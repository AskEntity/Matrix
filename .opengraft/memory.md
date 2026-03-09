# OpenGraft Project Memory

> Single source of truth for all accumulated knowledge.
> Every agent reads this on startup. CLAUDE.md points here; this file points to OpenGraft.md for design.
> Full system design and methodology: `OpenGraft.md`

## Operating Mode

**Autonomy**: Level 10. Work continuously: implement → test → commit → pick up next feature.
Do not ask questions — make decisions and keep moving.

## Bootstrap Mission

You are bootstrapping OpenGraft — using the system to improve itself. This is your continuous loop:

1. **Assess**: read codebase, run tests, identify the highest-impact improvement
2. **Implement**: decompose into tasks, spawn child agents, merge results
3. **Verify**: run full test suite on main after all merges
4. **Restart if needed**: if you changed daemon/provider/tool code, run `og daemon restart` via bash.
   The daemon auto-resumes your session — you wake up where you left off. Check get_tree to reorient.
5. **Repeat**: pick the next improvement

**What to improve** (prioritized):
- Bugs or reliability issues discovered while working
- Gaps between OpenGraft.md vision and actual implementation
- Code quality, missing test coverage, error handling
- Cost/performance optimization (token usage, caching, context efficiency)
- Developer experience (CLI, Web UI, error messages)
- Prompt quality — if children struggle, improve their prompts

**Self-modification rules**:
- You're modifying the system you're running on. Be careful.
- Always run full test suite before AND after merging changes to main
- If tests fail after merge, fix before restarting daemon
- Small, atomic improvements. Don't rewrite everything at once.
- Update this memory file with discoveries after each batch of improvements.

**How to run unit tests + all checks**:
```bash
bun test src/daemon.test.ts src/project-manager.test.ts src/task-tracker.test.ts src/worktree-manager.test.ts src/direct-provider.test.ts src/message-queue.test.ts src/agent-tools-helpers.test.ts
bun run typecheck   # tsc --noEmit
bun run check       # biome lint + format
```

**How to run E2E tests** (needs env vars):
```bash
source .env && export CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_MODEL
bun test src/e2e.test.ts
```

**Pre-commit hooks are active** (.hooks/pre-commit runs typecheck + lint + unit tests).

## Current Phase: Phase 4 — Self-Bootstrapping

System is functional and self-developing. OpenGraft uses itself to build itself.

## Architecture

```
Daemon (Hono: HTTP + WS on :7433)
    ↑               ↑
   CLI            Web UI (React, bundled by Bun)
```

- Daemon is the single core process. CLI and Web UI are API consumers.
- Two providers: ClaudeCodeProvider (subprocess) and DirectProvider (direct Anthropic API)
- Agent tree = Task tree. Each agent gets a worktree + branch. Agent lifecycle = branch lifecycle.
- All mutable APIs are fire-and-forget. Observe via WebSocket.
- MCP tools enable recursive orchestration: any agent can become a sub-orchestrator.

## Key Files

| File | Purpose |
|------|---------|
| src/types.ts | TaskNode, AgentResult, Project types |
| src/daemon.ts | Hono HTTP server, all routes, WS, createApp() |
| src/agent-provider.ts | AgentProvider interface, AgentRequest, AgentEvent, AgentSession |
| src/claude-code-provider.ts | Claude Code Agent SDK provider (subprocess) |
| src/direct-provider.ts | Direct Anthropic API provider (prompt caching, context compact, implicit yield, CWD tracking) |
| src/project-manager.ts | Project init/CRUD, .opengraft/ setup |
| src/task-tracker.ts | Task tree CRUD, short ID prefix matching, JSON persistence, per-task cost |
| src/worktree-manager.ts | Git worktree lifecycle (create, remove, merge, list) |
| src/agent-tools.ts | MCP tools (10 tools) + system prompts + helpers (`buildTaskPrompt`, `slugify`, `isDescendantOf`) |
| src/message-queue.ts | MessageQueue class + globalAgentQueues registry |
| src/cli.ts | CLI (`og` command): init, list, status, tasks, delete, orchestrate, watch, send, stop, logs |
| web/App.tsx | Web UI: task tree, activity log, message input, project management |
| web/hooks.ts | React hooks: useWebSocket, useProjects, useTasks, useAgent |
| web/style.css | Design system: `og-` prefix CSS variables |

## Tech Stack

| Decision | Choice |
|----------|--------|
| Language | TypeScript strict |
| Runtime | Bun |
| Lint/Format | Biome |
| Test | bun:test (colocated in src/) |
| HTTP | Hono (WS built-in) |
| AI | Claude Agent SDK + Direct Anthropic API |
| Frontend | React, bundled by Bun's HTML imports |

