import type { BroadcastEvent, Event } from "../events.ts";
import type { QueueMessage } from "../message-queue.ts";
import type { TaskTracker } from "../task-tracker.ts";
import type {
	DaemonContext,
	PendingClarification,
	WSClient,
} from "./context.ts";
import { getEventStore } from "./helpers.ts";

/** Broadcast an event to all WebSocket clients subscribed to a project. */
export function broadcast(
	clients: Set<WSClient>,
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
	const msg = JSON.stringify(event);
	for (const client of clients) {
		if (client.projectId === projectId) {
			try {
				client.ws.send(msg);
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
	broadcast(ctx.wsClients, projectId, {
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
 * Convert a BroadcastEvent to a persistable Event for JSONL storage.
 * Returns null for ephemeral events that should not be persisted.
 * Also returns the taskId (sessionId) to store under.
 *
 * Since BroadcastEvent and Event now share field names (toolCallId, etc.),
 * non-ephemeral events can be stored directly — no field mapping needed.
 */
function broadcastToEvent(
	event: BroadcastEvent,
	rootNodeId: string | undefined,
): { event: Event; sessionId: string } | null {
	if (EPHEMERAL_EVENT_TYPES.has(event.type)) return null;

	// Extract taskId for session routing
	const taskId =
		"taskId" in event ? (event.taskId as string | undefined) : undefined;
	const sessionId = taskId || rootNodeId;
	if (!sessionId) return null;

	// message_injected routes to root session
	if (event.type === "message_injected") {
		return {
			event: event as unknown as Event,
			sessionId: rootNodeId ?? sessionId,
		};
	}

	// All other non-ephemeral types can be stored as-is (field names match Event)
	return { event: event as unknown as Event, sessionId };
}

/** Broadcast an agent event to subscribers and persist lifecycle events to JSONL. */
export function broadcastEvent(
	ctx: DaemonContext,
	projectId: string,
	event: BroadcastEvent,
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
		ctx.wsClients,
		projectId,
		event as unknown as Record<string, unknown>,
	);

	// Track clarification_requested events for Web UI display
	if (event.type === "clarification_requested") {
		addPendingClarification(ctx, projectId, event.taskId, event.question);
	}
}

// --- Pending Messages (data-driven from queue) ---

/** Broadcast current queue contents as pending messages to WS clients. */
export function broadcastPendingFromQueue(
	ctx: DaemonContext,
	projectId: string,
	messages: QueueMessage[],
): void {
	const pending = messages
		.filter((m) => m.source === "user")
		.map((m, i) => ({
			id: `pending-${Date.now()}-${i}`,
			taskId: null,
			text: (m as Extract<QueueMessage, { source: "user" }>).content,
			timestamp: Date.now(),
		}));
	broadcast(ctx.wsClients, projectId, {
		type: "pending_messages",
		projectId,
		messages: pending,
	});
}

/** Broadcast empty pending messages to WS clients (queue drained). */
export function broadcastPendingCleared(
	ctx: DaemonContext,
	projectId: string,
): void {
	broadcast(ctx.wsClients, projectId, {
		type: "pending_messages",
		projectId,
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
): PendingClarification {
	const clarifications = getPendingClarifications(ctx, projectId);
	const entry: PendingClarification = {
		id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		taskId,
		question,
		timestamp: Date.now(),
	};
	clarifications.push(entry);
	broadcast(ctx.wsClients, projectId, {
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
		broadcast(ctx.wsClients, projectId, {
			type: "pending_clarifications",
			projectId,
			clarifications,
		});
	}
}
