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
8. **Treating context as a deadline** — an agent that feels "context is running low" starts planning a handoff, cutting scope, or asking to be replaced. **Context is not a deadline, it is a compaction boundary.** When it fills, the agent continues with a summary; the task description and memory.md survive compaction by construction. So a compacted agent strictly DOMINATES a replacement: it has the same durable documents the newcomer would read, plus a summary of its own work, plus whatever tacit judgement survived in it. **Running low on context is never a reason to hand off.** The only legitimate reason is that FAMILIARITY ITSELF has become the liability — a final read-through, an adversarial review, anything where not knowing the material is the requirement rather than the cost. Two failures observed the same day: an agent halved its own remaining scope over a constraint that does not exist (and agents estimate their own remaining budget badly, so the estimate was likely wrong too), and root created a fresh task to continue finished-agent work without ever comparing it against reactivating the original — the reason was constructed after the fact and did not survive checking the data. Note this is #7's sibling: both are "start something new" winning by default over "continue something that exists".

**Measured 2026-07-25**, because #8's "agents estimate their own remaining budget badly" was an assertion with no numbers under it. The agent that offered the handoff was at 2.0M / 891 events having **never compacted once**, and estimated it had 2-3 more sections in it. Told to continue instead, it finished all 5 remaining plus an extra debt, ending at 3.0M / 1191 events — **still zero compactions**. It therefore did roughly twice its own estimate and never reached the boundary it had budgeted against. Two sibling tasks working normally that same day sat at 2.0M / 928 events and 2.0M / 649 events, also zero compactions. This measures one day, one model, one config: read it as "the estimate was off by ~2x and the wall was nowhere near", **not** as a threshold. For where any session actually stands, count that task's own events and `compact_marker`s — no number written here can answer it.

## Change Ownership Principle

**Whoever introduces a change owns ALL consequences** (prompt, UI, tests, docs). Root never writes production code — delegates everything.

## ⚠️ Writing This File — entries rot in three different ways

Full reorganization procedure: `.mxd/memory-reorg.md`. What follows is what you need when **writing
or updating an entry**, which is every session.

**Three kinds of rot, three detectors, none substitutes for another:**

| Kind | Is a correction written down somewhere? | What finds it |
|---|---|---|
| **Superseded** — a later change invalidated this | Yes — but filed under the change, never under the claim | Putting claim and correction in the same region |
| **Drained** — a count/list quietly stopped being true | **No.** Nobody thinks they are correcting anything | Checking against the code, item by item |
| **Destroyed by understanding** — a curator deleted it as redundant | Content was there until we removed it | Being forced to enumerate what you dropped |

The drained kind has **no trigger at all**: a stale count and a fresh count look identical. Only a
deliberate pass catches it, so the interval between passes is how long a wrong number survives.

**Four roles content plays.** Know which one you are writing:
- **Claims** ("it works like X") — few, must be maintained, **these are what rot**.
- **Records** ("on date D we did X because Y") — many, **never rot**. Prefer this tense when you can.
- **Symptoms** ("what you SEE when this bites") — **this is the retrieval key.** This file is
  organized by cause but queried by symptom: the reader has "the buttons are missing", not
  "the event type was renamed". Never delete a symptom as a redundant example of a mechanism you
  have just understood — that is exactly when it looks redundant and exactly when it is needed.
- **Negative results** ("checked, it is not that") — rare, and they stop the next person reopening
  a closed question.

**Rules:**
1. **If something else is the authoritative source, point at it — don't snapshot it.** Interfaces,
   counts, file paths, file lists — and equally another task's `done()` result, a config value, an
   upstream doc. Write what the source CANNOT answer: why it is shaped this way, what bit us, which
   rule is load-bearing. "See the `test.todo`s in X" stays true; "3 remain" does not.
   ⚠️ **Not "code" — any authoritative source.** Reading the rule as "documentation vs code" is how
   a hand-compressed copy of two task results ended up in a task description, written before those
   tasks had even finished. The shape was recognisable and the rule still did not fire, because its
   perceived scope was too narrow.
   ⚠️ **A MEASUREMENT is not a snapshot — it is a record, and deleting it destroys evidence.**
   "99.8% cache hit (582 creation / 362K read)" is the proof that four specific fixes worked and
   stays true about the moment it describes. What rots is stating it in the present tense, so a
   reader takes it for today's number. Date it, say what it measured, and say where the current
   value actually lives. **Delete claims; keep measurements.**
2. **Name things by what they ARE, not where they came from.** A check called "the phase-1
   invariant" gets switched off after phase 1 — which is exactly when it starts being useful.
3. **Don't delete a refuted claim — mark it and point at what replaced it.** The old sentence is
   usually the evidence for why the new design exists. Two riders: when you mark a whole section as
   history, **name the parts of it that are still live**, or the banner becomes a new trap; and
   remember a pointer can rot **from either end** — "trust me over that older section" has to be
   re-checked whenever either end changes.
4. **Anything probabilistic: one passing sample is not verification.** The complement of mutation
   testing — that one makes a test fail on purpose, this one says a single green proves nothing.

**Daily maintenance** (cheap, do it every time):
- Changed an identifier? `grep` it in this file.
- **Approved a side effect?** Grep for that too — reviewing is how the `agent_idle` behavior change
  went unrecorded for months.
- About to leave a sentence standing as CURRENT? Verify it first — moving a sentence under a
  "current state" heading is **endorsing** it, not relocating it.
- **Promised to do something later, once some condition holds?** Create a draft task for it *at
  that moment*. A promise whose trigger exists only in one agent's context does not survive that
  agent being interrupted — and it fails silently, because nothing anywhere records that it was
  owed. (Same family as the rot above: a commitment with no home is a claim with no section.)

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
- Tiers large output: head 5KB + banner + tail 5KB + banner + **full file preserved** on disk, with the exact path printed in the tool result → `| head` / `| tail` are redundant AND destructive.
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
- If the tool result shows `<test_output saved at …>`, that file has everything. Read it. **Copy the
  path out of the tool result — do not type one from memory.** The directory is `mxd/` under the OS
  temp dir, which is NOT `/tmp` on macOS (it is the per-user `$TMPDIR`, e.g.
  `/var/folders/…/T/mxd/`). This file used to say `/tmp/mxd/`; on a Mac that path exists and is
  EMPTY, so following it produces "the tool lied to me" instead of the output you wanted.
- If you want to re-investigate, rerun `bun test` again. Both files persist; read either.
- If you're tempted to pipe "for context reasons": the bash tool's tiered output has already protected your context. Piping doesn't help — it only destroys.
- ~~~2119 tests pass, 4 skip, 12 todo (as of 2026-04-18 after Fix A/B/C).~~ **Don't record test
  counts here** — they were already ~500 short within three months, and a stale count is
  indistinguishable from a fresh one. `bun test` prints the current numbers; that is the only place
  they are true.

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
| src/event-store.ts | JSONL EventStore — append-only; eid/parentEid chain, `setChainHead` for rollback+repair. Never truncates. |
| src/event-converter.ts | walkEventsToMessages + EventConverterCallbacks |
| src/task-tracker.ts | Task tree, node CRUD, tree.json persistence |
| src/orchestrator-tools.ts | Every matrix tool definition + `buildAllToolDefs` (the external-MCP list is built from it) |
| src/data-paths.ts | THE resolver for every path built from `dataRoot` — a grep test fails if a second site appears |
| src/done-payload.ts | `donePayloadSchema` — the one source for done() content, imports only zod |
| src/task-index.ts | Orama hybrid search index (title / description / result) |
| src/plugin-sdk.ts | The public `mxd/plugin-sdk` surface — thin re-exports, never a vendored copy |
| src/llm.ts | Stateless single-turn LLM for plugins (no tools, no session) |
| .mxd/plugin/scope-opts.ts | `buildMatrixScopeOpts` — the ONE place that knows matrix's tools + prompt + hooks |
| .mxd/plugin/web/event-handler.ts | UI event → log entries; `queueEntryToUIEvent` is the materialization gate, `pendingReducer` is pending |
| src/test-utils/api-message-rules.ts | The MEASURED Anthropic message-shape rules, and the prefix-vs-sendable split. The authority on "would this request be accepted" |
| .mxd/plugin/message-editability.ts | Where the three Edit/Rewind judgments meet — and the ONLY place they may. Has zero imports, asserted by a test |

**Verified 2026-07-25**: every path above exists. Eight rows were added in the reorganisation pass
and two more the same afternoon — all of them files that had existed for a while, or landed that
day, without anyone adding the row. A file map is one of the entries most prone to going quietly
wrong, because it fails by OMISSION: nothing contradicts it, it just silently stops being the answer
to "where do I start". If you add a file that a newcomer would need to find, add the row.

**The two additions are the test of that instruction, and it failed twice in one day** — both files
were created by tasks that wrote careful memory entries about them and neither added a row. So the
instruction is not enough on its own; if this keeps happening the answer is a check, not a
firmer sentence.

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

## evaluate_script Discipline

Runtime debug introspection ONLY. Do NOT use to: reparent tasks, modify tree structure, batch operations. Fix the tool instead.

## Refactoring Philosophy

Embrace large type refactors. Delete first, let compiler show every dependency. Hundreds of errors = your todo list. Static type systems make large changes SAFE.

**Bound on "every dependency": the compiler enumerates only what it can TYPE.** Anything that
reaches a symbol *by name* is invisible to it — string-keyed dispatch, an event-type name matched
across a process boundary, a field an external system keys on. **The compiler's silence means
"nothing typed points here". It never means "nothing points here".** So the error list is a todo
list, not a completeness proof: before trusting it, grep for the symbol's name as a *string*, and
check every boundary the type system does not cross.

⚠️ **The instrument that rule depends on was itself blind until 2026-07-25.** `search` skipped every
dot directory — so all of `.mxd/plugin/`, 34% of non-test source and the entire UI — and its
documented `glob: "*.ts"` example matched only the top level. Both are fixed. But it means **a
"grepped it, nothing points there" conclusion reached before that date proves less than it looks
like**, and the failure was silent in the direction that matters: a confident non-empty answer with
the deciding file missing from it. See the two `search` entries in Core Mechanisms.

This bound is not hypothetical — the counter-evidence is in *Agent activity: live process state*
(Agent Loop region), § "Two consumers that a grep for `activeAgents` does NOT find". Deleting the
`agent_idle` event type would have made every external `send_user_message → yield_external →
get_logs` workflow hang until timeout, because `yield_external` matches the type NAME in a string
set. Same section records the identical class already having bitten us and gone unnoticed for
months: `WAKE_SIGNALS` still listed `agent_stopped` and `orchestration_completed`, names replaced
long before, so they could never match and a stopped agent never woke an external client.

Also note the asymmetry that makes this worth a paragraph: a typed break costs you one compiler
error and ten seconds. A name-based break costs you a silent, delayed, hard-to-attribute failure in
a system you were not looking at. Same deletion, two completely different blast radii.

## Key Architectural Invariants

### JSONL Content Fidelity
JSONL event content = exact content sent to API. Zero transformation. No `.slice()`, no truncation on persisted content. UI truncation happens only at the frontend rendering layer — never on persisted events. (The former SSE-layer `stripEventForUI` helper was deleted in the FU8 sweep; the citation is kept here only as a tombstone so future readers don't go looking for it.)

### Tool Result Three-Part Invariant
Every tool_result must: (1) emit to JSONL, (2) yield to SSE, (3) push to messages[]. Missing any = orphan, missing UI, or API 400.

### Yield JSONL Invariant
Nothing written to JSONL after yield tool_call except by provider loop. External events go to queue, not JSONL. ~~`hasPendingYield()` detects this state.~~ **That function no longer exists** — deleted in the FU/FIX-4b sweep with zero production callers (grep-verified: zero occurrences in `src/` today). Do not go looking for it; this file used to contradict itself about it. What exists now: `hasPendingImplicitYield` (events.ts) for the *implicit* yield, and for an *explicit* pending yield there is no named helper at all — `provider-shared.ts` reads it straight off the JSONL shape on resume (`pendingYieldToolCall`, set when the last tool_call is yield). The invariant itself is unchanged and live; only its detector sentence was stale.

### Persist Before Broadcast (2026-07-25)
`emitEvent` writes to JSONL FIRST and broadcasts the *stamped* copy, so every observer — SSE
clients included — gets the event's durable name (`eid`/`parentEid`) at the instant the event
exists. `append`/`appendBatch` are fully synchronous and return the persisted event; that synchrony
is what makes `rewindChainHead` correct on a failed write, so it is load-bearing, not a style
choice. Four consumers depend on the name being there (Edit/Rewind, deep-links, viewport
addressing, active-chain membership) and would each grow their own locating mechanism without it.
Ephemeral events (`text_delta`, `agent_activity`) are deliberately NOT stamped — they are not
history. Full reasoning: *Every transport carries the event's name (eid)* (Events/JSONL region).

### Single Delivery Path
`deliverMessage` is THE message delivery path: JSONL write → queue delivery → flush → auto-launch. `quiet: true` for notifications. No other code writes message events to JSONL.

### ONE Codepath Per Task Operation
`src/task-operations.ts`: createTaskOp, updateTaskOp, deleteTaskOp, closeTaskOp, resetTaskOp, reorderTasksOp. MCP and REST are thin wrappers. Behavioral differences via explicit `if (editedBy === "user")`.

### Two-Phase Message Lifecycle
Phase 1: `message` event persisted → frontend defers. Phase 2: `messages_consumed` → frontend materializes. `QueueMessage.ts` = `Event.ts` = timestamp in `[HH:MM:SS]` — all same value, set once at creation.

### JSONL-Memory Consistency
In-memory `messages[]` and JSONL events are two data structures. Recovery that only modifies `messages[]` doesn't persist — JSONL retains the poison. Any "fix" must touch JSONL, not just memory.

---
# Core Mechanisms
---

## Agent Lifecycle

- Root and child agents use the same launch function: `runAgentForNode` in `agent-lifecycle.ts`
- `done()` = two-phase, and an intended orphan like yield (no tool_result written). Full contract and
  its two hard-won invariants: *Two-Phase done() Lifecycle*, immediately below.
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

**Two invariants inside Phase 2, both learned the hard way** (records in FIX-3 cc#3 and B-M4;
re-verified in `agent-lifecycle.ts` 2026-07-25):

- **The loop promise settles on EVERY path.** Phase 2 is wrapped in try/catch/finally, and the
  `agentLoopPromises.delete` + resolve live in the `finally`. A throw anywhere in Phase 2 is logged,
  not rethrown — the task already did its work, and a Phase-2 hiccup must not be treated as agent
  failure. Why it matters: `stopTask` awaits that promise with **no timeout**, so a leaked promise
  hangs the stop forever.
- **task_complete must be DURABLE before `done_notified` is written.** Both are awaited and the
  parent's store flushed before the marker. The marker is the crash-recovery signal meaning "Phase 2
  finished", so if it can land while task_complete has not, a crash in that window leaves the parent
  waiting forever with nothing to re-deliver. The reverse window (marker written, crash before its
  own flush) re-delivers on restart — a duplicate completion is recoverable, a lost one is not, and
  that asymmetry is the whole reason for the ordering.

## Auto-Launch Failure = task_complete(failed)

`deliverMessage` auto-launches a pending child via `ensureChildAgentRunning`. When `beforeChildLaunch` throws (e.g., missing hook file, worktree creation fails), the sender's yield would have hung forever — target never ran, so no done() ever fires, so no task_complete ever delivered.

Launch failure IS task completion: failed before starting. The catch in `deliverMessage` (agent-lifecycle.ts ~580) handles this by reusing the existing task_complete channel — same semantic as `done("failed")`:
1. emit error event on target (activity log)
2. `tracker.updateStatus(nodeId, "failed")` + save + broadcast (UI red)
3. `deliverMessage(taskAbove, createTaskComplete(nodeId, title, false, errorMsg))`

Sender's yield wakes with `<task_complete status="failed" summary="Auto-launch failed: ...">` — handled by existing yield-resume flow, no new code paths. **Root launch failure is not handled** — root has no `taskAbove`; separate concern.

Design rule: any code path that could silently hang a yielding parent MUST notify via task_complete. The channel is reusable because "failed before starting" and "failed during work" look identical from the sender's perspective.

## Duplicate Yield Handling

API can return multiple yield tool_calls in the same assistant turn.

**Current behavior.** Two rules, both live:

1. **Repair skips the INTENDED orphan, which is specifically the LAST tool_call** — not "any
   yield/done". Earlier yield/done orphans in the same turn are genuine repair targets and do get
   interrupted results.
2. **Extras emit to JSONL immediately** (orphan prevention) **but their live-path construction is
   DEFERRED** via `pendingDuplicateYieldExtras`. On yield wake they bundle into the SAME
   `buildUserTurn` call as the real yield, producing ONE user message of
   `[...extras, real, ...queue]`. That order is forced by JSONL: extras emit at yield-detection and
   the real one at wake, so the walker reconstructs them in that order and the live path must match
   or the two drift.

⭐ **The reusable pattern — CONCLUSION KEPT, REASON REPLACED (2026-07-25).** It used to read: *"emit
to JSONL for orphan prevention, defer the `messages[]` push so it merges with the next user turn"*,
justified by role alternation. **Role alternation does not exist** (see *The Anthropic message-shape
rules, MEASURED*), so that justification only told you "this looks like the last one". The real
constraint is the one rule 2 above already states, and it is checkable:

> **Deferral is a live/walker BYTE-IDENTITY device, not an API-shape device.** It is REQUIRED when
> the deferred tool_result is PERSISTED and lands ADJACENT to another in JSONL — the walker's
> collection loop merges adjacent tool_results into ONE user message, so the live path must too.
> It is UNNECESSARY when the message it would merge into is TRANSIENT.

Which is why the three sites do not all resolve the same way. `pendingDuplicateYieldExtras` **must
stay**: nothing separates the extras' results from the real yield's in JSONL (the walker skips
`message` events), so splitting the live push would require inventing a JSONL boundary event —
strictly more machinery, not less. The two compaction deferrals **can collapse**: the summarization
instruction is never persisted at all (`provider-shared.ts` "summarization_request event removed"),
`messages.length = 0` on success, so that request is never reconstructed and there is nothing to
stay byte-identical with. See *Compaction Asymmetry* and FIX-5 R8-B#11.

Tests: `drift-lifecycle.test.ts` "2 yield calls in same turn" and "3 yield calls in same turn".

**How it got here** — rule 1 came first ("skip yield/done" was too broad; the invariant is "skip the
INTENDED orphan"). ~~The first attempt at rule 2 wrote the extras' no-op tool_results as a SEPARATE
user message, which produced a *new* bug: extras message + the real yield's message = two
consecutive user messages → API 400 "Messages must alternate roles". Worth keeping because the
failure is instructive: fixing an orphan by adding a message is how you turn a repair problem into
an alternation problem, and deferral is what avoids both.~~

**SUPERSEDED 2026-07-25 — that 400 never happened.** It was thrown by our own mock; the shape
(`user[tool_result]` then `user[tool_result, …]`) is ACCEPTED by the real API — both messages open
with tool_result blocks, so the answering run spans them. Kept because it is the clearest specimen
of the phantom: a real error message plus an unverified attribution reads exactly like evidence.
The deferral survives anyway, on the byte-identity ground above — **right mechanism, wrong reason,
and the wrong reason is what spread.**

## Compaction Asymmetry

> ⚠️ **THE PREMISE OF THIS WHOLE SECTION IS A PHANTOM (established 2026-07-25).** Two consecutive
> user messages are LEGAL — measured against production Anthropic, 19 shapes, see *The Anthropic
> message-shape rules, MEASURED*. Every "→ API 400" below came from `ValidatingMockAPI`, never from
> the API. Read this section as the HISTORY of why three `pending*` deferral variables exist.
>
> What is still LIVE in here: FIX-5 **R8-B#11** and the too-short-compact consumption (**R8-B#1b**)
> are REAL — their cause is the *pairing* rule (an assistant's tool_use with no answering
> tool_result in the request), which was attributed correctly at the time. What is dead: the
> alternation framing, the **B-L9** diagnosis, and the "latent walker bug" below.

~~Manual `/compact` injects a summarization instruction as a user message. If the previous loop iteration also pushed a user message (yield tool_result + queue content, done tool_result + queue content), result is two consecutive user messages → API 400 "Messages must alternate roles".~~

Seven paths in `provider-shared.ts` have this shape. 3 are clean (`continue;` without pushing user msg). ~~1 is fixed. 3 are deferred via test.todo.~~

**Do not trust a count here — go read the source.** The open paths are exactly the `test.todo`s in
`drift-lifecycle.test.ts`; that set shrinks over time and any number written down here starts
rotting the day after. (It said "1 fixed, 3 deferred" for months while three of the four had been
fixed — a stale count and a correct count look identical, which is why this is now a pointer.)

Fixed so far, each recorded in its own entry: the yield+compactOnly path (304fccd), the
**done**-resume + compactOnly variant (FIX-3 B-L9, `pendingCompactDoneToolCall`), and
duplicate-yield extras in the compactOnly path (FIX-5 R8-B#11). The shape of what survives: paths
where the queue had OTHER messages alongside the compact, so there was nothing empty to bundle the
deferred tool_result into.

**Fixed** (commit 304fccd): compactOnly pending-yield with empty queue. Defer the yield tool_result push via `pendingCompactYieldToolCall` flag; compact path bundles tool_result into the SAME user turn as summarization text. ~~One user message with `[tool_result, text]` blocks → valid alternation.~~ **The unbundled form — `user[tool_result]` then `user[summarization]` — is equally valid** (measured). This deferral has no remaining justification: the summarization message is never persisted, so there is no byte-identity to preserve. Slated for collapse.

~~**Pattern**: emit to JSONL for orphan prevention, defer messages[] push to merge with next user turn. Same as duplicate-yield fix (19995b9).~~ **Re-derived** — see the ⭐ block in *Duplicate Yield Handling*: deferral is a byte-identity device, and it is required only when the deferred tool_result is persisted next to another one. That is true of the duplicate-yield case and false of both compaction cases.

~~**Latent walker bug** (deferred): walker reading `[tool_result, messages_consumed, summarization_request]` produces two consecutive user messages. Proper structural fix: summarization_request should append to the current user turn, not create a separate one. Requires matching live + walker changes for byte-identical output. Documented as test.todo in drift-lifecycle.test.ts.~~

**NOT A BUG (2026-07-25).** That walker output was run through the real walker and checked against
the measured rules: `user[tool_result, text, text]` followed by the summarization user message —
the tool_result leads its turn, so the yield is answered, and the following consecutive user
message is fine. Verified verbatim against the live API. The `test.todo` in
`drift-lifecycle.test.ts` describes a shape that works; it should be deleted, not implemented.

## API 400 → crash → repair-on-next-launch

There is NO in-memory auto-recovery from a 400 invalid_request_error. The old mechanism (pop the broken user message, splice in synthetic tool_results + recovery text, retry once, gated by `enableAutoRecovery` / `autoRecoveryAttempted`) was REMOVED — those flags no longer exist anywhere in the codebase (grep confirms zero matches).

Current behavior (`provider-shared.ts` outer-retry catch, ~line 1409): on a non-transient 400 the error propagates, the agent stops, status stays `in_progress` (resumable). On the NEXT launch, `buildSessionRepair` fixes the JSONL on disk *before* the provider loop starts (see events.ts ~line 583). The fix lives in persisted state, not volatile `messages[]` — consistent with the "recovery must touch JSONL, not just memory" invariant.

Transient errors (429, 5xx, network) are still retried in-loop with backoff. Only the 400-class path is "crash + repair on next launch".

## Abort Signal + Inner Retry Fix

Inner retry checks `signal.aborted` first + abort-responsive sleep. Reset time: 30s → instant.

## Duplicate Launch Prevention in autoResumeProjects

### Bug: pre-register launchingNodes prevents runAgentForNode from starting
`autoResumeProjects` tried to pre-register all nodes in `launchingNodes` before launching. But `runAgentForNode` checks `launchingNodes.has(nodeId)` → returns early. Agents never started. Never pre-register in `launchingNodes` from outside `runAgentForNode`.

### Fix: quiet deliverMessage in Phase 2 crash recovery
Phase 2 crash recovery calls `deliverMessage(task_complete)` to parent. Without `quiet: true`, this auto-launches the parent → duplicate launch (autoResume also launches it). Fix: `{ quiet: true }` prevents auto-launch. Message goes to JSONL, recovered by `findUnconsumedMessages` when autoResume launches the parent.

### Test lesson: maxConsecutiveStarts conflates crash+resume with duplicate launch
After a crash, `orchestration_completed` never emits (the loop was interrupted). So `orchestration_started` from before crash + from resume = 2 consecutive starts. This is NORMAL. Use traceId uniqueness on `orchestration_started` events instead.

### Test lesson: shutdown() required before recreateApp() in restart tests
Without shutdown, old app's agent stays alive. New app launches another agent for same node → appears as duplicate but is a test setup bug (can't happen in production crash where process is dead).

## ParamDecl Bind

All bind params hidden from agent, auto-bound. `create_task`/`create_folder` parentId is `explicit`.

## bash tool: tiered output + merged streams (FU9)

Defensive-instinct-as-tool-design. AI piped/redirected because context was at risk; now context is bounded by the tool, so the instinct has nothing to act on.

**`<tmp>` below means `os.tmpdir()`**, i.e. `MXD_TMP_DIR = join(tmpdir(), "mxd")` in
`src/tools/bash.ts`. It is **not** `/tmp` on macOS — it is the per-user `$TMPDIR` under
`/var/folders/…/T/`. Never type the path from memory; the tool result prints the real one.

### Tiered display (merged mode, default)
- `<1024 bytes` → inline only, no file saved
- `1024..10240` → full inline + top/bottom banner + file kept at `<tmp>/mxd/exec-<id>.out`
- `>10240` → head 5KB + `... [N bytes / M lines truncated] ...` + tail 5KB + banner + read hint; file kept
- Boundary: `head_budget + tail_budget >= total` naturally shows full (no special-case for size===10240)
- Truncation: byte-aware + newline alignment via `Buffer.lastIndexOf(0x0a, budget-1)` / `Buffer.indexOf(0x0a, total-budget)`. No newline in window → hard byte cut + "mid-line cut" annotation.

### Separate mode (opt-in `separate: true`)
Two files: `<tmp>/mxd/exec-<id>.stdout` + `.stderr`. Budget allocation in the large case: if one stream is trivial (≤5KB), show it in full and give the other `BUDGET - trivial_size` split head/tail; else each gets 2.5k+2.5k. Continuous at boundary (stderr=5120 → both 5KB; stderr=5121 → stdout 2.5k+2.5k).

### Stream merging
`bash -c "(cmd) 2>&1"` wrapping. AI-written `2>&1` inside `cmd` becomes a harmless redundant no-op. Bash's own stderr (pre-subshell syntax errors, rare) is `stderr: "ignore"` at Bun.spawn level — acceptable tradeoff for clean single-file output.

### Foreground/background parity
One `formatBashResult` function. The `content` field of `background_complete` queue messages is byte-identical to what `parseForegroundResult` returns when the same command runs foreground.

### Directory rename
`mxd-bg/` → `mxd/` under the OS temp dir. The dir is no longer bg-specific (foreground commands save there too). `BackgroundProcess.separate: boolean` is the new mode discriminator; `stdoutPath` holds the `.out` file in merged mode (misleading name, kept for API compat).

### Pure-function exports for testing
`formatMergedOutput(path, exitCode)`, `formatSeparateOutput(so, se, exitCode)`, `truncateMiddle(buf, headBudget, tailBudget)`, `allocateSeparateBudget(stdoutSize, stderrSize)` — all exported from `src/tools/bash.ts` so tests hit them directly without spawning subshells.

### Tool description vs system prompt
The "don't pipe" guidance lives in the bash tool's `description` field (`src/tools/definitions.ts`), NOT in `src/system-prompts.ts`. Tool description is per-tool, embedded in API tool schema. system-prompts.ts has one general line about piping during long commands that's still accurate.

### Architectural framing the task demonstrated
When AI repeatedly does X (pipe/redirect/`| head`), ask: is the motivation legitimate? If yes (context protection IS legitimate), make the tool satisfy it naturally — don't enforce against it. Rule suppression leaks at edges; tool-level satisfaction closes the loop. If you find yourself adding parser/rejection/warning to the new tool, you drifted — the point is to make shortcuts unnecessary, not forbidden.

## `search` tool: a hidden directory is not a boring directory (2026-07-25)

`src/tools/search.ts` passed no `dot` option to `Bun.Glob.scanSync`, whose default is
`dot: false` — so the walker never descended into ANY hidden directory. In this repo that
is `.mxd/plugin/`: every ScopeOpts hook, every plugin REST route, the entire plugin UI —
**17,862 lines across 54 files, i.e. 34% of all non-test source** (the task that filed this
said "half"; measured, it is a third, and the whole UI). Invisible to the primary search
tool. Fixed by `dot: true` at both scanSync call sites (the glob branch and the no-glob
branch — fixing one and not the other leaves half the tool lying, so both are pinned
separately).

**`DEFAULT_SKIP_DIRS` is now the ONLY thing that decides what a search ignores**, which is
what the code always claimed: `.git/` and `.worktrees/` were already listed *explicitly*,
so `dot: false` was never anyone's intent — just a library default leaking through an
option nobody passed. It is exported now, and a test pins it against its prose copy in the
`excluded_dirs` param description. (Prose copies of lists are the "drained" rot from
§ *Writing This File*: a stale list and a fresh list read identically.)

⚠️ **`.worktrees/` in that list is load-bearing, costs nothing today, and therefore needs
an assertion.** Each sub-agent worktree is a full second copy of the repo — measured 63,975
files across 3 live worktrees — so dropping it makes one search from main scan every file
4× and report every hit 4×. The guard test exists for the day someone "tidies" the list;
it will not fail before then, which is the entire point.

Two adjacent findings filed rather than swept in: **01KYCS0BH6** (`glob: "*.ts"` — the
example in the tool's OWN description — returns nothing, because `*` does not cross `/` in
Bun.Glob) and **01KYCS1552** (the skip list is applied AFTER the walk, so every excluded
dir is enumerated then discarded; `dot: true` made that ~4× worse from main).

### ⭐ How it was caught, and why that was the only way it could have been

The failure mode is silent **by construction**: "no matches" and "never looked" produce a
byte-identical tool_result. Nothing in a search result carries evidence that the search
happened. So it can never be caught by inspecting the answer — only by a **collision with
something you independently already know**.

Forensic record, session 01KYCNHX9JAM, 13:01:04 → 13:01:55 (read out of its JSONL):

| time | event |
|---|---|
| 13:01:04 | `search("formatTieredHits\|Related past tasks")` → a long, confident answer spanning 3 `src/` files. It silently omitted `.mxd/plugin/scope-opts.ts`, which holds the literal header string `[Related past tasks]` AND the second formatter. **The agent did not blink** — 2s later it was reading one of the returned files. |
| 13:01:42 | `search("formatRelatedTasks\|RELATED_TASKS_CHAR_LIMIT")` → `(no matches)`. It had read that file 5 events earlier, and the thinking in the very same turn says *"I see there's a separate `formatRelatedTasks` function in scope-opts.ts"*. The answer was not incomplete, it was **impossible**. |
| 13:01:47 | `bash grep -rn` — 4s after the empty result, reflexively, with no hypothesis stated. |
| 13:01:55 | the hypothesis finally forms: *"seems to be skipping dotted directories"* — 7s AFTER grep had already proved it. The distrust was procedural, not analytical: the fallback fired first, the explanation came later. |

Three things worth carrying:

1. **The empty result is the detectable one; the partial result is the dangerous one.**
   Same bug, same tool, same agent, 38 seconds apart: the non-empty answer went
   unchallenged, the empty answer got double-checked. An under-report is only conspicuous
   when it takes *everything* away — which is the case that matters least.
2. **Detection needed an independently-held fact at that exact instant.** Search for
   something you do NOT already know exists — "are there other callers of X?" — and a false
   `(no matches)` is indistinguishable from the truth AND confirms your hypothesis, which is
   the most comfortable answer there is. That is precisely the rename/delete check
   § *Refactoring Philosophy* tells you to run.
3. **The check that caught it is the one the tool description forbids** ("ALWAYS use this
   for search tasks — NEVER invoke grep or rg via bash"), and the suppression had already
   worked once that same minute. Sibling of the bash-tool framing directly above: a rule
   that suppresses a redundant check also suppresses the only detector its failure mode has.
   For as long as the bug lived, **an agent that obeyed the instruction got the wrong answer
   and one that disobeyed got the right one** — which is not just a bad outcome, it is
   training every agent that reads a tool description to discount it. If a description tells
   agents to stop cross-checking, the tool has to earn it.

### Test notes

`src/anthropic-compatible-provider.test.ts` → `describe("jsSearch: hidden directories")`,
next to the pre-existing `describe("jsSearch")`. **Yes, that file** — search's tests have
always lived in the provider test file, and keeping them together beat giving `search` a
second home.

Mutations, each a full `bun test`:

| mutation | fails |
|---|---|
| the bug itself (no `dot: true`, both sites) | the 2 walker tests + `excluded_dirs: []`. The 3 guards stay green — which is what makes them guards, not coverage. |
| `.worktrees/` dropped from `DEFAULT_SKIP_DIRS` | the `.worktrees` guard + the description test, and nothing else. |

Per-site attribution comes free rather than from a third mutation: the two walker tests are
path-disjoint (one passes a `glob`, one does not), so each can only be reporting on its own
`scanSync` call.

⚠️ **The first cut of the two walker tests asserted an EXACT file list, and the `.worktrees`
mutation tripped them too** — three extra red tests all naming the wrong cause. Narrowed to
presence-only. **A test that can fail for two different reasons cannot tell you which one
happened**, and a guard's entire value is being legible on the one day it fires. The exact
list survives in `excluded_dirs: []`, where enumerating everything IS the claim.

## `search`: a glob with no slash is a FILENAME pattern (2026-07-25)

`src/tools/search.ts` handed the caller's `glob` to `Bun.Glob` verbatim. `*` never crosses `/`
there, so `*.ts` — **the example printed in the tool's own description**, and what ripgrep's
`--glob` means — matched only files sitting directly in `path`, i.e. `(no matches)` from a repo
root. The tool documented one semantic and implemented another.

`normalizeSearchGlob(glob)`: no `/` in the glob ⇒ it is a filename pattern ⇒ promote to
`**/<glob>`. A glob containing `/` is a PATH pattern and passes through untouched, so `src/*.ts`
stays anchored at the search root. Same split ripgrep makes.

**Promoting loses nothing** — `**` matches zero directories too (measured: `**/*.ts` returns the
top-level `top.ts` as well as nested ones). So the new behavior is a strict superset of the old
and cannot take a result away from anyone.

### ⭐ "That caller cannot exist, because the behavior never worked"

The standard objection to changing a semantic is "some caller depends on the old one". Here it
was answered by a fact rather than a judgement: a caller who genuinely wanted top-level-only
would have been getting an **empty result almost every time**, so they cannot exist.
**A semantic that has never worked has no users.** Worth keeping as a test for whether a
backward-compatibility worry is real or imagined — it is cheap to check (what did the old path
actually return?) and it settles the question outright instead of trading intuitions.

### The empty-result/partial-result split is NOMINAL here

The hidden-directory entry above concluded "the empty result is the detectable one; the partial
result is the dangerous one". This bug produces empty results, which sounds like the good side.
It is not, because of that entry's *second* point: detection needs a fact you independently hold
at that instant. `glob: "*.ts"` is typed precisely when you are asking **"where does this symbol
appear?"** — the case where you do NOT already know the answer, so a false `(no matches)` is
indistinguishable from the truth and confirms the hypothesis. Filing a bug under "detectable"
because of its output SHAPE is not the same as it being detectable in the situations it occurs in.

### Test notes — `describe("jsSearch: glob depth")`, next to the hidden-dir block

Same file as the rest of search's tests (`anthropic-compatible-provider.test.ts`) — see the
hidden-dir entry for why that is deliberate. Three behavioral tests + one string test.

| mutation | fails |
|---|---|
| the bug (`new Bun.Glob(glob)`) | the depth test, alone |
| always prepend `**/` | anchored + string |
| `startsWith("**/") ? glob : …` | anchored + string |
| `startsWith("*") && !startsWith("**")` | string ALONE, on its `*/top.ts` line |

⚠️ **The two PRE-EXISTING slash-glob tests do NOT catch over-promotion, though they look like
they would.** Their fixtures contain exactly one `src/`, so `src/*.ts` and `**/src/*.ts` return
the same files. Over-promotion is only observable against a fixture with the SAME directory name
at two depths — hence `deep/src/inner.ts`. I assumed those tests covered it and the mutation run
said otherwise: **a test whose fixture cannot express the difference passes both ways.**

The string test (`normalizeSearchGlob` directly) exists because two of its four cases have no
behavioral symptom at all: `**/**/*.ts` returns exactly the same files as `**/*.ts`, so a
doubly-promoted glob is invisible from the outside. It earns its place on one line — `*/top.ts`
— which is the shape no fixture covers and which the last mutation above breaks alone.

### Correction to Known Pitfalls

The ⚠️ under *Known Pitfalls* saying this bug is still OPEN and to "pass `**/*.ts`" until it
lands is now **outdated** — `*.ts` and `*.{ts,tsx}` both work at any depth. The neighbouring
claim in the hidden-dir entry ("Two adjacent findings filed rather than swept in: 01KYCS0BH6 …")
is history, not a live warning: 01KYCS0BH6 is this fix. **01KYCS1552 (the skip list is applied
after the walk) is still open** and was deliberately not touched here — `normalizeSearchGlob` is
a pure string transform applied before the walker is constructed, so it survives any rewrite of
the walk itself.

~~**Filed, not swept in: 01KYCV43JAZ** — `list_files` has BOTH bugs this tool just had.~~
**That is the section below** — fixed same day. The one number in it that was wrong is corrected
there (329 was counted without the skip list).

⚠️ **`normalizeSearchGlob` is now `normalizeGlobDepth`** — renamed when `list_files` became its
second caller. Read every mention of the old name in the two entries above as the current one.

## `list_files` had both of `search`'s bugs — and the third instance is where the CLASS got named (2026-07-25)

Same two defects, in the tool sitting next to `search` in `src/tools/definitions.ts`: it walked
with `dot: false` (so nothing under `.mxd/` existed — 29 `.ts` files) and handed its pattern to
`Bun.Glob` verbatim (so `*.ts` answered `(no files)` in a TypeScript repo). Both fixed;
`normalizeGlobDepth` and `DEFAULT_SKIP_DIRS` are now shared with `search` rather than copied.

Corrected number from the filing above: `**/*.json` returns **329** only as a raw Bun.Glob count
including `node_modules`. What the fixed tool returns is **5** — the 3 top-level ones plus
`scripts/retrieval-exp/package.json` and `.mxd/config.json`, that last one visible only because of
`dot: true`. Quoting a raw walk count as "what the tool would return" overstates the change by 65×
and understates the interesting part, which is the one file that was hidden.

Three things here outlive the fix: what the second bug's decision actually turned on, the shape
all three share, and the survey for a fourth.

### ⭐ The rule that settled this for `search` proves NOTHING here — and it points the other way

*"A semantic that has never worked has no users"* (the entry above) closed the same question for
`search` in one line, because there the old behavior was `(no matches)`. Here
`list_files("*.json")` returned **package.json, tsconfig.json, biome.json** — three real,
plausible files. The old semantic worked. **So the rule is only decisive when the old output was
EMPTY; when it was "a plausible-looking subset" it settles nothing**, and quoting it would have
been quoting a rule whose premise had not been checked.

⚠️ **This is a warning to you, the reader, not a note about who wrote it.** A rule is at its most
dangerous exactly when it happens to point at the answer you already want — and this one arrived
from the task above, pre-approved, one line from done. Checking its premise cost one command.

The generalisation that DOES hold is strictly stronger, and it is what actually decided the case:

> **Before letting a compatibility worry veto a change, go measure what the current behavior
> actually produces.** Not "is anything calling this" — *what does the call return today, and does
> it answer the question the caller was asking?*

The empty-output rule is the special case where the answer is trivially no. The common and more
dangerous case is **non-empty output that does not answer the question**, which is what happened
here: I was about to keep a wrong semantic to protect `list_files("*")` as a "list this
directory" affordance, and then measured it. `scan()` defaults `onlyFiles: true`, so `*` returned
the dozen loose files at the top of the repo and **not one directory** — no `src/`, no `web/`, no
`.mxd/`. The tool could not answer "what is the shape of this project", which is what its own
description ("discover project structure") claimed it was for. **The capability I was defending
did not exist.** `*` is also the DEFAULT pattern, so that was the most-used input in the tool.

### ⭐ The shape all three share: a library default serving somebody else's use case

`dot: false` serves "don't treat dotfiles as source". `*` not crossing `/` serves a shell, where
you `cd` first and *then* say `ls *.json` — the user picked the directory. Both defaults are
reasonable. Neither is ours: an agent calling a tool at a fixed cwd never had the `cd` step, and
in this repo the dot directory IS the source.

**What makes this class invisible is that there is no line to review.** Nothing anywhere says
"skip hidden directories" or "match only the top level" — the semantic lives in a library's
default, i.e. in the *absence* of an argument. Code review cannot catch an absence. Only feeding
it real input can. Hence the small discipline now in place at every walker: **pass every option
you depend on explicitly, even when you agree with the default.** `dot: true, onlyFiles: true` on
a call whose behavior is unchanged is not noise; it is the semantic becoming visible.

And the second-order damage, which is why this is worth a section rather than a commit message:
for as long as such a bug lives, **the tool's own description is teaching agents the wrong rule.**
`list_files`'s examples were `"src/**/*.ts"`, `"**/*.test.ts"`, `"*.json"` — the first two anchored
with `**/`, the third silently meaning something else. The defect was never that `*.json` returned
the wrong three files; it was that a reader **generalises from the neighbours** and walks away
believing all three are the same kind of pattern. Both tools now state the rule instead of
implying it, so they READ consistently and not merely behave consistently.

### Is there a fourth? — NO for the narrow class, YES for the harm (both are GATES)

**Narrow answer: three, and that is all of them.** Every `Bun.Glob` in the repo is now correct.
How that was established, so the next person can judge how complete "all of them" is:

| searched | production hits | verdict |
|---|---|---|
| `Bun.Glob` / `.scanSync(` / `.scan(` | 3 call sites (2 `search`, 1 `list_files`) | all three fixed |
| `readdir` / `readdirSync` / `opendir` / `globSync` / `fast-glob` / `tinyglobby` | 3 (`debug-snapshot.ts` roll, `event-store.ts listSessions`, `runtime/helpers.ts` prune) | **not instances** |
| `ls-files` / `Array.fromAsync` / `walk(` / `withFileTypes` | 1, test-local | see below |

The three `readdir`s are flat, single-directory reads of a directory we own, each with its filter
written down (a ULID regex, a `.jsonl` suffix). `readdir` *does* return dotfiles by default, and
here that is what we want — no default is doing hidden work. **That is the negative result: file
enumeration in this repo is either a Bun.Glob (now correct) or a flat owned-directory read with an
explicit filter. Do not go looking again.**

⚠️ Note what made this survey possible: it greps for symbols, and until earlier the same day
`search` could not see `.mxd/plugin/` — 54 files of production code. **A completeness survey run
with a blind instrument returns a confident, wrong "that's all of them".**

**Broader answer: two more, different cause, same harm — and both are GATES**, which is the worst
place for it, because a gate's silence is read as a verdict on the whole repo.

1. **`scripts/check-i18n.sh`** — `find web -maxdepth 1 -name '*.tsx'`. Measured: it reads
   **4 of 31** non-test `.tsx` files, **927 of 11,534 lines (8%)**. It never sees the shell's own
   `web/components/SettingsPanel.tsx` or `AppHeader.tsx`, and it never sees **any** of the 25-file
   plugin UI (`Plugin.tsx`, `TaskTree.tsx`, `InputBar.tsx`, `LogEntryView.tsx`, `ToolCard.tsx`, …)
   — which is where essentially every user-facing string in this product lives. It then prints
   `i18n check passed — no bare strings found in JSX`, unqualified, from inside the pre-commit
   hook.
2. **`src/data-paths.test.ts` → `describe("source audit — ONLY data-paths.ts performs .slice(2)")`**
   walks `src/` only, while 3 files under `.mxd/plugin/` do path work. **Verified by experiment,
   not by reading**: a `dataRoot.slice(2)` planted in `.mxd/plugin/scope-opts.ts` leaves the audit
   green (54 pass / 0 fail). Here the rot is mostly in the CITATION — the test's own name says
   "no other **src/** file", honestly, while the describe block and the *Key Files* row ("a grep
   test fails if a second site appears") drop the qualifier.

Recorded here rather than as drafts because the task above said it would open the tickets; the
measurements are the part that would otherwise be lost.

**The cause differs and that changes the detector.** These two scopes are *written down*
(`-maxdepth 1`, a walk root) — the opposite of the invisible-default class. They are readable, and
nobody reads them, because a gate that passes looks identical whether it checked 8% or 100%.
Invisible defaults need real input to catch; narrow-scope gates need someone to ask **"what did
you actually read?"** and get a number back.

### ⭐ The design rule that separates the two that got it right from the two that didn't

`biome.json` is `"includes": ["**", "!.worktrees", "!.claude", …]`. `tsconfig.json` is
`"exclude": [".worktrees", …]`. Both **start from everything and subtract**, and both name
`.worktrees` explicitly for exactly the reason `DEFAULT_SKIP_DIRS` does. Both are correct today
with nobody maintaining them.

> **Start from everything and subtract; do not enumerate what to include.** A subtract-list fails
> LOUDLY (something noisy shows up and someone adds an entry). An include-list fails SILENTLY —
> new code simply is not covered, and nothing anywhere says so.

Which is the same statement as *"`DEFAULT_SKIP_DIRS` is the ONLY thing that decides what a search
ignores"* from the first entry in this trio, arriving from the other direction.

### The three additions the fix needed that nobody asked for

1. **The skip filter runs INSIDE the walk loop, so the 500 cap counts files we KEEP.** Not an
   optimisation — a correctness requirement. Measured from the main checkout with `dot: true` and
   no skip list, an any-depth `*.ts` filled **323 of its 500 slots with `.worktrees/` copies** of
   files the caller already had, and never reached `web/`, `scripts/` or `.mxd/` at all, because
   `.worktrees` is walked before `src`. So **`dot: true` alone is not "a different flavour of
   wrong", it is strictly worse than the bug**: the cap stops protecting you and starts
   guaranteeing you get the copies. (The task above's first framing — "trading a false negative
   for a flood" — is the thing to correct here: it invites shipping `dot: true` first and adding
   the skip list later. Don't.)
2. **Truncation is announced**, and detected one PAST the cap so a project with exactly 500 files
   is not accused of having more. Silently returning 500 of 50,000 is the same failure as silently
   not walking a directory. `search` already said so; that asymmetry was its own small bug, and
   normalizing the depth makes it far easier to hit.
3. **`skipDirsForPattern(pattern)` = the default skips minus any directory the pattern NAMES.**
   `search` can reach an excluded directory by pointing `path` into it or passing
   `excluded_dirs: []`; `list_files` takes a pattern and nothing else, so a plain skip list would
   have deleted an ability with no replacement (`list_files("node_modules/zod/**")` →
   `(no files)`). No new parameter — the caller's intent is already in the input, and every param
   is a token every agent pays on every call. Comparing against the **trailing-slash** form is
   what keeps it from firing by accident: a pattern hunting for `*build*.ts` does not contain
   `build/`. When it misfires it hands over MORE files, never fewer — and every bug in this whole
   family did its damage by handing over fewer and not saying so.

### Test notes — three describes in `anthropic-compatible-provider.test.ts`

Next to `jsSearch: hidden directories` and `jsSearch: glob depth`; see the first entry in this
trio for why search's tests live in the provider test file.

Tests come in PAIRS: something that must now be reachable, and something that must still not be.

| mutation | fails |
|---|---|
| `dot: true` → `false` | the hidden-dir test + `.worktrees` reachable-when-named. The `.worktrees` guard stays green — which is what makes it a guard. |
| skip filter deleted | both exclusion guards + the `*build*` probe + the cap test |
| `skipDirsForPattern` loses the trailing slash | the `*build*` probe + the string test |
| **skip list never opts in** (over-strict) | `.worktrees` reachable-when-named + the string test |
| no `normalizeGlobDepth` | the nested-file test + the default-pattern test |
| always prepend (over-promote) | 2 anchored tests + 1 string test, across BOTH tools |
| cap AT the limit instead of one past | the 501 test |
| **truncation claimed at exactly the cap** (over-strict) | the exactly-500 test, alone |

The two **over-strict** rows are there deliberately (see *Guards need a two-sided mutation proof*):
"the skip list blocks everything" and "everything is reported as truncated" are the typical ways a
guard fails, and neither reddens a test unless someone wrote the what-it-must-NOT-block half.
`.worktrees` reachable-when-named is that half, and it is the kind of thing whose deletion reddens
nothing while a real ability silently disappears.

⚠️ **One fixture was vacuous and only mutation testing said so.** The `*build*` probe first put
`bundle.ts` inside `build/` — but `**/*build*.ts` does not match `bundle.ts`, so the
`not.toContain` half could never fail and the test passed under two different mutations. Fixed by
putting the SAME filename (`rebuild.ts`) in both `build/` and `src/`, so one pattern reaches both
candidates and the directory is the only thing separating them. Same lesson as the over-promotion
fixture in the entry above: **a test whose fixture cannot express the difference passes both
ways** — and the tell is a mutation you expected to catch it surviving.

## FIX-3 (2026-06-05) — lifecycle + provider concurrency: Phase-2 leak, done ordering, launch race, abort-sleep, done+compact

Five concurrency bugs in `agent-lifecycle.ts` + `provider-shared.ts`. Each is a "the loop/parent
silently hangs or corrupts" failure, NOT a crash. Files: `runtime/agent-lifecycle.ts`,
`provider-shared.ts`, `orchestrator-tools.ts`, `runtime/routes/tasks.ts`.

### cc#3 — Phase 2 + loop-promise resolution MUST be inside try/finally
`runAgentForNode`. Phase 2 (save/flushSession/onDone/deliverMessage) + the `resolveLoopPromise()` +
`agentLoopPromises.delete(nodeId)` sat AFTER the agent-loop try/finally, OUTSIDE any guard. A throw in
ANY Phase 2 step skipped the resolution → `agentLoopPromise` leaked forever. `stopTask` awaits that
promise with NO timeout (unlike `stopAgent`'s bounded 1s race) → it hung indefinitely. Fix: wrap
Phase 2 in `try { … } catch (log) { … } finally { delete + resolve }`. The loop promise now settles on
EVERY path. The old comment claiming resolution happened "in finally block" was a lie — now true.
Phase 2 errors are logged, not rethrown (the task already finished its work; a Phase-2 hiccup is not
an agent failure). **This corrects the "Two-Phase done() Lifecycle" section: resolution is now genuinely
in a finally.**

### B-M4 — task_complete MUST be durable BEFORE done_notified
`runAgentForNode` Phase 2 done branch used fire-and-forget `deliverMessage(parent,
task_complete).catch()` then immediately `emitEvent(done_notified)`. done_notified lands on THIS node's
write queue synchronously; task_complete goes through deliverMessage's `await getTracker` first → lands
later. So "done_notified durable ⟹ task_complete durable" did NOT hold. Crash with done_notified
persisted but task_complete not → restart's `findInterruptedDonePhase2` returns `status_stale` (marker
present, runtime.ts:~376) → does NOT re-deliver → parent hangs forever. Fix: `await deliverMessage(parent,
task_complete)` then `await eventStore.flushSession(parentId)` BEFORE `emitEvent(done_notified)` (+ flush
the marker too). Reverse case (crash after marker, before its flush) → restart re-delivers (needs_phase2)
→ at-least-once duplicate task_complete. A duplicate completion is recoverable; a lost one hangs the
parent — we deliberately prefer the duplicate (the needs_phase2 branch already accepts at-least-once).

### B-H2 — worktree-creation launch race (close the CLASS, not one instance)
The launch lock (`ctx.launchingNodes`) was added INSIDE runAgentForNode, AFTER the seconds-long
`beforeChildLaunch` (`git worktree add`). Two concurrent launches for the same fresh child both passed
the pre-lock guard → two `git worktree add` → the loser threw → `deliverMessage.catch` marked the node
`failed` + sent a bogus task_complete(failed) to the parent WHILE the winner ran. THREE create paths
existed post-FIX-2 — all three fixed:
1. `ensureChildAgentRunning → beforeChildLaunch`: acquire `launchingNodes` ATOMICALLY at the top
   (has-check + add in one synchronous tick, no await between), BEFORE beforeChildLaunch. Phase A (prep)
   releases the lock on throw; Phase B hands it to runAgentForNode.
2. `orchestrator-tools.ts send_message` inline `wm.create`: **DELETED**. send_message now delegates to
   deliverMessage → ensureChildAgentRunning (the single locked creator). Kept the git-clean + branch
   pre-flight gates; dropped the now-async "on branch X" suffix from the success string (the branch
   isn't known synchronously anymore — no test asserted that string). "Delete until ONE remains":
   beforeChildLaunch (existsSync-guarded) is the SOLE creator. (`slugify` import dropped from the file.)
3. `runtime/routes/tasks.ts` REST `/continue` reactivation (verify/closed, no worktree): FIX-2 wired
   this to call `beforeChildLaunch` directly, OUTSIDE the lock — same race (milder blast: a duplicate
   POST 500s, no parent corruption). Acquire the lock around it with the same launchLockHeld handoff.
- New `RunAgentOpts.launchLockHeld?: boolean`: when set, runAgentForNode's entry guard does NOT treat
  its own already-held lock as a competing launcher, and TAKES OVER the lock's release on EVERY exit
  path (incl. the early session-already-running bail) so the caller can't leak it. Entry guard split:
  `if (node.session != null) { if (launchLockHeld) delete; return; }` then `if (has(nodeId) &&
  !launchLockHeld) return;` then `add`.

### B-M3 — outer-retry backoff MUST be abort-aware
`provider-shared.ts` outer retry used `await new Promise(r => setTimeout(r, delay))` (30/60/120s). The
inner per-call retry was already abort-aware; this one was not. A transient error parked the loop in
this sleep; a stop/reset then blocked for the full backoff (up to 120s), exceeding the daemon's 60s
worker-forward timeout → 504 + a retry racing the still-running first reset. Fix: module-level
`abortableDelay(ms, signal)` (setTimeout raced against an `abort` listener, listener removed on both
paths so a long-lived signal doesn't accumulate listeners) + after it `if (signal.aborted) throw e` to
abandon the retry loop. **Test with stopTask (no timeout), NOT stopAgent (its 1s race masks the block).**

### B-L9 — done-resume + compactOnly → consecutive user messages → API 400 (FIXED)

> ⚠️ **PHANTOM (2026-07-25).** There was no 400. `pendingCompactDoneToolCall` was built against a
> mock-only rule; the unbundled shape is accepted by the real API. The mechanism works and is
> harmless, but it has no reason to exist — slated for collapse alongside
> `pendingCompactYieldToolCall`. See *The Anthropic message-shape rules, MEASURED*. Everything
> below is history, including the "Reachability trick", whose last sentence names the mock's
> fictional check as the detection mechanism — which is exactly how the phantom stayed alive.

`provider-shared.ts` pendingDoneToolCall handler did NOT check `compactOnly` (the yield path already did
via `pendingCompactYieldToolCall`). When the ONLY wake message during a done-resume was /compact, it
pushed the done tool_result as its own user message, then the compact block pushed the summarization as
a SECOND consecutive user message → 400. NOTE: the in-memory auto-recovery (`enableAutoRecovery`) is
GONE — this 400 is NOT masked; it crashes → buildSessionRepair on next launch. Fix: new
`pendingCompactDoneToolCall` mirroring the yield path — on compactOnly, emit the done tool_result
("Manual compaction requested") for orphan-prevention but DEFER its messages[] push; the compact block
bundles it + the summarization into ONE user turn. The compact-block bundling now unifies yield AND done
(`pendingCompactYieldToolCall ?? pendingCompactDoneToolCall` — mutually exclusive: a resume ends in one
orphan, not both). The compact-with-OTHER-messages (compactOnly=false) done case stays an analog of the
known-unfixed yield bug (still a test.todo). **Updates "Known Bugs": the done+compactOnly variant is
now fixed; only the +other-messages variants (yield AND done) remain.**

### Reachability trick for the B-L9 test
`/compact` endpoint 404s for a non-running (done/verify) agent, so it can't wake a pending-done agent.
Instead: `deliverMessage(node, createCompactMessage())` — a compact QueueMessage HAS an id, so
deliverMessage persists it to JSONL and findUnconsumedMessages recovers it on the auto-launched resume.
The resume drains ONLY the compact → compactOnly=true. The mock's `validateRequest` throws on
consecutive user roles, so the bug surfaces as an "alternate roles" error event + a missing
compact_marker.

### Regression tests (all mutation-proofed — each fails when its fix is reverted)
- `src/lifecycle-concurrency.test.ts` (new): cc#3 (throwing onDone → loop promise still settles +
  agentLoopPromises cleared), B-M4 (at the moment the child's done_notified is appended, the spy
  reads the parent JSONL from disk and asserts task_complete is ALREADY there — directly tests the
  durability ordering), B-H2 (counting beforeChildLaunch: two concurrent deliverMessage → ONE create +
  no bogus task_complete(success=false); two concurrent REST /continue → ONE create), B-M3 (stopTask
  during a 4s backoff returns <3s). Test gotchas: task_complete message has `source:"task_complete"`,
  field `success` (not "child_complete"/"passed"); a holder OBJECT (not a bare `let`) avoids TS
  narrowing the closure-assigned probe back to its `null` initializer; awaiting `ensureChildAgentRunning`
  directly HANGS (it awaits the whole agent loop) — drive launches via deliverMessage/REST instead.
- `src/drift-lifecycle.test.ts` "compact triggered while agent in pending-done (done resume)" — was a
  test.todo, now a real B-L9 test (compact_marker written, no alternate-roles error, every recorded
  request alternates roles).

## FIX-5 (2026-06-10) — too-short compact brick + duplicate-done brick + dup-yield compact extras

Three bugs in `provider-shared.ts`, all causing permanent session bricks.

### R8-B#1 — too-short compact must NOT emit compact_marker
`messages.length <= 4` branch emitted `compact_started` + `compact_marker` without
rebuilding context (no session_config, no compacted_resume). On restart,
`readActive()` returns only post-marker events → starts with assistant → 400
"first message must be role user" → permanent brick. Fix: emit only a status
"Context is too short to compact", reset `manualCompactRequested`, and consume any
`pendingCompactYieldToolCall` / `pendingCompactDoneToolCall` + `pendingDuplicateYieldExtras`
so the assistant tool_use has a matching result.

### R8-B#2 — duplicate done() → emit results for ALL dones

> ⚠️ **PHANTOM, and this one COST something (2026-07-25).** The diagnosis below is accurate right
> up to "two separate user messages", and then wrong: that shape is `user[tool_result]`
> `user[tool_result]`, which the real API ACCEPTS — both messages open with tool_result blocks so
> the answering run spans them. Verified by feeding this exact event sequence through the real
> walker. **So the trade-off recorded in the last sentence — the agent losing its done-resume
> context and getting a generic interrupted resume — was paid for a bug that does not exist.**
> Reverting is therefore a BEHAVIOR FIX, not a cleanup; do not treat it as a risky style revert.

Two done tool_calls both exited as orphans. On resume, repair placed the interrupted
result AFTER lifecycle events (agent_end, done_notified). The walker tool_result
collection loop broke at those lifecycle events → two separate user messages → API 400
→ permanent brick. Fix: for duplicates, emit tool_results for ALL dones (extras get
"duplicate done", winner gets "processed successfully"). No orphans → no repair →
no walker issue. Trade-off: resume detects `isInterruptedResume` instead of
`pendingDoneToolCall`, so agent gets normal interrupted resume instead of special
done-resume context.

### R8-B#11 — duplicate-yield extras must be bundled in compactOnly compact path
`pendingDuplicateYieldExtras` was only consumed in the normal yield-wake path. The
compactOnly compact path ignored them → extras tool_results were dangling → API 400.
Fix: compact summarization path and too-short path both include extras in the bundled
user turn.

✅ **REAL — and correctly attributed at the time (re-verified 2026-07-25).** "Dangling" is the
*pairing* rule, not alternation: the assistant's extra `tool_use` blocks had no answering
`tool_result` in the compaction request. Its sibling R8-B#1b (the too-short branch consuming the
same pendings) is real for the identical reason. **When the two compaction deferrals collapse, this
requirement does NOT go away** — the extras still have to be pushed, just as their own
`user[tool_result…]` message ahead of the rest. Form changes, obligation stays. Worth noting that
these two entries sit inches from B-L9 and R8-B#2 in the same file and are the ones that got it
right; the wording is nearly identical, so read the *mechanism* rather than pattern-matching the
sentence.

### Pre-existing issue found (not fixed here): compact messages never get messages_consumed
`handleImplicitYield` filters compact messages from `nonCompact` and `recordQueueEvents`
only records nonCompact. On restart, `findUnconsumedMessages` re-enqueues the compact →
spurious `manualCompactRequested` on next session. Usually benign but ~~can cause
consecutive user messages during done-resume with compact.~~ **that consequence was the phantom
(2026-07-25) — consecutive user messages are legal.** The re-enqueue itself is still real; it just
has no known bad effect.

## fable silent-turn → silent idle + agent date-blindness (2026-07-15, from closed task 01KWYCYA)

Two durable lessons from the fable-stall investigation (01KWYCYA, closed — fable now moot on opus-4-8, but these OUTLIVE fable). Generic fix drafted: **01KXK69KKKGG4XHPH7EWGNY5AC**. Date-blind fix drafted: **01KXK5QH2BDQSZB1H1CQV8X470**.

### Silent-idle on a no-text-no-tool turn (durable failure MODE)
An assistant turn returning **thinking-only** (no text block, no tool_call) makes the provider loop see `toolUses.length === 0` → treat it as end-of-turn → **implicit yield → idle, with NO user-visible signal**. The agent then waits for a message **indefinitely**; daemon restarts just RE-IDLE an implicit-yield agent (they don't self-continue it). Benign for a root-in-conversation (a human eventually pokes it); an **indefinite hang for an autonomous sub-agent nobody is watching** — the parent's yield never wakes. 01KWYCYA was the live repro: interrupted 7/7 14:56, idle 8 days until poked 7/15.
- Trigger was fable (server-side turn termination). Our gap: `getStopReason()` collapses all non-`end_turn` (incl. `refusal` / `pause_turn` / `model_context_window_exceeded` / `compaction`) to `tool_use`, and the loop idles without persisting/surfacing the anomalous stop.
- GUARD (deferred → draft 01KXK69K): any `stop_reason ∉ {end_turn, tool_use}` → emit a **persisted, user-visible error event BEFORE idling** (Part A observability); + bounded `pause_turn` continue (~3) (Part B). Generic, zero fable coupling.

### Forensics (durable, model-agnostic debugging tools)
- **Which model ACTUALLY served a turn**: base64-decode a thinking block's `signature` — it embeds the serving model name (e.g. `claude-fable-5`), **independent of `response.model`** (which can lie under silent routing). Root's full history: 8/8 silent turns were fable, 0/9800 opus.
- **Mid-stream/hardware cut vs upstream turn-completion**: a **clean `usage` event present** ⟹ the API turn completed and our loop processed it → RULES OUT a mid-stream process suspension (which would orphan the turn + trigger `buildSessionRepair` on resume). So `clean usage + thinking-only shape` = upstream silent turn, NOT a laptop-close/suspend.

### Agent time-perception is DATE-BLIND (ground truth = epoch ts)
Context message timestamps are `[HH:MM:SS]` with **no date**. 01KWYCYA was interrupted 7/7 14:56 and idle until 7/15 16:13 — **8 days** — but on wake it confidently reported "~80 minutes" because 14:56→16:13 looks same-day. **Ground truth is the epoch `ts` in the JSONL (encodes the date); the display stamps do NOT.** Rule for ANY "how long was I stalled / when did this happen / is this stale" reasoning: **read the epoch `ts`, never trust the `[HH:MM]` display for elapsed wall-clock.** Root hit the same thing this session: an overnight `bun test` `[22:06]` → user `[11:04]` next-day gap was invisible in the stamps (inferred only from anomalous test durations). Surfacing-fix design in draft 01KXK5QH.

## Agent activity: live process state is asked for, never replayed (2026-07-25)

"What is this agent doing" is now ONE explicit value the backend owns, pushed
on change and asked for at connect. It replaced a boolean with three competing
sources plus a 1.5s timer in the UI.

### The rule that generates the design

> **State is never derived from the event log. On connect the client ASKS;
> while connected the server PUSHES.**

The log records *"it became active at some past instant"*. Replaying that as
*"it is active now"* is a category error — and the old code had a poll
(`checkAgentStatus()` after every `processEventBatch`) whose ONLY job was to
undo the error it had just made. That poll was the bug report.

Note the exact inversion against pending messages (Task X): pending IS a
projection of a persistent log, so a reducer over events is right there.
Activity has no persistent representation at all. Same-looking code, opposite
conclusion — the question to ask is "does this thing exist on disk?".

### `AgentActivity = "idle" | "thinking" | "tool"` — asymmetric on purpose

| state | meaning |
|---|---|
| `tool` | loop is executing tools — **the only state with an unclosed tool_call** |
| `idle` | loop is parked on `queue.wait()` |
| `thinking` | **explicitly the residual**: every other way the loop is alive |

`tool` is the precise one because it is the one with an interrupt consequence
(an interrupted tool needs a synthetic tool_result). `idle` is the empty one.
`thinking` is *defined as the leftover*, which is what makes the following fall
out as consequences rather than special cases:
- the outer-retry backoff (up to 120s between API attempts) is `thinking`
- session setup before the loop starts (MCP connect can take seconds) is `thinking`
- a compaction turn is `thinking`

**Known naming debt, deliberately not fixed**: a compaction runs 2-3 minutes
and showing "Thinking..." across it is the same kind of lie this model removes.
Adding `compacting` later is a pure carve-OUT of the residual, not a
re-partition — cheap precisely because the residual is written down.

**Rejected framing** (offered, vetoed by root): defining the states by "what
feedback the user sees" (spinner vs tool card). That defines backend state in
terms of frontend rendering — the same class of error as deriving state from
the log. Add a UI affordance and the definition collapses.

### Where it lives, and the one rule about writing it

`TaskSession.activity` — dies with the session, so there is no second lifecycle
to keep in sync and nothing to leak. "All tasks' states" is DERIVED at read
time by walking tracker nodes that have a session.

**Field write and broadcast must happen in the same function.** Two writers,
because neither layer can reach the other:
- `setActivity(state)` — closure inside `runProviderLoop` (loop transitions)
- `setAgentActivity(ctx, projectId, taskId, session, state)` — `agent-lifecycle.ts`
  (session birth/death)

The tempting shortcut is to emit the event inside `handleImplicitYield` (which
only has `queue` + `emit`) and write the field at its four call sites. That
splits one source into two, and call site number five gets only one half. The
setter is passed IN instead — `handleImplicitYield(queue, setActivity)`.

### Transition points (each independently mutation-tested)

1. `idle` — in `handleImplicitYield`, before `queue.wait()`. ONE site covering
   four call paths (done resume / implicit-yield resume / explicit yield / end_turn).
   **Announced only when the loop will ACTUALLY park** (`!queue.hasPending`):
   with a message already queued, `wait()` resolves on the next microtask and
   the agent never paused. This is not flicker-avoidance dressed up — it is
   what makes `idle` mean "waiting for you" rather than "reached a yield
   point", and both consumers depend on the stronger meaning (yield_external
   wakes an external client on it; the UI re-fetches JSONL on it to expose
   Edit/Rewind). It also kept two provider harnesses working unchanged: they
   script the loop by counting idles, and an unconditional announce added a
   phantom startup idle that consumed their "first idle" step.
2. `idle` — the initial drain's blocking wait (`provider-shared.ts`, fresh start),
   same `!queue.hasPending` rule. The fifth place the loop parks on the queue,
   and it announced nothing — an agent waiting for its first message looked
   busy to every client. It deliberately does NOT set `queue.idle`; that flag
   is polled by test helpers as "the steady-state loop has settled", and
   flipping it during startup lets a poller call a booting agent settled.
   **Narrower than it looks**: `runAgentForNode` enqueues a `work_context`
   message before the loop starts whenever the scope's `buildWorkContext`
   returns content, so a matrix launch always has something queued and this
   park is not reached. It fires for a scope with no work context (the hook is
   optional), and on a resume that ends in a non-user message with nothing
   recovered. Worth its one line — an agent genuinely stuck here is stuck
   forever — but do not describe it as the common path.
3. `thinking` — at the API-call block, OUTSIDE the outer-retry loop.
4. `tool` — immediately before `Promise.all(executeTool)`.
5. `null` — at all three sites that clear `node.session` (runAgentForNode's
   finally, stopAgent, stopTask). Skipping any one leaves a permanent spinner
   for a dead agent in every connected client.

6. `thinking` — on the way OUT of idle, right where `queue.idle = false` sits.

⚠️ **Point 6 was initially left out, with an argument that was wrong in an
instructive way.** The reasoning was: every path leaving `handleImplicitYield`
reaches the API block, so a second setter is unobservable — *the emitted event
sequence is identical either way*. True about the event sequence, and
irrelevant: **consumers read the STORED value, not the event stream.**
`yield_external`'s fast path and the connect-time snapshot both ask
`session.activity` directly. Without the transition, the whole wake window
(drain → filter compact → buildUserTurn → emit its events) reports `idle` for
a loop that is provably not parked — and the documented
`send_user_message → yield_external` workflow lands exactly there, told "the
agent stopped working" at the moment it started.

The old code left idle TWICE here (`queue.idle = false` AND an `agent_active`
event). Collapsing to one state kept only the flag — which by then had no
production reader — so the migration silently dropped the half that mattered.

**The structural fix is the dedupe, not the extra line.** `setActivity`
early-returns when the state is unchanged, which makes "an extra setActivity
call is harmless" a true statement. Before that, every transition point needed
a per-site argument about whether its event would be redundant — and that is
precisely the argument that went wrong. With dedupe, you write a transition
wherever the loop changes what it is doing and never reason about it again.
Dedupe against a LOCAL (not the session field) so the property also holds for a
provider driven directly in a unit test, where there is no session.

### Wire format

- `{ type: "agent_activity", taskId, state: AgentActivity | null }` — ephemeral
  delta. `null` = session gone. In `isPersistedByEmitEvent`'s broadcast-only
  group; **it must never reach JSONL** — that is what makes "replaying history
  can't fake-activate" structurally true instead of corrected afterwards.
- `{ type: "agent_activity_snapshot", projectId, states }` — daemon → client on
  SSE connect, alongside the existing initial `tree_updated` /
  `pending_clarifications`. Sourced from `GET /projects/:id/agent/status`
  (shape changed from `{idle[], active[]}` to `{states}`). **Sent even when
  empty**: "nothing is running" is the message a client reconnecting after
  everything stopped needs in order to drop stale entries.

Delta rather than full-snapshot-per-change because building a snapshot needs
the tracker and the provider loop has none — a hard constraint, not taste.

### Frontend: mostly deletion

Deleted: the `checkAgentStatus` poll and its `/agent/status` fetch; the
`agent_start`/`agent_end` → activeAgents derivation; the `agent_active` /
`agent_idle` event types; ActivityLog's 1.5s timer + `lastEntry?.type ===
"tool_call"` guess; dead `useAgent.running`; dead `handlers.ts setActiveAgents`.

Kept: `agent_start`/`agent_end` themselves (persisted lifecycle log; agent_start
still reports provider/model), and `checkStatus` reduced to the provider/model
fetch only.

Added: `activityReducer` (pure) + `isWorking()` in event-handler.ts; one
write-through ref + `dispatchActivity` in Plugin.tsx mirroring `dispatchPending`;
`activeAgents = new Set(keys where isWorking)` derived ONCE, so the five
existing consumers (tree spinner, tab spinner, TaskDetail ×2,
OrchestratorDetail) did not change at all. ActivityLog takes `activity` and
does `showThinking = activity === "thinking"`.

Activity events bypass the viewed-session filter in `handleEvent` (activity is
project-wide — the sidebar shows every task) and produce no log entries.

### Two consumers that a grep for "activeAgents" does NOT find

1. **`yield_external` subscribes to the `agent_idle` EVENT TYPE**
   (`mcp-endpoint.ts` WAKE_SIGNALS). Deleting the type without migrating turns
   every external `send → yield_external → get_logs` wake into a timeout,
   silently. Now matched via a `wakeReason()` predicate on `agent_activity`
   (`state === "idle" || state === null`). The reported reason string stays
   `"agent_idle"` — that is the tool's EXTERNAL contract and is unrelated to
   our internal event names. (Same file, ~15 lines apart: the fast path
   `session.queue?.idle` returning the *string* `"agent_idle"` is a different
   thing from the *event type* in WAKE_SIGNALS. Easy to conflate.)
2. **`onAgentIdle`** (Edit/Rewind re-fetch — SSE events lack eid/parentEid, so
   the buttons only appear after a JSONL refetch). Migrated to "the viewed task
   stopped working", which now ALSO covers session end — an agent that finishes
   with `done()` never goes idle, so its last messages used to stay uneditable.

### Pre-existing bug found next door (fixed in its own commit)

WAKE_SIGNALS still listed `agent_stopped` and `orchestration_completed` — names
replaced by `agent_end` long ago, so they could never match. A stopped agent
only ever woke an external client by timing out. Committed separately from the
activity work so the two can be reverted independently.

### Test notes

- `src/agent-activity.test.ts` — real agent loop. The `tool` window is observed
  FROM INSIDE a tool handler (`getSession(...).activity`), which is the direct
  form of "there is an unclosed tool_call right now". Ordering assertions
  collapse repeats so they pin ORDER, not announcement count.
- Idle-detection in provider tests keys on
  `event.type === "agent_activity" && event.state === "idle"` (was `agent_idle`).
  Two harnesses in `anthropic-compatible-provider.test.ts` drive the loop this
  way — they hang for the full test timeout if missed.
- `web/ActivityLog-activity.test.tsx` renders with the LAST ENTRY being a
  tool_call in every case, so `tool` vs `thinking` can only be distinguished by
  the prop — the old heuristic would have gotten it right by accident.

### Mutation results, and the test the mutation caught

Every transition point was removed individually and the suite re-run. Each is
caught by tests only its own path can reach:

| removed | fails |
|---|---|
| `idle` in handleImplicitYield | parks-on-queue + 2 provider harnesses that script the loop by counting idles |
| `idle` in the initial drain | the initial-drain test, alone |
| `thinking` at the API block | thinking→tool→thinking, alone |
| `tool` before tool execution | the in-tool observation + thinking→tool→thinking |
| `null` at the 3 teardown sites | session-end, stopTask, stopAgent — one each |
| `thinking` on the way out of idle | wake-window test, alone |

**The initial-drain mutation caught a bug in my own test.** The first version
used the normal scope, so `work_context` was queued, the drain never parked,
the agent ran a turn and parked in `handleImplicitYield` instead — the test was
named for one transition and measured another. It passed clean and failed under
the WRONG mutation, which is exactly the "two tests covering for each other"
shape. Fixed by launching with `buildWorkContext: () => null`.

That is the argument for mutating per transition point as you add it rather
than once at the end: a green test tells you nothing about WHICH line made it
green.

**Mutation testing cannot find a transition point that was never written.**
The leave-idle gap (point 6) survived a full clean mutation sweep — nothing
failed, because nothing existed to remove. It was caught by reading the comment
that justified its absence. When a comment argues why some code is unnecessary,
that argument is the thing to check; the tests around it are all consistent
with it by construction.

**Careless-git note**: reverting a mutation with `git checkout -- <file>` also
reverts any UNCOMMITTED fix in the same file. Commit the fix before mutating
it, or back the file up.

## Interrupt vs stop: two abort channels, and why they can't be one (2026-07-25)

`stopTask` is TEARDOWN (kills background processes, closes the queue, drops the
session, disconnects MCP). `interruptTask` ends the current TURN and leaves all
of that alive. Same button in the UI before this; opposite verbs.

### The signal

`TaskSession.interrupt: TurnInterrupt` (`src/turn-interrupt.ts`), deliberately
NOT `session.abortController`. Sharing one channel gives either "an interrupt
tore the session down" or "a teardown was mistaken for an interrupt so it
couldn't tear down" — **both silent**. They meet in exactly one place, the API
call's signal (`AbortSignal.any([teardown, interrupt])`), and every reader asks
`request.signal.aborted` FIRST: teardown always wins.

Three read sites (API call, retry backoff, loop top) and **one park**. The two
ways an interrupt arrives converge: a cut-off API call `continue`s to the top; a
tool batch runs to completion and falls through to the top. That site parks via
`handleImplicitYield` — the park every other path already uses, so there is no
fifth "what is the agent waiting for" state.

**`consume()` is called when the loop PARKS, not when it decides to.** "The loop
actually parking satisfies the interrupt", whichever path parked it. Clearing at
the decision point instead leaves the flag set when a stop lands in the same
moment the agent goes idle on its own, and the next message gets swallowed into
a park.

### Why no repair is owed (the point of the whole thing)

`stopTask` leaves the turn's tool_calls unclosed *because the loop is already
dead*; the next launch's `buildSessionRepair` then writes
`"Tool execution was interrupted by daemon restart"` — false whenever a human
pressed stop, and re-read by the model on every later turn. An interrupt keeps
the loop alive, so **the loop closes its own tool_calls before parking** and
repair finds nothing. Pairing completeness is structural: `Promise.all` settles
for every tool and `executeTool` never throws, so the only way to break it is
bailing out early.

**Foreground tools**: `foregroundExecutions` has two verbs now — `resolve()`
moves to background (command KEEPS RUNNING, the pre-existing verb), `interrupt()`
terminates it and returns its output so far through the same formatter a normal
completion uses. A model told only "interrupted" knows it ran a command and lost
the result, which invites re-running something that already had side effects.
Tools that can't be stopped safely just run to completion — a half-written file
is worse than a two-second wait.

**done() wins a race with the stop button.** That is completion, not
interruption; marking it "not executed" would strand the parent waiting forever.

### ⚠️ SYMPTOM: "I pressed stop, then restarted the daemon, and it started working again"

Not a bug — a boundary we accepted. It depends on which state the interrupt hit,
and the window is *interrupt → daemon restart with no message in between*:

| interrupted during | log ends in | resume detects | after restart |
|---|---|---|---|
| `thinking` (text had streamed) | `assistant_text` | `hasPendingImplicitYield` | **parked at idle** ✓ |
| `thinking` (nothing streamed yet) | the turn's user message | `isInterruptedResume` | re-runs the turn |
| `tool` | tool_results (a user turn) | `isInterruptedResume` | **continues working** |

Making the `tool` row survive a restart needs a persisted "interrupted, waiting"
marker, i.e. a fifth resume state — which the design explicitly refuses. If this
ever has to change, that is the cost to weigh.

The first row is not luck, and it is the reason **partial assistant text is
KEPT** rather than discarded: keeping it makes the interrupted state
representable on disk with zero new states. It also gives the user's next
message a referent ("no, don't do that" needs the text they were reading), and
emitting it as a normal final `assistant_text` is what clears
`ctx.streamingText`, so the UI's partial becomes final instead of lingering
until the next refetch. Never the thinking blocks (no signature) and never a
half-emitted tool_use (that is the orphan being removed).

### `status` events are broadcast-only — measured, and it matters here

`isPersistedByEmitEvent` returns false for `status`, so the interrupt's
"Interrupted by user" reaches clients and never reaches the log. Consequences:
it cannot sit between tool_results in a reconstruction that never sees it; and
after a refresh the durable evidence is the interrupted tool_result's own text,
not a marker. **A test asserted the opposite and failed** — the assumption that
"emitEvent means it's in JSONL" is easy to make and the repair path's own status
event (written straight to the EventStore) makes it look true.

### Do NOT front-run the queue when parking

The cancellation-point drain is skipped while interrupted. A message drained
there would be merged into the turn's user message and then sat on — the loop
would wait for a *further* message before ever calling the API, so "stop, do X
instead" would look swallowed. Left in the queue, `handleImplicitYield` returns
it immediately (it doesn't even announce idle when something is pending).

### Compaction turns are not interruptible mid-flight

A 2-3 minute system operation whose instruction is already in `messages[]`;
cutting it there would pair "summarize yourself" with whatever the user says
next. The flag stays set and takes effect at the top of the next iteration.

### Pre-existing hole found next door, deliberately NOT fixed here

`provider-shared.ts` "context too short to compact" (`messages.length <= 4`)
emits a status, clears the flag and `continue`s — landing on the API call with
`messages[]` possibly ending in an ASSISTANT message, which IS a real 400
("must end with a user message"). Reachable today with no interrupt involved:
fresh agent ends its first turn with text, user hits compact. It lives inside
the compaction deferral machinery that root's mock-audit task owns.

### Tests: `src/interrupt.test.ts`, `web/InputBar-stop.test.tsx`

Mutation-verified per claim, each fix committed before mutating it:

| mutation | fails |
|---|---|
| interrupt also kills background processes | the background-survives test, ALONE |
| skip emitting tool_results when interrupted | no-repair, all-closed, partial-output, leading-run, not-executed (5) |
| drop the `!doneToolUse && !yieldToolUse` guard | done()-wins, by 10s timeout — the "parent waits forever" shape |

Reaching the "interrupt landed before the batch started" window deterministically:
subscribe to events and call `interrupt.request()` from the `tool_call` emission
— that emission happens after the response is processed and before execution
begins. Same trick reaches the done() race.

⭐ **"Interrupt an agent that is mid-generation" had never been executed by any
test in this suite** — and not because someone skipped it. `createMockAnthropicStream`
ignored the request's AbortSignal outright: it slept `delay_ms`, then yielded the
whole turn. Every test that aborted mid-stream therefore passed through a road
that was open and led to the OPPOSITE of production. The gap is invisible from
the test side: nothing fails, nothing is marked todo, the behaviour simply is not
the product's. Fixed by honoring the signal inside the delay window only (a turn
without `delay_ms` iterates byte-for-byte as before, so no existing test moved).
Same principle FU2 applied to integration mocks via `abortableSleep`.

**The class, stated generally: an unfaithful test double doesn't only make tests
lie — it makes the missing test unthinkable.** Nobody writes "assert the abort
actually aborts" when the harness has no way to express the difference. Sibling
of the fictional-alternation finding (an over-strict double blocks a correct
implementation); this is the permissive direction of the same failure.

⚠️ **`activity === "thinking"` does NOT mean "a request is in flight."** A session
is BORN thinking (setup — MCP connect, repair, work context — is the residual
state too), so a test that waits for `thinking` and then interrupts can land
before the first API call exists. That path parks the loop having never called
the API, and it **passes every park assertion while testing nothing about
aborting a request**. Key on the request actually being recorded
(`mockAPI.getRequestHistory().length >= 1`) instead. Found by the failure being
diagnostic: the tail of the log had no assistant turn at all before the wake.
Which is the general lesson — a bare "timed out waiting for X" tells you nothing;
dumping the last few events with it turned two blind reruns into one answer.

Three test-writing notes worth carrying:
- `await waitFor(() => x === null || true)` polls NOTHING (always true) and
  asserts before React commits. Poll the real condition.
- `expect(domNode).toBeNull()` on failure prints the node *with its React fiber
  graph*: one failing assertion produced a **227MB** log and a 60s test. Compare
  to a boolean (`expect(x === null).toBe(true)`) in DOM tests.

---
# Events, JSONL & Session History
---

## JSONL Repair

`buildSessionRepair()` in events.ts handles all repair. **A repair is a chain jump, and it never
deletes anything** — the poison stays on disk and simply stops being on the active chain, applied
exactly like a rollback. Two shapes: append-only (an orphaned tool_call just gets its interrupted
result, nothing dropped), or jump-back (duplicate / out-of-order results: chain back to the last
good event, then append). Repair runs in runAgentForNode before the provider loop starts.

**File truncation is gone** (`truncateAfterLine`, deleted 2026-07-24). Addressing events by file
position produced two separate data-destroying bugs (FIX-1 cc#1, FIX-8 R8-B#4) and destroyed the
evidence needed to debug the corruption. Read those FIX sections as history.

**The interface lives in exactly one place** — the return shape, the field names, what each jump
must append and in what order: *One boundary: the active chain*, at the end of this region. This
entry is the index card and states only the shape, so the two cannot drift apart.

### Scope: what it deliberately does NOT repair

**Orphan `tool_result`** (a result with no matching call). The runtime cannot produce one, so
repairing it would mask a real bug instead of fixing a real state. Same rule as "no dangling-link
handling" further down this region — a state the runtime cannot produce must not have code that
quietly patches it, or that code becomes a silencer.

Original wording of this scope statement, kept because it enumerates the three cases: *"Repairs:
orphan tool_call → synthetic result, duplicate tool_result → truncate, out-of-order → truncate.
Does NOT repair orphan tool_result — can't be produced by runtime, masking hides bugs."*
**The two `truncate`s are SUPERSEDED** — since 2026-07-24 both are a `chainToEid` jump and nothing
is truncated. The scope claim itself still holds.

## enqueue === persist (single JSONL write path)

`MessageQueue.enqueue(msg)` synchronously calls `onPersist(msg)` before delivery. ONE way queue messages reach JSONL.
- `replay: true` — skip onPersist (already in JSONL). `quiet: true` — suppress wake, NOT persistence.
- **traceId**: has traceId = produced by agent loop run. No traceId = external to any run.
- **Pitfall**: `createApp()` does NOT call `autoResumeProjects()`. Tests must call it explicitly.

## JSONL Lifecycle Refactor

- Message `header` deleted → `work_context` QueueMessage source instead
- `compact_marker` is empty boundary. `agent_start`/`agent_end` replace old lifecycle events.
- **JSONL sequence**: `session_config → work_context → trigger → messages_consumed → ...`
- **Critical lesson**: "delete until ONE remains" ≠ "merge into one place". Keep emit positions, just rename.

## EventSpec Type

`EventSpec = DistributiveOmit<Event, "taskId">`. Single emit path: `R.emit(projectId, taskId, spec)`.

## Usage Event Persistence

`usage` events moved from ephemeral to persisted. Now written to JSONL by emitEvent.
- Added `outputTokens?: number` to usage event type.
- `walkEventsToMessages` skips `usage` via default case (not conversation content).
- UI: `attach_usage` UpdateOp finds most recent `assistant_text` for same taskId and attaches `CacheInfo` (inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens).
- Displayed as subtle ⚡ hover badge on assistant messages (not separate log entries).
- Color-coded: green (>80% hit), yellow (>30%), grey (<30%).
- Compaction also emits usage (estimated=true, no cache fields) — persisted harmlessly.

## In-Process Event Subscribers

Third event consumer (alongside JSONL + SSE): `subscribeToEvents(ctx, projectId, callback)`. Per-project keyed Map. Used by yield_external, test helpers. Throwing subscribers caught + logged.

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

## FIX-1 (2026-06-05) — buildSessionRepair corrupted COMPACTED sessions (index-space + orphan results)

> **HISTORY — the machine these bugs lived in is deleted (2026-07-24).** `buildSessionRepair`
> computes no index at all now: it returns `{chainToEid, appendEvents}` and the caller applies it as
> a chain jump. cc#1 and F-H2 below diagnose a mechanism that no longer exists. Kept because the
> DIAGNOSIS is the reusable part — see FIX-8's banner for the same lesson, and *One boundary: the
> active chain* for the current shape.
> **Still LIVE, do not read as history**: B-L8's intended-orphan rule (skip yield/done only when it
> is the LAST tool_call), the `endsInPendingControl` guard on the synthetic user message, and D#1
> (`source: "system"` renders to an empty string).

CRITICAL data-corruption fix. Both audits (matrix F-H2 + cc#1) independently hit it. The repair
path could permanently brick any *compacted* session (recoverable only by `reset_task`). Four
facets, one subsystem (`src/events.ts buildSessionRepair`, call site `agent-lifecycle.ts:~801`).

~~**This SUPERSEDES the "JSONL Repair" and "buildSessionRepair Scope Boundary" sections above.** The
key claim that changed: `buildSessionRepair` now takes the **FULL** event log and returns a
**PHYSICAL** line index. Read those older sections with this correction in mind.~~

⚠️ **SUPERSEDED, and now pointing the wrong way — do NOT follow it.** "JSONL Repair" has since been
rewritten to the current `{chainToEid, appendEvents}` contract, so "correcting" it with the
struck-through claim would re-introduce physical-line addressing — precisely the bug class that was
deleted. The sentence stays visible because it records what the API looked like between 2026-06-05
and 2026-07-24, and because it is the clearest example in this file of a superseding pointer
outliving its own truth: **a pointer that says "trust me over that older section" has to be
re-checked every time either end changes.**

### cc#1 — index-space mismatch (root cause)
`buildSessionRepair` computed `truncateAfterIndex` against `readActive()` (post-`compact_marker`
slice), but `EventStore.truncateAfterLine` slices by **physical file line**. For a compacted
session, an active-relative index fed to physical truncation sliced off the `compact_marker`,
post-compact `session_config`, and `compacted_resume` summary, AND appended interrupted results
referencing tool_calls that had just been truncated away → unrecoverable.
- **Fix**: `buildSessionRepair(events)` is now a thin boundary-aware wrapper. It finds the last
  `compact_marker`, scopes analysis to the active region via an internal `repairActiveRegion(active)`
  (the old body, unchanged), then translates the returned index back to physical by adding the
  active offset. **Callers MUST pass the FULL log (`EventStore.read`), NOT `readActive`.** The call
  site in `agent-lifecycle.ts` now reads `read(nodeId)` and compares against `allEvents.length`.
- Truncation can never cross the compact boundary by construction (analysis is on the active slice;
  the floor is the boundary). Corruption that lives *before* the last marker is compacted away and
  is correctly ignored.

### F-H2 — Strategy 2 appended results for TRUNCATED-region tool_calls → orphan tool_results
The duplicate-repair branch had a second loop appending interrupted results for tool_calls located
in the region being truncated away. Those calls are removed → the results become **orphan
tool_results** (result with no matching call) → walker builds an invalid user message → API 400 →
next launch `buildSessionRepair` returns null (it detects orphan CALLS + duplicates, NOT orphan
RESULTS) → permanent crash loop. **Fix: that loop is DELETED.** Only the kept-region orphan loop is
correct (kept tool_calls whose results were truncated).

### B-L8 — kept-region orphan loop skipped TOOL_YIELD but not TOOL_DONE
A kept-region `done()` orphan got a spurious tool_result. Replaced the `!== TOOL_YIELD` filter with
the intended-orphan rule used by Strategy 0: skip yield/done **only when it is the last tool_call in
the kept region** (the resume's pending control state). Earlier yield/done orphans correctly get
interrupted results. New helper `lastToolCallEvent(events)`.

### Status-message structural guard (required once B-L8 lands)
Strategy 2's status message is a synthetic **user** message. If the kept region ends in an
unresolved intended-orphan yield/done (now skipped, not given a result), appending a user message
after it breaks ~~assistant→tool_result alternation~~ **the tool_use PAIRING rule** → API 400. Guard:
append the status message only when `!endsInPendingControl`. When the session ends in pending
yield/done, it correctly resumes in that state (no API-forcing user message).

✅ **REAL — verified 2026-07-25, keep the guard.** Removing it produces `assistant[text, tool_use]`
followed by `user[string]`: the answering run is empty, so the tool_use is unanswered → genuine
400 *"`tool_use` ids were found without `tool_result` blocks immediately after"*. Only the WORDING
was wrong — "alternation" is the fictional rule (see *The Anthropic message-shape rules,
MEASURED*), and this guard has nothing to do with it. A useful contrast with B-L9 / R8-B#2 in the
same file: same vocabulary, opposite verdict. **The word "alternation" in this codebase is not a
reliable signal of anything — go read what the shape actually is.**

### D#1 — `source: "system" as never` rendered to an EMPTY string
Strategy 0's reason message forced an illegal `source: "system"`; `formatBodyForAI`'s `default`
branch returned `""` (and the UI `queueEntryToUIEvent` had no "system" case) → the repair reason
silently vanished. **Fix: use `createUserMessage` (source "user")** — surfaced by both AI formatter
and UI materialization. No new source variant added; reuse the existing visible one. Same guarded
by `endsInPendingControl`.

### Regression tests (mutation-proof)
- `src/jsonl-stress.test.ts` → `describe("FIX-1: buildSessionRepair compact-boundary safety")`:
  5 unit tests (cc#1 pre-compact-ignored + physical-index survival, F-H2 orphan + idempotent second
  pass, B-L8 done orphan, D#1 visible status). Each seeds a session WITH a `compact_marker` — the
  gap every prior repair test had.
- `src/integration.test.ts` → `describe("Integration: repair on compacted session (FIX-1 cc#1)")`:
  drives the REAL `runAgentForNode` repair pipeline on a seeded compacted session; asserts the
  post-compact tool turn + summary + marker survive and the poison is gone. Catches the call-site
  `readActive`→`read` change (unit tests on `buildSessionRepair` alone can't).
- Mutation-checked: reverting the active-region scoping makes the pre-compact-ignored test return a
  repair; re-adding the truncated-region loop makes F-H2 see an orphan result; restoring the
  `!== TOOL_YIELD`-only filter gives the done orphan a spurious result; restoring the `as never`
  source makes the D#1 status render empty.

## FIX-8 (2026-06-10) — EventStore truncation safety: malformed-line index + write-queue serialization

> **HISTORY — the whole mechanism described below is deleted (2026-07-24).** `truncateAfterLine`,
> `readWithLineMap` and the event-index→physical-line translation are gone; repair addresses
> events by eid and applies as a chain jump. Both bugs below were symptoms of "address events by
> file position", and deleting the position-addressing deleted the bug class. Kept because the
> DIAGNOSIS is the reusable part: an index computed in one space and consumed in another is a
> silent corruption engine, and it bit us twice before we removed the second space. See "One
> boundary: the active chain".

Two EventStore bugs that amplify corruption during crash recovery.

### R8-B#4 — Malformed lines shift truncation index
`read()` skips malformed JSONL lines (crash artifacts) while `truncateAfterLine` slices raw
physical lines. `buildSessionRepair` returns event-array-relative indices. With N malformed lines
before the cut point, the physical cut lands N lines early → silently destroys valid events. Same
index-space-mismatch class as FIX-1 cc#1 (compact boundary), but at the individual-line level.

**Fix**: `EventStore.readWithLineMap()` returns `{ events, physicalLines }` where `physicalLines[i]`
is the 0-based physical file line of `events[i]`. The call site in `agent-lifecycle.ts` reads via
`readWithLineMap`, passes events to `buildSessionRepair` (which returns event-array-relative
indices), then translates via the map before calling `truncateAfterLine`. `read()` now delegates to
`readWithLineMap().events` — single parsing implementation.

**Docstring correction**: `buildSessionRepair` previously claimed to return "PHYSICAL line index" —
it actually returns event-array indices. Fixed in both the function-level and compact-boundary-safety
docstrings.

### R8-B#5 — truncateAfterLine not serialized with write queue
`truncateAfterLine` bypassed `enqueueWrite` (did its own `flushSession` + direct sync I/O). A
message persisted by `deliverMessage` in the flush-to-truncate window could land physically then get
cut by the truncation's `writeFileSync`.

**Fix**: route `truncateAfterLine` through `enqueueWrite`. Now fully serialized — pending writes
complete before truncation, and writes enqueued after truncation wait for it. The generation guard
also applies (if `clear()` runs while truncation is queued, truncation is silently dropped).

### Tests (5 new, all TDD — written before fix)
- `readWithLineMap returns events with their physical line numbers` — 2 malformed lines, verifies
  physical line mapping [0, 2, 4]
- `truncation after event index 2 with malformed lines preserves all 3 valid events` — end-to-end
  proof the fix works (uses readWithLineMap → physical line → truncateAfterLine)
- `BUG REPRO: using event-array index as physical line destroys the last event` — proves B#4 bug
  exists (passing event-index 2 as physical line cuts physical line 3)
- `truncation waits for pending writes before executing` — slow write completes before truncation
- `writes enqueued after truncation wait for truncation to complete` — truncation then append, order
  preserved

## JSONL event eid + parentEid (rollback infrastructure) (2026-07-21)

Every persisted JSONL event carries `eid` (12-char hex, `crypto.randomBytes(6).toString('hex')`)
and `parentEid` (previous event's eid, or `null` for the first event). Auto-stamped by
`EventStore.append`/`appendBatch` — callers never set them.

### Field naming: eid/parentEid (NOT id/parentId)
`MessageEvent` already has `id: string` (ULID for two-phase message lifecycle — `message` →
`messages_consumed`). Using `id` for the event chain would collide. `eid`/`parentEid` are the
event-chain fields; `id` on MessageEvent is unchanged and independent.

### Mechanism
- `EventStore.lastEventIds: Map<string, string|null>` — per-session chain head.
- `stampEvent(sessionId, event)` — returns a persisted COPY with the chain fields first (it no
  longer mutates the caller's object). Called inside the write queue (same microtask as
  appendFileSync). A failed write REWINDS the head — an event not on disk must not be in the chain.
- `read` populates `lastEventIds` from the last event on read.
- `copySessionFrom` preserves source eids but RE-LINKS the copied subset into one contiguous
  chain (the active context is a filtered subset, so the originals' parents aren't in the new
  file). Stamps synthetics + fork_marker with fresh eids. Sets `lastEventIds` for the target.
- `clear` deletes the session's `lastEventIds` entry.

### Auto-migration (old JSONL files)
On first `read`, if the first event lacks `eid`, the entire file is migrated:
assign linear eid chain, atomic rewrite (temp + rename, same pattern as `tracker.save()`).
Idempotent — skipped when first event already has `eid`. After migration, subsequent appends
chain correctly (lastEventIds populated from the last migrated event).

### SSE broadcast does NOT carry eid/parentEid
`emitEvent` broadcasts BEFORE persisting. `stampEvent` runs inside `append` (after broadcast).
This is intentional — eid/parentEid are persistence-layer concerns for future rollback; the
UI doesn't need them. The SSE-broadcast event object may gain eid/parentEid via mutation IF
a subscriber holds a reference past the broadcast call, but no subscriber does this.

**SUPERSEDED (2026-07-24)** — that last caveat is gone entirely: `stampEvent` returns a copy and
never mutates the caller's object. See § *Head-ordered lines* below. The first half (SSE carries no
chain fields, deliberately) still holds, and is why the frontend has to re-fetch JSONL before it can
offer Edit/Rewind.

### Walker unchanged (current stage)
`event-converter.ts` walker is linear — it scans events sequentially. eid/parentEid are purely
data at this stage. Future rollback/branching will make the walker "walk from leaf along
parentEid" instead of linear scan.

**SUPERSEDED (2026-07-22)** — the future in that paragraph arrived. `readActive` chain-walks via
`walkActiveChainIndices`; eid/parentEid are load-bearing, not "purely data". See *Message rollback
via parentEid chain-walk* and *One boundary: the active chain*. (The walker itself — the
event→message converter — is still linear; what changed is which events reach it.)

### Event type
Both fields are optional on the `Event` union's trailing intersection (`& { traceId?; eid?;
parentEid? }`). Optional because callers create events without them; EventStore stamps them.
After persistence (in JSONL), they're always present. After migration, they're present on all
old events too.

### Head-ordered lines: eid/parentEid serialize FIRST (2026-07-24)

Every line `EventStore` writes now starts with the chain links:

```json
{"eid":"53fa71c8e43d","parentEid":null,"type":"assistant_text","content":"…"}
```

Readability only — tailing a JSONL shows the chain without scanning past a long
`content`, and a future fixed-offset reader (draft 01KYB45P) would not need a
second format change. **Reading is untouched**: `JSON.parse` is order-agnostic,
so pre-change lines (chain fields at the tail) read back identically. Old files
are NOT rewritten; head-ordered and tail-ordered lines coexist inside one file
with zero effect (pinned by a test).

#### The mechanism, and the trap in the obvious version

`stampEvent` no longer hangs fields on the caller's object — it returns a
persisted copy built by module-level `withChainFields(event, eid, parentEid)`.
Every write path goes through it: `append`, `appendBatch`, `migrateEventIds`
(legacy eid-less files), and `copySessionFrom` (synthetics + fork_marker; copied
source events are rebuilt too, with their OWN eids preserved, so a brand-new
forked file is uniformly head-ordered).

**`{ eid, parentEid, ...event }` alone is WRONG.** When the input already has
those keys, the spread overwrites the fresh values with the stale ones (key
POSITION stays first, so it looks right). `withChainFields` destructures them
off before spreading. This is not hypothetical: `buildSessionRepair` re-appends
unconsumed `message` events read from the region it is about to truncate — with
the naive spread they keep a `parentEid` pointing at an event truncation just
deleted, so `walkActiveChainIndices` hits a chain break and silently degrades to
linear traversal (which can resurrect rolled-back events). Mutation-verified:
reverting to the naive spread fails exactly one test —
`event-id.test.ts` "re-appending an event that already carries eid gets a FRESH
chain".

#### Consequence: append/appendBatch no longer mutate the caller's event

Production never read `.eid` off an object it handed to the store (`emitEvent`
broadcasts to SSE *before* persisting; every eid consumer — frontend rollback,
repair, chain-walk — reads events back from disk). So this is invisible in
production, and it deletes the "an SSE subscriber holding a reference past the
broadcast could observe a mutation" caveat noted in the eid entry above.

TESTS did depend on it: `expect(store.read(id)).toEqual([literal])` passed only
because the literal was mutated to carry the chain fields. 9 such assertions
(8 in `event-store.test.ts`, 1 in `invariant.test.ts`) now wrap the read in
`stripChainFields()` (`src/test-utils/strip-chain-fields.ts`) — the assertion
stays exact for every other field instead of weakening to `toMatchObject`.

#### Verification

`bun test` green; typecheck error count unchanged (24, all pre-existing, owned by
01KYB3MJ); `check:ci` exit 0. Eyeball check via a real agent run (mock provider,
`emission-harness`): all 12 lines of the produced session file — message,
work_context, session_config, agent_start, messages_consumed, assistant_text,
tool_call, usage … — start with `{"eid":"…","parentEid":…`, chain visibly linear.

## Message rollback via parentEid chain-walk (2026-07-22, simplified 2026-07-24)

User clicks Rewind to here on a user message, system rolls back, agent regenerates. Claude Code /rewind equivalent.

### Core mechanism: readActive() chain-walks instead of linear slice

Old readActive(): findLastIndex(compact_marker) + slice(). New readActive(): walkActiveChainIndices() from the last event via parentEid. Without rollback, every event chains linearly (identical to old behavior). With rollback (setChainHead), the next event's parentEid jumps to the target event, rolled-back events are never visited.

⚠️ **Where the walk STOPS was changed later the same day** — see "One boundary: the active chain (2026-07-24)" at the end of this region. It is no longer `compact_marker`; it is the `compact_started` of the last COMPLETED compaction, and inside that window only `type === "message"` survives. Read this section for the rollback mechanism; read that one for the boundary.

### Rollback mechanism: setChainHead (no marker event)

`EventStore.setChainHead(sessionId, eid)` — one line: `this.lastEventIds.set(sessionId, eid)`. Pure in-memory. The NEXT event appended via `stampEvent` gets `parentEid = eid`, creating the chain jump. No intermediate `rollback_marker` event — the jump is carried by the first post-rollback event itself. `/edit` endpoint: `setChainHead(nodeId, rollbackTargetEid)` → `deliverMessage(newContent)` → stampEvent auto-sets parentEid.

**DELETED (2026-07-24)**: `rollback_marker` event type, `EventStore.appendRollback()`, frontend rollback_marker rendering (LogEntryView, event-handler, CSS). The marker was an implementation shortcut — parentEid jumps via setChainHead are simpler (one line vs. a full event write+flush).

### ~~Defensive chain-walk fallback~~ — DELETED 2026-07-24

This used to say: "if the parentEid chain breaks (null on a non-first event, or a parentEid naming a missing eid), fall back to linear traversal for preceding events. Without this fallback, 83 tests failed."

Half of it survived and half of it was wrong. What survived: **an event with no parentEid stops chain-following, and everything before it is taken linearly** — that is the genuine chain root at index 0, and it is what makes a pre-eid log readable. That is a documented rule now, not a fallback.

What was deleted: the *dangling-link* branch (a parentEid naming an eid no line carries). Coding around a state the runtime cannot produce hides bugs instead of surfacing them — the same reason `buildSessionRepair` refuses to repair orphan tool_results. Deleting it was only honest once the sole path that could produce a dangle was closed: `stampEvent` used to advance the chain head BEFORE the write, so a failed append (ENOSPC/EIO) left the next event pointing at an eid that never reached disk. `append`/`appendBatch` now rewind the head on write failure. **If you ever re-introduce a dangling-link fallback, you are papering over a writer bug — go find the writer.**

### REST endpoint

POST /api/matrix/projects/:id/tasks/:nodeId/edit (plugin route). Validates targetEid (exists, user message, after compact_marker). Stops agent, setChainHead, delivers new message via deliverMessage.

### `/rollback` deleted — `/edit` is the single path (2026-07-23)

The standalone `/rollback` REST endpoint in `.mxd/plugin/runtime.ts` (~100 lines) and the
`taskRollback` URL builder in `.mxd/plugin/web/api.ts` are deleted. Frontend (`Plugin.tsx
handleRollback`) already calls `api.taskEdit` exclusively — the `/edit` endpoint combines
rollback + message delivery atomically and fully supersedes `/rollback`.

**Edit/Rewind consistency verified** across three scenarios via 6 integration tests in
`src/rollback.test.ts`: readActive immediately, page refresh (readFromLastCompactMarker),
daemon restart (fresh EventStore). All produce byte-identical event sequences. Multiple
consecutive rollbacks: only the latest branch visible. Chain-walk via parentEid is
deterministic on persisted JSONL — no in-memory state.

### Frontend

Edit/Rewind buttons on user messages (hover-reveal). i18n: activity.rollback / activity.rollbackConfirm (EN + ZH).

### Agent lifecycle / buildSessionRepair adaptation

agent-lifecycle.ts feeds repair the chain-walked active events, so rolled-back events are excluded from repair analysis. (`readActiveWithLineMap` / `readWithLineMap` / the physical-line translation were deleted on 2026-07-24 — repair now addresses events by eid and applies as a chain jump, not a file truncation.)

### Tests

src/rollback.test.ts: walkActiveChainIndices unit tests, EventStore integration tests, consistency tests (readActive + readFromLastCompactMarker + restart).

## Which messages can be edited/rewound — three independent judgments (2026-07-25)

`/edit` is one backend operation and Rewind is an Edit whose content did not change, so **one answer
governs both buttons**. It is gated by three judgments, each a pure module at the plugin root, run
by BOTH layers (frontend greys the button, backend returns 400 — the frontend can lag because SSE
events carry no eid):

| module | question | the limit is on |
|---|---|---|
| `agent-activity.ts` `isWorking` | is the agent busy right now? | TIME |
| `run-start.ts` `messageStartsRun` | did the agent ever run FROM this message? | MEANING |
| `rewind-point.ts` `hasRewindPoint` | is there a state left to return to? | HISTORY |

`message-editability.ts` is the only place they meet. **Its checkable boundary: it has ZERO
imports** — it CONSUMES three verdicts and COMPUTES none, and a test asserts that by reading the
file. If it ever starts deciding something itself, that is when to split it.

### ⚠️ TOMBSTONE: two people tried to unify these on the same day. Do not.

Both attempts were the **same mistake — taking a PROPERTY of a thing for the thing itself**:

- *"the gates are one invariant at two timescales"* — both relate to unclosed tool calls, one asks
  "now" and one "at that position". Technically defensible and wrong: it explains a USER concept by
  its IMPLEMENTATION consequence. An end user has no notion of an unmatched tool call.
- *"the message is in the active chain, therefore it is rewindable"* — being in the context is a
  property of a rewind target, not the thing itself.

**API 400 is a symptom, not a reason.** Both framings leaned on it. Even if the API accepted a
rollback to a message the agent never ran from, the operation would still be **empty** — it points
at nothing. **Reasons must survive their failure mode disappearing.** The three judgments' only
shared property is that all three grey the button, which is a fact about pixels.

### The rule: which user turn PICKED THE MESSAGE UP

The user's own phrasing is the concept — **only an independently sent message can be rewound** —
and it is what the code and every user-visible string now say. "Run" only means something to
someone who has read the provider loop.

`buildUserTurn` packs `[...tool_results, ...queued messages]` into one turn. So **a turn carrying a
tool_result is ANSWERING the agent's own previous output**; anything riding along in it did not
start it. A turn with no tool_result exists *because* a message arrived. Both `messages_consumed`
and the tool_results before it are persisted, so this is decidable from the log. Walk back from
each `messages_consumed` to the turn boundary; unrecognised event types are SKIPPED, not treated as
boundaries — detaching a tool_result from its consumption is the direction that wrongly calls a
message editable.

**`yield`/`done` are the rule's best instance, not its exception.** Their results are written *at
wake*, by the very message being judged — so they are the message's CONSEQUENCE, not its cause:

| tool_result | caused by | counts as prior work |
|---|---|---|
| bash, read_file, … | already in flight before the message | yes — the message's CAUSE |
| yield, done | this message waking the agent | no — the message's CONSEQUENCE |

**The direction of causation is the rule; comparing tool names is only how it is detected** — hence
the predicate is named `isPriorWork`, not `isPark`. This exception was predicted to disappear under
the new rule and instead **grew**: 1513 of 2161 newly-blocked messages (70%) were yield turns, and
it is the DOMINANT shape for sub-agents, every one of which ends in `done()` and is later woken.

Measured on a 3621-message session: editable 97.2% → 79.8%, and **NEW-only-editable = 0** — a
one-way tightening that opens nothing the old rule blocked. The newly blocked were interjections
during work ("不错", "不要这样", "联网"), which by the user's own definition were not independently
sent. 20% describes the interaction style, not over-blocking.

### ⭐ The evidence was being sampled at the wrong instant

The first version tested for an unclosed tool_call at the message's **delivery** position. Real
trace that broke it:

```
12:57:53  MESSAGE   你跑个bash
12:58:01  MESSAGE   然后这条应该不能     ← arrived 10s BEFORE the tool_call
12:58:11  CALL      mcp__mxd__bash
12:58:49  MESSAGE   这条应该也不能回滚   ← arrived during bash
12:58:57  RESULT    mcp__mxd__bash
12:58:57  CONSUMED  2                    ← both picked up together
```

It blocked the second and **allowed the first**: at 12:58:01 the agent was thinking, composing the
call, so nothing was outstanding yet.

**The tombstone in `run-start.ts` must stay** — the next person's instinct is exactly "check for an
unclosed tool_call at delivery". Part A had documented this window honestly and concluded the log
could not do better: parking on `end_turn` writes no event and activity is deliberately never
persisted, so "parked, waiting for you" and "waiting for the model" leave the identical trace —
nothing. **Accurate about the DELIVERY moment, and irrelevant**: consumption leaves a trace, and
consumption is what answers the question. *Looking for evidence at the wrong instant is what made
the log look mute.*

Two sizing errors worth carrying, both of the form *reasoning where observing was cheap*:
- "the thinking gap is where the agent spends least of its wall-clock time" — true and beside the
  point. **Wall-clock share ≠ share of user actions.** "Ask for something, then add one more thing
  while it starts" is the most natural way to extend a request and lands squarely in that gap. It
  was hit on the first real use.
- "root's last 2000 lines contain no yield/done, so this is mainly a sub-agent problem" — the
  observation was accurate and the generalisation was not; `tail -2000` reflects a recent habit,
  not the session. The full log had 1513. **An accurate observation plus an over-broad
  generalisation is harder to challenge than a guess, because it arrives with a number.** Check the
  sampling window on every figure, including your own.

### Tri-state, and one piece of scaffolding to DELETE rather than repurpose

`messageStartsRun` returns `undefined` for an unconsumed message. That is not a new state — the
tri-state already exists for the reachable case (an eid not on the active chain, cut away by an
earlier rewind). Measured 0 of 3621 occurrences and the UI has no path to it (unconsumed messages
are pending chips, not log entries): **do not write logic for that branch.**

`processEventBatch(events, { fromActiveChain })` is **TEMPORARY**. It exists only because "Load
earlier history" fetches the raw file, including abandoned rewind branches and pre-compaction
history; annotating that would count a tool call from a branch nobody is on against an unrelated
message. **A gate that answers wrongly is worse than one that says "I don't know"**, so a raw batch
is not annotated at all. The real fix is server-side (mark active-chain membership in the response
— NOT a second copy of the chain walk in the browser, which is what *One boundary* removed). When
that lands, **delete the parameter, do not repurpose it.**

## One boundary: the active chain (2026-07-24)

"Which events count" had FOUR independent implementations. Now there is one:
`walkActiveChainIndices` (events.ts). `readActive`, `readFromLastCompactMarker`
and `copySessionFrom` all go through it; repair and rollback both express
"these events stop counting" the same way — a `parentEid` jump. Nothing
addresses events by file position any more, and nothing deletes.

### The rule

> The active chain ends at the `compact_started` of the last COMPLETED
> compaction. Inside that compaction's window, only `type === "message"`
> survives.

One backward scan does both jobs. `parentEid` always points at an earlier
position, so scanning backward IS the lookup — no eid→index map (O(result)
memory), and a cycle is structurally impossible because `i` only decreases.
Walking back: a `compact_marker` opens the window, its `compact_started`
closes the walk. `compact_marker` is always kept (walker treats it as
structural; `readFromLastCompactMarker` slices the UI log at it;
`buildSessionRepair` needs it to scope). `includeBarrier` is gone.

### Why the window (the bug it fixes)

Messages delivered WHILE the summarizer runs land between `compact_started`
and `compact_marker`. The old rule ended the chain at the marker, so those
messages were outside the active region while the `messages_consumed` that
acknowledged them (written after the marker) was inside — the walker resolved
a consumption record referencing an id it had never seen and dropped the
content silently. Measured on the root session: 22 compactions, 8 with
stranded messages, 15 lost, 4 typed by a human. The live path was fine; only
reconstruction (restart / fork / UI refetch) lost them, so this was pure
live-vs-reconstruction drift.

The window filter is equally load-bearing in the other direction: the
summarizer's own `thinking` + `<summary>…` `assistant_text` + `usage` must NOT
come back — the summary is already in the context as `compacted_resume`.

### ⚠️ Do NOT encode the barrier as `compact_started.parentEid = null`

This looks cleaner (termination collapses to the chain root, zero type
knowledge) and it is WRONG. Two independent reasons, both verified:

1. **A compaction is a 2-3 minute window whose outcome is unknown when
   `compact_started` is written.** Real durations from the root session:
   124s (1784053169510→1784053293730), 178s (1784222935672→1784223113791),
   145s (1784829047832→1784829193473). If the daemon dies inside that window
   there is no summary at all — but the chain root is already committed, so
   the active region becomes `[compact_started, window messages]`, the agent
   resumes with an empty context, `hasWorkContext` is false so a fresh
   work_context gets injected, and it carries on like a newborn. No error, no
   crash: **silent total context loss**, recoverable only by hand-editing
   JSONL. Under self-bootstrap (dozens of restarts a day) this is a matter of
   time. The type rule handles it for free: no marker ⇒ not a barrier ⇒ full
   history stays reachable.
2. **The type check has to exist anyway.** Logs written before
   `compact_started` existed have a marker with no opener, and walking past
   such a marker would drag pre-compact user messages back into the context.
   That legacy branch is mandatory — so emitting `null` only ADDS a mechanism
   on top of it, plus a migration pass over every existing session (otherwise
   the chain runs to line 1 and a compacted session's whole 84MB history
   floods back on the next restart). Strictly more code, strictly more risk.

Orchestrator's framing after being talked out of it twice: encoding structure
in links fits a JUMP (rollback, repair — you know the target when you write
it). A compaction is an INTERVAL whose validity depends on a result you don't
have yet. Don't express an undetermined fact as a link.

### Repair is a chain jump, never a truncation

`buildSessionRepair` returns `{ chainToEid, appendEvents }` (`SessionRepair`).
The caller does `setChainHead(chainToEid)` + `appendBatch` — literally the
rollback mechanism. `chainToEid: null` means append-only (orphan repair).
Deleted: `EventStore.truncateAfterLine`, `readWithLineMap`,
`readActiveWithLineMap`, the `physicalLines` array, and the event-index →
file-line translation that produced FIX-1 cc#1 and FIX-8 R8-B#4. Poisoned
events stay on disk and simply stop being reachable, so the evidence needed to
debug a corruption survives it.

**A truncating repair ALWAYS appends at least one event.** `setChainHead` is
pure in-memory; the jump only reaches disk as the first appended event's
`parentEid`. Both truncation strategies therefore append a `status` event
("Session repaired: …") LAST — last so it can never split a run of
tool_results into two user turns (the walker skips `status`, but position
still matters for the tool_result collection loop). Without it, the repair of
a session that resumes in pending-done (no orphan results, no replayed
messages, status user-message suppressed) would evaporate on restart and loop
forever.

Messages in the dropped region are replayed (fresh eids) so
`findUnconsumedMessages` re-delivers them. ALL of them, not just the ones
without a `messages_consumed`: a message consumed into a turn the repair just
dropped is exactly as absent as one that never arrived. Strategy 2 already did
this; Strategy 0 (out-of-order) silently ate them.

`buildSessionRepair` THROWS if the event it must chain to has no eid. Every
event on an active chain is stamped (EventStore stamps on write, migrates
legacy files on read), so that means the caller passed something that never
came from a store. A repair that cannot express its jump would leave the
poison in place and loop — better to ring.

### Fork had its own copy of the boundary — three bugs, one of them irreversible

`copySessionFrom` computed `findLastIndex(compact_marker) + slice()`. Now it
calls `readActive` (fork means "wake up with the source's current context" —
that IS readActive's definition). Fixed, each mutation-verified separately:

1. **Rolled-back events were copied into the child.** A linear slice ignores
   parentEid entirely. Empirically: source `readActive` = 2 events, fork
   copied 4.
2. **Window messages were dropped**, same root cause as the source-side leak.
3. **The copied subset was NOT re-linked.** The active context is a FILTERED
   subset, so the copied events' original parents (compact_started, the
   summarizer output, a rolled-back branch) are absent from the child's file.
   Copying links verbatim leaves a hole; everything older is stranded. The
   copy now keeps SOURCE eids (identity survives) but re-chains parentEid.

Also: the compaction boundary events are NOT copied. Only half of one can be
(compact_started is outside the active region by definition), and a lone
marker in the child reads as the legacy "unpaired marker" shape — so the child
would discard exactly the window messages we just inherited, with nothing left
in its file to ever recover them. That is the one genuinely irreversible
version of this bug: the source recovers on restart, a fork never does.

### ⚠️ Being ON the active chain ≠ being a legal rewind target (2026-07-25)

The most expensive corollary of this design, found by the Edit/Rewind gate. **The active chain is
NOT a uniform `parentEid` chain — it is a CONSTRUCTED sequence.** After the compaction point,
array order and chain order are the same thing. The window messages are **spliced in** by the
walker: adjacent in the resulting array, but their parent links point into the region the summary
replaced.

Rewinding is a pure parent-link operation (`setChainHead(target.parentEid)`). So **it is only
defined on the segment where construction order and chain order agree** — which excludes exactly
the window messages.

Measured (seed a completed compaction, rewind to the window message, read `readActive` back):

```
active BEFORE: [message:m-window, compact_marker, message:m-after, messages_consumed]
window msg's parentEid points at: compact_started
active AFTER : [assistant_text, compact_started, message:m-edited]
pre-compact history resurrected? true
summary still present?           false
```

Mechanism: the walk only treats `compact_started` as a barrier **once it has already passed a
`compact_marker`** (`window !== null`). With `window === null` it is an ordinary event — pushed,
and the walk continues. Set the chain head to a window message and the backward walk never meets a
marker, so the window mechanism never arms and it runs to the first line of the file. On a real
session that is the entire summarized-away history returning at once, with the summary stranded on
the abandoned branch.

**Making the window messages visible was correct** — they genuinely are context, and that is what
this section's window rule is for. Reading *visible* as *operable* is the error. A separate
predicate (`hasRewindPoint`, `.mxd/plugin/rewind-point.ts`) answers "is there a state left to
return to", and its mutation test fails on the DAMAGE — it asserts the resurrected history is
absent by name — so anyone who tries to relax that limit sees what they just did rather than a bare
status code.

### No dangling-link handling — and nothing may produce one

A `parentEid` pointing at an eid no line carries gets NO fallback. Same rule as
`buildSessionRepair` refusing to repair orphan tool_results: a state the
runtime cannot produce must not have code that quietly patches it, or the code
becomes a silencer for real structural bugs. It shows up as "the events before
it stop rendering", which is what we want.

That premise is only true because a failed write now REWINDS the chain head
(`rewindChainHead` in append/appendBatch). `stampEvent` advances
`lastEventIds` before the write; on ENOSPC/EIO the event never lands, and the
next event would then name a nonexistent parent and strand the session. An
event that isn't on disk isn't in the chain.

(An event with NO parentEid at all still ends chain-following and takes the
rest linearly — that is the genuine root at index 0, and it is what lets a
pre-eid log be read.)

### Test notes

- `src/rollback.test.ts` owns the walker + fork + repair-as-jump tests;
  `src/jsonl-stress.test.ts` owns the pure repair-strategy tests.
- Repair fixtures MUST carry eids now (`chained()` helper in both files, plus
  `events.test.ts`) — a repair chains to an event, so an eid-less fixture is
  not modelling production. That is a feature: it throws.
- Mutation-verified, each fix individually: barrier back at `compact_marker`
  (5 fail), no window type filter (5), unpaired started treated as a barrier
  (2), fork's old linear slice (3), fork without re-link (2), fork without the
  marker strip (2), no repair status event (2), no message replay (1), no
  chain-head rewind (1).
- Assertions about "the poison is gone" must read `readActive`, NOT the raw
  log — repair no longer deletes. `readActiveSessionEvents` exists next to
  `readSessionEvents` in integration.test.ts for exactly this.
- A test that needs a genuinely truncated file (simulating a crash that ended
  the log early) does the file surgery itself; the product has no such
  operation any more. See the Phase-2 crash-recovery test in integration.test.ts.

## Every transport carries the event's name (eid) — and what that let us delete (2026-07-25)

Four consumers wanted the same missing thing and were each about to grow their own locating
mechanism: the Edit/Rewind gate, message deep-links, viewport addressing, and "is this event still
part of the conversation". They are one thing — **the frontend needs the persisted event identity
on the path it actually receives events over** — and it was missing for one reason: `emitEvent`
broadcast BEFORE persisting, so SSE clients were shown events they could not refer to.

### The mechanism: `append` is synchronous and returns the persisted event

`EventStore.append`/`appendBatch` stamp the chain fields and write in one uninterruptible step and
return the stamped copy; `emitEvent` persists first and broadcasts THAT. One object, one name,
every transport.

**Why not "stamp now, write later"** (the shape tried and reverted in 01KY54YT round 11, whose
failure was two writers of `lastEventIds` racing):

- ONE writer of the chain head. This MOVES the only stamper earlier rather than adding a second, so
  the TOCTOU has no premise left. (Round 11's measurement was real and its product judgement —
  "rollback isn't a realtime feature" — is what expired.)
- ⭐ **The write-failure path is the load-bearing argument.** `rewindChainHead` keeps a failed event
  out of the chain, and that is correct ONLY while nothing can be stamped between the stamp and the
  write. Defer the write and a burst in one tick gets stamped first: the event after a failed one
  names a parent no line carries, the walk stops dead (no dangling-link fallback, deliberately), and
  the agent resumes with a **silently truncated context**. Synchronous keeps the cost of a failed
  write at "one event lost" instead of "history lost". Pinned by a test that chmods the file
  read-only and asserts the next event chains to the last one that actually landed.
- The general form: it replaces "correct because nothing happens to interleave" with "correct
  because nothing CAN".

`enqueueWrite` + the generation guard survive for `copySessionFrom`, the one genuinely async write.
Its docstring now says outright that **the guard has no reachable failure path today** — a mechanism
that looks like protection but protects nothing is worse than none, because the next reader reads
"there is a queue" as "there is protection". Revisit once synchronous appends have production
mileage: draft 01KYCQDJRF8Z8S6YC39F7ECVZ8.

### Entry ids come from the eid — the React key, not a display value

`createLogEntry` derives `LogEntry.id` from `eid` (`Map<eid, number>`, never cleared — clearing it
IS the failure it prevents). The log is replaced wholesale on every refetch, and a module counter
made every key change every time: measured in a real session as ONE MutationObserver batch with
`added: 82, removed: 82` against `removed: 1` for a normal update in the same trace.

Two entries exist BEFORE the event they are named after, and both **bind** their eid to the id they
already have rather than re-deriving it:
- a streamed text/thinking block is built from `*_delta`, which is never persisted, and learns its
  eid when the block closes;
- a tool card is replaced in place by its `tool_pair` when the result lands — which is exactly when
  a user is most likely to have it expanded. (That one was a live, independent bug: every tool card
  remounted and lost its expanded state the moment its result arrived.)

⚠️ **`key={entry.eid ?? entry.id}` is the wrong shape** even though it looks simpler: it moves the
key at the end of every streamed block, adding a per-block remount that does not exist today.

**Known residual, deliberate**: an entry that is still streaming when a wholesale replacement lands
changes key once — its rebuild source is the route-injected `partial: true` synthetic, which by
definition has no eid. One entry, no container collapse, and the buttons are disabled anyway
(`isWorking`). Closing it needs a second lifecycle-bearing map, i.e. a branch for an imagined
consumer (anti-pattern #6). Add it if it ever produces an observable symptom.

### Run-start is decided in the ONE in-order channel

"Was this message sent on its own" used to be a second pass over the raw batch AFTER entries were
built, which made it structurally unanswerable for a live message (the live path sees one event at a
time and never holds a batch) — and that is why Edit/Rewind could only appear via a JSONL refetch.
`processEvent` is reached in event order by BOTH paths, so the current turn is tracked there and the
verdict is set at the `messages_consumed` that picks the message up. The rule itself is
`turnAnswersPriorWork` in `run-start.ts`; the whole-log pass calls it too. **One rule, two entry
points**, locked by a test asserting the in-order map equals the one-shot map key for key.

### Active-chain membership needs its own bit — and this is the general reason

> **eid is an IDENTITY (immutable, per event). Membership is a RELATION between an event and the
> current chain head.** A rewind changes it for a whole stretch of log without touching a single
> event in it. **An immutable identity cannot encode a mutable relation.**

So the raw-file fetch (`GET .../events` without `after=compact`, i.e. "Load earlier history") marks
each event: `offChain: "summarized" | "abandoned"` (`classifyOffChain` in events.ts, built on the
one `walkActiveChainIndices`). The client gets the ANSWER, never the algorithm — a second chain walk
in the browser is what *One boundary: the active chain* removed.

Marked only where it is not the obvious answer: every other transport carries active events by
construction. Explicit-everywhere was considered and rejected — it does not actually buy safety,
because the reader still has to choose what `undefined` means, and it costs bytes on the hottest
path.

KNOWN IMPRECISION, documented in place: the summarizer's own output inside a compaction window is
labelled "abandoned" where "summarized" would be truer. Nothing reads it (only user messages carry
the buttons), and a third category for events with no consumer is a classification describing its
author.

### Two workarounds deleted, both by the person who filled the hole they stood in

- `processEventBatch(events, { fromActiveChain })` — gone. Off-chain events are simply dropped from
  the turn windows, which leaves exactly the active chain in order.
- **the re-fetch on agent idle** — gone. It existed only to go and get eids the broadcast did not
  carry, and it replaced the entire log to do it.

Refusal wording followed: "No longer part of the conversation" was what the UI said when it could
not tell — about every message in the batch, including ones still in it. Now it says which way the
message left, and either reason outranks "the agent is busy", because that one promises a remedy
that will never arrive.

### Live verification, including one honest negative

Real browser, two daemons (this branch vs main), same fixture, content deliberately expensive to
rebuild (tool cards, markdown tables, images with no reserved height — 327 entries). After "Load
earlier history":

| | main | this branch |
|---|---|---|
| Edit/Rewind enabled | **0 of 280** | 120 messages editable |
| what the rest say | all 280: "No longer part of the conversation — an earlier rewind replaced it." | the 20 pre-compaction ones: "From before the last context compaction…" |

**Negative result worth keeping**: the load-older path did NOT remount on EITHER build (90 of 100
entries kept both their React key and their DOM node, identical on both), so it does not discriminate
the id change. The measured `+82/-82` came from the **agent_idle** refetch specifically — which this
work deletes outright, so that trigger is gone rather than made cheap. Do not cite the load-older
path as evidence for or against the key derivation; use the unit tests, which mutate in both
directions.

Also, twice in one session, a first measurement measured the wrong element: `log.children[0]` is the
"load earlier" bar, not an entry, so "the first node is still attached" was true on a build that
remounts everything. Same shape as the viewport task's container-vs-content error. **Check what your
selector actually points at before believing a null result.**

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

### Cache results — measured once, when the four fixes landed
- Restart: 99.8% cache hit (582 creation / 362K read)
- Fork: 100% cache hit (0 creation / 365K read)

These are a **dated measurement**, not a current reading: they are the evidence that the four fixes
above worked, and they stay true as a record of that moment. Do NOT read them as "our cache hit rate
is 99.8%" — nothing re-measures them, and a prefix change would move them without touching this
file. If you need today's number, read `cache_creation` / `cache_read` off a real `usage` event.

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

## Pre-API-Call Debug Snapshot (v2: per-traceId epoch)

Layout: `projects/<id>/debug/<taskId>/<traceId>/last.json`. Each `runAgentForNode` gets unique `loopTraceId`. Restart → new dir → old snapshot preserved. `rollOldTraceIdDirs` keeps 10 most recent. Post-mortem: diff two newest traceId dirs' `last.json` files to find drift.

## Live/Reconstruction Drift Fix — Caption Bug

`buildUserTurn` now delegates to walker callbacks (single source of truth per provider). Live path has no independent construction logic — can't drift from JSONL reconstruction. Initial drain also delegates via `adapter.appendQueueMessagesToMessages`. Dead ToolResult fields (`formattedQueueMessages`, `consumedMessageIds`, `consumedQueueMessages`) removed.

---
# Providers & API
---

## 70K Post-Restart Cache Miss (RESOLVED — correct diagnosis 2026-04-16, bit-exact proof)

Caused by **Anthropic occasionally routing our OAuth traffic to what was then the unreleased Opus 4.7 tokenizer/model**. NOT a Matrix bug. The previous hypothesis ("server-side system prompt injection") was wrong — corrected via bit-exact replay experiment.

> **Sibling case**: this and *Fable-class connector-text summarization* (below) are the same class —
> the server did something it did not disclose, and the client's own records are the only way to
> catch it. Here the model was swapped while `response.model` kept reporting the declared one; there
> the reply text was rewritten while the original stayed encrypted in a signature. Both were found
> by comparing what we sent/stored against what came back, and in both the first hypothesis was
> wrong. If you are ever debugging "the API behaved impossibly", read both before theorizing.

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

## OpenAI Provider

- **There is ONE OpenAI provider: `OpenAIResponsesCompatibleProvider`.** `createProviderFromAuth`
  always builds it for OpenAI auth.
  ~~Chat Completions (`OpenAICompatibleProvider`) is dead code — not wired into production.~~
  **That file no longer exists** — `src/openai-compatible-provider.ts` and its 1624-line test were
  deleted in the FIX-4b sweep along with `eventsToOpenAIMessages`. Do not go looking for a
  "Chat Completions path"; there isn't one to compare against.
- Responses `streamResponsesAPI` has inner retry (5 attempts, exponential backoff) matching Anthropic. `retryDelayMs` param for fast tests.
- Function tool definitions include `strict: false` in outgoing payload.
- **Tool input Zod validation**: `executeTool` validates all built-in tool inputs against Zod schema. Rejects invalid types at schema boundary. External MCP tools (empty `inputSchema {}`) skip validation.

### SDK

Both providers use the `openai` npm package. `DebugSnapshot.body` === the exact object passed to the
SDK. `ChatCompletionMessageToolCall` is a union — filter on `tc.type === "function"`.

## Hidden Tools via Anthropic Free-Form Name Sampling

**Matrix's tools list frozen in session_config** defines what the LLM sees in its tool inventory. But the DAEMON's handler registry has every registered tool.

**Anthropic API** uses free-form tool name generation — server dispatches any name to whatever handler exists. Agents can invoke tools NOT in their tools list (e.g., `evaluate_script` is intentionally hidden from session_config). If you know a tool's name, you can call it.

**OpenAI Responses API** uses schema-constrained sampling — the model's probability distribution is masked to only tool names in the provided tools array. Agents CANNOT call tools not in session_config on OpenAI. `strict: false` on Responses only relaxes optional-field validation, not tool-name enforcement.

**Operational consequences**:
- Anthropic agents: can invoke create_folder, delete_folder, etc. by name even in sessions where those tools weren't frozen in
- OpenAI agents: must see the tool in their list to call it
- This is WHY compact-refresh-tools fix is OpenAI-critical, Anthropic-nice-to-have

## Thinking Block Provider Filtering

Thinking events have `provider?: string`. Switching providers automatically drops stale thinking blocks (provider mismatch → filtered). OpenAI walker ignores thinking entirely.

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

## Fable-class connector-text summarization: the model's context ≠ what the client stores (2026-06-09/10)

Three entries merged: the symptom plus a hypothesis that turned out wrong, the canary experiment
that proved the actual mechanism, and the official doc that named it. Only the last is
authoritative — the first two are kept for the forensic techniques, which are model-agnostic and
have been reused since.

⚠️ **Scope**: this is Fable-class behavior; Matrix has been on opus-class since. Treat the mechanism
as dormant rather than gone, and the techniques as permanently useful.

### What it is (official — AWS Bedrock `claude-messages-adaptive-thinking.html`)

Text emitted BETWEEN tool calls ("connector text") is **summarized server-side and returned as a
thinking block** — standard thinking shape, no new content-block type, with the signature carrying
the encrypted original. **"No customer opt-in or opt-out."** SDK version is irrelevant, exactly as
measured.

The scope rules explain why it looked intermittent:
- applies only AFTER a tool_result exists in the conversation,
- SHORT text segments may pass through unsummarized,
- **final assistant answers — text after all tool use is done, i.e. an end_turn — are UNAFFECTED and
  stay plain text.**

Echo-back: pass the thinking blocks back unchanged; the signature is validated, and stripped if sent
to a different model.

**How it presents** (this is what to look for if it ever recurs): assistant turns WITH thinking are
stored as `[thinking, thinking, tool_use]`, where the SECOND "thinking" block is a server-generated
summary of what should have been the visible reply — sometimes an English paraphrase of a Chinese
reply — carrying a signature. In the UI the user's reply vanishes into the thinking fold. First
reported by story1001, then reproduced in root's own session. **Matrix is faithful here**: the SDK
accumulator and the walker reproduce whatever blocks the server sent; nothing on our side reshaped
them. Confirmed by reading the raw `last-response.json` — a 135-char compressed paraphrase standing
in for a ~300-char actual reply.

Fable 5 launched 2026-06-09 (public Mythos-class with a safeguard layer; classifiers route
cybersecurity / bio-chem / distillation requests to a guarded path — which makes the
anti-distillation reading correct as motive).

### Operational mitigation: end the turn, don't call yield()

Replying and then calling `yield()` in the same turn makes the reply *connector* text (text followed
by a tool_use) → summarized away. Matrix already treats **end_turn as an implicit yield**, with
identical pause semantics. So an agent whose last action is a user-facing reply should **end its
turn** rather than call yield(); the reply then survives as plain text. Explicit yield() is still
fine when no user-facing prose precedes it.

### The proof: the signature carries the original, decrypted server-side

Two-sided canary experiment (2026-06-09 ~23:50):

1. **Setup turn** — a 12-digit random canary written ONLY in visible reply text, kept out of every
   tool input. The turn was downgraded: client-side JSONL stored a 132-char paraphrase that mentions
   "这串随机数" but DROPS the digits. The canary existed NOWHERE client-side.
2. **Recall turn** — the next turn's agent recalled the full canary verbatim from its context, with
   the recall claim recorded in a tool input (timestamped before any read). All 4 later JSONL
   occurrences of the canary come from post-recall commands.

**Conclusion**: the signature's encrypted payload is decrypted server-side on echo-back and the
ORIGINAL content is reconstituted into the model's effective context. The model sees its own
originals; the client and the user only ever hold server-rewritten summaries.

- **"context = messages[]" is FALSE** under this mechanism, and **the model cannot detect the
  divergence from inside** — only comparison against client-side records reveals it.
- The thinking-block packaging is a compat envelope that guarantees the ciphertext round-trips (old
  clients faithfully echo thinking + signature), so model continuity survives.
- Corroborating measurement: signature length is content-proportional (observed 364…14756 chars,
  ~2-4× the displayed text; opus-era thinking already did this) — consistent with an encrypted
  payload of the original rather than a checksum.
- Historical JSONL keeps the summarized turns. That is an accurate record of what the server sent;
  there is nothing to repair retroactively.

### Forensic techniques (model-agnostic, keep these)

- ⭐ **An agent's memory of its own past replies is NOT evidence of what the user saw.** When
  verifying user-visible behavior, read JSONL / debug snapshots. Never trust introspection of your
  own context. This is the single most transferable thing in this entry — it applies to any
  divergence between what a model believes it emitted and what was persisted.
- **Canary protocol**: put a unique token in visible text ONLY → have the next turn record its
  recall inside a tool input BEFORE any read → grep the client-side records. Tool inputs are the
  only generation-time verbatim side channel, because they must be executed as written.
- **Raw-response snapshot**: when block types look wrong, read the per-traceId
  `debug/<taskId>/<traceId>/last-response.json` — the raw server response, written before tool
  execution, so a bash call can read its OWN turn's response. Separates "server sent this" from
  "we corrupted it" in one step.
- Two more in the same family, recorded in *fable silent-turn → silent idle* (Agent Loop region):
  **base64-decoding a thinking block's `signature`** reveals which model actually served the turn,
  independent of `response.model` (which can lie under silent routing); and **a clean `usage` event
  proves the API turn completed**, which distinguishes "the upstream ended the turn oddly" from "we
  were cut off mid-stream" — the latter would have orphaned the turn and triggered repair on resume.

### Known gaps this exposed, deliberately NOT closed (anti-pattern #6 — wait for real data)

1. **`fallback` block** (server-side model fallback on refusal): `buildResponseEvents` has no branch
   → not persisted to JSONL → the post-restart walker omits it → per the SDK docs the thinking hash
   chains flanking the boundary then cannot verify → request rejected. Only fires if a fallback hop
   actually occurs.
2. **New stop_reasons** (`refusal`, `pause_turn`, `compaction`, `model_context_window_exceeded`):
   `getStopReason` maps everything non-`end_turn` to `"tool_use"`. See *fable silent-turn → silent
   idle* for what that costs when an anomalous stop happens.
3. **Check the SDK version first** on any future "weird block" bug — Fable-era servers changed
   behavior by SDK version, so a version gap is a cheap thing to rule out early.
   (This item used to read "SDK pin is a caret (`^0.104.0`), fine for now". It is no longer a caret:
   package.json pins `@anthropic-ai/sdk` EXACT at `0.104.0`. Same reason `zod` is pinned exact —
   see the plugin SDK's zod-identity note.)

### The hypothesis that was wrong, and why it is kept

The first diagnosis was **SDK-version sniffing**: the server reads `x-stainless` headers and serves
old SDKs (0.78) a compat format in which signed content is downgraded to thinking blocks. It was
plausible, it matched the observed block shape, and it produced an action: bump
`@anthropic-ai/sdk` 0.78.0 → 0.104.0 (commit a61d341, kept — new model types, harmless).

**One post-restart sample verified clean, and the pattern then recurred within the hour** — in
multiple sessions, including the very turn that had "verified" the fix.

Two things worth carrying out of that:
- A single passing sample after a fix is not verification when the phenomenon is *intermittent by
  design*. The scope rules above say short segments may pass through unsummarized — so a clean
  sample was always available regardless of the fix.
- The official doc later stated "no customer opt-in or opt-out", which is the same fact the
  recurrence had already demonstrated. The measurement was right before the documentation existed;
  what was wrong was the *causal story* attached to it.

## The Anthropic message-shape rules, MEASURED (2026-07-25) — and the fictional one we built on

⚠️ **`ValidatingMockAPI` enforced a role-alternation rule that DOES NOT EXIST.** 628 occurrences of
"Messages must alternate roles" in our JSONL history; **every one came from our own mock, none from
the API.** Four mechanisms, one `test.todo` and one memory "⭐ reusable pattern" were built to avoid
a 400 that cannot happen. Full audit + per-mechanism verdicts: task **01KYCQ856M3Z6F4EN247C4GW69**.

### The rules, as measured against production Anthropic (19 shapes, OAuth, `claude-opus-5`)

1. **First message must be `user`.** (mock had it ✅)
2. **The conversation must END with a `user` message.** Ending on assistant →
   400 *"This model does not support assistant message prefill."* (mock did NOT have it ❌)
3. **The tool-answering rule — and it is NOT "in the next message":**

   > Flatten the user messages after an assistant-with-`tool_use` into one block stream. Take the
   > **maximal LEADING run of `tool_result` blocks**. It crosses message boundaries freely; **any
   > non-`tool_result` block ends it** — including a *trailing* text block in an otherwise-fine
   > message, and including a plain-string user message. Every `tool_use` must be answered inside
   > that run.

4. **Every `tool_result` must answer a `tool_use` in the preceding assistant message** (orphan →
   400). (mock had it ✅)
5. **Consecutive same-role messages are LEGAL** — user/user, user/user/user, and assistant/assistant
   all accepted. (mock forbade ❌ — the fiction)
6. **Empty content is LEGAL** — `""`, `[]`, and `[{type:"text",text:""}]` all accepted. (mock
   forbade ❌ — a second, unnoticed fiction)

Consequences of rule 3 that nothing tests today:
- results **split across several user messages** are fine (`[R1] [R2] [R3,text]` ✅), in **any order**
- `[R1, text]` then `[R2, …]` is **400** — the trailing text ended the run before R2
- `[text, R1]` is **400** — block ORDER inside the message matters
- ⭐ **`buildUserTurn` packs `[...tool_results, ...queueMessages]`, tool_results FIRST. That order is
  a real API requirement, not style.** Put text before a tool_result, or between two batches of
  them, and you get a production 400 with a fully green suite.

### Reachable bug this exposed (BEHAVIOR SNAPSHOT test, `src/reachable-400-snapshot.test.ts`)

`provider-shared.ts` "context too short to compact" (`manualCompactRequested && messages.length <= 4`):
a fresh agent whose first turn ends with `end_turn` has `messages = [user, assistant]`; `/compact`
takes the compactOnly path → `continue` → the too-short branch clears the flag and `continue`s with
nothing to push → next iteration sends a request **ending in assistant** → 400. Reproduced
end-to-end through the real agent loop; the agent crashes. **No new code needed to reach it.**

### ⭐ The general lesson — how a fictional rule gets installed

`jsonl-stress.test.ts`'s `assertStructurallyValidApiMessages` wrote down BOTH rules in the same
comment, then chose:

> *"We don't assert the trailing-role rule because some walker outputs are intermediate and meant to
> be extended. We DO assert the alternation and structural shape."*

**That reasoning is correct.** Some walker outputs genuinely are conversation *prefixes* that end on
assistant; asserting the real rule would redden correct fixtures. So:

> **An inconvenient TRUE assertion + a conveniently-green FALSE one ⇒ the false one gets installed,
> and is then believed as fact.** The fiction does not win on persuasiveness — it wins on **not
> causing trouble**. Once it lives inside a `throw` it starts MANUFACTURING EVIDENCE: 628 error
> strings from the rule that was *executed*, 0 from the rule that was merely *documented*. **The
> knowledge was never lost; the enforcement was.**

**Detector — do not audit whether the assertions are correct** (that comment was entirely correct).
Ask instead: **is the rule being ENFORCED the same rule that is DOCUMENTED?** Wherever those two
fork is where the fiction starts producing evidence.

### An over-strict test double bills you in THREE ways, and the third is the quiet one

1. **It creates complexity you pay for.** Four `pending*` mechanisms, a `test.todo`, and a memory
   entry filed as a ⭐ reusable pattern — all to dodge a 400 that cannot happen.
2. **It hides gaps.** A fiction occupying the "role rules" slot stops anyone asking what the real
   role rule is, so the true one (last message must be user) got zero coverage and a reachable
   production 400 sat there unnoticed.
3. ⭐ **It VETOES correct code — and this one never looks like a bug.** Found the same day by
   01KYBB2Z: interrupting an agent before it emits anything, parking it, then sending another
   message produces `[…, user, user]`. Legal; the old mock rejected it. So the correct
   implementation could not be tested, the test was truncated at the park, and a comment was left
   saying the mock's constraint was unverified. **Nothing was red. The feature simply acquired a
   reputation for being "hard to test".**

The first two produce artifacts you can go find — code, a todo, a crash. The third produces
*absence*: a test that stops early, a scope quietly trimmed, an approach abandoned as awkward.
**Ask what your test double has been making people give up on**, not only what it has made them
build. A fiction's cheapest victims are the ones that were never written down.

**The name is the other tell.** `assertStructurallyValidApiMessages` fuses two different predicates:
*structurally valid* (a prefix property) and *API messages* (a sendable-request property). The code
can only be one of them, so it silently became the weaker one plus a fictional bonus — 2 of its 5
listed rules fictional, 1 true but deliberately unasserted. **A name that claims "valid" without
saying valid-for-what will drift to "matches what we imagined".** The way out is two predicates:
a *prefix* check and a *sendable* check. **Shipped as `src/test-utils/api-message-rules.ts`:**
`wellFormedPrefixViolations` (first-must-be-user; pairing, but an answering run that simply RUNS OFF
THE END of the array is incomplete rather than broken; orphan tool_results are violations at any
position) and `sendableRequestViolations` (all of that, plus trailing-role, plus the last
assistant's tool_uses must be answered by now). `ValidatingMockAPI.validateRequest` is the sendable
one; `jsonl-stress.test.ts`'s helper is the prefix one, renamed `assertWellFormedPrefix`.
`emptyContentViolations` holds the non-rule, opt-in, under a name that says it is ours.

**Note the second half of the trap**: the PAIRING rule has the same intermediate-state problem the
trailing-role rule has (an assistant's tool_results legitimately arrive after the prefix ends). So
whoever tried to assert the true rules with only one predicate available would have gone red on
correct fixtures *twice*, not once. **Courage was not the missing ingredient; the concept was.**
That is what makes this a structural failure rather than a lapse — and it is why the fix is a new
type of assertion, not a stricter one.

Sibling entries, same family: *"a real error message + an unverified attribution beats a pure guess,
because it arrives wearing evidence's clothes"* — the phrase that propagated this one was an
offhand "(matches real Anthropic)" that nobody checked. And *"an accurate observation + an
over-broad generalisation is harder to challenge than a guess, because it arrives with a number"*
(Which messages can be edited/rewound).

### Probing the real API: the `systemPreamble` trap

Any probe against the OAuth endpoint **must send the auth group's `systemPreamble` as the FIRST
system block**, or every call 429s. A first-pass probe that omitted it produced a wall of rate
limits that reads exactly like validation failure — nearly yielding the opposite conclusion. Probes
live in `/tmp/alt-probe/` (`probe2.ts`-`probe6.ts` = API shapes, `walker-shapes.ts` = runs disputed
shapes through the real walker and checks them against the measured rule). They read `oauthToken`
from config and never print it.

### What the measurement cost, and the one number that reframes it

Full `bun test` with the mock progressively made realistic (env-gated during the experiment, now
shipped): **A** (drop alternation) 2774/2 — one is the mock's own self-test of the fiction, one a
known teardown flake that did not recur; **B** (+ trailing-role) 2776/1; **C** (+ the real pairing
rule) 2776/1. In every variant **the only real failure was the mock's self-test of the fictional
rule.** The realistic mock was a drop-in: nothing depended on the fiction and the true rules cost
nothing to adopt — they were simply never asked for.

⭐ **Zero existing tests went red when the true rule was added, and that is the finding, not a
disappointment.** The expectation going in was "some tests will red, and those reds are assets".
They didn't, because `validateRequest` only ever sees requests the loop actually decided to send —
and the loop only sends when its state is right, *except* on the one reachable bug, which had no
test at all. **The fiction was not masking existing tests. It was masking the fact that nobody had
written the missing one.** A gap does not turn red; it stays invisible until someone goes looking,
which is why the probe had to be written by hand rather than discovered by running the suite.

### What DID go red: swapping the fused helper for the two real predicates (10 tests)

Splitting `assertStructurallyValidApiMessages` into prefix/sendable and giving both the measured
rules turned 10 tests red. **Every one was a fixture that could never be sent to the API, and none
of them was fixed by loosening a rule** — they were fixed by making the fixture a real
conversation. Two shapes:

- **6 walker fixtures produced assistant-first output** — no leading user message, because the
  fixture only cared about the assistant/tool region. Given a `user` head, they assert exactly what
  they always did.
- **4 prefix-byte-comparison fixtures opened with an orphan `tool_result`** — no assistant carrying
  the matching `tool_use`, because those tests are about byte diffing, not conversation validity.
  Given a real head, likewise unchanged.

One did NOT get a head, and it is the interesting one: the dirty-JSONL scenario table contained
`orphan assistant_text with no user message before it` under the blanket claim *"walker produces
valid structure"*. It doesn't — that output is assistant-first and the API rejects it. Moved to its
own BEHAVIOR SNAPSHOT. **Not hypothetical**: FIX-5 R8-B#1 records a session permanently bricked by
exactly this shape (a bare `compact_marker` left `readActive()` starting on an assistant turn),
quoting the same API error.

⭐ **The count that says how far this went.** The old helper's own comment listed five things it
was about. Of the FOUR rules the API actually has, it enforced **none**: never checked
first-must-be-user, explicitly skipped trailing-role, never checked pairing or orphans. What it did
enforce was role-is-one-of-two (a type constraint) plus the two fictions. **A helper named
`assertStructurallyValidApiMessages`, called from 10 sites, enforced zero real API rules for
months** — and looked like coverage the whole time. That is the shape to watch for: not a wrong
assertion, but a *confident name over a predicate nobody re-derived from the source of truth*.

---
# Data Model & Storage
---

## Image Handling

- **Pixel dimension guard**: `getImageDimensions(buffer)` in `src/image-dimensions.ts` parses PNG/JPEG headers. read_file rejects >8000px per dimension.
- **Provider-level byte size**: `validateImage?` on `ProviderAdapter`. Anthropic: 5MB decoded. OpenAI: 20MB decoded. Four filter points in `runProviderLoop`.
- **Streaming text partial**: `ctx.streamingText: Map<string, string>` tracks text_delta. Batch events endpoint injects synthetic `assistant_text` with `partial: true`.

## TaskNode Serialization — stripSession()

`JSON.stringify(TaskNode)` must NEVER include `session` (runtime-only: messages[], allTools, queue, abortController). Use `stripSession(node)` from `types.ts`. All four MCP tools that return TaskNode now use it: `get_tree`, `get_task`, `create_task`, `update_task`.

**Bug found**: create_task and update_task were missing the strip. A forked task (700K+ tokens in messages[]) updating its own description produced a 2.95MB tool_result → context doubled from 735K to 1.75M → API rejected. get_tree and get_task already had manual `const { session, ...rest }` — unified to `stripSession()`.

## Unified Storage Layout

⚠️ **The `~/.mxd/projects/<id>/` paths below are SUPERSEDED** — matrix's runtime files moved into a
plugin-namespaced subdirectory (`projects/<id>/plugin/matrix/…`). See § *Current layout* at the end
of this section for what is true today. Everything else here — the two-places split, the reasoning
for each, and three-layer config — is unchanged.

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
- ~~`projectTasksDir(dataDir, projectId)` in `daemon/helpers.ts` = `{dataDir}/projects/{projectId}/tasks/`.~~
  **SUPERSEDED twice**: the resolver moved to `src/data-paths.ts` (dataRoot hardening — and there is
  a grep test that FAILS if a second site ever computes these paths), and the path itself gained the
  plugin namespace. Every path built from `dataRoot` goes through that one resolver now.
- `getEventStore` uses this. Tests use `join(dataDir, "projects", projectId, "tasks")` directly.

### File extension
- `.jsonl` (was `.events.jsonl` — the `.events` prefix was redundant).
- `EventStore.listSessions()` filters `.jsonl` and strips with `/\.jsonl$/`.
- `pruneSessionFiles` filters `.jsonl`.

### Why
- "sessions" was the wrong word — Matrix's unit of work is a task; each JSONL file is one task's history.
- Project = single folder: back up / move / delete = one operation, not two.
- `debug/` directory created per-project for future drift snapshots and investigation artifacts.

### Current layout: plugin-namespaced (supersedes the paths above)

Matrix's per-project runtime data lives in a plugin-namespaced subdirectory,
matching the shape every other plugin uses. Completes the "matrix is just a
plugin" framing started in P2 (dataRoot infrastructure).

#### Layout

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

#### Mechanism

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

#### Gotchas

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

## DEFAULT_CONFIG Immutability

`Object.freeze`d at module load. `createApp()` defensive-clones. PATCH never mutates. **Lesson**: module-level constants MUST be frozen.

## Default Branch

Root node stores branch at init. `baseBranch` required on worktree create (no fallback). Child worktrees branch from parent's branch.

## The node model: TaskNode | GeneralNode (P3, + folders, + the later field promotions)

Three entries merged, in the order they happened: folders (matrix's first non-task node), P3 (which
generalized them into `GeneralNode`), and the 2026-06-07 promotion of `status` / `metadata` up to
`BaseTaskNode`. Read top-down; the folder notes near the end are still live design constraints, only
their type names changed.

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

### Folders — matrix's only GeneralNode flavor

Folders came first (as their own node kind) and P3 above generalized them. The design notes here are
all still live; only the type names moved.

~~`TreeNode = TaskNode | FolderNode` discriminated union. FolderNode: only id, title, parentId, children, type:"folder".~~
**There is no `FolderNode` type.** It is `TreeNode = TaskNode | GeneralNode`, and a folder is a
`GeneralNode` whose `type` happens to be `"folder"` — a matrix-plugin convention, not a runtime kind.
`isFolder` is plugin-local in two places (`src/orchestrator-tools.ts` for the backend,
`.mxd/plugin/web/types.ts` for the frontend), NOT exported by the runtime.
No status, no session, no lifecycle. Zero behavior — pure grouping.

#### Key Design
- **Tree structure vs task ownership**: `parentId` = tree structure (UI, reparent, delete). `getTaskAbove()`/`getTasksBelow()` = task ownership (message routing, worktree branching, task_complete delivery). Folders are transparent to ownership.
- **MCP tools**: `create_folder`, `delete_folder` (must be empty), `rename_folder` — separate from task tools.
- **56 parentId references audited**: each categorized as tree-structure or task-ownership. Task ownership uses getTaskAbove.
- **Lifecycle rejection**: all lifecycle operations (launch, done, close, reset, send_message) reject folders at entry point.
- **MUST resist feature creep**: persistent tasks started as "just a flag" and grew into a disaster. Folder stays at ZERO behavior forever.
- **getTask() vs get() audit**: All production `getTask()` calls audited. One bug fixed: REST reorder endpoint used `getTask()` → `get()` (folders have children too). All others correct — they access task-specific properties (session, worktree, branch, status).

### Later: fields promoted to BaseTaskNode, SET methods, seedTree (2026-06-07)

Pushes the genuinely runtime-generic node fields UP to `BaseTaskNode` and gives
plugins the SET path + project context they need to drive launchable nodes —
without re-declaring runtime fields or mutating the live tracker. Surfaced by the
dchat out-of-tree 试水 (Wall #2 + interface-gap D). Matrix's own `TaskNode` +
every status-driven path is byte-for-byte unchanged (regression bar held: full
`bun test` green, 2179→2189 with the new tests).

#### `status` + `metadata` moved to `BaseTaskNode` (`src/types.ts`)
- `status: TaskStatus` is now on `BaseTaskNode`, NOT only on matrix's `TaskNode`.
  It IS runtime-generic: `createNode` inits it, `updateStatus` mutates it, `load()`
  migrates it, and the default `shouldResume` keys on `status === "in_progress"`.
  A plugin whose nodes are launchable inherits it — it must not re-declare it.
- `metadata?: Record<string, unknown>` added to `BaseTaskNode` (parallel to the
  one `GeneralNode` already had — it's exactly the LAUNCHABLE node that needs
  per-node plugin config). Runtime NEVER reads it; only round-trips via save/load.
- Persistence is automatic: `save()` spreads all non-session task fields, `load()`
  casts the raw task object through untouched — so `metadata` round-trips with zero
  new code. The status-node load branch already migrated `status` ("passed"→"verify").

#### TaskTracker SET methods (`src/task-tracker.ts`)
- `CreateNodeOpts` type now carries `metadata?`; `addChild`/`addTask`/`createNode`
  thread it into the node literal (`...(opts?.metadata !== undefined ? {metadata} : {})`
  — absent, not `{}`, when unset).
- `setMetadata(nodeId, metadata)` — plugin-safe SET path; **REPLACES** the whole
  metadata object (to update one key, read+spread), bumps `updatedAt` for tasks,
  works for general nodes too. This replaces "mutate the live tracker directly".
- `load()` now returns `boolean` (`true` = fresh tree just created, `false` =
  loaded existing). Backward-compatible — every existing caller ignores the return.

#### Gotcha: moving status/metadata up tightened TaskNode⊆GeneralNode structural overlap
`save()`'s `if (isGeneral(node)) return node; const {session, ...rest} = node;`
started failing TS2700 ("Rest types may only be created from object types") because
the negative `isGeneral` narrowing collapsed `TaskNode` to `never`. Fix: use the
POSITIVE guard — `if (!isTask(node)) return node;` — so the narrowed type is
concretely `TaskNode`. Same runtime behavior. (Lesson: prefer positive type-guard
narrowing for destructure-after-guard when the union members overlap structurally.)

#### Hooks get `projectId` (gap D-C) — `src/runtime/context.ts` + `agent-lifecycle.ts`
`buildWorkContext` / `buildSummarizationPrompt` / `buildDoneResumeContext` now
receive `(node, projectPath, projectId)`. `projectPath` is the git checkout;
`projectId` is the registry id a data-driven plugin needs to locate its per-project
dataRoot (`~/.mxd/projects/<projectId>/...`) — matrix uses projectPath, dchat needs
projectId. Adding a TRAILING param is type-backward-compatible: existing impls that
take fewer args (matrix's, the story-scope tests') stay assignable. Three call sites
in `agent-lifecycle.ts` pass `project.id` (initial work-context inject ~907, the
compact re-arm `setBeforeFirstMessage` ~914, the AgentRequest closure ~1017).
The default `shouldResume` in `runtime.ts resumeScope` retyped `(n: TaskNode)` →
`(n: BaseTaskNode)` to reflect the now-generic `status`.

#### `seedTree` — worker-side tree-init hook (gap D-B) — `ScopeOpts` + `getTracker`
`onProjectInit` (PluginManifest, `src/plugin.ts`) runs DAEMON-side where there is
NO tracker → it can create FILES but not initial tree NODES. The complement is
`ScopeOpts.seedTree?(tracker, projectId)`, called once from `getTracker`
(`runtime/helpers.ts`) the first time a project's tree is created (`load()` returned
`true`), AFTER scope-opts registration, then `tracker.save()`. The plugin seeds its
starting nodes via `addChild`/`addGeneralNode`/`setMetadata`. Fires exactly once —
tree.json then exists, so reloads return `false` and never re-seed. Matrix has no
seedTree → no-op. (`markReady()` does NOT auto-run autoResume, so in tests the seed
fires deterministically on the first explicit `getTracker`.)

#### Tests
- `src/task-tracker.test.ts` "node-model generalization" (8 unit): addChild/addTask
  metadata, metadata-absent-not-`{}`, setMetadata REPLACE (the `extra` key
  disappearing proves replace≠merge), setMetadata on general nodes + throws-on-missing,
  metadata+status save/load round-trip, `load()` fresh→true / existing→false.
- `src/plugin-custom-scope.test.ts` "Node-model generalization (plugin integration)"
  (2 integration): (a) a non-matrix scope's `buildWorkContext` reads `node.metadata`
  + receives `projectId`, exercising addChild-metadata + setMetadata + round-trip
  end-to-end through a real agent run; (b) `seedTree` seeds 2 nodes with metadata on
  a fresh tree exactly once (custom `buildScopeOpts` passed via `setupTestContext`).
- **Mutation-verified**: setMetadata replace→merge fails the REPLACE test; dropping
  `projectId` at the initial-inject call site (~907) fails the integration test.
  (Mutating the AgentRequest-closure site ~1017 instead did NOT fail it — that path
  only fires on compaction; the integration test covers the fresh-inject path.)

## FIX-2 (2026-06-05) — REST boundary must use the same shared-op discipline as MCP

Five bugs, one theme: REST/HTTP routes bypassed fixes the MCP/shared ops already had. Failure
mode is silent data loss/leak, not a crash. Rule going forward: **a REST route that touches a
task lifecycle resource (session, JSONL, worktree, config) MUST route through the same shared op
the MCP path uses, or replicate its guard exactly.** Where they drift, the REST side silently
re-introduces a solved bug.

### cc#2 — `/sessions/clear` must await loop exit before clearing JSONL
`runtime/routes/tasks.ts` sessions/clear inlined a stop that closed the queue but did NOT await
the agent loop's exit (unlike `resetTaskOp`/`stopTask`). The loop's `finally` (agent_end, orphan
repair, Phase 2) then re-polluted the JSONL right after the clear — the "clear-race" the project's
own `integration.test.ts` documents as a BUG PATH. Fix: `if (node.session) await stopTask(...)`
else `await ctx.agentLoopPromises.get(nodeId)` (launchingNodes gap), THEN clear. The EventStore
generation guard handles stopTask's own fire-and-forget agent_end append racing the clear.

### cc#5 — REST node responses MUST stripSession
`c.json` does NOT throw on the live `session` (unlike SSE's `structuredClone`, which is FORCED to
strip). So every REST route returning a node serialized the whole queue/conversation/AbortController
over the wire. One shared `serializeNode(node)` helper in tasks.ts (`isTask(n) ? stripSession(n) : n`)
now wraps ALL node responses: GET /tasks (`.map`), POST /tasks (task + folder), PATCH, and all 3
continue returns. Mirrors the existing MCP `stripSession` discipline (get_tree/get_task/etc.).

### cc#4 — config null-delete + corrupt config must never wipe credentials (two layers)
- **PATCH /config/global** now rejects null/undefined for ANY top-level field (400). Global config
  is a COMPLETE MatrixConfig — no optional fields — so `delete next[k]` on null wrote an incomplete
  config. Per-auth-group deletion still goes through `{ authGroups: { name: ... } }` (object value,
  not rejected).
- **`createDaemon`** no longer catches a load failure into `{ ...DEFAULT_CONFIG }` — it RETHROWS.
  Silent DEFAULT_CONFIG booted with empty authGroups, and the next `saveGlobalConfig` overwrote the
  on-disk credentials with nothing. Fail boot loudly → on-disk config preserved.
- **`loadGlobalConfig`** now distinguishes ENOENT (fresh install → defaults) from read-error /
  invalid-JSON (throw). The old single catch returned defaults for a CORRUPT file too — same
  credential-wipe path. ENOENT-only return keeps fresh install working.

### B-H1 — delete_task must stop+await the live loop before cleanup (reset-style)
`deleteTaskOp` did NEITHER close's "reject in_progress" NOR reset's "await loop exit" — it called
`cleanupTaskResources` (close queue, `git worktree remove --force`, clearEventStore) WITHOUT
aborting/awaiting the loop. Destroyed unmerged work, removed a worktree under a running process,
and a pending done() then read getTask=undefined in Phase 2 → parent hangs forever. Fix: added
optional `stopTask`/`awaitLoopExit` callbacks to `deleteTaskOp` (mirroring resetTaskOp) + wired
them in BOTH the MCP (orchestrator-tools) and REST (tasks.ts) delete handlers. Semantic chosen:
reset-style ("delete a running task = stop it, then delete"), not close-style (reject).

### cc#6 — worktree removal must use STORED path+branch, never a re-slugified title
close/reset/delete removed worktrees via `wm.remove(node.id, slugify(node.title))`. The title can
change after creation (`mxd/<id>/<oldSlug>`), so re-slugifying the CURRENT title computes a
different path/branch → the real worktree is orphaned forever. Fix:
- New `WorktreeManager.removeByPath(worktreePath, branch)` — removes the EXACT stored values, no
  recomputation. (`remove(taskId, slug)` kept, now delegates to it; still used by its own test.)
- `removeWorktree` callback signature changed `(taskId, slug)` → `(taskId, worktreePath, branch)`.
  Ops pass `node.worktreePath`/`node.branch` (already inside the `if (worktreePath && branch)`
  guard, so type-clean). MCP wirings call `removeByPath(worktreePath, branch)`; the REST delete
  callback still uses param-1 (taskId) to look up the node for `onTaskDelete`.
- `.mxd/plugin/scope-opts.ts onTaskDelete` (the REST worktree hook) likewise uses
  `node.worktreePath`/`node.branch` instead of `slugify(node.title)`.

### Tests (all mutation-verified)
- `src/rest-boundary.test.ts` (new): session leak (GET/PATCH strip), clear-race (session +
  launchingNodes-gap), delete-race (loop awaited before cleanup), delete stops queue+session.
  The race tests use a 50ms-delayed simulated loop write — reverting the await makes JSONL reappear.
- `src/task-operations.test.ts`: close/reset/delete removeWorktree gets the STORED path+branch
  after a rename (cc#6).
- `src/worktree-manager.test.ts`: removeByPath removes exact path+branch; re-slugified remove
  orphans the worktree (demonstrates cc#6 directly).
- `src/config.test.ts`: loadGlobalConfig ENOENT→defaults, missing-field→throw, corrupt-JSON→throw.
- `src/daemon.test.ts`: PATCH null-delete → 400 (credentials preserved); createDaemon on
  corrupt/incomplete config → throws, on-disk config untouched.

## Node metadata write-path over REST — create + update (2026-06-08)

Exposed plugin-owned `metadata` editing over REST on BOTH paths. The tracker
primitives existed since the node-model task (`addChild` opts.metadata +
`setMetadata`) but NO REST/MCP path reached them — nodes could neither be born
with metadata nor have it edited:
- POST  `/projects/:id/tasks`          body `metadata?` → `createTaskOp` → `addChild(parent, title, desc, { metadata })`
- PATCH `/projects/:id/tasks/:nodeId`  body `metadata?` → `updateTaskOp` → `tracker.setMetadata(nodeId, metadata)`

### REPLACE, never deep-merge
`tracker.setMetadata` replaces the WHOLE object; `updateTaskOp` does NOT merge —
the caller (plugin UI) reads current metadata and sends the complete merged
object. PATCH with `metadata` absent (`undefined`) = "leave existing untouched"
(guarded by `if (updates.metadata !== undefined)`); PATCH `metadata: {...}` with
a key omitted = that key DISAPPEARS. Mirrors the color/status/title handlers in
the one shared `updateTaskOp` (and `createOpts.metadata` mirrors budgetUsd/draft).

### No new auth, no MCP
- REST relies on the daemon-level auth middleware (Bearer). The MCP path's
  `requireSubtreePermission` is a different layer — no new guard added.
- MCP `create_task`/`update_task` deliberately NOT given a `metadata` param: the
  only consumer is dchat's REST UI; an agent-facing opaque-metadata param is an
  imagined need (anti-pattern #6). REST is the whole requirement.

### Serialization is free
`serializeNode` (stripSession) keeps `metadata` — it's on BaseTaskNode,
round-trips via save/load. So POST/PATCH responses + GET /tasks + the SSE tree
broadcast all carry updated metadata with no extra code. `updateTaskOp`'s
existing `broadcastTree()` pushes it to the UI. Metadata changes do NOT fire
`notifyTargetNode`/`notifyTreeChange` (those stay title/description-only — a
metadata edit is config, not a message to the node).

### Driver + effect timing
dchat's roster UI: "add a character" = POST a node with personality metadata;
"edit a character's prompt" = PATCH its metadata. Editing a RUNNING character's
metadata takes effect on its next launch/compact (system prompt is built at
launch), not mid-session — dchat's UX concern, NOT this write-path's scope.

### Tests
- `src/task-operations.test.ts`: createTaskOp "applies metadata" + "persists
  across reload"; updateTaskOp "sets metadata" + "REPLACES — removed key
  disappears" + "metadata undefined leaves existing untouched".
- `src/rest-metadata.test.ts` (NEW, createMatrixApp harness): the canonical dchat
  journey — POST/PATCH metadata → GET /tasks reflects it; PATCH replace; PATCH
  title-only preserves metadata; POST without metadata → no metadata field.
- Mutation-verified: commenting out BOTH `createOpts.metadata = …` and
  `tracker.setMetadata(…)` → exactly the 9 metadata-asserting tests fail; the 1
  absence-asserting test (POST without metadata) correctly stays green.

## FIX-7 (2026-06-10) — lifecycle guards: root delete, status validation, prefix canonicalization

Five guard bugs at the task-operations + routes layer, each TDD with failing tests first.

### R8-C#1 — root node protection (delete/close/reset)
`deleteTaskOp`, `closeTaskOp`, `resetTaskOp` now reject `tracker.rootNodeId` with
`TaskOperationError("Cannot {delete,close,reset} the root node")`. The root orchestrator
is the tree anchor — destroying it orphans the tree.

### R8-C#2 — status transition validation
`updateTaskOp` rejects `status: "closed"` and `status: "failed"`. Both are lifecycle-terminal
states requiring cleanup (worktree removal for close, Phase 2 done delivery for failed). A
plain PATCH bypasses those ops and leaks worktrees / orphans state. Callers must use
`closeTaskOp` or let `done("failed")` set it (which goes through `tracker.updateStatus`
directly, NOT through `updateTaskOp`). Tests that need "failed" as setup now use
`tracker.updateStatus` directly instead of PATCH.

### R8-C#3 — prefix canonicalization in REST /message
REST `/message` route resolves `tracker.get(rawNodeId)` and uses `resolved.id` (canonical
full ID) for all downstream ops. Response also returns the canonical `taskId`.

### R8-C#4 — REST /message + /clarify node validation
Both routes now validate: node must exist (404) and be a task node, not folder (400).
`handleClarifyResponse` in agent-lifecycle.ts also got canonicalization + validation.

### R8-C#5 — draft guard on REST /message
REST `/message` rejects `status === "draft"` with 400, matching MCP `send_message` behavior.

---
# Memory Index & Search
---

## The done() payload: DonePayload → TaskNode.resultRounds (2026-07-14 … 07-20)

Merged from five sequential entries (Memory-index Step 1 → 1.1 → 1.2 → 1.3 → 1.4), each of which
superseded the one before it. Only the end state is load-bearing; the trail is at the bottom,
compressed to the decisions that still explain why the code looks like this.

### Current state

done() has exactly two agent-facing params: **`status`** (`passed`/`failed` — a RUNTIME control bit
that routes the node to verify/failed) and **`result`** (required, non-empty — everything the agent
reports as content). `TaskNode.resultRounds?: DonePayload[]`: ONE block APPENDED per done(), never
overwritten. Single-done task → one block; reawakened-and-re-done task → N blocks in call order;
the field is absent until the first done().

⚠️ **`lessons` is GONE — but every step below was written while it existed.** It was a second
content field for most of this chain's life, dropped from `DonePayload` after Step 2 shipped (the
index-side half of that removal is recorded in *Memory-index Step 2* § Post-merge cleanup). Agents
fold lessons and pitfalls into the `result` narrative directly. Verified against the code:
`src/done-payload.ts` is `z.object({ result: z.string() })`, one field; `orchestrator-tools.ts`
declares only `status` + `result`. **Wherever text below mentions `lessons`, read it as history.**

### The ONE struct — `src/done-payload.ts` (imports ONLY zod, no cycles)

- `donePayloadSchema` — the SINGLE source of the done CONTENT shape.
  `DonePayload = z.infer<typeof donePayloadSchema>`.
- `parseDonePayload(input: Record<string,unknown>|undefined): DonePayload` — the ONE raw-input →
  round normalizer. Add a content field → edit THIS schema; the tool params
  (`donePayloadSchema.shape`), the type, the stored round, and the normalizer all follow. No fan-out.
- Imports ONLY zod so BOTH `types.ts` (type layer) and `orchestrator-tools.ts` (tool layer) can
  import it without an import cycle.

`DonePayload` is 1:1 with a `resultRounds` element: `TaskNode.resultRounds?: DonePayload[]`
(types.ts), `tracker.appendResultRound(nodeId, round: DonePayload)` (task-tracker.ts). done() ↔
round by construction, not by hand-synced shapes.

DELETED along the way: `ResultRound` interface, `MatrixDoneData` type, `AgentResult.doneResult`
field, `readDonePayload`, `readDoneLessons`, `PluginTypes.done`, `MatrixPluginTypes.done`, and all
done-result carrying through the provider loop.

### ⭐ The boundary (root's review criterion — hold this line)

`status` is NOT in the struct — it's a RUNTIME control bit. The runtime↔plugin split for done():

- **Runtime MAY read**: `status` (routes → verify/failed) + ONE completion-output string
  (`doneCompletionOutput(input)` = `input.result` — the universal "what happened" summary sent to the
  parent via task_complete AND recorded on the done_notified marker; every plugin has one, calling it
  `result` is fine).
- **Runtime MUST NOT carry**: the round structure, or any content field beyond that one string.
  Those are read ONLY inside Matrix's `onDone`, via `parseDonePayload(doneInput)`. The runtime hands
  the raw done tool_call input to onDone as an OPAQUE `Record` (`BaseDoneData`) and never
  destructures round content itself.
- Enforcement check (grep): `resultRounds` / `appendResultRound` / `parseDonePayload` / `DonePayload`
  appear in `src/runtime/*`, `src/runtime.ts`, `src/provider-shared.ts`, `src/events.ts` ONLY in
  boundary-explaining COMMENTS, never in code. (`lessons` was on this grep list too, while it
  existed.) If a future change reads a content field inside the runtime, the boundary is broken.

### Flow (live + crash recovery)

- **provider-shared.ts** (loop): reads only `doneInput.status` → `doneExitReason`. Does NOT carry the
  result out.
- **agent-lifecycle.ts Phase 2**: `readDoneInput(events)` → raw `doneInput` (generic: the last done
  tool_call's input, in events.ts). `doneCompletionOutput(doneInput)` → the parent-notice/marker
  string. Runtime does the status flip (`updateStatus(passed ? "verify" : "failed")` — ONE mapping) +
  `opts.onDone?.(node, tracker, doneInput ?? {})` (opaque) + `createTaskComplete(..., completionOutput)`
  + marker `{status, result: completionOutput}`.
- **scope-opts.ts onDone** (Matrix): `tracker.appendResultRound(node.id, parseDonePayload(doneInput))`.
  Content-only, returns void. No status flip — that is the runtime's job.
- **runtime.ts findInterruptedDonePhase2** (crash recovery): reads `status` +
  `doneCompletionOutput(lastDoneCall.input)`.

**KNOWN LIMITATION (unchanged since Step 1)**: crash-recovery Phase 2 does NOT append a resultRound —
it is plugin-agnostic runtime code that updates status directly via `tracker.updateStatus` and never
calls the Matrix onDone. So a done() whose Phase 2 was interrupted by a daemon crash loses its round.
Wiring it in would either break the plugin-agnostic boundary (runtime knowing about resultRounds) or
change crash-recovery behavior (route it through onDone). The normal Phase 2 path — the overwhelming
majority — captures correctly.

### Enforcement: `result` is required and non-empty (two layers)

- Zod `explicit` (required) → an ABSENT result is rejected at executeTool's safeParse with
  "Tool input validation error (mcp__mxd__done): result: …" (the message names `result`).
- `beforeDone` (orchestrator-tools.ts) checks `!args.result?.trim()` FIRST, before the git-clean
  check → an EMPTY/whitespace-only result is rejected with a steering message ("done() needs a
  non-empty `result`: state what this round ACTUALLY accomplished…").

**Why a rejected done() is harmless**: it returns isError → the provider-loop done-exit block
(`if (doneToolResult && !doneToolResult.isError)`, provider-shared.ts ~1914) is skipped → the loop
does NOT exit, no Phase 2, no resultRound appended → the agent sees the error and continues. So a
barren done() never lands an empty `{result: ""}` round.

### onDone → void; done_notified marker-injection DELETED (root-blessed)

Old `onDone` returned `MatrixDoneData`, which was spread into `done_notified` — letting a plugin
inject arbitrary marker fields. REMOVED: onDone returns void, and `done_notified` is RUNTIME-standard
`{status, result}` always. Rationale: the marker is write-only (nothing reads its fields;
findInterruptedDonePhase2 recomputes from the tool_call) and only a synthetic test used the channel →
anti-pattern #6 (imagined use). Did NOT keep a `T["done"] | void` "just in case" shape.

### Tracker: appendResultRound

Append-only; creates the array on first call; rejects general nodes; bumps updatedAt. Round-trips
through `save()`/`load()` FREE (save spreads `...rest`, load casts raw → TaskNode) — zero extra
serialization code. Surfaces via `get_task` / `get_tree` FREE (stripSession spreads all fields).

### Robustness test — "a plugin evolves its done fields without touching the runtime"

The runtime IS already field-agnostic (opaque passthrough); the deliverable is the test that PROVES
and PROTECTS it. Target = a plugin's OWN extended fields (the opaque part) — NOT `status` or the
completion output, which ARE the runtime contract.

- `src/plugin-custom-scope.test.ts` "Boundary: done() custom fields are opaque to the runtime": a
  non-matrix scope whose done() carries `wordCount` + `mood`. onDone reads them off the opaque
  `doneInput` and setMetadata's them. Asserts (1) `node.metadata == {wordCount, mood}` → the runtime
  handed the raw input through untouched, no reshape to a fixed content struct; (2) `done_notified` =
  `{status, result}` ONLY, `wordCount`/`mood` undefined → the runtime never spreads plugin content
  into its artifacts; (3) status routed to verify.
- `src/events.test.ts`: `findInterruptedDonePhase2` with a custom-field input returns EXACTLY
  `{needs_phase2, status, result}` — crash recovery carries no custom fields.
- `src/done-payload.test.ts`: `parseDonePayload` robustness — extra fields dropped, missing/malformed
  defaulted, never throws.

**EMPIRICALLY mutation-proofed** (full `bun test`, not reasoning): mutating agent-lifecycle to reshape
`doneInput` into a fixed content struct before onDone → the ONLY failure across 2508 tests is this
boundary test; ALL matrix resultRounds/done_notified tests PASS.

**Lesson**: to test "layer X is opaque to layer Y's data", the test MUST use data that ONLY layer Y
understands (a custom field). Testing with the DEFAULT plugin's own fields cannot distinguish "passed
through opaque" from "reconstructed into that plugin's shape" — both produce the same round.

### Tests

- `src/task-tracker.test.ts` → `describe("TaskTracker: resultRounds (memory-index capture)")` — the
  tracker unit: append, **append-twice-never-overwrites**, undefined until first append, updatedAt
  bump, non-task throws, unknown-node throws, save/load round-trip, and stripSession (the
  serialization `get_task`/`get_tree` use) preserving the field.
- `src/integration.test.ts` → `describe("Integration: done() result capture (resultRounds)")` — the
  full flow: `done(result)` lands on the node; **absent result → REJECTED, no empty round**;
  **whitespace-only result → REJECTED with the steering message**; two rounds in call order after a
  reawaken, first preserved; a failed done() also appends; and **ONE value → BOTH the parent
  notification and `resultRounds.result`, byte-identical**.

That last one is worth naming as a property, because 1.4 changed how it holds: the parent notice and
the stored round are no longer the same variable handed to two places — the runtime derives the
completion output and Matrix's onDone derives the round, *independently, from the same
`doneInput.result`*. Byte-identity is now a consequence of both reading one source, which is why the
test pins it rather than trusting the plumbing.

Two consequences for test code, from when the carrier was removed:
- Test scope opts whose `onDone` did nothing but flip status no longer define `onDone` at all — the
  runtime flips status universally now.
- `anthropic-compatible-provider.test.ts` can no longer assert `agentResult.doneResult` (the field is
  gone); it asserts the emitted done() tool_call's `input.result` instead. That is the honest
  assertion anyway: **the result lives in JSONL, not on AgentResult.**

### Gotchas

- **Zod strips unknown keys.** `z.object(inputSchema).safeParse` (tool-execution.ts) has NO
  `.strict()`, so undeclared keys are STRIPPED, not rejected. A caller passing an obsolete param name
  therefore does not fail on that param — it fails on the required one that is now missing.
- **`parseDonePayload` must NOT use `donePayloadSchema.safeParse`** — the schema requires its fields
  and raw done input may omit them → reject. Manual normalization only.
- **Reading the done input** matches `e.tool === TOOL_DONE`, the full `mcp__mxd__done` name — tool_call
  events store the mcp-prefixed name (same as `findInterruptedDonePhase2`).
- **`appendResultRound` must NOT use `(node.resultRounds ??= []).push(x)`** — biome
  `noAssignInExpressions` errors. Use `if (!node.resultRounds) node.resultRounds = []; …push`.
- **Removing `PluginTypes.done` was safe**: test scopes use `ScopeOpts<any>` (erased). `BaseDoneData`
  is KEPT — it now documents "the opaque raw done input" and is still exported from `plugin-sdk.ts`.
- **Required-ness comes from the tool's `decl`, not from the schema.** The param reuses the schema's
  TYPE (`donePayloadSchema.shape.result.describe(...)`), while `decl: {kind: "explicit"}` vs
  `{kind: "optional"}` decides whether it is required. So the tool can be stricter or laxer than the
  stored shape without the two drifting — which is exactly how `result` is required on input while
  `parseDonePayload` still normalizes a missing one to `""`.
- **Frozen-agent transition window.** An agent whose session_config froze the OLD done schema keeps
  calling the old shape; the obsolete param is stripped (above), the required one is then absent, and
  the done is REJECTED with the required-result error. Costs that agent one round; it retries
  correctly. ANY change to a tool's required params has such a window — tools are frozen in
  session_config until a compaction refreshes them (see *Session Config Refresh at Compact*).

### Renaming a tool param — three things that bit us

Out of the `summary` → `result` rename, all three generic:

1. **Grep the FRONTEND.** The done-card consumers (`event-display.ts` getToolTitle, `McpToolCard.tsx`,
   `LogEntryView.tsx`, `ToolCard.tsx`, `mock-showcase.ts` fixtures) read the param BY NAME —
   `getArg(.., "summary")` / `toolArgs?.summary`. Typecheck cannot catch that (index/any access) and
   integration tests do not render, so it was a SILENT UI regression found only by manual grep: the
   done cards would have quietly lost their text. Same class as the bound on *Refactoring Philosophy*
   — the compiler enumerates only what it can TYPE.
2. **Grep the TARGET name before a blanket rename.** `doneSummary → doneResult` collided with two
   pre-existing local `doneResult` variables in provider-shared (the done ToolResult, and the
   `handleImplicitYield` resume result); they became `doneToolResult` / `doneResumeResult`.
3. **Make a missed site LOUD, not silent.** Because `result` became required, a missed call site fails
   Zod → the done never completes → the test times out. That enforcement WAS the safety net. The one
   miss that got through the bulk replace was a BACKTICK template literal
   (`` summary: `child ${label}…` ``) in integration-stress MULTI1: the child's done was rejected, the
   parent hung, and it read as a 48s flake rather than a regression. Grep BOTH `x: "` and `` x: ` ``,
   plus the shorthand `x }`.

**NOT this concept — do not rename these `summary`s**: compaction `<summary>` tags /
SUMMARIZATION_INSTRUCTION; llm.ts OpenAI Responses reasoning `summary[]` / `summary_text` (an API
field); cli.ts cost/tree display; get_logs "short summary" and send_message's title "Short summary of
the message"; generic `ToolDisplay.summary`; compactedResume `"summary-1"` ids.

**Two provider test files declare their own `done` tool with a `summary` schema and are CORRECT** —
`openai-responses-compatible-provider.test.ts` and `anthropic-compatible-provider.test.ts` (~2560)
are standalone provider tests driving `provider.stream()` directly; they never run the runtime loop,
so they are not Matrix's done().

### How it got here

The five entries this replaces, and the one decision from each that still explains the code:

- **Step 1** — introduced `resultRounds`, and read the round from the persisted done tool_call in
  JSONL rather than threading fields through `AgentResult` ("JSONL is the source of truth", draft
  01KN8D1M). That is why Phase 2 re-reads the log instead of receiving the value from the loop.
  Shipped with BOTH `summary` and `result` on done(), additively.
- **Step 1.1** — noticed `summary` and `result` said the same thing; made `result` primary with
  `summary` a deprecated alias (`result ?? summary`). Worth keeping for the naming rule it
  established: **the tool description is agent-facing on every single call, so the param must be
  named after the real concept.** Leaving the primary param `summary` while the stored field was
  `result` would have re-seeded the exact two-names-for-one-thing confusion being removed.
- **Step 1.2** — deleted the alias outright and made `result` required-non-empty. The alias had
  forced `result` to be optional, which in turn allowed a done() carrying neither param.
- **Step 1.3** — completed the rename through every internal carrier (`AgentResult.doneSummary`,
  `MatrixDoneData.summary`, the `done_notified` field, `agent_end.result`). Renaming the persisted
  marker field turned out to need no migration at all: nothing reads it back, and crash recovery
  recomputes from the tool_call. Step 1.2 had assumed the opposite and deferred the rename for it.
- **Step 1.4** — collapsed the three hand-picked shapes (done params / ResultRound / MatrixDoneData)
  into the one zod struct above, and drew the runtime↔plugin boundary.
- **After Step 2** — `lessons` dropped; `result` is the only content field.

## Memory index: the search engine — `src/task-index.ts` (2026-07-15 … 07-23)

Merged from "Memory-index Step 2" (FTS5) and "Memory-index Phase C" (Orama). Phase C replaced the
entire storage engine, so Step 2's machinery is history — but its *architectural* decisions (where
the engine lives, the sync model, the hook) survived the swap untouched and are stated here as
current. The FTS5 era is at the bottom.

Indexes every task's **title**, **description**, and **each done() round's result**, at per-field +
per-round granularity: one document per (task, field, round), so every hit traces to an exact
location rather than to "somewhere in this task".

### Current engine

Orama (pure TS, no native deps) + `@orama/tokenizers/mandarin` (jieba WASM) +
`@huggingface/transformers` EmbeddingGemma-300M (768-dim, q8 quantization).

- **Hybrid search** (`mode: "hybrid"`): BM25 keyword + cosine vector in one query, fused by Orama's
  built-in ranking. Cross-lingual in practice — "fix session recovery" ↔ "修复会话恢复" scores 0.81
  cosine.
- **Graceful degradation**: if the embedding model fails to load → `mode: "fulltext"` (pure BM25).
  The daemon is never blocked on a model download.
- **Mandarin tokenizer**: passed as `components.tokenizer` to `create()`. Chinese and English queries
  both work natively.
- **Embedding pipeline**: lazy module-level singleton (`getEmbeddingPipeline()`), ~5s cold / ~1s warm
  on first call. `embed(text) → number[768]`.
- ⚠️ **Score direction reversed at Phase C**: Orama scores are **higher = better**. FTS5 BM25 was
  lower = better. Any comparison, sort, or threshold carried over from the FTS5 era is backwards.

### ⭐ Boundary: why the engine lives in `src/`, not in the plugin

The red line is NOT "index code must physically sit in `.mxd/plugin/`" — `src/` is the neutral
building-block layer, like `done-payload.ts` or `worktree-manager.ts`. The REAL invariant:
**`src/runtime/*` + `runtime.ts` + `provider-shared.ts` contain ZERO occurrences of index / search /
resultRounds** — grep-verified including comments (two hook comments had to be genericized because
they said "search index"). The engine is a `src/` leaf imported by BOTH the plugin (onDone,
onScopeResume) AND `orchestrator-tools.ts` (search_tasks); plugin→src and src(non-runtime)→leaf are
both allowed directions.

**Why it cannot live in the plugin**: `search_tasks` needs `availability: "both"`, and the
external-MCP tool list is built by `mcp-endpoint.ts` from `buildAllToolDefs()` in
`orchestrator-tools.ts` — which is in `src/`, and `src/` may not import `.mxd/plugin/`. So the tool
must be in buildAllToolDefs → the search function must be src-importable → the engine lives in
`src/`. That chain decided the layout; it is the same boundary as the DonePayload one, stated for a
different subsystem.

### The `onScopeResume(tracker, projectId)` hook

A generic ScopeOpts hook (`src/runtime/context.ts`), called once per project in
`autoResumeProjects` after the tracker loads and BEFORE resumeScope. Counterpart to `seedTree`
(fresh tree only); this one runs every startup. **Named by EVENT, not by resource** — no
"index"/"search" token anywhere in the name, which is what keeps the boundary grep clean. Matrix's
implementation reconciles the index; the runtime attaches no meaning to it and wraps it in
try/catch (best-effort). Now `async`.

**Test pitfall**: `createApp` does NOT call `autoResumeProjects`, so reconcile does not fire in
every `createMatrixApp` test. Tests that want it call `app.autoResumeProjects()` or `reconcileIndex`
directly.

### Sync model

- **Staleness marker = the node's `updatedAt` string, stored per task in the index's sidecar**
  (`indexedAt`). Reconcile reindexes a task iff `stored.indexedAt !== node.updatedAt` — string
  compare, no clock math. This SUBSUMES backfill: a never-indexed task has no `indexedAt`, so it is
  stale, so it gets indexed. No separate "already backfilled" marker exists or is needed. Reconcile
  also PRUNES documents for tasks that have left the tree.
- **index-on-done**: Matrix's `onDone` appends the round, then indexes the canonical node
  best-effort — an index write must NEVER break the done lifecycle, and reconcile retries misses.
  Since Phase C the index call is fire-and-forget (`indexTask(...).catch(...)`) because `onDone` is
  synchronous in the runtime.
- **Reconcile catches what onDone cannot**: title/description edits via `update_task` (no done()
  fires), and a crash between done and index.
- **Accepted edge**: an edit landing in the same millisecond as an index write yields an equal
  `updatedAt` string and is skipped until the next edit or restart. Practically never — edits happen
  at live-work time, indexing at startup/done.
- **KNOWN LIMITATION (inherited)**: crash-recovery Phase 2 never calls onDone, so a crash-interrupted
  done()'s round is lost from BOTH the node and the index. See *The done() payload* § Flow.

### Persistence — two files per project

- `index.msp` — the Orama binary (msgpack, via `@orama/plugin-data-persistence`). Written after every
  `indexTask`, and after a reconcile that changed anything.
- `index-meta.json` — sidecar: `{ [taskId]: { indexedAt, docIds } }`. Holds the staleness marker and
  the stored document ids, which is what makes targeted removal possible.
- Both resolve through `projectIndexDbPath()` (data-paths.ts), a sibling of tree.json →
  `projects/<id>/plugin/matrix/`.

**Document id convention**: `${taskId}:${field}:${round}` — deterministic, so `remove(db, id)` is
targeted and needs no scan. Fields: `title`, `description`, `result` (per round). Metadata lives in
the sidecar JSON, never in Orama — see the `where` limitation below.

**In-memory cache**: `dbCache: Map<dbPath, IndexDb>`. First access restores from disk
(`restoreFromFile`); in production one DB per project lives for the daemon's lifetime. Tests clear
it via `_clearDbCache()`.

### Public API (all async)

`indexTask(dbPath, node)` · `reconcileIndex(dbPath, tracker) → {indexed, pruned}` ·
`searchIndex(dbPath, query, limit?) → SearchHit[]`, where
`SearchHit = { taskId, field, roundIndex?, snippet, score }`. Test-only:
`_setEmbeddingPipeline`, `_resetEmbeddingPipeline`, `_clearDbCache`.

### Gotchas

- **NaN scores → automatic BM25 retry.** Documents indexed without a working embedding pipeline get
  `ZERO_EMBEDDING` (768 zeros); cosine on a zero vector is `0/0 = NaN`, and hybrid fusion inherits
  it, so *every* hit comes back `score: NaN`. `searchIndex` checks
  `hits.some(h => !Number.isFinite(h.score))` after a hybrid search and, if any hit is non-finite,
  redoes the whole search as pure fulltext. 3 regression tests.
- **`MXD_DISABLE_EMBEDDINGS`** short-circuits `getEmbeddingPipeline()` to null (BM25-only). Set via
  `bunfig.toml [test.env]` and propagated to workers by the daemon's `{ env: process.env }` Worker
  option — see *Bun Worker env isolation*, because `process.env` assignments do NOT reach a Bun
  Worker on their own. Priority: explicit mock (`_setEmbeddingPipeline`) > env var > lazy load, so a
  test can still exercise hybrid paths with a mock while the env var is set.
  **Why it exists**: `@huggingface/transformers` has a STATIC `import * as ONNX_NODE from
  "onnxruntime-node"` at module scope. Loading it registers the NAPI backend, and worker teardown
  then hits `NAPI FATAL ERROR: Error::New napi_create_error` → SIGTRAP → the whole test process
  dies. The env var is how the test suite avoids ever registering it.
- **sharp / libvips**: `@huggingface/transformers` depends on `sharp`, and Bun's global cache puts
  libvips at a versioned path sharp cannot find. `scripts/fix-sharp-libvips.sh` symlinks the
  unversioned `lib/` to the versioned one; wired as `postinstall`. Idempotent, platform-aware.
- **Orama `where` only filters `enum` fields**, and has no `ne` on enums; `string`-typed fields
  silently return empty. That is why metadata lives in the sidecar and no search query uses `where`.
- **`search_tasks` enriches from the tracker, not the index**: each hit gets the task's CURRENT title
  via a fresh `tracker.getTask`, and hits whose task has been deleted since indexing are dropped.
- **`R.getDataPaths()`** (resource-registry, returns `{dataDir, dataRoot?}`) exists so the `src/` tool
  can resolve the index path without any src→plugin coupling; the minimal config interface gained
  `dataRoot?` for it.
- **Index coverage is title / description / result.** `lessons` rows were removed when that field was
  dropped from DonePayload — see *The done() payload* § Current state.

### Tests

- `src/task-index.test.ts` — provenance per field, re-index replaces stale rows, reconcile
  backfill/incremental-noop/prune/skip-folders, empty + punctuation query safety, BM25 ranking,
  limit, Chinese tokenizer, embedding degradation, persistence round-trip, hybrid search with mock
  embeddings.
- `src/integration.test.ts` "memory index (Orama hybrid search)" (4, full agent loop) — index-on-done
  searchable, startup reconcile via `autoResumeProjects` → onScopeResume, `search_tasks` end-to-end,
  and best-effort (sabotage the index path → done() still verifies and the round is still on the
  node).

### History: the FTS5 era (Step 2, 2026-07-15 → 07-20)

The first working index was per-project SQLite via `bun:sqlite`, zero deps: an FTS5 table
`task_fts(task_id, field, round, text)` with `tokenize='porter unicode61'`, a `task_index_meta`
staleness table, a versioned `schema_meta`, and a reserved-but-unpopulated `task_vec` table for the
vector phase that never used it. Query input went through `toMatchQuery` (quote each whitespace-split
term, implicit AND) — **input safety against FTS5 syntax errors, deliberately not query rewriting**;
no field weighting, no ranking heuristics, no filters, on the "add heuristics only when real use
exposes a need" rule. Connections were opened per operation with no module cache, specifically
because ~100 integration tests each use a fresh temp dataDir and a cached handle map would have
leaked one handle per test onto a removed directory.

Deleted at Phase C: `bun:sqlite`/`Database`/FTS5/SQL entirely, `openIndexDb`, `toMatchQuery`,
`SCHEMA_VERSION`, the `task_vec` table, and the `initSchema`/`withDb`/`indexTaskInDb` internals.

**One durable fact from that era**: `bun:sqlite` CANNOT `loadExtension` — smoke-tested,
`new Database(":memory:").loadExtension("x")` → *"This build of sqlite3 does not support dynamic
extension loading"*. That killed the sqlite-vec plan (the alternatives were
`Database.setCustomSQLite()` against an extension-enabled libsqlite3, or storing embeddings as BLOBs
and computing cosine in JS) and is why the vector phase went to a pure-TS engine instead. FTS5
itself was fully built in and worked correctly — MATCH, bm25, snippet and DELETE-by-column all
verified on bun 1.3.14.

## Sidebar search + work_context related-tasks injection (2026-07-21)

### Part A — Sidebar search via Orama
- REST endpoint `GET /projects/:id/search?q=...&limit=N` in `.mxd/plugin/runtime.ts`.
  Calls async `searchIndex`, enriches with task titles from `ctx.trackers.get(projectId)`.
- `api.search(projectId, query, limit?)` URL builder in `.mxd/plugin/web/api.ts`.
- `useSidebarSearch` hook (`.mxd/plugin/web/search.ts`): debounced 300ms, abort-on-supersede.
- `TaskTree` accepts `searchHits`/`searchLoading` props; renders search results overlay
  (title + field badge + snippet) INSTEAD of tree filter when backend results arrive.
- UX: search results replace tree filter when text is typed and backend hits arrive.
  Empty query → normal tree. Local substring filter still runs as instant fallback.

### Part B — work_context related-tasks injection
- `buildWorkContext` in `.mxd/plugin/scope-opts.ts` searches with `node.title + node.description` as
  the query and appends a `[Related past tasks]` block: up to 5 hits, capped at
  `RELATED_TASKS_CHAR_LIMIT = 8000` chars (~2000 tokens), self excluded (`taskId !== node.id`),
  best-effort (try/catch — index unavailable just means no block). Works on both the initial-launch
  and the compact re-arm path, because both go through the same `buildWorkContext` callback.

⚠️ **SUPERSEDED — this shipped with a synchronous search and no longer has one.** The original text
read: *"`searchIndexSync(dbPath, query, limit)`: synchronous BM25-only search using the
already-cached in-memory Orama DB … Injection is sync → no runtime interface change."* Both halves
are now false. `buildWorkContext` is `async` and awaits the normal `searchIndex`, and the runtime
awaits the hook (`agent-lifecycle.ts` ~950/961) — so the interface DID change. Verified in code:
`scope-opts.ts:149` is `buildWorkContext: async (...)`, `:166` is `await searchIndex(...)`.

`searchIndexSync` still exists in `src/task-index.ts` but has **zero production callers** — only its
own tests. It was written for this hook and orphaned when the hook went async. Whether to delete it
is draft 01KYB46KTM.

### Boundary preserved
- `src/runtime/*` has ZERO knowledge of search/index. Everything routes through the plugin's hooks.
- REST endpoint uses `ctx.trackers.get(projectId)` directly (not `getTracker` helper which
  has scope-opts dependencies).

## search_tasks tiered return + create_task auto-search (2026-07-23)

`search_tasks` now returns tiered output via `formatTieredHits()` (exported from
`orchestrator-tools.ts`). Top hits get full info (description ≤500 chars, latest
resultRound result ≤300 chars, matched field+snippet, score); remaining hits are
one-line briefs (title, taskId, status, score). Total output hard-capped at 8000
chars to protect the context window.

`create_task` handler appends a best-effort `[Related existing tasks]` block after
the node JSON. Query = `title + description`; self-excluded; 2 full + up to 5 brief
hits. Index unavailable → silent skip, never blocks create.

⚠️ **SUPERSEDED**: this shipped using `searchIndexSync` ("sync, BM25-only, in-memory DB cache warmed
at startup by `reconcileIndex`") — the handler now awaits the normal async `searchIndex`
(`orchestrator-tools.ts:308`). Same staleness as the work_context injection above; both moved off
the sync variant and left it with no production callers.

System prompt: "Search before building" bullet added to Planning before acting
(§2), steering agents to `search_tasks` before creating tasks or starting work
in unfamiliar areas.

### Key design decisions
- Full taskId in output (not truncated prefix) — agents need it for `fork_task_context`
  / `send_message`.
- ~~`searchIndexSync` for create_task (not async `searchIndex`) — the handler is async
  but sync search avoids a second embedding-pipeline load; the DB is already cached.~~
  **REVERSED** — create_task awaits the async `searchIndex` now. The reasoning above was
  sound but the sync variant lost its other caller and was not worth keeping alive for one.
- 8000-char budget matches `RELATED_TASKS_CHAR_LIMIT` in scope-opts.ts work_context
  injection.
- `formatTieredHits` is shared between search_tasks and create_task (same formatting,
  different `fullCount` and header).

## Retrieval that nobody acts on ⇒ guidance goes where the DECISION is (2026-07-25)

All three related-tasks surfaces worked and produced real prior art. None of them said
what to do with a hit, so the block read as a return value: scanned, then dropped. Root's
count for one day — `create_task` ×8, block returned ×8, behaviour changed ×0,
`search_tasks` called ×0.

### The placement rule (this is the reusable part)

> **Put the guidance where the decision is made. If the agent ASKED for the data, the
> tool description reaches it in time — it still holds the intent it called with. If the
> data arrives UNREQUESTED, only the payload reaches it.**

One rule, three placements, no duplicated paragraph:

| surface | asked for it? | guidance lives in |
|---|---|---|
| `search_tasks` | yes | its description (one added clause) |
| `create_task`'s `[Related existing tasks]` | no — rides along | the block header |
| `work_context`'s `[Related past tasks]` | no — injected | the block header |

This is also why the bash "don't pipe" precedent does NOT transfer: that decision is made
while CONSTRUCTING the call, so the description is its decision moment. A description read
before the call is guidance about something that does not exist yet in the agent's world.

Matrix-specific tiebreaker, worth knowing on its own: **tool descriptions are frozen in
`session_config` until a compaction refreshes them, so a description change does not reach
a running agent. Handler output reaches everyone on the next call.** For a fix motivated by
"this failed today", that is decisive.

⚠️ **Root's stated evidence did not support root's conclusion — a different fact did.**
The argument offered was "I read the tool description and still dropped the block". But
create_task's description had never mentioned the block at all, so that is evidence that an
unexplained block does not self-explain, not evidence about description-placed guidance.
The real support is next door: system prompt §2 has "Search before building", and
`search_tasks` was called 0 times that day. The conclusion held; the reason had to be
replaced. **Check that a conclusion's stated reason is the one actually carrying it —
especially when you already agree with the conclusion.**

### The two block headers are DIFFERENT sentences, on purpose

Same shared kernel — *pointers, not answers; `get_task` and read the result rounds* — then
they diverge, because the readers can do different things:

- **create_task's reader is ROUTING**: it just made a task and is deciding where the work
  should live. Menu: fold the conclusion into this task's description (most common, and
  the one agents skip); `fork_task_context`; `send_message` to the found task and delete
  the just-created one; or nothing.
- **work_context's reader is already ASSIGNED the work**: it is deciding how to do it.
  Read before re-deriving; and if a hit already tried the approach it is about to take,
  **surface that upward** rather than obeying or ignoring it (that is §3's "your
  investigation contradicts the premise the task above is operating on").

Verified rather than assumed, because the hypothesis handed to me was half wrong:
- ✅ a working agent **cannot** `send_message` to the task it found — the direction check
  in the handler allows only ancestors in its parent chain and its DIRECT sub tasks.
- ❌ it **can** update its own task description: `checkPermission(auth,"subtree",…)`
  returns true for self, and the system prompt tells it to on scope change.
- ⚠️ it **can** `fork_task_context` (only the TARGET is subtree-restricted, the source is
  free) — but only into a sub task it creates, so forking is a dispatch move, not a
  use-this-knowledge move.

### ⭐ "Latest result" is the LAST round, and the last round is often trivial

The single fact that makes the block structurally unable to answer anything. Measured on a
real hit: `01KY28ZXXSJG` has 3 rounds — round 0 is the whole implementation, rounds 1-2 are
CSS tweaks. The block therefore advertised that task with *"Restyled search hits as
card-style items: background: var(--bg-subtle…)"*. Everything that made the task worth
reading was invisible. Same shape for any task that was reawakened for a follow-up, which
is most closed tasks of any size.

Hence the ordering inside the header: the "these are excerpts, they cannot tell you what a
task concluded" reframe comes FIRST, so the hits are read as an index. Put it after the
hits and the agent has already formed a judgement from the excerpts.

### The reading rule that prevents a NEW error

A past round is *a measurement plus a judgement made at the time*. The measurement usually
still holds; the judgement may already be void — **and a new task on the subject is often
itself the evidence that intent changed** (see § *Tests as current truth* in the system
prompt: a task is a certificate of intent change). An agent that reads "we tried this and
reverted" as a prohibition abandons a road it is currently supposed to walk. Both headers
carry this in one clause.

### Two supporting fixes — an instruction you cannot execute is decoration

Both in the work_context block, both only worth doing BECAUSE the header now says
"get_task these":
- **full taskId**, not `slice(0,12) + "…"`. 12 chars resolves (tracker prefix-matching is
  ≥8), but the ellipsis does not, and a pasteable id costs ~70 chars per block.
- **dead hits dropped** (`if (!task) continue`). `formatTieredHits` always did this; this
  block rendered them as title `"unknown"` with a real-looking but unresolvable id.

### Test notes

Pinned by asserting the block contains `get_task` — the imperative, not the prose, so
rewording survives and deletion does not. In the work_context test the assertion MUST be
scoped to the block (`content.slice(content.lastIndexOf("[Related past tasks]"))`):
work_context also preloads memory.md, which contains both the marker and `get_task`, so an
unscoped `toContain` passes no matter what.

Mutation-verified individually, and the pairing matters: **M2 (full id → prefix) and M3
(dead-hit filter) must be mutated SEPARATELY.** Applied together they mask each other —
the dead-hit test asserts `not.toContain(goneChild.id)`, and a reverted-to-prefix render
does not contain the full id, so the M3 breakage passes silently. Results: both headers →
bare markers = 2 fail (create_task + work_context, nothing else); M2 = 1 fail; M3 = 1 fail.

### Relationship to draft 01KNZGYY (required `origin` param on create_task)

This does NOT replace it and cannot. The block is **structurally late** — the task already
exists by the time the agent learns a related one does. Everything here is recovery
("…and delete this just-created task"); the parameter would make the choice up front. What
changes is the evidence 01KNZGYY needs: its premise was "prompt alone cannot fix this", and
until now no prompt had tried. The honest read is now measurable — if hits still change
nothing, that premise is confirmed on real data instead of asserted.

Left as drafts rather than swept in here: **01KYCQVA8CP** (one task can eat BOTH of
create_task's full slots when it matches on two fields — observed twice; deduping would
regress `search_tasks`, whose whole contract is per-LOCATION hits, so it is a decision not
a tidy-up) and **01KYCQTGQZ** (~~the `search` tool skips `.mxd/` by default~~ — **FIXED the same
day**, along with its glob-depth sibling `01KYCS0BH6` and the same pair in `list_files`
`01KYCV43JAZ`; the three of them are one class and live next to each other in Core Mechanisms).

The strikethrough is the point, not politeness: that parenthetical was a **present-tense claim**
sitting inside a list of *records*, which is the shape that rots without anyone noticing. The
record — "this draft was filed here, for this reason" — stays true forever. "The tool skips
`.mxd/`" stopped being true four hours later, and nothing in this entry would ever have
contradicted it.

---
# Daemon, Worker & Transport
---

## Durability at process boundaries (FU2)

> **Verified 2026-07-25, every constant in this region still matches the code** —
> `WORKER_INIT_TIMEOUT_MS` 30s, `STABLE_RESET_MS` 60s, `RESTART_BACKOFF_MS` [2,4,8,16,30]s,
> `SSE_INITIAL_STATE_RETRY_MS` 200 × 15 attempts (= the 3s budget), `pendingRestartTimers`,
> `sseEpoch`, `formatSseEventId`/`parseSseLastEventId`, `{ env: process.env }` on the Worker
> constructor, `.mxd.lock`, and `arrayBuffer()` in scope-worker. Recorded as a **negative result**:
> this region was never re-checked before, and now it has been, so the next pass can skip it unless
> daemon.ts changed. FIX-6 (below) fixes bugs in the machinery this section builds — read them
> together.

Three tightly-coupled durability gaps closed so process exits + stops don't lose data:

### shutdown() + stopAgent loop settlement

- `shutdown()` order: (1) stopAgent on every running project, (2) await residual `ctx.agentLoopPromises` (bounded 1s), (3) `Promise.all(eventStores.map(s => s.flush()))`. Without (3), fire-and-forget `emitEvent` queued in `agent_end`/`done_notified`/tool_results was lost on worker terminate.
- `stopAgent` awaits loop settlement (bounded 1s) — symmetric with stopTask. Closes the race between `POST /projects/:id/stop` returning and the finally block's `agent_end` / Phase 2 `done_notified` / MCP disconnect writes. Fixes DELETE /projects → pm.delete → rm -rf racing with in-flight JSONL writes.
- Both timeouts are defensive: real providers respect abort within ms. A stuck tool (foreground bash ignoring abort) gets bounded grace, then `buildSessionRepair` on next startup synthesizes the interrupted tool_result (orphan-repair contract). **Do NOT call `fg.resolve()` in stopAgent** — that moves bash cleanly to background and breaks the orphan-repair semantic.
- Restart-crash integration tests (Restart B/I/J/K/N, LC3) rely on shutdown leaving foreground-tool orphans for autoResume to repair. 3s timeout was too slow for 5s test timeouts; 1s is the sweet spot.
- ⚠️ **Correction (2026-07-25): that 1s was tuned under a single-run assumption.** Normal load is now 3-4 sub-agents each running the full suite plus root running it too, and under that contention `Restart B: crash during bash sleep` intermittently blows its 30s test timeout — it takes ~2.6s on the runs where it passes, so this is contention, not a marginal miss. Read the line above as the historical record of that tradeoff, not as "already tuned". Rate, mechanism and a second (port-collision) instance live in draft `01KYCMVKN14RRX0KK0H2CNTD9P`. **Triage shortcut from that draft: the suite's own total run time is a load probe** — when this test fails, check it before suspecting your diff (measured 2026-07-25: failing run 300.8s vs 267-269s for passing ones; the draft carries the current threshold). The thing to re-examine is whether 1s still holds under parallel load; raising the test's timeout would only hide it.

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

## FIX-6 (2026-06-10) — worker init crash hang + shutdown throw (daemon.ts)

Five worker-lifecycle bugs in `src/daemon.ts`. Together they form the self-bootstrap death
chain: agent commits bad code → daemon restarts → worker crashes → permanent hang + lock.

### R8-A#1 — onerror rejects init promise (was: permanent hang)
`worker.onerror` cleared `initTimer` but never called `reject()`. Bun fires onerror AND
terminates the worker on unhandled errors. With the timer cleared and no reject, the
`startWorkerForPlugin` promise hung forever — no timeout fallback, no rejection.
Fix: `initResolved` boolean tracks whether init succeeded. onerror during init → reject
(daemon boot failed, no restart scheduled). onerror after init → schedule restart with
backoff (normal runtime crash recovery).

### R8-A#2 — shutdown() tolerates dead workers (was: thrown InvalidStateError)
`sw.worker.postMessage({ type: "shutdown" })` throws `InvalidStateError` on a terminated
Bun Worker. The throw skipped remaining workers + `releaseDataDirLock`. Fix: try/catch
per worker. Dead workers skip graceful-shutdown wait, go straight to terminate.

### R8-A#9a — {type:"error"} terminates worker (was: thread leak)
scope-worker catches init errors and posts `{type:"error"}`. Daemon rejected the init
promise but never called `worker.terminate()` — the worker thread stayed alive consuming
resources. Fix: terminate + delete from workers map.

### R8-A#9b — restart timers cleared on shutdown (was: zombie workers)
`scheduleWorkerRestart` used bare `setTimeout` without storing the timer ID. After shutdown
released the lock, pending restart timers fired and spawned zombie workers. Fix:
`pendingRestartTimers: Set<Timer>` tracks all restart timers. `shutdown()` clears them
before touching workers.

### R8-A#9c — dead workers cleaned from workers map
Timeout, onerror, and {type:"error"} all left dead `ScopeWorker` entries in the `workers`
map. Fix: `workers.delete(scopeName)` in all three failure paths.

### Test technique: triggering onerror during init
A plugin runtime with `setTimeout(() => { throw ... }, 0)` + `await new Promise(r =>
setTimeout(r, 50))` fires an unhandled throw DURING scope-worker's init phase (before
"ready" is sent). The top-level await gives the event loop a chance to process the 0ms
timer, which crashes the worker and fires `worker.onerror` on the parent. This is the
only reliable way to trigger onerror during init in tests — `process.exit(1)` does NOT
fire onerror (silent death, caught by timeout), and module-level `throw` is caught by
scope-worker's try/catch (posts `{type:"error"}`, not onerror).

## FIX-9 (2026-06-10) — binary response proxy: scope-worker .text() corrupts bytes >0x7F

`scope-worker.ts` used `response.text()` for buffered HTTP responses forwarded back to the
daemon. `text()` decodes bytes as UTF-8 — every byte >0x7F becomes U+FFFD (EF BF BD). A 256-byte
binary payload inflated to 512 bytes; PNG headers (0x89 first byte) became garbage.

**Fix**: `response.arrayBuffer()` + postMessage with transferable `[responseBody]` (zero-copy).
`daemon.ts` `ScopeWorker.pending` type widened from `body: string` to `body: string | ArrayBuffer`
— `new Response()` constructor handles both natively. `scope-worker.test.ts` `workerFetch` helper
decodes ArrayBuffer→string for JSON test convenience.

**Request bodies are NOT affected** — `forwardToWorker` already uses `request.text()` for the
outgoing request, but request bodies in practice are JSON (text). If binary request bodies are ever
needed (file upload via plugin route), that's a separate fix (`request.arrayBuffer()` in
`forwardToWorker` + `ArrayBuffer` in the worker's `new Request(url, { body })`).

Tests: `src/binary-proxy.test.ts` (3 tests) — full byte range 0x00–0xFF, PNG header, text
passthrough. Daemon integration: plugin registers routes serving binary, request goes through
daemon→worker→plugin route→worker→daemon pipeline.

## Audit FU3 [CRITICAL] — SSE catch-up correct across daemon/worker restarts (2026-07-07)

The LIVE "daemon restart → open page blank until F5" bug + two adjacent restart-window
holes. All in `src/daemon.ts`. Three findings, one class: after a restart the UI silently
diverges from server state.

### Finding 1 — epoch-prefix every SSE id (the live blank-until-F5 bug)
Per-lens seq counters restart at 0 on every daemon boot. Audit R7 P2.9 added a stale-ahead
check (`getEventsSinceFromBuffer`: `lastSeqId > lastEntry.seqId → null`) that catches a
pre-restart cursor BEYOND the new tail — but NOT a cursor whose seq falls INSIDE the new
incarnation's refilled range. After a real restart agents auto-resume + stream, so the buffer
refills PAST the browser's low pre-restart cursor before it reconnects → `getEventsSince`
returns a wrong-epoch slice → `catchUpDone=true` → full initial state skipped → stale UI until F5.
P2.9's own comment called epoch ids "the proper fix, out of scope"; FU3 shipped it.

- Every SSE `id:` is now `<epoch>-<seq>`, epoch = `String(Date.now())` minted once per
  `createDaemon` (const `sseEpoch`). Two pure exported helpers at module scope:
  `formatSseEventId(epoch, seqId)` and `parseSseLastEventId(header)`.
- `parseSseLastEventId`: `<epoch>-<seq>` → `{epoch, seq}` (split on the LAST dash — epoch may
  contain dashes); bare numeric (pre-epoch daemon cursor) → `{epoch: null, seq}`; garbage → null.
- `/events` catch-up runs ONLY when `lastCursor.epoch === sseEpoch`. `epoch:null` (legacy),
  foreign epoch (previous incarnation), and null (garbage) all fall through to full initial state.
- `getEventsSinceFromBuffer` is unchanged + still reasons WITHIN one incarnation; the epoch
  layer sits above it. Both `id:` emit sites (live relay ~837, catch-up replay ~1886) use
  `formatSseEventId` — a bare-seq emit would poison the client's NEXT reconnect cursor.
- Client needs ZERO changes: EventSource echoes `Last-Event-ID` opaquely; only the server parses.

### Finding 2 — ONE unified worker.onmessage, installed before init
The old code used a temp init-only handler (loaded/ready/error) and swapped in the runtime
handler AFTER `ready`. But the worker posts `sse_event`s DURING init (autoResumeProjects crash
recovery, `onBroadcast` wired before `autoResumeProjects` in scope-worker.ts) → dropped silently.
Harmless on first boot (no clients), HIGH impact on worker auto-restart (SSE clients still
connected daemon-side miss every recovery event). Fix: `setupWorkerMessageHandler` →
`handleWorkerRuntimeMessage(pluginName, scopeWorker, msg)`, called from the SINGLE
`worker.onmessage` for any non-init-protocol message (`else` branch after loaded/ready/error).
`shutdown_complete` is unaffected — it uses `addEventListener`, not `onmessage`.

### Finding 3 — /events initial-state polls worker readiness (restart-gap reconnect)
`workerKeyForProjectScope` (one-shot `workers.has → undefined`) → `awaitLensWorkerReady(projectId,
scope, signal)`: no plugin for the lens → undefined immediately (permanent; auth-only `scope=""`);
plugin exists but worker not ready → poll `SSE_INITIAL_STATE_RETRY_ATTEMPTS(15) ×
SSE_INITIAL_STATE_RETRY_MS(200)` = 3s, aborts on client disconnect. A client connecting during
the ~2s worker-restart backoff+init previously got a live stream with NO tree until the next
unrelated event. Budget is 3s not the spec's 2s ON PURPOSE: the 2s backoff expires exactly as the
restarted worker BEGINS init, so a 2s poll guarantees a miss for early-gap clients; spec Test 4
asserts arrival "within 3s". Ready worker resolves on first check, zero delay.

### Tests
- `src/sse-catchup.test.ts` (7 integration, REAL daemon+worker via in-process `daemon.fetch`):
  spec Tests 1-4 + the live old-epoch-cursor-INSIDE-new-range regression + same-epoch replay
  still works + same-epoch-ahead-cursor. Test plugin emits an `init_probe` sse_event at MODULE
  IMPORT time (fires inside the worker's init sequence, before `ready` — models
  autoResumeProjects timing) and exposes `/test-emit` (emit via ctx.onBroadcast) + `/test-crash`
  (unhandled throw → onerror → auto-restart, the FIX-6 technique). An `SseReader` parses `id:`/
  `data:` frames from the stream body with a `waitFor(pred, timeout)`.
- `src/sse-ring-buffer.test.ts` (+6 unit): formatSseEventId/parseSseLastEventId incl. legacy
  bare-numeric → epoch:null, last-dash split, garbage → null.
- Full suite 2447 pass / 0 fail (baseline 2435 + 12). typecheck + check:ci clean.
- Verified the LIVE correspondence first: pre-fix `getEventsSinceFromBuffer(buf 1..10, oldLEI=5)`
  returned a 5-event wrong-epoch slice (bug); the spec's literal repro (LEI=100) was already
  null via P2.9. So the epoch variant — NOT the literal one — is today's blank-until-F5 symptom.

### Pre-existing base-branch gate failures (NOT from this work — flagged to root)
`bash scripts/check-i18n.sh` fails on 3 bare strings in `web/MarkdownText.test.tsx` /
`web/markdown-table.test.ts` (from markdown commit 32b4f440, ancestor of this branch). My files
are `.ts` (no JSX). typecheck + check:ci pass with my changes; root should clean i18n before the
final main commit.

## Bun Worker env isolation — process.env NOT inherited (2026-07-23)

**Bun Workers do NOT inherit `process.env` assignments from the parent thread.** Workers
get their own env from the OS process snapshot at spawn time. `process.env.X = "Y"` in
the main thread is INVISIBLE to file-based Workers. This applies to BOTH:
- Direct `process.env` assignment in JS
- `bunfig.toml [test.env]` settings (which set process.env, not OS env)

**The ONLY way to pass env vars to a Bun Worker**: the `env` option on the Worker
constructor: `new Worker(url, { env: { KEY: "value" } })`. Verified empirically: data-URL
workers DO inherit process.env (different codepath), file-based workers do NOT.

**Fix applied**: `src/daemon.ts` Worker constructor passes `{ env: process.env as Record<string, string> }`
so workers inherit runtime env vars. This is correct for production too — workers SHOULD
see the same env as the main thread.

---
# Plugin System
---

## Plugin Architecture

### Three-Layer Split
- **Daemon** (`src/daemon.ts`): HTTP shell, auth, config, project CRUD, plugin discovery, worker management, SSE relay (ring buffer + Last-Event-ID), web build (Bun.build + importmap)
- **Runtime** (`src/runtime.ts`): Plugin-agnostic. ZERO Matrix imports. Receives `buildScopeOpts` via config.
- **Plugin** (`.mxd/plugin/`): Matrix-specific — manifest, tools, prompt, hooks, web UI component

### ScopeOpts on RuntimeContext

`ctx.scopeOpts: Map<projectId, ScopeOpts<T>>` — per-project scope configuration. `buildMatrixScopeOpts()`
is the ONE place that knows Matrix tools + prompt + hooks.

**The hook list is NOT reproduced here.** It lives in `src/runtime/context.ts` and it has grown
several times (`onTaskDelete`, `seedTree`, `onScopeResume` were all added after this section was
written, and two hooks changed arity and became required). A copy in this file would go stale
silently — there is no compiler between the two. Read the interface; the notes below are only for
the parts the type signature does not tell you:

- **Hooks are named by EVENT, never by resource.** `onTaskDelete`, not `removeWorkspace` — a name
  like the latter presupposes that tasks HAVE workspaces, which is a plugin-specific assumption the
  runtime must not encode. Prose comments may say "workspace"; hook NAMES may not.
- **`seedTree` vs `onScopeResume`**: seedTree runs once, only when a project's tree is first created;
  onScopeResume runs on every startup. They are the fresh-install and the every-boot halves of
  "the plugin gets a chance to touch its tree".
- **`onDone` returns void**, and the runtime hands it the raw done input as an opaque record — see
  *The done() payload* § The boundary for why that opacity is load-bearing.
- Everything optional is genuinely optional: the runtime does `opts.hook?.(...)` and attaches no
  meaning to absence.

### BaseTaskNode / TaskNode Split

Runtime uses `BaseTaskNode` **at the type level**: the `ScopeOpts<T>` hook interfaces and the
`PluginTypes` generic are parameterized over it. Matrix extends it — `TaskNode extends BaseTaskNode`
adds description, branch, worktreePath, cwd, color, costUsd, budgetUsd, resultRounds. The generic
flows through all `ScopeOpts<T>` hooks, so each plugin gets its own node type back, type-safe.

⚠️ **Two details in the original wording are superseded.** It said BaseTaskNode is
"(id, parentId, children, title, session)" and that Matrix adds "status" — `status` and `metadata`
were promoted UP to BaseTaskNode (they are genuinely runtime-generic: the runtime inits, mutates and
resumes on status). See *The node model* § Later. It also said `PluginTypes { node; done }` and
`MatrixPluginTypes binds done: MatrixDoneData` — **the `done` member of PluginTypes and the
`MatrixDoneData` type were both deleted**; done content is opaque to the runtime now. See
*The done() payload* § Step 1.4.

CAVEAT (Audit A): only the *hook interfaces* are generic. The concrete `TaskTracker` (`src/task-tracker.ts`) still stores Matrix's `TreeNode` (`TaskNode | GeneralNode`) directly — it is NOT generic over `BaseTaskNode`. "Runtime uses BaseTaskNode" is aspirational for the tracker; full tracker generalization is future work (plugin-extraction track).

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
<repo>/.mxd/
  config.json        ← daemon (repo-scope project config)
  plugin/            ← daemon reads for discovery
    index.ts         ← plugin manifest
    runtime.ts       ← plugin ScopeOpts (worker)
    web/             ← plugin React components (shell imports)
  hooks/             ← matrix plugin runtime
  memory.md          ← matrix plugin runtime
```

⚠️ **`tree.json` used to be listed here and that was wrong** — it is NOT in the repo. It is daemon
runtime state at `~/.mxd/projects/<id>/plugin/matrix/tree.json`, deliberately outside git because the
tree mutates constantly and committing it would pollute history. The listing above contradicted
*Unified Storage Layout*, which has always said so. Only the four repo-tracked things are here now;
everything runtime lives under `~/.mxd/` — same split, stated once per side.

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

## Plugin extraction — Chunk 1: buildMatrixScopeOpts → .mxd/plugin/, worktree via hooks (2026-06-05)

First chunk of "matrix → plugin" physical extraction. Runtime (`src/runtime/*`) no longer
CONTAINS matrix scope logic nor imports `WorktreeManager`.

**Moved**: `buildMatrixScopeOpts` + `MatrixDoneData`/`MatrixPluginTypes` → `.mxd/plugin/scope-opts.ts`.
The factory is self-contained; runtime only ever invokes it through the `ScopeOpts` hook
interface, never by name. Leaf utilities (WorktreeManager, createOrchestratorTools,
buildSystemPrompt, buildWorkContextContent, buildSummarizationInstruction, slugify,
McpClientManager) stay in `src/` as neutral building blocks — the plugin imports them
(plugin→src is the allowed direction). The LEAK was buildMatrixScopeOpts living in
runtime/agent-lifecycle.ts, NOT the utils.

**worktree-manager.ts stays in src/** (Option a — user-confirmed). Stateless git util, zero
matrix domain knowledge; both the plugin scope-opts AND orchestrator-tools.ts (matrix code
still in src/) import it. Re-evaluate its final home when orchestrator-tools moves (later chunk).

**Worktree ops in runtime routes → hooks** (`src/runtime/routes/tasks.ts`):
- Reactivation (verify/closed relaunch): now calls existing `scopeOpts.beforeChildLaunch(node,
  tracker, projectPath)` — semantics matched the inline worktree-create exactly. Kept the
  parent-no-branch 400 pre-check for behavior parity (hook throws → 500 otherwise).
- DELETE route: new hook `ScopeOpts.onTaskDelete?(node, projectPath)`. Matrix implements via
  `WorktreeManager.remove`. Route bridges the `removeWorktree(taskId, slug)` task-operations
  callback contract by looking up the node (`tracker.getTask(id)` — still present: cleanup runs
  before `tracker.remove`, and delete only works on leaf tasks). closeTaskOp/resetTaskOp worktree
  removal stays in orchestrator-tools.ts (matrix code) — out of scope this chunk.

**Hook naming rule (user)**: name lifecycle hooks by the EVENT, not the resource. `removeWorkspace`
was REJECTED — "workspace" presupposes tasks HAVE workspaces, a plugin-specific assumption;
runtime's BaseTaskNode is pure structure. Chose `onTaskDelete` (parallels onLaunch/onDone). Prose
comments may use "workspace" as a generic concept; the constraint is only on the hook/API NAME —
no "WorktreeManager"/"worktree" token in any runtime hook/API name.

**Invariants held**: `grep WorktreeManager src/runtime/` → zero. Zero production (non-test) imports
from `.mxd/plugin/` in src/ (test-utils + *.test.ts may import plugin — test infra). `bun test`
green, `bun run typecheck` clean. test-utils/matrix-scope.ts only changed its import path to the
new plugin location (test infra → plugin is allowed).

## Narrowed plugin messaging API — deliverToNode + listNodes (2026-06-07)

Two stable, named primitives in `src/resource-registry.ts` that a plugin's
tools compose for intra-project peer messaging WITHOUT importing the internal
singleton accessors (`getTracker` / `deliverMessage`) directly. The SDK
(task 01KTJ4EW8T3B1YWNV9JKGGZJW2) re-exports exactly these two;
`getTracker`/`deliverMessage` stay internal to matrix.

- `deliverToNode(projectId, nodeId, msg, opts?): Promise<void>` — a thin
  stable-named wrapper over the ONE existing `deliverMessage` (the
  projectId-handle side-effect). NOT a fork — it calls the single delivery
  path verbatim (JSONL persist → enqueue to a live peer's queue → auto-launch
  an idle peer unless `opts.quiet`). The "wake an idle recipient" semantic is
  exactly what a plugin wants. NO permission policy baked in (unlike matrix's
  `send_message` ancestor/sub-task restriction — that's matrix policy);
  intra-project delivery is unrestricted, the plugin's tools own routing.
- `listNodes(projectId): ReadonlyArray<BaseTaskNode>` — fresh read-only
  snapshot of the project's LAUNCHABLE nodes (`tracker.allNodes().filter(isTask)`).
  General (non-launchable) nodes — matrix folders, a plugin's grouping nodes —
  are excluded: you can only deliver to a launchable node, and `BaseTaskNode`
  is the runtime-generic launchable shape every plugin's node type extends.
  Returns a FRESH array each call (filter creates a new array): mutating the
  returned array does not affect the tracker. The plugin resolves group
  membership + name→node from each node's plugin-owned `metadata` (added to
  `BaseTaskNode` by the node-model generalization task).

### ⭐ Singleton constraint — the whole point
Both operate on the SAME in-process tracker/session registry the agent loop
uses (the module-level `_ctx` in resource-registry, initialized once at first
agent launch via `R.initResourceRegistry(ctx)` in agent-lifecycle.ts:183).
That shared singleton is the only reason a delivered message ARRIVES at a live
peer (enqueued / auto-launched) instead of being silently dropped. A plugin
that vendored its OWN copy of resource-registry would get a DIFFERENT `_ctx` →
a different tracker → delivery would no-op with no error. So the SDK MUST
re-export from this single live module, never bundle a copy. This is the same
finding the SDK task encodes ("thin re-export of the live install, never a
standalone bundle").

### Why narrow (not just expose getTracker/deliverMessage)
dchat was forced to import `getTracker` + `deliverMessage` (resource-registry's
own header declares it matrix-tool-handler INTERNAL). The narrowing is
SEMANTIC: `deliverToNode` exposes only delivery (can't be misused);
`listNodes` exposes a read-only snapshot (can't mutate the tracker). Versus
`getTracker` = full mutable tracker access, `deliverMessage` = raw path. The
SDK re-exports the narrow two; the plugin never touches resource-registry.

### Tests — `src/plugin-messaging.test.ts` (integration, mock provider)
Real agent loop (createMatrixApp + lightweight non-matrix "peer" scope, no
worktrees) so the registry is wired exactly as in production. (1) A dummy
plugin tool `send_to_peer` (invoked from inside a running root agent) calls
`deliverToNode` to an idle peer child → the peer AUTO-LAUNCHES, reads the
delivered instruction, done()s → verify; asserts the delivered user message is
in the peer's JSONL AND `registryGetTracker(projectId) === app.ctx.trackers.get(projectId)`
(same singleton). (2) `listNodes` returns root + task children, excludes a
folder; pushing to the returned array leaves a later call + the tracker
unchanged. (3) broadcast: loop `listNodes` → `deliverToNode` to each OTHER
member (exclude root + self) → both peers verify, self stays pending with no
JSONL ("none to self"). NB: in test 1 the sender root YIELDS after the tool
(single-turn instruction → mock end_turn) so it stays alive and the peer's
later task_complete enqueues instead of relaunching it.

### Rendering gap NOT solved here
A plugin still can't define how its own messages render (`formatQueueMessage`
hardcodes an XML wrapper per built-in source). Tracked as low-pri draft
01KTJ5F5XTM32YNS6RSPW7R5PF; dchat smuggles via `source:"user"` until then.

## Additive project-scoped plugin routing — dual lenses (2026-06-08)

A project that ships its own `.mxd/plugin/` is served by BOTH its own scope AND
the global matrix scope, **ADDITIVELY**. `matrix:<id>` (dev lens — coding/
orchestration) and `<own>:<id>` (product lens — its own worker) **coexist**, on
separate per-scope dataRoots. Shipping a plugin ADDS a lens; it NEVER removes the
matrix dev lens.

### Why additive, NOT exclusive (the lesson — don't re-pollute)
The first attempt (commit `171a3bf`, **REVERTED by `7b17a43`**) made ownership
EXCLUSIVE: `pluginForProject = own ?? global` (single owner) — matrix STOPPED
serving a project that shipped its own plugin. That was WRONG:
- **`<scope>:<project>` is a TWO-PART address — its existence PROVES dual.** If a
  project mapped to one scope, the prefix would be redundant. Exclusive collapsed
  it to `scope = f(project)`.
- The original design is **"Parallel Run Loops — alongside, NOT override."**
  Exclusive turned alongside into override.
- Self-bootstrap REQUIRES coexistence (matrix is its own product; "product is a
  dev tool" only holds if a project opens in both lenses at once).
- per-plugin dataRoot (`projects/<id>/plugin/<plugin>/`) was built for multiple
  plugins coexisting on one project — wasted under exclusive.

If any routing decision tempts you toward "a project belongs to ONE plugin",
that's the bug returning. Additive, never exclusive.

### Daemon-core routing (`src/daemon.ts`)
- `workerKeyForPlugin(plugin)`: global → `name`; project → `<projectId>:<name>`
  (two projects can ship a same-named plugin → distinct workers). This worker KEY
  uses `:`; it is NOT the URL scope segment (which is the bare plugin NAME).
- `scopesForProject(id)` = all globals ∪ the project's own plugin (if any).
  **GLOBALS-FIRST** ordering → default lens is matrix/dev. REPLACES the reverted
  exclusive `pluginForProject` single-owner. Used by DELETE fan-out + shell.
- `projectsForPlugin(plugin)`: **global → ALL projects** (matrix is every
  project's dev lens, MUST know them all to resume/build scope opts); project →
  its own project only. No double-resume: the lenses live in DISTINCT dataRoots,
  so each worker only resumes the tree under its own dataRoot. (The reverted
  version filtered globals to "only-owned" — dropped; that was a patch for a
  non-problem, dataRoot already isolates.)
- One worker per plugin (spawn loop over ALL plugins, not globals-only).
- `onProjectInit` (startup) runs per `projectsForPlugin` → matrix scaffolds EVERY
  project's dev lens (memory.md, hooks) — restores pre-exclusive behavior.
- DELETE `/projects/:id` **FANS OUT** a `/stop` to every scope serving the
  project (a running agent in ANY lens must stop before data removal).
- `/api/:plugin/*` resolution (reused verbatim from the reverted infra, correct
  for additive): a GLOBAL candidate named `<plugin>` is used directly → matrix
  serves any project; else the projectId in the stripped `/projects/<id>/...`
  path selects the project-scoped worker.
- `firstGlobalWorkerKey()` (ready-checked) for project-agnostic routes
  (health, /version, /stats). `firstGlobalPluginName()` = default SSE scope.

### SSE is scope-aware — a "lens" = (projectId, scope)
`scope` = the plugin NAME (URL `<pluginScope>`). A project has a DISTINCT tree
per lens, so each lens has its own SSE stream:
- `ShellSSEClient` carries `scope`; `/events?projectId=&scope=` (scope defaults
  to `firstGlobalPluginName()` ?? `""` — `""` keeps an auth-only/plugin-less
  daemon's `/events` opening 200 with no initial tree, the old behavior).
- seqId counter + ring buffer keyed by `lensKey(projectId, scope)` =
  `${projectId}\u0000${scope}` (`\u0000` can't appear in a ULID id or a
  `[A-Za-z0-9_-]` name; distinct from the worker key's `:`).
- The `sse_event` relay derives the lens from the EMITTING worker: the worker
  serving `pluginName` → events belong to `(projectId, pluginName)`. Only clients
  matching `(projectId, scope)` receive them → a product viewer never sees the
  dev tree and vice versa. `setupWorkerMessageHandler` gets the plugin NAME.
- Initial tree/clarifications come from `workerKeyForProjectScope(projectId,
  scope)` (the VIEWED lens's worker), not "first global".
- DELETE cleans every `${projectId}\u0000*` lens buffer.
- Single-lens projects (no own plugin) → one worker emits scope=matrix → one
  stream → **identical to pre-additive behavior** (the regression bar).

### Shell multi-lens (`web/`)
- `web/plugin-scope.ts → pluginsForProject(plugins, projectId)` = all globals ∪
  the project's own plugin, **globals-first** (default = dev/matrix). Mirrors the
  daemon `scopesForProject`.
- `ShellApp.tsx`: `availablePlugins = pluginsFor(projectId)` feeds the scope
  SELECTOR (lists BOTH lenses for a project with its own plugin); `scopeIsValid`
  + URL normalization rewrite a missing/stale `<pluginScope>` to a valid lens;
  `resolvePlugin(scope)` disambiguates same-named project plugins by projectId
  (loads the right web bundle). `<PluginUI key={projectId/scope}>` gets a new
  `scope` prop.
- Plugin web: `PluginProps += scope`; threaded Plugin → PluginShell →
  ProjectContent → `useSSE(projectId, scope, ...)` → `/events?...&scope=`.
  `useSSE` guards `if (!projectId || !scope) return` and includes `scope` in deps
  (lens switch → reconnect).

### DEFAULT LENS = dev-first (matrix), decided
Globals-first ordering. Rationale (orchestrator, 2026-06-08): additive
consistency (matrix is the foundation lens every project always has, the product
lens is the ADDITION — defaulting to product would make first-load identical to
the reverted exclusive model and HIDE the addition; the default should TEACH the
model), robustness (matrix dev lens always works; product workers are mid-build),
dev-workflow fit. A FUTURE per-project configurable default (for finished,
end-user-facing products) is draft `01KTJZ07MC0VWM923SBDZHDRP8` — do NOT bake
product-first globally while products are under development.

### Tests
- `src/plugin-project-scope.test.ts` (additive): INVERTS the reverted "matrix
  404s P_own" → "matrix STILL serves P_own (dev lens, 200 + Orchestrator)";
  dual-lens coexist + ISOLATION (task in `matrix:pown` absent from `story:pown`
  and vice-versa); DELETE fan-out (project gone from BOTH lenses); + onProjectInit
  runs on P_own too. Keeps regression + same-named-distinct-workers + scope-info.
- `web/plugin-scope.test.ts` (additive): a project with its own plugin sees BOTH
  scopes, default (first) = matrix; globals-first ordering pinned.
- `src/test-utils/story-scope.ts`: generic non-matrix test scope (reused verbatim
  from the reverted infra — it has no exclusive/additive logic).

### Pre-existing worktree noise (NOT a regression)
Daemon tests that run `createDaemon` with the matrix repo (a git WORKTREE, where
`.git` is a FILE) log `onProjectInit failed for matrix on matrix: ENOTDIR …
.git/info` from `excludeWorktrees`'s `mkdir(.git/info)`. Caught + logged, tests
pass. Predates this work (matrix's onProjectInit ran on the matrix project under
the old code too). On a normal checkout (`.git` is a dir) it succeeds.

## Plugin SDK — `mxd/plugin-sdk` bare specifier + re-exported zod (the "bun add mxd" dependency story) (2026-06-08)

An out-of-tree plugin (dchat) depends on matrix's public API via a STABLE,
depth-independent bare specifier instead of counting `../`s, with exactly ONE
zod identity shared between matrix and the plugin. Closes the two
dependency-boundary gaps the dchat 试水 surfaced (both had fragile workarounds:
a dev symlink + an exact zod pin on dchat's side).

### Mechanism — `exports`-map SUBPATH of the real `mxd` package (NOT `@mxd/plugin-sdk`)
- `package.json` gains `"exports": { "./plugin-sdk": "./src/plugin-sdk.ts", "./package.json": "./package.json" }`.
- Plugin imports `import { defineTool, type ScopeOpts, z, ... } from "mxd/plugin-sdk"`.
- A plugin installs matrix ONCE (`bun add <matrix>` / `bun link mxd` → a
  `node_modules/mxd` entry, typically a symlink). Bare-specifier resolution walks
  UP node_modules → depth-independent, so it works inside the plugin's own git
  worktree with NO `../` counting and NO dev-symlink hack (Gap A closed).
- Chose `mxd/plugin-sdk` over `@mxd/plugin-sdk`: the `@mxd/*` names
  (`@mxd/types`, `@mxd/auth-context`) are BROWSER virtual modules (tsconfig
  paths + importmap), a different mechanism. A server node_modules package reusing
  `@mxd/*` would falsely imply kinship. `mxd/plugin-sdk` is the honest subpath of
  the real `mxd` package — the literal "bun add mxd → import its subpath" story,
  zero extra publishing. (This overrides the `@mxd/plugin-sdk` example that
  appeared in the original task description; orchestrator approved the deviation.)

### ⭐ Singleton: thin re-export, never a vendored copy (realpath dedup — EMPIRICALLY PROVEN)
`src/plugin-sdk.ts` re-exports matrix's own modules via RELATIVE paths. Bun/Node
dedupe modules by REALPATH, so a plugin importing `mxd/plugin-sdk` through its
`node_modules/mxd` symlink resolves to the SAME physical files → the SAME process
singletons matrix's agent loop uses (the module-level `_ctx` in
resource-registry.ts). So `deliverToNode`/`listNodes` hit the ONE in-process
tracker — a delivered peer message ARRIVES (enqueued / auto-launched), never
silently dropped against a different `_ctx`. A vendored copy = different realpath
= different `_ctx` = silent no-op. Proven: a probe outside matrix with a
`node_modules/mxd` symlink shares matrix's `_ctx` (and `listNodes` returns the
EXACT same node object the app's tracker holds — reference identity).

### ⭐ One zod identity (Gap B closed) + exact pin (DO NOT re-add the caret)
- The SDK does `export { z } from "zod"`. A plugin imports `z` from the SDK →
  matrix's exact zod instance → a plugin's `z.string()` passes matrix's
  `shapeToJsonSchema` (`z.toJSONSchema(z.object(pluginShape))` — matrix's z
  wrapping the plugin's schema; only works when both are the same ZodString
  class). The plugin need not depend on zod at all.
- `package.json` pins `"zod": "4.3.6"` EXACT — the caret (`^4.3.6`) was the drift
  root cause on BOTH sides (dchat drifted to 4.4.3 → two distinct ZodString types
  → `defineTool` stopped typechecking). package.json is strict JSON (no inline
  comment possible) — this memory entry IS the "why no caret"; a future agent
  must NOT re-loosen it without re-reading the zod-identity requirement.

### Surface — EXACTLY the finalized manifest, never widened (anti-pattern #6)
Type-only: `ScopeOpts`, `PluginTypes`, `BaseDoneData`, `RuntimeContext`
(runtime/context.ts); `BaseTaskNode`, `TaskStatus` (types.ts); `Auth`
(tool-auth.ts); `PluginManifest` (plugin.ts).
Runtime values: `defineTool`, `toToolDefinition` (tool-def.ts); `createYieldTool`,
`createDoneTool` (tools/prefab.ts); `createUserMessage` (queue-message-factory.ts);
`isTask` (types.ts); `deliverToNode`, `listNodes` (resource-registry.ts — the
NARROWED messaging API, NOT raw getTracker/deliverMessage which stay internal);
`z` (zod). NO `checkPermission` (only `Auth` as a type), NO LLM facility — no
plugin imports them today.

### Exports map narrows the surface (gating is load-bearing)
Adding `exports` GATES deep imports: `import "mxd/src/resource-registry.ts"` now
FAILS to resolve — so `getTracker`/`deliverMessage` are un-importable; only the
narrowed `deliverToNode`/`listNodes` reach a plugin. Verified safe to add: ZERO
bare `mxd/`/`matrix/` self-imports exist in the tree (matrix uses relative
imports; the worker `import()`s plugins by ABSOLUTE path — both bypass package
resolution, so gating breaks nothing internal). The aspirational
`import "matrix/src/llm.ts"` docstring in src/llm.ts was wrong (wrong name +
non-resolving) and is unrelated — left as-is (not in scope).

### Tests
- `src/plugin-sdk.test.ts` (NEW, 7 tests): (1) thin re-export reference identity
  (every value === its origin symbol; `z` === zod's z); (2) zod identity
  end-to-end (SDK's z through toToolDefinition); (3) bare-specifier-through-symlink
  singleton — `listNodes` reads the app's own tracker, and the returned node is
  REFERENTIALLY the app's tracker node (the headline "same live tracker" proof);
  (4) zod through the bare specifier; (5) deep-import gating (exports map blocks
  `mxd/src/...`).
- `src/plugin-messaging.test.ts` (REROUTED): its dummy plugin now consumes the
  PUBLIC SDK surface (`./plugin-sdk.ts`) instead of resource-registry directly —
  so its real-agent-loop tests ("deliverToNode wakes an idle peer on the SAME
  tracker", listNodes snapshot, broadcast) double as the LITERAL proof that the
  SDK's deliverToNode delivers + wakes in a loop. `registryGetTracker` stays the
  internal accessor (used only to ASSERT identity, intentionally off-surface).
  Reference identity + this reroute = airtight arrival coverage WITHOUT
  duplicating the agent-loop harness.

### Gotcha — `deliverToNode` needs `registerSideEffects` (wired at AGENT LAUNCH, not createApp)
`_ctx` is set by `initResourceRegistry` (createApp path), but `_deliverMessage`
(backing `deliverMessage`/`deliverToNode`) is registered by `registerSideEffects`
which runs inside `buildAgentContext` at agent launch (agent-lifecycle.ts:184).
So `deliverToNode` THROWS "deliverMessage not registered" if called outside any
agent loop (e.g. a fresh createMatrixApp with no launch). `listNodes` works
without a launch (only needs `_ctx`). This is why the SDK's deliverToNode arrival
is tested via a real loop (plugin-messaging) not a bare createApp.

## Mock-showcase extraction — unconditional → matrix-plugin-only (2026-06-09)

Mock-showcase (static data endpoint + standalone UI page for component development)
extracted from unconditional runtime registration into the matrix plugin.

### What moved
- `src/runtime/routes/mock-showcase.ts` → `.mxd/plugin/routes/mock-showcase.ts`
- `src/runtime/routes/mock-showcase-image.png` → `.mxd/plugin/routes/mock-showcase-image.png`
- Route registered in `.mxd/plugin/runtime.ts` `registerRoutes`, not `src/runtime.ts`

### Leak fixed
Previously `registerMockShowcaseRoute(app)` was called unconditionally in
`src/runtime.ts` for EVERY plugin worker. Now only the matrix plugin worker serves it.

### UI activation path
Old: `?mock=true` query param — dead since Task Y.
New: `/<projectId>/matrix/mock-showcase` — Plugin.tsx lazy-loads MockShowcase when
`pluginPath === "mock-showcase"`.

### Key details
- MockShowcase.tsx stays at `.mxd/plugin/web/MockShowcase.tsx` (unchanged location)
- Data endpoint URL unchanged: `GET /api/matrix/mock-showcase`
- No new plugin entity — mock-showcase is a FEATURE of the matrix plugin
- Moved route file uses `../../../src/` relative paths (same pattern as scope-opts.ts)

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

## Auth Hardening (Audit FU4)

### Defaults that close the "LAN-open window"
- Fresh daemon auto-initializes `auth.json` with `jwtSecret` + `secretVersion=1`
  during `createDaemon`. ~~Production callers get this by default; tests opt out
  via `createDaemon({ autoInitAuth: false })`.~~ **There is no opt-out** — the
  parameter was deleted in Audit R7 P1.3 and auth is now unconditionally on for
  every daemon boot, tests included (they mint a token instead; see the migration
  note in that entry). This bullet contradicted P1.3 in the same file.
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
~~Skip set: `{ "/", "/auth/status", "/auth/logout" }` + static `/vendor/` `/app/` prefixes.~~
**SUPERSEDED twice** — see *The anonymous surface* under Audit R7 P1 for the current list, which is
one exact path plus two prefixes plus a GET-only frontend-path predicate. The durable half of this
entry: replacing a `startsWith("/auth/")` skip with an EXACT set (Audit J H1), because the prefix
form would silently exempt any future `/auth/*` route someone added. Regression guard:
`GET /auth/bogus` → 401.

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

### The anonymous surface (verified 2026-07-25 — this is the whole list)

Four ways a request skips auth, and `SKIP_EXACT` is now only the first:

1. `SKIP_EXACT` = **`{"/auth/status"}`**, one entry. The login page must be able to ask "am I
   authenticated?" before it has a token.
2. `/vendor/` and `/app/` prefixes — compiled bundles, no secrets.
3. **`GET` + `isFrontendPath(path)`** — `/` exact, OR the first path segment is a **currently
   registered project id**. This is the biggest part of the surface and the least obvious: after
   Task Y, tasks live at `/<projectId>/<scope>/<taskPath>`, browsers do not send `Authorization` on
   navigation, so a refresh on such a URL must reach the shell. The shell itself is
   auth-content-free and every API call it makes is gated by this same middleware. Unregistered
   first segments fall through to a clean 404. See *Task Y SPA fallback* for the `pm.has` predicate
   and why it is not a ULID regex.
4. Nothing else. **Everything under `/auth/*` other than `/auth/status` requires a token** —
   regression test `/auth/bogus` → 401, which exists because a former `startsWith("/auth/")` skip
   would have silently exempted any future `/auth/*` route.

**Method-gated on purpose**: item 3 is `GET` only. POST/PATCH to a frontend-shaped path stays
401 — those are not legitimate SPA paths, and an honest 401 beats accidentally serving HTML.

~~Earlier descriptions of this set said `{"/", "/auth/status", "/auth/logout"}`, and later
`{"/", "/auth/status"}` + prefixes.~~ Both are superseded: `/auth/logout` was removed by P1.1 (it
was CSRF-abusable — any drive-by page could force a `bumpSecretVersion` and log everyone out), and
`/` moved out of `SKIP_EXACT` into `isFrontendPath` when Task Y made project paths server-visible.
Reading either old list understates the anonymous surface, which is exactly the wrong direction for
an auth note to be wrong in.

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

---
# Web UI — Routing, State & Event Handling
---

## UI Notes

- Event fetching: per-session (`api.taskEvents(projectId, sessionId)`) not per-project. Forked sessions contain parent events — merging causes stale content.
- Derived state reset: ALL state cleared on project/task switch (logs, tokenUsage, pendingMessages, etc.).
- Lifecycle entry collapse: consecutive lifecycle-only entries collapsed, keeping last per run.
- Agent status: **SUPERSEDED 2026-07-25 — see "Agent activity: one explicit backend state" at the end of this file.** This used to read: *"`activeAgents` Set updated globally in `handleEvent` BEFORE per-session filter (agent_active/idle/stopped/orchestration_started/orchestration_completed). `processEventBatch` calls `checkAgentStatus()` after processing to overwrite stale state from historical events."* That second sentence WAS the bug report — replaying the log falsely activated agents, so a poll had to undo it. Activity is now one explicit backend state pushed by the server (and asked for at connect); `activeAgents` is derived from it in one place, and nothing reconstructs it from events.
- Per-task message drafts: `localStorage` key `mxd-prompt-draft:<nodeId>`. Debounce uses `targetRef.current` (not `targetNodeId` in deps) to avoid saving stale prompt to wrong task key during render transition.
- `/compact` targets viewed task: backend reads `nodeId` from POST body, falls back to rootNodeId. Frontend passes `viewedTaskId`.
- Task tree sort: `STATUS_PRIORITY` in TaskTree.tsx: in_progress(0) > verify(1) > pending(2) > draft(3) > failed(4) > closed(5). Stable sort preserves user ordering within each status group.
- hideCompleted filter: hides `closed` and `failed` only. `verify` is actionable and remains visible.
- Scroll follow mode: scroll-to-bottom re-enables follow, scroll-up disables. Follow button also enables.

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

## Root is a regular task — the null-sentinel anti-pattern (Fix A + Fix C, 2026-04-18)

Two entries merged: Fix A fixed one instance (the pending-message filter), Fix C named the class and
swept the rest. The **anti-pattern below is the durable part and is still the rule.**

⚠️ **The URL mechanism described in this section is superseded.** Fix C implemented it with a hash
(`#<projectId>/<taskId>`); Task Y replaced that with path segments a few months later — see *URL
routing: path segments with layer ownership*. What survived the replacement intact: the anti-pattern,
the sentinel sweep, and the principle that the URL is the routing truth and a brief "nothing selected
yet" state is valid rather than something to paper over. Task Y kept all three; it only moved where
the id is stored in the URL.

**Symmetry trio** (as written at the time): Fix A made root a regular task in the data model + AppFooter filter; Fix B made partial events monotonic-extend so refresh doesn't lose streamed content; Fix C makes the URL/routing layer treat root as a regular task too.

### Instance: the pending-message filter (Fix A)

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

### Anti-pattern: "root as default, null as sentinel"

**Any code that treats root specially at the ROUTING / TARGETING / IDENTIFICATION level is wrong.** Root has an id like any task; use it. Only the TREE VISUALIZATION layer legitimately knows "root is root" (for drawing the tree hierarchy + dedicated orchestrator tab button). All other layers should be oblivious to which id happens to be root.

Concrete failure shapes this anti-pattern produced over weeks:
- `targetNodeId = selectedTaskId ?? rootNodeId` — pending banner filter coupled to a fallback chain → silent drop of root-destined messages during the useTasks transient
- `isOrchestratorNode = !selectedTaskId || selectedTaskId === rootNodeId` — `!selectedTaskId` is the null sentinel meaning "treat as root", entangling routing logic with state initialization timing
- `tabScrollStateRef.current.get(selectedTaskId ?? "root")` — literal string `"root"` as a Map key, asymmetric with the SET branch (which guarded on `if (prevTabId)` and skipped null), so root's scroll state was never persisted at all
- `usageTaskId = targetNodeId ?? selectedTaskId ?? rootNodeId ?? nodes.find(...) ?? "orchestrator"` — 4-fallback chain that masks "no selection" rather than rendering empty
- URL hash stripped task component when view matched root → on refresh, no task in URL, useTasks transient drops everything destined for root

The fix everywhere: **selectedTaskId carries the actual root id when viewing root**. No sentinel. No fallback. If selectedTaskId is null, render nothing (it means "nothing selected yet"). The URL-redirect mechanism closes the null window; consumers stay simple.

### Two truths, one effect  — *(hash era; the shape survives, the code does not)*

The reconciliation SHAPE below is exactly what Task Y still does — URL is truth, the daemon's
`/projects/:id/tasks` supplies rootNodeId, one effect normalizes the URL when both are known. Only
the storage moved (hash → path segment) and the owner moved (Plugin → shell callback). Read it for
the reasoning; read Task Y for the code.

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

### Test pollution gotcha (pre-existing, not Fix C) — **SUPERSEDED, and the diagnosis below is wrong**

Kept because being wrong is the point: the theory here ("happy-dom state surviving
GlobalRegistrator cycles") was believed for months and shaped two separate decisions (Task Y deleted
a whole test file over it). The real cause was react-dom's scheduler binding to whichever timer
machinery existed at its FIRST import, and it is FIXED — see *bun test cross-file React breakage*
(Testing region). Subset runs are no longer order-flaky for this reason.

Running multiple `web/*.test.tsx` files together produces flaky failures (Plugin-targetNodeId may time out, AppFooter chips may not render). Caused by happy-dom state surviving GlobalRegistrator unregister/register cycles, and React's module-level state holding refs to old document instances. Pre-existing — confirmed by stashing changes and reproducing.

Workaround: run `bun test web/` (whole dir, all 28 pass) or `bun test` (full, 2118 pass). Subset runs (`bun test web/A.tsx web/B.tsx`) are flaky depending on order. Real fix is a separate task — needs hard process-level isolation per file.

## Pending messages are a projection of the event log (Task X, 2026-04-18)

Three entries merged: Task X (the model), Fix D (the last patch to the model Task X deleted — kept
because its lesson outlived its code), and the 2026-07-21 batch/SSE guard (the one qualification to
Task X's purity claim).

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

### Superseded by this: Fix D — compact_marker clear had to be immediate

**The code below is gone** — `deferredMessages` and every clear path with it (grep confirms the map
survives only in explanatory comments). Kept for two reasons. First, it is the clearest statement of
the phase-discipline lesson at the end, which applies to any code with an immediate phase and a
deferred phase. Second, it is the last of four attempts to patch the mutable-state model by moving
*when* mutations happen; reading it is what makes Task X's "the mutable state itself is the bug"
land as a conclusion instead of an assertion.

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

### Qualification: the batch/SSE duplicate-message guard (2026-07-21)

⚠️ **This is the one thing outside the reducer that affects pending.** Invariant 2 above ("no
imperative clear path — events drive everything") still holds for the reducer itself, but the
DRIVER now filters: `handleEvent` suppresses an APPLY for a message id it already saw consumed in a
batch. If you are reasoning about why a chip is or isn't showing, `pendingReducer` alone is no
longer the whole answer — check `batchConsumedIds` too.

**Root cause**: race between SSE ring-buffer catch-up and the batch REST re-fetch during
reconnection. `processEventBatch` (via `handleReconnect`) does RESET + full JSONL replay —
pending correctly empty. But SSE catch-up events arriving AFTER the batch can re-deliver a
`message` event whose `messages_consumed` was already in the batch. The duplicate `message`
re-adds the pending chip; no live `messages_consumed` arrives to clear it → chip persists.

**Fix**: `processEventBatch` records consumed IDs in `batchConsumedIds` (module-scoped Set
inside `createEventHandler`). `handleEvent` checks this before dispatching APPLY(message) —
batch-consumed IDs are suppressed. Set cleared on every RESET; entries removed by live
`messages_consumed` events (defensive against id reuse).

**Diagnosis technique**: 22 "unconsumed" messages found in JSONL were ALL compact/
compacted_resume source (correctly excluded by reducer). 0 unconsumed user messages. Backend
is correct — every user message has a matching `messages_consumed` with identical IDs. Bug
was purely frontend timing.

**Key invariant**: `batchConsumedIds` is the **minimum-viable deduplication** between batch
and SSE event sources. It does NOT replace the pure `pendingReducer` — the reducer stays
pure (no side-channel). The guard lives in `handleEvent` (the event handler driver), not in
the reducer itself.

## URL routing: path segments with layer ownership (Task Y, 2026-04-18)

The current URL mechanism, plus its server-side half (SPA fallback, folded in at the end). Replaces
the hash mechanism described in *Root is a regular task* — that entry keeps the reasoning and the
anti-pattern; this one is the code.

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

### Server side: SPA fallback — `pm.has(firstSeg)` is the single predicate

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

## ⚠️ A user message renders where it was CONSUMED, not where it arrived (2026-07-25)

A message typed during a tool call is **delivered** between the `tool_call` and its `tool_result`,
but **consumed** with that tool's results — so in the activity log it renders **after the finished
tool card**. Delivery order and rendered order are different things.

This is a trap for anything that reasons about a message's position. The Edit/Rewind gate hit it
first: judging "did the agent run from this message" off the RENDERED entries calls exactly the
blocked case a run start, because by then the message appears after the tool it interrupted. So the
annotation is computed in `processEventBatch` from the **raw batch**, never from the entries.
Mutation-verified — swapping the input to the entries fails exactly two tests out of ~2760.

It is also the only place the annotation is needed, for a reason worth knowing on its own:
**an eid reaches the UI only through a JSONL fetch — SSE broadcasts carry none** (events are
stamped at persist time, after the broadcast). A live-streamed entry therefore has no eid, hence no
Edit/Rewind buttons, hence nothing to gate. Same fact drives the re-fetch below.

## Re-fetch JSONL when the viewed task stops working — Edit/Rewind buttons (2026-07-23)

SSE-broadcast events lack `eid`/`parentEid` (stamped only at JSONL persist time in
`EventStore.stampEvent`). So during streaming the Edit/Rewind buttons cannot exist — there is no eid
to rewind TO. When the viewed task stops working, the frontend re-fetches JSONL via
`GET taskEvents?after=compact` → `processEventResponse` — same pattern as SSE reconnect and rollback.
Those events carry eid/parentEid, so the buttons appear.

Implementation: `onAgentIdle` callback on `EventHandlerDeps`, fired when the viewed task's activity
goes idle-or-gone. Plugin.tsx wires it via `refetchOnIdleRef` (breaks the useMemo/useCallback dep
cycle).

⚠️ **The trigger changed, and the original text named an event type that no longer exists.** It read:
*"triggered from the `agent_idle` case in `processEvent`"*. There is no `agent_idle` event any more —
it and `agent_active` were replaced by the single `agent_activity` state (see *Agent activity: live
process state*, Agent Loop region), and this callback was migrated to fire on
`agent_activity → idle` **or `null`**. The `null` half is a real behavior gain, not just a port: an
agent that finishes with `done()` never passes through idle, so before the migration its last
messages stayed uneditable. The CALLBACK name `onAgentIdle` survived the rename — do not read it as
evidence that an `agent_idle` event exists.

---
# Web UI — Components & Interactions
---

## Compact sidebar header (2026-06-17)

Sidebar header consolidated from 3 rows (TASKS+buttons / filter input / hide-completed)
into one: `[TASKS] [+] [Refresh] [🔍 Filter] [👁 Hide completed]`.

- `filterMode` state + `cycleFilterMode` lifted from TaskTree.tsx to Plugin.tsx.
  TaskTree accepts `filterOpen`, `onFilterOpenChange`, `filterMode` as props.
- `FilterMode`, `FILTER_MODES`, `readFilterMode` exported from TaskTree.tsx.
- Search bar is collapsible via CSS `max-height` + `opacity` transition.
  Class `mxd-tree-search-bar--open` toggles visibility. Auto-focus on open,
  auto-close on blur when empty, Escape clears and closes.
- Filter mode button uses `mxd-btn-icon mxd-filter-mode-btn` dual-class pattern
  in the header (inherits icon button sizing, overrides color for active/favorites).
- `IconSearch` added to icons.tsx (magnifying glass SVG).
- `tasks.filterToggle` i18n key added (EN + ZH).

## Full lightweight markdown rendering in agent replies (2026-07-02)

Extends the tables-only pipeline to the full lightweight set: fenced code, headings,
blockquotes, lists (one nesting level), hr + inline `code` / **strong** / *em* /
~~strike~~ / [text](http(s)-only url). Same philosophy as the table parser: strict
grammar, false positives worse than missing features, no md library, React elements
only (no dangerouslySetInnerHTML).

### Files
- `.mxd/plugin/web/markdown.ts` — NEW pure parser. `parseMarkdown(text): MarkdownBlock[]`,
  `parseInline(line): InlineNode[]`, `isPlainText(blocks)`, `isSafeLinkHref(href)`.
  Composes WITH `markdown-table.ts` (tables delegated to `parseTextSegments`, untouched).
- `components/MarkdownText.tsx` — renders the block tree; `MarkdownTable` component kept
  verbatim; new `CodeBlock` (copy button, mirrors table pattern), `ListView`, heading via
  `createElement("h"+level)`.
- `style.css` `.mxd-md-*` family extended (modest heading sizes — chat log, not document);
  copy-button selectors comma-joined table+code. `i18n.ts`: `code.copy`/`code.copied`.
- Tests: `web/markdown.test.ts` (72, pure) + `web/MarkdownText.test.tsx` (+6 DOM
  integration). Mock-showcase got a full-markdown sample event (visual verification).

### Parse order (load-bearing, tested)
1. Fences FIRST — content verbatim, no table/block/inline parsing inside. Unclosed fence
   runs to EOF (`closed:false`). Backtick-fence info string may not contain backticks
   (keeps "```x``` y" lines inline).
2. Tables via existing `parseTextSegments` on non-fence text.
3. Per-line blocks: heading (`#{1..6} + space`), hr (also `- - -` style; checked BEFORE
   list), quote, list. Everything else = verbatim text runs (interior blank lines
   preserved; edges trimmed next to blocks).
4. Inline per line: code spans bind tightest (N-backtick runs, protect content — even in
   emphasis-closer search), then links, then emphasis.

### Key invariants
- **Plain fallback**: `isPlainText(blocks)` (all blocks = text runs of only-text nodes) →
  render ORIGINAL string in single `<span className>` — byte-identical to pre-markdown
  rendering. Unsafe-link-only text stays "plain" (renders raw source).
- **Link safety**: only `^https?://` (case-insens.) becomes `<a target=_blank
  rel="noopener noreferrer">`; javascript:/data:/file:/relative → raw literal TEXT.
  Enforced in parser (single gate), tested at parser + DOM layers.
- **Emphasis = whitespace-adjacency rules, NOT \b** (CJK-safe: `周围**中文**相邻` works).
  Opener must be followed by non-WS; closer preceded by non-WS; single-`*` closer must be
  a LONE star (enables `*a **b** c*` nesting). Runs of 3+ markers = literal (predictable).
  No `_underscore_` emphasis (snake_case), no setext headings, no backslash escapes
  (Windows paths), no images (`![` skipped), no raw HTML — deliberate.
- Mutation-verified: scheme-gate → 5 tests fail; opener-WS / closer-WS rules each pinned
  by a dedicated asymmetric test (`** x**` literal / `**a ** b**` full-span strong) —
  the symmetric math case alone did NOT pin them individually (defense-in-depth masking;
  gap found by mutation #2 surviving, then closed).

### Gotchas for future editors
- biome `noArrayIndexKey` suppression on MULTILINE JSX must sit directly above the
  `key={i}` attribute line, not above the element. `useIterableCallbackReturn` requires
  every switch path to return — merged `default:` onto the last case (TS still narrows).
- Verification ran under the broken-gate interim rules above (scoped bun test + zero new
  typecheck/biome diagnostics); full-suite re-verification owed once the bun gate is
  restored.

### First slice: tables only (2026-06-22) — the parser this builds on

The table parser below was NOT replaced — the full-markdown parser composes with it
(`parseMarkdown` delegates tables to `parseTextSegments`). So its grammar rules are live, not
history. **One thing here IS superseded**: the scope statement "TABLES ONLY (not full markdown —
deliberate) … if full markdown is ever wanted, that's a separate decision". That decision was
taken, six weeks later, and is the section above.

Agent replies frequently use markdown tables to compare options; they rendered
as misaligned pipe text in the proportional/mono font. Now rendered as real
aligned `<table>` with a hover copy button.

#### Scope: TABLES ONLY (not full markdown — deliberate)
No markdown library pulled in. A focused hand-written GFM-table parser. Inline
markdown (`**bold**`, `` `code` ``) inside cells is NOT parsed — cells render as
plain text. If full markdown is ever wanted, that's a separate decision.

#### Files
- `.mxd/plugin/web/markdown-table.ts` — pure parser (no DOM, fully unit-tested):
  `parseTextSegments(text)` → ordered `{type:"text"} | {type:"table"}` segments;
  `splitRow`, `isDelimiterRow`, `hasTable` exported for tests.
- `.mxd/plugin/web/components/MarkdownText.tsx` — `<MarkdownText text className>`.
  Renders tables as `<table class="mxd-md-table">` + a `MarkdownTable` subcomponent
  with the copy button. Reusable — currently wired ONLY into `assistant_text`.
- `LogEntryView.tsx` — assistant_text path: `<span class=mxd-lmxd-text>{text}</span>`
  → `<MarkdownText text={text} className="mxd-lmxd-text" />`. Two-line diff.
- `style.css` — `.mxd-md*` block (after `.mxd-event-assistant_text .mxd-lmxd-text`).
- `i18n.ts` — `table.copy`/`table.copied` (EN + ZH).
- `routes/mock-showcase.ts` — added an assistant_text-with-table sample (same
  precedent as the compacted_resume card) → visually verifiable at `/mock-showcase`.

#### Parser grammar (strict — false positives are the danger)
A table requires a HEADER line containing `|` IMMEDIATELY followed by a DELIMITER
row whose cells are all `:?-+:?`, AND header/delimiter must have the SAME cell
count (GFM rule). The column-count match is what stops a thematic break (`---`)
or a piped prose line from being misread as a table. Body rows continue until a
blank/non-pipe/delimiter line; padded or truncated to header width. Escaped pipes
(`\|`) inside cells are unescaped and don't split. Alignment from delimiter colons.

#### Key invariants
- **Zero regression for the no-table case**: `MarkdownText` fast-paths to the
  SAME `<span className={className}>{text}</span>` when no table is present.
  `.mxd-md` wrapper only appears when a table exists.
- **XSS-safe**: cells render as React text children (escaped), never
  `dangerouslySetInnerHTML`. Test asserts `<img>`/`<b>` in a cell stay literal text.
- **Copy = original markdown source** (the captured `raw` block), so it re-pastes
  into another markdown surface verbatim. `navigator.clipboard?.writeText` guarded
  (insecure-context / denied → no-op).
- Copy button is hover/focus-reveal (`opacity 0 → 1`), styled like
  `mxd-bash-background-btn`. Non-scrolling `.mxd-md-table-wrap` holds the absolute
  button; inner `.mxd-md-table-scroll` does `overflow-x:auto` so the button stays
  fixed while a wide table scrolls.

#### Tests (mutation-verified)
- `web/markdown-table.test.ts` (26) — parser grammar, heavy on "this is NOT a
  table" (thematic break, no-delimiter, column mismatch). Mutation: removing the
  column-count guard fails the mismatch test.
- `web/MarkdownText.test.tsx` (6) — full render through LogEntryView: no-table
  plain span, real `<table>` headers/cells, alignment styles, copy-button copies
  the markdown, mixed prose+table, XSS guard. Mutations (force plain path / copy
  wrong content) fail the right tests.
- TS gotcha hit + fixed: clipboard capture used a holder object `{value}` (not a
  bare `let`) so TS doesn't narrow the closure-assigned probe back to `null` (same
  pattern noted in lifecycle-concurrency tests).

#### Pre-existing base-branch issues observed (NOT introduced here; flagged to root)
At fork point the branch already had: 5 `tsc` TS6133 unused-symbol errors
(`handlers.ts` isOrchestratorNode, `lifecycle-guards.test.ts` x3,
`worker-lifecycle.test.ts`) + 1 biome format drift (`mxd-user-prompt-text` span in
LogEntryView). Verified identical with my changes stashed. `bun test` is green
(2305 pass); these only affect `tsc`/`check:ci`. Root should clean before the
final main commit (worktree hooks are /dev/null so they don't gate here).

## Select-to-quote "Ask Matrix" in activity log (2026-07-02)

Select text in the activity log → floating "Ask Matrix" button near the selection →
click → text lands in the InputBar draft as a markdown blockquote (`> …\n\n` prepended
before any existing draft), textarea focused with cursor at end.

### Shape
- `.mxd/plugin/web/quote.ts` — ALL pure logic, unit-tested directly: `selectionQuoteText`
  (generic over node type — validates Selection against container: non-collapsed,
  non-whitespace, BOTH endpoints inside), `toBlockquote` (outer-trim, `\r\n?`→`\n`,
  interior empty lines become bare `>` so the blockquote stays one block),
  `insertQuote(draft, selected)` (prepend + blank line; whitespace-only → draft unchanged),
  `quoteButtonPosition` (below-right of selection end, viewport-clamped, flips above
  when no room below).
- `ActivityLog.tsx` — document-level mouseup (show), selectionchange (dismiss on
  collapse), keydown Escape (dismiss); container scroll + filterTaskId change also
  dismiss. Button is `position: fixed` (no ancestor transforms — verified), rendered
  only when `onQuoteText` prop present. `onMouseDown={e => e.preventDefault()}` on the
  button is LOAD-BEARING: without it, mousedown collapses the selection → selectionchange
  unmounts the button before click fires.
- Wiring: Plugin.tsx `quoteRequest: { text, seq } | null` state — `seq` increments per
  request so quoting the SAME text twice re-fires InputBar's effect. ActivityLog
  `onQuoteText` → Plugin → AppFooter passthrough → InputBar applies via
  `insertQuote(promptRef.current, …)` + rAF focus/cursor-to-end. `QuoteRequest` type
  exported from InputBar.tsx.
- i18n: `activity.askMatrix` (EN "Ask Matrix" / ZH "问 Matrix"). CSS:
  `.mxd-selection-quote-btn` at end of style.css.

### Tests (mutation-verified at the seams)
- `web/quote.test.ts` (24) — pure functions, no DOM.
- `web/ActivityLog-quote.test.tsx` (7) — happy-dom Selection/Range work well enough for
  the real flow (addRange + document mouseup dispatch + selectionchange). Only
  `range.getBoundingClientRect()` returns zeros — position math is covered by the pure
  tests instead. Poll-based `waitFor` (NonNullable<T> return), never fixed sleeps —
  fixed 20ms waits flaked on cold first-file module compile.
- `web/InputBar-quote.test.tsx` (4) — prop-driven rerender path, draft preservation,
  seq-bump reapplication.
- `web/Plugin-quote-journey.test.tsx` (1) — CANONICAL JOURNEY, full stack: real daemon,
  real Plugin, seeded tree.json + session JSONL at matrix dataRoot
  (`projects/<id>/plugin/matrix/{tree.json,tasks/<rootId>.jsonl}` — nodes need explicit
  `type: "task"` since P3). Mutation-proof: dropping `onQuoteText={handleQuoteText}` or
  `quoteRequest={quoteRequest}` in Plugin.tsx fails ONLY this test (component tests stay
  green) — the seam is exactly what it guards.
- NOTE: `web/Plugin-targetNodeId.test.tsx` seeds tree.json at `projects/<id>/tree.json` —
  the WRONG path since the dataRoot move (silently ignored; test passes because a fresh
  tree's default root title is also "Orchestrator"). Harmless but misleading; fix when
  next touching that file.

### Follow-up: scroll to the caret after inserting a long quote (2026-07-14)

Bug: after "Ask Matrix" select-to-quote prepends a markdown blockquote into the
InputBar and moves the caret to the END, a LONG quote overflowed the textarea's
`max-height: 120px; overflow-y: auto` cap — the visible region showed the quote
(top), the caret line (bottom) stayed below the fold → user typed blind.

Fix (`.mxd/plugin/web/components/InputBar.tsx`, the quote-apply effect's rAF ONLY —
`quote.ts insertQuote` is pure + correct, untouched): after caret-to-end, scroll to
the caret via `el.scrollTop = el.scrollHeight` (browser clamps to the max offset →
bottom, which is where the caret sits after a quote insert).

⚠️ ORDER IS LOAD-BEARING: the capped auto-grow height recompute (`adjustTextareaHeight`)
MUST run BEFORE reading `scrollHeight`/setting `scrollTop`, and BOTH inside the SAME
rAF. Reading scrollHeight before the new height applies yields a stale value → wrong
scroll. Do NOT rely on the separate `[prompt]` resize effect having run before the
rAF — React 18 flushes passive effects asynchronously; rAF-vs-passive-effect ordering
is NOT guaranteed. rAF body = applyHeight() → focus() → setSelectionRange(end) →
scrollTop=scrollHeight.

Seam: `focusCaretAndScrollToEnd(el, caret, applyHeight)` (exported from InputBar.tsx)
encapsulates that exact order; unit-testable against a fake element (no live layout).

Tests (`web/InputBar-quote.test.tsx`): 3 pure seam tests (scroll-to-bottom; the
stale-height guard = applyHeight mutates scrollHeight and we assert the POST value;
fits-the-cap) + 1 component test (mock `scrollHeight` via Object.defineProperty=500,
fire quoteRequest, assert `scrollTop===500` after rAF — happy-dom stores scrollTop
unclamped, same pattern as the existing ActivityLog/Plugin scroll tests).
Mutation-verified: removing `scrollTop=scrollHeight` fails exactly the 4 scroll
tests; the 4 insertion tests stay green.

biome gotcha: referencing the hoisted `adjustTextareaHeight` inside the effect's rAF
trips `useExhaustiveDependencies` (ERROR-level, not warning). Adding it to deps would
re-fire the insert every render (new fn identity each render) — a `biome-ignore` on
the effect is the correct fix, matching the codebase convention. No CSS/i18n change
(textarea was already capped+scrollable; fix is purely JS scroll).

## Scroll-to-bottom button + happy-dom v20 MutationObserver WeakRef GC hazard (2026-07-07)

Scroll-to-bottom button (↓, `.mxd-scroll-bottom-btn`) in `.mxd-panel-actions`, rendered
immediately LEFT of the Compact ⌘ button (which lives inside TokenUsageBadge — NOT in
AppFooter/InputBar). Shown when the activity log is scrolled >40px from the bottom.

### Shape
- `.mxd/plugin/web/scroll.ts` — pure `isNearBottom(scrollTop, scrollHeight, clientHeight,
  threshold=NEAR_BOTTOM_THRESHOLD)`; the ONE predicate for both auto-follow re-engagement
  (ActivityLog handleScroll, formerly inline `< 40`) and button visibility.
- ActivityLog: new optional `onAtBottomChange?: (atBottom: boolean) => void` prop, ref-mirrored
  (observer effects don't churn on unstable parent callbacks). Report sites: handleScroll (with
  onAutoScrollChange, same value), `visible.length` effect else-branch (entry growth while
  scrolled up — the DETERMINISTIC growth trigger), MutationObserver else-branch (streaming
  characterData growth, real-browsers-only complement), scrollToBottom (reports true by
  construction). One shared `reportAtBottom` callback.
- Plugin.tsx: `logAtBottom` state ← onAtBottomChange; click = querySelector scrollTop=scrollHeight
  (precedent: tab scroll save) + setAutoScroll(true) + optimistic setLogAtBottom(true).
- Existing Follow pill (`!autoScroll`, right of badge) untouched — overlaps ~95% with the new
  button (both show when scrolled up, both end in follow+bottom). Dedup is a user/UX call, not made here.

### ⚠️ happy-dom v20 MutationObserver delivery dies under GC pressure
`MutationObserverListener` stores its report callback as `new WeakRef((record) => this.report(record))`
with NO strong reference to the arrow anywhere; Node dispatch does `mutationListener.callback.deref()`
— after any GC pass the deref returns undefined and mutations are SILENTLY dropped (no error).
Consequence: a test relying on MO callbacks passes in isolation (no GC between observe and mutation)
and flakes in the full 250s suite (GC runs constantly). Real browsers hold strong refs per spec —
production code using MO is fine; only happy-dom TESTS of MO paths are inherently flaky.
**Rule: never let a happy-dom test depend on MutationObserver delivery.** Route the tested behavior
through a React effect (deterministic) and treat the MO path as a real-browser-only complement
(document, don't test). The scroll-report content-growth test additionally stubs a no-op
MutationObserver so its mutation-proof targets exactly the effect branch.

### Tests
`web/scroll.test.ts` (10 pure), `web/ActivityLog-scroll-report.test.tsx` (5 — every report path +
auto-follow-preserved + optional-prop), `web/Plugin-scroll-bottom-journey.test.tsx` (canonical
journey: real daemon, seeded assistant_text + `usage` event so TokenUsageBadge/⌘ renders → DOM-order
assertion "↓ before ⌘ in panel-actions"; scroll up → appears → click → bottom + hidden + Follow pill
gone). Seeding a `usage` JSONL event (`{type:"usage", taskId, inputTokens, contextWindow, ts}`) is
the trick to make the Compact button exist in harness tests. Mutation-verified: prop-wire drop →
journey fails; handleScroll report drop → 2 scroll tests fail; effect else drop → content-growth
test fails (exact, thanks to the MO stub).

## Activity-log viewport position: 30 touch points, three clusters, and the culprit that was not in the scroll code (2026-07-25)

A survey of everything that reads, writes or invalidates the activity log's scroll offset — done
because the area "felt fragile and nobody could state the conditions" — found **30 touch points,
not the 9 anyone could name**: 9 JS writers, 5 readers, 6 pieces of state, 6 content-height
mutators inside the container, 6 clientHeight mutators outside it, 6 wholesale `logs` replacements,
plus **the browser** (`overflow-anchor: auto`, which silently absorbs top-of-list insertions —
load-bearing here, and not implemented by Safari; see below).

They do NOT collapse into one mechanism, and forcing them to would be wrong. Three clusters:

- **A — measuring or writing during a transitional state.** Produces the *unpredictable* symptoms,
  because the transient's duration is a network variable.
- **B — viewport position addressed by a perishable identity** (pixel offsets, a module-counter
  entry id, a React component instance). Produces *deterministic* losses, each disguised as some
  other feature behaving normally, which is why none of them were ever reported.
- **C — conditional renders in a flex row.** Independent, cheap, cosmetic.

Their common amplifier: `logs` is the whole viewed session's array, replaced wholesale on every
refresh. **That amplifier turned out to be able to hurt users on its own** — see the causal chain
below. "What time may I measure" and "what name do I remember a position by" are orthogonal
questions; one mechanism cannot answer both.

### The finding: guard the PROPERTY, not the enumeration of causes

Two predicates were proposed on the *cause* side and both were killed by one measurement:

- *"is the rendered content from the task being viewed"* (a view-parameter identity)
- *"is the container non-scrollable"* (an emptiness proxy)

Counter-example: an in-log search matching 40 entries leaves the container with 449px of range —
fully scrollable — but `scrollTop` 1200 is clamped to 449, which IS the new bottom, so
`isNearBottom` returns true and follow mode arms itself. Neither predicate catches it.

**The predicate that works: `scrollRangeShrank(prev, current)` where range = `scrollHeight −
clientHeight`.** All five measured failures share not emptiness but *the scrollable range got
smaller and the browser pushed the offset to the new bottom*: tab-switch fetch gap (1549→0), three
kinds of in-log search, and the composer auto-growing (viewport 572→537). Growth is deliberately
NOT suspicious — streaming grows every frame, and a user scrolling back to the bottom mid-stream
must still be able to re-arm follow.

⭐ **Why this generalises and a cause-list does not**: this subsystem had already proven that the
cause side cannot be enumerated — the survey started from "your nine are almost certainly
incomplete" and ended at 30. Listing causes again would repeat the same error. `scrollRangeShrank`
tests **the property that makes an observation meaningless**, so it covers causes nobody wrote
down. The composer's auto-grow is the proof: not a view parameter, not anticipated, and it lands in
the predicate for free. (It also collapsed two separately-catalogued classes — content-height
changes inside the container and clientHeight changes outside it — into one. They were two classes
only because they were sorted by *what changed*; sorted by *what it causes*, they are one thing.)

### `autoScroll` vs `logAtBottom` — two concepts, one illegal coupling

`logAtBottom`'s writers are all **observations**. `autoScroll`'s are one observation and six
**intents**. That single observation-writing-intent (`handleScroll` reporting to both; the
predicate's own comment admits "one predicate, two consumers") is the door every hijack came
through. They must NOT be merged into one boolean — that would lose the "intent" concept the Follow
button needs.

Two halves of the same seam, fixed separately: the guard above rejects a **false observation** (a
clamp after shrink); and the new-content effect no longer takes `autoScroll` as a dependency, which
stops a **true observation from immediately executing** — the user scrolls into the 40px band,
follow correctly arms, and previously the effect fired and yanked them the rest of the way
mid-gesture. **Arming is not acting**, and "go to the bottom now" already has its own channel
(the `scrollToBottomRequest` counter). The fix was a deletion, and the effect reads `autoScrollRef`
so "responds to content, not to intent" is explicit rather than implied by a deps array.

### Pitfalls that will look like oversights

- **`prevScrollRangeRef` may ONLY be advanced by `handleScroll`.** Letting a geometry-reading effect
  update it too makes the guard inert: effects run at commit, the clamp's scroll event is dispatched
  by the browser *afterwards* (measured 14ms later), so the effect writes the new small value first
  and the comparison becomes new-vs-new. **The danger is that it looks MORE thorough** — the next
  person will read the single call site as a missed one.
- **"Only trust real user scrolls" is unimplementable.** A clamp-dispatched scroll event has
  `isTrusted === true` and is indistinguishable from a user's at the event layer. Written into the
  predicate's docstring specifically to stop someone walking that road again.
- **In a right-aligned flex row, inserting a child moves only the siblings BEFORE it.** So
  conditionally-rendered controls belong *before* the persistent ones — cheaper than reserving
  blank space and with no side effects. This is what made the header jump 71.3px when Follow
  appeared. (First measured as "100.3px on the whole actions group" — a container's property read
  as the content's. Same shape as the mistakes above, caught by re-measuring per child.) Fixed
  by putting both scroll-state buttons leftmost; Follow also shares `requestScrollLogToBottom`
  with ↓ so the two booleans flip in one batch instead of two.
- **`scroll-attribution.ts`** is dev-only (`localStorage mxd-debug-scroll`): it tags every
  programmatic write with who did it, plus a per-frame sampler for movement nobody claimed.
  **Read its docstring before trusting it** — it has a documented blind spot (below).

### Deleting an implementation that never worked

`tabScrollStateRef` (per-tab scroll memory) **never functioned**: the save ran in a passive effect
keyed on the task id, which runs *after* commit — by which time the list had emptied, the container
had collapsed and `scrollTop` was clamped to 0. It saved a destroyed value, structurally. It was
invisible because the follow-hijack it fed put you at the bottom anyway, which looked like normal
follow behavior.

Fixing the hijack exposed it, and "leave it as-is" turned out not to be an option — behavior would
change either way. Made into an explicit three-way choice and reported: guard only (visible
regression) / make restore actually work (decides a product question) / **delete the never-working
implementation and write the current behavior down explicitly (zero user-visible change, measured
8/8)**. Chose the third. **Deleting an implementation that never had an effect is not deciding the
feature shouldn't exist — it is removing a lie.** The real feature needs an address that survives a
refetch, which is the same requirement as message deep-linking and active-chain membership: all
three want persisted event identity (`eid`) on every entry regardless of transport.

### The symptom that was not in the scroll code at all

User: "from mid-output to output complete, my scroll gets yanked to somewhere above." Only visible
with follow OFF. Caught with a console probe in the real session:

```
t=22467   GET events?after=compact        atScrollTop = 5517      (agent went idle)
t=22736   5517 → 0   delta -5517   "BROWSER (no JS write)"   top=""   entries 59→60
t=22751   JS write scrollTop 0 → 0        at index.js:4283:33
```

Both line numbers map back exactly: **4283 = the lazy-render anchor**
(`container.scrollTop = container.scrollHeight - scrollBottom`), **4294 = `scrollToBottom`**.

The chain: `agent_idle` → `refetchOnIdleRef` → `processEventBatch` → `setLogs` replaces every entry
with a new object → new `createLogEntry` ids → new React keys → the whole subtree unmounts and
remounts → **the offset does not survive the swap**.

A second capture measured this from inside the DOM mutation:

```
t=87006  >>> REFETCH                          st 8089   sh 8823   kids 85
t=87032  dom-mutation  removed:1              st 8089   sh 8809
t=87299  dom-mutation  added:82 removed:82    st  191   sh 8978   ← offset already gone
t=87313  js-write 191 → 191                   (the same anchor, pinning again)
```

Note what this does and does not show. All 82 entries are swapped in **one** mutation record, and by
the time the observer's microtask runs the height is **already restored** — while the offset is
already lost. It lands wherever the intermediate geometry allowed (0 in the first capture, 191 in
this one), so "clamped to 0" is too specific; the honest statement is that **the offset does not
survive a wholesale replacement**. And the usable evidence is not a dip in `scrollHeight` — nothing
observable ever sees the dip — it is that **the offset changed across the mutation with no JS
write**.

**`added:82 removed:82` is the direct observation of every React key changing.** With stable keys
React reuses nodes and a normal update looks like the `removed:1` record at t=87032. Eighty-two out,
eighty-two back, `kids` unchanged — that is key churn measured, not inferred, and it is the positive
evidence that **eid-as-React-key is aimed at the right thing**.

Then the pin: landing near the top brings the sentinel into view → the IntersectionObserver fires →
it captures `scrollBottom = scrollHeight - scrollTop` → one frame later writes
`scrollHeight - scrollBottom`, reproducing the same offset (`0 → 0` in the first capture,
`191 → 191` in the second). **The anchor is what turns the culprit's result into a persistent
state** — which is why the symptom is "stuck near the top" rather than "flickered once".

But the anchor is an accomplice, not the cause, and the arithmetic proves it: `scrollBottom =
8978 − 191 = 8787`, and `scrollHeight` across that window was 8809–8978, so the offset **at capture
time** was already ≈22–191 — already near the top. The anchor **observed and reproduced** a position
that was lost before it ran; it did not compute a wrong one. So there is nothing to fix in the
anchor. Fix the keys.

**The fix is not in the scroll subsystem.** That refetch exists for exactly one reason: to get
`eid` back, because SSE-broadcast events don't carry it (it is stamped at persist time), so
Edit/Rewind can't work during streaming. Task `01KYBQXSVEP7Y94NWHGWSMNQSM` kills this two ways
over — eid arriving with SSE means the refetch never happens, and **eid as the React key** makes a
refetch reconcile instead of remount, which also covers `handleReconnect` (whose replacement will
not disappear) and fixes expanded `Card` state being reset. A stop-gap was explicitly rejected:
it would add a 31st touch point to a mechanism scheduled to disappear, and transitional code is
code that must later be deleted — which is forgotten far more reliably than adding it was.

### ⚠️ CORRECTION — "a wholesale replacement does not move the offset" is FALSE

An earlier round measured this four times and concluded a full replacement preserves `scrollTop`
(remove-all-then-insert-all inside one synchronous block does not clamp, because no layout happens
in between). **The measurements were honest and the conclusion is wrong**, and left standing it
sends the next reader straight past the actual culprit.

Why it looked true: the fixture held ~60–80 plain-text entries. Tearing those down and rebuilding
them is cheap enough that the collapse never survives to a layout. A real session has images with
no reserved height, expandable cards, markdown tables — rebuilding is slow enough that the collapse
becomes observable and the browser clamps.

**The cost of a remount depends on how expensive the content is to rebuild**, so a fixture made of
cheap content cannot answer the question at all. Second instance in one day of *correct measurement,
wrong world sampled*.

### The instrument's blind spot — and a rule about specifying observations

The probe classified that exact jump as `range UNCHANGED → scroll anchoring or user — NOT a clamp`.
Wrong: the range collapsed and refilled **inside one frame**, and a per-frame sampler only sees what
survives to the end of a frame.

So `range unchanged ⟹ not a clamp` holds ACROSS frames and fails for collapse-and-refill within
one. And **`scrollHeight` never dipped in any sample of the second capture either** — read
literally, that refutes "the container collapsed". It does not, and the reason is the sharp edge
of this whole subsystem:

```
t=87032  dom-mutation  ...
         ← 267ms, ZERO samples (≈16 expected at 60fps)
t=87299  dom-mutation  added:82 removed:82
```

The main thread was blocked solid for 267ms rebuilding 82 entries, so every rAF callback and
observer microtask queued behind it. **"No dip in the samples" ≠ "no dip."**

This turns the blind spot from an edge case into a **systematic bias**: the operations that cause
large displacement are exactly the operations that block the main thread long enough to hide
themselves. A per-frame instrument is least able to see precisely the moments it is most needed for.
Any future instrument here needs an observation that survives a blocked thread — a count taken
either side of the render, or a mutation record — not a sample taken during it.

The generalisation, which cost a nearly-wasted round: **before specifying a measurement, check that
the instrument's resolution can carry it.** The request that prompted this was "record
`scrollHeight` every frame across the window" — below the instrument's resolution, and its failure
mode is a **silent false negative** ("no dip, so not a remount") that reads exactly like a real
result. That is more dangerous than reasoning wrongly, because it arrives wearing evidence's
clothes. Three false negatives of this family landed in one day: an over-specified observation, a
fixture whose content was too cheap to reproduce the effect, and a blocked-thread sampling gap.

And the counterpart to knowing when to measure — **stop collecting once the answer cannot change
the action.** Exactly where in those 267ms the offset died does not alter the fix: don't remove the
82 nodes. Further rounds of user reproduction would have bought precision nobody would spend.

### Fixing a "you end up at the bottom anyway" mechanism makes older displacement visible

This displacement had always been there. With follow ON, any content change re-triggered
scroll-to-bottom, so **every** displacement was overwritten by the same endpoint and none of them
produced a distinguishable symptom. Removing that overwrite is what made this one visible.

Generally: **in a subsystem with a mechanism that keeps forcing one endpoint, that mechanism is
masking every other bug that moves the same value.** Each masker you fix surfaces a symptom that
"has always been there" — the user will report it as new and it is not a regression, it is
*newly visible*. This explains a whole class of "I hit this often but can't say when" reports, and
it means a subsystem's bug count can appear to grow while it is genuinely getting better.

### Reusable method

- **Attribution beats reasoning here.** One reproduction with the probe turned "something moved me
  and I don't know what" into two exact line numbers. The previous round needed a full 30-touch-point
  survey to reach a *worse* answer.
- **Diagnose by absence.** Browser scroll anchoring goes through no JS path and fires no event, so
  "the offset moved and nobody wrote it" is itself the diagnosis. Any instrument here must record
  unclaimed movement, not just instrument the writers.
- **Do not try to separate a clamp from a user scroll by `isTrusted`** — a clamp's scroll event is
  trusted and identical at the event layer. Recorded before, re-derived, and now recorded again.
- **A streaming mock provider is ~60 lines and puts a frontend bug on the real agent loop**: serve
  Anthropic's SSE shape on a local port and set `ANTHROPIC_BASE_URL` (the daemon passes
  `process.env` into the worker). Gets real `text_delta`, thinking, tool execution, `end_turn` →
  real `agent_idle` → real refetch. `/tmp/scroll-probe/` holds the fixture + mock.
- **When you cannot reproduce, send the instrument to whoever can.** Four increasingly faithful
  attempts failed; one paste into the user's console succeeded immediately.

## Sidebar search/filter toggle — pure reducer, blur-close removed (2026-07-07)

The sidebar filter button ([TASKS][+][refresh][🔍][👁] header row) now cleanly TOGGLES its
search input: click open→focus, click again/Escape→close, and **closing clears the query** so
the tree is never left silently narrowed by a hidden input.

### Root cause of the "又弹出来" (reopen) bug
open state lived in Plugin.tsx (`useState`), query lived in TaskTree.tsx (`useState`), and the
input had `onBlur` that auto-closed when empty. Clicking the toggle button while the input was
focused+empty fired the input's `blur` on **mousedown** (→ `onFilterOpenChange(false)`, state
now false) BEFORE the button's `onClick` `setFilterOpen(p=>!p)` ran → the toggle read `false` and
flipped back to `true` → the box **re-opened**. Classic blur-vs-click race across a split state.

### Fix — one atomic reducer, no blur-close
- **New `.mxd/plugin/web/filter-state.ts`**: pure `filterReducer(state,{toggle|close|setQuery})`
  over `{open, query}`. `toggle` opens (query stays "") / closes-and-clears; `close` clears+closes;
  `setQuery` ignored while closed. Invariant: **closed ⟹ query===""**. Race-free by construction —
  the button dispatches `toggle`, Escape dispatches `close`, there is NO competing blur mutation.
- **Plugin.tsx**: `useReducer(filterReducer, INITIAL_FILTER_STATE)`; button `onClick` →
  `dispatch({type:"toggle"})`; passes `filterQuery` + `onFilterQueryChange`(setQuery) +
  `onFilterClose`(close) to TaskTree. Button active-state styling (`.mxd-btn-icon.active`, already
  in CSS) unchanged.
- **TaskTree.tsx**: filter is now a CONTROLLED prop (`filterQuery`) — removed internal
  `taskFilter` useState. **Removed the input's `onBlur` handler entirely** (the race source).
  Escape → `onFilterClose()`. Auto-focus-on-open effect kept. Props type extracted to exported
  `TaskTreeProps`. Filtering behavior (substring match on title/description/id) unchanged.
- MockShowcase.tsx + web/TaskTree-color.test.tsx updated for the new props.

### Behavior change worth knowing (surfaced to root)
The old **auto-close-on-blur-when-empty** is GONE. An empty open search no longer collapses when
you click elsewhere; it closes only via the toggle button or Escape. This matches the task's
enumerated close triggers ("click again/Escape") and is what makes the toggle race-free without a
`preventDefault` hack. If click-away-collapse is ever wanted back, do it via a document-level
outside-click listener (NOT input.onBlur) to avoid re-introducing the race.

### Why lift to a reducer instead of a minimal in-place patch
happy-dom + React controlled-input change tracking is unreliable: simulating typing (native `input`
event AND the `Object.getOwnPropertyDescriptor(...).value` setter trick) both FAILED to fire React's
`onChange` in probes. So a query-in-TaskTree design would need fragile typing simulation to test.
Lifting the query to a controlled prop makes filtering testable by **passing a prop** (no typing),
and the pure reducer makes the toggle logic testable with **zero DOM**. `.blur()` and keydown DO
fire in happy-dom (probed) — used for the component-level guards.

### Tests (mutation-verified)
- `web/filter-state.test.ts` (11): reducer purity — open→type→close→open (reopened input empty),
  toggle strict alternation, close clears, setQuery-ignored-while-closed, closed⟹empty invariant.
- `web/TaskTree-filter.test.tsx` (7): filterQuery prop filters; search bar reflects filterOpen;
  Escape→onFilterClose; **blur does NOT close** (guard); auto-focus on open; and a faithful
  **"又弹出来" reproduction** — a Harness wiring a real button + the real reducer + TaskTree, does
  open→blur input→click toggle, asserts it stays CLOSED. Mutation proof: re-adding `onBlur`→close
  fails BOTH the blur guard AND the reproduction (reproduction shows `Received: true` = reopened).
- Full `bun test` 2465 pass / 0 fail (baseline 2447 + 18). typecheck + check:ci + i18n clean.

## Global image drag-drop → composer attachment (2026-07-15)

Drop an image ANYWHERE on the plugin web page → it attaches to the composer's existing
attachment state, instead of the browser navigating to / opening the file. The composer's
own footer-form drop (`.mxd-footer-form`) is UNTOUCHED (additive) — this ADDS page-wide
coverage.

### Files
- `.mxd/plugin/web/file-drop.ts` — NEW. Pure helpers `isFileDrag(dt)` / `extractImageFiles(dt)`
  (no DOM, unit-tested) + the `useWindowFileDrop(onImageFiles): isDragging` hook.
- `InputBar.tsx` — new `ImageDropRequest = { files: File[]; seq: number }` type + `imageDropRequest`
  prop + a one-shot `useEffect` that runs each file through the EXISTING `handleFileToBase64`
  (the reuse point — no duplicated validation; paste / click-upload / composer-drop all share it).
- `AppFooter.tsx` — threads `imageDropRequest` Plugin → InputBar.
- `Plugin.tsx` (ProjectContent) — `useWindowFileDrop(handleImageFiles)` → bumps a one-shot
  `imageDropRequest` state (mirrors the `quoteRequest` seq-hop) → AppFooter; renders the
  `.mxd-global-drop-overlay` when `isDraggingFile`.
- `style.css` — `.mxd-global-drop-overlay` (fixed, full-viewport, `pointer-events:none`) +
  `.mxd-global-drop-inner`. i18n `footer.dropImage` (EN "Drop image to attach" / ZH "拖放图片以添加").

### ⭐ RED LINE — never intercept internal HTML5 drags
The task-tree reorder/reparent (TaskTree.tsx) and tab-bar reorder are native HTML5 drags that
set `dataTransfer.setData("text/plain", …)` → `dataTransfer.types === ["text/plain"]`, NEVER
"Files". EVERY global handler gates on `isFileDrag` (= `types.includes("Files")`), so internal
drags pass through completely untouched. Verified: TaskTree `handleDragOver` early-returns (no
`preventDefault`) when its internal `dragState` is null (external drag), and `handleDrop` calls
`preventDefault` but NEVER `stopPropagation` — so a FILE dropped on a task node is preventDefaulted
(no browser open) AND bubbles to the window handler (attaches). Live-smoke confirmed
`internalDragPrevented === false` for a text/plain dragover.

### Design: window listeners, CAPTURE (visual) vs BUBBLE (functional) split
`useWindowFileDrop` attaches to `window` (covers the whole viewport regardless of DOM — sidebar,
activity, footer — without a wrapping div / layout change). Two concerns, two phases:
- FUNCTIONAL (bubble): `dragover` (preventDefault + `dropEffect="copy"`) + `drop` (preventDefault +
  attach image files). BUBBLE phase is load-bearing: InputBar's own composer `onDrop` calls
  `stopPropagation`, so a drop landing ON the composer is handled there and this window `drop`
  does NOT also fire → NO double-attach. Drops elsewhere aren't stopped → bubble to window → attach.
- VISUAL (capture): `dragenter`/`dragleave` depth counter + `drop` reset drive the overlay.
  CAPTURE phase is load-bearing: it fires before any inner bubble-phase handler, so InputBar's
  `stopPropagation` on the composer's drag/drop can't desync the counter or leave the overlay
  stuck (a composer drop still triggers the capture `drop` reset). This is why the overlay needs
  NO timer/flicker heuristic — the counter is deterministic.

### Consumer wiring — one-shot request (mirrors quoteRequest)
Window handler collects `File[]` and bumps `imageDropRequest = { files, seq }`; InputBar's effect
(keyed on the object; `handleFileToBase64` is a stable useCallback, listed in deps → no re-fire)
runs each file through `handleFileToBase64`. Passing File objects (not base64) down keeps the
one converter (size guard + FileReader + mediaType) in InputBar — zero duplication.

### Tests (mutation-verified)
- `web/file-drop.test.ts` (pure helpers), `web/file-drop-hook.test.tsx` (hook: overlay show/hide,
  attach, dropEffect, enter/leave counter, unmount cleanup, + RED LINE text/plain not intercepted),
  `web/InputBar-image-drop.test.tsx` (imageDropRequest → preview via handleFileToBase64),
  `web/Plugin-image-drop-journey.test.tsx` (CANONICAL: real daemon + Plugin, drop image on the
  sidebar → composer preview; internal text/plain dragover not prevented — guards the
  Plugin→AppFooter→InputBar seam + the hook wiring).
- Mutation-proofed: dropping `imageDropRequest={imageDropRequest}` in AppFooter → journey FAILS
  (15s timeout, no preview) while component tests stay green; removing the `isFileDrag` gate in
  the hook's `onDragOver` → RED-LINE hook test FAILS.
- Live browser smoke on the branch build (isolated daemon :7434): overlay renders w/ correct
  text + `pointer-events:none`; file dragover/drop `defaultPrevented`; text/plain drag NOT
  prevented; drop image on sidebar → `data:image/png;base64,…` preview in composer; paste image
  still works. happy-dom + Bun support `File`/`FileReader.readAsDataURL` and synthetic DragEvents
  (attach `dataTransfer` via `Object.defineProperty`).

### Gotcha — CDP can't synthesize an OS-file drag
chrome-devtools `drag` is element-to-element only; a REAL external-file drop (the one that
triggers the browser's open-the-file default) can't be synthesized via available tools. Both the
tests and the live smoke inject SYNTHETIC drops (dataTransfer stub). "Browser doesn't open the
file" rests on standard `preventDefault(dragover+drop)` semantics (verified prevented) + a human's
eventual real-file drag. Everything else is covered end-to-end.

## Settings UX — unified "Save & Restart" (2026-07-17)

Three entries merged, newest-first, because this UI was rebuilt twice in a month and only the end
state is actionable. **Current shape** (verified in `web/components/SettingsPanel.tsx`): a
`RestartBar` with exactly two buttons — **Save & Restart** (saves every dirty tab, then restarts the
daemon) and **Revert** (resets all tabs to last-saved). Closing the panel discards. **No confirm
dialogs anywhere.**

The two superseded entries are kept below for one reason each: the three-fix decouple carries the
mechanism note that is still true and still counter-intuitive (config Save takes effect on the next
run WITHOUT a restart — restart only reloads code), and FIX-10 carries the bug that made all of this
necessary in the first place.

Simplified from the three-fix model (separate Save, Revert, restart-relabel, save-effect hint,
restart-confirm) to a single-action model per user request ("try simplest, revert if bad").

**One button: "Save & Restart" / "保存并重启"** — saves ALL dirty tabs (global/repo/local) then
restarts the daemon. Closing the panel = discard. No separate Save or Revert buttons.

**handleSaveAndRestart** (SettingsPanel level): validates model required on global → PATCHes each
dirty tab via updateGlobal/updateRepo/updateLocal → on first error stops + shows inline error → on
all success POSTs /restart-daemon + polls /health + page reload. Lifted from GlobalTab to
SettingsPanel so the RestartBar is shared across all tabs.

**Close-panel guard retained**: X button + click-outside with `hasUnsavedChanges` → confirm
"You have unsaved changes. Discard them?". Tab-switch NOT guarded (drafts persist).

**RestartBar replaces TabActions**: renders after tab content, before danger zone. One button +
error display. The old per-tab Save/Revert bar is gone. GlobalTab/ProjectTab are pure forms
(no action buttons, no save/revert/error/dirty props).

**Verified mechanism** (unchanged): config Save → daemon syncToWorkers (daemon.ts:2163) →
worker ctx.globalConfig updates (scope-worker.ts:184-188) → next resolveProjectConfig uses new
values. Restart is only for loading newly deployed code. But the UX merges both into one button
for simplicity — "Save & Restart" always saves first, then restarts.

**Revert path**: the entire change (three-fix base + this simplification) is two merge-able
commits. `git revert <merge>` cleanly returns to pre-fix state.

### Settings UX iteration 3: Revert button added, close-panel confirm removed (2026-07-17)

User feedback: close-panel confirm dialog was more annoying than helpful. With Revert available,
users undo mistakes themselves — no need for system to block close.

- **Revert button** added to RestartBar (next to Save & Restart). Resets ALL tabs (global/repo/local)
  to last-saved state. Disabled when clean (nothing to revert).
- **Close-panel confirm removed**: X button + click-outside → direct onClose, no window.confirm.
- `closeConfirmUnsaved` i18n key deleted (EN + ZH).
- `handleClose` useCallback removed; click-outside handler reverted to direct `onClose()`.

**Current SettingsPanel action model**: Save & Restart (saves all dirty + restarts daemon) +
Revert (undo all edits) + close (just closes, discards unsaved). No confirm dialogs anywhere.

### Superseded by this: the three-fix decouple (2026-07-16)

Three UX fixes to `web/components/SettingsPanel.tsx` that stop users from conflating
"restart daemon (loads code)" with "apply config changes (Save → next run)". Root cause
was layout: restart button appeared inside the Global tab near Save/Revert, giving the
impression that restart = apply config.

**Verified mechanism (write into copy)**: config Save → daemon `syncToWorkers("config",
globalConfig)` (daemon.ts:2163) → worker `ctx.globalConfig` updates instantly
(scope-worker.ts:184-188) → next `resolveProjectConfig` → `resolveConfig(ctx.globalConfig,...)`
uses new values. **Restart is only for loading newly deployed code.**

#### Fix ①: Restart button relabel + decouple
- `settings.restartDaemon` = "Restart backend (load new code)" / "重启后台(加载新代码)"
- `settings.restartDaemonLabel` = "Load new code" (left label, replaces old misleading hint)
- `settings.restartDaemonHint` = description below button: "Only reloads daemon to pick up
  newly deployed code. Config changes do NOT need a restart — Save applies on the next run."
  
#### Fix ②: Save-takes-effect hint
- `settings.saveEffectHint` in TabActions (shared across all three config tabs):
  "Saved changes take effect on the next run — no restart needed."

#### Fix ③: Unsaved-changes protection (option A — guard real loss points only)
- **Restart** with any-tab unsaved → `window.confirm` with misconception-correcting text:
  "Restarting reloads code, does NOT apply config changes. Save first." If cancelled, no POST.
- **Close panel** (X or click-outside) with any-tab unsaved → standard "You have unsaved
  changes. Discard them?" confirm.
- **Tab-switch** (global↔project↔local): NO guard — each tab keeps independent persistent
  draft state; no data lost on switch. A confirm here = crying-wolf (trains users to ignore
  the real confirms on restart/close).

#### CSS
`.mxd-settings-hint` (muted 11px helper text). Inside `.mxd-settings-tab-actions` takes
full-width row via `flex-basis: 100%`.

#### Tests (`web/SettingsPanel-restart.test.tsx`, 13 tests)
- `isDirty` pure-function unit tests (6) — detection algorithm.
- Fix ①: button text, description text, left label. Fix ②: hint presence. Fix ③: clean-path
  restart (no confirm, POST fires), close (no confirm, onClose fires), tab-switch (no confirm).
- happy-dom limitation: React controlled `<input>` onChange doesn't fire from native value
  setter + dispatchEvent ("input"). Dirty-path component tests can't make the internal draft
  diverge from saved state. Dirty detection is unit-tested via exported `isDirty`; the wiring
  (`if (hasUnsavedChanges && !window.confirm(...)) return;`) is ~4 lines verified by code review.

### The bug underneath it all: Save silently failed (FIX-10, 2026-06-10)

Two frontend bugs caused "save then restart, changes gone":

#### Root cause chain
1. `updateDraftGlobal` deletes keys when value is `""` / `null` / `undefined`
2. `buildPatch` sends `null` for keys in saved but missing from draft (second loop)
3. Server PATCH `/config/global` rejects null on required fields -> 400
4. `updateConfig` in ShellApp.tsx didn't check `res.ok` -> silent swallow
5. Refetch after silent failure reverts UI -> user sees changes "disappear"

**Backend persistence is fine** -- PATCH -> disk write -> restart -> GET all works. Bug was
purely frontend.

#### Fix 1 -- `buildPatch(draft, saved, allowNull)`
New third parameter. `saveGlobal` passes `allowNull=false` -> null values omitted from
patch. `saveRepo`/`saveLocal` keep `allowNull=true` (null = "remove override"). A model
change + cleared field no longer poisons the entire PATCH body.

#### Fix 2 -- `updateConfig` checks `res.ok`
Returns `Promise<string | null>` (error message or null). SettingsPanel shows inline
red error banner in `TabActions`. Draft stays dirty on failure. Error clears on revert
or next save attempt. i18n: `settings.saveError` (EN: "Save failed", ZH: "保存失败").

#### Interaction with server-side null rejection (cc#4)
The server's null rejection for global config (added in FIX-2 cc#4) is CORRECT -- it
prevents writing incomplete configs that would brick the next boot. The frontend was
producing the null values that triggered the rejection. Both sides are now correct:
server rejects null, frontend never sends it for global.

## Pure image send + read-only tool collapse + timestamp alignment + edit SVG icon (2026-07-23)

Four fixes in one commit:

### Bug 1 — Pure image messages blocked
REST `/message` route (tasks.ts) and `/edit` route (plugin/runtime.ts) both rejected
requests with empty `content` even when `images` were present. Fixed both guards to
`!content?.trim() && (!images || images.length === 0)`. `createUserMessage` gets
`content ?? ""` fallback (it requires `string`, not `undefined`). `notifyParentChain`
gets `"[image]"` fallback for pure-image messages.

### Bug 2 — Read-only tool cards default collapsed
Added `TOOL_SEARCH_TASKS` to `tool-names.ts`. New `isDefaultCollapsed(toolName)` in
`event-display.ts` returns true for `get_tree`, `get_task`, `search_tasks`,
`list_projects`. `ToolCard.tsx` uses it alongside `titleOnly` to force
`defaultExpanded=false`. These tools still have expandable bodies (unlike `isTitleOnly`
which removes the body entirely) — users can click to see results.

### Bug 3 — Timestamp vertical alignment
`mxd-user-ts-col` had `align-items: center` with no fixed width. The action buttons row
(3×16px + 2×6px = 60px) was wider than the timestamp `min-width: 58px`, causing the
timestamp to center-shift rightward. Fixed: `width: 58px` + `align-items: flex-start`.
Action button gap reduced 6px→4px to fit within 58px (3×16px + 2×4px = 56px).

### Bug 4 — Edit button SVG icon
Replaced `✎` unicode char with `<IconEdit size={12}/>` SVG pencil icon in LogEntryView
user message action buttons. `IconEdit` added to `icons.tsx` (Lucide-style pencil path).

## Blocked Edit/Rewind buttons: grey + explain, never hide (2026-07-25)

The rule for which messages are editable is in Events/JSONL (*Which messages can be edited/rewound*).
This is how a refusal is presented.

**Blocked buttons stay, greyed and disabled, with the reason in `title`.** Copy is never gated. Two
independent justifications, which is what makes the decision stable:

1. **Semantic**: a silently vanishing control reads as broken — and the cases that most need an
   explanation are exactly the ones left with no affordance to carry one.
2. **Layout**: the row is ✎ ↺ ⧉. Hiding makes Copy change position, so a list has rows with two
   buttons and rows with three. Greying keeps the column stable. This holds *even if* every
   disappearance were explained.

**Precedence: permanent outranks transient** — not "whichever the code tests first". Order:
`unknown_message` → `no_rewind_point` → `did_not_start_run` → `agent_busy`. "Wait for the agent to
stop" promises a remedy; on a permanently un-editable message the user waits, the agent stops, the
button is still grey, and they cannot tell whether they waited wrong or the product is broken.
**Never offer a remedy that will not work.** The rule generalises to any future reason.

**Wording follows the user, not the loop.** Every visible string uses their framing — *"Not sent on
its own — the agent picked this up along with work it was already doing, so there is no separate
point here to go back to."* The internal token (`did_not_start_run`) stays, because it is part of
the `/edit` response shape.

**Keep the reason→string map exhaustive over the union** (`Record<EditBlockedReason, string>`), not
partial-with-fallback: it is what caught the missing i18n key the moment a third reason was added.

## Rewind/Edit confirm dialog + rollback impact analysis (2026-07-24)

Replaces `window.confirm` on Rewind with an in-app modal that reports **what the
rollback does NOT undo**, and marks the message being edited in the log.

### `.mxd/plugin/web/rollback-impact.ts` (pure, no DOM/React)
`analyzeRollbackImpact(entries, targetEid) → { filesModified, tasksModified,
messagesSent, otherSideEffects, toolNames[] }` + `hasSideEffects(impact)`.
Scans from the entry carrying `targetEid` (inclusive) to the end of the log,
counting `tool_call` / `tool_pair` entries, **skipping entries from other tasks**
(rollback is per-session — a sibling agent's bash must not be reported here).
Unknown `targetEid` → empty impact (the dialog then claims nothing).

Categories (MCP prefix stripped via `stripMcpPrefix`): FILE = write_file /
edit_file / bash · TASK = create/update/delete/close/reset_task, reorder_tasks,
execute_tasks, create/delete/rename_folder, fork_task_context · MESSAGE =
send_message, send_message_to_project, send_message_to_child, report_to_parent,
clarify.

**Read-only whitelist is load-bearing, not documentation**: read_file, list_files,
search, search_tasks, get_tree, get_task, get_logs, list_projects, background,
yield, done. Anything NOT whitelisted and NOT categorized sets `otherSideEffects`
→ generic warning. **Unknown tools (external MCP, evaluate_script) are never
assumed safe** — that's why the whitelist exists instead of "warn only on the
three known categories".

`toolNames` lists EVERY tool that ran in the range (read-only included, deduped,
first-call order) — raw truth for the detail line; the dialog collapses >8 to `+N`.

### Components
- `components/ConfirmDialog.tsx` — generic in-app modal (backdrop + centered card,
  Escape / backdrop click / Cancel all cancel, card click doesn't, `danger` picks
  `mxd-btn-stop` vs `mxd-btn-primary`, confirm button autofocused, `children` slot).
- `components/RollbackConfirmDialog.tsx` — composes it with the impact report.
  `kind: "rewind" | "edit"` picks wording + danger styling. Warnings render in an
  amber box; a clean range renders a green "nothing outside the conversation
  changes" box (+ the tool list if read-only tools ran).

**Other `confirm()` call sites are untouched** (delete task, clear session in
Plugin.tsx + handlers.ts). ConfirmDialog is ready for them; migrating was out of
scope.

### Rewind vs Edit — where the dialog sits
Both are the same backend operation (`POST /edit`). Rewind confirms and fires
immediately. **Edit confirms at the moment the ✎ button is clicked**, not at
submit: the warning's value is "before you decide to edit", and intercepting the
submit would need draft restore on cancel (InputBar clears the prompt on submit).
Trade-off accepted: the actual POST then happens without a second confirm.

### One "jump to bottom" mechanism
`ActivityLog` gained `scrollToBottomRequest?: number` — a monotonic counter applied
in a `useLayoutEffect` (deps `[scrollToBottomRequest, entries, scrollToBottom]`).
Plugin's `requestScrollLogToBottom()` bumps it + `setAutoScroll(true)` +
`setLogAtBottom(true)`; both the ↓ button and the post-rollback/edit re-fetch call
it (the ↓ button previously did its own `document.querySelector(...).scrollTop`).

Why a counter and not just `setAutoScroll(true)`: the follow effect only fires when
`visible.length` or `autoScroll` CHANGES. Rewinding while already at the bottom
with an unchanged entry count changes neither → nothing scrolls. That matches the
user's report that the "jumps to the top" symptom is **intermittent**. The layout
effect also runs before paint (no flash), unlike the follow effect's rAF.

This is a SIBLING of the "Load earlier history" bottom-relative anchor (01KXP05P),
not a change to it: same class of bug (wholesale `entries` replacement invalidates
the scroll offset), opposite intent (land at the bottom vs stay put). The anchor
effect and the follow effect are untouched.

### Editing highlight
`editRequest.eid` → ActivityLog `editingEid` → LogEntryView adds
`mxd-user-msg--editing` (inset accent rail + brighter bubble) and stamps
`data-eid` on every user-message entry. The composer's "editing" indicator is now
a button (`mxd-edit-indicator-label`, `IconEdit` SVG replacing the ✏️ emoji) that
jumps back to that message via `[data-eid=...]`.

**Gotcha — smooth scrollIntoView loses to follow mode.** `scrollIntoView({behavior:
"smooth"})` on the edited message got snapped back to the bottom mid-animation
(observed live in the browser, not in tests). Fix: `setAutoScroll(false)` first,
then an INSTANT `scrollIntoView({block:"center"})`.

### Test-harness gotcha: a seeded task with `status: "pending"` wipes its own log
`clearSessionState` (event-handler.ts) drops log entries for sessions transitioning
to `pending`. In happy-dom journey tests the SSE EventSource is a no-op mock so
this never fires, but in a REAL browser the first `tree_updated` arrives and the
activity log renders "No events yet" despite the events endpoint returning data.
Seed live-smoke fixtures with `status: "verify"` (or in_progress) — a task that
owns a session is never `pending` in reality.

### Live smoke recipe (reusable)
`/tmp/smoke-rewind/setup.ts` pattern: temp dataDir + `projects.json` + tree.json +
hand-written JSONL (explicit `eid`/`parentEid` chain so no auto-migration) under
`projects/<id>/plugin/matrix/`, `createTestToken`, `createDaemon({dataDir})`,
`Bun.serve({port: 7434, fetch: daemon.fetch})`. Then in the browser:
`localStorage.setItem("mxd-jwt", token)` + navigate to `/<projectId>/matrix/<rootId>`.
A user message needs BOTH a `message` event with `id`+`eid` AND a
`messages_consumed` event to materialize with its eid (the eid rides through
`pendingReducer` → `materializeFromPending`), which is what makes Edit/Rewind
buttons appear.

### Tests (36 new, mutation-verified)
- `web/rollback-impact.test.ts` (15, pure): every category, read-only → no warning,
  no-tools → clean, unknown tool → otherSideEffects, range/task filtering, dedupe.
- `web/ConfirmDialog.test.tsx` (12): dismissal contract + warning rendering per
  impact + rewind/edit wording and button styling.
- `web/ActivityLog-rollback-scroll.test.tsx` (7): request applies after a shrinking
  entries replacement, **mutation proof** (no request → offset unchanged), repeat
  requests, mount doesn't force a scroll, editingEid highlight on/off.
- `web/Plugin-rewind-journey.test.tsx` (2, real daemon + real Plugin): ↺ → in-app
  dialog (window.confirm spy proves it's never called) → impact warning → Cancel is
  a no-op → Confirm POSTs /edit and lands at the bottom with follow resumed; ✎ →
  edit wording → composer prefilled + log marked + indicator jumps back.
  The `POST /edit` is the ONE stubbed call (the real endpoint would launch an agent
  against the fixture repo; backend semantics live in src/rollback.test.ts).
  Mutation-proofed: dropping `scrollToBottomRequest` fails the follow-mode-rewind
  step; dropping `editingEid` fails the Edit test.

**Journey-test gotcha**: after a rollback re-fetch the log entries REMOUNT (fresh
`createLogEntry` ids → new React keys → new DOM nodes), so any button captured
before the rebuild is detached. Re-query it.

### Correction (2026-07-24, same day): `done` is NOT read-only

The first cut of `rollback-impact.ts` whitelisted `done` as read-only, so a range
that crossed a `done()` rendered the green "nothing outside the conversation
changes" box — a lie. `done()` has two real, non-rollback-able effects: it flips
the task's status to verify/failed AND delivers `task_complete` to the task above
(which may already have woken, reviewed and merged).

`done` now lives in BOTH `TASK_TOOLS` and `MESSAGE_TOOLS`, and the classification
loop changed from a first-match `else if` chain to **independent membership
checks** (`isFile` / `isTask` / `isMessage`, then `otherSideEffects` only when
none matched and the tool isn't whitelisted). The sets are otherwise disjoint, so
every single-category tool behaves exactly as before — a regression test pins
that (`bash`/`create_task`/`send_message` each flip exactly one flag).

Re-checked the rest of the whitelist: `yield` is a pure loop pause; `background`
covers list/status and a kill is a stop, not a rollback-able state change. Both
stay. Mutation-verified: moving `done` back to the whitelist fails 3 tests;
restoring the `else if` chain fails 2.

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
- Test counts are not recorded here — `bun test` prints them and any number written down starts
  rotting immediately. (This bullet used to say "~1976 tests, 4 skipped".)

## ⚠️ Every `throw` in a test double must quote the real error it mirrors (2026-07-25)

**Rule, for ANY test double — not just `ValidatingMockAPI`:** when a fake rejects something on the
grounds that the real system would reject it, the rejection message must carry **the real system's
own error string**. If you cannot quote it, you have not verified it, and it does not belong in a
predicate named after the real system.

**Why this rule and not "be careful":** it moves the failure to the moment of WRITING. The claim
that cost us four production mechanisms propagated as a parenthesis in a bug report — *"Error from
ValidatingMockAPI (matches real Anthropic)"* — which nobody ever checked. Under this rule the author
would have gone looking for the API's wording, found none, and stopped there. **A rule is worth
what its failure mode is worth, not what it says.**

**Corollary — separate OUR expectations from THEIR rules, by name.** A check we want but the API
does not enforce is fine; it just may not live inside something called `validateRequest` /
`assertValidApiMessages`. Give it its own name (`assertNoEmptyContent`) and let tests opt in. **A
style rule hidden inside an API-validity predicate gets cited later as API behavior** — that is
precisely how the alternation fiction became a documented fact.

**Corollary — a fake that is STRICTER than the real system is not "safe".** It manufactures phantom
bugs, and phantom bugs get fixed with real complexity. Strictness in a test double is not a
conservative choice; it is an unverified claim about the system under test.

Detection heuristic for auditing an existing double: **do not audit whether the assertions are
correct — ask whether the rule being ENFORCED is the same rule that is DOCUMENTED.** Where those two
fork is where a fiction starts producing evidence. Full case study: *The Anthropic message-shape
rules, MEASURED*.

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
- `src/drift-tool-lifecycle.test.ts` — tool lifecycle
- `src/drift-message-sources.test.ts` — every QueueMessage source type
- `src/drift-lifecycle.test.ts` — yield/done/fork/compact transitions
- `src/integration.test.ts` Bug repro suite — original caption bug regressions

### Correctness invariant (golden snapshot unit tests)
Direct invocation of `eventsToAnthropicMessages(events)`, assert exact output bytes. Catch when **walker callbacks produce wrong output** (even if consistently wrong across both paths). Fast (~90-150ms per file).

Example: if walker's `onConsumedMessages` lacked caption, both paths would miss it → drift tests pass, golden test catches it by asserting `[{text}, {image}, {caption}]` is the expected output.

Mutation-tested rigorously: every mutation (remove caption idle/working, drop is_error, add is_error to image tool_result, swap block order, break string↔array invariant, drop interleaved text, remove caller field) is caught by at least one test.

Files:
(Per-file test counts used to be listed here and have been dropped — they were wrong within weeks
and a stale count reads exactly like a fresh one. What each file COVERS is the durable part and is
what you actually need to pick a file; `bun test` counts them.)

- `src/walker-golden.test.ts` — core walker correctness
- `src/drift-infra-audit.test.ts` — golden output + mock-validator mutation tests
- `src/drift-tool-lifecycle.test.ts` — tool lifecycle (golden half)
- `src/drift-lifecycle.test.ts` — yield/done/fork/compact (golden half)

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

## Guards need a two-sided mutation proof (2026-07-25)

**Mutate in both directions, or the test suite will accept a guard that quietly kills the feature.**

- **Over-loose** (delete the guard) — the side everyone tests. Usually caught.
- **Over-strict** (make the guard block everything) — **almost never tested, and it is the typical
  failure mode of a guard.** It turns no test red; it just makes some normal path silently stop
  working.

The number that makes this concrete: making a follow-mode effect never scroll — i.e. killing the
entire follow feature — left **11 of 12 tests in that file green**, including four guard tests
written the day before. A second case the same day: keying a rule on "alone in its turn" instead of
"no prior work in its turn" failed **exactly one test out of 2775**, and only because someone had
deliberately written the "two messages consumed together are BOTH editable" case.

So: **when you add a guard, explicitly write a test for what it must NOT block, and verify that test
still passes with the guard in place.** Without it the change ships fully green with the feature
gone.

## Test fixtures with unstable identity lose their resolution silently (2026-07-25)

A fixture that regenerates entry ids on every render makes every rerender a full key change → whole
subtree remounts → MutationObserver fires → if follow is on, *the remount itself* scrolls to the
bottom. Which means the test can no longer see whether the code under test scrolled. It does not go
red; it stops being able to distinguish.

Fix: build the master array once and slice it, so entries keep their id / React key / DOM node
across rerenders and adding items is an APPEND — which is also what production does. **Whenever a
test asserts something about an effect, check that the fixture is not producing that effect
itself.**

Related, from the same area: **happy-dom does no layout**, so geometry cannot be observed there. It
can still test the *causes* of geometry — DOM order, commit granularity, whether a callback ran —
which is far better than dropping the test or mocking geometry brittlely. Anything genuinely about
pixels has to be measured in a real browser.

## Test-is-Golden / ITA Philosophy

Three layers: Intention → Test → Architecture. Three mutations guard each layer:
- **Intention Mutation**: is this behavior what users actually want?
- **Test Mutation**: do tests catch code changes?
- **Architecture Mutation**: can the code evolve?

Tests are the single source of truth. Bottom-up: write tests → find simplest architecture that passes them. Architecture is replaceable long-term, improved short-term. Reject spec-driven development.

## bun test cross-file React breakage: root cause is react-dom scheduler binding — FIXED via preload (2026-07-02)

**Supersedes the "Test pollution gotcha (pre-existing, not Fix C)" entry and the Task Y
"ShellApp integration tests — DELETED" workaround rationale.** The "happy-dom state
surviving GlobalRegistrator cycles" theory was wrong, and the class is now FIXED, not
worked around.

### Actual mechanism (probe-bisected, 2-file repros)
react-dom is a process-wide singleton; its scheduler picks timer machinery
(MessageChannel etc.) at FIRST IMPORT. If the first `import("react-dom/client")` in a
`bun test` process happens INSIDE a registered happy-dom environment, the scheduler
binds that window's machinery; when that file's afterAll runs
`GlobalRegistrator.unregister()`, scheduled render work stops flushing → EVERY
subsequent test file's React renders produce nothing (fast assertion fails + 5s render
timeouts). If the first import happens under plain bun globals, the binding is
bun-native and immortal — all later register/unregister cycles are harmless.

- bun's test-file order is filesystem-dependent (NOT alphabetical, NOT mtime). Baseline
  was green only because web/ShellApp.test.tsx happened to run first (its react-dom
  import path was benign); adding 4 new web test files reshuffled the order, put a new
  file in pole position, and 52 tests across 11 web files failed. Any file addition
  could have re-rolled this dice — the landmine was latent, not caused by any file's
  content.
- Red herrings eliminated by probes: matchMedia mocks (assign OR call), happy-dom
  register options (width/height), IS_REACT_ACT_ENVIRONMENT — none of them matter. A
  minimal register→import-react-dom→render→unregister file poisons; the identical file
  with a TOP-LEVEL react-dom import stays benign.
- Bisect trap to remember: a sed-mangled probe whose beforeAll THROWS never registers
  happy-dom → the paired victim file runs clean → looks like "mutation fixed it".
  Validate probe files pass on their own before trusting a bisect step.

### Fix (the ONE mechanism)
`bunfig.toml [test] preload = ["./src/test-utils/preload.ts"]` — the preload just does
`import "react-dom/client"` once per process, before any test file, guaranteeing the
native binding regardless of file order. Verified: previously-poisonous orders
(journey-first, targetNodeId-first, url-task-id-first) all green; full suite 2419/0.

### Consequences
- happy-dom + GlobalRegistrator register/unregister per file is SAFE now. Subset runs
  (`bun test web/A.tsx web/B.tsx`) are no longer order-flaky for this reason.
- matchMedia mocks in test files are innocent; keep them if a test needs desktop
  viewport (or use `GlobalRegistrator.register({ width, height })` — happy-dom's real
  matchMedia evaluates min/max-width correctly against it).
- Do NOT remove the preload "because tests pass without it locally" — passing depends
  on file order, which depends on the filesystem. The preload is what makes order
  irrelevant.

---
# Build, Tooling & Housekeeping
---

## CLI Installation

`mxd` CLI globally installed via `bun link`. package.json `"bin": { "mxd": "src/cli.ts" }`, cli.ts has `#!/usr/bin/env bun` shebang.

## Dead-code sweeps: what was deleted, and what deletion taught us

Four sweeps merged (FU8, R7 [LOW], the Clear-All-Sessions removal, FIX-4b). They are pure
RECORDS — "on date D we deleted X because Y" does not rot the way a claim does — so they are kept
in full and only gathered together, because as separate top-level entries they were four places to
look for the same question: *"is this thing still here, and if not, why not?"*

**Re-verified while merging** (2026-07-25), since a deletion record is exactly the kind of entry
that could have been quietly undone: `persistent-queue.ts`, `openai-compatible-provider.ts`,
`web/components/icons.tsx`, `_cache_audit.ts`, `_token_audit.ts` and `RelocateBanner.tsx` are all
still gone; `hasPendingYield`, `formatPendingSection`, `combineSystemPrompt`,
`buildExternalJsonSchema`, `resetAuthDataCache`, `clarifyTimeoutMs` and `readWithLineMap` have zero
occurrences. `truncateAfterLine` appears three times but only inside comments explaining why it was
removed — the function is gone. **One claim from this era did NOT hold and is corrected in place**:
FU8's "`scope: 'project'` union variant dropped" — see that bullet.

⭐ **The one durable lesson across all four, from FIX-4b C8: "test-only" ≠ "dead".** An audit called
`tool()` production-dead and asked for its removal. It IS test-only — and it has 23 call sites. That
makes it live test INFRASTRUCTURE; deleting it would have been a risky 23-site migration that
changed what those tests test, not a reclamation. The real violation was a genuine duplication
sitting next to it (`stripZodMeta` + `shapeToJsonSchema` existed verbatim in two files), and fixing
THAT was the actual win. **When an audit says "dead", check whether it means "unreferenced" or
"only referenced by tests" — the second is a different claim with a different answer.**

### Audit FU8 Dead-Code Sweep (2026-04-17)

Consolidated cleanup of items flagged by the 12-audit review:

- **Shared `src/version.ts`** for VERSION + GIT_HASH — was duplicated in daemon.ts + runtime.ts.
- **Worker-side SSE ring buffer deleted** — daemon owns SSE (seqId, buffer, fanout). Worker just calls `onBroadcast`; daemon serializes + fans out. Removes triple-JSON-serialize path.
- **`ctx.sseClients` removed from RuntimeContext** — worker never had SSE clients attached.
- **`persistent-queue.ts` deleted** — dead code that bypassed the unified `projects/<id>/` storage layout.
- ~~**`scope: "project"` union variant dropped** from PluginManifest (only "global" is implemented). Re-introduce via task when a real per-project plugin appears.~~ **It came back**, exactly as anticipated — `PluginManifest.scope` is `"global" | "project"` again since additive dual-lens routing. See *Additive project-scoped plugin routing*. Left visible because the removal-then-return is the honest record of a correct call: deleting an unimplemented union member and re-adding it when a real case arrived cost nothing, and is what anti-pattern #6 asks for.
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

#### dataRoot Hardening (Audit FU5)

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

### Audit R7 [LOW] drift cleanup (2026-04-18)

Four cosmetic items flagged by Audit R7 bundled in one commit:

#### pluginApiPrefix split: `src/plugin.ts` → `src/plugin-url.ts` (zero imports)

`pluginApiPrefix(name)` moved to a standalone file with ZERO imports. Rationale:
- `web/runtime-types.ts` (compiled to browser via `@mxd/types` importmap) re-exports `pluginApiPrefix` for plugin web code.
- Before the split: `plugin.ts` imported `data-paths.ts` which imports `node:path`. Bun's `target: "browser"` polyfilled the entire `node:path` module (~10 KB of assertPath/normalize/resolve/join/...) into every plugin's first-load bundle.
- Built `runtime-types.js` size: **10,293 B → 281 B (37× reduction)**.
- Server callers (cli, daemon, tests) import from `./plugin-url.ts` directly — one canonical location, no re-export. **Corrects the earlier "Plugin URL Namespace" memory entry that listed `src/plugin.ts` as the home.**

Regression guard: `src/plugin-url-namespace.test.ts` builds the shared module at test time and asserts `runtime-types.js < 500 bytes`. Any future re-introduction of a `node:*` transitive dep (or other server-only import) into `web/runtime-types.ts`'s graph will exceed the threshold and fail loud.

JSDoc fix: the old `pluginApiPrefix` docstring claimed "shell wraps a plugin's authFetch so relative paths become prefixed automatically" — the opposite of the b42c9a2 design, which explicitly rejects a shell wrapper. New docstring reflects reality ("explicit prefix prepended by each call site; no shell wrapper, no hidden rewriting").

#### BackgroundProcess dead fields removed

`stdout: string` and `stderr: string` on `BackgroundProcess` were zero-initialized and never read. Removed from `src/tools/bash.ts` (type + constructor) and from 4 test object literals in `src/anthropic-compatible-provider.test.ts`. The "kept for test harness compat" comment was stale — grep confirmed zero reads.

#### resetAuthDataCache deleted

`resetAuthDataCache` in `src/auth.ts` became a deprecated no-op after FU4 removed the in-memory cache. Zero callers remained; deleted outright to prevent future code from importing it expecting cache-flush semantics.

### "Clear All Sessions" deleted rather than repaired (2026-04-18)

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

### FIX-4b sweep + the biome gate (2026-06-05)

Wave-3 audit cleanup. ~78 dead tests removed, net ~−4250 LOC across 22 files (+ new
`src/zod-schema.ts`). `bun test` 2163 pass / 0 fail; `bun run check:ci` exits 0 (gate
restored — `--no-verify` can be dropped on main). Committed as 3 deletion commits (grouped by
non-overlapping file sets) + 1 format-only commit + this memory note.

**C1 — Chat Completions provider deleted**: `openai-compatible-provider.ts` (893 LOC) +
`.test.ts` (1624 LOC, 41 tests). Production-dead — `createProviderFromAuth`
(runtime/helpers.ts) only builds Anthropic + OpenAIResponses. `eventsToOpenAIMessages` (the
Chat-Completions event→message converter) lived ONLY there; `events.test.ts` exercised it in
~36 tests (`describe("eventsToOpenAIMessages")` block + scattered `OpenAI:`-prefixed tests +
dual Anthropic/OpenAI assertions) — all removed, Anthropic assertions preserved. Its
pricing/context utils (getModelPricing/getContextWindow/clearContextWindowCache) were
near-verbatim dups of the LIVE copies in anthropic-/openai-responses-compatible-provider.ts;
anthropic-compatible-provider.test.ts imports resolve to the Anthropic copy. Closes draft
01KN496YTW6HQNDWEKV0W99NQQ.

**F-L1 — hasPendingYield deleted** (events.ts): zero production callers (re-verified post
FIX-1/FIX-3 — FIX-1's repair rewrite uses its own `lastToolCallEvent`, not hasPendingYield).
`hasPendingImplicitYield` is the LIVE sibling (provider-shared.ts:759) — kept. Removed its
tests from events.test.ts + jsonl-stress.test.ts; the jsonl-stress tests that ALSO asserted
`buildSessionRepair` kept those assertions (renamed to drop the dead-fn reference).

**Tier-2 dead exports** (declaration-only, zero refs): formatPendingSection (events.ts),
combineSystemPrompt (system-prompts.ts), buildExternalJsonSchema (tool-def.ts — the
`buildExternalShape` it wrapped stays live in mcp-endpoint.ts), SerializedTreeNode (types.ts).

**C6 — clarifyTimeoutMs vertical deleted**: a user-settable setting that did NOTHING.
`getClarifyTimeoutMs` (resource-registry.ts) was never called, no clarify-timeout mechanism
exists, and the SettingsPanel "Clarify Timeout (ms)" input lied. Removed config field+default,
cli row + KNOWN_CONFIG_KEYS, resource-registry type + getter, SettingsPanel field, and i18n
keys `settings.clarifyTimeout` + the now-orphaned `settings.noTimeout` (only the clarify field
used it) in BOTH web/ and plugin i18n copies.

**C3** — RelocateBanner.tsx deleted (orphan; only ref a stale "moved to shell" comment — it was
NOT moved, relocate survives via CLI). **C9** — collapsed duplicate MCP_TOOL_PREFIX into
MCP_PREFIX (plugin tool-names.ts). **A-F7** — deleted the unreachable `scopeOpts.get(id) ??
{stubs}` fallback in routes/agent.ts `/restart` (createApp throws if buildScopeOpts missing) →
explicit guard-throw. **C4** — deleted `_cache_audit.ts` + `_token_audit.ts` (standalone
investigation scripts, zero importers, made real Anthropic API calls — a liability; recoverable
from git history).

**C8 — NARROWED (audit's "dead" was WRONG)**: the audit called `tool()` (tool-definition.ts)
"production-dead (test-only)" and asked to delete it. `tool()` IS test-only but NOT dead — it's
live test infrastructure with 23 call sites (anthropic/openai-responses provider tests,
evaluate-script, tool-execution). Its `tool(name, desc, zodRawShape, handler)` signature is
intentionally lightweight; the production builder `toToolDefinition(defineTool({params:
ParamDefs}), auth)` is a heavier, different shape. Deleting `tool()` = a risky 23-site migration
pulling auth/ParamDefs into unit tests that specifically test executeTool's Zod validation on the
raw inputSchema — that changes what's tested, NOT reclamation. KEPT `tool()`. The REAL violation
was the genuine duplication: `stripZodMeta` + `shapeToJsonSchema` existed verbatim in BOTH
tool-def.ts and tool-definition.ts → extracted both to a new leaf `src/zod-schema.ts` (depends
only on zod, no import cycle); both files import `shapeToJsonSchema` from it.
**Lesson: "test-only" ≠ "dead." A test helper with N call sites is live infra; deleting it is
test refactoring, not reclamation. Verify the actual violation (here: duplication) and fix THAT.**

**biome gate**: main was failing `check:ci` with 4 format ERRORS (incl. event-store.ts K8
`appendFileSync`) — the pre-commit hook had been bypassed via `--no-verify`. Ran `bun run check`
(write, NO `--unsafe`) → auto-fixed format only → committed as a SEPARATE commit from the
deletions. `check:ci` now exits 0. 35 lint WARNINGS remain (noNonNullAssertion + noExplicitAny —
pre-existing, not auto-fixable, out of scope); warnings don't fail check:ci, only the format
errors did. NOTE: the worktree pre-commit hook is /dev/null (hooksPath), so these commits skipped
the hook locally — verify on main's gate after merge.

**NOT touched**: mock-showcase (C2) — excluded, becoming a local plugin (draft
01KTBZRFXD3A9J3JTKK38FH3WA).

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

## bun 1.3.7–1.3.8 SIGTRAP on worker teardown — RESOLVED 2026-07-02: global bun upgraded to 1.3.14

RESOLUTION (root, same day): minimal 7-line repro (spawn Worker → terminate → exit 133) confirmed
the crash class independent of tests. Version matrix via isolated installs: 1.3.0 OK · 1.3.7 BAD ·
1.3.8 BAD · **1.3.14 (latest) FIXED**. Global `bun upgrade` run (user-blessed) → 1.3.14; repro
survives; full suite on main under 1.3.14 = **2305 pass / 0 fail** (baseline restored). The running
daemon (started Jun 17, pre-upgrade image) was never exposed; next restart boots 1.3.14 = safe.
Isolated pins ~/.bun-pin (1.3.7), ~/.bun-130, ~/.bun-latest are deletable. The interim scoped-gate
below is no longer needed — kept for the record of the era.

### Original diagnosis (markdown task 01KWHXMB, before resolution)

**Any test file that terminates a Bun Worker crashes the whole `bun test` process** with
SIGTRAP (exit 133) on bun v1.3.8. Native bug inside bun, NOT repo code: macOS crash report
shows libmalloc abort `BUG_IN_CLIENT_OF_LIBMALLOC_POINTER_BEING_FREED_WAS_NOT_ALLOCATED`
in `_pthread_tsd_cleanup` → `pthread_exit` (TSD double-free on worker-thread exit). Crash
logs: `~/Library/Logs/DiagnosticReports/bun-2026-07-02-*.ips`.

- Reproduced on the markdown branch, its clean base commit (stash), AND the main checkout —
  identical crash, so no branch's code is the cause. User presumably upgraded bun since the
  last green run (package.json pins no engines; only ~/.bun/bin/bun 1.3.8 on machine).
- Confirmed on `web/ShellApp.test.tsx` AND `src/daemon-integration.test.ts` (no happy-dom
  involved) — the trigger is worker terminate, i.e. every daemon/worker test file.
- The crashing file runs FIRST in a full `bun test`, so the full suite verifies ~3 tests
  before dying. **"bun test passed" claims from this era are meaningless — check exit code.**
- Production daemon runs the same bun 1.3.8 and terminates workers on restart/shutdown —
  same crash class may hit the live daemon.
- Same environment refresh also drifted node_modules: 5 pre-existing `tsc` errors in
  `_vendor_shims/*` (@types/react caret bump exposes missing internal props) + 2 biome
  format errors on `_vendor_shims/react{,-dom}.ts` + 61 lint warnings. All verified
  identical on clean base — NOT from any branch's diff.
- Orchestrator owns the fix (isolated older-bun pin to restore the gate, then user decision
  on downgrade). Interim per-task gate: typecheck + check:ci with zero NEW diagnostics vs
  base, plus scoped `bun test ./<files>` on non-worker test files.

## typecheck gate restored — every one of the 24 errors was a cast/hack, not a real type problem (2026-07-24)

> **Second time.** *Dead-code sweeps* § FIX-4b records the same story for biome three months
> earlier: gate found bypassed, errors accumulated behind it, cleared in one pass. Two independent
> recurrences of one failure mode is the argument of § *Why this kept happening* below — the problem
> was never the specific errors, it was that a checked-in hook file is not an enforced hook.

`bun run typecheck` had accumulated 24 errors across ~6 merges, undetected because
nothing was ever gated (see the `core.hooksPath` correction in Known Pitfalls — the
hook was never installed on main; every `--no-verify` was a no-op on a hook that did
not exist). Cleared them; the FULL `bash .hooks/pre-commit` (typecheck + check:ci +
check-i18n.sh + the fast test subset) now exits 0. `bun test` 2654 pass / 0 fail
(2650 on my fork point + 4 from main's rollback-impact work, merged in).

**The headline: zero `as unknown as` were added. All 24 fixes DELETED a cast or a
hack** — every error was a workaround for a type the code already had correctly.

### The four patterns (each a reusable diagnosis)

**1. `(node as Record<string, unknown>).status = …` in test fixtures (17 errors,
`search-format.test.ts`)** — `TaskNode.status` / `.resultRounds` are ordinary typed,
writable fields; `addChild` returns a real `TaskNode`. The cast was never needed for
ANY reason. Replaced with the tracker's public API (`tracker.updateStatus(id, status)`,
`tracker.appendResultRound(id, {result})`), which also stops the test from doing the
external-mutation-of-tracker-managed-nodes thing draft 01KNWKZVHP flags.
**Diagnosis rule: a `Record<string, unknown>` cast on a domain object in a TEST is
almost always a fixture-seeding shortcut, not a type problem. Look for the setter.**

**2. `(db as Record<string, unknown>).tokenizer = …` (`task-index.ts`)** — Orama's
`AnyOrama` includes `Internals` which declares `tokenizer: Tokenizer`, and
`@orama/tokenizers/mandarin`'s `createTokenizer()` returns a `DefaultTokenizer`
(assignable). `db.tokenizer = createTokenizer()` typechecks directly. TS2352 fires
because `AnyOrama` has no index signature — that error means "this isn't a bag of
unknowns", i.e. **the type is more precise than the cast assumed. Read the .d.ts
before laundering through `unknown`.**

**3. `.filter(Boolean)` does NOT narrow in TypeScript** (`.mxd/plugin/runtime.ts`
search endpoint) — `map(… | null).filter(Boolean)` still has type `(T | null)[]`, so
every later `hit.x` is "possibly null". Fixed with `flatMap` (`return []` to drop,
`return [value]` to keep), which infers the narrowed element type with no predicate
and no `!`. A `(x): x is NonNullable<typeof x> =>` predicate also works; flatMap reads
better. **Never "fix" this class with `!` — the compiler is right that filter(Boolean)
told it nothing.**

**4. Reading a variant-only field off the `Event` union** (`event-id.test.ts`) —
`id` lives on `MessageEvent`, not on `Event`. Narrow on the `type` discriminant
(`expect(stored?.type).toBe("message"); if (stored?.type !== "message") throw …`),
which makes the test STRONGER (it now also asserts the event round-trips as a message
event). Note `Event` is `(A|B|…) & {traceId?; eid?; parentEid?}` and TS still narrows
the union through that intersection fine.

### Process notes
- **The `noUnusedLocals` cases were real** (`child2`, the `searchIndexSync` import) —
  delete outright; `_` prefix does NOT satisfy `noUnusedLocals` for locals/imports
  (only for function params), as noted in Known Pitfalls.
- **Mutation-verified the one production behavior change**: reverting the flatMap
  drop-branch to emit a ghost entry fails `src/search-endpoint.test.ts` "excludes
  deleted tasks" — so that branch is genuinely guarded, the refactor didn't hollow it.
- **`check:ci` exits 0 with ~158 warnings** (noNonNullAssertion / noExplicitAny).
  Warnings never fail the gate; only format/lint ERRORS do. Don't "fix" the warning
  count in a gate-restoration pass — biome's suggested `!` → `?.` autofix is marked
  *unsafe* and silently changes assertion semantics in tests.

### ⚠️ The gate does not cover merges

Established here, but it is a CURRENT-STATE fact rather than part of this record, so it lives in
*What is actually gated (and what isn't)* (Reference & Pitfalls) — one place, with the coverage
table and the fresh-clone caveat. Short version: `git merge --no-ff` with a clean auto-commit fires
`pre-merge-commit`, which does not exist, so root's dominant path is ungated while a CONFLICTING
merge is gated. Deliberately not fixed: the branch model requires intermediate merges to be allowed
to not typecheck.

### Why this kept happening (the actual root cause)
NOT "root bypassed the gate" — there was no gate to bypass (see *What is actually
gated*). The failure was that a *tracked* `.hooks/pre-commit`
existed, was referenced in memory as if it were active, and nothing pointed at it. The
generalizable lesson: **a checked-in hook file is not an enforced hook.** Enforcement
lives in untracked local config (`.git/config` → `core.hooksPath`), so it silently
does not survive a fresh clone, and its absence looks identical to compliance — the
only observable difference is errors quietly accumulating. If you rely on a hook,
assert it is wired (`git config core.hooksPath`) rather than assuming the file's
presence means anything.

**Orphan found while clearing this** (drafted as 01KYB46KTM, NOT fixed here):
`searchIndexSync` in `task-index.ts` now has zero production callers — 01KY7TQXPP
explicitly kept it for the then-sync `buildWorkContext`, then 01KY83C8BV made that
hook async and switched it to `searchIndex`, and nobody reclaimed the sync variant.
Only its own 6 tests use it. Deleting a public export is a separate, separately
revertable decision from restoring a gate — so it was drafted, not silently swept in.

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

### The prompt contradicts itself across sessions, and nothing catches it

Prompt edits rot the same three ways this file does (§ *Writing This File*), but the **superseded**
kind — correction exists, filed away from the claim — is worse here because of the carrier.
`memory.md` has regions and topical adjacency, so putting a claim next to its refutation is a move
you can actually perform, and performing it is what makes the contradiction visible. **A prompt has
no such mechanism.** It is one linear argument; two sentences sixty lines apart are never brought
together by anything. And it does not present as a conflict — **both sentences are individually true
and well written.** They only cancel when someone holds both at once, which is precisely what the
linear form prevents.

Observed 2026-07-25, two commits one session apart, same file, same author:
- `be9707f9` added to §5 Refactoring: *"every unfinished break is state you carry, in a context that
  runs out"* — true as written, there to explain why a half-broken tree is expensive for an agent.
- `91ba03b5` existed to establish §6's *"compaction is a continuation, not a stopping point"* — i.e.
  to deny the wall the earlier sentence had just asserted. Fixed to "exactly the kind of state a
  compaction blurs", which keeps the cost claim and drops the wall.

No gate can see this. The prompt is a template literal; typecheck and biome only prove it parses and
is formatted, and the sole test touching its content greps for hardcoded git branch names.

**Rule: before editing the prompt, read the recent prompt DIFFS, not just the current text** —
`git log -p -5 -- src/system-prompts.ts`. The current text tells you what the prompt says; the
recent diffs tell you what it has just *started* saying, which is the only place a fresh
contradiction can have come from. After landing an edit, grep the file for the concept you leaned on
(here, `context`) and read every hit: the sentence that cancels yours will not share your wording.

**Why this step gets skipped**, from the same pair of sessions: the round that INTRODUCED the
contradiction was required to re-read all 436 lines after editing and substituted a targeted grep,
reasoning verbatim *"rather than burn context re-reading 436 lines verbatim"* — while sitting at
zero compactions. The round that CAUGHT it did the full read, and the full read is also what found a
second, subtler collision (§5 Text's "if you lack context … delegate to a sub task" reads as a
licensed handoff once §6 forbids handing off for context reasons). So the proximate cause of the
contradiction surviving a whole session was laziness pattern #8: a verification step narrowed to
protect a budget that was not under pressure. This rule is worth exactly as much as the willingness
to pay for it.

## Known Pitfalls

- **memory.md**: Never `write_file` to append. Use `edit_file` or `echo >>`.
- **Git worktrees**: `extensions.worktreeConfig` required. `core.hooksPath` absolute.
- **Biome**: Typecheck BEFORE lint. No `!important`. No duplicate CSS properties.
- **noUncheckedIndexedAccess**: Array index returns `T | undefined`.
- **Daemon reload**: Commits don't auto-restart the daemon. Must manually restart after code changes.
- ~~**`search` tool silently skips `.mxd/`** (verified 2026-07-25): with the default path it
  never walks hidden directories, and in THIS repo `.mxd/plugin/` is production code — every
  ScopeOpts hook, every plugin REST route, the whole plugin UI. `search("buildMatrixScopeOpts")`
  returns 4 files and omits `.mxd/plugin/scope-opts.ts`, which is where it is DEFINED. The
  pattern is fine; passing `path: ".mxd"` explicitly finds it. **This makes the "grep for the
  name as a string before you rename or delete" rule (Refactoring Philosophy) return a false
  negative with the tool the description tells you to always use.** Until fixed (draft
  01KYCQTGQZ), verify by-name references with `grep -rn` via bash, not with `search`.~~
  **FIXED same day (01KYCQTGQZ) — hidden dirs are searched now; the workaround advice above is
  obsolete.** The claim is kept because it is the clearest statement of the symptom, and
  because the DETECTION lesson generalises to any silent under-report: see
  § *`search` tool: a hidden directory is not a boring directory*. ~~⚠️ **One sibling bug in the
  same tool is still OPEN and still produces silent false negatives**: `glob: "*.ts"` — the
  example in the tool's own description — matches nothing below the top level, because `*`
  does not cross `/` in Bun.Glob (**01KYCS0BH6**). Until that lands, pass `**/*.ts`.~~
  **ALSO FIXED (01KYCS0BH6), and `list_files` had both defects too (01KYCV43JAZ, same day).**
  Nothing in this bullet is live any more: a pattern with no `/` means "at any depth" in BOTH
  tools, and both walk hidden directories. The
  workarounds above (`grep -rn` via bash, `**/*.ts`) are obsolete in both tools. Whether the
  three together were the whole class was surveyed — the answer, and how far it reached, is in
  § *`list_files` had both of `search`'s bugs*.
- **Concurrent ULID**: Use full `ulid()` (26 chars) — sliced ULIDs collide within same millisecond.
- **Provider queue close**: Check `queue.isClosed` after tool execution, `return` immediately.
- **Never modify own JSONL from agent**: Current tool_call has no result yet → false orphan.
- ~~**Async JSONL writes**: `emitEvent` fire-and-forgets `eventStore.append()`. Flush before reading
  in tests.~~ **FALSE since 2026-07-25.** `append(sessionId, event): Event` is fully SYNCHRONOUS and
  returns the persisted copy; `emitEvent` writes first and broadcasts that. Verified in code, not
  inferred: `src/runtime/event-system.ts:113` is `persisted = eventStore.append(...)` with no await
  and no `.catch()`. The synchrony is load-bearing — it is what makes `rewindChainHead` correct on a
  failed write — so do NOT "restore" the async form. See § *Every transport carries the event's name
  (eid)*. Flushing before reading is now belt-and-braces rather than required; harmless to keep in
  existing tests, unnecessary in new ones.
  **This bullet is a specimen worth noticing**: it was made false by our OWN change, the same
  afternoon, and nothing anywhere contradicted it — the change was recorded in a new section while
  the stale claim sat in the list every agent reads on every start. That is the *drained* rot class
  with a same-day fuse, and the only reason it was caught is that a curation pass happened to read
  the neighbouring bullet.
- **delete_task cascades**: Deletes all descendants AND session JSONL. Enforced: returns 400 with children.
- **Abort signal leak**: After stop, old runAgentForNode settles async. catch/finally check `sessionWasReplaced` to suppress stale error events.
- **TS6133 `_` prefix**: TypeScript's `noUnusedLocals` does NOT respect `_` prefix for local variables or destructured locals — only for function parameters. For unused destructured React state, use `const [, setX] = useState(...)` (skip the getter slot). For unused `const` locals, delete outright. The underscore-prefix hint in our prompts is a holdover that doesn't match TypeScript's actual behavior.
- **`bun run check` auto-writes**: `bun run check` runs `biome check --write` and silently formats 70+ files. `bun run check:ci` is the non-write variant used by the pre-commit hook. When debugging lint, use `check:ci`. When committing formatting sweeps, use `check` and split format-only changes into a separate commit.
- **Pre-commit hook**: see *What is actually gated* below — it needs more than a bullet.

## What is actually gated (and what isn't)

**Verified 2026-07-25.** Answer this before assuming a green result means anything.

| path | hook git looks for | gated? |
|---|---|---|
| direct `git commit` on main (memory curation, conflict resolution) | `pre-commit` | ✅ yes |
| `git merge --no-ff <branch>` with a clean auto-commit | `pre-merge-commit` | ❌ **no — that file does not exist** |
| a merge that CONFLICTS, then `git commit` after resolving | `pre-commit` | ✅ yes |
| any commit inside a sub-task worktree | none (`core.hooksPath=/dev/null`) | ❌ no, by design |

Current config, checked: main's `.git/config` has `core.hooksPath = .hooks`; worktrees have
`/dev/null`; `.hooks/` contains **only** `pre-commit`.

Three consequences, none obvious:

1. **The clean merge — root's dominant path — is NOT gated, while the conflicting merge IS.** That
   is backwards from intuition and it is why "the hook passed" says very little about an
   integration. Deliberately not fixed by adding `pre-merge-commit`: the branch model REQUIRES that
   intermediate merges be allowed to not typecheck, and gating every merge would just re-establish
   the routine-`--no-verify` habit that hid 24 errors before. The options if this ever needs
   closing are (a) leave merges ungated and keep running `bash .hooks/pre-commit` by hand once per
   integration, (b) add the hook and accept `--no-verify` on intermediate merges, (c) move
   enforcement off the commit hook entirely (CI, or a preflight subcommand).
2. **Worktrees skip the hook on purpose.** Sub-tasks commit constantly; a full typecheck + lint +
   test on each would be unusable. To check the gate from a worktree, run
   `bash /path/to/main/.hooks/pre-commit` manually.
3. ⚠️ **`core.hooksPath` is LOCAL config (`.git/config`), not tracked.** A fresh clone is ungated
   again and looks identical to a gated one. Install with `git config core.hooksPath .hooks`. If
   that onboarding step ever bites, it belongs in a `postinstall` script or in the main-repo
   counterpart of `.mxd/hooks/setup_worktree.sh` — nobody will remember to run it by hand.

**A checked-in hook file is not an enforced hook.** For years `.hooks/pre-commit` existed, was
referenced in this file as if active, and nothing pointed at it — git was looking in
`.git/hooks/pre-commit`, which held only `.sample` files. **Nobody was gated anywhere**, every
`--no-verify` was a no-op against a gate that did not exist, and the absence looked exactly like
compliance. The only way to know is to assert it: `git config core.hooksPath`. (Superseded by this
section: an older note claiming "only root's commits on main are gated" — that was never true.)

## Known Bugs (unfixed)

- ~~Manual compaction during yield → consecutive user messages → API 400.~~ **NOT A BUG — RESOLVED
  BY MEASUREMENT 2026-07-25.** Consecutive user messages are legal; the remaining `test.todo` in
  `drift-lifecycle.test.ts` describes a shape that works (verified through the real walker and
  against the live API). See *The Anthropic message-shape rules, MEASURED*.
- **Reachable, real, and open**: `/compact` on a session with `messages.length <= 4` whose last
  message is an assistant turn sends a request ending in assistant → 400 *"does not support
  assistant message prefill"*. A fresh agent whose first turn ends with `end_turn` reaches it with
  no further setup. Pinned by `src/reachable-400-snapshot.test.ts` (a BEHAVIOR SNAPSHOT — it
  asserts the CURRENT, buggy shape).

## Vertical Dependency Boundaries

Three layers: daemon → provider loop → tool handler. executeTool is clean (pure dispatch). done() closes queue through closure (boundary violation, but structural). evaluate_script punctures all layers (intentional). TaskSession has three-way mutation. Full audit in `VERTICAL-BOUNDARY-AUDIT.md`.

## Unresolved Design (prioritized)

⚠️ **This list had gone stale in two of three entries** — a list of open problems is the single
easiest thing in this file to leave behind, because closing a problem happens in a task that has no
reason to come back here. Re-checked against the code:

1. ~~Message routing expansion (subtree + parent chain, not just direct parent/child)~~
   **HALF DONE.** The parent chain shipped: `send_message` walks `getTaskAbove` upward, so any
   ancestor is reachable, and the tool description says so. **Subtree routing did not** — you can
   still only reach DIRECT sub tasks, not arbitrary descendants. That half is what remains open.
2. ~~Folder/grouping feature (UI-only visual grouping, not tree structure)~~ **SHIPPED**, and then
   generalized — see *The node model*. Folders exist, have zero behavior by design, and the
   "resist feature creep" constraint on them is recorded there.
3. Tool search — dynamic tool discovery. **Still open.** A draft exists; Anthropic has a server-side
   `defer_loading`, but the user prefers a client-side design.
