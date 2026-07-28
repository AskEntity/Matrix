# Reorganizing `memory.md`

The full procedure for a periodic memory reorganization. **You do not need this to write an entry**
— that is `memory.md` § *Writing This File*. You need this when the append zone has grown past the
point where related material can be found together.

Runs so far: **2026-07-25 phases 1-2**, 5,448 lines / 146 sections → 119, 18 commits. **2026-07-25
phase 3 (condense)**, 7,616 → 3,797 lines and 136 → 81 sections across 17 regions, 24 commits,
leaving zero `SUPERSEDED` banners and zero strikethroughs. **2026-07-25 phase 4**, six connective
repairs. **2026-07-28 rewrite**, 4,987 → ~3,050: a different exercise from the ones above, and the
one that produced the two sieves below. (The line count rises between runs because ordinary work
continues — see `memory.md` on this file having a rate rather than a size.)

⭐ **That run's method is the reusable part, and it is not "read the file and find redundancy".** The
file had lost its WHYs, and **the WHYs were never lost — they were sitting in the task tree**, in the
description of the task that produced each section, often in the user's own words. The loss happens
at the moment the entry is written: the author has just spent hours inside the mechanism, the
mechanism is in front of them, and the intention is one screen away in a task description they do not
re-open. So: **for each section, `search_tasks` for the task that produced it, read its WHY, and
rewrite the section's opening with that sentence.** One measured instance — a 178-line section on
`scrollRangeShrank`, thirty touch points and remount measurements, whose originating task opens
*"if the AI is still producing output, the user gets locked into follow mode just by scrolling down —
they can't read at their own pace"*, a sentence that appeared nowhere in the file. ⚠️ **Hit rate is
uneven rather than zero, and the unevenness is the useful signal**: it tells you which sections
genuinely have no recoverable WHY and therefore need one derived, instead of leaving you to guess.

---

## Why the file needs this at all

Entries are appended. Append means every new fact lands as far as possible from the fact it
invalidates, and that distance grows with the file. So contradictions accumulate **at the seams
between features**, systematically, not randomly.

Nobody is being careless. The agent writing an entry files it under its own subject, which is
correct — it does not know that a sentence in another region just became false. **The correction is
written where the CHANGE happened, never where the CLAIM lives.**

This has a consequence that shapes the whole procedure:

> **Phase 1 is not tidying. It is the detector for phase 2.**

### Three kinds of rot, three detectors, none substituting for another

| kind | is a correction written down anywhere? | what finds it |
|---|---|---|
| **Superseded** — a later change invalidated this | yes, but filed under the change, never under the claim | putting claim and correction in the same region |
| **Drained** — a count or list quietly stopped being true | **no.** Nobody thinks they are correcting anything | checking against the source, item by item |
| **Destroyed by understanding** — a curator deleted it as redundant | the content was there until we removed it | being forced to enumerate what you dropped |

The drained kind has **no trigger at all**: a stale count and a fresh count look identical, so the
interval between deliberate passes is how long a wrong number survives.

⭐ **Symptoms are the retrieval key, and the third rot kind eats them.** `memory.md` is organised by
cause and queried by symptom — the reader arrives holding "the buttons are missing", not "the event
type was renamed". A symptom looks most redundant exactly when you have just understood its
mechanism, which is exactly when it is most needed. Keep the conditional form — *"if you break this
invariant, you will see X"* — and cut the perfect tense, *"in July we had a bug where…"*, which is
addressed to nobody.

⭐ **Before applying any rule, ask whether the thing in front of you is a CLAIM or an INSTANCE.**
Every rule here targets what is presented as CURRENT STATE; none targets a string appearing in the
file. An instance cannot rot — it records something that was true at a moment, and that moment does
not change. *"You see `2116 pass / 2 fail` and cannot tell WHICH two"* is not a claim about the
suite's size; the story is identical when the suite reaches three thousand, and deleting the number
leaves it with no shape. The same pattern presented as state — *"the suite has 2116 tests"* —
expires silently and is what the rule is for.

⚠️ **This is the one phase-3 loss that nothing can detect.** A curator holding "do not record test
counts" scans, finds three violations, deletes them, writes them into the enumeration, and is
compliant at every step — while three arguments lose their skeletons. `comm` does not apply, nothing
rings, and the content was there until we removed it.

Contradictions are only visible when the claim and its refutation are in the same place. Reading the
file top to bottom does NOT find them — by the time you reach the correction you have forgotten the
original sentence forty sections back. Moving them adjacent is what makes them findable, and it is
why reordering must happen before, and separately from, any merging.

