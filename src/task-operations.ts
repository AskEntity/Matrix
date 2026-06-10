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
import { cleanupTaskResources, resolveColor } from "./task-utils.ts";
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
	/**
	 * Plugin-owned opaque metadata to attach at creation (e.g. a chat plugin's
	 * character profile). Runtime never reads it — round-trips via save/load.
	 */
	metadata?: Record<string, unknown>;
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
		metadata?: Record<string, unknown>;
	} = { editedBy };
	if (opts.budgetUsd !== undefined) {
		createOpts.budgetUsd = opts.budgetUsd;
	}
	if (opts.draft) createOpts.draft = true;
	if (opts.metadata !== undefined) {
		createOpts.metadata = opts.metadata;
	}

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
	/**
	 * Plugin-owned opaque metadata. REPLACE semantics — the whole object is
	 * replaced (mirrors tracker.setMetadata), never deep-merged. To update a
	 * single key, the caller reads current metadata and sends the merged object.
	 * `undefined` means "leave existing metadata untouched".
	 */
	metadata?: Record<string, unknown>;
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
		// "closed" and "failed" are lifecycle-terminal states that require
		// cleanup (worktree removal, JSONL clear, task_complete delivery).
		// Allowing them via a plain PATCH bypasses closeTaskOp / done() and
		// leaks worktrees + branches. Force callers through the proper ops.
		if (updates.status === "closed") {
			throw new TaskOperationError(
				'Cannot set status to "closed" via update. Use close_task instead.',
			);
		}
		if (updates.status === "failed") {
			throw new TaskOperationError(
				'Cannot set status to "failed" via update. Status "failed" is set by done("failed") or lifecycle operations.',
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
	if (updates.metadata !== undefined) {
		// REPLACE the whole object — never deep-merge. The caller (e.g. a
		// plugin UI) reads current metadata and sends the complete merged object.
		tracker.setMetadata(nodeId, updates.metadata);
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
		/** Remove the worktree by its STORED path + branch (rename-proof). */
		removeWorktree: (
			taskId: string,
			worktreePath: string,
			branch: string,
		) => Promise<void>;
		clearEventStore: (nodeId: string) => void;
		/**
		 * Stop a running agent and await its loop exit BEFORE cleanup.
		 * Without this, `git worktree remove --force` + clearEventStore race
		 * the live agent loop (mid-bash / mid-API-call): the loop's finally
		 * writes to the JSONL we just cleared, the worktree vanishes under a
		 * running process, and if the agent was about to done(), Phase 2 reads
		 * getTask=undefined → the parent is never notified and hangs forever.
		 * Mirrors resetTaskOp. Test/fallback path (no callback) closes the
		 * queue directly without awaiting.
		 */
		stopTask?: (nodeId: string) => Promise<void>;
		/**
		 * Await agent loop exit when no session is set yet — the launchingNodes
		 * gap (worktree creation / MCP connect in flight). Mirrors resetTaskOp.
		 */
		awaitLoopExit?: (nodeId: string) => Promise<void>;
	},
): Promise<{ taskId: string; title: string }> {
	const node = tracker.get(nodeId);
	if (!node) throw new TaskOperationError(`Task not found: ${nodeId}`);

	// Root node cannot be deleted — it would orphan the entire tree.
	if (isTask(node) && node.id === tracker.rootNodeId) {
		throw new TaskOperationError(
			"Cannot delete the root node. The root orchestrator is the tree anchor.",
		);
	}

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

	// Stop a running agent + await loop exit BEFORE removing the worktree /
	// clearing JSONL. delete used to skip this (close rejects in_progress,
	// reset awaits — delete did neither) and would destroy unmerged work and
	// race the live loop. reset-style is the right semantic: deleting a
	// running task means "stop it, then delete".
	if (node.session?.queue) {
		if (callbacks.stopTask) {
			await callbacks.stopTask(node.id);
		} else {
			const queue = node.session.queue;
			node.session = undefined;
			queue.close();
		}
	} else if (callbacks.awaitLoopExit) {
		await callbacks.awaitLoopExit(node.id);
	}

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
		/** Remove the worktree by its STORED path + branch (rename-proof). */
		removeWorktree: (
			taskId: string,
			worktreePath: string,
			branch: string,
		) => Promise<void>;
		clearEventStore: (nodeId: string) => void;
	},
): Promise<CloseTaskResult> {
	const node = tracker.get(nodeId);
	if (!node) throw new TaskOperationError(`Task not found: ${nodeId}`);
	if (!isTask(node))
		throw new TaskOperationError(`Cannot close a ${node.type} node: ${nodeId}`);

	// Root node cannot be closed — it is the tree anchor.
	if (node.id === tracker.rootNodeId) {
		throw new TaskOperationError(
			"Cannot close the root node. The root orchestrator is the tree anchor.",
		);
	}

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

	// Clean up worktree + branch if they exist. Remove by the STORED path +
	// branch — NOT a re-slugified title (the title may have changed since the
	// worktree was created, which would orphan the real worktree).
	if (node.worktreePath && node.branch) {
		try {
			await callbacks.removeWorktree(node.id, node.worktreePath, node.branch);
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
		/** Remove the worktree by its STORED path + branch (rename-proof). */
		removeWorktree: (
			taskId: string,
			worktreePath: string,
			branch: string,
		) => Promise<void>;
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

	// Root node cannot be reset — it is the tree anchor.
	if (node.id === tracker.rootNodeId) {
		throw new TaskOperationError(
			"Cannot reset the root node. The root orchestrator is the tree anchor.",
		);
	}

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

	// Clean up worktree + branch if they exist. Remove by the STORED path +
	// branch — NOT a re-slugified title (rename-proof; the title may have
	// changed since the worktree was created).
	if (node.worktreePath && node.branch) {
		try {
			await callbacks.removeWorktree(node.id, node.worktreePath, node.branch);
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
