import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEventStore, getTracker } from "./runtime/helpers.ts";
import { createApp } from "./runtime.ts";
import { resetResourceRegistry } from "./resource-registry.ts";

// ── Helpers ──

type AppLike = {
	request: (url: string, init?: RequestInit) => Response | Promise<Response>;
};

/** Send a JSON-RPC request to the MCP endpoint. */
async function mcpRequest(
	app: AppLike,
	method: string,
	params?: Record<string, unknown>,
	id: number | string = 1,
): Promise<{
	jsonrpc: string;
	id: number | string;
	result?: unknown;
	error?: unknown;
}> {
	const body: Record<string, unknown> = {
		jsonrpc: "2.0",
		id,
		method,
	};
	if (params !== undefined) body.params = params;
	const res = await app.request("/mcp", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		},
		body: JSON.stringify(body),
	});
	const text = await res.text();
	return JSON.parse(text);
}

/** Initialize MCP session (required before any tool call). */
async function mcpInitialize(app: AppLike): Promise<void> {
	const res = await mcpRequest(app, "initialize", {
		protocolVersion: "2025-03-26",
		capabilities: {},
		clientInfo: { name: "test-client", version: "1.0.0" },
	});
	if (!res.result && res.error) {
		throw new Error(`MCP initialize error: ${JSON.stringify(res.error)}`);
	}
}

/** Call an MCP tool and return the result. */
async function mcpCallTool(
	app: AppLike,
	toolName: string,
	args: Record<string, unknown> = {},
): Promise<{
	content: Array<{ type: string; text?: string }>;
	isError?: boolean;
}> {
	// Stateless: each request needs its own initialize
	await mcpInitialize(app);
	const res = await mcpRequest(
		app,
		"tools/call",
		{
			name: toolName,
			arguments: args,
		},
		2,
	);
	if (res.error) {
		throw new Error(`MCP error: ${JSON.stringify(res.error)}`);
	}
	return res.result as {
		content: Array<{ type: string; text?: string }>;
		isError?: boolean;
	};
}

/** List available MCP tools. */
async function mcpListTools(
	app: AppLike,
): Promise<Array<{ name: string; description: string; inputSchema: unknown }>> {
	await mcpInitialize(app);
	const res = await mcpRequest(app, "tools/list", {}, 2);
	if (res.error) {
		throw new Error(`MCP error: ${JSON.stringify(res.error)}`);
	}
	return (
		res.result as {
			tools: Array<{ name: string; description: string; inputSchema: unknown }>;
		}
	).tools;
}

/** Extract text from MCP tool result. */
function getText(result: {
	content: Array<{ type: string; text?: string }>;
}): string {
	const block = result.content[0];
	if (!block || block.type !== "text" || !block.text)
		throw new Error("No text in result");
	return block.text;
}

/** Extract and parse JSON from MCP tool result. */
function getJson(result: {
	content: Array<{ type: string; text?: string }>;
	// biome-ignore lint/suspicious/noExplicitAny: test helper — callers access arbitrary JSON fields
}): Record<string, any> {
	return JSON.parse(getText(result));
}

/** Create a project via REST and ensure tracker + event store are loaded. */
async function createProject(name: string): Promise<string> {
	const projDir = await mkdtemp(join(tmpdir(), "mxd-proj-"));
	const res = await hono.request("/projects", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name, path: projDir }),
	});
	const { id } = (await res.json()) as { id: string };
	// Load tracker + event store into ctx so R.getTracker/R.getEventStore work
	await getTracker(server.ctx, id);
	getEventStore(server.ctx, id);
	return id;
}

// ── Test setup ──

let dataDir: string;
let server: ReturnType<typeof createApp>;
let hono: AppLike;

beforeEach(async () => {
	resetResourceRegistry();
	dataDir = await mkdtemp(join(tmpdir(), "mxd-mcp-test-"));
	server = createApp({ dataDir });
	hono = server.app;

	server.markReady();
});

afterEach(async () => {
	await server.shutdown();
	resetResourceRegistry();
	await rm(dataDir, { recursive: true, force: true });
});

// ── Tests ──

