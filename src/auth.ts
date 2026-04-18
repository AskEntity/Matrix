/**
 * Local secret-based authentication.
 *
 * CLI is trust anchor — if you can read ~/.mxd/auth.json, you're authenticated.
 * Challenge-response: browser generates RSA-OAEP keypair, CLI encrypts session JWT with public key.
 * HMAC-SHA256 signing key auto-generated and persisted in auth.json.
 *
 * Revocation: tokens embed `sv` (secretVersion). Bumping `secretVersion` in
 * auth.json invalidates every outstanding token in one atomic step.
 */

import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────────

interface AuthData {
	/** HMAC-SHA256 key for JWT signing, base64-encoded. Auto-generated on first use. */
	jwtSecret?: string;
	/**
	 * Monotonically-increasing counter embedded in every signed JWT as `sv`.
	 * `verifyJWT` rejects tokens whose `sv` differs from the current value,
	 * which lets `bumpSecretVersion` (logout-all) revoke everything atomically.
	 */
	secretVersion?: number;
}

/** JWT subject types. */
export type JWTSubject = "cli" | "session" | "stream";

interface JWTPayload {
	/** Subject — "cli" (short-lived CLI token), "session" (web session),
	 *  "stream" (short-lived SSE token used in query param). */
	sub: JWTSubject;
	/** Secret version at issue time. Rejected if current version is higher. */
	sv?: number;
	/** Issued-at (seconds since epoch) */
	iat: number;
	/** Expiry (seconds since epoch) */
	exp: number;
}

// ── Auth Data Storage ──────────────────────────────────────────────────────

// Deliberately uncached. Prior `authDataCache` stayed stale across
// `mxd auth` (daemon never re-read auth.json until restart); a running
// daemon appeared secured but kept serving unauthenticated requests.
// Local JSON reads are cheap (~tens of μs); correctness trumps the cache.

async function readAuthData(path: string): Promise<AuthData> {
	try {
		const raw = JSON.parse(await readFile(path, "utf-8")) as Record<
			string,
			unknown
		>;
		return {
			jwtSecret: typeof raw.jwtSecret === "string" ? raw.jwtSecret : undefined,
			secretVersion:
				typeof raw.secretVersion === "number" ? raw.secretVersion : undefined,
		};
	} catch {
		return {};
	}
}

async function writeAuthData(path: string, data: AuthData): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	// mode 0o600 = owner rw-, group/others no access. Applies only on
	// CREATION (writeFile over an existing file preserves its current mode).
	// Legacy files at 0o644 are tightened by `ensureSecureFileMode` at boot.
	await writeFile(path, JSON.stringify(data, null, "\t"), {
		encoding: "utf-8",
		mode: 0o600,
	});
}

/**
 * Tighten auth.json to 0o600 if it exists with any group/other permissions.
 * Legacy files predate the 0o600 default in `writeAuthData`. Without this
 * chmod pass, `jwtSecret` remains world-readable on every boot — forever,
 * because `writeFile`'s `mode` option is ignored when overwriting.
 */
async function ensureSecureFileMode(path: string): Promise<void> {
	// File absence (ENOENT) is the normal first-boot case — bail out;
	// writeAuthData will create the file at 0o600 in a moment.
	const info = await stat(path).catch(() => null);
	if (!info) return;
	if ((info.mode & 0o077) !== 0) {
		await chmod(path, 0o600);
	}
}

/**
 * Kept for test compatibility. The in-memory cache was removed, so this is
 * now a no-op; tests may still call it freely.
 * @deprecated no cache exists; call is unnecessary.
 */
export function resetAuthDataCache(): void {
	// no-op — cache removed to fix stale-auth bug
}

/**
 * Read the current secret version (default 1).
 * Exposed so startup can pre-create auth.json with a jwtSecret + initial
 * secretVersion if absent, avoiding the "open window" during bootstrap.
 */
export async function getSecretVersion(authPath: string): Promise<number> {
	const data = await readAuthData(authPath);
	return data.secretVersion ?? 1;
}

/**
 * Increment secretVersion, invalidating every previously-signed token.
 * Used by POST /auth/logout for "logout-all".
 */
