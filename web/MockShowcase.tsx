/**
 * MockShowcase — standalone page for rendering all card types + task states.
 *
 * Activated by `?mock=true` in the URL. Fetches static data from `/mock-showcase`
 * and renders it using the same components as the real app.
 * No SSE connection — pure static render with all UI elements visible.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { authFetch } from "./auth.ts";
import { ActivityLog } from "./components/ActivityLog.tsx";
import { AppFooter } from "./components/AppFooter.tsx";
import { AppHeader } from "./components/AppHeader.tsx";
import { BackgroundProcessBar } from "./components/BackgroundProcessBar.tsx";
import { CuteCat } from "./components/CuteCat.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { TaskTree } from "./components/TaskTree.tsx";
import { TokenUsageBadge } from "./components/TokenUsageBadge.tsx";
import { createEventHandler, type EventHandlerDeps } from "./event-handler.ts";
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
		estimated?: boolean;
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
	const { t } = useLocale();

	// ── State ──
	const [nodes, setNodes] = useState<TreeNode[]>([]);
	const [rootNodeId, setRootNodeId] = useState<string | null>(null);
	const [logs, setLogs] = useState<LogEntry[]>([]);
	const [activeAgents, setActiveAgents] = useState<Set<string>>(new Set());
	const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
	const [autoScroll, setAutoScroll] = useState(true);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [pendingMessages, setPendingMessages] = useState<
		{
			id: string;
			taskId: string | null;
			text: string;
			timestamp: number;
			images?: Array<{ base64: string; mediaType: string }>;
		}[]
	>([]);
	const [pendingClarifications, setPendingClarifications] = useState<
		{
			id: string;
			taskId: string;
			question: string;
			title?: string;
			body?: string;
			timestamp: number;
		}[]
	>([]);
	const [clarifyAnswers] = useState<Record<string, string>>({});
	const [backgroundProcesses, setBackgroundProcesses] = useState<
		Map<
			string,
			{
				id: string;
				command: string;
				startTime: number;
				taskId?: string;
			}
		>
	>(() => new Map());
	const [tokenUsage, setTokenUsage] = useState<{
		inputTokens: number;
		contextWindow: number;
		estimated?: boolean;
	} | null>(null);
	const [theme, setThemeState] = useState<
		"dark" | "light" | "cute-light" | "cute-dark"
	>(() => {
		const stored = localStorage.getItem("mxd-theme");
		if (stored === "light" || stored === "cute-light" || stored === "cute-dark")
			return stored;
		return "dark";
	});
	const [sidebarOpen, setSidebarOpen] = useState(false);

	const nodeMap = useMemo(() => {
		const map = new Map<string, TreeNode>();
		for (const n of nodes) map.set(n.id, n);
		return map;
	}, [nodes]);

	const viewedSessionRef = useRef<string | null>(null);
	const viewedSessionId = selectedTaskId ?? rootNodeId;
	viewedSessionRef.current = viewedSessionId;

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
			setPendingMessages,
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
	}, [t]);

	// ── Fetch mock data on mount ──
	useEffect(() => {
		let cancelled = false;
		authFetch("/mock-showcase")
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
						{
							id: string;
							command: string;
							startTime: number;
							taskId?: string;
						}
					>();
					for (const bp of data.backgroundProcesses) {
						bgMap.set(bp.id, bp);
					}
					setBackgroundProcesses(bgMap);
				}
				if (data.pendingClarifications) {
					setPendingClarifications(data.pendingClarifications);
				}
				if (data.tokenUsage) {
					setTokenUsage(data.tokenUsage);
				}
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
	}, [processEventBatch]);

	// ── Callbacks ──
	const handleTaskSelect = useCallback((id: string | null) => {
		setSelectedTaskId(id);
		setSidebarOpen(false);
	}, []);

	const noop = useCallback(() => {}, []);
	// No-op: clarify input is visible but non-functional in mock mode
	const handleClarifyAnswerChange = useCallback(
		(_clarificationId: string, _value: string) => {},
		[],
	);
	const handleThemeChange = useCallback(
		(t: string) => setThemeState(t as typeof theme),
		[],
	);
	const handleToggleSidebar = useCallback(() => setSidebarOpen((s) => !s), []);

	// ── Derived ──
	const isOrchestratorNode = !selectedTaskId || selectedTaskId === rootNodeId;
	const selectedNode =
		selectedTaskId && !isOrchestratorNode
			? (nodeMap.get(selectedTaskId) ?? null)
			: null;
	const filterLabel = isOrchestratorNode
		? t("orch.label")
		: selectedNode
			? selectedNode.title
			: null;

	const totalCost = useMemo(() => {
		const sum = nodes.reduce(
			(acc, n) => (isTask(n) ? acc + n.costUsd : acc),
			0,
		);
		return sum > 0 ? sum : null;
	}, [nodes]);

	// Mock project for AppHeader
	const mockProjects = useMemo(
		() => [
			{
				id: "mock",
				name: "Mock Showcase",
				path: "/mock",
				pathExists: true as const,
			},
		],
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
								Make sure the daemon is running and the /mock-showcase endpoint
								is registered.
							</p>
						</div>
					</div>
				</div>
			</div>
		);
	}

	return (
		<>
			<AppHeader
				connected={true}
				projects={mockProjects}
				projectId="mock"
				showAddProject={false}
				newProjectPath=""
				creatingProject={false}
				showSettings={false}
				theme={theme}
				onProjectChange={noop}
				onShowAddProject={noop}
				onAddProject={noop}
				onNewProjectPathChange={noop}
				onCancelAddProject={noop}
				onToggleSettings={noop}
				onThemeChange={handleThemeChange}
				onToggleSidebar={handleToggleSidebar}
			/>

			<main className="mxd-main">
				{/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop */}
				{/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop */}
				<div
					className={`mxd-sidebar-backdrop${sidebarOpen ? " mxd-sidebar-open" : ""}`}
					onClick={() => setSidebarOpen(false)}
				/>
				<aside
					className={`mxd-sidebar${sidebarOpen ? " mxd-sidebar-open" : ""}`}
				>
					<div className="mxd-panel-header">
						<span className="mxd-panel-title">{t("tasks.title")}</span>
						<div className="mxd-panel-actions">
							{totalCost !== null && (
								<span
									style={{
										fontSize: "10px",
										color: "var(--text-faint)",
										fontFamily: "var(--font-mono)",
									}}
								>
									${totalCost.toFixed(2)}
								</span>
							)}
						</div>
					</div>
					<TaskTree
						nodes={nodes}
						selectedTaskId={selectedTaskId}
						rootNodeId={rootNodeId}
						activeAgents={activeAgents}
						onSelect={handleTaskSelect}
					/>
				</aside>

				<section className="mxd-content">
					<div className="mxd-activity-panel" style={{ flex: 1 }}>
						<div className="mxd-panel-header">
							<span className="mxd-panel-title">
								{t("activity.title")}
								{filterLabel && !isOrchestratorNode && (
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
							<div className="mxd-panel-actions">
								{tokenUsage && (
									<TokenUsageBadge
										inputTokens={tokenUsage.inputTokens}
										contextWindow={tokenUsage.contextWindow}
										estimated={tokenUsage.estimated}
										onCompact={noop}
									/>
								)}
							</div>
						</div>
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
							isActive={false}
							projectId=""
						/>
					</div>
				</section>
			</main>

			<AppFooter
				projectId=""
				targetNodeId={null}
				rootNodeId={rootNodeId}
				nodeMap={nodeMap}
				pendingMessages={pendingMessages}
				pendingClarifications={pendingClarifications}
				clarifyAnswers={clarifyAnswers}
				onSend={noop}
				onClearTarget={noop}
				onClarifySubmit={noop}
				onClarifyAnswerChange={handleClarifyAnswerChange}
			/>

			{themes[theme]?.hasCat && <CuteCat />}
		</>
	);
}
