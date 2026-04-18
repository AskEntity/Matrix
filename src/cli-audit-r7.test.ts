/**
 * Audit R7 CLI regressions — P2.4, P2.6, P2.8.
 *
 * Each test spawns the CLI as a subprocess so it exercises the real
 * module-load path (same pattern as cli.test.ts). We use an ephemeral
 * HTTP server to stand in for the daemon where we need a real response
 * shape; we use an unbound port where we need to simulate "daemon
 * offline".
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = new URL("./cli.ts", import.meta.url).pathname;

// ── P2.4: schema mismatch — `mxd status` reads `body.root` but daemon
//          emits `rootNodeId`, so it always printed "No task tree." ──

describe("P2.4: CLI reads rootNodeId from daemon response", () => {
	let dataDir: string;
	let server: ReturnType<typeof Bun.serve> | null = null;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "mxd-r7-cli-"));
	});

	afterEach(async () => {
		server?.stop();
		server = null;
		await rm(dataDir, { recursive: true, force: true });
	});

	/** Fake daemon that serves the minimum endpoints `mxd status` hits. */
	function startFakeDaemon(body: {
		rootNodeId: string | null;
		nodes: Array<{
			id: string;
			title: string;
			status: string;
			parentId: string | null;
			branch: string | null;
			costUsd?: number;
		}>;
	}): string {
		const projectId = "proj1";
		server = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/projects") {
					return Response.json([
						{
							id: projectId,
							name: "fake",
							path: "/fake",
							pathExists: true,
						},
					]);
				}
				// CLI's resolveProject() calls GET /projects/:id to validate
				// the ID. Reply 200 so the CLI proceeds to the tasks endpoint.
				if (url.pathname === `/projects/${projectId}`) {
					return Response.json({
						id: projectId,
						name: "fake",
						path: "/fake",
					});
				}
				if (url.pathname === `/api/matrix/projects/${projectId}/tasks`) {
					return Response.json(body);
				}
				return new Response("not found", { status: 404 });
			},
		});
		if (server.port === undefined) throw new Error("no port");
		return `http://localhost:${server.port}`;
	}

	test("`mxd status` prints the root task title (was 'No task tree.')", async () => {
		// Daemon wire format: `{rootNodeId, nodes}` — CLI used to read
		// `body.root` (non-existent field). Fix: look up node by rootNodeId.
		const daemonUrl = startFakeDaemon({
			rootNodeId: "root-id",
			nodes: [
				{
					id: "root-id",
					title: "My Root Task",
					status: "pending",
					parentId: null,
					branch: "main",
				},
				{
					id: "child-id",
					title: "Child Task",
					status: "in_progress",
					parentId: "root-id",
					branch: "feature/x",
				},
			],
		});

		const proc = Bun.spawn(["bun", CLI_PATH, "status", "proj1"], {
			env: {
				...process.env,
				MXD_DAEMON_URL: daemonUrl,
				MXD_DATA_DIR: dataDir,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const code = await proc.exited;
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();

		// The bug: old code printed "No task tree." because `body.root` was
		// undefined. Post-fix: the header with the root node title shows up.
		expect(code, `stderr: ${stderr}; stdout: ${stdout}`).toBe(0);
		expect(stdout).toContain("My Root Task");
		expect(stdout).toContain("Child Task");
		expect(stdout).not.toContain("No task tree.");
	});

	test("`mxd status` prints 'No task tree.' when rootNodeId is null", async () => {
		// Opposite direction: ensure the null branch still works. Prevents
		// an over-eager "always show something" fix from hiding the empty
		// state.
		const daemonUrl = startFakeDaemon({
			rootNodeId: null,
			nodes: [],
		});

		const proc = Bun.spawn(["bun", CLI_PATH, "status", "proj1"], {
			env: {
				...process.env,
				MXD_DAEMON_URL: daemonUrl,
				MXD_DATA_DIR: dataDir,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;
		const stdout = await new Response(proc.stdout).text();
		expect(stdout).toContain("No task tree.");
	});
});

// ── P2.8: CLI raw Bun stack trace when daemon is offline → friendly msg ──

describe("P2.8: CLI prints friendly message when daemon is unreachable", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "mxd-r7-offline-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	/**
	 * Find a port with high probability of being unbound. We bind/release
	 * port 0 to get a free port, then return that number — the kernel
	 * won't immediately rebind it.
	 */
	function findFreePort(): number {
		const s = Bun.serve({ port: 0, fetch: () => new Response() });
		const p = s.port;
		s.stop();
		if (p === undefined) throw new Error("no port");
		return p;
	}

	test("ECONNREFUSED → exit 1 + 'Daemon is not reachable'", async () => {
		const unboundPort = findFreePort();
		const daemonUrl = `http://localhost:${unboundPort}`;

		const proc = Bun.spawn(["bun", CLI_PATH, "list"], {
			env: {
				...process.env,
				MXD_DAEMON_URL: daemonUrl,
				MXD_DATA_DIR: dataDir,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const code = await proc.exited;
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();

		expect(code).toBe(1);
		// Friendly message — not a raw Bun stack trace.
		expect(stderr).toContain("Daemon is not reachable");
		expect(stderr).toContain(daemonUrl);
		// Regression guard: no raw TypeError or stack trace leaks.
		expect(stderr).not.toContain("TypeError:");
		expect(stderr).not.toContain("at fetch");
		expect(stdout).toBe("");
	});
});

// ── P2.6: `mxd init <nonexistent>` must fail cleanly, not create dirs ──

describe("P2.6: `mxd init` rejects nonexistent path", () => {
	let workDir: string;
	let dataDir: string;

	beforeEach(async () => {
		workDir = await mkdtemp(join(tmpdir(), "mxd-r7-initpath-"));
		dataDir = join(workDir, "data");
	});

	afterEach(async () => {
		await rm(workDir, { recursive: true, force: true });
	});

	test("nonexistent path → exit 1 + clear error + does NOT mkdir", async () => {
		// Target: a deep path under workDir that no ancestor has created.
		// Previously `pm.init` accepted any path and the plugin's
		// `mkdir({recursive: true})` silently built the tree, leaving a
		// ghost project the user never asked for.
		const ghostPath = join(workDir, "does", "not", "exist");
		expect(existsSync(ghostPath)).toBe(false);

		// Point at an unbound port so we don't need a real daemon — the
		// CLI call only reaches the daemon if the path check passes.
		// Actually, the check is server-side; we spin a minimal daemon
		// through the normal create path to prove the rejection happens
		// end-to-end.
		const { createDaemon } = await import("./daemon.ts");
		const { mkdir, writeFile } = await import("node:fs/promises");
		const { DEFAULT_CONFIG, saveGlobalConfig } = await import("./config.ts");

		await mkdir(dataDir, { recursive: true });
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));

		// Register a minimal plugin so worker boot doesn't need matrix runtime
		const installRoot = join(workDir, "fake-install");
		await mkdir(join(installRoot, ".mxd", "plugin"), { recursive: true });
		await writeFile(
			join(installRoot, ".mxd", "plugin", "index.ts"),
			`export default { name: "matrix-r7", scope: "global" };`,
			"utf-8",
		);

		const daemon = await createDaemon({
			dataDir,
			autoRegisterSelf: false,
			installRoot,
		});
		const server = Bun.serve({ port: 0, fetch: daemon.fetch });
		const port = server.port;
		if (port === undefined) throw new Error("no port");

		try {
			const proc = Bun.spawn(["bun", CLI_PATH, "init", ghostPath], {
				env: {
					...process.env,
					MXD_DAEMON_URL: `http://localhost:${port}`,
					MXD_DATA_DIR: dataDir,
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const code = await proc.exited;
			const stdout = await new Response(proc.stdout).text();
			const stderr = await new Response(proc.stderr).text();

			expect(code, `stdout: ${stdout}; stderr: ${stderr}`).not.toBe(0);
			const combined = `${stdout}\n${stderr}`;
			expect(combined).toMatch(/does not exist|Path does not exist/i);

			// Critical: the ghost directory was NOT created. This is the
			// user-visible symptom of the bug — a typo silently builds a
			// project tree under the wrong path.
			expect(existsSync(ghostPath)).toBe(false);
		} finally {
			server.stop();
			await daemon.shutdown();
		}
	});
});
