# OpenGraft Project Memory

> Single source of truth. Read on every session start. Full design: `OpenGraft.md`

## ⚠️ MOST IMPORTANT — Architecture Discipline

Every bug fix MUST ask TWO questions:
1. **What caused this specific bug?** — Fix it.
2. **Why does our architecture make this class of bug easy to create?** — Is the architecture too complex? Too hacky? Is the design philosophy wrong?

If the answer to #2 is "we have two codepaths that do similar things with subtle differences" — **DO NOT patch the symptom.** Remove the duplicate codepath entirely, even if it temporarily breaks something. A broken-but-simple architecture is better than a working-but-fragile one with hidden duplication.

**Pattern to watch for**: Every time we introduce an "ephemeral" shortcut alongside a "persisted" canonical path, we create a live/refresh inconsistency bug factory. ONE path. Always.

## ⚠️ CRITICAL — Task Execution Discipline

**Creating tasks is CHEAP. Executing tasks must be DELIBERATE.**

When the user discusses a feature or gives architectural feedback, they are designing with you — NOT telling you to ship immediately. The correct workflow:
1. **Draft the task** — capture the idea
2. **Discuss architecture** — iterate on the design WITH the user until they say "go"
3. **Only then execute** — with the agreed-upon architecture

Signs the user wants to discuss, NOT execute:
- They suggest an approach ("what if tool_result carried runningBackgrounds")
- They give architectural feedback ("background task info should be transmitted somehow")
- They add small clarifications or corrections after your response
- They haven't explicitly said "start" / "go" / "implement it"

**NEVER rush to launch a child task when the user is still refining the design.** A wasted child execution costs real money and loses context. A draft task costs nothing. When in doubt: update the draft description, ask for confirmation, wait.

## Operating Mode

**Autonomy**: Level 10 for execution. Level 0 for premature execution.
**Workflow**: Create tasks first, refine later. Tasks persist after compaction, mental notes don't.
**Architecture discussions**: Stay in discussion mode. Update draft descriptions. Don't launch until design is agreed.

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
| src/daemon.ts | Hono app, routes |
| src/daemon/ | context, event-system, helpers, agent-lifecycle, routes/ |
| src/system-prompts.ts | ORCHESTRATOR_SYSTEM_PROMPT, ORCHESTRATION_KNOWLEDGE, child prompt |
| src/orchestrator-tools.ts | MCP tool definitions + handlers (createOrchestratorTools) |
| src/agent-tools.ts | Re-exports from system-prompts + orchestrator-tools, helpers |
| src/provider-shared.ts | Shared provider logic: compaction, tool execution, queue handling, budget |
| src/anthropic-compatible-provider.ts | Anthropic provider: API client, message format, streaming |
| src/tools/ | definitions.ts, search.ts, bash.ts, executor.ts |
| src/config.ts | Config system, auth groups, DEFAULT_MODEL |
| src/task-tracker.ts | Task tree CRUD, JSON persistence |
| src/worktree-manager.ts | Git worktree lifecycle |
| src/message-queue.ts | MessageQueue + globalAgentQueues |
| src/persistent-queue.ts | Disk-backed message persistence |
| src/events.ts | Event types + helpers (formatEventForAI, queueMessageToEvent, findOrphanedToolCalls) |
| src/event-store.ts | JSONL EventStore — sole persistence for events (session resume + activity log) |
| src/daemon/routes/auth.ts | WebAuthn/Passkey auth middleware + endpoints |
| src/daemon/routes/sse.ts | SSE endpoint + initial state push |
| web/App.tsx | Web UI main, SSE/handlers |
| web/event-handler.ts | Event processing (processEvent — unified for both live and batch) |
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
- `text_delta`, `usage`, `agent_idle`, `agent_active`, `status`, `heartbeat`, `tree_updated`, `clarification_timeout`
- Provider events (`assistant_text`, `tool_call`, `tool_result`, `compact_marker`) — persisted by providers via emit callback, not by emitEvent

**Two-phase message lifecycle**:
1. Phase 1: `message` event with `id` written to JSONL at send time → frontend defers into `deferredMessages` map → shows in pending banner
2. Phase 2: `messages_consumed` event references IDs → frontend materializes messages into activity log entries
3. Pending banner = messages in `deferredMessages` that haven't been consumed yet

**Frontend unified processor**: ONE `processEvent` function used by both live SSE events AND batch processing (page load/reconnect). `processEventBatch` just loops `processEvent` over all events. No dual-path code.

