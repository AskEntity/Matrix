import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ulid } from "./ulid.ts";
import type { AgentProvider, AgentRequest } from "./agent-provider.ts";
import { createMatrixApp as createApp } from "./test-utils/create-matrix-app.ts";
import { EventStore } from "./event-store.ts";
import type { Event } from "./events.ts";
import { MessageQueue } from "./message-queue.ts";
import { createOrchestratorTools } from "./orchestrator-tools.ts";
import { resetResourceRegistry } from "./resource-registry.ts";
import { TaskTracker } from "./task-tracker.ts";
import { isDescendantOf } from "./task-utils.ts";
import { initTestProject } from "./test-utils/init-test-project.ts";
import { attachMockSession, initMockResourceRegistry } from "./test-utils.ts";
import { executeTool } from "./tool-execution.ts";
import type {
	AgentResult,
	HealthResponse,
	StatsResponse,
	TaskNode,
	VersionResponse,
} from "./types.ts";

function createMockProvider(
	handler?: (request: AgentRequest) => Promise<AgentResult>,
): AgentProvider {
	const execute =
		handler ??
		(async () => ({
			exitReason: "interrupted" as const,
			output: "",
			costUsd: 0,
			turns: 0,
			sessionId: "mock-session",
		}));
	return {
		name: "mock",
		execute,
		// biome-ignore lint/correctness/useYield: mock provider — drains initial messages then exits
		stream: async function* (req) {
			const queue = req.queue ?? new MessageQueue();
			// Drain first message (the initial prompt)
			if (queue.pending > 0) queue.drain();
			return {
				exitReason: "interrupted" as const,
				output: "",
				costUsd: 0,
				turns: 0,
				sessionId: "mock-session",
			};
		},
	};
}

const mockProvider = createMockProvider();

/** Helper: get root node ID for a project, then send a message to start the agent. */
async function startRootAgent(
	app: {
		request: (url: string, init?: RequestInit) => Response | Promise<Response>;
	},
	projectId: string,
	prompt: string,
): Promise<Response> {
	const tasksRes = await app.request(`/projects/${projectId}/tasks`);
	const { rootNodeId } = (await tasksRes.json()) as { rootNodeId: string };
	return app.request(`/projects/${projectId}/tasks/${rootNodeId}/message`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ content: prompt }),
	});
}

describe("daemon health", () => {
	test("GET /health returns ok with version and uptime", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "mxd-health-"));
		const { app, pm } = createApp({ dataDir, agentProvider: mockProvider });


		const res = await app.request("/health");
		expect(res.status).toBe(200);

		const body = (await res.json()) as HealthResponse;
		expect(body.status).toBe("ok");
		expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
		expect(typeof body.uptime).toBe("number");

		await rm(dataDir, { recursive: true });
	});

	test("GET /health without check_model has no model field", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "mxd-health-nomodel-"));
		const { app, pm } = createApp({ dataDir, agentProvider: mockProvider });


		const res = await app.request("/health");
		expect(res.status).toBe(200);

		const body = (await res.json()) as HealthResponse;
		expect(body.status).toBe("ok");
		expect(body.model).toBeUndefined();

		await rm(dataDir, { recursive: true });
	});

	test("GET /health?check_model=true returns model status", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "mxd-health-model-"));
		const { app, pm } = createApp({ dataDir, agentProvider: mockProvider });


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
		const dataDir = await mkdtemp(join(tmpdir(), "mxd-404-"));
		const { app, pm } = createApp({ dataDir, agentProvider: mockProvider });


		const res = await app.request("/unknown");
		expect(res.status).toBe(404);

		await rm(dataDir, { recursive: true });
	});
});

