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
6. **Premature heuristic stacking** — when building a tool/analyzer, agents default to "handle every imagined case upfront": classifications, category labels, filter flags, pattern-match explanations. Each branch corresponds to an **imagined** use need, not an **observed** one. Half of them end up dead code, and the non-dead ones often hide data patterns the raw output would have revealed. **Correct default: start with the simplest raw dump. Add heuristics only after real use exposes a concrete need.** A 50-line dump is far more valuable than a 500-line "smart analyzer" whose categories were invented at design time. User framing: "List raw data first, add heuristics incrementally during actual use — we're not sure we actually need certain items."
7. **Create-task as path of least resistance** — when a new requirement emerges, agents default to `create_task` even when an existing task (closed, verify, pending) is a better target. Three alternatives exist: (a) create_task fresh, (b) create_task + fork from source, (c) send_message to existing. Option (c) is often correct but loses in every "cheap" dimension: fresh description vs stale, clean session vs unknown state, single step vs two operations, "closed = finished" word bias. The agent picks (a) because it's the local optimum at every dimension — but globally it fragments context across redundant task trees. **Prompt alone cannot fix this** — mechanism is required: (1) required `origin` param on create_task forcing explicit fresh/fork/continue choice, (2) auto-search for similar titles on "fresh" with warning, (3) `latestDirective` field surfaced in get_tree so existing tasks' current focus is visible (not just their original description), (4) collapse fork_task_context into create_task's origin option to eliminate "two-step" cost. See draft task 01KNZGYY4T6SYWVT66DK13XCPV for full design. User framing: "Too many ways to achieve the same thing, and the easiest way isn't optimal."

## Change Ownership Principle

**Whoever introduces a change owns ALL consequences** (prompt, UI, tests, docs). Root never writes production code — delegates everything.

## Language Policy

Code, task tree, and memory.md: English
Matrix.md: Chinese
Agent reply language: follows the sender's language.

## How to Run Tests

```bash
bun test              # ALL tests (src/ + web/). Single command.
bun run typecheck     # tsc --noEmit
bun run check         # biome lint + format
```

**Rules:**
- Never pipe test output (`| grep`, `| head`, `| tail`). Run bare, read the saved output file afterward.
- If tests are flaky, run multiple times without pipes and read each output file separately.
- ~1834 tests pass, 4 skip.
```

## Architecture Overview

```
Daemon (src/daemon.ts — Hono HTTP shell, :7433)
  ├── Auth, project CRUD, config CRUD, plugin discovery
  ├── Web build (Bun.build → importmap + vendor React + shell + plugin)
  ├── SSE relay (ring buffer + Last-Event-ID catch-up)
  └── Worker (src/runtime/scope-worker.ts — per-plugin)
        └── Runtime (src/runtime.ts — agent lifecycle, tools, JSONL, MCP)
              └── Plugin (ScopeOpts: tools, prompt, hooks)

