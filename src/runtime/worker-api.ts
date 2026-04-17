/**
 * Worker API — the typed state-sync protocol between daemon (shell) and
 * runtime worker.
 *
 * The daemon owns mutable state (project list, global config). The worker
 * holds a read-only cached view. On change, daemon sends a SyncMessage via
 * postMessage; the worker's scope-worker handler applies it.
 *
 * HTTP forwarding + streaming are structural postMessage protocols described
 * inline in daemon.ts + scope-worker.ts; they're not typed here.
 */

import type { MatrixConfig } from "../config.ts";

/** All syncable state types. Shared between daemon and worker for type safety. */
export interface SyncMap {
	projects: Array<{ id: string; name: string; path: string }>;
	config: MatrixConfig;
	/** Signal worker to clean up in-memory caches for a deleted project */
	project_deleted: { projectId: string };
}

/** Sync message from daemon to worker. */
export interface SyncMessage<K extends keyof SyncMap = keyof SyncMap> {
	type: "sync";
	key: K;
	data: SyncMap[K];
}
