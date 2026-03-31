# Matrix Project Memory

> Single source of truth. Read on every session start. Full design: `Matrix.md`

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
- **Session JSONL = most valuable asset**: Contains complete agent thought process. Never auto-delete.

## ⚠️ JSONL Content Fidelity (CRITICAL)

**JSONL event content = exact content sent to API. Zero transformation.**

- No `.slice()`, no truncation, no preview formatting on any persisted event content
- UI truncation happens ONLY in `stripEventForUI` (SSE layer) and frontend rendering
- Header (memory.md) ONLY on true cold start (`!eventStore.has(sessionId)`) — resume agents already have context from JSONL
- Violation = prompt cache miss on every resume = wasted money

## Tool Result Three-Part Invariant (CRITICAL)

Every code path that produces a tool_result must do ALL three:
1. **JSONL**: `emit(tool_result_event)` — for resume/replay
2. **SSE**: `yield tool_result_event` — for frontend
3. **messages[]**: `adapter.buildToolResultsMessage()` + push — for next API call

Missing any one causes: (1) orphan on resume, (2) missing UI feedback, (3) API 400 unpaired tool_use.

## Yield JSONL Invariant (CRITICAL)

**For yielding agents, NOTHING should be written to JSONL after the yield tool_call except by the provider loop itself.** External events (bg_complete, orphan fixes) must go to the queue, not JSONL. Writing events between yield tool_call and its tool_result breaks the event converter → API 400.

`hasPendingYield()` in events.ts detects this state. Used by autoResumeProjects, launchAgent, and runChildAgentInBackground to route events to queue instead of JSONL.

## Tool Architecture

All tools are `ToolDefinition[]` under `mcp__mxd__*` namespace. ONE execution path via `mcpHandler.handler()`.

**TaskSession** — runtime-only field on `TaskNode`. Contains: `queue`, `cwd`, `fallbackCwd`, `depth`, `backgroundProcesses`, `foregroundExecutions`.

`createBuiltinTools()` + `createOrchestratorTools()` → merged at launch. System prompt = strategy only — `ToolDefinition.description` is sole source of truth for how to call tools.

## Message Schema

`MessageEvent.body` = `QueueMessage` discriminated union. `body.source` discriminates: `user`, `task_complete`, `task_message`, `user_message_forwarded`, `cross_project`, `background_complete`, `tree_change`, `clarify_response`.

- `header?: string` on `user` and `task_message` — context prepended for AI, stripped before UI delivery.
- Messages with `id: ""` = provider prompts (filtered by frontend).
- `send_message` tool: direction determined by comparing taskId to currentNode.parentId.
- `migrateQueueMessage()` handles backward compat from old source names.

## Agent Lifecycle

**exitReason**: `AgentResult.exitReason: ExitReason` — `"done_passed"` | `"done_failed"` | `"interrupted"`. Only `done()` produces the first two; everything else (stop, reset, error, queue close, restart) = interrupted.

- `done()` → update status + deliver `task_complete` to parent + close queue (child) or block (root). **Only path for task_complete.**
- `yield()` = loop-level pause (not JS await). Provider loop intercepts yield tool_use BEFORE executeTool, sets `pendingYieldToolCall`, continues to top of while(true). `handleImplicitYield` waits for queue messages.
- `end_turn` (no tool calls) = implicit yield, never implicit done. Always enters queue.wait().
- `stopAgent()` cascades: closes child queues. **Children stay in_progress** (not failed). Agent resumable.
- AbortSignal passed to Anthropic/OpenAI SDK stream — stop during AI generation aborts immediately.
- On JSONL resume: `pendingYieldToolCall` detected → bypass straight to queue.wait() (zero API call). Interrupted agents get orphan tool_result → normal resume.
- `autoResumeProjects`: each in_progress node evaluated independently by JSONL state. Yielding → bypass. Interrupted → resume. Children resumed independently.

## Same-Turn Tool Conflict Rules

- **yield + other tools** → other tools execute normally, yield returns success (no-op).
- **done + other tools** → other tools execute normally, done returns error.
- **fork + other tools** → fork returns error. Fork must be sole tool in turn.
- **yield/done/fork alone** → normal behavior.

## Daemon Restart & Recovery

Restart recovery handles several edge cases through a unified approach:

**Orphan cleanup** (`findOrphanedToolCalls` → `writeOrphanedToolResults`): Runs at stopAgent and autoResumeProjects. Writes synthetic tool_results to JSONL for interrupted tool calls. Yield tool_calls excluded (handled by loop-level pause). Single detection path — never add provider-specific orphan detection (caused duplicate tool_result bugs).

