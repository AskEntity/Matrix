# Matrix Project Memory

> Read on every session start. **This file holds the four things the code cannot hold: why we wanted
> it this way (in the words the decision was made in), how the next person will trip, the places two
> files three thousand lines apart are doing the same thing, and just enough implementation to make
> those three readable.**
>
> It does not hold mechanism. The code states mechanism better than prose can, and prose about
> mechanism rots without anything going red. If a paragraph you are writing would survive being
> replaced by "read the function", delete it.

## What this thing is, and the three facts the rest falls out of

**A self-bootstrapping multi-agent IDE. Every tab is a task, every task is a whole story. One
person, a team's output. Agents branch off like shoots and are grafted back into the trunk.**

Three facts. Almost every decision in this repo is downstream of one of them:

1. **An AI can hallucinate code. It cannot hallucinate a test result or a compiler error.** So
   execution is the only truth source, and *what a model believes it did* is never evidence — read
   the JSONL, run the command, look at the bytes.
2. **The context window fills.** Everything durable therefore lives outside it: the task tree, the
   JSONL, this file. An agent running low continues from a summary rather than stopping.
3. **The project runs on itself.** The tools you call belong to the *running daemon*, not to your
   worktree — so fixing a tool does not fix the tool in your hand, and a bug you write can break the
   thing you are writing it with.

`Matrix.md` is the pre-launch design doc, in Chinese, and nobody should need it day to day. **If you
go back to it to find out why we do something, that is a defect in THIS file — fix it here.**

## Language

Code, task tree and this file: English. `Matrix.md`: Chinese. Agent replies follow the sender's
language.

## How to run tests

**The command is exactly `bun test`.** No flags, no arguments, no pipes, no redirects.

```bash
bun test              # ALL tests (src/ + web/)
bun run typecheck     # tsc --noEmit
bun run check         # biome — WRITES, and silently formats 70+ files. `check:ci` is read-only.
```

**Piping is not size reduction, it is data loss.** The bash tool already bounds what reaches you and
saves the complete output to a file whose path it prints, so a pipe can only remove evidence you
cannot get back. The failure has one shape every time: pipe to `tail -8`, see `2116 pass / 2 fail`,
discover you cannot see *which* two, re-run with `| grep fail`, and get a **different** flaky subset
— because these tests flake at the scheduling level (ports, filesystem races, timer precision) and
there is no file ordering guarantee, so the grep run is questioning a different run than the one
that failed. Run it bare and read the saved file. ⚠️ Copy that path out of the tool result rather
than typing one from memory: it lives under the per-user `$TMPDIR`, and `/tmp/mxd/` also exists and
is empty, so a remembered path gives you "the tool lied to me".

⚠️ **The exit code and the pass count are two different claims, and only the exit code covers what
happens BETWEEN tests.** `2893 pass / 0 fail, exit 1` is not a contradiction to wave through — it is
bun reporting an unhandled rejection that no individual test was positioned to fail on. Read the
exit code first; when it disagrees with the summary, the summary is the one describing less. See
*An unhandled rejection is an outage here, not a log line* for why that stack matters far beyond the
test suite.

## How work moves through this repo

**Root never commits code to main.** Not as an abstract division of labour — because a direct commit
destroys clean rollback. A wrong fix that went through branch→merge reverts as ONE operation; the
same fix committed straight to main is interleaved with main's history and there is nothing clean to
revert. We have cleanly reverted both a wrong-semantic merge and a wrong-architecture merge exactly
that way, and only the branch model made it possible. The only direct-to-main operations are
merge-conflict resolution, memory curation, and task-tree management.

**Whoever introduces a change owns every consequence of it** — prompt, UI, tests, docs, i18n.

**Merging is signing, and a green hook is a floor rather than a ceiling.** The hook checks syntax,
types and a smoke subset. It does not check whether the diff addresses every point of the task,
whether layer boundaries held, or whether the child's self-report matches the diff — and that last
one differs non-trivially, because a child reports what it *thinks* it did. Read
`git diff main...<branch>` line by line before merging. The observed failure always has one shape:
child done → `git log --stat` → merge → post-merge bugs that a manual smoke caught immediately.
Watch for single-line catastrophes (`autoRegisterSelf: false` shipped exactly this way).

**Creating tasks is cheap; executing is deliberate.** Draft while the user is still discussing;
start when they say go.

⚠️ **`evaluate_script` is runtime introspection only.** Never use it to reparent tasks, edit the
tree, or run batch operations. Fix the tool instead.

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

The daemon holds no agent logic. The worker is a Bun Worker thread running the runtime. **Matrix
itself is a plugin** in `.mxd/plugin/`, discovered by the same scan as any other and special-cased
nowhere — that constraint is what keeps the runtime honest. Agent tree = task tree; each task gets a
worktree and a branch off its parent's branch.

**Files whose name does not tell you the thing you need to know.** Everything else is findable with
`list_files`; this is the exception set, and it fails by OMISSION — nothing ever contradicts it, it
just quietly stops being the answer to "where do I start". Add a row when you add a file a newcomer
must find.

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

**Every bug fix asks two questions, not one: what caused this specific bug, and why does the
architecture make this CLASS of bug easy?** The recurring answers are duplicate codepaths, lifecycle
coupling, legacy fallbacks masking bugs, and lazily-optional fields.

⚠️ **The compiler enumerates only what it can TYPE. Its silence means "nothing typed points here" —
it never means "nothing points here".** Anything reaching a symbol by NAME is invisible to it:
string-keyed dispatch, an event-type name matched across a process boundary, a field an external
system keys on. The asymmetry is what earns this a paragraph — a typed break costs one compiler
error and ten seconds, while a name-based break costs a silent, delayed, hard-to-attribute failure
in a system you were not looking at. `WAKE_SIGNALS` went on listing `agent_stopped` and
`orchestration_completed` for months after both names were replaced, so a stopped agent could only
ever wake an external client by timing out. **Grep for the symbol as a string before trusting the
error list, and check every boundary the type system does not cross.**

⭐ **Changed a BEHAVIOUR? Grep for the PROSE that describes it** — in this file, in docstrings, in
tool descriptions, in test names. This is the half the identifier rule misses, and it is the only
thing that finds the second kind of prose rot:

| kind | wrong when? | found by |
|---|---|---|
| **Fabricated** — a claim that was never true | the moment it is written | checking it against reality |
| **Invalidated** — a true statement about a neighbour | **later**, when the neighbour changes | *nothing you can do by re-reading it* |

Both appeared in one docstring on one day. The fabricated one was a benchmark quoted before the
benchmark was run, caught by its author reading their own diff. The invalidated one was true when
written, falsified two commits later by a change 300 lines away, and **auditing that same docstring
for falsehoods did not catch it, because nothing about the sentence is wrong on its face.** Two
directions to be careful in: *"changed nearby" is not "now false"*, and — the one that catches more —
⭐ ***"still true" is not "still accurate"***: one sentence survived as an invariant while the
mechanism under it was replaced, and a check looking only for false claims walks straight past that.

⭐ **Grep for the SENTENCE, not just the symbol.** A behaviour rule stated in prose lives in more
places than a grep for the CODE finds, and the distant surfaces are precisely the ones without the
identifier in them. Three surfaces of a removed `cd` rule were known; a fourth turned up only by
grepping the RULE itself with a tolerant pattern. ⚠️ **The highest-risk prose surface here is the
compaction checkpoint (`src/compaction.ts`), and it is nowhere near the code it describes.** It is
injected into an agent that has just lost its history, so nothing in that agent's context can
contradict a stale line — a rule that survives there gets taught, fresh, to every compacted agent,
and a grep scoped to the subsystem will never reach it. When one of its rules goes, **invert** its
test (`not.toContain`) rather than deleting it, or the removal ends up pinned by nothing.

### Deleting a mechanism built on a false premise: separate the PREMISE from the OBLIGATION

Having shown that the stated reason for some code is wrong, do **not** delete on that finding alone.
Answer two questions separately: what did it claim to prevent (the premise, now known false), and
what does it still actually DO (the obligation, possibly real and load-bearing)? Delete only where
the obligation is empty. Where it is real, keep the effect, relocate or re-justify it, and rewrite
the comment to name the true reason.

**Skip this and you delete a real guarantee along with the phantom, silently** — the premise was
false, so nothing else was protecting the obligation, and the tests that covered it were usually
written in the phantom's vocabulary too, so they go green or get "fixed" on the way out.

⚠️ **Check for a COST as well as for redundancy: "harmless, leave it" is not the safe default it
looks like, and the cost is usually written in the mechanism's own comment as an accepted
trade-off.** One dead collapse helper replaced entries in place, so the day a second producer
arrived two distinct entries would have rendered as one, carrying the last one's content at the
**first one's timestamp** — a latent wrong answer parked in the code waiting for a new caller.
Another such block answered every `done()` tool_call, which made resume detect a generic
interrupted-resume instead of a done-resume, silently losing the woken agent's done-resume context.

⭐ **The transferable half is what happens to the dead mechanism's TESTS, and the honest-looking move
is the wrong one.** *"Invert rather than delete"* is the right rule for the tests of a removed
FEATURE, and it does not reach the tests of a removed mechanism whose last producer is gone: those
would assert "nothing collapsed because nothing was produced", which passes against every
implementation including a deleted one. Three options, one right — delete mechanism and tests
together; keep both and RE-AIM the tests at a surviving producer; or keep the mechanism with no
coverage. **Re-aiming is the trap**, because it silently pins, as intended behaviour, whatever the
mechanism happens to do to a producer it was never designed for: chosen by nobody, and thereafter
defended by a test.

⚠️ **A guard on an unreachable state has to say IN THE TEST that it is a contract test**, or the
next reader tries to reproduce the scenario, fails, and concludes the test is wrong. Assert the
property that would be violated (two entries' **timestamps**, not their count — the failure being
guarded is content-and-position substitution, and a count assertion passes against a collapse that
kept two entries for some other reason).

## Where agents predictably go wrong

Not hypotheticals; each has cost us real work.

1. **The broken intermediate state feels more dangerous than it is.** Fear of a large change produces
   a revert, or a fallback that keeps the old path "just in case". Both are worse than the break: two
   codepaths drift silently and nobody knows which one ran. Delete until ONE remains.
2. **The existing shape is not a given.** "Why does this exist" beats "how do I make this work". And
   a "unification" that adds a third path is not a unification.
3. **Imagined requirements get built.** Building a tool or an analyzer, agents default to handling
   every case they can imagine — classifications, category labels, filter flags, pattern-matched
   explanations. Each branch corresponds to an imagined need, not an observed one; half end up dead,
   and the live half hides the data patterns a raw dump would have shown. **Start with the simplest
   raw dump and add heuristics only when real use exposes a concrete need.**
4. **"Start something new" wins locally and loses globally.** When a requirement appears, three
   options exist: create a task fresh, create and fork context into it, or `send_message` an existing
   (closed, verify, pending) task. The third is often correct and loses on every cheap dimension —
   fresh description vs stale, clean session vs unknown state, one step vs two, and the word "closed"
   reading as "finished" — so agents take the first and fragment context across redundant trees. The
   same shape appears as handing work to a fresh agent instead of continuing. Prompt alone has not
   fixed it; the mechanism design is draft `01KNZGYY4T6SYWVT66DK13XCPV`.
5. **Context is a compaction boundary, not a deadline.** An agent that feels low on context starts
   planning a handoff, cutting scope, or asking to be replaced. It continues from a summary instead,
   with the task description and this file intact by construction — so a compacted agent strictly
   DOMINATES a replacement. The only legitimate reason to hand off is that FAMILIARITY ITSELF has
   become the liability: a final read-through, an adversarial review, anything where not knowing the
   material is the requirement rather than the cost. ⚠️ **Agents estimate their own budget badly and
   confidently**: the one that offered a handoff was at 2.0M tokens having **never compacted once**,
   estimated 2-3 sections left in it, and on being told to continue finished all 5 plus an extra —
   roughly twice its own estimate, never reaching the boundary it budgeted against.

## Hard invariants

Violating any of these produces silent corruption rather than an error. The reasoning for each lives
in its own region; this is the index.

- **JSONL content fidelity.** What is written to JSONL is byte-identical to what was sent to the
  API. No truncation on persisted content — UI truncation happens at the rendering layer only.
- **Tool results are three-part.** Every tool_result must (1) emit to JSONL, (2) yield to SSE, and
  (3) push to `messages[]`. Missing any one gives an orphan, a missing UI entry, or an API 400.
- **Nothing writes to JSONL after a yield tool_call except the provider loop.** External events go
  to the queue, not to JSONL.
- **Persist before broadcast.** `emitEvent` writes to JSONL first and broadcasts the *stamped* copy,
  so every observer gets the event's durable name at the instant the event exists.
- **`deliverMessage` is THE message delivery path**: JSONL write → queue delivery → flush →
  auto-launch. No other code writes message events to JSONL.
- **One codepath per task operation.** `src/task-operations.ts` holds create/update/delete/close/
  reset/reorder; MCP and REST are thin wrappers. Behavioral differences are explicit
  (`if (editedBy === "user")`), never a second implementation.
- **Messages have a two-phase lifecycle.** `message` persisted → frontend defers; `messages_consumed`
  → frontend materializes. `QueueMessage.ts`, `Event.ts` and the displayed `[HH:MM:SS]` are all the
  same value, set once at creation.
- **Recovery must touch JSONL, not just memory.** In-memory `messages[]` and the JSONL events are two
  data structures. A "fix" that only edits `messages[]` leaves the poison on disk and it comes back
  on the next resume.

## ⚠️ Writing this file

What earns a place is the blockquote at the top of this file. **The reorganization procedure, the
rot taxonomy, the condensing rules and the measurement test all live in `.mxd/memory-reorg.md`** —
read them there, and put anything you learn about how this file fails there too. Two copies of a
procedure is drift, which this file has a whole section about.

**Never `write_file` this file.** It rewrites the whole thing, causing loss or duplication. Use
`edit_file` (match the last lines, extend) or `echo >> .mxd/memory.md`. Update it BEFORE calling
`done()`, and commit it alongside the code it describes.

⚠️ **Searching THIS file: anything over ~60 characters needs a multiline search.** It is hard wrapped
near 100 columns and the wrap lands mid-phrase, so a single-line `grep` for a sentence you can see
with your own eyes returns **0**. `git log -S"<long phrase>"` fails identically, so "when did this
sentence arrive" archaeology comes back silently empty. **The damage is the opposite of a missed
match**: you conclude the file does not say a thing, and then write it a second time — which is
exactly what a reorganization exists to remove. Search a short fragment, or collapse newlines first.

## Editing the system prompt

The system prompt is **universal** across every project that uses Matrix. Each project has its own
`memory.md`, and agents elsewhere see the shared prompt plus THEIR memory, never ours. So the prompt
gets principles, roles, tool semantics and craft; this file gets matrix-internal implementation,
architecture and pitfalls. The one matrix-internal detail the prompt is allowed to expose is the
path where pre-compaction events are preserved, because a compacted agent otherwise has no way to
read its own history.

⚠️ **The craft lessons in THIS file cannot be relocated to the prompt, and the attempt is the
proof.** It looks correct — "universal lessons belong in the universal prompt" follows directly from
the split above — and it was executed far enough to measure: the movable part shrank from an
estimated **310 lines to 82**, because **each rule here is welded to the specific thing that
happened, and the weld is what makes it work.** A craft rule in the prompt with no evidence is a
platitude every agent reads past; the same rule sitting next to the afternoon it cost is an
argument. The split still holds for a genuine DUPLICATE, where the prompt states a principle and
this file merely repeats it. It fails here because there is no duplicate: the prompt has the
principle and this file has the only evidence for it. **Someone will propose the move again.**

