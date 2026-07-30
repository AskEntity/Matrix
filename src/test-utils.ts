/**
 * Shared test utilities for building mock contexts.
 */

import { DEFAULT_CONFIG, type MatrixConfig } from "./config.ts";
import type { MessageQueue } from "./message-queue.ts";
import type { ProjectStore } from "./project-store.ts";
import {
	initResourceRegistry,
	registerSideEffects,
	resetResourceRegistry,
} from "./resource-registry.ts";
import type { RuntimeContext } from "./runtime/context.ts";
import type { TaskTracker } from "./task-tracker.ts";
import { type Auth, createAgentAuth } from "./tool-auth.ts";
import { TurnInterrupt } from "./turn-interrupt.ts";
import type { Project, TaskNode, TaskSession } from "./types.ts";

/**
 * The model a test deployment runs. Listed by the mock endpoint's catalogue
 * (`MEASURED_ANTHROPIC_CATALOGUE`), which is the real production response.
 */
export const TEST_MODEL = "claude-sonnet-4-6";

/**
 * `createApp` config for any test that actually RUNS an agent.
 *
 * ⚠️ Pass this wherever a test injects `agentProvider`. Without it
 * `ctx.globalConfig` is `DEFAULT_CONFIG`, whose `model` is `""` — so
 * `request.model` reaches the provider empty, and until 2026-07-29 the context
 * window for that non-existent model came back as 200_000 from a substring
 * test that `""` merely failed. Now the endpoint is the only source
 * (`src/context-window.ts`), so an undeclared model is an error instead of a
 * number nobody chose.
 *
 * That the whole suite ran this way is the reason memory.md says a green suite
 * "says nothing about whether a fresh install works". Declaring the model is
 * what a real deployment does.
 */
export const TEST_CONFIG: MatrixConfig = {
	...DEFAULT_CONFIG,
	model: TEST_MODEL,
};

/**
 * Build a minimal RuntimeContext for tests that call createOrchestratorTools directly.
 * Only the fields actually used by the tools are populated — the rest are empty/mock.
 */
export function mockRuntimeContext(opts: {
	tracker: TaskTracker;
	projectId: string;
	projectPath: string;
	dataDir?: string;
}): RuntimeContext {
	const project: Project = {
		id: opts.projectId,
		name: "test-project",
		path: opts.projectPath,
		createdAt: new Date().toISOString(),
	};

	// Minimal ProjectStore mock — just needs get() and list()
	const pm = {
		get: (id: string) => (id === opts.projectId ? project : undefined),
		list: () => [project],
	} as unknown as ProjectStore;

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
		eventSubscribers: new Map(),
		pendingClarifications: new Map(),
		eventStores: new Map(),
		streamingText: new Map(),
		streamingThinking: new Map(),
		agentLoopPromises: new Map(),
		requestCount: 0,
		startupReady: true,
		globalConfig: {},
	} as RuntimeContext;
}

/**
 * Initialize the resource registry with a mock RuntimeContext for tests.
 * Returns an Auth object for the given task.
 * Call resetResourceRegistry() in afterEach to clean up.
 */
export function initMockResourceRegistry(opts: {
	tracker: TaskTracker;
	projectId: string;
	projectPath: string;
	taskId: string;
	dataDir?: string;
}): { auth: Auth; ctx: RuntimeContext } {
	resetResourceRegistry();
	const ctx = mockRuntimeContext(opts);
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
		taskId: opts.tracker.rootNodeId,
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
	// Set node.cwd so tools can read it
	if (!node.cwd) node.cwd = opts?.cwd ?? "/tmp/mock-cwd";
	const session: TaskSession = {
		queue,
		abortController: new AbortController(),
		interrupt: new TurnInterrupt(),
		loopTraceId: "mock-trace-id",
		depth: opts?.depth ?? 0,
		backgroundProcesses: new Map(),
		activity: "thinking",
		foregroundExecutions: new Map(),
	};
	node.session = session;
	return session;
}