**Unconsumed message recovery** (`findUnconsumedMessages`): Messages persisted to JSONL as `message` events but lacking `messages_consumed` are re-enqueued on resume. Deduplicates against persistent queue messages via `unconsumedIds` Set.

**Orphan background processes** (`findOrphanedBackgroundProcesses`): Generates synthetic `background_complete` events for interrupted bg processes. Routes to queue (not JSONL) if agent has pending yield.

**Consecutive user message prevention**: When JSONL ends with user-role message (orphan tool_result), queue drain merges into existing message instead of creating a new user message.

**autoResumeProjects flow**: Phase 1: orphan cleanup for all nodes. Phase 2: each in_progress node classified independently — yielding → bypass resume, interrupted → normal resume. Root and children resume independently.

**Queue message format**: No wrappers. Each queue message is its own text block. Live path and resume path produce identical structures (no cache misses).

## Event System

**Ephemeral** (broadcast only): `text_delta`, `usage`, `agent_idle`, `agent_active`, `status`, `heartbeat`, `tree_updated`, `clarification_timeout`.

**Persisted**: Everything else. `isPersistedByEmitEvent()` in events.ts — exhaustive switch, compile-time enforced.

**Event converters**: `walkEventsToMessages()` + `EventConverterCallbacks`. Two-phase: events with `id` deferred until `messages_consumed`. `TOOL_NAME_ALIASES` for backward compat with old JSONL.

## Frontend

- `IncomingEvent` type = `UIEvent | SSEOnlyEvent`. Single `as IncomingEvent` cast at SSE boundary.
- `processEvent` / `processEventBatch` — unified for live + batch. Skips `tree_updated` from JSONL.
- `tool_pair` UIOnlyEvent combines tool_call + tool_result. `applyUpdate(entries, op)` pure function.
- `SLASH_COMMANDS` in SlashCommandMenu.tsx: `/compact`, `/stop`, `/clear`, `/settings`.
- localStorage keys: `mxd-` prefix. CSS file is `web/style.css` (not `styles.css`).

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
- **Worktree setup hook**: `.mxd/hooks/setup_worktree.sh` required. Missing = fail.
- **Concurrent ULID**: Use full `ulid()` (26 chars) for execId/bgId — sliced ULIDs collide within same millisecond.

## Auth

Challenge-response with browser keypair (RSA-OAEP 2048). Browser generates keypair → user runs `mxd auth <public_key>` → CLI encrypts JWT → user pastes ciphertext → browser decrypts → authenticated. JWT never in plaintext outside browser.

- CLI auto-auth: every HTTP request gets short-lived JWT (5min TTL) via `signCLIToken()`
- Web UI: session token in localStorage (`mxd-jwt`), `authFetch()` adds Bearer header. SSE auth via query param. 30-day TTL.
- `~/.mxd/auth.json` has `jwtSecret` (HMAC-SHA256, auto-generated)
- `hasJwtSecret()` checks existence WITHOUT auto-creating (unlike `getSigningKey()`)
- Biome flags functions starting with `use` as React hooks — renamed `useJti` to `consumeJti`

## Compaction

Structured checkpoint: 7 `<summary>` sections. `extractCheckpoint()` auto-injects CWD + resume instructions. `compact_marker` in JSONL — converter skips events before last marker.

## Background Processes

Two tools: `bash` (execute) + `background` (manage: list/status/kill/await). `formatBashResult()` shared for all output paths. `run_in_background: true` = `foreground_timeout=0`. REST endpoints for move-to-background, kill, cancel-await.

## Fork Task Context

Unix fork() semantics. `fork_task_context` MCP tool + `POST /tasks/:nodeId/fork` REST.
- Copies post-compact events from source to target (no existing session required)
- Case 1 (fork self): real fork tool_call in events → writes child-side tool_result ("You are the CHILD")
- Case 2 (fork other): injects synthetic tool_call + tool_result pair
- Parent gets: "You are the PARENT." Child gets: "You are the CHILD." — like unix fork() return values
- `fork_marker` is silent structural event — identity info is in the fork tool_result
- fork_marker content merged into tool_result user message via interleavedText in event converter
- Multi-layer forks (A→B→C): system prompt tells agent to look at LAST fork_marker for identity
- Mock API: `getConversationKey` detects forked agents via "You are the CHILD", uses post-fork message as key

## Ownership & Communication

System prompt uses ownership language: agents "own" tasks. "sub task" for downward, "the task above" for upward. `send_message` is unified — direction determined by taskId comparison. `clarify` always goes to user (UI).

