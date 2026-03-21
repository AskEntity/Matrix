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
| src/events.ts | Event types + provider converters (eventsToAnthropicMessages, eventsToOpenAIMessages) |
| src/event-store.ts | JSONL EventStore — sole persistence for events (session resume + activity log) |
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
- **Provider must exit when queue closes during tool execution**: After done() closes the queue, provider must check `queue.isClosed` after tool execution and `return` immediately — never send tool results to the API. The extra API call enters implicit yield on a closed queue, where `break` from `catch` hangs in Bun. Safety net: implicit yield catch uses `return` not `break`.
- **Don't edit src/ directly as orchestrator**: Use child tasks in worktrees. Exception: deadlock debugging — edit directly per user instruction.

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

## Deadlock Proper Fix (March 2026)

- **Root cause**: After done() closes the queue, provider checked `queue.isClosed` BEFORE yielding tool_result events. On resume, orphaned tool_use without tool_result → Anthropic 400 error.
- **Fix**: Moved `queue.isClosed` check to AFTER EventStore records tool_result events but BEFORE `messages.push` (which sends to API). Both providers fixed.
- **Safety net**: Implicit yield catch block uses `return` not `break` (Bun async generator `break`-from-`catch` hangs under concurrent I/O).



## Autonomous Operation Mode (March 2026)

- **User left for extended period** (possibly months). Run fully autonomously.
- **Use take_screenshot, NOT take_snapshot** for Chrome MCP — snapshots blow up context fast.
- **Priorities**: Fix bugs, streamline code, remove workarounds, unified maintainable codepaths.
- **Be careful**: Dont break daemon startup — cant self-recover if daemon wont start.
- **Test via Chrome MCP**: Send messages, take screenshots to verify UI rendering.
- **Restart daemon**: Via Settings button in UI (Chrome MCP) or POST /restart-daemon with auth cookie.


## Input Lag Fix (March 2026)

- **Root cause**: `prompt` state in App.tsx → every keystroke triggers full App re-render (ActivityLog with thousands of entries).
- **Fix**: Extracted `InputBar` component (`web/components/InputBar.tsx`) with local `prompt` + `attachedImages` state. App only receives final values via `onSend(message, images?)` callback.
- **AppFooter**: Now delegates form rendering to `InputBar`. Props simplified — no more `prompt`, `onPromptChange`, `attachedImages`, `onImageAttach`, `onImageRemove`.
- **handlers.ts**: `handleSubmit(e)` → `handleSend(message, images?)`. No longer reads prompt/images from closure.


## Lifecycle Test Patterns (March 2026)

- **Fresh vs resume detection**: `handleInjectMessage` checks `eventStore.has(rootNodeId)`. If true → resume with generic prompt. If false → fresh start with user message as prompt.
- **launchAgent prompt prepends memory**: For fresh starts, `launchAgent` reads `.opengraft/memory.md` and prepends to prompt. Test with `toContain()` not `toBe()`.
- **sessions/clear wipes JSONL events too**: `clearAll()` removes the entire sessions dir. EventStore cache is also cleared.
- **Capturing provider pattern**: Create a provider that records `AgentRequest` objects passed to `startSession()` — useful for verifying prompt content, resumeSessionId, and other session parameters.

## SessionStore Removal (March 2026)

- **Deleted**: `src/session-store.ts` and `src/session-store.test.ts`. SessionStore was a cache of provider-native message arrays (JSON files).
- **EventStore is now sole persistence**: Providers reconstruct messages from EventStore JSONL on resume via `eventsToAnthropicMessages()` / `eventsToOpenAIMessages()`.
- **Resume path**: `eventStore.readActive(sessionId)` → converter → messages array. `isResume = activeEvents.length > 0`.
- **taskContext for compaction**: On resume, reads first `user_message` from full event history (`eventStore.read(sessionId)`, not `readActive`).
- **EventStore.clearAll()**: New method — deletes all JSONL files in the directory.
- **handleInjectMessage resume detection**: Uses `eventStore.has(rootNodeId)`.
- **Conversation endpoint**: Reconstructs from EventStore events (user_message, assistant_text, tool_call).
- **pruneSessionFiles**: Prunes `.events.jsonl` files.
- **Type casts**: `eventsToAnthropicMessages()` and `eventsToOpenAIMessages()` return `unknown[]` — cast at call sites.


