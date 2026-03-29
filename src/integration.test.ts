/**
 * Integration tests: drive the full stack from HTTP API → provider loop → mock API → tool execution → JSONL.
 *
 * Each test creates a real app with a ValidatingMockAPI. The mock validates every API request
 * automatically (turn interleaving, tool_use/tool_result pairing, etc.). Tests also verify
 * JSONL persistence and request history for specific scenarios.
 *
 * Key insight: root orchestrator agents (depth 0) never close their queue via done() —
 * they enter an idle-yield waiting for new messages. We detect "done" by polling the root
 * node's status (changes from "in_progress" to "passed"/"failed"), then call shutdown().
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./daemon.ts";
import { EventStore } from "./event-store.ts";
import {
	createMockedProviderWithMock,
	ValidatingMockAPI,
} from "./test-utils/mock-anthropic-api.ts";

// ── Test infrastructure ──

interface TestContext {
	dataDir: string;
	projectDir: string;
	app: ReturnType<typeof createApp>;
	mockAPI: ValidatingMockAPI;
	projectId: string;
}

/**
 * Set up a fresh test environment:
 * - Temp dataDir for daemon state
 * - Temp projectDir (git-initialized) as the "project"
 * - Real app with mock provider injected
 * - Project registered in the PM
 */
async function setupTestContext(): Promise<TestContext> {
	const dataDir = await mkdtemp(join(tmpdir(), "og-integ-data-"));
	const projectDir = await mkdtemp(join(tmpdir(), "og-integ-project-"));

	// Initialize git in the project dir (needed for tracker, worktree manager)
	Bun.spawnSync(["git", "init"], { cwd: projectDir });
	Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
		cwd: projectDir,
	});
	Bun.spawnSync(["git", "config", "user.name", "Test"], {
		cwd: projectDir,
	});
	await Bun.write(join(projectDir, "README.md"), "# Test Project\n");
	Bun.spawnSync(["git", "add", "."], { cwd: projectDir });
	Bun.spawnSync(["git", "commit", "-m", "initial"], { cwd: projectDir });

	const mockAPI = new ValidatingMockAPI();
	const provider = createMockedProviderWithMock(mockAPI);

	const appResult = createApp({
		dataDir,
		agentProvider: provider,
	});

	await appResult.pm.load();
	const project = await appResult.pm.init(projectDir);
	appResult.markReady();

	return {
		dataDir,
		projectDir,
		app: appResult,
		mockAPI,
		projectId: project.id,
	};
}

async function teardownTestContext(ctx: TestContext): Promise<void> {
	await ctx.app.shutdown();
	// Small delay to let background cleanup complete before removing dirs
	await new Promise((r) => setTimeout(r, 50));
	await rm(ctx.dataDir, { recursive: true, force: true });
	await rm(ctx.projectDir, { recursive: true, force: true });
}

/**
 * Wait for the root node to reach a terminal status (passed/failed).
 * Root orchestrator (depth 0) doesn't close queue on done() — it enters idle-yield.
 * We detect completion by polling the node status.
 */
async function waitForDone(
	ctx: TestContext,
	timeoutMs = 15000,
): Promise<string> {
	const tracker = await ctx.app.getTracker(ctx.projectId);
	const rootNodeId = tracker.rootNodeId;
	if (!rootNodeId) throw new Error("No root node");

	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const rootNode = tracker.get(rootNodeId);
		if (rootNode?.status === "passed" || rootNode?.status === "failed") {
			return rootNode.status;
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`Agent did not call done() within ${timeoutMs}ms`);
}

/**
 * Wait for agent to enter idle state (yield or end_turn implicit yield).
 */
async function waitForIdle(ctx: TestContext, timeoutMs = 10000): Promise<void> {
	const tracker = await ctx.app.getTracker(ctx.projectId);
	const rootNodeId = tracker.rootNodeId;
	if (!rootNodeId) throw new Error("No root node");

	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const rootNode = tracker.get(rootNodeId);
		const queue = rootNode?.session?.queue;
		if (queue?.idle) {
			return;
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`Agent did not enter idle state within ${timeoutMs}ms`);
}

/**
 * Start the agent via HTTP and return the response.
 */
async function startAgent(ctx: TestContext, prompt: string): Promise<Response> {
	return ctx.app.app.request("/agents/start", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ path: ctx.projectDir, prompt }),
	});
}

/**
 * Send a message to a running agent via HTTP.
 */
async function sendMessage(
	ctx: TestContext,
	message: string,
): Promise<Response> {
	return ctx.app.app.request(`/projects/${ctx.projectId}/message`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ message }),
	});
}

