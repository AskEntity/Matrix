import { memo, useCallback, useMemo, useRef, useState } from "react";
import type { TaskStatus } from "../../src/types.ts";
import type { TaskNode } from "../hooks.ts";
import { useLocale } from "../i18n.ts";
import { IconChevron, IconEyeOff, IconHexagon, IconTrash } from "./icons.tsx";
import { statusDotClass } from "./StatusBadge.tsx";

/** Sort priority: lower = shown first */
const STATUS_PRIORITY: Record<TaskStatus, number> = {
	in_progress: 0,
	verify: 1,
	pending: 2,
	draft: 3,
	failed: 4,
	closed: 5,
};

/** Sort by status priority; within each status group, newest (last in original order) first. */
function sortByStatus(nodes: TaskNode[]): TaskNode[] {
	const indexMap = new Map(nodes.map((n, i) => [n.id, i]));
	return [...nodes].sort((a, b) => {
		const statusDiff =
			(STATUS_PRIORITY[a.status] ?? 9) - (STATUS_PRIORITY[b.status] ?? 9);
		if (statusDiff !== 0) return statusDiff;
		// Reverse original order within same status: higher original index = shown first
		return (indexMap.get(b.id) ?? 0) - (indexMap.get(a.id) ?? 0);
	});
}

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