## Yield Pending Section — Descendant Tracking (March 2026)

- **Bug**: `waitForQueueMessages()` in `agent-tools.ts` only checked direct children (`tracker.get(currentTaskId)?.children`) when building the `## Pending` summary. Children launched by the daemon (not via the orchestrator MCP tool) were already visible since `globalAgentQueues` is the source of truth for running agents, but grandchildren (descendants) were not tracked.
- **Fix**: Added `getDescendantIds(tracker, ancestorId)` helper that collects all descendant node IDs (breadth-first). Used in both `waitForQueueMessages()` pending section and `hasRunningChildren()`.
- **Key insight**: `globalAgentQueues` already tracks ALL running agents regardless of launch path (MCP tool or daemon). The issue was only checking direct children instead of the full descendant tree.


## Event Converter Lifecycle Skip (March 2026)

- **Critical bug**: `eventsToAnthropicMessages()` and `eventsToOpenAIMessages()` had no `default` case. Lifecycle events (`orchestration_started`, `agent_stopped`, etc.) in JSONL caused infinite loop (i never advanced). Root cause of daemon deadlock on startup after SessionStore removal (resume path now reads from JSONL which includes lifecycle events).
- **Fix**: Added `default: i++; break;` to both converters.
- **Regression test**: `converter resilience — lifecycle events in JSONL` in `src/events.test.ts`.

## Pending Banner Data Format (March 2026)

- **Bug**: `broadcastPendingFromQueue` sent `{text, timestamp}` but frontend expected `{id, taskId, text, timestamp}`. Pending banner never showed because type mismatch.
- **Fix**: Added `id: "pending-${Date.now()}"` and `taskId: null` to all 3 pending broadcast sites (event-system.ts, agent-lifecycle.ts, routes/projects.ts).

## Data Cleanup (March 2026)

- **Deleted**: `~/.opengraft/events/*.json` (old JSON array event files from pre-JSONL migration)
- **Deleted**: `~/.opengraft/sessions/*/*.json` (old SessionStore JSON files, replaced by `.events.jsonl`)
- **Kept**: `~/.opengraft/logs/` (daemon stdout/stderr logs)


## EventStore Write Serialization (March 2026)

- **Critical bug**: Multiple unawaited `appendBatch()` calls raced, causing tool_result events to appear before their matching tool_call in JSONL. On resume, the converter saw orphaned tool_result → Anthropic 400 error. User had to manually reorder the JSONL to fix.
- **Root cause**: `appendFile()` is async. Two fire-and-forget `appendBatch()` calls (one for assistant_text+tool_call, one for tool_result) could complete out of order.
- **Fix**: Added per-session write queue (`Map<sessionId, Promise>`) in EventStore. Each write chains on the previous via `.then()`, guaranteeing sequential execution. Queue entries self-clean after completion.


## Message Injected Timing Fix (March 2026)

- **Problem**: `message_injected` broadcast in `handleInjectMessage` showed user messages in activity log immediately on send. User wanted them to appear when the agent actually consumes them.
- **Fix**: Removed `message_injected` from the "enqueued" and "persisted" paths in `handleInjectMessage`. Added emission in `launchAgent`'s `consumeAgentEvents` callback — when `queue_message` event has `rawMessages` with `source: "user"`, emits `message_injected` at that point.
- **Fresh starts kept**: When no session exists (first message = prompt), `message_injected` still fires immediately since there's no queue delay.
- **Both idle drain and cancellation point work**: Both yield `queue_message` with `rawMessages`, so user messages consumed either way trigger `message_injected`.


## Unified Message Abstraction (March 2026)

**Core insight**: User messages can only be injected at cancellation points (API constraint). Two-phase lifecycle separates this constraint from user-facing abstraction.

- **UserMessageEvent**: Single interface for ALL queue messages. `source` field discriminates (user, child_complete, parent_update, clarify_response, cross_project, background_complete, system, compact).
- **Two-phase lifecycle**: Phase 1 = `user_message { id, content, ts }` written to JSONL at send time. Phase 2 = `messages_consumed { messageIds, ts }` (or `messagesConsumed` on `tool_result`) marks consumption at cancellation point.
- **Converter**: Events with `id` are skipped at original position, materialized at `messages_consumed` point. Backward-compatible: events without `id` work as before.
- **`queueMessageToEvent`**: Returns `UserMessageEvent` with `source` field. All queue types unified under `type: "user_message"`.
- **`handleInjectMessage`**: Writes user_message to JSONL BEFORE delivery. Checks `eventStore.has()` BEFORE writing.
- **Legacy types preserved**: child_complete, parent_update, etc. kept in Event union for old JSONL backward compat.