⚠️ **The prompt contradicts itself across sessions and nothing catches it.** This file has regions
and topical adjacency, so putting a claim next to its refutation is a move you can actually perform;
**a prompt is one linear argument, and two sentences sixty lines apart are never brought together by
anything.** It does not present as a conflict either — both are individually true and well written,
and they only cancel when someone holds both at once, which is what the linear form prevents.
Observed in two commits one session apart, same author: one added *"every unfinished break is state
you carry, in a context that runs out"*, the other existed to establish *"compaction is a
continuation, not a stopping point"*. Typecheck and biome only prove the template literal parses.
**So read the recent prompt DIFFS before editing, not just the current text** — the text says what
the prompt says, the diffs say what it has just *started* saying, which is the only place a fresh
contradiction can come from. Then re-read the whole thing: the round that INTRODUCED that
contradiction substituted a targeted grep for the full read, and the round that CAUGHT it did the
full read and found a second collision as well.

⚠️ **"Avoid matrix-internal detail" does NOT mean "delete the concept".** Told to strip internal
detail, agents delete the whole section. Strip implementation-specific words; keep the
agent-experience concept.

---
# How This Project Fools Itself
---

## ⭐ Plausible and wrong

> **The expensive failures here have not been mistakes that looked like mistakes. They have been
> well-written, well-evidenced, plausible things that were wrong — and each one then LOWERED THE BAR
> for everything downstream of it, because a check is only ever judged adequate against the
> explanation you currently believe.**

⭐ **What installs a fiction here is never a guess. It is something that LOOKS like evidence** — a
real error message carrying an unverified attribution, or a real published mechanism fitted to two
data points. **A guess invites checking; a citation suppresses it.** So the detectors below are all
about provenance rather than about plausibility.

**An ENFORCED fiction manufactures its own evidence.** `ValidatingMockAPI` enforced a
role-alternation rule that the Anthropic API does not have. **Our JSONL history contains 628
occurrences of "Messages must alternate roles" — every one from our own mock and none from the
API.** Four production mechanisms, one `test.todo` and one memory entry filed as a "reusable
pattern" were built to avoid a 400 that cannot happen.

How it got installed is the instructive part. The helper's own comment wrote down BOTH rules and
then chose between them: asserting the REAL rule (no trailing assistant message) would have reddened
correct fixtures, because some walker outputs are genuine conversation *prefixes* meant to be
extended. **That reasoning is correct.** So:

> ⚠️ **An inconvenient TRUE assertion plus a conveniently-green FALSE one means the false one gets
> installed, and is then believed as fact. The fiction does not win on persuasiveness — it wins on
> not causing trouble.** Once it lives inside a `throw` it starts MANUFACTURING EVIDENCE: 628 error
> strings from the rule that was *executed*, zero from the rule that was merely *documented*. **The
> knowledge was never lost; the enforcement was.**

⚠️ **Detector — do not audit whether the assertions are correct.** That comment was entirely
correct. Ask instead: **is the rule being ENFORCED the same rule that is DOCUMENTED?** Wherever those
two fork is where a fiction starts producing evidence. ⭐ **The fork does not only arrive inherited —
it can be born in code written minutes earlier, and a green test is what lets it survive**, because
the fixture chosen is the one drawn from the failure that happens in practice, which is exactly the
fixture that cannot separate the two rules. Build the fixture from the condition the rule NAMES, not
from the instance you have seen.

**An over-strict test double bills you three ways, and the third leaves no artifact.** It creates
complexity you pay for. It hides gaps — a fiction occupying the "role rules" slot stopped anyone
asking what the real role rule was, so the true one had zero coverage and a reachable production 400
sat there unnoticed. And ⭐ **it VETOES correct code**: interrupt an agent before it emits anything,
park it, send another message, and you get `[…, user, user]` — legal, and the old mock rejected it,
so the correct implementation could not be tested and the feature quietly acquired a reputation for
being hard to test. **Nothing was red. Ask what your test double has made people give up on, not
only what it has made them build.**

⭐ **Zero existing tests went red when the true rules were finally added, and that is the finding
rather than a disappointment. The fiction was not masking existing tests — it was masking the fact
that nobody had written the missing one.** A gap does not turn red; it stays invisible until someone
goes looking, which is why the probe had to be written by hand rather than discovered by running the
suite.

**Three shorter members of the same family, each a different medium:**

- **A wrong MECHANISM licenses a weaker test.** Chasing the CoreML NaN, a real published mechanism
  was found and fitted to two data points — over-fitting to n=2 while carrying a citation. "FP16
  overflows on long inputs" implies short inputs are safe, under which a single long probe is not
  merely adequate but *well-chosen*. **The causal story silently set the bar, so the check that
  would have caught it is the one the story talked you out of needing.**
- **The cheapest instance to guard against is READING.** A short instruction was given a coherent
  interpretation that fit its words, and acting on it would have deleted 660 lines of this file; the
  reading was defended with "a revert restores anything lost", which is true and beside the point —
  **the revert restores the lines, not the hour.** ⭐ **When an instruction is short and the action
  it licenses is expensive or irreversible, one clarifying question is always cheaper than a
  confident reading.** The temptation is strongest exactly when the reading is coherent, because
  coherence feels like confirmation.
- ⭐ **A measurement that contradicts your plan is not a result to report afterwards — it is a reason
  to stop.** Mid-execution of that same deletion, the first rung measured 82 lines against an
  estimate of 310, which already refuted the plan it was part of; the intent was to finish the cuts
  and report the discrepancy after. **Nothing about that is careless — it is the ordinary shape of
  finishing what you started**, which is exactly why it needs writing down: the surprising number
  arrives while you are busy, and "I'll report it when I'm done" costs nothing to think and
  everything if the plan was wrong.

## Reviewing: whose reference is it, and what shape of finding can it produce

Both halves came out of one 2026-04-03 documentation audit, and they compound.

⚠️ **A verification whose reference was produced by the verifier is not a verification.** That audit
reported five files "all verified clean". Its own session, ~320 events earlier, had sent the docs
project the numbered change-list those files had just been edited from — so it compared the docs
against its own instructions, and **agreement was structurally guaranteed.** Two properties make
this hard to catch rather than merely embarrassing. **Distance manufactures the illusion**: 320
events is far more than enough to stop experiencing a list as your own output, and by the time it is
read back it is simply *the criteria* — so the defence is not vigilance but asking **where did my
reference come from**, a question with a checkable answer, unlike "am I being circular", which has
none. And **`clean` is the one verdict that leaves nothing to review**, so it is accepted by default
and inherited by everyone downstream; here for **115 days**. ⚠️ A "clean" verdict does not even cover
the bytes it read — two commits landed on one of those files afterwards, one introducing a type that
has never existed. **Date the artifact, not the review: a verdict names a commit or it names
nothing.** The reusable form: **a review is evidence only to the extent its reference is INDEPENDENT
of the thing reviewed.** Code, a measurement, or a document someone else wrote are independent. Your
own change-list, task description or previous summary are not.

⭐ **A checklist derived from the artifact can only find contradictions, never omissions.** Walk a
document checking each claim and every finding you can possibly produce has the form "it says X, the
code says Y". You cannot produce "the code has Z and the document has never mentioned it", because
nothing in the document ever raised Z. That audit's findings were **100% contradictions and 0%
omissions**, and the ratio was a fact about the method, not about the documents: a whole-repo probe
for concepts absent from all four docs found **twelve** invisible subsystems — the plugin layer, the
Worker thread, dual lenses, `eid`/`parentEid`, the active chain, the search index, Edit/Rewind and
more. **This is the addition-list failure from *Gates* in a different medium**, which is why it lives
here rather than being filed as a documentation lesson. **The omission pass needs its own instrument
and it runs in the opposite direction: start from the CODE, enumerate what exists, and ask which of
those the reader would form a wrong model without** — that last clause is the bound, or the pass
never terminates. ⚠️ The trap for whoever runs it: **the omission pass makes the contradiction pass
look thorough by comparison**, because contradictions come with line numbers and quotes while
omissions come with an absence, and an absence reads as the weaker finding while being the larger
one.

⚠️ **Auditing a live repo: pin the commit, and expect it to move under you.** Mid-audit the target
gained two commits, one file went 984 → 1015 lines, every line number collected up to that point was
silently invalidated, and — worse — **one of the findings was fixed**, so reporting it would have
sent another team to redo work they had just finished. Record the target's HEAD when you start and
re-check it before you report; **re-derive line numbers mechanically from anchor TEXT at the end,
never carry the ones you noted while reading**; and diff the range before re-reading everything.
---
# The Agent Loop
---

## How an agent runs, parks and wakes

**An agent never ends; it parks.** Completion is `done()` and nothing else — `end_turn` with no tool
call is an implicit yield, never an implicit done. `handleImplicitYield` is the ONE place every path
that stops working ends up, which is what keeps "what is this agent waiting for" from becoming five
states.

**On resume, four states are read off the JSONL SHAPE**, never off an in-memory flag:

| shape | meaning | what happens |
|---|---|---|
| last tool_call is `yield` | explicit yield | bypass straight to `queue.wait` |
| last tool_call is `done` | pending done | wait for messages, then write the done tool_result with wake context |
| `hasPendingImplicitYield` | ended on `end_turn` | bypass to `queue.wait` → `handleImplicitYield` |
| orphaned tool_calls repaired | interrupted | non-blocking queue drain → API call |

⚠️ **`hasPendingImplicitYield` must stop at `messages_consumed`.** It used to walk straight over
consumptions, land on the `assistant_text` from BEFORE the message, and report a park — so the loop
parked on a conversation ending in an unanswered user message and **a message drained into a turn the
daemon died inside was silently never answered.** The window is a whole API call wide. `thinking` is
deliberately still transparent to it (below).

## Only launching agents that will act

> **`in_progress` is not the question and never was.** Status says the node was never finished. It
> says nothing about whether anything is owed, and today's dormant nodes have been `in_progress` for
> six weeks.

**Measured 2026-07-25: one daemon boot auto-resumed 14 nodes, and every single one looked at its log,
found nothing to do, and parked.** That cost 8 MCP-connected sessions, **32 subprocesses and 1.58 GB**
— and a parked session never ends, so they were held for the daemon's life. `shouldLaunchAgent(events)`
now answers "is anything owed here" BEFORE the session exists, because `runAgentForNode` connects
MCP, builds work_context and writes `session_config` before it ever looks at the conversation.

**It is an EXTRACTION of what the loop already decides, not a second opinion.** Every place the loop
declined to call the API was already correct; the change evaluates that same judgment one level
earlier. If the two ever disagree the loop wins and the predicate is wrong.

⚠️ **The cost did not vanish; it MOVED onto the path where a parent is waiting for its children.** A
parent used to be launched at boot and sit parked, so a child's `task_complete` woke a live agent in
microseconds; now that completion has to LAUNCH it. That is the intended trade, and it is invisible
in "32 → 0", which says what stopped being spent at boot and nothing about where it goes when it IS
needed. **Removing an eager cost relocates it to the moment of first use — ask what is waiting
there.**

⭐ **The boundary condition on hoisting ANY such decision is not the obvious one.** It is **not** "the
steps before the loop only read the log" — two of them manufacture input (`buildSessionRepair`
appends synthetic tool_results; bgOrphan synthesis invents a `background_complete` out of nothing on
disk). The rule is that **a decision can be hoisted iff every input it consumes is computable WITHOUT
performing the step that would create it.** Both qualify, being pure functions whose caller does the
writing. Stated the wrong way round, the next person concludes that a step which appends is
disqualified — the opposite of what holds. ⚠️ **A corrupt log whose repair cannot be expressed
LAUNCHES**, so it reaches `runAgentForNode` and gets reported; swallowing it into "nothing to do"
turns a loud failure into a node that never comes back.

**The one genuinely new rule is the `interrupt` exclusion**, a subtraction with a single named member:
it is the only message the loop writes ABOUT ITSELF rather than delivering as input. ⚠️ **It keys on
`source`, and must not be widened to "quiet".** `quiet` describes one moment of delivery and **does
not survive to JSONL**; worse, the generalisation is wrong on its own terms — crash-recovery
`task_complete` is delivered quiet *specifically so it does not double-launch*, so a "quiet sources do
not launch" rule strands a parent waiting on a child.

⚠️ **A log ending in `thinking` PARKS**, and the predicate agrees with the loop rather than
out-guessing it: the turn is deferred, not lost, and the next message ends it
`[…, assistant[thinking], user]`. **Measured against production, a thinking block is positionally
IDENTICAL to a text block**; only the TRAILING assistant message 400s, which is the trailing-assistant
rule wearing a different error string. A repair that dropped such a turn was built on the false
premise and is deleted.

**`launchingNodes` guards the window between "we decided to launch" and "the session exists", and the
lock is acquired atomically at the top of `ensureChildAgentRunning` with no await before
`beforeChildLaunch`.** That placement is the fix for a real race: `git worktree add` takes seconds,
two concurrent launches both used to get through, and the loser's throw marked the node `failed` and
sent a bogus `task_complete(failed)` while the winner was still running. `beforeChildLaunch` is the
SOLE worktree creator. ⚠️ **Never add a node to `launchingNodes` from outside `runAgentForNode`** —
`autoResumeProjects` once pre-registered every node it was about to launch, `runAgentForNode` saw the
set and returned early, and no agent ever started.

## done() is two-phase, and both of Phase 2's invariants were learned the hard way

**done() used to do everything inside the tool handler — status update, parent notification, queue
close — and it raced with messages still arriving.** So: **Phase 1 is agent-side** (close the queue,
exit the loop, no status update; done() is an *intended orphan* like yield, no tool_result written).
**Phase 2 is daemon-side** (status → verify/failed, `task_complete` to the parent, `done_notified` for
crash recovery). `session = null` is the irreversibility boundary.

⚠️ **`task_complete` must be DURABLE before `done_notified` is written.** The marker means "Phase 2
finished", so if it lands while `task_complete` has not, a crash in that window leaves the parent
waiting forever with nothing to re-deliver; the reverse window merely re-delivers a duplicate.
**That asymmetry is the whole reason for the ordering — a duplicate completion is recoverable, a lost
one hangs the parent.** The naive version looks fine, because the marker lands on this node's write
queue synchronously while `task_complete` goes through `await getTracker` first.

⚠️ **The loop promise must settle on EVERY path**, resolve inside the `finally`, throws logged and not
rethrown. `stopTask` awaits it with **no timeout**, so one leaked promise hangs the stop forever.

**Auto-launch failure IS task completion.** When `beforeChildLaunch` throws the target never runs, so
no done() ever fires and the sender's `yield` hangs forever; `deliverMessage`'s catch marks the node
`failed` and delivers `task_complete(success: false)`, and the sender wakes through the existing
resume flow because "failed before starting" and "failed during work" are indistinguishable from its
side. **Design rule: any code path that could silently hang a yielding parent must notify via
`task_complete`.**

⚠️ **Writing that handler and making it survive its OWN failure are two different problems, and the
second bites in exactly the shape the first was built to prevent.** The original was
`ensureChildAgentRunning(…).catch(async e => {…})` doing error event → status flip → `save()` →
deliver. An `async` function passed to `.catch()` has nobody to catch **it**, so a rejected `save()`
escaped as an unhandled rejection — and because the notification was last in a straight-line body,
that rejection **skipped** it. The handler whose entire purpose is "a parent must never wait forever"
then hung the parent, at the one moment something had already gone wrong. **The shape that holds:** a
NON-async `.catch` delegating to a named function where each COSMETIC step sits in its own try/catch
and the LOAD-BEARING delivery comes last but cannot be starved. ⚠️ **Do NOT collapse that into one
try/catch around the whole body** — it converts a loud unhandled rejection into a silently skipped
notification.

### An unhandled rejection is an outage here, not a log line

**Measured 2026-07-25: a rejected promise with no handler inside a Bun Worker ends the worker
thread.** Its pending timers never run and the daemon sees `worker.onerror`; in a plain Bun process it
exits the process outright. So a floating rejected promise in the runtime is a way to kill every agent
in that project's lens, and per *The self-bootstrap death chain* that death is indistinguishable from
a real crash to anyone reading the log. **The hang was the mild half** — worth saying in those words,
because the obvious framing ("a parent waits forever") describes the bounded consequence and silently
sets the priority for the whole class from it.

