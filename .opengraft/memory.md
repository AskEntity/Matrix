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

## Resuming Passed Tasks

- POST /tasks/:nodeId/continue accepts passed tasks. execute_tasks allows resume/reset for passed.
- For cleaned tasks, continue re-creates worktree from main via WorktreeManager.create().

## Duplicate Card Fix

- `task_completed` suppressed in child log (parent only). `done()` MCP card enhanced with task title lookup.

## Tree Mutation Events

- `notifyAgentOfTreeChange()` in `src/daemon/routes/tasks.ts` broadcasts a structured `tree_mutation` event (via `broadcastEvent`) with `action` (task_created/updated/reordered/deleted), `nodeId`, and `title`.
- Agent queue message uses `source: "system"` (not "user") — ws-handler skips it (UI is driven by the event, not the queue message).
- `web/ws-handler.ts` handles `tree_mutation` events in both `collectEntries` and `handleWS` to create `tree_mutation` log entries.
- `web/components/ToolCard.tsx` renders `tree_mutation` entries as green system cards with structured action detail.
- No `[TREE UPDATED]` string matching in the rendering pipeline — routing is source/event-type-based.

## Structural Queue Message Cards

- Queue messages render as distinct card types: `og-tool-card-parent` (purple), `og-tool-card-child-report` (blue), `og-tool-card-bg-complete` (gray), `og-tool-card-cross-project` (orange).
- `LogEntry.meta` carries structured data. `createQueueEntry()` in ws-handler.ts centralizes parsing.

## Clear Sessions Fix

- `rootNodeId` must be included in WS subscribe `tree_updated` and REST `/tasks` response. Without it, TaskTree can't identify root after event history is cleared.

## Child Agent Session Persistence

- `runChildAgentInBackground` passes `sessionsDir` to `startSession`. Same dir as orchestrator, differentiated by sessionId.

## Event Persistence

- Anthropic provider yields consolidated `{ type: "text" }` after streaming. `flushEvents()` on agent stop.

## Self-Bootstrap Mode

- `selfBootstrap?: boolean` in config. When true, `launchAgent()` appends "Self-Bootstrap Mode" section to orchestrator system prompt.
- `SettingBoolField` toggle in Settings UI. Boolean scalars work with `??` in `resolveConfig`.

## sessionId = taskId

- `sessionId` removed from TaskNode. Session file = `<nodeId>.json`. `resumeSessionId` always = `node.id` or `rootNodeId`.

## Task Resource Operations

- `close_task`: removes worktree only. Node + session preserved.
- `delete_task`: full removal (worktree + session file + node).
- `reset_task`: removes worktree + session file, keeps node, status → pending.
- `sessionsDir` added to `OrchestratorToolsDeps`. `cleanNode()` and `cleaned` field removed.

## execute_tasks Removal (Phase 2c)

- `execute_tasks` MCP tool removed. `send_message_to_child` is now the universal way to start/wake/continue child tasks.
- `send_message_to_child` auto-creates worktree and launches agent if not running. If agent is running, enqueues message.
- Legacy `execute_tasks` rendering kept in ToolCard.tsx for old event history compatibility.
- The agent spawn logic (executeChildStreaming, fire-and-forget async, child_complete enqueue) moved into send_message_to_child handler.
- Resume detection: if task status is failed/stuck/passed, treat as resume (session history provides context). Otherwise, build full task prompt.

## Phase 3: done() = yield() internally

- `doneRef` mechanism completely removed from the codebase. No more `{ done: null | { status, summary } }` refs.
- `done()` MCP tool now: (1) calls `tracker.updateStatus()` directly, (2) saves tree, (3) broadcasts `task_completed` event, (4) returns "Entering idle state" message. It does NOT cause the loop to exit.
- Provider run loops (both Anthropic and OpenAI) no longer exit on `end_turn`/`stop`. Instead they enter implicit yield mode via `queue.wait()`. Loop exits ONLY when: queue is closed (stop signal) or no queue available.
- `AgentRequest.doneRef` field removed from agent-provider interface.
- `OrchestratorToolsDeps.doneRef` field removed from agent-tools.
- `agent-lifecycle.ts` checks task status from tracker (set by done() tool) instead of doneRef. If agent exits without calling done(), status stays as-is or defaults to "passed".
- Tests updated: done tool tests verify tracker status updates instead of doneRef mutation. OpenAI runLoop test stops session to exit yield mode.

## autoResume Flag Removal (Phase 4a)

