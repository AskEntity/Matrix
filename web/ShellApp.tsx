/**
 * Shell App — daemon's UI layer.
 *
 * Owns: auth, header (logo/version/connected/project selector/settings/logout),
 * settings panel, scope selector.
 * Plugin renders below the header as a dynamically-loaded React component.
 */

import { AuthFetchProvider, GetTokenProvider } from "@mxd/auth-context";
import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { authFetch, clearToken, getToken } from "./auth.ts";
import { AppHeader } from "./components/AppHeader.tsx";
import { SettingsPanel } from "./components/SettingsPanel.tsx";
import type { Project, ThreeLayerConfig } from "./components/types.ts";
import { LocaleProvider } from "./i18n.ts";
import { LoginPage } from "./LoginPage.tsx";
import { buildPath, type ParsedPath, parsePath } from "./path-routing.ts";

/**
 * Renders the build-failure surface for a plugin whose web bundle failed to
 * compile. Replaces the old silent "Loading plugin…" hang so the user can
 * see the underlying error (and take action — fix syntax, rebuild, etc.).
 */
function PluginBuildErrorPanel({
	name,
	error,
}: {
	name: string;
	error: string;
}) {
	return (
		<div
			className="mxd-plugin-build-error"
			role="alert"
			style={{
				padding: 20,
				color: "#f85149",
				fontFamily: "monospace",
				whiteSpace: "pre-wrap",
				overflow: "auto",
			}}
		>
			<strong>Plugin "{name}" failed to build:</strong>
			<br />
			<br />
			{error}
		</div>
	);
}

// Dynamic import of compiled plugin JS (served at URL from build pipeline)
function loadPluginUI(
	pluginPath: string,
	// biome-ignore lint/suspicious/noExplicitAny: plugin component props vary
): React.LazyExoticComponent<React.ComponentType<any>> {
	return lazy(() =>
		import(/* @vite-ignore */ pluginPath).then((m) => ({
			default: m.Plugin ?? m.default,
		})),
	);
}

interface PluginInfo {
	name: string;
	scope: "global" | "project";
	/** Undefined when the plugin failed to build — check `buildError` first. */
	webComponentPath?: string;
	cssPath?: string;
	/** When set, the web build pipeline rejected this plugin. Rendering the
	 *  component would produce a broken import — show the error instead so
	 *  the user isn't stuck on "Loading plugin…" indefinitely. */
	buildError?: string;
}

export function ShellApp() {
	const [authenticated, setAuthenticated] = useState(false);
	const [checking, setChecking] = useState(true);

	useEffect(() => {
		(async () => {
			try {
				const token = getToken();
				const res = await fetch("/auth/status", {
					headers: token ? { Authorization: `Bearer ${token}` } : {},
				});
				const data = await res.json();
				setAuthenticated(data.authenticated);
			} catch {
				setAuthenticated(false);
			}
			setChecking(false);
		})();
	}, []);

	const handleAuthenticated = useCallback(() => {
		setAuthenticated(true);
	}, []);

	if (checking) return null;
	if (!authenticated)
		return <LoginPage onAuthenticated={handleAuthenticated} />;

	return (
		<LocaleProvider>
			<AuthFetchProvider value={authFetch}>
				<GetTokenProvider value={getToken}>
					<AuthenticatedShell />
				</GetTokenProvider>
			</AuthFetchProvider>
		</LocaleProvider>
	);
}

