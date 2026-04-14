#!/usr/bin/env bun
/**
 * Meta-daemon shell — the main entry point.
 *
 * Responsibilities:
 * - HTTP server (:7433)
 * - Auth middleware
 * - Project registry (meta-level: which projects exist, which plugins active)
 * - Worker management (start/stop scope workers)
 * - Request routing: auth + project/scope selection → forward to worker
 * - SSE relay: worker events → browser
 * - Static files (web UI shell)
 *
 * Does NOT own: RuntimeContext, trackers, eventStores, agent lifecycle, tools.
 * Those live in the worker (PluginContext).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hasJwtSecret, verifyJWT } from "./auth.ts";
import { loadGlobalConfig, type MatrixConfig, saveGlobalConfig } from "./config.ts";
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

// ── Worker management ──

/** SSE client connected to the shell */
interface ShellSSEClient {
	controller: ReadableStreamDefaultController;
	projectId: string;
}

const sseClients = new Set<ShellSSEClient>();
const sseEncoder = new TextEncoder();
let sseSeqId = 0;

interface ScopeWorker {
	worker: Worker;
	ready: boolean;
	/** Pending request callbacks keyed by request ID */
	pending: Map<string, {
		resolve: (response: { status: number; headers: Record<string, string>; body: string }) => void;
		reject: (error: Error) => void;
	}>;
}

const workers = new Map<string, ScopeWorker>();

function startWorker(scopeName: string, dataDir: string, globalConfigPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(
			new URL("./runtime/scope-worker.ts", import.meta.url).href,
		);

		const scopeWorker: ScopeWorker = {
			worker,
			ready: false,
			pending: new Map(),
		};

		worker.onmessage = (event: MessageEvent) => {
			const msg = event.data;

			if (msg.type === "loaded") {
				// Worker module loaded, send init
				worker.postMessage({ type: "init", dataDir, globalConfigPath });
			}

			if (msg.type === "ready") {
				scopeWorker.ready = true;
				console.log(`[shell] Worker "${scopeName}" ready`);
				resolve();
			}

			if (msg.type === "error") {
				reject(new Error(`Worker "${scopeName}" init failed: ${msg.message}`));
			}

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

			// SSE relay: worker broadcasts events → shell relays to browser
			if (msg.type === "sse_event") {
				const { projectId, event } = msg;
				sseSeqId++;
				const data = JSON.stringify(event);
				const sseMessage = sseEncoder.encode(`id: ${sseSeqId}\ndata: ${data}\n\n`);
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

		workers.set(scopeName, scopeWorker);
	});
}

