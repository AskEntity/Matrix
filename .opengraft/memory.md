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

All tools are `ToolDefinition[]` under `mcp__opengraft__*` namespace. ONE execution path via `mcpHandler.handler()`.

**TaskSession** — runtime-only field on `TaskNode`. Contains: `queue`, `cwd`, `fallbackCwd`, `depth`, `backgroundProcesses`, `foregroundExecutions`.

`createBuiltinTools()` + `createOrchestratorTools()` → merged at launch. System prompt = strategy only — `ToolDefinition.description` is sole source of truth for how to call tools.

## Message Schema

`MessageEvent.body` = `QueueMessage` discriminated union. `body.source` discriminates: `user`, `task_complete`, `task_message`, `user_message_forwarded`, `cross_project`, `background_complete`, `tree_change`, `clarify_response`.

- `header?: string` on `user` and `task_message` — context prepended for AI, stripped before UI delivery.
- Messages with `id: ""` = provider prompts (filtered by frontend).
- `send_message` tool: direction determined by comparing taskId to currentNode.parentId.
- `migrateQueueMessage()` handles backward compat from old source names.

## Agent Lifecycle

- `done()` → update status + deliver `task_complete` to parent + close queue (child) or block (root).
- `yield()` = loop-level pause (not JS await). Provider loop intercepts yield tool_use BEFORE executeTool, sets `pendingYieldToolCall`, continues to top of while(true). `handleImplicitYield` waits for queue messages. On resume, `buildYieldPendingSection` provides live ## Pending data.
- `stopAgent()` cascades: closes child queues, sets children to `failed`.
- On JSONL resume: detects pending yield from last tool_call (no matching tool_result) → enters yield-wait directly. `findOrphanedToolCalls` skips yield — handled by the loop.

## Same-Turn Tool Conflict Rules

- **yield + other tools** → other tools execute normally, yield returns success (no-op).
- **done + other tools** → other tools execute normally, done returns error.
- **yield/done alone** → existing behavior.

## Daemon Restart & Recovery

Restart recovery handles several edge cases through a unified approach:

**Orphan cleanup** (`findOrphanedToolCalls` → `writeOrphanedToolResults`): Runs at stopAgent and autoResumeProjects. Writes synthetic tool_results to JSONL for interrupted tool calls. Yield tool_calls excluded (handled by loop-level pause). Single detection path — never add provider-specific orphan detection (caused duplicate tool_result bugs).

**Unconsumed message recovery** (`findUnconsumedMessages`): Messages persisted to JSONL as `message` events but lacking `messages_consumed` are re-enqueued on resume. Deduplicates against persistent queue messages via `unconsumedIds` Set.

**Orphan background processes** (`findOrphanedBackgroundProcesses`): Generates synthetic `background_complete` events for interrupted bg processes. Routes to queue (not JSONL) if agent has pending yield.

**Consecutive user message prevention**: When JSONL ends with user-role message (orphan tool_result), queue drain merges into existing message instead of creating a new user message.

**autoResumeProjects flow**: Orphan cleanup always runs → root idle (no active children) skips auto-resume → root with active children marks children failed, resumes root.

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
- localStorage keys: `og-` prefix. CSS file is `web/style.css` (not `styles.css`).

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
- **Concurrent ULID**: Use full `ulid()` (26 chars) for execId/bgId — sliced ULIDs collide within same millisecond.

## Auth

WebAuthn/Passkey + JWT (HMAC-SHA256). Token in localStorage (`og-jwt`), `authFetch()` adds Bearer header. SSE auth via query param. 30-day TTL.

## Compaction

Structured checkpoint: 7 `<summary>` sections. `extractCheckpoint()` auto-injects CWD + resume instructions. `compact_marker` in JSONL — converter skips events before last marker.

## Background Processes

Two tools: `bash` (execute) + `background` (manage: list/status/kill/await). `formatBashResult()` shared for all output paths. `run_in_background: true` = `foreground_timeout=0`. REST endpoints for move-to-background, kill, cancel-await.

## Fork Task Context

`fork_task_context` MCP tool + `POST /tasks/:nodeId/fork` REST. Copies post-compact events from source session to target (which must have no existing session). Appends `fork_marker` event. Fork is almost always cheaper than cold start due to prompt cache hit.

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

**OpenGraft unique features** (no competitor has ALL): recursive task tree (infinite nesting), cross-project communication, real-time MessageQueue, compaction + fork context combo.

**Positioning**: "Scoped connectivity" — each project is scoped (task tree, memory, git) but not isolated (cross-project messaging = expert consultation).

## og-docs

