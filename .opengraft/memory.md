# OpenGraft Project Memory

> Single source of truth. Read on every session start. Full design: `OpenGraft.md`

## Operating Mode

**Autonomy**: Level 10. Work continuously. Don't ask questions — decide and move.
**Workflow**: Create tasks first, refine later. Never just mentally note things — create tasks (they persist after compaction, notes don't).

## How to Run Tests

```bash
bun test src/daemon.test.ts src/project-manager.test.ts src/task-tracker.test.ts src/worktree-manager.test.ts src/anthropic-compatible-provider.test.ts src/openai-compatible-provider.test.ts src/message-queue.test.ts src/agent-tools-helpers.test.ts src/config.test.ts
bun run typecheck   # tsc --noEmit
bun run check       # biome lint + format
```

Pre-commit hooks run typecheck + lint + unit tests.

## Architecture

```
Daemon (Hono: HTTP + WS on :7433)
    ↑               ↑
   CLI            Web UI (React, bundled by Bun)
```

- Two providers: AnthropicCompatibleProvider (Anthropic API), OpenAICompatibleProvider (raw fetch, no SDK). Both share `src/tools/` (definitions, search, bash, executor) and compaction flow.
- Three-layer config: global > repo > local. Auth groups define provider+credentials.
- Agent tree = Task tree. Each agent gets worktree + branch. Lifecycle = branch lifecycle.
- Orchestrator has a real task node (root node with ID).
- All mutable APIs fire-and-forget. Observe via WebSocket.
- MCP tools enable recursive orchestration (tested up to 5 levels deep).
- External MCP servers: `McpClientManager` (src/mcp-client.ts) connects via stdio, tools get `jsonSchema` field (not Zod).

## Key Files

| File | Purpose |
|------|---------|
| src/daemon.ts | Hono app setup, route registration, ORCHESTRATOR_SYSTEM_PROMPT |
| src/daemon/ | Extracted modules: context, event-system, helpers, agent-lifecycle, routes/ |
| src/agent-tools.ts | MCP tools, system prompts, ORCHESTRATION_KNOWLEDGE |
| src/anthropic-compatible-provider.ts | Anthropic API provider, compaction |
| src/tools/ | definitions.ts, search.ts, bash.ts, executor.ts, index.ts |
| src/openai-compatible-provider.ts | OpenAI-compatible API provider (raw fetch) |
| src/config.ts | Config system, auth groups, DEFAULT_MODEL constant |
| src/task-tracker.ts | Task tree CRUD, JSON persistence |
| src/worktree-manager.ts | Git worktree lifecycle |
| src/message-queue.ts | MessageQueue + globalAgentQueues |
| web/App.tsx | Web UI main, WS/handlers extracted to ws-handler.ts + handlers.ts |
| web/hooks.ts | React hooks + re-exports TaskNode/TaskStatus from src/types.ts |
| web/components/ | 15+ components (ActivityLog, ToolCard, SettingsPanel, ErrorBoundary, etc.) |

## Daemon Module Structure

`DaemonContext` (context.ts) holds all shared state. Route modules via `registerXxxRoutes(app, ctx)`:
- `agent-lifecycle.ts`: launchAgent, stopAgent (cascades to children), runChildAgentInBackground, createAgentContext (shared setup), consumeAgentEvents (shared event loop)
- `event-system.ts`: broadcast, broadcastEvent/TreeUpdate, pending messages/clarifications
- `helpers.ts`: getTracker, resolveProjectConfig, getProjectProvider, readProjectMemory
- `routes/`: projects, tasks, config, agent, websocket

## Known Pitfalls

- **memory.md**: Never `write_file` to append. Use `edit_file` (append) or `echo >>`.
- **Git worktrees**: `extensions.worktreeConfig` required. `core.hooksPath` must be absolute. `bun install` in new worktrees.
- **Prompt caching**: Don't put per-agent variables in system prompt — breaks cache sharing.
- **Biome**: Always typecheck BEFORE `bun run check` (--write can be destructive on broken JSX).
- **Template literals**: Use `${"$"}` for literal `$` in backtick strings in agent-tools.ts.
- **noUncheckedIndexedAccess**: Array index returns `T | undefined`. Use `?? ""` or `!`.
- **Compact signal in yield**: MUST `break` after re-enqueue — without break, infinite sync loop → 100% CPU.
- **Orchestrator must never edit src files directly**: Use child tasks in worktrees. Direct edits trigger bun --watch daemon restart.
- **React overrides**: ErrorBoundary class component requires `override` keyword (noImplicitOverride).
- **Shared types**: `web/hooks.ts` re-exports `TaskNode`/`TaskStatus` from `../src/types.ts`. All web code imports from hooks.ts.
- **CSS**: Use double-class selectors instead of `!important` (Biome rejects it). Always `type="button"` on buttons.

## Agent Lifecycle

- `stopAgent()` cascades: closes all child `MessageQueue`s via `globalAgentQueues`, sets children to `failed`.
- `activeSessions` Map is single source of truth for orchestrator running state.
- Orphan reset on startup: in_progress tasks → failed (skip root node).
- `done()` race fix: providers check `queue.pending` before exiting when `doneRef.done` is set.

## Bash Tool

- File-based stdout/stderr to `/tmp/opengraft-bg/`. Large output (>50KB) → 5KB preview + file path.
- `bg_action: kill|status` for background processes. No hard timeout — runs until exit or explicit kill.
- CWD tracked for foreground commands only. `cd` to same directory returns error.
- Temp files persist until session cleanup via `cleanupSessionBackgroundProcesses()`.

## Search Tool

- `jsSearch()` in `src/tools/search.ts`. Filters SKIP_DIRS via `excluded_dirs` parameter.
- Multiline mode: RegExp `s` flag, `offsetToLine` binary search for match→line mapping.

## Web UI

- **Auto-scroll**: MutationObserver (`childList + subtree + characterData`) for streaming text growth.
- **Stop button**: Handles 404 gracefully — resets UI. Backend resets orphaned root nodes too.
- **IME**: composingRef + keyCode 229 + isComposing triple-check for CJK input.
- **Task DnD**: HTML5 drag. Center 40% = reparent, top/bottom 30% = reorder. Trash/root drop zones.
- **ActivityLog**: toolUseId-based pairing for tool_use→tool_result. task_completed includes output summary.
- **Event replay**: `ws-handler.ts` batches all entries in one `setLogs()` call (prevents flash).
- **Settings**: `ModelsAuthSection` shared across 3 tabs. `__use_root_auth__` sentinel for childAuth.

## Compaction

- `SUMMARIZATION_INSTRUCTION` → `<summary>` tags → `extractCheckpoint()`. Manual: POST /compact.
- Guidance: resolved issues get concise outcome notes, not debugging narratives.

## Task System

- Color labels: named categories (Bug=red, Feature=blue, etc.) via `resolveColor()` in agent-tools.ts.
- `editedBy?: "user" | "agent"` on TaskNode. REST mutations inject `[TREE UPDATED]` message.
- `reparent(nodeId, newParentId)` with circular dep validation. `reorderChildren()` for ordering.
- `reorder_tasks` MCP tool with scope validation (currentTaskId + isDescendantOf).

## Cross-Project Communication

- `list_projects` and `send_message_to_project` tools (depth 0 only). `cross_project` QueueMessage source.

## Clarify Response Routing

- `handleClarifyResponse` routes via `globalAgentQueues.get(taskId) ?? session.queue`.

## Persistent Sub-Orchestrators

- `delete_task` splits: passed tasks get worktree/branch cleaned (`cleaned: true`) but node stays in tree. Non-passed tasks fully removed.
- `TaskTracker.cleanNode(id)` clears branch/worktreePath/sessionId, sets `cleaned: true`.
- REST `DELETE /tasks/:id` still fully removes (user-initiated).
