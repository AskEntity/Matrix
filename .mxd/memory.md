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

---
# Core Mechanisms
---

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

## Auto-Launch Failure = task_complete(failed)

`deliverMessage` auto-launches a pending child via `ensureChildAgentRunning`. When `beforeChildLaunch` throws (e.g., missing hook file, worktree creation fails), the sender's yield would have hung forever — target never ran, so no done() ever fires, so no task_complete ever delivered.

Launch failure IS task completion: failed before starting. The catch in `deliverMessage` (agent-lifecycle.ts ~580) handles this by reusing the existing task_complete channel — same semantic as `done("failed")`:
1. emit error event on target (activity log)
2. `tracker.updateStatus(nodeId, "failed")` + save + broadcast (UI red)
3. `deliverMessage(taskAbove, createTaskComplete(nodeId, title, false, errorMsg))`

Sender's yield wakes with `<task_complete status="failed" summary="Auto-launch failed: ...">` — handled by existing yield-resume flow, no new code paths. **Root launch failure is not handled** — root has no `taskAbove`; separate concern.

Design rule: any code path that could silently hang a yielding parent MUST notify via task_complete. The channel is reusable because "failed before starting" and "failed during work" look identical from the sender's perspective.

## JSONL Repair

`buildSessionRepair()` in events.ts handles all repair:
- **Orphan only** (tool_call without result): append interrupted results, no truncation
- **Duplicate results** (>1 result for same tool_call): truncate from first duplicate + status message
- `EventStore.truncateAfterLine(sessionId, lineIndex)`: rewrites file keeping lines 0..lineIndex
- Repair runs in runAgentForNode before provider loop starts

## enqueue === persist (single JSONL write path)

`MessageQueue.enqueue(msg)` synchronously calls `onPersist(msg)` before delivery. ONE way queue messages reach JSONL.
- `replay: true` — skip onPersist (already in JSONL). `quiet: true` — suppress wake, NOT persistence.
- **traceId**: has traceId = produced by agent loop run. No traceId = external to any run.
- **Pitfall**: `createApp()` does NOT call `autoResumeProjects()`. Tests must call it explicitly.

## buildSessionRepair Scope Boundary

Repairs: orphan tool_call → synthetic result, duplicate tool_result → truncate, out-of-order → truncate. Does NOT repair orphan tool_result — can't be produced by runtime, masking hides bugs.

## JSONL Lifecycle Refactor

- Message `header` deleted → `work_context` QueueMessage source instead
- `compact_marker` is empty boundary. `agent_start`/`agent_end` replace old lifecycle events.
- **JSONL sequence**: `session_config → work_context → trigger → messages_consumed → ...`
- **Critical lesson**: "delete until ONE remains" ≠ "merge into one place". Keep emit positions, just rename.

## EventSpec Type

`EventSpec = DistributiveOmit<Event, "taskId">`. Single emit path: `R.emit(projectId, taskId, spec)`.

---
# Cache & Drift Prevention
---

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

## 70K Post-Restart Cache Miss (RESOLVED — correct diagnosis 2026-04-16, bit-exact proof)

Caused by **Anthropic occasionally routing our OAuth traffic to what was then the unreleased Opus 4.7 tokenizer/model**. NOT a Matrix bug. The previous hypothesis ("server-side system prompt injection") was wrong — corrected via bit-exact replay experiment.

**Proof method** (task 01KPC6VS500NNABTTC5606A8P9):
1. Reset worktree to commit 8e49c1a (2026-04-04, the commit running when miss was observed)
2. Captured two JSONL states around the transition: reqA at ts=1775332443540 (20:54:03 PT, 220,712 tokens observed), reqB at ts=1775333012661 (21:03:32 PT, 284,800 tokens observed, 0 cache_read)
3. Added `MXD_CAPTURE_BODY` env hook to intercept `client.messages.stream` → save request body to file
4. Added `MXD_REPLAY_DATA_DIR` + `MXD_REPLAY_PORT` to run April-4 daemon against replay JSONL
5. Daemon's own buildSessionRepair + walker + adapter.callAPI produced bit-identical request bodies to what was sent April 4
6. Called today's count_tokens API with those captured bodies

**Results — bit-exact match**:
| Body | Model | Historical | Today | Match |
|------|-------|------------|-------|-------|
| reqA | opus-4-6 | 220,712 | 220,712 | **bit-exact** |
| reqB | opus-4-7 | 284,800 | 284,800 | **bit-exact** |

Cross-validation (same body, two tokenizers today): reqA on 4.6 = 220,712, reqA on 4.7 = 284,471. Pure tokenizer ratio = 1.2889x = **+28.9%** on identical content.

**What this proves**: Two different tokenizers were used on the same session 9 minutes apart:
- 20:54:03 PT: tokenizer matches today's opus-4-6 output exactly → 220,712
- 21:03:32 PT (9m 29s later, same session, ~1K new events): tokenizer matches today's opus-4-7 output exactly → 284,800
- `response.model` continued reporting "claude-opus-4-6" — the swap was client-invisible

Since tokenizers are typically bound to model weights (embedding layer dimensions match vocabulary), this strongly suggests the underlying model was swapped to opus-4-7 during that window. Other interpretations are possible (e.g., preprocessor-only swap) but less likely. Bottom line: **we suspect we were hot-routed to opus-4-7 while declaring opus-4-6**.

Opus 4.7 GA was 2026-04-16 — **12 days AFTER our observation**. During that period, Anthropic occasionally routed our requests to opus-4-7 while we declared model="claude-opus-4-6". Routing was sporadic (per-account, per-session) and generally undetectable client-side — the only reliable signal is a cache-miss event where the tokenizer signature shifts. Billing semantics are unknown.

**Intermediate gotcha**: On first replay attempt, daemon produced 210,197 (not 220,712). Gap = 10,515 tokens = compacted_resume content. Root cause: commit c5722b6 (2026-04-12) changed `type: "compacted_resume"` event shape → `type: "message" + body.source: "compacted_resume"`. Migration rewrote old events. April-4 walker deferred new-format (has `id`, no `messages_consumed`) and dropped the content. Pre-migration backup at `~/.mxd copy/sessions/.../events.jsonl.bak` (2026-04-03 18:48) confirmed old format. Fix: 10-line patch to April-4 walker.

**Lesson**: our JSONL is a log — it survives through format migrations but loses bit-fidelity against the code that wrote it. For reproducibility, preserve pre-migration snapshots when changing persisted event shapes.

**Observable side effects when routed to 4.7**:
- Unexplained cache misses when tokenizer differed between prefix-write and new-call
- ~29% higher input token counts vs 4.6 baseline for same content
- Possibly different response quality/style (not measured — indistinguishable from normal opus-4-6 variance unless compared side-by-side)

**Why this matters**: Silent model routing means `response.model` cannot be trusted as ground truth for which model actually served a request. A client declaring model X may receive model Y's output without any disclosed indicator. Tokenizer ratio is the most reliable post-hoc signal, but only visible at cache-transition moments.

## Pre-API-Call Debug Snapshot (v2: per-traceId epoch)

Layout: `projects/<id>/debug/<taskId>/<traceId>/last.json`. Each `runAgentForNode` gets unique `loopTraceId`. Restart → new dir → old snapshot preserved. `rollOldTraceIdDirs` keeps 10 most recent. Post-mortem: diff two newest traceId dirs' `last.json` files to find drift.

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

---
# Providers & API
---

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

## OpenAI SDK Migration

Both providers use `openai` npm package (v6.34.0). `DebugSnapshot.body` === exact object passed to SDK. `ChatCompletionMessageToolCall` is union — filter `tc.type === "function"`.

