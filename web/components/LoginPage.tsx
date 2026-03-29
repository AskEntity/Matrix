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
	const [step, setStep] = useState<"generating" | "show-key" | "paste">(
		"generating",
	);
	const [publicKey, setPublicKey] = useState("");
	const [privateKey, setPrivateKey] = useState<CryptoKey | null>(null);
	const [ciphertextInput, setCiphertextInput] = useState("");
	const [status, setStatus] = useState("");
	const [isError, setIsError] = useState(false);
	const [copied, setCopied] = useState(false);
	const [loading, setLoading] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	// Generate keypair on mount
	useEffect(() => {
		generateKeypair()
			.then(({ keyPair, publicKeyBase64 }) => {
				setPublicKey(publicKeyBase64);
				setPrivateKey(keyPair.privateKey);
				setStep("show-key");
			})
			.catch(() => {
				setStatus("Failed to generate keypair. Is Web Crypto available?");
				setIsError(true);
			});
	}, []);

	const handleCopyKey = useCallback(async () => {
		try {
			await navigator.clipboard.writeText(publicKey);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			// Fallback: select text for manual copy
			const el = document.querySelector(".og-login-key-display");
			if (el) {
				const range = document.createRange();
				range.selectNodeContents(el);
				const sel = window.getSelection();
				sel?.removeAllRanges();
				sel?.addRange(range);
			}
		}
	}, [publicKey]);

	const handleProceedToPaste = useCallback(() => {
		setStep("paste");
		setStatus("");
		setIsError(false);
		// Focus the input after transition
		setTimeout(() => inputRef.current?.focus(), 100);
	}, []);

	const handleDecrypt = useCallback(async () => {
		const trimmed = ciphertextInput.trim();
		if (!trimmed || !privateKey) {
			setStatus("Please paste the encrypted token");
			setIsError(true);
			return;
		}

		setLoading(true);
		setStatus("");
		setIsError(false);

		try {
			const jwt = await decryptWithPrivateKey(privateKey, trimmed);
			setToken(jwt);
			setStatus("Authenticated!");
			setIsError(false);
			onAuthenticated();
		} catch {
			setStatus("Decryption failed. Make sure you copied the full output.");
			setIsError(true);
		} finally {
			setLoading(false);
		}
	}, [ciphertextInput, privateKey, onAuthenticated]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Enter" && !loading) {
				handleDecrypt();
			}
		},
		[handleDecrypt, loading],
	);

	return (
		<div className="og-login-page">
			<div className="og-login-card">
				<div className="og-login-icon">🔐</div>
				<h1 className="og-login-title">OpenGraft</h1>

				{step === "generating" && (
					<p className="og-login-subtitle">Generating keypair…</p>
				)}

				{step === "show-key" && (
					<>
						<p className="og-login-subtitle">
							Copy this key, then run in your terminal:
						</p>
						<div className="og-login-command">
							<code>og auth &lt;public_key&gt;</code>
						</div>
						<div className="og-login-key-wrapper">
							<div className="og-login-key-display">{publicKey}</div>
							<button
								type="button"
								className="og-login-btn og-login-btn-copy"
								onClick={handleCopyKey}
							>
								{copied ? "Copied!" : "Copy Key"}
							</button>
						</div>
						<button
							type="button"
							className="og-login-btn"
							onClick={handleProceedToPaste}
						>
							Next: Paste Encrypted Token →
						</button>
					</>
				)}

				{step === "paste" && (
					<>
						<p className="og-login-subtitle">
							Paste the encrypted output from <code>og auth</code> below:
						</p>
						<input
							ref={inputRef}
							type="password"
							className="og-login-input"
							placeholder="Paste encrypted token here"
							value={ciphertextInput}
							onChange={(e) => setCiphertextInput(e.target.value)}
							onKeyDown={handleKeyDown}
							disabled={loading}
						/>
						<div className="og-login-actions">
							<button
								type="button"
								className="og-login-btn og-login-btn-ghost"
								onClick={() => {
									setStep("show-key");
									setCiphertextInput("");
									setStatus("");
									setIsError(false);
								}}
							>
								← Back
							</button>
							<button
								type="button"
								className="og-login-btn"
								onClick={handleDecrypt}
								disabled={loading || !ciphertextInput.trim()}
							>
								{loading ? "Decrypting..." : "Login"}
							</button>
						</div>
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
