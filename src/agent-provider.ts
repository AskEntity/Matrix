import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
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
	/** MCP servers to attach to the agent session. */
	mcpServers?: Record<string, McpServerConfig>;
}

/** Streaming event emitted by an agent during execution. */
export type AgentEvent =
	| { type: "status"; message: string }
	| { type: "tool_use"; tool: string; input: Record<string, unknown> }
	| { type: "text"; content: string }
	| { type: "error"; message: string };

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
}
