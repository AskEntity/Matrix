# Regenerating `memory.md`

**You do not need this to write an entry** — that is `memory.md` § *Writing this file*. You need it
when the append zone has grown to the point where related material can no longer be found together.

The procedure is two steps, and the second one is a single act rather than a sequence:

1. **Restore what the file has lost, from the task tree. This step may make the file LONGER.**
2. **Read the whole file in one read. Write a whole new version in one output, beside it.**

Everything below is either how to do those two things or how to check that they worked.

## Why the file needs this at all

Entries are appended, and append means every new fact lands as far as possible from the fact it
invalidates. Nobody is being careless: the agent writing an entry files it under its own subject,
which is correct, and it cannot know that a sentence in another region just became false. **The
correction is written where the CHANGE happened, never where the CLAIM lives.**

**Append distance is measured in the FILE, not in TIME.** The intuitive story is that a correction
lands far from its claim because months passed. Measured: two sections written **the same day by the
same author**, seventy lines apart, carried the same four-row table and the same conclusion. Nothing
about elapsed time explains that — appending puts the new entry at the end rather than next to its
sibling. So a duplicate hunt scoped to "the old regions" is scoped wrong.

Three kinds of rot accumulate, and no detector finds more than one of them:

| kind | is a correction written down anywhere? | what finds it |
|---|---|---|
| **Superseded** — a later change invalidated this | yes, but filed under the change, never under the claim | holding claim and correction in one head at one time |
| **Drained** — a count or a list quietly stopped being true | **no.** Nobody thinks they are correcting anything | checking against the source, item by item |
| **Destroyed by understanding** — a curator deleted it as redundant | the content was there until we removed it | being forced to enumerate what you dropped |

The drained kind has **no trigger at all**: a stale count and a fresh count look identical, so the
interval between deliberate passes is how long a wrong number survives.

**Symptoms are the retrieval key, and the third rot kind eats them.** `memory.md` is organised by
cause and queried by symptom — the reader arrives holding "the buttons are missing", not "the event
type was renamed". A symptom looks most redundant exactly when you have just understood its
mechanism, which is exactly when it is most needed. Keep the conditional form, *"if you break this
invariant you will see X"*, and cut the perfect tense, *"in July we had a bug where…"*, which is
addressed to nobody.

**Before applying any rule, ask whether the thing in front of you is a CLAIM or an INSTANCE.** Every
rule here targets what is presented as CURRENT STATE. An instance cannot rot — it records something
that was true at a moment, and that moment does not change. *"You see `2116 pass / 2 fail` and cannot
tell WHICH two"* is not a claim about the suite's size; the story is identical when the suite reaches
three thousand, and deleting the number leaves it with no shape. The same pattern presented as
state — *"the suite has 2116 tests"* — expires silently and is what the rule is for.

## Step 1 — Restore the understanding, from the task tree

**The WHYs were never lost. They are in the task tree**, in the description of the task that produced
each section, often in the user's own words. The loss happens at the moment the entry is written: the
author has just spent hours inside the mechanism, the mechanism is in front of them, and the
intention is one screen away in a task description they do not re-open.

So for each section: `search_tasks` for the task that produced it, `get_task` for its description and
its **result rounds** (conclusions live in the rounds), and `search_logs` when you need what the user
actually said, because a description is already a retelling of the decision and a result round is a
second one.

**There are two axes here and they are not the same job.** One is *why we wanted this*. The other is
*what KIND of thing this is* — and a section can open with a perfect user quote about the first while
never once naming the second. The exemplar: `close_task` landing inside the launch window had a
complete, correct timeline, hook order, seconds, which guard is missing, and the words *race
condition* appeared nowhere in the file. Say them and the paragraph is readable at a glance; leave
them out and every reader rebuilds the concept from a sequence.

**The class-name gap has a cheap mechanical detector, and it is worth running FIRST because one
command aims the whole pass.** Grep for the standard NAMES of phenomena and look for the ones at zero
while the phenomenon is plainly described. Measured on one run: `race condition` 0, `TOCTOU` 0,
`time-of-check` 0, `idempotent` 0, `back-pressure` 0, `off-by-one` 0, against six paragraphs
describing races and four describing an idempotence fix — while `silent` appeared 121 times.