---

## The three phases

Each phase is a separate commit (phase 2 may be several). The value comes from the phases staying
**pure** — the moment you rewrite while moving, the phase-1 invariant is void, and once it is void
nothing can verify what the file lost.

**The order is forced, and each phase detects something no other one can:**

| phase | what it does | what only it can detect |
|---|---|---|
| **1 · reorder** | move sections into subject regions, delete nothing | **superseded** — append-only files every new fact maximally far from the claim it refutes, so putting the two side by side is the only thing that surfaces the contradiction. One pass found 12. |
| **2 · merge** | same-subject sections become one narrative | redundancy that is invisible while scattered. The sharp question is *找不同*: once the invariant is stated, an instance earns its lines only if it does NOT fit. |
| **3 · condense** | delete; `comm` no longer applies, so enumerate every section's disposition | nothing, from the inside — the enumeration is the *only* thing keeping **destroyed by understanding** detectable at all |
| **4 · read-through** | a fresh agent who did not see phases 1-3 | whether it still READS |

Condensing before merging condenses N copies separately and keeps N. Merging before reordering
cannot see what is the same subject while it is scattered.

**Compression is not terseness.** Line count falls because seven sections became one, not because
sentences became telegrams. Write every surviving sentence out properly.

⭐ **`memory.md` has a RATE, not a size — so a line-count target is the wrong instrument.** Measured
2026-07-25: sixteen sections dated that single day accounted for **1,784 of the file's 7,617 lines,
23%**, and about **960 lines** after being rewritten at compressed density. **One heavy day produces
more than a 1,000-line target would allow the whole file to be.** What holds is a rule with a
trigger — merge a region when it passes some size, re-derive the criterion every Nth pass.

### Phase 1 — Reorder (move only)

Move whole sections into topic regions. **Do not change one character of existing content.** You may
ADD structural lines: region dividers, region headings, blank-line balancing.

- **Invariant: `comm -23 <(sort BEFORE) <(sort AFTER)` must be EMPTY.** Every original line still
  present, multiplicity not reduced. Additions (`comm -13`) are allowed and should contain nothing
  but dividers, headings and blanks — check that, too.
- **Region names may only be REUSED or ADDED. Renaming is a phase-2 edit** — a rename modifies an
  existing line and breaks the invariant. Expect to keep two or three ill-fitting old names through
  phase 1; that is correct.
- **Order within a region: original chronological order.** This is for the MERGE direction — later
  supersedes earlier, with no ambiguity about which way a conflict resolves.
- Propose the region scheme and the full section→region assignment **before moving anything**, and
  get it signed off. Misfiling is expensive: phase 2 then merges things on a wrong adjacency.

### Phase 2 — Merge (one region at a time)

Now that related material is adjacent, merging is a LOCAL operation — you can see both pieces at
once and never need the whole file in your head.

- **Invariant: `comm -23` must be ENUMERABLE**, and the enumeration goes in the commit message.
  Not "empty" — phase 2 legitimately deletes text — but every removed line must have a stated
  destination.
- **Match audit granularity to the granularity at which "did we lose a fact" is decidable.** A small
  edit: per line. A 350-line collapse: per subsection — list every `##`/`###` of the originals with
  its disposition (carried / superseded-and-where / dropped-and-why). Line-level audit of a rewrite
  is noise; subsection-level is checkable.
- **After merging, re-sort by AUTHORITY: current state first, history below.** Phase 1 ordered by
  time for the merge direction; that same order puts the most stale text where it is read first.
  Two sorts, two purposes, no conflict.
- **Merge duplicated TEXT, never facts.** Every fact, correction and lesson must still be findable.
- ⚠️ **A refuted claim is DELETED unless it can be written as a guardrail.** This reverses what this
  document said on its first run (*"a refuted claim becomes a pointer, not a deletion"*), and the
  reversal is the whole reason phase 3 exists — that instruction is what turned `memory.md` into a
  changelog of old claims, strikethroughs, corrections and pointers, which every agent then paid for
  on every launch. The live rule is in `memory.md` § *⚠️ Writing this file*: a past state earns its
  lines only when a reader without it could not justify the current design or would reintroduce the
  old one, and then it is written as *"do not change Z back to Y; Y silently loses W"*. **If you
  cannot write that sentence, delete the old state.**

### Phase 3 — Condense

**Phases 1-3 move and merge; they do not shrink much.** Measured on the most chronicle-dense region:
everything explicitly marked as history was **175 of 896 lines, 20%**. So a file that has grown too
expensive is not fixed by tidying its writing — the rest only comes out by removing things it
currently says.

