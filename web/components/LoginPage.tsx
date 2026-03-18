import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import {
	browserSupportsWebAuthn,
	startAuthentication,
} from "@simplewebauthn/browser";
import { useCallback, useState } from "react";

interface LoginPageProps {
	onAuthenticated: () => void;
	hasCredentials: boolean;
	enforced: boolean;
}

export function LoginPage({
	onAuthenticated,
	hasCredentials,
	enforced,
}: LoginPageProps) {
	const [status, setStatus] = useState("");
	const [isError, setIsError] = useState(false);
	const [loading, setLoading] = useState(false);

	const handleLogin = useCallback(async () => {
		if (!browserSupportsWebAuthn()) {
			setStatus("Your browser does not support WebAuthn/Passkeys");
			setIsError(true);
			return;
		}

		setLoading(true);
		setStatus("Starting authentication...");
		setIsError(false);

		try {
			// Get authentication options
			const optRes = await fetch("/auth/login/options", { method: "POST" });
			if (!optRes.ok) {
				const err = await optRes
					.json()
					.catch(() => ({ error: "Failed to get options" }));
				throw new Error(
					(err as { error?: string }).error ?? "Failed to get options",
				);
			}
			const options =
				(await optRes.json()) as PublicKeyCredentialRequestOptionsJSON;

			// Start WebAuthn authentication
			const credential = await startAuthentication({ optionsJSON: options });

			// Verify with server
			const verifyRes = await fetch("/auth/login/verify", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(credential),
			});
			if (!verifyRes.ok) {
				const err = await verifyRes
					.json()
					.catch(() => ({ error: "Verification failed" }));
				throw new Error(
					(err as { error?: string }).error ?? "Verification failed",
				);
			}

			const result = (await verifyRes.json()) as { verified: boolean };
			if (result.verified) {
				setStatus("Authenticated!");
				setIsError(false);
				onAuthenticated();
			} else {
				throw new Error("Verification failed");
			}
		} catch (err) {
			setStatus(err instanceof Error ? err.message : "Authentication failed");
			setIsError(true);
		} finally {
			setLoading(false);
		}
	}, [onAuthenticated]);

	const handleRegister = useCallback(async () => {
		setLoading(true);
		setStatus("");
		try {
			const { startRegistration } = await import("@simplewebauthn/browser");
			const optsRes = await fetch("/auth/register/options", {
				method: "POST",
			});
			if (!optsRes.ok) throw new Error("Failed to get options");
			const opts = await optsRes.json();
			const result = await startRegistration({ optionsJSON: opts });
			const verifyRes = await fetch("/auth/register/verify", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(result),
			});
			if (!verifyRes.ok) throw new Error("Verification failed");
			setStatus("Passkey registered! You can now sign in.");
			setIsError(false);
		} catch (e) {
			setStatus(e instanceof Error ? e.message : "Registration failed");
			setIsError(true);
		} finally {
			setLoading(false);
		}
	}, []);

	return (
		<div className="og-login-page">
			<div className="og-login-card">
				<div className="og-login-icon">🔐</div>
				<h1 className="og-login-title">OpenGraft</h1>
				{hasCredentials ? (
					<>
						<p className="og-login-subtitle">
							Authenticate with your passkey to continue
						</p>
						<button
							type="button"
							className="og-login-btn"
							onClick={handleLogin}
							disabled={loading}
						>
							{loading ? "Authenticating..." : "Sign in with Passkey"}
						</button>
					</>
				) : (
					<>
						<p className="og-login-subtitle">
							No passkeys registered. Register one to secure access.
						</p>
						<button
							type="button"
							className="og-login-btn"
							onClick={handleRegister}
							disabled={loading}
						>
							{loading ? "Registering..." : "Register Passkey"}
						</button>
					</>
				)}
				{!enforced && (
					<button
						type="button"
						className="og-login-btn og-login-btn-ghost"
						onClick={onAuthenticated}
					>
						Continue without auth →
					</button>
				)}
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
