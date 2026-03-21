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
| web/ws-handler.ts | Event processing (processEvent, UpdateOp) |
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
- Main port (7433) requires auth.
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



## Agent Self-Awareness: UI and Session Format (March 2026)

- **Use take_screenshot, NOT take_snapshot** for Chrome MCP — snapshots of pages with long activity logs blow up context instantly (hundreds of thousands of tokens). Screenshots are always safe.
- **Meta-awareness**: When the user describes a UI behavior (blank card, message appearing in wrong view, pending banner not clearing), map it to the corresponding JSONL event, WS broadcast event, and frontend processEvent code path. The user sees cards — I need to think in terms of what events produce those cards.
- **Timestamps matter**: Messages formatted for AI now include `[HH:MM:SS]` timestamps so the AI can correlate with the user's UI timestamps when discussing specific events.
- **Session format ≠ UI format**: What the AI sees (formatted text in tool_result) is different from what the user sees (individual cards with timestamps in the activity log). The AI must understand both formats and be able to reason about the mapping.
- **Restart daemon**: Via Settings button in UI (Chrome MCP) or POST /restart-daemon with auth cookie. System daemon (LaunchAgent), not bun --watch. Commits do NOT auto-restart.


## Message Type Unification (March 2026)

- **`user_message` → `message`**: All injected content is `{type: "message", id, ts, body: {source, ...}}`.
- **`queueEntry` → `body`**: Field on MessageEvent. `QueueEntry` → `MessageBody`.
- **Migration runner**: `ACTIVE_MIGRATIONS: EventMigration[]` in `src/event-store.ts`. Called at daemon startup. Idempotent. Add new transforms, remove old ones when confident → `[]`.



## SSE Migration (March 2026)

- **WebSocket → SSE**: Server→client push now uses SSE (`GET /events?projectId=X`) instead of WebSocket.
- **SSEClient type**: `{ controller: ReadableStreamDefaultController, projectId: string }`. No more `WSContext`.
- **broadcast()**: Encodes `data: JSON\n\n` and enqueues to controller. Dead clients caught via try/catch and removed from Set.
- **No onMessage handlers**: WS had subscribe/orchestrate/inject/clarify message types. All eliminated — projectId comes from query param, other actions use REST endpoints.
- **Initial state on connect**: Tree, pending messages, and pending clarifications sent immediately in `sendInitialState()`.
- **Cleanup on disconnect**: `c.req.raw.signal.addEventListener("abort", ...)` removes client from Set.
- **No special Bun dependencies**: SSE uses standard `ReadableStream` + `Response` — no `hono/bun` websocket import needed.


## Per-Task Session Clearing (March 2026)

- **Endpoint**: `POST /projects/:id/tasks/:nodeId/sessions/clear` in `src/daemon/routes/tasks.ts`
- Stops agent for that task (closes its queue in `globalAgentQueues`), clears JSONL events via `eventStore.clear(nodeId)`, clears persisted messages
- For root node: also stops project active session via `ctx.activeSessions`
- Frontend: "Clear Session" button in TaskDetail, shown when task is not running and not pending/draft
- Existing `POST /projects/:id/sessions/clear` (clear-all) remains unchanged

## iOS Auto-Scroll Fix (March 2026)

- **Bug**: `scrollIntoView({ block: "end" })` on iOS Safari propagates to ancestor containers even with `overflow: hidden`, scrolling the entire page and pushing the input bar out of view.
- **Fix**: Replaced with `el.scrollTop = el.scrollHeight` on the `og-activity-log` container directly. `scrollTop` only affects the target element, immune to iOS Safari scroll propagation.
- **Removed**: `bottomRef` sentinel div — no longer needed since we use `scrollTop` instead of `scrollIntoView`.


## Collapsible Detail Panel (March 2026)

- **Panel-level collapse** replaces inner OrchestratorDetail stats toggle. Whole panel (OrchestratorDetail or TaskDetail) hides, activity log fills full height.
- **CSS specificity order**: Biome enforces no descending specificity. `.og-detail-collapsed .og-activity-panel` (0,2,0) must come AFTER `.og-activity-panel` (0,1,0) in the file.
- **localStorage key**: `og-detail-collapsed`. Old inner toggle key `og-orch-stats-expanded` no longer used.
- **IconChevron**: `expanded={!detailCollapsed}` — points right when collapsed, rotated 90° (down) when expanded.


## Closed Task Resumption (March 2026)

