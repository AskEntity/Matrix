import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	createLogEntry,
	type LogEntry,
	type TaskNode,
	useAgent,
	useProjectConfig,
	useProjects,
	useTasks,
	useWebSocket,
} from "./hooks.ts";
import { LocaleProvider, useLocale } from "./i18n.ts";

const PROJECT_NODE_ID = "__project__";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Format a date as relative time: "5m ago", "2h 10m ago", "3d ago" */
function formatRelativeTime(dateStr: string | null | undefined): string {
	if (!dateStr) return "";
	const diff = Date.now() - new Date(dateStr).getTime();
	const secs = Math.floor(diff / 1000);
	if (secs < 60) return `${secs}s ago`;
	const mins = Math.floor(secs / 60);
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ${mins % 60}m ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

/** Format duration since a start date: "5m", "2h 10m" */
function formatRunningDuration(dateStr: string | null | undefined): string {
	if (!dateStr) return "";
	const diff = Date.now() - new Date(dateStr).getTime();
	const secs = Math.floor(diff / 1000);
	if (secs < 60) return `${secs}s`;
	const mins = Math.floor(secs / 60);
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	return `${hours}h ${mins % 60}m`;
}

/** Format a token count compactly: 1234 → "1.2k", 1234567 → "1.2M" */
function formatTokenCount(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function statusDotClass(status: string): string {
	const map: Record<string, string> = {
		pending: "status-dot-pending",
		in_progress: "status-dot-in_progress",
		testing: "status-dot-testing",
		passed: "status-dot-passed",
		failed: "status-dot-failed",
		stuck: "status-dot-stuck",
	};
	return map[status] ?? "status-dot-pending";
}

function StatusBadge({ status }: { status: string }) {
	const { t } = useLocale();
	const key = `status.${status}`;
	return (
		<span className={`og-status-badge ${status}`}>
			<span className="badge-dot" />
			{t(key)}
		</span>
	);
}

// ── Icons (inline SVG, no external dep) ───────────────────────────────────

function IconHexagon({ size = 16 }: { size?: number }) {
	return (
		<svg
			aria-hidden="true"
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<polygon points="11 2 21 7 21 17 11 22 1 17 1 7" />
		</svg>
	);
}

function IconPlus({ size = 14 }: { size?: number }) {
	return (
		<svg
			aria-hidden="true"
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
		>
			<line x1="12" y1="5" x2="12" y2="19" />
			<line x1="5" y1="12" x2="19" y2="12" />
		</svg>
	);
}

function IconRefresh({ size = 14 }: { size?: number }) {
	return (
		<svg
			aria-hidden="true"
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<polyline points="23 4 23 10 17 10" />
			<polyline points="1 20 1 14 7 14" />
			<path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
		</svg>
	);
}

function IconClose({ size = 12 }: { size?: number }) {
	return (
		<svg
			aria-hidden="true"
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
		>
			<line x1="18" y1="6" x2="6" y2="18" />
			<line x1="6" y1="6" x2="18" y2="18" />
		</svg>
	);
}

function IconArrowDown({ size = 12 }: { size?: number }) {
	return (
		<svg
			aria-hidden="true"
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
		>
			<line x1="12" y1="5" x2="12" y2="19" />
			<polyline points="19 12 12 19 5 12" />
		</svg>
	);
}

function IconSend({ size = 14 }: { size?: number }) {
	return (
		<svg
			aria-hidden="true"
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<line x1="22" y1="2" x2="11" y2="13" />
			<polygon points="22 2 15 22 11 13 2 9 22 2" />
		</svg>
	);
}

function IconStop({ size = 14 }: { size?: number }) {
	return (
		<svg
			aria-hidden="true"
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="currentColor"
		>
			<rect x="3" y="3" width="18" height="18" rx="2" />
		</svg>
	);
}

function IconPlay({ size = 14 }: { size?: number }) {
	return (
		<svg
			aria-hidden="true"
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="currentColor"
		>
			<polygon points="5 3 19 12 5 21 5 3" />
		</svg>
	);
}

function IconTrash({ size = 13 }: { size?: number }) {
	return (
		<svg
			aria-hidden="true"
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<polyline points="3 6 5 6 21 6" />
			<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
			<path d="M10 11v6M14 11v6" />
			<path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
		</svg>
	);
}

function IconRepeat({ size = 13 }: { size?: number }) {
	return (
		<svg
			aria-hidden="true"
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<polyline points="17 1 21 5 17 9" />
			<path d="M3 11V9a4 4 0 0 1 4-4h14" />
			<polyline points="7 23 3 19 7 15" />
			<path d="M21 13v2a4 4 0 0 1-4 4H3" />
		</svg>
	);
}

function IconTerminal({ size = 12 }: { size?: number }) {
	return (
		<svg
			aria-hidden="true"
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<polyline points="4 17 10 11 4 5" />
			<line x1="12" y1="19" x2="20" y2="19" />
		</svg>
	);
}

function IconChevron({
	size = 10,
	expanded,
}: {
	size?: number;
	expanded: boolean;
}) {
	return (
		<svg
			aria-hidden="true"
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			style={{
				transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
				transition: "transform 0.15s",
			}}
		>
			<polyline points="9 18 15 12 9 6" />
		</svg>
	);
}

function IconGear({ size = 14 }: { size?: number }) {
	return (
		<svg
			aria-hidden="true"
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<circle cx="12" cy="12" r="3" />
			<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
		</svg>
	);
}

// ── Cute Cat ──────────────────────────────────────────────────────────────

function CuteCat() {
	const [isTyping, setIsTyping] = useState(false);
	const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		const handleKeyDown = () => {
			setIsTyping(true);
			if (typingTimeout.current) clearTimeout(typingTimeout.current);
			typingTimeout.current = setTimeout(() => setIsTyping(false), 500);
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("keydown", handleKeyDown);
			if (typingTimeout.current) clearTimeout(typingTimeout.current);
		};
	}, []);

	return (
		<div className={`og-cute-cat${isTyping ? " og-cat-typing" : ""}`}>
			{/* Ears */}
			<div className="og-cat-ear-left" />
			<div className="og-cat-ear-right" />
			<div className="og-cat-ear-inner-left" />
			<div className="og-cat-ear-inner-right" />
			{/* Head */}
			<div className="og-cat-head" />
			{/* Eyes */}
			<div className="og-cat-eyes">
				<div className="og-cat-eye" />
				<div className="og-cat-eye" />
			</div>
			{/* Nose */}
			<div className="og-cat-nose" />
			{/* Mouth */}
			<div className="og-cat-mouth" />
			{/* Whiskers */}
			<div className="og-cat-whiskers">
				<div className="og-cat-whisker" />
				<div className="og-cat-whisker" />
				<div className="og-cat-whisker" />
				<div className="og-cat-whisker" />
			</div>
			{/* Body */}
			<div className="og-cat-body" />
			{/* Tail */}
			<div className="og-cat-tail" />
			{/* Paws */}
			<div className="og-cat-paw-left" />
			<div className="og-cat-paw-right" />
		</div>
	);
}

// ── Task Tree ──────────────────────────────────────────────────────────────

