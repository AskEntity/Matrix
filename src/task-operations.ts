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

import { projectIndexDbPath } from "./data-paths.ts";
import { updateTaskIndex } from "./task-index.ts";
import type { TaskTracker } from "./task-tracker.ts";
import { cleanupTaskResources, resolveColor } from "./task-utils.ts";
import { isTask, type TaskNode, type TaskStatus } from "./types.ts";

// ── Shared types ──

type TreeAction = "created" | "updated" | "deleted" | "reordered";

/**
 * Where this project's plugin-owned data lives, or `null` when the caller has
 * none (test harnesses that only exercise tree semantics).
 *
 * REQUIRED on every op that changes indexed content, deliberately, and NOT an
 * optional callback like `deleteTaskOp.stopTask`. Search indexing has to be
 * part of what the operation DOES, and the only way to make that unforgettable
 * is a parameter the compiler demands — an optional one is a parameter someone
 * omits at one of the two call sites and nothing ever says so.
 *
 * It is the raw path inputs rather than a ready-made db path because one of the
 * two call sites is `src/runtime/routes/tasks.ts`, and the runtime is
 * plugin-agnostic by a grep-verified rule: it may not name a search index. It
 * CAN honestly say where a project's data lives, which is all this is.
 */
export interface ProjectDataPaths {
	dataDir: string;
	dataRoot?: string;
	projectId: string;
}

/**
 * Bring the index in line with a task's current state. `node === null` means
 * the task is gone.
 *
 * Called UNCONDITIONALLY by every content-touching op, including on updates
 * that changed only a status or a colour. Guarding it on "did the title or
 * description change?" would be faster and is exactly the guard someone
 * forgets to extend when a fourth indexed field appears. Unconditional costs
 * one small JSON read plus a hash per document (measured: 3ms for 1200
 * documents) and finds nothing stale, so the op's contract is simply "after
 * this returns, the index reflects the task".
 */
async function syncIndex(
	paths: ProjectDataPaths | null,
	taskId: string,
	node: TaskNode | null,
): Promise<void> {
	if (!paths) return;
	await updateTaskIndex(
		projectIndexDbPath(paths.dataDir, paths.projectId, paths.dataRoot),
		taskId,
		node,
	);
}

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
		dataPaths: ProjectDataPaths | null;
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
	await syncIndex(callbacks.dataPaths, node.id, node);
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
	 * 1:1 agent-branch binding. REST-only in practice — agents do not set their
	 * own branch — but it lives here rather than at the route because it is a
	 * field of the same update: applied at the route it was one more mutation
	 * that outlived a rejected `status` in the same request.
	 */
	branch?: string;
	/**
	 * Plugin-owned opaque metadata. REPLACE semantics — the whole object is
	 * replaced (mirrors tracker.setMetadata), never deep-merged. To update a
	 * single key, the caller reads current metadata and sends the merged object.
	 * `undefined` means "leave existing metadata untouched".
	 */
	metadata?: Record<string, unknown>;
}

/**
 * Every field of `UpdateTaskOpts`, as data — used to answer "did this call ask
 * for anything at all?" and to name the other fields in a refusal.
 *
 * ⚠️ It is pinned to the interface IN BOTH DIRECTIONS by the two lines below,
 * so it cannot become a second list that drifts. `satisfies` rejects a name
 * that is not a field; `_UpdateFieldsAreExhaustive` rejects a field that is
 * not named here. Adding a field to `UpdateTaskOpts` without touching this is
 * a compile error, which is the only version of this that stays true.
 *
 * Deliberately NOT shared with `UNGATED_UPDATE_FIELDS` in orchestrator-tools:
 * that one is a permission list over MCP ARGUMENT names (it has
 * `old_description`, it has no `branch`), this one is the shared op's own
 * fields. Different vocabularies for different layers — and neither can drift
 * silently, because that one is a subtract-list where a new field lands on the
 * gated side and this one is compiler-pinned.
 */
const UPDATE_FIELDS = [
	"status",
	"title",
	"description",
	"draft",
	"parentId",
	"color",
	"branch",
	"metadata",
] as const satisfies readonly (keyof UpdateTaskOpts)[];

type _UpdateFieldsAreExhaustive =
	Exclude<keyof UpdateTaskOpts, (typeof UPDATE_FIELDS)[number]> extends never
		? true
		: ["UPDATE_FIELDS is missing a field of UpdateTaskOpts"];
const _updateFieldsExhaustive: _UpdateFieldsAreExhaustive = true;
void _updateFieldsExhaustive;

/**
 * Name the fields this call asked for besides the one being refused, so the
 * error can answer the question the caller actually has — "what happened to
 * the REST of my update?" — instead of only naming the field it rejected.
 */
function otherFieldsIn(updates: UpdateTaskOpts, except: string): string[] {
	return UPDATE_FIELDS.filter(
		(f) => f !== except && updates[f] !== undefined,
	) as unknown as string[];
}

/** `<reason>` plus what it means for everything else in the same call. */
function refuse(reason: string, updates: UpdateTaskOpts, field: string): never {
	const others = otherFieldsIn(updates, field);
	throw new TaskOperationError(
		others.length === 0
			? reason
			: `${reason} Nothing was applied: ${others.join(", ")} ${others.length === 1 ? "is" : "are"} unchanged too — re-send the whole update without ${field}.`,
	);
}

