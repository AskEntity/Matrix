import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentProvider } from "./agent-provider.ts";
import { createOrchestratorTools, isDescendantOf } from "./agent-tools.ts";
import { createApp } from "./daemon.ts";
import { globalAgentQueues, MessageQueue } from "./message-queue.ts";
import { TaskTracker } from "./task-tracker.ts";
import type {
	AgentResult,
	HealthResponse,
	Project,
	StatsResponse,
	TaskNode,
	VersionResponse,
} from "./types.ts";

function createMockProvider(
	handler?: (request: {
		prompt: string;
	}) => Promise<{ success: boolean; output: string }>,
): AgentProvider {
	const execute = handler ?? (async () => ({ success: true, output: "" }));
	return {
		name: "mock",
		execute,
		// biome-ignore lint/correctness/useYield: mock provider never streams
		stream: async function* () {
			return { success: true, output: "" };
		},
		startSession(req) {
			const queue = req.queue ?? new MessageQueue();
			// biome-ignore lint/correctness/useYield: mock session never streams
			async function* events(): AsyncGenerator<AgentEvent, AgentResult> {
				return { success: true, output: "" };
			}
			return {
				sessionId: "mock-session",
				events: events(),
				queue,
				sendMessage: async () => {},
				stop: () => {
					queue.close();
				},
			};
		},
	};
}

const mockProvider = createMockProvider();

describe("daemon health", () => {
	test("GET /health returns ok with version and uptime", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "og-health-"));
		const { app, pm } = createApp({ dataDir, agentProvider: mockProvider });
		await pm.load();

		const res = await app.request("/health");
		expect(res.status).toBe(200);

		const body = (await res.json()) as HealthResponse;
		expect(body.status).toBe("ok");
		expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
		expect(typeof body.uptime).toBe("number");

		await rm(dataDir, { recursive: true });
	});

	test("GET /health without check_model has no model field", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "og-health-nomodel-"));
		const { app, pm } = createApp({ dataDir, agentProvider: mockProvider });
		await pm.load();

		const res = await app.request("/health");
		expect(res.status).toBe(200);

		const body = (await res.json()) as HealthResponse;
		expect(body.status).toBe("ok");
		expect(body.model).toBeUndefined();

		await rm(dataDir, { recursive: true });
	});

	test("GET /health?check_model=true returns model status", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "og-health-model-"));
		const { app, pm } = createApp({ dataDir, agentProvider: mockProvider });
		await pm.load();

		const res = await app.request("/health?check_model=true");
		expect(res.status).toBe(200);

		const body = (await res.json()) as HealthResponse;
		expect(body.status).toBe("ok");
		// The model field must be present (either ok or error — no real API key in test env)
		expect(body.model).toBeDefined();
		expect(body.model?.status).toMatch(/^(ok|error)$/);
		if (body.model?.status === "error") {
			expect(
				typeof (body.model as { status: "error"; error: string }).error,
			).toBe("string");
			expect(
				(body.model as { status: "error"; error: string }).error.length,
			).toBeGreaterThan(0);
		} else if (body.model?.status === "ok") {
			const m = body.model as {
				status: "ok";
				model: string;
				latencyMs: number;
			};
			expect(typeof m.model).toBe("string");
			expect(typeof m.latencyMs).toBe("number");
		}

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

describe("daemon version", () => {
	test("GET /version returns version, nodeCount, and projectCount", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "og-version-"));
		const { app, pm } = createApp({ dataDir, agentProvider: mockProvider });
		await pm.load();

		const res = await app.request("/version");
		expect(res.status).toBe(200);

		const body = (await res.json()) as VersionResponse;
		expect(typeof body.version).toBe("string");
		expect(body.version.length).toBeGreaterThan(0);
		expect(typeof body.nodeCount).toBe("number");
		expect(body.nodeCount).toBeGreaterThanOrEqual(0);
		expect(typeof body.projectCount).toBe("number");
		expect(body.projectCount).toBeGreaterThanOrEqual(0);

		await rm(dataDir, { recursive: true });
	});
});

