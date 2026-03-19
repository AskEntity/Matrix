import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { QueueMessage } from "../message-queue.ts";
import type { TaskTracker } from "../task-tracker.ts";
import type {
	DaemonContext,
	PendingClarification,
	WSClient,
} from "./context.ts";

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

export function eventsPath(ctx: DaemonContext, projectId: string): string {
	return join(ctx.config.dataDir, "events", `${projectId}.json`);
}

export async function loadEventHistory(
	ctx: DaemonContext,
	projectId: string,
): Promise<Record<string, unknown>[]> {
	const path = eventsPath(ctx, projectId);
	try {
		const raw = await readFile(path, "utf-8");
		const events = JSON.parse(raw) as Record<string, unknown>[];
		ctx.eventHistory.set(projectId, events);
		return events;
	} catch {
		const events: Record<string, unknown>[] = [];
		ctx.eventHistory.set(projectId, events);
		return events;
	}
}

export async function flushEvents(ctx: DaemonContext): Promise<void> {
	const dirty = [...ctx.eventsDirty];
	ctx.eventsDirty.clear();
	const eventsDir = join(ctx.config.dataDir, "events");
	await mkdir(eventsDir, { recursive: true });
	for (const projectId of dirty) {
		const history = ctx.eventHistory.get(projectId);
		if (history) {
			try {
				await writeFile(
					eventsPath(ctx, projectId),
					JSON.stringify(history),
					"utf-8",
				);
			} catch {
				/* non-fatal */
			}
		}
	}
}

export function scheduleEventFlush(
	ctx: DaemonContext,
	projectId: string,
): void {
	ctx.eventsDirty.add(projectId);
	if (!ctx.eventFlushTimer) {
		ctx.eventFlushTimer = setTimeout(async () => {
			ctx.eventFlushTimer = null;
			await flushEvents(ctx);
		}, 2000); // batch writes every 2s
	}
}

export function getEventHistory(
	ctx: DaemonContext,
	projectId: string,
): Record<string, unknown>[] {
	if (!ctx.eventHistory.has(projectId)) ctx.eventHistory.set(projectId, []);
	return ctx.eventHistory.get(projectId) as Record<string, unknown>[];
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

/** Broadcast an agent event to subscribers and store in history. */
export function broadcastEvent(
	ctx: DaemonContext,
	projectId: string,
	event: Record<string, unknown>,
) {
	// Store in history (skip tree_updated, text_delta, agent_idle/active — too granular for persistence)
	if (
		event.type !== "tree_updated" &&
		event.type !== "agent_idle" &&
		event.type !== "agent_active" &&
		!(event.type === "agent_event" && event.eventType === "text_delta")
	) {
		const history = getEventHistory(ctx, projectId);
		history.push({ ...event, timestamp: Date.now() });
		if (history.length > ctx.MAX_EVENT_HISTORY) {
			history.splice(0, history.length - ctx.MAX_EVENT_HISTORY);
		}
		scheduleEventFlush(ctx, projectId);
	}
	broadcast(ctx.wsClients, projectId, event);

	// Track clarification_requested events for Web UI display
	if (
		event.type === "clarification_requested" &&
		typeof event.taskId === "string" &&
		typeof event.question === "string"
	) {
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
