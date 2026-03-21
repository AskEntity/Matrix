/**
 * WebAuthn/Passkey authentication for remote access.
 *
 * Credentials stored in ~/.opengraft/auth.json.
 * JWT tokens issued after WebAuthn verification (stateless, survives daemon restarts).
 * HMAC-SHA256 signing key auto-generated and persisted in auth.json.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
	AuthenticatorTransportFuture,
	Base64URLString,
} from "@simplewebauthn/server";

// ── Types ──────────────────────────────────────────────────────────────────

export interface StoredCredential {
	credentialID: Base64URLString;
	publicKey: string; // base64url-encoded
	counter: number;
	transports?: AuthenticatorTransportFuture[];
	createdAt: string;
}

interface AuthData {
	credentials: StoredCredential[];
	/** HMAC-SHA256 key for JWT signing, base64-encoded. Auto-generated on first use. */
	jwtSecret?: string;
	/** @deprecated — old session entries, kept for backward compat parsing only. */
	sessions?: unknown[];
}

interface JWTPayload {
	/** Credential ID that authenticated */
	sub: string;
	/** Issued-at (seconds since epoch) */
	iat: number;
	/** Expiry (seconds since epoch) */
	exp: number;
}

/** In-memory challenge store (short-lived, not persisted). */
const challenges = new Map<string, { challenge: string; expiresAt: number }>();

// ── Credential Storage ─────────────────────────────────────────────────────

let authDataCache: AuthData | null = null;

async function readAuthData(path: string): Promise<AuthData> {
	if (authDataCache) return authDataCache;
	try {
		const data = JSON.parse(await readFile(path, "utf-8")) as Partial<AuthData>;
		authDataCache = {
			credentials: data.credentials ?? [],
			jwtSecret: data.jwtSecret,
		};
	} catch {
		authDataCache = { credentials: [] };
	}
	return authDataCache;
}

async function writeAuthData(path: string, data: AuthData): Promise<void> {
	authDataCache = data;
	await mkdir(dirname(path), { recursive: true });
	// Don't persist deprecated sessions field
	const { sessions: _, ...clean } = data as AuthData & {
		sessions?: unknown[];
	};
	await writeFile(path, JSON.stringify(clean, null, "\t"), "utf-8");
}

export async function getCredentials(
	authPath: string,
): Promise<StoredCredential[]> {
	const data = await readAuthData(authPath);
	return data.credentials;
}

export async function addCredential(
	authPath: string,
	credential: StoredCredential,
): Promise<void> {
	const data = await readAuthData(authPath);
	data.credentials.push(credential);
	await writeAuthData(authPath, data);
}

export async function updateCredentialCounter(
	authPath: string,
	credentialID: Base64URLString,
	newCounter: number,
): Promise<void> {
	const data = await readAuthData(authPath);
	const cred = data.credentials.find((c) => c.credentialID === credentialID);
	if (cred) {
		cred.counter = newCounter;
		await writeAuthData(authPath, data);
	}
}

export async function removeCredential(
	authPath: string,
	credentialID: Base64URLString,
): Promise<boolean> {
	const data = await readAuthData(authPath);
	const before = data.credentials.length;
	data.credentials = data.credentials.filter(
		(c) => c.credentialID !== credentialID,
	);
	if (data.credentials.length === before) return false;
	await writeAuthData(authPath, data);
	return true;
}

export async function hasCredentials(authPath: string): Promise<boolean> {
	const creds = await getCredentials(authPath);
	return creds.length > 0;
}

// ── Challenge Management ───────────────────────────────────────────────────

const CHALLENGE_TTL = 5 * 60 * 1000; // 5 minutes

export function storeChallenge(key: string, challenge: string): void {
	// Clean expired challenges
	const now = Date.now();
	for (const [k, v] of challenges) {
		if (v.expiresAt < now) challenges.delete(k);
	}
	challenges.set(key, { challenge, expiresAt: now + CHALLENGE_TTL });
}

export function getAndRemoveChallenge(key: string): string | null {
	const entry = challenges.get(key);
	if (!entry) return null;
	challenges.delete(key);
	if (entry.expiresAt < Date.now()) return null;
	return entry.challenge;
}

// ── JWT Management ─────────────────────────────────────────────────────────

const JWT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/** Get or create the HMAC-SHA256 signing key. Persisted in auth.json. */
async function getSigningKey(authPath: string): Promise<CryptoKey> {
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

/** Sign a JWT token for the given credential ID. */
export async function signJWT(
	authPath: string,
	credentialID: string,
): Promise<string> {
	const key = await getSigningKey(authPath);
	const now = Math.floor(Date.now() / 1000);

	const header = { alg: "HS256", typ: "JWT" };
	const payload: JWTPayload = {
		sub: credentialID,
		iat: now,
		exp: now + JWT_TTL_SECONDS,
	};

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

/** Clear the in-memory cache (for testing). */
export function clearAuthCache(): void {
	authDataCache = null;
	challenges.clear();
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
