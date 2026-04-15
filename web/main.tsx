import { createRoot } from "react-dom/client";
import { AuthFetchProvider, GetTokenProvider } from "./auth-context.ts";
import { authFetch, getToken } from "./auth.ts";
import { LoginPage } from "./LoginPage.tsx";
import { useState, useEffect, useCallback } from "react";
// Static import — Bun's bundler transpiles this. Dynamic plugin loading is future work.
import PluginApp from "../.mxd/plugin/web/App.tsx";

function Shell() {
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
	if (!authenticated) return <LoginPage onAuthenticated={handleAuthenticated} />;

	return (
		<AuthFetchProvider value={authFetch}>
			<GetTokenProvider value={getToken}>
				<PluginApp />
			</GetTokenProvider>
		</AuthFetchProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Shell />);
}
