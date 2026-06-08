/**
 * Canonical daemon test for ADDITIVE project-scoped plugin loading + routing.
 *
 * Proves the daemon-side mechanism end-to-end through a real worker layer:
 *   - a project that ships its OWN `.mxd/plugin/` (manifest `scope:"project"`)
 *     gets its OWN worker running ITS scope (its PRODUCT lens);
 *   - that SAME project is STILL served by the global matrix plugin (its DEV
 *     lens) — shipping a plugin ADDS a lens, it never removes the matrix one.
 *     `matrix:P_own` and `<own>:P_own` coexist and are ISOLATED (separate
 *     dataRoot trees);
 *   - projects WITHOUT their own plugin keep using the global matrix plugin
 *     exactly as before (the regression bar);
 *   - DELETE fans out — the project disappears from EVERY lens that served it;
 *   - two different projects can each ship a SAME-NAMED project plugin without
 *     their workers colliding (keyed by `<projectId>:<name>`).
 *
 * This file is the redo of the REVERTED exclusive foundation. The key
 * inversions vs that version: matrix STILL serves P_own (was 404), and matrix's
 * onProjectInit runs on P_own too (was gated out). See .mxd/memory.md
 * "Additive project-scoped plugin routing".
 *
 * Hermetic — no real provider. Scope isolation is proven via a diagnostic
 * `/projects/:id/scope-info` route the story scope registers (it enumerates
 * the scope's agent tools + prompt without running an agent) plus the
 * 404/503 routing behavior of workers that don't serve a project.
 *
 * Projects in one daemon:
 *   - matrix (the repo itself)  → global matrix plugin   (worker key "matrix")
 *   - pglobal (plain)           → global matrix plugin   (served by "matrix")
 *   - pown    (ships story plug)→ matrix (dev) + story-plugin (product) lenses
 *                                 (workers "matrix" + "pown:story-plugin")
 *   - p1, p2  (ship group-chat) → matrix + group-chat (same name, distinct workers)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG, saveGlobalConfig } from "./config.ts";
import { createDaemon, type DaemonInstance } from "./daemon.ts";
import { createTestToken } from "./test-utils/auth-helper.ts";

// matrix repo root (parent of src/) — robust regardless of CWD.
const MATRIX_REPO = resolve(import.meta.dir, "..");
// Absolute path to the shared story scope; project plugins re-export from it.
const STORY_SCOPE = join(import.meta.dir, "test-utils", "story-scope.ts");

function gitInit(dir: string): void {
	Bun.spawnSync(["git", "init"], { cwd: dir });
	Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: dir });
	Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: dir });
}

async function makePlainProject(root: string): Promise<void> {
	await mkdir(join(root, ".mxd"), { recursive: true });
	gitInit(root);
	await writeFile(join(root, ".gitignore"), "node_modules/\n");
	// Deliberately NO .mxd/memory.md — so matrix's onProjectInit writing one is
	// an OBSERVABLE side effect (used by the onProjectInit additive test).
	Bun.spawnSync(["git", "add", "."], { cwd: root });
	Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: root });
}

/**
 * A project that ships its own project-scoped plugin. The on-disk plugin is
 * intentionally tiny: its runtime.ts re-exports the shared story scope by
 * ABSOLUTE path, so the tmpdir plugin needs no `node_modules` of its own.
 */
async function makeStoryPluginProject(
	root: string,
	pluginName: string,
): Promise<void> {
	await makePlainProject(root);
	const pluginDir = join(root, ".mxd", "plugin");
	await mkdir(pluginDir, { recursive: true });
	await writeFile(
		join(pluginDir, "index.ts"),
		`export default { name: ${JSON.stringify(pluginName)}, scope: "project", runtime: "./runtime.ts" };\n`,
	);
	await writeFile(
		join(pluginDir, "runtime.ts"),
		`export { buildScopeOpts, registerRoutes } from ${JSON.stringify(STORY_SCOPE)};\n`,
	);
}

