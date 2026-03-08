import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentProvider, AgentRequest } from "./agent-provider.ts";
import type { TaskTracker } from "./task-tracker.ts";
import type { AgentResult, TaskNode } from "./types.ts";
import type { WorktreeManager } from "./worktree-manager.ts";

export { METHODOLOGY_PROMPT } from "./orchestrator.ts";

/**
 * Event emitted by the Runner during execution.
 * Consumers can use these to build SSE streams or update UI.
 */
export type RunnerEvent =
	| { type: "task_started"; taskId: string; title: string }
	| { type: "task_completed"; taskId: string; title: string; success: boolean }
	| { type: "children_spawned"; parentId: string; childIds: string[] }
	| { type: "merge_started"; taskId: string; title: string }
	| { type: "merge_completed"; taskId: string; success: boolean }
	| { type: "error"; taskId: string; message: string };

/** Result of a full runner execution. */
export interface RunnerResult {
	completed: number;
	failed: number;
	results: {
		taskId: string;
		title: string;
		success: boolean;
		output: string;
	}[];
}

const METHODOLOGY_PROMPT = `You are an autonomous programming system. You work by actually executing code, not guessing.

## Workflow

For each feature:
1. Ask architecture questions first: which module? New module needed? Existing mechanism to reuse?
2. Write type definitions
3. Write tests (describe expected behavior)
4. Write implementation (simplest way to satisfy tests)
5. Run tests + typecheck + lint, all must pass
6. Review diff: unnecessary abstractions? Duplicate code?
7. Commit

## Test Principles

- Determinism by construction: use condition-wait not fixed delays
- Each test is self-contained: independent setup/teardown
- Test failure = bug in code, not bad luck
- Debug: add logs → see what actually happened → trust logs → fix

## Architecture Principles

- Before adding a feature, consider where it belongs — don't create unnecessary new files
- Three repetitions of similar code before abstracting
- Each module has a single responsibility, communicates via events/interfaces
- Pure functions first, isolate side effects to boundaries

## Prohibitions

- Never guess APIs — read docs or run --help first
- Never say "this should work" — run it and see
- Never blame the framework — suspect your own code first
- Never keep old-system fallbacks when replacing
- Never fix flaky tests with retries — find root cause
- Never guess bug causes without logs
- Never create helper functions for one-time operations`;

/**
 * Runner: agent-driven task execution with worktree isolation.
 *
 * Unlike the old Orchestrator (deterministic loop, sequential),
 * the Runner:
 * - Assigns each task a git worktree on a dedicated branch
 * - Executes sibling tasks in parallel
 * - Resumes parent agents after children complete
 * - Merges child branches into parent branch when all pass
 */
export class Runner {
	private events: RunnerEvent[] = [];
	private onEvent?: (event: RunnerEvent) => void;

	constructor(
		private readonly tracker: TaskTracker,
		private readonly provider: AgentProvider,
		private readonly worktrees: WorktreeManager,
		private readonly projectPath: string,
		options?: { onEvent?: (event: RunnerEvent) => void },
	) {
		this.onEvent = options?.onEvent;
	}

	/** Get all events emitted during execution. */
	getEvents(): RunnerEvent[] {
		return [...this.events];
	}

	/**
	 * Execute a single task: create worktree, run agent, update status.
	 * The agent runs in the task's worktree directory.
	 */
	async executeTask(node: TaskNode): Promise<AgentResult> {
		this.emit({ type: "task_started", taskId: node.id, title: node.title });

		// Create worktree for this task
		const slug = this.slugify(node.title);
		const parentNode = node.parentId
			? this.tracker.get(node.parentId)
			: undefined;
		const baseBranch = parentNode?.branch ?? undefined;

		const wt = await this.worktrees.create(node.id, slug, baseBranch);
		this.tracker.assignWorktree(node.id, wt.branch, wt.path);
		this.tracker.updateStatus(node.id, "in_progress");
		await this.tracker.save();

		const memory = this.readMemory();
		const prompt = this.buildPrompt(node, memory);

		const request: AgentRequest = {
			prompt,
			cwd: wt.path,
			systemPrompt: METHODOLOGY_PROMPT,
			maxTurns: 30,
			resumeSessionId: node.sessionId ?? undefined,
		};

		try {
			const result = await this.provider.execute(request);

			// Store session ID for potential resume
			if (result.sessionId) {
				this.tracker.assignSession(node.id, result.sessionId);
			}

			const newStatus = result.success ? "passed" : "failed";
			this.tracker.updateStatus(node.id, newStatus);
			await this.tracker.save();

			this.emit({
				type: "task_completed",
				taskId: node.id,
				title: node.title,
				success: result.success,
			});

			return result;
		} catch (e) {
			this.tracker.updateStatus(node.id, "stuck");
			await this.tracker.save();

			const message = e instanceof Error ? e.message : "Unknown error";
			this.emit({ type: "error", taskId: node.id, message });

			return { success: false, output: `Runner error: ${message}` };
		}
	}

