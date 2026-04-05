/**
 * Shared test utilities for building mock contexts.
 */
import type { DaemonContext } from "./daemon/context.ts";
import type { MessageQueue } from "./message-queue.ts";
import type { OrchestratorToolsDeps } from "./orchestrator-tools.ts";
import type { ProjectManager } from "./project-manager.ts";
import type { TaskTracker } from "./task-tracker.ts";
import type { Project, TaskNode, TaskSession } from "./types.ts";

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
			dataDir: opts.dataDir ?? "/tmp/mxd-test-mock",
		},
		pm,
		trackers,
		restartingProjects: new Set(),
		launchingNodes: new Set(),
		sseClients: new Set(),
		eventSubscribers: new Set(),
		pendingClarifications: new Map(),
		eventStores: new Map(),
		streamingText: new Map(),
		agentLoopPromises: new Map(),
		requestCount: 0,
		startupReady: true,
		globalConfig: {},
	} as DaemonContext;
}

/**
 * Build a minimal OrchestratorToolsDeps for tests that call createOrchestratorTools directly.
 * All callbacks are no-ops by default.
 */
export function mockOrchestratorDeps(opts: {
	tracker: TaskTracker;
	projectId: string;
	projectPath: string;
	dataDir?: string;
}): OrchestratorToolsDeps {
	const project: Project = {
		id: opts.projectId,
		name: "test-project",
		path: opts.projectPath,
		createdAt: new Date().toISOString(),
	};

	return {
		tracker: opts.tracker,
		repoPath: opts.projectPath,
		emit: () => {},
		broadcastTree: () => {},
		clearEventStore: () => {},
		hasEventStore: () => false,
		copySessionFrom: async (_s, _t, _opts) => ({ eventCount: 0 }),
		dataDir: opts.dataDir ?? "/tmp/mxd-test-mock",
		getClarifyTimeoutMs: () => undefined,
		getDefaultBudgetUsd: () => undefined,
		listProjects: () => [
			{
				id: project.id,
				name: project.name,
				path: project.path,
				hasActiveAgent: false,
			},
		],
		getProject: (id) => (id === opts.projectId ? project : undefined),
		getTracker: (projectId) =>
			projectId === opts.projectId ? opts.tracker : undefined,
	};
}

/**
 * Attach a minimal mock session to a tracker node, primarily for setting up the queue.
 * Returns the session for further customization if needed.
 */
export function attachMockSession(
	node: TaskNode,
	queue: MessageQueue,
	opts?: { cwd?: string; depth?: number },
): TaskSession {
	const session: TaskSession = {
		queue,
		abortController: new AbortController(),
		cwd: opts?.cwd ?? "/tmp/mock-cwd",
		fallbackCwd: opts?.cwd ?? "/tmp/mock-cwd",
		depth: opts?.depth ?? 0,
		backgroundProcesses: new Map(),
		foregroundExecutions: new Map(),
	};
	node.session = session;
	return session;
}