- `autoResume` flag fully removed from TaskTracker (property, getter, setter, serialization).
- `autoResumeProjects()` now checks root node status === "in_progress" instead of `tracker.autoResume`.
- `clearAutoResume` option removed from `stopAgent()`.
- Stop semantics: Stop = pause (root stays in_progress → will auto-resume on restart). Only done() changes status to passed/failed.
- Daemon crash: status stays "in_progress" → auto-resume on restart.

## Queue Cleanup in Task Resource Operations

- `close_task`, `delete_task`, and `reset_task` now close the running agent queue (from both `childQueues` and `globalAgentQueues`) before removing worktree/session resources. This prevents orphaned agents from running without a worktree.

## executeChildStreaming done() Detection

- After Phase 3, provider.stream() is infinite (runLoop yields on end_turn instead of exiting). executeChildStreaming must detect when the child calls done() and close the childQueue to exit the stream.
- Detection: check for `tool_result` events where `tool === "done"`, then verify tracker status is passed/failed. Close childQueue and drain remaining events until generator returns.
- Post-completion status logic: done() already sets tracker status. The caller now checks tracker before falling back to result.success, preventing status overwrites.

## Task Completion Card Styling

- `done()` tool_use/tool_result cards suppressed in ToolCard (return null after hooks to avoid hook-at-top-level lint error).
- `task_completed` events now added to both child and parent logs via `createLogEntry` with `meta: { title, success, output }`.
- `task_completed` card styled with `og-tool-card-done-passed/failed` CSS classes: 3px left border, green/red coloring, Passed/Failed badge, collapsible output.

## Closed Task Status

- `"closed"` added as 7th TaskStatus. Lifecycle: pending → in_progress → testing → passed/failed/stuck → closed.
- `close_task` MCP tool now sets status to `"closed"` after removing worktree.
- `send_message_to_child` treats closed like passed/failed/stuck (hasExistingSession = true, resumes).
- `continue` endpoint allows closed tasks — re-creates worktree from main (same as passed without worktree).
- `update_task` MCP tool z.enum includes "closed".
- Frontend: `.og-task-closed` class adds opacity 0.5 + strikethrough title. Status dot/badge use gray color.
- i18n: "Closed" (en) / "已关闭" (zh).
- StatsResponse.taskCounts includes `closed: number`.

## Bash CWD Fallback Chain

- CWD fallback in `executeBashWithTimeout`: checks `existsSync(cwd)` → tries `fallbackCwd` (if exists) → `process.cwd()` as last resort.

## ToolCard MCP Tool Coverage

All 14 MCP tools now have card rendering in `getToolCardTitle`, `isTitleOnlyCard`, `formatMcpToolResult`, and i18n keys (en + zh).

## Persistent Message Queue (Phase 4b)

- `src/persistent-queue.ts`: `persistMessage()`, `loadPersistedMessages()`, `clearPersistedMessages()` — write-through JSON at `<dataDir>/messages/<projectId>/<taskId>.json`.
- Messages persist when no active agent queue. On launch, persisted messages loaded into queue and file cleared.
- `handleInjectMessage` and `handleClarifyResponse` async — persist + auto-resume when no active session.
- `OrchestratorToolsDeps.dataDir` added for persistent queue access.

## Parent Chain Notification on User Message to Task

- POST `/projects/:id/tasks/:nodeId/message` now notifies the parent chain when a user sends a message to any task.
- `notifyParentChain()` walks up via `parentId`, sending `child_report` messages to each ancestor.
- Uses `globalAgentQueues` if ancestor has active queue, otherwise `persistMessage` to disk.

## Unified Message Input

- `handleOrchestrate` enqueues to running session instead of 409. `handleInjectMessage` launches new agent if no rootNodeId.
- Frontend `handleSubmit` tries `sendMessage()` first, falls back to `start()` only if no session exists.

## Running State Detection Fix

- `orchestration_completed` and `agent_stopped` WS events no longer unconditionally `setRunning(false)`. Instead they call `checkAgentStatus()` which does `GET /projects/:id/agent` to get actual running state. This handles auto-resume correctly — if agent was restarted, UI picks up `running=true`.
- `useWebSocket` accepts optional `onConnect` callback — used to call `checkStatus()` on WS connect/reconnect so running state syncs after daemon restart.
- AppFooter always shows "Send" button (never "Run") since `handleSubmit` uses unified path: tries `sendMessage` (POST /message) first, falls back to `start` (POST /orchestrate/agent) only if no session exists.
- `checkAgentStatus` added to `WSHandlerDeps` interface in ws-handler.ts.


## Message Target Banner

- AppFooter `og-message-target` banner shows when `targetNodeId` is set. X button clears targeting.

