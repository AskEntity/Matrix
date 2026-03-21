import type { Hono } from "hono";
import { globalAgentQueues } from "../../message-queue.ts";
import type { DaemonContext, SSEClient } from "../context.ts";
import {
	getEventsSince,
	getPendingClarifications,
	pendingTextForMessage,
} from "../event-system.ts";
import { getTracker } from "../helpers.ts";

const encoder = new TextEncoder();

/** Send an SSE event to a single client, with optional sequence ID. */
function sendSSE(
	client: SSEClient,
	data: Record<string, unknown>,
	seqId?: number,
): void {
	try {
		const json = JSON.stringify(data);
		const msg =
			seqId != null ? `id: ${seqId}\ndata: ${json}\n\n` : `data: ${json}\n\n`;
		client.controller.enqueue(encoder.encode(msg));
	} catch {
		// Client disconnected — caller should clean up
	}
}

/** Send initial state (tree, pending messages, pending clarifications) on SSE connect. */
async function sendInitialState(
	ctx: DaemonContext,
	client: SSEClient,
	projectId: string,
): Promise<void> {
	// Send current tree
	let tracker = ctx.trackers.get(projectId);
	if (!tracker) {
		try {
			tracker = await getTracker(ctx, projectId);
		} catch {
			/* project data not found — ok */
		}
	}
	if (tracker) {
		sendSSE(client, {
			type: "tree_updated",
			nodes: tracker.allNodes(),
			rootNodeId: tracker.rootNodeId,
		});
	}

	// Send current pending messages — derived from queue state for ALL agents
	if (tracker) {
		for (const node of tracker.allNodes()) {
			const agentQueue = globalAgentQueues.get(node.id);
			if (agentQueue) {
				const msgs = agentQueue.peekMessages();
				if (msgs.length > 0) {
					const taskId = node.id === tracker.rootNodeId ? null : node.id;
					const pending = msgs.map((m, i) => ({
						id: `pending-${Date.now()}-${i}`,
						taskId,
						text: pendingTextForMessage(m),
						timestamp: Date.now(),
					}));
					sendSSE(client, {
						type: "pending_messages",
						projectId,
						taskId,
						messages: pending,
					});
				}
			}
		}
	}

	// Send current pending clarifications
	const clarifications = getPendingClarifications(ctx, projectId);
	if (clarifications.length > 0) {
		sendSSE(client, {
			type: "pending_clarifications",
			projectId,
			clarifications,
		});
	}
}

/**
 * Replay buffered events since lastSeqId to a client.
 * Returns true if catch-up succeeded, false if gap too large (need full refresh).
 */
function replayCatchUp(
	client: SSEClient,
	projectId: string,
	lastSeqId: number,
): boolean {
	const events = getEventsSince(projectId, lastSeqId);
	if (events === null) return false; // Gap too large

	for (const entry of events) {
		try {
			const msg = `id: ${entry.seqId}\ndata: ${entry.data}\n\n`;
			client.controller.enqueue(encoder.encode(msg));
		} catch {
			return false; // Client disconnected
		}
	}
	return true;
}

export function registerSSERoute(app: Hono, ctx: DaemonContext) {
	app.get("/events", (c) => {
		const projectId = c.req.query("projectId");
		if (!projectId) return c.text("projectId required", 400);

		// EventSource sends Last-Event-ID on reconnect
		const lastEventId = c.req.header("Last-Event-ID");
		const lastSeqId = lastEventId ? Number.parseInt(lastEventId, 10) : null;

		const stream = new ReadableStream({
			start(controller) {
				const client: SSEClient = { controller, projectId };
				ctx.sseClients.add(client);

				let catchUpDone = false;

				// If reconnecting with Last-Event-ID, try ring buffer catch-up
				if (lastSeqId != null && !Number.isNaN(lastSeqId)) {
					catchUpDone = replayCatchUp(client, projectId, lastSeqId);
				}

				// If no Last-Event-ID or catch-up failed (gap too large),
				// send full initial state
				if (!catchUpDone) {
					sendInitialState(ctx, client, projectId);
				}

				// Two-tier heartbeat:
				// 1. SSE comment every 15s — keeps TCP alive through proxies
				//    (CF Tunnel kills idle connections ~100s)
				// 2. Data heartbeat every 120s — triggers onmessage so client
				//    watchdog can detect dead connections
				const commentHeartbeat = setInterval(() => {
					try {
						controller.enqueue(encoder.encode(": heartbeat\n\n"));
					} catch {
						// Client disconnected — interval will be cleared below
					}
				}, 15_000);
				const dataHeartbeat = setInterval(() => {
					try {
						controller.enqueue(
							encoder.encode(
								`data: ${JSON.stringify({ type: "heartbeat" })}\n\n`,
							),
						);
					} catch {
						// Client disconnected — interval will be cleared below
					}
				}, 120_000);

				// Clean up on disconnect
				c.req.raw.signal.addEventListener("abort", () => {
					clearInterval(commentHeartbeat);
					clearInterval(dataHeartbeat);
					ctx.sseClients.delete(client);
				});
			},
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	});
}
