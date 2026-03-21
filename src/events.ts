import { randomUUID } from "node:crypto";
import type { QueueMessage } from "./message-queue.ts";

/**
 * Strongly-typed event — provider-agnostic, one event per action.
 * Each event represents a single atomic action (no batching).
 *
 * Queue-originated events (previously nested under queue_message) are now
 * independent types. They can be identified by isQueueEvent() for batching.
 */
/**
 * UserMessageEvent — unified format for ALL messages that flow through the queue.
 * Uses a `source` field to indicate the message type. Written to JSONL with `id` for tracking.
 *
 * Base form (no source): initial prompt, resume messages — written by provider.
 * Source-typed form: queue-originated messages — written at enqueue time.
 *
 * All fields are optional at the type level. Source-based narrowing happens at runtime.
 * This keeps the type simple and avoids complex discriminated unions.
 */
export interface UserMessageEvent {
	type: "user_message";
	id?: string;
	/** Message source. Absent for initial prompt/resume. Present for queue messages. */
	source?: string;
	content?: string;
	cwd?: string;
	isResume?: boolean;
	images?: Array<{ base64: string; mediaType: string }>;
	// Queue-specific fields (present based on source)
	taskId?: string;
	title?: string;
	success?: boolean;
	output?: string;
	requestReply?: boolean;
	answer?: string;
	fromProjectId?: string;
	fromProjectName?: string;
	command?: string;
	commandId?: string;
	exitCode?: number | null;
	durationMs?: number;
	ts: number;
}