function TaskTree({
	nodes,
	selectedTaskId,
	onSelect,
	running,
}: {
	nodes: TaskNode[];
	selectedTaskId: string | null;
	onSelect: (id: string | null) => void;
	running: boolean;
}) {
	const roots = useMemo(() => nodes.filter((n) => !n.parentId), [nodes]);
	const childMap = useMemo(() => {
		const map = new Map<string, TaskNode[]>();
		for (const n of nodes) {
			if (n.parentId) {
				if (!map.has(n.parentId)) map.set(n.parentId, []);
				map.get(n.parentId)?.push(n);
			}
		}
		return map;
	}, [nodes]);

	const nodeMap = useMemo(() => {
		const map = new Map<string, TaskNode>();
		for (const n of nodes) map.set(n.id, n);
		return map;
	}, [nodes]);

	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	const toggleCollapse = useCallback((id: string) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	const [taskFilter, setTaskFilter] = useState("");

	const matchingIds = useMemo((): Set<string> | null => {
		const trimmed = taskFilter.trim();
		if (!trimmed) return null; // null = show all
		const lower = trimmed.toLowerCase();
		const matched = new Set<string>();
		for (const node of nodes) {
			if (node.title.toLowerCase().includes(lower)) {
				// Include this node AND all its ancestors
				let current: TaskNode | undefined = node;
				while (current) {
					matched.add(current.id);
					current = current.parentId
						? nodeMap.get(current.parentId)
						: undefined;
				}
			}
		}
		return matched;
	}, [nodes, taskFilter, nodeMap]);

	const { t } = useLocale();
	const isOrchestratorSelected = selectedTaskId === PROJECT_NODE_ID;
	const filteredRoots = matchingIds
		? roots.filter((r) => matchingIds.has(r.id))
		: roots;

	return (
		<div className="og-task-tree">
			{/* Search bar */}
			<div className="og-tree-search-bar">
				<input
					type="text"
					className="og-tree-search"
					placeholder={t("tasks.filter")}
					value={taskFilter}
					onChange={(e) => setTaskFilter(e.target.value)}
				/>
			</div>

			{/* Orchestrator row */}
			<button
				type="button"
				className={`og-orch-node${isOrchestratorSelected ? " selected" : ""}`}
				onClick={(e) => {
					e.stopPropagation();
					onSelect(isOrchestratorSelected ? null : PROJECT_NODE_ID);
				}}
			>
				<span className="og-orch-icon">
					<IconHexagon size={14} />
				</span>
				<span className="og-orch-label">{t("orch.label")}</span>
				<span className={`og-orch-badge ${running ? "running" : "idle"}`}>
					{running
						? t("status.running").toLowerCase()
						: t("status.idle").toLowerCase()}
				</span>
			</button>

			{nodes.length > 0 && <div className="og-sidebar-divider" />}

			{filteredRoots.map((root) => (
				<TaskNodeView
					key={root.id}
					node={root}
					childMap={childMap}
					depth={1}
					selectedTaskId={selectedTaskId}
					onSelect={onSelect}
					collapsed={collapsed}
					toggleCollapse={toggleCollapse}
					matchingIds={matchingIds}
				/>
			))}

			{nodes.length === 0 && (
				<div className="og-empty-state">
					<span className="og-empty-icon">
						<IconHexagon size={24} />
					</span>
					<span>{t("tasks.noTasks")}</span>
					<span style={{ color: "var(--text-faint)", fontSize: "11px" }}>
						{t("tasks.startAgent")}
					</span>
				</div>
			)}

			{nodes.length > 0 && filteredRoots.length === 0 && taskFilter && (
				<div className="og-tree-empty">
					{t("tasks.noMatch")} "{taskFilter}"
				</div>
			)}
		</div>
	);
}

function TaskNodeView({
	node,
	childMap,
	depth,
	selectedTaskId,
	onSelect,
	collapsed,
	toggleCollapse,
	matchingIds,
}: {
	node: TaskNode;
	childMap: Map<string, TaskNode[]>;
	depth: number;
	selectedTaskId: string | null;
	onSelect: (id: string | null) => void;
	collapsed: Set<string>;
	toggleCollapse: (id: string) => void;
	matchingIds: Set<string> | null;
}) {
	const isSelected = node.id === selectedTaskId;
	const allChildren = childMap.get(node.id) ?? [];
	// When filtering, only show children that are in the matching set
	const children = matchingIds
		? allChildren.filter((c) => matchingIds.has(c.id))
		: allChildren;
	const hasChildren = children.length > 0;
	// When filter is active, force-expand all ancestor nodes
	const isCollapsed = matchingIds ? false : collapsed.has(node.id);

	return (
		<>
			<button
				type="button"
				className={`og-task-node${isSelected ? " selected" : ""}`}
				onClick={(e) => {
					e.stopPropagation();
					onSelect(isSelected ? null : node.id);
				}}
			>
				<div
					className="og-task-row"
					style={{ paddingLeft: `${12 + depth * 16}px` }}
				>
					{hasChildren ? (
						<button
							type="button"
							className="og-tree-toggle"
							onClick={(e) => {
								e.stopPropagation();
								toggleCollapse(node.id);
							}}
						>
							<IconChevron expanded={!isCollapsed} />
						</button>
					) : (
						<span className="og-tree-toggle-placeholder" />
					)}
					<span
						className={`og-task-status-dot ${statusDotClass(node.status)}`}
					/>
					<span className="og-task-title">{node.title}</span>
					{node.branch && (
						<span className="og-task-branch-tag" title={node.branch}>
							{node.branch.replace("og/", "").split("/").slice(1).join("/") ||
								node.branch.replace("og/", "")}
						</span>
					)}
				</div>
			</button>
			{!isCollapsed &&
				children.map((child) => (
					<TaskNodeView
						key={child.id}
						node={child}
						childMap={childMap}
						depth={depth + 1}
						selectedTaskId={selectedTaskId}
						onSelect={onSelect}
						collapsed={collapsed}
						toggleCollapse={toggleCollapse}
						matchingIds={matchingIds}
					/>
				))}
		</>
	);
}

// ── Activity Log ───────────────────────────────────────────────────────────

function ActivityLog({
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
			logRef.current.scrollTop = logRef.current.scrollHeight;
		}
	}, [entries.length, autoScroll]);

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
		if (!filterTaskId) {
			items = entries;
		} else if (filterTaskId === PROJECT_NODE_ID) {
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
				{visible.map((entry) => (
					<LogEntryView key={entry.id} entry={entry} nodeMap={nodeMap} />
				))}
				{visible.length === 0 && (
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

function LogEntryView({
	entry,
	nodeMap,
}: {
	entry: LogEntry;
	nodeMap: Map<string, TaskNode>;
}) {
	const [expanded, setExpanded] = useState(false);
	const taskLabel = entry.taskId
		? (nodeMap.get(entry.taskId)?.title?.slice(0, 18) ??
			entry.taskId.slice(0, 8))
		: null;

	const { t } = useLocale();

	if (entry.type === "compact" && entry.checkpoint) {
		return (
			<div className="og-compact-boundary">
				<div className="og-compact-hint">{t("compact.notVisible")}</div>
				<div className="og-compact-bar">
					<span className="og-compact-label">◈ {entry.text}</span>
					<button
						type="button"
						className="og-compact-toggle"
						onClick={() => setExpanded(!expanded)}
					>
						{expanded ? t("compact.collapse") : t("compact.checkpoint")}
					</button>
				</div>
				{expanded && (
					<pre className="og-compact-checkpoint">{entry.checkpoint}</pre>
				)}
			</div>
		);
	}

	if (entry.type === "tool_use") {
		const parts = entry.text.split("(");
		const toolName = parts[0] ?? entry.text;
		const args = parts.slice(1).join("(").replace(/\)$/, "");
		return (
			<div className={`og-log-entry og-event-${entry.type}`}>
				<span className="og-log-time">{entry.time}</span>
				{taskLabel && (
					<span className="og-log-badge" title={entry.taskId}>
						{taskLabel}
					</span>
				)}
				<div className="og-log-body">
					<span className="og-tool-call">
						<span className="og-tool-name">
							<IconTerminal size={10} />
							{toolName}
						</span>
						{args && (
							<span className="og-tool-args">
								({args.length > 80 ? `${args.slice(0, 80)}…` : args})
							</span>
						)}
					</span>
				</div>
			</div>
		);
	}

	if (entry.type === "tool_result") {
		const isOk = entry.text.startsWith("OK ");
		const isErr = entry.text.startsWith("ERR ");
		const rest = entry.text.replace(/^(OK|ERR) [^:]+: /, "");
		const toolMatch = /^(OK|ERR) ([^:]+):/.exec(entry.text);
		const toolName = toolMatch?.[2] ?? "";
		return (
			<div className={`og-log-entry og-event-${entry.type}`}>
				<span className="og-log-time">{entry.time}</span>
				{taskLabel && (
					<span className="og-log-badge" title={entry.taskId}>
						{taskLabel}
					</span>
				)}
				<div className="og-log-body">
					<span className="og-tool-result">
						<span
							className={
								isOk ? "og-tool-result-ok" : isErr ? "og-tool-result-err" : ""
							}
						>
							{isOk ? "✓" : isErr ? "✗" : "→"} {toolName}
						</span>
						{rest && (
							<span className="og-tool-result-content">
								{" "}
								{rest.length > 120 ? `${rest.slice(0, 120)}…` : rest}
							</span>
						)}
					</span>
				</div>
			</div>
		);
	}

	if (entry.type === "queue_message") {
		return (
			<div className={`og-log-entry og-event-${entry.type}`}>
				<span className="og-log-time">{entry.time}</span>
				{taskLabel && (
					<span className="og-log-badge" title={entry.taskId}>
						{taskLabel}
					</span>
				)}
				<div className="og-log-body">
					<span className="og-queue-message">
						<IconSend size={10} />
						<span className="og-queue-message-text">{entry.text}</span>
					</span>
				</div>
			</div>
		);
	}

	if (entry.type === "user_prompt") {
		return (
			<div className="og-log-entry og-event-user_prompt">
				<span className="og-log-time">{entry.time}</span>
				<div className="og-user-prompt-bubble">
					<span className="og-user-prompt-label">{t("log.youArrow")}</span>
					<span className="og-user-prompt-text">{entry.text}</span>
				</div>
			</div>
		);
	}

	return (
		<div className={`og-log-entry og-event-${entry.type}`}>
			<span className="og-log-time">{entry.time}</span>
			{taskLabel && (
				<span className="og-log-badge" title={entry.taskId}>
					{taskLabel}
				</span>
			)}
			<div className="og-log-body">
				<span className="og-log-text">{entry.text}</span>
			</div>
		</div>
	);
}

// ── Conversation History ───────────────────────────────────────────────────

interface ConversationMessage {
	role: "user" | "assistant";
	content: string;
	hasToolUse: boolean;
	toolNames?: string[];
}

function ConversationHistory({
	projectId,
	nodeId,
}: {
	projectId: string;
	nodeId: string;
}) {
	const [messages, setMessages] = useState<ConversationMessage[]>([]);
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		setLoading(true);
		fetch(`/projects/${projectId}/tasks/${nodeId}/conversation`)
			.then((r) => r.json())
			.then((data: { messages: ConversationMessage[] }) => {
				setMessages(data.messages ?? []);
			})
			.catch(() => setMessages([]))
			.finally(() => setLoading(false));
	}, [projectId, nodeId]);

	const { t } = useLocale();

	if (loading) {
		return (
			<div className="og-conv-history">
				<div className="og-conv-loading">{t("detail.loadingHistory")}</div>
			</div>
		);
	}

	if (messages.length === 0) {
		return (
			<div className="og-conv-history">
				<div className="og-conv-empty">{t("detail.noHistory")}</div>
			</div>
		);
	}

	return (
		<div className="og-conv-history">
			{messages.map((msg, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: stable index for static list
				<div key={i} className={`og-conv-msg og-conv-msg-${msg.role}`}>
					<span className={`og-conv-role-badge og-conv-role-${msg.role}`}>
						{msg.role === "user" ? t("conv.user") : t("conv.assistant")}
					</span>
					<div className="og-conv-content">{msg.content}</div>
					{msg.hasToolUse && msg.toolNames && msg.toolNames.length > 0 && (
						<div className="og-conv-tools">🔧 {msg.toolNames.join(", ")}</div>
					)}
				</div>
			))}
		</div>
	);
}

