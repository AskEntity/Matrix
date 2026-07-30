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
that was true at a moment, and that moment does not change. *"You see `2116 pass / 2 fail` and
cannot tell WHICH two"* is not a claim about the suite's size; the story is identical when the suite
reaches three thousand, and deleting the number leaves it with no shape. The same pattern presented
as state — *"the suite has 2116 tests"* — expires silently and is what the rule is for.

## Step 1 — Restore the understanding, from the task tree

**The WHYs were never lost. They are in the task tree**, in the description of the task that
produced each section, often in the user's own words. The loss happens at the moment the entry is
written: the author has just spent hours inside the mechanism, the mechanism is in front of them,
and the intention is one screen away in a task description they do not re-open.

So for each section: `search_tasks` for the task that produced it, `get_task` for its description
and its **result rounds** (conclusions live in the rounds), and `search_logs` when you need what the
user actually said, because a description is already a retelling of the decision and a result round
is a second one.

**There are two axes here and they are not the same job.** One is *why we wanted this*. The other is
*what KIND of thing this is* — and a section can open with a perfect user quote about the first
while never once naming the second. The exemplar: `close_task` landing inside the launch window had
a complete, correct timeline, hook order, seconds, which guard is missing, and the words *race
condition* appeared nowhere in the file. Say them and the paragraph is readable at a glance; leave
them out and every reader rebuilds the concept from a sequence.

**The class-name gap has a cheap mechanical detector, and it is worth running FIRST because one
command aims the whole pass.** Grep for the standard NAMES of phenomena and look for the ones at
zero while the phenomenon is plainly described. Measured on one run: `race condition` 0, `TOCTOU` 0,
`time-of-check` 0, `idempotent` 0, `back-pressure` 0, `off-by-one` 0, against six paragraphs
describing races and four describing an idempotence fix — while `silent` appeared 121 times.

> **That ratio is the finding: the file reaches for the SYMPTOM it lived through far more readily
> than for the MECHANISM a stranger needs in order to look it up.**

**The direction of the loss is structural, which is why the tree can always repair it.** A task
description is written BEFORE the work, while the author still holds the problem as a CATEGORY; the
memory entry is written AFTER, while they hold the MECHANISM. So descriptions carry class names and
lack field names, entries carry field names and lack class names, and reading the two side by side
is not a heuristic — it is the answer sitting in the other document.

Three constraints on this step:

- **Do not force a name where the record has none.** Recognising a pattern is a hypothesis to be
  checked. This repo has already paid for reading several PARTS of one design as several ENTRANCES
  to one rule, which produced a patch nobody had chosen at a layer nobody had picked. When you
  cannot find the name, write that the class is unnamed and move on.
- **Report retrieved and inferred separately.** They are not the same grade of evidence, and the
  person reading your report cannot tell them apart from the diff.
- **Leave the task id behind.** It is the only entrance to the full record, and without it the next
  pass re-runs the same archaeology — or fails to, because the vocabulary has moved since. Measured
  before one pass: 90 of 130 sections carried no id.

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
  failure appears in five subsystems, that recurrence IS the content: say it once, hang the
  instances under it. This is the single largest source of compression, and it is invisible to any
  section-by-section pass, because no two instances share any wording — they were each filed
  correctly, under their own subject.
- **Write the design as a narrative, not a chronology.** "We went from A to B, here is what it is
  now and why" — not "on the 14th it was A, then it changed". Dates earn their place only when the
  date IS the fact, such as a credential that expired or a corpus that has since changed.
- **Compression is not terseness.** The line count falls because seven sections became one, not
  because sentences became telegrams. Do not stop writing properly in order to save words.

**A refuted claim is DELETED unless it can be written as a guardrail** — *"do not change Z back to
Y; Y silently loses W"*. If you cannot write that sentence, the old state goes. An earlier version
of this document said a refuted claim should become a pointer, and that instruction is what turned
`memory.md` into a changelog of old claims, corrections and pointers that every agent then paid for
on every launch.

### Two sieves, and the first one alone will lie to you

