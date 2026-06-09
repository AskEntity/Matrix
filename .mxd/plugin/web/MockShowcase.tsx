/**
 * MockShowcase — standalone page for rendering all card types + task states.
 *
 * Activated by navigating to `/<projectId>/matrix/mock-showcase`.
 * Fetches static data from `/api/matrix/mock-showcase` (matrix plugin route)
 * and renders it using the same components as the real app.
 * No SSE connection — pure static render with all UI elements visible.
 *
 * Mirrors AuthenticatedApp layout: AppHeader, sidebar with TaskTree, tab bar,
 */

import { pluginApiPrefix } from "@mxd/types";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuthFetch } from "./auth.ts";
import { ActivityLog } from "./components/ActivityLog.tsx";
import { BackgroundProcessBar } from "./components/BackgroundProcessBar.tsx";
import { CuteCat } from "./components/CuteCat.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import {
	IconArrowDown,
	IconClose,
	IconExpand,
	IconGear,
	IconHexagon,
	IconMinimize,
	IconPlus,
	IconRefresh,
} from "./components/icons.tsx";
import { OrchestratorDetail } from "./components/OrchestratorDetail.tsx";
import { statusDotClass } from "./components/StatusBadge.tsx";
import { TaskDetail } from "./components/TaskDetail.tsx";
import { TaskTree } from "./components/TaskTree.tsx";
import { TokenUsageBadge } from "./components/TokenUsageBadge.tsx";
import {
	createEventHandler,
	type EventHandlerDeps,
	type PendingAction,
	type PendingMessage,
	pendingReducer,
} from "./event-handler.ts";
import {
	type IncomingEvent,
	isTask,
	type LogEntry,
	type TreeNode,
} from "./hooks.ts";
import { useLocale } from "./i18n.ts";
import { applyTheme, themes } from "./themes.ts";

interface MockData {
	nodes: TreeNode[];
	rootNodeId: string;
	events: IncomingEvent[];
	backgroundProcesses?: Array<{
		id: string;
		command: string;
		startTime: number;
		taskId?: string;
	}>;
	pendingClarifications?: Array<{
		id: string;
		taskId: string;
		question: string;
		title?: string;
		body?: string;
		timestamp: number;
	}>;
	tokenUsage?: {
		inputTokens: number;
		contextWindow: number;
	};
}

export function MockShowcase() {
	return (
		<ErrorBoundary>
			<MockShowcaseInner />
		</ErrorBoundary>
	);
}

