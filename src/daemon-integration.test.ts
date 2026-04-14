/**
 * Daemon integration tests — verify that key HTTP behaviors work
 * through the full daemon → worker pipeline (not just direct createApp).
 *
 * These mirror runtime.test.ts scenarios but go through createDaemon.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDaemonTestApp, type DaemonTestApp } from "./test-utils/daemon-harness.ts";

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
		const res = await app.fetch(
			new Request("http://localhost/nonexistent"),
		);
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
		const res = await app.fetch(
			new Request("http://localhost/config/global"),
		);
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
		const res = await app.fetch(
			new Request("http://localhost/plugins"),
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(Array.isArray(body)).toBe(true);
		expect(body.length).toBe(1);
		expect(body[0].name).toBe("test-matrix");
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
		if (!projectId) return;
		const res = await app.fetch(
			new Request(`http://localhost/projects/${projectId}/tasks`),
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.rootNodeId).toBeDefined();
		expect(body.nodes).toBeDefined();
	});

	test("POST /projects/:id/tasks creates task through worker", async () => {
		if (!projectId) return;

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