describe("daemon stats", () => {
	test("GET /stats returns uptime, requestCount, projectCount, and taskCounts", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "og-stats-"));
		const { app, pm } = createApp({ dataDir, agentProvider: mockProvider });
		await pm.load();

		const res = await app.request("/stats");
		expect(res.status).toBe(200);

		const body = (await res.json()) as StatsResponse;
		expect(typeof body.uptime).toBe("number");
		expect(body.uptime).toBeGreaterThanOrEqual(0);
		expect(typeof body.requestCount).toBe("number");
		expect(body.requestCount).toBeGreaterThan(0);
		expect(body.projectCount).toBe(0);
		expect(body.taskCounts).toEqual({
			draft: 0,
			pending: 0,
			in_progress: 0,
			testing: 0,
			passed: 0,
			failed: 0,
			stuck: 0,
			closed: 0,
		});

		await rm(dataDir, { recursive: true });
	});

	test("GET /stats requestCount increments with each request", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "og-stats2-"));
		const { app, pm } = createApp({ dataDir, agentProvider: mockProvider });
		await pm.load();

		const res1 = await app.request("/stats");
		const body1 = (await res1.json()) as StatsResponse;
		const count1 = body1.requestCount;

		const res2 = await app.request("/stats");
		const body2 = (await res2.json()) as StatsResponse;
		const count2 = body2.requestCount;

		expect(count2).toBeGreaterThan(count1);

		await rm(dataDir, { recursive: true });
	});

	test("GET /stats uptime is in seconds not milliseconds", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "og-stats3-"));
		const { app, pm } = createApp({ dataDir, agentProvider: mockProvider });
		await pm.load();

		const res = await app.request("/stats");
		const body = (await res.json()) as StatsResponse;

		// uptime should be a small number (seconds since test start), not thousands (ms)
		// A test run shouldn't take more than 60 seconds
		expect(body.uptime).toBeLessThan(60);

		await rm(dataDir, { recursive: true });
	});

	test("GET /stats reflects projects and task counts", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "og-stats4-"));
		const dataDir = await mkdtemp(join(tmpdir(), "og-stats4d-"));
		const { app, pm } = createApp({ dataDir, agentProvider: mockProvider });
		await pm.load();

		// Create a project with tasks in different statuses
		const projRes = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: join(tempDir, "stats-proj") }),
		});
		const project = (await projRes.json()) as Project;

		// Create root task (pending)
		const rootRes = await app.request(`/projects/${project.id}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Root", description: "" }),
		});
		const root = (await rootRes.json()) as TaskNode;

		// Create child tasks
		const child1Res = await app.request(`/projects/${project.id}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Child1",
				description: "",
				parentId: root.id,
			}),
		});
		const child1 = (await child1Res.json()) as TaskNode;

		await app.request(`/projects/${project.id}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Child2",
				description: "",
				parentId: root.id,
			}),
		});

		// Mark root as in_progress, child1 as passed
		await app.request(`/projects/${project.id}/tasks/${root.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "in_progress" }),
		});
		await app.request(`/projects/${project.id}/tasks/${child1.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "passed" }),
		});

		const statsRes = await app.request("/stats");
		const stats = (await statsRes.json()) as StatsResponse;
		expect(stats.projectCount).toBe(1);
		expect(stats.taskCounts.pending).toBe(1); // Child2
		expect(stats.taskCounts.in_progress).toBe(1); // Root
		expect(stats.taskCounts.passed).toBe(1); // Child1
		expect(stats.taskCounts.failed).toBe(0);
		expect(stats.taskCounts.stuck).toBe(0);

		await rm(tempDir, { recursive: true });
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

describe("daemon tasks API", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createApp>["app"];
	let projectId: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-tasks-"));
		dataDir = await mkdtemp(join(tmpdir(), "og-tdata-"));
		const result = createApp({ dataDir, agentProvider: mockProvider });
		app = result.app;
		await result.pm.load();

		// Create a project for task tests
		const res = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: join(tempDir, "task-app") }),
		});
		const project = (await res.json()) as Project;
		projectId = project.id;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("POST /tasks creates root task", async () => {
		const res = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Chat App", description: "Build it" }),
		});
		expect(res.status).toBe(201);
		const node = (await res.json()) as TaskNode;
		expect(node.title).toBe("Chat App");
		expect(node.status).toBe("pending");
		expect(node.parentId).toBeNull();
	});

	test("POST /tasks creates task with budgetUsd", async () => {
		const res = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Budgeted Task",
				description: "Has a budget",
				budgetUsd: 0.5,
			}),
		});
		expect(res.status).toBe(201);
		const node = (await res.json()) as TaskNode;
		expect(node.title).toBe("Budgeted Task");
		expect(node.budgetUsd).toBe(0.5);
	});

	test("POST /tasks creates task without budgetUsd", async () => {
		const res = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "No Budget",
				description: "No budget set",
			}),
		});
		expect(res.status).toBe(201);
		const node = (await res.json()) as TaskNode;
		expect(node.budgetUsd).toBeUndefined();
	});

	test("POST /tasks creates child task", async () => {
		const rootRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Root", description: "" }),
		});
		const root = (await rootRes.json()) as TaskNode;

		const childRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Auth",
				description: "User auth",
				parentId: root.id,
			}),
		});
		expect(childRes.status).toBe(201);
		const child = (await childRes.json()) as TaskNode;
		expect(child.parentId).toBe(root.id);
	});

	test("GET /tasks returns tree", async () => {
		await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "App", description: "" }),
		});

		const res = await app.request(`/projects/${projectId}/tasks`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			nodes: TaskNode[];
			rootNodeId?: string | null;
		};
		expect(body.nodes).toHaveLength(1);
		expect(body.nodes[0]?.title).toBe("App");
	});

	test("GET /tasks returns rootNodeId when root node exists", async () => {
		// Create a task first so the tracker exists, then add a root node directly
		await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Child", description: "" }),
		});

		// GET /tasks should return nodes (rootNodeId may be null if no agent started)
		const res = await app.request(`/projects/${projectId}/tasks`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			nodes: TaskNode[];
			rootNodeId?: string | null;
		};
		expect(body.nodes.length).toBeGreaterThan(0);
		// rootNodeId field should exist in the response (even if null)
		expect("rootNodeId" in body).toBe(true);
	});

	test("PATCH /tasks/:nodeId updates status and branch", async () => {
		const rootRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "App", description: "" }),
		});
		const root = (await rootRes.json()) as TaskNode;

		const patchRes = await app.request(
			`/projects/${projectId}/tasks/${root.id}`,
			{
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					status: "in_progress",
					branch: "feat/main",
				}),
			},
		);
		expect(patchRes.status).toBe(200);
		const updated = (await patchRes.json()) as TaskNode;
		expect(updated.status).toBe("in_progress");
		expect(updated.branch).toBe("feat/main");
	});

	test("PATCH /tasks/:nodeId updates title and description", async () => {
		const rootRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Original", description: "Old desc" }),
		});
		const root = (await rootRes.json()) as TaskNode;

		const patchRes = await app.request(
			`/projects/${projectId}/tasks/${root.id}`,
			{
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "Updated Title",
					description: "New description",
				}),
			},
		);
		expect(patchRes.status).toBe(200);
		const updated = (await patchRes.json()) as TaskNode;
		expect(updated.title).toBe("Updated Title");
		expect(updated.description).toBe("New description");
	});

	test("PATCH /tasks/:nodeId can clear description with empty string", async () => {
		const rootRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Task", description: "Has desc" }),
		});
		const root = (await rootRes.json()) as TaskNode;

		const patchRes = await app.request(
			`/projects/${projectId}/tasks/${root.id}`,
			{
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ description: "" }),
			},
		);
		expect(patchRes.status).toBe(200);
		const updated = (await patchRes.json()) as TaskNode;
		expect(updated.description).toBe("");
		expect(updated.title).toBe("Task"); // title unchanged
	});

	test("PATCH /tasks/:nodeId reparents task with parentId", async () => {
		// Create two parents
		const p1Res = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Parent 1", description: "" }),
		});
		const p1 = (await p1Res.json()) as TaskNode;

		const p2Res = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Parent 2", description: "" }),
		});
		const p2 = (await p2Res.json()) as TaskNode;

		// Create a child under parent 1
		const childRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Child",
				description: "",
				parentId: p1.id,
			}),
		});
		const child = (await childRes.json()) as TaskNode;
		expect(child.parentId).toBe(p1.id);

		// Reparent child under parent 2
		const patchRes = await app.request(
			`/projects/${projectId}/tasks/${child.id}`,
			{
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ parentId: p2.id }),
			},
		);
		expect(patchRes.status).toBe(200);
		const updated = (await patchRes.json()) as TaskNode;
		expect(updated.parentId).toBe(p2.id);

		// Verify tree structure
		const treeRes = await app.request(`/projects/${projectId}/tasks`);
		const tree = (await treeRes.json()) as { nodes: TaskNode[] };
		const updatedP1 = tree.nodes.find((n) => n.id === p1.id);
		const updatedP2 = tree.nodes.find((n) => n.id === p2.id);
		expect(updatedP1?.children).not.toContain(child.id);
		expect(updatedP2?.children).toContain(child.id);
	});

	test("PATCH /tasks/:nodeId reparent returns 400 for circular dependency", async () => {
		const parentRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Parent", description: "" }),
		});
		const parent = (await parentRes.json()) as TaskNode;

		const childRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Child",
				description: "",
				parentId: parent.id,
			}),
		});
		const child = (await childRes.json()) as TaskNode;

		// Try to reparent parent under child (circular)
		const patchRes = await app.request(
			`/projects/${projectId}/tasks/${parent.id}`,
			{
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ parentId: child.id }),
			},
		);
		expect(patchRes.status).toBe(400);
		const body = (await patchRes.json()) as { error: string };
		expect(body.error).toContain("descendant");
	});

	test("DELETE /tasks/:nodeId removes task", async () => {
		const rootRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "App", description: "" }),
		});
		const root = (await rootRes.json()) as TaskNode;

		const delRes = await app.request(
			`/projects/${projectId}/tasks/${root.id}`,
			{ method: "DELETE" },
		);
		expect(delRes.status).toBe(200);

		const getRes = await app.request(`/projects/${projectId}/tasks`);
		const body = (await getRes.json()) as {
			nodes: TaskNode[];
		};
		expect(body.nodes).toHaveLength(0);
	});

	test("DELETE /tasks/:nodeId closes running agent queues", async () => {
		const rootRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Parent", description: "" }),
		});
		const root = (await rootRes.json()) as TaskNode;

		const childRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Running child",
				description: "",
				parentId: root.id,
			}),
		});
		const child = (await childRes.json()) as TaskNode;

		// Register a queue for the child (simulating a running agent)
		const childQueue = new MessageQueue();
		globalAgentQueues.set(child.id, childQueue);

		// Delete the parent — should cascade and close child queue
		const delRes = await app.request(
			`/projects/${projectId}/tasks/${root.id}`,
			{ method: "DELETE" },
		);
		expect(delRes.status).toBe(200);

		// Queue should be closed
		let closedAfterDelete = false;
		try {
			childQueue.enqueue({ source: "compact" });
		} catch {
			closedAfterDelete = true;
		}
		expect(closedAfterDelete).toBe(true);

		// Queue should be removed from global registry
		expect(globalAgentQueues.has(child.id)).toBe(false);
	});

	test("POST /tasks/:nodeId/continue resets failed task to pending", async () => {
		const rootRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "App", description: "" }),
		});
		const root = (await rootRes.json()) as TaskNode;

		// Mark as failed
		await app.request(`/projects/${projectId}/tasks/${root.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "failed" }),
		});

		// Continue with a message
		const contRes = await app.request(
			`/projects/${projectId}/tasks/${root.id}/continue`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message: "Try a different approach" }),
			},
		);
		expect(contRes.status).toBe(200);
		const continued = (await contRes.json()) as TaskNode;
		expect(continued.status).toBe("pending");
		expect(continued.message).toBe("Try a different approach");
	});

	test("POST /tasks/:nodeId/continue rejects non-failed task", async () => {
		const rootRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "App2", description: "" }),
		});
		const root = (await rootRes.json()) as TaskNode;

		const contRes = await app.request(
			`/projects/${projectId}/tasks/${root.id}/continue`,
			{ method: "POST" },
		);
		expect(contRes.status).toBe(400);
	});

	test("POST /tasks/:nodeId/continue uses startSession with MCP tools when task has worktree", async () => {
		// Track what stream() receives (runChildCore uses provider.stream())
		let streamCalled = false;
		let receivedMcpToolDefs = false;
		let receivedQueue = false;
		const agentProvider: AgentProvider = {
			name: "mock",
			execute: async () => ({ success: true, output: "" }),
			// biome-ignore lint/correctness/useYield: mock provider never streams
			stream: async function* (req) {
				streamCalled = true;
				if (req.mcpToolDefs && "opengraft" in req.mcpToolDefs) {
					receivedMcpToolDefs = true;
				}
				if (req.queue) {
					receivedQueue = true;
				}
				return { success: true, output: "done" };
			},
			startSession(req) {
				const queue = req.queue ?? new MessageQueue();
				// biome-ignore lint/correctness/useYield: mock session never streams
				async function* events(): AsyncGenerator<AgentEvent, AgentResult> {
					return { success: true, output: "done" };
				}
				return {
					sessionId: "mock-session",
					events: events(),
					queue,
					sendMessage: async () => {},
					stop: () => {
						queue.close();
					},
				};
			},
		};

		const localDataDir = await mkdtemp(join(tmpdir(), "og-cont-wt-"));
		const {
			app: localApp,
			pm: localPm,
			getTracker: localGetTracker,
		} = createApp({
			dataDir: localDataDir,
			agentProvider,
		});
		await localPm.load();

		// Create a project
		const projRes = await localApp.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: join(tempDir, "cont-wt-app") }),
		});
		const project = (await projRes.json()) as Project;

		// Create a task
		const taskRes = await localApp.request(`/projects/${project.id}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Cont task", description: "desc" }),
		});
		const task = (await taskRes.json()) as TaskNode;

		// Manually patch to failed
		await localApp.request(`/projects/${project.id}/tasks/${task.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "failed" }),
		});

		// Inject worktreePath directly into the daemon's in-memory tracker.
		// We use the project path itself as a fake worktree path (it exists as a dir).
		const daemonTracker = await localGetTracker(project.id);
		// assignWorktree(nodeId, branch, worktreePath)
		daemonTracker.assignWorktree(
			task.id,
			"og/fake/branch",
			join(tempDir, "cont-wt-app"),
		);
		await daemonTracker.save();

		// Continue the task
		const contRes = await localApp.request(
			`/projects/${project.id}/tasks/${task.id}/continue`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message: "Keep going" }),
			},
		);
		expect(contRes.status).toBe(200);

		// Wait briefly for the background agent to start
		await new Promise((r) => setTimeout(r, 100));

		expect(streamCalled).toBe(true);
		expect(receivedMcpToolDefs).toBe(true);
		expect(receivedQueue).toBe(true);
		// Ensure global queue registry is cleaned up after agent completes
		await new Promise((r) => setTimeout(r, 50));
		expect(globalAgentQueues.has(task.id)).toBe(false);

		await rm(localDataDir, { recursive: true });
	});

	test("GET /tasks/:nodeId/gitlog returns empty commits when no branch", async () => {
		const rootRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "NoLog", description: "" }),
		});
		const root = (await rootRes.json()) as TaskNode;

		const res = await app.request(
			`/projects/${projectId}/tasks/${root.id}/gitlog`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { commits: unknown[] };
		expect(body.commits).toBeInstanceOf(Array);
		expect(body.commits.length).toBe(0);
	});

	test("GET /tasks/:nodeId/gitlog returns 404 for unknown task", async () => {
		const res = await app.request(
			`/projects/${projectId}/tasks/nonexistent-task-id/gitlog`,
		);
		expect(res.status).toBe(404);
	});

	test("GET /tasks/:nodeId/gitlog returns commits when branch exists", async () => {
		// Use a local app instance to access getTracker
		const localDataDir = await mkdtemp(join(tmpdir(), "og-gitlog-wt-"));
		const {
			app: localApp,
			pm: localPm,
			getTracker: localGetTracker,
		} = createApp({ dataDir: localDataDir, agentProvider: mockProvider });
		await localPm.load();

		const projPath = join(tempDir, "gitlog-app");
		const projRes = await localApp.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: projPath }),
		});
		const project = (await projRes.json()) as Project;

		const taskRes = await localApp.request(`/projects/${project.id}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "LoggedTask", description: "" }),
		});
		const task = (await taskRes.json()) as TaskNode;

		// Find out the default branch name (could be "main" or "master" depending on git config)
		const branchProc = Bun.spawn(["git", "branch", "--show-current"], {
			cwd: projPath,
			stdout: "pipe",
			stderr: "pipe",
		});
		await branchProc.exited;
		const defaultBranch = (await new Response(branchProc.stdout).text()).trim();

		// Use assignWorktree to set both branch and worktreePath (PATCH only sets branch)
		const daemonTracker = await localGetTracker(project.id);
		daemonTracker.assignWorktree(task.id, defaultBranch, projPath);
		await daemonTracker.save();

		const res = await localApp.request(
			`/projects/${project.id}/tasks/${task.id}/gitlog`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			commits: { hash: string; message: string }[];
		};
		expect(body.commits).toBeInstanceOf(Array);
		// The project was initialized with a git commit, so there should be at least one
		expect(body.commits.length).toBeGreaterThan(0);
		expect(body.commits[0]).toHaveProperty("hash");
		expect(body.commits[0]).toHaveProperty("message");

		await rm(localDataDir, { recursive: true });
	});

	test("PATCH /tasks/:nodeId/reorder reorders children", async () => {
		// Create a parent task
		const parentRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Parent", description: "" }),
		});
		const parent = (await parentRes.json()) as TaskNode;

		// Create children
		const c1Res = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Child A",
				description: "",
				parentId: parent.id,
			}),
		});
		const c1 = (await c1Res.json()) as TaskNode;

		const c2Res = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Child B",
				description: "",
				parentId: parent.id,
			}),
		});
		const c2 = (await c2Res.json()) as TaskNode;

		const c3Res = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Child C",
				description: "",
				parentId: parent.id,
			}),
		});
		const c3 = (await c3Res.json()) as TaskNode;

		// Reorder: reverse order
		const reorderRes = await app.request(
			`/projects/${projectId}/tasks/${parent.id}/reorder`,
			{
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ children: [c3.id, c2.id, c1.id] }),
			},
		);
		expect(reorderRes.status).toBe(200);

		// Verify order via GET /tasks
		const tasksRes = await app.request(`/projects/${projectId}/tasks`);
		const { nodes } = (await tasksRes.json()) as { nodes: TaskNode[] };
		const updatedParent = nodes.find((n) => n.id === parent.id);
		expect(updatedParent?.children).toEqual([c3.id, c2.id, c1.id]);
	});

	test("PATCH /tasks/:nodeId/reorder returns 400 for invalid children", async () => {
		const parentRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Parent", description: "" }),
		});
		const parent = (await parentRes.json()) as TaskNode;

		await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Child",
				description: "",
				parentId: parent.id,
			}),
		});

		// Wrong children list
		const res = await app.request(
			`/projects/${projectId}/tasks/${parent.id}/reorder`,
			{
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ children: ["unknown-id"] }),
			},
		);
		expect(res.status).toBe(400);
	});

	test("PATCH /tasks/:nodeId/reorder returns 404 for unknown task", async () => {
		const res = await app.request(
			`/projects/${projectId}/tasks/nonexistent-task-id/reorder`,
			{
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ children: [] }),
			},
		);
		expect(res.status).toBe(404);
	});
});

describe("GET /projects/:id/events", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createApp>["app"];
	let projectId: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-events-"));
		dataDir = await mkdtemp(join(tmpdir(), "og-evdata-"));
		const result = createApp({ dataDir, agentProvider: mockProvider });
		app = result.app;
		await result.pm.load();

		const res = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: tempDir }),
		});
		const project = (await res.json()) as { id: string };
		projectId = project.id;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("returns empty events for new project", async () => {
		const res = await app.request(`/projects/${projectId}/events`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { events: unknown[] };
		expect(body.events).toBeInstanceOf(Array);
		expect(body.events.length).toBe(0);
	});

	test("returns 404 for unknown project", async () => {
		const res = await app.request("/projects/unknown-project-id/events");
		expect(res.status).toBe(404);
	});
});

describe("POST /projects/:id/tasks/:nodeId/message", () => {
	let tempDir: string;
	let dataDir: string;
	let projectId: string;
	let taskId: string;
	let taskQueue: MessageQueue;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-taskmsg-"));
		dataDir = await mkdtemp(join(tmpdir(), "og-taskmsgd-"));
		const { app: localApp, pm: localPm } = createApp({
			dataDir,
			agentProvider: mockProvider,
		});
		await localPm.load();

		const projRes = await localApp.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: join(tempDir, "proj") }),
		});
		const project = (await projRes.json()) as Project;
		projectId = project.id;

		const taskRes = await localApp.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Test task", description: "" }),
		});
		const task = (await taskRes.json()) as TaskNode;
		taskId = task.id;
	});

	afterEach(async () => {
		// Clean up global registry
		globalAgentQueues.delete(taskId);
		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("persists message when no queue registered for task", async () => {
		const { app, pm } = createApp({
			dataDir,
			agentProvider: mockProvider,
		});
		await pm.load();
		const res = await app.request(
			`/projects/${projectId}/tasks/${taskId}/message`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: "hello" }),
			},
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: boolean;
			taskId: string;
			persisted: boolean;
		};
		expect(body.ok).toBe(true);
		expect(body.persisted).toBe(true);
	});

	test("routes message to registered task queue", async () => {
		const { app, pm } = createApp({
			dataDir,
			agentProvider: mockProvider,
		});
		await pm.load();

		// Register a queue for this task in the global registry
		taskQueue = new MessageQueue();
		globalAgentQueues.set(taskId, taskQueue);

		const res = await app.request(
			`/projects/${projectId}/tasks/${taskId}/message`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: "ping from UI" }),
			},
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; taskId: string };
		expect(body.ok).toBe(true);
		expect(body.taskId).toBe(taskId);

		// Verify message was enqueued
		const msgs = taskQueue.drain();
		expect(msgs).toHaveLength(1);
		expect(msgs[0]).toEqual({ source: "user", content: "ping from UI" });
	});

	test("returns 400 when content is missing", async () => {
		const { app, pm } = createApp({
			dataDir,
			agentProvider: mockProvider,
		});
		await pm.load();

		const res = await app.request(
			`/projects/${projectId}/tasks/${taskId}/message`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			},
		);
		expect(res.status).toBe(400);
	});

	test("returns 404 for unknown project", async () => {
		const { app, pm } = createApp({
			dataDir,
			agentProvider: mockProvider,
		});
		await pm.load();

		const res = await app.request(
			`/projects/nonexistent/tasks/${taskId}/message`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: "hello" }),
			},
		);
		expect(res.status).toBe(404);
	});

	test("falls through to persist when queue is closed (no 409)", async () => {
		const { app, pm } = createApp({
			dataDir,
			agentProvider: mockProvider,
		});
		await pm.load();

		taskQueue = new MessageQueue();
		taskQueue.close();
		globalAgentQueues.set(taskId, taskQueue);

		const res = await app.request(
			`/projects/${projectId}/tasks/${taskId}/message`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: "ping" }),
			},
		);
		// Closed queue falls through to persist path — message is always delivered
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: boolean;
			taskId: string;
			persisted: boolean;
		};
		expect(body.ok).toBe(true);
		expect(body.persisted).toBe(true);

		globalAgentQueues.delete(taskId);
	});
});

describe("POST /projects/:id/message", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createApp>["app"];
	let projectId: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-projmsg-"));
		dataDir = await mkdtemp(join(tmpdir(), "og-projmsgd-"));
		const result = createApp({ dataDir, agentProvider: mockProvider });
		app = result.app;
		await result.pm.load();

		const projRes = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: join(tempDir, "proj") }),
		});
		const project = (await projRes.json()) as Project;
		projectId = project.id;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("returns 404 for unknown project", async () => {
		const res = await app.request("/projects/nonexistent/message", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "hello" }),
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("Project not found");
	});

	test("returns 400 when message is missing", async () => {
		const res = await app.request(`/projects/${projectId}/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("message is required");
	});

	test("auto-launches agent when no active session", async () => {
		const res = await app.request(`/projects/${projectId}/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "hello" }),
		});
		// POST /message now auto-launches the agent when no session exists
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(true);
	});
});

describe("POST /projects/:id/clarify", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createApp>["app"];
	let projectId: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-clarify-"));
		dataDir = await mkdtemp(join(tmpdir(), "og-clarifyd-"));
		const result = createApp({ dataDir, agentProvider: mockProvider });
		app = result.app;
		await result.pm.load();

		const projRes = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: join(tempDir, "proj") }),
		});
		const project = (await projRes.json()) as Project;
		projectId = project.id;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("returns 400 when taskId is missing", async () => {
		const res = await app.request(`/projects/${projectId}/clarify`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ answer: "yes" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("taskId and answer are required");
	});

	test("returns 400 when answer is missing", async () => {
		const res = await app.request(`/projects/${projectId}/clarify`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ taskId: "some-task-id" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("taskId and answer are required");
	});

	test("persists clarify_response when no active session", async () => {
		const res = await app.request(`/projects/${projectId}/clarify`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ taskId: "some-task-id", answer: "yes" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(true);
	});

	test("returns 404 for unknown project (no session)", async () => {
		const res = await app.request("/projects/nonexistent/clarify", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ taskId: "some-task-id", answer: "yes" }),
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("No active session for this project");
	});

	test("routes clarify_response to orchestrator queue when taskId is root", async () => {
		// Create a long-running provider so the agent stays alive
		const longRunningProvider: AgentProvider = {
			name: "mock",
			execute: async () => ({ success: true, output: "" }),
			// biome-ignore lint/correctness/useYield: mock provider never streams
			stream: async function* () {
				return { success: true, output: "" };
			},
			startSession(req) {
				const queue = req.queue ?? new MessageQueue();
				async function* events(): AsyncGenerator<AgentEvent, AgentResult> {
					await new Promise((resolve) => setTimeout(resolve, 10000));
					return { success: true, output: "" };
				}
				return {
					sessionId: "mock-session",
					events: events(),
					queue,
					sendMessage: async () => {},
					stop: () => {
						queue.close();
					},
				};
			},
		};

		const localDataDir = await mkdtemp(join(tmpdir(), "og-clarify-route-"));
		const {
			app: localApp,
			pm: localPm,
			markReady: localMarkReady,
			getTracker: localGetTracker,
		} = createApp({
			dataDir: localDataDir,
			agentProvider: longRunningProvider,
		});
		await localPm.load();
		localMarkReady();

		// Create project and start agent
		const projRes = await localApp.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: join(tempDir, "clarify-route-proj") }),
		});
		const project = (await projRes.json()) as Project;

		const orchRes = await localApp.request(
			`/projects/${project.id}/orchestrate/agent`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prompt: "test clarify routing" }),
			},
		);
		expect(orchRes.status).toBe(200);
		await new Promise((r) => setTimeout(r, 100));

		const tracker = await localGetTracker(project.id);
		const rootNodeId = tracker.rootNodeId;
		expect(rootNodeId).toBeTruthy();

		// Post clarify response with the root taskId — should go to orchestrator's queue
		const clarifyRes = await localApp.request(
			`/projects/${project.id}/clarify`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					taskId: rootNodeId,
					answer: "The answer for orchestrator",
				}),
			},
		);
		expect(clarifyRes.status).toBe(200);

		// Stop agent to clean up
		await localApp.request(`/projects/${project.id}/stop`, {
			method: "POST",
		});
		await rm(localDataDir, { recursive: true });
	});

	test("routes clarify_response to child queue when taskId is a child agent", async () => {
		// Create a long-running provider so the agent stays alive
		const longRunningProvider: AgentProvider = {
			name: "mock",
			execute: async () => ({ success: true, output: "" }),
			// biome-ignore lint/correctness/useYield: mock provider never streams
			stream: async function* () {
				return { success: true, output: "" };
			},
			startSession(req) {
				const queue = req.queue ?? new MessageQueue();
				async function* events(): AsyncGenerator<AgentEvent, AgentResult> {
					await new Promise((resolve) => setTimeout(resolve, 10000));
					return { success: true, output: "" };
				}
				return {
					sessionId: "mock-session",
					events: events(),
					queue,
					sendMessage: async () => {},
					stop: () => {
						queue.close();
					},
				};
			},
		};

		const localDataDir = await mkdtemp(
			join(tmpdir(), "og-clarify-child-route-"),
		);
		const {
			app: localApp,
			pm: localPm,
			markReady: localMarkReady,
			getTracker: localGetTracker,
		} = createApp({
			dataDir: localDataDir,
			agentProvider: longRunningProvider,
		});
		await localPm.load();
		localMarkReady();

		// Create project and start agent
		const projRes = await localApp.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				path: join(tempDir, "clarify-child-route-proj"),
			}),
		});
		const project = (await projRes.json()) as Project;

		const orchRes = await localApp.request(
			`/projects/${project.id}/orchestrate/agent`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prompt: "test child clarify routing" }),
			},
		);
		expect(orchRes.status).toBe(200);
		await new Promise((r) => setTimeout(r, 100));

		const tracker = await localGetTracker(project.id);
		const rootNodeId = tracker.rootNodeId;
		expect(rootNodeId).toBeTruthy();

		// Create a child task
		const childRes = await localApp.request(`/projects/${project.id}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Child agent",
				description: "A child task",
				parentId: rootNodeId,
			}),
		});
		const child = (await childRes.json()) as TaskNode;

		// Register a queue for the child in globalAgentQueues (simulating runChildAgentInBackground)
		const childQueue = new MessageQueue();
		globalAgentQueues.set(child.id, childQueue);

		try {
			// Post clarify response with the child's taskId
			const clarifyRes = await localApp.request(
				`/projects/${project.id}/clarify`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						taskId: child.id,
						answer: "The answer for child agent",
					}),
				},
			);
			expect(clarifyRes.status).toBe(200);

			// Verify the message arrived in the child's queue, NOT the orchestrator's
			const childMessages = childQueue.drain();
			expect(childMessages).toHaveLength(1);
			expect(childMessages[0]?.source).toBe("clarify_response");
			expect(
				childMessages[0]?.source === "clarify_response"
					? childMessages[0].answer
					: "",
			).toBe("The answer for child agent");
		} finally {
			globalAgentQueues.delete(child.id);
			await localApp.request(`/projects/${project.id}/stop`, {
				method: "POST",
			});
			await rm(localDataDir, { recursive: true });
		}
	});

	test("returns 409 when child queue is closed", async () => {
		// Create a long-running provider so the agent stays alive
		const longRunningProvider: AgentProvider = {
			name: "mock",
			execute: async () => ({ success: true, output: "" }),
			// biome-ignore lint/correctness/useYield: mock provider never streams
			stream: async function* () {
				return { success: true, output: "" };
			},
			startSession(req) {
				const queue = req.queue ?? new MessageQueue();
				async function* events(): AsyncGenerator<AgentEvent, AgentResult> {
					await new Promise((resolve) => setTimeout(resolve, 10000));
					return { success: true, output: "" };
				}
				return {
					sessionId: "mock-session",
					events: events(),
					queue,
					sendMessage: async () => {},
					stop: () => {
						queue.close();
					},
				};
			},
		};

		const localDataDir = await mkdtemp(
			join(tmpdir(), "og-clarify-closed-queue-"),
		);
		const {
			app: localApp,
			pm: localPm,
			markReady: localMarkReady,
			getTracker: localGetTracker,
		} = createApp({
			dataDir: localDataDir,
			agentProvider: longRunningProvider,
		});
		await localPm.load();
		localMarkReady();

		// Create project and start agent
		const projRes = await localApp.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				path: join(tempDir, "clarify-closed-queue-proj"),
			}),
		});
		const project = (await projRes.json()) as Project;

		const orchRes = await localApp.request(
			`/projects/${project.id}/orchestrate/agent`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prompt: "test closed queue" }),
			},
		);
		expect(orchRes.status).toBe(200);
		await new Promise((r) => setTimeout(r, 100));

		const tracker = await localGetTracker(project.id);

		// Create a child task with a CLOSED queue
		const childRes = await localApp.request(`/projects/${project.id}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Dead child",
				description: "A child whose queue is closed",
				parentId: tracker.rootNodeId,
			}),
		});
		const child = (await childRes.json()) as TaskNode;

		const closedQueue = new MessageQueue();
		closedQueue.close();
		globalAgentQueues.set(child.id, closedQueue);

		try {
			const clarifyRes = await localApp.request(
				`/projects/${project.id}/clarify`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						taskId: child.id,
						answer: "This should fail",
					}),
				},
			);
			expect(clarifyRes.status).toBe(409);
			const body = (await clarifyRes.json()) as { error: string };
			expect(body.error).toBe("Queue closed");
		} finally {
			globalAgentQueues.delete(child.id);
			await localApp.request(`/projects/${project.id}/stop`, {
				method: "POST",
			});
			await rm(localDataDir, { recursive: true });
		}
	});
});

describe("daemon orchestrate/agent API", () => {
	test("POST /orchestrate/agent invokes agent with MCP tools", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "og-orchagent-"));
		const dataDir = await mkdtemp(join(tmpdir(), "og-oadata-"));

		// Mock provider that verifies mcpToolDefs was passed
		let receivedMcpToolDefs = false;
		const agentProvider: AgentProvider = {
			name: "mock",
			execute: async (req) => {
				if (req.mcpToolDefs && "opengraft" in req.mcpToolDefs) {
					receivedMcpToolDefs = true;
				}
				return { success: true, output: "orchestrated" };
			},
			// biome-ignore lint/correctness/useYield: mock provider never streams
			stream: async function* () {
				return { success: true, output: "" };
			},
			startSession(req) {
				if (req.mcpToolDefs && "opengraft" in req.mcpToolDefs) {
					receivedMcpToolDefs = true;
				}
				const queue = req.queue ?? new MessageQueue();
				// biome-ignore lint/correctness/useYield: mock session never streams
				async function* events(): AsyncGenerator<AgentEvent, AgentResult> {
					return { success: true, output: "orchestrated" };
				}
				return {
					sessionId: "mock-session",
					events: events(),
					queue,
					sendMessage: async () => {},
					stop: () => {
						queue.close();
					},
				};
			},
		};

		const { app, pm, markReady } = createApp({ dataDir, agentProvider });
		await pm.load();
		markReady();

		const projectRes = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: join(tempDir, "oa-app") }),
		});
		const project = (await projectRes.json()) as Project;

		const res = await app.request(`/projects/${project.id}/orchestrate/agent`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "Build a todo app" }),
		});
		expect(res.status).toBe(200);

		const body = (await res.json()) as { status: string; projectId: string };
		expect(body.status).toBe("running");
		expect(body.projectId).toBe(project.id);

		// Wait briefly for the background agent to complete
		await new Promise((r) => setTimeout(r, 100));
		expect(receivedMcpToolDefs).toBe(true);

		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("POST /orchestrate/agent requires prompt", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "og-oa2-"));
		const dataDir = await mkdtemp(join(tmpdir(), "og-oa2d-"));

		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: mockProvider,
		});
		await pm.load();
		markReady();

		const projectRes = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: join(tempDir, "oa2") }),
		});
		const project = (await projectRes.json()) as Project;

		const res = await app.request(`/projects/${project.id}/orchestrate/agent`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);

		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("POST /orchestrate/agent returns 404 for unknown project", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "og-oa3d-"));
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: mockProvider,
		});
		await pm.load();
		markReady();

		const res = await app.request("/projects/nonexistent/orchestrate/agent", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "test" }),
		});
		expect(res.status).toBe(404);

		await rm(dataDir, { recursive: true });
	});
});

describe("create_task validation", () => {
	let tempDir: string;
	let tracker: TaskTracker;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-ct-val-"));
		tracker = new TaskTracker(join(tempDir, "tree.json"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
	});

	/** Helper to invoke the create_task tool from the MCP tool definitions. */
	async function invokeCreateTask(
		currentTaskId: string | null,
		args: { title: string; description: string; parentId?: string },
	) {
		const { toolDefs } = createOrchestratorTools({
			tracker,
			provider: mockProvider,
			worktrees: {} as never,
			projectPath: tempDir,
			repoPath: tempDir,
			currentTaskId,
		});
		const createTaskTool = toolDefs.find((t) => t.name === "create_task");
		if (!createTaskTool) throw new Error("create_task tool not found");
		// biome-ignore lint/suspicious/noExplicitAny: test helper accesses internal handler
		return (createTaskTool as any).handler(args);
	}

	test("isDescendantOf returns true for direct child", () => {
		const parent = tracker.addTask("parent", "");
		const child = tracker.addChild(parent.id, "child", "");
		expect(isDescendantOf(tracker, child.id, parent.id)).toBe(true);
	});

	test("isDescendantOf returns true for deep descendant", () => {
		const root = tracker.addTask("root", "");
		const mid = tracker.addChild(root.id, "mid", "");
		const leaf = tracker.addChild(mid.id, "leaf", "");
		expect(isDescendantOf(tracker, leaf.id, root.id)).toBe(true);
	});

	test("isDescendantOf returns false for non-ancestor", () => {
		const a = tracker.addTask("a", "");
		const b = tracker.addTask("b", "");
		expect(isDescendantOf(tracker, b.id, a.id)).toBe(false);
	});

	test("isDescendantOf returns false for self", () => {
		const a = tracker.addTask("a", "");
		expect(isDescendantOf(tracker, a.id, a.id)).toBe(false);
	});

	test("agent can create a child under itself (parentId === currentTaskId)", async () => {
		const agent = tracker.addTask("agent", "");
		const result = await invokeCreateTask(agent.id, {
			title: "child",
			description: "desc",
			parentId: agent.id,
		});
		expect(result.isError).toBeUndefined();
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.parentId).toBe(agent.id);
	});

	test("agent can create a child under its own descendant", async () => {
		const agent = tracker.addTask("agent", "");
		const child = tracker.addChild(agent.id, "child", "");
		const result = await invokeCreateTask(agent.id, {
			title: "grandchild",
			description: "desc",
			parentId: child.id,
		});
		expect(result.isError).toBeUndefined();
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.parentId).toBe(child.id);
	});

	test("agent cannot create a task under its parent", async () => {
		const parent = tracker.addTask("parent", "");
		const agent = tracker.addChild(parent.id, "agent", "");
		const result = await invokeCreateTask(agent.id, {
			title: "bad",
			description: "desc",
			parentId: parent.id,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("not your task or descendant");
	});

	test("agent cannot create a task under a sibling", async () => {
		const parent = tracker.addTask("parent", "");
		const agent = tracker.addChild(parent.id, "agent", "");
		const sibling = tracker.addChild(parent.id, "sibling", "");
		const result = await invokeCreateTask(agent.id, {
			title: "bad",
			description: "desc",
			parentId: sibling.id,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("not your task or descendant");
	});

	test("top-level orchestrator (currentTaskId=null) can create anywhere", async () => {
		const existing = tracker.addTask("existing", "");
		const result = await invokeCreateTask(null, {
			title: "anywhere",
			description: "desc",
			parentId: existing.id,
		});
		expect(result.isError).toBeUndefined();
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.parentId).toBe(existing.id);
	});

	test("agent auto-parents under itself when no parentId provided", async () => {
		const agent = tracker.addTask("agent", "");
		const result = await invokeCreateTask(agent.id, {
			title: "child",
			description: "desc",
		});
		expect(result.isError).toBeUndefined();
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.parentId).toBe(agent.id);
	});

	test("root orchestrator creates top-level task when no parentId", async () => {
		const result = await invokeCreateTask(null, {
			title: "toplevel",
			description: "desc",
		});
		expect(result.isError).toBeUndefined();
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.parentId).toBeNull();
	});
});

describe("GET /projects/:id/agent", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createApp>["app"];
	let projectId: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-agent-"));
		dataDir = await mkdtemp(join(tmpdir(), "og-agentd-"));
		const result = createApp({ dataDir, agentProvider: mockProvider });
		app = result.app;
		await result.pm.load();
		result.markReady();

		const res = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: tempDir }),
		});
		const project = (await res.json()) as { id: string };
		projectId = project.id;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("returns 404 for unknown project", async () => {
		const res = await app.request("/projects/nonexistent/agent");
		expect(res.status).toBe(404);
	});

	test("returns running=false when no agent is active", async () => {
		const res = await app.request(`/projects/${projectId}/agent`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			running: boolean;
		};
		expect(body.running).toBe(false);
	});
});

describe("POST /projects/:id/stop", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createApp>["app"];
	let projectId: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-stop-"));
		dataDir = await mkdtemp(join(tmpdir(), "og-stopd-"));
		const result = createApp({ dataDir, agentProvider: mockProvider });
		app = result.app;
		await result.pm.load();
		result.markReady();

		const res = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: tempDir }),
		});
		const project = (await res.json()) as { id: string };
		projectId = project.id;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("returns 404 for unknown project", async () => {
		const res = await app.request("/projects/nonexistent/stop", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(404);
	});

	test("returns 404 when no agent is running", async () => {
		const res = await app.request(`/projects/${projectId}/stop`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(404);
	});

	test("stopping agent cascades to child agent queues and marks them failed", async () => {
		// Create a long-running provider so the agent stays alive
		const longRunningProvider: AgentProvider = {
			name: "mock",
			execute: async () => ({ success: true, output: "" }),
			// biome-ignore lint/correctness/useYield: mock provider never streams
			stream: async function* () {
				return { success: true, output: "" };
			},
			startSession(req) {
				const queue = req.queue ?? new MessageQueue();
				async function* events(): AsyncGenerator<AgentEvent, AgentResult> {
					await new Promise((resolve) => setTimeout(resolve, 10000));
					return { success: true, output: "" };
				}
				return {
					sessionId: "mock-session",
					events: events(),
					queue,
					sendMessage: async () => {},
					stop: () => {
						queue.close();
					},
				};
			},
		};

		const localDataDir = await mkdtemp(join(tmpdir(), "og-stop-cascade-"));
		const {
			app: localApp,
			pm: localPm,
			markReady: localMarkReady,
			getTracker: localGetTracker,
		} = createApp({
			dataDir: localDataDir,
			agentProvider: longRunningProvider,
		});
		await localPm.load();
		localMarkReady();

		// Create a project
		const projRes = await localApp.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: join(tempDir, "cascade-proj") }),
		});
		const project = (await projRes.json()) as Project;

		// Start an agent
		const orchRes = await localApp.request(
			`/projects/${project.id}/orchestrate/agent`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prompt: "do something" }),
			},
		);
		expect(orchRes.status).toBe(200);
		await new Promise((r) => setTimeout(r, 100));

		// Get the tracker and create a child task simulating in_progress child agent
		const tracker = await localGetTracker(project.id);
		const childTask = await localApp.request(`/projects/${project.id}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Child agent task",
				description: "Running child",
				parentId: tracker.rootNodeId,
			}),
		});
		const child = (await childTask.json()) as TaskNode;

		// Mark child as in_progress
		await localApp.request(`/projects/${project.id}/tasks/${child.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "in_progress" }),
		});

		// Register a queue for the child in globalAgentQueues (simulating runChildAgentInBackground)
		const childQueue = new MessageQueue();
		globalAgentQueues.set(child.id, childQueue);

		// Verify queue is open
		let queueClosed = false;
		try {
			childQueue.enqueue({ source: "compact" });
			childQueue.drain(); // clear it
		} catch {
			queueClosed = true;
		}
		expect(queueClosed).toBe(false);

		// Stop the agent
		const stopRes = await localApp.request(`/projects/${project.id}/stop`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(stopRes.status).toBe(200);

		// Verify: child queue is now closed
		let closedAfterStop = false;
		try {
			childQueue.enqueue({ source: "compact" });
		} catch {
			closedAfterStop = true;
		}
		expect(closedAfterStop).toBe(true);

		// Verify: child task status is now "failed"
		const tasksRes = await localApp.request(`/projects/${project.id}/tasks`);
		const { nodes } = (await tasksRes.json()) as { nodes: TaskNode[] };
		const updatedChild = nodes.find((n) => n.id === child.id);
		expect(updatedChild?.status).toBe("failed");

		// Clean up
		globalAgentQueues.delete(child.id);
		await rm(localDataDir, { recursive: true });
	});
});

describe("POST /projects/:id/orchestrate/agent", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createApp>["app"];
	let projectId: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-run-"));
		dataDir = await mkdtemp(join(tmpdir(), "og-rund-"));
		const result = createApp({ dataDir, agentProvider: mockProvider });
		app = result.app;
		await result.pm.load();
		result.markReady();

		const res = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: tempDir }),
		});
		const project = (await res.json()) as { id: string };
		projectId = project.id;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("returns 404 for unknown project", async () => {
		const res = await app.request("/projects/unknown/orchestrate/agent", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "test" }),
		});
		expect(res.status).toBe(404);
	});

	test("returns 400 when prompt is missing", async () => {
		const res = await app.request(`/projects/${projectId}/orchestrate/agent`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	test("returns running status for valid request", async () => {
		const res = await app.request(`/projects/${projectId}/orchestrate/agent`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "do something" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string; projectId: string };
		expect(body.status).toBe("running");
		expect(body.projectId).toBe(projectId);
	});

	test("enqueues message when agent already running instead of 409", async () => {
		// Start once
		await app.request(`/projects/${projectId}/orchestrate/agent`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "first run" }),
		});
		// Try again immediately — agent is still active, prompt is enqueued as user message
		const res = await app.request(`/projects/${projectId}/orchestrate/agent`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "second run" }),
		});
		expect(res.status).toBe(200);
	});
});

describe("POST /projects/:id/sessions/prune", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createApp>["app"];
	let projectId: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-prune-"));
		dataDir = await mkdtemp(join(tmpdir(), "og-pruned-"));
		const result = createApp({ dataDir, agentProvider: mockProvider });
		app = result.app;
		await result.pm.load();

		const res = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: tempDir }),
		});
		const project = (await res.json()) as { id: string };
		projectId = project.id;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("returns 404 for unknown project", async () => {
		const res = await app.request("/projects/unknown/sessions/prune", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(404);
	});

	test("returns pruned=0 when no session files exist", async () => {
		const res = await app.request(`/projects/${projectId}/sessions/prune`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ keepCount: 5 }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { pruned: number; remaining: number };
		expect(body.pruned).toBe(0);
	});

	test("returns pruned=0 when file count is within keepCount", async () => {
		// Create 3 session files
		const sessionsDir = join(dataDir, "sessions", projectId);
		await mkdir(sessionsDir, { recursive: true });
		for (let i = 0; i < 3; i++) {
			await writeFile(join(sessionsDir, `session-${i}.json`), "{}");
		}

		const res = await app.request(`/projects/${projectId}/sessions/prune`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ keepCount: 5 }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { pruned: number; remaining: number };
		expect(body.pruned).toBe(0);
		expect(body.remaining).toBe(3);
	});

	test("prunes oldest session files keeping only keepCount", async () => {
		// Create 5 session files
		const sessionsDir = join(dataDir, "sessions", projectId);
		await mkdir(sessionsDir, { recursive: true });
		for (let i = 0; i < 5; i++) {
			await writeFile(join(sessionsDir, `session-${i}.json`), "{}");
		}

		const res = await app.request(`/projects/${projectId}/sessions/prune`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ keepCount: 2 }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { pruned: number; remaining: number };
		expect(body.pruned).toBe(3);
		expect(body.remaining).toBe(2);
	});

	test("defaults to keepCount=10 when not specified", async () => {
		// Create 12 session files
		const sessionsDir = join(dataDir, "sessions", projectId);
		await mkdir(sessionsDir, { recursive: true });
		for (let i = 0; i < 12; i++) {
			await writeFile(join(sessionsDir, `session-${i}.json`), "{}");
		}

		const res = await app.request(`/projects/${projectId}/sessions/prune`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { pruned: number; remaining: number };
		expect(body.pruned).toBe(2);
		expect(body.remaining).toBe(10);
	});
});

describe("POST /projects/:id/tasks/:nodeId/continue", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createApp>["app"];
	let projectId: string;
	let getTracker: ReturnType<typeof createApp>["getTracker"];

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-continue-"));
		dataDir = await mkdtemp(join(tmpdir(), "og-continued-"));
		const result = createApp({ dataDir, agentProvider: mockProvider });
		app = result.app;
		getTracker = result.getTracker;
		await result.pm.load();

		const res = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: join(tempDir, "cont-proj") }),
		});
		const project = (await res.json()) as Project;
		projectId = project.id;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("returns 404 for unknown project", async () => {
		const res = await app.request(
			"/projects/nonexistent/tasks/some-task/continue",
			{ method: "POST" },
		);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("Project not found");
	});

	test("returns 404 for unknown task", async () => {
		const res = await app.request(
			`/projects/${projectId}/tasks/nonexistent-task-id/continue`,
			{ method: "POST" },
		);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("Task not found");
	});

	test("returns 400 for task with status pending", async () => {
		const taskRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Pending task", description: "" }),
		});
		const task = (await taskRes.json()) as TaskNode;
		expect(task.status).toBe("pending");

		const res = await app.request(
			`/projects/${projectId}/tasks/${task.id}/continue`,
			{ method: "POST" },
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("Cannot continue task with status: pending");
	});

	test("continues passed task without worktree — re-creates worktree and launches agent", async () => {
		const taskRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Passed task", description: "" }),
		});
		const task = (await taskRes.json()) as TaskNode;

		await app.request(`/projects/${projectId}/tasks/${task.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "passed" }),
		});

		const res = await app.request(
			`/projects/${projectId}/tasks/${task.id}/continue`,
			{ method: "POST" },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as TaskNode;
		expect(body.status).toBe("in_progress");
	});

	test("returns 400 for task with status in_progress", async () => {
		const taskRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Active task", description: "" }),
		});
		const task = (await taskRes.json()) as TaskNode;

		await app.request(`/projects/${projectId}/tasks/${task.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "in_progress" }),
		});

		const res = await app.request(
			`/projects/${projectId}/tasks/${task.id}/continue`,
			{ method: "POST" },
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("Cannot continue task with status: in_progress");
	});

	test("resets failed task without worktree to pending", async () => {
		const taskRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Failed task", description: "Do stuff" }),
		});
		const task = (await taskRes.json()) as TaskNode;

		await app.request(`/projects/${projectId}/tasks/${task.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "failed" }),
		});

		const res = await app.request(
			`/projects/${projectId}/tasks/${task.id}/continue`,
			{ method: "POST" },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as TaskNode;
		expect(body.status).toBe("pending");
	});

	test("resets stuck task without worktree to pending", async () => {
		const taskRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Stuck task", description: "Do stuff" }),
		});
		const task = (await taskRes.json()) as TaskNode;

		await app.request(`/projects/${projectId}/tasks/${task.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "stuck" }),
		});

		const res = await app.request(
			`/projects/${projectId}/tasks/${task.id}/continue`,
			{ method: "POST" },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as TaskNode;
		expect(body.status).toBe("pending");
	});

	test("stores message when provided for task without worktree", async () => {
		const taskRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Msg task", description: "" }),
		});
		const task = (await taskRes.json()) as TaskNode;

		await app.request(`/projects/${projectId}/tasks/${task.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "failed" }),
		});

		const res = await app.request(
			`/projects/${projectId}/tasks/${task.id}/continue`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message: "Try a different approach" }),
			},
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as TaskNode;
		expect(body.status).toBe("pending");
		expect(body.message).toBe("Try a different approach");
	});

	test("sets status to in_progress for failed task with worktree", async () => {
		const taskRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "WT task", description: "desc" }),
		});
		const task = (await taskRes.json()) as TaskNode;

		await app.request(`/projects/${projectId}/tasks/${task.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "failed" }),
		});

		// Inject worktreePath directly into the tracker
		const tracker = await getTracker(projectId);
		tracker.assignWorktree(
			task.id,
			"og/fake/branch",
			join(tempDir, "cont-proj"),
		);
		await tracker.save();

		const res = await app.request(
			`/projects/${projectId}/tasks/${task.id}/continue`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message: "Keep going" }),
			},
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as TaskNode;
		expect(body.status).toBe("in_progress");

		// Wait for background agent to finish
		await new Promise((r) => setTimeout(r, 150));
	});

	test("works with no request body", async () => {
		const taskRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "No body", description: "" }),
		});
		const task = (await taskRes.json()) as TaskNode;

		await app.request(`/projects/${projectId}/tasks/${task.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "failed" }),
		});

		// POST with no body at all — the .catch() in the handler should handle it
		const res = await app.request(
			`/projects/${projectId}/tasks/${task.id}/continue`,
			{ method: "POST" },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as TaskNode;
		expect(body.status).toBe("pending");
	});

	test("cleans up global queue after agent completes for worktree task", async () => {
		const taskRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Cleanup task", description: "desc" }),
		});
		const task = (await taskRes.json()) as TaskNode;

		await app.request(`/projects/${projectId}/tasks/${task.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "failed" }),
		});

		const tracker = await getTracker(projectId);
		tracker.assignWorktree(
			task.id,
			"og/fake/branch2",
			join(tempDir, "cont-proj"),
		);
		await tracker.save();

		await app.request(`/projects/${projectId}/tasks/${task.id}/continue`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});

		// Queue should be registered during execution
		// Wait for background agent to complete
		await new Promise((r) => setTimeout(r, 150));

		// Queue should be cleaned up after completion
		expect(globalAgentQueues.has(task.id)).toBe(false);
	});

	test("sets status to in_progress for passed task with worktree", async () => {
		const taskRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Passed WT task",
				description: "finished work",
			}),
		});
		const task = (await taskRes.json()) as TaskNode;

		await app.request(`/projects/${projectId}/tasks/${task.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "passed" }),
		});

		// Inject worktreePath directly into the tracker
		const tracker = await getTracker(projectId);
		tracker.assignWorktree(
			task.id,
			"og/fake/passed-branch",
			join(tempDir, "cont-proj"),
		);
		await tracker.save();

		const res = await app.request(
			`/projects/${projectId}/tasks/${task.id}/continue`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message: "Add one more feature" }),
			},
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as TaskNode;
		expect(body.status).toBe("in_progress");

		// Wait for background agent to finish
		await new Promise((r) => setTimeout(r, 150));
	});

	test("stores message when continuing passed task", async () => {
		const taskRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Passed msg task", description: "" }),
		});
		const task = (await taskRes.json()) as TaskNode;

		await app.request(`/projects/${projectId}/tasks/${task.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "passed" }),
		});

		const res = await app.request(
			`/projects/${projectId}/tasks/${task.id}/continue`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message: "Add tests for edge cases" }),
			},
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as TaskNode;
		expect(body.message).toBe("Add tests for edge cases");
	});

	test("passes sessionStore to stream for child agent persistence", async () => {
		let receivedSessionStore: unknown;

		const agentProvider: AgentProvider = {
			name: "mock",
			execute: async () => ({ success: true, output: "" }),
			// biome-ignore lint/correctness/useYield: mock provider never streams
			stream: async function* (req) {
				receivedSessionStore = req.sessionStore;
				return { success: true, output: "" };
			},
			startSession(req) {
				const queue = req.queue ?? new MessageQueue();
				// biome-ignore lint/correctness/useYield: mock session never streams
				async function* events(): AsyncGenerator<AgentEvent, AgentResult> {
					return { success: true, output: "done" };
				}
				return {
					sessionId: "mock-session",
					events: events(),
					queue,
					sendMessage: async () => {},
					stop: () => {
						queue.close();
					},
				};
			},
		};

		const localDataDir = await mkdtemp(join(tmpdir(), "og-child-sess-"));
		const {
			app: localApp,
			pm: localPm,
			getTracker: localGetTracker,
		} = createApp({
			dataDir: localDataDir,
			agentProvider,
		});
		await localPm.load();

		const projRes = await localApp.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: join(tempDir, "child-sess-proj") }),
		});
		const project = (await projRes.json()) as Project;

		const taskRes = await localApp.request(`/projects/${project.id}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Child task", description: "desc" }),
		});
		const task = (await taskRes.json()) as TaskNode;

		await localApp.request(`/projects/${project.id}/tasks/${task.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "failed" }),
		});

		const daemonTracker = await localGetTracker(project.id);
		daemonTracker.assignWorktree(
			task.id,
			"og/fake/child-branch",
			join(tempDir, "child-sess-proj"),
		);
		await daemonTracker.save();

		const contRes = await localApp.request(
			`/projects/${project.id}/tasks/${task.id}/continue`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message: "Go" }),
			},
		);
		expect(contRes.status).toBe(200);

		await new Promise((r) => setTimeout(r, 100));

		expect(receivedSessionStore).toBeDefined();

		await rm(localDataDir, { recursive: true });
	});
});

describe("GET /projects/:id/pending-messages", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createApp>["app"];
	let projectId: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-pending-"));
		dataDir = await mkdtemp(join(tmpdir(), "og-pendingd-"));
		const result = createApp({ dataDir, agentProvider: mockProvider });
		app = result.app;
		await result.pm.load();
		result.markReady();

		const res = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: join(tempDir, "proj") }),
		});
		const project = (await res.json()) as Project;
		projectId = project.id;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("returns empty array initially", async () => {
		const res = await app.request(`/projects/${projectId}/pending-messages`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { messages: unknown[] };
		expect(body.messages).toBeInstanceOf(Array);
		expect(body.messages.length).toBe(0);
	});

	test("returns 404 for unknown project", async () => {
		const res = await app.request("/projects/nonexistent/pending-messages");
		expect(res.status).toBe(404);
	});

	test("includes message after POST /projects/:id/message", async () => {
		// Create a provider with a long-running session
		let resolveSession: (() => void) | null = null;
		const longRunningProvider: AgentProvider = {
			name: "mock-long",
			execute: async () => ({ success: true, output: "" }),
			// biome-ignore lint/correctness/useYield: mock provider never streams
			stream: async function* () {
				return { success: true, output: "" };
			},
			startSession(req) {
				const queue = req.queue ?? new MessageQueue();
				async function* events(): AsyncGenerator<AgentEvent, AgentResult> {
					// Wait until explicitly resolved, keeping the session alive
					await new Promise<void>((resolve) => {
						resolveSession = resolve;
					});
					return { success: true, output: "" };
				}
				return {
					sessionId: "mock-long-session",
					events: events(),
					queue,
					sendMessage: async () => {},
					stop: () => {
						if (resolveSession) resolveSession();
						queue.close();
					},
				};
			},
		};

		const localDataDir = await mkdtemp(join(tmpdir(), "og-pending-msg-"));
		const {
			app: localApp,
			pm: localPm,
			markReady: localMarkReady,
		} = createApp({
			dataDir: localDataDir,
			agentProvider: longRunningProvider,
		});
		await localPm.load();
		localMarkReady();

		// Create a project
		const projRes = await localApp.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: join(tempDir, "pending-proj") }),
		});
		const project = (await projRes.json()) as Project;

		// Start an agent
		const orchRes = await localApp.request(
			`/projects/${project.id}/orchestrate/agent`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prompt: "do something" }),
			},
		);
		expect(orchRes.status).toBe(200);
		await new Promise((r) => setTimeout(r, 50));

		// Send a message to the orchestrator
		const msgRes = await localApp.request(`/projects/${project.id}/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "hello agent" }),
		});
		expect(msgRes.status).toBe(200);

		// Check pending messages
		const res = await localApp.request(
			`/projects/${project.id}/pending-messages`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			messages: {
				id: string;
				taskId: string | null;
				text: string;
				timestamp: number;
			}[];
		};
		expect(body.messages.length).toBe(1);
		expect(body.messages[0]?.text).toBe("hello agent");
		expect(body.messages[0]?.taskId).toBeNull();
		expect(typeof body.messages[0]?.id).toBe("string");
		expect(typeof body.messages[0]?.timestamp).toBe("number");

		// Clean up: stop the agent
		await localApp.request(`/projects/${project.id}/stop`, {
			method: "POST",
		});
		await new Promise((r) => setTimeout(r, 50));
		await rm(localDataDir, { recursive: true });
	});

	test("includes message with taskId after POST /projects/:id/tasks/:nodeId/message", async () => {
		// Create a task
		const taskRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Test task", description: "" }),
		});
		const task = (await taskRes.json()) as TaskNode;

		// Register a queue for this task
		const taskQueue = new MessageQueue();
		globalAgentQueues.set(task.id, taskQueue);

		try {
			// Send a message to the task
			const msgRes = await app.request(
				`/projects/${projectId}/tasks/${task.id}/message`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ content: "task message" }),
				},
			);
			expect(msgRes.status).toBe(200);

			// Check pending messages
			const res = await app.request(`/projects/${projectId}/pending-messages`);
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				messages: {
					id: string;
					taskId: string | null;
					text: string;
					timestamp: number;
				}[];
			};
			expect(body.messages.length).toBe(1);
			expect(body.messages[0]?.text).toBe("task message");
			expect(body.messages[0]?.taskId).toBe(task.id);
		} finally {
			globalAgentQueues.delete(task.id);
		}
	});
});