/**
 * Read JSONL events for a session from the event store.
 * Path: {dataDir}/sessions/{projectId}/{sessionId}.events.jsonl
 */
function readSessionEvents(ctx: TestContext, sessionId: string) {
	const store = new EventStore(join(ctx.dataDir, "sessions", ctx.projectId));
	return store.read(sessionId);
}

/**
 * Get root node ID (convenience).
 */
async function getRootNodeId(ctx: TestContext): Promise<string> {
	const tracker = await ctx.app.getTracker(ctx.projectId);
	const id = tracker.rootNodeId;
	if (!id) throw new Error("No root node ID");
	return id;
}

/**
 * Get the last user message from a request record.
 * Throws if the request doesn't exist or last message isn't a user message.
 */
function getLastUserMessage(ctx: TestContext, requestIndex: number) {
	const req = ctx.mockAPI.getRequestHistory()[requestIndex];
	if (!req) throw new Error(`No request at index ${requestIndex}`);
	const lastMsg = req.messages[req.messages.length - 1];
	if (!lastMsg || lastMsg.role !== "user") {
		throw new Error(
			`Last message at request ${requestIndex} is not a user message`,
		);
	}
	return lastMsg;
}

/**
 * Extract tool_result blocks from a user message content array.
 */
function getToolResults(msg: { content: string | unknown[] }) {
	if (!Array.isArray(msg.content)) return [];
	return (
		msg.content as Array<{
			type: string;
			tool_use_id?: string;
			content?: string | unknown;
		}>
	).filter((b) => b.type === "tool_result");
}

/**
 * Extract text blocks from a user message content array, joined.
 */
function getTextContent(msg: { content: string | unknown[] }): string {
	if (typeof msg.content === "string") return msg.content;
	if (!Array.isArray(msg.content)) return "";
	return (msg.content as Array<{ type: string; text?: string }>)
		.filter((b) => b.type === "text")
		.map((b) => b.text ?? "")
		.join(" ");
}

// ── Tests ──

