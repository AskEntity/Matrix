import {
	memo,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { getLogTaskId, type LogEntry, type TreeNode } from "../hooks.ts";
import { useLocale } from "../i18n.ts";
import { quoteButtonPosition, selectionQuoteText } from "../quote.ts";
import { isNearBottom } from "../scroll.ts";
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
			return base;
		default:
			return base;
	}
}

export const ActivityLog = memo(function ActivityLog({
	entries,
	filterTaskId,
	rootNodeId,
	nodeMap,
	autoScroll,
	onAutoScrollChange,
	onAtBottomChange,
	isActive,
	projectId,
	olderEventsAvailable,
	loadingOlderEvents,
	onLoadOlderEvents,
	onTaskNavigate,
	projectMap,
	onProjectNavigate,
	showCacheBadges,
	onQuoteText,
	onRollback,
	onEdit,
}: {
	entries: LogEntry[];
	filterTaskId: string | null;
	rootNodeId: string | null;
	nodeMap: Map<string, TreeNode>;
	autoScroll: boolean;
	onAutoScrollChange: (locked: boolean) => void;
	/**
	 * Reports whether the log is scrolled near its bottom (isNearBottom).
	 * Drives the scroll-to-bottom button's visibility in the panel header.
	 * Fired on scroll, on content growth, and after auto-follow scrolls.
	 */
	onAtBottomChange?: (atBottom: boolean) => void;
	isActive: boolean;
	projectId: string;
	olderEventsAvailable?: Map<string, { hasOlder: boolean; oldestTs: number }>;
	loadingOlderEvents?: boolean;
	onLoadOlderEvents?: (sessionId: string) => void;
	onTaskNavigate?: (taskId: string, entryId?: string) => void;
	projectMap?: Map<string, string>;
	onProjectNavigate?: (projectId: string) => void;
	showCacheBadges?: boolean;
	/** Select-to-quote: called with the selected log text when the user clicks "Ask Matrix". */
	onQuoteText?: (text: string) => void;
	/** Rollback handler: called with the eid of a user message to roll back to. */
	onRollback?: (eid: string) => void;
	/** Edit handler: called with the eid + content of a user message to edit. */
	onEdit?: (eid: string, content: string) => void;
}) {
	const logRef = useRef<HTMLDivElement>(null);

	const [searchText, setSearchText] = useState("");
	const lastEventTimeRef = useRef(Date.now());
	const entriesRef = useRef(entries);
	entriesRef.current = entries;
	const autoScrollRef = useRef(autoScroll);
	autoScrollRef.current = autoScroll;
	// Ref-mirrored so scrollToBottom / observers don't need it in their deps
	// (an unstable parent callback must not churn the MutationObserver).
	const onAtBottomChangeRef = useRef(onAtBottomChange);
	onAtBottomChangeRef.current = onAtBottomChange;
	const [showThinking, setShowThinking] = useState(false);

	// ── Load-earlier scroll anchor ────────────────────────────────────────
	// Bottom-relative distance captured before the load starts. After the
	// fetch completes and React commits the new entries, useLayoutEffect
	// restores scrollTop so the user stays at the same content.
	const scrollAnchorRef = useRef<number | null>(null);
	const prevLoadingOlderRef = useRef(!!loadingOlderEvents);

	// Select-to-quote: floating "Ask Matrix" button near the current selection.
	// Set on mouseup with a valid selection inside the log container; dismissed
	// on selection collapse, Escape, container scroll, or after clicking.
	const [selectionAction, setSelectionAction] = useState<{
		left: number;
		top: number;
		text: string;
	} | null>(null);

	useEffect(() => {
		if (!onQuoteText) return;

		const handleMouseUp = () => {
			const container = logRef.current;
			if (!container) return;
			const sel = window.getSelection();
			const text = selectionQuoteText(sel, container);
			if (!text || !sel || sel.rangeCount === 0) {
				setSelectionAction(null);
				return;
			}
			const rect = sel.getRangeAt(0).getBoundingClientRect();
			const pos = quoteButtonPosition(rect, {
				width: window.innerWidth,
				height: window.innerHeight,
			});
			setSelectionAction({ ...pos, text });
		};

		// Dismiss when the selection collapses/clears (click elsewhere, new
		// selection outside, programmatic clear). Showing is mouseup-only.
		const handleSelectionChange = () => {
			const sel = window.getSelection();
			if (!sel || sel.isCollapsed || !sel.toString().trim()) {
				setSelectionAction(null);
			}
		};

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") setSelectionAction(null);
		};

		document.addEventListener("mouseup", handleMouseUp);
		document.addEventListener("selectionchange", handleSelectionChange);
		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("mouseup", handleMouseUp);
			document.removeEventListener("selectionchange", handleSelectionChange);
			document.removeEventListener("keydown", handleKeyDown);
		};
	}, [onQuoteText]);

	const handleQuoteClick = useCallback(() => {
		if (!selectionAction || !onQuoteText) return;
		onQuoteText(selectionAction.text);
		setSelectionAction(null);
		window.getSelection()?.removeAllRanges();
	}, [selectionAction, onQuoteText]);

	// Lazy rendering: only render the last `renderCount` entries from `visible`.
	// Increases when user scrolls near the top (via IntersectionObserver).
	const [renderCount, setRenderCount] = useState(RENDER_BATCH);
	const sentinelRef = useRef<HTMLDivElement>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset search and render count when filter task changes
	useEffect(() => {
		setSearchText("");
		setRenderCount(RENDER_BATCH);
		setSelectionAction(null);
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

	const hasMoreAbove = !isSearching && rendered.length < visible.length;

	// Reset renderCount when search text changes
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset render count on search change
	useEffect(() => {
		setRenderCount(RENDER_BATCH);
	}, [searchText]);

	// IntersectionObserver: when the sentinel at the top becomes visible, load more entries.
	// Preserves scroll position so the user doesn't jump.
	useEffect(() => {
		const sentinel = sentinelRef.current;
		const container = logRef.current;
		if (!sentinel || !container) return;

		const observer = new IntersectionObserver(
			(ioEntries) => {
				const entry = ioEntries[0];
				if (!entry?.isIntersecting) return;

				setRenderCount((prev) => {
					// Save scroll position relative to bottom before adding entries
					const scrollBottom = container.scrollHeight - container.scrollTop;
					const next = prev + RENDER_BATCH;
					// After React renders the new entries, restore scroll position
					requestAnimationFrame(() => {
						container.scrollTop = container.scrollHeight - scrollBottom;
					});
					return next;
				});
			},
			{ root: container, rootMargin: "200px 0px 0px 0px" },
		);

		observer.observe(sentinel);
		return () => observer.disconnect();
	}, []);

	// Scroll to bottom using scrollTop instead of scrollIntoView.
	// iOS Safari propagates scrollIntoView to ancestor containers even with overflow:hidden,
	// pushing the input bar out of view.
	const scrollToBottom = useCallback(() => {
		const el = logRef.current;
		if (el) {
			el.scrollTop = el.scrollHeight;
			// scrollTop clamps to the max scroll offset, so we are at the
			// bottom by construction — report without a forced layout read.
			onAtBottomChangeRef.current?.(true);
		}
	}, []);

	// Re-evaluate the distance from the bottom and report it upward.
	// Callback identity is stable ([]) — safe in effect deps.
	const reportAtBottom = useCallback(() => {
		const el = logRef.current;
		if (el) {
			onAtBottomChangeRef.current?.(
				isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight),
			);
		}
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new visible entries
	useEffect(() => {
		lastEventTimeRef.current = Date.now();
		if (autoScroll) {
			requestAnimationFrame(scrollToBottom);
		} else {
			// New entries while the user is scrolled up: the distance from
			// the bottom grew, so the scroll-to-bottom button's visibility
			// must be re-evaluated without any scroll event.
			reportAtBottom();
		}
	}, [visible.length, autoScroll, scrollToBottom, reportAtBottom]);

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

	useEffect(() => {
		const el = logRef.current;
		if (!el) return;
		const observer = new MutationObserver(() => {
			if (autoScrollRef.current) {
				requestAnimationFrame(scrollToBottom);
			} else {
				// Finer-grained complement to the visible.length effect above:
				// catches streaming text growth (characterData) that changes
				// the scroll distance without adding an entry. Real browsers
				// only — happy-dom v20 stores MutationObserver callbacks in a
				// WeakRef (MutationObserverListener.js: `new WeakRef((record) =>
				// this.report(record))` with no strong ref), so under GC
				// pressure delivery silently stops; tests cover the effect
				// path instead.
				reportAtBottom();
			}
		});
		observer.observe(el, {
			childList: true,
			subtree: true,
			characterData: true,
		});
		return () => observer.disconnect();
	}, [scrollToBottom, reportAtBottom]);

	const handleScroll = useCallback(() => {
		const el = logRef.current;
		if (!el) return;
		const atBottom = isNearBottom(
			el.scrollTop,
			el.scrollHeight,
			el.clientHeight,
		);
		onAutoScrollChange(atBottom);
		onAtBottomChangeRef.current?.(atBottom);
		// The quote button is fixed-positioned; scrolling moves the selected
		// text away from it. Dismiss instead of tracking.
		setSelectionAction(null);
	}, [onAutoScrollChange]);

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
			// Capture bottom-relative scroll position BEFORE the async load
			// starts. After the fetch completes and entries rebuild, the
			// useLayoutEffect below restores this anchor so the user stays
			// at the same content (older events appear above, out of view).
			const el = logRef.current;
			if (el) {
				scrollAnchorRef.current = el.scrollHeight - el.scrollTop;
			}
			onLoadOlderEvents(olderSessionId);
		}
	}, [olderSessionId, onLoadOlderEvents]);

	// Restore scroll position after load-older completes.
	// useLayoutEffect runs after DOM mutation but BEFORE paint — no visual jump.
	// Trigger: loadingOlderEvents transitions true → false (entries already
	// committed by React in this same render, thanks to React 18 batching).
	// biome-ignore lint/correctness/useExhaustiveDependencies: entries in deps ensures the effect fires when entries change in the same render as loadingOlderEvents
	useLayoutEffect(() => {
		const wasLoading = prevLoadingOlderRef.current;
		prevLoadingOlderRef.current = !!loadingOlderEvents;

		if (wasLoading && !loadingOlderEvents && scrollAnchorRef.current !== null) {
			const el = logRef.current;
			if (el) {
				el.scrollTop = el.scrollHeight - scrollAnchorRef.current;
			}
			scrollAnchorRef.current = null;
		}
	}, [loadingOlderEvents, entries]);

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
							onRollback={onRollback}
							onEdit={onEdit}
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
			{selectionAction && onQuoteText && (
				<button
					type="button"
					className="mxd-selection-quote-btn"
					style={{ left: selectionAction.left, top: selectionAction.top }}
					// preventDefault so pressing the button doesn't collapse the
					// selection (which would dismiss this button before click fires)
					onMouseDown={(e) => e.preventDefault()}
					onClick={handleQuoteClick}
				>
					<span className="mxd-selection-quote-glyph" aria-hidden="true">
						❝
					</span>
					{t("activity.askMatrix")}
				</button>
			)}
		</>
	);
});
