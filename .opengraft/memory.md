# OpenGraft Project Memory

> Single source of truth. Read on every session start. Full design: `OpenGraft.md`

## Operating Mode

**Autonomy**: Level 10. Work continuously. Don't ask questions — decide and move.
**Workflow**: Create tasks first, refine later. Never just mentally note things — create tasks (they persist after compaction, notes don't).

## How to Run Tests

```bash
bun test src/daemon.test.ts src/project-manager.test.ts src/task-tracker.test.ts src/worktree-manager.test.ts src/direct-provider.test.ts src/message-queue.test.ts src/agent-tools-helpers.test.ts
bun run typecheck   # tsc --noEmit
bun run check       # biome lint + format
```

Pre-commit hooks run typecheck + lint + unit tests. i18n check: `bash scripts/check-i18n.sh`.

## Architecture

```
Daemon (Hono: HTTP + WS on :7433)
    ↑               ↑
   CLI            Web UI (React, bundled by Bun)
```

- Two providers: ClaudeCodeProvider (subprocess), DirectProvider (direct Anthropic API)
- Agent tree = Task tree. Each agent gets worktree + branch. Lifecycle = branch lifecycle.
- All mutable APIs fire-and-forget. Observe via WebSocket.
- MCP tools enable recursive orchestration (tested up to 5 levels deep).

## Key Files

| File | Purpose |
|------|---------|
| src/daemon.ts | HTTP server, routes, WS, ORCHESTRATOR_SYSTEM_PROMPT |
| src/agent-tools.ts | MCP tools (10), system prompts, ORCHESTRATION_KNOWLEDGE |
| src/direct-provider.ts | Direct API provider, search tool (jsSearch), CWD tracking |
| src/task-tracker.ts | Task tree CRUD, JSON persistence |
| src/worktree-manager.ts | Git worktree lifecycle |
| src/message-queue.ts | MessageQueue + globalAgentQueues |
| web/App.tsx | Web UI main component |
| web/hooks.ts | React hooks (useWebSocket, useProjects, useTasks, useAgent, useProjectConfig) |
| web/i18n.ts | Localization (en/zh), LocaleProvider, useLocale, t() |
| web/style.css | CSS design system, themes (dark/light/cute-light/cute-dark) |

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| POST | /projects/:id/orchestrate/agent | Start orchestration |
| POST | /projects/:id/restart | Restart agent (applies config changes) |
| POST | /projects/:id/stop | Stop agent |
| POST | /projects/:id/message | Message root agent |
| POST | /projects/:id/tasks/:nodeId/message | Message specific agent |
| POST | /projects/:id/tasks/:nodeId/continue | Continue failed task |
| PATCH | /projects/:id/tasks/:nodeId | Update task (status, branch, title, description) |
| GET/PATCH | /projects/:id/config | Project config CRUD |
| POST | /projects/:id/clarify | Answer clarification |
| WS | /ws | Real-time events |

## MCP Tools (10 in agent-tools.ts)

get_tree, create_task, update_task_status, execute_tasks, yield, send_message_to_child, report_to_parent, delete_task, clarify, done

**create_task**: Without parentId, auto-parents under currentTaskId. Root orchestrator creates top-level.
**execute_tasks**: Fire-and-forget. task_started event now includes `message` (instructions).
**yield**: Blocks for queue messages. Timeout applies when pendingClarifications > 0.

## Project Config

Fields: `model`, `childModel`, `provider`, `budgetUsd`, `clarifyTimeoutMs`, `maxDepth` (default: 3)
Priority: API param > project config > env var > hardcoded default
`maxDepth` and `clarifyTimeoutMs` are propagated through nested createOrchestratorTools calls.

## Web UI Features

- **i18n**: en/zh localization via React Context. All strings use t().
- **Themes**: 4 themes (dark, light, cute-light, cute-dark) via JS variable overrides in themes.ts.
- **Task editing**: Title/description editable when pending (click-to-edit). Read-only with hint when running.
- **Activity log**: Full tool results stored (no pre-truncation). Display truncation at 500 chars for raw results. MCP tool results formatted as human-readable summaries via `formatMcpToolResult()`.
- **Tool labels**: `white-space: nowrap` on `.og-tool-name`, `.og-tool-result-ok`, `.og-tool-result-err` to prevent wrapping.
- **Token badge**: In activity panel header. Color thresholds: green (<50%), yellow (50-80%), red (>80%).
- **Pause/Resume**: UI-only convenience — send pre-formatted messages via existing API.

## Search Tool (Pure JS)

`jsSearch()` in direct-provider.ts uses `Bun.Glob.scanSync()` + `RegExp`. No rg/grep dependency.
Supports directory and single-file paths, all output modes, context lines, case insensitivity.
`multiline` parameter exists in schema but not yet implemented (TODO).

## Known Pitfalls

- **memory.md**: Never `write_file`. Always `edit_file` (append) or `echo >>`.
- **Git worktrees**: `extensions.worktreeConfig` required. `core.hooksPath` must be absolute. `bun install` in new worktrees.
- **Prompt caching**: Don't put per-agent variables in system prompt — breaks cache sharing.
- **macOS CWD**: `/var` → `/private/var` symlink. Fixed with `realpathSync()`.
- **Biome**: `<div role="button">` → use `<button>`. Always typecheck BEFORE `bun run check` (--write can be destructive on broken JSX).
- **Template literals**: Use `${"$"}` for literal `$` in backtick strings in agent-tools.ts.
- **Budget**: Don't set on child tasks. Project-level safety limits only.
- **Restart race**: launchAgent finally block checks session identity before cleanup. restartingProjects guard prevents double-restart.
- **report_to_parent**: Uses `deps.parentQueue` (not `deps.queue`) to route upward.
- **noUncheckedIndexedAccess**: Array index returns `T | undefined`. Use `?? ""` or `!`.

## Daemon Lifecycle

- `activeSessions` Map is single source of truth for running state (no separate Set).
- `launchAgent()` is async — callers `await` it to ensure session registration completes.
- `autoResume` cleared on normal completion; persists only during restart or crash.
- Orphan reset: in_progress tasks → failed before resume.
- startupReady guard prevents requests during auto-resume.
- Session auto-prune on startup (OG_SESSION_KEEP env, default: 5).

## Token Usage Tracking

- Usage events emitted after every API response using `response.usage.input_tokens`.
- Tracked per-taskId in frontend state; root orchestrator under PROJECT_NODE_ID key.
- Badge lookup: targetNodeId > selected task > first in_progress root task > PROJECT_NODE_ID.

## Lifecycle Edge Cases (daemon.ts)
- `/stop` must clear `pendingMessages` and `pendingClarifications` Maps + broadcast empty arrays so UI clears.
- `/restart` must clear `pendingClarifications` (stale after context change).
- `sessions/clear` must reject 409 if `activeSessions.has(project.id)`.
- `DELETE /projects/:id` must stop running agent before `pm.delete()`.
- Test pattern: use `createLongRunningProvider()` with 10s timeout in `events()` to keep agent alive during test.

## Refactoring: runChildAgentInBackground (daemon.ts)
- Extracted from `/continue` handler async IIFE into `runChildAgentInBackground(project, tracker, nodeId, prompt, model?)`.
- Lives inside `createApp()` closure so it has access to `config`, `broadcastEvent`, `broadcastTreeUpdate`, `loadProjectConfig`.
- Re-reads the task node internally (`tracker.get(nodeId)`) to get fresh `worktreePath`, `sessionId`, etc.
- Fire-and-forget: caller does NOT await it.