	/**
	 * Execute all leaf children of a parent in parallel.
	 * Returns when all children have completed.
	 */
	async executeChildren(parentId: string): Promise<AgentResult[]> {
		const children = this.tracker.getChildren(parentId);
		const pending = children.filter((c) => c.status === "pending");

		if (pending.length === 0) return [];

		this.emit({
			type: "children_spawned",
			parentId,
			childIds: pending.map((c) => c.id),
		});

		// Execute all pending children in parallel
		const results = await Promise.all(
			pending.map((child) => this.executeTask(child)),
		);

		return results;
	}

	/**
	 * Merge all completed children's branches into the parent's branch.
	 * Returns true if all merges succeeded.
	 */
	async mergeChildren(parentId: string): Promise<boolean> {
		const parent = this.tracker.get(parentId);
		if (!parent?.branch) return false;

		this.emit({
			type: "merge_started",
			taskId: parentId,
			title: parent.title,
		});

		const children = this.tracker.getChildren(parentId);
		const passed = children.filter((c) => c.status === "passed");

		let allMerged = true;
		for (const child of passed) {
			const slug = this.slugify(child.title);
			const success = await this.worktrees.merge(child.id, slug, parent.branch);
			if (!success) {
				allMerged = false;
				this.emit({
					type: "error",
					taskId: child.id,
					message: `Merge conflict: ${child.title} into ${parent.title}`,
				});
			}
		}

		this.emit({
			type: "merge_completed",
			taskId: parentId,
			success: allMerged,
		});

		return allMerged;
	}

	/**
	 * Run the full tree: execute leaf tasks, merge into parents, repeat.
	 * This is a breadth-first, bottom-up execution.
	 */
	async run(): Promise<RunnerResult> {
		const allResults: {
			taskId: string;
			title: string;
			success: boolean;
			output: string;
		}[] = [];

		const root = this.tracker.getRoot();
		if (!root) {
			return { completed: 0, failed: 0, results: [] };
		}

		// Execute the tree bottom-up
		await this.runNode(root, allResults);

		return {
			completed: allResults.filter((r) => r.success).length,
			failed: allResults.filter((r) => !r.success).length,
			results: allResults,
		};
	}

	/**
	 * Resume a parent agent after all its children have completed.
	 * The parent agent receives a merge prompt with child branch info.
	 */
	async resumeParent(node: TaskNode): Promise<AgentResult> {
		this.emit({
			type: "merge_started",
			taskId: node.id,
			title: node.title,
		});

		const children = this.tracker.getChildren(node.id);
		const passed = children.filter((c) => c.status === "passed");
		const failed = children.filter(
			(c) => c.status === "failed" || c.status === "stuck",
		);

		const prompt = this.buildMergePrompt(node, passed, failed);

		const request: AgentRequest = {
			prompt,
			cwd: node.worktreePath ?? this.projectPath,
			systemPrompt: METHODOLOGY_PROMPT,
			maxTurns: 20,
			resumeSessionId: node.sessionId ?? undefined,
		};

		try {
			const result = await this.provider.execute(request);

			if (result.sessionId) {
				this.tracker.assignSession(node.id, result.sessionId);
			}

			const newStatus = result.success ? "passed" : "failed";
			this.tracker.updateStatus(node.id, newStatus);
			await this.tracker.save();

			this.emit({
				type: "merge_completed",
				taskId: node.id,
				success: result.success,
			});

			return result;
		} catch (e) {
			this.tracker.updateStatus(node.id, "stuck");
			await this.tracker.save();

			const message = e instanceof Error ? e.message : "Unknown error";
			this.emit({ type: "error", taskId: node.id, message });
			return { success: false, output: `Merge error: ${message}` };
		}
	}

