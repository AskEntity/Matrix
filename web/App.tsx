import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	createLogEntry,
	type LogEntry,
	type TaskNode,
	useAgent,
	useProjects,
	useTasks,
	useWebSocket,
} from "./hooks.ts";

const PROJECT_NODE_ID = "__project__";

// ── Helpers ────────────────────────────────────────────────────────────────

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
	const labels: Record<string, string> = {
		pending: "Pending",
		in_progress: "In Progress",
		testing: "Testing",
		passed: "Passed",
		failed: "Failed",
		stuck: "Stuck",
		idle: "Idle",
		running: "Running",
	};
	return (
		<span className={`og-status-badge ${status}`}>
			<span className="badge-dot" />
			{labels[status] ?? status}
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

function IconSun({ size = 14 }: { size?: number }) {
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
			<circle cx="12" cy="12" r="5" />
			<line x1="12" y1="1" x2="12" y2="3" />
			<line x1="12" y1="21" x2="12" y2="23" />
			<line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
			<line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
			<line x1="1" y1="12" x2="3" y2="12" />
			<line x1="21" y1="12" x2="23" y2="12" />
			<line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
			<line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
		</svg>
	);
}

function IconMoon({ size = 14 }: { size?: number }) {
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
			<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
		</svg>
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

	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	const toggleCollapse = useCallback((id: string) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	const isOrchestratorSelected = selectedTaskId === PROJECT_NODE_ID;

	return (
		<div className="og-task-tree">
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
				<span className="og-orch-label">Orchestrator</span>
				<span className={`og-orch-badge ${running ? "running" : "idle"}`}>
					{running ? "running" : "idle"}
				</span>
			</button>

			{nodes.length > 0 && <div className="og-sidebar-divider" />}

			{roots.map((root) => (
				<TaskNodeView
					key={root.id}
					node={root}
					childMap={childMap}
					depth={1}
					selectedTaskId={selectedTaskId}
					onSelect={onSelect}
					collapsed={collapsed}
					toggleCollapse={toggleCollapse}
				/>
			))}

			{nodes.length === 0 && (
				<div className="og-empty-state">
					<span className="og-empty-icon">
						<IconHexagon size={24} />
					</span>
					<span>No tasks yet</span>
					<span style={{ color: "var(--text-faint)", fontSize: "11px" }}>
						Start an agent to create tasks
					</span>
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
}: {
	node: TaskNode;
	childMap: Map<string, TaskNode[]>;
	depth: number;
	selectedTaskId: string | null;
	onSelect: (id: string | null) => void;
	collapsed: Set<string>;
	toggleCollapse: (id: string) => void;
}) {
	const isSelected = node.id === selectedTaskId;
	const children = childMap.get(node.id) ?? [];
	const hasChildren = children.length > 0;
	const isCollapsed = collapsed.has(node.id);

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

	const visible = useMemo(() => {
		if (!filterTaskId) return entries;
		if (filterTaskId === PROJECT_NODE_ID) {
			return entries.filter((e) => !e.taskId);
		}
		const descendantIds = new Set<string>();
		const collect = (id: string) => {
			descendantIds.add(id);
			const node = nodeMap.get(id);
			if (node?.children) {
				for (const childId of node.children) collect(childId);
			}
		};
		collect(filterTaskId);
		return entries.filter((e) => e.taskId && descendantIds.has(e.taskId));
	}, [entries, filterTaskId, nodeMap]);

	return (
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
					No events yet
				</div>
			)}
		</div>
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

	if (entry.type === "compact" && entry.checkpoint) {
		return (
			<div className="og-compact-boundary">
				<div className="og-compact-hint">
					↑ Content above is not visible to the agent
				</div>
				<div className="og-compact-bar">
					<span className="og-compact-label">◈ {entry.text}</span>
					<button
						type="button"
						className="og-compact-toggle"
						onClick={() => setExpanded(!expanded)}
					>
						{expanded ? "▼ Collapse" : "▶ Checkpoint"}
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
					<span className="og-user-prompt-label">You →</span>
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

// ── Task Detail ────────────────────────────────────────────────────────────

function TaskDetail({
	node,
	onContinue,
	onDelete,
}: {
	node: TaskNode;
	onContinue: (msg?: string) => void;
	onDelete: () => void;
}) {
	const [continueMsg, setContinueMsg] = useState("");
	const canContinue = node.status === "failed" || node.status === "stuck";

	return (
		<div className="og-detail-content">
			<div className="og-detail-title">
				<span
					className={`og-task-status-dot ${statusDotClass(node.status)}`}
					style={{ width: "10px", height: "10px", flexShrink: 0 }}
				/>
				{node.title}
			</div>

			{node.description && (
				<div className="og-detail-description">{node.description}</div>
			)}

			<div className="og-detail-grid">
				<div className="og-detail-field">
					<div className="og-detail-label">Status</div>
					<StatusBadge status={node.status} />
				</div>
				{node.branch && (
					<div className="og-detail-field">
						<div className="og-detail-label">Branch</div>
						<div className="og-detail-value mono">{node.branch}</div>
					</div>
				)}
				{node.worktreePath && (
					<div className="og-detail-field">
						<div className="og-detail-label">Worktree</div>
						<div className="og-detail-value mono" style={{ fontSize: "10px" }}>
							{node.worktreePath}
						</div>
					</div>
				)}
				{node.updatedAt && (
					<div className="og-detail-field">
						<div className="og-detail-label">Updated</div>
						<div className="og-detail-value">
							{new Date(node.updatedAt).toLocaleString()}
						</div>
					</div>
				)}
				{node.costUsd != null && node.costUsd > 0 && (
					<div className="og-detail-field">
						<div className="og-detail-label">Cost</div>
						<div className="og-detail-value mono">
							${node.costUsd.toFixed(4)}
						</div>
					</div>
				)}
				{node.message && (
					<div className="og-detail-field" style={{ width: "100%" }}>
						<div className="og-detail-label">Message</div>
						<div className="og-detail-value">{node.message}</div>
					</div>
				)}
			</div>

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
							placeholder="Instructions for retry…"
						/>
						<button type="submit" className="og-btn og-btn-warning og-btn-sm">
							<IconRepeat size={12} />
							Continue
						</button>
					</form>
				)}
				<button
					type="button"
					className="og-btn og-btn-danger og-btn-sm"
					onClick={onDelete}
				>
					<IconTrash size={12} />
					Delete
				</button>
			</div>
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
	onClearSessions,
}: {
	running: boolean;
	nodeCount: number;
	nodes: import("./hooks.ts").TaskNode[];
	costUsd?: number | null;
	totalCost?: number | null;
	turns?: number | null;
	onClearSessions?: () => void;
}) {
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
					<div className="og-orch-name">Orchestrator</div>
					<div className="og-orch-sub">Root agent session</div>
				</div>
			</div>
			<div className="og-stats-row">
				<div className="og-stat-card">
					<span className="og-stat-label">State</span>
					<span
						className={`og-stat-value ${running ? "running" : ""}`}
						style={{ fontSize: "14px" }}
					>
						{running ? (
							<span className="og-running-indicator">
								<span className="og-spinner" />
								Running
							</span>
						) : (
							"Idle"
						)}
					</span>
				</div>
				<div className="og-stat-card">
					<span className="og-stat-label">Tasks</span>
					<span className="og-stat-value">{nodeCount}</span>
				</div>
				{nodeCount > 0 && (
					<div className="og-stat-card">
						<span className="og-stat-label">Done</span>
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
						<span className="og-stat-label">Passed</span>
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
						<span className="og-stat-label">Active</span>
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
						<span className="og-stat-label">Failed</span>
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
						<span className="og-stat-label">Session</span>
						<span className="og-stat-value">${costUsd.toFixed(3)}</span>
					</div>
				)}
				{totalCost != null && totalCost > 0 && (
					<div className="og-stat-card">
						<span className="og-stat-label">Total Cost</span>
						<span className="og-stat-value">${totalCost.toFixed(3)}</span>
					</div>
				)}
				{turns != null && turns > 0 && (
					<div className="og-stat-card">
						<span className="og-stat-label">Turns</span>
						<span className="og-stat-value">{turns}</span>
					</div>
				)}
			</div>
			{!running && onClearSessions && (
				<div style={{ marginTop: "12px" }}>
					<button
						type="button"
						className="og-btn og-btn-sm og-btn-danger"
						onClick={onClearSessions}
					>
						<IconTrash size={12} />
						Clear Sessions
					</button>
				</div>
			)}
		</div>
	);
}

// ── Main App ───────────────────────────────────────────────────────────────

export function App() {
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
	const [logs, setLogs] = useState<LogEntry[]>([]);
	const [prompt, setPrompt] = useState("");
	const [model, setModel] = useState("claude-opus-4-6");
	const [childModel, setChildModel] = useState("claude-opus-4-6");
	const [splitRatio, setSplitRatio] = useState(0.35);
	const [isDragging, setIsDragging] = useState(false);
	const [autoScroll, setAutoScroll] = useState(true);
	const [isDark, setIsDark] = useState(() => {
		return localStorage.getItem("og-theme") !== "light";
	});
	const [pendingMessages, setPendingMessages] = useState<
		{ id: number; text: string }[]
	>([]);
	const contentPanelRef = useRef<HTMLElement>(null);

	const { nodes, refresh: refreshTasks, updateFromWS } = useTasks(projectId);
	const {
		running,
		setRunning,
		start,
		stop,
		checkStatus,
		continueTask,
		deleteTask,
		sendMessage,
		sendMessageToTask,
	} = useAgent(projectId);

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
		document.documentElement.classList.toggle("light-mode", !isDark);
		localStorage.setItem("og-theme", isDark ? "dark" : "light");
	}, [isDark]);

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
						const acknowledgedTexts: string[] = [];
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
									acknowledgedTexts.push(msgText);
								} else {
									logType = "queue_message";
								}
								addLog(logType, msgText, taskId);
							}
						}
						// Remove acknowledged messages from pending
						if (acknowledgedTexts.length > 0) {
							setPendingMessages((prev) => {
								const remaining = [...prev];
								for (const ack of acknowledgedTexts) {
									const idx = remaining.findIndex((p) => p.text === ack);
									if (idx !== -1) remaining.splice(idx, 1);
								}
								return remaining;
							});
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
				case "task_started":
					addLog(
						"task_started",
						`↳ Started: ${msg.title}`,
						msg.taskId as string,
					);
					break;
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
			}
		},
		[addLog, updateFromWS, setRunning],
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

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!prompt.trim() || !projectId) return;
		try {
			if (running) {
				if (targetNodeId) {
					// Send to specific agent's queue
					await sendMessageToTask(targetNodeId, prompt.trim());
					const targetNode = nodeMap.get(targetNodeId);
					const targetLabel = targetNode?.title ?? targetNodeId.slice(0, 8);
					addLog(
						"lifecycle",
						`Message queued to "${targetLabel}": ${prompt.trim()}`,
					);
				} else {
					await sendMessage(prompt.trim());
					addLog("lifecycle", `Message queued: ${prompt.trim()}`);
				}
				setPendingMessages((prev) => [
					...prev,
					{ id: Date.now(), text: prompt.trim() },
				]);
			} else {
				await start({
					prompt: prompt.trim(),
					model: model || undefined,
					childModel: childModel || undefined,
				});
			}
			setPrompt("");
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

	async function handleClearSessions() {
		if (
			!confirm(
				"Clear session history? The orchestrator will start fresh next time.",
			)
		)
			return;
		try {
			const res = await fetch(`/projects/${projectId}/sessions/clear`, {
				method: "POST",
			});
			if (!res.ok) throw new Error((await res.json()).error);
			setLastCostUsd(null);
			setLastTurns(null);
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
		if (!confirm(`Delete task "${selectedNode.title}"?`)) return;
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
		if (!confirm(`Remove project "${project?.name ?? projectId}"?`)) return;
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
		const title = window.prompt("Task title:");
		if (!title) return;
		const description = window.prompt("Description:") ?? "";
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
		? "Orchestrator"
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
					<span className="og-header-title">OpenGraft</span>
					<div
						className={`og-connection-badge${connected ? " connected" : ""}`}
					>
						<span className="og-connection-dot" />
						{connected ? "Connected" : "Disconnected"}
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
								placeholder="Project path…"
								value={newProjectPath}
								onChange={(e) => setNewProjectPath(e.target.value)}
								style={{ width: "220px" }}
							/>
							<button
								type="submit"
								className="og-btn og-btn-primary"
								style={{ fontSize: "12px", padding: "4px 10px" }}
							>
								Add
							</button>
							<button
								type="button"
								className="og-btn-icon"
								title="Cancel"
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
									No projects
								</span>
							)}
							{projectId && (
								<button
									type="button"
									className="og-btn-icon"
									title="Remove project"
									onClick={handleDeleteProject}
								>
									<IconTrash size={13} />
								</button>
							)}
							<button
								type="button"
								className="og-btn-icon"
								title="Add project"
								onClick={() => setShowAddProject(true)}
							>
								<IconPlus size={14} />
							</button>
						</>
					)}
					<button
						type="button"
						className="og-btn-icon"
						title={isDark ? "Switch to light mode" : "Switch to dark mode"}
						aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
						onClick={() => setIsDark((d) => !d)}
					>
						{isDark ? <IconSun size={14} /> : <IconMoon size={14} />}
					</button>
				</div>
			</header>

			{/* ── Main ── */}
			<main className="og-main">
				{/* Left Sidebar */}
				<aside className="og-sidebar">
					<div className="og-panel-header">
						<span className="og-panel-title">Tasks</span>
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
										data-tip="Clear filter"
									>
										<IconClose size={11} />
									</button>
								</>
							)}
							<button
								type="button"
								className="og-btn-icon"
								onClick={handleAddTask}
								data-tip="Add task"
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
								data-tip="Refresh"
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
									? "Orchestrator"
									: selectedNode
										? "Task Details"
										: "Details"}
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
								onClearSessions={handleClearSessions}
							/>
						) : selectedNode ? (
							<TaskDetail
								node={selectedNode}
								onContinue={handleContinueTask}
								onDelete={handleDeleteTask}
							/>
						) : (
							<div className="og-detail-empty">
								<IconHexagon size={28} />
								<span>Select a task to view details</span>
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
								Activity
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
										Follow
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
				{pendingMessages.length > 0 && (
					<div className="og-pending-messages">
						<span className="og-pending-label">Pending:</span>
						{pendingMessages.map((m) => (
							<span key={m.id} className="og-pending-chip">
								{m.text.length > 30 ? `${m.text.slice(0, 30)}…` : m.text}
								<button
									type="button"
									className="og-pending-chip-dismiss"
									onClick={() =>
										setPendingMessages((prev) =>
											prev.filter((p) => p.id !== m.id),
										)
									}
									title="Dismiss"
								>
									×
								</button>
							</span>
						))}
					</div>
				)}
				{running && targetNodeId && (
					<div className="og-message-target">
						<span className="og-message-target-label">
							→ Sending to:{" "}
							<strong>
								{nodeMap.get(targetNodeId)?.title ?? targetNodeId.slice(0, 8)}
							</strong>
						</span>
						<button
							type="button"
							className="og-btn-icon"
							onClick={() => setTargetNodeId(null)}
							title="Send to orchestrator instead"
						>
							<IconClose size={11} />
						</button>
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
								? `Message to "${nodeMap.get(targetNodeId)?.title ?? "task"}"…`
								: running
									? "Send a message to the agent…"
									: "Describe what to build…"
						}
						disabled={!projectId}
					/>
					<div className="og-footer-controls">
						<select
							className="og-select"
							value={model}
							onChange={(e) => setModel(e.target.value)}
							title="Model"
						>
							<option value="">Model</option>
							<option value="claude-sonnet-4-6">Sonnet</option>
							<option value="claude-opus-4-6">Opus</option>
							<option value="claude-haiku-4-5-20251001">Haiku</option>
						</select>
						<select
							className="og-select"
							value={childModel}
							onChange={(e) => setChildModel(e.target.value)}
							title="Child model"
						>
							<option value="">Child</option>
							<option value="claude-sonnet-4-6">Sonnet</option>
							<option value="claude-opus-4-6">Opus</option>
							<option value="claude-haiku-4-5-20251001">Haiku</option>
						</select>
						{running ? (
							<>
								<button
									type="submit"
									className="og-btn-run"
									disabled={!projectId || !prompt.trim()}
								>
									<IconSend size={13} />
									Send
								</button>
								<button
									type="button"
									className="og-btn-stop-lg"
									onClick={handleStop}
								>
									<IconStop size={13} />
									Stop
								</button>
							</>
						) : (
							<button
								type="submit"
								className="og-btn-run"
								disabled={!projectId || !prompt.trim()}
							>
								<IconPlay size={13} />
								Run
							</button>
						)}
					</div>
				</form>
			</footer>
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
