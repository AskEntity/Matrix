import type { MessageQueue } from "./message-queue.ts";
import type { BackgroundProcess } from "./tools/bash.ts";

/** Task status follows the lifecycle: draft → pending → in_progress → verify | failed | closed */
export type TaskStatus =
	| "draft"
	| "pending"
	| "in_progress"
	| "verify"
	| "failed"
	| "closed";

/**
 * Runtime-only session state attached to a TaskNode while its agent is running.
 * NOT serialized to disk — rebuilt at agent launch, cleared at agent stop.
 */
export interface TaskSession {
	queue: MessageQueue;
	/** Abort controller for cancelling in-flight API calls. */
	abortController: AbortController;
	/**
	 * Trace ID for this agent loop instance. All events emitted BY this run
	 * (provider loop, tool handlers, lifecycle events in runAgentForNode) carry
	 * this value as `event.traceId`. External paths (deliverMessage of user
	 * input, task_started before loop spawn, fork_marker, tree_change) do NOT
	 * carry traceId — they exist independently of any specific run.
	 */
	loopTraceId: string;

	depth: number;
	/** Background processes for this session, keyed by background process ID. */
	backgroundProcesses: Map<string, BackgroundProcess>;
	/** Foreground execution tracking — resolve callbacks for move-to-background. Key: `${sessionId}:${execId}` */
	foregroundExecutions: Map<string, { resolve: () => void; command: string }>;
	/** Live provider messages[] — set by runProviderLoop via setMessages callback. For debug dump. */
	messages?: unknown[];
	/** Frozen JsonTool[] — set by runProviderLoop via setAllTools callback. For debug dump. */
	allTools?: unknown[];
}

/**
 * A general (non-launchable) tree node — pure metadata + tree position.
 *
 * Runtime has no opinion on what a GeneralNode means. The plugin decides:
 * Matrix uses `type: "folder"` for visual grouping; another plugin could
 * use `type: "chapter"`, `type: "note"`, etc. The runtime guarantees only
 * that general nodes have no session, no lifecycle, no agent.
 *
 * Ownership transparency: getTaskAbove/getTasksBelow walk through
 * GeneralNodes to find the owning task ancestor/descendants.
 *
 * There is NO `plugin` field — each tree (tree.json) belongs to exactly
 * one plugin by construction. The plugin identity is implicit.
 */
export interface GeneralNode {
	id: string;
	title: string;
	parentId: string | null;
	children: string[];
	/**
	 * Plugin-defined discriminator. Any string EXCEPT `"task"` (which is
	 * reserved for TaskNode). Matrix's folder uses `"folder"`.
	 */
	type: string;
	/**
	 * Plugin-owned opaque data. Runtime never parses, never validates.
	 * Plugins store their own semantic metadata here.
	 */
	metadata?: Record<string, unknown>;
}

/**
 * A task node — maps 1:1 to an agent and a git branch.
 * Has full lifecycle: draft → pending → in_progress → verify | failed → closed.
 */
/**
 * Base node — runtime-level fields only.
 * Plugin extends this with domain-specific fields.
 */
export interface BaseTaskNode {
	id: string;
	title: string;
	parentId: string | null;
	children: string[];
	createdAt: string;
	updatedAt: string;
	/**
	 * Lifecycle status. Runtime-generic, NOT a matrix-only concept: createNode
	 * inits it, updateStatus mutates it, load() migrates it, and the default
	 * shouldResume keys on `status === "in_progress"`. A plugin whose nodes are
	 * launchable inherits this field — it must NOT re-declare it. The runtime
	 * attaches no domain meaning to any particular status value beyond the
	 * lifecycle the tracker enforces.
	 */
	status: TaskStatus;
	/**
	 * Plugin-owned opaque data. Runtime never parses, never validates — it only
	 * round-trips this through save()/load(). Plugins store per-node config here
	 * (e.g. a chat plugin's character profile). Parallel to GeneralNode.metadata:
	 * the launchable node is exactly the one that needs per-node plugin config.
	 */
	metadata?: Record<string, unknown>;
	/**
	 * Runtime-only session state. Present while the agent is running.
	 * NOT persisted to disk — stripped during save(), undefined on load().
	 */
	session?: TaskSession;
	/** Discriminator: task nodes are always `"task"`. Required — no fallback. */
	type: "task";
}