## MCP Tools (10 tools in agent-tools.ts)

| Tool | Description |
|------|-------------|
| get_tree | View task tree |
| create_task | Create task (top-level or child) |
| update_task_status | Update status: pending/in_progress/testing/passed/failed |
| execute_tasks | Fire-and-forget: spawn children in parallel, returns immediately |
| yield | Suspend and wait for queue messages. Returns messages + ## Pending summary. Emits queue_message events for UI acknowledgment. |
| send_message_to_child | Send parent_update to a running child |
| report_to_parent | Non-blocking upward message to parent as child_report |
| delete_task | Clean up worktree + branch + task node (after merge) |
| clarify | Non-blocking question to user/parent. Answer arrives via yield() |
| done | Signal task completion: done("passed", summary) or done("failed", reason) |

## Agent Lifecycle

### Exit Model
- **done("passed", summary)** — task complete, parent merges branch
- **done("failed", reason)** — can't continue, parent decides resume/reset
- **end_turn with running children** — implicit yield (auto-waits for queue)
- **end_turn without done, no children** — warning, defaults to success:true

### Event-Driven Model (MessageQueue)
- **MessageQueue** (`src/message-queue.ts`): async channel per agent session
- **QueueMessage types**: `user` | `child_complete` | `parent_update` | `clarify_response` | `child_report`
- **globalAgentQueues**: global Map for routing messages to specific agents by task ID
- **Message delivery**: messages piggybacked on tool results at cancellation points, or delivered via yield() tool. Both paths emit `queue_message` events for UI.

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Health check |
| POST | /projects | Init project at `{path}` |
| GET/DELETE | /projects/:id | Get or remove project |
| POST | /projects/:id/tasks | Create task |
| GET | /projects/:id/tasks | Get task tree |
| PATCH | /projects/:id/tasks/:nodeId | Update task |
| DELETE | /projects/:id/tasks/:nodeId | Remove task + descendants |
| POST | /projects/:id/orchestrate/agent | Start orchestration |
| POST | /projects/:id/tasks/:nodeId/continue | Continue failed/stuck task |
| POST | /projects/:id/stop | Stop running agent |
| POST | /projects/:id/message | Send message to root agent |
| POST | /projects/:id/tasks/:nodeId/message | Send message to specific child |
| POST | /projects/:id/sessions/clear | Wipe session history |
| POST | /projects/:id/sessions/prune | Prune old sessions (keep N) |
| GET | /projects/:id/events | Event history (up to 500 events) |
| GET | /projects/:id/pending-messages | Pending messages waiting for agent consumption |
| GET | /projects/:id/clarifications | Pending clarifications waiting for user answer |
| POST | /projects/:id/clarify | Answer a pending clarification (taskId + answer) |
| WS | /ws | Real-time task tree + agent events |

## Prompt Caching (DirectProvider)

Three explicit cache breakpoints per API call:
1. System prompt (last block gets `cache_control`)
2. Last tool definition
3. Second-to-last user message (`addMessagesCacheControl()`)

**Critical**: Do NOT put per-agent-variable info (e.g. `Working directory: ${cwd}`) in the system prompt — every distinct value breaks cross-agent cache sharing. Prepend it to the first user message only (skip on resume).

## Bash Tool CWD Tracking

- `executeTool` for bash returns `{ content, isError, cwd? }` — `cwd` set only when working directory changed
- Uses bash EXIT trap to always capture `pwd`: `trap ___og_trap EXIT`
- CWD marker `___OPENGRAFT_CWD___` stripped from stdout; if cwd changed, `cwd: /new/path` appended to output
- `runLoop` uses mutable `let cwd` — updated after each bash tool execution, affects all subsequent tool calls
- **Pitfall**: macOS `/var` → `/private/var` symlink. Fixed with `realpathSync(cwd)` for comparison.
- **CWD fallback**: `executeTool` accepts optional `fallbackCwd` param. If tracked `cwd` no longer exists (e.g., temp dir cleaned up), falls back to `fallbackCwd` (typically `request.cwd`, the project root). Emits a warning and updates tracked CWD to prevent repeated failures.

## Daemon Startup & Restart

- **Auto-resume**: On restart, `autoResumeProjects()` re-launches orchestrators with saved sessions.
- **Orphan reset**: In-progress child tasks are reset to `failed` before resume (their agent sessions died).
- **Startup guard**: `startupReady` flag prevents orchestration requests until auto-resume completes.
- **Sessions**: stored in `~/.opengraft/sessions/{projectId}/{sessionId}.json`

## Known Pitfalls

