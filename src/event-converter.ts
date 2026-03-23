/**
 * Shared event-to-message converter walker.
 * Converts JSONL events into provider message arrays using provider-specific callbacks.
 * Both Anthropic and OpenAI providers implement EventConverterCallbacks to handle
 * their respective message formats.
 */
import { type Event, formatEventForAI, isQueueEvent } from "./events.ts";

// ── Types ──

/** Image data extracted from events (provider-agnostic). */
export interface EventImageData {
	base64: string;
	mediaType: string;
}

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
	pending?: {
		runningChildren: Array<{ id: string; title: string }>;
		pendingClarifications: number;
	};
}

/** Consumed messages resolved from a messages_consumed event. */
export interface ConsumedMessages {
	formattedTexts: string[];
	images: EventImageData[];
	isWorkingContext: boolean;
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

	/** Fix orphaned tool uses in the final message array. */
	fixOrphans(messages: unknown[]): void;

	/**
	 * Determine if the current message context is "working" (between tool results).
	 * Used to decide "[Messages received while you were working/idle:]" wrapper.
	 */
	isWorkingContext(messages: unknown[]): boolean;
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
	isWorking: boolean,
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

	return { formattedTexts, images, isWorkingContext: isWorking };
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
				const isWorking = callbacks.isWorkingContext(messages);
				const consumed = resolveConsumedMessages(
					event.messageIds,
					eventIndex,
					isWorking,
				);
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
							name: cur.tool,
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
						// messages_consumed between tool_results → working context
						const consumed = resolveConsumedMessages(
							current.messageIds,
							eventIndex,
							true,
						);
						if (consumed) {
							const mcText = `[Messages received while you were working:]\n${consumed.formattedTexts.join("\n")}`;
							interleavedText.push({ type: "text", text: mcText });
							queueImages.push(...consumed.images);
						}
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
				i++;
				break;

			default:
				// Skip lifecycle/broadcast events
				i++;
				break;
		}
	}

	callbacks.fixOrphans(messages);
	return messages;
}
