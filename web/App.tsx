import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { authFetch, clearToken } from "./auth.ts";
import { ActivityLog } from "./components/ActivityLog.tsx";
import { AppFooter } from "./components/AppFooter.tsx";
import { AppHeader } from "./components/AppHeader.tsx";
import { CuteCat } from "./components/CuteCat.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import {
	IconArrowDown,
	IconClose,
	IconHexagon,
	IconPlus,
	IconRefresh,
} from "./components/icons.tsx";
import { LoginPage } from "./components/LoginPage.tsx";
import { OrchestratorDetail } from "./components/OrchestratorDetail.tsx";
import { SettingsPanel } from "./components/SettingsPanel.tsx";
import { TaskDetail } from "./components/TaskDetail.tsx";
import { TaskTree } from "./components/TaskTree.tsx";
import { TokenUsageBadge } from "./components/TokenUsageBadge.tsx";
import { createActionHandlers } from "./handlers.ts";

import {
	createLogEntry,
	type LogEntry,
	type TaskNode,
	type UIEvent,
	useAgent,
	useProjects,
	useSSE,
	useTasks,
	useThreeLayerConfig,
} from "./hooks.ts";

import { LocaleProvider, useLocale } from "./i18n.ts";
import { applyTheme, themes } from "./themes.ts";
import { createWSHandler } from "./ws-handler.ts";

// ── Hash routing helpers ───────────────────────────────────────────────────

