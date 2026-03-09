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
bun test src/daemon.test.ts src/project-manager.test.ts src/task-tracker.test.ts src/worktree-manager.test.ts src/direct-provider.test.ts src/message-queue.test.ts
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
| src/direct-provider.ts | Direct Anthropic API provider (prompt caching, context compact, implicit yield) |
| src/project-manager.ts | Project init/CRUD, .opengraft/ setup |
| src/task-tracker.ts | Task tree CRUD, short ID prefix matching, JSON persistence, per-task cost |
| src/worktree-manager.ts | Git worktree lifecycle (create, remove, merge, list) |
| src/agent-tools.ts | MCP tools (10 tools) + system prompts (ORCHESTRATION_KNOWLEDGE, TASK_SYSTEM_PROMPT) |
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
| yield | Suspend and wait for queue messages. Returns messages + ## Pending summary |
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
| POST | /projects/:id/stop | Stop running agent |
| POST | /projects/:id/message | Send message to root agent |
| POST | /projects/:id/tasks/:nodeId/message | Send message to specific child |
| POST | /projects/:id/sessions/clear | Wipe session history |
| GET | /projects/:id/events | Event history (up to 500 events) |
| WS | /ws | Real-time task tree + agent events |

## Prompt Caching (DirectProvider)

Three explicit cache breakpoints per API call:
1. System prompt (last block gets `cache_control`)
2. Last tool definition
3. Second-to-last user message (`addMessagesCacheControl()`)

**Critical**: Do NOT put per-agent-variable info (e.g. `Working directory: ${cwd}`) in the system prompt — every distinct value breaks cross-agent cache sharing. Prepend it to the first user message only (skip on resume).

## Daemon Startup & Restart

- **Auto-resume**: On restart, `autoResumeProjects()` re-launches orchestrators with saved sessions.
- **Orphan reset**: In-progress child tasks are reset to `failed` before resume (their agent sessions died).
- **Startup guard**: `startupReady` flag prevents orchestration requests until auto-resume completes (prevents duplicate orchestration race condition). Tests must call `markReady()`.
- **Sessions**: stored in `~/.opengraft/sessions/{projectId}/{sessionId}.json`

## Web UI Features

- Auto-target: selecting an in_progress task auto-targets messages to it
- OrchestratorDetail: real task stats (passed/active/failed), session cost, total project cost, turns, clear sessions button
- Project management: add/remove projects from header
- Pending message chips: sent-but-unacknowledged messages shown as dismissible chips in footer
- Per-task cost display in TaskDetail panel (`costUsd` from tree.json)
- Task timing display: "Running Xm", "Waiting X ago", "Age X ago" in TaskDetail (uses createdAt/updatedAt)
- Collapsible task tree nodes (chevron toggle, state per node ID)
- Activity log search/filter: text search input in log header, clears on task change
- Dark/light mode toggle: persisted to localStorage, `.light-mode` class on `document.documentElement`
- queue_message parsing into typed log entries

## Web UI: Dark/Light Mode Toggle

- Theme toggle button added to top-right of header (`og-header-right`) in `web/App.tsx`
- `isDark` state initialized from `localStorage.getItem("og-theme") !== "light"` (defaults to dark)
- `useEffect` applies `.light-mode` class to `document.documentElement` and persists to localStorage
- Light mode CSS overrides are in `:root.light-mode { }` block in `web/style.css`
- The CSS uses exact `:root` variable names: `--bg-base`, `--bg-surface`, `--bg-raised`, `--bg-overlay`, `--bg-subtle`, `--border`, `--border-subtle`, `--border-muted`, `--text-primary`, `--text-secondary`, `--text-muted`, `--text-faint`, plus status/accent/shadow vars
- **Pitfall**: Several hover backgrounds use hardcoded `rgba(255,255,255,0.04)` — invisible on light bg. Fixed with `:root.light-mode .og-task-node:hover { background: rgba(0,0,0,0.04) }` etc. at end of CSS
- Layout/spacing/font/radius/transition variables intentionally NOT overridden — only color variables
- IconSun and IconMoon SVG icons added as inline components (matching existing icon pattern)

## Known Pitfalls

