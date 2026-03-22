/**
 * Shared test utilities for building mock DaemonContext objects.
 */
import type { DaemonContext } from "./daemon/context.ts";
import type { ProjectManager } from "./project-manager.ts";
import type { TaskTracker } from "./task-tracker.ts";
import type { Project } from "./types.ts";

/**
 * Build a minimal DaemonContext for tests that call createOrchestratorTools directly.
 * Only the fields actually used by the tools are populated — the rest are empty/mock.
 */
export function mockDaemonContext(opts: {
	tracker: TaskTracker;
	projectId: string;
	projectPath: string;
	dataDir?: string;
}): DaemonContext {
	const project: Project = {
		id: opts.projectId,
		name: "test-project",
		path: opts.projectPath,
		createdAt: new Date().toISOString(),
	};

	// Minimal ProjectManager mock — just needs get() and list()
	const pm = {
		get: (id: string) => (id === opts.projectId ? project : undefined),
		list: () => [project],
	} as unknown as ProjectManager;

	const trackers = new Map<string, TaskTracker>();
	trackers.set(opts.projectId, opts.tracker);

	return {
		config: {
			dataDir: opts.dataDir ?? "/tmp/og-test-mock",
		},
		pm,
		trackers,
		restartingProjects: new Set(),
		sseClients: new Set(),
		activeSessions: new Map(),
		pendingClarifications: new Map(),
		eventStores: new Map(),
		requestCount: 0,
		startupReady: true,
		globalConfig: {},
	} as DaemonContext;
}