describe("Integration: full stack with mock API", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("Scenario 1: normal multi-turn with real tool execution", async () => {
		ctx = await setupTestContext();

		// Instruction: turn 1 runs bash, turn 2 asserts output then calls done()
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Let me check." },
						{
							type: "tool_use",
							name: "mcp__opengraft__bash",
							input: { command: "echo hello_world" },
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							contains: "hello_world",
							isError: false,
						},
					],
					blocks: [
						{ type: "text", text: "All done!" },
						{
							type: "tool_use",
							name: "mcp__opengraft__done",
							input: {
								status: "passed",
								summary: "executed echo successfully",
							},
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		const status = await waitForDone(ctx);
		expect(status).toBe("passed");

		// Mock API validated all requests automatically — if we got here, contract is satisfied
		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThanOrEqual(2);

		// Verify request 2 contains tool_result with real bash output
		const lastUserMsg = getLastUserMessage(ctx, 1);
		const toolResults = getToolResults(lastUserMsg);
		expect(toolResults.length).toBeGreaterThanOrEqual(1);

		// bash `echo hello_world` → output contains "hello_world"
		const bashContent =
			typeof toolResults[0]?.content === "string"
				? toolResults[0].content
				: JSON.stringify(toolResults[0]?.content);
		expect(bashContent).toContain("hello_world");

		// Verify JSONL persistence
		const rootNodeId = await getRootNodeId(ctx);
		const events = readSessionEvents(ctx, rootNodeId);
		expect(events.length).toBeGreaterThan(0);

		const eventTypes = events.map((e) => e.type);
		expect(eventTypes).toContain("assistant_text");
		expect(eventTypes).toContain("tool_call");
		expect(eventTypes).toContain("tool_result");
	}, 20000);

	test("Scenario 2: multiple tools execute with real results", async () => {
		ctx = await setupTestContext();

		// Write a file to read
		await Bun.write(join(ctx.projectDir, "test-file.txt"), "file_content_here");

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Running two tools." },
						{
							type: "tool_use",
							name: "mcp__opengraft__bash",
							input: { command: "echo tool_one_output" },
						},
						{
							type: "tool_use",
							name: "mcp__opengraft__read_file",
							input: { path: "test-file.txt" },
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							contains: "tool_one_output",
							isError: false,
						},
						{
							block: 1,
							type: "tool_result",
							contains: "file_content_here",
							isError: false,
						},
					],
					blocks: [
						{ type: "text", text: "Got both results." },
						{
							type: "tool_use",
							name: "mcp__opengraft__done",
							input: { status: "passed", summary: "multi-tool ok" },
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		const status = await waitForDone(ctx);
		expect(status).toBe("passed");

		// Asserts in the DSL already validated both tool results.
		// If we got here without MockValidationError, both tools executed correctly.
		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThanOrEqual(2);
	}, 20000);

	test("Scenario 3: explicit yield + wake with message", async () => {
		ctx = await setupTestContext();

		// Turn 1: yield
		const instruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Waiting for input." },
				{
					type: "tool_use",
					name: "mcp__opengraft__yield",
					input: {},
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		// Wait for agent to enter idle (yield) state
		await waitForIdle(ctx);

		// Agent should still be active (in yield)
		expect(ctx.app.activeSessions.has(ctx.projectId)).toBe(true);

		// Wake from yield with done instruction
		const wakeInstruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Finished." },
				{
					type: "tool_use",
					name: "mcp__opengraft__done",
					input: { status: "passed", summary: "woke from yield" },
				},
			],
		});
		const msgResp = await sendMessage(ctx, wakeInstruction);
		expect(msgResp.status).toBe(200);

		const status = await waitForDone(ctx);
		expect(status).toBe("passed");

		// Validate: mock should have received at least 2 API calls
		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThanOrEqual(2);
	}, 20000);

	test("Scenario 4: implicit yield (end_turn) + wake with message", async () => {
		ctx = await setupTestContext();

		// Agent returns text-only (end_turn) → enters implicit yield
		const instruction = JSON.stringify({
			blocks: [{ type: "text", text: "I have nothing to do." }],
			stop_reason: "end_turn",
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		// Wait for agent to enter idle
		await waitForIdle(ctx);

		// Still active (in implicit yield)
		expect(ctx.app.activeSessions.has(ctx.projectId)).toBe(true);

		// Wake with done
		const wakeInstruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Goodbye." },
				{
					type: "tool_use",
					name: "mcp__opengraft__done",
					input: {
						status: "passed",
						summary: "woke from implicit yield",
					},
				},
			],
		});
		const msgResp = await sendMessage(ctx, wakeInstruction);
		expect(msgResp.status).toBe(200);

		const status = await waitForDone(ctx);
		expect(status).toBe("passed");

		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThanOrEqual(2);
	}, 20000);

	test("Scenario 5: JSONL event sequence is correct", async () => {
		ctx = await setupTestContext();

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Running bash." },
						{
							type: "tool_use",
							name: "mcp__opengraft__bash",
							input: { command: "echo jsonl_test" },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Done." },
						{
							type: "tool_use",
							name: "mcp__opengraft__done",
							input: { status: "passed", summary: "jsonl verified" },
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		await waitForDone(ctx);

		const rootNodeId = await getRootNodeId(ctx);
		const events = readSessionEvents(ctx, rootNodeId);

		const persistedTypes = events.map((e) => e.type);

		// Note: done() tool_call has no tool_result in JSONL for root agents.
		// Root (depth 0) done() enters waitForQueueMessages() which blocks —
		// the tool_result is only emitted when the agent wakes up or restarts.

		// Should have message events (user messages)
		expect(
			persistedTypes.filter((t) => t === "message").length,
		).toBeGreaterThanOrEqual(1);
		// Should have assistant_text events
		expect(
			persistedTypes.filter((t) => t === "assistant_text").length,
		).toBeGreaterThanOrEqual(2);
		// Should have tool_call events
		expect(
			persistedTypes.filter((t) => t === "tool_call").length,
		).toBeGreaterThanOrEqual(2);
		// Should have at least 1 tool_result (bash).
		// done() tool_result may not be in JSONL (root agent blocks in waitForQueueMessages).
		expect(
			persistedTypes.filter((t) => t === "tool_result").length,
		).toBeGreaterThanOrEqual(1);

		// Verify every tool_call comes before its corresponding tool_result
		for (let i = 0; i < events.length; i++) {
			const evt = events[i];
			if (evt?.type === "tool_result" && "toolCallId" in evt) {
				const callIdx = events.findIndex(
					(e) =>
						e.type === "tool_call" &&
						"toolCallId" in e &&
						e.toolCallId === evt.toolCallId,
				);
				expect(callIdx).toBeLessThan(i);
			}
		}
	}, 20000);

	test("Scenario 6: message injection during tool execution", async () => {
		ctx = await setupTestContext();

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Running slow command." },
						{
							type: "tool_use",
							name: "mcp__opengraft__bash",
							input: { command: "sleep 0.3 && echo slow_done" },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Got everything." },
						{
							type: "tool_use",
							name: "mcp__opengraft__done",
							input: {
								status: "passed",
								summary: "message received during tool",
							},
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		// Wait for tool to start, then inject message
		await new Promise((r) => setTimeout(r, 100));
		const msgResp = await sendMessage(ctx, "Injected message while tool runs");
		expect(msgResp.status).toBe(200);

		const status = await waitForDone(ctx);
		expect(status).toBe("passed");

		// The injected message should appear in request 2 alongside tool_results
		const lastUserMsg = getLastUserMessage(ctx, 1);
		const allText = getTextContent(lastUserMsg);

		// Should contain the injected message
		expect(allText).toContain("Injected message while tool runs");
	}, 20000);

	test("Scenario 7: validation catches contract violations", async () => {
		ctx = await setupTestContext();

		// This test verifies that the mock API's validation is working
		// by checking it catches violations in isolation (not through the provider).
		// The provider itself should never produce violations — that's what the
		// other tests verify (if they pass without MockValidationError, the provider
		// is generating correct API calls).

		const { MockValidationError } = await import(
			"./test-utils/mock-anthropic-api.ts"
		);

		// Direct mock call with bad messages
		expect(() =>
			ctx.mockAPI.createStream({
				messages: [
					{ role: "user", content: "hi" },
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "tc_1",
								name: "bash",
								input: {},
							},
						],
					},
					// Missing tool_result for tc_1
					{ role: "user", content: "no results here" },
				],
			}),
		).toThrow(MockValidationError);
	}, 10000);
});