## Thinking Block Provider Filtering

Thinking events have `provider?: string`. Switching providers automatically drops stale thinking blocks (provider mismatch → filtered). OpenAI walker ignores thinking entirely.

## Abort Signal + Inner Retry Fix

Inner retry checks `signal.aborted` first + abort-responsive sleep. Reset time: 30s → instant.

---
# Data Model & Storage
---

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

Per-project information lives in two places with different roles.

**`<repo>/.mxd/`** — tracked in the project repo. Things the project's source owns:
- `config.json` — repo-scope config (see three-layer config below)
- `plugin/` — optional; present only if this project ships a Matrix plugin
- `memory.md` — the project's durable memory

**`~/.mxd/`** — daemon runtime state on this machine, never in git:
- top-level: global-scope config + runtime artifacts (auth, lock file, web build cache, project registry)
- `projects/<projectId>/`:
  - `config.json` — local-scope config override
  - `tree.json` — the project's task tree with all tasks. **Deliberately NOT in the repo** because the tree mutates constantly; committing would pollute history.
  - `tasks/<taskId>.jsonl` — one file per task session; the complete agent conversation as JSONL.

Three-layer config (merged at runtime, later overrides earlier): global `~/.mxd/config.json` < repo `<repo>/.mxd/config.json` < local `~/.mxd/projects/<id>/config.json`.

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

Third event consumer (alongside JSONL + SSE): `subscribeToEvents(ctx, projectId, callback)`. Per-project keyed Map. Used by yield_external, test helpers. Throwing subscribers caught + logged.

---
# Auth & External API
---

## Stateless HTTP MCP Endpoint

POST `/mcp` — MCP Streamable HTTP transport for external clients. Stateless: no attach_to, no session state. 6 tools: list_projects, get_tree, get_task, get_logs (both), send_user_message, yield_external (external-only). ToolDef `availability: "internal" | "external" | "both"` on every tool. Workflow: send_user_message → yield_external → get_logs.

## Anti-pattern: Conflating Attached-Observer with Peer-Project

**Lesson**: Layer 1 (attached external client, asymmetric) and Layer 2 (peer project, symmetric) are different relationships. Same wire format ≠ same semantic. Check symmetry before unifying.

## Auth

Challenge-response with browser keypair (RSA-OAEP 2048). CLI `mxd auth <public_key>` → encrypted JWT → paste to browser. CLI auto-auth via `signCLIToken()`.

## Auth/Resource Split

- `tool-auth.ts`: Auth opaque type. `checkPermission(auth, mode, resource)`. Modes: project, exact, subtree, family, root, human.
- `resource-registry.ts`: Global handle-based functions (`R.getTracker`, `R.emit`, etc.). No closures.
- `tool-def.ts`: ParamDecl with `bind`. Handler signature: `handler(args, auth, toolCallId)`.
- All 32 tools use ToolDef + auth + global functions. Zero closure-based handlers.

## AuthGroup Discriminated Union

`AuthGroup = AnthropicAuthGroup | OpenAIAuthGroup` — discriminated on `provider`. `systemPreamble?: string` on Anthropic. System blocks always `ttl: "1h"`.

## ParamDecl Bind

All bind params hidden from agent, auto-bound. `create_task`/`create_folder` parentId is `explicit`.

## DEFAULT_CONFIG Immutability

`Object.freeze`d at module load. `createApp()` defensive-clones. PATCH never mutates. **Lesson**: module-level constants MUST be frozen.

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

---
# Testing
---

## Integration Test Framework

**This is the strongest verification framework in this codebase. Use it any time you make a claim about agent-observable behavior.**

**Policy — MUST use integration tests when**:
- A prompt, tool description, or user-facing string promises a specific shape ("output is bounded ~10KB", "stdout and stderr are labeled separately", "the file path appears at top and bottom", etc.)
- A change affects what the LLM sees in a tool_result, system prompt, or message
- A behavior crosses the agent-loop / tool-execution / JSONL / mock-reply boundary

Unit tests verify internal logic (a formatter function returns X). Integration tests verify **what the LLM actually observes when driving the full stack**. Those are different contracts. A formatter unit test doesn't prove the LLM sees the promised shape through MCP wrapping + tool_result persistence + mock-reply path — the gap between them is where prompt/code drift silently lies. The LLM then builds strategy on a lie, and no unit test catches it.

When a prompt says "X", there MUST be a test that:
1. Constructs a mock instruction / real tool invocation trigger
2. Runs the full agent loop with `ValidatingMockAPI`
3. Observes the tool_result the mock receives
4. Asserts the observed content matches the X claim literally

Drift between prompt claims and tool reality is a **silent failure mode**. Integration tests are the only guard against it.

**Framework components**:
- `ValidatingMockAPI`: instruction-driven mock, sessionId-based conversation keying, prefix validation, field validation, **strict tool-error mode**.
- Mock DSL: `{"blocks": [...]}` or `{"turns": [...]}` with assert/capture.
- `recreateApp()` simulates daemon restarts. `readSessionEvents` flushes EventStore before reading.
- ~1976 tests (unit + integration). 4 skipped (E2E).

## Merge review discipline — hook-pass ≠ reviewed

**"Pre-commit hook passed + tests green" is necessary but NOT sufficient for merging.** Hook verifies syntax, types, test-pass count. It does NOT verify:
- Is the diff addressing every point in the task description?
- Are layer boundaries respected (no matrix-specific code leaking into daemon/shell)?
- Does the commit message match what the code actually does?
- Are edge cases the task called out actually handled?
- Does the child's self-report align with the diff's actual content?

**Required before every merge** (this session burned multiple times on skipping):
1. `git diff main...<branch>` — read every line of diff, not just stat
2. Cross-check against task description — did the child address the stated scope?
3. Verify layer discipline — for each file changed, is this the right layer?
4. Look for `autoRegisterSelf: false`-style catastrophic single-line oversights
5. Flag anything ambiguous BEFORE pressing merge

**Observed failure pattern** (session 2026-04-18):
- Child done → run `git log --oneline` + `git diff --stat` → directly `git merge`
- Skipped: actual diff content review
- Result: multiple post-merge bugs that manual smoke caught (`autoRegisterSelf: false` in prod entry; layer violations in production-mode placement)

**The anti-pattern**: trusting the child's summary as review. Child reports what they THINK they did; diff shows what they ACTUALLY did. These differ non-trivially.

**Hook passing tempts you to skip review because it feels green.** Resist — hook is a floor, not a ceiling. For 400+ line architecture refactors, the user themselves wouldn't dare merge without reading the diff; orchestrator definitely can't.

## Canonical user journey test is MANDATORY

If the feature's name or description describes a user action — "fresh-install bootstrap", "sidebar toggle on desktop", "auto-save preserves output", "production mode blocks agent" — there MUST be a test that **performs that exact user action and asserts the user-observable result**. Testing subcomponents, supporting algorithms, and edge cases does not substitute.

The canonical user path IS the feature; everything else is scaffolding around it.

**Diagnostic**: open your test file. Is there a test whose whole shape is "do user-action X, observe X works for the user"? If no, the feature is untested — even if thousands of other tests pass.

**Typical silent failures** (tests green, production fails):
- **Test config ≠ production config.** Test calls `createDaemon({ installRoot: fake })` directly; production path is `import.meta.main` with different flags. Only one path tested.
- **Subcomponents tested individually, not the chain.** `findProjectRoot` ✓, `onProjectInit` ✓, `markProduction` ✓ — but no test that starts a real daemon and watches the whole flow run.
- **Partial-chain assertion.** "Marker written ✓" — and done. But GET /projects response, UI reading the flag, backend guarding agent ops — all unverified. The chain breaks after the first green check and no test looks.
- **Mocks matching the test, not reality.** Mock `onBroadcast` as in-process no-op; production goes through postMessage. Structural differences at process boundaries never exercised.

