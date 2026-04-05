/**
 * Integration tests for the HTTP MCP endpoint (/mcp).
 *
 * Verifies:
 * - MCP protocol handshake (initialize)
 * - Unscoped tools: list_projects, attach_to, get_attachment
 * - Scoped tools require attachment
 * - Scoped tools operate in attached context (get_tree, get_task, get_logs, read_file, list_files, search)
 * - Cross-project path isolation (can't escape attached worktree)
 * - Auth rejection when daemon has JWT secret but request has no token
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetAuthDataCache } from "../../auth.ts";
import { createApp } from "../../daemon.ts";

const ACCEPT = { Accept: "application/json, text/event-stream" };

interface McpInitResult {
	sessionId: string;
	body: {
		jsonrpc: "2.0";
		id: number;
		result: {
			protocolVersion: string;
			capabilities: Record<string, unknown>;
			serverInfo: { name: string; version: string };
		};
	};
}

type RequestFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Perform the MCP initialize handshake and return the session id. */
async function mcpInit(request: RequestFn): Promise<McpInitResult> {
	const res = await request("/mcp", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...ACCEPT },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "test-client", version: "1.0.0" },
			},
		}),
	});
	expect(res.status).toBe(200);
	const sessionId = res.headers.get("mcp-session-id");
	expect(sessionId).toBeTruthy();
	const body = (await res.json()) as McpInitResult["body"];
	return { sessionId: sessionId as string, body };
}

/** Send initialized notification (required by some MCP protocol versions). */
async function mcpInitialized(
	request: RequestFn,
	sessionId: string,
): Promise<void> {
	const res = await request("/mcp", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...ACCEPT,
			"mcp-session-id": sessionId,
			"mcp-protocol-version": "2025-06-18",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			method: "notifications/initialized",
		}),
	});
	// Notifications don't return a body — 202 Accepted
	expect([200, 202]).toContain(res.status);
}

/** Call a tool and parse the result. */
async function mcpCallTool(
	request: RequestFn,
	sessionId: string,
	id: number,
	toolName: string,
	args: Record<string, unknown> = {},
): Promise<{
	id: number;
	result?: {
		content: Array<{ type: string; text?: string; data?: string }>;
		isError?: boolean;
	};
	error?: { code: number; message: string };
}> {
	const res = await request("/mcp", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...ACCEPT,
			"mcp-session-id": sessionId,
			"mcp-protocol-version": "2025-06-18",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id,
			method: "tools/call",
			params: { name: toolName, arguments: args },
		}),
	});
	expect(res.status).toBe(200);
	return (await res.json()) as {
		id: number;
		result?: {
			content: Array<{ type: string; text?: string; data?: string }>;
			isError?: boolean;
		};
		error?: { code: number; message: string };
	};
}

/** List all tools exposed by the server. */
async function mcpListTools(
	request: RequestFn,
	sessionId: string,
): Promise<{
	id: number;
	result: {
		tools: Array<{ name: string; description?: string }>;
	};
}> {
	const res = await request("/mcp", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...ACCEPT,
			"mcp-session-id": sessionId,
			"mcp-protocol-version": "2025-06-18",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 99,
			method: "tools/list",
		}),
	});
	expect(res.status).toBe(200);
	return (await res.json()) as {
		id: number;
		result: { tools: Array<{ name: string; description?: string }> };
	};
}

describe("mcp-endpoint: protocol handshake", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "mxd-mcp-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	test("initialize returns session id and server info", async () => {
		const { app, pm } = createApp({ dataDir });
		await pm.load();
		const request: RequestFn = async (u, i) => app.request(u, i);

		const { sessionId, body } = await mcpInit(request);
		expect(sessionId).toMatch(/^[0-9a-f-]{36}$/i);
		expect(body.result.serverInfo.name).toBe("matrix");
		expect(body.result.serverInfo.version).toBeTruthy();
	});

	test("request without mcp-session-id header when not initializing returns 400", async () => {
		const { app, pm } = createApp({ dataDir });
		await pm.load();

		const res = await app.request("/mcp", {
			method: "POST",
			headers: { "Content-Type": "application/json", ...ACCEPT },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/list",
			}),
		});
		// Transport rejects non-initialize requests without session id
		expect(res.status).toBe(400);
	});

	test("request with invalid session id returns 404", async () => {
		const { app, pm } = createApp({ dataDir });
		await pm.load();

		const res = await app.request("/mcp", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...ACCEPT,
				"mcp-session-id": "nonexistent-session-id",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/list",
			}),
		});
		expect(res.status).toBe(404);
	});
});

