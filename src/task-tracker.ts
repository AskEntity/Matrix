import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
	type GeneralNode,
	isTask,
	type TaskNode,
	type TaskStatus,
	type TreeNode,
} from "./types.ts";
import { ulid } from "./ulid.ts";

/** Options for creating a launchable task node (addTask / addChild / createNode). */
export interface CreateNodeOpts {
	budgetUsd?: number;
	draft?: boolean;
	editedBy?: "user" | "agent";
	id?: string;
	/**
	 * Plugin-owned opaque metadata to attach at creation. Runtime never reads
	 * it — it only round-trips through save()/load(). See BaseTaskNode.metadata.
	 */
	metadata?: Record<string, unknown>;
}

/**
 * Manages the task tree for a project.
 * Each project has one task tree stored as tree.json in the daemon data dir.
 * The root node represents the orchestrator itself. Child tasks are created under it.
 */
export class TaskTracker {
	private nodes: Map<string, TreeNode> = new Map();
	private _rootNodeId!: string;

	constructor(private readonly treePath: string) {}

	/** Load task tree from disk. Creates root node for fresh projects.
	 * @param defaultBranch — branch name for root node (fresh projects, or backfill for old ones).
	 * @returns `true` if this was a fresh project (root node created, no tree.json
	 *   existed) — the caller may seed initial nodes; `false` if an existing
	 *   tree was loaded.
	 */
	async load(defaultBranch?: string): Promise<boolean> {
		if (existsSync(this.treePath)) {
			const raw = await readFile(this.treePath, "utf-8");
			const data = JSON.parse(raw) as {
				rootNodeId: string;
				nodes: Array<Record<string, unknown>>;
			};
			for (const raw of data.nodes) {
				// Discriminator: `type === "task"` → TaskNode; any other string →
				// GeneralNode. Every node must have an explicit `type` — saves
				// always write it (see `createNode` / `addGeneralNode`). A missing
				// `type` means the tree.json predates P3 and was never migrated,
				// or a bug wrote a typeless node — fail loud rather than silently
				// treat it as a general node with `type: undefined`.
				if (raw.type === "task") {
					const node = raw as unknown as TaskNode & {
						persistent?: unknown;
					};
					node.costUsd ??= 0;
					node.editedBy ??= "agent";
					node.cwd ??= null;
					// Migration: strip legacy persistent field
					delete (node as unknown as Record<string, unknown>).persistent;
					// Migrate: "passed" → "verify" (two-phase done() lifecycle)
					if ((node.status as string) === "passed") {
						node.status = "verify";
					}
					this.nodes.set(node.id, node as TaskNode);
				} else if (typeof raw.type === "string") {
					const general: GeneralNode = {
						id: raw.id as string,
						title: raw.title as string,
						parentId: raw.parentId as string | null,
						children: raw.children as string[],
						type: raw.type,
						...(raw.metadata !== undefined
							? { metadata: raw.metadata as Record<string, unknown> }
							: {}),
					};
					this.nodes.set(general.id, general);
				} else {
					throw new Error(
						`tree.json node ${String(raw.id)} is missing 'type' — every node must have an explicit discriminator (expected "task" or a plugin-defined string)`,
					);
				}
			}
			this._rootNodeId = data.rootNodeId;
			// Backfill root node branch for old projects
			const root = this.nodes.get(this._rootNodeId);
			if (root && isTask(root) && !root.branch && defaultBranch) {
				root.branch = defaultBranch;
			}
			return false;
		}
		// Fresh project — create root node
		this.createRootNode(defaultBranch);
		return true;
	}