- **Be given a target COMPOSITION, not a target line count.** The remaining material has no
  principled ordering among itself, so a number leaves you guessing which category to cut. "Keep the
  looks-wrong-but-is-right entries and the operating procedure, drop the design rationale for things
  nobody would simplify" is executable and checkable; "get to N lines" is not.

⭐ **Phase 3 needs TWO sieves, and having only the first is the standard way a condensing pass
stalls.** Established on the 2026-07-28 run, which reached 3,100 lines and then spent an hour finding
almost nothing more to cut:

1. **Necessary — is it one of the four things that earn a place?** (why / pitfall / the thing no
   single file can show / just enough implementation to read those three.) This answers *may it be in
   memory.md*.
2. **Sufficient — if this line were not here, what actually happens?** This answers *does it earn the
   space*, and the first sieve cannot:
   - **Silent, unbounded, and paid by someone other than the person who caused it** → keep. An empty
     text block bricks a session permanently and repair does not cover it. A fictional API rule got
     four production mechanisms built against it.
   - **Rings immediately, is visible on the spot, and only bites the person editing that code** →
     cut, however true and however real the pitfall. **That is the definition of the "very very small
     thing that reads like a code comment copied out here".** Whoever writes that test will discover
     in thirty minutes that happy-dom does not dispatch keydown, and those thirty minutes are not
     what this file exists to prevent.

**Negative results get the same second sieve; they are not exempt as a class.** *Expensive to
re-derive AND the wrong conclusion is attractive* → keep (CoreML's NaN is not monotonic in input
length, and a plausible length-threshold hypothesis would have shipped). *One command re-tests it and
the entry itself says which command* → cut (`bun:sqlite` cannot `loadExtension`).

⚠️ **Applying sieve 1 alone produces a defensible, wrong "we cannot compress further".** Measured on
that run: a 24-paragraph sample scored 18 keeps against sieve 1, and the curator reported the file
was near its floor. Under sieve 2 three whole blocks inside those 18 — a test environment's quirks, a
markdown parser's grammar, and a list of compiler-and-linter gotchas — came out. **Every one of them
was a true pitfall and a genuine member of the four categories.**
- **Phase 1's `comm -23` invariant does not apply — you are deleting.** Its replacement is a
  per-section disposition list in each commit message. That enumeration is the ONLY thing that keeps
  the "destroyed by understanding" rot detectable from the inside.
- ⚠️ **Sample your own marks before quoting them.** A curator marking their own entries as
  must-keep overstates the protected share: measured, 20 self-marked items tested against the
  criterion passed 11, borderline 3, **failed 5** — all five craft or method rather than
  looks-wrong-but-is-right. About a third too high, in the direction that favoured the curator's own
  position.

### Phase 4 — Read through

Connective repair only: transitions, pointers that no longer resolve, sections that now read as
orphans. **No new merges** — note them and report instead.

⭐ **Phase 4 must be done by an agent with a clean context, NOT by whoever did phases 1-3.** By the
end of them you understand the material too well to see what is missing — which is precisely the
mechanism behind the "destroyed by understanding" rot. The person best placed to finish is the
person least able to.

**This is the ONLY legitimate reason to hand this work over.** "Running low on context" is not one:
context is a compaction boundary, not a deadline — a compacted agent continues with a summary, and
both this file and `memory.md` survive compaction by construction. The compacted original therefore
strictly dominates a replacement, who would re-read the same documents *without* the summary and
without any tacit judgement. See `memory.md` § *Where agents predictably go wrong* #5. Phase 4 is different
in kind: there, not knowing the material is the requirement, not the cost.

---

## Checks — run ALL of these after EVERY change, not just in phase 1

Naming them "the phase-1 invariants" is how you switch them off at the moment they start mattering.
In phase 1 the structural checks are cheap and useless (moving cannot break structure). In phases 2
and 3 they are cheap and **necessary** (merging and deleting can).

```bash
# 1. information loss
comm -23 <(sort BEFORE) <(sort AFTER)      # phase 1: empty. phases 2-3: enumerable.

# 2. section conservation — catches a section absorbed into another
grep -c '^## ' memory.md

# 3. region conservation — DIFF THE LIST, don't count it
diff <(git show <phase1-commit>:.mxd/memory.md | grep '^# ') <(grep '^# ' .mxd/memory.md)

# 4. rendering integrity
#    - code fences balanced (odd count = a stray fence, mis-nests the rest of the document)
#    - no code block containing a heading line
#    - no '#### ' without a '### ' above it in its section

# 5. position-dependent prose — the one kind of rot MOVING creates
grep -nE '(see|See|under|Under|per|Per|in) \*[A-Z]'   # named refs: resolve each against the heading list
grep -nEi 'paragraphs? (down|up|below|above)|section (above|below)|next door|the (next|previous) section|the [A-Z][a-z]+ (section|region)'
```

