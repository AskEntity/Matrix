/**
 * Audit R7 P2.1 — `mxd config auth add` auto-promotes first group.
 *
 * Fresh users run `mxd config auth add anthropic --key sk-ant-...` and
 * expect the next `mxd send` to work. Before this fix, `auth add` only
 * wrote the authGroups entry; `defaultAuth` stayed `""` and provider
 * resolution threw "No auth group configured". README implies `auth add`
 * is the one-command fix — so the command now fills in defaultAuth when
 * it's unset, and leaves it alone when the user has already picked one.
 *
 * Spawning the CLI as a subprocess is deliberate: it exercises the real
 * module-load path (argv parse, env read, config load) the way a user
 * runs it. Unit-testing a helper would miss env-variable plumbing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "./config.ts";

const CLI_PATH = new URL("./cli.ts", import.meta.url).pathname;

describe("P2.1: `mxd config auth add` auto-promotes first group to defaultAuth", () => {
	// The CLI's `loadGlobalConfig()` reads `homedir()/.mxd/config.json`.
	// To isolate test runs, we override HOME so `homedir()` returns
	// `fakeHome`, placing the config at `fakeHome/.mxd/config.json`.
	let fakeHome: string;
	let configPath: string;
	let mxdDir: string;

	beforeEach(async () => {
		fakeHome = await mkdtemp(join(tmpdir(), "mxd-p21-"));
		mxdDir = join(fakeHome, ".mxd");
		configPath = join(mxdDir, "config.json");
		await mkdir(mxdDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(fakeHome, { recursive: true, force: true });
	});

	/** Write a config.json with the supplied overrides on top of DEFAULT_CONFIG. */
	async function seedConfig(overrides: Record<string, unknown>): Promise<void> {
		const cfg = { ...DEFAULT_CONFIG, ...overrides };
		await writeFile(configPath, JSON.stringify(cfg, null, "\t"), "utf-8");
	}

	/** Spawn `mxd config auth add …`. Returns stdout/stderr/exitCode. */
	async function runAuthAdd(...args: string[]): Promise<{
		code: number;
		stdout: string;
		stderr: string;
	}> {
		const { MXD_DATA_DIR: _omit, ...env } = process.env;
		const proc = Bun.spawn(
			["bun", CLI_PATH, "config", "auth", "add", ...args],
			{
				env: { ...env, HOME: fakeHome },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const code = await proc.exited;
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		return { code, stdout, stderr };
	}

	test("fresh config → `auth add anthropic …` sets defaultAuth=anthropic", async () => {
		// Baseline: DEFAULT_CONFIG has `defaultAuth: ""` and no authGroups.
		// Before the fix, the add would leave defaultAuth="" → provider
		// resolution fails at first agent call. Fix: auto-promote on empty.
		await seedConfig({ defaultAuth: "", authGroups: {} });

		const { code, stdout, stderr } = await runAuthAdd(
			"anthropic",
			"--provider",
			"anthropic",
			"--key",
			"sk-ant-test-123",
		);
		expect(code, `stdout: ${stdout}; stderr: ${stderr}`).toBe(0);

		// The confirmation string is the user-visible signal that the
		// promote happened. "Set as default." is the copy promised in
		// the task spec.
		expect(stdout.toLowerCase()).toContain("set as default");

		// On-disk state is the authoritative signal: defaultAuth is now
		// "anthropic" and the group is present.
		const written = JSON.parse(await readFile(configPath, "utf-8"));
		expect(written.defaultAuth).toBe("anthropic");
		expect(written.authGroups.anthropic).toEqual({
			provider: "anthropic",
			apiKey: "sk-ant-test-123",
		});
	});

	test("existing defaultAuth=openai → `auth add anthropic …` does NOT clobber defaultAuth", async () => {
		// User already has an openai group set as default. Adding a
		// second provider must NOT silently repoint the default — the
		// command's job is to record credentials, not reassign intent.
		await seedConfig({
			defaultAuth: "openai",
			authGroups: {
				openai: { provider: "openai", apiKey: "sk-openai-existing" },
			},
		});

		const { code, stdout, stderr } = await runAuthAdd(
			"anthropic",
			"--provider",
			"anthropic",
			"--key",
			"sk-ant-test-456",
		);
		expect(code, `stdout: ${stdout}; stderr: ${stderr}`).toBe(0);

		// Output should mention the existing default and point the
		// user at the switch command.
		expect(stdout).toContain("openai");
		expect(stdout).toMatch(/switch|defaultAuth/i);

		const written = JSON.parse(await readFile(configPath, "utf-8"));
		expect(written.defaultAuth).toBe("openai"); // unchanged
		// Both groups are now present.
		expect(written.authGroups.openai).toEqual({
			provider: "openai",
			apiKey: "sk-openai-existing",
		});
		expect(written.authGroups.anthropic).toEqual({
			provider: "anthropic",
			apiKey: "sk-ant-test-456",
		});
	});

	test("mutation proof: reverting the auto-promote line breaks test 1", async () => {
		// If a future edit removes `cfg.defaultAuth = name;` when
		// priorDefault is empty, the on-disk defaultAuth would remain
		// "" after the add. This test pins the exact invariant test 1
		// relies on — auto-promote is load-bearing for fresh users.
		await seedConfig({ defaultAuth: "", authGroups: {} });

		await runAuthAdd(
			"anthropic",
			"--provider",
			"anthropic",
			"--key",
			"sk-ant-mutation-proof",
		);

		const written = JSON.parse(await readFile(configPath, "utf-8"));
		// NOT "" — the whole point of P2.1 is this stops being the
		// empty string after a single add.
		expect(written.defaultAuth).not.toBe("");
		// AND it's the name that was just added — not some other value
		// a "clever" fix might have chosen.
		expect(written.defaultAuth).toBe("anthropic");
	});
});