CLI (mxd) → HTTP API → Daemon → Worker
Browser → Daemon (static assets + SSE) + Worker (API forwarding)
```

- **Daemon** = HTTP shell. Owns auth, projects, config, SSE, web build. No agent logic.
- **Worker** = Bun Worker thread running runtime. Owns agents, tools, JSONL, trackers.
- **Plugin** = `.mxd/plugin/` — provides ScopeOpts (tools, prompt, hooks) + web UI component.
- **Shell UI** = `web/` — auth, header, project/scope selector, settings.
- **Plugin UI** = `.mxd/plugin/web/Plugin.tsx` — compiled React component library, NOT SPA. Receives `projectId` prop.
- Two providers: `AnthropicCompatibleProvider`, `OpenAIResponsesCompatibleProvider`.
- Three-layer config: global > repo > local. Auth groups define provider+credentials.
- Agent tree = Task tree. Each agent gets worktree + branch from parent's branch.
- External MCP servers: `McpClientManager` (src/mcp-client.ts).

## Key Files

| File | Purpose |
|------|---------|
| src/daemon.ts | Meta-daemon: HTTP, auth, plugins, workers, SSE relay, web build |
| src/runtime.ts | Worker runtime: createApp, agent lifecycle, routes |
| src/runtime/agent-lifecycle.ts | runAgentForNode, stop, deliverMessage, autoResume |
| src/runtime/scope-worker.ts | Worker entry: postMessage protocol, HTTP forwarding |
| src/web-builder.ts | Bun.build pipeline: vendor React ESM + importmap + shell + plugin |
| src/plugin.ts | PluginManifest type, dataRoot resolution, collision detection |
| .mxd/plugin/index.ts | Matrix plugin manifest (scope, web, runtime, onProjectInit) |
| .mxd/plugin/web/Plugin.tsx | Matrix UI component (task tree, activity, input bar) |
| src/task-operations.ts | Shared CRUD operations (MCP + REST call these) |
| src/provider-shared.ts | Run loop, ProviderAdapter, yield/done handling |
| src/events.ts | Event types, formatBodyForAI, buildSessionRepair |
| src/event-store.ts | JSONL EventStore (with truncateAfterLine) |
| src/event-converter.ts | walkEventsToMessages + EventConverterCallbacks |
| src/task-tracker.ts | Task tree, node CRUD, tree.json persistence |

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

- **Phase 1** (agent-side): close queue, loop exits. No status update. Intended orphan (no tool_result).
- **Phase 2** (daemon-side): status→verify/failed, task_complete to parent, `done_notified` crash-safe marker.
- **Crash recovery**: `findInterruptedDonePhase2` detects orphaned TOOL_DONE without done_notified → completes Phase 2 on restart.
- **Status**: `done("passed")` → verify → close_task → closed. `done("failed")` → failed.
- **Phase 2 ordering**: session=null is irreversibility boundary. Phase 2 runs AFTER session cleanup.

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

## 70K Post-Restart Cache Miss (RESOLVED — Anthropic server-side injection)

Was caused by Anthropic server-side cache injection (~30% extra tokens injected into cache layer, invisible to client). Confirmed via count_tokens + replay experiments. NOT a Matrix bug. See "Anthropic Server-Side Cache Injection" section below.

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

`buildUserTurn` now delegates to walker callbacks (single source of truth per provider). Live path has no independent construction logic — can't drift from JSONL reconstruction. Initial drain also delegates via `adapter.appendQueueMessagesToMessages`. Dead ToolResult fields (`formattedQueueMessages`, `consumedMessageIds`, `consumedQueueMessages`) removed.

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

## Stateless HTTP MCP Endpoint

POST `/mcp` — MCP Streamable HTTP transport for external clients. Stateless: no attach_to, no session state. 6 tools: list_projects, get_tree, get_task, get_logs (both), send_user_message, yield_external (external-only). ToolDef `availability: "internal" | "external" | "both"` on every tool. Workflow: send_user_message → yield_external → get_logs.

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

## System Prompt

14 chapters. Two roles: root orchestrator, worker. Key principles: "ASK — NEVER SILENTLY FALL BACK", adversarial testing, fork = "changing jobs", memory callee-saved.

**Editing discipline**: prompt is for ALL Matrix users, not our project notebook. Matrix-specific rules → memory.md. Read the full prompt before editing. Principles and behavioral rules only — flow details go to tool descriptions.

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

## Vertical Dependency Boundaries

Three layers: daemon → provider loop → tool handler. executeTool is clean (pure dispatch). done() closes queue through closure (boundary violation, but structural). evaluate_script punctures all layers (intentional). TaskSession has three-way mutation. Full audit in `VERTICAL-BOUNDARY-AUDIT.md`.

## Unresolved Design (prioritized)

1. Message routing expansion (subtree + parent chain, not just direct parent/child)
2. Folder/grouping feature (UI-only visual grouping, not tree structure)
3. Tool search — dynamic tool discovery (draft exists, Anthropic has server-side `defer_loading` but user prefers client-side)

## Auth/Resource Split

- `tool-auth.ts`: Auth opaque type. `checkPermission(auth, mode, resource)` only way to check. Modes: project, exact, subtree, family, root, human.
- `resource-registry.ts`: Global handle-based functions (`R.getTracker(projectId)`, `R.emit(projectId, taskId, spec)`, etc.). No closures.
- `tool-def.ts`: ParamDecl with `bind` kind. Framework binds resource params from agent identity. Handler signature: `handler(args, auth, toolCallId)`.
- All 32 tools (25 orchestrator + 7 builtin) use ToolDef + auth + global functions. Zero closure-based handlers remain.



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

### Flags
- `replay: true` — skip onPersist (message already in JSONL from before restart)
- `quiet: true` — suppress wake, NOT persistence. Orthogonal to replay.

### traceId semantics
- **Has traceId**: events produced BY a specific agent loop run (provider events, lifecycle events, onPersist messages)
- **No traceId**: events external to any run (`task_started` before spawn, `fork_marker`, direct-write `deliverMessage` fallback)

### Pitfall
`createApp()` does NOT call `autoResumeProjects()`. Tests must call it explicitly.

## buildSessionRepair Scope Boundary

Repairs: orphan tool_call → synthetic result, duplicate tool_result → truncate, out-of-order result → truncate. Does NOT repair orphan tool_result (no tool_call) — that state can't be produced by runtime, so masking it hides real bugs.

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

### Key facts
- Injection invisible to client (not in request/response body, not in count_tokens API)
- Explains all previously-unexplained cache misses. Our code is correct.
- `inputTokens` in usage events = `totalContextTokens` (input + cache_creation + cache_read)

## OpenAI SDK Migration

Both providers use official `openai` npm package (v6.34.0). SDK types replace hand-rolled types. `ChatCompletionMessageToolCall` is a union — filter with `tc.type === "function"` before accessing `.function`.

### Debug snapshot invariant
After this change, for ALL providers: `DebugSnapshot.body` === exact object passed to SDK. Caller builds body → snapshots → sends. Zero divergence possible. Both providers also snapshot the API response via `writeDebugResponse`.

### Test mock infrastructure
SDK parses SSE `data:` JSON directly (not SSE `event:` line) to determine event type. Mocks must include `type` and `sequence_number` in the JSON data payload. Mock helpers: `mockOAIResponse()`, `mockFunctionCall()` build complete Response objects for `response.completed` events.

## Thinking Block Provider Filtering

Thinking events have optional `provider?: string` field. `buildResponseEvents` in Anthropic adapter sets `provider: "anthropic"`. Walker propagates provider through `AssistantContent` items. Anthropic's `onAssistantContent` filters: `provider === undefined` (legacy) or `provider === "anthropic"` → included; any other provider → skipped.

This means switching providers automatically drops stale thinking blocks from JSONL history. OpenAI's walker already ignores thinking items entirely (filters only `text` and `tool_call`).

Mock API supports `{type: "thinking", thinking: "...", signature: "..."}` in instruction blocks. Streams `thinking_delta` + `signature_delta` events.

Test file: `src/drift-thinking.test.ts` (11 golden + 4 drift integration = 15 tests).


## JSONL Lifecycle Refactor

### What changed
- Message `header` field **deleted** — context injection via `work_context` messages instead
- `work_context` and `compacted_resume` are QueueMessage source types (not Event types)
- `compact_marker` is empty boundary (no checkpoint content)
- `summarization_request` event type removed (merged into `compact_started`)
- Lifecycle events merged: `agent_start` (replaces task_started + orchestration_started), `agent_end` (replaces orchestration_completed + agent_stopped + budget_exceeded)
- `done_notified` preserved (crash-safe marker)
- `session_config` emitted in runAgentForNode before any messages (was in provider loop after)

### Enqueue hook mechanism
- `MessageQueue.setBeforeFirstMessage(hook)`: one-shot hook fires before first non-replay enqueue
- `markBeforeFirstMessageFired()`: skip on resume (work_context already in JSONL)
- `resetBeforeFirstMessage()`: re-arm after compact
- Explicit work_context enqueue in runAgentForNode for fresh sessions where deliverMessage replay path fires before hook wiring

### JSONL event sequence (new)
**Fresh session:** `session_config → message(work_context) → message(trigger) → messages_consumed → ...`
**Post-compact:** `...compact_started → assistant_text → compact_marker(empty) → session_config → message(work_context) → message(compacted_resume) → messages_consumed → ...`
**Restart:** No re-emission of session_config or work_context (already in JSONL from first run)

### agent_end = renamed agent_stopped (not merged lifecycle events)
`agent_end` is simply `agent_stopped` renamed. Emit positions unchanged from pre-refactor:
- `stopAgent`/`stopTask`: synchronous emit with captured traceId BEFORE session clear
- `runAgentForNode` finally: `notReplaced` guard emit (skips when stop already emitted)

**Critical lesson**: Previous attempt merged `orchestration_completed` + `agent_stopped` into one event emitted from ONE place (finally block). This changed lifecycle logic → deadlock on done(). The 2s timeout in shutdown() was a band-aid, not a fix. Correct fix: keep emit positions unchanged, just rename the event.

`orchestration_completed` deleted entirely — stats tracked via `tracker.updateCost`, not events.

agent_end.reason: `stopped` (only value now — other exit reasons tracked elsewhere)

### Migration
`bun src/migrate-jsonl.ts` — one-time conversion. Idempotent. Already run on all project JSONL files.

## EventSpec Type

`EventSpec = DistributiveOmit<Event, "taskId">` — event before routing. Producers create EventSpec (no taskId), emit layer adds taskId + traceId. `DistributiveOmit` preserves discriminated union structure.

**Single emit path**: `R.emit(projectId, taskId, spec: EventSpec)` is the ONE path above `emitEvent`. Deleted `emitWithTask` closure. Streaming text tracking + traceId lookup unified in R.emit's registered implementation. Provider loop stays decoupled — receives emit via `AgentRequest.emit: (spec: EventSpec) => void`.

## Abort Signal + Inner Retry Fix

Anthropic provider inner retry was catching abort errors as transient errors → 4 retries × exponential backoff = 30s delay on stopTask/resetTask. Fix: (1) catch checks `signal.aborted` first, (2) retry sleep responds to abort, (3) post-sleep abort check. Reset time: 30s → instant.

## Plugin Architecture

### Three-Layer Split
- **Daemon** (`src/daemon.ts`): HTTP shell, auth, config, project CRUD, plugin discovery, worker management, SSE relay (ring buffer + Last-Event-ID), web build (Bun.build + importmap)
- **Runtime** (`src/runtime.ts`): Plugin-agnostic. ZERO Matrix imports. Receives `buildScopeOpts` via config.
- **Plugin** (`.mxd/plugin/`): Matrix-specific — manifest, tools, prompt, hooks, web UI component

### ScopeOpts on RuntimeContext

`ctx.scopeOpts: Map<projectId, ScopeOpts<T>>` — per-project scope configuration. `buildMatrixScopeOpts()` is the ONE place that knows Matrix tools + prompt + hooks.

```ts
interface ScopeOpts<T extends PluginTypes> {
  buildTools: (auth, taskId) => { tools, ... };
  buildPrompt: () => SystemPrompt;
  connectMcp?: (projectPath) => Promise<McpClientManager>;
  beforeChildLaunch?: (node, tracker, projectPath) => Promise<void>;
  shouldResume?: (node) => boolean;
  onLaunch?: (node) => void;
  onDone?: (node, doneData) => void;
  buildWorkContext?: (node, project) => string;
  buildSummarizationPrompt?: (node) => string;
  buildDoneResumeContext?: (node) => string;
}
```

### BaseTaskNode / TaskNode Split

Runtime uses `BaseTaskNode` (id, parentId, children, title, session). Matrix extends with `TaskNode` (adds status, description, branch, worktreePath, cwd, color, costUsd, budgetUsd, etc.).

```ts
interface BaseTaskNode { id, parentId, children, title, session, ... }
interface TaskNode extends BaseTaskNode { status, description, branch, worktreePath, cwd, ... }
```

### PluginTypes Generic

```ts
interface PluginTypes { node: BaseTaskNode; done: BaseDoneData; }
interface MatrixPluginTypes { node: TaskNode; done: MatrixDoneData; }
```

ScopeOpts<T> flows the generic through all hooks — type-safe per-plugin.

### cwd Migration

- `node.cwd`: persistent field on TaskNode (survives restart)
- Bash `cd` updates `node.cwd` directly
- `session.cwd`, `session.fallbackCwd`, `AgentRequest.cwd`: all deleted
- Tools read via `getTaskCwd()`: node.cwd → node.worktreePath fallback
- provider-shared.ts loop-local cwd: deleted

### AgentRequest Simplified

- `buildSystemPrompt: () => SystemPrompt` replaces both `systemPrompt` and `refreshSystemPrompt`
- Provider loop owns resume/frozen logic internally
- `cwd` field deleted (lives on node)
- `projectPath` field deleted (lives on node as worktreePath)

### What Runtime No Longer Knows

After step 0 + step 1, `runAgentForNode` has zero Matrix imports. Runtime doesn't know about:
- Matrix's tools or system prompt (ScopeOpts.buildTools/buildPrompt)
- MCP server config (ScopeOpts.connectMcp)
- Git worktrees (ScopeOpts.beforeChildLaunch)
- Node lifecycle states (ScopeOpts.shouldResume/onLaunch/onDone)
- Work context / compaction prompt (ScopeOpts hooks)
- cwd semantics (plugin's node field)

### get_logs Availability

Changed from `"both"` to `"external"` — agents don't need to read other tasks' JSONL. get_logs is for external MCP clients (send → yield → get_logs workflow).

### Key Details (formerly "Daemon / Runtime / Plugin Split")


```
daemon.ts (meta-daemon shell):
  - HTTP server (:7433, port from config)
  - Auth middleware (shell-level, before worker forwarding)
  - Plugin discovery (scans projects for .mxd/plugin/index.ts)
  - Worker management (start/stop scope workers)
  - SSE relay (worker events → browser)
  - Global config CRUD
  - /plugins endpoint (registered plugins)

