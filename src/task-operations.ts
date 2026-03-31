/**
 * Shared task operations — ONE function per operation.
 * Both MCP tool handlers and REST route handlers call these.
 * The ONLY parameter difference: editedBy ("agent" | "user").
 *
 * All side effects (save, broadcastTree, notifyTreeChange, persistent json writes)
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
import type { TaskNode, TaskStatus } from "./types.ts";

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
	persistent?: false | "reset" | "continue";
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
		persistent?: false | "reset" | "continue";
	} = { editedBy };
	if (opts.budgetUsd !== undefined) {
		createOpts.budgetUsd = opts.budgetUsd;
	}
	if (opts.draft) createOpts.draft = true;
	if (opts.persistent) createOpts.persistent = opts.persistent;

	const node = opts.parentId
		? tracker.addChild(opts.parentId, opts.title, opts.description, createOpts)
		: tracker.addTask(opts.title, opts.description, createOpts);

	if (opts.color) {
		tracker.updateColor(node.id, resolveColor(opts.color), editedBy);
	}

	// Write persistent task definition to .mxd/tasks/<id>.json and commit
	if (opts.persistent) {
		tracker.savePersistentDef(node.id, callbacks.projectPath);
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

	if (updates.parentId !== undefined) {
		tracker.reparent(nodeId, updates.parentId);
	}
	if (updates.status !== undefined) {
		// Persistent tasks cannot be set to "closed" directly
		if (updates.status === "closed" && node.persistent) {
			throw new TaskOperationError(
				"Cannot set persistent task to closed. Use close_task which resets to pending.",
			);
		}
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

	// Write persistent json if title/description/color changed
	const titleOrDescChanged =
		updates.title !== undefined ||
		updates.description !== undefined ||
		updates.color !== undefined;
	if (titleOrDescChanged) {
		tracker.savePersistentDef(nodeId, callbacks.projectPath);
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

	const result = tracker.get(nodeId);
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
	persistent?: "reset" | "continue";
	resetTo?: "pending";
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

	if (node.status === "in_progress") {
		throw new TaskOperationError(
			"Cannot close a running task. Stop it first or wait for done().",
		);
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
		node.updatedAt = new Date().toISOString();
	}

	// Persistent tasks reset to pending on close; regular tasks go to closed.
	if (node.persistent) {
		// "reset" mode: clear session JSONL for a clean start each cycle
		if (node.persistent === "reset") {
			callbacks.clearEventStore(node.id);
		}
		// "continue" mode: keep session JSONL for resuming with context
		tracker.updateStatus(node.id, "pending");
	} else {
		tracker.updateStatus(node.id, "closed");
	}

	await tracker.save();
	callbacks.broadcastTree();

	const result: CloseTaskResult = {
		taskId: node.id,
		title: node.title,
	};
	if (node.persistent) {
		result.persistent = node.persistent;
		result.resetTo = "pending";
	}
	return result;
}

// ── resetTask ──

export async function resetTaskOp(
	tracker: TaskTracker,
	nodeId: string,
	callbacks: {
		broadcastTree: () => void;
		removeWorktree: (taskId: string, slug: string) => Promise<void>;
		clearEventStore: (nodeId: string) => void;
	},
): Promise<{ taskId: string; title: string }> {
	const node = tracker.get(nodeId);
	if (!node) throw new TaskOperationError(`Task not found: ${nodeId}`);

	// Close running agent if active
	if (node.session?.queue) {
		const queue = node.session.queue;
		node.session = undefined;
		queue.close();
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

	// Delete event JSONL files
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
