import { useCallback, useMemo, useState } from "react";
import type { TaskNode } from "../hooks.ts";
import { useLocale } from "../i18n.ts";
import { PROJECT_NODE_ID } from "../types.ts";
import { IconChevron, IconHexagon } from "./icons.tsx";
import { statusDotClass } from "./StatusBadge.tsx";

export function TaskTree({
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
					onSelect(PROJECT_NODE_ID);
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
					{running ? (
						<span>{t("tasks.agentWorking")}</span>
					) : (
						<>
							<span>{t("tasks.noTasks")}</span>
							<span style={{ color: "var(--text-faint)", fontSize: "11px" }}>
								{t("tasks.startAgent")}
							</span>
						</>
					)}
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
				className={`og-task-node${isSelected ? " selected" : ""}${node.draft ? " og-task-draft" : ""}`}
				onClick={(e) => {
					e.stopPropagation();
					onSelect(isSelected ? PROJECT_NODE_ID : node.id);
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
					{node.draft && <span className="og-task-draft-badge">draft</span>}
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
