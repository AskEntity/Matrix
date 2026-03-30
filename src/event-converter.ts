/**
 * Shared event-to-message converter walker.
 * Converts JSONL events into provider message arrays using provider-specific callbacks.
 * Both Anthropic and OpenAI providers implement EventConverterCallbacks to handle
 * their respective message formats.
 */
import { type Event, formatEventForAI, isQueueEvent } from "./events.ts";
import type { EventImageData, PendingState } from "./shared-types.ts";
import {
	TOOL_REPORT_TO_PARENT,
	TOOL_SEND_MESSAGE,
	TOOL_SEND_MESSAGE_TO_CHILD,
} from "./tool-names.ts";

export type { EventImageData } from "./shared-types.ts";

// ── Types ──

/** A single tool call in an assistant turn. */
export interface AssistantToolCall {
	id: string;
	name: string;
	input: Record<string, unknown>;
}

/** Collected assistant content: ordered text blocks and tool calls. */
export interface AssistantContent {
	items: Array<
		| { type: "text"; text: string }
		| { type: "tool_call"; call: AssistantToolCall }
	>;
}

/** A single tool result extracted from events. */
export interface ToolResultData {
	toolCallId: string;
	content: string;
	isError: boolean;
	images?: EventImageData[];
	pending?: PendingState;
}

/** Consumed messages resolved from a messages_consumed event. */
export interface ConsumedMessages {
	formattedTexts: string[];
	images: EventImageData[];
}

/**
 * Callbacks that each provider implements to handle provider-specific message formatting.
 * The shared walker calls these at the right points during event traversal.
 */
export interface EventConverterCallbacks {
	/** Build a user message from plain content (message/user_message without id, compacted_resume, etc.). */
	onUserMessage(content: string): unknown;

	/** Build an assistant message from collected text + tool_call blocks. */
	onAssistantContent(content: AssistantContent): unknown;

	/**
	 * Build message(s) for a batch of tool results.
	 * Called with consecutive tool_results, any interleaved messages_consumed data,
	 * and accumulated queue images.
	 */
	onToolResults(
		results: ToolResultData[],
		interleaved: Array<{ type: "text"; text: string }>,
		queueImages: EventImageData[],
	): unknown[];

	/**
	 * Handle consumed messages (from messages_consumed event).
	 * Called in non-tool-result context (idle or standalone).
	 * `messages` is the current message array — the callback may append to the last message
	 * or push new messages.
	 */
	onConsumedMessages(messages: unknown[], consumed: ConsumedMessages): void;

	/**
	 * Determine if the current message context is "working" (last message has tool results).
	 * Used to decide whether to append to existing user message or create a new one.
	 */
	isWorkingContext(messages: unknown[]): boolean;
}

// ── Tool name backward compat ──

/**
 * Map old tool names from JSONL to their current equivalents.
 * Old JSONL files may have tool_call events with names that have since been
 * renamed (e.g., send_message_to_child → send_message). The provider sends
 * these to the API which checks that tool names in conversation history match
 * current tool definitions. This mapping prevents API errors on resume.
 */
const TOOL_NAME_ALIASES: Record<string, string> = {
	[TOOL_SEND_MESSAGE_TO_CHILD]: TOOL_SEND_MESSAGE,
	[TOOL_REPORT_TO_PARENT]: TOOL_SEND_MESSAGE,
};

/** Resolve a tool name, mapping old aliases to current names. */
function resolveToolName(name: string): string {
	return TOOL_NAME_ALIASES[name] ?? name;
}

// ── Internal helpers ──

/**
 * Build an index of events by ID for messages_consumed resolution.
 */
function buildEventIndex(events: Event[]): Map<string, Event> {
	const index = new Map<string, Event>();
	for (const e of events) {
		const eid = (e as { id?: string }).id;
		if (eid) {
			index.set(eid, e);
		}
	}
	return index;
}

/**
 * Extract images from a consumed event (message with images in body).
 */
function extractConsumedEventImages(event: Event): EventImageData[] {
	if (event.type !== "message") return [];
	if (event.body.source !== "user") return [];
	const imgs = event.body.images ?? [];
	return imgs.map((img) => ({
		base64: img.base64,
		mediaType: img.mediaType,
	}));
}

/**
 * Resolve consumed events from a messages_consumed event using the event index.
 * Returns formatted text contents and extracted images.
 */
function resolveConsumedMessages(
	messageIds: string[],
	eventIndex: Map<string, Event>,
): ConsumedMessages | null {
	const consumedEvents: Event[] = [];
	for (const id of messageIds) {
		const msg = eventIndex.get(id);
		if (msg) consumedEvents.push(msg);
	}
	if (consumedEvents.length === 0) return null;

	const formattedTexts: string[] = [];
	const images: EventImageData[] = [];
	for (const msg of consumedEvents) {
		formattedTexts.push(formatEventForAI(msg));
		images.push(...extractConsumedEventImages(msg));
	}

	return { formattedTexts, images };
}

