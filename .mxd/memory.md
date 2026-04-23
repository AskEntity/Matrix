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

> **⚠️ WHEN YOU WANT TO RUN TESTS, THE ONLY COMMAND YOU ARE ALLOWED TO EXECUTE IS EXACTLY `bun test`. ⚠️**
>
> **Literally 8 characters: `b u n (space) t e s t`. No prefix. No suffix. No pipes, no redirects, no flags, no arguments, no `&&`, no `2>&1`. Just `bun test`.**
>
> **If the command you are about to send to bash is not byte-identical to `bun test`, STOP. You are about to do the wrong thing.**

```bash
bun test              # ALL tests (src/ + web/). Single command. Nothing appended.
bun run typecheck     # tsc --noEmit
bun run check         # biome lint + format
```

### Forms that are WRONG (every one of these has bitten us)

- ❌ `bun test 2>&1`
- ❌ `bun test | head` / `| tail` / `| grep`
- ❌ `bun test > /tmp/out.log`
- ❌ `bun test src/some.test.ts 2>&1 | tail -100`
- ❌ `bun test --bail`, `--silent`, `--quiet`, any flag to "reduce noise"
- ❌ `bun test && echo ok` (masks non-zero exit)
- ❌ Any combination of the above

### Why, in detail

The bash tool (FU9) already does everything decoration would do, and better:
- Merges stdout+stderr via `(cmd) 2>&1` wrapper → `2>&1` is redundant.
- Tiers large output: head 5KB + banner + tail 5KB + banner + **full file preserved** at `/tmp/mxd/exec-<id>.out` → `| head` / `| tail` are redundant AND destructive.
- Output file persists across turns → `> /tmp/out.log` is redundant.

**Piping is not "harmless size reduction". Piping is CATASTROPHIC DATA LOSS.** A pipe consumes the stream; bytes that go through your pipe never reach the bash tool. Whatever `head`/`tail`/`grep` didn't match is **gone from the Universe** — not in the output, not on disk, not recoverable. If the failure details are in the 50 lines you trimmed, you just burned them.

### Concrete anti-pattern (happens every week)

Real scenario:
1. Agent runs `bun test 2>&1 | tail -8` to "save context".
2. Output tail shows `2116 pass / 2 fail` summary in the last 8 lines.
3. Which tests failed? In the 200 lines above. Gone.
4. Agent re-runs `bun test 2>&1 | grep fail` hoping to see failures.
5. Second run happens to be a DIFFERENT flaky combination (tests are non-deterministic at scheduling level). Grep matches different failures, or none.
6. Agent is now chasing a test that wasn't failing in (1) — or worse, gaslit into thinking no failures exist at all.
7. They re-run 5 more times. Each run flakes differently. Each `| grep` shows a different subset. Agent loses sense of reality.

**Previous agents have gotten stuck in this loop for hours.** The fix is always the same: run `bun test` bare, read the saved output file, you see exactly what failed in that specific run.

### Tests are independent

Every test is its own isolated world. There is no guaranteed ordering between test files, and no expectation that "running just the one that failed" reproduces the failure — flakes are often scheduling-dependent (port conflicts, filesystem races, timer precision). So:

- ❌ "Let me just run the failing file" — the failure may not reproduce in isolation.
- ❌ "Let me `| grep fail`" — the grep is against a stale run, different from the current failure.
- ✅ `bun test` → read the full saved file → see what failed → analyze → fix → `bun test` again → verify green.

If a test is genuinely flaky, `bun test` it 5 times and read all 5 saved output files. Each time. No pipes. The bash tool's file preservation is your friend; the pipe is your enemy.

### Rules summary

- **Every test run is `bun test`, full stop.**
- If the tool result shows `<test_output saved at /tmp/mxd/exec-…>`, that file has everything. Read it.
- If you want to re-investigate, rerun `bun test` again. Both files persist; read either.
- If you're tempted to pipe "for context reasons": the bash tool's tiered output has already protected your context. Piping doesn't help — it only destroys.
- ~2119 tests pass, 4 skip, 12 todo (as of 2026-04-18 after Fix A/B/C).
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

### Test rule: createDaemon-with-worker beforeAll budget ≥ WORKER_INIT_TIMEOUT_MS

When a test's `beforeAll` calls `createDaemon` with a global-scope plugin (i.e., a worker spawn happens inside createDaemon), the test's beforeAll timeout MUST be ≥ the daemon's WORKER_INIT_TIMEOUT_MS (default 30s) — otherwise the test's timer fires first on a real flake and the test reports a useless "beforeAll timed out" with no diagnostic, masking the daemon's much-better "Worker init timed out: <plugin> (>30000ms)" message that names the actual stuck plugin.

Measured cost of `createDaemon` with one global plugin (no plugin runtime, no projects to resume):
- Cold isolated: ~213ms total (worker spawn ~120ms is dominant; web build ~37ms; plugin discovery ~35ms; rest <15ms)
- Warm mid-suite: ~137ms total (worker spawn ~107ms)
- Heavy contention (24 CPU stressors + 4 parallel `bun test`): peak ~346ms total (worker spawn ~209ms)

Normal headroom is 100×+ over a 30s budget. A 15s budget had >40× headroom and still produced rare flakes from extreme scheduler stalls; the test never observed which step stalled because the test's own timer fired first. **Default rule: pick 30s for any beforeAll that spawns a worker via createDaemon. Don't try to fit it under 15s "to fail fast" — fast is meaningless when it's failing on the wrong timer.**

`createTestToken` does NOT generate RSA keys (HMAC JWT secret only) — typically 2-3ms. Not a hypothesis worth investigating for slow daemon-test bootstraps. The dominant cost is always worker spawn.

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

## Fix A (2026-04-18) — root is a regular task, not a null sentinel

`Plugin.tsx` used to set `targetNodeId = null` whenever the user viewed the root. `AppFooter`'s pending-message filter then had two branches:
```ts
targetNodeId
  ? m.taskId === targetNodeId            // sub-task view: direct id compare
  : m.taskId === null || m.taskId === rootNodeId  // root view: sentinel + rootNodeId prop
```

That asymmetry coupled the root view's filter behavior to whether `rootNodeId` state had populated yet. On fresh mount (`useTasks` pending, `rootNodeId=null`), root-destined pending messages silently dropped. The sub-task view had no such race because it always used an explicit id.

**Fix**: root has a real id like any other task. Use it directly.
- `Plugin.tsx` effect collapses to `setTargetNodeId(selectedTaskId ?? rootNodeId)` — one-line, no branching.
- `AppFooter` filter collapses to `m.taskId === targetNodeId` — single path, both views behave identically.
- `rootNodeId` prop removed from `AppFooter` (dead after the filter simplification).
- `handleSend` / `/compact` / `/dump-messages` stop chaining `?? rootNodeId` because `targetNodeId` already resolves through the same fallback.

**Residual transient**: pre-`useTasks` both state values are null → `targetNodeId=null` → filter drops all messages. ~100-500ms flash, acceptable. Optional optimization (seed `rootNodeId` from URL hash on mount) is a separate task if it becomes user-visible.

**Regression guards**:
- `web/AppFooter-pending.test.tsx` (7 tests) — exercises the filter line directly with prop combinations. Catches mutations of the filter (e.g. accidental re-introduction of the two-branch form, accepting `taskId === null` without intent).
- `web/Plugin-targetNodeId.test.tsx` — mounts real Plugin against a seeded `tree.json`, waits for `useTasks` to populate, asserts InputBar's textarea placeholder reads `Message to "Orchestrator"…`. Mutation-verified: reverting the `Plugin.tsx` effect to the old branching form makes this test fail (placeholder stays at generic "Send a message…").

**Lesson**: "root is a special view that needs a sentinel" is a UI-level story with no data-model counterpart. Once the UI speaks the same id language as the data layer, both filter paths collapse to one and a whole class of state-timing races disappears.

