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

- **i18n**: en/zh localization via React Context. LocaleProvider wraps AppInner. All strings use t().
- **Themes**: 4 themes (dark, light, cute-light, cute-dark) via dropdown. CuteCat component for cute themes.
- **Task editing**: Title/description editable when pending (click-to-edit). Read-only with hint when running.
- **Activity log**: Tool names localized. Task instructions shown in started events.
- **Auto-save**: Prompt input saved to localStorage with 2s debounce, restored on mount.
- **Settings panel**: Model, childModel, budget, clarifyTimeout, maxDepth. Restart button when running.

## Search Tool (Pure JS)

`jsSearch()` in direct-provider.ts uses `Bun.Glob.scanSync()` + `RegExp`. No rg/grep dependency.
Supports all output modes, context lines, case insensitivity. Path-based globs work natively.

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

- Auto-resume on startup: re-launches orchestrators with saved sessions
- Orphan reset: in_progress tasks → failed before resume
- startupReady guard prevents requests during auto-resume
- Session auto-prune on startup (OG_SESSION_KEEP env, default: 5)

## Token Usage Badge

- Usage events arrive as `agent_event` with `eventType: "usage"`, containing `inputTokens`, `contextWindow`, `compressThreshold`, and optionally `estimated`.
- The App.tsx WS handler previously had a `break` for usage events (ignored them). Now we track them per-taskId in state.
- Badge shows in footer form, picks active task by priority: targetNodeId > selected task > first in_progress root task.
- Color thresholds: green (<50%), yellow (50-80%), red (>80%) based on inputTokens/contextWindow ratio.
- Light mode has separate color overrides for the badge.

## SVG Cat + Theme System

- CuteCat uses inline SVG (viewBox 0 0 100 120). Needs `<title>` + `role="img"` + `aria-label` for biome a11y.
- Themes are data-driven JS objects in `web/themes.ts`. `applyTheme()` sets CSS variables on root element.
- `ThemeConfig`: `{ name, variables, hasCat? }`. Dark theme uses `:root` defaults (empty variables).
- CSS classes `.light-mode`, `.cute-mode` removed — everything via JS variable overrides.

## Pause/Resume Buttons

- Pause/Resume are UI-only convenience buttons — no backend endpoints needed.
- They send pre-formatted messages via the existing `sendMessageToTask` API.
- Pause message tells agent to call `yield()` and wait; Resume tells it to continue.
- Both buttons show for `in_progress` and `testing` tasks in TaskDetail.
- IconPause added as inline SVG (two vertical bars pattern).

## Token Usage Badge Location
- Badge moved from footer form (caused input resize) to activity panel header (og-panel-actions div).
- Root orchestrator usage stored under PROJECT_NODE_ID key when taskId is falsy.
- Badge lookup falls back to PROJECT_NODE_ID when no specific task is selected.

## MCP Tool Result Formatting

- `formatMcpToolResult()` in App.tsx parses tool result content and returns human-readable strings.
- Only applied for successful (`isOk`) MCP tool results — errors still show raw content.
- JSON content is pre-truncated to 200 chars at creation (in WS handler). For truncated JSON (e.g., large get_tree), regex fallbacks estimate counts.
- All labels use i18n `t()` with keys prefixed `log.` (e.g., `log.createdTask`, `log.deletedTask`).
- Returns `null` on parse failure → falls back to default rendering (tool name + raw content).

## Selector Styling Unification
- Theme selector was using `og-theme-select` (custom class) while language/project selectors used `og-select`. Unified to all use `og-select`.
- Removed the now-unused `.og-theme-select` CSS rules from style.css.
- Language name i18n: each locale should show language names in its own language (en: "English"/"Chinese", zh: "英语"/"中文").

## Token Usage Tracking Fix
- Usage events were only emitted inside `if (messages.length > 4)` block, missing first few turns.
- The reported inputTokens was `estimatedInputTokens` from the previous turn (starts at 0), not actual.
- Fix: emit usage event after API response using `response.usage.input_tokens` (always, unconditionally).
- Compression check remains pre-call gated on `messages.length > 4` — these are separate concerns.

## jsSearch Single-File Path Fix
- `jsSearch()` crashed with ENOTDIR when `path` pointed to a file instead of a directory (e.g. `path: "src/daemon.ts"`).
- Fix: `statSync` check before glob scan. If file, set `files = [basename]` and `absSearchPath = dirname`.
- Also need `adjustedSearchPath` for correct `displayPath` computation — the original `searchPath` string would produce bad joins like `"src/daemon.ts/daemon.ts"`.
- When `dirname(searchPath) === "."` (file in cwd root), set `adjustedSearchPath = ""` to avoid `"./filename"` display paths.

## Tool Result Truncation Removal
- Removed 200-char `.slice(0, 200)` from WS handler tool_result creation — full content now stored in activity log state.
- Display truncation in LogEntryView increased from 120 to 500 chars for raw (non-MCP-formatted) results.
- Regex fallbacks in `formatMcpToolResult` for `execute_tasks` (spawnedMatch) and `get_tree` (idMatches) removed — no longer needed since full JSON is available for parsing.

## Root Orchestrator Lifecycle Simplification
- Removed `activeOrchestrations` Set — `activeSessions` Map is the single source of truth for running state.
- All `launchAgent()` callers now `await` it so `activeSessions.set()` completes before the caller returns, closing the race condition window that `activeOrchestrations.add()` previously covered.
- `autoResume` is now cleared on normal completion (try block) when the session is still the active one, preventing unnecessary auto-resume after successful orchestration.
- Removed duplicate `/run` endpoint — use `/orchestrate/agent` exclusively.
