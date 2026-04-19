/**
 * Shared task operations — ONE function per operation.
 * Both MCP tool handlers and REST route handlers call these.
 * The ONLY parameter difference: editedBy ("agent" | "user").
 *
 * All side effects (save, broadcastTree, notifyTreeChange)
 * happen inside these functions. Callers are thin wrappers.
 *
 * Notification rules:
 * - broadcastTree: always (SSE push for UI refresh)
 * - notifyTreeChange (parent chain walk): only when editedBy === "user"
 *   Agents are IN the tree — their parent already knows what it asked.
 * - notifyTargetNode (notify the modified node itself): always
 *   If agent A updates agent B's description, B should know.
 */

import type { TaskTracker } from "./task-tracker.ts";
import { cleanupTaskResources, resolveColor, slugify } from "./task-utils.ts";
import { isTask, type TaskNode, type TaskStatus } from "./types.ts";

// ── Shared types ──

type TreeAction = "created" | "updated" | "deleted" | "reordered";

/**
 * Callbacks for tree change notifications.
 * - notifyTreeChange: walks parent chain. Called only when editedBy === "user".
 * - notifyTargetNode: notifies the modified node itself. Called always.
 */
export interface TreeChangeCallbacks {
	/** Walk parent chain to notify ancestors of a tree modification. User-only. */
	notifyTreeChange?: (
		action: TreeAction,
		nodeId: string,
		title?: string,
	) => void;
	/** Notify the modified node itself (e.g. enqueue tree_change to its queue). */
	notifyTargetNode?: (
		action: TreeAction,
		nodeId: string,
		title?: string,
	) => void;
}

// ── Error types ──

/** Thrown when a task operation fails due to invalid input or state. */
export class TaskOperationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TaskOperationError";
	}
}

// ── createTask ──

export interface CreateTaskOpts {
	title: string;
	description: string;
	parentId?: string;
	draft?: boolean;
	color?: string;
	budgetUsd?: number;
}

export async function createTaskOp(
	tracker: TaskTracker,
	opts: CreateTaskOpts,
	editedBy: "agent" | "user",
	callbacks: TreeChangeCallbacks & {
		broadcastTree: () => void;
		projectPath: string;
	},
): Promise<TaskNode> {
	const createOpts: {
		budgetUsd?: number;
		draft?: boolean;
		editedBy: "user" | "agent";
	} = { editedBy };
	if (opts.budgetUsd !== undefined) {
		createOpts.budgetUsd = opts.budgetUsd;
	}
	if (opts.draft) createOpts.draft = true;

	const node = opts.parentId
		? tracker.addChild(opts.parentId, opts.title, opts.description, createOpts)
		: tracker.addTask(opts.title, opts.description, createOpts);

	if (opts.color) {
		tracker.updateColor(node.id, resolveColor(opts.color), editedBy);
	}

	await tracker.save();
	callbacks.broadcastTree();

	// Parent chain notification — user edits only
	if (editedBy === "user") {
		callbacks.notifyTreeChange?.("created", node.id, node.title);
	}

	return node;
}

// ── updateTask ──

export interface UpdateTaskOpts {
	status?: TaskStatus;
	title?: string;
	/** Final description. MCP pre-processes old_description/new_description into this. */
	description?: string;
	draft?: boolean;
	parentId?: string;
	color?: string | null;
}