## Partial event monotonic extend (Fix B, 2026-04-18)

Two bugs fixed together by one invariant: **partial events are monotonic snapshots of content that only grows; clients extend to the longer of {current state, snapshot} and never shrink**.

### Bug 1 — thinking refresh-loss
`text_delta` events have `ctx.streamingText` buffer + synthetic `assistant_text partial:true` injection in the batch-events endpoint. Thinking had nothing. Refresh mid-stream: text survived (partial snapshot brought it back), thinking didn't (thinking_delta events are ephemeral, only post-refresh deltas accumulated).

**Fix**: mirror streamingText exactly. `ctx.streamingThinking: Map<taskId, string>` updated in `updateStreamingBuffers` (extracted from the emit side-effect to `src/runtime/agent-lifecycle.ts` as a standalone exported function for unit testability). `thinking_delta` appends; `thinking` (final) clears; `runAgentForNode` finally clears on session end. Routes (`tasks.ts` + `projects.ts`) inject synthetic `thinking partial:true` alongside existing `assistant_text partial:true`.

### Bug 2 — partial + delta race on reconnect
`handleReconnect` does BOTH Last-Event-ID SSE resume AND REST refetch. Two paths deliver via different semantics:
- SSE deltas → `merge_thinking` / `merge_text` (append)
- REST partial snapshot → `replace_thinking` / `replace_text` (clobber)

Race cases: (a) live "ABCDEF" + stale REST "ABCDE" → replace overwrites → data loss. (b) REST "ABC" + SSE deltas append "DEF" → "ABCDEF" correct but if SSE already had "ABCDEF" then "ABCDEFDEF" duplicated.

**Fix**: new update ops `extend_text` / `extend_thinking` in `.mxd/plugin/web/event-handler.ts`. For events marked `partial: true`, emit extend ops instead of replace ops. Extend semantics:
- snapshot longer AND snapshot.startsWith(existing) → adopt snapshot
- snapshot shorter or equal → no-op (existing is ahead)
- snapshot longer BUT prefix mismatch → prefer longer + `console.warn` (content drift, shouldn't happen with strictly additive deltas)

Final (non-partial) events still use `replace_text` / `replace_thinking` — they're authoritative, not snapshots.

### Event type extension
`Event.assistant_text` and `Event.thinking` both gained optional `partial?: boolean` field. Never persisted to JSONL (the synthetic events are route-only injections); never produced by provider.

### Why "extend" not "replace" even for thinking
Thinking needs `signature` for Anthropic prefix byte-identity on restart. But partial events have empty signature (we don't know the real signature until the final block arrives). Using replace semantics for partial thinking would overwrite the signature; extend only touches `thinking`. When the final thinking event arrives, `replace_thinking` installs both final text AND signature.

### Test coverage
- Server (`src/runtime.test.ts`): 6 new tests — partial thinking synthesized, cleared on final, per-task + project-level endpoints, thinking+text together, `updateStreamingBuffers` unit tests for each spec type.
- Frontend (`src/plugin-event-handler.test.ts`): 20 new tests — every extend case (longer/shorter/equal/mismatch/no-existing/interleave), merge+extend+merge sequences, SSE+REST race scenarios, final-replaces-partial-replaces-extends.
- **Mutation-verified**: flipping `partial` check in processEvent → 3 integration tests fail. Removing `length <=` guard in extend → 2 tests fail. Deleting `thinking_delta` branch in `updateStreamingBuffers` → 2 tests fail.

## URL always carries viewed task id (Fix C, 2026-04-18)

**Symmetry trio**: Fix A made root a regular task in the data model + AppFooter filter; Fix B made partial events monotonic-extend so refresh doesn't lose streamed content; Fix C makes the URL/routing layer treat root as a regular task too.

### Anti-pattern: "root as default, null as sentinel"

**Any code that treats root specially at the ROUTING / TARGETING / IDENTIFICATION level is wrong.** Root has an id like any task; use it. Only the TREE VISUALIZATION layer legitimately knows "root is root" (for drawing the tree hierarchy + dedicated orchestrator tab button). All other layers should be oblivious to which id happens to be root.

Concrete failure shapes this anti-pattern produced over weeks:
- `targetNodeId = selectedTaskId ?? rootNodeId` — pending banner filter coupled to a fallback chain → silent drop of root-destined messages during the useTasks transient
- `isOrchestratorNode = !selectedTaskId || selectedTaskId === rootNodeId` — `!selectedTaskId` is the null sentinel meaning "treat as root", entangling routing logic with state initialization timing
- `tabScrollStateRef.current.get(selectedTaskId ?? "root")` — literal string `"root"` as a Map key, asymmetric with the SET branch (which guarded on `if (prevTabId)` and skipped null), so root's scroll state was never persisted at all
- `usageTaskId = targetNodeId ?? selectedTaskId ?? rootNodeId ?? nodes.find(...) ?? "orchestrator"` — 4-fallback chain that masks "no selection" rather than rendering empty
- URL hash stripped task component when view matched root → on refresh, no task in URL, useTasks transient drops everything destined for root

The fix everywhere: **selectedTaskId carries the actual root id when viewing root**. No sentinel. No fallback. If selectedTaskId is null, render nothing (it means "nothing selected yet"). The URL-redirect mechanism closes the null window; consumers stay simple.

### Two truths, one effect

Just two sources of truth:
1. **URL hash** is the routing truth: `#<projectId>/<taskId>`, ALWAYS includes taskId
2. **Daemon `/projects/:id/tasks`** is the rootId truth: returns `{nodes, rootNodeId}` (already exists, not new)

One effect reconciles them — when useTasks resolves rootNodeId AND the URL is missing taskId, normalize the URL via `replaceState` and `setSelectedTaskId(rootNodeId)`:

```ts
useEffect(() => {
  if (!projectId || !rootNodeId) return;
  const hash = parseHash();
  if (hash.projectId && hash.projectId !== projectId) return;
  if (!hash.taskId) {
    const desired = `#${projectId}/${rootNodeId}`;
    window.history.replaceState(null, "", pathname + search + desired);
    setSelectedTaskId(rootNodeId);
  }
}, [projectId, rootNodeId]);
```

That's the entire normalization mechanism. No localStorage cache, no SSE listener, no per-project state to invalidate. Hash without a task id is "an invalid state" → fix it once, naturally.

### Initial state: URL only

```ts
const [selectedTaskId, setSelectedTaskId] = useState(initialHash.taskId ?? null);
const [rootNodeId, setRootNodeId] = useState<string | null>(null);
const [targetNodeId, setTargetNodeId] = useState(initialHash.taskId ?? null);
```

Common case (URL already normalized): three states populated on first render → first commit is correct.

Brand-new visit (URL bare): all three null → empty state renders during ~50-200ms transient → URL-redirect fires → catches up.

The transient is **a valid empty state, not a bug to paper over**. AppFooter shows no pending banner. ActivityLog shows no logs. InputBar placeholder is generic "Send a message…". This is exactly what "nothing selected yet" should look like. No fallback chain tries to make it "work" during null.

### Sentinel sweep (parallel cleanup)

- `Plugin.tsx isOrchestratorNode = selectedTaskId === rootNodeId` (was `!selectedTaskId || ...`)
- `TaskTree.tsx isOrchestratorSelected = selectedTaskId === rootNodeId` (same)
- `MockShowcase.tsx` same (mirrors prod for consistency)
- `usageTaskId = selectedTaskId ?? ""` (was 4-fallback chain)
- `viewedSessionId = selectedTaskId` (was `selectedTaskId ?? rootNodeId`)
- `tabScrollStateRef.get(selectedTaskId)` (was `?? "root"` literal)
- `targetNodeId` useEffect = `setTargetNodeId(selectedTaskId)` (no fallback)
- `updateHash(projectId, taskId)` always writes `#proj/taskId` (no taskId-stripping branch)

