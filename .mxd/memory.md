# Matrix Project Memory

> Read on every session start. **This file holds what the code cannot hold about itself.** Your
> system prompt names the kinds that qualify; do not re-list them here, because two copies of one
> list is how a category goes missing without anything going red — this blockquote already lost
> "negative results" once, on the day it was written.
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

**The exit code and the pass count are two different claims, and only the exit code covers what
happens BETWEEN tests.** `2893 pass / 0 fail, exit 1` is not a contradiction to wave through — it is
bun reporting an unhandled rejection that no individual test was positioned to fail on. Read the
exit code first; when it disagrees with the summary, the summary is the one describing less. See *An
unhandled rejection is an outage here, not a log line* for why that stack matters far beyond the
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
one differs non-trivially, because a child reports what it *thinks* it did. Read `git diff
main...<branch>` line by line before merging. The observed failure always has one shape: child done
→ `git log --stat` → merge → post-merge bugs that a manual smoke caught immediately. Watch for
single-line catastrophes (`autoRegisterSelf: false` shipped exactly this way).

⚠️ **The merge commit message is the ONLY durable link from a line of code back to the task that
wrote it, and writing a good one destroys it.** Branches are `mxd/<taskId>/…`, so git's default
*"Merge branch 'mxd/01K…'"* carries the id; passing `-m "<a sentence about what landed>"` replaces
it, and `close_task` then deletes the branch, so nothing anywhere names the task again. **Measured
2026-07-29: 102 of 1280 merge commits (8%) carry a taskId, and the ten most recent were all
orphans** — the habit gets *worse* the more carefully you write. Put the id in the message as well
as the prose. Until the backlog is unrecoverable-by-construction, "blame it to find the task" is an
instruction that fails 92% of the time, so reach for `search_tasks` on the concept instead.

**Creating tasks is cheap; executing is deliberate.** Draft while the user is still discussing;
start when they say go.

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
| `src/event-converter.ts` | `walkEventsToMessages` — **"the walker"**, which is what this file calls it everywhere else and defines nowhere else: JSONL → `messages[]`. The live path delegates to its callbacks, so a live/reconstruction drift starts here. |
| `src/task-operations.ts` | the shared CRUD ops. MCP and REST are both thin wrappers over these. |
| `src/test-utils/api-message-rules.ts` | the MEASURED Anthropic message-shape rules, and the prefix-vs-sendable split |
| `.mxd/plugin/scope-opts.ts` | `buildMatrixScopeOpts` — the one place that knows matrix's tools, prompt and hooks |
| `.mxd/plugin/web/event-handler.ts` | UI event → log entries. `queueEntryToUIEvent` is the materialization gate; `pendingReducer` is pending. |
| `.mxd/plugin/message-editability.ts` | where the three Edit/Rewind judgments meet, and the only place they may. Has zero imports, asserted by a test. |

## Changing code here

**Every bug fix asks two questions, not one: what caused this specific bug, and why does the
architecture make this CLASS of bug easy?** The recurring answers are duplicate codepaths, lifecycle
coupling, legacy fallbacks masking bugs, and lazily-optional fields.

⭐ **The compiler enumerates only what it can TYPE. Its silence means "nothing typed points here" —
it never means "nothing points here".** Anything reaching a symbol by NAME is invisible to it:
string-keyed dispatch, an event-type name matched across a process boundary, a field an external
system keys on. The asymmetry is what earns this a paragraph — a typed break costs one compiler
error and ten seconds, while a name-based break costs a silent, delayed, hard-to-attribute failure
in a system you were not looking at. `WAKE_SIGNALS` went on listing `agent_stopped` and
`orchestration_completed` for months after both names were replaced, so a stopped agent could only
ever wake an external client by timing out. **Grep for the symbol as a string before trusting the
error list, and check every boundary the type system does not cross.**

**Changed a BEHAVIOUR? Grep for the PROSE that describes it** — in this file, in docstrings, in tool
descriptions, in test names. This is the half the identifier rule misses, and it is the only thing
that finds the second kind of prose rot:

| kind | wrong when? | found by |
|---|---|---|
| **Fabricated** — a claim that was never true | the moment it is written | checking it against reality |
| **Invalidated** — a true statement about a neighbour | **later**, when the neighbour changes | *nothing you can do by re-reading it* |

Both appeared in one docstring on one day. The fabricated one was a benchmark quoted before the
benchmark was run, caught by its author reading their own diff. The invalidated one was true when
written, falsified two commits later by a change 300 lines away, and **auditing that same docstring
for falsehoods did not catch it, because nothing about the sentence is wrong on its face.** Two
directions to be careful in: *"changed nearby" is not "now false"*, and — the one that catches more
— ***"still true" is not "still accurate"***: one sentence survived as an invariant while the
mechanism under it was replaced, and a check looking only for false claims walks straight past that.

⚠️ **And grep for the SENTENCE, not just the symbol** — a rule stated in prose lives in more places
than a grep for the CODE finds, and the distant surfaces are exactly the ones without the identifier
in them. **The highest-risk prose surface here is the compaction checkpoint (`src/compaction.ts`),
and it is nowhere near the code it describes.** It is injected into an agent that has just lost its
history, so nothing in that agent's context can contradict a stale line: a rule that survives there
gets taught, fresh, to every compacted agent, and a grep scoped to the subsystem never reaches it.

### Deleting a mechanism built on a false premise: separate the PREMISE from the OBLIGATION

Having shown that the stated reason for some code is wrong, do **not** delete on that finding alone.
Answer two questions separately: what did it claim to prevent (the premise, now known false), and
what does it still actually DO (the obligation, possibly real and load-bearing)? Delete only where
the obligation is empty; where it is real, keep the effect, relocate it, and rewrite the comment to
name the true reason. **Skip this and you delete a real guarantee along with the phantom, silently**
— the premise was false, so nothing else was protecting the obligation, and the tests that covered
it were usually written in the phantom's vocabulary too, so they go green on the way out.

**Check for a COST as well as for redundancy: "harmless, leave it" is not the safe default it looks
like, and the cost is usually written in the mechanism's own comment as an accepted trade-off.** One
dead collapse helper replaced entries in place, so the day a second producer arrived two distinct
entries would have rendered as one, carrying the last one's content at the **first one's timestamp**
— a latent wrong answer parked in the code waiting for a caller.

**The transferable half is what happens to the dead mechanism's TESTS, and the honest-looking move
is the wrong one.** *"Invert rather than delete"* is right for the tests of a removed FEATURE, and
it does not reach the tests of a removed mechanism whose last producer is gone: those would assert
"nothing collapsed because nothing was produced", which passes against every implementation
including a deleted one. Three options, one right — delete mechanism and tests together; keep both
and RE-AIM the tests at a surviving producer; or keep the mechanism with no coverage. **Re-aiming is
the trap**, because it silently pins, as intended behaviour, whatever the mechanism happens to do to
a producer it was never designed for: chosen by nobody, and thereafter defended by a test.

## Where agents predictably go wrong

Not hypotheticals; each has cost us real work.

1. **The broken intermediate state feels more dangerous than it is.** Fear of a large change
   produces a revert, or a fallback that keeps the old path "just in case". Both are worse than the
   break: two codepaths drift silently and nobody knows which one ran. Delete until ONE remains.
   **And the third harm outlives the code — the dead path's VOCABULARY stays in people's heads**,
   which is why this file has to keep saying that "alternation" names a rule that never existed, and
   why two people independently tried to unify the same three Edit/Rewind judgments on one
   afternoon. Neither cost was the old code; both were the model it left behind.
2. **The existing shape is not a given.** "Why does this exist" beats "how do I make this work". And
   a "unification" that adds a third path is not a unification.
3. **Imagined requirements get built.** Building a tool or an analyzer, agents default to handling
   every case they can imagine — classifications, category labels, filter flags, pattern-matched
   explanations. Each branch corresponds to an imagined need, not an observed one; half end up dead,
   and the live half hides the data patterns a raw dump would have shown. **Start with the simplest
   raw dump and add heuristics only when real use exposes a concrete need.**
4. **"Start something new" wins locally and loses globally.** When a requirement appears, three
   options exist: create a task fresh, create and fork context into it, or `send_message` an
   existing (closed, verify, pending) task. The third is often correct and loses on every cheap
   dimension — fresh description vs stale, clean session vs unknown state, one step vs two, and the
   word "closed" reading as "finished" — so agents take the first and fragment context across
   redundant trees. The same shape appears as handing work to a fresh agent instead of continuing.
   Prompt alone has not fixed it; the mechanism design is draft `01KNZGYY4T6SYWVT66DK13XCPV`.
5. **Context is a compaction boundary, not a deadline** — the system prompt argues this in full;
   what belongs here is the local measurement, because agents estimate their own budget **badly and
   confidently**. The agent that offered a handoff was at 2.0M tokens having **never compacted
   once**, estimated 2-3 sections left in it, and on being told to continue finished all 5 plus an
   extra.

## Hard invariants

Violating any of these produces silent corruption rather than an error. Each bullet is the whole
rule; most are also argued out in their own region, a few are stated only here — **a missing region
is not a missing mechanism**, so do not read one as the other.

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
  reset/reorder; MCP and REST are thin wrappers. Behavioral differences are explicit (`if
  (editedBy === "user")`), never a second implementation.
- **Messages have a two-phase lifecycle.** `message` persisted → frontend defers;
  `messages_consumed` → frontend materializes. `QueueMessage.ts`, `Event.ts` and the displayed
  `[HH:MM:SS]` are all the same value, set once at creation.
- **Recovery must touch JSONL, not just memory.** In-memory `messages[]` and the JSONL events are
  two data structures. A "fix" that only edits `messages[]` leaves the poison on disk and it comes
  back on the next resume.

## ⚠️ Writing this file

What earns a place is the blockquote at the top of this file. **The reorganization procedure, the
rot taxonomy, the condensing rules and the measurement test all live in `.mxd/memory-reorg.md`** —
read them there, and put anything you learn about how this file fails there too. Two copies of a
procedure drift, for exactly the reason *The live path has no construction logic of its own* gives
about code.

**Never `write_file` this file.** It rewrites the whole thing, causing loss or duplication. Use
`edit_file` (match the last lines, extend) or `echo >> .mxd/memory.md`. Update it BEFORE calling
`done()`, and commit it alongside the code it describes.

⚠️ **Searching THIS file: anything over ~60 characters needs a multiline search.** It is hard
wrapped near 100 columns and the wrap lands mid-phrase, so a single-line `grep` for a sentence you
can see with your own eyes returns **0**. `git log -S"<long phrase>"` fails identically, so "when
did this sentence arrive" archaeology comes back silently empty. **The damage is the opposite of a
missed match**: you conclude the file does not say a thing, and then write it a second time — which
is exactly what a reorganization exists to remove. Search a short fragment, or collapse newlines
first.

Two smaller facts about that hard wrap, both of which cost a cleanup pass. **`⚠️` is TWO code
points, not one**, so wrapping by eye to "100 columns" silently overshoots on every line carrying
one — one rewrite came out at 580 over-long lines that looked correct in an editor. And **a wrapped
line must never BEGIN with `>`, `|`, `#`, `-` or `=`**: markdown reads those as block markers before
it ever sees the inline code span they were part of, so breaking `` `x.length >= 1` `` across a line
turns the rest of the paragraph into a blockquote.

## Editing the system prompt

The system prompt is **universal** across every project that uses Matrix. Each project has its own
`memory.md`, and agents elsewhere see the shared prompt plus THEIR memory, never ours. So the prompt
gets principles, roles, tool semantics and craft; this file gets matrix-internal implementation,
architecture and pitfalls. The one matrix-internal detail the prompt is allowed to expose is the
path where pre-compaction events are preserved, because a compacted agent otherwise has no way to
read its own history.

⭐ **The craft lessons in THIS file cannot be relocated to the prompt, and the attempt is the
proof.** It looks correct — "universal lessons belong in the universal prompt" follows directly from
the split above — and it was executed far enough to measure: the movable part shrank from an
estimated **310 lines to 82**, because **each rule here is welded to the specific thing that
happened, and the weld is what makes it work.** A craft rule in the prompt with no evidence is a
platitude every agent reads past; the same rule sitting next to the afternoon it cost is an
argument. The split still holds for a genuine DUPLICATE, where the prompt states a principle and
this file merely repeats it. It fails here because there is no duplicate: the prompt has the
principle and this file has the only evidence for it. **Someone will propose the move again.**

⚠️ **The prompt contradicts itself across sessions and nothing catches it.** This file has regions,
so putting a claim next to its refutation is a move you can actually perform; **a prompt is one
linear argument, and two sentences sixty lines apart are never brought together by anything.** It
does not present as a conflict either — both are individually true and well written, and they only
cancel when someone holds both at once, which is exactly what the linear form prevents. Observed in
two commits one session apart, same author: one added *"every unfinished break is state you carry,
in a context that runs out"*, the other existed to establish *"compaction is a continuation, not a
stopping point"*. **So read the recent prompt DIFFS before editing, then re-read the whole thing** —
the round that INTRODUCED that contradiction substituted a targeted grep for the full read.

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

> **An inconvenient TRUE assertion plus a conveniently-green FALSE one means the false one gets
> installed, and is then believed as fact. The fiction does not win on persuasiveness — it wins on
> not causing trouble.** Once it lives inside a `throw` it starts MANUFACTURING EVIDENCE: 628 error
> strings from the rule that was *executed*, zero from the rule that was merely *documented*. **The
> knowledge was never lost; the enforcement was.**

**Detector — do not audit whether the assertions are correct.** That comment was entirely correct.
Ask instead: **is the rule being ENFORCED the same rule that is DOCUMENTED?** Wherever those two
fork is where a fiction starts producing evidence — and the fork can be born in code written minutes
earlier, kept alive by a green test whose fixture is drawn from the failure that happens in
practice, which is exactly the fixture that cannot separate the two rules.

**An over-strict test double bills you three ways, and the third leaves no artifact.** It creates
complexity you pay for. It hides gaps — a fiction occupying the "role rules" slot stopped anyone
asking what the real role rule was. And **it VETOES correct code**: the legal shape `[…, user,
user]` was rejected, so the correct implementation could not be tested and the feature quietly
acquired a reputation for being hard to test. **Nothing was red. Ask what your test double has made
people give up on, not only what it has made them build.**

**Zero existing tests went red when the true rules were finally added, and that is the finding
rather than a disappointment. The fiction was not masking existing tests — it was masking the fact
that nobody had written the missing one.** A gap does not turn red; it stays invisible until someone
goes looking.

**Three shorter members of the same family, each a different medium:**

- **A wrong MECHANISM licenses a weaker test.** Chasing the CoreML NaN, a real published mechanism
  was fitted to two data points — over-fitting to n=2 while carrying a citation. "FP16 overflows on
  long inputs" implies short inputs are safe, under which a single long probe is not merely adequate
  but *well-chosen*. **The causal story silently set the bar, so the check that would have caught it
  is the one the story talked you out of needing.**
- **The cheapest instance to guard against is READING. When an instruction is short and the action
  it licenses is expensive or irreversible, one clarifying question is always cheaper than a
  confident reading** — and the temptation is strongest exactly when the reading is coherent,
  because coherence feels like confirmation. A coherent misreading of a short instruction would have
  deleted 660 lines of this file — it is the relocation *Editing the system prompt* refuses —
  defended with "a revert restores anything lost": true, and beside the point, because **the revert
  restores the lines, not the hour.**
- **A measurement that contradicts your plan is not a result to report afterwards — it is a reason
  to stop.** Mid-execution of that same deletion, the first rung measured 82 lines against an
  estimate of 310, already refuting the plan it was part of; the intent was to finish the cuts and
  report the discrepancy after. **Nothing about that is careless — it is the ordinary shape of
  finishing what you started**, which is why it needs writing down: the surprising number arrives
  while you are busy, and "I'll report it when I'm done" costs nothing to think and everything if
  the plan was wrong.

## ⭐ Your instrument is a claim until you have made it fail

**Every measuring thing in this repo has, at least once, answered confidently and wrongly — and the
shape is always the same: it produces the COMFORTABLE answer.** A search returns `(no matches)` and
you conclude nothing points there. A gate prints `All checks passed.` A mutation harness reports
SURVIVED. A linter reports zero. **None of those look like a broken tool. They look like good
news**, which is why nobody goes back to check them, and why the wrong answer is inherited by
everyone downstream.

> **A checker reporting ZERO is a claim about the checker until you have made it report ONE.
> Planting is not diligence — it is the only thing that distinguishes "clean" from "not looking".**

The roll-call, because the range is the argument — these are not one subsystem's bad week:

| the instrument | what it reported | what was true |
|---|---|---|
| `search` | `(no matches)` | it could not see `.mxd/plugin/`, 34% of the source |
| `check-i18n.sh` | `All checks passed.` | it had read 8% of the lines, and 1 syntactic form of 4 |
| `.hooks/pre-commit` | `All checks passed.` | 4 of 141 test files, one of them deleted 4 months earlier |
| biome `noFloatingPromises` | zero violations | zero *also* over a planted violation in the file it was checking |
| a mutation harness | `SURVIVED` | macOS has no coreutils `timeout`, so the run never happened |
| a mutation harness (again) | `SURVIVED` | it ran, against a test path that does not contain the mutated file's tests |
| a per-frame scroll probe | "range unchanged" | 267ms of samples missing, because the thing being measured had blocked the main thread |
| a three-signal task probe | `false` for all 551 tasks | `tree.json`'s `nodes` is an ARRAY, so `Object.entries` handed back indices as ids |
| the `ps`-based autoResume audit | "auto-resume still costs 4 procs" | it was measuring an agent a human had started 14 seconds after boot |

Four things a control has to be, each paid for by a real one — the last two by rows in that table,
the first two by audits of this file itself (`.mxd/memory-reorg.md` § check 6). It must be **able to
FAIL for the reason you are testing** — a reviewer confirmed with a positive control that grep could
see a file's real exports, then reported two of its symbols as fabricated, but the symbols were real
and lived in a commit their branch had not merged, and the chosen control existed in BOTH versions,
so it could not separate "this symbol is absent" from "my checkout is old". It must be **placed
where the risk is**: a `while read` loop silently dropped its final line, and the planted control
worked only because it was last. It must be **verified to have RUN, and to have run the thing that
COVERS the subject** — two different questions, and only the second makes SURVIVED mean anything.
And it must be **of a resolution that can carry the measurement you specified**, because below that
resolution the failure mode is a silent false negative that reads exactly like a real result.

**Two corollaries that catch what planting does not.** A **uniform answer across a whole population
is the signature of a broken instrument, not a finding** — 551/551 is not a result. And **a
heuristic validated only where it works reads as verified**: the `ps` proxy was written against a
boot where nothing else was happening, i.e. in exactly the condition where it cannot fail.

**Worst of all is when the rule that suppresses a redundant check is also suppressing the only
detector a failure mode has** — *"ALWAYS use this for search tasks, NEVER invoke grep via bash"*, on
a `search` that was blind. For as long as that bug lived, an agent that obeyed got the wrong answer
and one that disobeyed got the right one. **A description that tells agents to stop cross-checking
has to earn it.**

## Reviewing: whose reference is it, and what shape of finding can it produce

Both halves came out of one 2026-04-03 documentation audit, and they compound.

**A verification whose reference was produced by the verifier is not a verification.** That audit
reported five files "all verified clean". Its own session, ~320 events earlier, had sent the docs
project the numbered change-list those files had just been edited from — so it compared the docs
against its own instructions, and **agreement was structurally guaranteed.** **Distance manufactures
the illusion**: 320 events is more than enough to stop experiencing a list as your own output, and
by the time it is read back it is simply *the criteria* — so the defence is not vigilance but asking
**where did my reference come from**, a question with a checkable answer, unlike "am I being
circular", which has none. And **`clean` is the one verdict that leaves nothing to review**, so it
is accepted by default and inherited downstream; here for **115 days**. It does not even cover the
bytes it read — two commits landed on one of those files afterwards, one introducing a type that has
never existed. **Date the artifact, not the review: a verdict names a commit or it names nothing.**
The reusable form: **a review is evidence only to the extent its reference is INDEPENDENT of the
thing reviewed.** Your own change-list, task description or previous summary are not.

⭐ **A checklist derived from the artifact can only find contradictions, never omissions.** Walk a
document checking each claim and every finding you can possibly produce has the form "it says X, the
code says Y". You cannot produce "the code has Z and the document has never mentioned it", because
nothing in the document ever raised Z. That audit's findings were **100% contradictions and 0%
omissions**, and the ratio was a fact about the method: a whole-repo probe for concepts absent from
all four docs found **twelve** invisible subsystems, including the plugin layer, the Worker thread,
dual lenses, the active chain and Edit/Rewind. **This is the addition-list failure from *Gates* in a
different medium. The omission pass needs its own instrument, running in the opposite direction:
start from the CODE, enumerate what exists, and ask which of those the reader would form a wrong
model without** — that last clause is the bound, or the pass never terminates. The trap: **the
omission pass makes the contradiction pass look thorough by comparison**, because contradictions
come with line numbers and quotes while omissions come with an absence, and an absence reads as the
weaker finding while being the larger one.

**Auditing a live repo: pin the commit, and expect it to move under you.** Mid-audit the target
gained two commits, every line number collected up to that point was silently invalidated, and —
worse — **one of the findings was fixed**, so reporting it would have sent another team to redo work
they had just finished. Record the target's HEAD when you start and re-check it before you report,
and **re-derive line numbers mechanically from anchor TEXT at the end, never carry the ones you
noted while reading.**
---
# The Agent Loop
---

## How an agent runs, parks and wakes

**An agent never ends; it parks.** Completion is `done()` and nothing else — `end_turn` with no tool
call is an implicit yield, never an implicit done. `handleImplicitYield` is the ONE place every path
that stops working ends up, which is what keeps "what is this agent waiting for" from becoming five
states.

**On resume the loop reads its state off the JSONL SHAPE — four of them — never off an in-memory
flag.** That is the durability property the whole design rests on, and it is why every proposal that
would add a fifth state gets weighed so carefully (see the interrupt marker below, which turned out
not to be one).

⚠️ **`hasPendingImplicitYield` must stop at `messages_consumed`.** It used to walk straight over
consumptions, land on the `assistant_text` from BEFORE the message, and report a park — so the loop
parked on a conversation ending in an unanswered user message and **a message drained into a turn
the daemon died inside was silently never answered.** The window is a whole API call wide.
`thinking` is deliberately still transparent to it, for the reason given under *Only launching
agents that will act*.

## Only launching agents that will act

> **`in_progress` is not the question and never was.** Status says the node was never finished. It
> says nothing about whether anything is owed, and today's dormant nodes have been `in_progress` for
> six weeks.

