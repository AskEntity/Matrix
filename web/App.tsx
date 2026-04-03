import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api.ts";
import { authFetch, clearToken } from "./auth.ts";
import { ActivityLog } from "./components/ActivityLog.tsx";
import { AppFooter } from "./components/AppFooter.tsx";
import { AppHeader } from "./components/AppHeader.tsx";
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
import { LoginPage } from "./components/LoginPage.tsx";
import { OrchestratorDetail } from "./components/OrchestratorDetail.tsx";
import { RelocateBanner } from "./components/RelocateBanner.tsx";
import { SettingsPanel } from "./components/SettingsPanel.tsx";
import { statusDotClass } from "./components/StatusBadge.tsx";
import { TaskDetail } from "./components/TaskDetail.tsx";
import { TaskTree } from "./components/TaskTree.tsx";
import { TokenUsageBadge } from "./components/TokenUsageBadge.tsx";
import { createEventHandler } from "./event-handler.ts";
import { createActionHandlers } from "./handlers.ts";
import {
	createLogEntry,
	type IncomingEvent,
	isTask,
	type LogEntry,
	type TreeNode,
	type UIEvent,
	useAgent,
	useProjects,
	useSSE,
	useTasks,
	useThreeLayerConfig,
} from "./hooks.ts";
import { LocaleProvider, useLocale } from "./i18n.ts";
import { MockShowcase } from "./MockShowcase.tsx";
import { applyTheme, themes } from "./themes.ts";

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

/** Check ?mock query param once at module load — never changes during session. */
const IS_MOCK_MODE = new URLSearchParams(window.location.search).has("mock");

export function App() {
	return (
		<LocaleProvider>
			<ErrorBoundary>
				{IS_MOCK_MODE ? <MockShowcase /> : <AppInner />}
			</ErrorBoundary>
		</LocaleProvider>
	);
}

