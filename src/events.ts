import type { QueueMessage } from "./message-queue.ts";

/**
 * Strongly-typed event — provider-agnostic, one event per action.
 * Each event represents a single atomic action (no batching).
 *
 * Queue-originated events (previously nested under queue_message) are now
 * independent types. They can be identified by isQueueEvent() for batching.
 */
export type Event =
	| {
			type: "user_message";
			content: string;
			cwd?: string;
			isResume?: boolean;
			images?: Array<{ base64: string; mediaType: string }>;
			ts: number;
	  }
	| { type: "assistant_text"; content: string; ts: number }
	| {
			type: "tool_call";
			tool: string;
			toolCallId: string;
			input: Record<string, unknown>;
			ts: number;
	  }
	| {
			type: "tool_result";
			toolCallId: string;
			content: string;
			isError: boolean;
			images?: Array<{ base64: string; mediaType: string }>;
			ts: number;
	  }
	| {
			type: "child_complete";
			taskId: string;
			title: string;
			success: boolean;
			output: string;
			ts: number;
	  }
	| {
			type: "parent_update";
			content: string;
			requestReply?: boolean;
			ts: number;
	  }
	| { type: "clarify_response"; answer: string; ts: number }
	| {
			type: "child_report";
			taskId: string;
			title: string;
			content: string;
			requestReply?: boolean;
			ts: number;
	  }
	| {
			type: "cross_project";
			fromProjectId: string;
			fromProjectName: string;
			content: string;
			ts: number;
	  }
	| {
			type: "background_complete";
			command: string;
			commandId: string;
			exitCode: number | null;
			durationMs: number;
			ts: number;
	  }
	| { type: "system_notification"; content: string; ts: number }
	| { type: "compact_request"; ts: number }
	| { type: "compacted_resume"; content: string; cwd?: string; ts: number }
	| { type: "summarization_request"; instruction: string; ts: number }
	| { type: "budget_warning"; warning: string; ts: number }
	| {
			type: "compact_marker";
			checkpoint: string;
			savedTokens: number;
			ts: number;
	  };

/** Event types that originate from the message queue (idle drain or cancellation points). */
const QUEUE_EVENT_TYPES = new Set([
	"child_complete",
	"parent_update",
	"clarify_response",
	"child_report",
	"cross_project",
	"background_complete",
	"system_notification",
	"compact_request",
]);

/**
 * Check if an event originated from the message queue.
 * user_message is ambiguous (can be provider or queue) — NOT included here.
 * The converter handles user_message specially based on context.
 */
export function isQueueEvent(event: Event): boolean {
	return QUEUE_EVENT_TYPES.has(event.type);
}

/**
 * Lifecycle/broadcast events — emitted over WebSocket but NOT persisted to EventStore.
 * These represent agent lifecycle state changes and ephemeral streaming data.
 */
export type BroadcastEvent =
	| { type: "text_delta"; content: string; taskId: string; ts: number }
	| {
			type: "assistant_text";
			content: string;
			taskId: string;
			ts: number;
	  }
	| {
			type: "tool_call";
			tool: string;
			toolUseId: string;
			input: Record<string, unknown>;
			taskId: string;
			ts: number;
	  }
	| {
			type: "tool_result";
			tool: string;
			toolUseId: string;
			content: string;
			isError: boolean;
			images?: Array<{ base64: string; mediaType: string }>;
			taskId: string;
			ts: number;
	  }
	| {
			type: "usage";
			taskId: string;
			inputTokens: number;
			contextWindow: number;
			estimated?: boolean;
			ts: number;
	  }
	| {
			type: "orchestration_started";
			taskId: string;
			resume: boolean;
			prompt?: string;
			model?: string;
			provider?: string;
			ts: number;
	  }
	| {
			type: "orchestration_completed";
			taskId: string;
			success: boolean;
			costUsd?: number;
			turns?: number;
			inputTokens?: number;
			cacheCreationTokens?: number;
			cacheReadTokens?: number;
			outputTokens?: number;
			childCosts?: {
				totalCostUsd: number;
				totalTurns: number;
				taskCount: number;
			};
			ts: number;
	  }
	| { type: "task_started"; taskId: string; title: string; ts: number }
	| {
			type: "task_completed";
			taskId: string;
			title: string;
			success: boolean;
			output?: string;
			error?: string;
			ts: number;
	  }
	| { type: "agent_stopped"; taskId?: string; ts: number }
	| { type: "agent_idle"; taskId: string; ts: number }
	| { type: "agent_active"; taskId: string; ts: number }
	| { type: "error"; taskId?: string; message: string; ts: number }
	| {
			type: "budget_exceeded";
			taskId: string;
			title: string;
			costUsd?: number;
			budgetUsd?: number;
			ts: number;
	  }
	| {
			type: "clarification_requested";
			taskId: string;
			question: string;
			ts: number;
	  }
	| {
			type: "clarification_answered";
			taskId: string;
			answer: string;
			ts: number;
	  }
	| {
			type: "tree_mutation";
			action: string;
			nodeId: string;
			title?: string;
			ts: number;
	  }
	| { type: "compact_started"; taskId: string; ts: number }
	| {
			type: "compact_marker";
			checkpoint: string;
			savedTokens: number;
			taskId: string;
			ts: number;
	  }
	| {
			type: "queue_message";
			messages: string;
			rawMessages?: Array<{
				source: string;
				content: string;
				images?: { base64: string; mediaType: string }[];
			}>;
			taskId: string;
			ts: number;
	  }
	| { type: "status"; message: string; taskId: string; ts: number }
	| { type: "message_injected"; message: string; ts: number }
	| {
			type: "clarification_timeout";
			taskId?: string;
			timeoutMs: number;
			ts: number;
	  };

