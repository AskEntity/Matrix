import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	applyScrollTarget,
	findTopAnchor,
	isAtBottom,
	type ScrollTarget,
} from "../hooks/useScrollTarget.ts";
import { getLogTaskId, type LogEntry, type TreeNode } from "../hooks.ts";
import { useLocale } from "../i18n.ts";
import { LogEntryView, ToolCard } from "./ToolCard.tsx";
import { getEntryText } from "./tools/utils.ts";

/** How many entries to render per batch */
const RENDER_BATCH = 50;

/** Get searchable text content from a LogEntry. Uses getEntryText as base, adds extra searchable fields. */
function getSearchableText(entry: LogEntry): string {
	const base = getEntryText(entry);
	// Add extra searchable context for specific types
	switch (entry.type) {
		case "tool_pair":
			// Include tool name in search (getEntryText only returns resultContent)
			return `${entry.tool} ${base}`;
		case "compact_marker":
			// Include checkpoint text in search
			return `${base} ${entry.checkpoint}`;
		default:
			return base;
	}
}

export const ActivityLog = memo(function ActivityLog({
	entries,
	filterTaskId,
	rootNodeId,
	nodeMap,
	target,
	onTargetChange,
	pendingJumpEntryId,
	onJumpConsumed,
	isActive,
	projectId,
	olderEventsAvailable,
	loadingOlderEvents,
	onLoadOlderEvents,
	onTaskNavigate,
	projectMap,
	onProjectNavigate,
	showCacheBadges,
}: {
	entries: LogEntry[];
	filterTaskId: string | null;
	rootNodeId: string | null;
	nodeMap: Map<string, TreeNode>;
	/** Single source of truth for scroll position. */
	target: ScrollTarget;
	/** Update target (called when user scrolls). */
	onTargetChange: (t: ScrollTarget) => void;
	/** In-session entry id to jump to (one-shot). */
	pendingJumpEntryId?: string | null;
	/** Called after the pending jump has been applied (or given up). */
	onJumpConsumed?: () => void;
	isActive: boolean;
	projectId: string;
	olderEventsAvailable?: Map<string, { hasOlder: boolean; oldestTs: number }>;
	loadingOlderEvents?: boolean;
	onLoadOlderEvents?: (sessionId: string) => void;
	onTaskNavigate?: (taskId: string, entryId?: string) => void;
	projectMap?: Map<string, string>;
	onProjectNavigate?: (projectId: string) => void;
	showCacheBadges?: boolean;
}) {
	const logRef = useRef<HTMLDivElement>(null);

	const [searchText, setSearchText] = useState("");
	const lastEventTimeRef = useRef(Date.now());
	const entriesRef = useRef(entries);
	entriesRef.current = entries;
	const targetRef = useRef(target);
	targetRef.current = target;
	/** True while we're writing scrollTop programmatically — suppresses
	 * the scroll event's target-update logic to prevent jitter. */
	const programmaticScrollRef = useRef(false);
	const onTargetChangeRef = useRef(onTargetChange);
	onTargetChangeRef.current = onTargetChange;
	const [showThinking, setShowThinking] = useState(false);

	// Lazy rendering: only render the last `renderCount` entries from `visible`.
	// Increases when user scrolls near the top (via IntersectionObserver).
	const [renderCount, setRenderCount] = useState(RENDER_BATCH);
	const sentinelRef = useRef<HTMLDivElement>(null);
	/** Tracks `visible.length` across renders so we can grow renderCount by
	 * the delta when new entries arrive (bug 2 fix). */
	const prevVisibleLenRef = useRef(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset search and render count when filter task changes
	useEffect(() => {
		setSearchText("");
		setRenderCount(RENDER_BATCH);
		// Reset window tracker so the "visible grew" effect doesn't add a
		// huge delta when switching to a task with more history.
		prevVisibleLenRef.current = 0;
	}, [filterTaskId]);

	const isRootFilter = !filterTaskId || filterTaskId === rootNodeId;
	const visible = useMemo(() => {
		let items: LogEntry[];
		if (isRootFilter) {
			// Root/orchestrator view — show entries tagged with root node OR untagged (backward compat)
			items = entries.filter((e) => {
				const tid = getLogTaskId(e);
				return !tid || tid === rootNodeId;
			});
		} else {
			items = entries.filter((e) => getLogTaskId(e) === filterTaskId);
		}

		if (searchText.trim()) {
			const lower = searchText.toLowerCase();
			items = items.filter((e) =>
				getSearchableText(e).toLowerCase().includes(lower),
			);
		}

		return items;
	}, [entries, filterTaskId, rootNodeId, isRootFilter, searchText]);

	// When searching, render all results. Otherwise, render the last `renderCount`.
	const isSearching = searchText.trim().length > 0;
	const rendered = useMemo(() => {
		if (isSearching) return visible;
		if (renderCount >= visible.length) return visible;
		return visible.slice(visible.length - renderCount);
	}, [visible, renderCount, isSearching]);

	// Bug 2 fix: prevent the sliding window from evicting entries the user is
	// currently reading. When new entries arrive (visible.length grows), grow
	// renderCount by the same amount so the oldest rendered index stays put.
	// Only the user's upward-scroll (sentinel IntersectionObserver) ever
	// shifts the floor backwards.
	useEffect(() => {
		const prev = prevVisibleLenRef.current;
		const curr = visible.length;
		if (curr > prev) {
			setRenderCount((rc) => rc + (curr - prev));
		}
		prevVisibleLenRef.current = curr;
	}, [visible.length]);

	const hasMoreAbove = !isSearching && rendered.length < visible.length;

	// Reset renderCount when search text changes
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset render count on search change
	useEffect(() => {
		setRenderCount(RENDER_BATCH);
	}, [searchText]);

	// IntersectionObserver: when the sentinel at the top becomes visible, load
	// more entries. Scroll position is preserved by the target-restoration
	// effect — when the anchored target is re-applied after the render, the
	// anchor entry is still in DOM so the viewport stays put.
	useEffect(() => {
		const sentinel = sentinelRef.current;
		const container = logRef.current;
		if (!sentinel || !container) return;

		const observer = new IntersectionObserver(
			(ioEntries) => {
				const entry = ioEntries[0];
				if (!entry?.isIntersecting) return;
				setRenderCount((prev) => prev + RENDER_BATCH);
			},
			{ root: container, rootMargin: "200px 0px 0px 0px" },
		);

		observer.observe(sentinel);
		return () => observer.disconnect();
	}, []);

	/** Re-apply the current target to the container. Marks the scroll as
	 * programmatic so handleScroll ignores the resulting scroll event. */
	const reapplyTarget = useCallback(() => {
		const el = logRef.current;
		if (!el) return;
		programmaticScrollRef.current = true;
		applyScrollTarget(el, targetRef.current);
		// Clear the flag after the scroll event has fired. rAF is enough —
		// scroll events are dispatched synchronously after scrollTop assignment.
		requestAnimationFrame(() => {
			programmaticScrollRef.current = false;
		});
	}, []);

	// Re-apply target when content arrives (follow mode pins to bottom,
	// anchored mode re-positions to keep the anchored entry in place).
	// biome-ignore lint/correctness/useExhaustiveDependencies: content grows via visible.length + rendered.length
	useEffect(() => {
		lastEventTimeRef.current = Date.now();
		requestAnimationFrame(reapplyTarget);
	}, [visible.length, rendered.length, reapplyTarget]);

	// Re-apply target when target itself changes (follow button click,
	// tab switch, link jump). Schedule after render to pick up new DOM.
	// If the anchored target references an entry outside the rendered
	// window, bump renderCount so it gets rendered — otherwise the
	// querySelector inside applyScrollTarget would fail silently.
	// biome-ignore lint/correctness/useExhaustiveDependencies: target is the trigger; reapplyTarget reads targetRef.current
	useEffect(() => {
		if (target.kind === "anchored") {
			const idx = visible.findIndex((e) => e.ts === target.ts);
			if (idx >= 0) {
				const needed = visible.length - idx;
				setRenderCount((rc) => (rc < needed ? needed : rc));
			}
		}
		requestAnimationFrame(reapplyTarget);
	}, [target]);

	// One-shot jump-to-entry by session-local entry id (e.g. clicking a
	// message link). Finds the entry in the visible list, ensures it's in
	// the rendered window, scrolls it into view, and adds the highlight
	// class. Uses data-entry-id (not data-entry-ts) because the caller
	// passed a session-local id.
	// biome-ignore lint/correctness/useExhaustiveDependencies: jump effect depends only on pendingJumpEntryId
	useEffect(() => {
		if (!pendingJumpEntryId) return;
		// Make sure the entry is in the rendered window. Find its index in
		// `visible` and bump renderCount so it's included.
		const idNum = Number(pendingJumpEntryId);
		if (Number.isFinite(idNum)) {
			const idx = visible.findIndex((e) => e.id === idNum);
			if (idx >= 0) {
				const needed = visible.length - idx;
				setRenderCount((rc) => (rc < needed ? needed : rc));
			}
		}
		// Retry the scroll for a few frames so we don't race the render
		// commit — especially when setRenderCount was called above.
		let cancelled = false;
		let rafHandle = 0;
		let attempts = 0;
		const MAX_ATTEMPTS = 20;
		const tryScroll = () => {
			if (cancelled) return;
			const container = logRef.current;
			if (!container) return;
			const el = container.querySelector<HTMLElement>(
				`[data-entry-id="${CSS.escape(pendingJumpEntryId)}"]`,
			);
			if (!el) {
				if (attempts++ < MAX_ATTEMPTS) {
					rafHandle = requestAnimationFrame(tryScroll);
					return;
				}
				// Give up quietly — entry not in DOM (likely not yet fetched)
				onJumpConsumed?.();
				return;
			}
			programmaticScrollRef.current = true;
			// Center the element in the container's viewport
			const containerRect = container.getBoundingClientRect();
			const rect = el.getBoundingClientRect();
			const center = containerRect.height / 2 - rect.height / 2;
			container.scrollTop = el.offsetTop - center;
			el.classList.add("mxd-scroll-target");
			setTimeout(() => el.classList.remove("mxd-scroll-target"), 2000);
			requestAnimationFrame(() => {
				programmaticScrollRef.current = false;
			});
			// Update target to anchor on the jumped entry so subsequent
			// content additions don't drift the view.
			const tsAttr = el.dataset.entryTs;
			const ts = tsAttr ? Number(tsAttr) : Number.NaN;
			if (Number.isFinite(ts)) {
				const newContainerRect = container.getBoundingClientRect();
				const newRect = el.getBoundingClientRect();
				onTargetChangeRef.current({
					kind: "anchored",
					ts,
					offsetPx: newContainerRect.top - newRect.top,
				});
			}
			onJumpConsumed?.();
		};
		rafHandle = requestAnimationFrame(tryScroll);
		return () => {
			cancelled = true;
			cancelAnimationFrame(rafHandle);
		};
	}, [pendingJumpEntryId]);

	// Show "Thinking..." when agent is active but no events for 1.5s
	useEffect(() => {
		if (!isActive) {
			setShowThinking(false);
			return;
		}
		const id = setInterval(() => {
			const currentEntries = entriesRef.current;
			const lastEntry = currentEntries[currentEntries.length - 1];
			const hasToolInProgress = lastEntry?.type === "tool_call";
			const elapsed = Date.now() - lastEventTimeRef.current;
			setShowThinking(isActive && !hasToolInProgress && elapsed > 1500);
		}, 500);
		return () => clearInterval(id);
	}, [isActive]);

	// MutationObserver: content mutations (streaming text_delta, subtree
	// re-renders) may change heights. Re-apply target to stay pinned.
	useEffect(() => {
		const el = logRef.current;
		if (!el) return;
		const observer = new MutationObserver(() => {
			requestAnimationFrame(reapplyTarget);
		});
		observer.observe(el, {
			childList: true,
			subtree: true,
			characterData: true,
		});
		return () => observer.disconnect();
	}, [reapplyTarget]);

	/** Scroll event handler: update target based on where the user scrolled.
	 * Ignored during programmatic scrolls (prevents jitter).
	 *
	 * User scrolling NEVER activates follow mode — follow is a deliberate
	 * mode you opt into via the Follow button (or initial tab-open).
	 * Scrolling away always switches to an anchored target; scrolling to
	 * the bottom gives you a bottom-most anchor but does NOT auto-follow
	 * new content. */
	const handleScroll = useCallback(() => {
		if (programmaticScrollRef.current) return;
		const el = logRef.current;
		if (!el) return;
		if (isAtBottom(el)) {
			// If already in follow mode (e.g. user just clicked Follow),
			// keep it. Otherwise leave target as anchored.
			if (targetRef.current.kind === "follow") return;
		}
		const anchor = findTopAnchor(el);
		if (!anchor) return;
		// Only update if the anchor has meaningfully changed
		const curr = targetRef.current;
		if (
			curr.kind === "anchored" &&
			curr.ts === anchor.ts &&
			Math.abs(curr.offsetPx - anchor.offsetPx) < 4
		) {
			return;
		}
		onTargetChangeRef.current({ kind: "anchored", ...anchor });
	}, []);

	// Determine if "Load earlier history" should be shown for the current view
	const olderSessionId = useMemo(() => {
		if (!olderEventsAvailable || olderEventsAvailable.size === 0) return null;
		if (filterTaskId && filterTaskId !== rootNodeId) {
			// Task-specific view: check if that specific session has older events
			return olderEventsAvailable.has(filterTaskId) ? filterTaskId : null;
		}
		// Root/orchestrator view: check if root session has older events
		if (rootNodeId && olderEventsAvailable.has(rootNodeId)) return rootNodeId;
		// Or any session with older events
		const first = olderEventsAvailable.keys().next();
		return first.done ? null : first.value;
	}, [olderEventsAvailable, filterTaskId, rootNodeId]);

	const handleLoadOlder = useCallback(() => {
		if (olderSessionId && onLoadOlderEvents) {
			onLoadOlderEvents(olderSessionId);
		}
	}, [olderSessionId, onLoadOlderEvents]);

	const { t } = useLocale();

	return (
		<>
			<div className="mxd-lmxd-search-bar">
				<input
					type="text"
					className="mxd-lmxd-search"
					placeholder={t("activity.searchLogs")}
					value={searchText}
					onChange={(e) => setSearchText(e.target.value)}
				/>
			</div>
			<div className="mxd-activity-log" ref={logRef} onScroll={handleScroll}>
				{olderSessionId && (
					<div className="mxd-load-older-bar">
						<button
							type="button"
							className="mxd-load-older-btn"
							onClick={handleLoadOlder}
							disabled={loadingOlderEvents}
						>
							{loadingOlderEvents ? "Loading…" : "↑ Load earlier history"}
						</button>
					</div>
				)}
				{/* Sentinel for IntersectionObserver — triggers loading more entries when scrolled near top */}
				<div ref={sentinelRef} className="mxd-lazy-sentinel" />
				{hasMoreAbove && (
					<div className="mxd-lazy-more-indicator">
						{visible.length - rendered.length} earlier entries
					</div>
				)}
				{rendered.map((entry) =>
					entry.type === "tool_pair" ? (
						<ToolCard
							key={entry.id}
							entry={entry}
							nodeMap={nodeMap}
							onTaskNavigate={onTaskNavigate}
							projectMap={projectMap}
							onProjectNavigate={onProjectNavigate}
						/>
					) : (
						<LogEntryView
							key={entry.id}
							entry={entry}
							nodeMap={nodeMap}
							projectId={projectId}
							rootNodeId={rootNodeId}
							onTaskNavigate={onTaskNavigate}
							onProjectNavigate={onProjectNavigate}
							showCacheBadges={showCacheBadges}
						/>
					),
				)}
				{isActive && (
					<div
						className="mxd-thinking-indicator"
						style={{ visibility: showThinking ? "visible" : "hidden" }}
					>
						<span className="mxd-thinking-dots">
							Thinking
							<span className="mxd-dots-anim">...</span>
						</span>
					</div>
				)}
				{visible.length === 0 && !showThinking && (
					<div
						style={{
							padding: "32px 20px",
							textAlign: "center",
							color: "var(--text-faint)",
							fontSize: "12px",
							fontFamily: "var(--font-mono)",
						}}
					>
						{searchText.trim() ? t("activity.noMatch") : t("activity.noEvents")}
					</div>
				)}
			</div>
		</>
	);
});
