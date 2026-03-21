import type { Event } from "../events.ts";
import type { QueueMessage } from "../message-queue.ts";
import type { TaskTracker } from "../task-tracker.ts";
import type {
	DaemonContext,
	PendingClarification,
	SSEClient,
} from "./context.ts";
import { getEventStore } from "./helpers.ts";

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

/** Broadcast an event to all SSE clients subscribed to a project. */
export function broadcast(
	clients: Set<SSEClient>,
	projectId: string,
	event: Record<string, unknown>,
) {
	console.error(
		event.type,
		event.type === "tool_call" ? event.tool : "",
		event.type === "tool_result" ? event.tool : "",
		clients.size,
		"clients",
	);
	const seqId = nextSeqId(projectId);
	const data = JSON.stringify(event);
	bufferEvent(projectId, seqId, data);

	const sseMessage = sseEncoder.encode(`id: ${seqId}\ndata: ${data}\n\n`);
	for (const client of clients) {
		if (client.projectId === projectId) {
			try {
				client.controller.enqueue(sseMessage);
			} catch {
				clients.delete(client);
			}
		}
	}
}

/** Broadcast a tree update to all subscribers of a project. */
export function broadcastTreeUpdate(
	ctx: DaemonContext,
	projectId: string,
	tracker: TaskTracker,
) {
	broadcast(ctx.sseClients, projectId, {
		type: "tree_updated",
		nodes: tracker.allNodes(),
		rootNodeId: tracker.rootNodeId,
	});
}

/** Ephemeral event types that should NOT be persisted to JSONL. */
const EPHEMERAL_EVENT_TYPES = new Set([
	"text_delta",
	"usage",
	"agent_idle",
	"agent_active",
	"status",
	"queue_message",
	"clarification_timeout",
	// Provider events are already written to JSONL by the provider — don't double-write
	"assistant_text",
	"tool_call",
	"tool_result",
	"compact_marker",
]);

/**
 * Convert a Event to a persistable Event for JSONL storage.
 * Returns null for ephemeral events that should not be persisted.
 * Also returns the taskId (sessionId) to store under.
 *
 * Since Event and Event now share field names (toolCallId, etc.),
 * non-ephemeral events can be stored directly — no field mapping needed.
 */
function broadcastToEvent(
	event: Event,
	rootNodeId: string | undefined,
): { event: Event; sessionId: string } | null {
	if (EPHEMERAL_EVENT_TYPES.has(event.type)) return null;

	// Extract taskId for session routing
	const taskId =
		"taskId" in event ? (event.taskId as string | undefined) : undefined;
	const sessionId = taskId || rootNodeId;
	if (!sessionId) return null;

	// All non-ephemeral types can be stored as-is (field names match Event)
	return { event: event as unknown as Event, sessionId };
}

/** Broadcast an agent event to subscribers and persist lifecycle events to JSONL. */
export function broadcastEvent(
	ctx: DaemonContext,
	projectId: string,
	event: Event,
) {
	// Persist lifecycle events to JSONL EventStore (fire-and-forget async write)
	const rootNodeId = ctx.trackers.get(projectId)?.rootNodeId ?? undefined;
	const persistable = broadcastToEvent(event, rootNodeId);
	if (persistable) {
		const eventStore = getEventStore(ctx, projectId);
		// append() is async with internal .catch() — safe to fire-and-forget
		eventStore.append(persistable.sessionId, persistable.event);
	}

	broadcast(
		ctx.sseClients,
		projectId,
		event as unknown as Record<string, unknown>,
	);

	// Track clarification_requested events for Web UI display
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

// --- Pending Messages (data-driven from queue) ---

/** Format a queue message into display text for the pending banner. */
export function pendingTextForMessage(m: QueueMessage): string {
	switch (m.source) {
		case "user":
			return m.content;
		case "child_complete":
			return `${m.success ? "✓" : "✗"} ${m.title}`;
		case "child_report":
			return `↑ ${m.title}: ${m.content}`;
		case "parent_update":
			return `← Parent: ${m.content}`;
		case "clarify_response":
			return `💬 ${m.answer}`;
		case "cross_project":
			return `← ${m.fromProjectName}: ${m.content}`;
		case "background_complete":
			return `⚙ ${m.command} (exit ${m.exitCode})`;
		case "system":
			return `⚙ ${m.content}`;
		case "compact":
			return "Compact requested";
	}
}

/** Broadcast current queue contents as pending messages to SSE clients. */
export function broadcastPendingFromQueue(
	ctx: DaemonContext,
	projectId: string,
	taskId: string | null,
	messages: QueueMessage[],
): void {
	const pending = messages.map((m, i) => ({
		id: `pending-${Date.now()}-${i}`,
		taskId,
		text: pendingTextForMessage(m),
		timestamp: Date.now(),
	}));
	broadcast(ctx.sseClients, projectId, {
		type: "pending_messages",
		projectId,
		taskId,
		messages: pending,
	});
}

/** Broadcast empty pending messages to SSE clients (queue drained). */
export function broadcastPendingCleared(
	ctx: DaemonContext,
	projectId: string,
	taskId: string | null,
): void {
	broadcast(ctx.sseClients, projectId, {
		type: "pending_messages",
		projectId,
		taskId,
		messages: [],
	});
}

// --- Pending Clarifications ---

export function getPendingClarifications(
	ctx: DaemonContext,
	projectId: string,
): PendingClarification[] {
	if (!ctx.pendingClarifications.has(projectId))
		ctx.pendingClarifications.set(projectId, []);
	return ctx.pendingClarifications.get(projectId) as PendingClarification[];
}

export function addPendingClarification(
	ctx: DaemonContext,
	projectId: string,
	taskId: string,
	question: string,
	title?: string,
	body?: string,
): PendingClarification {
	const clarifications = getPendingClarifications(ctx, projectId);
	const entry: PendingClarification = {
		id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		taskId,
		question,
		...(title ? { title } : {}),
		...(body ? { body } : {}),
		timestamp: Date.now(),
	};
	clarifications.push(entry);
	broadcast(ctx.sseClients, projectId, {
		type: "pending_clarifications",
		projectId,
		clarifications,
	});
	return entry;
}

export function removePendingClarification(
	ctx: DaemonContext,
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
		broadcast(ctx.sseClients, projectId, {
			type: "pending_clarifications",
			projectId,
			clarifications,
		});
	}
}
