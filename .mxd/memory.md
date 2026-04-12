# Matrix Project Memory

> Single source of truth. Read on every session start. Full design: `Matrix.md`

## ⚠️ Architecture Discipline

Every bug fix MUST ask: (1) What caused this specific bug? (2) Why does the architecture make this class of bug easy?

**Anti-patterns**: duplicate codepaths, lifecycle dependency coupling, legacy fallbacks masking bugs, lazy optional fields, "unify" = adding a third path (delete until ONE remains).

## ⚠️ Task Execution Discipline

Creating tasks is CHEAP. Executing must be DELIBERATE. When user discusses design → draft + discuss. Only execute when they say "go" or explicitly ask to start.

## ⚠️ Clean Rollback = Branch Model Property

Root orchestrator never commits to main directly — not because "root delegates" as abstract rule, but because **direct commits destroy clean-rollback**. If root fixes something on main and the fix is wrong, there is no clean revert: the commit is interleaved with main's history.

Proof: we have cleanly reverted wrong-semantic merges and wrong-architecture merges as single-commit operations. Only possible because both went through branch→merge, never direct-to-main.

User's framing: "if you fix it yourself, how do we cleanly rollback on master branch?"

Two concrete gates root must pass before committing ANY code change:
1. Could this fix be wrong? (answer: any code change could be wrong — always yes)
2. If wrong, do I want to be able to `git revert <merge>` as one operation? (answer: yes)

If yes + yes, the change MUST go through a branch. No exceptions for "it's small" or "I'm sure".

The ONLY direct-to-main operations allowed for root: merge-conflict resolution during branch integration, memory.md curation, task tree management (tree.json updates happen automatically).

This is a product property of Matrix's commit model, not a policy preference. Breaking it degrades the whole system's safety.

## ⚠️ AI Agent Laziness Patterns

1. **Fear of large changes** — revert/fallback instead of executing.
2. **Unnecessary fallbacks** — keep old path "just in case". Delete it.
3. **Won't communicate** — text blocks invisible to parent. Use send_message.
4. **Won't question architecture** — "why does this exist" > "how to make it work".
5. **"Unify" = add third path** — delete until ONE remains.
6. **Premature heuristic stacking** — when building a tool/analyzer, agents default to "handle every imagined case upfront": classifications, category labels, filter flags, pattern-match explanations. Each branch corresponds to an **imagined** use need, not an **observed** one. Half of them end up dead code, and the non-dead ones often hide data patterns the raw output would have revealed. **Correct default: start with the simplest raw dump. Add heuristics only after real use exposes a concrete need.** A 50-line dump is far more valuable than a 500-line "smart analyzer" whose categories were invented at design time. User framing: "先列出原始数据，实际使用的时候慢慢加 heuristic — 我们还不确定是不是真正需要某些条目".
7. **Create-task as path of least resistance** — when a new requirement emerges, agents default to `create_task` even when an existing task (closed, verify, pending) is a better target. Three alternatives exist: (a) create_task fresh, (b) create_task + fork from source, (c) send_message to existing. Option (c) is often correct but loses in every "cheap" dimension: fresh description vs stale, clean session vs unknown state, single step vs two operations, "closed = finished" word bias. The agent picks (a) because it's the local optimum at every dimension — but globally it fragments context across redundant task trees. **Prompt alone cannot fix this** — mechanism is required: (1) required `origin` param on create_task forcing explicit fresh/fork/continue choice, (2) auto-search for similar titles on "fresh" with warning, (3) `latestDirective` field surfaced in get_tree so existing tasks' current focus is visible (not just their original description), (4) collapse fork_task_context into create_task's origin option to eliminate "two-step" cost. See draft task 01KNZGYY4T6SYWVT66DK13XCPV for full design. User framing: "达成同一件事的方式太多，而最省事的方式不是最优的".

## Change Ownership Principle

**Whoever introduces a change owns ALL consequences** (prompt, UI, tests, docs). Root never writes production code — delegates everything.

## Language Policy

Code, task tree, and memory.md: English
Matrix.md: Chinese
Agent reply language: follows the sender's language.

## How to Run Tests

```bash
bun test              # ALL tests (unit + integration). ~1173 pass, 3 skip.
bun run typecheck     # tsc --noEmit
bun run check         # biome lint + format
```

## Architecture Overview

```
Daemon (Hono: HTTP + SSE on :7433)
    ↑               ↑
   CLI (mxd)     Web UI (React, bundled by Bun)
```

- Two providers: `AnthropicCompatibleProvider`, `OpenAIResponsesCompatibleProvider`. Shared `runProviderLoop` + `ProviderAdapter`.
- Three-layer config: global > repo > local. Auth groups define provider+credentials.
- Agent tree = Task tree. Each agent gets worktree + branch from parent's branch.
- All mutable APIs fire-and-forget. Observe via SSE.
- External MCP servers: `McpClientManager` (src/mcp-client.ts).

## Key Files

| File | Purpose |
|------|---------|
| src/task-operations.ts | Shared CRUD operations (MCP + REST call these) |
| src/tool-names.ts | MCP tool name constants + helpers |
| src/queue-message-factory.ts | QueueMessage factories (enforce id/ts invariant) |
| web/event-display.ts | Tool display logic — title generation, summaries (frontend-only, no truncation) |
| web/api.ts | Centralized API URL builder |
| src/daemon/agent-lifecycle.ts | runAgentForNode, stop, deliverMessage, autoResume |
| src/provider-shared.ts | Run loop, ProviderAdapter, yield/done handling |
| src/events.ts | Event types, formatBodyForAI, buildSessionRepair |
| src/event-store.ts | JSONL EventStore (with truncateAfterLine) |
| src/event-converter.ts | walkEventsToMessages + EventConverterCallbacks |
| src/task-tracker.ts | Task tree, node CRUD, tree.json persistence |
| src/image-dimensions.ts | PNG/JPEG pixel dimension parsing |

## Key Architectural Invariants

### JSONL Content Fidelity
JSONL event content = exact content sent to API. Zero transformation. No `.slice()`, no truncation on persisted content. UI truncation only in `stripEventForUI` (SSE layer) and frontend rendering.

### Tool Result Three-Part Invariant
Every tool_result must: (1) emit to JSONL, (2) yield to SSE, (3) push to messages[]. Missing any = orphan, missing UI, or API 400.

### Yield JSONL Invariant
Nothing written to JSONL after yield tool_call except by provider loop. External events go to queue, not JSONL. `hasPendingYield()` detects this state.

### Single Delivery Path
`deliverMessage` is THE message delivery path: JSONL write → queue delivery → flush → auto-launch. `quiet: true` for notifications. No other code writes message events to JSONL.

### ONE Codepath Per Task Operation
`src/task-operations.ts`: createTaskOp, updateTaskOp, deleteTaskOp, closeTaskOp, resetTaskOp, reorderTasksOp. MCP and REST are thin wrappers. Behavioral differences via explicit `if (editedBy === "user")`.

### Two-Phase Message Lifecycle
Phase 1: `message` event persisted → frontend defers. Phase 2: `messages_consumed` → frontend materializes. `QueueMessage.ts` = `Event.ts` = timestamp in `[HH:MM:SS]` — all same value, set once at creation.

### JSONL-Memory Consistency
In-memory `messages[]` and JSONL events are two data structures. Recovery that only modifies `messages[]` doesn't persist — JSONL retains the poison. Any "fix" must touch JSONL, not just memory.

## Agent Lifecycle

- Root and child agents use the same launch function: `runAgentForNode` in `agent-lifecycle.ts`
- `done()` = two-phase: Phase 1 (agent-side: close queue, loop exits) → Phase 2 (daemon-side: status→verify/failed, task_complete, done_notified marker). Intended orphan like yield — no tool_result written.
- `yield()` = loop-level pause. Provider intercepts before executeTool.
- `end_turn` = implicit yield, never implicit done.
- `stopTask()` = per-task real interrupt (close queue + abort signal via `TaskSession.abortController`).
- `launchingNodes: Set<string>` prevents duplicate launches during async setup.
- Session identity check in finally block prevents cleanup clobber when replacement agent launched.
- On JSONL resume, four states detected from JSONL shape:
  - **Explicit yield** (pendingYieldToolCall): bypass to queue.wait
  - **Done** (pendingDoneToolCall): wait for messages, write done tool_result with wake context
  - **Implicit yield** (hasPendingImplicitYield): bypass to queue.wait → handleImplicitYield
  - **Interrupted** (orphaned tools repaired): non-blocking queue drain → API call
- autoResumeProjects: finds in_progress nodes with JSONL + crash recovery for interrupted Phase 2 (done without done_notified).

## Two-Phase done() Lifecycle

