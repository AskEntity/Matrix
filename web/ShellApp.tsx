/**
 * Shell App — daemon's UI layer.
 *
 * Owns: auth, header (logo/version/connected/project selector/settings/logout),
 * settings panel, scope selector.
 * Plugin renders below the header as a dynamically-loaded React component.
 */

import { AuthFetchProvider, GetTokenProvider } from "@mxd/auth-context";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { authFetch, clearToken, getToken } from "./auth.ts";
import { AppHeader } from "./components/AppHeader.tsx";
import { SettingsPanel } from "./components/SettingsPanel.tsx";
import type { Project, ThreeLayerConfig } from "./components/types.ts";
import { LocaleProvider } from "./i18n.ts";
import { LoginPage } from "./LoginPage.tsx";

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
	// ── Project state (daemon-owned) ──
	const [projects, setProjects] = useState<Project[]>([]);
	const [projectId, setProjectId] = useState("");
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
	const [selectedScope, setSelectedScope] = useState("");
	const [PluginUI, setPluginUI] = useState<ReturnType<
		typeof loadPluginUI
	> | null>(null);

	// ── Fetch projects + plugins ──
	const refresh = useCallback(async () => {
		try {
			const res = await authFetch("/projects");
			const data = await res.json();
			setProjects(data);
			if (data.length > 0 && !projectId) setProjectId(data[0].id);
		} catch {}
		try {
			const res = await authFetch("/plugins");
			const data = await res.json();
			setPlugins(data);
			if (data.length > 0 && !selectedScope) setSelectedScope(data[0].name);
		} catch {}
	}, [projectId, selectedScope]);

	useEffect(() => {
		refresh();
	}, [refresh]);

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
	const handleProjectChange = useCallback((id: string) => {
		setProjectId(id);
		setShowSettings(false);
	}, []);

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
					setProjectId(proj.id);
					setNewProjectPath("");
					setShowAddProject(false);
					refresh();
				}
			} finally {
				setCreatingProject(false);
			}
		},
		[newProjectPath, refresh],
	);

	const handleLogout = useCallback(() => {
		clearToken();
		window.location.reload();
	}, []);

	const handleDeleteProject = useCallback(async () => {
		if (!projectId) return;
		await authFetch(`/projects/${projectId}`, { method: "DELETE" });
		setProjectId("");
		refresh();
	}, [projectId, refresh]);

	const handleClearSessions = useCallback(async () => {
		if (!projectId) return;
		await authFetch(`/projects/${projectId}/sessions/clear`, {
			method: "POST",
		});
	}, [projectId]);

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
				projectId={projectId}
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
				onScopeChange={setSelectedScope}
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
					onClearAllSessions={handleClearSessions}
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
				) : PluginUI ? (
					<Suspense
						fallback={
							<div style={{ padding: 20, color: "#8b949e" }}>
								Loading plugin...
							</div>
						}
					>
						<PluginUI projectId={projectId} />
					</Suspense>
				) : (
					<div style={{ padding: 20, color: "#8b949e" }}>
						Select a scope to load plugin UI
					</div>
				)}
			</div>
		</div>
	);
}
