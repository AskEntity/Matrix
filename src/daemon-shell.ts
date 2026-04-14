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
 * Does NOT own: DaemonContext, trackers, eventStores, agent lifecycle, tools.
 * Those live in the worker (PluginContext).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
			new URL("./daemon/scope-worker.ts", import.meta.url).href,
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

			// TODO: handle event relay for SSE
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

	// For now: start a single "matrix" scope worker
	console.log(`Matrix shell v${VERSION} (${GIT_HASH}) starting...`);

	await startWorker("matrix", dataDir, globalConfigPath);

	const port = 7433; // TODO: read from config

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
			// For now: forward everything to the matrix worker
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