function AuthenticatedShell() {
	// ── Path-based routing ──
	// URL format: `/<projectId>/<pluginScope>/<pluginPath>`. Shell owns
	// the `/<projectId>` segment; everything after `<pluginScope>/` is
	// the plugin's territory (passed down as `pluginPath` prop).
	//
	// State is seeded from `window.location.pathname` on mount, then kept
	// in sync via (a) a `popstate` listener for browser back/forward, and
	// (b) our own `pushState`/`replaceState` calls when the user changes
	// project or the plugin navigates via `pushPluginPath`.
	//
	// Single source of truth = the URL. State mirrors URL, never
	// disagrees. No `projects[0].id` default — the URL normalization
	// effect below fills in a real projectId once projects load.
	const [parsed, setParsed] = useState<ParsedPath>(() =>
		parsePath(window.location.pathname),
	);
	const { projectId, pluginScope, pluginPath } = parsed;

	// ── Project state (daemon-owned) ──
	const [projects, setProjects] = useState<Project[]>([]);
	const [connected, setConnected] = useState(false);

	// ── Header state ──
	const [showAddProject, setShowAddProject] = useState(false);
	const [newProjectPath, setNewProjectPath] = useState("");
	const [creatingProject, setCreatingProject] = useState(false);
	const [showSettings, setShowSettings] = useState(false);

	// ── Settings state ──
	const [layers, setLayers] = useState<ThreeLayerConfig | null>(null);
	const [configLoading, setConfigLoading] = useState(false);

	// ── Plugin state ──
	const [plugins, setPlugins] = useState<PluginInfo[]>([]);
	const [PluginUI, setPluginUI] = useState<ReturnType<
		typeof loadPluginUI
	> | null>(null);
	// Selected scope follows the URL's pluginScope segment; falls back to
	// first available plugin when the URL doesn't specify one. The URL
	// normalization effect below will write the scope back into the URL.
	const selectedScope = pluginScope ?? plugins[0]?.name ?? "";

	// ── browser back/forward → re-parse URL → state ──
	useEffect(() => {
		const onPop = () => setParsed(parsePath(window.location.pathname));
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, []);

	// ── Fetch projects + plugins ──
	// Note: we do NOT default projectId to `projects[0].id` here. The URL
	// normalization effect (below) handles picking a default when the URL
	// has none, and it writes the choice back into the URL so state stays
	// URL-derived.
	const refresh = useCallback(async () => {
		try {
			const res = await authFetch("/projects");
			const data = await res.json();
			setProjects(data);
		} catch {}
		try {
			const res = await authFetch("/plugins");
			const data = await res.json();
			setPlugins(data);
		} catch {}
	}, []);

	useEffect(() => {
		refresh();
	}, [refresh]);

	// ── URL normalization ──
	// "/" → "/<firstProjectId>/<firstPluginName>/" via replaceState.
	// "/<projectId>" with no pluginScope → "/<projectId>/<firstPluginName>/".
	//
	// Wait until both projects AND plugins have loaded — we pick defaults
	// from real data, never a hardcoded "matrix" string. That keeps the
	// shell honest about the plugin contract: whatever's registered wins.
	// If no plugins exist, we leave the URL alone and the render falls
	// through to the "no plugin loaded" state.
	useEffect(() => {
		const firstPlugin = plugins[0];
		if (!firstPlugin) return;
		if (!projectId) {
			const firstProj = projects[0];
			if (!firstProj) return;
			const scope = firstPlugin.name;
			window.history.replaceState(null, "", buildPath(firstProj.id, scope, ""));
			setParsed({
				projectId: firstProj.id,
				pluginScope: scope,
				pluginPath: "",
			});
			return;
		}
		if (!pluginScope) {
			const scope = firstPlugin.name;
			window.history.replaceState(null, "", buildPath(projectId, scope, ""));
			setParsed({ projectId, pluginScope: scope, pluginPath: "" });
		}
	}, [projectId, pluginScope, projects, plugins]);

	// ── Connected check via health ──
	useEffect(() => {
		const check = async () => {
			try {
				const res = await authFetch("/health");
				setConnected(res.ok);
			} catch {
				setConnected(false);
			}
		};
		check();
		const interval = setInterval(check, 15000);
		return () => clearInterval(interval);
	}, []);

	// ── Load plugin component when scope changes ──
	// Explicit null when buildError is set so the render below switches to
	// the error panel instead of hanging on the Suspense fallback.
	useEffect(() => {
		const plugin = plugins.find((p) => p.name === selectedScope);
		if (!plugin) return;
		if (plugin.buildError || !plugin.webComponentPath) {
			setPluginUI(null);
			return;
		}
		const path = plugin.webComponentPath;
		setPluginUI(() => loadPluginUI(path));
	}, [selectedScope, plugins]);

	const selectedPlugin = plugins.find((p) => p.name === selectedScope);

	// ── `pushPluginPath`: callback the plugin uses to navigate within its
	// own segment. Shell translates `path` (e.g. a taskId) into a full URL
	// `/<projectId>/<selectedScope>/<path>` and updates history + state.
	// `replace=true` uses replaceState (for normalization — empty → root
	// taskId); default false uses pushState (user-initiated — task click).
	//
	// The ref reads are important: this callback shouldn't re-create on
	// every projectId/selectedScope change, or plugin-side consumers
	// depending on it would re-trigger effects needlessly.
	const projectIdRef = useRef(projectId);
	projectIdRef.current = projectId;
	const selectedScopeRef = useRef(selectedScope);
	selectedScopeRef.current = selectedScope;
	const pushPluginPath = useCallback((path: string, replace = false) => {
		const pid = projectIdRef.current;
		const scope = selectedScopeRef.current;
		if (!pid || !scope) return;
		const url = buildPath(pid, scope, path);
		if (replace) window.history.replaceState(null, "", url);
		else window.history.pushState(null, "", url);
		setParsed({ projectId: pid, pluginScope: scope, pluginPath: path });
	}, []);

	// Scope change handler (writes to URL, matches project switch pattern).
	const handleScopeChange = useCallback(
		(name: string) => {
			if (!projectId || name === selectedScope) return;
			const url = buildPath(projectId, name, "");
			window.history.pushState(null, "", url);
			setParsed({ projectId, pluginScope: name, pluginPath: "" });
		},
		[projectId, selectedScope],
	);

	// ── Config layers for settings ──
	useEffect(() => {
		if (!showSettings || !projectId) return;
		setConfigLoading(true);
		authFetch(`/projects/${projectId}/config/all`)
			.then((r) => r.json())
			.then((data) => {
				setLayers(data);
				setConfigLoading(false);
			})
			.catch(() => setConfigLoading(false));
	}, [showSettings, projectId]);

	// ── Handlers ──
	// User-initiated project switch: pushState so back/forward works.
	// Goes to "/<id>/<scope>/" with empty pluginPath; plugin will
	// normalize the empty pluginPath to "<rootTaskId>" once it loads.
	const handleProjectChange = useCallback(
		(id: string) => {
			if (id === projectId) return;
			const scope = selectedScope || plugins[0]?.name || "matrix";
			window.history.pushState(null, "", buildPath(id, scope, ""));
			setParsed({ projectId: id, pluginScope: scope, pluginPath: "" });
			setShowSettings(false);
		},
		[projectId, selectedScope, plugins],
	);

	const handleAddProject = useCallback(
		async (e: React.FormEvent) => {
			e.preventDefault();
			if (!newProjectPath.trim()) return;
			setCreatingProject(true);
			try {
				const res = await authFetch("/projects", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ path: newProjectPath.trim() }),
				});
				if (res.ok) {
					const proj = await res.json();
					setNewProjectPath("");
					setShowAddProject(false);
					// Refresh project list then navigate to the new project.
					await refresh();
					const scope = selectedScope || plugins[0]?.name || "matrix";
					window.history.pushState(null, "", buildPath(proj.id, scope, ""));
					setParsed({
						projectId: proj.id,
						pluginScope: scope,
						pluginPath: "",
					});
				}
			} finally {
				setCreatingProject(false);
			}
		},
		[newProjectPath, refresh, selectedScope, plugins],
	);

	const handleLogout = useCallback(async () => {
		// Server-side logout first — `POST /auth/logout` bumps secretVersion,
		// invalidating EVERY token signed with the old version (session, CLI,
		// stream). Without this step the local session JWT would still be
		// valid for up to 30 days on the server; a stolen localStorage copy
		// could be replayed from another browser (Audit R7 P1.5).
		//
		// If the POST fails (token already expired, network issue, daemon
		// down, etc.) we STILL clear the local token and reload — the user's
		// intent is to end this session unconditionally.
		try {
			await authFetch("/auth/logout", { method: "POST" });
		} catch {
			/* ignore — proceed with local clear anyway */
		}
		clearToken();
		window.location.reload();
	}, []);

	const handleDeleteProject = useCallback(async () => {
		if (!projectId) return;
		await authFetch(`/projects/${projectId}`, { method: "DELETE" });
		// Navigate back to "/" so normalization picks a new default project
		// (or shows empty state if no projects remain).
		window.history.pushState(null, "", "/");
		setParsed({ projectId: null, pluginScope: null, pluginPath: "" });
		refresh();
	}, [projectId, refresh]);

	const updateConfig = useCallback(
		async (layer: string, patch: Record<string, unknown>) => {
			if (!projectId) return;
			const url =
				layer === "global"
					? "/config/global"
					: `/projects/${projectId}/config${layer === "repo" ? "/repo" : ""}`;
			await authFetch(url, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(patch),
			});
			// Refresh config
			const res = await authFetch(`/projects/${projectId}/config/all`);
			setLayers(await res.json());
		},
		[projectId],
	);

	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				height: "100%",
				overflow: "hidden",
			}}
		>
			<AppHeader
				connected={connected}
				projects={projects}
				projectId={projectId ?? ""}
				showAddProject={showAddProject}
				newProjectPath={newProjectPath}
				creatingProject={creatingProject}
				showSettings={showSettings}
				onProjectChange={handleProjectChange}
				onShowAddProject={() => setShowAddProject(true)}
				onAddProject={handleAddProject}
				onNewProjectPathChange={setNewProjectPath}
				onCancelAddProject={() => {
					setShowAddProject(false);
					setNewProjectPath("");
				}}
				onToggleSettings={() => setShowSettings((s) => !s)}
				onLogout={handleLogout}
				scopes={plugins.map((p) => ({ name: p.name }))}
				selectedScope={selectedScope}
				onScopeChange={handleScopeChange}
			/>

			{showSettings && projectId && layers && (
				<SettingsPanel
					projectId={projectId}
					layers={layers}
					loading={configLoading}
					theme="dark"
					onThemeChange={() => {}}
					updateGlobal={(patch) => updateConfig("global", patch)}
					updateRepo={(patch) => updateConfig("repo", patch)}
					updateLocal={(patch) => updateConfig("", patch)}
					onClose={() => setShowSettings(false)}
					onDeleteProject={handleDeleteProject}
				/>
			)}

			<div
				style={{
					flex: 1,
					minHeight: 0,
					display: "flex",
					flexDirection: "column",
					overflow: "hidden",
				}}
			>
				{selectedPlugin?.buildError ? (
					<PluginBuildErrorPanel
						name={selectedPlugin.name}
						error={selectedPlugin.buildError}
					/>
				) : PluginUI && projectId ? (
					<Suspense
						fallback={
							<div style={{ padding: 20, color: "#8b949e" }}>
								Loading plugin...
							</div>
						}
					>
						<PluginUI
							projectId={projectId}
							pluginPath={pluginPath}
							pushPluginPath={pushPluginPath}
						/>
					</Suspense>
				) : (
					<div style={{ padding: 20, color: "#8b949e" }}>
						{projects.length === 0
							? "No projects yet — add one to get started"
							: "Loading..."}
					</div>
				)}
			</div>
		</div>
	);
}
