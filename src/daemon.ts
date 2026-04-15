#!/usr/bin/env bun
/**
 * Meta-daemon — the main entry point.
 *
 * Responsibilities:
 * - HTTP server
 * - Auth middleware
 * - Plugin discovery (scans projects for .mxd/plugin/index.ts)
 * - Worker management (start/stop scope workers)
 * - SSE relay (worker events → browser)
 * - Global config + plugin registry endpoints
 *
 * Does NOT own: RuntimeContext, trackers, eventStores, agent lifecycle, tools.
 * Those live in the worker.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { hasJwtSecret, verifyJWT } from "./auth.ts";
import {
	DEFAULT_CONFIG,
	loadGlobalConfig,
	type MatrixConfig,
	saveGlobalConfig,
} from "./config.ts";
import { checkDataRootCollisions, type PluginManifest } from "./plugin.ts";
import { ProjectManager } from "./project-manager.ts";
import type { SyncMap } from "./runtime/worker-api.ts";
import { ulid } from "./ulid.ts";

// Read version
const _pkg = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };
const VERSION = _pkg.version;

let GIT_HASH = "unknown";
try {
	const result = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]);
	if (result.exitCode === 0) {
		GIT_HASH = new TextDecoder().decode(result.stdout).trim();
	}
} catch {}

// ── Types ──

interface ShellSSEClient {
	controller: ReadableStreamDefaultController;
	projectId: string;
}

interface ScopeWorker {
	worker: Worker;
	ready: boolean;
	pending: Map<
		string,
		{
			resolve: (response: {
				status: number;
				headers: Record<string, string>;
				body: string;
			}) => void;
			reject: (error: Error) => void;
		}
	>;
}

interface RegisteredPlugin extends PluginManifest {
	pluginRoot: string;
	projectId: string;
	resolvedWebPath?: string;
}

export interface DaemonInstance {
	/** Handle an HTTP request (for testing — bypasses Bun.serve) */
	fetch: (request: Request) => Promise<Response>;
	/** Registered plugins */
	plugins: RegisteredPlugin[];
	/** Graceful shutdown */
	shutdown: () => Promise<void>;
	/** Project manager */
	pm: ProjectManager;
	/** Global config */
	globalConfig: MatrixConfig;
}

// ── createDaemon ──

