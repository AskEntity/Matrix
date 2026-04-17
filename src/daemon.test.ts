/**
 * Test: daemon pipeline — createDaemon discovers plugins, starts workers, proxies requests.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, saveGlobalConfig } from "./config.ts";
import { createDaemon, type DaemonInstance } from "./daemon.ts";

describe("daemon without plugins — bare daemon invariant", () => {
	// Invariant: delete .mxd/plugin/ entirely → daemon still starts.
	// Shell shows auth + selector, scope is empty, content shows "no plugin".
	let tempDir: string;
	let dataDir: string;
	let daemon: DaemonInstance;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "daemon-bare-test-"));
		dataDir = join(tempDir, ".mxd");
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));

		// No projects → no plugin directories → pure bare daemon
		daemon = await createDaemon({ dataDir, autoInitAuth: false });
	});

	afterAll(async () => {
		await daemon.shutdown();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("GET /health → 200 (daemon-owned, not worker-forwarded)", async () => {
		const res = await daemon.fetch(new Request("http://localhost/health"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("ok");
	});

	test("GET /plugins → 200, empty array", async () => {
		const res = await daemon.fetch(new Request("http://localhost/plugins"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual([]);
	});

	test("GET /auth/status → 200, authenticated (no secret)", async () => {
		const res = await daemon.fetch(new Request("http://localhost/auth/status"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.authenticated).toBe(true);
		expect(body.enabled).toBe(false);
	});

	test("GET /projects → 200, empty array", async () => {
		const res = await daemon.fetch(new Request("http://localhost/projects"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual([]);
	});

	test("unhandled routes return 503 with clear message (no worker)", async () => {
		const res = await daemon.fetch(
			new Request("http://localhost/some/worker/route"),
		);
		expect(res.status).toBe(503);
		const body = await res.json();
		expect(body.error).toContain("No global plugin");
	});
});

describe("daemon pipeline (legacy)", () => {
	let tempDir: string;
	let dataDir: string;
	let daemon: DaemonInstance;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "daemon-pipeline-test-"));
		dataDir = join(tempDir, ".mxd");
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));

		daemon = await createDaemon({ dataDir, autoInitAuth: false });
	});

	afterAll(async () => {
		await daemon.shutdown();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("auth/status returns authenticated when no secret", async () => {
		const res = await daemon.fetch(new Request("http://localhost/auth/status"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.authenticated).toBe(true);
		expect(body.enabled).toBe(false);
	});

	test("/plugins returns registered plugins", async () => {
		const res = await daemon.fetch(new Request("http://localhost/plugins"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(Array.isArray(body)).toBe(true);
		// No projects registered in temp dir → no plugins discovered
	});

	test("global config CRUD", async () => {
		// GET
		const getRes = await daemon.fetch(
			new Request("http://localhost/config/global"),
		);
		expect(getRes.status).toBe(200);
		const config = await getRes.json();
		expect(config.budgetUsd).toBe(-1);

		// PATCH
		const patchRes = await daemon.fetch(
			new Request("http://localhost/config/global", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ budgetUsd: 50 }),
			}),
		);
		expect(patchRes.status).toBe(200);
		const updated = await patchRes.json();
		expect(updated.budgetUsd).toBe(50);
	});

	test("POST /projects handled by daemon (not forwarded to worker)", async () => {
		const res = await daemon.fetch(
			new Request("http://localhost/projects", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path: "relative-path" }),
			}),
		);
		// Daemon handles project CRUD directly — returns 409 (relative path rejected by pm.init)
		expect(res.status).toBe(409);
	});
});

describe("daemon with matrix plugin", () => {
	let tempDir: string;
	let dataDir: string;
	let projectPath: string;
	let daemon: DaemonInstance;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "daemon-matrix-test-"));
		dataDir = join(tempDir, ".mxd");
		projectPath = join(tempDir, "test-project");

		// Create a project with a matrix-like plugin
		await mkdir(join(projectPath, ".mxd", "plugin"), { recursive: true });
		await writeFile(
			join(projectPath, ".mxd", "plugin", "index.ts"),
			`export default { name: "test-matrix", scope: "global" };`,
			"utf-8",
		);

		// Register the project in daemon's project manager
		await mkdir(join(dataDir, "projects"), { recursive: true });
		const projectId = "test-project-id";
		const projectsMeta = [
			{
				id: projectId,
				name: "test-project",
				path: projectPath,
				createdAt: new Date().toISOString(),
			},
		];
		await writeFile(
			join(dataDir, "projects.json"),
			JSON.stringify(projectsMeta),
			"utf-8",
		);

		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));

		daemon = await createDaemon({ dataDir, autoInitAuth: false });
	});

	afterAll(async () => {
		await daemon.shutdown();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("discovers plugin from registered project", async () => {
		expect(daemon.plugins.length).toBe(1);
		expect(daemon.plugins[0]?.name).toBe("test-matrix");
		expect(daemon.plugins[0]?.scope).toBe("global");
	});

	test("/plugins returns discovered plugin", async () => {
		const res = await daemon.fetch(new Request("http://localhost/plugins"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.length).toBe(1);
		expect(body[0].name).toBe("test-matrix");
	});

	test("worker started for global plugin — version returns counts", async () => {
		// /version is forwarded to worker (unlike /health which is daemon-owned)
		// This actually verifies the worker is running and responding
		const res = await daemon.fetch(new Request("http://localhost/version"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
		expect(typeof body.nodeCount).toBe("number");
	});
});

describe("daemon startup — dataRoot hardening (Audit FU5)", () => {
	// Each case sets up its own temp project with a specific plugin manifest
	// and verifies createDaemon either throws (malformed) or succeeds (legal).
	async function setupProject(manifest: string): Promise<{
		tempDir: string;
		dataDir: string;
		cleanup: () => Promise<void>;
	}> {
		const tempDir = await mkdtemp(join(tmpdir(), "daemon-fu5-test-"));
		const dataDir = join(tempDir, ".mxd");
		const projectPath = join(tempDir, "proj");

		await mkdir(join(projectPath, ".mxd", "plugin"), { recursive: true });
		await writeFile(
			join(projectPath, ".mxd", "plugin", "index.ts"),
			manifest,
			"utf-8",
		);
		await mkdir(join(dataDir, "projects"), { recursive: true });
		await writeFile(
			join(dataDir, "projects.json"),
			JSON.stringify([
				{
					id: "p1",
					name: "proj",
					path: projectPath,
					createdAt: new Date().toISOString(),
				},
			]),
		);
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));

		return {
			tempDir,
			dataDir,
			cleanup: async () => {
				await rm(tempDir, { recursive: true, force: true });
			},
		};
	}

	test("manifest with traversal dataRoot '@/../etc' → createDaemon throws", async () => {
		const ctx = await setupProject(
			`export default { name: "evil", scope: "global", dataRoot: "@/../etc" };`,
		);
		try {
			await expect(createDaemon({ dataDir: ctx.dataDir })).rejects.toThrow(
				/Invalid dataRoot/,
			);
		} finally {
			await ctx.cleanup();
		}
	});

	test("manifest with no-prefix dataRoot 'foo' → createDaemon throws", async () => {
		const ctx = await setupProject(
			`export default { name: "bad", scope: "global", dataRoot: "foo" };`,
		);
		try {
			await expect(createDaemon({ dataDir: ctx.dataDir })).rejects.toThrow(
				/Invalid dataRoot/,
			);
		} finally {
			await ctx.cleanup();
		}
	});

	test("manifest with empty dataRoot '' → createDaemon throws", async () => {
		const ctx = await setupProject(
			`export default { name: "empty", scope: "global", dataRoot: "" };`,
		);
		try {
			await expect(createDaemon({ dataDir: ctx.dataDir })).rejects.toThrow(
				/Invalid dataRoot/,
			);
		} finally {
			await ctx.cleanup();
		}
	});

	test("manifest with absolute dataRoot '/etc' → createDaemon throws", async () => {
		const ctx = await setupProject(
			`export default { name: "abs", scope: "global", dataRoot: "/etc" };`,
		);
		try {
			await expect(createDaemon({ dataDir: ctx.dataDir })).rejects.toThrow(
				/Invalid dataRoot/,
			);
		} finally {
			await ctx.cleanup();
		}
	});

	test("manifest with legal '@' → daemon starts", async () => {
		const ctx = await setupProject(
			`export default { name: "ok", scope: "global", dataRoot: "@" };`,
		);
		try {
			const daemon = await createDaemon({ dataDir: ctx.dataDir });
			expect(daemon.plugins.length).toBe(1);
			await daemon.shutdown();
		} finally {
			await ctx.cleanup();
		}
	});
});