describe("mcp-endpoint: auth", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "mxd-mcp-"));
		resetAuthDataCache();
	});

	afterEach(async () => {
		resetAuthDataCache();
		await rm(dataDir, { recursive: true, force: true });
	});

	test("unauthenticated request rejected with 401 when jwtSecret exists", async () => {
		// Write an auth.json with a jwtSecret to enable auth enforcement
		await mkdir(dataDir, { recursive: true });
		await writeFile(
			join(dataDir, "auth.json"),
			JSON.stringify({ jwtSecret: "dGVzdC1zZWNyZXQtMTIzNDU2Nzg5MA==" }),
			"utf-8",
		);

		const { app, pm } = createApp({ dataDir });
		await pm.load();

		const res = await app.request("/mcp", {
			method: "POST",
			headers: { "Content-Type": "application/json", ...ACCEPT },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "test-client", version: "1.0.0" },
				},
			}),
		});
		expect(res.status).toBe(401);
	});

	test("requests pass through when no jwtSecret configured (dev mode)", async () => {
		// No auth.json written — daemon passes through all requests
		const { app, pm } = createApp({ dataDir });
		await pm.load();

		const res = await app.request("/mcp", {
			method: "POST",
			headers: { "Content-Type": "application/json", ...ACCEPT },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "test-client", version: "1.0.0" },
				},
			}),
		});
		expect(res.status).toBe(200);
	});
});