## BroadcastEvent/Event Unification (March 2026)

- **BroadcastEvent = Event**: `BroadcastEvent` is now a deprecated type alias for `Event`. One type for everything: JSONL persistence, WS broadcast, REST responses, frontend rendering.
- **Ephemeral types added to Event**: `text_delta`, `usage`, `agent_idle`, `agent_active`, `status`, `queue_message`, `clarification_timeout`. Converters skip these via `default` case.
- **toolCallId everywhere**: BroadcastEvent used `toolUseId`, Event used `toolCallId`. Unified to `toolCallId`. AgentEvent (internal provider format) still uses `toolUseId`; `agentEventToBroadcast` maps it.
- **Optional taskId on all types**: `assistant_text`, `tool_call`, `tool_result`, `compact_marker` now have `taskId?`. Set at broadcast time for WS routing.
- **broadcastToEvent simplified**: No field-by-field conversion. Just filter ephemeral types and use Event directly.
- **normalizeEventForUI simplified**: Only adds `taskId` (no more toolCallId→toolUseId mapping).
- **ws-handler backward compat**: Reads both `toolCallId` and `toolUseId` from incoming messages for compatibility with old cached WS data.


## User Message Consumption-Time Display (March 2026)

- **Eliminated `message_injected` event type** — replaced by two-phase `user_message` + `messages_consumed` lifecycle.
- **Send time**: `user_message` (with `id`) written to JSONL and broadcast via WS. Frontend shows in PENDING area (not activity log).
- **Consumption time**: `messages_consumed` broadcast via WS when provider drains queue. Frontend moves messages from pending to ACTIVITY LOG.
- **Fresh starts**: `user_message` without `id` (initial prompt via `orchestration_started`) shows directly in activity log — no pending phase.
- **Backend broadcasts**: `user_message` events broadcast directly via `broadcast()` (not `broadcastEvent()` which would persist — already persisted separately). `messages_consumed` broadcast extracted from `queue_message` rawMessages user IDs in `onEvent` callbacks.
- **`toRawMessage()`**: Now includes `id` field for user messages so `extractConsumedUserIds()` can find them in queue_message events.
- **Batch processing**: `processEventBatch` in ws-handler.ts resolves two-phase lifecycle locally — collects `user_message` with IDs, materializes them at `messages_consumed` position (or `messagesConsumed` on `tool_result`). Unconsumed messages go to pending state.
- **Backward compat**: Old `message_injected` events in JSONL still render via ws-handler fallback case.

## Message Delivery Unification (March 2026) — COMPLETED

**Previous problem**: 4+ code paths implemented message delivery differently (missing JSONL writes, missing broadcasts, inconsistent pending banners). Root cause of repeated bugs across 5+ sessions.

**Fix**: `deliverMessage()` is now the single delivery path. All callers are thin wrappers. `globalAgentQueues` is the sole queue registry (root + children). `findParentQueue()` exported for dynamic lookup. `broadcastAgentStreamEvent()` unifies consumption tracking.

## Unified Agent Queue Registry (March 2026)

**All agent queues (root + child) are in `globalAgentQueues`**, keyed by task node ID. No more split between `activeSessions.queue` (root) and `globalAgentQueues` (children).

**Key changes:**
- `launchAgent()`: Registers root queue in `globalAgentQueues` with `rootNodeId` as key
- `stopAgent()`: Closes root queue from `globalAgentQueues` before cascading to children
- `deliverMessage()`: Single lookup path — only checks `globalAgentQueues`, no `activeSessions` fallback
- `findParentQueue()`: Exported, simplified — no `activeSessions` check, no `ctx`/`projectId` params. Just walks `globalAgentQueues`
- `report_to_parent`: Dynamic lookup via `getParentQueue()` function, not captured static reference. Fixes stale parent queue when parent wasn't running at child launch
- Cross-project tools: `isProjectActive()` and `getProjectRootQueue()` callbacks replace `activeSessions` map

**`ctx.activeSessions` still exists** but ONLY for root session lifecycle (`.stop()`, session identity, `.has()` for "is running?" checks). No queue access via activeSessions anywhere.