1. **Necessary** — is it one of the things that earn a place at all? (why we wanted it / how the
   next person falls / what no single file can show / negative results / just enough implementation
   to read those.) This answers *may it be in `memory.md`*.
2. **Sufficient** — **if this line were not here, what actually happens?** This answers *does it
   earn the space*, and the first sieve cannot:
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

There used to be a four-phase procedure here — reorder, merge, condense, read through — checked by a
set-difference (`comm -23`) invariant, per-region scripts and a section-by-section disposition list.
**It worked twice, at a smaller size, and it stops working as the file grows**, for a reason worth
stating plainly so nobody reinstates it:

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
Measured: a pass reported six checks green — region list, code fences, orphan headings, bold
pairing, column widths, task-id count — and every one of them is STRUCTURAL. The disposition list is
the only one that asks whether a fact survived, and skipping it left **nine accidental content
losses** under an all-green report. That is `memory.md`'s own *a passing gate looks identical
whether it read 8% or 100%*, wearing this document as its medium.

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

**Position-dependent prose is the one kind of rot that MOVING creates**, so it is worth a pass of
its own whenever material changes region. Two families, neither findable by grepping the names you
moved: region-relative (*"written up under X in the Gates section"* — the section still resolves,
the region it names is now wrong) and purely positional (*"three paragraphs down"*, *"next door"*,
*"the section above"* — no name in them at all). Grep the position words, read every hit, and state
the result either way; "checked, none crossed" is worth recording so the next pass does not
re-derive it.

### The backward identifier survey

Extract every backticked identifier `memory.md` names and check each against the source. The forward
direction — *"I renamed something, let me grep the file"* — only fires when someone remembers; the
backward direction needs nobody to remember, which is why it finds a different set. Measured over
485 identifiers: 41 absent from the repo, most of them deliberate deletion records, and **four were
live present-tense guidance naming something that no longer exists.**

- **The endpoint of this survey is a DEFINITION, never another name.** A replacement you find in the
  source can itself be a phantom: one correction pointed at `wasReplaced`, which also does not exist
  — it appears three times, all in comments, while the real local is `notReplaced` and its polarity
  is the opposite. Ask the same question again of whatever you find.
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

The last step is a read-through by an agent with a clean context, **not by whoever did the
rewrite.** By the end of it you understand the material too well to see what is missing, which is
exactly the mechanism behind the "destroyed by understanding" rot. Its output is connective repair
only — transitions, pointers that no longer resolve, sections that now read as orphans — and
anything larger gets reported rather than done.

**This is the ONLY legitimate reason to hand this work over.** "Running low on context" is not one:
context is a compaction boundary, not a deadline, and both this file and `memory.md` survive
compaction by construction, so a compacted original strictly dominates a replacement who would
re-read the same documents without the summary and without any tacit judgement.

**Brief it on METHOD and forbid it every source of CONCLUSIONS** — the rewrite's commit message, the
curator's session, and the previous cold read's report, which names specific paragraphs and would
hand over its answers instead of letting the new reader reach their own. Extract the method yourself
and put it in the description. **Its instinct will be to restore what looks missing, and that
instinct is wrong at the measured deliberate-to-accidental ratio**, so state the ratio and make
restoration out of scope: a report costs a paragraph, a wrong restoration is indistinguishable from
a fix in the diff.

**What a cold read uniquely produces, measured on one run of a freshly rewritten file:** four
connective repairs, of which **three were defects the rewrite itself had introduced** — a positional
phrase written the same evening, a direction word whose nearest same-vocabulary heading was BELOW
it, and a markdown break from the curator's own re-wrapper. **The curator cannot find these**,
because each one was correct at the moment it was written and the curator is the person who wrote
it. Its other output is a verdict nothing else can give: whether the file reads as one argument or
as a collection, and — on that run — that the spine's citation traffic is **one-way**, so a reader
entering at a subsystem meets a class name cold with no pointer back.

**Require three parts in the report, because the last two get skipped**: what changed; what was
CHECKED AND NOT CHANGED, which is a real result that stops the next pass re-deriving it; and what it
wanted to change but did not.

