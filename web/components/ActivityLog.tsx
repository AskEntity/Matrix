import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getLogTaskId, type LogEntry, type TaskNode } from "../hooks.ts";
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
	autoScroll,
	onAutoScrollChange,
	isActive,
	projectId,
	olderEventsAvailable,
	loadingOlderEvents,
	onLoadOlderEvents,
}: {
	entries: LogEntry[];
	filterTaskId: string | null;
	rootNodeId: string | null;
	nodeMap: Map<string, TaskNode>;
	autoScroll: boolean;
	onAutoScrollChange: (locked: boolean) => void;
	isActive: boolean;
	projectId: string;
	olderEventsAvailable?: Map<string, { hasOlder: boolean; oldestTs: number }>;
	loadingOlderEvents?: boolean;
	onLoadOlderEvents?: (sessionId: string) => void;
}) {
	const logRef = useRef<HTMLDivElement>(null);

	const [searchText, setSearchText] = useState("");
	const lastEventTimeRef = useRef(Date.now());
	const entriesRef = useRef(entries);
	entriesRef.current = entries;
	const autoScrollRef = useRef(autoScroll);
	autoScrollRef.current = autoScroll;
	const [showThinking, setShowThinking] = useState(false);

	// Lazy rendering: only render the last `renderCount` entries from `visible`.
	// Increases when user scrolls near the top (via IntersectionObserver).
	const [renderCount, setRenderCount] = useState(RENDER_BATCH);
	const sentinelRef = useRef<HTMLDivElement>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset search and render count when filter task changes
	useEffect(() => {
		setSearchText("");
		setRenderCount(RENDER_BATCH);
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
		if (el) el.scrollTop = el.scrollHeight;
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new visible entries
	useEffect(() => {
		lastEventTimeRef.current = Date.now();
		if (autoScroll) {
			requestAnimationFrame(scrollToBottom);
		}
	}, [visible.length, autoScroll, scrollToBottom]);

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
			}
		});
		observer.observe(el, {
			childList: true,
			subtree: true,
			characterData: true,
		});
		return () => observer.disconnect();
	}, [scrollToBottom]);

	const handleScroll = useCallback(() => {
		const el = logRef.current;
		if (!el) return;
		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
		// Only disable follow mode on scroll-up. Never auto-enable on scroll-to-bottom —
		// follow mode should only be activated via the explicit Follow button click.
		if (!atBottom) {
			onAutoScrollChange(false);
		}
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
						<ToolCard key={entry.id} entry={entry} nodeMap={nodeMap} />
					) : (
						<LogEntryView
							key={entry.id}
							entry={entry}
							nodeMap={nodeMap}
							projectId={projectId}
							rootNodeId={rootNodeId}
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
