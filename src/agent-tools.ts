import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	createSdkMcpServer,
	type SdkMcpToolDefinition,
	tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AgentProvider, AgentRequest } from "./agent-provider.ts";
import type { TaskTracker } from "./task-tracker.ts";
import type { WorktreeManager } from "./worktree-manager.ts";

/**
 * Check if nodeId is a descendant of ancestorId by walking up the parent chain.
 */
export function isDescendantOf(
	tracker: TaskTracker,
	nodeId: string,
	ancestorId: string,
): boolean {
	let current = tracker.get(nodeId);
	while (current) {
		if (current.parentId === ancestorId) return true;
		if (!current.parentId) return false;
		current = tracker.get(current.parentId);
	}
	return false;
}

/**
 * Check if the git working tree is clean (no uncommitted changes).
 * Worktrees branch from the current HEAD, so dirty state would be lost.
 */
async function isGitClean(projectPath: string): Promise<{
	clean: boolean;
	message: string;
}> {
	const proc = Bun.spawn(["git", "status", "--porcelain"], {
		cwd: projectPath,
		stdout: "pipe",
		stderr: "pipe",
	});
	await proc.exited;
	const output = (await new Response(proc.stdout).text()).trim();
	if (!output) {
		return { clean: true, message: "" };
	}
	const lines = output.split("\n").filter((l) => l.trim());
	return {
		clean: false,
		message: `Working tree has ${lines.length} uncommitted change(s):\n${output}\n\nCommit or stash changes before spawning tasks.`,
	};
}

/**
 * Shared orchestration knowledge — every agent gets this because any agent
 * can become an orchestrator if it judges a task is too complex.
 */
export const ORCHESTRATION_KNOWLEDGE = `## Orchestration Tools (via MCP server "opengraft")
- get_tree: View the current task tree (always check this first)
- create_task: Create tasks (omit parentId for top-level, or provide parentId for children)
- update_task_status: Update a task's status
- execute_tasks: Execute 1+ of your direct children in parallel. Each task gets an isolated worktree.
  Modes: "new" (fresh start), "resume" (continue failed task's session), "reset" (wipe branch, restart)
- delete_task: Clean up a child's worktree + branch + task node (call AFTER you merge)

## Orchestration Workflow
1. Analyze the goal and the codebase (read files to understand structure)
2. Create tasks using create_task (top-level or as children of a parent)
3. CRITICAL: Sibling tasks run in PARALLEL — each must work on DIFFERENT files/modules
4. Call execute_tasks to run your children in parallel
5. When a child passes, merge its branch:
   a. Merge via bash: \`git merge --no-ff <child-branch> -m "Merge task: <title>"\`
      (run this from YOUR worktree directory, or the main repo if you are the top-level orchestrator)
   b. Call delete_task(taskId) to clean up the child's worktree, branch, and task node
6. If a child fails: use execute_tasks with mode "resume" (with instructions) or "reset" (start over)
7. After ALL children are merged: run full test suite on your branch to verify no regressions

## Task Lifecycle
pending → in_progress (agent working) → passed/failed/stuck
After a child passes: merge its branch → call delete_task to clean up
If a child fails: execute_tasks with resume (keep progress) or reset (start fresh)
If a child fails 3 times: mark it stuck, move on to other tasks

## Merge Details
- Use \`git merge --no-ff <branch> -m "..."\` to merge a child's branch.
- Merge from the directory that has the target branch checked out (your worktree or main repo).
- If merge conflicts occur, resolve them manually or mark the child as "stuck".
- After successful merge, ALWAYS call delete_task to clean up the worktree and branch.

## Memory System
- Project memory lives in \`.opengraft/memory.md\` — read it on start, update it as you learn.
- When you discover something important (pitfall, pattern, architectural decision), append it to memory.
- In a worktree: your memory edits will merge with the parent's when your branch merges.
- Rules: APPEND new entries. NEVER modify entries inherited from parent branches.
- If you find an inherited entry is wrong, add a correction note — don't overwrite.
- Commit memory updates alongside code: \`git add .opengraft/memory.md && git commit\`

## Orchestration Rules
- You can only execute your own direct children — no skipping levels
- Split by module/feature boundary, NOT by step (e.g. "auth module" vs "payment module")
- Never have two siblings modify the same file — parallel tasks must be independent
- Keep the tree shallow: 2-3 levels max
- Each leaf task should be independently executable by a single agent session
- ALWAYS merge and delete_task each passed child before moving on

## Stimulus Priority (what to do next)
When deciding your next action, follow this priority order:
1. **Failed children** → Analyze failure, execute_tasks with "resume" (give instructions) or "reset"
2. **Stuck children** → Provide guidance, try a different approach, or skip and note for user
3. **Passed children not yet merged** → Merge branch, delete_task, verify tests
4. **Pending children ready to start** → execute_tasks to spawn them
5. **All children done** → Run full test suite, verify integration, update memory
6. **Everything complete** → Report final status, stop

## Never-Stop Principle
You run continuously until one of three conditions:
1. **DONE**: All tasks passed, tests green, you are satisfied with the result
2. **CLARIFY**: You need user input on an ambiguous requirement (not a technical question)
3. **BLOCKED**: Technically stuck after exhausting all approaches — mark stuck, preserve branch

If some tasks are stuck but others are pending, keep working on the pending ones.
Do NOT stop just because you finished responding — check get_tree and keep driving.`;