// ── Task Detail ────────────────────────────────────────────────────────────

function TaskDetail({
	node,
	projectId,
	onContinue,
	onDelete,
}: {
	node: TaskNode;
	projectId: string;
	onContinue: (msg?: string) => void;
	onDelete: () => void;
}) {
	const { t } = useLocale();
	const [continueMsg, setContinueMsg] = useState("");
	const [commits, setCommits] = useState<{ hash: string; message: string }[]>(
		[],
	);
	const [showHistory, setShowHistory] = useState(false);
	const canContinue = node.status === "failed" || node.status === "stuck";
	const isPending = node.status === "pending";
	const isRunning = node.status === "in_progress" || node.status === "testing";
	const [editingTitle, setEditingTitle] = useState(false);
	const [editTitle, setEditTitle] = useState(node.title);
	const [editingDesc, setEditingDesc] = useState(false);
	const [editDesc, setEditDesc] = useState(node.description);
	const titleInputRef = useRef<HTMLInputElement>(null);
	const descTextareaRef = useRef<HTMLTextAreaElement>(null);

	// Sync local state when node changes
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset edit state when node identity changes
	useEffect(() => {
		setEditTitle(node.title);
		setEditDesc(node.description);
		setEditingTitle(false);
		setEditingDesc(false);
	}, [node.id]);

	const saveTitle = useCallback(
		(value: string) => {
			const trimmed = value.trim();
			if (trimmed && trimmed !== node.title) {
				fetch(`/projects/${projectId}/tasks/${node.id}`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title: trimmed }),
				});
			}
			setEditingTitle(false);
		},
		[projectId, node.id, node.title],
	);

	const saveDescription = useCallback(
		(value: string) => {
			if (value !== node.description) {
				fetch(`/projects/${projectId}/tasks/${node.id}`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ description: value }),
				});
			}
			setEditingDesc(false);
		},
		[projectId, node.id, node.description],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: refetch when status changes so new commits appear after task completes
	useEffect(() => {
		if (!projectId || !node.id) return;
		fetch(`/projects/${projectId}/tasks/${node.id}/gitlog`)
			.then((r) => r.json())
			.then((data: { commits: { hash: string; message: string }[] }) => {
				setCommits(data.commits ?? []);
			})
			.catch(() => setCommits([]));
	}, [node.id, node.status, projectId]);

	return (
		<div className="og-detail-content">
			<div className="og-detail-title">
				<span
					className={`og-task-status-dot ${statusDotClass(node.status)}`}
					style={{ width: "10px", height: "10px", flexShrink: 0 }}
				/>
				{editingTitle ? (
					<input
						ref={titleInputRef}
						className="og-editable-title-input"
						value={editTitle}
						onChange={(e) => setEditTitle(e.target.value)}
						onBlur={() => saveTitle(editTitle)}
						onKeyDown={(e) => {
							if (e.key === "Enter") saveTitle(editTitle);
							if (e.key === "Escape") {
								setEditTitle(node.title);
								setEditingTitle(false);
							}
						}}
					/>
				) : isPending ? (
					<button
						type="button"
						className="og-editable-title"
						onClick={() => {
							setEditingTitle(true);
							setTimeout(() => titleInputRef.current?.focus(), 0);
						}}
						title={t("detail.clickToEdit")}
					>
						{node.title}
					</button>
				) : (
					<span>{node.title}</span>
				)}
			</div>

			{editingDesc ? (
				<textarea
					ref={descTextareaRef}
					className="og-editable-desc-textarea"
					value={editDesc}
					onChange={(e) => setEditDesc(e.target.value)}
					onBlur={() => saveDescription(editDesc)}
					onKeyDown={(e) => {
						if (e.key === "Escape") {
							setEditDesc(node.description);
							setEditingDesc(false);
						}
					}}
					rows={4}
				/>
			) : isRunning ? (
				<div className="og-detail-description">
					{node.description || (
						<span className="og-text-faint">{t("detail.noDescription")}</span>
					)}
					<div className="og-running-hint">{t("detail.runningHint")}</div>
				</div>
			) : isPending ? (
				<button
					type="button"
					className="og-detail-description og-editable-desc"
					onClick={() => {
						setEditingDesc(true);
						setTimeout(() => descTextareaRef.current?.focus(), 0);
					}}
					title={t("detail.clickToEdit")}
				>
					{node.description || (
						<span className="og-text-faint">{t("detail.editDescription")}</span>
					)}
				</button>
			) : (
				<div className="og-detail-description">
					{node.description || (
						<span className="og-text-faint">{t("detail.noDescription")}</span>
					)}
				</div>
			)}

			<div className="og-detail-grid">
				<div className="og-detail-field">
					<div className="og-detail-label">{t("detail.status")}</div>
					<StatusBadge status={node.status} />
				</div>
				{node.branch && (
					<div className="og-detail-field">
						<div className="og-detail-label">{t("detail.branch")}</div>
						<div className="og-detail-value mono">{node.branch}</div>
					</div>
				)}
				{node.worktreePath && (
					<div className="og-detail-field">
						<div className="og-detail-label">{t("detail.worktree")}</div>
						<div className="og-detail-value mono" style={{ fontSize: "10px" }}>
							{node.worktreePath}
						</div>
					</div>
				)}
				{node.updatedAt && (
					<div className="og-detail-field">
						<div className="og-detail-label">{t("detail.updated")}</div>
						<div className="og-detail-value">
							{new Date(node.updatedAt).toLocaleString()}
						</div>
					</div>
				)}
				{(node.createdAt || node.updatedAt) && (
					<div className="og-detail-field">
						<div className="og-detail-label">
							{node.status === "in_progress"
								? t("detail.running")
								: node.status === "pending"
									? t("detail.waiting")
									: t("detail.age")}
						</div>
						<div className="og-detail-value">
							{node.status === "in_progress"
								? formatRunningDuration(node.createdAt ?? node.updatedAt)
								: node.status === "pending"
									? formatRelativeTime(node.createdAt ?? node.updatedAt)
									: formatRelativeTime(node.updatedAt)}
						</div>
					</div>
				)}
				{(node.costUsd != null && node.costUsd > 0) || node.budgetUsd ? (
					<div className="og-detail-field">
						<div className="og-detail-label">{t("detail.cost")}</div>
						<div className="og-detail-value mono">
							${(node.costUsd ?? 0).toFixed(4)}
							{node.budgetUsd
								? ` / ${node.budgetUsd.toFixed(2)} ${t("detail.budget")}`
								: ""}
						</div>
					</div>
				) : null}
				{node.message && (
					<div className="og-detail-field" style={{ width: "100%" }}>
						<div className="og-detail-label">{t("detail.message")}</div>
						<div className="og-detail-value">{node.message}</div>
					</div>
				)}
			</div>

			{commits.length > 0 && (
				<div className="og-detail-section">
					<div className="og-detail-label" style={{ marginBottom: "6px" }}>
						{t("detail.commits")}
					</div>
					{commits.slice(0, 10).map((commit) => (
						<div
							key={commit.hash}
							style={{
								display: "flex",
								gap: "8px",
								fontSize: "11px",
								lineHeight: "1.5",
								padding: "2px 0",
							}}
						>
							<span
								className="mono"
								style={{ color: "var(--text-faint)", flexShrink: 0 }}
							>
								{commit.hash.slice(0, 7)}
							</span>
							<span style={{ color: "var(--text-secondary)" }}>
								{commit.message}
							</span>
						</div>
					))}
				</div>
			)}

			<div className="og-detail-actions">
				{canContinue && (
					<form
						className="og-continue-form"
						onSubmit={(e) => {
							e.preventDefault();
							onContinue(continueMsg || undefined);
							setContinueMsg("");
						}}
					>
						<input
							type="text"
							className="og-continue-input"
							value={continueMsg}
							onChange={(e) => setContinueMsg(e.target.value)}
							placeholder={t("detail.retryPlaceholder")}
						/>
						<button type="submit" className="og-btn og-btn-warning og-btn-sm">
							<IconRepeat size={12} />
							{t("detail.continue")}
						</button>
					</form>
				)}
				{node.sessionId && (
					<button
						type="button"
						className={`og-btn og-btn-sm ${showHistory ? "og-btn-active" : "og-btn-ghost"}`}
						onClick={() => setShowHistory((v) => !v)}
					>
						{t("detail.history")}
					</button>
				)}
				<button
					type="button"
					className="og-btn og-btn-danger og-btn-sm"
					onClick={onDelete}
				>
					<IconTrash size={12} />
					{t("detail.delete")}
				</button>
			</div>

			{showHistory && node.sessionId && (
				<ConversationHistory projectId={projectId} nodeId={node.id} />
			)}
		</div>
	);
}

