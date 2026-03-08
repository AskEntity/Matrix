import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AgentProvider, AgentRequest } from "./agent-provider.ts";
import type { TaskTracker } from "./task-tracker.ts";
import type { WorktreeManager } from "./worktree-manager.ts";

const TASK_SYSTEM_PROMPT = `You are an autonomous programming agent working on a subtask.

## Workflow
1. Read the task description carefully
2. Explore the codebase to understand the relevant modules
3. Write types → tests → implementation
4. Run tests + typecheck + lint, all must pass
5. Commit your work when done

## Rules
- Work only on the files/modules described in your task
- Do NOT modify files outside your scope — sibling tasks work on other modules in parallel
- Run \`bun test\`, \`bun run typecheck\`, and \`bun run check\` before considering done
- Commit when all checks pass`;

export interface OrchestratorToolsDeps {
	tracker: TaskTracker;
	provider: AgentProvider;
	worktrees: WorktreeManager;
	projectPath: string;
}

/**
 * Create an MCP server with OpenGraft orchestrator tools.
 * These tools let the main agent observe and manipulate the task tree,
 * and spawn child agents on isolated worktrees.
 */
export function createOrchestratorTools(deps: OrchestratorToolsDeps) {
	const { tracker, provider, worktrees, projectPath } = deps;

	return createSdkMcpServer({
		name: "opengraft",
		version: "0.1.0",
		tools: [
			tool(
				"get_tree",
				"Get the current task tree. Returns all nodes with their status, branch, and hierarchy.",
				{ format: z.enum(["flat", "tree"]).optional().default("flat") },
				async () => {
					const root = tracker.getRoot();
					const nodes = tracker.allNodes();
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({ root: root ?? null, nodes }, null, 2),
							},
						],
					};
				},
			),

			tool(
				"create_task",
				"Create a new task in the tree. If parentId is provided, creates a child task. Otherwise creates the root task. " +
					"IMPORTANT: Sibling tasks will run in PARALLEL on separate branches. " +
					"Each sibling must work on DIFFERENT files/modules to avoid merge conflicts.",
				{
					title: z.string().describe("Short title for the task"),
					description: z
						.string()
						.describe(
							"Detailed description of what the task should accomplish",
						),
					parentId: z
						.string()
						.optional()
						.describe("Parent task ID. Omit to create root task."),
				},
				async (args) => {
					try {
						const node = args.parentId
							? tracker.addChild(args.parentId, args.title, args.description)
							: tracker.createRoot(args.title, args.description);
						await tracker.save();
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify(node, null, 2),
								},
							],
						};
					} catch (e) {
						const message = e instanceof Error ? e.message : "Unknown error";
						return {
							content: [{ type: "text" as const, text: `Error: ${message}` }],
							isError: true,
						};
					}
				},
			),

			tool(
				"update_task_status",
				"Update the status of a task node. Valid statuses: pending, in_progress, testing, passed, failed, stuck.",
				{
					taskId: z.string().describe("Task node ID"),
					status: z
						.enum([
							"pending",
							"in_progress",
							"testing",
							"passed",
							"failed",
							"stuck",
						])
						.describe("New status"),
				},
				async (args) => {
					try {
						tracker.updateStatus(args.taskId, args.status);
						await tracker.save();
						const node = tracker.get(args.taskId);
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify(node, null, 2),
								},
							],
						};
					} catch (e) {
						const message = e instanceof Error ? e.message : "Unknown error";
						return {
							content: [{ type: "text" as const, text: `Error: ${message}` }],
							isError: true,
						};
					}
				},
			),

			tool(
				"spawn_task",
				"Spawn a child agent to execute a task on an isolated git worktree. " +
					"Creates a worktree, runs the agent, waits for completion, and returns the result. " +
					"The agent works in its own branch and directory. " +
					"Call this for multiple tasks simultaneously — they will run in parallel.",
				{
					taskId: z.string().describe("ID of the task to execute"),
				},
				async (args) => {
					const node = tracker.get(args.taskId);
					if (!node) {
						return {
							content: [
								{ type: "text" as const, text: "Error: Task not found" },
							],
							isError: true,
						};
					}

					if (node.status !== "pending") {
						return {
							content: [
								{
									type: "text" as const,
									text: `Error: Task is ${node.status}, not pending`,
								},
							],
							isError: true,
						};
					}

					try {
						// Create worktree
						const slug = slugify(node.title);
						const parentNode = node.parentId
							? tracker.get(node.parentId)
							: undefined;
						const baseBranch = parentNode?.branch ?? undefined;

						const wt = await worktrees.create(node.id, slug, baseBranch);
						tracker.assignWorktree(node.id, wt.branch, wt.path);
						tracker.updateStatus(node.id, "in_progress");
						await tracker.save();

						// Build prompt
						const memory = readMemory(projectPath);
						const prompt = buildTaskPrompt(node, tracker, memory);

						const request: AgentRequest = {
							prompt,
							cwd: wt.path,
							systemPrompt: TASK_SYSTEM_PROMPT,
							maxTurns: 30,
							resumeSessionId: node.sessionId ?? undefined,
						};

						// Execute agent (this blocks until the child agent finishes)
						const result = await provider.execute(request);

						// Store session ID
						if (result.sessionId) {
							tracker.assignSession(node.id, result.sessionId);
						}

						const newStatus = result.success ? "passed" : "failed";
						tracker.updateStatus(node.id, newStatus);
						await tracker.save();

						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify(
										{
											taskId: node.id,
											title: node.title,
											status: newStatus,
											success: result.success,
											output: result.output.slice(0, 2000),
											branch: wt.branch,
											costUsd: result.costUsd,
											turns: result.turns,
										},
										null,
										2,
									),
								},
							],
						};
					} catch (e) {
						tracker.updateStatus(node.id, "stuck");
						await tracker.save();

						const message = e instanceof Error ? e.message : "Unknown error";
						return {
							content: [{ type: "text" as const, text: `Error: ${message}` }],
							isError: true,
						};
					}
				},
			),

			tool(
				"spawn_children",
				"Spawn ALL pending children of a parent task in parallel. " +
					"Each child gets its own git worktree and agent. " +
					"This tool blocks until all children have completed. " +
					"Use this instead of calling spawn_task multiple times — it's truly parallel.",
				{
					parentId: z
						.string()
						.describe("ID of the parent task whose children to spawn"),
				},
				async (args) => {
					const parent = tracker.get(args.parentId);
					if (!parent) {
						return {
							content: [
								{ type: "text" as const, text: "Error: Parent not found" },
							],
							isError: true,
						};
					}

					const children = tracker.getChildren(args.parentId);
					const pending = children.filter((c) => c.status === "pending");

					if (pending.length === 0) {
						return {
							content: [
								{
									type: "text" as const,
									text: "No pending children to spawn",
								},
							],
						};
					}

					// Ensure parent has a worktree so children can branch from it
					if (!parent.worktreePath) {
						const parentSlug = slugify(parent.title);
						const grandparent = parent.parentId
							? tracker.get(parent.parentId)
							: undefined;
						const baseBranch = grandparent?.branch ?? undefined;
						const wt = await worktrees.create(
							parent.id,
							parentSlug,
							baseBranch,
						);
						tracker.assignWorktree(parent.id, wt.branch, wt.path);
						tracker.updateStatus(parent.id, "in_progress");
						await tracker.save();
					}

					// Spawn all children in parallel
					const results = await Promise.all(
						pending.map(async (child) => {
							try {
								const slug = slugify(child.title);
								const baseBranch = parent.branch ?? undefined;

								const wt = await worktrees.create(child.id, slug, baseBranch);
								tracker.assignWorktree(child.id, wt.branch, wt.path);
								tracker.updateStatus(child.id, "in_progress");
								await tracker.save();

								const memory = readMemory(projectPath);
								const prompt = buildTaskPrompt(child, tracker, memory);

								const result = await provider.execute({
									prompt,
									cwd: wt.path,
									systemPrompt: TASK_SYSTEM_PROMPT,
									maxTurns: 30,
									resumeSessionId: child.sessionId ?? undefined,
								});

								if (result.sessionId) {
									tracker.assignSession(child.id, result.sessionId);
								}

								const newStatus = result.success ? "passed" : "failed";
								tracker.updateStatus(child.id, newStatus);
								await tracker.save();

								return {
									taskId: child.id,
									title: child.title,
									status: newStatus,
									success: result.success,
									branch: wt.branch,
									costUsd: result.costUsd,
									turns: result.turns,
								};
							} catch (e) {
								tracker.updateStatus(child.id, "stuck");
								await tracker.save();
								const message =
									e instanceof Error ? e.message : "Unknown error";
								return {
									taskId: child.id,
									title: child.title,
									status: "stuck" as const,
									success: false,
									branch: null,
									error: message,
								};
							}
						}),
					);

					const passed = results.filter((r) => r.success).length;
					const failed = results.length - passed;

					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify(
									{ passed, failed, total: results.length, results },
									null,
									2,
								),
							},
						],
						...(failed > 0 ? { isError: true } : {}),
					};
				},
			),

			tool(
				"merge_branch",
				"Merge a task's branch into a target branch. Used after child tasks complete to integrate their work.",
				{
					taskId: z.string().describe("ID of the task whose branch to merge"),
					targetBranch: z
						.string()
						.describe("Branch to merge into (usually the parent's branch)"),
				},
				async (args) => {
					const node = tracker.get(args.taskId);
					if (!node) {
						return {
							content: [
								{ type: "text" as const, text: "Error: Task not found" },
							],
							isError: true,
						};
					}
					if (!node.branch) {
						return {
							content: [
								{
									type: "text" as const,
									text: "Error: Task has no branch assigned",
								},
							],
							isError: true,
						};
					}

					try {
						const slug = slugify(node.title);
						const success = await worktrees.merge(
							node.id,
							slug,
							args.targetBranch,
						);
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify(
										{
											merged: success,
											branch: node.branch,
											into: args.targetBranch,
										},
										null,
										2,
									),
								},
							],
							...(success ? {} : { isError: true }),
						};
					} catch (e) {
						const message = e instanceof Error ? e.message : "Unknown error";
						return {
							content: [{ type: "text" as const, text: `Error: ${message}` }],
							isError: true,
						};
					}
				},
			),
			tool(
				"cleanup_worktrees",
				"Clean up all worktrees and their branches. Call this after orchestration is complete to free disk space.",
				{},
				async () => {
					try {
						const list = await worktrees.list();
						await worktrees.cleanup();

						// Also clean up og/ branches that may remain
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify(
										{
											cleaned: list.length,
											worktrees: list.map((w) => w.branch),
										},
										null,
										2,
									),
								},
							],
						};
					} catch (e) {
						const message = e instanceof Error ? e.message : "Unknown error";
						return {
							content: [{ type: "text" as const, text: `Error: ${message}` }],
							isError: true,
						};
					}
				},
			),
		],
	});
}

function readMemory(projectPath: string): string {
	try {
		return readFileSync(join(projectPath, ".ai", "memory.md"), "utf-8");
	} catch {
		return "";
	}
}

function buildTaskPrompt(
	node: { title: string; description: string; parentId: string | null },
	tracker: TaskTracker,
	memory: string,
): string {
	const parts: string[] = [];

	if (memory) {
		parts.push("## Project Memory", memory, "");
	}

	parts.push(`# Task: ${node.title}`);
	if (node.description) {
		parts.push(node.description);
	}

	if (node.parentId) {
		const siblings = tracker.getChildren(node.parentId);
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

function slugify(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 30);
}