describe("MCP endpoint", () => {
	describe("tools/list", () => {
		test("returns expected tool names", async () => {
			const tools = await mcpListTools(hono);
			const names = tools.map((t) => t.name);

			// "both" tools from orchestrator-tools
			expect(names).toContain("list_projects");
			expect(names).toContain("get_tree");
			expect(names).toContain("get_task");
			expect(names).toContain("get_logs");

			// external-only tools
			expect(names).toContain("send_user_message");
			expect(names).toContain("yield_external");

			// internal-only tools must NOT appear
			expect(names).not.toContain("create_task");
			expect(names).not.toContain("update_task");
			expect(names).not.toContain("delete_task");
			expect(names).not.toContain("yield");
			expect(names).not.toContain("done");
			expect(names).not.toContain("bash");
			expect(names).not.toContain("send_message");
		});

		test("get_tree has projectId as required param, no taskId", async () => {
			const tools = await mcpListTools(hono);
			const getTree = tools.find((t) => t.name === "get_tree");
			expect(getTree).toBeDefined();
			const schema = getTree?.inputSchema as {
				properties: Record<string, unknown>;
				required?: string[];
			};
			expect(schema.properties).toHaveProperty("projectId");
			expect(schema.required).toContain("projectId");
			// taskId should NOT be in the schema — it's read from auth, not a param
			expect(schema.properties).not.toHaveProperty("taskId");
		});

		test("get_task has projectId and taskId as required params", async () => {
			const tools = await mcpListTools(hono);
			const getTool = tools.find((t) => t.name === "get_task");
			expect(getTool).toBeDefined();
			const schema = getTool?.inputSchema as {
				properties: Record<string, unknown>;
				required?: string[];
			};
			expect(schema.properties).toHaveProperty("projectId");
			expect(schema.properties).toHaveProperty("taskId");
			expect(schema.required).toContain("projectId");
			expect(schema.required).toContain("taskId");
		});
	});

	describe("list_projects", () => {
		test("returns empty list when no projects exist", async () => {
			const result = await mcpCallTool(hono, "list_projects");
			expect(result.isError).toBeFalsy();
			const projects = getJson(result);
			expect(projects).toEqual([]);
		});

		test("returns registered projects", async () => {
			const projectId = await createProject("test-project");
			const result = await mcpCallTool(hono, "list_projects");
			const projects = getJson(result);
			expect(projects.length).toBe(1);
			expect(projects[0].id).toBe(projectId);
			expect(typeof projects[0].name).toBe("string");
		});
	});

	describe("get_tree", () => {
		test("returns task tree for a project", async () => {
			const projectId = await createProject("test-project");
			const result = await mcpCallTool(hono, "get_tree", { projectId });
			expect(result.isError).toBeFalsy();
			const tree = getJson(result);
			expect(tree.nodes).toBeDefined();
			expect(tree.nodes.length).toBeGreaterThan(0);
		});

		test("does not include (you) marker for external callers", async () => {
			const projectId = await createProject("test-project");
			const result = await mcpCallTool(hono, "get_tree", { projectId });
			const tree = getJson(result);
			for (const node of tree.nodes) {
				expect(node.title).not.toContain("(you)");
			}
		});
	});

	describe("get_task", () => {
		test("returns task details", async () => {
			const projectId = await createProject("test-project");
			const treeResult = await mcpCallTool(hono, "get_tree", { projectId });
			const tree = getJson(treeResult);
			const rootTaskId = tree.nodes[0].id;

			const result = await mcpCallTool(hono, "get_task", {
				projectId,
				taskId: rootTaskId,
			});
			expect(result.isError).toBeFalsy();
			const task = getJson(result);
			expect(task.id).toBe(rootTaskId);
		});

		test("returns error for non-existent task", async () => {
			const projectId = await createProject("test-project");
			const result = await mcpCallTool(hono, "get_task", {
				projectId,
				taskId: "nonexistent",
			});
			expect(result.isError).toBe(true);
		});
	});

	describe("get_logs", () => {
		test("returns empty events for task with no session", async () => {
			const projectId = await createProject("test-project");
			const treeResult = await mcpCallTool(hono, "get_tree", { projectId });
			const rootTaskId = getJson(treeResult).nodes[0].id;

			const result = await mcpCallTool(hono, "get_logs", {
				projectId,
				taskId: rootTaskId,
			});
			expect(result.isError).toBeFalsy();
			const logs = getJson(result);
			expect(logs.events).toEqual([]);
			expect(logs.cursor).toBe(0);
		});

		test("returns events with cursor", async () => {
			const projectId = await createProject("test-project");
			const treeResult = await mcpCallTool(hono, "get_tree", { projectId });
			const rootTaskId = getJson(treeResult).nodes[0].id;

			const eventStore = getEventStore(server.ctx, projectId);
			await eventStore.append(rootTaskId, {
				type: "assistant_text",
				taskId: rootTaskId,
				content: "Hello",
				ts: Date.now(),
			});
			await eventStore.append(rootTaskId, {
				type: "assistant_text",
				taskId: rootTaskId,
				content: "World",
				ts: Date.now() + 1,
			});
			await eventStore.flushSession(rootTaskId);

			const result = await mcpCallTool(hono, "get_logs", {
				projectId,
				taskId: rootTaskId,
			});
			const logs = getJson(result);
			expect(logs.events.length).toBe(2);
			expect(logs.cursor).toBe(2);
		});

		test("begin/end cursor range", async () => {
			const projectId = await createProject("test-project");
			const treeResult = await mcpCallTool(hono, "get_tree", { projectId });
			const rootTaskId = getJson(treeResult).nodes[0].id;

			const eventStore = getEventStore(server.ctx, projectId);
			for (let i = 0; i < 5; i++) {
				await eventStore.append(rootTaskId, {
					type: "assistant_text",
					taskId: rootTaskId,
					content: `Msg ${i}`,
					ts: Date.now() + i,
				});
			}
			await eventStore.flushSession(rootTaskId);

			// Read range [2, 4) — should get events at index 2 and 3
			const result = await mcpCallTool(hono, "get_logs", {
				projectId,
				taskId: rootTaskId,
				begin: 2,
				end: 4,
			});
			const logs = getJson(result);
			expect(logs.events.length).toBe(2);
			expect(logs.cursor).toBe(5); // total events
		});

		test("strips thinking signature by default", async () => {
			const projectId = await createProject("test-project");
			const treeResult = await mcpCallTool(hono, "get_tree", { projectId });
			const rootTaskId = getJson(treeResult).nodes[0].id;

			const eventStore = getEventStore(server.ctx, projectId);
			await eventStore.append(rootTaskId, {
				type: "thinking",
				thinking: "Let me reason about this...",
				signature: "base64-signature-blob-very-long",
				provider: "anthropic",
				taskId: rootTaskId,
				ts: Date.now(),
			});
			await eventStore.flushSession(rootTaskId);

			const result = await mcpCallTool(hono, "get_logs", {
				projectId,
				taskId: rootTaskId,
			});
			const logs = getJson(result);
			expect(logs.events.length).toBe(1);
			const ev = logs.events[0];
			expect(ev.type).toBe("thinking");
			expect(ev.thinking).toBe("Let me reason about this...");
			expect(ev.signature).toBeUndefined();
			expect(ev.provider).toBe("anthropic");
		});

		test("filters out usage events", async () => {
			const projectId = await createProject("test-project");
			const treeResult = await mcpCallTool(hono, "get_tree", { projectId });
			const rootTaskId = getJson(treeResult).nodes[0].id;

			const eventStore = getEventStore(server.ctx, projectId);
			await eventStore.append(rootTaskId, {
				type: "assistant_text",
				taskId: rootTaskId,
				content: "Hello",
				ts: Date.now(),
			});
			await eventStore.append(rootTaskId, {
				type: "usage",
				taskId: rootTaskId,
				inputTokens: 1000,
				outputTokens: 200,
				contextWindow: 200000,
				cacheCreationTokens: 500,
				cacheReadTokens: 300,
				ts: Date.now() + 1,
			});
			await eventStore.append(rootTaskId, {
				type: "assistant_text",
				taskId: rootTaskId,
				content: "World",
				ts: Date.now() + 2,
			});
			await eventStore.flushSession(rootTaskId);

			const result = await mcpCallTool(hono, "get_logs", {
				projectId,
				taskId: rootTaskId,
			});
			const logs = getJson(result);
			// usage event should be filtered out, only 2 assistant_text remain
			expect(logs.events.length).toBe(2);
			expect(
				logs.events.every((e: { type: string }) => e.type === "assistant_text"),
			).toBe(true);
		});

		test("hides tool_result content by default", async () => {
			const projectId = await createProject("test-project");
			const treeResult = await mcpCallTool(hono, "get_tree", { projectId });
			const rootTaskId = getJson(treeResult).nodes[0].id;

			const eventStore = getEventStore(server.ctx, projectId);
			await eventStore.append(rootTaskId, {
				type: "tool_result",
				tool: "read_file",
				toolCallId: "tc_1",
				content: "A".repeat(5000),
				isError: false,
				taskId: rootTaskId,
				ts: Date.now(),
			});
			await eventStore.flushSession(rootTaskId);

			const result = await mcpCallTool(hono, "get_logs", {
				projectId,
				taskId: rootTaskId,
			});
			const logs = getJson(result);
			expect(logs.events.length).toBe(1);
			const ev = logs.events[0];
			expect(ev.type).toBe("tool_result");
			expect(ev.tool).toBe("read_file");
			expect(ev.content).toBe("(content hidden, 5000 chars)");
		});

		test("shows tool_result content when hideToolResults=false", async () => {
			const projectId = await createProject("test-project");
			const treeResult = await mcpCallTool(hono, "get_tree", { projectId });
			const rootTaskId = getJson(treeResult).nodes[0].id;

			const originalContent = "file content here";
			const eventStore = getEventStore(server.ctx, projectId);
			await eventStore.append(rootTaskId, {
				type: "tool_result",
				tool: "read_file",
				toolCallId: "tc_1",
				content: originalContent,
				isError: false,
				taskId: rootTaskId,
				ts: Date.now(),
			});
			await eventStore.flushSession(rootTaskId);

			const result = await mcpCallTool(hono, "get_logs", {
				projectId,
				taskId: rootTaskId,
				hideToolResults: false,
			});
			const logs = getJson(result);
			expect(logs.events.length).toBe(1);
			expect(logs.events[0].content).toBe(originalContent);
		});

		test("cursor counts include filtered events", async () => {
			const projectId = await createProject("test-project");
			const treeResult = await mcpCallTool(hono, "get_tree", { projectId });
			const rootTaskId = getJson(treeResult).nodes[0].id;

			const eventStore = getEventStore(server.ctx, projectId);
			await eventStore.append(rootTaskId, {
				type: "assistant_text",
				taskId: rootTaskId,
				content: "Hello",
				ts: Date.now(),
			});
			await eventStore.append(rootTaskId, {
				type: "usage",
				taskId: rootTaskId,
				inputTokens: 1000,
				outputTokens: 200,
				contextWindow: 200000,
				ts: Date.now() + 1,
			});
			await eventStore.flushSession(rootTaskId);

			const result = await mcpCallTool(hono, "get_logs", {
				projectId,
				taskId: rootTaskId,
			});
			const logs = getJson(result);
			// 1 event returned (usage filtered), but cursor reflects raw total
			expect(logs.events.length).toBe(1);
			expect(logs.cursor).toBe(2);
		});
	});

	describe("availability filtering", () => {
		test("tools with availability=internal are not exposed", async () => {
			const tools = await mcpListTools(hono);
			const names = tools.map((t) => t.name);
			// Spot check internal tools
			const internalOnly = [
				"create_task",
				"update_task",
				"delete_task",
				"close_task",
				"reset_task",
				"yield",
				"done",
				"send_message",
				"clarify",
				"fork_task_context",
				"reorder_tasks",
				"create_folder",
				"delete_folder",
				"rename_folder",
				"send_message_to_project",
			];
			for (const name of internalOnly) {
				expect(names).not.toContain(name);
			}
		});
	});
});