> **That ratio is the finding: the file reaches for the SYMPTOM it lived through far more readily
> than for the MECHANISM a stranger needs in order to look it up.**

**The direction of the loss is structural, which is why the tree can always repair it.** A task
description is written BEFORE the work, while the author still holds the problem as a CATEGORY; the
memory entry is written AFTER, while they hold the MECHANISM. So descriptions carry class names and
lack field names, entries carry field names and lack class names, and reading the two side by side is
not a heuristic — it is the answer sitting in the other document.

Three constraints on this step:

- **Do not force a name where the record has none.** Recognising a pattern is a hypothesis to be
  checked. This repo has already paid for reading several PARTS of one design as several ENTRANCES to
  one rule, which produced a patch nobody had chosen at a layer nobody had picked. When you cannot
  find the name, write that the class is unnamed and move on.
- **Report retrieved and inferred separately.** They are not the same grade of evidence, and the
  person reading your report cannot tell them apart from the diff.
- **Leave the task id behind.** It is the only entrance to the full record, and without it the next
  pass re-runs the same archaeology — or fails to, because the vocabulary has moved since.
  Measured before one pass: 90 of 130 sections carried no id.

**Hit rate is uneven rather than zero, and the unevenness is the useful signal**: it tells you which
sections genuinely have no recoverable WHY and therefore need one derived, instead of leaving you to
guess which.

## Step 2 — One full read, then one full rewrite, beside it

**Read the entire file in a single read. Not section by section, not region by region.** Then write
the whole new version as a single output, into a new file next to the old one.

**The one-shot output is not a convenience, it is the mechanism.** Producing the whole thing in one
pass is what forces it to be a connected narrative: you cannot write chapter nine as if chapter two
did not exist, and you cannot quietly leave two sections saying the same thing in different words,
because both are in front of you as you write. Emit it in pieces and you get a shorter directory —
which is the failure condition, not a smaller success.

What the rewrite is doing, stated as operations on each entry:

- **Ask: is this WHAT HAPPENED, or WHAT WE UNDERSTOOD?** What happened is in the task tree and in
  git, and `search_tasks` finds it, so it goes. What we understood stays, as a rule.
- **Keep the weld only where it is a DEFENCE LINE.** A craft rule with no evidence is a platitude
  every reader skims; the same rule sitting next to the afternoon it cost is an argument. But the
  test is not "is this evidence true", it is **would anyone make a different decision without it**.
  Keep the number that defends a counter-intuitive choice; drop the number that merely proves the
  fix worked, because that is in the code.
- **Once is an incident, twice is a pattern, three times is architecture.** When the same class of
  failure appears in five subsystems, that recurrence IS the content: say it once, hang the instances
  under it. This is the single largest source of compression, and it is invisible to any
  section-by-section pass, because no two instances share any wording — they were each filed
  correctly, under their own subject.
- **Write the design as a narrative, not a chronology.** "We went from A to B, here is what it is
  now and why" — not "on the 14th it was A, then it changed". Dates earn their place only when the
  date IS the fact, such as a credential that expired or a corpus that has since changed.
- **Compression is not terseness.** The line count falls because seven sections became one, not
  because sentences became telegrams. Do not stop writing properly in order to save words.

**A refuted claim is DELETED unless it can be written as a guardrail** — *"do not change Z back to Y;
Y silently loses W"*. If you cannot write that sentence, the old state goes. An earlier version of
this document said a refuted claim should become a pointer, and that instruction is what turned
`memory.md` into a changelog of old claims, corrections and pointers that every agent then paid for
on every launch.

### Two sieves, and the first one alone will lie to you

1. **Necessary** — is it one of the things that earn a place at all? (why we wanted it / how the next
   person falls / what no single file can show / negative results / just enough implementation to
   read those.) This answers *may it be in `memory.md`*.
2. **Sufficient** — **if this line were not here, what actually happens?** This answers *does it earn
   the space*, and the first sieve cannot:
   - **Silent, unbounded, and paid by someone other than the person who caused it** → keep.
   - **Rings immediately, is visible on the spot, and only bites the person editing that code** →
     cut, however true and however real the pitfall.

**Applying sieve 1 alone produces a defensible, wrong "we cannot compress further".** Measured: a
24-paragraph sample scored 18 keeps against sieve 1 and the curator reported the file was near its
floor; under sieve 2 three whole blocks inside those 18 came out, and every one of them was a true
pitfall and a genuine member of the four categories.

