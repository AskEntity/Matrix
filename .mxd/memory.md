# Matrix Project Memory

> Read on every session start. This file exists to record what the code cannot record about itself:
> why the obvious simplification fails, what has already been checked and ruled out, and how to
> operate here. Full design doc: `Matrix.md`.

## How to run tests — the command is exactly `bun test`

**`b u n (space) t e s t`. No flags, no arguments, no pipes, no redirects, no `&&`, no `2>&1`.**
If what you are about to send to bash is not byte-identical to `bun test`, stop.

```bash
bun test              # ALL tests (src/ + web/)
bun run typecheck     # tsc --noEmit
bun run check         # biome — WRITES, and silently formats 70+ files. `check:ci` is read-only.
```

**Piping is not size reduction, it is data loss.** The bash tool already merges stdout+stderr and
already bounds what reaches you: over 10KB it shows head 5KB + tail 5KB and preserves the **whole**
output in a file whose path it prints. A pipe consumes the stream before the tool ever sees it, so
whatever `head`/`tail`/`grep` did not match is gone from the universe — not truncated, not on disk,
not recoverable. The failure repeats with the same shape every time: pipe to `tail -8`, see
`2116 pass / 2 fail`, discover you cannot see *which* two, re-run with `| grep fail`, get a
different flaky subset because scheduling differs per run, and spend hours chasing a test that was
never failing. Run it bare and read the saved file.

**Copy the output path out of the tool result. Never type one from memory.** The directory is
`mxd/` under the OS temp dir, which on macOS is the per-user `$TMPDIR` (`/var/folders/…/T/mxd/`) and
is **not** `/tmp`. `/tmp/mxd/` exists on a Mac and is empty, so a remembered path gives you "the
tool lied to me" instead of your output.

**Tests are independent and flake at the scheduling level** (port conflicts, filesystem races,
timer precision). There is no file ordering guarantee, so "let me just run the failing file" may not
reproduce it, and a `grep` run afterwards is questioning a *different* run than the one that failed.
Suspect a flake? Run `bun test` five times and read all five saved files.

Do not record test counts in this file. They were ~500 short within three months, and a stale count
is indistinguishable from a fresh one.

## Language

Code, task tree and this file: English. `Matrix.md`: Chinese. Agent replies follow the sender's
language.

## How work moves through this repo

**Root never commits code to main.** Not because "root delegates" as an abstract rule — because a
direct commit destroys clean rollback. A wrong fix that went through branch→merge reverts as one
operation. A wrong fix committed straight to main is interleaved with main's history and there is
nothing clean to revert. We have cleanly reverted both a wrong-semantic merge and a
wrong-architecture merge as single-commit operations, and only the branch model made that possible.
Two gates before root touches any code: *could this fix be wrong?* (any code change could — always
yes) and *if it is wrong, do I want `git revert <merge>` to be one operation?* (yes). Yes plus yes
means it goes through a branch, with no exception for "it's small" or "I'm sure". The only
direct-to-main operations are merge-conflict resolution, memory.md curation, and task-tree
management. This is a property of the product's commit model, not a policy preference.

**Whoever introduces a change owns every consequence of it** — prompt, UI, tests, docs, i18n.

**Creating tasks is cheap; executing is deliberate.** While the user is discussing a design, draft
and discuss. Start when they say go.

**Merging is signing, and a green hook is a floor rather than a ceiling.** The hook checks syntax,
types and pass count. It does not check whether the diff addresses every point of the task, whether
layer boundaries held, whether the commit message matches the code, or whether the child's
self-report matches the diff — and the last of those differs non-trivially, because a child reports
what it *thinks* it did. Read `git diff main...<branch>` line by line before merging. The observed
failure always has one shape: child done → `git log --oneline` + `--stat` → merge → post-merge bugs
that a manual smoke caught immediately. Watch for single-line catastrophes (`autoRegisterSelf:
false` shipped exactly this way) and for matrix-specific code leaking into daemon or shell.

**`evaluate_script` is runtime introspection only.** Never use it to reparent tasks, edit the tree,
or run batch operations. Fix the tool instead.

## The shape of the system

```
Daemon (src/daemon.ts — Hono HTTP shell, :7433)
  ├── Auth, project CRUD, config CRUD, plugin discovery
  ├── Web build (Bun.build → importmap + vendor React + shell + plugin)
  ├── SSE relay (ring buffer + Last-Event-ID catch-up)
  └── Worker (src/runtime/scope-worker.ts — one per plugin)
        └── Runtime (src/runtime.ts — agent lifecycle, tools, JSONL, MCP)
              └── Plugin (ScopeOpts: tools, prompt, hooks)

CLI (mxd) → HTTP → Daemon.   Browser → Daemon (assets + SSE) + Worker (API forwarding).
```

- **Daemon** owns auth, projects, config, SSE, web build. It holds no agent logic.
- **Worker** is a Bun Worker thread running the runtime: agents, tools, JSONL, trackers.
- **Plugin** is `.mxd/plugin/` — ScopeOpts plus a web component. Matrix is itself a plugin,
  discovered by the same scan as any other; it is not special-cased anywhere.
- **Shell UI** (`web/`) is auth, header, project/scope selector. Plugin UI is a compiled React
  component library, not an SPA, loaded with `React.lazy`.
- Agent tree = task tree. Each task gets a worktree and a branch off its parent's branch.
- Three-layer config: global < repo < local. Two providers: Anthropic, OpenAI Responses.

**Files whose name does not tell you the thing you need to know.** Everything else is findable with
`list_files`; this is the exception set. It fails by OMISSION — nothing ever contradicts it, it just
quietly stops being the answer to "where do I start" — so if you add a file a newcomer must find,
add the row.

| file | the part you would not guess |
|---|---|
| `src/data-paths.ts` | THE resolver for every path built from `dataRoot`. A grep test fails if a second site computes one, anywhere in the repo. |
| `src/done-payload.ts` | the one source for done()'s content shape. Imports only zod, so the type layer and the tool layer can both import it without a cycle. |
| `src/orchestrator-tools.ts` | every matrix tool definition **and** `buildAllToolDefs`, from which the external-MCP tool list is built |
| `src/event-store.ts` | append-only JSONL. eid/parentEid chain, `setChainHead` for rollback and repair. **Never truncates.** |
| `src/events.ts` | event types, `buildSessionRepair`, and `walkActiveChainIndices` — the ONE definition of "which events count" |
| `src/task-operations.ts` | the shared CRUD ops. MCP and REST are both thin wrappers over these. |
| `src/test-utils/api-message-rules.ts` | the MEASURED Anthropic message-shape rules, and the prefix-vs-sendable split |
| `.mxd/plugin/scope-opts.ts` | `buildMatrixScopeOpts` — the one place that knows matrix's tools, prompt and hooks |
| `.mxd/plugin/web/event-handler.ts` | UI event → log entries. `queueEntryToUIEvent` is the materialization gate; `pendingReducer` is pending. |
| `.mxd/plugin/message-editability.ts` | where the three Edit/Rewind judgments meet, and the only place they may. Has zero imports, asserted by a test. |

## Changing code here

**Every bug fix asks two questions, not one.** What caused this specific bug, and why does the
architecture make this *class* of bug easy? The recurring answers: duplicate codepaths, lifecycle
dependency coupling, legacy fallbacks masking bugs, lazily-optional fields.

⚠️ **The compiler enumerates only what it can TYPE.** Anything reaching a symbol *by name* is
invisible to it: string-keyed dispatch, an event-type name matched across a process boundary, a
field an external system keys on. **The compiler's silence means "nothing typed points here". It
never means "nothing points here".** So grep for the symbol as a *string* before trusting the error
list, and check every boundary the type system does not cross. The asymmetry is what makes this
worth a paragraph: a typed break costs one compiler error and ten seconds, while a name-based break
costs a silent, delayed, hard-to-attribute failure in a system you were not looking at. Deleting the
`agent_idle` event type would have hung every external `send_user_message → yield_external →
get_logs` workflow until timeout, because `yield_external` matches the type NAME in a string set —
and the same class had already bitten us unnoticed for months, with `WAKE_SIGNALS` still listing
`agent_stopped` and `orchestration_completed` long after both names were replaced, so a stopped
agent could only ever wake an external client by timing out.

### Deleting a mechanism built on a false premise: separate the PREMISE from the OBLIGATION

Having shown that the stated reason for some code is wrong, do **not** delete on that finding alone.
For each block answer two questions separately: what did it claim to prevent (the premise, now known
false), and what does it actually still do (the obligation, possibly real and load-bearing)? Delete
only where the obligation is empty. Where it is real, keep the effect, relocate or re-justify it,
and rewrite the comment to name the true reason.

**Skip this and you delete a real guarantee along with the phantom, silently** — the premise was
false so nothing was protecting the obligation, and the tests that covered it were usually written
in the phantom's vocabulary too, so they go green or get "fixed" on the way out.

⚠️ **A mechanism built on a phantom can also be actively harmful, so "harmless, leave it" is not the
safe default it looks like.** Check for a COST, not only for redundancy — and the cost is usually
written in the mechanism's own comment as an accepted trade-off. One such block answered every
`done()` tool_call, which made resume detect a generic interrupted-resume instead of a done-resume,
so the woken agent silently lost its done-resume context. Reverting it was a behavior fix.

## Where agents predictably go wrong

These are not hypotheticals; each has cost us real work.

1. **The broken intermediate state feels more dangerous than it is.** Fear of a large change
   produces a revert, or a fallback that keeps the old path "just in case". Both are worse than the
   break: two codepaths drift silently and nobody knows which one ran. Delete until ONE remains.
2. **The existing shape is not a given.** "Why does this exist" beats "how do I make this work". And
   a "unification" that adds a third path is not a unification.
3. **Imagined requirements get built.** Building a tool or analyzer, agents default to handling every
   case they can imagine: classifications, category labels, filter flags, pattern-matched
   explanations. Each branch corresponds to an imagined need, not an observed one; half end up dead,
   and the live half often hides the data patterns a raw dump would have shown. **Start with the
   simplest raw dump and add heuristics only when real use exposes a concrete need.** A 50-line dump
   beats a 500-line smart analyzer whose categories were invented at design time.
4. **"Start something new" wins locally and loses globally.** When a requirement appears, three
   options exist: create a task fresh, create and fork context into it, or `send_message` an
   existing (closed, verify, pending) task. The third is often correct and loses on every cheap
   dimension — fresh description vs stale, clean session vs unknown state, one step vs two, and the
   word "closed" reading as "finished" — so agents take the first and fragment context across
   redundant trees. The same shape appears as handing work to a fresh agent instead of continuing.
   Prompt alone has not fixed this; the mechanism design is draft `01KNZGYY4T6SYWVT66DK13XCPV`.
5. **Context is a compaction boundary, not a deadline.** An agent that feels low on context starts
   planning a handoff, cutting scope, or asking to be replaced. When context fills, the agent
   continues from a summary; the task description and this file survive compaction by construction.
   So a compacted agent strictly DOMINATES a replacement — same durable documents, plus a summary of
   its own work, plus whatever tacit judgement survived. Running low is never a reason to hand off.
   The only legitimate reason is that FAMILIARITY ITSELF has become the liability: a final
   read-through, an adversarial review, anything where not knowing the material is the requirement
   rather than the cost.
   **Measured 2026-07-25**, because the claim that agents estimate their own budget badly had no
   numbers under it. The agent offering a handoff was at 2.0M tokens / 891 events having **never
   compacted once**, and estimated 2-3 sections left in it. Told to continue, it finished all 5
   remaining plus an extra debt, ending at 3.0M / 1191 events, still zero compactions — roughly
   twice its own estimate, never reaching the boundary it budgeted against. Two sibling tasks that
   day sat at 2.0M / 928 and 2.0M / 649, also zero compactions. That is one day, one model, one
   config: read it as "the estimate was off by ~2× and the wall was nowhere near", not as a
   threshold. For where a session actually stands, count its own events and `compact_marker`s.

## Hard invariants

Violating any of these produces silent corruption rather than an error. The reasoning for each lives
in its own region; this is the index.

- **JSONL content fidelity.** What is written to JSONL is byte-identical to what was sent to the
  API. No `.slice()`, no truncation on persisted content. UI truncation happens at the rendering
  layer only.
- **Tool results are three-part.** Every tool_result must (1) emit to JSONL, (2) yield to SSE, and
  (3) push to `messages[]`. Missing any one gives an orphan, a missing UI entry, or an API 400.
- **Nothing writes to JSONL after a yield tool_call except the provider loop.** External events go
  to the queue, not to JSONL.
- **Persist before broadcast.** `emitEvent` writes to JSONL first and broadcasts the *stamped* copy,
  so every observer — SSE included — gets the event's durable name (`eid`/`parentEid`) at the
  instant the event exists. `append`/`appendBatch` are fully synchronous and return the persisted
  event; that synchrony is what makes chain-head rewind correct on a failed write, so it is
  load-bearing, not a style choice.
- **`deliverMessage` is THE message delivery path**: JSONL write → queue delivery → flush →
  auto-launch. No other code writes message events to JSONL.
- **One codepath per task operation.** `src/task-operations.ts` holds create/update/delete/close/
  reset/reorder. MCP and REST are thin wrappers; behavioral differences are explicit
  (`if (editedBy === "user")`), never a second implementation.
- **Messages have a two-phase lifecycle.** `message` persisted → frontend defers; `messages_consumed`
  → frontend materializes. `QueueMessage.ts`, `Event.ts` and the displayed `[HH:MM:SS]` are all the
  same value, set once at creation.
