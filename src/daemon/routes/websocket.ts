import type { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import type { QueueImage } from "../../message-queue.ts";
import {
	handleClarifyResponse,
	handleInjectMessage,
	handleOrchestrate,
} from "../agent-lifecycle.ts";
import type { DaemonContext, WSClient } from "../context.ts";
import {
	broadcastEvent,
	getPendingClarifications,
	getPendingMessages,
	loadEventHistory,
} from "../event-system.ts";
import { getTracker } from "../helpers.ts";

export function registerWebSocketRoute(
	app: Hono,
	ctx: DaemonContext,
	orchestratorSystemPrompt: string,
) {
	app.get(
		"/ws",
		upgradeWebSocket((_c) => {
			const client: WSClient = {
				ws: null as unknown as import("hono/ws").WSContext,
				projectId: null,
			};

			return {
				onOpen(_evt, ws) {
					client.ws = ws;
					ctx.wsClients.add(client);
				},
				async onMessage(evt, ws) {
					try {
						const msg = JSON.parse(
							typeof evt.data === "string" ? evt.data : "",
						) as {
							type: string;
							projectId?: string;
							prompt?: string;
							model?: string;
							childModel?: string;
							taskId?: string;
							answer?: string;
							images?: QueueImage[];
						};

						if (msg.type === "subscribe" && msg.projectId) {
							client.projectId = msg.projectId;
							// Send current tree immediately
							let tracker = ctx.trackers.get(msg.projectId);
							if (!tracker) {
								// Load tracker if not in memory yet
								try {
									tracker = await getTracker(ctx, msg.projectId);
								} catch {
									/* project data not found — ok */
								}
							}
							if (tracker) {
								ws.send(
									JSON.stringify({
										type: "tree_updated",
										nodes: tracker.allNodes(),
									}),
								);
							}
							// Send event history so client has full context (load from disk if needed)
							let history = ctx.eventHistory.get(msg.projectId);
							if (!history) {
								history = await loadEventHistory(ctx, msg.projectId);
							}
							if (history.length > 0) {
								ws.send(
									JSON.stringify({
										type: "event_history",
										events: history,
									}),
								);
							}
							// Send current pending messages
							const pending = getPendingMessages(ctx, msg.projectId);
							if (pending.length > 0) {
								ws.send(
									JSON.stringify({
										type: "pending_messages",
										projectId: msg.projectId,
										messages: pending,
									}),
								);
							}
							// Send current pending clarifications
							const clarifications = getPendingClarifications(
								ctx,
								msg.projectId,
							);
							if (clarifications.length > 0) {
								ws.send(
									JSON.stringify({
										type: "pending_clarifications",
										projectId: msg.projectId,
										clarifications,
									}),
								);
							}
						}

						if (msg.type === "orchestrate" && msg.projectId && msg.prompt) {
							const result = await handleOrchestrate(
								ctx,
								msg.projectId,
								msg.prompt,
								{ model: msg.model, childModel: msg.childModel },
								orchestratorSystemPrompt,
							);
							if (!result.ok) {
								ws.send(
									JSON.stringify({ type: "error", message: result.error }),
								);
							}
						}

						if (
							msg.type === "clarify_response" &&
							msg.projectId &&
							msg.taskId &&
							msg.answer
						) {
							// Errors silently ignored for WS clarify (matches previous behavior)
							handleClarifyResponse(ctx, msg.projectId, msg.taskId, msg.answer);
						}

						if (msg.type === "inject_message" && msg.projectId && msg.prompt) {
							const result = handleInjectMessage(
								ctx,
								msg.projectId,
								msg.prompt,
								msg.images,
							);
							if (result.ok) {
								broadcastEvent(ctx, msg.projectId, {
									type: "message_injected",
									message: msg.prompt,
								});
							} else {
								ws.send(
									JSON.stringify({ type: "error", message: result.error }),
								);
							}
						}
					} catch {
						/* ignore parse errors */
					}
				},
				onClose() {
					ctx.wsClients.delete(client);
				},
			};
		}),
	);
}
