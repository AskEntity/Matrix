import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { authFetch, getToken } from "./auth.ts";
import { AuthFetchProvider, GetTokenProvider } from "./auth-context.ts";
import { LoginPage } from "./LoginPage.tsx";

// Plugin UI loaded dynamically from registered plugin path
function loadPluginUI(pluginPath: string) {
	return lazy(() =>
		import(/* @vite-ignore */ pluginPath).then((m) => ({
			default: m.Plugin ?? m.default,
		})),
	);
}

interface ProjectInfo {
	id: string;
	name: string;
	path: string;
}

interface PluginInfo {
	name: string;
	scope: "global" | "project";
	webComponentPath: string;
}

export function ShellApp() {
	const [authenticated, setAuthenticated] = useState(false);
	const [checking, setChecking] = useState(true);
	const [projects, setProjects] = useState<ProjectInfo[]>([]);
	const [selectedProject, setSelectedProject] = useState<string>("");
	const [selectedScope, setSelectedScope] = useState("");
	const [plugins, setPlugins] = useState<PluginInfo[]>([]);
	const [PluginUI, setPluginUI] = useState<ReturnType<typeof loadPluginUI> | null>(null);

	// Check auth on mount
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

	// Load projects + plugins after auth
	useEffect(() => {
		if (!authenticated) return;
		(async () => {
			try {
				const res = await authFetch("/projects");
				const data = await res.json();
				setProjects(data);
				if (data.length > 0 && !selectedProject) {
					setSelectedProject(data[0].id);
				}
			} catch {}
			// Load registered plugins
			try {
				const res = await authFetch("/plugins");
				const data = await res.json();
				setPlugins(data);
				if (data.length > 0 && !selectedScope) {
					setSelectedScope(data[0].name);
				}
			} catch {}
		})();
	}, [authenticated]);

	// Load plugin UI component when scope changes
	useEffect(() => {
		const plugin = plugins.find((p) => p.name === selectedScope);
		if (plugin?.webComponentPath) {
			setPluginUI(() => loadPluginUI(plugin.webComponentPath));
		}
	}, [selectedScope, plugins]);

	const handleAuthenticated = useCallback(() => {
		setAuthenticated(true);
	}, []);

	if (checking) return null;
	if (!authenticated) return <LoginPage onAuthenticated={handleAuthenticated} />;

	return (
		<div className="mxd-shell">
			<div className="mxd-shell-topbar">
				<span className="mxd-shell-logo">Matrix</span>
				<span className="mxd-shell-status">● Connected</span>
				<select
					className="mxd-shell-select"
					value={selectedProject}
					onChange={(e) => setSelectedProject(e.target.value)}
				>
					{projects.map((p) => (
						<option key={p.id} value={p.id}>
							{p.name}
						</option>
					))}
				</select>
				<select
					className="mxd-shell-select"
					value={selectedScope}
					onChange={(e) => setSelectedScope(e.target.value)}
				>
					{plugins.map((p) => (
						<option key={p.name} value={p.name}>
							{p.name}
						</option>
					))}
				</select>
			</div>
			<div className="mxd-shell-content">
				{PluginUI && (
					<AuthFetchProvider value={authFetch}>
						<GetTokenProvider value={getToken}>
							<Suspense fallback={<div style={{ padding: 20, color: "#8b949e" }}>Loading plugin...</div>}>
								<PluginUI />
							</Suspense>
						</GetTokenProvider>
					</AuthFetchProvider>
				)}
				{!PluginUI && (
					<div style={{ padding: 20, color: "#8b949e" }}>Select a scope to load plugin UI</div>
				)}
			</div>
		</div>
	);
}
