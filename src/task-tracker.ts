import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TaskNode, TaskStatus } from "./types.ts";
import { ulid } from "./ulid.ts";

/** Shape of a persistent task definition file (.mxd/tasks/<id>.json). */
export interface PersistentTaskDef {
	title: string;
	description: string;
	color?: string;
}

/**
 * Manages the task tree for a project.
 * Each project has one task tree stored as tree.json in the daemon data dir.
 * The root node represents the orchestrator itself. Child tasks are created under it.
 */
export class TaskTracker {
	private nodes: Map<string, TaskNode> = new Map();
	private _rootNodeId!: string;

	constructor(private readonly treePath: string) {}

	/** Load task tree from disk. Creates root node for fresh projects.
	 * @param defaultBranch — branch name for root node (fresh projects, or backfill for old ones).
	 * @param projectPath — repo root path. When provided, scans `.mxd/tasks/` for persistent task definitions.
	 */
	async load(defaultBranch?: string, projectPath?: string): Promise<void> {
		if (existsSync(this.treePath)) {
			const raw = await readFile(this.treePath, "utf-8");
			const data = JSON.parse(raw) as {
				rootNodeId: string;
				nodes: TaskNode[];
			};
			for (const node of data.nodes) {
				// Backfill defaults for fields that became required
				node.costUsd ??= 0;
				node.editedBy ??= "agent";
				// Migrate: undefined → false, true → "reset"
				if (node.persistent === undefined || node.persistent === null) {
					node.persistent = false;
				} else if ((node.persistent as unknown) === true) {
					node.persistent = "reset";
				}
				this.nodes.set(node.id, node);
			}
			this._rootNodeId = data.rootNodeId;
			// Backfill root node branch for old projects
			const root = this.nodes.get(this._rootNodeId);
			if (root && !root.branch && defaultBranch) {
				root.branch = defaultBranch;
			}
		} else {
			// Fresh project — create root node
			this.createRootNode(defaultBranch);
		}

		// Merge persistent task definitions from .mxd/tasks/
		if (projectPath) {
			this.mergePersistentTasks(projectPath);
		}
	}

	/** Persist task tree to disk. Strips runtime-only `session` field.
	 *  For persistent nodes, title/description are NOT written (they live in .mxd/tasks/<id>.json). */
	async save(): Promise<void> {
		const dir = dirname(this.treePath);
		await mkdir(dir, { recursive: true });
		const data = {
			rootNodeId: this._rootNodeId,
			nodes: Array.from(this.nodes.values()).map((node) => {
				const { session: _session, title, description, ...rest } = node;
				if (rest.persistent) {
					// Persistent nodes: strip title/description (source of truth is .mxd/tasks/<id>.json)
					return rest;
				}
				return { ...rest, title, description };
			}),
		};
		await writeFile(this.treePath, JSON.stringify(data, null, "\t"), "utf-8");
	}