**Minimum bar for "feature works"**:
1. Real process boundary: if the feature is about daemon behavior, spawn a real daemon (`Bun.spawn(["bun", "src/daemon.ts"], { env: { MXD_DATA_DIR: fakeDataDir, ... } })`) and HTTP-call it.
2. Manual smoke: before calling `done("passed")`, run the canonical user journey by hand. If you can't describe the concrete steps you took and what you observed, you haven't verified the feature.
3. All observable consequences: if the feature involves UI, test UI (happy-dom render + assertion). If it involves backend guards, test the guard fires with a 403. If it involves marker files, test the marker affects all downstream consumers.

**The rule of thumb**: "2003 tests pass" is not a merge gate. "I ran the feature the way a user would and it worked" is.

## Test harness: broadcast payload cloneability (structuredClone wrapper)

`createMatrixApp` (src/test-utils/create-matrix-app.ts) wraps `ctx.onBroadcast` with a `structuredClone({projectId, event})` call. Every broadcast payload MUST be structured-clone compatible — production's postMessage boundary (worker → shell) will reject anything else.

**Why this exists**: FU8 deleted a triple-JSON-serialize step that was silently dropping non-cloneable fields (functions, `AbortController`, live class instances). `broadcastTreeUpdate` had relied on that accidental sanitization to pass `tracker.allNodes()` with live `TaskSession` attached. Post-FU8, production threw `DataCloneError` on every tree mutation. No integration test caught it because none of them exercise `structuredClone`.

**Invariant**: every broadcast site MUST either construct a plain object, or explicitly strip runtime-only fields. `broadcastTreeUpdate` now runs `.map((n) => isFolder(n) ? n : stripSession(n))`. If you add a new broadcast site and pass live objects through, the harness fails the first test with `DataCloneError: The object can not be cloned`.

**Regression test**: `src/broadcast-strip-session.test.ts` pins the positive invariant (fix works) and the mutation-proof (unstripped broadcast throws). Removing the `.map(...stripSession)` in event-system.ts makes both the unit test AND every integration test that creates a task fail loudly.

## Test harness: strict tool-error mode

`ValidatingMockAPI.enableStrictToolErrors(allowlist?)` — when enabled, any `is_error: true` tool_result that reaches the mock throws `MockValidationError("Unsurfaced tool error: ...")`. That propagates back through `client.messages.stream` and surfaces as a test failure. Default-off to keep individual tests opt-in.

**Three ways a test opts a specific error out**:
1. **Turn assert with `isError: true`** — if a turn's `assert` array has `{ block: N, type: "tool_result", isError: true }`, block N is pre-acknowledged. Tests that already express intent through asserts get strict coverage for free.
2. **Global allowlist entry** — pass `[{ tool: "mcp__mxd__bash", contains: "..." }]` to `enableStrictToolErrors`. Tool + contains are ANDed; omit either to match any.
3. **Per-test disable** — `mockAPI.disableStrictToolErrors()` inside an individual test. Used by drift-test scenarios that intentionally invoke error tools (bash with nonexistent command, read_file on missing path) to exercise `is_error` round-trip through JSONL. Strict mode is orthogonal to what those tests assert.

**Default allowlist** (`ValidatingMockAPI.DEFAULT_ERROR_ALLOWLIST`): `{ contains: "Tool execution was interrupted by daemon restart" }` — covers the `buildSessionRepair` synthetic tool_result for orphaned tool_calls on restart. This is a system contract, not a bug. Restart tests legitimately trigger it.

Called with no argument → uses defaults. Called with explicit array → no defaults merged; caller takes full control.

**Where enabled** (2026-04-17 rollout):
- `setupTestContext` in `src/integration.test.ts`
- `setupEmissionTestContext` in `src/test-utils/emission-harness.ts`
- Every drift test's local mock construction: `drift-lifecycle`, `drift-initial-drain`, `drift-message-sources`, `drift-thinking`, `drift-tool-lifecycle`
- `integration-stress`, `invariant`, `debug-snapshot-integration`, `plugin-hooks`, `plugin-custom-scope`

**Not enabled** (yet): `openai-responses-integration.test.ts` — uses a separate `ValidatingMockResponsesAPI` class that doesn't have strict-mode wired in. Follow-up.

**Motivation**: the stripSession regression caused every `create_task`/`update_task`/`delete_task`/etc. to return `is_error: true` to the agent. Dozens of tests hit those tools; none failed because nothing asserted the error state. Strict mode + structuredClone wrapper now cover that class of bug from two independent angles.

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

---
# Reference & Pitfalls
---

## System Prompt

**7 chapters + Staying Alive + Closing** (v2, rewritten for 4.7-era calibration). Core framings:
- Three engagement modes (§3 Dialogue): Upward / User / Autonomous — decision authority varies, reporting threshold constant
- Silent deliberation named as canonical failure mode + self-check ("if the person above you would only learn what you decided by reading your thinking...")
- Tests as **current** truth (§5): Intent → Tests → Arch hierarchy; task is certificate of intent change; "absent a task certifying intent change, tests ARE the intent"
- Memory as calling convention (§6): callee-saved inheritance
- "fork" is the only allowed parent/child context; everywhere else positional (task above / sub task / ancestor)

### Authorship rule — what goes in prompt vs memory

System prompt is **universal** across all matrix projects. Each project has its own `memory.md`. Agents in OTHER matrix projects see: shared system prompt + THEIR memory.md. They do NOT see our memory.md, and they do NOT need Matrix's implementation details.

- **System prompt content**: principles, roles, tool semantics, communication patterns, task lifecycle, craft — things that apply to ANY project using Matrix.
- **memory.md content**: matrix-internal implementation details, project-specific architecture, pitfalls, design decisions — things meaningful only within THIS project.

**The one matrix-internal detail system prompt IS allowed to expose**: the file path where pre-compaction events are preserved. Agents must be able to retrieve lost context after compaction; without the path, a compacted agent has no way to read their own history. Everything else matrix-internal goes to memory.md.

### Pitfall: "avoid internal" ≠ "delete the concept"

Common AI misunderstanding when cleaning prompts: told "avoid matrix-internal", agents DELETE the whole concept. Wrong. "Avoid internal" means **strip implementation-specific words, keep the agent-experience concept**. Example: the §6 Session history section — don't delete the memory/compaction block; rewrite without `JSONL` / `checkpoint` / type names, but keep the file path agents operationally need. Preserve what agents experience; remove what only implementers reason about.

### Editing discipline

- Read the full prompt before editing. Prompt is for ALL Matrix users, not our project notebook.
- Matrix-specific rules → memory.md (this file), not prompt.
- Principle over rule: 4.7 generalizes from framings better than from rule lists. Prefer "tests are our current truth" (principle that generates behavior) over "don't contort arch for old tests" (rule specifying one behavior). Keep explicit rules only when they protect a product property (e.g., git worktree invariants) — those stay as-is.

## evaluate_script Discipline

Runtime debug introspection ONLY. Do NOT use to: reparent tasks, modify tree structure, batch operations. Fix the tool instead.

## Refactoring Philosophy

Embrace large type refactors. Delete first, let compiler show every dependency. Hundreds of errors = your todo list. Static type systems make large changes SAFE.

## Default Branch

