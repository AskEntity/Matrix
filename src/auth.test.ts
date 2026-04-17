/**
 * Unit tests for the `auth.ts` primitives: token signing, verification,
 * revocation (secretVersion), subject restriction, cache semantics.
 */
import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	bumpSecretVersion,
	ensureAuthInitialized,
	getSecretVersion,
	hasJwtSecret,
	signCLIToken,
	signSessionToken,
	signStreamToken,
	verifyJWT,
} from "./auth.ts";

async function mkTempAuthPath(): Promise<string> {
	const { mkdtemp } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const dir = await mkdtemp(join(tmpdir(), "auth-test-"));
	return join(dir, "auth.json");
}

describe("auth: initialization", () => {
	test("ensureAuthInitialized creates jwtSecret + secretVersion on first boot", async () => {
		const authPath = await mkTempAuthPath();
		expect(await hasJwtSecret(authPath)).toBe(false);

		const result = await ensureAuthInitialized(authPath);
		expect(result.createdSecret).toBe(true);
		expect(await hasJwtSecret(authPath)).toBe(true);
		expect(await getSecretVersion(authPath)).toBe(1);

		// Stored auth.json has both fields
		const raw = JSON.parse(await readFile(authPath, "utf-8"));
		expect(typeof raw.jwtSecret).toBe("string");
		expect(typeof raw.secretVersion).toBe("number");
	});

	test("ensureAuthInitialized is idempotent on subsequent calls", async () => {
		const authPath = await mkTempAuthPath();
		await ensureAuthInitialized(authPath);
		const before = await readFile(authPath, "utf-8");

		const result = await ensureAuthInitialized(authPath);
		expect(result.createdSecret).toBe(false);
		const after = await readFile(authPath, "utf-8");
		expect(after).toEqual(before);
	});
});

describe("auth: JWT sign + verify round-trip", () => {
	test("signSessionToken + verifyJWT returns payload with sub='session'", async () => {
		const authPath = await mkTempAuthPath();
		await ensureAuthInitialized(authPath);
		const tok = await signSessionToken(authPath);

		const payload = await verifyJWT(authPath, tok);
		expect(payload).not.toBeNull();
		expect(payload?.sub).toBe("session");
		expect(payload?.sv).toBe(1);
	});

	test("signStreamToken + verifyJWT returns payload with sub='stream'", async () => {
		const authPath = await mkTempAuthPath();
		await ensureAuthInitialized(authPath);
		const tok = await signStreamToken(authPath);

		const payload = await verifyJWT(authPath, tok, ["stream"]);
		expect(payload?.sub).toBe("stream");
	});

	test("signCLIToken + verifyJWT returns payload with sub='cli'", async () => {
		const authPath = await mkTempAuthPath();
		await ensureAuthInitialized(authPath);
		const tok = await signCLIToken(authPath);

		const payload = await verifyJWT(authPath, tok);
		expect(payload?.sub).toBe("cli");
	});

	test("malformed token → null", async () => {
		const authPath = await mkTempAuthPath();
		await ensureAuthInitialized(authPath);
		expect(await verifyJWT(authPath, "not.a.jwt")).toBeNull();
		expect(await verifyJWT(authPath, "")).toBeNull();
		expect(await verifyJWT(authPath, "only-one-part")).toBeNull();
	});

	test("verifyJWT rejects stream token when allowedSubjects=['session']", async () => {
		const authPath = await mkTempAuthPath();
		await ensureAuthInitialized(authPath);
		const streamTok = await signStreamToken(authPath);

		expect(await verifyJWT(authPath, streamTok, ["session"])).toBeNull();
		expect(await verifyJWT(authPath, streamTok, ["stream"])).not.toBeNull();
		expect(
			await verifyJWT(authPath, streamTok, ["session", "stream"]),
		).not.toBeNull();
	});

	test("verifyJWT rejects session token on /events (allowedSubjects=['stream'])", async () => {
		const authPath = await mkTempAuthPath();
		await ensureAuthInitialized(authPath);
		const sessionTok = await signSessionToken(authPath);
		expect(await verifyJWT(authPath, sessionTok, ["stream"])).toBeNull();
	});
});