- **Git worktrees**: `extensions.worktreeConfig` must be enabled. `core.hooksPath` must be absolute. New worktrees need `bun install`.
- **Nested Claude Code sessions**: strip CLAUDECODE env vars to prevent conflicts.
- **OAuth token**: requires `anthropic-beta: oauth-2025-04-20` header.
- **Template strings in agent-tools.ts**: backticks must be escaped as `` \` ``.
- **Biome SVG rule**: `noSvgWithoutTitle` requires `aria-hidden="true"` on decorative SVGs.
- **`git merge --no-ff`**: run from the correct directory (parent worktree or main repo root).
- **TaskTracker.get()**: supports short ID prefix matching (8+ chars), returns undefined on ambiguity.
- **Continue handler**: uses `provider.startSession()` (not `stream()`), creates `MessageQueue` + `createOrchestratorTools()`. Status from `doneRef.done` first, `agentResult.success` as fallback.

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
| `og health` | Check daemon health |
| `og daemon <cmd>` | Manage daemon service |

## Per-Task Cost Tracking

- `costUsd?: number` field on `TaskNode` (optional, backward compatible)
- `TaskTracker.updateCost(nodeId, costUsd)` accumulates cost (NOT `setCost` which was removed)
- Cost is accumulated in `agent-tools.ts` after each child task completes
- Persisted to `tree.json` — survives daemon restart
- Shown in Web UI TaskDetail and `og tasks`/`og cost` CLI commands

## Web UI: Task Tree Search Filter (added)

- Search input added at top of `TaskTree` component in `web/App.tsx`
- `taskFilter` state lives in `TaskTree` (self-contained, resets naturally on project change if component remounts)
- `nodeMap` (id→TaskNode) built via `useMemo` for ancestor traversal
- `matchingIds: Set<string> | null` — null means show all; when active, includes matching nodes + all ancestors up the tree
- `filteredRoots` filters top-level roots by `matchingIds`
- `TaskNodeView` accepts `matchingIds` prop: filters children to those in set, force-expands (overrides `isCollapsed`) when filter active
- Empty state: "No tasks match '…'" shown when filter active but no roots remain
- CSS classes: `og-tree-search-bar`, `og-tree-search`, `og-tree-empty` in `web/style.css`
- **Pitfall**: `var(--radius)` is not defined in the CSS (only `--radius-sm`, `--radius-md` etc). The existing log search uses `var(--radius)` which silently fails. Use `var(--radius-sm)` for correct behavior.

## Bash Tool CWD Tracking

- `executeTool` for bash now returns `{ content, isError, cwd? }` — `cwd` is set only when the working directory changed
- Uses bash EXIT trap to capture `pwd` even when the command calls `exit`: `trap ___og_trap EXIT`
- CWD marker `___OPENGRAFT_CWD___` is stripped from stdout; if cwd changed, `cwd: /new/path` is appended to output
- `runLoop` in DirectProvider uses `let cwd` (mutable) and updates it after each bash tool execution with a new cwd
- **Pitfall**: macOS `/var` → `/private/var` symlink causes `pwd` output to differ from input `cwd`. Fixed by using `realpathSync(cwd)` for comparison.
- All subsequent tool calls (bash, read_file, write_file, edit_file, list_files, search) automatically use the updated cwd

## Backlog (next improvements to consider)

- Token budget per task: cost limits and alerts
- `og run` endpoint: currently just runs agent without watching (consider deprecating in favor of `og orchestrate`)
- WebSocket reconnect in CLI `og watch` when connection drops

## Sessions Prune (added)

- `POST /projects/:id/sessions/prune` — prunes old session JSON files, keeps N most recent (default 10). Sorts by mtime. Returns `{ pruned, remaining }`.
- `og sessions prune [--keep N]` — CLI command. Usage error now says `og sessions clear|prune [--keep N]`.
- **TypeScript pitfall**: `c.req.json<T>().catch(() => ({}))` gives union type `T | {}`. Cast the fallback: `.catch(() => ({} as T))` to avoid TS2339.
- `readdir`, `stat`, `unlink` added to static imports from `node:fs/promises` in daemon.ts (don't use dynamic import — use static like the rest of the file).
- `/projects/:id/run` now has tests: 404 unknown project, 400 missing prompt, 200 running status, 409 conflict when already running.