/** Convert a QueueMessage to a concrete Event type. */
export function queueMessageToEvent(msg: QueueMessage): Event {
	const ts = Date.now();
	switch (msg.source) {
		case "user":
			return {
				type: "user_message",
				content: msg.content,
				...(msg.images?.length
					? {
							images: msg.images.map((img) => ({
								base64: img.base64,
								mediaType: img.mediaType,
							})),
						}
					: {}),
				ts,
			};
		case "child_complete":
			return {
				type: "child_complete",
				taskId: msg.taskId,
				title: msg.title,
				success: msg.success,
				output: msg.output,
				ts,
			};
		case "parent_update":
			return {
				type: "parent_update",
				content: msg.content,
				...(msg.requestReply ? { requestReply: true } : {}),
				ts,
			};
		case "clarify_response":
			return {
				type: "clarify_response",
				answer: msg.answer,
				ts,
			};
		case "child_report":
			return {
				type: "child_report",
				taskId: msg.taskId,
				title: msg.title,
				content: msg.content,
				...(msg.requestReply ? { requestReply: true } : {}),
				ts,
			};
		case "cross_project":
			return {
				type: "cross_project",
				fromProjectId: msg.fromProjectId,
				fromProjectName: msg.fromProjectName,
				content: msg.content,
				ts,
			};
		case "background_complete":
			return {
				type: "background_complete",
				command: msg.command,
				commandId: msg.commandId,
				exitCode: msg.exitCode,
				durationMs: msg.durationMs,
				ts,
			};
		case "system":
			return {
				type: "system_notification",
				content: msg.content,
				ts,
			};
		case "compact":
			return { type: "compact_request", ts };
	}
}

/**
 * Format a concrete Event for inclusion in provider messages.
 * Simple messages (user_message) use raw content.
 * Single-field messages (clarify_response, system_notification) use XML tags for semantic clarity.
 * Multi-field messages (child_complete, parent_update, etc.) use XML tags for structured data.
 */
export function formatEventForAI(event: Event): string {
	switch (event.type) {
		case "user_message":
			return event.content;
		case "clarify_response":
			return `<clarify_response>${event.answer}</clarify_response>`;
		case "system_notification":
			return `<system_notification>${event.content}</system_notification>`;
		case "compact_request":
			return "Manual compaction requested";
		case "child_complete":
			return `<child_complete task="${event.title}" id="${event.taskId}" status="${event.success ? "passed" : "failed"}">${event.output.slice(0, 500)}</child_complete>`;
		case "parent_update":
			return `<parent_update${event.requestReply ? ' requestReply="true"' : ""}>${event.content}</parent_update>`;
		case "child_report":
			return `<child_report from="${event.title}" id="${event.taskId}"${event.requestReply ? ' requestReply="true"' : ""}>${event.content}</child_report>`;
		case "cross_project":
			return `<cross_project from="${event.fromProjectName}" projectId="${event.fromProjectId}">${event.content}</cross_project>`;
		case "background_complete":
			return `<background_complete command="${event.command}" id="${event.commandId}" exit="${event.exitCode}" duration="${event.durationMs}ms">Command completed. Use bg_action="status" with background_id="${event.commandId}" or read_file on output files to see results.</background_complete>`;
		default:
			return "";
	}
}

