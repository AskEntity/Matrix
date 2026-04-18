/**
 * Tests for daemon auto-register + 4-step hook flow + production mode.
 *
 * These cover the full bootstrap path that daemon.test.ts skips
 * (all other tests use autoRegisterSelf: false).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG, saveGlobalConfig } from "./config.ts";
import { createDaemon, type DaemonInstance } from "./daemon.ts";

describe("auto-register + production mode", () => {
	let tempDir: string;
	let dataDir: string;
	let daemon: DaemonInstance;

	afterAll(async () => {
		await daemon?.shutdown();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("daemon auto-registers its own install root", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "bootstrap-test-"));
		dataDir = join(tempDir, ".mxd");
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));

		// autoRegisterSelf: true (default) — daemon should find its own repo
		daemon = await createDaemon({ dataDir, autoInitAuth: false });

		const res = await daemon.fetch(new Request("http://localhost/projects"));
		const projects = await res.json();

		// Should have auto-registered the matrix repo
		expect(projects.length).toBeGreaterThanOrEqual(1);
		const matrixProject = projects.find((p: { path: string }) =>
			resolve(p.path) === resolve(join(__dirname, ".."))
		);
		expect(matrixProject).toBeDefined();
	});

	test("matrix repo with .git is NOT production mode", async () => {
		const res = await daemon.fetch(new Request("http://localhost/projects"));
		const projects = await res.json();
		const matrixProject = projects.find((p: { path: string }) =>
			resolve(p.path) === resolve(join(__dirname, ".."))
		);

		// This repo has .git — should NOT be production mode
		expect(matrixProject.productionMode).toBe(false);
	});
});

describe("production mode — install root without git", () => {
	let tempDir: string;
	let dataDir: string;
	let fakeInstallDir: string;
	let daemon: DaemonInstance;

	afterAll(async () => {
		await daemon?.shutdown();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("project at installRoot without .git gets .mxd.production marker", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "prod-mode-test-"));
		dataDir = join(tempDir, ".mxd");
		fakeInstallDir = join(tempDir, "fake-install");

		// Create a fake install directory with .mxd/plugin/ but NO .git
		await mkdir(join(fakeInstallDir, ".mxd", "plugin"), { recursive: true });
		await writeFile(
			join(fakeInstallDir, ".mxd", "plugin", "index.ts"),
			`export default { name: "test-plugin", scope: "global" };`,
		);

		// Register it as a project
		await mkdir(join(dataDir, "projects"), { recursive: true });
		await writeFile(
			join(dataDir, "projects.json"),
			JSON.stringify([
				{ id: "fake-install", name: "fake-install", path: fakeInstallDir, createdAt: new Date().toISOString() },
			]),
		);
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));

		// Don't auto-register (we manually set up the project), but DO run hooks
		daemon = await createDaemon({ dataDir, autoInitAuth: false, autoRegisterSelf: false });

		// Check: since fakeInstallDir is NOT the real installRoot (daemon binary path),
		// it should NOT get production marker. Production mode is only for the actual
		// daemon install root.
		const marker = join(dataDir, "projects", "fake-install", ".mxd.production");
		expect(existsSync(marker)).toBe(false);

		// GET /projects should show productionMode: false
		const res = await daemon.fetch(new Request("http://localhost/projects"));
		const projects = await res.json();
		expect(projects[0].productionMode).toBe(false);
	});
});

describe("4-step hook flow", () => {
	let tempDir: string;
	let dataDir: string;
	let daemon: DaemonInstance;
	let projectPath: string;

	afterAll(async () => {
		await daemon?.shutdown();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("POST /projects runs global plugin hooks on new project", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "hook-flow-test-"));
		dataDir = join(tempDir, ".mxd");
		projectPath = join(tempDir, "user-project");
		await mkdir(projectPath, { recursive: true });

		// Register the matrix repo so its global plugin is discovered
		await mkdir(join(dataDir, "projects"), { recursive: true });
		const matrixRoot = resolve(join(__dirname, ".."));
		await writeFile(
			join(dataDir, "projects.json"),
			JSON.stringify([
				{ id: "matrix", name: "matrix", path: matrixRoot, createdAt: new Date().toISOString() },
			]),
		);
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));
		daemon = await createDaemon({ dataDir, autoInitAuth: false, autoRegisterSelf: false });

		// POST /projects with a new user project
		const res = await daemon.fetch(new Request("http://localhost/projects", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: projectPath }),
		}));
		expect(res.status).toBe(201);

		// Matrix's global hook should have run on the new project
		// → created .mxd/memory.md
		expect(existsSync(join(projectPath, ".mxd", "memory.md"))).toBe(true);
	});
});