**Those three parts have three DIFFERENT destinations, and only the first is obvious.** Part one is
the commit. **Part two goes into a document, dated and scoped** — the same rule as *when a region
checks out clean, say so IN the file*, and the report is where it gets skipped most reliably,
because a clean result feels like the absence of a finding rather than a finding. **Part three lands
as NODES before the cold read calls `done()`, and the report names their ids**
(`01KYT7EYE951TPFSYRJ3QAH2F5`). A result round cannot hold owed work — `memory.md` § *A request
inside a `done()` result is owed to nobody* carries the general rule and the measurement behind it.
This step is the most expensive place to learn that, because part three is exactly the set no probe
can reach, and because the reader who produced it is about to stop existing.

**What the 2026-07-30 read checked and found clean, on `memory.md` @ `880845ed` (4224 lines)** — an
instance of part two, which had never once been recorded. Do not re-derive these; do re-run them
against a later version. 118 italic cross-reference spans, every
one resolving to a real heading or region. 40 distinct task ids against 727 nodes — one dangling,
repaired. 73 path-shaped tokens, all resolving but the four the file itself lists as deleted. 326
backticked identifiers against tracked source: 20 absent, 19 of them correctly so (deletion records,
vendor names, things deliberately never built). **Vestigial sentences: ZERO** from 12 patterns plus
every *"not X, not Y"* pair — worth knowing, because that class is live elsewhere in this repo.
Positional prose: 17 patterns, ~45 hits, **43 legitimate** — so expect this sweep to be mostly false
alarms and budget for reading them. Format: 0 attention markers, 138 headings before and after,
fences even, and every over-wide line a table row.

**The two runs bracket the range, and the good one is a coincidence rather than a process.** On
2026-07-30, 6 of 8 out-of-scope findings were fixed within 90 minutes — every fix committed by the
curator that had just merged the report, in the window before it closed. On 2026-07-25 the curator
was already gone: nothing was actioned, and five days later a regeneration re-derived the placement
and cross-reference findings as a side effect of reorganising while every finding needing its own
separate act died. **What survives an unowned report is exactly what a later pass regenerates
anyway**, which is the half you did not need a cold read for.

**Do not defer them to the next regeneration instead.** It is the tempting answer, since that is
where the material already is, and it fails on latency: a report is a measurement of ONE version,
the next rewrite rewords every sentence in it, and a cold read's yield is concentrated in defects
the pass just introduced — which the next pass will not be looking for, being busy introducing its
own.

## Judgement calls that keep coming up

- **`memory.md` has a RATE, not a size, so a line-count target is the wrong instrument.** Measured:
  sixteen sections dated one single day accounted for 1,784 of 7,617 lines, about 960 after being
  rewritten at compressed density — one heavy day produces more than a 1,000-line target would allow
  the whole file to be. What holds is a trigger, not a number: regenerate when a region passes a
  size you re-derive each pass. **A target makes you stop at the number, and what gets cut is
  whatever you happened to be reading last rather than whatever least deserved to stay.**
- **Batch labels are not subjects.** FIX-1…FIX-10, Task X, P3 — dissolve by subject and retitle;
  nobody searches for "P3". **Except when the batch IS the subject**: a dead-code sweep has no
  subject other than what was deleted, and grouping those by process is correct.
- **Classify by conclusion, not by title.** "70K post-restart cache miss" is not a cache entry; its
  conclusion is that `response.model` cannot be trusted.
- **Classify by who gets hurt.** The LLM facility's real warning is a duplication between two
  provider files — that bites whoever edits providers, not a plugin author.
- **Keep evolution chains together even when different people drove them.** Grouping by who drove it
  is grouping by history, which is the thing you are leaving behind.
- **File a round's findings BY SUBJECT, not where the task lived.** A walker rewrite also produced
  two lessons about mutation harnesses and one about how prose rots; filing all of it under the
  walker buries the other two where only someone already reading about walkers will find them.
- **A deletion record deserves re-verification** — it is the entry most likely to have been quietly
  undone. Record the false positives you hit while checking, such as a deleted function still
  appearing in the comments that explain its deletion; that is a negative result and it stops the
  next person reopening it.
