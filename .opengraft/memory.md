# OpenGraft Project Memory

> This is the project's single source of truth for all accumulated knowledge.
> Every agent reads this on startup. CLAUDE.md points here; this file points to OpenGraft.md for design.
> Agents: append discoveries, never modify existing entries from parent branches.
> Full system design and methodology: `OpenGraft.md`

## Operating Mode

**Autonomy**: Level 10. Work continuously: implement → test → commit → pick up next feature.
Do not ask questions — make decisions and keep moving.

**How to run unit tests + all checks**:
```bash
bun test src/daemon.test.ts src/project-manager.test.ts src/task-tracker.test.ts src/worktree-manager.test.ts src/direct-provider.test.ts
bun run typecheck   # tsc --noEmit
bun run check       # biome lint + format
```

**How to run E2E tests** (needs this every time after context compression):
```bash
source .env && export CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_MODEL
bun test src/e2e.test.ts
```

**Pre-commit hooks are active** (.hooks/pre-commit runs typecheck + lint + unit tests).

## Current Phase: Phase 4 — Self-Bootstrapping

Phases 0–3 complete. System is functional: daemon, orchestrator, task decomposition,
worktree isolation, DirectProvider, web UI, CLI. Phase 4: use OpenGraft to develop itself.

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

## Key Files

| File | Purpose |
|------|---------|
| src/types.ts | All type definitions (TaskNode, AgentResult, Project, etc.) |
| src/daemon.ts | Hono HTTP server, all routes, createApp() factory |
| src/agent-provider.ts | AgentProvider interface + AgentRequest type |
| src/claude-code-provider.ts | Claude Code Agent SDK provider (subprocess) |
| src/direct-provider.ts | Direct Anthropic API provider (lightweight, context compact) |
| src/project-manager.ts | Project init/CRUD, .opengraft/ setup, git init |
| src/task-tracker.ts | Task tree CRUD, persistence to JSON |
| src/worktree-manager.ts | Git worktree lifecycle (create, remove, merge, list) |
| src/agent-tools.ts | MCP tools + system prompts (orchestration + child agents) |
| src/message-queue.ts | MessageQueue + globalAgentQueues registry |
| src/cli.ts | CLI (`og` command) |
| web/App.tsx | Web UI: task tree, agent activity |
| web/hooks.ts | React hooks: useWebSocket, sendMessageToTask |

## Tech Stack

| Decision | Choice | Reason |
|----------|--------|--------|
| Language | TypeScript strict | Strong type inference, large training data, unified front/back |
| Runtime | Bun | Fast startup, built-in test framework, native TS support |
| Lint/Format | Biome | Single tool, minimal config, AI-friendly |
| Test | bun:test | Zero config, integrated with runtime (tests colocated in src/) |
| HTTP framework | Hono | Lightweight, Bun-native, TS-first, built-in WS helper |
| AI engine | Claude Agent SDK + Direct Anthropic API | Two providers, swappable |

## Code Rules

1. **All code and comments in English.** No exceptions.
2. **Pre-commit hooks enforce all checks** (typecheck, lint, test).
3. Three repetitions before abstracting. No premature helpers.
4. **No synchronous mutable APIs.** Fire-and-forget + WS observe.

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Daemon health check |
| POST | /projects | Init project at `{path}` |
| GET/DELETE | /projects/:id | Get or remove project |
| POST | /projects/:id/tasks | Create task (root or child via `parentId`) |
| GET | /projects/:id/tasks | Get full task tree |
| PATCH | /projects/:id/tasks/:nodeId | Update task status/branch |
| DELETE | /projects/:id/tasks/:nodeId | Remove task and descendants |
| POST | /projects/:id/orchestrate/agent | Start orchestration (fire-and-forget) |
| POST | /projects/:id/stop | Stop running agent |
| POST | /projects/:id/message | Send instruction to root agent |
| POST | /projects/:id/tasks/:nodeId/message | Send instruction to specific child agent |
| POST | /projects/:id/sessions/clear | Wipe session history (fresh start) |
| WS | /ws | Real-time task tree + agent events |

