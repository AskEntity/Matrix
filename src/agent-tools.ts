import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	createSdkMcpServer,
	type SdkMcpToolDefinition,
	tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AgentProvider, AgentRequest } from "./agent-provider.ts";
import {
	globalAgentQueues,
	MessageQueue,
	type QueueMessage,
} from "./message-queue.ts";
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

/** Format a QueueMessage for display to the agent. */
export function formatQueueMessage(msg: QueueMessage): string {
	switch (msg.source) {
		case "child_complete":
			return `[child_complete] Task "${msg.title}" (${msg.taskId}) ${msg.success ? "passed" : "failed"}: ${msg.output.slice(0, 500)}`;
		case "user":
			return `[user] ${msg.content}`;
		case "parent_update":
			return `[parent_update] ${msg.content}`;
		case "clarify_response":
			return `[clarify_response] ${msg.answer}`;
		case "child_report":
			return `[child_report] From child "${msg.title}" (${msg.taskId}): ${msg.content}`;
	}
}

/**
 * Shared orchestration knowledge — every agent gets this because any agent
 * can become an orchestrator if it judges a task is too complex.
 */
export const ORCHESTRATION_KNOWLEDGE = `## Orchestration Tools (via MCP server "opengraft")
- get_tree: View the current task tree (always check this first)
- create_task: Create tasks (omit parentId to create under your own task, or provide parentId for a specific parent)
- update_task_status: Update a task's status
- execute_tasks: Fire-and-forget. Spawns children in background, returns immediately with task IDs.
  Results arrive via yield() as child_complete messages.
  Modes: "new" (fresh start), "resume" (continue failed task's session), "reset" (wipe branch, restart)
- yield: Suspend execution and wait for messages (child completions, user messages, clarify responses).
  Call this after spawning tasks. Returns all accumulated messages plus a "## Pending" summary section
  showing running children and pending clarifications. Zero token burn while suspended.
- send_message_to_child: Send a requirement update or instruction to a running child agent.
- delete_task: Clean up a child's worktree + branch + task node (call AFTER you merge)
- clarify: Send a clarification question to the user or parent orchestrator. Returns immediately —
  you can continue doing other work that doesn't need the answer, then call yield() when ready
  to wait for the clarify_response.
- done: Signal that you have finished your task. Call done(status, summary) with status "passed" or "failed".
  This is the proper way to exit — always call done() when you're finished.
- report_to_parent: Send a progress update or status message to your parent agent. Non-blocking.
  The parent receives this as a child_report message when it calls yield().
  Use this to keep the parent informed about important intermediate progress or issues.
  When to call: after completing major milestones, or when you discover something that affects siblings.
  Don't call it for every small action — only significant events worth surfacing.

## Event-Driven Workflow Pattern
1. Analyze the goal and the codebase (read files to understand structure and scope)
2. Create tasks using create_task (omit parentId to create under your own task)
   - Write detailed task descriptions (see "Task Decomposition" in orchestrator system prompt)
   - Sibling tasks run in PARALLEL — plan their scope to minimize merge conflicts
3. Call execute_tasks to spawn children (returns immediately)
4. **Do productive work while children run** — you do NOT need to yield() immediately.
   While children are executing, you can:
   - Research the codebase for future tasks
   - Create additional tasks based on new information
   - Address user messages (create tasks, update descriptions, send instructions to children)
   - Prepare merge strategies
   Only call yield() when you have nothing else to do and are ready to block-wait.
5. Call yield() when idle — this suspends with zero token burn until a message arrives
6. When yield() returns, process the messages and the ## Pending summary:
   - child_complete: check if passed/failed, merge passed branches, retry failed ones
   - child_report: progress update from a running child — read it and continue waiting if needed
   - user: incorporate new instructions
   - clarify_response: use the answer to proceed
   - ## Pending section: shows which children are still running and how many clarifications are outstanding
7. When a child passes, merge its branch:
   a. Merge via bash: \`git merge --no-ff <child-branch> -m "Merge task: <title>"\`
   b. Call delete_task(taskId) to clean up the child's worktree, branch, and task node
8. If a child fails: read the failure summary carefully. Decide:
   - "resume" with specific instructions addressing the failure (child keeps progress)
   - "reset" to start fresh with a different approach
   - Delete and create a new task with different scope if the approach was wrong
9. After ALL children are merged: run full test suite to verify no regressions
10. If integration issues surface, create new targeted tasks to fix them

## Task Lifecycle
pending → in_progress (agent working) → passed / failed

### Calling done() — REQUIRED (the parent is blocked until you do this)
When you finish working on a task, you MUST call \`done(status, summary)\`:
1. **done("passed", summary)** — Task completed. Tests pass, code committed, work done.
   → Parent merges your branch.
2. **done("failed", summary)** — You're stuck. Explain what you tried and where you got blocked.
   → Parent decides: resume (with new instructions) or reset (wipe branch, try differently).

**Every agent session MUST end with a done() call.** If you stop without calling done(),
the parent hangs forever waiting for your result. This is the #1 cause of stuck orchestrations.

If you're unsure about a requirement, use \`clarify\` to ask (returns immediately, continue working).
If you encounter problems you can't overcome, call done("failed", ...) — failing early is better than spinning.

### Parent Handling of Child Results
- **passed** → \`git merge --no-ff <branch>\` → \`delete_task\` → verify tests on your branch
- **failed** → Read the child's failure summary carefully. The quality of your resume/reset decision
  directly affects whether the next attempt succeeds:
  - \`resume\`: Give SPECIFIC instructions addressing the failure. Don't just say "try again" —
    explain what went wrong and how to fix it. The child keeps its progress and your message.
  - \`reset\`: Use when the approach was fundamentally wrong. Rewrite the task description with
    a different strategy. The child starts fresh with a clean branch.
  - If the failure reveals a scope issue: delete the task and create new tasks with better boundaries.

### Merge Protocol
- Use \`git merge --no-ff <branch> -m "Merge task: <title>"\` from YOUR working directory
- If merge conflicts occur: resolve them with edit_file. This is expected with parallel work.
- If conflicts are too complex: merge the larger/more complex feature first, then reset and re-spawn the simpler one.
- After successful merge: ALWAYS call delete_task to clean up worktree + branch + node
- After merging a child, if other children are still running, send them a message via
  send_message_to_child to sync with main: "Main updated — run \`git merge main\`
  to stay in sync and reduce merge conflicts."
  Only do this if you merged substantial changes that could affect sibling work.
- After ALL merges: run full test suite to catch integration issues
- Intermediate merges may not typecheck (e.g., types merged but implementors not yet).
  Use \`--no-verify\` for intermediate commits. The final state MUST pass all hooks.

## Memory System
- Project memory lives in \`.opengraft/memory.md\` — read it on start, update it as you learn.
- When you discover something important (pitfall, pattern, architectural decision), append it to memory.
- In a worktree: your memory edits will merge with the parent's when your branch merges.
- Rules: APPEND new entries. NEVER modify entries inherited from parent branches.
- If you find an inherited entry is wrong, add a correction note — don't overwrite.
- Commit memory updates alongside code: \`git add .opengraft/memory.md && git commit\`
- **Update memory BEFORE calling done()** — memory updates are part of task completion, not an afterthought.
- Focus on: pitfalls discovered, API patterns that worked, decisions made and why.

**How to write memory entries (CRITICAL — prevents duplication)**:
- Use \`edit_file\` to append: set \`old_string\` to the last line(s) of the file, \`new_string\` to those same lines + your new content.
- Or use bash: \`echo "\\n## My Section\\n- bullet" >> .opengraft/memory.md\`
- **NEVER use \`write_file\` on memory.md** — it rewrites the whole file and risks embedding the old content inside the new content, causing triplication. Use \`edit_file\` or bash append only.

### After merging all children: curate memory
After resolving merge conflicts, do a full review of \`.opengraft/memory.md\`:
1. **Reorder**: Important, broadly-applicable knowledge floats up; narrow task-specific details sink down or are removed.
2. **Trim**: Delete trivial one-off notes that no future agent needs. Less is more — every line burns context tokens.
3. **Consolidate**: If two children wrote related entries, merge them into one clear paragraph.
4. The goal: memory.md on main is the project's **distilled wisdom**, filtered through every merge. Quality over quantity.
Commit the curated memory as a standalone commit after all task merges are done.

## Orchestration Rules
- You can only execute your own direct children — no skipping levels
- Split by module/feature boundary, NOT by step (e.g. "auth module" vs "payment module")
- Keep the tree shallow: 2-3 levels max
- Each leaf task should be independently executable by a single agent session
- ALWAYS merge and delete_task each passed child before moving on

## Parallelization Strategy
- Sibling tasks run in PARALLEL. Split by sub-feature so each has a clear scope.
- Some file overlap is OK if the changes are in different areas (e.g., each adding a new UI component).
  Merge conflicts from parallel work are normal — resolve them.
- When specifying child tasks, tell each child whether its task is independently compilable/testable,
  or whether it depends on sibling outputs (and if so, what to expect).
- If a merge conflict is too complex to resolve: merge the more complex/larger feature first,
  then re-spawn the simpler feature with \`mode: "reset"\` so it rebuilds on top of the merged code.

## Reusable Worker Pattern
To assign multiple sequential tasks to the same agent without spawning new ones:
1. Spawn child via execute_tasks with initial task
2. Child does work → calls report_to_parent("ready for more") → calls yield() to wait
3. Parent receives child_report via yield() → sends next task via send_message_to_child
4. Child receives message during yield, does next task, reports again, and yields again
5. When truly done, parent tells child via send_message_to_child("All done, call done('passed')")

Benefits: Session context reuse (cheaper), no worktree setup overhead for related tasks.
Use when: child has expensive startup context, or tasks are closely related and benefit from shared memory.

## Session Continuity
Your session persists across conversations. When the user sends a new message:
- The message arrives piggybacked on your current tool result — no need to call yield()
- Incorporate the user's instructions immediately: create tasks, update plans, send messages to children
- Do useful work BEFORE calling yield() — research, planning, task creation
- Only yield() when you've handled everything you can and are ready to wait

**Critical rule for user messages received during yield():**
When yield() returns with a user message, you MUST take concrete action before yielding again:
- At minimum: create a task from the request (tasks persist after context compaction, mental notes don't)
- Better: create AND execute the task immediately
- If it affects running children: send_message_to_child with the update
- If it's a question you can answer directly: answer it
- NEVER just yield() again with only a mental note about what the user asked
- Creating a task (even without executing it yet) counts as taking action — it persists in the tree
- "Noted" or "I'll keep that in mind" is NOT a valid response to a user request. Every user message that contains a request or instruction MUST result in a task creation, a send_message_to_child, or immediate action. If you're unsure whether it's actionable, create a task anyway — tasks are cheap, lost context is expensive.

## Stimulus Priority (what to do next — check this after EVERY action, including after compaction)
When deciding your next action, follow this priority order:
0. **Just resumed from compaction?** → Read checkpoint, call get_tree, then follow priorities below
1. **Failed children** → Analyze output, execute_tasks with "resume" (give instructions) or "reset"
2. **Passed children not yet merged** → Merge branch, delete_task, verify tests
3. **Pending children ready to start** → execute_tasks to spawn them
4. **All children done** → Run full test suite, verify integration, update memory
5. **Everything complete** → Call done("passed", summary)

## Never-Stop Principle (CRITICAL — especially after context compaction)
You stop ONLY when ALL tasks are resolved (all passed/merged) and you have nothing left to do.
After compaction, you will see a checkpoint — treat it as your TODO list and keep driving.

- If you need clarification: make your best judgement, note the decision in memory, and proceed.
- If technically blocked: try a different approach. If that fails too, call done("failed", ...).
- If some children failed: address them (resume/reset) before stopping.
- Do NOT stop just because you finished responding — call get_tree and keep driving.
- After compaction: read the checkpoint's "Remaining Work" and "Next Action" — then DO them.`;