**Provider-internal events**: `message` events with `id: ""` (empty string) = provider prompts (initial/resume). Filtered out by frontend. `compacted_resume` also filtered.

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
- `done()` = update status + deliver child_complete to parent queue + closeQueue (child) or block on waitForQueueMessages (root).
- `yield()` and `done()` share `waitForQueueMessages()` helper. Both = "block and wait."
- Loop exits ONLY when queue is closed (stop signal). Stop = pause (root stays in_progress → auto-resume). Only `done()` changes to passed/failed.
- **done() closes queue directly**: `closeQueue` callback (OrchestratorToolsDeps) for child agents (depth > 0). Child_complete delivered directly by done(), not reconstructed by agent-lifecycle.

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
- **Data heartbeat every 15s**: Resets Bun's `idleTimeout` (255s) and lets client watchdog detect dead connections. No comment heartbeat (Bun ignores SSE comments for idle timeout, EventSource ignores them too).
- **Client watchdog**: 30s check interval, 45s timeout (3x heartbeat). Does NOT check readyState to avoid conflicting with EventSource auto-reconnect.
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

## Provider Architecture

- **ONE Event type** (`Event` from events.ts) throughout the entire system. No `AgentEvent`, no conversion layers.
- **`runProviderLoop()`** in `provider-shared.ts` — ONE run loop. Yields `Event` directly.
- **`ProviderAdapter`** interface — hooks for API-specific operations.
- **`walkEventsToMessages()`** + `EventConverterCallbacks` — shared JSONL→messages converter walker.
- **Provider has zero EventStore access**. All events flow through `emit` callback (`AgentRequest.emit`).
- `emit` wired to `emitEvent()` by daemon layer — handles SSE broadcast + JSONL persistence.
- `activeEvents` on AgentRequest provides pre-loaded events for resume (daemon reads from EventStore).
- Orphan tool_call fixes happen in daemon layer before passing events to provider.
- Converters live in their respective provider files, not events.ts.
- `events.ts` is types + helpers only (~400 lines).
- Adding a new provider = implement `ProviderAdapter` + `EventConverterCallbacks`.

## Miscellaneous

- **CF Tunnel**: macOS LaunchAgent, domain `t.opengraft.com`. rpID must match page domain.
- **clarify** tool: ALWAYS goes to user (UI), never parent. Use `report_to_parent` with `requestReply: true` for parent guidance.
- **Tool images vs queue images**: `tool_result.images` = MCP screenshots. Queue message images = user-attached, go as sibling blocks.
- **Chrome MCP**: Use `take_screenshot` for root (safe). `take_snapshot` only for child tasks with short logs.
- **Done counter**: UI counts both `passed` and `closed` tasks as "done".
- **Resume error dedup**: Only show errors after last `orchestration_started` or resume event.

## React Memo + Performance

- All major UI components wrapped with `React.memo`: InputBar, AppFooter, AppHeader, ActivityLog, ToolCard, LogEntryView, OrchestratorDetail, TaskDetail, TaskTree, TokenUsageBadge, SettingsPanel.
- Pattern: `export const Foo = memo(function Foo(props) { ... });` — import `memo` from react.
- `createActionHandlers()` in App.tsx wrapped in `useMemo` to stabilize handler references.
- Inline arrow callbacks in App.tsx render extracted to `useCallback` (onProjectChange, onSelect, onClearTarget, etc.) to prevent busting React.memo on child components.
- State setters (from useState) are stable references — no need to include them in useMemo/useCallback deps.

## ULID Migration

- `src/ulid.ts`: Monotonic ULID generator. 26-char Crockford base32, lexicographically sortable.
- All `randomUUID()` calls replaced with `ulid()`. Old UUID strings in JSONL/task files still work (just strings).
- Background process IDs changed from `bg-{hex8}` to `bg-{ULID8}` — test regex updated from `[a-f0-9]` to `[A-Z0-9]`.
- `noUncheckedIndexedAccess`: Uint8Array indexing needs `as number` casts. `(arr[i] as number)++` works for increment.


## Unified Message Schema