/** Forward an HTTP request to a worker and get the response. */
async function forwardToWorker(
	scopeName: string,
	request: Request,
): Promise<Response> {
	const sw = workers.get(scopeName);
	if (!sw || !sw.ready) {
		return new Response(JSON.stringify({ error: `Worker "${scopeName}" not ready` }), {
			status: 503,
			headers: { "content-type": "application/json" },
		});
	}

	const id = ulid();
	const body = request.method !== "GET" && request.method !== "HEAD"
		? await request.text()
		: undefined;

	const headers: Record<string, string> = {};
	request.headers.forEach((v, k) => { headers[k] = v; });

	return new Promise((resolve) => {
		const timeout = setTimeout(() => {
			sw.pending.delete(id);
			resolve(new Response(JSON.stringify({ error: "Worker timeout" }), {
				status: 504,
				headers: { "content-type": "application/json" },
			}));
		}, 60000); // 1 min timeout

		sw.pending.set(id, {
			resolve: (resp) => {
				clearTimeout(timeout);
				resolve(new Response(resp.body, {
					status: resp.status,
					headers: resp.headers,
				}));
			},
			reject: (err) => {
				clearTimeout(timeout);
				resolve(new Response(JSON.stringify({ error: err.message }), {
					status: 500,
					headers: { "content-type": "application/json" },
				}));
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

// ── Main ──

if (import.meta.main) {
	const dataDir = join(homedir(), ".mxd");
	const globalConfigPath = join(dataDir, "config.json");

	// Load global config for port + auth settings
	let globalConfig: MatrixConfig;
	try {
		globalConfig = await loadGlobalConfig(globalConfigPath);
	} catch {
		const { DEFAULT_CONFIG } = await import("./config.ts");
		globalConfig = { ...DEFAULT_CONFIG };
	}
	const port = globalConfig.port ?? 7433;

	// Start the matrix scope worker
	console.log(`Matrix daemon v${VERSION} (${GIT_HASH}) starting...`);

	await startWorker("matrix", dataDir, globalConfigPath);

	// Check if port is in use
	try {
		const res = await fetch(`http://localhost:${port}/health`);
		if (res.ok) {
			console.error(`Error: daemon already running on port ${port}`);
			process.exit(1);
		}
	} catch {}

	// Web UI
	const webIndex = await import("../web/index.html");

	Bun.serve({
		routes: {
			"/": webIndex.default,
		},
		fetch: async (request) => {
			const url = new URL(request.url);

			// ── Auth (shell-level, before any forwarding) ──

			// Skip auth for: SPA root, static assets, auth endpoints
			const skipAuth = url.pathname === "/" 
				|| url.pathname.startsWith("/web/")
				|| url.pathname.startsWith("/auth/");

			if (!skipAuth) {
				const authPath = join(dataDir, "auth.json");
				if (await hasJwtSecret(authPath)) {
					const authHeader = request.headers.get("authorization");
					const token = authHeader?.startsWith("Bearer ") 
						? authHeader.slice(7) 
						: url.searchParams.get("token");
					if (!token || !(await verifyJWT(authPath, token))) {
						return new Response(JSON.stringify({ error: "Unauthorized" }), {
							status: 401,
							headers: { "content-type": "application/json" },
						});
					}
				}
			}

			// ── Auth routes (handled by shell directly) ──
			if (url.pathname === "/auth/status") {
				const authPath = join(dataDir, "auth.json");
				const hasSecret = await hasJwtSecret(authPath);
				const authHeader = request.headers.get("authorization");
				const token = authHeader?.startsWith("Bearer ")
					? authHeader.slice(7)
					: url.searchParams.get("token");
				const hasValidToken = token ? (await verifyJWT(authPath, token)) !== null : false;
				const authenticated = hasValidToken || !hasSecret;
				return new Response(JSON.stringify({ enabled: hasSecret, authenticated }), {
					headers: { "content-type": "application/json" },
				});
			}
			if (url.pathname === "/auth/logout") {
				return new Response(JSON.stringify({ ok: true }), {
					headers: { "content-type": "application/json" },
				});
			}

			// ── Global config (daemon-owned) ──
			if (url.pathname === "/config/global" && request.method === "GET") {
				return new Response(JSON.stringify(globalConfig), {
					headers: { "content-type": "application/json" },
				});
			}
			if (url.pathname === "/config/global" && request.method === "PATCH") {
				const partial = await request.json() as Partial<MatrixConfig>;
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
				return new Response(JSON.stringify(globalConfig), {
					headers: { "content-type": "application/json" },
				});
			}

			// ── SSE endpoint — handled by shell, events relayed from worker ──
			if (url.pathname === "/events") {
				const projectId = url.searchParams.get("projectId");
				if (!projectId) {
					return new Response("projectId required", { status: 400 });
				}

				const stream = new ReadableStream({
					async start(controller) {
						const client: ShellSSEClient = { controller, projectId };
						sseClients.add(client);

						// Get initial state from worker (tree + clarifications)
						// by fetching from the worker's internal /events endpoint
						try {
							await forwardToWorker("matrix", new Request(
								`http://localhost/events?projectId=${projectId}`,
								{ headers: request.headers },
							));
							// The worker's SSE response is a stream — we can't easily proxy it.
							// Instead, request tree data via regular HTTP and send as initial SSE event.
							const treeResp = await forwardToWorker("matrix", new Request(
								`http://localhost/tasks?projectId=${projectId}`,
								{ headers: request.headers },
							));
							if (treeResp.ok) {
								const treeData = await treeResp.json();
								const msg = sseEncoder.encode(
									`data: ${JSON.stringify({ type: "tree_updated", ...treeData })}\n\n`,
								);
								controller.enqueue(msg);
							}
						} catch {
							// Best effort — events will stream from worker anyway
						}

						// Heartbeat every 15s
						const heartbeat = setInterval(() => {
							try {
								controller.enqueue(
									sseEncoder.encode(`data: ${JSON.stringify({ type: "heartbeat" })}\n\n`),
								);
							} catch {
								// disconnected
							}
						}, 15_000);

						// Clean up on disconnect
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

			// Everything else: forward to the matrix worker
			return forwardToWorker("matrix", request);
		},
		port,
		idleTimeout: 255,
	});

	console.log(`Matrix shell v${VERSION} (${GIT_HASH}) listening on http://localhost:${port}`);
	console.log(`Web UI: http://localhost:${port}/`);

	// Graceful shutdown
	const handleShutdown = async () => {
		console.log("Shell shutting down...");
		for (const [name, sw] of workers) {
			console.log(`  Stopping worker "${name}"...`);
			sw.worker.postMessage({ type: "shutdown" });
			sw.worker.terminate();
		}
		process.exit(0);
	};
	process.on("SIGTERM", handleShutdown);
	process.on("SIGINT", handleShutdown);
}