/**
 * Normalize legacy queue_message events from old JSONL files into concrete Event types.
 * Returns the event unchanged if it's not a legacy queue_message.
 */
function normalizeLegacyEvent(event: Event): Event {
	const e = event as Record<string, unknown>;
	if (e.type !== "queue_message" || !e.source) return event;

	const ts = (e.ts as number) ?? Date.now();
	switch (e.source) {
		case "user":
			return {
				type: "user_message",
				content: (e.content as string) ?? "",
				...(e.images
					? { images: e.images as Array<{ base64: string; mediaType: string }> }
					: {}),
				ts,
			};
		case "child_complete":
			return {
				type: "child_complete",
				taskId: (e.taskId as string) ?? "",
				title: (e.title as string) ?? "",
				success: (e.success as boolean) ?? false,
				output: (e.output as string) ?? "",
				ts,
			};
		case "parent_update":
			return {
				type: "parent_update",
				content: (e.content as string) ?? "",
				...(e.requestReply ? { requestReply: true } : {}),
				ts,
			};
		case "clarify_response":
			return {
				type: "clarify_response",
				answer: (e.answer as string) ?? "",
				ts,
			};
		case "child_report":
			return {
				type: "child_report",
				taskId: (e.taskId as string) ?? "",
				title: (e.title as string) ?? "",
				content: (e.content as string) ?? "",
				...(e.requestReply ? { requestReply: true } : {}),
				ts,
			};
		case "cross_project":
			return {
				type: "cross_project",
				fromProjectId: (e.fromProjectId as string) ?? "",
				fromProjectName: (e.fromProjectName as string) ?? "",
				content: (e.content as string) ?? "",
				ts,
			};
		case "background_complete":
			return {
				type: "background_complete",
				command: (e.command as string) ?? "",
				commandId: (e.commandId as string) ?? "",
				exitCode: (e.exitCode as number | null) ?? null,
				durationMs: (e.durationMs as number) ?? 0,
				ts,
			};
		case "system":
			return {
				type: "system_notification",
				content: (e.content as string) ?? "",
				ts,
			};
		case "compact":
			return { type: "compact_request", ts };
		default:
			return event;
	}
}

/**
 * Reconstruct Anthropic-format messages from events.
 * Pure function — no side effects or external dependencies.
 *
 * Key batching rules:
 * - assistant_text + consecutive tool_calls → single assistant message
 * - consecutive tool_results (with optional queue events) → single user message
 * - compact_marker → skipped (readActive handles filtering)
 */
