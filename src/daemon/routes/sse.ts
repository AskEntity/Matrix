import type { Hono } from "hono";
import { globalAgentQueues } from "../../message-queue.ts";
import type { DaemonContext, SSEClient } from "../context.ts";
import {
	getPendingClarifications,
	pendingTextForMessage,
} from "../event-system.ts";
import { getTracker } from "../helpers.ts";

const encoder = new TextEncoder();

/** Send an SSE event to a single client. */
function sendSSE(client: SSEClient, data: Record<string, unknown>): void {
	try {
		const msg = `data: ${JSON.stringify(data)}\n\n`;
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

export function registerSSERoute(app: Hono, ctx: DaemonContext) {
	app.get("/events", (c) => {
		const projectId = c.req.query("projectId");
		if (!projectId) return c.text("projectId required", 400);

		const stream = new ReadableStream({
			start(controller) {
				const client: SSEClient = { controller, projectId };
				ctx.sseClients.add(client);

				// Send initial state (tree, pending messages, pending clarifications)
				sendInitialState(ctx, client, projectId);

				// Clean up on disconnect
				c.req.raw.signal.addEventListener("abort", () => {
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
