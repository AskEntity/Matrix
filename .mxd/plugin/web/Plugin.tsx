import type React from "react";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isProductionProject } from "../production.ts";
import { api } from "./api.ts";
import { useAuthFetch } from "./auth.ts";
import { ActivityLog } from "./components/ActivityLog.tsx";
import { AppFooter } from "./components/AppFooter.tsx";
// AppHeader moved to daemon shell (web/components/AppHeader.tsx)
import { BackgroundProcessBar } from "./components/BackgroundProcessBar.tsx";
import { CuteCat } from "./components/CuteCat.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import {
	IconArrowDown,
	IconClose,
	IconExpand,
	IconHexagon,
	IconMinimize,
	IconPlus,
	IconRefresh,
	IconSidebarLeft,
} from "./components/icons.tsx";
// LoginPage removed — auth handled by daemon shell
import { OrchestratorDetail } from "./components/OrchestratorDetail.tsx";
// SettingsPanel moved to daemon shell (web/components/SettingsPanel.tsx)
import { statusDotClass } from "./components/StatusBadge.tsx";
import { TaskDetail } from "./components/TaskDetail.tsx";
import { TaskTree } from "./components/TaskTree.tsx";
import { TokenUsageBadge } from "./components/TokenUsageBadge.tsx";
import {
	createEventHandler,
	type PendingAction,
	type PendingMessage,
	pendingReducer,
} from "./event-handler.ts";
import { createActionHandlers } from "./handlers.ts";
import {
	createLogEntry,
	type IncomingEvent,
	isTask,
	type LogEntry,
	type TreeNode,
	type UIEvent,
	useAgent,
	useSSE,
	useTasks,
} from "./hooks.ts";
import { LocaleProvider, useLocale } from "./i18n.ts";
import { applyTheme, themes } from "./themes.ts";

// ── Sidebar state model ────────────────────────────────────────────────────
// ONE visibility state (`sidebarOpen`) works on both desktop (flex sibling)
// and mobile (fixed overlay). CSS handles the platform difference. Width is
// a separate concern — always represents "how wide when open", never encodes
// hidden-ness. Treating 0-width as "closed" was a double-state that caused
// the "button hides sidebar but sidebar is invisible" bug.
const SIDEBAR_MIN_OPEN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 600;
const SIDEBAR_SNAP_CLOSE_THRESHOLD = 100;
const SIDEBAR_DEFAULT_WIDTH = 288;
const MOBILE_BREAKPOINT_PX = 768;

const STORAGE_KEY_OPEN = "mxd-sidebar-open";
const STORAGE_KEY_WIDTH = "mxd-sidebar-width";
const LEGACY_STORAGE_KEY_COLLAPSED = "mxd-sidebar-collapsed"; // migrated to OPEN

/**
 * Initial sidebar-open state. Priority:
 * 1. New key `mxd-sidebar-open` — authoritative if set.
 * 2. Legacy key `mxd-sidebar-collapsed` — migrate (inverted), then delete.
 * 3. First visit: viewport default (desktop→open, mobile→closed).
 *
 * The migration runs lazily on first mount per browser. After one pass the
 * legacy key is gone and the new key owns the value.
 */
function readInitialSidebarOpen(): boolean {
	const stored = localStorage.getItem(STORAGE_KEY_OPEN);
	if (stored === "true") return true;
	if (stored === "false") return false;

	const legacy = localStorage.getItem(LEGACY_STORAGE_KEY_COLLAPSED);
	if (legacy !== null) {
		const open = legacy !== "true";
		localStorage.setItem(STORAGE_KEY_OPEN, String(open));
		localStorage.removeItem(LEGACY_STORAGE_KEY_COLLAPSED);
		return open;
	}

	// First visit — sensible default per viewport.
	return window.matchMedia(`(min-width: ${MOBILE_BREAKPOINT_PX + 1}px)`)
		.matches;
}

/**
 * Initial sidebar width. Always returns a valid width (>= MIN). Legacy
 * stored value of "0" (possible from earlier buggy snap-close code paths)
 * is treated as "missing" and falls back to default.
 */
