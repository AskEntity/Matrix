import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider } from "./agent-provider.ts";
import { createApp } from "./daemon.ts";
import type { HealthResponse, Project } from "./types.ts";

const mockProvider: AgentProvider = {
	name: "mock",
	execute: async () => ({ success: true, output: "" }),
	// biome-ignore lint/correctness/useYield: mock provider never streams
	stream: async function* () {
		return { success: true, output: "" };
	},
};

describe("daemon health", () => {
	test("GET /health returns ok with version and uptime", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "og-health-"));
		const { app, pm } = createApp({ dataDir, agentProvider: mockProvider });
		await pm.load();

		const res = await app.request("/health");
		expect(res.status).toBe(200);

		const body = (await res.json()) as HealthResponse;
		expect(body.status).toBe("ok");
		expect(body.version).toBe("0.0.1");
		expect(typeof body.uptime).toBe("number");

		await rm(dataDir, { recursive: true });
	});

	test("GET /unknown returns 404", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "og-404-"));
		const { app, pm } = createApp({ dataDir, agentProvider: mockProvider });
		await pm.load();

		const res = await app.request("/unknown");
		expect(res.status).toBe(404);

		await rm(dataDir, { recursive: true });
	});
});

describe("daemon projects API", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createApp>["app"];

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-projects-"));
		dataDir = await mkdtemp(join(tmpdir(), "og-data-"));
		const result = createApp({ dataDir, agentProvider: mockProvider });
		app = result.app;
		await result.pm.load();
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("POST /projects with new path creates project", async () => {
		const projectPath = join(tempDir, "my-app");
		const res = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: projectPath }),
		});
		expect(res.status).toBe(201);

		const project = (await res.json()) as Project;
		expect(project.name).toBe("my-app");
		expect(project.path).toBe(projectPath);
	});

	test("POST /projects rejects duplicate path", async () => {
		const projectPath = join(tempDir, "dup");
		await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: projectPath }),
		});

		const res = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: projectPath }),
		});
		expect(res.status).toBe(409);
	});

	test("POST /projects requires path", async () => {
		const res = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	test("GET /projects lists all", async () => {
		await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: join(tempDir, "a") }),
		});
		await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: join(tempDir, "b") }),
		});

		const res = await app.request("/projects");
		const list = (await res.json()) as Project[];
		expect(list).toHaveLength(2);
	});

	test("GET /projects/:id returns project", async () => {
		const createRes = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: join(tempDir, "find-me") }),
		});
		const created = (await createRes.json()) as Project;

		const res = await app.request(`/projects/${created.id}`);
		expect(res.status).toBe(200);
		const project = (await res.json()) as Project;
		expect(project.name).toBe("find-me");
	});

	test("GET /projects/:id returns 404 for unknown", async () => {
		const res = await app.request("/projects/nonexistent");
		expect(res.status).toBe(404);
	});

	test("DELETE /projects/:id removes metadata", async () => {
		const createRes = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: join(tempDir, "delete-me") }),
		});
		const created = (await createRes.json()) as Project;

		const delRes = await app.request(`/projects/${created.id}`, {
			method: "DELETE",
		});
		expect(delRes.status).toBe(200);

		const getRes = await app.request(`/projects/${created.id}`);
		expect(getRes.status).toBe(404);
	});
});
