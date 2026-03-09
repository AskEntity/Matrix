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
| src/task-tracker.ts | Task tree CRUD, short ID prefix matching, JSON persistence |
| src/worktree-manager.ts | Git worktree lifecycle (create, remove, merge, list) |
| src/agent-tools.ts | MCP tools (10 tools) + system prompts (ORCHESTRATION_KNOWLEDGE, TASK_SYSTEM_PROMPT) |
| src/message-queue.ts | MessageQueue class + globalAgentQueues registry |
| src/cli.ts | CLI (`og` command) |
| web/App.tsx | Web UI: task tree, activity log, message input, auto-scroll |
| web/hooks.ts | React hooks: useWebSocket, message routing |
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
- **Cancellation points**: queue drained after each tool batch in runLoop

### yield() Output Format
Messages + `## Pending` section showing running children list + pending clarification count.

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
| WS | /ws | Real-time task tree + agent events |

## Anthropic Prompt Caching (DirectProvider)

Three explicit cache breakpoints per API call:
1. System prompt (last block gets `cache_control`)
2. Last tool definition
3. Second-to-last user message (`addMessagesCacheControl()`)

Cost formula: `input * 1x + cache_creation * 1.25x + cache_read * 0.1x + output * outputRate`
- `input_tokens` from API = non-cached tokens only. Do NOT subtract cache tokens.

**Caching pitfall**: Do NOT put per-agent-variable info (e.g. `Working directory: ${cwd}`) in the
system prompt. Every distinct value breaks cache sharing. Instead, prepend it to the first user
message only (and skip on resume). This lets all agents share an identical system prompt and
benefit from cache reads after the first agent's cache-creation turn.

## Session Persistence

- Sessions stored in daemon data dir: `~/.opengraft/sessions/{projectId}/{sessionId}.json`
- NOT in project repo — keeps repo clean, sessions are daemon-internal state
- On resume: loads from disk if not in memory
- Restart: stop → restart daemon → orchestrate with `resume: true` → full history restored

## Real-time Task Tree Updates

All task mutations broadcast `tree_update` via WebSocket:
- HTTP routes: POST/PATCH/DELETE `/projects/:id/tasks`
- MCP tools: `create_task`, `update_task_status`, `delete_task` via `deps.broadcastTreeUpdate?()`

## Web UI Features

- Modern design system: `og-` prefix CSS variables
- Status colors: pending=gray, in_progress=blue, testing=purple, passed=green, failed=red, stuck=amber
- Message input: send messages to root or specific child agents (targetNodeId)
- Auto-scroll lock: toggle button in activity header, auto-unlocks on manual scroll
- Token breakdown: `$0.043 · 500 in · 10k write · 5k read · 200 out`
- Orchestration prompt shown as user message bubble before start
- Queue message events styled in activity log
- Compact boundary with collapsible checkpoint content
- **Auto-target on task selection**: selecting an in_progress task auto-sets targetNodeId.
  Selecting anything else resets to null (sends to orchestrator). Footer shows targeting status.
- **queue_message parsing**: Split on `\n`, filter `## ` section headers, regex `^\[([^\]]+)\] (.*)`.
  Map `child_complete` → `task_completed`, `user` → `user_prompt`, others → `queue_message`.
- **OrchestratorDetail stats**: Shows real passed/active/failed counts from nodes array.

## Code Rules

1. All code and comments in English
2. Pre-commit hooks enforce all checks
3. Three repetitions before abstracting
4. No synchronous mutable APIs — fire-and-forget + WS observe

## Known Bugs / TODO

(none — continue handler bug fixed, UI targeting improved, prompt caching bug fixed)

## Known Pitfalls

- **Git worktrees**: `extensions.worktreeConfig` must be enabled. `core.hooksPath` must be absolute. New worktrees need `bun install`.
- **Nested Claude Code sessions**: strip CLAUDECODE env vars to prevent conflicts.
- **OAuth token**: requires `anthropic-beta: oauth-2025-04-20` header.
- **Template strings in agent-tools.ts**: backticks must be escaped as `` \` ``.
- **Biome SVG rule**: `noSvgWithoutTitle` requires `aria-hidden="true"` on decorative SVGs.
- **Zod v4**: array elements at `def.element`; enum values at `def.entries` (record).
- **`git merge --no-ff`**: run from the correct directory (parent worktree or main repo root).
- **TaskTracker.get()**: supports short ID prefix matching (8+ chars), returns undefined on ambiguity.
- **`createApp` returns `getTracker`**: to test daemon internals that depend on the in-memory `TaskTracker` (e.g., the continue handler's worktreePath branch), use `const { getTracker } = createApp(...)` to get the daemon's own tracker instance. Writing to the tracker file externally won't affect an already-loaded in-memory tracker.
- **Continue handler pattern**: uses `provider.startSession()` (not `stream()`), creates a `MessageQueue` registered in `globalAgentQueues`, and calls `createOrchestratorTools()` with `depth: 1`, `currentTaskId: nodeId`. Queue is cleaned up in `finally` block. Status determined by `doneRef.done` first, with `agentResult.success` as fallback.

## Methodology

- Vertical iteration: types → implementation → tests → all passing
- Don't guess APIs — read source or `--help` first
- Don't say "should work" — run it
- Flaky test = Bug. Never fix with retries.
- No old-system fallbacks when replacing something

## Bootstrap Strategy: Large-Scale Parallelism

The bootstrapping process is most efficient when using **massive parallelism** — spawn many child agents simultaneously to tackle different features/modules in parallel, then merge results.

**Key patterns**:
- **Fan out aggressively**: When you have 5+ improvements to make, create all tasks and spawn them all at once. Don't serialize what can be parallel.
- **Sub-agents can also orchestrate**: Child agents that encounter large tasks should themselves spawn sub-agents. The tree can be 3+ levels deep: orchestrator → feature agent → sub-feature agents.
- **Merge order matters**: Merge simpler/smaller tasks first. If a larger task conflicts, reset the smaller one on top of the merged main branch.
- **Identify non-overlapping work**: tasks touching different files (e.g., daemon.ts vs App.tsx vs types.ts vs CLI) can always run in parallel safely.
- **Batch improvements**: Instead of fixing one bug at a time, assess 5-10 improvements, decompose all of them into tasks, and spawn all at once. Check memory.md and OpenGraft.md for the full list of known gaps.

**What to parallelize** (examples of safe parallel splits):
- Backend fix (daemon.ts) + Frontend feature (App.tsx) = always safe
- New test file + New feature file = usually safe
- Different CLI commands = safe
- Different API routes = safe (same file but different functions, merge usually clean)