export type Event =
	| UserMessageEvent
	| { type: "assistant_text"; content: string; taskId?: string; ts: number }
	| {
			type: "tool_call";
			tool: string;
			toolCallId: string;
			input: Record<string, unknown>;
			taskId?: string;
			ts: number;
	  }
	| {
			type: "tool_result";
			tool?: string;
			toolCallId: string;
			content: string;
			isError: boolean;
			images?: Array<{ base64: string; mediaType: string }>;
			/** IDs of queue messages consumed at this cancellation point. */
			messagesConsumed?: string[];
			taskId?: string;
			ts: number;
	  }
	// Ephemeral events — broadcast over WS but not persisted to JSONL
	| { type: "text_delta"; content: string; taskId?: string; ts: number }
	| {
			type: "usage";
			taskId?: string;
			inputTokens: number;
			contextWindow: number;
			estimated?: boolean;
			ts: number;
	  }
	| { type: "agent_idle"; taskId: string; ts: number }
	| { type: "agent_active"; taskId: string; ts: number }
	| { type: "status"; message: string; taskId?: string; ts: number }
	| {
			type: "queue_message";
			messages: string;
			rawMessages?: Array<{
				source: string;
				content: string;
				id?: string;
				images?: { base64: string; mediaType: string }[];
			}>;
			taskId?: string;
			ts: number;
	  }
	| {
			type: "clarification_timeout";
			taskId?: string;
			timeoutMs: number;
			ts: number;
	  }
	// Legacy event types — kept for backward compat with old JSONL files.
	// New writes use user_message with source field instead.
	| {
			type: "child_complete";
			id?: string;
			taskId: string;
			title: string;
			success: boolean;
			output: string;
			ts: number;
	  }
	| {
			type: "parent_update";
			id?: string;
			content: string;
			requestReply?: boolean;
			ts: number;
	  }
	| { type: "clarify_response"; id?: string; answer: string; ts: number }
	| {
			type: "child_report";
			id?: string;
			taskId: string;
			title: string;
			content: string;
			requestReply?: boolean;
			ts: number;
	  }
	| {
			type: "cross_project";
			id?: string;
			fromProjectId: string;
			fromProjectName: string;
			content: string;
			ts: number;
	  }
	| {
			type: "background_complete";
			id?: string;
			command: string;
			commandId: string;
			exitCode: number | null;
			durationMs: number;
			ts: number;
	  }
	| { type: "system_notification"; id?: string; content: string; ts: number }
	| { type: "compact_request"; id?: string; ts: number }
	| { type: "compacted_resume"; content: string; cwd?: string; ts: number }
	| { type: "summarization_request"; instruction: string; ts: number }
	| { type: "budget_warning"; warning: string; ts: number }
	| {
			type: "compact_marker";
			checkpoint: string;
			savedTokens: number;
			taskId?: string;
			ts: number;
	  }
	// Lifecycle events — persisted to JSONL for activity log replay
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
	| { type: "agent_stopped"; taskId?: string; ts: number }
	| {
			type: "messages_consumed";
			messageIds: string[];
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
 * Legacy concrete types (child_complete, parent_update, etc.) are checked by type.
 * Unified user_message events with a source field are also queue events.
 * user_message WITHOUT source is ambiguous (can be provider or queue) — NOT included here.
 */
export function isQueueEvent(event: Event): boolean {
	if (QUEUE_EVENT_TYPES.has(event.type)) return true;
	// Unified format: user_message with source field (except "user" which is ambiguous)
	if (event.type === "user_message") {
		const src = (event as { source?: string }).source;
		return src !== undefined && src !== "user";
	}
	return false;
}

/**
 * BroadcastEvent is now unified with Event.
 * All event types (persisted + ephemeral) are in the Event union.
 * @deprecated Use Event directly. BroadcastEvent is kept as an alias for backward compat.
 */
export type BroadcastEvent = Event;

/** Convert a QueueMessage to a unified user_message Event with source. */
export function queueMessageToEvent(msg: QueueMessage): UserMessageEvent {
	const ts = Date.now();
	const base = { type: "user_message" as const, id: randomUUID(), ts };
	switch (msg.source) {
		case "user":
			return {
				...base,
				id: msg.id ?? base.id,
				source: "user",
				content: msg.content,
				...(msg.images?.length
					? {
							images: msg.images.map((img) => ({
								base64: img.base64,
								mediaType: img.mediaType,
							})),
						}
					: {}),
			};
		case "child_complete":
			return {
				...base,
				source: "child_complete",
				taskId: msg.taskId,
				title: msg.title,
				success: msg.success,
				output: msg.output,
			};
		case "parent_update":
			return {
				...base,
				source: "parent_update",
				content: msg.content,
				...(msg.requestReply ? { requestReply: true } : {}),
			};
		case "clarify_response":
			return {
				...base,
				source: "clarify_response",
				answer: msg.answer,
			};
		case "child_report":
			return {
				...base,
				source: "child_report",
				taskId: msg.taskId,
				title: msg.title,
				content: msg.content,
				...(msg.requestReply ? { requestReply: true } : {}),
			};
		case "cross_project":
			return {
				...base,
				source: "cross_project",
				fromProjectId: msg.fromProjectId,
				fromProjectName: msg.fromProjectName,
				content: msg.content,
			};
		case "background_complete":
			return {
				...base,
				source: "background_complete",
				command: msg.command,
				commandId: msg.commandId,
				exitCode: msg.exitCode,
				durationMs: msg.durationMs,
			};
		case "system":
			return {
				...base,
				source: "system",
				content: msg.content,
			};
		case "compact":
			return { ...base, source: "compact" };
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
		case "user_message": {
			// Unified user_message with source field
			const src = (event as { source?: string }).source;
			if (!src || src === "user") {
				return (event as { content: string }).content;
			}
			// Format based on source — same formatting as legacy concrete types
			switch (src) {
				case "child_complete": {
					const e = event as {
						taskId: string;
						title: string;
						success: boolean;
						output: string;
					};
					return `<child_complete task="${e.title}" id="${e.taskId}" status="${e.success ? "passed" : "failed"}">${e.output.slice(0, 500)}</child_complete>`;
				}
				case "parent_update": {
					const e = event as { content: string; requestReply?: boolean };
					return `<parent_update${e.requestReply ? ' requestReply="true"' : ""}>${e.content}</parent_update>`;
				}
				case "clarify_response": {
					const e = event as { answer: string };
					return `<clarify_response>${e.answer}</clarify_response>`;
				}
				case "child_report": {
					const e = event as {
						taskId: string;
						title: string;
						content: string;
						requestReply?: boolean;
					};
					return `<child_report from="${e.title}" id="${e.taskId}"${e.requestReply ? ' requestReply="true"' : ""}>${e.content}</child_report>`;
				}
				case "cross_project": {
					const e = event as {
						fromProjectId: string;
						fromProjectName: string;
						content: string;
					};
					return `<cross_project from="${e.fromProjectName}" projectId="${e.fromProjectId}">${e.content}</cross_project>`;
				}
				case "background_complete": {
					const e = event as {
						command: string;
						commandId: string;
						exitCode: number | null;
						durationMs: number;
					};
					return `<background_complete command="${e.command}" id="${e.commandId}" exit="${e.exitCode}" duration="${e.durationMs}ms">Command completed. Use bg_action="status" with background_id="${e.commandId}" or read_file on output files to see results.</background_complete>`;
				}
				case "system":
					return `<system_notification>${(event as { content: string }).content}</system_notification>`;
				case "compact":
					return "Manual compaction requested";
				default:
					return "";
			}
		}
		// Legacy concrete types — backward compat for old JSONL files
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

	// Build index of events by ID for messages_consumed resolution.
	// All queue-originated events can have IDs — user_message, child_complete, etc.
	const eventIndex = new Map<string, Event>();
	for (const e of events) {
		const eid = (e as { id?: string }).id;
		if (eid) {
			eventIndex.set(eid, e);
		}
	}

	while (i < events.length) {
		const event = events[i] as Event;

		switch (event.type) {
			case "user_message":
				// user_message with id = injected message (written at enqueue time).
				// Skip here — it will be materialized at the messages_consumed point.
				if (event.id) {
					i++;
					break;
				}
				messages.push({ role: "user", content: event.content });
				i++;
				break;

			case "messages_consumed": {
				// Resolve referenced events and inject with appropriate wrapper
				const consumedEvents: Event[] = [];
				for (const id of event.messageIds) {
					const msg = eventIndex.get(id);
					if (msg) consumedEvents.push(msg);
				}
				if (consumedEvents.length > 0) {
					// Check context: are we between tool_results?
					const lastMsg = messages[messages.length - 1] as
						| { role: string; content: unknown }
						| undefined;
					const isWorkingContext =
						lastMsg?.role === "user" &&
						Array.isArray(lastMsg.content) &&
						(lastMsg.content as unknown[]).some(
							(b) =>
								b &&
								typeof b === "object" &&
								(b as Record<string, unknown>).type === "tool_result",
						);

					const wrapper = isWorkingContext
						? "[Messages received while you were working:]"
						: "[Messages received while you were idle:]";

					const contents: string[] = [];
					const imageBlocks: unknown[] = [];
					for (const msg of consumedEvents) {
						contents.push(formatEventForAI(msg));
						if (msg.type === "user_message" && msg.images) {
							for (const img of msg.images) {
								imageBlocks.push({
									type: "image",
									source: {
										type: "base64",
										media_type: img.mediaType,
										data: img.base64,
									},
								});
							}
						}
					}

					const text = `${wrapper}\n${contents.join("\n")}`;
					if (isWorkingContext && Array.isArray(lastMsg?.content)) {
						// Append to existing tool_result user message
						(lastMsg.content as unknown[]).push({
							type: "text",
							text,
						});
						if (imageBlocks.length > 0) {
							(lastMsg.content as unknown[]).push(...imageBlocks);
							(lastMsg.content as unknown[]).push({
								type: "text",
								text: `[${imageBlocks.length} image(s) attached by user]`,
							});
						}
					} else if (imageBlocks.length > 0) {
						messages.push({
							role: "user",
							content: [{ type: "text", text }, ...imageBlocks],
						});
					} else {
						messages.push({ role: "user", content: text });
					}
				}
				i++;
				break;
			}

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
						// Handle messagesConsumed on tool_result (cancellation point)
						if (current.messagesConsumed?.length) {
							const mcEvents: Event[] = [];
							for (const mcId of current.messagesConsumed) {
								const mcEvt = eventIndex.get(mcId);
								if (mcEvt) mcEvents.push(mcEvt);
							}
							if (mcEvents.length > 0) {
								const mcContents = mcEvents.map(formatEventForAI);
								const mcText = `[Messages received while you were working:]\n${mcContents.join("\n")}`;
								resultBlocks.push({ type: "text", text: mcText });
								for (const mcEvt of mcEvents) {
									if (mcEvt.type === "user_message" && mcEvt.images) {
										for (const img of mcEvt.images) {
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
								}
							}
						}
						i++;
					} else if (current.type === "messages_consumed") {
						// Standalone messages_consumed between tool_results
						const mcEvents: Event[] = [];
						for (const mcId of (
							current as Event & { type: "messages_consumed" }
						).messageIds) {
							const mcEvt = eventIndex.get(mcId);
							if (mcEvt) mcEvents.push(mcEvt);
						}
						if (mcEvents.length > 0) {
							const mcContents = mcEvents.map(formatEventForAI);
							const mcText = `[Messages received while you were working:]\n${mcContents.join("\n")}`;
							resultBlocks.push({ type: "text", text: mcText });
							for (const mcEvt of mcEvents) {
								if (mcEvt.type === "user_message" && mcEvt.images) {
									for (const img of mcEvt.images) {
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
							}
						}
						i++;
					} else if (isQueueEvent(current) || current.type === "user_message") {
						// Legacy: queue events without IDs at cancellation points
						// (backward compat for old JSONL files)
						const eid = (current as { id?: string }).id;
						if (eid) {
							// Has ID — skip, will be materialized by messages_consumed
							i++;
						} else {
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
						}
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
				// Events with IDs are consumed via messages_consumed — skip them here
				const eid = (event as { id?: string }).id;
				if (eid) {
					i++;
					break;
				}
				// Legacy: collect consecutive queue events without IDs into a single user message
				const queueContents: string[] = [];
				const queueImageBlocks: unknown[] = [];

				while (i < events.length) {
					const current = events[i] as Event;
					if (isQueueEvent(current) || current.type === "user_message") {
						const cid = (current as { id?: string }).id;
						if (cid) {
							// Has ID — skip
							i++;
							continue;
						}
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

				if (queueContents.length === 0) break;

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

			default:
				// Skip lifecycle/broadcast events (orchestration_started, agent_stopped, etc.)
				// that are persisted to JSONL but have no message representation.
				i++;
				break;
		}
	}

	// Fix orphaned tool_use: if the last assistant message has tool_use blocks
	// without matching tool_result blocks, synthesize tool_results.
	// This happens when the daemon stops mid-tool execution — tool_call is written
	// to JSONL before execution, but tool_result never gets written.
	fixOrphanedAnthropicToolUse(messages);

	return messages;
}

/**
 * Detect and fix orphaned tool_use blocks in Anthropic message arrays.
 * If the last assistant message has tool_use blocks, check for matching
 * tool_result blocks in the following user message. Synthesize missing ones.
 */
function fixOrphanedAnthropicToolUse(messages: unknown[]): void {
	if (messages.length === 0) return;

	const lastMsg = messages[messages.length - 1] as {
		role?: string;
		content?: unknown[];
	};
	if (lastMsg.role !== "assistant" || !Array.isArray(lastMsg.content)) return;

	// Collect all tool_use IDs from the last assistant message
	const toolUseIds: string[] = [];
	for (const block of lastMsg.content) {
		if (
			block &&
			typeof block === "object" &&
			(block as Record<string, unknown>).type === "tool_use"
		) {
			toolUseIds.push((block as Record<string, unknown>).id as string);
		}
	}

	if (toolUseIds.length === 0) return;

	// All tool_use blocks at the end are orphaned (no following user message with tool_results)
	const syntheticResults: unknown[] = toolUseIds.map((id) => ({
		type: "tool_result",
		tool_use_id: id,
		content:
			"Tool execution was interrupted by daemon restart. Results were lost.",
		is_error: true,
	}));

	messages.push({ role: "user", content: syntheticResults });
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

	// Build index of events by ID for messages_consumed resolution
	const oaiEventIndex = new Map<string, Event>();
	for (const e of events) {
		const eid = (e as { id?: string }).id;
		if (eid) {
			oaiEventIndex.set(eid, e);
		}
	}

	while (i < events.length) {
		const event = events[i] as Event;

		switch (event.type) {
			case "user_message":
				// user_message with id = injected message (written at enqueue time).
				// Skip here — it will be materialized at the messages_consumed point.
				if (event.id) {
					i++;
					break;
				}
				messages.push({ role: "user", content: event.content });
				i++;
				break;

			case "messages_consumed": {
				// Resolve referenced events and inject with appropriate wrapper
				const consumedEvents: Event[] = [];
				for (const id of event.messageIds) {
					const msg = oaiEventIndex.get(id);
					if (msg) consumedEvents.push(msg);
				}
				if (consumedEvents.length > 0) {
					// Check context: is the last message a tool result?
					const lastMsg = messages[messages.length - 1] as
						| { role: string; content: string }
						| undefined;
					const isWorkingContext = lastMsg?.role === "tool";

					const wrapper = isWorkingContext
						? "[Messages received while you were working:]"
						: "[Messages received while you were idle:]";

					const contents: string[] = [];
					const imageParts: unknown[] = [];
					for (const msg of consumedEvents) {
						contents.push(formatEventForAI(msg));
						if (msg.type === "user_message" && msg.images) {
							for (const img of msg.images) {
								imageParts.push(
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
					}

					const text = `${wrapper}\n${contents.join("\n")}`;
					if (
						isWorkingContext &&
						lastMsg &&
						typeof lastMsg.content === "string"
					) {
						// Append to last tool result content
						lastMsg.content += `\n\n---\n${text}`;
					} else if (imageParts.length > 0) {
						messages.push({
							role: "user",
							content: [{ type: "text", text }, ...imageParts],
						});
					} else {
						messages.push({ role: "user", content: text });
					}
				}
				i++;
				break;
			}

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
						// Handle messagesConsumed on tool_result (cancellation point)
						if (current.messagesConsumed?.length) {
							const mcEvents: Event[] = [];
							for (const mcId of current.messagesConsumed) {
								const mcEvt = oaiEventIndex.get(mcId);
								if (mcEvt) mcEvents.push(mcEvt);
							}
							if (mcEvents.length > 0) {
								const mcContents = mcEvents.map(formatEventForAI);
								const mcText = `[Messages received while you were working:]\n${mcContents.join("\n")}`;
								const lastToolMsg = messages[messages.length - 1] as
									| { role: string; content: string }
									| undefined;
								if (
									lastToolMsg?.role === "tool" &&
									typeof lastToolMsg.content === "string"
								) {
									lastToolMsg.content += `\n\n---\n${mcText}`;
								}
								for (const mcEvt of mcEvents) {
									if (mcEvt.type === "user_message" && mcEvt.images) {
										for (const img of mcEvt.images) {
											queueImageResults.push({
												text: "[User-attached image]",
												dataUri: `data:${img.mediaType};base64,${img.base64}`,
											});
										}
									}
								}
							}
						}
						i++;
					} else if (current.type === "messages_consumed") {
						// Standalone messages_consumed between tool_results
						const mcEvents: Event[] = [];
						for (const mcId of (
							current as Event & { type: "messages_consumed" }
						).messageIds) {
							const mcEvt = oaiEventIndex.get(mcId);
							if (mcEvt) mcEvents.push(mcEvt);
						}
						if (mcEvents.length > 0) {
							const mcContents = mcEvents.map(formatEventForAI);
							const mcText = `[Messages received while you were working:]\n${mcContents.join("\n")}`;
							const lastToolMsg = messages[messages.length - 1] as
								| { role: string; content: string }
								| undefined;
							if (
								lastToolMsg?.role === "tool" &&
								typeof lastToolMsg.content === "string"
							) {
								lastToolMsg.content += `\n\n---\n${mcText}`;
							}
							for (const mcEvt of mcEvents) {
								if (mcEvt.type === "user_message" && mcEvt.images) {
									for (const img of mcEvt.images) {
										queueImageResults.push({
											text: "[User-attached image]",
											dataUri: `data:${img.mediaType};base64,${img.base64}`,
										});
									}
								}
							}
						}
						i++;
					} else if (isQueueEvent(current) || current.type === "user_message") {
						// Legacy: queue events without IDs at cancellation points
						const eid = (current as { id?: string }).id;
						if (eid) {
							i++;
						} else {
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
						}
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
				// Events with IDs are consumed via messages_consumed — skip them here
				const eid = (event as { id?: string }).id;
				if (eid) {
					i++;
					break;
				}
				// Legacy: collect consecutive queue events without IDs
				const oaiQueueContents: string[] = [];
				const oaiQueueImageParts: unknown[] = [];

				while (i < events.length) {
					const current = events[i] as Event;
					if (isQueueEvent(current) || current.type === "user_message") {
						const cid = (current as { id?: string }).id;
						if (cid) {
							i++;
							continue;
						}
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

				if (oaiQueueContents.length === 0) break;

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

			default:
				// Skip lifecycle/broadcast events (orchestration_started, agent_stopped, etc.)
				// that are persisted to JSONL but have no message representation.
				i++;
				break;
		}
	}

	// Fix orphaned tool_calls: if the last assistant message has tool_calls
	// without matching tool role messages, synthesize them.
	// This happens when the daemon stops mid-tool execution.
	fixOrphanedOpenAIToolCalls(messages);

	return messages;
}

/**
 * Detect and fix orphaned tool_calls in OpenAI message arrays.
 * If the last assistant message has tool_calls, check for matching
 * tool role messages following it. Synthesize missing ones.
 */
function fixOrphanedOpenAIToolCalls(messages: unknown[]): void {
	if (messages.length === 0) return;

	const lastMsg = messages[messages.length - 1] as {
		role?: string;
		tool_calls?: Array<{
			id: string;
			type: string;
			function: { name: string; arguments: string };
		}>;
	};
	if (lastMsg.role !== "assistant" || !lastMsg.tool_calls?.length) return;

	// All tool_calls at the end are orphaned (no following tool role messages)
	for (const tc of lastMsg.tool_calls) {
		messages.push({
			role: "tool",
			tool_call_id: tc.id,
			name: tc.function.name,
			content:
				"Tool execution was interrupted by daemon restart. Results were lost.",
		});
	}
}
