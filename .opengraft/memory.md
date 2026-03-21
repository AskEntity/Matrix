# OpenGraft Project Memory

> Single source of truth. Read on every session start. Full design: `OpenGraft.md`

## Operating Mode

**Autonomy**: Level 10. Work continuously. Don't ask questions — decide and move.
**Workflow**: Create tasks first, refine later. Tasks persist after compaction, mental notes don't.

## How to Run Tests

```bash
bun test src/daemon.test.ts src/project-manager.test.ts src/task-tracker.test.ts src/worktree-manager.test.ts src/anthropic-compatible-provider.test.ts src/openai-compatible-provider.test.ts src/message-queue.test.ts src/agent-tools-helpers.test.ts src/config.test.ts src/events.test.ts src/event-store.test.ts src/lifecycle.test.ts
bun run typecheck   # tsc --noEmit
bun run check       # biome lint + format
```

Pre-commit hooks run typecheck + lint + unit tests.

## Architecture

```
Daemon (Hono: HTTP + SSE on :7433)
    ↑               ↑
   CLI            Web UI (React, bundled by Bun)
```

- Two providers: AnthropicCompatibleProvider, OpenAICompatibleProvider. Both share `src/tools/` and compaction.
- Three-layer config: global > repo > local. Auth groups define provider+credentials.
- Agent tree = Task tree. Each agent gets worktree + branch. Lifecycle = branch lifecycle.
- All mutable APIs fire-and-forget. Observe via SSE.
- External MCP servers: `McpClientManager` (src/mcp-client.ts), tools get `jsonSchema` (not Zod).

## Key Files

| File | Purpose |
|------|---------|
| src/daemon.ts | Hono app, routes, ORCHESTRATOR_SYSTEM_PROMPT |
| src/daemon/ | context, event-system, helpers, agent-lifecycle, routes/ |
| src/agent-tools.ts | MCP tools, system prompts, ORCHESTRATION_KNOWLEDGE |
| src/anthropic-compatible-provider.ts | Anthropic provider, compaction, retry |
| src/tools/ | definitions.ts, search.ts, bash.ts, executor.ts |
| src/config.ts | Config system, auth groups, DEFAULT_MODEL |
| src/task-tracker.ts | Task tree CRUD, JSON persistence |
| src/worktree-manager.ts | Git worktree lifecycle |
| src/message-queue.ts | MessageQueue + globalAgentQueues |
| src/persistent-queue.ts | Disk-backed message persistence |
| src/events.ts | Event types + provider converters (eventsToAnthropicMessages, eventsToOpenAIMessages) |
| src/event-store.ts | JSONL EventStore — sole persistence for events (session resume + activity log) |
| src/daemon/routes/auth.ts | WebAuthn/Passkey auth middleware + endpoints |
| src/daemon/routes/sse.ts | SSE endpoint + initial state push |
| web/App.tsx | Web UI main, SSE/handlers |
| web/ws-handler.ts | Event processing (processEvent — unified for both live and batch) |
| web/components/ | 15+ components (ActivityLog, ToolCard, SettingsPanel, etc.) |

## Core Design Principles

- **Cache invariant**: All in-memory state (queues, sessions) is cache of disk. Eviction = optimization. Daemon restart = rebuild from disk.
- **MCP/REST parity**: Same observable behavior regardless of entry point. Only difference: message source + REST notifies parent chain.
- **Message delivery guarantee**: Messages ALWAYS delivered. Active queue → enqueue directly. No queue → persist to disk + launch agent.
- **`globalAgentQueues`** is sole source of truth for running agents (root + child). Delete BEFORE close.
- **Single event path**: `emitEvent()` is THE function all events flow through (broadcast + optional persist).

## Unified Event System

**`emitEvent(ctx, projectId, event)`** — single path for ALL events:
1. Always broadcasts to SSE clients (with taskId for routing)
2. Persists non-ephemeral events to JSONL EventStore

**Ephemeral events** (broadcast only, NOT persisted to JSONL):
- `text_delta`, `usage`, `agent_idle`, `agent_active`, `status`, `queue_message`, `heartbeat`, `tree_updated`, `clarification_timeout`
- Provider events (`assistant_text`, `tool_call`, `tool_result`, `compact_marker`) — already written to JSONL by providers

**Two-phase message lifecycle**:
1. Phase 1: `message` event with `id` written to JSONL at send time → frontend defers into `deferredMessages` map → shows in pending banner
2. Phase 2: `messages_consumed` event references IDs → frontend materializes messages into activity log entries
3. Pending banner = messages in `deferredMessages` that haven't been consumed yet

**Frontend unified processor**: ONE `processEvent` function used by both live SSE events AND batch processing (page load/reconnect). `processEventBatch` just loops `processEvent` over all events. No dual-path code.

**Provider-internal events**: `message` events with `cwd` field and no `id` = provider prompts (initial/resume). Filtered out by frontend. `compacted_resume` also filtered.

## Known Pitfalls