/**
 * Matrix-specific task node — extends base with coding-IDE fields.
 * This is what Matrix's plugin operates on. Other plugins define their own extends.
 */
export interface TaskNode extends BaseTaskNode {
	description: string;
	branch: string | null;
	/** Absolute path to the git worktree for this task. */
	worktreePath: string | null;
	/** Current working directory — persists across restarts. Updated by bash cd. */
	cwd: string | null;
	/** Accumulated cost in USD for this task's agent execution. Default 0. */
	costUsd: number;
	/** Maximum cost in USD this task is allowed to spend. */
	budgetUsd?: number;
	/** Who last modified this node: 'user' (REST/CLI) or 'agent' (MCP tools). Default "agent". */
	editedBy: "user" | "agent";
	/** Optional color label for visual categorization. */
	color?: string;
}

/** Any node in the task tree — either a launchable task or a plugin-defined general node. */
export type TreeNode = TaskNode | GeneralNode;

/** Type guard: is this a task node? Narrowing hinges on the required `type` discriminator. */
export function isTask(node: TreeNode): node is TaskNode {
	return node.type === "task";
}

/** Type guard: is this a general (non-launchable) node? */
export function isGeneral(node: TreeNode): node is GeneralNode {
	return node.type !== "task";
}

/** Strip runtime-only session from a TaskNode for serialization. */
export function stripSession(node: TaskNode): Omit<TaskNode, "session"> {
	const { session: _, ...rest } = node;
	return rest;
}

/**
 * Why the provider loop exited.
 * - `done_passed` / `done_failed` — agent explicitly called done(). Agent's decision.
 * - `interrupted` — everything else (stop, reset, error, queue close, restart).
 */
export type ExitReason = "done_passed" | "done_failed" | "interrupted";

/** Result returned by an agent after executing a task step. */
export interface AgentResult {
	/** Why the provider loop exited. */
	exitReason: ExitReason;
	output: string;
	/** The agent's done() summary text, carried from tool handler to Phase 2 in runAgentForNode. */
	doneSummary?: string;
	/** Cost in USD for this execution. */
	costUsd: number;
	/** Number of agentic turns (tool-use round trips). */
	turns: number;
	/** Session ID for resuming this conversation later. */
	sessionId: string;
	// Token breakdown (AnthropicCompatibleProvider only; undefined for ClaudeAgentSdkProvider)
	/** Non-cached input tokens consumed. */
	inputTokens?: number;
	/** Cache-creation (write) tokens consumed. */
	cacheCreationTokens?: number;
	/** Cache-read tokens consumed. */
	cacheReadTokens?: number;
	/** Output tokens produced. */
	outputTokens?: number;
}

/** Project-level state managed by the daemon. */
export interface Project {
	id: string;
	name: string;
	path: string;
	createdAt: string;
}

/** Daemon health response. */
export interface HealthResponse {
	status: "ok";
	version: string;
	gitHash: string;
	uptime: number;
	model?:
		| { status: "ok"; model: string; latencyMs: number }
		| { status: "error"; error: string };
}

/** Daemon version response. */
export interface VersionResponse {
	version: string;
	gitHash: string;
	nodeCount: number;
	projectCount: number;
}

/** Daemon stats response. */
export interface StatsResponse {
	uptime: number;
	requestCount: number;
	projectCount: number;
	taskCounts: {
		draft: number;
		pending: number;
		in_progress: number;
		verify: number;
		failed: number;
		closed: number;
	};
}
