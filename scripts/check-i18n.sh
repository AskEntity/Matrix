#!/bin/bash
# Check for bare/hardcoded user-visible strings in JSX/TSX files.
# A heuristic — not a parser, and not perfect — but it now looks at more than
# one syntactic form, and it says how much it looked at.
#
# ── SCOPE IS A SUBTRACTION, NOT AN ADDITION ──────────────────────────────────
# Start from EVERY .tsx in the repo and subtract; never enumerate the places to
# look. An include-list fails SILENTLY — new UI simply is not covered and
# nothing anywhere says so. A subtract-list fails LOUDLY — something noisy shows
# up and someone adds an entry. `biome.json` (`"includes": ["**", "!…"]`) and
# `tsconfig.json` (`"exclude": [...]`) already follow this rule, which is why
# both of them are still correct today with nobody maintaining them.
#
# This gate did not. It read `find web -maxdepth 1`, i.e. 4 of the repo's 31
# non-test .tsx files, and never touched `.mxd/plugin/web/` at all — where most
# of the product's user-facing strings live. It then printed an unqualified
# "i18n check passed" from inside the pre-commit hook. That unqualified sentence
# was the worse half of the defect: a gate that passes looks identical whether
# it read 8% of the UI or 100%. Hence the file count below — it is not
# decoration, it is the only thing that makes a future re-narrowing visible.
#
# ── DEPTH IS AN ADDITION LIST, AND IT CANNOT BE ANYTHING ELSE HERE ───────────
# Fixing the scope left the same defect one axis over. The check was a single
# regex for ONE syntactic form — text between two tags on ONE line — while its
# output spoke about bare strings in general. Measured on ErrorBoundary.tsx:
# six user-visible strings, one flagged.
#
# The honest subtraction here is a TSX parser: enumerate every JSXText and
# JSXAttribute and subtract the ones that route through t(). We do not have one,
# and a regex cannot become one. So the forms below ARE an addition list, they
# will never be complete, and the remedy is the same as the scope fix: the FORM
# COUNT is printed next to the file count. A future narrowing of depth is then
# exactly as visible as a narrowing of scope — which is the only property that
# was ever really missing, on either axis.
#
# ── PRECISION OVER RECALL, DELIBERATELY ──────────────────────────────────────
# Every form below is filtered by VISIBLE_STR: a user-visible string starts with
# a capital OR contains a space. That single rule is what separates "Kill
# process" from "mxd-btn-stop", "rotate(90deg)", "currentColor", "sk-ant-..."
# and "rollback.rewindTitle" — measured, it takes the ternary form from 32%
# precision to ~100%. It costs recall: alt="attached" is one word and lowercase,
# so it is missed. That is the right trade for a gate. A gate with a bad hit
# rate teaches people to skim past it, and then it is worth less than nothing —
# it is an unqualified "passed" with a habit of being ignored attached.
#
# ⚠️ Say it plainly, because a deliberate recall gap that nobody wrote down is
# one commit away from being the next depth defect — the very thing this file
# was just fixed for: SINGLE LOWERCASE WORDS WITH NO SPACE ARE NOT REPORTED.
# `alt="attached"` is a real bare string and this gate does not see it. That is
# a characterised limit, not an oversight, and the reason is the list of CSS
# values and i18n keys above. Widen it only with the false-positive rate in hand.
#
# ── THE BASELINE IS A RATCHET, AND IT WRITES ITSELF DOWNWARD ─────────────────
# Widening the forms surfaced 26 real bare strings that already existed. Two
# things are true at once: the gate is now correct, and the repo cannot pass it
# today. Failing every commit until a translation project finishes is not a
# strict gate — it is a gate that gets --no-verify'd, which leaves no trace and
# is how 24 type errors once accumulated. A gate nobody can pass stops being
# evidence about anything.
#
# So: fail when the count RISES, and REWRITE the baseline when it FALLS. The
# rewrite is the load-bearing half. A baseline that only a human remembers to
# lower is a number that quietly stops being true — the same silent-drain rot
# this whole round is about, reintroduced by the fix for it. Fix ten strings and
# a stale 26 would let ten new ones land unnoticed. Writing it down on every run
# means the number can never be stale in the direction that hides debt.
#
# ⚠️ KNOWN HOLE, accepted: the baseline is one count, so removing one string and
# adding another in the same commit nets to zero and passes. A per-file table
# would close it and is a bigger surface than the thing it protects. If you hit
# this, you have found the characterised case, not a new bug.