runtime.ts (worker code, was daemon.ts):
  - createApp() — full Hono app + RuntimeContext
  - All agent lifecycle, tools, providers
  - Routes run inside worker, HTTP forwarded from shell
  - Production entry point (cli.ts points here until shell is ready)

src/runtime/ (was src/daemon/):
  - context.ts — RuntimeContext (was DaemonContext)
  - agent-lifecycle.ts, event-system.ts, helpers.ts
  - routes/ — Hono route handlers (run in worker)
  - scope-worker.ts — Worker entry point
```

### Worker Communication

- Shell → Worker: HTTP request serialized via postMessage → Worker's Hono app.fetch() → response back
- Worker → Shell: `ctx.onBroadcast` hook → postMessage sse_event → shell relays to SSE clients
- Shell handles: auth, global config, SSE connections, plugin discovery
- Worker handles: everything else (routes, agent loop, tools, events, JSONL)

### Plugin System

`src/plugin.ts` defines `PluginManifest`:
```ts
interface PluginManifest {
  name: string;
  scope: "global" | "project";
  web?: string;           // React component path
  runtime?: string;       // ScopeOpts builder path
  onProjectInit?: (path, { isNew }) => Promise<void>;
}
```

Matrix plugin at `.mxd/plugin/index.ts`: `{ name: "matrix", scope: "global" }`. Not special-cased — discovered through same scanning mechanism as any plugin.

### File Ownership

```
.mxd/
  config.json        ← daemon (project config)
  plugin/            ← daemon reads for discovery
    index.ts         ← plugin manifest
    runtime.ts       ← plugin ScopeOpts (worker)
    web/             ← plugin React components (shell imports)
  hooks/             ← matrix plugin runtime
  memory.md          ← matrix plugin runtime
  tree.json          ← matrix plugin runtime
