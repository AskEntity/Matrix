import { randomUUID } from "node:crypto";
import type { QueueMessage } from "./message-queue.ts";

/**
 * Strongly-typed event — provider-agnostic, one event per action.
 * Each event represents a single atomic action (no batching).
 *
 * All injected content uses `type: "message"` with a `body` field.
 * `body.source` discriminates: "user", "system", "child_complete", etc.
 */
/**
 * MessageBody — structured body of a message event.
 * The `source` field discriminates the shape. Format for AI happens at conversion time.
 */
export interface MessageBody {
	source: string;
	content?: string;
	taskId?: string;
	title?: string;
	summary?: string;
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
	images?: Array<{ base64: string; mediaType: string }>;
}

/**
 * MessageEvent — unified format for ALL messages that flow through the queue.
 * Uses `body.source` to indicate the message type. Written to JSONL with `id` for tracking.
 *
 * Base form (no body): initial prompt, resume messages — written by provider.
 * Body-typed form: queue-originated messages — written at enqueue time.
 */
export interface MessageEvent {
	type: "message";
	id?: string;
	/** Message source. Absent for initial prompt/resume. Present for queue messages. */
	source?: string;
	content?: string;
	cwd?: string;
	isResume?: boolean;
	images?: Array<{ base64: string; mediaType: string }>;
	/** Task/session ID — used for JSONL routing and SSE broadcast targeting. */
	taskId?: string;
	/**
	 * Structured message body — present when this message represents a queue message.
	 * Contains the full structured data (source, taskId, title, etc.).
	 * Format for AI happens at conversion time via formatEventForAI().
	 */
	body?: MessageBody;
	ts: number;
}

/** @deprecated Use MessageEvent instead */
export type UserMessageEvent = MessageEvent;
/** @deprecated Use MessageBody instead */
export type QueueEntry = MessageBody;

export type Event =
	| MessageEvent
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
			/** Structured pending state (running children + clarifications). */
			pending?: {
				runningChildren: Array<{ id: string; title: string }>;
				pendingClarifications: number;
			};

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
	// Legacy queue-originated event types — kept for backward compat with old JSONL.
	// New code produces `message` events with `body.source` instead.
	// normalizeLegacyEvent() converts these to `message` on read.
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
			summary?: string;
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
	// Legacy user_message — old JSONL may have this type. Normalized to "message" on read.
	| {
			type: "user_message";
			id?: string;
			source?: string;
			content?: string;
			cwd?: string;
			isResume?: boolean;
			images?: Array<{ base64: string; mediaType: string }>;
			queueEntry?: MessageBody;
			body?: MessageBody;
			ts: number;
	  }
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
			/** Short title extracted from question (first line). */
			title?: string;
			/** Detailed body (remaining lines after title). */
			body?: string;
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
			taskId?: string;
			ts: number;
	  };