**Measured 2026-07-25: one daemon boot auto-resumed 14 nodes, and every single one looked at its
log, found nothing to do, and parked.** Only 8 of the 14 got as far as connecting MCP — the other
lenses do not connect it at all — and those 8 cost **32 subprocesses and 1.58 GB**, held for the
daemon's life, because a parked session never ends. `shouldLaunchAgent(events)` now answers "is
anything owed here" BEFORE the session exists, because `runAgentForNode` connects MCP, builds
work_context and writes `session_config` before it ever looks at the conversation.

**It is an EXTRACTION of what the loop already decides, not a second opinion.** Every place the loop
declined to call the API was already correct; the change evaluates that same judgment one level
earlier. If the two ever disagree the loop wins and the predicate is wrong.

**The cost did not vanish; it MOVED onto the path where a parent is waiting for its children.** A
parent used to be launched at boot and sit parked, so a child's `task_complete` woke a live agent in
microseconds; now that completion has to LAUNCH it. That is the intended trade, and it is invisible
in "32 → 0", which says what stopped being spent at boot and nothing about where it goes when it IS
needed. **Removing an eager cost relocates it to the moment of first use — ask what is waiting
there.**

⭐ **The boundary condition on hoisting ANY such decision is not the obvious one.** It is **not**
"the steps before the loop only read the log" — two of them manufacture input. The rule is that **a
decision can be hoisted iff every input it consumes is computable WITHOUT performing the step that
would create it**; stated the wrong way round, the next person concludes that a step which appends
is disqualified, the opposite of what holds. **A corrupt log whose repair cannot be expressed
LAUNCHES**, so it reaches `runAgentForNode` and gets reported; swallowing it into "nothing to do"
turns a loud failure into a node that never comes back.

**The one genuinely new rule is the `interrupt` exclusion**, a subtraction with a single named
member: it is the only message the loop writes ABOUT ITSELF rather than delivering as input. ⚠️ **It
keys on `source`, and must not be widened to "quiet".** `quiet` describes one moment of delivery and
**does not survive to JSONL**; worse, the generalisation is wrong on its own terms — crash-recovery
`task_complete` is delivered quiet *specifically so it does not double-launch*, so a "quiet sources
do not launch" rule strands a parent waiting on a child.

**A log ending in `thinking` PARKS**, and the predicate agrees with the loop rather than
out-guessing it: the turn is deferred, not lost, and the next message ends it `[…,
assistant[thinking], user]`. **Measured against production, a thinking block is positionally
IDENTICAL to a text block**; only the TRAILING assistant message 400s, which is the
trailing-assistant rule wearing a different error string. A repair that dropped such a turn was
built on the false premise and is deleted.

**`launchingNodes` guards the window between "we decided to launch" and "the session exists", and it
must be taken with no await before `beforeChildLaunch`** — `git worktree add` takes seconds, two
concurrent launches both used to get through, and the loser's throw marked the node `failed` and
sent a bogus `task_complete(failed)` while the winner was still running. ⚠️ **Never add a node to it
from outside `runAgentForNode`**: `autoResumeProjects` once pre-registered every node it was about
to launch, `runAgentForNode` saw the set and returned early, and no agent ever started.

## done() is two-phase, and both of Phase 2's invariants were learned the hard way

**done() used to do everything inside the tool handler — status update, parent notification, queue
close — and it raced with messages still arriving.** So: **Phase 1 is agent-side** (close the queue,
exit the loop, no status update; done() is an *intended orphan* like yield, no tool_result written).
**Phase 2 is daemon-side** (status → verify/failed, `task_complete` to the parent, `done_notified`
for crash recovery). `session = null` is the irreversibility boundary.

⚠️ **`task_complete` must be DURABLE before `done_notified` is written.** The marker means "Phase 2
finished", so if it lands while `task_complete` has not, a crash in that window leaves the parent
waiting forever with nothing to re-deliver; the reverse window merely re-delivers a duplicate.
**That asymmetry is the whole reason for the ordering — a duplicate completion is recoverable, a
lost one hangs the parent.** The naive version looks fine, because the marker lands on this node's
write queue synchronously while `task_complete` goes through `await getTracker` first.

⚠️ **The loop promise must settle on EVERY path**, resolve inside the `finally`, throws logged and
not rethrown. `stopTask` awaits it with **no timeout**, so one leaked promise hangs the stop
forever.

**Auto-launch failure IS task completion.** When `beforeChildLaunch` throws the target never runs,
so no done() ever fires and the sender's `yield` hangs forever; `deliverMessage`'s catch marks the
node `failed` and delivers `task_complete(success: false)`, and the sender wakes through the
existing resume flow because "failed before starting" and "failed during work" are indistinguishable
from its side. **Design rule: any code path that could silently hang a yielding parent must notify
via `task_complete`.**

**Writing that handler and making it survive its OWN failure are two different problems, and the
second bites in exactly the shape the first was built to prevent.** The original was `.catch(async
e => {…})` doing error event → status flip → `save()` → deliver. An `async` function passed to
`.catch()` has nobody to catch **it**, so a rejected `save()` escaped as an unhandled rejection —
and because the notification was last in a straight-line body, that rejection **skipped** it, so the
handler whose entire purpose is "a parent must never wait forever" hung the parent at the one moment
something had already gone wrong. **The shape that holds:** a NON-async `.catch` where each COSMETIC
step sits in its own try/catch and the LOAD-BEARING delivery comes last but cannot be starved. **Do
NOT collapse that into one try/catch around the whole body** — it converts a loud unhandled
rejection into a silently skipped notification.

### An unhandled rejection is an outage here, not a log line

**Measured 2026-07-25: a rejected promise with no handler inside a Bun Worker ends the worker
thread.** Its pending timers never run and the daemon sees `worker.onerror`; in a plain Bun process
it exits the process outright. So a floating rejected promise in the runtime is a way to kill every
agent in that project's lens, and per *The self-bootstrap death chain* that death is
indistinguishable from a real crash to anyone reading the log. **The hang was the mild half** —
worth saying in those words, because the obvious framing ("a parent waits forever") describes the
bounded consequence and silently sets the priority for the whole class from it.

⚠️ **`MessageQueue.enqueue()` returns `void | Promise<void>`**, returning the Promise exactly when
the before-first-message hook is armed — a fresh session, and after every compaction re-arm. The
idiom around it is a sync `try/catch` at five production sites including `deliverMessage`, and **a
sync try/catch does not cover the async branch**: the rejection escapes and `return "enqueued"`
reports a delivery that may not have happened. The full classified census (26 sites, 11 real) is in
task `01KYDEFRM5WBDCRXPTGX75FYZ2`.

**DECIDED (`01KYDESAKCW186VZ8GEK6TW91W`): the worker should install an `unhandledRejection` handler
that LOGS AND LETS THE THREAD DIE.** It looks like the swallowing catch this file keeps arguing
against, and what resolves it is *what the handler does AFTER it logs*: log-and-die is pure
attribution, turning an anonymous worker death into one that names the lens, while log-and-swallow
is the swallowing catch at PROCESS scope — worse than the per-site version, because the worker
carries on in an unknown state while writing JSONL and managing worktrees.

## The done() payload, and the boundary it defends

**The runtime must not know what a plugin's completion MEANS.** `done()` has exactly two
agent-facing params — `status` (a control bit routing the node to verify/failed) and `result`
(required, non-empty, everything reported as content) — and `resultRounds` gets ONE block APPENDED
per `done()`, never overwritten, so a task woken and re-done N times carries N rounds in call order.

**The boundary is the point of the design.** The runtime MAY read `status` and ONE completion-output
string (every plugin has one). It MUST NOT carry the round structure or any other content field —
those are read only inside matrix's `onDone`, and the runtime passes the raw done input through as
an opaque `Record`. **The check is a grep**: `resultRounds`, `appendResultRound`, `parseDonePayload`
and `DonePayload` appear in `src/runtime/*`, `runtime.ts`, `provider-shared.ts` and `events.ts` only
inside boundary-explaining comments.

**Testing opacity requires data only the other layer understands** — the robustness test uses a
non-matrix scope whose `done()` carries `wordCount` and `mood`. **Testing with the default plugin's
own fields cannot distinguish "passed through opaque" from "reconstructed into that plugin's
shape"**, because both produce the same round.

**KNOWN LIMITATION: crash-recovery Phase 2 does not append a resultRound.** It is plugin-agnostic
runtime code that sets status directly and never calls `onDone`; wiring it in would either break the
boundary or route crash recovery through a plugin hook.

⚠️ **When you rename a tool param, grep the FRONTEND**: done-card consumers read it BY NAME through
index access, so typecheck cannot catch it and integration tests do not render — the cards would
have quietly lost their text. Same by-name blindness as *Changing code here*.

## Duplicate yield or done in one turn

The API can return several `yield` tool_calls in one assistant turn. Repair skips the intended
orphan — specifically the LAST tool_call, not "any yield/done" — and the extras emit to JSONL
immediately while their live-path construction is DEFERRED, so on wake they bundle into ONE user
message.

**The deferral is a live/walker BYTE-IDENTITY device, not an API-shape device**, and this was
misunderstood for a long time:

> Deferral is REQUIRED when the deferred tool_result is PERSISTED and lands ADJACENT to another one
> in JSONL, because the walker merges adjacent tool_results into one user message and the live path
> must match. It is UNNECESSARY when the message it would merge into is TRANSIENT.

⚠️ **So do not "simplify" it away by analogy with the compaction deferrals that were deleted.**
Nothing separates the extras' results from the real yield's in JSONL, so splitting the live push
would require inventing a JSONL boundary event — strictly more machinery. The compaction deferrals
were removable for the opposite reason: the summarization instruction is never persisted at all.

⚠️ **Duplicate `done()` calls must exit as orphans. Do NOT emit tool_results for all of them.** That
was tried, to avoid a repair path; it works, and it costs behavior — with every done answered,
resume detects a generic interrupted-resume instead of a done-resume, so the woken agent silently
loses its done-resume context.

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

**What made the deletion safe is worth more than the deletion: the branch's one real obligation had
already moved out of it.** It used to consume the pending tool_result and the duplicate-yield extras
— the **pairing** rule, which is real. That now happens where the tool_result is EMITTED, so the
ordinary path inherits it for free. A second worked example of *Deleting a mechanism built on a
false premise: separate the PREMISE from the OBLIGATION*.

**STANDING DEFECT of the automatic trigger: a session with ≤4 messages cannot auto-compact no matter
how large it is.** One giant tool result puts a 3-message session over the threshold and it keeps
calling the API until the context window rejects it. **It is not a consequence of removing the
manual short path** — the two used to be independent `if`s and `auto + len <= 4` already fell
through both.

⚠️ **Why the floor exists at all**, since "delete the magic 4" is the obvious reading and would
reintroduce something worse: a freshly compacted session sits at ~1 message, so if the token count
is STILL over threshold — system prompt plus tools plus summary already exceed it — the loop would
compact again immediately, forever. **The floor is a PROXY, and a bad one: the condition it stands
in for is "compacting will not reduce anything", which has nothing to do with message count.** **If
you replace it, replace it with a measurement, not a smaller number** — compact, and if still over,
say so loudly and stop auto-compacting for that session. "Even a full compaction cannot get this
under the limit" is a real configuration problem the user needs to see, and both of today's
behaviours hide it equally well. Code-level half of `01KXNZHYSJFF0BVQJVPG2WC1RV`.

**Session config is refreshed at the compaction boundary, and only there**, because compaction wipes
`messages[]` so the cache is already lost — `cacheTtl` excepted, to preserve fork inheritance.

## Interrupt and stop are two abort channels, and they cannot be one

**An interrupt takes a running agent from mid-turn to idle-waiting-for-input and tears down
nothing.** A stop is teardown: kill background processes, close the queue, drop the session,
disconnect MCP. They were the same button in the UI before this, and they are opposite verbs.

The signal is `TaskSession.interrupt`, deliberately **not** `session.abortController`. Sharing one
channel gives you either "an interrupt tore the session down" or "a teardown was mistaken for an
interrupt so it could not tear down", and **both are silent**. They meet in exactly one place —
`AbortSignal.any([teardown, interrupt])` — and every reader checks teardown FIRST.

**No repair is owed, and that is the point.** `stopTask` leaves tool_calls unclosed because the loop
is already dead, so the next launch's repair writes *"interrupted by daemon restart"* — false
whenever a human pressed stop, and re-read by the model on every later turn. An interrupt keeps the
loop alive, so it closes its own tool_calls before parking.

**Partial assistant text is KEPT, deliberately.** It makes the interrupted state representable on
disk with zero new resume states; it gives the user's next message a referent, because "no, don't do
that" needs the text they were reading; and emitting it as a normal final `assistant_text` is what
clears the UI's streaming partial. Never the thinking blocks (no signature), never a half-emitted
`tool_use`.

⚠️ **Do NOT front-run the queue when parking.** A message drained at the cancellation point would be
merged into the turn's user message and then sat on — the loop would wait for a *further* message
before calling the API, so "stop, do X instead" would look swallowed. Left in the queue,
`handleImplicitYield` returns it immediately. **`consume()` is called when the loop PARKS, not when
it decides to**; clear the flag at the decision point and a stop landing as the agent goes idle on
its own leaves the flag set, swallowing the next message.

**Compaction turns are not interruptible mid-flight** — the summarization instruction is already in
`messages[]` and cutting there pairs "summarize yourself" with whatever the user says next.
**`done()` wins a race with the stop button**, because that is completion, and marking it "not
executed" would strand the parent forever.

⭐ **"I pressed stop, then restarted the daemon, and it started working again" used to be an accepted
boundary, and how the trade CHANGED is the transferable part.** In the window *interrupt → restart
with no message between*, the log could not tell "the user stopped me" from "I died mid-work" — an
interrupt during a tool leaves tool_results, byte-for-byte what a daemon death inside an API call
leaves. The stated price of fixing it was a persisted marker, i.e. a **fifth resume state**, which
this design refuses. **What changed is that the marker acquired a second, unrelated buyer**:
`shouldLaunchAgent` has to answer the same question before a session exists. One `message` event
with `source: "interrupt"` settles both. **And it is NOT the fifth resume state** — resume still
reads exactly four shapes; the marker is an ordinary queue message that happens to be written by the
loop about itself. **A cost rejected as "a new state in the state machine" can become payable as "an
existing mechanism used once more", and those are worth re-pricing separately.**

## Agent activity: live process state is asked for, never replayed

**"Is the agent working" was three layers of heuristics stacked on a boolean that itself had three
sources** — a 500ms poll, a timer, and a correcting re-poll, each covering the layer above it. It is
now ONE explicit state in backend memory:

> **State is never derived from the event log. On connect the client ASKS; while connected the
> server PUSHES.**

The log records *"it became active at some past instant"*; replaying that as *"it is active now"* is
a category error, and the old poll existed only to undo the error it had just made. Note the exact
inversion against pending messages: pending IS a projection of a persistent log, so a reducer over
events is right there (*Pending messages are a projection of the event log*). **The question to ask
is "does this thing exist on disk?"**

`AgentActivity = "idle" | "thinking" | "tool"`, asymmetric on purpose. `tool` is the precise one
because it is the only state with an unclosed tool_call, which is the one with an interrupt
consequence. `idle` means parked on `queue.wait()`. **`thinking` is explicitly the residual** —
every other way the loop is alive — which makes retry backoff, session setup and compaction turns
consequences rather than special cases. Known naming debt, deliberately unfixed: a compaction runs
2-3 minutes and "Thinking…" across it is the same kind of lie this model removed; adding
`compacting` later is a pure carve-OUT of the residual, cheap precisely because the residual is
written down.

**Rejected framing, offered and vetoed: defining the states by what feedback the user sees**
(spinner vs tool card). That defines backend state in terms of frontend rendering — the same class
of error as deriving it from the log — and collapses the moment a UI affordance is added.

It lives on `TaskSession.activity`, so it dies with the session and there is no second lifecycle to
keep in sync. **The field write and the broadcast must happen in the same function**, which is why
the setter is passed INTO `handleImplicitYield` rather than the event emitted there and the field
written at its four call sites — split them and call site number five gets only one half.

⚠️ **`idle` is announced only when the loop will ACTUALLY park.** Not flicker avoidance: it is what
makes `idle` mean "waiting for you" rather than "reached a yield point", and both consumers depend
on the stronger meaning — `yield_external` wakes an external client on it, and the UI re-fetches
JSONL on it.

⚠️ **There is a `thinking` transition on the way OUT of idle, and the argument for omitting it was
wrong in an instructive way.** The reasoning: every path leaving `handleImplicitYield` reaches the
API block, so a second setter is unobservable — *the emitted event sequence is identical either
way*. True, and irrelevant, because **consumers read the STORED value, not the event stream.**
Without it the whole wake window reports `idle` for a loop that is provably not parked, and the
documented `send_user_message → yield_external` workflow lands exactly there and is told the agent
stopped working. **The structural fix is the dedupe, not the extra line**: `setActivity`
early-returns on an unchanged state, which makes "an extra call is harmless" true, so you write a
transition wherever the loop changes what it is doing and never reason about it again.

**`agent_activity` is a broadcast-only delta and must never reach JSONL** — that is what makes
"replaying history cannot fake-activate an agent" structurally true instead of corrected afterwards.
A separate snapshot goes daemon→client on SSE connect, **sent even when empty**, because "nothing is
running" is exactly what a client reconnecting after everything stopped needs in order to drop stale
entries.

**One consumer is invisible to a grep for `activeAgents`**, and it is the canonical local instance
of the by-name blindness in *Changing code here*: `yield_external` subscribes to the `agent_idle`
**event type name**, now matched via a predicate on `agent_activity`, and **the reported reason
string stays `"agent_idle"` because that is the tool's external contract.**

## An anomalous stop idles the agent silently

An assistant turn returning **thinking only** — no text, no tool_call — makes the loop see
`toolUses.length === 0`, treat it as end of turn, and implicitly yield **with no user-visible
signal**. For a root in conversation this is benign; a human eventually pokes it. **For an
autonomous sub-agent nobody is watching it is an indefinite hang, and the parent's yield never
wakes: the live case sat idle for 8 days.** Our gap is that `getStopReason()` collapses every
non-`end_turn` reason — `refusal`, `pause_turn`, `model_context_window_exceeded` — to `tool_use`.
The guard (draft `01KXK69KKKGG4XHPH7EWGNY5AC`) is a persisted, user-visible error event **before**
idling for any stop reason outside `{end_turn, tool_use}`, plus a bounded `pause_turn` continue.

**Agent time perception is DATE-BLIND, and it fails confidently.** Context timestamps are
`[HH:MM:SS]` with no date, so the 8-day agent woke and reported "~80 minutes" — 14:56 → 16:13 looks
same-day. **Ground truth is the epoch `ts` in the JSONL.** Root hit the identical thing with an
overnight test run whose `[22:06]` → `[11:04]` gap was only inferable from anomalous test durations.

---
# Tools the Agent Calls
---

## bash: bound the output rather than forbidding the workaround

**Agents piped and redirected for a legitimate reason — context was genuinely at risk — and rules
against it leak at the edges.** So the tool satisfies the need instead: under 1KB is inline only, up
to 10KB is full inline plus a saved file, over 10KB is head 5KB + a banner + tail 5KB with the
complete output on disk. Now the instinct has nothing to act on. Streams are merged by wrapping in
`bash -c "(cmd) 2>&1"`, which makes an agent-written `2>&1` a harmless no-op, and foreground and
background share one `formatBashResult` so a `background_complete` is byte-identical to the
foreground result for the same command.

⭐ **The framing generalises: when agents repeatedly do X, ask whether the motivation is legitimate,
and if it is, make the tool satisfy it naturally instead of enforcing against it. If you find
yourself adding a parser, a rejection or a warning to the new tool, you have drifted** — the point
is to make the shortcut unnecessary, not forbidden.

The "don't pipe" guidance lives in the bash tool's `description`, not in the system prompt, because
that is where the decision to pipe is made — while constructing the call.

## The bash result names its own working directory — and a one-shot warning could not

**The failure this removes is invisible by construction.** After a `cd` out of the worktree every
later command succeeds, `git status` reports cleanly, and the output looks authoritative. An agent
in another project `cd`'d into this repo, missed the one-shot warning, then built a five-link
evidence chain — empty `git status --porcelain`, `ls` returning "No such file or directory", a `git
check-ignore` hit — and **filed a two-bug report against this daemon.** Every link was individually
valid; they were answers about a different repository.

⭐ **The general rule, worth more than the feature: a one-shot notification cannot signal a
persistent condition — the notification's lifetime has to match the state's.** The old warning fired
at the moment of the `cd` and never again, so it covered the one result the agent was already paying
attention to and left silent every result where the mistake actually does its damage. Now every
result whose cwd is not the worktree root opens with a line naming it, and the quiet state is
EXACTLY the root. **Once every affected result carries the state, the transition warning's firing
condition is a strict SUBSET of it**, so "keep both" means printing the same fact twice — deleted.
What is NOT redundant is `workdir set to X from now on`: that reports an EVENT, the notice reports a
STATE, and neither substitutes for the other. (Same distinction as an SSE delta versus a snapshot.)

⚠️ **Which checkout a directory belongs to is answered by `git rev-parse --show-toplevel`, and both
obvious simplifications are wrong.** A path-prefix test calls `.worktrees/<other-task>` "inside",
because it IS under the main repo root — and for ROOT that covers *every* other agent's checkout,
the single most dangerous place to stand unknowingly, where a write or a commit lands in someone
else's in-flight work and looks entirely normal going in. A hand-rolled walk up to the nearest
`.git` is wrong too, because **a linked worktree's `.git` is a FILE**, so an `isDirectory()` test
resolves every agent worktree to the main repo — the one answer that makes another agent's checkout
look like home. Asking git cannot drift from git.

The lookup rides in the exit trap that was already writing `pwd`, and the notice describes the
directory the shell ENDED in. Its `2>/dev/null` is load-bearing: outside a repository `git
rev-parse` fails loudly on stderr, that case is NORMAL, and merged mode would fold it into the
command's own output.

**The other end of the same guarantee: `cd` to the directory you are already in is a free no-op**,
so an agent unsure where it is can just say so. There was a shell `cd()` override that errored with
*"already in this directory"*, and **every line of its body existed to produce that error**; with
the error gone the remainder is `cd() { builtin cd "$1"; }`, strictly worse than the builtin it
shadows — it breaks `cd -`, and an empty argument stops meaning `$HOME`. Do not reintroduce a
wrapper. The trade was priced wrong originally, optimising the common case (a redundant `cd` costs a
few tokens) against the rare one (a command running somewhere unintended, with every result still
looking authoritative). **Prefix a `cd` whenever you are not sure where you are.**

## Two filesystem-walk defects, in both tools that walk: a library default serving somebody else

`search` and `list_files` each had the SAME two defects, and finding the pair a second time in the
second tool is what turned two bug reports into a class.