set -e

# Directories that are not our source. Add here when something noisy appears.
PRUNE_DIRS=(
	./node_modules  # dependencies
	./.git
	./.worktrees    # each sub-agent worktree is a full second copy of the repo
	./dist          # build output
	./out           # build output
	./coverage
	./.cache
	./_vendor_shims # Bun.build vendor scratch
)

prune_expr=()
for d in "${PRUNE_DIRS[@]}"; do
	prune_expr+=(-path "$d" -o)
done
unset 'prune_expr[${#prune_expr[@]}-1]' # drop the trailing -o

# Test files (*.test.tsx) hold assertion literals and parser fixtures, not
# user-facing UI — subtracted for that reason, not because of where they live.
FILES=()
while IFS= read -r -d '' f; do
	FILES+=("$f")
done < <(find . \( "${prune_expr[@]}" \) -prune -o \
	-name '*.tsx' ! -name '*.test.tsx' -print0 | sort -z)

if [ ${#FILES[@]} -eq 0 ]; then
	echo "i18n check FAILED — scanned 0 JSX files."
	echo "That is a broken scope, not a clean repo. Check the prune list in $0."
	exit 1
fi

# A string a user can read: starts with a capital, or contains a space.
VISIBLE_STR='"([A-Z][^"]+|[A-Za-z][^"]* [^"]+)"'

# Lines that are never user-facing text, whichever form matched.
SKIP_ALWAYS='^\s*(//|/\*|\*|import |export type|type |interface )'
# An i18n call on the line means the strings on it are keys, not copy.
SKIP_I18N='\bt\('
# SVG geometry and presentation. `aria-label=` used to live in this list and
# does not belong here — it is an accessibility string a screen reader speaks,
# which is precisely a string that must be translated.
SKIP_SVG='(viewBox|strokeWidth|strokeLinecap|strokeLinejoin|fill=|stroke=|points=|<svg|</svg|<path|<line|<circle|<rect|<polygon|<polyline|<title)'
# A string steering CSS or a class name is not copy.
SKIP_STYLING='(className|classList|style=|styles\.)'

HITS=$(mktemp)
trap 'rm -f "$HITS"' EXIT

# Forms are listed here so the count below cannot drift from what runs.
FORMS=(jsx-text multiline-text visible-prop rendered-expression)

for file in "${FILES[@]}"; do
	rel="${file#./}"

	# FORM jsx-text — bare text between tags on one line: >SomeText<
	# `(^|[^=])>` excludes `=>`: in real JSX the character before a closing `>`
	# is an identifier char, a quote, `}`, `/` or a space — never `=`. Without
	# this, every `(x: A) => Promise<void>` type annotation reads as `> Promise<`
	# and reports as a bare string.
	grep -nE '(^|[^=])>\s*[A-Za-z][A-Za-z ]{1,}\s*<' "$file" 2>/dev/null |
		grep -vE "$SKIP_ALWAYS" | grep -vE "$SKIP_SVG" |
		sed "s|^|$rel	jsx-text	|" >>"$HITS" || true

	# FORM multiline-text — JSX text on its own line, the tag closed on the one
	# before. Structurally invisible to any single-line pattern.
	awk -v rel="$rel" '
		prev ~ />[[:space:]]*$/ &&
		$0 ~ /^[[:space:]]*[A-Z][A-Za-z]*([[:space:]]+[A-Za-z0-9.,!?:'"'"'-]+)+[[:space:]]*$/ &&
		$0 !~ /[<>{}=]/ { printf "%s\tmultiline-text\t%d:%s\n", rel, NR, $0 }
		{ prev = $0 }
	' "$file" >>"$HITS"

	# FORM visible-prop — a prop a user reads, carrying a literal. Covers both
	# title="Copy" and title={cond ? "Thinking" : "Thinking (redacted)"}.
	grep -nE "(placeholder|title|alt|aria-label|aria-description)=\{?[^\"]*$VISIBLE_STR" "$file" 2>/dev/null |
		grep -vE "$SKIP_ALWAYS" | grep -vE "$SKIP_I18N" | grep -vE "$SKIP_SVG" |
		sed "s|^|$rel	visible-prop	|" >>"$HITS" || true

	# FORM rendered-expression — a ternary or fallback whose branches are text:
	# {loading ? "Verifying…" : "Login"}, {alt ?? "enlarged image"}.
	grep -nE "(\?|\?\?|\|\|)\s*$VISIBLE_STR" "$file" 2>/dev/null |
		grep -vE "$SKIP_ALWAYS" | grep -vE "$SKIP_I18N" | grep -vE "$SKIP_SVG" |
		grep -vE "$SKIP_STYLING" |
		sed "s|^|$rel	rendered-expression	|" >>"$HITS" || true
done

# One report per line of source: the forms overlap on purpose (a prop holding a
# ternary matches two), and a reader wants the location once. Dedupe first so
# the earliest form in FORMS wins, then sort so the list reads in file order —
# the forms run per-file, so raw output interleaves line numbers.
TAB=$(printf '\t')
DEDUPED=$(awk -F'\t' '{ split($3, p, ":"); k = $1 ":" p[1] } !seen[k]++' "$HITS" |
	sort -t"$TAB" -k1,1 -k3,3n)

COUNT=0
[ -n "$DEDUPED" ] && COUNT=$(echo "$DEDUPED" | wc -l | tr -d ' ')

# Absent baseline means ZERO permitted debt — a tree nobody has measured does
# not get a free allowance. That default is also what keeps the gate strict
# inside the synthetic fixtures the tests build.
BASELINE_FILE="scripts/i18n-baseline.txt"
BASELINE=0
if [ -f "$BASELINE_FILE" ]; then
	BASELINE=$(tr -cd '0-9' <"$BASELINE_FILE")
	[ -z "$BASELINE" ] && BASELINE=0
fi

list_hits() {
	echo "$DEDUPED" | while IFS="$TAB" read -r f form rest; do
		echo "BARE STRING [$form] $f:$rest"
	done
}

if [ "$COUNT" -gt "$BASELINE" ]; then
	list_hits
	echo ""
	# Keep the words "scanned N JSX file(s)" verbatim on BOTH the pass and fail
	# paths: the coverage test reads the number with one regex either way, so
	# that it measures scope independently of whether the repo is clean today.
	echo "i18n check FAILED — $COUNT bare string(s) against a baseline of $BASELINE; scanned ${#FILES[@]} JSX file(s) for ${#FORMS[@]} form(s)."
	echo "This change added $((COUNT - BASELINE))."
	echo "Wrap user-visible text with t() from the i18n system."
	echo "If the string is intentional (e.g. a brand name), it still goes through"
	echo "t() — give it the same value in every locale, as \"header.title\" does."
	exit 1
fi

# Falling count rewrites the baseline. See the ratchet note at the top: a
# baseline only a human remembers to lower is a number that silently stops
# being true, which is the rot this gate was just fixed for.
if [ "$COUNT" -lt "$BASELINE" ]; then
	mkdir -p "$(dirname "$BASELINE_FILE")"
	echo "$COUNT" >"$BASELINE_FILE"
	echo "i18n baseline lowered: $BASELINE -> $COUNT ($BASELINE_FILE rewritten — commit it)."
fi

if [ "$1" = "--list" ]; then
	list_hits
fi

if [ "$COUNT" -gt 0 ]; then
	echo "i18n check passed — scanned ${#FILES[@]} JSX file(s) for ${#FORMS[@]} form(s); $COUNT known bare string(s), 0 new. '$0 --list' shows them."
else
	echo "i18n check passed — scanned ${#FILES[@]} JSX file(s) for ${#FORMS[@]} bare-string form(s), none found."
fi
exit 0
