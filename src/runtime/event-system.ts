import { type Event, isPersistedByEmitEvent } from "../events.ts";
import type { TaskTracker } from "../task-tracker.ts";
import { isFolder, stripSession } from "../types.ts";
import { ulid } from "../ulid.ts";
import type {
	EventSubscriber,
	PendingClarification,
	RuntimeContext,
} from "./context.ts";
import { getEventStore } from "./helpers.ts";

/**
 * Broadcast an event to all observers of a project:
 *   1. Parent thread (shell) via onBroadcast — daemon fans out to SSE clients.
 *   2. In-process event subscribers (registered via subscribeToEvents)
 *
 * The event is ephemeral here — no persistence. Callers that need both
 * broadcast AND JSONL persistence should use emitEvent() instead.
 *
 * A subscriber throwing is logged but does not interrupt the broadcast.
 */
export function broadcast(
	ctx: RuntimeContext,
	projectId: string,
	event: Record<string, unknown>,
) {
	// 1. Relay to parent thread (shell) for SSE fanout. Daemon owns the SSE
	//    protocol (seqId, ring buffer, client set). Worker just forwards.
	if (ctx.onBroadcast) {
		ctx.onBroadcast(projectId, event);
	}

	// 2. In-process subscribers for this project (O(subs_for_this_project),
	//    not O(all_subs_across_all_projects)).
	const subs = ctx.eventSubscribers.get(projectId);
	if (subs) {
		for (const callback of subs) {
			try {
				callback(event);
			} catch (e) {
				console.warn("[broadcast] event subscriber threw:", e);
			}
		}
	}
}

/**
 * Register an in-process event subscriber for a project. Returns an
 * unsubscribe function — callers MUST call it to prevent leaks (typically
 * in a finally block).
 *
 * Subscribers see every event broadcast for the project, including ephemeral
 * events (agent_idle, text_delta, etc.). They receive the raw event object.
 *
 * Symmetric lifecycle pattern:
 *   const unsub = subscribeToEvents(ctx, projectId, (evt) => { ... });
 *   try { await somethingLong(); } finally { unsub(); }
 */
export function subscribeToEvents(
	ctx: RuntimeContext,
	projectId: string,
	callback: EventSubscriber,
): () => void {
	let subs = ctx.eventSubscribers.get(projectId);
	if (!subs) {
		subs = new Set();
		ctx.eventSubscribers.set(projectId, subs);
	}
	subs.add(callback);
	return () => {
		const s = ctx.eventSubscribers.get(projectId);
		if (!s) return;
		s.delete(callback);
		// Clean up the empty bucket to prevent unbounded project-key growth
		// across a long-running daemon's lifetime.
		if (s.size === 0) ctx.eventSubscribers.delete(projectId);
	};
}

// --- Unified event emission ---

/**
 * THE single path for all events in the system.
 *
 * 1. Always broadcasts to SSE clients (with taskId for routing)
 * 2. Persists to JSONL for non-ephemeral events
 *
 * All callers use this instead of separate broadcast + persist calls.
 */
export function emitEvent(
	ctx: RuntimeContext,
	projectId: string,
	event: Event,
) {
	broadcast(ctx, projectId, event as unknown as Record<string, unknown>);

	// Persist to JSONL (skips ephemeral events like text_delta, usage, etc.)
	if (isPersistedByEmitEvent(event)) {
		const taskId =
			"taskId" in event ? (event.taskId as string | undefined) : undefined;
		const sessionId = taskId || ctx.trackers.get(projectId)?.rootNodeId;
		if (sessionId) {
			const eventStore = getEventStore(ctx, projectId);
			eventStore.append(sessionId, event);
		}
	}

	// Track clarification_requested events for pending clarifications state
	if (event.type === "clarification_requested") {
		addPendingClarification(
			ctx,
			projectId,
			event.taskId,
			event.question,
			event.title,
			event.body,
		);
	}
}

/**
 * Broadcast a tree update to all subscribers of a project.
 * This is ephemeral — carries full tree data for immediate UI update.
 * Tree changes are also delivered as structured queue messages to running agents.
 *
 * Sessions MUST be stripped before crossing the postMessage boundary — the
 * live session object contains MessageQueue, AbortController, messages[] with
 * non-cloneable references. `structuredClone` throws DataCloneError on these.
 * Pre-FU8 the triple-JSON-serialize path silently dropped these fields; after
 * FU8 removed that path, stripping became explicitly required.
 */
export function broadcastTreeUpdate(
	ctx: RuntimeContext,
	projectId: string,
	tracker: TaskTracker,
) {
	broadcast(ctx, projectId, {
		type: "tree_updated",
		nodes: tracker.allNodes().map((n) => (isFolder(n) ? n : stripSession(n))),
		rootNodeId: tracker.rootNodeId,
	});
}

// --- Pending Clarifications ---

export function getPendingClarifications(
	ctx: RuntimeContext,
	projectId: string,
): PendingClarification[] {
	if (!ctx.pendingClarifications.has(projectId))
		ctx.pendingClarifications.set(projectId, []);
	return ctx.pendingClarifications.get(projectId) as PendingClarification[];
}

function addPendingClarification(
	ctx: RuntimeContext,
	projectId: string,
	taskId: string,
	question: string,
	title?: string,
	body?: string,
): PendingClarification {
	const clarifications = getPendingClarifications(ctx, projectId);
	const entry: PendingClarification = {
		id: ulid(),
		taskId,
		question,
		...(title ? { title } : {}),
		...(body ? { body } : {}),
		timestamp: Date.now(),
	};
	clarifications.push(entry);
	broadcast(ctx, projectId, {
		type: "pending_clarifications",
		projectId,
		clarifications,
	});
	return entry;
}

export function removePendingClarification(
	ctx: RuntimeContext,
	projectId: string,
	taskId: string,
	clarificationId?: string,
): void {
	const clarifications = getPendingClarifications(ctx, projectId);
	const idx = clarificationId
		? clarifications.findIndex((c) => c.id === clarificationId)
		: clarifications.findIndex((c) => c.taskId === taskId);
	if (idx !== -1) {
		clarifications.splice(idx, 1);
		broadcast(ctx, projectId, {
			type: "pending_clarifications",
			projectId,
			clarifications,
		});
	}
}