**Kept (legitimate, not the anti-pattern)**:
- Tab close → navigate to root: `next[idx] ?? rootNodeId` — this is a navigation decision ("where to go after closing the last tab"), not a fallback that hides null state. The `??` resolves an array-out-of-bounds undefined.
- `handlers.ts: if (!selectedTaskId) return` in destructive ops — guards "did the user actually click a sub-task?", not the routing sentinel.
- `BackgroundProcessBar.tsx` / `LogEntryView.tsx`: `taskId ?? rootNodeId` for event-level session attribution — different concern (per-event routing).
- `tabScrollState SET` skips on null prevTabId — symmetric with the GET cleanup; null prevTabId means we never had anywhere to save from.

### Tests (web/Plugin-url-task-id.test.tsx, 5 tests, mutation-verified)

1. **URL has root task id** → first render is correct (no async wait)
2. **URL bare** → after useTasks resolves, URL normalized to `#proj/<rootId>` + state catches up
3. **URL has sub-task id** → preserved verbatim, NOT rewritten to root
4. **openTabs defensive strip** → root id stripped from openTabs after useTasks (no cache to consult at init time, post-mount effect handles it)
5. **No localStorage `mxd-root:` keys are written or read** (regression guard: any future agent re-introducing a cache fails this)

**Mutation proofs confirmed by reverting code one edit at a time**:
- Drop `initialHash.taskId ??` from useState init → Test 1 fails (placeholder is generic "Send a message…", not "Message to …" — proves URL-as-source-of-truth)
- Drop the URL-redirect effect → Test 2 fails (URL stays `#proj`, placeholder never resolves)

### How I went wrong (and what to do differently)

**The wrong goal led to a complex solution.** I framed the problem as "first render must be correct" — which forced me to find some way to know rootId synchronously at mount. That led to building a localStorage cache layer.

**The right goal**: "URL is truth; if URL is missing the id, normalize it AS SOON AS we know the id". The "as soon as" is naturally async (useTasks resolves in 50-200ms), and that's fine — the brief empty state during normalization IS a valid state.

**The pivot**: user pointed out that daemon's `/projects/:id/tasks` already returns rootNodeId. Once that fact lodged, the cache became obviously redundant — `useTasks` already provides what the cache was caching, just async instead of sync. The async response IS the truth source; cache is only useful if you reject async, which I had no reason to do.

**Lesson**: when tempted to add cache to make something synchronous, ask "is there an existing async truth I can wait for instead?" If yes (and there usually is), the answer is "wait + redirect", not "cache". Caches add invalidation complexity for the optimization of skipping a 100ms fetch. Rarely worth it.

**Anti-pattern in the wider sense**: I picked a goal that sounded stricter than necessary ("first render correct" vs "correct after first async settle"). The strict goal pulled in solution complexity. **Default to the loosest goal that satisfies the actual user need.** "Pending banner appears within 200ms of refresh" was the real goal; "appears synchronously on first render" was my over-strict invention.

### Test infra limitation: happy-dom + history.replaceState

`window.history.replaceState(null, "", url)` does NOT update `window.location.hash` in happy-dom (real browsers do). Confirmed via direct repro. The URL-redirect effect handles this with a manual `setSelectedTaskId(rootNodeId)` call alongside the replaceState — works in both env. Without that manual setState, happy-dom would leave selectedTaskId stale (replaceState wouldn't fire hashchange to trigger the listener; production would, but tests wouldn't catch it).

### Test pollution gotcha (pre-existing, not Fix C)

Running multiple `web/*.test.tsx` files together produces flaky failures (Plugin-targetNodeId may time out, AppFooter chips may not render). Caused by happy-dom state surviving GlobalRegistrator unregister/register cycles, and React's module-level state holding refs to old document instances. Pre-existing — confirmed by stashing changes and reproducing.

Workaround: run `bun test web/` (whole dir, all 28 pass) or `bun test` (full, 2118 pass). Subset runs (`bun test web/A.tsx web/B.tsx`) are flaky depending on order. Real fix is a separate task — needs hard process-level isolation per file.

## Fix D (2026-04-18) — compact_marker clear must be immediate, not deferred

`.mxd/plugin/web/event-handler.ts`: `compact_marker` was the ONLY `deferredMessages` mutation that ran in the sideEffects phase. `message` case calls `deferredMessages.set(id, ...)` synchronously inside `processEvent` (before its return); `messages_consumed` calls `.delete(id)` synchronously too; `compact_marker` was calling `.clear()` from inside the `sideEffects` closure that runs AFTER `processEventBatch`'s loop completes.

**Failure shape** — for a batch `[compact_marker, message_A, message_B]`:
1. `processEvent(compact_marker)` → pushes `clearSideEffect` onto `deferredSideEffects`
2. `processEvent(message_A)` → `deferredMessages.set("msg-A", ...)` immediate
3. `processEvent(message_B)` → `deferredMessages.set("msg-B", ...)` immediate
4. `setLogs(entries)`
5. Deferred sideEffects run in insertion order → `clearSideEffect` wipes A and B that were legitimately staged AFTER the compact
6. `syncPendingBanner` reads empty map → `pendingMessages = []`

User observation: root view's pending banner was empty for messages sent mid-stream. Fresh sessions (no compact_marker in batch) worked; sessions with 14+ compact_markers triggered the bug on every refresh (REST batch-events fetch on reconnect re-runs `processEventBatch` with the full history including every compact).

**Fix**: move `deferredMessages.clear()` out of the sideEffects closure into immediate execution inside the `case` body, before the return. Only `syncPendingBanner` (a React setState) stays deferred. Comment next to `messages_consumed` already said "Materialize immediately (not as side effect) so batch mode works" — compact_marker was the one violating the invariant.

**Invariant, stated plainly**: all mutations to `deferredMessages` (`set`, `delete`, `clear`) must happen in the IMMEDIATE phase, synchronously inside `processEvent` before its return. Only React state sync (`syncPendingBanner`, `setBackgroundProcesses`) belongs in `sideEffects` — those are legitimate deferred-until-after-loop setState calls.

**Regression tests** (`src/plugin-event-handler.test.ts` — "event-handler compact_marker clear ordering (Fix D)"):
1. Batch `[compact, msg_A, msg_B]` → pendingMessages contains both A and B (post-compact messages survive)
2. Batch `[msg_pre, compact, msg_post]` → pendingMessages contains only msg_post (pre-compact correctly cleared)
3. Batch `[msg_pre, consumed([pre]), compact, msg_post]` → pendingMessages contains only msg_post (consumed pre is materialized then cleared)

**Mutation-verified**: reverting `clear()` back into the sideEffects closure makes all 3 tests fail. Test 1 is the direct repro of the user's bug shape.

**Lesson — mutation/setState phase discipline**: when multiple event types mutate the same data structure, they must all mutate in the same phase. Mixing "set/delete inside processEvent" with "clear inside sideEffects" is a silent correctness hazard: in single-event mode (handleEvent) there's no loop between processEvent and sideEffects so both phases look equivalent; in batch mode (processEventBatch) the phase gap yawns open and mutations interleave wrongly. Search any `sideEffects:` closure for non-React-state mutations — that's the smoke.

## Task X (2026-04-18) — pending is a projection of the events log, not a state

Deletes the entire "mutable deferredMessages map + imperative setPendingMessages + syncPendingBanner sideEffect + multiple clear paths" model in `.mxd/plugin/web/event-handler.ts`. Replaces it with a pure reducer.

**Why**: Fixes A, B, C, D all tried to patch the imperative-state model by shifting *when* mutations happen. Each fix closed one race (Fix A: filter symmetry; Fix B: partial monotonic extend; Fix C: URL routing truth; Fix D: compact_marker mutation phase). Each left the underlying bad model in place. User's conclusion: the mutable state itself is the bug. Defining "which event clears pending" is still inside the wrong frame.