- **Recovery must touch JSONL, not just memory.** In-memory `messages[]` and the JSONL events are
  two data structures. A "fix" that only edits `messages[]` leaves the poison on disk and it comes
  back on the next resume.

## ⚠️ Writing this file

Full reorganization procedure: `.mxd/memory-reorg.md`. What follows is what you need when writing or
updating an entry, which is every session.

**What earns a place.** Code can state what it does. It cannot state why the change that looks like
an improvement is wrong. So: *if a reader of this code would want to simplify it, this file must say
why that fails; if nobody would touch it, this file should say nothing.* Do not ask "is this
useful" — the answer is "somewhat" for every entry ever written, and that is how the file reached
7,616 lines. Four things survive that question: how to operate here and what happens if you don't;
why the design is shaped this way; **the places that look wrong but are right**; and negative
results ("checked, it is not that"), which are recorded nowhere else because nobody opens a task for
"it wasn't that".

**Write the current design as one narrative, not as a sequence of amendments.** A past state earns
its lines only when a reader without it could not justify the current design, or would likely
reintroduce the old one — and then it is not history, it is a guardrail, and must be written as one:
*"do not change Z back to Y; Y silently loses history when W"*. If you cannot write that sentence,
delete the old state instead of striking it through. Strikethrough-plus-pointer produces a
changelog, and a changelog is what every reader pays for on every launch.

**Compression is not terseness.** Line count falls because seven sections became one, not because
sentences became telegrams. Write every surviving sentence out properly.

**Three kinds of rot, three detectors, none substituting for another:**

| kind | is a correction written down anywhere? | what finds it |
|---|---|---|
| **Superseded** — a later change invalidated this | yes, but filed under the change, never under the claim | putting claim and correction in the same region |
| **Drained** — a count or list quietly stopped being true | **no.** Nobody thinks they are correcting anything | checking against the source, item by item |
| **Destroyed by understanding** — a curator deleted it as redundant | the content was there until we removed it | being forced to enumerate what you dropped |

The drained kind has **no trigger at all**: a stale count and a fresh count look identical, so the
interval between deliberate passes is how long a wrong number survives.

⭐ **Symptoms are the retrieval key, and the third rot kind eats them.** This file is organised by
cause and queried by symptom: the reader arrives holding "the buttons are missing", not "the event
type was renamed". A symptom looks most redundant exactly when you have just understood its
mechanism, which is exactly when it is most needed. Keep the conditional form — *"if you break this
invariant, you will see X"* — and cut the perfect tense — *"in July we had a bug where the buttons
disappeared"*, which is addressed to nobody.

**Rules:**

1. **If something else is the authoritative source, point at it rather than snapshotting it.**
   Interfaces, counts, file paths, file lists — and equally another task's `done()` result, a config
   value, an upstream doc. Write what the source cannot answer: why it is shaped this way, what bit
   us, which rule is load-bearing. "See the `test.todo`s in X" stays true; "3 remain" does not.
   ⚠️ Reading this as "documentation vs code" is too narrow, and that misreading is how a
   hand-compressed copy of two task results ended up in a task description, written before those
   tasks had even finished.
   ⚠️ **A MEASUREMENT is a record, not a snapshot, and deleting it destroys evidence.** "99.8% cache
   hit (582 creation / 362K read)" is proof that four specific fixes worked and stays true about the
   moment it describes. What rots is the present tense. Date it, say what it measured, say where the
   current value lives. **Delete claims; keep measurements.**
2. **Name things for what they ARE, not where they came from.** A check called "the phase-1
   invariant" gets switched off after phase 1 — precisely when it starts being useful.
3. **Anything probabilistic: one passing sample is not verification.** The complement of mutation
   testing — that one makes a test fail on purpose, this one says a single green proves nothing.

**Daily maintenance, all cheap:**

- Changed an identifier? Grep it in this file.
- **Approved a side effect?** Grep for that too. Reviewing is how an `agent_idle` behavior change
  went unrecorded for months.
- About to leave a sentence standing as CURRENT? Verify it first. Moving a sentence under a
  "current state" heading is **endorsing** it, not relocating it.
- **Promised to do something later, once some condition holds?** Create a draft task for it *at that
  moment*. A promise whose trigger exists only in one agent's context does not survive that agent
  being interrupted, and it fails silently because nothing records that it was owed.

---
# The Agent Loop
---

## How an agent runs, parks and wakes

Root and child agents use the same launch function, `runAgentForNode` in `agent-lifecycle.ts`.

**The loop parks in exactly one place.** `handleImplicitYield` is where every path that stops
working ends up — explicit `yield()` (intercepted by the provider before `executeTool`), `end_turn`
(an implicit yield, never an implicit done), a done-resume waiting for messages, and an interrupted
turn. Keeping one park is what stops "what is this agent waiting for" from becoming five states.

**On resume, four states are read off the JSONL shape**, not off any in-memory flag:

| shape | meaning | what happens |
|---|---|---|
| last tool_call is `yield` | explicit yield | bypass straight to `queue.wait` |
| last tool_call is `done` | pending done | wait for messages, then write the done tool_result with wake context |
| `hasPendingImplicitYield` | ended on `end_turn` | bypass to `queue.wait` → `handleImplicitYield` |
| orphaned tool_calls repaired | interrupted | non-blocking queue drain → API call |

There is no named helper for the explicit-yield case — `provider-shared.ts` reads it straight off
the JSONL. Don't go looking for one; a `hasPendingYield` used to exist and was deleted with zero
production callers. `hasPendingImplicitYield` (events.ts) is the implicit-yield one and is live.

**`launchingNodes` guards the window between "we decided to launch" and "the session exists".**
⚠️ **Never add a node to `launchingNodes` from outside `runAgentForNode`.** `autoResumeProjects`
once pre-registered every node it was about to launch; `runAgentForNode` checks the set and returns
early, so no agent ever started. The lock is acquired atomically at the top of
`ensureChildAgentRunning`, in one synchronous tick with no await before `beforeChildLaunch` — that
placement is the fix for a real race, because `git worktree add` takes seconds and two concurrent
launches both used to get through, with the loser's throw marking the node `failed` and sending a
bogus `task_complete(failed)` to the parent while the winner was still running. A caller that
already holds the lock passes `launchLockHeld`, and `runAgentForNode` then takes over releasing it
on **every** exit path including the early "session already running" bail, so the caller cannot leak
it. `beforeChildLaunch` is the SOLE worktree creator; the inline `wm.create` that `send_message`
used to do, and the REST `/continue` path that called `beforeChildLaunch` outside the lock, were
both deleted rather than made careful.

**The session-identity check in the `finally` block** prevents a dying agent from clobbering the
cleanup of the replacement agent that was launched to succeed it.

**Retry backoff must be abort-aware.** Both the inner per-call retry and the outer retry
(`abortableDelay`, 30/60/120s) race their sleep against the abort signal and re-check
`signal.aborted` afterwards. Without that, a transient error parks the loop in a sleep, and a
stop/reset blocks for up to 120s — past the daemon's 60s worker-forward timeout, producing a 504
plus a retry racing the still-running first reset. ⚠️ **Test this with `stopTask`, not `stopAgent`**:
`stopAgent`'s bounded 1s race masks the block entirely.

**There is no in-memory recovery from a 400.** The old mechanism — pop the broken user message,
splice in synthetic tool_results, retry once — was removed and its flags no longer exist. A
non-transient 400 propagates, the agent stops, and the status stays `in_progress` so it is
resumable; the next launch runs `buildSessionRepair` on the JSONL **before** the provider loop
starts. The fix lives in persisted state rather than in volatile `messages[]`, which is the general
rule for this codebase. Transient errors (429, 5xx, network) are still retried in-loop.

## done() is two-phase, and both of Phase 2's invariants were learned the hard way

**Phase 1 is agent-side**: close the queue, exit the loop, no status update. done() is an *intended
orphan* like yield — no tool_result is written. **Phase 2 is daemon-side**: status → verify/failed,
`task_complete` to the parent, and a `done_notified` marker for crash recovery.
`findInterruptedDonePhase2` completes an interrupted Phase 2 on restart. `session = null` is the
irreversibility boundary, and Phase 2 runs after session cleanup.

⚠️ **The loop promise must settle on EVERY path.** Phase 2 is wrapped in try/catch/finally with the
`agentLoopPromises.delete` and the resolve inside the `finally`; a throw anywhere in Phase 2 is
logged and not rethrown, because the task already did its work and a Phase-2 hiccup is not an agent
failure. The reason this matters is not tidiness: `stopTask` awaits that promise with **no timeout**,
so one leaked promise hangs the stop forever.

⚠️ **`task_complete` must be DURABLE before `done_notified` is written.** Both are awaited and the
parent's store flushed before the marker. The marker means "Phase 2 finished", so if it can land
while `task_complete` has not, a crash in that window leaves the parent waiting forever with nothing
to re-deliver. The reverse window — marker written, crash before its own flush — re-delivers on
restart, giving a duplicate completion. **That asymmetry is the whole reason for the ordering: a
duplicate completion is recoverable, a lost one hangs the parent.** The naive version is easy to
write and looks fine — a fire-and-forget `deliverMessage(...).catch()` followed immediately by
`emitEvent(done_notified)` — because the marker lands on *this* node's write queue synchronously
while `task_complete` goes through `await getTracker` first.

**Auto-launch failure IS task completion**, and must be reported through the same channel. When
`beforeChildLaunch` throws (missing hook file, worktree creation fails), the target never runs, so
no done() ever fires, so no `task_complete` is ever delivered, and the sender's `yield` hangs
forever. The catch in `deliverMessage` emits an error event, marks the node `failed`, and delivers
`task_complete(success: false)` to the task above — the sender's yield then wakes through the
existing resume flow with no new code path, because "failed before starting" and "failed during
work" are indistinguishable from the sender's side. **Design rule: any code path that could silently
hang a yielding parent must notify via `task_complete`.** Root launch failure is not handled — root
has no task above it, and that is a separate problem.

⚠️ **Phase 2 crash recovery must deliver `task_complete` with `quiet: true`.** Without it the
delivery auto-launches the parent, and `autoResumeProjects` launches it too — a duplicate launch.
Quiet still persists the message to JSONL, and `findUnconsumedMessages` recovers it when autoResume
gets there.

Two things that look like duplicate-launch bugs and are not: after a crash,
`orchestration_completed` never emitted, so `orchestration_started` from before the crash plus one
from the resume is **two consecutive starts and is normal** — assert on `traceId` uniqueness
instead. And in a restart test, `shutdown()` is required before `recreateApp()`, or the old app's
agent stays alive and the new app launches a second one for the same node; in a real crash the
process is dead, so that shape cannot occur in production.

## Duplicate yield or done in one turn

The API can return several `yield` tool_calls in the same assistant turn. Two rules, both live:

1. **Repair skips the INTENDED orphan, which is specifically the LAST tool_call** — not "any
   yield/done". Earlier yield/done orphans in the same turn are genuine repair targets and do get
   interrupted results. The first version of this rule said "skip yield/done", which was too broad.
2. **Extras emit to JSONL immediately** (orphan prevention) **but their live-path construction is
   DEFERRED** via `pendingDuplicateYieldExtras`. On yield wake they bundle into the same
   `buildUserTurn` call as the real yield, producing ONE user message of
   `[...extras, real, ...queue]`.

⭐ **The deferral is a live/walker BYTE-IDENTITY device, not an API-shape device.** This is the
reusable rule and it was wrong for a long time:

> Deferral is REQUIRED when the deferred tool_result is PERSISTED and lands ADJACENT to another one
> in JSONL, because the walker's collection loop merges adjacent tool_results into one user message
> and the live path must match. It is UNNECESSARY when the message it would merge into is TRANSIENT.

⚠️ **Do not "simplify" `pendingDuplicateYieldExtras` away by analogy with the compaction deferrals
that were deleted.** Nothing separates the extras' results from the real yield's in JSONL (the
walker skips `message` events), so splitting the live push would require inventing a JSONL boundary
event — strictly more machinery. The two compaction deferrals were removable for the opposite
reason: the summarization instruction is never persisted at all, so nothing reconstructs it and
there was nothing to stay byte-identical with. Both compaction sites now emit the tool_result and
push its turn on the spot via one `emitAndPushCompactToolResult` generator.

The justification these three sites *used* to share — role alternation — does not exist; see
*The Anthropic message-shape rules, MEASURED*. What survives it is the **pairing** obligation: the
assistant's yield/done `tool_use` must be answered before the request goes out. That is real, it is
why the extras still ride in the same turn, and it is why the compaction paths still push them.

⚠️ **Duplicate `done()` calls must exit as orphans. Do NOT emit tool_results for all of them.** That
was tried, to avoid a repair path; it works, and it costs behavior — with every done answered, resume
detects a generic interrupted-resume instead of a done-resume, so the woken agent silently loses its
done-resume context. Reverting it was a behavior fix, not a style cleanup.

## Compaction: the two ways it bricks a session

**A too-short compact must NOT emit `compact_marker`.** The `messages.length <= 4` branch used to
emit `compact_started` + `compact_marker` without rebuilding context — no `session_config`, no
`compacted_resume`. On restart, `readActive()` returns only post-marker events, so the session starts
on an assistant turn, and the API rejects it permanently. The branch now emits only a status, resets
`manualCompactRequested`, and — this is the part that is easy to drop — **consumes any pending
yield/done tool_result and the duplicate-yield extras**, so the assistant's `tool_use` blocks have
matching results.