⚠️ **`MessageQueue.enqueue()` returns `void | Promise<void>`**, returning the Promise exactly when the
before-first-message hook is armed — a fresh session, and after every compaction re-arm. The idiom
around it is a sync `try/catch` at five production sites including `deliverMessage`, and **a sync
try/catch does not cover the async branch**: the rejection escapes and `return "enqueued"` reports a
delivery that may not have happened. The full classified census (26 sites, 11 real) is in task
`01KYDEFRM5WBDCRXPTGX75FYZ2`.

⭐ **DECIDED (`01KYDESAKCW186VZ8GEK6TW91W`): the worker should install an `unhandledRejection` handler
that LOGS AND LETS THE THREAD DIE.** It looks like the swallowing catch this file keeps arguing
against, and what resolves it is *what the handler does AFTER it logs*. Log-and-die is pure
attribution — semantics unchanged, an anonymous worker death becomes one that names the lens.
Log-and-swallow is the swallowing catch at PROCESS scope, and worse than the per-site version, because
the worker carries on in an unknown state while writing JSONL and managing worktrees. ⚠️ Installing a
handler SUPPRESSES the default action, so the death has to be re-raised deliberately.

## The done() payload, and the boundary it defends

**The runtime must not know what a plugin's completion MEANS.** `done()` has exactly two agent-facing
params — `status` (a control bit routing the node to verify/failed) and `result` (required, non-empty,
everything reported as content) — and `resultRounds` gets ONE block APPENDED per `done()`, never
overwritten, so a task woken and re-done N times carries N rounds in call order.

⭐ **The boundary is the point of the design.** The runtime MAY read `status` and ONE completion-output
string (every plugin has one). It MUST NOT carry the round structure or any other content field —
those are read only inside matrix's `onDone`, and the runtime passes the raw done input through as an
opaque `Record`. **The check is a grep**: `resultRounds`, `appendResultRound`, `parseDonePayload` and
`DonePayload` appear in `src/runtime/*`, `runtime.ts`, `provider-shared.ts` and `events.ts` only
inside boundary-explaining comments.

⚠️ **`onDone` returns void.** It used to return a plugin struct that got spread into `done_notified`,
letting a plugin inject arbitrary marker fields — removed, because the marker is write-only and only a
synthetic test used the channel. Do not re-add a `T["done"] | void` shape "just in case".

⭐ **Testing opacity requires data only the other layer understands** — the robustness test uses a
non-matrix scope whose `done()` carries `wordCount` and `mood`. **Testing with the default plugin's
own fields cannot distinguish "passed through opaque" from "reconstructed into that plugin's shape"**,
because both produce the same round.

⚠️ **KNOWN LIMITATION: crash-recovery Phase 2 does not append a resultRound.** It is plugin-agnostic
runtime code that sets status directly and never calls `onDone`; wiring it in would either break the
boundary or route crash recovery through a plugin hook.

⚠️ **Any change to a tool's required params has a transition window.** Tools are frozen in
`session_config` until a compaction refreshes them, so an agent mid-session keeps calling the old
shape, the obsolete param is stripped by zod, the required one is absent, and that done is rejected.
It costs one round and retries correctly — expected, not a bug. ⚠️ And when you rename a param,
**grep the FRONTEND**: done-card consumers read it BY NAME through index access, so typecheck cannot
catch it and integration tests do not render. Same by-name blindness as *Changing code here*.

## Duplicate yield or done in one turn

The API can return several `yield` tool_calls in one assistant turn. Repair skips the intended orphan
— specifically the LAST tool_call, not "any yield/done" — and the extras emit to JSONL immediately
while their live-path construction is DEFERRED, so on wake they bundle into ONE user message.

⭐ **The deferral is a live/walker BYTE-IDENTITY device, not an API-shape device**, and this was
misunderstood for a long time:

> Deferral is REQUIRED when the deferred tool_result is PERSISTED and lands ADJACENT to another one in
> JSONL, because the walker merges adjacent tool_results into one user message and the live path must
> match. It is UNNECESSARY when the message it would merge into is TRANSIENT.

⚠️ **So do not "simplify" it away by analogy with the compaction deferrals that were deleted.** Nothing
separates the extras' results from the real yield's in JSONL, so splitting the live push would require
inventing a JSONL boundary event — strictly more machinery. The compaction deferrals were removable for
the opposite reason: the summarization instruction is never persisted at all.

⚠️ **Duplicate `done()` calls must exit as orphans. Do NOT emit tool_results for all of them.** That
was tried, to avoid a repair path; it works, and it costs behavior — with every done answered, resume
detects a generic interrupted-resume instead of a done-resume, so the woken agent silently loses its
done-resume context.

## Compaction: ONE path, and the two bricks a second one produced

`/compact` enters the ordinary path unconditionally, whatever the conversation looks like.

⚠️ **Do NOT add a short-circuit for a conversation "too short to be worth compacting".** There was
one, twice, and each bricked sessions in its own way: v1 emitted the markers **without rebuilding
context**, so the next launch started on an ASSISTANT turn and every request 400s; v2 — the fix for
v1 — cleared the flag and continued with nothing pushed, so the very next request ended on the
assistant message the agent had parked on. **Shortness caused neither. Being a SECOND PATH did**: v2
inherited the shape of the thing it was patching rather than the correctness of the path next to it.
The cost of not having it is one API call and a near-useless summary when a human compacts a
two-message session, which is the price of the user asking.

⭐ **What made the deletion safe is worth more than the deletion: the branch's one real obligation had
already moved out of it.** It used to consume the pending tool_result and the duplicate-yield extras
— the **pairing** rule, which is real. That now happens where the tool_result is EMITTED, so the
ordinary path inherits it for free. A second worked example of *Deleting a mechanism built on a false
premise: separate the PREMISE from the OBLIGATION*.

⚠️ **STANDING DEFECT of the automatic trigger: a session with ≤4 messages cannot auto-compact no
matter how large it is.** One giant tool result puts a 3-message session over the threshold and it
keeps calling the API until the context window rejects it. **It is not a consequence of removing the
manual short path** — the two used to be independent `if`s and `auto + len <= 4` already fell through
both.

⭐ **Why the floor exists at all**, since "delete the magic 4" is the obvious reading and would
reintroduce something worse: a freshly compacted session sits at ~1 message, so if the token count is
STILL over threshold — system prompt plus tools plus summary already exceed it — the loop would
compact again immediately, forever. **The floor is a PROXY, and a bad one: the condition it stands in
for is "compacting will not reduce anything", which has nothing to do with message count.** ⚠️ **If
you replace it, replace it with a measurement, not a smaller number** — compact, and if still over,
say so loudly and stop auto-compacting for that session. "Even a full compaction cannot get this under
the limit" is a real configuration problem the user needs to see, and both of today's behaviours hide
it equally well. Code-level half of `01KXNZHYSJFF0BVQJVPG2WC1RV`.

**Session config is refreshed at the compaction boundary, and only there** — compaction wipes
`messages[]`, so the cache is already lost, which makes it the one safe moment. ⚠️ **`request.systemPrompt`
must be updated too, not just the emitted event**: the next API call reads the former, so refreshing
only the event looks complete and leaves the next call on the stale prompt. `cacheTtl` is deliberately
NOT refreshed, to preserve fork inheritance.

## Interrupt and stop are two abort channels, and they cannot be one

**An interrupt takes a running agent from mid-turn to idle-waiting-for-input and tears down nothing.**
A stop is teardown: kill background processes, close the queue, drop the session, disconnect MCP.
They were the same button in the UI before this, and they are opposite verbs.

The signal is `TaskSession.interrupt`, deliberately **not** `session.abortController`. Sharing one
channel gives you either "an interrupt tore the session down" or "a teardown was mistaken for an
interrupt so it could not tear down", and **both are silent**. They meet in exactly one place —
`AbortSignal.any([teardown, interrupt])` — and every reader checks teardown FIRST.

**No repair is owed, and that is the point.** `stopTask` leaves tool_calls unclosed because the loop is
already dead, so the next launch's repair writes *"interrupted by daemon restart"* — false whenever a
human pressed stop, and re-read by the model on every later turn. An interrupt keeps the loop alive, so
it closes its own tool_calls before parking.

**Partial assistant text is KEPT, deliberately.** It makes the interrupted state representable on disk
with zero new resume states; it gives the user's next message a referent, because "no, don't do that"
needs the text they were reading; and emitting it as a normal final `assistant_text` is what clears the
UI's streaming partial. Never the thinking blocks (no signature), never a half-emitted `tool_use`.

⚠️ **Do NOT front-run the queue when parking.** A message drained at the cancellation point would be
merged into the turn's user message and then sat on — the loop would wait for a *further* message
before calling the API, so "stop, do X instead" would look swallowed. Left in the queue,
`handleImplicitYield` returns it immediately. ⚠️ **`consume()` is called when the loop PARKS, not when
it decides to**; clear the flag at the decision point and a stop landing as the agent goes idle on its
own leaves the flag set, swallowing the next message.

**Compaction turns are not interruptible mid-flight** — the summarization instruction is already in
`messages[]` and cutting there pairs "summarize yourself" with whatever the user says next. **`done()`
wins a race with the stop button**, because that is completion, and marking it "not executed" would
strand the parent forever.

⚠️ **"I pressed stop, then restarted the daemon, and it started working again" used to be an accepted
boundary, and how the trade CHANGED is the transferable part.** In the window *interrupt → restart with
no message between*, the log could not tell "the user stopped me" from "I died mid-work" — an interrupt
during a tool leaves tool_results, byte-for-byte what a daemon death inside an API call leaves. The
stated price of fixing it was a persisted marker, i.e. a **fifth resume state**, which this design
refuses. **What changed is that the marker acquired a second, unrelated buyer**: `shouldLaunchAgent` has
to answer the same question before a session exists. One `message` event with `source: "interrupt"`
settles both. ⭐ **And it is NOT the fifth resume state** — resume still reads exactly four shapes; the
marker is an ordinary queue message that happens to be written by the loop about itself. **A cost
rejected as "a new state in the state machine" can become payable as "an existing mechanism used once
more", and those are worth re-pricing separately.**

## Agent activity: live process state is asked for, never replayed

**"Is the agent working" was three layers of heuristics stacked on a boolean that itself had three
sources** — a 500ms poll, a timer, and a correcting re-poll, each covering the layer above it. It is
now ONE explicit state in backend memory:

> **State is never derived from the event log. On connect the client ASKS; while connected the server
> PUSHES.**

The log records *"it became active at some past instant"*; replaying that as *"it is active now"* is a
category error, and the old poll existed only to undo the error it had just made. Note the exact
inversion against pending messages: pending IS a projection of a persistent log, so a reducer over
events is right there. **The question to ask is "does this thing exist on disk?"**

`AgentActivity = "idle" | "thinking" | "tool"`, asymmetric on purpose. `tool` is the precise one because
it is the only state with an unclosed tool_call, which is the one with an interrupt consequence. `idle`
means parked on `queue.wait()`. **`thinking` is explicitly the residual** — every other way the loop is
alive — which makes retry backoff, session setup and compaction turns consequences rather than special
cases. Known naming debt, deliberately unfixed: a compaction runs 2-3 minutes and "Thinking…" across it
is the same kind of lie this model removed; adding `compacting` later is a pure carve-OUT of the
residual, cheap precisely because the residual is written down.

⚠️ **Rejected framing, offered and vetoed: defining the states by what feedback the user sees** (spinner
vs tool card). That defines backend state in terms of frontend rendering — the same class of error as
deriving it from the log — and collapses the moment a UI affordance is added.

It lives on `TaskSession.activity`, so it dies with the session and there is no second lifecycle to keep
in sync. **The field write and the broadcast must happen in the same function**, which is why the setter
is passed INTO `handleImplicitYield` rather than the event emitted there and the field written at its
four call sites — split them and call site number five gets only one half.

⚠️ **`idle` is announced only when the loop will ACTUALLY park.** Not flicker avoidance: it is what makes
`idle` mean "waiting for you" rather than "reached a yield point", and both consumers depend on the
stronger meaning — `yield_external` wakes an external client on it, and the UI re-fetches JSONL on it.

⚠️ **There is a `thinking` transition on the way OUT of idle, and the argument for omitting it was wrong
in an instructive way.** The reasoning: every path leaving `handleImplicitYield` reaches the API block,
so a second setter is unobservable — *the emitted event sequence is identical either way*. True, and
irrelevant, because **consumers read the STORED value, not the event stream.** Without the transition
the entire wake window reports `idle` for a loop that is provably not parked, and the documented
`send_user_message → yield_external` workflow lands exactly there and is told the agent stopped working.
**The structural fix is the dedupe, not the extra line**: `setActivity` early-returns on an unchanged
state, which makes "an extra `setActivity` call is harmless" true, so you write a transition wherever the
loop changes what it is doing and never reason about it again.

**`agent_activity` is a broadcast-only delta and must never reach JSONL** — that is what makes "replaying
history cannot fake-activate an agent" structurally true instead of corrected afterwards. A separate
snapshot goes daemon→client on SSE connect, **sent even when empty**, because "nothing is running" is
exactly what a client reconnecting after everything stopped needs in order to drop stale entries.

⚠️ **A consumer that a grep for `activeAgents` does NOT find**, and the canonical local instance of the
by-name blindness in *Changing code here*: `yield_external` subscribes to the `agent_idle` **event type
name** in `WAKE_SIGNALS`. It is matched now via a predicate on `agent_activity`, and **the reported
reason string stays `"agent_idle"` because that is the tool's external contract**, unrelated to our
internal event names.

## An anomalous stop idles the agent silently

An assistant turn returning **thinking only** — no text, no tool_call — makes the loop see
`toolUses.length === 0`, treat it as end of turn, and implicitly yield **with no user-visible signal**.
For a root in conversation this is benign; a human eventually pokes it. **For an autonomous sub-agent
nobody is watching it is an indefinite hang, and the parent's yield never wakes: the live case sat idle
for 8 days.** Our gap is that `getStopReason()` collapses every non-`end_turn` reason — `refusal`,
`pause_turn`, `model_context_window_exceeded` — to `tool_use`. The guard (draft
`01KXK69KKKGG4XHPH7EWGNY5AC`) is a persisted, user-visible error event **before** idling for any stop
reason outside `{end_turn, tool_use}`, plus a bounded `pause_turn` continue.

⚠️ **Agent time perception is DATE-BLIND, and it fails confidently.** Context timestamps are `[HH:MM:SS]`
with no date, so the 8-day agent woke and reported "~80 minutes" — 14:56 → 16:13 looks same-day.
**Ground truth is the epoch `ts` in the JSONL.** Root hit the identical thing with an overnight test run
whose `[22:06]` → `[11:04]` gap was only inferable from anomalous test durations.

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

## The bash result names its own working directory — and a one-shot warning could not

Every bash result whose working directory is not the agent's worktree root opens with a line naming
it. Three states, and the quiet one is EXACTLY the root:

| cwd | line |
|---|---|
| exactly your worktree root | *(nothing)* |
| below your root | `[cwd: <dir>]` |
| a different checkout | `[cwd: <dir> — OUTSIDE your worktree, which is <root>]` |

**The failure it removes is invisible by construction**, which is why a stronger warning was not the
fix: after a `cd` out of the worktree, every later command succeeds, `git status` reports cleanly,
and the output looks authoritative. An agent in another project `cd`'d into this repo, missed the
one-shot warning, then built a five-link evidence chain — empty `git status --porcelain`, `ls`
returning "No such file or directory", a `git check-ignore` hit — and **filed a two-bug report
against this daemon.** Every link was individually valid; they were answers about a different
repository. Root hit the same shape twice in one day.