// ── Main walker ──

/**
 * Generic event walker that converts JSONL events to provider messages.
 * Handles all shared control flow: event index, two-phase skip/materialize,
 * queue event skipping, compaction skip, and the main while-loop structure.
 *
 * Provider-specific formatting is delegated to callbacks.
 */
export function walkEventsToMessages(
	events: Event[],
	callbacks: EventConverterCallbacks,
): unknown[] {
	const messages: unknown[] = [];
	const eventIndex = buildEventIndex(events);
	let i = 0;

	while (i < events.length) {
		const event = events[i] as Event;

		switch (event.type) {
			case "message": {
				// Messages with non-empty IDs are deferred — materialized at messages_consumed
				if (event.id) {
					i++;
					break;
				}
				// Messages without meaningful IDs — render directly as user message
				const msgContent = formatEventForAI(event) || "(empty)";
				messages.push(callbacks.onUserMessage(msgContent));
				i++;
				break;
			}

			case "messages_consumed": {
				const consumed = resolveConsumedMessages(event.messageIds, eventIndex);
				if (consumed) {
					callbacks.onConsumedMessages(messages, consumed);
				}
				i++;
				break;
			}

			case "compacted_resume":
				messages.push(callbacks.onUserMessage(event.content));
				i++;
				break;

			case "summarization_request":
				messages.push(callbacks.onUserMessage(event.instruction));
				i++;
				break;

			case "budget_warning":
				messages.push(callbacks.onUserMessage(event.warning));
				i++;
				break;

			case "assistant_text":
			case "tool_call": {
				const content: AssistantContent = {
					items: [],
				};

				// Collect ALL consecutive assistant_text and tool_call events.
				// They may be interleaved (text→tool→text→tool) but belong to the same turn.
				while (i < events.length) {
					const cur = events[i] as Event;
					if (cur.type === "assistant_text") {
						content.items.push({ type: "text", text: cur.content });
						i++;
					} else if (cur.type === "tool_call") {
						const call: AssistantToolCall = {
							id: cur.toolCallId,
							name: resolveToolName(cur.tool),
							input: cur.input,
						};
						content.items.push({ type: "tool_call", call });
						i++;
					} else {
						break;
					}
				}

				messages.push(callbacks.onAssistantContent(content));
				break;
			}

			case "tool_result": {
				const results: ToolResultData[] = [];
				const interleavedText: Array<{ type: "text"; text: string }> = [];
				const queueImages: EventImageData[] = [];

				while (i < events.length) {
					const current = events[i] as Event;
					if (current.type === "tool_result") {
						results.push({
							toolCallId: current.toolCallId,
							content: current.content,
							isError: current.isError,
							images: current.images?.map((img) => ({
								base64: img.base64,
								mediaType: img.mediaType,
							})),
							pending: current.pending,
						});
						i++;
					} else if (current.type === "messages_consumed") {
						// messages_consumed between tool_results — each message as its own text block
						const consumed = resolveConsumedMessages(
							current.messageIds,
							eventIndex,
						);
						if (consumed) {
							for (const text of consumed.formattedTexts) {
								interleavedText.push({ type: "text", text });
							}
							queueImages.push(...consumed.images);
						}
						i++;
					} else if (current.type === "fork_marker") {
						// fork_marker between tool_results — inline identity text
						const forkEvt = current as Extract<Event, { type: "fork_marker" }>;
						const targetAttr = forkEvt.targetTitle
							? ` task="${forkEvt.targetTitle}"`
							: "";
						const descBlock = forkEvt.targetDescription
							? `\nTask description: ${forkEvt.targetDescription}`
							: "";
						interleavedText.push({
							type: "text",
							text:
								`<fork_marker source="${forkEvt.sourceTaskId}"${targetAttr}>\n` +
								`YOU ARE NOT THE AGENT ABOVE. The conversation above is inherited context ` +
								`from a different agent. You are a new agent.${descBlock}\n` +
								`</fork_marker>`,
						});
						i++;
					} else if (isQueueEvent(current) || current.type === "message") {
						// Queue events with IDs — skip, materialized by messages_consumed
						i++;
					} else {
						break;
					}
				}

				const toolMsgs = callbacks.onToolResults(
					results,
					interleavedText,
					queueImages,
				);
				for (const msg of toolMsgs) {
					messages.push(msg);
				}
				break;
			}

			case "compact_marker":
			case "session_config":
				// Structural events — skip, not part of conversation messages
				i++;
				break;

			default:
				// Skip lifecycle/broadcast events
				i++;
				break;
		}
	}

	return messages;
}