	/** Write a persistent node's title/description/color to .mxd/tasks/<id>.json and auto-commit.
	 *  No-op if the node is not persistent. */
	savePersistentDef(nodeId: string, projectPath: string): void {
		const node = this.nodes.get(nodeId);
		if (!node?.persistent) return;

		const tasksDir = join(projectPath, ".mxd", "tasks");
		mkdirSync(tasksDir, { recursive: true });
		const def: PersistentTaskDef = {
			title: node.title,
			description: node.description,
		};
		if (node.color) def.color = node.color;
		const defPath = join(tasksDir, `${nodeId}.json`);
		writeFileSync(defPath, JSON.stringify(def, null, "\t"));
		// Auto-commit so the working tree stays clean for worktree creation
		const addProc = Bun.spawnSync(["git", "add", defPath], {
			cwd: projectPath,
			stdout: "pipe",
			stderr: "pipe",
		});
		if (addProc.exitCode === 0) {
			Bun.spawnSync(
				["git", "commit", "-m", `Update persistent task: ${node.title}`],
				{ cwd: projectPath, stdout: "pipe", stderr: "pipe" },
			);
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
	addTask(
		title: string,
		description: string,
		opts?: {
			budgetUsd?: number;
			draft?: boolean;
			editedBy?: "user" | "agent";
			persistent?: false | "reset" | "continue";
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
			persistent?: false | "reset" | "continue";
			id?: string;
		},
	): TaskNode {
		const parent = this.nodes.get(parentId);
		if (!parent) {
			throw new Error(`Parent node not found: ${parentId}`);
		}
		const child = this.createNode(title, description, parentId, opts);
		parent.children.push(child.id);
		parent.updatedAt = new Date().toISOString();
		return child;
	}

	/** Get all top-level tasks (parentId === null). */
	getTopLevel(): TaskNode[] {
		return Array.from(this.nodes.values()).filter((n) => n.parentId === null);
	}

	/** Update the status of a task node. */
	updateStatus(
		nodeId: string,
		status: TaskStatus,
		editedBy?: "user" | "agent",
	): void {
		const node = this.nodes.get(nodeId);
		if (!node) {
			throw new Error(`Node not found: ${nodeId}`);
		}
		node.status = status;
		if (editedBy) node.editedBy = editedBy;
		node.updatedAt = new Date().toISOString();
	}

	/** Assign session and worktree info to a task node. */
	assignWorktree(nodeId: string, branch: string, worktreePath: string): void {
		const node = this.nodes.get(nodeId);
		if (!node) throw new Error(`Node not found: ${nodeId}`);
		node.branch = branch;
		node.worktreePath = worktreePath;
		node.updatedAt = new Date().toISOString();
	}

	/** Update the title of a task node. */
	updateTitle(
		nodeId: string,
		title: string,
		editedBy?: "user" | "agent",
	): void {
		const node = this.nodes.get(nodeId);
		if (!node) throw new Error(`Node not found: ${nodeId}`);
		node.title = title;
		if (editedBy) node.editedBy = editedBy;
		node.updatedAt = new Date().toISOString();
	}

	/** Update the description of a task node. */
	updateDescription(
		nodeId: string,
		description: string,
		editedBy?: "user" | "agent",
	): void {
		const node = this.nodes.get(nodeId);
		if (!node) throw new Error(`Node not found: ${nodeId}`);
		node.description = description;
		if (editedBy) node.editedBy = editedBy;
		node.updatedAt = new Date().toISOString();
	}

	/** Assign a branch to a task node (1:1 agent-branch binding). */
	assignBranch(nodeId: string, branch: string): void {
		const node = this.nodes.get(nodeId);
		if (!node) {
			throw new Error(`Node not found: ${nodeId}`);
		}
		node.branch = branch;
		node.updatedAt = new Date().toISOString();
	}

	/** Get a node by ID (supports short prefix matching, min 8 chars). */
	get(nodeId: string): TaskNode | undefined {
		// Exact match first
		const exact = this.nodes.get(nodeId);
		if (exact) return exact;

		// Short prefix match (at least 8 chars to avoid ambiguity)
		if (nodeId.length >= 8) {
			let match: TaskNode | undefined;
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

	/** Get all children of a node. */
	getChildren(nodeId: string): TaskNode[] {
		const node = this.nodes.get(nodeId);
		if (!node) return [];
		return node.children
			.map((id) => this.nodes.get(id))
			.filter((n): n is TaskNode => n !== undefined);
	}

	/** Get the full tree as a flat list. */
	allNodes(): TaskNode[] {
		return Array.from(this.nodes.values());
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
		parent.updatedAt = new Date().toISOString();
	}

	/** Move a node to a new parent. Validates no circular dependency. */
	reparent(nodeId: string, newParentId: string): void {
		const node = this.nodes.get(nodeId);
		if (!node) throw new Error(`Node not found: ${nodeId}`);
		const newParent = this.nodes.get(newParentId);
		if (!newParent) throw new Error(`New parent not found: ${newParentId}`);
		if (nodeId === newParentId)
			throw new Error("Cannot reparent a node under itself");

		// Circular check: newParentId must not be a descendant of nodeId
		let current: TaskNode | undefined = newParent;
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

		// Remove from old parent's children list
		if (node.parentId) {
			const oldParent = this.nodes.get(node.parentId);
			if (oldParent) {
				oldParent.children = oldParent.children.filter((id) => id !== nodeId);
				oldParent.updatedAt = new Date().toISOString();
			}
		}

		// Add to new parent's children list
		newParent.children.push(nodeId);
		newParent.updatedAt = new Date().toISOString();
		node.parentId = newParentId;
		node.updatedAt = new Date().toISOString();
	}

	/** Remove a node and all its descendants. */
	remove(nodeId: string): void {
		const node = this.nodes.get(nodeId);
		if (!node) return;

		// Remove from parent's children list
		if (node.parentId) {
			const parent = this.nodes.get(node.parentId);
			if (parent) {
				parent.children = parent.children.filter((id) => id !== nodeId);
				parent.updatedAt = new Date().toISOString();
			}
		}

		// Recursively remove descendants
		for (const childId of node.children) {
			this.remove(childId);
		}

		this.nodes.delete(nodeId);
	}

	/** Accumulate cost on a task node. */
	updateCost(nodeId: string, costUsd: number): void {
		const node = this.get(nodeId);
		if (!node) return;
		node.costUsd += costUsd;
		node.updatedAt = new Date().toISOString();
	}

	/** Get nodes filtered by status. */
	byStatus(status: TaskStatus): TaskNode[] {
		return Array.from(this.nodes.values()).filter((n) => n.status === status);
	}

	/** Update the color label on a task node. */
	updateColor(
		nodeId: string,
		color: string | null,
		editedBy?: "user" | "agent",
	): void {
		const node = this.nodes.get(nodeId);
		if (!node) throw new Error(`Node not found: ${nodeId}`);
		if (color) {
			node.color = color;
		} else {
			delete node.color;
		}
		if (editedBy) node.editedBy = editedBy;
		node.updatedAt = new Date().toISOString();
	}

	/**
	 * Scan `.mxd/tasks/` for persistent task definition files and merge into the tree.
	 * - Existing persistent nodes get title/description refreshed from their json file.
	 * - New json files (no tree entry) create a pending node under root.
	 */
	private mergePersistentTasks(projectPath: string): void {
		const tasksDir = join(projectPath, ".mxd", "tasks");
		if (!existsSync(tasksDir)) return;

		let entries: string[];
		try {
			entries = readdirSync(tasksDir).filter((f) => f.endsWith(".json"));
		} catch {
			return;
		}

		for (const filename of entries) {
			const id = filename.replace(/\.json$/, "");
			let def: PersistentTaskDef;
			try {
				const raw = readFileSync(join(tasksDir, filename), "utf-8");
				def = JSON.parse(raw) as PersistentTaskDef;
			} catch {
				continue; // Skip malformed files
			}

			const existing = this.nodes.get(id);
			if (existing) {
				// Refresh title/description from the definition file
				existing.title = def.title;
				existing.description = def.description;
				if (def.color !== undefined) existing.color = def.color;
			} else {
				// New persistent task — create a pending node under root
				// Default to "reset" for tasks discovered from json files (backward compat with `persistent: true`)
				const now = new Date().toISOString();
				const node: TaskNode = {
					id,
					persistent: "reset",
					title: def.title,
					description: def.description,
					status: "pending",
					branch: null,
					parentId: this._rootNodeId,
					children: [],
					worktreePath: null,
					costUsd: 0,
					editedBy: "agent",
					...(def.color ? { color: def.color } : {}),
					createdAt: now,
					updatedAt: now,
				};
				this.nodes.set(id, node);
				// Add to root's children
				const root = this.nodes.get(this._rootNodeId);
				if (root) {
					root.children.push(id);
				}
			}
		}
	}

	private createNode(
		title: string,
		description: string,
		parentId: string | null,
		opts?: {
			budgetUsd?: number;
			draft?: boolean;
			editedBy?: "user" | "agent";
			persistent?: false | "reset" | "continue";
			id?: string;
		},
	): TaskNode {
		const now = new Date().toISOString();
		const node: TaskNode = {
			id: opts?.id ?? ulid(),
			persistent: opts?.persistent ?? false,
			title,
			description,
			status: opts?.draft ? "draft" : "pending",
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