- **When a region checks out clean, say so IN the file**, dated and scoped. Otherwise the next pass
  re-derives the same finding, which is exactly the cost this exercise exists to remove.
- **Rot correlates with the gap between when a sentence was written and when the code under it last
  moved**, not with the sentence's age. A region whose entries were written by the same tasks, in
  the same sessions, as the code they describe can check out entirely clean while being the newest.
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

## What the first whole-rewrite run taught

Measured on the run that replaced the surgical route: **5394 -> 4225 lines, 64044 -> 49299 words**,
one read in, one write out.

**The acceptance instrument depends on which method produced the output, and reaching for the wrong
one is the default.** The surgical era's probe was sentence identity — take high-information
sentences from the input, ask whether each still appears — and under surgery that works, because
surviving text is verbatim. **Under a rewrite every sentence is reworded, so the same probe reports
~100% LOST and carries no information at all.** It fails loudly rather than silently, which is the
one mercy; the real hazard is tuning it until it goes quiet.

**Two probes, and neither finds what the other finds.**

- **The token probe finds lost FACTS.** From the input pull every backticked identifier, every
  number of three or more digits, every all-caps word, every CJK run; check presence in the output.
  Yield on this run: **1347 / 145 / 519 / 22 candidates, ~190 flagged, 9 real losses.**
- **The coverage probe finds lost SUBJECTS.** For each section of the input, name two or three
  distinctive strings that must survive SOMEWHERE, and check the whole output — not the matching
  heading, which a rewrite has usually renamed or dissolved. This run: **67 of 67 subjects clean**,
  while the token probe was still finding real losses inside them.

**Do not carry the surgical pass's accident-to-drop ratio across as a prior — it inverts.** There it
was 9 accidents to 1 deliberate drop. Under a rewrite it is roughly 180 deliberate to 9 accidental,
because dropping implementation detail is what the rewrite is FOR: test-file names that are not
themselves the reference, mock names, model-name examples, SDK internals, reason-string constants
whose rule survives. **So the work is adjudicating ~190 items to find 9, and the 9 do not stand
out.** Budget for it, and write the deliberate drops into the commit message — an unexplained
absence and a considered one are identical in a diff.

**Match CJK fragments with whitespace stripped, not collapsed.** A CJK run has no spaces of its own,
so the hard wrap breaks it mid-phrase and a flatten-to-single-space comparison misses it: 4 of this
run's 5 CJK "misses" were wrap artifacts and one was real. Same class as the third-of-all-hits wrap
false positives above, at 80% rather than 33%.

**A mechanical re-wrap is provable, which is what makes it worth doing at the end.** Strip all
whitespace from input and output and assert byte equality, then assert the counts of headings, table
rows and code fences are unchanged. **The trap is that blockquote `>` prefixes MOVE under a
re-wrap**, so a whitespace-only strip is not invariant and the assertion fires on a correct
transform — normalise leading `>` away as well. Result here: 529 over-wide lines to 0, content
proven identical.

Four things about writing that re-wrapper, all of which cost a cycle:

- **The marker set is not what both documents said it was, and the missing member shipped a bug the
  cold read caught.** It is `>`, `|`, `#`, `-`, `=` **and a number followed by `.` or `)` AND A
  SPACE.** A sentence ending *"its message described 14."* put `14. ` at line start, which became an
  ordered-list item that swallowed the next four lines and left the sentence with no object — while
  `1.58M.` and `0.02s` in the same file are harmless, because the trailing space is the whole rule.
- **Its two rules fight.** *No continuation line may begin with a marker* is fixed by pulling a word
  down from the previous line, which then makes that line overlong. Chasing both in code loops; the
  cheap fix is to edit the TEXT so the offending token is not marker-initial (`#14876` became
  `(#14876)`).
- **A paragraph accumulator that stops at `#`-initial lines will split a paragraph at exactly the
  defect you are hunting**, and it is content-preserving, so no assertion fires and the tool hides
  the bug from itself.
- Do not treat "near 100 columns" as satisfied by 105. Wrap to a hard bound and the check is binary.