## Draft as TaskStatus

- `draft` is a TaskStatus value, not a boolean. Draft tasks have `status: "draft"`.
- Migration: `load()` converts old `draft: true` boolean to `status: "draft"`.

## Suppressed Lifecycle Cards

- `orchestration_started/completed` and `agent_stopped` no longer render cards in UI. Side effects (setRunning, stats) preserved.

## User Message Double-Display Fix

- Auto-resume uses generic prompt, not user message. Real message delivered via queue. `orchestration_started` omits `prompt` on resume.


## Bottom Input Target Fix

- `targetNodeId` effect in App.tsx previously gated on `node?.status === "in_progress"` — only in-progress tasks got the "Sending to:" banner.
- Fixed: always set `targetNodeId = selectedTaskId` for non-root tasks. Backend handles routing via persistent queue + auto-resume.

## POST /tasks/:nodeId/message Auto-Launch

- `ensureChildAgentRunning()` shared helper in `agent-lifecycle.ts`. Creates worktree, sets in_progress, calls `runChildAgentInBackground`.

## Legacy Lifecycle UI Removal

- Removed Idle/Running state display, Continue form, running-gated UI. Stop → "Pause" (ghost styling).
- `running` state still tracked for Thinking indicator + Pause button visibility.
- i18n: removed 15+ legacy keys, added orch.pause, tasks.sendMessage.

## Unified Child Agent Launching (runChildCore)

- `runChildCore()` in `src/daemon/agent-lifecycle.ts` is the shared child agent lifecycle for both MCP (`send_message_to_child`) and daemon (REST endpoints) code paths.
- Handles: queue setup (create/register in `globalAgentQueues`), persisted message loading, event streaming via `provider.stream()` with done() detection, and queue cleanup in `finally`.
- `executeChildStreaming` in `agent-tools.ts` is now a thin wrapper: sets up MCP tools (if depth < maxDepth) then delegates to `runChildCore`.
- `runChildAgentInBackground` in `agent-lifecycle.ts` uses `runChildCore` with daemon callbacks (`broadcastEvent`).
- When caller needs MCP tools that close over the queue, create the queue first, pass to both `createOrchestratorTools` and `runChildCore` via `queue` param.
- Tests now check `provider.stream()` instead of `provider.startSession()` for child agents (since `runChildCore` uses `stream()`).
- `consumeAgentEvents()` still exists for `launchAgent` (orchestrator root). Only child agents use `runChildCore`.


## Unified Message Queue Architecture

### Core Principle
Messages are ALWAYS delivered regardless of agent state. The system guarantees: waking messages → agent processes them (active agent enqueues, no agent → persist + launch).

### Single Registry
`globalAgentQueues` is the SOLE source of truth for running agents. `childQueues` was removed. All code paths (REST, MCP, WS) check `globalAgentQueues`. Queue cleanup: `globalAgentQueues.delete()` BEFORE `queue.close()` — callers see "no queue" not "closed queue."

### Message Types
- Waking (via `enqueue`): user, child_complete, parent_update, clarify_response, child_report, cross_project, background_complete, compact
- Non-waking (via `enqueueQuiet`): system/tree_mutation only. `drainMerged()` deduplicates them.
- XML format via `formatQueueMessage()`. `requestReply` as XML attribute.

### Message Persistence
- `persistent-queue.ts`: `persistMessage/loadPersistedMessages/clearPersistedMessages` at `<dataDir>/messages/<projectId>/<taskId>.json`
- Cleared on: delete_task (all descendants), reset_task. Kept on: close_task.
- Double-message prevention: persist message + launch with generic prompt (not user message). Agent loads from disk.

### Agent Idle/Active Events
- `agent_idle`/`agent_active` top-level broadcast events with taskId. Emitted from yield tool + both provider implicit yields.
- `MessageQueue.idle` flag for REST queries. `GET /projects/:id/agent/status` returns `{ idle, active }`.
- Frontend: `activeAgents: Set<string>` replaces `running: boolean`. Spinners/thinking per-agent.

### REST/MCP Parity
- `ensureChildAgentRunning()` checks `globalAgentQueues` first (prevents duplicate agents), emits `task_started`, notifies parent chain.
- REST DELETE closes queues + deletes session files (matches MCP delete_task).
- Intentional divergences: `editedBy` (user vs agent), scope validation (MCP only), tree change notifications (REST only).

### Image Pipeline
- Images flow through: `toRawMessage()` → `rawMessages` → `createQueueEntry()` → `entry.images`. `lastSubmittedImagesRef` removed.