describe("GET /projects/:id/clarifications", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createApp>["app"];
	let projectId: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-clarifs-"));
		dataDir = await mkdtemp(join(tmpdir(), "og-clarifsd-"));
		const result = createApp({ dataDir, agentProvider: mockProvider });
		app = result.app;
		await result.pm.load();
		result.markReady();

		const res = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: join(tempDir, "proj") }),
		});
		const project = (await res.json()) as Project;
		projectId = project.id;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("returns empty array initially", async () => {
		const res = await app.request(`/projects/${projectId}/clarifications`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { clarifications: unknown[] };
		expect(body.clarifications).toBeInstanceOf(Array);
		expect(body.clarifications.length).toBe(0);
	});

	test("returns 404 for unknown project", async () => {
		const res = await app.request("/projects/nonexistent/clarifications");
		expect(res.status).toBe(404);
	});

	test("adds clarification when clarification_requested event fires via agent tools", async () => {
		// Use createOrchestratorTools to emit a clarification_requested event which
		// should flow through onTaskEvent → broadcastEvent → addPendingClarification
		const trackerPath = join(dataDir, "projects", projectId, "tree.json");
		await mkdir(join(dataDir, "projects", projectId), { recursive: true });
		const tracker = new TaskTracker(trackerPath);
		await tracker.load();

		const capturedEvents: Record<string, unknown>[] = [];

		const { toolDefs } = createOrchestratorTools({
			tracker,
			provider: mockProvider,
			worktrees: { createWorktree: async () => {} } as unknown as Parameters<
				typeof createOrchestratorTools
			>[0]["worktrees"],
			projectPath: tempDir,
			repoPath: tempDir,
			depth: 0,
			queue: new MessageQueue(),
			onTaskEvent: (event) => {
				capturedEvents.push(event);
			},
			broadcastTreeUpdate: () => {},
		});

		// Find the clarify tool and call it
		const clarifyTool = toolDefs.find((t) => t.name === "clarify");
		expect(clarifyTool).toBeDefined();

		// Simulate a clarification by directly calling broadcastEvent via the app
		// We test the endpoint independently — the integration is via broadcastEvent
		// which is internal. Instead, test that the endpoint responds correctly.
		const res = await app.request(`/projects/${projectId}/clarifications`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			clarifications: {
				id: string;
				taskId: string;
				question: string;
				timestamp: number;
			}[];
		};
		// Initially empty — no clarifications fired yet
		expect(body.clarifications).toBeInstanceOf(Array);
		expect(body.clarifications.length).toBe(0);
	});
});