function MockShowcaseInner() {
	const authFetch = useAuthFetch();
	const { t } = useLocale();

	// ── State (mirrors AuthenticatedApp) ──
	const [nodes, setNodes] = useState<TreeNode[]>([]);
	const [rootNodeId, setRootNodeId] = useState<string | null>(null);
	const [logs, setLogs] = useState<LogEntry[]>([]);
	const [activeAgents, setActiveAgents] = useState<Set<string>>(new Set());
	const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
	const [autoScroll, setAutoScroll] = useState(true);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	// Events-derived pending — same pattern as Plugin.tsx. MockShowcase
	// doesn't render the pending banner itself, but it still needs to
	// dispatch reducer actions so createEventHandler's deps contract holds.
	const pendingMessagesRef = useRef<PendingMessage[]>([]);
	const dispatchPending = useCallback((action: PendingAction) => {
		pendingMessagesRef.current = pendingReducer(
			pendingMessagesRef.current,
			action,
		);
	}, []);
	const getPendingMessages = useCallback(() => pendingMessagesRef.current, []);
	const [, setPendingClarifications] = useState<
		{
			id: string;
			taskId: string;
			question: string;
			title?: string;
			body?: string;
			timestamp: number;
		}[]
	>([]);
	const [backgroundProcesses, setBackgroundProcesses] = useState<
		Map<
			string,
			{ id: string; command: string; startTime: number; taskId?: string }
		>
	>(() => new Map());
	const [tokenUsage, setTokenUsage] = useState<{
		inputTokens: number;
		contextWindow: number;
	} | null>(null);
	const [theme] = useState<"dark" | "light" | "cute-light" | "cute-dark">(
		() => {
			const stored = localStorage.getItem("mxd-theme");
			if (
				stored === "light" ||
				stored === "cute-light" ||
				stored === "cute-dark"
			)
				return stored;
			return "dark";
		},
	);
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const [sidebarWidth, setSidebarWidth] = useState(288);
	const [isSidebarDragging, setIsSidebarDragging] = useState(false);
	const [openTabs, setOpenTabs] = useState<string[]>([]);
	const [previewTabId, setPreviewTabId] = useState<string | null>(null);
	const [viewMode, setViewMode] = useState<"activity" | "description">(
		"activity",
	);
	const [fullscreen, setFullscreen] = useState(false);
	const [showCacheBadges, setShowCacheBadges] = useState(false);

	const nodeMap = useMemo(() => {
		const map = new Map<string, TreeNode>();
		for (const n of nodes) map.set(n.id, n);
		return map;
	}, [nodes]);

	const viewedSessionRef = useRef<string | null>(null);
	viewedSessionRef.current = selectedTaskId ?? rootNodeId;

	// ── Theme ──
	useEffect(() => {
		const config = themes[theme];
		if (config) applyTheme(config);
		localStorage.setItem("mxd-theme", theme);
	}, [theme]);

	// ── Event handler ──
	const { processEventBatch } = useMemo(() => {
		const deps: EventHandlerDeps = {
			updateFromWS: () => {},
			setRootNodeId,
			setActiveAgents,
			checkAgentStatus: () => {},
			setAgentProvider: () => {},
			setAgentModel: () => {},
			setLogs,
			setTokenUsage: () => {},
			dispatchPending,
			getPendingMessages,
			setPendingClarifications: () => {},
			setLastTurns: () => {},
			setLastInputTokens: () => {},
			setLastCacheCreationTokens: () => {},
			setLastCacheReadTokens: () => {},
			setLastOutputTokens: () => {},
			setBackgroundProcesses: () => {},
			t,
			getViewedSessionId: () => viewedSessionRef.current,
		};
		return createEventHandler(deps);
	}, [t, getPendingMessages, dispatchPending]);

	// ── Fetch mock data ──
	useEffect(() => {
		let cancelled = false;
		// `/mock-showcase` is a matrix-plugin-worker route; it lives under the
		// plugin's API namespace. Daemon strips the `/api/matrix` prefix and
		// forwards to the worker, which serves `/mock-showcase` at root.
		authFetch(`${pluginApiPrefix("matrix")}/mock-showcase`)
			.then((r) => {
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				return r.json();
			})
			.then((data: MockData) => {
				if (cancelled) return;
				setNodes(data.nodes);
				setRootNodeId(data.rootNodeId);
				processEventBatch(data.events);
				if (data.backgroundProcesses) {
					const bgMap = new Map<
						string,
						{ id: string; command: string; startTime: number; taskId?: string }
					>();
					for (const bp of data.backgroundProcesses) bgMap.set(bp.id, bp);
					setBackgroundProcesses(bgMap);
				}
				if (data.pendingClarifications)
					setPendingClarifications(data.pendingClarifications);
				if (data.tokenUsage) setTokenUsage(data.tokenUsage);
				// Pre-open some tabs to show the tab bar
				const taskNodes = data.nodes.filter(
					(n) => "status" in n && n.status !== "closed",
				);
				const initialTabs = taskNodes
					.slice(0, 3)
					.map((n) => n.id)
					.filter((id) => id !== data.rootNodeId);
				setOpenTabs(initialTabs);
				// Mark root's in_progress task as active for spinner demo
				const inProgressTask = data.nodes.find(
					(n) =>
						"status" in n &&
						n.status === "in_progress" &&
						n.id !== data.rootNodeId,
				);
				if (inProgressTask)
					setActiveAgents(new Set([data.rootNodeId, inProgressTask.id]));
				setLoading(false);
			})
			.catch((e) => {
				if (cancelled) return;
				setError(e.message);
				setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [processEventBatch, authFetch]);

	// ── Sidebar resize ──
	const handleSidebarResizeStart = useCallback((e: React.MouseEvent) => {
		e.preventDefault();
		setIsSidebarDragging(true);
	}, []);

	useEffect(() => {
		if (!isSidebarDragging) return;
		const handleMouseMove = (e: MouseEvent) => {
			if (e.clientX < 100) {
				setSidebarWidth(0);
				setSidebarCollapsed(true);
			} else {
				setSidebarCollapsed(false);
				setSidebarWidth(Math.min(600, Math.max(180, e.clientX)));
			}
		};
		const handleMouseUp = () => setIsSidebarDragging(false);
		document.addEventListener("mousemove", handleMouseMove);
		document.addEventListener("mouseup", handleMouseUp);
		return () => {
			document.removeEventListener("mousemove", handleMouseMove);
			document.removeEventListener("mouseup", handleMouseUp);
		};
	}, [isSidebarDragging]);

	// ── Callbacks ──
	const noop = useCallback(() => {}, []);

	const openTabsRef = useRef(openTabs);
	openTabsRef.current = openTabs;
	const previewTabRef = useRef(previewTabId);
	previewTabRef.current = previewTabId;

	const handleTaskSelect = useCallback((id: string | null) => {
		setSelectedTaskId(id);
		setSidebarOpen(false);
		if (!id) return;
		const prev = openTabsRef.current;
		if (prev.includes(id)) return;
		const curPreview = previewTabRef.current;
		let next: string[];
		if (curPreview && prev.includes(curPreview)) {
			next = prev.map((t) => (t === curPreview ? id : t));
		} else {
			next = [...prev, id];
		}
		setOpenTabs(next);
		setPreviewTabId(id);
	}, []);

	const handleTaskPin = useCallback((id: string | null) => {
		if (!id) return;
		setSelectedTaskId(id);
		setPreviewTabId((prev) => (prev === id ? null : prev));
		setOpenTabs((prev) => {
			if (prev.includes(id)) return prev;
			return [...prev, id];
		});
	}, []);

	const handleTabSelect = useCallback((id: string | null) => {
		setSelectedTaskId(id);
	}, []);

	const handleTabClose = useCallback((id: string, e?: React.MouseEvent) => {
		e?.stopPropagation();
		setPreviewTabId((prev) => (prev === id ? null : prev));
		setOpenTabs((prev) => prev.filter((t) => t !== id));
	}, []);

	const handleTaskNavigate = useCallback((id: string) => {
		if (!id) return;
		setSelectedTaskId(id);
		setPreviewTabId((prev) => (prev === id ? null : prev));
		setOpenTabs((prev) => {
			if (prev.includes(id)) return prev;
			return [...prev, id];
		});
	}, []);

	// ── Derived ──
	// Root-view check: selectedTaskId carries the real root id; no null-as-root
	// sentinel. (Mirrors Plugin.tsx — Fix A + Fix C consistency.)
	const isOrchestratorNode = selectedTaskId === rootNodeId;
	const selectedNode =
		selectedTaskId && !isOrchestratorNode
			? (nodeMap.get(selectedTaskId) ?? null)
			: null;
	const totalCost = useMemo(() => {
		const sum = nodes.reduce(
			(acc, n) => (isTask(n) ? acc + n.costUsd : acc),
			0,
		);
		return sum > 0 ? sum : null;
	}, [nodes]);
	const viewedTaskId = isOrchestratorNode ? rootNodeId : selectedTaskId;
	const mockProjectMap = useMemo(
		() => new Map([["mock", "Mock Showcase"]]),
		[],
	);

	// ── Render ──

	if (loading) {
		return (
			<div className="mxd-login-page">
				<div className="mxd-login-container">
					<div className="mxd-login-auth">
						<div className="mxd-login-loading">
							<div className="mxd-login-spinner" />
							<p>Loading mock showcase…</p>
						</div>
					</div>
				</div>
			</div>
		);
	}

	if (error) {
		return (
			<div className="mxd-login-page">
				<div className="mxd-login-container">
					<div className="mxd-login-auth">
						<div className="mxd-login-loading">
							<p>❌ Failed to load mock data: {error}</p>
							<p style={{ fontSize: "11px", color: "var(--text-muted)" }}>
								Make sure the daemon is running.
							</p>
						</div>
					</div>
				</div>
			</div>
		);
	}

	return (
		<>
			{/* AppHeader moved to daemon shell — mock renders content only */}
			<main
				className={`mxd-main${fullscreen ? " mxd-fullscreen" : ""}${isSidebarDragging ? " mxd-sidebar-resizing" : ""}`}
			>
				{/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop */}
				{/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop */}
				<div
					className={`mxd-sidebar-backdrop${sidebarOpen ? " mxd-sidebar-open" : ""}`}
					onClick={() => setSidebarOpen(false)}
				/>
				<aside
					className={`mxd-sidebar${sidebarOpen ? " mxd-sidebar-open" : ""}${sidebarCollapsed ? " mxd-sidebar-collapsed" : ""}`}
					style={
						!sidebarCollapsed
							? ({ "--sidebar-w": `${sidebarWidth}px` } as React.CSSProperties)
							: undefined
					}
				>
					<div className="mxd-panel-header">
						<span className="mxd-panel-title">{t("tasks.title")}</span>
						<div className="mxd-panel-actions">
							<button
								type="button"
								className="mxd-btn-icon"
								data-tip={t("tasks.addTask")}
							>
								<IconPlus size={13} />
							</button>
							<button
								type="button"
								className="mxd-btn-icon"
								data-tip={t("tasks.refresh")}
							>
								<IconRefresh size={13} />
							</button>
							<button
								type="button"
								className="mxd-btn-icon mxd-sidebar-settings-btn"
								data-tip={t("project.settings")}
							>
								<IconGear size={13} />
							</button>
						</div>
					</div>
					<TaskTree
						nodes={nodes}
						selectedTaskId={selectedTaskId}
						rootNodeId={rootNodeId}
						activeAgents={activeAgents}
						onSelect={handleTaskSelect}
						onDoubleClick={handleTaskPin}
					/>
				</aside>

				{/* biome-ignore lint/a11y/noStaticElementInteractions: resize handle */}
				<div
					className={`mxd-sidebar-resize-handle${sidebarCollapsed ? " mxd-sidebar-resize-handle-collapsed" : ""}`}
					onMouseDown={handleSidebarResizeStart}
				/>

				<section className="mxd-content">
					{/* Tab bar */}
					{openTabs.length > 0 && (
						<div className="mxd-tab-bar">
							<button
								type="button"
								className={`mxd-tab${isOrchestratorNode ? " mxd-tab-active" : ""}`}
								onClick={() => handleTabSelect(rootNodeId)}
							>
								<IconHexagon size={10} />
								<span className="mxd-tab-label">{t("orch.label")}</span>
							</button>
							{openTabs.map((tabId) => {
								const tabNode = nodeMap.get(tabId);
								if (!tabNode) return null;
								const isActive = selectedTaskId === tabId;
								const isTabAgentActive =
									isTask(tabNode) && activeAgents.has(tabId);
								const isPreview = previewTabId === tabId;
								return (
									<button
										key={tabId}
										type="button"
										className={`mxd-tab${isActive ? " mxd-tab-active" : ""}${isPreview ? " mxd-tab-preview" : ""}`}
										onClick={() => handleTabSelect(tabId)}
									>
										{isTabAgentActive && <span className="mxd-task-spinner" />}
										{isTask(tabNode) && !isTabAgentActive && (
											<span
												className={`mxd-tab-dot ${statusDotClass(tabNode.status)}`}
											/>
										)}
										<span className="mxd-tab-label">{tabNode.title}</span>
										{/* biome-ignore lint/a11y/useKeyWithClickEvents: tab close */}
										{/* biome-ignore lint/a11y/noStaticElementInteractions: tab close */}
										<span
											className="mxd-tab-close"
											onClick={(e) => handleTabClose(tabId, e)}
										>
											<IconClose size={9} />
										</span>
									</button>
								);
							})}
						</div>
					)}

					{/* Compact task metadata bar */}
					{!isOrchestratorNode && selectedNode && isTask(selectedNode) && (
						<div className="mxd-task-meta-bar">
							<TaskDetail
								node={selectedNode}
								projectId=""
								isActive={activeAgents.has(selectedNode.id)}
								onDelete={noop}
								onStop={noop}
								onClearSession={noop}
								compact
							/>
						</div>
					)}

					{/* View mode toggle header */}
					<div className="mxd-panel-header">
						<div className="mxd-view-toggle">
							<button
								type="button"
								className={`mxd-view-toggle-btn${viewMode === "activity" ? " active" : ""}`}
								onClick={() => setViewMode("activity")}
							>
								{t("activity.title")}
							</button>
							<button
								type="button"
								className={`mxd-view-toggle-btn${viewMode === "description" ? " active" : ""}`}
								onClick={() => setViewMode("description")}
							>
								{isOrchestratorNode ? t("project.details") : t("detail.title")}
							</button>
						</div>
						<div className="mxd-panel-actions">
							{tokenUsage && (
								<TokenUsageBadge
									inputTokens={tokenUsage.inputTokens}
									contextWindow={tokenUsage.contextWindow}
									onCompact={noop}
								/>
							)}
							{viewMode === "activity" && !autoScroll && (
								<button
									type="button"
									className="mxd-scroll-follow-btn"
									onClick={() => setAutoScroll(true)}
								>
									<IconArrowDown size={10} />
									{t("activity.follow")}
								</button>
							)}
							{viewMode === "activity" && (
								<button
									type="button"
									className={`mxd-btn-icon mxd-cache-toggle-btn${showCacheBadges ? " active" : ""}`}
									onClick={() => setShowCacheBadges((p) => !p)}
									title={t("activity.toggleCacheBadges")}
								>
									⚡
								</button>
							)}
							<button
								type="button"
								className="mxd-btn-icon mxd-fullscreen-btn"
								onClick={() => setFullscreen((f) => !f)}
								title={
									fullscreen
										? t("activity.exitFullscreen")
										: t("activity.fullscreen")
								}
							>
								{fullscreen ? (
									<IconMinimize size={12} />
								) : (
									<IconExpand size={12} />
								)}
							</button>
						</div>
					</div>

					{/* Main view area */}
					{viewMode === "activity" ? (
						<div className="mxd-activity-panel">
							<BackgroundProcessBar
								processes={backgroundProcesses}
								projectId=""
								filterTaskId={selectedTaskId}
								rootNodeId={rootNodeId}
							/>
							<ActivityLog
								entries={logs}
								filterTaskId={selectedTaskId}
								rootNodeId={rootNodeId}
								nodeMap={nodeMap}
								autoScroll={autoScroll}
								onAutoScrollChange={setAutoScroll}
								isActive={viewedTaskId ? activeAgents.has(viewedTaskId) : false}
								projectId=""
								onTaskNavigate={handleTaskNavigate}
								projectMap={mockProjectMap}
								showCacheBadges={showCacheBadges}
							/>
						</div>
					) : isOrchestratorNode ? (
						<div className="mxd-description-view">
							<OrchestratorDetail
								isRootActive={rootNodeId ? activeAgents.has(rootNodeId) : false}
								nodes={nodes}
								rootNodeId={rootNodeId}
								totalCost={totalCost}
								turns={15}
								inputTokens={125000}
								cacheCreationTokens={8500}
								cacheReadTokens={95000}
								outputTokens={12000}
								provider="anthropic"
								model="claude-sonnet-4-20250514"
								onClearSession={noop}
								onStop={noop}
							/>
						</div>
					) : selectedNode && isTask(selectedNode) ? (
						<div className="mxd-description-view">
							<TaskDetail
								node={selectedNode}
								projectId=""
								isActive={activeAgents.has(selectedNode.id)}
								onDelete={noop}
								onStop={noop}
								onClearSession={noop}
							/>
						</div>
					) : null}
				</section>
			</main>

			{/* AppFooter moved to shell */}

			{themes[theme]?.hasCat && <CuteCat />}
		</>
	);
}