**Negative results get the same second sieve and are not exempt as a class.** Expensive to re-derive
AND the wrong conclusion is attractive → keep. One command re-tests it and the entry names the
command → cut.

### Why the surgical route is no longer the method

There used to be a four-phase procedure here — reorder, merge, condense, read through — with a
`comm -23` invariant, per-region scripts and a section-by-section disposition list. **It worked twice,
at a smaller size, and it stops working as the file grows**, for a reason worth stating plainly so
nobody reinstates it:

> **Surgery merges by SUBJECT. It cannot merge by CLASS, because the instances of a class are never
> adjacent and never share wording.** So a competent surgical pass produces exactly what the
> acceptance criterion calls failure: the same entries, arranged into a shorter directory.

Measured on one such pass: five subject merges took the merged regions down 22%, the other
three-quarters of the file was untouched, and the whole file came out *longer* than it started
because the understanding restored in step 1 exceeded what subject-merging removed.

**The parts of that procedure that survive are demoted from METHOD to ACCEPTANCE.** The enumeration
and the probes below are how you check a rewrite afterwards. They are not how you produce one.

## Acceptance — run these AFTER the rewrite

**The enumeration is the only CONTENT check, and every other check passing is what hides that.**
Measured: a pass reported six checks green — region list, code fences, orphan headings, bold pairing,
column widths, task-id count — and every one of them is STRUCTURAL. The disposition list is the only
one that asks whether a fact survived, and skipping it left **nine accidental content losses** under
an all-green report. That is `memory.md`'s own *a passing gate looks identical whether it read 8% or
100%*, wearing this document as its medium.

**The mechanical form, because "list every section's disposition" reads like bookkeeping until you
have a way to do it:** for each section of the OLD file, pull out every `**bold run**` over ~25
characters and every backticked identifier, and check both against the new file.

- **The bold runs are useless alone** — about 85% report "not verbatim", because rewriting rewords.
- **The identifiers are the signal.** An identifier present before and absent after is either a
  deliberate drop or an accident, **and separating those two is the entire point of the list.**
  Measured ratio on one pass: **9 accidents to 1 deliberate drop.** In the diff they are
  indistinguishable, and the deliberate one looks exactly as alarming as the accidents.

**Expect roughly a third of probe hits to be line-wrap false positives** — a phrase that exists in
the new file split across two lines. That is `memory.md`'s own *anything over ~60 characters needs a
multiline search*, firing on the script written to verify it. Chase all of them anyway; the check
that separates a wrap from a loss is one grep on a short fragment, and the one you skip is the one
that was real.

The structural checks, which are cheap and still worth running:

