# OpenGraft Project Memory

> This is the project's living knowledge base. Every agent reads this on startup.
> Agents: append discoveries, never modify existing entries from parent branches.
> See OpenGraft.md for the full methodology and vision.

## Architecture

- Daemon is the single core process (Hono on :7433). CLI and Web UI are API consumers.
- Two providers: ClaudeCodeProvider (subprocess, full tool access) and DirectProvider (direct API, lightweight)
- Agent tree = Task tree. Each agent gets a worktree + branch. Agent lifecycle = branch lifecycle.
- All mutable APIs are fire-and-forget. Observe via WebSocket.
- MCP tools enable recursive orchestration: any agent can become a sub-orchestrator.

## Git Worktree Configuration

- `extensions.worktreeConfig` MUST be enabled before `git config --worktree` works
- Without it, `--worktree` silently writes to shared `.git/config`
- Hooks are shared across all worktrees — use per-worktree `core.hooksPath` to override
- `core.hooksPath` must be absolute path (relative resolves differently in worktrees)
- New worktrees don't have node_modules — must run `bun install` after creation
- WorktreeManager.create() handles all of this: enable extension, add worktree, disable hooks, install deps

## Pre-commit Hook

- Hook at `.hooks/pre-commit`, configured via `core.hooksPath = .hooks`
- Runs: typecheck → lint → unit tests. All must pass.
- Hook `unset`s GIT_DIR etc. so subprocess git operations work correctly
- Child agent worktrees disable hooks via `core.hooksPath /dev/null`

## Zod v4 Schema Conversion (DirectProvider)

- Zod v4 stores array elements at `def.element` (not `def.type`)
- Zod v4 stores enum values at `def.entries` (record), not `def.values` (array)
- `zodShapeToJsonSchema` handles: string, number, boolean, enum, optional, default, array, object
- Missing type support defaults to `{ type: "string" }` — always verify new Zod types are handled

## Testing Patterns

- Use `bun test` — zero config, integrated with Bun runtime
- Tests colocated in `src/` alongside implementation
- daemon.test.ts uses `createApp()` factory for isolated HTTP testing
- Worktree tests need actual git repos — use `mkdtemp` + `git init` + cleanup in afterEach
- 94 tests across 5 files (daemon, project-manager, task-tracker, worktree-manager, direct-provider)

## Known Pitfalls

- Nested Claude Code sessions: must strip CLAUDECODE env vars to prevent conflicts
- OAuth token requires `anthropic-beta: oauth-2025-04-20` header
- DirectProvider maxTurns: default 200, detect infinite loops early
- `git merge --no-ff` from the correct directory (parent's worktree or main repo)
- After merge + delete_task: worktree, branch, and task node are all cleaned up

## Project Goal

OpenGraft is a self-bootstrapping autonomous AI programming system. The full vision is in
OpenGraft.md. Current phase: Phase 4 (self-bootstrapping) — using OpenGraft to develop itself.
The system should eventually replace its Claude Code dependency with its own tool layer,
support multiple AI providers, and enable distributed AI instances to improve the system
via PR-based contributions.