Check 3 exists because of a real incident: a merge script swallowed an entire region heading and
reparented five sections. `comm` showed the three divider lines as removed and they read as ordinary
churn; section count was unaffected. **Only the structural count caught it, and only because it was
still being run.** Diffing the list beats counting it — a count tells you something moved, the diff
tells you what.

⭐ **Check 5 is phase 1's OWN hazard, and it is the only one that is.** Every other check guards
against something any phase can do. This one guards against something only phase 1 does at scale:
**phase 1 is the only phase that changes POSITION, and position-dependent prose is the only prose
that a change of position falsifies.** Two families, and neither is findable by grepping the names
you moved:

- **Region-relative** — "written up under *X* **in the Gates section**", "see *Y*, **Daemon
  region**". The section name still resolves; the region it names is now wrong.
- **Purely positional** — "the rule **three paragraphs down**", "the self-bootstrap warning
  **below**", "**next door**", "the section **above**". These have no name in them at all.

Both are the *invalidated* rot kind — true when written, falsified by a change somewhere else, and
**re-reading the sentence cannot detect it**, because nothing about the sentence is wrong on its
face. Measured on the 2026-07-27 run: moving one subsection broke exactly two references, one of
each family, and a name-grep over everything that moved returned neither.

**So grep the position words, not the moved names**, and read every hit — a grep gives you
candidates, not verdicts. Most hits are figurative ("the task above", "the layer below") and are
discarded in a second. Do this at the END of phase 1, before the commit, and state the result in the
commit message either way; "checked, none crossed" is worth recording, because the next curator will
otherwise re-derive it.

### Check 6 — the BACKWARD identifier survey

Extract every backticked identifier `memory.md` names and check each against the source. The forward
direction (*"I renamed something, let me grep the file"*) only fires when someone remembers; the
backward direction needs nobody to remember, which is why it finds a different set. Measured
2026-07-27 over 485 identifiers: 41 absent from the repo, most of them deliberate deletion records —
and **four were live present-tense guidance naming something that no longer exists**. Each fails the
same way: a reader greps it, gets nothing, and concludes the mechanism is gone.

⚠️ **The endpoint of this survey is a DEFINITION, never another name.** The replacement you find in
the source can itself be a phantom: one correction pointed at `wasReplaced`, which **also does not
exist** — it appears three times, all in comments, while the real local is `notReplaced` and its
polarity is the opposite. After finding a candidate, ask the same question again: does *this* one
have a definition?

⚠️ **Plant a fake identifier in the input before believing the output.** On the first run a bash
`while read` loop silently dropped its final line, and the planted control — added last — was the
only thing that said so. A survey of 485 names that quietly checks 484 reports exactly like one that
checks all of them. ⭐ **The control worked ONLY because it was last: put it where truncation risk is
highest**, which for anything looping line by line is the final line.

⚠️ **A control must be able to FAIL for the reason you are testing.** A reviewer reported two symbols
as fabricated, having first confirmed with a positive control that grep could see that file's real
exports — sound method, wrong control. The symbols were real and lived in a commit their branch had
not merged, and the chosen control existed in BOTH versions, so it could not separate "this symbol
is absent" from "my checkout is old". **Pick a control present under one hypothesis and absent under
the other.** Corollary for a repo worked on in parallel branches: **prose on a branch can correctly
point at code that only exists on `main` yet**, and it reads as fabricated to anyone on the branch.

---

## Scripts

Ephemeral, written per-region. The patterns matter, not the files.

**⚠️ The bug to not repeat.** Cutting a section by scanning to the next `## `:

```ts
// WRONG — swallows the region divider when the cut section is LAST in its region
while (e < lines.length && !lines[e].startsWith("## ")) e++;

// RIGHT — stop at a divider too
const isDivider = (i) =>
  lines[i] === "---" && (lines[i + 1] ?? "").startsWith("# ") && lines[i + 2] === "---";
while (e < lines.length && !lines[e].startsWith("## ") && !isDivider(e)) e++;
```

Three patterns cover everything:
- `cut(titlePrefix)` — remove a whole section (with the guard above), trailing blanks trimmed.
- `demote(block, newTitle)` — `## `→`### `, `### `→`#### `. **Required when folding**, or the
  folded section's subheadings become siblings of their own parent.
