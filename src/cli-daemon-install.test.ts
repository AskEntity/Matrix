/**
 * `mxd daemon install` writes a launchd plist that must describe the SAME
 * matrix the installing shell was using. The data dir decides all of it —
 * `projects.json`, `config.json`, `auth.json`, `tasks/*.jsonl` — so a plist
 * that does not name it installs a service on `~/.mxd` no matter where the
 * installer was pointed:
 *
 *   export MXD_DATA_DIR=/data/mxd
 *   mxd init .            # project registered in /data/mxd/projects.json
 *   mxd daemon install    # daemon runs on ~/.mxd
 *
 * The user's own projects are then invisible to their own service, and the
 * jwtSecret the CLI signs with lives in a different auth.json than the one the
 * daemon verifies against — the UI says "not logged in" and neither side
 * reports anything.
 *
 * The path is BAKED, not forwarded: the absolute path the CLI resolved is
 * written into the plist, so what the service runs on cannot depend on what
 * launchd happens to hold in its environment at login. The discriminating test
 * is the one with no `MXD_DATA_DIR` in the shell at all — a forwarding
 * implementation emits nothing there, a baking one emits the resolved default.
 *
 * Everything runs against a temp HOME with a stub `launchctl` earlier on PATH,
 * so no test ever writes to the real `~/Library/LaunchAgents` or talks to the
 * real launchd.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAuthInitialized } from "./auth.ts";
import {
	DEFAULT_CONFIG,
	loadGlobalConfig,
	saveGlobalConfig,
} from "./config.ts";
import { createDaemon } from "./daemon.ts";
import { withAuth } from "./test-utils/auth-helper.ts";

const CLI_PATH = new URL("./cli.ts", import.meta.url).pathname;

interface Env {
	tempDir: string;
	/** Stands in for the user's home — the plist is written under it. */
	home: string;
	/** Earlier on PATH than the real launchctl. */
	stubBin: string;
	/** The custom data dir an installing shell would have exported. */
	dataDir: string;
}

/** A stub `launchctl`: `list` reports "not loaded", everything else succeeds. */
async function setupEnv(prefix: string): Promise<Env> {
	const tempDir = await mkdtemp(join(tmpdir(), prefix));
	const env: Env = {
		tempDir,
		home: join(tempDir, "home"),
		stubBin: join(tempDir, "bin"),
		dataDir: join(tempDir, "custom-data"),
	};
	await mkdir(env.home, { recursive: true });
	await mkdir(env.stubBin, { recursive: true });
	await mkdir(env.dataDir, { recursive: true });
	await writeFile(
		join(env.stubBin, "launchctl"),
		'#!/bin/sh\necho "$@" >> "$LAUNCHCTL_LOG"\ncase "$1" in\n  list) exit 1 ;;\n  *) exit 0 ;;\nesac\n',
		{ mode: 0o755 },
	);
	return env;
}

interface InstallResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	plist: string;
	/** Everything the stub launchctl was asked to do, one invocation per line. */
	launchctl: string;
}

/**
 * Run `mxd daemon install` as a real subprocess against the temp HOME.
 *
 * `dataDir: undefined` means "the shell has no MXD_DATA_DIR" and DELETES the
 * variable rather than leaving it inherited — otherwise whether this test can
 * fail would depend on whose shell ran it.
 */
