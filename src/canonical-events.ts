/**
 * Strongly-typed canonical event — provider-agnostic, one event per action.
 * Each event represents a single atomic action (no batching).
 */
export type StrongEvent =
	| {
			type: "user_message";
			content: string;
			cwd?: string;
			isResume?: boolean;
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
			type: "queue_message";
			source: string;
			content: string;
			images?: Array<{ base64: string; mediaType: string }>;
			ts: number;
	  }
	| { type: "compacted_resume"; content: string; cwd?: string; ts: number }
	| { type: "summarization_request"; instruction: string; ts: number }
	| { type: "budget_warning"; warning: string; ts: number }
	| {
			type: "compact_marker";
			checkpoint: string;
			savedTokens: number;
			ts: number;
	  };

/**
 * Canonical events recorded alongside provider messages.
 * Uses `unknown[]` instead of Anthropic-specific types for provider-agnostic portability.
 * @deprecated Use StrongEvent instead — will be removed in Phase 4.
 */
export type CanonicalEvent =
	| { type: "user_message"; content: string; cwd?: string; isResume?: boolean }
	| { type: "compacted_resume"; content: string; cwd?: string }
	| { type: "summarization_request"; instruction: string }
	| {
			type: "assistant_response";
			content: unknown[];
	  }
	| {
			type: "queue_messages";
			formatted: string;
			hasImages?: boolean;
			imageBlocks?: unknown[];
	  }
	| {
			type: "tool_results";
			results: unknown[];
			hasImages?: boolean;
			imageBlocks?: unknown[];
	  }
	| { type: "budget_warning"; warning: string };

/**
 * Reconstruct Anthropic-format messages from canonical events.
 * Pure function — no side effects or external dependencies.
 *
 * The output should be identical to the `messages` array built by
 * AnthropicCompatibleProvider.runLoop, enabling deterministic verification.
 */
export function eventsToAnthropicMessages(events: CanonicalEvent[]): unknown[] {
	const messages: unknown[] = [];
	for (const event of events) {
		switch (event.type) {
			case "user_message":
				messages.push({ role: "user", content: event.content });
				break;
			case "compacted_resume":
				messages.push({ role: "user", content: event.content });
				break;
			case "summarization_request":
				messages.push({ role: "user", content: event.instruction });
				break;
			case "assistant_response":
				messages.push({ role: "assistant", content: event.content });
				break;
			case "queue_messages": {
				const text = `[Messages received while you were idle:]\n${event.formatted}\n\nProcess these messages and continue working. Remember to call done() when finished.`;
				if (event.imageBlocks && event.imageBlocks.length > 0) {
					messages.push({
						role: "user",
						content: [{ type: "text", text }, ...event.imageBlocks],
					});
				} else {
					messages.push({ role: "user", content: text });
				}
				break;
			}
			case "tool_results":
				if (event.imageBlocks && event.imageBlocks.length > 0) {
					messages.push({
						role: "user",
						content: [
							...event.results,
							...event.imageBlocks,
							{
								type: "text",
								text: `[${event.imageBlocks.length} image(s) attached by user]`,
							},
						],
					});
				} else {
					messages.push({ role: "user", content: event.results });
				}
				break;
			case "budget_warning":
				messages.push({ role: "user", content: event.warning });
				break;
		}
	}
	return messages;
}

/**
 * Reconstruct OpenAI-format messages from canonical events.
 * Pure function — no side effects or external dependencies.
 *
 * For OpenAI, assistant_response and tool_results store already-formatted
 * OpenAI message objects in their content/results arrays. We spread them
 * directly into the output.
 */
export function eventsToOpenAIMessages(events: CanonicalEvent[]): unknown[] {
	const messages: unknown[] = [];
	for (const event of events) {
		switch (event.type) {
			case "user_message":
				messages.push({ role: "user", content: event.content });
				break;
			case "compacted_resume":
				messages.push({ role: "user", content: event.content });
				break;
			case "summarization_request":
				messages.push({ role: "user", content: event.instruction });
				break;
			case "assistant_response":
				// OpenAI stores the full assistant message object(s) in content array
				for (const msg of event.content) {
					messages.push(msg);
				}
				break;
			case "queue_messages": {
				const text = `[Messages received while you were idle:]\n${event.formatted}\n\nProcess these messages and continue working. Remember to call done() when finished.`;
				if (event.imageBlocks && event.imageBlocks.length > 0) {
					messages.push({
						role: "user",
						content: [{ type: "text", text }, ...event.imageBlocks],
					});
				} else {
					messages.push({ role: "user", content: text });
				}
				break;
			}
			case "tool_results":
				// OpenAI stores individual tool result messages in results array
				for (const msg of event.results) {
					messages.push(msg);
				}
				break;
			case "budget_warning":
				messages.push({ role: "user", content: event.warning });
				break;
		}
	}
	return messages;
}

/**
 * Reconstruct Anthropic-format messages from strongly-typed canonical events.
 * Pure function — no side effects or external dependencies.
 *
 * Key batching rules:
 * - assistant_text + consecutive tool_calls → single assistant message
 * - consecutive tool_results (with optional queue_messages) → single user message
 * - compact_marker → skipped (readActive handles filtering)
 */
