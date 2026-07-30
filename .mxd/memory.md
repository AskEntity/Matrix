# Matrix Project Memory

> Read on every session start. This file holds what the code cannot hold about itself: why a thing
> is shaped the way it is, how the next person falls into the hole, what no single file can show,
> and what we checked and found untrue. The code states mechanism better than prose can, so if a
> paragraph you are writing would survive being replaced by "read the function", delete it.

## What this is, and the three facts everything else falls out of

A self-bootstrapping multi-agent IDE. Every tab is a task, every task is a whole story. One person,
a team's output. Agents branch off like shoots and are grafted back into the trunk.

1. **An AI can hallucinate code. It cannot hallucinate a test result or a compiler error.**
   Execution is the only truth source, and *what a model believes it did* is never evidence — read
   the JSONL, run the command, look at the bytes.
2. **The context window fills.** Everything durable therefore lives outside it: the task tree, the
   JSONL, this file. An agent running low continues from a summary rather than stopping.
3. **The project runs on itself.** The tools an agent calls belong to the *running daemon*, not to
   anybody's worktree — so fixing a tool does not fix the tool in your hand, and a bug you write can
   break the thing you are writing it with.

`Matrix.md` is the pre-launch design doc, in Chinese, and nobody should need it day to day. If you
go back to it to find out why we do something, that is a defect in THIS file — fix it here.

**Language.** Code, task tree and this file: English. `Matrix.md`: Chinese. Agent replies follow the
sender's language. Decisions the user made in Chinese are quoted in Chinese, because the wording is
the decision.

## How to run tests

The command is exactly `bun test`. No flags, no arguments, no pipes, no redirects.

```bash
bun test              # ALL tests (src/ + web/)
bun run typecheck     # tsc --noEmit
bun run check         # biome — WRITES, and silently formats 70+ files. `check:ci` is read-only.
```

**Piping is not size reduction, it is data loss.** The bash tool already bounds what reaches you and
saves the complete output to a file whose path it prints, so a pipe can only remove evidence you
cannot get back. The failure has one shape every time: pipe to `tail -8`, see `2116 pass / 2 fail`,
discover you cannot see *which* two, re-run with `| grep fail`, and get a **different** flaky subset
— because these tests flake at the scheduling level and there is no file ordering guarantee, so the
second run is questioning a different run than the one that failed. Run it bare and read the saved
file, and copy that path out of the tool result rather than typing one from memory: it lives under
the per-user `$TMPDIR`, `/tmp/mxd/` also exists and is empty, and a remembered path gives you "the
tool lied to me".

**The exit code and the pass count are two different claims, and only the exit code covers what
happens BETWEEN tests.** `2893 pass / 0 fail, exit 1` is not a contradiction to wave through — it is
bun reporting an unhandled rejection that no individual test was positioned to fail on, which in
this repo is an outage rather than a log line. When the exit code disagrees with the summary, the
summary is the one describing less.

## How work moves through this repo

**Root never commits code to main.** Not as a division of labour — because a direct commit destroys
clean rollback. A wrong fix that went through branch→merge reverts as ONE operation; the same fix
committed straight to main is interleaved with main's history and there is nothing clean to revert.
We have cleanly reverted both a wrong-semantic merge and a wrong-architecture merge exactly that
way. The only direct-to-main operations are merge-conflict resolution, memory curation, and
task-tree management.

**Whoever introduces a change owns every consequence of it** — prompt, UI, tests, docs, i18n.

**Merging is signing, and a green hook is a floor rather than a ceiling.** The hook checks syntax,
types and a smoke subset. It does not check whether the diff addresses every point of the task,
whether layer boundaries held, or whether the child's self-report matches the diff — and that last
one differs non-trivially, because a child reports what it *thinks* it did. Read `git diff
main...<branch>` line by line before merging. The observed failure always has one shape: child done
→ `git log --stat` → merge → post-merge bugs a manual smoke caught immediately. Watch for
single-line catastrophes; `autoRegisterSelf: false` shipped exactly that way.

Creating tasks is cheap; executing is deliberate. Draft while the user is still discussing, start
when they say go. `evaluate_script` is runtime introspection only — never use it to reparent tasks,
edit the tree, or run batch operations; fix the tool instead.

---
# How This Project Fools Itself
---

Almost every expensive failure here belongs to one of the classes below. They were each learned
separately, in different subsystems, by people who could not have known they were meeting the same
thing — so the rest of this file names the class rather than re-arguing it, and this chapter is
where the argument lives. **Recognising the shape is the whole mechanism: none of these announce
themselves, and every one of them produces the comfortable answer.**

## Plausible and wrong

> The expensive failures have not been mistakes that looked like mistakes. They have been
> well-written, well-evidenced, plausible things that were wrong — and each one then LOWERED THE BAR
> for everything downstream, because a check is only ever judged adequate against the explanation
> you currently believe.

**What installs a fiction is never a guess. It is something that LOOKS like evidence** — a real
error message carrying an unverified attribution, or a real published mechanism fitted to two data
points. **A guess invites checking; a citation suppresses it.** So every detector below is about
provenance rather than about plausibility.

**An ENFORCED fiction manufactures its own evidence.** `ValidatingMockAPI` enforced a
role-alternation rule the Anthropic API does not have. Our JSONL history contains 628 occurrences of
"Messages must alternate roles" — every one from our own mock and none from the API. Four production
mechanisms, one `test.todo` and one memory entry filed as a "reusable pattern" were built to avoid a
400 that cannot happen.

How it got installed is the instructive part. The helper's own comment wrote down BOTH rules and
chose between them: asserting the REAL rule (no trailing assistant message) would have reddened
correct fixtures, because some walker outputs are genuine conversation *prefixes* meant to be
extended. That reasoning is correct. So:

> **An inconvenient TRUE assertion plus a conveniently-green FALSE one means the false one gets
> installed, and is then believed as fact.** The fiction does not win on persuasiveness — it wins on
> not causing trouble. Once it lives inside a `throw` it starts MANUFACTURING EVIDENCE: 628 error
> strings from the rule that was *executed*, zero from the rule that was merely *documented*. The
> knowledge was never lost; the enforcement was.

**Detector: do not audit whether the assertions are correct** — that comment was entirely correct.
Ask instead whether **the rule being ENFORCED is the same rule that is DOCUMENTED.** Wherever those
fork, a fiction is producing evidence.

**An over-strict test double bills you three ways and the third leaves no artifact.** It creates
complexity you pay for. It hides gaps — a fiction occupying the "role rules" slot stopped anyone
asking what the real role rule was. And it **VETOES correct code**: the legal shape `[…, user,
user]` was rejected, so the correct implementation could not be tested and the feature acquired a
reputation for being hard to test. Nothing was red. **Ask what your test double has made people give
up on, not only what it has made them build.** When the true rules were finally added, zero existing
tests went red — the fiction was not masking existing tests, it was masking the fact that nobody had
written the missing one. A gap does not turn red; it stays invisible until someone goes looking.

Three shorter members, each in a different medium:

- **A wrong MECHANISM licenses a weaker test.** Chasing the CoreML NaN, a real published mechanism
  was fitted to two data points — over-fitting to n=2 while carrying a citation. "FP16 overflows on
  long inputs" implies short inputs are safe, under which a single long probe is not merely adequate
  but *well-chosen*. **The causal story silently set the bar, so the check that would have caught it
  is the one the story talked you out of needing.**
- **The cheapest instance to guard against is READING.** When an instruction is short and the action
  it licenses is expensive or irreversible, one clarifying question is always cheaper than a
  confident reading — and the temptation is strongest exactly when the reading is coherent, because
  coherence feels like confirmation. A coherent misreading of a short instruction nearly deleted 660
  lines of this file, defended with "a revert restores anything lost": true, and beside the point,
  because **the revert restores the lines, not the hour.**
- **A measurement that contradicts your plan is not a result to report afterwards — it is a reason
  to stop.** Mid-execution of that same deletion, the first rung measured 82 lines against an
  estimate of 310, already refuting the plan it was part of; the intent was to finish and report the
  discrepancy after. Nothing about that is careless — it is the ordinary shape of finishing what you
  started, which is why it needs writing down.

## Your instrument is a claim until you have made it fail

**Every measuring thing in this repo has, at least once, answered confidently and wrongly, and the
shape is always the same: it produces the COMFORTABLE answer.** A search returns `(no matches)`. A
gate prints `All checks passed.` A mutation harness reports SURVIVED. A linter reports zero. None of
those look like a broken tool. They look like good news, which is why nobody goes back to check
them, and why the wrong answer is inherited by everyone downstream.

> **A checker reporting ZERO is a claim about the checker until you have made it report ONE.
> Planting is not diligence — it is the only thing that distinguishes "clean" from "not looking".**

The roll-call, because the range is the argument — these are not one subsystem's bad week:

| the instrument | what it reported | what was true |
|---|---|---|
| `search` | `(no matches)` | it could not see `.mxd/plugin/`, 34% of the source |
| `check-i18n.sh` | `All checks passed.` | it had read 8% of the lines, and 1 syntactic form of 4 |
| `.hooks/pre-commit` | `All checks passed.` | 4 of 141 test files, one deleted 4 months earlier |
| biome `noFloatingPromises` | zero violations | zero *also* over a planted violation in that same file |
| a mutation harness | `SURVIVED` | macOS has no coreutils `timeout`, so the run never happened |
| a mutation harness, again | `SURVIVED` | it ran, against a test path not covering the mutated file |
| a per-frame scroll probe | "range unchanged" | 267ms of samples missing; the thing measured had blocked the thread |
| a three-signal task probe | `false` for all 551 tasks | `tree.json`'s `nodes` is an ARRAY, so `Object.entries` gave indices |
| a `ps`-based autoResume audit | "still costs 4 procs" | it was measuring an agent a human started 14s after boot |

**Four things a control has to be**, each paid for by a real one. It must be **able to FAIL for the
reason you are testing** — a reviewer confirmed with a positive control that grep could see a file's
real exports, then reported two symbols as fabricated; the symbols were real and lived in a commit
their branch had not merged, and the chosen control existed in BOTH versions, so it could not
separate "this symbol is absent" from "my checkout is old". It must be **placed where the risk is**:
a `while read` loop silently dropped its final line, and the planted control caught it only because
it was last. It must be **verified to have RUN, and to have run the thing that COVERS the subject**
— two different questions, and only the second makes SURVIVED mean anything. And it must be **of a
resolution that can carry the measurement you specified**, or the failure mode is a silent false
negative that reads exactly like a real result.

Two corollaries that catch what planting does not. **A uniform answer across a whole population is
the signature of a broken instrument, not a finding** — 551/551 is not a result. And **a heuristic
validated only where it works reads as verified**: the `ps` proxy was written against a boot where
nothing else was happening, i.e. in exactly the condition where it cannot fail.

**Every row above reports a ZERO or a PASS, and that is the table teaching half its lesson. The more
dangerous form is a PLAUSIBLE SMALL POSITIVE, because nobody plants a control against a measurement
that already looks like it worked.** Measured: an audit of what a whole-file rewrite had lost ran a
token probe, reported **9 real losses, all restored**, and the true figure was **18** within the
hour. The probe was fine. The number was honest. **The number is what closed the question** — a zero
at least looks like something to verify, whereas 9 reads as the yield of a completed adjudication,
so nobody asks what the adjudication could not see. It could not see a whole category: three of four
token classes were adjudicated item by item and the fourth was dismissed as a class, because its
output was sorted by frequency and the generic emphasis words sat at the head, setting the prior for
a tail they were unrepresentative of.

> **A checker reporting a small plausible number is a claim about the checker exactly as much as one
> reporting zero, and it will never prompt anyone to say so.** Plant against it too, and state any
> loss count with a SCOPE CLAUSE naming what was adjudicated and at what granularity.

**A grep for a SYMBOL cannot answer a question about a BEHAVIOUR, and the empty result looks the
same either way.** Root searched `hasRunningChildren`, found it genuinely dead, and concluded that
`done()` has no running-children guard. The guard was live the whole time — in `createDoneTool`'s
own handler body, and there since 2026-04-14. **The symbol was dead and the rule was enforced;
nothing about the empty grep distinguished those two.**

**The amplifier was the enumeration, and it is what overruled a human.** Root then listed *"done()'s
three rejection paths"* — assembled entirely from the places it already knew to look, never reading
the handler body where the guard lives. **A list of what you found is not a list of what exists, and
writing it as an enumeration is what makes it read as complete.** The user had stated the rule
correctly (*「现在不能了 父任务不能done的」*), was talked out of it by that list, conceded
(*「可能是我一直以为有这功能」*), and was right the entire time. **When a person's recollection
contradicts your search, the search is the one with a known failure mode** — and the cost is not the
wrong answer, it is that they stop trusting a correct memory. It recurred: three days later the
retraction existed as a draft and root repeated the refuted claim to the same user, who corrected it
from memory a second time.

**Worst is when the rule that suppresses a redundant check is also suppressing the only detector a
failure mode has** — *"ALWAYS use this for search, NEVER invoke grep via bash"*, on a `search` that
was blind. For as long as that bug lived, an agent that obeyed got the wrong answer and one that
disobeyed got the right one. **A description that tells agents to stop cross-checking has to earn
it.**

## Two situations, one observation

**Two different states of the world produce a BYTE-IDENTICAL observation, so the observer cannot
tell which one they are in — and the one they assume is always the comfortable one.** This is NOT
the previous class, and keeping them apart is what makes both usable: there the instrument is broken
and the answer is false; here the instrument is fine, the answer is true, and the answer is simply
consistent with two worlds.

| the observation | one world | the other |
|---|---|---|
| `search` returns `(no matches)` | nothing points there | it could not see 34% of the source |
| a catalogue answers `200 []` | the endpoint lists no models | our own `client_version` filtered them out |
| `getEventsSince` returns `[]` | the client is caught up | the cursor is from a dead incarnation |
| `getStopReason()` says `tool_use` | an ordinary tool turn | `refusal` / `pause_turn` / context exceeded |
| a config field reads `""` | inherit from the layer above | an explicit empty override |
| an SDK slot is `undefined` | the caller wants the default | the caller never mentioned it, so read env |
| a log ending in unanswered tool_calls | a human pressed stop | the daemon died inside an API call |
| the source of a defect | known, filed and half-designed | nobody has ever noticed it |
| `bun test` exits 0 on a listed path | we chose not to check that | the file evaporated four months ago |
| a probe does not call a hidden tool | the API masks unlisted names | the model did not want to |
| a green credential test | production cannot leak | your shell happened not to hold that variable |

**The remedy is one move wearing three costumes: make the two worlds produce DIFFERENT
observations.** Either widen the ENCODING so the states stop colliding — an epoch in every SSE id, a
raw `stop_reason` carried beside the collapsed one, `null` rather than `undefined` in a credential
slot, `undefined` rather than `""` for inherit — or, where you cannot change the thing observed,
change the EXPERIMENT: plant a violation and require the checker to report it; choose a positive
control that exists under one hypothesis and not the other; permute two probes so a first-hit edge
block separates from a real header requirement; stand up a decoy endpoint that testifies to what it
caught.

**It is worth naming rather than leaving in eleven places because the collision is invisible from
inside the observation, so the only thing that ever triggers a check is RECOGNISING THE SHAPE.**
Nothing about `[]` announces that it is ambiguous. What announces it is asking, of any answer you
are about to act on, **what else would look exactly like this?**

**And it is not only a diagnosis problem: once two states share one value, a control built on that
value cannot REACH one of them.** The settings panel read `(draft.model as string | undefined) ??
""` and past that line inherit and explicit-empty were one value — so the state could not be
rendered and, worse, could not be EXITED. Typing then deleting left `""` with no gesture anywhere
setting it back. Derive the state from the raw value FIRST, then coalesce for the control.

## A stored explanation expires, and nothing anywhere turns red

**Code has a compiler and tests. A label, a comment, a task description and a result round have
neither — and they get quoted far more often than they get re-run.** Their only moment of
verification is somebody measuring again, and the person quoting one is precisely the person least
likely to, because a stored explanation reads as *already checked*. **That is what separates this
from the instrument class: there the instrument is wrong; here the instrument is right and the
number is right, and only the sentence explaining it is false.**

| medium | the explanation that had expired |
|---|---|
| an audit script's output label | a bucket printed as `(pre-migration)` — a CAUSE the scan never tested, and false when written, since clean merges land in it too |
| a task description | "the gate still prints an unqualified `All checks passed`" — long since fixed; it prints a computed `9 of 158` plus `NOT the suite` |
| a task description | `config.model \|\| DEFAULT_MODEL` quoted as current code four hours after that constant stopped existing |
| a task description | a codex `auth.json` expiry passed forward as current state — of a file that ROTATES ITSELF, and did so 17 seconds after the task was filed |
| a result round | "the codex path 401s, waiting on credentials" read downstream as "fix the credential and it answers"; the 401 was masking four further mismatches |
| a code comment | `indeterminate = inherit`, describing a control nobody built; and "the CLI has the same check client-side", describing a door that was never guarded |
| a timeout value | `48.2s` and `15×` carried forward as measurements of a slowdown, when 48.2s is a 45,000ms budget plus 3.2s of setup |

**That last row is the sharpest, because the number was real and the arithmetic was right.** A
censored observation reports the BUDGET, not the quantity: any run where `done()` misses a 45s
deadline reports ≈48.2s whether the true cost was 46 seconds or 500, so three runs landing within
59ms of each other proves the constant is stable and says nothing about the phenomenon. `15×` is
`45000 / 3200`, a property of the budget and a LOWER BOUND. **Never tune a timeout from a ratio that
timeout produced — that is calibrating a constant against itself.**

**The rule: a stored explanation is a claim with a shelf life, and the shelf life is invisible on
its face.** A MEASUREMENT can be quoted if you say when it was taken. An EXPLANATION quoted forward
is somebody's belief about a mechanism that may have been replaced since. **Grep for the mechanism,
not for the sentence claiming it** — `indeterminate` had zero hits in the file documenting it; the
CLI's guard existed only in `GLOBAL_ONLY_FIELDS`. One grep each, and both were relayed onward as
fact instead. **A reading of self-rotating state has a shelf life by construction**, so no reading
of externally-owned state may survive as a constant, a cached value, or a comment stating a date,
including a fresh one. Ask the file.

## A rule enforced at N of M doors is enforced nowhere

The other doors accept the same payload, and **the door nobody remembers is reliably the second
one.** Three independent sets of evidence, which is what makes it the most reliable rule here: a
message reaches the runtime through `POST …/message` and `POST …/edit`, both taking `images`; a
search-hit vocabulary is shared by three renderers; the composer has four text-required gates. Test
both doors in one file against one app, and "I closed the door" can no longer quietly mean "I closed
a door". The way you find them is by asking **how many places accept this payload**, never by
reading the one place you were already editing.

**Three refinements, each of which cost something.**

**A producer and its consumers are doors too, and that arrangement is nastier than two peers.** One
task deleted a substituted model name at ONE CONSUMER — the `agent_start` event, because the log
claimed a model nobody chose — and left the SOURCE, so the loop-local went on substituting a literal
into a dozen event payloads plus the context-window lookup. **Fixing a consumer leaves every other
consumer wrong and looks exactly like the fix** (`01KYJ1775HCFY1VQ4QT36JXFTP`).

**Not every door is a WRITE.** For *how can `defaultAuth` reach the repo config layer* there are
three: `PATCH …/config/repo` (guarded), `mxd config set --project` (never guarded, writes the file
directly), and **`git clone`, where the file simply arrives and there is no write moment to guard at
all.** So no set of write-door guards can ever be complete, which is what turns a read-boundary
projection from the tidier option into the only one that finishes the job. **When one door is "the
state was already there when we arrived", enforcement has to move to the READ.**

**One door can live in `node_modules`.** `grep process.env src/` came back clean while an SDK's
default parameter read the credential env on every request. For any value you resolve from config,
ask **who else reads this name**, and go read the constructor of whatever you hand it to.

And the failure mode that makes this rule actively harmful: **a comment asserting that a sibling
door is covered.** You read the claim, believe both are covered, and stop looking — the same shape
as a gate printing a pass.

## A pattern name is a HYPOTHESIS about the situation, never an argument

**Naming a class correctly does not license its remedy, and this rule has cost twice — in the two
different ways it can fail, one of which survives scrutiny of the name and is therefore worse.**

**MISCLASSIFICATION: the name does not apply.** A prompt line said *"check `get_tree` for closed
tasks in the same area"*, which is wrong because `get_tree` hides closed by default; changing the
line to say `search_tasks` was the whole fix. A proposal to ALSO make `get_tree` disclose what it
filtered was framed as *the half the prompt cannot reach*, root recognised **N of M doors**, and
approved on the strength of the name. **But that rule is about one RULE enforced at several
entrances, and nothing was being enforced here** — the note fixed no defect of `get_tree`'s, so it
was a patch applied at the wrong layer. Cost: zero real defects fixed, plus a nearly-shipped break
of `get_tree`'s external MCP contract, since it is `availability: "both"` and clients `JSON.parse`
its text — **a bug that existed only because of the scope expansion.**

**CORRECT CLASS, ABSENT PROPERTY — the one to watch for, because the name holds up.** A proposed
table of contents for this file was rejected partly on the ground that it is an addition list. It IS
one. But **a class is dangerous because of a specific property, and an addition list's is that it
fails SILENTLY** — where a table of contents fails loudly, since entry-matches-heading is
bidirectionally checkable and the regeneration procedure already diffs the region list. The
classification was true and carried no force.

> **So the check is not "does this class fit". It is: name the property that makes the class
> dangerous, then confirm that property is present HERE.** A correct name with the property absent
> produces a true sentence with no force, and it is more persuasive than a wrong name precisely
> because it survives every challenge aimed at the name.

The remedy differs by member, which is why they must not be collapsed. *Several PARTS of one design*
and *several ENTRANCES to one rule* feel identical on site and pull opposite ways: **entrances ask
you to COMPLETE** — deploy the same rule at the door you missed, mechanical, because the decision
was already made — while **parts ask you to DECIDE**, since an unbuilt part was proposed and never
agreed. **The tell is cheap: for an entrance you can name the rule and point at where it already
runs. If you cannot, you are holding a proposal.** *Editing the system prompt* works that through on
the case it cost.

## Start from everything and subtract; never enumerate what to include

**An addition list fails SILENTLY** — new code simply is not covered and nothing anywhere says so.
**A subtract-list fails LOUDLY**: something noisy shows up and someone adds an entry. `biome.json`
and `tsconfig.json` both got this right with nobody maintaining them.

**The sharpest instance upgrades the class: an addition list does not merely fail to cover NEW code,
it silently stops covering the code it explicitly NAMED.** The pre-commit hook listed five test
files and ran four; `src/direct-provider.test.ts` was deleted four days after being added to that
list, and the hook went on naming it for 4.5 months while printing `All checks passed.` What made it
silent is the runner: **`bun test` skips a path that does not exist and still exits 0.** So an
addition list must FAIL when a listed item is ABSENT — a checker that shrugs at a missing entry
cannot tell *"we chose not to check this"* from *"this evaporated"*.

The same rule governs permission lists and CLI flag tables: `update_task`'s gate names the FREE
fields so a new param lands on the gated side where somebody hits a refusal, and `auth add`'s flag
check refuses unknown flags so a forgotten one is noticed rather than silently dropped.

**The one legitimate exception is performance, and it must be said out loud rather than implied** —
a full `bun test` is ~255-300s per commit, so the hook genuinely cannot subtract, and its remedy is
the other half: **say what you ran, in numbers you computed.**

## The compiler enumerates only what it can TYPE

**Its silence means "nothing typed points here". It never means "nothing points here."** Anything
reaching a symbol by NAME is invisible: string-keyed dispatch, an event-type name matched across a
process boundary, a field an external system keys on. The asymmetry earns the paragraph — a typed
break costs one compiler error and ten seconds, a name-based break costs a silent, delayed,
hard-to-attribute failure in a system you were not looking at. `WAKE_SIGNALS` went on listing
`agent_stopped` and `orchestration_completed` for months after both names were replaced, so a
stopped agent could only ever wake an external client by timing out. **Grep for the symbol as a
string before trusting the error list.**

**Measured instance of the ratio: deleting three fields from an auth-group type produced 8 files of
compiler errors and 5 more found only by a whole-tree grep** — the loudest being a settings UI that
declares its own copy of the shape and went on collecting the deleted fields through two live
password inputs, plus 12 orphan i18n keys (`01KYRD9GS9HCW8145H5C5ES6MZ`). **The typed half and the
by-name half are the same order of magnitude, and only one of them reddens.**

**Deleting a UI control leaves four orphans the compiler cannot see**: its i18n key in every locale
file, its icon (reachable only by name), its URL builder, and the prose describing it. That rule
applies to a control you *considered and dropped*, not only to one you delete.

**Deleting a named constant does not find its literal twins.** A grep for `DEFAULT_MODEL` found all
four call sites and could not see `model ?? "gpt-4o"`, `config.model || "gpt-4o"` three lines below
a branch the same commit had just fixed, or `request.model ?? "claude-sonnet-4-6"`. **Chase the
SHAPE — a fallback sitting in the model slot — not the name.**

Three grep traps in the same family, all of which return a confident, complete-looking answer:
`--include='*.ts'` **silently excludes every git hook, because a hook has no file extension** (the
extensionless set here is `.hooks/pre-commit`, `.hooks/worktree/prepare-commit-msg`, and anything
`core.hooksPath` points at) — caught during the `matrix.taskId` → `mxd.taskId` rename, where the
extension-scoped grep reported the rename complete while the file holding the READ still looked for
the old key; a single-line grep is **a claim about line breaks**, so `grep '\.catch(async'` returns
zero in a repo that has one the formatter split; and **your own tool list is a frozen snapshot, not
an inventory of what you can do** — an unlisted tool called by name works, so "it is not in my list"
is not evidence that it does not exist.

## Taking a PROPERTY of a thing for the thing itself

Two people tried to unify the three Edit/Rewind judgments on the same day and both made this
mistake. *"The gates are one invariant at two timescales"* explains a USER concept by its
IMPLEMENTATION consequence; an end user has no notion of an unmatched tool call. *"The message is in
the active chain, therefore it is rewindable"* takes a property of a rewind target for the target.
**API 400 is a symptom, not a reason**, and both framings leaned on it — even if the API accepted a
rollback to a message the agent never ran from, the operation would still be **empty**, because it
points at nothing. **Reasons must survive their failure mode disappearing.**

