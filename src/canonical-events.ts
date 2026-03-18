/**
 * Canonical events recorded alongside provider messages.
 * Uses `unknown[]` instead of Anthropic-specific types for provider-agnostic portability.
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
