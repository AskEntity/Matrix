import { useCallback, useState } from "react";
import { setToken } from "../auth.ts";

interface LoginPageProps {
	onAuthenticated: () => void;
}

export function LoginPage({ onAuthenticated }: LoginPageProps) {
	const [tokenInput, setTokenInput] = useState("");
	const [status, setStatus] = useState("");
	const [isError, setIsError] = useState(false);
	const [loading, setLoading] = useState(false);

	const handleLogin = useCallback(async () => {
		const trimmed = tokenInput.trim();
		if (!trimmed) {
			setStatus("Please paste a login token");
			setIsError(true);
			return;
		}

		setLoading(true);
		setStatus("");
		setIsError(false);

		try {
			const res = await fetch("/auth/exchange", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token: trimmed }),
			});

			if (!res.ok) {
				const err = (await res
					.json()
					.catch(() => ({ error: "Login failed" }))) as {
					error?: string;
				};
				throw new Error(err.error ?? "Login failed");
			}

			const result = (await res.json()) as { token?: string };
			if (result.token) {
				setToken(result.token);
				setStatus("Authenticated!");
				setIsError(false);
				onAuthenticated();
			} else {
				throw new Error("No session token received");
			}
		} catch (err) {
			setStatus(err instanceof Error ? err.message : "Login failed");
			setIsError(true);
		} finally {
			setLoading(false);
		}
	}, [tokenInput, onAuthenticated]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Enter" && !loading) {
				handleLogin();
			}
		},
		[handleLogin, loading],
	);

	return (
		<div className="og-login-page">
			<div className="og-login-card">
				<div className="og-login-icon">🔐</div>
				<h1 className="og-login-title">OpenGraft</h1>
				<p className="og-login-subtitle">
					Run <code>og sign</code> in your terminal, then paste the token below.
				</p>
				<input
					type="password"
					className="og-login-input"
					placeholder="Paste login token here"
					value={tokenInput}
					onChange={(e) => setTokenInput(e.target.value)}
					onKeyDown={handleKeyDown}
					disabled={loading}
				/>
				<button
					type="button"
					className="og-login-btn"
					onClick={handleLogin}
					disabled={loading || !tokenInput.trim()}
				>
					{loading ? "Verifying..." : "Login"}
				</button>
				{status && (
					<div
						className={`og-login-status ${isError ? "og-login-status-error" : "og-login-status-ok"}`}
					>
						{status}
					</div>
				)}
			</div>
		</div>
	);
}