VitePress docs at og-docs project. Build with npm (not bun — hangs due to vuejs/vitepress#2943). Deploy: `npm install && npx vitepress build docs && npx wrangler pages deploy docs/.vitepress/dist --project-name=og-docs`.

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

Two indicators of test quality — applies to ALL code, not just OpenGraft:

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

**OpenGraft-specific application**: For lifetime/restart bugs, use the integration test framework (`src/integration.test.ts`, `src/test-utils/mock-anthropic-api.ts`). The `recreateApp()` helper simulates real daemon restarts. Every restart test must complete the full lifecycle: crash → restart → resume → done(). Unit tests that call recovery functions directly give false confidence.

**System prompt boundary**: The system prompt is used by ALL projects, not just OpenGraft. Test quality principles in the system prompt must be general software engineering advice. OpenGraft-specific details (mock DSL, JSONL, EventStore, specific file paths) belong in memory.md only.

## Mutation Testing Results (March 2025)

15 mutations tested. 11 caught, 3 gaps fixed, 1 production bug found.

**Gaps fixed**: M1 (yield no-op content assert), M2 (done+bash request count), M12 (Restart M for bg orphan cleanup).

**Production bug found**: Synthetic bg_complete with `id: ""` → converter materializes as immediate user message → consecutive user messages → API 400 on resume. Fix needed: bg_complete should have proper ULID and follow two-phase message lifecycle.

## Synthetic Event IDs

All synthetic events written to JSONL must have proper ULID ids (never `id: ""`). Falsy id causes the event converter to materialize the event as an immediate user message instead of following the two-phase lifecycle. This applies to `findOrphanedBackgroundProcesses` and any future code that generates synthetic message events.


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


## Auth Simplification (March 2026)

Replaced WebAuthn/Passkey auth with local secret-based auth:
- CLI is trust anchor — `~/.opengraft/auth.json` has `jwtSecret` (HMAC-SHA256)
- CLI auto-auth: every HTTP request gets short-lived JWT (5min TTL) via `signCLIToken()`
- `og sign` → generates login token (5min, with jti) → user pastes into web UI
- Web UI: POST /auth/exchange with login token → gets session token (30d)
- JTI replay prevention: in-memory Set with 5min TTL, auto-cleanup
- Rate limiting on /auth/exchange: 5 failures/min/IP
- Removed `@simplewebauthn/server` and `@simplewebauthn/browser` dependencies
- auth.json backward compat: legacy `credentials` field ignored if present
- `hasJwtSecret()` checks existence WITHOUT auto-creating (unlike `getSigningKey()` which auto-creates)
- Biome flags functions starting with `use` as React hooks — renamed `useJti` to `consumeJti`


## Auth v2: Challenge-Response with Browser Keypair

Login: browser generates RSA-OAEP 2048 keypair → user runs `og auth <public_key>` → CLI encrypts JWT → user pastes ciphertext back → browser decrypts → authenticated. JWT never in plaintext outside browser.

## Setup Hook as .example

Project init creates `setup_worktree.sh.example` (not `.sh`). Agent must review, customize, rename. Init does NOT auto-commit — root agent is forced to configure and commit. Tests activate hook by renaming .example → .sh in setup.


## Lifecycle Refactor (March 2026)

### exitReason
`AgentResult.exitReason: ExitReason` — "done_passed" | "done_failed" | "interrupted". `success: boolean` kept for backward compat, derived from exitReason.

**Detection**: done() detected by checking `doneToolUse` presence + `doneResult.isError === false`. `doneExitReason` flag tracks across loop iterations.

### No Fallback
Only `done()` tool produces status changes and task_complete. All other exits = interrupted = status stays in_progress.

**Deleted**: `runChildAgentInBackground` fallback task_complete, `launchAgent` implicit pass, `stopAgent` marking children failed.

**New behavior**:
- `stopAgent`: children stay in_progress (queue closed, session cleaned, no status change)
- Error catch paths: emit error event, status stays in_progress
- `autoResumeProjects`: each in_progress node evaluated independently by JSONL state. Yielding → bypass (zero API call). Interrupted → normal resume. Children resumed via `runChildAgentInBackground`.
- `failCount`: only incremented on done("failed"), not interrupted.

### end_turn = implicit yield
Always enters implicit yield. `!queue` case returns `exitReason: "interrupted"` instead of breaking.

### resumeFromYield bypass
Already works as-is — `pendingYieldToolCall` at TOP of while(true), before any API call. Zero API calls wasted on yield resume.

### AbortSignal passthrough
Now passed to Anthropic SDK `stream()` and OpenAI `fetch()` — stop during AI generation aborts immediately.


## Integration Test: setup_worktree.sh in setupTestContext

Parent-child integration tests were silently broken because setupTestContext didn't activate the setup_worktree.sh hook. ensureChildAgentRunning → WorktreeManager.create() → runHook() threw 'Missing setup_worktree.sh' but the error was swallowed by the .catch() in deliverMessage. Fix: rename .example → .sh after pm.init() and commit it.