- `appendInto(hostPrefix, blocks)` — insert at the end of a host section, backing up over its
  trailing blanks first.

Recompute section indices after every splice — caching them across mutations silently corrupts the
next lookup.

---

## Judgement calls that came up, and how they were settled

- **Batch labels are not subjects.** FIX-1…FIX-10, Task X, Task Y, P3 — a batch fixed a binary proxy
  and a save button in the same pass. Dissolve by subject and retitle; nobody searches for "P3".
- **Except when the batch IS the subject**: the dead-code sweeps have no subject other than "what we
  deleted". Grouping those by process is correct — and worth flagging in the commit as the one
  deliberate exception, so the exception does not erode the rule.
- **Classify by conclusion, not by title.** "70K Post-Restart Cache Miss" is not a cache entry; its
  conclusion is "`response.model` cannot be trusted".
- **Classify by who gets hurt.** The LLM facility's real warning is a duplication between two
  provider files — that bites someone editing providers, not a plugin author.
- **Keep evolution chains together even when different people drove them.** Grouping by "who drove
  it" is grouping by history, which is what you are leaving behind.
- A deletion record deserves re-verification: it is the entry most likely to have been quietly
  undone. Also record the false positives you hit while checking (e.g. a deleted function still
  appearing in comments that explain its deletion) — that is a negative result and it stops the
  next person reopening it.
- **When a region checks out clean, say so IN the file**, dated and scoped ("verified <date>, skip
  unless <file> moved"). Otherwise the next pass re-derives the same finding from scratch, which is
  exactly the cost this exercise exists to remove. The file has almost no negative results; it
  should have more.
- **Rot correlates with the gap between when a sentence was written and when the code under it last
  moved** — not with the sentence's age alone. The newest region checked out entirely clean because
  its entries were written by the same tasks, in the same sessions, as the code they describe. This
  is why the oldest sections are worth reordering first: it front-loads the finds.
- **"If code can answer it, point at it" is too narrow — it is any AUTHORITATIVE SOURCE.** Another
  task's `done()` result, a config value, an upstream doc. The narrow reading is not hypothetical:
  a hand-compressed copy of two task results was written into a task description — by someone who
  had stated the rule that same day — because its perceived scope was "documentation vs code".
- **A measurement as EVIDENCE can go; a measurement as a DEFENCE LINE must stay.** The older form of
  this rule was "delete claims, keep measurements", justified by measurements not rotting — true,
  and "does not rot" is not the same as "earns its place". The sharper test is: **if this number
  were gone, would anyone make a different decision?**
  - **Yes → keep.** `webgpu 909s wall / 38.8s CPU` against `cpu 697s / 3044s CPU` defends a
    counter-intuitive choice (we ship the option that is 30% slower in wall-clock), and anyone
    arriving to "optimise" it will pick cpu and starve the machine. The number is the only defence
    that decision has. Same for the 628 mock-generated error strings.
  - **No → delete the number, keep the conclusion.** `68,664 files → 320, 153ms → 0.4ms` defends
    "prune at descent", and the sentence *"the walk now costs what the ANSWER costs"* already
    defends it completely. The number proved the fix worked, and that the fix works is in the code.
  - What still rots either way is the present tense. Date it, say what it measured, say where the
    current value lives. ⭐ And a kept measurement survives best **folded INTO the guardrail it
    evidences** — standing alone as its own paragraph it reads as trivia and is the first thing the
    next pass deletes.
- **File a task's findings BY SUBJECT, not where the task lived.** A round's output is rarely one
  thing: a walker rewrite also produced two lessons about mutation harnesses and one about how prose
  rots. Filing all of it under the walker buries the other two where only someone already reading
  about walkers will find them — which is nobody. Splitting that round three ways cost 117 net lines
  against the ~200 it would have taken as one appended section.
- **Understating a security surface is worse than overstating it.** The auth middleware's skip list
  was described twice, both times smaller than reality, because a later change (frontend paths
  becoming server-visible) enlarged the anonymous surface without touching either auth entry. When
  verifying anything about access control, check what is reachable, not just what the entry lists.

---

## What a run produces

Two things, and the second is the more valuable:

1. A reorganized file.
2. Everything learned about **how this file fails** — which belongs in `memory.md` §
   *Writing This File*, because it applies to every entry written between reorganizations.

A forced enumeration is a **forcing function, not a document**: its value is realized while you
write it. In the first run, both curator mistakes were caught by writing the disposition table, not
by re-reading. Budget for the write-up before you run out of room; a handoff written at the edge of
exhaustion is exactly the artifact that most needed the care.