⭐ **The general rule, worth more than the feature: a one-shot notification cannot signal a
persistent condition — the notification's lifetime has to match the state's.** The old warning fired
at the moment of the `cd` and never again, so it covered the one result the agent was already paying
attention to and left silent every result where the mistake actually does its damage.

⭐ **And the corollary that decided a live disagreement: once every affected result carries the
state, the transition warning's firing condition is a strict SUBSET of it, so "keep both" means
printing the same fact twice in one result.** Deleted. What is NOT redundant, and stays, is
`workdir set to X from now on` — that reports an EVENT (you just moved), the notice reports a STATE
(this is where the output above came from). Neither substitutes for the other, and the distinction is
worth keeping in hand: it is the same one that separates an SSE delta from a snapshot.

⚠️ **Which checkout a directory belongs to is answered by `git rev-parse --show-toplevel`, and both
obvious simplifications are wrong:**

- **A path-prefix test** (`cwd.startsWith(worktreeRoot + "/")`) calls `.worktrees/<other-task>`
  "inside", because it IS under the main repo root. For ROOT — whose worktree root is the repo root
  — that covers *every* other agent's checkout, which is the single most dangerous place to stand
  unknowingly: another branch, where a write or a commit lands in someone else's in-flight work and
  looks entirely normal going in.
- **A hand-rolled walk up to the nearest `.git`** is wrong in its naive form, because **a linked
  worktree's `.git` is a FILE** (`gitdir: <repo>/.git/worktrees/<name>`), not a directory. An
  `isDirectory()` test resolves every agent worktree to the main repo — the one answer that makes
  another agent's checkout look like home. Asking git cannot drift from git, and `GIT_DIR`,
  submodules and everything else come free. The test fixture is a real `git worktree add`, with a
  test pinning that its `.git` really is a file, so the fixture cannot decay into one that every
  implementation passes.

The lookup **rides in the EXIT trap that was already writing `pwd`** (a second line beside it), not
in a daemon-side spawn — the shell is being paid for regardless. ⚠️ **The `2>/dev/null` on that trap
is load-bearing, not tidiness**: outside a repository `git rev-parse` fails LOUDLY on stderr, that
case is NORMAL rather than an error, and merged mode folds the subshell's stderr into the command's
own output — so without it every command run from `/tmp` reports a git error it did not cause.
Removing it reddens exactly one test. (The command's OWN git errors still surface, which is the
distinction to preserve if you touch this.)

The notice describes the directory the shell **ENDED** in, not the one it started in:
`cd ~/.mxd && cat config.json` produces output about `~/.mxd`, and naming the worktree there would be
the very defect the line exists to remove. It is carried on the shape `formatBashResult` takes, so
foreground, `background_complete` and the `background` tool's status action get it by construction
rather than by three callers remembering.

**The other end of the same guarantee: `cd` to the directory you are already in is a free no-op**,
so an agent unsure where it is can always just say so. There was a shell `cd()` override that
errored with *"already in this directory"*, and **every line of its body existed to produce that
error** — it resolved the target only to compare it against `pwd`, and wrote no file anywhere. CWD
tracking was, and is, entirely the EXIT trap. ⚠️ **Do not reintroduce a wrapper**: with the error
gone the remainder is `cd() { builtin cd "$1"; }`, strictly worse than the builtin it shadows — it
breaks `cd -`, and an empty argument stops meaning `$HOME`.

The trade was priced wrong originally: it optimised the common case (a redundant `cd` costs a few
tokens) against the rare one (a command running somewhere unintended, with every result still
looking authoritative). The guidance is now the opposite — **prefix a `cd` whenever you are not sure
where you are.**

⚠️ **Removing an error branch must not remove real errors.** A `cd` that silently does nothing on a
typo'd path is the wrong-directory command this whole area exists to prevent, wearing a friendlier
face. Pinned by four tests that pass identically before and after the change — a missing directory
and a path that is a file both still fail with bash's own message naming the path, the rest of the
command still runs in the original directory, and a bare `cd` still reaches `$HOME`.

## Two filesystem-walk defects, in both tools that walk: a library default serving somebody else

`search` and `list_files` each had the SAME two defects, and finding the pair a second time in the
second tool is what turned two bug reports into a class.

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
in place at every walker: **decide every behaviour you depend on explicitly, even when you agree
with what you would have got for free.** Stating a choice you were already getting by default is not
noise; it is the semantic becoming visible and therefore reviewable. The hand-rolled walk that
replaced these `scanSync` calls follows the same rule from the other side — it now *chooses* its
symlink handling, its skip set and its sort rather than inheriting any of them, and each of those
choices has a test.

The second-order damage is why this is worth a section rather than a commit message: for as long as
such a bug lives, **the tool's own description is teaching agents the wrong rule.** `list_files`'s
examples were `"src/**/*.ts"`, `"**/*.test.ts"`, `"*.json"` — the first two anchored, the third
silently meaning something else. The defect was never that `*.json` returned the wrong three files;
it was that a reader **generalises from the neighbours**. Both tools now state the rule rather than
implying it.

### Four things that will look like oversights

1. ⚠️ **The 500-file cap counts files we KEEP, never files we walked past.** Not an optimisation — a
   correctness requirement, and now structurally guaranteed by pruning at descent (below) rather
   than achieved by a filter inside the loop. Measured from the main checkout with `dot: true` and
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

### The fourth change to this family, and the one that is NOT a correctness bug

The two defects above produced silently wrong answers from a library default. This one produced the
**right answer at the wrong cost**, and its cause is architectural rather than a missing argument:
both tools consulted the skip list about FILES after the walk instead of about DIRECTORIES during
it, so every excluded directory was enumerated in full and then discarded. `dot: true` made an
existing waste roughly 4× worse by adding `.worktrees/` (~21k files per live worktree) and `.git/`.

`walkFiles(root, skipDirs, glob?)` is now the ONE walker for both tools, and `isInSkippedDir` is
asked about a directory once, in its trailing-slash form, **before the directory is opened**.
Measured 2026-07-25 from main with 2 live worktrees: **68,664 files enumerated to return 320 → 320
to return 320**, 153ms → 0.4ms — which also beats the pre-`dot: true` code (18,239 files / 36ms),
because pruning removes a waste that PREDATES the hidden-directory fix rather than paying for it.
The durable claim is that **the walk now costs what the ANSWER costs**; the numbers are a dated
reading of one tree.

⚠️ **`list_files` had to move onto the same walk, and "doing just one is the smaller change" is the
wrong instinct.** Two tools sharing three predicates but disagreeing on WHEN to consult them give
those predicates two meanings depending on the caller, and the next person to change one has to hold
both models. That is precisely the drift the shared predicates were introduced to prevent, so
leaving one tool behind is a decision to create it.

#### What a hand-rolled walk must reproduce, and where the tidy version fails silently

⭐ **Symlinks: use `dirent.isFile()` / `isDirectory()`, NEVER `statSync`.** `readdirSync`'s dirents
are lstat-based, so a symlink answers false to BOTH predicates and is dropped by both branches —
which is exactly what `scanSync({onlyFiles: true})` did, verified against a symlink to a file, to a
directory, a broken one, and a directory linked to its own ancestor.

> **The tidiest-looking way to write this walk — `statSync` instead of lstat-based dirents — is
> wrong, and wrong in a way that makes `dir/link -> dir` walk forever. Before this change NOTHING in
> the suite would have gone red. 6 tests catch it now and all 6 are new.**

It is wrong twice over, and the second half is the one someone would defend as a feature: it also
starts **returning symlinked files `search` has never returned**, so one file is reported two or
three times under different paths. **Not following links is also the entire termination argument** —
there is no visited-inode set and it needs none.

⚠️ **Errors must THROW, not be swallowed.** `scanSync` throws on a missing root (ENOENT) and on an
unreadable directory mid-walk (EACCES). The first version wrapped `readdirSync` in try/catch and
continued — with a comment asserting that matched `scanSync`, written without measuring it.
Swallowing turns "your path is wrong" and "the directory holding the definition is unreadable" into
`(no matches)`, which is exactly the failure mode this family has already shipped twice.