- **MessageEvent**: `{ type: "message", id: string, taskId?, body: MessageBody, ts }`. `id` and `body` required. All data in `body`, no top-level fields.
- **MessageBody** = `QueueMessage` discriminated union. `body.source` determines type (user, child_complete, parent_update, etc.).
- **`header?: string`** on `user` and `parent_update` variants. Header = context prepended in AI message (working dir, pre-loaded memory, task description). Frontend does NOT display header.
- **`queueMessageToEvent()`**: wraps QueueMessage as `{ type: "message", id: ulid(), body: msg, ts }`.
- **`formatEventForAI()`**: only handles `message` type, reads from `body` via `formatBodyForAI()`.
- **`isQueueEvent()`**: just checks `event.body.source !== "user"`.
- **No legacy types in Event union**: All queue messages are `message` events with `body.source` discriminating. No standalone `child_complete`, `user_message`, etc.
- **Prompt removed from AgentRequest**: Provider drains queue for first message. Header provides context.
- **Resume and fresh start converge**: Both paths drain queue. Header is ALWAYS how context enters the conversation.
- `launchAgent` no longer takes prompt — callers enqueue messages to queue before/after launch.
- `execute()` in both providers creates a self-closing queue (onDrain closes it) so provider exits on end_turn instead of entering implicit yield.
- Mock providers in tests must loop `while(true) { await queue.wait(); }` to stay alive.
- **`walkEventsToMessages()`**: Messages with non-empty `id` are deferred (skipped until `messages_consumed`). Messages with `id: ""` are rendered directly as prompt events.
- **Frontend `UIOnlyEvent`**: includes `parent_update`, `child_report`, `cross_project`, `background_complete`, `clarify_response` types for UI rendering (not in backend Event union).

## AssistantContent & Converter
- `AssistantContent` has only `items` array (ordered text + tool_call items). No separate `texts`/`toolCalls`.
- `walkEventsToMessages()`: single unified while loop collects both `assistant_text` + `tool_call` until hitting a non-assistant event.
- Natural boundary: assistant_text + tool_call = one assistant turn. tool_result/message = boundary.

## Critical Rule
- **NEVER delete session JSONL files** for other projects. If a session is corrupted, wait for daemon restart with fixed code — the converter fix will handle it on resume. Session files are not in git and cannot be recovered.

## Cross-Project Auto-Launch
- `send_message_to_project` now auto-launches target agent if not running, via `injectMessageToProject` dep.
- `injectMessageToProject` wraps `handleInjectMessage` from agent-lifecycle.ts. Only wired at depth 0 with `orchestratorSystemPrompt`.
- When target has running agent: direct queue enqueue (fast path, cross_project message).
- When target has no agent: falls back to `injectMessageToProject` which uses `handleInjectMessage` to persist + launch. Message is prefixed with sender identity since it goes through as a user message.

## task_completed Event Removal
- **Removed `task_completed` from Event union** — was architectural duplication of `child_complete` queue message (parent view) and `done()` tool call (child view).
- **New done() flow**: done() handler calls `closeQueue()` directly (via OrchestratorToolsDeps) instead of emitting task_completed. closeQueue closes the queue, waitForQueueMessages() rejects immediately, done() returns idle message.
- **`closeQueue` only set for child agents** (depth > 0). Root agents block on waitForQueueMessages() normally.
- **`task_completed` remains as UIOnlyEvent** — child_complete queue message materialization creates it for the parent activity log card. The SSE event and backend Event type are gone.
- **done() tool cards unsuppressed** in LogEntryView.tsx and ToolCard.tsx — styled with green/red border like old task_completed card.
- **Error path in runChildAgentInBackground**: emits `error` event instead of `task_completed`. child_complete queue message still handles parent notification.

## queue_message Removal (DONE)
- `queue_message` ephemeral SSE event fully removed from backend + frontend (-180 lines).
- TWO-PHASE lifecycle is the ONE canonical UI rendering path: `message` event (persisted) → `deferredMessages` → `messages_consumed` → `materialize()`.
- `toRawMessage` dead code also removed from agent-tools.ts.


## done() → child_complete Direct Delivery
- done() handler directly enqueues child_complete to parent queue (stateless, like report_to_parent). No reconstruction from tracker state.
- runChildAgentInBackground only delivers child_complete as fallback when done() was NOT called (daemon restart, error).
- done() card and child_complete card both show "Task Passed/Failed: {title}" format with green/red border.


## Bash Background Improvements
- `formatBashResult()` in bash.ts is THE shared formatting function for ALL output paths (foreground, background completion, await, status).
- `run_in_background: true` is sugar for `foreground_timeout=0`. Handled in executor.ts.
- `bg_action="await"` blocks on `completionPromise` (stored on BackgroundProcess). Returns formatted output like foreground.
- Background completion notifications now include stdout/stderr content when small (< 50KB). formatBashResult cleans up small files, keeps large ones.
- `completionPromise` pattern: create bgEntry first, then assign promise that captures resolve callback onto bgEntry. Avoids non-null assertions.
- `queueMessageToEvent` and `formatBodyForAI` updated to pass through stdout/stderr fields for background_complete messages.
