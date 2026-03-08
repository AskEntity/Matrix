# OpenGraft — CLAUDE.md

**A self-bootstrapping autonomous AI programming system.**

> This file is the cold-start anchor for every AI session. Read it first.
> Full methodology: `OpenGraft.md`. This file keeps only key decisions and current state.

## Operating Mode

**Autonomy**: Level 10. Work continuously: implement → test → commit → pick up next feature.
Do not ask questions — make decisions and keep moving.

**How to run E2E tests** (needs this every time after context compression):
```bash
# Load env vars from .env file (contains CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_MODEL)
source .env && export CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_MODEL
bun test src/e2e.test.ts
```

**How to run unit tests + all checks**:
```bash
bun test src/daemon.test.ts src/project-manager.test.ts src/task-tracker.test.ts src/worktree-manager.test.ts src/direct-provider.test.ts  # unit tests
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
| Language | TypeScript strict | Strong type inference, large training data, unified front/back, fast compiler feedback |
| Runtime | Bun | Fast startup, built-in test framework, native TS support |
| Lint/Format | Biome | Single tool, minimal config, AI-friendly |
| Test | bun:test | Zero config, integrated with runtime, fast (tests colocated in src/) |
| Package manager | Bun | Fastest dependency installs |
| HTTP framework | Hono | Lightweight, Bun-native, TS-first, built-in WS helper |
| AI engine (Phase 0) | Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) | Reuse existing tool impl, sandbox, context management |

## Architecture

```
Daemon (Hono: HTTP + SSE + WS on :7433)
    ↑               ↑
   CLI            Web UI
