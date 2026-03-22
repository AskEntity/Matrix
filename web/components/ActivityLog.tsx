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
		case "error":
			return entry.message;
		case "message":
			return entry.body.content ?? "";
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
		case "tree_mutation":
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
}: {
	entries: LogEntry[];
	filterTaskId: string | null;
	rootNodeId: string | null;
	nodeMap: Map<string, TaskNode>;
	autoScroll: boolean;
	onAutoScrollChange: (locked: boolean) => void;
	isActive: boolean;
	projectId: string;
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

	const { t } = useLocale();

	// Merge tool_use + tool_result into combined entries for rendering.
	// Pairs tool_use → tool_result by unique toolUseId.
	const mergedVisible = useMemo(() => {
		const result: Array<
			| { kind: "single"; entry: LogEntry }
			| {
					kind: "tool_card";
					useEntry: LogEntry;
					resultEntry: LogEntry;
			  }
		> = [];

		// Get tool name from typed entry (handles both Event and BroadcastEvent variants)
		const getToolName = (entry: LogEntry): string => {
			if (entry.type === "tool_call" || entry.type === "tool_result") {
				return "tool" in entry ? (entry.tool as string) : "";
			}
			return "";
		};

		// --- ID-based pairing ---
		// Match tool_use → tool_result by toolUseId (unique per call).
		const paired = new Map<number, number>(); // useIdx → resultIdx
		const pairedResults = new Set<number>(); // result indices already consumed

		// Index tool_use entries by toolUseId for O(1) lookup
		const useByToolUseId = new Map<string, number>();
		// Indices to hide: yield pairs
		const hiddenIndices = new Set<number>();

		// Get tool call ID from entry (unified: toolCallId)
		const getToolUseId = (entry: LogEntry): string | undefined => {
			if ("toolCallId" in entry) return entry.toolCallId as string;
			// Backward compat for old cached entries
			if ("toolUseId" in entry) return entry.toolUseId as string;
			return undefined;
		};

		// First pass: register all tool_call entries by toolUseId
		for (let j = 0; j < visible.length; j++) {
			const entry = visible[j];
			if (!entry || entry.type !== "tool_call") continue;
			const uid = getToolUseId(entry);
			if (uid) {
				useByToolUseId.set(uid, j);
			}
		}

		// Second pass: match tool_result entries to tool_call entries
		for (let j = 0; j < visible.length; j++) {
			const entry = visible[j];
			if (!entry || entry.type !== "tool_result") continue;

			// Match by toolUseId/toolCallId
			const uid = getToolUseId(entry);
			if (uid) {
				const useIdx = useByToolUseId.get(uid);
				if (useIdx !== undefined) {
					paired.set(useIdx, j);
					pairedResults.add(j);
				}
			}
		}

		// Pre-scan: hide completed yield pairs.
		// Only an unmatched yield tool_use at the end (agent waiting) stays visible.
		for (const [useIdx, resultIdx] of paired) {
			const entry = visible[useIdx];
			if (entry && getToolName(entry) === "mcp__opengraft__yield") {
				hiddenIndices.add(useIdx);
				hiddenIndices.add(resultIdx);
			}
		}

		let i = 0;
		while (i < visible.length) {
			const cur = visible[i];
			if (!cur) {
				i += 1;
				continue;
			}

			// Skip hidden entries (yield pairs, consumed results)
			if (hiddenIndices.has(i) || pairedResults.has(i)) {
				i += 1;
				continue;
			}

			if (cur.type === "tool_call") {
				// Check for a paired tool_result
				const resultIdx = paired.get(i);
				const resultEntry =
					resultIdx !== undefined ? visible[resultIdx] : undefined;
				if (resultEntry) {
					result.push({
						kind: "tool_card",
						useEntry: cur,
						resultEntry,
					});
					i += 1;
					continue;
				}
			}

			result.push({ kind: "single", entry: cur });
			i += 1;
		}

		return result;
	}, [visible]);

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
				{mergedVisible.map((item) =>
					item.kind === "tool_card" ? (
						<ToolCard
							key={item.useEntry.id}
							useEntry={item.useEntry}
							resultEntry={item.resultEntry}
							nodeMap={nodeMap}
						/>
					) : (
						<LogEntryView
							key={item.entry.id}
							entry={item.entry}
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
				{mergedVisible.length === 0 && !showThinking && (
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