export async function updateTaskOp(
	tracker: TaskTracker,
	nodeId: string,
	updates: UpdateTaskOpts,
	editedBy: "agent" | "user",
	callbacks: TreeChangeCallbacks & {
		broadcastTree: () => void;
		projectPath: string;
	},
): Promise<TaskNode> {
	const node = tracker.get(nodeId);
	if (!node) throw new TaskOperationError(`Task not found: ${nodeId}`);
	if (!isTask(node))
		throw new TaskOperationError(
			`Cannot update non-task node as task: ${nodeId}`,
		);

	if (updates.parentId !== undefined) {
		tracker.reparent(nodeId, updates.parentId);
	}
	if (updates.status !== undefined) {
		tracker.updateStatus(nodeId, updates.status, editedBy);
	}
	if (updates.title !== undefined) {
		tracker.updateTitle(nodeId, updates.title, editedBy);
	}
	if (updates.description !== undefined) {
		tracker.updateDescription(nodeId, updates.description, editedBy);
	}
	if (updates.draft !== undefined) {
		tracker.updateStatus(nodeId, updates.draft ? "draft" : "pending", editedBy);
	}
	if (updates.color !== undefined) {
		tracker.updateColor(
			nodeId,
			updates.color ? resolveColor(updates.color) : null,
			editedBy,
		);
	}

	await tracker.save();
	callbacks.broadcastTree();

	// Notifications for title/description changes
	if (updates.title !== undefined || updates.description !== undefined) {
		const updatedNode = tracker.get(nodeId);
		// Notify the modified node itself — always (both agent and user edits)
		callbacks.notifyTargetNode?.("updated", nodeId, updatedNode?.title);
		// Walk parent chain — user edits only
		if (editedBy === "user") {
			callbacks.notifyTreeChange?.("updated", nodeId, updatedNode?.title);
		}
	}

	const result = tracker.getTask(nodeId);
	if (!result)
		throw new TaskOperationError(`Task not found after update: ${nodeId}`);
	return result;
}

// ── deleteTask ──

export async function deleteTaskOp(
	tracker: TaskTracker,
	nodeId: string,
	editedBy: "agent" | "user",
	callbacks: TreeChangeCallbacks & {
		broadcastTree: () => void;
		removeWorktree: (taskId: string, slug: string) => Promise<void>;
		clearEventStore: (nodeId: string) => void;
	},
): Promise<{ taskId: string; title: string }> {
	const node = tracker.get(nodeId);
	if (!node) throw new TaskOperationError(`Task not found: ${nodeId}`);

	if (!isTask(node)) {
		// General nodes (folders etc.) can only be deleted when empty
		if (node.children.length > 0) {
			throw new TaskOperationError(
				`Cannot delete ${node.type} with children. Move or delete children first.`,
			);
		}
		const title = node.title;
		tracker.remove(nodeId);
		await tracker.save();
		callbacks.broadcastTree();
		if (editedBy === "user") {
			callbacks.notifyTreeChange?.("deleted", nodeId, title);
		}
		return { taskId: nodeId, title };
	}

	if (node.children.length > 0) {
		throw new TaskOperationError(
			`Cannot delete task with children. Reparent or delete children first.`,
		);
	}

	const title = node.title;

	await cleanupTaskResources(tracker, nodeId, {
		removeWorktree: callbacks.removeWorktree,
		clearEventStore: callbacks.clearEventStore,
	});

	tracker.remove(nodeId);
	await tracker.save();
	callbacks.broadcastTree();

	// Parent chain notification — user edits only
	if (editedBy === "user") {
		callbacks.notifyTreeChange?.("deleted", nodeId, title);
	}

	return { taskId: nodeId, title };
}

// ── closeTask ──

export interface CloseTaskResult {
	taskId: string;
	title: string;
}

export async function closeTaskOp(
	tracker: TaskTracker,
	nodeId: string,
	callbacks: {
		broadcastTree: () => void;
		removeWorktree: (taskId: string, slug: string) => Promise<void>;
		clearEventStore: (nodeId: string) => void;
	},
): Promise<CloseTaskResult> {
	const node = tracker.get(nodeId);
	if (!node) throw new TaskOperationError(`Task not found: ${nodeId}`);
	if (!isTask(node))
		throw new TaskOperationError(`Cannot close a ${node.type} node: ${nodeId}`);

	if (node.status === "in_progress") {
		throw new TaskOperationError(
			"Cannot close a running task. Stop it first or wait for done().",
		);
	}

	if (node.status !== "verify" && node.status !== "failed") {
		throw new TaskOperationError(
			`Cannot close a task with status "${node.status}". Only verify or failed tasks can be closed.`,
		);
	}

	const targetStatus = "closed";

	// Clean up worktree + branch if they exist
	if (node.worktreePath && node.branch) {
		try {
			await callbacks.removeWorktree(node.id, slugify(node.title));
		} catch {
			/* worktree may already be gone */
		}
		node.worktreePath = null;
		node.branch = null;
		node.updatedAt = new Date().toISOString();
	}

	tracker.updateStatus(node.id, targetStatus);

	await tracker.save();
	callbacks.broadcastTree();

	return {
		taskId: node.id,
		title: node.title,
	};
}

