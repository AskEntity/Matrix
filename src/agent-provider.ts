import type { EventStore } from "./event-store.ts";
import type { MessageQueue } from "./message-queue.ts";
import type { ToolDefinition } from "./tool-definition.ts";
import type { AgentResult } from "./types.ts";

/** What the orchestrator sends to an agent. */
export interface AgentRequest {
	/** The task prompt for the agent. */
	prompt: string;
	/** Working directory for the agent to operate in. */
	cwd: string;
	/** Absolute path to the project root. Defaults to cwd if omitted. */
	projectPath?: string;
	/** System prompt injected into the agent session. */
	systemPrompt?: string;
	/** Abort signal for cancellation. */
	signal?: AbortSignal;
	/** Session ID to resume a previous conversation. */
	resumeSessionId?: string;
	/** Raw MCP tool definitions for direct API forwarding (for AnthropicCompatibleProvider). */
	// biome-ignore lint/suspicious/noExplicitAny: ToolDefinition generic varies
	mcpToolDefs?: Record<string, ToolDefinition<any>[]>;
	/** Claude model to use (e.g. 'claude-sonnet-4-6', 'claude-opus-4-6'). */
	model?: string;
	/** External MessageQueue — if provided, startSession uses this instead of creating a new one. */
	queue?: MessageQueue;
	/** Callback to check if this agent has running children (for implicit yield on end_turn). */
	hasRunningChildren?: () => boolean;
	/** Budget limit in USD — provider will inject warnings at 80% and 100%. */
	budgetUsd?: number;
	/** EventStore for strongly-typed event persistence (Event JSONL). */
	eventStore?: EventStore;
}

/** Streaming event emitted by an agent during execution. */
export type AgentEvent =
	| { type: "status"; message: string }
	| {
			type: "tool_use";
			tool: string;
			toolUseId: string;
			input: Record<string, unknown>;
	  }
	| {
			type: "tool_result";
			tool: string;
			toolUseId: string;
			content: string;
			isError: boolean;
	  }
	| { type: "text"; content: string }
	| { type: "text_delta"; content: string }
	| { type: "error"; message: string }
	| { type: "compact_started" }
	| {
			type: "compact";
			checkpoint: string;
			savedTokens: number;
	  }
	| {
			type: "queue_message";
			/** Formatted queue messages injected at cancellation points */
			messages: string;
			/** Structured raw messages for UI consumption (avoids text parsing) */
			rawMessages?: Array<{ source: string; content: string }>;
	  }
	| {
			type: "usage";
			inputTokens: number;
			compressThreshold: number;
			contextWindow: number;
			estimated?: boolean;
	  }
	| { type: "agent_idle" }
	| { type: "agent_active" };

/** Handle to a running agent session that supports message injection. */
export interface AgentSession {
	/** Unique session ID for this running agent. */
	readonly sessionId: string;
	/** Stream of agent events. Consume this to drive the session. */
	events: AsyncGenerator<AgentEvent, AgentResult>;
	/** Message queue for async event delivery (user messages, child completions, etc.) */
	readonly queue: MessageQueue;
	/** @deprecated Use queue.enqueue({ source: "user", content: text }) instead */
	sendMessage(text: string): Promise<void>;
	/** Stop the agent. */
	stop(): void;
}

/**
 * Interface for agent execution backends.
 *
 * Phase 0: Claude Code Agent SDK
 * Phase 2-3: Direct Anthropic Messages API + custom tools
 * Phase 4+: Multi-provider (Claude, GPT, Gemini, etc.)
 */
export interface AgentProvider {
	readonly name: string;

	/** Execute a task and return the final result. */
	execute(request: AgentRequest): Promise<AgentResult>;

	/**
	 * Execute a task with streaming events.
	 * The last yielded value is always the final AgentResult.
	 */
	stream(request: AgentRequest): AsyncGenerator<AgentEvent, AgentResult>;

	/**
	 * Start an interactive agent session that supports mid-execution message injection.
	 * Returns a session handle with sendMessage() and an event stream.
	 */
	startSession(request: AgentRequest): AgentSession;
}
