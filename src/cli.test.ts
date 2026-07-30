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
import { existsSync, realpathSync, symlinkSync } from "node:fs";
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
		const proc = runCli([
			"config",
			"set",
			"model",
			"chosen-by-user",
			"--global",
		]);
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

/**
 * The CLI talks to the port the daemon actually listens on.
 *
 * `DAEMON_URL` was `process.env.MXD_DAEMON_URL ?? "http://localhost:7433"`, and
 * the daemon listens on `globalConfig.port` — a field the Settings UI exposes
 * with 7433 as its PLACEHOLDER, i.e. explicitly a value the user may change. So
 * a user who changed it lost every CLI command to `Daemon is not reachable at
 * http://localhost:7433`: true, useless, and unfalsifiable from outside.
 *
 * ⚠️ `MXD_DAEMON_URL` is NOT the defect and must keep winning — it is the test
 * seam, and the way to reach a remote daemon. The defect was the hardcoded
 * fallback UNDER it. An explicit override losing to nothing is fine; a default
 * that overrides config is the bug.
 *
 * The same resolved port is what `mxd daemon install` prints. That line cannot
 * be tested (it calls launchctl against the real launchd), so it takes the value
 * from the same constant these tests pin rather than computing its own.
 */
describe("cli: the daemon URL comes from the configured port", () => {
	let dataDir: string;
	let fakeHome: string;
	let server: ReturnType<typeof Bun.serve> | null = null;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "mxd-cli-port-data-"));
		fakeHome = await mkdtemp(join(tmpdir(), "mxd-cli-port-home-"));
	});

	afterEach(async () => {
		server?.stop();
		server = null;
		await rm(dataDir, { recursive: true, force: true });
		await rm(fakeHome, { recursive: true, force: true });
	});

	/** Write a complete global config carrying `port` into the data dir. */
	async function writeConfigWithPort(port: number) {
		await writeFile(
			join(dataDir, "config.json"),
			JSON.stringify({
				authGroups: {},
				defaultAuth: "",
				model: "",
				budgetUsd: -1,
				mcpServers: {},
				port,
				selfBootstrap: false,
				thinkingEffort: 0,
				cacheTtl: { root: "1h", child: "5m" },
			}),
		);
	}

	/** A daemon on an ephemeral port that records the paths it is asked for. */
	function startFakeDaemon(): { port: number; paths: string[] } {
		const paths: string[] = [];
		const s = Bun.serve({
			port: 0,
			fetch(req) {
				paths.push(new URL(req.url).pathname);
				return Response.json([]);
			},
		});
		server = s;
		if (s.port == null) throw new Error("fake daemon got no port");
		return { port: s.port, paths };
	}

	function runCli(args: string[], env: Record<string, string | undefined>) {
		const { MXD_DAEMON_URL: _drop, ...rest } = process.env;
		return Bun.spawn(["bun", CLI_PATH, ...args], {
			env: { ...rest, MXD_DATA_DIR: dataDir, HOME: fakeHome, ...env },
			stdout: "pipe",
			stderr: "pipe",
		});
	}

	test("with no MXD_DAEMON_URL, the CLI reaches the port in config", async () => {
		const { port, paths } = startFakeDaemon();
		await writeConfigWithPort(port);

		const proc = runCli(["list"], {});
		const stderr = await new Response(proc.stderr).text();
		expect(await proc.exited, `stderr: ${stderr}`).toBe(0);

		// The whole claim: a request arrived at the configured port. Nothing is
		// listening on 7433 in this test's world, so a CLI still hardcoding it
		// cannot produce this.
		expect(paths).toContain("/projects");
	});

	test("MXD_DAEMON_URL still wins over the configured port", async () => {
		const { port, paths } = startFakeDaemon();
		// Config points somewhere dead; the override points at the live server.
		await writeConfigWithPort(1);

		const proc = runCli(["list"], {
			MXD_DAEMON_URL: `http://localhost:${port}`,
		});
		const stderr = await new Response(proc.stderr).text();
		expect(await proc.exited, `stderr: ${stderr}`).toBe(0);
		expect(paths).toContain("/projects");
	});

	test("the unreachable message names the configured port, not 7433", async () => {
		// The reported symptom was a URL the user could not act on. Port 1 is
		// privileged and unbound, so the connection fails for a real reason.
		await writeConfigWithPort(1);

		const proc = runCli(["list"], {});
		expect(await proc.exited).toBe(1);
		const stderr = await new Response(proc.stderr).text();
		expect(stderr).toContain("http://localhost:1");
		expect(stderr).not.toContain("7433");
	});

	test("no hardcoded daemon port, and no PORT env read, survives in cli.ts", async () => {
		// A source assertion because the two sites that held these are different
		// KINDS of line — a module constant and a console.log — and only one of
		// them is reachable from a test at all. `process.env.PORT` was read by
		// `daemon daemon install`'s printed URL and by nothing else in the repo:
		// the daemon has never read it, so the line reported a port that no
		// configuration could produce.
		//
		// Collect the OFFENDING LINES rather than asserting on the file text: a
		// failing `expect(wholeFile).not.toContain(…)` prints all 1600 lines of
		// cli.ts into the log, which is how one assertion elsewhere in this repo
		// produced a 227MB run.
		const src = await readFile(
			new URL("./cli.ts", import.meta.url).pathname,
			"utf-8",
		);
		// Comment-opening lines are skipped for the same reason the data-dir
		// audit in `data-paths.test.ts` skips them: the fix's own comments quote
		// the deleted expression, so a source audit written in the same commit as
		// its fix will always match the explanation of that fix. Third time
		// tonight — it is the rule here, not the exception.
		const offenders = src
			.split("\n")
			.map((line, i) => ({ line, n: i + 1 }))
			.filter(({ line }) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
			.filter(({ line }) => /7433|process\.env\.PORT\b/.test(line))
			.map(({ line, n }) => `${n}: ${line.trim()}`);
		expect(offenders).toEqual([]);
	});
});

