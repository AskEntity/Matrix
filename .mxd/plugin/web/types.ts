/**
 * Matrix plugin types — defines the shapes this plugin works with.
 * These match the API response format. Plugin does NOT import from src/.
 */

export type TaskStatus =
	| "draft"
	| "pending"
	| "in_progress"
	| "verify"
	| "failed"
	| "closed";

export interface FolderNode {
	id: string;
	title: string;
	parentId: string | null;
	children: string[];
	type: "folder";
}

export interface TaskNode {
	id: string;
	title: string;
	description: string;
	status: TaskStatus;
	parentId: string | null;
	children: string[];
	branch: string | null;
	worktreePath: string | null;
	cwd: string | null;
	costUsd: number;
	budgetUsd?: number;
	editedBy: "user" | "agent";
	color?: string;
	createdAt: string;
	updatedAt: string;
	type?: "task";
}

export type TreeNode = TaskNode | FolderNode;

export function isFolder(node: TreeNode): node is FolderNode {
	return node.type === "folder";
}

export function isTask(node: TreeNode): node is TaskNode {
	return node.type !== "folder";
}

/**
 * SSE Event — the shape of events received from the daemon.
 * Plugin doesn't need the full discriminated union from src/events.ts.
 * This is the wire format.
 */
export interface Event {
	type: string;
	taskId: string;
	ts: number;
	// Common fields across event types (plugin accesses these)
	content?: string;
	tool?: string;
	toolCallId?: string;
	input?: Record<string, unknown>;
	body?: Record<string, unknown>;
	traceId?: string;
	// Allow additional fields
	[key: string]: unknown;
}

/**
 * QueueMessage — the shape of message bodies in "message" events.
 */
export interface QueueMessage {
	id: string;
	source: string;
	ts: number;
	content?: string;
	title?: string;
	taskId?: string;
	taskName?: string;
	fromProjectId?: string;
	fromProjectName?: string;
	images?: Array<{ base64: string; mediaType: string }>;
	[key: string]: unknown;
}