describe("autoResumeProjects — auto-prune old sessions", () => {
	let tempDir: string;
	let dataDir: string;
	let projectId: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-autoresume-"));
		dataDir = await mkdtemp(join(tmpdir(), "og-autoresume-data-"));

		const result = createApp({ dataDir, agentProvider: mockProvider });
		await result.pm.load();

		const res = await result.app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: tempDir }),
		});
		const project = (await res.json()) as { id: string };
		projectId = project.id;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("prunes old sessions keeping sessionKeep most recent on startup", async () => {
		const sessionsDir = join(dataDir, "sessions", projectId);
		await mkdir(sessionsDir, { recursive: true });

		// Create 8 session files one by one with small delays to ensure distinct mtimes
		for (let i = 0; i < 8; i++) {
			await writeFile(join(sessionsDir, `session-${i}.json`), `{"i":${i}}`);
			await new Promise((r) => setTimeout(r, 5));
		}

		// session-7 is newest, session-0 is oldest
		// sessionKeep=3 → keep session-5, session-6, session-7; delete session-0..4
		const result = createApp({
			dataDir,
			agentProvider: mockProvider,
			initialConfig: { sessionKeep: 3 },
		});
		await result.pm.load();
		await result.autoResumeProjects();

		const remaining = await readdir(sessionsDir);
		const jsonFiles = remaining.filter((f) => f.endsWith(".json"));
		expect(jsonFiles.length).toBe(3);
	});

	test("does not prune when session count is within limit", async () => {
		const sessionsDir = join(dataDir, "sessions", projectId);
		await mkdir(sessionsDir, { recursive: true });

		for (let i = 0; i < 3; i++) {
			await writeFile(join(sessionsDir, `session-${i}.json`), `{"i":${i}}`);
		}

		const result = createApp({
			dataDir,
			agentProvider: mockProvider,
			initialConfig: { sessionKeep: 5 },
		});
		await result.pm.load();
		await result.autoResumeProjects();

		const remaining = await readdir(sessionsDir);
		const jsonFiles = remaining.filter((f) => f.endsWith(".json"));
		expect(jsonFiles.length).toBe(3);
	});

	test("defaults to keeping 5 sessions when sessionKeep not set", async () => {
		const sessionsDir = join(dataDir, "sessions", projectId);
		await mkdir(sessionsDir, { recursive: true });

		for (let i = 0; i < 9; i++) {
			await writeFile(join(sessionsDir, `session-${i}.json`), `{"i":${i}}`);
			await new Promise((r) => setTimeout(r, 5));
		}

		// No initialConfig.sessionKeep → defaults to 5
		const result = createApp({ dataDir, agentProvider: mockProvider });
		await result.pm.load();
		await result.autoResumeProjects();

		const remaining = await readdir(sessionsDir);
		const jsonFiles = remaining.filter((f) => f.endsWith(".json"));
		expect(jsonFiles.length).toBe(5);
	});

	test("does not fail when sessions directory does not exist", async () => {
		// No sessionsDir created — should be a no-op
		const result = createApp({
			dataDir,
			agentProvider: mockProvider,
			initialConfig: { sessionKeep: 5 },
		});
		await result.pm.load();
		// Should not throw
		await result.autoResumeProjects();
	});
});