```

### Addressing: `<scope>:<project>`

- `matrix:story1001` = story1001 in dev mode (matrix worker handles it)
- `story1001:story1001` = story1001 in product mode (story1001 worker)
- Inside worker: scope is implicit (worker IS the scope), just `projectId`
- Cross-scope: worker can't handle → escalates to shell → shell routes to correct worker

### Shell Web UI

`web/` = daemon shell React app (auth + project/scope selector). Plugin UI loaded as dynamic React component import (not iframe): `React.lazy(() => import(pluginWebPath))`.

### ProjectStore (worker's read-only project registry)

`ProjectStore` replaces `ProjectManager` in worker/runtime. Pure in-memory, sync-only:
- `sync(projects)` — daemon pushes full project list
- `get(id)` / `list()` / `has(id)` — read-only lookups
- No disk access, no CRUD methods
- `createApp({ projects })` — injects project list at construction

`ProjectManager` remains in daemon only — it owns disk persistence + CRUD.

### Test pattern for projects

```ts
// Runtime tests: inject projects directly (no HTTP)
const app = createApp({ dataDir, projects: [{ id, name, path }] });

// Daemon tests: full pipeline
const daemon = await createDaemon({ dataDir });
await daemon.fetch(new Request("/projects", { method: "POST", body: ... }));
```

Tests needing git worktrees use `initTestProject(path)` helper (creates git repo + .mxd/ structure).

### Current State (half-state)

Production: daemon.ts is entry point (cli.ts → daemon.ts). Daemon starts worker per global plugin.

### Key Invariants
- Shell/src → ZERO imports from `.mxd/plugin/` (delete plugin → still compiles)
- Plugin web → ZERO imports from `../../../src/` (plugin is independent repo)
- Plugin web imports via `@mxd/auth-context`, `@mxd/types` (importmap shared modules)
- Runtime throws if `buildScopeOpts` not provided
- Tests use `createMatrixApp` (auto-injects Matrix scope opts)

