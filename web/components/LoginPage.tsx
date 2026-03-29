import { useCallback, useEffect, useRef, useState } from "react";
import { setToken } from "../auth.ts";

interface LoginPageProps {
	onAuthenticated: () => void;
}

/** Generate an RSA-OAEP keypair for challenge-response auth. */
async function generateKeypair() {
	const keyPair = await crypto.subtle.generateKey(
		{
			name: "RSA-OAEP",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["encrypt", "decrypt"],
	);
	const publicKeyDer = await crypto.subtle.exportKey("spki", keyPair.publicKey);
	const publicKeyBase64 = uint8ArrayToBase64(new Uint8Array(publicKeyDer));
	return { keyPair, publicKeyBase64 };
}

/** Decrypt RSA-OAEP ciphertext with private key. */
async function decryptWithPrivateKey(
	privateKey: CryptoKey,
	ciphertextBase64: string,
): Promise<string> {
	const ciphertext = base64ToUint8Array(ciphertextBase64);
	const decrypted = await crypto.subtle.decrypt(
		{ name: "RSA-OAEP" },
		privateKey,
		ciphertext,
	);
	return new TextDecoder().decode(decrypted);
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i] ?? 0);
	}
	return btoa(binary);
}

function base64ToUint8Array(b64: string): Uint8Array<ArrayBuffer> {
	const binary = atob(b64);
	const buf = new ArrayBuffer(binary.length);
	const bytes = new Uint8Array(buf);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

export function LoginPage({ onAuthenticated }: LoginPageProps) {
	const [command, setCommand] = useState("");
	const [privateKey, setPrivateKey] = useState<CryptoKey | null>(null);
	const [pasteInput, setPasteInput] = useState("");
	const [status, setStatus] = useState("");
	const [isError, setIsError] = useState(false);
	const [copied, setCopied] = useState(false);
	const [loading, setLoading] = useState(false);
	const [ready, setReady] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	// Generate keypair on mount and build the full command
	useEffect(() => {
		generateKeypair()
			.then(({ keyPair, publicKeyBase64 }) => {
				setCommand(`og auth ${publicKeyBase64}`);
				setPrivateKey(keyPair.privateKey);
				setReady(true);
			})
			.catch(() => {
				setStatus("Failed to initialize. Is this a modern browser?");
				setIsError(true);
			});
	}, []);

	const handleCopy = useCallback(async () => {
		try {
			await navigator.clipboard.writeText(command);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			// Fallback: select the command text
			const el = document.querySelector(".og-login-command-text");
			if (el) {
				const range = document.createRange();
				range.selectNodeContents(el);
				const sel = window.getSelection();
				sel?.removeAllRanges();
				sel?.addRange(range);
			}
		}
	}, [command]);

	const handleLogin = useCallback(async () => {
		const trimmed = pasteInput.trim();
		if (!trimmed || !privateKey) {
			setStatus("Paste the output from the command above");
			setIsError(true);
			return;
		}

		setLoading(true);
		setStatus("");
		setIsError(false);

		try {
			const jwt = await decryptWithPrivateKey(privateKey, trimmed);
			setToken(jwt);
			onAuthenticated();
		} catch {
			setStatus("Invalid token. Make sure you copied the full output.");
			setIsError(true);
		} finally {
			setLoading(false);
		}
	}, [pasteInput, privateKey, onAuthenticated]);

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

				{!ready ? (
					<p className="og-login-subtitle">Initializing…</p>
				) : (
					<>
						<p className="og-login-subtitle">
							Run this command in your terminal:
						</p>
						<div className="og-login-command-block">
							<code className="og-login-command-text">{command}</code>
							<button
								type="button"
								className="og-login-btn og-login-btn-copy"
								onClick={handleCopy}
							>
								{copied ? "✓ Copied" : "Copy"}
							</button>
						</div>

						<p className="og-login-subtitle">Then paste the output here:</p>
						<input
							ref={inputRef}
							type="password"
							className="og-login-input"
							placeholder="Paste output here"
							value={pasteInput}
							onChange={(e) => setPasteInput(e.target.value)}
							onKeyDown={handleKeyDown}
							disabled={loading}
						/>
						<button
							type="button"
							className="og-login-btn"
							onClick={handleLogin}
							disabled={loading || !pasteInput.trim()}
						>
							{loading ? "Verifying…" : "Login"}
						</button>
					</>
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