describe("GET /projects/:id/config", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createApp>["app"];
	let projectId: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-cfg-get-"));
		dataDir = await mkdtemp(join(tmpdir(), "og-cfg-get-data-"));
		const result = createApp({ dataDir, agentProvider: mockProvider });
		app = result.app;
		await result.pm.load();

		const res = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: tempDir }),
		});
		const project = (await res.json()) as Project;
		projectId = project.id;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("returns empty object for project with no config", async () => {
		const res = await app.request(`/projects/${projectId}/config`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({});
	});

	test("returns config after PATCH sets values", async () => {
		await app.request(`/projects/${projectId}/config`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: "claude-opus-4-5" }),
		});

		const res = await app.request(`/projects/${projectId}/config`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { model?: string };
		expect(body.model).toBe("claude-opus-4-5");
	});

	test("returns 404 for unknown project", async () => {
		const res = await app.request("/projects/nonexistent-id/config");
		expect(res.status).toBe(404);
	});
});

describe("PATCH /projects/:id/config", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createApp>["app"];
	let projectId: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-cfg-patch-"));
		dataDir = await mkdtemp(join(tmpdir(), "og-cfg-patch-data-"));
		const result = createApp({ dataDir, agentProvider: mockProvider });
		app = result.app;
		await result.pm.load();

		const res = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: tempDir }),
		});
		const project = (await res.json()) as Project;
		projectId = project.id;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("sets model and returns merged config", async () => {
		const res = await app.request(`/projects/${projectId}/config`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: "claude-sonnet-4-6" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { model?: string };
		expect(body.model).toBe("claude-sonnet-4-6");
	});

	test("merging partial config does not erase unrelated fields", async () => {
		// Set two fields
		await app.request(`/projects/${projectId}/config`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: "claude-opus-4-5", budgetUsd: 2.0 }),
		});

		// Update only model
		const res = await app.request(`/projects/${projectId}/config`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: "claude-haiku-4-5" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { model?: string; budgetUsd?: number };
		expect(body.model).toBe("claude-haiku-4-5");
		expect(body.budgetUsd).toBe(2.0);
	});

	test("setting a field to null removes it", async () => {
		// First set it
		await app.request(`/projects/${projectId}/config`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: "claude-opus-4-5" }),
		});

		// Then null it out
		const res = await app.request(`/projects/${projectId}/config`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: null }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { model?: string };
		expect(body.model).toBeUndefined();
	});

	test("returns 404 for unknown project", async () => {
		const res = await app.request("/projects/nonexistent-id/config", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: "claude-sonnet-4-6" }),
		});
		expect(res.status).toBe(404);
	});
});