XML tags use `from_task` (ID) + `task_name` (title): `task_complete`, `user_message_forwarded`, `task_message`.

## send_message Header Gating

- Header included only on cold start (`node.session == null`). Running agents skip header to save tokens.
- Cold-start header uses `buildTaskPrompt()` from task-utils.ts (includes memory, siblings, budget).
- `formatBodyForAI` embeds header into content. Use `formatQueueMessagesWithHeaders` to extract headers to message level.

## Tree Change Notifications

`source: "tree_change"` QueueMessage with `action`, `nodeId`, `title`. `notifyTreeChange()` walks parent chain, quiet-enqueues to each running ancestor. Also notifies the modified node itself for "updated" actions.

## Anthropic Cache TTL

System prompt + tools: `ttl: "1h"`. Messages: orchestrator `1h`, child agents `5m` (default).

## Anthropic `caller` Field

`caller: {type: "direct"}` on tool_use blocks — official API field. Our JSONL reconstruction hardcodes it. Prefix validation does NOT strip caller (unlike `cache_control`).

## User Preferences

- Don't delete completed tasks — close only.
- Don't change auth config values without permission.
- User communicates in Chinese, expects Chinese for conversation.
- User prefers discussing architecture before executing.
- Remove project = non-destructive (registry removal only, data preserved).

## Competitive Landscape (2026-03)

Key competitors: Claude Code Agent Teams, OpenClaw, Cursor 2.0, OpenAI Codex App, Devin, Stoneforge, Intent (Augment Code), GitHub Copilot Coding Agent.

**Matrix unique features** (no competitor has ALL): recursive task tree (infinite nesting), cross-project communication, real-time MessageQueue, compaction + fork context combo.

**Positioning**: "Scoped connectivity" — each project is scoped (task tree, memory, git) but not isolated (cross-project messaging = expert consultation).

## mxd-docs

