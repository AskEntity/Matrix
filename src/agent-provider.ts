import type {
	McpServerConfig,
	SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentResult } from "./types.ts";

/** What the orchestrator sends to an agent. */
export interface AgentRequest {
	/** The task prompt for the agent. */
	prompt: string;
	/** Working directory for the agent to operate in. */
	cwd: string;
	/** System prompt injected into the agent session. */
	systemPrompt?: string;
	/** Maximum number of agentic turns (tool-use round trips). */
	maxTurns?: number;
	/** Abort signal for cancellation. */
	signal?: AbortSignal;
	/** Session ID to resume a previous conversation. */
	resumeSessionId?: string;
	/** MCP servers to attach to the agent session (for Claude Code provider). */
	mcpServers?: Record<string, McpServerConfig>;
	/** Raw MCP tool definitions for direct API forwarding (for DirectProvider). */
	// biome-ignore lint/suspicious/noExplicitAny: SdkMcpToolDefinition generic varies
	mcpToolDefs?: Record<string, SdkMcpToolDefinition<any>[]>;
	/** Claude model to use (e.g. 'claude-sonnet-4-6', 'claude-opus-4-6'). */
	model?: string;
}

/** Streaming event emitted by an agent during execution. */
export type AgentEvent =
	| { type: "status"; message: string }
	| { type: "tool_use"; tool: string; input: Record<string, unknown> }
	| {
			type: "tool_result";
			tool: string;
			content: string;
			isError: boolean;
	  }
	| { type: "text"; content: string }
	| { type: "error"; message: string };

/** Handle to a running agent session that supports message injection. */
export interface AgentSession {
	/** Unique session ID for this running agent. */
	readonly sessionId: string;
	/** Stream of agent events. Consume this to drive the session. */
	events: AsyncGenerator<AgentEvent, AgentResult>;
	/** Send a message to the agent mid-execution. */
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
