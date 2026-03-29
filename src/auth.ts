/**
 * Local secret-based authentication.
 *
 * CLI is trust anchor — if you can read ~/.opengraft/auth.json, you're authenticated.
 * JWT tokens issued via `og sign` (CLI) and exchanged for session tokens via POST /auth/exchange.
 * HMAC-SHA256 signing key auto-generated and persisted in auth.json.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ulid } from "./ulid.ts";

// ── Types ──────────────────────────────────────────────────────────────────

interface AuthData {
	/** HMAC-SHA256 key for JWT signing, base64-encoded. Auto-generated on first use. */
	jwtSecret?: string;
}

interface JWTPayload {
	/** Subject — "cli" for CLI auto-auth, "login" for login tokens, "session" for web sessions */
	sub: string;
	/** Issued-at (seconds since epoch) */
	iat: number;
	/** Expiry (seconds since epoch) */
	exp: number;
	/** JWT ID — unique token ID for one-time login tokens */
	jti?: string;
}

// ── Auth Data Storage ──────────────────────────────────────────────────────

let authDataCache: AuthData | null = null;

async function readAuthData(path: string): Promise<AuthData> {
	if (authDataCache) return authDataCache;
	try {
		const raw = JSON.parse(await readFile(path, "utf-8")) as Record<
			string,
			unknown
		>;
		// Only keep jwtSecret — ignore legacy fields like credentials
		authDataCache = {
			jwtSecret: typeof raw.jwtSecret === "string" ? raw.jwtSecret : undefined,
		};
	} catch {
		authDataCache = {};
	}
	return authDataCache;
}

async function writeAuthData(path: string, data: AuthData): Promise<void> {
	authDataCache = data;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(data, null, "\t"), "utf-8");
}

/** Reset the in-memory auth data cache (for testing). */
export function resetAuthDataCache(): void {
	authDataCache = null;
}

// ── JWT Management ─────────────────────────────────────────────────────────

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const LOGIN_TTL_SECONDS = 5 * 60; // 5 minutes
const CLI_TTL_SECONDS = 5 * 60; // 5 minutes

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
 */
async function signJWTRaw(
	authPath: string,
	payload: JWTPayload,
): Promise<string> {
	const key = await getSigningKey(authPath);

	const header = { alg: "HS256", typ: "JWT" };
	const headerB64 = toBase64Url(JSON.stringify(header));
	const payloadB64 = toBase64Url(JSON.stringify(payload));
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
 * Sign a short-lived login token (5min TTL) with unique jti.
 * Used by `og sign` — user pastes into web UI to exchange for session token.
 */
export async function signLoginToken(
	authPath: string,
	ttlSeconds?: number,
): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return signJWTRaw(authPath, {
		sub: "login",
		iat: now,
		exp: now + (ttlSeconds ?? LOGIN_TTL_SECONDS),
		jti: ulid(),
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
 * Legacy signJWT for backward compatibility — generates a session token.
 * @deprecated Use signSessionToken, signLoginToken, or signCLIToken instead.
 */
export async function signJWT(
	authPath: string,
	_credentialID: string,
): Promise<string> {
	return signSessionToken(authPath);
}

/** Verify a JWT token. Returns the payload if valid, null otherwise. */
export async function verifyJWT(
	authPath: string,
	token: string,
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

	return payload;
}

// ── JTI replay prevention ─────────────────────────────────────────────────

/** In-memory set of used login token jtis. Entries auto-expire after 5 minutes. */
const usedJtis = new Map<string, number>(); // jti → expiry timestamp (ms)

const JTI_CLEANUP_INTERVAL = 60_000; // Clean expired entries every 60s
let jtiCleanupTimer: ReturnType<typeof setInterval> | null = null;

function ensureJtiCleanup(): void {
	if (jtiCleanupTimer) return;
	jtiCleanupTimer = setInterval(() => {
		const now = Date.now();
		for (const [jti, expiresAt] of usedJtis) {
			if (expiresAt < now) usedJtis.delete(jti);
		}
		// Stop timer if no entries
		if (usedJtis.size === 0 && jtiCleanupTimer) {
			clearInterval(jtiCleanupTimer);
			jtiCleanupTimer = null;
		}
	}, JTI_CLEANUP_INTERVAL);
	// Don't keep the process alive just for cleanup
	if (typeof jtiCleanupTimer === "object" && "unref" in jtiCleanupTimer) {
		jtiCleanupTimer.unref();
	}
}

/** Check if a jti has been used. If not, mark it as used (one-time). Returns true if unused (fresh). */
export function consumeJti(jti: string): boolean {
	// Clean expired entries inline (cheap)
	const now = Date.now();
	if (usedJtis.has(jti)) {
		const expiresAt = usedJtis.get(jti);
		if (expiresAt && expiresAt < now) {
			usedJtis.delete(jti);
		} else {
			return false; // Already used
		}
	}
	// Mark as used (expires after 5 minutes)
	usedJtis.set(jti, now + 5 * 60 * 1000);
	ensureJtiCleanup();
	return true;
}

/** Clear used JTI tracking (for testing). */
export function clearUsedJtis(): void {
	usedJtis.clear();
	if (jtiCleanupTimer) {
		clearInterval(jtiCleanupTimer);
		jtiCleanupTimer = null;
	}
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

function base64ToUint8Array(b64: string): Uint8Array<ArrayBuffer> {
	const binary = atob(b64);
	const buf = new ArrayBuffer(binary.length);
	const bytes = new Uint8Array(buf);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}