export const TASK_SYSTEM_PROMPT = `You are an autonomous programming agent working on a subtask in a git worktree.
You can implement code directly (worker role), OR if the task is too complex, decompose it into
subtasks and delegate to child agents (sub-orchestrator role). Use your judgement.
When acting as sub-orchestrator: do NOT write code yourself — only manage child agents.

## Worker Tools
- bash: Run shell commands (tests, git, build tools)
- read_file: Read file contents
- write_file: Create or overwrite files (creates directories automatically)
- edit_file: Replace a unique string in a file (for surgical edits)
- list_files: Glob pattern matching to find files
- search: Regex search across files (with optional context lines)

## Worker Workflow
1. Read \`.opengraft/memory.md\` and the task description carefully
2. Explore the codebase: list_files to find relevant files, search to understand patterns
3. Implement: types → tests → implementation (vertical iteration)
4. Validate: run tests, typecheck, and lint — all must pass
5. Update \`.opengraft/memory.md\` if you discovered anything important (pitfalls, patterns, decisions)
6. Commit your work via bash (git add + git commit) — include memory updates in the same commit

## Git Rules (CRITICAL)
- You are working in a git WORKTREE on a dedicated branch. Do NOT switch branches.
- Run \`git branch\` to verify your current branch before committing.
- NEVER run \`git checkout main\` or \`git checkout master\` — this will corrupt the worktree setup.
- All commits must go on your current branch. The parent orchestrator will merge later.
- Do NOT push — just commit locally.

## Worker Rules
- Work only on the files/modules described in your task
- Do NOT modify files outside your scope — sibling tasks work on other modules in parallel
- Run \`bun test\`, \`bun run typecheck\`, and \`bun run check\` before considering done
- Commit when all checks pass
- Prefer edit_file for small changes, write_file for new files or complete rewrites
- Use search to understand existing code before modifying it

## Methodology (from OpenGraft.md)
- Don't guess APIs — read docs or run --help first
- Don't say "should work" — run it and see
- Don't blame the framework — suspect your own code first
- Flaky test = Bug. Never "fix" with retries.
- Three repetitions before abstracting. No premature helpers.
- Identify layer → add logs → trust logs → isolate → minimize

${ORCHESTRATION_KNOWLEDGE}`;

export interface OrchestratorToolsDeps {
	tracker: TaskTracker;
	provider: AgentProvider;
	worktrees: WorktreeManager;
	/** Working directory for this agent (main repo or worktree). */
	projectPath: string;
	/** Main repo root — always the same, used for git operations. */
	repoPath: string;
	/** Current task ID — null for top-level orchestrator (project level). */
	currentTaskId?: string | null;
	/** Recursion depth (0 = top-level orchestrator). Max depth limits MCP tool injection. */
	depth?: number;
	/** Optional callback for broadcasting task events (e.g., to WebSocket clients). */
	onTaskEvent?: (event: Record<string, unknown>) => void;
	/** Model for child agent execution (defaults to provider's default). */
	childModel?: string;
}

/** Tracks accumulated costs from all child agent executions. */
export class CostAccumulator {
	private _totalCost = 0;
	private _totalTurns = 0;
	private _taskCount = 0;

	add(costUsd: number | undefined, turns: number | undefined): void {
		if (costUsd) this._totalCost += costUsd;
		if (turns) this._totalTurns += turns;
		this._taskCount++;
	}

