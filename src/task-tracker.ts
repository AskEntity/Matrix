import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TaskNode, TaskStatus } from "./types.ts";

/**
 * Manages the task tree for a project.
 * Each project has one task tree stored as tree.json in the daemon data dir.
 * Tasks with parentId === null are top-level (direct children of the project).
 * The project itself (main branch) is the implicit root.
 */
export class TaskTracker {
	private nodes: Map<string, TaskNode> = new Map();
	private _orchestratorSessionId: string | null = null;
	private _autoResume = false;

	constructor(private readonly treePath: string) {}

	/** Load task tree from disk. */
	async load(): Promise<void> {
		if (existsSync(this.treePath)) {
			const raw = await readFile(this.treePath, "utf-8");
			const data = JSON.parse(raw) as {
				rootId?: string | null;
				nodes: TaskNode[];
				orchestratorSessionId?: string | null;
				autoResume?: boolean;
			};
			this._orchestratorSessionId = data.orchestratorSessionId ?? null;
			this._autoResume = data.autoResume ?? false;
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

	/** Create a top-level task (direct child of the project). */
	addTask(title: string, description: string): TaskNode {
		return this.createNode(title, description, null);
	}

	/** Add a child task under a parent node. */
	addChild(parentId: string, title: string, description: string): TaskNode {
		const parent = this.nodes.get(parentId);
		if (!parent) {
			throw new Error(`Parent node not found: ${parentId}`);
		}
		const child = this.createNode(title, description, parentId);
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

	/** Set the cost in USD for a task's agent execution. */
	setCost(nodeId: string, costUsd: number): void {
		const node = this.nodes.get(nodeId);
		if (!node) throw new Error(`Node not found: ${nodeId}`);
		node.costUsd = costUsd;
		node.updatedAt = new Date().toISOString();
	}

	/** Set a message on a task (e.g. instructions when continuing a failed task). */
	setMessage(nodeId: string, message: string): void {
		const node = this.nodes.get(nodeId);
		if (!node) throw new Error(`Node not found: ${nodeId}`);
		node.message = message;
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

	/** Get nodes filtered by status. */
	byStatus(status: TaskStatus): TaskNode[] {
		return Array.from(this.nodes.values()).filter((n) => n.status === status);
	}

	private createNode(
		title: string,
		description: string,
		parentId: string | null,
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
			createdAt: now,
			updatedAt: now,
		};
		this.nodes.set(node.id, node);
		return node;
	}
}
