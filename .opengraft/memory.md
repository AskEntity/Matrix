# OpenGraft Project Memory

> This is the project's single source of truth for all accumulated knowledge.
> Every agent reads this on startup. CLAUDE.md points here; this file points to OpenGraft.md for design.
> Agents: append discoveries, never modify existing entries from parent branches.
> Full system design and methodology: `OpenGraft.md`

## Operating Mode

**Autonomy**: Level 10. Work continuously: implement → test → commit → pick up next feature.
Do not ask questions — make decisions and keep moving.

**How to run E2E tests** (needs this every time after context compression):
```bash
source .env && export CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_MODEL
bun test src/e2e.test.ts
```

**How to run unit tests + all checks**:
```bash
bun test src/daemon.test.ts src/project-manager.test.ts src/task-tracker.test.ts src/worktree-manager.test.ts src/direct-provider.test.ts
bun run typecheck   # tsc --noEmit
bun run check       # biome lint + format
```

**Pre-commit hooks are active** (.hooks/pre-commit runs typecheck + lint + unit tests).

## Current Phase: Phase 4 — Self-Bootstrapping

Phases 0–3 complete. System is functional: daemon, orchestrator, task decomposition,
worktree isolation, DirectProvider, web UI, CLI. Phase 4: use OpenGraft to develop itself.

## Tech Stack

| Decision | Choice | Reason |
|----------|--------|--------|
| Language | TypeScript strict | Strong type inference, large training data, unified front/back |
| Runtime | Bun | Fast startup, built-in test framework, native TS support |
| Lint/Format | Biome | Single tool, minimal config, AI-friendly |
| Test | bun:test | Zero config, integrated with runtime (tests colocated in src/) |
| HTTP framework | Hono | Lightweight, Bun-native, TS-first, built-in WS helper |
| AI engine | Claude Agent SDK + Direct Anthropic API | Two providers, swappable |

## Architecture

```
Daemon (Hono: HTTP + SSE + WS on :7433)
    ↑               ↑
   CLI            Web UI
```

- Daemon is the single core process. CLI and Web UI are API consumers.
- Two providers: ClaudeCodeProvider (subprocess) and DirectProvider (direct API, lightweight)
- Agent tree = Task tree. Each agent gets a worktree + branch. Agent lifecycle = branch lifecycle.
- All mutable APIs are fire-and-forget. Observe via WebSocket.
- MCP tools enable recursive orchestration: any agent can become a sub-orchestrator.

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Daemon health check (optional ?check_model=true) |
| POST | /projects | Init project at `{path}` |
| GET | /projects | List all projects |
| GET | /projects/:id | Get project by ID |
| DELETE | /projects/:id | Remove project metadata |
| POST | /projects/:id/tasks | Create task (root or child via `parentId`) |
| GET | /projects/:id/tasks | Get full task tree |
| PATCH | /projects/:id/tasks/:nodeId | Update task status/branch |
| POST | /projects/:id/tasks/:nodeId/continue | Continue failed task |
| DELETE | /projects/:id/tasks/:nodeId | Remove task and descendants |
| POST | /projects/:id/run | Start agent (fire-and-forget) |
| POST | /projects/:id/orchestrate/agent | Start orchestration (fire-and-forget) |
| GET | /projects/:id/agent | Check if agent is running |
| POST | /projects/:id/stop | Stop running agent |
| POST | /projects/:id/message | Send instruction to running agent |
| POST | /projects/:id/clarify | Respond to agent clarification request |
| WS | /ws | Real-time task tree + agent events + message injection |

## Key Files

| File | Purpose |
|------|---------|
| src/types.ts | All type definitions (TaskNode, AgentResult, Project, etc.) |
| src/daemon.ts | Hono HTTP server, all routes, createApp() factory |
| src/agent-provider.ts | AgentProvider interface (decoupled, swappable) |
| src/claude-code-provider.ts | Claude Code Agent SDK provider (subprocess) |
| src/direct-provider.ts | Direct Anthropic API provider (lightweight, context compact) |
| src/project-manager.ts | Project init/CRUD, .opengraft/ setup, git init |
| src/task-tracker.ts | Task tree CRUD, persistence to JSON |
| src/worktree-manager.ts | Git worktree lifecycle (create, remove, merge, list) |
| src/agent-tools.ts | MCP tools + system prompts (orchestration + child agents) |
| src/cli.ts | CLI (`og` command) |
| web/ | Web UI: task tree, agent activity, compact display |

## Code Rules

1. **All code and comments in English.** No exceptions.
2. **Pre-commit hooks enforce all checks** (typecheck, lint, test).
3. Three repetitions before abstracting. No premature helpers.
4. **No synchronous mutable APIs.** Fire-and-forget + WS observe.

## Agent Exit Model

