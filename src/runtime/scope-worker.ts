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
		const { dataDir, globalConfigPath, projects } = msg as {
			type: "init";
			dataDir: string;
			globalConfigPath: string;
			projects?: Array<{ id: string; name: string; path: string }>;
		};

		try {
			appInstance = createApp({ dataDir, globalConfigPath, projects });
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

			// Read response body
			const responseBody = await response.text();
			const responseHeaders: Record<string, string> = {};
			response.headers.forEach((v, k) => {
				responseHeaders[k] = v;
			});

			self.postMessage({
				type: "http_response",
				id,
				status: response.status,
				headers: responseHeaders,
				body: responseBody,
			});
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
			appInstance.pm.sync(data as import("./worker-api.ts").SyncMap["projects"]);
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
