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

## The server can do things it does not disclose, and only our own records catch it

Twice now, the API has behaved in a way that is invisible from inside a single response, and both
times the only detector was **comparing what we sent and stored against what came back.** Both times
the first hypothesis was wrong and plausible. If you are ever debugging "the API behaved
impossibly", read both before theorizing.

### `response.model` cannot be trusted as ground truth

A session showed a 70K-token cache miss with no explanation. Bit-exact replay settled it: two
requests 9 minutes apart in one session were tokenized by two different tokenizers. The earlier
request matched today's opus-4-6 output exactly (220,712 tokens); the later one matched opus-4-7
exactly (284,800). Same body on the two tokenizers today: 220,712 versus 284,471, a pure ratio of
**+28.9% on identical content**. Throughout, `response.model` kept reporting the declared model —
the swap was entirely client-invisible, and opus-4-7 was not GA for another 12 days.

> **A client declaring model X may receive model Y's output with no disclosed indicator.** The
> tokenizer ratio is the most reliable post-hoc signal, and it is only visible at a cache-transition
> moment.

Observable side effects when this happens: unexplained cache misses whenever the tokenizer differed
between prefix-write and the new call, and ~29% higher input-token counts for the same content.

⭐ **Forensic technique, model-agnostic: base64-decode a thinking block's `signature` — it embeds the
serving model name**, independently of `response.model`. That is how "8 of 8 silent turns were served
by a different model, 0 of 9,800 normal ones were" got established.

⚠️ **Lesson from the replay itself: our JSONL survives format migrations but loses bit-fidelity
against the code that wrote it.** The first replay attempt came out 10,515 tokens short because a
later commit had changed the shape of one event type and a migration rewrote the old events, so the
old walker dropped their content. **When you change a persisted event shape, preserve a pre-migration
snapshot** — reproducibility against historical sessions depends on it.

### Connector text is summarized server-side, and the model still sees the original

⚠️ **Scope: this is Fable-class behavior and Matrix has been on opus-class since. Treat the mechanism
as dormant rather than gone, and the techniques as permanently useful.**

Officially documented (AWS Bedrock, adaptive thinking): text emitted BETWEEN tool calls — "connector
text" — is **summarized server-side and returned as a thinking block**, standard thinking shape, no
new content-block type, with the signature carrying the encrypted original. **"No customer opt-in or
opt-out."** SDK version is irrelevant.

The scope rules explain why it looked intermittent: it applies only AFTER a tool_result exists in
the conversation; SHORT segments may pass through unsummarized; and **a final assistant answer —
text after all tool use, i.e. an `end_turn` — is UNAFFECTED and stays plain text.**

**How it presents**, which is what to look for if it recurs: assistant turns stored as
`[thinking, thinking, tool_use]`, where the SECOND thinking block is a server-generated summary of
what should have been the visible reply — sometimes an English paraphrase of a Chinese one — carrying
a signature. In the UI the user's reply vanishes into the thinking fold. **Matrix is faithful here**:
the SDK accumulator and the walker reproduce whatever blocks the server sent, confirmed by reading a
raw response where a 135-char paraphrase stood in for a ~300-char actual reply.

⚠️ **Operational mitigation: an agent whose last action is a user-facing reply should END ITS TURN
rather than call `yield()`.** Replying and then calling yield in the same turn makes the reply
*connector* text and it is summarized away. Matrix treats `end_turn` as an implicit yield with
identical pause semantics, so nothing is lost. Explicit `yield()` is fine when no user-facing prose
precedes it.

⭐ **The proof, and the reason it matters beyond this one mechanism.** A 12-digit canary was written
only in visible reply text and kept out of every tool input. The client-side JSONL stored a
paraphrase that mentioned "这串随机数" and **dropped the digits** — the canary existed nowhere
client-side. The next turn's agent then recalled the full canary verbatim from its context, with the
recall recorded in a tool input timestamped before any read. So the signature's encrypted payload is
decrypted server-side on echo-back and the ORIGINAL is reconstituted into the model's effective
context.

> **"Context = `messages[]`" is FALSE under this mechanism, and the model cannot detect the
> divergence from inside.** The model sees its own originals; the client and the user hold only
> server-rewritten summaries.

⭐ **An agent's memory of its own past replies is NOT evidence of what the user saw.** When verifying
user-visible behavior, read the JSONL or a debug snapshot. Never trust introspection of your own
context. This is the single most transferable thing here — it applies to any divergence between what
a model believes it emitted and what was persisted.

Three forensic techniques worth keeping, all model-agnostic:

- **Canary protocol**: put a unique token in visible text ONLY, have the next turn record its recall
  inside a TOOL INPUT before any read, then grep the client-side records. Tool inputs are the only
  generation-time verbatim side channel, because they must be executed as written.
- **Raw-response snapshot**: when block types look wrong, read
  `debug/<taskId>/<traceId>/last-response.json` — written before tool execution, so a bash call can
  read its OWN turn's response. Separates "the server sent this" from "we corrupted it" in one step.
- **A clean `usage` event proves the API turn completed**, which rules out a mid-stream process
  suspension (that would orphan the turn and trigger repair on resume). So `clean usage +
  thinking-only shape` is an upstream silent turn, not a laptop-close.

⚠️ **The first diagnosis was wrong, and it is worth knowing how.** It was SDK-version sniffing —
plausible, matching the observed block shape, and it produced an action (an SDK bump, kept, harmless).
One post-restart sample verified clean, and the pattern recurred within the hour. **A single passing
sample is not verification when the phenomenon is intermittent by design** — the scope rules
guarantee a clean sample is always available regardless of the fix. The measurement was right before
the documentation existed; what was wrong was the causal story attached to it.

**Two gaps deliberately left open** (waiting for real data rather than building for imagined cases):
`buildResponseEvents` has no branch for a server-side `fallback` block, so a fallback hop would not
be persisted and the post-restart walker would omit it, breaking the thinking hash chain; and
`getStopReason` maps every non-`end_turn` reason to `"tool_use"` — see *An anomalous stop idles the
agent silently* for what that costs.

## The Anthropic message-shape rules, MEASURED

Measured against production Anthropic (19 shapes, OAuth, opus-class). These four are the API's actual
rules:

1. **The first message must be `user`.**
2. **The conversation must END with a `user` message.** Ending on assistant → 400 *"This model does
   not support assistant message prefill."*
3. **The tool-answering rule, which is NOT "in the next message":** flatten the user messages after
   an assistant-with-`tool_use` into one block stream and take the **maximal LEADING run of
   `tool_result` blocks.** It crosses message boundaries freely; **any non-`tool_result` block ends
   it**, including a *trailing* text block in an otherwise-fine message and including a plain-string
   user message. Every `tool_use` must be answered inside that run.
4. **Every `tool_result` must answer a `tool_use` in the preceding assistant message.**

And two things that are **LEGAL** and were long believed otherwise: **consecutive same-role messages**
(user/user, user/user/user, assistant/assistant) and **empty content** (`""`, `[]`,
`[{type:"text",text:""}]`).

⭐ **Consequence nothing else states: `buildUserTurn` packs `[...tool_results, ...queueMessages]` with
tool_results FIRST, and that order is a real API requirement rather than style.** Put text before a
tool_result, or between two batches of them, and you get a production 400 with a fully green suite.
Results split across several user messages are fine, in any order; `[R1, text]` then `[R2, …]` is a
400 because the trailing text ended the run; `[text, R1]` is a 400 because block order inside the
message matters.

**Reachable, real and open**: `/compact` on a session with `messages.length <= 4` whose last message
is an assistant turn sends a request ending in assistant → 400. A fresh agent whose first turn ends
with `end_turn` reaches it with no other setup. `src/reachable-400-snapshot.test.ts` asserts the
CURRENT buggy shape.

⚠️ **Probing the real API: the `systemPreamble` trap.** Any probe against the OAuth endpoint must
send the auth group's `systemPreamble` as the FIRST system block, or every call 429s. A first-pass
probe that omitted it produced a wall of rate limits that reads exactly like validation failure and
nearly yielded the opposite conclusion.

## ⭐ Plausible and wrong: how this project fools itself

> **The expensive failures here have not been mistakes that looked like mistakes. They have been
> well-written, well-evidenced, plausible things that were wrong — and each one then LOWERED the bar
> for everything downstream of it, because a check is only ever judged adequate against the
> explanation you currently believe.**

**Member 1: an ENFORCED fiction manufactures its own evidence.** `ValidatingMockAPI` enforced a
role-alternation rule that does not exist. Our JSONL history contains **628 occurrences of "Messages
must alternate roles" — every one from our own mock and none from the API.** Four production
mechanisms, one `test.todo` and one memory entry filed as a "reusable pattern" were built to avoid a
400 that cannot happen.

How it got installed is the instructive part. The helper's own comment wrote down BOTH rules and then
chose:

> *"We don't assert the trailing-role rule because some walker outputs are intermediate and meant to
> be extended. We DO assert the alternation and structural shape."*

**That reasoning is correct.** Some walker outputs genuinely are conversation *prefixes* that end on
assistant, and asserting the real rule would redden correct fixtures. So:

> ⚠️ **An inconvenient TRUE assertion plus a conveniently-green FALSE one means the false one gets
> installed, and is then believed as fact. The fiction does not win on persuasiveness — it wins on
> not causing trouble.** Once it lives inside a `throw` it starts MANUFACTURING EVIDENCE: 628 error
> strings from the rule that was *executed*, zero from the rule that was merely *documented*. **The
> knowledge was never lost; the enforcement was.**

⚠️ **Detector — do not audit whether the assertions are correct.** That comment was entirely correct.
Ask instead: **is the rule being ENFORCED the same rule that is DOCUMENTED?** Wherever those two
fork is where a fiction starts producing evidence.

**An over-strict test double bills you three ways, and the third leaves no artifact.** It creates
complexity you pay for (the four mechanisms). It hides gaps — a fiction occupying the "role rules"
slot stopped anyone asking what the real role rule was, so the true one got zero coverage and a
reachable production 400 sat there unnoticed. And ⭐ **it VETOES correct code**: interrupting an agent
before it emits anything, parking it, then sending another message produces `[…, user, user]` —
legal, and the old mock rejected it, so the correct implementation could not be tested, the test was
truncated at the park, and a comment was left saying the constraint was unverified. **Nothing was
red. The feature simply acquired a reputation for being hard to test.** The first two produce
artifacts you can go find; the third produces *absence*. **Ask what your test double has made people
give up on, not only what it has made them build.**