- **Neither walked hidden directories**, because `Bun.Glob.scanSync` defaults to `dot: false` and
  nobody passed the option. In this repo the hidden directory IS the source: `.mxd/plugin/` is every
  ScopeOpts hook, every plugin REST route and the entire UI — **34% of all non-test source,
  invisible to the primary search tool.**
- **A glob with no slash was treated as a path pattern.** `*` does not cross `/` in `Bun.Glob`, so
  `*.ts` — *the example printed in the tool's own description* — matched only files sitting directly
  in the search root. A slash-free glob is now promoted to `**/<glob>`; one containing `/` is a path
  pattern and passes through untouched. Same split ripgrep makes.

⭐ **What makes this class invisible is that there is no line to review.** Nothing anywhere said
"skip hidden directories" or "match only the top level" — the semantic lived in a library's default,
i.e. in the *absence* of an argument, and **code review cannot catch an absence.** Hence the
discipline at every walker now: **decide every behaviour you depend on explicitly, even when you
agree with what you would have got for free.** Stating a choice you were already getting is not
noise; it is the semantic becoming visible and therefore reviewable.

**The second-order damage is why this is a section rather than a commit message: for as long as such
a bug lives, the tool's own description is teaching agents the wrong rule.** `list_files`'s examples
were `"src/**/*.ts"`, `"**/*.test.ts"`, `"*.json"` — the first two anchored, the third silently
meaning something else. The defect was never that `*.json` returned the wrong three files; it was
that a reader **generalises from the neighbours**.

Two consequences that will look like oversights. **The 500-file cap counts files we KEEP, never
files we walked past** — a correctness requirement, now structurally guaranteed by pruning at
descent. With `dot: true` and no skip list, an any-depth `*.ts` filled **323 of its 500 slots with
`.worktrees/` copies** of files the caller already had, and never reached `web/`, `scripts/` or
`.mxd/` at all, so `dot: true` alone is not a different flavour of wrong but strictly worse than the
bug: the cap stops protecting you and starts guaranteeing you get the copies. Do not ship the two
halves separately. And **`.worktrees/` in `DEFAULT_SKIP_DIRS` is load-bearing while costing nothing
today, so it needs an assertion** — each sub-agent worktree is a full second copy of the repo, and
the guard test will not fail before someone "tidies" the list, which is the entire point of it.

### Detecting a silent under-report

The failure mode is silent **by construction**: "no matches" and "never looked" produce a
byte-identical tool_result, so it can never be caught by inspecting the answer — only by a
**collision with something you independently already know**. And you search for things you do NOT
already know, so a false `(no matches)` is indistinguishable from the truth AND confirms your
hypothesis, which is the most comfortable answer there is.

⚠️ **The empty result is the detectable one; the partial result is the dangerous one.** Same bug,
same tool, same agent, 38 seconds apart: a long confident answer that silently omitted the file
*defining* the symbol went unchallenged and was acted on 2 seconds later, while an empty result for
something the agent had read 5 events earlier got double-checked immediately. **An under-report is
only conspicuous when it takes everything away, which is the case that matters least** — so do not
file a bug in this family under "detectable" because of its output SHAPE.

The check that caught it is the one this tool's own description forbids — see *Your instrument is a
claim until you have made it fail*, where that is the general rule.

### Two rules about compatibility worries, one of which is a trap

*"A semantic that has never worked has no users"* settled the `search` glob change in one line. It
proves nothing for `list_files`, where the same change was one line from done: there
`list_files("*.json")` returned `package.json`, `tsconfig.json`, `biome.json` — three real,
plausible files. **The rule is only decisive when the old output was EMPTY**, and a rule is at its
most dangerous exactly when it happens to point at the answer you already want.

> **Before letting a compatibility worry veto a change, measure what the current behavior actually
> produces.** Not "is anything calling this" — *what does the call return today, and does it answer
> the question the caller was asking?*

The common and more dangerous case is non-empty output that does not answer the question, which is
what happened here: the capability being defended was `list_files("*")` as a "show me this
directory" affordance, and `scan()` defaults `onlyFiles: true`, so `*` returned a dozen loose files
and **not one directory**. The tool could not answer "what is the shape of this project", which its
own description claimed it was for, and `*` is the DEFAULT pattern. **The capability being protected
did not exist.**

### The fourth change to this family, and what a hand-rolled walk must reproduce

The two defects above produced silently wrong answers. This one produced the **right answer at the
wrong cost**: both tools consulted the skip list about FILES after the walk instead of about
DIRECTORIES during it, so every excluded directory was enumerated in full and then discarded.
`walkFiles` is now the ONE walker for both tools and prunes before opening a directory — **the walk
now costs what the ANSWER costs.** **`list_files` had to move onto the same walk, and "doing just
one is the smaller change" is the wrong instinct**: two tools sharing three predicates but
disagreeing on WHEN to consult them give those predicates two meanings depending on the caller.

> **The tidiest-looking way to write this walk — `statSync` instead of lstat-based dirents — is
> wrong, and wrong in a way that makes `dir/link -> dir` walk forever. Before this change NOTHING in
> the suite would have gone red.**

`readdirSync`'s dirents are lstat-based, so a symlink answers false to BOTH `isFile()` and
`isDirectory()` and is dropped by both branches — exactly what `scanSync({onlyFiles: true})` did.
`statSync` is wrong twice over, and the second half is the one someone would defend as a feature: it
also starts returning symlinked files `search` has never returned, so one file is reported two or
three times under different paths. **Not following links is also the entire termination argument** —
there is no visited-inode set and it needs none.

⚠️ **Errors must THROW, not be swallowed.** The first version wrapped `readdirSync` in try/catch and
continued, with a comment asserting that matched `scanSync`, written without measuring it.
Swallowing turns "your path is wrong" and "the directory holding the definition is unreadable" into
`(no matches)` — exactly the failure mode this family has already shipped twice.

Sort must live in exactly ONE place, because both caps SLICE the sorted list, so in traversal order
"the first N" is an arbitrary set that can differ between two runs over an unchanged tree. It
follows that `list_files`'s cap bounds the RESULT and can no longer bound the walk — sorted output
and early termination are mutually exclusive — which is fine now that the walk it no longer bounds
is the cheap one, and which the old early break never exercised anyway, **exactly the condition that
would have made a regression here invisible.**

## ⚠️ In a self-bootstrapping project, fixing a tool's SOURCE does not fix the tool in your hand

> The tools an agent calls belong to the **running daemon**, not to anybody's worktree. So *"I just
> fixed X, therefore I can use X"* is **false until the daemon restarts** — and false for every
> other agent running at the same time.

**This makes the blind-instrument trap harder to avoid than it looks, because of who walks into it:
the person who fixed the tool is the person with the most reason to believe it works.** The task
that wrote down "a completeness survey run with a blind instrument returns a confident, wrong
'that's all of them'" then ran its own survey on the blind instrument. The warning and the violation
were in the same task. Everything else about instruments answering wrongly is in *Your instrument is
a claim until you have made it fail*; what is specific here is that **the daemon is the reason your
instrument can be stale while your source is correct.**

⚠️ **Sibling trap, and the cheaper half to forget: a single-line grep is a claim about LINE
BREAKS.** `grep '\.catch(async'` returns **zero** hits in a repo that has one, because the formatter
split the call across two lines. Reach for a multiline search whenever the pattern spans a call
boundary the formatter is free to break.

**Same family, and here the blind instrument is your own tool list: it is a frozen snapshot, not an
inventory of what you can do.** The list you see was frozen into `session_config` at session start;
the daemon's handler registry holds more, and Anthropic dispatches any tool name to whatever handler
exists. Root asserted "there is no WebSearch tool in this project" from reading its own 56-entry
list; `mcp__brave-search__brave_web_search` works, called by name. **"It is not in my list" is not
evidence that it does not exist.** (Gotcha: an unlisted tool has unconstrained argument types, so a
numeric `count` arrives as a string and fails validation — pass the required argument alone.)

## ⚠️ "Never offer a remedy that will not work" costs MORE in a tool error than in a UI

The rule is already written down for greyed buttons under *Blocked buttons are greyed and explained,
never hidden*. It reappeared twice in `closeTaskOp`, and **the second medium is the expensive one: a
human reads a bad remedy and gives up; an agent DOES IT, collects the second refusal, and then
invents a workaround — and what it invents is worse than the failure, because it is invisible.**

**Instance 1 — the dead end.** `update_task {status:"closed"}` refuses with *"Use close_task
instead"*, and `close_task` refused anything that was not `verify`/`failed`. **The first error named
a road the second did not accept**, so a draft had no path to a terminal state at all. Observed
damage: a superseded draft was marked done by writing `[已解决 by <id>]` into its **TITLE** — state
encoded in a string, invisible to every status filter, so it sits in the active pool forever. **That
is the shape to watch for: the workaround is legible to humans and to nothing else.** The fix is a
SUBTRACTION with one member — only `in_progress` is refused. **Close means two things at once**
(reclaim the resources, take it out of the active pool); a draft owns no worktree, branch or
session, so for it only the second applies and the first is a **no-op, not a contradiction**. The
old whitelist read that no-op as grounds to refuse.

**Instance 2 — the false remedy inside the guard that STAYS.** The old message was *"Cannot close a
running task. Stop it first or wait for done()."* ⚠️ **`stopTask` never touches `status`,
deliberately — a stopped task stays `in_progress` precisely so it can resume.** So stopping lands
the caller back on the same refusal, and an agent cannot even take that road: **there is no stop
tool.**

⭐ **The fix for a false remedy is a SHORTER message, not a more complete one — and two drafts went
the wrong way before this landed.** The instinct when correcting a wrong instruction is to explain:
name the false path, name the alternative, price it. Both intermediate drafts did exactly that, and
both were wrong for one reason — **they generated COMPLETENESS where the reader needs an
INSTRUCTION.** An error answers a single question, *what do I do now*; the answer here is "wait".
Each rejected clause fails a concrete test worth keeping:

- *"Note that STOPPING it does not help"* — a warning about an action the reader **cannot perform**.
  Worse, the fact that agents have no stop tool was written down in the report that argued for the
  sentence: it was known, and not applied. **Check what the reader can DO before writing them a
  warning.**
- *"reset_task it first, which discards its session and worktree"* — genuinely unblocks the close,
  and is a destructive option nobody asked for. **Handing someone a knife because they asked to tidy
  up is not helpfulness, and attaching the price tag does not make it one.**
- *"done() sets verify or failed, both closable"* — internal state vocabulary, contributing nothing
  to *what do I do now*.

---
# Events, JSONL & the Active Chain
---

## The event log: append-only, chained, and it never deletes

One JSONL file per task. Every persisted event carries `eid` and `parentEid`, stamped by the store —
callers never set them. **The chain exists so that history can be ABANDONED without being destroyed:
a rollback moves the head, the events after it simply stop being reachable, and the evidence needed
to debug a corruption survives it.** Nothing in this codebase may address an event by file position.

⚠️ **`{ eid, parentEid, ...event }` is WRONG, and it looks right.** When the input already carries
those keys the spread overwrites the fresh values with the stale ones, while the key POSITION stays
first so the line looks correct. Not hypothetical: `buildSessionRepair` re-appends unconsumed
`message` events read out of the region it is about to drop, and with the naive spread they keep a
`parentEid` pointing at an event no longer on the chain — the walk then hits a break and silently
degrades to linear traversal, **which can resurrect rolled-back events.**

⚠️ **`append`/`appendBatch` are fully SYNCHRONOUS. Do not "modernise" them to `fs.promises`.** Two
independent things depend on it, both failing silently: a `clear()` could bump the generation and
unlink the file while the write was still queued, so the thread pool woke and **recreated the file
it was writing to**; and the failed-write rewind only works while nothing can be stamped between the
stamp and the write, so deferring it lets a burst in one tick get stamped first — the event after a
failed one then names a missing parent, the walk stops dead, and **the agent resumes with a silently
truncated context.** Cost of sync I/O: one ~100-byte line, and writes were already serialized per
session. **The general form is worth carrying: it replaces *"correct because nothing happens to
interleave"* with *"correct because nothing CAN"*.**

Ephemeral events (`text_delta`, `agent_activity`, `status`) are deliberately never stamped and never
reach JSONL; **they are not history**, and that is what makes "replaying the log cannot fake live
state" structurally true rather than corrected afterwards.

## One boundary: the active chain

**"Which events count" had FOUR independent implementations.** There is now one —
`walkActiveChainIndices` — and `readActive`, `readFromLastCompactMarker` and `copySessionFrom` all
go through it.

> The active chain ends at the `compact_started` of the last COMPLETED compaction. Inside that
> compaction's window, only `type === "message"` survives.

One backward scan does both jobs, and because `parentEid` always points earlier, scanning backward
IS the lookup — no eid→index map, and a cycle is structurally impossible because the index only
decreases.

**Why the window exists, measured.** Messages delivered WHILE the summarizer runs land between
`compact_started` and `compact_marker`. Ending the chain at the marker put those messages outside
the active region while the `messages_consumed` acknowledging them — written after the marker — was
inside, so reconstruction resolved a consumption referencing an id it had never seen and dropped the
content silently. On the root session: **22 compactions, 8 with stranded messages, 15 messages lost,
4 of them typed by a human.** The live path was fine; only reconstruction (restart, fork, UI
refetch) lost them. The type filter inside the window is equally load-bearing in the other direction
— the summarizer's own thinking and `<summary>` text must NOT come back, because the summary is
already in context as `compacted_resume`.

⚠️ **Do NOT encode the barrier as `compact_started.parentEid = null`.** It looks cleaner —
termination collapses to the chain root and needs zero type knowledge — and it is wrong for two
independently verified reasons. **A compaction is a 2-3 minute window whose outcome is unknown when
`compact_started` is written**, so if the daemon dies inside it there is no summary but the chain
root is already committed: the agent resumes with an empty context, `hasWorkContext` is false so a
fresh work_context is injected, and it carries on like a newborn. No error, no crash — **silent
total context loss**, recoverable only by hand-editing JSONL. And the type check has to exist
anyway, for logs written before `compact_started` existed. The general form, after being talked out
of this twice: **encoding structure in links fits a JUMP (rollback, repair — you know the target
when you write it); a compaction is an INTERVAL whose validity depends on a result you do not have
yet. Do not express an undetermined fact as a link.**

⚠️ **Being ON the active chain is NOT the same as being a legal rewind target**, and this is the
most expensive corollary of the design. **The active chain is not a uniform `parentEid` chain — it
is a CONSTRUCTED sequence.** The window messages are *spliced in* by the walker, adjacent in the
resulting array but with parent links pointing into the region the summary replaced. Rewinding is a
pure parent-link operation, so **it is only defined where construction order and chain order
agree**, which excludes exactly those messages: set the head to one and the backward walk never
meets a marker, so on a real session the entire summarized-away history returns at once with the
summary stranded on an abandoned branch. **Making the window messages visible was correct; reading
*visible* as *operable* is the error.** `hasRewindPoint` answers the separate question, and its test
fails on the DAMAGE — it asserts the resurrected history is absent by name — so anyone relaxing the
limit sees what they just did rather than a bare status code.

**No dangling-link handling, and nothing may produce one.** A `parentEid` naming an eid no line
carries gets NO fallback — same rule as repair refusing to fix orphan tool_results: **a state the
runtime cannot produce must not have code that quietly patches it, or that code becomes a silencer
for real structural bugs.** It shows up as "the events before it stop rendering", which is what we
want. This is only honest because `rewindChainHead` closed the one path that could produce a dangle.

**Fork had its own copy of the boundary and it produced three bugs, one irreversible.**
`copySessionFrom` now calls `readActive`, because "wake up with the source's current context" IS
readActive's definition. A linear slice copied rolled-back events (a slice ignores `parentEid`),
dropped window messages, and did not RE-LINK — the active context is a FILTERED subset, so the
copied events' original parents are absent from the child's file and copying links verbatim strands
everything older. **The compaction boundary events are deliberately NOT copied**: only half of one
can be, and a lone marker in the child reads as the legacy unpaired-marker shape, so the child would
discard exactly the window messages it just inherited. **That is the irreversible one — the source
recovers on restart, a fork never does.**

## The live path has no construction logic of its own

**Two independent constructions of "how a user turn is built" disagreed about whether an image
carried its caption, and that is the bug this design deletes.** `buildUserTurn` delegates to the
walker's callbacks, and the initial drain goes through `adapter.appendQueueMessagesToMessages` for
the same reason, so there is exactly one implementation per provider. **The live path therefore
cannot drift from JSONL reconstruction, structurally rather than by discipline.** If you are tempted
to inline a bit of turn-building "just here", that is the thing being prevented.

⚠️ **Multiline queue content must stay ONE text block.** Two earlier per-shape builders split queue
messages on `\n` into separate blocks while JSONL reconstruction merged them back into one — a
guaranteed prefix mismatch on every resume, and the reason turn-building was collapsed onto a single
path at all.

The yield and done tool_results are the two fixed strings the resume path writes: `"resumed."` for
yield, and for done `"You previously called done(). New messages woke you up:"` plus the working
directory. Queue messages ride as separate text blocks after them, never embedded twice.

**Pre-API-call debug snapshots** land at `projects/<id>/debug/<taskId>/<traceId>/last.json`, one
directory per `runAgentForNode`, ten most recent kept. A restart makes a new traceId directory, so
the previous snapshot survives — **diffing the two newest `last.json` files is the post-mortem for
any drift or unexplained cache miss.**

## Repair is a chain jump, never a truncation

`buildSessionRepair` computes a jump and its caller performs it — `setChainHead` + `appendBatch`,
literally the rollback mechanism. Two shapes: append-only (an orphaned tool_call gets its
interrupted result) and jump-back (duplicate or out-of-order results). It runs before the provider
loop starts.

⭐ **The whole inheritance from the design this replaced: an index computed in one space and consumed
in another is a silent corruption engine.** Repair used to compute an index while the store
truncated by physical line, and the two index spaces silently disagreed **twice** — once because the
index was computed against the post-`compact_marker` slice while truncation counted from the top of
the file (a compacted session lost its marker, its post-compact `session_config` and its summary,
then got interrupted results referencing tool_calls that had just been cut: unrecoverable), and once
because `read()` skips malformed lines while truncation counts raw ones. Both were fixed with a
translation layer, and the translation layer was then deleted along with `truncateAfterLine` —
because the second index space WAS the bug.

Three details that will each look removable:

1. **A truncating repair ALWAYS appends at least one event.** `setChainHead` is pure in-memory; the
   jump only reaches disk as the first appended event's `parentEid`. So both truncation strategies
   append a status event LAST — last so it can never split a run of tool_results into two user
   turns. Without it, repairing a session that resumes in pending-done would evaporate on restart
   and loop forever.
2. **Messages in the dropped region are replayed with fresh eids — ALL of them**, not just the ones
   without a `messages_consumed`. A message consumed into a turn the repair just dropped is exactly
   as absent as one that never arrived.
3. ⚠️ **The synthetic status message is a USER message, and it is suppressed when the kept region
   ends in a pending yield/done.** Appending a user message after an unanswered intended-orphan
   `tool_use` breaks the pairing rule and produces a genuine 400. Older text called this an
   "alternation" guard; alternation is fictional and this is not it. **The word "alternation" in
   this codebase is not a reliable signal of anything — go read what the shape actually is.**

⚠️ **A synthetic message must not use `source: "system"`.** It was tried; `formatBodyForAI`'s
default branch returns `""` and the UI's materialization switch had no case for it, so the repair
reason **silently rendered as an empty string** in both places. Use `createUserMessage` — do not add
a new source variant to fix a rendering gap.

## Rollback and Edit

**It exists because a vendor handed us a point fix and we refused it.** fable-5's streaming
content-filter silently truncated turns, leaving empty and half-written messages in the UI, and
Anthropic's official remedy was a configured fallback to a different model. We built the general
capability instead — let the user go back and resend with DIFFERENT content, reworded or
constrained or on another model — because that one capability subsumes the vendor-specific need
and delivers interrupt, edit and restart along with it. **The catalyst is now moot and the feature
stayed, which is the bet the decision was making**: a hardcoded fallback would have become dead code
the day we changed models.

⚠️ **SCOPE, decided with the user and never widened: a rollback moves MESSAGES and nothing
else.** Files written, tasks created and commits made on the discarded branch stay made, so a
rolled-back conversation can reference world-state produced by a branch no longer on the chain —
an inconsistency that is ACCEPTED, not pending. That is why the impact dialog REPORTS what the
rollback does not undo instead of undoing it, and why "roll the code back too" is a separate
feature with its own decision (`01KY5H4QPFQ3M4Y5WWDJBFSQNB`) rather than a gap to be quietly
filled. **Branching far back also invalidates the prompt cache from the fork onward, which is
affordable only because every rollback is user-initiated** — anything that rolls back
automatically makes the expensive shape routine.

`setChainHead(sessionId, eid)` is one line: set the in-memory head. The NEXT appended event gets
`parentEid = eid`, creating the jump — **the jump is carried by the first post-rollback event
itself, so there is no marker event.** A `rollback_marker` type and an `appendRollback` method
existed and were deleted. **`/edit` is the single backend path**; a standalone `/rollback` endpoint
was deleted because `/edit` combines rollback and delivery atomically. Rewind is an Edit whose
content did not change, so **one answer governs both buttons.**

### Which messages can be edited — three independent judgments, and do NOT unify them

| module | question | the limit is on |
|---|---|---|
| `isWorking` | is the agent busy right now? | TIME |
| `messageStartsRun` | did the agent ever run FROM this message? | MEANING |
| `hasRewindPoint` | is there a state left to return to? | HISTORY |

`message-editability.ts` is the only place they meet, and **its checkable boundary is that it has
ZERO imports** — it consumes three verdicts and computes none. If it ever starts deciding something
itself, that is when to split it.

⚠️ **TOMBSTONE: two people tried to unify these on the same day. Do not.** Both made the **same
mistake — taking a PROPERTY of a thing for the thing itself.** *"The gates are one invariant at two
timescales"* explains a USER concept by its IMPLEMENTATION consequence; an end user has no notion of
an unmatched tool call. *"The message is in the active chain, therefore it is rewindable"* takes a
property of a rewind target for the target. **API 400 is a symptom, not a reason**, and both
framings leaned on it — even if the API accepted a rollback to a message the agent never ran from,
the operation would still be **empty**, because it points at nothing. **Reasons must survive their
failure mode disappearing.** The three judgments' only shared property is that all three grey the
button, which is a fact about pixels.

**The rule is which user turn PICKED THE MESSAGE UP, and the user's own phrasing is the concept:
*only an independently sent message can be rewound*.** "Run" means something only to someone who has
read the provider loop. `buildUserTurn` packs `[...tool_results, ...queued messages]` into one turn,
so **a turn carrying a tool_result is ANSWERING the agent's own previous output** and anything
riding along in it did not start it; a turn with no tool_result exists *because* a message arrived.
Both sides are persisted, so this is decidable from the log — walk back from each
`messages_consumed` to the turn boundary, and skip unrecognised event types rather than treating
them as boundaries.