**Deleted:**
- `deps.launchChild` — deliverMessage handles launch
- `deps.activeSessions` from OrchestratorToolsDeps
- `deps.parentQueue` (static ref) — replaced by `deps.getParentQueue` (dynamic lookup)
- Fallback path in MCP `send_message_to_child` (persist + launchChild)

**`broadcastAgentStreamEvent()`**: Unified helper for all queue message consumption tracking. Both provider stream events (onEvent) and MCP tool events (onTaskEvent/agent_event wrapper) go through this single function for event broadcast + messages_consumed.

**Bug fix**: `messages_consumed` was never broadcast for messages consumed via yield/done MCP tools. The onTaskEvent callback (agent_event wrapper path) didn't check for queue_message events. Fixed by routing both paths through `broadcastAgentStreamEvent()`.


## Orphaned Tool Use Fix (March 2026)

- **Bug**: Daemon stop mid-tool leaves JSONL with tool_call but no tool_result. On resume, converter produces orphaned tool_use → Anthropic 400 error.
- **Fix**: Post-processing in both `eventsToAnthropicMessages()` and `eventsToOpenAIMessages()`. After building messages, check if last assistant message has tool_use/tool_calls without matching results. Synthesize error tool_results with "interrupted by daemon restart" message.
- **Helper functions**: `fixOrphanedAnthropicToolUse()` and `fixOrphanedOpenAIToolCalls()` — mutate messages array in place.
- **Approach**: Option 1 (converter fix) chosen over JSONL cleanup or write-ordering changes — handles any JSONL state gracefully without side effects.


## yield/done messagesConsumed Fix (March 2026)

- **Bug**: yield/done tool_result events had no `messagesConsumed` field. User messages consumed via these tools were invisible in the UI (stuck in pending state forever).
- **Root cause**: `waitForQueueMessages()` in agent-tools.ts drained the queue and returned formatted text, but the consumed message IDs were lost. The provider recorded tool_result to JSONL without `messagesConsumed`.
- **Fix**: Three-layer propagation:
  1. `waitForQueueMessages()` extracts user message IDs from drained messages, returns `_consumedMessageIds` alongside content
  2. Both providers (Anthropic + OpenAI) extract `_consumedMessageIds` from MCP tool result, merge with cancellation-point IDs, and write `messagesConsumed` to JSONL tool_result event
  3. `broadcastAgentStreamEvent()` checks tool_result events for `_consumedMessageIds` and broadcasts `messages_consumed` to WS clients
- **Key insight**: The `_consumedMessageIds` prefix convention avoids polluting the MCP tool result schema while allowing custom metadata to flow from tool handler → provider → JSONL → broadcast.


## JSONL Architecture Vision (March 2026)

