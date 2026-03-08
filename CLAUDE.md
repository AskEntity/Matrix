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
bun test src/daemon.test.ts src/project-manager.test.ts src/task-tracker.test.ts src/orchestrator.test.ts src/worktree-manager.test.ts src/runner.test.ts  # unit tests
bun run typecheck   # tsc --noEmit
bun run check       # biome lint + format
```

**Pre-commit hooks are active** (.hooks/pre-commit runs typecheck + lint + unit tests).

## Current Phase: Phase 2

Phase 1 complete: task decomposition + worktree-isolated parallel execution + parent merge.
Phase 2: Main agent as orchestrator — agent observes tree, spawns tasks via MCP tools.

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
| POST | /projects/:id/tasks/:nodeId/retry | Reset failed/stuck task to pending |
| DELETE | /projects/:id/tasks/:nodeId | Remove task and descendants |
| POST | /projects/:id/run | Execute agent task (one-shot) |
| POST | /projects/:id/stream | Execute agent task (SSE streaming) |
| POST | /projects/:id/decompose | Agent breaks goal into task tree |
| POST | /projects/:id/execute | Run task tree with worktree isolation (parallel) |
| POST | /projects/:id/orchestrate | Run pending tasks sequentially (legacy) |
| POST | /projects/:id/orchestrate/agent | Agent-driven orchestration with MCP tools |

## Key Files

| File | Purpose |
|------|---------|
| src/types.ts | All type definitions (TaskNode, AgentResult, Project, etc.) |
| src/daemon.ts | Hono HTTP server, all routes, createApp() factory |
| src/agent-provider.ts | AgentProvider interface (decoupled, swappable) |
| src/claude-code-provider.ts | Phase 0 impl: delegates to Claude Agent SDK |
| src/project-manager.ts | Project init/CRUD, .opengraft/ setup, git init |
| src/task-tracker.ts | Task tree CRUD, persistence to JSON |
| src/worktree-manager.ts | Git worktree lifecycle (create, remove, merge, list) |
| src/runner.ts | Agent-driven parallel task execution with worktree isolation |
| src/orchestrator.ts | Legacy sequential orchestrator (kept for backward compat) |
| src/agent-tools.ts | MCP server with orchestrator tools (get_tree, create_task, spawn_task, merge_branch) |
| src/cli.ts | CLI (`og` command) — init, list, status, run, decompose, orchestrate, execute |
| src/daemon.test.ts | API route tests (33 tests, 81 total across 6 files) |
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

### Phase 2 (IN PROGRESS)
- [x] CLI: `og init`, `og list`, `og status`, `og run`, `og decompose`, `og execute`, `og retry`
- [x] Better decomposition: merge-safe prompt (non-overlapping file boundaries)
- [x] Retry endpoint: POST /tasks/:nodeId/retry (reset failed/stuck → pending)
- [x] MCP server for agent tools: get_tree, create_task, update_task_status, spawn_task, merge_branch
- [x] AgentRequest.mcpServers support in ClaudeCodeProvider
- [x] POST /orchestrate/agent endpoint: agent-driven orchestration with MCP tools
- [x] CLI `og orchestrate` command
- [x] E2E validated: agent orchestrator creates 3 tasks + executes via MCP tools (17 turns, $0.18)
- [x] spawn_children tool for true parallel execution via Promise.all
- [x] E2E validated: 2 independent modules spawned in parallel (23 turns, $0.32)
- [x] cleanup_worktrees MCP tool for post-orchestration cleanup
- [x] Orchestrator session persistence + resume (--resume flag in CLI)
- [x] Cost tracking: CostAccumulator across orchestrator + child agents
- [x] Concurrent orchestration guard (409 on double-run)
- [x] Orchestrator prompt tuning: explicit finalization steps, root marked as passed
- [x] E2E validated: 4-node tree (root + setup + 2 modules), all passed (22 turns, $0.99)
- [x] 自举测试成功

### Phase 3 (NEXT)
- [ ] Direct Anthropic API: bypass Claude Code subprocess, use Messages API directly
- [ ] Multi-model support: select model per task (cheap model for simple tasks)
- [ ] Web UI: real-time dashboard for task tree visualization