describe("daemon: additive project-scoped plugin loading + routing", () => {
	let tempDir: string;
	let daemon: DaemonInstance;
	let server: ReturnType<typeof Bun.serve>;
	let port: number;
	let token: string;

	async function afetch(path: string, init?: RequestInit): Promise<Response> {
		const headers = new Headers(init?.headers);
		headers.set("Authorization", `Bearer ${token}`);
		return fetch(`http://localhost:${port}${path}`, { ...init, headers });
	}

	beforeAll(async () => {
		tempDir = realpathSync(await mkdtemp(join(tmpdir(), "mxd-proj-scope-")));
		const dataDir = join(tempDir, ".mxd");

		const pglobal = join(tempDir, "pglobal");
		const pown = join(tempDir, "pown");
		const p1 = join(tempDir, "p1");
		const p2 = join(tempDir, "p2");

		await makePlainProject(pglobal);
		await makeStoryPluginProject(pown, "story-plugin");
		await makeStoryPluginProject(p1, "group-chat");
		await makeStoryPluginProject(p2, "group-chat");

		await mkdir(join(dataDir, "projects"), { recursive: true });
		const now = new Date().toISOString();
		await writeFile(
			join(dataDir, "projects.json"),
			JSON.stringify([
				{ id: "matrix", name: "matrix", path: MATRIX_REPO, createdAt: now },
				{ id: "pglobal", name: "pglobal", path: pglobal, createdAt: now },
				{ id: "pown", name: "pown", path: pown, createdAt: now },
				{ id: "p1", name: "p1", path: p1, createdAt: now },
				{ id: "p2", name: "p2", path: p2, createdAt: now },
			]),
		);

		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));
		token = await createTestToken(join(dataDir, "auth.json"));
		daemon = await createDaemon({ dataDir, autoRegisterSelf: false });

		server = Bun.serve({ port: 0, fetch: daemon.fetch });
		if (server.port === undefined) throw new Error("no port");
		port = server.port;
	}, 30000);

	afterAll(async () => {
		server?.stop();
		await daemon?.shutdown();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("discovers the global matrix plugin AND the project-scoped plugins", () => {
		const matrix = daemon.plugins.find((p) => p.name === "matrix");
		expect(matrix?.scope).toBe("global");

		const story = daemon.plugins.find(
			(p) => p.name === "story-plugin" && p.projectId === "pown",
		);
		expect(story).toBeDefined();
		expect(story?.scope).toBe("project");

		// Two SAME-NAMED project plugins, one per project — both registered.
		const gcs = daemon.plugins.filter((p) => p.name === "group-chat");
		expect(gcs.map((p) => p.projectId).sort()).toEqual(["p1", "p2"]);
		expect(gcs.every((p) => p.scope === "project")).toBe(true);
	});

	test("P_own's PRODUCT lens runs ITS scope (story tools); matrix tools absent there", async () => {
		const res = await afetch("/api/story-plugin/projects/pown/scope-info");
		expect(res.status).toBe(200);
		const info = (await res.json()) as {
			promptStable: string;
			toolNames: string[];
		};
		// Story prompt, not matrix's.
		expect(info.promptStable).toContain("storyteller");
		// Custom tool present.
		expect(info.toolNames.some((n) => n.includes("write_paragraph"))).toBe(
			true,
		);
		// Matrix's tools absent in the PRODUCT lens.
		expect(info.toolNames.some((n) => n.includes("bash"))).toBe(false);
		expect(info.toolNames.some((n) => n.includes("create_task"))).toBe(false);
		expect(info.toolNames.some((n) => n.includes("read_file"))).toBe(false);
	});

	test("P_own's PRODUCT lens task tree is served by its OWN worker", async () => {
		const res = await afetch("/api/story-plugin/projects/pown/tasks");
		expect(res.status).toBe(200);
		const tree = (await res.json()) as { rootNodeId: string };
		expect(tree.rootNodeId).toBeDefined();
	});

	// ── THE additive assertion (inverts the reverted "matrix 404s for P_own") ──
	test("matrix STILL serves P_own (additive DEV lens — NOT exclusive 404)", async () => {
		// Under the reverted exclusive model this was 404 (matrix's pm had no
		// pown). Additive: matrix is global, serves EVERY project's dev lens, so
		// pown is reachable under matrix too — with matrix's own (Orchestrator)
		// tree, distinct from the story tree.
		const res = await afetch("/api/matrix/projects/pown/tasks");
		expect(res.status).toBe(200);
		const tree = (await res.json()) as {
			rootNodeId: string;
			nodes: Array<{ title: string }>;
		};
		expect(tree.rootNodeId).toBeDefined();
		// matrix's dev-lens root node is the "Orchestrator".
		expect(tree.nodes.some((n) => n.title === "Orchestrator")).toBe(true);
	});

	test("P_own's DEV (matrix) and PRODUCT (story) lenses coexist and are ISOLATED", async () => {
		// A task created via the DEV lens.
		const mTree = (await (
			await afetch("/api/matrix/projects/pown/tasks")
		).json()) as { rootNodeId: string };
		const cM = await afetch("/api/matrix/projects/pown/tasks", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				parentId: mTree.rootNodeId,
				title: "Dev lens task",
				description: "created via matrix:pown",
			}),
		});
		expect(cM.status).toBe(201);

		// A task created via the PRODUCT lens.
		const sTree = (await (
			await afetch("/api/story-plugin/projects/pown/tasks")
		).json()) as { rootNodeId: string };
		const cS = await afetch("/api/story-plugin/projects/pown/tasks", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				parentId: sTree.rootNodeId,
				title: "Product lens task",
				description: "created via story-plugin:pown",
			}),
		});
		expect(cS.status).toBe(201);

		// Each lens sees ONLY its own task — they live in separate dataRoot
		// trees (`plugin/matrix/pown/` vs `plugin/story-plugin/pown/`).
		const devTitles = (
			(await (await afetch("/api/matrix/projects/pown/tasks")).json()) as {
				nodes: Array<{ title: string }>;
			}
		).nodes.map((n) => n.title);
		const productTitles = (
			(await (
				await afetch("/api/story-plugin/projects/pown/tasks")
			).json()) as { nodes: Array<{ title: string }> }
		).nodes.map((n) => n.title);

		expect(devTitles).toContain("Dev lens task");
		expect(devTitles).not.toContain("Product lens task");
		expect(productTitles).toContain("Product lens task");
		expect(productTitles).not.toContain("Dev lens task");
	});

	test("P_global still routes to the global matrix worker (regression bar)", async () => {
		const res = await afetch("/api/matrix/projects/pglobal/tasks");
		expect(res.status).toBe(200);
		const tree = (await res.json()) as {
			rootNodeId: string;
			nodes: Array<{ title: string }>;
		};
		expect(tree.rootNodeId).toBeDefined();
		// matrix's root node is the "Orchestrator".
		expect(tree.nodes.some((n) => n.title === "Orchestrator")).toBe(true);
	});

	test("matrix runs onProjectInit on ALL projects — including ones shipping their own plugin", async () => {
		// Additive: matrix is every project's DEV lens, so it scaffolds every
		// project's dev environment (memory.md), NOT only the projects it
		// exclusively owns.
		const pglobalMemory = join(tempDir, "pglobal", ".mxd", "memory.md");
		expect(existsSync(pglobalMemory)).toBe(true);
		expect(await readFile(pglobalMemory, "utf-8")).toContain(
			"# Project Memory",
		);

		// pown ships its OWN (story) plugin — but it KEEPS the matrix dev lens,
		// so matrix's onProjectInit ALSO scaffolds pown's memory.md. (Under the
		// reverted exclusive model this was gated out and asserted absent.)
		const pownMemory = join(tempDir, "pown", ".mxd", "memory.md");
		expect(existsSync(pownMemory)).toBe(true);
		expect(await readFile(pownMemory, "utf-8")).toContain("# Project Memory");
	});

	test("story-plugin worker does NOT serve P_global", async () => {
		// No global candidate named story-plugin, and story-plugin's only
		// project is pown → no worker resolves for pglobal under story-plugin.
		const res = await afetch("/api/story-plugin/projects/pglobal/tasks");
		expect(res.status).toBe(503);
	});

	test("project-scoped plugin handles its own task CRUD", async () => {
		const tree = (await (
			await afetch("/api/story-plugin/projects/pown/tasks")
		).json()) as { rootNodeId: string };

		const create = await afetch("/api/story-plugin/projects/pown/tasks", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				parentId: tree.rootNodeId,
				title: "Chapter 1",
				description: "First chapter",
			}),
		});
		expect(create.status).toBe(201);

		const after = (await (
			await afetch("/api/story-plugin/projects/pown/tasks")
		).json()) as { nodes: Array<{ title: string }> };
		expect(after.nodes.map((n) => n.title)).toContain("Chapter 1");
	});

	test("two projects shipping a SAME-NAMED plugin get distinct, isolated workers", async () => {
		// Both p1 and p2 ship a plugin literally named "group-chat". They must be
		// keyed by projectId (`p1:group-chat` / `p2:group-chat`), so a task
		// created in p1 NEVER appears in p2's tree.
		const t1 = (await (
			await afetch("/api/group-chat/projects/p1/tasks")
		).json()) as { rootNodeId: string };
		const t2 = (await (
			await afetch("/api/group-chat/projects/p2/tasks")
		).json()) as { rootNodeId: string };
		expect(t1.rootNodeId).toBeDefined();
		expect(t2.rootNodeId).toBeDefined();

		const c1 = await afetch("/api/group-chat/projects/p1/tasks", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				parentId: t1.rootNodeId,
				title: "From P1",
				description: "p1 only",
			}),
		});
		expect(c1.status).toBe(201);

		const p1Tree = (await (
			await afetch("/api/group-chat/projects/p1/tasks")
		).json()) as { nodes: Array<{ title: string }> };
		const p2Tree = (await (
			await afetch("/api/group-chat/projects/p2/tasks")
		).json()) as { nodes: Array<{ title: string }> };

		expect(p1Tree.nodes.map((n) => n.title)).toContain("From P1");
		// Isolation: p2's worker is a DIFFERENT worker — never saw "From P1".
		expect(p2Tree.nodes.map((n) => n.title)).not.toContain("From P1");
	});

	test("each same-named worker runs its own scope independently", async () => {
		const r1 = await afetch("/api/group-chat/projects/p1/scope-info");
		const r2 = await afetch("/api/group-chat/projects/p2/scope-info");
		expect(r1.status).toBe(200);
		expect(r2.status).toBe(200);
		const i1 = (await r1.json()) as { toolNames: string[] };
		const i2 = (await r2.json()) as { toolNames: string[] };
		expect(i1.toolNames.some((n) => n.includes("write_paragraph"))).toBe(true);
		expect(i2.toolNames.some((n) => n.includes("write_paragraph"))).toBe(true);
	});

	// ── DELETE fan-out — runs LAST (it removes pown) ──
	test("DELETE P_own fans out — project removed from BOTH lenses (dev + product)", async () => {
		// Before: pown is reachable in BOTH lenses (additive).
		expect((await afetch("/api/matrix/projects/pown/tasks")).status).toBe(200);
		expect((await afetch("/api/story-plugin/projects/pown/tasks")).status).toBe(
			200,
		);

		// DELETE fans out a /stop to EVERY scope serving pown (matrix +
		// pown:story-plugin), then removes the project. Under the reverted
		// exclusive model the "before: matrix serves pown" precondition above
		// would already fail (matrix 404'd pown), so this test is additive-specific.
		const del = await afetch("/projects/pown", { method: "DELETE" });
		expect(del.status).toBe(200);

		// After: pown is gone from the registry → neither lens serves it anymore
		// (syncProjects propagated the removal to BOTH workers).
		expect((await afetch("/api/matrix/projects/pown/tasks")).status).not.toBe(
			200,
		);
		expect(
			(await afetch("/api/story-plugin/projects/pown/tasks")).status,
		).not.toBe(200);
	});
});