### Lifecycle Tests
- `src/lifecycle.test.ts` — 52 tests covering message delivery, queue state, concurrency, parent notifications, and cleanup ordering.

## UI Updates (this session)

- Title/description always editable (click-to-edit) regardless of task status.
- Yield pending card: calm gray `og-tool-card-yield-waiting` with "⏸ Waiting..." — no spinner/pulse.
- `.og-spinner`: `display: inline-block` (was inline → width/height ignored → stretching).
- Session cost removed. Only total cost (sum of node.costUsd).
- Queue card detail truncation: `og-tool-card-detail` with ellipsis. Card names max-width 50%.
- Pause shows when active, Clear Sessions when idle.


## Compact Events

- `compact_started` emitted exactly ONCE per compaction — at the pre-call compression step only. Queue drains set `manualCompactRequested = true` without yielding.
- Pending compact entries: `checkpoint = undefined`. Completed: `checkpoint` is a string (even empty). Dedup uses `=== undefined`, NOT `!e.checkpoint` (empty string is falsy → breaks dedup).

## Compact Live Display Fix

- Root cause: `compact_started` live handler used `setLogs` with dedup logic that scanned for existing pending entries. The dedup returned `prev` (no change) if a pending entry existed, but this check ran on every invocation and could suppress entries incorrectly.
- Fix: replaced with simple `addLog()` call, matching all other event types. Backend already emits exactly one `compact_started` per compaction so dedup is unnecessary.
- The `compact` completion handler still uses `setLogs` for in-place update (replacing "Compressing context..." with completion text + checkpoint). This is correct.

## ws-handler Unified Event Processing Refactor

- `processEvent(msg)` returns `{ entries: LogEntry[], updates: UpdateOp[], sideEffects: () => void }` — single source of truth for event→entry conversion.
- `UpdateOp` type handles in-place mutations: `merge_text` (text_delta), `replace_text` (consolidated text), `complete_compact` (compact completion replaces pending entry).
- Batch path (event_history): applies entries + updates to accumulator array, defers side effects until after `setLogs`.
- Live path: pushes entries via `setLogs`, applies updates via `applyUpdateLive` (React state updater), runs side effects immediately.
- `addLog` removed from `WSHandlerDeps` — ws-handler uses `setLogs` directly for both paths. `addLog` still exists in App.tsx for handlers.ts usage.
- `createLogEntry` signature changed to single options object (`CreateLogEntryOpts`) — eliminates `undefined` placeholder chains.
- `statusText.includes("Compress")` hack removed — status events produce no log entries (they are internal).
- `setPendingCompact(false)` consolidated: only in `compact_started` handler (clears UI pending state) and `orchestration_completed`/`agent_stopped` (cleanup).
- `NO_SIDE_EFFECTS` sentinel enables efficient identity check to skip empty functions.

## Clear Sessions Auto-Stop

- `POST /projects/:id/sessions/clear` now calls `stopAgent()` when agent is running instead of returning 409. Aligns with unified lifecycle (agents always running, just idle).

## pinyin-pro for CJK Slugification

- `pinyin()` with `type: "array"` splits every non-CJK character individually — unusable for mixed titles.
- Solution: use regex `[\u4e00-\u9fff\u3400-\u4dbf]+` to match CJK runs, convert only those via `pinyin(match, { toneType: "none" })`, wrap with spaces for word boundary separation.
- This preserves ASCII text while converting CJK to pinyin. Mixed titles like "Fix: 修复bug" → "fix-xiu-fu-bug".
- Empty/special-char-only slugs now fallback to "task" instead of empty string (prevents invalid branch names).

## SessionStore Integration (Phase 1)

- `SessionStore` replaces all scattered session management (`sessionsDir`, `sessionHistory` Maps, manual `readFile`/`writeFile`).
- `AgentRequest.sessionStore?: SessionStore` replaces `sessionsDir?: string`.
- Anthropic provider uses no suffix (`.json`), OpenAI uses suffix `"openai"` (`.openai.json`).
- `setSync()` for mid-loop fire-and-forget persists, `set()` (await) for final persist.
- `getSessionStore(ctx, projectId)` in `src/daemon/helpers.ts` — lazy creates and caches in `ctx.sessionStores`.
- `DaemonContext.sessionStores: Map<string, SessionStore>` added.
- `store.clear(nodeId)` fixes the `.openai.json` deletion bug — deletes ALL suffix variants, not just `.json`.
- Resume detection in `handleInjectMessage` uses `store.hasAny(rootNodeId)` — checks both `.json` and `.openai.json`.
- `OrchestratorToolsDeps.sessionStore` replaces `sessionsDir`. Propagated through recursive child agent creation.
- Providers no longer have `private sessionHistory` Maps — all session state is in SessionStore (cache + disk).
- `routes/agent.ts` sessions/clear uses `store.clearAll()`. Sessions/prune still uses `pruneSessionFiles()` (works on raw disk).
- Conversation endpoint (`GET /tasks/:nodeId/conversation`) tries Anthropic format first, then OpenAI format.

