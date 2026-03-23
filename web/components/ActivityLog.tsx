import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getLogTaskId, type LogEntry, type TaskNode } from "../hooks.ts";
import { useLocale } from "../i18n.ts";
import { LogEntryView, ToolCard } from "./ToolCard.tsx";

/** Get searchable text content from a LogEntry. */
function getSearchableText(entry: LogEntry): string {
	switch (entry.type) {
		case "assistant_text":
		case "text_delta":
			return entry.content.trimStart();
		case "tool_call":
			return entry.tool;
		case "tool_result":
			return entry.content;
		case "tool_pair":
			return `${entry.tool} ${entry.resultContent}`;
		case "error":
			return entry.message;
		case "message":
			return entry.body.source === "user" ? entry.body.content : "";
		case "lifecycle":
		case "parent_update":
		case "child_report":
		case "cross_project":
			return entry.content ?? "";
		case "background_complete":
			return entry.command;
		case "task_started":
		case "task_completed":
		case "budget_exceeded":
			return entry.title;
		case "tree_change":
			return entry.title ?? entry.action;
		case "compact_marker":
			return entry.checkpoint;
		case "compact_started":
			return "Compacting context...";
		case "clarification_requested":
			return entry.title ?? entry.question;
		case "clarification_answered":
			return entry.answer;
		default:
			return "";
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
	const [showThinking, setShowThinking] = useState(false);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset search when filter task changes
	useEffect(() => {
		setSearchText("");
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
			if (autoScroll) {
				requestAnimationFrame(scrollToBottom);
			}
		});
		observer.observe(el, {
			childList: true,
			subtree: true,
			characterData: true,
		});
		return () => observer.disconnect();
	}, [autoScroll, scrollToBottom]);

	const handleScroll = useCallback(() => {
		const el = logRef.current;
		if (!el) return;
		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
		onAutoScrollChange(atBottom);
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
			<div className="og-log-search-bar">
				<input
					type="text"
					className="og-log-search"
					placeholder={t("activity.searchLogs")}
					value={searchText}
					onChange={(e) => setSearchText(e.target.value)}
				/>
			</div>
			<div className="og-activity-log" ref={logRef} onScroll={handleScroll}>
				{olderSessionId && (
					<div className="og-load-older-bar">
						<button
							type="button"
							className="og-load-older-btn"
							onClick={handleLoadOlder}
							disabled={loadingOlderEvents}
						>
							{loadingOlderEvents ? "Loading…" : "↑ Load earlier history"}
						</button>
					</div>
				)}
				{visible.map((entry) =>
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
						className="og-thinking-indicator"
						style={{ visibility: showThinking ? "visible" : "hidden" }}
					>
						<span className="og-thinking-dots">
							Thinking
							<span className="og-dots-anim">...</span>
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