### Design
- **Phase 1** (agent-side): done() handler closes queue + returns. No status update, no parent notification. Intended orphan like yield — no tool_result written to JSONL. Provider loop detects done, sets doneExitReason + doneSummary, exits.
- **Phase 2** (daemon-side, in runAgentForNode): After loop exits with done exit reason, updates status (verify/failed), delivers task_complete to parent, writes `done_notified` crash-safe marker to JSONL.
- **Crash recovery**: `findInterruptedDonePhase2` in daemon.ts detects orphaned TOOL_DONE without done_notified → completes Phase 2 on restart. Also fixes stale status (done_notified exists but status still in_progress).

### Status Changes
- "verify" added to TaskStatus: `done("passed")` → verify, `done("failed")` → failed.
- closeTaskOp: verify→closed. Rejects in_progress/pending/draft.
- buildSessionRepair: TOOL_DONE skipped alongside TOOL_YIELD (not treated as orphans).
- AgentResult.doneSummary carries summary from done() handler through to Phase 2.

### Done Resume from JSONL
When JSONL has done orphan (last tool_call is TOOL_DONE with no result), provider loop waits for wake messages, writes synthetic tool_result with "You previously called done()" context.

### Key Pitfalls
- waitForDone test helper must check "verify" or "failed" (no "passed" status exists).
- Root agents no longer block in waitForQueueMessages after done() — loop exits immediately.
- Background processes may be killed by cleanup before completing after done().
- closeTaskOp now rejects pending/draft/in_progress — tests must set verify or failed before close_task.
- **Phase 2 ordering is critical**: session=null is the irreversibility boundary. Phase 2 (status update, parent notification) runs AFTER session cleanup, not before. Before session=null: late messages → relaunch (reversible). After session=null: commit verify + notify parent (irreversible). No race window.

## JSONL Repair

`buildSessionRepair()` in events.ts handles all repair:
- **Orphan only** (tool_call without result): append interrupted results, no truncation
- **Duplicate results** (>1 result for same tool_call): truncate from first duplicate + status message
- `EventStore.truncateAfterLine(sessionId, lineIndex)`: rewrites file keeping lines 0..lineIndex
- Repair runs in runAgentForNode before provider loop starts

## Default Branch

Root node stores branch at init. `baseBranch` required on worktree create (no fallback). Child worktrees branch from parent's branch.

## Session Config + Cache

`session_config` event at JSONL start: tools, systemStable, systemVariable. Frozen between compactions for cache stability. Anthropic cache: 3 breakpoints (tools, systemVariable, 2nd-to-last user message).

## Session Config Refresh at Compact

**Compact is the refresh boundary** for session-scoped config. After compaction wipes messages[] (cache already lost), session_config is re-emitted with CURRENT values:
- `tools`: rebuilt from `request.mcpToolDefs` (picks up tools added to orchestrator-tools.ts since session start)
- `systemStable` / `systemVariable`: refreshed from `request.refreshSystemPrompt()`
- `request.systemPrompt` also updated (next API call reads from here, not just the emitted event)
- `cacheTtl`: **intentionally frozen** (fork inheritance semantic preserved, see draft 01KNFCWDEYR1114TZCNXNCMW4Z for opt-in refresh)

**Without compact (normal resume)**: everything stays frozen from storedConfig → byte-identical prefix → cache hit.

**Why this invariant matters**:
- Anthropic: frozen tools are a DX issue (model can still invoke tools by name — agents CAN work around via knowledge)
- OpenAI Responses: frozen tools are CORRECTNESS-critical (schema-constrained sampling — agents physically cannot call tools not in tools array)
- System prompt: always should match current memory.md + principles after compact (prompt evolution becomes visible)

**Bug found by mutation testing**: initial fix refreshed the emitted session_config event but forgot to update `request.systemPrompt`. Next API call read stale value. Strong test (Invariant A) caught it — "test your tests" principle applied.

**Test approach**: pre-seed JSONL with BOGUS session_config (wrong prompt, wrong tools), run agent to compact, verify post-compact emitted session_config contains CURRENT values (not bogus). Provider-agnostic, no mock instruction dependencies.

See: commit 0d8cda0, test file `src/drift-lifecycle.test.ts`, ValidatingMockAPI helpers `getToolNames()` + `getSystemText()`.

## Cache TTL

- `SessionConfigEvent.cacheTtl?: "1h"` — stored in session_config, inherited via fork.
- Root = `"1h"`, regular children = `undefined` (5min default).
- On resume, `cacheTtl` from stored session_config (not recomputed) — preserves fork inheritance.
- ALL breakpoints (system, tools, messages) use consistent TTL. Extended cache TTL (1h) is GA — no beta header needed.
- **PITFALL**: Never add per-request `anthropic-beta` headers — they override client's `defaultHeaders` (including OAuth header `oauth-2025-04-20`), breaking OAuth mode.
- `{type: "ephemeral"}` and `{type: "ephemeral", ttl: "1h"}` are DIFFERENT cache entries — TTL is part of prefix identity.
- `AgentRequest.isOrchestrator` replaced with `cacheTtl?: "1h"`. Same on ProviderAdapter.callAPI.
- Prefix validation: system+tools strict JSON compare; message breakpoint position can move but value must match; all other messages compared with cache_control included.

## Cache Architecture

### Anthropic Cache Prefix Order
**tools → system → messages** (NOT system → tools → messages). Tools mismatch = entire prefix miss (including system and messages).

### Cache Fixes Applied
1. **Multiline split fix**: `buildToolResultsMessage` and `buildImplicitYieldMessage` split queue messages by `\n` into individual text blocks. JSONL reconstruction merged them back into one. Fix: keep as single text block.
2. **JsonTool golden source**: `{name, description, jsonSchema}` — provider-agnostic. Frozen in session_config. Resume uses frozen tools → byte-identical → cache hit.
3. **session_config tools=[] fix**: Moved session_config emission from agent-lifecycle to runProviderLoop (after tools are ready).
4. **MCP tool ordering**: MCP servers connect asynchronously → tool registration order non-deterministic. Frozen tools solve this.

### Cache Results
- Restart: 99.8% cache hit (582 creation / 362K read)
- Fork: 100% cache hit (0 creation / 365K read)

### Message Cache Breakpoint
Breakpoint on **last** user message (not second-to-last). Last message sent to API is always user role. Anthropic's 20-block lookback caches all preceding history. Previous "second-to-last" strategy caused full miss when only 1 user message existed (post-compaction with no new user input before restart).

### Remaining Cache Concern
`addAssistantMessage` stores raw API response content (SDK key order). JSONL reconstruction uses our manual key order. Within a session this is consistent (messages[] grows in memory). But the two key orders are `{type, id, name, input, caller}` (both paths currently). If SDK ever changes key order, this would break. Low priority — currently not causing issues.

### yield/done tool_result
- yield: `"resumed."` — queue messages delivered as separate text blocks
- done resume: `"You previously called done(). New messages woke you up:"` + working directory — queue messages as separate text blocks (no duplicate embedding)
- Deleted: `buildYieldPendingSection`, `pendingClarifications` counter

### await_background Deleted
await blocked entire agent loop. yield is the one path — accepts all message types. -360 lines.

## 70K Post-Restart Cache Miss (unresolved)

Production root session, post-restart first API call: inputTokens=104,188, cacheCreation=70,607, cacheRead=33,575 (32% hit). Pre-restart last call: 99.67% hit. ~70K drifted between pre-restart live messages[] and post-restart walker reconstruction.

**Cannot isolate by inspection**: pre-restart live state is lost; post-restart live == walker(JSONL) by construction. Comparing current live to current walker-recon shows 0 mismatches.

**Evidence drift was AFTER fork (same session)**: a forked child had 100% cache hit throughout its session, proving pre-fork prefix was walker-consistent. Comparing my live[0..57] to child's inherited reconstruction: byte-identical. Drift appeared between fork and restart — 26-minute window.

**Audited candidates**: addAssistantMessage vs walker onAssistantContent (match), addMessagesCacheControl (same breakpoint strategy), SDK input key ordering (preserved), session_config (latest read both times), walker batching (correct), image filtering (same rejection text), timestamp drift (not reflected in bytes). Nothing found.

**Needs production instrumentation** to catch: persist each API request's exact byte representation + walker-would-produce delta at each tick. Not yet built.

**Possible non-drift explanation**: Anthropic server-side cache eviction or routing (similar pattern to Opus token injection in blog notes).

## Pre-API-Call Debug Snapshot (v2: per-traceId epoch)

Evidence-capture for post-mortem cache-drift debugging. Before each API call, providers write the fully-assembled request bytes to disk. When a restart causes an unexpected cache miss, the **previous run's** snapshot is preserved in its own traceId directory — diff against walker(JSONL) or against the new run's snapshot to find the divergence.

### Layout
```
projects/<id>/debug/<taskId>/<traceId>/last.json
```

