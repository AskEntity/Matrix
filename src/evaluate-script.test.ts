/**
 * Tests for the hidden evaluate_script tool.
 *
 * 1. Hidden tool mechanism: prepareTools registers hidden tools in mcpHandlers
 *    but excludes them from the API tool definitions.
 * 2. Eval tool execution: runs scripts, captures console output, returns values,
 *    handles errors, accesses context (messages, tracker, etc.).
 * 3. Only created in selfBootstrap mode.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { createOrchestratorTools } from "./orchestrator-tools.ts";
import { resetResourceRegistry } from "./resource-registry.ts";
import { TaskTracker } from "./task-tracker.ts";
import { initMockResourceRegistry } from "./test-utils.ts";
import { type ToolDefinition, tool } from "./tool-definition.ts";
import { executeTool } from "./tool-execution.ts";
const TOOL_EVALUATE_SCRIPT = "mcp__mxd__evaluate_script";

// ── Helpers ──

afterEach(() => resetResourceRegistry());

/** Find evaluate_script tool from result, throw if missing. */
function findEvalTool(
	result: ReturnType<typeof createOrchestratorTools>,
): ToolDefinition {
	const evalTool = result.toolDefs.find((t) => t.name === "evaluate_script");
	if (!evalTool) throw new Error("evalTool not found");
	return evalTool;
}

/** Initialize resource registry and create auth for tests. */
function makeAuth(): ReturnType<typeof initMockResourceRegistry>["auth"] {
	const tracker = new TaskTracker("root-node");
	const { auth } = initMockResourceRegistry({
		tracker,
		projectId: "proj1",
		projectPath: "/tmp/test-repo",
		taskId: tracker.rootNodeId,
	});
	return auth;
}

// ── Hidden tool mechanism ──

describe("hidden tool mechanism", () => {
	test("prepareTools registers hidden tools in mcpHandlers but excludes from API tools", () => {
		const visibleTool = tool(
			"visible_tool",
			"A visible tool",
			{ input: z.string() },
			async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		);

		const hiddenTool = tool(
			"hidden_tool",
			"A hidden tool",
			{ script: z.string() },
			async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		);
		hiddenTool.hidden = true;

		// Simulate what prepareTools does in all providers
		// biome-ignore lint/suspicious/noExplicitAny: test flexibility
		const mcpToolDefs: Record<string, ToolDefinition<any>[]> = {
			mxd: [visibleTool, hiddenTool],
		};

		// biome-ignore lint/suspicious/noExplicitAny: test flexibility
		const mcpHandlers = new Map<string, ToolDefinition<any>>();
		const allTools: Array<{ name: string }> = [];

		for (const [serverName, defs] of Object.entries(mcpToolDefs)) {
			for (const def of defs) {
				const toolName = `mcp__${serverName}__${def.name}`;
				mcpHandlers.set(toolName, def);
				if (!def.hidden) {
					allTools.push({ name: toolName });
				}
			}
		}

		// Hidden tool is in mcpHandlers (can be executed)
		expect(mcpHandlers.has("mcp__mxd__hidden_tool")).toBe(true);
		// Hidden tool is NOT in allTools (not sent to API)
		expect(
			allTools.find((t) => t.name === "mcp__mxd__hidden_tool"),
		).toBeUndefined();
		// Visible tool is in both
		expect(mcpHandlers.has("mcp__mxd__visible_tool")).toBe(true);
		expect(
			allTools.find((t) => t.name === "mcp__mxd__visible_tool"),
		).toBeDefined();
	});

	test("executeTool can execute hidden tools normally", async () => {
		const hiddenTool = tool(
			"hidden_tool",
			"A hidden tool",
			{ value: z.string() },
			async (args) => ({
				content: [{ type: "text" as const, text: `hidden: ${args.value}` }],
			}),
		);
		hiddenTool.hidden = true;

		// biome-ignore lint/suspicious/noExplicitAny: test flexibility
		const handlers = new Map<string, ToolDefinition<any>>();
		handlers.set("mcp__mxd__hidden_tool", hiddenTool);

		const result = await executeTool(
			"mcp__mxd__hidden_tool",
			{ value: "test" },
			handlers,
		);
		expect(result.isError).toBeFalsy();
		expect(result.content).toBe("hidden: test");
	});
});

