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

/**
 * Convert a BroadcastEvent to a persistable Event for JSONL storage.
 * Returns null for ephemeral events that should not be persisted.
 * Also returns the taskId (sessionId) to store under.
 */
function broadcastToEvent(
	event: BroadcastEvent,
	rootNodeId: string | undefined,
): { event: Event; sessionId: string } | null {
	// Extract taskId for session routing
	const taskId =
		"taskId" in event ? (event.taskId as string | undefined) : undefined;
	const sessionId = taskId || rootNodeId;
	if (!sessionId) return null;

	// Skip ephemeral events
	switch (event.type) {
		case "text_delta":
		case "usage":
		case "agent_idle":
		case "agent_active":
		case "status":
		case "queue_message":
		case "clarification_timeout":
			return null;
	}

	// These event types match the Event union directly
	switch (event.type) {
		case "orchestration_started":
			return {
				event: {
					type: "orchestration_started",
					taskId: event.taskId,
					resume: event.resume,
					prompt: event.prompt,
					model: event.model,
					provider: event.provider,
					ts: event.ts,
				},
				sessionId,
			};
		case "orchestration_completed":
			return {
				event: {
					type: "orchestration_completed",
					taskId: event.taskId,
					success: event.success,
					costUsd: event.costUsd,
					turns: event.turns,
					inputTokens: event.inputTokens,
					cacheCreationTokens: event.cacheCreationTokens,
					cacheReadTokens: event.cacheReadTokens,
					outputTokens: event.outputTokens,
					childCosts: event.childCosts,
					ts: event.ts,
				},
				sessionId,
			};
		case "task_started":
			return {
				event: {
					type: "task_started",
					taskId: event.taskId,
					title: event.title,
					ts: event.ts,
				},
				sessionId,
			};
		case "task_completed":
			return {
				event: {
					type: "task_completed",
					taskId: event.taskId,
					title: event.title,
					success: event.success,
					output: event.output,
					error: event.error,
					ts: event.ts,
				},
				sessionId,
			};
		case "error":
			return {
				event: {
					type: "error",
					taskId: event.taskId,
					message: event.message,
					ts: event.ts,
				},
				sessionId,
			};
		case "budget_exceeded":
			return {
				event: {
					type: "budget_exceeded",
					taskId: event.taskId,
					title: event.title,
					costUsd: event.costUsd,
					budgetUsd: event.budgetUsd,
					ts: event.ts,
				},
				sessionId,
			};
		case "clarification_requested":
			return {
				event: {
					type: "clarification_requested",
					taskId: event.taskId,
					question: event.question,
					ts: event.ts,
				},
				sessionId,
			};
		case "clarification_answered":
			return {
				event: {
					type: "clarification_answered",
					taskId: event.taskId,
					answer: event.answer,
					ts: event.ts,
				},
				sessionId,
			};
		case "tree_mutation":
			return {
				event: {
					type: "tree_mutation",
					action: event.action,
					nodeId: event.nodeId,
					title: event.title,
					ts: event.ts,
				},
				sessionId,
			};
		case "compact_started":
			return {
				event: {
					type: "compact_started",
					taskId: event.taskId,
					ts: event.ts,
				},
				sessionId,
			};
		case "agent_stopped":
			return {
				event: {
					type: "agent_stopped",
					taskId: event.taskId,
					ts: event.ts,
				},
				sessionId,
			};
		case "message_injected":
			return {
				event: {
					type: "message_injected",
					message: event.message,
					ts: event.ts,
				},
				sessionId: rootNodeId ?? sessionId,
			};
		// Provider events (assistant_text, tool_call, tool_result, compact_marker)
		// are already written to JSONL by the provider — don't double-write
		case "assistant_text":
		case "tool_call":
		case "tool_result":
		case "compact_marker":
			return null;
		default:
			return null;
	}
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
		.map((m) => ({
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