- Each `runAgentForNode` invocation has a unique `loopTraceId` (ULID, ~`TaskSession.loopTraceId`) — this is the "epoch" boundary.
- Every API call within one run **overwrites** `<current_traceId>/last.json` (we only need the latest per run).
- Daemon restart → new loop → new traceId → new directory → **old directory is preserved with its final pre-restart snapshot**.
- `rollOldTraceIdDirs(taskDebugDir, 10)` runs at the start of each `runAgentForNode`, keeping the 10 most recent traceId dirs (by mtime) and removing the rest. Non-ULID entries are ignored.

### v1 → v2 migration rationale
v1 used a single flat file `debug/<taskId>.last-messages.json` that was overwritten on every API call. On restart, the first post-restart call **overwrote the pre-restart snapshot** — destroying the exact evidence needed to diagnose drift, at the exact moment it was needed. v2 fixes this by binding the snapshot path to `loopTraceId`, so each run's snapshots live under their own directory. Old flat files from v1 are disjoint from v2's `debug/<taskId>/` layout — no explicit migration needed; they simply become stale artifacts.

### Implementation
- `src/debug-snapshot.ts`:
  - `writeDebugSnapshot(filePath, snapshot)` — sync mkdir + writeFileSync, non-fatal on error. Path is now nested (traceId subdir).
  - `rollOldTraceIdDirs(taskDebugDir, keepCount)` — readdir + filter by ULID regex + sort by mtime + rm oldest. Non-fatal.
- `src/daemon/agent-lifecycle.ts` `runAgentForNode`:
  - Computes `taskDebugDir = <dataDir>/projects/<id>/debug/<taskId>/`
  - Calls `rollOldTraceIdDirs(taskDebugDir, DEBUG_SNAPSHOT_KEEP_TRACE_DIRS)` (=10) BEFORE creating the new run's dir (no race with active writes).
  - Sets `debugSnapshotPath = join(taskDebugDir, loopTraceId, "last.json")` on `AgentRequest`.
- Provider loop is unchanged — it just writes to the path it's given.

### Post-mortem workflow
1. Observe restart → high cacheCreation (drift signal).
2. `ls projects/<id>/debug/<taskId>/` → find the 2 newest traceId dirs (pre-restart + post-restart).
3. Diff their `last.json` files:
   ```
   diff <(jq . debug/<id>/<taskA>/last.json) <(jq . debug/<id>/<taskB>/last.json)
   ```
4. First message-level difference IS the drift location.
5. Optional 3-way: also compare against walker replay `eventsToAnthropicMessages(eventStore.readActive(taskId))`.

Turns the 70K miss investigation from "exhausted code inspection" into "look at the two files".

## Live/Reconstruction Drift Fix — Caption Bug

### Bug
User sends image message while agent in idle context (after end_turn implicit yield). Live path `buildUserTurn` adds `[N image(s) attached by user]` caption text block. Reconstruction path `onConsumedMessages` idle branch did NOT. One missing block → prefix mismatch → full cache miss on restart (580K creation observed in production).

### Fix: delete buildUserTurn's duplicate implementation entirely
NOT "extract shared helper both call" — that's hidden duplication. Instead: Anthropic's `buildUserTurn` **delegates** to the JSONL reconstruction path.

`buildUserTurn(params)` now:
1. Calls `buildToolResultEvents(...)` (exported from provider-shared.ts) to build synthetic events equivalent to what will be emitted to JSONL
2. Appends synthetic `message` events for user-source queue messages (walker resolves them via eventIndex)
3. Returns `eventsToAnthropicMessages(syntheticEvents)` — the same walker callbacks used by JSONL reconstruction

Walker callbacks (`onToolResults`, `onConsumedMessages`, `isAnthropicWorkingContext`) are now the **SINGLE source of truth** for "how Anthropic user messages are built from tool_results + queue messages". Live path can no longer drift because it has no independent construction logic.

Deleted ~160 lines from `buildUserTurn`. Also added caption to idle branch of `onConsumedMessages` (the actual bug fix — live path now routes through this).

### Third Codepath Unified (commit 39e420b)
`provider-shared.ts` initial drain previously had its own ad-hoc construction logic that dropped images and missed caption. Now delegates to `adapter.appendQueueMessagesToMessages(messages, queueMsgs)`.

Each provider extracts its walker's `onConsumedMessages` logic into a named function (`applyAnthropicQueueContent`, `applyOpenAIResponsesQueueContent`). Both the walker callback AND the adapter hook route through this one function. Single source of truth per provider — walker + initial drain can no longer drift.

4 test.todo → 2 pass (image drift tests closed), 2 remain as skeleton tests blocked by mock-API infra for non-user queue sources (task_message, cross_project).

### Dead Code Cleaned (commit f75a512)
`formattedQueueMessages`, `consumedMessageIds`, `consumedQueueMessages` on ToolResult type — removed. No code was setting these (orchestrator-tools doesn't return them; they originated from the deleted `agent-tools.ts`). -81 lines across 5 files. Simplified `collectToolResultImages`, `buildToolResultEvents`, and both OpenAI providers' image routing.

## Duplicate Yield Handling

API can return multiple yield tool_calls in the same assistant turn. Evolution:

**Fix 1**: `buildSessionRepair` only skips the LAST tool_call if it's yield/done. Earlier yield/done orphans are genuine repair targets. Architectural lesson: "Skip yield/done" was too broad — the invariant is "skip the INTENDED orphan", which is specifically the LAST tool_call.

**Fix 2 (superseded)**: Provider loop wrote no-op tool_results for extras as a SEPARATE user message. This caused a new bug: extras user message + real yield's user message → 2 consecutive user messages → API 400 "Messages must alternate roles".

**Fix 3 (current)**: Extras' tool_result events still emit to JSONL immediately (orphan prevention), but their live-path construction is DEFERRED via `pendingDuplicateYieldExtras`. On yield wake, extras bundle into the SAME `buildUserTurn` call as the real yield, producing ONE user message with `[...extras, real, ...queue]`. Order matches JSONL (extras emit at yield-detection, real emits at wake → walker reconstructs in that order → live must match).

Tests: `drift-lifecycle.test.ts` "2 yield calls in same turn" and "3 yield calls in same turn" regression-guard this.

## Compaction Asymmetry

Manual `/compact` injects a summarization instruction as a user message. If the previous loop iteration also pushed a user message (yield tool_result + queue content, done tool_result + queue content), result is two consecutive user messages → API 400 "Messages must alternate roles".

Seven paths in `provider-shared.ts` have this shape. 3 are clean (`continue;` without pushing user msg). 1 is fixed. 3 are deferred via test.todo.

**Fixed** (commit 304fccd): compactOnly pending-yield with empty queue. Defer the yield tool_result push via `pendingCompactYieldToolCall` flag; compact path bundles tool_result into the SAME user turn as summarization text. One user message with `[tool_result, text]` blocks → valid alternation.

**Pattern**: emit to JSONL for orphan prevention, defer messages[] push to merge with next user turn. Same as duplicate-yield fix (19995b9).

**Latent walker bug** (deferred): walker reading `[tool_result, messages_consumed, summarization_request]` produces two consecutive user messages. Proper structural fix: summarization_request should append to the current user turn, not create a separate one. Requires matching live + walker changes for byte-identical output. Documented as test.todo in drift-lifecycle.test.ts.

## Auto-Recovery from API 400

Provider loop auto-recovers from 400 invalid_request_error. On 400, pops broken user message, replaces with safe synthetic tool_results + recovery text, retries once (`autoRecoveryAttempted` flag). Production: `enableAutoRecovery ?? true`. Tests: `enableAutoRecovery: false`.

## OpenAI Provider

- Chat Completions (`OpenAICompatibleProvider`) is dead code — not wired into production.
- `createProviderFromAuth` always creates `OpenAIResponsesCompatibleProvider` for OpenAI auth.
- Responses `streamResponsesAPI` has inner retry (5 attempts, exponential backoff) matching Anthropic. `retryDelayMs` param for fast tests.
- Function tool definitions include `strict: false` in outgoing payload.
- **Tool input Zod validation**: `executeTool` validates all built-in tool inputs against Zod schema. Rejects invalid types at schema boundary. External MCP tools (empty `inputSchema {}`) skip validation.

## Hidden Tools via Anthropic Free-Form Name Sampling

**Matrix's tools list frozen in session_config** defines what the LLM sees in its tool inventory. But the DAEMON's handler registry has every registered tool.

**Anthropic API** uses free-form tool name generation — server dispatches any name to whatever handler exists. Agents can invoke tools NOT in their tools list (e.g., `evaluate_script` is intentionally hidden from session_config). If you know a tool's name, you can call it.

**OpenAI Responses API** uses schema-constrained sampling — the model's probability distribution is masked to only tool names in the provided tools array. Agents CANNOT call tools not in session_config on OpenAI. `strict: false` on Responses only relaxes optional-field validation, not tool-name enforcement.

**Operational consequences**:
- Anthropic agents: can invoke create_folder, delete_folder, etc. by name even in sessions where those tools weren't frozen in
- OpenAI agents: must see the tool in their list to call it
- This is WHY compact-refresh-tools fix is OpenAI-critical, Anthropic-nice-to-have

## Image Handling

- **Pixel dimension guard**: `getImageDimensions(buffer)` in `src/image-dimensions.ts` parses PNG/JPEG headers. read_file rejects >8000px per dimension.
- **Provider-level byte size**: `validateImage?` on `ProviderAdapter`. Anthropic: 5MB decoded. OpenAI: 20MB decoded. Four filter points in `runProviderLoop`.
- **Streaming text partial**: `ctx.streamingText: Map<string, string>` tracks text_delta. Batch events endpoint injects synthetic `assistant_text` with `partial: true`.

## Folder Nodes

`TreeNode = TaskNode | FolderNode` discriminated union. FolderNode: only id, title, parentId, children, type:"folder". No status, no session, no lifecycle. Zero behavior — pure grouping.

### Key Design
- **Tree structure vs task ownership**: `parentId` = tree structure (UI, reparent, delete). `getTaskAbove()`/`getTasksBelow()` = task ownership (message routing, worktree branching, task_complete delivery). Folders are transparent to ownership.
- **MCP tools**: `create_folder`, `delete_folder` (must be empty), `rename_folder` — separate from task tools.
- **56 parentId references audited**: each categorized as tree-structure or task-ownership. Task ownership uses getTaskAbove.
- **Lifecycle rejection**: all lifecycle operations (launch, done, close, reset, send_message) reject folders at entry point.
- **MUST resist feature creep**: persistent tasks started as "just a flag" and grew into a disaster. Folder stays at ZERO behavior forever.
- **getTask() vs get() audit**: All production `getTask()` calls audited. One bug fixed: REST reorder endpoint used `getTask()` → `get()` (folders have children too). All others correct — they access task-specific properties (session, worktree, branch, status).

## TaskNode Serialization — stripSession()

`JSON.stringify(TaskNode)` must NEVER include `session` (runtime-only: messages[], allTools, queue, abortController). Use `stripSession(node)` from `types.ts`. All four MCP tools that return TaskNode now use it: `get_tree`, `get_task`, `create_task`, `update_task`.

**Bug found**: create_task and update_task were missing the strip. A forked task (700K+ tokens in messages[]) updating its own description produced a 2.95MB tool_result → context doubled from 735K to 1.75M → API rejected. get_tree and get_task already had manual `const { session, ...rest }` — unified to `stripSession()`.

## Duplicate Launch Prevention in autoResumeProjects

### Bug: pre-register launchingNodes prevents runAgentForNode from starting
`autoResumeProjects` tried to pre-register all nodes in `launchingNodes` before launching. But `runAgentForNode` checks `launchingNodes.has(nodeId)` → returns early. Agents never started. Never pre-register in `launchingNodes` from outside `runAgentForNode`.

### Fix: quiet deliverMessage in Phase 2 crash recovery
Phase 2 crash recovery calls `deliverMessage(task_complete)` to parent. Without `quiet: true`, this auto-launches the parent → duplicate launch (autoResume also launches it). Fix: `{ quiet: true }` prevents auto-launch. Message goes to JSONL, recovered by `findUnconsumedMessages` when autoResume launches the parent.

### Test lesson: maxConsecutiveStarts conflates crash+resume with duplicate launch
After a crash, `orchestration_completed` never emits (the loop was interrupted). So `orchestration_started` from before crash + from resume = 2 consecutive starts. This is NORMAL. Use traceId uniqueness on `orchestration_started` events instead.

### Test lesson: shutdown() required before recreateApp() in restart tests
Without shutdown, old app's agent stays alive. New app launches another agent for same node → appears as duplicate but is a test setup bug (can't happen in production crash where process is dead).