## Event-Driven Agent Model (MessageQueue)

- **MessageQueue** (`src/message-queue.ts`): Single async channel per agent session for all events
- **execute_tasks**: Fire-and-forget — spawns children in background. Results arrive as `child_complete` via queue.
- **yield()**: Suspends agent loop (zero token burn), waits for queue message, returns messages + `## Pending` summary.
- **clarify()**: Non-blocking — emits event, agent can continue. Call yield() when ready for `clarify_response`.
- **send_message_to_child**: Sends `parent_update` to a running child via `childQueues` registry.
- **report_to_parent**: Non-blocking upward message to parent's queue as `child_report`.
- **globalAgentQueues** in `src/message-queue.ts`: global `Map<string, MessageQueue>` for all running agents, used by `POST /tasks/:nodeId/message` to route messages to specific agents.

### QueueMessage types
`user` | `child_complete` | `parent_update` | `clarify_response` | `child_report`

### yield() output format
Messages + `## Pending` section (running children list + pending clarification count). Always present.

## Session Persistence (Daemon Restart)

- DirectProvider writes session messages to `{projectPath}/.opengraft/sessions/{sessionId}.json` after each run.
- On resume: if sessionId exists but not in memory, loads from disk automatically.
- `sessions/` excluded from git via `.opengraft/.gitignore`.
- **Restart workflow**: `og stop` → restart daemon → `og orchestrate --resume` → full history restored.
- `POST /projects/:id/sessions/clear` wipes session files for a fresh start.

## Anthropic Prompt Caching (DirectProvider)

Three cache breakpoints per API call: system prompt, last tool definition, second-to-last user message.
- `input_tokens` = non-cached tokens ONLY. Do NOT subtract cache tokens from it (that was a bug).
- Cost = `input * 1x + cache_creation * 1.25x + cache_read * 0.1x + output * outputRate`
- `addMessagesCacheControl()` (exported, tested) handles message-level caching.

## Real-time Task Tree Updates

All task mutations now broadcast `tree_update` via WebSocket:
- HTTP routes: `POST/PATCH/DELETE /projects/:id/tasks` — each calls `broadcastTreeUpdate()`.
- MCP tools: `create_task`, `update_task_status`, `delete_task` — call `deps.broadcastTreeUpdate?.()`.
- `broadcastTreeUpdate` callback is passed from `daemon.ts` into `createOrchestratorTools()` and propagated to child tool sets.

## Known Pitfalls

- **Git worktrees**: `extensions.worktreeConfig` must be enabled before `git config --worktree` works. `core.hooksPath` must be absolute. New worktrees need `bun install`.
- **Nested Claude Code sessions**: must strip CLAUDECODE env vars to prevent conflicts.
- **OAuth token**: requires `anthropic-beta: oauth-2025-04-20` header.
- **Template strings in agent-tools.ts**: backticks inside the prompt strings must be escaped as `` \` `` to avoid TS parse errors.
- **Biome SVG rule**: `noSvgWithoutTitle` requires `aria-hidden="true"` on decorative inline SVGs.
- **Zod v4**: array elements at `def.element` (not `def.type`); enum values at `def.entries` (record).
- **`git merge --no-ff`**: run from the correct directory (parent worktree or main repo root).

## Methodology

- Vertical iteration: one feature at a time (types → implementation → tests → all passing).
- Don't guess APIs — read source or run `--help` first. Don't say "should work" — run it.
- Flaky test = Bug. Never fix with retries.
- No old-system fallbacks when replacing something.

## Web UI

- Design system: custom CSS variables, `og-` prefix for all classes.
- Status colors: pending=gray, in_progress=blue (#388bfd), testing=purple, passed=green, failed=red, stuck=amber.
- Inline SVG icons with `aria-hidden="true"` (biome requirement). No external icon libs.
- Agent message targeting: `targetNodeId` state in App.tsx; "Send messages here" button on in-progress tasks.
- Token breakdown shown on `orchestration_completed`: `$0.043 · 500 in · 10k write · 5k read · 200 out`.