VitePress docs at mxd-docs project. Build with npm (not bun — hangs due to vuejs/vitepress#2943). Deploy: `npm install && npx vitepress build docs && npx wrangler pages deploy docs/.vitepress/dist --project-name=mxd-docs`.

## Integration Test Framework

**Mock API** (`src/test-utils/mock-anthropic-api.ts`):
- `ValidatingMockAPI`: instruction-driven mock that validates every request
- Per-conversation turn queues keyed by first user message content (200 chars). Parent+child agents share mock instance without interference.
- Validates: turn interleaving, tool_use/tool_result pairing, no empty content, no duplicates
- **Prefix validation**: API messages must be strictly monotonically increasing across calls. Strips `cache_control` only.

**Mock Instruction DSL**:
- `{"blocks": [...]}` (single turn) or `{"turns": [...]}` (multi-turn)
- `assert` arrays validate previous turn results: `block: N`, `type`, `contains`, `notContains`, `isError`, `matches`
- `capture: {varName: "regex:(group)"}` extracts values for `$varName` in later blocks
- `{length: N}` validates total block count
- Variable substitution uses `split().join()` not `replaceAll()` (`$` in replacement is special)
- Substitution applies to `blocks` only, NOT `assert` rules

**Integration tests** (`src/integration.test.ts`):
- Real app + mock provider + temp git project + temp dataDir
- Root agents don't close queue on done() — detect completion via node status polling (`waitForDone`)
- `recreateApp()` creates new app from same `dataDir` + same mock (survives restarts)

**Restart test scenarios**: crash during yield, during bash, during implicit yield, after done(), prefix self-test, concurrent bash, background processes.

## ⚠️ TDD for Lifetime/Restart Bugs

Lifetime issues (daemon restart, message loss, orphan cleanup) MUST use TDD. Write failing test FIRST, confirm it catches the bug, then fix. The integration framework makes crash/restart scenarios cheap.

**Every restart test MUST complete the full lifecycle**: crash → restart → resume → done(). Never stop at "JSONL has correct events".

**Gotchas**:
- Concurrent bash + crash: NEITHER tool_result gets persisted — both become orphans.
- End_turn implicit yield + timestamp mismatch: Live vs resume format differs. Disable prefix validation for these tests.
- Double restart is safe: orphan cleanup is idempotent.

## Test Quality Principles

Two indicators of test quality — applies to ALL code, not just Matrix:

**Mutation resistance**: After writing tests, mentally mutate the code they cover — flip a conditional, delete a line, change a return value, swap an argument. If no test fails, the test suite has a gap. Add a test that catches the mutation. This is especially important for:
- Conditional branches (if you flip `===` to `!==`, does a test fail?)
- Error handling paths (if you remove a catch/fallback, does a test fail?)
- Edge cases in loops (off-by-one, empty arrays, single elements)
- Return values (if you return `null` instead of the real value, does a test fail?)

**Coverage realism**: Tests must exercise code through the same paths real users trigger, not through test-only shortcuts. Specific anti-patterns:
- Testing a "restart recovery" function by calling it directly instead of actually crashing and restarting
- Mocking away the database layer and then claiming "persistence is tested"
- Testing an event handler by calling the handler function directly instead of emitting the event
- Testing middleware by calling it as a function instead of making an HTTP request through the stack

**Matrix-specific application**: For lifetime/restart bugs, use the integration test framework (`src/integration.test.ts`, `src/test-utils/mock-anthropic-api.ts`). The `recreateApp()` helper simulates real daemon restarts. Every restart test must complete the full lifecycle: crash → restart → resume → done(). Unit tests that call recovery functions directly give false confidence.

**System prompt boundary**: The system prompt is used by ALL projects, not just Matrix. Test quality principles in the system prompt must be general software engineering advice. Matrix-specific details (mock DSL, JSONL, EventStore, specific file paths) belong in memory.md only.

## Synthetic Event IDs

All synthetic events written to JSONL must have proper ULID ids (never `id: ""`). Falsy id causes the event converter to materialize the event as an immediate user message instead of following the two-phase lifecycle.


## Outer API Retry (provider-shared.ts)

The provider loop now has an outer retry around `adapter.callAPI()`. When callAPI throws after exhausting its internal retry loop (5 attempts), the outer retry catches transient errors and retries up to 3 times with exponential backoff (30s, 60s, 120s by default).

- `isTransientAPIError()` — provider-agnostic detection via error `.status` property and message patterns. Works for both Anthropic SDK errors and OpenAI plain errors.
- `getOuterRetryDelayMs` — optional adapter method to override retry delay (used in tests for 100ms instead of 30s).
- Error events are emitted during outer retry so the user sees what is happening.

## Mock API Error Injection

`ValidatingMockAPI.injectError()` — injects transient errors on specific API request numbers:
```typescript
mockAPI.injectError({ onRequest: 2, error: "rate_limit", count: 1 });
```
Uses `TransientAPIError` (NOT Anthropic SDK classes) so the inner retry in callAPI does NOT recognize them as transient → throws immediately → outer retry catches them. This avoids 30s of inner retry delays in tests.

Available error types: `rate_limit`, `overloaded`, `internal_server_error`, `connection_error`.


## Setup Hook as .example

Project init creates `setup_worktree.sh.example` (not `.sh`). Agent must review, customize, and create `setup_worktree.sh`. Init does NOT auto-commit — root agent is forced to configure and commit. Tests activate hook by creating .sh from .example in setupTestContext.

## exitReason Detection Details

done() detected by checking `doneToolUse` presence + `doneResult.isError === false`. `doneExitReason` flag tracks across loop iterations. `success: boolean` kept for backward compat, derived from exitReason.



## Message Event Body Must Include ID (dedup invariant)

The `/tasks/:nodeId/message` REST endpoint writes a message to both JSONL (as event) and persistent queue (via deliverMessage). On resume, `findUnconsumedMessages` recovers messages from JSONL and `loadPersistedMessages` loads from disk. Dedup relies on `msg.id` being present in the JSONL event body — without it, `childUnconsumedIds` stays empty and the persistent queue copy is not filtered, causing duplication. **Rule: event body and deliverMessage payload must be the same object (or at minimum share the same `id` field).**


## QueueMessage Required ID

All QueueMessage variants now require `id: string`. This is enforced at both compile-time (TypeScript) and runtime (MessageQueue.enqueue throws if id is falsy).

Key consequences:
- `queueMessageToEvent` uses `msg.id` directly (no more `ulid()` fallback)
- `recordQueueEvents` in provider-shared.ts: user messages with id skip emit (already in JSONL from send time). This means provider-emitted event lists do NOT include user `message` events — they only contain `messages_consumed` referencing those ids.
- `migrateQueueMessage` adds `id: ulid()` to legacy messages that lack one.
- Tests that verify event reconstruction must prepend user message events (simulating what JSONL already has from send time) before calling `eventsToAnthropicMessages`/`eventsToOpenAIMessages`.


## Unified Message Endpoint

ONE message endpoint: `POST /projects/:id/tasks/:nodeId/message` with `{ content: string, images?: QueueImage[] }`.

- **Root messages**: nodeId = rootNodeId → delegates to `handleInjectMessage` (auto-launch, cold-start header, resume detection)
- **Child messages**: direct delivery with two-phase lifecycle + parent chain notification
- **`POST /projects/:id/message`**: DELETED. All callers use the task endpoint.
- **`/agents/start`** and **`/orchestrate/agent`**: thin wrappers that delegate to `handleInjectMessage` for message delivery. No duplicate enqueue logic.
- **CLI `mxd send`**: resolves rootNodeId from task tree, sends via task endpoint
- **Frontend**: `sendMessageToTask(taskId, content, images?)` is the single function. `sendMessage` removed.
- Field name: `content` (accepts `message` as alias for backward compat)

## rootNodeId: string (never null)

`TaskTracker.rootNodeId` is `string`, not `string | null`. Root node created at `load()` time:
- Fresh project (no tree.json) → creates "Orchestrator" root node
- Old tree.json without rootNodeId → creates root + adopts orphan top-level nodes
- `ensureRootNode()` removed — replaced by `initRootNode()` (private, called from `load()`)
- `launchAgent` no longer creates root — it already exists
- `handleInjectMessage` no longer has "no rootNodeId" branch — rootNodeId always valid

## send_message Header Cold-Start Fix

`orchestrator-tools.ts` send_message handler: cold-start detection changed from `node.session != null` to `node.session != null || deps.hasEventStore(node.id)`. Prevents double-header on fork + send_message (forked agent already has context from JSONL events).


## Architecture Cleanup (March 2026)

**Breaking changes** — old JSONL/tree.json formats no longer supported.

### Deleted
- `TaskNode.message`, `setMessage()`, `failCount` — dead fields
- `TaskStatus`: removed `"stuck"`, `"testing"` — never used by agents
- `AgentSession.sendMessage()` — use `queue.enqueue()` directly
- `AgentResult.success` — use `exitReason` instead (`.not.toBe("done_failed")` for "not failed" checks)
- `AgentResult.testResults` — dead field
- `orchestration_started.prompt` — CLI now shows model name
- `InternalToolResult`, `ToolExecResult` — unified into `ToolResult`
- All backward compat: `migrateQueueMessage()`, EventStore read patches, `runEventMigrations()`, `isStaleEphemeralEvent`, `normalizeEventForUI`, standalone `fork_marker` case, `initRootNode()` orphan adoption, draft boolean migration

### Type changes
- `ToolResult` in shared-types.ts: `content: string`, `isError: boolean` (both required), NO index signature. `BuiltinToolResult` in definitions.ts is local (MCP Array format + index sig for CallToolResult compat).
- `AgentResult`: `costUsd`, `turns`, `sessionId` all required. Mock providers must provide: `{ exitReason, output, costUsd: 0, turns: 0, sessionId: "mock" }`
- `TaskNode`: `costUsd: number` (default 0), `editedBy: "user" | "agent"` (default "agent"). Both required. `load()` backfills via `??=`.
- `TaskTracker.load()` requires `rootNodeId: string` in tree.json (no more optional/null).
- CLI inline types kept `costUsd?: number` for API response compat.

### File splits
- `src/tool-execution.ts`: `executeTool()`, `isTransientAPIError()`, retry constants
- `src/queue-utils.ts`: queue image extraction, message formatting, drain, record
- `src/budget.ts`: `checkBudget()`, `recordBudgetWarning()`
- Re-exports from provider-shared.ts preserved to minimize import churn.

- `PendingClarification.id`: uses `ulid()` (not `Date.now()-random`)
- `handleImplicitYield`: async function (not generator). Events emitted via `emit()` callback; provider generator yields are consumed but ignored.
- `jti` field deleted from JwtPayload (unused)
- CSS variables `--color-testing`/`--color-stuck` kept for non-status uses (compact labels, warnings). Consider renaming to `--color-purple`/`--color-warning`.

### Deferred
- Session-as-Map: moving `TaskNode.session` to `Map<string, TaskSession>` on tracker (~117 refs)
- Derive pendingClarifications from events instead of mutable Map


## Token Usage (March 2026)

**Anthropic**: Sonnet 4.6, 1M context GA, $3/$15 per Mtok. No long-context premium.

**Token breakdown**: tool_result 64-87% of ALL tokens. #1 cost driver. Token/char ratio ~0.37.

**Fork double header**: ~13K tokens wasted per fork. Fixed: cold start detection now checks `eventStore.has(nodeId)`.

**Optimization**: tool_result stays full size forever in context. Anthropic `clear_tool_uses_20250919` beta can auto-clear old tool results.

**Audit scripts**: src/_token_audit.ts and src/_cache_audit.ts.

## session_config Event in JSONL

**Event type**: `session_config` — persisted at JSONL start and after each `compact_marker`.
Records `tools`, `systemStable`, `systemVariable` for the session segment.

**Lifecycle**:
- Fresh start: `buildSessionConfig()` writes session_config, provider uses it
- Resume: `findSessionConfig(activeEvents)` finds stored config → frozen system prompt for cache stability
- Compaction: provider loop emits fresh session_config via `refreshSystemPrompt` callback after `compact_marker`
- Fork: `copySessionFrom` copies all active events including session_config → child inherits parent's config

**buildSystemPrompt()**: Returns `SystemPrompt { stable: string; variable: string }`. No more `isRoot` parameter — all agents share the same stable prompt. `variable` = date + optional selfBootstrap.

**Identity via tree**: ROOT_ORCHESTRATOR_ROLE merged into SYSTEM_PROMPT. Behavior derives from tree position (root node = project-level = only manage tasks). `get_tree` marks calling agent's node with `(you)` in default mode and `you: true` in detailed mode.

**Cache breakpoints (Anthropic)**: 3 slots used:
1. Last tool definition → `cache_control: {type: "ephemeral", ttl: "1h"}`
2. systemVariable end → `cache_control: {type: "ephemeral", ttl: "1h"}` (stable auto-hits via 20-block lookback)
3. Second-to-last user message → `1h` (orchestrator) or `5m` (leaf worker)

**Migration**: Old JSONL without session_config gets one synthesized at agent launch. Written to JSONL end (appended), found by `findSessionConfig` which searches backwards.


## QueueMessage.ts Field + Timestamp Consistency (March 2026)

**Root cause found**: live path and JSONL reconstruction path formatted consumed messages differently — live path added `[HH:MM:SS]` timestamps via `formatQueueMessage`, reconstruction path via `formatEventForAI` did not. This caused prefix mismatches (cache misses) on every resume with consumed messages.

**Fix architecture**:
- `QueueMessage` now has required `ts: number` field — set at creation time with `Date.now()`
- `formatEventForAI` adds `[HH:MM:SS]` prefix to all message events (using `event.ts`)
- `queueMessageToEvent` uses `msg.ts` (not `Date.now()`) — same timestamp source as JSONL
- `formatQueueMessage` is now just `formatEventForAI(queueMessageToEvent(msg))` — single path
- Initial drain in provider-shared.ts uses `formatQueueMessage` for all messages (no special-casing user vs other sources)
- `formatTimestamp` exported from events.ts for shared use

**Also fixed**: `onToolResults` in both Anthropic and OpenAI providers was adding a duplicate pending text block from `result.pending`. The pending section was already embedded in the tool_result content string — the separate text block was a reconstruction-only artifact that broke prefix consistency.

**Key invariant**: `QueueMessage.ts` = `Event.ts` = timestamp used in `[HH:MM:SS]`. All three are the same value, set once at message creation. Never use `Date.now()` at format time.

## Test-is-Golden Philosophy

**Test is golden. Not spec, not architecture.** System prompt `## Test is Golden` section contains the full philosophy (was `## Test Quality`). Applies to ALL projects using Matrix.

- Bottom-up: write tests that define behavior → find simplest architecture that passes them
- Architecture serves tests — question it freely ("is there a simpler design that passes these tests?")
- Reject spec-driven development: spec has interpretation gaps, tests can only be satisfied or not

## Integration Test Infrastructure (March 2026)

**Mock API conversation keying**: Uses `sessionId` (via `metadata.sessionId` in API params) as conversation key. Old message-content heuristic had collisions in 3-level nesting (child/grandchild share memory.md prefix). Falls back to content-based key when sessionId absent.

**Interrupted child resume**: `autoResumeProjects` now persists a "daemon restarted" message for interrupted (non-yielding) child agents before `runChildAgentInBackground`. Without this, provider blocks on `queue.wait()` forever during initial drain. Yielding children bypass drain — no message needed.

**Known: Prefix violation after double restart** (Restart N test). Resume message from `autoResumeProjects` reconstructs differently on 2nd restart → cache miss. Test runs with prefix validation disabled. Real bug, unfixed.

## ⚠️ AI Agent Laziness Patterns (fight these)

1. **Fear of large changes** — told to delete a file, first instinct is revert/fallback instead of executing. Large changes are normal, don't shy away.
2. **Unnecessary fallbacks** — new approach works but keeps "falls back to old approach". Unless backward compat is explicitly required, delete the old path.
3. **Won't communicate** — text blocks are invisible to parent. send_message is the only channel, use it.
4. **Won't question architecture** — sees data written to two places, doesn't ask "why". "Why does this exist" matters more than "how to make it work".
5. **"Unify" = add a third path** — when asked to unify codepaths, AI tends to create a new unified entry but keep old entries. This isn't unification, it's added complexity. Unify = delete all old paths, keep one.

## Architecture Quality: Feature Mutation Test

Probe architecture quality by posing a hypothetical change and counting how many places need modification.

- **1 place** = architecture OK, truly unified codepath
- **3+ places** = duplicate codepaths exist, refactor until it's a one-place change

If a hypothetical change can't be done in one place, the architecture has a problem. Architecture is disposable — tests are the stable anchor.

## Unified deliverMessage (March 2026)

`deliverMessage` is THE single message delivery path. All external message delivery goes through it:
1. Write to JSONL (emitEvent — SSE + persistence)
2. Try queue delivery (if agent running)
3. Flush JSONL (await — ensures on disk before auto-launch reads)
4. Auto-launch child (unless `quiet: true`)

Callers must NOT call emitEvent separately for messages — deliverMessage owns that.

`quiet: true` for notifications (tree_change, parent chain) that should not auto-launch stopped agents.

The persistent disk queue (persistent-queue.ts) was removed. JSONL + findUnconsumedMessages is the sole persistence mechanism. No more dual writes, no dedup logic.

Resume messages from autoResumeProjects must be written to JSONL (via deliverMessage). Otherwise messages_consumed references an ID that doesn't exist in the JSONL event index → empty interleaved text on reconstruction → prefix mismatch.



## Architecture Fix Centralization (March 2026)

- `src/tool-names.ts` — MCP tool name constants (TOOL_YIELD, TOOL_DONE, etc.) + helpers (mcpToolName, stripMcpPrefix, isBuiltinTool). Test files keep literal strings.
- `src/queue-message-factory.ts` — factories for all 8 QueueMessage variants. Enforce `id: ulid(), ts: Date.now()` invariant.
- `web/api.ts` — centralized API URL builder. Changing API prefix = one-place change.
- `src/event-display.ts` — platform-agnostic event rendering. New platforms (CLI, Telegram) use this directly.

## Stress Test Findings (March 2026)

**Known bug: manual compaction during yield creates consecutive user messages.**
`/compact` during explicit yield → yield tool_result (user msg) → SUMMARIZATION_INSTRUCTION (another user msg) → API 400.

**Mock `isCompactionRequest` fix**: Changed from `<summary>` to `Context compression required` (avoids false positive on post-compaction checkpoint content).

**Flaky tests**: `Fork from closed agent` and `BG5` — timing-dependent race conditions.


## Mock API Field Validation (March 2026)

`ValidatingMockAPI.createStream()` validates incoming params against a whitelist of known Anthropic API fields. Rejects unknown fields with `MockValidationError`, mirroring the real API behavior (`"Extra inputs are not permitted"`). Also validates `metadata` sub-fields (only `user_id` is allowed).

**sessionId side channel**: The provider stores `params.sessionId` on the client object as `_currentSessionId` before each `client.messages.stream()` call. The mock client wrapper reads it and passes to `createStream` as a separate argument. The real Anthropic SDK ignores this JS property (never serialized to HTTP). This avoids putting test-only fields in the API params where the real API would reject them.


## Root/Child Unification (March 2026)

**Single message endpoint**: `POST /projects/:id/tasks/:nodeId/message` is THE endpoint for all messages. `/agents/start` and `/orchestrate/agent` deleted.

**CLI**: `mxd run`, `mxd orchestrate`, `mxd send` all use shared `sendToRoot()` → resolveCurrentProject + GET tasks + POST task message. No more `/agents/start` — user must `mxd init` first.

**deliverMessage now handles root auto-launch**: Pass `orchestratorSystemPrompt` in opts to trigger `launchAgent` for root nodes. `shouldResume` checked before JSONL write (the event about to be written shouldn't influence cold-start detection).

**Cold-start header for all nodes**: Task message endpoint adds header on cold start for ALL nodes, not just root. Root gets memory.md + workdir. Child gets buildTaskPrompt (task description + siblings + memory).

**stopTask()**: Per-task stop (close queue, clean session, write orphans). `POST /projects/:id/tasks/:nodeId/stop`. Frontend uses real stop instead of fake "PAUSED by user" text message.

**Upward send_message**: Now goes through `deliverMessage(parentId, msg, {quiet: true})` — persists to parent's JSONL for crash safety. Previously used direct `parentQueue.enqueue()` which was lost on crash.

**Root vs child launch**: genuinely different, NOT duplicated. Root has project-level session tracking (`ctx.activeSessions`), `provider.startSession()`, cost aggregation. Child uses `runChildCore()` with done() detection.

## Self-Bootstrap: Web Auth for Chrome DevTools

When testing the web UI via Chrome DevTools (take_snapshot, click, etc.), the browser may show the Matrix auth/login page. To authenticate:
1. Take a snapshot of the login page to see the public key
2. Run `bash` with `bun src/cli.ts auth <public_key_from_page>`
3. The output is an encrypted token — paste it into the login page input
4. Now Chrome DevTools can access the authenticated UI

## Scroll Anchoring Fix (ActivityLog)

MutationObserver must use `autoScrollRef.current`, not closure-captured `autoScroll`. Stale closure caused scroll-to-bottom even when user scrolled up. CSS `overflow-anchor: auto` on `.mxd-activity-log` for native browser anchoring. Safari fallback via IntersectionObserver.


## Default Branch Detection (March 2026)

Root node gets `branch` set at tracker load time via `detectBranch()` in `getTracker()`. Fresh projects: branch passed to `TaskTracker.load(defaultBranch)` → `createRootNode(branch)`. Old projects: backfilled if `root.branch` is null.

`WorktreeManager.create()` requires `baseBranch: string` (no fallback to HEAD). All callers look up parent node branch: `currentNode.branch` in orchestrator-tools, `parentNode.branch` in agent-lifecycle and tasks route.

System prompt is branch-name-agnostic. No hardcoded "main" references. Agents only know "my branch" and "the task above merges me".


## Persistent Tasks (March 2026)

`TaskNode.persistent: boolean` — discriminates serialization + close behavior:
- **Regular** (`persistent: false`): title/description in tree.json. close → "closed".
- **Persistent** (`persistent: true`): title/description in `.mxd/tasks/<id>.json` (git-tracked). close → "pending".

**Serialization**: `save()` strips title/description from persistent nodes. `load(defaultBranch, projectPath)` merges `.mxd/tasks/*.json` — new files create pending nodes under root, existing nodes get title/description refreshed.

**Auto-commit**: `create_task` with `persistent: true` writes `.mxd/tasks/<id>.json` then auto-commits (`git add` + `git commit`). Without this, the dirty working tree blocks `isGitClean()` → worktree creation fails → child agent never launches.

**Root only**: Only depth-0 agents can create persistent tasks.

**Frontend**: 📌 icon in TaskTree for persistent nodes.

**Type system**: `SerializedPersistentNode` / `SerializedRegularNode` / `SerializedTaskNode` union types exist for tree.json serialization but are not used at runtime. Runtime `TaskNode` is a flat interface with `persistent: boolean`.


## Persistent Task Update Fix (March 2026)

**Bug**: `update_task` (both MCP tool and REST PATCH) updated in-memory node but never wrote to `.mxd/tasks/<id>.json`. On daemon restart, `load()` read from the json file and got the OLD values.

**Fix**: `TaskTracker.savePersistentDef(nodeId, projectPath)` — centralized method that writes title/description/color to `.mxd/tasks/<id>.json` + git auto-commit. Called by:
- `create_task` MCP tool (on creation)
- `update_task` MCP tool (on title/description/color change)
- REST PATCH `/tasks/:nodeId` (on title/description/color change)

No-op if node is not persistent.

**Also fixed**: MCP `delete_task` was not cleaning up descendant worktrees/JSONL (only cleaned the target node). REST DELETE did this correctly. Now both iterate all descendants.

**Anti-pattern caught**: REST and MCP having independent implementations of the same operation. Always centralize in TaskTracker or a shared helper.


## cleanupTaskResources (March 2026)

`cleanupTaskResources(tracker, nodeId, deps)` in task-utils.ts — single codepath for deleting a task and all its descendants. Closes agent queues, removes worktrees via `deps.removeWorktree`, clears JSONL via `deps.clearEventStore`. Both MCP `delete_task` and REST `DELETE /tasks/:nodeId` call this.

`savePersistentDef(nodeId, projectPath)` on TaskTracker — writes `.mxd/tasks/<id>.json` + git auto-commit. Called by create_task, update_task (MCP), and REST PATCH. No-op if node is not persistent.