Root node stores branch at init. `baseBranch` required on worktree create (no fallback). Child worktrees branch from parent's branch.

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
- **TS6133 `_` prefix**: TypeScript's `noUnusedLocals` does NOT respect `_` prefix for local variables or destructured locals — only for function parameters. For unused destructured React state, use `const [, setX] = useState(...)` (skip the getter slot). For unused `const` locals, delete outright. The underscore-prefix hint in our prompts is a holdover that doesn't match TypeScript's actual behavior.
- **`bun run check` auto-writes**: `bun run check` runs `biome check --write` and silently formats 70+ files. `bun run check:ci` is the non-write variant used by the pre-commit hook. When debugging lint, use `check:ci`. When committing formatting sweeps, use `check` and split format-only changes into a separate commit.
- **Pre-commit hook disabled in worktrees**: `config.worktree` sets `core.hooksPath = /dev/null` in every worktree, so `git commit` in a sub-task skips the hook entirely. To verify the hook passes, run `bash /path/to/main/.hooks/pre-commit` manually. Only root-orchestrator commits on `main` are actually gated.

## Known Bugs (unfixed)

- Manual compaction during yield → consecutive user messages → API 400.

## Vertical Dependency Boundaries

Three layers: daemon → provider loop → tool handler. executeTool is clean (pure dispatch). done() closes queue through closure (boundary violation, but structural). evaluate_script punctures all layers (intentional). TaskSession has three-way mutation. Full audit in `VERTICAL-BOUNDARY-AUDIT.md`.

## Unresolved Design (prioritized)

1. Message routing expansion (subtree + parent chain, not just direct parent/child)
2. Folder/grouping feature (UI-only visual grouping, not tree structure)
3. Tool search — dynamic tool discovery (draft exists, Anthropic has server-side `defer_loading` but user prefers client-side)

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

Runtime uses `BaseTaskNode` (id, parentId, children, title, session). Matrix extends: `TaskNode extends BaseTaskNode` adds status, description, branch, worktreePath, cwd, color, costUsd, budgetUsd. `PluginTypes { node; done }` generic flows through all `ScopeOpts<T>` hooks — type-safe per plugin. `MatrixPluginTypes` binds `node: TaskNode, done: MatrixDoneData`.

### cwd / AgentRequest

- `node.cwd` is source of truth (persistent, survives restart). Bash `cd` updates it directly. Tools read via `getTaskCwd()` (node.cwd → node.worktreePath fallback).
- `AgentRequest.buildSystemPrompt: () => SystemPrompt` — single entry point; provider loop owns resume-vs-refresh internally.

### get_logs Availability

Changed from `"both"` to `"external"` — agents don't need to read other tasks' JSONL. get_logs is for external MCP clients (send → yield → get_logs workflow).

### Worker Communication

- Shell → Worker: HTTP request serialized via postMessage → worker's Hono app.fetch() → response back. `text/event-stream` detected; chunks stream via postMessage.
- Worker → Shell: `ctx.onBroadcast` hook → postMessage sse_event → shell relays to SSE clients.
- Shell owns: auth, global config, SSE connections, plugin discovery, web build, `/plugin-assets/<pluginName>/` asset serving.
- Worker owns: routes, agent loop, tools, events, JSONL, per-project tracker.

### Plugin Manifest

`PluginManifest` (src/plugin.ts): `{ name, scope: "global" | "project", web?, runtime?, onProjectInit? }`. Matrix plugin at `.mxd/plugin/index.ts` with `{ name: "matrix", scope: "global" }` — not special-cased; discovered through the same scan as any plugin.

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
- Cross-scope: worker escalates to shell → shell routes to correct worker

### ProjectStore

Worker's read-only project registry. `sync(projects)` from daemon; `get`/`list`/`has` read-only. No disk access, no CRUD. `createApp({ projects })` injects at construction. `ProjectManager` (daemon-only) owns disk persistence + CRUD.

### Test patterns

- Runtime tests: `createApp({ dataDir, projects: [...] })` — inject directly, no HTTP.
- Daemon tests: `createDaemon({ dataDir })` + `daemon.fetch(new Request("/projects", { method: "POST", body: ... }))`.
- Tests needing git worktrees: `initTestProject(path)` helper.
- Matrix scope auto-injected via `createMatrixApp` (test-utils).

### Key Invariants
- Shell/src → ZERO imports from `.mxd/plugin/` (delete plugin → shell still compiles)
- Plugin web → ZERO imports from `../../../src/` (plugin is independent)
- Plugin web imports via `@mxd/auth-context`, `@mxd/types` (importmap shared modules)
- Runtime throws if `buildScopeOpts` not provided (no silent fallback)
- Shell web UI (`web/`) is auth + project/scope selector. Plugin UI via `React.lazy(() => import(pluginWebPath))` (not iframe).

## Audit FU8 Dead-Code Sweep (2026-04-17)

Consolidated cleanup of items flagged by the 12-audit review:

- **Shared `src/version.ts`** for VERSION + GIT_HASH — was duplicated in daemon.ts + runtime.ts.
- **Worker-side SSE ring buffer deleted** — daemon owns SSE (seqId, buffer, fanout). Worker just calls `onBroadcast`; daemon serializes + fans out. Removes triple-JSON-serialize path.
- **`ctx.sseClients` removed from RuntimeContext** — worker never had SSE clients attached.
- **`persistent-queue.ts` deleted** — dead code that bypassed the unified `projects/<id>/` storage layout.
- **`scope: "project"` union variant dropped** from PluginManifest (only "global" is implemented). Re-introduce via task when a real per-project plugin appears.
- **`family` PermissionMode dropped** (zero call sites). `send_message` still walks parent/child manually; when we finally apply a shared mode there, re-introduce.
- **`@mxd/types` is now the plugin's single source** of TaskNode / FolderNode / TreeNode / TaskStatus / isFolder / isTask — `.mxd/plugin/web/types.ts` re-exports from it instead of redeclaring. `src/types.ts` is the one truth.
- **Shell icon set reduced** from 19 to 7 in `web/icons.tsx`. `web/components/icons.tsx` (381 lines duplicated from plugin) deleted.
- **`DaemonConfig` renamed to `RuntimeConfig`** in `runtime/context.ts` — the type configures the worker runtime, not the daemon. Old name re-exported from `runtime.ts` as a type alias for back-compat.
- **`SystemPrompt` type moved** to `runtime/context.ts` (plugin-agnostic); `system-prompts.ts` re-exports for back-compat.
- **ShellApp tests made hermetic** — no more `resolve(".")` (CWD-dependent). Tests derive matrix-repo path from `import.meta.url`.
- **`_isYield` field removed** from yield prefab — yield detection is by name.
- **`buildMatrixScopeOpts` fallback dropped** from scope-worker — plugin contract is `buildScopeOpts` or `default`.
- **`worker-api.ts` reduced** to `SyncMap` + `SyncMessage` (everything else was declared-and-never-imported).
- **JSDoc cleanups**: orphan comments on ScopeOpts/BaseDoneData, duplicate JSDoc on computeDepth + RunAgentOpts, "extracted for plugin reuse" that was never exported, `stripEventForUI` transitional-fix note.

Net: ~880 lines deleted, 0 test failures, no functional behavior change.

### dataRoot Hardening (Audit FU5)

**One resolver, `src/data-paths.ts`**, owns every path built from `dataRoot`. Never compute `dataRoot.slice(2)` anywhere else — the grep test in `data-paths.test.ts` fails if a second site appears. `projectTasksDir`, `projectDebugDir`, `getTracker`, and `agent-lifecycle`'s debug snapshot all route through `resolveDataRoot(dataDir, projectId, dataRoot?)`.

