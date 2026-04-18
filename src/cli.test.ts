/**
 * CLI tests.
 *
 * The CLI's `AUTH_JSON_PATH` must respect `MXD_DATA_DIR` so it stays in
 * lockstep with the daemon. If the two diverge, the CLI signs tokens with
 * one jwtSecret while the daemon verifies with another — any `mxd auth`
 * flow on an alt data dir silently fails authentication.
 *
 * Regression for:
 *   User hits `MXD_DATA_DIR=/tmp/x bun src/daemon.ts` for smoke testing.
 *   CLI's `mxd auth <pub>` writes to ~/.mxd/auth.json, daemon reads
 *   /tmp/x/auth.json — browser login fails with an opaque 401.
 *
 * We spawn the CLI as a subprocess so the test exercises the real
 * module-load path resolution (not a reimplementation of it).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = new URL("./cli.ts", import.meta.url).pathname;

/**
 * Generate a real RSA-OAEP SPKI public key so the CLI's
 * `encryptWithPublicKey` path runs end-to-end. Returns base64-encoded SPKI,
 * which is exactly the format `mxd auth <pub>` expects.
 */
async function generatePubKeyBase64(): Promise<string> {
	const kp = await crypto.subtle.generateKey(
		{
			name: "RSA-OAEP",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["encrypt", "decrypt"],
	);
	const spki = await crypto.subtle.exportKey("spki", kp.publicKey);
	return Buffer.from(spki).toString("base64");
}

describe("cli: AUTH_JSON_PATH respects MXD_DATA_DIR", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "mxd-cli-auth-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	test("mxd auth <pub> writes auth.json to MXD_DATA_DIR, not ~/.mxd", async () => {
		const pubKey = await generatePubKeyBase64();
		// Fresh dataDir, no pre-existing auth.json — CLI must create it.
		expect(existsSync(join(dataDir, "auth.json"))).toBe(false);

		const proc = Bun.spawn(["bun", CLI_PATH, "auth", pubKey], {
			env: { ...process.env, MXD_DATA_DIR: dataDir },
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		const stderr = await new Response(proc.stderr).text();
		expect(exitCode, `stderr: ${stderr}`).toBe(0);

		// auth.json lives at MXD_DATA_DIR, not at ~/.mxd/auth.json.
		const authPath = join(dataDir, "auth.json");
		expect(existsSync(authPath)).toBe(true);

		// The CLI initialized a jwtSecret inside the custom dir — the single
		// piece of evidence that `AUTH_JSON_PATH = join(DATA_DIR, "auth.json")`
		// resolved through MXD_DATA_DIR and not the homedir fallback.
		const raw = JSON.parse(await readFile(authPath, "utf-8"));
		expect(typeof raw.jwtSecret).toBe("string");
		expect(raw.jwtSecret.length).toBeGreaterThan(0);

		// Output is the encrypted token — non-empty means encryption
		// succeeded with a token signed using THIS dir's jwtSecret.
		const stdout = await new Response(proc.stdout).text();
		expect(stdout.trim().length).toBeGreaterThan(0);
	});

	test("mxd auth without MXD_DATA_DIR falls back to HOME/.mxd", async () => {
		const fakeHome = dataDir;
		const pubKey = await generatePubKeyBase64();

		// Strip MXD_DATA_DIR so the fallback (join(homedir(), ".mxd")) runs.
		// HOME is the source of truth for homedir() on macOS/Linux (Bun test
		// runs on macOS); isolating HOME keeps the test from touching the
		// real ~/.mxd/auth.json.
		const { MXD_DATA_DIR: _omit, ...envWithoutDataDir } = process.env;
		const proc = Bun.spawn(["bun", CLI_PATH, "auth", pubKey], {
			env: { ...envWithoutDataDir, HOME: fakeHome },
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		const stderr = await new Response(proc.stderr).text();
		expect(exitCode, `stderr: ${stderr}`).toBe(0);

		// Fallback path: HOME/.mxd/auth.json, not HOME/auth.json.
		expect(existsSync(join(fakeHome, ".mxd", "auth.json"))).toBe(true);
		expect(existsSync(join(fakeHome, "auth.json"))).toBe(false);
	});
});
