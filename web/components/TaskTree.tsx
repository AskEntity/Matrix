import { useCallback, useMemo, useRef, useState } from "react";
import type { TaskNode } from "../hooks.ts";
import { useLocale } from "../i18n.ts";
import { IconChevron, IconHexagon, IconTrash } from "./icons.tsx";
import { statusDotClass } from "./StatusBadge.tsx";

interface DragState {
	/** ID of the node being dragged */
	dragId: string;
	/** Parent ID of the dragged node */
	parentId: string;
}

interface DropIndicator {
	/** Parent whose children list we're reordering */
	parentId: string;
	/** Insert before this child index (children.length = insert at end) */
	index: number;
}

type DropZone = "before" | "center" | "after";

export function TaskTree({
	nodes,
	selectedTaskId,
	rootNodeId,
	onSelect,
	running,
	onReorder,
	onReparent,
	isCreating,
	onCreateTask,
	onCancelCreate,
	onDeleteTask,
}: {
	nodes: TaskNode[];
	selectedTaskId: string | null;
	rootNodeId: string | null;
	onSelect: (id: string | null) => void;
	running: boolean;
	onReorder?: (parentId: string, children: string[]) => Promise<void>;
	onReparent?: (nodeId: string, newParentId: string) => Promise<void>;
	isCreating?: boolean;
	onCreateTask?: (title: string) => void;
	onCancelCreate?: () => void;
	onDeleteTask?: (taskId: string) => void;
}) {
	// Root node's children are the visible top-level tasks
	const rootNode = useMemo(
		() => (rootNodeId ? nodes.find((n) => n.id === rootNodeId) : undefined),
		[nodes, rootNodeId],
	);
	const roots = useMemo(() => {
		if (rootNode) {
			// Show children of root node as top-level tasks, preserving order
			const childOrder = rootNode.children;
			const nodeById = new Map(nodes.map((n) => [n.id, n]));
			return childOrder
				.map((id) => nodeById.get(id))
				.filter((n): n is TaskNode => n !== undefined);
		}
		// Fallback: filter out root nodes (nodes with no parent that are parents of others)
		// This prevents the root orchestrator node from flickering on initial render
		// before rootNodeId is received via WebSocket
		const parentIds = new Set(nodes.map((n) => n.parentId).filter(Boolean));
		return nodes.filter((n) => !n.parentId && !parentIds.has(n.id));
	}, [nodes, rootNode]);

	const childMap = useMemo(() => {
		const map = new Map<string, TaskNode[]>();
		const nodeById = new Map(nodes.map((n) => [n.id, n]));
		// Build children lists preserving the parent's children order
		for (const n of nodes) {
			if (n.children.length > 0) {
				const ordered = n.children
					.map((id) => nodeById.get(id))
					.filter((c): c is TaskNode => c !== undefined);
				map.set(n.id, ordered);
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

	// --- Drag-and-drop state ---
	const [dragState, setDragState] = useState<DragState | null>(null);
	const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(
		null,
	);
	const [reparentTargetId, setReparentTargetId] = useState<string | null>(null);

	/** Check if nodeId is the dragged node or an ancestor of it. */
	const isDescendantOfDragged = useCallback(
		(nodeId: string, dragId: string): boolean => {
			let current = nodeMap.get(nodeId);
			while (current) {
				if (current.id === dragId) return true;
				if (!current.parentId) return false;
				current = nodeMap.get(current.parentId);
			}
			return false;
		},
		[nodeMap],
	);

	const handleDragStart = useCallback(
		(nodeId: string, parentId: string, e: React.DragEvent) => {
			e.dataTransfer.effectAllowed = "move";
			e.dataTransfer.setData("text/plain", nodeId);
			// Use setTimeout so the dragged element renders before we set state
			setTimeout(() => setDragState({ dragId: nodeId, parentId }), 0);
		},
		[],
	);

	/** Determine which drop zone the cursor is in: top 30%, center 40%, bottom 30%. */
	const getDropZone = useCallback((e: React.DragEvent): DropZone => {
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const relY = e.clientY - rect.top;
		const ratio = relY / rect.height;
		if (ratio < 0.3) return "before";
		if (ratio > 0.7) return "after";
		return "center";
	}, []);

	const handleDragOver = useCallback(
		(
			targetNodeId: string,
			targetParentId: string,
			siblingIds: string[],
			e: React.DragEvent,
		) => {
			if (!dragState) return;
			if (dragState.dragId === targetNodeId) {
				e.preventDefault();
				e.dataTransfer.dropEffect = "move";
				setDropIndicator(null);
				setReparentTargetId(null);
				return;
			}

			const zone = getDropZone(e);

			if (zone === "center" && onReparent) {
				// Reparent mode — can't drop onto self or a descendant
				if (isDescendantOfDragged(targetNodeId, dragState.dragId)) return;
				e.preventDefault();
				e.dataTransfer.dropEffect = "move";
				setDropIndicator(null);
				setReparentTargetId(targetNodeId);
				return;
			}

			// Reorder mode — only within same parent
			if (dragState.parentId !== targetParentId) {
				setDropIndicator(null);
				setReparentTargetId(null);
				return;
			}

			e.preventDefault();
			e.dataTransfer.dropEffect = "move";
			setReparentTargetId(null);

			const targetIndex = siblingIds.indexOf(targetNodeId);
			const insertIndex = zone === "before" ? targetIndex : targetIndex + 1;
			setDropIndicator({ parentId: targetParentId, index: insertIndex });
		},
		[dragState, onReparent, getDropZone, isDescendantOfDragged],
	);

	const handleDragEnd = useCallback(() => {
		setDragState(null);
		setDropIndicator(null);
		setReparentTargetId(null);
	}, []);

	const handleDrop = useCallback(
		(
			_targetNodeId: string,
			targetParentId: string,
			siblingIds: string[],
			e: React.DragEvent,
		) => {
			e.preventDefault();
			if (!dragState) {
				handleDragEnd();
				return;
			}

			// Reparent drop
			if (reparentTargetId && onReparent) {
				const dragId = dragState.dragId;
				handleDragEnd();
				onReparent(dragId, reparentTargetId);
				return;
			}

			// Reorder drop
			if (!dropIndicator || !onReorder) {
				handleDragEnd();
				return;
			}
			if (dragState.parentId !== targetParentId) {
				handleDragEnd();
				return;
			}

			// Compute new order
			const oldOrder = [...siblingIds];
			const dragIndex = oldOrder.indexOf(dragState.dragId);
			if (dragIndex === -1) {
				handleDragEnd();
				return;
			}

			// Remove dragged item
			oldOrder.splice(dragIndex, 1);
			// Adjust insert index if needed
			let insertAt = dropIndicator.index;
			if (insertAt > dragIndex) insertAt--;
			// Insert at new position
			oldOrder.splice(insertAt, 0, dragState.dragId);

			// Only call API if order actually changed
			if (oldOrder.join(",") !== siblingIds.join(",")) {
				onReorder(targetParentId, oldOrder);
			}

			handleDragEnd();
		},
		[
			dragState,
			dropIndicator,
			reparentTargetId,
			onReorder,
			onReparent,
			handleDragEnd,
		],
	);

	const { t } = useLocale();
	const isOrchestratorSelected =
		!selectedTaskId || selectedTaskId === rootNodeId;
	const filteredRoots = matchingIds
		? roots.filter((r) => matchingIds.has(r.id))
		: roots;

	// Parent ID for top-level tasks (roots)
	const topLevelParentId = rootNodeId ?? "";
	const topLevelSiblingIds = roots.map((r) => r.id);

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
					onSelect(rootNodeId);
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

			{/* Root-level drop zone — visible only during drag for reparenting to root */}
			{dragState && rootNodeId && onReparent && (
				<RootDropZone
					rootNodeId={rootNodeId}
					dragId={dragState.dragId}
					dragParentId={dragState.parentId}
					onReparent={onReparent}
					onDragEnd={handleDragEnd}
				/>
			)}

			{roots.length > 0 && <div className="og-sidebar-divider" />}

			{filteredRoots.map((root, i) => (
				<TaskNodeView
					key={root.id}
					node={root}
					childMap={childMap}
					depth={1}
					selectedTaskId={selectedTaskId}
					rootNodeId={rootNodeId}
					onSelect={onSelect}
					collapsed={collapsed}
					toggleCollapse={toggleCollapse}
					matchingIds={matchingIds}
					dragState={dragState}
					dropIndicator={dropIndicator}
					reparentTargetId={reparentTargetId}
					parentId={topLevelParentId}
					siblingIds={topLevelSiblingIds}
					siblingIndex={i}
					onDragStart={handleDragStart}
					onDragOver={handleDragOver}
					onDragEnd={handleDragEnd}
					onDrop={handleDrop}
				/>
			))}

			{roots.length === 0 && (
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

			{roots.length > 0 && filteredRoots.length === 0 && taskFilter && (
				<div className="og-tree-empty">
					{t("tasks.noMatch")} "{taskFilter}"
				</div>
			)}

			{/* Inline task creation row */}
			{isCreating && (
				<InlineCreateRow
					onConfirm={(title) => onCreateTask?.(title)}
					onCancel={() => onCancelCreate?.()}
				/>
			)}

			{/* Trash drop zone — visible only while dragging */}
			{dragState && onDeleteTask && (
				<TrashDropZone
					onDrop={(taskId) => onDeleteTask(taskId)}
					onDragEnd={handleDragEnd}
				/>
			)}
		</div>
	);
}

function TaskNodeView({
	node,
	childMap,
	depth,
	selectedTaskId,
	rootNodeId,
	onSelect,
	collapsed,
	toggleCollapse,
	matchingIds,
	dragState,
	dropIndicator,
	reparentTargetId,
	parentId,
	siblingIds,
	siblingIndex,
	onDragStart,
	onDragOver,
	onDragEnd,
	onDrop,
}: {
	node: TaskNode;
	childMap: Map<string, TaskNode[]>;
	depth: number;
	selectedTaskId: string | null;
	rootNodeId: string | null;
	onSelect: (id: string | null) => void;
	collapsed: Set<string>;
	toggleCollapse: (id: string) => void;
	matchingIds: Set<string> | null;
	dragState: DragState | null;
	dropIndicator: DropIndicator | null;
	reparentTargetId: string | null;
	parentId: string;
	siblingIds: string[];
	siblingIndex: number;
	onDragStart: (nodeId: string, parentId: string, e: React.DragEvent) => void;
	onDragOver: (
		targetNodeId: string,
		targetParentId: string,
		siblingIds: string[],
		e: React.DragEvent,
	) => void;
	onDragEnd: () => void;
	onDrop: (
		targetNodeId: string,
		targetParentId: string,
		siblingIds: string[],
		e: React.DragEvent,
	) => void;
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

	const isDragging = dragState?.dragId === node.id;
	const isReparentTarget = reparentTargetId === node.id;
	// Show indicator before this node
	const showIndicatorBefore =
		dropIndicator &&
		dropIndicator.parentId === parentId &&
		dropIndicator.index === siblingIndex &&
		dragState?.parentId === parentId;
	// Show indicator after this node (only for last item)
	const showIndicatorAfter =
		dropIndicator &&
		dropIndicator.parentId === parentId &&
		dropIndicator.index === siblingIds.length &&
		siblingIndex === siblingIds.length - 1 &&
		dragState?.parentId === parentId;

	const childSiblingIds = children.map((c) => c.id);

	return (
		<>
			{showIndicatorBefore && (
				<div
					className="og-drop-indicator"
					style={{ marginLeft: `${12 + depth * 10}px` }}
				/>
			)}
			<button
				type="button"
				className={`og-task-node${isSelected ? " selected" : ""}${node.draft ? " og-task-draft" : ""}${isDragging ? " og-task-dragging" : ""}${isReparentTarget ? " og-reparent-target" : ""}`}
				draggable
				onDragStart={(e) => onDragStart(node.id, parentId, e)}
				onDragOver={(e) => onDragOver(node.id, parentId, siblingIds, e)}
				onDragEnd={onDragEnd}
				onDrop={(e) => onDrop(node.id, parentId, siblingIds, e)}
				onClick={(e) => {
					e.stopPropagation();
					onSelect(isSelected ? rootNodeId : node.id);
				}}
			>
				<div
					className="og-task-row"
					style={{ paddingLeft: `${12 + depth * 10}px` }}
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
					{node.color && (
						<span
							className="og-task-color-dot"
							style={{ backgroundColor: node.color }}
						/>
					)}
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
			{showIndicatorAfter && (
				<div
					className="og-drop-indicator"
					style={{ marginLeft: `${12 + depth * 10}px` }}
				/>
			)}
			{!isCollapsed &&
				children.map((child, i) => (
					<TaskNodeView
						key={child.id}
						node={child}
						childMap={childMap}
						depth={depth + 1}
						selectedTaskId={selectedTaskId}
						rootNodeId={rootNodeId}
						onSelect={onSelect}
						collapsed={collapsed}
						toggleCollapse={toggleCollapse}
						matchingIds={matchingIds}
						dragState={dragState}
						dropIndicator={dropIndicator}
						reparentTargetId={reparentTargetId}
						parentId={node.id}
						siblingIds={childSiblingIds}
						siblingIndex={i}
						onDragStart={onDragStart}
						onDragOver={onDragOver}
						onDragEnd={onDragEnd}
						onDrop={onDrop}
					/>
				))}
		</>
	);
}

// ── Inline creation input ────────────────────────────────────────────────

function InlineCreateRow({
	onConfirm,
	onCancel,
}: {
	onConfirm: (title: string) => void;
	onCancel: () => void;
}) {
	const [value, setValue] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	const composingRef = useRef(false);
	const { t } = useLocale();

	// Auto-focus when mounted
	const setRef = useCallback((el: HTMLInputElement | null) => {
		(inputRef as React.MutableRefObject<HTMLInputElement | null>).current = el;
		el?.focus();
	}, []);

	return (
		<div className="og-task-node og-inline-create">
			<div className="og-task-row" style={{ paddingLeft: "22px" }}>
				<span className="og-tree-toggle-placeholder" />
				<span className="og-task-status-dot dot-pending" />
				<input
					ref={setRef}
					type="text"
					className="og-inline-create-input"
					placeholder={t("prompt.taskTitle")}
					value={value}
					onChange={(e) => setValue(e.target.value)}
					onCompositionStart={() => {
						composingRef.current = true;
					}}
					onCompositionEnd={() => {
						composingRef.current = false;
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !composingRef.current) {
							e.preventDefault();
							const trimmed = value.trim();
							if (trimmed) onConfirm(trimmed);
						} else if (e.key === "Escape") {
							e.preventDefault();
							onCancel();
						}
					}}
					onBlur={() => {
						// If they click away without entering, cancel
						const trimmed = value.trim();
						if (trimmed) onConfirm(trimmed);
						else onCancel();
					}}
				/>
			</div>
		</div>
	);
}

// ── Root drop zone (reparent to root) ────────────────────────────────────

function RootDropZone({
	rootNodeId,
	dragId,
	dragParentId,
	onReparent,
	onDragEnd,
}: {
	rootNodeId: string;
	dragId: string;
	dragParentId: string;
	onReparent: (nodeId: string, newParentId: string) => Promise<void>;
	onDragEnd: () => void;
}) {
	const [isOver, setIsOver] = useState(false);
	const { t } = useLocale();

	// Only show if the dragged node is NOT already a direct child of root
	if (dragParentId === rootNodeId) return null;

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: drop target for drag-and-drop
		<div
			className={`og-root-drop-zone${isOver ? " og-root-drop-over" : ""}`}
			onDragOver={(e) => {
				e.preventDefault();
				e.dataTransfer.dropEffect = "move";
				setIsOver(true);
			}}
			onDragLeave={() => setIsOver(false)}
			onDrop={(e) => {
				e.preventDefault();
				onReparent(dragId, rootNodeId);
				setIsOver(false);
				onDragEnd();
			}}
		>
			<span className="og-root-drop-label">{t("tasks.moveToRoot")}</span>
		</div>
	);
}

// ── Trash drop zone ──────────────────────────────────────────────────────

function TrashDropZone({
	onDrop,
	onDragEnd,
}: {
	onDrop: (taskId: string) => void;
	onDragEnd: () => void;
}) {
	const [isOver, setIsOver] = useState(false);
	const { t } = useLocale();

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: drop target for drag-and-drop
		<div
			className={`og-trash-drop-zone${isOver ? " og-trash-over" : ""}`}
			onDragOver={(e) => {
				e.preventDefault();
				e.dataTransfer.dropEffect = "move";
				setIsOver(true);
			}}
			onDragLeave={() => setIsOver(false)}
			onDrop={(e) => {
				e.preventDefault();
				const taskId = e.dataTransfer.getData("text/plain");
				if (taskId) onDrop(taskId);
				setIsOver(false);
				onDragEnd();
			}}
		>
			<IconTrash size={14} />
			<span>{t("tasks.dropToDelete")}</span>
		</div>
	);
}