- **Closed tasks CAN be resumed**: `send_message_to_child` works on closed tasks — auto-creates worktree and launches agent. System prompt was wrong about this.
- Use case: reusable worker pattern. Close a task after merging, then update its description and send a new message to reuse the agent context.

## JWT Auth Migration (March 2026)

- **Session-based → JWT**: Replaced server-side session tokens (stored in auth.json `sessions` array) with stateless JWT tokens signed with HMAC-SHA256.
- **Signing key**: Auto-generated on first use, persisted as `jwtSecret` (base64) in `auth.json`. Survives daemon restarts.
- **No external deps**: Uses native Web Crypto API (`crypto.subtle`) for HMAC-SHA256 sign/verify. No `jsonwebtoken` or `jose` library.
- **Token delivery**: Login verify endpoint returns `{ verified: true, token: "..." }` in response body (not cookie). Frontend stores in `localStorage` via `web/auth.ts` helpers.
- **Frontend auth**: `authFetch()` wrapper adds `Authorization: Bearer` header to all API calls. `LoginPage` stores token on successful auth. `clearToken()` on logout.
- **SSE auth**: `EventSource` cannot set custom headers. Token passed as query param: `/events?projectId=X&token=Y`. Middleware `extractToken()` checks both `Authorization` header and `token` query param.
- **Logout**: Now stateless — server endpoint is a no-op. Client-side `clearToken()` removes JWT from localStorage.
- **Backward compat**: Old `sessions` array in auth.json is ignored (not written back). `auth.json` migrates cleanly — existing credentials preserved, sessions dropped.
- **JWT payload**: `{ sub: credentialID, iat: seconds, exp: seconds }`. 30-day TTL. Expiry checked on every verify.

## Orchestrator Pitfall: Closed Task Resume (March 2026)

- **Never assume a child_complete from a previously-closed task is stale.** User can resume closed tasks via UI. When a closed task reports passed, ALWAYS check the branch for new commits and merge them.
- **child_report = something happened.** Even if a task was "already done", a child_report means the agent is running. Do NOT close_task while it has running agents.
- **Always `git log main..<branch>` before close_task** — verify there are truly no unmerged commits.


## child_report Activity Log Routing Bug (March 2026)

