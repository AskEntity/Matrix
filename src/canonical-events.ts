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
