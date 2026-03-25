# OpenGraft Project Memory

> Single source of truth. Read on every session start. Full design: `OpenGraft.md`

## ⚠️ Architecture Discipline

Every bug fix MUST ask: (1) What caused this specific bug? (2) Why does the architecture make this class of bug easy?

**Anti-patterns**: duplicate codepaths with subtle differences, lifecycle dependency coupling, legacy fallbacks masking bugs, stale mental models in new code, lazy optional fields.

## ⚠️ Task Execution Discipline

Creating tasks is CHEAP. Executing must be DELIBERATE. When user discusses design → draft + discuss. Only execute when they say "go" / "做" / "开始".

## How to Run Tests

```bash
bun test src/daemon.test.ts src/project-manager.test.ts src/task-tracker.test.ts src/worktree-manager.test.ts src/anthropic-compatible-provider.test.ts src/openai-compatible-provider.test.ts src/message-queue.test.ts src/agent-tools-helpers.test.ts src/config.test.ts src/events.test.ts src/event-store.test.ts src/lifecycle.test.ts
bun run typecheck   # tsc --noEmit
bun run check       # biome lint + format
```

## Architecture Overview

```
Daemon (Hono: HTTP + SSE on :7433)
    ↑               ↑
   CLI            Web UI (React, bundled by Bun)
```

- Two providers: `AnthropicCompatibleProvider`, `OpenAICompatibleProvider`. Both share `src/tools/` and compaction.
- Three-layer config: global > repo > local. Auth groups define provider+credentials.
- Agent tree = Task tree. Each agent gets worktree + branch. Lifecycle = branch lifecycle.
- All mutable APIs fire-and-forget. Observe via SSE.
- External MCP servers: `McpClientManager` (src/mcp-client.ts), tools get `jsonSchema` (not Zod).

## Key Files

| File | Purpose |
|------|---------|
| src/daemon.ts | Hono app, routes |
| src/daemon/ | context, event-system, helpers, agent-lifecycle, routes/ |
| src/system-prompts.ts | SYSTEM_PROMPT, ROOT_ORCHESTRATOR_ROLE, buildSystemPrompt() |
| src/orchestrator-tools.ts | MCP tool definitions + handlers |
| src/provider-shared.ts | Run loop, ProviderAdapter, executeTool |
| src/compaction.ts | extractCheckpoint, buildCompactedContext, processCompaction |
| src/event-converter.ts | walkEventsToMessages, EventConverterCallbacks |
| src/anthropic-compatible-provider.ts | Anthropic provider |
| src/openai-compatible-provider.ts | OpenAI provider |
| src/tools/ | definitions.ts, search.ts, bash.ts, background.ts, executor.ts |
| src/config.ts | Config system, auth groups |
| src/task-tracker.ts | Task tree CRUD, JSON persistence |
| src/worktree-manager.ts | Git worktree lifecycle |
| src/message-queue.ts | MessageQueue |
| src/persistent-queue.ts | Disk-backed message persistence |
| src/events.ts | Event types + helpers |
| src/event-store.ts | JSONL EventStore |
| src/types.ts | TaskSession interface |
| src/shared-types.ts | PendingState, EventImageData, InternalToolResult |
| src/task-utils.ts | buildTaskPrompt, readProjectMemory |
| src/daemon/routes/auth.ts | WebAuthn/Passkey auth + endpoints |
| src/daemon/routes/sse.ts | SSE endpoint + initial state |
| web/App.tsx | Web UI main, SSE/handlers |
| web/event-handler.ts | processEvent (unified live + batch) |
| web/components/ | ActivityLog, ToolCard, Card, LogEntryView, etc. |

## Core Design Principles

- **Cache invariant**: All in-memory state is cache of disk. Daemon restart = rebuild from disk.
- **Message delivery guarantee**: Active queue → enqueue. No queue → persist to disk + launch agent.
- **`task.session`** = sole source of truth for running agents. `session != null` = agent running.
- **Single event path**: `emitEvent()` handles SSE broadcast + JSONL persistence.
- **Two-phase message lifecycle**: Phase 1: `message` event persisted → frontend defers. Phase 2: `messages_consumed` → frontend materializes into activity log.

## Tool Architecture

All tools are `ToolDefinition[]` under `mcp__opengraft__*` namespace. ONE execution path via `mcpHandler.handler()`.

**TaskSession** — runtime-only field on `TaskNode`. Contains: `queue`, `cwd`, `fallbackCwd`, `depth`, `backgroundProcesses`, `foregroundExecutions`.

`createBuiltinTools()` + `createOrchestratorTools()` → merged at launch. System prompt = strategy only — `ToolDefinition.description` is sole source of truth for how to call tools.

## Message Schema

`MessageEvent.body` = `QueueMessage` discriminated union. `body.source` discriminates: `user`, `child_complete`, `parent_update`, `child_report`, `cross_project`, `background_complete`, `tree_change`, `clarify_response`.

- `header?: string` on `user` and `parent_update` — context prepended for AI, stripped before UI delivery.
- Messages with `id: ""` = provider prompts (filtered by frontend).
- `send_message` tool: direction determined by comparing taskId to currentNode.parentId.

## Agent Lifecycle

- `done()` → update status + deliver `child_complete` to parent + close queue (child) or block (root).
- `yield()` + `done()` share `waitForQueueMessages()`. Loop exits when queue closed.
- `stopAgent()` cascades: closes child queues, sets children to `failed`.
- done() directly enqueues child_complete to parent (stateless). runChildAgentInBackground only handles fallback.

## Event System