**After hoisting classes into a spine chapter, verify the pointers resolve.** Every `*Class name*`
reference must match a real heading — 20 of 20 here. This is the only check that tests whether the
hoist WORKED rather than whether text moved. **Do not try to extract the pointers with a regex over
italics**: the file's emphasis style and its pointer style are the same syntax, so a naive sweep
returned 457 candidates of which 8 were pointers. Check a named list you wrote deliberately.

**And the probe is an instrument.** This run's coverage probe required ALL of a section's strings to
be present when the intent was ANY, and reported one false loss — in a run whose entire subject was
that a green report proves nothing about what was read.

### The token probe is PER-SITE, so a correct drop can orphan a surviving use

**This is the failure mode of the adjudication the 180-to-9 ratio describes, and it means the 9
accidents are not the only cost of the 180 deliberate drops. Each deliberate drop is also a
candidate ORPHANING.**

Worked instance from this run, found afterwards by somebody else. A model codename appeared twice,
about a thousand lines apart. One site GROUNDED it — a sentence naming the model whose behaviour
prompted a feature. The other DEPENDED on it — a scope note reading *"this is X-class behaviour"*,
which is only meaningful to a reader who has met X. The rewrite generalised the grounding site,
which was correct in isolation and correct by this document's own list, since model-name examples
are exactly what a rewrite is supposed to drop. It kept the dependent site byte-identical.

**Neither half of the probe could see the result.** The dropped token fired, was adjudicated, and
the adjudication was right about the site it was looking at. The dependent site was never flagged,
because that site lost nothing — it is unchanged. **The probe asks "present before, absent after" of
one identifier at a time, and an orphaning is a relation between two sites.**

The check that closes it is cheap and belongs in the adjudication loop rather than after it:

> **For every identifier you are about to record as a deliberate drop, take its FIRST alphabetic run
> and grep the OUTPUT for it, case-insensitively.** `fable-5` dropped, `Fable` survives, one hit,
> one pass.

**First run, not longest — this rule was written as "longest" and measured wrong within the hour.**
`gpt-4.1-mini` gives `mini`, `sk-ant-` gives `ant` at 178 hits, `codex-auto-review` gives `review`.
**The longest run is routinely the least distinctive part of a name; the first run is the family.**
The failure direction matters more than the error: a check that answers 178 for a name with no
surviving use is not a false positive anyone argues with, it is noise, and noise is what gets a
check abandoned rather than fixed.

**It matters for NAMES, not for symbols.** A dropped symbol usually still has a definition in the
source, so a surviving use remains resolvable by the reader. A codename, a vendor generation, a
project or an incident name has no definition anywhere but this file — so deleting its only
introduction leaves every other use permanently unreadable, and nothing in the file or the repo can
repair it.

**The repair is not to define the term.** Grounding it again re-adds the very material the drop
correctly removed. Three options in order of preference: **cite the TASK that defines it**, which
costs one bracket and is what this document already tells you to do with an id; restore just enough
at the SURVIVING site to make the sentence stand alone; or delete the clause that depends on it.
Prefer deletion over a definition when the paragraph itself calls the mechanism dormant, because a
definition maintained for a dormant mechanism is a line paid for on every launch forever. **When you
cite, say what the task GROUNDS** — a draft that never ran defines a name and a symptom and settles
no measurement, and the search-hit vocabulary exists precisely to stop a proposal reading as a
record of work.

**And run the orphan check over the REPAIR, not only over the original.** The clause rewritten to
ground one name here contained a SECOND ungrounded name, in the same sentence, written while
thinking about grounding — it reads as context rather than as the same bug, because the author is
attending to the defect they just fixed. `memory.md` carries the general form under *a source audit
written in the same commit as its fix*: a repair manufactures false positives AND true positives
nobody re-runs the instrument over.

### The identifier is not the best anchor available. It is the ONLY one

**Ask the rule question, not the token question — and the reason you cannot simply ask it everywhere
is a measurement, not an excuse.** The caps failure was a substitution: testing *is this token
needed* where the question was *does the rule this token carried survive*. The obvious correction is
to check every rule directly. **It is not mechanizable.**