	/** Recursively execute a node: children first (parallel), then self. */
	private async runNode(
		node: TaskNode,
		results: {
			taskId: string;
			title: string;
			success: boolean;
			output: string;
		}[],
	): Promise<void> {
		const children = this.tracker.getChildren(node.id);
		const pendingChildren = children.filter((c) => c.status === "pending");

		if (pendingChildren.length > 0) {
			// Parent needs a worktree so children can branch from it
			if (!node.worktreePath) {
				const slug = this.slugify(node.title);
				const parentNode = node.parentId
					? this.tracker.get(node.parentId)
					: undefined;
				const baseBranch = parentNode?.branch ?? undefined;
				const wt = await this.worktrees.create(node.id, slug, baseBranch);
				this.tracker.assignWorktree(node.id, wt.branch, wt.path);
				this.tracker.updateStatus(node.id, "in_progress");
				await this.tracker.save();
			}

			// Recursively process any children that have their own children
			for (const child of pendingChildren) {
				const grandchildren = this.tracker.getChildren(child.id);
				if (grandchildren.length > 0) {
					await this.runNode(child, results);
				}
			}

			// Execute remaining leaf children in parallel
			const leafChildren = pendingChildren.filter((c) => {
				const current = this.tracker.get(c.id);
				return current?.status === "pending";
			});

			if (leafChildren.length > 0) {
				const childResults = await Promise.all(
					leafChildren.map((child) => this.executeTask(child)),
				);

				for (let i = 0; i < leafChildren.length; i++) {
					const child = leafChildren[i];
					const result = childResults[i];
					if (child && result) {
						results.push({
							taskId: child.id,
							title: child.title,
							success: result.success,
							output: result.output,
						});
					}
				}
			}

			// All children done — resume parent to merge
			const allChildrenPassed = children.every((c) => {
				const current = this.tracker.get(c.id);
				return current?.status === "passed";
			});

			if (allChildrenPassed) {
				const mergeResult = await this.resumeParent(node);
				results.push({
					taskId: node.id,
					title: node.title,
					success: mergeResult.success,
					output: mergeResult.output,
				});
			} else {
				// Some children failed — mark parent as failed too
				this.tracker.updateStatus(node.id, "failed");
				await this.tracker.save();
				results.push({
					taskId: node.id,
					title: node.title,
					success: false,
					output: "Some child tasks failed",
				});
			}
		} else {
			// Leaf node — execute directly
			const current = this.tracker.get(node.id);
			if (current?.status === "pending") {
				const result = await this.executeTask(node);
				results.push({
					taskId: node.id,
					title: node.title,
					success: result.success,
					output: result.output,
				});
			}
		}
	}

	private buildMergePrompt(
		node: TaskNode,
		passed: TaskNode[],
		failed: TaskNode[],
	): string {
		const parts: string[] = [];

		parts.push(`# Merge: ${node.title}`);
		parts.push(
			"All child tasks have completed. Merge their work into this branch.",
		);
		parts.push("");
		parts.push("## Completed children:");
		for (const child of passed) {
			parts.push(`- ${child.title} (branch: ${child.branch})`);
		}
		if (failed.length > 0) {
			parts.push("\n## Failed children:");
			for (const child of failed) {
				parts.push(`- ${child.title} (${child.status})`);
			}
		}
		parts.push("");
		parts.push("## Instructions");
		parts.push(
			"Merge each child branch into the current branch using `git merge`.",
		);
		parts.push(
			"Resolve any conflicts. Run tests to verify the merged code works.",
		);
		parts.push("Commit the merge when everything passes.");

		return parts.join("\n");
	}

	private emit(event: RunnerEvent): void {
		this.events.push(event);
		this.onEvent?.(event);
	}

	private readMemory(): string {
		try {
			return readFileSync(join(this.projectPath, ".ai", "memory.md"), "utf-8");
		} catch {
			return "";
		}
	}

	private buildPrompt(node: TaskNode, memory: string): string {
		const parts: string[] = [];

		if (memory) {
			parts.push("## Project Memory", memory, "");
		}

		parts.push(`# Task: ${node.title}`);
		if (node.description) {
			parts.push(node.description);
		}

		if (node.parentId) {
			const siblings = this.tracker.getChildren(node.parentId);
			const done = siblings.filter((s) => s.status === "passed");
			if (done.length > 0) {
				parts.push(
					"\n## Already completed siblings:",
					...done.map((s) => `- ${s.title} (passed)`),
				);
			}
		}

		parts.push(
			"\n## Instructions",
			"Implement this task fully: types → tests → implementation → all checks passing.",
			"Run `bun test`, `bun run typecheck`, and `bun run check` before considering the task done.",
			"Commit your work when all checks pass.",
		);

		return parts.join("\n");
	}

	private slugify(title: string): string {
		return title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 30);
	}
}