⚠️ **That branch has a live, reachable hole that is NOT fixed**: it clears the flag and `continue`s
with nothing pushed, so the next iteration sends a request whose last message is the ASSISTANT one,
which really is a 400 (*"does not support assistant message prefill"*). A fresh agent whose first
turn ends with `end_turn`, followed by `/compact`, reaches it with no other setup. Pinned by
`src/reachable-400-snapshot.test.ts`, which asserts the CURRENT buggy shape.

**Compact messages never get `messages_consumed`.** `handleImplicitYield` filters them out of
`nonCompact` and only `nonCompact` is recorded, so on restart `findUnconsumedMessages` re-enqueues
the compact and the next session sees a spurious `manualCompactRequested`. Real, still there, no
known bad effect — the consequence it was once blamed for was the alternation phantom.

**Session config is refreshed at the compaction boundary, and only there.** Compaction wipes
`messages[]`, so the cache is already lost, which makes it the one safe moment to re-emit
`session_config` with current values: tools rebuilt from `request.mcpToolDefs`, system prompt
refreshed from `request.refreshSystemPrompt()`. ⚠️ **`request.systemPrompt` must be updated too, not
just the emitted event** — the next API call reads the former. That was the mutation-testing find
here; refreshing only the event looks complete and leaves the next call on the stale prompt.
`cacheTtl` is deliberately NOT refreshed, to preserve fork inheritance. Without a compaction,
everything stays frozen from the stored config, which is what gives a byte-identical prefix and a
cache hit on resume.

Why the refresh matters differs by provider, and the difference is worth knowing: on Anthropic
frozen tools are a DX problem, since the model can invoke a tool by name whether or not it is in the
list. On OpenAI Responses it is a CORRECTNESS problem — schema-constrained sampling masks the token
distribution to the supplied tool names, so an agent physically cannot call a tool that was not in
its frozen `session_config`.

## Interrupt and stop are two abort channels, and they cannot be one

`stopTask` is TEARDOWN: kill background processes, close the queue, drop the session, disconnect
MCP. `interruptTask` ends the current TURN and leaves all of that alive. They were the same button
in the UI before this, and they are opposite verbs.

The signal is `TaskSession.interrupt` (`src/turn-interrupt.ts`), deliberately **not**
`session.abortController`. Sharing one channel gives you either "an interrupt tore the session down"
or "a teardown was mistaken for an interrupt so it could not tear down", and **both are silent**.
They meet in exactly one place — the API call's signal, `AbortSignal.any([teardown, interrupt])` —
and every reader checks `request.signal.aborted` FIRST, so teardown always wins.

⚠️ **`consume()` is called when the loop PARKS, not when it decides to.** The satisfying event is
the loop actually parking, whichever path parked it. Clear the flag at the decision point instead
and a stop landing in the same moment the agent goes idle on its own leaves the flag set, so the
next message is swallowed into a park.

**No repair is owed, and that is the point of the design.** `stopTask` leaves the turn's tool_calls
unclosed because the loop is already dead, and the next launch's repair then writes *"Tool execution
was interrupted by daemon restart"* — false whenever a human pressed stop, and re-read by the model
on every later turn. An interrupt keeps the loop alive, so the loop closes its own tool_calls before
parking and repair finds nothing. Completeness is structural: `Promise.all` settles for every tool
and `executeTool` never throws, so the only way to break it is bailing out early.

**Partial assistant text is KEPT, deliberately.** It makes the interrupted state representable on
disk with zero new resume states (the log ends in `assistant_text`, which reads as
`hasPendingImplicitYield`); it gives the user's next message a referent, because "no, don't do that"
needs the text they were reading; and emitting it as a normal final `assistant_text` is what clears
`ctx.streamingText`, so the UI's partial becomes final instead of lingering. Never the thinking
blocks (no signature) and never a half-emitted `tool_use` (that is the orphan being removed).

⚠️ **Do NOT front-run the queue when parking.** The cancellation-point drain is skipped while
interrupted. A message drained there would be merged into the turn's user message and then sat on —
the loop would wait for a *further* message before calling the API, so "stop, do X instead" would
look swallowed. Left in the queue, `handleImplicitYield` returns it immediately.

**Compaction turns are not interruptible mid-flight.** The summarization instruction is already in
`messages[]`; cutting there would pair "summarize yourself" with whatever the user says next. The
flag stays set and takes effect at the top of the next iteration.

**`done()` wins a race with the stop button.** That is completion, not interruption; marking it "not
executed" would strand the parent waiting forever.

**Foreground tools have two verbs now.** `foregroundExecutions.resolve()` moves a command to
background and it keeps running (the pre-existing verb); `interrupt()` terminates it and returns its
output so far through the same formatter a normal completion uses. A model told only "interrupted"
knows it ran a command and lost the result, which invites re-running something that already had side
effects. Tools that cannot be stopped safely just run to completion — a half-written file is worse
than a two-second wait.

⚠️ **SYMPTOM: "I pressed stop, then restarted the daemon, and it started working again."** Not a
bug; an accepted boundary, in the window *interrupt → restart with no message in between*:

| interrupted during | log ends in | resume detects | after restart |
|---|---|---|---|
| `thinking`, text had streamed | `assistant_text` | implicit yield | **parked at idle** ✓ |
| `thinking`, nothing streamed yet | the turn's user message | interrupted | re-runs the turn |
| `tool` | tool_results (a user turn) | interrupted | **continues working** |

Making the last row survive a restart needs a persisted "interrupted, waiting" marker — a fifth
resume state, which this design refuses. That is the cost to weigh if it ever has to change.

**`status` events are broadcast-only** (`isPersistedByEmitEvent` returns false), so the interrupt's
"Interrupted by user" reaches clients and never reaches the log. Two consequences: it cannot sit
between tool_results in a reconstruction that never sees it, and after a refresh the durable
evidence is the interrupted tool_result's own text. ⚠️ A test asserted the opposite and failed —
"emitEvent means it's in JSONL" is an easy assumption, and the repair path's own status event
(written straight to the EventStore) makes it look true.

## Agent activity: live process state is asked for, never replayed

> **State is never derived from the event log. On connect the client ASKS; while connected the
> server PUSHES.**

The log records *"it became active at some past instant"*. Replaying that as *"it is active now"* is
a category error, and the old code had a poll (`checkAgentStatus()` after every event batch) whose
only job was to undo the error it had just made. That poll was the bug report. Note the exact
inversion against pending messages: pending IS a projection of a persistent log, so a reducer over
events is right there. **The question to ask is "does this thing exist on disk?"**

`AgentActivity = "idle" | "thinking" | "tool"`, and it is asymmetric on purpose. `tool` is the
precise one because it is the only state with an unclosed tool_call, which is the one with an
interrupt consequence. `idle` means the loop is parked on `queue.wait()`. **`thinking` is explicitly
the residual** — every other way the loop is alive — which makes the following consequences rather
than special cases: the outer-retry backoff is `thinking`, session setup before the loop starts is
`thinking`, and a compaction turn is `thinking`. Known naming debt, deliberately unfixed: a
compaction runs 2-3 minutes and "Thinking…" across it is the same kind of lie this model removed.
Adding `compacting` later is a pure carve-OUT of the residual, which is cheap precisely because the
residual is written down.

⚠️ **Rejected framing, offered and vetoed: defining the states by what feedback the user sees**
(spinner vs tool card). That defines backend state in terms of frontend rendering — the same class
of error as deriving state from the log — and it collapses the moment a UI affordance is added.

It lives on `TaskSession.activity`, so it dies with the session and there is no second lifecycle to
keep in sync. **The field write and the broadcast must happen in the same function**, which is why
the setter is passed INTO `handleImplicitYield` rather than the event being emitted there and the
field written at its four call sites. Split them and call site number five gets only one half.

Two of the six transition points are worth stating explicitly, because both are the kind that get
"simplified" out:

⚠️ **`idle` is announced only when the loop will ACTUALLY park (`!queue.hasPending`).** This is not
flicker avoidance. It is what makes `idle` mean "waiting for you" rather than "reached a yield
point", and both consumers depend on the stronger meaning: `yield_external` wakes an external client
on it, and the UI re-fetches JSONL on it. It also keeps two provider test harnesses working — they
script the loop by counting idles, and an unconditional announce adds a phantom startup idle that
eats their first step.

⚠️ **There is a `thinking` transition on the way OUT of idle, and the argument for omitting it was
wrong in an instructive way.** The reasoning was: every path leaving `handleImplicitYield` reaches
the API block, so a second setter is unobservable — *the emitted event sequence is identical either
way*. True about the event sequence, and irrelevant, because **consumers read the STORED value, not
the event stream**. `yield_external`'s fast path and the connect-time snapshot both ask
`session.activity` directly, so without the transition the entire wake window reports `idle` for a
loop that is provably not parked, and the documented `send_user_message → yield_external` workflow
lands exactly there and is told the agent stopped working. **The structural fix is the dedupe, not
the extra line**: `setActivity` early-returns on an unchanged state, which makes "an extra
`setActivity` call is harmless" a true statement, so you write a transition wherever the loop
changes what it is doing and never reason about it again. Dedupe against a LOCAL rather than the
session field, so the property also holds for a provider driven in a unit test with no session.

**`agent_activity` is a broadcast-only delta and must never reach JSONL.** That is what makes
"replaying history cannot fake-activate an agent" structurally true instead of corrected afterwards.
A separate `agent_activity_snapshot` goes daemon→client on SSE connect, **sent even when empty**,
because "nothing is running" is exactly the message a client reconnecting after everything stopped
needs in order to drop stale entries. A delta rather than a snapshot per change because building a
snapshot needs the tracker and the provider loop has none.

⚠️ **Two consumers that a grep for `activeAgents` does NOT find**, and this is the canonical local
example of the by-name blindness described in *Changing code here*:

1. `yield_external` subscribes to the `agent_idle` **event type name** in `WAKE_SIGNALS`
   (`mcp-endpoint.ts`). It is matched now via a predicate on `agent_activity`
   (`state === "idle" || state === null`), and **the reported reason string stays `"agent_idle"`
   because that is the tool's external contract**, unrelated to our internal event names. In the
   same file, ~15 lines apart, the fast path returns the *string* `"agent_idle"` off
   `session.queue?.idle` — a different thing from the event type, and easy to conflate.
2. `onAgentIdle` (the Edit/Rewind re-fetch). Migrated to "the viewed task stopped working", which
   now also covers session end — an agent that finishes with `done()` never goes idle, so its last
   messages used to stay uneditable forever.

## An anomalous stop idles the agent silently

An assistant turn that returns **thinking only** — no text block, no tool_call — makes the loop see
`toolUses.length === 0`, treat it as end of turn, and implicitly yield. **With no user-visible
signal.** The agent then waits for a message indefinitely, and a daemon restart just re-idles an
implicit-yield agent rather than continuing it. For a root in conversation this is benign, because a
human eventually pokes it. For an autonomous sub-agent nobody is watching it is an indefinite hang,
and the parent's yield never wakes: the live case sat idle for **8 days**.

Our gap is that `getStopReason()` collapses every non-`end_turn` reason — including `refusal`,
`pause_turn`, `model_context_window_exceeded`, `compaction` — to `tool_use`, and the loop idles
without persisting or surfacing the anomaly. The guard (draft `01KXK69KKKGG4XHPH7EWGNY5AC`) is to
emit a persisted, user-visible error event **before** idling for any stop reason outside
`{end_turn, tool_use}`, plus a bounded `pause_turn` continue.

⚠️ **Agent time perception is DATE-BLIND, and it fails confidently.** Context message timestamps are
`[HH:MM:SS]` with no date. The 8-day agent woke and reported "~80 minutes", because 14:56 → 16:13
looks same-day. **Ground truth is the epoch `ts` in the JSONL; the display stamps do not encode the
date.** For any "how long was I stalled / when did this happen / is this stale" reasoning, read the
epoch. Root hit the identical thing with an overnight test run whose `[22:06]` → `[11:04]` gap was
invisible in the stamps and only inferable from anomalous test durations.

---
# Tools the Agent Calls
---

## bash: bound the output rather than forbidding the workaround

The tiered display exists because agents piped and redirected for a legitimate reason — context was
genuinely at risk — and rules against it leak at the edges. Now context is bounded by the tool, so
the instinct has nothing to act on. Under 1KB is inline only; up to 10KB is full inline plus a
saved file; over 10KB is head 5KB + a truncation banner + tail 5KB, with the complete output on
disk. Streams are merged by wrapping in `bash -c "(cmd) 2>&1"`, which makes an agent-written `2>&1`
a harmless no-op. Foreground and background go through one `formatBashResult`, so a
`background_complete` message is byte-identical to the foreground result for the same command.

⭐ **The framing generalises**: when agents repeatedly do X, ask whether the motivation is
legitimate. If it is, make the tool satisfy it naturally instead of enforcing against it. **If you
find yourself adding a parser, a rejection or a warning to the new tool, you have drifted** — the
point is to make the shortcut unnecessary, not forbidden.

The "don't pipe" guidance lives in the bash tool's `description`, not in `system-prompts.ts`,
because that is where the decision to pipe is made — while constructing the call.

## The three glob bugs were one class: a library default serving somebody else's use case

`search` and `list_files` each had two defects, and finding the third instance is what named the
class.