**New model**:
```ts
// module scope, pure, exported
type PendingMessage = { id, taskId, text, timestamp, images, source, content, queueEntry };
type PendingAction = { type: "RESET" } | { type: "APPLY"; event: IncomingEvent };

function pendingReducer(state, action) {
  if (action.type === "RESET") return [];
  const e = action.event;
  if (e.type === "message" && e.id && e.body?.source !== "compact") {
    return [...state, /* derived entry */];
  }
  if (e.type === "messages_consumed" && e.messageIds?.length) {
    const consumed = new Set(e.messageIds);
    return state.filter(m => !consumed.has(m.id));
  }
  return state;  // every other event: no-op for pending
}
```

**Deletions** (all gone from event-handler.ts):
- `const deferredMessages = new Map<...>()`
- `function syncPendingBanner()`
- `clearSessionState` deferredMessages manipulation (log filter + olderEvents cleanup retained)
- `deferredMessages.clear()` in `compact_marker` case (Fix D's immediate version — now unnecessary)
- `deferredMessages.clear()` in `processEventBatch` — replaced by `dispatchPending({type:"RESET"})`
- `deferredMessages.set(id, ...)` in `message` case — replaced by `pendingActions: [{type:"APPLY", event}]`
- `deferredMessages.delete(id)` in `messages_consumed` case — replaced by `pendingActions`
- `setPendingMessages: React.Dispatch<...>` from `EventHandlerDeps`

**Added** (all at module scope, all pure):
- `PendingMessage` type (exported)
- `PendingAction` type (exported)
- `pendingReducer` function (exported, pure)
- `pendingChipText` (hoisted from closure — used by reducer)

**Plugin.tsx**: useState<Array> replaced with `useRef + useState + dispatchPending` sync-write-through pattern. Synchronous ref update → any messages_consumed in the same batch sees the just-applied message. setState triggers re-render, consumers (AppFooter) read the state as before.

**Driver flow**:
```ts
for (const evt of events) {
  const result = processEvent(evt);
  entries.push(...result.entries);
  applyUpdates(entries, result.updates);
  for (const a of result.pendingActions ?? []) dispatchPending(a);  // SYNC
  if (result.sideEffects !== NO_SIDE_EFFECTS) deferredSideEffects.push(result.sideEffects);
}
```

**Invariants after Task X**:
1. Pending is a pure function of the events log. `pendingReducer(prev, action)` is the only way pending changes.
2. No imperative `clear` path. Events drive everything. `RESET` exists only for "replay from scratch" (processEventBatch at batch start or project switch).
3. Compact-source messages never enter pending (predicate filter at reducer APPLY time). No subsequent cleanup needed — old Fix D world had to clear the "[compact]" chip; this world never adds it.
4. tree_updated does NOT mutate pending. Task lifecycle status "pending" and message state "pending" are different concepts.

**What Task X obsoletes from prior fixes**:
- Fix A's AppFooter filter: still correct (`m.taskId === targetNodeId`), independent concern.
- Fix B's partial monotonic extend: still correct (different code path — partial events don't affect pending).
- Fix C's URL routing: orthogonal to pending.
- Fix D's immediate `deferredMessages.clear()`: the clear itself is now deleted. Fix D's principle (mutations must happen in the same phase) is still valid — Task X eliminates the need by deleting the mutation entirely.

**Regression tests**:
- `src/plugin-event-handler.test.ts` "Task X: pendingReducer is pure" — 6 tests exercising the reducer directly (RESET, APPLY message/consumed/unrelated, compact-source exclusion).
- `src/plugin-event-handler.test.ts` "Task X: no 'clear pending' paths outside messages_consumed/RESET" — 3 tests proving tree_updated and compact_marker no-op for pending.
- `src/plugin-event-handler.test.ts` "Task X: mutation-proof regression for the four prior fixes" — 2 tests locking in the Fix-D-era batch shape and live handleEvent flow.
- Three historical tests **inverted**: they previously encoded "clear pending on X" behaviors. Now they assert pending is PRESERVED — documenting the new invariant in-place.

**Unconsumed messages stay pending forever** — semantically correct per user: "如果之前有没consume的，之后还是显示pending 我觉得合理". If the agent never processed a message, the UI should keep surfacing it; silently clearing on compact was lying about what actually happened.

**Lesson**: any null/sentinel/special-case handling for "pending" was papering over a wrong mental model. Pending is a view — a projection. The data is the events log. Derivation is the correct word, not storage.

## Task Y (2026-04-18) — URL path-based routing with segment ownership

Replaces the single-hash cross-layer coordination (`#projectId/taskId`) with
a path-based URL where each layer owns its segment:

- URL format: `/<projectId>/<pluginScope>/<pluginPath>`
- Shell owns `/<projectId>/<pluginScope>/` prefix
- Plugin owns everything after `<pluginScope>/` (the `<pluginPath>` suffix)
- Shell passes `pluginPath` + `pushPluginPath(path, replace?)` as props

**Why path-based (not hash-based extended)**: hash routing forced `#projectId/taskId`
into a single string two layers had to cooperate on. Shell's `projectId` state
and plugin's `taskId` state constantly drifted — shell didn't read URL on
mount, plugin wrote hash for task changes, "back" button was broken for
project switches, and every layer had its own "URL stays in sync" bug.

User's framing: "一个 daemon owned 一个是 project owned 中间完全同步灾难". Path
segments are a natural ownership line — shell never reads plugin's path, plugin
never reads shell's prefix. Cross-layer coordination deletes itself.

**Shape after Task Y**:
- Shell `AuthenticatedShell`:
  - `parsed = parsePath(window.location.pathname)` on mount + `popstate` listener.
  - URL normalization effect: `/` → `/<firstProjectId>/<firstPluginName>/` via
    `replaceState` (no history entry). Waits for both projects AND plugins to
    load — uses `plugins[0].name` (no hardcoded "matrix").
  - `pushPluginPath(path, replace?)` callback passed to plugin: shell converts
    to full URL, calls `push/replaceState`, updates its own `parsed` state.
  - `handleProjectChange` / `handleAddProject` / `handleDeleteProject` use
    `pushState` so browser back/forward works naturally.
  - `handleScopeChange` pushes new scope URL.

- Plugin `ProjectContent`:
  - `selectedTaskId` is DERIVED from `pluginPath` via `parsePluginPath()` — NOT
    useState. No hashchange listener. No URL bookkeeping inside plugin.
  - `setSelectedTaskId(id, replace?)` is now a thin wrapper that calls
    `pushPluginPath(id ?? "", replace)`. Same callsites, same semantics.
  - URL normalization effect: `pluginPath === "" && rootNodeId` → 
    `pushPluginPath(rootNodeId, replace=true)`. Same logic as Fix C, now
    plugin-internal.
  - `targetNodeId` remains useState, synced from `selectedTaskId` via useEffect.
    Kept this way to minimize the diff — refactoring all `targetNodeId`
    consumers to re-derive is orthogonal to Task Y.

**Deletions**:
- `parseHash`, `updateHash`, `initialHash` useMemo, hashchange listener in
  Plugin.tsx.
- Hash-based URL-redirect effect (replaced with path-based normalization
  that calls pushPluginPath).
- Shell's `projects[0].id` default (URL-derived now, no guessing).

**What this fixes that prior Fix C didn't**:
- Hash ownership was ambiguous — shell wrote projectId (via `window.location.hash`
  directly in `handleProjectChange`), plugin wrote taskId, both trampled each
  other during refresh and SSE updates.
- ShellApp.tsx never read `window.location.hash` on mount → defaulted to
  `projects[0].id` regardless of URL. Refresh on a specific project → URL hash
  preserved the projectId but shell state started with projects[0].id, so task
  events went to the wrong session.
- Back button was broken: shell used `window.location.hash = ...` which
  triggered hashchange but also created history entries plugin didn't know
  about.

**Invariants**:
1. Shell NEVER reads/writes `<pluginPath>`. Plugin NEVER reads/writes
   `<projectId>` or `<pluginScope>`. Each layer only touches its own segment.
