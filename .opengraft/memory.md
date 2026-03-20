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
Daemon (Hono: HTTP + WS on :7433, admin :7434)
    ↑               ↑
   CLI            Web UI (React, bundled by Bun)
```

- Two providers: AnthropicCompatibleProvider, OpenAICompatibleProvider. Both share `src/tools/` and compaction.
- Three-layer config: global > repo > local. Auth groups define provider+credentials.
- Agent tree = Task tree. Each agent gets worktree + branch. Lifecycle = branch lifecycle.
- All mutable APIs fire-and-forget. Observe via WebSocket.
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
| src/session-store.ts | SessionStore (cache + disk) for session history |
| src/events.ts | Event types + provider converters (eventsToAnthropicMessages, eventsToOpenAIMessages) |
| src/event-store.ts | JSONL EventStore — append-only event persistence |
| src/daemon/routes/auth.ts | WebAuthn/Passkey auth middleware + endpoints |
| web/App.tsx | Web UI main, WS/handlers |
| web/ws-handler.ts | WS event processing (processEvent, UpdateOp) |
| web/components/ | 15+ components (ActivityLog, ToolCard, SettingsPanel, etc.) |

## Core Design Principles

- **Cache invariant**: All in-memory state (queues, sessions) is cache of disk. Eviction = optimization. Daemon restart = rebuild from disk.
- **MCP/REST parity**: Same observable behavior regardless of entry point. Only difference: message source + REST notifies parent chain.
- **Message delivery guarantee**: Messages ALWAYS delivered. Active queue → enqueue directly. No queue → persist to disk + launch agent.
- **`globalAgentQueues`** is sole source of truth for running agents. Delete BEFORE close (callers see "no queue" not "closed queue").

## Known Pitfalls

- **memory.md**: Never `write_file` to append. Use `edit_file` or `echo >>`.
- **Git worktrees**: `extensions.worktreeConfig` required. `core.hooksPath` absolute. `bun install` in new worktrees.
- **Biome**: Typecheck BEFORE `bun run check`. Rejects `!important` (use double-class selectors). Rejects duplicate CSS properties (use CSS variables for progressive enhancement).
- **noUncheckedIndexedAccess**: Array index returns `T | undefined`.
- **Template literals**: `${"$"}` for literal `$` in agent-tools.ts backtick strings.
- **React**: ErrorBoundary needs `override` keyword. `web/hooks.ts` re-exports types from `src/types.ts`. Always `type="button"` on buttons.
- **Inline styles vs media queries**: Inline `style={{ flex: val }}` beats CSS. Use CSS custom properties: `style={{ '--var': val }}` + `flex: var(--var)` in CSS, override with direct `flex: 1` in media query.
- **Daemon reload**: System daemon (LaunchAgent), not `bun --watch`. Web changes need manual restart. Commits do NOT auto-restart.
- **Compact signal in yield**: MUST `break` after re-enqueue — prevents infinite sync loop.
- **Don't edit src/ directly as orchestrator**: Use child tasks in worktrees.

## Agent Lifecycle

- `stopAgent()` cascades: closes child queues via `globalAgentQueues`, sets children to `failed`.
- `done()` = explicit yield: sets tracker status, broadcasts `task_completed`, then calls `waitForQueueMessages()` (same as yield()). Blocks the tool handler — provider never makes another API call after done(). Wake messages arrive as done()'s tool_result.
- `yield()` and `done()` share `waitForQueueMessages()` helper. Both tools = "block and wait for messages." yield() is an explicit tool for AI psychology ("I called a tool, something will happen"). Implicit yield (end_turn) is equivalent but AI is reluctant to use it.
- Loop exits ONLY when queue is closed (stop signal).
- Stop = pause (root stays in_progress → auto-resume on restart). Only `done()` changes to passed/failed.
- `runChildAgentInBackground` handles ALL child lifecycle: queue, streaming, done() detection, cost, completion events.
- **done() deadlock fix**: done()=yield blocks on queue.wait() before tool_result emits. `onTaskEvent` callback in `createAgentContext` detects `task_completed` (emitted before blocking) and closes queue immediately. Only for child agents (depth > 0). `tool_result` detection in `runChildCore` remains as fallback.

## Task System

- 7 statuses: draft, pending, in_progress, testing, passed, failed, stuck, closed.
- `close_task`: removes worktree, status → closed. `delete_task`: full removal. `reset_task`: removes worktree + session, status → pending.
- `send_message_to_child` is universal: auto-creates worktree + launches agent if not running. Resumes if passed/failed/closed.
- `deliverMessage()`: single path for ALL delivery (root + child). Returns `"enqueued" | "persisted"`. Root: no auto-launch (caller handles). Child: auto-launches via `ensureChildAgentRunning`. `handleInjectMessage` is a thin REST wrapper.

## WebAuthn/Passkey Authentication

- Auth is ALWAYS on when credentials exist. `enforced` only controls whether registration is allowed.
- Main port (7433) requires auth. Admin port (7434) localhost-only, no auth.
- Middleware exempts `/`, `/web/*`, `/auth/*`. First-run bypass when no credentials.
- `resolveOrigin` respects `X-Forwarded-Proto` for CF Tunnel.
- simplewebauthn v13: `Uint8Array<ArrayBuffer>` type, `{optionsJSON}` wrapper for `startRegistration`.

## Mobile Layout

- `viewport-fit=cover` + `100dvh` (not `100vh` — iOS Safari bug).
- `@media (max-width: 768px)`: sidebar = fixed slide-in overlay, detail panel hidden, activity log fills height.
- Safe area: `env(safe-area-inset-top/bottom)` on header/footer.
- Panel flex ratios via CSS custom properties (`--split-ratio`, `--activity-ratio`) so media queries can override.

## Compaction

- **Structured checkpoint**: AI writes 7 sections in `<summary>` tags. System auto-injects CWD + resume instructions via `extractCheckpoint(responseText, cwd?)`.
- "Key Insights & Rejected Approaches" — high-level design principles, not API quirks.
- Anthropic SDK timeout: 60 minutes (1 hour) (default 10min insufficient for large contexts under load).

## SSE Error Retry

- SSE stream errors have `APIError.status === undefined`. Retry catches: RateLimitError, APIConnectionError, InternalServerError, status 529, AND status undefined.

## Event System (`src/events.ts`)

- **`Event` type** (renamed from StrongEvent): provider-agnostic, strongly-typed. Types: `user_message`, `assistant_text`, `tool_call`, `tool_result`, `queue_message`, `compacted_resume`, `summarization_request`, `budget_warning`, `compact_marker`. Each has `ts: number`.
- **`queue_message` is a discriminated union by `source`** (`QueueMessageEvent`): stores structured data (taskId, title, success, etc.), NOT pre-formatted XML strings. Formatting happens in converters at consumption time.
- **`EventStore`** (`src/event-store.ts`): JSONL append-only. `readActive()` returns events after last `compact_marker`.
- **Converters**: `eventsToAnthropicMessages()` and `eventsToOpenAIMessages()` reconstruct provider messages. `formatQueueMessageEvent()` formats structured queue events for AI.
- **Old `CanonicalEvent` system deleted** — no more dual-write, no more `.events.json` files.
- **Compaction**: `compact_marker` event. Converter skips events before last marker.
- **Test command includes**: `src/events.test.ts src/event-store.test.ts` (not `canonical-events.test.ts`).

## CF Tunnel

- Running as macOS LaunchAgent (`com.cloudflare.cloudflared`), domain `t.opengraft.com`.
- rpID must match page domain for WebAuthn.

## User Preferences

- Don't delete completed tasks — close only.
- Don't change auth config values without permission.

## Slash Commands

- Frontend slash commands (/compact, /clear) handled in `web/handlers.ts` via `handleSlashCommand()`. `pendingCompact` state removed — WS events drive UI feedback.

## Event Converter Details

- **Assistant text format**: Always use array `content` for assistant messages, never bare string.
- **Idle vs working queue wrapper**: Standalone queue events (idle drain) batched with `[Messages received while you were idle:]`. Cancellation-point uses `[Messages received while you were working:]`.
- **caller field**: Converter adds `caller: {type: "direct"}` to tool_use blocks to match Anthropic API.
- **Single formatter**: `formatQueueMessage` → `formatEventForAI(queueMessageToEvent(msg))` — one source of truth.
- **XML rules**: `user_message` and `compact_request` = raw content. `clarify_response` and `system_notification` = XML for semantic clarity. Multi-field events (child_complete, parent_update, etc.) = XML for structured data.
- **Mocking Anthropic SDK**: Fake stream with `{[Symbol.asyncIterator], finalMessage}`. Replace `(provider as any).client`.

## Pending Message Banner (Data-Driven)

- Queue state is the source of truth (`ctx.pendingMessages` removed). `MessageQueue.peekMessages()` + `onDrain` callback.
- `broadcastPendingFromQueue()` on enqueue, `broadcastPendingCleared()` on drain. No fallback — one mechanism only.

## clarify Tool Routing

- `clarify` ALWAYS goes to the user (via UI), never to the parent orchestrator.
- For child agents needing design guidance: use `report_to_parent` with `requestReply: true` instead.

## Tool Images vs Queue Images Separation

- `tool_result.images` = tool images only (MCP screenshots). Embedded INSIDE tool_result content.
- `queue_message.images` = user images only (sent via queue). Sibling blocks with annotation.
- Cancellation-point queue messages recorded as separate `queue_message` Events (not mixed into tool_result).

## Unified Event System (Completed March 2026)

**One Event type for the entire system.** 5 parallel event systems → 1.

```
Event (src/events.ts) — THE source of truth
  ├── JSONL persistence (EventStore)
  ├── WS broadcast (BroadcastEvent subset)
  ├── Provider converter → AI messages
  └── Frontend LogEntry = Event & { id, taskId? }
```

**Event types** (all in one discriminated union):
- Provider: `user_message`, `assistant_text`, `tool_call`, `tool_result`, `compacted_resume`, `summarization_request`, `budget_warning`, `compact_marker`
- Queue: `child_complete`, `parent_update`, `clarify_response`, `child_report`, `cross_project`, `background_complete`, `system_notification`, `compact_request`
- Lifecycle: `text_delta`, `usage`, `orchestration_started/completed`, `task_started/completed`, `agent_idle/active/stopped`, `error`, `budget_exceeded`, `clarification_requested/answered`, `tree_mutation`, `compact_started`

**Key helpers:**
- `formatEventForAI(event)` — formats any Event for AI consumption (XML for multi-field, raw for simple)
- `queueMessageToEvent(msg)` — converts runtime QueueMessage to concrete Event type
- `isQueueEvent(event)` — identifies queue-originated events for converter batching
- `normalizeLegacyEvent(event)` — backward compat for old `queue_message` JSONL events
- `formatTime(ts)` — frontend renders `ts` field on demand (no pre-formatted `time` string)

**Frontend residual:** `UIOnlyEvent` has 2 types (`lifecycle`, `generic_queue_message`) that are frontend-only. `UIEvent = Event | BroadcastEvent | UIOnlyEvent`. `LogEntry = UIEvent & { id, taskId? }`.

## Activity Log Migration (JSONL EventStore)

- **Old system deleted**: `data/events/<projectId>.json` (JSON array), `ctx.eventHistory`, `eventsDirty`, `eventFlushTimer`, `MAX_EVENT_HISTORY`, `loadEventHistory`, `flushEvents`, `scheduleEventFlush`, `getEventHistory`, `eventsPath`.
- **New system**: All activity log events served from per-task JSONL files (`data/<projectId>/events/<taskId>.events.jsonl`).
- **Lifecycle events added to Event union**: `orchestration_started/completed`, `task_started/completed`, `error`, `budget_exceeded`, `clarification_requested/answered`, `tree_mutation`, `compact_started`, `agent_stopped`, `message_injected`.
- **broadcastEvent()** now persists lifecycle events to JSONL via `broadcastToEvent()` converter. Provider events (assistant_text, tool_call, tool_result, compact_marker) are skipped since providers already write them.
- **REST endpoints**: `GET /projects/:id/events` merges all tasks' JSONL sorted by `ts`. `GET /projects/:id/tasks/:nodeId/events` returns one task's events. Both normalize Event→BroadcastEvent field names (toolCallId→toolUseId, add taskId).
- **Frontend**: Fetches events from REST on project change. WS subscribe no longer sends `event_history`. `createWSHandler` returns `{ handleWS, processEventBatch }`.
- **normalizeEventForUI()**: Maps Event field names to BroadcastEvent-compatible format for frontend `processEvent()`.
- **EventStore.listSessions()** and **readAllSorted()**: New methods for project-level event retrieval.


## Frontend addLog Audit (March 2026)

- **Principle**: "UI must never show anything that disappears on refresh." All activity log entries must come from backend-persisted events.
- **Error addLog calls are OK**: Transient UX feedback for failed API calls (no backend event for "frontend fetch failed"). These are ephemeral by design.
- **Daemon restart addLog is OK**: Page is about to reconnect anyway.
- **Removed**: `⚡ /compact`, `⚡ /clear`, `Session history cleared`, `Deleted: ...` — all had backend event equivalents (`compact_started`, `tree_mutation`).
- **Slash commands**: `handleSlashCommand` still routes to correct API endpoints, just no longer injects frontend-only log entries.


## EventStore Async Writes (March 2026)

- **appendFileSync → async appendFile**: EventStore.append() and appendBatch() now return Promise<void> with internal .catch() for fire-and-forget safety.
- **Callers**: broadcastEvent() fire-and-forgets. Provider runLoop calls are also fire-and-forget (unawaited Promises in async generators). Tests must await.
- **Reads remain sync**: read(), readActive() still use readFileSync — only called during session resume, not in hot path.

## MessageQueue onEnqueue Callback

- **Bug**: `enqueue()` has two paths — waiter (direct resolve) and array (push to `this.messages`). The waiter path bypasses the array, so `peekMessages()` returns empty and `onDrain` never fires. This broke pending message banner display.
- **Fix**: Added `onEnqueue?: (msg: QueueMessage) => void` callback, called at the TOP of `enqueue()` before the waiter check. Fires on every enqueue regardless of path. `onDrain` still handles clearing.
- **Wiring**: Set `queue.onEnqueue` at queue creation sites in `agent-lifecycle.ts` (child queues and root queue). Removed all manual `broadcastPendingFromQueue` calls after `enqueue()` in `deliverMessage` — the callback handles it.