- **Neither walked hidden directories.** `Bun.Glob.scanSync` defaults to `dot: false` and nobody
  passed the option. In this repo the hidden directory IS the source: `.mxd/plugin/` is every
  ScopeOpts hook, every plugin REST route and the entire UI — **17,862 lines across 54 files, 34% of
  all non-test source**, invisible to the primary search tool.
- **A glob with no slash was treated as a path pattern.** `*` does not cross `/` in `Bun.Glob`, so
  `*.ts` — *the example printed in the tool's own description*, and what ripgrep's `--glob` means —
  matched only files sitting directly in the search root, i.e. `(no matches)` from a repo root.
  `normalizeGlobDepth` now promotes a slash-free glob to `**/<glob>`; a glob containing `/` is a
  path pattern and passes through untouched, so `src/*.ts` stays anchored. Same split ripgrep makes.

**What makes this class invisible is that there is no line to review.** Nothing anywhere said "skip
hidden directories" or "match only the top level" — the semantic lived in a library's default, i.e.
in the *absence* of an argument, and code review cannot catch an absence. Hence the discipline now
in place at every walker: **pass every option you depend on explicitly, even when you agree with the
default.** `dot: true, onlyFiles: true` on a call whose behavior is unchanged is not noise; it is
the semantic becoming visible.

The second-order damage is why this is worth a section rather than a commit message: for as long as
such a bug lives, **the tool's own description is teaching agents the wrong rule.** `list_files`'s
examples were `"src/**/*.ts"`, `"**/*.test.ts"`, `"*.json"` — the first two anchored, the third
silently meaning something else. The defect was never that `*.json` returned the wrong three files;
it was that a reader **generalises from the neighbours**. Both tools now state the rule rather than
implying it.

### Four things in the fix that will look like oversights

1. ⚠️ **The skip filter runs INSIDE the walk loop, so the 500-file cap counts files we KEEP.** Not
   an optimisation — a correctness requirement. Measured from the main checkout with `dot: true` and
   no skip list, an any-depth `*.ts` filled **323 of its 500 slots with `.worktrees/` copies** of
   files the caller already had, and never reached `web/`, `scripts/` or `.mxd/` at all, because
   `.worktrees` is walked before `src`. **So `dot: true` alone is not a different flavour of wrong,
   it is strictly worse than the bug**: the cap stops protecting you and starts guaranteeing you get
   the copies. Do not ship the two halves separately.
2. ⚠️ **`.worktrees/` in `DEFAULT_SKIP_DIRS` is load-bearing and costs nothing today, so it needs an
   assertion.** Each sub-agent worktree is a full second copy of the repo — measured 63,975 files
   across 3 live worktrees — so dropping it makes one search from main scan every file 4× and report
   every hit 4×. The guard test will not fail before someone "tidies" the list, which is the entire
   point of it.
3. ⚠️ **Truncation is announced, and detected one PAST the cap**, so a project with exactly 500
   files is not accused of having more. Silently returning 500 of 50,000 is the same failure as
   silently not walking a directory.
4. ⚠️ **`skipDirsForPattern(pattern)` is the default skips minus any directory the pattern NAMES.**
   `search` can reach an excluded directory by pointing `path` into it or passing `excluded_dirs:
   []`; `list_files` takes a pattern and nothing else, so a plain skip list would have deleted an
   ability with no replacement. No new parameter — the caller's intent is already in the input, and
   every param is a token every agent pays on every call. **Comparing against the trailing-slash
   form is what keeps it from firing by accident**: a pattern hunting for `*build*.ts` does not
   contain `build/`. When it misfires it hands over MORE files, never fewer, and every bug in this
   family did its damage by handing over fewer without saying so.

⭐ **`DEFAULT_SKIP_DIRS` is now the ONLY thing that decides what a search ignores**, which is what
the code always claimed — `.git/` and `.worktrees/` were already listed explicitly, so `dot: false`
was never anyone's intent. It is exported, and a test pins it against its prose copy in the
`excluded_dirs` description, because a prose copy of a list is the drained rot kind: a stale list
and a fresh list read identically.

### Detecting a silent under-report

The failure mode is silent **by construction**: "no matches" and "never looked" produce a
byte-identical tool_result. Nothing in a search result carries evidence that the search happened, so
it can never be caught by inspecting the answer — only by a **collision with something you
independently already know**. Three things generalise from how it was actually caught:

1. ⚠️ **The empty result is the detectable one; the partial result is the dangerous one.** Same bug,
   same tool, same agent, 38 seconds apart: a long confident answer that silently omitted the file
   *defining* the symbol went unchallenged and was acted on 2 seconds later, while an empty result
   for something the agent had read 5 events earlier got double-checked immediately. An
   under-report is only conspicuous when it takes *everything* away, which is the case that matters
   least.
2. ⚠️ **Detection needs an independently-held fact at that exact instant.** You search for things
   you do NOT already know — "are there other callers of X?" — and there a false `(no matches)` is
   indistinguishable from the truth AND confirms your hypothesis, which is the most comfortable
   answer there is. That is precisely the rename/delete check *Changing code here* tells you to run.
   Do not file a bug under "detectable" because of its output SHAPE; ask whether it is detectable in
   the situations it occurs in.
3. ⚠️ **The check that caught it is the one the tool description forbids** — *"ALWAYS use this for
   search tasks — NEVER invoke grep or rg via bash"* — and that suppression had already worked once
   in the same minute. **A rule that suppresses a redundant check also suppresses the only detector
   its failure mode has.** For as long as the bug lived, an agent that obeyed got the wrong answer
   and one that disobeyed got the right one, which trains every agent reading a tool description to
   discount it. A description that tells agents to stop cross-checking has to earn it.

### Two rules about compatibility worries, one of which is a trap

*"A semantic that has never worked has no users"* settled the `search` glob change in one line: a
caller wanting top-level-only would have been getting an empty result almost every time, so they
cannot exist. ⚠️ **It proves nothing for `list_files`, where the same change was in front of the
same person one line from done.** There, `list_files("*.json")` returned `package.json`,
`tsconfig.json`, `biome.json` — three real, plausible files. The old semantic worked. **The rule is
only decisive when the old output was EMPTY; when it was a plausible-looking subset it settles
nothing** — and a rule is at its most dangerous exactly when it happens to point at the answer you
already want. Checking its premise cost one command.

The generalisation that does hold is stronger, and it is what decided the case:

> **Before letting a compatibility worry veto a change, measure what the current behavior actually
> produces.** Not "is anything calling this" — *what does the call return today, and does it answer
> the question the caller was asking?*

The empty-output rule is the trivial special case. The common and more dangerous one is non-empty
output that does not answer the question, which is what happened here: the capability being
defended was `list_files("*")` as a "show me this directory" affordance, and `scan()` defaults
`onlyFiles: true`, so `*` returned the dozen loose files at the top of the repo and **not one
directory** — no `src/`, no `web/`, no `.mxd/`. The tool could not answer "what is the shape of this
project", which is what its own description claimed it was for, and `*` is the DEFAULT pattern.
**The capability being protected did not exist.**

## Gates: a passing gate looks identical whether it read 8% or 100%

Two gates had scopes narrower than their names, and both are now subtractions: `scripts/
check-i18n.sh` walks every non-test `.tsx` minus a named prune list (4 → 31 files), and
`src/data-paths.test.ts`'s source audit walks the repo root instead of `src/`. Before the fix the
i18n gate read **927 of 11,534 lines (8%)** — never the shell's own `SettingsPanel.tsx` or
`AppHeader.tsx`, and never *any* of the 25-file plugin UI, which is where essentially every
user-facing string in this product lives — and then printed `i18n check passed — no bare strings
found in JSX`, unqualified, from inside the pre-commit hook. The data-paths audit was proven dead by
experiment rather than by reading: a `dataRoot.slice(2)` planted in `.mxd/plugin/scope-opts.ts` left
it at 54 pass / 0 fail.

⭐ **Start from everything and subtract; do not enumerate what to include.** A subtract-list fails
LOUDLY — something noisy shows up and someone adds an entry. An include-list fails SILENTLY: new
code simply is not covered and nothing anywhere says so. `biome.json` (`"includes": ["**",
"!.worktrees", …]`) and `tsconfig.json` (`exclude`, no `include`) both got this right with nobody
maintaining them, and `tsc --noEmit --listFiles` really does put all 54 `.mxd/plugin/` files in its
program. The one legitimate exception is performance, and it must be said out loud rather than
implied — see the pre-commit hook below.

⭐ **When a check is known dead, "the suite passes" is not evidence the fix worked** — the suite
passed while it was dead. The evidence is the round trip: plant re-verified dead against the old
audit, then plant → **1 test red naming the offending file**, then plant removed → green. A test
whose value is entirely in the day it fires must be made to fire on purpose at least once.

⭐ **An unqualified pass is worse than a narrow scope.** The pass message carries the file count now
(`scanned 31 JSX file(s)`), and **scanning 0 files is a failure, not a pass**. The count is the
detector: re-narrowing to `-maxdepth 1` drops it to 4 in front of whoever commits next. A test pins
the same property in non-rotting form — scanned must exceed the number of non-test `.tsx` directly
under `web/`, both sides measured — so the historical bug reports as `Expected: > 4, Received: 4`.

⭐ **A partial-hit gate plus a fix-only-what-it-flagged policy produces incoherent output.** The
i18n heuristic is single-line, so in a component with 6 user-visible strings it flagged 1. Fixing
that one leaves a component half translated and half English — worse than untouched, and it looks
*handled*. **The unit of repair is the coherent unit, not the flagged line**; a gate that catches a
subset tells you WHERE to look, not WHAT to fix. The judgement is per-case and the same round went
the other way on purpose: in an 1800-line file containing an entire untranslated screen, fixing the
flagged line's neighbours reproduces the same incoherence one level up, so the line was fixed alone
and the rest filed.

Two repair notes worth keeping. The heuristic's `>text<` detector matched `) => Promise<void>;` six
times out of eleven hits, so the guard is `(^|[^=])>` — in real JSX the character before a closing
`>` is an identifier char, a quote, `}`, `/` or a space, never `=`. **That is exactly the shape a
lazy agent would use as cover for loosening the rule**, so it is pinned in both directions: an arrow
type must NOT report, and real JSX text including a `>` in column 0 MUST. And **brand names go
through `t()` with the same value in every locale**, which is what `"header.title": "Matrix"` has
always done; an exemption list was considered and rejected as the entry point for the next fictional
rule.

### The census — negative results, so nobody re-runs this

Every file-enumeration site in the repo was searched, deliberately with bash `grep -rn` rather than
`search` (see the self-bootstrap warning below). Conclusions:

- **Every `Bun.Glob` in the repo is now correct** — three call sites, two in `search`, one in
  `list_files`.
- **File enumeration here is either a `Bun.Glob` or a flat, single-directory read of a directory we
  own with its filter written down** (a ULID regex, a `.jsonl` suffix). `readdir` returns dotfiles
  by default and here that is what we want, so no default is doing hidden work. **Do not go looking
  again.**
- **File-scope CLAIMS are made in exactly two places**: a `readdirSync` walk in a test, or a
  config's include/exclude. Everything else that reads a file reads a file it names, where the scope
  IS the claim.
- **There is no CI.** `.github/` and `.gitlab-ci.yml` do not exist; the pre-commit hook is the only
  gate runner in this repo.
- ⚠️ **The hook itself is the third addition list**: it runs `bun test --bail` on **5 of 140** test
  files (3.6%) and then prints `All checks passed.` Here subtraction is genuinely infeasible — a
  full `bun test` is ~270-300s per commit — which is the performance exception, and the remedy is
  the other half of the i18n fix: say what you ran. Filed as `01KYCYSPVYPW0SGCX2YMK59874`.

Two more of the same class along a different axis, filed not fixed: the i18n heuristic's DEPTH is
still an addition list of one syntactic form (`01KYCYSPVYPW0SGCX2YMK59875`), and the data-paths
audit's PATTERN is one spelling, so `dataRoot.substring(2)` passes silently
(`01KYCYTJ2TC72AR8RDZGF9HMBZ`). **"Scope" is only one of the dimensions an addition list can hide
in.**

### ⚠️ In a self-bootstrapping project, fixing a tool's SOURCE does not fix the tool in your hand

> The tools an agent calls belong to the **running daemon**, not to anybody's worktree. So *"I just
> fixed X, therefore I can use X"* is **false until the daemon restarts** — and it is false for
> every other agent running at the same time.

Measured hours after `search`'s fixes landed on main: `search("ErrorBoundary", glob: "**/*.tsx")`
returned `(no matches)` while `grep -rn` returned 10 hits including the file that DEFINES it.

**This makes the blind-instrument trap harder to avoid than it looks, because of who walks into
it: the person who fixed the tool is the person with the most reason to believe it works.** The task
that wrote down "a completeness survey run with a blind instrument returns a confident, wrong
'that's all of them'" then ran its own survey on the blind instrument. The warning and the violation
were in the same task. **A tool description's "always use this" has an unstated premise — that the
tool works. Spend one call proving your instrument sees a file you already know exists before
trusting a by-name survey.**

⚠️ **Consequence for this file**: any "grepped it, nothing points there" conclusion recorded here
before 2026-07-25 was reached with an instrument that could not see `.mxd/plugin/`, and the failure
was silent in the direction that matters — a confident non-empty answer with the deciding file
missing from it.

---
# Events, JSONL & the Active Chain
---