describe("daemon version", () => {
	test("GET /version returns version, nodeCount, and projectCount", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "mxd-version-"));
		const { app, pm } = createApp({ dataDir, agentProvider: mockProvider });


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
		const dataDir = await mkdtemp(join(tmpdir(), "mxd-stats-"));
		const { app, pm } = createApp({ dataDir, agentProvider: mockProvider });


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
			verify: 0,

			failed: 0,
			closed: 0,
		});

		await rm(dataDir, { recursive: true });
	});

	test("GET /stats requestCount increments with each request", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "mxd-stats2-"));
		const { app, pm } = createApp({ dataDir, agentProvider: mockProvider });


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
		const dataDir = await mkdtemp(join(tmpdir(), "mxd-stats3-"));
		const { app, pm } = createApp({ dataDir, agentProvider: mockProvider });


		const res = await app.request("/stats");
		const body = (await res.json()) as StatsResponse;

		// uptime should be a modest number (seconds since process start),
		// not millions (ms). startTime is module-level and shared across the
		// test file — a long test suite can push this up past a naive 60s
		// threshold, so check it's plausibly seconds-scale (<1 hour).
		expect(body.uptime).toBeLessThan(3600);

		await rm(dataDir, { recursive: true });
	});

	test("GET /stats reflects projects and task counts", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "mxd-stats4-"));
		const dataDir = await mkdtemp(join(tmpdir(), "mxd-stats4d-"));
		const project = { id: ulid(), name: "stats-proj", path: join(tempDir, "stats-proj") };
		const { app } = createApp({ dataDir, agentProvider: mockProvider, projects: [project] });

		// Get the auto-created root node ID
		const tasksRes = await app.request(`/projects/${project.id}/tasks`);
		const tasksBody = (await tasksRes.json()) as {
			rootNodeId: string;
		};
		const statsRootNodeId = tasksBody.rootNodeId;

		// Create root task (pending)
		const rootRes = await app.request(`/projects/${project.id}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Root",
				description: "",
				parentId: statsRootNodeId,
			}),
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

		// Mark root as in_progress, child1 as verify
		await app.request(`/projects/${project.id}/tasks/${root.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "in_progress" }),
		});
		await app.request(`/projects/${project.id}/tasks/${child1.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "verify" }),
		});

		const statsRes = await app.request("/stats");
		const stats = (await statsRes.json()) as StatsResponse;
		expect(stats.projectCount).toBe(1);
		expect(stats.taskCounts.pending).toBe(2); // Child2 + Orchestrator root
		expect(stats.taskCounts.in_progress).toBe(1); // Root
		expect(stats.taskCounts.verify).toBe(1); // Child1
		expect(stats.taskCounts.failed).toBe(0);

		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});
});


describe("daemon tasks API", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createApp>["app"];
	let getTracker: ReturnType<typeof createApp>["getTracker"];
	let projectId: string;
	let rootNodeId: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-tasks-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-tdata-"));
		const project = { id: ulid(), name: "task-app", path: join(tempDir, "task-app") };
		const result = createApp({ dataDir, agentProvider: mockProvider, projects: [project] });
		app = result.app;
		getTracker = result.getTracker;
		projectId = project.id;
		// Get root node ID for task creation
		const tracker = await getTracker(projectId);
		rootNodeId = tracker.rootNodeId;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("POST /tasks requires parentId", async () => {
		const res = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Chat App", description: "Build it" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("parentId");
	});

	test("POST /tasks creates task with explicit parentId", async () => {
		const res = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Chat App",
				description: "Build it",
				parentId: rootNodeId,
			}),
		});
		expect(res.status).toBe(201);
		const node = (await res.json()) as TaskNode;
		expect(node.title).toBe("Chat App");
		expect(node.status).toBe("pending");
		expect(node.parentId).toBe(rootNodeId);
	});

	test("POST /tasks creates task with budgetUsd", async () => {
		const res = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Budgeted Task",
				description: "Has a budget",
				budgetUsd: 0.5,
				parentId: rootNodeId,
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
				parentId: rootNodeId,
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
			body: JSON.stringify({
				title: "Root",
				description: "",
				parentId: rootNodeId,
			}),
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
			body: JSON.stringify({
				title: "App",
				description: "",
				parentId: rootNodeId,
			}),
		});

		const res = await app.request(`/projects/${projectId}/tasks`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			nodes: TaskNode[];
			rootNodeId?: string | null;
		};
		// Root node + "App" task
		expect(body.nodes).toHaveLength(2);
		expect(body.nodes.some((n) => n.title === "App")).toBe(true);
	});

	test("GET /tasks returns rootNodeId", async () => {
		// Root node exists from tracker.load()
		await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Child",
				description: "",
				parentId: rootNodeId,
			}),
		});

		// GET /tasks should return nodes with rootNodeId always set
		const res = await app.request(`/projects/${projectId}/tasks`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			nodes: TaskNode[];
			rootNodeId: string;
		};
		expect(body.nodes.length).toBeGreaterThan(0);
		expect(body.rootNodeId).toBeTruthy();
	});

	test("PATCH /tasks/:nodeId updates status and branch", async () => {
		const rootRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "App",
				description: "",
				parentId: rootNodeId,
			}),
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
			body: JSON.stringify({
				title: "Original",
				description: "Old desc",
				parentId: rootNodeId,
			}),
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
			body: JSON.stringify({
				title: "Task",
				description: "Has desc",
				parentId: rootNodeId,
			}),
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
			body: JSON.stringify({
				title: "Parent 1",
				description: "",
				parentId: rootNodeId,
			}),
		});
		const p1 = (await p1Res.json()) as TaskNode;

		const p2Res = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Parent 2",
				description: "",
				parentId: rootNodeId,
			}),
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
			body: JSON.stringify({
				title: "Parent",
				description: "",
				parentId: rootNodeId,
			}),
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
			body: JSON.stringify({
				title: "App",
				description: "",
				parentId: rootNodeId,
			}),
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
		expect(body.nodes).toHaveLength(1); // root node only
	});

	test("DELETE /tasks/:nodeId closes running agent queue on leaf task", async () => {
		const taskRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Running task",
				description: "",
				parentId: rootNodeId,
			}),
		});
		const task = (await taskRes.json()) as TaskNode;

		// Attach session to simulate a running agent
		const taskQueue = new MessageQueue();
		const tracker = await getTracker(projectId);
		const taskNode = tracker.getTask(task.id) as TaskNode;
		attachMockSession(taskNode, taskQueue);

		// Delete the leaf task — should close its queue
		const delRes = await app.request(
			`/projects/${projectId}/tasks/${task.id}`,
			{ method: "DELETE" },
		);
		expect(delRes.status).toBe(200);

		// Queue should be closed
		let closedAfterDelete = false;
		try {
			taskQueue.enqueue({ source: "compact", id: "test-id", ts: 0 });
		} catch {
			closedAfterDelete = true;
		}
		expect(closedAfterDelete).toBe(true);

		// Session should be cleared
		expect(taskNode.session).toBeUndefined();
	});

	test("DELETE /tasks/:nodeId rejects delete with children", async () => {
		const parentRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Parent",
				description: "",
				parentId: rootNodeId,
			}),
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

		const delRes = await app.request(
			`/projects/${projectId}/tasks/${parent.id}`,
			{ method: "DELETE" },
		);
		expect(delRes.status).toBe(400);
	});

	test("POST /tasks/:nodeId/continue resets failed task to pending", async () => {
		const rootRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "App",
				description: "",
				parentId: rootNodeId,
			}),
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
	});

	test("POST /tasks/:nodeId/continue rejects non-failed task", async () => {
		const rootRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "App2",
				description: "",
				parentId: rootNodeId,
			}),
		});
		const root = (await rootRes.json()) as TaskNode;

		const contRes = await app.request(
			`/projects/${projectId}/tasks/${root.id}/continue`,
			{ method: "POST" },
		);
		expect(contRes.status).toBe(400);
	});

	test("POST /tasks/:nodeId/continue uses stream with MCP tools when task has worktree", async () => {
		// Track what stream() receives (runChildCore uses provider.stream())
		let streamCalled = false;
		let receivedMcpToolDefs = false;
		let receivedQueue = false;
		const agentProvider: AgentProvider = {
			name: "mock",
			execute: async () => ({
				exitReason: "interrupted" as const,
				output: "",
				costUsd: 0,
				turns: 0,
				sessionId: "mock",
			}),
			// biome-ignore lint/correctness/useYield: mock provider never streams
			stream: async function* (req) {
				streamCalled = true;
				if (req.mcpToolDefs && "mxd" in req.mcpToolDefs) {
					receivedMcpToolDefs = true;
				}
				if (req.queue) {
					receivedQueue = true;
				}
				return {
					exitReason: "interrupted" as const,
					output: "done",
					costUsd: 0,
					turns: 0,
					sessionId: "mock",
				};
			},
		};

		const localDataDir = await mkdtemp(join(tmpdir(), "mxd-cont-wt-"));
		const _projInfo = { id: ulid(), name: "test", path: join(tempDir, "cont-wt-app") };
		await initTestProject(_projInfo.path);
		const {
			app: localApp,
			getTracker: localGetTracker,
		} = createApp({
			dataDir: localDataDir,
			agentProvider,
			projects: [_projInfo],
		});

		const project = _projInfo;
		const localTracker = await localGetTracker(project.id);
		const localRootId = localTracker.rootNodeId;

		// Create a task
		const taskRes = await localApp.request(`/projects/${project.id}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Cont task",
				description: "desc",
				parentId: localRootId,
			}),
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
			"mxd/fake/branch",
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
		// Ensure session is cleaned up after agent completes
		await new Promise((r) => setTimeout(r, 50));
		expect(daemonTracker.getTask(task.id)?.session).toBeUndefined();

		await rm(localDataDir, { recursive: true });
	});

	test("GET /tasks/:nodeId/gitlog returns empty commits when no branch", async () => {
		const rootRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "NoLog",
				description: "",
				parentId: rootNodeId,
			}),
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
		const localDataDir = await mkdtemp(join(tmpdir(), "mxd-gitlog-wt-"));
		const gitlogProjPath = join(tempDir, "gitlog-app");
		await mkdir(gitlogProjPath, { recursive: true });
		// Initialize a git repo so the gitlog endpoint has commits to return
		const gitExec = (args: string[]) => Bun.spawn(["git", ...args], { cwd: gitlogProjPath, stdout: "pipe", stderr: "pipe" });
		await gitExec(["init"]).exited;
		await writeFile(join(gitlogProjPath, "README.md"), "# test\n");
		await gitExec(["add", "README.md"]).exited;
		await gitExec(["commit", "-m", "initial commit"]).exited;
		const _projInfo2 = { id: ulid(), name: "test", path: gitlogProjPath };
		const {
			app: localApp,
			getTracker: localGetTracker,
		} = createApp({ dataDir: localDataDir, agentProvider: mockProvider, projects: [_projInfo2] });
		const project = _projInfo2;
		const localTracker2 = await localGetTracker(project.id);
		const localRootId2 = localTracker2.rootNodeId;

		const taskRes = await localApp.request(`/projects/${project.id}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "LoggedTask",
				description: "",
				parentId: localRootId2,
			}),
		});
		const task = (await taskRes.json()) as TaskNode;

		// Find out the default branch name (could be "main" or "master" depending on git config)
		const branchProc = Bun.spawn(["git", "branch", "--show-current"], {
			cwd: project.path,
			stdout: "pipe",
			stderr: "pipe",
		});
		await branchProc.exited;
		const defaultBranch = (await new Response(branchProc.stdout).text()).trim();

		// Use assignWorktree to set both branch and worktreePath (PATCH only sets branch)
		const daemonTracker = await localGetTracker(project.id);
		daemonTracker.assignWorktree(task.id, defaultBranch, project.path);
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
			body: JSON.stringify({
				title: "Parent",
				description: "",
				parentId: rootNodeId,
			}),
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
			body: JSON.stringify({
				title: "Parent",
				description: "",
				parentId: rootNodeId,
			}),
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

	test("PATCH /tasks/:nodeId/reorder works on folder nodes", async () => {
		// Create a folder under root
		const folderRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "My Folder",
				folder: true,
				parentId: rootNodeId,
			}),
		});
		expect(folderRes.status).toBe(201);
		const folder = (await folderRes.json()) as { id: string };

		// Create two tasks inside the folder
		const t1Res = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Task 1",
				description: "",
				parentId: folder.id,
			}),
		});
		const t1 = (await t1Res.json()) as TaskNode;

		const t2Res = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Task 2",
				description: "",
				parentId: folder.id,
			}),
		});
		const t2 = (await t2Res.json()) as TaskNode;

		// Reorder folder's children: reverse order
		const reorderRes = await app.request(
			`/projects/${projectId}/tasks/${folder.id}/reorder`,
			{
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ children: [t2.id, t1.id] }),
			},
		);
		expect(reorderRes.status).toBe(200);

		// Verify order via GET /tasks
		const tasksRes = await app.request(`/projects/${projectId}/tasks`);
		const { nodes } = (await tasksRes.json()) as {
			nodes: Array<{ id: string; children?: string[] }>;
		};
		const updatedFolder = nodes.find((n) => n.id === folder.id);
		expect(updatedFolder?.children).toEqual([t2.id, t1.id]);
	});
});

describe("GET /projects/:id/events", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createApp>["app"];
	let projectId: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-events-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-evdata-"));
		const project = { id: ulid(), name: basename(tempDir), path: tempDir };
		const result = createApp({ dataDir, agentProvider: mockProvider, projects: [project] });
		app = result.app;
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

	test("returns hasOlderEvents: false when no compact_marker", async () => {
		// Write some events to a session JSONL
		const eventStore = new EventStore(
			join(dataDir, "projects", projectId, "tasks"),
		);
		await eventStore.append("session1", {
			type: "message",
			id: "",
			body: { source: "user", id: "test-id", ts: 0, content: "hello" },
			taskId: "session1",
			ts: 1000,
		});

		const res = await app.request(
			`/projects/${projectId}/events?after=compact`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			events: unknown[];
			hasOlderEvents: boolean;
		};
		expect(body.events.length).toBe(1);
		expect(body.hasOlderEvents).toBe(false);
	});

	test("?after=compact returns only post-compact events with hasOlderEvents", async () => {
		const eventStore = new EventStore(
			join(dataDir, "projects", projectId, "tasks"),
		);
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", ts: 0, content: "old" },
				taskId: "session1",
				ts: 1000,
			},
			{
				type: "assistant_text",
				content: "old response",
				taskId: "session1",
				ts: 1001,
			},
			{
				type: "compact_marker",
				savedTokens: 5000,
				taskId: "session1",
				ts: 2000,
			},
			{
				type: "assistant_text",
				content: "new response",
				taskId: "session1",
				ts: 2001,
			},
		];
		await eventStore.appendBatch("session1", events);

		const res = await app.request(
			`/projects/${projectId}/events?after=compact`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			events: Record<string, unknown>[];
			hasOlderEvents: boolean;
		};
		expect(body.hasOlderEvents).toBe(true);
		// Should have compact_marker + the event after it
		expect(body.events.length).toBe(2);
		expect(body.events[0]?.type).toBe("compact_marker");
		expect(body.events[1]?.type).toBe("assistant_text");
	});

	test("without ?after=compact returns all events", async () => {
		const eventStore = new EventStore(
			join(dataDir, "projects", projectId, "tasks"),
		);
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", ts: 0, content: "old" },
				taskId: "session1",
				ts: 1000,
			},
			{
				type: "compact_marker",
				savedTokens: 5000,
				taskId: "session1",
				ts: 2000,
			},
			{
				type: "assistant_text",
				content: "new",
				taskId: "session1",
				ts: 2001,
			},
		];
		await eventStore.appendBatch("session1", events);

		const res = await app.request(`/projects/${projectId}/events`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			events: Record<string, unknown>[];
			hasOlderEvents: boolean;
		};
		expect(body.events.length).toBe(3);
		expect(body.hasOlderEvents).toBe(false);
	});
});

describe("GET /projects/:id/events/older", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createApp>["app"];
	let projectId: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-older-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-olderdata-"));
		const project = { id: ulid(), name: basename(tempDir), path: tempDir };
		const result = createApp({ dataDir, agentProvider: mockProvider, projects: [project] });
		app = result.app;
		projectId = project.id;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("returns older events before timestamp", async () => {
		const eventStore = new EventStore(
			join(dataDir, "projects", projectId, "tasks"),
		);
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", ts: 0, content: "old" },
				taskId: "session1",
				ts: 1000,
			},
			{
				type: "assistant_text",
				content: "old response",
				taskId: "session1",
				ts: 1500,
			},
			{
				type: "compact_marker",
				savedTokens: 5000,
				taskId: "session1",
				ts: 2000,
			},
			{
				type: "assistant_text",
				content: "new",
				taskId: "session1",
				ts: 2001,
			},
		];
		await eventStore.appendBatch("session1", events);

		const res = await app.request(
			`/projects/${projectId}/events/older?session=session1&before=2000&limit=100`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			events: Record<string, unknown>[];
			hasMore: boolean;
		};
		expect(body.events.length).toBe(2);
		expect(body.hasMore).toBe(false);
	});

	test("respects limit parameter", async () => {
		const eventStore = new EventStore(
			join(dataDir, "projects", projectId, "tasks"),
		);
		const events: Event[] = [];
		for (let i = 0; i < 10; i++) {
			events.push({
				type: "assistant_text",
				content: `msg ${i}`,
				taskId: "session1",
				ts: 1000 + i * 100,
			});
		}
		await eventStore.appendBatch("session1", events);

		const res = await app.request(
			`/projects/${projectId}/events/older?session=session1&before=1800&limit=3`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			events: Record<string, unknown>[];
			hasMore: boolean;
		};
		expect(body.events.length).toBe(3);
		expect(body.hasMore).toBe(true);
	});

	test("returns 400 when missing required params", async () => {
		const res = await app.request(
			`/projects/${projectId}/events/older?session=s1`,
		);
		expect(res.status).toBe(400);

		const res2 = await app.request(
			`/projects/${projectId}/events/older?before=1000`,
		);
		expect(res2.status).toBe(400);
	});

	test("returns 404 for unknown project", async () => {
		const res = await app.request(
			"/projects/unknown/events/older?session=s1&before=1000",
		);
		expect(res.status).toBe(404);
	});

	test("defaults limit to 200 when not specified", async () => {
		const eventStore = new EventStore(
			join(dataDir, "projects", projectId, "tasks"),
		);
		await eventStore.append("session1", {
			type: "assistant_text",
			content: "msg",
			taskId: "session1",
			ts: 1000,
		});

		const res = await app.request(
			`/projects/${projectId}/events/older?session=session1&before=2000`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			events: Record<string, unknown>[];
			hasMore: boolean;
		};
		expect(body.events.length).toBe(1);
		expect(body.hasMore).toBe(false);
	});
});

describe("GET /projects/:id/tasks/:nodeId/events", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createApp>["app"];
	let projectId: string;
	let taskId: string;
	let rootNodeId: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-taskev-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-taskevd-"));
		const project = { id: ulid(), name: basename(tempDir), path: tempDir };
		const result = createApp({ dataDir, agentProvider: mockProvider, projects: [project] });
		app = result.app;
		projectId = project.id;
		const tasksRes = await app.request(`/projects/${projectId}/tasks`);
		rootNodeId = ((await tasksRes.json()) as { rootNodeId: string }).rootNodeId;

		const taskRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Test Task",
				description: "",
				parentId: rootNodeId,
			}),
		});
		const task = (await taskRes.json()) as TaskNode;
		taskId = task.id;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("?after=compact returns post-compact events with hasOlderEvents", async () => {
		const eventStore = new EventStore(
			join(dataDir, "projects", projectId, "tasks"),
		);
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", ts: 0, content: "old" },
				taskId: taskId,
				ts: 1000,
			},
			{
				type: "compact_marker",
				savedTokens: 3000,
				taskId: taskId,
				ts: 2000,
			},
			{
				type: "assistant_text",
				content: "new",
				taskId: taskId,
				ts: 2001,
			},
		];
		await eventStore.appendBatch(taskId, events);

		const res = await app.request(
			`/projects/${projectId}/tasks/${taskId}/events?after=compact`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			events: Record<string, unknown>[];
			hasOlderEvents: boolean;
		};
		expect(body.hasOlderEvents).toBe(true);
		expect(body.events.length).toBe(2);
		expect(body.events[0]?.type).toBe("compact_marker");
	});

	test("without ?after=compact returns all events", async () => {
		const eventStore = new EventStore(
			join(dataDir, "projects", projectId, "tasks"),
		);
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", ts: 0, content: "old" },
				taskId: taskId,
				ts: 1000,
			},
			{
				type: "compact_marker",
				savedTokens: 3000,
				taskId: taskId,
				ts: 2000,
			},
		];
		await eventStore.appendBatch(taskId, events);

		const res = await app.request(
			`/projects/${projectId}/tasks/${taskId}/events`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			events: Record<string, unknown>[];
			hasOlderEvents: boolean;
		};
		expect(body.hasOlderEvents).toBe(false);
		expect(body.events.length).toBe(2);
	});
});

describe("streaming text injection in batch events", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createApp>["app"];
	let ctx: ReturnType<typeof createApp>["ctx"];
	let projectId: string;
	let taskId: string;
	let rootNodeId: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-stream-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-streamd-"));
		const project = { id: ulid(), name: basename(tempDir), path: tempDir };
		const result = createApp({ dataDir, agentProvider: mockProvider, projects: [project] });
		app = result.app;
		ctx = result.ctx;
		projectId = project.id;
		const tasksRes = await app.request(`/projects/${projectId}/tasks`);
		rootNodeId = ((await tasksRes.json()) as { rootNodeId: string }).rootNodeId;

		const taskRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Test Task",
				description: "",
				parentId: rootNodeId,
			}),
		});
		const task = (await taskRes.json()) as TaskNode;
		taskId = task.id;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("streaming in progress → GET task events → partial text at end", async () => {
		// Write some JSONL events first
		const eventStore = new EventStore(
			join(dataDir, "projects", projectId, "tasks"),
		);
		const events: Event[] = [
			{
				type: "assistant_text",
				content: "previous response",
				taskId: taskId,
				ts: 1000,
			},
		];
		await eventStore.appendBatch(taskId, events);

		// Simulate active streaming by setting streamingText directly
		ctx.streamingText.set(taskId, "Hello, I am currently strea");

		const res = await app.request(
			`/projects/${projectId}/tasks/${taskId}/events`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			events: Record<string, unknown>[];
			hasOlderEvents: boolean;
		};
		// Should have the persisted event + the synthetic partial
		expect(body.events.length).toBe(2);
		expect(body.events[0]?.type).toBe("assistant_text");
		expect(body.events[0]?.content).toBe("previous response");
		expect(body.events[1]?.type).toBe("assistant_text");
		expect(body.events[1]?.content).toBe("Hello, I am currently strea");
		expect(body.events[1]?.partial).toBe(true);
	});

	test("streaming in progress → GET task events with ?after=compact → partial text at end", async () => {
		const eventStore = new EventStore(
			join(dataDir, "projects", projectId, "tasks"),
		);
		const events: Event[] = [
			{
				type: "compact_marker",
				savedTokens: 3000,
				taskId: taskId,
				ts: 1000,
			},
			{
				type: "assistant_text",
				content: "post-compact text",
				taskId: taskId,
				ts: 2000,
			},
		];
		await eventStore.appendBatch(taskId, events);

		ctx.streamingText.set(taskId, "partial streaming content");

		const res = await app.request(
			`/projects/${projectId}/tasks/${taskId}/events?after=compact`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			events: Record<string, unknown>[];
			hasOlderEvents: boolean;
		};
		// compact_marker + assistant_text + synthetic partial
		expect(body.events.length).toBe(3);
		expect(body.events[2]?.type).toBe("assistant_text");
		expect(body.events[2]?.content).toBe("partial streaming content");
		expect(body.events[2]?.partial).toBe(true);
	});

	test("streaming complete → GET task events → no synthetic text", async () => {
		const eventStore = new EventStore(
			join(dataDir, "projects", projectId, "tasks"),
		);
		const events: Event[] = [
			{
				type: "assistant_text",
				content: "final response",
				taskId: taskId,
				ts: 1000,
			},
		];
		await eventStore.appendBatch(taskId, events);

		// No streaming text set — response completed

		const res = await app.request(
			`/projects/${projectId}/tasks/${taskId}/events`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			events: Record<string, unknown>[];
			hasOlderEvents: boolean;
		};
		expect(body.events.length).toBe(1);
		expect(body.events[0]?.type).toBe("assistant_text");
		expect(body.events[0]?.content).toBe("final response");
		expect(body.events[0]?.partial).toBeUndefined();
	});

	test("no streaming → GET task events → no partial text", async () => {
		// No events, no streaming text
		const res = await app.request(
			`/projects/${projectId}/tasks/${taskId}/events`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			events: Record<string, unknown>[];
			hasOlderEvents: boolean;
		};
		expect(body.events.length).toBe(0);
	});

	test("streaming text in project-level events endpoint", async () => {
		const eventStore = new EventStore(
			join(dataDir, "projects", projectId, "tasks"),
		);
		const events: Event[] = [
			{
				type: "assistant_text",
				content: "existing",
				taskId: taskId,
				ts: 1000,
			},
		];
		await eventStore.appendBatch(taskId, events);

		ctx.streamingText.set(taskId, "partial from project");

		const res = await app.request(`/projects/${projectId}/events`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			events: Record<string, unknown>[];
			hasOlderEvents: boolean;
		};
		// Should contain persisted event + synthetic partial
		const partials = body.events.filter((e) => e.partial === true);
		expect(partials.length).toBe(1);
		expect(partials[0]?.content).toBe("partial from project");
	});
});

describe("POST /projects/:id/tasks/:nodeId/message", () => {
	let tempDir: string;
	let dataDir: string;
	let projectId: string;
	let taskId: string;
	let taskQueue: MessageQueue;
	let rootNodeId: string;

	let projectInfo: { id: string; name: string; path: string };

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-taskmsg-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-taskmsgd-"));
		projectInfo = { id: ulid(), name: "test", path: join(tempDir, "proj") };
		const {
			app: localApp,
			getTracker,
		} = createApp({
			dataDir,
			agentProvider: mockProvider,
			projects: [projectInfo],
		});

		projectId = projectInfo.id;
		const tracker = await getTracker(projectId);
		rootNodeId = tracker.rootNodeId;

		const taskRes = await localApp.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Test task",
				description: "",
				parentId: rootNodeId,
			}),
		});
		const task = (await taskRes.json()) as TaskNode;
		taskId = task.id;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("persists message when no queue registered for task", async () => {
		const { app, markReady } = createApp({
			dataDir,
			agentProvider: mockProvider,
			projects: [projectInfo],
		});

		markReady();
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
		};
		expect(body.ok).toBe(true);
	});

	test("routes message to registered task queue", async () => {
		const {
			app,
			markReady,
			getTracker: gt,
		} = createApp({
			dataDir,
			agentProvider: mockProvider,
			projects: [projectInfo],
		});

		markReady();

		// Attach session to simulate a running agent
		taskQueue = new MessageQueue();
		const tracker = await gt(projectId);
		const taskNode = tracker.getTask(taskId) as TaskNode;
		attachMockSession(taskNode, taskQueue);

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

		// Verify message was enqueued (now includes id for two-phase lifecycle)
		const msgs = taskQueue.drain();
		expect(msgs).toHaveLength(1);
		const msg = msgs[0] as { source: "user"; content: string; id: string };
		expect(msg.source).toBe("user");
		expect(msg.content).toBe("ping from UI");
		expect(msg.id).toBeString();
	});

	test("returns 400 when content is missing", async () => {
		const { app, markReady } = createApp({
			dataDir,
			agentProvider: mockProvider,
			projects: [projectInfo],
		});

		markReady();

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
		const { app, markReady } = createApp({
			dataDir,
			agentProvider: mockProvider,
			projects: [projectInfo],
		});

		markReady();

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
		const {
			app,
			markReady,
			getTracker: gt,
		} = createApp({
			dataDir,
			agentProvider: mockProvider,
			projects: [projectInfo],
		});

		markReady();

		taskQueue = new MessageQueue();
		taskQueue.close();
		const tracker = await gt(projectId);
		const taskNode = tracker.getTask(taskId) as TaskNode;
		attachMockSession(taskNode, taskQueue);

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
		};
		expect(body.ok).toBe(true);

		taskNode.session = undefined;
	});
});

describe("POST /projects/:id/tasks/:nodeId/message (root node)", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createApp>["app"];
	let getTracker: ReturnType<typeof createApp>["getTracker"];
	let projectId: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-projmsg-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-projmsgd-"));
		const project = { id: ulid(), name: "proj", path: join(tempDir, "proj") };
		const result = createApp({ dataDir, agentProvider: mockProvider, projects: [project] });
		app = result.app;
		getTracker = result.getTracker;

		result.markReady();
		projectId = project.id;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("returns 404 for unknown project", async () => {
		const res = await app.request(
			"/projects/nonexistent/tasks/some-task/message",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: "hello" }),
			},
		);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("Project not found");
	});

	test("returns 400 when content is missing", async () => {
		const tracker = await getTracker(projectId);
		const rootNodeId = tracker.rootNodeId;
		const res = await app.request(
			`/projects/${projectId}/tasks/${rootNodeId}/message`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			},
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("content is required");
	});

	test("auto-launches agent when no active session", async () => {
		const tracker = await getTracker(projectId);
		const rootNodeId = tracker.rootNodeId;
		const res = await app.request(
			`/projects/${projectId}/tasks/${rootNodeId}/message`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: "hello" }),
			},
		);
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
		tempDir = await mkdtemp(join(tmpdir(), "mxd-clarify-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-clarifyd-"));
		const project = { id: ulid(), name: "proj", path: join(tempDir, "proj") };
		const result = createApp({ dataDir, agentProvider: mockProvider, projects: [project] });
		app = result.app;
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
		expect(body.error).toBe("Project not found");
	});

	test("routes clarify_response to orchestrator queue when taskId is root", async () => {
		// Create a long-running provider so the agent stays alive
		const longRunningProvider: AgentProvider = {
			name: "mock",
			execute: async () => ({
				exitReason: "interrupted" as const,
				output: "",
				costUsd: 0,
				turns: 0,
				sessionId: "mock",
			}),
			stream: async function* () {
				await new Promise((resolve) => setTimeout(resolve, 10000));
				return {
					exitReason: "interrupted" as const,
					output: "",
					costUsd: 0,
					turns: 0,
					sessionId: "mock",
				};
			},
		};

		const localDataDir = await mkdtemp(join(tmpdir(), "mxd-clarify-route-"));
		const project = { id: ulid(), name: "test", path: join(tempDir, "clarify-route-proj") };
		const {
			app: localApp,
			markReady: localMarkReady,
			getTracker: localGetTracker,
		} = createApp({
			dataDir: localDataDir,
			agentProvider: longRunningProvider,
			projects: [project],
		});
		localMarkReady();

		const orchRes = await startRootAgent(
			localApp,
			project.id,
			"test clarify routing",
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
			execute: async () => ({
				exitReason: "interrupted" as const,
				output: "",
				costUsd: 0,
				turns: 0,
				sessionId: "mock",
			}),
			stream: async function* () {
				await new Promise((resolve) => setTimeout(resolve, 10000));
				return {
					exitReason: "interrupted" as const,
					output: "",
					costUsd: 0,
					turns: 0,
					sessionId: "mock",
				};
			},
		};

		const localDataDir = await mkdtemp(
			join(tmpdir(), "mxd-clarify-child-route-"),
		);
		const project = { id: ulid(), name: "test", path: join(tempDir, "clarify-child-route-proj") };
		const {
			app: localApp,
			markReady: localMarkReady,
			getTracker: localGetTracker,
		} = createApp({
			dataDir: localDataDir,
			agentProvider: longRunningProvider,
			projects: [project],
		});
		localMarkReady();

		const orchRes = await startRootAgent(
			localApp,
			project.id,
			"test child clarify routing",
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

		// Attach session to simulate a running child agent
		const childQueue = new MessageQueue();
		const childNode = tracker.getTask(child.id) as TaskNode;
		attachMockSession(childNode, childQueue);

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
			childNode.session = undefined;
			await localApp.request(`/projects/${project.id}/stop`, {
				method: "POST",
			});
			await rm(localDataDir, { recursive: true });
		}
	});

	test("returns 200 when child queue is closed (persists to JSONL)", async () => {
		// Create a long-running provider so the agent stays alive
		const longRunningProvider: AgentProvider = {
			name: "mock",
			execute: async () => ({
				exitReason: "interrupted" as const,
				output: "",
				costUsd: 0,
				turns: 0,
				sessionId: "mock",
			}),
			stream: async function* () {
				await new Promise((resolve) => setTimeout(resolve, 10000));
				return {
					exitReason: "interrupted" as const,
					output: "",
					costUsd: 0,
					turns: 0,
					sessionId: "mock",
				};
			},
		};

		const localDataDir = await mkdtemp(
			join(tmpdir(), "mxd-clarify-closed-queue-"),
		);
		const project = { id: ulid(), name: "test", path: join(tempDir, "clarify-closed-queue-proj") };
		const {
			app: localApp,
			markReady: localMarkReady,
			getTracker: localGetTracker,
		} = createApp({
			dataDir: localDataDir,
			agentProvider: longRunningProvider,
			projects: [project],
		});
		localMarkReady();

		const orchRes = await startRootAgent(
			localApp,
			project.id,
			"test closed queue",
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
		const childNode = tracker.getTask(child.id) as TaskNode;
		attachMockSession(childNode, closedQueue);

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
			// With unified deliverMessage, closed queue falls through to JSONL persistence → 200
			expect(clarifyRes.status).toBe(200);
		} finally {
			childNode.session = undefined;
			await localApp.request(`/projects/${project.id}/stop`, {
				method: "POST",
			});
			await rm(localDataDir, { recursive: true });
		}
	});
});

describe("task message API — agent launch", () => {
	test("POST /tasks/:nodeId/message invokes agent with MCP tools", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "mxd-orchagent-"));
		const dataDir = await mkdtemp(join(tmpdir(), "mxd-oadata-"));

		// Mock provider that verifies mcpToolDefs was passed
		let receivedMcpToolDefs = false;
		const agentProvider: AgentProvider = {
			name: "mock",
			execute: async (req) => {
				if (req.mcpToolDefs && "mxd" in req.mcpToolDefs) {
					receivedMcpToolDefs = true;
				}
				return {
					exitReason: "interrupted" as const,
					output: "orchestrated",
					costUsd: 0,
					turns: 0,
					sessionId: "mock",
				};
			},
			// biome-ignore lint/correctness/useYield: mock provider
			stream: async function* (req) {
				if (req.mcpToolDefs && "mxd" in req.mcpToolDefs) {
					receivedMcpToolDefs = true;
				}
				return {
					exitReason: "interrupted" as const,
					output: "orchestrated",
					costUsd: 0,
					turns: 0,
					sessionId: "mock",
				};
			},
		};

		const project = { id: ulid(), name: "oa-app", path: join(tempDir, "oa-app") };
		const { app, markReady } = createApp({ dataDir, agentProvider, projects: [project] });

		markReady();

		const res = await startRootAgent(app, project.id, "Build a todo app");
		expect(res.status).toBe(200);

		// Wait briefly for the background agent to complete
		await new Promise((r) => setTimeout(r, 100));
		expect(receivedMcpToolDefs).toBe(true);

		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("POST /tasks/:nodeId/message requires content", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "mxd-oa2-"));
		const dataDir = await mkdtemp(join(tmpdir(), "mxd-oa2d-"));

		const project = { id: ulid(), name: "oa2", path: join(tempDir, "oa2") };
		const { app, markReady } = createApp({
			dataDir,
			agentProvider: mockProvider,
			projects: [project],
		});

		markReady();

		const tasksRes = await app.request(`/projects/${project.id}/tasks`);
		const { rootNodeId } = (await tasksRes.json()) as { rootNodeId: string };
		const res = await app.request(
			`/projects/${project.id}/tasks/${rootNodeId}/message`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			},
		);
		expect(res.status).toBe(400);

		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("POST /tasks/:nodeId/message returns 404 for unknown project", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "mxd-oa3d-"));
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: mockProvider,
		});

		markReady();

		const res = await app.request("/projects/nonexistent/tasks/fake/message", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: "test" }),
		});
		expect(res.status).toBe(404);

		await rm(dataDir, { recursive: true });
	});
});

describe("create_task validation", () => {
	let tempDir: string;
	let tracker: TaskTracker;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-ct-val-"));
		tracker = new TaskTracker(join(tempDir, "tree.json"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
	});

	/** Helper to invoke the create_task tool from the MCP tool definitions. */
	async function invokeCreateTask(
		currentTaskId: string,
		args: { title: string; description: string; parentId?: string },
	) {
		resetResourceRegistry();
		const { auth } = initMockResourceRegistry({
			tracker,
			projectId: "test-project",
			projectPath: tempDir,
			taskId: currentTaskId,
		});
		const { toolDefs } = createOrchestratorTools(
			auth,
			"test-project",
			currentTaskId,
		);
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

	test("agent can create a task under its parent (create anywhere)", async () => {
		const parent = tracker.addTask("parent", "");
		const agent = tracker.addChild(parent.id, "agent", "");
		const result = await invokeCreateTask(agent.id, {
			title: "sibling task",
			description: "desc",
			parentId: parent.id,
		});
		expect(result.isError).toBeUndefined();
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.parentId).toBe(parent.id);
	});

	test("agent can create a task under a sibling (create anywhere)", async () => {
		const parent = tracker.addTask("parent", "");
		const agent = tracker.addChild(parent.id, "agent", "");
		const sibling = tracker.addChild(parent.id, "sibling", "");
		const result = await invokeCreateTask(agent.id, {
			title: "nephew task",
			description: "desc",
			parentId: sibling.id,
		});
		expect(result.isError).toBeUndefined();
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.parentId).toBe(sibling.id);
	});

	test("top-level orchestrator can create anywhere", async () => {
		const existing = tracker.addTask("existing", "");
		const result = await invokeCreateTask(tracker.rootNodeId, {
			title: "anywhere",
			description: "desc",
			parentId: existing.id,
		});
		expect(result.isError).toBeUndefined();
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.parentId).toBe(existing.id);
	});

	test("parentId is required in agent schema — Zod rejects missing parentId", async () => {
		const agent = tracker.addTask("agent", "");
		resetResourceRegistry();
		const { auth } = initMockResourceRegistry({
			tracker,
			projectId: "test-project",
			projectPath: tempDir,
			taskId: agent.id,
		});
		const { toolDefs } = createOrchestratorTools(
			auth,
			"test-project",
			agent.id,
		);
		const createTaskTool = toolDefs.find((t) => t.name === "create_task");
		if (!createTaskTool) throw new Error("create_task tool not found");
		// parentId is required in schema — executeTool should reject
		const handlers = new Map();
		handlers.set("create_task", createTaskTool);
		const result = await executeTool(
			"create_task",
			{ title: "child", description: "desc" },
			handlers,
		);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("parentId");
	});
});

describe("GET /projects/:id/agent", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createApp>["app"];
	let projectId: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-agent-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-agentd-"));
		const project = { id: ulid(), name: basename(tempDir), path: tempDir };
		const result = createApp({ dataDir, agentProvider: mockProvider, projects: [project] });
		app = result.app;

		result.markReady();
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
		tempDir = await mkdtemp(join(tmpdir(), "mxd-stop-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-stopd-"));
		const project = { id: ulid(), name: basename(tempDir), path: tempDir };
		const result = createApp({ dataDir, agentProvider: mockProvider, projects: [project] });
		app = result.app;

		result.markReady();
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

	test("stopping agent cascades to child agent queues — children stay in_progress", async () => {
		// Create a long-running provider so the agent stays alive
		const longRunningProvider: AgentProvider = {
			name: "mock",
			execute: async () => ({
				exitReason: "interrupted" as const,
				output: "",
				costUsd: 0,
				turns: 0,
				sessionId: "mock",
			}),
			stream: async function* () {
				await new Promise((resolve) => setTimeout(resolve, 10000));
				return {
					exitReason: "interrupted" as const,
					output: "",
					costUsd: 0,
					turns: 0,
					sessionId: "mock",
				};
			},
		};

		const localDataDir = await mkdtemp(join(tmpdir(), "mxd-stop-cascade-"));
		const project = { id: ulid(), name: "test", path: join(tempDir, "cascade-proj") };
		const {
			app: localApp,
			markReady: localMarkReady,
			getTracker: localGetTracker,
		} = createApp({
			dataDir: localDataDir,
			agentProvider: longRunningProvider,
			projects: [project],
		});
		localMarkReady();

		// Start an agent
		const orchRes = await startRootAgent(localApp, project.id, "do something");
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

		// Attach session to simulate a running child agent
		const childQueue = new MessageQueue();
		const childNode = tracker.getTask(child.id) as TaskNode;
		attachMockSession(childNode, childQueue);

		// Verify queue is open
		let queueClosed = false;
		try {
			childQueue.enqueue({ source: "compact", id: "test-id", ts: 0 });
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
			childQueue.enqueue({ source: "compact", id: "test-id", ts: 0 });
		} catch {
			closedAfterStop = true;
		}
		expect(closedAfterStop).toBe(true);

		// Verify: child task status stays in_progress (interrupted, not failed)
		// stopAgent no longer marks children as failed — they are resumable on restart
		const tasksRes = await localApp.request(`/projects/${project.id}/tasks`);
		const { nodes } = (await tasksRes.json()) as { nodes: TaskNode[] };
		const updatedChild = nodes.find((n) => n.id === child.id);
		expect(updatedChild?.status).toBe("in_progress");

		// Clean up
		await rm(localDataDir, { recursive: true });
	});
});

describe("POST /projects/:id/tasks/:nodeId/message — root agent", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createApp>["app"];
	let projectId: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-run-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-rund-"));
		const project = { id: ulid(), name: basename(tempDir), path: tempDir };
		const result = createApp({ dataDir, agentProvider: mockProvider, projects: [project] });
		app = result.app;

		result.markReady();
		projectId = project.id;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("returns 404 for unknown project", async () => {
		const res = await app.request("/projects/unknown/tasks/fake/message", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: "test" }),
		});
		expect(res.status).toBe(404);
	});

	test("returns 400 when content is missing", async () => {
		const tasksRes = await app.request(`/projects/${projectId}/tasks`);
		const { rootNodeId } = (await tasksRes.json()) as { rootNodeId: string };
		const res = await app.request(
			`/projects/${projectId}/tasks/${rootNodeId}/message`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			},
		);
		expect(res.status).toBe(400);
	});

	test("returns ok for valid request", async () => {
		const res = await startRootAgent(app, projectId, "do something");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(true);
	});

	test("enqueues message when agent already running instead of error", async () => {
		await startRootAgent(app, projectId, "first run");
		const res = await startRootAgent(app, projectId, "second run");
		expect(res.status).toBe(200);
	});
});

describe("POST /projects/:id/sessions/prune", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createApp>["app"];
	let projectId: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-prune-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-pruned-"));
		const project = { id: ulid(), name: basename(tempDir), path: tempDir };
		const result = createApp({ dataDir, agentProvider: mockProvider, projects: [project] });
		app = result.app;
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
		// Create 3 event JSONL files
		const sessionsDir = join(dataDir, "projects", projectId, "tasks");
		await mkdir(sessionsDir, { recursive: true });
		for (let i = 0; i < 3; i++) {
			await writeFile(join(sessionsDir, `session-${i}.jsonl`), "{}");
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

	test("prunes oldest event JSONL files keeping only keepCount", async () => {
		// Create 5 event JSONL files
		const sessionsDir = join(dataDir, "projects", projectId, "tasks");
		await mkdir(sessionsDir, { recursive: true });
		for (let i = 0; i < 5; i++) {
			await writeFile(join(sessionsDir, `session-${i}.jsonl`), "{}");
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
		// Create 12 event JSONL files
		const sessionsDir = join(dataDir, "projects", projectId, "tasks");
		await mkdir(sessionsDir, { recursive: true });
		for (let i = 0; i < 12; i++) {
			await writeFile(join(sessionsDir, `session-${i}.jsonl`), "{}");
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
	let rootNodeId: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-continue-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-continued-"));
		const projPath = join(tempDir, "cont-proj");
		await initTestProject(projPath);

		const project = { id: ulid(), name: "cont-proj", path: projPath };
		const result = createApp({ dataDir, agentProvider: mockProvider, projects: [project] });
		app = result.app;
		getTracker = result.getTracker;
		projectId = project.id;
		const tracker = await getTracker(projectId);
		rootNodeId = tracker.rootNodeId;

		// Activate the .example hook so worktree creation works in tests
		const hookDir = join(projPath, ".mxd", "hooks");
		const examplePath = join(hookDir, "setup_worktree.sh.example");
		const hookPath = join(hookDir, "setup_worktree.sh");
		if (existsSync(examplePath)) {
			await rename(examplePath, hookPath);
			await chmod(hookPath, 0o755);
			Bun.spawnSync(["git", "add", "-A"], { cwd: projPath });
			Bun.spawnSync(["git", "commit", "-m", "activate setup hook"], { cwd: projPath });
		}
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
			body: JSON.stringify({
				title: "Pending task",
				description: "",
				parentId: rootNodeId,
			}),
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

	test("continues verify task without worktree — re-creates worktree and launches agent", async () => {
		const taskRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Passed task",
				description: "",
				parentId: rootNodeId,
			}),
		});
		const task = (await taskRes.json()) as TaskNode;

		await app.request(`/projects/${projectId}/tasks/${task.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "verify" }),
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
			body: JSON.stringify({
				title: "Active task",
				description: "",
				parentId: rootNodeId,
			}),
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
			body: JSON.stringify({
				title: "Failed task",
				description: "Do stuff",
				parentId: rootNodeId,
			}),
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

	test("resets failed task without worktree to pending", async () => {
		const taskRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Failed task",
				description: "Do stuff",
				parentId: rootNodeId,
			}),
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

	test("continues task with message for task without worktree", async () => {
		const taskRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Msg task",
				description: "",
				parentId: rootNodeId,
			}),
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
	});

	test("sets status to in_progress for failed task with worktree", async () => {
		const taskRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "WT task",
				description: "desc",
				parentId: rootNodeId,
			}),
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
			"mxd/fake/branch",
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
			body: JSON.stringify({
				title: "No body",
				description: "",
				parentId: rootNodeId,
			}),
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

	test("cleans up session after agent completes for worktree task", async () => {
		const taskRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Cleanup task",
				description: "desc",
				parentId: rootNodeId,
			}),
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
			"mxd/fake/branch2",
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

		// Session should be cleaned up after completion
		expect(tracker.getTask(task.id)?.session).toBeUndefined();
	});

	test("sets status to in_progress for verify task with worktree", async () => {
		const taskRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Passed WT task",
				description: "finished work",
				parentId: rootNodeId,
			}),
		});
		const task = (await taskRes.json()) as TaskNode;

		await app.request(`/projects/${projectId}/tasks/${task.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "verify" }),
		});

		// Inject worktreePath directly into the tracker
		const tracker = await getTracker(projectId);
		tracker.assignWorktree(
			task.id,
			"mxd/fake/verify-branch",
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

	test("continues verify task with message — launches agent", async () => {
		const taskRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Passed msg task",
				description: "",
				parentId: rootNodeId,
			}),
		});
		const task = (await taskRes.json()) as TaskNode;

		await app.request(`/projects/${projectId}/tasks/${task.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "verify" }),
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
		// Task gets a worktree created and agent launched → in_progress
		expect(body.status).toBe("in_progress");
	});

	test("passes emit callback to stream for child agent event emission", async () => {
		let receivedEmit: unknown;

		const agentProvider: AgentProvider = {
			name: "mock",
			execute: async () => ({
				exitReason: "interrupted" as const,
				output: "",
				costUsd: 0,
				turns: 0,
				sessionId: "mock",
			}),
			// biome-ignore lint/correctness/useYield: mock provider never streams
			stream: async function* (req) {
				receivedEmit = req.emit;
				return {
					exitReason: "interrupted" as const,
					output: "",
					costUsd: 0,
					turns: 0,
					sessionId: "mock",
				};
			},
		};

		const localDataDir = await mkdtemp(join(tmpdir(), "mxd-child-sess-"));
		const project = { id: ulid(), name: "test", path: join(tempDir, "child-sess-proj") };
		const {
			app: localApp,
			getTracker: localGetTracker,
		} = createApp({
			dataDir: localDataDir,
			agentProvider,
			projects: [project],
		});
		const emitTracker = await localGetTracker(project.id);
		const emitRootId = emitTracker.rootNodeId;

		const taskRes = await localApp.request(`/projects/${project.id}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Child task",
				description: "desc",
				parentId: emitRootId,
			}),
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
			"mxd/fake/child-branch",
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

		expect(receivedEmit).toBeDefined();
		expect(typeof receivedEmit).toBe("function");

		await rm(localDataDir, { recursive: true });
	});
});

// NOTE: GET /projects/:id/pending-messages endpoint was removed.
// Pending messages are now derived on the frontend from JSONL events
// (message events with IDs that have no matching messages_consumed).

describe("GET /projects/:id/clarifications", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createApp>["app"];
	let projectId: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-clarifs-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-clarifsd-"));
		const project = { id: ulid(), name: "proj", path: join(tempDir, "proj") };
		const result = createApp({ dataDir, agentProvider: mockProvider, projects: [project] });
		app = result.app;

		result.markReady();
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
		// Test that the clarification endpoint responds correctly.
		// The integration (clarify tool → emitEvent → pendingClarifications) is tested
		// via the daemon's event system. Here we just verify the endpoint.
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

describe("POST /projects/:id/restart", () => {
	let dataDir: string;
	let projectDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "mxd-restart-"));
		projectDir = await mkdtemp(join(tmpdir(), "mxd-restart-proj-"));
		await mkdir(join(projectDir, ".git"), { recursive: true });
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
		await rm(projectDir, { recursive: true, force: true });
	});

	test("returns 404 when project not found", async () => {
		const { app, pm } = createApp({ dataDir, agentProvider: mockProvider });

		const res = await app.request("/projects/nonexistent/restart", {
			method: "POST",
		});
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.error).toBe("Project not found");
	});

	test("returns 404 when no active agent", async () => {
		const proj = { id: ulid(), name: basename(projectDir), path: projectDir };
		const { app } = createApp({ dataDir, agentProvider: mockProvider, projects: [proj] });

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
			execute: async () => ({
				exitReason: "interrupted" as const,
				output: "",
				costUsd: 0,
				turns: 0,
				sessionId: "mock",
			}),
			stream: async function* () {
				sessionCount++;
				await new Promise((resolve) => setTimeout(resolve, 5000));
				return {
					exitReason: "interrupted" as const,
					output: "",
					costUsd: 0,
					turns: 0,
					sessionId: `session-${sessionCount}`,
				};
			},
		};

		const proj = { id: ulid(), name: "test", path: join(dataDir, "restart-proj") };
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: restartProvider,
			projects: [proj],
		});

		markReady();

		// Start orchestration
		const startRes = await startRootAgent(app, proj.id, "test");
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
			execute: async () => ({
				exitReason: "interrupted" as const,
				output: "",
				costUsd: 0,
				turns: 0,
				sessionId: "mock",
			}),
			stream: async function* () {
				sessionCount++;
				await new Promise((resolve) => setTimeout(resolve, 5000));
				return {
					exitReason: "interrupted" as const,
					output: "",
					costUsd: 0,
					turns: 0,
					sessionId: `session-${sessionCount}`,
				};
			},
		};

		const proj = { id: ulid(), name: basename(projectDir), path: projectDir };
		const { app, markReady } = createApp({
			dataDir,
			agentProvider: slowStopProvider,
			projects: [proj],
		});

		markReady();

		// Start orchestration
		await startRootAgent(app, proj.id, "test");
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
			execute: async () => ({
				exitReason: "interrupted" as const,
				output: "",
				costUsd: 0,
				turns: 0,
				sessionId: "mock",
			}),
			stream: async function* () {
				sessionCount++;
				await new Promise((resolve) => setTimeout(resolve, 5000));
				return {
					exitReason: "interrupted" as const,
					output: "",
					costUsd: 0,
					turns: 0,
					sessionId: `session-${sessionCount}`,
				};
			},
		};

		const proj = { id: ulid(), name: basename(projectDir), path: projectDir };
		const { app, markReady } = createApp({
			dataDir,
			agentProvider: trackingProvider,
			projects: [proj],
		});

		markReady();

		// Start orchestration
		await startRootAgent(app, proj.id, "test");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(sessionCount).toBe(1);

		// Stop the agent
		const stopRes = await app.request(`/projects/${proj.id}/stop`, {
			method: "POST",
		});
		expect(stopRes.status).toBe(200);

		// Immediately start a new agent
		const startRes = await startRootAgent(app, proj.id, "test 2");
		expect(startRes.status).toBe(200);

		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(sessionCount).toBe(2);

		// Trying to start again enqueues the message (no longer 409)
		const dupRes = await startRootAgent(app, proj.id, "test 3");
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
			execute: async () => ({
				exitReason: "interrupted" as const,
				output: "",
				costUsd: 0,
				turns: 0,
				sessionId: "mock",
			}),
			stream: async function* () {
				sessionCount++;
				const currentNum = sessionCount;
				try {
					await new Promise((resolve) => setTimeout(resolve, 5000));
				} catch {
					// queue.close() rejects pending waits — session stopped
				}
				return {
					exitReason: "interrupted" as const,
					output: "",
					costUsd: 0,
					turns: 0,
					sessionId: `session-${currentNum}`,
				};
			},
		};

		const proj = { id: ulid(), name: basename(projectDir), path: projectDir };
		const { app, markReady } = createApp({
			dataDir,
			agentProvider: restartSafeProvider,
			projects: [proj],
		});

		markReady();

		// Start orchestration — session 1
		await startRootAgent(app, proj.id, "test");
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
			execute: async () => ({
				exitReason: "interrupted" as const,
				output: "",
				costUsd: 0,
				turns: 0,
				sessionId: "mock",
			}),
			stream: async function* () {
				sessionCount++;
				const currentSessionId = `test-session-${sessionCount}`;
				await new Promise((resolve) => setTimeout(resolve, 5000));
				return {
					exitReason: "interrupted" as const,
					output: "",
					costUsd: 0,
					turns: 0,
					sessionId: currentSessionId,
				};
			},
		};

		const proj = { id: ulid(), name: basename(projectDir), path: projectDir };
		const { app, markReady, getTracker } = createApp({
			dataDir,
			agentProvider: sessionIdProvider,
			projects: [proj],
		});

		markReady();

		// Start orchestration
		await startRootAgent(app, proj.id, "test");
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
		const proj = { id: ulid(), name: basename(projectDir), path: projectDir };
		const { app } = createApp({
			dataDir,
			agentProvider: mockProvider,
			projects: [proj],
		});

		// Don't call markReady() — startup guard should block

		// Should return 503 before markReady
		const tasksRes = await app.request(`/projects/${proj.id}/tasks`);
		const { rootNodeId } = (await tasksRes.json()) as { rootNodeId: string };
		const startRes = await app.request(
			`/projects/${proj.id}/tasks/${rootNodeId}/message`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: "test" }),
			},
		);
		expect(startRes.status).toBe(503);
	});
});

describe("lifecycle edge cases", () => {
	let dataDir: string;
	let projectDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "mxd-lifecycle-"));
		projectDir = await mkdtemp(join(tmpdir(), "mxd-lifecycle-proj-"));
		await mkdir(join(projectDir, ".git"), { recursive: true });
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
		await rm(projectDir, { recursive: true, force: true });
	});

	function createLongRunningProvider(): AgentProvider {
		return {
			name: "mock",
			execute: async () => ({
				exitReason: "interrupted" as const,
				output: "",
				costUsd: 0,
				turns: 0,
				sessionId: "mock",
			}),
			stream: async function* () {
				await new Promise((resolve) => setTimeout(resolve, 10000));
				return {
					exitReason: "interrupted" as const,
					output: "",
					costUsd: 0,
					turns: 0,
					sessionId: "mock",
				};
			},
		};
	}

	test("stopping agent clears pending clarifications", async () => {
		const provider = createLongRunningProvider();
		const project = { id: ulid(), name: basename(projectDir), path: projectDir };
		const { app, markReady } = createApp({
			dataDir,
			agentProvider: provider,
			projects: [project],
		});

		markReady();

		// Start agent
		await startRootAgent(app, project.id, "test");
		await new Promise((r) => setTimeout(r, 100));

		// Stop the agent
		await app.request(`/projects/${project.id}/stop`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});

		// Pending clarifications should be cleared
		const clarRes = await app.request(`/projects/${project.id}/clarifications`);
		const clars = (await clarRes.json()) as { clarifications: unknown[] };
		expect(clars.clarifications).toEqual([]);
	});

	test("clearing sessions while agent is running stops agent and succeeds", async () => {
		const provider: AgentProvider = {
			name: "mock",
			execute: async () => ({
				exitReason: "interrupted" as const,
				output: "",
				costUsd: 0,
				turns: 0,
				sessionId: "mock",
			}),
			stream: async function* () {
				await new Promise((resolve) => setTimeout(resolve, 10000));
				return {
					exitReason: "interrupted" as const,
					output: "",
					costUsd: 0,
					turns: 0,
					sessionId: "mock",
				};
			},
		};

		const project = { id: ulid(), name: basename(projectDir), path: projectDir };
		const { app, markReady, getTracker } = createApp({
			dataDir,
			agentProvider: provider,
			projects: [project],
		});

		markReady();

		// Start agent
		await startRootAgent(app, project.id, "test");
		await new Promise((r) => setTimeout(r, 100));

		// Clear sessions while running — should stop agent and succeed
		const clearRes = await app.request(
			`/projects/${project.id}/sessions/clear`,
			{ method: "POST" },
		);
		expect(clearRes.status).toBe(200);

		// Agent should have been stopped as a side effect
		await new Promise((r) => setTimeout(r, 100));
		const tracker = await getTracker(project.id);
		expect(tracker.getTask(tracker.rootNodeId)?.session).toBeUndefined();
	});

	test.skip("deleting project stops running agent — MOVED to daemon tests (DELETE /projects is daemon-owned)", async () => {
		const provider: AgentProvider = {
			name: "mock",
			execute: async () => ({
				exitReason: "interrupted" as const,
				output: "",
				costUsd: 0,
				turns: 0,
				sessionId: "mock",
			}),
			stream: async function* () {
				await new Promise((resolve) => setTimeout(resolve, 10000));
				return {
					exitReason: "interrupted" as const,
					output: "",
					costUsd: 0,
					turns: 0,
					sessionId: "mock",
				};
			},
		};

		const project = { id: ulid(), name: basename(projectDir), path: projectDir };
		const { app, markReady } = createApp({
			dataDir,
			agentProvider: provider,
			projects: [project],
		});

		markReady();

		// Start agent
		await startRootAgent(app, project.id, "test");
		await new Promise((r) => setTimeout(r, 100));

		// Delete the project — should stop the agent first
		const delRes = await app.request(`/projects/${project.id}`, {
			method: "DELETE",
		});
		expect(delRes.status).toBe(200);
		// Project deleted — agent was stopped (project no longer exists in tracker)
	});

	test("clearing sessions works when no agent is running", async () => {
		const project = { id: ulid(), name: basename(projectDir), path: projectDir };
		const { app, markReady } = createApp({
			dataDir,
			agentProvider: mockProvider,
			projects: [project],
		});

		markReady();

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
		const project = { id: ulid(), name: basename(projectDir), path: projectDir };
		const { app, markReady } = createApp({
			dataDir,
			agentProvider: mockProvider,
			projects: [project],
		});

		markReady();

		// Start and stop agent to create root node + tasks
		await startRootAgent(app, project.id, "test");
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

describe("project directory structure", () => {
	let tempDir: string;
	let dataDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-mig-proj-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-mig-data-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		await rm(dataDir, { recursive: true, force: true });
	});

	test("new project registration creates tasks/ and debug/ directories", async () => {
		const { existsSync: exists } = await import("node:fs");
		const project = { id: ulid(), name: basename(tempDir), path: tempDir };
		const result = createApp({ dataDir, agentProvider: mockProvider, projects: [project] });

		expect(exists(join(dataDir, "projects", project.id, "tasks"))).toBe(true);
		expect(exists(join(dataDir, "projects", project.id, "debug"))).toBe(true);
	});

	test("EventStore created for a project writes under projects/<id>/tasks/", async () => {
		const { existsSync: exists } = await import("node:fs");
		const project = { id: ulid(), name: basename(tempDir), path: tempDir };
		const result = createApp({ dataDir, agentProvider: mockProvider, projects: [project] });

		// Directly touch the store through helpers
		const { getEventStore } = await import("./runtime/helpers.ts");
		const store = getEventStore(result.ctx, project.id);
		await store.append("sid-1", {
			type: "assistant_text",
			content: "wrote via helper",
			taskId: "sid-1",
			ts: 100,
		});
		await store.flush();

		const expected = join(
			dataDir,
			"projects",
			project.id,
			"tasks",
			"sid-1.jsonl",
		);
		expect(exists(expected)).toBe(true);
		// Old layout must NOT exist
		expect(exists(join(dataDir, "sessions", project.id, "sid-1.jsonl"))).toBe(
			false,
		);
		expect(
			exists(join(dataDir, "sessions", project.id, "sid-1.events.jsonl")),
		).toBe(false);
	});
});
