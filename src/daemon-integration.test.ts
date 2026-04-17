/**
 * Daemon integration tests — verify that key HTTP behaviors work
 * through the full daemon → worker pipeline (not just direct createApp).
 *
 * These mirror runtime.test.ts scenarios but go through createDaemon.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	createDaemonTestApp,
	type DaemonTestApp,
} from "./test-utils/daemon-harness.ts";

describe("daemon integration: health + version + stats", () => {
	let app: DaemonTestApp;

	beforeAll(async () => {
		app = await createDaemonTestApp();
	});

	afterAll(async () => {
		await app.cleanup();
	});

	test("GET /health returns ok", async () => {
		const res = await app.fetch(new Request("http://localhost/health"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("ok");
		expect(body.version).toBeDefined();
	});

	test("GET /version returns version + counts", async () => {
		const res = await app.fetch(new Request("http://localhost/version"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.version).toBeDefined();
		expect(typeof body.nodeCount).toBe("number");
	});

	test("GET /stats returns stats", async () => {
		const res = await app.fetch(new Request("http://localhost/stats"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.uptime).toBeGreaterThanOrEqual(0);
	});

	test("GET /unknown returns 404", async () => {
		const res = await app.fetch(new Request("http://localhost/nonexistent"));
		expect(res.status).toBe(404);
	});
});

describe("daemon integration: projects", () => {
	let app: DaemonTestApp;

	beforeAll(async () => {
		app = await createDaemonTestApp();
	});

	afterAll(async () => {
		await app.cleanup();
	});

	test("GET /projects returns list", async () => {
		const res = await app.fetch(new Request("http://localhost/projects"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(Array.isArray(body)).toBe(true);
	});

	test("POST /projects creates project", async () => {
		const { mkdir } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const newProjectPath = join(app.tempDir, "new-project");
		await mkdir(newProjectPath, { recursive: true });

		const res = await app.fetch(
			new Request("http://localhost/projects", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path: newProjectPath }),
			}),
		);
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.id).toBeDefined();
		expect(body.name).toBe("new-project");
	});

	test("POST /projects rejects duplicate", async () => {
		const { mkdir } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const dupPath = join(app.tempDir, "dup-project");
		await mkdir(dupPath, { recursive: true });

		// Create first
		await app.fetch(
			new Request("http://localhost/projects", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path: dupPath }),
			}),
		);

		// Duplicate should fail
		const res = await app.fetch(
			new Request("http://localhost/projects", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path: dupPath }),
			}),
		);
		expect(res.status).toBe(409);
	});
});

describe("daemon integration: config", () => {
	let app: DaemonTestApp;

	beforeAll(async () => {
		app = await createDaemonTestApp();
	});

	afterAll(async () => {
		await app.cleanup();
	});

	test("GET /config/global returns config (daemon-owned)", async () => {
		const res = await app.fetch(new Request("http://localhost/config/global"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.budgetUsd).toBe(-1);
	});

	test("PATCH /config/global updates config (daemon-owned)", async () => {
		const res = await app.fetch(
			new Request("http://localhost/config/global", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ budgetUsd: 100 }),
			}),
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.budgetUsd).toBe(100);
	});

	test("/plugins returns discovered plugins", async () => {
		const res = await app.fetch(new Request("http://localhost/plugins"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(Array.isArray(body)).toBe(true);
		expect(body.length).toBe(1);
		expect(body[0].name).toBe("test-matrix");
	});
});

describe("daemon integration: project config", () => {
	let app: DaemonTestApp;
	let projectId: string;

	beforeAll(async () => {
		app = await createDaemonTestApp();
		const res = await app.fetch(new Request("http://localhost/projects"));
		const projects = await res.json();
		projectId = projects[0]?.id;
	});

	afterAll(async () => {
		await app.cleanup();
	});

	test("GET /projects/:id/config returns empty for new project", async () => {
		const res = await app.fetch(
			new Request(`http://localhost/projects/${projectId}/config`),
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({});
	});

	test("PATCH /projects/:id/config sets and returns config", async () => {
		await app.fetch(
			new Request(`http://localhost/projects/${projectId}/config`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "claude-opus-4-5" }),
			}),
		);
		const res = await app.fetch(
			new Request(`http://localhost/projects/${projectId}/config`),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { model?: string };
		expect(body.model).toBe("claude-opus-4-5");
	});

	test("PATCH preserves unrelated fields", async () => {
		await app.fetch(
			new Request(`http://localhost/projects/${projectId}/config`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "a", budgetUsd: 2 }),
			}),
		);
		const res = await app.fetch(
			new Request(`http://localhost/projects/${projectId}/config`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "b" }),
			}),
		);
		const body = (await res.json()) as { model?: string; budgetUsd?: number };
		expect(body.model).toBe("b");
		expect(body.budgetUsd).toBe(2);
	});

	test("PATCH null removes field", async () => {
		await app.fetch(
			new Request(`http://localhost/projects/${projectId}/config`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "x" }),
			}),
		);
		const res = await app.fetch(
			new Request(`http://localhost/projects/${projectId}/config`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: null }),
			}),
		);
		const body = (await res.json()) as { model?: string };
		expect(body.model).toBeUndefined();
	});

	test("GET /projects/:id/config/repo returns empty when no repo config", async () => {
		const res = await app.fetch(
			new Request(`http://localhost/projects/${projectId}/config/repo`),
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({});
	});

	test("returns 404 for unknown project", async () => {
		const res = await app.fetch(
			new Request("http://localhost/projects/nonexistent/config"),
		);
		expect(res.status).toBe(404);
	});
});

describe("daemon integration: tasks through worker", () => {
	let app: DaemonTestApp;
	let projectId: string;

	beforeAll(async () => {
		app = await createDaemonTestApp();

		// Get the registered project ID
		const res = await app.fetch(new Request("http://localhost/projects"));
		const projects = await res.json();
		projectId = projects[0]?.id;
	});

	afterAll(async () => {
		await app.cleanup();
	});

	test("GET /projects/:id/tasks returns tree", async () => {
		expect(projectId).toBeTruthy();
		const res = await app.fetch(
			new Request(`http://localhost/projects/${projectId}/tasks`),
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(typeof body.rootNodeId).toBe("string");
		expect(body.rootNodeId.length).toBeGreaterThan(0);
		expect(Array.isArray(body.nodes)).toBe(true);
		expect(body.nodes.length).toBeGreaterThan(0);
		expect(body.nodes[0].title).toBe("Orchestrator");
	});

	test("POST /projects/:id/tasks creates task through worker", async () => {
		expect(projectId).toBeTruthy();

		// Get root node ID first
		const treeRes = await app.fetch(
			new Request(`http://localhost/projects/${projectId}/tasks`),
		);
		const tree = await treeRes.json();
		const rootId = tree.rootNodeId;

		const res = await app.fetch(
			new Request(`http://localhost/projects/${projectId}/tasks`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					parentId: rootId,
					title: "Test task via daemon",
					description: "Created through daemon pipeline",
				}),
			}),
		);
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.title).toBe("Test task via daemon");
	});
});

describe("daemon integration: project CRUD coverage", () => {
	let app: DaemonTestApp;
	let projectId: string;
	let projectPath: string;

	beforeAll(async () => {
		app = await createDaemonTestApp();
		projectPath = join(app.tempDir, "crud-project");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(projectPath, { recursive: true });

		const res = await app.fetch(
			new Request("http://localhost/projects", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path: projectPath }),
			}),
		);
		const body = await res.json();
		projectId = body.id;
	});

	afterAll(async () => {
		await app.cleanup();
	});

	test("GET /projects/:id returns project", async () => {
		const res = await app.fetch(
			new Request(`http://localhost/projects/${projectId}`),
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.id).toBe(projectId);
		expect(body.name).toBe("crud-project");
	});

	test("GET /projects/:id returns 404 for unknown", async () => {
		const res = await app.fetch(
			new Request("http://localhost/projects/nonexistent"),
		);
		expect(res.status).toBe(404);
	});

	test("GET /projects includes pathExists field", async () => {
		const res = await app.fetch(new Request("http://localhost/projects"));
		const projects = (await res.json()) as Array<{
			id: string;
			pathExists?: boolean;
		}>;
		const proj = projects.find((p) => p.id === projectId);
		expect(proj?.pathExists).toBeDefined();
	});

	test("PATCH /projects/:id updates name", async () => {
		const res = await app.fetch(
			new Request(`http://localhost/projects/${projectId}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: "renamed-project" }),
			}),
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.name).toBe("renamed-project");
	});

	test("PATCH /projects/:id rejects empty body", async () => {
		const res = await app.fetch(
			new Request(`http://localhost/projects/${projectId}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({}),
			}),
		);
		expect(res.status).toBe(400);
	});

	test("PATCH /projects/:id returns 404 for unknown", async () => {
		const res = await app.fetch(
			new Request("http://localhost/projects/nonexistent", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: "x" }),
			}),
		);
		expect(res.status).toBe(404);
	});

	test("DELETE /projects/:id removes project", async () => {
		// Create a throwaway project to delete
		const { mkdir } = await import("node:fs/promises");
		const delPath = join(app.tempDir, "to-delete");
		await mkdir(delPath, { recursive: true });
		const createRes = await app.fetch(
			new Request("http://localhost/projects", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path: delPath }),
			}),
		);
		const created = await createRes.json();

		const res = await app.fetch(
			new Request(`http://localhost/projects/${created.id}`, {
				method: "DELETE",
			}),
		);
		expect(res.status).toBe(200);

		// Verify gone
		const getRes = await app.fetch(
			new Request(`http://localhost/projects/${created.id}`),
		);
		expect(getRes.status).toBe(404);
	});
});

describe("daemon integration: onProjectInit pipeline", () => {
	let app: DaemonTestApp;

	beforeAll(async () => {
		// Use a plugin manifest WITH onProjectInit so the pipeline test is real
		const pluginWithInit = `
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
export default {
	name: "test-with-init",
	scope: "global",
	async onProjectInit(projectPath, { isNew }) {
		await mkdir(join(projectPath, ".mxd"), { recursive: true });
		if (!existsSync(join(projectPath, ".mxd", "memory.md"))) {
			await writeFile(join(projectPath, ".mxd", "memory.md"), "# Project Memory\\nTest init.\\n");
		}
	},
};`;
		app = await createDaemonTestApp({ pluginManifest: pluginWithInit });
	});

	afterAll(async () => {
		await app.cleanup();
	});

	test("POST /projects calls plugin onProjectInit — new project gets memory.md", async () => {
		const { mkdir, readFile } = await import("node:fs/promises");
		const { existsSync } = await import("node:fs");
		const projectPath = join(app.tempDir, "init-test-project");
		await mkdir(projectPath, { recursive: true });

		const res = await app.fetch(
			new Request("http://localhost/projects", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path: projectPath }),
			}),
		);
		expect(res.status).toBe(201);

		// Plugin's onProjectInit should have created .mxd/memory.md
		expect(existsSync(join(projectPath, ".mxd", "memory.md"))).toBe(true);
		const memory = await readFile(
			join(projectPath, ".mxd", "memory.md"),
			"utf-8",
		);
		expect(memory).toContain("Project Memory");
	});
});
