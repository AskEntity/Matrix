import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LogEntry, TaskNode } from "../hooks.ts";
import { useLocale } from "../i18n.ts";
import { LogEntryView, ToolCard } from "./ToolCard.tsx";

export function ActivityLog({
	entries,
	filterTaskId,
	rootNodeId,
	nodeMap,
	autoScroll,
	onAutoScrollChange,
	running,
}: {
	entries: LogEntry[];
	filterTaskId: string | null;
	rootNodeId: string | null;
	nodeMap: Map<string, TaskNode>;
	autoScroll: boolean;
	onAutoScrollChange: (locked: boolean) => void;
	running: boolean;
}) {
	const logRef = useRef<HTMLDivElement>(null);
	const bottomRef = useRef<HTMLDivElement>(null);
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
			items = entries.filter((e) => !e.taskId || e.taskId === rootNodeId);
		} else {
			items = entries.filter((e) => e.taskId === filterTaskId);
		}

		if (searchText.trim()) {
			const lower = searchText.toLowerCase();
			items = items.filter((e) => e.text.toLowerCase().includes(lower));
		}

		return items;
	}, [entries, filterTaskId, rootNodeId, isRootFilter, searchText]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new visible entries
	useEffect(() => {
		lastEventTimeRef.current = Date.now();
		if (autoScroll) {
			requestAnimationFrame(() => {
				bottomRef.current?.scrollIntoView({
					block: "end",
					behavior: "instant",
				});
			});
		}
	}, [visible.length, autoScroll]);

	// Show "Thinking..." when agent is running but no events for 1.5s
	useEffect(() => {
		if (!running) {
			setShowThinking(false);
			return;
		}
		const id = setInterval(() => {
			const currentEntries = entriesRef.current;
			const lastEntry = currentEntries[currentEntries.length - 1];
			const hasToolInProgress = lastEntry?.type === "tool_use";
			const elapsed = Date.now() - lastEventTimeRef.current;
			setShowThinking(running && !hasToolInProgress && elapsed > 1500);
		}, 500);
		return () => clearInterval(id);
	}, [running]);

	useEffect(() => {
		const el = logRef.current;
		if (!el) return;
		const observer = new MutationObserver(() => {
			if (autoScroll) {
				requestAnimationFrame(() => {
					bottomRef.current?.scrollIntoView({
						block: "end",
						behavior: "instant",
					});
				});
			}
		});
		observer.observe(el, {
			childList: true,
			subtree: true,
			characterData: true,
		});
		return () => observer.disconnect();
	}, [autoScroll]);

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

		// Get tool name from structured field
		const getToolName = (entry: LogEntry): string => {
			return entry.toolName ?? "";
		};

		// --- ID-based pairing ---
		// Match tool_use → tool_result by toolUseId (unique per call).
		const paired = new Map<number, number>(); // useIdx → resultIdx
		const pairedResults = new Set<number>(); // result indices already consumed

		// Index tool_use entries by toolUseId for O(1) lookup
		const useByToolUseId = new Map<string, number>();
		// Indices to hide: yield pairs
		const hiddenIndices = new Set<number>();

		// First pass: register all tool_use entries by toolUseId
		for (let j = 0; j < visible.length; j++) {
			const entry = visible[j];
			if (!entry || entry.type !== "tool_use") continue;
			if (entry.toolUseId) {
				useByToolUseId.set(entry.toolUseId, j);
			}
		}

		// Second pass: match tool_result entries to tool_use entries
		for (let j = 0; j < visible.length; j++) {
			const entry = visible[j];
			if (!entry || entry.type !== "tool_result") continue;

			// Match by toolUseId
			if (entry.toolUseId) {
				const useIdx = useByToolUseId.get(entry.toolUseId);
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

			// Hide get_tree tool_use entries (noise); their tool_results still show
			if (cur.type === "tool_use") {
				const name = getToolName(cur);
				if (name === "mcp__opengraft__get_tree") {
					i += 1;
					continue;
				}

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
						/>
					),
				)}
				{running && (
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
				<div ref={bottomRef} />
			</div>
		</>
	);
}