## Usage Event Persistence

`usage` events moved from ephemeral to persisted. Now written to JSONL by emitEvent.
- Added `outputTokens?: number` to usage event type.
- `walkEventsToMessages` skips `usage` via default case (not conversation content).
- UI: `attach_usage` UpdateOp finds most recent `assistant_text` for same taskId and attaches `CacheInfo` (inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens).
- Displayed as subtle ⚡ hover badge on assistant messages (not separate log entries).
- Color-coded: green (>80% hit), yellow (>30%), grey (<30%).
- Compaction also emits usage (estimated=true, no cache fields) — persisted harmlessly.

## Unified Storage Layout

Each project is now a self-contained folder:
```
~/.mxd/
  projects/<projectId>/
    config.json
    tree.json
    tasks/<taskId>.jsonl     (formerly sessions/<projectId>/<taskId>.events.jsonl)
    debug/                    (empty; drift snapshots etc.)
```

### Migration
- `src/storage-migration.ts` → `migrateStorageLayout(dataDir)` runs at daemon startup (inside `autoResumeProjects`).
- Idempotent, crash-safe: move `.events.jsonl` → `.jsonl`, skip files already at destination, remove emptied old dirs.
- No-op after first successful run (old `sessions/` directory is gone).

### Path helper
- `projectTasksDir(dataDir, projectId)` in `daemon/helpers.ts` = `{dataDir}/projects/{projectId}/tasks/`.
- `getEventStore` uses this. Tests use `join(dataDir, "projects", projectId, "tasks")` directly.

### File extension
- `.jsonl` (was `.events.jsonl` — the `.events` prefix was redundant).
- `EventStore.listSessions()` filters `.jsonl` and strips with `/\.jsonl$/`.
- `pruneSessionFiles` filters `.jsonl`.

### Why
- "sessions" was the wrong word — Matrix's unit of work is a task; each JSONL file is one task's history.
- Project = single folder: back up / move / delete = one operation, not two.
- `debug/` directory created per-project for future drift snapshots and investigation artifacts.

## In-Process Event Subscribers

Daemon's event flow has three consumers:
1. JSONL (persistence, disk)
2. SSE clients (browser UI, HTTP stream)
3. **In-process subscribers** (any daemon code, callback-based)

API in `src/daemon/event-system.ts`:
```ts
const unsubscribe = subscribeToEvents(ctx, projectId, (rawEvent) => { ... });
try { ... } finally { unsubscribe(); }
```

- Keyed by `Map<projectId, Set<EventSubscriber>>` — fanout is O(subs for
  this project), not O(all subs).
- Callbacks receive RAW event objects (pre-strip) — see `taskId` and all
  routing fields directly.
- Throwing subscribers don't kill the broadcast (caught + logged).
- Empty buckets auto-cleaned on last unsubscribe (no unbounded map growth).

`broadcast(ctx, projectId, event)` signature is clean — reaches into ctx
for both sseClients and eventSubscribers.

Use this for: task hooks, budget monitors, external webhooks, test
`waitForEvent` helpers, condition-wait primitives (peek-or-subscribe-or-wait:
check state synchronously → subscribe → add timeout → unsubscribe in finally).

## HTTP MCP Endpoint — Removed Pending Rebuild

Prior HTTP MCP endpoint (POST /mcp) was removed. It was built on an
**attach-based session model** (attach_to → session state → scoped tools)
which conflicts with Matrix's correct architecture: scope should be an
explicit per-call parameter, not ambient session state.

Removed in a single surgical commit:
- `src/daemon/routes/mcp-endpoint.ts` (the endpoint + 10 tools)
- `src/daemon/mcp-session-state.ts` (attach state container)
- `src/daemon/routes/mcp-endpoint.test.ts`, `mcp-endpoint-yield.test.ts`
- `DaemonContext.mcpSessionStore` field

**Preserved**: in-process event-subscriber primitive (above) — it is
general-purpose daemon infrastructure, not MCP-specific. Will be reused by
the rebuilt stateless MCP endpoint.

**Rebuild plan**: stateless ToolDef architecture where each tool declares
its scope (daemon/project/task/special) and availability (internal/external/
both). Same handler code for both internal agent calls and external MCP
calls — scope resolved from agent context (internal) or tool-call params
(external). See the ToolDef refactor task under Agent Loop folder.

## Anti-pattern: Conflating Attached-Observer with Peer-Project (reverted)

**What happened**: tried to add `send_message` to the HTTP MCP endpoint (commits 244665c + 1185983), wrapping peer messages as `cross_project` source. Merged, then realized the semantic was wrong. Reverted in 5efd5f9.

**The confusion**: two architectural layers got conflated into one tool:

