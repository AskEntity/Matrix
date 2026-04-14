import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { authFetch, getToken } from "./auth.ts";
import { LoginPage } from "./LoginPage.tsx";

// Plugin UI loaded dynamically based on active scope
function loadPluginUI(pluginPath: string) {
	return lazy(() =>
		import(/* @vite-ignore */ pluginPath).then((m) => ({
			default: m.default ?? m.App,
		})),
	);
}

// Default: Matrix plugin (will be configurable per project/scope)
const DEFAULT_PLUGIN_PATH = "../.mxd/plugin/web/App.tsx";
let PluginUI = loadPluginUI(DEFAULT_PLUGIN_PATH);

interface ProjectInfo {
	id: string;
	name: string;
	path: string;
}

export function ShellApp() {
	const [authenticated, setAuthenticated] = useState(false);
	const [checking, setChecking] = useState(true);
	const [projects, setProjects] = useState<ProjectInfo[]>([]);
	const [selectedProject, setSelectedProject] = useState<string>("");
	const [selectedScope, setSelectedScope] = useState("matrix");

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

	// Load projects after auth
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
		})();
	}, [authenticated]);

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
					<option value="matrix">matrix</option>
				</select>
			</div>
			<div className="mxd-shell-content">
				<Suspense fallback={<div style={{ padding: 20, color: "#8b949e" }}>Loading plugin...</div>}>
					<PluginUI />
				</Suspense>
			</div>
		</div>
	);
}