function readInitialSidebarWidth(): number {
	const stored = localStorage.getItem(STORAGE_KEY_WIDTH);
	const parsed = stored != null ? Number(stored) : Number.NaN;
	if (Number.isFinite(parsed) && parsed >= SIDEBAR_MIN_OPEN_WIDTH) {
		return Math.min(parsed, SIDEBAR_MAX_WIDTH);
	}
	return SIDEBAR_DEFAULT_WIDTH;
}

// ── Mock-showcase lazy load ──────────────────────────────────────────────
// MockShowcase is a standalone dev page — lazy-loaded only when the user
// navigates to `/<projectId>/matrix/mock-showcase`. Keeps the main bundle
// clean for normal usage.
const LazyMockShowcase = lazy(() =>
	import("./MockShowcase.tsx").then((m) => ({ default: m.MockShowcase })),
);

// ── Path routing ──────────────────────────────────────────────────────────
//
// Task Y (2026-04-18): URL is `/<projectId>/<pluginScope>/<pluginPath>`.
// Shell owns the `/<projectId>/<pluginScope>/` prefix; plugin owns the
// suffix. Shell passes `pluginPath` (everything after `<pluginScope>/`)
// as a prop; plugin calls `pushPluginPath(path, replace?)` to navigate.
//
// The plugin's own path format is currently `<taskId>` (flat). Future
// plugins could extend to `<taskId>/<subPath>`. Parse is first segment:
function parsePluginPath(pluginPath: string): { taskId: string | null } {
	if (!pluginPath) return { taskId: null };
	const firstSlash = pluginPath.indexOf("/");
	const taskId =
		firstSlash === -1 ? pluginPath : pluginPath.slice(0, firstSlash);
	return { taskId: taskId || null };
}

// ── Main Plugin ───────────────────────────────────────────────────────────────

/**
 * Plugin component — renders content for a single project.
 * NOT a SPA. Receives projectId from shell. No auth, no project selection, no settings.
 */
function ProductionModePage() {
	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				height: "100%",
				background: "var(--bg-base, #0d1117)",
				color: "var(--text-primary, #e6edf3)",
				fontFamily: "var(--font-sans, system-ui)",
			}}
		>
			<div
				style={{
					display: "flex",
					gap: 48,
					alignItems: "center",
					maxWidth: 700,
				}}
			>
				<div style={{ textAlign: "center" }}>
					<div
						style={{
							width: 80,
							height: 80,
							borderRadius: 16,
							background: "var(--accent, #388bfd)",
							color: "#fff",
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							margin: "0 auto 16px",
							boxShadow: "0 4px 16px rgba(56, 139, 253, 0.3)",
						}}
					>
						<IconHexagon size={32} />
					</div>
					<div style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>
						Matrix
					</div>
					<div style={{ color: "var(--text-muted, #8b949e)", fontSize: 14 }}>
						Autonomous agent orchestration
					</div>
				</div>
				<div
					style={{
						color: "var(--text-secondary, #b1bac4)",
						fontSize: 15,
						lineHeight: 1.6,
					}}
				>
					Matrix is running in production mode. Please select a different
					project
				</div>
			</div>
		</div>
	);
}

/**
 * Props the shell passes to the plugin.
 *
 * Routing contract (Task Y, 2026-04-18): the shell owns `/<projectId>`
 * and `/<projectId>/<pluginScope>/`; the plugin owns the path after
 * `<pluginScope>/`. `pluginPath` is that suffix (empty on first visit,
 * `<taskId>` once normalized, `<taskId>/<subPath>` if the plugin ever
 * adds deeper routing). `pushPluginPath` lets the plugin navigate
 * within its own segment — shell converts it into a full URL and
 * updates `history.pushState` / `replaceState` accordingly.
 */
interface PluginProps {
	projectId: string;
	/** The lens (plugin NAME / URL `<pluginScope>`) the shell is showing. Passed
	 * to the SSE stream so it subscribes to THIS lens's events — under additive
	 * routing a project has a distinct tree per lens (matrix dev vs product). */
	scope: string;
	pluginPath: string;
	pushPluginPath: (path: string, replace?: boolean) => void;
}