The same error, elsewhere and in different clothes: a permission list sorted by MECHANISM ("these
all modify an existing node") grouped *recording intent* with *destroying resources*.

**A former example of this class was RETRACTED, and how it failed is worth more than it was.** It
read: *`close_task` asks `status` when it means "is an agent running", which status cannot answer,
because status is what a launch SETS rather than what a launch IS.* That was true of the code it
described and false of the field — `onLaunch` ran at the END of a launch, so status could not
answer; moved into the launch lock's own tick it reports "a launch has begun", which is the question
close is actually asking. **The property was of the WRITE POSITION, not of the field, and reading it
as the field's nature is the very error this section names** — one level up, aimed at the diagnosis
instead of at the code. See *Only launching agents that will act*.

## A fixture that cannot express the difference

The test is green and it is measuring nothing. Four ways it happens, and the last two are the ones
you will defend rather than fix:

- **Too small.** Over-promotion of a glob was invisible because the fixture contained exactly one
  `src/`; and an absence assertion passes against the detailed form too when the fixture is empty.
- **Too cheap.** "A wholesale replacement does not move the scroll offset" was measured four times
  and concluded wrongly, because the fixture held 60-80 plain-text entries — cheap enough to tear
  down and rebuild that the collapse never survived to a layout. **The cost of a remount depends on
  how expensive the content is to rebuild.**
- **Too REAL.** Deleting a `b.type !== "text"` filter reddened nothing, because both tests used
  genuine shapes and **no real Anthropic block type carries a `text` field at all**, so that filter
  and the narrowing below it covered for each other perfectly. Only a synthetic block can see that
  line. "Our fixtures are faithful" is not an answer to "would this mutation be caught".
- **Drawn from the input where both candidate implementations AGREE.** Baking a data dir into a
  plist versus forwarding it through an env list emit identical bytes when the variable is set; they
  differ only when it is unset. **Ask which input the candidates agree on, and test the other one.**

Two sibling shapes worth the same suspicion. **An assertion about the TEXT of a rejection is not an
assertion about what is rejected** — it survives the behaviour being inverted, and the diff looks
like the test was updated alongside. **And an assertion whose redness depends on whose shell ran it
is not an assertion**: an env sentinel must DELETE its sibling variables, not merely set the one
under test.

**Detector, cheap and general: for any behavioural claim, ask what the test would do if the
behaviour were inverted.** If the answer is "still pass, possibly after changing one string", the
behaviour is uncovered.

## Never offer a remedy that will not work

**In a UI a human reads a bad remedy and gives up. In a tool error an agent DOES IT, collects the
second refusal, and then invents a workaround — and what it invents is worse than the failure,
because it is invisible.** `update_task {status:"closed"}` refused with *"Use close_task instead"*
while `close_task` refused anything not `verify`/`failed`, so **the first error named a road the
second did not accept** and a draft had no path to a terminal state at all. Observed damage: a
superseded draft was marked done by writing `[已解决 by <id>]` into its **TITLE** — state encoded in
a string, invisible to every status filter, so it sat in the active pool. **The workaround is
legible to humans and to nothing else.** Both defects were fixed and that title still stood two days
later, because **fixing a defect does not retract the workarounds it caused**: the task that solved
the underlying bug had recorded *"root should retitle or delete this"* in its own `done()` result,
and nothing owns a result round (`01KYT7EYE951TPFSYRJ3QAH2F5`). **So the repair has to be filed as
its own act, by the person who removes the defect, or the damage outlives it.**

**The fix for a false remedy is a SHORTER message, not a more complete one.** The instinct when
correcting a wrong instruction is to explain — name the false path, name the alternative, price it —
and two drafts did exactly that. Both were wrong for one reason: **they generated COMPLETENESS where
the reader needs an INSTRUCTION.** An error answers one question, *what do I do now*. Each rejected
clause fails a test worth keeping: a warning about an action the reader **cannot perform** (agents
have no stop tool, which was written down in the report arguing for the sentence); a destructive
option nobody asked for, where attaching the price tag does not make handing over the knife helpful;
and internal state vocabulary contributing nothing to *what do I do now*.

Greyed buttons follow the same rule with an ordering constraint: **precedence is
permanent-outranks-transient, not whichever the code tests first.** "Wait for the agent to stop"
promises a remedy; on a permanently un-editable message the user waits, the agent stops, the button
is still grey, and they cannot tell whether they waited wrong or the product is broken.

## Imagined requirements get built

Building a tool or an analyzer, agents default to handling every case they can imagine —
classifications, category labels, filter flags, pattern-matched explanations. Each branch
corresponds to an imagined need, not an observed one; half end up dead, and the live half hides the
data patterns a raw dump would have shown. **Start with the simplest raw dump and add heuristics
only when real use exposes a concrete need.** The same instinct explains why there is no `metadata`
param on MCP `create_task`/`update_task`: the only consumer is a plugin's REST UI.

**And its mirror: an optimisation for a case your fix eliminates is dead code that looks like
foresight.** Ask when the case occurs *after* the change, not before. (Batching embeddings across
projects was rejected on exactly this ground: the expensive part, the model load, is already shared
because the pipeline is a per-process singleton.)

## Delete until ONE remains

**The broken intermediate state feels more dangerous than it is.** Fear of a large change produces a
revert, or a fallback that keeps the old path "just in case". Both are worse than the break: two
codepaths drift silently and nobody knows which one ran. **And the third harm outlives the code —
the dead path's VOCABULARY stays in people's heads**, which is why this file has to keep saying that
"alternation" names a rule that never existed. The existing shape is not a given either: "why does
this exist" beats "how do I make this work", and **a "unification" that adds a third path is not a
unification.** **Test doubles get exempted from all of this by default, because test code reads as
lower stakes** — four copies of one Anthropic client mock is four places to miss one.

**Do not silently lose coverage when removing duplication.** Unifying two paths shifts
responsibility: after the live path was made to delegate to the walker, drift tests stopped being
able to catch walker bugs — confirmed experimentally, not reasoned, by deleting the caption handling
and watching all 27 integration prefix tests stay green because both paths were now consistently
wrong. Correctness tests must re-establish what the drift tests used to provide.

**And when you delete a consumer, follow the data backwards to the producer before believing you are
done** — the compiler stops at the prop. Deleting one `useState` for a redundant scroll button
cascaded to a reporting channel, a prop, a ref mirror and the `else` branch of two effects, all of
which existed only to keep its visibility fresh.

### Deleting a mechanism built on a false premise: separate the PREMISE from the OBLIGATION

Having shown that the stated reason for some code is wrong, do **not** delete on that finding alone.
Answer two questions separately: what did it claim to prevent (the premise, now known false), and
what does it still actually DO (the obligation, possibly real and load-bearing)? Delete only where
the obligation is empty; where it is real, keep the effect, relocate it, and rewrite the comment to
name the true reason. **Skip this and you delete a real guarantee along with the phantom, silently**
— the premise was false, so nothing else was protecting the obligation, and the tests covering it
were usually written in the phantom's vocabulary too, so they go green on the way out.

**Check for a COST as well as for redundancy**: "harmless, leave it" is not the safe default it
looks like, and the cost is usually written in the mechanism's own comment as an accepted trade-off.
One dead collapse helper replaced entries in place, so the day a second producer arrived two
distinct entries would have rendered as one, carrying the last one's content at the **first one's
timestamp** — a latent wrong answer parked in the code waiting for a caller.

**What happens to the dead mechanism's TESTS is the transferable half, and the honest-looking move
is the wrong one.** *"Invert rather than delete"* is right for the tests of a removed FEATURE, and
it does not reach the tests of a removed mechanism whose last producer is gone: those would assert
"nothing collapsed because nothing was produced", which passes against every implementation
including a deleted one. Three options, one right — delete mechanism and tests together; keep both
and RE-AIM the tests at a surviving producer; or keep the mechanism with no coverage. **Re-aiming is
the trap**, because it silently pins, as intended behaviour, whatever the mechanism happens to do to
a producer it was never designed for: chosen by nobody, and thereafter defended by a test. The test
that inverts correctly is the one whose PRODUCER still exists — a shell really can hold
`OPENAI_API_KEY`, so a test that sets it and asserts the value did not land is real coverage.

## Make the operation IDEMPOTENT and a whole class of reasoning disappears

The one positive member of this chapter. **Four places solved a "did somebody already do this?"
problem the same way, and every time the win was not the line saved but the REASONING retired.**
`setActivity` early-returns on an unchanged state, so you write a transition wherever the loop
changes what it is doing and never think about call sites again. `cd` to the directory you are
already in is a free no-op, which is what makes *"prefix a `cd` whenever you are not sure where you
are"* an instruction anybody can follow. The index repair pass removes before EVERY insert, so the
pass whose whole job is recovering from a half-written state tolerates being run against a correct
one. The trailer hook passes `--if-exists doNothing`.

**The tell: you are about to write a check whose only purpose is to find out whether an earlier step
already ran.** That check is a second source of truth about the same fact, and it will be wrong at
the one moment it matters.

## Reviewing: whose reference is it, and what shape of finding can it produce

**A verification whose reference was produced by the verifier is not a verification.** One audit
reported five files "all verified clean". Its own session, ~320 events earlier, had sent the docs
project the numbered change-list those files had just been edited from — so it compared the docs
against its own instructions, and **agreement was structurally guaranteed.** **Distance manufactures
the illusion**: 320 events is enough to stop experiencing a list as your own output, after which it
is simply *the criteria*. The defence is not vigilance but asking **where did my reference come
from**, a question with a checkable answer, unlike "am I being circular", which has none. And
**`clean` is the one verdict that leaves nothing to review**, so it is accepted by default and
inherited downstream — here for 115 days, over bytes it did not even cover, since two commits landed
on one of those files afterwards. **Date the artifact, not the review: a verdict names a commit or
it names nothing.**

**A checklist derived from the artifact can only find contradictions, never omissions.** Walk a
document checking each claim and every finding you can produce has the form "it says X, the code
says Y". You cannot produce "the code has Z and the document has never mentioned it", because
nothing in the document ever raised Z. That audit's findings were 100% contradictions and 0%
omissions, and the ratio was a fact about the method: a whole-repo probe for concepts absent from
all four docs found **twelve** invisible subsystems. **The omission pass needs its own instrument,
running in the opposite direction: start from the CODE, enumerate what exists, and ask which of
those the reader would form a wrong model without** — that last clause is the bound, or the pass
never terminates. The trap is that **the omission pass makes the contradiction pass look thorough**,
because contradictions come with line numbers while omissions come with an absence.

**"This is not a problem" is an assertion that needs evidence, and it is asked for evidence far less
often than "this IS a problem".** A claim of a defect gets challenged, reproduced, measured; an
all-clear closes the subject.

**Auditing a live repo: pin the commit, and expect it to move under you.** Mid-audit a target gained
two commits, every line number collected was silently invalidated, and one of the findings was fixed
— so reporting it would have sent another team to redo work they had just finished. Record the
target's HEAD when you start, re-check it before you report, and **re-derive line numbers
mechanically from anchor TEXT at the end, never carry the ones you noted while reading.**

## Where agents predictably go wrong

Not hypotheticals; each has cost real work, and each is a class above wearing an agent's clothes.

1. **"Start something new" wins locally and loses globally.** When a requirement appears, three
   options exist: create a task fresh, create and fork context into it, or `send_message` an
   existing (closed, verify, pending) task. The third is often correct and loses on every cheap
   dimension — fresh description vs stale, clean session vs unknown state, one step vs two, and the
   word "closed" reading as "finished" — so agents take the first and fragment context across
   redundant trees. The same shape appears as handing work to a fresh agent instead of continuing.
   Prompt alone has not fixed it; the mechanism design is draft `01KNZGYY4T6SYWVT66DK13XCPV`.
2. **Context is a compaction boundary, not a deadline**, and agents estimate their own budget badly
   and confidently. The agent that offered a handoff was at 2.0M tokens having never compacted once,
   estimated 2-3 sections left in it, and on being told to continue finished all five plus an extra.
3. **The rules are written for the worker's situation, so root's operations look exempt.** Measured
   on one session: root broke three rules it had quoted at children that same evening — `git
   checkout --detach` to peek at a branch ("I am not switching work"), `bun test | tail -25` ("I
   only need the pass/fail line"), and relaying two code comments to a sub-task as measured fact ("a
   comment is in the repo, so it reads as evidence"). **The rule is recognised, judged inapplicable,
   and violated, all without deliberation** — and two of the three left no trace, because `git
   checkout` succeeded silently and the pipe returned exit 0. Do not read this as "be more careful":
   **when a rule is broken by someone who knows it, ask what made the act look like a different
   act**, and give the prohibition an alternative. To READ another branch use `git show
   <ref>:<path>` or `git grep <pat> <ref>`; a prohibition with no remedy gets violated by whoever
   has the legitimate need.

---
# Changing Code Here
---

**Every bug fix asks two questions, not one: what caused this specific bug, and why does the
architecture make this CLASS of bug easy?** The recurring answers are duplicate codepaths, lifecycle
coupling, legacy fallbacks masking bugs, and lazily-optional fields.

## Changed a behaviour? Grep for the PROSE that describes it

In this file, in docstrings, in tool descriptions, in test names. This is the half the identifier
rule misses, and the distant surfaces are exactly the ones without the identifier in them. **The
highest-risk prose surface is the compaction checkpoint (`src/compaction.ts`), and it is nowhere
near the code it describes** — it is injected into an agent that has just lost its history, so
nothing in that agent's context can contradict a stale line: a rule that survives there gets taught,
fresh, to every compacted agent, and a grep scoped to the subsystem never reaches it.

Four kinds of prose rot, and only the first is findable by re-reading:

| kind | wrong when? | found by |
|---|---|---|
| **Fabricated** — a claim that was never true | the moment it is written | checking it against reality |
| **Invalidated** — a true statement about a neighbour | **later**, when the neighbour changes | *nothing you can do by re-reading it* |
| **Vestigial** — a true statement whose content is a DIFF against a version only the author saw | the moment it is written, and it never stops reading as content | asking what a reader who never saw the old version learns from it |
| **Drained** — a count or a list that quietly stopped being true | **later**, and nobody thinks they are correcting anything | checking against the source, item by item |

Two directions to be careful in: *"changed nearby" is not "now false"*, and — the one that catches
more — ***"still true" is not "still accurate"***. One sentence survived as an invariant while the
mechanism under it was replaced, and a check looking only for false claims walks straight past that.

**The vestigial kind is the one an accuracy audit can never catch, because it is not inaccurate.** A
prompt line read *"Trigger on the question you're holding — not on an unfamiliar area, not on a task
about to be created"*; both negations named triggers a PREVIOUS revision had used. To the author,
mid-correction, that clause was the whole point; to every reader afterwards it is a comparison with
something they cannot see, so it carries zero information while occupying the position of an
instruction. **It survived a full read-through and a deliberate contradiction hunt**, because those
look for statements that fight each other or fight reality, and this one does neither. The question
that finds it: *what does this tell someone who never saw the old version?* Grep candidates are
cheap — any "not X, not Y" whose X and Y appear nowhere else — but the grep is a candidate list
only, since most negations name something the reader can see and are doing real work.

## A symbol that lives ONLY in the comments describing it

*Changed a behaviour? Grep for the PROSE that describes it* tells you to grep. This is the case
where the grep ANSWERS — three ways a name in a comment can be dead, and the middle column is all
the person checking ever sees:

| variant | grepping the name shows | outcome |
|---|---|---|
| the symbol was deleted | nothing | **caught** |
| the symbol exists, nobody calls it | hits, every one true | missed, and merely stale |
| **the symbol survives only in the prose describing it** | **hits, every one prose** | **missed, and it reads as CONFIRMATION** |

The third is the expensive one because those comments describe the thing as if it were running, so
whoever looks the name up gets supporting text. **Grep for a DEFINITION, never for a name** —
`grep -n 'function <name>\|const <name> ='` — and **the endpoint of the chase is a definition, never
another name**, because the replacement you find can itself be a phantom: `wasReplaced` appears
three times in `agent-lifecycle.ts`, all comments, while the real local is `notReplaced` and its
polarity is the opposite, so a mechanical rename inverts every sentence it touches.

**Ask `git log -S"<dead name>" --all` before you pick a replacement.** The commit that removed a
symbol usually names its successor in the message, and that is evidence where the nearest plausible
export is a guess. Measured: `runChildAgentInBackground` was five comment hits with zero definition,
and `6c46e2f3` says *"Rename runChildAgentInBackground to runAgentForNode"* — while the plausible
guess, the exported launcher three lines below one of those comments, was `ensureChildAgentRunning`,
which does not call the function whose docstring that comment is, and which the restart path skips
entirely (`autoResume` calls `runAgentForNode` directly). **A name proposed from PROXIMITY survives
review exactly as well as one derived from the CALLER, and the two costs are not equal: proximity is
free, because the wrong name is already on screen, while the caller costs one grep — the grep that
"I can see the answer from here" is precisely what talks you out of.** Both people in the loop paid
it: the author of the original comment, and the reviewer who corrected three other stale claims in
the same task description that same evening and passed the unverified replacement name through
untouched. **Nobody in a chain of two ran the grep, and the description they produced was ABOUT
names rotting.**

**The census, and the discriminator that made it actionable.** `scripts/comment-phantom-survey.ts`
extracts identifier-shaped words from every TS comment and reports those with zero occurrences in
comment-stripped code: 326 files, 1,235 distinct candidates, **152 with no code occurrence** — of
which about a dozen names across ~25 sites were the defect and the rest were external API names or
legitimate deletion records. **TENSE separates them, and nothing else does.** *"X used to do Y, it
is gone"* is correct prose that must stay; the same name in the present tense, or standing in a list
of current examples, is the defect — and **no mechanical check can tell those apart, because to a
grep, to a compiler and to a reviewer scanning a column of names they are the same name with the
same zero definitions.** The discriminator is a VERB, visible only to someone reading the sentence,
which is why the survey's output is a list to be read rather than a gate to be passed.

Two properties of that instrument worth reusing. **Its errors must fall on the false-positive side**
— the scanner does not track regex literals, so it can misread a `/…/` body as a comment, which only
ever ADDS a candidate; the opposite bias would hide a phantom, and hiding is the whole failure being
hunted. And **a planted control has to exercise the form the defect actually lives in**: phantoms
sit overwhelmingly in JSDoc, so a control planted only in a `//` line proves the wrong branch.
Third, learned by watching it break: **once an instrument is committed it becomes part of the corpus
it searches**, so `const PLANTED = "zzControl"` puts the control's own name into the haystack and
every run afterwards reports MISSED. Build such names at runtime. It failed in the safe direction —
which is the only reason anyone saw it, and the reason to check: **a control that can read its own
name out of the haystack can only ever under-report.**

**An ABSENCE is a universal claim, so a truncated list can never support one — with or without a
count beside it.** This is stronger than *a correct COUNT next to a truncated LIST*, which is about
believing you finished an enumeration: here no amount of belief helps, because *"no line says X"*
quantifies over lines the pipe threw away. Paid: `git grep -n handleInjectMessage | head -5`
returned five hits, all comments, and the phantom was half-written before the definition turned up
on the seventh line. **Piping to `head` is not economy on any command whose output is meant to prove
that a name has no definition — it invalidates the conclusion.**

Two things the sweep found that no rename would have: `.mxd/plugin/index.ts` promised that
pre-existing data is moved into the plugin namespace by a one-shot migration **at daemon startup**,
which `acb887d2` deleted — a reader would believe an old-layout data dir converts itself. **Before
rewriting a comment like that, check whether the need it describes is still real, or the repair
launders a data gap into an accurate sentence.** Measured here, so nobody re-derives it: the
migration was deleted because it had already RUN, not because it was judged unnecessary (*"After P4
migration executed on disk … no legacy data in the wild"*), and today 14 of 15 projects under
`~/.mxd/projects/` hold nothing but `plugin/`, while the fifteenth carries one stray **0-byte**
`tasks/*.jsonl` whose 432KB twin sits in the new layout. **No unconverted data exists, so the
comment was the whole defect.** And in `lifecycle.test.ts` a test's header comment listed *"done()
handler updates tracker status"* sixty lines above that same test's assertion that status is **not**
updated. **Prose and code contradicting each other inside one file, with nothing red**, is the
ordinary state of a comment nobody re-runs.

## Hard invariants

Violating any of these produces silent corruption rather than an error. **They are two families, and
knowing which family you are in tells you what a violation will look like.**

**Family one is ONE WRITER, ONE PATH.** `deliverMessage` is the only writer of message events; the
provider loop is the only writer after a yield tool_call; `src/task-operations.ts` is the only
implementation of a task operation (MCP and REST are thin wrappers, and behavioural differences are
explicit `if (editedBy === "user")` rather than a second implementation); the live path delegates to
the walker instead of constructing anything of its own; `src/data-paths.ts` is the only place that
resolves a path from `dataRoot`; `resolveDataDir()` is the only derivation of the data directory.
**Breaking one of these corrupts nothing on the day you do it** — it creates a SECOND
implementation, which then drifts, and the bill arrives months later when the two disagree about
something nobody thought to compare.

**Family two is DURABLE BEFORE VISIBLE — and where a crash can land between two writes, order them
so that the state you are left holding is the one you can repair.** Persist before broadcast, so no
observer is shown an event it cannot name. Make `task_complete` durable before `done_notified`,
because a duplicate completion is recoverable and a lost one hangs the parent forever. Write the
index DB before the sidecar that claims it, because "the sidecar is behind" is repairable while "the
sidecar says indexed" is a permanent silent hole. Write a temp sibling and rename, because a crash
mid-write must leave the OLD `tree.json` whole rather than truncated. Repair a session by appending,
because `setChainHead` is pure memory and the jump only reaches disk as the next event's
`parentEid`. **One question generates every one of them: there is an instant when only the first
write has landed — which of the two possible worlds can you come back from?**

The rest, stated once because each is the whole rule:

- **JSONL content fidelity.** What is written to JSONL is byte-identical to what was sent to the
  API. UI truncation happens at the rendering layer only.
- **Tool results are three-part.** Every tool_result must emit to JSONL, yield to SSE, and push to
  `messages[]`. Missing any one gives an orphan, a missing UI entry, or an API 400.
- **Nothing writes to JSONL after a yield tool_call except the provider loop.** External events go
  to the queue.
- **Messages have a two-phase lifecycle.** `message` persisted → frontend defers;
  `messages_consumed` → frontend materializes. `QueueMessage`, `Event` and the displayed
  `[HH:MM:SS]` are the same value, set once at creation.
- **Recovery must touch JSONL, not just memory.** In-memory `messages[]` and the JSONL events are
  two data structures; a "fix" that only edits `messages[]` leaves the poison on disk and it comes
  back on the next resume.

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
nowhere — that constraint is the only thing keeping the runtime honest. Agent tree = task tree; each
task gets a worktree and a branch off its parent's branch.

**Files whose name does not tell you the thing you need to know.** Everything else is findable with
`list_files`; this fails by OMISSION, so add a row when you add a file a newcomer must find.

| file | the part you would not guess |
|---|---|
| `src/data-paths.ts` | THE resolver for every path built from `dataRoot`, and `resolveDataDir()`. A grep test fails if a second site computes either, anywhere in the repo. |
| `src/done-payload.ts` | the one source for done()'s content shape. Imports only zod, so the type layer and the tool layer can both import it without a cycle. |
| `src/orchestrator-tools.ts` | every matrix tool definition **and** `buildAllToolDefs`, from which the external-MCP tool list is built. NOT the file-search `search` — that is `src/tools/definitions.ts`. |
| `src/event-store.ts` | append-only JSONL. eid/parentEid chain, `setChainHead` for rollback and repair. **Never truncates.** |
| `src/events.ts` | event types, `buildSessionRepair`, and `walkActiveChainIndices` — the ONE definition of "which events count" |
| `src/event-converter.ts` | `walkEventsToMessages`, called **"the walker"** everywhere else and defined nowhere else: JSONL → `messages[]`. The live path delegates to its callbacks, so a live/reconstruction drift starts here. |
| `src/task-operations.ts` | the shared CRUD ops. MCP and REST are both thin wrappers over these. |
| `src/test-utils/api-message-rules.ts` | the MEASURED Anthropic message-shape rules, and the prefix-vs-sendable split |
| `src/context-window.ts` | asks the endpoint. There is no table and no fallback. |
| `.mxd/plugin/scope-opts.ts` | `buildMatrixScopeOpts` — the one place that knows matrix's tools, prompt and hooks |
| `.mxd/plugin/web/event-handler.ts` | UI event → log entries. `queueEntryToUIEvent` is the materialization gate; `pendingReducer` is pending. |
| `.mxd/plugin/message-editability.ts` | where the three Edit/Rewind judgments meet, and the only place they may. Has zero imports, asserted by a test. |

---
# The Agent Loop
---

## An agent never ends; it parks

Completion is `done()` and nothing else — `end_turn` with no tool call is an implicit yield, never
an implicit done. `handleImplicitYield` is the ONE place every path that stops working ends up,
which is what keeps "what is this agent waiting for" from becoming five states.

**On resume the loop reads its state off the JSONL SHAPE — never off an in-memory flag — and there
are exactly four shapes.** The enumeration is here because the rule attached to it is a CONSTRAINT
on the set, and a constraint on a set the reader cannot see is unusable:

| shape | what the tail of the active chain looks like | what the loop does with the queue |
|---|---|---|
| **yield resume** | last tool_call is `yield` with no result, **or** the last provider content is `assistant_text` (an implicit yield) | skip the drain entirely; the yield handler consumes |
| **done resume** | last tool_call is `done` with no result | skip the drain entirely; the wake path writes the done tool_result |
| **interrupted resume** | none of the above, and the reconstructed messages END on a `user` role — the shape repair leaves behind | NON-blocking drain: take what is already queued, do not wait |
| **fresh start** | anything else, including a session with no events at all | blocking wait for the first message |

**That is why every proposal to add a FIFTH is weighed so carefully**, and why the `interrupt`
marker is not one: it is an ordinary queue message the loop happens to write about itself, so it
lands inside the shapes above rather than beside them. **The rule to check any proposal against is
that each shape must be decidable from the JSONL alone** — the moment a fifth needs a flag that only
exists in memory, a crash makes the loop unable to tell which state it is in.

`hasPendingImplicitYield` must stop at `messages_consumed`. It used to walk straight over
consumptions, land on the `assistant_text` from BEFORE the message, and report a park — so the loop
parked on a conversation ending in an unanswered user message, and **a message drained into a turn
the daemon died inside was silently never answered.** The window is a whole API call wide.
`thinking` is deliberately still transparent to it.

## Only launching agents that will act

> **`in_progress` is not the question and never was.** Status says the node was never finished. It
> says nothing about whether anything is owed, and dormant nodes have been `in_progress` for weeks.

One daemon boot auto-resumed 14 nodes and every single one looked at its log, found nothing to do,
and parked. Only 8 got as far as connecting MCP, and those 8 cost **32 subprocesses and 1.58 GB**,
held for the daemon's life, because a parked session never ends. `shouldLaunchAgent(events)` now
answers "is anything owed here" BEFORE the session exists, because `runAgentForNode` connects MCP,
builds work_context and writes `session_config` before it ever looks at the conversation.

**It is an EXTRACTION of what the loop already decides, not a second opinion.** If the two ever
disagree the loop wins and the predicate is wrong.

**The cost did not vanish; it MOVED onto the path where a parent is waiting for its children.** A
parent used to be launched at boot and sit parked, so a child's `task_complete` woke a live agent in
microseconds; now that completion has to LAUNCH it. That is the intended trade, and it is invisible
in "32 → 0", which says what stopped being spent at boot and nothing about where it goes when it IS
needed. **Removing an eager cost relocates it to the moment of first use — ask what is waiting
there.**

**The boundary condition on hoisting ANY such decision is not the obvious one.** It is *not* "the
steps before the loop only read the log" — two of them manufacture input. The rule is that **a
decision can be hoisted iff every input it consumes is computable WITHOUT performing the step that
would create it.** Stated the wrong way round, the next person concludes that a step which appends
is disqualified, the opposite of what holds. **A corrupt log whose repair cannot be expressed
LAUNCHES**, so it reaches `runAgentForNode` and gets reported; swallowing it into "nothing to do"
turns a loud failure into a node that never comes back.

The one genuinely new rule is the `interrupt` exclusion, a subtraction with a single named member:
it is the only message the loop writes ABOUT ITSELF rather than delivering as input. **It keys on
`source` and must not be widened to "quiet"** — `quiet` describes one moment of delivery and does
not survive to JSONL, and the generalisation is wrong on its own terms, since crash-recovery
`task_complete` is delivered quiet *specifically so it does not double-launch*.

A log ending in `thinking` PARKS, and the predicate agrees with the loop rather than out-guessing
it: the turn is deferred, not lost. **Measured against production, a thinking block is positionally
IDENTICAL to a text block**; only the TRAILING assistant message 400s.

**`launchingNodes` is a MUTEX over a race condition, and its window is `git worktree add` — the
seconds between "we decided to launch" and "the session exists".** It must be taken with no await
before `beforeChildLaunch`, or it guards nothing: two concurrent launches both used to get through,
and the loser's throw marked the node `failed` and sent a bogus `task_complete(failed)` while the
winner was still running. **Never add a node to it from outside `runAgentForNode`** —
`autoResumeProjects` once pre-registered every node it was about to launch, `runAgentForNode` saw
the set and returned early, and no agent ever started. **Three consumers time those same seconds,
which is why they read as unrelated bugs until you notice the window is one window.**

**The third was `close_task`, and it is shut — by ANNOUNCING the launch instead of adding a guard**
(`01KYNAKQDJTMVXWCQ3T62FHMZA`). `onLaunch`, Matrix's one-line flip to `in_progress`, used to run at
the END of a launch, after the seconds of
`beforeChildLaunch`; it now runs as the first statement inside the lock's own synchronous tick, so
`close_task`'s existing `in_progress` refusal covers the whole launch. **The window is ZERO rather
than smaller**, on the same discipline the lock rests on — check, `add()` and flip are one tick with
no await between them, so nothing can interleave. Two fixes that would have added a SECOND source of
truth (ask `ctx.launchingNodes`; give `closeTaskOp` an `awaitLoopExit`) were on the table and the
user rejected both: 「启动的时候必须先等状态改好 不然不能启动…而一旦 status 被设置成 in progress
就没有人能随意动他了」.

**TWO doors reach that window and only one goes through `onLaunch`** — the REST `/continue`
reactivation branch writes `in_progress` itself, so fixing the hook alone leaves a node closable for
the whole worktree create on the other door. The rest of the map, because no single file shows it:
`deliverMessage`'s root branch already flipped synchronously with its guard, `/continue`'s
has-worktree branch and `/restart` flip before launching, and `autoResume` needs no flip because it
only resumes nodes already `in_progress`.

**Announcing first makes the FAILURE path load-bearing, and the two doors answer it differently on
purpose.** A throwing `beforeChildLaunch` used to leave the old status and now leaves `in_progress`
— a node with no agent, which `close_task` refuses. On the `deliverMessage` door that is not a new
state (`reportAutoLaunchFailure` marks it `failed`, as before; the Phase 2 relaunch only logs and
relaunches a node already `in_progress`). The REST door has no such handler, so it **restores the
status it found** — leaving `in_progress` would hand the caller a 500 plus a node they can no longer
close, which is *Never offer a remedy that will not work* arriving as a state rather than a message.

**Holding the window open is what makes any of this testable, and it is cheap**: a gated
`beforeChildLaunch` parks the launch, the test calls `closeTaskOp` from inside it, and asserts the
DAMAGE — refused, and no worktree removal requested. Against the pre-fix code both door tests fail
with `Expected promise that rejects / Received promise that resolved`, which is the bug stated
exactly.

## done() is two-phase

done() used to do everything inside the tool handler — status update, parent notification, queue
close — and it raced with messages still arriving. So **Phase 1 is agent-side** (close the queue,
exit the loop, no status update; done() is an *intended orphan* like yield, no tool_result written)
and **Phase 2 is daemon-side** (status → verify/failed, `task_complete` to the parent,
`done_notified` for crash recovery). `session = null` is the irreversibility boundary.

**`task_complete` must be DURABLE before `done_notified` is written.** The marker means "Phase 2
finished", so if it lands while `task_complete` has not, a crash in that window leaves the parent
waiting forever with nothing to re-deliver; the reverse window merely re-delivers a duplicate. The
naive version looks fine, because the marker lands on this node's write queue synchronously while
`task_complete` goes through `await getTracker` first.

**The loop promise must settle on EVERY path**, resolving inside the `finally`, throws logged and
not rethrown. `stopTask` awaits it with **no timeout**, so one leaked promise hangs the stop
forever.

**Auto-launch failure IS task completion.** When `beforeChildLaunch` throws the target never runs,
so no done() ever fires and the sender's `yield` hangs forever; `deliverMessage`'s catch marks the
node `failed` and delivers `task_complete(success: false)`, and the sender wakes through the
existing resume flow because "failed before starting" and "failed during work" are indistinguishable
from its side. **Any code path that could silently hang a yielding parent must notify via
`task_complete`.**

**Writing that handler and making it survive its OWN failure are two different problems, and the
second bites in exactly the shape the first was built to prevent.** The original was `.catch(async
e => {…})` doing error event → status flip → `save()` → deliver. An `async` function passed to
`.catch()` has nobody to catch **it**, so a rejected `save()` escaped as an unhandled rejection —
and because the notification was last in a straight-line body, that rejection **skipped** it, so the
handler whose entire purpose is "a parent must never wait forever" hung the parent at the one moment
something had already gone wrong. **The shape that holds:** a NON-async `.catch` where each COSMETIC
step sits in its own try/catch and the LOAD-BEARING delivery comes last but cannot be starved. Do
NOT collapse that into one try/catch around the whole body — that converts a loud unhandled
rejection into a silently skipped notification.

**Price what that fix COST, because the trade recurs: making a failure survivable also removes the
pressure that would have got it fixed.** A separate latent race — a test's `afterEach` deleting a
dataDir while an agent it auto-launched was still writing — used to surface as `# Unhandled error
between tests` with `bun test` exiting 1 on zero failures. Ugly, and the only reason anybody found
it. Now it prints `[launch-failure] could not persist failed status for <id>: ENOENT` and the suite
exits 0. The trade is right, and it is not free: **whenever you make a failure survivable, say what
the NEW detector is, in the place the old one used to fire.** Here, grep the run output for
`[launch-failure]`; waiting for red no longer works.

### An unhandled rejection is an outage here, not a log line

**A rejected promise with no handler inside a Bun Worker ends the worker thread.** Its pending
timers never run and the daemon sees `worker.onerror`; in a plain Bun process it exits outright. So
a floating rejected promise in the runtime is a way to kill every agent in that project's lens, and
that death is indistinguishable from a real crash to anyone reading the log. **The hang was the mild
half** — worth saying in those words, because the obvious framing ("a parent waits forever")
describes the bounded consequence and silently sets the priority for the whole class from it.

**`MessageQueue.enqueue()` returns `void | Promise<void>`**, returning the Promise exactly when the
before-first-message hook is armed — a fresh session, and after every compaction re-arm. The idiom
around it is a sync `try/catch` at five production sites including `deliverMessage`, and **a sync
try/catch does not cover the async branch**: the rejection escapes and `return "enqueued"` reports a
delivery that may not have happened. Full classified census in `01KYDEFRM5WBDCRXPTGX75FYZ2`.

**DECIDED (`01KYDESAKCW186VZ8GEK6TW91W`): the worker should install an `unhandledRejection` handler
that LOGS AND LETS THE THREAD DIE.** It looks like the swallowing catch this file keeps arguing
against, and what resolves it is *what the handler does after it logs*: log-and-die is pure
attribution, turning an anonymous worker death into one that names the lens, while log-and-swallow
is the swallowing catch at PROCESS scope — worse than the per-site version, because the worker
carries on in an unknown state while writing JSONL and managing worktrees.

## The done() payload, and the boundary it defends

**The runtime must not know what a plugin's completion MEANS.** `done()` has exactly two
agent-facing params — `status` (a control bit routing the node to verify/failed) and `result`
(required, non-empty) — and `resultRounds` gets ONE block APPENDED per `done()`, never overwritten,
so a task woken and re-done N times carries N rounds in call order.

The runtime MAY read `status` and ONE completion-output string. It MUST NOT carry the round
structure or any other content field — those are read only inside matrix's `onDone`, and the runtime
passes the raw done input through as an opaque `Record`. **The check is a grep**: `resultRounds`,
`appendResultRound`, `parseDonePayload` and `DonePayload` appear in `src/runtime/*`, `runtime.ts`,
`provider-shared.ts` and `events.ts` only inside boundary-explaining comments.

**Testing opacity requires data only the other layer understands** — the robustness test uses a
non-matrix scope whose `done()` carries `wordCount` and `mood`. Testing with the default plugin's
own fields cannot distinguish "passed through opaque" from "reconstructed into that plugin's shape".

**KNOWN LIMITATION: crash-recovery Phase 2 does not append a resultRound.** It is plugin-agnostic
runtime code that sets status directly and never calls `onDone`; wiring it in would either break the
boundary or route crash recovery through a plugin hook.

## A request inside a `done()` result is owed to nobody

**A result round is append-only history. It can RECORD a request; nothing executes it, and nothing
turns red when it is ignored** — so *actioned* and *forgotten* leave the identical trace. That is
*Two situations, one observation* in the one medium every task in this system ends with.

**The need is real, and it has already invented a vocabulary with no receiver on the other end.**
Measured by `scripts/scan-unowned-requests.ts` over every result round in every registered lens (134
rounds, 727 tasks, 572K chars): **28 rounds carry request-shaped prose, 15 of them naming no task id
anywhere**, and the ADDRESSED form appears in six spellings across six tasks that
could not have copied each other — `FINDING ROOT SHOULD ACT ON`, `TWO THINGS FOR ROOT`, `FOR ROOT`
plus *three things I could not do myself*, `FOUR THINGS FOR ROOT TO DECIDE OR KNOW`, `Open for
root`, and *left for root to decide whether it becomes a task*. *When agents repeatedly do X, ask
whether the motivation is legitimate*: it is, so this wants a destination rather than a prohibition.

**The failure is not that nobody reads it. It is that the reader has a LIFETIME.** The 2026-07-30
cold read placed 8 findings out of scope; re-checked against the file two hours later, **6 were
already fixed**, and one of the two survivors was a pair of forward references the reader had
judged fine — so the residue was ONE item. That reads like a success and it is a coincidence:
reading the commits' `Task-Id` trailers, every fix was committed by the CHILD that had just merged
the report, inside the 90 minutes before it closed. What executed those requests was a second agent
that happened to still be alive. **And the outcome cannot tell you which findings were ACTIONED** —
three are named in one commit's subject line, while the `Drained` taxonomy row came back inside an
unrelated pass restoring 13 dropped rules.

**The previous run is the other end of that range: the same step with the executor gone.** The
2026-07-25 cold read's report was never actioned. Five days later a full regeneration re-derived
its placement, region-balance and cross-reference findings as a side effect of reorganising — and
every finding that needed its own separate act, define a term, add a map, delete a label, died.
**A process that lands only the findings a later pass would have regenerated anyway is getting
nothing from the cold read**, which is the half nothing else can produce. One round of
`01KYQKY5S2826C4SNMWM0MVN6T` shows both behaviours at once: one finding it FILED as a node, one it
left as *"for root to decide whether it becomes a task"*. Both got done, because somebody was
attending. `01KYJ4E7JERXZFJCQDB5SB9GQ6`'s did not, and a human cleaned it up by hand two days later.

> **`close_task` is the deadline.** A request still in prose when its task closes is not pending —
> it is gone, and the round it lives in will not be read again.

**The remedy is the one medium here that holds OWED rather than RECORDED: a node.** `create_task` is
unrestricted anywhere in the tree, so the reporter can always file, and the result then names the
id. That is also what finally separates the two worlds inside a single sentence: **an owned request
carries an id and an unowned one does not.** 13 of those 28 rounds already do it, so the rule
codifies a practice rather than inventing one. **SCOPE on both counts: the scan matches sentence
SHAPE, and "names an id" is a proxy** — the id may belong to something else in the same round. Read
the hits before quoting the number as an adjudicated backlog.

**Answer the obvious objection in the text, or the rule reads as bookkeeping.** *"There are ~130
drafts nobody has actioned, so filing a node changes nothing."* The node does not promise action; it
changes the failure mode. An unactioned node is `pending`, statused, searchable and visible in the
tree — a backlog you can see and decide against. An unactioned paragraph is not a backlog at all,
because nothing records that it is owed. **The win is converting gone into pending**, and 130
visible drafts is a decision where an unknown number of buried requests is not.

**NEGATIVE RESULT — do not give `done()` a `requests` field.** `lessons` was exactly that shape and
was deleted on the user's call (`01KXKCJW9P26RPPXKCTGDV4BPJ`), and ownership kills it independently:
a typed list inside an append-only round still has no status, and it would stand beside
`create_task` as a second way to create a task. **`done()` also cannot warn** — it is an intended
orphan that writes no tool_result, so nothing said there ever reaches the agent. The doors that do
reach one are the `result` param's own description, read at the moment the sentence is being
written, and the system prompt at both ends: *Before calling done("passed")* for the writer,
*Merging is signing* for the reader.

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

So do not "simplify" it away by analogy with the compaction deferrals that were deleted: nothing
separates the extras' results from the real yield's in JSONL, so splitting the live push would
require inventing a JSONL boundary event — strictly more machinery. The compaction deferrals were
removable for the opposite reason, because the summarization instruction is never persisted at all.

**Duplicate `done()` calls must exit as orphans.** Emitting tool_results for all of them was tried,
to avoid a repair path; it works, and it costs behaviour — with every done answered, resume detects
a generic interrupted-resume instead of a done-resume, so the woken agent silently loses its
done-resume context.

## Compaction: ONE path

`/compact` enters the ordinary path unconditionally, whatever the conversation looks like.

**Do NOT add a short-circuit for a conversation "too short to be worth compacting".** There was one,
twice, and each bricked sessions in its own way: v1 emitted the markers **without rebuilding
context**, so the next launch started on an ASSISTANT turn and every request 400s; v2 — the fix for
v1 — cleared the flag and continued with nothing pushed, so the very next request ended on the
assistant message the agent had parked on. **Shortness caused neither. Being a SECOND PATH did**: v2
inherited the shape of the thing it was patching rather than the correctness of the path next to it.
The cost of not having it is one API call and a near-useless summary when a human compacts a
two-message session, which is the price of the user asking.

**What made the deletion safe is worth more than the deletion: the branch's one real obligation had
already moved out of it.** It used to consume the pending tool_result and the duplicate-yield extras
— the **pairing** rule, which is real. That now happens where the tool_result is EMITTED, so the
ordinary path inherits it for free.

**STANDING DEFECT of the automatic trigger: a session with ≤4 messages cannot auto-compact no matter
how large it is.** One giant tool result puts a 3-message session over the threshold and it keeps
calling the API until the context window rejects it. **Why the floor exists at all**, since "delete
the magic 4" is the obvious reading and would reintroduce something worse: a freshly compacted
session sits at ~1 message, so if the token count is STILL over threshold the loop would compact
again immediately, forever. **The floor is a PROXY, and a bad one: the condition it stands in for is
"compacting will not reduce anything", which has nothing to do with message count. If you replace
it, replace it with a measurement, not a smaller number** — compact, and if still over, say so
loudly and stop auto-compacting for that session. "Even a full compaction cannot get this under the
limit" is a real configuration problem the user needs to see, and both of today's behaviours hide it
equally well. Code-level half of `01KXNZHYSJFF0BVQJVPG2WC1RV`.

**Session config is refreshed at the compaction boundary, and only there**, because compaction wipes
`messages[]` so the cache is already lost — `cacheTtl` excepted, to preserve fork inheritance.

## Interrupt and stop are two abort channels, and they cannot be one

**An interrupt takes a running agent from mid-turn to idle-waiting-for-input and tears down
nothing.** A stop is teardown: kill background processes, close the queue, drop the session,
disconnect MCP. They were the same button in the UI before this — it wore a pause icon, said
"Interrupt", and called `stopTask` (`01KYBB2ZWQQDTSXE3V110PGT0Y`) — and they are opposite verbs.

The signal is `TaskSession.interrupt`, deliberately **not** `session.abortController`. Sharing one
channel gives you either "an interrupt tore the session down" or "a teardown was mistaken for an
interrupt so it could not tear down", and **both are silent**. They meet in exactly one place,
`AbortSignal.any([teardown, interrupt])`, and every reader checks teardown FIRST.

**No repair is owed, and that is the point.** `stopTask` leaves tool_calls unclosed because the loop
is already dead, so the next launch's repair writes *"interrupted by daemon restart"* — false
whenever a human pressed stop, and re-read by the model on every later turn. An interrupt keeps the
loop alive, so it closes its own tool_calls before parking.

**Partial assistant text is KEPT, deliberately.** It makes the interrupted state representable on
disk with zero new resume states; it gives the user's next message a referent, because "no, don't do
that" needs the text they were reading; and emitting it as a normal final `assistant_text` is what
clears the UI's streaming partial. Never the thinking blocks (no signature), never a half-emitted
`tool_use`.

**Do NOT front-run the queue when parking.** A message drained at the cancellation point would be
merged into the turn's user message and then sat on — the loop would wait for a *further* message
before calling the API, so "stop, do X instead" would look swallowed. Left in the queue,
`handleImplicitYield` returns it immediately. **`consume()` is called when the loop PARKS, not when
it decides to**; clear the flag at the decision point and a stop landing as the agent goes idle on
its own leaves the flag set, swallowing the next message.

Compaction turns are not interruptible mid-flight — the summarization instruction is already in
`messages[]` and cutting there pairs "summarize yourself" with whatever the user says next. And
**`done()` wins a race with the stop button**, because that is completion, and marking it "not
executed" would strand the parent forever.

**"I pressed stop, then restarted the daemon, and it started working again" used to be an accepted
boundary, and how the trade CHANGED is the transferable part.** In the window *interrupt → restart
with no message between*, the log could not tell "the user stopped me" from "I died mid-work" — an
interrupt during a tool leaves tool_results, byte-for-byte what a daemon death inside an API call
leaves. The stated price of fixing it was a persisted marker, i.e. a fifth resume state, which this
design refuses. **What changed is that the marker acquired a second, unrelated buyer**:
`shouldLaunchAgent` has to answer the same question before a session exists. One `message` event
with `source: "interrupt"` settles both, and it is NOT a fifth resume state — resume still reads
exactly four shapes; the marker is an ordinary queue message the loop happens to write about itself.
**A cost rejected as "a new state in the state machine" can become payable as "an existing mechanism
used once more", and those are worth re-pricing separately.**

## Agent activity: live process state is asked for, never replayed

"Is the agent working" was three layers of heuristics stacked on a boolean that itself had three
sources — a 500ms poll, a timer, and a correcting re-poll, each covering the layer above it. It is
now ONE explicit state in backend memory (`01KYBBEBYP4EFMSHFAMS43PMDF`):

> **State is never derived from the event log. On connect the client ASKS; while connected the
> server PUSHES.**

The log records *"it became active at some past instant"*; replaying that as *"it is active now"* is
a category error, and the old poll existed only to undo the error it had just made. Note the exact
inversion against pending messages, which ARE a projection of a persistent log and correctly use a
reducer over events. **The question to ask is "does this thing exist on disk?"**

`AgentActivity = "idle" | "thinking" | "tool"`, and the split the user drew is **"is the MODEL
running", not "is something happening"**: `idle` no, `thinking` yes, `tool` **no — the API has
already returned and we are executing what it asked for.** `thinking` and `tool` are both alive and
they are **two different kinds of alive**; that is the semantic foundation the interrupt work stands
on rather than a display detail, because only one of them has an in-flight request to cancel. `tool`
is the precise one because it is the only state with an unclosed tool_call. **`thinking` is
explicitly the residual** — every other way the loop is alive — which makes retry backoff, session
setup and compaction turns consequences rather than special cases. Known naming debt, deliberately
unfixed: a compaction runs 2-3 minutes and "Thinking…" across it is the same kind of lie this model
removed; adding `compacting` later is a pure carve-OUT of the residual, cheap precisely because the
residual is written down.

**Rejected framing, offered and vetoed: defining the states by what feedback the user sees**
(spinner vs tool card). That defines backend state in terms of frontend rendering — the same class
of error as deriving it from the log — and collapses the moment a UI affordance is added.

It lives on `TaskSession.activity`, so it dies with the session and there is no second lifecycle to
keep in sync. **The field write and the broadcast must happen in the same function**, which is why
the setter is passed INTO `handleImplicitYield` rather than the event emitted there and the field
written at its four call sites — split them and call site number five gets only one half.

**`idle` is announced only when the loop will ACTUALLY park.** Not flicker avoidance: it is what
makes `idle` mean "waiting for you" rather than "reached a yield point", and both consumers depend
on the stronger meaning — `yield_external` wakes an external client on it, and the UI re-fetches
JSONL on it.

**There is a `thinking` transition on the way OUT of idle, and the argument for omitting it was
wrong in an instructive way.** The reasoning: every path leaving `handleImplicitYield` reaches the
API block, so a second setter is unobservable — *the emitted event sequence is identical either
way*. True, and irrelevant, because **consumers read the STORED value, not the event stream.**
Without it the whole wake window reports `idle` for a loop that is provably not parked.

**`agent_activity` is a broadcast-only delta and must never reach JSONL** — that is what makes
"replaying history cannot fake-activate an agent" structurally true instead of corrected afterwards.
A separate snapshot goes daemon→client on SSE connect, **sent even when empty**, because "nothing is
running" is exactly what a client reconnecting after everything stopped needs in order to drop stale
entries. One consumer is invisible to a grep for `activeAgents`: `yield_external` subscribes to the
`agent_idle` **event type name**, now matched via a predicate, and **the reported reason string
stays `"agent_idle"` because that is the tool's external contract.**

## An anomalous stop idles the agent silently

**The class is the silent indefinite hang, and it is the worst failure shape an autonomous
orchestration has** — not a crash and not an error, but a node that never speaks again while the
parent's `yield` waits for a `task_complete` nobody will ever send.

An assistant turn returning **thinking only** — no text, no tool_call — makes the loop see
`toolUses.length === 0`, treat it as end of turn, and implicitly yield with no user-visible signal.
For a root in conversation this is benign; a human eventually pokes it. For an autonomous sub-agent
nobody is watching, **nothing bounds it — and a daemon restart does not rescue it either, because
restart RE-IDLES an implicitly-yielded agent instead of continuing it.** That is why the live case
sat idle for **8 days** rather than until the next restart: the mechanism that recovers almost
everything else is precisely the one that cannot see this.

Our gap is `getStopReason()`, and naming what it does is the whole argument for the fix: it
**collapses every non-`end_turn` reason — `refusal`, `pause_turn`, `model_context_window_exceeded` —
onto `tool_use`**, so several different situations reach the loop as one value. The guard (draft
`01KXK69KKKGG4XHPH7EWGNY5AC`) is a persisted, user-visible error event **before** idling for any
stop reason outside `{end_turn, tool_use}`, plus a bounded `pause_turn` continue.

**Agent time perception is DATE-BLIND, and it fails confidently.** Context timestamps are
`[HH:MM:SS]` with no date, so the 8-day agent woke and reported "~80 minutes" — 14:56 → 16:13 looks
same-day. **Ground truth is the epoch `ts` in the JSONL.**

---
# Tools the Agent Calls
---

## Bound the output rather than forbidding the workaround

**Agents piped and redirected for a legitimate reason — context was genuinely at risk — and rules
against it leak at the edges.** So the tool satisfies the need instead: under 1KB is inline only, up
to 10KB is full inline plus a saved file, over 10KB is head 5KB + banner + tail 5KB with the
complete output on disk. Now the instinct has nothing to act on. Streams are merged by wrapping in
`bash -c "(cmd) 2>&1"`, which makes an agent-written `2>&1` a harmless no-op, and foreground and
background share one `formatBashResult` so a `background_complete` is byte-identical to the
foreground result.

> **When agents repeatedly do X, ask whether the motivation is legitimate, and if it is, make the
> tool satisfy it naturally instead of enforcing against it. If you find yourself adding a parser, a
> rejection or a warning to the new tool, you have drifted** — the point is to make the shortcut
> unnecessary, not forbidden.

The "don't pipe" guidance lives in the bash tool's `description`, not in the system prompt, because
that is where the decision to pipe is made.

## The bash result names its own working directory

**The failure this removes is invisible by construction.** After a `cd` out of the worktree every
later command succeeds, `git status` reports cleanly, and the output looks authoritative. An agent
in another project `cd`'d into this repo, missed a one-shot warning, then built a five-link evidence
chain — empty `git status --porcelain`, `ls` returning "No such file or directory", a `git
check-ignore` hit — and **filed a two-bug report against this daemon.** Every link was individually
valid; they were answers about a different repository.

> **A one-shot notification cannot signal a persistent condition — the notification's lifetime has
> to match the state's.** The old warning fired at the moment of the `cd` and never again, so it
> covered the one result the agent was already paying attention to and left silent every result
> where the mistake does its damage.

Now every result whose cwd is not the worktree root opens with a line naming it, and the quiet state
is EXACTLY the root. Once every affected result carries the state, the transition warning's firing
condition is a strict SUBSET of it, so keeping both prints the same fact twice. What is NOT
redundant is `workdir set to X from now on`: that reports an EVENT, the notice reports a STATE.

**Which checkout a directory belongs to is answered by `git rev-parse --show-toplevel`, and both
obvious simplifications are wrong.** A path-prefix test calls `.worktrees/<other-task>` "inside",
because it IS under the main repo root — and for root that covers *every* other agent's checkout,
the single most dangerous place to stand unknowingly. A hand-rolled walk up to the nearest `.git` is
wrong too, because **a linked worktree's `.git` is a FILE**, so an `isDirectory()` test resolves
every agent worktree to the main repo. Asking git cannot drift from git. The `2>/dev/null` is
load-bearing: outside a repository `git rev-parse` fails loudly on stderr, that case is NORMAL, and
merged mode would fold it into the command's own output.

**The other end of the same guarantee: `cd` to the directory you are already in is a free no-op**,
so an agent unsure where it is can just say so. A shell `cd()` override that errored with *"already
in this directory"* had every line of its body existing to produce that error; with the error gone
the remainder is strictly worse than the builtin it shadows — it breaks `cd -`, and an empty
argument stops meaning `$HOME`. **Prefix a `cd` whenever you are not sure where you are.**

## The two filesystem walkers, and a library default serving somebody else

`search` and `list_files` each had the SAME two defects, and finding the pair a second time is what
turned two bug reports into a class. **Neither walked hidden directories**, because
`Bun.Glob.scanSync` defaults to `dot: false` and nobody passed the option — and in this repo the
hidden directory IS the source: `.mxd/plugin/` is 34% of all non-test source. **And a glob with no
slash was treated as a path pattern**, so `*.ts` — the example printed in the tool's own description
— matched only files sitting directly in the search root. A slash-free glob is now promoted to
`**/<glob>`; one containing `/` is a path pattern. Same split ripgrep makes.

> **What makes this class invisible is that there is no line to review.** Nothing said "skip hidden
> directories" or "match only the top level" — the semantic lived in a library's default, i.e. in
> the *absence* of an argument, and **code review cannot catch an absence.**

Hence the discipline at every walker: **decide every behaviour you depend on explicitly, even when
you agree with what you would have got for free.** Stating a choice you were already getting is not
noise; it is the semantic becoming visible and therefore reviewable.

**The second-order damage is why this is a section: for as long as such a bug lives, the tool's own
description is teaching agents the wrong rule.** `list_files`'s examples were `"src/**/*.ts"`,
`"**/*.test.ts"`, `"*.json"` — the first two anchored, the third silently meaning something else.
The defect was never that `*.json` returned the wrong three files; it was that **a reader
generalises from the neighbours.**

Three consequences that will look like oversights:

- **The 500-file cap counts files we KEEP, never files we walked past**, now structurally guaranteed
  by pruning at descent. With `dot: true` and no skip list, an any-depth `*.ts` filled 323 of its
  500 slots with `.worktrees/` copies and never reached `web/`, `scripts/` or `.mxd/` — so `dot:
  true` alone is strictly worse than the bug. Do not ship the two halves separately. And
  `.worktrees/` in `DEFAULT_SKIP_DIRS` is load-bearing while costing nothing today, so it needs an
  assertion: the guard test will not fail before someone "tidies" the list.
- **`walkFiles` is the ONE walker for both tools and prunes before opening a directory**, so the
  walk now costs what the ANSWER costs. `list_files` had to move onto it too: two tools sharing
  three predicates but disagreeing on WHEN to consult them give those predicates two meanings
  depending on the caller.
- **Sort must live in exactly ONE place**, because both caps SLICE the sorted list, so in traversal
  order "the first N" is an arbitrary set that can differ between runs. `list_files`'s cap therefore
  bounds the RESULT and can no longer bound the walk — sorted output and early termination are
  mutually exclusive — which is fine now that the walk it no longer bounds is the cheap one.

**The tidiest-looking way to write that walk — `statSync` instead of lstat-based dirents — is wrong,
and wrong in a way that makes `dir/link -> dir` walk forever, with nothing in the suite going red.**
`readdirSync`'s dirents are lstat-based, so a symlink answers false to BOTH `isFile()` and
`isDirectory()` and is dropped by both branches. `statSync` is wrong twice over, and the second half
is the one someone would defend as a feature: it also starts returning symlinked files `search` has
never returned, so one file is reported under two or three paths. **Not following links is also the
entire termination argument** — there is no visited-inode set and it needs none.

**Errors must THROW, not be swallowed.** The first version wrapped `readdirSync` in try/catch with a
comment asserting that matched `scanSync`, written without measuring it. Swallowing turns "your path
is wrong" and "the directory holding the definition is unreadable" into `(no matches)`.

### Detecting a silent under-report, and the asymmetry that matters

"No matches" and "never looked" produce a byte-identical tool_result, so a false `(no matches)` can
never be caught by inspecting the answer — only by a **collision with something you independently
already know**. And you search for things you do NOT already know, so it is indistinguishable from
the truth AND confirms your hypothesis.

**The empty result is the detectable one; the partial result is the dangerous one.** Same bug, same
tool, same agent, 38 seconds apart: a long confident answer that silently omitted the file
*defining* the symbol went unchallenged and was acted on 2 seconds later, while an empty result for
something the agent had read 5 events earlier got double-checked immediately. **An under-report is
only conspicuous when it takes everything away, which is the case that matters least** — so do not
file a bug in this family under "detectable" because of its output SHAPE.

### Before letting a compatibility worry veto a change, measure what it produces today

*"A semantic that has never worked has no users"* settled the `search` glob change in one line. It
proves nothing for `list_files`, where `list_files("*.json")` returned `package.json`,
`tsconfig.json`, `biome.json` — three real, plausible files. **The rule is only decisive when the
old output was EMPTY**, and a rule is at its most dangerous exactly when it happens to point at the
answer you already want.

> Not "is anything calling this" — *what does the call return today, and does it answer the question
> the caller was asking?*

The common and more dangerous case is non-empty output that does not answer the question, which is
what happened here: the capability being defended was `list_files("*")` as a "show me this
directory" affordance, and `scan()` defaults `onlyFiles: true`, so `*` returned a dozen loose files
and **not one directory** — for the DEFAULT pattern of a tool whose description claimed it answered
"what is the shape of this project". **The capability being protected did not exist.**

## Fixing a tool's SOURCE does not fix the tool in your hand

> The tools an agent calls belong to the **running daemon**, not to anybody's worktree. So *"I just
> fixed X, therefore I can use X"* is **false until the daemon restarts** — and false for every
> other agent running at the same time.

**This makes the blind-instrument trap harder to avoid than it looks, because of who walks into it:
the person who fixed the tool is the person with the most reason to believe it works.** The task
that wrote down "a completeness survey run with a blind instrument returns a confident, wrong
'that's all of them'" then ran its own survey on the blind instrument. The warning and the violation
were in the same task.

---
# Events, JSONL and the Active Chain
---

## The event log: append-only, chained, and it never deletes

One JSONL file per task. Every persisted event carries `eid` and `parentEid`, stamped by the store —
callers never set them. **The chain exists so that history can be ABANDONED without being destroyed:
a rollback moves the head, the events after it simply stop being reachable, and the evidence needed
to debug a corruption survives it.** Nothing in this codebase may address an event by file position.

**`{ eid, parentEid, ...event }` is WRONG, and it looks right.** When the input already carries
those keys the spread overwrites the fresh values with the stale ones, while the key POSITION stays
first so the line looks correct. Not hypothetical: `buildSessionRepair` re-appends unconsumed
`message` events read out of the region it is about to drop, and with the naive spread they keep a
`parentEid` pointing at an event no longer on the chain — the walk then hits a break and silently
degrades to linear traversal, **which can resurrect rolled-back events.**

**`append`/`appendBatch` are fully SYNCHRONOUS. Do not "modernise" them to `fs.promises`.** Two
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

"Which events count" had FOUR independent implementations. There is now one,
`walkActiveChainIndices`, and every reader goes through it.

> The active chain ends at the `compact_started` of the last COMPLETED compaction. Inside that
> compaction's window, only `type === "message"` survives.

One backward scan does both jobs, and because `parentEid` always points earlier, scanning backward
IS the lookup — no eid→index map, and a cycle is structurally impossible because the index only
decreases.

**Why the window exists, measured.** Messages delivered WHILE the summarizer runs land between
`compact_started` and `compact_marker`. Ending the chain at the marker put those outside the active
region while the `messages_consumed` acknowledging them — written after the marker — was inside, so
reconstruction resolved a consumption referencing an id it had never seen and dropped the content
silently. On the root session: **22 compactions, 8 with stranded messages, 15 messages lost, 4 typed
by a human.** The live path was fine; only reconstruction lost them. The type filter inside the
window is equally load-bearing in the other direction — the summarizer's own thinking and
`<summary>` text must NOT come back, because the summary is already in context as
`compacted_resume`.

**Do NOT encode the barrier as `compact_started.parentEid = null`.** It looks cleaner — termination
collapses to the chain root and needs zero type knowledge — and it is wrong for two independently
verified reasons. **A compaction is a 2-3 minute window whose outcome is unknown when
`compact_started` is written**, so if the daemon dies inside it there is no summary but the chain
root is already committed: the agent resumes with an empty context, so the "have I been briefed"
check (`hasWorkContext`, which scans the active chain for a `work_context` message) is false, a
fresh work_context is injected, and it carries on like a newborn. No error, no crash — **silent
total context loss**, recoverable only by hand-editing JSONL. And the type check has to exist
anyway, for logs written before `compact_started` existed. The general form, after being talked out
of this twice: **encoding structure in links fits a JUMP (rollback, repair — you know the target
when you write it); a compaction is an INTERVAL whose validity depends on a result you do not have
yet. Do not express an undetermined fact as a link.**

**Being ON the active chain is NOT the same as being a legal rewind target**, and this is the most
expensive corollary of the design. **The active chain is not a uniform `parentEid` chain — it is a
CONSTRUCTED sequence.** The window messages are *spliced in* by the walker, adjacent in the
resulting array but with parent links pointing into the region the summary replaced. Rewinding is a
pure parent-link operation, so **it is only defined where construction order and chain order
agree**, which excludes exactly those messages: set the head to one and the backward walk never
meets a marker, so the entire summarized-away history returns at once with the summary stranded on
an abandoned branch. **Making the window messages visible was correct; reading *visible* as
*operable* is the error.** `hasRewindPoint` answers the separate question, and its test fails on the
DAMAGE — it asserts the resurrected history is absent by name — so anyone relaxing the limit sees
what they just did rather than a bare status code.

**No dangling-link handling, and nothing may produce one.** A `parentEid` naming an eid no line
carries gets NO fallback — same rule as repair refusing to fix orphan tool_results: **a state the
runtime cannot produce must not have code that quietly patches it, or that code becomes a silencer
for real structural bugs.** It shows up as "the events before it stop rendering", which is what we
want. This is only honest because `rewindChainHead` closed the one path that could produce a dangle.

**Fork had its own copy of this boundary and it produced three bugs, one irreversible.**
`copySessionFrom` now calls `readActive`, because "wake up with the source's current context" IS
readActive's definition. A linear slice copied rolled-back events, dropped window messages, and did
not RE-LINK — the active context is a FILTERED subset, so the copied events' original parents are
absent from the child's file and copying links verbatim strands everything older. **The compaction
boundary events are deliberately NOT copied**: only half of one can be, and a lone marker in the
child reads as the legacy unpaired-marker shape, so the child would discard exactly the window
messages it just inherited. **That is the irreversible one — the source recovers on restart, a fork
never does.**

**The compaction boundary is now an ARGUMENT rather than a second function** (user:
*「一起删吧。直接 删掉单独的 readFromLastCompactMarker。如今的 read active 增加选项包含/不包含
compact」*): `walkActiveChainIndices(events, "stop" | "past")`, surfaced on `readActive` and
`streamActive`. AI and UI take `"stop"`; `search_logs` takes `"past"`. **The deleted function was
not a tidy-up — it sliced from the later `compact_marker` and therefore excluded exactly the window
messages the walk splices in deliberately.** Measured project-wide: 38 completed compactions, 15
with at least one message in the window, 27 messages, overwhelmingly user text. **A fixture drawn
from a current tail cannot show this** — its barrier sits at index 0, so both behaviours return the
same thing; the regression fixture has to be constructed with a message inside the window. The UI's
`hasOlderEvents` was computed from that barrier and is now `readActive(id).length < countEvents(id)`
— the same answer with nothing to keep in sync, and `countEvents` streams so it costs no memory.

Why the parameter is load-bearing rather than a convenience: the stopping walk keeps **294 of 71,524
events (0.4%)** on the root session, so a search that always stopped would be searching 0.4% of the
thing it exists to search. What `"past"` still excludes is the rewound branch, and the worry that it
might break on pre-eid files was measured away: **398,792 of 399,057 events across all 455 sessions
(99.93%)**, with 454 of 455 files losing nothing — the shortfall is one file's 265 events on
branches five rollbacks walked away from. **BEHAVIOUR CHANGE, intended: a forked session now shows
its inherited parent history**, because that function also treated `fork_marker` as a start point
and so the UI hid context the model could always see.

## The live path has no construction logic of its own

**Two independent constructions of "how a user turn is built" disagreed about whether an image
carried its caption, and that is the bug this design deletes** (`01KNDS3AQ76SEZCK27SNQW5HAD`).
**Name the cost, because "the two paths disagreed" understates it: a divergence between the live
turn and the reconstructed one is a PREFIX MISMATCH, so the next restart pays a full cache miss on
the whole conversation** — a difference of one line of text and a bill in tens of thousands of
tokens. `buildUserTurn` delegates to the walker's callbacks, and the initial drain goes through
`adapter.appendQueueMessagesToMessages` for the same reason, so there is exactly one implementation
per provider and **the live path cannot drift from JSONL reconstruction, structurally rather than by
discipline.**

**Multiline queue content must stay ONE text block.** Two earlier per-shape builders split queue
messages on `\n` into separate blocks while reconstruction merged them back into one — a guaranteed
prefix mismatch on every resume, and the reason turn-building was collapsed onto a single path.

The yield and done tool_results are the two fixed strings the resume path writes: `"resumed."` for
yield, and for done `"You previously called done(). New messages woke you up:"` plus the working
directory. Queue messages ride as separate text blocks after them, never embedded twice.

**Pre-API-call debug snapshots** land at `projects/<id>/debug/<taskId>/<traceId>/last.json`, one
directory per `runAgentForNode`, ten most recent kept. A restart makes a new traceId directory, so
**diffing the two newest `last.json` files is the post-mortem for any drift or unexplained cache
miss.**

## Repair is a chain jump, never a truncation

`buildSessionRepair` computes a jump and its caller performs it — `setChainHead` + `appendBatch`,
literally the rollback mechanism. Two shapes: append-only (an orphaned tool_call gets its
interrupted result) and jump-back (duplicate or out-of-order results). It runs before the provider
loop starts.

**The whole inheritance from the design this replaced: an index computed in one space and consumed
in another is a silent corruption engine.** Repair used to compute an index while the store
truncated by physical line, and the two index spaces silently disagreed **twice** — once because the
index was computed against the post-`compact_marker` slice while truncation counted from the top of
the file (a compacted session lost its marker, its post-compact `session_config` and its summary,
then got interrupted results referencing tool_calls that had just been cut: unrecoverable), and once
because `read()` skips malformed lines while truncation counts raw ones. Both were fixed with a
translation layer, and the translation layer was then deleted along with `truncateAfterLine` —
**because the second index space WAS the bug.**

Three details that will each look removable:

1. **A truncating repair ALWAYS appends at least one event.** `setChainHead` is pure in-memory; the
   jump only reaches disk as the first appended event's `parentEid`. So both truncation strategies
   append a status event LAST — last so it can never split a run of tool_results into two user
   turns. Without it, repairing a session that resumes in pending-done evaporates on restart and
   loops forever.
2. **Messages in the dropped region are replayed with fresh eids — ALL of them**, not just the ones
   without a `messages_consumed`. A message consumed into a turn the repair just dropped is exactly
   as absent as one that never arrived.
3. **The synthetic status message is a USER message, and it is suppressed when the kept region ends
   in a pending yield/done.** Appending a user message after an unanswered intended-orphan
   `tool_use` breaks the pairing rule and produces a genuine 400. Older text called this an
   "alternation" guard; alternation is fictional and this is not it.

**A synthetic message must not use `source: "system"`.** It was tried; `formatBodyForAI`'s default
branch returns `""` and the UI's materialization switch had no case for it, so the repair reason
**silently rendered as an empty string** in both places. Use `createUserMessage` — do not add a new
source variant to fix a rendering gap.

## Rollback and Edit

**It exists because a vendor handed us a point fix and we refused it.** A streaming content-filter
silently truncated turns, leaving empty and half-written messages in the UI, and the official remedy
was a configured fallback to a different model. We built the general capability instead — let the
user go back and resend with DIFFERENT content, reworded or constrained or on another model —
because that one capability subsumes the vendor-specific need and delivers interrupt, edit and
restart along with it. **The catalyst is now moot and the feature stayed, which is the bet the
decision was making**: a hardcoded fallback would have become dead code the day we changed models.

**SCOPE, decided with the user and never widened: a rollback moves MESSAGES and nothing else.**
Files written, tasks created and commits made on the discarded branch stay made, so a rolled-back
conversation can reference world-state produced by a branch no longer on the chain — an
inconsistency that is ACCEPTED, not pending. That is why the impact dialog REPORTS what the rollback
does not undo instead of undoing it, and why "roll the code back too" is a separate feature with its
own decision (`01KY5H4QPFQ3M4Y5WWDJBFSQNB`). **Branching far back also invalidates the prompt cache
from the fork onward, which is affordable only because every rollback is user-initiated** — anything
that rolls back automatically makes the expensive shape routine.

`setChainHead(sessionId, eid)` is one line: set the in-memory head. The NEXT appended event gets
`parentEid = eid`, creating the jump — **the jump is carried by the first post-rollback event
itself, so there is no marker event.** A `rollback_marker` type and an `appendRollback` method
existed and were deleted. **`/edit` is the single backend path**; a standalone `/rollback` endpoint
was deleted because `/edit` combines rollback and delivery atomically. Rewind is an Edit whose
content did not change, so one answer governs both buttons.

### Which messages can be edited — three independent judgments

| module | question | the limit is on |
|---|---|---|
| `isWorking` | is the agent busy right now? | TIME |
| `messageStartsRun` | did the agent ever run FROM this message? | MEANING |
| `hasRewindPoint` | is there a state left to return to? | HISTORY |

`message-editability.ts` is the only place they meet, and **its checkable boundary is that it has
ZERO imports** — it consumes three verdicts and computes none. **Do not unify them: two people tried
to on the same day, and both reached for the same wrong reason** — see *Taking a PROPERTY of a thing
for the thing itself*. The three judgments' only shared property is that all three grey the button,
which is a fact about pixels.

**The rule is which user turn PICKED THE MESSAGE UP, and the user's own phrasing is the concept:
*only an independently sent message can be rewound*.** "Run" means something only to someone who has
read the provider loop. `buildUserTurn` packs `[...tool_results, ...queued messages]` into one turn,
so **a turn carrying a tool_result is ANSWERING the agent's own previous output** and anything
riding along in it did not start it; a turn with no tool_result exists *because* a message arrived.
Both sides are persisted, so this is decidable from the log — walk back from each
`messages_consumed` to the turn boundary, skipping unrecognised event types rather than treating
them as boundaries.

**`yield`/`done` are the rule's best instance, not an exception to it.** Their results are written
*at wake*, by the very message being judged, so they are that message's CONSEQUENCE and not its
cause; an ordinary tool_result was already in flight before the message arrived, so it is prior
work. **The direction of causation is the rule; comparing tool names is only how it is detected** —
hence the predicate is `isPriorWork`, not `isPark`. This exception was predicted to disappear under
the new rule and instead **grew**: 1513 of 2161 newly-blocked messages were yield turns, and it is
the dominant shape for sub-agents, every one of which ends in `done()` and is later woken.

**The evidence was being sampled at the wrong instant, and that is the reusable finding.** The first
version tested for an unclosed tool_call at the message's **delivery** position. Real trace: a
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

Blocked buttons are greyed and explained, never hidden. Copy is never gated, on two independent
justifications — a silently vanishing control reads as broken, and the cases that most need an
explanation are exactly the ones left with no affordance to carry one; and the row is three buttons,
so hiding makes Copy change position and a list ends up with two-button and three-button rows. Keep
the reason→string map exhaustive over the union rather than partial-with-fallback: that is what
caught a missing i18n key the moment a third reason was added.

## Every transport carries the event's name (eid)

**Four consumers wanted the same missing thing and were each about to grow their own locating
mechanism**: the Edit/Rewind gate, message deep-links, viewport addressing, and "is this event still
part of the conversation". **When several unrelated features independently reach for the same
missing primitive, the primitive is the work and the four features are its callers**
(`01KYBQXSVEP7Y94NWHGWSMNQSM`; the eid/parentEid chain itself is `01KY2TAX4CQAF2V0YF4SCZH6FK`).

**NEGATIVE RESULT, and it is the reason the invariant is *persist before broadcast* rather than the
obvious *stamp before broadcast*: pre-stamping the eid inside `emitEvent` was implemented and
reverted.** It puts TWO mutators on `lastEventIds` — a synchronous `stampEid` in `emitEvent` and the
asynchronous `stampEvent` inside the write queue — which is a **TOCTOU race**: under rapid emission,
or interleaved with a direct append, the parentEid chain breaks and the walk silently degrades. The
eid is stamped in exactly ONE place, the write queue; what changed later was the ORDER. **One
stamper, reordered — never a second stamper placed earlier.**

**`LogEntry.id` is derived from the eid** via a map that is never cleared — clearing it IS the
failure it prevents. The log is replaced wholesale on every refetch, and a module counter made every
key change every time: measured as one MutationObserver batch with `added: 82, removed: 82` against
`removed: 1` for a normal update. Two entries exist BEFORE the event they are named after, and both
**bind** their eid to the id they already have rather than re-deriving it. `key={entry.eid ??
entry.id}` is the wrong shape even though it looks simpler: it moves the key at the end of every
streamed block, adding a per-block remount that does not exist today.

**Active-chain membership needs its own bit:**

> **eid is an IDENTITY — immutable, per event. Membership is a RELATION between an event and the
> current chain head.** A rewind changes it for a whole stretch of log without touching a single
> event in it. **An immutable identity cannot encode a mutable relation.**

So the raw-file fetch marks each event `offChain: "summarized" | "abandoned"`, built on the one
`walkActiveChainIndices`. **The client gets the ANSWER, never the algorithm** — a second chain walk
in the browser is exactly what the one-boundary work removed.

**A user message renders where it was CONSUMED, not where it arrived.** A message typed during a
tool call is delivered between the `tool_call` and its `tool_result` but consumed with that tool's
results, so in the log it appears **after the finished tool card**. Anything reasoning about a
message's position must use the raw event batch, not the rendered entries.

## `read()` is not a read, and "synchronous" is not "whole file"

Two beliefs about `EventStore` that were each wrong in a way that shaped a design before anyone
checked.

**`read()` MIGRATES.** A file whose first event lacks an `eid` is rewritten in place — measured on a
copy of a real session, 154,958 bytes in, 158,980 out, first event stamped. Nothing in the name says
so, and the files it fires on are the OLDEST ones, which is exactly the population an old-history
search reaches for. **A reader that only wants to LOOK must not rewrite what it looks at**, which is
why `streamEvents` exists beside it rather than as a tidier spelling of it.

**`readFileSync` is one way to be synchronous, not the meaning of it.** A whole design round was
spent on a trilemma — make `read()` async and pay `await` at 9 production plus 154 test sites, or
keep it sync and let search cost +552MB — built on treating *synchronous* and *materialises the
whole file* as one property. `openSync` + `readSync` + `StringDecoder` is the counter-example:
synchronous AND bounded. **The premise was never stated as an assumption, so it was never checked;
it arrived inside a measurement of `readFileSync` and inherited its authority.**

| driver | peak RSS | live heap | time |
|---|---|---|---|
| `streamEvents` — sync chunked, consumer keeps nothing | **+136MB** | +40MB | 143ms |
| `readFileSync` + parse all | +552MB | +221MB | 154ms |
| `read()` | +536MB | +146MB | 164ms |
| holding only `(eid, parentEid, type)` for all events | — | **+13MB** | — |

That last row is why `ChainLink` is a named type: it is the entire input to
`walkActiveChainIndices`, so the backward walk is affordable on a stream. **Widening it back to
`Event` closes that door silently.**

**STATED TRADE: the sync walk BLOCKS the worker thread** — linear at ~120ms per 100MB, worst case
133ms on the largest file in the corpus. Bounded memory bought with a blocked thread, chosen
deliberately; the async form buys ~16MB of peak and is not worth an async ripple.

**The instrument for a driver swap is byte-identity over WHOLE outputs, not a green suite.**
`streamEvents` versus the old whole-file loop: 71,571 events, `JSON.stringify`-identical at every
index, malformed line skipped at the same position with the same warning. A suite can only say "the
cases someone thought to assert still pass".

---
# Providers and the API
---

## The server can do things it does not disclose

**Twice the API has behaved in a way that is invisible from inside a single response, and both times
the only detector was comparing what we SENT and STORED against what came back.** Both times the
first hypothesis was plausible and wrong.

**`response.model` cannot be trusted as ground truth.** A session showed a 70K-token cache miss with
no explanation. Bit-exact replay settled it: two requests 9 minutes apart in one session were
tokenized by two different tokenizers, the earlier matching one model exactly and the later matching
its successor exactly, **+28.9% on identical content** — while `response.model` kept reporting the
declared model, and the successor was not GA for another 12 days.

> **A client declaring model X may receive model Y's output with no disclosed indicator.** The
> tokenizer ratio is the most reliable post-hoc signal, and it is only visible at a cache-transition
> moment. Observable side effects: unexplained cache misses, and ~29% higher input-token counts.

**Forensic technique, model-agnostic: base64-decode a thinking block's `signature` — it embeds the
serving model name**, independently of `response.model`. That is how "8 of 8 silent turns were
served by a different model, 0 of 9,800 normal ones were" got established. **And our JSONL survives
format migrations but loses bit-fidelity against the code that wrote it** — one replay came out
10,515 tokens short because a migration rewrote old events into a shape the old walker dropped.
**When you change a persisted event shape, preserve a pre-migration snapshot.**

**Connector text is summarized server-side, and the model still sees the original.** Text emitted
BETWEEN tool calls is summarized and returned as a thinking block with the signature carrying the
encrypted original — officially documented, no opt-out. It applies only AFTER a tool_result exists,
and a final assistant answer after all tool use is UNAFFECTED. **Operational mitigation: an agent
whose last action is a user-facing reply should END ITS TURN rather than call `yield()`**, because
replying and then yielding in the same turn makes the reply *connector* text; `end_turn` is an
implicit yield with identical pause semantics. **The user-visible symptom, which is what a reader
actually arrives holding: the agent's reply vanishes into the thinking fold** — the response is
`[thinking, thinking, tool_use]`, the second block being a summary of what should have been visible
text. (Scope: measured on an earlier model generation than the one we run, and treated as dormant
rather than gone. Draft `01KY54KQ4RXTARSN5ZYMWSVZJ1` **defines the model name and the symptom** — it
is a proposal that never ran, so it grounds the vocabulary and not a measurement.)

> **"Context = `messages[]`" is FALSE under this mechanism, and the model cannot detect the
> divergence from inside.** The model sees its own originals; the client and the user hold only
> server-rewritten summaries. **So an agent's memory of its own past replies is NOT evidence of what
> the user saw.** This applies to any divergence between what a model believes it emitted and what
> was persisted.

**The canary protocol proved it and generalises**: put a unique token in visible text ONLY, have the
next turn record its recall inside a TOOL INPUT before any read, then grep the client-side records —
tool inputs are the only generation-time verbatim side channel, because they must be executed as
written. The first diagnosis had been SDK-version sniffing: plausible, matching the observed block
shape, wrong, and "verified" by one clean post-restart sample before recurring within the hour. **A
single passing sample is not verification when the phenomenon is intermittent by design.**

## The Anthropic message-shape rules, MEASURED

**`src/test-utils/api-message-rules.ts` is the authoritative list — read it there, not here.** It
carries each rule with the real 400 string it mirrors, plus `PROBED_SHAPES` (every shape we have
actually sent, with the day) and `UNPROBED` (what we assert but have never asked). **Do not
re-enumerate the rules here**: this section used to, opening "these four are the API's actual
rules", and it was five within two days — with the fifth in the very next paragraph, reading as an
elaboration rather than the refutation it was.

**"NOT rules" in that file means MEASURED LEGAL, not never-objected-to, and that distinction is the
whole bug.** From outside, a rule we never discovered and a shape we measured as legal read
identically. `[{type:"text", text:""}]` sat under "NOT rules" for two days and is in fact a 400 in
every position on either role. It is reachable: the walker rebuilds an empty `assistant_text` as
exactly that block, repair does not cover it, and while both emit sites guard on truthiness,
**whitespace-only passes truthiness** — so a model whose first streamed token is a newline,
interrupted right there, bricks the session on every later request.

**Consequence nothing else states: `buildUserTurn` packs `[...tool_results, ...queueMessages]` with
tool_results FIRST, and that order is a real API requirement rather than style.** Put text before a
tool_result, or between two batches of them, and you get a production 400 with a fully green suite.

**Probing the real API: the `systemPreamble` trap.** Any probe against the OAuth endpoint must send
the auth group's `systemPreamble` as the FIRST system block, or every call 429s — a wall of rate
limits that reads exactly like validation failure.

## Prompt cache: what is frozen, and what breaks a prefix

A `session_config` event at the start of the JSONL holds the tools, `systemStable` and
`systemVariable`, frozen between compactions. **That freeze IS the cache strategy**: on resume
everything is read back from the stored config rather than recomputed, so the prefix is
byte-identical and hits.

**The Anthropic prefix order is tools → system → messages, so a tools mismatch is a miss on the
*entire* prefix.** This is why tools are frozen at all: MCP servers connect asynchronously, so
registration order is non-deterministic and an unfrozen tools array would reshuffle itself between
runs. Freezing them as a provider-agnostic `JsonTool` and emitting that event from `runProviderLoop`
**after** tools are ready — rather than from `agent-lifecycle`, where it captured `tools: []` — is
what took restart to a 99.8% cache hit and fork to 100%.

**Three cache breakpoints: tools, `systemVariable`, and the LAST user message.** Last, not
second-to-last: the last message sent is always a user message and the 20-block lookback caches
everything before it, whereas second-to-last caused a full miss whenever only one user message
existed — exactly the post-compaction restart case.

**Never add a per-request `anthropic-beta` header.** It overrides the client's `defaultHeaders`,
including the OAuth header, and silently breaks OAuth mode. Extended cache TTL is GA and needs no
beta header. And `{type: "ephemeral"}` and `{type: "ephemeral", ttl: "1h"}` are **different cache
entries** — the TTL is part of prefix identity, which is why `cacheTtl` lives in `session_config`,
is inherited through fork, and is deliberately not refreshed at compaction.

**Known residual, low priority**: `addAssistantMessage` stores the raw API response content in the
SDK's key order while JSONL reconstruction uses our manual key order. They agree today, so within a
session `messages[]` is consistent. If the SDK changes key order this breaks silently.

## The two providers, and which claims are evidence

**There is ONE OpenAI provider: `OpenAIResponsesCompatibleProvider`.** The Chat Completions provider
and its 1624-line test were deleted; do not go looking for a "Chat Completions path" to compare
against. Both providers use the `openai` npm package, and `ChatCompletionMessageToolCall` is a
union, so filter on `tc.type === "function"`.

**Whether an agent can call a tool that is NOT in its frozen list is measured on Anthropic and has
never been measured on OpenAI — and this file stated both halves in one voice for four months.**

**Anthropic — MEASURED, `scripts/probe-hidden-tool.ts`.** The tools array holds `get_weather` alone
while the system prompt describes a hidden `send_email`; the model returns `tool_use(send_email)`
with correct arguments. **Every run is preceded by its positive control** — same prompt,
`send_email` IN the array — because *"it did not call the hidden tool"* and *"it did not want to"*
are byte-identical output, and the control is not ceremony: on one model the control 400s, so that
model's probe concludes nothing. **A hidden tool needs TWO properties**, and the old wording ("the
server dispatches any name to whatever handler exists") collapsed them into one place that was not
even the right one. The API's half is that the model can generate a name the tools array does not
contain. Matrix's half is `executeTool` looking that name up in its own handler map and answering an
unregistered one with an ordinary `Unknown tool: X` error result — the server dispatches nothing, it
returns a block. **Neither half suffices alone**, and the misattribution stood for four months
because `executeTool` goes on looking names up either way: **code that keeps working cannot tell you
somebody wrote its behaviour down as the server's.**

**OpenAI — NOT measured, and the provenance is the part worth having.** *"Responses uses
schema-constrained sampling, masking the distribution to the supplied tool names"* arrived from THE
USER, in conversation, phrased as a recollection (*"我记得"*), and reached this file 103 minutes
later as an absolute (*"physically cannot"*). **External knowledge we never verified is a different
thing from an invention** — worth the distinction, because it tells you who to ask. Read but NOT
measured, and pointing the other way: OpenAI's docs scope `strict` to the ARGUMENTS matching the
schema and say nothing about names.

**Nothing we believe about OpenAI has been able to be contradicted by reality for months, because
THE OPENAI PROVIDER IS NOT IN USE.** We bootstrap on Anthropic and always have; both stored OpenAI
credentials sat expired for months with nothing refreshing them (`void this.refreshToken`, draft
`01KYQJQC0Z3NQR51E8CPWNQQZA`), which is the symptom rather than the cause — no traffic means no 400,
no flake and no report. **Read that as an instruction, not a disclaimer: treat every OpenAI sentence
in this file as unchecked by default, and every Anthropic one as load-bearing until it isn't.** The
two are written in the same voice and are not the same grade of evidence — Anthropic claims get hit
by bootstrap traffic every day and fail loudly when wrong, while an OpenAI claim can only be wrong
in private. Where this lands: the design conclusion that *refreshing tools at compaction is
correctness-critical on OpenAI and merely nice on Anthropic* rests on an unverified asymmetry about
a provider nobody runs. Keep the refresh; it is right for the Anthropic reason. Do not restate the
asymmetry as `physically cannot` again.

Thinking events carry a `provider` field, so switching providers automatically drops stale thinking
blocks on mismatch; the OpenAI walker ignores thinking entirely. `executeTool` validates every
built-in tool's input against its Zod schema at the boundary; external MCP tools have an empty
`inputSchema` and skip validation.

## The context window belongs to the ENDPOINT, not to the model

Same rule as the model and the credential, one field over: **a number nobody chose, silently
deciding when we compact.** The user's instruction was to delete it with nothing put back (*"先问端
点,不要 config 覆盖,我们本地不要 config 覆盖,也不要兜底,把本地的检测删了。"*). The substring guess,
the `CONTEXT_WINDOWS` table and `DEFAULT_CONTEXT_WINDOW` are gone; `src/context-window.ts` asks the
endpoint's `/models` and THROWS when it will not answer.

**Both directions were live and both were silent, which is why nothing was ever red.** One model
measures 1,000,000 where we guessed 200,000, because the guess matched a literal from the previous
generation and a new one simply fell through; another measures 200,000 where we guessed 1,000,000,
because a bare family name matched everything. **The over-estimate is the dangerous half**:
compacting at ~900K against an API that refuses at 200K walks straight into the compaction deadlock.
200000 and 1000000 are both entirely normal numbers to see.

**Read BOTH keys — `max_input_tokens ?? context_length` — because the key follows the PROTOCOL
DIALECT, not the configured provider.** kimi's auth group is `provider: "anthropic"` with a
`baseUrl`, and its models response looks Anthropic all over while putting the number under OpenAI's
name. Pick the key from the provider type and you get a confident 200000 with 1M in the next field.

**And read nothing else, however limit-shaped it looks.** Anthropic's `max_tokens` sits beside
`max_input_tokens` and is the OUTPUT cap — 128,000 next to a 1,000,000 window, which is the LiteLLM
confusion (#14876). OpenClaw (#88596) read xAI's `long_context_threshold`, a PRICING breakpoint, and
reported a 1M model as 200K. A third member lives inside a dialect we now read: codex's
`max_context_window` is the model's ceiling somewhere else, while `context_window` is what this
deployment grants — `gpt-5.4` reports 272000 and 1000000 in the same entry, **3.68× apart**. **Five
of the seven live models have the two keys EQUAL, so a fixture drawn from those five cannot tell
them apart**; only `gpt-5.4` can, which is why the test uses it.

**Cache on `baseUrl + model`, never on the model alone.** `k3` is 1M and `k3-256k` is 256K at ONE
host; GPT-5.5 is 1,050,000 on OpenAI's own API and 272,000 of input through the codex endpoint. A
model does not even have one NAME across deployments — Haiku 4.5 is `claude-haiku-4-5-20251001` on
the Claude API, `anthropic.claude-haiku-4-5-20251001-v1:0` on Bedrock and
`claude-haiku-4-5@20251001` on Vertex. **The endpoint is the thing that knows.**

**Matching is EXACT on the model id, and the reason is not that prefixes are sloppy.** `/v1/models`
is keyed by model ID; an ALIAS is a separate documented name the server resolves to whatever
snapshot it currently points at, and it is designed to MOVE — so there is no correct client-side
alias→ID mapping, and a prefix match gets today's answer right by naming convention while silently
following list order the day an alias is repointed. **MEASURED COST, accepted**: `claude-haiku-4-5`
is NOT among the 11 ids the endpoint lists and the messages API accepts it anyway, so exact matching
really does break a config that works today. That is why a miss **suggests** the single prefix
candidate and resolves nothing — an id the user writes into config is chosen and auditable while one
we resolved for them is guessed and invisible. **Do not "fix" aliases by reading `response.model`
off a probe call**: it expands them, and that field is measured NOT to be ground truth.

### An empty 200 is a REFUSAL wearing the shape of an answer

*The endpoint is the only source; if it will not answer, throw* quietly assumes an endpoint either
answers or fails. **A 200 carrying an empty list is neither.** MEASURED on the codex catalog:
`client_version=0.144.0` returns 7 models, `0.143.0` returns 4, `0.50.0` returns **200 with zero**.
The list is silently filtered by a parameter WE send.

**So an empty list gets its own error, ahead of the not-found case.** Classifying it as "the
endpoint does not list your model" is wrong twice over: it blames a config field, and editing that
field cannot help. The refusal instead says the endpoint enumerated nothing and names the request
that produced it (`requestDetail`, supplied by the provider because only the provider knows what it
sent).

**`client_version` is sent at the MAXIMUM (`999.0.0`), meaning "apply no version filter", and that
is not the species of constant this module deleted.** `DEFAULT_MODEL` and `DEFAULT_CONTEXT_WINDOW`
stood IN FOR AN ANSWER; this flows into no answer, since the window still comes entirely from the
response. **The discriminator worth keeping is "does this value substitute for a fact, or modify a
request".** Why each alternative loses: a real pinned version IS the deleted defect, chosen once and
degrading to an empty list the day the server raises its floor; reading the local `codex --version`
claims to be a build we are not and makes our answer depend on whether that CLI is installed; and
`0.0.0`, which also returns all 7, is the worse of the two lies, because `999.0.0` returning
everything follows from `>= minimal_client_version`, the visible mechanism, while `0.0.0` returning
everything works for a reason we cannot see. **Prefer the sentinel whose behaviour follows from the
mechanism you can read.** Filtering is pure loss regardless — we never SELECT from this list.

**Sent unconditionally with no endpoint branch, measured rather than assumed:**
`api.openai.com/v1/models` answers identically with and without it (same 401, so it is ignored
rather than rejected — an unknown-parameter rejection would be a 400), and kimi returns the same 4
either way.

**One 401 was hiding four more disagreements** (`01KYRD862V1JCXNHJ3YZDR3KCH`). An earlier entry said
the codex catalog answers 401 so the OpenAI path fails at startup — and implied that fixing the
credentials would make it answer. Measured against a live token: it does not. The endpoint returns
200 and `fetchOpenAIModels` could not read a single field: `client_version` is a REQUIRED query
parameter, the envelope is `{models:[…]}` not `{data:[…]}`, entries are keyed `slug` with no `id`,
and the window is under `context_window`.

> **A 401 masks every later disagreement, and the ones behind it are only separable once it is
> gone.** Nothing was wrong with the earlier measurement — the 401 was real and the conclusion drawn
> was the honest one available. It was still half wrong, because *"authentication failed"* and *"we
> cannot read this dialect"* are one observation until the first is fixed. **A conclusion of the
> form "X is blocked on Y" is a PREDICTION about what happens after Y, and it should be labelled as
> one.**

That third dialect is read through the SAME path, with no `isCodexEndpoint` branch: `ID_KEYS = [id,
slug]`, `WINDOW_KEYS = [max_input_tokens, context_length, context_window]`, envelope `data ??
models`. **NEGATIVE RESULTS**: OpenRouter is public and carries `context_length` on all 367 models
with zero bare-name collisions, and is still wrong as a fallback table — it covered 3 of the 15
models we measured, every kimi model missing, and it reports the window *as accessed through
OpenRouter*. A vendored registry is the same hardcoding at larger scale. `api.openai.com/v1/models`
does not return a context length at all.

## The LLM facility — single-turn, no tools, no session

`src/llm.ts` wraps the provider adapters for plugins needing one-shot calls outside the agent loop.
**SDK client construction is DUPLICATED across three sites** — the provider class constructor,
`createAnthropicClient` in `llm.ts`, and the `check_model` handler in `runtime.ts` — with beta
headers, timeout and `baseURL` hand-matched and nothing enforcing agreement. **That duplication is
now load-bearing for a correctness property rather than cosmetics: each of the three must build its
client from ONE object literal naming EVERY credential slot, because any slot left unmentioned is
exactly what sends the SDK to read the environment.** Three hand-matched copies of that literal are
three places a fourth branch could reopen it — see *Nothing ambient may decide*.

---
# Nothing Ambient May Decide What We Send
---

Three fields decide every request this system makes: which model, which credential, which host. All
three used to have a second, invisible answer sitting behind the configured one, and in each case
the invisible answer won whenever the configured one was merely absent. The user settled it in one
line — *"我觉得压根就不该有一个 DEFAULT_MODEL"*, then *"所有用 env 决定模型或者 key 的 删掉"*, then
*「env 不许决定」* — and the reason generalises past the three fields:

> A constant or an environment variable standing in for the user's choice means an agent runs
> against something nobody selected, and the log afterwards records a name nobody chose. **The
> failure is not that the value is wrong. It is that the value is unattributable.**

So `DEFAULT_MODEL` is gone, `DEFAULT_CONFIG.model` is `""`, both providers take `model` and `opts`
as REQUIRED parameters, `getContextWindow` returns a `Promise<number>` obtained from the endpoint,
and the credential reaches the SDK as a function rather than a string. Only matrix's own `MXD_*`
variables may still be read. What made the deletion safe rather than merely wanted: the fallbacks
were covering a state the validator already rejects, so three of four `?? DEFAULT_MODEL` branches
were unreachable, and the one path that does reach them is the `"model": null` hole they were
masking (`01KYJ27S0N3VBXQTFVNQ3FB879`).

**Nothing in production guards an empty or absent model, and no test can see one.** After the
deletion `""` and `null` both travel to the API untouched, and `ValidatingMockAPI` substitutes a
default without checking emptiness — so **a suite that is green with `model: ""` everywhere says
nothing about whether a fresh install works.** Whoever closes that hole inherits a contradiction
this created: reject empty at load and `DEFAULT_CONFIG.model = ""` fails its own validator, so `mxd
config init` writes a config the loader refuses. *Global config is a COMPLETE config* and *empty is
invalid* cannot both hold.

## The SDK is a second reader, so deleting our own reads was half the job

Deleting our `?? process.env.ANTHROPIC_API_KEY` did **not** stop a shell-held key from reaching the
API. The Anthropic SDK's constructor does `if (apiKey === undefined) apiKey = readEnv(...)`, and the
same for `ANTHROPIC_AUTH_TOKEN`, so with zero env reads left in `src/`, `new
AnthropicCompatibleProvider(model, {})` still yields a client whose `apiKey` is whatever the shell
holds. What our deletion removed was the BRANCH CHOICE: a truthy `apiKey` sets `useOAuth = false`,
so an ambient key silently outranked a configured OAuth token.

**And it was never "env silently outranks config" — it was a HARD FAILURE pointing the wrong way.**
`authHeaders()` emits one header per filled slot and the API rejects a request carrying both
`x-api-key` and `authorization`, so anyone whose shell held `ANTHROPIC_API_KEY` for some other
project **could not use the OAuth path at all**, and the auth error blamed their OAuth token. That
is the path we bootstrap on every day. **Read "a credential env var is set" as a break, not a
preference.**

`undefined` and "I did not pass it" are the same thing to an SDK that tests `=== undefined`, and
**`null` is the only other spelling** — its own signature is `string | null | undefined`, and
Anthropic's tracker treats `null` as the documented opt-out (`anthropic-sdk-csharp#47`). **NEGATIVE
RESULT: there is no disable-env option to go looking for**; the open request for one
(`claude-code#12047`) is against a different product.

**`check_model` is the site where getting this wrong hurt most, and "it shares the bug" understates
it**: it backs the Settings *check model* button, which is exactly what a user presses while
diagnosing this failure — so it did not merely fail too, it reproduced the both-headers rejection
and reported that the OAuth token the user had just configured was bad. **When ranking doors, ask
which one somebody arrives at while already confused.**

**How that third door came to be missing from the plan is worth more than the door.** The list was
built by grepping `new Anthropic` in the two files already open and written up as a table — and **a
grep of the files you are editing is not a population.** This file already named the third site.
Cheap detector, and it is the question a grep cannot answer for you: *what would tell me this list
is complete, other than the list?*

**Four things about testing this door, each of which cost a false green.** `git log -S` tells you
which names were ever yours: 15 commits touched `ANTHROPIC_API_KEY`, and `ANTHROPIC_AUTH_TOKEN` has
**zero** — it was never ours, so a sentinel claiming we ignore it would assert the opposite of
measured reality. **An env sentinel must DELETE its sibling credential variables**, or with both
`??`s restored the `CLAUDE_CODE_OAUTH_TOKEN` test PASSES on a machine whose shell holds
`ANTHROPIC_API_KEY`, because the ambient key suppresses the branch being watched. **A negative
assertion about a header (`not.toContain("oauth-2025-04-20")`) passes just as happily on a header
you failed to READ**, so it needs a positive control asserting a beta feature that is always sent.
And **`check_model`'s only test accepted `ok` OR `error`**, so on a machine holding that variable it
made a REAL call to `api.anthropic.com` during `bun test` and passed either way; the sentinel that
replaced it asserts **zero requests left the process**, which can tell a hermetic run from a
networked one. One thing that does NOT transfer between providers: the Anthropic no-credential
branch neither warns nor throws, it builds a credential-less client, so the OpenAI sentinel's
`console.warn` hook has nothing to hang on.

## One object literal per client, so a forgotten slot is unrepresentable

The three-branch fix left the omission POSSIBLE and merely absent — a fourth branch added next year
reopens it and nothing goes red. So all three sites build their client from **one object literal
naming every credential slot**, with `useOAuth` deciding which one is `null`. Same move as
`OpenAICredentialSource` becoming a function type so holding a token is not expressible, and
`getContextWindow` returning a promise so a local guess is not expressible. `|| null` rather than
`?? null`, and the type is the reason: both locals are `string | undefined`, and `undefined` in a
slot is precisely what sends the SDK to env.

MEASURED, because the justification written first was wrong and only a mutation said so:

| passed | `authHeaders` builds | request sent? |
|---|---|---|
| `apiKey: null` | nothing | no — the SDK refuses |
| `apiKey: ""` | `x-api-key: ""` | **no** — `validateHeaders` refuses anyway |
| `authToken: ""` | `Authorization: Bearer` | **YES — malformed, and it goes out** |

So for `apiKey` the two spellings are indistinguishable, which is why that mutation SURVIVED: an
equivalent mutant rather than a coverage gap. The dangerous slot is the other one, and `useOAuth =
Boolean(oauthToken && !apiKey)` is the whole reason `authToken: ""` is unreachable — **do not
simplify that guard without re-reading this.** The order the error happened in is the transferable
part: the justification went into a comment, then a test was written to pin it, and the test passed
against both spellings. **A comment stating a behaviour is not evidence of it, including when you
wrote it ten minutes ago.**

**Behaviour change, intended: with nothing configured the client holds nothing**, so the SDK throws
*"Could not resolve authentication method…"* before building a request, instead of quietly running
on the shell's key.

## The host, and who gets billed

`ANTHROPIC_BASE_URL` was the same defect one field over. `authGroup.baseUrl` is typed, in Settings,
in the CLI and in `config.json`; the variable was ambient, undocumented, and silently authoritative
**whenever the typed field was unset** — because the SDK takes `baseURL` as a default parameter
reading it, so omitting the option WAS consent. The string entered this repo one day before it was
removed, in a comment, in the very commit that added the typed field (`cdad315a`). **A comment that
documents a behaviour without endorsing it is exactly how an accident survives review** — it reads
as *considered*, and nothing distinguishes it from *decided*. `resolveAnthropicBaseUrl` in
`src/config.ts` is the one answer now, behaviourally identical to what the SDK would have done,
which is the point: it changes who decides, not what happens. One SDK side effect, checked rather
than assumed: an explicit `baseURL` sets `_baseURLIsExplicit`, which only governs whether a
`profile` credential may supply a host, and we never pass `profile`.

The OpenAI door is the same rule in a different currency. `openai`'s constructor takes **all five**
slots as default parameters, so there is not even an `=== undefined` test to sidestep.
`organization` and `project` were never passed, so `OPENAI_ORG_ID` and `OPENAI_PROJECT_ID` became
request headers, and the consequence is vendor-documented rather than inferred: *"If no header is
provided, the default organization will be billed."* **That is env deciding billing attribution**,
which is why it belongs to a rule about credentials although neither field is one. Both are pinned
to `null`; measured with the shell holding all four names, both headers arrived as the shell's
values and with the nulls neither appears. `apiKey` and `baseURL` were already clean because we
always pass them — a side effect of other requirements rather than a decision, so **the test asserts
all four names.** (Surveyed and reported before it was fixed: `01KYSD71GAYKD5AAT48C0MFKQN`.)

**One asymmetry to keep true rather than work around: `apiKey`'s type is `string | ApiKeySetter |
undefined`, with no `null`.** If `authToken` ever became optional there would be no way to spell "do
not read env" for it, so **the thing to preserve is that `authToken` stays required.** `apiKey: ""`
suppresses the read and then sends `Authorization: Bearer` with nothing after it: suppression
achieved, request malformed, 401 with a misleading message.

**MEASURED, and it bounds this whole family: none of these variables can reach an INSTALLED
daemon.** `daemonPlist()` forwards `PATH` and `HOME` and nothing else. That is not a reason to relax
— **it is precisely the bootstrap path, which is us, every day** — but state it that way round
rather than as "any user with the variable exported". One env reader remains, out of product scope
and worth knowing before you trust it: `scripts/probe-hidden-tool.ts` builds its own client with no
`baseURL`, so a shell variable can silently redirect the probe we use to measure what the API does.

## A credential somebody else owns is READ at every use

The user's decision was to delete the copy: *"把 config 做成,api key,没有别的选项。access token 和
ref token 选项去掉。换成 auth.json path"*. An OpenAI auth group holds `apiKey` **or** `authJsonPath`
— a path to the `auth.json` the codex CLI maintains, which we only ever read.

**The reason is ownership, and it is what makes the design non-obvious.** OpenAI ROTATES the refresh
token on every refresh, invalidating the previous one. So two copies of the pair are not one live
value and one going stale — **they are two claimants to a single chain, and whichever refreshes
first turns the other into waste paper.** Measured: our config's copy and codex's file held
different access AND refresh tokens, both dead. So reading the file is not the lazy option, it is
the only correct one. The corollary a future change will get wrong: **an expired token is an ERROR
with an instruction, never something we refresh** — refreshing means writing that file, and
rewriting it from anything we hold discards what codex just wrote.

**The credential therefore reaches the openai SDK as a FUNCTION, and only a RETRY can tell that
apart.** The `apiKey` slot accepts `() => Promise<string>`, invoked before EVERY request, and
`retryRequest` re-enters `makeRequest`. We had hand-built exactly that shape as
`OpenAICredentialSource`, then resolved it ourselves and handed the SDK a static string,
**downgrading a per-REQUEST capability to per-TURN.** With `maxRetries: 2` one call sends up to
three HTTP requests on one token while codex rotates on its own schedule, so the retry re-sent a
token that had just been rotated away and collected an auth error that reads like a bad credential.
It had been deliberately deferred once (`01KYSE0N667GMYDC81057J3NX8`) on the correct ground that it
needs a test driving a real retry.

**Moving a capability from per-N to per-M needs a fixture holding TWO M's inside ONE N, and every
weaker assertion is green against both implementations.** "The function was passed" and "it was
called once" are both true of the static string. What works: rewrite `auth.json` from inside the
fetch mock, answer the first attempt with 500 plus `retry-after-ms: 0`, and assert the SECOND
request carried the SECOND token. Against the resolved-string mutant exactly ONE test goes red and
its message IS the diagnosis (`"Bearer first-token"` twice). `retry-after-ms: 0` keeps it at 2.7ms —
the same shape on a bare 429 costs 397ms of the SDK's backoff.

**THE LINE, and it is not "everything goes to the SDK": the token goes to the SDK, the account id
stays ours.** `ChatGPT-Account-Id` is a header and `defaultHeaders` is fixed when the client is
built, so `streamResponsesAPI` resolves the source once for it — and that resolve pays twice,
because it is also where an unreadable credential fails with OUR message instead of inside the SDK's
wrapper. Measured with a real token as positive control: a setter returning `""` throws and **zero
requests leave the process**. **Deliberately NOT pinned by a test** — `openAICredentialSource`
cannot produce an empty token, so such a test would only assert the SDK's behaviour rather than
ours.

Two smaller decisions. A path is **never masked** — `authJsonPath` is not a credential, the secret
never enters config, and which file you pointed at is the one thing that settings row exists to tell
you, so `maskAuthGroup` and the CLI leave it verbatim and the test pins the ABSENCE of masking. And
`readCodexAuth` expands a leading `~/`, because the documented location is `~/.codex/auth.json` and
neither place a user types it goes through a shell.

**`ChatGPT-Account-Id` is MEASURED not required for codex `/models`** (200 with and without,
byte-identical; 401 with no `Authorization` as the positive control). It is still sent, because
codex sends it and the **responses** path was never probed without it. **The first 2×2 said the
opposite and the ORDER CONTROL killed it**: `/models/catalog` answered 403 without the header and
404 with it, which reads exactly like a header requirement — reversing the order moved the 403 onto
the with-header call, then both settled at 404. **A first-hit edge block and a real header
requirement are indistinguishable in the payload; only the permutation separates them.**

## Proving it: assert at the RECEIVER

The rule above is only worth what its tests are worth, and the obvious test is **provably vacuous**:
set `ANTHROPIC_API_KEY`, construct with empty opts, assert `client.apiKey` is not the env value.
That fails today AND its inverse passes under the restored fallback, because the SDK reads that
variable too. **A second producer downstream of the one you deleted destroys the observable you
would naturally assert on.**

So `src/env-cannot-decide.test.ts` asserts at the far end: two real listeners on ephemeral ports,
config naming endpoint 1 and the env variable naming endpoint 2, and the assertion is **what crossed
the wire.**

**Endpoint 2 is a TRAP THAT TESTIFIES, not a silence.** It records method, path and the credential
headers of anything it catches, so a regression's failure message *is* the diagnosis: the request
moved from `target` to `decoy`, carrying `x-api-key: configured-api-key`, at `/v1/messages`. A
boolean decoy gives you `expected false, got true` and the next person rebuilds the scenario from
scratch. It also catches leaks nobody wrote a case for, because the whole header map is compared.

**Both endpoints must be asserted in ONE `toEqual`.** Two properties are needed — the target really
RECEIVED something, and the decoy testifies — and written as sequential `expect`s **the arrival
assertion fails first and aborts the test, so the testimony never prints**: measured, a mutation
sending everything to the decoy reported only `Expected: 1 Received: 0`. **Two requirements that
each look satisfied can cancel through assertion ORDER.**

**No vendor protocol is implemented, and that is the load-bearing simplification: both listeners
answer 400**, a status neither SDK retries, because the observable is ARRIVAL rather than a
successful turn. **`check_model` is the cheapest real door in the repo** — it calls
`messages.create` rather than `.stream` and never asks `/v1/models` — so about ten lines of listener
buys the whole chain from a `config.json` in a temp dir through `loadGlobalConfig` →
`resolveAuthGroup` → `createProviderFromConfig` → SDK → wire. The agent LOOP is the one door this
cannot reach; that needs a real SSE mock, filed as `01KMNYSM4JBJ3FPZCQPFZF6T3Q`.

**A default that is a REAL host makes one case unreachable receiver-side.** With no `baseUrl`
configured we target `api.anthropic.com`, so that case would make a genuine outbound call — and a
GLOBAL fetch stub is not the fix, because it makes the decoy unreachable and *"the decoy caught
nothing"* becomes a tautology. **A trap that cannot be triggered is not a trap.** The shape that
works is a stub refusing EXACTLY ONE host and forwarding everything else, plus a POSITIVE assertion
that the blocked request really targeted that host. This justified deleting three fetch-interception
`describe` blocks that the receiver version subsumes; **the provider constructor's own sentinels
were KEPT**, because no door reaches that client without running a loop. **Check which door each
test actually reaches before calling it redundant.**

### The fixture underneath it is only as wide as its callback's synchronous prefix

Every credential sentinel stands on one env fixture, and **a fixture that restores when its callback
RETURNS can only see a client constructed in that callback's synchronous prefix.**

| callback shape | is the fixture's env visible at construction? | which door |
|---|---|---|
| sync callback | yes | `createLLM` |
| async fn, before its first `await` | yes | `check_model` via `app.request` |
| an async generator's first `next()` | yes | `streamResponsesAPI` |
| async fn, AFTER an `await` | **no** | none today |

**All four of our doors happened to qualify, and that is the entry: "it works" and "it works for a
reason" were indistinguishable here, so this was found by READING rather than by anything going
red.** The failure direction is the invisible one — env already restored, client reads the real
shell, fixture reports no leak, **test green while asserting nothing.** `withClientEnv` therefore
defers its restore when the callback returns a promise, and `src/test-utils/sdk-client-env.test.ts`
exists because a fixture is an instrument.

**That deferral changed no outcome the day it shipped and was load-bearing ONE DAY later.** Putting
`await credentials()` above `new OpenAI(...)` moved the OpenAI door into the fragile row. Measured
both ways with the `organization: null, project: null` deleted so production genuinely leaks:
**deferral intact → RED, naming both shell headers; deferral removed → the same vulnerable
production reports CLEAN.** This does not soften *an optimisation for a case your fix eliminates is
dead code that looks like foresight*; the difference is that the deferral deleted a CLASS — any
`await` upstream of any client construction — rather than serving a scenario.

**Sibling trap, met while probing: both SDKs snapshot `globalThis.fetch` in their CONSTRUCTOR.** A
fetch-intercepting test must install its stub BEFORE the client is built — get it backwards and the
call goes to the real `api.openai.com`, which is exactly what a first probe did: it reported
`headers: {} … leaked: NONE`, **a clean bill of health produced by talking to the internet.**

---
# Data Model, Storage and Config
---

## Where a project's data lives, and why it is in two places

**`<repo>/.mxd/`** is tracked in the project's own repo: `config.json`, `memory.md`, `hooks/`, and
`plugin/` if the project ships one. **`~/.mxd/`** is daemon runtime state on this machine, never in
git: global config, auth, the lock file, the web build cache, the project registry, and per project
a `config.json` plus a plugin-namespaced data root.

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
than colliding at the top level, which completes the "matrix is just a plugin" framing.

**`src/data-paths.ts` is the ONE place that resolves a path from `dataRoot`.** Never apply a string
operation to a `dataRoot` anywhere else — **any** spelling, not just `.slice(2)`; a grep test walks
the whole repo and fails if a second site appears. Three lines of defence, each there because the
previous one might be relaxed: a strict regex at the input boundary, one resolver so a fix touches
one file, and a post-resolve invariant that the result is still inside the project root. **Keep the
third even though the regex already rejects traversal** — `resolveDataRoot("@/../etc")` used to
return `dataDir/etc`, which is a cross-plugin attack. **A malformed manifest is FATAL at startup,
not a warning**: import errors are recoverable (skip the plugin), validation errors are not.

Directory creation is lazy and happens at the owning plugin's data root — the daemon used to eagerly
mkdir `projects/<id>/tasks`, which hardcoded matrix's layout. `tracker.save()` writes a temp sibling
then renames.

## Config: three layers, three TYPES

**DECIDED (user): *"三层各有自己的类型…如果你设置的 config 你的 field 里没有,自然而然就不对了。以后
不需要再纠结 validation 了。"*** `RepoConfig` and `LocalConfig` are computed from ONE classification
table in `src/config.ts`, and each loader projects its file onto that layer's field set. **A field
outside a layer's set does not exist after the read, so nothing downstream has to reject it** — and
every argument that used to surround this loses its subject, because all of it came from ONE type
serving three layers with different semantics. **The instinct it replaces is a blacklist plus a
filter, which is the same defect relocated.** The test for whether you built the right thing: the
types must be COMPUTED from the classification so the two cannot disagree, and `satisfies
Record<keyof MatrixConfig, …>` must make an unclassified new field a compile error.

**The semantic, end to end (user):** *"global auth 默认是空白，model 是 `""`. project 和 local 的话
auth 默认是 undefined，ui 表现为 tick 了 inherit，选择框消失"*. So **global is a COMPLETE config,
every key present, and "not chosen yet" is `""`; the overlays are `Partial`, so an ABSENT key means
inherit.** The precedence is `global < repo < local`: `resolveConfig(base, ...overlays)` overlays on
`value !== undefined`, so `""` IS an overriding value — and **global is the BASE at all three
production sites (`daemon.ts`, `runtime/helpers.ts`, `cli.ts`)**, so an empty global value can never
climb over a project's while the reverse is reachable and pinned by a test. **The direction was
asserted backwards twice in one evening — with the `global < repo < local` line sitting right there
above it, read past both times** — and wrapped in a *correctly recalled* mechanism, which is what
makes a wrong direction look checked. **So writing the fact down is not the fix**, and that is the
whole reason there is a detector: for any "A overrides B" claim, name which of them is the
function's FIRST argument.

**The axis that decides which layer may hold a field is TRUST, not scope.** `model` and
`defaultAuth` are settable on **global** and on **local**, and are **not rendered at all** on the
**project** tab — because the repo layer is `<projectPath>/.mxd/config.json`, git-tracked and
**arriving with `git clone`**, so a repo you cloned could otherwise choose the model and the auth
group every later agent run uses. **That is why `GLOBAL_ONLY_FIELDS` is the wrong home for the rule:
the field is not global-only, it is not-from-the-repo** — and it is why the three tabs are not
variations of one form. **The enforcement is the layer projection itself: a field outside a layer's
set is dropped at the read, so no separate credential rejector is needed or exists.** `authGroups`
is the exception that proves it — being global-only it is validated rather than projected, so a
removed field inside a group would simply never be read again, and `warnRemovedAuthFields` exists to
say so out loud. **It warns and never repairs**, because this loader is also what `mxd config` reads
before saving, so a fix applied here would rewrite the user's credentials as a side effect of an
unrelated command. The deeper hole a write-door guard never covered is `01KYQYRXST632196G3FNWTWF1X`,
and it is hardening rather than a vulnerability: **there is no sandbox, so a hostile repo already
owns you once an agent reads it.**

**`SettingNumberField` KEEPS the implicit "empty box = inherit" convention**, considered rather than
missed. It is a third convention in one panel, which is the one real argument for converting it.
Against, decisively: it is **not broken the way the other two were** — clearing the box returns to
inherit and the inherited value renders as the placeholder. **A number has no `""` state, so "empty"
there can only mean absent**; the ambiguity the user objected to requires a competing legal empty
value, which a number does not have.

**The two that WERE broken share one rule: a 3-state value cannot live on a 2-state checkbox — the
inherit state needs its own control**, which is why both now share one `InheritToggle`. A checkbox
can DISPLAY a third state and has no way to RETURN to it, so the state is reachable only until the
user's first click.

Three consequences of the projection that will look like bugs. **A repo write now NORMALIZES a
git-tracked file** — the loader strips and the saver writes what it was handed, so the next write
silently removes a stale key from someone's tracked file. **A key NO layer declares is dropped the
same way, and carrying it was considered and REJECTED** (user): the hazard is real — an older matrix
editing one field deletes a field a NEWER matrix wrote, as an ordinary commit — but **the user's
answer is that this is a missing-versioning problem, not a loader problem** (*"现在我们并没有 proper
的 versioning…以后有 versioning 之后,自然而然的 如果你读到新版本 应该说让你去更新"*) — reading a
config a NEWER matrix wrote should tell you to upgrade, not absorb it silently. Filed as
`01KYR25PSVP33F6MF858VHG0R6`. And **look a classification table up through a `Map`, never property
access on the object literal**: `TABLE["__proto__"]` answers with `Object.prototype`, which is
TRUTHY, and `JSON.parse` yields `__proto__` as an OWN key, so a key that passes the check is then
ASSIGNED to the result object where `__proto__` is a setter. Found by a test asserting the refusal's
WORDING — every prototype name was already being refused, for a reason that was not the true one.

> **A consequence traced correctly does not make the fix derived from it correctly priced.** The
> remedy proposed from that trace — "keep the unknown key, one branch" — was not one branch:
> `asLayerConfig` returns `LayerConfig<L>`, so passing unknown keys through either makes that return
> type a lie for everything downstream or needs a preservation channel through read→edit→write in
> three functions, for a case that has never occurred. **A cost stated as one branch by the person
> who wants the cure is the one to re-derive.**

**NEGATIVE RESULTS**: stripping `authGroups` from the LOCAL layer is not a new policy — the type had
excluded it from both project layers since it was written, and only the runtime disagreed. And
`mcpServers` shallow-merging in from the repo layer **stays exactly as it is** (*"mcp 你就别添油加醋
了 这个保持现状"*); root raised the `command`/`args`-get-spawned concern and was overruled.
`budgetUsd` / `thinkingEffort` are candidates for the same trust principle, not licence.

## The CLI and the daemon must agree, and nothing checks that they do

**They are two processes reading one file, so every disagreement is silent.** `globalConfigPath()`
read `~/.mxd/config.json` while the daemon read `join(dataDir, "config.json")` — the same file only
while `MXD_DATA_DIR` is unset, so with it set `mxd config set … --global` **exited 0 having edited a
file nothing reads.** And `DAEMON_URL` hardcoded `localhost:7433` while the daemon listens on
`globalConfig.port`, a field the Settings UI exposes with 7433 as its *placeholder* — changing it
lost every CLI command to *"Daemon is not reachable at http://localhost:7433"*: true, useless,
unfalsifiable from outside.

**DECIDED (user): *"不能让任何人去读 HOME,而是从 data dir 或者默认 home derive 出来"*.** One
exported derivation, `resolveDataDir()`, and a whole-repo audit fails on any other read of HOME for
our data — with two allowlisted exceptions carrying their reasons: `PLIST_DIR`, because macOS
genuinely puts LaunchAgents under HOME and it must **not** move with our data dir, and codex-auth
expanding a `~` the user typed.

**The two byte-identical duplicates are WHY the other three drifted.** `cli.ts` and `daemon.ts`
carried the same expression character for character while three other sites dropped the env half.
**Nobody ever had to reconcile anything, because there was no one place to reconcile.** So a
duplicate is not just a maintenance cost: it is the absence of the site where a divergence would
have been noticed.

**Do NOT read this as "delete the env fallbacks."** `MXD_DATA_DIR` is how tests get an isolated data
dir and `MXD_DAEMON_URL` is how they reach an ephemeral port. The rule is *an env var must not
silently answer a question config already answers*: **an explicit override losing to nothing is
fine; a DEFAULT that overrides config is the bug.**

**An unreadable config is REPORTED and then falls back, and both halves are deliberate.** Reporting,
because silently substituting a port is the defect itself. Falling back, because the remedy the
message names (`mxd config init`) is a CLI command — a throw at module load takes away the only tool
that can repair the state.

**NEGATIVE RESULTS from the same sweep.** `createApp`'s optional config default was **dead** — zero
callers ever omitted the argument, and it has since been deleted, so `createApp(config)` is now
required — while `resolveTaskJsonlPath`'s identical-looking default was the **opposite**: its one
caller never passed anything, so the default WAS the value, and `mxd analyze-cache` read whatever it
said. **Two defaults written the same way, one unreachable and one load-bearing; only counting
callers tells them apart, and the reflex fix is wrong for one of them. A default's value is decided
entirely by who OMITS the argument, which is the one thing its definition cannot show you.** Also
`ProjectManager`'s `getByPath` and `ensureProject` have zero production callers, which is most of
the answer to `01KYSBAA41QRBA7GY3ZQ9M9RBR`.

**An installed service records a decision; it must not look one up at login.** `mxd daemon install`
BAKES the resolved data dir into the plist as an absolute path rather than forwarding the variable:
**a forwarded variable is evaluated in launchd's login environment — neither the installing shell's,
nor anything the user can see — while a baked path is evaluated once, at install, which is what
installing a service means.** The plist already treated `LOG_DIR` that way, so this is that ONE
mechanism reaching the value `LOG_DIR` is derived from. `["PATH", "HOME"]` stays a forwarding list
of two: those describe the machine. Measured symptom when the plist was silent, worth recognising
because neither side reports anything: the CLI's own token is rejected by the service the CLI just
installed, and `mxd health` answers `Daemon: undefined vundefined (uptime: NaNs)` while **exiting
0** — that exit-0-on-401 is `01KYSBCBNWEWYM2GHF0KH8QW0H`. **An installer IS testable without
touching the real machine**: a stub `launchctl` earlier on PATH plus a temp `HOME`, since
`Bun.spawn` resolves the binary through the CHILD env's PATH and `PLIST_DIR` is built from
`process.env.HOME`. The baked value is user-supplied and lands inside XML, so every interpolated
string is escaped — an unescaped `&` produces a plist launchd cannot parse, and **that failure
arrives at login, not at install.**

## One primitive, two standards, in two files

`realpathOr` — realpath, falling back to the literal path — already existed in `src/tools/bash.ts`,
where the cwd notice has always resolved symlinks. Another file answered the same question (do these
two paths name one directory) with `===`. **Neither was wrong on its own terms; the repo held two
standards for one primitive.** Now `src/real-path.ts`, imported by both. **The fallback is the
load-bearing half**: `realpathSync` **throws** on a path that does not exist, and both callers
COMPARE paths rather than read them — a deleted project directory or a typo'd `--project` must still
compare — so returning the literal makes the worst case the old behaviour instead of a crash.

**Project lookup compares by REALPATH, and that is a production property rather than a test
convention.** It was not, until a fixture workaround that had been hiding it got read properly. On
macOS `mkdtemp(tmpdir())` returns `/var/folders/…` while a spawned subprocess reports
`/private/var/folders/…`; wrapping fixture paths in `realpathSync` is now hygiene, not a requirement
for the CLI to work.

> **A workaround in the fixtures is where a production bug goes to be forgotten.** This file once
> recorded the TEST half of that defect and not the defect: `resolveCurrentProject` compared strings
> with no realpath layer, so a project registered through a symlink answered "No project found for
> current directory" from inside its own directory. The test carrying the workaround also carried a
> comment stating that production string-compares — **the defect was written down twice and filed
> nowhere.** Routing around a problem in a fixture removes the only pressure to fix it, and the note
> you write to help the next person teaches the workaround as the answer. **Ask of any "test gotcha"
> you are about to record: is this a fact about the test environment, or a defect the test is
> absorbing on production's behalf?**

The fixture for such a fix must not borrow the platform's symlink: macOS hands you `/tmp →
/private/tmp` for free, but `/tmp` is a real directory on Linux, so relying on it passes against the
broken code by testing nothing. Build an explicit `symlinkSync` and assert the link differs from its
target.

## The node model: TaskNode | GeneralNode

Runtime exposes exactly two node kinds, discriminated by a **required** `type: string` with no
`undefined` fallback. **TaskNode** (`type: "task"`) is launchable: session, git branch, lifecycle.
**GeneralNode** (any other string) is pure metadata plus tree position. **Matrix uses `"folder"` as
its only flavour, and "folder" is a matrix convention rather than a runtime kind** — which is why
`isFolder` is plugin-local while `isTask`/`isGeneral` are runtime exports, and why the folder MCP
tools are sugar over one general-node API.

**Folders must stay at ZERO behaviour, forever, and the reason is a measured failure rather than
taste: a node kind that carries behaviour is a CROSS-CUTTING CONCERN — it does not stay in the file
that defines it, it adds a branch to every operation that touches a node.** Persistent tasks
(`01KN8JNPV6FV56ABBM4YBPBMYZ`, deleted entirely) began as "just a flag" and ended up owning a
dual-source sync, a split in what `done()` MEANS, a special case in close, reset, delete, `get_tree`
and launch, a third role in the system prompt, and a cache-hostile session per node. **The verdict
recorded when it was removed was "a failed abstraction".**

`status` and `metadata` live on **`BaseTaskNode`** — `status` is genuinely runtime-generic, and
`metadata` is opaque: the runtime never reads it, only round-trips it. **`tracker.setMetadata`
REPLACES the whole object; it does not merge**, and `PATCH` with an object omitting a key makes that
key DISAPPEAR.

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

**Two hooks, two moments**: `seedTree` runs once, when a project's tree is first created, and is the
worker-side complement to the daemon-side `onProjectInit` (which can create FILES but has no
tracker, so it cannot create initial NODES). `onScopeResume` runs on every startup.

## The REST boundary must reuse the shared op

> **A REST route that touches a task lifecycle resource — session, JSONL, worktree, config — MUST
> route through the same shared op the MCP path uses, or replicate its guard exactly. Where they
> drift, the REST side silently re-introduces a solved bug.**

That rule came from five bugs found together, all silent data loss rather than a crash. **`c.json`
does NOT throw on a live `session`** — SSE's `structuredClone` is *forced* to strip it, so the SSE
path was safe by accident while every REST route returning a node serialized the whole queue,
conversation and AbortController over the wire; **one transport's safety came from a constraint the
other transport did not have.** One `serializeNode` helper now wraps every node response, so the
remedy is findable by anyone who hits the hazard. **Worktree removal must use the STORED path and
branch, never a re-slugified title**, because a title can change after creation and the real
worktree is then orphaned forever. **A config write must never be able to wipe credentials**, which
took three fixes because there were three doors: `PATCH /config/global` rejects null for any
top-level field; `createDaemon` RETHROWS a load failure instead of falling back to defaults, because
the silent fallback booted with empty `authGroups` and the next save overwrote the on-disk
credentials with nothing; and `loadGlobalConfig` distinguishes ENOENT (fresh install → defaults)
from a read error or invalid JSON. **`delete_task` must stop and await the running loop before
cleanup** — it did neither what close does nor what reset does, so it removed the worktree under a
live process, destroying unmerged work, and a pending `done()` then read `getTask() === undefined`
in Phase 2 and hung the parent forever.

Lifecycle guards that were simply missing: the **root node** cannot be deleted, closed or reset;
`updateTaskOp` rejects `status: "closed"` and `"failed"`, because both are terminal states needing
cleanup a plain PATCH bypasses; and REST `/message` and `/clarify` canonicalize a task-id prefix,
validate the node is a task rather than a folder, and reject `draft` the way MCP always did.

**NEGATIVE RESULT — REST `PATCH …/tasks/:nodeId` has no subtree gate, and that is not an omission.**
Subtree permission is a concept about an AGENT's identity. REST is the user, `editedBy: "user"`, and
`createHumanAuth` grants every permission by construction. **"Add the missing check to REST" is a
plausible-looking fix that locks the user out of their own tree.**

## A partial update is a write nobody can see

**`updateTaskOp` validated and applied in ONE pass, in function-body order, and threw partway.**
`parentId` sat above the status check and `title` below it, so `{parentId, title, status:"closed"}`
reparented the node, dropped the title, and reported only that status was refused. **The shape of
the partial update was decided by LINE NUMBERS, which is not something any caller can see** — so
"the whole call was refused, I'll retry" is the correct-looking move that replays a reparent which
already happened. Now: phase 1 validates everything, phase 2 applies everything.

**The half nobody predicts: NO tracker mutator saves.** `save()` is defined once in
`task-tracker.ts` and called zero times inside it; the only save is at the END of the op. So a field
applied before a throw **lives in memory only, and `tree.json` still holds the old value** — until
some UNRELATED operation's `save()` publishes it, or a restart evaporates it. Measured, not
reasoned: a rejected update followed by an innocent rename of a different node committed the
abandoned reparent to disk. **A mutator that does not persist is not "a smaller write", it is a
write with no owner.**

**The reported symptom and the discriminating test are DIFFERENT CASES, and the task description
asked for the wrong one.** It specified: assert that after `{title, status:"closed"}` throws, the
title did not change. **That assertion is green against the broken implementation** — title sat
after the throw, so it never landed either way. The tests that catch both are the ones about a field
applied BEFORE the throw. **For the reported case the entire user-visible fix is the ERROR STRING**,
which now names the other fields and says they are unchanged too. *"Assert the other field did not
change"* is the right instinct, and it only bites when that field could have changed.

**One correct implementation, defeated by a line placed BEFORE it.** REST `PATCH` called
`tracker.assignBranch()` four lines above `updateTaskOp`, so `{branch, status:"closed"}` left the
branch assigned on a 400 — **not two implementations drifting, but one right implementation that
something upstream renders untrue.** `branch` now goes through the op. **Widening a shared op's
input type is a moment to check the tool schema**: an agent editing another task's branch
desynchronizes the tree from the worktrees on disk with nothing going red until a later close
deletes a branch that is wrong or still in use.

**Two field lists that cannot drift, without merging them.** The "did you ask for anything?" check
and `UNGATED_UPDATE_FIELDS` are different vocabularies — MCP argument names have `old_description`
and no `branch`; the op's own fields are the reverse. Neither can go stale silently: the op's is
compiler-pinned to `UpdateTaskOpts` in both directions (`satisfies` one way, an `Exclude<>`
assertion the other), and the gate's is a subtract-list. **"Don't create a second list" is not the
rule; "no list may be able to drift in silence" is** — and a refusal that must speak the CALLER's
vocabulary is a real reason for a second one.

**NEGATIVE RESULT — no `tree.json` was ever corrupted this way.** All 561 task JSONLs, 452,731
lines: 1269 `update_task` calls, 21 carrying a rejected status, **zero** combining that with a
`parentId`. The scanner reports its own positive control first. Re-runnable:
`scripts/scan-partial-update-damage.ts`.

**The one instance that DID fire is where two separately-filed defects turn out to be one call.**
The single silently-dropped field in that whole history is a `title` on task
`01KYCQVA8CP2S0X6V1QDQSBH8X` — **and that task carried the `[已解决 by …]` title named above as the
damage from `closeTaskOp`'s dead end, until it was undone on 2026-07-30.** Same call. They COMPOUND:
the dead end forced a workaround that encodes state where only a human can read it, and the partial
update made that workaround take two attempts to land. **Two small defects can multiply — and you
only ever see it by tracing one concrete incident through both, never by reading either bug
report.**

**A field dropped at a body-type boundary reddens nothing.** `POST /projects/:id/tasks` declared its
body inline and omitted `draft` and `color`, which `createTaskOp` accepts. **Failing to declare a
field is not a type error anywhere**, so a client asking for a draft got 201 plus a `pending` task —
something dispatchable, and `draft` vs `pending` is the "can this execute" bit. Pinned now the way
`UPDATE_FIELDS` is, with the limit stated beside it: **the pin ties the list to the INTERFACE, not
the list to the test bodies.**

## `get_tree` returns a minimal projection

**DECIDED (user): *"它应该不能 include detail,把这个能力删了。然后 with closed 可以有。"***
`include_details` returned the whole node, and on the real 578-node tree that measured **~114K
tokens alone and ~631K with `include_closed`, from one call** — and **no anomaly was required to
reach it**: root spent ~114K merely to count running tasks, the most natural use of the parameter
that existed.

**The reusable half is how the consumer count was taken. Two UI sites matched a grep for
`include_details` and NEITHER was a consumer**: they read whether the caller PASSED the argument, to
print a badge, and never touched a field of the response. **An argument-reader and a data-reader are
indistinguishable in a grep for the parameter name**, so decide which one each hit is before pricing
a removal, or a pure-badge site reads as a dependency and vetoes it.

**Nothing pinned the projection, and the two pre-existing tests could not have** — under a mutation
restoring whole nodes they both stayed green, because they assert only that the call did not crash.
Pinned now by an exact key-set assertion plus named absences, on a fixture carrying a description, a
cost, a result round AND a branch, because with an empty fixture every absence assertion passes
against the detailed form too.

**And the test written to prove the feature worked was itself the evidence it was broken.** It read
`JSON.parse(text.slice(0, text.indexOf("\n\n[")))` — **a payload that needs string surgery before it
parses is not JSON**, and that line was authored, run green, and re-read during a mutation pass
without anyone asking why the surgery was there. No other test caught the real break either, because
every fixture parsing `get_tree` output happened to contain no closed tasks: *a fixture that cannot
express the difference*.

## Images

`getImageDimensions` parses PNG/JPEG headers, and `read_file` rejects anything over 8000px per
dimension before it reaches a provider. Byte size is a provider-level concern (`validateImage?` on
`ProviderAdapter`): Anthropic 5MB decoded, OpenAI 20MB.

---
# Memory Index, Search and Retrieval
---

## The search index

**The tree accumulates decisions faster than anyone can remember them, so the index exists to make
"has this been solved before" answerable instead of re-derived.** `src/task-index.ts` indexes every
task's title, description and each done() round's result at per-field, per-round granularity: one
document per (task, field, round), so every hit traces to an exact location and removal is targeted.

Orama (pure TS, no native deps) with the Mandarin tokenizer and EmbeddingGemma-300M embeddings in
`mode: "hybrid"` — BM25 and cosine fused in one query, cross-lingual in practice ("fix session
recovery" ↔ "修复会话恢复" scores 0.81). If the model fails to load it degrades to pure BM25, so the
daemon is never blocked on a model download. **Orama scores are higher = better; the previous FTS5
engine was lower = better, so any threshold carried over from that era is backwards.** The engine is
pure-TS because `bun:sqlite` cannot `loadExtension`, which killed the sqlite-vec plan.

**Why the engine lives in `src/` and not in the plugin.** The red line is not "index code must sit
in `.mxd/plugin/`" — `src/` is the neutral building-block layer. The real invariant is that
**`src/runtime/*`, `runtime.ts` and `provider-shared.ts` contain ZERO occurrences of index / search
/ resultRounds, including in comments.** The layout was then forced: `search_tasks` needs
`availability: "both"`, the external-MCP list is built from `buildAllToolDefs` in
`orchestrator-tools.ts`, that is in `src/`, and `src/` may not import `.mxd/plugin/`. Likewise
`onScopeResume` is named by EVENT, not by resource — that is what keeps the boundary grep clean.

**SYMPTOM, known and unfixed: the index is case-sensitive.** `"Uppercase Widget Title"` is found by
`Widget` and not by `widget` — the mandarin tokenizer does not lowercase, and fixing it re-tokenizes
every stored document.

### Staleness is a per-document content hash

**Do not key staleness on `node.updatedAt`.** `task-tracker.ts` writes it in **16 places and only 3
touch a field the index stores** — a status transition, a cost update, or merely CREATING A CHILD
(which bumps the parent) all marked a task stale. Two consequences explain the failure's shape:
**the backlog grew with ACTIVITY rather than with content change, and it was only paid at boot, so
the longer the daemon stayed up the more expensive starting it became.** A full backfill took 4m13s
against a 30s worker-init budget, and the daemon was unbootable for hours.

Staleness is now `sha256(v1 | model | dtype | text)` **per document**. Per-document is not a detail:
a whole-task hash re-embeds every result round because one word of the title changed. Model identity
is inside the hash, which prevents **mixing two vector spaces in one index — a state that does not
fail, but returns plausible wrong answers.**

**The second staleness clause is one-directional on purpose.** A document is stale if the hash
differs, OR if it is stored without a real embedding **and embeddings are now available**. Without
that clause the failure is permanent and silent: one offline first boot writes zero vectors, the
content hash calls them current forever, and the index serves keyword-only results with nothing
reporting it. The reverse is deliberately NOT stale, so turning embeddings off can never destroy
vectors that already exist. **Migration treats "no hash" as UNKNOWN, not as stale**, because calling
it stale would make deploying this fix trigger the exact backfill it exists to prevent, on every
machine, on the next boot.

**`onScopeResume` awaits the PLAN and nothing else, and the rule is categorical: anything that
touches the `.msp` or the model is deferred — NOT "anything expensive."** `planIndex()` is pure and
measured at 12ms for 1115 documents; `applyIndexPlan()` loads the 21MB index, lazily loads the
model, and runs on a module-level **serialized** background chain so seven projects cannot backfill
concurrently. **A cheapness judgement is something a future change gets wrong silently; a
categorical rule can only be violated deliberately.** This matters because the worker's `ready`
waits on autoResume, which awaits `onScopeResume`, and terminating the worker at that timeout is
what took the daemon down.

**Batching is length-sorted, and the sort is most of the win**, because a batch costs count × its
longest member: tree order pads 1.49M chars to 4.74M char-equivalents while length-sorted pads to
1.58M.

### Choosing an embedding device

On darwin, transformers.js resolves `device: "auto"` to CoreML first — and **CoreML returns a
768-dim vector of NaN, L2 norm 0, for most inputs. Nothing raises.** The NaN-score guard then
quietly redoes every query as pure BM25, **so the product keeps working with semantic search deleted
and no error anywhere.** `auto` is also 7.4× slower than CPU.

**The failure is deterministic per input and NOT monotonic in length**, and that is the load-bearing
part: `"reconcile "` (10 chars) is all NaN, `"Fix session recovery bug"` (24) is correct, a repeated
sentence (336) is all NaN. A first pass drew only the 24- and 336-char cases and read it as a length
threshold; **it was a coincidence of two strings, and a one-string probe would have shipped.** So
`tryDevice` probes four inputs of different shapes through BOTH `embed` and `embedMany`, requiring
every result finite, right-dimension and non-degenerate — batched separately, because **a batch is
padded to its longest member, so a document that is finite alone is not necessarily finite in
company.**

**Non-monotonic forecloses the workarounds, which is why "we don't know why" is a complete result
rather than an unfinished investigation.** A length threshold would invite chunking, capping, or
probing at the boundary — any of which could be made to look like it works. **NEGATIVE RESULTS on
the CoreML knobs, so nobody spends the afternoon again**: `mlComputeUnits: CPUOnly` / `CPUAndGPU`,
`modelFormat: MLProgram`, and `allowLowPrecisionAccumulationOnGPU: "0"` — every one still NaN. **The
one that is NOT NaN is `coreml` + `dtype: "fp16"`, because there is nothing left to convert — and it
changes no decision, since fp16 doubles the weights and `webgpu` + `fp16` does not even load.** That
exception is the load-bearing member of this list: without it the list enumerates every knob that
fails and omits the only one that works, so it stops preventing the afternoon and starts aiming the
reader at it.

> **webgpu is chosen for CPU CONTENTION, not for wall-clock — and on the real corpus it is 30%
> SLOWER in wall-clock.** Full rebuild of 1115 documents: **cpu 697s wall / 3044s CPU; webgpu 909s
> wall / 38.8s CPU.** 3044s of CPU is 4.4 cores saturated for twelve minutes next to live agents.
> **Anyone "optimising" this back to wall-clock will pick cpu and starve the machine.**

**Do not log the REQUESTED device** — it prints "coreml" just as confidently while emitting NaN; log
what was *proven*. And **"webgpu vs coreml" is not "GPU vs not-GPU"**: both reach the same Metal
GPU, and CoreML's extra reach is the ANE. **There is no MPS execution provider in ONNX Runtime**,
verified from the installed library rather than recalled.

**`MXD_DISABLE_EMBEDDINGS` exists because of a process-killing NAPI bug, not for speed.** It must be
passed to workers via the Worker constructor's `env` option; a `bunfig.toml [test.env]` entry does
NOT reach a Worker.

## Retrieval that nobody acts on: guidance goes where the DECISION is

Three surfaces inject prior art: `work_context`'s `[Related past tasks]`, `create_task`'s `[Related
existing tasks]`, and `search_tasks`' tiered output. All three worked and produced real hits. **None
said what to do with a hit, so the block read as a return value: scanned, then dropped. Root's count
for one day: `create_task` called 8 times, block returned 8 times, behaviour changed 0 times,
`search_tasks` called 0 times.**

> **Put the guidance where the decision is made. If the agent ASKED for the data, the tool
> description reaches it in time — it still holds the intent it called with. If the data arrives
> UNREQUESTED, only the payload reaches it. And if NO CALL HAPPENS AT ALL, only the system prompt
> reaches it.**

**The third arm is the one that assigns the prompt its role, and it is the case the other two cannot
cover**: the agent does not recognise that the question in its hand is one the code can never
answer, so there is no payload and no description in view at that moment. **The freeze argument
applies to the prompt too and does NOT settle it.** `session_config` freezes the system prompt
exactly as it freezes tool descriptions, so a prompt edit also reaches a running agent only after a
compaction — which prices **urgency, not medium**. Handler output wins where the fix has to work
*today*; a standing disposition can wait one compaction, and a prompt line that is *wrong* is frozen
too, which argues for landing the fix rather than deferring it.

**The bash "don't pipe" precedent does NOT transfer**: that decision is made while CONSTRUCTING the
call, so the description is its decision moment. A description read before the call is guidance
about something that does not yet exist in the agent's world. **Matrix-specific tiebreaker: tool
descriptions are frozen in `session_config` until a compaction refreshes them, so a description
change does not reach a running agent, while handler output reaches everyone on the next call.** For
a fix motivated by "this failed today", that is decisive.

**The two block headers are different sentences on purpose**, because the readers can do different
things. `create_task`'s reader is ROUTING. `work_context`'s reader is already ASSIGNED the work:
read before re-deriving, and if a hit already tried the approach it is about to take, **surface that
upward** rather than obeying or ignoring it. Three capability facts were verified rather than
assumed: a working agent **cannot** `send_message` the task it found, it **can** update its own
description, and it **can** `fork_task_context` only into a sub task it creates.

**"Latest result" is the LAST round, and the last round is often trivial.** A real hit had 3 rounds:
round 0 was the whole implementation, rounds 1-2 were CSS tweaks, so the block advertised the task
as *"Restyled search hits as card-style items"* and everything worth reading was invisible. That is
the shape of any task reawakened for follow-up, i.e. most closed tasks of any size. Hence the
ordering inside the header: **the "these are excerpts and cannot tell you what a task concluded"
reframe comes FIRST**, so the hits are read as an index.

**The reading rule that prevents a NEW error**: a past round is *a measurement plus a judgement made
at the time*. The measurement usually still holds; the judgement may already be void — **and a new
task on the subject is often itself the evidence that intent changed.** An agent that reads "we
tried this and reverted" as a prohibition abandons a road it is currently supposed to walk.

**And a result round is APPEND-ONLY history, so anything wrong inside one is permanent — which makes
the copy the only place a mistake can be stopped.** Traced instance: a `done()` result said *"Filed
as `01KYR23…`"* naming an id that resolves to nothing, this file copied the id out of it, and the
copy sat here until someone tried to follow it. The round itself stays wrong, correctly; nothing
should edit history. **So `get_task` a hit before you quote its id, for the same reason the header
tells you to `get_task` before you trust its excerpt** — an unresolvable id looks exactly like a
real one until it is dereferenced, and every copy multiplies the places that has to happen.

**An instruction you cannot execute is decoration.** Both fixes here are only worth doing BECAUSE
the header now says "get_task these": the block prints the **full taskId** (12 chars resolves, an
ellipsis does not), and dead hits are dropped rather than rendered with a real-looking but
unresolvable id.

## Every hit says what it IS before its body is read

Status, both dates, and for a terminal task whether it ever actually ran. All three surfaces share
the vocabulary in `src/search-hit-format.ts` — *N of M doors* in its second medium, because the
third renderer goes on handing out the old shape to a reader who cannot tell which renderer produced
it.

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
and confident about it.**

**"Did it ever execute" is the UNION of three signals, not a choice among them.** Each is
one-directional POSITIVE evidence: a session file, a recorded cost and a reported round can only
exist if the task ran. So OR-ing them cannot produce a false "ran", while every single member
produces false "never ran"s.

| signal | really answers | its blind spot |
|---|---|---|
| `resultRounds` | did it REPORT? | postdates most of the tree — **365 of the 417 closed tasks that had run carried no round** |
| `costUsd > 0` | did it SPEND? | one closed task had a session and no cost: launched, died before any usage landed |
| session JSONL | did it ever HAVE a session? | one closed task had a cost and no file — a session can be cleared by hand or by `reset_task` |

`resultRounds` is the member that looks right, and alone it would have relabelled **88% of this
repo's executed history as an unexecuted proposal** — precisely backwards about what the description
means. `branch` / `worktreePath` cannot be used at all, because close nulls them. **The probe that
produced that table was broken on its first run**, reporting no session file for all 551 tasks;
believed, it would have handed the decision to `resultRounds`.

**Dedup runs BEFORE the full/brief tier split, not after.** A real `search_tasks(limit 6)`: three
tasks filled all six slots, one appearing once as a full entry and once as a brief one with its
entire description repeated verbatim. Merge the duplicates' field labels into the survivor rather
than dropping them. **Dedup is unconditional, and the objection against that is worth keeping
because it is a good one**: `search_tasks` advertises "the best-matching LOCATIONS", so two hits
inside one task ARE two answers. It is not a regression, **because the locations survive** — merging
keeps every label, round indices included. What dedup drops is a second copy of a 500-char
description and a second score, neither of which was ever a location.

## `search_logs` — the conversation is searchable, one task at a time

`search_tasks` indexes the DECISIONS. `src/log-search.ts` searches the conversation: **how they were
reached**, which is the only place a user's own words survive before anyone retold them. A
description is written after the decision (one retelling), a result round after the work (another) —
and the hedge in *"我记得…"* was lost between those two retellings while carrying a design
conclusion for four months.

**SCOPE, and the thing to refuse: one task, scanned on demand, NO index.** Rebuilding the existing
index over 1115 SHORT documents costs 697s wall; this project's 454 session files are **600MB**. A
global conversation index is not a smaller version of that problem.

Measured on the largest real file (113.5MB, 71,148 events): full streaming parse **154ms**, full
search ~300ms. **So the cost that needed bounding was MEMORY, not time** — hold the parsed events
and you cost hundreds of MB inside the worker running the agent loop. Stream and reduce each event
immediately; never accumulate. **NEGATIVE RESULT: a raw substring pre-filter before `JSON.parse`
measured 51ms vs 154ms — a real 3× on something already negligible, bought with a silent soundness
hole**, since JSON escapes `"`, `\` and control chars so any query containing one would fail to
match lines that do contain it.

**Where the text lives is NOT uniform, and the task description warning about this got two of its
three rows wrong.** Measured: `message` → `body`, `assistant_text` → `content`, `thinking` →
`thinking`, `tool_call` → `input` (no `body` at all), `tool_result` → `content`. **So the fix is not
a better per-type table — it is not having one:** walk every string leaf and SUBTRACT a named set of
identifier/blob fields (`eid`, `taskId`, `signature`, `source`, …). A new event type is then
searchable for free, where an include-list of "fields worth reading" fails silently forever.
`signature` is the expensive subtraction: thinking is 22MB of one session and much of it is base64.

Kind = type plus its discriminator (`message:user`, `tool_call:mcp__mxd__bash`), and filters match a
group by prefix. Default = everything MINUS `tool_result`, `message:work_context` and
`session_config`. **The principle for adding a fourth is not size — it is that all three are COPIES
OF SOMETHING ELSE**, so a hit inside one crowds out content that exists nowhere else. `message:user`
is the single biggest category and is the whole point. **Whatever is skipped, the header SAYS SO,
and a zero result lists the kinds the file does hold** — otherwise "no matches" and "you searched
the wrong kinds" are byte-identical.

**Context events are drawn from the same filtered population and only from events that HAVE text.**
Both halves came from reading real output: without the filter ±1 event is almost always `usage` or
`messages_consumed`, and the first render showed `(no text)` under half the hits. Context text is
the **longest** leaf, not the first — a `tool_call`'s first leaf is the tool NAME, so "first"
rendered every bash call as the bare string `mcp__mxd__bash` with the command one field away.

### Cap on BYTES, never on event count

`01KP1B56XZX4BT56EGTKS5K74Y` measured `get_logs` at 60KB+/call in April and traced it to
`tool_result` content plus thinking-signature blobs; that is why `hideToolResults` defaults true and
signatures are stripped. **RE-MEASURED: `get_logs(begin=0, end=2)` — TWO events — still returns
~60KB, now from `work_context` preloading the whole of `memory.md`.** The April fix works and simply
does not cover this path.

> **One oversized category was identified and mitigated, and a different one grew into the same
> envelope. A byte-keyed cap survives that substitution; a cap keyed on "which event types are big"
> was correct in April and wrong today.**

And a count bounds nothing regardless: one `message:user` in the root session is **1.68MB**, so a
single event can outweigh every other event combined.

**The over-strict half of a budget guard is invisible, and it was the ONE survivor of 30
mutations.** Dropping the "always render the first hit" escape reddens nothing, because with
production's numbers one hit can never fill the budget — so the failure it allows (a header
announcing *"166 matching events"* above zero hits) is unreachable *today* and one raised
`maxContext` away from shipping. Two things fix it, both needed: an **injectable budget** so the
failing path can be exercised at all, and an assertion that `MAX_SINGLE_HIT_CHARS < totalChars` —
**a relationship between two constants declared far apart, i.e. an invariant that holds by
coincidence until someone edits one of them.** Injecting the budget then created its own survivor: a
mutation ignoring the parameter is harmless in production and **silently makes the over-strict test
vacuous**, so it needs a positive control.

**A zero-length-match regex (`q*`) is a SYNCHRONOUS infinite loop, and no test timeout can interrupt
it** — measured: the harness sat for 622s and bun's per-test timeout never fired, because the
blocked event loop cannot run it. `if (m[0].length === 0) re.lastIndex++` is the whole guard. **On
macOS there is no coreutils `timeout`**, so a harness must bound the run itself and report a hang as
its own verdict rather than as a pass.

**`availability` gates ONLY the external MCP list.** `createOrchestratorTools` maps every def with
no filter at all, so internal agents receive `"external"`-declared tools too — which is why
`get_logs`, declared `"external"`, is callable from inside the agent loop. **So the flag is a claim
about the external list and NOT a statement of who can call the tool.** Filed as
`01KYSK4VJREN5SDMM2BA2YNGGW`.

## A migration that adds an identifier makes it non-uniform FOREVER

**Every reader of a newly-introduced id needs a DEFINED rendering for the pre-migration half, and
the default failure is that teaching the new mechanism is the very act that makes the old data look
broken.** Two instances, which is what turns it from a footnote into something to check whenever an
id is introduced: the `Task-Id:` commit trailer (1280 historical commits will never have one), and
the event `eid` (**3296 of 397,771 events, 0.83%**, newest 2026-04-16).

**The sharper half, shared by both: the pre-migration population and the population you most want
are THE SAME POPULATION.** A retrieval tool reaches for the oldest history — that is what it is for
— so the hole sits exactly where the value is. `search_logs`' motivating find is a 2026-04-05 event,
inside the unstamped window. A reader that drops unnamed events is broken precisely on its best case
while looking correct on every fixture.

**The resolution both times: render the hit and say the name is missing. And make the absence
structural, not typographic** — `search_logs` emits NO `eid=` token at all rather than `eid=(none)`,
so anything parsing for `eid=([0-9a-f]{12})` finds nothing and concludes "absent" instead of
capturing a placeholder that reads like a real name.

**Root asserted "every hit is identified by eid" from the memory rule alone** (*Nothing in this
codebase may address an event by file position* — which is correct, and positional addressing stays
out). The rule was right; its universality was not. **A rule quoted from this file is a hypothesis
about the data until somebody counts.**

## The code→task link is a trailer on every commit

**WHY, in the user's words: *"所有的 commit 都有信息"* — every commit carries its own provenance.**
The old link was structurally MISALIGNED rather than merely thin: the id rode on git's default
`Merge branch 'mxd/<taskId>/…'`, and **`git blame` never lands on a merge**, because a clean merge
carries no changes — so even a surviving id named a commit nobody was holding. Measured: 3755
commits, 1285 merges, **2470 non-merges, which are the ones blame hands you**; and of the merges
only 102 still named a task, because `git merge -m "<a good sentence>"` overwrites exactly that
line. **The habit gets worse the more carefully you write.** A trailer on every commit made inside
the worktree dissolves both problems (`01KYQMNB0DPAZ3XJGATTW2NQAP`). **Preserving provenance had to
be a MECHANISM rather than an instruction, and the measurement above is exactly why**: an earlier
attempt to ship it as a prompt bullet was written and deleted, because using evidence that agents
forget to justify "remember to do it manually" runs that evidence backwards.

| file | its part of the mechanism |
|---|---|
| `src/worktree-manager.ts` | `git config --worktree mxd.taskId <id>` at creation |
| `.mxd/hooks/setup_worktree.sh` | points `core.hooksPath` at `.hooks/worktree` |
| `.hooks/worktree/prepare-commit-msg` | reads that config, appends the trailer |

**Migration constraint on the CONSUMER side: nothing that reads a trailer may present its ABSENCE as
"no provenance".** Route through the TIME COORDINATE, which holds for every commit ever made — `git
log -S'<phrase>'` finds when a line arrived, then read that commit *and the ones around it*, since
what landed alongside is usually what it was for — and treat a trailer as an accelerator where it
happens to exist. **`git blame` answers who touched it last, often cosmetically.**

**`.hooks/worktree` holds `prepare-commit-msg` and nothing else, and aiming it at `.hooks` instead
is the tempting near-miss**: that directory holds `pre-commit`, which worktrees skip deliberately
because agents commit constantly. Recording provenance and gating a commit are separate decisions
(`01KNJ7PT19V1HE1ZRT5KW8X043` owns the gate question). **`git config core.hooksPath` answers "is a
hook wired", never "is a gate wired" — list the directory.**

Two decisions that look like details. **The id comes from git config, never from parsing the
worktree path**: the path shape has changed before, and config is where a worktree's identity
durably lives. And `--if-exists doNothing` makes an inherited `Task-Id` win over ours, because one
commit carrying two ids makes `%(trailers:key=Task-Id)` answer ambiguously for every consumer — **a
trailer arrives inherited via `git commit -c` and via cherry-pick, and naming those is what stops
the flag reading as a guard against a case that cannot arise.** **The hook never exits non-zero**: a
failing `prepare-commit-msg` aborts the commit, so a bug in there takes away the one thing an agent
needs in order to fix it. **Root's own commits carry no trailer**, because root works in the main
worktree; accepted, root's id is a constant.

### `git interpret-trailers` has its own opinion about where a message ENDS

**Three traps in this hook, and all three are that one fact: whenever the trailer is placed
somewhere that is not the last paragraph *as `%(trailers:…)` sees it*, the id sits in `%B` looking
perfect and the parser reports nothing.** The next one will look unrelated too — this is the
sentence that says where to look.

1. **`MERGE_MSG` arrives with NO trailing newline; `COMMIT_EDITMSG` does.** Hand the former to
   `--in-place` and the trailer is joined to the subject by a single newline. Every merge made
   inside a worktree lands there. Append a newline first. **This is why an assertion about a trailer
   must go through `%(trailers:…)` and never through a substring of the message.**
2. **An empty message plus a hook that adds content is a commit whose SUBJECT is `Task-Id: …`.** Git
   aborts such a commit only because it is empty, and the hook rescues it into existence. Guard on
   "nothing but blanks and comments" and do nothing.
3. **A line beginning `---` is the format-patch divider**, so interpret-trailers stops the message
   there and inserts the trailer ABOVE it. The asymmetry is one-sided and is the whole mechanism:
   **only the WRITER honours `---`; the reader just takes the last paragraph.** Fix is one flag,
   `--no-divider`.

**MEASURED, and the result is a NEGATIVE one worth more than the fix — `---` is the whole class, not
one spelling of it.** Read back through git's parser: `---` and `--- any text ---` are unreadable
without the flag; `----------`, `___`, `***`, `-- `, `--` and `diff --git a/x b/x` are all fine. So
`--no-divider` disables the single end-of-message heuristic that exists rather than guarding one
spelling, and **there is nothing else to go and guard.** Note the asymmetry someone will trip over:
git wants `---` followed by whitespace or end-of-line, so a LONGER markdown rule is safe while the
short one is not. **Do NOT add a test asserting `----------` still works** — it passes without the
flag too, so it cannot express the difference.

**The hook checks its own work, and WHERE that check can live is the whole finding.** A `pre-commit`
audit of trailer damage is structurally blind, because **the commits that CAN be damaged are exactly
the ones a `pre-commit` hook never sees**: pre-commit never runs in a worktree, a clean `--no-ff`
merge runs no hook at all, so a gate there sees only root's direct commits on main — which carry no
trailer whatsoever and therefore cannot exhibit the defect. **Three files have to be held at once to
see that**, which is why it was invisible to two people in a row. Second reason, independent and
generalising past this hook: **an audit of history cannot be a gate**, because the damage it reports
is in a commit that already exists, so a blocking check refuses your innocent new commit until
somebody rewrites history. **A gate you cannot satisfy by doing the right thing teaches bypassing.**

So the check lives in `prepare-commit-msg`, warns on stderr, and never fails — the one moment the
author can still `--amend`. **It is not a second reader implementation**: running `git
interpret-trailers --no-divider --parse <msgfile>` applies git's OWN last-paragraph rule, measured
to agree with `%(trailers:key=Task-Id,valueonly)` on **11 of 11** shapes, including messages trailed
by comment or scissors blocks, which is the half that would otherwise warn spuriously on every
editor commit. `--no-divider` is load-bearing on the PARSE call too. **The guard has a test for each
direction** — deleting the check reddens one, making it warn unconditionally reddens the other — and
over-strict is the direction nobody tests, which here is the expensive one, because a check that
cries on every commit is read as wallpaper within a day. **The state is unreachable through a
correct writer, so the test breaks the WRITER on purpose**: `installTrailerHook` takes a mutation
stripping one flag from the shipped script, leaving the code under test verbatim.

---
# Daemon, Worker and Transport
---

## Durability at the process boundaries

**`shutdown()` order is fixed**: stop every running project's agent, then await residual loop
promises (bounded 1s), then flush every EventStore. `stopAgent` awaits loop settlement with the same
bound, symmetric with `stopTask` — that closes the race between `POST /stop` returning and the
`finally` block's `agent_end` / `done_notified` / MCP-disconnect writes, and it is what stops
`DELETE /projects` → `rm -rf` racing in-flight writes.

**Do NOT call `fg.resolve()` in `stopAgent`.** It looks like the tidy way to deal with a foreground
bash ignoring abort, and it moves the command cleanly to background — which **breaks the
orphan-repair semantic.** A stuck tool is supposed to get bounded grace and then be left as an
orphan, so repair synthesizes the interrupted tool_result on the next launch.

**The 1s bound is an ENVIRONMENTAL FACT FROZEN INTO A CONSTANT, and the environment changed without
anything announcing it.** The note that set it read *"3s was too slow for 5s test timeouts; 1s is
the sweet spot"* — a sweet spot found on a machine running one suite. Today 3-4 sub-agents each run
the full suite in their own worktree while root runs it too. **Parallel agents are how this project
WORKS, not an accident**, so that assumption is not occasionally violated, it is systematically
false. Open question, unchanged: whether 1s still holds under parallel load
(`01KYCMVKN14RRX0KK0H2CNTD9P`).

**Worker init has a 30s timeout.** Without it a plugin whose `runtime.ts` hangs at top level hangs
daemon boot forever — no log, no 503. **A `beforeAll` that calls `createDaemon` with a worker must
budget ≥ that**, or on a real flake the test's own timer fires first and you get a useless
"beforeAll timed out", **masking the daemon's much better "Worker init timed out: <plugin>" message
that names the actual stuck plugin.** `createDaemon` costs ~213ms cold and ~346ms under heavy
contention, so 30s has 100×+ headroom; a 15s budget had >40× and still flaked. **Do not try to fit
it under 15s "to fail fast" — fast is meaningless when it fails on the wrong timer.**

**`.mxd.lock`** at the dataDir root is acquired with `O_EXCL` and holds `{pid, startedAt, version}`;
a stale lock whose PID is dead is stolen, a live PID errors out. It is opt-in, because tests run
concurrent daemons on isolated tempdirs, and it refuses even when the lock holds our own PID — a
second `createDaemon` in one process is a test bug, and surfacing it beats tolerating it.

## An ORT session dies with the thread it lives on, so it gets its own process

The embedding session lives in a child process. Worker threads never load ORT. Keep it that way; the
rest of this section is why.

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
held a session → a recoverable "one plugin failed to load" became a hard failure.

**Why a child process and not the alternatives.** Main-thread inference is crash-safe by the table
above but blocks the HTTP shell the worker architecture exists to protect. The WASM backend avoids
NAPI entirely, but transformers' node build has no `wasm` device. "Never terminate a worker holding
a session" trades a native abort for a leaked thread and disables worker restart — the daemon's own
crash-recovery mechanism — exactly when a plugin is misbehaving. **Cost of the fix is small and
partly negative**: spawn plus model load 939ms once, ~4ms of IPC per query, and the parent now burns
0.02s of user CPU for work that used to run on the thread next to the agent loop.

**Lifecycle is inherited, not managed.** When the spawning thread goes away Bun closes the IPC
channel and `disconnect` fires in the child, which exits — one mechanism covering worker terminate,
worker restart and daemon shutdown, with no bookkeeping and no leaked 500MB process per restart.
**The regression that would silently undo this is one line: a static `import … from
"@huggingface/transformers"` in any module a worker loads.** Everything keeps working until the next
shutdown, which is exactly how this sat unexamined for two days. A test greps three files for that
shape.

## The self-bootstrap death chain

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
fail — **`process.exit(1)` does NOT fire `onerror`**, and a module-level `throw` is caught by
scope-worker's own try/catch and becomes `{type:"error"}` instead.

> **STANDING RULE, and the death chain is the argument for it: never delete the external boot
> path.** The catastrophic form of self-bootstrapping is not a crash — it is breaking the file
> editing, command execution or daemon startup you would need IN ORDER TO FIX IT, which is a
> compiler emitting a broken compiler when the broken one is the only one you have. So matrix must
> stay rebuildable and startable from outside itself: a plain shell, a bare `bun test`, a `git`
> checkout, the CLI on `$PATH`. Rust keeps mrustc for exactly this reason. **The low frequency IS
> the hazard** — an external path that looks unused is what a cleanup deletes with nobody objecting.

## Two transport bugs that corrupt silently

**`response.text()` on a proxied response destroys binary data.** It decodes as UTF-8, so **every
byte above 0x7F becomes U+FFFD** — a 256-byte binary payload inflates to 512 and a PNG header
becomes garbage. Fixed with `arrayBuffer()` plus a transferable postMessage. Request bodies are
*not* affected today only because they are JSON in practice.

**Bun Workers do NOT inherit `process.env` assignments from the parent thread.** They get their env
from the OS process snapshot at spawn time, so `process.env.X = "Y"` in the main thread — and
therefore `bunfig.toml [test.env]` — is **invisible** to a file-based Worker. The only way through
is the `env` option on the Worker constructor. Verified empirically, including the confusing part:
**data-URL workers DO inherit it**, so a minimal repro can "prove" the opposite of production.

## SSE catch-up must survive a restart: epoch-prefix every event id

**Symptom: after a daemon restart, an open page stays blank until F5**
(`01KPCY0GC8DBTTHZYH3PRPCT6R`, a draft promoted by a live user report). Per-lens seq counters
restart at 0 on every boot. There was already a guard for a pre-restart cursor *beyond* the new
tail, but not for one falling *inside* the new incarnation's refilled range — and after a real
restart agents auto-resume and stream, so the buffer refills past the browser's low cursor before it
reconnects.

**What that is: a sequence number is only meaningful INSIDE one process incarnation, so comparing a
cursor across a restart is a category error — and `getEventsSince` had no way to say so.** It
returned `[]` for two different situations, *you are caught up* and *your cursor means nothing to
me*, and the caller could only read the second as the first. **That is *Two situations, one
observation* in the transport layer**, and the epoch prefix is precisely what buys the ability to
TELL them apart: it puts the incarnation in the name, so a stale cursor becomes recognisable rather
than merely small.

Every SSE `id:` is now `<epoch>-<seq>`, minted once per `createDaemon`, and catch-up runs **only**
when the cursor's epoch matches. **Both `id:` emit sites must use the formatter** — the live relay
and the catch-up replay — since one bare-seq emit poisons the client's NEXT reconnect cursor. The
client needs zero changes: EventSource echoes `Last-Event-ID` opaquely.

Two adjacent restart-window holes closed with it. **There is ONE `worker.onmessage`, installed
before init**: the old code swapped in the runtime handler after `ready`, but **the worker posts
`sse_event`s DURING init**, so those were dropped silently — harmless on first boot, but on a worker
auto-restart the SSE clients are still connected daemon-side and miss every recovery event. And
**`/events` initial state polls for worker readiness for 3s, deliberately not the spec's 2s**,
because the restart backoff is 2s and expires exactly as the restarted worker *begins* init, so a 2s
poll guarantees a miss.

---
# Plugin System
---

## What a plugin is, and the boundaries that keep it one

A plugin is `.mxd/plugin/`: a manifest, a worker-side `runtime.ts` supplying `ScopeOpts`, and a
`web/` React component the shell lazy-loads. **Matrix is one of these and is discovered by the same
scan as any other — that constraint is the only thing keeping the runtime honest**, and it is
checkable: `src/` has ZERO production imports from `.mxd/plugin/` (delete the plugin and the shell
still compiles); plugin web has ZERO imports from `../../../src/`, reaching shared code through
importmap aliases; the runtime **throws** if `buildScopeOpts` is not provided, with no silent
fallback to a built-in matrix scope; and `src/runtime/*`, `runtime.ts` and `provider-shared.ts`
mention no matrix concept, including in comments.

**The hook list is deliberately not reproduced here.** It lives in `src/runtime/context.ts`, it has
grown several times, and two hooks have changed arity — a copy here would go stale silently because
there is no compiler between the two. What the type signature cannot tell you: **hooks are named by
EVENT, never by resource.** `onTaskDelete`, not `removeWorkspace` — the latter presupposes that
tasks HAVE workspaces, which is a plugin-specific assumption the runtime must not encode. Prose
comments may say "workspace"; hook NAMES may not.

**CAVEAT on "the runtime is generic": only the hook INTERFACES are.** The concrete `TaskTracker`
still stores matrix's `TaskNode | GeneralNode` directly and is not generic over `BaseTaskNode`.

**What extraction actually moved**: `buildMatrixScopeOpts` moved into `.mxd/plugin/`; the **leaf
utilities stayed in `src/`** (WorktreeManager, `createOrchestratorTools`, `buildSystemPrompt`,
`McpClientManager`) and the plugin imports them, because plugin→src is the allowed direction. **The
leak was `buildMatrixScopeOpts` living in `runtime/agent-lifecycle.ts`, not the utils** — `grep
WorktreeManager src/runtime/` is zero, and that is the check.

## `/api/<plugin>/*` — explicit URLs, no hidden rewriting

Plugin-owned routes live under `/api/<plugin-name>/*` on the wire; the daemon strips the prefix and
the worker serves its routes as if at root. `pluginApiPrefix(name)` is the single source, imported
by the daemon router, the CLI, the plugin's URL builders and `web/runtime-types.ts`, so a format
change propagates atomically across all four.

**The `app.all("*")` catch-all was REMOVED, and that is the point of the change.** An unprefixed
plugin path now 404s instead of silently falling back to "the first global worker" — which is why
`/version` and `/stats` needed explicit daemon-level forwarders. External MCP clients configured
against the old `/mcp` URL break, deliberately and with no deprecation alias.

**`pluginApiPrefix` lives in `src/plugin-url.ts`, which has ZERO imports, and it must stay that
way.** `web/runtime-types.ts` re-exports it to browser code; when it lived in `plugin.ts` it dragged
in `data-paths.ts` → `node:path`, and Bun's browser target polyfilled the entire module into every
plugin's first-load bundle: **10,293 bytes → 281 bytes when it was split out.** A test asserts the
shared module stays under 500 bytes.

**Rejected alternatives, so nobody re-proposes them**: a shell `authFetch` wrapper would need a
daemon-route passthrough list, coupling the shell to the daemon's internal routing table; and
plugin-via-props data flow is cleaner long-term but was 100+ LOC of scope creep.

## Additive dual lenses

A project that ships its own `.mxd/plugin/` is served by **both** its own scope and the global
matrix scope, on separate per-scope data roots. `matrix:<id>` is the dev lens; `<own>:<id>` is the
product lens. **Shipping a plugin ADDS a lens and never removes the matrix one.**

**The first implementation made ownership EXCLUSIVE (`own ?? global`) and was reverted. Do not
re-derive it.** Four reasons, the first decisive: **`<scope>:<project>` is a TWO-PART address, and
its existence proves the relationship is dual** — if a project mapped to one scope the prefix would
be redundant. The design was always "parallel run loops, alongside NOT override". Self-bootstrap
requires coexistence, because matrix is its own product and "the product is a dev tool" only holds
if a project opens in both lenses at once. And per-plugin `dataRoot` was built for exactly this.

**If any routing decision tempts you toward "a project belongs to ONE plugin", that is this bug
returning.** Consequences that would otherwise look arbitrary: `scopesForProject` is all globals ∪
the project's own plugin, **globals-first**, so the default lens is dev/matrix; `projectsForPlugin`
gives a global plugin **ALL** projects, with no double-resume because the lenses live in distinct
data roots; and `DELETE /projects/:id` **fans out** a stop to every scope serving the project. **SSE
is scope-aware**, keyed by `lensKey = ${projectId}\u0000${scope}`, with the relay deriving the lens
from the *emitting* worker, so a product viewer never sees the dev tree. **Default lens is
dev-first**, because defaulting to product would make first load identical to the reverted exclusive
model and hide the addition. The default should teach the model.

## The plugin SDK: one zod, one live module

An out-of-tree plugin imports `mxd/plugin-sdk` — a subpath of the real `mxd` package — rather than
counting `../`s. Chosen over `@mxd/plugin-sdk` on purpose: the `@mxd/*` names are BROWSER virtual
modules, a different mechanism, and a server package reusing that prefix would falsely imply
kinship.

**It must stay a thin re-export and must never become a vendored copy.** Bun and Node dedupe modules
by REALPATH, so a plugin importing through its `node_modules/mxd` symlink resolves to the same
physical files and therefore the **same process singletons** the agent loop uses — in particular the
module-level `_ctx` in `resource-registry.ts`. A vendored copy has a different realpath, a different
`_ctx`, and **message delivery silently no-ops with no error.**

**`package.json` pins `zod` EXACT, and the caret must not come back.** The SDK does `export { z }
from "zod"` so a plugin's `z.string()` passes matrix's `shapeToJsonSchema` — which only works when
both sides are the same `ZodString` class. A caret let a consumer drift, producing two distinct Zod
identities and a `defineTool` that stopped typechecking. **`package.json` is strict JSON and cannot
hold a comment, so this paragraph is the only record of why.** The `@anthropic-ai/sdk` pin is exact
for the same class of reason.

**The `exports` map also GATES deep imports**, and that gating is load-bearing: `getTracker` and
`deliverMessage` are un-importable, and only `deliverToNode` + `listNodes` reach a plugin — semantic
narrowing rather than cosmetic, giving delivery that cannot be misused and a read-only snapshot that
cannot mutate the tracker. `deliverToNode` is a thin wrapper over the ONE `deliverMessage` path, so
it keeps the wake-an-idle-recipient semantic, and **no permission policy is baked in**: matrix's
ancestor/sub-task restriction is matrix policy. **`deliverToNode` throws "deliverMessage not
registered" outside any agent loop**, because `_ctx` is set on the `createApp` path while
`_deliverMessage` is registered inside `createAgentContext` at agent launch.

---
# Auth and the External API
---

## Auth is always on, and the anonymous surface is four things

**Read this whole region as answering ONE of the two security questions. It is about authenticating
the USER to the daemon. Nothing here — and nothing anywhere else — constrains the AGENT: there is no
sandbox.** An agent has full filesystem, network and command access, bounded only by the OS user the
daemon runs as. That is a deliberate and acceptable trade for single-user local software, and it is
the stated blocker for ever hosting this. The failure it causes is a reader who finishes a hundred
careful lines about tokens, masking and skip lists and concludes *security here is handled* — so
**split every "is this safe?" in two: can an unauthenticated stranger reach it (this region answers
that), and can a misbehaving agent do it (the answer is yes, always).**

There is **no auth-disabled mode and no opt-out.** Every `createDaemon` unconditionally runs
`ensureAuthInitialized`; an anonymous request to a non-skip path is ALWAYS 401. Tests mint a token
rather than disabling auth. Production binds `127.0.0.1` unless `MXD_BIND_HOST` is set — the old
`*:7433` default was LAN-reachable during the bootstrap window.

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

**Item 3 is `GET`-only on purpose.** And **the predicate is `pm.has(firstSegment)`, not a ULID
regex, deliberately the SAME predicate used by the SPA-fallback wildcard**: one predicate, one
answer, so there is no way to get "auth bypassed but the wildcard 404s". A regex was considered and
rejected — a project's *existence* is the correctness condition, not its id format, and under a
regex a deleted id would load a broken SPA that 404s on its own data fetches instead of 404ing
cleanly.

**`/auth/logout` requires a valid token.** It was in the skip list, so any drive-by page could POST
it and force a secret rotation, logging out every active user — CSRF denial of service. The
handler's own docstring already described the 401 behaviour; the code just did not agree.

## Tokens and credentials

JWTs carry `sub` (`"cli" | "session" | "stream"`) and `sv` (secret version). `/events` accepts only
`stream`; REST accepts only `cli`/`session`; a token with no `sv` always fails. **The long-lived
session token never appears in a URL** — the frontend POSTs `/auth/stream-token` before every
EventSource connect and passes a 5-minute token as `?token=`; the heartbeat re-verifies it and on
expiry emits a named `auth_expired` event, which the client's watchdog turns into a fresh token.
**`mxd watch` must do the same** — its own `sub: "cli"` token is rejected by `/events`, producing a
401 → reconnect → 401 loop forever.

**There is no auth cache, and do not add one back.** A previous `authDataCache` produced "the user
ran `mxd auth` but the running daemon never re-read `auth.json`". `readAuthData` hits disk on every
call; it is a small local JSON file and the cost is negligible against that failure mode. Relatedly
it **throws** on a parse failure, an empty file or a read error, returning `{}` only for ENOENT, and
`writeAuthData` writes to a temp sibling and renames — before auth became mandatory, a truncated
`auth.json` was a file state that silently disabled auth entirely.

**Credentials are masked on read and protected on write, in three places.** `maskConfig` replaces
every credential on every config view; `mergeAuthGroups` preserves the plaintext when a client
echoes back a masked value, which is what keeps the UI's "save the entire authGroups object" pattern
safe; and `PATCH /projects/:id/config` and `/config/repo` **return 400 if the body contains
`authGroups` or `defaultAuth`** — that last one was CLI-only enforcement before.

**`auth.json` needs BOTH a mode on write and a chmod on init, because of a POSIX detail that looks
like a bug.** Node's `writeFile(path, data, {mode})` only honours `mode` on file CREATION;
overwriting an existing file silently preserves whatever mode the inode already has. So without a
boot-time `ensureSecureFileMode`, an `auth.json` created by an older version stays `0o644` forever
even after every rewrite, leaving `jwtSecret` world-readable and forgeable by any local user. The
mask is `(mode & 0o077) !== 0`, so a user-hardened `0o400` is left alone.

**UI logout is server-first, and the order is the point**: POST logout → clear token → reload.
Clearing locally first leaves the session JWT valid on the server for up to 30 days, so a stolen
`localStorage` copy replays from another browser.

**Upstream errors are classified before they reach a user** — `classifyUpstreamError` maps `{status,
keyword}` to `auth / rate_limit / credits / …` with a one-line headline, keeping the raw message for
debugging.

## A permission list sorted by MECHANISM groups recording with destroying

**`update_task`'s `title`, `description` and `color` are ungated — settable on ANY node, anywhere in
the tree. `status`, `draft` and `parentId` keep the `requireSubtreePermission` check** at handler
entry, alongside `close_task`, `delete_task`, `reset_task` and the three folder tools.

**The blanket gate's stated justification was void, and it named its own refutation.** The comment
above it defended exactly one case: `status="closed"` triggering worktree and JSONL cleanup. That
case is unreachable through the tool. So apply the premise/obligation split field by field, and the
obligation is real for structure and lifecycle and **empty for prose**: `create_task` already lets
you author that exact text at that exact tree position, **so the gate never prevented a bad edit —
it only prevented the FIX.**

**What the old rule got wrong is the axis it sorted on.** April freed `create_task` and left
`update_task` grouped with delete/close/reset, by MECHANISM. Sorted by ACT, editing a description is
*recording intent*, the same act as `create_task`, later in time. The April principle is not
weakened by this, it is applied more precisely: **recording intent is free wherever you are;
exercising authority over someone's tree or lifecycle is not.**

**The cost was paid in lost knowledge rather than in error messages.** One agent filed a draft
outside its subtree (allowed), then found the provenance that turned it from "a new rule" into
"restore a shipped invariant", and could not append it — the paragraph became a message asking root
to paste it in by hand. Another put a `color` argument into the `description` TEXT of a task it had
created two minutes earlier, and was refused permission to take it back out. **A model that lets you
write a thing but not correct it does not prevent bad edits — it converts good ones into someone
else's chore, and the record it leaves is one its own author cannot fix.**

**`draft` is a status setter wearing another name**, and it is why the gated set is three fields and
not two: `updateTaskOp` runs `updateStatus(id, draft ? "draft" : "pending")`, so `draft: false` on a
foreign draft makes it startable. It is pinned by its own mutation rather than riding along with
`status`.

**Only the refusal string reaches a running agent.** Tool descriptions are frozen in
`session_config` until compaction, so the description carries the durable statement of the rule and
the refusal carries the actionable half: it names WHICH field was refused and says the prose fields
are editable from anywhere. Without that, an agent told only "not your task or descendant" concludes
prose edits are impossible too.

## The external MCP endpoint

`POST /api/matrix/mcp` is a stateless MCP Streamable HTTP transport — no attach, no session state.
The tools are gated by `availability: "internal" | "external" | "both"`, and the intended workflow
is `send_user_message` → `yield_external` → `get_logs`. **The tool count is deliberately not written
here**: a number in prose is indistinguishable from a true one on the day it stops being true, and
`src/mcp-endpoint.test.ts` pins the list with `toContain` per name — an ADDITION list, so it cannot
notice a tool that leaves, which is worth knowing before trusting it.

**Anti-pattern this endpoint taught us: an attached external observer and a peer project are
different relationships.** Layer 1 is asymmetric (an observer attached to a running agent); layer 2
is symmetric (two projects as peers). **The same wire format does not make them the same semantic**
— check symmetry before unifying two things that look alike on the wire.

**`mxd config auth add` auto-promotes the first group to `defaultAuth`.** Provider resolution reads
`cfg.defaultAuth`, so add-without-promote was a half-command: a fresh user followed the README and
the next `mxd send` threw "No auth group configured". Adding a *second* provider leaves the existing
default alone — we never silently clobber an existing pick.

---
# Web UI
---

## Root is a regular task: the null-sentinel anti-pattern

> **Any code that treats root specially at the ROUTING, TARGETING or IDENTIFICATION level is wrong.
> Root has an id like any other task; use it.** Only the TREE VISUALIZATION layer legitimately knows
> which node is root, for drawing the hierarchy and the orchestrator tab.

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

**Two design lessons came out of getting this wrong first**, when the initial attempt built a
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

> **When two layers coordinate through a shared serialized blob — one hash, one query string, one
> localStorage key — look for the segment each layer owns and give each direct access to only its
> own. If "they must agree" is the contract, the contract is wrong: sooner or later they disagree.**

That was not theoretical. The previous design put `#projectId/taskId` in one hash that both layers
wrote, and they trampled each other on refresh and on every SSE update. The shell also never read
the hash on mount, so it defaulted to `projects[0].id` regardless of the URL — meaning **a refresh
on a specific project sent task events to the wrong session.**

**Process lesson, and it cost a wrong conclusion: never claim "pre-existing" without verifying
against main properly.** The claim was that 18 failures predated the change. The verification used
`git stash` — **which does not revert already-committed work**; `git reset --hard HEAD^` was needed.
And even correctly reverted, the baseline must be a bare full `bun test`, not `bun test web/`.

## Pending messages are a projection of the event log

**Four successive fixes tried to patch a mutable `deferredMessages` map by changing *when* mutations
happen — and each closed one race and left the model in place. The mutable state was the bug**
(`01KY2TRYPWP408Y3FGX029YBK6`). **Four fixes that each close one race is the diagnosis, not the
history: if every fix is about WHEN a mutation happens, the thing to remove is the mutation, not to
find the correct moment for it.**

`pendingReducer(state, action)` is a pure module-level function: a `message` event with an id and a
non-compact source appends, a `messages_consumed` removes by id set, **every other event is a
no-op.** Pending is a pure function of the event log; **there is no imperative clear path**;
compact-source messages never enter pending, filtered at APPLY; and `tree_updated` does NOT touch
pending, because **a task's lifecycle status "pending" and a message's state "pending" are different
concepts that happen to share a word.**

**Unconsumed messages stay pending forever, and that is correct**, per the user: if the agent never
processed a message the UI should keep surfacing it. Silently clearing on compact was lying.

**One thing outside the reducer affects pending.** The driver suppresses an APPLY for a message id
it already saw consumed in the same batch, because a RESET-plus-replay correctly empties pending and
then SSE catch-up events arriving *after* the batch can re-deliver a `message` whose consumption was
already in it. The guard lives in the driver; the reducer stays pure. **Diagnosis worth keeping: all
22 "unconsumed" messages in the JSONL were compact-source and correctly excluded, and zero user
messages were unconsumed — the backend was right and the bug was purely frontend timing.**

**The phase-discipline lesson from the last of the four patches, which outlived its own code:** when
several event types mutate one structure, **they must all mutate in the same phase.** Three did it
synchronously inside `processEvent`; `compact_marker` did it inside a deferred side-effect closure.
In single-event mode there is no loop between the two, so both look equivalent; in batch mode the
gap yawns open and a deferred clear wipes messages that arrived *after* the compact. **Search any
`sideEffects:` closure for non-React-state mutations — that is the smoke.**

## Partial events are monotonic snapshots

`assistant_text` and `thinking` can arrive with `partial: true` — synthetic events injected by the
events endpoint, never persisted, so a mid-stream refresh does not lose what has streamed so far.

> **A partial event is a snapshot of content that only grows. Clients extend to the longer of
> {current state, snapshot} and never shrink.**

That is why the ops are `extend_*` rather than `replace_*`. On reconnect the frontend does BOTH an
SSE resume and a REST refetch, and the two deliver with opposite semantics — SSE deltas append, a
REST snapshot clobbers — so without extend you get either data loss or duplication. **Final
(non-partial) events still use `replace_*`** — they are authoritative rather than snapshots.
**Thinking specifically must extend rather than replace even though replace looks equivalent**: a
partial thinking event has an empty `signature`, and Anthropic needs that signature for prefix
byte-identity on restart.

**Now name what those two deliveries ARE, because `extend_*` is a CONSEQUENCE and not the point: the
frontend still runs an incremental path and a wholesale-rebuild path at the same time, so it has the
duplicate-codepath disease the backend was cured of.** The incremental half was built deliberately
and at length — epoch-prefixed SSE ids, a ring buffer, `Last-Event-ID` catch-up, an entire task —
*specifically so that a gap could be filled without rebuilding*; and after it shipped every
reconnect went on rebuilding anyway. What has grown on the seam is defensive apparatus: `extend_*`
is one guard, the pending driver's suppression is a second, and the remount that loses the reader's
scroll position is the bill for the rebuild itself. **The standing proposal is to delete one of
them: the log should be a fold over an append-only stream. Draft `01KYCPCFXF1QXVB3ESE40BAW58`, filed
off the user's own reading — "it has no reason to refresh, it should just be append".**

## `queueEntryToUIEvent` is THE UI materialization gate

**Every `QueueMessage.source` that should be visible in the activity log MUST have a case here.** A
missing case falls through to `default: null` and **the event class is silently dropped — no error,
no warning, nothing in the DOM.** That is exactly what happened to post-compaction summaries: the
message existed in JSONL and went through the full two-phase lifecycle, and the UI showed nothing.
Adding a new source means three places, in order: the union member, the producer path, and this
switch. **Forget the third and the JSONL is perfect while the UI is empty.**

## Project switch: remount, do not reset

`<PluginUI key={`${projectId}/${selectedScope}`}>`. This replaced a 25-line effect that watched a
`prevProjectId` ref and manually cleared **fourteen** pieces of state. **"Detect that prop X changed
and manually clear N pieces of local state" is a consistent smell, and the manual version cannot be
kept correct** — every new `useState` added anywhere in the subtree has to be added to the reset
list. `key={X}` resets everything, **including state that does not exist yet.**

Two that stay silent: **events are fetched per-session, not per-project**, because a forked session
contains its parent's events and merging by project produces stale content; and **the per-task draft
debounce reads `targetRef.current`, not `targetNodeId` from the deps array**, because with the value
in deps a render transition saves the previous task's prompt under the new task's key.

## The activity log's scroll position: guard the property, not the list of causes

Two user sentences define this whole subsystem:

> **"If the AI is still producing output, I only have to scroll down once and I'm locked into follow
> mode — I can't read at my own pace."**
>
> **"Load-earlier should work like a chat app's infinite scroll upward: reveal more above me and
> LEAVE ME WHERE I AM. I wanted a bit more context and got thrown to the very top."**

So: follow mode is armed by the user, never by the browser; and revealing history must not move the
reader. Both were broken by the same underlying thing — **the log is the whole session's array,
replaced wholesale on every refetch.**

A survey of everything that reads, writes or invalidates the scroll offset found **30 touch points,
not the 9 anyone could name** — including the browser itself, via `overflow-anchor`. The user asked
for the whole map instead of the two reported symptoms (`01KYBN3AG5PD2H1K09HS9XA39E`), on an
argument worth reusing: **nine mechanisms were already writing that one number and were already
known to fight each other, so fixing any single symptom without the map is adding a tenth.**

**The predicate that works is `scrollRangeShrank(prev, current)`, where range = `scrollHeight −
clientHeight`.** Two predicates were proposed on the *cause* side and one measurement killed both:
"is the rendered content from the task being viewed" and "is the container non-scrollable" both miss
an in-log search that leaves 449px of range — fully scrollable — where a `scrollTop` of 1200 is
clamped to 449, which IS the new bottom, so the near-bottom test returns true and follow mode arms
itself.

> **This generalises and a cause-list does not.** The survey started from "your nine are almost
> certainly incomplete" and ended at 30. `scrollRangeShrank` tests **the property that makes an
> observation meaningless**, so it covers causes nobody wrote down. The composer auto-growing is the
> proof: not a view parameter, not anticipated, and it lands in the predicate for free.

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

**`prevScrollRangeRef` may ONLY be advanced by the scroll handler, and the danger is that the wrong
version looks MORE thorough.** Letting a geometry-reading effect update it too makes the guard
inert: effects run at commit, the clamp's scroll event is dispatched by the browser *afterwards*
(measured 14ms later), so the effect writes the new small value first and the comparison becomes
new-vs-new. Relatedly, **"only trust real user scrolls" is unimplementable** — a clamp-dispatched
scroll event has `isTrusted === true`.

**The culprit was not in the scroll code at all.** Symptom: *"from mid-output to output complete, my
scroll gets yanked to somewhere above"*, only visible with follow OFF. The chain: the viewed agent
goes idle → a refetch replaces every entry object → new entry ids → new React keys → **the whole
subtree unmounts and remounts**, and the offset does not survive the swap. Measured from inside the
DOM mutation: `added: 82, removed: 82` in one batch against `removed: 1` for a normal update. **Fix
the keys** — deriving `LogEntry.id` from the eid is that fix.

**The per-frame probe watching all this reported `range UNCHANGED → not a clamp`, and was wrong**:
the range collapsed and refilled **inside one frame**, and between the two DOM mutations there are
**267ms containing ZERO samples where ~16 were due at 60fps**, because the main thread was blocked
rebuilding 82 entries. **"No dip in the samples" is not "no dip."** The bias is systematic rather
than an edge case — **the operations that cause large displacement are exactly the operations that
block the main thread long enough to hide themselves** — so any instrument here needs an observation
that survives a blocked thread: a count taken either side of the render, or a mutation record, never
a sample taken during it. **And the counterpart: stop collecting once the answer cannot change the
action.** Exactly where in those 267ms the offset died does not alter the fix.

> **In a subsystem with a mechanism that keeps forcing one endpoint, that mechanism is masking every
> other bug that moves the same value.** With follow ON, every displacement was overwritten by the
> same endpoint and none produced a distinguishable symptom. Each masker you fix surfaces a symptom
> that has always been there; the user reports it as new and it is not a regression, it is *newly
> visible*. This explains a whole class of "I hit this often but cannot say when" reports, and it
> means a subsystem's bug count can appear to grow while it is genuinely getting better.

**Two deletions here, and neither was about the feature.** Per-tab scroll memory **never
functioned**: the save ran in a passive effect keyed on the task id, which runs *after* commit — by
which time the list had emptied and `scrollTop` was clamped to 0, so it saved a destroyed value,
structurally. It was invisible because the follow-hijack it fed put you at the bottom anyway.
**Deleting an implementation that never had an effect is not deciding the feature should not exist —
it is removing a lie.**

**Reusable method: attribution beats reasoning.** One reproduction with a probe tagging every
programmatic write with who did it turned "something moved me and I don't know what" into two line
numbers, where the previous round needed a 30-touch-point survey to reach a *worse* answer. And
**diagnose by absence**: browser scroll anchoring goes through no JS path and fires no event, so
"the offset moved and nobody wrote it" is itself the diagnosis.

## Rewind and Edit: report what the rollback does NOT undo

`analyzeRollbackImpact` scans from the target entry to the end of the log, **skipping entries from
other tasks** (rollback is per-session, so a sibling agent's bash must not be reported), and counts
file / task / message side effects plus a generic bucket. An unknown target yields an empty impact,
so the dialog claims nothing rather than guessing.

**The read-only list is a WHITELIST, and that is the load-bearing choice.** `read_file`,
`list_files`, `search`, `get_tree`, `get_task`, `background`, `yield` and friends are named safe;
**anything not whitelisted and not categorised sets the generic warning.** Unknown tools — external
MCP servers, `evaluate_script` — are never assumed safe. **`done` is NOT read-only, and the first
cut whitelisted it**: a range crossing a `done()` then rendered the green "nothing outside the
conversation changes" box, which is a lie, because `done()` flips the task's status AND delivers
`task_complete` to the task above, which may already have woken, reviewed and merged. `done` now
lives in both the task and message sets, which forced the classification loop from a first-match
`else if` chain to **independent membership checks**.

**Edit confirms at the moment the pencil is clicked, not at submit.** The warning's value is "before
you decide to edit", and intercepting the submit would need draft restore on cancel.

**There is ONE "jump to bottom" mechanism, and it is a monotonic counter rather than
`setAutoScroll(true)`.** The follow effect only fires when `visible.length` or `autoScroll` CHANGES,
so rewinding while already at the bottom with an unchanged entry count changes neither and **nothing
scrolls** — which is exactly why the "jumps to the top" symptom was reported as intermittent. And a
smooth `scrollIntoView` loses to follow mode: `setAutoScroll(false)` first, then an INSTANT scroll.

## Markdown rendering in agent replies

A hand-written parser for a lightweight subset — no markdown library, no `dangerouslySetInnerHTML`,
React elements only. **Strict grammar throughout, because a false positive is worse than a missing
feature**: that one sentence generates every rule, and the grammar's own tests state them better
than prose can. Two things the tests do not say:

- **Link safety is one gate in the parser, and it is the only security-relevant line in it.** Only
  `^https?://` becomes an anchor; `javascript:`, `data:`, `file:` and relative URLs render as
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
scrollHeight`. Reading `scrollHeight` before the new height applies gives a stale value, and **do
NOT rely on the separate resize effect having run first**, because React 18 flushes passive effects
asynchronously and rAF-versus-passive ordering is not guaranteed.

**Global image drag-drop. RED LINE: never intercept internal HTML5 drags** — task-tree and tab
reorder set `dataTransfer` `text/plain`, so every global handler gates on `types.includes("Files")`.
**The visual and functional halves are on different phases, and both choices are load-bearing.**
Functional is on BUBBLE, because the composer's own drop handler calls `stopPropagation`; visual (a
`dragenter`/`dragleave` depth counter) is on CAPTURE, so it cannot be desynced by that same
`stopPropagation` — no stuck overlay, and no timer or flicker heuristic needed.

**Sidebar filter toggle**: open state lived in the parent and query state in the child, and an
`onBlur` auto-closed when empty — so clicking the toggle while focused and empty fired blur on
**mousedown** (closing it) before the button's **click** (which read `false` and flipped it back).
Fixed by one reducer over `{open, query}` with the invariant **closed ⟹ query === ""**, and by
removing `onBlur`. If the auto-close is ever wanted back, use a document-level outside-click
listener — **not** `input.onBlur`, which re-introduces the race.

**The composer's image hint is the placeholder, and its condition is `!prompt`, NOT `!prompt.trim()`
— the trimmed version is the one that looks correct**, since every other gate in that component
trims. A placeholder is hidden by ANY content, whitespace included, so trimming sets a hint the
browser never paints. **Borrowing a slot that already has a job means you owe it back** — one
keystroke must restore `Message to "…"`.

## Settings and stops

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
button and `/stop` was a third door, both calling teardown. All of them said "stop". **When a
replacement lands, go back and look at what it replaced** — neither leftover ever went red, because
the older affordance keeps working, which is exactly why nobody looks at it. **Here the runtime had
deliberately separated the two verbs and the UI went on offering both, handing the user the very
confusion the architecture exists to prevent.** Do not "keep the escape hatch" by demoting the
second control to a slash command — that is still two stops with the second one harder to find.

> **Frontend code lives in TWO directories and is consumed from THREE.** `web/` is the shell,
> `.mxd/plugin/web/` is the plugin UI — and `src/` imports plugin web modules too (in tests). **A
> grep scoped "to the frontend" therefore misses a real edge**, silently, in the direction that says
> "nothing points here". Scope the grep to the repo, and let the compiler be the second opinion, not
> the first.

---
# Testing
---

## Three layers: intention → tests → architecture

Tests are the single source of truth, and each layer can be challenged by the layer above but never
captured by the layer below. **The reason is the project's founding one: an AI can hallucinate code
but not a test result.** Three mutations guard the layers: is this behaviour what users actually
want (intention); do the tests catch code changes (test); can the code evolve (architecture). Work
bottom-up — write tests, then find the simplest architecture that passes them.

## Integration tests are mandatory when a promise crosses a layer

**Use an integration test — full agent loop, `ValidatingMockAPI`, observe what the mock receives —
whenever a prompt, tool description or user-facing string promises a specific SHAPE; whenever a
change affects what the LLM sees; whenever the behaviour crosses the agent-loop / tool-execution /
JSONL boundary.** A unit test proves a formatter returns X. **It does not prove the LLM observes X
through MCP wrapping plus tool_result persistence plus the mock-reply path**, and the gap between
those two is where prompt/code drift silently lives.

**The canonical user journey test is MANDATORY.** If the feature's name describes a user action,
there **must** be a test that performs that exact action and asserts the user-observable result.
**The canonical path IS the feature; everything else is scaffolding.** Diagnostic: open your test
file — is there a test whose whole shape is "do user-action X, observe X works for the user"?

Four ways this fails silently, all observed: **test config ≠ production config** (the test calls
`createDaemon` directly while production goes through `import.meta.main` with different flags);
**subcomponents tested individually, never the chain**; **partial-chain assertion** ("marker
written" while the GET response, the UI reading the flag and the backend guard are all unverified);
and **mocks matching the test rather than reality** (an in-process no-op `onBroadcast` where
production goes through postMessage). **Minimum bar: cross the real process boundary, and run the
journey by hand before `done("passed")`. "2003 tests pass" is not a merge gate. "I ran the feature
the way a user would and it worked" is.**

## Every `throw` in a test double must quote the real error it mirrors

**When a fake rejects something on the grounds that the real system would, the rejection message
must carry the real system's own error string. If you cannot quote it, you have not verified it, and
it does not belong in a predicate named after the real system.**

This rule exists because **it moves the failure to the moment of WRITING.** The claim that cost four
production mechanisms propagated as a parenthesis in a bug report — *"Error from ValidatingMockAPI
(matches real Anthropic)"* — which nobody ever checked. Under this rule the author goes looking for
the API's wording, finds none, and stops there. **A rule is worth what its failure mode is worth,
not what it says.**

Three corollaries. **Separate OUR expectations from THEIR rules, by name** — a check we want but the
API does not enforce is fine, it just may not live inside something called `validateRequest`,
because **a style rule hidden inside an API-validity predicate gets cited later as API behaviour.**
**A fake that is STRICTER than the real system is not "safe"**: it manufactures phantom bugs, and
phantom bugs get fixed with real complexity. And **fix the double BEFORE the code it guards, and
treat that ordering as the point** — right after `ValidatingMockAPI` was made faithful, the next
commit extracted a `yield`-ing block into a generator and omitted `yield*` at both call sites: legal
TS, zero diagnostics, the whole effect silently gone. **8 tests caught it, all via the rule that had
just been added.** The reason to fix the double first is not tidiness — it is that you are about to
be the one it catches.

**A test double standing in for an endpoint has to be able to REFUSE.** `ValidatingMockAPI` serves
the measured production catalogue — 11 real ids with their real `max_input_tokens` — and a test may
replace it, including with `[]`. Answering whatever model it is asked about would put a deleted
default back inside the harness, where nothing could ever go red.

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
output bytes. See *Delete until ONE remains* for why unifying two paths shifts which of these can
establish what.

**Golden-snapshot gotcha**: a user `message` event carrying an `id` is DEFERRED by the walker and
materializes only via `messages_consumed`. Without the consumption event it never renders, and your
fixture is silently testing nothing.

**When you replace an implementation but not its contract, a differential probe beats a green
suite.** ~40 lines running the OLD path and the NEW one over 21 real cases, asserting
**byte-identical output including order**, found nothing — which is the point: it states "behaviour
is unchanged" as a measurement over whole outputs, where a green suite can only state "the cases
someone thought to write still pass".

## Mutation testing: what to keep, and the shapes it misses

**Keep every mutation that surprised you; cut every mutation that confirmed what you expected.** The
confirming ones are verification records and belong in a commit message. The tell is the sentence
next to the table: *"I expected this to fail and it did not, because…"*

**Guards need a two-sided mutation proof.** Everyone mutates the over-loose direction (delete the
guard). Almost nobody mutates the over-strict one — **and over-strict is the typical way a guard
fails**, because it reddens nothing and just silently stops a normal path working. Making a
follow-mode effect never scroll, i.e. killing the entire feature, left **11 of 12 tests in that file
green**, including four guard tests written the day before.

Four shapes mutation testing cannot see, each with a different cause. **A transition point that was
never written**: a missing `setActivity` survived a full clean sweep, because nothing existed to
remove; it was caught by reading the comment that argued for its absence. **When a comment argues
why some code is unnecessary, that argument is the thing to check; the tests around it are all
consistent with it by construction.** The other three are the fixture failures in *A fixture that
cannot express the difference* and **two implementations of the same guarantee covering for each
other** — the tell is a mutation surviving that obviously should not have: `walkFiles` sorted its
output and then the caller sorted the same array again, so deleting the sort inside the walk failed
no test at all. **Deleting the redundant one is what made the survivor testable.**

**`SURVIVED` is the comfortable answer, so it is the one to distrust.** A harness must refuse to
print a verdict unless the file text actually changed AND bun printed a summary line. **`git
checkout -- <file>` reverts to the last COMMIT, so it eats an uncommitted fix in the same file —
including the fix you are mutating.** The tell is an "after revert" run showing the same failure
count as the mutated run. **Commit before mutating.**

## Fixtures and harness traps

**A fixture with unstable identity silently loses its resolution.** If it regenerates entry ids on
every render, every rerender is a full key change, the subtree remounts, and — with follow mode on —
*the remount itself* scrolls to the bottom. The test does not go red; **it stops being able to see
whether the code under test scrolled.** Build the master array once and slice it, which is also what
production does. **Whenever a test asserts something about an effect, check that the fixture is not
producing that effect itself.**

**An unfaithful double does not only make tests lie — it makes the missing test unthinkable.**
"Interrupt an agent mid-generation" had never been executed by any test, and not because anyone
skipped it: the mock stream ignored the request's AbortSignal outright, so every test that aborted
mid-stream passed through a road that was open and led to the OPPOSITE of production. **Nobody
writes "assert the abort actually aborts" when the harness cannot express the difference.**
Relatedly, `activity === "thinking"` does NOT mean a request is in flight — a session is BORN
thinking, so a test that waits for `thinking` and then interrupts can land before the first API call
exists. Key on `getRequestHistory().length >= 1`.

**A negative assertion is only worth the WAIT in front of it — and deleting a redundant channel can
silently remove that wait.** Two guard tests awaited a report from a *redundant* channel and then
asserted `expect(calls).toEqual([])`, so deleting the duplicate deleted the await and the negative
assertion now runs before anything COULD have been reported. **It passes on a component that reports
nothing at all — nothing goes red, in the same commit that "only removed a duplicate".** The fix is
a positive control inside the same test. **Same rule with the ENVIRONMENT supplying the dead
wiring**: "Enter with an image and no text does not send" **passed on code that had no guard at
all**, because under happy-dom Enter never reached the handler.

**A test that RUNS an agent declares its model** — `createApp({…, initialConfig: TEST_CONFIG})`.
Which model an integration test runs decides its context window and therefore its compaction
thresholds, so naming it at the call site is the point rather than boilerplate. **The suite once ran
a configuration no install can have**: `model: ""` travelled config resolution → provider
construction → `agent_start` (into the durable log) → the request with nothing objecting, and
`getContextWindow("")` answered 200_000 — a window for a model that does not exist. **The suite was
green throughout and was never evidence about a real install**; deleting the guess turned 333 tests
red across 21 files, and the one file that had always named its model was the one file that stayed
green.

**Two happy-dom gaps that do not announce themselves**, unlike the rest, which cost thirty minutes
and tell you so. **It silently drops MutationObserver callbacks under GC pressure** — the listener
holds its callback in a `WeakRef` with no strong reference anywhere, so after any GC pass mutations
are delivered to nothing, with no error; **a test relying on MO delivery passes in isolation and
flakes inside the full suite**, which is then chased as a scheduling flake. And **do NOT spy on
`history.pushState`/`replaceState`**: instrumenting them in `beforeEach` survives
`GlobalRegistrator.unregister()` in ways nobody could diagnose, and **poisoned every subsequent
`web/*.test.tsx` file with ~18 spurious failures** — a cost that lands entirely on whoever runs the
suite next.

**A constant-vector mock makes every hybrid-search assertion vacuous.** If the fake embedder returns
the same vector for every text, every document scores cosine 1.0 against every query and any
assertion about *which* documents matched passes silently. Return a text-derived vector.

**`expect(domNode).toBeNull()` prints the node with its whole React fiber graph on failure**, and
the second cost is worse than the first: one such assertion produced a 227MB log, and another
**mangled bun's `(fail)` line, so a harness scraping that line reported a mutation as SURVIVED** —
the instrument was fine and its INPUT was destroyed by an assertion elsewhere. Compare booleans in
DOM tests, and collect offending LINES rather than asserting on whole file text.

**Test-harness gotcha with real teeth**: `clearSessionState` drops log entries for a session
transitioning to `pending`, so a fixture seeded with `status: "pending"` **wipes its own log** the
moment the first `tree_updated` arrives. In happy-dom the SSE mock is a no-op so this never fires;
in a real browser the log renders "No events yet" while the events endpoint returns data. **Seed
live-smoke fixtures with `verify`** — a task that owns a session is never `pending` in reality.

**Live smoke recipe, reusable**: temp dataDir + `projects.json` + `tree.json` + hand-written JSONL
with an explicit eid/parentEid chain (so nothing auto-migrates), `createTestToken`, `createDaemon`,
`Bun.serve`, then `localStorage.setItem("mxd-jwt", token)` in the browser. **A user message needs
BOTH a `message` event carrying `id` and `eid` AND a `messages_consumed`** to materialize with its
eid, and without it the Edit/Rewind buttons never appear.

## `bunfig.toml`'s preload is load-bearing; do not remove it

It does one thing: `import "react-dom/client"` once per process, before any test file. react-dom is
a process-wide singleton and its scheduler binds to whatever timer machinery exists at **first
import**. If that first import happens inside a registered happy-dom environment, the scheduler
binds that window's machinery — and when that file's `afterAll` unregisters, **scheduled render work
stops flushing for every subsequent test file in the process**.

**`bun test`'s file order is filesystem-dependent — not alphabetical, not mtime — so this is a
latent landmine that any file addition can re-roll.** The baseline was green only because a benign
file happened to run first; adding four web test files reshuffled the order and produced 52 failures
across 11 files. **Do not remove the preload "because tests pass without it locally".** Red herrings
eliminated by probe, so nobody re-investigates: matchMedia mocks, happy-dom register options and
`IS_REACT_ACT_ENVIRONMENT` are all innocent. And one bisect trap: a mangled probe file whose
`beforeAll` THROWS never registers happy-dom, so the paired victim file runs clean and it looks like
the mutation fixed the problem. **Validate that a probe passes on its own before trusting a bisect
step.**

## A flake that usually passes gets filed as weather

**The common cause of every flake here is one sentence: the load profile changed and nothing
announced it.** Timeouts and "pick a probably-free port" were both tuned against a single suite on
an idle machine; four suites in parallel is now the normal way this project runs. So these are not
tests that are occasionally unlucky — they are tests carrying an assumption that is now
systematically false.

**Do not simply raise the timeout.** It is the cheapest fix and wrong twice: it lowers the test's
power to catch a real regression, and the next load change re-flakes it. Classify first, because the
three classes share no remedy. **The test should not depend on load at all** — `P2.8` wants to
verify error CLASSIFICATION, so it should test the classifier instead of standing up a real daemon
on a port it guessed was free. **The test genuinely is testing timing** — `Restart B` relies on
shutdown leaving a foreground-tool orphan for `autoResume` to repair, and that window IS the
behaviour under test; this kind cannot be abstracted away, but ask whether it needs WALL CLOCK or
only event ORDER. **Or it is not on the test side at all** — perhaps the suite serializes certain
groups when it detects concurrency.

**Fix the MECHANISM, never the test name.** Written up by instance this reads as three flaky tests;
measured, two runs of one unchanged tree failed two DIFFERENT ones, so the victim set is not those
three — it is *any timing-sensitive restart test*, and patching names is whack-a-mole the fourth
test wins. The three mechanisms really are distinct: TIMING, PORT COLLISION, and a genuine RACE
(`tracker.save()` renaming into a dataDir that `afterEach` has already deleted, while an agent the
test itself auto-launched is still writing).

**Triage in this order, and it is worth more than any of the numbers.** Is the failure a TIMEOUT or
an ASSERTION — only a timeout comes down this road. Run that one file alone three times: low
variance and all green means load rather than your diff. Then compare the two full runs' total time
**and the number of tests COLLECTED** — equal collection with a longer run is pure load, a much
harder claim than duration alone, though collection itself jitters (3212 vs 3213 observed). **The
~290s total-run probe is a DIRECTION, not a classifier**: it sees "the whole machine is slowing" and
is blind to "this test always had a race", which surfaced on a 272s run. The numbers behind the
threshold, which are what make it usable: the failing run measured **300.8s against 267-269s** on
three passing runs of identical code, and later samples put failing runs at 313 / 324 / 327s against
green runs at 278 / 280 / 283 / 286s.

**Check whether you caused it yourself.** An agent can manufacture this flake by starting a second
background `bun test` overlapping the first; two recorded data points are exactly that.

**The cost is not the 4.5 minutes of re-run.** A flake that usually passes gets filed as weather
rather than as signal — `P2.8` was hit by two agents on two days and classified as weather both
times, with the mechanism one step away from the error message. And it makes a correct
mutation-testing result **uninterpretable**: once `1 fail` is something a human has to adjudicate,
`0 fail` stops being a gate anybody can trust automatically.

**One measured constraint on any fix, because it contradicts the obvious framing.** The slowdown is
NOT uniform inside a failing test: the segment before the wait ran at isolation speed (~3187ms under
load against ≤3224ms isolated), and only the phase waiting on three children to reach `done()`
stalled. Standing hypothesis, flagged as a hypothesis: that phase is the only one spawning REAL git
subprocesses — the stress harness does a real `git init` and activates `setup_worktree.sh` as a live
hook, and git is disk- and `index.lock`-bound, hence serial. To confirm it, measure `git worktree
add` itself under load.

---
# Gates, Build and Housekeeping
---

## What is actually gated

Answer this before assuming a green result means anything.

| path | hook git looks for | gated? |
|---|---|---|
| direct `git commit` on main (memory curation, conflict resolution) | `pre-commit` | yes |
| `git merge --no-ff <branch>` with a clean auto-commit | `pre-merge-commit` | **no — that file does not exist** |
| a merge that CONFLICTS, then `git commit` after resolving | `pre-commit` | yes |
| any commit inside a sub-task worktree | `prepare-commit-msg` only | no GATE, by design |

**The clean merge — root's dominant path — is NOT gated, while the conflicting merge IS.** That is
backwards from intuition, and it is why "the hook passed" says very little about an integration.
Deliberately not fixed by adding `pre-merge-commit`: the branch model REQUIRES that intermediate
merges be allowed to not typecheck, and gating every merge would re-establish the routine
`--no-verify` habit that hid 24 errors before. To check the gate from a worktree, run `bash
/path/to/main/.hooks/pre-commit` by hand.

**`core.hooksPath` is LOCAL config and is not tracked, so a fresh clone is ungated again and looks
identical to a gated one.**

> **A checked-in hook file is not an enforced hook.** For a long time `.hooks/pre-commit` existed,
> was referenced as if active, and nothing pointed at it — git was looking in `.git/hooks/`, which
> held only `.sample` files. **Nobody was gated anywhere**, every `--no-verify` was a no-op against
> a gate that did not exist, and **the absence looked exactly like compliance.**

**The smoke set the hook runs is chosen, not accumulated**, on two criteria: the round-trip proofs
for checks the hook itself runs (because a hook that runs a gate but not the gate's own test can
print that gate's "passed" while the gate is dead), and invariants that fail SILENTLY — which here
means the persistence layer, since the daemon shell, project registry, task tree and worktrees all
fail loudly.

## A passing gate looks identical whether it read 8% or 100%

**Every gate in this repo has now been caught claiming more than it read, and they failed along
three INDEPENDENT axes. Fixing one axis leaves the others silently intact, and the output looks
identical either way.**

| gate | axis | the claim | what it checked |
|---|---|---|---|
| `check-i18n.sh` | SCOPE | bare strings in JSX | 4 of 31 files — **927 of 11,534 lines (8%)** |
| `check-i18n.sh` | DEPTH | bare strings | 1 syntactic form of 4 — **1 of 6** in one component |
| `data-paths.test.ts` | PATTERN | only one file builds paths from `dataRoot` | the 16 literal characters `dataRoot.slice(2)` |
| `.hooks/pre-commit` | SCOPE | `All checks passed.` | **4 of 141** test files, while NAMING five |

**"Scope" is only one dimension an addition list can hide in — PATTERN is another, and it hides
better**, because a widened scope makes a narrow pattern look thoroughly exercised. Round trip:
**the old regex caught 1 of 8 planted spellings; the new audit catches 8 of 8 and names the file.**
Two limits stated rather than left to be discovered: a direct rebind gets its own check, and a value
laundered through a function return is out of reach of any grep.

**An unqualified pass is worse than a narrow scope**, so the i18n pass message carries the file
count, and **scanning 0 files is a failure, not a pass**. **The count must be COMPUTED, never
written down** — a literal `5 of 140` is indistinguishable from a true one on the day it stops being
true, and it is the drained rot sitting inside the very sentence whose job is to describe scope.
Every axis gets the same treatment: the i18n gate prints its FORM count beside its file count.

**When a check is known dead, "the suite passes" is not evidence the fix worked** — the suite passed
while it was dead. The evidence is the round trip: plant, re-verify dead against the old audit, then
plant → **1 test red naming the offending file**, then plant removed → green. **A test whose value
is entirely in the day it fires must be made to fire on purpose at least once.**

**The widened heuristic has a RECALL GAP that is stated on purpose, because an unwritten one is the
next depth defect.** Precision came from one rule — *a user-visible string starts with a capital OR
contains a space* — which took the noisiest form from 32% real hits to ~100%. The price is that **a
single lowercase word with no space is NOT reported**, so `alt="attached"` is a real bare string
this gate cannot see, and **baseline 0 will not mean zero bare strings.** The trade is worth taking
because **a gate with a bad hit rate teaches people to skim past it** — but a recall gap nobody
wrote down is one commit from becoming exactly the defect this gate was just fixed for.

**A partial-hit gate plus a fix-only-what-it-flagged policy produces incoherent output.** A
heuristic is partial by construction: when the i18n gate was single-line it flagged 1 of a
component's 6 user-visible strings, and fixing that one leaves a component half translated and half
English — **worse than untouched, and it looks *handled*.** **The unit of repair is the coherent
unit, not the flagged line.**

**When a widened gate surfaces a real backlog, RATCHET — and make the baseline write itself down.**
The widening found 26 pre-existing bare strings, so two things were true at once: the gate is
correct and the repo cannot pass it. **A gate nobody can pass stops being evidence about anything**
— it just gets `--no-verify`'d, which leaves no trace. So a baseline file carries the measured debt,
the gate fails on any RISE, and **rewrites the file downward on any FALL**. The rewrite is the
load-bearing half: a baseline only a human remembers to lower is a number that quietly stops being
true, so fixing ten strings against a stale 26 lets ten new ones land unnoticed — **the drained rot,
reintroduced by the fix for it.** Known hole, accepted and recorded next to the baseline: it is ONE
count, so removing one string and adding another in the same commit nets to zero. **Do not let the
string cleanup swallow the gate fix** — count them, file them (`01KYDBRDAPF13M5X0E7PGQVB0X`), ship
the gate.

**NEGATIVE RESULTS from the census, so nobody re-runs it**: every `Bun.Glob` in the repo was
correct; file enumeration here is either a `Bun.Glob` or a flat read of a directory we own with its
filter written down; file-scope CLAIMS are made in exactly two places; and **there is no CI** — the
pre-commit hook is the only gate runner in this repo. **And branded types were believed to be the
one direction that escapes the enumeration frame entirely, and they do not**: probed with `tsc`
rather than reasoned about, `dr.slice(2)` and `dr.substring(2)` both compile clean on a branded
string, while a plain JSON-shaped manifest object fails TS2322 and so *does* break plugin authors.
Refuted at both ends.

**A source audit written in the same commit as its fix matches its own explanation.** The audit
greps for the expression you just deleted, and the fix leaves behind comments that QUOTE that
expression as the thing that was wrong — so the instrument fires on prose that exists *only because
the fix happened*. **Skip comment-opening lines.** Rewording the prose instead is the wrong repair:
it teaches the next person that the audit is the thing to bend.

**That has a twin pointing the other way, and neither is visible from inside the other. A repair
manufactures FALSE positives — and it also manufactures TRUE positives the instrument is never run
over again.** Measured on the same evening: a clause was rewritten to stop an ungrounded name from
being unreadable, and the replacement clause contained a SECOND ungrounded name, in the same
sentence, written by the same hand while thinking about grounding. It shipped as far as review. **A
repair is written by someone attending to the defect, which is exactly when another instance of it
reads as context rather than as the same bug.**

> **So the one instruction has two limbs: after a repair, re-run the check over the REPAIRED text.
> It will fire on prose your fix created, and it will catch the defect your fix introduced.** Only
> the first limb feels necessary at the time, and only the second one is silent.

## Type errors that were all casts, and the gate that never ran

Twenty-four `tsc` errors accumulated across six merges, and the shape of the fix is the transferable
part: **every one was a workaround for a type the code already had correctly — zero `as unknown as`
were added, and all 24 fixes DELETED a cast or a hack.** What the compiler will not tell you is that
**a cast failing with TS2352 means the type is MORE precise than you assumed, not less**, and that
`.filter(Boolean)` does not narrow, so `!` is never the fix.

**Why 24 errors accumulated is the more important half, and it is not "someone bypassed the gate":
there was no gate to bypass.** The errors accumulated in the open, and the absence looked exactly
like compliance. Relatedly, `check:ci` exits 0 with a standing pile of warnings, so **do not "fix"
the warning count during a gate restoration**: biome's suggested `!` → `?.` autofix is marked unsafe
and silently changes assertion semantics.

**A correct COUNT next to a truncated LIST reads as a complete enumeration.** Following that
compiler cascade, `tsc | tail -30` was paired with a `grep -c` over the same output reporting 24
errors, and **the number is what does the damage**: it felt like verification, a plan was built from
the visible tail, and **7 more sites appeared that had been in the head all along.** Without the
count the truncation is obvious; with it you believe you have enumerated.

**`git stash pop` does not restore the INDEX, so a commit can be a subset of what you staged.** A
cleanup staged 12 deletions, stashed and popped for an unrelated comparison, then `git add`-ed two
config files and committed: `stash pop` returns everything as **unstaged** unless you pass
`--index`, so the narrow `git add` was the whole index and the commit contained 2 files while its
message described 14. **What makes it a member of the gate family rather than a git tip: the hook
passed, and passing was CORRECT** — the deleted files were still on disk, so nothing was broken. **A
green gate is consistent with a commit that did the opposite of what it says**, and nothing in this
repo compares a commit's message against its diff. **After any commit whose message makes a claim
about scope, run `git show --stat` and confirm the file count.**

## Which probes get committed

Probes kept accumulating in `scripts/` with nothing written down about which belong there, so
"commit the probe" read as an unconditional convention. It is not one:

> **A committed probe is worth the space iff the thing it measures can change WITHOUT any test going
> red.** That is the whole question. Not how good the probe is, not how hard it was to write.

`probe-hidden-tool.ts` measures **an external system** — KEEP, it can change under us on any
Tuesday. `scan-partial-update-damage.ts` measures **accumulated history** — KEEP, no test can pin
the past, and it carries its own positive control. A probe of **our own code, already pinned by 20
tests** — CUT.

**The counter-intuitive half: being covered by tests is the reason to DELETE a probe, not to keep
it.** Where a probe and a test guard the same fact, the test wins unconditionally — *it runs
itself*, and the probe only works if a human remembers it exists. A probe that duplicates a test is
a second, weaker copy that will drift, and whose narration goes stale the moment the bug it
describes is fixed.

**And price the cost on the right side of the ledger.** That probe called `updateTaskOp` with
`dataPaths: null`, so a whole-repo SUBTRACT-list audit caught it, correctly. The reflex is to add an
exemption row and call the cost "one line". **It is not: the cost is an audit that no longer means
what it meant.** The first exemption is what teaches the next person that exemptions are available.
**Deleting the file deleted the exemption with it; an audit catching a new file is evidence the
audit works, never a formality to route around.**

## The build pipeline is content-addressed

Every asset carries its content hash in its filename and is served `immutable`; the HTML referencing
them is `no-cache`. So the browser always asks whether there is a new index and never asks whether
the hashed JS is fresh, and **stale content is impossible because stale URLs do not exist on disk.**

**Do not add `Cache-Control: no-store` anywhere as a fallback, and do not add a query-string cache
buster.** Both are the cargo-cult reflex this design replaced: `no-store` re-downloads the whole
shell on every reload, and query strings defeat CDN caching. **Either a URL is content-addressable
(immutable) or it is the index (no-cache).** **Never hardcode a logical asset URL** — only the
manifest knows the real hashed path, and the build throws if an entry is missing rather than
emitting a bare specifier that would 404 at runtime.

## Deleting code

**"Test-only" is not "dead", and conflating them turns a cleanup into a risky migration.** An audit
called `tool()` production-dead and asked for its removal. It IS test-only — and it has 23 call
sites, which makes it live test INFRASTRUCTURE; deleting it would have been a 23-site migration that
changes what those tests test rather than reclaiming anything. **The real violation was sitting next
to it** — two helpers existed verbatim in two files. **When an audit says "dead", check whether it
means "unreferenced" or "only referenced by tests"; the second is a different claim with a different
answer.**

**Deletion beats repair when a feature is duplicative AND the user wants it gone.** Project-wide
"Clear All Sessions" was deleted rather than fixed, because repairing it needed an architectural
decision about whether the shell may know plugin URL prefixes, and the feature had no unique use
case. **Do not confuse it with what was KEPT**: per-session `clear`, the sessions/prune endpoint,
the per-task "Clear Session" route, and the frontend's unrelated `clearSessionState`.

**Names that no longer exist, so you do not go looking**: `persistent-queue.ts`,
`openai-compatible-provider.ts` (the whole Chat Completions path), `hasPendingYield`,
`truncateAfterLine` / `readWithLineMap`, `combineSystemPrompt`, `resetAuthDataCache`,
`rollback_marker` / `appendRollback`, `await_background`, `RelocateBanner.tsx`,
`readFromLastCompactMarker`. **False positive to expect while checking**: a deleted function often
still appears in comments explaining its deletion, so a bare grep count is not the answer.

## When the runner itself is the bug, the summary is the last thing to trust

**If `bun test` ever dies mid-suite, read the EXIT CODE rather than the summary.** Bun 1.3.7-1.3.8
killed the whole test process with SIGTRAP on any Worker teardown, so the crashing file ran first
and `3 tests passed` was meaningless — every claim of a green suite from that era was worthless.
Fixed by upgrading, and what survives the fix is the method: **a minimal 7-line repro plus a version
matrix over isolated installs settled in minutes what days of test-level debugging could not.**
Reach for the version matrix as soon as a failure's shape does not depend on your code.

---
# Reference: Pitfalls and Open Design
---

## Known pitfalls

Only the ones that stay silent and are paid by someone else. Anything the compiler, biome or a
failing test tells you within a minute is deliberately not here.

- **A generator called without `yield*` is a SILENT NO-OP.** After extracting a `yield`-ing block
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
- **To READ another branch, use `git show <ref>:<path>` or `git grep <pat> <ref>` — never check it
  out.** Recovery from a stray checkout is `git checkout main` and costs nothing *if the tree was
  clean and nothing rebuilt in the window*; neither is guaranteed, and the daemon serves the web
  build out of the main worktree.

## Known bugs and open design

**Subtree message routing, and the principle the shipped half never states: RESTRICT LAUNCH, NOT
MESSAGING.** Messaging a *pending* task IS launching it — worktree, agent, the lot; messaging a
*running* task is only communication. So the permission question was never "who may talk to whom",
it is **"who may START something"**, and the thing being prevented has a name in the design:
隔空启动, reaching across the tree to boot a task that is none of your business. The agreed rule
(`01KN6QE6WV0SWX2CR21BFZF71W`) falls straight out of that reading — direct children may be messaged
AND launched, because you created them; any RUNNING agent in your own subtree at any depth may be
messaged only, because reaching a live grandchild is coordination while starting one is a remote
boot that belongs to its direct parent; any ancestor may be messaged only, because escalation is
always valid. Unrelated tasks, never. **The parent chain shipped and the subtree half did not.**

**That draft also carries a live defect nobody has fixed, and it belongs to the silent indefinite
hang class: agent→ancestor is the ONLY delivery direction in this system that cannot start its
target.** The `isUpward` branch of `send_message` delivers with `{ quiet: true }`, and `quiet` does
exactly one thing — skip auto-launch when the agent is not running. **The reachable path is NOT the
obvious one.** *"A parent can `done()` while its children run, so an ancestor may be stopped"* is
FALSE and has been since 2026-04-14: `createDoneTool`'s handler in `src/tools/prefab.ts` collects
descendants and refuses while any of them holds a session, and matrix's `done` IS that prefab. What
remains reachable is an ancestor whose session went away for a reason `done()` did not cause — **the
user pressed stop** (`stopTask` deliberately leaves `status` alone, so the node still reads
`in_progress`), a root that was never launched, or a node left un-resumed after a restart. So a sub
task calling `send_message(requestReply: true)` to such an ancestor gets its message persisted and
nothing else, then yields exactly as the prompt instructs, and waits forever with nothing anywhere
reporting it. **Three surfaces say three different things**: the tool description promises every
pending/closed target launches on receipt, `task_complete` on the normal Phase 2 path really does
launch the ancestor, and upward `send_message` does not. Commit `ecfff7ce` added `quiet`
deliberately and recorded the mechanism without the reason; a defensible position may exist — a
parent the user stopped should not be dragged back by its children — but `task_complete` already
violates it, so **at least two of the three have to move.** Deferred by the user: settle the policy
question first, then make all three agree.

**Tool search** — dynamic tool discovery instead of sending every tool, so a large MCP tool set
stops costing context on every request. Anthropic's server-side answer is `defer_loading: true` plus
a `tool_search` server tool that injects one on demand; the user prefers a client-side design. **The
reason for that preference is not in the record** — the draft `01KN8WP20GTS34D1D6WAQPKJBV` states
the server mechanism and the cross-provider gap and never says why we would rather own it, so
whoever picks this up is re-deciding rather than implementing.

## Writing this file

What earns a place is the blockquote at the top. **The regeneration procedure, the condensing
sieves, the acceptance probes and the taxonomy of how THIS FILE accumulates rot between
regenerations all live in `.mxd/memory-reorg.md`** — read them there, and put anything you learn
about how this file fails there too. Two copies of a procedure drift, for exactly the reason *The
live path has no construction logic of its own* gives about code.

**That is a different taxonomy from the prose-rot table in *Changed a behaviour?*, and the two are
not a duplicate to be merged.** This file's table is about **prose describing CODE** — docstrings,
tool descriptions, test names — and asks *when does it become wrong*. The reorg document's is about
**how a curated document decays while nobody is editing it**, and asks *is a correction written down
anywhere*. They share exactly one member, **Drained**, because a count going stale is the one
failure both subjects suffer; that overlap is one thing seen from two directions, not two copies of
one thing.

**Never `write_file` this file for an ordinary update.** Use `edit_file` (match the last lines,
extend) or `echo >> .mxd/memory.md`. Update it BEFORE calling `done()`, and commit it alongside the
code it describes. A full rewrite is a deliberate, user-authorized regeneration, not a way to
append.

**Searching THIS file: anything over ~60 characters needs a multiline search.** It is hard wrapped
near 100 columns and the wrap lands mid-phrase, so a single-line `grep` for a sentence you can see
with your own eyes returns **0**, and `git log -S"<long phrase>"` fails identically. **The damage is
the opposite of a missed match**: you conclude the file does not say a thing, and then write it a
second time — which is exactly what a regeneration exists to remove. Search a short fragment, or
collapse newlines first.

Two more facts about that hard wrap, both of which cost a cleanup pass. **A wrapped line must never
BEGIN with `>`, `|`, `#`, `-`, `=`, or a number followed by `.` or `)` AND A SPACE**: markdown reads
those as block markers before it ever sees the inline code span they were part of. The trailing
space is the whole rule and the reason a re-wrapper written without it ships a bug — a sentence
ending *"its message described 14."* put `14. ` at line start, which silently became an ordered-list
item that swallowed the next four lines and left the sentence with no object, while `1.58M.` and
`0.02s` in the same file are harmless. And **"100 columns" is not one measurement** — bytes, code
points and display columns all differ here, because the file carries Chinese in its decision quotes
and a CJK character is one code point occupying two columns. Wrap against code points and check the
result.

## Editing the system prompt

The system prompt is **universal** across every project that uses Matrix. Each project has its own
`memory.md`, and agents elsewhere see the shared prompt plus THEIR memory, never ours. So the prompt
gets principles, roles, tool semantics and craft; this file gets matrix-internal implementation,
architecture and pitfalls. The one matrix-internal detail the prompt is allowed to expose is the
path where pre-compaction events are preserved, because a compacted agent otherwise has no way to
read its own history.

**The craft lessons in THIS file cannot be relocated to the prompt, and the attempt is the proof.**
It looks correct — "universal lessons belong in the universal prompt" follows directly from the
split above — and it was executed far enough to measure: the movable part shrank from an estimated
**310 lines to 82**, because **each rule here is welded to the specific thing that happened, and the
weld is what makes it work.** A craft rule in the prompt with no evidence is a platitude every agent
reads past; the same rule sitting next to the afternoon it cost is an argument. The split still
holds for a genuine DUPLICATE, where the prompt states a principle and this file merely repeats it.
It fails here because there is no duplicate: the prompt has the principle and this file has the only
evidence for it. **Someone will propose the move again.**

**The prompt contradicts itself across sessions and nothing catches it.** This file has regions, so
putting a claim next to its refutation is a move you can actually perform; **a prompt is one linear
argument, and two sentences sixty lines apart are never brought together by anything.** It does not
present as a conflict either — both are individually true and well written, and they only cancel
when someone holds both at once, which is exactly what the linear form prevents. Observed in two
commits one session apart, same author — **and the round that INTRODUCED the contradiction had
substituted a targeted grep for the full read**, which is the mechanism rather than a detail: a grep
finds the line you are changing and can never surface the line sixty lines away that it cancels.
**So read the recent prompt DIFFS before editing, then re-read the whole thing.**

**Neither document uses attention markers.** Measured on `src/system-prompts.ts`: zero of them in
459 lines, against 86 `**bold**` and 39 all-caps, with its hardest rules carried by bold plus one
clause of why (*"**Never** `git checkout` to switch branches — it corrupts the worktree."*). This
file used to carry 306, and an agent that had just spent an hour in here would add one to the prompt
without ever deciding to. **The user removed them from this file too, which retires the import
hazard and leaves the underlying rule, which was always the better argument: a marker claims that a
line matters more than the lines around it without making the case, and emphasis has to be earned
per line.** Bold the assertion, and let the sentence say why it is one.

**The same split governs SENTENCES, and the test is instruction vs inference.** The user's edit is
the template: from *"it lists structure, not relevance, and it hides closed tasks by default, so it
reports an area full of finished work as empty and that report is indistinguishable from the
truth"*, the tail was cut and the facts kept. The tail is true, it is this file's own sentence, and
the reader infers it unaided. **Anything shaped like *"so this leads to…"*, *"which is the same
shape as…"* or *"measured, it was…"* is evidence: it belongs here, and in the prompt it is weight
without instruction.**

**Describing a successful piece of archaeology is not a dispatchable instruction. The former only
has to be TRUE; the latter also has to have a CALL behind it.** Three instances in one evening, in
three different subsystems: *"blame the line and you'll find the task"* (the id is on 102 of 1280
merges); *"carry the timestamp back to the task tree and ask what was being worked on then"*
(**there is no time predicate anywhere** — that is a person scanning 577 nodes by eye); and
*"send_message the task you found"* (a working agent can only reach ancestors in its parent chain
and DIRECT sub tasks). Every one was written by someone who had really done it, or watched it work.
**The check is one question and it is cheap: for every "you should X" you are about to write, name
the tool call X is. If you cannot, it is prose, not an instruction.**

**The mechanism that produces it: recounting your own success COMPRESSES parallel routes into one,
because in memory it was a single win.** The real work was two separate moves, *timestamp → grep the
JSONL* and *concepts → `search_tasks` the tree*; the recounting came out as one route with the tree
bolted onto the timestamp, and that sentence was then inherited into a prompt instruction. **The
person who did the work was not the person who wrote the unexecutable line, and neither could have
caught it alone.** Ask for the call, not for the story.

**A prompt line that names a tool inherits that tool's blind spots, and nothing ever goes red.**
*"Check `get_tree` for closed/pending/draft tasks in the same area"* was written 2026-04-17 and was
correct then; `search_tasks` did not exist until 2026-07-15, and `get_tree` hides closed tasks by
default without saying how many it dropped. **Six prompt sites asserted that past work is wealth and
the commit that introduced `search_tasks` wired ONE of them** — *N of M doors* in the medium where
no compiler, test or gate can notice. **When you add a capability, grep the PROSE that has been
promising it.**

**`get_tree` IS a poor tool, filed twice in April and still open**, and the answer was in the tree
the whole time: `01KN8CQRHE7CADWE8FJ0THN32Y` (it returns `tracker.allNodes()` to EVERY agent
regardless of position) and `01KNCQB6W2WWSRRB7VQ362PHFB` (which lists *returns ALL nodes*,
*hideCompleted is binary* and ***No search*** as bullets of ONE problem, and proposes `search_tasks`
in the same document — so `search_tasks` shipping implemented one quarter of that design).
**"Several PARTS of one design" and "several ENTRANCES to one rule" feel identical on site and have
OPPOSITE remedies.** Entrances ask you to COMPLETE — deploy the same rule at the door you missed,
mechanical because the decision was already made. Parts ask you to DECIDE — go read the design and
judge whether the unbuilt part is still the right thing to build, because it was never agreed, only
proposed. **The tell is cheap: for an entrance you can name the rule and point at where it already
runs. If you cannot, you are holding a proposal.**

**The failure is classification, not compliance, and the hardest instance proves it: the misfiled
question arrives DRESSED as a code question.** Asked where a known `update_task` defect stood,
root's first move was to grep `updateTaskOp` — while the task existed, was `pending`, and had been
created **by root itself 21 hours earlier**. **Reminders were present in triplicate and it still
happened**, so "remind harder" is refuted; what was missing was a way to tell the classes apart. The
tell that does it: **source cannot distinguish a defect that is known, filed and half-designed from
one nobody has ever noticed — byte-identical on disk.** And the grep was pure loss rather than a
partial win: it returned field order, which the task already contained alongside the incident, two
design routes and the acceptance criteria.

**So the prompt trigger is not another reminder — it names a state you can catch yourself in**:
*search when you think you have found something new*, hung on an observable, **the sentence you are
about to write** (*this is new / nobody has considered / I've found the cause*). Confidence and the
urge to check move in opposite directions, so it fires precisely where compliance-style reminders
cannot reach. Evidence, one evening, four for four — every "new" finding already existed, including
a "60KB per call" figure reported as fresh that had been measured three months earlier, and a
positional-cursor *defect* that was a deliberate design made when event count was the only
primitive. **In all four, searching stopped after ONE round and only continued because the user
pushed — and each further round found something more important than the last.** Hence *"one query is
not a search; stop when a round adds nothing, not when a round finally returns something."*

The scale of the gap, counted over one 110MB session log: of **14,453 tool calls**, `search` (files)
955, `read_file` 775, `bash` 4320, and `search_tasks` **42**. Pick the denominator deliberately,
because the three available ones differ by 6×: 23 file-searches per tree-search, 41 if `read_file`
counts as consulting the tree, 144 against everything that touches the working tree. **Counting it
needs `{"type":"tool_call","tool":"…"}` — the field is `tool`, not `name`.** A first pass grepping
`"name":"mcp__mxd__search_tasks"` returned **10** — a plausible small number that would have
"confirmed" the thesis while actually matching that string inside tool_result CONTENT. **The wrong
instrument answered in the believable direction, on the very claim it was asked about.**

**Writing advocacy for a thing is when you overclaim for it, and the overclaim lands as a
contradiction of a correction that already exists.** Drafting that section produced *"the tree is
never the thing that was wrong"* — false, and **precisely inverted**: the retrieval headers exist to
say a past measurement usually holds while a past *"so we decided not to"* may not. **The fix was to
delete the false sentence and add nothing** — the true version is already in the payload headers,
and restating it in the prompt would be the same paragraph in two places, free to drift. **Silence
where another surface already speaks is correct; an assertion in the opposite direction is not.**
