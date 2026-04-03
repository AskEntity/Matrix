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
	/** Current working directory — mutable, updated by bash cd. */
	cwd: string;
	/** Project/worktree root — immutable fallback. */
	fallbackCwd: string;
	depth: number;
	/** Background processes for this session, keyed by background process ID. */
	backgroundProcesses: Map<string, BackgroundProcess>;
	/** Foreground execution tracking — resolve callbacks for move-to-background. Key: `${sessionId}:${execId}` */
	foregroundExecutions: Map<string, { resolve: () => void; command: string }>;
}

/** Shared fields for all task nodes. */
interface BaseTaskNode {
	id: string;
	title: string;
	description: string;
	branch: string | null;
	parentId: string | null;
	children: string[];
	/** Absolute path to the git worktree for this task. */
	worktreePath: string | null;
	/** Accumulated cost in USD for this task's agent execution. Default 0. */
	costUsd: number;
	/** Maximum cost in USD this task is allowed to spend. */
	budgetUsd?: number;
	/** Who last modified this node: 'user' (REST/CLI) or 'agent' (MCP tools). Default "agent". */
	editedBy: "user" | "agent";
	/** Optional color label for visual categorization. */
	color?: string;
	createdAt: string;
	updatedAt: string;
	/**
	 * Runtime-only session state. Present while the agent is running.
	 * NOT persisted to disk — stripped during save(), undefined on load().
	 */
	session?: TaskSession;
}

/** A node in the task tree. Each node maps 1:1 to an agent and a git branch. */
export interface TaskNode extends BaseTaskNode {
	status: TaskStatus;
}

/** Serialized form of a task node in tree.json (session stripped). */
export type SerializedTaskNode = Omit<TaskNode, "session">;

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