| long bold spans (>=40 chars) | count |
|---|---|
| in the input | 1201 |
| in the output | 893 |
| surviving VERBATIM | **188 — 16%** |

This file already predicted that number from the other side (*"the bold runs are useless alone —
about 85% report not verbatim, because rewriting rewords"*). Read forwards it says something
stronger: **a rewrite rewords 84% of its own rules, so no probe can ask whether a rule survived. The
identifier is the only anchor that survives rewording, so the dropped identifiers that sat inside a
bold span are not a subset you settled for — they are the ENTIRE mechanically-adjudicable
population.** Measured on this run: 175 dropped identifiers, **103** inside a bold span, and that
set arrives with the rule text attached, so adjudicating it is reading one sentence each.

> **Everything outside those 103 is reachable by no probe anybody can write. It is reachable only by
> somebody reading.** That is the argument for the cold read being a STEP rather than a courtesy,
> and it is also why an unowned cold-read report loses the only coverage that set ever gets.

**Yield of the bold-span pass, so the next run can price it:** nine further losses on top of the
nine the token probe found, one of which is a rule of its own and is stated below.

**State the yield with a SCOPE CLAUSE naming what was adjudicated at rule granularity, because a
count in a result round is read as a completed measurement.** This run reported *"9 real losses, all
restored"*, honestly, and it was 18 within the hour. The honest form is *N losses found, from
token-level adjudication of identifiers/numbers/CJK and rule-level adjudication of nothing.*

**And record an inconsistency you find in the INPUT as inherited, explicitly.** A rewrite is the
obvious suspect for every inconsistency discovered after it, so *"this was already in the input"*
costs one clause and stops a future pass paying to re-investigate work that was faithful.

### Compressing a list of NEGATIVES inverts it. It does not weaken it

A negative-results list exists to stop somebody spending an afternoon, so **its promise is
EXHAUSTION** — and that is the one place where dropping a member does not cost a little coverage, it
reverses the entry.

Measured instance. The input read *"NEGATIVE RESULTS on the CoreML knobs, so nobody spends the
afternoon again: `mlComputeUnits: CPUOnly`/`CPUAndGPU`, `modelFormat: MLProgram`,
`allowLowPrecisionAccumulationOnGPU` — every one still NaN"*, followed by a parenthetical:
**`coreml` plus `dtype: "fp16"` IS clean, it changes no decision because fp16 doubles the weights,
and `webgpu` plus `fp16` does not even load.** The rewrite kept the list and dropped the
parenthetical.

> **The list now enumerates every knob that fails and omits the only one that works. It does not
> merely fail to prevent the afternoon — it AIMS the reader at it**, because the single experiment
> left unmentioned is the one a reader tries next, and the surrounding sentence promises that trying
> it is unnecessary. *The promise was kept and the exception that made it true was deleted.*

**It will look safe to the next curator for the same reason it looked safe here.** An exception
inside a list of failures reads as a qualification of a point already made, and every other kind of
list in this document really does compress by dropping its weakest member. **Before shortening any
list, ask what its promise is. Where the promise is "these are all of them", it cannot be shortened
at all** — only replaced by a shorter list that is still complete.

### Symptom scarcity is a standing property of this file, not one curator's slip

The 2026-07-25 cold read measured **4 explicitly symptom-form entries in 81 sections, none in the
first 700 lines** — in a document that states its own access pattern as organised by cause and
queried by symptom. That finding was never actioned, and **the rewrite in between deleted another
one**: the user-visible symptom of connector-text summarization, *the user's reply vanishes into the
thinking fold*, went while the mechanism survived in full. Two independent passes, and it got worse
across the pass between them.

> **A symptom looks most redundant exactly when you have finished understanding its mechanism. So
> the moment you are best qualified to curate a section is the moment you are least able to keep its
> retrieval key** — which is why this cannot be fixed by curating more carefully, and has to be
> checked for by name.

The reader arrives holding *"my reply disappeared into the thinking fold"*, never *"connector text
is summarized server-side"*. **Count the symptom-form entries after a rewrite and state the
number.**