// ── Restart tests ──

/**
 * Recreate app with same dataDir/projectDir but new provider (wrapping the same mock).
 * Simulates daemon restart: all in-memory state is lost, rebuilt from disk.
 */
async function recreateApp(
	ctx: TestContext,
): Promise<ReturnType<typeof createApp>> {
	const provider = createMockedProviderWithMock(ctx.mockAPI);
	const newApp = createApp({
		dataDir: ctx.dataDir,
		agentProvider: provider,
	});
	await newApp.pm.load();
	newApp.markReady();
	return newApp;
}

describe("Integration: daemon restart with prefix consistency", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("Restart A: crash during explicit yield", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Turn 1: agent yields → waits for input
		const instruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Waiting for input." },
				{
					type: "tool_use",
					name: "mcp__opengraft__yield",
					input: {},
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		// Wait for agent to enter idle (yield) state
		await waitForIdle(ctx);
		expect(ctx.app.activeSessions.has(ctx.projectId)).toBe(true);

		const preRestartRequests = ctx.mockAPI.getRequestCount();
		expect(preRestartRequests).toBe(1);

		// === CRASH: shutdown the daemon ===
		await ctx.app.shutdown();
		// Small delay to let cleanup complete
		await new Promise((r) => setTimeout(r, 100));

		// === RESTART: recreate app from disk ===
		ctx.app = await recreateApp(ctx);

		// autoResume skips (no active children) — agent doesn't wake
		await ctx.app.autoResumeProjects();

		// Agent should NOT have made new API calls yet (no children = skip resume)
		expect(ctx.mockAPI.getRequestCount()).toBe(preRestartRequests);

		// Send message to wake the agent — this triggers handleInjectMessage → launchAgent(resume)
		// Post-restart turn: agent should call done()
		const wakeInstruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Finished after restart." },
				{
					type: "tool_use",
					name: "mcp__opengraft__done",
					input: { status: "passed", summary: "survived yield restart" },
				},
			],
		});
		const msgResp = await sendMessage(ctx, wakeInstruction);
		expect(msgResp.status).toBe(200);

		const status = await waitForDone(ctx);
		expect(status).toBe("passed");

		// Prefix validation ran automatically in mock — if we got here, prefixes are consistent
		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThan(preRestartRequests);
	}, 30000);

	test("Restart B: crash during bash sleep", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Turn 1: start a long-running bash command
		// Turn 2 (queued): after bash completes → call done
		// Turn 3 (queued): fallback after interrupted bash → call done
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Running a long command." },
						{
							type: "tool_use",
							name: "mcp__opengraft__bash",
							input: { command: "sleep 30" },
						},
					],
				},
				{
					// After restart, the interrupted bash tool_result arrives with isError
					// The agent gets this and should call done
					blocks: [
						{ type: "text", text: "Bash was interrupted, finishing up." },
						{
							type: "tool_use",
							name: "mcp__opengraft__done",
							input: {
								status: "passed",
								summary: "handled bash interruption",
							},
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		// Wait for bash to start executing (the API call happened, tool execution started)
		// We detect this by waiting for the first API request + a small delay
		const start = Date.now();
		while (ctx.mockAPI.getRequestCount() < 1 && Date.now() - start < 5000) {
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(ctx.mockAPI.getRequestCount()).toBe(1);
		// Give bash a moment to actually start
		await new Promise((r) => setTimeout(r, 200));

		const preRestartRequests = ctx.mockAPI.getRequestCount();

		// === CRASH: shutdown while bash is running ===
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		// === RESTART: recreate app ===
		ctx.app = await recreateApp(ctx);

		// autoResume runs orphan cleanup (writes synthetic error tool_result for interrupted bash)
		// but skips auto-resume (no active children)
		await ctx.app.autoResumeProjects();

		// Send message to wake agent — it will see the interrupted bash result
		const wakeInstruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Continue after crash." },
				{
					type: "tool_use",
					name: "mcp__opengraft__done",
					input: { status: "passed", summary: "recovered from bash crash" },
				},
			],
		});
		const msgResp = await sendMessage(ctx, wakeInstruction);
		expect(msgResp.status).toBe(200);

		const status = await waitForDone(ctx);
		expect(status).toBe("passed");

		// Prefix validation passed automatically
		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThan(preRestartRequests);

		// Verify JSONL has the orphan tool_result for bash
		const rootNodeId = await getRootNodeId(ctx);
		const events = readSessionEvents(ctx, rootNodeId);
		const toolResults = events.filter((e) => e.type === "tool_result");
		// At least one tool_result should be the interrupted bash (isError: true)
		const errorResults = toolResults.filter(
			(e) => "isError" in e && e.isError === true,
		);
		expect(errorResults.length).toBeGreaterThanOrEqual(1);
	}, 30000);

	test("Restart C: crash during implicit yield (end_turn)", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Agent returns text-only (end_turn) → enters implicit yield
		const instruction = JSON.stringify({
			blocks: [{ type: "text", text: "I have nothing to do, waiting." }],
			stop_reason: "end_turn",
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		// Wait for agent to enter idle
		await waitForIdle(ctx);
		expect(ctx.app.activeSessions.has(ctx.projectId)).toBe(true);

		const preRestartRequests = ctx.mockAPI.getRequestCount();
		expect(preRestartRequests).toBe(1);

		// === CRASH ===
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		// === RESTART ===
		ctx.app = await recreateApp(ctx);
		await ctx.app.autoResumeProjects();

		// No active children → no auto-resume
		expect(ctx.mockAPI.getRequestCount()).toBe(preRestartRequests);

		// Wake with message → done
		const wakeInstruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Wrapping up after restart." },
				{
					type: "tool_use",
					name: "mcp__opengraft__done",
					input: {
						status: "passed",
						summary: "survived implicit yield restart",
					},
				},
			],
		});
		const msgResp = await sendMessage(ctx, wakeInstruction);
		expect(msgResp.status).toBe(200);

		const status = await waitForDone(ctx);
		expect(status).toBe("passed");

		// Prefix consistency validated by mock
		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThan(preRestartRequests);
	}, 30000);

	test("Restart D: crash after done() — root idle-yield", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Agent immediately calls done (root enters idle-yield)
		const instruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Done immediately." },
				{
					type: "tool_use",
					name: "mcp__opengraft__done",
					input: { status: "passed", summary: "quick done" },
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		// Wait for root to reach "passed" status
		const firstStatus = await waitForDone(ctx);
		expect(firstStatus).toBe("passed");

		const preRestartRequests = ctx.mockAPI.getRequestCount();

		// === CRASH ===
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		// === RESTART ===
		ctx.app = await recreateApp(ctx);
		await ctx.app.autoResumeProjects();

		// Root status was "passed" → autoResume only checks in_progress → skip
		// Agent should NOT auto-resume
		expect(ctx.mockAPI.getRequestCount()).toBe(preRestartRequests);

		// Now send a new message → this should launch a fresh resume session
		const wakeInstruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "New task after restart." },
				{
					type: "tool_use",
					name: "mcp__opengraft__done",
					input: { status: "passed", summary: "second pass after restart" },
				},
			],
		});
		const msgResp = await sendMessage(ctx, wakeInstruction);
		expect(msgResp.status).toBe(200);

		// Root was already "passed" from first run. launchAgent sets it to "in_progress",
		// then agent resumes and calls done() again → "passed". We need to wait for
		// the transition: passed → in_progress → passed. Poll for in_progress first.
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNodeId = tracker.rootNodeId;
		if (!rootNodeId) throw new Error("No root node");

		// Wait for status to become in_progress (agent started)
		const start = Date.now();
		while (Date.now() - start < 5000) {
			const node = tracker.get(rootNodeId);
			if (node?.status === "in_progress") break;
			await new Promise((r) => setTimeout(r, 50));
		}

		// Now wait for the second done
		const secondStatus = await waitForDone(ctx, 20000);
		expect(secondStatus).toBe("passed");

		// Prefix validation passed
		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThan(preRestartRequests);
	}, 30000);

	test("Restart E: prefix validation catches inconsistency", async () => {
		// This test verifies the prefix validation itself works by intentionally
		// creating an inconsistency and checking it throws.
		const { MockValidationError } = await import(
			"./test-utils/mock-anthropic-api.ts"
		);

		const mockAPI = new ValidatingMockAPI();
		mockAPI.enablePrefixValidation();

		// First call: establishes prefix
		mockAPI.createStream({
			messages: [{ role: "user", content: "hello" }],
		});

		// Second call: valid extension (prefix match + new messages)
		mockAPI.createStream({
			messages: [
				{ role: "user", content: "hello" },
				{
					role: "assistant",
					content: [{ type: "text", text: "hi" }],
				},
				{ role: "user", content: "bye" },
			],
		});

		// Third call: INVALID — changes message at index 0
		expect(() =>
			mockAPI.createStream({
				messages: [
					{ role: "user", content: "CHANGED" },
					{
						role: "assistant",
						content: [{ type: "text", text: "hi" }],
					},
					{ role: "user", content: "bye" },
				],
			}),
		).toThrow(MockValidationError);
	}, 10000);

	test("Restart F: messages enqueued during bash survive restart", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Turn 1: start long bash sleep
		// Turn 2: after restart, agent sees interrupted bash + both messages → done
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Running long command." },
						{
							type: "tool_use",
							name: "mcp__opengraft__bash",
							input: { command: "sleep 30" },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Got all messages, finishing." },
						{
							type: "tool_use",
							name: "mcp__opengraft__done",
							input: {
								status: "passed",
								summary: "both messages received after restart",
							},
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		// Wait for bash to start executing
		const start = Date.now();
		while (ctx.mockAPI.getRequestCount() < 1 && Date.now() - start < 5000) {
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(ctx.mockAPI.getRequestCount()).toBe(1);
		await new Promise((r) => setTimeout(r, 200));

		// Send message1 while bash is running — goes into live queue
		const msg1Resp = await sendMessage(ctx, "MESSAGE_ONE_BEFORE_CRASH");
		expect(msg1Resp.status).toBe(200);

		// === CRASH ===
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		// === RESTART ===
		ctx.app = await recreateApp(ctx);
		await ctx.app.autoResumeProjects();

		// Send message2 after restart — triggers agent resume
		const msg2Resp = await sendMessage(ctx, "MESSAGE_TWO_AFTER_RESTART");
		expect(msg2Resp.status).toBe(200);

		const status = await waitForDone(ctx);
		expect(status).toBe("passed");

		// Find the API call after restart that contains user messages
		// It should contain BOTH message1 and message2
		const history = ctx.mockAPI.getRequestHistory();
		const postRestartReq = history[history.length - 1];
		expect(postRestartReq).toBeDefined();

		// Collect all text from user messages in the post-restart request
		const allUserText = postRestartReq!.messages
			.filter((m) => m.role === "user")
			.map((m) => getTextContent(m))
			.join(" ");

		// BOTH messages must be present
		expect(allUserText).toContain("MESSAGE_ONE_BEFORE_CRASH");
		expect(allUserText).toContain("MESSAGE_TWO_AFTER_RESTART");

		// ORDER matters: message1 (sent before crash) must appear BEFORE message2 (sent after restart)
		const idx1 = allUserText.indexOf("MESSAGE_ONE_BEFORE_CRASH");
		const idx2 = allUserText.indexOf("MESSAGE_TWO_AFTER_RESTART");
		expect(idx1).toBeLessThan(idx2);
	}, 30000);

	test("Restart G: message sent after restart is not duplicated", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Agent immediately calls done → enters idle-yield (root)
		const instruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Done immediately." },
				{
					type: "tool_use",
					name: "mcp__opengraft__done",
					input: { status: "passed", summary: "quick done" },
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);
		const firstStatus = await waitForDone(ctx);
		expect(firstStatus).toBe("passed");

		// === CRASH ===
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		// === RESTART ===
		ctx.app = await recreateApp(ctx);
		await ctx.app.autoResumeProjects();

		// Send a message after restart — this triggers handleInjectMessage → launchAgent(resume)
		// The message gets written to JSONL (emitEvent) AND persistent queue (deliverMessage).
		// On launchAgent, findUnconsumedMessages reads it from JSONL, loadPersistedMessages
		// reads it from disk. Without dedup, the message appears TWICE in the queue.
		const wakeInstruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "UNIQUE_RESTART_MESSAGE" },
				{
					type: "tool_use",
					name: "mcp__opengraft__done",
					input: { status: "passed", summary: "no duplicates" },
				},
			],
		});
		const msgResp = await sendMessage(ctx, wakeInstruction);
		expect(msgResp.status).toBe(200);

		// Wait for status transition: passed → in_progress → passed
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNodeId = tracker.rootNodeId;
		if (!rootNodeId) throw new Error("No root node");
		const start = Date.now();
		while (Date.now() - start < 5000) {
			const node = tracker.get(rootNodeId);
			if (node?.status === "in_progress") break;
			await new Promise((r) => setTimeout(r, 50));
		}
		const secondStatus = await waitForDone(ctx, 20000);
		expect(secondStatus).toBe("passed");

		// Find the post-restart API call
		const history = ctx.mockAPI.getRequestHistory();
		// The last request is the post-restart one
		const postRestartReq = history[history.length - 1];
		expect(postRestartReq).toBeDefined();

		// Collect ALL text from ALL user messages in the post-restart request
		const allUserTexts: string[] = [];
		for (const msg of postRestartReq!.messages) {
			if (msg.role === "user") {
				const text = getTextContent(msg);
				if (text) allUserTexts.push(text);
			}
		}
		const allUserText = allUserTexts.join(" ");

		// The message must appear exactly ONCE, not twice
		expect(allUserText).toContain("UNIQUE_RESTART_MESSAGE");

		// Count occurrences — must be exactly 1
		const matches = allUserText.match(/UNIQUE_RESTART_MESSAGE/g);
		expect(matches?.length).toBe(1);
	}, 30000);

	test("Restart H: bg process + yield crash → resume works (bg_complete delivered via queue)", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Turn 1: bash with run_in_background:true (returns immediately with backgroundId).
		// Turn 2: agent yields to wait for input.
		// Turn 3 (post-restart): agent receives wake message + bg_complete → calls done.
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Running background process." },
						{
							type: "tool_use",
							name: "mcp__opengraft__bash",
							input: { command: "sleep 30", run_in_background: true },
						},
					],
				},
				{
					// After bash returns (backgrounded), agent yields
					blocks: [
						{ type: "text", text: "Waiting for input." },
						{
							type: "tool_use",
							name: "mcp__opengraft__yield",
							input: {},
						},
					],
				},
				{
					// Post-restart: agent wakes from yield, sees bg_complete + user message
					blocks: [
						{ type: "text", text: "Background was interrupted, finishing." },
						{
							type: "tool_use",
							name: "mcp__opengraft__done",
							input: {
								status: "passed",
								summary: "survived bg + yield restart",
							},
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		// Wait for agent to enter idle (yield) state — bash already backgrounded
		await waitForIdle(ctx);

		// Verify a background process was started — check JSONL for tool_result with backgroundId
		const rootNodeId = await getRootNodeId(ctx);
		const preRestartEvents = readSessionEvents(ctx, rootNodeId);
		const bgToolResults = preRestartEvents.filter(
			(e) => e.type === "tool_result" && "backgroundId" in e && e.backgroundId,
		);
		expect(bgToolResults.length).toBe(1);
		const bgId = (bgToolResults[0] as { backgroundId: string }).backgroundId;
		expect(bgId).toMatch(/^bg-/);

		// Before restart: no background_complete in JSONL
		const preRestartBgComplete = preRestartEvents.filter(
			(e) =>
				e.type === "message" &&
				"body" in e &&
				e.body &&
				typeof e.body === "object" &&
				"source" in e.body &&
				e.body.source === "background_complete",
		);
		expect(preRestartBgComplete.length).toBe(0);

		const preRestartRequests = ctx.mockAPI.getRequestCount();

		// === CRASH ===
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		// === RESTART ===
		ctx.app = await recreateApp(ctx);
		await ctx.app.autoResumeProjects();

		// bg_complete should NOT be in JSONL for yielding agents (it goes to queue instead)
		// This is the key: writing bg_complete to JSONL between yield tool_call and its
		// tool_result breaks the converter → API 400.
		const postRestartEvents = readSessionEvents(ctx, rootNodeId);
		const bgCompleteInJSONL = postRestartEvents.filter(
			(e) =>
				e.type === "message" &&
				"body" in e &&
				e.body &&
				typeof e.body === "object" &&
				"source" in e.body &&
				e.body.source === "background_complete",
		);
		// For yielding agents, bg_complete goes to queue, not JSONL
		expect(bgCompleteInJSONL.length).toBe(0);

		// Send message to wake agent — triggers resume with yield detection
		const wakeInstruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Continue after bg restart." },
				{
					type: "tool_use",
					name: "mcp__opengraft__done",
					input: {
						status: "passed",
						summary: "survived bg + yield restart",
					},
				},
			],
		});
		const msgResp = await sendMessage(ctx, wakeInstruction);
		expect(msgResp.status).toBe(200);

		// Agent should resume from yield, process bg_complete + wake message, call done
		const status = await waitForDone(ctx);
		expect(status).toBe("passed");

		// Prefix validation passed — no API 400 from misplaced bg_complete
		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThan(preRestartRequests);
	}, 30000);
});

