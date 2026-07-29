import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageQueue } from "./message-queue.ts";
import { resetResourceRegistry } from "./resource-registry.ts";
import { broadcast } from "./runtime/event-system.ts";
import { getEventStore, getTracker } from "./runtime/helpers.ts";
import { createMatrixApp as createApp } from "./test-utils/create-matrix-app.ts";
import { TurnInterrupt } from "./turn-interrupt.ts";
import { ulid } from "./ulid.ts";

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

/** Register a project via pm.sync and ensure tracker + event store are loaded. */
async function createProject(name: string): Promise<string> {
	const projDir = await mkdtemp(join(tmpdir(), "mxd-proj-"));
	const id = ulid();
	const existing = server.pm.list();
	server.pm.sync([...existing, { id, name, path: projDir }]);
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

		// ── The projection is minimal, and there is no way to widen it ──
		//
		// `include_details` used to return stripSession(node) — the whole node.
		// Measured on the real 578-node tree it cost ~114K tokens alone and
		// ~631K together with include_closed, i.e. one call could exhaust a
		// context window. It is deleted; these tests pin the projection so a
		// "just add the fields back" change goes red.
		//
		// The fixture carries a description, a cost, a result round AND a
		// branch/worktree on purpose: every one of those is a field the old
		// detailed form returned. With an empty fixture the absence assertions
		// below would pass against the detailed form too, and prove nothing.
		test("the projection is exactly {id,title,status,children,parentId} — no node internals", async () => {
			const projectId = await createProject("test-project");
			const tracker = await getTracker(server.ctx, projectId);
			const child = tracker.addChild(
				tracker.rootNodeId,
				"Fixture task",
				"A description long enough to notice if it leaks",
			);
			tracker.updateCost(child.id, 12.34);
			tracker.appendResultRound(child.id, { result: "a reported round" });
			tracker.assignWorktree(child.id, "mxd/fixture/branch", "/tmp/fixture-wt");

			const result = await mcpCallTool(hono, "get_tree", { projectId });
			expect(result.isError).toBeFalsy();
			const node = getJson(result).nodes.find(
				(n: { id: string }) => n.id === child.id,
			);
			expect(node).toBeDefined();

			// Named absences: these are the fields the deleted parameter advertised.
			expect(node.description).toBeUndefined();
			expect(node.costUsd).toBeUndefined();
			expect(node.resultRounds).toBeUndefined();
			expect(node.branch).toBeUndefined();
			expect(node.worktreePath).toBeUndefined();

			// And the exhaustive form, which also catches a field nobody here
			// thought to name.
			expect(Object.keys(node).sort()).toEqual([
				"children",
				"id",
				"parentId",
				"status",
				"title",
			]);
		});

		test("a caller still passing include_details gets the minimal form, not an error", async () => {
			// get_tree is availability:"both", so external MCP clients may still
			// send the old parameter, and running agents hold a frozen tool
			// description until they compact. Zod has no .strict(), so an unknown
			// key is stripped rather than refused — silently narrowed, never broken.
			const projectId = await createProject("test-project");
			const tracker = await getTracker(server.ctx, projectId);
			const child = tracker.addChild(
				tracker.rootNodeId,
				"Fixture task",
				"A description long enough to notice if it leaks",
			);

			const result = await mcpCallTool(hono, "get_tree", {
				projectId,
				include_details: true,
			});
			expect(result.isError).toBeFalsy();
			const node = getJson(result).nodes.find(
				(n: { id: string }) => n.id === child.id,
			);
			expect(node.description).toBeUndefined();
			expect(Object.keys(node).sort()).toEqual([
				"children",
				"id",
				"parentId",
				"status",
				"title",
			]);
		});

		test("include_details is no longer advertised, include_closed still is", async () => {
			const tools = await mcpListTools(hono);
			const schema = tools.find((t) => t.name === "get_tree")?.inputSchema as {
				properties: Record<string, unknown>;
			};
			expect(schema.properties).not.toHaveProperty("include_details");
			expect(schema.properties).toHaveProperty("include_closed");
		});

		// ── include_closed survives, both directions ──
		//
		// Asserted with a closed task actually present: a fixture with no closed
		// task cannot tell "the filter works" from "the filter is gone".
		test("include_closed hides closed tasks by default and reveals them when set", async () => {
			const projectId = await createProject("test-project");
			const tracker = await getTracker(server.ctx, projectId);
			const open = tracker.addChild(tracker.rootNodeId, "Open task", "d");
			const shut = tracker.addChild(tracker.rootNodeId, "Closed task", "d");
			tracker.updateStatus(shut.id, "closed");

			const ids = (args: Record<string, unknown>) =>
				mcpCallTool(hono, "get_tree", { projectId, ...args }).then((r) =>
					getJson(r).nodes.map((n: { id: string }) => n.id),
				);

			const without = await ids({});
			expect(without).toContain(open.id);
			expect(without).not.toContain(shut.id);

			const with_ = await ids({ include_closed: true });
			expect(with_).toContain(open.id);
			expect(with_).toContain(shut.id);

			// A hidden node must also leave its parent's children list, or the
			// caller gets an id it cannot resolve in the same response.
			const rootWithout = getJson(
				await mcpCallTool(hono, "get_tree", { projectId }),
			).nodes.find((n: { id: string }) => n.id === tracker.rootNodeId);
			expect(rootWithout.children).toContain(open.id);
			expect(rootWithout.children).not.toContain(shut.id);
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

// ============================================================
// yield_external wake signals
// ============================================================
//
// yield_external subscribes to in-process events and finishes when one of
// WAKE_SIGNALS arrives. That set is matched against `event.type`, so it is
// coupled to the live event-type names — a rename anywhere in the runtime
// silently turns a wake into a timeout. These tests pin the coupling.

/** Attach a fake ACTIVE session (queue.idle = false) so yield_external takes
 *  the subscribe path instead of the already-idle fast path. */
function attachActiveSession(projectId: string, taskId: string): void {
	const tracker = server.ctx.trackers.get(projectId);
	if (!tracker) throw new Error("tracker not loaded");
	const node = tracker.getTask(taskId);
	if (!node) throw new Error("task not found");
	const queue = new MessageQueue();
	queue.idle = false;
	node.session = {
		queue,
		abortController: new AbortController(),
		interrupt: new TurnInterrupt(),
		loopTraceId: "test-trace",
		depth: 0,
		backgroundProcesses: new Map(),
		activity: "thinking",
		foregroundExecutions: new Map(),
	};
}

describe("yield_external wake signals", () => {
	test("wakes on agent_end when the agent stops", async () => {
		const projectId = await createProject("wake-end");
		const tracker = await getTracker(server.ctx, projectId);
		const rootId = tracker.rootNodeId;
		attachActiveSession(projectId, rootId);

		const started = Date.now();
		// 2000ms, NOT 5000: bun's own per-test timeout is 5s, so a 5s tool
		// timeout races it and the failure surfaces as an unhandled rejection
		// in the NEXT test instead of a clean red here.
		const resultP = mcpCallTool(hono, "yield_external", {
			projectId,
			taskId: rootId,
			timeoutMs: 2000,
		});
		// Let the handler register its subscription before the event fires.
		await new Promise((r) => setTimeout(r, 100));
		broadcast(server.ctx, projectId, {
			type: "agent_end",
			taskId: rootId,
			reason: "stopped",
			ts: Date.now(),
		});

		const json = getJson(await resultP);
		expect(json.reason).toBe("agent_end");
		// Must be the wake, not the timeout.
		expect(Date.now() - started).toBeLessThan(1500);
	});

	test("wakes on done_notified", async () => {
		const projectId = await createProject("wake-done");
		const tracker = await getTracker(server.ctx, projectId);
		const rootId = tracker.rootNodeId;
		attachActiveSession(projectId, rootId);

		const resultP = mcpCallTool(hono, "yield_external", {
			projectId,
			taskId: rootId,
			timeoutMs: 2000,
		});
		await new Promise((r) => setTimeout(r, 100));
		broadcast(server.ctx, projectId, {
			type: "done_notified",
			taskId: rootId,
			ts: Date.now(),
		});

		const json = getJson(await resultP);
		expect(json.reason).toBe("done_notified");
	});

	test("an event for a DIFFERENT task does not wake it", async () => {
		const projectId = await createProject("wake-other");
		const tracker = await getTracker(server.ctx, projectId);
		const rootId = tracker.rootNodeId;
		attachActiveSession(projectId, rootId);

		const resultP = mcpCallTool(hono, "yield_external", {
			projectId,
			taskId: rootId,
			timeoutMs: 1000,
		});
		await new Promise((r) => setTimeout(r, 100));
		broadcast(server.ctx, projectId, {
			type: "agent_end",
			taskId: "some-other-task",
			reason: "stopped",
			ts: Date.now(),
		});

		const json = getJson(await resultP);
		expect(json.reason).toBe("timeout");
	});
});