- **Git worktrees**: `extensions.worktreeConfig` must be enabled. `core.hooksPath` must be absolute. New worktrees need `bun install`.
- **Nested Claude Code sessions**: strip CLAUDECODE env vars to prevent conflicts.
- **OAuth token**: requires `anthropic-beta: oauth-2025-04-20` header.
- **Template strings in agent-tools.ts**: backticks must be escaped as `` \` ``.
- **Biome SVG rule**: `noSvgWithoutTitle` requires `aria-hidden="true"` on decorative SVGs.
- **`git merge --no-ff`**: run from the correct directory (parent worktree or main repo root).
- **TaskTracker.get()**: supports short ID prefix matching (8+ chars), returns undefined on ambiguity.
- **Continue handler**: uses `provider.startSession()` (not `stream()`), creates `MessageQueue` + `createOrchestratorTools()`. Status from `doneRef.done` first, `agentResult.success` as fallback.
- **CSS `var(--radius)`**: not defined — use `var(--radius-sm)`, `var(--radius-md)` etc.
- **`c.req.json<T>().catch(() => ({}))`**: gives union type. Cast fallback: `.catch(() => ({} as T))`.
- **Search tool `rg --max-count`**: limits per-file, not total. Use post-processing truncation instead (`truncateSearchOutput()`).

## Methodology

- Vertical iteration: types → implementation → tests → all passing
- Don't guess APIs — read source or `--help` first
- Don't say "should work" — run it
- Flaky test = Bug. Never fix with retries.
- No old-system fallbacks when replacing something

## Bootstrap Strategy

- **Fan out aggressively**: spawn many parallel tasks touching different files
- **Sub-agents can orchestrate**: tree can be 3+ levels deep
- **Merge order**: simpler tasks first; reset smaller ones if conflicts are complex
- Safe parallel splits: daemon.ts + App.tsx, different CLI commands, new test + new feature files

## CLI Commands

| Command | Description |
|---------|-------------|
| `og init [path]` | Initialize project |
| `og list` | List all projects |
| `og status [id]` | Show task tree |
| `og tasks [id]` | List tasks with details + cost |
| `og delete <taskId>` | Delete task |
| `og orchestrate <goal>` | Start orchestration + watch |
| `og continue <taskId>` | Continue failed task |
| `og watch` | Watch live events |
| `og send <msg>` | Send message to running agent |
| `og stop` | Stop running agent |
| `og logs [id]` | Show event history |
| `og cost [id]` | Show cost breakdown by task |
| `og sessions clear` | Wipe session history |
| `og sessions prune [--keep N]` | Prune old session files |
| `og health` | Check daemon health |
| `og daemon <cmd>` | Manage daemon service |

## Web UI Features

- Auto-target: selecting an in_progress task auto-targets messages to it
- OrchestratorDetail: task stats, session cost, total project cost, turns, clear sessions
- Project management: add/remove projects from header
- Pending message chips: backend-driven (daemon tracks per-agent), filtered by targetNodeId, auto-dismiss when agent consumes via queue_message events
- Per-task cost, timing display in TaskDetail panel
- Collapsible task tree nodes, task tree search filter
- Activity log search/filter, dark/light mode toggle
- queue_message parsing into typed log entries
- "Message queued" no longer shown in activity log (pending chips provide this feedback)
- TaskDetail git log: shows commits for a task's branch via GET /projects/:id/tasks/:nodeId/gitlog; refetched when node.id or node.status changes

## API Notes

- **GET /projects/:id/tasks/:nodeId/gitlog**: returns `{ commits: [{hash, message}] }`. Runs `git log --oneline -20 <branch>` from project root. Returns empty array if no worktreePath/branch set, or if git fails (e.g., branch not yet pushed).
- **PATCH /projects/:id/tasks/:nodeId**: only handles `status` and `branch` — does NOT handle `worktreePath`. Use `tracker.assignWorktree()` directly to set both branch + worktreePath.
- **Git default branch**: `git init` uses "master" by default (git < 3.0 without config). Tests must use `git branch --show-current` via `Bun.spawn` to detect actual branch name, not hardcode "main".
- **GET /projects/:id/pending-messages**: returns `{ messages: [{id, taskId, text, timestamp}] }`. `taskId` is null for root orchestrator messages, string for task-specific messages. Daemon auto-removes pending messages when `queue_message` events with `[user]` lines fire. WS event `pending_messages` broadcasts the full list on changes.

## Per-Task Cost Budgets

- `TaskNode.budgetUsd` — optional field for maximum cost a task is allowed to spend
- `TaskTracker.addTask()` and `addChild()` accept `opts?: { budgetUsd?: number }` parameter
- `create_task` MCP tool accepts optional `budgetUsd` param, passed through to tracker
- `POST /projects/:id/tasks` API route accepts optional `budgetUsd` in body
- `AgentRequest.budgetUsd` — passed to DirectProvider; triggers mid-execution warnings
- DirectProvider checks running cost after each tool-result turn: warns at 80%, demands done() at 100%
- Budget warnings injected as user messages in conversation history (so agent sees them)
- `buildTaskPrompt` includes budget info in child task prompts when set
- After child completes, `execute_tasks` handler emits `budget_exceeded` event if cost > budget
- Web UI shows cost alongside budget in TaskDetail (e.g., "$0.12 / $0.50 budget")
- **Dollar sign in template literals**: use `${"$"}` to inject a literal `$` inside backtick strings in agent-tools.ts

## report_to_parent Queue Routing

**Bug found & fixed**: `report_to_parent` tool was enqueuing to `deps.queue` which, for a child agent, is the child's OWN queue (childQueue). Messages went back to the child, never reaching the parent. **Fix**: Added `parentQueue` field to `OrchestratorToolsDeps`. In `executeChildStreaming`, `deps.queue` (the parent's queue) is passed as `parentQueue` to child tools. `report_to_parent` now uses `deps.parentQueue` to enqueue messages upward.

## Queue Message Delivery — Confirmed Behavior

- `yield()`: blocks waiting for queue, returns all pending messages
- `bash` (and all tools): after tool batch completes, DirectProvider checks `queue.pending > 0` and appends messages to tool result under "Messages received while you were working" section
- ClaudeCodeProvider: drains queue after each `assistant` event, injects via `sendMessage()` in startSession mode
- Race condition: if agent calls `done()` before message arrives, message is lost (queue closed). Expected — messages only arrive at tool-call boundaries.

## Clarify UI Feature (implemented)

- `clarification_requested` events (emitted by the `clarify()` MCP tool via `onTaskEvent`) are now intercepted inside `broadcastEvent()` and stored in `pendingClarifications` per-project Map.
- `GET /projects/:id/clarifications` returns current list: `{ clarifications: [{id, taskId, question, timestamp}] }`
- `POST /projects/:id/clarify` calls `removePendingClarification()` after enqueuing response, which broadcasts updated `pending_clarifications` WS event.
- WS `clarify_response` handler (from Web UI / old path) also calls `removePendingClarification()`.
- On WS subscribe, sends current `pending_clarifications` to new client.
- Web UI: `pendingClarifications` state + `clarifyAnswers` state (per-taskId input values).
- Web UI: Handles `pending_clarifications` WS event, fetches on project change.
- Web UI: Shows clarification cards above footer with question, task name, text input, Answer button.
- Web UI: Calls `POST /projects/:id/clarify` with `{taskId, answer}` on submit.
- CSS: `.og-clarification-card`, `.og-clarification-form`, `.og-clarification-input` etc. in blue accent.
- **Key design**: clarification is per-taskId. Only one clarification per taskId is tracked (first one wins); removal is by taskId not id. This mirrors the session routing (root session only).

## Backlog (next improvements to consider)

- Compact checkpoint should include "Rejected Approaches" more aggressively — agents often retry failed paths after compaction

## memory.md Duplication Root Cause (Investigated)

**Root cause found in commit `7ad2cf6`**: The child agent (token budget task) used `write_file` to write memory.md. When constructing the content, it embedded the entire existing file content inside the new section text. This caused the new section to contain the full old content literally embedded in it (e.g., the dollar sign pitfall line became `use \`${"$"}\` to inject a literal \`# OpenGraft Project Memory...` followed by the whole file).

**Pattern**: Agent read file → constructed new content with `write_file` → accidentally included old content as part of the new bullet point string → resulted in 3 copies of the file (old + embedded old + continuation).

**Fix applied in `src/agent-tools.ts`**: Added explicit "NEVER use write_file on memory.md" warning to:
1. The `## Memory System` section (orchestrator system prompt)
2. The `## Worker Workflow` step 5 (worker system prompt)  
3. The `buildTaskPrompt` instructions (step 4 of task prompt given to child agents)

**Rule**: Always use `edit_file` (match last lines, extend them) or bash `echo >> .opengraft/memory.md` to append. Never `write_file` on memory.md.

## Reusable Worker Pattern (tested & confirmed)

Child agents can act as persistent workers without being torn down between tasks:
1. Child does work → `report_to_parent("ready for more")` → `yield()` to wait
2. Parent sees `child_report` via yield() → sends next task via `send_message_to_child`
3. Child receives message during yield, does next task
4. When truly done, orchestrator tells child to `done("passed", ...)`

Benefits: Session/context reuse, cheaper than spawning new agents for related sequential tasks.
Implementation: Existing `report_to_parent`, `yield()`, `send_message_to_child` tools — no code changes needed.
