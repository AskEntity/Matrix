/**
 * E2E test: daemon with Matrix plugin — full pipeline including task tree.
 *
 * Auth is always on (Audit R7 P1.3); the test server attaches a session
 * token to every outgoing request via a patched global fetch.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG, saveGlobalConfig } from "./config.ts";
import { createDaemon, type DaemonInstance } from "./daemon.ts";
import { createTestToken } from "./test-utils/auth-helper.ts";

describe("daemon with Matrix plugin e2e", () => {
	let tempDir: string;
	let daemon: DaemonInstance;
	let server: ReturnType<typeof Bun.serve>;
	let TEST_PORT: number;
	let sessionToken: string;

	// Thin fetch wrapper that attaches Bearer token automatically.
	async function afetch(path: string, init?: RequestInit): Promise<Response> {
		const headers = new Headers(init?.headers);
		headers.set("Authorization", `Bearer ${sessionToken}`);
		return fetch(`http://localhost:${TEST_PORT}${path}`, { ...init, headers });
	}

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "daemon-matrix-e2e-"));
		const dataDir = join(tempDir, ".mxd");
		const projectPath = join(tempDir, "test-project");

		// Create a project with git repo
		await mkdir(join(projectPath, ".mxd", "hooks"), { recursive: true });
		Bun.spawnSync(["git", "init"], { cwd: projectPath });
		Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
			cwd: projectPath,
		});
		Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: projectPath });
		await writeFile(join(projectPath, ".gitignore"), "node_modules/\n");
		await writeFile(join(projectPath, ".mxd", "memory.md"), "# Test\n");
		await writeFile(
			join(projectPath, ".mxd", "hooks", "setup_worktree.sh"),
			"#!/bin/bash\n",
		);
		const { chmod } = await import("node:fs/promises");
		await chmod(join(projectPath, ".mxd", "hooks", "setup_worktree.sh"), 0o755);
		Bun.spawnSync(["git", "add", "."], { cwd: projectPath });
		Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: projectPath });

		// Register project with Matrix plugin reference
		await mkdir(join(dataDir, "projects"), { recursive: true });
		await writeFile(
			join(dataDir, "projects.json"),
			JSON.stringify([
				{
					id: "proj1",
					name: "test-project",
					path: projectPath,
					createdAt: new Date().toISOString(),
				},
			]),
		);

		// Also register the Matrix repo itself (so plugin discovery finds .mxd/plugin/)
		const matrixRepoPath = resolve(".");
		await writeFile(
			join(dataDir, "projects.json"),
			JSON.stringify([
				{
					id: "proj1",
					name: "test-project",
					path: projectPath,
					createdAt: new Date().toISOString(),
				},
				{
					id: "matrix",
					name: "matrix",
					path: matrixRepoPath,
					createdAt: new Date().toISOString(),
				},
			]),
		);

		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));

		sessionToken = await createTestToken(join(dataDir, "auth.json"));
		daemon = await createDaemon({
			dataDir,
			autoRegisterSelf: false,
		});

		server = Bun.serve({ port: 0, fetch: daemon.fetch });
		if (server.port === undefined)
			throw new Error("Bun.serve returned no port");
		TEST_PORT = server.port;
	}, 15000);

	afterAll(async () => {
		server?.stop();
		await daemon?.shutdown();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("discovers Matrix plugin", () => {
		const matrix = daemon.plugins.find((p) => p.name === "matrix");
		expect(matrix).toBeDefined();
		expect(matrix?.scope).toBe("global");
	});

	test("health through daemon → worker", async () => {
		const res = await afetch("/health");
		expect(res.status).toBe(200);
	});

	test("projects list includes test project", async () => {
		const res = await afetch("/projects");
		const projects = (await res.json()) as Array<{ name: string }>;
		expect(projects.some((p) => p.name === "test-project")).toBe(true);
	});

	test("task tree for project — has root node", async () => {
		// Plugin-owned routes go through the `/api/<plugin>/*` namespace.
		const res = await afetch("/api/matrix/projects/proj1/tasks");
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.rootNodeId).toBeDefined();
		expect(data.nodes.length).toBeGreaterThan(0);
		expect(data.nodes[0].title).toBe("Orchestrator");
	});

	test("create task through daemon → worker", async () => {
		// Get root node
		const treeRes = await afetch("/api/matrix/projects/proj1/tasks");
		const tree = await treeRes.json();

		const res = await afetch("/api/matrix/projects/proj1/tasks", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				parentId: tree.rootNodeId,
				title: "E2E Test Task",
				description: "Created in daemon e2e test",
			}),
		});
		expect(res.status).toBe(201);
		const task = await res.json();
		expect(task.title).toBe("E2E Test Task");
		expect(task.status).toBe("pending");
	});

	test("tree now has the created task", async () => {
		const res = await afetch("/api/matrix/projects/proj1/tasks");
		const data = (await res.json()) as { nodes: Array<{ title: string }> };
		const titles = data.nodes.map((n) => n.title);
		expect(titles).toContain("E2E Test Task");
	});

	test("bare (unprefixed) plugin path returns 404", async () => {
		// Regression guard: the `/api/<plugin>/*` namespace is the ONLY way
		// plugin routes are served. Unprefixed paths no longer fall through
		// to a global worker.
		const res = await afetch("/projects/proj1/tasks");
		expect(res.status).toBe(404);
	});

	test("plugins endpoint returns Matrix with web path", async () => {
		const res = await afetch("/plugins");
		const plugins = (await res.json()) as Array<{
			name: string;
			webComponentPath?: string;
		}>;
		const matrix = plugins.find((p) => p.name === "matrix");
		expect(matrix).toBeDefined();
		expect(matrix?.webComponentPath).toBeDefined();
	});

	test("anonymous REST request returns 401 (Audit R7 P1.3)", async () => {
		// Same endpoint as above, but without the Authorization header —
		// auth is ALWAYS on after P1.3, so this MUST reject.
		const res = await fetch(`http://localhost:${TEST_PORT}/projects`);
		expect(res.status).toBe(401);
	});
});