**Three lines of defence**:
1. Strict regex at input boundary — `DATA_ROOT_PATTERN = /^@(\/[A-Za-z0-9_-]+)*$/`, `PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]+$/`. Run at daemon startup (`validatePluginManifest`) and at every `resolveDataRoot` call.
2. ONE resolver — any traversal must pass regex AND the post-resolve invariant.
3. Post-resolve invariant — `resolved.startsWith(projectRoot)` check inside `resolveDataRoot`. Belt to the regex's braces. If someone ever relaxes the regex, this still rejects traversal.

**Before**: `resolveDataRoot("@/../etc")` returned `dataDir/etc` — cross-plugin attack (reported: Audit H F1, Audit C H4). Four inline `.slice(2)` sites meant every fix had to touch four files.

**Malformed manifest is fatal at startup**, not a warning. `src/daemon.ts` separates import errors (recoverable, skip plugin) from validation errors (unrecoverable, throw). A malicious plugin with `dataRoot: "@/../etc"` cannot be silently skipped while its legitimate siblings run.

**Lazy dir creation respects dataRoot**. `daemon.ts`, `project-manager.ts`, `runtime.ts` used to eagerly `mkdir projects/<id>/tasks` + `projects/<id>/debug` — hardcoded Matrix's `@` layout. Deleted. `EventStore` constructor and `TaskTracker.save` mkdir on first write, at the owning plugin's dataRoot. For Matrix this is a no-op behavior change; for any plugin with `dataRoot !== "@"` it moves the dirs to the right place.

**Why path-based collision check still runs after validation**: validation alone catches `"@/foo/.."` (regex rejects). Defence in depth — `checkDataRootCollisions` also resolves both roots against a canonical `dataDir`/`projectId` and compares paths. If anyone ever relaxes the regex, the collision check still catches structural duplicates.

