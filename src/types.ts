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

/** Daemon health response. */
export interface HealthResponse {
	status: "ok";
	version: string;
	uptime: number;
}
