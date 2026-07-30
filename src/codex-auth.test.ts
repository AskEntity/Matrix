import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	openAICredentialSource,
	readCodexAuth,
	staticCredential,
} from "./codex-auth.ts";

/** A JWT whose payload carries `exp`. Signature is not checked — we never verify it. */
function jwt(payload: Record<string, unknown>): string {
	const b64 = (o: unknown) =>
		Buffer.from(JSON.stringify(o)).toString("base64url");
	return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

const HOUR = 3600;
const nowSec = () => Math.floor(Date.now() / 1000);

describe("readCodexAuth", () => {
	let dir: string;
	let path: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "codex-auth-"));
		path = join(dir, "auth.json");
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	async function write(file: unknown): Promise<void> {
		await writeFile(path, JSON.stringify(file));
	}

	test("reads the access token and the account id", async () => {
		await write({
			auth_mode: "chatgpt",
			// ⚠️ null here is NORMAL — it is the marker of the ChatGPT OAuth path,
			// not damage. A reader that treats it as corrupt rejects every healthy
			// codex login.
			OPENAI_API_KEY: null,
			tokens: {
				id_token: "ignored",
				access_token: jwt({ exp: nowSec() + HOUR }),
				refresh_token: "also-ignored",
				account_id: "acct-42",
			},
			last_refresh: "2026-07-30T00:01:10.335671Z",
		});
		const cred = await readCodexAuth(path);
		expect(cred.authToken).toStartWith("eyJ");
		expect(cred.accountId).toBe("acct-42");
	});

	test("an expired token throws, naming the file, the date and the fix", async () => {
		const expired = nowSec() - HOUR;
		await write({ tokens: { access_token: jwt({ exp: expired }) } });
		const err = await readCodexAuth(path).catch((e: Error) => e);
		expect(err).toBeInstanceOf(Error);
		const msg = (err as Error).message;
		expect(msg).toContain(path);
		expect(msg).toContain(new Date(expired * 1000).toISOString());
		expect(msg).toContain("codex login");
		// The reason we do not simply refresh it ourselves — without this the
		// instruction reads as a limitation rather than an ownership boundary.
		expect(msg).toMatch(/only reads|belongs to codex/i);
	});

	test("a token expiring in the future is accepted", async () => {
		await write({ tokens: { access_token: jwt({ exp: nowSec() + 60 }) } });
		await expect(readCodexAuth(path)).resolves.toBeDefined();
	});

	/**
	 * "Cannot judge" is not "expired". A token we fail to parse is still handed
	 * to the API, which is the authority on whether it works — failing locally
	 * on our own inability to read it would break a working setup.
	 */
	test("a non-JWT token passes through rather than being rejected", async () => {
		await write({ tokens: { access_token: "opaque-not-a-jwt" } });
		expect((await readCodexAuth(path)).authToken).toBe("opaque-not-a-jwt");
	});

	test("a JWT with no exp claim passes through", async () => {
		await write({ tokens: { access_token: jwt({ sub: "u1" }) } });
		await expect(readCodexAuth(path)).resolves.toBeDefined();
	});

	test("a missing file says how to create it", async () => {
		const missing = join(dir, "nope.json");
		await expect(readCodexAuth(missing)).rejects.toThrow(
			/does not exist.*codex login/s,
		);
	});

	test("a file with no tokens.access_token is named as such", async () => {
		await write({ OPENAI_API_KEY: null, tokens: {} });
		await expect(readCodexAuth(path)).rejects.toThrow(/tokens\.access_token/);
	});

	test("invalid JSON is reported as invalid JSON, not as a missing token", async () => {
		await writeFile(path, "{ not json");
		await expect(readCodexAuth(path)).rejects.toThrow(/not valid JSON/i);
	});

	/**
	 * ⚠️ The single most important property in this file. Rewriting auth.json
	 * from anything we hold throws away the tokens codex just refreshed — the
	 * documented way to break a working codex install. Asserted on mtime AND
	 * bytes, because a write of identical content still breaks the ownership
	 * rule and would leave the bytes assertion green.
	 */
	test("reading never writes the file", async () => {
		await write({ tokens: { access_token: jwt({ exp: nowSec() + HOUR }) } });
		const before = await stat(path);
		const bytesBefore = await readFile(path, "utf-8");
		await new Promise((r) => setTimeout(r, 10));
		await readCodexAuth(path);
		await readCodexAuth(path);
		const after = await stat(path);
		expect(after.mtimeMs).toBe(before.mtimeMs);
		expect(await readFile(path, "utf-8")).toBe(bytesBefore);
	});

	test("an expired token is still not repaired or rewritten", async () => {
		await write({ tokens: { access_token: jwt({ exp: nowSec() - HOUR }) } });
		const bytesBefore = await readFile(path, "utf-8");
		await readCodexAuth(path).catch(() => {});
		expect(await readFile(path, "utf-8")).toBe(bytesBefore);
	});

	/**
	 * `~/.codex/auth.json` is the documented location and neither of the two
	 * places a user types it — a settings text field, a JSON config file — goes
	 * through a shell. Without expansion the error quotes back the exact string
	 * they typed, which looks correct, and the read happened somewhere else.
	 */
	test("a leading ~/ is expanded, and the error names the resolved path", async () => {
		const err = await readCodexAuth("~/.mxd-nonexistent-probe/auth.json").catch(
			(e: Error) => e,
		);
		const msg = (err as Error).message;
		expect(msg).toContain(homedir());
		expect(msg).not.toContain("~/");
	});
});

describe("openAICredentialSource", () => {
	test("apiKey wins and never touches the filesystem", async () => {
		const source = openAICredentialSource({
			provider: "openai",
			apiKey: "sk-platform",
			authJsonPath: "/definitely/not/here.json",
		});
		expect((await source()).authToken).toBe("sk-platform");
	});

	/**
	 * Deferred to first USE rather than thrown at construction: a misconfigured
	 * group must not be able to take down a daemon that was never going to call
	 * it. The message names both fields, because which one you want depends on
	 * which endpoint you meant.
	 */
	test("a group with neither credential throws at use, naming both options", async () => {
		const source = openAICredentialSource({ provider: "openai" });
		const err = await source().catch((e: Error) => e);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toContain("apiKey");
		expect((err as Error).message).toContain("authJsonPath");
	});

	test("staticCredential carries an optional account id", async () => {
		expect(await staticCredential("t", "a")()).toEqual({
			authToken: "t",
			accountId: "a",
		});
		expect((await staticCredential("t")()).accountId).toBeUndefined();
	});
});