```

Daemon is the single core process. CLI and frontend are API consumers.
Project lifecycle is deterministic code, not agent work.

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Daemon health check |
| POST | /projects | Init project at `{path}` (create or convert existing) |
| GET | /projects | List all projects |
| GET | /projects/:id | Get project by ID |
| DELETE | /projects/:id | Remove project metadata (keeps code) |
| POST | /projects/:id/tasks | Create task (root or child via `parentId`) |
| GET | /projects/:id/tasks | Get full task tree |
| PATCH | /projects/:id/tasks/:nodeId | Update task status/branch |
| POST | /projects/:id/tasks/:nodeId/continue | Continue failed/stuck task (optional `{message}`) |
| DELETE | /projects/:id/tasks/:nodeId | Remove task and descendants |
| POST | /projects/:id/run | Execute agent task (one-shot) |
| POST | /projects/:id/stream | Execute agent task (SSE streaming) |
| POST | /projects/:id/decompose | Agent breaks goal into task tree |
| POST | /projects/:id/orchestrate/agent | Agent-driven orchestration with MCP tools |
| POST | /projects/:id/message | Send instruction to running agent |
| WS | /ws | Real-time task tree + agent events + message injection |

## Key Files

| File | Purpose |
|------|---------|
| src/types.ts | All type definitions (TaskNode, AgentResult, Project, etc.) |
| src/daemon.ts | Hono HTTP server, all routes, createApp() factory |
| src/agent-provider.ts | AgentProvider interface (decoupled, swappable) |
| src/claude-code-provider.ts | Claude Code Agent SDK provider (subprocess, full tool access) |
| src/direct-provider.ts | Direct Anthropic API provider (lightweight, no subprocess) |
| src/project-manager.ts | Project init/CRUD, .opengraft/ setup, git init |
| src/task-tracker.ts | Task tree CRUD, persistence to JSON |
| src/worktree-manager.ts | Git worktree lifecycle (create, remove, merge, list) |
| src/agent-tools.ts | MCP server with orchestrator tools (get_tree, create_task, spawn_task, spawn_children, delete_task) |
| src/cli.ts | CLI (`og` command) — init, list, status, run, decompose, orchestrate, continue, watch, send |
| web/ | Web UI: task tree, agent activity, message injection (served by daemon) |
| src/daemon.test.ts | API route tests (74 total across 5 files) |
| src/project-manager.test.ts | ProjectManager unit tests |
| src/task-tracker.test.ts | TaskTracker unit tests |
| src/e2e.test.ts | Real agent E2E test (token-gated) |

## Code Rules

1. **All code and comments in English.** No exceptions.
2. **All user-facing text must go through i18n.** No raw string literals in HTML/UI.
3. **Pre-commit hooks enforce all checks** (typecheck, lint, test).
4. Three repetitions before abstracting. No premature helpers.

## Methodology Summary (read every session)

### Vertical Iteration
One feature at a time: types → implementation → tests → all passing. Never spread horizontally.

### Test-Driven Self-Correction
- Hallucinations die to test results, not prompt engineering
- Deterministic tests: condition-wait not fixed delay, independent setup/teardown per test
- Flaky test = Bug. Never "fix" with retries.

### Execute to Eliminate Hallucination
- Don't guess APIs — read docs or run --help first
- Don't say "should work" — run it and see
- Don't blame the framework — suspect your own code first

### Debug Protocol
Identify layer → add logs → trust logs → isolate → minimize

### Prohibitions
- No old-system fallbacks when replacing
- No single-use helpers
- No guessing bug causes without logs

## Build Log

### Phase 0 (COMPLETE)
- [x] Project init (package.json, tsconfig, biome, hono)
- [x] Core types (TaskNode, AgentResult, Project, HealthResponse)
- [x] Daemon skeleton + /health + tests
- [x] AgentProvider interface + ClaudeCodeProvider (decoupled for future swap)
- [x] ProjectManager: init(path) — create new or convert existing projects
- [x] Projects CRUD API + tests
- [x] Agent execution: POST /run (one-shot) + POST /stream (SSE)
- [x] Nested session fix (strip CLAUDECODE env var)
- [x] E2E validated: agent creates calculator (13 tests) in 11 turns
- [x] Pre-commit hooks (typecheck + lint + test)

### Phase 1 (COMPLETE)
- [x] TaskTracker: tree CRUD, persistence, status management
- [x] Task API endpoints: POST/GET/PATCH/DELETE /projects/:id/tasks
- [x] Orchestrator: leaf-first task execution, methodology injection, pass/fail/stuck handling
- [x] POST /projects/:id/orchestrate endpoint
- [x] E2E validated: orchestrator completes 2-node task tree (37 turns, $0.47)
- [x] Context compression survival: memory.md read on agent start
- [x] Task decomposition: POST /projects/:id/decompose — agent breaks goal into task tree
- [x] WorktreeManager: git worktree lifecycle for task isolation
- [x] Session persistence: AgentRequest.resumeSessionId + AgentResult.sessionId
- [x] Runner: parallel task execution with worktree isolation, event system
- [x] POST /projects/:id/execute endpoint (worktree-based parallel)
- [x] SSE streaming: POST /execute/stream with real-time runner events
- [x] Parent agent resume: wake parent with merge prompt when children complete
- [x] Worktree cleanup after successful parent merge
- [x] E2E validated: runner parallel execution (2 children + merge, ~2min)
- [x] Full pipeline E2E: decompose (4 tasks) → execute (3 children parallel, ~3.5min)

### Phase 2 (COMPLETE)
- [x] CLI: `og init`, `og list`, `og status`, `og run`, `og decompose`, `og execute`, `og continue`
- [x] MCP tools: get_tree, create_task, update_task_status, spawn_task, spawn_children, delete_task
- [x] Agent-driven orchestration (POST /orchestrate/agent) with session persistence + cost tracking
- [x] Git-clean guard: require clean working tree before spawn
- [x] Rename .ai → .opengraft, .ai-daemon → .opengraft-daemon
- [x] Bootstrap verified: OpenGraft orchestrates its own development (version.ts task)

### Phase 3 (COMPLETE)
- [x] Web UI: dark-themed SPA with task tree + agent activity panels
- [x] WebSocket endpoint (/ws) for live task tree + agent event streaming
- [x] Real-time agent activity: tool calls, text output, errors streamed to UI
- [x] User interaction: inject messages into running agents (WS + HTTP + Web UI + CLI)
- [x] CLI `og watch`: real-time agent activity monitoring via WebSocket
- [x] CLI `og send`: send instructions to running agents
- [x] CLI `og orchestrate` streams via WebSocket for real-time output
- [x] Interactive AgentSession with streamInput() for mid-execution messages
- [x] Worktree cleanup fix: proper removal
- [x] Direct Anthropic API: DirectProvider with Messages API + built-in tools
- [x] Multi-model support: OG_PROVIDER + OG_MODEL env vars, model per AgentRequest
- [x] Cleanup: removed Runner + old Orchestrator (replaced by agent-driven orchestration)
- [x] Merge lifecycle: parent merges via bash, delete_task cleans up worktree/branch/node
- [x] Worktree isolation: per-worktree config, hooks disabled, deps installed
- [x] Retry → Continue: POST /tasks/:nodeId/continue with optional message
- [x] Web UI: task detail panel (click task → status, description, branch, actions)
- [x] Web UI: continue action for failed/stuck tasks with message input
- [x] MCP tool forwarding in DirectProvider (Zod→JSON Schema + handler routing)
- [x] Cost tracking per model (different pricing for Sonnet vs Opus vs Haiku)
- [x] Per-task agent event streaming: child agents stream events tagged with taskId
- [x] Web UI: per-task agent output log in detail panel (real-time updates)

### Phase 4 (IN PROGRESS)
- [ ] Self-bootstrap: run OpenGraft development sessions on OpenGraft itself
- [ ] Dual-track verification: compare external toolchain vs self-hosted results