export function Plugin({
	projectId,
	scope,
	pluginPath,
	pushPluginPath,
}: PluginProps) {
	if (!projectId)
		return (
			<div style={{ padding: 20, color: "#8b949e" }}>No project selected</div>
		);

	// Mock-showcase: standalone dev page at /<projectId>/matrix/mock-showcase
	if (pluginPath === "mock-showcase") {
		return (
			<LocaleProvider>
				<ErrorBoundary>
					<Suspense
						fallback={
							<div style={{ padding: 20, color: "#8b949e" }}>Loading…</div>
						}
					>
						<LazyMockShowcase />
					</Suspense>
				</ErrorBoundary>
			</LocaleProvider>
		);
	}

	return (
		<LocaleProvider>
			<ErrorBoundary>
				<PluginShell
					projectId={projectId}
					scope={scope}
					pluginPath={pluginPath}
					pushPluginPath={pushPluginPath}
				/>
			</ErrorBoundary>
		</LocaleProvider>
	);
}

/**
 * Production-aware shell — derives production state on the client.
 * Fetches the plugin-agnostic `/global-context` (installRoot, gitHash) plus
 * the current project's `/projects/:id` (for path) in parallel, and computes
 * `isProductionProject` locally using the same pure function the runtime uses.
 * No server round-trip just to branch on a derivable state.
 *
 * While unknown (pending fetch): render `ProjectContent` optimistically so
 * the dev-mode user doesn't see a flash of "loading". Production-install
 * users see the flash briefly, then the ProductionModePage — acceptable
 * tradeoff since dev-mode is the dominant case.
 */
function PluginShell({
	projectId,
	scope,
	pluginPath,
	pushPluginPath,
}: PluginProps) {
	const authFetch = useAuthFetch();
	const [production, setProduction] = useState<boolean | null>(null);
	useEffect(() => {
		let cancelled = false;
		Promise.all([
			authFetch("/global-context").then((r) => (r.ok ? r.json() : null)),
			authFetch(`/projects/${projectId}`).then((r) => (r.ok ? r.json() : null)),
		])
			.then(([ctx, project]) => {
				if (cancelled) return;
				if (!ctx || !project?.path) {
					setProduction(false);
					return;
				}
				setProduction(isProductionProject(project.path, ctx));
			})
			.catch(() => {
				if (!cancelled) setProduction(false);
			});
		return () => {
			cancelled = true;
		};
	}, [projectId, authFetch]);
	if (production === true) return <ProductionModePage />;
	return (
		<ProjectContent
			projectId={projectId}
			scope={scope}
			pluginPath={pluginPath}
			pushPluginPath={pushPluginPath}
		/>
	);
}