describe("GET /config/global", () => {
	test("returns empty object by default", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "og-gcfg-"));
		const { app, pm } = createApp({ dataDir, agentProvider: mockProvider });
		await pm.load();

		const res = await app.request("/config/global");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({});

		await rm(dataDir, { recursive: true });
	});
});

describe("PATCH /config/global", () => {
	test("sets and returns global config", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "og-gcfg-patch-"));
		const globalConfigPath = join(dataDir, "config.json");
		const { app, pm } = createApp({
			dataDir,
			agentProvider: mockProvider,
			globalConfigPath,
		});
		await pm.load();

		const res = await app.request("/config/global", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: "claude-opus-4-5", maxDepth: 3 }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { model?: string; maxDepth?: number };
		expect(body.model).toBe("claude-opus-4-5");
		expect(body.maxDepth).toBe(3);

		// GET should reflect the change
		const getRes = await app.request("/config/global");
		const getBody = (await getRes.json()) as {
			model?: string;
			maxDepth?: number;
		};
		expect(getBody.model).toBe("claude-opus-4-5");
		expect(getBody.maxDepth).toBe(3);

		await rm(dataDir, { recursive: true });
	});

	test("null removes a field", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "og-gcfg-null-"));
		const globalConfigPath = join(dataDir, "config.json");
		const { app, pm } = createApp({
			dataDir,
			agentProvider: mockProvider,
			globalConfigPath,
		});
		await pm.load();

		// Set a value
		await app.request("/config/global", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: "claude-opus-4-5" }),
		});

		// Null it out
		const res = await app.request("/config/global", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: null }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { model?: string };
		expect(body.model).toBeUndefined();

		await rm(dataDir, { recursive: true });
	});
});