describe("auth: revocation via secretVersion", () => {
	test("bumpSecretVersion invalidates every previously signed token", async () => {
		const authPath = await mkTempAuthPath();
		await ensureAuthInitialized(authPath);
		const sessionTok = await signSessionToken(authPath);
		const streamTok = await signStreamToken(authPath);
		const cliTok = await signCLIToken(authPath);

		expect(await verifyJWT(authPath, sessionTok)).not.toBeNull();
		expect(await verifyJWT(authPath, streamTok, ["stream"])).not.toBeNull();
		expect(await verifyJWT(authPath, cliTok)).not.toBeNull();

		const v = await bumpSecretVersion(authPath);
		expect(v).toBe(2);

		expect(await verifyJWT(authPath, sessionTok)).toBeNull();
		expect(await verifyJWT(authPath, streamTok, ["stream"])).toBeNull();
		expect(await verifyJWT(authPath, cliTok)).toBeNull();

		// A new token signed AFTER the bump is valid again.
		const newTok = await signSessionToken(authPath);
		const payload = await verifyJWT(authPath, newTok);
		expect(payload?.sv).toBe(2);
	});

	test("legacy token without `sv` claim is rejected", async () => {
		const authPath = await mkTempAuthPath();
		await ensureAuthInitialized(authPath);
		// Hand-craft a legacy token (sv missing)
		const { getSigningKey } = await import("./auth.ts");
		const key = await getSigningKey(authPath);
		const payload = {
			sub: "session",
			iat: Math.floor(Date.now() / 1000),
			exp: Math.floor(Date.now() / 1000) + 3600,
			// sv intentionally missing
		};
		const toB64 = (s: string) =>
			btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
		const headerB64 = toB64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
		const payloadB64 = toB64(JSON.stringify(payload));
		const signingInput = `${headerB64}.${payloadB64}`;
		const signature = await crypto.subtle.sign(
			"HMAC",
			key,
			new TextEncoder().encode(signingInput),
		);
		const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=/g, "");
		const legacyTok = `${signingInput}.${sigB64}`;

		expect(await verifyJWT(authPath, legacyTok)).toBeNull();
	});
});

describe("auth: no-cache staleness fix", () => {
	test("daemon re-reads auth.json after on-disk changes (no in-memory cache)", async () => {
		const authPath = await mkTempAuthPath();

		// Simulate: daemon boots with no auth.json, user later creates one.
		expect(await hasJwtSecret(authPath)).toBe(false);

		// Out-of-band write (e.g. `mxd auth`)
		await writeFile(
			authPath,
			JSON.stringify({ jwtSecret: "x".repeat(44), secretVersion: 1 }),
			"utf-8",
		);

		// Previously `authDataCache` stayed stale → `hasJwtSecret` kept
		// returning false until restart. After the fix the next call
		// re-reads from disk and reports auth as enabled.
		expect(await hasJwtSecret(authPath)).toBe(true);
	});

	test("signing secret rotation is visible to subsequent verify calls", async () => {
		const authPath = await mkTempAuthPath();
		await ensureAuthInitialized(authPath);
		const tok = await signSessionToken(authPath);
		expect(await verifyJWT(authPath, tok)).not.toBeNull();

		// Rotate the JWT secret (simulating key compromise recovery).
		const raw = JSON.parse(await readFile(authPath, "utf-8"));
		// Write a new random 32-byte key
		const fresh = new Uint8Array(32);
		crypto.getRandomValues(fresh);
		raw.jwtSecret = btoa(String.fromCharCode(...fresh));
		await writeFile(authPath, JSON.stringify(raw), "utf-8");

		// Old token is now invalid (wrong HMAC).
		expect(await verifyJWT(authPath, tok)).toBeNull();
	});
});
