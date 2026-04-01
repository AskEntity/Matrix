import type { Event } from "./events.ts";
import type { MessageQueue } from "./message-queue.ts";

import type { ToolDefinition } from "./tool-definition.ts";
import type { AgentResult, TaskSession } from "./types.ts";

/** What the orchestrator sends to an agent. */
export interface AgentRequest {
	/** Working directory for the agent to operate in. */
	cwd: string;
	/** Absolute path to the project root. Defaults to cwd if omitted. */
	projectPath?: string;
	/** System prompt injected into the agent session. Split for cache optimization. */
	systemPrompt?: import("./system-prompts.ts").SystemPrompt;
	/**
	 * Rebuild the system prompt with fresh date. Called after compaction to refresh
	 * the session_config. If not provided, the original systemPrompt is reused.
	 */
	refreshSystemPrompt?: () => import("./system-prompts.ts").SystemPrompt;
	/** Abort signal for cancellation. */
	signal?: AbortSignal;
	/** Session ID to resume a previous conversation. */
	resumeSessionId?: string;
	/** Raw MCP tool definitions for direct API forwarding (for AnthropicCompatibleProvider). */
	// biome-ignore lint/suspicious/noExplicitAny: ToolDefinition generic varies
	mcpToolDefs?: Record<string, ToolDefinition<any>[]>;
	/** Claude model to use (e.g. 'claude-sonnet-4-6', 'claude-opus-4-6'). */
	model?: string;
	/** External MessageQueue for message delivery. */
	queue?: MessageQueue;
	/** Callback to check if this agent has running children (for implicit yield on end_turn). */
	hasRunningChildren?: () => boolean;
	/** Budget limit in USD — provider will inject warnings at 80% and 100%. */
	budgetUsd?: number;
	/** True for root orchestrator sessions (depth 0). Affects cache TTL strategy. */
	isOrchestrator?: boolean;
	/**
	 * Emit callback for provider events (broadcast + persist).
	 * Provider calls this instead of writing to EventStore directly.
	 * The daemon layer wires this to emitEvent() which handles persistence.
	 * Provider emits events without taskId — the daemon layer injects it.
	 */
	emit?: (event: Event) => void;
	/**
	 * Pre-loaded active events for session resume.
	 * The daemon layer reads these from EventStore and passes them in.
	 * Provider uses them to reconstruct the conversation on resume.
	 */
	activeEvents?: Event[];
	/**
	 * Lookup function for TaskSession by sessionId.
	 * Used by tool execution to access session-scoped state (backgroundProcesses, foregroundExecutions).
	 */
	getSession?: (sessionId: string) => TaskSession | undefined;
	/**
	 * Build the ## Pending section for yield tool_result at resume time.
	 * Called by the provider loop when yield resumes after receiving messages.
	 * Uses live tracker data to report running sub tasks and pending clarifications.
	 * Returns the pending section text (e.g. "## Pending\n- Running sub tasks: ...").
	 */
	buildYieldPendingSection?: () => string;
	/**
	 * Enable auto-recovery from API 400 invalid_request_error.
	 * When true, the provider loop will attempt to recover by rolling back
	 * to the last successful turn instead of crashing.
	 * Default: false (tests should not use this to avoid masking real bugs).
	 * Production daemon sets this to true.
	 */
	enableAutoRecovery?: boolean;
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
	 * The queue, abort signal, and session lifecycle are managed by the caller (daemon layer).
	 */
	stream(request: AgentRequest): AsyncGenerator<Event, AgentResult>;
}
