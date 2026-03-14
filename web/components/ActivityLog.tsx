import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LogEntry, TaskNode } from "../hooks.ts";
import { useLocale } from "../i18n.ts";
import { PROJECT_NODE_ID } from "../types.ts";
import { LogEntryView, ToolCard } from "./ToolCard.tsx";

export function ActivityLog({
	entries,
	filterTaskId,
	nodeMap,
	autoScroll,
	onAutoScrollChange,
	running,
}: {
	entries: LogEntry[];
	filterTaskId: string | null;
	nodeMap: Map<string, TaskNode>;
	autoScroll: boolean;
	onAutoScrollChange: (locked: boolean) => void;
	running: boolean;
}) {
	const logRef = useRef<HTMLDivElement>(null);
	const [searchText, setSearchText] = useState("");
	const lastEventTimeRef = useRef(Date.now());
	const [showThinking, setShowThinking] = useState(false);

	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new entries
	useEffect(() => {
		lastEventTimeRef.current = Date.now();
		if (autoScroll && logRef.current) {
			requestAnimationFrame(() => {
				if (logRef.current) {
					logRef.current.scrollTop = logRef.current.scrollHeight;
				}
			});
		}
	}, [entries.length, autoScroll]);

	// Show "Thinking..." when agent is running but no events for 1.5s
	useEffect(() => {
		if (!running) {
			setShowThinking(false);
			return;
		}
		const id = setInterval(() => {
			setShowThinking(running && Date.now() - lastEventTimeRef.current > 1500);
		}, 500);
		return () => clearInterval(id);
	}, [running]);

	useEffect(() => {
		const el = logRef.current;
		if (!el) return;
		const observer = new ResizeObserver(() => {
			if (autoScroll) {
				requestAnimationFrame(() => {
					if (logRef.current) {
						logRef.current.scrollTop = logRef.current.scrollHeight;
					}
				});
			}
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [autoScroll]);

	const handleScroll = useCallback(() => {
		const el = logRef.current;
		if (!el) return;
		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
		onAutoScrollChange(atBottom);
	}, [onAutoScrollChange]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset search when filter task changes
	useEffect(() => {
		setSearchText("");
	}, [filterTaskId]);

	const visible = useMemo(() => {
		let items: LogEntry[];
		if (!filterTaskId || filterTaskId === PROJECT_NODE_ID) {
			items = entries.filter((e) => !e.taskId);
		} else {
			const descendantIds = new Set<string>();
			const collect = (id: string) => {
				descendantIds.add(id);
				const node = nodeMap.get(id);
				if (node?.children) {
					for (const childId of node.children) collect(childId);
				}
			};
			collect(filterTaskId);
			items = entries.filter((e) => e.taskId && descendantIds.has(e.taskId));
		}

		if (searchText.trim()) {
			const lower = searchText.toLowerCase();
			items = items.filter((e) => e.text.toLowerCase().includes(lower));
		}

		return items;
	}, [entries, filterTaskId, nodeMap, searchText]);

	const { t } = useLocale();

	// Merge tool_use + tool_result into combined entries for rendering.
	// Uses structured toolName field when available, falls back to text parsing.
	// Handles parallel tool calls (A_use, B_use, A_result, B_result) by scanning
	// ahead to find matching tool_result by toolName.
	const mergedVisible = useMemo(() => {
		const result: Array<
			| { kind: "single"; entry: LogEntry }
			| {
					kind: "tool_card";
					useEntry: LogEntry;
					resultEntry: LogEntry;
			  }
		> = [];

		// Get effective tool name from an entry (structured field or text parsing)
		const getToolName = (entry: LogEntry): string => {
			if (entry.toolName) return entry.toolName;
			if (entry.type === "tool_use") return entry.text.split("(")[0] ?? "";
			if (entry.type === "tool_result") {
				const m = /^(?:OK|ERR) ([^:]+):/.exec(entry.text);
				return m?.[1] ?? "";
			}
			return "";
		};

		// Track which tool_result indices have been consumed by pairing
		const consumedResults = new Set<number>();

		// For each tool_use, scan ahead to find its matching tool_result
		const findMatchingResult = (
			useIdx: number,
			name: string,
			taskId: string | undefined,
		): number => {
			for (let j = useIdx + 1; j < visible.length; j++) {
				const candidate = visible[j];
				if (!candidate || candidate.type !== "tool_result") continue;
				if (candidate.taskId !== taskId) continue;
				if (consumedResults.has(j)) continue;
				if (getToolName(candidate) === name) return j;
			}
			return -1;
		};

		let i = 0;
		while (i < visible.length) {
			const cur = visible[i];
			if (!cur) {
				i += 1;
				continue;
			}

			// Skip already-consumed tool_result entries (paired with an earlier tool_use)
			if (consumedResults.has(i)) {
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

				// Try to find a matching tool_result
				const resultIdx = findMatchingResult(i, name, cur.taskId);
				const resultEntry = resultIdx !== -1 ? visible[resultIdx] : undefined;
				if (resultEntry) {
					consumedResults.add(resultIdx);
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
				{showThinking && (
					<div className="og-thinking-indicator">
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
}
