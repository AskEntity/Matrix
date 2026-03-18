/**
 * WebAuthn/Passkey authentication for remote access.
 *
 * Credentials stored in ~/.opengraft/auth.json.
 * Sessions maintained via random token in cookie.
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
	sessions: SessionEntry[];
}

interface SessionEntry {
	token: string;
	createdAt: number;
	/** Session expiry in ms since epoch. */
	expiresAt: number;
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
			sessions: data.sessions ?? [],
		};
	} catch {
		authDataCache = { credentials: [], sessions: [] };
	}
	return authDataCache;
}

async function writeAuthData(path: string, data: AuthData): Promise<void> {
	authDataCache = data;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(data, null, "\t"), "utf-8");
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

// ── Session Management ─────────────────────────────────────────────────────

const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

function generateToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export async function createSession(authPath: string): Promise<string> {
	const data = await readAuthData(authPath);
	const now = Date.now();

	// Prune expired sessions
	data.sessions = data.sessions.filter((s) => s.expiresAt > now);

	const token = generateToken();
	data.sessions.push({
		token,
		createdAt: now,
		expiresAt: now + SESSION_TTL,
	});
	await writeAuthData(authPath, data);
	return token;
}

export async function verifySession(
	authPath: string,
	token: string,
): Promise<boolean> {
	if (!token) return false;
	const data = await readAuthData(authPath);
	const session = data.sessions.find((s) => s.token === token);
	if (!session) return false;
	if (session.expiresAt < Date.now()) {
		// Remove expired session
		data.sessions = data.sessions.filter((s) => s.token !== token);
		await writeAuthData(authPath, data);
		return false;
	}
	return true;
}

export async function removeSession(
	authPath: string,
	token: string,
): Promise<void> {
	const data = await readAuthData(authPath);
	data.sessions = data.sessions.filter((s) => s.token !== token);
	await writeAuthData(authPath, data);
}

/** Clear the in-memory cache (for testing). */
export function clearAuthCache(): void {
	authDataCache = null;
	challenges.clear();
}
