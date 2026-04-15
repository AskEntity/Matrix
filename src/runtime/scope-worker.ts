/**
 * Scope Worker — runs the full Matrix runtime in a Worker thread.
 *
 * This is the entry point for a Bun Worker. It:
 * 1. Receives config via initial message from main thread
 * 2. Creates the app (RuntimeContext + routes + agent lifecycle)
 * 3. Handles requests forwarded from main thread
 * 4. Emits events back to main thread for SSE relay
 *
 * Step 1 (now): proof of concept — just boot createApp() in a worker
 * Step 2: wire up request forwarding + event relay
 */

/// <reference lib="webworker" />
declare const self: Worker;

import { createApp } from "../runtime.ts";

let appInstance: ReturnType<typeof createApp> | null = null;

self.onmessage = async (event: MessageEvent) => {
	const msg = event.data;

	if (msg.type === "init") {
		const { dataDir, globalConfigPath, projects, pluginRuntimePath } = msg as {
			type: "init";
			dataDir: string;
			globalConfigPath: string;
			projects?: Array<{ id: string; name: string; path: string }>;
			/** Path to plugin's runtime module (exports buildScopeOpts). */
			pluginRuntimePath?: string;
		};

		try {
			// Load plugin's scope opts builder if provided
			// biome-ignore lint/suspicious/noExplicitAny: plugin module shape varies
			let buildScopeOpts: any;
			if (pluginRuntimePath) {
				const pluginMod = await import(pluginRuntimePath);
				const builder = pluginMod.buildMatrixScopeOpts ?? pluginMod.buildScopeOpts ?? pluginMod.default;
				if (typeof builder === "function") {
					buildScopeOpts = (projectId: string, ctx: import("./context.ts").RuntimeContext) =>
						builder(projectId, ctx.globalConfig.selfBootstrap ?? false, ctx);
				}
			}
			appInstance = createApp({ dataDir, globalConfigPath, projects, buildScopeOpts });
			await appInstance.loadConfig();

			// Wire broadcast BEFORE autoResume — events during crash recovery must reach shell
			appInstance.ctx.onBroadcast = (projectId, event) => {
				self.postMessage({ type: "sse_event", projectId, event });
			};

			await appInstance.autoResumeProjects();

			appInstance.markReady();

			self.postMessage({ type: "ready" });
		} catch (e) {
			self.postMessage({
				type: "error",
				message: e instanceof Error ? e.message : String(e),
			});
		}
	}

	if (msg.type === "http_request") {
		const { id, method, url, headers, body } = msg;
		if (!appInstance) {
			self.postMessage({
				type: "http_response",
				id,
				status: 503,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ error: "Worker not ready" }),
			});
			return;
		}

		try {
			// Reconstruct Request and let Hono handle it
			const request = new Request(url, {
				method,
				headers,
				body: body ?? undefined,
			});

			const response = await appInstance.app.fetch(request);

			const responseHeaders: Record<string, string> = {};
			response.headers.forEach((v, k) => {
				responseHeaders[k] = v;
			});

			// Streaming responses (SSE, MCP) can't be buffered — stream chunks via postMessage
			const contentType = response.headers.get("content-type") ?? "";
			if (contentType.includes("text/event-stream") && response.body) {
				// Send headers first, then stream chunks
				self.postMessage({
					type: "http_response_stream_start",
					id,
					status: response.status,
					headers: responseHeaders,
				});
				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				try {
					while (true) {
						const { done: readerDone, value } = await reader.read();
						if (readerDone) break;
						self.postMessage({
							type: "http_response_stream_chunk",
							id,
							chunk: decoder.decode(value, { stream: true }),
						});
					}
				} finally {
					self.postMessage({ type: "http_response_stream_end", id });
				}
			} else {
				// Buffered response (normal HTTP)
				const responseBody = await response.text();
				self.postMessage({
					type: "http_response",
					id,
					status: response.status,
					headers: responseHeaders,
					body: responseBody,
				});
			}
		} catch (e) {
			self.postMessage({
				type: "http_response",
				id,
				status: 500,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					error: e instanceof Error ? e.message : String(e),
				}),
			});
		}
	}

	if (msg.type === "sync") {
		const { key, data } = msg as import("./worker-api.ts").SyncMessage;
		if (!appInstance) return;

		if (key === "projects") {
			const projects = data as import("./worker-api.ts").SyncMap["projects"];
			appInstance.pm.sync(projects);
			// Ensure data directories exist for new projects
			const { mkdirSync } = await import("node:fs");
			const { join } = await import("node:path");
			for (const p of projects) {
				const projectDir = join(appInstance.ctx.config.dataDir, "projects", p.id);
				mkdirSync(join(projectDir, "tasks"), { recursive: true });
				mkdirSync(join(projectDir, "debug"), { recursive: true });
			}
		} else if (key === "config") {
			appInstance.ctx.globalConfig = data as import("./worker-api.ts").SyncMap["config"];
		} else if (key === "project_deleted") {
			const { projectId } = data as import("./worker-api.ts").SyncMap["project_deleted"];
			// Defensive: stop any running agents before clearing caches.
			// Daemon already sends POST /stop before this sync, but if that
			// failed or timed out, agents would keep running on a deleted project.
			const { stopAgent } = await import("./agent-lifecycle.ts");
			await stopAgent(appInstance.ctx, projectId);
			appInstance.ctx.trackers.delete(projectId);
			appInstance.ctx.eventStores.delete(projectId);
			appInstance.ctx.pendingClarifications.delete(projectId);
		}
	}

	if (msg.type === "shutdown") {
		if (appInstance) await appInstance.shutdown();
		self.postMessage({ type: "shutdown_complete" });
	}
};

// Signal to main thread that worker module loaded
self.postMessage({ type: "loaded" });