**Core problem**: Queue messages are formatted as text and embedded in tool_result content. This loses structure, makes the JSONL format unmaintainable, and breaks frontend rendering (messages_consumed can't reference IDs of things embedded as text).

**Target JSONL structure**:
```
{"type":"user_message","id":"X","queueEntry":{"source":"child_complete","taskId":"...","success":true,...}}
{"type":"tool_result","toolCallId":"Y","content":"<pure tool output>","messagesConsumed":["X"],"pending":{"children":[...],"clarifications":[...]}}
```

**Principles**:
1. `user_message` with `queueEntry` = structured record of ANY queue message (user text, child_complete, clarify_response, parent_update, etc.)
2. `tool_result.content` = ONLY the tool's actual output (no queue messages embedded)  
3. `tool_result.messagesConsumed` = references consumed user_message IDs
4. `tool_result.pending` = structured state (not `## Pending` text)
5. Converter formats queue messages as XML/text for AI at conversion time

**Three types of tools**:
1. **Built-in tools** (bash, read_file, etc.): Pure I/O, no state changes, no context needed
2. **Runtime API tools** (create_task, send_message_to_child, report_to_parent, etc.): Conceptually HTTP API calls to OpenGraft runtime. Request/response, no queue state changes.
3. **Queue-state tools** (yield, done): Fundamentally different — they block/close the queue. Need dedicated provider callbacks.

**Current mess**: Types 1-3 are all in one `createOrchestratorTools()` with a big deps bag. Queue message text is pre-formatted and embedded in tool_result. Two separate event callbacks (onEvent from provider, onTaskEvent from agent-tools emit) handle the same thing differently.

**Fix path**: Task 297eacb7 (structured JSONL) + 064df856 (yield/done separation) + 51d1e79e (provider refactor).

## Anthropic API: Mixed Content Blocks in User Messages (Confirmed March 2026)

**Confirmed by official docs**: User messages can contain BOTH `tool_result` and `text` blocks in the same user turn. Queue messages are now text blocks alongside tool_results, NOT embedded in tool_result content.

## Structured JSONL Refactor (March 2026)

**Core change**: Queue messages are structured `user_message` events with `queueEntry` field. Converters format at conversion time. `messages_consumed` is always standalone.

**Key changes**:
- `QueueEntry` interface — structured data for all queue message types
- `tool_result.content` = PURE tool output (no embedded queue text)
- `messages_consumed` = standalone event (not field on tool_result)
- `tool_result.pending` = structured running children + clarifications
- `waitForQueueMessages()` writes user_message events to JSONL directly
- Cancellation queue messages → separate text blocks alongside tool_results
- Backward compat: old JSONL with flat fields or embedded text still works


## Frontend queueEntry Handling (March 2026)

- **Root cause of blank cards**: `processEventBatch` stored `user_message` events with only `{ content, images, taskId, ts }`, losing the `queueEntry` field. On materialization at `messages_consumed` time, it always created `user_message` LogEntry. For non-user sources (child_report, parent_update, etc.), `content` was empty → blank card.
- **Fix**: `queueEntryToUIEvent()` helper converts `QueueEntry` (or raw message) to the appropriate UIEvent type based on `source` field. Used by both `processEvent` (live WS) and `processEventBatch` (refresh).
- **`pendingChipText()`**: Formats descriptive text for the pending banner. User messages show content; non-user sources show labeled text (e.g., "↑ Worker: Phase 1 done", "← Parent: ...", "💬 answer").
- **Two stores for deferred messages**: `pendingMessages` state (visible in UI banner) holds ALL deferred messages. `deferredQueueMsgs` Map (internal) holds `queueEntry` data for non-user sources so `messages_consumed` can materialize the correct card type.
- **Legacy backward compat**: Old JSONL with flat fields (source + taskId/title/content at top level, no queueEntry) → constructs a `QueueEntryLike` from flat fields for correct materialization.
- **`createQueueUIEvent` simplified**: Delegates to `queueEntryToUIEvent` instead of duplicating switch logic.



## yield/done Queue Messages as Separate Text Blocks (March 2026)

- **Bug**: `waitForQueueMessages()` embedded formatted queue messages in the tool_result content. AI saw them as part of the tool output.
- **Fix**: Split into two return fields: `content` (just pending section) and `_formattedQueueMessages` (formatted queue text). Both providers add queue messages as separate text/user blocks alongside tool_results.
- **Anthropic**: Queue text + images added as sibling `text`/`image` blocks in the user message content array (same turn as tool_result).
- **OpenAI**: Queue text + images added as a separate `user` message after tool result messages.
- **Image routing**: When `_formattedQueueMessages` is set, `mcpImages` are user queue images — they go alongside queue text, NOT in tool_result. For non-yield MCP tools, `mcpImages` still go in tool_result as before.
- **Wrapper text**: yield uses `[Messages received while you were idle:]`, cancellation point uses `[Messages received while you were working:]`.


## User Message Live Visibility Race Condition Fix (March 2026)

- **Root cause**: Two systems managed the same lifecycle conflicting. Queue-driven `pending_messages:[]` (from `onDrain` callback) cleared React `pendingMessages` state BEFORE `messages_consumed` WS event arrived. When `messages_consumed` handler tried to read from `pendingMessages`, it was empty → no log entry created.
- **Race sequence**: (1) `user_message` broadcast → frontend adds to pendingMessages, (2) Queue `onDrain` fires immediately on agent wake → broadcasts `pending_messages:[]` → clears pendingMessages, (3) `messages_consumed` broadcast → reads pendingMessages → EMPTY → nothing added to logs.
- **Fix**: Added `deferredUserMsgs` Map in ws-handler.ts — stores user message data (content, images, taskId, ts) keyed by message ID. This map is NOT affected by `pending_messages:[]` clearing. `messages_consumed` handler reads from this durable map instead of React state.
- **Key insight**: `pendingMessages` React state serves two masters (pending banner display AND consumption data). Separating the data store from the display state fixes the race.

