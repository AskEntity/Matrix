import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider } from "./agent-provider.ts";
import { createApp } from "./daemon.ts";
import type { HealthResponse, Project, TaskNode } from "./types.ts";

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

	test("POST /tasks/:nodeId/retry resets failed task to pending", async () => {
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

		// Retry
		const retryRes = await app.request(
			`/projects/${projectId}/tasks/${root.id}/retry`,
			{ method: "POST" },
		);
		expect(retryRes.status).toBe(200);
		const retried = (await retryRes.json()) as TaskNode;
		expect(retried.status).toBe("pending");
	});

	test("POST /tasks/:nodeId/retry rejects non-failed task", async () => {
		const rootRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "App2", description: "" }),
		});
		const root = (await rootRes.json()) as TaskNode;

		const retryRes = await app.request(
			`/projects/${projectId}/tasks/${root.id}/retry`,
			{ method: "POST" },
		);
		expect(retryRes.status).toBe(400);
	});
});

describe("daemon orchestrate API", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createApp>["app"];
	let projectId: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-orch-"));
		dataDir = await mkdtemp(join(tmpdir(), "og-odata-"));
		const result = createApp({ dataDir, agentProvider: mockProvider });
		app = result.app;
		await result.pm.load();

		const res = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: join(tempDir, "orch-app") }),
		});
		const project = (await res.json()) as Project;
		projectId = project.id;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("POST /orchestrate runs pending tasks", async () => {
		// Create task tree
		const rootRes = await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "App", description: "Build it" }),
		});
		const root = (await rootRes.json()) as TaskNode;

		await app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Feature A",
				description: "First feature",
				parentId: root.id,
			}),
		});

		const orchRes = await app.request(`/projects/${projectId}/orchestrate`, {
			method: "POST",
		});
		expect(orchRes.status).toBe(200);
		const body = (await orchRes.json()) as {
			completed: number;
			results: { title: string; status: string; success: boolean }[];
		};
		expect(body.completed).toBeGreaterThan(0);
		expect(body.results[0]?.success).toBe(true);
	});

	test("POST /orchestrate returns empty when no tasks", async () => {
		const orchRes = await app.request(`/projects/${projectId}/orchestrate`, {
			method: "POST",
		});
		expect(orchRes.status).toBe(200);
		const body = (await orchRes.json()) as { completed: number };
		expect(body.completed).toBe(0);
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
			startSession() {
				throw new Error("Not implemented in mock");
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

		const body = (await res.json()) as {
			success: boolean;
			output: string;
			tree: { root: null; nodes: unknown[] };
		};
		expect(body.success).toBe(true);
		expect(body.output).toBe("orchestrated");
		expect(body.tree).toBeDefined();
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

/** Clean git env for test isolation. */
const cleanGitEnv: Record<string, string | undefined> = {
	...process.env,
	GIT_DIR: undefined,
	GIT_WORK_TREE: undefined,
	GIT_INDEX_FILE: undefined,
	GIT_OBJECT_DIRECTORY: undefined,
	GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
};

async function gitExec(cmd: string[], cwd: string): Promise<void> {
	const proc = Bun.spawn(cmd, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: cleanGitEnv,
	});
	await proc.exited;
}

describe("daemon execute API", () => {
	test("POST /execute runs tasks with worktree isolation", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "og-exec-"));
		const dataDir = await mkdtemp(join(tmpdir(), "og-edata-"));
		const projectPath = join(tempDir, "exec-app");

		// Init a real git repo for worktree support
		await Bun.spawn(["mkdir", "-p", projectPath]).exited;
		await gitExec(["git", "init"], projectPath);
		await gitExec(
			["git", "config", "user.email", "test@test.com"],
			projectPath,
		);
		await gitExec(["git", "config", "user.name", "Test"], projectPath);
		await writeFile(join(projectPath, "README.md"), "# Test\n");
		await gitExec(["git", "add", "-A"], projectPath);
		await gitExec(["git", "commit", "-m", "init"], projectPath);

		const execProvider = createMockProvider(async () => ({
			success: true,
			output: "task done",
			sessionId: "sess-1",
		}));

		const { app, pm } = createApp({
			dataDir,
			agentProvider: execProvider,
		});
		await pm.load();

		// Register the project (it already exists, so it's a "convert")
		const projectRes = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: projectPath }),
		});
		const project = (await projectRes.json()) as Project;

		// Create task tree
		const rootRes = await app.request(`/projects/${project.id}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "App", description: "Build it" }),
		});
		const root = (await rootRes.json()) as TaskNode;

		await app.request(`/projects/${project.id}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Feature A",
				description: "First feature",
				parentId: root.id,
			}),
		});

		// Execute
		const execRes = await app.request(`/projects/${project.id}/execute`, {
			method: "POST",
		});
		expect(execRes.status).toBe(200);

		const result = (await execRes.json()) as {
			completed: number;
			failed: number;
			events: { type: string }[];
		};
		expect(result.completed).toBeGreaterThan(0);
		expect(result.events.length).toBeGreaterThan(0);

		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("POST /execute returns empty when no tasks", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "og-exec2-"));
		const dataDir = await mkdtemp(join(tmpdir(), "og-edata2-"));
		const projectPath = join(tempDir, "empty-app");

		await Bun.spawn(["mkdir", "-p", projectPath]).exited;
		await gitExec(["git", "init"], projectPath);
		await gitExec(
			["git", "config", "user.email", "test@test.com"],
			projectPath,
		);
		await gitExec(["git", "config", "user.name", "Test"], projectPath);
		await writeFile(join(projectPath, "README.md"), "# Test\n");
		await gitExec(["git", "add", "-A"], projectPath);
		await gitExec(["git", "commit", "-m", "init"], projectPath);

		const { app, pm } = createApp({ dataDir, agentProvider: mockProvider });
		await pm.load();

		const projectRes = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: projectPath }),
		});
		const project = (await projectRes.json()) as Project;

		const execRes = await app.request(`/projects/${project.id}/execute`, {
			method: "POST",
		});
		expect(execRes.status).toBe(200);
		const result = (await execRes.json()) as { completed: number };
		expect(result.completed).toBe(0);

		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	test("POST /execute/stream returns SSE events", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "og-sse-"));
		const dataDir = await mkdtemp(join(tmpdir(), "og-sdata-"));
		const projectPath = join(tempDir, "sse-app");

		await Bun.spawn(["mkdir", "-p", projectPath]).exited;
		await gitExec(["git", "init"], projectPath);
		await gitExec(
			["git", "config", "user.email", "test@test.com"],
			projectPath,
		);
		await gitExec(["git", "config", "user.name", "Test"], projectPath);
		await writeFile(join(projectPath, "README.md"), "# Test\n");
		await gitExec(["git", "add", "-A"], projectPath);
		await gitExec(["git", "commit", "-m", "init"], projectPath);

		const sseProvider = createMockProvider(async () => ({
			success: true,
			output: "done",
		}));

		const { app, pm } = createApp({
			dataDir,
			agentProvider: sseProvider,
		});
		await pm.load();

		const projectRes = await app.request("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: projectPath }),
		});
		const project = (await projectRes.json()) as Project;

		await app.request(`/projects/${project.id}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Task", description: "Do it" }),
		});

		const sseRes = await app.request(`/projects/${project.id}/execute/stream`, {
			method: "POST",
		});
		expect(sseRes.status).toBe(200);
		expect(sseRes.headers.get("Content-Type")).toBe("text/event-stream");

		const body = await sseRes.text();
		expect(body).toContain("event: event");
		expect(body).toContain("event: result");
		expect(body).toContain("task_started");

		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});
});