describe("mcp-endpoint: unscoped tools", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "mxd-mcp-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	test("tools/list exposes all 9 tools", async () => {
		const { app, pm } = createApp({ dataDir });
		await pm.load();
		const request: RequestFn = async (u, i) => app.request(u, i);

		const { sessionId } = await mcpInit(request);
		await mcpInitialized(request, sessionId);
		const res = await mcpListTools(request, sessionId);
		const names = res.result.tools.map((t) => t.name).sort();
		expect(names).toEqual(
			[
				"attach_to",
				"get_attachment",
				"get_logs",
				"get_task",
				"get_tree",
				"list_files",
				"list_projects",
				"read_file",
				"search",
			].sort(),
		);
	});

	test("list_projects returns empty when no projects registered", async () => {
		const { app, pm } = createApp({ dataDir });
		await pm.load();
		const request: RequestFn = async (u, i) => app.request(u, i);

		const { sessionId } = await mcpInit(request);
		await mcpInitialized(request, sessionId);
		const res = await mcpCallTool(request, sessionId, 2, "list_projects");
		expect(res.result?.isError).toBeFalsy();
		const text = res.result?.content[0]?.text ?? "";
		const projects = JSON.parse(text);
		expect(projects).toEqual([]);
	});

	test("list_projects returns registered projects", async () => {
		const projectPath = await mkdtemp(join(tmpdir(), "mxd-mcp-proj-"));
		try {
			const { app, pm } = createApp({ dataDir });
			await pm.load();
			const project = await pm.init(projectPath);
			const request: RequestFn = async (u, i) => app.request(u, i);

			const { sessionId } = await mcpInit(request);
			await mcpInitialized(request, sessionId);
			const res = await mcpCallTool(request, sessionId, 2, "list_projects");
			const text = res.result?.content[0]?.text ?? "";
			const projects = JSON.parse(text) as Array<{
				id: string;
				name: string;
				path: string;
			}>;
			expect(projects.length).toBe(1);
			expect(projects[0]?.id).toBe(project.id);
			expect(projects[0]?.path).toBe(projectPath);
		} finally {
			await rm(projectPath, { recursive: true, force: true });
		}
	});

	test("get_attachment returns 'Not attached' initially", async () => {
		const { app, pm } = createApp({ dataDir });
		await pm.load();
		const request: RequestFn = async (u, i) => app.request(u, i);

		const { sessionId } = await mcpInit(request);
		await mcpInitialized(request, sessionId);
		const res = await mcpCallTool(request, sessionId, 2, "get_attachment");
		const text = res.result?.content[0]?.text ?? "";
		expect(text).toContain("Not attached");
	});

	test("attach_to with invalid project returns error", async () => {
		const { app, pm } = createApp({ dataDir });
		await pm.load();
		const request: RequestFn = async (u, i) => app.request(u, i);

		const { sessionId } = await mcpInit(request);
		await mcpInitialized(request, sessionId);
		const res = await mcpCallTool(request, sessionId, 2, "attach_to", {
			projectId: "nonexistent",
		});
		expect(res.result?.isError).toBe(true);
		const text = res.result?.content[0]?.text ?? "";
		expect(text).toContain("Project not found");
	});

	test("attach_to + get_attachment round trip", async () => {
		const projectPath = await mkdtemp(join(tmpdir(), "mxd-mcp-proj-"));
		try {
			const { app, pm } = createApp({ dataDir });
			await pm.load();
			const project = await pm.init(projectPath);
			const request: RequestFn = async (u, i) => app.request(u, i);

			const { sessionId } = await mcpInit(request);
			await mcpInitialized(request, sessionId);

			// Attach (no task)
			const attachRes = await mcpCallTool(request, sessionId, 2, "attach_to", {
				projectId: project.id,
			});
			expect(attachRes.result?.isError).toBeFalsy();
			expect(attachRes.result?.content[0]?.text ?? "").toContain("Attached");

			// Get attachment back
			const getRes = await mcpCallTool(request, sessionId, 3, "get_attachment");
			const info = JSON.parse(
				(getRes.result?.content[0]?.text ?? "{}").trim(),
			) as { projectId: string; taskId: string | null };
			expect(info.projectId).toBe(project.id);
			expect(info.taskId).toBeNull();
		} finally {
			await rm(projectPath, { recursive: true, force: true });
		}
	});

	test("attach_to with invalid taskId returns error", async () => {
		const projectPath = await mkdtemp(join(tmpdir(), "mxd-mcp-proj-"));
		try {
			const { app, pm } = createApp({ dataDir });
			await pm.load();
			const project = await pm.init(projectPath);
			const request: RequestFn = async (u, i) => app.request(u, i);

			const { sessionId } = await mcpInit(request);
			await mcpInitialized(request, sessionId);

			const res = await mcpCallTool(request, sessionId, 2, "attach_to", {
				projectId: project.id,
				taskId: "bogus-task-id",
			});
			expect(res.result?.isError).toBe(true);
			const text = res.result?.content[0]?.text ?? "";
			expect(text).toContain("Task not found");
		} finally {
			await rm(projectPath, { recursive: true, force: true });
		}
	});
});