| Layer | Model | Relationship | Identity | Scope |
|-------|-------|--------------|----------|-------|
| **1. Attached external client** | Observer + injector | attach_to → operate ON target | "who is doing this" (header on injected user messages) | Scoped to attached task subtree |
| **2. Peer project** | Symmetric project-to-project | No attachment | projectId in cross_project wrapper | Matrix project registry |

Layer 1: client attaches to a project/task, reads state, injects **user_message-style** content with a header like `[from: CC]`. The client is an **external actor** acting ON the target tree — not a peer.

Layer 2: client IS another Matrix project from Matrix's perspective. Registered in project registry. Sends/receives `cross_project` messages. Opaque (Matrix doesn't know its internals).

**Why the wrong merge**: wrapping Layer 1 attach_to's send as `cross_project` implied "attached client IS a peer project" — breaking both semantics. An attached observer isn't a peer; a peer doesn't attach.

**Correct design** (TBD, drafted as follow-up):
- Layer 1: add `send_user_message` tool — injects as user_message with peer header. Remove `read_file`/`list_files`/`search` from MCP tools (client uses its own, just needs worktreePath from attach_to return).
- Layer 2: separate tool set on separate config (possibly separate port). Reuses existing `list_projects` + `send_message_to_project` semantics. Needs new `yield_cross_project` to drain peer's own inbox.

**Lesson**: when one tool looks right for two different use cases, check whether the relationships are symmetric (both parties peers) or asymmetric (one observes the other). Same-wire-format ≠ same-semantic.

## Auth

Challenge-response with browser keypair (RSA-OAEP 2048). CLI `mxd auth <public_key>` → encrypted JWT → paste to browser. CLI auto-auth via `signCLIToken()`.

## CLI Installation

`mxd` CLI globally installed via `bun link`. package.json `"bin": { "mxd": "src/cli.ts" }`, cli.ts has `#!/usr/bin/env bun` shebang.

## UI Notes

- Event fetching: per-session (`api.taskEvents(projectId, sessionId)`) not per-project. Forked sessions contain parent events — merging causes stale content.
- Derived state reset: ALL state cleared on project/task switch (logs, tokenUsage, pendingMessages, etc.).
- Lifecycle entry collapse: consecutive lifecycle-only entries collapsed, keeping last per run.
- Agent status: `activeAgents` Set updated globally in `handleEvent` BEFORE per-session filter (agent_active/idle/stopped/orchestration_started/orchestration_completed). `processEventBatch` calls `checkAgentStatus()` after processing to overwrite stale state from historical events.
- Per-task message drafts: `localStorage` key `mxd-prompt-draft:<nodeId>`. Debounce uses `targetRef.current` (not `targetNodeId` in deps) to avoid saving stale prompt to wrong task key during render transition.
- `/compact` targets viewed task: backend reads `nodeId` from POST body, falls back to rootNodeId. Frontend passes `viewedTaskId`.
- Task tree sort: `STATUS_PRIORITY` in TaskTree.tsx: in_progress(0) > verify(1) > pending(2) > draft(3) > failed(4) > closed(5). Stable sort preserves user ordering within each status group.
- hideCompleted filter: hides `closed` and `failed` only. `verify` is actionable and remains visible.
- Scroll follow mode: scroll-to-bottom re-enables follow, scroll-up disables. Follow button also enables.

## Integration Test Framework

- `ValidatingMockAPI`: instruction-driven mock, sessionId-based conversation keying, prefix validation, field validation.
- Mock DSL: `{"blocks": [...]}` or `{"turns": [...]}` with assert/capture.
- `recreateApp()` simulates daemon restarts. `readSessionEvents` flushes EventStore before reading.
- ~1139 tests (unit + integration). 3 skipped (E2E).

## Test Architecture: Drift vs Correctness Invariants

Two distinct test classes protect against different bug classes. Learned via mutation testing during the caption-bug unification audit.

### Drift invariant (prefix-validation integration tests)
Full agent loop + restart + `ValidatingMockAPI.enablePrefixValidation()`. Catch when **live path diverges from reconstruction path** — two independent codepaths producing different bytes.

**Blind spot after unification**: live path delegates to walker → live and reconstruction SHARE the walker. A walker bug makes both paths "consistently wrong" → validation passes. **Experimentally confirmed**: removing caption from walker → all 27 integration prefix-validation tests still pass.

What drift tests DO catch:
- Accidental creation of parallel user-message-construction paths
- Bugs in non-walker paths: initial drain, buildSessionRepair, compaction rebuild, cache control construction
- EventStore/JSONL corruption
- System/tools presence asymmetry (fixed a gap: previously silently passed when dropping system/tools mid-conversation)

Files:
- `src/drift-tool-lifecycle.test.ts` (22 integration tests — tool lifecycle)
- `src/drift-message-sources.test.ts` (27 integration tests — every QueueMessage source type)
- `src/drift-lifecycle.test.ts` (21 integration tests — yield/done/fork/compact transitions)
- `src/integration.test.ts` Bug repro suite — original caption bug regressions

### Correctness invariant (golden snapshot unit tests)
Direct invocation of `eventsToAnthropicMessages(events)`, assert exact output bytes. Catch when **walker callbacks produce wrong output** (even if consistently wrong across both paths). Fast (~90-150ms per file).

Example: if walker's `onConsumedMessages` lacked caption, both paths would miss it → drift tests pass, golden test catches it by asserting `[{text}, {image}, {caption}]` is the expected output.

Mutation-tested rigorously: every mutation (remove caption idle/working, drop is_error, add is_error to image tool_result, swap block order, break string↔array invariant, drop interleaved text, remove caller field) is caught by at least one test.

Files:
- `src/walker-golden.test.ts` (47 unit tests — core walker correctness)
- `src/drift-infra-audit.test.ts` (23 golden + 39 mock-validator mutation tests)
- `src/drift-tool-lifecycle.test.ts` (29 golden tests — tool lifecycle)
- `src/drift-lifecycle.test.ts` (17 golden tests — yield/done/fork/compact)

### Principle
- Prefix validation tests **convergence** between paths (drift detection)
- Golden snapshots test **correctness** of the path itself
- After unification, correctness can't be inferred from convergence — both needed
- **Don't silently lose coverage when removing duplication.** Unifying two paths into one shifts responsibility: correctness tests must re-establish coverage that drift tests provided.

### Gotcha for golden snapshot authors
User `message` events with `id` are DEFERRED by walker — only materialize via `messages_consumed`. Helper pattern:
```ts
function userPromptEvents(id, content, ts, images?): Event[] {
  return [
    { type: "message", id, taskId: "", body: {source:"user", id, ts, content, images}, ts },
    { type: "messages_consumed", messageIds: [id], taskId: "", ts: ts+1 },
  ];
}
```
Without messages_consumed, message with id is never rendered.

### Third-codepath drift fixed (commit 39e420b)
`src/drift-initial-drain.test.ts` image-drift tests now pass. Initial drain delegates to `adapter.appendQueueMessagesToMessages`, which routes through the same `applyXxxQueueContent` function the walker uses. One function, two call sites, zero drift possible.

## Test-is-Golden / ITA Philosophy

Three layers: Intention → Test → Architecture. Three mutations guard each layer:
- **Intention Mutation**: is this behavior what users actually want?
- **Test Mutation**: do tests catch code changes?
- **Architecture Mutation**: can the code evolve?

Tests are the single source of truth. Bottom-up: write tests → find simplest architecture that passes them. Architecture is replaceable long-term, improved short-term. Reject spec-driven development.

## System Prompt v2

10 chapters. Two roles: root orchestrator, worker. Fork = "changing jobs". Memory callee-saved convention. Ch7 "Keeping Honest" (test your tests, check coupling, challenge the task). "ASK — NEVER SILENTLY FALL BACK." Adversarial testing.

## System Prompt Chapter 7 Renamed

"Three Mutations" → "Keeping Honest". Same three practices, reframed: "Test your tests", "Check coupling", "Challenge the task". Closing paragraph removed.

## System Prompt Ch5 "Using Tools" Added

New chapter between Git(4) and Writing Code(now 6). All subsequent chapters renumbered (5→6...10→11). Four sections:
- **Reversibility**: worktree-internal mistakes recoverable via git; external interactions may not be
- **Scope awareness**: blast radius of each tool, precision matching
- **Time awareness**: foreground blocks loop, background results via yield(), don't re-run running commands
- **Dangerous operations**: filesystem (rm, write_file), git (checkout, add .), tasks (delete erases the decision, reset destroys session, close loses unmerged commits). Hierarchy: send_message > close > reset > delete.

## Compaction Prompt Fix

"this session" → "ENTIRE history". Re-compaction must integrate previous checkpoint into new narrative, not restart. Section 1 and Section 8 both updated.

## System Prompt Editing Discipline