export function eventsToAnthropicMessages(rawEvents: Event[]): unknown[] {
	// Normalize legacy queue_message events on the fly
	const events = rawEvents.map(normalizeLegacyEvent);
	const messages: unknown[] = [];
	let i = 0;

	while (i < events.length) {
		const event = events[i] as Event;

		switch (event.type) {
			case "user_message":
				messages.push({ role: "user", content: event.content });
				i++;
				break;

			case "compacted_resume":
				messages.push({ role: "user", content: event.content });
				i++;
				break;

			case "summarization_request":
				messages.push({ role: "user", content: event.instruction });
				i++;
				break;

			case "budget_warning":
				messages.push({ role: "user", content: event.warning });
				i++;
				break;

			case "assistant_text":
			case "tool_call": {
				// Collect assistant_text + consecutive tool_calls into one assistant message
				const contentBlocks: unknown[] = [];

				// Collect text block(s)
				while (
					i < events.length &&
					(events[i] as Event).type === "assistant_text"
				) {
					const textEvent = events[i] as Event & {
						type: "assistant_text";
					};
					contentBlocks.push({ type: "text", text: textEvent.content });
					i++;
				}

				// Collect tool_call blocks
				while (i < events.length && (events[i] as Event).type === "tool_call") {
					const tcEvent = events[i] as Event & { type: "tool_call" };
					contentBlocks.push({
						type: "tool_use",
						id: tcEvent.toolCallId,
						name: tcEvent.tool,
						input: tcEvent.input,
						caller: { type: "direct" },
					});
					i++;
				}

				// Always use array content format (matches Anthropic API response.content)
				messages.push({ role: "assistant", content: contentBlocks });
				break;
			}

			case "tool_result": {
				// Collect consecutive tool_results (with optional queue events for cancellation points) into one user message
				const resultBlocks: unknown[] = [];
				// Queue message images (user-sent) go as sibling blocks after all tool_results
				const queueImageBlocks: unknown[] = [];

				while (i < events.length) {
					const current = events[i] as Event;
					if (current.type === "tool_result") {
						if (current.images && current.images.length > 0) {
							const contentParts: unknown[] = [];
							for (const img of current.images) {
								contentParts.push({
									type: "image",
									source: {
										type: "base64",
										media_type: img.mediaType,
										data: img.base64,
									},
								});
							}
							contentParts.push({ type: "text", text: current.content });
							resultBlocks.push({
								type: "tool_result",
								tool_use_id: current.toolCallId,
								content: contentParts,
							});
						} else {
							resultBlocks.push({
								type: "tool_result",
								tool_use_id: current.toolCallId,
								content: current.content,
								is_error: current.isError,
							});
						}
						i++;
					} else if (isQueueEvent(current) || current.type === "user_message") {
						// Queue events at cancellation points (between tool_results)
						// user_message between tool_results is always queue-originated
						const formatted = formatEventForAI(current);
						const queueText = `[Messages received while you were working:]\n${formatted}`;
						resultBlocks.push({ type: "text", text: queueText });
						if (current.type === "user_message" && current.images) {
							for (const img of current.images) {
								queueImageBlocks.push({
									type: "image",
									source: {
										type: "base64",
										media_type: img.mediaType,
										data: img.base64,
									},
								});
							}
						}
						i++;
					} else {
						break;
					}
				}

				if (queueImageBlocks.length > 0) {
					messages.push({
						role: "user",
						content: [
							...resultBlocks,
							...queueImageBlocks,
							{
								type: "text",
								text: `[${queueImageBlocks.length} image(s) attached by user]`,
							},
						],
					});
				} else {
					messages.push({ role: "user", content: resultBlocks });
				}
				break;
			}

			// Queue-originated events (standalone, from idle drain)
			case "child_complete":
			case "parent_update":
			case "clarify_response":
			case "child_report":
			case "cross_project":
			case "background_complete":
			case "system_notification":
			case "compact_request": {
				// Collect consecutive queue events into a single user message
				const queueContents: string[] = [];
				const queueImageBlocks: unknown[] = [];

				while (i < events.length) {
					const current = events[i] as Event;
					if (isQueueEvent(current) || current.type === "user_message") {
						queueContents.push(formatEventForAI(current));
						if (current.type === "user_message" && current.images) {
							for (const img of current.images) {
								queueImageBlocks.push({
									type: "image",
									source: {
										type: "base64",
										media_type: img.mediaType,
										data: img.base64,
									},
								});
							}
						}
						i++;
					} else {
						break;
					}
				}

				const joined = queueContents.join("\n");
				const idleText = `[Messages received while you were idle:]\n${joined}`;
				if (queueImageBlocks.length > 0) {
					messages.push({
						role: "user",
						content: [{ type: "text", text: idleText }, ...queueImageBlocks],
					});
				} else {
					messages.push({ role: "user", content: idleText });
				}
				break;
			}

			case "compact_marker":
				// Skip — readActive handles filtering by compact markers
				i++;
				break;
		}
	}
	return messages;
}

/**
 * Reconstruct OpenAI-format messages from events.
 * Pure function — no side effects or external dependencies.
 *
 * Key differences from Anthropic converter:
 * - assistant_text + tool_calls → single message with `content` and `tool_calls` array
 * - tool_results → individual `{ role: "tool" }` messages (not batched into one user message)
 * - Images from tool_results → separate `{ role: "user" }` message with image_url parts
 * - queue events between tool_results → appended to last tool result content
 * - compact_marker → skipped
 */
