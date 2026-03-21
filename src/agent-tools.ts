import { pinyin } from "pinyin-pro";
import { z } from "zod";
import type { AgentProvider } from "./agent-provider.ts";

import type { EventStore } from "./event-store.ts";
import { formatEventForAI, queueMessageToEvent } from "./events.ts";
import {
	globalAgentQueues,
	type MessageQueue,
	type QueueMessage,
} from "./message-queue.ts";
import { clearPersistedMessages } from "./persistent-queue.ts";
import type { ProjectManager } from "./project-manager.ts";
import type { TaskTracker } from "./task-tracker.ts";
import { type ToolDefinition, tool } from "./tool-definition.ts";
import type { WorktreeManager } from "./worktree-manager.ts";

/** Named color → hex mapping for agent tools. Accepts common names and converts to hex. */
const NAMED_COLORS: Record<string, string> = {
	red: "#f85149",
	blue: "#388bfd",
	green: "#3fb950",
	yellow: "#d29922",
	purple: "#a371f7",
	orange: "#f0883e",
	gray: "#768390",
};

/** Resolve a color value: converts named colors to hex, passes hex through. */
export function resolveColor(color: string): string {
	return NAMED_COLORS[color.toLowerCase()] ?? color;
}

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
 * Collect all descendant node IDs of a given ancestor (breadth-first).
 * Includes direct children, grandchildren, etc.
 */
