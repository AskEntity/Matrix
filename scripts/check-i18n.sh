#!/bin/bash
# Check for bare/hardcoded strings in JSX/TSX files
# Looks for text content between > and < that isn't wrapped in {t(...)}
# This is a basic heuristic check — not perfect, but catches obvious violations.

set -e

ERRORS=0

# Find bare text between JSX tags: >SomeText< (where SomeText is 2+ alpha chars)
# Excludes: SVG elements, className/style props, comments, imports
while IFS= read -r line; do
    # Skip lines that are comments, imports, type declarations, SVG content
    if echo "$line" | grep -qE '^\s*(//|/\*|\*|import |export type|type |interface )'; then
        continue
    fi
    # Skip SVG-related lines (points, d=, etc.)
    if echo "$line" | grep -qE '(viewBox|strokeWidth|strokeLinecap|strokeLinejoin|fill=|stroke=|points=|<svg|</svg|<path|<line|<circle|<rect|<polygon|<polyline|<title|aria-label=)'; then
        continue
    fi
    
    # Look for bare English text between > and { or > and <
    # Pattern: > followed by text with 2+ alphabetic chars not inside braces
    if echo "$line" | grep -qE '>\s*[A-Za-z][A-Za-z ]{1,}\s*<'; then
        echo "BARE STRING: $line"
        ERRORS=$((ERRORS + 1))
    fi
done < <(cat web/*.tsx 2>/dev/null)

if [ $ERRORS -gt 0 ]; then
    echo ""
    echo "Found $ERRORS potential bare string(s) in JSX files."
    echo "Wrap user-visible text with t() from the i18n system."
    echo "If the string is intentional (e.g., a brand name), add it to the translation files."
    exit 1
fi

echo "i18n check passed — no bare strings found in JSX."
exit 0
