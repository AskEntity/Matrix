/**
 * Fresh-install bootstrap tests.
 *
 * - Auto-register at daemon startup (STEP 1 of the 4-step flow).
 * - Plugin discovery + onProjectInit hooks run on all applicable projects.
 * - Backend 403 guard for matrix's production-mode projects (plugin-side).
 * - Zero-plugin shell still serves valid HTML.
 *
 * Matrix's "production mode" semantic is fully plugin-owned. Daemon exposes
 * only plugin-agnostic facts via GET /global-context. These tests assert the
 * plugin-owned behavior end-to-end (daemon doesn't leak matrix concepts).
 *
 * Auth is always on (Audit R7 P1.3); tests mint a session token per daemon.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG, saveGlobalConfig } from "./config.ts";
import { createDaemon, type DaemonInstance } from "./daemon.ts";
import { createTestToken } from "./test-utils/auth-helper.ts";

function authed(daemon: DaemonInstance, token: string) {
	return (req: Request) => {
		const headers = new Headers(req.headers);
		if (!headers.has("authorization")) {
			headers.set("Authorization", `Bearer ${token}`);
		}
		return daemon.fetch(
			new Request(req.url, {
				method: req.method,
				headers,
				body:
					req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
			}),
		);
	};
}

describe("auto-register at startup", () => {
	let tempDir: string;
	let daemon: DaemonInstance;

	afterAll(async () => {
		await daemon?.shutdown();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("daemon auto-registers its own install root on first run (no restart needed)", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "bootstrap-"));
		const dataDir = join(tempDir, ".mxd");
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));

		const token = await createTestToken(join(dataDir, "auth.json"));
		daemon = await createDaemon({ dataDir });
		const fetch = authed(daemon, token);

		const res = await fetch(new Request("http://localhost/projects"));
		const projects = await res.json();
		const matrixRoot = resolve(join(__dirname, ".."));
		const found = projects.find(
			(p: { path: string }) => resolve(p.path) === matrixRoot,
		);
		expect(found).toBeDefined();
		// Daemon response must NOT leak matrix's production semantic
		expect("productionMode" in found).toBe(false);
	});
});

describe("global-context endpoint", () => {
	let tempDir: string;
	let daemon: DaemonInstance;

	afterAll(async () => {
		await daemon?.shutdown();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("GET /global-context exposes installRoot, gitHash, version", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "global-ctx-"));
		const dataDir = join(tempDir, ".mxd");
		const fakeInstall = join(tempDir, "fake-install");
		await mkdir(fakeInstall, { recursive: true });
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));

		const token = await createTestToken(join(dataDir, "auth.json"));
		daemon = await createDaemon({
			dataDir,
			autoRegisterSelf: false,
			installRoot: fakeInstall,
		});
		const fetch = authed(daemon, token);

		const res = await fetch(new Request("http://localhost/global-context"));
		expect(res.status).toBe(200);
		const ctx = await res.json();
		expect(ctx.installRoot).toBe(fakeInstall);
		expect(typeof ctx.version).toBe("string");
		// gitHash is null when GIT_HASH is unresolved (common in tests)
		expect("gitHash" in ctx).toBe(true);
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

		const token = await createTestToken(join(dataDir, "auth.json"));
		daemon = await createDaemon({
			dataDir,
			autoRegisterSelf: false,
		});
		const fetch = authed(daemon, token);

		// POST new user project
		const res = await fetch(
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
});

describe("production-mode backend guard (plugin middleware, unit)", () => {
	// Tests the middleware registered by matrix's registerRoutes directly on
	// an isolated Hono app. Avoids worker-thread indirection (tempdir-TS-import
	// fragility) while still verifying the middleware's exact semantic.
	test("guards POST on production project, allows GET, passes non-production through", async () => {
		const { Hono } = await import("hono");
		const { registerRoutes } = await import("../.mxd/plugin/runtime.ts");

		// Fake ctx with a ProjectManager-shape stub and matrix's globalContext
		// pointing at the install root (production detection fires when project
		// path matches installRoot AND no gitHash).
		const installRoot = "/fake/install";
		const prodProject = { id: "prod", name: "prod", path: installRoot };
		const devProject = { id: "dev", name: "dev", path: "/some/other/path" };
		const ctx = {
			pm: {
				get: (id: string) =>
					id === "prod" ? prodProject : id === "dev" ? devProject : null,
			},
			globalContext: {
				installRoot,
				gitHash: null,
				version: "test",
			},
		};

		const app = new Hono();
		// biome-ignore lint/suspicious/noExplicitAny: test harness sufficient shape
		registerRoutes(app, ctx as any);
		// Fallthrough handler: 200 for everything not blocked by middleware.
		app.all("*", (c) => c.text("ok", 200));

		// Production project + POST (mutation) → 403
		const prodPost = await app.fetch(
			new Request(`http://localhost/projects/prod/tasks/root/message`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ content: "hello" }),
			}),
		);
		expect(prodPost.status).toBe(403);
		const prodBody = await prodPost.json();
		expect(prodBody.error).toContain("production mode");

		// Production project + GET (read-only) → passes through
		const prodGet = await app.fetch(
			new Request(`http://localhost/projects/prod/tasks`),
		);
		expect(prodGet.status).toBe(200);

		// Non-production project + POST → passes through
		const devPost = await app.fetch(
			new Request(`http://localhost/projects/dev/tasks/root/message`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ content: "hello" }),
			}),
		);
		expect(devPost.status).toBe(200);
	});
});

describe("zero-plugin shell rendering", () => {
	let tempDir: string;
	let daemon: DaemonInstance;

	afterAll(async () => {
		await daemon?.shutdown();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("shell serves valid HTML when no plugins registered", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "zero-plugin-"));
		const dataDir = join(tempDir, ".mxd");
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));

		daemon = await createDaemon({
			dataDir,
			autoRegisterSelf: false,
		});

		// SPA root is on SKIP_EXACT — anonymous access works.
		const res = await daemon.fetch(new Request("http://localhost/"));
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("<!DOCTYPE html>");
		// Shell entry URL is content-hashed (`main-<8chars>.js`). The logical
		// name `main.js` no longer appears in HTML after the hashed-URL build.
		expect(html).toMatch(/\/app\/web\/main-[a-z0-9]{8}\.js/);

		// /auth/status is on SKIP_EXACT too — login page needs it pre-auth.
		const authRes = await daemon.fetch(
			new Request("http://localhost/auth/status"),
		);
		expect(authRes.status).toBe(200);
	});
});

describe("plugin-namespace storage migration (P4)", () => {
	let tempDir: string;
	let daemon: DaemonInstance;

	afterAll(async () => {
		await daemon?.shutdown();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("createDaemon migrates pre-existing tree.json/tasks/debug into plugin/matrix/", async () => {
		// Simulate a pre-P4 install: projects/<id>/{tree.json,tasks/,debug/}
		// sitting at the top level. createDaemon should migrate them before
		// spinning up any worker that would try to read them.
		tempDir = await mkdtemp(join(tmpdir(), "p4-migration-"));
		const dataDir = join(tempDir, ".mxd");
		const projectId = "01LEGACY_PROJ";
		const projectDir = join(dataDir, "projects", projectId);
		await mkdir(join(projectDir, "tasks"), { recursive: true });
		await mkdir(join(projectDir, "debug"), { recursive: true });
		await writeFile(
			join(projectDir, "tree.json"),
			JSON.stringify({ rootNodeId: "root", nodes: [] }),
		);
		await writeFile(join(projectDir, "tasks", "root.jsonl"), "line1\n");
		await writeFile(join(projectDir, "debug", "sample.json"), "{}");

		// projects.json points at some external path so the project is
		// discovered by pm.load() — but we don't need a real project on disk
		// for the migration itself (it scans projects/ dirs directly).
		const externalProjectPath = join(tempDir, "external");
		await mkdir(externalProjectPath, { recursive: true });
		await writeFile(
			join(dataDir, "projects.json"),
			JSON.stringify([
				{
					id: projectId,
					name: "legacy",
					path: externalProjectPath,
					createdAt: new Date().toISOString(),
				},
			]),
		);
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));

		daemon = await createDaemon({
			dataDir,
			autoRegisterSelf: false,
		});

		// Old layout should be GONE.
		expect(existsSync(join(projectDir, "tree.json"))).toBe(false);
		expect(existsSync(join(projectDir, "tasks"))).toBe(false);
		expect(existsSync(join(projectDir, "debug"))).toBe(false);

		// New layout exists with content preserved.
		const matrixDir = join(projectDir, "plugin", "matrix");
		expect(existsSync(join(matrixDir, "tree.json"))).toBe(true);
		expect(existsSync(join(matrixDir, "tasks", "root.jsonl"))).toBe(true);
		expect(existsSync(join(matrixDir, "debug", "sample.json"))).toBe(true);
	});
});