2. URL is THE routing source of truth. Neither shell nor plugin cache
   anything — refresh is free, back/forward is free, `pushPluginPath` with
   `replace=true` normalizes, default pushState for user actions.
3. Plugin has ONE parent → prop → child flow. Shell owns URL and passes
   `pluginPath` down. Plugin calls `pushPluginPath` back up. Cycle is
   explicit and type-safe.

**Future extension**: if a future plugin wants deeper routing (e.g.
`<taskId>/<subPath>`), the plugin's own `parsePluginPath` handles that
internally. Shell doesn't care what shape the plugin uses.

**Regression tests**:
- `web/path-routing.test.ts` (15 unit tests): pure `parsePath` / `buildPath`
  covering all URL shapes (empty, bare projectId, full, ULID/UUID, double
  slashes). Pins the parse ∘ build = identity round-trip.
- `web/Plugin-url-task-id.test.tsx` (5 integration tests, rewritten for Task
  Y): `TestShell` wrapper holds pluginPath state + forwards pushPluginPath,
  mimicking the real shell↔plugin prop contract. Tests first-render
  correctness, URL normalization on empty path, sub-task preservation, openTabs
  defensive strip, no-localStorage-cache invariant.
- `web/Plugin-targetNodeId.test.tsx` (1 integration test): same TestShell
  pattern — verifies InputBar placeholder reflects root task title after
  useTasks resolves.

**ShellApp integration tests for path routing — DELETED, with reason**:
An initial `web/ShellApp-path-routing.test.tsx` tried to spy on
`window.history.pushState`/`replaceState` in `beforeEach` and restore in
`afterAll`. Running the full test suite, those spies polluted every
subsequent `bun test web/*.test.tsx`: `ShellApp.test.tsx`,
`AppFooter-pending.test.tsx`, and `ShellApp-build-error.test.tsx` all got
18 spurious failures. The polluting mechanism was not clean even with
explicit restore + `GlobalRegistrator.unregister()` in `afterAll` — happy-
dom's cross-file state is opaque, and mixing method-level monkey-patches
with happy-dom's per-describe-block lifecycle turned out unfixable within
scope. Deleted the file. Coverage isn't lost: the pure parse/build logic
is in `path-routing.test.ts`; the shell's actual pushState/replaceState
wiring is verified by manual smoke + visual inspection of the diff (13
lines total: URL normalization effect, popstate listener, three pushState
callsites in project handlers).

**happy-dom limitation — monkey-patching `window.history`**:
Instrumenting `window.history.pushState`/`replaceState` via `beforeEach`
replacement survives `GlobalRegistrator.unregister()` in ways we couldn't
diagnose. If a future task needs to assert on history API calls from
happy-dom tests, **don't** spy on `window.history.*`; instead, intercept
at a layer the test owns (e.g., a test harness that wraps `ShellApp` and
exposes a ref to captured history calls via React context), OR accept
that integration coverage of routing is best left to real browsers and
keep unit tests for the pure logic.

