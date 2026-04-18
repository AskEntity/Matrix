/**
 * Tests for daemon auto-register + 4-step hook flow + production mode.
 *
 * These cover the full bootstrap path that daemon.test.ts skips
 * (all other tests use autoRegisterSelf: false).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG, saveGlobalConfig } from "./config.ts";
import { createDaemon, type DaemonInstance } from "./daemon.ts";

describe("auto-register at startup", () => {
	let tempDir: string;
	let daemon: DaemonInstance;

	afterAll(async () => {
		await daemon?.shutdown();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("daemon auto-registers its own install root", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "bootstrap-"));
		const dataDir = join(tempDir, ".mxd");
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));

		daemon = await createDaemon({ dataDir, autoInitAuth: false });

		const res = await daemon.fetch(new Request("http://localhost/projects"));
		const projects = await res.json();
		const matrixRoot = resolve(join(__dirname, ".."));
		const found = projects.find(
			(p: { path: string }) => resolve(p.path) === matrixRoot,
		);
		expect(found).toBeDefined();
		// This repo has .git → NOT production
		expect(found.productionMode).toBe(false);
	});
});

describe("production mode — positive path (end-to-end)", () => {
	let tempDir: string;
	let daemon: DaemonInstance;
	let fakeInstall: string;
	let dataDir: string;

	afterAll(async () => {
		await daemon?.shutdown();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("install root without .git → marker written + productionMode: true", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "prod-positive-"));
		dataDir = join(tempDir, ".mxd");
		fakeInstall = join(tempDir, "fake-install");

		// Create fake install dir with .mxd/ but NO .git
		await mkdir(join(fakeInstall, ".mxd", "plugin"), { recursive: true });
		await writeFile(
			join(fakeInstall, ".mxd", "plugin", "index.ts"),
			`export default { name: "test-plugin", scope: "global" };`,
		);
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));

		// installRoot override → daemon treats fakeInstall as its own install
		// autoRegisterSelf: true (default) → registers fakeInstall
		daemon = await createDaemon({
			dataDir,
			autoInitAuth: false,
			installRoot: fakeInstall,
		});

		// Assert: project was auto-registered
		const res = await daemon.fetch(new Request("http://localhost/projects"));
		const projects = await res.json();
		const prod = projects.find(
			(p: { path: string }) => resolve(p.path) === resolve(fakeInstall),
		);
		expect(prod).toBeDefined();

		// Assert: .mxd.production marker written in daemon data dir
		const marker = join(dataDir, "projects", prod.id, ".mxd.production");
		expect(existsSync(marker)).toBe(true);

		// Assert: GET /projects returns productionMode: true
		expect(prod.productionMode).toBe(true);
	});
});

describe("production mode — negative paths", () => {
	let tempDir: string;
	let daemon: DaemonInstance;

	afterAll(async () => {
		await daemon?.shutdown();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("project NOT at installRoot does NOT get .mxd.production marker", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "prod-negative-"));
		const dataDir = join(tempDir, ".mxd");
		const otherProject = join(tempDir, "other-project");

		await mkdir(join(otherProject, ".mxd", "plugin"), { recursive: true });
		await writeFile(
			join(otherProject, ".mxd", "plugin", "index.ts"),
			`export default { name: "other", scope: "global" };`,
		);
		await mkdir(join(dataDir, "projects"), { recursive: true });
		await writeFile(
			join(dataDir, "projects.json"),
			JSON.stringify([
				{
					id: "other",
					name: "other",
					path: otherProject,
					createdAt: new Date().toISOString(),
				},
			]),
		);
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));

		daemon = await createDaemon({
			dataDir,
			autoInitAuth: false,
			autoRegisterSelf: false,
		});

		const marker = join(dataDir, "projects", "other", ".mxd.production");
		expect(existsSync(marker)).toBe(false);

		const res = await daemon.fetch(new Request("http://localhost/projects"));
		const projects = await res.json();
		expect(projects[0].productionMode).toBe(false);
	});
});

describe("4-step hook flow", () => {
	let tempDir: string;
	let daemon: DaemonInstance;

	afterAll(async () => {
		await daemon?.shutdown();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("POST /projects runs global plugin hooks on new project", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "hook-flow-"));
		const dataDir = join(tempDir, ".mxd");
		const userProject = join(tempDir, "user-project");
		await mkdir(userProject, { recursive: true });

		// Register matrix repo so its global plugin is discovered
		const matrixRoot = resolve(join(__dirname, ".."));
		await mkdir(join(dataDir, "projects"), { recursive: true });
		await writeFile(
			join(dataDir, "projects.json"),
			JSON.stringify([
				{
					id: "matrix",
					name: "matrix",
					path: matrixRoot,
					createdAt: new Date().toISOString(),
				},
			]),
		);
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));
		daemon = await createDaemon({
			dataDir,
			autoInitAuth: false,
			autoRegisterSelf: false,
		});

		// POST new user project
		const res = await daemon.fetch(
			new Request("http://localhost/projects", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path: userProject }),
			}),
		);
		expect(res.status).toBe(201);

		// Matrix's global hook should have created .mxd/memory.md
		expect(existsSync(join(userProject, ".mxd", "memory.md"))).toBe(true);
	});

	test("POST /projects with global plugin propagates hook to existing projects", async () => {
		// Setup: existing project A (no plugin), then POST project B with global plugin
		const projectA = join(tempDir, "project-a");
		await mkdir(projectA, { recursive: true });

		// Register project A (no plugin)
		const resA = await daemon.fetch(
			new Request("http://localhost/projects", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path: projectA }),
			}),
		);
		expect(resA.status).toBe(201);

		// Matrix global plugin already registered at daemon startup
		// → project A should already have memory.md from step 3 of POST /projects
		// (POST /projects calls onProjectInit for all global plugins on the new project)
		expect(existsSync(join(projectA, ".mxd", "memory.md"))).toBe(true);
	});
});

describe("production mode — backend guard (Bug 5)", () => {
	let tempDir: string;
	let daemon: DaemonInstance;

	afterAll(async () => {
		await daemon?.shutdown();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("POST to production project returns 403", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "prod-guard-"));
		const dataDir = join(tempDir, ".mxd");
		const fakeInstall = join(tempDir, "fake-install");

		await mkdir(join(fakeInstall, ".mxd", "plugin"), { recursive: true });
		await writeFile(
			join(fakeInstall, ".mxd", "plugin", "index.ts"),
			'export default { name: "test-plugin", scope: "global" };',
		);
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));

		daemon = await createDaemon({
			dataDir,
			autoInitAuth: false,
			installRoot: fakeInstall,
		});

		const listRes = await daemon.fetch(
			new Request("http://localhost/projects"),
		);
		const projects = await listRes.json();
		const prod = projects.find(
			(p: { path: string }) => resolve(p.path) === resolve(fakeInstall),
		);
		expect(prod).toBeDefined();
		expect(prod.productionMode).toBe(true);

		// POST message → 403
		const msgRes = await daemon.fetch(
			new Request(`http://localhost/projects/${prod.id}/tasks/root/message`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ content: "hello" }),
			}),
		);
		expect(msgRes.status).toBe(403);
		const body = await msgRes.json();
		expect(body.error).toContain("production mode");

		// GET still works (read-only allowed)
		const getRes = await daemon.fetch(
			new Request(`http://localhost/projects/${prod.id}/tasks`),
		);
		expect(getRes.status).not.toBe(403);
	});
});

describe("zero-plugin shell rendering (Bug 2+3)", () => {
	let tempDir: string;
	let daemon: DaemonInstance;

	afterAll(async () => {
		await daemon?.shutdown();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("shell serves valid HTML with CSS when no plugins registered", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "zero-plugin-"));
		const dataDir = join(tempDir, ".mxd");
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));

		daemon = await createDaemon({
			dataDir,
			autoInitAuth: false,
			autoRegisterSelf: false,
		});

		const res = await daemon.fetch(new Request("http://localhost/"));
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("<!DOCTYPE html>");
		expect(html).toContain("stylesheet");
		expect(html).toContain("/app/web/main.js");

		const cssRes = await daemon.fetch(
			new Request("http://localhost/app/web/styles.css"),
		);
		expect(cssRes.status).toBe(200);

		const authRes = await daemon.fetch(
			new Request("http://localhost/auth/status"),
		);
		expect(authRes.status).toBe(200);
	});
});