- **Bug**: After page refresh, `child_report` notifications appeared in the child's activity log instead of the parent's.
- **Root cause**: `queueEntryToUIEvent()` in `web/ws-handler.ts` used `qe.taskId` (the inner child task ID from the message body) for the `child_report` case, instead of `parentTaskId` (the consuming agent's task ID). Other message types like `parent_update`, `cross_project`, `background_complete` correctly used `parentTaskId`.
- **Live SSE worked**: In the live path, `toRawMessage()` for `child_report` doesn't include a `taskId` field in rawMessages, so `qe.taskId` was undefined and fell back to `""` (falsy), which the root filter treated as "show in root view". Accidentally correct.
- **REST/refresh broke**: On page load, events are fetched from REST. `normalizeEventForUI()` sets top-level `taskId = sessionId` (parent's). But the `body` field retains `taskId = childId`. `processEventBatch` stores the event with parent's `taskId` but passes `body` (with child's `taskId`) to `queueEntryToUIEvent`, which used the inner `qe.taskId` instead of the outer `parentTaskId`.
- **Fix**: Changed `child_report` case in `queueEntryToUIEvent` to use `parentTaskId` (consistent with all other message types).


## Per-Task Pending Messages (March 2026)

- **Root cause**: `broadcastPendingFromQueue/broadcastPendingCleared` had no `taskId` — all pending messages appeared as root-only. Child task pending messages were invisible.
- **Convention**: Root orchestrator uses `taskId: null`, child agents use their `nodeId`. This matches frontend `targetNodeId` which is `null` when viewing root.
- **Frontend merge logic**: `pending_messages` events replace entries matching the incoming `taskId`, keeping other tasks' pending intact.
- **stopAgent clears per-task**: Iterates all tracker nodes and broadcasts clear for each, since `queue.close()` does NOT trigger `onDrain` callbacks.
- **SSE initial state + REST endpoint**: Now scan ALL agent queues via `tracker.allNodes()`, not just root.


## Chrome MCP: take_snapshot vs take_screenshot (March 2026)

- **take_snapshot is OK for child task views** — child tasks have short activity logs, snapshot size is manageable.
- **take_snapshot is DANGEROUS for root/orchestrator view** — root has thousands of activity log entries, snapshot blows up context (hundreds of thousands of tokens).
- **Rule**: Use take_screenshot for root/orchestrator. Use take_snapshot for child tasks when you need to interact with specific UI elements (click, type, etc.).
- **take_screenshot is always safe** — fixed size regardless of page content.

## Child Task User Message Live Display Fix (March 2026)

- **Bug**: User messages sent to child tasks via REST endpoint (`POST /projects/:id/tasks/:nodeId/message`) were not visible live in the child's activity log. Only appeared after page refresh.
- **Root cause**: The child task message endpoint was missing the two-phase message lifecycle that `handleInjectMessage` implements for root messages. Specifically: (1) No `message` event written to JSONL at send time, (2) No `message` SSE broadcast for frontend pending/deferred state, (3) No `id` field in the `QueueMessage` so `messages_consumed` could not reference it.
- **Why refresh worked**: Without an `id`, the provider's `queueMessageToEvent()` generated a new UUID and wrote the `message` event to JSONL during queue drain. `processEventBatch` on refresh found this event and rendered it. But the live SSE path requires the two-phase lifecycle (broadcast `message` with ID → frontend defers → broadcast `messages_consumed` → frontend materializes).
- **Fix**: Added three things to the child task message endpoint: (1) Generate `msgId` via `randomUUID()`, (2) Write `message` event to JSONL and broadcast via SSE, (3) Include `id` in `QueueMessage` passed to `deliverMessage`. Now matches `handleInjectMessage` behavior.


## report_to_parent Title Field (March 2026)

- **Added `title` parameter** to `report_to_parent` MCP tool (required). Short summary shown as card header.
- **`message` parameter** remains as the detailed body content (expanded on click).
- **Backend flow**: `args.title` → `summary` field on `child_report` QueueMessage/Event. Kept separate from existing `title` (task name).
- **XML format**: `<child_report from="taskName" id="taskId" summary="reportTitle">message</child_report>`.
- **Frontend (child view)**: `getToolCardTitle` shows `← {title}`. `isTitleOnlyCard` returns false when message exists (always expandable). `McpToolCardBody` shows full message.
- **Frontend (parent view)**: `child_report` card label shows `↑ {summary}` when available, falls back to `↑ from {taskTitle}`.
- **No backward compat**: Clean break — old JSONL without summary field just shows fallback labels.



## SSE Catch-Up Mechanism (March 2026)

- **Ring buffer + Last-Event-ID**: Per-project monotonic counter + 2000-entry ring buffer in `event-system.ts`. Every `broadcast()` assigns `id: seqId` to SSE events.
- **Reconnect catch-up**: `sse.ts` reads `Last-Event-ID` header on connect. If present, replays missed events from ring buffer. Falls back to full `sendInitialState` if gap too large.
- **Frontend reconnect**: `useSSE` tracks first-connect vs reconnect. On reconnect, calls `onReconnect` which re-fetches events from REST and pending messages — safety net for gaps the ring buffer cannot cover.
- **Initial state events have no `id:`**: `sendInitialState` sends without sequence ID so they do not interfere with Last-Event-ID tracking.



## Provider-Internal Prompt Filtering (March 2026)

- **Bug**: After page refresh, activity log showed a giant card with full system prompt (Working directory + memory.md + user message) alongside the correct user message card from `orchestration_started`.
- **Root cause**: Provider writes full `firstUserContent` as `{type: "message", content: ..., cwd: ...}` to JSONL. Frontend rendered ALL `message` events as user cards.
- **Fix**: In `web/ws-handler.ts`, skip `message`/`user_message` events that have a `cwd` field and no `id` field — these are provider-internal prompt events. Also skip `compacted_resume` events (internal compaction state). Applied in both `processEvent` (live) and `processEventBatch` (refresh).
- **Key distinguishing field**: `cwd` — only provider-written prompt events have it. User-injected messages never have `cwd`.


## Fresh Session Pending Banner Fix (March 2026)

- **Bug**: First message on fresh/cleared session stays in pending banner forever. Agent responds, message shows in activity log, but pending chip never clears.
- **Root cause**: `handleInjectMessage` `!rootNodeId` branch writes `message` event (Phase 1) but never emits `messages_consumed` (Phase 2). The message becomes the initial prompt, not a queue message, so no queue drain triggers `messages_consumed`.
- **Fix**: Broadcast `messages_consumed` immediately after the `message` broadcast in the `!rootNodeId` path — the message was consumed instantly as the prompt.


## Clarify Banner Dismissal Fix (March 2026)

- **Root cause**: `handleClarifySubmit` in `web/handlers.ts` only cleared the answer input text (`setClarifyAnswers`) after successful POST, but did NOT remove the answered clarification from `pendingClarifications` state. Banner relied entirely on backend SSE broadcast of `pending_clarifications:[]` to dismiss.
- **Why intermittent**: If SSE event was delayed or EventSource was recreated (React effect re-run due to dependency changes), the `pending_clarifications:[]` broadcast could be missed.
- **Fix 1 (optimistic removal)**: After successful POST to `/clarify`, immediately `setPendingClarifications(prev => prev.filter(c => c.id !== clarificationId))`. Added `setPendingClarifications` to `ActionHandlerDeps`.
- **Fix 2 (reconnect safety net)**: `handleReconnect` in App.tsx now re-fetches pending clarifications (`GET /projects/:id/clarifications`) alongside events and pending messages.


## SSE Heartbeat (March 2026)

- **Two-tier heartbeat** prevents SSE connections from silently dying (especially through CF Tunnel which kills idle connections ~100s):
  1. SSE comment (`": heartbeat\n\n"`) every 15s — standard SSE keepalive, keeps TCP alive through proxies. Invisible to `EventSource.onmessage`.
  2. Data heartbeat (`data: {"type":"heartbeat"}`) every 120s — triggers `onmessage`, updates `lastMessageRef` for client-side dead connection detection.
- **Client watchdog** in `useSSE` (`web/hooks.ts`): checks every 10s. Force-reconnects (via `reconnectKey` state bump) if no data event in 150s OR if `EventSource.readyState === CLOSED` (CF Tunnel clean close won't auto-reconnect).
- **`reconnectKey`**: State variable in `useSSE`. Bumping it triggers effect cleanup (close old source) + re-run (create new source). `reconnectKey > 0` means watchdog-forced reconnect — `hasConnectedBefore` starts `true` so `onReconnect` fires on first open.
- **`handleWS` ignoring heartbeat**: Heartbeat data events are filtered in `onmessage` before reaching `handleWS` — just `return` after updating `lastMessageRef`.


## Unified Activity Log Display (March 2026)

- **Problem**: `task_completed` and `task_started` standalone SSE events created duplicate log entries in the parent's activity log immediately, while the same info was also delivered via queue messages (`child_complete` source) through the two-phase lifecycle. During long tool calls (e.g., `bash sleep 60`), child events appeared immediately instead of showing in the pending banner first.
- **Fix**: (1) `task_started`/`task_completed` in `processEvent` no longer create entries in the parent's view — only in the child's own view. (2) `child_complete` and `system` sources in `queueEntryToUIEvent` now render proper cards (`task_completed` and `lifecycle` respectively) instead of returning null. (3) `createQueueUIEvent` no longer skips `child_complete`/`system` — they flow through the two-phase lifecycle like all other queue messages.
- **Result**: ALL queue messages follow the same lifecycle: fire → pending banner → consumption → activity log card. No more immediate display bypassing the pending phase.
- **Removed `nodeMapRef`**: No longer needed since `task_started`/`task_completed` don't look up parent IDs. Removed from `WSHandlerDeps`, `createWSHandler`, and `App.tsx`.


## Defensive Converter Guards (March 2026)

- **"(empty)" fallback**: All event converters now use `"(empty)"` string instead of `undefined`/empty for message content. Prevents Anthropic 400 "content: Field required" errors from corrupt/incomplete JSONL.
- **Three guard sites per converter**: (1) `message`/`user_message` without content → try `formatEventForAI()`, fallback to `"(empty)"`, (2) empty assistant `contentBlocks` → push `{type:"text",text:"(empty)"}`, (3) empty `resultBlocks` in tool_result → push `{type:"text",text:"(empty)"}`. Also `?? "(empty)"` on individual tool_result content fields.
- **`console.warn` on fallback**: Every fallback triggers a warning log for production debugging.
- **fixOrphanedAnthropicToolUse/fixOrphanedOpenAIToolCalls now scan ALL messages**: Previously only checked the last assistant message. After double-restart (daemon stops mid-tool, agent resumes and continues, daemon stops again), orphaned tool_use blocks end up in the MIDDLE of the conversation. Fix now iterates all assistant messages in reverse, checking each for matching tool_results in the following message.
- **stopAgent writes synthetic tool_result to JSONL**: Defense-in-depth — `writeOrphanedToolResults()` scans JSONL at stop time and writes synthetic error tool_result events for any trailing unpaired tool_call. Prevents orphans from ever existing in JSONL.