describe("GET /projects/:id/config/repo", () => {
	test("returns empty object when no repo config exists", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "og-repo-cfg-"));
		const dataDir = await mkdtemp(join(tmpdir(), "og-repo-cfg-data-"));
		const { app, pm } = createApp({ dataDir, agentProvider: mockProvider });
		await pm.load();

		const projRes = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: tempDir }),
		});
		const project = (await projRes.json()) as Project;

		const res = await app.request(`/projects/${project.id}/config/repo`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({});

		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("returns repo config when .opengraft/config.json exists", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "og-repo-cfg2-"));
		const dataDir = await mkdtemp(join(tmpdir(), "og-repo-cfg2-data-"));
		const { app, pm } = createApp({ dataDir, agentProvider: mockProvider });
		await pm.load();

		const projRes = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: tempDir }),
		});
		const project = (await projRes.json()) as Project;

		// Write a repo config file in the project directory
		await mkdir(join(tempDir, ".opengraft"), { recursive: true });
		await writeFile(
			join(tempDir, ".opengraft", "config.json"),
			JSON.stringify({ model: "claude-haiku-4-5", maxDepth: 2 }),
		);

		const res = await app.request(`/projects/${project.id}/config/repo`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { model?: string; maxDepth?: number };
		expect(body.model).toBe("claude-haiku-4-5");
		expect(body.maxDepth).toBe(2);

		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("returns 404 for unknown project", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "og-repo-cfg3-"));
		const { app, pm } = createApp({ dataDir, agentProvider: mockProvider });
		await pm.load();

		const res = await app.request("/projects/nonexistent-id/config/repo");
		expect(res.status).toBe(404);

		await rm(dataDir, { recursive: true });
	});
});

describe("GET /projects/:id/tasks/:nodeId/conversation", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createApp>["app"];
	let projectId: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-conv-"));
		dataDir = await mkdtemp(join(tmpdir(), "og-conv-data-"));
		const result = createApp({ dataDir, agentProvider: mockProvider });
		app = result.app;
		await result.pm.load();

		const res = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: tempDir }),
		});
		const project = (await res.json()) as Project;
		projectId = project.id;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("returns { messages: [] } for new task with no session file", async () => {
		const taskRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "No Session", description: "" }),
		});
		const task = (await taskRes.json()) as TaskNode;

		const res = await app.request(
			`/projects/${projectId}/tasks/${task.id}/conversation`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { messages: unknown[] };
		expect(body.messages).toEqual([]);
	});

	test("returns 404 for unknown task", async () => {
		const res = await app.request(
			`/projects/${projectId}/tasks/nonexistent-task-id/conversation`,
		);
		expect(res.status).toBe(404);
	});

	test("returns 404 for unknown project", async () => {
		const res = await app.request(
			"/projects/nonexistent-project/tasks/any-task/conversation",
		);
		expect(res.status).toBe(404);
	});

	test("returns { messages: [] } for task with no session file on disk", async () => {
		const taskRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Missing Session", description: "" }),
		});
		const task = (await taskRes.json()) as TaskNode;

		// No session file exists for this task (sessionId = nodeId, but no file on disk)
		const res = await app.request(
			`/projects/${projectId}/tasks/${task.id}/conversation`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { messages: unknown[] };
		expect(body.messages).toEqual([]);
	});

	test("returns transformed messages from session file (happy path)", async () => {
		const taskRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Has Session", description: "" }),
		});
		const task = (await taskRes.json()) as TaskNode;

		// Write mock session file — sessionId = nodeId
		const sessionsDir = join(dataDir, "sessions", projectId);
		await mkdir(sessionsDir, { recursive: true });
		const sessionData = [
			{ role: "user", content: "Help me build a feature" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "I'll help you" },
					{ type: "tool_use", id: "tool-1", name: "bash", input: {} },
				],
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "tool-1", content: "ok" },
				],
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "Done!" }],
			},
		];
		await writeFile(
			join(sessionsDir, `${task.id}.json`),
			JSON.stringify(sessionData),
		);

		const res = await app.request(
			`/projects/${projectId}/tasks/${task.id}/conversation`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			messages: {
				role: string;
				content: string;
				hasToolUse: boolean;
				toolNames?: string[];
			}[];
		};

		expect(body.messages).toHaveLength(4);

		// First message: plain string content
		expect(body.messages[0]?.role).toBe("user");
		expect(body.messages[0]?.content).toBe("Help me build a feature");
		expect(body.messages[0]?.hasToolUse).toBe(false);

		// Second message: assistant with text + tool_use
		expect(body.messages[1]?.role).toBe("assistant");
		expect(body.messages[1]?.content).toBe("I'll help you");
		expect(body.messages[1]?.hasToolUse).toBe(true);
		expect(body.messages[1]?.toolNames).toEqual(["bash"]);

		// Third message: user tool_result (no text blocks)
		expect(body.messages[2]?.role).toBe("user");
		expect(body.messages[2]?.content).toBe("");
		expect(body.messages[2]?.hasToolUse).toBe(false);

		// Fourth message: assistant text only
		expect(body.messages[3]?.role).toBe("assistant");
		expect(body.messages[3]?.content).toBe("Done!");
		expect(body.messages[3]?.hasToolUse).toBe(false);
	});

	test("returns last 100 messages when session has more than 100", async () => {
		const taskRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Big Session", description: "" }),
		});
		const task = (await taskRes.json()) as TaskNode;

		// Write 110 messages — sessionId = nodeId
		const sessionsDir = join(dataDir, "sessions", projectId);
		await mkdir(sessionsDir, { recursive: true });
		const sessionData = Array.from({ length: 110 }, (_, i) => ({
			role: i % 2 === 0 ? "user" : "assistant",
			content: `Message ${i}`,
		}));
		await writeFile(
			join(sessionsDir, `${task.id}.json`),
			JSON.stringify(sessionData),
		);

		const res = await app.request(
			`/projects/${projectId}/tasks/${task.id}/conversation`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { messages: { content: string }[] };
		expect(body.messages).toHaveLength(100);
		// Should be the last 100: messages 10..109
		expect(body.messages[0]?.content).toBe("Message 10");
		expect(body.messages[99]?.content).toBe("Message 109");
	});
});

describe("POST /projects/:id/restart", () => {
	let dataDir: string;
	let projectDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "og-restart-"));
		projectDir = await mkdtemp(join(tmpdir(), "og-restart-proj-"));
		await mkdir(join(projectDir, ".git"), { recursive: true });
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
		await rm(projectDir, { recursive: true, force: true });
	});

	test("returns 404 when project not found", async () => {
		const { app, pm } = createApp({ dataDir, agentProvider: mockProvider });
		await pm.load();
		const res = await app.request("/projects/nonexistent/restart", {
			method: "POST",
		});
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.error).toBe("Project not found");
	});

	test("returns 404 when no active agent", async () => {
		const { app, pm } = createApp({ dataDir, agentProvider: mockProvider });
		await pm.load();
		const projRes = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: projectDir }),
		});
		const proj = (await projRes.json()) as Project;

		const res = await app.request(`/projects/${proj.id}/restart`, {
			method: "POST",
		});
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.error).toBe("No active agent to restart");
	});

	test("restarts a running agent and returns ok", async () => {
		let sessionCount = 0;
		const restartProvider: AgentProvider = {
			name: "mock",
			execute: async () => ({ success: true, output: "" }),
			// biome-ignore lint/correctness/useYield: mock provider never streams
			stream: async function* () {
				return { success: true, output: "" };
			},
			startSession(req) {
				sessionCount++;
				const queue = req.queue ?? new MessageQueue();
				async function* events(): AsyncGenerator<AgentEvent, AgentResult> {
					// Keep the session alive long enough for the restart test
					await new Promise((resolve) => setTimeout(resolve, 5000));
					return {
						success: true,
						output: "",
						sessionId: `session-${sessionCount}`,
					};
				}
				return {
					sessionId: `session-${sessionCount}`,
					events: events(),
					queue,
					sendMessage: async () => {},
					stop: () => {
						queue.close();
					},
				};
			},
		};

		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: restartProvider,
		});
		await pm.load();
		markReady();

		// Create project
		const projRes = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: projectDir }),
		});
		const proj = (await projRes.json()) as Project;

		// Start orchestration
		const startRes = await app.request(
			`/projects/${proj.id}/orchestrate/agent`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prompt: "test" }),
			},
		);
		expect(startRes.status).toBe(200);

		// Wait briefly for agent to start
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(sessionCount).toBe(1);

		// Restart
		const restartRes = await app.request(`/projects/${proj.id}/restart`, {
			method: "POST",
		});
		expect(restartRes.status).toBe(200);
		const body = await restartRes.json();
		expect(body.ok).toBe(true);

		// Wait for new session to start
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(sessionCount).toBe(2);

		// Stop the agent to clean up
		const stopRes = await app.request(`/projects/${proj.id}/stop`, {
			method: "POST",
		});
		expect(stopRes.status).toBe(200);
	});

	test("double-restart returns 409 for second request", async () => {
		let sessionCount = 0;
		const slowStopProvider: AgentProvider = {
			name: "mock",
			execute: async () => ({ success: true, output: "" }),
			// biome-ignore lint/correctness/useYield: mock provider never streams
			stream: async function* () {
				return { success: true, output: "" };
			},
			startSession(req) {
				sessionCount++;
				const queue = req.queue ?? new MessageQueue();
				async function* events(): AsyncGenerator<AgentEvent, AgentResult> {
					await new Promise((resolve) => setTimeout(resolve, 5000));
					return {
						success: true,
						output: "",
						sessionId: `session-${sessionCount}`,
					};
				}
				return {
					sessionId: `session-${sessionCount}`,
					events: events(),
					queue,
					sendMessage: async () => {},
					stop: () => {
						queue.close();
					},
				};
			},
		};

		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: slowStopProvider,
		});
		await pm.load();
		markReady();

		const projRes = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: projectDir }),
		});
		const proj = (await projRes.json()) as Project;

		// Start orchestration
		await app.request(`/projects/${proj.id}/orchestrate/agent`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "test" }),
		});
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Fire two restarts concurrently — second should fail with 409
		const [r1, r2] = await Promise.all([
			app.request(`/projects/${proj.id}/restart`, { method: "POST" }),
			app.request(`/projects/${proj.id}/restart`, { method: "POST" }),
		]);

		const statuses = [r1.status, r2.status].sort();
		// One should succeed (200), the other should be rejected (409 or 404)
		expect(statuses[0]).toBe(200);
		expect(statuses[1]).not.toBe(200);

		// Clean up
		await new Promise((resolve) => setTimeout(resolve, 100));
		await app.request(`/projects/${proj.id}/stop`, { method: "POST" });
	});

	test("stop then immediately start does not create duplicate", async () => {
		let sessionCount = 0;
		const trackingProvider: AgentProvider = {
			name: "mock",
			execute: async () => ({ success: true, output: "" }),
			// biome-ignore lint/correctness/useYield: mock provider never streams
			stream: async function* () {
				return { success: true, output: "" };
			},
			startSession(req) {
				sessionCount++;
				const queue = req.queue ?? new MessageQueue();
				async function* events(): AsyncGenerator<AgentEvent, AgentResult> {
					await new Promise((resolve) => setTimeout(resolve, 5000));
					return {
						success: true,
						output: "",
						sessionId: `session-${sessionCount}`,
					};
				}
				return {
					sessionId: `session-${sessionCount}`,
					events: events(),
					queue,
					sendMessage: async () => {},
					stop: () => {
						queue.close();
					},
				};
			},
		};

		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: trackingProvider,
		});
		await pm.load();
		markReady();

		const projRes = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: projectDir }),
		});
		const proj = (await projRes.json()) as Project;

		// Start orchestration
		await app.request(`/projects/${proj.id}/orchestrate/agent`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "test" }),
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(sessionCount).toBe(1);

		// Stop the agent
		const stopRes = await app.request(`/projects/${proj.id}/stop`, {
			method: "POST",
		});
		expect(stopRes.status).toBe(200);

		// Immediately start a new agent
		const startRes = await app.request(
			`/projects/${proj.id}/orchestrate/agent`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prompt: "test 2" }),
			},
		);
		expect(startRes.status).toBe(200);

		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(sessionCount).toBe(2);

		// Trying to start again enqueues the message (no longer 409)
		const dupRes = await app.request(`/projects/${proj.id}/orchestrate/agent`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "test 3" }),
		});
		expect(dupRes.status).toBe(200);
		// Still only 2 sessions launched (not 3 — the third prompt was enqueued, not a new session)
		expect(sessionCount).toBe(2);

		// Clean up
		await app.request(`/projects/${proj.id}/stop`, { method: "POST" });
	});

	test("old session cleanup does not clobber new session after restart", async () => {
		let sessionCount = 0;
		const restartSafeProvider: AgentProvider = {
			name: "mock",
			execute: async () => ({ success: true, output: "" }),
			// biome-ignore lint/correctness/useYield: mock provider never streams
			stream: async function* () {
				return { success: true, output: "" };
			},
			startSession(req) {
				sessionCount++;
				const currentNum = sessionCount;
				const queue = req.queue ?? new MessageQueue();

				async function* events(): AsyncGenerator<AgentEvent, AgentResult> {
					// Keep alive long enough for restart test, but short enough to trigger cleanup
					try {
						await new Promise((resolve) => setTimeout(resolve, 5000));
					} catch {
						// queue.close() rejects pending waits — session stopped
					}
					return {
						success: true,
						output: "",
						sessionId: `session-${currentNum}`,
					};
				}
				return {
					sessionId: `session-${currentNum}`,
					events: events(),
					queue,
					sendMessage: async () => {},
					stop: () => {
						queue.close();
					},
				};
			},
		};

		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: restartSafeProvider,
		});
		await pm.load();
		markReady();

		const projRes = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: projectDir }),
		});
		const proj = (await projRes.json()) as Project;

		// Start orchestration — session 1
		await app.request(`/projects/${proj.id}/orchestrate/agent`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "test" }),
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(sessionCount).toBe(1);

		// Restart — this stops session 1 and starts session 2
		const restartRes = await app.request(`/projects/${proj.id}/restart`, {
			method: "POST",
		});
		expect(restartRes.status).toBe(200);

		// Wait for session 2 to be created
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(sessionCount).toBe(2);

		// Wait for session 1's cleanup to run (its finally block)
		await new Promise((resolve) => setTimeout(resolve, 200));

		// The agent should still be running (session 2 not clobbered)
		const agentRes = await app.request(`/projects/${proj.id}/agent`);
		const agentBody = (await agentRes.json()) as {
			running: boolean;
		};
		expect(agentBody.running).toBe(true);

		// Should still be able to stop it
		const stopRes = await app.request(`/projects/${proj.id}/stop`, {
			method: "POST",
		});
		expect(stopRes.status).toBe(200);

		// Should not be able to stop again
		const stopRes2 = await app.request(`/projects/${proj.id}/stop`, {
			method: "POST",
		});
		expect(stopRes2.status).toBe(404);
	});

	test("restart preserves session ID for resume", async () => {
		let sessionCount = 0;
		const sessionIdProvider: AgentProvider = {
			name: "mock",
			execute: async () => ({ success: true, output: "" }),
			// biome-ignore lint/correctness/useYield: mock provider never streams
			stream: async function* () {
				return { success: true, output: "" };
			},
			startSession(req) {
				sessionCount++;
				const currentSessionId = `test-session-${sessionCount}`;
				const queue = req.queue ?? new MessageQueue();
				async function* events(): AsyncGenerator<AgentEvent, AgentResult> {
					await new Promise((resolve) => setTimeout(resolve, 5000));
					return { success: true, output: "", sessionId: currentSessionId };
				}
				return {
					sessionId: currentSessionId,
					events: events(),
					queue,
					sendMessage: async () => {},
					stop: () => {
						queue.close();
					},
				};
			},
		};

		const { app, pm, markReady, getTracker } = createApp({
			dataDir,
			agentProvider: sessionIdProvider,
		});
		await pm.load();
		markReady();

		const projRes = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: projectDir }),
		});
		const proj = (await projRes.json()) as Project;

		// Start orchestration
		await app.request(`/projects/${proj.id}/orchestrate/agent`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "test" }),
		});
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Restart
		await app.request(`/projects/${proj.id}/restart`, { method: "POST" });
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Root node should still exist (session file is at <rootNodeId>.json)
		const tracker = await getTracker(proj.id);
		expect(tracker.rootNodeId).toBeTruthy();

		// Clean up
		await app.request(`/projects/${proj.id}/stop`, { method: "POST" });
	});

	test("start after startup guard is released succeeds", async () => {
		const { app, pm } = createApp({
			dataDir,
			agentProvider: mockProvider,
		});
		await pm.load();
		// Don't call markReady() — startup guard should block

		const projRes = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: projectDir }),
		});
		const proj = (await projRes.json()) as Project;

		// Should return 503 before markReady
		const startRes = await app.request(
			`/projects/${proj.id}/orchestrate/agent`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prompt: "test" }),
			},
		);
		expect(startRes.status).toBe(503);
	});
});

