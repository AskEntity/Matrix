import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentProvider } from "./agent-provider.ts";
import { createOrchestratorTools, isDescendantOf } from "./agent-tools.ts";
import { createApp } from "./daemon.ts";
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
		startSession() {
			throw new Error("Not implemented in mock");
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
			pending: 0,
			in_progress: 0,
			testing: 0,
			passed: 0,
			failed: 0,
			stuck: 0,
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
		};
		expect(body.nodes).toHaveLength(1);
		expect(body.nodes[0]?.title).toBe("App");
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
});

describe("daemon orchestrate/agent API", () => {
	test("POST /orchestrate/agent invokes agent with MCP tools", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "og-orchagent-"));
		const dataDir = await mkdtemp(join(tmpdir(), "og-oadata-"));

		// Mock provider that verifies mcpServers was passed
		let receivedMcpServers = false;
		const agentProvider: AgentProvider = {
			name: "mock",
			execute: async (req) => {
				if (req.mcpServers && "opengraft" in req.mcpServers) {
					receivedMcpServers = true;
				}
				return { success: true, output: "orchestrated" };
			},
			// biome-ignore lint/correctness/useYield: mock provider never streams
			stream: async function* () {
				return { success: true, output: "" };
			},
			startSession(req) {
				if (req.mcpServers && "opengraft" in req.mcpServers) {
					receivedMcpServers = true;
				}
				// biome-ignore lint/correctness/useYield: mock session never streams
				async function* events(): AsyncGenerator<AgentEvent, AgentResult> {
					return { success: true, output: "orchestrated" };
				}
				return {
					sessionId: "mock-session",
					events: events(),
					sendMessage: async () => {},
					stop: () => {},
				};
			},
		};

		const { app, pm } = createApp({ dataDir, agentProvider });
		await pm.load();

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
		expect(receivedMcpServers).toBe(true);

		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("POST /orchestrate/agent requires prompt", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "og-oa2-"));
		const dataDir = await mkdtemp(join(tmpdir(), "og-oa2d-"));

		const { app, pm } = createApp({ dataDir, agentProvider: mockProvider });
		await pm.load();

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
		const { app, pm } = createApp({ dataDir, agentProvider: mockProvider });
		await pm.load();

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

	test("agent can create top-level task (no parentId)", async () => {
		const agent = tracker.addTask("agent", "");
		const result = await invokeCreateTask(agent.id, {
			title: "toplevel",
			description: "desc",
		});
		expect(result.isError).toBeUndefined();
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.parentId).toBeNull();
	});
});