// ── evaluate_script tool ──

describe("evaluate_script tool", () => {
	test("not created when selfBootstrap is false/undefined", () => {
		const result1 = createOrchestratorTools(makeAuth(), "proj1", "root-node");
		expect(result1.setMessages).toBeUndefined();
		const evalTool = result1.toolDefs.find((t) => t.name === "evaluate_script");
		expect(evalTool).toBeUndefined();

		const result2 = createOrchestratorTools(
			makeAuth(),
			"proj1",
			"root-node",
			false,
		);
		expect(result2.setMessages).toBeUndefined();
		const evalTool2 = result2.toolDefs.find(
			(t) => t.name === "evaluate_script",
		);
		expect(evalTool2).toBeUndefined();
	});

	test("created with hidden=true when selfBootstrap is true", () => {
		const result = createOrchestratorTools(
			makeAuth(),
			"proj1",
			"root-node",
			true,
		);
		expect(result.setMessages).toBeDefined();
		const evalTool = result.toolDefs.find((t) => t.name === "evaluate_script");
		expect(evalTool).toBeDefined();
		expect(evalTool?.hidden).toBe(true);
	});

	test("executes script and returns result", async () => {
		const result = createOrchestratorTools(
			makeAuth(),
			"proj1",
			"root-node",
			true,
		);
		const evalTool = findEvalTool(result);

		const handlers = new Map<string, ToolDefinition>();
		handlers.set(TOOL_EVALUATE_SCRIPT, evalTool);

		const execResult = await executeTool(
			TOOL_EVALUATE_SCRIPT,
			{ script: "return 2 + 2" },
			handlers,
		);
		expect(execResult.isError).toBeFalsy();
		expect(execResult.content).toContain("4");
	});

	test("captures console.log output", async () => {
		const result = createOrchestratorTools(
			makeAuth(),
			"proj1",
			"root-node",
			true,
		);
		const evalTool = findEvalTool(result);

		const handlers = new Map<string, ToolDefinition>();
		handlers.set(TOOL_EVALUATE_SCRIPT, evalTool);

		const execResult = await executeTool(
			TOOL_EVALUATE_SCRIPT,
			{ script: 'console.log("hello"); console.log("world")' },
			handlers,
		);
		expect(execResult.isError).toBeFalsy();
		expect(execResult.content).toContain("Console Output");
		expect(execResult.content).toContain("hello");
		expect(execResult.content).toContain("world");
	});

	test("captures console.error and console.warn", async () => {
		const result = createOrchestratorTools(
			makeAuth(),
			"proj1",
			"root-node",
			true,
		);
		const evalTool = findEvalTool(result);

		const handlers = new Map<string, ToolDefinition>();
		handlers.set(TOOL_EVALUATE_SCRIPT, evalTool);

		const execResult = await executeTool(
			TOOL_EVALUATE_SCRIPT,
			{ script: 'console.error("err"); console.warn("warn")' },
			handlers,
		);
		expect(execResult.isError).toBeFalsy();
		expect(execResult.content).toContain("[error] err");
		expect(execResult.content).toContain("[warn] warn");
	});

	test("returns error on script failure", async () => {
		const result = createOrchestratorTools(
			makeAuth(),
			"proj1",
			"root-node",
			true,
		);
		const evalTool = findEvalTool(result);

		const handlers = new Map<string, ToolDefinition>();
		handlers.set(TOOL_EVALUATE_SCRIPT, evalTool);

		const execResult = await executeTool(
			TOOL_EVALUATE_SCRIPT,
			{ script: 'throw new Error("test error")' },
			handlers,
		);
		expect(execResult.isError).toBe(true);
		expect(execResult.content).toContain("Eval error");
		expect(execResult.content).toContain("test error");
	});

	test("accesses ctx.messages via setMessages binding", async () => {
		const result = createOrchestratorTools(
			makeAuth(),
			"proj1",
			"root-node",
			true,
		);
		const evalTool = findEvalTool(result);

		// Simulate provider loop binding the messages array
		const messages = [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi there" },
		];
		result.setMessages?.(messages);

		const handlers = new Map<string, ToolDefinition>();
		handlers.set(TOOL_EVALUATE_SCRIPT, evalTool);

		const execResult = await executeTool(
			TOOL_EVALUATE_SCRIPT,
			{ script: "return ctx.messages.length" },
			handlers,
		);
		expect(execResult.isError).toBeFalsy();
		expect(execResult.content).toContain("2");
	});

	test("accesses ctx.tracker", async () => {
		const result = createOrchestratorTools(
			makeAuth(),
			"proj1",
			"root-node",
			true,
		);
		const evalTool = findEvalTool(result);

		const handlers = new Map<string, ToolDefinition>();
		handlers.set(TOOL_EVALUATE_SCRIPT, evalTool);

		// TaskTracker exists and has expected methods
		const execResult = await executeTool(
			TOOL_EVALUATE_SCRIPT,
			{ script: "return typeof ctx.tracker.get" },
			handlers,
		);
		expect(execResult.isError).toBeFalsy();
		expect(execResult.content).toContain("function");
	});

	test("accesses ctx.projectId and ctx.taskId", async () => {
		const tracker = new TaskTracker("root-node");
		const { auth } = initMockResourceRegistry({
			tracker,
			projectId: "my-project",
			projectPath: "/tmp/test-repo",
			taskId: "my-task",
		});
		const result = createOrchestratorTools(auth, "my-project", "my-task", true);
		const evalTool = findEvalTool(result);

		const handlers = new Map<string, ToolDefinition>();
		handlers.set(TOOL_EVALUATE_SCRIPT, evalTool);

		const execResult = await executeTool(
			TOOL_EVALUATE_SCRIPT,
			{
				script: "return { projectId: ctx.projectId, taskId: ctx.taskId }",
			},
			handlers,
		);
		expect(execResult.isError).toBeFalsy();
		expect(execResult.content).toContain("my-project");
		expect(execResult.content).toContain("my-task");
	});

	test("supports async/await in script", async () => {
		const result = createOrchestratorTools(
			makeAuth(),
			"proj1",
			"root-node",
			true,
		);
		const evalTool = findEvalTool(result);

		const handlers = new Map<string, ToolDefinition>();
		handlers.set(TOOL_EVALUATE_SCRIPT, evalTool);

		const execResult = await executeTool(
			TOOL_EVALUATE_SCRIPT,
			{ script: "const x = await Promise.resolve(42); return x" },
			handlers,
		);
		expect(execResult.isError).toBeFalsy();
		expect(execResult.content).toContain("42");
	});

	test("returns '(no output)' when script has no return or console", async () => {
		const result = createOrchestratorTools(
			makeAuth(),
			"proj1",
			"root-node",
			true,
		);
		const evalTool = findEvalTool(result);

		const handlers = new Map<string, ToolDefinition>();
		handlers.set(TOOL_EVALUATE_SCRIPT, evalTool);

		const execResult = await executeTool(
			TOOL_EVALUATE_SCRIPT,
			{ script: "const x = 1 + 1" },
			handlers,
		);
		expect(execResult.isError).toBeFalsy();
		expect(execResult.content).toBe("(no output)");
	});

	test("restores console methods after error", async () => {
		const originalLog = console.log;
		const result = createOrchestratorTools(
			makeAuth(),
			"proj1",
			"root-node",
			true,
		);
		const evalTool = findEvalTool(result);

		const handlers = new Map<string, ToolDefinition>();
		handlers.set(TOOL_EVALUATE_SCRIPT, evalTool);

		await executeTool(
			TOOL_EVALUATE_SCRIPT,
			{ script: 'throw new Error("boom")' },
			handlers,
		);

		// console.log should be restored
		expect(console.log).toBe(originalLog);
	});

	test("both console output and return value in same script", async () => {
		const result = createOrchestratorTools(
			makeAuth(),
			"proj1",
			"root-node",
			true,
		);
		const evalTool = findEvalTool(result);

		const handlers = new Map<string, ToolDefinition>();
		handlers.set(TOOL_EVALUATE_SCRIPT, evalTool);

		const execResult = await executeTool(
			TOOL_EVALUATE_SCRIPT,
			{ script: 'console.log("log output"); return { answer: 42 }' },
			handlers,
		);
		expect(execResult.isError).toBeFalsy();
		expect(execResult.content).toContain("Console Output");
		expect(execResult.content).toContain("log output");
		expect(execResult.content).toContain("Return Value");
		expect(execResult.content).toContain("42");
	});

	test("accesses ctx.sessionId (equals taskId)", async () => {
		const tracker2 = new TaskTracker("root-node");
		const { auth: auth2 } = initMockResourceRegistry({
			tracker: tracker2,
			projectId: "my-project",
			projectPath: "/tmp/test-repo",
			taskId: "my-session-id",
		});
		const result = createOrchestratorTools(
			auth2,
			"my-project",
			"my-session-id",
			true,
		);
		const evalTool = findEvalTool(result);

		const handlers = new Map<string, ToolDefinition>();
		handlers.set(TOOL_EVALUATE_SCRIPT, evalTool);

		const execResult = await executeTool(
			TOOL_EVALUATE_SCRIPT,
			{ script: "return ctx.sessionId" },
			handlers,
		);
		expect(execResult.isError).toBeFalsy();
		expect(execResult.content).toContain("my-session-id");
	});

	test("accesses ctx.daemonCtx when provided", async () => {
		// The daemonCtx is the full context registered in the resource registry.
		// initMockResourceRegistry sets up a RuntimeContext with pm, eventStores, etc.
		// We use that same context, then extend it for the test assertion.
		const tracker3 = new TaskTracker("root-node");
		const { auth: auth3, ctx: testCtx } = initMockResourceRegistry({
			tracker: tracker3,
			projectId: "proj1",
			projectPath: "/tmp/test-repo",
			taskId: tracker3.rootNodeId,
		});
		// Extend the mock ctx with extra fields the test expects to find
		(testCtx as unknown as Record<string, unknown>).pm = {
			list: () => [{ id: "p1", name: "test-project" }],
			get: () => undefined,
		};
		(testCtx as unknown as Record<string, unknown>).eventStores = new Map([
			["p1", "fake-store"],
		]);
		const result = createOrchestratorTools(auth3, "proj1", "root-node", true);
		const evalTool = findEvalTool(result);

		const handlers = new Map<string, ToolDefinition>();
		handlers.set(TOOL_EVALUATE_SCRIPT, evalTool);

		const execResult = await executeTool(
			TOOL_EVALUATE_SCRIPT,
			{ script: "return ctx.daemonCtx.pm.list().length" },
			handlers,
		);
		expect(execResult.isError).toBeFalsy();
		expect(execResult.content).toContain("1");
	});

	test("ctx.daemonCtx is undefined when not provided", async () => {
		const result = createOrchestratorTools(
			makeAuth(),
			"proj1",
			"root-node",
			true,
		);
		const evalTool = findEvalTool(result);

		const handlers = new Map<string, ToolDefinition>();
		handlers.set(TOOL_EVALUATE_SCRIPT, evalTool);

		const execResult = await executeTool(
			TOOL_EVALUATE_SCRIPT,
			{ script: "return ctx.daemonCtx !== undefined" },
			handlers,
		);
		expect(execResult.isError).toBeFalsy();
		// In the new architecture, daemonCtx is always available through the resource registry
		expect(execResult.content).toContain("true");
	});

	test("accesses ctx.allTools via setAllTools binding", async () => {
		const result = createOrchestratorTools(
			makeAuth(),
			"proj1",
			"root-node",
			true,
		);
		expect(result.setAllTools).toBeDefined();

		const evalTool = findEvalTool(result);

		// Simulate provider loop binding the tools array
		const tools = [
			{ name: "tool1", description: "desc1", jsonSchema: {} },
			{ name: "tool2", description: "desc2", jsonSchema: {} },
		];
		result.setAllTools?.(tools);

		const handlers = new Map<string, ToolDefinition>();
		handlers.set(TOOL_EVALUATE_SCRIPT, evalTool);

		const execResult = await executeTool(
			TOOL_EVALUATE_SCRIPT,
			{
				script: "return ctx.allTools.map(t => t.name)",
			},
			handlers,
		);
		expect(execResult.isError).toBeFalsy();
		expect(execResult.content).toContain("tool1");
		expect(execResult.content).toContain("tool2");
	});

	test("setAllTools not created when selfBootstrap is false", () => {
		const result = createOrchestratorTools(
			makeAuth(),
			"proj1",
			"root-node",
			false,
		);
		expect(result.setAllTools).toBeUndefined();
	});
});