function ProjectContent({
	projectId,
	scope,
	pluginPath,
	pushPluginPath,
}: PluginProps) {
	const authFetch = useAuthFetch();
	const { t } = useLocale();
	const [isCreatingTask, setIsCreatingTask] = useState(false);
	// URL is the routing truth (Task Y). `selectedTaskId` is DERIVED from
	// `pluginPath` — no separate state, no hashchange listener, no
	// redirect/replace bookkeeping. Navigation happens via
	// `pushPluginPath(newTaskId, replace?)`; the new path flows down as a
	// prop and `selectedTaskId` re-derives.
	//
	// Transient: during the brand-new-project window before `useTasks`
	// resolves the daemon-returned rootNodeId, `pluginPath` is empty and
	// `selectedTaskId` is null. The normalization effect below calls
	// `pushPluginPath(rootNodeId, true)` once rootNodeId arrives, which
	// moves the URL forward and the derived state catches up.
	const { taskId: selectedTaskId } = parsePluginPath(pluginPath);
	const [rootNodeId, setRootNodeId] = useState<string | null>(null);
	// `targetNodeId` follows `selectedTaskId` (derivation identity) — the
	// effect below keeps this in sync with the URL and avoids a wider
	// refactor of the many places that still read `targetNodeId`.
	const [targetNodeId, setTargetNodeId] = useState<string | null>(
		selectedTaskId,
	);

	// Navigation helper. All existing `setSelectedTaskId(X)` call sites use
	// this as their setter — behaviourally equivalent to the old useState
	// setter, but routed through `pushPluginPath` so the URL is always
	// updated. Use `replace=true` for URL normalization (e.g. empty →
	// rootNodeId); default `false` adds a history entry (user-initiated).
	const setSelectedTaskId = useCallback(
		(id: string | null, replace = false) => {
			pushPluginPath(id ?? "", replace);
		},
		[pushPluginPath],
	);
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
	// Unified visibility state — same flag controls desktop collapse AND
	// mobile drawer. Width is an orthogonal attribute, always >= MIN.
	const [sidebarOpen, setSidebarOpen] = useState(readInitialSidebarOpen);
	const [sidebarWidth, setSidebarWidth] = useState(readInitialSidebarWidth);
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
		// Add URL-derived task to tabs if not present. If the URL-derived
		// task happens to be the root id (deeplink to root), the post-mount
		// defensive effect below strips it once useTasks resolves rootNodeId.
		// We can't tell at init time without a cache (which we deliberately
		// don't have); the brief window of "root in openTabs" is harmless
		// because the tab bar only renders when openTabs.length > 0 anyway.
		const initialTask = parsePluginPath(pluginPath).taskId;
		if (initialTask && !tabs.includes(initialTask)) {
			tabs = [...tabs, initialTask];
			localStorage.setItem("mxd-open-tabs", JSON.stringify(tabs));
		}
		return tabs;
	});
	const [previewTabId, setPreviewTabId] = useState<string | null>(null);
	const [viewMode, setViewMode] = useState<"activity" | "description">(
		"activity",
	);
	// Per-tab scroll state: { scrollTop, follow }
	const tabScrollStateRef = useRef<
		Map<string, { scrollTop: number; follow: boolean }>
	>(new Map());
	const [autoScroll, setAutoScroll] = useState(true);
	const [fullscreen, setFullscreen] = useState(false);
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
	const [tokenUsage, setTokenUsage] = useState<
		Record<string, { inputTokens: number; contextWindow: number }>
	>({});
	const [showCacheBadges, setShowCacheBadges] = useState(
		() => localStorage.getItem("mxd-show-cache-badges") === "true",
	);
	// Pending messages are a pure derivation of the events log (see
	// `pendingReducer` in event-handler.ts). The `ref` is updated
	// synchronously by `dispatchPending` so messages_consumed in the same
	// batch can read the already-applied state. `setPendingMessages` is
	// only used inside `dispatchPending` to trigger a re-render — it isn't
	// exposed anywhere; no imperative "clear" paths are possible.
	const pendingMessagesRef = useRef<PendingMessage[]>([]);
	const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([]);
	const dispatchPending = useCallback((action: PendingAction) => {
		const next = pendingReducer(pendingMessagesRef.current, action);
		pendingMessagesRef.current = next;
		setPendingMessages(next);
	}, []);
	const getPendingMessages = useCallback(() => pendingMessagesRef.current, []);
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

	// Currently viewed session id = selectedTaskId. URL is the routing truth;
	// during the brand-new-project transient (URL has no taskId, useTasks
	// hasn't resolved yet) selectedTaskId is null → no fetch fires (guard
	// below). Once URL-redirect normalizes the hash, selectedTaskId catches
	// up and fetches start. No rootNodeId fallback — `selectedTaskId` flows
	// through everywhere, root is just a regular id.
	const viewedSessionRef = useRef<string | null>(null);
	const viewedSessionId = selectedTaskId;
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
	// Config/settings managed by shell — plugin doesn't need it

	const nodeMap = useMemo(() => {
		const map = new Map<string, TreeNode>();
		for (const n of nodes) map.set(n.id, n);
		return map;
	}, [nodes]);
	// Fetch current project info (name, pathExists) — plugin doesn't manage project list
	const [currentProject, setCurrentProject] = useState<{
		id: string;
		name: string;
		path: string;
		pathExists?: boolean;
	} | null>(null);
	useEffect(() => {
		if (!projectId) {
			setCurrentProject(null);
			return;
		}
		authFetch(`/projects/${projectId}`)
			.then((r) => (r.ok ? r.json() : null))
			.then(setCurrentProject)
			.catch(() => setCurrentProject(null));
	}, [projectId, authFetch]);
	const projectMap = useMemo(() => {
		const map = new Map<string, string>();
		if (currentProject) map.set(currentProject.id, currentProject.name);
		return map;
	}, [currentProject]);
	const totalCost = useMemo(() => {
		const sum = nodes.reduce(
			(acc, n) => (isTask(n) ? acc + n.costUsd : acc),
			0,
		);
		return sum > 0 ? sum : null;
	}, [nodes]);

	// Root-view check: selectedTaskId is seeded from URL+cache on mount and
	// kept in sync with the URL — so it equals rootNodeId iff we're viewing
	// root. The brand-new-project transient (~50ms before useTasks resolves)
	// has both null, and `null === null` correctly returns true (still root).
	// No `!selectedTaskId` sentinel needed.
	const isOrchestratorNode = selectedTaskId === rootNodeId;
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
	}, [nodes, rootNodeId, currentProject]);

	// ── Sidebar resize ───────────────────────────────────────────────────

	const handleSidebarResizeStart = useCallback((e: React.MouseEvent) => {
		e.preventDefault();
		setIsSidebarDragging(true);
	}, []);

	useEffect(() => {
		if (!isSidebarDragging) return;
		let hasDragged = false;

		/**
		 * During drag: mirror the "what the user is aiming at" state, but NEVER
		 * set width to 0. Below threshold = mark closed (CSS hides via class);
		 * width stays at the last valid value so re-opening is instant and
		 * visible. This eliminates the "0-width as hidden" double-state.
		 */
		const handleMouseMove = (e: MouseEvent) => {
			hasDragged = true;
			if (e.clientX < SIDEBAR_SNAP_CLOSE_THRESHOLD) {
				setSidebarOpen(false);
				// Width untouched — keep last valid value.
			} else {
				setSidebarOpen(true);
				setSidebarWidth(
					Math.min(
						SIDEBAR_MAX_WIDTH,
						Math.max(SIDEBAR_MIN_OPEN_WIDTH, e.clientX),
					),
				);
			}
		};
		const handleMouseUp = (e: MouseEvent) => {
			setIsSidebarDragging(false);
			if (!hasDragged) {
				// Pure click on the handle — same semantic as the toggle button.
				setSidebarOpen((prev) => {
					const next = !prev;
					localStorage.setItem(STORAGE_KEY_OPEN, String(next));
					return next;
				});
				return;
			}
			if (e.clientX < SIDEBAR_SNAP_CLOSE_THRESHOLD) {
				setSidebarOpen(false);
				localStorage.setItem(STORAGE_KEY_OPEN, "false");
				// Width unchanged — the user's last valid width is preserved in
				// both state and localStorage.
			} else {
				const finalWidth = Math.min(
					SIDEBAR_MAX_WIDTH,
					Math.max(SIDEBAR_MIN_OPEN_WIDTH, e.clientX),
				);
				setSidebarWidth(finalWidth);
				setSidebarOpen(true);
				localStorage.setItem(STORAGE_KEY_OPEN, "true");
				localStorage.setItem(STORAGE_KEY_WIDTH, String(finalWidth));
			}
		};
		document.addEventListener("mousemove", handleMouseMove);
		document.addEventListener("mouseup", handleMouseUp);
		return () => {
			document.removeEventListener("mousemove", handleMouseMove);
			document.removeEventListener("mouseup", handleMouseUp);
		};
	}, [isSidebarDragging]);

	/**
	 * Unified sidebar-visibility toggle. Used by:
	 * - Floating toggle button on the content area (always visible)
	 * - Cmd/Ctrl+B keyboard shortcut
	 *
	 * A pure flip of `sidebarOpen`. No viewport check, no width manipulation:
	 * width is always valid (>= MIN, invariant maintained by the drag handler
	 * never setting it to 0), so opening is guaranteed to be visible.
	 */
	const handleToggleSidebar = useCallback(() => {
		setSidebarOpen((prev) => {
			const next = !prev;
			localStorage.setItem(STORAGE_KEY_OPEN, String(next));
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
					// targetNodeId updates via the effect on selectedTaskId/rootNodeId.
					setSelectedTaskId(rootNodeId);
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
				handleToggleSidebar();
			}
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [
		rootNodeId,
		fullscreen,
		handleToggleSidebar, // targetNodeId updates via the effect on selectedTaskId/rootNodeId.
		setSelectedTaskId,
	]);

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
				dispatchPending,
				getPendingMessages,
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
			dispatchPending,
			getPendingMessages,
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
				console.warn("[Plugin] Failed to re-fetch events on reconnect:", e),
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
					"[Plugin] Failed to re-fetch clarifications on reconnect:",
					e,
				),
			);
	}, [projectId, processEventResponse, authFetch]);

	useSSE(projectId, scope, handleEvent, checkStatus, handleReconnect);

	// Project selection is managed by shell — plugin receives projectId as prop

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
				console.warn("[Plugin] Failed to fetch events for session:", e),
			);
		return () => {
			cancelled = true;
		};
	}, [projectId, viewedSessionId]);

	// ── URL normalization ──────────────────────────────────────────────────
	//
	// Plugin's segment must always carry a taskId. On empty `pluginPath`
	// (brand-new-project first load), wait for useTasks to resolve
	// rootNodeId, then `pushPluginPath(rootNodeId, true)` — replaceState
	// so no history entry for this auto-normalization.
	//
	// Shell owns the `<projectId>/<pluginScope>/` prefix and the popstate
	// listener; plugin doesn't touch `window.history`, only calls
	// `pushPluginPath`.
	useEffect(() => {
		if (!rootNodeId) return;
		if (pluginPath === "") {
			pushPluginPath(rootNodeId, true);
		}
	}, [rootNodeId, pluginPath, pushPluginPath]);

	// Defensive: rootNodeId must NEVER appear in openTabs (it has its own
	// dedicated tab button). At init time we can't tell if a URL deeplink is
	// pointing at root (no cache → can't compare), so we strip it post-load.
	useEffect(() => {
		if (!rootNodeId || openTabs.length === 0) return;
		if (openTabs.includes(rootNodeId)) {
			const cleaned = openTabs.filter((id) => id !== rootNodeId);
			setOpenTabs(cleaned);
			localStorage.setItem("mxd-open-tabs", JSON.stringify(cleaned));
		}
	}, [rootNodeId, openTabs]);

	useEffect(() => {
		if (projectId) checkStatus();
	}, [projectId, checkStatus]);

	// Pending messages are derived from the events log by pendingReducer.
	// Clear on project change — the next event fetch's RESET (in
	// processEventBatch) will repopulate from the new project's events.
	useEffect(() => {
		if (!projectId) {
			dispatchPending({ type: "RESET" });
		}
	}, [projectId, dispatchPending]);

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
	}, [projectId, authFetch]);

	// targetNodeId = the task that receives sends / owns pending messages.
	// Root is treated as a regular task — its id appears in `selectedTaskId`
	// exactly the same way a sub-task id does, no fallback needed.
	// `selectedTaskId` is DERIVED from `pluginPath` (prop from shell). The
	// brand-new transient (pluginPath bare → useTasks resolves → URL
	// normalization effect calls `pushPluginPath(rootNodeId, replace=true)`)
	// updates the prop, which flows through, then this effect catches up.
	useEffect(() => {
		setTargetNodeId(selectedTaskId);
	}, [selectedTaskId]);

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

	// When set, the next task switch should scroll to this timestamp instead of the bottom.
	const scrollToEntryRef = useRef<string | null>(null);
	const prevSelectedTaskRef = useRef<string | null>(selectedTaskId);

	// biome-ignore lint/correctness/useExhaustiveDependencies: only trigger on task selection change
	useEffect(() => {
		setViewMode("activity");
		const targetEntryId = scrollToEntryRef.current;
		scrollToEntryRef.current = null;

		// Save scroll state of the previous tab
		const prevTabId = prevSelectedTaskRef.current;
		if (prevTabId) {
			const logEl = document.querySelector(".mxd-activity-log");
			tabScrollStateRef.current.set(prevTabId, {
				scrollTop: logEl?.scrollTop ?? 0,
				follow: autoScroll,
			});
		}
		prevSelectedTaskRef.current = selectedTaskId;

		if (targetEntryId) {
			// Navigation: scroll to specific entry by ID
			setAutoScroll(false);
			// Delay to let event fetch + render complete after task switch
			setTimeout(() => {
				const el = document.querySelector(
					`[data-entry-id="${CSS.escape(targetEntryId)}"]`,
				);
				if (el) {
					el.scrollIntoView({ block: "center", behavior: "smooth" });
					el.classList.add("mxd-scroll-target");
					setTimeout(() => el.classList.remove("mxd-scroll-target"), 2000);
				} else {
					// Entry not found — likely pending. Enable follow mode.
					setAutoScroll(true);
					const logEl = document.querySelector(".mxd-activity-log");
					if (logEl) logEl.scrollTop = logEl.scrollHeight;
				}
			}, 300);
		} else {
			// Normal tab switch: restore previous scroll state or follow.
			// selectedTaskId is the real id of the viewed task (root included);
			// no "root" string sentinel needed. Pre-Fix-C this used `?? "root"`
			// asymmetrically with the SET branch above (which skipped on null
			// via `if (prevTabId)`), so root's scroll state never persisted at
			// all — set under nothing, get from "root" → always missed.
			const tabId = selectedTaskId;
			const saved = tabId ? tabScrollStateRef.current.get(tabId) : undefined;
			if (saved) {
				setAutoScroll(saved.follow);
				requestAnimationFrame(() => {
					const logEl = document.querySelector(".mxd-activity-log");
					if (logEl) {
						if (saved.follow) {
							logEl.scrollTop = logEl.scrollHeight;
						} else {
							logEl.scrollTop = saved.scrollTop;
						}
					}
				});
			} else {
				// First visit to this tab — follow mode
				setAutoScroll(true);
				requestAnimationFrame(() => {
					const logEl = document.querySelector(".mxd-activity-log");
					if (logEl) logEl.scrollTop = logEl.scrollHeight;
				});
			}
		}
	}, [selectedTaskId]);

	// ── Handlers ─────────────────────────────────────────────────────────────

	const {
		handleSend,
		handleStop,
		handleClarifySubmit,
		handleClearRootSession,
		handleDeleteTask,
		handleStopTask,
		handleClearTaskSession,
		handleAddTask,
		handleCreateTask,
		handleCancelCreate,
	} = useMemo(
		() =>
			createActionHandlers({
				authFetch,
				projectId,
				selectedTaskId,
				rootNodeId,
				selectedNode,
				isOrchestratorNode,
				targetNodeId,
				clarifyAnswers,
				pendingClarifications,
				addLog,
				setLogs,
				setLastTurns,
				setLastInputTokens,
				setLastCacheCreationTokens,
				setLastCacheReadTokens,
				setLastOutputTokens,
				setSelectedTaskId,
				setRootNodeId,
				setClarifyAnswers,
				setPendingClarifications,
				setIsCreatingTask,
				setTokenUsage,
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
			addLog,
			start,
			stop,
			compact,
			sendMessageToTask,
			deleteTask,
			stopTask,
			clearTaskSession,
			refreshTasks,
			t,
			setActiveAgents,
			authFetch,
			setSelectedTaskId,
		],
	);

	// ── Stabilized callbacks for memoized child components ───────────────────
	//
	// No manual project-switch reset needed: shell passes
	// `key={${projectId}/${selectedScope}}` on `<PluginUI>`, so any project
	// (or scope) change unmounts this component and remounts a fresh one.
	// Every `useState` / `useRef` / `useAgent` reinitializes from scratch —
	// no imperative clearing, no stale-ref hazard.

	// Use refs to read current preview/tabs without deps
	const previewTabRef = useRef(previewTabId);
	previewTabRef.current = previewTabId;
	const openTabsRef = useRef(openTabs);
	openTabsRef.current = openTabs;

	const handleTaskSelect = useCallback(
		(id: string | null) => {
			setSelectedTaskId(id);
			// Auto-dismiss drawer on mobile only: on mobile the sidebar is an
			// overlay that covers content, so selecting a task needs to dismiss
			// it. On desktop the sidebar is a persistent sibling — keep it open.
			if (window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`).matches) {
				setSidebarOpen(false);
			}
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
		[rootNodeId, setSelectedTaskId],
	);

	const handleTaskPin = useCallback(
		(id: string | null) => {
			if (!id || id === rootNodeId) return;
			setSelectedTaskId(id);
			// See handleTaskSelect — dismiss drawer only on mobile.
			if (window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`).matches) {
				setSidebarOpen(false);
			}
			// Pin: add to tabs if not present, clear preview
			setPreviewTabId((prev) => (prev === id ? null : prev));
			setOpenTabs((prev) => {
				if (prev.includes(id)) return prev;
				const next = [...prev, id];
				localStorage.setItem("mxd-open-tabs", JSON.stringify(next));
				return next;
			});
		},
		[rootNodeId, setSelectedTaskId],
	);

	const handleTabSelect = useCallback(
		(id: string | null) => {
			setSelectedTaskId(id);
		},
		[setSelectedTaskId],
	);

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

	/** Navigate to a task from an activity log card. Supports root. Scrolls to timestamp if provided. */
	const handleTaskNavigate = useCallback(
		(id: string, entryId?: string) => {
			if (!id) return;
			if (entryId) {
				scrollToEntryRef.current = entryId;
			}
			if (id === rootNodeId) {
				// Navigate to root — just select it
				setSelectedTaskId(rootNodeId);
				return;
			}
			// Open as pinned tab
			setSelectedTaskId(id);
			setPreviewTabId((prev) => (prev === id ? null : prev));
			setOpenTabs((prev) => {
				if (prev.includes(id)) return prev;
				const next = [...prev, id];
				localStorage.setItem("mxd-open-tabs", JSON.stringify(next));
				return next;
			});
		},
		[
			rootNodeId, // Open as pinned tab
			setSelectedTaskId,
		],
	);

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
		[selectedTaskId, rootNodeId, setSelectedTaskId],
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
		[
			projectId,
			loadingOlderEvents,
			olderEventsAvailable,
			processEventBatch,
			authFetch,
		],
	);

	// ── Render ───────────────────────────────────────────────────────────────

	return (
		<>
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
					className={`mxd-sidebar${sidebarOpen ? " mxd-sidebar-open" : " mxd-sidebar-collapsed"}`}
					style={
						sidebarOpen
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
								}}
								data-tip={t("tasks.refresh")}
							>
								<IconRefresh size={13} />
							</button>
							{/* Settings button moved to shell header */}
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
					className={`mxd-sidebar-resize-handle${!sidebarOpen ? " mxd-sidebar-resize-handle-collapsed" : ""}`}
					onMouseDown={handleSidebarResizeStart}
				/>

				<section className="mxd-content">
					{!fullscreen && (
						<button
							type="button"
							className="mxd-sidebar-expand-btn"
							onClick={handleToggleSidebar}
							title={t("sidebar.toggle")}
							aria-label={t("sidebar.toggle")}
						>
							<IconSidebarLeft size={14} />
						</button>
					)}
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
								// One source: selectedTaskId. Brand-new transient = null
								// → tokenUsage[""] is undefined → no badge rendered (correct).
								const usageTaskId = selectedTaskId ?? "";
								const usage = tokenUsage[usageTaskId];
								return usage ? (
									<TokenUsageBadge
										inputTokens={usage.inputTokens}
										contextWindow={usage.contextWindow}
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
							{viewMode === "activity" && (
								<button
									type="button"
									className={`mxd-btn-icon mxd-cache-toggle-btn${showCacheBadges ? " active" : ""}`}
									onClick={() => {
										setShowCacheBadges((prev) => {
											const next = !prev;
											localStorage.setItem(
												"mxd-show-cache-badges",
												String(next),
											);
											return next;
										});
									}}
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
								onTaskNavigate={handleTaskNavigate}
								projectMap={projectMap}
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