export const TaskTree = memo(function TaskTree({
	nodes,
	selectedTaskId,
	rootNodeId,
	activeAgents,
	onSelect,
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
	activeAgents?: Set<string>;
	onSelect: (id: string | null) => void;
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
			// Show children of root node as top-level tasks, sorted by status
			const childOrder = rootNode.children;
			const nodeById = new Map(nodes.map((n) => [n.id, n]));
			const ordered = childOrder
				.map((id) => nodeById.get(id))
				.filter((n): n is TaskNode => n !== undefined);
			return sortByStatus(ordered);
		}
		// Fallback: filter out root nodes (nodes with no parent that are parents of others)
		// This prevents the root orchestrator node from flickering on initial render
		// before rootNodeId is received via WebSocket
		const parentIds = new Set(nodes.map((n) => n.parentId).filter(Boolean));
		return sortByStatus(
			nodes.filter((n) => !n.parentId && !parentIds.has(n.id)),
		);
	}, [nodes, rootNode]);

	const childMap = useMemo(() => {
		const map = new Map<string, TaskNode[]>();
		const nodeById = new Map(nodes.map((n) => [n.id, n]));
		// Build children lists sorted by status priority
		for (const n of nodes) {
			if (n.children.length > 0) {
				const ordered = n.children
					.map((id) => nodeById.get(id))
					.filter((c): c is TaskNode => c !== undefined);
				map.set(n.id, sortByStatus(ordered));
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
	const [hideCompleted, setHideCompleted] = useState(
		() => localStorage.getItem("mxd-hide-closed") === "true",
	);

	/** Set of node IDs that should be hidden because they (or an ancestor) are completed */
	const completedIds = useMemo((): Set<string> | null => {
		if (!hideCompleted) return null;
		const hidden = new Set<string>();
		// First pass: mark completed nodes
		for (const node of nodes) {
			if (node.status === "closed" || node.status === "failed") {
				hidden.add(node.id);
			}
		}
		// Second pass: mark all descendants of completed nodes
		const addDescendants = (id: string) => {
			const children = nodes.filter((n) => n.parentId === id);
			for (const child of children) {
				hidden.add(child.id);
				addDescendants(child.id);
			}
		};
		for (const id of [...hidden]) {
			addDescendants(id);
		}
		return hidden;
	}, [nodes, hideCompleted]);

	const matchingIds = useMemo((): Set<string> | null => {
		const trimmed = taskFilter.trim();
		if (!trimmed && !completedIds) return null; // null = show all
		const matched = new Set<string>();
		const lower = trimmed.toLowerCase();
		for (const node of nodes) {
			// Skip completed nodes when hiding
			if (completedIds?.has(node.id)) continue;
			// Apply text filter if present (matches title, description, or task ID prefix)
			if (
				trimmed &&
				!node.title.toLowerCase().includes(lower) &&
				!node.description?.toLowerCase().includes(lower) &&
				!node.id.toLowerCase().includes(lower)
			)
				continue;
			// Include this node AND all its ancestors
			let current: TaskNode | undefined = node;
			while (current) {
				if (!completedIds?.has(current.id)) {
					matched.add(current.id);
				}
				current = current.parentId ? nodeMap.get(current.parentId) : undefined;
			}
		}
		return matched;
	}, [nodes, taskFilter, nodeMap, completedIds]);

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
	const hasTextFilter = taskFilter.trim().length > 0;
	const filteredRoots = matchingIds
		? roots.filter((r) => matchingIds.has(r.id))
		: roots;

	// Parent ID for top-level tasks (roots)
	const topLevelParentId = rootNodeId ?? "";
	const topLevelSiblingIds = roots.map((r) => r.id);

	return (
		<div className="mxd-task-tree">
			{/* Non-scrolling header area */}
			<div className="mxd-tree-header">
				{/* Search bar */}
				<div className="mxd-tree-search-bar">
					<input
						type="text"
						className="mxd-tree-search"
						placeholder={t("tasks.filter")}
						value={taskFilter}
						onChange={(e) => setTaskFilter(e.target.value)}
					/>
					<button
						type="button"
						className={`mxd-hide-completed-btn${hideCompleted ? " active" : ""}`}
						onClick={() =>
							setHideCompleted((v) => {
								const next = !v;
								localStorage.setItem("mxd-hide-closed", String(next));
								return next;
							})
						}
						title={t("tasks.hideCompleted")}
					>
						<IconEyeOff size={12} />
					</button>
				</div>

				{/* Orchestrator row */}
				<button
					type="button"
					className={`mxd-orch-node${isOrchestratorSelected ? " selected" : ""}`}
					onClick={(e) => {
						e.stopPropagation();
						onSelect(rootNodeId);
					}}
				>
					<span className="mxd-orch-icon">
						<IconHexagon size={14} />
					</span>
					<span className="mxd-orch-label">{t("orch.label")}</span>
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

				{roots.length > 0 && <div className="mxd-sidebar-divider" />}
			</div>

			{/* Scrollable task list */}
			<div className="mxd-task-list">
				{filteredRoots.map((root, i) => (
					<TaskNodeView
						key={root.id}
						node={root}
						childMap={childMap}
						depth={0}
						selectedTaskId={selectedTaskId}
						rootNodeId={rootNodeId}
						activeAgents={activeAgents}
						onSelect={onSelect}
						collapsed={collapsed}
						toggleCollapse={toggleCollapse}
						matchingIds={matchingIds}
						hasTextFilter={hasTextFilter}
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
					<div className="mxd-empty-state">
						<span className="mxd-empty-icon">
							<IconHexagon size={24} />
						</span>
						<span>{t("tasks.noTasks")}</span>
						<span style={{ color: "var(--text-faint)", fontSize: "11px" }}>
							{t("tasks.sendMessage")}
						</span>
					</div>
				)}

				{roots.length > 0 && filteredRoots.length === 0 && taskFilter && (
					<div className="mxd-tree-empty">
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
		</div>
	);
});

function TaskNodeView({
	node,
	childMap,
	depth,
	selectedTaskId,
	rootNodeId,
	activeAgents,
	onSelect,
	collapsed,
	toggleCollapse,
	matchingIds,
	hasTextFilter,
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
	activeAgents?: Set<string>;
	onSelect: (id: string | null) => void;
	collapsed: Set<string>;
	toggleCollapse: (id: string) => void;
	matchingIds: Set<string> | null;
	hasTextFilter: boolean;
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
	// When text filter is active, force-expand all ancestor nodes so matches are visible.
	// When only hiding completed (no text filter), allow normal collapse behavior.
	const isCollapsed = hasTextFilter ? false : collapsed.has(node.id);

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
					className="mxd-drop-indicator"
					style={{ marginLeft: `${12 + depth * 10}px` }}
				/>
			)}
			<button
				type="button"
				className={`mxd-task-node${isSelected ? " selected" : ""}${node.status === "draft" ? " mxd-task-draft" : ""}${isDragging ? " mxd-task-dragging" : ""}${isReparentTarget ? " mxd-reparent-target" : ""}${node.status === "closed" ? " mxd-task-closed" : ""}`}
				style={node.color ? { borderLeftColor: node.color } : undefined}
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
					className="mxd-task-row"
					style={{ paddingLeft: `${12 + depth * 10}px` }}
				>
					{hasChildren ? (
						<button
							type="button"
							className="mxd-tree-toggle"
							onClick={(e) => {
								e.stopPropagation();
								toggleCollapse(node.id);
							}}
						>
							<IconChevron expanded={!isCollapsed} />
						</button>
					) : (
						<span className="mxd-tree-toggle-placeholder" />
					)}
					{activeAgents?.has(node.id) ? (
						<span className="mxd-task-spinner" />
					) : (
						<span
							className={`mxd-task-status-dot ${statusDotClass(node.status)}`}
						/>
					)}

					<span className="mxd-task-title">{node.title}</span>
					{node.status === "draft" && (
						<span className="mxd-task-draft-badge">draft</span>
					)}
				</div>
			</button>
			{showIndicatorAfter && (
				<div
					className="mxd-drop-indicator"
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
						activeAgents={activeAgents}
						onSelect={onSelect}
						collapsed={collapsed}
						toggleCollapse={toggleCollapse}
						matchingIds={matchingIds}
						hasTextFilter={hasTextFilter}
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
		<div className="mxd-task-node mxd-inline-create">
			<div className="mxd-task-row" style={{ paddingLeft: "22px" }}>
				<span className="mxd-tree-toggle-placeholder" />
				<span className="mxd-task-status-dot dot-pending" />
				<input
					ref={setRef}
					type="text"
					className="mxd-inline-create-input"
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
			className={`mxd-root-drop-zone${isOver ? " mxd-root-drop-over" : ""}`}
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
			<span className="mxd-root-drop-label">{t("tasks.moveToRoot")}</span>
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
			className={`mxd-trash-drop-zone${isOver ? " mxd-trash-over" : ""}`}
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