System prompt is for ALL Matrix users, not our project notebook. When editing it:
- Only add universal principles that help any project, not matrix-specific concerns
- Matrix-specific rules go in memory.md
- Read the full prompt before editing — understand the 10-chapter structure
- Delegate to a child for full review if context is insufficient
- Prompt contains only principles and behavioral rules. Flow details go to tool descriptions.

## evaluate_script Discipline

evaluate_script is for runtime debug introspection ONLY (inspecting messages, checking provider state, comparing JSONL vs live memory). Do NOT use it to: reparent tasks, modify tree structure, batch operations, or anything that has a proper MCP tool. Using eval to bypass tool limitations is a trap — fix the tool instead.

## Refactoring Philosophy

Embrace large type refactors. Rename TaskNode → TreeNode = TaskNode | FolderNode. Let the compiler show you every place that assumes "all nodes are tasks." Each error is a location that needs to decide how to handle the new case. Hundreds of errors is not a problem — it is the audit.

"Don't fear large changes" is not just about courage. Static type systems make large changes SAFE — the compiler catches what you miss. The errors are your todo list.

## Known Pitfalls

- **memory.md**: Never `write_file` to append. Use `edit_file` or `echo >>`.
- **Git worktrees**: `extensions.worktreeConfig` required. `core.hooksPath` absolute.
- **Biome**: Typecheck BEFORE lint. No `!important`. No duplicate CSS properties.
- **noUncheckedIndexedAccess**: Array index returns `T | undefined`.
- **Daemon reload**: Commits don't auto-restart the daemon. Must manually restart after code changes.
- **Concurrent ULID**: Use full `ulid()` (26 chars) — sliced ULIDs collide within same millisecond.
- **Provider queue close**: Check `queue.isClosed` after tool execution, `return` immediately.
- **Never modify own JSONL from agent**: Current tool_call has no result yet → false orphan.
- **Async JSONL writes**: `emitEvent` fire-and-forgets `eventStore.append()`. Flush before reading in tests.
- **delete_task cascades**: Deletes all descendants AND session JSONL. Enforced: returns 400 with children.
- **Abort signal leak**: After stop, old runAgentForNode settles async. catch/finally check `sessionWasReplaced` to suppress stale error events.

## Known Bugs (unfixed)

- Manual compaction during yield → consecutive user messages → API 400.

## Vertical Boundary Audit (Daemon → Provider Loop → Tool Handler)

Full audit: `VERTICAL-BOUNDARY-AUDIT.md` in repo root.

### Three Layers
- **Daemon**: DaemonContext, agent-lifecycle, event-system. Creates sessions, manages lifecycle.
- **Provider Loop**: runProviderLoop in provider-shared.ts. Owns messages[], API calls, yield/done detection.
- **Tool Handler**: executeTool dispatch, orchestrator-tools closures, built-in tool closures.

### Clean Boundaries
- **Daemon→Loop** (AgentRequest): 14/17 fields structural. Clean config+IO bundle.
- **Loop→Handler** (executeTool): Pure dispatch — name lookup, Zod validation, call handler. No state leaks.
- **Handler→Loop** (ToolResult): Value type with no back-references.

### Accidental Crossings (block operator/resource split)
1. **`getSession` on AgentRequest**: Loop writes cwd to daemon's TaskSession. Mixes daemon-owned state with loop-local state.
2. **`setMessages`/`setAllTools`**: Reverse binding — loop pushes state UP into daemon for evaluate_script. Exists solely for the hidden debug tool.
3. **`done()` closes queue**: Handler reaches into loop's queue via closure. Should be a return-value signal (loop already intercepts done by name).
4. **TaskSession three-way mutation**: Daemon creates, loop writes (messages, allTools, cwd), handler writes (backgroundProcesses, foregroundExecutions). Worst cross-cutting state.

### Key Finding: yield vs done asymmetry
- **yield**: Clean boundary. Loop intercepts by name, `executeTool` never runs. Handler's `_isYield` return flag is dead code.
- **done**: Boundary violation. `executeTool` runs the handler, which closes queue as side effect. Loop then checks result. Queue.close() couples handler to loop internals.

### Recommendations for Operator/Resource Split
1. Split TaskSession into SessionControl (daemon), LoopState (loop), ProcessState (handlers)
2. Make done() a return-value signal (loop closes queue itself, like yield)
3. Remove setMessages/setAllTools from AgentRequest (replace with callback read)
4. Formalize OrchestratorToolsDeps into OperatorDeps + ResourceDeps

## Unresolved Design (prioritized)

1. Message routing expansion (subtree + parent chain, not just direct parent/child)
2. Folder/grouping feature (UI-only visual grouping, not tree structure)
3. Tool search — dynamic tool discovery (draft exists, Anthropic has server-side `defer_loading` but user prefers client-side)

## Auth/Resource Split (operator/resource refactor)

### Architecture
Three new modules replace the old closure-based OrchestratorToolsDeps:

1. **`src/tool-auth.ts`** — Auth branded opaque type. Only `checkPermission(auth, mode, resource)` can look inside. Modes: project, exact, subtree, family, root. `getBindValues(auth)` is framework-only (for ToolDef adapter).

2. **`src/resource-registry.ts`** — Global handle-based functions. Initialized once at daemon startup via `initResourceRegistry(ctx)` + `registerSideEffects(...)`. All resource access: `getTracker(projectId)`, `getSession(projectId, taskId)`, `emit(projectId, event)`, `deliverMessage(projectId, nodeId, msg)`, etc. No closures, no injection bags.

3. **`src/tool-def.ts`** — ParamDecl with `bind` (not "infer"). Framework binds resource params from agent identity. Decision table: handler always gets T; agent sees bind params as invisible (non-overridable) or optional (overridable); external sees bind params as required.