export function strongEventsToAnthropicMessages(
	events: StrongEvent[],
): unknown[] {
	const messages: unknown[] = [];
	let i = 0;

	while (i < events.length) {
		const event = events[i] as StrongEvent;

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
					(events[i] as StrongEvent).type === "assistant_text"
				) {
					const textEvent = events[i] as StrongEvent & {
						type: "assistant_text";
					};
					contentBlocks.push({ type: "text", text: textEvent.content });
					i++;
				}

				// Collect tool_call blocks
				while (
					i < events.length &&
					(events[i] as StrongEvent).type === "tool_call"
				) {
					const tcEvent = events[i] as StrongEvent & { type: "tool_call" };
					contentBlocks.push({
						type: "tool_use",
						id: tcEvent.toolCallId,
						name: tcEvent.tool,
						input: tcEvent.input,
					});
					i++;
				}

				// If only text and no tools, use simple string content
				if (
					contentBlocks.length === 1 &&
					(contentBlocks[0] as { type: string }).type === "text"
				) {
					messages.push({
						role: "assistant",
						content: (contentBlocks[0] as { text: string }).text,
					});
				} else {
					messages.push({ role: "assistant", content: contentBlocks });
				}
				break;
			}

			case "tool_result":
			case "queue_message": {
				// Collect consecutive tool_results and queue_messages into one user message
				const resultBlocks: unknown[] = [];
				const imageBlocks: unknown[] = [];

				while (
					i < events.length &&
					((events[i] as StrongEvent).type === "tool_result" ||
						(events[i] as StrongEvent).type === "queue_message")
				) {
					const current = events[i] as StrongEvent;
					if (current.type === "tool_result") {
						resultBlocks.push({
							type: "tool_result",
							tool_use_id: current.toolCallId,
							content: current.content,
							is_error: current.isError,
						});
						if (current.images) {
							for (const img of current.images) {
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
					} else if (current.type === "queue_message") {
						const queueText = `[Messages received while you were working:]\n<${current.source}>\n${current.content}\n</${current.source}>`;
						resultBlocks.push({ type: "text", text: queueText });
						if (current.images) {
							for (const img of current.images) {
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
					i++;
				}

				if (imageBlocks.length > 0) {
					messages.push({
						role: "user",
						content: [
							...resultBlocks,
							...imageBlocks,
							{
								type: "text",
								text: `[${imageBlocks.length} image(s) attached by user]`,
							},
						],
					});
				} else {
					messages.push({ role: "user", content: resultBlocks });
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
 * Reconstruct OpenAI-format messages from strongly-typed canonical events.
 * Pure function — no side effects or external dependencies.
 *
 * Key differences from Anthropic converter:
 * - assistant_text + tool_calls → single message with `content` and `tool_calls` array
 * - tool_results → individual `{ role: "tool" }` messages (not batched into one user message)
 * - Images from tool_results → separate `{ role: "user" }` message with image_url parts
 * - queue_messages between tool_results → appended to last tool result content
 * - compact_marker → skipped
 */
export function strongEventsToOpenAIMessages(events: StrongEvent[]): unknown[] {
	const messages: unknown[] = [];
	// Map toolCallId → tool name for resolving tool_result.name
	const toolNames = new Map<string, string>();
	let i = 0;

	while (i < events.length) {
		const event = events[i] as StrongEvent;

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
					(events[i] as StrongEvent).type === "assistant_text"
				) {
					const textEvent = events[i] as StrongEvent & {
						type: "assistant_text";
					};
					// Concatenate multiple text blocks (rare but possible)
					textContent =
						textContent === null
							? textEvent.content
							: `${textContent}\n${textEvent.content}`;
					i++;
				}

				// Collect tool_calls
				while (
					i < events.length &&
					(events[i] as StrongEvent).type === "tool_call"
				) {
					const tcEvent = events[i] as StrongEvent & { type: "tool_call" };
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

			case "tool_result":
			case "queue_message": {
				// Process tool_results as individual messages, with queue_messages
				// appended to the preceding tool result and images collected for a user message
				const imageResults: Array<{
					text: string;
					dataUri: string;
				}> = [];

				while (
					i < events.length &&
					((events[i] as StrongEvent).type === "tool_result" ||
						(events[i] as StrongEvent).type === "queue_message")
				) {
					const current = events[i] as StrongEvent;
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
								imageResults.push({
									text: "[User-attached image]",
									dataUri: `data:${img.mediaType};base64,${img.base64}`,
								});
							}
						}
					} else if (current.type === "queue_message") {
						// Queue messages at cancellation points are appended to last tool result
						const lastMsg = messages[messages.length - 1] as
							| { role: string; content: string }
							| undefined;
						if (
							lastMsg?.role === "tool" &&
							typeof lastMsg.content === "string"
						) {
							lastMsg.content += `\n\n---\n[Messages received while you were working:]\n${current.content}`;
						}
						if (current.images) {
							for (const img of current.images) {
								imageResults.push({
									text: "[User-attached image]",
									dataUri: `data:${img.mediaType};base64,${img.base64}`,
								});
							}
						}
					}
					i++;
				}

				// Inject images as a user message (OpenAI tool results are text-only)
				if (imageResults.length > 0) {
					const imageParts: unknown[] = [];
					for (const img of imageResults) {
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

			case "compact_marker":
				// Skip — readActive handles filtering by compact markers
				i++;
				break;
		}
	}
	return messages;
}
