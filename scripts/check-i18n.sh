#!/bin/bash
# Check for bare/hardcoded strings in JSX/TSX files.
# Looks for text content between > and < that isn't wrapped in {t(...)}.
# This is a basic heuristic check — not perfect, but catches obvious violations.
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
# it read 8% of the UI or 100%. Hence the file count below — it is not decoration,
# it is the only thing that makes a future re-narrowing visible.

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

ERRORS=0

for file in "${FILES[@]}"; do
	# Bare text between JSX tags: >SomeText< (SomeText = 2+ alpha chars).
	# `(^|[^=])>` excludes `=>`: in real JSX the character before a closing `>`
	# is an identifier char, a quote, `}`, `/` or a space — never `=`. Without
	# this, every `(x: A) => Promise<void>` type annotation reads as `> Promise<`
	# and reports as a bare string.
	while IFS=: read -r lineno line; do
		[ -z "$lineno" ] && continue
		# Skip comments, imports, type declarations.
		if echo "$line" | grep -qE '^\s*(//|/\*|\*|import |export type|type |interface )'; then
			continue
		fi
		# Skip SVG-related lines (points, d=, etc.).
		if echo "$line" | grep -qE '(viewBox|strokeWidth|strokeLinecap|strokeLinejoin|fill=|stroke=|points=|<svg|</svg|<path|<line|<circle|<rect|<polygon|<polyline|<title|aria-label=)'; then
			continue
		fi
		echo "BARE STRING: ${file#./}:$lineno: $line"
		ERRORS=$((ERRORS + 1))
	done < <(grep -nE '(^|[^=])>\s*[A-Za-z][A-Za-z ]{1,}\s*<' "$file" || true)
done

if [ $ERRORS -gt 0 ]; then
	echo ""
	echo "Found $ERRORS potential bare string(s) across ${#FILES[@]} JSX file(s)."
	echo "Wrap user-visible text with t() from the i18n system."
	echo "If the string is intentional (e.g. a brand name), it still goes through"
	echo "t() — give it the same value in every locale, as \"header.title\" does."
	exit 1
fi

echo "i18n check passed — scanned ${#FILES[@]} JSX file(s), no bare strings found."
exit 0