## The event log: append-only, chained, and it never deletes

One JSONL file per task. Every persisted event carries `eid` (12-char hex) and `parentEid` (the
previous event's eid, or `null` for the first), stamped by `EventStore.append`/`appendBatch` —
callers never set them. `EventStore.lastEventIds` holds the per-session chain head. Old files
without eids are migrated on first read (linear chain, atomic temp+rename, idempotent).

**Field naming**: `eid`/`parentEid`, not `id`/`parentId`, because `MessageEvent.id` already exists
and means something else (the ULID of the two-phase message lifecycle). They are optional on the
`Event` type because callers create events without them; after persistence they are always present.

**Lines serialize the chain fields FIRST** (`{"eid":…,"parentEid":…,"type":…}`). Readability only —
tailing a JSONL shows the chain without scrolling past a long `content`. Reading is order-agnostic,
so pre-change lines with the fields at the tail read back identically and old files are not
rewritten; the two forms coexist inside one file, pinned by a test.

⚠️ **`{ eid, parentEid, ...event }` is WRONG, and it looks right.** When the input already carries
those keys the spread overwrites the fresh values with the stale ones, while the key POSITION stays
first so the line looks correct. `withChainFields` destructures them off before spreading. Not
hypothetical: `buildSessionRepair` re-appends unconsumed `message` events read out of the region it
is about to drop, and with the naive spread they keep a `parentEid` pointing at an event that is no
longer on the chain — the walk then hits a break and silently degrades to linear traversal, which
can resurrect rolled-back events.

⚠️ **`append`/`appendBatch` are fully SYNCHRONOUS and return the persisted copy. Do not "modernise"
them to `fs.promises`.** Two independent things depend on the synchrony:

1. **The generation guard.** The check and the filesystem write must happen in the same microtask.
   The old code called an async `writeFn` after checking, so the sequence was: guard passes, libuv
   schedules `open(O_APPEND | O_CREAT)` on the thread pool, the main thread is now free, a
   `clear()` bumps the generation and unlinks the file, and the thread pool then wakes and
   **recreates the file it was writing to**. The window is normally sub-millisecond and invisible;
   under load it widens to tens of ms and produces "JSONL reappeared after Nms" flakes. Cost of
   sync I/O: one ~100-byte line, microseconds on SSD, and writes were already serialized per
   session anyway. There is also a post-check that unlinks a zombie if `clear()` ran during a write
   — **decorative in the current fast path, and keep it**: it is the safety net for any future
   caller that passes an async `writeFn`. And do not drop `appendFile` from the imports;
   `copySessionFrom` still uses it.
2. **The failed-write rewind.** `stampEvent` advances the chain head before the write, so on
   ENOSPC/EIO the event never lands and the next event would name a parent that no line carries.
   `rewindChainHead` undoes the advance. **That is only correct while nothing can be stamped between
   the stamp and the write.** Defer the write and a burst in one tick gets stamped first: the event
   after a failed one names a missing parent, the walk stops dead, and the agent resumes with a
   **silently truncated context**. Synchronous keeps the cost of a failed write at "one event lost"
   instead of "history lost". Pinned by a test that chmods the file read-only.

The general form of that second argument is worth carrying: it replaces *"correct because nothing
happens to interleave"* with *"correct because nothing CAN"*.

`enqueueWrite` and its generation guard survive for `copySessionFrom`, the one genuinely async
write. ⚠️ **Its docstring says outright that the guard has no reachable failure path today**, and
that is deliberate: a mechanism that looks like protection but protects nothing is worse than none,
because the next reader reads "there is a queue" as "there is protection".

**`emitEvent` persists first and broadcasts the stamped copy**, so every observer — SSE included —
gets the event's durable name at the instant the event exists. Ephemeral events (`text_delta`,
`agent_activity`, `status`) are deliberately NOT stamped and never reach JSONL; they are not
history.

**`MessageQueue.enqueue(msg)` synchronously calls `onPersist(msg)` before delivery.** That is the
one way a queue message reaches JSONL. `replay: true` skips it (already persisted); `quiet: true`
suppresses the wake but NOT the persistence. A `traceId` means the message was produced inside an
agent-loop run; no traceId means it came from outside any run.

⚠️ **`createApp()` does NOT call `autoResumeProjects()`.** Tests that need resume behavior must call
it explicitly, and anything wired into `onScopeResume` will not fire without it.

`usage` events are persisted (the walker skips them as non-conversation content) and the UI attaches
them to the nearest preceding `assistant_text` as a hover badge rather than a log entry. Compaction
emits one too, marked estimated.

## One boundary: the active chain

"Which events count" had FOUR independent implementations. There is now one —
`walkActiveChainIndices` in `events.ts` — and `readActive`, `readFromLastCompactMarker` and
`copySessionFrom` all go through it. **Nothing addresses events by file position any more, and
nothing deletes.**

> The active chain ends at the `compact_started` of the last COMPLETED compaction. Inside that
> compaction's window, only `type === "message"` survives.

One backward scan does both jobs. `parentEid` always points at an earlier position, so scanning
backward IS the lookup — no eid→index map, and a cycle is structurally impossible because the index
only decreases. Walking back, a `compact_marker` opens the window and its `compact_started` closes
the walk. `compact_marker` is always kept (the walker treats it as structural, the UI slices its log
at it, and repair needs it to scope).

**Why the window exists.** Messages delivered WHILE the summarizer runs land between
`compact_started` and `compact_marker`. Ending the chain at the marker put those messages outside
the active region while the `messages_consumed` that acknowledged them — written after the marker —
was inside, so reconstruction resolved a consumption record referencing an id it had never seen and
dropped the content silently. Measured on the root session: 22 compactions, 8 with stranded
messages, 15 messages lost, 4 of them typed by a human. The live path was fine; only reconstruction
(restart, fork, UI refetch) lost them, which is what made it pure live-vs-reconstruction drift.

The type filter inside the window is equally load-bearing in the other direction: the summarizer's
own `thinking`, its `<summary>` `assistant_text` and its `usage` must NOT come back, because the
summary is already in the context as `compacted_resume`.

⚠️ **Do NOT encode the barrier as `compact_started.parentEid = null`.** It looks cleaner —
termination collapses to the chain root and needs zero type knowledge — and it is wrong for two
independently verified reasons:

1. **A compaction is a 2-3 minute window whose outcome is unknown when `compact_started` is
   written** (measured durations from the root session: 124s, 178s, 145s). If the daemon dies inside
   that window there is no summary at all, but the chain root is already committed — so the active
   region becomes `[compact_started, window messages]`, the agent resumes with an empty context,
   `hasWorkContext` is false so a fresh work_context is injected, and it carries on like a newborn.
   No error, no crash: **silent total context loss**, recoverable only by hand-editing JSONL. Under
   self-bootstrap, with dozens of restarts a day, that is a matter of time. The type rule handles it
   for free: no marker means no barrier means full history stays reachable.
2. **The type check has to exist anyway.** Logs written before `compact_started` existed have a
   marker with no opener, and walking past such a marker would drag pre-compact user messages back
   into the context. So emitting `null` only ADDS a mechanism on top of the one that must exist,
   plus a migration over every existing session — otherwise a compacted session's whole 84MB
   history floods back on the next restart.

The general form, after being talked out of this twice: **encoding structure in links fits a JUMP**
(rollback, repair — you know the target when you write it). **A compaction is an INTERVAL whose
validity depends on a result you do not have yet. Do not express an undetermined fact as a link.**

⚠️ **No dangling-link handling, and nothing may produce one.** A `parentEid` naming an eid no line
carries gets NO fallback — same rule as repair refusing to fix orphan tool_results: a state the
runtime cannot produce must not have code that quietly patches it, or that code becomes a silencer
for real structural bugs. It shows up as "the events before it stop rendering", which is what we
want. This is only honest because `rewindChainHead` closed the one path that could produce a dangle.
(There *was* a dangling-link fallback, and deleting it was blocked until that writer bug was fixed.
If you find yourself re-introducing one, go find the writer.)

**An event with NO parentEid at all still ends chain-following, and everything before it is taken
linearly.** That is the genuine chain root at index 0, and it is what lets a pre-eid log be read.

⚠️ **Being ON the active chain is NOT the same as being a legal rewind target**, and this is the
most expensive corollary of the design. **The active chain is not a uniform `parentEid` chain — it
is a CONSTRUCTED sequence.** After the compaction point, array order and chain order are the same
thing; the window messages are **spliced in** by the walker, adjacent in the resulting array but
with parent links pointing into the region the summary replaced. Rewinding is a pure parent-link
operation (`setChainHead(target.parentEid)`), so **it is only defined on the segment where
construction order and chain order agree**, which excludes exactly the window messages. Measured:
set the chain head to a window message and the backward walk never meets a marker, so the window
mechanism never arms and the walk runs to the first line of the file — on a real session that is
the entire summarized-away history returning at once, with the summary stranded on the abandoned
branch. **Making the window messages visible was correct; reading *visible* as *operable* is the
error.** A separate predicate (`hasRewindPoint`) answers "is there a state left to return to", and
its test fails on the DAMAGE — it asserts the resurrected history is absent by name — so anyone
relaxing that limit sees what they just did rather than a bare status code.

**Fork had its own copy of the boundary and it produced three bugs, one irreversible.**
`copySessionFrom` now calls `readActive`, because "wake up with the source's current context" IS
readActive's definition. What a linear slice got wrong: rolled-back events were copied into the
child (a slice ignores `parentEid` entirely); window messages were dropped; and the copied subset
was not RE-LINKED — the active context is a FILTERED subset, so the copied events' original parents
are absent from the child's file and copying links verbatim strands everything older. The copy keeps
SOURCE eids (identity survives) and re-chains `parentEid`. ⚠️ **The compaction boundary events are
deliberately NOT copied.** Only half of one can be (`compact_started` is outside the active region
by definition), and a lone marker in the child reads as the legacy unpaired-marker shape — so the
child would discard exactly the window messages it just inherited, with nothing left in its file to
ever recover them. **That is the irreversible one: the source recovers on restart, a fork never
does.**

## Repair is a chain jump, never a truncation

`buildSessionRepair` returns `{ chainToEid, appendEvents }`; the caller does `setChainHead` +
`appendBatch` — literally the rollback mechanism. `chainToEid: null` means append-only. Poisoned
events stay on disk and simply stop being reachable, **so the evidence needed to debug a corruption
survives it**. Repair runs in `runAgentForNode` before the provider loop starts.

Two shapes: append-only (an orphaned tool_call gets its interrupted result, nothing dropped) and
jump-back (duplicate or out-of-order results: chain back to the last good event, then append).

⭐ **Nothing in this codebase may address an event by file position.** That rule is the whole
inheritance from the design this replaced. Repair used to compute an index and the store used to
slice by physical line, and the two index spaces silently disagreed **twice**: once because the
index was computed against the post-`compact_marker` slice while truncation counted from the top of
the file (so a compacted session lost its marker, its post-compact `session_config` and its summary,
and then got interrupted results referencing tool_calls that had just been cut — unrecoverable), and
once because `read()` skips malformed lines while truncation counts raw ones (so N crash-artifact
lines made the cut land N lines early, silently destroying valid events). Both were fixed with a
translation layer, and the translation layer was then deleted along with `truncateAfterLine`,
`readWithLineMap` and `readActiveWithLineMap`, because the second index space was the bug. **An
index computed in one space and consumed in another is a silent corruption engine.**

Four details of the current repair that will each look removable:

1. ⚠️ **A truncating repair ALWAYS appends at least one event.** `setChainHead` is pure in-memory;
   the jump only reaches disk as the first appended event's `parentEid`. So both truncation
   strategies append a `status` event ("Session repaired: …") **LAST** — last so it can never split
   a run of tool_results into two user turns (the walker skips `status`, but position still
   matters for the collection loop). Without it, repairing a session that resumes in pending-done —
   no orphan results, no replayed messages, status user-message suppressed — would evaporate on
   restart and loop forever.
2. ⚠️ **Messages in the dropped region are replayed with fresh eids — ALL of them, not just the ones
   without a `messages_consumed`.** A message consumed into a turn the repair just dropped is
   exactly as absent as one that never arrived.