- **memory.md**: Never `write_file` to append. Use `edit_file` or `echo >>`.
- **Git worktrees**: `extensions.worktreeConfig` required. `core.hooksPath` absolute. `bun install` in new worktrees.
- **Biome**: Typecheck BEFORE `bun run check`. Rejects `!important` (use double-class selectors). Rejects duplicate CSS properties.
- **noUncheckedIndexedAccess**: Array index returns `T | undefined`.
- **Template literals**: `${"$"}` for literal `$` in agent-tools.ts backtick strings.
- **React**: ErrorBoundary needs `override` keyword. Always `type="button"` on buttons.
- **Daemon reload**: System daemon (LaunchAgent), not `bun --watch`. Web changes need manual restart. Commits do NOT auto-restart.
- **Compact signal in yield**: MUST `break` after re-enqueue — prevents infinite sync loop.
- **Provider must exit when queue closes during tool execution**: Check `queue.isClosed` after tool execution, `return` immediately. Safety net: implicit yield catch uses `return` not `break` (Bun async generator hang).
- **Don't edit src/ directly as orchestrator**: Use child tasks in worktrees.
- **Never modify own JSONL from agent**: Current tool_call has no result yet → scan sees false orphan. JSONL fixes at stopAgent or provider resume only.
- **CSS specificity**: Biome enforces no descending specificity. More specific selectors must come AFTER less specific.

## Agent Lifecycle

- `stopAgent()` cascades: closes child queues via `globalAgentQueues`, sets children to `failed`.
- `done()` = explicit yield: sets tracker status, emits `task_completed`, blocks on `waitForQueueMessages()`. Wake messages arrive as done()'s tool_result.
- `yield()` and `done()` share `waitForQueueMessages()` helper. Both = "block and wait."
- Loop exits ONLY when queue is closed (stop signal). Stop = pause (root stays in_progress → auto-resume). Only `done()` changes to passed/failed.
- **done() deadlock fix**: `onTaskEvent` callback detects `task_completed` and closes queue immediately (child agents only).

## Task System

- 7 statuses: draft, pending, in_progress, testing, passed, failed, stuck, closed.
- `close_task`: removes worktree, status → closed. `delete_task`: full removal. `reset_task`: removes worktree + session, status → pending.
- `send_message_to_child` is universal: auto-creates worktree + launches agent. Resumes if passed/failed/closed.
- `deliverMessage()`: single delivery path. Returns `"enqueued" | "persisted"`.

## Auth

- WebAuthn/Passkey + JWT (HMAC-SHA256, Web Crypto). Token in localStorage, `authFetch()` adds Bearer header.
- SSE auth via query param (`/events?token=Y`). 30-day TTL.
- Auth always on when credentials exist. `enforced` controls registration only.

## Event Converters & JSONL

- **Converters**: `eventsToAnthropicMessages()` / `eventsToOpenAIMessages()` reconstruct provider messages from JSONL.
- **Two-phase in converter**: Events with `id` skipped at original position, materialized at `messages_consumed`.
- **Defensive guards**: `"(empty)"` fallback for undefined content. `console.warn` on each fallback.
- **Orphan tool_call defense**: Three layers — (1) `writeOrphanedToolResults()` at stopAgent, (2) `findOrphanedToolCalls()` persists fixes on resume, (3) converter full-scan safety net.
- **EventStore write serialization**: Per-session write queue prevents async race conditions.
- **Migration runner**: `ACTIVE_MIGRATIONS` in event-store.ts. Called at daemon startup. Idempotent.

## SSE Infrastructure

- **SSE replaces WebSocket**: `GET /events?projectId=X&token=Y`. Standard `ReadableStream` + `Response`.
- **Ring buffer + Last-Event-ID**: 2000-entry catch-up on reconnect. Falls back to full `sendInitialState`.
- **Two-tier heartbeat**: SSE comment every 15s (keepalive), data heartbeat every 120s (dead connection detection). Client watchdog 150s timeout.
- **Initial state**: Tree + pending clarifications sent on connect. Pending messages derived from JSONL events.

## Compaction

- **Structured checkpoint**: AI writes 7 sections in `<summary>` tags. `extractCheckpoint(responseText, cwd?)` auto-injects CWD + resume instructions.
- Anthropic SDK timeout: 60 minutes.
- `compact_marker` event in JSONL. Converter skips events before last marker.

## Mobile Layout

- `viewport-fit=cover` + `100dvh`. `@media (max-width: 768px)`: sidebar = fixed slide-in overlay.
- Safe area: `env(safe-area-inset-top/bottom)`. iOS: use `scrollTop` not `scrollIntoView`.

## User Preferences

- Don't delete completed tasks — close only.
- Don't change auth config values without permission.

## Miscellaneous

- **CF Tunnel**: macOS LaunchAgent, domain `t.opengraft.com`. rpID must match page domain.
- **clarify** tool: ALWAYS goes to user (UI), never parent. Use `report_to_parent` with `requestReply: true` for parent guidance.
- **Tool images vs queue images**: `tool_result.images` = MCP screenshots. Queue message images = user-attached, go as sibling blocks.
- **Chrome MCP**: Use `take_screenshot` for root (safe). `take_snapshot` only for child tasks with short logs.
- **Inline styles vs media queries**: CSS custom properties for flex ratios so media queries can override.
- **Done counter**: UI counts both `passed` and `closed` tasks as "done".
- **Resume error dedup**: Only show errors after last `orchestration_started` or resume event.

## File Renames
- `web/ws-handler.ts` → `web/event-handler.ts` (exports: `EventHandlerDeps`, `createEventHandler`, returns `handleEvent`)
- `web/ws-handler.test.ts` → `web/event-handler.test.ts`