export function eventsToOpenAIMessages(rawEvents: Event[]): unknown[] {
	const events = rawEvents.map(normalizeLegacyEvent);
	const messages: unknown[] = [];
	// Map toolCallId → tool name for resolving tool_result.name
	const toolNames = new Map<string, string>();
	let i = 0;

	while (i < events.length) {
		const event = events[i] as Event;

		switch (event.type) {
			case "user_message":
				messages.push({ role: "user", content: event.content });
				i++;
				break;

			case "compacted_resume":
				messages.push({ role: "user", content: event.content });
				i++;
				break;

			case "summarization_request":
				messages.push({ role: "user", content: event.instruction });
				i++;
				break;

			case "budget_warning":
				messages.push({ role: "user", content: event.warning });
				i++;
				break;

			case "assistant_text":
			case "tool_call": {
				// Collect assistant_text + consecutive tool_calls into one assistant message
				let textContent: string | null = null;
				const toolCalls: Array<{
					id: string;
					type: "function";
					function: { name: string; arguments: string };
				}> = [];

				// Collect text
				while (
					i < events.length &&
					(events[i] as Event).type === "assistant_text"
				) {
					const textEvent = events[i] as Event & {
						type: "assistant_text";
					};
					textContent =
						textContent === null
							? textEvent.content
							: `${textContent}\n${textEvent.content}`;
					i++;
				}

				// Collect tool_calls
				while (i < events.length && (events[i] as Event).type === "tool_call") {
					const tcEvent = events[i] as Event & { type: "tool_call" };
					toolCalls.push({
						id: tcEvent.toolCallId,
						type: "function",
						function: {
							name: tcEvent.tool,
							arguments: JSON.stringify(tcEvent.input),
						},
					});
					// Register tool name for later tool_result resolution
					toolNames.set(tcEvent.toolCallId, tcEvent.tool);
					i++;
				}

				const msg: Record<string, unknown> = {
					role: "assistant",
					content: textContent,
				};
				if (toolCalls.length > 0) {
					msg.tool_calls = toolCalls;
				}
				messages.push(msg);
				break;
			}

			case "tool_result": {
				// Process tool_results as individual messages, with queue events
				// appended to the preceding tool result and images collected for a user message
				const toolImageResults: Array<{
					text: string;
					dataUri: string;
				}> = [];
				const queueImageResults: Array<{
					text: string;
					dataUri: string;
				}> = [];

				while (i < events.length) {
					const current = events[i] as Event;
					if (current.type === "tool_result") {
						const toolName = toolNames.get(current.toolCallId) ?? "unknown";
						messages.push({
							role: "tool",
							tool_call_id: current.toolCallId,
							name: toolName,
							content: current.content,
						});
						if (current.images) {
							for (const img of current.images) {
								toolImageResults.push({
									text: current.content,
									dataUri: `data:${img.mediaType};base64,${img.base64}`,
								});
							}
						}
						i++;
					} else if (isQueueEvent(current) || current.type === "user_message") {
						// Queue events at cancellation points are appended to last tool result
						// user_message between tool_results is always queue-originated
						const formatted = formatEventForAI(current);
						const lastMsg = messages[messages.length - 1] as
							| { role: string; content: string }
							| undefined;
						if (
							lastMsg?.role === "tool" &&
							typeof lastMsg.content === "string"
						) {
							lastMsg.content += `\n\n---\n[Messages received while you were working:]\n${formatted}`;
						}
						if (current.type === "user_message" && current.images) {
							for (const img of current.images) {
								queueImageResults.push({
									text: "[User-attached image]",
									dataUri: `data:${img.mediaType};base64,${img.base64}`,
								});
							}
						}
						i++;
					} else {
						break;
					}
				}

				// Inject tool images as a user message (OpenAI tool results are text-only)
				const allImageResults = [...toolImageResults, ...queueImageResults];
				if (allImageResults.length > 0) {
					const imageParts: unknown[] = [];
					for (const img of allImageResults) {
						imageParts.push(
							{ type: "text", text: img.text },
							{
								type: "image_url",
								image_url: { url: img.dataUri, detail: "auto" },
							},
						);
					}
					messages.push({ role: "user", content: imageParts });
				}
				break;
			}

			// Queue-originated events (standalone, from idle drain)
			case "child_complete":
			case "parent_update":
			case "clarify_response":
			case "child_report":
			case "cross_project":
			case "background_complete":
			case "system_notification":
			case "compact_request": {
				const oaiQueueContents: string[] = [];
				const oaiQueueImageParts: unknown[] = [];

				while (i < events.length) {
					const current = events[i] as Event;
					if (isQueueEvent(current) || current.type === "user_message") {
						oaiQueueContents.push(formatEventForAI(current));
						if (current.type === "user_message" && current.images) {
							for (const img of current.images) {
								oaiQueueImageParts.push(
									{ type: "text", text: "[User-attached image]" },
									{
										type: "image_url",
										image_url: {
											url: `data:${img.mediaType};base64,${img.base64}`,
											detail: "auto",
										},
									},
								);
							}
						}
						i++;
					} else {
						break;
					}
				}

				const oaiJoined = oaiQueueContents.join("\n");
				const oaiIdleText = `[Messages received while you were idle:]\n${oaiJoined}`;
				if (oaiQueueImageParts.length > 0) {
					messages.push({
						role: "user",
						content: [
							{ type: "text", text: oaiIdleText },
							...oaiQueueImageParts,
						],
					});
				} else {
					messages.push({ role: "user", content: oaiIdleText });
				}
				break;
			}

			case "compact_marker":
				// Skip — readActive handles filtering by compact markers
				i++;
				break;
		}
	}
	return messages;
}
