/**
 * Global resource registry — handle-based access to daemon, project, and task state.
 *
 * All resource access goes through this module. Functions take id handles
 * (projectId, taskId) and return the corresponding resources. No closures,
 * no dependency injection bags — just global functions with explicit handles.
 *
 * The registry is initialized once at daemon startup with a RuntimeContext reference.
 * Tool handlers call these functions directly with handles from their args.
 */

import type { EventStore } from "./event-store.ts";
import type { EventSpec } from "./events.ts";
import type { QueueMessage } from "./message-queue.ts";
import type { TaskTracker } from "./task-tracker.ts";
import type { BaseTaskNode, TaskSession } from "./types.ts";
import { isTask } from "./types.ts";

// ── Registry state (module-level singleton) ──

/** Opaque daemon reference — only this module sees inside. */
let _ctx: unknown = null;

/**
 * Initialize the resource registry with the daemon context.
 * Called once at daemon startup. Must be called before any resource function.
 */
export function initResourceRegistry(ctx: unknown): void {
	_ctx = ctx;
}

/** Get the raw daemon context. Only for internal use within this module. */
function ctx(): RuntimeContextLike {
	if (!_ctx) {
		throw new Error(
			"Resource registry not initialized. Call initResourceRegistry() at daemon startup.",
		);
	}
	return _ctx as RuntimeContextLike;
}

// ── Minimal interface we need from RuntimeContext ──
// Avoids importing RuntimeContext directly (would create circular deps from daemon/)

interface RuntimeContextLike {
	readonly pm: {
		list(): Array<{ id: string; name: string; path: string }>;
		get(id: string): { id: string; name: string; path: string } | undefined;
	};
	readonly trackers: Map<string, TaskTracker>;
	readonly eventStores: Map<string, EventStore>;
	readonly config: { dataDir: string };
	readonly globalConfig: {
		budgetUsd: number;
	};
	readonly eventSubscribers: Map<string, Set<unknown>>;
	readonly launchingNodes: Set<string>;
	readonly agentLoopPromises: Map<string, Promise<void>>;
	readonly streamingText: Map<string, string>;
	readonly streamingThinking: Map<string, string>;
	readonly pendingClarifications: Map<string, unknown[]>;
}

// ── Daemon-level functions (no project/task handle needed) ──

export function listProjects(): Array<{
	id: string;
	name: string;
	path: string;
	hasActiveAgent: boolean;
}> {
	const c = ctx();
	return c.pm.list().map((p) => ({
		id: p.id,
		name: p.name,
		path: p.path,
		hasActiveAgent: (() => {
			const t = c.trackers.get(p.id);
			if (!t) return false;
			const root = t.getTask(t.rootNodeId);
			return root?.session != null;
		})(),
	}));
}

export function getProject(
	projectId: string,
): { id: string; name: string; path: string } | undefined {
	return ctx().pm.get(projectId);
}

export function getDefaultBudgetUsd(): number {
	return ctx().globalConfig.budgetUsd;
}

// ── Project-level functions (need projectId handle) ──

export function getTracker(projectId: string): TaskTracker | undefined {
	return ctx().trackers.get(projectId);
}

export function getEventStore(projectId: string): EventStore {
	const c = ctx();
	const store = c.eventStores.get(projectId);
	if (!store) {
		throw new Error(
			`No EventStore for project ${projectId}. EventStores must be initialized at daemon startup.`,
		);
	}
	return store;
}

export function clearEventStore(projectId: string, sessionId: string): void {
	const store = ctx().eventStores.get(projectId);
	if (store) store.clear(sessionId);
}

export function hasEventStore(projectId: string, sessionId: string): boolean {
	const store = ctx().eventStores.get(projectId);
	if (!store) return false;
	return store.has(sessionId);
}

export function copySessionFrom(
	projectId: string,
	sourceId: string,
	targetId: string,
	opts?: { targetTitle?: string; targetDescription?: string },
): Promise<{ eventCount: number }> {
	return getEventStore(projectId).copySessionFrom(sourceId, targetId, opts);
}

// ── Task-level functions (need projectId + taskId handles) ──

export function getSession(
	projectId: string,
	taskId: string | null,
): TaskSession | undefined {
	if (!taskId) return undefined;
	const tracker = getTracker(projectId);
	if (!tracker) return undefined;
	return tracker.getTask(taskId)?.session ?? undefined;
}

// ── Functions that need daemon context for side effects ──
// These are thin wrappers that will delegate to daemon-layer functions.
// They're declared here so tool handlers can call them with just handles.
// The actual implementation is injected at init time to avoid circular imports.

type EmitFn = (projectId: string, taskId: string, spec: EventSpec) => void;
type BroadcastTreeFn = (projectId: string) => void;
type DeliverMessageFn = (
	projectId: string,
	nodeId: string,
	message: QueueMessage,
	opts?: { quiet?: boolean },
) => Promise<void>;
type StopTaskFn = (projectId: string, nodeId: string) => Promise<boolean>;
type AwaitLoopExitFn = (nodeId: string) => Promise<void>;
type InjectMessageToProjectFn = (
	projectId: string,
	message: string,
) => Promise<{ ok: boolean; error?: string }>;

let _emit: EmitFn | null = null;
let _broadcastTree: BroadcastTreeFn | null = null;
let _deliverMessage: DeliverMessageFn | null = null;
let _stopTask: StopTaskFn | null = null;
let _awaitLoopExit: AwaitLoopExitFn | null = null;
let _injectMessageToProject: InjectMessageToProjectFn | null = null;

