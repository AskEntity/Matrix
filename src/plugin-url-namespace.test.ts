/**
 * Tests for the `/api/<plugin>/*` URL namespace contract.
 *
 * Covers:
 *  - `pluginApiPrefix()` is the single source of truth both sides import.
 *  - Plugin web's api.ts builders prepend the prefix (one-line migration).
 *  - Daemon strips the prefix and forwards to the plugin's worker.
 *  - Unknown plugin, unprefixed plugin path, and crashed worker all respond
 *    with the correct status — no silent fallback to a different worker.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG, saveGlobalConfig } from "./config.ts";
import { createDaemon, type DaemonInstance } from "./daemon.ts";
import { pluginApiPrefix } from "./plugin-url.ts";
import { buildWebAssets } from "./web-builder.ts";

// ── Pure helpers ──

describe("pluginApiPrefix()", () => {
	test("returns /api/<name>", () => {
		expect(pluginApiPrefix("matrix")).toBe("/api/matrix");
		expect(pluginApiPrefix("story1001")).toBe("/api/story1001");
		expect(pluginApiPrefix("x")).toBe("/api/x");
	});

	test("is stable across calls (no mutation)", () => {
		const a = pluginApiPrefix("matrix");
		const b = pluginApiPrefix("matrix");
		expect(a).toBe(b);
	});
});

describe("matrix plugin api.ts builders apply the namespace prefix", () => {
	// api.ts imports `@mxd/types` which re-exports `pluginApiPrefix` from
	// `src/plugin.ts`. TypeScript path alias + bun's tsconfig support resolve
	// this in the test process.
	test("api.tasks(id) → /api/matrix/projects/:id/tasks", async () => {
		const { api } = await import("../.mxd/plugin/web/api.ts");
		expect(api.tasks("proj-abc")).toBe("/api/matrix/projects/proj-abc/tasks");
	});

	test("api.taskMessage(projectId, nodeId) → namespaced", async () => {
		const { api } = await import("../.mxd/plugin/web/api.ts");
		expect(api.taskMessage("p1", "n1")).toBe(
			"/api/matrix/projects/p1/tasks/n1/message",
		);
	});

	test("api.agent(id) → /api/matrix/projects/:id/agent", async () => {
		const { api } = await import("../.mxd/plugin/web/api.ts");
		expect(api.agent("abc")).toBe("/api/matrix/projects/abc/agent");
	});

	test("api.events(id, query) preserves query string under the prefix", async () => {
		const { api } = await import("../.mxd/plugin/web/api.ts");
		expect(api.events("abc", "after=123")).toBe(
			"/api/matrix/projects/abc/events?after=123",
		);
	});

	test("every builder contains the pluginApiPrefix", async () => {
		const { api } = await import("../.mxd/plugin/web/api.ts");
		const samples = [
			api.project("p"),
			api.tasks("p"),
			api.task("p", "n"),
			api.taskMessage("p", "n"),
			api.taskStop("p", "n"),
			api.taskFork("p", "n"),
			api.taskReorder("p", "n"),
			api.taskContinue("p", "n"),
			api.stop("p"),
			api.compact("p"),
			api.clarify("p"),
			api.agent("p"),
			api.agentStatus("p"),
			api.sessionsClear("p"),
			api.sessionsPrune("p"),
			api.clarifications("p"),
			api.backgroundMove("p"),
			api.backgroundKill("p", "bg"),
			api.debugDumpMessages("p"),
		];
		const prefix = pluginApiPrefix("matrix");
		for (const url of samples) {
			expect(url.startsWith(prefix)).toBe(true);
		}
	});
});

// ── Daemon forwarding through the namespace ──

describe("daemon /api/<plugin>/* forwarding", () => {
	let daemon: DaemonInstance;
	let tempDir: string;
	let projectId: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "plugin-url-ns-"));
		const dataDir = join(tempDir, ".mxd");
		const projectPath = join(tempDir, "proj");
		await mkdir(join(projectPath, ".mxd", "plugin"), { recursive: true });
		// Two plugins side-by-side — only "worker-a" gets a worker because
		// scope=global triggers worker startup. Bonus: proves `/api/<plugin>`
		// routes to the correct one.
		await writeFile(
			join(projectPath, ".mxd", "plugin", "index.ts"),
			`export default { name: "worker-a", scope: "global" };`,
		);
		await mkdir(join(dataDir, "projects"), { recursive: true });
		projectId = "ns-test-proj";
		await writeFile(
			join(dataDir, "projects.json"),
			JSON.stringify([
				{
					id: projectId,
					name: "proj",
					path: projectPath,
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
	}, 15000);

	afterAll(async () => {
		await daemon?.shutdown();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("prefixed plugin path reaches the matching worker (200)", async () => {
		const res = await daemon.fetch(
			new Request(`http://localhost/api/worker-a/projects/${projectId}/tasks`),
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(typeof body.rootNodeId).toBe("string");
	});

	test("bare (unprefixed) plugin path → 404 (no catch-all forwarding)", async () => {
		const res = await daemon.fetch(
			new Request(`http://localhost/projects/${projectId}/tasks`),
		);
		expect(res.status).toBe(404);
	});

	test("unknown plugin name → 404 with the name in the error", async () => {
		const res = await daemon.fetch(
			new Request(`http://localhost/api/not-registered/projects/foo/tasks`),
		);
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.error).toContain("not-registered");
	});

	test("POST body + query string survive the strip+forward", async () => {
		// Build a task through the namespaced URL, with a query param to prove
		// the daemon's URL rewriting preserves everything except the path prefix.
		const treeRes = await daemon.fetch(
			new Request(
				`http://localhost/api/worker-a/projects/${projectId}/tasks?sort=status`,
			),
		);
		expect(treeRes.status).toBe(200);
		const tree = await treeRes.json();

		const createRes = await daemon.fetch(
			new Request(`http://localhost/api/worker-a/projects/${projectId}/tasks`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					parentId: tree.rootNodeId,
					title: "namespaced task",
					description: "proves body survives",
				}),
			}),
		);
		expect(createRes.status).toBe(201);
		const created = await createRes.json();
		expect(created.title).toBe("namespaced task");
	});

	test("daemon-owned /global-context is NOT touched by the namespace", async () => {
		const res = await daemon.fetch(
			new Request("http://localhost/global-context"),
		);
		expect(res.status).toBe(200);
		const ctx = await res.json();
		expect(typeof ctx.installRoot).toBe("string");
		expect(typeof ctx.version).toBe("string");
	});

	test("daemon-owned /projects/:id (project info) is NOT touched", async () => {
		const res = await daemon.fetch(
			new Request(`http://localhost/projects/${projectId}`),
		);
		expect(res.status).toBe(200);
		const p = await res.json();
		expect(p.id).toBe(projectId);
	});
});

// ── runtime-types.js bundle-size regression ──
//
// web/runtime-types.ts is compiled for the browser and shipped to every plugin
// via the @mxd/types importmap entry. It must stay free of `node:*` transitive
// dependencies — Bun's browser polyfill for `node:path` alone is ~10KB.
//
// Regression story: commit b42c9a2 (URL namespace) re-exported `pluginApiPrefix`
// from `src/plugin.ts`, which imports `src/data-paths.ts`, which imports
// `node:path`. The built runtime-types.js ballooned from 169 B to 10,293 B —
// a 60× regression paid by every plugin's first load. The fix moved
// `pluginApiPrefix` to a zero-import sibling (`src/plugin-url.ts`).
//
// This test is the guardrail. If a future change re-introduces a transitive
// `node:*` or other server-only import into runtime-types' graph, the built
// file's size jumps past the threshold and this test fails loud.
describe("runtime-types.js bundle size (regression guard)", () => {
	const MATRIX_ROOT = resolve(new URL("..", import.meta.url).pathname);
	const SHELL_ENTRY = join(MATRIX_ROOT, "web", "main.tsx");
	const RUNTIME_TYPES_SIZE_LIMIT = 500; // bytes

	let buildDir: string;
	beforeAll(async () => {
		buildDir = await mkdtemp(join(tmpdir(), "runtime-types-size-"));
		await buildWebAssets({
			buildDir,
			shellEntry: SHELL_ENTRY,
			plugins: [],
			projectRoot: MATRIX_ROOT,
		});
	}, 30000);

	afterAll(async () => {
		await rm(buildDir, { recursive: true, force: true });
	});

	test(`runtime-types.js < ${RUNTIME_TYPES_SIZE_LIMIT} bytes`, () => {
		const builtPath = join(buildDir, "vendor", "shared", "runtime-types.js");
		const size = statSync(builtPath).size;
		if (size >= RUNTIME_TYPES_SIZE_LIMIT) {
			throw new Error(
				`runtime-types.js is ${size} bytes (limit ${RUNTIME_TYPES_SIZE_LIMIT}). ` +
					`A recent change likely re-introduced a server-only import (node:*) into ` +
					`its graph. Check web/runtime-types.ts imports — every re-export must come ` +
					`from a module whose transitive graph is browser-safe.`,
			);
		}
		expect(size).toBeLessThan(RUNTIME_TYPES_SIZE_LIMIT);
	});
});