**The name was the other tell.** `assertStructurallyValidApiMessages` fused two different predicates
— *structurally valid* (a prefix property) and *API messages* (a sendable-request property) — and
code can only be one of them, so it silently became the weaker one plus a fictional bonus. **A name
that claims "valid" without saying valid-for-what will drift to "matches what we imagined."** The fix
was a new *concept*, not a stricter assertion: `wellFormedPrefixViolations` (first-must-be-user;
pairing, but an answering run that RUNS OFF THE END of the array is incomplete rather than broken;
orphan tool_results are violations at any position) and `sendableRequestViolations` (all of that plus
trailing-role plus the last assistant's tool_uses answered by now). Note the trap's second half: the
PAIRING rule has the same intermediate-state problem the trailing-role rule has, so whoever tried to
assert the true rules with only one predicate available would have gone red on correct fixtures
*twice*. **Courage was not the missing ingredient; the concept was.**

⭐ **Zero existing tests went red when the true rules were added, and that is the finding rather than
a disappointment.** `validateRequest` only ever sees requests the loop actually decided to send, and
the loop only sends when its state is right — except on the one reachable bug, which had no test at
all. **The fiction was not masking existing tests. It was masking the fact that nobody had written
the missing one.** A gap does not turn red; it stays invisible until someone goes looking, which is
why the probe had to be written by hand rather than discovered by running the suite.

What DID go red was swapping the fused helper for the two real predicates: 10 tests, **every one a
fixture that could never be sent to the API, and none fixed by loosening a rule** — six walker
fixtures produced assistant-first output because they only cared about the assistant/tool region, and
four prefix-byte-comparison fixtures opened with an orphan `tool_result`. Given a real conversation
head they assert exactly what they always did. One did NOT get a head and is the interesting one: a
dirty-JSONL scenario table claimed "the walker produces valid structure" for an *assistant-first*
output. It does not, and **that is not hypothetical — a session was once permanently bricked by
exactly that shape**, when a bare `compact_marker` left `readActive()` starting on an assistant turn.

## The two providers

**There is ONE OpenAI provider: `OpenAIResponsesCompatibleProvider`.** The Chat Completions provider
and its 1624-line test were deleted along with `eventsToOpenAIMessages`; **do not go looking for a
"Chat Completions path" to compare against — there isn't one.** Both providers use the `openai` npm
package, and `ChatCompletionMessageToolCall` is a union, so filter on `tc.type === "function"`.
`DebugSnapshot.body` is exactly the object passed to the SDK.

`executeTool` validates every built-in tool's input against its Zod schema at the boundary; external
MCP tools have an empty `inputSchema` and skip validation.

⚠️ **Anthropic and OpenAI differ on whether an agent can call a tool that is not in its frozen list,
and the difference is not cosmetic.** Anthropic uses free-form tool-name generation and the server
dispatches any name to whatever handler exists — which is why `evaluate_script` can be hidden from
`session_config` and still be callable if you know its name. **OpenAI Responses uses
schema-constrained sampling**, masking the distribution to the supplied tool names, so an agent
physically cannot call a tool it cannot see. `strict: false` relaxes optional-field validation, not
tool-name enforcement. This is why refreshing tools at compaction is correctness-critical on OpenAI
and merely nice on Anthropic.

**Thinking events carry a `provider` field**, so switching providers automatically drops stale
thinking blocks on mismatch. The OpenAI walker ignores thinking entirely.

## The LLM facility — single-turn, no tools, no session

`src/llm.ts` wraps the existing provider adapters for plugins that need one-shot calls outside the
agent loop (`createLLM({authGroup, model, defaultThinkingEffort})` → `run` / `stream`). It is
strictly single-turn: no tools, no session state, no image input. It reuses `adapter.callAPI`,
`buildResponseEvents`, `getTokenUsage` and `computeCost`, so it is mostly wiring; the plugin resolves
`AuthGroup` and model from `MatrixConfig` itself, keeping the facility decoupled from config shape.
Errors are exceptions (no error chunk), transient ones are retried by the SDK, and hitting
`max_tokens` returns the text with `stopReason: "max_tokens"` rather than throwing.

⚠️ **SDK client construction is DUPLICATED from the provider class constructors, and this is the one
thing here that will bite someone.** Beta headers and timeout are hand-matched to
`AnthropicCompatibleProvider`. **Any future change to beta headers must update BOTH the class
constructor AND `createAnthropicClient` in `src/llm.ts`** — nothing enforces it, and the failure
would be OAuth breaking for plugin calls only.

⚠️ **Anthropic test mocks must set `sessionId`.** `ValidatingMockAPI` keys conversations by it; the
facility generates a fresh ULID internally and writes it onto `client._currentSessionId` as a side
channel, which is where the mock picks it up. `systemPreamble` is honored and passed through as the
first system block; OpenAI has no equivalent field.

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

## Durability at the process boundaries

**`shutdown()` order is fixed**: stop every running project's agent, then await residual
`agentLoopPromises` (bounded 1s), then flush every EventStore. `stopAgent` awaits loop settlement
with the same 1s bound, symmetric with `stopTask` — that closes the race between
`POST /projects/:id/stop` returning and the `finally` block's `agent_end` / Phase 2 `done_notified` /
MCP-disconnect writes, and it is what stops `DELETE /projects` → `rm -rf` racing in-flight writes.
The final flush matters only for the one genuinely async write path (`copySessionFrom`) now that
`append` is synchronous, but it is the correct shape and costs nothing.

⚠️ **Do NOT call `fg.resolve()` in `stopAgent`.** It looks like the tidy way to deal with a
foreground bash that is ignoring abort, and it moves the command cleanly to background — which
**breaks the orphan-repair semantic**. A stuck tool is supposed to get bounded grace and then be
left as an orphan, so `buildSessionRepair` synthesizes the interrupted tool_result on the next
launch. Several restart tests depend on exactly that.

⚠️ **The 1s bound was tuned under a single-run assumption and is now a known flake source.** Normal
load today is 3-4 sub-agents each running the full suite plus root running it too, and under that
contention `Restart B: crash during bash sleep` intermittently blows its 30s test timeout — it takes
~2.6s on the runs where it passes, so this is contention rather than a marginal miss. **Triage
shortcut: the suite's own total run time is a load probe** — measured 300.8s on the failing run
against 267-269s on passing ones. Check that before suspecting your diff. Raising the test's timeout
would only hide it; the open question is whether 1s still holds under parallel load
(`01KYCMVKN14RRX0KK0H2CNTD9P`).

**Worker init has a 30s timeout** (`WORKER_INIT_TIMEOUT_MS`, overridable for tests). Without it a
plugin whose `runtime.ts` hangs at top level hangs daemon boot forever — no log, no 503. On timeout
the worker is terminated and the promise rejects with a message naming the plugin. Crash-restart
uses exponential backoff `[2, 4, 8, 16, 30]s`, five attempts, then a circuit break with an SSE
event; a worker that has been ready for 60s resets its attempt counter.

⚠️ **A `beforeAll` that calls `createDaemon` with a worker must budget ≥ `WORKER_INIT_TIMEOUT_MS`.**
Otherwise on a real flake the test's own timer fires first and you get a useless "beforeAll timed
out" with no diagnostic, **masking the daemon's much better "Worker init timed out: <plugin>"
message that names the actual stuck plugin.** Measured cost of `createDaemon` with one global
plugin: ~213ms cold, ~137ms warm, ~346ms under 24 CPU stressors plus 4 parallel `bun test` runs —
worker spawn dominates every time. So 30s has 100×+ headroom; a 15s budget had >40× headroom and
still produced rare flakes from scheduler stalls, and the test never observed which step stalled.
**Do not try to fit it under 15s "to fail fast" — fast is meaningless when it fails on the wrong
timer.** (`createTestToken` is HMAC only, 2-3ms — never the cause of a slow bootstrap.)

**`.mxd.lock`** at the dataDir root is acquired with `O_EXCL` and holds `{pid, startedAt, version}`.
A stale lock whose PID is dead is stolen; a live PID errors out. It is opt-in (`lockDataDir: true`),
because tests run concurrent daemons on isolated tempdirs. ⚠️ **It refuses even when the lock holds
our own PID** — a second `createDaemon` in one process is a test bug or a double-init, and surfacing
it beats tolerating it. Released in `shutdown()` after the workers are gone.

⚠️ **Test mocks must honor the abort signal.** A mock doing `setTimeout(resolve, 10000)` makes
`stopAgent`'s loop-settlement await wait the full window. Real provider SDKs already respect abort;
`abortableSleep(ms, req.signal)` brings mocks in line.

## The self-bootstrap death chain, and the five worker-lifecycle bugs that formed it

Agent commits bad code → daemon restarts → worker crashes → **permanent hang plus a held lock.**
Five bugs in `daemon.ts` chained into that, and each is worth knowing because the failure is always
"nothing happens" rather than an error:

- **`worker.onerror` must reject the init promise.** It cleared the init timer and then did nothing;
  Bun fires `onerror` *and* terminates the worker, so with the timer cleared and no reject, the
  start promise hung forever with no timeout left to save it. An `initResolved` flag now decides:
  during init → reject (boot failed, no restart scheduled); after init → schedule a backoff restart.
- **`shutdown()` must tolerate dead workers.** `postMessage` throws `InvalidStateError` on a
  terminated Bun Worker, and that throw skipped every remaining worker **and**
  `releaseDataDirLock` — which is where the held lock in the chain came from. Try/catch per worker;
  a dead one goes straight to terminate.
- **A `{type:"error"}` message from the worker must also `terminate()` it.** Rejecting the init
  promise alone left the thread alive consuming resources.
- **Restart timers must be tracked and cleared on shutdown.** Bare `setTimeout` restart timers fired
  *after* the lock was released and spawned zombie workers.
- **Dead workers must be deleted from the `workers` map** on all three failure paths (timeout,
  onerror, `{type:"error"}`).

⚠️ **Triggering `onerror` during init in a test is not obvious**: a plugin runtime with
`setTimeout(() => { throw … }, 0)` followed by `await new Promise(r => setTimeout(r, 50))` gives the
event loop a chance to run the 0ms timer while scope-worker is still in its init phase. The two
approaches that seem simpler both fail — **`process.exit(1)` does NOT fire `onerror`** (silent
death, only the timeout catches it), and a module-level `throw` is caught by scope-worker's own
try/catch and becomes `{type:"error"}` instead.

## Two transport bugs that corrupt silently

⚠️ **`response.text()` on a proxied response destroys binary data.** scope-worker used it for
buffered HTTP responses forwarded back to the daemon; `text()` decodes as UTF-8, so **every byte
above 0x7F becomes U+FFFD** — a 256-byte binary payload inflates to 512 bytes and a PNG header
(first byte 0x89) becomes garbage. Fixed with `arrayBuffer()` plus a transferable postMessage
(zero-copy); `new Response()` accepts both `string` and `ArrayBuffer` natively. Request bodies are
*not* affected today only because they are JSON in practice — a binary request body (plugin file
upload) needs the same fix on `forwardToWorker`.

⚠️ **Bun Workers do NOT inherit `process.env` assignments from the parent thread.** They get their
env from the OS process snapshot at spawn time, so `process.env.X = "Y"` in the main thread — and
therefore `bunfig.toml [test.env]`, which sets `process.env` — is **invisible** to a file-based
Worker. The only way through is the `env` option on the Worker constructor, and the daemon passes
`{ env: process.env }`. Verified empirically, including the confusing part: **data-URL workers DO
inherit it** (different codepath), so a minimal repro can "prove" the opposite of production.

## SSE catch-up must survive a restart: epoch-prefix every event id

**Symptom: after a daemon restart, an open page stays blank until F5.** Per-lens seq counters restart
at 0 on every boot. There was already a guard for a pre-restart cursor *beyond* the new tail, but
not for one that falls *inside* the new incarnation's refilled range — and after a real restart
agents auto-resume and stream, so the buffer refills past the browser's low cursor before it
reconnects. `getEventsSince` then returned a wrong-epoch slice, catch-up was marked done, and the
full initial state was never sent.

Every SSE `id:` is now `<epoch>-<seq>` where the epoch is minted once per `createDaemon`. Catch-up
runs **only** when the cursor's epoch matches; a legacy bare-numeric cursor, a foreign epoch and
garbage all fall through to full initial state. ⚠️ **`parseSseLastEventId` splits on the LAST dash**,
because the epoch may contain dashes. ⚠️ **Both `id:` emit sites must use the formatter** — the live
relay and the catch-up replay — since one bare-seq emit poisons the client's NEXT reconnect cursor.
The client needs zero changes: EventSource echoes `Last-Event-ID` opaquely and only the server
parses it.

Two adjacent restart-window holes closed with it:

⚠️ **There is ONE `worker.onmessage`, installed before init.** The old code used a temporary
init-only handler and swapped in the runtime handler after `ready` — but **the worker posts
`sse_event`s DURING init** (autoResume crash recovery runs with `onBroadcast` already wired), so
those were dropped silently. Harmless on first boot with no clients; on a worker auto-restart, SSE
clients are still connected daemon-side and miss every recovery event.

⚠️ **`/events` initial state polls for worker readiness for 3s, and the 3s is deliberate, not the
spec's 2s.** The restart backoff is 2s and expires exactly as the restarted worker *begins* init, so
a 2s poll guarantees a miss for early-gap clients. A ready worker resolves on the first check with
zero delay; a lens with no plugin at all resolves immediately as undefined.

---
# Plugin System
---

## What a plugin is, and the boundaries that keep it one

A plugin is `.mxd/plugin/`: a manifest (`index.ts`), a worker-side `runtime.ts` supplying
`ScopeOpts`, and a `web/` React component the shell lazy-loads. Matrix is one of these and is
discovered by the same scan as any other. `ctx.scopeOpts: Map<projectId, ScopeOpts<T>>` holds the
per-project configuration, and `buildMatrixScopeOpts` in `.mxd/plugin/scope-opts.ts` is the ONE
place that knows matrix's tools, prompt and hooks.

**The hook list is deliberately not reproduced here.** It lives in `src/runtime/context.ts`, it has
grown several times, and two hooks have changed arity — a copy in this file would go stale silently
because there is no compiler between the two. What the type signature cannot tell you:

⚠️ **Hooks are named by EVENT, never by resource.** `onTaskDelete`, not `removeWorkspace` — the
latter presupposes that tasks HAVE workspaces, which is a plugin-specific assumption the runtime
must not encode. Prose comments may say "workspace"; hook NAMES may not. The same rule is why the
index reconciliation hook is called `onScopeResume`.

Everything optional is genuinely optional — the runtime does `opts.hook?.(...)` and attaches no
meaning to absence.

**Four invariants, each checkable:**

- `src/` has **ZERO** production imports from `.mxd/plugin/`. Delete the plugin and the shell still
  compiles. (Test files and test-utils may import it; that is test infrastructure.)
- Plugin web has **ZERO** imports from `../../../src/`. It reaches shared code through the
  `@mxd/auth-context` and `@mxd/types` importmap aliases.
- The runtime **throws** if `buildScopeOpts` is not provided. No silent fallback to a built-in
  matrix scope — that fallback existed and was deleted.
- `src/runtime/*`, `runtime.ts` and `provider-shared.ts` mention no matrix concept, including in
  comments.

**`BaseTaskNode` vs `TaskNode`**: the runtime is generic **at the type level** — `ScopeOpts<T>` and
the `PluginTypes` generic are parameterized over `BaseTaskNode`, and matrix extends it with
description, branch, worktreePath, cwd, color, costUsd, budgetUsd, resultRounds. ⚠️ **CAVEAT: only
the hook interfaces are generic.** The concrete `TaskTracker` still stores matrix's
`TaskNode | GeneralNode` directly and is not generic over `BaseTaskNode`, so "the runtime uses
BaseTaskNode" is aspirational for the tracker. Full tracker generalization is future work.

## `/api/<plugin>/*` — explicit URLs, no hidden rewriting

Plugin-owned routes live under `/api/<plugin-name>/*` on the wire. The daemon strips the prefix and
the worker serves its routes as if at root. `pluginApiPrefix(name)` is the single source and is
imported by the daemon router, the CLI, the plugin's `api.ts` URL builders, and `web/runtime-types.ts`
— so a format change propagates atomically across all four.

⚠️ **The `app.all("*")` catch-all was REMOVED, and that is the point of the change.** An unprefixed
plugin path now 404s instead of silently falling back to "the first global worker". `/version` and
`/stats` needed explicit daemon-level forwarders because they had only ever been served by that
catch-all. Daemon-owned paths stay at root: `/auth/*`, `/health`, `/version`, `/stats`, `/plugins`,
`/global-context`, `/events`, `/projects` CRUD and `/projects/:id/config*`, `/vendor/*`, `/app/*`,
`/restart-daemon`. Everything else under `/projects/:id/` is plugin-owned.

External MCP clients configured against the old `/mcp` URL break, deliberately and with no
deprecation alias.

⚠️ **`pluginApiPrefix` lives in `src/plugin-url.ts`, which has ZERO imports, and it must stay that
way.** `web/runtime-types.ts` re-exports it to browser code; when it lived in `plugin.ts` it dragged
in `data-paths.ts` → `node:path`, and Bun's browser target polyfilled the entire module into every
plugin's first-load bundle: **10,293 bytes → 281 bytes when it was split out, a 37× reduction.** A
test builds the shared module and asserts it stays under 500 bytes, so any future server-only import
that creeps into that graph fails loudly rather than quietly costing 10KB on first paint.

**Rejected alternatives, so nobody re-proposes them**: a shell `authFetch` wrapper would need a
daemon-route passthrough list, coupling the shell to the daemon's internal routing table; and
plugin-via-props data flow is cleaner long-term but was 100+ LOC of scope creep. Explicit URL
construction at each layer means the plugin author sees exactly what hits the wire.

## Additive dual lenses — a project is served by its own plugin AND by matrix

A project that ships its own `.mxd/plugin/` is served by **both** its own scope and the global matrix
scope, on separate per-scope data roots. `matrix:<id>` is the dev lens (coding, orchestration);
`<own>:<id>` is the product lens. Shipping a plugin **ADDS** a lens and never removes the matrix one.

⚠️ **The first implementation made ownership EXCLUSIVE (`own ?? global`) and was reverted. Do not
re-derive it.** Four reasons it is wrong, and the first is decisive:

1. **`<scope>:<project>` is a TWO-PART address, and its existence proves the relationship is dual.**
   If a project mapped to one scope the prefix would be redundant. Exclusive collapsed it to
   `scope = f(project)`.
2. The design was always "parallel run loops — alongside, NOT override". Exclusive turned alongside
   into override.
3. Self-bootstrap requires coexistence: matrix is its own product, and "the product is a dev tool"
   only holds if a project opens in both lenses at once.
4. Per-plugin `dataRoot` was built for exactly this and is wasted under exclusive.

**If any routing decision tempts you toward "a project belongs to ONE plugin", that is this bug
returning.**

Consequences that follow from additive and would otherwise look arbitrary: `scopesForProject` is
all globals ∪ the project's own plugin, **globals-first**, so the default lens is dev/matrix;
`projectsForPlugin` gives a global plugin **ALL** projects (matrix is every project's dev lens and
must know them all to resume), with no double-resume because the lenses live in distinct data roots;
`onProjectInit` runs per that list, so matrix scaffolds every project's dev lens; and `DELETE
/projects/:id` **fans out** a stop to every scope serving the project, because a running agent in
any lens must stop before data removal.

**SSE is scope-aware, because a lens is `(projectId, scope)` and each lens has its own tree.** The
ring buffer and seq counter are keyed by `lensKey = ${projectId}\u0000${scope}` — `\u0000` cannot
appear in a ULID or a plugin name, and is deliberately different from the worker key's `:`. The
relay derives the lens from the *emitting* worker, so a product viewer never sees the dev tree. A
project with no plugin of its own has one worker emitting one scope, so behavior is identical to
before the change, which is the regression bar.

**Default lens is dev-first (globals-first ordering).** Rationale: matrix is the foundation lens
every project always has and the product lens is the ADDITION, so defaulting to product would make
first load identical to the reverted exclusive model and **hide the addition** — the default should
teach the model. Also the matrix lens always works while product workers are mid-build. A per-project
configurable default is drafted (`01KTJZ07MC0VWM923SBDZHDRP8`); do not bake product-first globally
while products are under development.

⚠️ **Pre-existing noise, not a regression**: daemon tests that run `createDaemon` against the matrix
repo log `onProjectInit failed … ENOTDIR .git/info`, because a git WORKTREE has `.git` as a FILE and
`excludeWorktrees` tries to mkdir inside it. Caught and logged; succeeds on a normal checkout.

## The plugin SDK: `mxd/plugin-sdk`, one zod, one live module

An out-of-tree plugin imports `mxd/plugin-sdk` — a subpath of the real `mxd` package via its
`exports` map — rather than counting `../`s. Bare-specifier resolution walks up `node_modules`, so it
is depth-independent and works inside the plugin's own worktree with no dev symlink.

⚠️ **Chosen over `@mxd/plugin-sdk` on purpose.** The `@mxd/*` names are BROWSER virtual modules
(tsconfig paths + importmap), a different mechanism; a server package reusing that prefix would
falsely imply kinship.

⭐ **It must stay a thin re-export and must never become a vendored copy.** Bun and Node dedupe
modules by REALPATH, so a plugin importing through its `node_modules/mxd` symlink resolves to the
same physical files and therefore the **same process singletons** the agent loop uses — in
particular the module-level `_ctx` in `resource-registry.ts`. A vendored copy has a different
realpath, a different `_ctx`, and **message delivery silently no-ops with no error.** Proven by a
probe outside the repo: `listNodes` returns the exact same node object the app's tracker holds,
reference-identical.

⭐ **`package.json` pins `zod` EXACT (`"4.3.6"`), and the caret must not come back.** The SDK does
`export { z } from "zod"` so a plugin's `z.string()` passes matrix's `shapeToJsonSchema` — which
only works when both sides are the same `ZodString` class. A caret let a consumer drift to 4.4.3,
producing two distinct Zod identities and a `defineTool` that stopped typechecking. **package.json
is strict JSON and cannot hold a comment, so this paragraph is the only record of why.** The
`@anthropic-ai/sdk` pin is exact for the same class of reason.

**The `exports` map also GATES deep imports**, and that gating is load-bearing rather than
incidental: `import "mxd/src/resource-registry.ts"` no longer resolves, so `getTracker` and
`deliverMessage` are un-importable and only the narrowed pair reaches a plugin. Verified safe
because nothing in the tree self-imports by bare specifier (matrix uses relative imports; the worker
`import()`s plugins by absolute path).

**The narrowed messaging API is `deliverToNode` + `listNodes`**, and the narrowing is semantic rather
than cosmetic: `deliverToNode` exposes only delivery and cannot be misused, `listNodes` returns a
fresh read-only snapshot of launchable nodes and cannot mutate the tracker — versus `getTracker`,
which is full mutable access. `deliverToNode` is a thin wrapper over the ONE `deliverMessage` path,
not a fork, so it keeps the wake-an-idle-recipient semantic. **No permission policy is baked in**;
matrix's ancestor/sub-task restriction is matrix policy, and intra-project delivery is unrestricted
with the plugin's own tools owning routing.

⚠️ **`deliverToNode` throws "deliverMessage not registered" outside any agent loop.** `_ctx` is set
by `initResourceRegistry` on the `createApp` path, but `_deliverMessage` is registered by
`registerSideEffects`, which runs inside `buildAgentContext` **at agent launch**. `listNodes` works
without a launch; delivery does not. This is why its arrival is tested through a real loop rather
than a bare `createApp`.

**Still missing**: a plugin cannot define how its own message source renders — `formatQueueMessage`
hardcodes a wrapper per built-in source. Drafted as `01KTJ5F5XTM32YNS6RSPW7R5PF`.

## What extraction actually moved

`buildMatrixScopeOpts` moved into `.mxd/plugin/`; the **leaf utilities stayed in `src/`**
(WorktreeManager, `createOrchestratorTools`, `buildSystemPrompt`, `slugify`, `McpClientManager`) and
the plugin imports them, because plugin→src is the allowed direction. **The leak was
`buildMatrixScopeOpts` living in `runtime/agent-lifecycle.ts`, not the utils.** `grep WorktreeManager
src/runtime/` is zero, and that is the check.

Worktree operations in runtime routes became hooks: reactivation calls the existing
`beforeChildLaunch` (the semantics already matched exactly), and DELETE got `onTaskDelete`.

Mock-showcase (a static data endpoint plus a component-development page) was registered
**unconditionally in `src/runtime.ts`, so every plugin worker served it.** It is a FEATURE of the
matrix plugin, not a plugin of its own, and now lives in `.mxd/plugin/routes/`. Its UI activates at
`/<projectId>/matrix/mock-showcase`; the old `?mock=true` query param was dead. It is the place to
visually confirm a new log-entry card renders without running a real agent.

---
# Auth & External API
---

## Auth is always on, and the anonymous surface is four things

There is **no auth-disabled mode and no opt-out.** The `autoInitAuth` parameter was deleted, every
`createDaemon` unconditionally runs `ensureAuthInitialized`, and the middleware's "no jwtSecret →
skip" branch is gone: an anonymous request to a non-skip path is ALWAYS 401. Tests mint a token
rather than disabling auth. Production binds `127.0.0.1` unless `MXD_BIND_HOST` is set — the old
`*:7433` default was LAN-reachable during the bootstrap window.

⚠️ **`readAuthData` throws on a parse failure, an empty file or a read error**, returning `{}` only
for ENOENT (fresh install). And `writeAuthData` writes to a temp sibling and renames, so a crash
mid-write cannot leave a truncated or empty `auth.json` — which, before auth became mandatory, was
a file state that silently disabled auth entirely.

**Exactly four ways a request skips auth. This is the whole list**, and understating it is the wrong
direction for an auth note to be wrong in:

1. `SKIP_EXACT`, which is **one entry**: `/auth/status`. The login page must be able to ask "am I
   authenticated?" before it has a token.
2. The `/vendor/` and `/app/` prefixes — compiled bundles, no secrets.
3. **`GET` + `isFrontendPath(path)`** — `/` exactly, or a first path segment that is a **currently
   registered project id**. This is the largest and least obvious part of the surface: tasks live at
   `/<projectId>/<scope>/<taskPath>`, browsers do not send `Authorization` on navigation, and a
   refresh on such a URL must reach the shell. The shell itself is auth-content-free and every API
   call it then makes goes through this same middleware. Unregistered first segments fall through
   to a clean 404.
4. Nothing else. **Everything under `/auth/*` except `/auth/status` requires a token**, guarded by a
   regression test asserting `GET /auth/bogus` → 401 — which exists because a former
   `startsWith("/auth/")` skip would have silently exempted any future `/auth/*` route.

⚠️ **Item 3 is `GET`-only on purpose.** POST/PATCH to a frontend-shaped path stays 401; those are not
legitimate SPA paths, and an honest 401 beats accidentally serving HTML.

⚠️ **The predicate is `pm.has(firstSegment)`, not a ULID regex, and it is deliberately the SAME
predicate used by the SPA-fallback wildcard** (`app.get("*")`). One predicate, one answer — there is
no way to get "auth bypassed but the wildcard 404s". A regex was considered and rejected: a
project's *existence* is the correctness condition, not its id format, and under a regex a stale or
deleted id would load a broken SPA that immediately 404s on its own data fetches instead of 404ing
cleanly. Backend route names never collide with project ids because ULIDs are 26 chars of base32.

⚠️ **`/auth/logout` requires a valid token.** It was in the skip list, so any drive-by page could POST
it and force a `bumpSecretVersion`, logging out every active user — CSRF denial of service. The
handler's own docstring already described the 401 behavior; the code just did not agree.

## Tokens, credentials and the destructive-tool gate

JWTs carry `sub` (`"cli" | "session" | "stream"`) and `sv` (secret version). `/events` accepts only
`stream`; REST accepts only `cli`/`session`; a token with no `sv` always fails. `bumpSecretVersion`
(POST `/auth/logout`) rotates it and invalidates every outstanding token. Lifetimes: session 30d,
CLI 5min, stream 5min. `extractBearerToken` matches `/^Bearer[ \t]+(.+)$/i` because RFC 7235 makes
the scheme case-insensitive.

⚠️ **There is no auth cache, and do not add one back.** A previous `authDataCache` produced "the user
ran `mxd auth` but the running daemon never re-read `auth.json`". `readAuthData` hits disk on every
call; it is a small local JSON file and the cost is negligible against that failure mode.

**The long-lived session token never appears in a URL.** The frontend POSTs `/auth/stream-token`
(with the session Bearer) before every EventSource connect and passes the resulting 5-minute token
as `?token=`; the SSE heartbeat re-verifies it and, on expiry or revocation, emits a named
`auth_expired` event and closes the stream, which the client's watchdog turns into a fresh token and
a new EventSource. **`mxd watch` must do the same** — its own `sub: "cli"` token is rejected by
`/events`, producing a 401 → reconnect → 401 loop forever, and each reconnect must re-mint rather
than reuse a possibly-revoked token.

⚠️ **Credentials are masked on read and protected on write, in three places.** `maskConfig` replaces
every `authGroups.*.{apiKey, oauthToken, accessToken, refreshToken}` with `prefix…last4` on every
config view including the resolved and local layers; `mergeAuthGroups` preserves the plaintext when
a client echoes back a masked value, which is what keeps the UI's "save the entire authGroups
object" pattern safe; and `PATCH /projects/:id/config` and `/config/repo` **return 400 if the body
contains `authGroups` or `defaultAuth`**. That last one was CLI-only enforcement before, so a
non-friendly HTTP client could put its own credentials into a project's config and the next agent
run would use them.

⚠️ **UI logout is server-first, and the order is the point**: `await authFetch('/auth/logout')` →
`clearToken()` → reload. Clearing locally first leaves the session JWT valid on the server for up to
30 days, so a stolen `localStorage` copy replays from another browser. If the POST fails the local
clear still happens — the user's intent to end the session is unconditional.

⚠️ **`auth.json` needs BOTH a mode on write and a chmod on init, because of a POSIX detail that
looks like a bug.** Node's `fs.writeFile(path, data, {mode})` only honors `mode` on file CREATION
(`O_CREAT`); overwriting an existing file silently preserves whatever mode the inode already has. So
`{mode: 0o600}` secures new files, and `ensureSecureFileMode` at daemon boot upgrades loose existing
ones. Without the chmod pass, an `auth.json` created by an older version stays `0o644` forever even
after every rewrite, leaving `jwtSecret` world-readable and forgeable by any local user. The mask is
`(mode & 0o077) !== 0`, which fires only on a group/other bit and therefore leaves a user-hardened
`0o400` alone.

**Destructive tools check `requireSubtreePermission` at handler entry**: `update_task` (all
mutations, not only reparent), `close_task`, `delete_task`, `reset_task`, and the three folder tools
(resolving a folder to its nearest task ancestor). `reorder_tasks` and `fork_task_context` already
had it; the point was making the whole destructive suite consistent.

**Upstream errors are classified before they reach a user.** `classifyUpstreamError` maps
`{status, keyword}` to `auth / rate_limit / credits / invalid_request / upstream_down / network /
other` with a one-line headline, keeping the raw message (trimmed to 300 chars) for debugging.
Users no longer see raw Anthropic JSON blobs.

**Layering**: `tool-auth.ts` owns the opaque `Auth` type and `checkPermission(auth, mode, resource)`;
`resource-registry.ts` owns handle-based global functions (`R.getTracker`, `R.emit`) with no
closures; `tool-def.ts` owns `ParamDecl` with `bind`, so bound params are hidden from the agent and
filled automatically. Every tool is a `ToolDef` with an auth-aware handler — there are no
closure-based handlers left. `AuthGroup` is a discriminated union on `provider`.

## The external MCP endpoint

`POST /api/matrix/mcp` is a stateless MCP Streamable HTTP transport for external clients — no
attach, no session state. Six tools, gated by `availability: "internal" | "external" | "both"` on
every ToolDef. The intended workflow is `send_user_message` → `yield_external` → `get_logs`.
`get_logs` is `"external"` rather than `"both"` because agents do not need to read each other's
JSONL.

⚠️ **Anti-pattern this endpoint taught us: an attached external observer and a peer project are
different relationships.** Layer 1 is asymmetric (an observer attached to a running agent); layer 2
is symmetric (two projects as peers). **The same wire format does not make them the same semantic** —
check symmetry before unifying two things that look alike on the wire.

## CLI onboarding

⚠️ **`mxd config auth add` auto-promotes the first group to `defaultAuth`.** Provider resolution
reads `cfg.defaultAuth`, so add-without-promote was a half-command: a fresh user followed the README,
ran `mxd config auth add anthropic --key …`, and the next `mxd send` threw "No auth group
configured". Adding a *second* provider leaves the existing default alone and prints how to switch —
we never silently clobber an existing pick.

⚠️ **macOS test gotcha**: `mkdtemp(tmpdir())` returns `/var/folders/…` while a spawned subprocess's
`process.cwd()` returns the resolved `/private/var/folders/…`. `resolveCurrentProject` compares
strings, fails, and the CLI exits with "No project found for current directory" long before reaching
whatever you were testing. Wrap fixture paths in `realpathSync`.

---
# Web UI — Routing, State & Event Handling
---

## Root is a regular task: the null-sentinel anti-pattern

> ⚠️ **Any code that treats root specially at the ROUTING, TARGETING or IDENTIFICATION level is
> wrong. Root has an id like any other task; use it.** Only the TREE VISUALIZATION layer legitimately
> knows which node is root, for drawing the hierarchy and the dedicated orchestrator tab. Every other
> layer should be oblivious to which id happens to be root.

This one anti-pattern produced five separate bugs over several weeks, and they look unrelated until
you see the shape:

- `targetNodeId = selectedTaskId ?? rootNodeId` — the pending-message filter then needed two
  branches, one comparing ids and one accepting `taskId === null`, so it was coupled to whether
  `rootNodeId` had populated yet. On a fresh mount, root-destined pending messages were **silently
  dropped**.
- `isOrchestratorNode = !selectedTaskId || selectedTaskId === rootNodeId` — `!selectedTaskId` is the
  sentinel meaning "treat as root", entangling routing with state-initialization timing.
- `tabScrollStateRef.get(selectedTaskId ?? "root")` — a literal string as a Map key, asymmetric with
  the SET branch (which guarded on `if (prevTabId)` and skipped null), so **root's scroll state was
  never persisted at all**.
- `usageTaskId = targetNodeId ?? selectedTaskId ?? rootNodeId ?? nodes.find(…) ?? "orchestrator"` —
  a four-deep fallback chain masking "nothing is selected" rather than rendering empty.
- The URL stripped the task component when the view matched root, so a refresh left no task in the
  URL at all.

**The fix everywhere is the same: `selectedTaskId` carries the actual root id when viewing root.** No
sentinel, no fallback. **If `selectedTaskId` is null, render nothing — it means "nothing selected
yet", and that is a valid state rather than a bug to paper over.** The URL normalization closes the
null window, so consumers stay simple: `AppFooter`'s filter is one comparison, and both views behave
identically.

Legitimate uses of `?? rootNodeId` that are NOT this anti-pattern: "where do I navigate after
closing the last tab" (a navigation decision, resolving an array-out-of-bounds), and
`if (!selectedTaskId) return` guards in destructive operations (asking "did the user actually click
a sub-task", not routing).

⭐ **Two design lessons came out of getting this wrong first.** The initial attempt built a
localStorage cache of `rootNodeId` so the first render could be correct synchronously:

> **When tempted to add a cache to make something synchronous, ask whether there is an existing
> async truth you can wait for instead.** There was — `/projects/:id/tasks` already returns
> `rootNodeId`. `useTasks` provides in 50-200ms exactly what the cache was caching, and a cache is
> only useful if you reject async, which there was no reason to do. Caches buy a skipped fetch and
> cost invalidation complexity forever.

> **Default to the loosest goal that satisfies the actual user need.** The goal was framed as "first
> render must be correct", which *forces* a synchronous source and pulls in the cache. The real need
> was "the pending banner appears within 200ms of refresh". "Correct after the first async settle"
> satisfies it and needs no new machinery. An over-strict goal is how solution complexity gets in.

## URL routing: each layer owns its own segment

`/<projectId>/<pluginScope>/<pluginPath>`. The shell owns the `/<projectId>/<pluginScope>/` prefix;
the plugin owns everything after it. The shell passes `pluginPath` down as a prop and
`pushPluginPath(path, replace?)` back up.

**Three invariants:**

1. The shell NEVER reads or writes `<pluginPath>`; the plugin NEVER reads or writes `<projectId>` or
   `<pluginScope>`.
2. **The URL is THE routing source of truth.** Neither layer caches anything, so refresh and
   back/forward are free. `replace = true` normalizes; the default `pushState` is for user actions.
3. `selectedTaskId` is DERIVED from `pluginPath`, not `useState`. There is no hashchange listener
   and no URL bookkeeping inside the plugin.

⭐ **The lesson, which is what makes this worth a section:**

> **When two layers coordinate through a shared serialized blob — one hash, one query string, one
> localStorage key — look for the segment each layer owns and give each direct access to only its
> own. If "they must agree" is the contract, the contract is wrong: sooner or later they disagree.**

That was not theoretical. The previous design put `#projectId/taskId` in one hash that both layers
wrote: the shell wrote the project part directly via `window.location.hash`, the plugin wrote the
task part, and they trampled each other on refresh and on every SSE update. The shell also never
read the hash on mount, so it defaulted to `projects[0].id` regardless of the URL — meaning a
refresh on a specific project sent task events to the wrong session. Back was broken because the
shell created history entries the plugin did not know about.

The server-side half — why a refresh on such a path reaches the shell at all — is the `GET` +
`pm.has(firstSegment)` predicate in *Auth & External API*; it is one predicate for both the auth
bypass and the SPA-fallback wildcard, deliberately.

⚠️ **happy-dom limitation: do NOT spy on `window.history.pushState`/`replaceState`.** Instrumenting
them in `beforeEach` survives `GlobalRegistrator.unregister()` in ways nobody could diagnose and
poisoned every subsequent `web/*.test.tsx` file with ~18 spurious failures. If you must assert on
history calls, intercept at a layer the test owns (a harness that wraps the component and exposes
captured calls), or leave routing integration to a real browser and unit-test the pure
parse/build functions. Related: `history.replaceState` does **not** update `window.location.hash` in
happy-dom although real browsers do.

⚠️ **Process lesson, and it cost a wrong conclusion: never claim "pre-existing" without verifying
against main properly.** The claim was that 18 failures predated the change. The verification used
`git stash` — **which does not revert already-committed work**; `git reset --hard HEAD^` was needed.
And even correctly reverted, the baseline must be a bare full `bun test`, not `bun test web/`: on the
true baseline main had zero failures.

## Pending messages are a projection of the event log

Four successive fixes tried to patch a mutable `deferredMessages` map by changing *when* mutations
happen — and each closed one race and left the model in place. **The mutable state was the bug.**

`pendingReducer(state, action)` is a pure module-level function over `{type: "RESET"} | {type:
"APPLY", event}`: a `message` event with an id and a non-compact source appends; a
`messages_consumed` removes by id set; **every other event is a no-op.** Plugin.tsx drives it with a
synchronous write-through ref plus `setState`, so a `messages_consumed` later in the same batch sees
a message applied earlier in it.

**Invariants after the rewrite:**

1. Pending is a pure function of the event log. The reducer is the only thing that changes it.
2. **There is no imperative clear path.** `RESET` exists only for "replay from scratch".
3. Compact-source messages never enter pending, filtered at APPLY. The old model had to *clear* a
   `[compact]` chip; this one never adds it.
4. `tree_updated` does NOT touch pending. **A task's lifecycle status "pending" and a message's
   state "pending" are different concepts** that happen to share a word.

⚠️ **Unconsumed messages stay pending forever, and that is correct**, per the user: if the agent
never processed a message the UI should keep surfacing it. Silently clearing on compact was lying
about what happened.

⚠️ **One thing outside the reducer affects pending, so the reducer alone is no longer the whole
answer.** `handleEvent` suppresses an APPLY for a message id it already saw consumed in a batch
(`batchConsumedIds`). The race: `processEventBatch` does RESET plus a full JSONL replay, correctly
emptying pending — and then SSE catch-up events arriving *after* the batch can re-deliver a `message`
whose `messages_consumed` was already in it, re-adding a chip that nothing will ever clear. The
guard lives in the driver, not in the reducer, which stays pure. **Diagnosis worth keeping: all 22
"unconsumed" messages in the JSONL were compact-source and correctly excluded; zero user messages
were unconsumed. The backend was right and the bug was purely frontend timing.**

⭐ **The phase-discipline lesson from the last of the four patches, which outlived its own code:**
when several event types mutate one structure, **they must all mutate in the same phase.** Three did
it synchronously inside `processEvent`; `compact_marker` did it inside a deferred side-effect
closure. In single-event mode there is no loop between the two, so both look equivalent; in batch
mode the gap yawns open and a deferred clear wipes messages that arrived *after* the compact.
**Search any `sideEffects:` closure for non-React-state mutations — that is the smoke.**

## Partial events are monotonic snapshots

`assistant_text` and `thinking` can arrive with `partial: true` — synthetic events injected by the
events endpoint from `ctx.streamingText` / `ctx.streamingThinking`, never persisted and never
produced by a provider. They exist so a mid-stream refresh does not lose what has streamed so far.

> **A partial event is a snapshot of content that only grows. Clients extend to the longer of
> {current state, snapshot} and never shrink.**

That rule is why the ops are `extend_text`/`extend_thinking` rather than `replace_*`. On reconnect
the frontend does BOTH an SSE resume and a REST refetch, and the two deliver with opposite
semantics — SSE deltas append, a REST snapshot clobbers. Without extend semantics you get either
data loss (live "ABCDEF" overwritten by a stale "ABCDE") or duplication ("ABCDEFDEF"). Extend
adopts a longer prefix-matching snapshot, ignores a shorter or equal one, and on a prefix mismatch
prefers the longer and warns. **Final (non-partial) events still use `replace_*` — they are
authoritative rather than snapshots.**

⚠️ **Thinking specifically must extend rather than replace even though replace looks equivalent**:
a partial thinking event has an empty `signature` (we do not know the real one until the block
closes), and Anthropic needs that signature for prefix byte-identity on restart. Replace would
overwrite it with nothing. Extend touches only the text, and the final event installs both.

## `queueEntryToUIEvent` is THE UI materialization gate

⚠️ **Every `QueueMessage.source` that should be visible in the activity log MUST have a case in
`queueEntryToUIEvent`.** A missing case falls through to `default: null`, `materializeFromPending`
produces null, and **the event class is silently dropped — no error, no warning, nothing in the
DOM.** That is exactly what happened to post-compaction summaries: the message existed in JSONL and
went through the full two-phase lifecycle, and the UI showed nothing. The placeholder text in
`event-display.ts` was itself dead code, so the visible artifact was not even a wrong string.

Adding a new source means three places, in order: the union member in `src/message-queue.ts`, the
producer path, and this switch. Forget the third and the JSONL is perfect while the UI is empty.

Related routing decision: `compact` and `compacted_resume` both skip `pendingReducer` deliberately,
so no chip flashes during the brief emit→consume window. A new server-internal source belongs on
that skip list too.

## Project switch: remount, do not reset

`<PluginUI key={`${projectId}/${selectedScope}`}>`. When either segment changes React unmounts the
subtree and every `useState`/`useRef`/`useAgent` re-initialises from scratch.

This replaced a 25-line effect that watched a `prevProjectId` ref and manually cleared **fourteen**
pieces of state. ⭐ **"Detect that prop X changed and manually clear N pieces of local state" is a
consistent smell, and the manual version cannot be kept correct** — every new `useState` added
anywhere in the subtree has to be added to the reset list, and forgetting one leaks across projects.
`key={X}` resets everything, including state that does not exist yet.

## Small facts that are not obvious from the code

- **Events are fetched per-session, not per-project.** A forked session contains its parent's
  events, so merging by project produces stale content.
- **`hideCompleted` hides `closed` and `failed` only.** `verify` is actionable and must stay
  visible; that is a product decision, not an oversight in the filter.
- ⚠️ **The per-task draft debounce reads `targetRef.current`, not `targetNodeId` from the deps
  array.** With the value in deps, a render transition saves the previous task's prompt under the
  new task's `mxd-prompt-draft:<nodeId>` key.
- `/compact` targets the VIEWED task: the backend reads `nodeId` from the POST body and falls back
  to the root node.

---
# Web UI — Components & Interactions
---

## The activity log's scroll position: guard the property, not the list of causes

A survey of everything that reads, writes or invalidates the log's scroll offset found **30 touch
points, not the 9 anyone could name**: 9 JS writers, 5 readers, 6 pieces of state, 6 content-height
mutators inside the container, 6 clientHeight mutators outside it, 6 wholesale `logs` replacements —
plus the browser itself, via `overflow-anchor: auto`, which silently absorbs top-of-list insertions
and is not implemented by Safari. They fall into three clusters: measuring or writing during a
transitional state (unpredictable symptoms, because the transient's duration is a network variable);
addressing a viewport position by a **perishable identity** (a pixel offset, a module-counter entry
id, a React component instance — deterministic losses, each disguised as some other feature behaving
normally); and conditional renders in a flex row (cheap, cosmetic). Their common amplifier is that
`logs` is the whole session's array, replaced wholesale on every refetch.

⭐ **The predicate that works is `scrollRangeShrank(prev, current)`, where range = `scrollHeight −
clientHeight`.** Two predicates were proposed on the *cause* side and one measurement killed both:
"is the rendered content from the task being viewed" and "is the container non-scrollable" both miss
an in-log search that leaves 449px of range — fully scrollable — where a `scrollTop` of 1200 is
clamped to 449, which IS the new bottom, so the near-bottom test returns true and follow mode arms
itself. All five measured failures share not emptiness but *the scrollable range got smaller and the
browser pushed the offset to the new bottom*.

> **This generalises and a cause-list does not.** This subsystem had already proven the cause side
> cannot be enumerated — the survey started from "your nine are almost certainly incomplete" and
> ended at 30. `scrollRangeShrank` tests **the property that makes an observation meaningless**, so
> it covers causes nobody wrote down. The composer auto-growing is the proof: not a view parameter,
> not anticipated, and it lands in the predicate for free. It also collapsed two separately-
> catalogued classes — content-height changes inside the container and clientHeight changes outside
> it — into one. They were two classes only because they were sorted by *what changed*; sorted by
> *what it causes*, they are one thing.

**Growth is deliberately NOT suspicious**: streaming grows every frame, and a user scrolling back to
the bottom mid-stream must still be able to re-arm follow.

**`autoScroll` and `logAtBottom` are two concepts and must not be merged into one boolean.**
`logAtBottom`'s writers are all **observations**; `autoScroll`'s are one observation and six
**intents**, and the Follow button needs the intent concept. That single observation-writing-intent
(`handleScroll` reporting to both) is the door every hijack came through. Two halves, fixed
separately: the guard rejects a **false observation** (a clamp after a shrink), and the new-content
effect no longer takes `autoScroll` as a dependency, which stops a **true observation from
immediately executing** — the user scrolls into the 40px band, follow correctly arms, and the effect
used to fire and yank them the rest of the way mid-gesture. **Arming is not acting**, and "go to the
bottom now" already has its own channel (a monotonic `scrollToBottomRequest` counter). That fix was
a deletion, and the effect reads `autoScrollRef` so "responds to content, not to intent" is explicit
rather than implied by a deps array.

⚠️ **`prevScrollRangeRef` may ONLY be advanced by `handleScroll`, and the danger is that the wrong
version looks MORE thorough.** Letting a geometry-reading effect update it too makes the guard inert:
effects run at commit, the clamp's scroll event is dispatched by the browser *afterwards* (measured
14ms later), so the effect writes the new small value first and the comparison becomes new-vs-new.
The next person will read the single call site as a missed one.

⚠️ **"Only trust real user scrolls" is unimplementable.** A clamp-dispatched scroll event has
`isTrusted === true` and is indistinguishable from a user's at the event layer. Recorded, re-derived,
recorded again.

⚠️ **In a right-aligned flex row, inserting a child moves only the siblings BEFORE it.** So
conditionally-rendered controls belong *before* the persistent ones — cheaper than reserving blank
space and with no side effects. This is what made the header jump 71.3px when the Follow pill
appeared. (First measured as "100.3px on the whole actions group" — a container's property read as
the content's; re-measure per child.)

### Deleting an implementation that never worked

`tabScrollStateRef` (per-tab scroll memory) **never functioned**: the save ran in a passive effect
keyed on the task id, which runs *after* commit — by which time the list had emptied, the container
had collapsed and `scrollTop` was clamped to 0. It saved a destroyed value, structurally. It was
invisible because the follow-hijack it fed put you at the bottom anyway, which looked like normal
follow behavior.

⭐ **Deleting an implementation that never had an effect is not deciding the feature should not
exist — it is removing a lie.** The real feature needs an address that survives a refetch, which is
the same requirement as message deep-linking and active-chain membership: all three want persisted
event identity on every entry regardless of transport.

### The culprit was not in the scroll code at all

Symptom: *"from mid-output to output complete, my scroll gets yanked to somewhere above"* — only
visible with follow OFF. The chain: the viewed agent goes idle → a refetch replaces every entry
object → new entry ids → new React keys → the whole subtree unmounts and remounts → **the offset
does not survive the swap.** Measured from inside the DOM mutation:

```
t=87006  >>> REFETCH                   scrollTop 8089  scrollHeight 8823  children 85
t=87032  dom-mutation  removed:1       scrollTop 8089  scrollHeight 8809
t=87299  dom-mutation  added:82 removed:82   scrollTop 191   ← offset already gone
t=87313  js-write 191 -> 191           (the lazy-render anchor, pinning it)
```

**`added:82 removed:82` is the direct observation of every React key changing.** With stable keys
React reuses nodes and a normal update looks like the `removed:1` record — 82 out, 82 back,
`children` unchanged, is key churn measured rather than inferred. Note what it does *not* show: the
height is already restored by the time the observer's microtask runs, so "clamped to 0" is too
specific; the honest statement is that **the offset does not survive a wholesale replacement**, and
it lands wherever the intermediate geometry allowed (0 in one capture, 191 in another).

**The lazy-render anchor is an accomplice, not the cause**, and the arithmetic proves it: it captured
`scrollBottom = 8978 − 191 = 8787` against a `scrollHeight` of 8809-8978, so the offset was already
near the top when it ran. It **observed and reproduced** a position that was lost before it existed;
it did not compute a wrong one. That is what turns a one-frame flicker into a stuck state, and it is
why there is nothing to fix in the anchor. **Fix the keys.**

⚠️ **CORRECTION: "a wholesale replacement does not move the offset" is FALSE**, and an earlier round
measured it four times and concluded otherwise. The measurements were honest; the fixture held ~60-80
plain-text entries, which are cheap enough to tear down and rebuild that the collapse never survives
to a layout. A real session has images with no reserved height, expandable cards and markdown tables.
**The cost of a remount depends on how expensive the content is to rebuild, so a fixture made of
cheap content cannot answer the question at all.**

### The instrument's blind spot, and what it says about specifying measurements

The per-frame probe classified that exact jump as `range UNCHANGED → scroll anchoring or user — NOT
a clamp`. Wrong: the range collapsed and refilled **inside one frame**. Worse, `scrollHeight` never
dipped in any sample — read literally, that refutes "the container collapsed", and it does not:

```
t=87032  dom-mutation ...
         <- 267ms, ZERO samples (~16 expected at 60fps)
t=87299  dom-mutation  added:82 removed:82
```

The main thread was blocked solid for 267ms rebuilding 82 entries, so every rAF callback and observer
microtask queued behind it. **"No dip in the samples" is not "no dip."**

⚠️ **That is a systematic bias, not an edge case: the operations that cause large displacement are
exactly the operations that block the main thread long enough to hide themselves.** A per-frame
instrument is least able to see precisely the moments it is most needed for. Any instrument here
needs an observation that survives a blocked thread — a count taken either side of the render, or a
mutation record — not a sample taken during it.

⭐ **Before specifying a measurement, check that the instrument's resolution can carry it.** The
request that prompted this was "record `scrollHeight` every frame across the window", which is below
the instrument's resolution and whose failure mode is a **silent false negative** ("no dip, so not a
remount") that reads exactly like a real result. That is more dangerous than reasoning wrongly,
because it arrives wearing evidence's clothes. Three false negatives of this family landed in one
day: an over-specified observation, a fixture whose content was too cheap to reproduce the effect,
and a blocked-thread sampling gap. A fourth, twice in one session: **check what your selector
actually points at before believing a null result** — `log.children[0]` is the "load earlier" bar,
not an entry, so "the first node is still attached" was true on a build that remounts everything.

⭐ **And the counterpart: stop collecting once the answer cannot change the action.** Exactly where
in those 267ms the offset died does not alter the fix — do not remove the 82 nodes. Further rounds
of user reproduction would have bought precision nobody would spend.

### Fixing a "you end up at the bottom anyway" mechanism makes older displacement visible

This displacement had always been there. With follow ON, any content change re-triggered
scroll-to-bottom, so **every** displacement was overwritten by the same endpoint and none produced a
distinguishable symptom. Removing that overwrite is what made this one visible.

> **In a subsystem with a mechanism that keeps forcing one endpoint, that mechanism is masking every
> other bug that moves the same value.** Each masker you fix surfaces a symptom that has always been
> there; the user reports it as new and it is not a regression, it is *newly visible*. This explains
> a whole class of "I hit this often but cannot say when" reports, and it means a subsystem's bug
> count can appear to grow while it is genuinely getting better.

### Reusable method

- **Attribution beats reasoning here.** One reproduction with a probe that tags every programmatic
  write with who did it turned "something moved me and I don't know what" into two exact line
  numbers. The previous round needed a 30-touch-point survey to reach a *worse* answer.
- **Diagnose by absence.** Browser scroll anchoring goes through no JS path and fires no event, so
  "the offset moved and nobody wrote it" is itself the diagnosis. Instrument unclaimed movement, not
  just the writers.
- **A streaming mock provider is ~60 lines and puts a frontend bug on the real agent loop**: serve
  Anthropic's SSE shape on a local port and set `ANTHROPIC_BASE_URL` (the daemon passes
  `process.env` into the worker). You get real `text_delta`, real tool execution, real `end_turn`.
- **When you cannot reproduce, send the instrument to whoever can.** Four increasingly faithful
  local attempts failed; one paste into the user's console succeeded immediately.

## Rewind and Edit: report what the rollback does NOT undo

`analyzeRollbackImpact(entries, targetEid)` scans from the target entry to the end of the log,
**skipping entries from other tasks** (rollback is per-session, so a sibling agent's bash must not be
reported), and counts file / task / message side effects plus a generic bucket. An unknown
`targetEid` yields an empty impact, so the dialog claims nothing rather than guessing.

⚠️ **The read-only list is a WHITELIST, and that is the load-bearing choice.** `read_file`,
`list_files`, `search`, `search_tasks`, `get_tree`, `get_task`, `get_logs`, `list_projects`,
`background`, `yield` are named safe; **anything not whitelisted and not categorised sets the generic
warning.** Unknown tools — external MCP servers, `evaluate_script` — are never assumed safe. That is
why it is not "warn only on the three known categories".

⚠️ **`done` is NOT read-only, and the first cut whitelisted it.** A range crossing a `done()` then
rendered the green "nothing outside the conversation changes" box, which is a lie: `done()` flips the
task's status AND delivers `task_complete` to the task above, which may already have woken, reviewed
and merged. `done` now lives in both the task and message sets, which forced the classification loop
from a first-match `else if` chain to **independent membership checks** — the sets are otherwise
disjoint, so every single-category tool behaves exactly as before, pinned by a regression test.
Re-checked at the same time: `yield` is a pure loop pause and `background`'s kill is a stop rather
than a rollback-able state change, so both correctly stay whitelisted.

**Edit confirms at the moment ✎ is clicked, not at submit.** The warning's value is "before you
decide to edit", and intercepting the submit would need draft restore on cancel, since the composer
clears the prompt on submit. Accepted trade-off: the actual POST then happens without a second
confirm.

⚠️ **There is ONE "jump to bottom" mechanism, and it is a monotonic counter rather than
`setAutoScroll(true)`.** The follow effect only fires when `visible.length` or `autoScroll` CHANGES,
so rewinding while already at the bottom with an unchanged entry count changes neither and **nothing
scrolls** — which is exactly why the "jumps to the top" symptom was reported as intermittent. The
counter is applied in a `useLayoutEffect`, so it also runs before paint with no flash. This is a
SIBLING of the "Load earlier history" bottom-relative anchor, not a change to it: same class of bug
(a wholesale `entries` replacement invalidates the offset), opposite intent (land at the bottom
versus stay put).

⚠️ **A smooth `scrollIntoView` loses to follow mode.** Jumping back to the edited message got snapped
to the bottom mid-animation — observed live in a browser, not in tests. `setAutoScroll(false)` first,
then an INSTANT `scrollIntoView({block: "center"})`.

⚠️ **Test-harness gotcha with a real teeth**: `clearSessionState` drops log entries for a session
transitioning to `pending`, so a fixture seeded with `status: "pending"` **wipes its own log** the
moment the first `tree_updated` arrives. In happy-dom tests the SSE mock is a no-op so this never
fires; in a real browser the activity log renders "No events yet" while the events endpoint returns
data. Seed live-smoke fixtures with `verify` — a task that owns a session is never `pending` in
reality.

⚠️ **After a rollback re-fetch the log entries REMOUNT** (fresh ids → new React keys → new DOM
nodes), so any element captured before the rebuild is detached. Re-query it.

**Live smoke recipe, reusable**: temp dataDir + `projects.json` + `tree.json` + hand-written JSONL
with an explicit eid/parentEid chain (so nothing auto-migrates) under
`projects/<id>/plugin/matrix/`, `createTestToken`, `createDaemon`, `Bun.serve`. Then in the browser
`localStorage.setItem("mxd-jwt", token)` and navigate. **A user message needs BOTH a `message` event
carrying `id` and `eid` AND a `messages_consumed`** to materialize with its eid — the eid rides
through `pendingReducer` → `materializeFromPending`, and without it the Edit/Rewind buttons never
appear.

## Markdown rendering in agent replies

A hand-written parser for a lightweight subset — fenced code, headings, blockquotes, one level of
lists, hr, tables, and inline code/strong/em/strike/link. No markdown library, no
`dangerouslySetInnerHTML`, React elements only. **Strict grammar throughout, because a false positive
is worse than a missing feature.**

⚠️ **Parse order is load-bearing.** Fences FIRST, with their content verbatim and no table, block or
inline parsing inside (an unclosed fence runs to EOF). Then tables. Then per-line blocks, with **hr
checked BEFORE list**, since `- - -` is both. Then inline, where **code spans bind tightest** and
protect their content even during the search for an emphasis closer.

⚠️ **The plain fallback must stay byte-identical to no markdown at all.** When every block is a text
run of only text nodes, the original string renders in a single `<span className>` — the same element
as before markdown existed. Text containing only an unsafe link stays "plain" and renders its raw
source.

⚠️ **Link safety is one gate in the parser**: only `^https?://` (case-insensitive) becomes an anchor
with `target="_blank" rel="noopener noreferrer"`. `javascript:`, `data:`, `file:` and relative URLs
render as literal TEXT. Cells and inline nodes are React text children, so an `<img>` or `<b>` typed
by the model stays visible text.

⚠️ **Emphasis uses whitespace-adjacency rules, NOT word boundaries — that is what makes it
CJK-safe.** An opener must be followed by non-whitespace and a closer preceded by non-whitespace, so
`周围**中文**相邻` works where `\b` would not. A single-`*` closer must be a lone star, which is what
allows `*a **b** c*`. Runs of 3+ markers are literal, on purpose. Deliberately absent, each for a
concrete reason: `_underscore_` emphasis (snake_case identifiers), setext headings, backslash escapes
(Windows paths), images, raw HTML.

⚠️ **A table requires the header and delimiter rows to have the SAME cell count**, and that guard is
the entire defence against reading a thematic break or a piped prose line as a table.

⚠️ **The copy button copies the ORIGINAL markdown source**, not the rendered text, so it re-pastes
into another markdown surface verbatim.

⭐ **Mutation-testing finding worth keeping**: the symmetric math case alone did NOT pin the
opener/closer whitespace rules individually — two tests were covering for each other, so a mutation
survived. Each rule now has a dedicated asymmetric test (`** x**` stays literal; `**a ** b**` spans
the whole run). **A defence-in-depth pair can hide the fact that neither half is actually pinned.**

⚠️ Two biome traps in this file: a `noArrayIndexKey` suppression on multiline JSX must sit directly
above the `key={i}` attribute line, not above the element; and `useIterableCallbackReturn` requires
every switch path to return, which is why the last case and `default:` are merged.

## Interactions with a load-bearing event detail

**Select-to-quote ("Ask Matrix").** ⚠️ **`onMouseDown={e => e.preventDefault()}` on the floating
button is LOAD-BEARING**: without it, mousedown collapses the selection, `selectionchange` unmounts
the button, and the click never fires. The request carries a `seq` counter so quoting the *same* text
twice re-fires the consumer's effect.

⚠️ **The rAF that inserts the quote has a required ORDER, all in ONE frame**: recompute the capped
auto-grow height, then focus, then set the caret to the end, then `scrollTop = scrollHeight`. Reading
`scrollHeight` before the new height applies gives a stale value and the wrong scroll, so a long
quote leaves the user typing below the fold. **Do NOT rely on the separate `[prompt]` resize effect
having run first — React 18 flushes passive effects asynchronously and rAF-versus-passive ordering is
not guaranteed.**

**Global image drag-drop.** ⚠️ **RED LINE: never intercept internal HTML5 drags.** Task-tree reorder
and tab reorder set `dataTransfer` `text/plain`; every global handler gates on
`types.includes("Files")`, so internal drags pass through untouched. A file dropped on a task node is
preventDefaulted by the tree (no browser navigation) and still bubbles to the window handler.

⚠️ **The visual and functional halves are on different phases, and both choices are load-bearing.**
Functional (`dragover`, `drop`) is on BUBBLE, because the composer's own drop handler calls
`stopPropagation` — so a drop on the composer is handled there and does not also attach at the
window, which is what prevents a double-attach. Visual (`dragenter`/`dragleave` depth counter) is on
CAPTURE, so it fires before any inner bubble handler and cannot be desynced by that same
`stopPropagation`, leaving no stuck overlay and needing no timer or flicker heuristic.

⚠️ **CDP cannot synthesize an OS-file drag** — `drag` is element-to-element only. Both tests and live
smoke inject synthetic drops; "the browser does not open the file" rests on standard
`preventDefault` semantics plus a human with a real file.

**Sidebar filter toggle.** ⚠️ The reopen bug: open state lived in the parent and query state in the
child, and the input had an `onBlur` that auto-closed when empty. Clicking the toggle while the input
was focused and empty fired blur on **mousedown** (closing it) before the button's **click** (which
read `false` and flipped it back to `true`), so the box reopened. Fixed by one reducer over
`{open, query}` with the invariant **closed ⟹ query === ""**, and by **removing `onBlur` entirely**.
⚠️ **The behavior change is real and intended: an empty open search no longer collapses on
click-away.** If that is ever wanted back, use a document-level outside-click listener — **not**
`input.onBlur`, which re-introduces the race.

⚠️ **happy-dom cannot simulate typing into a React controlled input.** Both the native `input` event
and the `Object.getOwnPropertyDescriptor(...).value` setter trick fail to fire `onChange` (probed).
That is *why* the query was lifted to a controlled prop: filtering became testable by passing a prop
instead of typing. `.blur()` and keydown do work.

⚠️ **happy-dom v20 silently drops MutationObserver callbacks under GC pressure.**
`MutationObserverListener` stores its callback in a `new WeakRef(...)` with no strong reference
anywhere, and dispatch does `callback.deref()` — so after any GC pass, mutations are delivered to
nothing, with **no error**. A test relying on MO delivery passes in isolation (no GC between observe
and mutate) and flakes inside the full suite. Real browsers hold strong refs per spec, so production
is fine. **Rule: never let a happy-dom test depend on MutationObserver delivery.** Route the tested
behavior through a React effect and treat the MO path as a real-browser-only complement — and stub a
no-op MutationObserver so the mutation proof targets the effect branch exactly.

## Settings: one Save & Restart button, and the misconception it encodes

The panel has exactly two actions — **Save & Restart** (saves every dirty tab, then restarts the
daemon) and **Revert** (resets all tabs to last-saved) — and **no confirm dialogs anywhere**. Closing
the panel discards. Tab switching is deliberately not guarded, because each tab keeps an independent
draft and a confirm there is crying wolf, which trains users to ignore the real ones.

⚠️ **The mechanism everyone gets wrong: saving config takes effect on the NEXT run, with no restart.**
Save → the daemon syncs to workers → `ctx.globalConfig` updates → the next `resolveProjectConfig`
uses the new values. **Restart exists only to load newly deployed code.** The two got conflated
because the restart button used to sit next to Save; the single button now merges both actions so the
question does not arise, and the restart control's own label says "load new code".

⚠️ **A save that silently fails looks exactly like a save that was reverted**, and this shipped: the
draft dropped keys whose value became `""`, `buildPatch` then sent `null` for keys present in saved
but absent from draft, the server correctly rejected null on required global fields with a 400,
`updateConfig` **did not check `res.ok`**, and the refetch reverted the UI — so the user saw their
changes "disappear". Two fixes, and both are needed: `buildPatch(draft, saved, allowNull)` omits
nulls for global saves (repo and local keep `allowNull`, where null means "remove this override"),
and `updateConfig` returns an error message that surfaces as an inline banner with the draft left
dirty. **The server's null rejection was correct all along; the frontend was manufacturing the
nulls.**

## Small component facts worth knowing

- ⚠️ **A pure-image message with no text was rejected by both REST guards**, which tested
  `!content?.trim()`. They now also check `images.length`, `createUserMessage` gets a `content ?? ""`
  fallback, and the parent notification falls back to `"[image]"`.
- **Read-only tools default to collapsed but keep their body** (`isDefaultCollapsed`: `get_tree`,
  `get_task`, `search_tasks`, `list_projects`). That is a different thing from `isTitleOnly`, which
  removes the body entirely — users can still click to see results.
- ⚠️ **A `min-width` does not center-align a column whose content is wider than it.** The timestamp
  column drifted right because the action-button row (3×16px + gaps) exceeded its `min-width: 58px`
  with `align-items: center`. Fixed with a hard `width` plus `flex-start`.

---
# Testing
---

## Three layers: intention → tests → architecture

Tests are the single source of truth, and each layer can be challenged by the layer above but never
captured by the layer below. Three mutations guard them: is this behavior what users actually want
(intention); do the tests catch code changes (test); can the code evolve (architecture). Work
bottom-up — write tests, then find the simplest architecture that passes them.

## Integration tests are mandatory when a promise crosses a layer

**Use an integration test — full agent loop, `ValidatingMockAPI`, observe what the mock receives —
whenever:**

- a prompt, tool description or user-facing string promises a specific SHAPE ("output is bounded
  ~10KB", "stdout and stderr are labeled separately", "the path appears at top and bottom");
- a change affects what the LLM sees in a tool_result, system prompt or message;
- the behavior crosses the agent-loop / tool-execution / JSONL / mock-reply boundary.

A unit test proves a formatter returns X. **It does not prove the LLM observes X through MCP
wrapping plus tool_result persistence plus the mock-reply path**, and the gap between those two is
where prompt/code drift silently lives. The LLM then builds strategy on the lie, and no unit test
catches it. If a prompt says "X", something must construct the real invocation, run the full loop,
and assert the observed content matches X literally.

## The canonical user journey test is MANDATORY

If the feature's name describes a user action — "fresh-install bootstrap", "sidebar toggle on
desktop", "auto-save preserves output" — there **must** be a test that performs that exact action
and asserts the user-observable result. Testing subcomponents, supporting algorithms and edge cases
does not substitute. **The canonical path IS the feature; everything else is scaffolding.**

**Diagnostic**: open your test file. Is there a test whose whole shape is "do user-action X, observe
X works for the user"? If not, the feature is untested no matter how many other tests pass.

Four ways this fails silently, all observed:

- **Test config ≠ production config.** The test calls `createDaemon({installRoot: fake})` directly
  while production goes through `import.meta.main` with different flags. Only one path is tested.
- **Subcomponents tested individually, never the chain.** Three green units and no test that starts
  a real daemon and watches the whole flow.
- **Partial-chain assertion.** "Marker written ✓" — and the GET response, the UI reading the flag,
  and the backend guard are all unverified. The chain breaks after the first green check and no test
  looks.
- **Mocks matching the test rather than reality.** An in-process no-op `onBroadcast` where
  production goes through postMessage; the structural differences at process boundaries are never
  exercised.

**Minimum bar**: cross the real process boundary (spawn a real daemon and HTTP-call it if the
feature is about daemon behavior); run the journey by hand before `done("passed")`, and if you
cannot describe the concrete steps and what you observed, you have not verified it; and test every
observable consequence, not the first one. **"2003 tests pass" is not a merge gate. "I ran the
feature the way a user would and it worked" is.**

## ⚠️ Every `throw` in a test double must quote the real error it mirrors

**When a fake rejects something on the grounds that the real system would, the rejection message must
carry the real system's own error string. If you cannot quote it, you have not verified it, and it
does not belong in a predicate named after the real system.**

This rule exists because it moves the failure to the moment of WRITING. The claim that cost us four
production mechanisms propagated as a parenthesis in a bug report — *"Error from ValidatingMockAPI
(matches real Anthropic)"* — which nobody ever checked. Under this rule the author goes looking for
the API's wording, finds none, and stops there. **A rule is worth what its failure mode is worth,
not what it says.**

Three corollaries:

- **Separate OUR expectations from THEIR rules, by name.** A check we want but the API does not
  enforce is fine; it just may not live inside something called `validateRequest` or
  `assertValidApiMessages`. Give it its own name and let tests opt in. **A style rule hidden inside
  an API-validity predicate gets cited later as API behavior** — that is exactly how the alternation
  fiction became a documented fact.
- **A fake that is STRICTER than the real system is not "safe".** It manufactures phantom bugs, and
  phantom bugs get fixed with real complexity. Strictness in a double is an unverified claim about
  the system under test.
- ⭐ **Fix the double BEFORE the code it guards, and treat that ordering as the point.** A faithful
  double pays for itself on the very change that installs it. Measured inside one task: right after
  `ValidatingMockAPI` was made to mirror the API, the next commit extracted a `yield`-ing block into
  a generator and omitted `yield*` at both call sites — legal TS, zero diagnostics, the whole effect
  silently gone, requests going out with an unanswered `tool_use`. **8 tests caught it, all via the
  pairing rule that had just been added; under the previous double every one of them would have been
  green.** The reason to fix the double first is not tidiness — it is that you are about to be the
  one it catches.

## Two harnesses that exist because a whole bug class was invisible

⚠️ **`createMatrixApp` wraps `ctx.onBroadcast` in `structuredClone`, and every broadcast payload must
survive it**, because production's worker→shell postMessage boundary will reject anything else. This
exists because a sweep deleted a triple-JSON-serialize step that had been *accidentally* sanitizing
payloads — `broadcastTreeUpdate` was passing `tracker.allNodes()` with live `TaskSession` attached
and relying on that accident. Post-sweep, production threw `DataCloneError` on every tree mutation
and **no integration test caught it, because none of them exercised `structuredClone`.** Every
broadcast site must either construct a plain object or explicitly strip runtime-only fields.

⚠️ **`ValidatingMockAPI.enableStrictToolErrors()` fails a test on any unacknowledged `is_error`
tool_result.** Same regression is why: the missing `stripSession` made every
`create_task`/`update_task`/`delete_task` return `is_error` to the agent, dozens of tests invoked
those tools, and **not one failed, because nothing asserted the error state.** Opt out three ways: a
turn `assert` with `isError: true` (so tests that already express intent get coverage for free), a
global allowlist entry, or per-test disable for scenarios that deliberately invoke error tools. The
default allowlist contains the repair path's "Tool execution was interrupted by daemon restart",
which is a system contract rather than a bug.

## Drift tests and correctness tests catch different things — and unification created a blind spot

**Drift invariant** (prefix-validation integration tests): full agent loop plus restart, asserting
the live path and the reconstruction path produce identical bytes. It catches accidental parallel
construction paths, bugs in the non-walker paths (initial drain, session repair, compaction rebuild,
cache-control construction), and JSONL corruption.

**Correctness invariant** (golden snapshots): invoke the walker directly and assert exact output
bytes.

⚠️ **After the live path was unified to delegate to the walker, drift tests stopped being able to
catch walker bugs — and this was confirmed experimentally, not reasoned.** Removing the caption
handling from the walker leaves **all 27 integration prefix-validation tests passing**, because both
paths are now consistently wrong. The golden snapshot catches it by asserting the expected
`[text, image, caption]` output.

> ⭐ **Do not silently lose coverage when removing duplication.** Unifying two paths shifts
> responsibility: convergence tests can no longer establish correctness, so correctness tests must
> re-establish what the drift tests used to provide.

⚠️ **Golden-snapshot gotcha**: a user `message` event carrying an `id` is DEFERRED by the walker and
materializes only via `messages_consumed`. Without the consumption event it never renders, and your
fixture is silently testing nothing.

## Mutation testing: what to keep, and the two shapes it misses

**Keep every mutation that surprised you; cut every mutation that confirmed what you expected.** The
confirming ones are verification records — "reverting X fails test Y" — and belong in a commit
message. The surprising ones are discoveries about the test suite and are recorded nowhere else. The
tell is the sentence next to the table: *"I expected this to fail and it did not, because…"*

⚠️ **Guards need a two-sided mutation proof.** Everyone mutates the over-loose direction (delete the
guard). Almost nobody mutates the over-strict one — **and over-strict is the typical way a guard
fails**, because it reddens nothing and just silently stops a normal path working. Making a
follow-mode effect never scroll, i.e. killing the entire feature, left **11 of 12 tests in that file
green**, including four guard tests written the day before. So when you add a guard, explicitly write
a test for what it must NOT block and verify that test still passes with the guard in place.

⚠️ **Mutation testing cannot find a transition point that was never written.** A missing
`setActivity` on the way out of idle survived a full clean sweep — nothing failed, because nothing
existed to remove. It was caught by reading the comment that argued for its absence. **When a
comment argues why some code is unnecessary, that argument is the thing to check; the tests around
it are all consistent with it by construction.**

⚠️ **A test whose fixture cannot express the difference passes both ways.** Over-promotion of a glob
was invisible because the fixture contained exactly one `src/`, so `src/*.ts` and `**/src/*.ts`
returned the same files. And ⚠️ **a test that can fail for two different reasons cannot tell you
which one happened** — a guard's entire value is being legible on the day it fires, so narrow it to
presence-only rather than asserting an exact list.

⚠️ **Careless-git note**: reverting a mutation with `git checkout -- <file>` also reverts any
UNCOMMITTED fix in the same file. Commit the fix before mutating it.

## Test fixtures and harness traps

⚠️ **A fixture with unstable identity silently loses its resolution.** If it regenerates entry ids on
every render, every rerender is a full key change, the subtree remounts, MutationObserver fires, and
— with follow mode on — *the remount itself* scrolls to the bottom. The test does not go red; it
stops being able to see whether the code under test scrolled. Build the master array once and slice
it, which is also what production does. **Whenever a test asserts something about an effect, check
that the fixture is not producing that effect itself.**

⚠️ **An unfaithful double does not only make tests lie — it makes the missing test unthinkable.**
"Interrupt an agent mid-generation" had never been executed by any test in this suite, and not
because anyone skipped it: `createMockAnthropicStream` ignored the request's AbortSignal outright, so
every test that aborted mid-stream passed through a road that was open and led to the OPPOSITE of
production. Nothing fails, nothing is marked todo; the behaviour simply is not the product's. Nobody
writes "assert the abort actually aborts" when the harness cannot express the difference.

⚠️ **`activity === "thinking"` does NOT mean a request is in flight.** A session is BORN thinking
(setup is the residual state too), so a test that waits for `thinking` and then interrupts can land
before the first API call exists — and it **passes every park assertion while testing nothing about
aborting a request**. Key on `mockAPI.getRequestHistory().length >= 1`.

⚠️ **happy-dom does no layout, so geometry cannot be observed there.** It can still test the *causes*
of geometry — DOM order, commit granularity, whether a callback ran — which is far better than
dropping the test or mocking geometry brittlely. Anything genuinely about pixels needs a real
browser.

Three smaller traps that each cost real time:

- `await waitFor(() => x === null || true)` polls NOTHING (always true) and asserts before React
  commits. Poll the real condition.
- `expect(domNode).toBeNull()` prints the node **with its React fiber graph** on failure: one
  assertion produced a **227MB** log and a 60s test. Compare booleans in DOM tests.
- **A bare "timed out waiting for X" tells you nothing.** Dump the last few events alongside it —
  that turned two blind reruns into one answer.

## ⚠️ `bunfig.toml`'s preload is load-bearing; do not remove it

`preload = ["./src/test-utils/preload.ts"]` does one thing: `import "react-dom/client"` once per
process, before any test file.

react-dom is a process-wide singleton and its scheduler binds to whatever timer machinery exists at
**first import**. If that first import happens inside a registered happy-dom environment, the
scheduler binds that window's machinery — and when that file's `afterAll` calls
`GlobalRegistrator.unregister()`, scheduled render work stops flushing for **every subsequent test
file in the process**: fast assertions fail and renders time out at 5s. If the first import happens
under plain bun globals the binding is bun-native and immortal, and all later register/unregister
cycles are harmless.

⚠️ **`bun test`'s file order is filesystem-dependent — not alphabetical, not mtime — so this is a
latent landmine that any file addition can re-roll.** The baseline was green only because a benign
file happened to run first; adding four web test files reshuffled the order and produced 52 failures
across 11 files. **Do not remove the preload "because tests pass without it locally"**: passing
depends on file order, which depends on the filesystem. The preload is what makes order irrelevant.

Red herrings eliminated by probe, so nobody re-investigates: matchMedia mocks, happy-dom register
options, and `IS_REACT_ACT_ENVIRONMENT` are all innocent. ⚠️ And one bisect trap: a mangled probe
file whose `beforeAll` THROWS never registers happy-dom, so the paired victim file runs clean and it
looks like the mutation fixed the problem. Validate that a probe passes on its own before trusting a
bisect step.

---
# Build, Tooling & Housekeeping
---

## Deleting code

⭐ **"Test-only" is not "dead", and conflating them turns a cleanup into a risky migration.** An
audit called `tool()` (in `tool-definition.ts`) production-dead and asked for its removal. It IS
test-only — and it has 23 call sites, which makes it live test INFRASTRUCTURE. Deleting it would
have been a 23-site migration that pulls auth and ParamDefs into unit tests written specifically to
test `executeTool`'s Zod validation against a raw inputSchema; that changes what those tests test
rather than reclaiming anything. **The real violation was sitting next to it** — `stripZodMeta` and
`shapeToJsonSchema` existed verbatim in two files — and extracting those to a leaf module was the
actual win. **When an audit says "dead", check whether it means "unreferenced" or "only referenced
by tests"; the second is a different claim with a different answer.**

**Names that no longer exist, so you do not go looking** (re-verified 2026-07-25, since a deletion
record is the entry most likely to have been quietly undone): `persistent-queue.ts`,
`openai-compatible-provider.ts` (the whole Chat Completions path, with `eventsToOpenAIMessages`),
`hasPendingYield`, `truncateAfterLine` / `readWithLineMap` / `readActiveWithLineMap`,
`formatPendingSection`, `combineSystemPrompt`, `buildExternalJsonSchema`, `resetAuthDataCache`,
`clarifyTimeoutMs` and its whole config-through-UI vertical, `rollback_marker` / `appendRollback`,
`await_background`, `stripEventForUI`, `RelocateBanner.tsx`, the `_cache_audit.ts` / `_token_audit.ts`
scripts. ⚠️ **False positive to expect while checking**: a deleted function often still appears in
comments that explain its deletion, so a bare grep count is not the answer.

⭐ **Deletion beats repair when a feature is duplicative AND the user wants it gone.** Project-wide
"Clear All Sessions" (endpoint, CLI subcommand, settings button, slash command, `EventStore.clearAll`)
was deleted rather than fixed, because repairing it needed an architectural decision about whether the
shell may know plugin URL prefixes, and the feature had no unique use case — `reset_task` covers
per-task reset, delete-and-re-add covers a project reset. ⚠️ **Do not confuse it with what was KEPT**:
`EventStore.clear(sessionId)` (per-session), `POST /projects/:id/sessions/prune` (used by
autoResume and the CLI), the per-task `sessions/clear` route behind the UI's "Clear Session" button,
and the frontend's unrelated `clearSessionState` helper.

## The build pipeline is content-addressed

Every asset carries its content hash in its filename (`main-a1b2c3d4.js`) and is served
`Cache-Control: public, max-age=31536000, immutable`. The HTML referencing them is
`no-cache, must-revalidate`, so the browser always asks whether there is a new index and never asks
whether the hashed JS is fresh. A daemon rebuild changes the hashed URLs, the next navigation learns
them, and stale content is **impossible because stale URLs do not exist on disk**.

⚠️ **Do not add `Cache-Control: no-store` anywhere as a fallback**, and do not add a query-string
cache buster. Both are the cargo-cult reflex this design replaced: `no-store` re-downloads the whole
shell on every reload, and query strings defeat CDN caching. Either a URL is content-addressable
(immutable) or it is the index (no-cache).

⚠️ **Never hardcode a logical asset URL** like `/app/web/main.js` — only the manifest knows the real
hashed path. The importmap is built from that same manifest, and the build **throws** if an entry is
missing rather than emitting a bare specifier that would 404 at runtime.

⚠️ **A test pins the hash SHAPE with `[a-z0-9]{8}`.** Bun could widen its hash in a future version;
if it does, the manual CSS hash helper must be updated to match, and that test is what will tell you.

## Type errors that were all casts, and the gate that never ran

Twenty-four `tsc` errors accumulated across six merges. **Every one of them was a workaround for a
type the code already had correctly — zero `as unknown as` were added to fix them, all 24 fixes
DELETED a cast or a hack.** Four patterns, each a reusable diagnosis:

- ⚠️ **`(node as Record<string, unknown>).status = …` in a test fixture** — the field is ordinary,
  typed and writable. **A `Record<string, unknown>` cast on a domain object in a TEST is almost
  always a fixture-seeding shortcut, not a type problem. Look for the setter.**
- ⚠️ **A cast that fails with TS2352 means the type is MORE precise than you assumed, not less.**
  `(db as Record<string, unknown>).tokenizer = …` errored because `AnyOrama` has no index
  signature — and it declares `tokenizer` outright, so the plain assignment typechecks. **Read the
  `.d.ts` before laundering through `unknown`.**
- ⚠️ **`.filter(Boolean)` does NOT narrow.** `map(… | null).filter(Boolean)` still has type
  `(T | null)[]`, so every later access is "possibly null". Use `flatMap` (`return []` to drop,
  `return [v]` to keep), which infers the narrowed element type with no predicate. **Never "fix"
  this with `!` — the compiler is right that `filter(Boolean)` told it nothing.**
- ⚠️ **Reading a variant-only field off a union**: narrow on the `type` discriminant instead of
  casting. The narrowing usually makes the test STRONGER, since it now also asserts the event
  round-trips as that variant.

Two adjacent facts: `noUnusedLocals` cases are real, so delete them (a `_` prefix does not satisfy it
for locals or imports, only for function params); and `check:ci` exits 0 with ~158 warnings, because
warnings never fail the gate — **do not "fix" the warning count during a gate restoration**, since
biome's suggested `!` → `?.` autofix is marked unsafe and silently changes assertion semantics.

⚠️ **Why 24 errors accumulated is the more important half, and it is not "someone bypassed the
gate".** There was no gate to bypass — see *What is actually gated*. A **tracked** `.hooks/pre-commit`
existed and was referenced in this file as if it were active, while nothing pointed at it.

## Two smaller standing facts

`mxd` is installed globally via `bun link`; `package.json` has `"bin": { "mxd": "src/cli.ts" }` and
the CLI carries a `#!/usr/bin/env bun` shebang.

⚠️ **If `bun test` ever dies mid-suite, check the EXIT CODE rather than the summary.** Bun 1.3.7-1.3.8
had a native bug that killed the whole test process with SIGTRAP (exit 133) on any Worker teardown —
a libmalloc double-free in `pthread_exit` — so the crashing file ran first and "3 tests passed" was
meaningless while every claim of a green suite from that era was worthless. Fixed by upgrading to
1.3.14. The generalisable part is the check, and that a minimal 7-line repro (spawn a Worker,
terminate, observe exit 133) plus a version matrix over isolated installs settled in minutes what
days of test-level debugging could not.

---
# Reference & Pitfalls
---

## Editing the system prompt

The system prompt is **universal** across every project that uses Matrix. Each project has its own
`memory.md`, and agents elsewhere see the shared prompt plus THEIR memory — never ours. So:

- **Prompt**: principles, roles, tool semantics, communication patterns, task lifecycle, craft —
  anything true for any project using Matrix.
- **This file**: matrix-internal implementation, architecture, pitfalls, design decisions.

**The one matrix-internal detail the prompt is allowed to expose is the path where pre-compaction
events are preserved**, because a compacted agent otherwise has no way to read its own history.

⚠️ **Pitfall: "avoid internal" does NOT mean "delete the concept".** Told to strip matrix-internal
detail, agents delete the whole section. It means strip implementation-specific words and keep the
agent-experience concept — rewrite without `JSONL`, `checkpoint` and type names, keep the file path
agents operationally need. **Preserve what agents experience; remove what only implementers reason
about.**

Read the full prompt before editing it; it is for all Matrix users, not our project notebook. Prefer
a principle that generates behavior ("tests are our current truth") over a rule specifying one
behavior ("don't contort architecture for old tests"). Keep explicit rules only where they protect a
product property, such as the git worktree invariants.

⚠️ **The prompt contradicts itself across sessions and nothing catches it.** Prompt edits rot the
same three ways this file does, but the **superseded** kind is worse there because of the carrier.
This file has regions and topical adjacency, so putting a claim next to its refutation is a move you
can actually perform, and performing it is what makes the contradiction visible. **A prompt has no
such mechanism** — it is one linear argument, and two sentences sixty lines apart are never brought
together by anything. It does not present as a conflict either: **both sentences are individually
true and well written**, and they only cancel when someone holds both at once, which is exactly what
the linear form prevents. Observed in two commits one session apart, same file, same author: one
added *"every unfinished break is state you carry, in a context that runs out"*, and the other
existed to establish *"compaction is a continuation, not a stopping point"* — i.e. to deny the wall
the first had just asserted. No gate can see this: the prompt is a template literal, so typecheck
and biome only prove it parses, and the one test touching its content greps for hardcoded branch
names.

> **Before editing the prompt, read the recent prompt DIFFS, not just the current text**
> (`git log -p -5 -- src/system-prompts.ts`). The current text tells you what the prompt says; the
> recent diffs tell you what it has just *started* saying, which is the only place a fresh
> contradiction can come from. Afterwards, grep the file for the concept you leaned on and read
> every hit — the sentence that cancels yours will not share your wording.

⚠️ **Why that step gets skipped**, from the same pair of sessions: the round that INTRODUCED the
contradiction was required to re-read all 436 lines after editing and substituted a targeted grep,
reasoning *"rather than burn context re-reading 436 lines verbatim"* — while sitting at zero
compactions. The round that CAUGHT it did the full read, and the full read also found a second,
subtler collision. **This rule is worth exactly as much as the willingness to pay for it.**

## What is actually gated (and what is not)

Answer this before assuming a green result means anything.

| path | hook git looks for | gated? |
|---|---|---|
| direct `git commit` on main (memory curation, conflict resolution) | `pre-commit` | ✅ yes |
| `git merge --no-ff <branch>` with a clean auto-commit | `pre-merge-commit` | ❌ **no — that file does not exist** |
| a merge that CONFLICTS, then `git commit` after resolving | `pre-commit` | ✅ yes |
| any commit inside a sub-task worktree | none (`core.hooksPath=/dev/null`) | ❌ no, by design |

⚠️ **The clean merge — root's dominant path — is NOT gated, while the conflicting merge IS.** That is
backwards from intuition, and it is why "the hook passed" says very little about an integration.
Deliberately not fixed by adding `pre-merge-commit`: the branch model REQUIRES that intermediate
merges be allowed to not typecheck, and gating every merge would just re-establish the routine
`--no-verify` habit that hid 24 errors before. The options if it ever needs closing are to keep
merges ungated and run `bash .hooks/pre-commit` by hand once per integration, to add the hook and
accept `--no-verify` on intermediate merges, or to move enforcement off the commit hook entirely.

**Worktrees skip the hook on purpose** — sub-tasks commit constantly and a full typecheck plus lint
plus tests on each would be unusable. To check the gate from a worktree, run
`bash /path/to/main/.hooks/pre-commit` manually.

⚠️ **`core.hooksPath` is LOCAL config (`.git/config`) and is not tracked, so a fresh clone is ungated
again and looks identical to a gated one.** Install with `git config core.hooksPath .hooks`.

> ⭐ **A checked-in hook file is not an enforced hook.** For a long time `.hooks/pre-commit` existed,
> was referenced as if active, and nothing pointed at it — git was looking in `.git/hooks/`, which
> held only `.sample` files. **Nobody was gated anywhere**, every `--no-verify` was a no-op against a
> gate that did not exist, and the absence looked exactly like compliance. The only way to know is to
> assert it: `git config core.hooksPath`.

The hook itself runs typecheck, `check:ci`, `check-i18n.sh`, and `bun test --bail` on **5 of 140**
test files — see *Gates: a passing gate looks identical whether it read 8% or 100%*.

## Known pitfalls

- **This file**: never `write_file` to append. Use `edit_file` or `echo >>`.
- ⚠️ **A generator called without `yield*` is a SILENT NO-OP.** After extracting a `yield`-ing block
  into a helper, grep every call site for `yield*`. `foo()` on a `function*` builds a generator
  object and discards it — the body never runs. **Nothing catches this**: legal TS, no diagnostic, no
  lint warning, because the call genuinely returns a generator and the type system has no opinion
  about whether anyone iterates it. Observed cost: two missing `yield*` meant a tool_result reached
  neither JSONL nor `messages[]`, so requests went out with an unanswered `tool_use`.
- **Git worktrees**: `extensions.worktreeConfig` required; `core.hooksPath` absolute.
- **Biome**: typecheck BEFORE lint. No `!important`. No duplicate CSS properties. ⚠️ `bun run check`
  runs `--write` and silently formats 70+ files — use `check:ci` when debugging, and split a
  format-only sweep into its own commit.
- **`noUncheckedIndexedAccess`**: an array index returns `T | undefined`.
- ⚠️ **TS6133 and the `_` prefix**: `noUnusedLocals` does NOT respect a leading underscore for local
  variables or destructured locals — only for function parameters. For unused destructured React
  state use `const [, setX] = useState(...)`; for an unused `const`, delete it.
- **Commits do not restart the daemon.** Restart it manually after code changes — and remember the
  tools you call belong to the running daemon, not to your worktree.
- **Concurrent ULID**: use the full 26-char `ulid()`. Sliced ULIDs collide within one millisecond.
- **Provider queue close**: check `queue.isClosed` after tool execution and `return` immediately.
- ⚠️ **Never modify your own JSONL from inside an agent.** The current tool_call has no result yet, so
  you will read it as a false orphan.
- ⚠️ **`delete_task` cascades** to all descendants AND their session JSONL. It returns 400 if the task
  has children, which is the only thing standing between a misclick and unrecoverable loss.
- ⚠️ **Abort-signal leak**: after a stop, the old `runAgentForNode` settles asynchronously. The catch
  and finally check `sessionWasReplaced` to suppress stale error events from a session that is
  already gone.

## Known bugs and open design

**Open and reachable**: `/compact` on a session with `messages.length <= 4` whose last message is an
assistant turn sends a request ending in assistant → 400 *"does not support assistant message
prefill"*. Pinned by `src/reachable-400-snapshot.test.ts`, which asserts the CURRENT buggy shape.

**Open design questions**, re-checked rather than carried forward:

- **Subtree message routing.** The parent chain shipped — `send_message` walks upward through
  `getTaskAbove`, so any ancestor is reachable — but you can still only reach DIRECT sub tasks, not
  arbitrary descendants. That half is what remains open.
- **Tool search** — dynamic tool discovery instead of sending every tool. Anthropic has a server-side
  `defer_loading`; the user prefers a client-side design.
