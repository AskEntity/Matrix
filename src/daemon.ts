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
import { hasJwtSecret, verifyJWT } from "./auth.ts";
import {
	DEFAULT_CONFIG,
	loadGlobalConfig,
	type MatrixConfig,
	saveGlobalConfig,
} from "./config.ts";
import type { PluginManifest } from "./plugin.ts";
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

			// Temporary handler for init sequence
			worker.onmessage = (event: MessageEvent) => {
				const msg = event.data;
				if (msg.type === "loaded") {
					worker.postMessage({
						type: "init",
						dataDir,
						globalConfigPath,
						projects: pm.list().map((p) => ({ id: p.id, name: p.name, path: p.path })),
					});
				}
				if (msg.type === "ready") {
					scopeWorker.ready = true;
					setupWorkerMessageHandler(scopeName, scopeWorker);
					resolve();
				}
				if (msg.type === "error") {
					reject(
						new Error(
							`Worker "${scopeName}" init failed: ${msg.message}`,
						),
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
				console.warn(
					`[daemon] Failed to load plugin from ${project.name}:`,
					e,
				);
			}
		}
	}

	// Start workers for global plugins
	for (const plugin of registeredPlugins.filter(
		(p) => p.scope === "global",
	)) {
		await startWorkerForPlugin(plugin.name);
	}

	// ── Request handler ──

	async function fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// Auth
		const skipAuth =
			url.pathname === "/" ||
			url.pathname.startsWith("/web/") ||
			url.pathname.startsWith("/auth/") ||
			url.pathname.startsWith("/.mxd/") ||
			url.pathname.endsWith(".js") ||
			url.pathname.endsWith(".css") ||
			url.pathname.endsWith(".tsx") ||
			url.pathname.endsWith(".ts");

		if (!skipAuth) {
			const authPath = join(dataDir, "auth.json");
			if (await hasJwtSecret(authPath)) {
				const authHeader = request.headers.get("authorization");
				const token = authHeader?.startsWith("Bearer ")
					? authHeader.slice(7)
					: url.searchParams.get("token");
				if (!token || !(await verifyJWT(authPath, token))) {
					return new Response(
						JSON.stringify({ error: "Unauthorized" }),
						{
							status: 401,
							headers: { "content-type": "application/json" },
						},
					);
				}
			}
		}

		// Auth routes
		if (url.pathname === "/auth/status") {
			const authPath = join(dataDir, "auth.json");
			const hasSecret = await hasJwtSecret(authPath);
			const authHeader = request.headers.get("authorization");
			const token = authHeader?.startsWith("Bearer ")
				? authHeader.slice(7)
				: url.searchParams.get("token");
			const hasValidToken = token
				? (await verifyJWT(authPath, token)) !== null
				: false;
			const authenticated = hasValidToken || !hasSecret;
			return new Response(
				JSON.stringify({ enabled: hasSecret, authenticated }),
				{ headers: { "content-type": "application/json" } },
			);
		}
		if (url.pathname === "/auth/logout") {
			return new Response(JSON.stringify({ ok: true }), {
				headers: { "content-type": "application/json" },
			});
		}

		// ── Project CRUD (daemon-owned) ──
		if (url.pathname === "/projects" && request.method === "GET") {
			const projects = pm.list().map((p) => ({
				...p,
				pathExists: pm.checkPathExists(p.id),
			}));
			return new Response(JSON.stringify(projects), {
				headers: { "content-type": "application/json" },
			});
		}
		if (url.pathname === "/projects" && request.method === "POST") {
			try {
				const body = await request.json() as { path: string };
				if (!body.path) {
					return new Response(JSON.stringify({ error: "path is required" }), {
						status: 400,
						headers: { "content-type": "application/json" },
					});
				}
				const project = await pm.init(body.path);

				// Call onProjectInit for all global plugins
				for (const plugin of registeredPlugins.filter((p) => p.scope === "global")) {
					if (plugin.onProjectInit) {
						await plugin.onProjectInit(body.path, { isNew: !existsSync(join(body.path, ".git")) });
					}
				}

				syncProjects();
				return new Response(JSON.stringify(project), {
					status: 201,
					headers: { "content-type": "application/json" },
				});
			} catch (e) {
				const message = e instanceof Error ? e.message : "Unknown error";
				return new Response(JSON.stringify({ error: message }), {
					status: 409,
					headers: { "content-type": "application/json" },
				});
			}
		}
		if (url.pathname.match(/^\/projects\/[^/]+$/) && request.method === "GET") {
			const projectId = url.pathname.split("/")[2]!;
			const project = pm.get(projectId);
			if (!project) {
				return new Response(JSON.stringify({ error: "Project not found" }), {
					status: 404,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(JSON.stringify({
				...project,
				pathExists: pm.checkPathExists(project.id),
			}), {
				headers: { "content-type": "application/json" },
			});
		}
		if (url.pathname.match(/^\/projects\/[^/]+$/) && request.method === "DELETE") {
			const projectId = url.pathname.split("/")[2]!;
			try {
				// Stop worker agents first
				const globalWorkerName = registeredPlugins.find(
					(p) => p.scope === "global" && workers.has(p.name),
				)?.name;
				if (globalWorkerName) {
					await forwardToWorker(globalWorkerName, new Request(
						`http://localhost/projects/${projectId}/stop`,
						{ method: "POST" },
					));
				}
				await pm.delete(projectId);
				syncProjects();
				return new Response(JSON.stringify({ ok: true }), {
					headers: { "content-type": "application/json" },
				});
			} catch (e) {
				const message = e instanceof Error ? e.message : "Unknown error";
				return new Response(JSON.stringify({ error: message }), {
					status: 404,
					headers: { "content-type": "application/json" },
				});
			}
		}
		if (url.pathname.match(/^\/projects\/[^/]+$/) && request.method === "PATCH") {
			const projectId = url.pathname.split("/")[2]!;
			try {
				const body = await request.json() as { path?: string; name?: string };
				if (!body.path && !body.name) {
					return new Response(JSON.stringify({ error: "At least one of path or name is required" }), {
						status: 400,
						headers: { "content-type": "application/json" },
					});
				}
				const updated = await pm.updateProject(projectId, body);
				return new Response(JSON.stringify({
					...updated,
					pathExists: pm.checkPathExists(updated.id),
				}), {
					headers: { "content-type": "application/json" },
				});
			} catch (e) {
				const message = e instanceof Error ? e.message : "Unknown error";
				const status = message.includes("not found") ? 404 : 400;
				return new Response(JSON.stringify({ error: message }), {
					status,
					headers: { "content-type": "application/json" },
				});
			}
		}

		// Plugins
		if (url.pathname === "/plugins" && request.method === "GET") {
			return new Response(
				JSON.stringify(
					registeredPlugins.map((p) => ({
						name: p.name,
						scope: p.scope,
						webComponentPath: p.resolvedWebPath,
						projectId: p.projectId,
					})),
				),
				{ headers: { "content-type": "application/json" } },
			);
		}

		// Global config
		if (url.pathname === "/config/global" && request.method === "GET") {
			return new Response(JSON.stringify(globalConfig), {
				headers: { "content-type": "application/json" },
			});
		}
		if (url.pathname === "/config/global" && request.method === "PATCH") {
			const partial = (await request.json()) as Partial<MatrixConfig>;
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
			return new Response(JSON.stringify(globalConfig), {
				headers: { "content-type": "application/json" },
			});
		}

		// SSE
		if (url.pathname === "/events") {
			const projectId = url.searchParams.get("projectId");
			if (!projectId) {
				return new Response("projectId required", { status: 400 });
			}

			const stream = new ReadableStream({
				async start(controller) {
					const client: ShellSSEClient = { controller, projectId };
					sseClients.add(client);

					try {
						const workerName = registeredPlugins.find(
							(p) => p.scope === "global" && workers.has(p.name),
						)?.name;
						const treeResp = workerName ? await forwardToWorker(
							workerName,
							new Request(
								`http://localhost/tasks?projectId=${projectId}`,
								{ headers: request.headers },
							),
						) : null;
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
		}

		// Forward to first available global worker
		const globalWorkerName = registeredPlugins.find(
			(p) => p.scope === "global" && workers.has(p.name),
		)?.name;
		if (!globalWorkerName) {
			return new Response(
				JSON.stringify({ error: "No global plugin worker available" }),
				{ status: 503, headers: { "content-type": "application/json" } },
			);
		}
		return forwardToWorker(globalWorkerName, request);
	}

	/**
	 * Typed sync primitive — daemon (golden) → workers (read-only).
	 * SyncMap shared between daemon + worker for type safety on both sides.
	 */
	function syncToWorkers<K extends keyof SyncMap>(key: K, data: SyncMap[K]): void {
		for (const [, sw] of workers) {
			if (sw.ready) {
				sw.worker.postMessage({ type: "sync", key, data });
			}
		}
	}

	function syncProjects(): void {
		syncToWorkers("projects", pm.list().map((p) => ({ id: p.id, name: p.name, path: p.path })));
	}

	function syncConfig(): void {
		syncToWorkers("config", globalConfig);
	}

	// ── Shutdown ──

	async function shutdown(): Promise<void> {
		for (const [, sw] of workers) {
			sw.worker.postMessage({ type: "shutdown" });
			sw.worker.terminate();
		}
		workers.clear();
	}

	return {
		fetch,
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
	const dataDir = join(homedir(), ".mxd");
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
