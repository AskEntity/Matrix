import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	type FolderNode,
	type TaskNode,
	type TaskStatus,
	type TreeNode,
	isFolder,
	isTask,
} from "./types.ts";
import { ulid } from "./ulid.ts";

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
	 * @param defaultBranch — branch name for root node (fresh projects, or backfill for old ones).
	 */
	async load(defaultBranch?: string): Promise<void> {
		if (existsSync(this.treePath)) {
			const raw = await readFile(this.treePath, "utf-8");
			const data = JSON.parse(raw) as {
				rootNodeId: string;
				nodes: Array<Record<string, unknown>>;
			};
			for (const raw of data.nodes) {
				if (raw.type === "folder") {
					// Folder node — minimal fields only
					const folder: FolderNode = {
						id: raw.id as string,
						title: raw.title as string,
						parentId: raw.parentId as string | null,
						children: raw.children as string[],
						type: "folder",
					};
					this.nodes.set(folder.id, folder);
				} else {
					// Task node — full fields with migrations
					const node = raw as unknown as TaskNode & {
						persistent?: unknown;
					};
					node.costUsd ??= 0;
					node.editedBy ??= "agent";
					// Migration: strip legacy persistent field
					delete (node as unknown as Record<string, unknown>).persistent;
					// Migrate: "passed" → "verify" (two-phase done() lifecycle)
					if ((node.status as string) === "passed") {
						node.status = "verify";
					}
					this.nodes.set(node.id, node as TaskNode);
				}
			}
			this._rootNodeId = data.rootNodeId;
			// Backfill root node branch for old projects
			const root = this.nodes.get(this._rootNodeId);
			if (root && isTask(root) && !root.branch && defaultBranch) {
				root.branch = defaultBranch;
			}
		} else {
			// Fresh project — create root node
			this.createRootNode(defaultBranch);
		}
	}

	/** Persist task tree to disk. Strips runtime-only `session` field. */
	async save(): Promise<void> {
		const dir = dirname(this.treePath);
		await mkdir(dir, { recursive: true });
		const data = {
			rootNodeId: this._rootNodeId,
			nodes: Array.from(this.nodes.values()).map((node) => {
				if (isFolder(node)) return node;
				const { session: _session, ...rest } = node;
				return rest;
			}),
		};
		await writeFile(this.treePath, JSON.stringify(data, null, "\t"), "utf-8");
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
	addTask(
		title: string,
		description: string,
		opts?: {
			budgetUsd?: number;
			draft?: boolean;
			editedBy?: "user" | "agent";
			id?: string;
		},
	): TaskNode {
		return this.createNode(title, description, null, opts);
	}

	/** Add a child task under a parent node. */
	addChild(
		parentId: string,
		title: string,
		description: string,
		opts?: {
			budgetUsd?: number;
			draft?: boolean;
			editedBy?: "user" | "agent";
			id?: string;
		},
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

	/** Update the status of a task node. Rejects folders. */
	updateStatus(
		nodeId: string,
		status: TaskStatus,
		editedBy?: "user" | "agent",
	): void {
		const node = this.nodes.get(nodeId);
		if (!node) throw new Error(`Node not found: ${nodeId}`);
		if (isFolder(node)) throw new Error(`Cannot update status on folder: ${nodeId}`);
		node.status = status;
		if (editedBy) node.editedBy = editedBy;
		node.updatedAt = new Date().toISOString();
	}

	/** Assign session and worktree info to a task node. Rejects folders. */
	assignWorktree(nodeId: string, branch: string, worktreePath: string): void {
		const node = this.nodes.get(nodeId);
		if (!node) throw new Error(`Node not found: ${nodeId}`);
		if (isFolder(node)) throw new Error(`Cannot assign worktree to folder: ${nodeId}`);
		node.branch = branch;
		node.worktreePath = worktreePath;
		node.updatedAt = new Date().toISOString();
	}

	/** Update the title of a node. Works for both tasks and folders. */
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

	/** Update the description of a task node. Rejects folders (they have no description). */
	updateDescription(
		nodeId: string,
		description: string,
		editedBy?: "user" | "agent",
	): void {
		const node = this.nodes.get(nodeId);
		if (!node) throw new Error(`Node not found: ${nodeId}`);
		if (isFolder(node)) throw new Error(`Cannot update description on folder: ${nodeId}`);
		node.description = description;
		if (editedBy) node.editedBy = editedBy;
		node.updatedAt = new Date().toISOString();
	}

	/** Assign a branch to a task node (1:1 agent-branch binding). Rejects folders. */
	assignBranch(nodeId: string, branch: string): void {
		const node = this.nodes.get(nodeId);
		if (!node) throw new Error(`Node not found: ${nodeId}`);
		if (isFolder(node)) throw new Error(`Cannot assign branch to folder: ${nodeId}`);
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
		if (!node || !node.parentId) return undefined;
		let current = this.get(node.parentId);
		while (current) {
			if (isTask(current)) return current;
			if (!current.parentId) return undefined;
			current = this.get(current.parentId);
		}
		return undefined;
	}

	/**
	 * Get "tasks below" — direct child tasks, skipping folders transparently.
	 * If a child is a folder, recurse into it and collect its task children.
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
			} else if (isFolder(child)) {
				// Recurse through folder — its tasks are logically owned by us
				tasks.push(...this.getTasksBelow(childId));
			}
		}
		return tasks;
	}

	/** Add a folder node. Folders are pure grouping — no status, no lifecycle. */
	addFolder(
		title: string,
		parentId: string | null,
	): FolderNode {
		const now = new Date().toISOString();
		const folder: FolderNode = {
			id: ulid(),
			title,
			parentId,
			children: [],
			type: "folder",
		};
		this.nodes.set(folder.id, folder);
		if (parentId) {
			const parent = this.nodes.get(parentId);
			if (parent) {
				parent.children.push(folder.id);
				if (isTask(parent)) parent.updatedAt = now;
			}
		}
		return folder;
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

	/** Accumulate cost on a task node. Silently ignores folders. */
	updateCost(nodeId: string, costUsd: number): void {
		const node = this.get(nodeId);
		if (!node || isFolder(node)) return;
		node.costUsd += costUsd;
		node.updatedAt = new Date().toISOString();
	}

	/** Get task nodes filtered by status (folders are excluded). */
	byStatus(status: TaskStatus): TaskNode[] {
		return Array.from(this.nodes.values()).filter(
			(n): n is TaskNode => isTask(n) && n.status === status,
		);
	}

	/** Update the color label on a task node. Rejects folders. */
	updateColor(
		nodeId: string,
		color: string | null,
		editedBy?: "user" | "agent",
	): void {
		const node = this.nodes.get(nodeId);
		if (!node) throw new Error(`Node not found: ${nodeId}`);
		if (isFolder(node)) throw new Error(`Cannot update color on folder: ${nodeId}`);
		if (color) {
			node.color = color;
		} else {
			delete node.color;
		}
		if (editedBy) node.editedBy = editedBy;
		node.updatedAt = new Date().toISOString();
	}

	private createNode(
		title: string,
		description: string,
		parentId: string | null,
		opts?: {
			budgetUsd?: number;
			draft?: boolean;
			editedBy?: "user" | "agent";
			id?: string;
		},
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
			costUsd: 0,
			editedBy: opts?.editedBy ?? "agent",
			...(opts?.budgetUsd !== undefined ? { budgetUsd: opts.budgetUsd } : {}),
			createdAt: now,
			updatedAt: now,
		};
		this.nodes.set(node.id, node);
		return node;
	}
}