async function runInstall(
	env: Env,
	opts: { dataDir?: string } = {},
): Promise<InstallResult> {
	const launchctlLog = join(env.stubBin, "invocations.log");
	const childEnv: Record<string, string> = {
		...(process.env as Record<string, string>),
		HOME: env.home,
		PATH: `${env.stubBin}:${process.env.PATH}`,
		LAUNCHCTL_LOG: launchctlLog,
	};
	if ("dataDir" in opts && opts.dataDir === undefined)
		delete childEnv.MXD_DATA_DIR;
	else childEnv.MXD_DATA_DIR = opts.dataDir ?? env.dataDir;

	const proc = Bun.spawn(["bun", CLI_PATH, "daemon", "install"], {
		env: childEnv,
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();

	const plistPath = join(
		env.home,
		"Library",
		"LaunchAgents",
		"dev.matrix.daemon.plist",
	);
	const plist =
		exitCode === 0 ? await readFile(plistPath, "utf-8") : "<not written>";
	let launchctl = "";
	try {
		launchctl = await readFile(launchctlLog, "utf-8");
	} catch {
		/* the stub never ran */
	}
	return { exitCode, stdout, stderr, plist, launchctl };
}

/**
 * The RAW text of an `EnvironmentVariables` entry — escaping included, because
 * one of the tests below is about the escaping.
 */
function plistEnvRaw(plist: string, key: string): string | undefined {
	const m = plist.match(
		new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`),
	);
	return m?.[1];
}

function unescapeXml(value: string): string {
	return value
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

async function jwtSecretOf(dir: string): Promise<string> {
	const raw = JSON.parse(await readFile(join(dir, "auth.json"), "utf-8")) as {
		jwtSecret: string;
	};
	return raw.jwtSecret;
}

describe("mxd daemon install: the plist bakes the data dir the CLI resolved", () => {
	let env: Env;
	beforeEach(async () => {
		env = await setupEnv("mxd-daemon-install-");
	});
	afterEach(async () => {
		await rm(env.tempDir, { recursive: true, force: true });
	});

	test("bakes the MXD_DATA_DIR the installing shell was using", async () => {
		const r = await runInstall(env);
		expect(r.exitCode, `stderr: ${r.stderr}`).toBe(0);

		expect(plistEnvRaw(r.plist, "MXD_DATA_DIR")).toBe(env.dataDir);
		// The plist really was handed to launchctl — without this the test
		// could be asserting about a file the install path wrote and abandoned.
		expect(r.launchctl).toContain("load");
	});

	test("bakes the resolved default when the shell has no MXD_DATA_DIR", async () => {
		// THE discriminating case. Forwarding `process.env.MXD_DATA_DIR` skips
		// an unset variable, so a forwarding implementation emits no entry at
		// all here — this assertion is the one that goes red on it.
		const r = await runInstall(env, { dataDir: undefined });
		expect(r.exitCode, `stderr: ${r.stderr}`).toBe(0);

		expect(plistEnvRaw(r.plist, "MXD_DATA_DIR")).toBe(join(env.home, ".mxd"));
	});

	test("PATH and HOME are still forwarded from the installing shell", async () => {
		// The baked entry is an addition, not a replacement: launchd's login
		// environment has neither the user's PATH nor their HOME, and the
		// daemon shells out to git.
		const r = await runInstall(env);
		expect(r.exitCode, `stderr: ${r.stderr}`).toBe(0);

		expect(plistEnvRaw(r.plist, "HOME")).toBe(env.home);
		expect(plistEnvRaw(r.plist, "PATH")).toContain(env.stubBin);
	});

	test("an `&` in the data dir is escaped, so the plist stays parseable", async () => {
		// The baked value is user-supplied and lands inside an XML document.
		// Unescaped, launchd cannot read the plist at all — and that failure
		// arrives at login, not at install.
		const ampDir = join(env.tempDir, "a&b-data");
		await mkdir(ampDir, { recursive: true });

		const r = await runInstall(env, { dataDir: ampDir });
		expect(r.exitCode, `stderr: ${r.stderr}`).toBe(0);

		const raw = plistEnvRaw(r.plist, "MXD_DATA_DIR");
		expect(raw).toBe(ampDir.replace(/&/g, "&amp;"));
		expect(unescapeXml(raw ?? "")).toBe(ampDir);
		// The log paths are built from the same value and live in the same
		// document — escaping one and not the other leaves the plist just as
		// unparseable.
		expect(r.plist).toContain(
			`${join(ampDir, "logs").replace(/&/g, "&amp;")}/daemon.log`,
		);
	});
});

describe("mxd daemon install: what it prints is what it installed", () => {
	let env: Env;
	beforeEach(async () => {
		env = await setupEnv("mxd-daemon-install-print-");
	});
	afterEach(async () => {
		await rm(env.tempDir, { recursive: true, force: true });
	});

	test("prints the data dir it baked in", async () => {
		// The plist lives in ~/Library/LaunchAgents. This line is the only
		// place the user will ever see which data dir their service runs on.
		const r = await runInstall(env);
		expect(r.exitCode, `stderr: ${r.stderr}`).toBe(0);

		expect(r.stdout).toContain(`Data:  ${env.dataDir}`);
		// Printed and baked cannot drift: asserted against each other rather
		// than each against a literal.
		expect(plistEnvRaw(r.plist, "MXD_DATA_DIR")).toBe(
			r.stdout.match(/^ {2}Data: {2}(.+)$/m)?.[1],
		);
	});

	test("the printed port is the port the installed daemon will read", async () => {
		// The visible symptom this closes. The CLI honestly reports the port
		// from the config IT read — under a custom data dir that used to be a
		// different file than the daemon's, so the URL could name a port
		// nothing would be listening on.
		await saveGlobalConfig(
			{ ...DEFAULT_CONFIG, port: 12345 },
			join(env.dataDir, "config.json"),
		);
		// A DIFFERENT port in the dir a non-baking plist sends the daemon to,
		// so a wrong bake produces a wrong number rather than an ENOENT default
		// that happens to agree.
		await saveGlobalConfig(
			{ ...DEFAULT_CONFIG, port: 7777 },
			join(env.home, ".mxd", "config.json"),
		);

		const r = await runInstall(env);
		expect(r.exitCode, `stderr: ${r.stderr}`).toBe(0);
		expect(r.stdout).toContain("URL:   http://localhost:12345");

		// Read the config the INSTALLED daemon will read, through the daemon's
		// own loader, from the path the plist names.
		const baked = plistEnvRaw(r.plist, "MXD_DATA_DIR");
		const installed = await loadGlobalConfig(join(baked ?? "", "config.json"));
		expect(installed.port).toBe(12345);
	});
});

describe("mxd daemon install: the installed daemon accepts the CLI's token", () => {
	let env: Env;
	beforeEach(async () => {
		env = await setupEnv("mxd-daemon-install-auth-");
	});
	afterEach(async () => {
		await rm(env.tempDir, { recursive: true, force: true });
	});

	test("a token the CLI signed is accepted by a daemon on the baked dir and rejected by one on ~/.mxd", async () => {
		// End to end, in the shape a user reports it: they run
		// `mxd auth <pubkey>`, paste the token into the UI, and the UI says
		// they are not logged in. That is two auth.json files with two
		// jwtSecrets, and the plist decides which one the service reads.
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
		const pubKeyBase64 = Buffer.from(spki).toString("base64");

		// 1. The real CLI mints a session token against the custom data dir.
		const authProc = Bun.spawn(["bun", CLI_PATH, "auth", pubKeyBase64], {
			env: { ...process.env, MXD_DATA_DIR: env.dataDir, HOME: env.home },
			stdout: "pipe",
			stderr: "pipe",
		});
		const authCode = await authProc.exited;
		const encrypted = (await new Response(authProc.stdout).text()).trim();
		expect(
			authCode,
			`stderr: ${await new Response(authProc.stderr).text()}`,
		).toBe(0);
		const sessionToken = new TextDecoder().decode(
			await crypto.subtle.decrypt(
				{ name: "RSA-OAEP" },
				kp.privateKey,
				Buffer.from(encrypted, "base64"),
			),
		);
		expect(sessionToken.split(".").length).toBe(3);

		// 2. Install, and take the data dir FROM THE PLIST rather than from
		//    the variable we set — the plist is the thing under test.
		const r = await runInstall(env);
		expect(r.exitCode, `stderr: ${r.stderr}`).toBe(0);
		const baked = plistEnvRaw(r.plist, "MXD_DATA_DIR");
		expect(baked).toBe(env.dataDir);

		// 3. Give the dir a non-baking plist would have used its own
		//    secret. Asserting the two DIFFER is what makes the negative
		//    control below able to fail at all.
		const fallbackDir = join(env.home, ".mxd");
		await ensureAuthInitialized(join(fallbackDir, "auth.json"));
		expect(await jwtSecretOf(fallbackDir)).not.toBe(
			await jwtSecretOf(env.dataDir),
		);
		await saveGlobalConfig(
			{ ...DEFAULT_CONFIG },
			join(fallbackDir, "config.json"),
		);

		// 4. The daemon the plist describes accepts the token.
		const installed = await createDaemon({
			dataDir: baked ?? "",
			autoRegisterSelf: false,
		});
		try {
			const res = await installed.fetch(
				new Request("http://localhost/projects", {
					headers: withAuth(sessionToken),
				}),
			);
			expect(res.status).toBe(200);
		} finally {
			await installed.shutdown();
		}

		// 5. Negative control: the daemon a non-baking plist would have
		//    started rejects the very same token. That 401 is the bug, and
		//    it is exactly what the user sees.
		const onFallback = await createDaemon({
			dataDir: fallbackDir,
			autoRegisterSelf: false,
		});
		try {
			const res = await onFallback.fetch(
				new Request("http://localhost/projects", {
					headers: withAuth(sessionToken),
				}),
			);
			expect(res.status).toBe(401);
		} finally {
			await onFallback.shutdown();
		}
	}, 60_000);
});