export async function bumpSecretVersion(authPath: string): Promise<number> {
	const data = await readAuthData(authPath);
	const next = (data.secretVersion ?? 1) + 1;
	data.secretVersion = next;
	await writeAuthData(authPath, data);
	return next;
}

/**
 * Ensure auth.json has a jwtSecret + secretVersion. Creates both if missing.
 * Called at daemon boot so the "no secret yet" open window closes
 * before the first HTTP request is accepted.
 */
export async function ensureAuthInitialized(
	authPath: string,
): Promise<{ createdSecret: boolean }> {
	// Upgrade-path guard: legacy auth.json files created before the 0o600
	// default in `writeAuthData` may still be 0o644 on disk. Tighten them
	// before any token-signing code reads the secret.
	await ensureSecureFileMode(authPath);
	const data = await readAuthData(authPath);
	if (data.jwtSecret && typeof data.secretVersion === "number") {
		return { createdSecret: false };
	}
	// Generate key if missing
	if (!data.jwtSecret) {
		const key = await crypto.subtle.generateKey(
			{ name: "HMAC", hash: "SHA-256" },
			true,
			["sign", "verify"],
		);
		const raw = await crypto.subtle.exportKey("raw", key);
		data.jwtSecret = uint8ArrayToBase64(new Uint8Array(raw));
	}
	if (typeof data.secretVersion !== "number") {
		data.secretVersion = 1;
	}
	await writeAuthData(authPath, data);
	return { createdSecret: true };
}

// ── JWT Management ─────────────────────────────────────────────────────────

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const CLI_TTL_SECONDS = 5 * 60; // 5 minutes
const STREAM_TTL_SECONDS = 5 * 60; // 5 minutes — SSE query-param token

/** Check whether auth.json has a jwtSecret (i.e., auth is initialized). */
export async function hasJwtSecret(authPath: string): Promise<boolean> {
	const data = await readAuthData(authPath);
	return typeof data.jwtSecret === "string" && data.jwtSecret.length > 0;
}

/** Get or create the HMAC-SHA256 signing key. Persisted in auth.json. */
export async function getSigningKey(authPath: string): Promise<CryptoKey> {
	const data = await readAuthData(authPath);

	if (data.jwtSecret) {
		// Import existing key
		const raw = base64ToUint8Array(data.jwtSecret);
		return crypto.subtle.importKey(
			"raw",
			raw,
			{ name: "HMAC", hash: "SHA-256" },
			true,
			["sign", "verify"],
		);
	}

	// Generate new key
	const key = await crypto.subtle.generateKey(
		{ name: "HMAC", hash: "SHA-256" },
		true,
		["sign", "verify"],
	);
	const raw = await crypto.subtle.exportKey("raw", key);
	data.jwtSecret = uint8ArrayToBase64(new Uint8Array(raw));
	await writeAuthData(authPath, data);
	return key;
}

/**
 * Sign a JWT token with the given claims.
 * Used internally by the specific token generation functions.
 * Automatically stamps the current secretVersion so revoke-all works.
 */
async function signJWTRaw(
	authPath: string,
	payload: Omit<JWTPayload, "sv">,
): Promise<string> {
	const key = await getSigningKey(authPath);
	const sv = await getSecretVersion(authPath);

	const header = { alg: "HS256", typ: "JWT" };
	const fullPayload: JWTPayload = { ...payload, sv };
	const headerB64 = toBase64Url(JSON.stringify(header));
	const payloadB64 = toBase64Url(JSON.stringify(fullPayload));
	const signingInput = `${headerB64}.${payloadB64}`;

	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(signingInput),
	);

	const signatureB64 = uint8ArrayToBase64Url(new Uint8Array(signature));
	return `${signingInput}.${signatureB64}`;
}

/**
 * Sign a short-lived CLI auto-auth token (5min TTL).
 * CLI attaches this to every HTTP request.
 */
export async function signCLIToken(authPath: string): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return signJWTRaw(authPath, {
		sub: "cli",
		iat: now,
		exp: now + CLI_TTL_SECONDS,
	});
}

/**
 * Sign a long-lived session token (30d TTL).
 * Issued by the daemon after login token exchange.
 */
export async function signSessionToken(authPath: string): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return signJWTRaw(authPath, {
		sub: "session",
		iat: now,
		exp: now + SESSION_TTL_SECONDS,
	});
}