```bash
grep -c '^## ' memory.md                              # section conservation
diff <(git show <base>:.mxd/memory.md | grep '^# ') <(grep '^# ' .mxd/memory.md)   # regions
grep -c '^```' memory.md                              # fences must be even
awk '/^### /{h3=1} /^#### /{if(!h3)print NR}' memory.md   # orphan h4
grep -nEi 'paragraphs? (down|up|below|above)|section (above|below)|next door'      # positional prose
```

**Position-dependent prose is the one kind of rot that MOVING creates**, so it is worth a pass of its
own whenever material changes region. Two families, neither findable by grepping the names you moved:
region-relative (*"written up under X in the Gates section"* — the section still resolves, the region
it names is now wrong) and purely positional (*"three paragraphs down"*, *"next door"*, *"the section
above"* — no name in them at all). Grep the position words, read every hit, and state the result
either way; "checked, none crossed" is worth recording so the next pass does not re-derive it.

### The backward identifier survey

Extract every backticked identifier `memory.md` names and check each against the source. The forward
direction — *"I renamed something, let me grep the file"* — only fires when someone remembers; the
backward direction needs nobody to remember, which is why it finds a different set. Measured over 485
identifiers: 41 absent from the repo, most of them deliberate deletion records, and **four were live
present-tense guidance naming something that no longer exists.**

- **The endpoint of this survey is a DEFINITION, never another name.** A replacement you find in the
  source can itself be a phantom: one correction pointed at `wasReplaced`, which also does not
  exist — it appears three times, all in comments, while the real local is `notReplaced` and its
  polarity is the opposite. Ask the same question again of whatever you find.
- **Plant a fake identifier in the input before believing the output.** A `while read` loop silently
  dropped its final line, and the planted control caught it only because it was last. **Put the
  control where truncation risk is highest.** A survey of 485 names that quietly checks 484 reports
  exactly like one that checks all of them.
- **A control must be able to FAIL for the reason you are testing.** A reviewer confirmed with a
  positive control that grep could see a file's real exports, then reported two symbols as
  fabricated — but the symbols were real and lived in a commit their branch had not merged, and the
  chosen control existed in BOTH versions, so it could not separate "this symbol is absent" from "my
  checkout is old". Pick a control present under one hypothesis and absent under the other.
  Corollary: **prose on a branch can correctly point at code that only exists on `main` yet.**

### The cold read, by somebody else

The last step is a read-through by an agent with a clean context, **not by whoever did the rewrite.**
By the end of it you understand the material too well to see what is missing, which is exactly the
mechanism behind the "destroyed by understanding" rot. Its output is connective repair only —
transitions, pointers that no longer resolve, sections that now read as orphans — and anything larger
gets reported rather than done.

**This is the ONLY legitimate reason to hand this work over.** "Running low on context" is not one:
context is a compaction boundary, not a deadline, and both this file and `memory.md` survive
compaction by construction, so a compacted original strictly dominates a replacement who would re-read
the same documents without the summary and without any tacit judgement.

## Judgement calls that keep coming up

- **`memory.md` has a RATE, not a size, so a line-count target is the wrong instrument.** Measured:
  sixteen sections dated one single day accounted for 1,784 of 7,617 lines, about 960 after being
  rewritten at compressed density — one heavy day produces more than a 1,000-line target would allow
  the whole file to be. What holds is a trigger, not a number: regenerate when a region passes a size
  you re-derive each pass. **A target makes you stop at the number, and what gets cut is whatever you
  happened to be reading last rather than whatever least deserved to stay.**
- **Batch labels are not subjects.** FIX-1…FIX-10, Task X, P3 — dissolve by subject and retitle;
  nobody searches for "P3". **Except when the batch IS the subject**: a dead-code sweep has no
  subject other than what was deleted, and grouping those by process is correct.
- **Classify by conclusion, not by title.** "70K post-restart cache miss" is not a cache entry; its
  conclusion is that `response.model` cannot be trusted.
- **Classify by who gets hurt.** The LLM facility's real warning is a duplication between two provider
  files — that bites whoever edits providers, not a plugin author.
- **Keep evolution chains together even when different people drove them.** Grouping by who drove it
  is grouping by history, which is the thing you are leaving behind.
- **File a round's findings BY SUBJECT, not where the task lived.** A walker rewrite also produced two
  lessons about mutation harnesses and one about how prose rots; filing all of it under the walker
  buries the other two where only someone already reading about walkers will find them.
- **A deletion record deserves re-verification** — it is the entry most likely to have been quietly
  undone. Record the false positives you hit while checking, such as a deleted function still
  appearing in the comments that explain its deletion; that is a negative result and it stops the
  next person reopening it.
- **When a region checks out clean, say so IN the file**, dated and scoped. Otherwise the next pass
  re-derives the same finding, which is exactly the cost this exercise exists to remove.
- **Rot correlates with the gap between when a sentence was written and when the code under it last
  moved**, not with the sentence's age. A region whose entries were written by the same tasks, in the
  same sessions, as the code they describe can check out entirely clean while being the newest.
- **"If code can answer it, point at it" is too narrow — it is any AUTHORITATIVE SOURCE**, including
  another task's result round, a config value, an upstream doc.
- **Understating a security surface is worse than overstating it.** An auth skip list was described
  twice, both times smaller than reality, because a later change enlarged the anonymous surface
  without touching either entry. Check what is reachable, not what the entry lists.

## What a run produces

Two things, and the second is the more valuable:

1. A regenerated file.
2. **Everything learned about how this file fails**, which belongs here, because it applies to every
   entry written between regenerations.

The enumeration is a **forcing function, not a document**: its value is realised while you write it.
Budget for the write-up before you run out of room — a handoff written at the edge of exhaustion is
exactly the artifact that most needed the care.
