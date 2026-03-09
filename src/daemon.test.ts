import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentProvider } from "./agent-provider.ts";
import { createApp } from "./daemon.ts";
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
	test("GET /stats returns uptime in seconds and requestCount", async () => {
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
			root: TaskNode;
			nodes: TaskNode[];
		};
		expect(body.root.title).toBe("App");
		expect(body.nodes).toHaveLength(1);
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
			root: null;
			nodes: TaskNode[];
		};
		expect(body.root).toBeNull();
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

describe("daemon decompose API", () => {
	test("POST /decompose creates task tree from agent output", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "og-decomp-"));
		const dataDir = await mkdtemp(join(tmpdir(), "og-ddata-"));

		const taskTree = JSON.stringify({
			title: "Chat App",
			description: "Build a real-time chat application",
			children: [
				{ title: "Setup project", description: "Init project with deps" },
				{
					title: "Implement backend",
					description: "WebSocket server",
					children: [
						{ title: "Auth module", description: "JWT auth" },
						{ title: "Message handling", description: "Send/receive messages" },
					],
				},
			],
		});

		const decompProvider = createMockProvider(async () => ({
			success: true,
			output: taskTree,
		}));

		const { app, pm } = createApp({ dataDir, agentProvider: decompProvider });
		await pm.load();

		const projectRes = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: join(tempDir, "chat") }),
		});
		const project = (await projectRes.json()) as Project;

		const decompRes = await app.request(`/projects/${project.id}/decompose`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ goal: "Build a chat app" }),
		});
		expect(decompRes.status).toBe(200);

		const result = (await decompRes.json()) as {
			root: TaskNode;
			nodes: TaskNode[];
		};
		expect(result.root.title).toBe("Chat App");
		expect(result.nodes).toHaveLength(5); // root + 2 top-level + 2 nested

		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("POST /decompose handles markdown-fenced JSON", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "og-decomp2-"));
		const dataDir = await mkdtemp(join(tmpdir(), "og-ddata2-"));

		const output = `Here's the task breakdown:\n\`\`\`json\n${JSON.stringify({
			title: "API Server",
			description: "REST API",
			children: [{ title: "Routes", description: "Define routes" }],
		})}\n\`\`\`\nThis should work well.`;

		const decompProvider = createMockProvider(async () => ({
			success: true,
			output,
		}));

		const { app, pm } = createApp({ dataDir, agentProvider: decompProvider });
		await pm.load();

		const projectRes = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: join(tempDir, "api") }),
		});
		const project = (await projectRes.json()) as Project;

		const decompRes = await app.request(`/projects/${project.id}/decompose`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ goal: "Build an API" }),
		});
		expect(decompRes.status).toBe(200);

		const result = (await decompRes.json()) as {
			root: TaskNode;
			nodes: TaskNode[];
		};
		expect(result.root.title).toBe("API Server");
		expect(result.nodes).toHaveLength(2);

		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("POST /decompose returns 500 on unparseable output", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "og-decomp3-"));
		const dataDir = await mkdtemp(join(tmpdir(), "og-ddata3-"));

		const decompProvider = createMockProvider(async () => ({
			success: true,
			output: "I cannot decompose this goal into tasks.",
		}));

		const { app, pm } = createApp({ dataDir, agentProvider: decompProvider });
		await pm.load();

		const projectRes = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: join(tempDir, "bad") }),
		});
		const project = (await projectRes.json()) as Project;

		const decompRes = await app.request(`/projects/${project.id}/decompose`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ goal: "Something vague" }),
		});
		expect(decompRes.status).toBe(500);

		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("POST /decompose requires goal", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "og-decomp4-"));
		const dataDir = await mkdtemp(join(tmpdir(), "og-ddata4-"));

		const { app, pm } = createApp({ dataDir, agentProvider: mockProvider });
		await pm.load();

		const projectRes = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: join(tempDir, "no-goal") }),
		});
		const project = (await projectRes.json()) as Project;

		const decompRes = await app.request(`/projects/${project.id}/decompose`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(decompRes.status).toBe(400);

		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("POST /decompose returns 500 on agent failure", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "og-decomp5-"));
		const dataDir = await mkdtemp(join(tmpdir(), "og-ddata5-"));

		const failProvider = createMockProvider(async () => ({
			success: false,
			output: "Agent crashed",
		}));

		const { app, pm } = createApp({ dataDir, agentProvider: failProvider });
		await pm.load();

		const projectRes = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: join(tempDir, "fail") }),
		});
		const project = (await projectRes.json()) as Project;

		const decompRes = await app.request(`/projects/${project.id}/decompose`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ goal: "Build something" }),
		});
		expect(decompRes.status).toBe(500);

		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
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
