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

## Agent Notification on User Tree Mutations

- REST task mutations inject `[TREE UPDATED]` message into running agent session. `editedBy?: "user" | "agent"` on TaskNode.

## Task Reparenting

- `TaskTracker.reparent(nodeId, newParentId)` with circular dep validation. PATCH with `{ parentId }`.
- Agent `update_task` tool: `parentId` field with scope validation.
- DnD: center 40% of row = reparent, top/bottom 30% = reorder. `.og-reparent-target` visual indicator.

## UI Fix Notes (March 2026)

- **Root node flicker fix**: The fallback `roots` computation (when `rootNodeId` is null) now excludes nodes that are parents of other nodes, not just nodes with no `parentId`. This prevents the root orchestrator node from showing during initial render.
- **Root drop zone**: `RootDropZone` component appears during drag when the dragged node is not already at root level. Uses `og-root-drop-zone` CSS class with accent-blue hover styling.
- **[TREE UPDATED] card**: Detected via `entry.text.includes("[TREE UPDATED]")` in `queue_message` handler in ToolCard.tsx. Rendered with `og-tool-card-system` class (green accent).
- **Color UI**: Was already fully implemented - color dot in TaskTree row, color picker in TaskDetail, PATCH API support.
## Agent MCP Tools

- `reorder_tasks` tool added alongside existing tools. Pattern: scope validation (currentTaskId check + isDescendantOf), then tracker method, save, broadcastTreeUpdate.

## Settings Panel Auth Group Dropdown

- `SettingAuthGroupSelect` component: reusable select dropdown that reads auth group names from `layers.global.authGroups` keys. Used for both `defaultAuth` and `childAuth` fields.
- Global tab: auth groups + default auth dropdown + daemon settings + MCP servers. No model fields (those are project/local level).
- Project/Local tabs (shared `ProjectTab` component): auth dropdowns, root model, task agent model, limits, MCP servers.
- Translation keys renamed: `settings.modelOverride` → `settings.rootModel`, `settings.childModel` → `settings.taskAgentModel`.

## SettingsPanel Refactor (March 2026)

- `ModelsAuthSection` component: shared across all 3 tabs (global/project/local). Takes `layer`, `authGroupNames`, `draft`, `onDraftChange`.
- Config key mapping: Root Auth → `defaultAuth`, Root Model → `model`, Child Auth → `childAuth`, Child Model → `childModel`.
- Global tab: no inherit options, Child Auth defaults to "Use Root Auth", Child Model placeholder is "Use Root Model".
- Project/Local tabs: all fields have "— Inherit —" as first option (empty string value). Child Auth also has "Use Root Auth" option.
- `__use_root_auth__` sentinel in childAuth select maps to empty string on save (clears childAuth → falls back to defaultAuth).
- Panel header title changes per active tab: "Global Settings" / "Project Settings" / "Local Settings".
- Removed `SettingStringField` and `SettingAuthGroupSelect` (replaced by inline rendering in ModelsAuthSection).
- i18n keys added: `settings.rootAuth`, `settings.childModel`, `settings.inheritOption`, `settings.useRootAuth`, `settings.useRootModel`, `settings.titleGlobal/Project/Local`.

## External MCP Server Support

- `src/mcp-client.ts`: `McpClientManager` class connects to external MCP servers via stdio transport using `@modelcontextprotocol/sdk`.
- External tool schemas are JSON Schema (not Zod). Added optional `jsonSchema` field to `ToolDefinition` — providers use it directly instead of calling `zodShapeToJsonSchema()`.
- Integration in `agent-lifecycle.ts`: both `launchAgent` and `runChildAgentInBackground` create `McpClientManager`, `connectAll()` from config, merge tool defs, and `disconnectAll()` in finally/cleanup.
- `connectAll()` uses `Promise.allSettled` — individual server failures don't block others. Failed servers are logged but not added to the map.
- Tool handler closure captures `serverName` and `tool.name`, calls `mcpManager.callTool()` which returns `CallToolResult` directly — compatible with both providers.
## Background Process Management

- ALL bash commands use file-based stdout/stderr redirection (`Bun.file(path)` to `/tmp/opengraft-bg/`). Consistent approach — no piped output.
- `BackgroundProcess` interface has `kill: (() => void) | null`, `stdoutPath`, `stderrPath` fields.
- Agent can `read_file` on output file paths for partial output while process is running.
- `bg_action` parameter on bash tool: `kill` terminates process + returns final output, `status` returns metadata + file paths (running) or stored output (completed).
- `timeout` parameter removed from bash tool schema. Internal 600s safety timeout hardcoded in executor.ts.
- Temp files cleaned up on completion, kill, or session cleanup.
- CWD tracking only applies to foreground-completed commands. Backgrounded commands never update CWD.

## Hard Timeout Removal (March 2026)

- Removed `hardTimeout` parameter from `executeBashWithTimeout()` and all callers.
- Background processes (immediate or promoted from foreground) now run until natural exit or explicit `bg_action: "kill"`.
- No more automatic `setTimeout(() => proc.kill(), ...)` kill timers.
- The `foregroundTimeout >= hardTimeout` branch was removed — foreground commands just race `foreground_timeout` vs process exit.
- executor.ts no longer has a 600s safety timeout constant.

## Bash Tool Card Rendering Fix (March 2026)

- `getToolCardTitle()` for bash: when `bg_action` is present in toolArgs, shows `bg kill: <bgId>` or `bg status: <bgId>` instead of `$ ignored`.
- `formatArgs()` accepts optional `excludeKeys?: Set<string>` parameter. For bash bg_action calls, `command` key is excluded from displayed args.
- `bashBgExcludeKeys()` helper returns the exclude set when toolName is "bash" and bg_action is present.