**Ephemeral** (broadcast only): `text_delta`, `usage`, `agent_idle`, `agent_active`, `status`, `heartbeat`, `tree_updated`, `clarification_timeout`.

**Persisted**: Everything else. `isPersistedByEmitEvent()` in events.ts — exhaustive switch, compile-time enforced.

**Provider events** (assistant_text, tool_call, tool_result, compact_marker) persisted via emit callback = emitEvent.

**Event converters**: `walkEventsToMessages()` + `EventConverterCallbacks`. Two-phase: events with `id` deferred until `messages_consumed`. `TOOL_NAME_ALIASES` for backward compat with old JSONL.

## Frontend

- `IncomingEvent` type = `UIEvent | SSEOnlyEvent`. Single `as IncomingEvent` cast at SSE boundary.
- `processEvent` / `processEventBatch` — unified for live + batch.
- `tool_pair` UIOnlyEvent combines tool_call + tool_result. `resolve_tool` / `remove_tool` UpdateOps.
- `applyUpdate(entries, op)` pure function for all log mutations.
- `Card.tsx` — base card component. `ToolCard` extends it.
- All major components wrapped with `React.memo`.
- `SLASH_COMMANDS` in SlashCommandMenu.tsx: `/compact`, `/stop`, `/clear`, `/settings`.
- localStorage keys: `og-` prefix (e.g., `og-jwt`, `og-theme`, `og-locale`).

## Known Pitfalls

- **memory.md**: Never `write_file` to append. Use `edit_file` or `echo >>`.
- **Git worktrees**: `extensions.worktreeConfig` required. `core.hooksPath` absolute.
- **Biome**: Typecheck BEFORE lint. Rejects `!important` (use double-class selectors). No duplicate CSS properties. No descending CSS specificity.
- **noUncheckedIndexedAccess**: Array index returns `T | undefined`.
- **Template literals**: `${"$"}` for literal `$` in backtick strings.
- **React**: `override` keyword on ErrorBoundary. Always `type="button"` on buttons.
- **Daemon reload**: System daemon (LaunchAgent), not `bun --watch`. Commits do NOT auto-restart.
- **Compact signal in yield**: MUST `break` after re-enqueue — prevents infinite sync loop.
- **Provider queue close**: Check `queue.isClosed` after tool execution, `return` immediately.
- **Don't edit src/ directly as orchestrator**: Use child tasks in worktrees.
- **Never modify own JSONL from agent**: Current tool_call has no result yet → false orphan.
- **CSS attribute selectors break with i18n**: Use class-based selectors instead.
- **Worktree setup hook**: `.opengraft/hooks/setup_worktree.sh` required. Missing = fail.

## Auth

WebAuthn/Passkey + JWT (HMAC-SHA256). Token in localStorage (`og-jwt`), `authFetch()` adds Bearer header. SSE auth via query param. 30-day TTL.

## Compaction

Structured checkpoint: 7 `<summary>` sections. `extractCheckpoint()` auto-injects CWD + resume instructions. `compact_marker` in JSONL — converter skips events before last marker.

## Background Processes

Two tools: `bash` (execute) + `background` (manage: list/status/kill/await). `formatBashResult()` shared for all output paths. `run_in_background: true` = `foreground_timeout=0`. REST endpoints for move-to-background, kill, cancel-await.

## Fork Task Context

`fork_task_context` MCP tool + `POST /tasks/:nodeId/fork` REST. Copies post-compact events from source session to target (which must have no existing session). Appends `fork_marker` event. Converter treats fork_marker as transparent pass-through.

## Ownership Framing

System prompt uses ownership language: agents "own" tasks. "sub task" for downward, "the task above" for upward. No "parent/child" agent language. `send_message` is unified — direction determined by taskId comparison. `clarify` always goes to user (UI).

## Tree Change Notifications

`source: "tree_change"` QueueMessage with `action`, `nodeId`, `title`. `notifyTreeChange()` walks parent chain, quiet-enqueues to each running ancestor. UI sidebar updates via `tree_updated` ephemeral event.

## Lazy-Load Activity Log

`EventStore.readFromLastCompactMarker()` for initial load. `readBefore()` for pagination. `GET /events?after=compact` for post-compact only. Frontend "Load earlier history" button re-fetches full events.

## Cross-Project Communication

`send_message_to_project` auto-launches target agent if not running via `injectMessageToProject`.

## Orphan Tool Call Defense

Three layers: (1) `writeOrphanedToolResults()` at stopAgent, (2) `findOrphanedToolCalls()` on resume, (3) converter full-scan safety net.

## Anthropic Cache TTL

System prompt + tools: `ttl: "1h"`. Messages: orchestrator `1h`, child agents `5m` (default).

## User Preferences

- Don't delete completed tasks — close only.
- Don't change auth config values without permission.
- User communicates in Chinese, expects Chinese for conversation.
- User prefers discussing architecture before executing.
- Remove project = non-destructive (registry removal only, data preserved).


## Child Agent Lifecycle Events

- `runChildAgentInBackground()` originally did NOT emit `orchestration_started` or `agent_stopped` events.
- Only `launchAgent()` (root agent path) emitted these. The frontend relies on `orchestration_started` to add taskId to `activeAgents` Set, and `agent_stopped`/`orchestration_completed` to remove it.
- Fix: emit `orchestration_started` before `runChildCore()` and `agent_stopped` in the `finally` block of `runChildAgentInBackground()`.
- For root agents, normal completion emits `orchestration_completed` (not `agent_stopped`); `agent_stopped` only emits on error. For child agents, we always emit `agent_stopped` in `finally` since child agents dont have `orchestration_completed`.