/** Legacy event types that originate from the message queue (for backward compat). */
const LEGACY_QUEUE_EVENT_TYPES = new Set([
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
 * A `message` event is a queue event if `body.source` is present and not "user".
 * Legacy standalone types (child_complete, parent_update, etc.) are also detected.
 * Legacy `user_message` events with source/queueEntry are also detected.
 */
export function isQueueEvent(event: Event): boolean {
	if (LEGACY_QUEUE_EVENT_TYPES.has(event.type)) return true;
	if (event.type === "message") {
		const src =
			(event as { source?: string }).source ??
			(event as MessageEvent).body?.source;
		return src !== undefined && src !== "user";
	}
	// Legacy: user_message with source or queueEntry field
	if (event.type === "user_message") {
		const src =
			(event as { source?: string }).source ??
			(event as { queueEntry?: { source?: string } }).queueEntry?.source ??
			(event as { body?: { source?: string } }).body?.source;
		return src !== undefined && src !== "user";
	}
	return false;
}

/** Convert a QueueMessage to a unified `message` Event with body. */
export function queueMessageToEvent(msg: QueueMessage): MessageEvent {
	const ts = Date.now();
	const base = { type: "message" as const, id: randomUUID(), ts };
	switch (msg.source) {
		case "user":
			return {
				...base,
				id: msg.id ?? base.id,
				source: "user",
				content: msg.content,
				body: {
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
				},
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
				body: {
					source: "child_complete",
					taskId: msg.taskId,
					title: msg.title,
					success: msg.success,
					output: msg.output,
				},
			};
		case "parent_update":
			return {
				...base,
				source: "parent_update",
				body: {
					source: "parent_update",
					content: msg.content,
					...(msg.requestReply ? { requestReply: true } : {}),
				},
			};
		case "clarify_response":
			return {
				...base,
				source: "clarify_response",
				body: {
					source: "clarify_response",
					answer: msg.answer,
				},
			};
		case "child_report":
			return {
				...base,
				source: "child_report",
				body: {
					source: "child_report",
					taskId: msg.taskId,
					title: msg.title,
					...(msg.summary ? { summary: msg.summary } : {}),
					content: msg.content,
					...(msg.requestReply ? { requestReply: true } : {}),
				},
			};
		case "cross_project":
			return {
				...base,
				source: "cross_project",
				body: {
					source: "cross_project",
					fromProjectId: msg.fromProjectId,
					fromProjectName: msg.fromProjectName,
					content: msg.content,
				},
			};
		case "background_complete":
			return {
				...base,
				source: "background_complete",
				body: {
					source: "background_complete",
					command: msg.command,
					commandId: msg.commandId,
					exitCode: msg.exitCode,
					durationMs: msg.durationMs,
				},
			};
		case "system":
			return {
				...base,
				source: "system",
				body: {
					source: "system",
					content: msg.content,
				},
			};
		case "compact":
			return {
				...base,
				source: "compact",
				body: { source: "compact" },
			};
	}
}

/**
 * Format a MessageBody for AI consumption based on source.
 * Used by formatEventForAI for message events.
 */
function formatBodyForAI(body: MessageBody): string {
	switch (body.source) {
		case "child_complete":
			return `<child_complete task="${body.title}" id="${body.taskId}" status="${body.success ? "passed" : "failed"}">${(body.output ?? "").slice(0, 500)}</child_complete>`;
		case "parent_update":
			return `<parent_update${body.requestReply ? ' requestReply="true"' : ""}>${body.content}</parent_update>`;
		case "clarify_response":
			return `<clarify_response>${body.answer}</clarify_response>`;
		case "child_report":
			return `<child_report from="${body.title}" id="${body.taskId}"${body.summary ? ` summary="${body.summary}"` : ""}${body.requestReply ? ' requestReply="true"' : ""}>${body.content}</child_report>`;
		case "cross_project":
			return `<cross_project from="${body.fromProjectName}" projectId="${body.fromProjectId}">${body.content}</cross_project>`;
		case "background_complete":
			return `<background_complete command="${body.command}" id="${body.commandId}" exit="${body.exitCode}" duration="${body.durationMs}ms">Command completed. Use bg_action="status" with background_id="${body.commandId}" or read_file on output files to see results.</background_complete>`;
		case "system":
			return `<system_notification>${body.content}</system_notification>`;
		case "compact":
			return "Manual compaction requested";
		case "user":
			return body.content ?? "";
		default:
			return "";
	}
}

/**
 * Format a concrete Event for inclusion in provider messages.
 * `message` events use body.source to determine formatting.
 * Legacy standalone types (child_complete, etc.) are also supported for backward compat.
 */
export function formatEventForAI(event: Event): string {
	switch (event.type) {
		case "message": {
			const src = (event as { source?: string }).source;
			if (!src || src === "user") {
				return (event as { content: string }).content;
			}
			const body = (event as MessageEvent).body;
			if (!body) return "";
			return formatBodyForAI(body);
		}
		// Legacy: user_message (old JSONL)
		case "user_message": {
			const src = (event as { source?: string }).source;
			if (!src || src === "user") {
				return (event as { content: string }).content;
			}
			const body =
				(event as { body?: MessageBody }).body ??
				(event as { queueEntry?: MessageBody }).queueEntry;
			if (!body) return "";
			return formatBodyForAI(body);
		}
		// Legacy standalone queue event types (old JSONL)
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
			return `<child_report from="${event.title}" id="${event.taskId}"${event.summary ? ` summary="${event.summary}"` : ""}${event.requestReply ? ' requestReply="true"' : ""}>${event.content}</child_report>`;
		case "cross_project":
			return `<cross_project from="${event.fromProjectName}" projectId="${event.fromProjectId}">${event.content}</cross_project>`;
		case "background_complete":
			return `<background_complete command="${event.command}" id="${event.commandId}" exit="${event.exitCode}" duration="${event.durationMs}ms">Command completed. Use bg_action="status" with background_id="${event.commandId}" or read_file on output files to see results.</background_complete>`;
		default:
			return "";
	}
}

/**
 * Format a structured pending section into text for AI consumption.
 * Converts the structured `pending` field on tool_result into the `## Pending` text format.
 */
export function formatPendingSection(pending: {
	runningChildren: Array<{ id: string; title: string }>;
	pendingClarifications: number;
}): string {
	const runningChildrenText =
		pending.runningChildren.length > 0
			? pending.runningChildren.map((c) => `"${c.title}" (${c.id})`).join(", ")
			: "none";
	const clarifyText =
		pending.pendingClarifications > 0
			? String(pending.pendingClarifications)
			: "none";
	return [
		"",
		"## Pending",
		`- Running children: ${runningChildrenText}`,
		`- Pending clarifications: ${clarifyText}`,
	].join("\n");
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

/**
 * Scan events for orphaned tool_call events (no matching tool_result).
 * Returns synthetic tool_result events that should be persisted to JSONL.
 * Call this BEFORE eventsToAnthropicMessages/eventsToOpenAIMessages on resume
 * to fix orphans once and persist the fix.
 */
export function findOrphanedToolCalls(events: Event[]): Event[] {
	// Build sets of tool_call IDs and tool_result IDs
	const toolCallIds = new Map<string, string>(); // id → tool name
	const toolResultIds = new Set<string>();
	for (const e of events) {
		if (e.type === "tool_call") {
			toolCallIds.set(e.toolCallId, e.tool);
		} else if (e.type === "tool_result") {
			toolResultIds.add(e.toolCallId);
		}
	}
	// Find tool_calls without matching tool_results
	const orphans: Event[] = [];
	for (const [id, tool] of toolCallIds) {
		if (!toolResultIds.has(id)) {
			console.warn(
				`[findOrphanedToolCalls] Orphaned tool_call: ${id} (${tool})`,
			);
			orphans.push({
				type: "tool_result" as const,
				toolCallId: id,
				content:
					"Tool execution was interrupted by daemon restart. Results were lost.",
				isError: true,
				ts: Date.now(),
			});
		}
	}
	return orphans;
}

export function eventsToAnthropicMessages(rawEvents: Event[]): unknown[] {
	const events = rawEvents;
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
			case "message":
			case "user_message":
				// message/user_message with id = injected message (written at enqueue time).
				// Skip here — it will be materialized at the messages_consumed point.
				if ((event as { id?: string }).id) {
					i++;
					break;
				}
				{
					// Defensive: ensure content is never undefined (causes Anthropic 400)
					let msgContent = (event as { content?: string }).content;
					if (!msgContent) {
						// Try to generate content from body/queueEntry for queue messages
						msgContent = formatEventForAI(event);
						if (!msgContent) {
							console.warn(
								"[event-converter] Empty content fallback triggered for event:",
								event.type,
								event,
							);
							msgContent = "(empty)";
						}
					}
					messages.push({ role: "user", content: msgContent });
				}
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
						if (msg.type === "message" || msg.type === "user_message") {
							const imgs =
								(msg as MessageEvent).images ??
								(msg as MessageEvent).body?.images ??
								(msg as { queueEntry?: MessageBody }).queueEntry?.images ??
								[];
							for (const img of imgs) {
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

				// Defensive: ensure content array is never empty (causes Anthropic 400)
				if (contentBlocks.length === 0) {
					console.warn(
						"[event-converter] Empty assistant content blocks at index",
						i,
						"- nearby events:",
						events.slice(Math.max(0, i - 2), i + 1).map((e) => e.type),
					);
					contentBlocks.push({ type: "text", text: "(empty)" });
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
							contentParts.push({
								type: "text",
								text: current.content ?? "(empty)",
							});
							resultBlocks.push({
								type: "tool_result",
								tool_use_id: current.toolCallId,
								content: contentParts,
							});
						} else {
							resultBlocks.push({
								type: "tool_result",
								tool_use_id: current.toolCallId,
								// Defensive: ensure content is never undefined
								content: current.content ?? "(empty)",
								is_error: current.isError,
							});
						}

						// Handle structured pending section
						if (current.pending) {
							const pendingText = formatPendingSection(current.pending);
							resultBlocks.push({
								type: "text",
								text: pendingText,
							});
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
								if (
									(mcEvt.type === "message" || mcEvt.type === "user_message") &&
									((mcEvt as MessageEvent).images ||
										(mcEvt as MessageEvent).body?.images ||
										(mcEvt as { queueEntry?: MessageBody }).queueEntry?.images)
								) {
									const imgs =
										(mcEvt as MessageEvent).images ??
										(mcEvt as MessageEvent).body?.images ??
										(mcEvt as { queueEntry?: MessageBody }).queueEntry
											?.images ??
										[];
									for (const img of imgs) {
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
					} else if (
						isQueueEvent(current) ||
						current.type === "message" ||
						current.type === "user_message"
					) {
						// Queue events with IDs — skip, will be materialized by messages_consumed
						i++;
					} else {
						break;
					}
				}

				// Defensive: ensure content array is never empty (causes Anthropic 400)
				if (resultBlocks.length === 0) {
					console.warn(
						"[event-converter] Empty tool_result blocks at index",
						i,
						"- nearby events:",
						events.slice(Math.max(0, i - 3), i + 1).map((e) => e.type),
					);
					resultBlocks.push({ type: "text", text: "(empty)" });
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
			case "compact_request":
				// Queue events with IDs — skip, materialized by messages_consumed
				i++;
				break;

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
 * Scans ALL assistant messages (not just the last one) for tool_use blocks
 * without matching tool_result blocks in the following user message.
 * This handles cases where daemon restarts mid-tool, the orphan gets fixed,
 * then more events append, and another restart leaves the first orphan
 * in the middle of the conversation.
 */
function fixOrphanedAnthropicToolUse(messages: unknown[]): void {
	// Scan in reverse so insertions don't shift indices of unprocessed messages
	for (let mi = messages.length - 1; mi >= 0; mi--) {
		const msg = messages[mi] as { role?: string; content?: unknown[] };
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

		// Collect tool_use IDs from this assistant message
		const toolUseIds: string[] = [];
		for (const block of msg.content) {
			if (
				block &&
				typeof block === "object" &&
				(block as Record<string, unknown>).type === "tool_use"
			) {
				toolUseIds.push((block as Record<string, unknown>).id as string);
			}
		}
		if (toolUseIds.length === 0) continue;

		// Check the next message for matching tool_results
		const nextMsg = messages[mi + 1] as
			| {
					role?: string;
					content?: unknown[];
			  }
			| undefined;
		const existingResultIds = new Set<string>();
		if (nextMsg?.role === "user" && Array.isArray(nextMsg.content)) {
			for (const block of nextMsg.content) {
				if (
					block &&
					typeof block === "object" &&
					(block as Record<string, unknown>).type === "tool_result"
				) {
					existingResultIds.add(
						(block as Record<string, unknown>).tool_use_id as string,
					);
				}
			}
		}

		// Find orphaned tool_use IDs (no matching tool_result)
		const orphanedIds = toolUseIds.filter((id) => !existingResultIds.has(id));
		if (orphanedIds.length === 0) continue;

		console.warn(
			"[event-converter] Orphaned tool_use blocks found at message index",
			mi,
			"- ids:",
			orphanedIds,
		);

		const syntheticResults: unknown[] = orphanedIds.map((id) => ({
			type: "tool_result",
			tool_use_id: id,
			content:
				"Tool execution was interrupted by daemon restart. Results were lost.",
			is_error: true,
		}));

		if (nextMsg?.role === "user" && Array.isArray(nextMsg.content)) {
			// Append synthetic results to existing user message
			(nextMsg.content as unknown[]).push(...syntheticResults);
		} else {
			// Insert a new user message right after this assistant message
			messages.splice(mi + 1, 0, {
				role: "user",
				content: syntheticResults,
			});
		}
	}
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
	const events = rawEvents;
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
			case "message":
			case "user_message":
				// message/user_message with id = injected message (written at enqueue time).
				// Skip here — it will be materialized at the messages_consumed point.
				if ((event as { id?: string }).id) {
					i++;
					break;
				}
				{
					// Defensive: ensure content is never undefined (causes API errors)
					let msgContent = (event as { content?: string }).content;
					if (!msgContent) {
						msgContent = formatEventForAI(event);
						if (!msgContent) {
							console.warn(
								"[event-converter] Empty content fallback triggered for event:",
								event.type,
								event,
							);
							msgContent = "(empty)";
						}
					}
					messages.push({ role: "user", content: msgContent });
				}
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
						if (
							(msg.type === "message" || msg.type === "user_message") &&
							(msg as MessageEvent).images
						) {
							for (const img of (msg as MessageEvent).images ?? []) {
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

				// Defensive: ensure assistant message has content or tool_calls
				if (textContent === null && toolCalls.length === 0) {
					console.warn(
						"[event-converter] Empty assistant content at index",
						i,
						"- nearby events:",
						events.slice(Math.max(0, i - 2), i + 1).map((e) => e.type),
					);
					textContent = "(empty)";
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
							// Defensive: ensure content is never undefined
							content: current.content ?? "(empty)",
						});
						if (current.images) {
							for (const img of current.images) {
								toolImageResults.push({
									text: current.content,
									dataUri: `data:${img.mediaType};base64,${img.base64}`,
								});
							}
						}

						// Handle structured pending section
						if (current.pending) {
							const pendingText = formatPendingSection(current.pending);
							const lastToolMsg = messages[messages.length - 1] as
								| { role: string; content: string }
								| undefined;
							if (
								lastToolMsg?.role === "tool" &&
								typeof lastToolMsg.content === "string"
							) {
								lastToolMsg.content += pendingText;
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
								if (
									(mcEvt.type === "message" || mcEvt.type === "user_message") &&
									((mcEvt as MessageEvent).images ||
										(mcEvt as MessageEvent).body?.images ||
										(mcEvt as { queueEntry?: MessageBody }).queueEntry?.images)
								) {
									const imgs =
										(mcEvt as MessageEvent).images ??
										(mcEvt as MessageEvent).body?.images ??
										(mcEvt as { queueEntry?: MessageBody }).queueEntry
											?.images ??
										[];
									for (const img of imgs) {
										queueImageResults.push({
											text: "[User-attached image]",
											dataUri: `data:${img.mediaType};base64,${img.base64}`,
										});
									}
								}
							}
						}
						i++;
					} else if (
						isQueueEvent(current) ||
						current.type === "message" ||
						current.type === "user_message"
					) {
						// Queue events with IDs — skip, materialized by messages_consumed
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
			case "compact_request":
				// Queue events with IDs — skip, materialized by messages_consumed
				i++;
				break;

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
 * Scans ALL assistant messages (not just the last one) for tool_calls
 * without matching tool role messages following them.
 */
function fixOrphanedOpenAIToolCalls(messages: unknown[]): void {
	// Scan in reverse so insertions don't shift indices of unprocessed messages
	for (let mi = messages.length - 1; mi >= 0; mi--) {
		const msg = messages[mi] as {
			role?: string;
			tool_calls?: Array<{
				id: string;
				type: string;
				function: { name: string; arguments: string };
			}>;
		};
		if (msg.role !== "assistant" || !msg.tool_calls?.length) continue;

		// Collect existing tool result IDs from messages following this assistant message
		const existingResultIds = new Set<string>();
		for (let j = mi + 1; j < messages.length; j++) {
			const followingMsg = messages[j] as {
				role?: string;
				tool_call_id?: string;
			};
			if (followingMsg.role === "tool" && followingMsg.tool_call_id) {
				existingResultIds.add(followingMsg.tool_call_id);
			} else if (followingMsg.role !== "tool" && followingMsg.role !== "user") {
				// Stop at next assistant message — tool results must come before
				break;
			}
		}

		// Find orphaned tool_calls (no matching tool result)
		const orphanedCalls = msg.tool_calls.filter(
			(tc) => !existingResultIds.has(tc.id),
		);
		if (orphanedCalls.length === 0) continue;

		console.warn(
			"[event-converter] Orphaned tool_calls found at message index",
			mi,
			"- ids:",
			orphanedCalls.map((tc) => tc.id),
		);

		// Find insertion point: after all existing tool results for this assistant message
		let insertAt = mi + 1;
		while (
			insertAt < messages.length &&
			(messages[insertAt] as { role?: string }).role === "tool"
		) {
			insertAt++;
		}
		// Also skip user messages that might be image wrappers between tool results
		// (OpenAI tool results are individual messages, images follow as user messages)

		const syntheticResults = orphanedCalls.map((tc) => ({
			role: "tool",
			tool_call_id: tc.id,
			name: tc.function.name,
			content:
				"Tool execution was interrupted by daemon restart. Results were lost.",
		}));

		messages.splice(insertAt, 0, ...syntheticResults);
	}
}