## Duplicate task_completed Fix (daemon path)

- `executeChildStreaming` (MCP path in agent-tools.ts) already had `doneWasCalled` guard to skip `task_completed` emission when `done()` was called.
- `runChildAgentInBackground` (daemon path in agent-lifecycle.ts) was missing this guard — unconditionally emitted `task_completed` after stream, causing duplicates when `done()` already emitted it.
- Fix: added same `doneWasCalled` check (`status === "passed" || "failed"`) to `runChildAgentInBackground`.

## notifyParentChain Root Queue Fix

- Root orchestrator queue is in `ctx.activeSessions.get(projectId)?.queue`, NOT in `globalAgentQueues`.
- `notifyParentChain` must check both: `globalAgentQueues` for child agents, `activeSessions` for root (no parentId).
- `createApp` now exposes `activeSessions` for test access.

## Cache Invariant (Core Mental Model)

All in-memory state (queues, session history, provider cache) is a cache of disk state. At any non-tool-call moment, destroying and recreating in-memory state should produce identical observable behavior. Specifically:
- **SessionStore**: memory cache → disk fallback → empty (fresh start). Eviction = optimization.
- **MessageQueue**: if no queue, persist to disk. On next queue creation, load from disk. Queue existence = cache.
- **done() closing queue**: pure optimization. Removing it should be indistinguishable from keeping it.
- **Only non-recoverable case**: interrupting a tool call mid-execution. Tools cannot be replayed; result = "interrupted" error.
- This invariant should hold across daemon restarts, stop/resume cycles, and clear sessions.

## MCP/REST Code Path Parity (Design Principle)

MCP tools and REST endpoints that do the same thing MUST produce identical observable behavior. The only difference should be the message source (user vs parent_update) and notification additions (REST notifies parent chain).

**Current violations** (fixed or in progress):
- `child_complete` not sent in daemon path (runChildAgentInBackground) — fixed
- `doneWasCalled` guard missing in daemon path — fixed
- `notifyParentChain` missing activeSessions lookup for root — fixed

**Root cause of violations**: Two separate completion handlers — `executeChildStreaming` (MCP, in agent-tools.ts) and `runChildAgentInBackground` (daemon, in agent-lifecycle.ts). Both use `runChildCore` for the streaming loop, but post-completion logic is duplicated.

**Future unification**: `runChildCore` should accept an `onComplete(result, tracker, node)` callback that handles all post-completion logic (task_completed broadcast, child_complete notification, status update, tree update). Both MCP and daemon paths pass the same callback. This eliminates the class of bugs where one path adds logic the other forgets.


## Unified Child Agent Lifecycle (Phase 5)

- `executeChildStreaming` removed from `agent-tools.ts`. All child agent launching goes through `runChildAgentInBackground` in `agent-lifecycle.ts`.
- `OrchestratorToolsDeps.launchChild?: (nodeId: string, prompt: string) => Promise<void>` — daemon provides this callback via `createAgentContext`. MCP `send_message_to_child` calls it instead of inline async IIFE.
- `createOrchestratorTools` no longer accepts `costAccumulator` parameter. Cost tracking is done per-node via `tracker.updateCost()` in `runChildAgentInBackground`.
- `runChildAgentInBackground` now handles ALL post-completion logic: cost reporting, budget exceeded check, failCount/stuck handling, `task_completed` broadcast, and `child_complete` notification to parent queue.
- `findParentQueue()` helper resolves parent queue dynamically: checks `globalAgentQueues` for child-of-child, `ctx.activeSessions` for child-of-root. Used for both `child_complete` and `report_to_parent` (via `parentQueue` in `createAgentContext`).
- `computeDepth()` replaces hardcoded `depth: 1` — walks up `parentId` chain to compute actual tree depth. Enables recursive spawning at correct depth levels.
- `orchestration_completed` child costs now summed from tree (`tracker.allNodes()`) instead of `CostAccumulator`. This is the source of truth.
- `parentQueue` wired in `createAgentContext` so daemon-spawned children have working `report_to_parent` MCP tool.
