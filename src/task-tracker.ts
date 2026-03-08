import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TaskNode, TaskStatus } from "./types.ts";

/**
 * Manages the task tree for a project.
 * Each project has one task tree stored as tree.json in the daemon data dir.
 * The tree represents the hierarchical decomposition of the project goal.
 */
export class TaskTracker {
	private nodes: Map<string, TaskNode> = new Map();
	private rootId: string | null = null;
	private _orchestratorSessionId: string | null = null;

	constructor(private readonly treePath: string) {}

	/** Load task tree from disk. */
	async load(): Promise<void> {
		if (existsSync(this.treePath)) {
			const raw = await readFile(this.treePath, "utf-8");
			const data = JSON.parse(raw) as {
				rootId: string | null;
				nodes: TaskNode[];
				orchestratorSessionId?: string | null;
			};
			this.rootId = data.rootId;
			this._orchestratorSessionId = data.orchestratorSessionId ?? null;
			for (const node of data.nodes) {
				this.nodes.set(node.id, node);
			}
		}
	}

	/** Persist task tree to disk. */
	async save(): Promise<void> {
		const dir = dirname(this.treePath);
		await mkdir(dir, { recursive: true });
		const data = {
			rootId: this.rootId,
			orchestratorSessionId: this._orchestratorSessionId,
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

	/** Create the root task node for the project. */
	createRoot(title: string, description: string): TaskNode {
		if (this.rootId !== null) {
			throw new Error("Root task already exists");
		}
		const node = this.createNode(title, description, null);
		this.rootId = node.id;
		return node;
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

	/** Assign a branch to a task node (1:1 agent-branch binding). */
	assignBranch(nodeId: string, branch: string): void {
		const node = this.nodes.get(nodeId);
		if (!node) {
			throw new Error(`Node not found: ${nodeId}`);
		}
		node.branch = branch;
		node.updatedAt = new Date().toISOString();
	}

	/** Get a node by ID. */
	get(nodeId: string): TaskNode | undefined {
		return this.nodes.get(nodeId);
	}

	/** Get the root node. */
	getRoot(): TaskNode | undefined {
		if (this.rootId === null) return undefined;
		return this.nodes.get(this.rootId);
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

		if (this.rootId === nodeId) {
			this.rootId = null;
		}
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
			createdAt: now,
			updatedAt: now,
		};
		this.nodes.set(node.id, node);
		return node;
	}
}