function parseHash(): { projectId?: string; taskId?: string } {
	const raw = window.location.hash.replace(/^#/, "");
	if (!raw) return {};
	const slash = raw.indexOf("/");
	if (slash === -1) return { projectId: raw };
	return { projectId: raw.slice(0, slash), taskId: raw.slice(slash + 1) };
}

function updateHash(
	projectId: string,
	taskId: string | null,
	rootNodeId: string | null,
) {
	const hash =
		taskId && taskId !== rootNodeId
			? `#${projectId}/${taskId}`
			: projectId
				? `#${projectId}`
				: "";
	if (window.location.hash !== hash) {
		window.location.hash = hash;
	}
}

// ── Main App ───────────────────────────────────────────────────────────────

export function App() {
	return (
		<LocaleProvider>
			<ErrorBoundary>
				<AppInner />
			</ErrorBoundary>
		</LocaleProvider>
	);
}

function AppInner() {
	// Auth state — check on mount
	const [authState, setAuthState] = useState<
		"loading" | "authenticated" | "login"
	>("loading");
	const [authInfo, setAuthInfo] = useState<{
		enforced: boolean;
		hasCredentials: boolean;
	}>({ enforced: false, hasCredentials: false });

	const handleLogout = useCallback(async () => {
		try {
			await authFetch("/auth/logout", { method: "POST" });
		} catch {
			// ignore
		}
		clearToken();
		setAuthState("login");
	}, []);

	useEffect(() => {
		authFetch("/auth/status")
			.then((r) => r.json())
			.then(
				(data: {
					enforced?: boolean;
					hasCredentials?: boolean;
					authenticated?: boolean;
				}) => {
					setAuthInfo({
						enforced: data.enforced ?? false,
						hasCredentials: data.hasCredentials ?? false,
					});
					if (data.authenticated) {
						setAuthState("authenticated");
					} else {
						setAuthState("login");
					}
				},
			)
			.catch(() => {
				// If auth endpoint fails, assume no auth needed (backward compatible)
				setAuthState("authenticated");
			});
	}, []);

	if (authState === "loading") {
		return (
			<div className="og-login-page">
				<div className="og-login-card">
					<div className="og-login-icon">⏳</div>
					<p className="og-login-subtitle">Loading...</p>
				</div>
			</div>
		);
	}

	if (authState === "login") {
		return (
			<LoginPage
				hasCredentials={authInfo.hasCredentials}
				enforced={authInfo.enforced}
				onAuthenticated={() => setAuthState("authenticated")}
			/>
		);
	}

	return <AuthenticatedApp onLogout={handleLogout} />;
}

function AuthenticatedApp({ onLogout }: { onLogout: () => void }) {
	const { t } = useLocale();
	const {
		projects,
		refresh: refreshProjects,
		initProject,
		deleteProject,
	} = useProjects();
	const initialHash = useMemo(() => parseHash(), []);
	const [projectId, setProjectId] = useState(initialHash.projectId ?? "");
	const [showAddProject, setShowAddProject] = useState(false);
	const [newProjectPath, setNewProjectPath] = useState("");
	const [creatingProject, setCreatingProject] = useState(false);
	const [isCreatingTask, setIsCreatingTask] = useState(false);
	const [selectedTaskId, setSelectedTaskId] = useState<string | null>(
		initialHash.taskId ?? null,
	);
	const [rootNodeId, setRootNodeId] = useState<string | null>(null);
	const [targetNodeId, setTargetNodeId] = useState<string | null>(null);
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
	const [showSettings, setShowSettings] = useState(false);
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const [splitRatio, setSplitRatio] = useState(0.35);
	const [isDragging, setIsDragging] = useState(false);
	const [autoScroll, setAutoScroll] = useState(true);
	const [theme, setThemeState] = useState<
		"dark" | "light" | "cute-light" | "cute-dark"
	>(() => {
		const stored = localStorage.getItem("og-theme");
		if (stored === "light" || stored === "cute-light" || stored === "cute-dark")
			return stored;
		return "dark";
	});
	const [tokenUsage, setTokenUsage] = useState<
		Record<
			string,
			{ inputTokens: number; contextWindow: number; estimated?: boolean }
		>
	>({});
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
		{ id: string; taskId: string; question: string; timestamp: number }[]
	>([]);
	const [clarifyAnswers, setClarifyAnswers] = useState<Record<string, string>>(
		{},
	);
	const contentPanelRef = useRef<HTMLElement>(null);

	const {
		nodes,
		refresh: refreshTasks,
		updateFromWS,
	} = useTasks(projectId, setRootNodeId);
	const {
		running,
		activeAgents,
		setActiveAgents,
		provider: agentProvider,
		setProvider: setAgentProvider,
		model: agentModel,
		setModel: setAgentModel,
		start,
		stop,
		checkStatus,
		compact,
		deleteTask,
		clearTaskSession,
		sendMessage,
		sendMessageToTask,
		reorderTasks,
		reparentTask,
	} = useAgent(projectId);
	const {
		layers,
		loading: configLoading,
		updateGlobal,
		updateRepo,
		updateLocal,
	} = useThreeLayerConfig(projectId);

	const nodeMap = useMemo(() => {
		const map = new Map<string, TaskNode>();
		for (const n of nodes) map.set(n.id, n);
		return map;
	}, [nodes]);
	const nodeMapRef = useRef(nodeMap);
	nodeMapRef.current = nodeMap;

	const totalCost = useMemo(() => {
		const sum = nodes.reduce((acc, n) => acc + (n.costUsd ?? 0), 0);
		return sum > 0 ? sum : null;
	}, [nodes]);

	const isOrchestratorNode = !selectedTaskId || selectedTaskId === rootNodeId;
	const selectedNode =
		selectedTaskId && !isOrchestratorNode
			? (nodeMap.get(selectedTaskId) ?? null)
			: null;

	// Per-agent active state: check if the currently viewed agent is active
	const viewedTaskId = isOrchestratorNode ? rootNodeId : selectedTaskId;
	const isSelectedTaskActive = viewedTaskId
		? activeAgents.has(viewedTaskId)
		: false;

	const addLog = useCallback((event: UIEvent) => {
		setLogs((prev) => [...prev, createLogEntry(event)]);
	}, []);

	// ── Effects ──────────────────────────────────────────────────────────────

	useEffect(() => {
		const config = themes[theme];
		if (config) applyTheme(config);
		localStorage.setItem("og-theme", theme);
	}, [theme]);

	useEffect(() => {
		const currentProject = projects.find((p) => p.id === projectId);
		const projectName = currentProject?.name ?? "";
		const base = `OpenGraft${projectName ? ` — ${projectName}` : ""}`;

		const childNodes = rootNodeId
			? nodes.filter((n) => n.id !== rootNodeId)
			: nodes;
		const total = childNodes.length;
		if (total === 0) {
			document.title = base;
			return;
		}
		const passed = childNodes.filter((n) => n.status === "passed").length;
		const failed = childNodes.filter(
			(n) => n.status === "failed" || n.status === "stuck",
		).length;
		if (failed > 0) document.title = `${base} [!${failed}]`;
		else if (passed === total) document.title = `${base} [✓]`;
		else document.title = `${base} [${passed}/${total}]`;
	}, [nodes, rootNodeId, projects, projectId]);

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
			const ratio = Math.min(
				0.85,
				Math.max(0.1, (e.clientY - rect.top) / rect.height),
			);
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

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement;
			const isInput =
				target.tagName === "INPUT" ||
				target.tagName === "TEXTAREA" ||
				target.isContentEditable;
			if (e.key === "Escape" && !isInput) {
				setSelectedTaskId(rootNodeId);
				setTargetNodeId(null);
			}
			if (e.key === "/" && !isInput) {
				e.preventDefault();
				(
					document.querySelector(".og-log-search") as HTMLInputElement | null
				)?.focus();
			}
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [rootNodeId]);

	// ── SSE handler ──────────────────────────────────────────────────────────

	const { handleWS, processEventBatch } = useMemo(
		() =>
			createWSHandler({
				updateFromWS,
				setRootNodeId,
				setActiveAgents,
				checkAgentStatus: checkStatus,
				setAgentProvider,
				setAgentModel,
				setLogs,
				setTokenUsage,
				setPendingMessages,
				setPendingClarifications,
				setLastTurns,
				setLastInputTokens,
				setLastCacheCreationTokens,
				setLastCacheReadTokens,
				setLastOutputTokens,
				nodeMapRef,
				t,
			}),
		[
			updateFromWS,
			setActiveAgents,
			checkStatus,
			setAgentProvider,
			setAgentModel,
			t,
		],
	);

	const { connected } = useSSE(projectId, handleWS, checkStatus);

	useEffect(() => {
		if (projects.length === 0) return;
		if (projectId && projects.some((p) => p.id === projectId)) return;
		const first = projects[0];
		if (first) setProjectId(first.id);
	}, [projects, projectId]);

	// Fetch event history from JSONL EventStore on project change
	// biome-ignore lint/correctness/useExhaustiveDependencies: processEventBatch is stable within useMemo
	useEffect(() => {
		if (!projectId) return;
		let cancelled = false;
		authFetch(`/projects/${projectId}/events`)
			.then((r) => r.json())
			.then((data: { events?: Record<string, unknown>[] }) => {
				if (cancelled) return;
				if (data.events && data.events.length > 0) {
					processEventBatch(data.events);
				}
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [projectId]);

	// ── Hash routing sync ────────────────────────────────────────────────────

	// Update hash when projectId or selectedTaskId changes
	useEffect(() => {
		if (projectId) updateHash(projectId, selectedTaskId, rootNodeId);
	}, [projectId, selectedTaskId, rootNodeId]);

	// Listen for browser back/forward (hashchange)
	useEffect(() => {
		const onHashChange = () => {
			const { projectId: hp, taskId: ht } = parseHash();
			if (hp && hp !== projectId) {
				setProjectId(hp);
				setSelectedTaskId(ht ?? rootNodeId);
				setLogs([]);
			} else if (ht && ht !== selectedTaskId) {
				setSelectedTaskId(ht);
			} else if (!ht && selectedTaskId !== rootNodeId) {
				setSelectedTaskId(rootNodeId);
			}
		};
		window.addEventListener("hashchange", onHashChange);
		return () => window.removeEventListener("hashchange", onHashChange);
	}, [projectId, selectedTaskId, rootNodeId]);

	useEffect(() => {
		if (projectId) checkStatus();
	}, [projectId, checkStatus]);

	useEffect(() => {
		if (!projectId) {
			setPendingMessages([]);
			return;
		}
		authFetch(`/projects/${projectId}/pending-messages`)
			.then((r) => r.json())
			.then((data: { messages: typeof pendingMessages }) =>
				setPendingMessages(data.messages ?? []),
			)
			.catch(() => setPendingMessages([]));
	}, [projectId]);

	useEffect(() => {
		if (!projectId) {
			setPendingClarifications([]);
			setClarifyAnswers({});
			return;
		}
		authFetch(`/projects/${projectId}/clarifications`)
			.then((r) => r.json())
			.then((data: { clarifications: typeof pendingClarifications }) =>
				setPendingClarifications(data.clarifications ?? []),
			)
			.catch(() => setPendingClarifications([]));
	}, [projectId]);

	useEffect(() => {
		if (!selectedTaskId || selectedTaskId === rootNodeId) {
			setTargetNodeId(null);
			return;
		}
		// Always target the selected task regardless of status — the backend
		// handles routing (persistent queue + auto-resume for non-running tasks).
		setTargetNodeId(selectedTaskId);
	}, [selectedTaskId, rootNodeId]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: only trigger on task selection change
	useEffect(() => {
		setAutoScroll(true);
		requestAnimationFrame(() => {
			const logEl = document.querySelector(".og-activity-log");
			if (logEl) logEl.scrollTop = logEl.scrollHeight;
		});
	}, [selectedTaskId]);

	// ── Handlers ─────────────────────────────────────────────────────────────

	const {
		handleSend,
		handleStop,
		handleClarifySubmit,
		handleClearSessions,
		handleDeleteTask,
		handlePauseTask,
		handleClearTaskSession,
		handleAddProject,
		handleDeleteProject,
		handleAddTask,
		handleCreateTask,
		handleCancelCreate,
		handleDeleteTaskByDrag,
	} = createActionHandlers({
		projectId,
		selectedTaskId,
		rootNodeId,
		selectedNode,
		isOrchestratorNode,
		targetNodeId,
		clarifyAnswers,
		pendingClarifications,
		newProjectPath,
		creatingProject,
		projects,
		addLog,
		setLogs,
		setLastTurns,
		setLastInputTokens,
		setLastCacheCreationTokens,
		setLastCacheReadTokens,
		setLastOutputTokens,
		setProjectId,
		setSelectedTaskId,
		setRootNodeId,
		setClarifyAnswers,
		setCreatingProject,
		setNewProjectPath,
		setShowAddProject,
		setIsCreatingTask,
		start,
		stop,
		compact,
		sendMessage,
		sendMessageToTask,
		deleteTask,
		clearTaskSession,
		initProject,
		deleteProject,
		refreshTasks,
		t,
	});

	const filterLabel = isOrchestratorNode
		? t("orch.label")
		: selectedNode
			? selectedNode.title
			: null;

	// ── Render ───────────────────────────────────────────────────────────────

	return (
		<>
			<AppHeader
				connected={connected}
				projects={projects}
				projectId={projectId}
				showAddProject={showAddProject}
				newProjectPath={newProjectPath}
				creatingProject={creatingProject}
				showSettings={showSettings}
				theme={theme}
				onProjectChange={(id) => {
					setProjectId(id);
					setSelectedTaskId(null);
					setRootNodeId(null);
					setLogs([]);
				}}
				onDeleteProject={handleDeleteProject}
				onShowAddProject={() => setShowAddProject(true)}
				onAddProject={handleAddProject}
				onNewProjectPathChange={setNewProjectPath}
				onCancelAddProject={() => {
					setShowAddProject(false);
					setNewProjectPath("");
				}}
				onToggleSettings={() => setShowSettings((s) => !s)}
				onThemeChange={(t) => setThemeState(t as typeof theme)}
				onLogout={onLogout}
				onToggleSidebar={() => setSidebarOpen((s) => !s)}
			/>

			{showSettings && projectId && (
				<SettingsPanel
					projectId={projectId}
					layers={layers}
					loading={configLoading}
					updateGlobal={updateGlobal}
					updateRepo={updateRepo}
					updateLocal={updateLocal}
					onClose={() => setShowSettings(false)}
					onRestart={async () => {
						try {
							await authFetch("/restart-daemon", { method: "POST" });
							addLog({
								type: "lifecycle",
								content: "Daemon restarting…",
								ts: Date.now(),
							});
						} catch {
							addLog({
								type: "lifecycle",
								content: "Daemon restarting…",
								ts: Date.now(),
							});
						}
					}}
				/>
			)}

			<main className="og-main">
				{/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop is a visual overlay, not a focusable control */}
				{/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop is dismissed by Escape key or clicking outside */}
				<div
					className={`og-sidebar-backdrop${sidebarOpen ? " og-sidebar-open" : ""}`}
					onClick={() => setSidebarOpen(false)}
				/>
				<aside className={`og-sidebar${sidebarOpen ? " og-sidebar-open" : ""}`}>
					<div className="og-panel-header">
						<span className="og-panel-title">{t("tasks.title")}</span>
						<div className="og-panel-actions">
							{selectedTaskId && !isOrchestratorNode && (
								<>
									<span className="og-filter-chip" title={filterLabel ?? ""}>
										{filterLabel}
									</span>
									<button
										type="button"
										className="og-btn-icon"
										onClick={() => setSelectedTaskId(rootNodeId)}
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
						rootNodeId={rootNodeId}
						activeAgents={activeAgents}
						onSelect={(id) => {
							setSelectedTaskId(id);
							setSidebarOpen(false);
						}}
						onReorder={reorderTasks}
						onReparent={reparentTask}
						isCreating={isCreatingTask}
						onCreateTask={handleCreateTask}
						onCancelCreate={handleCancelCreate}
						onDeleteTask={handleDeleteTaskByDrag}
					/>
				</aside>

				<section
					className={`og-content${isDragging ? " dragging" : ""}`}
					ref={contentPanelRef}
				>
					<div
						className="og-detail-panel"
						style={
							{
								"--split-ratio": splitRatio,
								minHeight: 0,
							} as React.CSSProperties
						}
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
								isRootActive={rootNodeId ? activeAgents.has(rootNodeId) : false}
								nodes={nodes}
								rootNodeId={rootNodeId}
								totalCost={totalCost}
								turns={lastTurns}
								inputTokens={lastInputTokens}
								cacheCreationTokens={lastCacheCreationTokens}
								cacheReadTokens={lastCacheReadTokens}
								outputTokens={lastOutputTokens}
								provider={agentProvider}
								model={agentModel}
								onClearSessions={handleClearSessions}
								onStop={handleStop}
							/>
						) : selectedNode ? (
							<TaskDetail
								node={selectedNode}
								projectId={projectId}
								isActive={activeAgents.has(selectedNode.id)}
								onDelete={handleDeleteTask}
								onPause={handlePauseTask}
								onClearSession={handleClearTaskSession}
							/>
						) : (
							<div className="og-detail-empty">
								<IconHexagon size={28} />
								<span>{t("detail.selectTask")}</span>
							</div>
						)}
					</div>

					{/* biome-ignore lint/a11y/noStaticElementInteractions: resize handle */}
					<div
						className="og-resize-divider"
						onMouseDown={handleDividerMouseDown}
					/>

					<div
						className="og-activity-panel"
						style={
							{
								"--activity-ratio": 1 - splitRatio,
							} as React.CSSProperties
						}
					>
						<div className="og-panel-header">
							<span className="og-panel-title">
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
							<div className="og-panel-actions">
								{(() => {
									const usageTaskId =
										targetNodeId ??
										selectedTaskId ??
										rootNodeId ??
										nodes.find((n) => !n.parentId && n.status === "in_progress")
											?.id ??
										"orchestrator";
									const usage = tokenUsage[usageTaskId];
									return usage ? (
										<TokenUsageBadge
											inputTokens={usage.inputTokens}
											contextWindow={usage.contextWindow}
											estimated={usage.estimated}
											onCompact={
												isSelectedTaskActive
													? () => {
															compact();
														}
													: undefined
											}
										/>
									) : null;
								})()}
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
							rootNodeId={rootNodeId}
							nodeMap={nodeMap}
							autoScroll={autoScroll}
							onAutoScrollChange={setAutoScroll}
							isActive={isSelectedTaskActive}
						/>
					</div>
				</section>
			</main>

			<AppFooter
				projectId={projectId}
				targetNodeId={targetNodeId}
				nodeMap={nodeMap}
				pendingMessages={pendingMessages}
				pendingClarifications={pendingClarifications}
				clarifyAnswers={clarifyAnswers}
				onSend={handleSend}
				onClearTarget={() => {
					setTargetNodeId(null);
					setSelectedTaskId(rootNodeId);
				}}
				onClarifySubmit={handleClarifySubmit}
				onClarifyAnswerChange={(clarificationId, value) =>
					setClarifyAnswers((prev) => ({
						...prev,
						[clarificationId]: value,
					}))
				}
			/>

			{themes[theme]?.hasCat && <CuteCat />}
		</>
	);
}