/**
 * Register side-effect functions that need daemon infrastructure.
 * Called at daemon startup alongside initResourceRegistry.
 */
export function registerSideEffects(fns: {
	emit: EmitFn;
	broadcastTree: BroadcastTreeFn;
	deliverMessage: DeliverMessageFn;
	stopTask: StopTaskFn;
	awaitLoopExit: AwaitLoopExitFn;
	injectMessageToProject: InjectMessageToProjectFn;
}): void {
	_emit = fns.emit;
	_broadcastTree = fns.broadcastTree;
	_deliverMessage = fns.deliverMessage;
	_stopTask = fns.stopTask;
	_awaitLoopExit = fns.awaitLoopExit;
	_injectMessageToProject = fns.injectMessageToProject;
}

export function emit(projectId: string, taskId: string, spec: EventSpec): void {
	if (!_emit) throw new Error("emit not registered");
	_emit(projectId, taskId, spec);
}

export function broadcastTree(projectId: string): void {
	if (!_broadcastTree) throw new Error("broadcastTree not registered");
	_broadcastTree(projectId);
}

export function deliverMessage(
	projectId: string,
	nodeId: string,
	message: QueueMessage,
	opts?: { quiet?: boolean },
): Promise<void> {
	if (!_deliverMessage) throw new Error("deliverMessage not registered");
	return _deliverMessage(projectId, nodeId, message, opts);
}

export function stopTask(projectId: string, nodeId: string): Promise<boolean> {
	if (!_stopTask) throw new Error("stopTask not registered");
	return _stopTask(projectId, nodeId);
}

export function awaitLoopExit(nodeId: string): Promise<void> {
	if (!_awaitLoopExit) throw new Error("awaitLoopExit not registered");
	return _awaitLoopExit(nodeId);
}

export function injectMessageToProject(
	projectId: string,
	message: string,
): Promise<{ ok: boolean; error?: string }> {
	if (!_injectMessageToProject)
		throw new Error("injectMessageToProject not registered");
	return _injectMessageToProject(projectId, message);
}

// ── Narrowed plugin messaging API (deliverToNode + listNodes) ──
//
// These two are the NARROW, named, stable surface a plugin's tools use for
// intra-project peer messaging. A plugin composes its own routing policy
// (broadcast to a group / private to one) on top of them — WITHOUT importing
// the internal singleton accessors (`getTracker` exposes the whole mutable
// tracker; `deliverMessage` is the raw delivery path). The SDK re-exports
// exactly these two; `getTracker`/`deliverMessage` stay internal to matrix.
//
// ⭐ SINGLETON: both operate on the SAME in-process tracker/session registry
// the agent loop uses (the module-level `_ctx`). That shared singleton is the
// whole reason a delivered message ARRIVES at a live peer (enqueued to its
// running queue, or auto-launched if idle) instead of being silently dropped.
// A plugin that vendored its own copy of this module would get a DIFFERENT
// `_ctx` → a different tracker → delivery would no-op. So the SDK MUST re-export
// from this single live module, never bundle a copy.

/**
 * Deliver a {@link QueueMessage} to ANY node in a project — the stable-named
 * plugin API over the ONE existing delivery path (`deliverMessage`).
 *
 * Reuses that single path verbatim: JSONL persist → enqueue to the peer's live
 * queue if it is running → auto-launch the peer if it is idle (and not quiet).
 * The "wake an idle recipient" semantic is exactly what a plugin wants when
 * routing a message to a peer that isn't currently active.
 *
 * No permission policy is applied. Unlike matrix's `send_message` (ancestor /
 * sub-task restricted — a matrix policy), this primitive is UNRESTRICTED
 * intra-project; the calling plugin's tools own the routing policy.
 *
 * @param opts.quiet - skip auto-launch (notification semantics — don't wake an
 *   idle peer; the message is persisted and recovered on its next launch).
 */
export function deliverToNode(
	projectId: string,
	nodeId: string,
	message: QueueMessage,
	opts?: { quiet?: boolean },
): Promise<void> {
	return deliverMessage(projectId, nodeId, message, opts);
}

/**
 * Read-only snapshot of a project's launchable nodes — the stable-named plugin
 * API for enumerating peers. A plugin resolves group membership and
 * name→node from each node's plugin-owned `metadata`; routing (broadcast vs
 * private) stays 100% in the plugin's tools.
 *
 * Returns a FRESH array each call: mutating the array (push/splice) does not
 * affect the tracker, and a later call returns a new snapshot. General
 * (non-launchable) nodes — matrix folders, a plugin's grouping nodes — are
 * excluded: you can only deliver to a launchable node, and `BaseTaskNode` is
 * the runtime-generic launchable shape every plugin's node type extends.
 */
export function listNodes(projectId: string): ReadonlyArray<BaseTaskNode> {
	const tracker = getTracker(projectId);
	if (!tracker) return [];
	return tracker.allNodes().filter(isTask);
}

/**
 * Get the raw daemon context for evaluate_script ONLY.
 * This is the one escape hatch — evaluate_script needs full runtime access for debugging.
 */
export function getRuntimeContext(): unknown {
	return _ctx;
}

/**
 * Reset registry state. For testing only.
 */
export function resetResourceRegistry(): void {
	_ctx = null;
	_emit = null;
	_broadcastTree = null;
	_deliverMessage = null;
	_stopTask = null;
	_awaitLoopExit = null;
	_injectMessageToProject = null;
}
