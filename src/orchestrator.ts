import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentProvider, AgentRequest } from "./agent-provider.ts";
import type { TaskTracker } from "./task-tracker.ts";
import type { AgentResult, TaskNode } from "./types.ts";

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

/** Result of executing a single task step. */
export interface OrchestratorStepResult {
	node: TaskNode;
	agentResult: AgentResult;
}

/**
 * Orchestrator ties together TaskTracker + AgentProvider.
 * It picks pending tasks, spawns agents, and updates status based on results.
 */
export class Orchestrator {
	constructor(
		private readonly tracker: TaskTracker,
		private readonly provider: AgentProvider,
		private readonly projectPath: string,
	) {}

	/** Pick the next pending task and execute it. Returns null if nothing to do. */
	async step(): Promise<OrchestratorStepResult | null> {
		const pending = this.tracker.byStatus("pending");
		if (pending.length === 0) return null;

		// Pick the first pending task that has no pending children
		// (leaf-first execution: children before parents)
		const target = this.pickNext(pending);
		if (!target) return null;

		// Mark as in_progress
		this.tracker.updateStatus(target.id, "in_progress");
		await this.tracker.save();

		// Read project memory for context survival
		const memory = this.readMemory();

		// Build the prompt from task context
		const prompt = this.buildPrompt(target, memory);

		// Execute
		const request: AgentRequest = {
			prompt,
			cwd: this.projectPath,
			systemPrompt: METHODOLOGY_PROMPT,
			maxTurns: 30,
		};

		try {
			const result = await this.provider.execute(request);

			// Update status based on result
			const newStatus = result.success ? "passed" : "failed";
			this.tracker.updateStatus(target.id, newStatus);
			await this.tracker.save();

			// target is still valid — we just updated it via updateStatus
			return { node: target, agentResult: result };
		} catch (e) {
			// Unexpected error — mark as stuck
			this.tracker.updateStatus(target.id, "stuck");
			await this.tracker.save();

			const message = e instanceof Error ? e.message : "Unknown error";
			return {
				node: target,
				agentResult: {
					success: false,
					output: `Orchestrator error: ${message}`,
				},
			};
		}
	}

	/**
	 * Run the orchestrator loop: keep executing pending tasks until
	 * there are no more actionable tasks.
	 */
	async run(): Promise<OrchestratorStepResult[]> {
		const results: OrchestratorStepResult[] = [];

		let step = await this.step();
		while (step !== null) {
			results.push(step);

			// If the task failed, don't keep going — let the caller decide
			if (!step.agentResult.success) break;

			step = await this.step();
		}

		return results;
	}

	/** Pick the best next task to execute from pending tasks. */
	private pickNext(pending: TaskNode[]): TaskNode | undefined {
		// Prefer leaf nodes (no pending children) — depth-first execution
		for (const node of pending) {
			const children = this.tracker.getChildren(node.id);
			const hasPendingChildren = children.some(
				(c) => c.status === "pending" || c.status === "in_progress",
			);
			if (!hasPendingChildren) {
				return node;
			}
		}
		// If all pending nodes have pending children, pick the deepest leaf
		return pending[0];
	}

	/** Read .opengraft/memory.md from the project directory. Returns empty string if not found. */
	private readMemory(): string {
		try {
			return readFileSync(
				join(this.projectPath, ".opengraft", "memory.md"),
				"utf-8",
			);
		} catch {
			return "";
		}
	}

	/** Build the agent prompt from task context. */
	private buildPrompt(node: TaskNode, memory: string): string {
		const parts: string[] = [];

		// Project memory — accumulated knowledge from previous sessions
		if (memory) {
			parts.push("## Project Memory", memory, "");
		}

		// Task description
		parts.push(`# Task: ${node.title}`);
		if (node.description) {
			parts.push(node.description);
		}

		// Sibling context — what's already done
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
}

/** Export the methodology prompt for testing/inspection. */
export { METHODOLOGY_PROMPT };
