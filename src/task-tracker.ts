import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TaskNode, TaskStatus } from "./types.ts";

/**
 * Manages the task tree for a project.
 * Each project has one task tree stored as tree.json in the daemon data dir.
 * The root node represents the orchestrator itself. Child tasks are created under it.
 */
export class TaskTracker {
	private nodes: Map<string, TaskNode> = new Map();
	private _orchestratorSessionId: string | null = null;
	private _autoResume = false;
	private _rootNodeId: string | null = null;

	constructor(private readonly treePath: string) {}

	/** Load task tree from disk. */
	async load(): Promise<void> {
		if (existsSync(this.treePath)) {
			const raw = await readFile(this.treePath, "utf-8");
			const data = JSON.parse(raw) as {
				rootNodeId?: string | null;
				nodes: TaskNode[];
				orchestratorSessionId?: string | null;
				autoResume?: boolean;
			};
			this._orchestratorSessionId = data.orchestratorSessionId ?? null;
			this._autoResume = data.autoResume ?? false;
			this._rootNodeId = data.rootNodeId ?? null;
			for (const node of data.nodes) {
				// Backward compat: old nodes may lack failCount
				if (node.failCount === undefined) node.failCount = 0;
				this.nodes.set(node.id, node);
			}
		}
	}

	/** Persist task tree to disk. */
	async save(): Promise<void> {
		const dir = dirname(this.treePath);
		await mkdir(dir, { recursive: true });
		const data = {
			orchestratorSessionId: this._orchestratorSessionId,
			autoResume: this._autoResume,
			rootNodeId: this._rootNodeId,
			nodes: Array.from(this.nodes.values()),
		};
		await writeFile(this.treePath, JSON.stringify(data, null, "\t"), "utf-8");
	}

	/** Get the orchestrator agent's session ID (for resuming). */
	get orchestratorSessionId(): string | null {
		return this._orchestratorSessionId;
	}

	/** Store the orchestrator agent's session ID. */
	set orchestratorSessionId(id: string | null) {
		this._orchestratorSessionId = id;
	}

	/** Whether this project should auto-resume orchestration on daemon restart. */
	get autoResume(): boolean {
		return this._autoResume;
	}

	set autoResume(value: boolean) {
		this._autoResume = value;
	}

	/** Get the root node ID (the orchestrator's node). */
	get rootNodeId(): string | null {
		return this._rootNodeId;
	}

	/**
	 * Ensure a root node exists for the orchestrator.
	 * If one already exists, returns it. Otherwise creates a new one.
	 * The root node represents the orchestrator itself — all tasks are children of it.
	 * Any existing top-level orphan nodes are re-parented under the root node.
	 */
	ensureRootNode(title: string, description: string): TaskNode {
		if (this._rootNodeId) {
			const existing = this.nodes.get(this._rootNodeId);
			if (existing) return existing;
		}
		// Collect existing top-level nodes before creating root
		const orphans = Array.from(this.nodes.values()).filter(
			(n) => n.parentId === null,
		);
		const node = this.createNode(title, description, null);
		this._rootNodeId = node.id;
		// Re-parent orphan top-level nodes under the new root
		for (const orphan of orphans) {
			orphan.parentId = node.id;
			node.children.push(orphan.id);
		}
		return node;
	}

	/** Create a top-level task (direct child of the project). */
	addTask(
		title: string,
		description: string,
		opts?: { budgetUsd?: number; draft?: boolean },
	): TaskNode {
		return this.createNode(title, description, null, opts);
	}

	/** Add a child task under a parent node. */
	addChild(
		parentId: string,
		title: string,
		description: string,
		opts?: { budgetUsd?: number; draft?: boolean },
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
	updateStatus(nodeId: string, status: TaskStatus): void {
		const node = this.nodes.get(nodeId);
		if (!node) {
			throw new Error(`Node not found: ${nodeId}`);
		}
		node.status = status;
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

	/** Store the agent session ID for later resume. */
	assignSession(nodeId: string, sessionId: string): void {
		const node = this.nodes.get(nodeId);
		if (!node) throw new Error(`Node not found: ${nodeId}`);
		node.sessionId = sessionId;
		node.updatedAt = new Date().toISOString();
	}

	/** Set a message on a task (e.g. instructions when continuing a failed task). */
	setMessage(nodeId: string, message: string): void {
		const node = this.nodes.get(nodeId);
		if (!node) throw new Error(`Node not found: ${nodeId}`);
		node.message = message;
		node.updatedAt = new Date().toISOString();
	}

	/** Update the title of a task node. */
	updateTitle(nodeId: string, title: string): void {
		const node = this.nodes.get(nodeId);
		if (!node) throw new Error(`Node not found: ${nodeId}`);
		node.title = title;
		node.updatedAt = new Date().toISOString();
	}

	/** Update the description of a task node. */
	updateDescription(nodeId: string, description: string): void {
		const node = this.nodes.get(nodeId);
		if (!node) throw new Error(`Node not found: ${nodeId}`);
		node.description = description;
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
		node.costUsd = (node.costUsd ?? 0) + costUsd;
		node.updatedAt = new Date().toISOString();
	}

	/** Get nodes filtered by status. */
	byStatus(status: TaskStatus): TaskNode[] {
		return Array.from(this.nodes.values()).filter((n) => n.status === status);
	}

	/** Update the color label on a task node. */
	updateColor(nodeId: string, color: string | null): void {
		const node = this.nodes.get(nodeId);
		if (!node) throw new Error(`Node not found: ${nodeId}`);
		if (color) {
			node.color = color;
		} else {
			delete node.color;
		}
		node.updatedAt = new Date().toISOString();
	}

	/** Update the draft flag on a task node. */
	updateDraft(nodeId: string, draft: boolean): void {
		const node = this.nodes.get(nodeId);
		if (!node) throw new Error(`Node not found: ${nodeId}`);
		if (draft) {
			node.draft = true;
		} else {
			delete node.draft;
		}
		node.updatedAt = new Date().toISOString();
	}

	private createNode(
		title: string,
		description: string,
		parentId: string | null,
		opts?: { budgetUsd?: number; draft?: boolean },
	): TaskNode {
		const now = new Date().toISOString();
		const node: TaskNode = {
			id: crypto.randomUUID(),
			title,
			description,
			status: "pending",
			branch: null,
			parentId,
			children: [],
			sessionId: null,
			worktreePath: null,
			message: null,
			failCount: 0,
			...(opts?.budgetUsd !== undefined ? { budgetUsd: opts.budgetUsd } : {}),
			...(opts?.draft ? { draft: true } : {}),
			createdAt: now,
			updatedAt: now,
		};
		this.nodes.set(node.id, node);
		return node;
	}
}
