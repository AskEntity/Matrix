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
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

// `mxd config set … --project` writes `<projectPath>/.mxd/config.json` DIRECTLY,
// bypassing the daemon entirely — so the refusal the HTTP door gives is not the
// one this door gives, and for a long time this one gave none at all. It is
// asserted here in the same file as the daemon door's own test would be in
// `daemon-auth.test.ts`, because "the rule is enforced at some of its doors" is
// the failure this boundary keeps producing.
describe("cli: config set --project respects the repo layer's field set", () => {
	let projectPath: string;

	beforeEach(async () => {
		// `findProjectPath` walks up looking for `.git`, so the fixture needs one.
		projectPath = await mkdtemp(join(tmpdir(), "mxd-cli-cfg-"));
		await mkdir(join(projectPath, ".git"), { recursive: true });
	});

	afterEach(async () => {
		await rm(projectPath, { recursive: true, force: true });
	});

	function runConfigSet(args: string[]) {
		return Bun.spawn(["bun", CLI_PATH, "config", ...args], {
			cwd: projectPath,
			env: { ...process.env },
			stdout: "pipe",
			stderr: "pipe",
		});
	}

	test("model is refused, with the reason, and nothing is written", async () => {
		const proc = runConfigSet(["set", "model", "claude-opus-5", "--project"]);
		const exitCode = await proc.exited;
		const stderr = await new Response(proc.stderr).text();
		expect(exitCode).toBe(1);
		expect(stderr).toContain("model");
		expect(stderr).toContain("git-tracked");
		// The refusal happens BEFORE the write. Writing and letting the next read
		// drop it is the exact failure this door exists to avoid: from the user's
		// side a successful write that does nothing is indistinguishable from one
		// that worked.
		expect(existsSync(join(projectPath, ".mxd", "config.json"))).toBe(false);
	});

	test("defaultAuth is refused too", async () => {
		const proc = runConfigSet(["set", "defaultAuth", "work", "--project"]);
		expect(await proc.exited).toBe(1);
		const stderr = await new Response(proc.stderr).text();
		expect(stderr).toContain("defaultAuth");
	});

	test("a field the repo layer does have is still written", async () => {
		// Positive control: without this, a door that refused everything would pass
		// both tests above.
		const proc = runConfigSet(["set", "budgetUsd", "25", "--project"]);
		const stderr = await new Response(proc.stderr).text();
		expect(await proc.exited, `stderr: ${stderr}`).toBe(0);
		const written = JSON.parse(
			await readFile(join(projectPath, ".mxd", "config.json"), "utf-8"),
		) as Record<string, unknown>;
		expect(written).toEqual({ budgetUsd: 25 });
	});
});

/**
 * Global config is the SECOND thing the CLI locates in the data dir, and for a
 * long time it located it somewhere else.
 *
 * `AUTH_JSON_PATH` above is `join(DATA_DIR, "auth.json")` and has its own test
 * and its own comment about staying in lockstep with the daemon. Four lines
 * away, `config.ts`'s `globalConfigPath()` was `join(homedir(), ".mxd",
 * "config.json")` — the same file only while `MXD_DATA_DIR` is unset, while the
 * daemon reads `join(dataDir, "config.json")`. One door closed, the adjacent one
 * open, in the same file as the comment warning about exactly this.
 *
 * MEASURED before the fix: two configs on disk, `MXD_DATA_DIR` pointing at the
 * first, `mxd config auth list` printed the group from the SECOND. So `mxd
 * config set … --global` exited 0 having edited a file nothing reads.
 */
describe("cli: global config lives in the data dir, same as the daemon reads", () => {
	let dataDir: string;
	let fakeHome: string;

	/**
	 * A complete MatrixConfig — `loadGlobalConfig` throws on a partial one.
	 *
	 * The distinguishing value is an auth GROUP NAME, because `config auth list`
	 * is the read path that touches no daemon. `mxd config` with no subcommand
	 * resolves all three layers and would need one running.
	 */
	function completeConfig(marker: string, over: Record<string, unknown> = {}) {
		return JSON.stringify({
			authGroups: { [marker]: { provider: "anthropic", apiKey: "sk-test" } },
			defaultAuth: marker,
			model: "",
			budgetUsd: -1,
			mcpServers: {},
			port: 7433,
			selfBootstrap: false,
			thinkingEffort: 0,
			cacheTtl: { root: "1h", child: "5m" },
			...over,
		});
	}

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "mxd-cli-gcfg-data-"));
		fakeHome = await mkdtemp(join(tmpdir(), "mxd-cli-gcfg-home-"));
		await mkdir(join(fakeHome, ".mxd"), { recursive: true });
		// Both files exist and are DISTINGUISHABLE. A fixture with only one
		// config cannot express the difference between the two paths — it would
		// pass against either.
		await writeFile(
			join(dataDir, "config.json"),
			completeConfig("group-in-data-dir", { model: "model-in-data-dir" }),
		);
		await writeFile(
			join(fakeHome, ".mxd", "config.json"),
			completeConfig("group-in-home", { model: "model-in-home" }),
		);
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
		await rm(fakeHome, { recursive: true, force: true });
	});

	function runCli(args: string[]) {
		return Bun.spawn(["bun", CLI_PATH, ...args], {
			env: { ...process.env, MXD_DATA_DIR: dataDir, HOME: fakeHome },
			stdout: "pipe",
			stderr: "pipe",
		});
	}

	test("config auth list reads the data dir's config, not HOME's", async () => {
		const proc = runCli(["config", "auth", "list"]);
		const stderr = await new Response(proc.stderr).text();
		expect(await proc.exited, `stderr: ${stderr}`).toBe(0);
		const out = await new Response(proc.stdout).text();
		expect(out).toContain("group-in-data-dir");
		expect(out).not.toContain("group-in-home");
	});

	test("config set --global writes the data dir's config and leaves HOME's alone", async () => {
		const proc = runCli(["config", "set", "model", "chosen-by-user", "--global"]);
		const stderr = await new Response(proc.stderr).text();
		expect(await proc.exited, `stderr: ${stderr}`).toBe(0);

		const inDataDir = JSON.parse(
			await readFile(join(dataDir, "config.json"), "utf-8"),
		);
		expect(inDataDir.model).toBe("chosen-by-user");

		// The other half of the assertion, and the one that fails against the
		// old code: a write that lands in the wrong file looks identical to a
		// correct one from the caller's side.
		const inHome = JSON.parse(
			await readFile(join(fakeHome, ".mxd", "config.json"), "utf-8"),
		);
		expect(inHome.model).toBe("model-in-home");
	});

	test("with MXD_DATA_DIR unset it falls back to HOME/.mxd/config.json", async () => {
		// The control: the fallback still works, so the test above cannot pass
		// merely because HOME was ignored everywhere.
		const { MXD_DATA_DIR: _omit, ...env } = process.env;
		const proc = Bun.spawn(["bun", CLI_PATH, "config", "auth", "list"], {
			env: { ...env, HOME: fakeHome },
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = await new Response(proc.stderr).text();
		expect(await proc.exited, `stderr: ${stderr}`).toBe(0);
		expect(await new Response(proc.stdout).text()).toContain("group-in-home");
	});
});