function OrchestratorDetail({
	running,
	nodeCount,
	nodes,
	costUsd,
	totalCost,
	turns,
	inputTokens,
	cacheCreationTokens,
	cacheReadTokens,
	outputTokens,
	provider,
	model,
	onClearSessions,
}: {
	running: boolean;
	nodeCount: number;
	nodes: import("./hooks.ts").TaskNode[];
	costUsd?: number | null;
	totalCost?: number | null;
	turns?: number | null;
	inputTokens?: number | null;
	cacheCreationTokens?: number | null;
	cacheReadTokens?: number | null;
	outputTokens?: number | null;
	provider?: string | null;
	model?: string | null;
	onClearSessions?: () => void;
}) {
	const { t } = useLocale();
	const passed = nodes.filter((n) => n.status === "passed").length;
	const failed = nodes.filter(
		(n) => n.status === "failed" || n.status === "stuck",
	).length;
	const inProgress = nodes.filter((n) => n.status === "in_progress").length;
	return (
		<div className="og-orch-detail">
			<div className="og-orch-detail-header">
				<div className="og-orch-icon-lg">
					<IconHexagon size={18} />
				</div>
				<div>
					<div className="og-orch-name">{t("orch.label")}</div>
					<div className="og-orch-sub">{t("orch.rootSession")}</div>
				</div>
			</div>
			<div className="og-stats-row">
				<div className="og-stat-card">
					<span className="og-stat-label">{t("orch.state")}</span>
					<span
						className={`og-stat-value ${running ? "running" : ""}`}
						style={{ fontSize: "14px" }}
					>
						{running ? (
							<span className="og-running-indicator">
								<span className="og-spinner" />
								{t("status.running")}
							</span>
						) : (
							t("status.idle")
						)}
					</span>
				</div>
				{provider && (
					<div className="og-stat-card">
						<span className="og-stat-label">{t("orch.provider")}</span>
						<span className="og-stat-value" style={{ fontSize: "12px" }}>
							{provider}
						</span>
					</div>
				)}
				{model && (
					<div className="og-stat-card">
						<span className="og-stat-label">{t("orch.model")}</span>
						<span className="og-stat-value" style={{ fontSize: "12px" }}>
							{model}
						</span>
					</div>
				)}
				<div className="og-stat-card">
					<span className="og-stat-label">{t("orch.tasks")}</span>
					<span className="og-stat-value">{nodeCount}</span>
				</div>
				{nodeCount > 0 && (
					<div className="og-stat-card">
						<span className="og-stat-label">{t("orch.done")}</span>
						<span className="og-stat-value" style={{ fontSize: "14px" }}>
							<span style={{ color: "var(--color-passed)" }}>{passed}</span>
							<span style={{ color: "var(--text-faint)", fontWeight: 400 }}>
								{" "}
								/ {nodeCount}
							</span>
						</span>
					</div>
				)}
				{passed > 0 && (
					<div className="og-stat-card">
						<span className="og-stat-label">{t("orch.passed")}</span>
						<span
							className="og-stat-value"
							style={{ color: "var(--color-passed)" }}
						>
							{passed}
						</span>
					</div>
				)}
				{inProgress > 0 && (
					<div className="og-stat-card">
						<span className="og-stat-label">{t("orch.active")}</span>
						<span
							className="og-stat-value"
							style={{ color: "var(--color-in-progress)" }}
						>
							{inProgress}
						</span>
					</div>
				)}
				{failed > 0 && (
					<div className="og-stat-card">
						<span className="og-stat-label">{t("orch.failed")}</span>
						<span
							className="og-stat-value"
							style={{ color: "var(--color-failed)" }}
						>
							{failed}
						</span>
					</div>
				)}
				{costUsd != null && (
					<div className="og-stat-card">
						<span className="og-stat-label">{t("orch.session")}</span>
						<span className="og-stat-value">${costUsd.toFixed(3)}</span>
					</div>
				)}
				{totalCost != null && totalCost > 0 && (
					<div className="og-stat-card">
						<span className="og-stat-label">{t("orch.totalCost")}</span>
						<span className="og-stat-value">${totalCost.toFixed(3)}</span>
					</div>
				)}
				{turns != null && turns > 0 && (
					<div className="og-stat-card">
						<span className="og-stat-label">{t("orch.turns")}</span>
						<span className="og-stat-value">{turns}</span>
					</div>
				)}
			</div>
			{(inputTokens != null ||
				cacheCreationTokens != null ||
				cacheReadTokens != null ||
				outputTokens != null) && (
				<div className="og-stats-row" style={{ marginTop: "8px" }}>
					<div className="og-stat-card">
						<span className="og-stat-label">{t("orch.input")}</span>
						<span className="og-stat-value" style={{ fontSize: "13px" }}>
							{(inputTokens ?? 0).toLocaleString()}
						</span>
					</div>
					<div className="og-stat-card">
						<span className="og-stat-label">{t("orch.cacheWrite")}</span>
						<span className="og-stat-value" style={{ fontSize: "13px" }}>
							{(cacheCreationTokens ?? 0).toLocaleString()}
						</span>
					</div>
					<div className="og-stat-card">
						<span className="og-stat-label">{t("orch.cacheRead")}</span>
						<span className="og-stat-value" style={{ fontSize: "13px" }}>
							{(cacheReadTokens ?? 0).toLocaleString()}
						</span>
					</div>
					<div className="og-stat-card">
						<span className="og-stat-label">{t("orch.output")}</span>
						<span className="og-stat-value" style={{ fontSize: "13px" }}>
							{(outputTokens ?? 0).toLocaleString()}
						</span>
					</div>
				</div>
			)}
			{!running && onClearSessions && (
				<div style={{ marginTop: "12px" }}>
					<button
						type="button"
						className="og-btn og-btn-sm og-btn-danger"
						onClick={onClearSessions}
					>
						<IconTrash size={12} />
						{t("orch.clearSessions")}
					</button>
				</div>
			)}
		</div>
	);
}