export function getDescendantIds(
	tracker: TaskTracker,
	ancestorId: string,
): string[] {
	const result: string[] = [];
	const queue = [...(tracker.get(ancestorId)?.children ?? [])];
	while (queue.length > 0) {
		// biome-ignore lint/style/noNonNullAssertion: length > 0 guarantees shift returns a value
		const id = queue.shift()!;
		result.push(id);
		const node = tracker.get(id);
		if (node?.children?.length) {
			queue.push(...node.children);
		}
	}
	return result;
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
	const evt = queueMessageToEvent(msg);
	const time = new Date(evt.ts).toLocaleTimeString("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
	return `[${time}] ${formatEventForAI(evt)}`;
}

/** Convert a QueueMessage to a simplified { source, content } for structured WS events. */
export function toRawMessage(msg: QueueMessage): {
	source: string;
	content: string;
	id?: string;
	images?: { base64: string; mediaType: string }[];
} {
	switch (msg.source) {
		case "child_complete":
			return {
				source: msg.source,
				content: `Task "${msg.title}" (${msg.taskId}) ${msg.success ? "passed" : "failed"}: ${msg.output.slice(0, 500)}`,
			};
		case "user":
			return {
				source: msg.source,
				content: msg.content,
				...(msg.id ? { id: msg.id } : {}),
				...(msg.images?.length ? { images: msg.images } : {}),
			};
		case "system":
			return { source: msg.source, content: msg.content };
		case "parent_update":
			return { source: msg.source, content: msg.content };
		case "clarify_response":
			return { source: msg.source, content: msg.answer };
		case "child_report":
			return {
				source: msg.source,
				content: `From child "${msg.title}" (${msg.taskId}): ${msg.content}`,
			};
		case "cross_project":
			return {
				source: msg.source,
				content: `From project "${msg.fromProjectName}" (${msg.fromProjectId}): ${msg.content}`,
			};
		case "background_complete":
			return {
				source: msg.source,
				content: `Command "${msg.command}" (${msg.commandId}): exit=${msg.exitCode}, duration=${msg.durationMs}ms. Use read_file on output files to see results.`,
			};
		case "compact":
			return { source: msg.source, content: "Manual compaction requested" };
	}
}

/**
 * Shared orchestration knowledge — every agent gets this because any agent
 * can become an orchestrator if it judges a task is too complex.
 */
export const ORCHESTRATION_KNOWLEDGE = `## Orchestration Tools (via MCP server "opengraft")
- get_tree: View the current task tree (always check this first)
- create_task: Create tasks (omit parentId to create under your own task, or provide parentId for a specific parent)
- update_task: Update a task's status, title, description, or draft state
- send_message_to_child: The universal way to start, wake, or message a child task.
  Sending a message to a task IS starting it. One call per task for parallel launches.
  Auto-creates worktree and launches agent if not running. If already running, delivers message.
  The message parameter is the prompt for new tasks, or instructions for running ones.
  When changing a child's scope or requirements, be explicit about what's overridden:
  - State "This overrides your original scope" when expanding or changing what the child should do
  - Say "You are now authorized to also modify X, Y, Z files" when granting access beyond original scope
  - Don't just relay information — make it clear which original constraints are lifted or changed
  - The child treats parent_update messages as authoritative, so be precise about what's new vs unchanged
- yield: Suspend execution and wait for messages (child completions, user messages, clarify responses).
  Call this after starting tasks. Returns all accumulated messages plus a "## Pending" summary section
  showing running children and pending clarifications. Zero token burn while suspended.
- reorder_tasks: Reorder children of a task node. Pass the parent nodeId and an array of child IDs in the desired order.
- close_task: Clean up a child's worktree + branch after merging. Node and session preserved. Status set to 'closed'.
  Use after merging a passed child, or to defer a task and reclaim disk space.
- delete_task: Full removal — deletes worktree, session file, and task node from the tree. Use for abandoned tasks.
- reset_task: Remove worktree + session file but keep node. Sets status to pending. Use to start over with a different approach.
- clarify: Send a clarification question to the user. Returns immediately —
  you can continue doing other work that doesn't need the answer, then call yield() when ready
  to wait for the clarify_response.
- done: Signal that you have finished your task. Call done(status, summary) with status "passed" or "failed".
  This is the proper way to exit — always call done() when you're finished.
- report_to_parent: Send a progress update or status message to your parent agent. Non-blocking.
  The parent receives this as a child_report message when it calls yield().
  Use this to keep the parent informed about important intermediate progress or issues.
  When to call: after completing major milestones, or when you discover something that affects siblings.
  Don't call it for every small action — only significant events worth surfacing.
- list_projects: List all registered projects with their IDs, names, paths, and active agent status.
  Use this to discover other projects before sending cross-project messages.
- send_message_to_project: Send a message to the orchestrator of another project.
  The target project must have an active agent running. The message arrives as a cross_project
  message in the target orchestrator's queue (visible via yield()).

## Draft Tasks
- Create tasks with \`draft: true\` to quickly capture ideas, requirements, and half-formed thoughts. They get status="draft".
- Draft tasks cannot be executed — they serve as a scratch pad for future work.
- Use \`update_task(taskId, { draft: false })\` or \`update_task(taskId, { status: "pending" })\` to mark a draft ready for execution.
- **ALWAYS draft when the user mentions ANY idea, bug, or feature** — even mid-conversation. Don't wait
  for them to say "create a task". If they mention something worth doing, draft it immediately.
- Better to over-create drafts than to lose an idea. Drafts are cheap, lost context is expensive.
- When receiving multiple requirements at once, create drafts for ones needing more discussion, execute the clear ones.
- Draft titles should be descriptive enough to understand later without context.

## Event-Driven Workflow Pattern
1. Analyze the goal and the codebase (read files to understand structure and scope)
2. Create tasks using create_task (omit parentId to create under your own task)
   - Write detailed task descriptions (see "Task Decomposition" in orchestrator system prompt)
   - Sibling tasks run in PARALLEL — plan their scope to minimize merge conflicts
3. Call send_message_to_child for each task to start it (one call per task, returns immediately)
   - The message becomes the agent's prompt. Include any extra instructions beyond the task description.
   - Worktree creation and agent launch happen automatically.
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
   b. Call close_task(taskId) to clean up the child's worktree and branch (node stays in tree for history)
8. If a child fails: distinguish daemon-restart failures (child was interrupted, work may be complete) from genuine failures (child called done("failed")). **Always resume first** (send_message_to_child) — the child can assess its own state. Only reset_task when the approach was fundamentally wrong.
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

If you're unsure about a requirement, use \`clarify\` to ask the user (returns immediately, continue working).
If you encounter problems you can't overcome, call done("failed", ...) — failing early is better than spinning.

### Progress Updates
During execution, use \`report_to_parent\` 1-2 times to share progress — especially after completing a major phase or making a significant design decision. If you're unsure about a design decision or how to interpret the task — use \`report_to_parent\` with requestReply: true to ask your parent. Don't go in circles guessing. The parent has context and can answer quickly. A wrong approach wastes tokens and the task may be rejected. Asking is cheap, rework is expensive.

### Before calling done("passed") — self-verification checklist
Before marking a task as passed, verify EVERY item in the task description is complete:
- Re-read the task description (title + description from the task tree)
- Check each numbered phase/requirement — did you implement it?
- If the task says "Phase A, Phase B, Phase C" — all three must be done, not just A and B
- "Tests pass" is necessary but NOT sufficient — it proves nothing is broken, not that everything is built
- If you can't complete all requirements, call done("failed") and explain what's missing
- Partial completion is NEVER "passed" — it's "failed" with a clear status report

### Parent Handling of Child Results
- **passed** → \`git merge --no-ff <branch>\` → \`close_task\` (cleans worktree/branch, keeps node) → verify tests on your branch
- **failed** → **Always resume first.** Send \`send_message_to_child\` immediately — the child knows its own state.
  **NEVER check git log, commits, or branch state to decide what to do.** The child may have:
  uncommitted file changes, completed everything but not committed, or done significant planning/analysis
  in its session context without touching any files. All of these represent valuable work. Only the child can assess this.
  - **Daemon restart**: Children get marked "failed" when the daemon restarts — even if they finished their work.
    Resume them so they can check their own state, commit if needed, and call done().
  - **Genuine failure**: The child reported done("failed") with an explanation. Read the summary carefully.
    - **Resume** (default): Send another \`send_message_to_child\` with SPECIFIC instructions addressing the failure.
      Don't just say "try again" — explain what went wrong and how to fix it. The child keeps its progress.
    - **Reset** (last resort): Call \`reset_task\` first, then \`send_message_to_child\` to start fresh.
      Only when the approach was fundamentally wrong and you want to start over from scratch.
  - If the failure reveals a scope issue: delete the task and create new tasks with better boundaries.

### Merge Protocol
- Use \`git merge --no-ff <branch> -m "Merge task: <title>"\` from YOUR working directory
- If merge conflicts occur: resolve them with edit_file. This is expected with parallel work.
- If conflicts are too complex: merge the larger/more complex feature first, then reset_task and re-send to the simpler one.
- After successful merge: ALWAYS call close_task to clean up worktree + branch (node stays in tree)
- After merging a child, if other children are still running, send them a message via
  send_message_to_child to sync with main: "Main updated — run \`git merge main\`
  to stay in sync and reduce merge conflicts."
  Only do this if you merged substantial changes that could affect sibling work.
- After ALL merges: run full test suite to catch integration issues
- Intermediate merges may not typecheck (e.g., types merged but implementors not yet).
  Use \`--no-verify\` for intermediate commits. The final state MUST pass all hooks.

## Responsibilities at Each Level
Every agent can be both a dispatcher (creating child tasks) and an implementer (doing work):

**As an implementer** (when YOU are doing the work):
- done("passed") means EVERY requirement in the task description is complete — not most, ALL of them
- Before calling done(), re-read your task description and verify each item
- If you completed part of the work, call done("failed") with a clear status of what's done vs missing
- Your parent trusts your done() signal to decide whether to merge — false positives waste time and create bugs

**As a dispatcher** (when you CREATE child tasks):
- Write precise, verifiable task descriptions with explicit deliverables
- After a child reports "passed", verify deliverables against the diff before merging
- The child may have interpreted the task differently or missed items — catch it at review
- If verification reveals gaps, send the child back with specific instructions

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
- You can only start/message your own descendants — no skipping to unrelated tasks
- Split by module/feature boundary, NOT by step (e.g. "auth module" vs "payment module")
- Keep the tree shallow: 2-3 levels max
- Each leaf task should be independently executable by a single agent session
- ALWAYS merge and close_task each passed child before moving on (nodes remain visible in tree)

## Parallelization Strategy
- Sibling tasks run in PARALLEL. Split by sub-feature so each has a clear scope.
- Some file overlap is OK if the changes are in different areas (e.g., each adding a new UI component).
  Merge conflicts from parallel work are normal — resolve them.
- When specifying child tasks, tell each child whether its task is independently compilable/testable,
  or whether it depends on sibling outputs (and if so, what to expect).
- If a merge conflict is too complex to resolve: merge the more complex/larger feature first,
  then \`reset_task\` + \`send_message_to_child\` the simpler feature so it rebuilds on top of the merged code.

## Multi-Phase Tasks
When a task has multiple phases (e.g., "Phase 1: types, Phase 2: implementation, Phase 3: tests"):
- Create ALL phase sub-tasks upfront under the parent task, not just the current phase
- Execute phases in order (or parallel where possible)
- Keep the parent task open (pending/in_progress) until ALL phases are complete
- Only close the parent when every phase is done
- Each phase's completion status is independent — a phase can be closed while the parent stays open

## Reusable Worker Pattern
To assign multiple sequential tasks to the same agent without spawning new ones:
1. Start child via send_message_to_child with initial instructions
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
1. **Failed children** → Analyze output, send_message_to_child to resume (give instructions) or reset_task first
2. **Passed children not yet merged** → Merge branch, close_task (cleans resources, keeps node), verify tests
3. **Pending children ready to start** → send_message_to_child to spawn them
4. **All children done** → Run full test suite, verify integration, update memory
5. **Everything complete** → Call done("passed", summary)

## Never-Stop Principle (CRITICAL — especially after context compaction)
You stop ONLY when ALL tasks are resolved (all passed/merged) and you have nothing left to do.
After compaction, you will see a checkpoint — treat it as your TODO list and keep driving.

- If you need clarification: make your best judgement, note the decision in memory, and proceed.
- If technically blocked: try a different approach. If that fails too, call done("failed", ...).
- If some children failed: address them (resume/reset) before stopping.
- Do NOT stop just because you finished responding — call get_tree and keep driving.
- After compaction: read the checkpoint's "Pending Work" and "Next Action" — then DO them.

## Output Efficiency
Be concise. Don't narrate — act. When thinking through a plan, keep it brief. Don't repeat
information from memory.md or the task tree back. Your token budget matters.

## Agent-to-Agent Communication
Keep report_to_parent and send_message_to_child messages concise plain text. No markdown. These are internal communications.`;

export const TASK_SYSTEM_PROMPT = `Today's date is ${new Date().toISOString().split("T")[0]}.

You are an autonomous programming agent working on a subtask in a git worktree.
You can implement code directly (worker role), OR if the task is too complex, decompose it into
subtasks and delegate to child agents (sub-orchestrator role). Use your judgement.
When acting as sub-orchestrator: do NOT write code yourself — only manage child agents.

**MANDATORY**: When you finish your task, you MUST call done("passed", summary) or done("failed", summary).
Never just stop responding — the parent agent is waiting for your done() signal to proceed.

When a user or parent provides an explicit instruction, suggestion, or request, execute it directly as stated. Do not reinterpret, rephrase, or second-guess explicit instructions.

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
  **foreground_timeout**: Controls how long to wait before backgrounding. Default = timeout (fully foreground).
  Use 0 for fire-and-forget (e.g. starting servers). Background completions arrive as messages on your next yield() or tool call.
  **Background management**: Use bg_action ('kill' or 'status') with background_id to manage backgrounded processes.
  Foreground commands automatically track CWD (cd updates persist across calls). Background commands
  (foreground_timeout=0 or exceeded foreground_timeout) do NOT affect CWD — your working directory stays unchanged.
  You can read_file on the output file paths for partial output.
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
1. Read \`.opengraft/memory.md\` and the task description carefully. Also read \`CLAUDE.md\` if it exists.
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

## Environment Files in Worktrees
- Child worktrees don't have gitignored files (.env, .dev.vars, etc.)
- Prefer mock-based tests that don't need real credentials
- If a child truly needs env files: copy them with bash before or after launching
  (the worktree path is in the task tree), then inform the child via send_message_to_child

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

## Parent Messages (parent_update)
- Messages from your parent agent (received as parent_update) are **authoritative** and override your original task description.
- If the parent expands your scope or authorizes you to modify additional files, follow those instructions without hesitation — they supersede the original task boundaries.
- Don't worry about exceeding your original scope when the parent explicitly authorizes it.

## Communication with Parent
- When facing complex design decisions, architectural questions, or uncertainty about approach, use report_to_parent(message, requestReply=true) to discuss BEFORE implementing.
- The parent has broader context about the project and other running tasks — leverage it.
- Multi-round discussion is encouraged: report_to_parent → yield → receive parent response → proceed.
- Don't try to solve everything alone. If you're unsure or stuck, ask rather than guess.
- When the parent sends you a message with requestReply=true, always respond via report_to_parent.

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
	/**
	 * Dynamic parent queue lookup — called at invocation time, not captured at launch.
	 * Returns the nearest ancestor's queue, or undefined for top-level orchestrator.
	 */
	getParentQueue?: () => MessageQueue | undefined;
	/** Default budget per task from project config. undefined = unlimited. */
	defaultBudgetUsd?: number;
	/** Timeout for clarify() responses in ms. undefined = wait forever. */
	clarifyTimeoutMs?: number;
	/** Maximum recursive depth for spawning child agents. Defaults to 3. */
	maxDepth?: number;
	/** Project manager for cross-project communication. Only needed at depth 0. */
	projectManager?: ProjectManager;
	/**
	 * Check if a project has an active agent running. Only needed at depth 0.
	 * Uses globalAgentQueues to check if root node has a queue.
	 */
	isProjectActive?: (projectId: string) => boolean;
	/**
	 * Find the root queue for a project by looking up its rootNodeId in globalAgentQueues.
	 * Only needed at depth 0 for cross-project message delivery.
	 */
	getProjectRootQueue?: (projectId: string) => MessageQueue | undefined;
	/** Current project ID — used as sender identity for cross-project messages. */
	currentProjectId?: string;
	/** EventStore for JSONL event persistence. Used to clear session data on reset/delete. */
	eventStore?: EventStore;
	/** Data directory root (~/.opengraft). Used for persistent message queue. */
	dataDir?: string;
	/**
	 * Deliver a message to a task: persist → enqueue (if running) → launch (if not).
	 * Daemon provides this via the deliverMessage function in agent-lifecycle.ts.
	 */
	deliverMessage?: (nodeId: string, message: QueueMessage) => Promise<void>;
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

/** Result of createOrchestratorTools — raw tool definitions for provider forwarding. */
export interface OrchestratorToolsResult {
	/** Raw tool definitions for provider forwarding. */
	// biome-ignore lint/suspicious/noExplicitAny: ToolDefinition generic is not narrowable here
	toolDefs: ToolDefinition<any>[];
	/** Returns true if this agent has running children (checked via globalAgentQueues). */
	hasRunningChildren?: () => boolean;
}

/**
 * Create orchestrator tools for the main agent.
 * Returns both an MCP server (for Claude Code provider) and raw tool definitions
 * (for AnthropicCompatibleProvider to forward as Anthropic API tools).
 */
export function createOrchestratorTools(
	deps: OrchestratorToolsDeps,
): OrchestratorToolsResult {
	const { tracker, worktrees, projectPath, onTaskEvent, broadcastTreeUpdate } =
		deps;
	const currentTaskId = deps.currentTaskId ?? null;
	const emit = (event: Record<string, unknown>) => onTaskEvent?.(event);
	/** Count of outstanding clarify() calls that have not yet received a clarify_response. */
	let pendingClarifications = 0;

	/**
	 * Shared yield logic: wait for messages on the queue, handle compact signals,
	 * clarify timeouts, emit idle/active events, and return formatted result.
	 * Used by both yield() and done() tools.
	 * Returns null if no queue is available.
	 */
	async function waitForQueueMessages(): Promise<{
		content: Array<
			| { type: "text"; text: string }
			| { type: "image"; data: string; mimeType: string }
		>;
		isError?: boolean;
		_consumedMessageIds?: string[];
		_formattedQueueMessages?: string;
		_pending?: {
			runningChildren: Array<{ id: string; title: string }>;
			pendingClarifications: number;
		};
	} | null> {
		if (!deps.queue) return null;
		try {
			let all: QueueMessage[];

			while (true) {
				if (currentTaskId) {
					deps.queue.idle = true;
					emit({ type: "agent_idle", taskId: currentTaskId });
				}

				const timeoutMs =
					pendingClarifications > 0 ? deps.clarifyTimeoutMs : undefined;
				const result = await deps.queue.waitForMessage(timeoutMs);

				if (result === "timeout") {
					const timeoutMsg = `<clarify_timeout duration="${timeoutMs}ms">No response received. Proceed with your best judgement.</clarify_timeout>`;
					emit({
						type: "clarification_timeout",
						taskId: currentTaskId ?? undefined,
						timeoutMs,
					});
					const synthesized: QueueMessage[] = Array.from(
						{ length: pendingClarifications },
						() => ({
							source: "clarify_response" as const,
							answer: timeoutMsg,
						}),
					);
					pendingClarifications = 0;
					all = [...synthesized, ...deps.queue.drainMerged()];
				} else {
					const rest = deps.queue.drainMerged();
					all = [result, ...rest];
					for (const msg of all) {
						if (msg.source === "clarify_response") {
							pendingClarifications = Math.max(0, pendingClarifications - 1);
						}
					}
				}

				const compactMsgs = all.filter((m) => m.source === "compact");
				all = all.filter((m) => m.source !== "compact");
				if (compactMsgs.length > 0) {
					for (const cm of compactMsgs) {
						deps.queue.enqueue(cm);
					}
					break;
				}
				if (all.length > 0) break;
			}

			if (currentTaskId) {
				deps.queue.idle = false;
				emit({ type: "agent_active", taskId: currentTaskId });
			}

			const formatted = all.map(formatQueueMessage).join("\n");
			if (formatted) {
				emit({
					type: "agent_event",
					taskId: currentTaskId ?? undefined,
					eventType: "queue_message",
					messages: formatted,
					rawMessages: all.map(toRawMessage),
				});
			}

			const completedIds = new Set(
				all
					.filter(
						(m): m is Extract<QueueMessage, { source: "child_complete" }> =>
							m.source === "child_complete",
					)
					.map((m) => m.taskId),
			);
			const myDescendants = currentTaskId
				? getDescendantIds(tracker, currentTaskId)
				: [];
			const runningChildren = myDescendants.filter(
				(id) => globalAgentQueues.has(id) && !completedIds.has(id),
			);
			// Build structured pending data
			const runningChildrenData = runningChildren.map((id) => ({
				id,
				title: tracker.get(id)?.title ?? id,
			}));
			const pendingData = {
				runningChildren: runningChildrenData,
				pendingClarifications,
			};

			const runningChildrenText =
				runningChildrenData.length > 0
					? runningChildrenData.map((c) => `"${c.title}" (${c.id})`).join(", ")
					: "none";
			const clarifyText =
				pendingClarifications > 0 ? String(pendingClarifications) : "none";
			const pendingSection = [
				"",
				"## Pending",
				`- Running children: ${runningChildrenText}`,
				`- Pending clarifications: ${clarifyText}`,
			].join("\n");

			const imageBlocks: Array<{
				type: "image";
				data: string;
				mimeType: string;
			}> = [];
			for (const msg of all) {
				if (msg.source === "user" && msg.images) {
					for (const img of msg.images) {
						imageBlocks.push({
							type: "image",
							data: img.base64,
							mimeType: img.mediaType,
						});
					}
				}
			}

			// Write structured message events to JSONL for each consumed queue message.
			// The provider writes tool_result + standalone messages_consumed events.
			const consumedIds: string[] = [];
			const sessionId = currentTaskId ?? "orchestrator";
			for (const msg of all) {
				if (msg.source === "user" && msg.id) {
					// User messages are already written to JSONL at send time
					consumedIds.push(msg.id);
				} else {
					const evt = queueMessageToEvent(msg);
					const evtId = (evt as { id?: string }).id;
					if (evtId) consumedIds.push(evtId);
					// Write the structured message event to JSONL
					if (deps.eventStore) {
						deps.eventStore.append(sessionId, evt);
					}
				}
			}

			return {
				content: [
					{
						type: "text" as const,
						text: pendingSection.trimStart(),
					},
					...imageBlocks,
				],
				...(consumedIds.length > 0 ? { _consumedMessageIds: consumedIds } : {}),
				...(formatted ? { _formattedQueueMessages: formatted } : {}),
				_pending: pendingData,
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
				color: z
					.string()
					.optional()
					.describe(
						"Optional color label for visual categorization (e.g. 'red', 'blue', 'green', 'yellow', 'purple', 'orange', 'gray' or hex like '#ff5733'). " +
							"Categories: Bug=red, Feature=blue, Refactor=green, Optimization=yellow, Research=purple, Chore=gray.",
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

					const opts: {
						budgetUsd?: number;
						draft?: boolean;
						editedBy: "agent";
					} = { editedBy: "agent" };
					if (deps.defaultBudgetUsd) opts.budgetUsd = deps.defaultBudgetUsd;
					if (args.draft) opts.draft = true;
					const node = effectiveParentId
						? tracker.addChild(
								effectiveParentId,
								args.title,
								args.description,
								opts,
							)
						: tracker.addTask(args.title, args.description, opts);
					if (args.color) {
						tracker.updateColor(node.id, resolveColor(args.color), "agent");
					}
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
			"update_task",
			"Update a task node. All fields except taskId are optional — provide only the fields you want to change.",
			{
				taskId: z.string().describe("Task node ID"),
				status: z
					.enum([
						"draft",
						"pending",
						"in_progress",
						"testing",
						"passed",
						"failed",
						"closed",
					])
					.optional()
					.describe("New status"),
				title: z.string().optional().describe("New title"),
				description: z.string().optional().describe("New description"),
				draft: z
					.boolean()
					.optional()
					.describe(
						"Set draft flag. true = status becomes 'draft', false = status becomes 'pending'.",
					),
				parentId: z
					.string()
					.optional()
					.describe(
						"New parent task ID. Moves the task under this parent (reparent).",
					),
				color: z
					.string()
					.optional()
					.describe(
						"Color label for visual categorization (e.g. 'red', 'blue', 'green', 'yellow', 'purple', 'orange', 'gray' or hex). " +
							"Categories: Bug=red, Feature=blue, Refactor=green, Optimization=yellow, Research=purple, Chore=gray.",
					),
			},
			async (args) => {
				try {
					if (args.parentId !== undefined) {
						// Scope validation: agent can only reparent tasks under itself or its descendants
						if (
							currentTaskId !== null &&
							args.taskId !== currentTaskId &&
							!isDescendantOf(tracker, args.taskId, currentTaskId)
						) {
							return {
								content: [
									{
										type: "text" as const,
										text: `Cannot reparent ${args.taskId}: not your task or descendant`,
									},
								],
								isError: true,
							};
						}
						if (
							currentTaskId !== null &&
							args.parentId !== currentTaskId &&
							!isDescendantOf(tracker, args.parentId, currentTaskId)
						) {
							return {
								content: [
									{
										type: "text" as const,
										text: `Cannot reparent under ${args.parentId}: not your task or descendant`,
									},
								],
								isError: true,
							};
						}
						tracker.reparent(args.taskId, args.parentId);
					}
					if (args.status !== undefined) {
						tracker.updateStatus(args.taskId, args.status, "agent");
					}
					if (args.title !== undefined) {
						tracker.updateTitle(args.taskId, args.title, "agent");
					}
					if (args.description !== undefined) {
						tracker.updateDescription(args.taskId, args.description, "agent");
					}
					if (args.draft !== undefined) {
						tracker.updateStatus(
							args.taskId,
							args.draft ? "draft" : "pending",
							"agent",
						);
					}
					if (args.color !== undefined) {
						tracker.updateColor(
							args.taskId,
							args.color ? resolveColor(args.color) : null,
							"agent",
						);
					}
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
			"yield",
			"Suspend execution and wait for messages (child completions, user messages, etc.). " +
				"Call this when you have spawned tasks and are waiting for results. " +
				"Returns all accumulated messages plus a ## Pending summary section. " +
				"Zero token burn while waiting.",
			{},
			async () => {
				const result = await waitForQueueMessages();
				if (!result) {
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
				return result;
			},
		),

		tool(
			"send_message_to_child",
			"Send a message to a child task — starts it if not running. " +
				"If the task has no worktree, one is auto-created. " +
				"If no agent is running, one is launched with the message as the prompt. " +
				"If the agent is already running, the message is delivered to its queue. " +
				"Call once per task for parallel launches.",
			{
				taskId: z.string().describe("ID of the child task to message or start"),
				message: z
					.string()
					.describe(
						"Message content — becomes the prompt for new tasks, or instructions for running ones",
					),
				requestReply: z
					.boolean()
					.optional()
					.describe(
						"If true, signals to the child that a reply (via report_to_parent) is expected.",
					),
			},
			async (args) => {
				// Validate: task exists and is a descendant
				const node = tracker.get(args.taskId);
				if (!node) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: Task "${args.taskId}" not found.`,
							},
						],
						isError: true,
					};
				}
				if (
					currentTaskId !== null &&
					args.taskId !== currentTaskId &&
					!isDescendantOf(tracker, args.taskId, currentTaskId)
				) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: Task "${args.taskId}" is not your descendant.`,
							},
						],
						isError: true,
					};
				}
				if (node.status === "draft") {
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: Task "${node.title}" (${args.taskId}) is a draft and cannot be started. Remove draft status first.`,
							},
						],
						isError: true,
					};
				}

				try {
					// Create worktree if needed (requires clean working tree)
					if (!node.worktreePath) {
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
						const currentNode = currentTaskId
							? tracker.get(currentTaskId)
							: undefined;
						const baseBranch = currentNode?.branch ?? undefined;
						const slug = slugify(node.title);
						const wt = await worktrees.create(node.id, slug, baseBranch);
						tracker.assignWorktree(node.id, wt.branch, wt.path);
					}

					// Deliver message via unified path: persist → enqueue/launch
					// The message is NOT included in the launch prompt — it arrives
					// via queue drain of persisted messages (exactly-once delivery).
					const queueMessage: QueueMessage = {
						source: "parent_update",
						content: args.message,
						...(args.requestReply ? { requestReply: true } : {}),
					};

					if (deps.deliverMessage) {
						await deps.deliverMessage(args.taskId, queueMessage);
					} else {
						// Fallback for non-daemon contexts (tests without full daemon):
						// direct queue delivery only
						const existingQueue = globalAgentQueues.get(args.taskId);
						if (existingQueue) {
							existingQueue.enqueue(queueMessage);
						}
					}

					const wasRunning = globalAgentQueues.has(args.taskId);
					return {
						content: [
							{
								type: "text" as const,
								text: wasRunning
									? `Message sent to running child "${node.title}" (${args.taskId})`
									: `Started child "${node.title}" (${args.taskId}) on branch ${node.branch}`,
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [
							{
								type: "text" as const,
								text: `Error starting child: ${message}`,
							},
						],
						isError: true,
					};
				}
			},
		),

		tool(
			"close_task",
			"Clean up a child task's worktree and branch to reclaim disk space. " +
				"Node and session are preserved — status set to 'closed'. " +
				"Call this AFTER you have already merged the child's branch yourself. " +
				"Use for merged tasks or deferred tasks where you want to free resources.",
			{
				taskId: z.string().describe("ID of the task to close"),
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
					// Close running agent if active
					// Delete from registry first so callers see "no queue" not "closed queue"
					const activeQueueClose = globalAgentQueues.get(args.taskId);
					if (activeQueueClose) {
						globalAgentQueues.delete(args.taskId);
						activeQueueClose.close();
					}

					// Clean up worktree + branch if they exist
					if (node.worktreePath && node.branch) {
						const slug = slugify(node.title);
						await worktrees.remove(node.id, slug);
						node.worktreePath = null;
						node.branch = null;
						node.updatedAt = new Date().toISOString();
					}

					tracker.updateStatus(node.id, "closed");
					await tracker.save();
					broadcastTreeUpdate?.();

					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify(
									{
										closed: true,
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
			"delete_task",
			"Fully remove a child task — deletes worktree, session file, and task node from the tree. " +
				"Use for abandoned tasks you no longer need.",
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
					// Close running agent if active
					// Delete from registry first so callers see "no queue" not "closed queue"
					const activeQueueDelete = globalAgentQueues.get(args.taskId);
					if (activeQueueDelete) {
						globalAgentQueues.delete(args.taskId);
						activeQueueDelete.close();
					}

					// Clean up worktree + branch if they exist
					if (node.worktreePath && node.branch) {
						const slug = slugify(node.title);
						await worktrees.remove(node.id, slug);
					}

					// Delete event JSONL files
					if (deps.eventStore && node.id) {
						deps.eventStore.clear(node.id);
					}

					// Clear persisted messages for this task and all descendants
					if (deps.dataDir && deps.currentProjectId) {
						const dd = deps.dataDir;
						const pid = deps.currentProjectId;
						const collectIds = (id: string): string[] => {
							const n = tracker.get(id);
							if (!n) return [];
							return [id, ...n.children.flatMap((cid) => collectIds(cid))];
						};
						const allIds = collectIds(node.id);
						await Promise.all(
							allIds.map((id) => clearPersistedMessages(dd, pid, id)),
						);
					}

					// Remove node from tree
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
			"reset_task",
			"Reset a child task for a fresh start — removes worktree and session file but keeps the node. " +
				"Sets status to pending. Use when you want to retry with a different approach.",
			{
				taskId: z.string().describe("ID of the task to reset"),
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
					// Close running agent if active
					// Delete from registry first so callers see "no queue" not "closed queue"
					const activeQueueReset = globalAgentQueues.get(args.taskId);
					if (activeQueueReset) {
						globalAgentQueues.delete(args.taskId);
						activeQueueReset.close();
					}

					// Clean up worktree + branch if they exist
					if (node.worktreePath && node.branch) {
						const slug = slugify(node.title);
						await worktrees.remove(node.id, slug);
						node.worktreePath = null;
						node.branch = null;
					}

					// Delete event JSONL files
					if (deps.eventStore) {
						deps.eventStore.clear(node.id);
					}

					// Clear persisted messages (follows session lifecycle)
					if (deps.dataDir && deps.currentProjectId) {
						await clearPersistedMessages(
							deps.dataDir,
							deps.currentProjectId,
							node.id,
						);
					}

					tracker.updateStatus(node.id, "pending");
					await tracker.save();
					broadcastTreeUpdate?.();

					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify(
									{
										reset: true,
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
			"Ask a clarification question and send it to the user. " +
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
				requestReply: z
					.boolean()
					.optional()
					.describe(
						"If true, signals to the parent that a reply (via send_message_to_child) is expected.",
					),
			},
			async (args) => {
				// Dynamic parent queue lookup at invocation time
				const parentQueue = deps.getParentQueue?.();
				if (!parentQueue) {
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
					parentQueue.enqueue({
						source: "child_report",
						taskId: currentTaskId ?? "unknown",
						title: taskTitle,
						content: args.message,
						...(args.requestReply ? { requestReply: true } : {}),
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
			"reorder_tasks",
			"Reorder children of a task node. The children array must contain exactly the same task IDs as the current children, just in a different order.",
			{
				nodeId: z.string().describe("Parent task ID whose children to reorder"),
				children: z
					.array(z.string())
					.describe("Ordered list of child task IDs"),
			},
			async (args) => {
				try {
					// Scope validation: must be own task or descendant
					if (
						currentTaskId !== null &&
						args.nodeId !== currentTaskId &&
						!isDescendantOf(tracker, args.nodeId, currentTaskId)
					) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Cannot reorder children of ${args.nodeId}: not your task or descendant`,
								},
							],
							isError: true,
						};
					}
					tracker.reorderChildren(args.nodeId, args.children);
					await tracker.save();
					broadcastTreeUpdate?.();
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify(
									{
										reordered: true,
										nodeId: args.nodeId,
										children: args.children,
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

		tool(
			"list_projects",
			"List all registered projects with their IDs, names, and paths. " +
				"Use this to discover other projects before sending cross-project messages.",
			{},
			async () => {
				if (!deps.projectManager) {
					return {
						content: [
							{
								type: "text" as const,
								text: "Cross-project tools are not available at this depth.",
							},
						],
						isError: true,
					};
				}
				const projects = deps.projectManager.list().map((p) => ({
					id: p.id,
					name: p.name,
					path: p.path,
					hasActiveAgent: deps.isProjectActive?.(p.id) ?? false,
				}));
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(projects, null, 2),
						},
					],
				};
			},
		),

		tool(
			"send_message_to_project",
			"Send a message to the orchestrator of another project. " +
				"The message appears in the target project's orchestrator queue as a cross_project message. " +
				"The target project must have an active agent running.",
			{
				projectId: z.string().describe("ID of the target project"),
				message: z.string().describe("Message content to send"),
			},
			async (args) => {
				if (!deps.projectManager || !deps.getProjectRootQueue) {
					return {
						content: [
							{
								type: "text" as const,
								text: "Cross-project tools are not available at this depth.",
							},
						],
						isError: true,
					};
				}

				const targetProject = deps.projectManager.get(args.projectId);
				if (!targetProject) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: Project "${args.projectId}" not found.`,
							},
						],
						isError: true,
					};
				}

				const targetQueue = deps.getProjectRootQueue(args.projectId);
				if (!targetQueue) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: No active agent running for project "${targetProject.name}" (${args.projectId}).`,
							},
						],
						isError: true,
					};
				}

				// Determine sender identity
				const senderProject = deps.currentProjectId
					? deps.projectManager.get(deps.currentProjectId)
					: undefined;
				const fromProjectId = deps.currentProjectId ?? "unknown";
				const fromProjectName = senderProject?.name ?? "unknown";

				try {
					targetQueue.enqueue({
						source: "cross_project",
						fromProjectId,
						fromProjectName,
						content: args.message,
					});
					return {
						content: [
							{
								type: "text" as const,
								text: `Message sent to project "${targetProject.name}" (${args.projectId}).`,
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
				// Update task status in the tree
				if (currentTaskId) {
					tracker.updateStatus(
						currentTaskId,
						args.status === "passed" ? "passed" : "failed",
					);
					await tracker.save();
					broadcastTreeUpdate?.();
				}

				// Broadcast task_completed event
				const node = currentTaskId ? tracker.get(currentTaskId) : null;
				emit({
					type: "task_completed",
					taskId: currentTaskId ?? "orchestrator",
					title: node?.title ?? "unknown",
					success: args.status === "passed",
					output: args.summary.slice(0, 500),
				});

				// Enter implicit yield — wait for wake messages (e.g. parent resume).
				// This prevents the provider from making another API call after done(),
				// which would waste tokens and create confusing behavior.
				const wakeResult = await waitForQueueMessages();
				if (wakeResult && !wakeResult.isError) {
					// Prepend context so the agent knows it previously completed
					const firstBlock = wakeResult.content[0];
					if (firstBlock && firstBlock.type === "text") {
						firstBlock.text = `You previously called done(${args.status}). New messages woke you up:\n\n${firstBlock.text}`;
					}
					return wakeResult;
				}

				// No queue, or queue closed (normal shutdown) — return immediately
				return {
					content: [
						{
							type: "text" as const,
							text: `Task marked as ${args.status}. Entering idle state.`,
						},
					],
				};
			},
		),
	];

	return {
		toolDefs,
		hasRunningChildren: () => {
			// Check if any descendants of this task have active queues in globalAgentQueues
			if (!currentTaskId) return false;
			return getDescendantIds(tracker, currentTaskId).some((id) =>
				globalAgentQueues.has(id),
			);
		},
	};
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
			`Your working directory is already set to \`${node.worktreePath ?? "unknown"}\` — do NOT cd to it.`,
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
	// Convert CJK characters to pinyin, leaving ASCII untouched
	const romanized = title.replace(
		/[\u4e00-\u9fff\u3400-\u4dbf]+/g,
		(match) => ` ${pinyin(match, { toneType: "none" })} `,
	);
	const slug = romanized
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 30);
	return slug || "task";
}