/**
 * A project is found by WHICH DIRECTORY a path names, not by how it is spelled.
 *
 * `resolveCurrentProject` compared `process.cwd()` against each registered path
 * as a STRING, and `resolveProject` did the same for an explicit path argument.
 * `process.cwd()` is always the physical path, while a registered path is
 * whatever was typed — so a project registered through a symlink (on macOS
 * every `/tmp/...` is one) answered "No project found for current directory"
 * from inside its own directory.
 *
 * ⚠️ memory recorded only the TEST-side workaround for this ("wrap fixture paths
 * in realpathSync") — `cli-audit-r7-p2_2.test.ts` still carries the comment
 * explaining that production string-compares. Once a problem is routed around in
 * the tests, nobody looks at the production half again. Both doors are fixed
 * here; that comment is corrected in the same commit.
 */
describe("cli: a project is found through a symlinked path", () => {
	let root: string;
	let realDir: string;
	let linkDir: string;
	let dataDir: string;
	let server: ReturnType<typeof Bun.serve> | null = null;
	const PROJECT_ID = "01SYMLINKPROJECT0000000000";

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "mxd-cli-link-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-cli-link-data-"));
		realDir = join(root, "real");
		linkDir = join(root, "link");
		await mkdir(realDir, { recursive: true });
		// An EXPLICIT symlink rather than relying on macOS's /tmp → /private/tmp:
		// on Linux /tmp is a real directory, so a platform-borrowed symlink makes
		// this a fixture that cannot express the difference — it would pass
		// against the broken code by testing nothing.
		symlinkSync(realDir, linkDir);
	});

	afterEach(async () => {
		server?.stop();
		server = null;
		await rm(root, { recursive: true, force: true });
		await rm(dataDir, { recursive: true, force: true });
	});

	/**
	 * A daemon holding ONE project, registered at `registeredPath`. Records
	 * every path asked for, so the test can see the resolution succeed.
	 */
	function startFakeDaemon(registeredPath: string): { paths: string[] } {
		const paths: string[] = [];
		server = Bun.serve({
			port: 0,
			fetch(req) {
				const { pathname } = new URL(req.url);
				paths.push(pathname);
				if (pathname === "/projects") {
					return Response.json([
						{ id: PROJECT_ID, name: "linked", path: registeredPath },
					]);
				}
				if (pathname.endsWith("/tasks")) {
					return Response.json({ rootNodeId: null, nodes: [] });
				}
				// Everything else 404s — in particular `GET /projects/<a path>`,
				// which is how `resolveProject` probes the argument as an ID
				// before trying it as a path.
				return new Response("nope", { status: 404 });
			},
		});
		if (server.port == null) throw new Error("fake daemon got no port");
		return { paths };
	}

	function runCli(args: string[], cwd: string) {
		return Bun.spawn(["bun", CLI_PATH, ...args], {
			cwd,
			env: {
				...process.env,
				MXD_DATA_DIR: dataDir,
				MXD_DAEMON_URL: `http://localhost:${server?.port}`,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
	}

	test("the fixture's symlink really differs from its target", () => {
		// The positive control. If these were equal the two tests below would
		// pass against string comparison and prove nothing.
		expect(realpathSync(linkDir)).toBe(realpathSync(realDir));
		expect(realpathSync(linkDir)).not.toBe(linkDir);
	});

	test("cwd inside the symlink finds a project registered at the symlink", async () => {
		// The reported bug. `process.cwd()` comes back as `.../real`, the
		// registry says `.../link`.
		const { paths } = startFakeDaemon(linkDir);
		const proc = runCli(["tasks"], linkDir);
		const stderr = await new Response(proc.stderr).text();
		expect(await proc.exited, `stderr: ${stderr}`).toBe(0);
		expect(stderr).not.toContain("No project found");
		expect(paths).toContain(`/api/matrix/projects/${PROJECT_ID}/tasks`);
	});

	test("cwd in a SUBDIRECTORY of the symlink finds it too", async () => {
		// The prefix branch of the same comparison — `cwd.startsWith(path + "/")`
		// — which is the one an agent working in a subdir actually hits.
		const { paths } = startFakeDaemon(linkDir);
		const sub = join(linkDir, "nested", "deeper");
		await mkdir(sub, { recursive: true });
		const proc = runCli(["tasks"], sub);
		const stderr = await new Response(proc.stderr).text();
		expect(await proc.exited, `stderr: ${stderr}`).toBe(0);
		expect(paths).toContain(`/api/matrix/projects/${PROJECT_ID}/tasks`);
	});

	test("an explicit path argument matches the same project spelled either way", async () => {
		// The second door: `mxd tasks <path>`. Registered physical, asked for by
		// the symlink — the mirror of the case above, and it used to answer
		// "Project not found: <path>".
		const { paths } = startFakeDaemon(realpathSync(realDir));
		const proc = runCli(["tasks", linkDir], root);
		const stderr = await new Response(proc.stderr).text();
		expect(await proc.exited, `stderr: ${stderr}`).toBe(0);
		expect(stderr).not.toContain("Project not found");
		expect(paths).toContain(`/api/matrix/projects/${PROJECT_ID}/tasks`);
	});

	test("a path that is not a project is still refused", async () => {
		// The control on the other side: realpath must not make everything
		// match. `root` is the symlink's PARENT, which is not the project.
		startFakeDaemon(linkDir);
		const proc = runCli(["tasks", root], root);
		expect(await proc.exited).toBe(1);
		expect(await new Response(proc.stderr).text()).toContain(
			"Project not found",
		);
	});
});
