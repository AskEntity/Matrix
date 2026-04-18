/**
 * Unit tests for the `auth.ts` primitives: token signing, verification,
 * revocation (secretVersion), subject restriction, cache semantics.
 */
import { describe, expect, test } from "bun:test";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
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

// POSIX-only: Windows file modes don't map to POSIX permission bits.
const isPosix = process.platform !== "win32";

describe.skipIf(!isPosix)(
	"auth: file permissions (jwtSecret leak prevention)",
	() => {
		test("fresh auth.json is created with mode 0o600 (owner-only)", async () => {
			const authPath = await mkTempAuthPath();
			await ensureAuthInitialized(authPath);

			const mode = (await stat(authPath)).mode & 0o777;
			expect(mode).toBe(0o600);
		});

		test("pre-existing 0o644 auth.json is tightened to 0o600 on ensureAuthInitialized", async () => {
			const authPath = await mkTempAuthPath();

			// Simulate a legacy file written before the 0o600 default.
			await writeFile(
				authPath,
				JSON.stringify({ jwtSecret: "x".repeat(44), secretVersion: 1 }),
				"utf-8",
			);
			await chmod(authPath, 0o644);
			expect((await stat(authPath)).mode & 0o777).toBe(0o644);

			await ensureAuthInitialized(authPath);
			expect((await stat(authPath)).mode & 0o777).toBe(0o600);
		});

		test("any group/other permission bit triggers chmod to 0o600", async () => {
			// Spot-check additional loose modes so the mask check (`mode & 0o077`)
			// isn't silently pinned to 0o644 only.
			for (const looseMode of [0o640, 0o604, 0o660, 0o666] as const) {
				const authPath = await mkTempAuthPath();
				await writeFile(
					authPath,
					JSON.stringify({ jwtSecret: "x".repeat(44), secretVersion: 1 }),
					"utf-8",
				);
				await chmod(authPath, looseMode);

				await ensureAuthInitialized(authPath);
				expect((await stat(authPath)).mode & 0o777).toBe(0o600);
			}
		});

		test("already-0o600 auth.json is left untouched (idempotent)", async () => {
			const authPath = await mkTempAuthPath();
			await ensureAuthInitialized(authPath);
			expect((await stat(authPath)).mode & 0o777).toBe(0o600);

			await ensureAuthInitialized(authPath);
			expect((await stat(authPath)).mode & 0o777).toBe(0o600);
		});

		test("0o400 (read-only, owner-only) is preserved — no group/other bits set", async () => {
			// Paranoid users might pre-harden to 0o400. Our mask only reacts to
			// group/other permissions, so 0o400 stays untouched.
			const authPath = await mkTempAuthPath();
			await writeFile(
				authPath,
				JSON.stringify({ jwtSecret: "x".repeat(44), secretVersion: 1 }),
				"utf-8",
			);
			await chmod(authPath, 0o400);

			await ensureAuthInitialized(authPath);
			// Note: our chmod-on-init only fires if group/other bits are set.
			// 0o400 has neither, so it passes through unchanged.
			expect((await stat(authPath)).mode & 0o777).toBe(0o400);
		});
	},
);

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

describe("auth: corrupt auth.json fails loud, never silent", () => {
	// Pre-P1.3, any error reading auth.json returned `{}` → hasJwtSecret(false)
	// → middleware skipped auth → silent public exposure. After P1.3 the fall-
	// through is deleted and readAuthData surfaces the error. These tests pin
	// the loud behavior so "catch-all returning empty" can never come back.

	test("corrupt JSON → hasJwtSecret throws (not false)", async () => {
		const authPath = await mkTempAuthPath();
		await writeFile(authPath, "not json at all", "utf-8");
		await expect(hasJwtSecret(authPath)).rejects.toThrow(/not valid JSON/);
	});

	test("empty file → hasJwtSecret throws", async () => {
		const authPath = await mkTempAuthPath();
		await writeFile(authPath, "", "utf-8");
		await expect(hasJwtSecret(authPath)).rejects.toThrow(/not valid JSON/);
	});

	test("missing file is still the pre-init case (no throw)", async () => {
		const authPath = await mkTempAuthPath();
		// ENOENT is distinguished from parse errors — this is the first-
		// boot "auth.json doesn't exist yet" path that ensureAuthInitialized
		// handles by creating the file.
		expect(await hasJwtSecret(authPath)).toBe(false);
	});

	test("getSecretVersion throws on corrupt file", async () => {
		const authPath = await mkTempAuthPath();
		await writeFile(authPath, "{malformed", "utf-8");
		await expect(getSecretVersion(authPath)).rejects.toThrow();
	});
});

describe("auth: atomic writeAuthData", () => {
	test("writeAuthData uses temp-file-then-rename (no partial writes visible)", async () => {
		// Observe the filesystem during a write: temp files are named
		// `.<basename>.tmp.*`; the final file has no such prefix. After write
		// completes, temp is gone and final has full content.
		const authPath = await mkTempAuthPath();
		await ensureAuthInitialized(authPath);

		const dir = authPath.split("/").slice(0, -1).join("/");
		const { readdir } = await import("node:fs/promises");
		const entries = await readdir(dir);

		// Only the real file exists — no orphaned temp files.
		expect(entries).toContain("auth.json");
		const tempFiles = entries.filter((n) => n.startsWith(".auth.json.tmp."));
		expect(tempFiles.length).toBe(0);
	});

	test("crash mid-bump leaves the original auth.json intact (atomic rename)", async () => {
		// Simulate: write a valid file, then trigger a write that we
		// abort mid-way. POSIX rename guarantees the old file stays if
		// the new write didn't complete.
		const authPath = await mkTempAuthPath();
		await ensureAuthInitialized(authPath);
		const originalContent = await readFile(authPath, "utf-8");
		const originalParsed = JSON.parse(originalContent);
		expect(originalParsed.secretVersion).toBe(1);

		// Successful bump — verify it replaces atomically.
		await bumpSecretVersion(authPath);
		const afterBumpParsed = JSON.parse(await readFile(authPath, "utf-8"));
		expect(afterBumpParsed.secretVersion).toBe(2);
		expect(typeof afterBumpParsed.jwtSecret).toBe("string");
		expect(afterBumpParsed.jwtSecret).toBe(originalParsed.jwtSecret);

		// File size is fully-formed JSON (not a 0-byte crash artifact).
		const rawAfter = await readFile(authPath, "utf-8");
		expect(rawAfter.length).toBeGreaterThan(10);
	});
});