**Lesson (process — "never claim pre-existing without verifying against
main")**: My first pass blamed these 18 failures on pre-existing happy-dom
pollution documented in memory.md. I used `git stash && bun test web/` to
"verify", saw 19 fails on main, and concluded Task Y hadn't regressed
anything. I was wrong twice: (a) `git stash` left my committed changes in
place — I needed `git reset --hard HEAD^` to actually revert Task Y; (b)
even if stash had worked, the relevant baseline is `bun test` (full), not
`bun test web/` (subset). On the true baseline, main had 0 failures. Lesson
for any future "it was already broken" claim: revert the commit, run
`bun test` (bare, not subset, not piped), read the bare numbers.

**Lesson (design)**: when two layers coordinate via a shared serialized
blob (one hash, one query string, one localStorage key), look for the
segment they each own and give each layer direct access to its own segment.
If "they must agree" is the contract, the contract is wrong — sooner or
later they disagree. Path segments + props+callbacks encode ownership at
the type level; no synchronization protocol needed.

## Task Y SPA fallback (2026-04-18) — `pm.has(firstSeg)` is the single predicate

After Task Y, paths look like `/<projectId>/<scope>/<rest>` and are
server-visible. Browser refresh on those paths must reach the shell HTML so
the SPA can boot, parse the URL, and render. Pre-fix: 404 (no catch-all).
Post-fix: 200 HTML iff first segment is a registered project id.

**Single source of truth**: `pm.has(firstSegment)` decides BOTH whether the
auth middleware bypasses (skipping the 401 wall on browser navigation) AND
whether the wildcard `app.get("*")` serves HTML. Same predicate, same
answer — no chance of "auth bypassed but wildcard 404'd" or vice versa.

**`isFrontendPath(path)`** (auth middleware): returns true for `/` exact OR
`pm.has(firstSeg)`. Bypass only on GET (POST/PATCH to `/<projectId>/...`
stay auth-gated — those don't exist as legitimate SPA paths, 401 is more
honest than accidental HTML).

**`app.get("*", ...)`** (registered last): mirrors the same `pm.has` check.
Stale / deleted / never-existed first segments → clean 404, not a fake SPA
shell that immediately 404s on its own data fetches. Backend route names
("api", "auth", "projects", "health", etc.) never collide with project ids
(ULIDs are 26 chars of base32).

**Why not regex on ULID?** Considered + rejected. `pm.has` is the actual
correctness predicate — a project's existence decides validity, not its
id format. ULID format could change; project registration semantics
won't. Also: bogus / old-deleted ids 404 cleanly under `pm.has`,
broken-SPA-pretending-to-load under regex.

**Why GET-only?** The wildcard is `app.get("*")`, not `app.all("*")`.
POST/PATCH/DELETE to unknown paths stay 404. Typo'd write endpoint can't
silently 200-with-HTML.

**Plumbing**: added `ProjectManager.has(id)` as a one-liner public method
(was using internal `this.projects.has(id)` only). Tests live in
`src/daemon-integration.test.ts → "daemon integration: SPA fallback (Task Y
refresh)"` — 13 tests covering authenticated GET, unauthenticated browser-
refresh GET (the actual UX scenario), byte-identical HTML between `/` and
`/<projectId>/...`, plugin 404s not swallowed, `/auth/bogus` still 401,
`/vendor/missing.js` still 404, POST/PATCH stay auth-gated, non-existent
project id 404s.

**Cache hygiene** (SHIPPED — see "Content-hashed build pipeline" below):
browser used to cache old `/app/web/main.js` after daemon restart. Fix was
content-hashed filenames in the build pipeline (`naming: "[name]-[hash].[ext]"`
+ manifest), NOT a `Cache-Control: no-store` band-aid. Different layer
(build, not server routing), different risk class — shipped as its
own ticket.

## Project-switch reset via remount key (2026-04-18)

`web/ShellApp.tsx` passes `key={`${projectId}/${selectedScope}`}` on
`<PluginUI>`. When either segment changes, React unmounts the plugin
subtree and remounts a fresh instance — every `useState` / `useRef` /
`useAgent` re-initialises from scratch. No imperative reset ceremony
needed.

Before: `.mxd/plugin/web/Plugin.tsx` kept a `prevProjectId` ref + a
25-line useEffect that manually cleared 14 pieces of state
(`rootNodeId`, `openTabs`, `logs`, `tokenUsage`, `pendingMessages`,
`pendingClarifications`, `backgroundProcesses`, `activeAgents`,
`olderEventsAvailable`, `lastTurns`, `lastInputTokens`,
`lastCacheCreationTokens`, `lastCacheReadTokens`, `lastOutputTokens`)
plus clobbered `mxd-open-tabs` in localStorage.

After: the useEffect is gone. Remount handles all 14 resets implicitly.
`mxd-open-tabs` localStorage now survives a project switch; the
existing tab-cleanup effect
(`validTabs = openTabs.filter((id) => nodeMap.has(id))`) filters
cross-project stale ids once `nodeMap` loads, so no user-visible
difference.

Why this matters as a pattern: "detect prop X change and manually
clear 14 pieces of local state" is a consistent smell. React's
`key={X}` is the idiomatic equivalent and cannot drift — a new useState
added anywhere inside the subtree is reset for free. The old approach
required every new piece of state to be manually added to the reset
list; forgetting → cross-project leaks.

Net LOC: -20 (+7 / -27).

## Content-hashed build pipeline (2026-04-18) — `Cache-Control: immutable` replaces `no-store`

**What shipped**: every asset `buildWebAssets` emits carries its content hash
in the filename. `main-a1b2c3d4.js`, `react-7h8j9kml.js`, `styles-q2w3e4r5.css`.
Served with `Cache-Control: public, max-age=31536000, immutable`. HTML that
references them is served with `Cache-Control: no-cache, must-revalidate` so
the browser always asks "is there a new index?" and never asks "is the
hashed JS still fresh?".

**Why**: Task Y SPA fallback memorized the deferred cache-hygiene problem —
"browser caches old `/app/web/main.js` after daemon restart". Two
options: `Cache-Control: no-store` (band-aid — works but every reload
re-downloads the ~MB shell) vs content hash (standard web pattern —
cache win is preserved, and stale content is impossible because stale
URLs literally don't exist on disk). User ordered the second.

**Mechanism**:
- `Bun.build({ naming: "[name]-[hash].[ext]" })` for vendor shims,
  shared modules, and plugins.
- `Bun.build({ naming: "[dir]/[name]-[hash].[ext]" })` for the shell
  entry — preserves the `web/` subdir.
- CSS goes through `hashRename(sourcePath, outDir, logicalBasename)`
  which reads bytes, computes `Bun.hash → base36 → low 8 chars`, copies
  to `<logicalBasename>-<hash>.<ext>`. Same shape as Bun.build's own
  hashes so URLs look uniform.
- `manifest: Record<string, string>` — logical URL → hashed URL. Populated
  for every asset. Used by `generateIndexHTML` to emit the correct
  `<script>`/`<link>`/importmap hrefs.
- `importmap.imports` is sourced from `manifest` — so every bare
  specifier (`react`, `@mxd/auth-context`, etc.) resolves through the
  importmap to a hashed URL. If the manifest is missing an entry, build
  throws (`Vendor shim ${specifier} missing from manifest`) instead of
  silently emitting a bare URL that would 404.

**Cache header semantic**:
- Hashed asset URL changes iff content changes → `immutable` is safe.
- HTML URL (`/` and every SPA-fallback path) is stable → `no-cache`
  forces revalidation on every navigation. Daemon rebuild → next index
  fetch learns the new hashed asset URLs → browser downloads them
  fresh. No orphan references, no band-aid.

**Determinism**: `Bun.hash` on content bytes is pure. Two builds of the
same source produce identical hashes → identical filenames → identical
HTML → byte-identical deployments. Changed source → different hash →
different filename → automatic cache bust.

**Tests** (`src/web-builder.test.ts`, 18 tests, including):
- Every importmap entry is a hashed URL
- Every logical asset URL has a manifest entry pointing at a hashed URL
- Two builds of same input produce identical hashes
- Changed shell source produces a different shell hash
- CSS content change produces a different CSS hash
- Plugin output is hashed; hashed file exists on disk

**Tests updated** (dropped hardcoded `/app/web/main.js` references):
- `src/daemon-bootstrap.test.ts:244` → regex match against
  `/app/web/main-[a-z0-9]{8}\.js`
- `web/ShellApp.test.tsx:60,61,78,82` → extract hashed URLs from HTML,
  fetch those; also assert `Cache-Control: immutable` on assets +
  `no-cache` on HTML.
- `src/plugin-url-namespace.test.ts` runtime-types.js size regression
  → look up hashed path via manifest instead of `vendor/shared/runtime-types.js`.

**What NOT to do**:
- Don't add `Cache-Control: no-store` anywhere as a fallback. Either
  the URL is content-addressable (immutable) or it's the index (no-cache).
  `no-store` is the band-aid the hashing design replaced.
- Don't hardcode logical asset URLs (`/app/web/main.js`) in production
  code — only the manifest knows the real hashed URL.
- Don't assume Bun.build hash width matches our manual CSS hash width
  blindly; the test regex `[a-z0-9]{8}` pins the shape. Bun could widen
  it in a future version — if so, update `shortContentHash` to match
  and re-run the shape tests.

**Anti-pattern avoided**: my first instinct was to write `no-store` +
add a query-string cache buster `?v=abc123`. Both are cargo-cult. Query
strings defeat CDN caching; `no-store` wastes bandwidth. Content-
addressable URLs are the web-native answer to this class of problem —
the browser's cache is already an infinite content-addressable store if
you feed it content-addressable URLs.

## compacted_resume UI card (2026-04-18) — queueEntryToUIEvent is the UI materialization gate

Rendered post-compact summaries as a collapsible card in the activity log
(visual cousin of the `◈ Context compacted` bar). Before the fix, the
summary message existed in JSONL + went through the two-phase lifecycle,
but the UI **silently dropped it** because `queueEntryToUIEvent` had no
case for `source: "compacted_resume"` — fell through to `default: null`,
so `materializeFromPending` produced null, so no log entry was ever
created. The placeholder text "Session resumed from checkpoint" in
`event-display.ts` was dead code (nothing imports `eventToDisplay` /
`messageToDisplay`), so it wasn't even the visible artifact — the visible
artifact was **nothing**.

### Invariant (lock in mentally)

Every `QueueMessage.source` that should be user-visible in the activity
log MUST have a case in `queueEntryToUIEvent` (in
`.mxd/plugin/web/event-handler.ts`). That switch is THE UI
materialization gate for message-shaped events. A missing case → a
silently-dropped event class. No error, no warning, nothing in DOM.

Adding a new source type? Three places to touch, in order:
1. `src/message-queue.ts` — union member definition
2. `src/events.ts` — producer paths (usually via `queue.enqueue`)
3. `.mxd/plugin/web/event-handler.ts:queueEntryToUIEvent` — UI
   materialization case. If you forget this, nothing in the UI will
   render despite perfect JSONL.

### Pending routing decision

compact & compacted_resume both skip `pendingReducer` (they're
server-internal messages, not user-pending). That's an **intentional
symmetry** — no chip flashes in the footer banner during the brief
emit→consume window. If a new source should behave this way, add it to
the same skip list.

### Where the new card lives

- Branch in `.mxd/plugin/web/components/tools/LogEntryView.tsx`
  right after `fork_marker`, matching `entry.type === "message" &&
  entry.body.source === "compacted_resume"`.
- Uses `Card` component, default-collapsed (summaries are hundreds of
  lines — expanding is opt-in).
- Wrapper class `mxd-compact-boundary mxd-compact-summary` shares the
  existing compact visual language.
- Content renders in `<div className="mxd-compact-summary-content">`
  with `white-space: pre-wrap` + scrollable `max-height: 420px`.
- New i18n string `compact.summaryTitle` in both EN ("Compact Summary")
  and ZH ("压缩摘要").

### MockShowcase

Added a sample `compacted_resume` event right after the
`compact_marker` in `src/runtime/routes/mock-showcase.ts` so the
mock-showcase page exercises the new card. Any future agent touching
this flow can open `/mock-showcase` and visually confirm the card
renders without running a real compaction.

### Regression tests

- `web/LogEntryView-compacted-resume.test.tsx` (3 tests) — full
  LogEntryView render through LocaleProvider. Asserts i18n header,
  default-collapsed, expand-click reveals real content, no placeholder
  string ever appears, long bodies render verbatim (no truncation).
- `src/plugin-event-handler.test.ts` "compacted_resume message plumbing"
  (3 tests) — locks in: processEvent renders directly (skips pending),
  pendingReducer treats compacted_resume as no-op, full cycle with
  messages_consumed produces exactly ONE log entry (no duplicate).
  Mutation proofs documented per-test.

## EventStore generation guard: sync writes + post-check (2026-04-18)

`src/event-store.ts` `append`/`appendBatch` use `appendFileSync` (not
`fs.promises.appendFile`). The guard check and the filesystem write
must happen in the SAME microtask — anything async between them lets
`clear()` interleave and recreate a just-unlinked file.

### Race symptom (the flake)

`Integration: resetTask JSONL cleanup race` tests, especially "reset
running agent during bash: JSONL stays deleted", failed under CPU
contention with "JSONL reappeared after Nms — async cleanup wrote
after clear".

### Root cause

Old code in `enqueueWrite`:
```ts
const guardedFn = () => {
  if (this.getGeneration(sessionId) !== generation) return Promise.resolve();
  return writeFn();  // returns async appendFile Promise
};
```

Sequence under contention:
1. `guardedFn` microtask runs: guard passes (G0 == G0).
2. `writeFn = () => appendFile(path, line)` called. libuv schedules
   `open(path, O_APPEND | O_CREAT)` on the thread pool. `guardedFn`
   returns the pending Promise.
3. Main thread is free. Test's `eventStore.clear(rootId)` runs:
   generation bumped to G1, `unlinkSync` removes the file.
4. libuv thread pool finally wakes, calls `open(O_APPEND | O_CREAT)`.
   `O_CREAT` creates a NEW file (directory entry was just removed).
5. Writes the line. Closes. File has reappeared.

The window is typically sub-ms and invisible. Under load (sibling tests
saturating the libuv thread pool), it widens to tens of ms — wide enough
to flake.

### Fix (two layers)

**Primary — sync writes**: `append`/`appendBatch` use `appendFileSync`
inside the guardedFn. Guard check + write happen synchronously in one
microtask; `clear()` cannot interleave by construction.

**Defense — post-check**: after `await writeFn()` in `guardedFn`, check
generation again. If `clear()` ran DURING writeFn, any file writeFn
created is a zombie — `unlinkSync` it. Redundant in the fast path (sync
writeFn leaves no window) but catches any future caller who passes an
async writeFn.

### Why sync I/O is fine

- Per-write cost: one JSONL line (~100 bytes), microseconds on SSD.
- Writes are already serialized per-session via `writeQueues` Promise
  chain. Sync just means each link of the chain is itself atomic.
- Main thread is usually idle between provider streaming ticks; blocking
  it for microseconds is invisible.

### Regression tests (mutation-proof)

`src/event-store.test.ts`:
- `race: clear during async writeFn delay → post-check unlinks zombie`:
  uses reflection to call private `enqueueWrite` with a deliberately
  slow async writeFn. After 5ms (guard passed, writeFn sleeping), test
  calls `clear()`. When writeFn finally writes, post-check must remove
  the zombie. Fails without Layer 2.
- `race: new agent enqueues AFTER clear — new write survives post-check`:
  exercises the edge where W1 (old gen, slow async) + clear + W2 (new
  gen, fast sync) all chain on the same session. W1's zombie gets
  unlinked; W2's legitimate write is preserved. Zombie content is valid
  JSON so `read()` doesn't silently skip it — "only agent_start
  survives" is a real mutation guard.

Both tests verified by `git stash push src/event-store.ts` + re-running
the file: both FAIL on main, both PASS with the fix.

### What NOT to do

- Don't revert `appendFileSync` to `fs.promises.appendFile` because it
  "feels more idiomatic". The sync I/O is load-bearing for the guard.
- Don't remove the post-check even though it's decorative in the
  current fast path. It's the safety net for any future async writeFn.
- Don't remove `appendFile` from the `node:fs/promises` import —
  `copySessionFrom` still uses it (different path, no `clear()` race
  because fork has structural exclusion with reset at the task level).

## Plugin-namespace storage layout

Matrix's per-project runtime data lives in a plugin-namespaced subdirectory,
matching the shape every other plugin uses. Completes the "matrix is just a
plugin" framing started in P2 (dataRoot infrastructure).

### Layout

```
~/.mxd/projects/<projectId>/
├── config.json      (daemon-owned)
└── plugin/matrix/
    ├── tree.json
    ├── tasks/<taskId>.jsonl
    └── debug/<taskId>/<traceId>/last.json
```

A future `story1001` plugin with `dataRoot` defaulting to `@/plugin/story1001`
parks its own data at `projects/<id>/plugin/story1001/`, right next to matrix.
No top-level collision possible.

### Mechanism

Driven by **matrix's manifest** in `.mxd/plugin/index.ts`:
`dataRoot: "@/plugin/matrix"`. All path construction — `getTracker`,
`getEventStore`, `projectDebugDir`, `projectTreeJsonPath` — reads this
through `ctx.config.dataRoot` and routes through `resolveDataRoot` in
`src/data-paths.ts`. **The resolver stays the single source of truth** (the
`data-paths.test.ts` "ONLY data-paths.ts performs .slice(2)" grep test still
guards this).

**Helper**: `projectTreeJsonPath(dataDir, projectId, dataRoot?)` in
`data-paths.ts`, parallel to `projectTasksDir` / `projectDebugDir`. Used by
`runtime/helpers.ts:getTracker`.

### Gotchas

- **CLI tools that read JSONL directly** (e.g. `resolveTaskJsonlPath` in
  `cli-analyze-cache.ts`) must call `projectTasksDir(dataDir, projectId,
  "@/plugin/matrix")` — not hardcode the `projects/<id>/tasks/` path. Matrix
  is the only consumer of that helper today, so embedding the dataRoot string
  is fine; if more plugins need similar post-hoc tools, pass it as an arg.
- **In-process test harnesses** (`createApp` called without `dataRoot`) use
  the project-root layout by design. They exercise runtime semantics, not
  the matrix-plugin manifest layout. Tests that hardcode `projects/<id>/
  tree.json` in those harnesses stay correct.
- **Daemon-level tests** go through `createDaemon` → plugin discovery reads
  the manifest → matrix's `@/plugin/matrix` takes effect. A daemon-level
  test that hardcodes old paths will break; use `projectTreeJsonPath` with
  `ctx.config.dataRoot` (as done in `src/integration.test.ts` root-branch
  persistence test).

## P3: Tree is TaskNode | GeneralNode (folder becomes a GeneralNode variant)

Runtime exposes exactly two node kinds. Discriminator is `type: string`,
required on every node, no `undefined` fallback.

- **TaskNode** (`type: "task"`): launchable, has session + git branch +
  status + lifecycle. Matrix's actual work units.
- **GeneralNode** (`type: string`, anything except `"task"`): pure metadata
  + tree position, no session, no lifecycle, no agent. Optional
  `metadata?: Record<string, unknown>` — opaque to runtime, plugin-owned.
  NO `plugin` field — each tree.json belongs to exactly one plugin by
  construction; plugin identity is implicit.

Matrix uses `type: "folder"` as its only GeneralNode flavor today. A
future plugin in its own project could define its own types
(`"chapter"`, `"note"`, …) without touching runtime code.

### Type guards

`src/types.ts` exports:
- `isTask(node)` — narrows to `TaskNode`, `node.type === "task"`.
- `isGeneral(node)` — narrows to `GeneralNode`, `node.type !== "task"`.

`isFolder` is **matrix-plugin-local**, not runtime-exported. Lives in two
places:
- `src/orchestrator-tools.ts` — backend (matrix's MCP tool handlers).
- `.mxd/plugin/web/types.ts` — frontend (tree UI, drag/drop, icons).
Both are `(node) => isGeneral(node) && node.type === "folder"`.

### Tracker API

`TaskTracker.addGeneralNode(title, parentId, type, metadata?)` — one
method covers every non-task node. Rejects `type === "task"`. Matrix
callers pass `"folder"`; tests for other plugins can pass any string.

### MCP tools

User-facing tool names unchanged: `create_folder`, `delete_folder`,
`rename_folder`. Internals call `tracker.addGeneralNode(title, parent,
"folder")`. Matrix-specific syntactic sugar on the general-node API.
Agents cannot create generic GeneralNodes via MCP; matrix-plugin
decides what kinds its agents can create.

### Invariants locked in

- `TaskNode.type: "task"` — required, not optional (breaks `undefined`
  fallback idioms).
- `GeneralNode.type: string` — any string except `"task"`.
- `TaskTracker.addGeneralNode` throws if called with `"task"`.
- `TaskTracker.load()` throws on a node with missing `type`. Every save
  writes `type` explicitly — a typeless node means corrupted tree.json
  or a bug, not "legacy data".
- Runtime never reads `metadata` — it's opaque plugin data.

### What did NOT change

- tree.json serialization format (other than `type` now present on task
  entries, which was previously absent).
- MCP tool names (`create_folder` etc. preserved — matrix-plugin surface).
- Folder UX / UI rendering / drag-and-drop / lifecycle rejection.
- `getTaskAbove` / `getTasksBelow` / transparent ownership walks.

### Tests

`src/general-node.test.ts` — 10 tests exercising a probe-typed
GeneralNode (`type: "probe"`) through save/load, ownership walks,
tracker helpers. Proves generalization works outside matrix's
folder-only world.

## LLM Facility — stateless single-turn LLM for plugins (2026-04-23)

`src/llm.ts` — a thin, provider-agnostic wrapper around the existing provider
adapters. For plugins that need individual LLM calls outside the agent loop
(pipelines, one-shot generation, classifiers). **Strictly single-turn, no
tools, no session state.**

### Surface

```ts
createLLM({ authGroup, model, defaultThinkingEffort? }): LLMClient
runLLM(config, req): Promise<LLMResult>
streamLLM(config, req): AsyncIterable<LLMChunk>
```

`LLMChunk`:
```ts
| { type: "text_delta"; delta: string }
| { type: "thinking_delta"; delta: string }  // Anthropic only in v1
| { type: "final"; text; thinking?; usage; stopReason }
```

`LLMRequest`: `{ system?, user? | messages?, maxTokens?, thinkingEffort?, signal? }`
— exactly one of `user` / `messages`. No image input, no tool_use.

### Plugin idiom

```ts
import { createLLM } from "matrix/src/llm.ts";
import { resolveAuthGroup } from "matrix/src/config.ts";

const authGroup = resolveAuthGroup(effectiveCfg);
if (!authGroup) throw new Error("No auth group configured");
const llm = createLLM({
  authGroup,
  model: effectiveCfg.model,
  defaultThinkingEffort: effectiveCfg.thinkingEffort,  // plugin resolves once
});
const { text } = await llm.run({ system: "...", user: "..." });
```

**Plugin resolves from MatrixConfig itself**. The facility stays decoupled
from `MatrixConfig`/`RuntimeContext` shape — it only knows `AuthGroup`, model
string, and thinking effort number. Per-call `thinkingEffort` overrides the
default; unset → uses `defaultThinkingEffort` → unset → 0 (no thinking).

### Reuse strategy (audit-driven)

Leverages existing runtime aggressively — the facility is ~180 LOC of wiring
over existing adapter code:

1. **`adapter.callAPI`** (reuse) — already yields `text_delta`/`thinking_delta`
   and returns the raw SDK response. Facility drives it, normalizes chunks,
   extracts `final`. Two factory functions exposed via `export`:
   `createAnthropicAdapter`, `createOpenAIResponsesAdapter`.
2. **`adapter.buildResponseEvents(response, false)`** (reuse for Anthropic
   thinking extraction) — filter for `type: "thinking" && !redacted` events,
   concat. Redacted blocks dropped silently.
3. **`adapter.getTokenUsage` / `computeCost` / `getResponseText`** (reuse).
4. **`requestToRoleList`** — single helper maps `LLMRequest` to
   `[{role, content: string}]`. Both Anthropic's `MessageParam` and Matrix's
   OpenAI `HistoryMessage` accept this shape natively — no
   `buildAnthropicMessages`/`buildOpenAIMessages` wrappers needed.
5. **OpenAI reasoning extraction** — NEW code (~15 lines). No existing
   walker emits reasoning events for OpenAI Responses (only `message` and
   `function_call` surface in `buildResponseEvents`). Walks
   `response.output[].type === "reasoning"` items directly for `final.thinking`.
6. **Stop reason mapping** — NEW (~20 lines total across both providers).
   `adapter.getStopReason` returns `"end_turn" | "tool_use"` — too coarse
   for facility (can't distinguish `max_tokens`). Facility maps explicitly.
7. **SDK client construction** — DUPLICATED from provider class
   constructors (~40 lines). Not extracted this round (scope). Beta headers
   and timeout match `AnthropicCompatibleProvider` exactly. Note: any
   future change to beta headers must update BOTH the class constructor
   AND `createAnthropicClient` in `src/llm.ts`.

### Error / retry / abort

- Transient errors auto-retried by the SDK (5 attempts × exponential
  backoff), inherited from `callAPI`. No outer retry — caller can layer
  their own if they want more.
- Non-transient errors (401, 400) throw immediately.
- `signal.abort()` throws from the SDK; propagates as a thrown error from
  `run()` / mid-iteration in `stream()`.
- No `error` chunk in v1. Errors are exceptions.
- `max_tokens` hit → text still returned; `stopReason: "max_tokens"`
  signals truncation. Does NOT throw.

### What's NOT pulled in (by design)

Agent-loop concerns stay out: MessageQueue, JSONL EventStore, MCP tools,
`runProviderLoop`, compaction, budget, work context, debug snapshot,
session_config, session identity (fresh random sessionId per call — it's
used only for mock test-conversation keying inside `adapter.callAPI`'s
side channel, never visible to production).

`cache_control` breakpoints still emitted by `callAPI` on every call. 
Harmless for single-shot (nothing repeats to hit the cache), just a few
extra bytes per request.

### systemPreamble is honored

`AnthropicAuthGroup.systemPreamble` is passed through to
`createAnthropicAdapter` opts → prepended as first system block. A plugin
using the facility sees the same preamble an agent-loop call would. OpenAI
has no equivalent; `OpenAIAuthGroup` has no `systemPreamble` field.

### Testing discipline

Mocks must set `sessionId` for Anthropic (ValidatingMockAPI requires it
for conversation keying). Facility generates a fresh ULID internally and
passes it to `adapter.callAPI`, which writes it onto
`client._currentSessionId` (side channel). Mock picks it up from there.

OpenAI mock intercepts `globalThis.fetch` globally — facility has nothing
to configure; construction via `createLLM` with the mock fetch installed
just works.

Anthropic test pattern uses `_createLLMFromAnthropicClient(mockClient, ...)`
— test-only internal export that bypasses `createAnthropicClient`'s
credential resolution. Do not import from production code.

### OpenAI Responses mock: `response.output_text.delta`

`ValidatingMockResponsesAPI.buildTurnResponse` now emits a single
`response.output_text.delta` event per text block (between `content_part.added`
and `response.completed`). Real Responses API streams the output_text via one
or more delta events; the mock produces one delta carrying the whole text.
This makes the mock more accurate without breaking existing tests (they check
final content, not per-token granularity).

### Files

- `src/llm.ts` — ~560 LOC (incl. JSDoc)
- `src/llm.test.ts` — 18 tests, all providers × run/stream × error/abort paths
- `src/anthropic-compatible-provider.ts` — 1 line changed (`export function createAnthropicAdapter`)
- `src/openai-responses-compatible-provider.ts` — 1 line changed (`export function createOpenAIResponsesAdapter`)
- `src/test-utils/mock-openai-responses-api.ts` — +10 lines (delta emission)