/**
 * Sign a short-lived stream token (5min TTL). Issued on demand to EventSource
 * clients so the long-lived session token never rides in the URL (browser
 * history, proxy logs, Referer). Shares the `sv` revocation channel.
 */
export async function signStreamToken(authPath: string): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return signJWTRaw(authPath, {
		sub: "stream",
		iat: now,
		exp: now + STREAM_TTL_SECONDS,
	});
}

/**
 * Verify a JWT token. Returns the payload if valid, null otherwise.
 *
 * Optionally restrict to a specific set of `sub` values (e.g. `/events` only
 * accepts stream tokens). Rejects on:
 *   - malformed token
 *   - bad signature
 *   - expired
 *   - `sv` older than current secretVersion (revoked)
 *   - `sub` not in `allowedSubjects`
 */
export async function verifyJWT(
	authPath: string,
	token: string,
	allowedSubjects?: readonly JWTSubject[],
): Promise<JWTPayload | null> {
	if (!token) return null;

	const parts = token.split(".");
	if (parts.length !== 3) return null;

	const [headerB64, payloadB64, signatureB64] = parts as [
		string,
		string,
		string,
	];

	let key: CryptoKey;
	try {
		key = await getSigningKey(authPath);
	} catch {
		return null;
	}

	// Verify signature
	const signingInput = `${headerB64}.${payloadB64}`;
	const signature = base64UrlToUint8Array(signatureB64);

	let valid: boolean;
	try {
		valid = await crypto.subtle.verify(
			"HMAC",
			key,
			signature,
			new TextEncoder().encode(signingInput),
		);
	} catch {
		return null;
	}

	if (!valid) return null;

	// Parse and validate payload
	let payload: JWTPayload;
	try {
		payload = JSON.parse(fromBase64Url(payloadB64)) as JWTPayload;
	} catch {
		return null;
	}

	// Check expiry
	const now = Math.floor(Date.now() / 1000);
	if (payload.exp <= now) return null;

	// Revocation check: tokens signed before a logout-all are rejected
	const currentVersion = await getSecretVersion(authPath);
	if ((payload.sv ?? 0) < currentVersion) return null;

	// Subject restriction (e.g. stream tokens must not be used for REST)
	if (allowedSubjects && !allowedSubjects.includes(payload.sub)) return null;

	return payload;
}

// ── Base64/Base64URL helpers ───────────────────────────────────────────────

function toBase64Url(str: string): string {
	return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function fromBase64Url(b64url: string): string {
	const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
	const pad = b64.length % 4;
	const padded = pad ? b64 + "=".repeat(4 - pad) : b64;
	return atob(padded);
}

function uint8ArrayToBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i] ?? 0);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function base64UrlToUint8Array(b64url: string): Uint8Array<ArrayBuffer> {
	const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
	const pad = b64.length % 4;
	const padded = pad ? b64 + "=".repeat(4 - pad) : b64;
	const binary = atob(padded);
	const buf = new ArrayBuffer(binary.length);
	const bytes = new Uint8Array(buf);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i] ?? 0);
	}
	return btoa(binary);
}

export function base64ToUint8Array(b64: string): Uint8Array<ArrayBuffer> {
	const binary = atob(b64);
	const buf = new ArrayBuffer(binary.length);
	const bytes = new Uint8Array(buf);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

// ── RSA-OAEP encryption for challenge-response auth ────────────────────────

/**
 * Import a base64-encoded RSA-OAEP public key (spki format) and encrypt data with it.
 * Used by CLI `mxd auth <public_key>` to encrypt a session JWT for the browser.
 */
export async function encryptWithPublicKey(
	publicKeyBase64: string,
	plaintext: string,
): Promise<string> {
	const keyData = base64ToUint8Array(publicKeyBase64);
	const publicKey = await crypto.subtle.importKey(
		"spki",
		keyData,
		{ name: "RSA-OAEP", hash: "SHA-256" },
		false,
		["encrypt"],
	);
	const encrypted = await crypto.subtle.encrypt(
		{ name: "RSA-OAEP" },
		publicKey,
		new TextEncoder().encode(plaintext),
	);
	return uint8ArrayToBase64(new Uint8Array(encrypted));
}