	get totalCostUsd(): number {
		return this._totalCost;
	}
	get totalTurns(): number {
		return this._totalTurns;
	}
	get taskCount(): number {
		return this._taskCount;
	}
}

/** Result of createOrchestratorTools — MCP server + raw tool definitions. */
export interface OrchestratorToolsResult {
	/** MCP server config for Claude Code provider. */
	mcpServer: ReturnType<typeof createSdkMcpServer>;
	/** Raw tool definitions for DirectProvider forwarding. */
	// biome-ignore lint/suspicious/noExplicitAny: SdkMcpToolDefinition generic is not narrowable here
	toolDefs: SdkMcpToolDefinition<any>[];
}

/**
 * Create orchestrator tools for the main agent.
 * Returns both an MCP server (for Claude Code provider) and raw tool definitions
 * (for DirectProvider to forward as Anthropic API tools).
 */
export function createOrchestratorTools(
	deps: OrchestratorToolsDeps,
	costAccumulator?: CostAccumulator,
): OrchestratorToolsResult {
	const {
		tracker,
		provider,
		worktrees,
		projectPath,
		repoPath,
		onTaskEvent,
		childModel,
	} = deps;
	const currentTaskId = deps.currentTaskId ?? null;
	const depth = deps.depth ?? 0;
	const maxDepth = 3;
	const costs = costAccumulator ?? new CostAccumulator();
	const emit = (event: Record<string, unknown>) => onTaskEvent?.(event);

	/**
	 * Execute a child agent with streaming, forwarding events tagged with taskId.
	 * If depth < maxDepth, the child also receives MCP tools for recursive spawning.
	 */
	async function executeChildStreaming(
		request: AgentRequest,
		taskId: string,
		childCwd: string,
	): Promise<{
		success: boolean;
		output: string;
		costUsd?: number;
		turns?: number;
		sessionId?: string;
	}> {
		// Give children MCP tools if we haven't hit max depth
		if (depth < maxDepth && !request.mcpToolDefs) {
			const childCosts = new CostAccumulator();
			const { toolDefs: childToolDefs, mcpServer: childMcpServer } =
				createOrchestratorTools(
					{
						tracker,
						provider,
						worktrees,
						projectPath: childCwd,
						repoPath,
						currentTaskId: taskId,
						depth: depth + 1,
						onTaskEvent,
						childModel,
					},
					childCosts,
				);
			request.mcpToolDefs = { opengraft: childToolDefs };
			request.mcpServers = { opengraft: childMcpServer };
		}

		const stream = provider.stream(request);
		let result = await stream.next();
		while (!result.done) {
			const { type: eventType, ...eventData } = result.value;
			emit({ type: "agent_event", taskId, eventType, ...eventData });
			result = await stream.next();
		}
		return result.value;
	}

	const toolDefs = [
		tool(
			"get_tree",
			"Get the current task tree. Returns all nodes with their status, branch, and hierarchy.",
			{ format: z.enum(["flat", "tree"]).optional().default("flat") },
			async () => {
				const nodes = tracker.allNodes();
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ nodes }, null, 2),
						},
					],
				};
			},
		),

		tool(
			"create_task",
			"Create a new task. If parentId is provided, creates a child task under that parent. " +
				"If omitted, creates a top-level task (direct child of the project). " +
				"IMPORTANT: Sibling tasks will run in PARALLEL on separate branches. " +
				"Each sibling must work on DIFFERENT files/modules to avoid merge conflicts.",
			{
				title: z.string().describe("Short title for the task"),
				description: z
					.string()
					.describe("Detailed description of what the task should accomplish"),
				parentId: z
					.string()
					.optional()
					.describe("Parent task ID. Omit to create a top-level task."),
			},
			async (args) => {
				try {
					// Scope validation: agents can only create tasks under themselves or their descendants
					if (
						args.parentId &&
						currentTaskId !== null &&
						args.parentId !== currentTaskId &&
						!isDescendantOf(tracker, args.parentId, currentTaskId)
					) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Cannot create task under ${args.parentId}: not your task or descendant`,
								},
							],
							isError: true,
						};
					}

					const node = args.parentId
						? tracker.addChild(args.parentId, args.title, args.description)
						: tracker.addTask(args.title, args.description);
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
			"execute_tasks",
			"Execute 1 or more of your direct children tasks in parallel. " +
				"Each task runs on an isolated git worktree with its own agent. " +
				"Blocks until all tasks complete. " +
				"For each task, you can provide instructions and a mode:\n" +
				"- new (default): fresh execution, creates worktree and branch\n" +
				"- resume: continue from previous session (for failed/stuck tasks)\n" +
				"- reset: wipe the branch and start fresh (for failed/stuck tasks)",
			{
				tasks: z
					.array(
						z.object({
							taskId: z.string().describe("ID of the child task"),
							message: z
								.string()
								.optional()
								.describe("Instructions for the agent"),
							mode: z
								.enum(["new", "resume", "reset"])
								.optional()
								.default("new")
								.describe(
									"new=fresh start, resume=continue session, reset=wipe branch and restart",
								),
						}),
					)
					.describe("Tasks to execute in parallel"),
			},
			async (args) => {
				// Guard: require clean working tree before spawning
				const gitCheck = await isGitClean(projectPath);
				if (!gitCheck.clean) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: ${gitCheck.message}`,
							},
						],
						isError: true,
					};
				}

				if (args.tasks.length === 0) {
					return {
						content: [
							{ type: "text" as const, text: "Error: No tasks specified" },
						],
						isError: true,
					};
				}

				// Validate: all tasks must be direct children of current agent
				const myChildren = currentTaskId
					? tracker.getChildren(currentTaskId)
					: tracker.getTopLevel();
				const myChildIds = new Set(myChildren.map((c) => c.id));

				for (const t of args.tasks) {
					if (!myChildIds.has(t.taskId)) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Error: Task ${t.taskId} is not your direct child`,
								},
							],
							isError: true,
						};
					}
				}

				// Determine base branch for worktree creation
				const currentNode = currentTaskId
					? tracker.get(currentTaskId)
					: undefined;
				const baseBranch = currentNode?.branch ?? undefined;

				// Execute all tasks in parallel
				const results = await Promise.all(
					args.tasks.map(async (taskSpec) => {
						const node = tracker.get(taskSpec.taskId);
						if (!node) {
							return {
								taskId: taskSpec.taskId,
								title: "?",
								status: "stuck" as const,
								success: false,
								error: "Task not found",
							};
						}

						const mode = taskSpec.mode ?? "new";

						// Validate mode vs status
						if (mode === "new" && node.status !== "pending") {
							return {
								taskId: node.id,
								title: node.title,
								status: node.status,
								success: false,
								error: `Cannot use mode "new" on task with status "${node.status}" — use "resume" or "reset"`,
							};
						}
						if (
							(mode === "resume" || mode === "reset") &&
							node.status !== "failed" &&
							node.status !== "stuck"
						) {
							return {
								taskId: node.id,
								title: node.title,
								status: node.status,
								success: false,
								error: `Cannot use mode "${mode}" on task with status "${node.status}"`,
							};
						}

						try {
							// Handle reset: wipe existing worktree/branch and start fresh
							if (mode === "reset" && node.worktreePath) {
								const slug = slugify(node.title);
								await worktrees.remove(node.id, slug);
								node.worktreePath = null;
								node.branch = null;
								node.sessionId = null;
							}

							// Create worktree if needed (new or reset)
							if (!node.worktreePath) {
								const slug = slugify(node.title);
								const wt = await worktrees.create(node.id, slug, baseBranch);
								tracker.assignWorktree(node.id, wt.branch, wt.path);
							}

							tracker.updateStatus(node.id, "in_progress");
							await tracker.save();
							emit({
								type: "task_started",
								taskId: node.id,
								title: node.title,
							});

							// Build prompt based on mode
							const memory = readMemory(projectPath);
							let prompt: string;
							const branchReminder = node.branch
								? `\n\nYou are on branch \`${node.branch}\`. Do NOT switch branches.`
								: "";

							if (mode === "resume" && node.sessionId) {
								// Resume: send message to existing session
								prompt = taskSpec.message
									? `${taskSpec.message}${branchReminder}`
									: `Continue working. Pick up where you left off.${branchReminder}`;
							} else {
								// New or reset: full task context
								const taskPrompt = buildTaskPrompt(node, tracker, memory);
								prompt = taskSpec.message
									? `${taskSpec.message}\n\n${taskPrompt}`
									: taskPrompt;
							}

							const result = await executeChildStreaming(
								{
									prompt,
									cwd: node.worktreePath as string,
									systemPrompt: TASK_SYSTEM_PROMPT,
									resumeSessionId:
										mode === "resume"
											? (node.sessionId ?? undefined)
											: undefined,
									model: childModel,
								},
								node.id,
								node.worktreePath as string,
							);

							if (result.sessionId) {
								tracker.assignSession(node.id, result.sessionId);
							}
							costs.add(result.costUsd, result.turns);

							let newStatus: "passed" | "failed" | "stuck";
							if (result.success) {
								newStatus = "passed";
								node.failCount = 0;
							} else {
								node.failCount = (node.failCount ?? 0) + 1;
								// Auto-stuck after 3 consecutive failures
								newStatus = node.failCount >= 3 ? "stuck" : "failed";
							}
							tracker.updateStatus(node.id, newStatus);
							await tracker.save();
							emit({
								type: "task_completed",
								taskId: node.id,
								title: node.title,
								success: result.success,
							});

							return {
								taskId: node.id,
								title: node.title,
								status: newStatus,
								success: result.success,
								branch: node.branch,
								output: result.output.slice(0, 2000),
								costUsd: result.costUsd,
								turns: result.turns,
								failCount: node.failCount,
								...(newStatus === "stuck"
									? {
											autoStuck: true,
											reason: `Failed ${node.failCount} consecutive times — marked stuck automatically`,
										}
									: {}),
							};
						} catch (e) {
							tracker.updateStatus(node.id, "stuck");
							await tracker.save();
							const message = e instanceof Error ? e.message : "Unknown error";
							return {
								taskId: node.id,
								title: node.title,
								status: "stuck" as const,
								success: false,
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
			"delete_task",
			"Delete a child task and clean up its resources (worktree + branch). " +
				"Call this AFTER you have already merged the child's branch yourself. " +
				"This removes the worktree directory, deletes the git branch, " +
				"and removes the task node from the tree.",
			{
				taskId: z.string().describe("ID of the task to delete"),
			},
			async (args) => {
				const node = tracker.get(args.taskId);
				if (!node) {
					return {
						content: [
							{
								type: "text" as const,
								text: "Error: Task not found",
							},
						],
						isError: true,
					};
				}

				try {
					// Clean up worktree + branch if they exist
					if (node.worktreePath && node.branch) {
						const slug = slugify(node.title);
						await worktrees.remove(node.id, slug);
					}

					// Remove task from tree
					tracker.remove(node.id);
					await tracker.save();

					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify(
									{
										deleted: true,
										taskId: node.id,
										title: node.title,
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
						content: [
							{
								type: "text" as const,
								text: `Error: ${message}`,
							},
						],
						isError: true,
					};
				}
			},
		),
	];

	const mcpServer = createSdkMcpServer({
		name: "opengraft",
		version: "0.1.0",
		tools: toolDefs,
	});

	return { mcpServer, toolDefs };
}