// ── resetTask ──

export async function resetTaskOp(
	tracker: TaskTracker,
	nodeId: string,
	callbacks: {
		broadcastTree: () => void;
		removeWorktree: (taskId: string, slug: string) => Promise<void>;
		clearEventStore: (nodeId: string) => void;
		/**
		 * Stop a running agent and await its loop exit.
		 * Must wait for the agent loop's finally block to complete before returning.
		 * Without this, the agent's async cleanup can write events AFTER JSONL is cleared.
		 */
		stopTask?: (nodeId: string) => Promise<void>;
		/**
		 * Await agent loop exit even when session is not yet set.
		 * Covers the launchingNodes gap: runAgentForNode is running
		 * (worktree creation, MCP connect) but session hasn't been set yet.
		 * Without this, clearEventStore races with the loop's setup writes.
		 */
		awaitLoopExit?: (nodeId: string) => Promise<void>;
	},
): Promise<{ taskId: string; title: string }> {
	const node = tracker.get(nodeId);
	if (!node) throw new TaskOperationError(`Task not found: ${nodeId}`);
	if (!isTask(node))
		throw new TaskOperationError(`Cannot reset a ${node.type} node: ${nodeId}`);

	// Stop running agent and await loop exit BEFORE clearing JSONL.
	// The agent loop's finally block may write events (agent_stopped, etc.).
	// We must wait for it to complete so those writes happen BEFORE we clear.
	if (node.session?.queue) {
		if (callbacks.stopTask) {
			// Daemon path: stop + await loop exit (writes settle before clear)
			await callbacks.stopTask(node.id);
		} else {
			// Test/fallback path: just close queue + clear session
			const queue = node.session.queue;
			node.session = undefined;
			queue.close();
		}
	} else if (callbacks.awaitLoopExit) {
		// No session yet — agent may be in launchingNodes state (still creating
		// worktree, connecting MCP). The loop promise exists but session doesn't.
		// Await loop exit so its writes complete BEFORE we clear JSONL.
		await callbacks.awaitLoopExit(node.id);
	}

	// Clean up worktree + branch if they exist
	if (node.worktreePath && node.branch) {
		try {
			await callbacks.removeWorktree(node.id, slugify(node.title));
		} catch {
			/* worktree may already be gone */
		}
		node.worktreePath = null;
		node.branch = null;
	}

	// Delete event JSONL files — safe now because agent loop has fully exited
	callbacks.clearEventStore(node.id);

	tracker.updateStatus(node.id, "pending");
	await tracker.save();
	callbacks.broadcastTree();

	return { taskId: node.id, title: node.title };
}

// ── reorderTasks ──

export async function reorderTasksOp(
	tracker: TaskTracker,
	nodeId: string,
	children: string[],
	editedBy: "agent" | "user",
	callbacks: TreeChangeCallbacks & {
		broadcastTree: () => void;
	},
): Promise<void> {
	const node = tracker.get(nodeId);
	if (!node) throw new TaskOperationError(`Task not found: ${nodeId}`);

	tracker.reorderChildren(nodeId, children);
	await tracker.save();
	callbacks.broadcastTree();

	// Parent chain notification — user edits only
	if (editedBy === "user") {
		callbacks.notifyTreeChange?.("reordered", nodeId, node.title);
	}
}
