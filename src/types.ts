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
}

/** Project-level state managed by the daemon. */
export interface Project {
	id: string;
	name: string;
	path: string;
	rootTaskId: string | null;
	createdAt: string;
}

/** A task description produced by the decomposition agent. */
export interface DecomposedTask {
	title: string;
	description: string;
	children?: DecomposedTask[];
}

/** Daemon health response. */
export interface HealthResponse {
	status: "ok";
	version: string;
	uptime: number;
}

/** Daemon version response. */
export interface VersionResponse {
	version: string;
	commit: string;
	startedAt: string;
}

/** Daemon stats response. */
export interface StatsResponse {
	uptime: number;
	requestCount: number;
}