### Key Naming Decisions
- **auth** not "operator" — writing `auth.taskId` feels wrong (that's the point)
- **bind** not "infer" — framework **binds** a resource param from identity, not "infers" it
- Resource params are just params (called `taskId`, `projectId`) not "callerTaskId" or "hidden params"

### Handler Signature
```ts
handler(args, auth, toolCallId) {
  checkPermission(auth, "subtree", { taskId: args.taskId });
  const tracker = R.getTracker(args.projectId);
  // do work with resources from args + global functions
}
```

### Deleted
- `OrchestratorToolsDeps` interface — replaced by resource-registry global functions
- `LifecycleDeps` interface — deliverMessage/injectMessageToProject now in resource-registry
- All closure-captured deps in createOrchestratorTools
- `execute_tasks` tool (deprecated alias)

### What's NOT Changed Yet
- Built-in tools (bash, read_file, etc. in `src/tools/definitions.ts`) still use closure-based `createBuiltinTools`. They're next.
- TaskSession internal structure unchanged (audit identified it as needing split, but separate refactor)
- External MCP endpoint not yet updated (separate task)

## Vertical Dependency Boundary Audit Findings

Three execution layers: daemon → provider loop → tool handler.
- executeTool boundary is clean (pure dispatch)
- done() closes queue through closure (boundary violation, but structural — leave for now)
- evaluate_script punctures all layers (intentional escape hatch)
- TaskSession is worst cross-cutting state (three-way mutation across all layers)

## Builtin Tools Migration

All 7 builtin tools (bash, background, read_file, write_file, edit_file, list_files, search) migrated from closure-based `createBuiltinTools()` to ToolDef objects using global functions.

- `buildBuiltinToolDefs()` replaces `createBuiltinTools()` — returns ToolDef[] instead of ToolDefinition[]
- All tools use `R.getSession(projectId, taskId)` for session access (cwd, queue, backgroundProcesses)
- `getSession` param removed from `createAgentContext` opts — no longer needed
- Common `bindParams` pattern: all builtin tools bind projectId + taskId (non-overridable)

Now ALL 32 tools (25 orchestrator + 7 builtin) use the same ToolDef + auth + global functions pattern. Zero closure-based tool handlers remain.

## AuthGroup Discriminated Union

`AuthGroup = AnthropicAuthGroup | OpenAIAuthGroup` — discriminated on `provider` field. Each variant has only its own fields (no cross-provider optionals).

### Field Renames (BREAKING config change)
- `anthropicApiKey` → `apiKey`, `claudeOauthToken` → `oauthToken`
- `openaiApiKey` → `apiKey`, `openaiAccessToken` → `accessToken`, `openaiRefreshToken` → `refreshToken`, `openaiAccountId` → `accountId`, `openaiBaseUrl` → `baseUrl`

### systemPreamble (Anthropic only)
`AnthropicAuthGroup.systemPreamble?: string` — prepended as the first system text block at API call time. Not stored in session_config. Takes effect immediately on next API call (no compact/restart needed). Empty string or undefined = no preamble.

### System Prompt Cache TTL
System blocks always use `{ type: "ephemeral", ttl: "1h" }` regardless of per-session `cacheTtl`. System prompt is shared across agents, changes rarely, benefits most from long cache. Tools and messages still use per-session TTL.

## ParamDecl Bind: No Overridable

`ParamDecl` bind variant has no `overridable` field. All bind params are always hidden from agent schema and auto-bound by the framework. create_task and create_folder's parentId changed to `kind: "explicit"` (agent must always specify).

## DEFAULT_CONFIG Immutability (frozen + defensive clone)

`DEFAULT_CONFIG` in `src/config.ts` is `Object.freeze`d at module load (top level + nested `mcpServers`, `cacheTtl`, `authGroups`). Any mutation attempt throws at the point of the bug, not three test files later.

`createApp()` in `daemon.ts` defensive-clones: `globalConfig: { ...(config.initialConfig ?? DEFAULT_CONFIG) }`. PATCH `/config/global` in `daemon/routes/config.ts` builds a new object and replaces `ctx.globalConfig` — never mutates in place.

**Bug fixed**: PATCH `/config/global` used to mutate `ctx.globalConfig` field-by-field. When `initialConfig` was not passed to `createApp`, `ctx.globalConfig` was the SAME reference as `DEFAULT_CONFIG`. A PATCH in one test (e.g. `daemon.test.ts` setting `budgetUsd: 50`) poisoned `DEFAULT_CONFIG` for the rest of the process → `config.test.ts` later failed `budgetUsd === -1` assertion. Production consequence: any long-lived daemon that accepts a PATCH `/config/global` has the module singleton mutated for subsequent `createApp()` calls in the same process.

**Lesson**: module-level constants MUST be frozen. Mutation via `Object.entries` + index assignment bypasses TypeScript's readonly checks. Freeze makes the footgun physically impossible, not just discouraged.

The other two PATCH handlers (`/projects/:id/config/repo`, `/projects/:id/config`) load fresh config from disk and build a new `merged` object — not affected by this bug.

## enqueue === persist (single JSONL write path)

`MessageQueue.enqueue(msg)` synchronously calls `onPersist(msg)` before delivery. This is the ONE way queue messages reach JSONL. All former second-path emissions (recordQueueEvents re-emit, buildToolResultEvents nonUserQueueEvents) are deleted.

### Wiring
- `runAgentForNode` creates `new MessageQueue({ onPersist: (msg) => emitEvent(ctx, projectId, {type:"message", id: msg.id, taskId: nodeId, body: msg, ts: msg.ts}) })`.
- `runProviderLoop` auto-wires onPersist from `request.emit` if the queue has no callback (`hasOnPersist()`), via `setOnPersist`. Unit tests that pass a bare `new MessageQueue()` get automatic wiring.
- `setOnPersist` is one-shot: throws if already set. Production wiring wins over provider-loop auto-wiring.

### replay: true
Recovery paths (`findUnconsumedMessages`, `bgOrphans` append) use `queue.enqueue(msg, { replay: true })` to skip onPersist — the message is already in JSONL from before the restart.

### quiet is orthogonal
`quiet: true` only suppresses waking a pending `wait()`. It does NOT affect persistence. `queue.enqueue(msg, { quiet: true })` still persists.

### deliverMessage simplification
- Agent running → `queue.enqueue(msg)` (one atomic persist + deliver via onPersist).
- Agent not running → direct `emitEvent({type:"message", ...})` + flush (no queue to go through).
- `deliverMessage`'s `opts.quiet` still controls auto-launch only (unchanged).

### recordQueueEvents role
Now emits `messages_consumed` marker only. No `message` event emission. Sole purpose: tell the walker which ids have been consumed by the current turn.

### buildToolResultEvents role
Outputs `tool_result*` + `messages_consumed`. No `nonUserQueueEvents`. The anthropic provider's `buildUserTurn` synth path pushes synthetic `message` events for ALL queue messages (not just user source) so the walker can resolve them via eventIndex.

### bgOrphans unified branch (option A)
Yielding and non-yielding sessions both `appendBatch(bgOrphans)` to JSONL at resume. Walker skips standalone `message` events with ids (event-converter.ts line 181-185) — they materialize only when `messages_consumed` references them — so writing them between a pending yield tool_call and its eventual tool_result is safe.

### Bugs fixed (task 01KNWM9YTTMHEF620EKGCAP9HH)
1. **Duplicate message events**: deliverMessage wrote message to JSONL, then enqueued; provider loop's recordQueueEvents wrote it again for non-user sources. After refactor, single write path. JSONL has each body.id exactly once.
2. **Usage off-by-one**: `usage` was emitted before `assistant_text` in the same turn. Frontend's walk-backwards `attach_usage` found the PREVIOUS turn's text. Fix: reorder provider-shared.ts to emit content events (buildResponseEvents) BEFORE usage.
3. **Missing traceId on lifecycle events**: `orchestration_completed`, `error`, `agent_stopped`, `done_notified` had no `traceId`. Fix: `TaskSession.loopTraceId` field (hoisted out of try block), explicit injection in the 4 lifecycle emitEvent calls, `stopAgent/stopTask` capture session.loopTraceId, `resource-registry` emit auto-injects traceId for tool-handler `R.emit` paths (clarification_requested etc.).

### traceId semantics
**The A/B distinction is persistence timestamp, not content origin.** A message's semantic origin (user, task_message, cross_project, etc.) is irrelevant — what matters is whether a specific loop run was alive and performing the JSONL write.

- **Has traceId** (A-class): events produced BY a specific agent loop run — orchestration_started/completed, done_notified, agent_stopped, error, all provider events (assistant_text, tool_call, tool_result, usage), tool-handler events via R.emit, **AND `message` events persisted via onPersist while a loop owns the queue** (regardless of the message's content origin).
- **No traceId** (B-class): events that exist independently of any run — `task_started` (before loop spawn), `fork_marker` (fork setup), and direct-write `message` events from `deliverMessage`'s fallback path (queue unavailable because the agent is not running).

Wiring: `runAgentForNode`'s `onPersist` callback injects `traceId: loopTraceId`; `deliverMessage`'s fallback `emitEvent` omits `traceId`. `findUnconsumedMessages` replays cold-start messages with `{replay: true}` which skips `onPersist` — their original no-traceId JSONL entries are preserved untouched.

**Earlier memory claimed "all message events have no traceId" — that was wrong.** Counting after the refactor showed ~100% of message events arrive on the onPersist path (agent is typically running when a peer sends a message). The old rule mis-attributed them to B-class. Fixed in commit landing debug-snapshot v2 + message traceId.

### Test architecture
6 new test files, 50+ tests split by concern:
- `src/message-queue-onpersist.test.ts` — MessageQueue unit contract
- `src/event-dedup-jsonl.test.ts` — Bug 1 JSONL dedup invariants
- `src/event-usage-order.test.ts` — Bug 2 emission order
- `src/event-trace-id.test.ts` — Bug 3 traceId semantics
- `src/event-structural-invariants.test.ts` — walker safety (messages_consumed after yield tool_result)
- `src/test-utils/emission-harness.ts` — shared setup/teardown/helpers

### Pitfall: autoResumeProjects not in createApp
`createApp()` does NOT call `autoResumeProjects()`. Tests that simulate restart must call `await newApp.autoResumeProjects()` explicitly before `markReady()`. Only `import.meta.main` daemon entry point auto-calls it.

## buildSessionRepair Scope Boundary — orphan tool_result is OUT

`buildSessionRepair` only repairs states that a **legitimate crash on a valid run** could have produced:
- Orphan tool_call (no tool_result) → append synthetic interrupted result
- Duplicate tool_result → truncate from poison point
- Out-of-order tool_result (result after a new assistant turn) → truncate

It does NOT repair "orphan tool_result" (tool_result without any tool_call). Runtime cannot produce this — tool_result is always emitted by the provider loop immediately after its tool_call. If a JSONL file contains an orphan tool_result, something much more serious is wrong upstream (manual edit, cross-version migration bug, corrupted write). Masking it in the repair layer would hide the real problem.

Walker behavior on this state: emits two consecutive `user` messages (the prior user turn, plus a second user turn wrapping the orphan tool_result). Anthropic API rejects this with 400. The auto-recovery fallback in the provider loop may or may not recover — but the proper fix is to find WHY the orphan tool_result ended up in JSONL, not to paper over it.

`src/jsonl-stress.test.ts` contains behavior snapshots of this case (clearly labeled "BEHAVIOR SNAPSHOT" / "not an invariant"). If someone changes the walker or repair to be "graceful" here, those tests fail and force a deliberate discussion about whether the change masks a real bug.

Lesson: not every "the tool could be nicer to bad input" is a bug. Some inputs should NEVER happen and the layer that sees them isn't the right place to patch the state. Boundaries matter.

## Anthropic Server-Side Cache Injection (2026-04-12 investigation)

**Confirmed behavior**: Anthropic injects ~30% extra tokens into the cache layer. This injection is invisible to the client — not in request body, not in response body, not in count_tokens API. Only visible through usage.inputTokens (which is actually `input_tokens + cache_creation + cache_read` in our JSONL — see `totalContextTokens` computation in anthropic-compatible-provider.ts:615).

### Evidence chain
1. Debug snapshot (traceId `01KNZM6TFNVRB7T3D2CESZN4BD`) saved exact request body: 161 messages, count_tokens = 127,517
2. JSONL recorded usage total = 163,938 for the same call
3. Replay same body now → total = 127,517 (gap = 0). The 36K injection is gone.
4. Injection disappeared at line 26690 (02:49:40 BST): 181K → 141K in 7 seconds, cr=0 (full cache miss)
5. Disappearance coincided with us beginning to use evaluate_script to query auth groups for a comparison experiment

### Timeline
- 02:24:13 compact → 02:24:16 call 26301 cc=74,739 (fresh cache WITH injection)
- 02:24:23 call 26305 **injection content changed** → prefix broke → cr=22,709 (only tools hit) ← original reported miss
- 02:24~02:49 injection stable, incremental growth 74K→181K
- 02:49:40 **injection removed**: 181K→141K, cr=0, full rebuild without injection
- After: all calls gap=0, injection never returned

### Key properties
- Injection only exists in Anthropic's server-side cache, never in our request/response body
- count_tokens API returns client-side count (no injection)
- Injection attaches to cache entries; new sessions inherit injected cache via cache_read
- Cache invalidation (system prompt change) produces clean entries (gap=0)
- Investigation behavior may trigger injection removal (anti-forensic)
- Cannot be reproduced on demand

### Practical impact on Matrix
- Explains ALL previously-unexplained cache misses (70K miss, compact-after misses)
- Our code is correct — all paths verified via count_tokens + raw fetch replay
- analyze-cache tool's hit% is based on `inputTokens` which includes injection overhead
- No code change needed; this is external behavior

### JSONL inputTokens field semantics
`inputTokens` in usage events = `totalContextTokens` = Anthropic's `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. NOT just the raw `input_tokens` field. This is intentional (set at provider-shared.ts:1469).

## Stateless HTTP MCP Endpoint

POST `/mcp` — MCP Streamable HTTP transport for external clients (e.g., Claude Code). Stateless: no attach_to, no session state.

### ToolDef Availability
Required field `availability: "internal" | "external" | "both"` on every ToolDef. No default — each tool explicitly declares who can call it.
- `"internal"`: 25 orchestrator tools + 7 builtin tools
- `"both"`: list_projects, get_tree, get_task, get_logs
- `"external"`: send_user_message, yield_external

External endpoint filters by `availability !== "internal"`. Internal agent pipeline unchanged.

### External Schema (buildExternalShape)
Bind params become required explicit params for external callers. Simple and mechanical — no special cases by `from` field. External clients provide projectId explicitly; taskId bind params become required too.

### get_tree "(you)" Marker
`taskId` removed from get_tree's params entirely. Handler uses `checkPermission(auth, "human", {})` to skip marking for external callers, and `checkPermission(auth, "exact", { taskId: nodeId })` for agent identity. No data extracted from auth — only permission checks.

### Auth Changes
- **`human` permission mode**: `checkPermission(auth, "human", {})` returns true for human auth, false for agent auth. Used by get_tree to skip "(you)" marker.
- **`getBindValues` deleted**: replaced by `resolveBindParam(auth, from)` which resolves one param at a time and asserts on human auth (framework-only, not for handlers).
- **Auth internal storage simplified**: private `Symbol("auth-internal")` as property key instead of WeakMap + branded type.
- **`createAgentAuth` taskId**: `string` not `string | null`. Root orchestrator always has `tracker.rootNodeId`.

### External-Only Tools
- **send_user_message(projectId, taskId, content)**: delivers user message via `R.deliverMessage`. Returns cursor (read BEFORE delivery for stable snapshot).
- **yield_external(projectId, taskId, timeoutMs?)**: subscribes to events via `subscribeToEvents`, waits for wake signals (agent_idle, done_notified, agent_stopped, orchestration_completed). Returns `{ reason, taskStatus, cursor }`.
- **get_logs begin/end**: cursor range pagination. `begin` (inclusive), `end` (exclusive). Returns `{ events, cursor (total count), hasMore }`.

### Workflow: send → yield → get_logs
1. `send_user_message` → returns `{ cursor: N }` (position before message)
2. `yield_external` → blocks until agent pauses → returns `{ cursor: M, reason, taskStatus }`
3. `get_logs(begin=N, end=M)` → returns events from N to M (the agent's response)

### Folder Tool Constants
`TOOL_CREATE_FOLDER`, `TOOL_DELETE_FOLDER`, `TOOL_RENAME_FOLDER`, `TOOL_GET_LOGS` added to `src/tool-names.ts`. `web/event-display.ts` uses constants instead of string literals.

## MCP Layer 1 — Stateless External Endpoint

POST `/mcp` — MCP Streamable HTTP transport. Stateless: no attach_to, no session state.

### 6 tools
- **list_projects** (both), **get_tree(projectId)** (both), **get_task(projectId, taskId)** (both), **get_logs(projectId, taskId, begin?, end?)** (both) — read-only
- **send_user_message(projectId, taskId, content)** (external) — delivers user message, returns cursor before delivery
- **yield_external(projectId, taskId, timeoutMs?)** (external) — peek-or-subscribe-or-wait, returns reason + taskStatus + cursor

### Workflow: send → yield → get_logs
1. `send_user_message` returns `{ cursor: N }` (position before message)
2. `yield_external` blocks until agent pauses → returns `{ cursor: M, reason, taskStatus }`
3. `get_logs(begin=N, end=M)` returns events in that range

### ToolDef availability (required field)
`"internal" | "external" | "both"` on every ToolDef. No default. 25 orchestrator + 7 builtin = internal. list_projects/get_tree/get_task/get_logs = both. send_user_message/yield_external = external.

### Auth changes
- `checkPermission(auth, "human", {})` — new mode for external callers
- get_tree "(you)" marker: uses `checkPermission(auth, "exact", { taskId })` per node, no data extracted from auth
- `getBindValues` deleted → `resolveBindParam(auth, from)`: single param, asserts on human auth. "NOT for handlers" invariant preserved.
- Auth internals: private Symbol key replaces WeakMap + branded type
- `createAgentAuth` taskId: `string` not `string | null` (root always has rootNodeId)

### Prefix/suffix headers (deferred)
`X-MCP-Prefix` / `X-MCP-Suffix` for send_user_message — attempted but reverted. Concurrent request isolation needs per-session McpServer, not shared mutable ref.

### yield_external fast path
Checks `session.queue?.idle` (covers explicit + implicit yield) and `!session` (not running) before subscribing. Without this → deadlock when agent already idle.

## OpenAI SDK Migration

Both OpenAI providers now use the official `openai` npm package (v6.34.0) instead of raw `fetch`.

### Responses provider (`openai-responses-compatible-provider.ts`)
- `streamResponsesAPI` accepts `body: ResponseCreateParams` (SDK type) instead of individual params
- SDK's `client.responses.create(body, { stream: true })` handles retries, SSE parsing, streaming
- Caller (`createOpenAIResponsesAdapter.callAPI`) builds the body, snapshots it, passes to SDK
- SDK returns typed `Response` (aliased as `OAIResponse`) with `.output`, `.output_text`, `.usage`
- `ResponseFunctionToolCall` from SDK replaces hand-rolled `ResponsesFunctionCall`
- ~200 lines of hand-rolled SSE parsing deleted

### Chat Completions provider (`openai-compatible-provider.ts`)
- `callOpenAIAPI` accepts `body: ChatCompletionCreateParamsNonStreaming` (SDK type)
- SDK's `client.chat.completions.create(body)` replaces raw fetch + retry loop
- `ChatCompletion` from SDK replaces hand-rolled `OpenAIChatResponse`
- **ChatCompletionMessageToolCall union**: SDK type is `FunctionToolCall | CustomToolCall`. Must filter with `tc.type === "function"` before accessing `.function.name`/`.function.arguments`.

### Debug snapshot invariant
After this change, for ALL providers: `DebugSnapshot.body` === exact object passed to SDK. Caller builds body → snapshots → sends. Zero divergence possible. Both providers also snapshot the API response via `writeDebugResponse`.

### Test mock infrastructure
SDK parses SSE `data:` JSON directly (not SSE `event:` line) to determine event type. Mocks must include `type` and `sequence_number` in the JSON data payload. Mock helpers: `mockOAIResponse()`, `mockFunctionCall()` build complete Response objects for `response.completed` events.