describe("mcp-endpoint: scoped tools", () => {
	let dataDir: string;
	let projectPath: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "mxd-mcp-"));
		projectPath = await mkdtemp(join(tmpdir(), "mxd-mcp-proj-"));
		// Create a dummy file for read/list/search tests
		await writeFile(
			join(projectPath, "hello.txt"),
			"line1\nline2\nline3\n",
			"utf-8",
		);
		await writeFile(
			join(projectPath, "code.ts"),
			"function foo() { return 42; }\n",
			"utf-8",
		);
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
		await rm(projectPath, { recursive: true, force: true });
	});

	test("get_tree before attach returns error", async () => {
		const { app, pm } = createApp({ dataDir });
		await pm.load();
		const request: RequestFn = async (u, i) => app.request(u, i);

		const { sessionId } = await mcpInit(request);
		await mcpInitialized(request, sessionId);

		const res = await mcpCallTool(request, sessionId, 2, "get_tree");
		expect(res.result?.isError).toBe(true);
		expect(res.result?.content[0]?.text ?? "").toContain("Not attached");
	});

	test("read_file before attach returns error", async () => {
		const { app, pm } = createApp({ dataDir });
		await pm.load();
		const request: RequestFn = async (u, i) => app.request(u, i);

		const { sessionId } = await mcpInit(request);
		await mcpInitialized(request, sessionId);

		const res = await mcpCallTool(request, sessionId, 2, "read_file", {
			path: "hello.txt",
		});
		expect(res.result?.isError).toBe(true);
		expect(res.result?.content[0]?.text ?? "").toContain("Not attached");
	});

	test("get_tree after attach returns root node", async () => {
		const { app, pm } = createApp({ dataDir });
		await pm.load();
		const project = await pm.init(projectPath);
		const request: RequestFn = async (u, i) => app.request(u, i);

		const { sessionId } = await mcpInit(request);
		await mcpInitialized(request, sessionId);

		await mcpCallTool(request, sessionId, 2, "attach_to", {
			projectId: project.id,
		});
		const res = await mcpCallTool(request, sessionId, 3, "get_tree");
		expect(res.result?.isError).toBeFalsy();
		const data = JSON.parse(res.result?.content[0]?.text ?? "{}");
		expect(data.rootNodeId).toBeTruthy();
		expect(Array.isArray(data.nodes)).toBe(true);
		expect(data.nodes.length).toBeGreaterThan(0);
	});

	test("read_file requires task attachment, not just project", async () => {
		const { app, pm } = createApp({ dataDir });
		await pm.load();
		const project = await pm.init(projectPath);
		const request: RequestFn = async (u, i) => app.request(u, i);

		const { sessionId } = await mcpInit(request);
		await mcpInitialized(request, sessionId);

		// Attach project only
		await mcpCallTool(request, sessionId, 2, "attach_to", {
			projectId: project.id,
		});
		const res = await mcpCallTool(request, sessionId, 3, "read_file", {
			path: "hello.txt",
		});
		expect(res.result?.isError).toBe(true);
		expect(res.result?.content[0]?.text ?? "").toContain(
			"Not attached to a task",
		);
	});

	test("read_file works with root task attached", async () => {
		const { app, pm, getTracker } = createApp({ dataDir });
		await pm.load();
		const project = await pm.init(projectPath);
		const tracker = await getTracker(project.id);
		const rootId = tracker.rootNodeId;
		const request: RequestFn = async (u, i) => app.request(u, i);

		const { sessionId } = await mcpInit(request);
		await mcpInitialized(request, sessionId);

		await mcpCallTool(request, sessionId, 2, "attach_to", {
			projectId: project.id,
			taskId: rootId,
		});
		const res = await mcpCallTool(request, sessionId, 3, "read_file", {
			path: "hello.txt",
		});
		expect(res.result?.isError).toBeFalsy();
		const text = res.result?.content[0]?.text ?? "";
		expect(text).toContain("line1");
		expect(text).toContain("line3");
	});

	test("read_file rejects paths outside worktree", async () => {
		const { app, pm, getTracker } = createApp({ dataDir });
		await pm.load();
		const project = await pm.init(projectPath);
		const tracker = await getTracker(project.id);
		const rootId = tracker.rootNodeId;
		const request: RequestFn = async (u, i) => app.request(u, i);

		const { sessionId } = await mcpInit(request);
		await mcpInitialized(request, sessionId);

		await mcpCallTool(request, sessionId, 2, "attach_to", {
			projectId: project.id,
			taskId: rootId,
		});
		// Absolute path outside the project
		const res = await mcpCallTool(request, sessionId, 3, "read_file", {
			path: "/etc/passwd",
		});
		expect(res.result?.isError).toBe(true);
		expect(res.result?.content[0]?.text ?? "").toContain("escapes");
	});

	test("read_file rejects relative path escaping via ../", async () => {
		const { app, pm, getTracker } = createApp({ dataDir });
		await pm.load();
		const project = await pm.init(projectPath);
		const tracker = await getTracker(project.id);
		const rootId = tracker.rootNodeId;
		const request: RequestFn = async (u, i) => app.request(u, i);

		const { sessionId } = await mcpInit(request);
		await mcpInitialized(request, sessionId);

		await mcpCallTool(request, sessionId, 2, "attach_to", {
			projectId: project.id,
			taskId: rootId,
		});
		const res = await mcpCallTool(request, sessionId, 3, "read_file", {
			path: "../../../../etc/passwd",
		});
		expect(res.result?.isError).toBe(true);
		expect(res.result?.content[0]?.text ?? "").toContain("escapes");
	});

	test("list_files returns worktree files", async () => {
		const { app, pm, getTracker } = createApp({ dataDir });
		await pm.load();
		const project = await pm.init(projectPath);
		const tracker = await getTracker(project.id);
		const rootId = tracker.rootNodeId;
		const request: RequestFn = async (u, i) => app.request(u, i);

		const { sessionId } = await mcpInit(request);
		await mcpInitialized(request, sessionId);

		await mcpCallTool(request, sessionId, 2, "attach_to", {
			projectId: project.id,
			taskId: rootId,
		});
		const res = await mcpCallTool(request, sessionId, 3, "list_files", {
			pattern: "*.txt",
		});
		expect(res.result?.isError).toBeFalsy();
		expect(res.result?.content[0]?.text ?? "").toContain("hello.txt");
	});

	test("search finds patterns in worktree", async () => {
		const { app, pm, getTracker } = createApp({ dataDir });
		await pm.load();
		const project = await pm.init(projectPath);
		const tracker = await getTracker(project.id);
		const rootId = tracker.rootNodeId;
		const request: RequestFn = async (u, i) => app.request(u, i);

		const { sessionId } = await mcpInit(request);
		await mcpInitialized(request, sessionId);

		await mcpCallTool(request, sessionId, 2, "attach_to", {
			projectId: project.id,
			taskId: rootId,
		});
		const res = await mcpCallTool(request, sessionId, 3, "search", {
			pattern: "function foo",
			glob: "*.ts",
		});
		expect(res.result?.isError).toBeFalsy();
		expect(res.result?.content[0]?.text ?? "").toContain("foo");
	});

	test("get_task returns details for root task", async () => {
		const { app, pm, getTracker } = createApp({ dataDir });
		await pm.load();
		const project = await pm.init(projectPath);
		const tracker = await getTracker(project.id);
		const rootId = tracker.rootNodeId;
		const request: RequestFn = async (u, i) => app.request(u, i);

		const { sessionId } = await mcpInit(request);
		await mcpInitialized(request, sessionId);

		await mcpCallTool(request, sessionId, 2, "attach_to", {
			projectId: project.id,
			taskId: rootId,
		});
		const res = await mcpCallTool(request, sessionId, 3, "get_task", {
			taskId: rootId,
		});
		expect(res.result?.isError).toBeFalsy();
		const node = JSON.parse(res.result?.content[0]?.text ?? "{}");
		expect(node.id).toBe(rootId);
		expect(node).not.toHaveProperty("session"); // stripSession
	});

	test("get_task with unknown id returns error", async () => {
		const { app, pm, getTracker } = createApp({ dataDir });
		await pm.load();
		const project = await pm.init(projectPath);
		const tracker = await getTracker(project.id);
		const rootId = tracker.rootNodeId;
		const request: RequestFn = async (u, i) => app.request(u, i);

		const { sessionId } = await mcpInit(request);
		await mcpInitialized(request, sessionId);

		await mcpCallTool(request, sessionId, 2, "attach_to", {
			projectId: project.id,
			taskId: rootId,
		});
		const res = await mcpCallTool(request, sessionId, 3, "get_task", {
			taskId: "nope",
		});
		expect(res.result?.isError).toBe(true);
		expect(res.result?.content[0]?.text ?? "").toContain("not found");
	});

	test("get_logs returns empty events for fresh task", async () => {
		const { app, pm, getTracker } = createApp({ dataDir });
		await pm.load();
		const project = await pm.init(projectPath);
		const tracker = await getTracker(project.id);
		const rootId = tracker.rootNodeId;
		const request: RequestFn = async (u, i) => app.request(u, i);

		const { sessionId } = await mcpInit(request);
		await mcpInitialized(request, sessionId);

		await mcpCallTool(request, sessionId, 2, "attach_to", {
			projectId: project.id,
			taskId: rootId,
		});
		const res = await mcpCallTool(request, sessionId, 3, "get_logs", {
			taskId: rootId,
		});
		expect(res.result?.isError).toBeFalsy();
		const data = JSON.parse(res.result?.content[0]?.text ?? "{}");
		expect(data.taskId).toBe(rootId);
		expect(Array.isArray(data.events)).toBe(true);
	});

	test("cross-project: attaching to project A cannot read project B files", async () => {
		const projectPathB = await mkdtemp(join(tmpdir(), "mxd-mcp-projB-"));
		try {
			await writeFile(
				join(projectPathB, "secret.txt"),
				"super-secret",
				"utf-8",
			);

			const { app, pm, getTracker } = createApp({ dataDir });
			await pm.load();
			const projectA = await pm.init(projectPath);
			const projectB = await pm.init(projectPathB);
			const trackerA = await getTracker(projectA.id);
			const rootIdA = trackerA.rootNodeId;
			const request: RequestFn = async (u, i) => app.request(u, i);

			const { sessionId } = await mcpInit(request);
			await mcpInitialized(request, sessionId);

			// Attach to project A
			await mcpCallTool(request, sessionId, 2, "attach_to", {
				projectId: projectA.id,
				taskId: rootIdA,
			});
			// Try to read project B's file via absolute path
			const res = await mcpCallTool(request, sessionId, 3, "read_file", {
				path: join(projectPathB, "secret.txt"),
			});
			expect(res.result?.isError).toBe(true);
			expect(res.result?.content[0]?.text ?? "").toContain("escapes");
			// Verify projectB really exists (sanity check)
			expect(pm.get(projectB.id)).toBeTruthy();
		} finally {
			await rm(projectPathB, { recursive: true, force: true });
		}
	});

	test("session isolation: two MCP sessions have independent attachments", async () => {
		const projectPathB = await mkdtemp(join(tmpdir(), "mxd-mcp-projB-"));
		try {
			const { app, pm } = createApp({ dataDir });
			await pm.load();
			const projectA = await pm.init(projectPath);
			const projectB = await pm.init(projectPathB);
			const request: RequestFn = async (u, i) => app.request(u, i);

			// Session 1 attaches to project A
			const { sessionId: sid1 } = await mcpInit(request);
			await mcpInitialized(request, sid1);
			await mcpCallTool(request, sid1, 2, "attach_to", {
				projectId: projectA.id,
			});

			// Session 2 attaches to project B
			const { sessionId: sid2 } = await mcpInit(request);
			await mcpInitialized(request, sid2);
			await mcpCallTool(request, sid2, 2, "attach_to", {
				projectId: projectB.id,
			});

			// Both sessions report their own attachments
			const a1 = await mcpCallTool(request, sid1, 3, "get_attachment");
			const a2 = await mcpCallTool(request, sid2, 3, "get_attachment");
			const info1 = JSON.parse((a1.result?.content[0]?.text ?? "{}").trim());
			const info2 = JSON.parse((a2.result?.content[0]?.text ?? "{}").trim());
			expect(info1.projectId).toBe(projectA.id);
			expect(info2.projectId).toBe(projectB.id);
			expect(sid1).not.toBe(sid2);
		} finally {
			await rm(projectPathB, { recursive: true, force: true });
		}
	});

	test("re-attach replaces previous attachment", async () => {
		const projectPathB = await mkdtemp(join(tmpdir(), "mxd-mcp-projB-"));
		try {
			const { app, pm } = createApp({ dataDir });
			await pm.load();
			const projectA = await pm.init(projectPath);
			const projectB = await pm.init(projectPathB);
			const request: RequestFn = async (u, i) => app.request(u, i);

			const { sessionId } = await mcpInit(request);
			await mcpInitialized(request, sessionId);

			await mcpCallTool(request, sessionId, 2, "attach_to", {
				projectId: projectA.id,
			});
			await mcpCallTool(request, sessionId, 3, "attach_to", {
				projectId: projectB.id,
			});
			const res = await mcpCallTool(request, sessionId, 4, "get_attachment");
			const info = JSON.parse((res.result?.content[0]?.text ?? "{}").trim());
			expect(info.projectId).toBe(projectB.id);
		} finally {
			await rm(projectPathB, { recursive: true, force: true });
		}
	});
});
