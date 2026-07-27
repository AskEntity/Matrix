# Reorganizing `memory.md`

The full procedure for a periodic memory reorganization. **You do not need this to write an entry**
— that is `memory.md` § *Writing This File*. You need this when the append zone has grown past the
point where related material can be found together.

Runs so far: **2026-07-25 phases 1-2**, 5,448 lines / 146 sections → 119, 18 commits. **2026-07-25
phase 3 (condense)**, 7,616 → 3,797 lines and 136 → 81 sections across 17 regions, 24 commits,
leaving zero `SUPERSEDED` banners and zero strikethroughs. **2026-07-25 phase 4**, six connective
repairs. (The line count rose between the two runs because ordinary work continued — see
`memory.md` on this file having a rate rather than a size.)

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

Contradictions are only visible when the claim and its refutation are in the same place. Reading the
file top to bottom does NOT find them — by the time you reach the correction you have forgotten the
original sentence forty sections back. Moving them adjacent is what makes them findable, and it is
why reordering must happen before, and separately from, any merging.

---

## The three phases

Each phase is a separate commit (phase 2 may be several). The value comes from the phases staying
**pure** — the moment you rewrite while moving, the phase-1 invariant is void, and once it is void
nothing can verify what the file lost.

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
- **Delete claims; keep measurements.** A measurement ("99.8% cache hit, 582 creation / 362K read")
  is a RECORD: it stays true about the moment it describes and it is the evidence that a fix worked.
  Applying the no-snapshots rule to it destroys evidence. What rots is the present tense — date it,
  say what it measured, say where today's value lives.
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