**`yield`/`done` are the rule's best instance, not an exception to it.** Their results are written
*at wake*, by the very message being judged, so they are that message's CONSEQUENCE and not its
cause; an ordinary tool_result was already in flight before the message arrived, so it is prior
work. **The direction of causation is the rule; comparing tool names is only how it is detected** —
hence the predicate is `isPriorWork`, not `isPark`. This exception was predicted to disappear under
the new rule and instead **grew**: 1513 of 2161 newly-blocked messages were yield turns, and it is
the dominant shape for sub-agents, every one of which ends in `done()` and is later woken.

⭐ **The evidence was being sampled at the wrong instant, and that is the reusable finding.** The
first version tested for an unclosed tool_call at the message's **delivery** position. Real trace: a
message arrived 10 seconds BEFORE the tool_call it was meant to be blocked by — at that moment the
agent was composing the call, so nothing was outstanding — while a message arriving during the bash
run was correctly blocked. Both were consumed together. The earlier analysis had concluded honestly
that the log could not do better, because parking on `end_turn` writes no event and activity is
never persisted, so "parked, waiting for you" and "waiting for the model" leave the identical trace:
nothing. **That was accurate about the DELIVERY moment and irrelevant — consumption leaves a trace,
and consumption is what answers the question. Looking for evidence at the wrong instant is what made
the log look mute.**

**An accurate observation plus an over-broad generalisation is harder to challenge than a guess,
because it arrives with a number.** *"Root's last 2000 lines contain no yield/done, so this is
mainly a sub-agent problem"* — the observation was accurate and `tail -2000` reflects a recent
habit, not the session; the full log had 1513. **Check the sampling window on every figure,
including your own.**

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
was added.

## Every transport carries the event's name (eid)

**Four consumers wanted the same missing thing and were each about to grow their own locating
mechanism**: the Edit/Rewind gate, message deep-links, viewport addressing, and "is this event still
part of the conversation". They are one thing — **the frontend needs the persisted event identity on
the path it actually receives events over** — and it was missing because `emitEvent` used to
broadcast before persisting, so SSE clients were shown events they could not refer to.

**`LogEntry.id` is derived from the eid** via a map that is never cleared — clearing it IS the
failure it prevents. The log is replaced wholesale on every refetch, and a module counter made every
key change every time: measured as one MutationObserver batch with `added: 82, removed: 82` against
`removed: 1` for a normal update. Two entries exist BEFORE the event they are named after, and both
**bind** their eid to the id they already have rather than re-deriving it. **`key={entry.eid ??
entry.id}` is the wrong shape** even though it looks simpler: it moves the key at the end of every
streamed block, adding a per-block remount that does not exist today.

⭐ **Active-chain membership needs its own bit, and this is the general reason:**

> **eid is an IDENTITY — immutable, per event. Membership is a RELATION between an event and the
> current chain head.** A rewind changes it for a whole stretch of log without touching a single
> event in it. **An immutable identity cannot encode a mutable relation.**

So the raw-file fetch marks each event `offChain: "summarized" | "abandoned"`, built on the one
`walkActiveChainIndices`. **The client gets the ANSWER, never the algorithm** — a second chain walk
in the browser is exactly what the one-boundary work removed. Refusal wording followed the same
discipline: "No longer part of the conversation" was what the UI said when it could not tell, about
every message in the batch including ones still in it.

**A user message renders where it was CONSUMED, not where it arrived.** A message typed during a
tool call is delivered between the `tool_call` and its `tool_result` but consumed with that tool's
results, so in the log it appears **after the finished tool card**. Anything reasoning about a
message's position must use the raw event batch, not the rendered entries — judging run-start off
rendered entries calls exactly the blocked case a run start.

---
# Providers & API
---

## The server can do things it does not disclose, and only our own records catch it

**Twice now the API has behaved in a way that is invisible from inside a single response, and both
times the only detector was comparing what we SENT and STORED against what came back.** Both times
the first hypothesis was plausible and wrong.

### `response.model` cannot be trusted as ground truth

A session showed a 70K-token cache miss with no explanation. Bit-exact replay settled it: two
requests 9 minutes apart in one session were tokenized by two different tokenizers — the earlier
matched today's opus-4-6 exactly, the later matched opus-4-7 exactly, **+28.9% on identical
content**. Throughout, `response.model` kept reporting the declared model, and opus-4-7 was not GA
for another 12 days.

> **A client declaring model X may receive model Y's output with no disclosed indicator.** The
> tokenizer ratio is the most reliable post-hoc signal, and it is only visible at a cache-transition
> moment. Observable side effects: unexplained cache misses, and ~29% higher input-token counts for
> the same content.

**Forensic technique, model-agnostic: base64-decode a thinking block's `signature` — it embeds the
serving model name**, independently of `response.model`. That is how "8 of 8 silent turns were
served by a different model, 0 of 9,800 normal ones were" got established.

**Our JSONL survives format migrations but loses bit-fidelity against the code that wrote it.** The
first replay came out 10,515 tokens short because a later commit changed the shape of one event type
and a migration rewrote the old events, so the old walker dropped their content. **When you change a
persisted event shape, preserve a pre-migration snapshot** — reproducibility against historical
sessions depends on it.

### Connector text is summarized server-side, and the model still sees the original

**Scope: this is Fable-class behavior and Matrix has been on opus-class since. Treat the mechanism
as dormant rather than gone, and the techniques as permanently useful.**

Text emitted BETWEEN tool calls is summarized server-side and returned as a thinking block, with the
signature carrying the encrypted original — officially documented, **no customer opt-in or
opt-out**. It applies only AFTER a tool_result exists, and **a final assistant answer after all tool
use is UNAFFECTED**. It presents as `[thinking, thinking, tool_use]`, the second block being a
summary of what should have been the visible reply — so in the UI the user's reply vanishes into the
thinking fold. **Operational mitigation: an agent whose last action is a user-facing reply should
END ITS TURN rather than call `yield()`**, because replying and then yielding in the same turn makes
the reply *connector* text. `end_turn` is an implicit yield with identical pause semantics, so
nothing is lost.

> ⭐ **"Context = `messages[]`" is FALSE under this mechanism, and the model cannot detect the
> divergence from inside.** The model sees its own originals; the client and the user hold only
> server-rewritten summaries. **So an agent's memory of its own past replies is NOT evidence of what
> the user saw** — when verifying user-visible behavior, read the JSONL or a debug snapshot, never
> introspection. This is the most transferable thing here, and it applies to any divergence between
> what a model believes it emitted and what was persisted.

**The canary protocol proved it, and generalises**: put a unique token in visible text ONLY, have
the next turn record its recall inside a TOOL INPUT before any read, then grep the client-side
records — tool inputs are the only generation-time verbatim side channel, because they must be
executed as written. Run that way, the digits existed nowhere client-side and the next turn recalled
them verbatim. The first diagnosis had been SDK-version sniffing: plausible, matching the observed
block shape, wrong, and "verified" by one clean post-restart sample before recurring within the
hour. **A single passing sample is not verification when the phenomenon is intermittent by design.**

## The Anthropic message-shape rules, MEASURED

**`src/test-utils/api-message-rules.ts` is the authoritative list — read it there, not here.** It
carries each rule with the real 400 string it mirrors, plus `PROBED_SHAPES` (every shape we have
actually sent, with the day we sent it) and `UNPROBED` (what we assert but have never asked the
API).

⚠️ **Do not re-enumerate the rules here.** This section used to, opening "these four are the API's
actual rules" — and it was **five** within two days, with the fifth sitting in the very next
paragraph, added later and reading as an elaboration rather than as the refutation it was. Nobody
noticed, because a list and its correction do not look like a contradiction when they are adjacent
and politely worded.

⚠️ **"NOT rules" in that file means MEASURED LEGAL, not never-objected-to, and that distinction is
the whole bug.** From outside, a rule we never discovered and a shape we measured as legal read
identically. `[{type:"text", text:""}]` sat under "NOT rules" as legal for two days and is in fact a
400 in every position on either role. It is reachable: the walker rebuilds an empty `assistant_text`
as exactly that block, repair does not cover it, and while both emit sites guard on truthiness,
**whitespace-only passes truthiness** — so a model whose first streamed token is a newline,
interrupted right there, bricks the session on every later request.

**Consequence nothing else states: `buildUserTurn` packs `[...tool_results, ...queueMessages]` with
tool_results FIRST, and that order is a real API requirement rather than style.** Put text before a
tool_result, or between two batches of them, and you get a production 400 with a fully green suite.
Results split across several user messages are fine, in any order; `[R1, text]` then `[R2, …]` is a
400 because the trailing text ended the run.

⚠️ **Probing the real API: the `systemPreamble` trap.** Any probe against the OAuth endpoint must
send the auth group's `systemPreamble` as the FIRST system block, or every call 429s. A first-pass
probe that omitted it produced a wall of rate limits that reads exactly like validation failure and
nearly yielded the opposite conclusion.

## Prompt cache: what is frozen, what refreshes, and what breaks a prefix

A `session_config` event at the start of the JSONL holds the tools, `systemStable` and
`systemVariable` for the session, and it is **frozen between compactions**. That freeze IS the cache
strategy: on resume everything is read back from the stored config rather than recomputed, so the
prefix is byte-identical and hits.

⚠️ **The Anthropic prefix order is tools → system → messages, not system → tools → messages, so a
tools mismatch is a miss on the *entire* prefix.** This is why tools are frozen at all: MCP servers
connect asynchronously, so registration order is non-deterministic and an unfrozen tools array would
reshuffle itself between runs. Freezing them as a provider-agnostic `JsonTool` and emitting that
event from `runProviderLoop` **after** tools are ready — rather than from `agent-lifecycle`, where
it captured `tools: []` — is what took restart to a 99.8% cache hit and fork to 100%.

**Three cache breakpoints: tools, `systemVariable`, and the LAST user message.** Last, not
second-to-last: the last message sent is always a user message and Anthropic's 20-block lookback
caches everything before it, whereas the previous second-to-last strategy caused a full miss
whenever only one user message existed — exactly the post-compaction restart case.

⚠️ **Never add a per-request `anthropic-beta` header.** It overrides the client's `defaultHeaders`,
including the OAuth header, and silently breaks OAuth mode. Extended cache TTL is GA and needs no
beta header. Note also that `{type: "ephemeral"}` and `{type: "ephemeral", ttl: "1h"}` are
**different cache entries** — the TTL is part of prefix identity, which is why `cacheTtl` lives in
`session_config`, is inherited through fork, and is deliberately not refreshed at compaction.

**Known residual, low priority**: `addAssistantMessage` stores the raw API response content in the
SDK's key order while JSONL reconstruction uses our manual key order. They happen to agree today, so
within a session `messages[]` is consistent. If the SDK ever changes key order this breaks silently.

## The two providers

**There is ONE OpenAI provider: `OpenAIResponsesCompatibleProvider`.** The Chat Completions provider
and its 1624-line test were deleted; **do not go looking for a "Chat Completions path" to compare
against — there isn't one.** Both providers use the `openai` npm package, and
`ChatCompletionMessageToolCall` is a union, so filter on `tc.type === "function"`.

**Whether an agent can call a tool that is NOT in its frozen list is measured on Anthropic and has
never been measured on OpenAI — and this file stated both halves in one voice for four months.**
Keeping them apart is the point of the two paragraphs below: you should be able to tell which half
somebody checked without leaving the page.

**Anthropic — MEASURED 2026-07-29, `claude-opus-5`, `scripts/probe-hidden-tool.ts`.** The tools
array holds `get_weather` alone while the system prompt describes a hidden `send_email` in exactly
the shape matrix uses for `evaluate_script`; the model returns `tool_use(send_email)` with correct
arguments, twice. **Every run is preceded by its positive control** — same prompt, `send_email` IN
the array — because *"it did not call the hidden tool"* and *"it did not want to"* are byte-identical
output, and the control is not ceremony: on `claude-sonnet-4-6` it 400s, so that model's probe
concludes nothing. First observed 2026-04-05, when root called `create_folder` by name out of a
session frozen before that tool existed. ⚠️ **A hidden tool needs TWO properties, and the old
wording — *"the server dispatches any name to whatever handler exists"* — collapsed them into one
place that was not even the right one.** The API's half is the half measured above: the model can
generate a name the tools array does not contain. Matrix's half is `executeTool` looking that name
up in its own handler map, answering an unregistered one with an ordinary `Unknown tool: X` error
result; the server dispatches nothing, it returns a block. **Neither half suffices alone** — on a
provider that really did mask names our lookup would simply never be handed one. That misattribution
is this section's theme in miniature: it stood for four months because `executeTool` goes on looking
names up either way, and **code that keeps working cannot tell you somebody wrote its behaviour down
as the server's.**

**OpenAI — NOT measured, and the provenance is the part worth having.** *"Responses uses
schema-constrained sampling, masking the distribution to the supplied tool names"*, with the rider
that `strict: false` relaxes optional-field validation but not tool-name enforcement, arrived
2026-04-05 from THE USER, in conversation, phrased as a recollection (*"我记得"*), and reached this
file 103 minutes later as an absolute (*"physically cannot"*). **External knowledge we never
verified is a different thing from an invention** — it is worth the distinction, because it tells
you who to ask. Read but NOT measured, and pointing the other way: OpenAI's docs scope `strict` to
the ARGUMENTS matching the schema and say nothing about names, and OpenAI's own guidance suggests a
system message to stop models calling functions that were not provided — advice that presupposes it
happens.

⚠️ **2026-07-29 could not measure it either, and why is worth more than the failure: THE OPENAI
PROVIDER IS NOT IN USE.** We bootstrap on Anthropic and always have. Both stored OpenAI credentials
had expired — `~/.mxd/config.json`'s on 2026-04-10, `~/.codex/auth.json`'s on 2026-01-19 — and that
is the symptom rather than the cause; nothing refreshes them either (`void this.refreshToken`, draft
`01KYQJQC0Z3NQR51E8CPWNQQZA`). No traffic means no 400, no flake and no report, so **nothing we
believe about OpenAI has been able to be contradicted by reality for months.**

⭐ **Read that as an instruction, not a disclaimer: treat every OpenAI sentence in this file as
unchecked by default, and every Anthropic one as load-bearing until it isn't.** The two are written
in the same voice today and are not the same grade of evidence — the Anthropic claims get hit by
bootstrap traffic every day and fail loudly when wrong, while an OpenAI claim can only be wrong in
private. **Where this one lands: the design conclusion it carries — *refreshing tools at compaction
is correctness-critical on OpenAI and merely nice on Anthropic* — therefore rests on an unverified
asymmetry, about a provider nobody runs, that reality has no way to correct.** Keep the refresh; it
is right for the Anthropic reason measured above. Do not restate the asymmetry as `physically
cannot` again.

**Thinking events carry a `provider` field**, so switching providers automatically drops stale
thinking blocks on mismatch. The OpenAI walker ignores thinking entirely. `executeTool` validates
every built-in tool's input against its Zod schema at the boundary; external MCP tools have an empty
`inputSchema` and skip validation.

## The LLM facility — single-turn, no tools, no session

`src/llm.ts` wraps the existing provider adapters for plugins that need one-shot calls outside the
agent loop. **The one thing here that will bite someone: SDK client construction is DUPLICATED from
the provider class constructors.** Beta headers and timeout are hand-matched to
`AnthropicCompatibleProvider`, so **any change to beta headers must update BOTH the class
constructor AND `createAnthropicClient`** — nothing enforces it, and the failure would be OAuth
breaking for plugin calls only.

---
# Data Model & Storage
---

## Where a project's data lives, and why it is in two places

**`<repo>/.mxd/`** is tracked in the project's own repo: `config.json`, `memory.md`, `hooks/`, and
`plugin/` if the project ships one. **`~/.mxd/`** is daemon runtime state on this machine and is
never in git: global config, auth, the lock file, the web build cache, the project registry, and per
project a `config.json` plus a plugin-namespaced data root.

```
~/.mxd/projects/<projectId>/
├── config.json               (daemon-owned)
└── plugin/matrix/            (from the manifest's dataRoot: "@/plugin/matrix")
    ├── tree.json
    ├── tasks/<taskId>.jsonl  (one file per task, the complete conversation)
    └── debug/<taskId>/<traceId>/last.json
```

**`tree.json` is deliberately NOT in the repo.** The tree mutates constantly and committing it would
pollute history. The plugin namespace exists so a second plugin's data parks beside matrix's rather
than colliding at the top level, which completes the "matrix is just a plugin" framing. Config
merges in three layers: global < repo < local.

**`src/data-paths.ts` is the ONE place that resolves a path from `dataRoot`.** Never apply a string
operation to a `dataRoot` anywhere else — **any** spelling, not just `.slice(2)`; a grep test walks
the whole repo and fails if a second site appears, with one named allowlist entry. Three lines of
defence, and each is there because the previous one might be relaxed: a strict regex at the input
boundary, one resolver so a fix touches one file, and a post-resolve invariant that the result is
still inside the project root. ⚠️ **Keep the third even though the regex already rejects traversal**
— `resolveDataRoot("@/../etc")` used to return `dataDir/etc`, which is a cross-plugin attack.

**A malformed manifest is FATAL at startup, not a warning.** Import errors are recoverable (skip the
plugin); validation errors are not. A malicious plugin declaring `dataRoot: "@/../etc"` must not be
silently skipped while its legitimate siblings run.

**Directory creation is lazy and happens at the owning plugin's data root** — the daemon used to
eagerly mkdir `projects/<id>/tasks`, which hardcoded matrix's layout. `tracker.save()` writes a temp
sibling then renames, because POSIX rename is atomic and a crash mid-write must leave the old
`tree.json` intact rather than truncated.

## The node model: TaskNode | GeneralNode

Runtime exposes exactly two node kinds, discriminated by a **required** `type: string` with no
`undefined` fallback. **TaskNode** (`type: "task"`) is launchable: session, git branch, lifecycle.
**GeneralNode** (any other string) is pure metadata plus tree position. **Matrix uses `"folder"` as
its only flavour, and "folder" is a matrix convention rather than a runtime kind** — which is why
`isFolder` is plugin-local while `isTask`/`isGeneral` are runtime exports, why there is no
`FolderNode` type, and why the folder MCP tools are sugar over one general-node API.

**Folders must stay at ZERO behavior, forever.** Persistent tasks started as "just a flag" and grew
into a disaster; this is the same shape. Every lifecycle operation rejects folders at its entry
point.

`status` and `metadata` live on **`BaseTaskNode`**, not on matrix's `TaskNode` — `status` is
genuinely runtime-generic, and `metadata` is opaque: the runtime never reads it, only round-trips
it. **`tracker.setMetadata` REPLACES the whole object; it does not merge**, and the REST write path
is the same — `PATCH` with `metadata` absent leaves it untouched, but `PATCH` with an object
omitting a key makes that key DISAPPEAR. Deliberately **no** `metadata` param on MCP
`create_task`/`update_task`: the only consumer is a plugin's REST UI, and an agent-facing
opaque-metadata param is an imagined need.

**`parentId` and task ownership are different questions, and 56 call sites had to be sorted into the
two.** `parentId` is tree structure — UI, reparent, delete. `getTaskAbove()` / `getTasksBelow()` are
task ownership — message routing, worktree branching, `task_complete` delivery — and **folders are
transparent to ownership.** The one bug this audit found: a REST reorder endpoint used `getTask()`
where it needed `get()`, because folders have children too.

**`JSON.stringify(TaskNode)` must NEVER include `session`** — it holds `messages[]`, `allTools`, the
queue and an AbortController. Use `stripSession`. The failure is spectacular rather than subtle: a
forked task with 700K tokens in `messages[]` updated its own description, produced a **2.95MB
tool_result**, and doubled its own context from 735K to 1.75M until the API rejected it.

Three smaller facts: `load()` throws on a node with a missing `type`, so a typeless node means
corrupted `tree.json` rather than "legacy data" to be tolerated; **use the POSITIVE type guard when
destructuring after a guard** (`if (!isTask(node)) return node;`), because the negative narrowing
collapses `TaskNode` to `never` once shared fields move up; and `DEFAULT_CONFIG` is `Object.freeze`d
at module load, because a PATCH handler that mutates a module-level constant poisons every later
reader in the process.

**Two hooks, two moments**: `seedTree` runs once, only when a project's tree is first created, and
is the worker-side complement to the daemon-side `onProjectInit` (which can create FILES but has no
tracker, so it cannot create initial NODES). `onScopeResume` runs on every startup.

## The REST boundary must reuse the shared op, not re-implement it

> **A REST route that touches a task lifecycle resource — session, JSONL, worktree, config — MUST
> route through the same shared op the MCP path uses, or replicate its guard exactly. Where they
> drift, the REST side silently re-introduces a solved bug.**

That rule came from five bugs found together, all of them silent data loss rather than a crash:

**`c.json` does NOT throw on a live `session`.** SSE's `structuredClone` is *forced* to strip it, so
the SSE path was safe by accident while every REST route returning a node serialized the whole
queue, conversation and AbortController over the wire. One `serializeNode` helper now wraps every
node response. **The lesson is that one transport's safety came from a constraint the other
transport did not have.**

**Worktree removal must use the STORED path and branch, never a re-slugified title.** Close, reset
and delete used `slugify(node.title)`; a title can change after creation, so re-slugifying computes
a different path and the real worktree is orphaned forever.

⚠️ **A config write must never be able to wipe credentials**, and it took three fixes because there
were three doors: `PATCH /config/global` rejects null for any top-level field (global config is a
COMPLETE config, so `delete next[k]` wrote an incomplete one); `createDaemon` RETHROWS a load
failure instead of falling back to `{...DEFAULT_CONFIG}`, because the silent fallback booted with
empty `authGroups` and the next save overwrote the on-disk credentials with nothing; and
`loadGlobalConfig` distinguishes ENOENT (fresh install → defaults) from a read error or invalid JSON
(throw), because the old single catch returned defaults for a CORRUPT file too.

**`delete_task` must stop and await the running loop before cleanup.** It did neither what close
does (reject `in_progress`) nor what reset does (await loop exit) — it removed the worktree under a
live process, destroying unmerged work, and a pending `done()` then read `getTask() === undefined`
in Phase 2 and hung the parent forever. Semantic chosen: reset-style, not close-style.

⭐ **The same principle one layer out, and it is the one rule in this file with three independent
sets of evidence: a rule enforced at N of M doors is enforced nowhere**, because the others accept
the same payload — and the door nobody remembers is reliably the second one. Here a message reaches
the runtime through **`POST …/message`** and **`POST …/edit`**; both take `images`, and `/clarify`
does NOT and is not one of them. Both answer a text-less message with the same sentence asserted
against ONE constant, so changing either wording alone reddens. **Test both doors in one file
against one app, and "I closed the door" can no longer quietly mean "I closed a door".** The other
two instances are a search-hit vocabulary shared by three renderers, and the composer's four
text-required gates — both under their own sections, and both found the same way: by asking *how
many places accept this payload*, never by reading the one place you were already editing.

