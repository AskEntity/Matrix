import { useCallback, useEffect, useRef, useState } from "react";

/**
 * ScrollTarget — the single source of truth for where the activity log should
 * be scrolled to for a given task.
 *
 * One target per task. Transitions are explicit:
 * - { kind: "follow" } — pinned to bottom, auto-updates as content arrives.
 *   User scrolling to bottom re-enters this state; follow-button enters it.
 * - { kind: "anchored", ts, offsetPx } — pinned to a specific log entry by
 *   its backend timestamp. Survives content additions above/below AND page
 *   refreshes (ts is backend-assigned, stable across reloads).
 *
 * Why not pixel-based? Pixel scrollTop drifts when content is added above
 * (lazy loader) or when an entry grows (streaming text). Anchor by entry +
 * offset-within-viewport is content-change-invariant.
 *
 * Why ts and not a session-local id? entry.id is a monotonic counter reset
 * on page reload. ts comes from the backend and is stable across reloads,
 * reconnects, and between tabs.
 */
export type ScrollTarget =
	| { kind: "follow" }
	| { kind: "anchored"; ts: number; offsetPx: number };

const STORAGE_KEY_PREFIX = "mxd-scroll-state:";
/** Considered "at bottom" if distance is less than this. */
const BOTTOM_THRESHOLD_PX = 40;

function storageKey(taskId: string): string {
	return `${STORAGE_KEY_PREFIX}${taskId}`;
}

function loadTarget(taskId: string): ScrollTarget {
	try {
		const raw = localStorage.getItem(storageKey(taskId));
		if (!raw) return { kind: "follow" };
		const parsed = JSON.parse(raw);
		if (parsed?.kind === "follow") return { kind: "follow" };
		if (
			parsed?.kind === "anchored" &&
			typeof parsed.ts === "number" &&
			typeof parsed.offsetPx === "number"
		) {
			return {
				kind: "anchored",
				ts: parsed.ts,
				offsetPx: parsed.offsetPx,
			};
		}
	} catch {
		/* ignore */
	}
	return { kind: "follow" };
}

function saveTarget(taskId: string, target: ScrollTarget): void {
	try {
		localStorage.setItem(storageKey(taskId), JSON.stringify(target));
	} catch {
		/* ignore */
	}
}

/** Clear saved state for a task (called when a tab is closed permanently). */
export function clearScrollTarget(taskId: string): void {
	try {
		localStorage.removeItem(storageKey(taskId));
	} catch {
		/* ignore */
	}
}

/** Pure anchor-selection: given container top and a list of entry
 * (top, bottom, ts) rects (in viewport coords), return the first entry whose
 * bottom is at or below the container's top — that's the "topmost visible"
 * entry. Extracted from DOM for testability. */
export function selectTopAnchor(
	containerTop: number,
	entries: ReadonlyArray<{ top: number; bottom: number; ts: number }>,
): { ts: number; offsetPx: number } | null {
	for (const e of entries) {
		if (!Number.isFinite(e.ts)) continue;
		if (e.bottom >= containerTop) {
			return { ts: e.ts, offsetPx: containerTop - e.top };
		}
	}
	return null;
}

/** Pure at-bottom predicate. */
export function atBottomPure(
	scrollHeight: number,
	scrollTop: number,
	clientHeight: number,
): boolean {
	return scrollHeight - scrollTop - clientHeight < BOTTOM_THRESHOLD_PX;
}

/**
 * Find the log entry currently at the top of the viewport. Returns null if
 * no entry element is in view (empty log).
 */
function findTopAnchor(
	container: HTMLElement,
): { ts: number; offsetPx: number } | null {
	const containerRect = container.getBoundingClientRect();
	const entries = container.querySelectorAll<HTMLElement>("[data-entry-ts]");
	const rects: Array<{ top: number; bottom: number; ts: number }> = [];
	for (const el of entries) {
		const rect = el.getBoundingClientRect();
		rects.push({
			top: rect.top,
			bottom: rect.bottom,
			ts: Number(el.dataset.entryTs),
		});
	}
	return selectTopAnchor(containerRect.top, rects);
}

/** True if the container is scrolled to (within threshold of) the bottom. */
function isAtBottom(container: HTMLElement): boolean {
	return atBottomPure(
		container.scrollHeight,
		container.scrollTop,
		container.clientHeight,
	);
}

/**
 * Apply a target to the scroll container. Idempotent.
 * Returns true if the target was applied, false if the anchor couldn't be
 * resolved (entry not in DOM yet).
 */
export function applyScrollTarget(
	container: HTMLElement,
	target: ScrollTarget,
): boolean {
	if (target.kind === "follow") {
		container.scrollTop = container.scrollHeight;
		return true;
	}
	// anchored
	const el = container.querySelector<HTMLElement>(
		`[data-entry-ts="${target.ts}"]`,
	);
	if (!el) return false;
	// offsetTop is relative to offsetParent. Since the container has
	// overflow-y:auto, offsetTop of children is relative to the container.
	container.scrollTop = el.offsetTop - target.offsetPx;
	return true;
}

/**
 * Hook returning per-task scroll target state. One target active at a time
 * (keyed by taskId). Persists to localStorage.
 *
 * Usage:
 *   const { target, setTarget, containerRef } = useScrollTarget(taskId);
 *   <div ref={containerRef} onScroll={onScroll}>…</div>
 *
 * The ActivityLog component calls:
 * - `onScrollEvent(container)` from its scroll handler (debounced) to update
 *   the target based on current viewport.
 * - `applyTarget()` after renders to restore scroll position.
 *
 * The host (App) calls `setFollow()` from the follow button.
 */
export function useScrollTarget(taskId: string | null) {
	const [target, setTargetState] = useState<ScrollTarget>(() =>
		taskId ? loadTarget(taskId) : { kind: "follow" },
	);
	// Track the taskId this target belongs to — so we don't persist a target
	// to the wrong task during transitions.
	const targetTaskIdRef = useRef<string | null>(taskId);

	// Load new task's target when taskId changes
	useEffect(() => {
		targetTaskIdRef.current = taskId;
		if (taskId) {
			setTargetState(loadTarget(taskId));
		} else {
			setTargetState({ kind: "follow" });
		}
	}, [taskId]);

	const setTarget = useCallback(
		(next: ScrollTarget) => {
			setTargetState(next);
			if (taskId && targetTaskIdRef.current === taskId) {
				saveTarget(taskId, next);
			}
		},
		[taskId],
	);

	return { target, setTarget };
}

export { BOTTOM_THRESHOLD_PX, findTopAnchor, isAtBottom };
