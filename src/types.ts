/** Task status follows the lifecycle: pending → in_progress → testing → passed | failed | stuck */
export type TaskStatus =
	| "pending"
	| "in_progress"
	| "testing"
	| "passed"
	| "failed"
	| "stuck";

/** A node in the task tree. Each node maps 1:1 to an agent and a git branch. */
export interface TaskNode {
	id: string;
	title: string;
	description: string;
	status: TaskStatus;
	branch: string | null;
	parentId: string | null;
	children: string[];
	/** Agent session ID for resuming conversations. */
	sessionId: string | null;
	/** Absolute path to the git worktree for this task. */
	worktreePath: string | null;
	/** Optional message to pass when continuing a failed/stuck task. */
	message: string | null;
	/** Number of consecutive failures (auto-stuck at 3). */
	failCount: number;
	/** Accumulated cost in USD for this task's agent execution. */
	costUsd?: number;
	createdAt: string;
	updatedAt: string;
}

/** Result returned by an agent after executing a task step. */
export interface AgentResult {
	success: boolean;
	output: string;
	/** Cost in USD for this execution. */
	costUsd?: number;
	/** Number of agentic turns (tool-use round trips). */
	turns?: number;
	/** Session ID for resuming this conversation later. */
	sessionId?: string;
	/** Structured test results, if the step involved running tests. */
	testResults?: {
		passed: string[];
		failed: string[];
		errors: string[];
	};
	// Token breakdown (DirectProvider only; undefined for ClaudeCodeProvider)
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
	uptime: number;
	model?:
		| { status: "ok"; model: string; latencyMs: number }
		| { status: "error"; error: string };
}

/** Daemon version response. */
export interface VersionResponse {
	version: string;
	nodeCount: number;
	projectCount: number;
}

/** Daemon stats response. */
export interface StatsResponse {
	uptime: number;
	requestCount: number;
	projectCount: number;
	taskCounts: {
		pending: number;
		in_progress: number;
		testing: number;
		passed: number;
		failed: number;
		stuck: number;
	};
}
