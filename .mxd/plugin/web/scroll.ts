/**
 * Scroll-position helpers for the activity log.
 *
 * Pure functions — no DOM access — so they are directly unit-testable
 * (web/scroll.test.ts). The DOM-facing callers live in ActivityLog.tsx.
 */

/**
 * Distance (px) from the bottom within which the log still counts as
 * "at bottom". Matches the historical inline `< 40` threshold that drives
 * auto-follow re-engagement on scroll-down.
 */
export const NEAR_BOTTOM_THRESHOLD = 40;

/**
 * True when a scroll container is within `threshold` px of its bottom.
 *
 * One predicate, two consumers:
 * - auto-follow: scrolling back down to the bottom re-enables follow mode
 * - scroll-to-bottom button: shown when NOT near bottom
 *
 * A non-overflowing container (scrollHeight <= clientHeight) is always
 * "near bottom" — there is nowhere to scroll, so the button never shows.
 * Overscroll (iOS rubber-banding puts scrollTop past the max) yields a
 * negative distance, which also counts as "near bottom".
 */
export function isNearBottom(
	scrollTop: number,
	scrollHeight: number,
	clientHeight: number,
	threshold: number = NEAR_BOTTOM_THRESHOLD,
): boolean {
	return scrollHeight - scrollTop - clientHeight < threshold;
}

/** How far the container can be scrolled. Zero when it does not overflow. */
export function scrollRange(
	scrollHeight: number,
	clientHeight: number,
): number {
	return Math.max(0, scrollHeight - clientHeight);
}

/**
 * True when the scrollable range got smaller, i.e. the content or the viewport
 * shrank underneath the current offset.
 *
 * `isNearBottom` cannot tell "the user scrolled back down to the bottom" from
 * "the bottom came up to meet the user". Both read as at-bottom, and the second
 * one is not a statement about what the user wants — the browser clamps the
 * offset to the new maximum and dispatches a perfectly ordinary, `isTrusted`
 * scroll event. There is no flag on the event that distinguishes them.
 *
 * Measured cases where the range shrank and follow mode was silently re-armed,
 * dragging the user to the bottom as soon as the content came back:
 *
 *   - switching tasks: the log renders empty for one frame while the new
 *     session's events are still in flight (range 1549 → 0)
 *   - a log search that matches nothing (range 1549 → 0)
 *   - a log search that matches a few entries (range 1549 → 0)
 *   - a log search that still overflows (range 1549 → 449) — note this one
 *     stays scrollable, so "does it overflow" is NOT the discriminator
 *   - the composer growing as the user types (measured: viewport 572 → 537)
 *
 * The list above is not the point and should not be turned into a list of
 * causes to check. This tests the property that makes the observation
 * meaningless, so it also covers the causes nobody has enumerated yet.
 *
 * Growth is deliberately NOT suspicious: a streaming reply grows the content
 * every frame, and a user who scrolls back down during streaming must still be
 * able to re-arm follow.
 */
export function scrollRangeShrank(
	previousRange: number,
	currentRange: number,
): boolean {
	return currentRange < previousRange;
}