	/** Persist task tree to disk. Strips runtime-only `session` field.
	 *
	 * Atomic via temp-file + rename: `writeFile` truncates + writes, so a crash
	 * mid-write would leave tree.json empty or half-written — and tree.json is
	 * the single source of truth for task state. Writing to a unique `.tmp`
	 * sibling then renaming gives us all-or-nothing semantics on POSIX
	 * filesystems.
	 *
	 * The temp file uses a per-call random suffix so concurrent saves (tests,
	 * racing broadcasts) don't clobber each other's in-flight temp. If the
	 * rename fails, the caller observes the error and the old tree.json is
	 * still intact.
	 */
	async save(): Promise<void> {
		const dir = dirname(this.treePath);
		await mkdir(dir, { recursive: true });
		const data = {
			rootNodeId: this._rootNodeId,
			nodes: Array.from(this.nodes.values()).map((node) => {
				if (!isTask(node)) return node;
				const { session: _session, ...rest } = node;
				return rest;
			}),
		};
		const tmpName = `.${basename(this.treePath)}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
		const tmpPath = join(dir, tmpName);
		try {
			await writeFile(tmpPath, JSON.stringify(data, null, "\t"), "utf-8");
			await rename(tmpPath, this.treePath);
		} catch (e) {
			// Best-effort cleanup: remove the temp file if the rename failed
			// (so we don't accumulate orphan `.tree.json.tmp.*` files).
			await unlink(tmpPath).catch(() => {});
			throw e;
		}
	}

	/** Root node ID. Always present after load(). */
	get rootNodeId(): string {
		return this._rootNodeId;
	}

	/** Create root node for a fresh project. */
	private createRootNode(branch?: string): void {
		const node = this.createNode("Orchestrator", "", null);
		if (branch) node.branch = branch;
		this._rootNodeId = node.id;
	}

	/** Create a top-level task (direct child of the project). */
	addTask(title: string, description: string, opts?: CreateNodeOpts): TaskNode {
		return this.createNode(title, description, null, opts);
	}

	/**
	 * Add a child task under a parent node.
	 *
	 * `opts.metadata` lets a plugin attach per-node opaque config at creation
	 * (e.g. a chat plugin's character profile). Runtime never reads it.
	 */
	addChild(
		parentId: string,
		title: string,
		description: string,
		opts?: CreateNodeOpts,
	): TaskNode {
		const parent = this.nodes.get(parentId);
		if (!parent) {
			throw new Error(`Parent node not found: ${parentId}`);
		}
		const child = this.createNode(title, description, parentId, opts);
		parent.children.push(child.id);
		if (isTask(parent)) parent.updatedAt = new Date().toISOString();
		return child;
	}

	/** Get all top-level nodes (parentId === null). */
	getTopLevel(): TreeNode[] {
		return Array.from(this.nodes.values()).filter((n) => n.parentId === null);
	}

	/** Update the status of a task node. Rejects general nodes. */
	updateStatus(
		nodeId: string,
		status: TaskStatus,
		editedBy?: "user" | "agent",
	): void {
		const node = this.nodes.get(nodeId);
		if (!node) throw new Error(`Node not found: ${nodeId}`);
		if (!isTask(node))
			throw new Error(`Cannot update status on non-task node: ${nodeId}`);
		node.status = status;
		if (editedBy) node.editedBy = editedBy;
		node.updatedAt = new Date().toISOString();
	}

	/** Assign session and worktree info to a task node. Rejects general nodes. */
	assignWorktree(nodeId: string, branch: string, worktreePath: string): void {
		const node = this.nodes.get(nodeId);
		if (!node) throw new Error(`Node not found: ${nodeId}`);
		if (!isTask(node))
			throw new Error(`Cannot assign worktree to non-task node: ${nodeId}`);
		node.branch = branch;
		node.worktreePath = worktreePath;
		node.updatedAt = new Date().toISOString();
	}

	/** Update the title of a node. Works for both tasks and general nodes. */
	updateTitle(
		nodeId: string,
		title: string,
		editedBy?: "user" | "agent",
	): void {
		const node = this.nodes.get(nodeId);
		if (!node) throw new Error(`Node not found: ${nodeId}`);
		node.title = title;
		if (isTask(node)) {
			if (editedBy) node.editedBy = editedBy;
			node.updatedAt = new Date().toISOString();
		}
	}

	/** Update the description of a task node. Rejects general nodes (they have no description). */
	updateDescription(
		nodeId: string,
		description: string,
		editedBy?: "user" | "agent",
	): void {
		const node = this.nodes.get(nodeId);
		if (!node) throw new Error(`Node not found: ${nodeId}`);
		if (!isTask(node))
			throw new Error(`Cannot update description on non-task node: ${nodeId}`);
		node.description = description;
		if (editedBy) node.editedBy = editedBy;
		node.updatedAt = new Date().toISOString();
	}

	/** Assign a branch to a task node (1:1 agent-branch binding). Rejects general nodes. */
	assignBranch(nodeId: string, branch: string): void {
		const node = this.nodes.get(nodeId);
		if (!node) throw new Error(`Node not found: ${nodeId}`);
		if (!isTask(node))
			throw new Error(`Cannot assign branch to non-task node: ${nodeId}`);
		node.branch = branch;
		node.updatedAt = new Date().toISOString();
	}

	/** Get a node by ID (supports short prefix matching, min 8 chars). */
	get(nodeId: string): TreeNode | undefined {
		// Exact match first
		const exact = this.nodes.get(nodeId);
		if (exact) return exact;

		// Short prefix match (at least 8 chars to avoid ambiguity)
		if (nodeId.length >= 8) {
			let match: TreeNode | undefined;
			for (const [id, node] of this.nodes) {
				if (id.startsWith(nodeId)) {
					if (match) return undefined; // Ambiguous — multiple matches
					match = node;
				}
			}
			return match;
		}
		return undefined;
	}

	/** Get a TASK node by ID. Returns undefined for folders. */
	getTask(nodeId: string): TaskNode | undefined {
		const node = this.get(nodeId);
		return node && isTask(node) ? node : undefined;
	}

	/** Get all children of a node. */
	getChildren(nodeId: string): TreeNode[] {
		const node = this.nodes.get(nodeId);
		if (!node) return [];
		return node.children
			.map((id) => this.nodes.get(id))
			.filter((n): n is TreeNode => n !== undefined);
	}

	/** Get the full tree as a flat list. */
	allNodes(): TreeNode[] {
		return Array.from(this.nodes.values());
	}

	// ── Folder-transparent ownership helpers ──

	/**
	 * Get the "task above" — walk up from nodeId, skip folders, return first real task or root.
	 * This is the logical owner: who delegates to this node, who receives its done().
	 */
	getTaskAbove(nodeId: string): TaskNode | undefined {
		const node = this.get(nodeId);
		if (!node?.parentId) return undefined;
		let current = this.get(node.parentId);
		while (current) {
			if (isTask(current)) return current;
			if (!current.parentId) return undefined;
			current = this.get(current.parentId);
		}
		return undefined;
	}

	/**
	 * Get "tasks below" — direct child tasks, skipping general nodes transparently.
	 * If a child is a general node, recurse into it and collect its task children.
	 */
	getTasksBelow(nodeId: string): TaskNode[] {
		const node = this.get(nodeId);
		if (!node) return [];
		const tasks: TaskNode[] = [];
		for (const childId of node.children) {
			const child = this.get(childId);
			if (!child) continue;
			if (isTask(child)) {
				tasks.push(child);
			} else {
				// Recurse through general node — its tasks are logically owned by us
				tasks.push(...this.getTasksBelow(childId));
			}
		}
		return tasks;
	}

	/**
	 * Add a general (non-launchable) node. General nodes are pure
	 * metadata — no status, no lifecycle, no agent. Runtime has no
	 * opinion on the `type` string; that's the plugin's semantic.
	 */
	addGeneralNode(
		title: string,
		parentId: string | null,
		type: string,
		metadata?: Record<string, unknown>,
	): GeneralNode {
		if (type === "task") {
			throw new Error(
				"GeneralNode.type cannot be 'task' — that's reserved for TaskNode",
			);
		}
		const now = new Date().toISOString();
		const node: GeneralNode = {
			id: ulid(),
			title,
			parentId,
			children: [],
			type,
			...(metadata !== undefined ? { metadata } : {}),
		};
		this.nodes.set(node.id, node);
		if (parentId) {
			const parent = this.nodes.get(parentId);
			if (parent) {
				parent.children.push(node.id);
				if (isTask(parent)) parent.updatedAt = now;
			}
		}
		return node;
	}

	/** Reorder children of a parent node. orderedChildIds must be the same set as current children. */
	reorderChildren(parentId: string, orderedChildIds: string[]): void {
		const parent = this.nodes.get(parentId);
		if (!parent) throw new Error(`Parent node not found: ${parentId}`);

		const currentSet = new Set(parent.children);
		const newSet = new Set(orderedChildIds);

		if (
			currentSet.size !== newSet.size ||
			orderedChildIds.length !== newSet.size
		) {
			throw new Error(
				"orderedChildIds must contain exactly the current children (no duplicates)",
			);
		}
		for (const id of orderedChildIds) {
			if (!currentSet.has(id)) {
				throw new Error(`orderedChildIds contains unknown child: ${id}`);
			}
		}

		parent.children = [...orderedChildIds];
		if (isTask(parent)) parent.updatedAt = new Date().toISOString();
	}

	/** Move a node to a new parent. Validates no circular dependency. Works for both tasks and folders. */
	reparent(nodeId: string, newParentId: string): void {
		const node = this.nodes.get(nodeId);
		if (!node) throw new Error(`Node not found: ${nodeId}`);
		const newParent = this.nodes.get(newParentId);
		if (!newParent) throw new Error(`New parent not found: ${newParentId}`);
		if (nodeId === newParentId)
			throw new Error("Cannot reparent a node under itself");

		// Circular check: newParentId must not be a descendant of nodeId
		let current: TreeNode | undefined = newParent;
		while (current) {
			if (current.parentId === nodeId) {
				throw new Error(
					"Cannot reparent under a descendant (would create cycle)",
				);
			}
			if (!current.parentId) break;
			current = this.nodes.get(current.parentId);
		}

		// Already under the same parent — nothing to do
		if (node.parentId === newParentId) return;

		const now = new Date().toISOString();

		// Remove from old parent's children list
		if (node.parentId) {
			const oldParent = this.nodes.get(node.parentId);
			if (oldParent) {
				oldParent.children = oldParent.children.filter((id) => id !== nodeId);
				if (isTask(oldParent)) oldParent.updatedAt = now;
			}
		}

		// Add to new parent's children list
		newParent.children.push(nodeId);
		if (isTask(newParent)) newParent.updatedAt = now;
		node.parentId = newParentId;
		if (isTask(node)) node.updatedAt = now;
	}

	/** Remove a node and all its descendants. Works for both tasks and folders. */
	remove(nodeId: string): void {
		const node = this.nodes.get(nodeId);
		if (!node) return;

		// Remove from parent's children list
		if (node.parentId) {
			const parent = this.nodes.get(node.parentId);
			if (parent) {
				parent.children = parent.children.filter((id) => id !== nodeId);
				if (isTask(parent)) parent.updatedAt = new Date().toISOString();
			}
		}

		// Recursively remove descendants
		for (const childId of node.children) {
			this.remove(childId);
		}

		this.nodes.delete(nodeId);
	}

	/** Accumulate cost on a task node. Silently ignores general nodes. */
	updateCost(nodeId: string, costUsd: number): void {
		const node = this.get(nodeId);
		if (!node || !isTask(node)) return;
		node.costUsd += costUsd;
		node.updatedAt = new Date().toISOString();
	}

	/** Get task nodes filtered by status (general nodes are excluded). */
	byStatus(status: TaskStatus): TaskNode[] {
		return Array.from(this.nodes.values()).filter(
			(n): n is TaskNode => isTask(n) && n.status === status,
		);
	}

	/** Update the color label on a task node. Rejects general nodes. */
	updateColor(
		nodeId: string,
		color: string | null,
		editedBy?: "user" | "agent",
	): void {
		const node = this.nodes.get(nodeId);
		if (!node) throw new Error(`Node not found: ${nodeId}`);
		if (!isTask(node))
			throw new Error(`Cannot update color on non-task node: ${nodeId}`);
		if (color) {
			node.color = color;
		} else {
			delete node.color;
		}
		if (editedBy) node.editedBy = editedBy;
		node.updatedAt = new Date().toISOString();
	}

	/**
	 * Replace a node's plugin-owned opaque metadata. Works for both task nodes
	 * and general nodes (both carry `metadata`). This is the plugin-safe SET
	 * path — plugins call this instead of mutating tracker-managed nodes
	 * directly. Replaces the entire object; to update a single key, read the
	 * current metadata and spread it. Bumps updatedAt for task nodes.
	 */
	setMetadata(nodeId: string, metadata: Record<string, unknown>): void {
		const node = this.get(nodeId);
		if (!node) throw new Error(`Node not found: ${nodeId}`);
		node.metadata = metadata;
		if (isTask(node)) node.updatedAt = new Date().toISOString();
	}

	private createNode(
		title: string,
		description: string,
		parentId: string | null,
		opts?: CreateNodeOpts,
	): TaskNode {
		const now = new Date().toISOString();
		const status = opts?.draft ? "draft" : "pending";
		const node: TaskNode = {
			id: opts?.id ?? ulid(),
			title,
			description,
			status,
			branch: null,
			parentId,
			children: [],
			worktreePath: null,
			cwd: null,
			costUsd: 0,
			editedBy: opts?.editedBy ?? "agent",
			...(opts?.budgetUsd !== undefined ? { budgetUsd: opts.budgetUsd } : {}),
			...(opts?.metadata !== undefined ? { metadata: opts.metadata } : {}),
			createdAt: now,
			updatedAt: now,
			type: "task",
		};
		this.nodes.set(node.id, node);
		return node;
	}
}
