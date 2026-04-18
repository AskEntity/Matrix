/**
 * Audit R7 P2.13 — Port-conflict probe must work under auth.
 *
 * Before: the production entry `await fetch(\`http://localhost:\${port}/health\`)`
 * hit the auth middleware. With auth enabled, `/health` returned 401 →
 * `res.ok === false` → the probe concluded "nothing listening" → `Bun.serve`
 * → EADDRINUSE and a raw Bun stack trace.
 *
 * After: probe `/auth/status`. That route is on SKIP_EXACT and replies 200
 * regardless of auth state. Any successful response (and any response at all,
 * really) means "something IS listening" — triggers the clean "already
 * running" exit.
 *
 * This test doesn't spawn two real daemons (too heavy for a unit test;
 * platform port choices are flaky). Instead it verifies the routing
 * invariant the fix depends on: `/auth/status` responds 200 without a token,
 * `/health` responds 401 without one. If either of those changes, P2.13's
 * fix breaks and this test fails.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, saveGlobalConfig } from "./config.ts";
import { createDaemon, type DaemonInstance } from "./daemon.ts";

describe("P2.13: port-conflict probe endpoint invariants", () => {
	let tempDir: string;
	let dataDir: string;
	let daemon: DaemonInstance;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-r7-portprobe-"));
		dataDir = join(tempDir, "data");
		await mkdir(dataDir, { recursive: true });
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));

		// autoInitAuth: true is the important bit — this writes jwtSecret
		// into auth.json so the auth middleware is active. If we probed a
		// production-flavored daemon, this is what we'd be up against.
		daemon = await createDaemon({
			dataDir,
			autoInitAuth: true,
			autoRegisterSelf: false,
		});
	});

	afterAll(async () => {
		await daemon?.shutdown();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("/auth/status is reachable without a token (200) — the probe path works", async () => {
		const res = await daemon.fetch(new Request("http://localhost/auth/status"));
		// 200 means SKIP_EXACT is honoring /auth/status — the invariant
		// P2.13 depends on. If this changes (someone adds auth to /auth/status),
		// the port-conflict probe breaks again.
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			enabled: boolean;
			authenticated: boolean;
		};
		expect(body.enabled).toBe(true);
	});

	test("/health is 401 without a token — confirms the old probe was broken", async () => {
		const res = await daemon.fetch(new Request("http://localhost/health"));
		// This test pins WHY the fix was needed: /health + auth-enabled daemon
		// = 401, and the old probe treated 401 as "nothing listening".
		expect(res.status).toBe(401);
	});

	test("production-entry probe logic: non-zero response status ⇒ 'already running'", async () => {
		// We replicate the exact predicate the production entry uses
		// (see `if (import.meta.main)` block in daemon.ts). A 200 from
		// /auth/status must trigger the "daemon already running" branch.
		const res = await daemon.fetch(new Request("http://localhost/auth/status"));
		// The fix's predicate: `res.status !== 0`. Any HTTP response at all
		// (2xx/4xx/5xx) means something is listening and we should surface
		// the friendly message instead of letting Bun.serve trip on
		// EADDRINUSE.
		expect(res.status).not.toBe(0);
		// For good measure, also cover the narrower "res.ok" path that
		// the old probe required — with auth enabled, /auth/status is ok,
		// /health was not. The fix widens the probe to auth/status.
		expect(res.ok).toBe(true);
	});
});

// ── E2E: spawn two real daemon processes on the same port ──
//
// The endpoint-invariant tests above prove WHY the fix is needed.
// This test proves the fix actually works end-to-end: the second
// daemon subprocess must see "daemon already running" and exit 1,
// NOT crash with an EADDRINUSE stack trace.

describe("P2.13 E2E: second daemon on same port with auth enabled", () => {
	const DAEMON_PATH = new URL("./daemon.ts", import.meta.url).pathname;

	test("second daemon exits cleanly with 'already running' message", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "mxd-r7-e2e-port-"));
		const dataDirA = join(tempDir, "a");
		const dataDirB = join(tempDir, "b");
		await mkdir(dataDirA, { recursive: true });
		await mkdir(dataDirB, { recursive: true });

		// Pick a free port. We use Bun.serve to claim+release — the port
		// is unlikely to be taken between here and the daemon spawn.
		const probe = Bun.serve({ port: 0, fetch: () => new Response() });
		const PORT = probe.port;
		probe.stop();
		if (PORT === undefined) throw new Error("no port");

		// Global config with the chosen port for BOTH daemons
		await saveGlobalConfig(
			{ ...DEFAULT_CONFIG, port: PORT },
			join(dataDirA, "config.json"),
		);
		await saveGlobalConfig(
			{ ...DEFAULT_CONFIG, port: PORT },
			join(dataDirB, "config.json"),
		);

		// First daemon: normal start. Auth auto-initializes (autoInitAuth
		// default true in production entry) — the exact scenario P2.13
		// was broken under.
		const procA = Bun.spawn(["bun", DAEMON_PATH], {
			env: {
				...process.env,
				MXD_DATA_DIR: dataDirA,
				MXD_BIND_HOST: "127.0.0.1",
			},
			stdout: "pipe",
			stderr: "pipe",
		});

		// Wait for the first daemon to come up. `mxd health` → /auth/status
		// (which replies 200 regardless of auth). We poll until listening.
		let up = false;
		for (let i = 0; i < 30; i++) {
			await new Promise((r) => setTimeout(r, 150));
			try {
				const r = await fetch(`http://localhost:${PORT}/auth/status`);
				if (r.ok) {
					up = true;
					break;
				}
			} catch {}
		}
		expect(up, "first daemon never came up").toBe(true);

		try {
			// Second daemon: same port. Should detect the first and exit 1.
			const procB = Bun.spawn(["bun", DAEMON_PATH], {
				env: {
					...process.env,
					MXD_DATA_DIR: dataDirB,
					MXD_BIND_HOST: "127.0.0.1",
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const code = await procB.exited;
			const stdout = await new Response(procB.stdout).text();
			const stderr = await new Response(procB.stderr).text();
			const combined = `${stdout}\n${stderr}`;

			expect(code, `combined: ${combined}`).toBe(1);
			expect(combined).toContain("already running");
			// Must NOT be an EADDRINUSE stack trace — that's the bug.
			expect(combined).not.toContain("EADDRINUSE");
			expect(combined).not.toContain("SyntaxError");
		} finally {
			procA.kill();
			await procA.exited;
			await rm(tempDir, { recursive: true, force: true });
		}
	}, 20_000);
});
