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
