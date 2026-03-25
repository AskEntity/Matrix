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
| src/daemon.ts | Hono app, routes, autoResumeProjects |
| src/daemon/ | context, event-system, helpers, agent-lifecycle, routes/ |
| src/system-prompts.ts | SYSTEM_PROMPT, ROOT_ORCHESTRATOR_ROLE, buildSystemPrompt() |
| src/orchestrator-tools.ts | MCP tool definitions + handlers |
| src/provider-shared.ts | Run loop, ProviderAdapter, executeTool, yield loop-level pause |
| src/compaction.ts | extractCheckpoint, buildCompactedContext, processCompaction |
| src/event-converter.ts | walkEventsToMessages, EventConverterCallbacks |
| src/anthropic-compatible-provider.ts | Anthropic provider |
| src/openai-compatible-provider.ts | OpenAI provider |
| src/tools/ | definitions.ts, search.ts, bash.ts, background.ts, executor.ts |
| src/config.ts | Config system, auth groups |
| src/task-tracker.ts | Task tree CRUD, JSON persistence |
| src/worktree-manager.ts | Git worktree lifecycle |
| src/message-queue.ts | MessageQueue, migrateQueueMessage() |
| src/persistent-queue.ts | Disk-backed message persistence |
| src/events.ts | Event types + helpers, findOrphanedToolCalls |
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
- **Session JSONL = most valuable asset**: Contains complete agent thought process. Never auto-delete. Migration should backup, not delete.

## Tool Architecture

All tools are `ToolDefinition[]` under `mcp__opengraft__*` namespace. ONE execution path via `mcpHandler.handler()`.

**TaskSession** — runtime-only field on `TaskNode`. Contains: `queue`, `cwd`, `fallbackCwd`, `depth`, `backgroundProcesses`, `foregroundExecutions`.

`createBuiltinTools()` + `createOrchestratorTools()` → merged at launch. System prompt = strategy only — `ToolDefinition.description` is sole source of truth for how to call tools.

## Message Schema

`MessageEvent.body` = `QueueMessage` discriminated union. `body.source` discriminates: `user`, `task_complete`, `task_message`, `user_message_forwarded`, `cross_project`, `background_complete`, `tree_change`, `clarify_response`.

- `header?: string` on `user` and `task_message` — context prepended for AI, stripped before UI delivery.
- Messages with `id: ""` = provider prompts (filtered by frontend).
- `send_message` tool: direction determined by comparing taskId to currentNode.parentId.
- `migrateQueueMessage()` handles backward compat from old source names (child_report, parent_update, child_complete).

## Agent Lifecycle

- `done()` → update status + deliver `task_complete` to parent + close queue (child) or block (root).
- `yield()` = loop-level pause (not JS await). See "Yield as Loop-Level Pause" section.
- `stopAgent()` cascades: closes child queues, sets children to `failed`.
- done() directly enqueues task_complete to parent (stateless). runChildAgentInBackground only handles fallback.

## Yield as Loop-Level Pause

yield() is a loop-level pause, not a JS await. Provider loop in provider-shared.ts intercepts yield tool_use BEFORE executeTool, sets `pendingYieldToolCall`, and continues to top of while(true). There, `handleImplicitYield` waits for queue messages. On resume, `buildYieldPendingSection` callback (from orchestrator-tools.ts) provides live tracker data for ## Pending section.

**On JSONL resume**: detects pending yield from last tool_call event (no matching tool_result) → skips initial queue drain, enters yield-wait directly. `findOrphanedToolCalls` skips yield tool_calls — they're handled by the loop.

**Key benefit**: yield state is serializable/recoverable across daemon restart. No synthetic orphan results needed.

## Daemon Restart Behavior

- **Orphan cleanup always runs**: `writeOrphanedToolResults` moved before `hasActiveChildren` check in `autoResumeProjects`. Cleans up non-yield orphans (bg processes, etc.) regardless of whether agent auto-resumes.
- **Root idle (no active children)**: orphan cleanup runs, then skip auto-resume (saves money).
- **Root with active children**: mark children failed, orphan cleanup, resume root.
- **Yield on restart**: yield tool_call detected from JSONL → enters loop-level pause without API call. Agent only wakes when message arrives.

## Event System

**Ephemeral** (broadcast only): `text_delta`, `usage`, `agent_idle`, `agent_active`, `status`, `heartbeat`, `tree_updated`, `clarification_timeout`.

**Persisted**: Everything else. `isPersistedByEmitEvent()` in events.ts — exhaustive switch, compile-time enforced.

**Provider events** (assistant_text, tool_call, tool_result, compact_marker) persisted via emit callback = emitEvent.