- Agents only see two exit states: **passed** (done) and **failed** (can't continue)
- **stuck** is an internal circuit breaker: auto-set after 3 consecutive failures, invisible to agents
- **clarify(question)** is an MCP tool call, not an exit condition — blocks the agent, waits for response or timeout
- Root orchestrator session is always preserved (saved in finally block) for future resume

## Context Compression (Compact)

- Claude Code-style: compact ALL messages into structured checkpoint, then rebuild from scratch
- After compact: original task prompt + fresh memory (re-read from disk) + checkpoint
- Checkpoint format: Task / Current Phase / Completed / Files Modified / Current State / Next Action / Key Context
- Uses same-tier model (not haiku) for high-quality checkpoint generation
- UI shows compact as a boundary line with collapsible checkpoint content

## Git Worktree Configuration

- `extensions.worktreeConfig` MUST be enabled before `git config --worktree` works
- Without it, `--worktree` silently writes to shared `.git/config`
- Hooks are shared across all worktrees — use per-worktree `core.hooksPath` to override
- `core.hooksPath` must be absolute path (relative resolves differently in worktrees)
- New worktrees don't have node_modules — must run `bun install` after creation
- WorktreeManager.create() handles all of this

## Zod v4 Schema Conversion (DirectProvider)

- Zod v4 stores array elements at `def.element` (not `def.type`)
- Zod v4 stores enum values at `def.entries` (record), not `def.values` (array)
- `zodShapeToJsonSchema` handles: string, number, boolean, enum, optional, default, array, object

## Known Pitfalls

- Nested Claude Code sessions: must strip CLAUDECODE env vars to prevent conflicts
- OAuth token requires `anthropic-beta: oauth-2025-04-20` header
- DirectProvider maxTurns: default 200, detect infinite loops early
- `git merge --no-ff` from the correct directory (parent's worktree or main repo)
- After merge + delete_task: worktree, branch, and task node are all cleaned up

## Methodology (from OpenGraft.md)

- Vertical iteration: one feature at a time (types → implementation → tests → all passing)
- Don't guess APIs — read docs or run --help first
- Don't say "should work" — run it and see
- Flaky test = Bug. Never "fix" with retries.
- Identify layer → add logs → trust logs → isolate → minimize
- No old-system fallbacks when replacing

## MessageQueue + yield() Scheduler (Phase 4 Feature)

**Architecture change**: Replaced blocking execute_tasks + clarify with event-driven model.

### New Model
- **MessageQueue** (`src/message-queue.ts`): Single async channel per agent session for all events
- **execute_tasks**: Fire-and-forget — spawns children in background, returns immediately. Results arrive as `child_complete` messages via queue.
- **yield()**: New MCP tool — suspends agent loop (zero token burn), waits for any queue message, returns all accumulated messages.
- **send_message_to_child**: New MCP tool — sends `parent_update` to a running child via `childQueues` registry.
- **clarify**: Now non-blocking — emits event, returns immediately. After calling clarify(), the agent can continue doing other work that doesn't need the answer, then call yield() when ready to wait for the `clarify_response`.
- **Cancellation points**: After each tool batch execution, queue is drained and messages appended to tool results.

### Key Design Decisions
- Queue created in daemon.ts `launchAgent`, shared between tools and session via `AgentRequest.queue`
- `childQueues: Map<string, MessageQueue>` tracks running children for send_message_to_child
- Old mechanisms removed: `ClarificationMap`, `activeClarifications`, `checkInjectedMessage`, `injectedMessages`
- `sendMessage()` on AgentSession is deprecated — use `queue.enqueue()` directly

### QueueMessage Types
- `{ source: "user", content }` — user/parent message
- `{ source: "child_complete", taskId, title, success, output }` — child finished
- `{ source: "parent_update", content }` — parent sent update to child
- `{ source: "clarify_response", answer }` — user answered clarification

## DirectProvider Tool Upgrades (Phase 4)

Enhanced built-in tools to close gap with Claude SDK capabilities:

| Tool | Added |
|------|-------|
| `search` | `output_mode` (content/files_with_matches/count), `head_limit` (max 200), `case_insensitive` |
| `read_file` | `offset` (1-based line start), `limit` (max lines); appends "N more lines, use offset=X" hint |
| `edit_file` | `replace_all` (replaces all occurrences, skips uniqueness check); reports count in success message |

Cost calculation also fixed: now accounts for cache_creation (1.25x) and cache_read (0.1x) tokens.

## Pending Feature Request: UI Message Routing to Specific Agents

User requested: When a task/agent is selected in the web UI, messages should be sent to that specific agent (via send_message_to_child routing), not always to the root orchestrator. This requires:
1. UI changes to track which agent/task is selected
2. API changes to route messages to specific agent queues (may already be possible via existing queue infrastructure)
3. Will be addressed after the done() tool lifecycle feature is complete.