Same family, different layer — lifecycle guards that were simply missing: the **root node** cannot
be deleted, closed or reset; `updateTaskOp` rejects `status: "closed"` and `"failed"`, because both
are terminal states needing cleanup that a plain PATCH bypasses; and REST `/message` and `/clarify`
canonicalize a task-id prefix, validate the node is a task rather than a folder, and reject `draft`
the way MCP `send_message` always did.

## Images

`getImageDimensions` parses PNG/JPEG headers, and `read_file` rejects anything over 8000px per
dimension before it reaches a provider. Byte size is a provider-level concern (`validateImage?` on
`ProviderAdapter`): Anthropic 5MB decoded, OpenAI 20MB.

---
# Memory Index & Search
---

## The search index — `src/task-index.ts`

**The tree accumulates decisions faster than anyone can remember them, so the index exists to make
"has this been solved before" answerable instead of re-derived.** It indexes every task's **title**,
**description** and **each done() round's result** at per-field, per-round granularity: one document
per (task, field, round), so every hit traces to an exact location and removal is targeted rather
than a scan.

Orama (pure TS, no native deps) with the Mandarin tokenizer and EmbeddingGemma-300M embeddings, in
`mode: "hybrid"` — BM25 and cosine fused in one query, cross-lingual in practice ("fix session
recovery" ↔ "修复会话恢复" scores 0.81). If the model fails to load it degrades to pure BM25, so the
daemon is never blocked on a model download. Orama scores are **higher = better**; the previous FTS5
engine was lower = better, so any comparison or threshold carried over from that era is backwards.

**Why the engine lives in `src/` and not in the plugin.** The red line is not "index code must sit
in `.mxd/plugin/`" — `src/` is the neutral building-block layer. The real invariant is that
**`src/runtime/*`, `runtime.ts` and `provider-shared.ts` contain ZERO occurrences of index / search
/ resultRounds, including in comments.** The layout was then forced: `search_tasks` needs
`availability: "both"`, the external-MCP list is built from `buildAllToolDefs` in
`orchestrator-tools.ts`, that is in `src/`, and `src/` may not import `.mxd/plugin/`. Likewise
`onScopeResume` is named by EVENT, not by resource — that is what keeps the boundary grep clean.

The engine is pure-TS because `bun:sqlite` cannot `loadExtension`, which killed the sqlite-vec plan
(one line to re-check on a Bun upgrade). The FTS5 index that preceded Orama worked correctly; it was
replaced for the vector story, not because it was broken.

### Staleness is a per-document content hash, and `updatedAt` was why boots got slower over time

⚠️ **Do not key staleness on `node.updatedAt`.** `task-tracker.ts` writes it in **16 places and only
3 touch a field the index stores.** A status transition, a cost update, or merely CREATING A CHILD —
which bumps the **parent** — all marked a task stale. Two consequences explain the failure's shape:
**the backlog grew with ACTIVITY rather than with content change, and it was only paid at boot, so
the longer the daemon stayed up the more expensive starting it became.** A full backfill took 4m13s
against a 30s worker-init budget, and the daemon was unbootable for hours.

Staleness is now `sha256(v1 | model | dtype | text)` **per document**. Per-document is not a detail:
a whole-task hash re-embeds every result round because one word of the title changed, and the root
task has dozens of rounds. Model identity is inside the hash, which prevents **mixing two vector
spaces in one index — a state that does not fail, but returns plausible wrong answers.**

⚠️ **The second staleness clause is one-directional on purpose.** A document is stale if the hash
differs, OR if it is stored without a real embedding **and embeddings are now available**. Without
that second clause the failure is permanent and silent: one offline first boot writes zero vectors,
the content hash calls them current forever, and the index serves keyword-only results with nothing
reporting it. The reverse — embedded document, embeddings now disabled — is deliberately NOT stale,
so turning embeddings off can never destroy vectors that already exist.

⚠️ **Migration treats "no hash" as UNKNOWN, not as stale.** An old sidecar has a flat id list, and
calling that stale would make **deploying this fix trigger the exact backfill it exists to
prevent**, on every machine, on the next boot. The plan instead ADOPTS the current content's hash
for documents the legacy entry already lists — strictly no worse than what it replaces, because
assuming those are current is precisely the claim the old sidecar was already making.

⭐ **The DB is persisted BEFORE the sidecar that claims it. Never the reverse.** Sidecar-first turns
any failed `.msp` write into a silent permanent hole, because the sidecar says "indexed" and nothing
ever revisits it. In the correct order every failure lands on "the sidecar is behind", which the
next plan repairs — **and that is the whole reason an index write is safe to treat as
loud-but-non-fatal.** Renaming a task must not fail because search could not be written, and that
trade is only honest because the failure is recoverable. **The invariant then bites you on the
repair path**: because the sidecar can legitimately under-report the DB, the repair pass plans an
`insert` for a document that is already there, and Orama's `insert` THROWS on a duplicate id — so
the very failure the ordering exists to make recoverable would throw on the pass that recovers it.
Remove before *every* insert.

⚠️ **`onScopeResume` awaits the PLAN and nothing else, and the rule is categorical: anything that
touches the `.msp` or the model is deferred — NOT "anything expensive."** `planIndex()` is pure and
measured at 12ms for 1115 documents; `applyIndexPlan()` loads the 21MB index, lazily loads the
model, and runs on a module-level **serialized** background chain so seven projects cannot backfill
concurrently. **A cheapness judgement is something a future change gets wrong silently; a
categorical rule can only be violated deliberately.** This matters because the worker's `ready`
waits on autoResume, which awaits `onScopeResume`, and terminating the worker at that timeout is
what took the daemon down.

**Negative result, with its dependency, so it can be re-checked rather than inherited: do NOT batch
embeddings across projects.** The expensive part — the model load — is *already* shared, because the
pipeline is a module-level singleton and all projects live in one worker. Simulated on the real
7-project tree: merging the small projects would save ~1-3s out of a 909s rebuild while coupling the
projects and breaking the clean per-project plan/apply split. **An optimisation for a case your fix
eliminates is dead code that looks like foresight** — ask when the case occurs *after* the change,
not before. This inverts completely if the pipeline ever stops being a per-process singleton.

**Batching is length-sorted, and the sort is most of the win**, because a batch costs count × its
longest member: on the real tree, tree order pads 1.49M chars to 4.74M char-equivalents while
length-sorted pads to 1.58M.

**SYMPTOM, known and unfixed: the index is case-sensitive.** `"Uppercase Widget Title"` is found by
`Widget` and **not** by `widget` — the mandarin tokenizer does not lowercase. Fixing it re-tokenizes
every stored document.

### ⚠️ Choosing an embedding device: `auto` is the obvious answer and it silently corrupts the index

On darwin, transformers.js resolves `device: "auto"` to CoreML first — and **CoreML returns a
768-dim vector of NaN, L2 norm 0, for most inputs. Nothing raises.** The NaN-score guard then
quietly redoes every query as pure BM25, **so the product keeps working with semantic search deleted
and no error anywhere.** `auto` is also 7.4× slower than CPU.

**The failure is deterministic per input and NOT monotonic in length**, and this table is the
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

**Non-monotonic forecloses the workarounds, which is why "we don't know why" is a complete result
rather than an unfinished investigation.** A length threshold would invite chunking, capping, or
probing at the boundary — any of which could be made to look like it works. With no cheap input
property that predicts the verdict, rejecting the device is the only sound response. **Negative
results on the CoreML knobs, so nobody spends the afternoon again**: `mlComputeUnits: CPUOnly` /
`CPUAndGPU`, `modelFormat: MLProgram`, and `allowLowPrecisionAccumulationOnGPU: "0"` — **every one
still NaN.** (`coreml` + `dtype: "fp16"` IS clean, because there is nothing left to convert — and it
changes no decision, since fp16 doubles the weights and **`webgpu` + `fp16` does not even load.**)

> ⭐ **webgpu is chosen for CPU CONTENTION, not for wall-clock — and on the real corpus it is 30%
> SLOWER in wall-clock.** Full rebuild of 1115 documents: **cpu 697s wall / 3044s CPU; webgpu 909s
> wall / 38.8s CPU.** 3044s of CPU is 4.4 cores saturated for twelve minutes next to live agents,
> because the backfill runs alongside them. 38.8s is invisible. **Anyone "optimising" this back to
> wall-clock will pick cpu and starve the machine.**

⚠️ **Do not log the REQUESTED device.** It prints "coreml" just as confidently while emitting NaN.
Log what was *proven*. And note **"webgpu vs coreml" is not "GPU vs not-GPU"** — both reach the same
Metal GPU; CoreML's extra reach is the ANE. **There is no MPS execution provider in ONNX Runtime**
(that is a PyTorch concept), verified from the installed library rather than recalled.

**`MXD_DISABLE_EMBEDDINGS` exists because of a process-killing NAPI bug, not for speed** — see *An
ORT session dies with the thread it lives on*. It must be passed to workers via the Worker
constructor's `env` option; a `bunfig.toml [test.env]` entry does NOT reach a Worker.

## Retrieval that nobody acts on ⇒ guidance goes where the DECISION is

Three surfaces inject prior art: `work_context`'s `[Related past tasks]`, `create_task`'s `[Related
existing tasks]`, and `search_tasks`' tiered output. All three worked and produced real hits. **None
of them said what to do with a hit, so the block read as a return value: scanned, then dropped.
Root's count for one day: `create_task` called 8 times, block returned 8 times, behaviour changed 0
times, `search_tasks` called 0 times.**

> ⭐ **Put the guidance where the decision is made. If the agent ASKED for the data, the tool
> description reaches it in time — it still holds the intent it called with. If the data arrives
> UNREQUESTED, only the payload reaches it.**

⚠️ **The bash "don't pipe" precedent does NOT transfer**: that decision is made while CONSTRUCTING
the call, so the description is its decision moment. A description read before the call is guidance
about something that does not yet exist in the agent's world. **Matrix-specific tiebreaker, worth
knowing on its own: tool descriptions are frozen in `session_config` until a compaction refreshes
them, so a description change does not reach a running agent. Handler output reaches everyone on the
next call.** For a fix motivated by "this failed today", that is decisive.

**The two block headers are different sentences on purpose**, because the readers can do different
things. `create_task`'s reader is ROUTING — it just made a task and is deciding where the work
should live. `work_context`'s reader is already ASSIGNED the work and is deciding how to do it: read
before re-deriving, and if a hit already tried the approach it is about to take, **surface that
upward** rather than obeying or ignoring it. Three capability facts were verified rather than
assumed: a working agent **cannot** `send_message` the task it found, it **can** update its own
description, and it **can** `fork_task_context` only into a sub task it creates — so forking is a
dispatch move rather than a use-this-knowledge move.

**"Latest result" is the LAST round, and the last round is often trivial.** This single fact makes
an excerpt block structurally unable to answer anything: a real hit had 3 rounds, round 0 was the
whole implementation, rounds 1-2 were CSS tweaks, so the block advertised the task as *"Restyled
search hits as card-style items"* and everything worth reading was invisible. That is the shape of
any task reawakened for follow-up, i.e. most closed tasks of any size. Hence the ordering inside the
header: **the "these are excerpts and cannot tell you what a task concluded" reframe comes FIRST**,
so the hits are read as an index — put it after the hits and the agent has already formed a
judgement.

**The reading rule that prevents a NEW error**: a past round is *a measurement plus a judgement made
at the time*. The measurement usually still holds; the judgement may already be void — **and a new
task on the subject is often itself the evidence that intent changed.** An agent that reads "we
tried this and reverted" as a prohibition abandons a road it is currently supposed to walk.

⚠️ **An instruction you cannot execute is decoration.** Both fixes here are only worth doing BECAUSE
the header now says "get_task these": the block prints the **full taskId** rather than a truncated
one (12 chars resolves, an ellipsis does not), and dead hits are dropped rather than rendered with a
real-looking but unresolvable id.

**Root's stated evidence did not support root's conclusion; a different fact did.** The argument
offered was "I read the tool description and still dropped the block" — but that description had
never mentioned the block, so it is evidence that an unexplained block does not self-explain, not
evidence about description-placed guidance. **Check that a conclusion's stated reason is the one
actually carrying it, especially when you already agree with the conclusion.**

## Every hit says what it IS before its body is read

*Retrieval that nobody acts on* made the blocks say what to DO with a hit. This one makes each hit
say what it is — status, both dates, and for a terminal task whether it ever actually ran. All three
surfaces share the vocabulary in `src/search-hit-format.ts` — the N-of-M-doors rule from *The REST
boundary must reuse the shared op*, in its second medium: the third renderer goes on handing out the
old shape to a reader who cannot tell which renderer produced it.

**Status LEADS the line now.** It was always rendered, at the END of the first line, where a long
title pushes it to the right margin and the next thing the eye meets is a 300-char `Description:`
that reads like a conclusion. Measured cost of that placement: a `draft` whose description held a
real measurement AND a never-executed proposal, separated from a finished task by four characters at
the far right of the line.

**`updatedAt` renders as `record touched`, never as "last active", and the LABEL is the whole fix**
— the field was always renderable. It is written in 16 places and 3 of them touch content, so
labelled as activity it shows an April task as worked-on today, which is worse than having no date:
an authoritative-looking wrong number. `createdAt` is always beside it because it cannot drift, and
both carry a relative age, which is load-bearing rather than decorative — **agents are date-blind
and confident about it**, so an absolute date alone re-runs the failure the date was added to fix.

⭐ **"Did it ever execute" is the UNION of three signals, not a choice among them — and it is the one
thing here someone will try to simplify.** Each is one-directional POSITIVE evidence: a session
file, a recorded cost and a reported round can only exist if the task ran. So OR-ing them cannot
produce a false "ran", while every single member produces false "never ran"s.

| signal | really answers | its blind spot |
|---|---|---|
| `resultRounds` | did it REPORT? | postdates most of the tree — **365 of the 417 closed tasks that had run carried no round** |
| `costUsd > 0` | did it SPEND? | one closed task had a session and no cost: launched, died before any usage landed |
| session JSONL | did it ever HAVE a session? | one closed task had a cost and no file — a session can be cleared by hand or by `reset_task` |

`resultRounds` is the member that looks right, being literally "it finished and reported", and alone
it would have relabelled **88% of this repo's executed history as an unexecuted proposal** — the
worst answer available, because it is precisely backwards about what the description means. `branch`
/ `worktreePath` cannot be used at all — close nulls them. The marker is rendered on `closed` and
`failed` only: while a status is live the question is still open.

⚠️ **Dedup runs BEFORE the full/brief tier split, not after.** A real `search_tasks(limit 6)`: three
tasks filled all six slots, one appearing once as a full entry and once as a brief one with its
entire `Description:` repeated verbatim. Merge the duplicates' field labels into the survivor rather
than dropping them — matching on two fields is relevance evidence, and it is the only thing the
discarded hits carried.

**Dedup is unconditional, and the objection against that is worth keeping because it is a good
one.** `search_tasks` advertises "the best-matching LOCATIONS … WHICH field matched, the round
index", so two hits inside one task ARE two answers there, and collapsing them reads as a regression
against the tool's own promise. It is not, **because the locations survive**: merging keeps every
label, round indices included, so every place inside the task that matched is still named. What
dedup drops is a second copy of the same 500-char description and a second score, neither of which
was ever a location.

**The probe that produced that table was broken on its first run**, reporting "session JSONL exists"
as false for all 551 tasks — and believed, it would have "proved" the JSONL signal useless and
handed the decision to `resultRounds`, i.e. to the 88% error above. It now asserts its own premise
before it reports anything. See *Your instrument is a claim until you have made it fail*.

---
# Daemon, Worker & Transport
---

## Durability at the process boundaries

**`shutdown()` order is fixed**: stop every running project's agent, then await residual loop
promises (bounded 1s), then flush every EventStore. `stopAgent` awaits loop settlement with the same
bound, symmetric with `stopTask` — that closes the race between `POST /stop` returning and the
`finally` block's `agent_end` / `done_notified` / MCP-disconnect writes, and it is what stops
`DELETE /projects` → `rm -rf` racing in-flight writes.

⚠️ **Do NOT call `fg.resolve()` in `stopAgent`.** It looks like the tidy way to deal with a
foreground bash that is ignoring abort, and it moves the command cleanly to background — which
**breaks the orphan-repair semantic.** A stuck tool is supposed to get bounded grace and then be
left as an orphan, so repair synthesizes the interrupted tool_result on the next launch.

**The 1s bound was tuned under a single-run assumption and is now a known flake source.** Normal
load today is 3-4 sub-agents each running the full suite plus root running it too. **Triage
shortcut: the suite's own total run time is a load probe** — 300.8s on the failing run against
267-269s on passing ones. Check that before suspecting your diff. Open question: whether 1s still
holds under parallel load (`01KYCMVKN14RRX0KK0H2CNTD9P`).

**Worker init has a 30s timeout.** Without it a plugin whose `runtime.ts` hangs at top level hangs
daemon boot forever — no log, no 503. ⚠️ **A `beforeAll` that calls `createDaemon` with a worker
must budget ≥ that**, or on a real flake the test's own timer fires first and you get a useless
"beforeAll timed out", **masking the daemon's much better "Worker init timed out: <plugin>" message
that names the actual stuck plugin.** `createDaemon` costs ~213ms cold and ~346ms under heavy
contention, so 30s has 100×+ headroom; a 15s budget had >40× and still flaked. **Do not try to fit
it under 15s "to fail fast" — fast is meaningless when it fails on the wrong timer.**

**`.mxd.lock`** at the dataDir root is acquired with `O_EXCL` and holds `{pid, startedAt, version}`;
a stale lock whose PID is dead is stolen, a live PID errors out. It is opt-in, because tests run
concurrent daemons on isolated tempdirs. It refuses even when the lock holds our own PID — a second
`createDaemon` in one process is a test bug, and surfacing it beats tolerating it.

## ⚠️ An ORT session dies with the thread it lives on — so it gets its own process

**FIXED 2026-07-25.** The embedding session now lives in a child process. Worker threads never load
ORT. Keep it that way; the rest of this section is why, and what it cost to find out.

Measured one variable at a time:

| where the session lives | thread ends by | result |
|---|---|---|
| worker thread, NO session (import only) | parent `terminate()` | **exit 0** |
| worker thread | parent `terminate()`, device `cpu` | **exit 133** |
| worker thread | worker's own `process.exit(0)` | **exit 133** |
| worker thread, `dispose()` first | parent `terminate()` | **exit 133** |
| **MAIN thread** | **`process.exit(0)`** | **exit 0** |

**The trigger is not `terminate()`, not the device, and not skipping `dispose()` — it is an ORT
InferenceSession existing in a thread that is ENDING.** The last row is the whole fix: a process's
main thread only ends when the process ends. **Upgrading does not help — measured, do not
re-litigate**: `onnxruntime-node` 1.24.3 → 1.27.0 still exits 133.

**What it cost before the fix.** 13 of the last 20 process deaths carried this exact panic, at
uptimes up to 18.4h — **as far as that log went back, this daemon had never once exited cleanly.**
Three consequences, and the third is the expensive one: `releaseDataDirLock()` is sequenced after
worker teardown so it had never run; **exit 133 is indistinguishable from a real crash to launchd
and to a human**, which is why 13 of them went unremarked; and it converted a slow startup into an
unbootable machine, because init exceeded the 30s budget → daemon terminated the worker → the worker
held a session → a recoverable "one plugin failed to load" became a hard failure. **This is what the
"segfault" in the index bug report actually was.**

**Why a child process and not the alternatives.** Main-thread inference is crash-safe by the table
above but blocks the HTTP shell that the worker architecture exists to protect. The WASM backend
avoids NAPI entirely, but transformers' node build has no `wasm` device and its web build assumes
browser semantics. "Never terminate a worker holding a session" trades a native abort for a leaked
thread and disables worker restart — the daemon's own crash-recovery mechanism — exactly when a
plugin is misbehaving. **Cost of the fix is small and partly negative**: spawn + model load 939ms
once, ~4ms of IPC per query, and the parent now burns 0.02s of user CPU for work that used to run on
the thread next to the agent loop.

**Lifecycle is inherited, not managed.** When the spawning thread goes away Bun closes the IPC
channel and `disconnect` fires in the child, which exits — one mechanism covering worker terminate,
worker restart and daemon shutdown, with no bookkeeping and no leaked 500MB process per restart.
Deleting that handler is the quiet way to reintroduce a leak.

⚠️ **The regression that would silently undo this is one line: a static `import … from
"@huggingface/transformers"` in any module a worker loads.** Everything keeps working until the next
shutdown, which is exactly how this sat unexamined for two days. A test greps three files for that
shape.

## The self-bootstrap death chain, and the five worker-lifecycle bugs that formed it

Agent commits bad code → daemon restarts → worker crashes → **permanent hang plus a held lock.**
Five bugs in `daemon.ts` chained into that, and each is worth knowing because **the failure is
always "nothing happens" rather than an error**:

- **`worker.onerror` must reject the init promise.** It cleared the init timer and then did nothing;
  Bun fires `onerror` *and* terminates the worker, so with the timer cleared and no reject, the
  start promise hung forever with no timeout left to save it.
- **`shutdown()` must tolerate dead workers.** `postMessage` throws on a terminated Bun Worker, and
  that throw skipped every remaining worker **and** `releaseDataDirLock` — which is where the held
  lock came from.
- A `{type:"error"}` message from the worker must also `terminate()` it; restart timers must be
  tracked and cleared on shutdown, or they fire *after* the lock is released and spawn zombies; and
  dead workers must be deleted from the `workers` map on all three failure paths.

**Triggering `onerror` during init in a test is not obvious**: use a plugin runtime with
`setTimeout(() => { throw … }, 0)` plus a short await. The two approaches that seem simpler both
fail — **`process.exit(1)` does NOT fire `onerror`** (silent death, only the timeout catches it),
and a module-level `throw` is caught by scope-worker's own try/catch and becomes `{type:"error"}`
instead.

⚠️ **STANDING RULE, and the death chain above is the argument for it: never delete the external
boot path.** The catastrophic form of self-bootstrapping is not a crash — it is breaking the file
editing, command execution or daemon startup that you would need IN ORDER TO FIX IT, which is a
compiler emitting a broken compiler when the broken one is the only one you have. So matrix must
stay rebuildable and startable from outside itself: a plain shell, a bare `bun test`, a `git`
checkout, the CLI on `$PATH`. Rust keeps mrustc for exactly this reason. **The low frequency IS
the hazard** — an external path that looks unused is what a cleanup deletes with nobody objecting,
and the day it is missed is the day nothing can reach the code to put it back.

## Two transport bugs that corrupt silently

⚠️ **`response.text()` on a proxied response destroys binary data.** It decodes as UTF-8, so **every
byte above 0x7F becomes U+FFFD** — a 256-byte binary payload inflates to 512 and a PNG header
becomes garbage. Fixed with `arrayBuffer()` plus a transferable postMessage. Request bodies are
*not* affected today only because they are JSON in practice; a binary request body needs the same
fix.

⚠️ **Bun Workers do NOT inherit `process.env` assignments from the parent thread.** They get their
env from the OS process snapshot at spawn time, so `process.env.X = "Y"` in the main thread — and
therefore `bunfig.toml [test.env]` — is **invisible** to a file-based Worker. The only way through
is the `env` option on the Worker constructor. Verified empirically, including the confusing part:
**data-URL workers DO inherit it**, so a minimal repro can "prove" the opposite of production.

## SSE catch-up must survive a restart: epoch-prefix every event id

**Symptom: after a daemon restart, an open page stays blank until F5.** Per-lens seq counters
restart at 0 on every boot. There was already a guard for a pre-restart cursor *beyond* the new
tail, but not for one falling *inside* the new incarnation's refilled range — and after a real
restart agents auto-resume and stream, so the buffer refills past the browser's low cursor before it
reconnects. Catch-up was then marked done and the full initial state never sent.

Every SSE `id:` is now `<epoch>-<seq>`, minted once per `createDaemon`, and catch-up runs **only**
when the cursor's epoch matches. **Both `id:` emit sites must use the formatter** — the live relay
and the catch-up replay — since one bare-seq emit poisons the client's NEXT reconnect cursor. The
client needs zero changes: EventSource echoes `Last-Event-ID` opaquely.

Two adjacent restart-window holes closed with it. ⚠️ **There is ONE `worker.onmessage`, installed
before init**: the old code swapped in the runtime handler after `ready`, but **the worker posts
`sse_event`s DURING init** (autoResume crash recovery runs with `onBroadcast` already wired), so
those were dropped silently — harmless on first boot, but on a worker auto-restart the SSE clients
are still connected daemon-side and miss every recovery event. And **`/events` initial state polls
for worker readiness for 3s, deliberately not the spec's 2s**, because the restart backoff is 2s and
expires exactly as the restarted worker *begins* init, so a 2s poll guarantees a miss for early-gap
clients.

---
# Plugin System
---

## What a plugin is, and the boundaries that keep it one

A plugin is `.mxd/plugin/`: a manifest, a worker-side `runtime.ts` supplying `ScopeOpts`, and a
`web/` React component the shell lazy-loads. **Matrix is one of these and is discovered by the same
scan as any other — that constraint is the only thing keeping the runtime honest**, and it is
checkable:

- `src/` has **ZERO** production imports from `.mxd/plugin/`. Delete the plugin and the shell still
  compiles. (Test files may import it.)
- Plugin web has **ZERO** imports from `../../../src/`; it reaches shared code through importmap
  aliases.
- The runtime **throws** if `buildScopeOpts` is not provided. No silent fallback to a built-in
  matrix scope — that fallback existed and was deleted.
- `src/runtime/*`, `runtime.ts` and `provider-shared.ts` mention no matrix concept, including in
  comments.

**The hook list is deliberately not reproduced here.** It lives in `src/runtime/context.ts`, it has
grown several times, and two hooks have changed arity — a copy here would go stale silently because
there is no compiler between the two. What the type signature cannot tell you: **hooks are named by
EVENT, never by resource.** `onTaskDelete`, not `removeWorkspace` — the latter presupposes that
tasks HAVE workspaces, which is a plugin-specific assumption the runtime must not encode. Prose
comments may say "workspace"; hook NAMES may not.

**CAVEAT on "the runtime is generic": only the hook INTERFACES are.** The concrete `TaskTracker`
still stores matrix's `TaskNode | GeneralNode` directly and is not generic over `BaseTaskNode`, so
that claim is aspirational for the tracker.

## `/api/<plugin>/*` — explicit URLs, no hidden rewriting

Plugin-owned routes live under `/api/<plugin-name>/*` on the wire; the daemon strips the prefix and
the worker serves its routes as if at root. `pluginApiPrefix(name)` is the single source, imported
by the daemon router, the CLI, the plugin's URL builders and `web/runtime-types.ts`, so a format
change propagates atomically across all four.

**The `app.all("*")` catch-all was REMOVED, and that is the point of the change.** An unprefixed
plugin path now 404s instead of silently falling back to "the first global worker" — which is why
`/version` and `/stats` needed explicit daemon-level forwarders: they had only ever been served by
that catch-all. External MCP clients configured against the old `/mcp` URL break, deliberately and
with no deprecation alias.

⚠️ **`pluginApiPrefix` lives in `src/plugin-url.ts`, which has ZERO imports, and it must stay that
way.** `web/runtime-types.ts` re-exports it to browser code; when it lived in `plugin.ts` it dragged
in `data-paths.ts` → `node:path`, and Bun's browser target polyfilled the entire module into every
plugin's first-load bundle: **10,293 bytes → 281 bytes when it was split out.** A test asserts the
shared module stays under 500 bytes, so any future server-only import that creeps into that graph
fails loudly rather than quietly costing 10KB on first paint.

**Rejected alternatives, so nobody re-proposes them**: a shell `authFetch` wrapper would need a
daemon-route passthrough list, coupling the shell to the daemon's internal routing table; and
plugin-via-props data flow is cleaner long-term but was 100+ LOC of scope creep.

## Additive dual lenses — a project is served by its own plugin AND by matrix

A project that ships its own `.mxd/plugin/` is served by **both** its own scope and the global
matrix scope, on separate per-scope data roots. `matrix:<id>` is the dev lens; `<own>:<id>` is the
product lens. Shipping a plugin **ADDS** a lens and never removes the matrix one.

⭐ **The first implementation made ownership EXCLUSIVE (`own ?? global`) and was reverted. Do not
re-derive it.** Four reasons, and the first is decisive:

1. **`<scope>:<project>` is a TWO-PART address, and its existence proves the relationship is dual.**
   If a project mapped to one scope the prefix would be redundant.
2. The design was always "parallel run loops — alongside, NOT override".
3. Self-bootstrap requires coexistence: matrix is its own product, and "the product is a dev tool"
   only holds if a project opens in both lenses at once.
4. Per-plugin `dataRoot` was built for exactly this and is wasted under exclusive.

**If any routing decision tempts you toward "a project belongs to ONE plugin", that is this bug
returning.** Consequences that follow and would otherwise look arbitrary: `scopesForProject` is all
globals ∪ the project's own plugin, **globals-first**, so the default lens is dev/matrix;
`projectsForPlugin` gives a global plugin **ALL** projects, with no double-resume because the lenses
live in distinct data roots; and `DELETE /projects/:id` **fans out** a stop to every scope serving
the project.

**SSE is scope-aware, because a lens is `(projectId, scope)` and each lens has its own tree.** The
ring buffer and seq counter are keyed by `lensKey = ${projectId}\u0000${scope}`, and the relay
derives the lens from the *emitting* worker, so a product viewer never sees the dev tree.

**Default lens is dev-first**, because matrix is the foundation lens every project always has and
the product lens is the ADDITION — defaulting to product would make first load identical to the
reverted exclusive model and **hide the addition**. The default should teach the model.

## The plugin SDK: `mxd/plugin-sdk`, one zod, one live module

An out-of-tree plugin imports `mxd/plugin-sdk` — a subpath of the real `mxd` package — rather than
counting `../`s. Chosen over `@mxd/plugin-sdk` on purpose: the `@mxd/*` names are BROWSER virtual
modules, a different mechanism, and a server package reusing that prefix would falsely imply
kinship.

⭐ **It must stay a thin re-export and must never become a vendored copy.** Bun and Node dedupe
modules by REALPATH, so a plugin importing through its `node_modules/mxd` symlink resolves to the
same physical files and therefore the **same process singletons** the agent loop uses — in
particular the module-level `_ctx` in `resource-registry.ts`. A vendored copy has a different
realpath, a different `_ctx`, and **message delivery silently no-ops with no error.**

⚠️ **`package.json` pins `zod` EXACT, and the caret must not come back.** The SDK does `export { z }
from "zod"` so a plugin's `z.string()` passes matrix's `shapeToJsonSchema` — which only works when
both sides are the same `ZodString` class. A caret let a consumer drift, producing two distinct Zod
identities and a `defineTool` that stopped typechecking. **`package.json` is strict JSON and cannot
hold a comment, so this paragraph is the only record of why.** The `@anthropic-ai/sdk` pin is exact
for the same class of reason.

**The `exports` map also GATES deep imports**, and that gating is load-bearing: `getTracker` and
`deliverMessage` are un-importable, and only the narrowed pair reaches a plugin. **`deliverToNode` +
`listNodes`** is semantic narrowing rather than cosmetic — delivery that cannot be misused, and a
read-only snapshot that cannot mutate the tracker, versus full mutable access. `deliverToNode` is a
thin wrapper over the ONE `deliverMessage` path, so it keeps the wake-an-idle-recipient semantic,
and **no permission policy is baked in**: matrix's ancestor/sub-task restriction is matrix policy.

⚠️ **`deliverToNode` throws "deliverMessage not registered" outside any agent loop.** `_ctx` is set
on the `createApp` path, but `_deliverMessage` is registered inside `createAgentContext` **at agent
launch**. `listNodes` works without a launch; delivery does not.

## What extraction actually moved

`buildMatrixScopeOpts` moved into `.mxd/plugin/`; the **leaf utilities stayed in `src/`**
(WorktreeManager, `createOrchestratorTools`, `buildSystemPrompt`, `McpClientManager`) and the plugin
imports them, because plugin→src is the allowed direction. **The leak was `buildMatrixScopeOpts`
living in `runtime/agent-lifecycle.ts`, not the utils** — `grep WorktreeManager src/runtime/` is
zero, and that is the check. Worktree operations in runtime routes became hooks. Mock-showcase was
registered unconditionally in `src/runtime.ts`, so **every plugin worker served it**; it is a
FEATURE of the matrix plugin and now lives in `.mxd/plugin/routes/`. It is the place to visually
confirm a new log-entry card renders without running a real agent.

---
# Auth & External API
---

## Auth is always on, and the anonymous surface is four things

⚠️ **Read this whole region as answering ONE of the two security questions. It is about
authenticating the USER to the daemon. Nothing here — and nothing anywhere else — constrains the
AGENT: there is no sandbox.** An agent has full filesystem, network and command access, bounded only
by the OS user the daemon runs as. That is a deliberate and acceptable trade for single-user local
software, and it is the stated blocker for ever hosting this. The failure it causes is a reader who
finishes a hundred careful lines about tokens, masking and skip lists and concludes *security here
is handled* — so **split every "is this safe?" in two: can an unauthenticated stranger reach it
(this region answers that), and can a misbehaving agent do it (the answer is yes, always).**

There is **no auth-disabled mode and no opt-out.** Every `createDaemon` unconditionally runs
`ensureAuthInitialized`, and the middleware's "no jwtSecret → skip" branch is gone: an anonymous
request to a non-skip path is ALWAYS 401. Tests mint a token rather than disabling auth. Production
binds `127.0.0.1` unless `MXD_BIND_HOST` is set — the old `*:7433` default was LAN-reachable during
the bootstrap window.

**Exactly four ways a request skips auth. This is the whole list**, and understating it is the wrong
direction for an auth note to be wrong in:

1. `SKIP_EXACT`, which is **one entry**: `/auth/status`. The login page must be able to ask "am I
   authenticated?" before it has a token.
2. The `/vendor/` and `/app/` prefixes — compiled bundles, no secrets.
3. **`GET` + `isFrontendPath(path)`** — `/` exactly, or a first path segment that is a **currently
   registered project id**. This is the largest and least obvious part of the surface: tasks live at
   `/<projectId>/<scope>/<taskPath>`, browsers do not send `Authorization` on navigation, so a
   refresh must reach the shell — which is auth-content-free, and every API call it then makes goes
   through this same middleware.
4. Nothing else. **Everything under `/auth/*` except `/auth/status` requires a token**, guarded by a
   test asserting `GET /auth/bogus` → 401, which exists because a former `startsWith("/auth/")` skip
   would have silently exempted any future `/auth/*` route.

**Item 3 is `GET`-only on purpose** — POST/PATCH to a frontend-shaped path stays 401. And **the
predicate is `pm.has(firstSegment)`, not a ULID regex, deliberately the SAME predicate used by the
SPA-fallback wildcard**: one predicate, one answer, so there is no way to get "auth bypassed but the
wildcard 404s". A regex was considered and rejected — a project's *existence* is the correctness
condition, not its id format, and under a regex a deleted id would load a broken SPA that 404s on
its own data fetches instead of 404ing cleanly.

⚠️ **`/auth/logout` requires a valid token.** It was in the skip list, so any drive-by page could
POST it and force a secret rotation, logging out every active user — CSRF denial of service. The
handler's own docstring already described the 401 behavior; the code just did not agree.

## Tokens, credentials and the destructive-tool gate

JWTs carry `sub` (`"cli" | "session" | "stream"`) and `sv` (secret version). `/events` accepts only
`stream`; REST accepts only `cli`/`session`; a token with no `sv` always fails. **The long-lived
session token never appears in a URL** — the frontend POSTs `/auth/stream-token` before every
EventSource connect and passes a 5-minute token as `?token=`; the heartbeat re-verifies it and on
expiry emits a named `auth_expired` event, which the client's watchdog turns into a fresh token.
**`mxd watch` must do the same** — its own `sub: "cli"` token is rejected by `/events`, producing a
401 → reconnect → 401 loop forever.

⚠️ **There is no auth cache, and do not add one back.** A previous `authDataCache` produced "the
user ran `mxd auth` but the running daemon never re-read `auth.json`". `readAuthData` hits disk on
every call; it is a small local JSON file and the cost is negligible against that failure mode.
Relatedly it **throws** on a parse failure, an empty file or a read error, returning `{}` only for
ENOENT, and `writeAuthData` writes to a temp sibling and renames — before auth became mandatory, a
truncated `auth.json` was a file state that silently disabled auth entirely.

**Credentials are masked on read and protected on write, in three places.** `maskConfig` replaces
every credential on every config view; `mergeAuthGroups` preserves the plaintext when a client
echoes back a masked value, which is what keeps the UI's "save the entire authGroups object" pattern
safe; and `PATCH /projects/:id/config` and `/config/repo` **return 400 if the body contains
`authGroups` or `defaultAuth`** — that last one was CLI-only enforcement before, so a non-friendly
HTTP client could put its own credentials into a project's config and the next agent run would use
them.

⚠️ **`auth.json` needs BOTH a mode on write and a chmod on init, because of a POSIX detail that
looks like a bug.** Node's `writeFile(path, data, {mode})` only honors `mode` on file CREATION;
overwriting an existing file silently preserves whatever mode the inode already has. So without a
boot-time `ensureSecureFileMode`, an `auth.json` created by an older version stays `0o644` forever
even after every rewrite, leaving `jwtSecret` world-readable and forgeable by any local user. The
mask is `(mode & 0o077) !== 0`, so a user-hardened `0o400` is left alone.

**UI logout is server-first, and the order is the point**: POST logout → clear token → reload.
Clearing locally first leaves the session JWT valid on the server for up to 30 days, so a stolen
`localStorage` copy replays from another browser.

**Destructive tools check `requireSubtreePermission` at handler entry**: `update_task` (all
mutations, not only reparent), `close_task`, `delete_task`, `reset_task`, and the three folder
tools. **Upstream errors are classified before they reach a user** — `classifyUpstreamError` maps
`{status, keyword}` to `auth / rate_limit / credits / …` with a one-line headline, keeping the raw
message for debugging, so users no longer see raw Anthropic JSON blobs.

## The external MCP endpoint

`POST /api/matrix/mcp` is a stateless MCP Streamable HTTP transport — no attach, no session state.
Six tools, gated by `availability: "internal" | "external" | "both"`. The intended workflow is
`send_user_message` → `yield_external` → `get_logs`.

**Anti-pattern this endpoint taught us: an attached external observer and a peer project are
different relationships.** Layer 1 is asymmetric (an observer attached to a running agent); layer 2
is symmetric (two projects as peers). **The same wire format does not make them the same semantic**
— check symmetry before unifying two things that look alike on the wire.

## CLI onboarding

**`mxd config auth add` auto-promotes the first group to `defaultAuth`.** Provider resolution reads
`cfg.defaultAuth`, so add-without-promote was a half-command: a fresh user followed the README and
the next `mxd send` threw "No auth group configured". Adding a *second* provider leaves the existing
default alone — we never silently clobber an existing pick.

**macOS test gotcha**: `mkdtemp(tmpdir())` returns `/var/folders/…` while a spawned subprocess's
`process.cwd()` returns the resolved `/private/var/folders/…`. `resolveCurrentProject` compares
strings, fails, and the CLI exits with "No project found for current directory" long before reaching
whatever you were testing. Wrap fixture paths in `realpathSync`.

---
# Web UI — Routing, State & Event Handling
---

## Root is a regular task: the null-sentinel anti-pattern

> ⭐ **Any code that treats root specially at the ROUTING, TARGETING or IDENTIFICATION level is
> wrong. Root has an id like any other task; use it.** Only the TREE VISUALIZATION layer
> legitimately knows which node is root, for drawing the hierarchy and the orchestrator tab.

**This one anti-pattern produced five separate bugs over several weeks, and they look unrelated
until you see the shape.** `targetNodeId = selectedTaskId ?? rootNodeId` made the pending-message
filter need two branches, one of which accepted `taskId === null`, so on a fresh mount root-destined
pending messages were **silently dropped**. `isOrchestratorNode = !selectedTaskId || …` made
`!selectedTaskId` a sentinel meaning "treat as root", entangling routing with state-initialization
timing. `tabScrollStateRef.get(selectedTaskId ?? "root")` used a literal string as a Map key,
asymmetric with the SET branch, so **root's scroll state was never persisted at all**. A four-deep
`usageTaskId` fallback chain masked "nothing is selected" rather than rendering empty. And the URL
stripped the task component when the view matched root, so a refresh left no task in the URL.

**The fix everywhere is the same: `selectedTaskId` carries the actual root id when viewing root.**
No sentinel, no fallback. **If it is null, render nothing — that means "nothing selected yet", which
is a valid state rather than a bug to paper over.** Legitimate uses of `?? rootNodeId` that are NOT
this anti-pattern: "where do I navigate after closing the last tab" (a navigation decision), and `if
(!selectedTaskId) return` guards in destructive operations (asking "did the user actually click a
sub-task", not routing).

**Two design lessons came out of getting this wrong first.** The initial attempt built a
localStorage cache of `rootNodeId` so the first render could be correct synchronously:

> **When tempted to add a cache to make something synchronous, ask whether there is an existing
> async truth you can wait for instead.** There was — `/projects/:id/tasks` already returns
> `rootNodeId` in 50-200ms. A cache is only useful if you reject async, and there was no reason to.

> **Default to the loosest goal that satisfies the actual user need.** The goal was framed as "first
> render must be correct", which *forces* a synchronous source and pulls in the cache. The real need
> was "the pending banner appears within 200ms of refresh". **An over-strict goal is how solution
> complexity gets in.**

## URL routing: each layer owns its own segment

`/<projectId>/<pluginScope>/<pluginPath>`. The shell owns the prefix; the plugin owns everything
after it. Three invariants: neither layer reads or writes the other's segment; **the URL is THE
routing source of truth**, so neither caches anything and refresh and back/forward are free; and
`selectedTaskId` is DERIVED from `pluginPath` rather than being `useState`.

⭐ **The lesson, which is what makes this worth a section:**

> **When two layers coordinate through a shared serialized blob — one hash, one query string, one
> localStorage key — look for the segment each layer owns and give each direct access to only its
> own. If "they must agree" is the contract, the contract is wrong: sooner or later they disagree.**

That was not theoretical. The previous design put `#projectId/taskId` in one hash that both layers
wrote, and they trampled each other on refresh and on every SSE update. The shell also never read
the hash on mount, so it defaulted to `projects[0].id` regardless of the URL — meaning **a refresh
on a specific project sent task events to the wrong session.** Back was broken because the shell
created history entries the plugin did not know about.

⚠️ **Process lesson, and it cost a wrong conclusion: never claim "pre-existing" without verifying
against main properly.** The claim was that 18 failures predated the change. The verification used
`git stash` — **which does not revert already-committed work**; `git reset --hard HEAD^` was needed.
And even correctly reverted, the baseline must be a bare full `bun test`, not `bun test web/`: on
the true baseline main had zero failures.

## Pending messages are a projection of the event log

**Four successive fixes tried to patch a mutable `deferredMessages` map by changing *when* mutations
happen — and each closed one race and left the model in place. The mutable state was the bug.**

`pendingReducer(state, action)` is a pure module-level function: a `message` event with an id and a
non-compact source appends, a `messages_consumed` removes by id set, **every other event is a
no-op.** Invariants after the rewrite: pending is a pure function of the event log; **there is no
imperative clear path**; compact-source messages never enter pending, filtered at APPLY, so the old
model's need to *clear* a `[compact]` chip is gone; and `tree_updated` does NOT touch pending,
because **a task's lifecycle status "pending" and a message's state "pending" are different concepts
that happen to share a word.**

**Unconsumed messages stay pending forever, and that is correct**, per the user: if the agent never
processed a message the UI should keep surfacing it. Silently clearing on compact was lying.

**One thing outside the reducer affects pending, so the reducer alone is no longer the whole
answer.** The driver suppresses an APPLY for a message id it already saw consumed in the same batch,
because a RESET-plus-replay correctly empties pending and then SSE catch-up events arriving *after*
the batch can re-deliver a `message` whose consumption was already in it, re-adding a chip nothing
will ever clear. The guard lives in the driver; the reducer stays pure. **Diagnosis worth keeping:
all 22 "unconsumed" messages in the JSONL were compact-source and correctly excluded, and zero user
messages were unconsumed — the backend was right and the bug was purely frontend timing.**

⭐ **The phase-discipline lesson from the last of the four patches, which outlived its own code:**
when several event types mutate one structure, **they must all mutate in the same phase.** Three did
it synchronously inside `processEvent`; `compact_marker` did it inside a deferred side-effect
closure. In single-event mode there is no loop between the two, so both look equivalent; in batch
mode the gap yawns open and a deferred clear wipes messages that arrived *after* the compact.
**Search any `sideEffects:` closure for non-React-state mutations — that is the smoke.**

## Partial events are monotonic snapshots

`assistant_text` and `thinking` can arrive with `partial: true` — synthetic events injected by the
events endpoint, never persisted, so a mid-stream refresh does not lose what has streamed so far.

> **A partial event is a snapshot of content that only grows. Clients extend to the longer of
> {current state, snapshot} and never shrink.**

That is why the ops are `extend_*` rather than `replace_*`. On reconnect the frontend does BOTH an
SSE resume and a REST refetch, and the two deliver with opposite semantics — SSE deltas append, a
REST snapshot clobbers — so without extend you get either data loss (live "ABCDEF" overwritten by a
stale "ABCDE") or duplication ("ABCDEFDEF"). **Final (non-partial) events still use `replace_*` —
they are authoritative rather than snapshots.**

**Thinking specifically must extend rather than replace even though replace looks equivalent**: a
partial thinking event has an empty `signature`, and Anthropic needs that signature for prefix
byte-identity on restart. Replace would overwrite it with nothing.

## `queueEntryToUIEvent` is THE UI materialization gate

⚠️ **Every `QueueMessage.source` that should be visible in the activity log MUST have a case here.**
A missing case falls through to `default: null` and **the event class is silently dropped — no
error, no warning, nothing in the DOM.** That is exactly what happened to post-compaction summaries:
the message existed in JSONL and went through the full two-phase lifecycle, and the UI showed
nothing. Adding a new source means three places, in order: the union member, the producer path, and
this switch. **Forget the third and the JSONL is perfect while the UI is empty.**

## Project switch: remount, do not reset

`<PluginUI key={`${projectId}/${selectedScope}`}>`. This replaced a 25-line effect that watched a
`prevProjectId` ref and manually cleared **fourteen** pieces of state. **"Detect that prop X changed
and manually clear N pieces of local state" is a consistent smell, and the manual version cannot be
kept correct** — every new `useState` added anywhere in the subtree has to be added to the reset
list, and forgetting one leaks across projects. `key={X}` resets everything, **including state that
does not exist yet.**

Two that stay silent: **events are fetched per-session, not per-project**, because a forked session
contains its parent's events and merging by project produces stale content; and **the per-task draft
debounce reads `targetRef.current`, not `targetNodeId` from the deps array**, because with the value
in deps a render transition saves the previous task's prompt under the new task's key.

---
# Web UI — Components & Interactions
---

## The activity log's scroll position: guard the property, not the list of causes

Two user sentences define this whole subsystem, and everything below is downstream of them:

> **"If the AI is still producing output, I only have to scroll down once and I'm locked into follow
> mode — I can't read at my own pace."**
>
> **"Load-earlier should work like a chat app's infinite scroll upward: reveal more above me and
> LEAVE ME WHERE I AM. I wanted a bit more context and got thrown to the very top."**

So: follow mode is armed by the user, never by the browser; and revealing history must not move the
reader. Both were broken by the same underlying thing — **the log is the whole session's array,
replaced wholesale on every refetch** — which is why they belong in one section.

A survey of everything that reads, writes or invalidates the scroll offset found **30 touch points,
not the 9 anyone could name** — including the browser itself, via `overflow-anchor`.

⭐ **The predicate that works is `scrollRangeShrank(prev, current)`, where range = `scrollHeight −
clientHeight`.** Two predicates were proposed on the *cause* side and one measurement killed both:
"is the rendered content from the task being viewed" and "is the container non-scrollable" both miss
an in-log search that leaves 449px of range — fully scrollable — where a `scrollTop` of 1200 is
clamped to 449, which IS the new bottom, so the near-bottom test returns true and follow mode arms
itself.

> **This generalises and a cause-list does not.** This subsystem had already proven the cause side
> cannot be enumerated — the survey started from "your nine are almost certainly incomplete" and
> ended at 30. `scrollRangeShrank` tests **the property that makes an observation meaningless**, so
> it covers causes nobody wrote down. The composer auto-growing is the proof: not a view parameter,
> not anticipated, and it lands in the predicate for free.

**Growth is deliberately NOT suspicious**: streaming grows every frame, and a user scrolling back to
the bottom mid-stream must still be able to re-arm follow.

**Observation and intent are two concepts, and there is exactly ONE channel carrying each.** Scroll
position is an observation; `autoScroll` is an intent. The single place where an observation writes
an intent is the door every hijack came through, and today it is guarded: `if (!shrank)
onAutoScrollChange(atBottom)`. **Do not add a second reporting channel to re-establish the
separation — the separation is already there, and a second channel is what the first one was.** Two
halves were fixed separately: the guard rejects a **false observation** (a clamp after a shrink),
and the new-content effect no longer takes `autoScroll` as a dependency, which stops a **true
observation from immediately executing** — the user scrolls into the 40px band, follow correctly
arms, and the effect used to yank them the rest of the way mid-gesture. **Arming is not acting**,
and "go to the bottom now" has its own channel, a monotonic counter.

⚠️ **`prevScrollRangeRef` may ONLY be advanced by the scroll handler, and the danger is that the
wrong version looks MORE thorough.** Letting a geometry-reading effect update it too makes the guard
inert: effects run at commit, the clamp's scroll event is dispatched by the browser *afterwards*
(measured 14ms later), so the effect writes the new small value first and the comparison becomes
new-vs-new. Relatedly, **"only trust real user scrolls" is unimplementable** — a clamp-dispatched
scroll event has `isTrusted === true`.

### The culprit was not in the scroll code at all

Symptom: *"from mid-output to output complete, my scroll gets yanked to somewhere above"* — only
visible with follow OFF. The chain: the viewed agent goes idle → a refetch replaces every entry
object → new entry ids → new React keys → **the whole subtree unmounts and remounts**, and the
offset does not survive the swap. Measured from inside the DOM mutation, `added: 82, removed: 82` in
one batch against `removed: 1` for a normal update — **that is every React key changing, measured
rather than inferred.** The lazy-render anchor is an accomplice, not the cause: it **observed and
reproduced** a position that was already lost, which is what turns a one-frame flicker into a stuck
state. **Fix the keys** — *Every transport carries the event's name (eid)* is that fix, and this is
the measurement behind it.

**CORRECTION: "a wholesale replacement does not move the offset" is FALSE**, and an earlier round
measured it four times and concluded otherwise. The measurements were honest; the fixture held
~60-80 plain-text entries, cheap enough to tear down and rebuild that the collapse never survived to
a layout. A real session has images with no reserved height, expandable cards and markdown tables.
**The cost of a remount depends on how expensive the content is to rebuild, so a fixture made of
cheap content cannot answer the question at all.**

**The per-frame probe watching all this reported `range UNCHANGED → not a clamp`, and was wrong**:
the range collapsed and refilled **inside one frame**, and between the two DOM mutations there are
**267ms containing ZERO samples where ~16 were due at 60fps**, because the main thread was blocked
solid rebuilding 82 entries. **"No dip in the samples" is not "no dip."** The bias is systematic
rather than an edge case — **the operations that cause large displacement are exactly the operations
that block the main thread long enough to hide themselves** — so any instrument here needs an
observation that survives a blocked thread: a count taken either side of the render, or a mutation
record, never a sample taken during it. (General form: *Your instrument is a claim until you have
made it fail*.)

**And the counterpart: stop collecting once the answer cannot change the action.** Exactly where in
those 267ms the offset died does not alter the fix — do not remove the 82 nodes.

### Fixing a "you end up at the bottom anyway" mechanism makes older displacement visible

This displacement had always been there. With follow ON, any content change re-triggered
scroll-to-bottom, so **every** displacement was overwritten by the same endpoint and none produced a
distinguishable symptom.

> **In a subsystem with a mechanism that keeps forcing one endpoint, that mechanism is masking every
> other bug that moves the same value.** Each masker you fix surfaces a symptom that has always been
> there; the user reports it as new and it is not a regression, it is *newly visible*. This explains
> a whole class of "I hit this often but cannot say when" reports, and it means a subsystem's bug
> count can appear to grow while it is genuinely getting better.

**Two deletions here, and neither was about the feature.** Per-tab scroll memory **never
functioned**: the save ran in a passive effect keyed on the task id, which runs *after* commit — by
which time the list had emptied and `scrollTop` was clamped to 0, so it saved a destroyed value,
structurally. It was invisible because the follow-hijack it fed put you at the bottom anyway.
**Deleting an implementation that never had an effect is not deciding the feature should not exist —
it is removing a lie.** The second was a `↓` button that Follow had subsumed two and a half weeks
later; **the cost of that narrow affordance was not the affordance** — deleting one `useState`
cascaded to a whole reporting channel, a prop, a ref mirror and the `else` branch of two effects,
all of which existed only to keep its visibility fresh. **When you delete a consumer, follow the
data backwards to the producer before believing you are done**; the compiler stops at the prop.

**Reusable method:** attribution beats reasoning — one reproduction with a probe tagging every
programmatic write with who did it turned "something moved me and I don't know what" into two line
numbers, where the previous round needed a 30-touch-point survey to reach a *worse* answer. And
**diagnose by absence**: browser scroll anchoring goes through no JS path and fires no event, so
"the offset moved and nobody wrote it" is itself the diagnosis.

## Rewind and Edit: report what the rollback does NOT undo

`analyzeRollbackImpact` scans from the target entry to the end of the log, **skipping entries from
other tasks** (rollback is per-session, so a sibling agent's bash must not be reported), and counts
file / task / message side effects plus a generic bucket. An unknown target yields an empty impact,
so the dialog claims nothing rather than guessing.

⚠️ **The read-only list is a WHITELIST, and that is the load-bearing choice.** `read_file`,
`list_files`, `search`, `get_tree`, `get_task`, `background`, `yield` and friends are named safe;
**anything not whitelisted and not categorised sets the generic warning.** Unknown tools — external
MCP servers, `evaluate_script` — are never assumed safe.

⚠️ **`done` is NOT read-only, and the first cut whitelisted it.** A range crossing a `done()` then
rendered the green "nothing outside the conversation changes" box, which is a lie: `done()` flips
the task's status AND delivers `task_complete` to the task above, which may already have woken,
reviewed and merged. `done` now lives in both the task and message sets, which forced the
classification loop from a first-match `else if` chain to **independent membership checks**.

**Edit confirms at the moment ✎ is clicked, not at submit.** The warning's value is "before you
decide to edit", and intercepting the submit would need draft restore on cancel.

**There is ONE "jump to bottom" mechanism, and it is a monotonic counter rather than
`setAutoScroll(true)`.** The follow effect only fires when `visible.length` or `autoScroll` CHANGES,
so rewinding while already at the bottom with an unchanged entry count changes neither and **nothing
scrolls** — which is exactly why the "jumps to the top" symptom was reported as intermittent. And a
smooth `scrollIntoView` loses to follow mode — jumping back to the edited message got snapped to the
bottom mid-animation, observed live in a browser, not in tests. `setAutoScroll(false)` first, then
an INSTANT scroll.

⚠️ **Test-harness gotcha with real teeth**: `clearSessionState` drops log entries for a session
transitioning to `pending`, so a fixture seeded with `status: "pending"` **wipes its own log** the
moment the first `tree_updated` arrives. In happy-dom the SSE mock is a no-op so this never fires;
in a real browser the log renders "No events yet" while the events endpoint returns data. **Seed
live-smoke fixtures with `verify`** — a task that owns a session is never `pending` in reality.
Related: after a rollback re-fetch the entries REMOUNT, so any element captured before the rebuild
is detached.

**Live smoke recipe, reusable**: temp dataDir + `projects.json` + `tree.json` + hand-written JSONL
with an explicit eid/parentEid chain (so nothing auto-migrates), `createTestToken`, `createDaemon`,
`Bun.serve`, then `localStorage.setItem("mxd-jwt", token)` in the browser. **A user message needs
BOTH a `message` event carrying `id` and `eid` AND a `messages_consumed`** to materialize with its
eid, and without it the Edit/Rewind buttons never appear.

## Markdown rendering in agent replies

A hand-written parser for a lightweight subset — no markdown library, no `dangerouslySetInnerHTML`,
React elements only. **Strict grammar throughout, because a false positive is worse than a missing
feature**: that one sentence generates every rule in it, and the grammar's own tests state the rules
better than prose can. Two things the tests do not say:

- ⚠️ **Link safety is one gate in the parser, and it is the only security-relevant line in it.**
  Only `^https?://` becomes an anchor; `javascript:`, `data:`, `file:` and relative URLs render as
  literal TEXT, and text containing only an unsafe link stays "plain" and renders its raw source.
- **Emphasis uses whitespace-adjacency rules, NOT word boundaries — that is what makes it
  CJK-safe**, so `周围**中文**相邻` works where `\b` would not. Anyone "fixing" it toward a standard
  markdown implementation breaks every Chinese reply in the product, which no test of the parser
  itself would obviously name.

## Four interactions, each with one line that silently breaks it

Unrelated except in the way that matters here: each depends on a single easy-to-delete line — an
event-phase choice or a `preventDefault` — whose removal breaks the feature **without breaking a
test or producing an error.**

**Select-to-quote**: `onMouseDown={e => e.preventDefault()}` on the floating button is LOAD-BEARING
— without it, mousedown collapses the selection, `selectionchange` unmounts the button, and the
click never fires. **The rAF that inserts the quote has a required ORDER, all in ONE frame**:
recompute the capped auto-grow height, then focus, then set the caret, then `scrollTop =
scrollHeight`. Reading `scrollHeight` before the new height applies gives a stale value, so a long
quote leaves the user typing below the fold — and **do NOT rely on the separate resize effect having
run first**, because React 18 flushes passive effects asynchronously and rAF-versus-passive ordering
is not guaranteed.

**Global image drag-drop.** **RED LINE: never intercept internal HTML5 drags** — task-tree and tab
reorder set `dataTransfer` `text/plain`, so every global handler gates on `types.includes("Files")`.
**The visual and functional halves are on different phases, and both choices are load-bearing.**
Functional is on BUBBLE, because the composer's own drop handler calls `stopPropagation`, so a drop
there does not also attach at the window; visual (a `dragenter`/`dragleave` depth counter) is on
CAPTURE, so it cannot be desynced by that same `stopPropagation` — no stuck overlay, and no timer or
flicker heuristic needed.

**Sidebar filter toggle**: open state lived in the parent and query state in the child, and an
`onBlur` auto-closed when empty — so clicking the toggle while focused and empty fired blur on
**mousedown** (closing it) before the button's **click** (which read `false` and flipped it back).
Fixed by one reducer over `{open, query}` with the invariant **closed ⟹ query === ""**, and by
removing `onBlur`. If the auto-close is ever wanted back, use a document-level outside-click
listener — **not** `input.onBlur`, which re-introduces the race.

## Settings, stops, and the composer

**The mechanism everyone gets wrong: saving config takes effect on the NEXT run, with no restart.**
Save → the daemon syncs to workers → the next `resolveProjectConfig` uses the new values. **Restart
exists only to load newly deployed code.** The two got conflated because the restart button used to
sit next to Save; the single **Save & Restart** button now merges both actions so the question does
not arise. The panel has exactly two actions and **no confirm dialogs anywhere** — tab switching is
deliberately not guarded, because each tab keeps an independent draft and a confirm there is crying
wolf, which trains users to ignore the real ones.

**A save that silently fails looks exactly like a save that was reverted**, and this shipped: the
draft dropped keys whose value became `""`, `buildPatch` then sent `null` for them, the server
correctly rejected null on required global fields, `updateConfig` **did not check `res.ok`**, and
the refetch reverted the UI — so the user saw their changes "disappear". **The server's null
rejection was correct all along; the frontend was manufacturing the nulls.**

**Two stops became one.** The composer's Stop ends the TURN; the Orchestrator panel held a second
button and `/stop` was a third door, both calling teardown. All of them said "stop". **Second
instance of one shape, in the same component family: when a replacement lands, go back and look at
what it replaced.** Neither leftover ever went red — the older affordance keeps working, which is
exactly why nobody looks at it. The sharpening over the `↓` case: there both buttons shared one
handler, so it was a duplicate ENTRY POINT; here they called different backends with opposite blast
radii, so **the runtime had deliberately separated the two verbs and the UI went on offering both,
handing the user the very confusion the architecture exists to prevent.** Do not "keep the escape
hatch" by demoting the second control to a slash command — that is still two stops with the second
one harder to find.

**Deleting a UI control leaves four orphans the compiler cannot see**, and this one had all four:
its **i18n key** in every locale file (string-indexed), its **icon** (reachable only by name), its
**URL builder**, and the **prose describing it**. Typecheck found only the prop chain.

> **Frontend code lives in TWO directories and is consumed from THREE.** `web/` is the shell,
> `.mxd/plugin/web/` is the plugin UI — and `src/` imports plugin web modules too (in tests). **A
> grep scoped "to the frontend" therefore misses a real edge**, and it misses it silently, in the
> direction that says "nothing points here". Scope the grep to the repo, and let the compiler be the
> second opinion, not the first.

**The composer's image hint is the placeholder, and its condition is `!prompt`, NOT `!prompt.trim()`
— the trimmed version is the one that looks correct**, since every other gate in that component
trims. A placeholder is hidden by ANY content, whitespace included, so trimming sets a hint the
browser never paints: a flag claiming an affordance nobody can see. **Borrowing a slot that already
has a job means you owe it back** — one keystroke must restore `Message to "…"`, or an unconditional
hint sits on top of the target prompt for the rest of the session.

**A message must carry TEXT; images ride along with it and are never a message on their own** —
refused at four gates, because the Enter path never touches the Send button and the two REST doors
each accept the payload the other would have rejected. They answer with one identical sentence
asserted against a single constant, so no wording can drift alone.

---
# Testing
---

## Three layers: intention → tests → architecture

Tests are the single source of truth, and each layer can be challenged by the layer above but never
captured by the layer below. **The reason is the project's founding one: an AI can hallucinate code
but not a test result.** Three mutations guard the layers: is this behavior what users actually want
(intention); do the tests catch code changes (test); can the code evolve (architecture). Work
bottom-up — write tests, then find the simplest architecture that passes them.

## Integration tests are mandatory when a promise crosses a layer

**Use an integration test — full agent loop, `ValidatingMockAPI`, observe what the mock receives —
whenever a prompt, tool description or user-facing string promises a specific SHAPE; whenever a
change affects what the LLM sees; whenever the behavior crosses the agent-loop / tool-execution /
JSONL boundary.**

A unit test proves a formatter returns X. **It does not prove the LLM observes X through MCP
wrapping plus tool_result persistence plus the mock-reply path**, and the gap between those two is
where prompt/code drift silently lives. The LLM then builds strategy on the lie, and no unit test
catches it.

## The canonical user journey test is MANDATORY

If the feature's name describes a user action, there **must** be a test that performs that exact
action and asserts the user-observable result. **The canonical path IS the feature; everything else
is scaffolding.** Diagnostic: open your test file — is there a test whose whole shape is "do
user-action X, observe X works for the user"? If not, the feature is untested no matter how many
other tests pass.

Four ways this fails silently, all observed: **test config ≠ production config** (the test calls
`createDaemon` directly while production goes through `import.meta.main` with different flags);
**subcomponents tested individually, never the chain**; **partial-chain assertion** ("marker written
✓" while the GET response, the UI reading the flag and the backend guard are all unverified); and
**mocks matching the test rather than reality** (an in-process no-op `onBroadcast` where production
goes through postMessage). **Minimum bar: cross the real process boundary, and run the journey by
hand before `done("passed")`. "2003 tests pass" is not a merge gate. "I ran the feature the way a
user would and it worked" is.**

## ⚠️ Every `throw` in a test double must quote the real error it mirrors

**When a fake rejects something on the grounds that the real system would, the rejection message
must carry the real system's own error string. If you cannot quote it, you have not verified it, and
it does not belong in a predicate named after the real system.**

This rule exists because **it moves the failure to the moment of WRITING.** The claim that cost us
four production mechanisms propagated as a parenthesis in a bug report — *"Error from
ValidatingMockAPI (matches real Anthropic)"* — which nobody ever checked. Under this rule the author
goes looking for the API's wording, finds none, and stops there. **A rule is worth what its failure
mode is worth, not what it says.**

Three corollaries. **Separate OUR expectations from THEIR rules, by name** — a check we want but the
API does not enforce is fine, it just may not live inside something called `validateRequest`,
because **a style rule hidden inside an API-validity predicate gets cited later as API behavior.**
**A fake that is STRICTER than the real system is not "safe"**: it manufactures phantom bugs, and
phantom bugs get fixed with real complexity. And **fix the double BEFORE the code it guards, and
treat that ordering as the point** — right after `ValidatingMockAPI` was made faithful, the next
commit extracted a `yield`-ing block into a generator and omitted `yield*` at both call sites: legal
TS, zero diagnostics, the whole effect silently gone. **8 tests caught it, all via the rule that had
just been added; under the previous double every one of them would have been green.** The reason to
fix the double first is not tidiness — it is that you are about to be the one it catches.

**Two harnesses exist because a whole bug class was invisible.** `createMatrixApp` wraps
`ctx.onBroadcast` in `structuredClone`, because production's worker→shell postMessage boundary will
reject anything else — a sweep once deleted a triple-JSON-serialize step that had been
*accidentally* sanitizing payloads, production threw `DataCloneError` on every tree mutation, and
**no integration test caught it because none exercised `structuredClone`.**
`enableStrictToolErrors()` fails a test on any unacknowledged `is_error` tool_result, because the
same regression made every task tool return `is_error` to the agent, dozens of tests invoked those
tools, and **not one failed, because nothing asserted the error state.**

## Drift tests and correctness tests catch different things

**Drift invariant**: full agent loop plus restart, asserting the live path and the reconstruction
path produce identical bytes. **Correctness invariant**: invoke the walker directly and assert exact
output bytes.

**After the live path was unified to delegate to the walker, drift tests stopped being able to catch
walker bugs — and this was confirmed experimentally, not reasoned.** Removing the caption handling
from the walker leaves **all 27 integration prefix-validation tests passing**, because both paths
are now consistently wrong. The golden snapshot catches it.

> ⭐ **Do not silently lose coverage when removing duplication.** Unifying two paths shifts
> responsibility: convergence tests can no longer establish correctness, so correctness tests must
> re-establish what the drift tests used to provide.

**Golden-snapshot gotcha**: a user `message` event carrying an `id` is DEFERRED by the walker and
materializes only via `messages_consumed`. Without the consumption event it never renders, and your
fixture is silently testing nothing.

## Mutation testing: what to keep, and the shapes it misses

**Keep every mutation that surprised you; cut every mutation that confirmed what you expected.** The
confirming ones are verification records and belong in a commit message. The tell is the sentence
next to the table: *"I expected this to fail and it did not, because…"*

⚠️ **Guards need a two-sided mutation proof.** Everyone mutates the over-loose direction (delete the
guard). Almost nobody mutates the over-strict one — **and over-strict is the typical way a guard
fails**, because it reddens nothing and just silently stops a normal path working. Making a
follow-mode effect never scroll, i.e. killing the entire feature, left **11 of 12 tests in that file
green**, including four guard tests written the day before.

Four shapes mutation testing cannot see, each with a different cause:

- **A transition point that was never written.** A missing `setActivity` survived a full clean sweep
  — nothing failed, because nothing existed to remove. It was caught by reading the comment that
  argued for its absence. **When a comment argues why some code is unnecessary, that argument is the
  thing to check; the tests around it are all consistent with it by construction.**
- **A fixture that cannot express the difference.** Over-promotion of a glob was invisible because
  the fixture contained exactly one `src/`.
- ⭐ **And the mirror image, which you will defend rather than fix: a fixture can be too REAL.**
  Deleting a `b.type !== "text"` filter reddened NOTHING, because both tests used genuine shapes and
  **no real Anthropic block type carries a `text` field at all**, so that filter and the narrowing
  below it covered for each other perfectly. Only a synthetic block can see that line. **Realism is
  normally what you want from a fixture, and here it is exactly what blinded it** — so "our fixtures
  are faithful" is not an answer to "would this mutation be caught".
- **Two implementations of the same guarantee cover for each other**, and the tell is a mutation
  surviving that obviously should not have: `walkFiles` sorted its output and then the caller sorted
  the same array again, so deleting the sort inside the walk failed **no test at all**. Deleting the
  redundant one is what made the survivor testable.

⚠️ **`SURVIVED` is the comfortable answer, so it is the one to distrust** — twice a harness reported
it without ever running the tests that cover the mutation. Both instances and the general rule are
under *Your instrument is a claim until you have made it fail*; the local requirement is that a
harness must refuse to print a verdict unless the file text actually changed AND bun printed a
summary line.

⚠️ **`git checkout -- <file>` reverts to the last COMMIT, so it eats an uncommitted fix in the same
file — including the fix you are mutating.** The tell is an "after revert" run showing the same
failure count as the mutated run. **Commit before mutating.**

**When you replace an implementation but not its contract, a differential probe beats a green
suite.** ~40 lines running the OLD path and the NEW one over 21 real cases, asserting
**byte-identical output including order**, found nothing — which is the point: it states "behaviour
is unchanged" as a measurement over whole outputs, where a green suite can only state "the cases
someone thought to write still pass".

## An assertion about an ERROR MESSAGE survives the behaviour being inverted

**What earns this a section is not the rule. It is that the behaviour had shipped TWICE,
deliberately, and was pinned by NOTHING.** Two commits made image-only messages acceptable at two
layers. The only test either commit touched was one line:

```diff
-  expect(body.error).toBe("content is required");
+  expect(body.error).toBe("content or images required");
```

That reads as coverage. It is an assertion about a STRING, and it holds no matter which way the
behaviour goes.

> **An assertion about the text of a rejection is not an assertion about what is rejected.** It
> hides better than a fixture that cannot express the difference, because the diff LOOKS like the
> test was updated along with the behaviour.

**Detector, and it is cheap: for any behavioural claim, ask what the test would do if the behaviour
were inverted.** If the answer is "still pass, possibly after changing one string", the behaviour is
uncovered. Here the inversion needed 10 new tests across 4 gates and **0 flipped ones, because there
was nothing to flip** — worth knowing before you go looking for the outdated tests a task
description promises you.

## Test fixtures and harness traps

**A fixture with unstable identity silently loses its resolution.** If it regenerates entry ids on
every render, every rerender is a full key change, the subtree remounts, and — with follow mode on —
*the remount itself* scrolls to the bottom. The test does not go red; **it stops being able to see
whether the code under test scrolled.** Build the master array once and slice it, which is also what
production does. **Whenever a test asserts something about an effect, check that the fixture is not
producing that effect itself.**

⚠️ **An unfaithful double does not only make tests lie — it makes the missing test unthinkable.**
"Interrupt an agent mid-generation" had never been executed by any test, and not because anyone
skipped it: the mock stream ignored the request's AbortSignal outright, so every test that aborted
mid-stream passed through a road that was open and led to the OPPOSITE of production. **Nobody
writes "assert the abort actually aborts" when the harness cannot express the difference.**
Relatedly, `activity === "thinking"` does NOT mean a request is in flight — a session is BORN
thinking, so a test that waits for `thinking` and then interrupts can land before the first API call
exists and **passes every park assertion while testing nothing.** Key on
`getRequestHistory().length >= 1`.

⚠️ **A negative assertion is only worth the WAIT in front of it — and deleting a redundant channel
can silently remove that wait.** The shape generalises to every "delete the duplicate" task: two
guard tests awaited a report from a *redundant* channel and then asserted
`expect(calls).toEqual([])`, so deleting the duplicate deleted the await and the negative assertion
now runs before anything COULD have been reported. **It passes on a component that reports nothing
at all — nothing goes red, in the same commit that "only removed a duplicate".** The fix is a
positive control inside the same test. **Same rule with the ENVIRONMENT supplying the dead wiring**:
the first version of "Enter with an image and no text does not send" **passed on code that had no
guard at all**, because under happy-dom Enter never reached the handler.

### What happy-dom does not do

Most of its gaps announce themselves within a minute — no layout, so no geometry; you cannot type
into a React controlled input; a key handler needs a `.focus()` first or React throws before any
listener runs. (Hence the way to drive a composer in a test: **seed the draft through the
component's own `localStorage` key, `.focus()` + keydown for the submit.**) **Two do not announce
themselves, and both are paid by someone other than the author:**

- ⚠️ **It silently drops MutationObserver callbacks under GC pressure** — the listener holds its
  callback in a `WeakRef` with no strong reference anywhere, so after any GC pass mutations are
  delivered to nothing, with no error. **A test relying on MO delivery passes in isolation and
  flakes inside the full suite**, which is then chased as a scheduling flake. Real browsers hold
  strong refs per spec, so production is fine. **Never let a happy-dom test depend on
  MutationObserver delivery.**
- **Do NOT spy on `history.pushState`/`replaceState`.** Instrumenting them in `beforeEach` survives
  `GlobalRegistrator.unregister()` in ways nobody could diagnose, and **poisoned every subsequent
  `web/*.test.tsx` file with ~18 spurious failures** — a cost that lands entirely on whoever runs
  the suite next. Unit-test the pure parse/build functions instead.

**A constant-vector mock makes every hybrid-search assertion vacuous.** If the fake embedder returns
the same vector for every text, every document scores cosine 1.0 against every query, the whole
index comes back, and any assertion about *which* documents matched passes silently. Return a
text-derived vector. (And hybrid search embeds the QUERY through the same pipeline, so an embed
counter read after a search has counted the query too.)

⚠️ **`expect(domNode).toBeNull()` prints the node with its whole React fiber graph on failure**, and
the second cost is worse than the first: one such assertion produced a 227MB log, and another
**mangled bun's `(fail)` line, so a harness scraping that line reported a mutation as SURVIVED** —
the instrument was fine and its INPUT was destroyed by an assertion elsewhere. Compare booleans in
DOM tests.

## ⚠️ `bunfig.toml`'s preload is load-bearing; do not remove it

It does one thing: `import "react-dom/client"` once per process, before any test file. react-dom is
a process-wide singleton and its scheduler binds to whatever timer machinery exists at **first
import**. If that first import happens inside a registered happy-dom environment, the scheduler
binds that window's machinery — and when that file's `afterAll` unregisters, **scheduled render work
stops flushing for every subsequent test file in the process**: fast assertions fail and renders
time out at 5s.

⚠️ **`bun test`'s file order is filesystem-dependent — not alphabetical, not mtime — so this is a
latent landmine that any file addition can re-roll.** The baseline was green only because a benign
file happened to run first; adding four web test files reshuffled the order and produced 52 failures
across 11 files. **Do not remove the preload "because tests pass without it locally".** Red herrings
eliminated by probe, so nobody re-investigates: matchMedia mocks, happy-dom register options and
`IS_REACT_ACT_ENVIRONMENT` are all innocent. And one bisect trap: a mangled probe file whose
`beforeAll` THROWS never registers happy-dom, so the paired victim file runs clean and it looks like
the mutation fixed the problem. **Validate that a probe passes on its own before trusting a bisect
step.**

---
# Build, Tooling & Housekeeping
---

## Deleting code

⭐ **"Test-only" is not "dead", and conflating them turns a cleanup into a risky migration.** An
audit called `tool()` production-dead and asked for its removal. It IS test-only — and it has 23
call sites, which makes it live test INFRASTRUCTURE; deleting it would have been a 23-site migration
that changes what those tests test rather than reclaiming anything. **The real violation was sitting
next to it** — two helpers existed verbatim in two files — and extracting those was the actual win.
**When an audit says "dead", check whether it means "unreferenced" or "only referenced by tests";
the second is a different claim with a different answer.**

**Deletion beats repair when a feature is duplicative AND the user wants it gone.** Project-wide
"Clear All Sessions" (endpoint, CLI subcommand, settings button, slash command, `clearAll`) was
deleted rather than fixed, because repairing it needed an architectural decision about whether the
shell may know plugin URL prefixes, and the feature had no unique use case. **Do not confuse it with
what was KEPT**: per-session `clear`, the sessions/prune endpoint, the per-task "Clear Session"
route, and the frontend's unrelated `clearSessionState`.

**Names that no longer exist, so you do not go looking**: `persistent-queue.ts`,
`openai-compatible-provider.ts` (the whole Chat Completions path), `hasPendingYield`,
`truncateAfterLine` / `readWithLineMap`, `combineSystemPrompt`, `resetAuthDataCache`,
`rollback_marker` / `appendRollback`, `await_background`, `RelocateBanner.tsx`. **False positive to
expect while checking**: a deleted function often still appears in comments explaining its deletion,
so a bare grep count is not the answer.

## The build pipeline is content-addressed

Every asset carries its content hash in its filename and is served `immutable`; the HTML referencing
them is `no-cache`. So the browser always asks whether there is a new index and never asks whether
the hashed JS is fresh, and **stale content is impossible because stale URLs do not exist on disk.**

⚠️ **Do not add `Cache-Control: no-store` anywhere as a fallback, and do not add a query-string
cache buster.** Both are the cargo-cult reflex this design replaced: `no-store` re-downloads the
whole shell on every reload, and query strings defeat CDN caching. **Either a URL is
content-addressable (immutable) or it is the index (no-cache).** **Never hardcode a logical asset
URL** — only the manifest knows the real hashed path, and the build throws if an entry is missing
rather than emitting a bare specifier that would 404 at runtime.

## What is actually gated (and what is not)

Answer this before assuming a green result means anything.

| path | hook git looks for | gated? |
|---|---|---|
| direct `git commit` on main (memory curation, conflict resolution) | `pre-commit` | ✅ yes |
| `git merge --no-ff <branch>` with a clean auto-commit | `pre-merge-commit` | ❌ **no — that file does not exist** |
| a merge that CONFLICTS, then `git commit` after resolving | `pre-commit` | ✅ yes |
| any commit inside a sub-task worktree | none (`core.hooksPath=/dev/null`) | ❌ no, by design |

⚠️ **The clean merge — root's dominant path — is NOT gated, while the conflicting merge IS.** That
is backwards from intuition, and it is why "the hook passed" says very little about an integration.
Deliberately not fixed by adding `pre-merge-commit`: the branch model REQUIRES that intermediate
merges be allowed to not typecheck, and gating every merge would re-establish the routine
`--no-verify` habit that hid 24 errors before. Worktrees skip the hook on purpose — sub-tasks commit
constantly. To check the gate from a worktree, run `bash /path/to/main/.hooks/pre-commit` by hand.

**`core.hooksPath` is LOCAL config and is not tracked, so a fresh clone is ungated again and looks
identical to a gated one.**

> ⭐ **A checked-in hook file is not an enforced hook.** For a long time `.hooks/pre-commit` existed,
> was referenced as if active, and nothing pointed at it — git was looking in `.git/hooks/`, which
> held only `.sample` files. **Nobody was gated anywhere**, every `--no-verify` was a no-op against
> a gate that did not exist, and **the absence looked exactly like compliance.** The only way to
> know is to assert it: `git config core.hooksPath`.

**The smoke set the hook runs is chosen, not accumulated**, on two criteria: the round-trip proofs
for checks the hook itself runs (because a hook that runs a gate but not the gate's own test can
print that gate's "passed" while the gate is dead), and invariants that fail SILENTLY — which here
means the persistence layer, since the daemon shell, project registry, task tree and worktrees all
fail loudly.

## Gates: a passing gate looks identical whether it read 8% or 100%

**Every gate in this repo has now been caught claiming more than it read, and they failed along
three INDEPENDENT axes. That is the part to carry: fixing one axis leaves the others silently
intact, and the output looks identical either way.**

| gate | axis | the claim | what it checked |
|---|---|---|---|
| `check-i18n.sh` | SCOPE | bare strings in JSX | 4 of 31 files — **927 of 11,534 lines (8%)** |
| `check-i18n.sh` | DEPTH | bare strings | 1 syntactic form of 4 — **1 of 6** in one component |
| `data-paths.test.ts` | PATTERN | only one file builds paths from `dataRoot` | the 16 literal characters `dataRoot.slice(2)` |
| `.hooks/pre-commit` | SCOPE | `All checks passed.` | **4 of 141** test files, while NAMING five |

⚠️ **The sharpest instance upgrades the class statement: an addition list does not merely fail to
cover NEW code — it silently stops covering the code it explicitly NAMED.** The hook listed five
test files and ran four. `src/direct-provider.test.ts` was deleted **four days after being added to
that list**, and the hook went on naming it for 4.5 months while printing `All checks passed.` What
made it silent is the runner: **`bun test` skips a path that does not exist and still exits 0.**
**So an addition list must FAIL when a listed item is ABSENT** — a checker that shrugs at a missing
entry cannot tell *"we chose not to check this"* from *"this evaporated"*.

⭐ **Start from everything and subtract; do not enumerate what to include.** A subtract-list fails
LOUDLY — something noisy shows up and someone adds an entry. An include-list fails SILENTLY: new
code simply is not covered and nothing anywhere says so. `biome.json` and `tsconfig.json` both got
this right with nobody maintaining them. **The one legitimate exception is performance, and it must
be said out loud rather than implied** — a full `bun test` is ~255-300s per commit, so the hook
genuinely cannot subtract, and its remedy is the other half: **say what you ran.**

**An unqualified pass is worse than a narrow scope.** The i18n pass message carries the file count
now, and **scanning 0 files is a failure, not a pass**. The count is the detector: re-narrowing
drops it to 4 in front of whoever commits next. **And the count must be COMPUTED, never written
down** — a literal `5 of 140` is indistinguishable from a true one on the day it stops being true —
the drained rot, a count nobody experiences as a claim so nothing ever rings, sitting inside the
very sentence whose job is to describe scope. Both numbers are derived, so a re-narrowing prints `3
of 141` and a suite growing around a frozen list shows its own ratio worsening. **Every axis gets
the same treatment**: the i18n gate prints its FORM count beside its file count, so a narrowing of
depth is exactly as visible as a narrowing of scope.

**When a check is known dead, "the suite passes" is not evidence the fix worked** — the suite passed
while it was dead. The evidence is the round trip: plant, re-verify dead against the old audit, then
plant → **1 test red naming the offending file**, then plant removed → green. **A test whose value
is entirely in the day it fires must be made to fire on purpose at least once.**

⚠️ **And the widened heuristic has a RECALL GAP that is stated on purpose, because an unwritten one
is the next depth defect.** Precision came from one rule — *a user-visible string starts with a
capital OR contains a space* — which took the noisiest form from **32% real hits to ~100%** by
dropping `rotate(90deg)`, `currentColor`, `sk-ant-…` and dotted i18n keys. The price is that **a
single lowercase word with no space is NOT reported**, so `alt="attached"` is a real bare string
this gate cannot see, and **baseline 0 will not mean zero bare strings.** The trade is worth taking
because **a gate with a bad hit rate teaches people to skim past it** — but a recall gap nobody
wrote down is one commit from becoming exactly the defect this gate was just fixed for. **This
paragraph came within one commit of proving its own point**: a compression pass deleted it as
supporting detail, and it was recovered only by a mechanical sweep asking whether each of the old
file's warnings still had a landing place. Nothing about its absence would have rung — the gate
would have kept printing a number that the next reader had no way to know was holed.

**A partial-hit gate plus a fix-only-what-it-flagged policy produces incoherent output.** This
outlives any particular widening — a heuristic is partial by construction. When the i18n gate was
single-line it flagged 1 of a component's 6 user-visible strings; fixing that one leaves a component
half translated and half English, **worse than untouched, and it looks *handled*.** **The unit of
repair is the coherent unit, not the flagged line**; a gate that catches a subset tells you WHERE to
look, not WHAT to fix.

⚠️ **When a widened gate surfaces a real backlog, RATCHET — and make the baseline write itself
down.** The widening found 26 pre-existing bare strings, so two things were true at once: the gate
is correct and the repo cannot pass it. **A gate nobody can pass stops being evidence about
anything** — it just gets `--no-verify`'d, which leaves no trace, the way 24 type errors once
accumulated. So a baseline file carries the measured debt, the gate fails on any RISE, and
**rewrites the file downward on any FALL**. The rewrite is the load-bearing half rather than a
convenience: a baseline only a human remembers to lower is a number that quietly stops being true,
so fixing ten strings against a stale 26 lets ten new ones land unnoticed — **the drained rot,
reintroduced by the fix for it.** Known hole, accepted and recorded next to the baseline: it is ONE
count, so removing one string and adding another in the same commit nets to zero.

⚠️ **Do not let the string cleanup swallow the gate fix.** Widening flags a lot, and the pull to fix
them "while I'm here" converts a nearly-finished bounded task into an unbounded translation project
— which is how the thing that was going to protect us gets abandoned halfway. Count them, file them
(`01KYDBRDAPF13M5X0E7PGQVB0X`), ship the gate.

⚠️ **"Scope" is only one dimension an addition list can hide in — PATTERN is another, and it hides
better**, because a widened scope makes a narrow pattern look thoroughly exercised. The data-paths
audit's scope was fixed while its regex still matched sixteen literal characters, so
`dataRoot.substring(2)`, `.replace("@/", "")` and a formatter-wrapped `dataRoot\n\t.slice(2)` all
passed in silence. Round trip: **the old regex caught 1 of 8 planted spellings; the new audit
catches 8 of 8 and names the file.** Two limits stated rather than left to be discovered: a direct
rebind gets its own check, and a value laundered through a function return is out of reach of any
grep.

**Negative results from the 2026-07-25 census, so nobody re-runs it** (state claims, true of the
tree that day): **every `Bun.Glob` in the repo was correct**; file enumeration here is either a
`Bun.Glob` or a flat read of a directory we own with its filter written down, so **do not go looking
again**; file-scope CLAIMS are made in exactly two places, a `readdirSync` walk in a test and a
config's include/exclude; and **there is no CI** — the pre-commit hook is the only gate runner in
this repo.

**NEGATIVE RESULT — branded types were believed to be the one direction that escapes the enumeration
frame entirely, and they do not.** Probed with `tsc` rather than reasoned about: on `type DataRoot =
string & {__brand}`, **`dr.slice(2)` and `dr.substring(2)` both compile clean** — a branded string
keeps every string method. Meanwhile a plain JSON-shaped manifest object fails TS2322, so it *does*
break plugin authors. Refuted at both ends; manifests are JSON. **Do not re-derive.**

## Type errors that were all casts, and the gate that never ran

Twenty-four `tsc` errors accumulated across six merges, and the shape of the fix is the transferable
part: **every one was a workaround for a type the code already had correctly — zero `as unknown as`
were added, and all 24 fixes DELETED a cast or a hack.** The compiler will show you the individual
cases; what it will not tell you is that **a cast failing with TS2352 means the type is MORE precise
than you assumed, not less**, and that `.filter(Boolean)` does not narrow, so `!` is never the fix.

⚠️ **Why 24 errors accumulated is the more important half, and it is not "someone bypassed the
gate": there was no gate to bypass.** Nothing snuck past anything — the errors accumulated in the
open, and the absence looked exactly like compliance. Relatedly, `check:ci` exits 0 with a standing
pile of warnings, so **do not "fix" the warning count during a gate restoration**: biome's suggested
`!` → `?.` autofix is marked unsafe and silently changes assertion semantics.

## Two smaller standing facts

`mxd` is installed globally via `bun link`; `package.json` has `"bin": { "mxd": "src/cli.ts" }` and
the CLI carries a `#!/usr/bin/env bun` shebang.

**If `bun test` ever dies mid-suite, check the EXIT CODE rather than the summary.** Bun 1.3.7-1.3.8
killed the whole test process with SIGTRAP on any Worker teardown, so the crashing file ran first
and "3 tests passed" was meaningless — every claim of a green suite from that era was worthless.
Fixed by upgrading. The generalisable part is the check, and that **a minimal 7-line repro plus a
version matrix over isolated installs settled in minutes what days of test-level debugging could
not.**

---
# Reference & Pitfalls
---

## Known pitfalls

Only the ones that stay silent and are paid by someone else. Anything the compiler, biome or a
failing test tells you within a minute is deliberately not here.

- ⚠️ **A generator called without `yield*` is a SILENT NO-OP.** After extracting a `yield`-ing block
  into a helper, grep every call site. **Nothing catches this**: legal TS, no diagnostic, no lint
  warning, because the call genuinely returns a generator and the type system has no opinion about
  whether anyone iterates it. Observed cost: a tool_result reached neither JSONL nor `messages[]`,
  so requests went out with an unanswered `tool_use`.
- **Never modify your own JSONL from inside an agent.** The current tool_call has no result yet, so
  you will read it as a false orphan.
- **`delete_task` REFUSES any node with children** — you reparent or delete them yourself first.
  `tracker.remove` underneath it IS recursive and would take their session JSONL with it; that guard
  is the only thing between a misclick and unrecoverable loss. **Prose in this file, in the tool
  description and in the system prompt all said the cascade was reachable, for months; it is not,
  and describing a guard as a hazard makes agents avoid the tool where it is the right move.**
- **Concurrent ULID**: use the full 26-char `ulid()`. Sliced ULIDs collide within one millisecond.
- **Commits do not restart the daemon**, and the tools you call belong to the running daemon rather
  than to your worktree.
- **`bun run check` runs `--write` and silently formats 70+ files** — use `check:ci` when debugging,
  and split a format-only sweep into its own commit, or the diff someone reviews is not the diff you
  made.

## Known bugs and open design

- **Subtree message routing.** The parent chain shipped — `send_message` walks upward through
  `getTaskAbove`, so any ancestor is reachable — but you can still only reach DIRECT sub tasks, not
  arbitrary descendants. That half is what remains open.
- **Tool search** — dynamic tool discovery instead of sending every tool. Anthropic has a
  server-side `defer_loading`; the user prefers a client-side design.
- **`close_task` can land inside the launch window.** `beforeChildLaunch` (a `git worktree add`,
  seconds) runs BEFORE `onLaunch` flips the status, so a task being launched is still readable as
  its old status. It could always land there on a woken `verify`/`failed` task; narrowing the
  refusal to `in_progress` widened it to `pending` too — we made it more reachable without
  changing it in kind. `deleteTaskOp` and `resetTaskOp` close this with `awaitLoopExit`;
  `closeTaskOp` never had it and still does not. Draft `01KYNAKQDJTMVXWCQ3T62FHMZA`.