**Event converters**: `walkEventsToMessages()` + `EventConverterCallbacks`. Two-phase: events with `id` deferred until `messages_consumed`. `TOOL_NAME_ALIASES` for backward compat with old JSONL.

**Side effect discipline**: When extending an event to new emitters, audit ALL consumers for assumptions about who emits it.

## Frontend

- `IncomingEvent` type = `UIEvent | SSEOnlyEvent`. Single `as IncomingEvent` cast at SSE boundary.
- `processEvent` / `processEventBatch` — unified for live + batch. Skips `tree_updated` from JSONL.
- `tool_pair` UIOnlyEvent combines tool_call + tool_result. `resolve_tool` / `remove_tool` UpdateOps.
- `applyUpdate(entries, op)` pure function for all log mutations.
- `Card.tsx` — base card component. `ToolCard` extends it.
- All major components wrapped with `React.memo`.
- `SLASH_COMMANDS` in SlashCommandMenu.tsx: `/compact`, `/stop`, `/clear`, `/settings`.
- localStorage keys: `og-` prefix (e.g., `og-jwt`, `og-theme`, `og-locale`).
- CSS file is `web/style.css` (not `styles.css`).

## Known Pitfalls

- **memory.md**: Never `write_file` to append. Use `edit_file` or `echo >>`.
- **Git worktrees**: `extensions.worktreeConfig` required. `core.hooksPath` absolute.
- **Biome**: Typecheck BEFORE lint. Rejects `!important` (use double-class selectors). No duplicate CSS properties. No descending CSS specificity.
- **noUncheckedIndexedAccess**: Array index returns `T | undefined`.
- **Template literals**: `${"$"}` for literal `$` in backtick strings.
- **React**: `override` keyword on ErrorBoundary. Always `type="button"` on buttons.
- **Daemon reload**: System daemon (LaunchAgent), not `bun --watch`. Commits do NOT auto-restart.
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

`fork_task_context` MCP tool + `POST /tasks/:nodeId/fork` REST. Copies post-compact events from source session to target (which must have no existing session). Appends `fork_marker` event — generates visible `<fork_marker>` XML so forked agents know their identity boundary. Fork is almost always cheaper than cold start due to prompt cache hit.

## Ownership Framing

System prompt uses ownership language: agents "own" tasks. "sub task" for downward, "the task above" for upward. No "parent/child" agent language. `send_message` is unified — direction determined by taskId comparison. `clarify` always goes to user (UI).

## XML Attribute Naming Convention

All XML tags use consistent attribute naming:
- `from_task` = task ID (unique identifier)
- `task_name` = human-readable title
- Tags: `task_complete`, `user_message_forwarded`, `task_message`

## Tree Change Notifications

`source: "tree_change"` QueueMessage with `action`, `nodeId`, `title`. `notifyTreeChange()` walks parent chain, quiet-enqueues to each running ancestor. Also notifies the modified node itself for "updated" actions. UI sidebar updates via `tree_updated` ephemeral event.

## Lazy-Load Activity Log

`EventStore.readFromLastCompactMarker()` for initial load. `readBefore()` for pagination. `GET /events?after=compact` for post-compact only. Frontend "Load earlier history" button re-fetches full events.

## Cross-Project Communication

`send_message_to_project` auto-launches target agent if not running via `injectMessageToProject`.

## Orphan Tool Call Defense

Single path: `findOrphanedToolCalls()` (events.ts) → `writeOrphanedToolResults()` at stopAgent and autoResumeProjects → JSONL fixed before resume. Yield tool_calls excluded — handled by loop-level pause. Provider-specific converter fixOrphans was removed (caused duplicate tool_result bugs).

## Anthropic Cache TTL

System prompt + tools: `ttl: "1h"`. Messages: orchestrator `1h`, child agents `5m` (default).

## send_message Header Gating

- `send_message` in orchestrator-tools.ts only includes header on cold start (`node.session == null`). Running agents skip header to save tokens.
- Cold-start header uses `buildTaskPrompt()` from task-utils.ts (includes memory, siblings, budget).

## User Preferences

- Don't delete completed tasks — close only.
- Don't change auth config values without permission.
- User communicates in Chinese, expects Chinese for conversation.
- User prefers discussing architecture before executing.
- Remove project = non-destructive (registry removal only, data preserved).

## Competitive Landscape (2026-03)

Key competitors: Claude Code Agent Teams, OpenClaw, Cursor 2.0, OpenAI Codex App, Devin, Stoneforge, Intent (Augment Code), GitHub Copilot Coding Agent.