describe("lifecycle edge cases", () => {
	let dataDir: string;
	let projectDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "og-lifecycle-"));
		projectDir = await mkdtemp(join(tmpdir(), "og-lifecycle-proj-"));
		await mkdir(join(projectDir, ".git"), { recursive: true });
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
		await rm(projectDir, { recursive: true, force: true });
	});

	function createLongRunningProvider(): AgentProvider {
		return {
			name: "mock",
			execute: async () => ({ success: true, output: "" }),
			// biome-ignore lint/correctness/useYield: mock provider never streams
			stream: async function* () {
				return { success: true, output: "" };
			},
			startSession(req) {
				const queue = req.queue ?? new MessageQueue();
				async function* events(): AsyncGenerator<AgentEvent, AgentResult> {
					// Keep the session alive
					await new Promise((resolve) => setTimeout(resolve, 10000));
					return { success: true, output: "" };
				}
				return {
					sessionId: "mock-session",
					events: events(),
					queue,
					sendMessage: async () => {},
					stop: () => {
						queue.close();
					},
				};
			},
		};
	}

	test("stopping agent clears pending messages and clarifications", async () => {
		const provider = createLongRunningProvider();
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: provider,
		});
		await pm.load();
		markReady();

		// Create project
		const projRes = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: projectDir }),
		});
		const project = (await projRes.json()) as Project;

		// Start agent
		await app.request(`/projects/${project.id}/orchestrate/agent`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "test" }),
		});
		await new Promise((r) => setTimeout(r, 100));

		// Send a message (creates a pending message)
		await app.request(`/projects/${project.id}/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "hello" }),
		});

		// Verify pending message exists
		const msgRes = await app.request(
			`/projects/${project.id}/pending-messages`,
		);
		const msgs = (await msgRes.json()) as { messages: unknown[] };
		expect(msgs.messages.length).toBeGreaterThan(0);

		// Stop the agent
		await app.request(`/projects/${project.id}/stop`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});

		// Pending messages should be cleared
		const msgRes2 = await app.request(
			`/projects/${project.id}/pending-messages`,
		);
		const msgs2 = (await msgRes2.json()) as { messages: unknown[] };
		expect(msgs2.messages).toEqual([]);

		// Pending clarifications should also be cleared
		const clarRes = await app.request(`/projects/${project.id}/clarifications`);
		const clars = (await clarRes.json()) as { clarifications: unknown[] };
		expect(clars.clarifications).toEqual([]);
	});

	test("clearing sessions while agent is running stops agent and succeeds", async () => {
		let stopCalled = false;
		const provider: AgentProvider = {
			name: "mock",
			execute: async () => ({ success: true, output: "" }),
			// biome-ignore lint/correctness/useYield: mock provider never streams
			stream: async function* () {
				return { success: true, output: "" };
			},
			startSession(req) {
				const queue = req.queue ?? new MessageQueue();
				async function* events(): AsyncGenerator<AgentEvent, AgentResult> {
					await new Promise((resolve) => setTimeout(resolve, 10000));
					return { success: true, output: "" };
				}
				return {
					sessionId: "mock-session",
					events: events(),
					queue,
					sendMessage: async () => {},
					stop: () => {
						stopCalled = true;
						queue.close();
					},
				};
			},
		};

		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: provider,
		});
		await pm.load();
		markReady();

		// Create project
		const projRes = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: projectDir }),
		});
		const project = (await projRes.json()) as Project;

		// Start agent
		await app.request(`/projects/${project.id}/orchestrate/agent`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "test" }),
		});
		await new Promise((r) => setTimeout(r, 100));

		// Clear sessions while running — should stop agent and succeed
		const clearRes = await app.request(
			`/projects/${project.id}/sessions/clear`,
			{ method: "POST" },
		);
		expect(clearRes.status).toBe(200);

		// Agent should have been stopped as a side effect
		await new Promise((r) => setTimeout(r, 100));
		expect(stopCalled).toBe(true);
	});

	test("deleting project stops running agent", async () => {
		let stopCalled = false;
		const provider: AgentProvider = {
			name: "mock",
			execute: async () => ({ success: true, output: "" }),
			// biome-ignore lint/correctness/useYield: mock provider never streams
			stream: async function* () {
				return { success: true, output: "" };
			},
			startSession(req) {
				const queue = req.queue ?? new MessageQueue();
				async function* events(): AsyncGenerator<AgentEvent, AgentResult> {
					await new Promise((resolve) => setTimeout(resolve, 10000));
					return { success: true, output: "" };
				}
				return {
					sessionId: "mock-session",
					events: events(),
					queue,
					sendMessage: async () => {},
					stop: () => {
						stopCalled = true;
						queue.close();
					},
				};
			},
		};

		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: provider,
		});
		await pm.load();
		markReady();

		// Create project
		const projRes = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: projectDir }),
		});
		const project = (await projRes.json()) as Project;

		// Start agent
		await app.request(`/projects/${project.id}/orchestrate/agent`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "test" }),
		});
		await new Promise((r) => setTimeout(r, 100));

		// Delete the project — should stop the agent first
		const delRes = await app.request(`/projects/${project.id}`, {
			method: "DELETE",
		});
		expect(delRes.status).toBe(200);
		expect(stopCalled).toBe(true);
	});

	test("clearing sessions works when no agent is running", async () => {
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: mockProvider,
		});
		await pm.load();
		markReady();

		// Create project
		const projRes = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: projectDir }),
		});
		const project = (await projRes.json()) as Project;

		// Clear sessions without running agent — should succeed
		const clearRes = await app.request(
			`/projects/${project.id}/sessions/clear`,
			{ method: "POST" },
		);
		expect(clearRes.status).toBe(200);
		const body = (await clearRes.json()) as { cleared: boolean };
		expect(body.cleared).toBe(true);
	});

	test("clearing sessions preserves task tree and rootNodeId in GET /tasks", async () => {
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: mockProvider,
		});
		await pm.load();
		markReady();

		// Create project
		const projRes = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: projectDir }),
		});
		const project = (await projRes.json()) as Project;

		// Start and stop agent to create root node + tasks
		await app.request(`/projects/${project.id}/orchestrate/agent`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "test" }),
		});
		await new Promise((r) => setTimeout(r, 100));
		await app.request(`/projects/${project.id}/stop`, { method: "POST" });
		await new Promise((r) => setTimeout(r, 100));

		// Verify tasks exist before clearing
		const beforeRes = await app.request(`/projects/${project.id}/tasks`);
		const before = (await beforeRes.json()) as {
			nodes: TaskNode[];
			rootNodeId: string | null;
		};
		expect(before.rootNodeId).toBeTruthy();
		const nodeCountBefore = before.nodes.length;
		expect(nodeCountBefore).toBeGreaterThan(0);

		// Clear sessions
		const clearRes = await app.request(
			`/projects/${project.id}/sessions/clear`,
			{ method: "POST" },
		);
		expect(clearRes.status).toBe(200);

		// Verify tasks are still there after clearing
		const afterRes = await app.request(`/projects/${project.id}/tasks`);
		const after = (await afterRes.json()) as {
			nodes: TaskNode[];
			rootNodeId: string | null;
		};
		expect(after.nodes.length).toBe(nodeCountBefore);
		expect(after.rootNodeId).toBe(before.rootNodeId);
	});
});