function readMemory(projectPath: string): string {
	const parts: string[] = [];

	try {
		const claudeMd = readFileSync(join(projectPath, "CLAUDE.md"), "utf-8");
		if (claudeMd) parts.push(claudeMd);
	} catch {
		// No CLAUDE.md
	}

	try {
		const memory = readFileSync(
			join(projectPath, ".opengraft", "memory.md"),
			"utf-8",
		);
		if (memory) parts.push(memory);
	} catch {
		// No memory file
	}

	return parts.join("\n\n");
}

function buildTaskPrompt(
	node: {
		title: string;
		description: string;
		parentId: string | null;
		branch?: string | null;
		worktreePath?: string | null;
	},
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

	// Include branch/worktree info so the agent knows where it is
	if (node.branch) {
		parts.push(
			`\n## Git Context`,
			`You are on branch: \`${node.branch}\``,
			`Working directory: \`${node.worktreePath ?? "unknown"}\``,
			`Do NOT switch branches. All commits go on \`${node.branch}\`.`,
		);
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
		"1. Read `.opengraft/memory.md` first for project-specific knowledge.",
		"2. Implement this task: types → tests → implementation → all checks passing.",
		"3. Run `bun test`, `bun run typecheck`, and `bun run check` before considering done.",
		"4. If you discover something important, append it to `.opengraft/memory.md`.",
		"5. Commit all changes (including memory updates) when all checks pass.",
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