3. ⚠️ **The synthetic status message is a USER message, and it is suppressed when the kept region
   ends in a pending yield/done.** Appending a user message after an unanswered intended-orphan
   `tool_use` breaks the pairing rule and produces a genuine 400 (*"`tool_use` ids were found
   without `tool_result` blocks immediately after"*). Verified by removing the guard. When the
   session ends in pending yield/done it correctly resumes in that state, with no API-forcing user
   message. ⚠️ Older text called this an "alternation" guard; alternation is fictional and this is
   not it. **The word "alternation" in this codebase is not a reliable signal of anything — go read
   what the shape actually is.**
4. ⚠️ **`buildSessionRepair` THROWS if the event it must chain to has no eid.** Every event on an
   active chain is stamped, so that can only mean the caller passed something that never came from a
   store. A repair that cannot express its jump would leave the poison in place and loop forever —
   better to ring.

**What repair deliberately does NOT fix: an orphan `tool_result`** (a result with no matching call).
The runtime cannot produce one, so repairing it would mask a real bug instead of fixing a real
state.

⚠️ **A synthetic message must not use `source: "system"`.** It was tried; `formatBodyForAI`'s
default branch returns `""` and the UI's materialization switch had no case for it, so the repair
reason **silently rendered as an empty string** in both places. Use `createUserMessage`. Do not add
a new source variant to fix a rendering gap — reuse the visible one.

## Rollback and Edit

`EventStore.setChainHead(sessionId, eid)` is one line: set the in-memory head. The NEXT appended
event gets `parentEid = eid`, creating the jump — **the jump is carried by the first post-rollback
event itself, so there is no marker event.** A `rollback_marker` type and an `appendRollback` method
existed and were deleted; they were an implementation shortcut where one line of state does the job.

**`/edit` is the single backend path.** A standalone `/rollback` endpoint existed alongside it and
was deleted: `/edit` combines rollback and message delivery atomically and fully superseded it.
Rewind is an Edit whose content did not change, so **one answer governs both buttons.**

### Which messages can be edited — three independent judgments, and do NOT unify them

| module | question | the limit is on |
|---|---|---|
| `agent-activity.ts` `isWorking` | is the agent busy right now? | TIME |
| `run-start.ts` `messageStartsRun` | did the agent ever run FROM this message? | MEANING |
| `rewind-point.ts` `hasRewindPoint` | is there a state left to return to? | HISTORY |

`message-editability.ts` is the only place they meet, and **its checkable boundary is that it has
ZERO imports** — it consumes three verdicts and computes none, asserted by a test that reads the
file. If it ever starts deciding something itself, that is when to split it.

⚠️ **TOMBSTONE: two people tried to unify these on the same day. Do not.** Both attempts made the
**same mistake — taking a PROPERTY of a thing for the thing itself.** *"The gates are one invariant
at two timescales"* (both relate to unclosed tool calls, one asks "now" and one "at that position")
is technically defensible and explains a USER concept by its IMPLEMENTATION consequence; an end user
has no notion of an unmatched tool call. *"The message is in the active chain, therefore it is
rewindable"* takes a property of a rewind target for the target. **API 400 is a symptom, not a
reason**, and both framings leaned on it: even if the API accepted a rollback to a message the agent
never ran from, the operation would still be **empty**, because it points at nothing. **Reasons must
survive their failure mode disappearing.** The three judgments' only shared property is that all
three grey the button, which is a fact about pixels.

**The rule is which user turn PICKED THE MESSAGE UP**, and the user's own phrasing is the concept:
*only an independently sent message can be rewound*. "Run" means something only to someone who has
read the provider loop. `buildUserTurn` packs `[...tool_results, ...queued messages]` into one turn,
so **a turn carrying a tool_result is ANSWERING the agent's own previous output** and anything
riding along in it did not start it; a turn with no tool_result exists *because* a message arrived.
Both `messages_consumed` and the tool_results before it are persisted, so this is decidable from the
log. Walk back from each `messages_consumed` to the turn boundary, and **skip unrecognised event
types rather than treating them as boundaries** — detaching a tool_result from its consumption is
the direction that wrongly calls a message editable.

⚠️ **`yield`/`done` are the rule's best instance, not an exception to it.** Their results are
written *at wake*, by the very message being judged, so they are that message's CONSEQUENCE and not
its cause. An ordinary tool_result (bash, read_file) was already in flight before the message
arrived, so it is prior work. **The direction of causation is the rule; comparing tool names is only
how it is detected** — hence the predicate is `isPriorWork`, not `isPark`. This exception was
predicted to disappear under the new rule and instead **grew**: 1513 of 2161 newly-blocked messages
(70%) were yield turns, and it is the dominant shape for sub-agents, every one of which ends in
`done()` and is later woken.

⭐ **The evidence was being sampled at the wrong instant, and that is the reusable finding.** The
first version tested for an unclosed tool_call at the message's **delivery** position. Real trace:
a message arrived 10 seconds BEFORE the tool_call it was meant to be blocked by — at that moment the
agent was thinking, composing the call, so nothing was outstanding yet — while a message arriving
during the bash run was correctly blocked. Both were consumed together. The earlier analysis had
concluded honestly that the log could not do better, because parking on `end_turn` writes no event
and activity is deliberately never persisted, so "parked, waiting for you" and "waiting for the
model" leave the identical trace: nothing. **That was accurate about the DELIVERY moment and
irrelevant — consumption leaves a trace, and consumption is what answers the question. Looking for
evidence at the wrong instant is what made the log look mute.**

Two sizing errors from the same work, both of the form *reasoning where observing was cheap*:

- *"The thinking gap is where the agent spends least of its wall-clock time"* — true and beside the
  point. **Wall-clock share is not share of user actions.** "Ask for something, then add one more
  thing while it starts" is the most natural way to extend a request and lands squarely in that gap.
- *"Root's last 2000 lines contain no yield/done, so this is mainly a sub-agent problem"* — the
  observation was accurate and the generalisation was not; `tail -2000` reflects a recent habit, not
  the session. The full log had 1513. ⚠️ **An accurate observation plus an over-broad generalisation
  is harder to challenge than a guess, because it arrives with a number. Check the sampling window
  on every figure, including your own.**

Measured on a 3621-message session: editable 97.2% → 79.8%, and **NEW-only-editable = 0** — a
one-way tightening that opens nothing the old rule blocked. `messageStartsRun` returns `undefined`
for an unconsumed message, which is not a new state (the tri-state already existed for a message cut
away by an earlier rewind); measured 0 of 3621 occurrences with no UI path to it, so **do not write
logic for that branch.**

### Blocked buttons are greyed and explained, never hidden

Copy is never gated. Two independent justifications, which is what makes the decision stable: a
silently vanishing control reads as broken, and the cases that most need an explanation are exactly
the ones left with no affordance to carry one; and the row is ✎ ↺ ⧉, so hiding makes Copy change
position and a list ends up with two-button and three-button rows.

⚠️ **Precedence is permanent-outranks-transient, not whichever the code tests first**:
`unknown_message` → `no_rewind_point` → `did_not_start_run` → `agent_busy`. "Wait for the agent to
stop" promises a remedy; on a permanently un-editable message the user waits, the agent stops, the
button is still grey, and they cannot tell whether they waited wrong or the product is broken.
**Never offer a remedy that will not work.** Keep the reason→string map exhaustive over the union
rather than partial-with-fallback — that is what caught a missing i18n key the moment a third reason
was added. Visible strings use the user's framing ("Not sent on its own — the agent picked this up
along with work it was already doing"); the internal token stays, because it is part of the `/edit`
response shape.

## Every transport carries the event's name (eid)

Four consumers wanted the same missing thing and were each about to grow their own locating
mechanism: the Edit/Rewind gate, message deep-links, viewport addressing, and "is this event still
part of the conversation". They are one thing — **the frontend needs the persisted event identity on
the path it actually receives events over** — and it was missing because `emitEvent` used to
broadcast before persisting, so SSE clients were shown events they could not refer to. Persisting
first fixed all four.

**`LogEntry.id` is derived from the eid** (`Map<eid, number>`, never cleared — clearing it IS the
failure it prevents). The log is replaced wholesale on every refetch, and a module counter made every
key change every time: measured in a real session as one MutationObserver batch with
`added: 82, removed: 82`, against `removed: 1` for a normal update in the same trace. Two entries
exist BEFORE the event they are named after, and both **bind** their eid to the id they already have
rather than re-deriving it: a streamed text/thinking block (built from `*_delta`, which is never
persisted) learns its eid when the block closes, and a tool card is replaced in place by its
`tool_pair` when the result lands — which is exactly when a user is most likely to have it expanded,
and was a live bug on its own.

⚠️ **`key={entry.eid ?? entry.id}` is the wrong shape** even though it looks simpler: it moves the
key at the end of every streamed block, adding a per-block remount that does not exist today.

⚠️ **Active-chain membership needs its own bit, and this is the general reason:**

> **eid is an IDENTITY — immutable, per event. Membership is a RELATION between an event and the
> current chain head.** A rewind changes it for a whole stretch of log without touching a single
> event in it. **An immutable identity cannot encode a mutable relation.**

So the raw-file fetch ("Load earlier history") marks each event `offChain: "summarized" |
"abandoned"` via `classifyOffChain`, built on the one `walkActiveChainIndices`. **The client gets the
ANSWER, never the algorithm** — a second chain walk in the browser is exactly what the one-boundary
work removed. Marked only where it is not the obvious answer, because every other transport carries
active events by construction; explicit-everywhere was considered and rejected, since the reader
still has to choose what `undefined` means and it costs bytes on the hottest path.

Refusal wording followed the same discipline: "No longer part of the conversation" was what the UI
said when it could not tell — about every message in the batch, including ones still in it. It now
says which way the message left, and **either reason outranks "the agent is busy", because that one
promises a remedy that will never arrive.**

⚠️ **A user message renders where it was CONSUMED, not where it arrived.** A message typed during a
tool call is delivered between the `tool_call` and its `tool_result` but consumed with that tool's
results, so in the log it appears **after the finished tool card**. Anything reasoning about a
message's position must use the raw event batch, not the rendered entries — judging run-start off
rendered entries calls exactly the blocked case a run start. Mutation-verified: swapping the input
to the entries fails exactly two tests out of ~2760.

---
# Cache & Drift Prevention
---

## Prompt cache: what is frozen, what refreshes, and what breaks a prefix

A `session_config` event at the start of the JSONL holds the tools, `systemStable` and
`systemVariable` for the session. It is **frozen between compactions**, and that freeze is the whole
cache strategy: on resume everything is read back from the stored config rather than recomputed, so
the prefix is byte-identical and hits. The one refresh point is compaction — see *The Agent Loop* §
compaction, which also explains why the refresh is a correctness issue on OpenAI and only a DX issue
on Anthropic.

⚠️ **The Anthropic prefix order is tools → system → messages, not system → tools → messages.** A
tools mismatch is therefore a miss on the *entire* prefix, system and messages included. This is why
tools are frozen at all: MCP servers connect asynchronously, so registration order is
non-deterministic and an unfrozen tools array would reshuffle itself between runs. Freezing them as
a provider-agnostic `JsonTool` (`{name, description, jsonSchema}`) in `session_config`, and emitting
that event from `runProviderLoop` **after** tools are ready rather than from `agent-lifecycle` (where
it captured `tools: []`), took restart to **99.8% cache hit and fork to 100%** — measured 2026-04,
582 creation / 362K read and 0 creation / 365K read. That pair of numbers is the evidence those
fixes work; for today's rate read `cache_creation` / `cache_read` off a real `usage` event.

Three cache breakpoints: tools, `systemVariable`, and the **last** user message. ⚠️ **Last, not
second-to-last.** The last message sent to the API is always a user message, and Anthropic's
20-block lookback caches everything before it; the previous second-to-last strategy caused a full
miss whenever only one user message existed, which is exactly the post-compaction restart case.

⚠️ **Never add a per-request `anthropic-beta` header.** It overrides the client's `defaultHeaders`,
including the OAuth header (`oauth-2025-04-20`), and silently breaks OAuth mode. Extended cache TTL
is GA and needs no beta header. Also note `{type: "ephemeral"}` and `{type: "ephemeral", ttl: "1h"}`
are **different cache entries** — the TTL is part of prefix identity. `cacheTtl` lives in
`session_config` (root `"1h"`, regular children unset = 5 min) and is inherited through fork, which
is why it is deliberately NOT refreshed at compaction.

⚠️ **Multiline queue content must stay ONE text block.** `buildToolResultsMessage` and
`buildImplicitYieldMessage` used to split queue messages on `\n` into separate blocks, while JSONL
reconstruction merged them back into one — a guaranteed prefix mismatch on every resume.

**Known residual, low priority**: `addAssistantMessage` stores the raw API response content in the
SDK's key order, while JSONL reconstruction uses our manual key order. They happen to agree today
(`{type, id, name, input, caller}` on both paths), so within a session `messages[]` is consistent.
If the SDK ever changes key order this breaks silently.

## The live path has no construction logic of its own

`buildUserTurn` delegates to the walker's callbacks, so there is exactly one implementation per
provider of "how a user turn is built", and the initial drain goes through
`adapter.appendQueueMessagesToMessages` for the same reason. **The live path therefore cannot drift
from JSONL reconstruction, structurally rather than by discipline** — which is the fix for the
caption bug, where two independent constructions disagreed about whether an image carried its
caption. If you are tempted to inline a bit of turn-building "just here", that is the thing being
prevented.

The yield and done tool_results are the two fixed strings the resume path writes: `"resumed."` for
yield, and for done `"You previously called done(). New messages woke you up:"` plus the working
directory. Queue messages ride as separate text blocks after them, never embedded twice.

**Pre-API-call debug snapshots** land at `projects/<id>/debug/<taskId>/<traceId>/last.json`, one
directory per `runAgentForNode`, ten most recent kept. A restart makes a new traceId directory, so
the previous snapshot survives — diffing the two newest `last.json` files is the post-mortem for any
drift or unexplained cache miss.

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

## Where a project's data lives, and why it is in two places

**`<repo>/.mxd/`** is tracked in the project's own repo: `config.json` (repo-scope), `memory.md`,
`hooks/`, and `plugin/` if the project ships one.

**`~/.mxd/`** is daemon runtime state on this machine and is never in git: global config, auth, the
lock file, the web build cache, the project registry, and per project a `config.json` plus a
plugin-namespaced data root.

```
~/.mxd/projects/<projectId>/
├── config.json               (daemon-owned)
└── plugin/matrix/            (from the manifest's dataRoot: "@/plugin/matrix")
    ├── tree.json
    ├── tasks/<taskId>.jsonl  (one file per task, the complete conversation)
    └── debug/<taskId>/<traceId>/last.json
```

⚠️ **`tree.json` is deliberately NOT in the repo.** The tree mutates constantly and committing it
would pollute history. It has been listed under `<repo>/.mxd/` in this file before, wrongly, and
that listing contradicted the layout above.

The namespace exists so a second plugin's data parks beside matrix's rather than colliding at the
top level, and it completes the "matrix is just a plugin" framing. Config merges in three layers,
later overriding earlier: global `~/.mxd/config.json` < repo `<repo>/.mxd/config.json` < local
`~/.mxd/projects/<id>/config.json`.

**`src/data-paths.ts` is the ONE place that resolves a path from `dataRoot`.** Never compute
`dataRoot.slice(2)` anywhere else; a grep test fails if a second site appears, and it now walks the
repo root rather than `src/` (it walked only `src/` until 2026-07-25, so the very file that DEFINES
`dataRoot` sat outside it — proven by planting, not by reading). Three lines of defence, and each
one is there because the previous one might be relaxed:

1. A strict regex at the input boundary (`/^@(\/[A-Za-z0-9_-]+)*$/`), checked at daemon startup and
   at every resolve.
2. One resolver, so a fix touches one file. There used to be four inline `.slice(2)` sites.
3. A post-resolve invariant that the result is still inside the project root. ⚠️ Keep this even
   though the regex already rejects traversal — `resolveDataRoot("@/../etc")` used to return
   `dataDir/etc`, which is a cross-plugin attack, and belt-and-braces here is cheap.

⚠️ **A malformed manifest is FATAL at startup, not a warning.** Import errors are recoverable (skip
the plugin); validation errors are not. A malicious plugin declaring `dataRoot: "@/../etc"` must not
be silently skipped while its legitimate siblings run.

**Directory creation is lazy and happens at the owning plugin's data root.** The daemon used to
eagerly `mkdir projects/<id>/tasks`, which hardcoded matrix's layout; `EventStore`'s constructor and
`TaskTracker.save` now mkdir on first write. `tracker.save()` writes a temp sibling then renames,
because POSIX rename is atomic and a crash mid-write must leave the old `tree.json` intact rather
than truncated.

Two gotchas that are not visible from the layout: a CLI tool reading JSONL directly must pass
`"@/plugin/matrix"` to `projectTasksDir` rather than hardcoding `projects/<id>/tasks/`; and
in-process test harnesses (`createApp` with no `dataRoot`) use the project-root layout by design,
because they exercise runtime semantics rather than matrix's manifest — a daemon-level test goes
through plugin discovery and does see the namespace.

## The node model: TaskNode | GeneralNode

Runtime exposes exactly two node kinds, discriminated by a **required** `type: string` with no
`undefined` fallback.

- **TaskNode** (`type: "task"`) is launchable: session, git branch, lifecycle.
- **GeneralNode** (any other string) is pure metadata plus tree position — no session, no lifecycle,
  no agent. Matrix uses `"folder"` as its only flavour; another plugin could define `"chapter"`
  without touching runtime code.

`isTask` / `isGeneral` are runtime-exported type guards. **`isFolder` is matrix-plugin-local**, in
`orchestrator-tools.ts` for the backend and `.mxd/plugin/web/types.ts` for the frontend, because
"folder" is a matrix convention and not a runtime kind. There is no `FolderNode` type. The MCP tools
keep their user-facing names (`create_folder` etc.) and are sugar over one general-node API,
`tracker.addGeneralNode(title, parentId, type, metadata?)`, which throws on `"task"`.

`status` and `metadata` live on **`BaseTaskNode`**, not on matrix's `TaskNode`. `status` is genuinely
runtime-generic — `createNode` inits it, `updateStatus` mutates it, `load()` migrates it, and the
default `shouldResume` keys on `in_progress` — so a plugin whose nodes are launchable inherits it and
must not re-declare it. `metadata` is opaque: the runtime never reads it, only round-trips it.
Persistence is free, because `save()` spreads all non-session fields and `load()` casts the raw
object through; so is exposure through `get_task` / `get_tree`, because `stripSession` spreads
everything.

⚠️ **`tracker.setMetadata` REPLACES the whole object; it does not merge.** To update one key, read
and spread. Same on the REST write path: `PATCH` with `metadata` absent leaves it untouched, but
`PATCH` with a `metadata` object omitting a key makes that key DISAPPEAR. The caller sends the
complete merged object. Deliberately **no** `metadata` param on MCP `create_task`/`update_task` —
the only consumer is a plugin's REST UI, and an agent-facing opaque-metadata param is an imagined
need.

⚠️ **`load()` throws on a node with a missing `type`.** Every save writes it explicitly, so a
typeless node means corrupted `tree.json` or a bug — not "legacy data" to be tolerated.

⚠️ **Folders must stay at ZERO behavior, forever.** Persistent tasks started as "just a flag" and
grew into a disaster; this is the same shape. Every lifecycle operation (launch, done, close, reset,
send_message) rejects folders at its entry point.

⚠️ **`parentId` and task ownership are different questions, and 56 call sites had to be sorted into
the two.** `parentId` is tree structure — UI, reparent, delete. `getTaskAbove()` / `getTasksBelow()`
are task ownership — message routing, worktree branching, `task_complete` delivery — and **folders
are transparent to ownership**. The one bug this audit found: a REST reorder endpoint used
`getTask()` where it needed `get()`, because folders have children too.

⚠️ **Use the POSITIVE type guard when destructuring after a guard.** `if (isGeneral(node)) return
node; const {session, ...rest} = node;` started failing TS2700 once `status`/`metadata` moved up,
because the negative narrowing collapsed `TaskNode` to `never`. `if (!isTask(node)) return node;`
gives a concretely-narrowed `TaskNode` and identical runtime behavior.

**Two hooks, two moments**: `seedTree(tracker, projectId)` runs once, only when a project's tree is
first created, and is the worker-side complement to the daemon-side `onProjectInit` (which can
create FILES but has no tracker, so it cannot create initial NODES). `onScopeResume` runs on every
startup. Hooks receive `projectId` as well as `projectPath`, because a data-driven plugin needs the
registry id to find its per-project data root while matrix only needs the checkout.

⚠️ **`JSON.stringify(TaskNode)` must NEVER include `session`** — it holds `messages[]`, `allTools`,
the queue and an AbortController. Use `stripSession`. The failure is spectacular rather than subtle:
a forked task with 700K tokens in `messages[]` updated its own description, produced a **2.95MB
tool_result**, and doubled its own context from 735K to 1.75M until the API rejected it. Two of the
four MCP tools returning a node were missing the strip.

**`DEFAULT_CONFIG` is `Object.freeze`d at module load** and `createApp()` defensive-clones it.
Module-level constants must be frozen; a PATCH handler that mutates one poisons every later reader
in the process.

**`baseBranch` is required when creating a worktree — no fallback.** The root node stores its branch
at init and child worktrees branch from the parent's branch.

## The REST boundary must reuse the shared op, not re-implement it

> **A REST route that touches a task lifecycle resource — session, JSONL, worktree, config — MUST
> route through the same shared op the MCP path uses, or replicate its guard exactly.** Where they
> drift, the REST side silently re-introduces a solved bug.

That rule came from five bugs found together, all of them silent data loss rather than a crash, and
the four that generalise are worth knowing individually:

⚠️ **`c.json` does NOT throw on a live `session`.** SSE's `structuredClone` is *forced* to strip it,
so the SSE path was safe by accident and every REST route returning a node was serializing the whole
queue, conversation and AbortController over the wire. One `serializeNode` helper now wraps every
node response. **The lesson is that one transport's safety came from a constraint the other
transport did not have.**

⚠️ **Worktree removal must use the STORED path and branch, never a re-slugified title.** Close,
reset and delete used `wm.remove(node.id, slugify(node.title))`; a title can change after creation,
so re-slugifying computes a different path and the real worktree is orphaned forever.
`removeByPath(worktreePath, branch)` removes exactly what was stored.

⚠️ **A config write must never be able to wipe credentials**, and it took three fixes because there
were three doors. `PATCH /config/global` rejects null for any top-level field (global config is a
COMPLETE config, so `delete next[k]` wrote an incomplete one). `createDaemon` RETHROWS a load
failure instead of falling back to `{...DEFAULT_CONFIG}` — the silent fallback booted with empty
`authGroups`, and the next save overwrote the on-disk credentials with nothing. And
`loadGlobalConfig` distinguishes ENOENT (fresh install → defaults) from a read error or invalid JSON
(throw), because the old single catch returned defaults for a CORRUPT file too, which is the same
credential-wipe path with a different trigger.

⚠️ **`delete_task` must stop and await the running loop before cleanup.** It did neither what close
does (reject `in_progress`) nor what reset does (await loop exit) — it went straight to removing the
worktree under a live process, destroying unmerged work, and a pending `done()` then read
`getTask() === undefined` in Phase 2 and hung the parent forever. Semantic chosen: reset-style
("deleting a running task stops it first"), not close-style (reject).

Same family, different layer — five lifecycle guards that were simply missing: the **root node**
cannot be deleted, closed or reset (it is the tree anchor); `updateTaskOp` rejects `status: "closed"`
and `status: "failed"`, because both are terminal states needing cleanup that a plain PATCH bypasses,
leaking worktrees or orphaning Phase 2 (use `closeTaskOp`, or let `done("failed")` set it through
`tracker.updateStatus`); REST `/message` and `/clarify` canonicalize a task-id prefix to the full id,
validate the node exists and is a task rather than a folder, and reject `draft` the way MCP
`send_message` always did.

## Images

`getImageDimensions(buffer)` parses PNG/JPEG headers, and `read_file` rejects anything over 8000px
per dimension before it ever reaches a provider. Byte size is a provider-level concern
(`validateImage?` on `ProviderAdapter`): Anthropic 5MB decoded, OpenAI 20MB.

---
# Memory Index & Search
---

## The done() payload, and the boundary it defends

`done()` has exactly two agent-facing params: **`status`** (`passed`/`failed`, a runtime control bit
that routes the node to verify/failed) and **`result`** (required, non-empty — everything the agent
reports as content). `TaskNode.resultRounds?: DonePayload[]` gets ONE block APPENDED per `done()`,
never overwritten, so a task woken and re-done N times carries N rounds in call order and the field
is simply absent until the first done.

`src/done-payload.ts` holds the single schema. Add a content field there and the tool param, the
type, the stored round and the normalizer all follow — no fan-out. ⚠️ **It imports only zod**, which
is not an aesthetic choice: both `types.ts` (type layer) and `orchestrator-tools.ts` (tool layer)
must import it, and anything heavier creates a cycle.

⭐ **The runtime↔plugin boundary, which is the point of the whole design.** The runtime MAY read
`status` and ONE completion-output string (`doneCompletionOutput(input)` = `input.result`, the
"what happened" summary sent to the parent and recorded on the `done_notified` marker; every plugin
has one). The runtime MUST NOT carry the round structure or any content field beyond that string —
those are read only inside matrix's `onDone`, via `parseDonePayload`, and the runtime hands the raw
done input through as an opaque `Record`. **The check is a grep**: `resultRounds`,
`appendResultRound`, `parseDonePayload` and `DonePayload` appear in `src/runtime/*`, `runtime.ts`,
`provider-shared.ts` and `events.ts` only inside boundary-explaining comments, never in code.

⚠️ **`onDone` returns void, and `done_notified` is always the runtime-standard `{status, result}`.**
It used to return a plugin struct that got spread into the marker, letting a plugin inject arbitrary
marker fields — removed, because the marker is write-only (nothing reads its fields; crash recovery
recomputes from the tool_call) and only a synthetic test used the channel. Do not re-add a
`T["done"] | void` shape "just in case".

**Testing opacity requires data only the other layer understands.** The robustness test uses a
non-matrix scope whose `done()` carries `wordCount` and `mood`, and asserts they reach `onDone`
untouched and never appear in `done_notified`. **Testing with the default plugin's own fields cannot
distinguish "passed through opaque" from "reconstructed into that plugin's shape"** — both produce
the same round. Mutation-proofed empirically: reshaping `doneInput` into a fixed struct before
`onDone` fails exactly that one test out of ~2500, and every matrix resultRounds test still passes.

⚠️ **KNOWN LIMITATION: crash-recovery Phase 2 does not append a resultRound.** It is plugin-agnostic
runtime code that sets status directly and never calls matrix's `onDone`, so a `done()` whose Phase
2 was interrupted by a daemon crash loses its round. Wiring it in would either break the boundary
above or route crash recovery through a plugin hook. The normal path — the overwhelming majority —
captures correctly.

**`result` is enforced twice, and a rejected `done()` is harmless.** Zod rejects an absent result at
`executeTool`; `beforeDone` rejects an empty or whitespace-only one with a steering message, before
the git-clean check. Either way the tool_result is `isError`, and the loop's done-exit is gated on
`!doneToolResult.isError`, so the loop does not exit, no Phase 2 runs, and no empty round is
appended — the agent just sees the error and continues.

Four gotchas that will each cost an hour:

- ⚠️ **Zod strips unknown keys** (`z.object(inputSchema).safeParse`, no `.strict()`). So a caller
  passing an obsolete param name does NOT fail on that param — it fails on the required one that is
  now missing, which points at the wrong place.
- ⚠️ **`parseDonePayload` must NOT use `donePayloadSchema.safeParse`.** The schema requires its
  fields and raw done input may omit them, so safeParse rejects. Manual normalization only; it must
  never throw.
- ⚠️ **Required-ness comes from the tool's `decl`, not from the schema.** The param reuses the
  schema's TYPE while `{kind: "explicit"}` vs `{kind: "optional"}` decides whether it is required —
  which is how `result` is required on input while `parseDonePayload` still normalizes a missing one
  to `""`, with no drift between the two.
- ⚠️ **Any change to a tool's required params has a transition window.** Tools are frozen in
  `session_config` until a compaction refreshes them, so an agent mid-session keeps calling the old
  shape, the obsolete param is stripped, the required one is absent, and that done is rejected. It
  costs that agent one round and it retries correctly. Know that this is expected, not a bug.

### ⭐ Renaming a tool param: three things that bit us, all generic

1. **Grep the FRONTEND.** Done-card consumers read the param BY NAME (`getArg(.., "summary")`,
   `toolArgs?.summary`) through index/`any` access, so **typecheck cannot catch it and integration
   tests do not render.** The done cards would have quietly lost their text; only a manual grep
   found it. Same class as the compiler-only-types bound in *Changing code here*.
2. **Grep the TARGET name before a blanket rename.** `doneSummary → doneResult` collided with two
   pre-existing local `doneResult` variables.
3. **Make a missed site LOUD rather than silent.** Because `result` became required, a missed call
   site fails Zod, the done never completes, and the test times out — that enforcement WAS the
   safety net. The one miss that got through the bulk replace was a **backtick template literal**
   (`` result: `child ${label}…` ``), and it read as a 48-second flake rather than a regression.
   Grep both `x: "` and `` x: ` ``, plus the shorthand `x }`.

⚠️ **Not this concept, do not rename these**: compaction's `<summary>` tags and
`SUMMARIZATION_INSTRUCTION`; `llm.ts`'s OpenAI Responses reasoning `summary[]` / `summary_text` (an
API field); CLI cost/tree display; `get_logs`' "short summary" and `send_message`'s title; the
generic `ToolDisplay.summary`; `compactedResume` ids. Two provider test files declare their own
`done` tool with a `summary` schema and are CORRECT — they drive `provider.stream()` directly and
never run the runtime loop.

## The search index — `src/task-index.ts`

Indexes every task's **title**, **description** and **each done() round's result** at per-field,
per-round granularity: one document per (task, field, round), id `${taskId}:${field}:${round}`, so
every hit traces to an exact location and removal is targeted rather than a scan.

Orama (pure TS, no native deps) with the Mandarin tokenizer (jieba WASM) and EmbeddingGemma-300M
768-dim embeddings. `mode: "hybrid"` fuses BM25 and cosine in one query and is cross-lingual in
practice ("fix session recovery" ↔ "修复会话恢复" scores 0.81). If the embedding model fails to
load it degrades to pure BM25, so the daemon is never blocked on a model download.

⚠️ **Orama scores are higher = better.** The previous FTS5 engine was lower = better, so any
comparison, sort or threshold carried over from that era is backwards.

⭐ **Why the engine lives in `src/` and not in the plugin.** The red line is not "index code must sit
in `.mxd/plugin/`" — `src/` is the neutral building-block layer. The real invariant is that
**`src/runtime/*`, `runtime.ts` and `provider-shared.ts` contain ZERO occurrences of index / search /
resultRounds, including in comments** (two hook comments had to be genericized because they said
"search index"). The layout was then forced: `search_tasks` needs `availability: "both"`, the
external-MCP list is built by `mcp-endpoint.ts` from `buildAllToolDefs()` in `orchestrator-tools.ts`,
that is in `src/`, and `src/` may not import `.mxd/plugin/`. So the tool must be in
`buildAllToolDefs` → the search function must be src-importable → the engine lives in `src/`.

⚠️ **`onScopeResume(tracker, projectId)` is named by EVENT, not by resource**, and that is what keeps
the boundary grep clean — no "index" or "search" token anywhere in the name. The runtime calls it
once per project after the tracker loads and wraps it in try/catch; matrix's implementation happens
to reconcile the index, and the runtime attaches no meaning to that. Its counterpart `seedTree` runs
only on a fresh tree; this one runs every startup.

**Staleness is the node's `updatedAt` string, stored per task in a sidecar** (`index-meta.json`,
beside the binary `index.msp`). Reconcile reindexes iff `stored.indexedAt !== node.updatedAt` —
string compare, no clock math — which **subsumes backfill**, because a never-indexed task has no
`indexedAt` and is therefore stale. There is no separate "already backfilled" marker and none is
needed. Reconcile also prunes documents for tasks that have left the tree, and it catches what
`onDone` cannot: title and description edits, which fire no `done()`. Accepted edge: an edit landing
in the same millisecond as an index write yields an equal string and is skipped until the next edit
or restart.

Four gotchas, three of them environmental:

- ⚠️ **NaN scores trigger an automatic BM25 retry.** Documents indexed without a working embedding
  pipeline get a zero vector; cosine on a zero vector is `0/0 = NaN` and hybrid fusion inherits it,
  so *every* hit comes back `NaN`. `searchIndex` checks for a non-finite score and redoes the whole
  search as pure fulltext.
- ⚠️ **`MXD_DISABLE_EMBEDDINGS` exists because of a process-killing NAPI bug**, not for speed.
  `@huggingface/transformers` has a static `import * as ONNX_NODE from "onnxruntime-node"` at module
  scope; loading it registers the NAPI backend, and worker teardown then hits
  `NAPI FATAL ERROR: Error::New napi_create_error` → SIGTRAP → **the whole test process dies.** The
  env var short-circuits the pipeline so the backend is never registered. It must be passed to
  workers via the Worker constructor's `env` option (see *Bun Worker env isolation*); a
  `bunfig.toml [test.env]` entry alone does not reach them. Priority is explicit mock > env var >
  lazy load, so a test can still exercise hybrid paths with a mock while the var is set.
- ⚠️ **`sharp`/`libvips`**: Bun's global cache puts libvips at a versioned path sharp cannot find.
  `scripts/fix-sharp-libvips.sh` symlinks it and is wired as `postinstall`.
- ⚠️ **Orama's `where` only filters `enum` fields** and has no `ne` on them; `string`-typed fields
  silently return empty. That is why all metadata lives in the sidecar and no query uses `where`.

**`search_tasks` enriches from the tracker, not from the index**: each hit gets the task's CURRENT
title via a fresh `getTask`, and hits whose task has been deleted are dropped.

**NEGATIVE RESULT, do not re-derive:** `bun:sqlite` **cannot** `loadExtension` — smoke-tested,
`new Database(":memory:").loadExtension("x")` throws *"This build of sqlite3 does not support
dynamic extension loading"*. That killed the sqlite-vec plan and is why the vector phase went to a
pure-TS engine. The FTS5 index that preceded Orama worked correctly (MATCH, bm25, snippet,
DELETE-by-column all verified); it was replaced for the vector story, not because it was broken.

## Retrieval that nobody acts on ⇒ guidance goes where the DECISION is

Three surfaces inject prior art: `work_context`'s `[Related past tasks]`, `create_task`'s
`[Related existing tasks]`, and `search_tasks`' tiered output (2 full hits + up to 5 one-line briefs,
hard-capped at 8000 chars to protect the context window). All three worked and produced real hits.
None of them said what to do with a hit, so the block read as a return value: scanned, then dropped.
**Root's count for one day: `create_task` called 8 times, block returned 8 times, behaviour changed
0 times, `search_tasks` called 0 times.**

> ⭐ **Put the guidance where the decision is made. If the agent ASKED for the data, the tool
> description reaches it in time — it still holds the intent it called with. If the data arrives
> UNREQUESTED, only the payload reaches it.**

So the guidance lives in `search_tasks`' description (asked for) and in the two block headers
(unrequested), with no duplicated paragraph. ⚠️ **The bash "don't pipe" precedent does NOT transfer**:
that decision is made while CONSTRUCTING the call, so the description is its decision moment. A
description read before the call is guidance about something that does not yet exist in the agent's
world.

⚠️ **Matrix-specific tiebreaker, worth knowing on its own: tool descriptions are frozen in
`session_config` until a compaction refreshes them, so a description change does not reach a running
agent. Handler output reaches everyone on the next call.** For a fix motivated by "this failed
today", that is decisive.

**The two block headers are different sentences on purpose**, because the readers can do different
things. `create_task`'s reader is ROUTING — it just made a task and is deciding where the work should
live, so its menu is fold-the-conclusion-into-this-description (most common, and the one agents
skip), fork, `send_message` the found task and delete this one, or nothing. `work_context`'s reader
is already ASSIGNED the work and is deciding how to do it: read before re-deriving, and if a hit
already tried the approach it is about to take, **surface that upward** rather than obeying or
ignoring it. Three capability facts were verified rather than assumed, because the hypothesis handed
over was half wrong: a working agent **cannot** `send_message` the task it found (the handler's
direction check allows only ancestors and direct sub tasks); it **can** update its own task
description; and it **can** `fork_task_context` (only the TARGET is subtree-restricted, the source
is free) but only into a sub task it creates, so forking is a dispatch move rather than a
use-this-knowledge move.

⭐ **"Latest result" is the LAST round, and the last round is often trivial.** This is the single
fact that makes an excerpt block structurally unable to answer anything. A real hit had 3 rounds:
round 0 was the whole implementation, rounds 1-2 were CSS tweaks, so the block advertised the task
as *"Restyled search hits as card-style items: background: var(--bg-subtle…)"* and everything worth
reading was invisible. That is the shape of any task reawakened for follow-up, which is most closed
tasks of any size. Hence the ordering inside the header: **the "these are excerpts and cannot tell
you what a task concluded" reframe comes FIRST**, so the hits are read as an index. Put it after the
hits and the agent has already formed a judgement from the excerpts.

**The reading rule that prevents a NEW error**: a past round is *a measurement plus a judgement made
at the time*. The measurement usually still holds; the judgement may already be void — **and a new
task on the subject is often itself the evidence that intent changed.** An agent that reads "we
tried this and reverted" as a prohibition abandons a road it is currently supposed to walk.

⚠️ **An instruction you cannot execute is decoration.** Both fixes here are only worth doing BECAUSE
the header now says "get_task these": the block prints the **full taskId** rather than
`slice(0,12) + "…"` (12 chars resolves, the ellipsis does not, and a pasteable id costs ~70 chars),
and dead hits are dropped rather than rendered as title `"unknown"` with a real-looking but
unresolvable id.

⚠️ **Root's stated evidence did not support root's conclusion; a different fact did.** The argument
offered was "I read the tool description and still dropped the block" — but `create_task`'s
description had never mentioned the block, so that is evidence that an unexplained block does not
self-explain, not evidence about description-placed guidance. The real support was next door: the
system prompt already says "Search before building", and `search_tasks` was called 0 times that day.
**Check that a conclusion's stated reason is the one actually carrying it, especially when you
already agree with the conclusion.**

⚠️ **Two mutations here mask each other and must be run SEPARATELY.** Reverting the full-id render
and removing the dead-hit filter at the same time leaves the dead-hit test green, because it asserts
`not.toContain(goneChild.id)` and a prefix render does not contain the full id. And the work_context
assertion must be scoped to the block (`content.slice(content.lastIndexOf("[Related past tasks]"))`)
— **work_context also preloads memory.md, which contains both the marker and the word `get_task`, so
an unscoped `toContain` passes no matter what.**

This does **not** replace draft `01KNZGYY4T6SYWVT66DK13XCPV` (a required `origin` param on
`create_task`) and cannot: the block is **structurally late**, because the task already exists by the
time the agent learns a related one does. Everything here is recovery. What changes is the evidence
that draft needs — its premise was "prompt alone cannot fix this", and until now no prompt had tried.

**`searchIndexSync` now has zero production callers.** It was written for a then-synchronous
`buildWorkContext` and orphaned when that hook went async; only its own tests use it. Deleting a
public export is its own decision, drafted as `01KYB46KTMNTW8E48YHE3KVXSR`.

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

**Fix the double BEFORE the code it guards, and treat that ordering as the point of the work.** A
faithful double pays for itself immediately, on the very change that installs it — while a
too-loose one lets a real defect through in the same window. Measured inside a single task: after
`ValidatingMockAPI` was made to mirror the API, the next commit extracted a `yield`-ing block into a
generator and omitted `yield*` at both call sites. Legal TS, zero diagnostics, and the whole effect
silently gone — requests went out with an unanswered `tool_use`. **8 tests caught it, all of them
via the pairing rule that had just been added; under the previous double every one of them would
have been green.** The report even quoted the real API string, because the double's own rule says
every throw must. **The reason to fix the double first is not tidiness — it is that you are about to
be the one it catches.**

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
- **A generator called without `yield*` is a SILENT NO-OP. After extracting a `yield`-ing block into
  a helper, grep every call site for `yield*` before running anything.** `foo()` on a `function*`
  builds a generator object and discards it — the body never runs. Nothing catches this: it is legal
  TS with no diagnostic and no lint warning, because the call genuinely does return a generator and
  the type system has no opinion about whether anyone iterates it. Omit it at one site and that
  entire effect leaves the program while the build stays clean. Observed cost: two missing `yield*`
  meant a `tool_result` reached neither JSONL nor `messages[]`, so requests went out with an
  unanswered `tool_use` (8 tests). See `emitAndPushCompactToolResult` in `provider-shared.ts`, whose
  docstring carries the warning at the definition.
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