function AppInner() {
	// Auth state — check on mount
	const [authState, setAuthState] = useState<
		"loading" | "authenticated" | "login"
	>("loading");

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
			.then((data: { enabled?: boolean; authenticated?: boolean }) => {
				if (data.authenticated) {
					setAuthState("authenticated");
				} else {
					setAuthState("login");
				}
			})
			.catch(() => {
				// If auth endpoint fails, assume no auth needed (backward compatible)
				setAuthState("authenticated");
			});
	}, []);

	if (authState === "loading") {
		return (
			<div className="mxd-login-page">
				<div className="mxd-login-container">
					<div className="mxd-login-brand">
						<div className="mxd-login-brand-content">
							<div className="mxd-login-logo">
								<IconHexagon size={32} />
							</div>
							<h1 className="mxd-login-title">Matrix</h1>
						</div>
						<div className="mxd-login-brand-decoration" />
					</div>
					<div className="mxd-login-auth">
						<div className="mxd-login-loading">
							<div className="mxd-login-spinner" />
							<p>Loading…</p>
						</div>
					</div>
				</div>
			</div>
		);
	}

	if (authState === "login") {
		return <LoginPage onAuthenticated={() => setAuthState("authenticated")} />;
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
		updateProject,
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
	const [sidebarCollapsed, setSidebarCollapsed] = useState(
		() => localStorage.getItem("mxd-sidebar-collapsed") === "true",
	);
	const [sidebarWidth, setSidebarWidth] = useState(() => {
		const stored = localStorage.getItem("mxd-sidebar-width");
		return stored ? Number(stored) : 288;
	});
	const [isSidebarDragging, setIsSidebarDragging] = useState(false);
	const [openTabs, setOpenTabs] = useState<string[]>(() => {
		let tabs: string[] = [];
		try {
			const stored = localStorage.getItem("mxd-open-tabs");
			if (stored) {
				const parsed = JSON.parse(stored);
				if (Array.isArray(parsed)) tabs = parsed;
			}
		} catch {
			/* ignore */
		}
		// Ensure the hash taskId is in the tab list
		const hashTask = initialHash.taskId;
		if (hashTask && !tabs.includes(hashTask)) {
			tabs = [...tabs, hashTask];
			localStorage.setItem("mxd-open-tabs", JSON.stringify(tabs));
		}
		return tabs;
	});
	const [previewTabId, setPreviewTabId] = useState<string | null>(null);
	const [viewMode, setViewMode] = useState<"activity" | "description">(
		"activity",
	);
	const [autoScroll, setAutoScroll] = useState(true);
	const [fullscreen, setFullscreen] = useState(false);
	const [theme, setThemeState] = useState<
		"dark" | "light" | "cute-light" | "cute-dark"
	>(() => {
		const stored = localStorage.getItem("mxd-theme");
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
		{
			id: string;
			taskId: string;
			question: string;
			title?: string;
			body?: string;
			timestamp: number;
		}[]
	>([]);
	const [clarifyAnswers, setClarifyAnswers] = useState<Record<string, string>>(
		{},
	);
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
	/** Per-session flag indicating older events exist before the compact barrier */
	const [olderEventsAvailable, setOlderEventsAvailable] = useState<
		Map<string, { hasOlder: boolean; oldestTs: number }>
	>(() => new Map());
	const [loadingOlderEvents, setLoadingOlderEvents] = useState(false);

	// The currently viewed session = selectedTaskId ?? rootNodeId.
	// Kept as a ref so callbacks (handleReconnect) don't need to re-create on every selection change.
	const viewedSessionRef = useRef<string | null>(null);
	const viewedSessionId = selectedTaskId ?? rootNodeId;
	viewedSessionRef.current = viewedSessionId;

	const {
		nodes,
		refresh: refreshTasks,
		updateFromWS,
	} = useTasks(projectId, setRootNodeId);
	const {
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
		stopTask,
		clearTaskSession,
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
		const map = new Map<string, TreeNode>();
		for (const n of nodes) map.set(n.id, n);
		return map;
	}, [nodes]);
	const totalCost = useMemo(() => {
		const sum = nodes.reduce(
			(acc, n) => (isTask(n) ? acc + n.costUsd : acc),
			0,
		);
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
		localStorage.setItem("mxd-theme", theme);
	}, [theme]);

	useEffect(() => {
		const currentProject = projects.find((p) => p.id === projectId);
		const projectName = currentProject?.name ?? "";
		const base = `Matrix${projectName ? ` — ${projectName}` : ""}`;

		const childNodes = rootNodeId
			? nodes.filter((n) => n.id !== rootNodeId)
			: nodes;
		const total = childNodes.length;
		if (total === 0) {
			document.title = base;
			return;
		}
		const passed = childNodes.filter(
			(n) => isTask(n) && n.status === "verify",
		).length;
		const failed = childNodes.filter(
			(n) => isTask(n) && n.status === "failed",
		).length;
		if (failed > 0) document.title = `${base} [!${failed}]`;
		else if (passed === total) document.title = `${base} [✓]`;
		else document.title = `${base} [${passed}/${total}]`;
	}, [nodes, rootNodeId, projects, projectId]);

	// ── Sidebar resize ───────────────────────────────────────────────────

	const handleSidebarResizeStart = useCallback((e: React.MouseEvent) => {
		e.preventDefault();
		setIsSidebarDragging(true);
	}, []);

	useEffect(() => {
		if (!isSidebarDragging) return;
		const SNAP_CLOSE_THRESHOLD = 100;
		const MIN_OPEN_WIDTH = 180;
		const MAX_WIDTH = 600;
		let hasDragged = false;
		const handleMouseMove = (e: MouseEvent) => {
			hasDragged = true;
			if (e.clientX < SNAP_CLOSE_THRESHOLD) {
				// Snap closed — show at 0 width during drag
				setSidebarWidth(0);
				setSidebarCollapsed(true);
			} else {
				setSidebarCollapsed(false);
				setSidebarWidth(
					Math.min(MAX_WIDTH, Math.max(MIN_OPEN_WIDTH, e.clientX)),
				);
			}
		};
		const handleMouseUp = (e: MouseEvent) => {
			setIsSidebarDragging(false);
			// If user just clicked (no drag), toggle collapsed
			if (!hasDragged) {
				setSidebarCollapsed((prev) => {
					const next = !prev;
					localStorage.setItem("mxd-sidebar-collapsed", String(next));
					if (!next) {
						// Restore previous width when expanding via click
						const stored = localStorage.getItem("mxd-sidebar-width");
						if (stored) setSidebarWidth(Number(stored));
					}
					return next;
				});
				return;
			}
			if (e.clientX < SNAP_CLOSE_THRESHOLD) {
				// Snap to collapsed
				setSidebarCollapsed(true);
				localStorage.setItem("mxd-sidebar-collapsed", "true");
			} else {
				const finalWidth = Math.min(
					MAX_WIDTH,
					Math.max(MIN_OPEN_WIDTH, e.clientX),
				);
				setSidebarWidth(finalWidth);
				setSidebarCollapsed(false);
				localStorage.setItem("mxd-sidebar-collapsed", "false");
				localStorage.setItem("mxd-sidebar-width", String(finalWidth));
			}
		};
		document.addEventListener("mousemove", handleMouseMove);
		document.addEventListener("mouseup", handleMouseUp);
		return () => {
			document.removeEventListener("mousemove", handleMouseMove);
			document.removeEventListener("mouseup", handleMouseUp);
		};
	}, [isSidebarDragging]);

	const handleToggleSidebarCollapse = useCallback(() => {
		setSidebarCollapsed((prev) => {
			const next = !prev;
			localStorage.setItem("mxd-sidebar-collapsed", String(next));
			return next;
		});
	}, []);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement;
			const isInput =
				target.tagName === "INPUT" ||
				target.tagName === "TEXTAREA" ||
				target.isContentEditable;
			if (e.key === "Escape" && !isInput) {
				if (fullscreen) {
					setFullscreen(false);
				} else {
					setSelectedTaskId(rootNodeId);
					setTargetNodeId(null);
				}
			}
			if (e.key === "/" && !isInput) {
				e.preventDefault();
				(
					document.querySelector(".mxd-lmxd-search") as HTMLInputElement | null
				)?.focus();
			}
			// Ctrl+B / Cmd+B toggles sidebar (VSCode convention)
			if (e.key === "b" && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
				e.preventDefault();
				handleToggleSidebarCollapse();
			}
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [rootNodeId, fullscreen, handleToggleSidebarCollapse]);

	// ── SSE handler ──────────────────────────────────────────────────────────

	const { handleEvent, processEventBatch } = useMemo(
		() =>
			createEventHandler({
				updateFromWS,
				setRootNodeId,
				setOlderEventsAvailable,
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
				setBackgroundProcesses,
				t,
				getViewedSessionId: () => viewedSessionRef.current,
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

	/** Process event response: update logs and track which sessions have older events */
	const processEventResponse = useCallback(
		(data: { events?: IncomingEvent[]; hasOlderEvents?: boolean }) => {
			if (data.events && data.events.length > 0) {
				processEventBatch(data.events);

				// Track per-session older events availability
				if (data.hasOlderEvents) {
					const sessionMap = new Map<string, number>();
					for (const evt of data.events) {
						const taskId = "taskId" in evt ? (evt.taskId as string) : undefined;
						const ts = "ts" in evt ? (evt.ts as number) : undefined;
						if (taskId && ts !== undefined) {
							const existing = sessionMap.get(taskId);
							if (existing === undefined || ts < existing) {
								sessionMap.set(taskId, ts);
							}
						}
					}
					setOlderEventsAvailable((prev) => {
						const next = new Map(prev);
						for (const [sid, oldestTs] of sessionMap) {
							next.set(sid, { hasOlder: true, oldestTs });
						}
						return next;
					});
				}
			}
		},
		[processEventBatch],
	);

	// Re-fetch full event history on SSE reconnect.
	// The SSE ring buffer handles short disconnects via Last-Event-ID,
	// but for longer gaps we need to re-fetch everything.
	// Pending messages are derived from JSONL events (no separate endpoint).
	const handleReconnect = useCallback(() => {
		if (!projectId) return;
		const sessionId = viewedSessionRef.current;
		if (!sessionId) return;
		// Re-fetch events for the viewed session with compact barrier
		authFetch(api.taskEvents(projectId, sessionId, "after=compact"))
			.then((r) => r.json())
			.then(processEventResponse)
			.catch((e) =>
				console.warn("[App] Failed to re-fetch events on reconnect:", e),
			);
		// Re-fetch pending clarifications (still ephemeral/in-memory)
		authFetch(api.clarifications(projectId))
			.then((r) => r.json())
			.then(
				(data: {
					clarifications: {
						id: string;
						taskId: string;
						question: string;
						title?: string;
						body?: string;
						timestamp: number;
					}[];
				}) => setPendingClarifications(data.clarifications ?? []),
			)
			.catch((e) =>
				console.warn(
					"[App] Failed to re-fetch clarifications on reconnect:",
					e,
				),
			);
	}, [projectId, processEventResponse]);

	const { connected } = useSSE(
		projectId,
		handleEvent,
		checkStatus,
		handleReconnect,
	);

	useEffect(() => {
		if (projects.length === 0) return;
		if (projectId && projects.some((p) => p.id === projectId)) return;
		const first = projects[0];
		if (first) setProjectId(first.id);
	}, [projects, projectId]);

	// Fetch event history for the viewed session (compact barrier optimization).
	// Re-fires on project change AND task selection change so each session's events are fetched independently.
	// biome-ignore lint/correctness/useExhaustiveDependencies: processEventResponse is stable (wraps useMemo'd processEventBatch)
	useEffect(() => {
		if (!projectId || !viewedSessionId) return;
		let cancelled = false;
		setOlderEventsAvailable(new Map());
		authFetch(api.taskEvents(projectId, viewedSessionId, "after=compact"))
			.then((r) => r.json())
			.then((data: { events?: IncomingEvent[]; hasOlderEvents?: boolean }) => {
				if (cancelled) return;
				processEventResponse(data);
			})
			.catch((e) =>
				console.warn("[App] Failed to fetch events for session:", e),
			);
		return () => {
			cancelled = true;
		};
	}, [projectId, viewedSessionId]);

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
				setTokenUsage({});
				setPendingMessages([]);
				setPendingClarifications([]);
				setBackgroundProcesses(new Map());
				setActiveAgents(new Set());
				setOlderEventsAvailable(new Map());
				setLastTurns(null);
				setLastInputTokens(null);
				setLastCacheCreationTokens(null);
				setLastCacheReadTokens(null);
				setLastOutputTokens(null);
			} else if (ht && ht !== selectedTaskId) {
				setSelectedTaskId(ht);
			} else if (!ht && selectedTaskId !== rootNodeId) {
				setSelectedTaskId(rootNodeId);
			}
		};
		window.addEventListener("hashchange", onHashChange);
		return () => window.removeEventListener("hashchange", onHashChange);
	}, [projectId, selectedTaskId, rootNodeId, setActiveAgents]);

	useEffect(() => {
		if (projectId) checkStatus();
	}, [projectId, checkStatus]);

	// Pending messages are derived from JSONL events by processEventBatch.
	// Clear on project change — the event fetch will repopulate.
	useEffect(() => {
		if (!projectId) {
			setPendingMessages([]);
		}
	}, [projectId]);

	useEffect(() => {
		if (!projectId) {
			setPendingClarifications([]);
			setClarifyAnswers({});
			return;
		}
		authFetch(api.clarifications(projectId))
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
		// handles routing (auto-resume for non-running tasks).
		setTargetNodeId(selectedTaskId);
	}, [selectedTaskId, rootNodeId]);

	// Clean up stale tabs (nodes that were deleted).
	// Guard: skip when nodeMap is empty (nodes not yet loaded from server).
	useEffect(() => {
		if (openTabs.length === 0 || nodeMap.size === 0) return;
		const validTabs = openTabs.filter((id) => nodeMap.has(id));
		if (validTabs.length !== openTabs.length) {
			setOpenTabs(validTabs);
			localStorage.setItem("mxd-open-tabs", JSON.stringify(validTabs));
		}
	}, [openTabs, nodeMap]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: only trigger on task selection change
	useEffect(() => {
		setAutoScroll(true);
		setViewMode("activity");
		requestAnimationFrame(() => {
			const logEl = document.querySelector(".mxd-activity-log");
			if (logEl) logEl.scrollTop = logEl.scrollHeight;
		});
	}, [selectedTaskId]);

	// ── Handlers ─────────────────────────────────────────────────────────────

	const {
		handleSend,
		handleStop,
		handleClarifySubmit,
		handleClearSessions,
		handleClearRootSession,
		handleDeleteTask,
		handleStopTask,
		handleClearTaskSession,
		handleAddProject,
		handleDeleteProject,
		handleAddTask,
		handleCreateTask,
		handleCancelCreate,
	} = useMemo(
		() =>
			createActionHandlers({
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
				setPendingClarifications,
				setCreatingProject,
				setNewProjectPath,
				setShowAddProject,
				setShowSettings,
				setIsCreatingTask,
				setTokenUsage,
				setPendingMessages,
				setBackgroundProcesses,
				setActiveAgents,
				setOlderEventsAvailable,
				start,
				stop,
				compact,
				sendMessageToTask,
				deleteTask,
				stopTask,
				clearTaskSession,
				initProject,
				deleteProject,
				refreshTasks,
				t,
			}),
		[
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
			start,
			stop,
			compact,
			sendMessageToTask,
			deleteTask,
			stopTask,
			clearTaskSession,
			initProject,
			deleteProject,
			refreshTasks,
			t,
			setActiveAgents,
		],
	);

	// ── Stabilized callbacks for memoized child components ───────────────────

	const handleProjectChange = useCallback(
		(id: string) => {
			setProjectId(id);
			setSelectedTaskId(null);
			setRootNodeId(null);
			setOpenTabs([]);
			localStorage.setItem("mxd-open-tabs", "[]");
			setLogs([]);
			setTokenUsage({});
			setPendingMessages([]);
			setPendingClarifications([]);
			setBackgroundProcesses(new Map());
			setActiveAgents(new Set());
			setOlderEventsAvailable(new Map());
			setLastTurns(null);
			setLastInputTokens(null);
			setLastCacheCreationTokens(null);
			setLastCacheReadTokens(null);
			setLastOutputTokens(null);
		},
		[setActiveAgents],
	);

	const handleShowAddProject = useCallback(() => setShowAddProject(true), []);

	const handleCancelAddProject = useCallback(() => {
		setShowAddProject(false);
		setNewProjectPath("");
	}, []);

	const handleToggleSettings = useCallback(
		() => setShowSettings((s) => !s),
		[],
	);

	const handleThemeChange = useCallback(
		(t: string) => setThemeState(t as typeof theme),
		[],
	);

	const handleToggleSidebar = useCallback(() => setSidebarOpen((s) => !s), []);

	// Use refs to read current preview/tabs without deps
	const previewTabRef = useRef(previewTabId);
	previewTabRef.current = previewTabId;
	const openTabsRef = useRef(openTabs);
	openTabsRef.current = openTabs;

	const handleTaskSelect = useCallback(
		(id: string | null) => {
			setSelectedTaskId(id);
			setSidebarOpen(false);
			if (!id || id === rootNodeId) return;
			const prev = openTabsRef.current;
			const curPreview = previewTabRef.current;
			if (prev.includes(id)) {
				// Already open — just select it
				return;
			}
			let next: string[];
			if (curPreview && prev.includes(curPreview)) {
				// Replace preview tab in-place
				next = prev.map((t) => (t === curPreview ? id : t));
			} else {
				// Append new tab
				next = [...prev, id];
			}
			setOpenTabs(next);
			setPreviewTabId(id);
			localStorage.setItem("mxd-open-tabs", JSON.stringify(next));
		},
		[rootNodeId],
	);

	const handleTaskPin = useCallback(
		(id: string | null) => {
			if (!id || id === rootNodeId) return;
			setSelectedTaskId(id);
			setSidebarOpen(false);
			// Pin: add to tabs if not present, clear preview
			setPreviewTabId((prev) => (prev === id ? null : prev));
			setOpenTabs((prev) => {
				if (prev.includes(id)) return prev;
				const next = [...prev, id];
				localStorage.setItem("mxd-open-tabs", JSON.stringify(next));
				return next;
			});
		},
		[rootNodeId],
	);

	const handleTabSelect = useCallback((id: string | null) => {
		setSelectedTaskId(id);
	}, []);

	const handleTabDoubleClick = useCallback((id: string) => {
		// Double-click pins the tab (removes from preview)
		setPreviewTabId((prev) => (prev === id ? null : prev));
	}, []);

	const [tabDragId, setTabDragId] = useState<string | null>(null);

	const handleTabDragStart = useCallback(
		(tabId: string, e: React.DragEvent) => {
			e.dataTransfer.effectAllowed = "move";
			e.dataTransfer.setData("text/plain", tabId);
			setTimeout(() => setTabDragId(tabId), 0);
		},
		[],
	);

	const handleTabDragOver = useCallback(
		(tabId: string, e: React.DragEvent) => {
			if (!tabDragId || tabDragId === tabId) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = "move";
			// Reorder on hover for instant visual feedback
			setOpenTabs((prev) => {
				const fromIdx = prev.indexOf(tabDragId);
				const toIdx = prev.indexOf(tabId);
				if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return prev;
				const next = [...prev];
				next.splice(fromIdx, 1);
				next.splice(toIdx, 0, tabDragId);
				return next;
			});
		},
		[tabDragId],
	);

	const handleTabDragEnd = useCallback(() => {
		setTabDragId(null);
		// Persist final order
		localStorage.setItem("mxd-open-tabs", JSON.stringify(openTabsRef.current));
	}, []);

	const handleTabClose = useCallback(
		(id: string, e?: React.MouseEvent) => {
			e?.stopPropagation();
			setPreviewTabId((prev) => (prev === id ? null : prev));
			setOpenTabs((prev) => {
				const next = prev.filter((t) => t !== id);
				localStorage.setItem("mxd-open-tabs", JSON.stringify(next));
				// If closing the active tab, select the nearest remaining tab or orchestrator
				if (selectedTaskId === id) {
					const closedIndex = prev.indexOf(id);
					const newActive =
						next[Math.min(closedIndex, next.length - 1)] ?? rootNodeId;
					setSelectedTaskId(newActive);
				}
				return next;
			});
		},
		[selectedTaskId, rootNodeId],
	);

	const handleClarifyAnswerChange = useCallback(
		(clarificationId: string, value: string) =>
			setClarifyAnswers((prev) => ({
				...prev,
				[clarificationId]: value,
			})),
		[],
	);

	/** Load older events before the compact barrier for a given session */
	const handleLoadOlderEvents = useCallback(
		async (sessionId: string) => {
			if (!projectId || loadingOlderEvents) return;
			const info = olderEventsAvailable.get(sessionId);
			if (!info?.hasOlder) return;

			setLoadingOlderEvents(true);
			try {
				const res = await authFetch(
					api.eventsOlder(
						projectId,
						`session=${encodeURIComponent(sessionId)}&before=${info.oldestTs}&limit=200`,
					),
				);
				const data = (await res.json()) as {
					events?: IncomingEvent[];
					hasMore?: boolean;
				};
				if (data.events && data.events.length > 0) {
					// Re-fetch all events for this session to get a complete picture, then re-process.
					// Simpler than trying to prepend and re-process.
					const fullRes = await authFetch(api.taskEvents(projectId, sessionId));
					const fullData = (await fullRes.json()) as {
						events?: IncomingEvent[];
					};
					if (fullData.events && fullData.events.length > 0) {
						processEventBatch(fullData.events);
					}
					// Update older events availability
					setOlderEventsAvailable((prev) => {
						const next = new Map(prev);
						if (data.hasMore) {
							// Find the oldest ts from the older events we received
							let minTs = info.oldestTs;
							for (const evt of data.events ?? []) {
								const ts = "ts" in evt ? (evt.ts as number) : undefined;
								if (ts !== undefined && ts < minTs) minTs = ts;
							}
							next.set(sessionId, { hasOlder: true, oldestTs: minTs });
						} else {
							next.delete(sessionId);
						}
						return next;
					});
				} else {
					// No older events returned
					setOlderEventsAvailable((prev) => {
						const next = new Map(prev);
						next.delete(sessionId);
						return next;
					});
				}
			} catch {
				// Silently fail — user can retry
			} finally {
				setLoadingOlderEvents(false);
			}
		},
		[projectId, loadingOlderEvents, olderEventsAvailable, processEventBatch],
	);

	const currentProject = projects.find((p) => p.id === projectId);
	const projectPathMissing = currentProject?.pathExists === false;

	const handleRelocate = useCallback(
		async (newPath: string) => {
			if (!projectId) return;
			await updateProject(projectId, { path: newPath });
		},
		[projectId, updateProject],
	);

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
				onProjectChange={handleProjectChange}
				onShowAddProject={handleShowAddProject}
				onAddProject={handleAddProject}
				onNewProjectPathChange={setNewProjectPath}
				onCancelAddProject={handleCancelAddProject}
				onToggleSettings={handleToggleSettings}
				onThemeChange={handleThemeChange}
				onLogout={onLogout}
				onToggleSidebar={handleToggleSidebar}
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
					onDeleteProject={handleDeleteProject}
					onClearAllSessions={handleClearSessions}
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

			<main
				className={`mxd-main${fullscreen ? " mxd-fullscreen" : ""}${isSidebarDragging ? " mxd-sidebar-resizing" : ""}`}
			>
				{/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop is a visual overlay, not a focusable control */}
				{/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop is dismissed by Escape key or clicking outside */}
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
								onClick={handleAddTask}
								data-tip={t("tasks.addTask")}
							>
								<IconPlus size={13} />
							</button>
							<button
								type="button"
								className="mxd-btn-icon"
								onClick={() => {
									refreshTasks();
									refreshProjects();
								}}
								data-tip={t("tasks.refresh")}
							>
								<IconRefresh size={13} />
							</button>
							{projectId && (
								<button
									type="button"
									className="mxd-btn-icon mxd-sidebar-settings-btn"
									onClick={() => {
										setSidebarOpen(false);
										handleToggleSettings();
									}}
									data-tip={t("project.settings")}
								>
									<IconGear size={13} />
								</button>
							)}
						</div>
					</div>
					<TaskTree
						nodes={nodes}
						selectedTaskId={selectedTaskId}
						rootNodeId={rootNodeId}
						activeAgents={activeAgents}
						onSelect={handleTaskSelect}
						onDoubleClick={handleTaskPin}
						onReorder={reorderTasks}
						onReparent={reparentTask}
						isCreating={isCreatingTask}
						onCreateTask={handleCreateTask}
						onCancelCreate={handleCancelCreate}
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
								const isTabActive = isTask(tabNode) && activeAgents.has(tabId);
								const isPreview = previewTabId === tabId;
								return (
									<button
										key={tabId}
										type="button"
										className={`mxd-tab${isActive ? " mxd-tab-active" : ""}${isPreview ? " mxd-tab-preview" : ""}${tabDragId === tabId ? " mxd-tab-dragging" : ""}`}
										onClick={() => handleTabSelect(tabId)}
										onDoubleClick={() => handleTabDoubleClick(tabId)}
										draggable
										onDragStart={(e) => handleTabDragStart(tabId, e)}
										onDragOver={(e) => handleTabDragOver(tabId, e)}
										onDragEnd={handleTabDragEnd}
									>
										{isTabActive && <span className="mxd-task-spinner" />}
										{isTask(tabNode) && !isTabActive && (
											<span
												className={`mxd-tab-dot ${statusDotClass(tabNode.status)}`}
											/>
										)}
										<span className="mxd-tab-label">{tabNode.title}</span>
										{/* biome-ignore lint/a11y/useKeyWithClickEvents: close button is mouse-only */}
										{/* biome-ignore lint/a11y/noStaticElementInteractions: tab close affordance */}
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
					{projectPathMissing && currentProject && (
						<RelocateBanner
							projectPath={currentProject.path}
							onRelocate={handleRelocate}
						/>
					)}

					{/* Compact metadata header for task views */}
					{!isOrchestratorNode && selectedNode && isTask(selectedNode) && (
						<div className="mxd-task-meta-bar">
							<TaskDetail
								node={selectedNode}
								projectId={projectId}
								isActive={activeAgents.has(selectedNode.id)}
								onDelete={handleDeleteTask}
								onStop={handleStopTask}
								onClearSession={handleClearTaskSession}
								compact
							/>
						</div>
					)}

					{/* View mode panel header */}
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
							{(() => {
								const usageTaskId =
									targetNodeId ??
									selectedTaskId ??
									rootNodeId ??
									nodes.find(
										(n) =>
											!n.parentId && isTask(n) && n.status === "in_progress",
									)?.id ??
									"orchestrator";
								const usage = tokenUsage[usageTaskId];
								return usage ? (
									<TokenUsageBadge
										inputTokens={usage.inputTokens}
										contextWindow={usage.contextWindow}
										estimated={usage.estimated}
										onCompact={() => {
											compact(viewedTaskId ?? undefined);
										}}
									/>
								) : null;
							})()}
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
								projectId={projectId}
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
								isActive={isSelectedTaskActive}
								projectId={projectId}
								olderEventsAvailable={olderEventsAvailable}
								loadingOlderEvents={loadingOlderEvents}
								onLoadOlderEvents={handleLoadOlderEvents}
								onTaskNavigate={handleTaskPin}
							/>
						</div>
					) : isOrchestratorNode ? (
						<div className="mxd-description-view">
							<OrchestratorDetail
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
								onClearSession={handleClearRootSession}
								onStop={handleStop}
							/>
						</div>
					) : selectedNode && isTask(selectedNode) ? (
						<div className="mxd-description-view">
							<TaskDetail
								node={selectedNode}
								projectId={projectId}
								isActive={activeAgents.has(selectedNode.id)}
								onDelete={handleDeleteTask}
								onStop={handleStopTask}
								onClearSession={handleClearTaskSession}
							/>
						</div>
					) : null}
				</section>
			</main>

			<AppFooter
				projectId={projectId}
				targetNodeId={targetNodeId}
				rootNodeId={rootNodeId}
				nodeMap={nodeMap}
				pendingMessages={pendingMessages}
				pendingClarifications={pendingClarifications}
				clarifyAnswers={clarifyAnswers}
				onSend={handleSend}
				onClarifySubmit={handleClarifySubmit}
				onClarifyAnswerChange={handleClarifyAnswerChange}
			/>

			{themes[theme]?.hasCat && <CuteCat />}
		</>
	);
}
