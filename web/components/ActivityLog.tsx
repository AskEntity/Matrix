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
}: {
	entries: LogEntry[];
	filterTaskId: string | null;
	nodeMap: Map<string, TaskNode>;
	autoScroll: boolean;
	onAutoScrollChange: (locked: boolean) => void;
}) {
	const logRef = useRef<HTMLDivElement>(null);
	const [searchText, setSearchText] = useState("");

	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new entries
	useEffect(() => {
		if (autoScroll && logRef.current) {
			requestAnimationFrame(() => {
				if (logRef.current) {
					logRef.current.scrollTop = logRef.current.scrollHeight;
				}
			});
		}
	}, [entries.length, autoScroll]);

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

	// Merge adjacent tool_use + tool_result into combined entries for rendering
	const mergedVisible = useMemo(() => {
		const result: Array<
			| { kind: "single"; entry: LogEntry }
			| {
					kind: "tool_card";
					useEntry: LogEntry;
					resultEntry: LogEntry;
			  }
		> = [];
		let i = 0;
		while (i < visible.length) {
			const cur = visible[i];
			if (!cur) {
				i += 1;
				continue;
			}
			// Hide yield and get_tree tool_use entries (noise); their tool_results still show
			if (
				cur.type === "tool_use" &&
				(cur.text.startsWith("mcp__opengraft__yield(") ||
					cur.text.startsWith("mcp__opengraft__get_tree("))
			) {
				i += 1;
				continue;
			}
			const next = visible[i + 1];
			if (
				cur.type === "tool_use" &&
				next?.type === "tool_result" &&
				next.taskId === cur.taskId
			) {
				// Extract tool name from tool_use text: "toolName(args...)"
				const useToolName = cur.text.split("(")[0] ?? "";
				// Extract tool name from tool_result text: "OK toolName: ..." or "ERR toolName: ..."
				const resultToolMatch = /^(?:OK|ERR) ([^:]+):/.exec(next.text);
				const resultToolName = resultToolMatch?.[1] ?? "";
				if (useToolName === resultToolName) {
					result.push({ kind: "tool_card", useEntry: cur, resultEntry: next });
					i += 2;
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
				{mergedVisible.length === 0 && (
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