⚠️ **Sort is load-bearing and must live in exactly ONE place.** `readdirSync` returns filesystem
order (on APFS, a hash order). Order is part of the contract because both caps SLICE the sorted
list, so in traversal order "the first N" is an arbitrary set that can differ between two runs over
an unchanged tree. **Forward slashes are built by string concatenation, not `join()`** — the
relative path is both what the caller sees and what the glob is matched against, and `join()` writes
`\` on Windows.

⚠️ **`list_files`'s cap bounds the RESULT and can no longer bound the walk, because sorted output
and early termination are mutually exclusive.** You cannot know the alphabetically-first 500 files
without having seen all of them. Accepted because the walk it no longer bounds is now the cheap one,
and because the old early break never fired anyway: no pattern in this repo reaches 501 kept files —
**which is exactly the condition that would have made a regression here invisible.** No parameter
was added for a large-repo case we have not hit; if one arrives, the choice is sorted-and-complete
versus early-and-arbitrary and it cannot be both.

**The only case that regresses**: for an anchored glob (`src/*.ts`) `Bun.Glob` prunes the path
prefix itself and this walk does not, so it is slower — 0.3ms → 0.4ms. Deliberately not chased.

## ⚠️ In a self-bootstrapping project, fixing a tool's SOURCE does not fix the tool in your hand

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

⭐ **Generalised, because this is the standing pattern rather than a run of bad luck: a checker
reporting ZERO is a claim about the checker until you have made it report ONE.** Four instruments
answered confidently and wrongly in one week — a `search` that could not see a third of the source,
two gates that read 8% and 3.6% and printed `All checks passed.`, and (2026-07-25) biome 2.4.10's
`nursery/noFloatingPromises`, which reports zero over this repo **and zero over a planted
`async function boom(){throw new Error("x")} ; boom();` in the file it is checking**. Without that
probe the survey would have been written up as "the type-aware linter finds none" — a false
all-clear carrying a tool's authority, which is strictly worse than no check. **Planting is not
diligence; it is the only thing that distinguishes "clean" from "not looking".**

⚠️ **Sibling trap from the same survey, and the cheaper half to forget: a single-line grep is a
claim about LINE BREAKS.** The shape being hunted was `.catch(async`, and `grep '\.catch(async'`
returns **zero** hits in a repo that has one, because biome's formatter had split the call across
two lines. A recommended instrument thus reported the whole class as already clean. Reach for a
multiline search whenever the pattern spans a call boundary the formatter is free to break.

⚠️ **Consequence for this file**: any "grepped it, nothing points there" conclusion recorded here
before 2026-07-25 was reached with an instrument that could not see `.mxd/plugin/`, and the failure
was silent in the direction that matters — a confident non-empty answer with the deciding file
missing from it.

⚠️ **Same family, and here the blind instrument is your own tool list: it is a frozen snapshot, not
an inventory of what you can do.** The list you can see was frozen into `session_config` at session
start; the daemon's handler registry holds more, and Anthropic dispatches any tool name to whatever
handler exists. Root asserted "there is no WebSearch tool in this project" from reading its own
56-entry list; `mcp__brave-search__brave_web_search` works, called by name. **"It is not in my list"
is not evidence that it does not exist.** (Gotcha when you do call one: an unlisted tool has
unconstrained argument types, so a numeric `count` arrives as a string and fails validation — pass
the required argument alone.)

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

`buildSessionRepair` computes a jump and its caller performs it — `setChainHead` + `appendBatch`,
literally the rollback mechanism, with a null jump target meaning append-only. Poisoned
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
to the entries fails exactly TWO tests.

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

⚠️ **Multiline queue content must stay ONE text block**, which today is `adapter.buildUserTurn`'s
job. Two earlier per-shape builders split queue messages on `\n` into separate blocks while JSONL
reconstruction merged them back into one — a guaranteed prefix mismatch on every resume, and the
reason turn-building was collapsed onto a single path at all.

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
a signature, so in the UI the user's reply vanishes into the thinking fold. **Matrix is faithful
here**: the SDK accumulator and the walker reproduce whatever blocks the server sent.

⚠️ **Operational mitigation: an agent whose last action is a user-facing reply should END ITS TURN
rather than call `yield()`.** Replying and then calling yield in the same turn makes the reply
*connector* text and it is summarized away. Matrix treats `end_turn` as an implicit yield with
identical pause semantics, so nothing is lost. Explicit `yield()` is fine when no user-facing prose
precedes it.

⭐ **The proof.** A 12-digit canary was written only in visible reply text and kept out of every tool
input; the client-side JSONL stored a paraphrase that mentioned "这串随机数" and **dropped the
digits**, so the canary existed nowhere client-side. The next turn's agent recalled it verbatim, with
the recall recorded in a tool input timestamped before any read. The signature's encrypted payload is
decrypted server-side on echo-back and the original is reconstituted into the model's context.

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

⚠️ **The first diagnosis was SDK-version sniffing: plausible, matching the observed block shape, and
wrong.** It produced an action (an SDK bump, kept, harmless) and a false verification — one clean
post-restart sample, then recurrence within the hour. **A single passing sample is not verification
when the phenomenon is intermittent by design**, and the scope rules above guarantee a clean sample
is always available regardless of the fix. This is *Plausible and wrong* again, in its member-2
shape: the wrong mechanism is what made one sample look like enough.

**Two gaps deliberately left open** (waiting for real data rather than building for imagined cases):
`buildResponseEvents` has no branch for a server-side `fallback` block, so a fallback hop would not
be persisted and the post-restart walker would omit it, breaking the thinking hash chain; and
`getStopReason` maps every non-`end_turn` reason to `"tool_use"` — see *An anomalous stop idles the
agent silently* for what that costs.

## The Anthropic message-shape rules, MEASURED

**`src/test-utils/api-message-rules.ts` is the authoritative list — read it there, not here.** It
carries each rule with the real 400 string it mirrors, plus `PROBED_SHAPES` (every shape we have
actually sent, with the day we sent it) and `UNPROBED` (what we assert but have never asked the API).
This section keeps only what that file cannot tell you.

⚠️ **Do not re-enumerate the rules here.** This section used to, opening "these four are the API's
actual rules" — and it was **five** within two days, with the fifth sitting in the very next
paragraph, added later and reading as an elaboration rather than as the refutation it was. Nobody
noticed, because a list and its correction do not look like a contradiction when they are adjacent
and politely worded.

⚠️ **"NOT rules" in that file means MEASURED LEGAL, not never-objected-to, and that distinction is
the whole bug.** From outside, a rule we never discovered and a shape we measured as legal read
identically. `[{type:"text", text:""}]` sat under "NOT rules" as legal for two days and is in fact a
400 in every position on either role. It is reachable: `walker-golden.test.ts` pins the walker
rebuilding an empty `assistant_text` as exactly that block, repair does not cover it, and while both
emit sites guard on truthiness (`if (partialText)`, `if (responseText)`), ⚠️ **whitespace-only passes
truthiness** — so a model whose first streamed token is a newline, interrupted right there, bricks
the session on every later request.

⭐ **A `thinking` block is positionally identical to a text block, so it needs no clause of its
own.** (Rule numbers below are that file's.) Measured against production with real signed thinking
blocks: `[u, a[thinking], u]`, `[u, a[text, thinking], u]` and `[u, a[text], a[thinking], u]` are
all accepted. Trailing, `a[thinking]` is rejected — but so is `a[text]`, and **the SAME assistant
message is accepted when it is not last**, which is what makes it rule 2 rather than a rule about
thinking. Only the error string differs: a trailing thinking block says *"The final block in an
assistant message cannot be `thinking`"*, trailing text says *"does not support assistant message
prefill"*. ⚠️ **Do not read that wording as a separate constraint.** It fires only where rule 2
already fires, and reading it as its own rule is how someone builds a repair step to strip thinking
tails that were never the problem — which was proposed here and cancelled by this measurement.

⭐ **Consequence nothing else states: `buildUserTurn` packs `[...tool_results, ...queueMessages]` with
tool_results FIRST, and that order is a real API requirement rather than style.** Put text before a
tool_result, or between two batches of them, and you get a production 400 with a fully green suite.
Results split across several user messages are fine, in any order; `[R1, text]` then `[R2, …]` is a
400 because the trailing text ended the run; `[text, R1]` is a 400 because block order inside the
message matters.

**Rule 2's only production violator was a second compaction path for short sessions**, which sent a
request ending on the assistant turn the agent had parked on. Writing the rules down is what turned
it from an invisible gap into a red test; the path is deleted (see *Compaction: ONE path, and the
two bricks a second one produced*) and `src/compact-short-session.test.ts` holds the shape.

⚠️ **Probing the real API: the `systemPreamble` trap.** Any probe against the OAuth endpoint must
send the auth group's `systemPreamble` as the FIRST system block, or every call 429s. A first-pass
probe that omitted it produced a wall of rate limits that reads exactly like validation failure and
nearly yielded the opposite conclusion.

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
agent loop. It is strictly single-turn: no tools, no session state, no image input — and it is
mostly wiring, reusing the adapter's own call, response-event, usage and cost functions. The plugin
resolves `AuthGroup` and model from `MatrixConfig` itself, keeping the facility decoupled from
config shape. Errors are exceptions (no error chunk), transient ones are retried by the SDK, and
hitting `max_tokens` returns the text with `stopReason: "max_tokens"` rather than throwing.

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
would pollute history.

The namespace exists so a second plugin's data parks beside matrix's rather than colliding at the
top level, and it completes the "matrix is just a plugin" framing. Config merges in three layers,
later overriding earlier: global `~/.mxd/config.json` < repo `<repo>/.mxd/config.json` < local
`~/.mxd/projects/<id>/config.json`.

**`src/data-paths.ts` is the ONE place that resolves a path from `dataRoot`.** Never apply a string
operation to a `dataRoot` anywhere else — **any** spelling, not just `.slice(2)`; a grep test walks
the whole repo and fails if a second site appears, with one named allowlist entry
(`effectiveDataRoot`, which normalizes trailing slashes and returns a dataRoot rather than a path).
Both halves of that audit were broken until 2026-07-25 and each was proven by planting rather than by
reading: it walked only `src/`, so the very file that DEFINES `dataRoot` sat outside it, and it
matched one literal spelling, so `.substring(2)` and `.replace("@/", "")` passed silently. See
*Gates: a passing gate looks identical whether it read 8% or 100%*. Three lines of defence, and each
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
`tracker.addGeneralNode`, which throws on `"task"`.

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

⭐ **The same principle one layer out: a rule enforced at one of two doors is enforced nowhere**,
because the other accepts the same payload — and the second door is reliably the one nobody
remembers. A message reaches the runtime through **`POST /projects/:id/tasks/:nodeId/message`**
(`src/runtime/routes/tasks.ts`) and **`POST /projects/:id/tasks/:nodeId/edit`**
(`.mxd/plugin/runtime.ts`); both take `images`, and `/clarify` does NOT and is not one of them.
Both answer a text-less message with the same sentence, and `src/image-requires-text.test.ts`
asserts both against ONE constant, so changing either wording alone reddens. Test both doors in one
file against one app, and "I closed the door" can no longer quietly mean "I closed a door".

## Images

`getImageDimensions(buffer)` parses PNG/JPEG headers, and `read_file` rejects anything over 8000px
per dimension before it ever reaches a provider. Byte size is a provider-level concern
(`validateImage?` on `ProviderAdapter`): Anthropic 5MB decoded, OpenAI 20MB.

---
# Memory Index & Search
---

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

### Staleness is a per-document content hash, and `updatedAt` was why boots got slower over time

⚠️ **Do not key staleness on `node.updatedAt`.** `task-tracker.ts` writes it in **16 places and only
3 touch a field the index stores** (`updateTitle`, `updateDescription`, `appendResultRound`). A
status transition, a cost update, assigning a worktree, or merely CREATING A CHILD — which bumps the
**parent** — all marked a task stale. Two consequences explain the failure's shape: **the backlog
grew with ACTIVITY rather than with content change, and it was only paid at boot**, so the longer
the daemon stayed up the more expensive starting it became. Measured 2026-07-25: a full backfill
took 4m13s against a 30s worker-init budget, and the daemon was unbootable for hours.

Staleness is now `sha256(v1 | model | dtype | text)` **per document** (per field, per round), stored
in the sidecar as `{h, e}`. ⚠️ **Per-document is not a detail**: a whole-task hash re-embeds every
result round because one word of the title changed, and the root task has dozens of rounds. Model
identity is inside the hash, so a model or dtype change invalidates everything — which costs nothing
on the day it happens (the rebuild runs in the background) and prevents **mixing two vector spaces
in one index, a state that does not fail but returns plausible wrong answers.**

⚠️ **The second staleness clause is one-directional on purpose.** A document is stale if the hash
differs, OR if it is stored without a real embedding (`e: false`) **and embeddings are now
available**. Without that second clause the failure is permanent and silent: one offline first boot,
or one run with `MXD_DISABLE_EMBEDDINGS`, writes zero vectors, the content hash calls them current
forever, and the index serves keyword-only results with nothing anywhere reporting it. The reverse —
embedded document, embeddings now disabled — is deliberately NOT stale, so turning embeddings off
can never destroy vectors that already exist. Mutation-verified in both directions: making the
clause symmetric fails exactly the "turning embeddings OFF does not destroy vectors" test.

⚠️ **Migration treats "no hash" as UNKNOWN, not as stale.** An old sidecar has `indexedAt` and a flat
id list; calling that stale would make **deploying this fix trigger the exact backfill it exists to
prevent**, on every machine, on the next boot. The plan instead ADOPTS the current content's hash for
documents the legacy entry already lists, without re-embedding — strictly no worse than what it
replaces, because assuming those documents are current is precisely the claim `indexedAt` was
already making. Documents the legacy entry does not list are genuinely absent and still get built.

⭐ **The DB is persisted BEFORE the sidecar that claims it. Never the reverse.** Sidecar-first turns
any failed `.msp` write into a silent permanent hole, because the sidecar says "indexed" and nothing
ever revisits it. In the correct order every failure lands on "the sidecar is behind", which the next
plan repairs — and **that is the whole reason an index write is safe to treat as loud-but-non-fatal.**
Renaming a task must not fail because search could not be written, and that trade is only honest
because the failure is recoverable.

⚠️ **And the invariant then bites you on the repair path.** Because the sidecar can legitimately
under-report the DB, the repair pass plans an `insert` for a document that is already there — and
Orama's `insert` THROWS on a duplicate id. So the very failure the ordering exists to make
recoverable would throw on the pass that recovers it. Fixed by removing before *every* insert, not
only where the plan saw a prior document. Found by a test seeded with a legacy sidecar listing fewer
ids than the index held; otherwise it surfaces only after a real crash in the write window.

⚠️ **`onScopeResume` awaits the PLAN and nothing else, and the rule is categorical:
anything that touches the `.msp` or the model is deferred — NOT "anything expensive."** `planIndex()`
is pure (read the small sidecar, walk the tasks, hash each document, diff) and measured **12ms for
1115 documents**. `applyIndexPlan()` loads the 21MB `.msp`, lazily loads the model at the first
document that actually needs one, embeds and persists, on a module-level **serialized** background
chain so seven projects cannot backfill concurrently. A cheapness judgement is something a future
change gets wrong silently; a categorical rule can only be violated deliberately. This matters
because `autoResumeProjects` awaits `onScopeResume` and the worker's `ready` waits on autoResume, so
anything slow there spends the 30s init budget — and terminating the worker at that timeout is what
took the daemon down.

⭐ **Negative result, with its dependency, so it can be re-checked rather than inherited: do NOT
batch embeddings across projects.** The expensive part, the model load, is *already* shared —
`getEmbeddingPipeline()` is a module-level singleton and all projects live in one worker. Simulated
on the real 7-project tree: 64 batches today, 57 if the small projects merged, **saving ~1-3s out of
a 909s rebuild** while coupling the projects and breaking the clean per-project plan/apply split.
**An optimisation for a case your fix eliminates is dead code that looks like foresight** — ask when
the case occurs *after* the change, not before. This inverts completely if `getEmbeddingPipeline()`
ever stops being a per-process singleton.

**Batching is length-sorted, and the sort is most of the win.** A batch costs count × its longest
member, so a 4000-char result round interleaved with 31 titles makes all 32 cost 4000. Measured on
the real tree: tree order pads 1.49M chars to **4.74M char-equivalents (3.2× waste)**; length-sorted
pads to 1.58M (1.1×).

⚠️ **SYMPTOM, known and unfixed: the index is case-sensitive.** `"Uppercase Widget Title"` is found
by `Uppercase` and `Widget` and **not** by `uppercase` or `widget` — the mandarin tokenizer does not
lowercase. Pre-existing; fixing it re-tokenizes every stored document.

### ⚠️ Choosing an embedding device: `auto` is the obvious answer and it silently corrupts the index

On darwin, transformers.js resolves `device: "auto"` to `["coreml","webgpu","cpu"]`, so CoreML claims
the graph — and **CoreML returns a 768-dim vector of NaN, L2 norm 0, for most inputs. Nothing
raises.** `searchIndex`'s NaN-score guard then quietly redoes every query as pure BM25, so the
product keeps working with semantic search deleted and no error anywhere. `auto` is also 7.4× slower
than CPU.

⭐ **The failure is deterministic per input and NOT monotonic in length**, and this table is the
load-bearing part:

| input | chars | result |
|---|---|---|
| `"reconcile "` | 10 | **all NaN** |
| `"Fix session recovery bug"` | 24 | correct |
| a repeated sentence | 336 | **all NaN** |

A first pass drew only the 24- and 336-char cases and read it as a length threshold; **it was a
coincidence of two strings, and a one-string probe would have shipped.** So `tryDevice` probes four
inputs of different shapes through BOTH `embed` and `embedMany`, requiring every result finite,
right-dimension and non-degenerate — batched separately, because **a batch is padded to its longest
member, so a document that is finite alone is not necessarily finite in company.**

⚠️ **Do not log `session.config.device`.** It reports the device that was REQUESTED, so it prints
"coreml" just as confidently while emitting NaN. Log what was *proven*.

⭐ **Non-monotonic forecloses the workarounds, which is why "we don't know why" is a complete result
rather than an unfinished investigation.** A length threshold would invite chunking, capping, or
probing at the boundary — any of which could be made to look like it works. With no cheap input
property that predicts the verdict, rejecting the device is the only sound response.

**Negative results on the CoreML knobs, so nobody spends the afternoon again**: `mlComputeUnits:
CPUOnly` / `CPUAndGPU`, `modelFormat: MLProgram + mlComputeUnits: ALL`, and
`allowLowPrecisionAccumulationOnGPU: "0"` — **every one still NaN.** MLProgram is the documented fix
for the FP16 cast and is either not reachable through transformers.js or not sufficient; ORT ignores
unknown option keys silently, so those two cannot be distinguished from here.

⚠️ **"webgpu vs coreml" is not "GPU vs not-GPU."** Both reach the same Metal GPU — webgpu via Dawn,
CoreML via its own compiler; CoreML's extra reach is the ANE. **There is no MPS execution provider in
ONNX Runtime** (that is a PyTorch concept), verified from the installed library rather than recalled:
`listSupportedBackends()` returns cpu / webgpu / coreml, and the dylib exports zero metal symbols.

> ⭐ **webgpu is chosen for CPU CONTENTION, not for wall-clock — and on the real corpus it is 30%
> SLOWER in wall-clock.** Full rebuild of 1115 documents / 1.49M chars: **cpu 697s wall / 3044s CPU;
> webgpu 909s wall / 38.8s CPU.** 3044s of CPU is 4.4 cores saturated for twelve minutes next to
> live agents, because the backfill runs alongside them. 38.8s is invisible. Anyone "optimising" this
> back to wall-clock will pick cpu and starve the machine.

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
  workers via the Worker constructor's `env` option (see *Two transport bugs that corrupt
  silently*, Daemon region — a `bunfig.toml [test.env]` entry does NOT reach a Worker). Priority is
  explicit mock > env var > lazy load, so a test can still exercise hybrid paths with a mock while
  the var is set.
- ⚠️ **`sharp`/`libvips`**: Bun's global cache puts libvips at a versioned path sharp cannot find.
  `scripts/fix-sharp-libvips.sh` symlinks it and is wired as `postinstall`.
- ⚠️ **Orama's `where` only filters `enum` fields** and has no `ne` on them; `string`-typed fields
  silently return empty. That is why all metadata lives in the sidecar and no query uses `where`.

**`search_tasks` enriches from the tracker, not from the index**: each hit gets the task's CURRENT
title via a fresh `getTask`, and hits whose task has been deleted are dropped.

**NEGATIVE RESULT, do not re-derive — except on a Bun upgrade, which is the only thing that can
change it:** `bun:sqlite` **cannot** `loadExtension`. Smoke-tested;
`new Database(":memory:").loadExtension("x")` throws *"This build of sqlite3 does not support
dynamic extension loading"*, and that one line is the whole re-check. That killed the sqlite-vec
plan and is why the vector phase went to a pure-TS engine. The FTS5 index that preceded Orama
worked correctly (MATCH, bm25, snippet, DELETE-by-column all verified); it was replaced for the
vector story, not because it was broken.

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

## Every hit says what it IS before its body is read

The section above made the three blocks say what to DO with a hit. This one makes each hit say what
it is — status, both dates, and for a terminal task whether it ever actually ran. Same three
surfaces, and they now share the vocabulary in `src/search-hit-format.ts` instead of spelling it out
three times, because a rule enforced at two of three renderers is enforced nowhere: the third goes on
handing out the old shape to a reader who cannot tell which renderer produced it.
`scripts/render-hit-samples.ts` renders all three against the real tree and the real index, which is
the only way to answer the question that actually decides this design — scanning the output, can you
separate a proposal from a finished task in the half-second it gets?

**Status LEADS the line now.** It was always rendered, at the END of the first line, where a long
title pushes it to the right margin and the next thing the eye meets is a 300-char `Description:`
that reads like a conclusion. Measured cost of that placement: a `draft` whose description held a
real measurement AND a never-executed proposal, separated from a finished task by four characters at
the far right of the line.

⚠️ **`updatedAt` renders as `record touched`, never as "last active", and the LABEL is the whole
fix** — the field was always renderable. `task-tracker.ts` writes it in 16 places and 3 of them touch
content; a status flip, a cost update, or merely creating a CHILD (which bumps the parent) all
refresh it. Labelled as activity it shows an April task as worked-on today, which is worse than
having no date: an authoritative-looking wrong number. `createdAt` is always beside it because it
cannot drift. Both carry a relative age (`2026-04-01 (4mo ago)`), and that half is load-bearing
rather than decorative — agents are date-blind and confident about it, so an absolute date alone
re-runs the failure the date was added to fix.

⭐ **"Did it ever execute" is the UNION of three signals, not a choice among them — and it is the one
thing here someone will try to simplify.** Each is one-directional POSITIVE evidence: a session file,
a recorded cost and a reported round can only exist if the task ran. So OR-ing them cannot produce a
false "ran", while every single member produces false "never ran"s. Measured on this repo's tree,
2026-07-27:

| signal | really answers | its blind spot |
|---|---|---|
| `resultRounds` | did it REPORT? | postdates most of the tree — **365 of the 417 closed tasks that had run carried no round** |
| `costUsd > 0` | did it SPEND? | one closed task had a session and no cost: launched, died before any usage landed |
| session JSONL | did it ever HAVE a session? | one closed task had a cost and no file — a session can be cleared by hand or by `reset_task` |

`resultRounds` is the member that looks right, being literally "it finished and reported", and alone
it would have relabelled **88% of this repo's executed history as an unexecuted proposal** — the
worst answer available, because it is precisely backwards about what the description means. A live
instance sits in the samples: one closed task that burned **$9.52 has zero rounds**, one metre from a
closed task that genuinely never ran. ⚠️ `branch` / `worktreePath` cannot be used at all — close
nulls them.

**The marker is rendered on `closed` and `failed` only.** Terminal-status rather than a case list:
while a status is live the question is still open, so the marker would be transient noise. It is also
the only place both answers are common — 417 ran / 23 not for closed, against draft 2/104 and pending
1/8, where a marker carries no information.

⚠️ **Dedup runs BEFORE the full/brief tier split, not after.** A real `search_tasks(limit 6)`: three
tasks filled all six slots, one of them appearing once as a full entry and once as a brief one with
its entire `Description:` paragraph repeated verbatim. Dedup afterwards leaves the slot arithmetic
running on the duplicates. Merge the duplicates' field labels into the survivor
(`Matched: description, title`) instead of dropping them — matching on two fields is relevance
evidence, and it is the only thing the discarded hits carried. The tier is counted over RENDERED
entries for the same reason: a hit whose task has left the tree used to consume a full slot and
silently demote the next real one to brief.

⭐ **Dedup is unconditional, and the objection against that is worth keeping because it is a good
one.** `search_tasks` advertises "the best-matching LOCATIONS … WHICH field matched, the round
index", so two hits inside one task ARE two answers there and collapsing them reads as a regression
against the tool's own promise — which is why a per-caller `distinctTasks` flag was proposed first.
It is not a regression, because **the locations survive**: merging keeps every label, round indices
included (`Matched: result round 0, result round 3`), so every place inside the task that matched is
still named. What dedup drops is a second copy of the same 500-char `Description:` and a second
score, neither of which was ever a location. The promise is kept once it is read as *locations*
rather than as *excerpts* — which is also what the header says these blocks are, so the two callers
turned out to want the same thing and the flag was not needed.

⚠️ **CORRECTION to the section above**: it describes `search_tasks`' output as "2 full hits + up to 5
one-line briefs". Two things have drifted — the 2/5 split is `create_task`'s (`search_tasks` is
`min(5, limit)` full), and the unit is now TASKS rather than hits.

⭐ **Instrument note, reusable far beyond this: a uniform answer across a whole population is the
signature of a broken instrument, not a finding.** The first probe of the three signals reported
"session JSONL exists" as **false for all 551 tasks** — `tree.json`'s `nodes` is an ARRAY, and
reading it with `Object.entries` hands back indices as ids, so every `existsSync` missed a file that
was there. Believed, it would have "proved" the JSONL signal useless and handed the decision to
`resultRounds`, i.e. to the 88% error above. The probe now asserts its own premise — nodes is an
array, a sampled id matches the ULID shape — before it reports anything. Smaller sibling from the
same afternoon: a budget line counted entries by a leading `- ` and reported 7 for 5, because
description bodies contain markdown bullets. Leading every entry with `[status]` is also what makes
an entry distinguishable from the prose inside one.

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
it beats tolerating it. Release is sequenced in `shutdown()` after the workers are gone, **which
means in practice it has almost never run** — see the next section. The steal-on-dead-PID path is not
a fallback; it is the only path, and it has been load-bearing since embeddings landed.

⚠️ **Test mocks must honor the abort signal.** A mock doing `setTimeout(resolve, 10000)` makes
`stopAgent`'s loop-settlement await wait the full window. Real provider SDKs already respect abort;
`abortableSleep(ms, req.signal)` brings mocks in line.

## ⚠️ An ORT session dies with the thread it lives on — so it gets its own process

**FIXED 2026-07-25.** The session now lives in a child process (`src/embedder-child.ts`), spawned by
`src/embedder-client.ts`. Worker threads never load ORT. Keep it that way; the rest of this section
is why, and what it cost to find out.

Measured one variable at a time, harness in `scripts/napi-repro/` (reproduces in ~2s):

| where the session lives | thread ends by | result |
|---|---|---|
| worker thread, NO session (import only) | parent `terminate()` | **exit 0** |
| worker thread | parent `terminate()`, device `cpu` | **exit 133** |
| worker thread | parent `terminate()`, device `webgpu` | **exit 133** |
| worker thread | worker's own `process.exit(0)` | **exit 133** |
| worker thread, `dispose()` first | parent `terminate()` | **exit 133** |
| **MAIN thread** | **`process.exit(0)`** | **exit 0** |

`panic: NAPI FATAL ERROR: Error::New napi_create_error`. **The trigger is not `terminate()`, not the
device, and not skipping `dispose()` — it is an ORT InferenceSession existing in a thread that is
ENDING.** The last row is the whole fix: a process's main thread only ends when the process ends, and
that path is clean. So give the session a process whose main thread owns it.

**Upgrading does not help — measured, do not re-litigate.** bun 1.3.14 and transformers 4.2.0 are
already the latest; `onnxruntime-node` 1.24.3 → **1.27.0 still exit 133**. The precedent that made
this worth trying (a *different* bun worker-teardown crash that 1.3.7/1.3.8 → 1.3.14 did fix) does
not extend to this one.

**What it cost before the fix.** Grepping `daemon.err`: 13 of the last 20 process deaths carried this
exact panic, at uptimes up to 18.4h — **as far as that log went back, this daemon had never once
exited cleanly.** Three consequences, and the third is the expensive one:

1. `releaseDataDirLock()` is sequenced AFTER worker teardown in `shutdown()`, so it had never run.
   `.mxd.lock`'s steal-on-dead-PID path was not a fallback, it was the only path.
2. Exit 133 is indistinguishable from a real crash to launchd and to a human — which is why 13 of
   them went unremarked.
3. It converted a slow startup into an unbootable machine: init exceeded the 30s budget → daemon
   terminated the worker → the worker held a session → a recoverable "one plugin failed to load"
   became a hard failure, 23 times over. **This is what the "segfault" in the index bug report
   actually was**, not a memory blowup; the 2.26GB RSS was a symptom sitting next to the cause.

**Why a child process and not the alternatives.** Main-thread inference is crash-safe by the table
above but blocks the HTTP shell that the worker architecture exists to protect. The WASM backend
avoids NAPI entirely, but transformers' node build has no `wasm` device (only `coreml, webgpu, cpu`)
and its web build assumes browser semantics — it fetches models by URL and cannot read the local
cache. "Never terminate a worker holding a session" trades a native abort for a leaked thread and
disables worker restart, the daemon's own crash-recovery mechanism, exactly when a plugin is
misbehaving.

**The cost is small and partly negative.** Spawn + model load + verify: 939ms, once, then warm. A
search-query embed: 63ms median vs ~59ms in-process — ~4ms of IPC. Batched indexing: 12.8ms/doc
wall. And the parent process now burns **0.02s of user CPU** for work that used to run on the worker
thread next to the agent loop — the boundary moved inference off the thread that serves agents.
Vectors cross as structured clone (`serialization: "advanced"`), so no JSON cost for Float32Array.

**Lifecycle is inherited, not managed.** When the thread that spawned it goes away, Bun closes the
IPC channel and `disconnect` fires in the child, which exits. One mechanism covers worker terminate,
worker restart and daemon shutdown, with no bookkeeping in the parent and no leaked 500MB process per
restart. Deleting that handler is the quiet way to reintroduce a leak.

⚠️ **The regression that would silently undo this is one line: a static `import ... from
"@huggingface/transformers"` in any module a worker loads.** Everything keeps working until the next
shutdown, which is exactly how this sat unexamined for two days. `src/embedder-client.test.ts` greps
`task-index.ts`, `embedder-client.ts` and `orchestrator-tools.ts` for that shape and fails on it —
mutation-verified by reintroducing the import. `embedding.ts` may name the package, but only inside a
function body, where `import()` loads nothing until the child calls it.

**`MXD_DISABLE_EMBEDDINGS` is no longer a crash guard, and its comments now say so.** It was the
test-side half of this hazard; it is now just "run BM25-only", which `bun test` uses to skip a 500MB
model load and a per-suite child spawn it has no assertions about. Unsetting it is safe, only slower.
A mock pipeline still takes priority over it, so vector-path tests are unaffected.

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
discovered by the same scan as any other. The per-project configuration lives in `ctx.scopeOpts`,
and `buildMatrixScopeOpts` in `.mxd/plugin/scope-opts.ts` is the ONE place that knows matrix's
tools, prompt and hooks.

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

⚠️ **Chosen over `@mxd/plugin-sdk` on purpose**: the `@mxd/*` names are BROWSER virtual modules
(tsconfig paths + importmap), a different mechanism, and a server package reusing that prefix would
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
`registerSideEffects`, which runs inside `createAgentContext` **at agent launch**. `listNodes` works
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
   `/<projectId>/<scope>/<taskPath>`, browsers do not send `Authorization` on navigation, so a
   refresh must reach the shell — which is auth-content-free, and every API call it then makes goes
   through this same middleware. Unregistered first segments 404 cleanly.
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
(POST `/auth/logout`) rotates it and invalidates every outstanding token. `extractBearerToken`
matches `/^Bearer[ \t]+(.+)$/i` because RFC 7235 makes the scheme case-insensitive.

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

⚠️ **Testing this layer under happy-dom has its own trap — do NOT spy on `history.pushState` /
`replaceState`** (limit 5 under *What happy-dom does not do*); unit-test the pure parse/build
functions instead and leave routing integration to a real browser.

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
points, not the 9 anyone could name** — including the browser itself, via `overflow-anchor: auto`,
which silently absorbs top-of-list insertions and is not implemented by Safari. Three clusters:
measuring or writing during a transitional state (unpredictable symptoms, because the transient's
duration is a network variable); addressing a viewport position by a **perishable identity** (a
pixel offset, a module-counter entry id, a React component instance — deterministic losses, each
disguised as some other feature behaving normally); and conditional renders in a flex row (cheap,
cosmetic). Their common amplifier is that `logs` is the whole session's array, replaced wholesale
on every refetch.

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
> not anticipated, and it lands in the predicate for free. It also collapsed two catalogued classes
> into one — content-height changes inside the container and clientHeight changes outside it were
> two classes only because they were sorted by *what changed*; sorted by *what it causes* they are
> one thing.

**Growth is deliberately NOT suspicious**: streaming grows every frame, and a user scrolling back to
the bottom mid-stream must still be able to re-arm follow.

**Observation and intent are two concepts, and there is exactly ONE channel carrying each.** Scroll
position is an observation; `autoScroll` is an intent, written by one observation and six intents,
and the Follow button needs the intent concept. That single observation-writing-intent is the door
every hijack came through, and today it is the only place the two meet:
`if (!shrank) onAutoScrollChange(atBottom)` inside `handleScroll`. ⚠️ **Do not add a second
reporting channel to re-establish the separation — the separation is already there, and a second
channel is what the first one was.** There used to be a `logAtBottom` boolean feeding an icon-only
`↓` button whose `onClick` was Follow's own handler; Follow arrived two and a half weeks later and
subsumed it. Two halves, fixed separately: the guard rejects a **false observation** (a clamp after
a shrink), and the new-content effect no longer takes `autoScroll` as a dependency, which stops a
**true observation from immediately executing** — the user scrolls into the 40px band, follow
correctly arms, and the effect used to fire and yank them the rest of the way mid-gesture. **Arming
is not acting**, and "go to the bottom now" already has its own channel (a monotonic
`scrollToBottomRequest` counter). That fix was a deletion, and the effect reads `autoScrollRef` so
"responds to content, not to intent" is explicit rather than implied by a deps array.

⚠️ **`prevScrollRangeRef` may ONLY be advanced by `handleScroll`, and the danger is that the wrong
version looks MORE thorough.** Letting a geometry-reading effect update it too makes the guard inert:
effects run at commit, the clamp's scroll event is dispatched by the browser *afterwards* (measured
14ms later), so the effect writes the new small value first and the comparison becomes new-vs-new.
The next person will read the single call site as a missed one.

⚠️ **"Only trust real user scrolls" is unimplementable.** A clamp-dispatched scroll event has
`isTrusted === true` and is indistinguishable from a user's at the event layer.

⚠️ **In a right-aligned flex row, inserting a child moves only the siblings BEFORE it.** So
conditionally-rendered controls belong *before* the persistent ones — cheaper than reserving blank
space and with no side effects. This is what made the header jump 71.3px when the Follow pill
appeared.

### Two deletions here, and neither was about the feature

`tabScrollStateRef` (per-tab scroll memory) **never functioned**: the save ran in a passive effect
keyed on the task id, which runs *after* commit — by which time the list had emptied, the container
had collapsed and `scrollTop` was clamped to 0. It saved a destroyed value, structurally. It was
invisible because the follow-hijack it fed put you at the bottom anyway, which looked like normal
follow behavior.

⭐ **Deleting an implementation that never had an effect is not deciding the feature should not
exist — it is removing a lie.** The real feature needs an address that survives a refetch, which is
the same requirement as message deep-linking and active-chain membership: all three want persisted
event identity on every entry regardless of transport.

The `↓` button above is the second, and it is the harder kind to see: **a duplicate ENTRY POINT is
not a duplicate mechanism, and unifying the mechanism does not clean it up.** The jump had already
been collapsed to one `scrollBottomRequest` counter — which is precisely why two buttons could sit
there unnoticed, both thin, both calling the same handler, both working. What made the pair visible
was putting them side by side and asking what the older one still does that the newer one does not:
nothing.

⭐ **The cost of the narrow affordance was not the affordance.** Deleting one `useState` cascaded to
a whole reporting channel — `ActivityLog`'s `onAtBottomChange` prop, its ref mirror,
`reportAtBottom`, and the `else` branch of BOTH the `visible.length` effect and the
MutationObserver, each of which existed only to keep that button's visibility fresh. **When you
delete a consumer, follow the data backwards to the producer before believing you are done**; the
compiler stops at the prop.

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
near the top when it ran. It **observed and reproduced** a position that was lost before it
existed rather than computing a wrong one — which is what turns a one-frame flicker into a stuck
state, and why there is nothing to fix in the anchor. **Fix the keys.**

⚠️ **CORRECTION: "a wholesale replacement does not move the offset" is FALSE**, and an earlier round
measured it four times and concluded otherwise. The measurements were honest; the fixture held ~60-80
plain-text entries, which are cheap enough to tear down and rebuild that the collapse never survives
to a layout. A real session has images with no reserved height, expandable cards and markdown tables.
**The cost of a remount depends on how expensive the content is to rebuild, so a fixture made of
cheap content cannot answer the question at all.**

### The instrument's blind spot, and what it says about specifying measurements

The per-frame probe classified that exact jump as `range UNCHANGED → scroll anchoring or user — NOT
a clamp`. Wrong: the range collapsed and refilled **inside one frame**. Worse, `scrollHeight` never
dipped in any sample — read literally that refutes "the container collapsed", and it does not, because
**between the two DOM mutations there are 267ms containing ZERO samples where ~16 were due at 60fps.**
The main thread was blocked solid rebuilding 82 entries, so every rAF callback and observer microtask
queued behind it. **"No dip in the samples" is not "no dip."**

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

⚠️ **Test-harness gotcha with real teeth**: `clearSessionState` drops log entries for a session
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

⚠️ Two biome traps in the parser: a `noArrayIndexKey` suppression on multiline JSX must sit directly
above the `key={i}` attribute line, not above the element; and `useIterableCallbackReturn` requires
every switch path to return, which is why the last case and `default:` are merged.

## Four interactions, each with one line that silently breaks it

These features are unrelated except in the way that matters here: each depends on a single
easy-to-delete line — an event-phase choice or a `preventDefault` — whose removal breaks the feature
without breaking a test or producing an error.

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

⚠️ **The query was lifted to a controlled prop because happy-dom cannot type into a React controlled
input** (limit 3 under *What happy-dom does not do*): filtering became testable by passing a prop
instead of typing.

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

## Two stops became one, and the leftover was invisible for the usual reason

The composer's Stop ends the TURN (`interruptTask`). The Orchestrator panel held a
second button, and `/stop` was a third door, both calling `stop()` — which tears the session
down. All of them said "stop". `/stop` now runs the composer button's path on the composer's
task, the panel button is deleted, and `POST /projects/:id/stop` survives with **no
conversational entry point at all** (`reset_task`, `delete_task` and shutdown need it, and
`mxd stop` still reaches it).

⭐ **Second instance of one shape, in the same component family: when a replacement lands, go
back and look at what it replaced.** `↓` was auto-follow's manual complement and Follow
subsumed it two and a half weeks later; stop predates interrupt the same way (*Interrupt and
stop are two abort channels* records that they were once one button). Neither leftover ever
went red — the older affordance keeps working, which is exactly why nobody looks at it. The
sharpening over the `↓` case: there both buttons shared one handler, so it was a duplicate
ENTRY POINT. Here they called different backends with opposite blast radii — **the runtime had
deliberately separated the two verbs and the UI went on offering both, so the confusion the
architecture exists to prevent was handed straight to the user.**

⚠️ **Do not "keep the escape hatch" by demoting the second control to a slash command.** That
is still two stops with the second one harder to find; the problem was never how visible they
were.

⚠️ **Deleting a UI control leaves four orphans the compiler cannot see**, and this one had all
four: its **i18n key** in every locale file (string-indexed — and `orch.pause` had a dead
mirror in the shell's `web/i18n.ts` with no consumer, beside a `detail.stop` = "Interrupt"
left from an even earlier stop button); its **icon** (`IconPause`, reachable only by name);
its **URL builder** (`api.stop`); and the **prose describing it** (`SLASH_COMMANDS` still read
"Stop the running agent"). Typecheck found only the prop chain and the newly-unused deps.
⚠️ It also caught the one grep that was wrong, and the edge it fell off is structural rather
than careless: `api.stop`'s only remaining consumer was in `src/plugin-url-namespace.test.ts`,
while the search had been scoped to `.mxd/plugin/web/` and `web/`.

> ⭐ **Frontend code lives in TWO directories and is consumed from THREE.** `web/` is the
> shell, `.mxd/plugin/web/` is the plugin UI — and `src/` imports plugin web modules too.
> **A grep scoped "to the frontend" therefore misses a real edge**, and it misses it silently,
> in the direction that says "nothing points here".

Measured 2026-07-28 as evidence rather than as a current-state count: `grep -rl
".mxd/plugin/web" src/ web/` gives 35 files in `web/` and 5 in `src/` — of which 3 are real
imports (`plugin-app-derived-state`, `plugin-event-handler`, `plugin-url-namespace`, all
tests), one writes fixture paths, and one only names the path in a comment. The production
invariant that `src/` has no production import from `.mxd/plugin/` is intact; it is the TEST
edge that breaks directory-scoped searching. Same narrowing that made the data-paths audit
walk only `src/` — **scope the grep to the repo, and let the compiler be the second opinion,
not the first.**

**Pin which function runs and on which task.** "/stop does not error" is green before and
after; the fixture can only express the difference while `targetNodeId` and `rootNodeId` are
distinct in it, so the test asserts that about itself first.

## The composer's image hint is the placeholder, and its condition is deliberately un-trimmed

An attachment with no message used to add a full-width line under the thumbnails — a second
layout jump per paste, and a dangling imperative that reads as an error however quietly it is
styled. The reasoning that put it there was right about tooltips (Enter-to-send has no hover,
and a keyboard user never produces one) and then jumped from "not a tooltip" to "a permanent
div of its own", past the slot that is already permanent and already where the caret is going.

⚠️ **The condition is `!prompt`, NOT `!prompt.trim()` — and the trimmed version is the one that
looks correct**, since every other gate in that component trims. A placeholder is hidden by ANY
content, whitespace included, so trimming sets a hint the browser never paints: a flag claiming
an affordance nobody can see. Whitespace-plus-attachment is carried by the disabled Send button
alone, and the test asserts the ABSENCE of the hint there so that choice is pinned rather than
assumed.

⭐ **Borrowing a slot that already has a job means you owe it back.** The test pins that one
keystroke restores `Message to "…"`; an unconditional hint would sit on top of the target
prompt for the rest of the session.

## Small component facts worth knowing

- ⚠️ **A message must carry TEXT; images ride along with it and are never a message on their own.**
  Refused at four gates — `canSend` (the Send button), `handleSubmit` (Enter, which never touches the
  button), `handlers.handleSend`, and both REST doors, `/message` and `/edit`, which answer with one
  identical sentence asserted against a single constant so neither wording can drift alone. Note
  `/clarify` is NOT one of the doors; it takes no images. The earlier permissive behaviour and the
  fallbacks that served it (`content ?? ""` into `createUserMessage`, `"[image]"` into the parent
  notification) are gone with their premise.
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

**Minimum bar**: cross the real process boundary; run the journey by hand before `done("passed")`,
and if you cannot describe the concrete steps and what you observed, you have not verified it; test
every observable consequence, not the first one. **"2003 tests pass" is not a merge gate. "I ran the
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
returned the same files.

⚠️ **And the mirror image, which is the one you will defend rather than fix: a fixture can be too
REAL to see the difference.** Deleting a `b.type !== "text"` filter reddened NOTHING, because both
scoping tests used genuine shapes — an empty `tool_result`, a real thinking block — and **no real
Anthropic block type carries a `text` field at all**, so that filter and the `typeof b.text ===
"string"` narrowing below it covered for each other perfectly. Only a synthetic block, a non-`text`
type that nevertheless has a `text` field, can see that line. Realism is normally the thing you want
from a fixture, and here it is exactly what blinded it — so "our fixtures are faithful" is not an
answer to "would this mutation be caught".

⚠️ **The same defect in a PERFORMANCE fixture does not merely lose precision — it can reverse the
sign.** A synthetic 64-document benchmark said webgpu was 18% *faster*; the real 1115-document corpus
says it is 30% *slower*, because real documents have a long tail (p50 206 chars, p90 3988, max
19284), attention is O(n²), and `feature-extraction` does not truncate. The synthetic set had no
tail, so it measured a different workload and answered confidently. Same shape as the remount-cost
error under *The activity log's scroll position*: **a fixture whose content is too cheap cannot
answer the question at all, and the danger is that it answers anyway.** (The device decision
survived only because a second number — CPU time, 3044s vs 38.8s — was measured on the real corpus
too.) And ⚠️ **a test that can fail for two different reasons cannot tell you which one happened** —
a guard's entire value is being legible on the day it fires, so narrow it to presence-only rather
than asserting an exact list.

⚠️ **Two implementations of the same guarantee cover for each other, and the tell is a mutation
surviving that obviously should not have.** `walkFiles` sorted its output and then `jsSearch` sorted
the same array again; deleting the sort *inside the walk* failed **no test at all**. Deleting the
redundant one is what made the survivor testable. Same shape as the markdown parser's whitespace
rules, where a symmetric fixture pinned neither half individually — **a defence-in-depth pair can
hide the fact that neither half is actually pinned.**

⚠️ **Check that the harness RAN before believing its verdict — "survived" is the comfortable answer
for every mutation.** A mutation harness wrapped its run in `timeout 180 bun test`; **macOS ships no
coreutils `timeout`**, so the command failed, the run never happened, `grep -c '^(fail)'` on empty
output returned 0, and **the harness reported the mutation as SURVIVED** — which reads as a real and
even reassuring result about your tests rather than as a broken instrument. The only available
signal was wall-clock: 234ms against an expected ~12s. The fixed harness refuses to print a verdict
unless the file text actually changed AND bun printed a summary line. **An instrument that fails by
producing the comfortable answer is worse than one that errors**, and this is the same family as the
blind `search` and the blocked-main-thread sampler: a false negative wearing evidence's clothes.

⚠️ **A harness that RAN can still be aimed at the wrong files, and that also reports SURVIVED.**
Same shape, second instance (2026-07-25): a mutation to `.mxd/plugin/web/event-handler.ts` was
checked with `bun test web/ .mxd/plugin/web/` while the tests covering it live in
`src/plugin-event-handler.test.ts`. Bun ran, printed a real summary, reported zero failures — a
verdict about a set of tests that never touched the mutated code. **"Did it run" and "did it run
the tests that cover this" are two questions**, and only the second one makes SURVIVED mean
anything. Cheap check: a mutation reported as SURVIVED should name which tests it ran, so an
implausible target is visible at the moment the verdict is printed.

⚠️ **`git checkout -- <file>` reverts to the last COMMIT, so it eats an uncommitted fix in the same
file — including the fix you are mutating.** Recorded again under a different symptom because the
existing note reads as being about tidiness: mid-review a rename plus a behaviour fix were made,
then a mutation was run to prove the new test fires, then reverted — and the revert silently took
the whole uncommitted change with it. The tell was the "after revert" run showing the same failure
count as the mutated run. **Commit before mutating** is not a style preference; the alternative
loses work in a way that looks like the mutation still being applied.

⭐ **When you replace an implementation but not its contract, a differential probe beats a green
suite.** ~40 lines running the OLD path and the NEW one over 21 real cases — the actual repo, both
checkouts, subdirectory roots, every glob shape, a synthetic symlink fixture, `excluded_dirs: []` at
68,641 files — asserting **byte-identical output including order**. It found nothing, which is the
point: it states "behaviour is unchanged" as a measurement over whole outputs, where a green suite
can only state "the cases someone thought to write still pass".

## An assertion about an ERROR MESSAGE survives the behaviour being inverted

⭐ **What earns this a section is not the rule. It is that the behaviour had shipped TWICE,
deliberately, and was pinned by NOTHING.** `6be3a829` made the composer accept image-only;
`10da7d33` made both REST doors accept it. The only test either commit touched was a single line:

```diff
-  expect(body.error).toBe("content is required");
+  expect(body.error).toBe("content or images required");
```

That reads as coverage. It is an assertion about a STRING, and it holds no matter which way the
behaviour goes: the wording could survive untouched while image-only flipped from accepted to
refused and back. Two rounds of authors, one green suite, zero tests of the thing.

> **An assertion about the text of a rejection is not an assertion about what is rejected.** Same
> family as *a test whose fixture cannot express the difference passes both ways*, and it hides
> better, because the diff LOOKS like the test was updated along with the behaviour.

**Detector, and it is cheap: for any behavioural claim, ask what the test would do if the behaviour
were inverted.** If the answer is "still pass, possibly after changing one string", the behaviour is
uncovered. Here the inversion needed 10 new tests across 4 gates and 0 flipped ones, because there
was nothing to flip — a fact worth knowing before you go looking for the outdated tests a task
description promises you.

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

### What happy-dom does not do — five limits, each probed

Kept together because a test author hits them as one question ("why did nothing happen?"), and each
one produces a **passing** test rather than an error.

1. ⚠️ **It silently drops MutationObserver callbacks under GC pressure** (v20).
   `MutationObserverListener` stores its callback in a `new WeakRef(...)` with no strong reference
   anywhere, and dispatch does `callback.deref()` — so after any GC pass, mutations are delivered to
   nothing, with **no error**. A test relying on MO delivery passes in isolation (no GC between
   observe and mutate) and flakes inside the full suite. Real browsers hold strong refs per spec, so
   production is fine. **Never let a happy-dom test depend on MutationObserver delivery.** Route the
   behavior through a React effect and treat the MO path as a real-browser-only complement — and
   stub a no-op MutationObserver so the mutation proof targets the effect branch exactly.
2. ⚠️ **No layout, so geometry cannot be observed there.** It can still test the *causes* of
   geometry — DOM order, commit granularity, whether a callback ran — which is far better than
   dropping the test or mocking geometry brittlely. Anything genuinely about pixels needs a real
   browser.
3. ⚠️ **You cannot type into a React controlled input.** Both the native `input` event and the
   `Object.getOwnPropertyDescriptor(...).value` setter trick fail to fire `onChange` (probed).
   `.blur()` and keydown do work.
4. ⚠️ **A key handler on a text input needs a FOCUS first, or it never runs** (measured 2026-07-27).
   `textarea.dispatchEvent(new KeyboardEvent("keydown", …))` on a React-controlled textarea does not
   reach `onKeyDown`: React's ChangeEventPlugin takes its polyfill branch under happy-dom and, on
   any key event over a text input, calls `getInstIfValueChanged` with the fiber it recorded at
   `focusin` — `null` when nothing was ever focused — and throws on that **before any listener
   runs**. Call `.focus()` first and both `onKeyDown` and a dispatched `submit` work normally.
5. ⚠️ **Do NOT spy on `window.history.pushState`/`replaceState`.** Instrumenting them in
   `beforeEach` survives `GlobalRegistrator.unregister()` in ways nobody could diagnose and poisoned
   every subsequent `web/*.test.tsx` file with ~18 spurious failures. To assert on history calls,
   intercept at a layer the test owns (a harness wrapping the component and exposing captured
   calls), or leave routing integration to a real browser and unit-test the pure parse/build
   functions. Related: `history.replaceState` does **not** update `window.location.hash` here,
   although real browsers do.

Taking 3 and 4 together, the way to drive a composer in a test is: **seed the draft through the
component's own `localStorage` key (or a `quoteRequest` prop) for the text, `.focus()` + keydown for
the submit.**

⚠️ **A constant-vector mock makes every hybrid-search assertion vacuous.** If the fake embedder
returns the same vector for every text, every document scores cosine 1.0 against every query, the
whole index comes back, and any assertion about *which* documents matched passes silently. Three
tests were written that way and were measuring nothing. Return a text-derived vector so different
texts are orthogonal. ⚠️ And **hybrid search embeds the QUERY through the same pipeline**, so an
embed counter read *after* a search has counted the query too — snapshot before searching.

⚠️ **A negative assertion is only worth the WAIT in front of it — and deleting a redundant channel
can silently remove that wait.** The shape, which generalises to every "delete the duplicate" task:
two guard tests did `await waitFor(() => atBottomCalls.length > 0)` and then asserted
`expect(autoScrollCalls).toEqual([])`. `atBottomCalls` came from a *redundant* reporting channel —
so deleting the duplicate deletes the await, and the negative assertion now runs before anything
COULD have been reported. It passes on a component that reports nothing at all. **Nothing goes red;
the guard just stops being covered, in the same commit that "only removed a duplicate".** The fix is
a positive control inside the same test: after asserting the thing was NOT triggered, make it
trigger for real and require that. Same family as `waitFor(() => x === null || true)` below — both
are assertions sampled before the moment they are about.

⚠️ **The same rule with the environment, not a duplicate channel, supplying the dead wiring:
a negative assertion driven through SYNTHETIC EVENTS needs a positive control in the same test.**
The first version of "Enter with an image and no text does not send" **passed on code that had no
guard at all**, because limit 4 above meant Enter never reached the handler. Nothing in the test
looked wrong — the fixture was fine and the environment was the thing that could not express the
difference. Give the same composer text, press the same key, require a send.

Three smaller traps that each cost real time:

- `await waitFor(() => x === null || true)` polls NOTHING (always true) and asserts before React
  commits. Poll the real condition.
- ⚠️ **`expect(domNode).toBeNull()` prints the node with its whole React fiber graph on failure**,
  and the second cost is worse than the first. One such assertion produced a **227MB** log and a
  60s test; another (182MB, 43s) **mangled bun's `(fail)` line, so a harness scraping that line
  reported the mutation as SURVIVED** — the instrument was fine and its INPUT was destroyed by an
  assertion elsewhere. Compare booleans in DOM tests, not for tidiness but for legibility on the one
  day it fires.
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

The hook runs typecheck, `check:ci`, `check-i18n.sh`, and `bun test --bail` on a smoke subset whose
size it computes and prints on every run — never a literal, so the ratio cannot go stale and this
file does not need to carry it. It also **fails before typecheck if it names a test file that no longer
exists**, and stages `scripts/i18n-baseline.txt` when the i18n gate lowers it. See *Gates: a passing
gate looks identical whether it read 8% or 100%*.

**The smoke set is chosen, not accumulated**, which matters because the old one grew by whoever
happened to write a test that day. Two criteria: (1) the round-trip proofs for checks the hook itself
runs — `check-i18n.test.ts`, `data-paths.test.ts`, `pre-commit-hook.test.ts` — because a hook that
runs a gate but not the gate's own test can print that gate's "passed" while the gate is dead; and
(2) invariants that fail SILENTLY, which in this repo means the persistence layer (`event-store`,
`events`), since the inherited four — daemon shell, project registry, task tree, worktrees — all fail
loudly. Deliberately excluded: `walker-golden` (one step out from the on-disk chain, covered by the
drift suite at merge time) and `message-editability` (breakage greys a button, which is visible).

## Gates: a passing gate looks identical whether it read 8% or 100%

Every gate in this repo has now been caught claiming more than it read, and they failed along **three
independent axes**. That is the part to carry: fixing one axis leaves the others silently intact, and
the output looks identical either way.

| gate | axis | the claim | what it checked |
|---|---|---|---|
| `scripts/check-i18n.sh` | SCOPE | bare strings in JSX | 4 of 31 files — **927 of 11,534 lines (8%)** |
| `scripts/check-i18n.sh` | DEPTH | bare strings | 1 syntactic form of 4 — **1 of 6** in `ErrorBoundary.tsx` |
| `src/data-paths.test.ts` | PATTERN | only `data-paths.ts` builds paths from `dataRoot` | the 16 literal characters `dataRoot.slice(2)` |
| `.hooks/pre-commit` | SCOPE | `All checks passed.` | **4 of 141** test files, while NAMING five |

All four are fixed. The i18n gate never touched the shell's own `SettingsPanel.tsx` or
`AppHeader.tsx`, and never *any* of the 25-file plugin UI, which is where essentially every
user-facing string in this product lives. The data-paths audit was proven dead by experiment rather
than by reading: a `dataRoot.slice(2)` planted in `.mxd/plugin/scope-opts.ts` left it at 54 pass /
0 fail.

⚠️ **The sharpest instance, and it upgrades the class statement: an addition list does not merely
fail to cover NEW code — it silently stops covering the code it explicitly NAMED.** The hook listed
five test files and ran four. `src/direct-provider.test.ts` was deleted 2026-03-12, **four days after
being added to that list**, and the hook went on naming it for 4.5 months while printing
`All checks passed.` What made it silent is the runner: **`bun test` skips a path that does not exist
and still exits 0.** So even the list's own stated scope was fiction, and nothing green anywhere
carried that information.

⭐ **Second detector for this family, worth as much as the finding: an addition list must FAIL when a
listed item is ABSENT.** A checker that shrugs at a missing entry cannot tell *"we chose not to check
this"* from *"this evaporated"*. Pin it with a test rather than only implementing it — a
named-but-missing entry is precisely the condition nobody thinks to re-verify.

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

⭐ **And the count must be COMPUTED, never written down.** A literal `5 of 140` is indistinguishable
from a true one on the day it stops being true — the drained rot, sitting inside the very sentence
whose job is to describe scope. The hook derives both numbers (`wc -w` over its own list,
`git ls-files` for the suite), so a re-narrowing prints `3 of 141` in front of whoever commits next,
and a suite growing around a frozen list shows its own ratio worsening. **Every axis gets the same
treatment**: the i18n gate prints its FORM count beside its file count, so a narrowing of depth is
exactly as visible as a narrowing of scope. That symmetry was the only thing really missing on
either axis.

⭐ **A partial-hit gate plus a fix-only-what-it-flagged policy produces incoherent output.** This
outlives any particular widening — a heuristic is partial by construction, and the four-form version
still misses things. When it was single-line it flagged 1 of a component's 6 user-visible strings. Fixing
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

**The heuristic knows four forms now** — `>text<` on one line; text on its own line with the tag
closed on the one before; a user-visible prop (`title`/`alt`/`placeholder`/`aria-label`) carrying a
literal; a ternary or fallback whose branches are text. 1 hit → **26, every one real**. Fixing DEPTH
honestly would mean a TSX parser (enumerate JSXText and JSXAttribute, subtract what routes through
`t()`); a regex cannot become one, so these forms ARE an addition list and the remedy is the printed
form count rather than a pretence of completeness.

⭐ **One rule bought the precision, and it is the reusable part: a user-visible string starts with a
capital OR contains a space.** Unfiltered, the ternary form ran at **32%** — reporting
`rotate(90deg)`, `currentColor`, `mxd-btn-stop`, `sk-ant-...` and dotted i18n keys like
`rollback.rewindTitle`. Filtered, ~100%. ⚠️ **The recall it costs is stated where the rule lives and
pinned by a test: a single lowercase word with no space is NOT reported**, so `alt="attached"` is a
real bare string this gate cannot see, and **baseline 0 will not mean zero bare strings**. A
deliberate recall gap nobody wrote down is one commit from becoming the next depth defect — which is
exactly what this gate was just fixed for. The reason to take the trade at all: **a gate with a bad
hit rate teaches people to skim past it**, and then it is worth less than nothing.

⚠️ **`aria-label=` had been sitting in the gate's SVG skip list**, between `viewBox` and
`strokeWidth` — an accessibility string a screen reader speaks, skipped as if it were path geometry.
Pulling it out changes 0 existing hits, which is what makes the fix provably not a behaviour change
anywhere else.

⭐ **When a widened gate surfaces a real backlog, RATCHET — and make the baseline write itself down.**
The widening found 26 pre-existing bare strings, so two things were true at once: the gate is correct
and the repo cannot pass it. Failing every commit until a translation project finishes is not a
strict gate, it is one that gets `--no-verify`'d, which leaves no trace — the way 24 type errors once
accumulated. **A gate nobody can pass stops being evidence about anything.** So
`scripts/i18n-baseline.txt` carries the measured debt, the gate fails on any RISE, and **rewrites the
file downward on any FALL**. The rewrite is the load-bearing half, not convenience: a baseline only a
human remembers to lower is a number that quietly stops being true, so fixing ten strings against a
stale 26 lets ten new ones land unnoticed — the drained rot, reintroduced by the fix for it. The hook
stages the file, so the lowered number rides in the commit that earned it. ⚠️ Known hole, accepted
and recorded next to the baseline: it is ONE count, so removing one string and adding another in the
same commit nets to zero. A per-file table closes it and is a bigger surface than the thing it
protects.

⚠️ **Do not let the string cleanup swallow the gate fix.** Widening flags a lot, and the pull to fix
them "while I'm here" is strong; it converts a nearly-finished bounded task into an unbounded
translation project, which is how the thing that was going to protect us gets abandoned halfway.
Count them, file them (`01KYDBRDAPF13M5X0E7PGQVB0X`), ship the gate.

### The census, 2026-07-25 — negative results, so nobody re-runs this

⚠️ **The date is the point of this heading, not decoration.** Everything below is a state claim with
nothing that would ring if it stopped being true, and the heading tells you not to re-check — which
is the one combination that lets a finding age into a lie undetected. Read every bullet as "true of
the tree on 2026-07-25"; re-run the census if you are about to rely on one and the tree has moved.

Every file-enumeration site in the repo was searched, deliberately with bash `grep -rn` rather than
`search` — see *In a self-bootstrapping project, fixing a tool's SOURCE does not fix the tool in
your hand*, in the tools region. Conclusions:

- **Every `Bun.Glob` in the repo was correct** — three call sites, two in `search`, one in
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
- ⚠️ **The hook itself was the third addition list** — 3.6% of the suite behind an unqualified
  `All checks passed.` **Subtraction is genuinely infeasible here** (a full `bun test` is
  ~255-300s per commit), which is the performance exception the rule leaves open, so the remedy was
  the other half of the i18n fix: say what you ran. Now fixed, along with the two axis-siblings
  below. **The census found no fourth; that census is done.**

⭐ **"Scope" is only one dimension an addition list can hide in — PATTERN is another, and it hides
better**, because a widened scope makes a narrow pattern look thoroughly exercised. The data-paths
audit's scope was fixed while its regex still matched sixteen literal characters, so
`dataRoot.substring(2)`, `.replace("@/", "")`, `.split("@/")[1]`, `dataRoot[2]` and a
formatter-wrapped `dataRoot\n\t.slice(2)` all passed in silence. Widened to *any* operation on a
dataRoot-named value, it immediately found a real second site the narrow pattern could never have
seen: `effectiveDataRoot` in `plugin.ts`, which is legitimate — dataRoot in, dataRoot out, never a
path — and is now a NAMED allowlist entry carrying its reason, which is what makes the check a
subtraction. Round trip: **the old regex caught 1 of 8 planted spellings; the new audit catches 8 of
8 and names the file.** Two limits stated rather than left to be discovered: a direct rebind
(`const r = cfg.dataRoot`) gets its own check, and a value laundered through a function return is out
of reach of any grep. ⚠️ Requiring the call parens (`dataRoot.slice(`) is load-bearing — five doc
comments in this repo end a sentence on the word and start the next with a capital, which a bare
`dataRoot\.\w+` reads as a method call.

⚠️ **NEGATIVE RESULT — branded types were believed to be the one direction that escapes the
enumeration frame entirely, and they do not.** Probed with `tsc` rather than reasoned about: on
`type DataRoot = string & {__brand}`, **`dr.slice(2)` and `dr.substring(2)` both compile clean** — a
branded string keeps every string method, so branding does not prevent the operation it was proposed
to prevent. Meanwhile `const m: Manifest = { dataRoot: "@/plugin/foo" }` fails TS2322, so it *does*
break plugin authors writing a plain JSON-shaped manifest. Refuted at both ends. Forbidding `.slice`
needs a genuinely opaque non-string type with an unwrap at every serialize/log/compare site, and
manifests are JSON. **Do not re-derive.**

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
for locals or imports, only for function params); and `check:ci` exits 0 with a standing pile of
warnings, because warnings never fail the gate — **do not "fix" the warning count during a gate
restoration**, since biome's suggested `!` → `?.` autofix is marked unsafe and silently changes
assertion semantics.

⚠️ **Why 24 errors accumulated is the more important half, and it is not "someone bypassed the
gate": there was no gate to bypass.** This is the incident that *a checked-in hook file is not an
enforced hook* is about — nothing snuck past anything, the errors accumulated in the open, and the
absence looked exactly like compliance.

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
- ⚠️ **`delete_task` REFUSES any node with children** — `deleteTaskOp` throws on both the task and
  the general-node branch, so you reparent or delete the children yourself first. `tracker.remove`
  underneath it IS recursive and would take their session JSONL with it; that guard is the only
  thing standing between a misclick and unrecoverable loss. Prose in this file, in the tool
  description and in the system prompt all said the cascade was reachable, for months; it is not,
  and describing a guard as a hazard makes agents avoid the tool where it is the right move.
- ⚠️ **Abort-signal leak**: after a stop, the old `runAgentForNode` settles asynchronously. The catch
  and finally re-read the node and compare its session against the one they began with, so a dying
  agent cannot emit stale error events over the replacement that already owns the node. ⚠️ Do not
  reach for a name here: the readable one (`wasReplaced`) exists only in comments, and the real
  local is its **negation** (`notReplaced`).

## Known bugs and open design

**Open design questions**, re-checked rather than carried forward:

- **Subtree message routing.** The parent chain shipped — `send_message` walks upward through
  `getTaskAbove`, so any ancestor is reachable — but you can still only reach DIRECT sub tasks, not
  arbitrary descendants. That half is what remains open.
- **Tool search** — dynamic tool discovery instead of sending every tool. Anthropic has a server-side
  `defer_loading`; the user prefers a client-side design.

## ⚠️ "Never offer a remedy that will not work" is not a UI rule — it costs MORE in a tool error

The rule is already written down for greyed buttons under *Blocked buttons are greyed and explained,
never hidden*. It reappeared twice in `closeTaskOp`, and the second medium is the expensive one:
**a human reads a bad remedy and gives up; an agent DOES IT, collects the second refusal, and then
invents a workaround.** What it invents is worse than the failure, because it is invisible.

**Instance 1 — the dead end (fixed).** `update_task {status:"closed"}` refuses with *"Use close_task
instead"*, and `close_task` refused anything that was not `verify`/`failed`. **The first error named
a road the second did not accept**, so a draft had no path to a terminal state at all. Observed
damage: a superseded draft was marked done by writing `[已解决 by <id>]` into its **TITLE** — state
encoded in a string, invisible to every status filter, so it sits in the active pool forever. That
is the shape to watch for: *the workaround is legible to humans and to nothing else.* (⚠️ Correction
to the entry that says "**`hideCompleted`** hides closed and failed only": the CLAIM is right and
the NAME is a phantom — the sidebar filter is `FilterMode = "all" | "hide-closed" |
"active-favorites"` in `.mxd/plugin/web/components/TaskTree.tsx`, and grepping `hideCompleted` lands
on an i18n key. Closing a draft therefore does remove it from the pile, which is the whole point of
this change.)

The fix is a SUBTRACTION with one member — only `in_progress` is refused. **Close means two things
at once** (reclaim the resources, take it out of the active pool); a draft/pending owns no worktree,
no branch and no session, so for it only the second applies and the first is a **no-op, not a
contradiction**. The old whitelist read that no-op as grounds to refuse.

**Instance 2 — the false remedy inside the guard that STAYS (fixed).** The old message was *"Cannot
close a running task. **Stop it first** or wait for done()."* ⚠️ **`stopTask` never touches
`status`, deliberately — a stopped task stays `in_progress` precisely so it can resume** (its own
docstring says so; all 7 runtime `updateStatus` sites were checked and none is a stop). So stopping
lands the caller back on this same refusal, and an agent cannot even take that road: **there is no
stop tool.**

⭐ **The fix for a false remedy is a SHORTER message, not a more complete one — and two drafts went
the wrong way before this landed.** The instinct when correcting a wrong instruction is to explain:
name the false path and why it fails, name the alternative, price it. Both intermediate drafts did
exactly that, and both were wrong for one reason — **they generated COMPLETENESS where the reader
needs an INSTRUCTION.** An error answers a single question, *what do I do now*; the answer here is
"wait", so the message is `Cannot close a running task — wait for it to finish.` Each rejected
clause fails a concrete test worth keeping:

- *"Note that STOPPING it does not help"* — a warning about an action the reader **cannot perform**.
  Worse, the fact that agents have no stop tool was written down in the report that argued for the
  sentence: it was known, and not applied. **Check what the reader can DO before writing them a
  warning.**
- *"reset_task it first, which discards its session and worktree"* — `reset_task` genuinely unblocks
  the close (→ pending → closable, true only because of this change), and it is a destructive option
  nobody asked for. Handing someone a knife because they asked to tidy up is not helpfulness, and
  attaching the price tag does not make it one.
- *"done() sets verify or failed, both closable"* — internal state vocabulary, contributing nothing
  to *what do I do now*.

Pinned by a test asserting the message names waiting and contains neither `stop` nor `reset_task`,
so the false remedy cannot return in either form — recommending it, or warning against it.

**Negative result, verified rather than assumed** (the guard "looks like it already covers this" was
the reason to check): `closeTaskOp`'s `if (node.worktreePath && node.branch)` really is a clean
no-op for a resourceless task, and **close never calls `clearEventStore` at all — the callback sits
in its signature unused, and that absence IS "task record + session preserved"**. Both are pinned by
tests carrying a POSITIVE CONTROL in the same test (a *pending* task that does own a worktree still
gets it removed; `deleteTaskOp` with the same capture does clear), because "the callback was not
called" is equally consistent with "nothing in this build calls it".

⚠️ **Pre-existing race this widens without changing in kind**: `beforeChildLaunch` (a `git worktree
add`, seconds) runs BEFORE `onLaunch` flips the status, so a task being launched is still readable
as its old status. `close_task` has always been able to land in that window on a `verify`/`failed`
task woken by `send_message`; it can now also land on a `pending` one. `deleteTaskOp` and
`resetTaskOp` close this with `awaitLoopExit`; `closeTaskOp` never had it and still does not.
