/**
 * Shared test utilities for building mock contexts.
 */
import type { DaemonContext } from "./daemon/context.ts";
import type { MessageQueue } from "./message-queue.ts";
import type { ProjectManager } from "./project-manager.ts";
import {
	initResourceRegistry,
	registerSideEffects,
	resetResourceRegistry,
} from "./resource-registry.ts";
import type { TaskTracker } from "./task-tracker.ts";
import { createAgentAuth, type Auth } from "./tool-auth.ts";
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
		eventSubscribers: new Map(),
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
 * Initialize the resource registry with a mock DaemonContext for tests.
 * Returns an Auth object for the given task.
 * Call resetResourceRegistry() in afterEach to clean up.
 */
export function initMockResourceRegistry(opts: {
	tracker: TaskTracker;
	projectId: string;
	projectPath: string;
	taskId: string | null;
	dataDir?: string;
}): { auth: Auth; ctx: DaemonContext } {
	resetResourceRegistry();
	const ctx = mockDaemonContext(opts);
	initResourceRegistry(ctx);
	registerSideEffects({
		emit: () => {},
		broadcastTree: () => {},
		deliverMessage: async (
			_projectId: string,
			nodeId: string,
			message: import("./message-queue.ts").QueueMessage,
		) => {
			// In tests, deliver directly to the target's queue if it exists
			const targetNode = opts.tracker.getTask(nodeId);
			const targetQueue = targetNode?.session?.queue;
			if (targetQueue) {
				targetQueue.enqueue(message);
			}
		},
		stopTask: async () => false,
		awaitLoopExit: async () => {},
		injectMessageToProject: async () => ({
			ok: false,
			error: "not available in tests",
		}),
	});
	const auth = createAgentAuth(opts.projectId, opts.taskId, opts.tracker);
	return { auth, ctx };
}

/**
 * Backward-compat wrapper: creates auth + initializes registry.
 * Returns an object that can be spread into createOrchestratorTools.
 * Usage: const { auth } = mockOrchestratorDeps({...});
 *        createOrchestratorTools(auth, projectId, taskId);
 */
export function mockOrchestratorDeps(opts: {
	tracker: TaskTracker;
	projectId: string;
	projectPath: string;
	dataDir?: string;
}): { auth: Auth; tracker: TaskTracker } {
	const { auth } = initMockResourceRegistry({
		...opts,
		taskId: null,
	});
	return { auth, tracker: opts.tracker };
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
