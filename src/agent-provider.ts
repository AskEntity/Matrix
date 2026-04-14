import type { Event, EventSpec } from "./events.ts";
import type { MessageQueue } from "./message-queue.ts";

import type { ToolDefinition } from "./tool-definition.ts";
import type { AgentResult, TaskSession } from "./types.ts";

/** What the orchestrator sends to an agent. */
export interface AgentRequest {
	/** Absolute path to the project root. */
	projectPath?: string;
	/** Build work context content. Plugin hook. */
	buildWorkContext?: () => string | null;
	/** Build summarization instruction for compaction. Plugin hook. */
	buildSummarizationPrompt?: () => string;
	/** Build done-resume context text. Plugin hook. */
	buildDoneResumeContext?: () => string;
	/** Build system prompt. Called for fresh sessions and compact refresh.
	 * On resume, provider loop uses frozen prompt from session_config in JSONL. */
	buildSystemPrompt?: () => import("./system-prompts.ts").SystemPrompt;
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
	/**
	 * Cache TTL for message-level cache breakpoints.
	 * "1h" for root + persistent tasks. undefined for regular children (default 5min).
	 * Stored in session_config, inherited across fork.
	 */
	cacheTtl?: "1h";
	/**
	 * Emit callback for provider events (broadcast + persist).
	 * Provider calls this instead of writing to EventStore directly.
	 * The daemon layer wires this to R.emit() which adds taskId + traceId.
	 * Provider emits EventSpec (no taskId) — the emit layer routes it.
	 */
	emit?: (spec: EventSpec) => void;
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
	 * Bind the live messages[] array from the provider loop.
	 * Called once after the messages array is created in runProviderLoop.
	 * Used by the hidden evaluate_script tool (selfBootstrap mode) to inspect
	 * the live conversation state.
	 */
	setMessages?: (msgs: unknown[]) => void;
	/**
	 * Bind the frozen JsonTool[] from the provider loop.
	 * Called once after tools are resolved in runProviderLoop.
	 * Used by the hidden evaluate_script tool (selfBootstrap mode) to inspect
	 * the session's tool definitions.
	 */
	setAllTools?: (tools: unknown[]) => void;
	/**
	 * Absolute file path where the provider should write a pre-API-call snapshot
	 * of the exact bytes being sent to the API. Overwritten on every API call.
	 *
	 * Evidence for post-mortem cache-drift debugging: when a restart causes
	 * unexpected cache miss, compare this snapshot (last pre-restart state) to
	 * walker(JSONL). Enables diff at the exact granularity of what the API saw.
	 *
	 * Non-fatal on write failure — the snapshot is diagnostic, not load-bearing.
	 * If undefined, no snapshot is written.
	 */
	debugSnapshotPath?: string;
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
	stream(request: AgentRequest): AsyncGenerator<EventSpec, AgentResult>;
}