// ── Main App ───────────────────────────────────────────────────────────────

export function App() {
	return (
		<LocaleProvider>
			<AppInner />
		</LocaleProvider>
	);
}

function AppInner() {
	const { locale, setLocale, t } = useLocale();
	const {
		projects,
		refresh: refreshProjects,
		initProject,
		deleteProject,
	} = useProjects();
	const [projectId, setProjectId] = useState("");
	const [showAddProject, setShowAddProject] = useState(false);
	const [newProjectPath, setNewProjectPath] = useState("");
	const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
	/** Which task/agent receives the next message. null = orchestrator (default). */
	const [targetNodeId, setTargetNodeId] = useState<string | null>(null);
	const [lastCostUsd, setLastCostUsd] = useState<number | null>(null);
	const [lastTurns, setLastTurns] = useState<number | null>(null);
	const [lastInputTokens, setLastInputTokens] = useState<number | null>(null);
	const [lastCacheCreationTokens, setLastCacheCreationTokens] = useState<
		number | null
	>(null);
	const [lastCacheReadTokens, setLastCacheReadTokens] = useState<number | null>(
		null,
	);
	const [lastOutputTokens, setLastOutputTokens] = useState<number | null>(null);
	const [logs, setLogs] = useState<LogEntry[]>([]);
	const [prompt, setPrompt] = useState(
		() => localStorage.getItem("og-prompt-draft") ?? "",
	);
	const [showSettings, setShowSettings] = useState(false);
	const [splitRatio, setSplitRatio] = useState(0.35);
	const [isDragging, setIsDragging] = useState(false);
	const [autoScroll, setAutoScroll] = useState(true);
	const [theme, setThemeState] = useState<
		"dark" | "light" | "cute-light" | "cute-dark"
	>(() => {
		const stored = localStorage.getItem("og-theme");
		if (stored === "light" || stored === "cute-light" || stored === "cute-dark")
			return stored;
		if (stored === "dark") return "dark";
		return "dark";
	});
	const [pendingMessages, setPendingMessages] = useState<
		{ id: string; taskId: string | null; text: string; timestamp: number }[]
	>([]);
	const [pendingClarifications, setPendingClarifications] = useState<
		{ id: string; taskId: string; question: string; timestamp: number }[]
	>([]);
	const [clarifyAnswers, setClarifyAnswers] = useState<Record<string, string>>(
		{},
	);
	const contentPanelRef = useRef<HTMLElement>(null);

	const { nodes, refresh: refreshTasks, updateFromWS } = useTasks(projectId);
	const {
		running,
		setRunning,
		provider: agentProvider,
		setProvider: setAgentProvider,
		model: agentModel,
		setModel: setAgentModel,
		start,
		stop,
		restartAgent,
		checkStatus,
		continueTask,
		deleteTask,
		sendMessage,
		sendMessageToTask,
	} = useAgent(projectId);
	const { config: projectConfig, updateConfig } = useProjectConfig(projectId);

	const nodeMap = useMemo(() => {
		const map = new Map<string, TaskNode>();
		for (const n of nodes) map.set(n.id, n);
		return map;
	}, [nodes]);

	const totalCost = useMemo(() => {
		const sum = nodes.reduce((acc, n) => acc + (n.costUsd ?? 0), 0);
		return sum > 0 ? sum : null;
	}, [nodes]);

	const isOrchestratorNode = selectedTaskId === PROJECT_NODE_ID;
	const selectedNode =
		selectedTaskId && !isOrchestratorNode
			? (nodeMap.get(selectedTaskId) ?? null)
			: null;

	const addLog = useCallback(
		(type: string, text: string, taskId?: string, checkpoint?: string) => {
			const entry = createLogEntry(type, text, taskId);
			if (checkpoint) entry.checkpoint = checkpoint;
			setLogs((prev) => [...prev, entry]);
		},
		[],
	);

	// Theme persistence
	useEffect(() => {
		const root = document.documentElement;
		root.classList.remove("light-mode", "cute-mode", "cute-dark");
		if (theme === "light") {
			root.classList.add("light-mode");
		} else if (theme === "cute-light") {
			root.classList.add("cute-mode");
		} else if (theme === "cute-dark") {
			root.classList.add("cute-mode", "cute-dark");
		}
		// "dark" = no extra classes (default)
		localStorage.setItem("og-theme", theme);
	}, [theme]);

	// Browser tab title progress
	useEffect(() => {
		const total = nodes.length;
		if (total === 0) {
			document.title = "OpenGraft";
			return;
		}
		const passed = nodes.filter((n) => n.status === "passed").length;
		const failed = nodes.filter(
			(n) => n.status === "failed" || n.status === "stuck",
		).length;

		if (failed > 0) {
			document.title = `[!${failed}] OpenGraft`;
		} else if (passed === total) {
			document.title = `[✓] OpenGraft`;
		} else {
			document.title = `[${passed}/${total}] OpenGraft`;
		}
	}, [nodes]);

	// Draggable divider
	const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
		e.preventDefault();
		setIsDragging(true);
	}, []);

	useEffect(() => {
		if (!isDragging) return;
		const handleMouseMove = (e: MouseEvent) => {
			const panel = contentPanelRef.current;
			if (!panel) return;
			const rect = panel.getBoundingClientRect();
			const y = e.clientY - rect.top;
			const ratio = Math.min(0.85, Math.max(0.1, y / rect.height));
			setSplitRatio(ratio);
		};
		const handleMouseUp = () => setIsDragging(false);
		document.addEventListener("mousemove", handleMouseMove);
		document.addEventListener("mouseup", handleMouseUp);
		return () => {
			document.removeEventListener("mousemove", handleMouseMove);
			document.removeEventListener("mouseup", handleMouseUp);
		};
	}, [isDragging]);

	// Global keyboard shortcuts
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement;
			const isInput =
				target.tagName === "INPUT" ||
				target.tagName === "TEXTAREA" ||
				target.isContentEditable;

			if (e.key === "Escape" && !isInput) {
				setSelectedTaskId(null);
				setTargetNodeId(null);
			}

			if (e.key === "/" && !isInput) {
				e.preventDefault();
				const searchInput = document.querySelector(
					".og-log-search",
				) as HTMLInputElement | null;
				searchInput?.focus();
			}
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, []);

	// WebSocket handler
	const handleWS = useCallback(
		(msg: Record<string, unknown>) => {
			switch (msg.type) {
				case "tree_updated":
					updateFromWS(msg.nodes as TaskNode[]);
					break;
				case "agent_event": {
					const et = msg.eventType as string;
					let text = "";
					if (et === "tool_use") {
						text = `${msg.tool}(${formatArgs(msg.input as Record<string, unknown>)})`;
					} else if (et === "tool_result") {
						text = `${msg.isError ? "ERR" : "OK"} ${msg.tool}: ${((msg.content as string) || "").slice(0, 200)}`;
					} else if (et === "text") {
						text = (msg.content as string) || "";
					} else if (et === "error") {
						text = (msg.message as string) || "";
					} else if (et === "usage") {
						break;
					} else if (et === "compact") {
						text = `Context compacted (saved ~${msg.savedTokens} tokens)`;
						addLog(
							et,
							text,
							msg.taskId as string | undefined,
							msg.checkpoint as string,
						);
						break;
					} else if (et === "queue_message") {
						// Parse structured queue messages and add typed log entries
						const raw = (msg.messages as string) || "";
						const taskId = msg.taskId as string | undefined;
						const lines = raw
							.split("\n")
							.filter((l) => l.trim() && !l.startsWith("## "));
						let parsed = false;
						for (const line of lines) {
							const m = /^\[([^\]]+)\] (.*)$/s.exec(line);
							if (m) {
								parsed = true;
								const msgType = m[1];
								const msgText = m[2] ?? "";
								let logType: string;
								if (msgType === "child_complete") {
									logType = "task_completed";
								} else if (msgType === "user") {
									logType = "user_prompt";
								} else {
									logType = "queue_message";
								}
								addLog(logType, msgText, taskId);
							}
						}
						if (!parsed) {
							// Fallback: show raw text as single queue_message entry
							addLog("queue_message", raw, taskId);
						}
						break;
					} else if (et === "status") {
						text = (msg.message as string) || "";
					} else {
						text = JSON.stringify(msg).slice(0, 200);
					}
					addLog(et, text, msg.taskId as string | undefined);
					break;
				}
				case "orchestration_started":
					if (msg.prompt) {
						addLog("user_prompt", msg.prompt as string);
					}
					addLog("lifecycle", "Orchestration started");
					setRunning(true);
					if (msg.provider) setAgentProvider(msg.provider as string);
					if (msg.model) setAgentModel(msg.model as string);
					break;
				case "orchestration_completed": {
					const costStr = msg.costUsd
						? ` · ${(msg.costUsd as number).toFixed(3)}`
						: "";
					const hasTokens =
						msg.inputTokens !== undefined ||
						msg.cacheCreationTokens !== undefined ||
						msg.cacheReadTokens !== undefined ||
						msg.outputTokens !== undefined;
					const tokenStr = hasTokens
						? ` · ${formatTokenCount((msg.inputTokens as number) ?? 0)} in · ${formatTokenCount((msg.cacheCreationTokens as number) ?? 0)} write · ${formatTokenCount((msg.cacheReadTokens as number) ?? 0)} read · ${formatTokenCount((msg.outputTokens as number) ?? 0)} out`
						: "";
					if (msg.costUsd !== undefined) setLastCostUsd(msg.costUsd as number);
					if (msg.turns !== undefined) setLastTurns(msg.turns as number);
					if (msg.inputTokens !== undefined)
						setLastInputTokens(msg.inputTokens as number);
					if (msg.cacheCreationTokens !== undefined)
						setLastCacheCreationTokens(msg.cacheCreationTokens as number);
					if (msg.cacheReadTokens !== undefined)
						setLastCacheReadTokens(msg.cacheReadTokens as number);
					if (msg.outputTokens !== undefined)
						setLastOutputTokens(msg.outputTokens as number);
					addLog(
						"lifecycle",
						`Orchestration ${msg.success ? "completed ✓" : "failed ✗"}${costStr}${tokenStr}`,
					);
					setRunning(false);
					break;
				}
				case "agent_stopped":
					addLog("lifecycle", "Agent stopped");
					setRunning(false);
					break;
				case "task_started": {
					const instruction = msg.message
						? `\n${t("lifecycle.instructions")} ${(msg.message as string).length > 200 ? `${(msg.message as string).slice(0, 200)}…` : msg.message}`
						: "";
					addLog(
						"task_started",
						`${t("lifecycle.taskStarted")} ${msg.title}${instruction}`,
						msg.taskId as string,
					);
					break;
				}
				case "task_completed":
					addLog(
						"task_completed",
						`${msg.success ? "✓ Passed" : "✗ Failed"}: ${msg.title}`,
						msg.taskId as string,
					);
					break;
				case "error":
					addLog("error", msg.message as string);
					break;
				case "event_history": {
					setLogs([]);
					const events = msg.events as Record<string, unknown>[];
					for (const evt of events) handleWS(evt);
					break;
				}
				case "pending_messages": {
					const messages = msg.messages as {
						id: string;
						taskId: string | null;
						text: string;
						timestamp: number;
					}[];
					setPendingMessages(messages ?? []);
					break;
				}
				case "pending_clarifications": {
					const clarifications = msg.clarifications as {
						id: string;
						taskId: string;
						question: string;
						timestamp: number;
					}[];
					setPendingClarifications(clarifications ?? []);
					break;
				}
			}
		},
		[addLog, updateFromWS, setRunning, setAgentProvider, setAgentModel, t],
	);

	const { connected } = useWebSocket(projectId, handleWS);

	// Auto-select first project
	useEffect(() => {
		if (projects.length > 0 && !projectId && projects[0]) {
			setProjectId(projects[0].id);
		}
	}, [projects, projectId]);

	// Check agent status on project change
	useEffect(() => {
		if (projectId) checkStatus();
	}, [projectId, checkStatus]);

	// Fetch pending messages on project change
	useEffect(() => {
		if (!projectId) {
			setPendingMessages([]);
			return;
		}
		fetch(`/projects/${projectId}/pending-messages`)
			.then((r) => r.json())
			.then(
				(data: {
					messages: {
						id: string;
						taskId: string | null;
						text: string;
						timestamp: number;
					}[];
				}) => {
					setPendingMessages(data.messages ?? []);
				},
			)
			.catch(() => setPendingMessages([]));
	}, [projectId]);

	// Fetch pending clarifications on project change
	useEffect(() => {
		if (!projectId) {
			setPendingClarifications([]);
			setClarifyAnswers({});
			return;
		}
		fetch(`/projects/${projectId}/clarifications`)
			.then((r) => r.json())
			.then(
				(data: {
					clarifications: {
						id: string;
						taskId: string;
						question: string;
						timestamp: number;
					}[];
				}) => {
					setPendingClarifications(data.clarifications ?? []);
				},
			)
			.catch(() => setPendingClarifications([]));
	}, [projectId]);

	// Auto-target selected in_progress tasks for messages
	useEffect(() => {
		if (!selectedTaskId || selectedTaskId === PROJECT_NODE_ID) {
			setTargetNodeId(null);
			return;
		}
		const node = nodeMap.get(selectedTaskId);
		if (node?.status === "in_progress") {
			setTargetNodeId(selectedTaskId);
		} else {
			setTargetNodeId(null);
		}
	}, [selectedTaskId, nodeMap]);

	// Auto-save prompt draft to localStorage (debounced 2s)
	useEffect(() => {
		const timer = setTimeout(() => {
			if (prompt) {
				localStorage.setItem("og-prompt-draft", prompt);
			} else {
				localStorage.removeItem("og-prompt-draft");
			}
		}, 2000);
		return () => clearTimeout(timer);
	}, [prompt]);

	// Save prompt draft immediately on beforeunload
	useEffect(() => {
		const handler = () => {
			if (prompt) localStorage.setItem("og-prompt-draft", prompt);
		};
		window.addEventListener("beforeunload", handler);
		return () => window.removeEventListener("beforeunload", handler);
	}, [prompt]);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!prompt.trim() || !projectId) return;
		try {
			if (running) {
				if (targetNodeId) {
					// Send to specific agent's queue
					await sendMessageToTask(targetNodeId, prompt.trim());
				} else {
					await sendMessage(prompt.trim());
				}
			} else {
				await start({ prompt: prompt.trim() });
			}
			setPrompt("");
			localStorage.removeItem("og-prompt-draft");
		} catch (err) {
			addLog("error", (err as Error).message);
		}
	}

	async function handleStop() {
		try {
			await stop();
		} catch (err) {
			addLog("error", (err as Error).message);
		}
	}

	async function handleClarifySubmit(taskId: string) {
		if (!projectId) return;
		const answer = clarifyAnswers[taskId]?.trim();
		if (!answer) return;
		try {
			const res = await fetch(`/projects/${projectId}/clarify`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ taskId, answer }),
			});
			if (!res.ok) {
				const body = (await res.json()) as { error: string };
				addLog("error", `Failed to answer clarification: ${body.error}`);
				return;
			}
			// Clear the answer input
			setClarifyAnswers((prev) => {
				const next = { ...prev };
				delete next[taskId];
				return next;
			});
		} catch (err) {
			addLog("error", (err as Error).message);
		}
	}

	async function handleClearSessions() {
		if (!confirm(t("confirm.clearSessions"))) return;
		try {
			const res = await fetch(`/projects/${projectId}/sessions/clear`, {
				method: "POST",
			});
			if (!res.ok) throw new Error((await res.json()).error);
			setLastCostUsd(null);
			setLastTurns(null);
			setLastInputTokens(null);
			setLastCacheCreationTokens(null);
			setLastCacheReadTokens(null);
			setLastOutputTokens(null);
			setLogs([]);
			addLog("lifecycle", "Session history cleared");
		} catch (err) {
			addLog("error", (err as Error).message);
		}
	}

	async function handleContinueTask(msg?: string) {
		if (!selectedTaskId) return;
		try {
			await continueTask(selectedTaskId, msg);
			addLog(
				"task_started",
				`↳ Continued: ${selectedNode?.title}`,
				selectedTaskId,
			);
			await refreshTasks();
		} catch (err) {
			addLog("error", (err as Error).message);
		}
	}

	async function handleDeleteTask() {
		if (!selectedTaskId || !selectedNode) return;
		if (!confirm(t("confirm.deleteTask", { title: selectedNode.title })))
			return;
		try {
			await deleteTask(selectedTaskId);
			addLog("lifecycle", `Deleted: ${selectedNode.title}`);
			setSelectedTaskId(null);
			await refreshTasks();
		} catch (err) {
			addLog("error", (err as Error).message);
		}
	}

	async function handleAddProject(e: React.FormEvent) {
		e.preventDefault();
		const path = newProjectPath.trim();
		if (!path) return;
		try {
			const project = await initProject(path);
			setProjectId(project.id);
			setNewProjectPath("");
			setShowAddProject(false);
		} catch (err) {
			addLog("error", (err as Error).message);
		}
	}

	async function handleDeleteProject() {
		if (!projectId) return;
		const project = projects.find((p) => p.id === projectId);
		if (
			!confirm(t("confirm.removeProject", { name: project?.name ?? projectId }))
		)
			return;
		try {
			await deleteProject(projectId);
			setProjectId("");
			setSelectedTaskId(null);
			setLogs([]);
		} catch (err) {
			addLog("error", (err as Error).message);
		}
	}

	async function handleAddTask() {
		if (!projectId) return;
		const title = window.prompt(t("prompt.taskTitle"));
		if (!title) return;
		const description = window.prompt(t("prompt.taskDescription")) ?? "";
		const body: Record<string, string> = { title, description };
		if (selectedTaskId && !isOrchestratorNode) body.parentId = selectedTaskId;
		try {
			const res = await fetch(`/projects/${projectId}/tasks`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok)
				throw new Error(((await res.json()) as { error: string }).error);
			await refreshTasks();
		} catch (err) {
			addLog("error", (err as Error).message);
		}
	}

	// Compute activity filter label
	const filterLabel = isOrchestratorNode
		? t("orch.label")
		: selectedNode
			? selectedNode.title
			: null;

	return (
		<>
			{/* ── Header ── */}
			<header className="og-header">
				<div className="og-header-brand">
					<div className="og-logo">
						<IconHexagon size={14} />
					</div>
					<span className="og-header-title">{t("header.title")}</span>
					<div
						className={`og-connection-badge${connected ? " connected" : ""}`}
					>
						<span className="og-connection-dot" />
						{connected ? t("header.connected") : t("header.disconnected")}
					</div>
				</div>

				<div className="og-header-right">
					{showAddProject ? (
						<form
							onSubmit={handleAddProject}
							style={{ display: "flex", alignItems: "center", gap: "6px" }}
						>
							<input
								className="og-continue-input"
								type="text"
								placeholder={t("project.pathPlaceholder")}
								value={newProjectPath}
								onChange={(e) => setNewProjectPath(e.target.value)}
								style={{ width: "220px" }}
							/>
							<button
								type="submit"
								className="og-btn og-btn-primary"
								style={{ fontSize: "12px", padding: "4px 10px" }}
							>
								{t("project.add")}
							</button>
							<button
								type="button"
								className="og-btn-icon"
								title={t("project.cancel")}
								onClick={() => {
									setShowAddProject(false);
									setNewProjectPath("");
								}}
							>
								<IconClose size={11} />
							</button>
						</form>
					) : (
						<>
							{projects.length > 0 && (
								<select
									className="og-select"
									value={projectId}
									onChange={(e) => {
										setProjectId(e.target.value);
										setSelectedTaskId(null);
										setLogs([]);
									}}
								>
									{projects.map((p) => (
										<option key={p.id} value={p.id}>
											{p.name}
										</option>
									))}
								</select>
							)}
							{projects.length === 0 && (
								<span style={{ fontSize: "12px", color: "var(--text-faint)" }}>
									{t("project.noProjects")}
								</span>
							)}
							{projectId && (
								<button
									type="button"
									className="og-btn-icon"
									title={t("project.remove")}
									onClick={handleDeleteProject}
								>
									<IconTrash size={13} />
								</button>
							)}
							<button
								type="button"
								className="og-btn-icon"
								title={t("project.addProject")}
								onClick={() => setShowAddProject(true)}
							>
								<IconPlus size={14} />
							</button>
						</>
					)}
					{projectId && (
						<button
							type="button"
							className={`og-btn-icon${showSettings ? " active" : ""}`}
							title={t("project.settings")}
							aria-label={t("project.settings")}
							onClick={() => setShowSettings((s) => !s)}
						>
							<IconGear size={14} />
						</button>
					)}
					<button
						type="button"
						className="og-btn-icon og-lang-toggle"
						title={t("lang.toggle")}
						aria-label={t("lang.toggle")}
						onClick={() => setLocale(locale === "en" ? "zh" : "en")}
					>
						{locale === "en" ? "中" : "EN"}
					</button>
					<select
						className="og-theme-select"
						value={theme}
						onChange={(e) => setThemeState(e.target.value as typeof theme)}
						title={t("theme.selector")}
						aria-label={t("theme.selector")}
					>
						<option value="dark">{t("theme.dark")}</option>
						<option value="light">{t("theme.light")}</option>
						<option value="cute-light">{t("theme.cuteLight")}</option>
						<option value="cute-dark">{t("theme.cuteDark")}</option>
					</select>
				</div>
			</header>

			{/* ── Settings Panel ── */}
			{showSettings && projectId && (
				<div className="og-settings-panel">
					<div className="og-settings-header">
						<span className="og-settings-title">{t("settings.title")}</span>
						<button
							type="button"
							className="og-btn-icon"
							onClick={() => setShowSettings(false)}
						>
							<IconClose size={11} />
						</button>
					</div>
					<label className="og-settings-field">
						<span className="og-settings-label">{t("settings.model")}</span>
						<select
							className="og-select"
							value={(projectConfig.model as string) || ""}
							onChange={(e) => updateConfig({ model: e.target.value || null })}
						>
							<option value="">{t("settings.default")}</option>
							<option value="claude-sonnet-4-6">{t("model.sonnet")}</option>
							<option value="claude-opus-4-6">{t("model.opus")}</option>
							<option value="claude-haiku-4-5-20251001">
								{t("model.haiku")}
							</option>
						</select>
					</label>
					<label className="og-settings-field">
						<span className="og-settings-label">
							{t("settings.childModel")}
						</span>
						<select
							className="og-select"
							value={(projectConfig.childModel as string) || ""}
							onChange={(e) =>
								updateConfig({ childModel: e.target.value || null })
							}
						>
							<option value="">{t("settings.default")}</option>
							<option value="claude-sonnet-4-6">{t("model.sonnet")}</option>
							<option value="claude-opus-4-6">{t("model.opus")}</option>
							<option value="claude-haiku-4-5-20251001">
								{t("model.haiku")}
							</option>
						</select>
					</label>
					<label className="og-settings-field">
						<span className="og-settings-label">{t("settings.budget")}</span>
						<input
							type="number"
							className="og-settings-input"
							placeholder={t("settings.unlimited")}
							min="0"
							step="0.01"
							value={
								projectConfig.budgetUsd != null
									? String(projectConfig.budgetUsd)
									: ""
							}
							onChange={(e) =>
								updateConfig({
									budgetUsd: e.target.value ? Number(e.target.value) : null,
								})
							}
						/>
					</label>
					<label className="og-settings-field">
						<span className="og-settings-label">
							{t("settings.clarifyTimeout")}
						</span>
						<input
							type="number"
							className="og-settings-input"
							placeholder={t("settings.noTimeout")}
							min="0"
							step="1000"
							value={
								projectConfig.clarifyTimeoutMs != null
									? String(projectConfig.clarifyTimeoutMs)
									: ""
							}
							onChange={(e) =>
								updateConfig({
									clarifyTimeoutMs: e.target.value
										? Number(e.target.value)
										: null,
								})
							}
						/>
					</label>
					<label className="og-settings-field">
						<span className="og-settings-label">{t("settings.maxDepth")}</span>
						<input
							type="number"
							className="og-settings-input"
							placeholder={t("settings.maxDepthDefault")}
							min="1"
							max="10"
							step="1"
							value={
								projectConfig.maxDepth != null
									? String(projectConfig.maxDepth)
									: ""
							}
							onChange={(e) =>
								updateConfig({
									maxDepth: e.target.value ? Number(e.target.value) : null,
								})
							}
						/>
					</label>
					{running && (
						<div className="og-settings-field">
							<span className="og-settings-label">
								{t("settings.restartHint")}
							</span>
							<button
								type="button"
								className="og-btn og-btn-warning og-btn-sm"
								onClick={async () => {
									try {
										await restartAgent();
										addLog("lifecycle", "Agent restarting…");
									} catch (err) {
										addLog("error", (err as Error).message);
									}
								}}
							>
								<IconRefresh size={12} /> {t("settings.restartAgent")}
							</button>
						</div>
					)}
				</div>
			)}

			{/* ── Main ── */}
			<main className="og-main">
				{/* Left Sidebar */}
				<aside className="og-sidebar">
					<div className="og-panel-header">
						<span className="og-panel-title">{t("tasks.title")}</span>
						<div className="og-panel-actions">
							{selectedTaskId && (
								<>
									<span className="og-filter-chip" title={filterLabel ?? ""}>
										{filterLabel}
									</span>
									<button
										type="button"
										className="og-btn-icon"
										onClick={() => setSelectedTaskId(null)}
										data-tip={t("tasks.clearFilter")}
									>
										<IconClose size={11} />
									</button>
								</>
							)}
							<button
								type="button"
								className="og-btn-icon"
								onClick={handleAddTask}
								data-tip={t("tasks.addTask")}
							>
								<IconPlus size={13} />
							</button>
							<button
								type="button"
								className="og-btn-icon"
								onClick={() => {
									refreshTasks();
									refreshProjects();
								}}
								data-tip={t("tasks.refresh")}
							>
								<IconRefresh size={13} />
							</button>
						</div>
					</div>

					<TaskTree
						nodes={nodes}
						selectedTaskId={selectedTaskId}
						onSelect={setSelectedTaskId}
						running={running}
					/>
				</aside>

				{/* Right Content */}
				<section
					className={`og-content${isDragging ? " dragging" : ""}`}
					ref={contentPanelRef}
				>
					{/* Top: Detail panel */}
					<div
						className="og-detail-panel"
						style={{ flex: splitRatio, minHeight: 0 }}
					>
						<div className="og-panel-header">
							<span className="og-panel-title">
								{isOrchestratorNode
									? t("orch.label")
									: selectedNode
										? t("detail.title")
										: t("detail.details")}
							</span>
						</div>

						{isOrchestratorNode ? (
							<OrchestratorDetail
								running={running}
								nodeCount={nodes.length}
								nodes={nodes}
								costUsd={lastCostUsd}
								totalCost={totalCost}
								turns={lastTurns}
								inputTokens={lastInputTokens}
								cacheCreationTokens={lastCacheCreationTokens}
								cacheReadTokens={lastCacheReadTokens}
								outputTokens={lastOutputTokens}
								provider={agentProvider}
								model={agentModel}
								onClearSessions={handleClearSessions}
							/>
						) : selectedNode ? (
							<TaskDetail
								node={selectedNode}
								projectId={projectId}
								onContinue={handleContinueTask}
								onDelete={handleDeleteTask}
							/>
						) : (
							<div className="og-detail-empty">
								<IconHexagon size={28} />
								<span>{t("detail.selectTask")}</span>
							</div>
						)}
					</div>

					{/* Resize divider */}
					{/* biome-ignore lint/a11y/noStaticElementInteractions: resize handle */}
					<div
						className="og-resize-divider"
						onMouseDown={handleDividerMouseDown}
					/>

					{/* Bottom: Activity panel */}
					<div className="og-activity-panel" style={{ flex: 1 - splitRatio }}>
						<div className="og-panel-header">
							<span className="og-panel-title">
								{t("activity.title")}
								{filterLabel && (
									<span
										style={{
											color: "var(--text-faint)",
											marginLeft: "6px",
											fontSize: "10px",
											fontWeight: 400,
											textTransform: "none",
											letterSpacing: 0,
										}}
									>
										— {filterLabel}
									</span>
								)}
							</span>
							<div className="og-panel-actions">
								{!autoScroll && (
									<button
										type="button"
										className="og-scroll-follow-btn"
										onClick={() => setAutoScroll(true)}
									>
										<IconArrowDown size={10} />
										{t("activity.follow")}
									</button>
								)}
							</div>
						</div>
						<ActivityLog
							entries={logs}
							filterTaskId={selectedTaskId}
							nodeMap={nodeMap}
							autoScroll={autoScroll}
							onAutoScrollChange={setAutoScroll}
						/>
					</div>
				</section>
			</main>

			{/* ── Footer ── */}
			<footer className="og-footer">
				{/* Pending clarifications — shown above footer when agent called clarify() */}
				{pendingClarifications.length > 0 && (
					<div className="og-clarifications">
						{pendingClarifications.map((c) => {
							const taskTitle =
								nodeMap.get(c.taskId)?.title ?? c.taskId.slice(0, 8);
							return (
								<div key={c.id} className="og-clarification-card">
									<div className="og-clarification-header">
										<span className="og-clarification-badge">
											❓ {t("clarify.needed")}
										</span>
										<span className="og-clarification-task">
											{t("clarify.from")} {taskTitle}
										</span>
									</div>
									<p className="og-clarification-question">{c.question}</p>
									<form
										className="og-clarification-form"
										onSubmit={(e) => {
											e.preventDefault();
											handleClarifySubmit(c.taskId);
										}}
									>
										<input
											type="text"
											className="og-clarification-input"
											placeholder={t("clarify.placeholder")}
											value={clarifyAnswers[c.taskId] ?? ""}
											onChange={(e) =>
												setClarifyAnswers((prev) => ({
													...prev,
													[c.taskId]: e.target.value,
												}))
											}
											// biome-ignore lint/a11y/noAutofocus: clarification input should grab focus immediately
											autoFocus
										/>
										<button
											type="submit"
											className="og-btn-run"
											disabled={!clarifyAnswers[c.taskId]?.trim()}
										>
											{t("clarify.answer")}
										</button>
									</form>
								</div>
							);
						})}
					</div>
				)}
				{(() => {
					const filtered = pendingMessages.filter((m) =>
						targetNodeId ? m.taskId === targetNodeId : m.taskId === null,
					);
					return (
						filtered.length > 0 && (
							<div className="og-pending-messages">
								<span className="og-pending-label">{t("pending.label")}</span>
								{filtered.map((m) => (
									<span key={m.id} className="og-pending-chip">
										{m.text.length > 30 ? `${m.text.slice(0, 30)}…` : m.text}
									</span>
								))}
							</div>
						)
					);
				})()}
				{running && targetNodeId && (
					<div className="og-message-target">
						<span className="og-message-target-label">
							→ {t("target.sendingTo")}{" "}
							<strong>
								{nodeMap.get(targetNodeId)?.title ?? targetNodeId.slice(0, 8)}
							</strong>
						</span>
					</div>
				)}
				<form className="og-footer-form" onSubmit={handleSubmit}>
					<input
						type="text"
						className="og-prompt-input"
						value={prompt}
						onChange={(e) => setPrompt(e.target.value)}
						placeholder={
							running && targetNodeId
								? t("footer.messageToTask", {
										task: nodeMap.get(targetNodeId)?.title ?? "task",
									})
								: running
									? t("footer.sendMessage")
									: t("footer.describeBuild")
						}
						disabled={!projectId}
					/>
					<div className="og-footer-controls">
						{running ? (
							<>
								<button
									type="submit"
									className="og-btn-run"
									disabled={!projectId || !prompt.trim()}
								>
									<IconSend size={13} />
									{t("footer.send")}
								</button>
								<button
									type="button"
									className="og-btn-stop-lg"
									onClick={handleStop}
								>
									<IconStop size={13} />
									{t("footer.stop")}
								</button>
							</>
						) : (
							<button
								type="submit"
								className="og-btn-run"
								disabled={!projectId || !prompt.trim()}
							>
								<IconPlay size={13} />
								{t("footer.run")}
							</button>
						)}
					</div>
				</form>
			</footer>

			{/* Cute mode cat */}
			{theme.startsWith("cute-") && <CuteCat />}
		</>
	);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatArgs(input: Record<string, unknown> | undefined): string {
	if (!input) return "";
	const parts = Object.entries(input).map(([k, v]) => {
		const val = typeof v === "string" ? v : JSON.stringify(v);
		return `${k}=${val.length > 40 ? `${val.slice(0, 40)}…` : val}`;
	});
	const joined = parts.join(", ");
	return joined.length > 100 ? `${joined.slice(0, 100)}…` : joined;
}
