/**
 * Matrix plugin types.
 *
 * Runtime types: re-exported from @mxd/types (importmap shared module).
 * Matrix-specific types: defined here.
 */

// Runtime types — shared via importmap, type-only in compiled JS
export type { Event, QueueMessage, BaseTaskNode } from "@mxd/types";

// Matrix-specific types

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