**Key files**:
- `src/data-paths.ts` — single source of truth (validators + resolver + task/debug dirs).
- `src/plugin.ts` — imports validators from data-paths.ts; delegates path resolution; keeps `effectiveDataRoot` (normalizes defaults) + `checkDataRootCollisions`.
- `src/runtime/helpers.ts` — re-exports `projectTasksDir`/`projectDebugDir` from data-paths.ts for existing callers (convenience barrel).
- `src/runtime/agent-lifecycle.ts:~984` — passes `ctx.config.dataRoot` to `projectDebugDir` (was missing, debug snapshots landed at Matrix's path regardless of plugin).

## Auth Hardening (Audit FU4)

### Defaults that close the "LAN-open window"
- Fresh daemon auto-initializes `auth.json` with `jwtSecret` + `secretVersion=1`
  during `createDaemon`. Production callers get this by default; tests opt out
  via `createDaemon({ autoInitAuth: false })`.
- Production entry binds `127.0.0.1` unless `MXD_BIND_HOST` is set. Previous
  default `*:7433` was LAN-reachable during the bootstrap window.

### JWT claims
- `sub: "cli" | "session" | "stream"`. `/events` accepts only `stream`;
  REST accepts only `cli`/`session`. Subject restriction lives in
  `verifyJWT(authPath, token, allowedSubjects)`.
- `sv`: secretVersion. `bumpSecretVersion` (POST /auth/logout) rotates it,
  invalidating every outstanding token. Legacy `sv`-less tokens always fail.
- Session 30d, CLI 5min, stream 5min.

### No auth cache
Prior `authDataCache` caused "user ran `mxd auth` but running daemon
never re-read auth.json" (Audit L H3). Cache removed; `readAuthData`
reads from disk on every call (local JSON, cost negligible).
`resetAuthDataCache()` kept as deprecated no-op for test compat.

### SSE stream tokens (Audit G M1 + M4)
- Frontend calls `POST /auth/stream-token` (Authorization: Bearer session)
  before every EventSource (re)connect → 5min stream token in `?token=`.
- Heartbeat re-verifies the token; on expire/revoke, emits named event
  `auth_expired` and closes the stream. Watchdog in `useSSE` bumps
  reconnectKey → re-fetch stream token → fresh EventSource.
- Long-lived session token never appears in URL / proxy logs / history.

### Auth middleware exact-skip
Skip set: `{ "/", "/auth/status", "/auth/logout" }` + static `/vendor/`
`/app/` prefixes. Previously `startsWith("/auth/")` would silently allow
any future `/auth/*` worker route past the middleware (Audit J H1).
Regression guard: `GET /auth/bogus` with auth enabled → 401.

### Case-insensitive Bearer
`extractBearerToken` uses `/^Bearer[ \t]+(.+)$/i`. RFC 7235 mandates
case-insensitive scheme. `bearer`, `BeArEr`, `Bearer` all accepted.

### API-key masking
- `maskConfig(config)` replaces every `authGroups.*.{apiKey, oauthToken,
  accessToken, refreshToken}` with `prefix…last4`. Applied on:
  GET /config/global, GET /projects/:id/config/all (global + resolved),
  PATCH /config/global response.
- `mergeAuthGroups` on PATCH preserves plaintext when client echoes a
  masked value (UI didn't touch the field). Keeps the "save entire
  authGroups object" pattern safe.

### Destructive-tool permission (Audit G H1)
`orchestrator-tools.ts` helper `requireSubtreePermission(auth, projectId,
nodeId, opName)` applied at handler entry for:
- update_task (ALL mutations, not just reparent)
- close_task, delete_task, reset_task
- create_folder (vs parent), delete_folder, rename_folder (vs owning task)
Folders resolve to nearest task ancestor. reorder_tasks + fork_task_context
had the check already — now consistent across the destructive suite.

### Upstream error classification (Audit L H5)
`classifyUpstreamError(e)` / `formatUpstreamError(e, prefix)` in
`tool-execution.ts`: provider-agnostic mapping of {status, keyword} →
{auth, rate_limit, credits, invalid_request, upstream_down, network,
other} + one-line curated headline. Raw message preserved (trimmed to
300 chars) for debugging. Used by `runAgentForNode` catch + provider
outer-retry emit — users no longer see raw Anthropic JSON blobs.

## Durability at process boundaries (FU2)

Three tightly-coupled durability gaps closed so process exits + stops don't lose data:

### shutdown() + stopAgent loop settlement

- `shutdown()` order: (1) stopAgent on every running project, (2) await residual `ctx.agentLoopPromises` (bounded 1s), (3) `Promise.all(eventStores.map(s => s.flush()))`. Without (3), fire-and-forget `emitEvent` queued in `agent_end`/`done_notified`/tool_results was lost on worker terminate.
- `stopAgent` awaits loop settlement (bounded 1s) — symmetric with stopTask. Closes the race between `POST /projects/:id/stop` returning and the finally block's `agent_end` / Phase 2 `done_notified` / MCP disconnect writes. Fixes DELETE /projects → pm.delete → rm -rf racing with in-flight JSONL writes.
- Both timeouts are defensive: real providers respect abort within ms. A stuck tool (foreground bash ignoring abort) gets bounded grace, then `buildSessionRepair` on next startup synthesizes the interrupted tool_result (orphan-repair contract). **Do NOT call `fg.resolve()` in stopAgent** — that moves bash cleanly to background and breaks the orphan-repair semantic.
- Restart-crash integration tests (Restart B/I/J/K/N, LC3) rely on shutdown leaving foreground-tool orphans for autoResume to repair. 3s timeout was too slow for 5s test timeouts; 1s is the sweet spot.

### Worker init timeout + restart backoff (daemon)

- `WORKER_INIT_TIMEOUT_MS = 30_000` default, override via `createDaemon({ workerInitTimeoutMs })` for tests. Without this, a hung plugin `runtime.ts` (top-level `await new Promise(()=>{})`) hangs daemon boot forever — no log, no 503.
- On timeout: `worker.terminate()` + reject with `"Worker init timed out: <plugin> (>30000ms)"`. Tests use 1.5s override.
- Exponential backoff on crash-restart: `[2, 4, 8, 16, 30]s`, max 5 attempts, then circuit-break (log + SSE `worker_circuit_broken` event). `STABLE_RESET_MS = 60_000` — a worker that's been ready 60s resets its attempt counter. Per-scope state in `workerRestartState: Map<string, {attempts, lastReadyAt, circuitBroken}>`.

### tracker.save() atomic via temp + rename

- Writes `.{basename}.tmp.{pid}.{time}.{rand}` sibling, then `rename` to `tree.json`. POSIX rename is atomic — crash mid-write leaves old `tree.json` intact, not truncated.
- `mkdir` before writeFile stays — removing it broke projects added via `pm.sync` (no pre-existing tasks/ dir).
- **Test gotcha**: temp-file rename races with recursive `rm(dataDir)` during test teardown. The rm lists entries, then rename moves the tmp entry, then rm tries to delete the now-gone tmp → ENOENT. Fix: every test afterEach uses `rm(..., { recursive: true, force: true })`.

### dataDir filesystem lock

- `.mxd.lock` at `<dataDir>/.mxd.lock` — JSON `{pid, startedAt, version}`. Acquired via `O_EXCL` (`openSync(..., 'wx')`). Stale locks (dead PID via `process.kill(pid, 0)`) are stolen; live PID → error "already running on dataDir X (PID Y)".
- `createDaemon({ lockDataDir: true })` — opt-in. Production entry passes `true`; tests pass `false` (concurrent test daemons on isolated tempdirs). Lock released in `shutdown()` AFTER workers are gone.
- **Semantic**: refuses even when the lock holds our own PID. A second `createDaemon` in the same process is a test bug or double-init — better to surface it.

### Test mock abort awareness

- Integration test mocks using `setTimeout(resolve, 10000)` / `5000` now call `abortableSleep(ms, req.signal)` helper in `runtime.test.ts`. Without signal awareness, stopAgent's loop-settlement await would wait the full sleep window. Real providers (Anthropic, OpenAI SDKs) already respect abort; this brings mocks in line.

## bash tool: tiered output + merged streams (FU9)

Defensive-instinct-as-tool-design. AI piped/redirected because context was at risk; now context is bounded by the tool, so the instinct has nothing to act on.

### Tiered display (merged mode, default)
- `<1024 bytes` → inline only, no file saved
- `1024..10240` → full inline + top/bottom banner + file kept at `/tmp/mxd/exec-<id>.out`
- `>10240` → head 5KB + `... [N bytes / M lines truncated] ...` + tail 5KB + banner + read hint; file kept
- Boundary: `head_budget + tail_budget >= total` naturally shows full (no special-case for size===10240)
- Truncation: byte-aware + newline alignment via `Buffer.lastIndexOf(0x0a, budget-1)` / `Buffer.indexOf(0x0a, total-budget)`. No newline in window → hard byte cut + "mid-line cut" annotation.

### Separate mode (opt-in `separate: true`)
Two files: `/tmp/mxd/exec-<id>.stdout` + `.stderr`. Budget allocation in the large case: if one stream is trivial (≤5KB), show it in full and give the other `BUDGET - trivial_size` split head/tail; else each gets 2.5k+2.5k. Continuous at boundary (stderr=5120 → both 5KB; stderr=5121 → stdout 2.5k+2.5k).

### Stream merging
`bash -c "(cmd) 2>&1"` wrapping. AI-written `2>&1` inside `cmd` becomes a harmless redundant no-op. Bash's own stderr (pre-subshell syntax errors, rare) is `stderr: "ignore"` at Bun.spawn level — acceptable tradeoff for clean single-file output.

### Foreground/background parity
One `formatBashResult` function. The `content` field of `background_complete` queue messages is byte-identical to what `parseForegroundResult` returns when the same command runs foreground.

### Directory rename
`/tmp/mxd-bg/` → `/tmp/mxd/`. The dir is no longer bg-specific (foreground commands save there too). `BackgroundProcess.separate: boolean` is the new mode discriminator; `stdoutPath` holds the `.out` file in merged mode (misleading name, kept for API compat).

### Pure-function exports for testing
`formatMergedOutput(path, exitCode)`, `formatSeparateOutput(so, se, exitCode)`, `truncateMiddle(buf, headBudget, tailBudget)`, `allocateSeparateBudget(stdoutSize, stderrSize)` — all exported from `src/tools/bash.ts` so tests hit them directly without spawning subshells.

### Tool description vs system prompt
The "don't pipe" guidance lives in the bash tool's `description` field (`src/tools/definitions.ts`), NOT in `src/system-prompts.ts`. Tool description is per-tool, embedded in API tool schema. system-prompts.ts has one general line about piping during long commands that's still accurate.

### Architectural framing the task demonstrated
When AI repeatedly does X (pipe/redirect/`| head`), ask: is the motivation legitimate? If yes (context protection IS legitimate), make the tool satisfy it naturally — don't enforce against it. Rule suppression leaks at edges; tool-level satisfaction closes the loop. If you find yourself adding parser/rejection/warning to the new tool, you drifted — the point is to make shortcuts unnecessary, not forbidden.

## Plugin URL Namespace `/api/<plugin>/*`

Plugin-owned routes live under `/api/<plugin-name>/*` on the wire. Daemon strips the prefix; worker serves routes as-if-at-root. Shell wraps nothing — explicit URLs over hidden rewrites.

### Single source of truth
`src/plugin.ts → pluginApiPrefix(name)` returns `/api/<name>`. Imported by:
- `src/daemon.ts` — the `/api/:plugin/*` router branch strips this prefix.
- `src/cli.ts` — `MATRIX_API = pluginApiPrefix("matrix")` prepended to every plugin-owned CLI call.
- `.mxd/plugin/web/api.ts` — `PROJECT_PREFIX = \`${pluginApiPrefix("matrix")}/projects\``; every `api.tasks/taskMessage/etc` builder produces namespaced URLs.
- `web/runtime-types.ts` — re-export so plugin web code gets it via the `@mxd/types` importmap alias.

Any format change (`/api/...` → `/v1/plugins/...`) propagates atomically across all four sites.

### Daemon routing (src/daemon.ts)
- `app.all("/api/:plugin/*", ...)` strips the prefix, rebuilds a Request with the rewritten URL + preserved method/headers/body, forwards to that plugin's worker. Unknown plugin → 404, worker missing → 503.
- The old `app.all("*", ...)` catch-all is **removed**. Unprefixed plugin paths (`/projects/:id/tasks` etc.) return 404 — no silent fallback to "first global worker".
- `/version` and `/stats` got explicit daemon-level forwarders (same pattern as `/health?check_model=true`) because they were previously served only via the catch-all.

### Daemon-owned paths (unchanged — stay at root)
Plugin web + CLI call these directly, no prefix:
- `/auth/*`, `/health`, `/version`, `/stats`, `/plugins`, `/global-context`, `/events` (SSE)
- `/projects` (CRUD: list/create/get/patch/delete)
- `/projects/:id` bare (project info)
- `/projects/:id/config*` (three-layer config)
- `/vendor/*`, `/app/*`, `/restart-daemon`

### Plugin-owned paths (go through `/api/matrix/*`)
Everything else under `/projects/:id/` (tasks, agent, events activity log, clarifications, stop, compact, sessions, background, debug) + standalone `/mcp` + `/mock-showcase`.

### Plugin code discipline
Plugin web uses `api.ts` builders for plugin routes — everything funnels through one file, `PROJECT_PREFIX` is the one line to change. Plugin daemon calls stay raw (`authFetch("/auth/stream-token")`, `authFetch("/global-context")`, `authFetch(\`/projects/${id}\`)`) — plugin is explicit about whose route it's calling. No shell wrapper, no pass-through list, no magic.

`/mock-showcase` is a standalone plugin route outside the `/projects` tree — `.mxd/plugin/web/MockShowcase.tsx` inlines `${pluginApiPrefix("matrix")}/mock-showcase` directly.

### External MCP clients
`POST /mcp` moved to `/api/matrix/mcp`. External MCP clients (Claude Desktop, etc.) configured against the old URL break on this change. Intentional — no deprecation alias per design.

### Tests (src/plugin-url-namespace.test.ts)
Covers pluginApiPrefix invariant, every api.ts builder produces the prefix, daemon forwards correctly with body/query preserved, unknown plugin 404, bare-plugin-path 404, daemon routes untouched. Plus daemon-integration.test.ts + daemon-plugin-ui.test.ts were migrated to use namespaced URLs (new plugin name "test-matrix" → `/api/test-matrix/*`).

### Why this shape (over alternatives)
- Not a shell authFetch wrapper: wrapper would need a daemon-route passthrough list → shell couples to daemon's internal routing table. Fragile if daemon adds routes.
- Not plugin-via-props data flow: cleaner long-term but 100+ LOC scope creep across event stream / props plumbing — separate follow-up.
- Explicit URL construction at each layer: plugin author sees exactly what hits the wire; no hidden rewriting; tests assert exact strings.

## auth.json file mode — 0o600 + chmod-on-init

`src/auth.ts:writeAuthData` passes `{mode: 0o600}` to `writeFile`. Legacy files get a one-time upgrade via `ensureSecureFileMode` called at the top of `ensureAuthInitialized` (daemon boot).

**Non-obvious POSIX detail**: Node's `fs.writeFile(path, data, {mode})` only honors `mode` on file CREATION (O_CREAT). Overwriting an existing file preserves whatever mode the inode already has — the `mode` option is silently ignored. This is why two paths are needed:
- `{mode: 0o600}` on writeFile → secures NEW files
- `chmod` on init for loose existing files → one-shot upgrade path

Without the chmod pass, any auth.json created by an older Matrix version stays at 0o644 forever, even after every `bumpSecretVersion` rewrite. `jwtSecret` remains world-readable → any local user can forge CLI/session/stream tokens.

**Chmod mask**: `(mode & 0o077) !== 0` — fires only if any group/other permission bit is set. Deliberately preserves user-hardened 0o400 (read-only) files untouched.

**Tests**: POSIX-only via `describe.skipIf(process.platform === "win32")`. Five tests cover fresh creation, legacy upgrade, mask coverage (0o640/604/660/666), idempotency, and 0o400 preservation. Mutation-tested: removing either the mode option or the chmod pass makes a test fail.

## Audit R7 P1 — critical security hardening (2026-04-18)

Four items landed together. All fixed behaviors the audit verified live in session 01KPFE6HSZ2TWD3G034D5J0BNW.

### P1.1 — `/auth/logout` requires a valid token
- `src/daemon.ts` `SKIP_EXACT`: `/auth/logout` removed. Only `/`, `/auth/status`, `/vendor/`, `/app/` remain anonymous.
- Previous behavior: any drive-by webpage could POST `/auth/logout` and force `bumpSecretVersion`, logging out every active user (CSRF DoS).
- Handler's own JSDoc already documented the intended 401 behavior; code now agrees.
- Regression test: `daemon-auth.test.ts` "POST /auth/logout rejects anonymous callers" — asserts 401 + `secretVersion` unchanged.

### P1.3 — auth-disabled mode removed entirely (user: "never allow auth-disabled")
- `createDaemon({ autoInitAuth })` parameter **deleted**. Every daemon boot unconditionally runs `ensureAuthInitialized`.
- Middleware `if (!hasJwtSecret) skip` branch **deleted**. Anonymous request to a non-skip path is ALWAYS 401.
- `hasJwtSecret` no longer imported in daemon.ts; remains exported for other callers (cli.ts).
- `readAuthData` in `src/auth.ts` throws on parse failure / empty file / read error. ENOENT (first boot) still returns `{}` so `ensureAuthInitialized` can create the file.
- `writeAuthData` now uses **atomic rename**: write to `.auth.json.tmp.<pid>.<ts>.<rand>` → POSIX rename over `auth.json`. Crash mid-write (bumpSecretVersion, ensureAuthInitialized) leaves the original file intact — never a truncated/empty auth.json that would have silently disabled auth pre-P1.3.
- `/auth/status` always reports `enabled: true` (field preserved for backward compat with older browser bundles).
- `/auth/logout` / `/auth/stream-token` handlers dropped their `!hasJwtSecret` no-op branches.
- `/events` heartbeat unconditionally re-verifies the stream token.

### P1.4 — server rejects credential fields on per-project PATCH
- `PATCH /projects/:id/config` and `PATCH /projects/:id/config/repo` return 400 if body contains `authGroups` or `defaultAuth`. Helper: `rejectCredentialFields`.
- Previously only the CLI (`src/cli.ts`) enforced `GLOBAL_ONLY_FIELDS`. A non-friendly HTTP client could PATCH a project's config with their own `authGroups` → next agent run uses attacker's credentials.
- `maskConfig` generalized to `Partial<MatrixConfig>` so all three-layer views (global, repo, local, resolved) mask authGroups uniformly. Defense in depth: even if an attacker writes authGroups directly to on-disk config JSON, GET endpoints mask plaintext.
- `GET /projects/:id/config` now also applies `maskConfig` to the local layer.

### P1.5 — UI logout is a two-step server-side-first sequence
- `web/ShellApp.tsx:handleLogout` is now async: `await authFetch('/auth/logout', {method:'POST'})` → `clearToken()` → reload.
- Server-side `bumpSecretVersion` invalidates the token before local clear. Without this step a session JWT remains valid for up to 30d on the server; a stolen localStorage copy could be replayed from another browser.
- POST failure (expired token, network down) still falls through to local clear + reload — user's intent to end the session is unconditional.
- Regression test: `ShellApp.test.tsx` "handleLogout calls POST /auth/logout BEFORE clearing local token" — exercises the exact sequence: authFetch POST 200, secretVersion bumped, old token now rejected as 401.

### Test migration (P1.3)
After auth became always-on, every test that went through `daemon.fetch` against a protected endpoint had to mint a token. Pattern:

```ts
const token = await createTestToken(join(dataDir, "auth.json"));  // mints BEFORE createDaemon
const daemon = await createDaemon({ dataDir });                    // secretVersion matches
```

Helper: `src/test-utils/auth-helper.ts` → `createTestToken(authPath, { sub?: "session" | "cli" | "stream" })`. Also `withAuth(token, extra?)` for building headers.

Per-test pattern varies — a small `authed(daemon, token)` wrapper that attaches `Authorization: Bearer` is common. `src/test-utils/daemon-harness.ts` does this internally and exposes `fetch` pre-wrapped.

Migrated files: `daemon.test.ts`, `daemon-auth.test.ts`, `daemon-bootstrap.test.ts`, `daemon-plugin-ui.test.ts`, `plugin-url-namespace.test.ts`, `daemon-harness.ts`, `web/ShellApp.test.tsx`. Lines migrated: ~200 across 7 files, within scope budget.

### SKIP_EXACT rules (post-P1.1)
- `/` — SPA root, login page renders pre-auth
- `/auth/status` — login page needs to ask "are we authenticated?" before having a token
- `/vendor/`, `/app/` (prefix match) — compiled bundles, no secrets
- Everything else under `/auth/*` requires a token. Regression test: `/auth/bogus` → 401.

## Audit R7 [LOW] drift cleanup (2026-04-18)

Four cosmetic items flagged by Audit R7 bundled in one commit:

### pluginApiPrefix split: `src/plugin.ts` → `src/plugin-url.ts` (zero imports)

`pluginApiPrefix(name)` moved to a standalone file with ZERO imports. Rationale:
- `web/runtime-types.ts` (compiled to browser via `@mxd/types` importmap) re-exports `pluginApiPrefix` for plugin web code.
- Before the split: `plugin.ts` imported `data-paths.ts` which imports `node:path`. Bun's `target: "browser"` polyfilled the entire `node:path` module (~10 KB of assertPath/normalize/resolve/join/...) into every plugin's first-load bundle.
- Built `runtime-types.js` size: **10,293 B → 281 B (37× reduction)**.
- Server callers (cli, daemon, tests) import from `./plugin-url.ts` directly — one canonical location, no re-export. **Corrects the earlier "Plugin URL Namespace" memory entry that listed `src/plugin.ts` as the home.**

Regression guard: `src/plugin-url-namespace.test.ts` builds the shared module at test time and asserts `runtime-types.js < 500 bytes`. Any future re-introduction of a `node:*` transitive dep (or other server-only import) into `web/runtime-types.ts`'s graph will exceed the threshold and fail loud.

JSDoc fix: the old `pluginApiPrefix` docstring claimed "shell wraps a plugin's authFetch so relative paths become prefixed automatically" — the opposite of the b42c9a2 design, which explicitly rejects a shell wrapper. New docstring reflects reality ("explicit prefix prepended by each call site; no shell wrapper, no hidden rewriting").

### BackgroundProcess dead fields removed

`stdout: string` and `stderr: string` on `BackgroundProcess` were zero-initialized and never read. Removed from `src/tools/bash.ts` (type + constructor) and from 4 test object literals in `src/anthropic-compatible-provider.test.ts`. The "kept for test harness compat" comment was stale — grep confirmed zero reads.

### resetAuthDataCache deleted

`resetAuthDataCache` in `src/auth.ts` became a deprecated no-op after FU4 removed the in-memory cache. Zero callers remained; deleted outright to prevent future code from importing it expecting cache-flush semantics.

## Audit R7: "Clear All Sessions" feature deleted

The project-wide `POST /projects/:id/sessions/clear` endpoint, its CLI subcommand (`mxd sessions clear`), the SettingsPanel danger-zone button, the `/clear` slash command, and `EventStore.clearAll()` are GONE. `handleClearSessions` (shell + plugin), `api.sessionsClear`, and the i18n strings (`settings.clearAllSessions*`, `confirm.clearSessions`) are deleted.

**Why deleted**: User decided deletion over repair (post-audit-R7 discussion). Repair would have required an architectural call on whether shell should know plugin URL prefixes; the feature itself has no unique use case:
- `reset_task` already handles per-task reset
- Delete-project + re-add covers "fresh start for this project"
- Per-task `POST /projects/:id/tasks/:nodeId/sessions/clear` (called from OrchestratorDetail / TaskDetail "Clear Session" buttons) remains and handles per-task reset

**Kept (do NOT confuse with the deleted feature)**:
- `EventStore.clear(sessionId)` — per-session JSONL delete (used by per-task clear route)
- `POST /projects/:id/sessions/prune` — prunes oldest JSONL files (used by autoResumeProjects + `mxd sessions prune` CLI)
- `POST /projects/:id/tasks/:nodeId/sessions/clear` — per-task clear, the `reset_task`-equivalent for the UI
- `taskSessionsClear` in `.mxd/plugin/web/api.ts` — calls the per-task route
- `clearSessionState` in `event-handler.ts` — frontend state cleanup helper, unrelated to the API

Rule going forward: deletion is preferable to repair when a feature is duplicative AND the user explicitly wants it gone. Don't reach for "fix the URL bug" when the feature itself doesn't justify its surface area.

## Audit R7 P2 — CLI onboarding fixes (2026-04-18)

Two independent CLI fixes, both in `src/cli.ts`, landed as separate commits for per-fix revert granularity. Both pinch points were filed by five+ independent auditors — onboarding-critical.

### P2.1 — `mxd config auth add` auto-promotes first group to defaultAuth

Fresh users run `mxd config auth add anthropic --key sk-ant-...` and the README implies that's it. Before P2.1 the command only wrote `authGroups[name]`; `cfg.defaultAuth` stayed `""` and the next `mxd send` threw `"No auth group configured. Add an auth group in Settings > Global > Auth Groups and set defaultAuth."` Provider resolution reads `cfg.defaultAuth` — add-without-promote was a half-command.

Fix in `handleConfigAuth`'s add branch: on the final save, if `cfg.defaultAuth` is empty, set it to the group being added. If already set (user adding a second provider), leave it alone and hint at `mxd config set defaultAuth <name> --global` to switch — we never silently clobber an existing pick.

Output strings are semantic signals: `"Set as default."` on promote, `"Current default is \"<prior>\"; run \`mxd config set defaultAuth <name> --global\` to switch."` on leave-alone. Tests assert the first loosely (`toLowerCase().includes("set as default")`) so future rewording doesn't flake; they assert the second via `toContain("openai") + toMatch(/switch|defaultAuth/i)`.

### P2.2 — `mxd watch` mints a stream token before opening /events

After Audit R7 P1.3 auth is always on; `/events` middleware accepts only `sub=stream` JWTs. The CLI's own `sub=cli` token (what old `mxd watch` sent as `?token=...`) is rejected → 401 → reconnect → 401 loop forever.

Fix mirrors `.mxd/plugin/web/hooks.ts`'s `useSSE`:
1. New helper `fetchStreamToken()` next to `getCLIToken()`: POST `/auth/stream-token` with CLI Bearer → return 5min stream token. On any failure → null (caller falls through to tokenless GET /events → server 401s → existing reconnect backoff handles it).
2. `watchProject.connect()` calls `fetchStreamToken()` each reconnect iteration instead of `getCLIToken()`. Recursive reconnect structure naturally re-mints — never reuse a stale/revoked token across reconnects.

Stream token rides in `?token=` on `/events`; CLI Bearer rides as `Authorization` header on the POST. Long-lived token never appears in proxy logs / shell history / `ps`-visible argv.

**Test gotcha (macOS)**: `mkdtemp(tmpdir())` returns `/var/folders/...` but `process.cwd()` inside the spawned subprocess returns the resolved `/private/var/folders/...`. `resolveCurrentProject`'s string compare fails; CLI exits 1 with "No project found for current directory" before ever reaching the stream-token flow. Fix in test setup: `realpathSync(await mkdtemp(...))` for both dataDir and fakeHome, so the project is registered with the path the CLI's `cwd` actually resolves to.

**Mutation-verified**: all 6 tests (3 per fix, in `src/cli-audit-r7-p2_1.test.ts` and `src/cli-audit-r7-p2_2.test.ts`) fail when the fix line is reverted. Test 3 of P2.2 especially — stdout shows `"Reconnecting in 2s... (attempt 1)"` without the fix, exactly the 401-loop symptom users reported.