export async function updateTaskOp(
	tracker: TaskTracker,
	nodeId: string,
	updates: UpdateTaskOpts,
	editedBy: "agent" | "user",
	callbacks: TreeChangeCallbacks & {
		broadcastTree: () => void;
		projectPath: string;
		dataPaths: ProjectDataPaths | null;
	},
): Promise<TaskNode> {
	const node = tracker.get(nodeId);
	if (!node) throw new TaskOperationError(`Task not found: ${nodeId}`);
	if (!isTask(node))
		throw new TaskOperationError(
			`Cannot update non-task node as task: ${nodeId}`,
		);

	// ─────────────────────────────────────────────────────────────────────
	// PHASE 1 — VALIDATE. Nothing has been applied yet, so every throw below
	// leaves the task byte-identical to how the caller found it.
	//
	// This used to be one pass that validated and applied as it went, in
	// function-body order, so a refusal in the middle left the fields ABOVE it
	// applied and the fields BELOW it silently dropped — a partial update whose
	// shape was decided by line numbers, which is not something any caller can
	// see. Worse, no tracker mutator saves; only the `tracker.save()` at the
	// end of this function does. So the applied half lived in memory only and
	// diverged from tree.json until an unrelated operation's save() published
	// it — or a restart evaporated it.
	//
	// The permission gate one layer up (orchestrator-tools) is already atomic:
	// it refuses the whole call before any field lands. This makes the layer
	// below agree with it.
	// ─────────────────────────────────────────────────────────────────────

	const requested = UPDATE_FIELDS.filter((f) => updates[f] !== undefined);
	if (requested.length === 0) {
		// Reporting success for a call that changed nothing is the failure mode
		// this repo keeps paying for: the caller cannot tell "done" from "no-op",
		// so it moves on. Unknown keys are stripped upstream (Zod, and REST body
		// destructuring), which is exactly how a plausible wrong parameter name
		// arrives here as an empty update.
		throw new TaskOperationError(
			`update_task changed nothing: no updatable field was supplied. It accepts: ${UPDATE_FIELDS.join(", ")}.`,
		);
	}

	if (updates.status === "closed") {
		// "closed" and "failed" are lifecycle-terminal states that require
		// cleanup (worktree removal, JSONL clear, task_complete delivery).
		// Allowing them via a plain PATCH bypasses closeTaskOp / done() and
		// leaks worktrees + branches. Force callers through the proper ops.
		refuse(
			'Cannot set status to "closed" via update. Use close_task instead.',
			updates,
			"status",
		);
	}
	if (updates.status === "failed") {
		refuse(
			'Cannot set status to "failed" via update. Status "failed" is set by done("failed") or lifecycle operations.',
			updates,
			"status",
		);
	}
	if (updates.parentId !== undefined) {
		// Ask whether the move is legal before anything else is applied — the
		// same check `reparent` runs, so the wording and the rules cannot drift.
		tracker.assertCanReparent(nodeId, updates.parentId);
	}

	// ─────────────────────────────────────────────────────────────────────
	// PHASE 2 — APPLY. Everything below is known-legal, so no ordering here
	// can produce a partial update. Add new REJECTIONS to phase 1, never here.
	// ─────────────────────────────────────────────────────────────────────

	if (updates.parentId !== undefined) {
		tracker.reparent(nodeId, updates.parentId);
	}
	if (updates.status !== undefined) {
		tracker.updateStatus(nodeId, updates.status, editedBy);
	}
	if (updates.branch !== undefined) {
		tracker.assignBranch(nodeId, updates.branch);
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
	await syncIndex(callbacks.dataPaths, nodeId, tracker.getTask(nodeId) ?? null);
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
		dataPaths: ProjectDataPaths | null;
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
	// The task is gone from the tree — drop its documents now rather than
	// leaving them for the next boot's reconcile to prune.
	await syncIndex(callbacks.dataPaths, nodeId, null);
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

	// The ONLY refused status, and it is a subtraction rather than a whitelist:
	// closing pulls the worktree out from under a live agent. Everything else
	// closes — including draft and pending, which own no worktree, no branch
	// and no session. Close means two things at once ("reclaim the resources"
	// and "take it out of the active pool"); for a resourceless task only the
	// second applies and the first is a NO-OP, not a contradiction. The old
	// verify-or-failed whitelist read that no-op as a reason to refuse, which
	// left draft and pending with NO path to a terminal state at all —
	// update_task rejects `status: "closed"` and points at close_task, and
	// close_task then refused. A superseded draft could only be marked done by
	// writing "[resolved]" into its TITLE, which encodes state in a string
	// that no status filter can see.
	//
	// ⚠️ Do NOT put "stop it first" back into this message. `stopTask` does not
	// touch status — a stopped task stays in_progress precisely so it can
	// resume — so stopping lands the caller back on this same error, and an
	// agent cannot stop a task anyway (there is no stop tool). Nor should this
	// offer `reset_task`: it does unblock the close (→ pending → closable) and
	// it discards the session and the worktree, which is not a trade to hand
	// someone who only wanted to close a task.
	//
	// An error answers one question — what do I do now. Here the answer is
	// "wait", so the message is "wait". Naming the roads that do not work, or
	// the destructive one nobody asked for, is completeness rather than
	// instruction.
	//
	// And this is why close needs NO `stopTask` / `awaitLoopExit` callbacks
	// where `deleteTaskOp` and `resetTaskOp` have both — asked and answered,
	// so nobody has to re-derive it from the asymmetry. Those two operate ON a
	// running task (stop it, then delete/reset it), so they must wait out the
	// launch window in which a loop exists but `node.session` is not set yet.
	// Close REFUSES a running task instead, and the status now covers that same
	// window: a launch flips it to in_progress in the launch lock's own
	// synchronous tick, before the seconds of workspace prep, so there is no
	// instant where an agent is coming up and this check reads something else.
	// Adding awaitLoopExit here would be a second answer to a question that
	// already has one — and it would block a close behind a loop that close is
	// not allowed to stop.
	if (node.status === "in_progress") {
		throw new TaskOperationError(
			"Cannot close a running task — wait for it to finish.",
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