export async function createDaemon(opts: {
	dataDir: string;
	globalConfigPath?: string;
}): Promise<DaemonInstance> {
	const { dataDir } = opts;
	const globalConfigPath =
		opts.globalConfigPath ?? join(dataDir, "config.json");

	// Load global config
	let globalConfig: MatrixConfig;
	try {
		globalConfig = await loadGlobalConfig(globalConfigPath);
	} catch {
		globalConfig = { ...DEFAULT_CONFIG };
	}

	// SSE state
	const sseClients = new Set<ShellSSEClient>();
	const sseEncoder = new TextEncoder();
	let sseSeqId = 0;

	// Worker state
	const workers = new Map<string, ScopeWorker>();

	function setupWorkerMessageHandler(
		_scopeName: string,
		scopeWorker: ScopeWorker,
	) {
		scopeWorker.worker.onmessage = (event: MessageEvent) => {
			const msg = event.data;

			if (msg.type === "http_response") {
				const pending = scopeWorker.pending.get(msg.id);
				if (pending) {
					scopeWorker.pending.delete(msg.id);
					pending.resolve({
						status: msg.status,
						headers: msg.headers,
						body: msg.body,
					});
				}
			}

			if (msg.type === "sse_event") {
				const { projectId, event: evt } = msg;
				sseSeqId++;
				const data = JSON.stringify(evt);
				const sseMessage = sseEncoder.encode(
					`id: ${sseSeqId}\ndata: ${data}\n\n`,
				);
				for (const client of sseClients) {
					if (client.projectId === projectId) {
						try {
							client.controller.enqueue(sseMessage);
						} catch {
							sseClients.delete(client);
						}
					}
				}
			}
		};
	}

	async function startWorkerForPlugin(
		scopeName: string,
		pluginRuntimePath?: string,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			const worker = new Worker(
				new URL("./runtime/scope-worker.ts", import.meta.url).href,
			);

			const scopeWorker: ScopeWorker = {
				worker,
				ready: false,
				pending: new Map(),
			};

			// Handle worker crash — reject all pending requests
			worker.onerror = (event: ErrorEvent) => {
				console.error(`[daemon] Worker "${scopeName}" crashed:`, event.message);
				scopeWorker.ready = false;
				// Reject all pending HTTP requests so they don't hang forever
				for (const [id, pending] of scopeWorker.pending) {
					pending.reject(
						new Error(`Worker "${scopeName}" crashed: ${event.message}`),
					);
				}
				scopeWorker.pending.clear();
			};

			// Temporary handler for init sequence
			worker.onmessage = (event: MessageEvent) => {
				const msg = event.data;
				if (msg.type === "loaded") {
					worker.postMessage({
						type: "init",
						dataDir,
						globalConfigPath,
						projects: pm
							.list()
							.map((p) => ({ id: p.id, name: p.name, path: p.path })),
						pluginRuntimePath,
					});
				}
				if (msg.type === "ready") {
					scopeWorker.ready = true;
					setupWorkerMessageHandler(scopeName, scopeWorker);
					resolve();
				}
				if (msg.type === "error") {
					reject(
						new Error(`Worker "${scopeName}" init failed: ${msg.message}`),
					);
				}
			};

			workers.set(scopeName, scopeWorker);
		});
	}

	async function forwardToWorker(
		scopeName: string,
		request: Request,
	): Promise<Response> {
		const sw = workers.get(scopeName);
		if (!sw || !sw.ready) {
			return new Response(
				JSON.stringify({ error: `Worker "${scopeName}" not ready` }),
				{ status: 503, headers: { "content-type": "application/json" } },
			);
		}

		const id = ulid();
		const body =
			request.method !== "GET" && request.method !== "HEAD"
				? await request.text()
				: undefined;

		const headers: Record<string, string> = {};
		request.headers.forEach((v: string, k: string) => {
			headers[k] = v;
		});

		return new Promise((resolve) => {
			const timeout = setTimeout(() => {
				sw.pending.delete(id);
				resolve(
					new Response(JSON.stringify({ error: "Worker timeout" }), {
						status: 504,
						headers: { "content-type": "application/json" },
					}),
				);
			}, 60000);

			sw.pending.set(id, {
				resolve: (resp) => {
					clearTimeout(timeout);
					resolve(
						new Response(resp.body, {
							status: resp.status,
							headers: resp.headers,
						}),
					);
				},
				reject: (err) => {
					clearTimeout(timeout);
					resolve(
						new Response(JSON.stringify({ error: err.message }), {
							status: 500,
							headers: { "content-type": "application/json" },
						}),
					);
				},
			});

			sw.worker.postMessage({
				type: "http_request",
				id,
				method: request.method,
				url: request.url,
				headers,
				body,
			});
		});
	}

	// ── Discover plugins ──

	const pm = new ProjectManager(dataDir);
	await pm.load();

	const registeredPlugins: RegisteredPlugin[] = [];

	for (const project of pm.list()) {
		const pluginDir = join(project.path, ".mxd", "plugin");
		const pluginIndex = join(pluginDir, "index.ts");
		if (existsSync(pluginIndex)) {
			try {
				const mod = await import(pluginIndex);
				const manifest = (mod.default ?? mod) as PluginManifest;
				registeredPlugins.push({
					...manifest,
					pluginRoot: pluginDir,
					projectId: project.id,
					resolvedWebPath: manifest.web
						? resolve(pluginDir, manifest.web)
						: undefined,
				});
			} catch (e) {
				console.warn(`[daemon] Failed to load plugin from ${project.name}:`, e);
			}
		}
	}

	// Check for dataRoot collisions — two plugins writing to the same directory
	const collision = checkDataRootCollisions(registeredPlugins);
	if (collision) {
		throw new Error(collision);
	}

	// Start workers for global plugins
	for (const plugin of registeredPlugins.filter((p) => p.scope === "global")) {
		// Resolve plugin's runtime module path for the worker
		const runtimePath = plugin.runtime
			? resolve(plugin.pluginRoot, plugin.runtime)
			: undefined;
		await startWorkerForPlugin(plugin.name, runtimePath);
	}

	// ── Hono app with routes ──

	const app = new Hono();

	// Auth middleware
	// Only skip auth for SPA root, shell static assets, and auth endpoints.
	// NOT /.mxd/ (has config.json, tree.json, memory.md — sensitive).
	// NOT file extensions (attackers can append .ts to bypass).
	app.use("*", async (c, next) => {
		const skipAuth =
			c.req.path === "/" ||
			c.req.path.startsWith("/web/") ||
			c.req.path.startsWith("/auth/");

		if (!skipAuth) {
			const authPath = join(dataDir, "auth.json");
			if (await hasJwtSecret(authPath)) {
				const authHeader = c.req.header("authorization");
				const token = authHeader?.startsWith("Bearer ")
					? authHeader.slice(7)
					: c.req.query("token");
				if (!token || !(await verifyJWT(authPath, token))) {
					return c.json({ error: "Unauthorized" }, 401);
				}
			}
		}
		await next();
	});

	// Health — daemon-owned, not worker-forwarded
	app.get("/health", (c) => {
		return c.json({ status: "ok", version: VERSION });
	});

	// Auth routes
	app.get("/auth/status", async (c) => {
		const authPath = join(dataDir, "auth.json");
		const hasSecret = await hasJwtSecret(authPath);
		const authHeader = c.req.header("authorization");
		const token = authHeader?.startsWith("Bearer ")
			? authHeader.slice(7)
			: c.req.query("token");
		const hasValidToken = token
			? (await verifyJWT(authPath, token)) !== null
			: false;
		const authenticated = hasValidToken || !hasSecret;
		return c.json({ enabled: hasSecret, authenticated });
	});

	app.get("/auth/logout", (c) => {
		return c.json({ ok: true });
	});

	// ── Project CRUD (daemon-owned) ──

	app.get("/projects", (c) => {
		const projects = pm.list().map((p) => ({
			...p,
			pathExists: pm.checkPathExists(p.id),
		}));
		return c.json(projects);
	});

	app.post("/projects", async (c) => {
		try {
			const body = await c.req.json<{ path: string }>();
			if (!body.path) {
				return c.json({ error: "path is required" }, 400);
			}
			const project = await pm.init(body.path);

			// Call onProjectInit for all global plugins
			for (const plugin of registeredPlugins.filter(
				(p) => p.scope === "global",
			)) {
				if (plugin.onProjectInit) {
					await plugin.onProjectInit(body.path, {
						isNew: !existsSync(join(body.path, ".git")),
					});
				}
			}

			syncProjects();
			return c.json(project, 201);
		} catch (e) {
			const message = e instanceof Error ? e.message : "Unknown error";
			return c.json({ error: message }, 409);
		}
	});

	app.get("/projects/:id", (c) => {
		const projectId = c.req.param("id");
		const project = pm.get(projectId);
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		return c.json({
			...project,
			pathExists: pm.checkPathExists(project.id),
		});
	});

	app.delete("/projects/:id", async (c) => {
		const projectId = c.req.param("id");
		try {
			// Stop worker agents first
			const globalWorkerName = registeredPlugins.find(
				(p) => p.scope === "global" && workers.has(p.name),
			)?.name;
			if (globalWorkerName) {
				await forwardToWorker(
					globalWorkerName,
					new Request(`http://localhost/projects/${projectId}/stop`, {
						method: "POST",
					}),
				);
			}
			await pm.delete(projectId);
			syncToWorkers("project_deleted", { projectId });
			syncProjects();
			return c.json({ ok: true });
		} catch (e) {
			const message = e instanceof Error ? e.message : "Unknown error";
			return c.json({ error: message }, 404);
		}
	});

	app.patch("/projects/:id", async (c) => {
		const projectId = c.req.param("id");
		try {
			const body = await c.req.json<{ path?: string; name?: string }>();
			if (!body.path && !body.name) {
				return c.json(
					{ error: "At least one of path or name is required" },
					400,
				);
			}
			const updated = await pm.updateProject(projectId, body);
			return c.json({
				...updated,
				pathExists: pm.checkPathExists(updated.id),
			});
		} catch (e) {
			const message = e instanceof Error ? e.message : "Unknown error";
			const status = message.includes("not found") ? 404 : 400;
			return c.json({ error: message }, status);
		}
	});

	// Plugins
	app.get("/plugins", (c) => {
		return c.json(
			registeredPlugins.map((p) => ({
				name: p.name,
				scope: p.scope,
				webComponentPath: p.resolvedWebPath,
				projectId: p.projectId,
			})),
		);
	});

	// Global config
	app.get("/config/global", (c) => {
		return c.json(globalConfig);
	});

	app.patch("/config/global", async (c) => {
		const partial = await c.req.json<Partial<MatrixConfig>>();
		const next = { ...globalConfig } as MatrixConfig;
		for (const [k, v] of Object.entries(partial)) {
			if (v === null || v === undefined) {
				delete (next as unknown as Record<string, unknown>)[k];
			} else {
				(next as unknown as Record<string, unknown>)[k] = v;
			}
		}
		globalConfig = next;
		await saveGlobalConfig(globalConfig, globalConfigPath);
		syncConfig();
		return c.json(globalConfig);
	});

	// ── Project config (daemon-owned: per-project settings) ──

	// Helper: resolve project or 404
	function getProjectOrNull(projectId: string) {
		return pm.get(projectId) ?? null;
	}

	app.get("/projects/:id/config/repo", async (c) => {
		const project = getProjectOrNull(c.req.param("id"));
		if (!project) return c.json({ error: "Project not found" }, 404);
		const { loadProjectRepoConfig } = await import("./config.ts");
		const cfg = await loadProjectRepoConfig(project.path);
		return c.json(cfg);
	});

	app.patch("/projects/:id/config/repo", async (c) => {
		const project = getProjectOrNull(c.req.param("id"));
		if (!project) return c.json({ error: "Project not found" }, 404);
		const { loadProjectRepoConfig, saveProjectRepoConfig } = await import(
			"./config.ts"
		);
		const partial = await c.req.json<Partial<MatrixConfig>>();
		const existing = await loadProjectRepoConfig(project.path);
		const merged = { ...existing };
		for (const [k, v] of Object.entries(partial)) {
			if (v === null || v === undefined) {
				delete (merged as unknown as Record<string, unknown>)[k];
			} else {
				(merged as unknown as Record<string, unknown>)[k] = v;
			}
		}
		await saveProjectRepoConfig(project.path, merged);
		return c.json(merged);
	});

	app.get("/projects/:id/config/all", async (c) => {
		const project = getProjectOrNull(c.req.param("id"));
		if (!project) return c.json({ error: "Project not found" }, 404);
		const { loadProjectRepoConfig, loadProjectLocalConfig, resolveConfig } =
			await import("./config.ts");
		const [repoConfig, localConfig] = await Promise.all([
			loadProjectRepoConfig(project.path),
			loadProjectLocalConfig(dataDir, project.id),
		]);
		const resolved = resolveConfig(globalConfig, repoConfig, localConfig);
		return c.json({
			global: globalConfig,
			repo: repoConfig,
			local: localConfig,
			resolved,
		});
	});

	app.get("/projects/:id/config", async (c) => {
		const project = getProjectOrNull(c.req.param("id"));
		if (!project) return c.json({ error: "Project not found" }, 404);
		const { loadProjectLocalConfig } = await import("./config.ts");
		const cfg = await loadProjectLocalConfig(dataDir, project.id);
		return c.json(cfg);
	});

	app.patch("/projects/:id/config", async (c) => {
		const project = getProjectOrNull(c.req.param("id"));
		if (!project) return c.json({ error: "Project not found" }, 404);
		const { loadProjectLocalConfig, saveProjectLocalConfig } = await import(
			"./config.ts"
		);
		const partial = await c.req.json<Partial<MatrixConfig>>();
		const existing = await loadProjectLocalConfig(dataDir, project.id);
		const merged = { ...existing };
		for (const [k, v] of Object.entries(partial)) {
			if (v === null || v === undefined) {
				delete (merged as unknown as Record<string, unknown>)[k];
			} else {
				(merged as unknown as Record<string, unknown>)[k] = v;
			}
		}
		await saveProjectLocalConfig(dataDir, project.id, merged);
		return c.json(merged);
	});

	// SSE
	app.get("/events", async (c) => {
		const projectId = c.req.query("projectId");
		if (!projectId) {
			return c.text("projectId required", 400);
		}

		const request = c.req.raw;
		const stream = new ReadableStream({
			async start(controller) {
				const client: ShellSSEClient = { controller, projectId };
				sseClients.add(client);

				try {
					const workerName = registeredPlugins.find(
						(p) => p.scope === "global" && workers.has(p.name),
					)?.name;
					const treeResp = workerName
						? await forwardToWorker(
								workerName,
								new Request(`http://localhost/tasks?projectId=${projectId}`, {
									headers: request.headers,
								}),
							)
						: null;
					if (treeResp?.ok) {
						const treeData = await treeResp.json();
						const msg = sseEncoder.encode(
							`data: ${JSON.stringify({ type: "tree_updated", ...treeData })}\n\n`,
						);
						controller.enqueue(msg);
					}
				} catch {}

				const heartbeat = setInterval(() => {
					try {
						controller.enqueue(
							sseEncoder.encode(
								`data: ${JSON.stringify({ type: "heartbeat" })}\n\n`,
							),
						);
					} catch {}
				}, 15_000);

				request.signal.addEventListener("abort", () => {
					clearInterval(heartbeat);
					sseClients.delete(client);
				});
			},
		});

		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			},
		});
	});

	// Fallthrough: forward to first available global worker
	app.all("*", async (c) => {
		const globalWorkerName = registeredPlugins.find(
			(p) => p.scope === "global" && workers.has(p.name),
		)?.name;
		if (!globalWorkerName) {
			return c.json({ error: "No global plugin worker available" }, 503);
		}
		return forwardToWorker(globalWorkerName, c.req.raw);
	});

	/**
	 * Typed sync primitive — daemon (golden) → workers (read-only).
	 * SyncMap shared between daemon + worker for type safety on both sides.
	 */
	function syncToWorkers<K extends keyof SyncMap>(
		key: K,
		data: SyncMap[K],
	): void {
		for (const [, sw] of workers) {
			if (sw.ready) {
				sw.worker.postMessage({ type: "sync", key, data });
			}
		}
	}

	function syncProjects(): void {
		syncToWorkers(
			"projects",
			pm.list().map((p) => ({ id: p.id, name: p.name, path: p.path })),
		);
	}

	function syncConfig(): void {
		syncToWorkers("config", globalConfig);
	}

	// ── Shutdown ──

	async function shutdown(): Promise<void> {
		for (const [name, sw] of workers) {
			sw.worker.postMessage({ type: "shutdown" });
			// Wait for graceful shutdown (agent stop, JSONL flush) before terminating
			await new Promise<void>((resolve) => {
				const timeout = setTimeout(() => {
					console.warn(
						`[daemon] Worker "${name}" shutdown timeout — terminating`,
					);
					resolve();
				}, 5000);
				const handler = (event: MessageEvent) => {
					if (event.data.type === "shutdown_complete") {
						clearTimeout(timeout);
						sw.worker.removeEventListener("message", handler);
						resolve();
					}
				};
				sw.worker.addEventListener("message", handler);
			});
			sw.worker.terminate();
		}
		workers.clear();
	}

	return {
		fetch: app.fetch as (request: Request) => Promise<Response>,
		plugins: registeredPlugins,
		shutdown,
		pm,
		globalConfig,
	};
}

// Re-export for tests
export type { RegisteredPlugin };

// ── Production entry ──

if (import.meta.main) {
	const dataDir = process.env.MXD_DATA_DIR ?? join(homedir(), ".mxd");
	const daemon = await createDaemon({ dataDir });

	const port = daemon.globalConfig.port ?? 7433;

	try {
		const res = await fetch(`http://localhost:${port}/health`);
		if (res.ok) {
			console.error(`Error: daemon already running on port ${port}`);
			process.exit(1);
		}
	} catch {}

	const webIndex = await import("../web/index.html");

	Bun.serve({
		routes: { "/": webIndex.default },
		fetch: daemon.fetch,
		port,
		idleTimeout: 255,
		development:
			process.env.NODE_ENV === "development"
				? { hmr: true, console: true }
				: false,
	});

	console.log(
		`Matrix daemon v${VERSION} (${GIT_HASH}) listening on http://localhost:${port}`,
	);

	const handleShutdown = async () => {
		console.log("Shutting down...");
		await daemon.shutdown();
		process.exit(0);
	};
	process.on("SIGTERM", handleShutdown);
	process.on("SIGINT", handleShutdown);
}
