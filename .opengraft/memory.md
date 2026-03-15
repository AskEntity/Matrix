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

- Two providers: AnthropicCompatibleProvider (Anthropic API), OpenAICompatibleProvider (raw fetch, no SDK).
- Three-layer config: global > repo > local. Auth groups define provider+credentials.
- Agent tree = Task tree. Each agent gets worktree + branch. Lifecycle = branch lifecycle.
- Orchestrator has a real task node (root node with ID).
- All mutable APIs fire-and-forget. Observe via WebSocket.
- MCP tools enable recursive orchestration (tested up to 5 levels deep).

## Key Files

| File | Purpose |
|------|---------|
| src/daemon.ts | Hono app setup, route registration, ORCHESTRATOR_SYSTEM_PROMPT (~405 lines) |
| src/daemon/ | Extracted modules: context, event-system, helpers, agent-lifecycle, routes/ |
| src/agent-tools.ts | MCP tools (10), system prompts, ORCHESTRATION_KNOWLEDGE |
| src/anthropic-compatible-provider.ts | Anthropic API provider, compaction (~1200 lines) |
| src/tools/ | Extracted: definitions, search, bash, executor |
| src/openai-compatible-provider.ts | OpenAI-compatible API provider (raw fetch) |
| src/config.ts | Config system, auth groups, DEFAULT_MODEL constant |
| src/task-tracker.ts | Task tree CRUD, JSON persistence |
| src/worktree-manager.ts | Git worktree lifecycle |
| src/message-queue.ts | MessageQueue + globalAgentQueues |
| web/App.tsx | Web UI main (~650 lines, WS/handlers extracted) |
| web/ws-handler.ts | WebSocket event handler |
| web/handlers.ts | Action handlers |
| web/hooks.ts | React hooks + re-exports TaskNode/TaskStatus from src/types.ts |
| web/components/ | 15+ components (ActivityLog, ToolCard, SettingsPanel, ErrorBoundary, etc.) |

## Daemon Module Structure

`DaemonContext` (context.ts) holds all shared state. Route modules registered via `registerXxxRoutes(app, ctx)`:
- `agent-lifecycle.ts`: launchAgent, stopAgent, runChildAgentInBackground, handleOrchestrate/InjectMessage/ClarifyResponse
- `event-system.ts`: broadcast, broadcastEvent/TreeUpdate, pending messages/clarifications, event history persistence
- `helpers.ts`: getTracker, resolveProjectConfig, getProjectProvider, readProjectMemory, pruneSessionFiles
- `routes/`: projects, tasks, config, agent, websocket

## Known Pitfalls

- **memory.md**: Never `write_file` to append. Use `edit_file` (append) or `echo >>`.
- **Git worktrees**: `extensions.worktreeConfig` required. `core.hooksPath` must be absolute. `bun install` in new worktrees.
- **Prompt caching**: Don't put per-agent variables in system prompt — breaks cache sharing.
- **Biome**: Always typecheck BEFORE `bun run check` (--write can be destructive on broken JSX).
- **Template literals**: Use `${"$"}` for literal `$` in backtick strings in agent-tools.ts.
- **noUncheckedIndexedAccess**: Array index returns `T | undefined`. Use `?? ""` or `!`.
- **Compact signal in yield**: Yield tool MUST `break` after re-enqueue — without break, infinite sync loop → 100% CPU.
- **Orchestrator must never edit src files directly**: Use child tasks in worktrees. Direct edits trigger bun --watch daemon restart.
- **React overrides**: ErrorBoundary class component requires `override` keyword on state/componentDidCatch/render (noImplicitOverride).
- **Shared types**: `web/hooks.ts` re-exports `TaskNode`/`TaskStatus` from `../src/types.ts`. All web code imports from hooks.ts.

## Web UI

- **Auto-scroll**: MutationObserver (`childList + subtree + characterData`) for streaming text growth. ResizeObserver doesn't work.
- **Stop button**: Handles 404 gracefully (session gone) — resets UI. Backend resets orphaned root nodes too.
- **IME**: composingRef + keyCode 229 + isComposing triple-check for CJK input.
- **Task DnD**: HTML5 drag, `setTimeout` for setDragState in onDragStart, midpoint check for before/after.
- **App.tsx pattern**: `createWSHandler(deps)` + `createActionHandlers(deps)` — deps interface with state setters.

## Compaction

- `SUMMARIZATION_INSTRUCTION` → model responds with `<summary>` tags → `extractCheckpoint()` parses
- Resolved issues get concise outcome notes, not debugging narratives (prevents fixation on stale context)
- Manual compact: POST /compact → queue signal → yield tool re-enqueues → provider handles

## Search Tool

- `jsSearch()` filters SKIP_DIRS (node_modules, .git, dist, etc.) via `excluded_dirs` parameter
- Agent can pass custom `excluded_dirs` or empty array to search all

## Event History Replay

- `ws-handler.ts` splits into `collectEntries()` (pure, builds array) and `processSideEffects()` (state setters). Prevents tool card JSON flash during event_history replay by setting all logs in one `setLogs()` call.

## Tool Module Structure

- `src/tools/`: Extracted from anthropic-compatible-provider.ts (2190→1212 lines)
  - `definitions.ts`: TOOLS array
  - `search.ts`: jsSearch(), truncateSearchOutput(), formatContextBlock()
  - `bash.ts`: executeBashWithTimeout(), background process management
  - `executor.ts`: executeTool(), resolvePath()
  - `index.ts`: barrel re-exports
- Provider re-exports from `./tools/index.ts` for backward compatibility.
- `readProjectMemory(path, includeHeaders?)` in daemon/helpers.ts — single function for CLAUDE.md + memory.md reading. Agent-tools.ts imports with `includeHeaders=false`.

## Task UI Features

- **Color labels**: `color?: string` on TaskNode. 7-color palette in TaskDetail. Color dot in TaskTree row. PATCH + agent tools support.
- **Inline task creation**: `isCreating` state -> inline input in TaskTree. IME-safe. Blur with text confirms, without cancels.
- **Trash drop zone**: Appears during drag at TaskTree bottom. Uses dataTransfer for task ID.
- **CSS**: Use double-class selectors instead of `!important` (Biome rejects it). Always `type="button"` on buttons.

## Task Reparenting

- `TaskTracker.reparent(nodeId, newParentId)` validates circular deps by walking up parent chain from newParent.
- PATCH `/tasks/:nodeId` with `{ parentId }` triggers reparent. Returns 400 for circular dependency.
- Agent `update_task` tool: `parentId` field with scope validation (same as create_task — must be own descendant).
- DnD reparent: top/bottom 30% of row = reorder (existing), center 40% = reparent. Visual: `.og-reparent-target` class with dashed accent outline.
- `handleDrop` signature changed to include `targetNodeId` for reparent support — first param is `_targetNodeId` (unused in reorder path, reparent uses `reparentTargetId` state).
