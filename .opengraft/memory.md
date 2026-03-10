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
| POST | /projects/:id/stop | Stop agent (clears pending messages/clarifications) |
| POST | /projects/:id/message | Message root agent |
| POST | /projects/:id/tasks/:nodeId/message | Message specific agent |
| POST | /projects/:id/tasks/:nodeId/continue | Continue failed task (uses runChildAgentInBackground) |
| PATCH | /projects/:id/tasks/:nodeId | Update task (status, branch, title, description) |
| GET/PATCH | /projects/:id/config | Project config CRUD |
| POST | /projects/:id/clarify | Answer clarification |
| WS | /ws | Real-time events |

## MCP Tools (10 in agent-tools.ts)

get_tree, create_task, update_task_status, execute_tasks, yield, send_message_to_child, report_to_parent, delete_task, clarify, done

## Project Config

Fields: `model`, `childModel`, `provider`, `budgetUsd`, `clarifyTimeoutMs`, `maxDepth` (default: 3)
Priority: API param > project config > env var > hardcoded default

## Web UI Features

- **i18n**: en/zh localization via React Context. All strings use t().
- **Themes**: 4 themes via JS variable overrides in themes.ts.
- **Prompt input**: `<textarea>` with Shift+Enter for newlines, Enter to submit. `isComposing` check for CJK IME compatibility. Auto-resize up to 4 lines.
- **Activity log**: Full tool results stored (no pre-truncation). Display truncation at 500 chars for raw results. MCP results formatted via `formatMcpToolResult()`. Tool_use and tool_result use block layout with word-wrap.
- **Task actions**: Pause/Resume + Delete for child tasks. Stop only on OrchestratorDetail.
- **Token badge**: In activity panel header. green (<50%), yellow (50-80%), red (>80%).

## Search Tool (Pure JS)

`jsSearch()` in direct-provider.ts: `Bun.Glob.scanSync()` + `RegExp`. No rg/grep dependency.
Supports directory and single-file paths. `multiline` parameter in schema but not implemented (TODO).

## Known Pitfalls

- **memory.md**: Never `write_file`. Always `edit_file` (append) or `echo >>`.
- **Git worktrees**: `extensions.worktreeConfig` required. `core.hooksPath` must be absolute. `bun install` in new worktrees.
- **Prompt caching**: Don't put per-agent variables in system prompt — breaks cache sharing.
- **macOS CWD**: `/var` → `/private/var` symlink. Fixed with `realpathSync()`.
- **Biome**: Always typecheck BEFORE `bun run check` (--write can be destructive on broken JSX).
- **Template literals**: Use `${"$"}` for literal `$` in backtick strings in agent-tools.ts.
- **noUncheckedIndexedAccess**: Array index returns `T | undefined`. Use `?? ""` or `!`.
- **Multiline queue messages**: Pending message acknowledgement splits on `\n(?=\[)` not `\n` to handle multiline user messages.

## Daemon Lifecycle

- `activeSessions` Map is single source of truth for running state.
- `launchAgent()` is async — callers `await` it for session registration.
- `autoResume` cleared on normal completion; persists only during restart or crash.
- `/stop` clears pendingMessages + pendingClarifications Maps + broadcasts empties.
- `/restart` clears pendingClarifications (stale after context change).
- `sessions/clear` rejects 409 if agent running.
- `DELETE /projects/:id` stops running agent before deletion.
- `runChildAgentInBackground()` extracted from `/continue` handler — reusable child agent runner.
- Orphan reset: in_progress tasks → failed before auto-resume.
- Session auto-prune on startup (OG_SESSION_KEEP env, default: 5).

## Token Usage Tracking

- Usage events emitted after every API response using `response.usage.input_tokens`.
- Tracked per-taskId in frontend; root orchestrator under PROJECT_NODE_ID key.

## Compaction Fix (2026-03-10)
- **Bug**: `compressMessages()` returned `[user(checkpoint), assistant(ack)]`. The assistant ack caused the API call to fail because the Anthropic API rejects messages ending with assistant role.
- **Fix**: Removed the assistant ack. Compressed messages now return only `[user(checkpoint)]`. The model generates a fresh response from the checkpoint context.

## Task Execution Efficiency
- Avoid running full test suites in every child task — too expensive. Use `bun run typecheck` for quick validation.
- Skip biome/lint checks in child tasks unless the task specifically touches formatting.
- Pre-commit hooks run typecheck + lint + tests automatically, so explicit runs are often redundant.

## Compaction System Overhaul (2026-03-10)
- **No truncation**: `compressMessages()` no longer truncates tool_use inputs, tool_result content, or per-message content. Full transcript sent to summarizer.
- **Transcript limit**: 640k chars (~160k tokens) to leave room for 32k output tokens. Truncates from HEAD (keeps tail/newest), prepends "[Earlier conversation truncated]".
- **max_tokens**: Increased from 8192 to 32768 for richer checkpoint summaries.
- **Tail preservation**: After generating checkpoint, keeps ~80k chars of most recent messages. Tail must start with user role. Bridge assistant message inserted between checkpoint(user) and tail(user) to maintain valid alternation.
- **CHECKPOINT_SYSTEM_PROMPT**: Added "Agent Tree State" and "Communication State" sections for multi-agent awareness.


## Daemon Refactoring (stopAgent + shared handlers)
- **`stopAgent()`**: Single function for all stop operations. Options: `clearAutoResume` (true for explicit user stop/delete), `keepPendingMessages` (true for restart so messages survive for new session).
- **Shared handlers**: `handleOrchestrate()`, `handleInjectMessage()`, `handleClarifyResponse()` used by both REST routes and WS message handlers. Return `{ ok, error?, status? }`.
- **`pruneSessionFiles()`**: Shared between autoResumeProjects and POST /sessions/prune.
- **restartingProjects guard**: Both REST /orchestrate/agent and /agents/start now check `restartingProjects.has()` to prevent starting during restart.
- **DELETE /projects/:id cleanup**: Now clears pendingMessages, pendingClarifications, eventHistory in addition to stopping agent and removing tracker.

## Tool Card Redesign (activity log)
- Tool entries (tool_use + tool_result) now render as cards instead of inline entries.
- Merging logic is in the rendering layer: `ActivityLog` uses `useMemo` to pair adjacent tool_use → tool_result with matching tool names into `tool_card` entries.
- `ToolCard` component: collapsible card with header (tool name, status icon, chevron toggle) and body (args + result).
- MCP tools (mcp__opengraft__*) get purple accent and special card body rendering via `McpToolCardBody`.
- Default collapsed if total content > 200 chars, expanded if short.
- Resume button removed from TaskDetail — only Pause shown for running tasks.

## IME Enter Key Fix (keyCode 229)
- `composingRef` alone is insufficient — some IME candidate selections (e.g., English words in Chinese IME) bypass composition events entirely.
- `e.keyCode === 229` is the most reliable IME detection: browsers set it for ALL IME-related key events. Despite being deprecated, it is universally supported and the only reliable method.
- Belt-and-suspenders: check `composingRef.current`, `e.nativeEvent.isComposing`, AND `e.keyCode !== 229`.
