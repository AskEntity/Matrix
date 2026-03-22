import type { Event } from "../events.ts";
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

/** Broadcast an event to all SSE clients subscribed to a project (SSE transport only, no persistence). */
export function broadcast(
	clients: Set<SSEClient>,
	projectId: string,
	event: Record<string, unknown>,
) {
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

// --- Ephemeral event detection ---

/**
 * Ephemeral events are NOT persisted to JSONL — they're live-only.
 * Provider events (assistant_text, tool_call, tool_result, compact_marker) are
 * already written to JSONL by the provider — emitEvent skips them to prevent double-write.
 */
const EPHEMERAL_EVENT_TYPES = new Set([
	"text_delta",
	"usage",
	"agent_idle",
	"agent_active",
	"status",
	"clarification_timeout",
	"heartbeat",
	// tree_updated carries full tree payload — ephemeral push, not JSONL
	"tree_updated",
]);

function isEphemeral(type: string): boolean {
	return EPHEMERAL_EVENT_TYPES.has(type);
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
export function emitEvent(ctx: DaemonContext, projectId: string, event: Event) {
	// Broadcast to all SSE clients
	broadcast(
		ctx.sseClients,
		projectId,
		event as unknown as Record<string, unknown>,
	);

	// Persist non-ephemeral events to JSONL
	if (!isEphemeral(event.type)) {
		const rootNodeId = ctx.trackers.get(projectId)?.rootNodeId ?? undefined;
		const taskId =
			"taskId" in event ? (event.taskId as string | undefined) : undefined;
		const sessionId = taskId || rootNodeId;
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
 * The tree_mutation lifecycle events in JSONL provide the persistent record.
 */
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
