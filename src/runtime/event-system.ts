import { type Event, isPersistedByEmitEvent } from "../events.ts";
import type { TaskTracker } from "../task-tracker.ts";
import { ulid } from "../ulid.ts";
import type {
	RuntimeContext,
	EventSubscriber,
	PendingClarification,
} from "./context.ts";
import { getEventStore, stripEventForUI } from "./helpers.ts";

const sseEncoder = new TextEncoder();

// --- Per-project SSE event sequencing + ring buffer for catch-up ---

/** Per-project monotonic event counter. */
const projectSeqCounters = new Map<string, number>();

/** Ring buffer entry: an SSE event with its sequence ID. */
interface SSERingEntry {
	seqId: number;
	data: string; // JSON-encoded event
}

/** Per-project ring buffer of recent events for Last-Event-ID catch-up. */
const projectEventBuffers = new Map<string, SSERingEntry[]>();

const RING_BUFFER_SIZE = 2000;

/** Get the next sequence ID for a project. */
function nextSeqId(projectId: string): number {
	const current = projectSeqCounters.get(projectId) ?? 0;
	const next = current + 1;
	projectSeqCounters.set(projectId, next);
	return next;
}

/** Add an event to the project's ring buffer. */
function bufferEvent(projectId: string, seqId: number, data: string): void {
	let buffer = projectEventBuffers.get(projectId);
	if (!buffer) {
		buffer = [];
		projectEventBuffers.set(projectId, buffer);
	}
	buffer.push({ seqId, data });
	// Trim to ring buffer size
	if (buffer.length > RING_BUFFER_SIZE) {
		buffer.splice(0, buffer.length - RING_BUFFER_SIZE);
	}
}

/**
 * Get events from the ring buffer after a given sequence ID.
 * Returns null if the requested ID is too old (not in buffer).
 */
export function getEventsSince(
	projectId: string,
	lastSeqId: number,
): SSERingEntry[] | null {
	const buffer = projectEventBuffers.get(projectId);
	if (!buffer || buffer.length === 0) return null;

	const firstEntry = buffer[0];
	if (!firstEntry) return null;

	// If the requested ID is older than our oldest buffered event,
	// we can't guarantee no gaps — return null to trigger full refresh
	if (lastSeqId < firstEntry.seqId - 1) return null;

	// Find events after lastSeqId
	const idx = buffer.findIndex((e) => e.seqId > lastSeqId);
	if (idx === -1) return []; // All events are <= lastSeqId, client is up to date
	return buffer.slice(idx);
}

/**
 * Broadcast an event to all observers of a project:
 *   1. SSE clients (browser UI via HTTP stream)
 *   2. In-process event subscribers (registered via subscribeToEvents)
 *
 * The event is ephemeral here — no persistence. Callers that need both
 * broadcast AND JSONL persistence should use emitEvent() instead.
 *
 * Subscribers receive the RAW event object (pre-strip). SSE clients receive
 * the stripped/SSE-encoded form. A subscriber throwing is logged but does
 * not interrupt the broadcast.
 */
export function broadcast(
	ctx: RuntimeContext,
	projectId: string,
	event: Record<string, unknown>,
) {
	const seqId = nextSeqId(projectId);
	const data = JSON.stringify(stripEventForUI(event));
	bufferEvent(projectId, seqId, data);

	// 1. SSE clients — only the ones watching this project.
	const sseMessage = sseEncoder.encode(`id: ${seqId}\ndata: ${data}\n\n`);
	for (const client of ctx.sseClients) {
		if (client.projectId === projectId) {
			try {
				client.controller.enqueue(sseMessage);
			} catch {
				ctx.sseClients.delete(client);
			}
		}
	}

	// 2. Relay to parent thread (shell) for SSE when running in a worker.
	if (ctx.onBroadcast) {
		ctx.onBroadcast(projectId, event);
	}

	// 3. In-process subscribers for this project (O(subs_for_this_project),
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
export function emitEvent(ctx: RuntimeContext, projectId: string, event: Event) {
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
 */
export function broadcastTreeUpdate(
	ctx: RuntimeContext,
	projectId: string,
	tracker: TaskTracker,
) {
	broadcast(ctx, projectId, {
		type: "tree_updated",
		nodes: tracker.allNodes(),
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