**OpenGraft unique features** (no competitor has ALL): recursive task tree (infinite nesting), cross-project communication, real-time MessageQueue, compaction + fork context combo.

**Positioning**: "Scoped connectivity" — between global agent (OpenClaw) and per-project worker (Composio/Stoneforge). Each project is scoped (task tree, memory, git) but projects aren't isolated (cross-project messaging = expert consultation).

**Closest competitor**: Stoneforge (Director → Workers, dispatch daemon, git worktree isolation). But uses external CLI agents, can't do compaction/fork/API control.

**Biggest threat**: Claude Code Agent Teams — if Anthropic makes it recursive + real-time.

## og-docs

VitePress docs at og-docs project. Build with npm (not bun — hangs due to vuejs/vitepress#2943). Deploy: `npm install && npx vitepress build docs && npx wrangler pages deploy docs/.vitepress/dist --project-name=og-docs`. CF Pages custom domain: `docs.opengraft.com`. Pending user deployment.

## Yield Resume & Header Fixes

- **Header only on cold start**: `prepareAgentMessage` (which adds memory.md + working dir header) should only be called when there is NO existing JSONL session. Resume agents already have context from their session. Fixed in `handleInjectMessage` (agent-lifecycle.ts), POST `/orchestrate/agent` and POST `/restart` (routes/agent.ts).
- **Yield tool_result content**: The yield tool_result event emitted to JSONL must have FULL content (no `.slice(0, 500)`). On resume, event converter reads JSONL to rebuild API messages — truncation causes prompt cache misses.
- **Yield resume message structure**: Queue messages arriving during yield go as additional text blocks in the same user message (via `cancellationQueueMsgs`/`cancellationFormatted`), not in a separate user message. Headers stripped via `formatQueueMessagesWithHeaders` to prevent memory.md duplication.
- **Consumer loop yield vs emit**: The `yield` at the bottom of the tool execution loop (for SSE consumer) is NOT persisted to JSONL — `buildToolResultEvents` via `emit()` handles JSONL with full content. The `.slice(0, 500)` was removed from the yield too per principle: backend = full fidelity, frontend = display optimization.
- **`formatBodyForAI` embeds header**: For `user` and `task_message` with header, `formatBodyForAI` returns `header + content`. So `formatQueueMessage` → `formatBodyForAI` includes the header. Use `formatQueueMessagesWithHeaders` to extract headers to message level and pass headerless copies to `formatQueueMessage`.



## ⚠️ JSONL Content Fidelity (CRITICAL)

**JSONL event content = exact content sent to API. Zero transformation.**

- No `.slice()`, no truncation, no preview formatting on any persisted event content
- UI truncation happens ONLY in `stripEventForUI` (SSE layer) and frontend rendering
- Header (memory.md) ONLY on true cold start (`!eventStore.has(sessionId)`) — resume agents already have context from JSONL
- Violation = prompt cache miss on every resume = wasted money

This applies to: `tool_result.content`, `tool_call.input`, `message.body`, `assistant_text.text` — anything in JSONL that gets reconstructed into API messages via `walkEventsToMessages`.


## Tool Result Three-Part Invariant (CRITICAL)

Every code path that produces a tool_result must do ALL three:
1. **JSONL**: `emit(tool_result_event)` — for resume/replay
2. **SSE**: `yield tool_result_event` — for frontend
3. **messages[]**: `adapter.buildToolResultsMessage()` + push — for next API call

Missing any one causes a different bug class: (1) orphan on resume, (2) missing UI feedback, (3) API 400 unpaired tool_use.

**Compact during yield** hit this twice: first fix added step 1+2, second fix added step 3. The end-of-turn implicit yield compactOnly path doesn't need this — no `pendingYieldToolCall` exists there.


## Single Orphan Detection Path

Orphan tool_call detection is ONE path — `findOrphanedToolCalls()` in events.ts:
- Skips `mcp__opengraft__yield` (loop-level pause, not an orphan)
- Called by `writeOrphanedToolResults()` at stopAgent/autoResume → writes synthetic tool_results to JSONL
- Converter reads clean JSONL — no orphan fixing needed (removed `fixOrphans` from `EventConverterCallbacks`)
- **Never add provider-specific orphan detection** — it caused duplicate tool_result bugs and was deleted


## Integration Test Framework

**Mock API** (`src/test-utils/mock-anthropic-api.ts`):
- `ValidatingMockAPI`: instruction-driven mock that validates every request
- Instruction JSON embedded in user messages: `{"blocks": [...]}` (single turn) or `{"turns": [...]}` (multi-turn)
- Parser handles JSON embedded in formatQueueMessage wrappers (timestamps, "[Messages received while you were working:]")
- Validates: turn interleaving, tool_use/tool_result pairing, no empty content, no duplicates
- `createMockedProviderWithMock(mockAPI)`: wires mock into real AnthropicCompatibleProvider

**Integration tests** (`src/integration.test.ts`):
- 7 scenarios: multi-turn tools, multiple tools, yield+wake, implicit yield, JSONL verification, message injection, validation
- Each test: real app + mock provider + temp git project + temp dataDir
- Inject provider via `ctx.config.agentProvider` (DaemonConfig field)
- Root agents (depth 0) dont close queue on done() — they enter idle-yield. Detect completion via node status polling, not activeSessions.
- `waitForDone()`: polls root node status. `waitForIdle()`: polls queue.idle.

**Mutation testing results** (4/4 caught):
- Duplicate messages.push → CAUGHT (consecutive same-role validation)
- Remove messages.push → CAUGHT (missing tool_result validation)
- Remove emit callback → CAUGHT (JSONL tool_result count check)
- Remove yield messages.push → CAUGHT (unpaired tool_use validation)
- NOT tested: compactOnly yield path (needs compact-during-yield scenario)

## Queue Message Format Unification (March 2025)

**Before**: Two separate label systems (`[Messages received while you were idle:]` / `[Messages received while you were working:]`) applied differently in live vs resume paths, causing cache misses on every daemon restart.

**After**: No wrappers. Each queue message is its own text block with just the formatted content (timestamp + XML or raw text). Live path (`buildToolResultsMessage`, `buildImplicitYieldMessage`) and resume path (`onConsumedMessages`, `onToolResults`) now produce identical message structures.

Key changes:
- `ConsumedMessages.isWorkingContext` field removed — the callback's `isWorkingContext` is still used for structural decisions (append vs new message) but no longer for label text
- `isAnthropicWorkingContext` / `isOpenAIWorkingContext` extracted as standalone functions (needed because object literal methods can't reference `this` or `callbacks` variable)
- Both providers' `buildToolResultsMessage` unified: `yieldQueueTextBlocks` + `cancellationTextBlocks` merged into single `queueTextBlocks` / `allQueueTexts`
- `buildImplicitYieldMessage` splits formatted string into individual text blocks per queue message
- Event converter's interleaved `messages_consumed` no longer wraps with `[Messages received while you were working:]`
- Single-message idle context → string content (cache-friendly); multi-message → array of text blocks


## Restart Integration Tests & Resume Path Fix

**Bug found**: When resuming from a crash during tool execution (e.g., bash interrupted), the last reconstructed message from JSONL is a user message (tool_result). The initial queue drain in `runProviderLoop` was pushing a SECOND user message, violating Anthropic API strict role alternation.

**Fix** (provider-shared.ts): When the last reconstructed message is already a user message (from tool_result), combine the queue drain content into it as additional text blocks instead of creating a new user message.

**Prefix validation** in `ValidatingMockAPI`: Validates that API messages are strictly monotonically increasing across calls. Each request's messages must be a prefix extension of the previous request. Normalizes content comparison by stripping `cache_control` annotations and converting string content to array form.

**Crash test scenarios** (integration.test.ts):
- Restart A: crash during explicit yield → agent resumes in yield, wakes on message
- Restart B: crash during bash sleep → orphan tool_result written, agent resumes
- Restart C: crash during implicit yield (end_turn) → same as yield restart
- Restart D: crash after done() → root was "passed", agent relaunches on message
- Restart E: prefix validation self-test

**Key pattern**: `recreateApp()` creates new app+provider from same `dataDir` + same `mockAPI` instance (survives across restarts). autoResumeProjects skips root-only agents (no active children). User message triggers handleInjectMessage → launchAgent(resume: true).


## Unconsumed Messages on Restart (March 2025)

**Bug**: Messages sent while a tool is executing (e.g., bash sleep) go into the live queue AND get persisted to JSONL as `message` events. If daemon crashes before the provider loop drains the queue (emitting `messages_consumed`), the message is lost — it exists in JSONL but the event converter skips it (deferred message with id, no consumption event).

**Fix**: `findUnconsumedMessages()` in events.ts scans for `message` events with IDs that have no corresponding `messages_consumed`. On resume, these are re-enqueued to the agent queue in both `launchAgent` (root) and `runChildAgentInBackground` (child). The provider loop picks them up normally via queue drain, emits `messages_consumed`, and on next resume the converter materializes them correctly.

**Root cause**: Two-phase message lifecycle (message → messages_consumed) assumes the provider loop always completes consumption. Daemon crash breaks this assumption. The fix recovers from the broken state by detecting and re-enqueuing unconsumed messages.