export const TASK_SYSTEM_PROMPT = `You are an autonomous programming agent working on a subtask in a git worktree.
You can implement code directly (worker role), OR if the task is too complex, decompose it into
subtasks and delegate to child agents (sub-orchestrator role). Use your judgement.
When acting as sub-orchestrator: do NOT write code yourself — only manage child agents.

**MANDATORY**: When you finish your task, you MUST call done("passed", summary) or done("failed", summary).
Never just stop responding — the parent agent is waiting for your done() signal to proceed.

**Parallelism**: If your task is complex, decompose it into subtasks and spawn children for parallel execution.
The task tree is a tree, not a list — each level of decomposition multiplies parallelism.
Only implement directly if the task is small enough for a single agent session.

## Worker Tools
- bash: Run shell commands (tests, git, build tools). Do NOT use bash for file operations — use
  the dedicated tools instead (read_file, write_file, edit_file, list_files, search).
  Reserve bash for: running tests, git commands, package install, build commands, system operations.
  Good: \`bun test\`, \`git commit\`, \`bun install\`, \`bun run typecheck\`
  Bad: \`cat src/foo.ts\` (use read_file), \`grep -r pattern .\` (use search), \`find . -name "*.ts"\` (use list_files)
  Your working directory persists across bash calls. Do NOT start every command with \`cd /path &&\` — it's wasteful.
  If you cd once, all subsequent commands run from that directory. Your CWD is tracked — if you navigate outside your worktree, you'll be warned. Remember to cd back when done.
- read_file: Read file contents with optional offset/limit for large files.
  You MUST read a file before editing it — understand existing code before modifying.
- write_file: Create or overwrite files (creates directories automatically).
  Use for new files or complete rewrites. Prefer edit_file for modifying existing files.
- edit_file: Replace a unique string in a file (for surgical edits).
  The old_string MUST be unique in the file. If the edit fails because old_string is not unique,
  provide more surrounding context to make it unique, or use replace_all=true for bulk renames.
  Always include enough context (surrounding lines) to be unambiguous.
- list_files: Glob pattern matching to find files (e.g. "src/**/*.ts", "*.json").
- search: Regex search across files. Use output_mode="files_with_matches" for discovery,
  then read_file the relevant files. Use context lines when you need to understand surrounding code.
- report_to_parent: Send a progress update to your parent agent (non-blocking). Use this to report
  important intermediate results, blockers, or status without waiting for parent acknowledgement.

## Worker Workflow
1. Read \`.opengraft/memory.md\` and the task description carefully
2. Explore the codebase to understand context before writing any code:
   - list_files to find relevant files and understand project structure
   - search with output_mode="files_with_matches" to locate where things are defined
   - read_file the key files you'll modify or depend on — understand patterns, conventions, types
   - Look at existing tests to understand the testing patterns used in the project
3. Implement incrementally — make a change, test it, make the next change:
   - Types first, then implementation, then tests (or tests first for bug fixes)
   - Run tests after each meaningful change, not just at the end
   - When a test fails: read the test file and the error carefully. Understand WHAT the test expects
     and WHY before attempting a fix. Don't blindly retry with small modifications.
4. Validate: run tests, typecheck, and lint — all must pass
5. **Write to \`.opengraft/memory.md\`** — this is your scratch pad, write freely:
   - Pitfalls you hit and how you solved them
   - API quirks or gotchas (e.g. "Zod v4 uses def.element not def.type")
   - Architectural decisions you made and why
   - Patterns you discovered that future agents should know
   - Anything you wish you had known at the start of this task
   No format constraints. No approval needed. The parent will curate after merge — your job is to capture, not to filter.
   **APPEND ONLY** — use \`edit_file\` (match last lines, extend them) or bash \`echo >> .opengraft/memory.md\`. NEVER use \`write_file\` on memory.md — it duplicates content.
6. Commit your work via bash (git add + git commit) — include memory updates in the same commit.
   Stage specific files by name — avoid \`git add .\` which can stage unintended files.

## Git Rules (CRITICAL)
- You are working in a git WORKTREE on a dedicated branch. Do NOT switch branches.
- Run \`git branch\` to verify your current branch before committing.
- NEVER run \`git checkout main\` or \`git checkout master\` — this will corrupt the worktree setup.
- All commits must go on your current branch. The parent orchestrator will merge later.
- Do NOT push — just commit locally.
- Write concise commit messages that focus on the "why" rather than the "what".

## Worker Rules
- Work on the files/modules described in your task. Avoid modifying files outside your scope.
- Read the codebase to understand context — explore relevant files, patterns, and conventions.
  Do NOT propose changes to code you haven't read. Read first, then modify.
- Follow the parent's instructions on whether your task is independently compilable/testable.
  If the parent says your task depends on sibling outputs, use \`--no-verify\` for commits if needed.
- Run \`bun test\`, \`bun run typecheck\`, and \`bun run check\` before considering done.
- Prefer edit_file for small changes, write_file for new files or complete rewrites.
- Use search to understand existing code before modifying it.
- When finished, call \`done("passed", summary)\` or \`done("failed", summary)\`. Always call done().

## Code Quality
- Avoid over-engineering. Only make changes directly needed for the task. Keep solutions simple.
  Don't add features, refactor code, or make "improvements" beyond what was asked.
- Don't add unnecessary error handling, fallbacks, or validation for scenarios that can't happen.
- Don't create helpers or abstractions for one-time operations. Three repetitions before abstracting.
- Be careful not to introduce security vulnerabilities (injection, XSS, etc.).
  Don't commit secrets (.env, API keys, credentials).
- Prefer editing existing files over creating new ones — build on existing work.

## Debugging
- When stuck: add targeted console.log/debug output to isolate the issue. Trust the logs.
- Identify which layer has the bug → add logs → reproduce → isolate → fix → remove debug logs.
- Don't guess — read the actual error message. Read the relevant source code.
- Don't blame the framework — suspect your own code first.
- If an approach isn't working after 2-3 attempts, step back and reconsider. Try a fundamentally
  different approach rather than making incremental tweaks to a broken one.
- If you're truly stuck, call done("failed", explanation) with a clear description of what you
  tried and what went wrong. Failing early is better than wasting turns.

## Token Budget Awareness
- Prefer targeted searches over reading large files when you know what you're looking for.
- Use search() with specific patterns instead of reading entire files speculatively.
- Read large files in chunks (use offset/limit) when you only need a specific section.
- Use report_to_parent() to surface important findings early — don't wait until done().

## Output Efficiency
Keep your text output brief and direct. Lead with the action, not the reasoning. Skip filler
words and unnecessary transitions. Don't narrate what you're about to do — just do it.
Don't repeat the task description back. Focus text on decisions, errors, and results.

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
	/** Optional callback to broadcast tree updates to WebSocket clients after task mutations. */
	broadcastTreeUpdate?: () => void;
	/** Model for child agent execution (defaults to provider's default). */
	childModel?: string;
	/** MessageQueue for the parent agent session (for fire-and-forget results). */
	queue?: MessageQueue;
	/** Registry of child agent queues for send_message_to_child. Managed internally. */
	childQueues?: Map<string, MessageQueue>;
	/** Mutable ref shared between done tool and runLoop — when done tool is called, sets the result here. */
	doneRef?: { done: null | { status: "passed" | "failed"; summary: string } };
	/** Parent's queue — used by report_to_parent to send messages UP. Null for top-level orchestrator. */
	parentQueue?: MessageQueue;
	/** Default budget per task from project config. undefined = unlimited. */
	defaultBudgetUsd?: number;
	/** Timeout for clarify() responses in ms. undefined = wait forever. */
	clarifyTimeoutMs?: number;
	/** Maximum recursive depth for spawning child agents. Defaults to 3. */
	maxDepth?: number;
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
	/** Raw tool definitions for AnthropicCompatibleProvider forwarding. */
	// biome-ignore lint/suspicious/noExplicitAny: SdkMcpToolDefinition generic is not narrowable here
	toolDefs: SdkMcpToolDefinition<any>[];
	/** Returns true if this agent has running children (childQueues is non-empty). */
	hasRunningChildren?: () => boolean;
}

/**
 * Create orchestrator tools for the main agent.
 * Returns both an MCP server (for Claude Code provider) and raw tool definitions
 * (for AnthropicCompatibleProvider to forward as Anthropic API tools).
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
		broadcastTreeUpdate,
	} = deps;
	const currentTaskId = deps.currentTaskId ?? null;
	const depth = deps.depth ?? 0;
	const maxDepth = deps.maxDepth ?? 3;
	const costs = costAccumulator ?? new CostAccumulator();
	const emit = (event: Record<string, unknown>) => onTaskEvent?.(event);
	const childQueues = deps.childQueues ?? new Map<string, MessageQueue>();
	const doneRef = deps.doneRef ?? null;
	/** Count of outstanding clarify() calls that have not yet received a clarify_response. */
	let pendingClarifications = 0;

	/**
	 * Execute a child agent with streaming, forwarding events tagged with taskId.
	 * If depth < maxDepth, the child also receives MCP tools for recursive spawning.
	 * Returns the child's queue so the parent can send messages to it.
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
		// Create a queue for this child agent
		const childQueue = new MessageQueue();
		childQueues.set(taskId, childQueue);
		globalAgentQueues.set(taskId, childQueue);
		request.queue = childQueue;

		// Give children MCP tools if we haven't hit max depth
		if (depth < maxDepth && !request.mcpToolDefs) {
			const childCosts = new CostAccumulator();
			const childDoneRef: {
				done: null | { status: "passed" | "failed"; summary: string };
			} = { done: null };
			const {
				toolDefs: childToolDefs,
				mcpServer: childMcpServer,
				hasRunningChildren: childHasRunningChildren,
			} = createOrchestratorTools(
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
					queue: childQueue,
					parentQueue: deps.queue,
					doneRef: childDoneRef,
					broadcastTreeUpdate,
					defaultBudgetUsd: deps.defaultBudgetUsd,
					maxDepth: deps.maxDepth,
					clarifyTimeoutMs: deps.clarifyTimeoutMs,
				},
				childCosts,
			);
			request.mcpToolDefs = { opengraft: childToolDefs };
			request.mcpServers = { opengraft: childMcpServer };
			request.doneRef = childDoneRef;
			request.hasRunningChildren = childHasRunningChildren;
		}

		try {
			const stream = provider.stream(request);
			let result = await stream.next();
			while (!result.done) {
				const { type: eventType, ...eventData } = result.value;
				emit({ type: "agent_event", taskId, eventType, ...eventData });
				result = await stream.next();
			}
			return result.value;
		} finally {
			childQueues.delete(taskId);
			globalAgentQueues.delete(taskId);
			childQueue.close();
		}
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
			"Create a new task. If parentId is provided, creates a child under that parent. " +
				"If omitted, creates a child of YOUR current task (or top-level if you are the root orchestrator). " +
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
					.describe(
						"Parent task ID. Omit to create a child of your current task.",
					),
				draft: z
					.boolean()
					.optional()
					.describe(
						"If true, creates the task as a draft. Draft tasks can be edited but not executed.",
					),
			},
			async (args) => {
				try {
					// Auto-parent: if no parentId provided, default to current agent's task
					const effectiveParentId = args.parentId ?? currentTaskId ?? undefined;

					// Scope validation: agents can only create tasks under themselves or their descendants
					if (
						effectiveParentId &&
						currentTaskId !== null &&
						effectiveParentId !== currentTaskId &&
						!isDescendantOf(tracker, effectiveParentId, currentTaskId)
					) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Cannot create task under ${effectiveParentId}: not your task or descendant`,
								},
							],
							isError: true,
						};
					}

					const opts: { budgetUsd?: number; draft?: boolean } = {};
					if (deps.defaultBudgetUsd) opts.budgetUsd = deps.defaultBudgetUsd;
					if (args.draft) opts.draft = true;
					const node = effectiveParentId
						? tracker.addChild(
								effectiveParentId,
								args.title,
								args.description,
								Object.keys(opts).length > 0 ? opts : undefined,
							)
						: tracker.addTask(
								args.title,
								args.description,
								Object.keys(opts).length > 0 ? opts : undefined,
							);
					await tracker.save();
					broadcastTreeUpdate?.();
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
			"Update the status of a task node. Valid statuses: pending, in_progress, testing, passed, failed.",
			{
				taskId: z.string().describe("Task node ID"),
				status: z
					.enum(["pending", "in_progress", "testing", "passed", "failed"])
					.describe("New status"),
			},
			async (args) => {
				try {
					tracker.updateStatus(args.taskId, args.status);
					await tracker.save();
					broadcastTreeUpdate?.();
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
				"Fire-and-forget: returns immediately after spawning. " +
				"Call yield() to wait for child_complete messages. " +
				"For each task, you can provide instructions and a mode:\n" +
				"- new (default): fresh execution, creates worktree and branch\n" +
				"- resume: continue from previous session (for failed tasks)\n" +
				"- reset: wipe the branch and start fresh (for failed tasks)",
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

				// Validate: draft tasks cannot be executed
				for (const t of args.tasks) {
					const node = tracker.get(t.taskId);
					if (node?.draft) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Error: Task "${node.title}" (${t.taskId}) is a draft and cannot be executed. Remove draft status first.`,
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

				// Spawn all tasks in background (fire-and-forget)
				const spawnedTasks: {
					taskId: string;
					title: string;
					branch: string | null;
				}[] = [];
				const errors: { taskId: string; title: string; error: string }[] = [];

				for (const taskSpec of args.tasks) {
					const node = tracker.get(taskSpec.taskId);
					if (!node) {
						errors.push({
							taskId: taskSpec.taskId,
							title: "?",
							error: "Task not found",
						});
						continue;
					}

					const mode = taskSpec.mode ?? "new";

					// Validate mode vs status
					if (mode === "new" && node.status !== "pending") {
						errors.push({
							taskId: node.id,
							title: node.title,
							error: `Cannot use mode "new" on task with status "${node.status}" — use "resume" or "reset"`,
						});
						continue;
					}
					if (
						(mode === "resume" || mode === "reset") &&
						node.status !== "failed" &&
						node.status !== "stuck"
					) {
						errors.push({
							taskId: node.id,
							title: node.title,
							error: `Cannot use mode "${mode}" on task with status "${node.status}"`,
						});
						continue;
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
							message: taskSpec.message,
						});

						spawnedTasks.push({
							taskId: node.id,
							title: node.title,
							branch: node.branch,
						});

						// Build prompt based on mode
						const memory = readMemory(projectPath);
						let prompt: string;
						const branchReminder = node.branch
							? `\n\nYou are on branch \`${node.branch}\`. Do NOT switch branches.`
							: "";

						if (mode === "resume" && node.sessionId) {
							prompt = taskSpec.message
								? `${taskSpec.message}${branchReminder}`
								: `Continue working. Pick up where you left off.${branchReminder}`;
						} else {
							const taskPrompt = buildTaskPrompt(node, tracker, memory);
							prompt = taskSpec.message
								? `${taskSpec.message}\n\n${taskPrompt}`
								: taskPrompt;
						}

						// Spawn child in background — don't await
						const childRequest: AgentRequest = {
							prompt,
							cwd: node.worktreePath as string,
							systemPrompt: TASK_SYSTEM_PROMPT,
							resumeSessionId:
								mode === "resume" ? (node.sessionId ?? undefined) : undefined,
							model: childModel,
							budgetUsd: node.budgetUsd,
						};

						// Fire-and-forget: spawn child agent in background
						const nodeRef = node;
						(async () => {
							try {
								const result = await executeChildStreaming(
									childRequest,
									nodeRef.id,
									nodeRef.worktreePath as string,
								);

								if (result.sessionId) {
									tracker.assignSession(nodeRef.id, result.sessionId);
								}
								costs.add(result.costUsd, result.turns);
								if (result.costUsd) {
									tracker.updateCost(nodeRef.id, result.costUsd);
								}

								// Check if task exceeded its budget
								const updatedNode = tracker.get(nodeRef.id);
								if (
									updatedNode?.budgetUsd &&
									updatedNode.costUsd &&
									updatedNode.costUsd > updatedNode.budgetUsd
								) {
									emit({
										type: "budget_exceeded",
										taskId: nodeRef.id,
										title: nodeRef.title,
										costUsd: updatedNode.costUsd,
										budgetUsd: updatedNode.budgetUsd,
									});
								}

								let newStatus: "passed" | "failed" | "stuck";
								if (result.success) {
									newStatus = "passed";
									nodeRef.failCount = 0;
								} else {
									nodeRef.failCount = (nodeRef.failCount ?? 0) + 1;
									newStatus = nodeRef.failCount >= 3 ? "stuck" : "failed";
								}
								tracker.updateStatus(nodeRef.id, newStatus);
								await tracker.save();
								emit({
									type: "task_completed",
									taskId: nodeRef.id,
									title: nodeRef.title,
									success: result.success,
								});

								// Enqueue child_complete message to parent's queue
								if (deps.queue) {
									try {
										deps.queue.enqueue({
											source: "child_complete",
											taskId: nodeRef.id,
											title: nodeRef.title,
											success: result.success,
											output: result.output.slice(0, 2000),
										});
									} catch {
										// Queue may be closed if parent already finished
									}
								}
							} catch (e) {
								tracker.updateStatus(nodeRef.id, "stuck");
								await tracker.save();
								const message =
									e instanceof Error ? e.message : "Unknown error";
								emit({
									type: "task_completed",
									taskId: nodeRef.id,
									title: nodeRef.title,
									success: false,
									error: message,
								});

								// Enqueue child_complete (failure) to parent's queue
								if (deps.queue) {
									try {
										deps.queue.enqueue({
											source: "child_complete",
											taskId: nodeRef.id,
											title: nodeRef.title,
											success: false,
											output: `Error: ${message}`,
										});
									} catch {
										// Queue may be closed
									}
								}
							}
						})();
					} catch (e) {
						const message = e instanceof Error ? e.message : "Unknown error";
						errors.push({
							taskId: node.id,
							title: node.title,
							error: message,
						});
					}
				}

				const responseData = {
					status: "spawned",
					spawned: spawnedTasks.length,
					tasks: spawnedTasks,
					...(errors.length > 0 ? { errors } : {}),
				};

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(responseData, null, 2),
						},
					],
					...(errors.length > 0 && spawnedTasks.length === 0
						? { isError: true }
						: {}),
				};
			},
		),

		tool(
			"yield",
			"Suspend execution and wait for messages (child completions, user messages, etc.). " +
				"Call this when you have spawned tasks and are waiting for results. " +
				"Returns all accumulated messages plus a ## Pending summary section. " +
				"Zero token burn while waiting.",
			{},
			async () => {
				if (!deps.queue) {
					return {
						content: [
							{
								type: "text" as const,
								text: "No message queue available",
							},
						],
						isError: true,
					};
				}
				try {
					// Use timeout when there are pending clarifications and clarifyTimeoutMs is set
					const timeoutMs =
						pendingClarifications > 0 ? deps.clarifyTimeoutMs : undefined;
					const result = await deps.queue.waitForMessage(timeoutMs);

					let all: QueueMessage[];

					if (result === "timeout") {
						// Timeout fired — synthesize a clarify_response for all pending clarifications
						const timeoutMsg = `[TIMEOUT] No response received within ${timeoutMs}ms. Proceed with your best judgement.`;
						// Emit clarification_timeout event so the UI knows
						emit({
							type: "clarification_timeout",
							taskId: currentTaskId ?? undefined,
							timeoutMs,
						});
						// Synthesize one clarify_response for each pending clarification
						const synthesized: QueueMessage[] = Array.from(
							{ length: pendingClarifications },
							() => ({
								source: "clarify_response" as const,
								answer: timeoutMsg,
							}),
						);
						pendingClarifications = 0;
						// Also drain any real messages that may have arrived simultaneously
						all = [...synthesized, ...deps.queue.drain()];
					} else {
						// Got a real message — drain any additional messages that accumulated
						const rest = deps.queue.drain();
						all = [result, ...rest];

						// Track clarify_response messages — each one resolves a pending clarification
						for (const msg of all) {
							if (msg.source === "clarify_response") {
								pendingClarifications = Math.max(0, pendingClarifications - 1);
							}
						}
					}

					// Format messages for the agent
					const formatted = all.map(formatQueueMessage).join("\n");

					// Emit queue_message event so the UI can acknowledge pending messages
					if (formatted) {
						emit({
							type: "agent_event",
							taskId: currentTaskId ?? undefined,
							eventType: "queue_message",
							messages: formatted,
						});
					}

					// Build ## Pending summary
					const runningChildren = Array.from(childQueues.keys());
					const runningChildrenText =
						runningChildren.length > 0
							? runningChildren
									.map((id) => {
										const title = tracker.get(id)?.title ?? id;
										return `"${title}" (${id})`;
									})
									.join(", ")
							: "none";
					const clarifyText =
						pendingClarifications > 0 ? String(pendingClarifications) : "none";
					const pendingSection = [
						"",
						"## Pending",
						`- Running children: ${runningChildrenText}`,
						`- Pending clarifications: ${clarifyText}`,
					].join("\n");

					return {
						content: [
							{
								type: "text" as const,
								text: formatted
									? formatted + pendingSection
									: pendingSection.trimStart(),
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [
							{
								type: "text" as const,
								text: `Queue error: ${message}`,
							},
						],
						isError: true,
					};
				}
			},
		),

		tool(
			"send_message_to_child",
			"Send a message to a running child agent. " +
				"The message appears in the child's queue as a parent_update.",
			{
				taskId: z.string().describe("ID of the running child task to message"),
				message: z.string().describe("Message content to send"),
			},
			async (args) => {
				const childQueue = childQueues.get(args.taskId);
				if (!childQueue) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: No running child with taskId "${args.taskId}". The child may have already completed or not been spawned yet.`,
							},
						],
						isError: true,
					};
				}
				try {
					childQueue.enqueue({
						source: "parent_update",
						content: args.message,
					});
					return {
						content: [
							{
								type: "text" as const,
								text: `Message sent to child ${args.taskId}`,
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [
							{
								type: "text" as const,
								text: `Error sending message: ${message}`,
							},
						],
						isError: true,
					};
				}
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
					broadcastTreeUpdate?.();

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

		tool(
			"clarify",
			"Ask a clarification question and send it to the user or parent orchestrator. " +
				"Returns immediately — you can continue doing other work that doesn't need the answer, " +
				"then call yield() when ready to wait for the clarify_response. " +
				"Only use this for genuine ambiguities that could lead to wasted work.",
			{
				question: z
					.string()
					.describe(
						"The clarification question to ask the user or parent orchestrator",
					),
			},
			async (args) => {
				const taskId = currentTaskId ?? "orchestrator";

				// Track this as a pending clarification — decremented in yield() when clarify_response arrives
				pendingClarifications++;

				emit({
					type: "clarification_requested",
					taskId,
					question: args.question,
				});

				return {
					content: [
						{
							type: "text" as const,
							text: "Question sent. You can continue working on other things that don't need the answer, then call yield() when ready to receive the clarify_response.",
						},
					],
				};
			},
		),

		tool(
			"report_to_parent",
			"Send a progress update or status message to your parent agent. " +
				"Non-blocking: returns immediately. " +
				"The parent receives this as a child_report message when it calls yield(). " +
				"Use this to keep the parent informed about important intermediate progress, " +
				"blockers, or results without waiting for acknowledgement.",
			{
				message: z
					.string()
					.describe("The message content to send to the parent agent"),
			},
			async (args) => {
				if (!deps.parentQueue) {
					// No parent queue — silently no-op (top-level orchestrator has no parent)
					return {
						content: [
							{
								type: "text" as const,
								text: "No parent agent to report to (you are the top-level orchestrator). Message dropped.",
							},
						],
					};
				}

				const node = currentTaskId ? tracker.get(currentTaskId) : null;
				const taskTitle = node?.title ?? "unknown";

				try {
					deps.parentQueue.enqueue({
						source: "child_report",
						taskId: currentTaskId ?? "unknown",
						title: taskTitle,
						content: args.message,
					});
					return {
						content: [
							{
								type: "text" as const,
								text: "Message reported to parent agent.",
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [
							{
								type: "text" as const,
								text: `Error reporting to parent: ${message}`,
							},
						],
						isError: true,
					};
				}
			},
		),

		tool(
			"done",
			"Signal that you have finished working on your task. " +
				"Call this when you are done — either passed (task completed successfully) or failed (you cannot continue). " +
				"This is the proper way to exit. Do NOT just stop responding — always call done().",
			{
				status: z
					.enum(["passed", "failed"])
					.describe("Whether the task passed or failed"),
				summary: z
					.string()
					.describe(
						"Brief summary of what was accomplished (if passed) or what went wrong (if failed)",
					),
			},
			async (args) => {
				if (doneRef) {
					doneRef.done = { status: args.status, summary: args.summary };
				}
				return {
					content: [
						{
							type: "text" as const,
							text: `Task marked as ${args.status}. ${args.status === "passed" ? "Good work!" : "Returning to parent for guidance."}`,
						},
					],
				};
			},
		),
	];

	const mcpServer = createSdkMcpServer({
		name: "opengraft",
		version: "0.1.0",
		tools: toolDefs,
	});

	return {
		mcpServer,
		toolDefs,
		hasRunningChildren: () => childQueues.size > 0,
	};
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

/** @internal Exported for testing */
export function buildTaskPrompt(
	node: {
		id: string;
		title: string;
		description: string;
		parentId: string | null;
		branch?: string | null;
		worktreePath?: string | null;
		budgetUsd?: number;
	},
	tracker: TaskTracker,
	memory: string,
): string {
	const parts: string[] = [];

	if (memory) {
		parts.push("## Project Memory", memory, "");
	}

	parts.push(`# Task: ${node.title}`);
	parts.push(`Task ID: \`${node.id}\``);
	if (node.budgetUsd) {
		parts.push(
			`**Budget: ${"$"}${node.budgetUsd.toFixed(2)}** — you will be warned at 80% and must wrap up at 100%.`,
		);
	}
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
		"4. If you discover something important, append it to `.opengraft/memory.md` using edit_file (match last lines + extend) or bash `echo >> .opengraft/memory.md`. Never use write_file on memory.md — it duplicates content.",
		"5. Commit all changes (including memory updates) when all checks pass.",
	);

	return parts.join("\n");
}

/** @internal Exported for testing */
export function slugify(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 30);
}
