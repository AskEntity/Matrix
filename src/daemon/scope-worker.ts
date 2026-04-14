/**
 * Scope Worker — runs the full Matrix runtime in a Worker thread.
 *
 * This is the entry point for a Bun Worker. It:
 * 1. Receives config via initial message from main thread
 * 2. Creates the app (DaemonContext + routes + agent lifecycle)
 * 3. Handles requests forwarded from main thread
 * 4. Emits events back to main thread for SSE relay
 *
 * Step 1 (now): proof of concept — just boot createApp() in a worker
 * Step 2: wire up request forwarding + event relay
 */

/// <reference lib="webworker" />
declare const self: Worker;

import { createApp } from "../daemon.ts";

// Wait for config from main thread
self.onmessage = async (event: MessageEvent) => {
	const msg = event.data;

	if (msg.type === "init") {
		const { dataDir, globalConfigPath } = msg;
		
		try {
			const app = createApp({ dataDir, globalConfigPath });
			await app.pm.load();
			await app.loadConfig();
			await app.autoResumeProjects();
			app.markReady();

			self.postMessage({ type: "ready" });
			console.log("[scope-worker] Runtime initialized successfully");
		} catch (e) {
			self.postMessage({ 
				type: "error", 
				message: e instanceof Error ? e.message : String(e) 
			});
		}
	}

	if (msg.type === "shutdown") {
		// TODO: graceful shutdown
		self.postMessage({ type: "shutdown_complete" });
		process.exit(0);
	}
};

// Signal to main thread that worker module loaded
self.postMessage({ type: "loaded" });