// ── Same-turn tool conflict tests ──

describe("Integration: same-turn tool conflicts", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("yield + bash same turn: bash executes, yield returns success (no-op)", async () => {
		ctx = await setupTestContext();

		// Turn 1: bash + yield in same turn
		// Expected: bash executes normally, yield returns success without waiting
		// Turn 2: assert both results, then done
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Running bash and yielding." },
						{
							type: "tool_use",
							name: "mcp__opengraft__bash",
							input: { command: "echo yield_bash_test" },
						},
						{
							type: "tool_use",
							name: "mcp__opengraft__yield",
							input: {},
						},
					],
				},
				{
					assert: [
						{ length: 2 },
						{
							block: 0,
							type: "tool_result",
							contains: "yield_bash_test",
							isError: false,
						},
						{ block: 1, type: "tool_result", isError: false },
					],
					blocks: [
						{ type: "text", text: "Both tools handled." },
						{
							type: "tool_use",
							name: "mcp__opengraft__done",
							input: {
								status: "passed",
								summary: "yield + bash same turn ok",
							},
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		const status = await waitForDone(ctx);
		expect(status).toBe("passed");
	}, 20000);

	test("bash + yield reverse order: same behavior regardless of order", async () => {
		ctx = await setupTestContext();

		// Turn 1: yield first, bash second — should behave identically to bash+yield
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Yield first, then bash." },
						{
							type: "tool_use",
							name: "mcp__opengraft__yield",
							input: {},
						},
						{
							type: "tool_use",
							name: "mcp__opengraft__bash",
							input: { command: "echo reverse_order_test" },
						},
					],
				},
				{
					assert: [
						{ length: 2 },
						{ block: 0, type: "tool_result", isError: false },
						{
							block: 1,
							type: "tool_result",
							contains: "reverse_order_test",
							isError: false,
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__opengraft__done",
							input: {
								status: "passed",
								summary: "reverse order ok",
							},
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		const status = await waitForDone(ctx);
		expect(status).toBe("passed");
	}, 20000);

	test("done + bash same turn: bash executes, done returns error", async () => {
		ctx = await setupTestContext();

		// Turn 1: bash + done in same turn
		// Expected: bash executes normally, done returns error (can't finish without seeing results)
		// Turn 2: assert bash succeeded and done errored, then actually done
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Trying to bash and done together." },
						{
							type: "tool_use",
							name: "mcp__opengraft__bash",
							input: { command: "echo done_bash_test" },
						},
						{
							type: "tool_use",
							name: "mcp__opengraft__done",
							input: { status: "passed", summary: "premature done" },
						},
					],
				},
				{
					assert: [
						{ length: 2 },
						{
							block: 0,
							type: "tool_result",
							contains: "done_bash_test",
							isError: false,
						},
						{
							block: 1,
							type: "tool_result",
							isError: true,
							contains: "Cannot call done",
						},
					],
					blocks: [
						{ type: "text", text: "Now properly done." },
						{
							type: "tool_use",
							name: "mcp__opengraft__done",
							input: {
								status: "passed",
								summary: "done after seeing error",
							},
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		const status = await waitForDone(ctx);
		expect(status).toBe("passed");
	}, 20000);
});
