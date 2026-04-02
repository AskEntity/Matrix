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
import { existsSync, rmSync } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./daemon.ts";
import { EventStore } from "./event-store.ts";
import type { Event } from "./events.ts";
import {
	createMockedProviderWithMock,
	ValidatingMockAPI,
} from "./test-utils/mock-anthropic-api.ts";
import type { TaskNode } from "./types.ts";

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
	const dataDir = await mkdtemp(join(tmpdir(), "mxd-integ-data-"));
	const projectDir = await mkdtemp(join(tmpdir(), "mxd-integ-project-"));

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

	// Clean up quality task templates that interfere with test assumptions
	const tasksDir = join(projectDir, ".mxd", "tasks");
	if (existsSync(tasksDir)) {
		rmSync(tasksDir, { recursive: true });
	}

	// Activate the setup hook: rename .example → .sh so worktree creation works.
	// Without this, child agent tasks can't create worktrees.
	const hookExample = join(
		projectDir,
		".mxd",
		"hooks",
		"setup_worktree.sh.example",
	);
	const hookActive = join(projectDir, ".mxd", "hooks", "setup_worktree.sh");
	if (existsSync(hookExample)) {
		await rename(hookExample, hookActive);
	}
	// Commit the hook so it's available in worktrees
	Bun.spawnSync(["git", "add", "."], { cwd: projectDir });
	Bun.spawnSync(["git", "commit", "-m", "activate setup hook"], {
		cwd: projectDir,
	});

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
 * Start the agent via the unified task message endpoint.
 */
async function startAgent(ctx: TestContext, prompt: string): Promise<Response> {
	const tasksRes = await ctx.app.app.request(
		`/projects/${ctx.projectId}/tasks`,
	);
	const { rootNodeId } = (await tasksRes.json()) as { rootNodeId: string };
	return ctx.app.app.request(
		`/projects/${ctx.projectId}/tasks/${rootNodeId}/message`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: prompt }),
		},
	);
}

/**
 * Send a message to the root agent via the unified task message endpoint.
 */
async function sendMessage(
	ctx: TestContext,
	message: string,
): Promise<Response> {
	const tracker = await ctx.app.getTracker(ctx.projectId);
	const rootNodeId = tracker.rootNodeId;
	return ctx.app.app.request(
		`/projects/${ctx.projectId}/tasks/${rootNodeId}/message`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: message }),
		},
	);
}

/**
 * Read JSONL events for a session from the event store.
 * Flushes pending writes from the daemon's EventStore first to avoid race conditions
 * where async JSONL writes haven't completed yet.
 * Path: {dataDir}/sessions/{projectId}/{sessionId}.events.jsonl
 */
async function readSessionEvents(ctx: TestContext, sessionId: string) {
	// Flush the daemon's EventStore to ensure all pending writes are on disk
	const daemonStore = ctx.app.ctx.eventStores.get(ctx.projectId);
	if (daemonStore) {
		await daemonStore.flushSession(sessionId);
	}
	const store = new EventStore(join(ctx.dataDir, "sessions", ctx.projectId));
	return store.read(sessionId);
}

/**
 * Get root node ID (convenience).
 */
async function getRootNodeId(ctx: TestContext): Promise<string> {
	const tracker = await ctx.app.getTracker(ctx.projectId);
	return tracker.rootNodeId;
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
							name: "mcp__mxd__bash",
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
							name: "mcp__mxd__done",
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
		const events = await readSessionEvents(ctx, rootNodeId);
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
							name: "mcp__mxd__bash",
							input: { command: "echo tool_one_output" },
						},
						{
							type: "tool_use",
							name: "mcp__mxd__read_file",
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
							name: "mcp__mxd__done",
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
					name: "mcp__mxd__yield",
					input: {},
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		// Wait for agent to enter idle (yield) state
		await waitForIdle(ctx);

		// Agent should still be active (in yield)
		const yieldTracker = await ctx.app.getTracker(ctx.projectId);
		expect(yieldTracker.get(yieldTracker.rootNodeId)?.session).toBeTruthy();

		// Wake from yield with done instruction
		const wakeInstruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Finished." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
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
		const implicitTracker = await ctx.app.getTracker(ctx.projectId);
		expect(
			implicitTracker.get(implicitTracker.rootNodeId)?.session,
		).toBeTruthy();

		// Wake with done
		const wakeInstruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Goodbye." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
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
							name: "mcp__mxd__bash",
							input: { command: "echo jsonl_test" },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Done." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
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
		const events = await readSessionEvents(ctx, rootNodeId);

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
							name: "mcp__mxd__bash",
							input: { command: "sleep 0.3 && echo slow_done" },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Got everything." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
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
			ctx.mockAPI.createStream(
				{
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
				},
				"s7",
			),
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
					name: "mcp__mxd__yield",
					input: {},
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		// Wait for agent to enter idle (yield) state
		await waitForIdle(ctx);
		{
			const t = await ctx.app.getTracker(ctx.projectId);
			expect(t.get(t.rootNodeId)?.session).toBeTruthy();
		}

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
					name: "mcp__mxd__done",
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
							name: "mcp__mxd__bash",
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
							name: "mcp__mxd__done",
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
					name: "mcp__mxd__done",
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
		const events = await readSessionEvents(ctx, rootNodeId);
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
		{
			const t = await ctx.app.getTracker(ctx.projectId);
			expect(t.get(t.rootNodeId)?.session).toBeTruthy();
		}

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
					name: "mcp__mxd__done",
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
					name: "mcp__mxd__done",
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
					name: "mcp__mxd__done",
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
		mockAPI.createStream(
			{
				messages: [{ role: "user", content: "hello" }],
			},
			"restart-e",
		);

		// Second call: valid extension (prefix match + new messages)
		mockAPI.createStream(
			{
				messages: [
					{ role: "user", content: "hello" },
					{
						role: "assistant",
						content: [{ type: "text", text: "hi" }],
					},
					{ role: "user", content: "bye" },
				],
			},
			"restart-e",
		);

		// Third call: INVALID — changes assistant message at index 1
		// (same first user message = same conversation, so prefix validation triggers)
		expect(() =>
			mockAPI.createStream(
				{
					messages: [
						{ role: "user", content: "hello" },
						{
							role: "assistant",
							content: [{ type: "text", text: "CHANGED" }],
						},
						{ role: "user", content: "bye" },
					],
				},
				"restart-e",
			),
		).toThrow(MockValidationError);
	}, 10000);

	test("Prefix validation catches system prompt change between calls", async () => {
		const { MockValidationError } = await import(
			"./test-utils/mock-anthropic-api.ts"
		);

		const mockAPI = new ValidatingMockAPI();
		mockAPI.enablePrefixValidation();

		const systemBlocks = [
			{ type: "text", text: "You are helpful." },
			{
				type: "text",
				text: "Today is 2026-03-30.",
				cache_control: { type: "ephemeral", ttl: "1h" },
			},
		];

		// First call: establishes system + messages
		mockAPI.createStream(
			{
				messages: [{ role: "user", content: "hello" }],
				system: systemBlocks,
			},
			"sys-prompt",
		);

		// Second call: same system, extended messages — OK
		mockAPI.createStream(
			{
				messages: [
					{ role: "user", content: "hello" },
					{ role: "assistant", content: [{ type: "text", text: "hi" }] },
					{ role: "user", content: "next" },
				],
				system: systemBlocks,
			},
			"sys-prompt",
		);

		// Third call: CHANGED system prompt — must throw
		expect(() =>
			mockAPI.createStream(
				{
					messages: [
						{ role: "user", content: "hello" },
						{ role: "assistant", content: [{ type: "text", text: "hi" }] },
						{ role: "user", content: "next" },
						{ role: "assistant", content: [{ type: "text", text: "ok" }] },
						{ role: "user", content: "more" },
					],
					system: [
						{ type: "text", text: "You are helpful." },
						{
							type: "text",
							text: "Today is 2026-03-31.", // Date changed!
							cache_control: { type: "ephemeral", ttl: "1h" },
						},
					],
				},
				"sys-prompt",
			),
		).toThrow(MockValidationError);
	}, 10000);

	test("Prefix validation catches tools change between calls", async () => {
		const { MockValidationError } = await import(
			"./test-utils/mock-anthropic-api.ts"
		);

		const mockAPI = new ValidatingMockAPI();
		mockAPI.enablePrefixValidation();

		const tools = [
			{ name: "bash", description: "Run bash", input_schema: {} },
			{ name: "read", description: "Read file", input_schema: {} },
		];

		// First call
		mockAPI.createStream(
			{
				messages: [{ role: "user", content: "hello" }],
				tools,
			},
			"tools-change",
		);

		// Second call: same tools — OK
		mockAPI.createStream(
			{
				messages: [
					{ role: "user", content: "hello" },
					{ role: "assistant", content: [{ type: "text", text: "hi" }] },
					{ role: "user", content: "next" },
				],
				tools,
			},
			"tools-change",
		);

		// Third call: tools changed (added a tool) — must throw
		expect(() =>
			mockAPI.createStream(
				{
					messages: [
						{ role: "user", content: "hello" },
						{ role: "assistant", content: [{ type: "text", text: "hi" }] },
						{ role: "user", content: "next" },
						{ role: "assistant", content: [{ type: "text", text: "ok" }] },
						{ role: "user", content: "more" },
					],
					tools: [
						...tools,
						{ name: "write", description: "Write file", input_schema: {} },
					],
				},
				"tools-change",
			),
		).toThrow(MockValidationError);
	}, 10000);

	test("Prefix validation: different conversations don't interfere", async () => {
		// Parent and child have different sessionIds → different conversations.
		// System prompt change in one shouldn't affect the other.
		const mockAPI = new ValidatingMockAPI();
		mockAPI.enablePrefixValidation();

		const system = [{ type: "text", text: "shared system prompt" }];

		// Parent conversation
		mockAPI.createStream(
			{
				messages: [{ role: "user", content: "parent msg" }],
				system,
			},
			"parent-session",
		);

		// Child conversation (different sessionId)
		mockAPI.createStream(
			{
				messages: [{ role: "user", content: "child msg" }],
				system,
			},
			"child-session",
		);

		// Parent turn 2: same system — should NOT throw
		mockAPI.createStream(
			{
				messages: [
					{ role: "user", content: "parent msg" },
					{ role: "assistant", content: [{ type: "text", text: "hi" }] },
					{ role: "user", content: "next" },
				],
				system,
			},
			"parent-session",
		);

		// Child turn 2: same system — should NOT throw
		mockAPI.createStream(
			{
				messages: [
					{ role: "user", content: "child msg" },
					{ role: "assistant", content: [{ type: "text", text: "hi" }] },
					{ role: "user", content: "next" },
				],
				system,
			},
			"child-session",
		);
	}, 10000);

	test("Prefix validation: fork parent and child share system+tools", async () => {
		// Verifies that fork parent and child, when they diverge in messages
		// but share system/tools, pass validation. And if system differs, it catches it.
		const { MockValidationError } = await import(
			"./test-utils/mock-anthropic-api.ts"
		);

		const mockAPI = new ValidatingMockAPI();
		mockAPI.enablePrefixValidation();

		const system = [
			{ type: "text", text: "Stable prompt text." },
			{
				type: "text",
				text: "Variable: date=2026-03-30",
				cache_control: { type: "ephemeral", ttl: "1h" },
			},
		];
		const tools = [
			{
				name: "mcp__mxd__done",
				description: "Finish",
				input_schema: {},
			},
		];

		// Parent turn 1
		mockAPI.createStream(
			{
				messages: [{ role: "user", content: "parent start" }],
				system,
				tools,
			},
			"fork-parent",
		);

		// Parent turn 2 (extended prefix)
		mockAPI.createStream(
			{
				messages: [
					{ role: "user", content: "parent start" },
					{
						role: "assistant",
						content: [
							{ type: "text", text: "working" },
							{
								type: "tool_use",
								id: "t1",
								name: "mcp__mxd__fork_task_context",
								input: {},
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "t1",
								content: "You are the PARENT",
							},
						],
					},
				],
				system,
				tools,
			},
			"fork-parent",
		);

		// Child turn 1 — shares parent's prefix up to fork point, then diverges.
		// Key: system + tools must match parent's.
		// First user message is different (child gets fork result) → different conversation key.
		mockAPI.createStream(
			{
				messages: [
					{ role: "user", content: "parent start" }, // inherited prefix
					{
						role: "assistant",
						content: [
							{ type: "text", text: "working" },
							{
								type: "tool_use",
								id: "t1",
								name: "mcp__mxd__fork_task_context",
								input: {},
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "t1",
								content: "You are the CHILD",
							},
						],
					},
				],
				system, // same system — should pass
				tools, // same tools — should pass
			},
			"fork-child",
		);

		// Child turn 2 — same system/tools, extended messages — should pass
		mockAPI.createStream(
			{
				messages: [
					{ role: "user", content: "parent start" },
					{
						role: "assistant",
						content: [
							{ type: "text", text: "working" },
							{
								type: "tool_use",
								id: "t1",
								name: "mcp__mxd__fork_task_context",
								input: {},
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "t1",
								content: "You are the CHILD",
							},
						],
					},
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "t2",
								name: "mcp__mxd__done",
								input: { status: "passed", summary: "done" },
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "t2",
								content: "passed",
							},
						],
					},
				],
				system, // same — pass
				tools, // same — pass
			},
			"fork-child",
		);

		// Now: mutation — if child had a DIFFERENT system prompt, it should throw.
		// This is the exact bug we fixed: fork child used to get buildSystemPrompt(false)
		// while parent had buildSystemPrompt(true).
		const wrongSystem = [
			{ type: "text", text: "DIFFERENT stable prompt." },
			{
				type: "text",
				text: "Variable: date=2026-03-30",
				cache_control: { type: "ephemeral", ttl: "1h" },
			},
		];

		// Reset and replay parent so we get a fresh conversation
		mockAPI.reset();
		mockAPI.enablePrefixValidation();

		// Parent
		mockAPI.createStream(
			{
				messages: [{ role: "user", content: "parent msg v2" }],
				system,
				tools,
			},
			"fork-parent-v2",
		);

		// Child with WRONG system — same first user message prefix as parent
		// but since child has different content at fork point, it's a different
		// conversation key. So we need to check within the SAME conversation.
		// Simulate: child makes 2 calls, second one has wrong system.
		mockAPI.createStream(
			{
				messages: [{ role: "user", content: "child v2 start" }],
				system,
				tools,
			},
			"fork-child-v2",
		);

		expect(() =>
			mockAPI.createStream(
				{
					messages: [
						{ role: "user", content: "child v2 start" },
						{ role: "assistant", content: [{ type: "text", text: "ok" }] },
						{ role: "user", content: "next" },
					],
					system: wrongSystem, // changed system — MUST throw
					tools,
				},
				"fork-child-v2",
			),
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
							name: "mcp__mxd__bash",
							input: { command: "sleep 30" },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Got all messages, finishing." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
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
		const req = postRestartReq as (typeof history)[0];
		const allUserText = req.messages
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
					name: "mcp__mxd__done",
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
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "no duplicates" },
				},
			],
		});
		const msgResp = await sendMessage(ctx, wakeInstruction);
		expect(msgResp.status).toBe(200);

		// Wait for status transition: passed → in_progress → passed
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNodeId = tracker.rootNodeId;
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
		for (const msg of postRestartReq?.messages ?? []) {
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
							name: "mcp__mxd__bash",
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
							name: "mcp__mxd__yield",
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
							name: "mcp__mxd__done",
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
		const preRestartEvents = await readSessionEvents(ctx, rootNodeId);
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
		const postRestartEvents = await readSessionEvents(ctx, rootNodeId);
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
					name: "mcp__mxd__done",
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

	test("Restart I: two concurrent bash + crash (one fast, one slow)", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Turn 1: two bash commands in parallel — echo A completes fast, sleep 30 is slow
		// Both execute via Promise.all. If we crash before Promise.all resolves,
		// neither tool_result gets written to JSONL → both become orphans.
		// Turn 2 (after restart): assert both tool_results present as orphans (isError: true)
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Running two commands in parallel." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo FAST_RESULT_A" },
						},
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "sleep 30" },
						},
					],
				},
				{
					assert: [
						// Both tool_results are orphaned since Promise.all hadn't resolved
						{
							block: 0,
							type: "tool_result",
							isError: true,
							contains: "interrupted",
						},
						{
							block: 1,
							type: "tool_result",
							isError: true,
							contains: "interrupted",
						},
					],
					blocks: [
						{ type: "text", text: "Both results received, finishing." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: {
								status: "passed",
								summary: "concurrent bash + crash handled",
							},
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		// Wait for API call (turn 1) + bash to start
		const start = Date.now();
		while (ctx.mockAPI.getRequestCount() < 1 && Date.now() - start < 5000) {
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(ctx.mockAPI.getRequestCount()).toBe(1);
		// Let the fast echo complete but sleep is still running
		await new Promise((r) => setTimeout(r, 500));

		const preRestartRequests = ctx.mockAPI.getRequestCount();

		// === CRASH while sleep 30 is still running ===
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		// === RESTART ===
		ctx.app = await recreateApp(ctx);
		await ctx.app.autoResumeProjects();

		// Send message to wake agent — it will see both tool results
		const wakeMsg = await sendMessage(ctx, "Continue after concurrent crash.");
		expect(wakeMsg.status).toBe(200);

		const status = await waitForDone(ctx);
		expect(status).toBe("passed");

		// Prefix validation passed
		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThan(preRestartRequests);

		// Verify JSONL: should have 2 tool_results for the 2 bash commands
		const rootNodeId = await getRootNodeId(ctx);
		const events = await readSessionEvents(ctx, rootNodeId);
		const toolResults = events.filter((e) => e.type === "tool_result");
		// At least 2 tool_results: echo (normal) + sleep (orphan/interrupted)
		expect(toolResults.length).toBeGreaterThanOrEqual(2);
	}, 30000);

	test("Restart J: message inject during bash + crash", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Turn 1: bash sleep 2 (slow enough to inject message, but we crash before it completes)
		// After restart: orphan bash + injected message both present
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Running sleep." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "sleep 30" },
						},
					],
				},
				{
					// After restart: tool_result (orphaned bash) + text (injected message)
					assert: [
						{ block: 0, type: "tool_result", isError: true },
						{ block: 1, type: "text", contains: "INJECTED_DURING_BASH" },
					],
					blocks: [
						{ type: "text", text: "Got orphan result and message." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "inject + crash ok" },
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		// Wait for bash to start
		const start = Date.now();
		while (ctx.mockAPI.getRequestCount() < 1 && Date.now() - start < 5000) {
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(ctx.mockAPI.getRequestCount()).toBe(1);
		await new Promise((r) => setTimeout(r, 200));

		// Inject message while bash is running
		const msgResp = await sendMessage(ctx, "INJECTED_DURING_BASH");
		expect(msgResp.status).toBe(200);

		// Short delay so the message event is persisted to JSONL
		await new Promise((r) => setTimeout(r, 100));

		// === CRASH ===
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		// === RESTART ===
		ctx.app = await recreateApp(ctx);
		await ctx.app.autoResumeProjects();

		// Send message to trigger resume
		const wakeResp = await sendMessage(ctx, "Resume after inject crash");
		expect(wakeResp.status).toBe(200);

		const status = await waitForDone(ctx);
		expect(status).toBe("passed");

		// The injected message must appear in the post-restart API call
		const history = ctx.mockAPI.getRequestHistory();
		const postRestartReq = history[history.length - 1];
		expect(postRestartReq).toBeDefined();
		const allUserText = postRestartReq?.messages
			.filter((m) => m.role === "user")
			.map((m) => getTextContent(m))
			.join(" ");
		expect(allUserText).toContain("INJECTED_DURING_BASH");
	}, 30000);

	test("Restart K: double restart (crash → restart → crash → restart)", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Turn 1: bash sleep 30
		// Crash → restart → crash again → restart → agent resumes with orphan result → done
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Running long command." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "sleep 30" },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Survived double restart." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "double restart survived" },
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		// Wait for bash to start
		const start = Date.now();
		while (ctx.mockAPI.getRequestCount() < 1 && Date.now() - start < 5000) {
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(ctx.mockAPI.getRequestCount()).toBe(1);
		await new Promise((r) => setTimeout(r, 200));

		// === FIRST CRASH ===
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		// === FIRST RESTART ===
		ctx.app = await recreateApp(ctx);
		await ctx.app.autoResumeProjects();

		// === SECOND CRASH (immediately, before agent fully resumes) ===
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		// === SECOND RESTART ===
		ctx.app = await recreateApp(ctx);
		await ctx.app.autoResumeProjects();

		// Send wake message to resume agent
		const wakeResp = await sendMessage(ctx, "Continue after double restart.");
		expect(wakeResp.status).toBe(200);

		const status = await waitForDone(ctx);
		expect(status).toBe("passed");

		// Verify JSONL has the orphan tool_result(s)
		const rootNodeId = await getRootNodeId(ctx);
		const events = await readSessionEvents(ctx, rootNodeId);
		const errorResults = events.filter(
			(e) => e.type === "tool_result" && "isError" in e && e.isError === true,
		);
		expect(errorResults.length).toBeGreaterThanOrEqual(1);
	}, 45000);

	test("Restart L: crash during end_turn implicit yield + message recovery", async () => {
		ctx = await setupTestContext();
		// Note: prefix validation intentionally disabled for this test.
		// end_turn implicit yield + consumed message has a known timestamp formatting
		// difference between live path (timestamped string) and resume path (array form).
		// This test validates message survival, not prefix consistency.

		// Agent returns text-only (end_turn) → enters implicit yield.
		// Message is injected — it wakes the agent and gets consumed.
		// Then crash + restart → agent must be able to resume and call done.
		const instruction = JSON.stringify({
			blocks: [{ type: "text", text: "Nothing to do right now." }],
			stop_reason: "end_turn",
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		// Wait for agent to enter idle (implicit yield)
		await waitForIdle(ctx);
		{
			const t = await ctx.app.getTracker(ctx.projectId);
			expect(t.get(t.rootNodeId)?.session).toBeTruthy();
		}

		const preRestartRequests = ctx.mockAPI.getRequestCount();
		expect(preRestartRequests).toBe(1);

		// Inject message while in implicit yield — it wakes the agent.
		// The agent consumes it and makes an API call (default "Acknowledged.").
		const msgResp = await sendMessage(ctx, "PENDING_MSG_BEFORE_CRASH");
		expect(msgResp.status).toBe(200);

		// Let the message be consumed and the default response processed
		await new Promise((r) => setTimeout(r, 300));

		// Verify the message was consumed (request count increased)
		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThan(preRestartRequests);

		// === CRASH (while agent is back in implicit yield after consuming the message) ===
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		// === RESTART ===
		ctx.app = await recreateApp(ctx);
		await ctx.app.autoResumeProjects();

		// Send wake instruction with done()
		const wakeInstruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Finish up after crash." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "end_turn crash recovered" },
				},
			],
		});
		const wakeResp = await sendMessage(ctx, wakeInstruction);
		expect(wakeResp.status).toBe(200);

		// Wait for status transition
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNodeId = tracker.rootNodeId;
		const start2 = Date.now();
		while (Date.now() - start2 < 5000) {
			const node = tracker.get(rootNodeId);
			if (node?.status === "in_progress") break;
			await new Promise((r) => setTimeout(r, 50));
		}

		const status = await waitForDone(ctx, 20000);
		expect(status).toBe("passed");

		// The pending message should appear somewhere in the API call history
		const history = ctx.mockAPI.getRequestHistory();
		const allUserText = history
			.flatMap((r) => r.messages.filter((m) => m.role === "user"))
			.map((m) => getTextContent(m))
			.join(" ");
		expect(allUserText).toContain("PENDING_MSG_BEFORE_CRASH");

		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThan(preRestartRequests);
	}, 30000);

	test("Restart M: bg orphan cleanup — full lifecycle with synthetic background_complete", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Scenario: bg process started (run_in_background) → foreground bash → crash.
		// On restart, findOrphanedBackgroundProcesses writes synthetic background_complete
		// to JSONL. The synthetic event must have a proper ULID id so that it follows the
		// two-phase message lifecycle (deferred until messages_consumed). With id="" the
		// converter materializes it as an immediate user message, causing consecutive user
		// messages (orphan tool_result + bg_complete both user role) → API 400.
		//
		// Full lifecycle: crash → restart → resume → done.
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Starting bg." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "sleep 60", run_in_background: true },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Foreground bash." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "sleep 30" },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Resumed after restart." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: {
								status: "passed",
								summary: "bg orphan handled on restart",
							},
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		// Wait for foreground bash to start (API call 2)
		const start = Date.now();
		while (ctx.mockAPI.getRequestCount() < 2 && Date.now() - start < 5000) {
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(ctx.mockAPI.getRequestCount()).toBe(2);
		await new Promise((r) => setTimeout(r, 200));

		const rootNodeId = await getRootNodeId(ctx);

		// Verify bg started (tool_result with backgroundId in JSONL)
		const preEvents = await readSessionEvents(ctx, rootNodeId);
		expect(
			preEvents.some((e) => e.type === "tool_result" && e.backgroundId),
		).toBe(true);

		// No bg_complete before crash
		expect(
			preEvents.filter(
				(e) =>
					e.type === "message" &&
					e.body &&
					typeof e.body === "object" &&
					"source" in e.body &&
					(e.body as { source: string }).source === "background_complete",
			).length,
		).toBe(0);

		// === CRASH ===
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		// === RESTART ===
		ctx.app = await recreateApp(ctx);
		await ctx.app.autoResumeProjects();

		// Wait for runAgentForNode to complete repair + bg orphan detection
		// (these now happen inside runAgentForNode, not autoResumeProjects)
		await new Promise((r) => setTimeout(r, 1000));

		// After agent starts, JSONL should have synthetic background_complete
		const postEvents = await readSessionEvents(ctx, rootNodeId);
		const bgCompleteEvents = postEvents.filter(
			(e) =>
				e.type === "message" &&
				e.body &&
				typeof e.body === "object" &&
				"source" in e.body &&
				(e.body as { source: string }).source === "background_complete",
		);
		expect(bgCompleteEvents.length).toBeGreaterThanOrEqual(1);
		expect(
			(bgCompleteEvents[0] as { body: { stderr: string } }).body.stderr,
		).toContain("daemon restart");

		// Verify the synthetic bg_complete has a proper ULID id (not empty string)
		const bgCompleteEvent = bgCompleteEvents[0] as (typeof bgCompleteEvents)[0];
		expect(bgCompleteEvent.type).toBe("message");
		if (bgCompleteEvent.type === "message") {
			expect(bgCompleteEvent.id).toBeTruthy();
			expect(bgCompleteEvent.id.length).toBe(26); // ULID is 26 chars
		}

		// Verify the bg_complete's commandId matches the bg process that was started
		const bgToolResult = preEvents.find(
			(e) => e.type === "tool_result" && e.backgroundId,
		);
		const bgId =
			bgToolResult?.type === "tool_result"
				? (bgToolResult.backgroundId ?? "")
				: "";
		expect(bgId).toBeTruthy();
		const bgCompleteCommandId = (
			bgCompleteEvents[0] as { body: { commandId: string } }
		).body.commandId;
		expect(bgCompleteCommandId).toBe(bgId);

		// Send message to wake agent and trigger resume
		const msgResp = await sendMessage(ctx, "RESUME_AFTER_BG_ORPHAN");
		expect(msgResp.status).toBe(200);

		// Full lifecycle: agent resumes, processes bg_complete + message, calls done
		const status = await waitForDone(ctx);
		expect(status).toBe("passed");

		// Verify the API was called after restart (prefix validation catches consecutive user msgs)
		const postRestartRequests = ctx.mockAPI.getRequestCount();
		expect(postRestartRequests).toBeGreaterThan(2);
	}, 30000);

	test("Restart N: bg await during restart — no duplicate tool_result", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Scenario: bash → backgrounded → bg await → daemon restart while await is pending.
		// Bug: stopAgent's writeOrphanedToolResults races with the provider loop's
		// tool_result emission (cleanup kills bg → completionPromise resolves → provider
		// loop emits real tool_result, while writeOrphanedToolResults writes synthetic one).
		// Fix: don't write orphans during stopAgent — defer to restart.
		const instruction = JSON.stringify({
			turns: [
				{
					// Turn 1: bash with short foreground timeout → gets backgrounded
					blocks: [
						{ type: "text", text: "Starting bg build." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "sleep 30", foreground_timeout: 500 },
						},
					],
				},
				{
					// Turn 2: bg await on the backgrounded process
					assert: [
						{
							block: 0,
							type: "tool_result",
							contains: "Background ID",
							capture: {
								bgId: "regex:Background ID: (bg-[A-Z0-9]+)",
							},
						},
					],
					blocks: [
						{ type: "text", text: "Awaiting bg process." },
						{
							type: "tool_use",
							name: "mcp__mxd__background",
							input: { action: "await", id: "$bgId" },
						},
					],
				},
				{
					// Turn 3: after restart, agent sees interrupted result → done
					blocks: [
						{ type: "text", text: "Resumed after bg await crash." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: {
								status: "passed",
								summary: "bg await restart survived",
							},
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		// Wait for turn 2 to start (bg await is blocking)
		const start = Date.now();
		while (ctx.mockAPI.getRequestCount() < 2 && Date.now() - start < 10000) {
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(ctx.mockAPI.getRequestCount()).toBe(2);
		// Let bg await start executing
		await new Promise((r) => setTimeout(r, 500));

		const rootNodeId = await getRootNodeId(ctx);

		// Verify bg was started (tool_result with backgroundId)
		const preEvents = await readSessionEvents(ctx, rootNodeId);
		expect(
			preEvents.some((e) => e.type === "tool_result" && e.backgroundId),
		).toBe(true);

		// Verify bg await tool_call exists but has no tool_result yet
		const bgAwaitCalls = preEvents.filter(
			(e) =>
				e.type === "tool_call" &&
				e.tool === "mcp__mxd__background" &&
				(e.input as { action?: string }).action === "await",
		);
		expect(bgAwaitCalls.length).toBe(1);
		const bgAwaitCallId = (bgAwaitCalls[0] as { toolCallId: string })
			.toolCallId;
		const bgAwaitResults = preEvents.filter(
			(e) => e.type === "tool_result" && e.toolCallId === bgAwaitCallId,
		);
		expect(bgAwaitResults.length).toBe(0); // no result yet — still awaiting

		const preRestartRequests = ctx.mockAPI.getRequestCount();

		// === CRASH while bg await is pending ===
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 200));

		// KEY CHECK: after shutdown, verify NO duplicate tool_results in JSONL
		const postShutdownEvents = await readSessionEvents(ctx, rootNodeId);
		const toolResultsByCallId = new Map<string, number>();
		for (const e of postShutdownEvents) {
			if (e.type === "tool_result") {
				const count = toolResultsByCallId.get(e.toolCallId) ?? 0;
				toolResultsByCallId.set(e.toolCallId, count + 1);
			}
		}
		for (const [callId, count] of toolResultsByCallId) {
			if (count > 1) {
				const tc = postShutdownEvents.find(
					(e) => e.type === "tool_call" && e.toolCallId === callId,
				);
				const toolName = tc && tc.type === "tool_call" ? tc.tool : "unknown";
				throw new Error(
					`Duplicate tool_result for ${callId} (${toolName}): found ${count}`,
				);
			}
		}

		// === RESTART ===
		ctx.app = await recreateApp(ctx);
		await ctx.app.autoResumeProjects();

		// After restart: orphan detection should have written exactly ONE tool_result
		// for the bg await (the one from restart, not from stopAgent)
		const postRestartEvents = await readSessionEvents(ctx, rootNodeId);
		const bgAwaitResultsPost = postRestartEvents.filter(
			(e) => e.type === "tool_result" && e.toolCallId === bgAwaitCallId,
		);
		expect(bgAwaitResultsPost.length).toBe(1);

		// Send message to wake agent
		const msgResp = await sendMessage(ctx, "Continue after bg await crash.");
		expect(msgResp.status).toBe(200);

		const status = await waitForDone(ctx);
		expect(status).toBe("passed");

		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThan(preRestartRequests);
	}, 30000);
});

// ── Auto-recovery from API 400 tests ──

describe("Integration: auto-recovery from API 400", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("400 crashes the agent — repair fixes JSONL on next launch", async () => {
		ctx = await setupTestContext();

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Working." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo OK" },
						},
					],
				},
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "done" },
						},
					],
				},
			],
		});

		// Inject 400 on 2nd call
		ctx.mockAPI.injectError({
			onRequest: 2,
			error: "invalid_request_error",
			count: 1,
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		// Agent should crash (no recovery). Wait a bit and check status.
		await new Promise((r) => setTimeout(r, 2000));

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNode = tracker.get(tracker.rootNodeId) as TaskNode;
		// Agent stays in_progress (it was interrupted, not done)
		expect(rootNode.status).toBe("in_progress");
		// Should NOT have reached done
		expect(rootNode.status).not.toBe("passed");
		// Only 2 API calls (1 success + 1 failed, no retry)
		expect(ctx.mockAPI.getRequestCount()).toBe(2);
	}, 10000);

	test("TDD: poison mid-JSONL cleaned by repair on restart", async () => {
		// This test verifies that JSONL repair removes duplicate tool_results.
		// 1. Agent runs successfully (bash + done)
		// 2. Inject duplicate tool_result into JSONL (poison)
		// 3. Restart → repair fires, removes poison
		// 4. Agent resumes and calls done — proving the JSONL is clean
		ctx = await setupTestContext();

		// Turn 1: bash echo
		// Turn 2: done
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Working." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo OK" },
						},
					],
				},
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "phase 1" },
						},
					],
				},
			],
		});
		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);
		const status1 = await waitForDone(ctx, 10000);
		expect(status1).toBe("passed");

		// Inject poison — duplicate tool_result for the bash tool_call
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNodeId = tracker.rootNodeId;

		// Shutdown first to flush all JSONL writes
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 200));

		const events1 = await readSessionEvents(ctx, rootNodeId);
		const bashToolCall = events1.find(
			(e) => e.type === "tool_call" && e.tool === "mcp__mxd__bash",
		);
		expect(bashToolCall).toBeDefined();
		const bashCallId = (bashToolCall as { toolCallId: string }).toolCallId;

		// Verify bash tool_call has exactly 1 result before poisoning
		const bashResults = events1.filter(
			(e) => e.type === "tool_result" && e.toolCallId === bashCallId,
		);
		expect(bashResults.length).toBe(1);

		// Inject the poison
		const store = new EventStore(join(ctx.dataDir, "sessions", ctx.projectId));
		await store.append(rootNodeId, {
			type: "tool_result" as const,
			tool: "mcp__mxd__bash",
			toolCallId: bashCallId,
			content: "DUPLICATE POISON",
			isError: true,
			taskId: rootNodeId,
			ts: Date.now(),
		} as Event);
		await store.flushSession(rootNodeId);

		// Verify poison is in JSONL
		const poisonedEvents = await readSessionEvents(ctx, rootNodeId);
		const poisonedResults = poisonedEvents.filter(
			(e) => e.type === "tool_result" && e.toolCallId === bashCallId,
		);
		expect(poisonedResults.length).toBe(2); // original + duplicate

		// Restart — repair should clean the poison
		ctx.mockAPI.reset();
		ctx.app = await recreateApp(ctx);

		// Wake instruction: just call done
		const wakeInstruction = JSON.stringify({
			blocks: [
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "clean after repair" },
				},
			],
		});
		const msgResp = await sendMessage(ctx, wakeInstruction);
		expect(msgResp.status).toBe(200);

		// Agent should be able to call done — proving the JSONL is clean
		const status2 = await waitForDone(ctx, 10000);
		expect(status2).toBe("passed");

		// Verify: no duplicate tool_results in final JSONL
		const finalEvents = await readSessionEvents(ctx, rootNodeId);
		const toolResultsByCallId = new Map<string, number>();
		for (const e of finalEvents) {
			if (e.type === "tool_result") {
				const count = toolResultsByCallId.get(e.toolCallId) ?? 0;
				toolResultsByCallId.set(e.toolCallId, count + 1);
			}
		}
		for (const [callId, count] of toolResultsByCallId) {
			// Each tool_call should have at most 1 result
			// (repair may have replaced duplicates with interrupted results)
			if (count > 1) {
				throw new Error(
					`Duplicate tool_result for ${callId}: found ${count}. Poison not cleaned!`,
				);
			}
		}
	}, 20000);
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
							name: "mcp__mxd__bash",
							input: { command: "echo yield_bash_test" },
						},
						{
							type: "tool_use",
							name: "mcp__mxd__yield",
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
						{
							block: 1,
							type: "tool_result",
							isError: false,
							contains: "yield() ignored",
						},
					],
					blocks: [
						{ type: "text", text: "Both tools handled." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
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
							name: "mcp__mxd__yield",
							input: {},
						},
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo reverse_order_test" },
						},
					],
				},
				{
					assert: [
						{ length: 2 },
						{
							block: 0,
							type: "tool_result",
							isError: false,
							contains: "yield() ignored",
						},
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
							name: "mcp__mxd__done",
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
							name: "mcp__mxd__bash",
							input: { command: "echo done_bash_test" },
						},
						{
							type: "tool_use",
							name: "mcp__mxd__done",
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
							name: "mcp__mxd__done",
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
		// done+bash conflict MUST go through 2 turns:
		// Turn 1: bash executes + done returns error → agent continues
		// Turn 2: agent calls done properly
		// Without the done error guard, done() executes in turn 1 and the mock
		// never gets turn 2 — verify the mock processed both turns.
		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThanOrEqual(2);
	}, 20000);

	test("Scenario: concurrent background bash commands get unique output files", async () => {
		ctx = await setupTestContext();

		// Two bash commands backgrounded in same turn (Promise.all).
		// Bug: they share the same output file path → output corruption.
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo OUTPUT_A", run_in_background: true },
						},
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo OUTPUT_B", run_in_background: true },
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							contains: "Background ID:",
							isError: false,
						},
						{
							block: 1,
							type: "tool_result",
							contains: "Background ID:",
							isError: false,
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "bg commands done" },
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		const status = await waitForDone(ctx);
		expect(status).toBe("passed");

		// Verify: the two background bash results have DIFFERENT output file paths
		const req1 = ctx.mockAPI.getRequestHistory()[1];
		expect(req1).toBeDefined();
		const messages = req1?.messages ?? [];
		const lastMsg = messages[messages.length - 1];
		expect(lastMsg?.role).toBe("user");
		const toolResults = lastMsg ? getToolResults(lastMsg) : [];
		expect(toolResults.length).toBe(2);

		// Extract output file paths from the tool results
		const paths0 = extractOutputPaths(
			typeof toolResults[0]?.content === "string" ? toolResults[0].content : "",
		);
		const paths1 = extractOutputPaths(
			typeof toolResults[1]?.content === "string" ? toolResults[1].content : "",
		);

		// Both should have paths
		expect(paths0.stdout).toBeTruthy();
		expect(paths0.stderr).toBeTruthy();
		expect(paths1.stdout).toBeTruthy();
		expect(paths1.stderr).toBeTruthy();

		// Paths must be DIFFERENT between the two commands
		expect(paths0.stdout).not.toBe(paths1.stdout);
		expect(paths0.stderr).not.toBe(paths1.stderr);

		// Also verify: bg IDs are different
		const bgId0 = extractBgId(
			typeof toolResults[0]?.content === "string" ? toolResults[0].content : "",
		);
		const bgId1 = extractBgId(
			typeof toolResults[1]?.content === "string" ? toolResults[1].content : "",
		);
		expect(bgId0).toBeTruthy();
		expect(bgId1).toBeTruthy();
		expect(bgId0).not.toBe(bgId1);

		// Wait a bit for bg processes to complete and check JSONL for bg_complete events
		await new Promise((r) => setTimeout(r, 500));
		const rootNodeId = await getRootNodeId(ctx);
		const events = await readSessionEvents(ctx, rootNodeId);

		// Find background_complete message events
		const bgCompleteEvents = events.filter(
			(e): e is Extract<typeof e, { type: "message" }> =>
				e.type === "message" && e.body?.source === "background_complete",
		);

		// Both bg processes should have completed
		expect(bgCompleteEvents.length).toBeGreaterThanOrEqual(2);

		// Verify outputs are correct and not mixed
		const bgOutputs = bgCompleteEvents.map((e) => {
			const body = e.body as { stdout?: string };
			return body.stdout ?? "";
		});
		const hasOutputA = bgOutputs.some((o: string) => o.includes("OUTPUT_A"));
		const hasOutputB = bgOutputs.some((o: string) => o.includes("OUTPUT_B"));
		expect(hasOutputA).toBe(true);
		expect(hasOutputB).toBe(true);
	}, 20000);
});

// ── Helpers for concurrent background test ──

/** Extract stdout and stderr file paths from a background bash tool result. */
function extractOutputPaths(content: string): {
	stdout: string | null;
	stderr: string | null;
} {
	const match = content.match(/Output files: ([^,]+), (\S+)/);
	return {
		stdout: match?.[1] ?? null,
		stderr: match?.[2] ?? null,
	};
}

/** Extract background ID from a background bash tool result. */
function extractBgId(content: string): string | null {
	const match = content.match(/Background ID: (bg-\S+)/);
	return match?.[1] ?? null;
}

// ── Yield wakeup assertion tests ──

describe("Integration: yield wakeup assertions", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("Scenario: explicit yield → user message → assert yield resume structure", async () => {
		ctx = await setupTestContext();

		// Turn 1: agent yields
		// Turn 2 (after wake): assert structure — block 0 is yield tool_result with ## Pending,
		// block 1 is text with the user message
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Waiting for input." },
						{
							type: "tool_use",
							name: "mcp__mxd__yield",
							input: {},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							contains: "## Pending",
							isError: false,
						},
						{
							block: 1,
							type: "text",
							contains: "WAKE_MESSAGE_CONTENT",
						},
					],
					blocks: [
						{ type: "text", text: "Woke up." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: {
								status: "passed",
								summary: "yield resume structure verified",
							},
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		await waitForIdle(ctx);

		// Send message to wake agent
		const msgResp = await sendMessage(ctx, "WAKE_MESSAGE_CONTENT");
		expect(msgResp.status).toBe(200);

		const status = await waitForDone(ctx);
		expect(status).toBe("passed");

		// If we got here, the assert DSL validated that:
		// - block 0 = tool_result containing "## Pending"
		// - block 1 = text containing "WAKE_MESSAGE_CONTENT"
		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThanOrEqual(2);
	}, 20000);

	test("Scenario: implicit yield (end_turn) → message inject → assert text block", async () => {
		ctx = await setupTestContext();

		// Agent returns text-only → implicit yield (end_turn)
		// When message arrives, it becomes a new user message (not tool_result, since no tool was used)
		const instruction = JSON.stringify({
			blocks: [{ type: "text", text: "Nothing to do right now." }],
			stop_reason: "end_turn",
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		await waitForIdle(ctx);

		// The wake message is turn 2 — agent receives it as a user message (text blocks)
		// After the default response from mock, the third turn will need instruction
		// But since mock has no queued turns and no instruction found, it returns "Acknowledged."
		// which enters implicit yield again. Let's set up: wake with a message that contains
		// a new instruction for the next turn.
		const wakeInstruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "All done." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: {
						status: "passed",
						summary: "implicit yield wake verified",
					},
				},
			],
		});
		const msgResp = await sendMessage(ctx, wakeInstruction);
		expect(msgResp.status).toBe(200);

		const status = await waitForDone(ctx);
		expect(status).toBe("passed");

		// Verify: the second API call should contain the user message as a text block
		// For implicit yield, the message goes through buildImplicitYieldMessage
		// which creates a user message with text blocks (one per queue message)
		const req2 = ctx.mockAPI.getRequestHistory()[1];
		expect(req2).toBeDefined();
		const lastMsg = req2?.messages[req2?.messages.length - 1];
		expect(lastMsg?.role).toBe("user");

		// The content should be text blocks (not tool_result, since no tool was involved)
		if (Array.isArray(lastMsg?.content)) {
			const textBlocks = (
				lastMsg?.content as Array<{ type: string; text?: string }>
			).filter((b) => b.type === "text");
			expect(textBlocks.length).toBeGreaterThanOrEqual(1);
			// At least one text block should contain our instruction
			const allText = textBlocks.map((b) => b.text ?? "").join(" ");
			expect(allText).toContain(wakeInstruction);
		} else {
			// String content — should contain our instruction
			expect(lastMsg?.content as string).toContain(wakeInstruction);
		}

		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThanOrEqual(2);
	}, 20000);

	test("Scenario: yield → two messages → assert both present in order", async () => {
		ctx = await setupTestContext();

		// Turn 1: agent yields
		// Turn 2 (after wake): assert both messages are present as text blocks
		// Turn 3+ (fallback): if only one message arrived in the yield resume,
		//   the second arrives during/after the next API call
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Yielding now." },
						{
							type: "tool_use",
							name: "mcp__mxd__yield",
							input: {},
						},
					],
				},
				{
					// After first yield wake: at minimum block 0 is yield tool_result,
					// block 1+ has at least one message. We check for FIRST_MSG here.
					assert: [
						{
							block: 0,
							type: "tool_result",
							contains: "## Pending",
							isError: false,
						},
						{ block: 1, type: "text", contains: "FIRST_MSG_ALPHA" },
					],
					blocks: [
						{ type: "text", text: "Got first message, yielding for second." },
						{
							type: "tool_use",
							name: "mcp__mxd__yield",
							input: {},
						},
					],
				},
				{
					// Second yield wake: should have the second message
					assert: [
						{
							block: 0,
							type: "tool_result",
							contains: "## Pending",
						},
						{ block: 1, type: "text", contains: "SECOND_MSG_BETA" },
					],
					blocks: [
						{ type: "text", text: "Got both messages." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: {
								status: "passed",
								summary: "multiple yield messages verified",
							},
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		await waitForIdle(ctx);

		// Send first message to wake from yield
		const msg1Resp = await sendMessage(ctx, "FIRST_MSG_ALPHA");
		expect(msg1Resp.status).toBe(200);

		// Wait for agent to re-enter yield after processing first message
		await waitForIdle(ctx);

		// Send second message to wake from second yield
		const msg2Resp = await sendMessage(ctx, "SECOND_MSG_BETA");
		expect(msg2Resp.status).toBe(200);

		const status = await waitForDone(ctx);
		expect(status).toBe("passed");

		// The assert DSL validated messages in order across two yield cycles
		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThanOrEqual(3);
	}, 20000);

	test("Scenario: yield → message with task_message format → assert XML content", async () => {
		ctx = await setupTestContext();

		// This test verifies that yield resume correctly formats different message types.
		// We send a regular user message (which arrives as source: "user")
		// and check that it's in the yield resume content.
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Yielding." },
						{
							type: "tool_use",
							name: "mcp__mxd__yield",
							input: {},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							contains: "## Pending",
							isError: false,
						},
						{
							block: 1,
							type: "text",
							// User messages are not wrapped in XML — they're raw content
							contains: "PLAIN_USER_MESSAGE",
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: {
								status: "passed",
								summary: "message format verified",
							},
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		await waitForIdle(ctx);

		const msgResp = await sendMessage(ctx, "PLAIN_USER_MESSAGE");
		expect(msgResp.status).toBe(200);

		const status = await waitForDone(ctx);
		expect(status).toBe("passed");
	}, 20000);
});

// ── Parent-child lifecycle tests ──

describe("Integration: parent-child lifecycle", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("Scenario: parent creates child → child does work → parent receives task_complete", async () => {
		ctx = await setupTestContext();

		// Child instruction: bash echo + done
		const childInstruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Child working." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo CHILD_OUTPUT_123" },
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							contains: "CHILD_OUTPUT_123",
							isError: false,
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "child completed work" },
						},
					],
				},
			],
		});

		// Parent instruction: create_task → capture $childId → send_message → yield → done
		const parentInstruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Creating child task." },
						{
							type: "tool_use",
							name: "mcp__mxd__create_task",
							input: {
								title: "Test Child Task",
								description: "A child task for testing",
							},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
							// create_task returns JSON.stringify(node) — capture the "id" field
							capture: {
								childId: 'regex:"id":\\s*"([A-Z0-9]+)"',
							},
						},
					],
					blocks: [
						{ type: "text", text: "Sending message to child." },
						{
							type: "tool_use",
							name: "mcp__mxd__send_message",
							input: {
								taskId: "$childId",
								title: "Start work",
								message: childInstruction,
							},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
						},
					],
					blocks: [
						{ type: "text", text: "Waiting for child." },
						{
							type: "tool_use",
							name: "mcp__mxd__yield",
							input: {},
						},
					],
				},
				{
					// After yield: should have yield tool_result + task_complete from child
					assert: [
						{
							block: 0,
							type: "tool_result",
							contains: "## Pending",
							isError: false,
						},
						{
							block: 1,
							type: "text",
							contains: "task_complete",
						},
						{
							block: 1,
							type: "text",
							contains: "passed",
						},
					],
					blocks: [
						{ type: "text", text: "Child completed. Finishing." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: {
								status: "passed",
								summary: "parent-child lifecycle complete",
							},
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, parentInstruction);
		expect(resp.status).toBe(200);

		// Wait for parent to complete (child should complete first, parent wakes from yield)
		const status = await waitForDone(ctx, 30000);
		expect(status).toBe("passed");

		// Verify the child task was created and completed
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNode = tracker.get(tracker.rootNodeId);
		expect(rootNode?.children?.length).toBeGreaterThanOrEqual(1);

		const childId = rootNode?.children?.[0] as string;
		const childNode = tracker.get(childId);
		expect(childNode?.status).toBe("passed");
		expect(childNode?.title).toBe("Test Child Task");

		// Verify child JSONL has events
		const childEvents = await readSessionEvents(ctx, childId);
		const childToolCalls = childEvents.filter((e) => e.type === "tool_call");
		expect(childToolCalls.length).toBeGreaterThanOrEqual(1);
	}, 45000);

	test("Scenario: child fails → parent receives failed task_complete", async () => {
		ctx = await setupTestContext();

		// Child instruction: calls done("failed")
		const childInstruction = JSON.stringify({
			blocks: [
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "failed", summary: "child encountered an error" },
				},
			],
		});

		// Parent: create → send_message → yield → assert failed task_complete → done
		const parentInstruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__create_task",
							input: {
								title: "Failing Child",
								description: "A child task that will fail",
							},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
							capture: {
								childId: 'regex:"id":\\s*"([A-Z0-9]+)"',
							},
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__send_message",
							input: {
								taskId: "$childId",
								title: "Start",
								message: childInstruction,
							},
						},
					],
				},
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__yield",
							input: {},
						},
					],
				},
				{
					// Yield wake: should have task_complete with status="failed"
					assert: [
						{
							block: 0,
							type: "tool_result",
							contains: "## Pending",
						},
						{
							block: 1,
							type: "text",
							contains: "task_complete",
						},
						{
							block: 1,
							type: "text",
							contains: "failed",
						},
					],
					blocks: [
						{ type: "text", text: "Child failed as expected." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: {
								status: "passed",
								summary: "handled child failure",
							},
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, parentInstruction);
		expect(resp.status).toBe(200);

		const status = await waitForDone(ctx, 30000);
		expect(status).toBe("passed");

		// Verify child is in failed state
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNode = tracker.get(tracker.rootNodeId);
		const childId = rootNode?.children?.[0] as string;
		const childNode = tracker.get(childId);
		expect(childNode?.status).toBe("failed");
	}, 45000);
});

// ── Lifecycle: exitReason + interrupt + yield bypass tests ──

describe("Integration: lifecycle exitReason and interrupt behavior", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("LC1: done(passed) → status=passed, exitReason=done_passed", async () => {
		ctx = await setupTestContext();

		const instruction = JSON.stringify({
			blocks: [
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "all good" },
				},
			],
		});

		await startAgent(ctx, instruction);
		const status = await waitForDone(ctx);
		expect(status).toBe("passed");

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNode = tracker.get(tracker.rootNodeId);
		expect(rootNode?.status).toBe("passed");
	});

	test("LC2: done(failed) → status=failed, exitReason=done_failed", async () => {
		ctx = await setupTestContext();

		const instruction = JSON.stringify({
			blocks: [
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "failed", summary: "something went wrong" },
				},
			],
		});

		await startAgent(ctx, instruction);
		const status = await waitForDone(ctx);
		expect(status).toBe("failed");
	});

	test("LC3: interrupted (crash) → status stays in_progress, no task_complete", async () => {
		ctx = await setupTestContext();

		// Agent starts a long bash command, then we crash
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "sleep 30" },
						},
					],
				},
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "recovered" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		// Wait a bit for bash to start
		await new Promise((r) => setTimeout(r, 200));

		// Crash
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		// Check status — should be in_progress (not passed, not failed)
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNode = tracker.get(tracker.rootNodeId);
		expect(rootNode?.status).toBe("in_progress");
	});

	test("LC4: interrupted (stop) → status stays in_progress", async () => {
		ctx = await setupTestContext();

		// Agent yields, then we stop it
		const instruction = JSON.stringify({
			blocks: [
				{
					type: "tool_use",
					name: "mcp__mxd__yield",
					input: {},
				},
			],
		});

		await startAgent(ctx, instruction);
		await waitForIdle(ctx);

		// Stop the agent
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		// Status should still be in_progress
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNode = tracker.get(tracker.rootNodeId);
		expect(rootNode?.status).toBe("in_progress");
	});

	test("LC5: stop root with children → all stay in_progress", async () => {
		ctx = await setupTestContext();

		// Parent creates a child and yields
		const childInstruction = JSON.stringify({
			blocks: [
				{
					type: "tool_use",
					name: "mcp__mxd__bash",
					input: { command: "sleep 30" },
				},
			],
		});

		const parentInstruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__create_task",
							input: {
								title: "Long Running Child",
								description: "child that runs a long time",
							},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
							capture: { childId: 'regex:"id":\\s*"([A-Z0-9]+)"' },
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__send_message",
							input: {
								taskId: "$childId",
								title: "Start",
								message: childInstruction,
							},
						},
					],
				},
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__yield",
							input: {},
						},
					],
				},
			],
		});

		await startAgent(ctx, parentInstruction);
		await waitForIdle(ctx);
		// Give child time to launch
		await new Promise((r) => setTimeout(r, 500));

		// Stop everything
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		// Both root and child should be in_progress (not failed)
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNode = tracker.get(tracker.rootNodeId);
		expect(rootNode?.status).toBe("in_progress");

		if (rootNode?.children && rootNode.children.length > 0) {
			const childId = rootNode.children[0] as string;
			const childNode = tracker.get(childId);
			expect(childNode?.status).toBe("in_progress");
		}
	}, 30000);
});

describe("Integration: yield bypass on restart", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("LC6: yield → restart → bypass → message → done (zero wasted API calls)", async () => {
		ctx = await setupTestContext();

		// Turn 1: agent yields
		const instruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Going idle." },
				{
					type: "tool_use",
					name: "mcp__mxd__yield",
					input: {},
				},
			],
		});

		await startAgent(ctx, instruction);
		await waitForIdle(ctx);
		const preRestartRequests = ctx.mockAPI.getRequestCount();
		expect(preRestartRequests).toBe(1);

		// Crash
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		// Restart
		ctx.app = await recreateApp(ctx);
		await ctx.app.autoResumeProjects();

		// Yielding root should have been launched but NO new API calls yet
		// (provider loop bypasses to queue.wait via pendingYieldToolCall)
		// Give it a moment to launch
		await new Promise((r) => setTimeout(r, 200));
		expect(ctx.mockAPI.getRequestCount()).toBe(preRestartRequests);

		// Send message to wake agent
		const wakeInstruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Waking up after restart." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "survived restart" },
				},
			],
		});
		await sendMessage(ctx, wakeInstruction);

		const status = await waitForDone(ctx);
		expect(status).toBe("passed");
		// Now should have made exactly 1 new API call (the one after yield resolved)
		expect(ctx.mockAPI.getRequestCount()).toBe(preRestartRequests + 1);
	}, 30000);

	test("LC7: interrupted agent resumes normally after restart", async () => {
		ctx = await setupTestContext();

		// Agent runs a bash command — we crash during it
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Running bash." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "sleep 30" },
						},
					],
				},
				{
					// After restart: get interrupted bash result, call done
					blocks: [
						{ type: "text", text: "Bash interrupted, done." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "handled interruption" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		await new Promise((r) => setTimeout(r, 300));

		const preRestartRequests = ctx.mockAPI.getRequestCount();
		expect(preRestartRequests).toBe(1);

		// Crash
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		// Restart
		ctx.app = await recreateApp(ctx);
		await ctx.app.autoResumeProjects();

		// Interrupted root should resume with an API call
		const status = await waitForDone(ctx);
		expect(status).toBe("passed");
		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThan(preRestartRequests);
	}, 30000);

	test("LC8: end_turn enters implicit yield, message wakes agent", async () => {
		ctx = await setupTestContext();

		// First turn: API returns end_turn (no tool calls).
		// With the new behavior, this enters implicit yield instead of exiting.
		// Second turn: user sends message, agent wakes and calls done.
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [{ type: "text", text: "Nothing to do, ending turn." }],
					stop_reason: "end_turn",
				},
				{
					blocks: [
						{ type: "text", text: "Got a message, finishing." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "woke from end_turn" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);

		// Wait for agent to enter implicit yield (idle state)
		await waitForIdle(ctx);
		expect(ctx.mockAPI.getRequestCount()).toBe(1);

		// Agent should still be in_progress (not passed — end_turn is no longer implicit done)
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNode = tracker.get(tracker.rootNodeId);
		expect(rootNode?.status).toBe("in_progress");

		// Send message to wake from implicit yield
		const wakeInstruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Continue please." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "continued after end_turn" },
				},
			],
		});
		await sendMessage(ctx, wakeInstruction);

		const status = await waitForDone(ctx);
		expect(status).toBe("passed");
	}, 15000);
});

describe("Integration: autoResume with mixed agent states", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("LC9: restart with yielding root — zero-cost bypass resume", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const instruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Yielding." },
				{
					type: "tool_use",
					name: "mcp__mxd__yield",
					input: {},
				},
			],
		});

		await startAgent(ctx, instruction);
		await waitForIdle(ctx);
		const preRestart = ctx.mockAPI.getRequestCount();

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		ctx.app = await recreateApp(ctx);
		await ctx.app.autoResumeProjects();
		await new Promise((r) => setTimeout(r, 300));

		// No new API calls — yielding root entered bypass
		expect(ctx.mockAPI.getRequestCount()).toBe(preRestart);

		// But root should be launchable — send a message to verify
		const wakeInstruction = JSON.stringify({
			blocks: [
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "after restart" },
				},
			],
		});
		await sendMessage(ctx, wakeInstruction);
		const status = await waitForDone(ctx);
		expect(status).toBe("passed");
		// Prefix validation passed (mock would throw on mismatch)
	}, 30000);
});

describe("Integration: implicit yield restart", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("LC10: implicit yield (end_turn) → restart → bypass → message → done (zero wasted API calls)", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Turn 1: end_turn (no tool calls) → enters implicit yield
		// Turn 2 (after restart + message): agent wakes, calls done
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [{ type: "text", text: "Nothing to do, ending turn." }],
					stop_reason: "end_turn",
				},
				{
					blocks: [
						{ type: "text", text: "Got a message after restart." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: {
								status: "passed",
								summary: "survived implicit yield restart",
							},
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		await waitForIdle(ctx);
		const preRestartRequests = ctx.mockAPI.getRequestCount();
		expect(preRestartRequests).toBe(1);

		// Crash
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		// Restart
		ctx.app = await recreateApp(ctx);
		await ctx.app.autoResumeProjects();

		// Implicit yield root should have been launched but NO new API calls yet
		// (provider loop detects pendingImplicitYieldResume → bypass to handleImplicitYield)
		await new Promise((r) => setTimeout(r, 200));
		expect(ctx.mockAPI.getRequestCount()).toBe(preRestartRequests);

		// Send message to wake agent
		const wakeInstruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Wake up from implicit yield." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "implicit yield restart ok" },
				},
			],
		});
		await sendMessage(ctx, wakeInstruction);

		const status = await waitForDone(ctx);
		expect(status).toBe("passed");
		// Should have made exactly 1 new API call (the one after implicit yield resolved)
		expect(ctx.mockAPI.getRequestCount()).toBe(preRestartRequests + 1);
	}, 30000);
});

// ── Background process lifecycle tests ──

describe("Integration: background process lifecycle", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("BG1: foreground timeout triggers auto-background", async () => {
		ctx = await setupTestContext();

		// bash with foreground_timeout=500 and a command that takes longer
		// → should be moved to background automatically
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: {
								command: "sleep 2 && echo timeout_done",
								foreground_timeout: 500,
							},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							contains: "Background ID:",
							isError: false,
						},
						{
							block: 0,
							type: "tool_result",
							contains: "moved to background",
							isError: false,
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: {
								status: "passed",
								summary: "foreground timeout triggered background",
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

	test("BG2: background await", async () => {
		ctx = await setupTestContext();

		// Turn 1: run_in_background with echo → returns bg ID immediately
		// Turn 2: await with captured bg ID
		// Turn 3: assert await result confirms completion
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: {
								command: "echo bg_await_output",
								run_in_background: true,
							},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							contains: "Background ID:",
							isError: false,
							capture: {
								bgId: "regex:Background ID: (bg-\\S+)",
							},
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__background",
							input: { action: "await", id: "$bgId" },
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							contains: "completed",
							isError: false,
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "bg await worked" },
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

	test("BG3: background list + status", async () => {
		ctx = await setupTestContext();

		// Turn 1: start two bg processes (sleep to keep them running long enough to list)
		// Turn 2: list → assert both commands appear
		// Turn 3: status on first → assert command info
		// Note: $vars can't be used in assert `contains` — only in block inputs.
		// So we check for command substrings (which are unique per bg process).
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: {
								command: "sleep 5 && echo bg_list_a",
								run_in_background: true,
							},
						},
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: {
								command: "sleep 5 && echo bg_list_b",
								run_in_background: true,
							},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							contains: "Background ID:",
							capture: {
								bgId1: "regex:Background ID: (bg-\\S+)",
							},
						},
						{
							block: 1,
							type: "tool_result",
							contains: "Background ID:",
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__background",
							input: { action: "list" },
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							// Both commands should appear in list output
							contains: "bg_list_a",
							isError: false,
						},
						{
							block: 0,
							type: "tool_result",
							contains: "bg_list_b",
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__background",
							input: { action: "status", id: "$bgId1" },
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							contains: "sleep 5",
							isError: false,
						},
						{
							block: 0,
							type: "tool_result",
							contains: "bg_list_a",
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "bg list + status ok" },
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

	test("BG4: background kill", async () => {
		ctx = await setupTestContext();

		// Turn 1: start bg sleep 30
		// Turn 2: kill it with captured bg ID
		// Turn 3: assert kill confirmation
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: {
								command: "sleep 30",
								run_in_background: true,
							},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							contains: "Background ID:",
							capture: {
								bgId: "regex:Background ID: (bg-\\S+)",
							},
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__background",
							input: { action: "kill", id: "$bgId" },
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							contains: "killed",
							isError: false,
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "bg kill ok" },
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

	test("BG5: bg completes during foreground tool execution", async () => {
		ctx = await setupTestContext();

		// Turn 1: start bg (fast: sleep 1) + foreground (slow: sleep 3)
		// bg_complete arrives while foreground is running → delivered as queue message
		// Turn 2: should have foreground tool_result + bg_complete text block
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: {
								command: "sleep 1 && echo BG_DONE_FIVE",
								run_in_background: true,
							},
						},
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "sleep 3 && echo FG_DONE_FIVE" },
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							contains: "Background ID:",
							isError: false,
						},
						{
							block: 1,
							type: "tool_result",
							contains: "FG_DONE_FIVE",
							isError: false,
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: {
								status: "passed",
								summary: "bg complete during fg tool",
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

		// Verify bg_complete event was written to JSONL
		const rootNodeId = await getRootNodeId(ctx);
		const events = await readSessionEvents(ctx, rootNodeId);
		const bgCompleteEvents = events.filter(
			(e) =>
				e.type === "message" &&
				"body" in e &&
				e.body &&
				typeof e.body === "object" &&
				"source" in e.body &&
				e.body.source === "background_complete",
		);
		expect(bgCompleteEvents.length).toBeGreaterThanOrEqual(1);
	}, 20000);

	test("BG6: multiple bg processes complete during yield", async () => {
		ctx = await setupTestContext();

		// Start 2 bg processes (short sleeps), then yield.
		// bg_complete messages wake yield and deliver notifications.
		// Use sequential yield-wake cycles per memory.md guidance.
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: {
								command: "sleep 0.3 && echo BG_SIX_A",
								run_in_background: true,
							},
						},
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: {
								command: "sleep 0.6 && echo BG_SIX_B",
								run_in_background: true,
							},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							contains: "Background ID:",
						},
						{
							block: 1,
							type: "tool_result",
							contains: "Background ID:",
						},
					],
					blocks: [
						{ type: "text", text: "Yielding to wait for bg completions." },
						{
							type: "tool_use",
							name: "mcp__mxd__yield",
							input: {},
						},
					],
				},
				{
					// First yield wake: should have at least one bg_complete
					assert: [
						{
							block: 0,
							type: "tool_result",
							contains: "## Pending",
						},
						{
							block: 1,
							type: "text",
							contains: "background_complete",
						},
					],
					blocks: [
						{ type: "text", text: "Got first bg_complete, yielding again." },
						{
							type: "tool_use",
							name: "mcp__mxd__yield",
							input: {},
						},
					],
				},
				{
					// Second yield wake: second bg_complete
					assert: [
						{
							block: 0,
							type: "tool_result",
							contains: "## Pending",
						},
						{
							block: 1,
							type: "text",
							contains: "background_complete",
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: {
								status: "passed",
								summary: "multiple bg completions received via yield",
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

		// Verify both bg_complete events in JSONL
		const rootNodeId = await getRootNodeId(ctx);
		const events = await readSessionEvents(ctx, rootNodeId);
		const bgCompleteEvents = events.filter(
			(e) =>
				e.type === "message" &&
				"body" in e &&
				e.body &&
				typeof e.body === "object" &&
				"source" in e.body &&
				e.body.source === "background_complete",
		);
		expect(bgCompleteEvents.length).toBeGreaterThanOrEqual(2);
	}, 25000);

	test("BG7: REST move-to-background during foreground execution", async () => {
		ctx = await setupTestContext();

		// Turn 1: bash sleep 10 (long foreground, high timeout so it doesn't auto-background)
		// Test code: while bash is running, call REST to move it to background
		// Turn 2: agent sees tool_result with "moved to background" + bg ID → done
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: {
								command: "sleep 3 && echo REST_BG_DONE",
								foreground_timeout: 60000,
							},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							contains: "moved to background",
							isError: false,
						},
						{
							block: 0,
							type: "tool_result",
							contains: "Background ID:",
							isError: false,
						},
					],
					blocks: [
						{ type: "text", text: "Moved via REST. Waiting for completion." },
						{
							type: "tool_use",
							name: "mcp__mxd__yield",
							input: {},
						},
					],
				},
				{
					// bg_complete should arrive via yield
					assert: [
						{
							block: 0,
							type: "tool_result",
							contains: "## Pending",
						},
						{
							block: 1,
							type: "text",
							contains: "background_complete",
						},
						{
							block: 1,
							type: "text",
							contains: "REST_BG_DONE",
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: {
								status: "passed",
								summary: "REST move-to-background worked",
							},
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		// Wait for bash to start (API call made, tool executing)
		const start = Date.now();
		while (ctx.mockAPI.getRequestCount() < 1 && Date.now() - start < 5000) {
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(ctx.mockAPI.getRequestCount()).toBe(1);
		await new Promise((r) => setTimeout(r, 200));

		// Find the foreground execution ID from the session
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNodeId = tracker.rootNodeId;
		const rootNode = tracker.get(rootNodeId);
		const session = rootNode?.session;
		expect(session).toBeDefined();

		// The foreground execution map has entries like `${sessionId}:${execId}`
		const fgMap = session?.foregroundExecutions as Map<string, unknown>;
		expect(fgMap.size).toBeGreaterThanOrEqual(1);

		// Get the first (and only) foreground execution key
		const fgKey = [...fgMap.keys()][0] as string;
		// fgKey format: `${sessionId}:${execId}` — extract execId
		const execId = fgKey.split(":").slice(1).join(":");

		// Call REST endpoint to move to background
		const moveResp = await ctx.app.app.request(
			`/projects/${ctx.projectId}/background/move`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					sessionId: rootNodeId,
					execId,
				}),
			},
		);
		expect(moveResp.status).toBe(200);
		const moveBody = (await moveResp.json()) as { ok: boolean };
		expect(moveBody.ok).toBe(true);

		// Agent should now complete: tool_result with "moved to background",
		// then yield, then bg_complete arrives, then done
		const status = await waitForDone(ctx, 20000);
		expect(status).toBe("passed");
	}, 30000);
});

// ── Tree operation tests ──

describe("Integration: tree operations", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("TREE1: create_task → update_task → close_task chain", async () => {
		ctx = await setupTestContext();

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__create_task",
							input: {
								title: "Tree Test Task",
								description: "A task for tree testing",
							},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
							contains: "Tree Test Task",
							capture: {
								taskId: 'regex:"id":\\s*"([A-Z0-9]+)"',
							},
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__update_task",
							input: {
								taskId: "$taskId",
								title: "Updated Tree Task",
							},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
							contains: "Updated Tree Task",
						},
					],
					// Set status to "passed" before closing (close_task rejects pending/draft)
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__update_task",
							input: { taskId: "$taskId", status: "passed" },
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__close_task",
							input: { taskId: "$taskId" },
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: {
								status: "passed",
								summary: "tree CRUD chain complete",
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

		// Verify task was closed
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNode = tracker.get(tracker.rootNodeId);
		const childId = rootNode?.children?.[0];
		expect(childId).toBeDefined();
		const childNode = tracker.get(childId as string);
		expect(childNode?.title).toBe("Updated Tree Task");
		expect(childNode?.status).toBe("closed");
	}, 25000);

	test("TREE2: create_task + reorder_tasks", async () => {
		ctx = await setupTestContext();

		// First get the root node ID from get_tree, then create 3 tasks, then reorder
		const instruction = JSON.stringify({
			turns: [
				{
					// Get tree to capture root node ID
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__get_tree",
							input: {},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
							capture: {
								rootId: 'regex:"id":\\s*"([A-Z0-9]+)"',
							},
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__create_task",
							input: { title: "Task Alpha", description: "First" },
						},
						{
							type: "tool_use",
							name: "mcp__mxd__create_task",
							input: { title: "Task Beta", description: "Second" },
						},
						{
							type: "tool_use",
							name: "mcp__mxd__create_task",
							input: { title: "Task Gamma", description: "Third" },
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
							capture: {
								id1: 'regex:"id":\\s*"([A-Z0-9]+)"',
							},
						},
						{
							block: 1,
							type: "tool_result",
							isError: false,
							capture: {
								id2: 'regex:"id":\\s*"([A-Z0-9]+)"',
							},
						},
						{
							block: 2,
							type: "tool_result",
							isError: false,
							capture: {
								id3: 'regex:"id":\\s*"([A-Z0-9]+)"',
							},
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__reorder_tasks",
							input: {
								nodeId: "$rootId",
								children: ["$id3", "$id1", "$id2"],
							},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "reorder ok" },
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		const status = await waitForDone(ctx);
		expect(status).toBe("passed");

		// Verify reorder: children should be [id3, id1, id2]
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNode = tracker.get(tracker.rootNodeId);
		const children = rootNode?.children ?? [];
		expect(children.length).toBe(3);

		// Third task (Gamma) should now be first
		const firstChild = tracker.get(children[0] as string);
		expect(firstChild?.title).toBe("Task Gamma");
	}, 25000);

	test("TREE3: get_tree reflects changes", async () => {
		ctx = await setupTestContext();

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__create_task",
							input: {
								title: "Visible Task 42",
								description: "Should appear in tree",
							},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__get_tree",
							input: { format: "flat" },
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
							contains: "Visible Task 42",
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "tree reflects task" },
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

	test("TREE4: persistent task — create writes .mxd/tasks/<id>.json, close rejected", async () => {
		ctx = await setupTestContext();

		const instruction = JSON.stringify({
			turns: [
				{
					// Create a persistent task
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__create_task",
							input: {
								title: "Test Mutation Agent",
								description: "Run mutation tests periodically",
								color: "#a371f7",
								persistent: true,
							},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
							contains: "Test Mutation Agent",
							capture: {
								taskId: 'regex:"id":\\s*"([A-Z0-9]+)"',
							},
						},
					],
					// Try to close the persistent task — should error
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__close_task",
							input: { taskId: "$taskId" },
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: true,
							contains: "Cannot close a running task",
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: {
								status: "passed",
								summary: "persistent task lifecycle verified",
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

		// Verify .mxd/tasks/<id>.json was created in the project dir
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNode = tracker.get(tracker.rootNodeId);
		const childId = rootNode?.children?.[0];
		expect(childId).toBeDefined();

		const taskDefPath = join(
			ctx.projectDir,
			".mxd",
			"tasks",
			`${childId}.json`,
		);
		expect(existsSync(taskDefPath)).toBe(true);
		const def = JSON.parse(await Bun.file(taskDefPath).text());
		expect(def.title).toBe("Test Mutation Agent");
		expect(def.description).toBe("Run mutation tests periodically");
		expect(def.color).toBe("#a371f7");

		// Verify the task node is persistent and in_progress
		const childNode = tracker.get(childId as string);
		expect(childNode?.persistent).toBe(true);
		expect(childNode?.status).toBe("in_progress");
		expect(childNode?.title).toBe("Test Mutation Agent");

		// Verify tree.json doesn't contain title/description for persistent node
		const { readFile: readFileAsync } = await import("node:fs/promises");
		const treePath = join(ctx.dataDir, "projects", ctx.projectId, "tree.json");
		const treeData = JSON.parse(await readFileAsync(treePath, "utf-8"));
		const serializedNode = treeData.nodes.find(
			(n: { id: string }) => n.id === childId,
		);
		expect(serializedNode.persistent).toBe(true);
		expect(serializedNode.title).toBeUndefined();
		expect(serializedNode.description).toBeUndefined();
	}, 25000);

	test("TREE5: persistent task — full lifecycle: create → launch child → done → stays in_progress", async () => {
		ctx = await setupTestContext();

		// Child instruction: simple done
		const childInstruction = JSON.stringify({
			blocks: [
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "persistent child done" },
				},
			],
		});

		// Parent: create persistent task → send_message → yield → done
		// close_task is no longer valid for persistent tasks
		const parentInstruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__create_task",
							input: {
								title: "Persistent Runner",
								description: "A persistent task that runs periodically",
								persistent: true,
								color: "purple",
							},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
							contains: "Persistent Runner",
							capture: {
								childId: 'regex:"id":\\s*"([A-Z0-9]+)"',
							},
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__send_message",
							input: {
								taskId: "$childId",
								title: "Run it",
								message: childInstruction,
							},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__yield",
							input: {},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							contains: "## Pending",
							isError: false,
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: {
								status: "passed",
								summary: "persistent task lifecycle complete",
							},
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, parentInstruction);
		expect(resp.status).toBe(200);

		const status = await waitForDone(ctx, 45000);
		expect(status).toBe("passed");

		// Verify the persistent child
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNode = tracker.get(tracker.rootNodeId) as TaskNode;
		const childId = rootNode.children[0] as string;
		const childNode = tracker.get(childId) as TaskNode;

		// Status stays in_progress (persistent tasks don't change status on done)
		expect(childNode.status).toBe("in_progress");
		expect(childNode.persistent).toBe(true);
		expect(childNode.title).toBe("Persistent Runner");

		// .mxd/tasks/<id>.json exists in repo
		const taskDefPath = join(
			ctx.projectDir,
			".mxd",
			"tasks",
			`${childId}.json`,
		);
		expect(existsSync(taskDefPath)).toBe(true);

		// tree.json doesn't have title/description for the persistent node
		const { readFile: readFileAsync } = await import("node:fs/promises");
		const treePath = join(ctx.dataDir, "projects", ctx.projectId, "tree.json");
		const treeData = JSON.parse(await readFileAsync(treePath, "utf-8"));
		const serialized = treeData.nodes.find(
			(n: { id: string }) => n.id === childId,
		);
		expect(serialized.persistent).toBe(true);
		expect(serialized.title).toBeUndefined();
		expect(serialized.description).toBeUndefined();
	}, 60000);

	test("TREE6: persistent task definition survives daemon restart", async () => {
		ctx = await setupTestContext();

		// Manually create a persistent task definition file
		const { mkdir: mkdirAsync, writeFile: writeFileAsync } = await import(
			"node:fs/promises"
		);
		const tasksDir = join(ctx.projectDir, ".mxd", "tasks");
		await mkdirAsync(tasksDir, { recursive: true });
		const persistentId = "01AAABBBCCCDDDEEEFF";
		await writeFileAsync(
			join(tasksDir, `${persistentId}.json`),
			JSON.stringify({
				title: "Quality Gate",
				description: "Run quality checks before merge",
			}),
		);

		// Git commit so it survives
		Bun.spawnSync(["git", "add", ".mxd/tasks/"], { cwd: ctx.projectDir });
		Bun.spawnSync(["git", "commit", "-m", "add persistent task def"], {
			cwd: ctx.projectDir,
		});

		// Force re-create app to pick up the new persistent task file
		ctx.app = (
			await (async () => {
				await ctx.app.shutdown();
				await new Promise((r) => setTimeout(r, 50));
				const provider = createMockedProviderWithMock(ctx.mockAPI);
				const appResult = createApp({
					dataDir: ctx.dataDir,
					agentProvider: provider,
				});
				await appResult.pm.load();
				appResult.markReady();
				return { app: appResult };
			})()
		).app;

		const tracker2 = await ctx.app.getTracker(ctx.projectId);
		const node = tracker2.get(persistentId);
		expect(node).toBeDefined();
		expect(node?.persistent).toBe(true);
		expect(node?.title).toBe("Quality Gate");
		expect(node?.description).toBe("Run quality checks before merge");
		expect(node?.status).toBe("in_progress");
		expect(node?.parentId).toBe(tracker2.rootNodeId);
	}, 15000);

	test("TREE7: update_task writes to .mxd/tasks/<id>.json for persistent tasks", async () => {
		ctx = await setupTestContext();

		const instruction = JSON.stringify({
			turns: [
				{
					// Turn 1: Create a persistent task
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__create_task",
							input: {
								title: "Original Title",
								description: "Original description",
								persistent: true,
							},
						},
					],
				},
				{
					// Turn 2: Update the persistent task's title and description
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
							contains: "Original Title",
							capture: {
								taskId: 'regex:"id":\\s*"([A-Z0-9]+)"',
							},
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__update_task",
							input: {
								taskId: "$taskId",
								title: "Updated Title",
								description: "Updated description after change",
							},
						},
					],
				},
				{
					// Turn 3: Done
					assert: [{ block: 0, type: "tool_result", notContains: "Error" }],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: {
								status: "passed",
								summary: "updated persistent task",
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

		// Get the child task ID
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNode = tracker.get(tracker.rootNodeId) as TaskNode;
		const childId = rootNode.children[0] as string;

		// Verify in-memory state has the updated values
		const childNode = tracker.get(childId) as TaskNode;
		expect(childNode.persistent).toBe(true);
		expect(childNode.title).toBe("Updated Title");
		expect(childNode.description).toBe("Updated description after change");

		// Verify .mxd/tasks/<id>.json has the updated values
		const { readFile: readFileAsync } = await import("node:fs/promises");
		const defPath = join(ctx.projectDir, ".mxd", "tasks", `${childId}.json`);
		expect(existsSync(defPath)).toBe(true);
		const def = JSON.parse(await readFileAsync(defPath, "utf-8"));
		expect(def.title).toBe("Updated Title");
		expect(def.description).toBe("Updated description after change");

		// === RESTART: the real test — does the update survive? ===
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);

		// After restart, load should read from .mxd/tasks/<id>.json
		const tracker2 = await ctx.app.getTracker(ctx.projectId);
		const nodeAfterRestart = tracker2.get(childId) as TaskNode;
		expect(nodeAfterRestart.persistent).toBe(true);
		expect(nodeAfterRestart.title).toBe("Updated Title");
		expect(nodeAfterRestart.description).toBe(
			"Updated description after change",
		);
	}, 25000);
});

// ── File operation tests ──

describe("Integration: file operations", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("FILE1: write_file → read_file chain", async () => {
		ctx = await setupTestContext();

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__write_file",
							input: {
								path: "test-write.txt",
								content: "WRITTEN_CONTENT_XYZ",
							},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__read_file",
							input: { path: "test-write.txt" },
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
							contains: "WRITTEN_CONTENT_XYZ",
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "write+read ok" },
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

	test("FILE2: read_file → edit_file → read_file", async () => {
		ctx = await setupTestContext();

		// Pre-write a file with known content
		await Bun.write(
			join(ctx.projectDir, "editable.txt"),
			"line1: ORIGINAL_VALUE\nline2: keep this\n",
		);

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__read_file",
							input: { path: "editable.txt" },
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
							contains: "ORIGINAL_VALUE",
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__edit_file",
							input: {
								path: "editable.txt",
								old_string: "ORIGINAL_VALUE",
								new_string: "REPLACED_VALUE",
							},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__read_file",
							input: { path: "editable.txt" },
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
							contains: "REPLACED_VALUE",
							notContains: "ORIGINAL_VALUE",
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "edit ok" },
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

	test("FILE3: search → read_file workflow", async () => {
		ctx = await setupTestContext();

		// Pre-write multiple files with searchable content
		await Bun.write(
			join(ctx.projectDir, "search-a.txt"),
			"FINDME_PATTERN in file A\n",
		);
		await Bun.write(
			join(ctx.projectDir, "search-b.txt"),
			"FINDME_PATTERN in file B\n",
		);
		await Bun.write(
			join(ctx.projectDir, "search-c.txt"),
			"nothing special here\n",
		);

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__search",
							input: {
								pattern: "FINDME_PATTERN",
								path: ".",
							},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
							contains: "search-a.txt",
						},
						{
							block: 0,
							type: "tool_result",
							contains: "search-b.txt",
						},
						{
							block: 0,
							type: "tool_result",
							notContains: "search-c.txt",
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "search ok" },
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

	test("FILE4: list_files with glob", async () => {
		ctx = await setupTestContext();

		// Pre-write files in nested dirs
		const { mkdirSync, writeFileSync } = await import("node:fs");
		mkdirSync(join(ctx.projectDir, "subdir"), { recursive: true });
		writeFileSync(join(ctx.projectDir, "subdir", "alpha.ts"), "export {};\n");
		writeFileSync(join(ctx.projectDir, "subdir", "beta.ts"), "export {};\n");
		writeFileSync(join(ctx.projectDir, "subdir", "gamma.json"), "{}\n");

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__list_files",
							input: { pattern: "subdir/*.ts" },
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
							contains: "alpha.ts",
						},
						{
							block: 0,
							type: "tool_result",
							contains: "beta.ts",
						},
						{
							block: 0,
							type: "tool_result",
							notContains: "gamma.json",
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "list_files ok" },
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

	test("Transient API error: outer retry recovers after rate limit", async () => {
		ctx = await setupTestContext();

		// 2-turn conversation: bash → done
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Let me check." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo hello_retry" },
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							contains: "hello_retry",
						},
					],
					blocks: [
						{ type: "text", text: "All done!" },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "survived rate limit" },
						},
					],
				},
			],
		});

		// Inject a rate limit error on the 2nd API call (the turn after bash).
		// The mock throws TransientAPIError (not Anthropic SDK class) so the inner
		// retry doesn't recognize it → throws immediately → outer retry catches it,
		// waits 100ms (test override), and retries.
		ctx.mockAPI.injectError({
			onRequest: 2,
			error: "rate_limit",
			count: 1,
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		const status = await waitForDone(ctx);
		expect(status).toBe("passed");

		// Should have 3+ requests: 1 success, 1 failure, 1 retry success (+ maybe done turn)
		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThanOrEqual(3);

		// Verify JSONL has an error event from the outer retry
		const rootNodeId = await getRootNodeId(ctx);
		const events = await readSessionEvents(ctx, rootNodeId);
		const errorEvents = events.filter((e) => e.type === "error");
		expect(errorEvents.length).toBeGreaterThanOrEqual(1);
		const errorMsg = (errorEvents[0] as { message: string }).message;
		expect(errorMsg).toContain("outer retry");
		expect(errorMsg).toContain("Rate limit");
	}, 20000);

	test("Transient API error: agent dies after max outer retries exhausted", async () => {
		ctx = await setupTestContext();

		// Simple instruction
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Let me check." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo test" },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Done!" },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "ok" },
						},
					],
				},
			],
		});

		// Inject persistent rate limit on the 2nd API call (count=10 to exceed
		// both inner retries and outer retries). With TransientAPIError, inner retry
		// fails immediately, and outer retry tries MAX_OUTER_RETRIES (3) times.
		// So we need count >= 4 (1 original + 3 outer retries).
		ctx.mockAPI.injectError({
			onRequest: 2,
			error: "rate_limit",
			count: 10,
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		// Agent should stay in_progress — errors are "interrupted", not "failed".
		// Wait for the error events to appear, then check status.
		await new Promise((r) => setTimeout(r, 5000));
		const rootNodeId = await getRootNodeId(ctx);
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNode = tracker.get(rootNodeId);
		// Root stays in_progress (interrupted, resumable) — not failed
		expect(rootNode?.status).toBe("in_progress");

		// Should have multiple error events from outer retries
		const events = await readSessionEvents(ctx, rootNodeId);
		const errorEvents = events.filter((e) => e.type === "error");
		// At least 3 outer retry errors before giving up
		expect(errorEvents.length).toBeGreaterThanOrEqual(3);
	}, 30000);
});

// ── Fork prefix consistency tests ──

/**
 * Normalize message content for deep comparison.
 * Strips cache_control, normalizes string content to array form.
 * Mirrors the mock API's normalizeContent + deepEqualMessage logic.
 */
function normalizeMessageContent(content: unknown): unknown {
	if (typeof content === "string") {
		return [{ type: "text", text: content }];
	}
	if (Array.isArray(content)) {
		return content.map((block) => {
			if (block && typeof block === "object") {
				const { cache_control: _, ...rest } = block as Record<string, unknown>;
				return rest;
			}
			return block;
		});
	}
	return content;
}

function messagesDeepEqual(
	a: { role: string; content: unknown } | undefined,
	b: { role: string; content: unknown } | undefined,
): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	if (a.role !== b.role) return false;
	const aNorm = normalizeMessageContent(a.content);
	const bNorm = normalizeMessageContent(b.content);
	return JSON.stringify(aNorm) === JSON.stringify(bNorm);
}

describe("Integration: fork prefix consistency", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("Forked child's messages have parent's complete turns as prefix", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Child instruction: simple done
		const childInstruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "I am the forked child." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "forked child done" },
				},
			],
		});

		// Parent: bash × 2 → create → fork → send → yield → done
		const parentInstruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Work 1." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo PARENT_WORK_1" },
						},
					],
				},
				{
					assert: [
						{ block: 0, type: "tool_result", contains: "PARENT_WORK_1" },
					],
					blocks: [
						{ type: "text", text: "Work 2." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo PARENT_WORK_2" },
						},
					],
				},
				{
					assert: [
						{ block: 0, type: "tool_result", contains: "PARENT_WORK_2" },
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__create_task",
							input: {
								title: "Forked Child",
								description: "Testing fork prefix",
							},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
							capture: {
								childId: 'regex:"id":\\s*"([A-Z0-9]+)"',
								rootId: 'regex:"parentId":\\s*"([^"]+)"',
							},
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__fork_task_context",
							input: { sourceTaskId: "$rootId", targetTaskId: "$childId" },
						},
					],
				},
				{
					assert: [
						{ block: 0, type: "tool_result", contains: "You are the PARENT" },
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__send_message",
							input: {
								taskId: "$childId",
								title: "Start",
								message: childInstruction,
							},
						},
					],
				},
				{
					assert: [{ block: 0, type: "tool_result", isError: false }],
					blocks: [{ type: "tool_use", name: "mcp__mxd__yield", input: {} }],
				},
				{
					assert: [{ block: 0, type: "tool_result", contains: "## Pending" }],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "fork prefix test done" },
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, parentInstruction);
		expect(resp.status).toBe(200);
		const status = await waitForDone(ctx, 30000);
		expect(status).toBe("passed");

		const history = ctx.mockAPI.getRequestHistory();
		const hasChildForkResult = (req: (typeof history)[0]) =>
			req.messages.some((m) => {
				if (m.role !== "user" || !Array.isArray(m.content)) return false;
				return (m.content as Array<{ type: string; content?: string }>).some(
					(b) =>
						b.type === "tool_result" &&
						b.content?.includes("You are the CHILD"),
				);
			});
		const childRequests = history.filter(hasChildForkResult);
		const parentRequests = history.filter((r) => !hasChildForkResult(r));

		expect(parentRequests.length).toBeGreaterThanOrEqual(3);
		expect(childRequests.length).toBeGreaterThanOrEqual(1);

		// Find parent request that returned fork_task_context tool_use
		const forkRequestIdx = parentRequests.findIndex((req) => {
			const last = [...req.messages]
				.reverse()
				.find((m) => m.role === "assistant");
			if (!last || !Array.isArray(last.content)) return false;
			return (last.content as Array<{ name?: string }>).some(
				(b) => b.name === "mcp__mxd__fork_task_context",
			);
		});
		expect(forkRequestIdx).toBeGreaterThanOrEqual(0);

		const preForkMsgs = parentRequests[forkRequestIdx]?.messages as Array<{
			role: string;
			content: unknown;
		}>;
		const childFirstMsgs = childRequests[0]?.messages as Array<{
			role: string;
			content: unknown;
		}>;

		// Prefix match: everything except the fork tool_result diverges
		let prefixMatchCount = 0;
		for (
			let i = 0;
			i < Math.min(preForkMsgs.length, childFirstMsgs.length);
			i++
		) {
			const p = preForkMsgs[i] as { role: string; content: unknown };
			const c = childFirstMsgs[i] as { role: string; content: unknown };
			if (messagesDeepEqual(p, c)) prefixMatchCount++;
			else break;
		}
		// Parent: "You are the PARENT", Child: "You are the CHILD" — fork() return value
		expect(prefixMatchCount).toBe(preForkMsgs.length - 1);

		// Verify JSONL has fork_marker
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const childNodeId = tracker.get(tracker.rootNodeId)
			?.children?.[0] as string;
		expect(
			(await readSessionEvents(ctx, childNodeId)).some(
				(e) => e.type === "fork_marker",
			),
		).toBe(true);
	}, 45000);

	test("Fork writes synthetic tool_results before fork_marker for orphaned tool_calls", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Child: just done
		const childInstruction = JSON.stringify({
			blocks: [
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "child done" },
				},
			],
		});

		// Parent: bash → create_task → fork (solo turn) → send_message → yield → done
		// Fork is in its own turn. copySessionFrom should write a synthetic
		// tool_result for fork's own tool_call before the fork_marker.
		const parentInstruction = JSON.stringify({
			turns: [
				{
					// Turn 1: bash — complete turn
					blocks: [
						{ type: "text", text: "Working." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo WORK" },
						},
					],
				},
				{
					// Turn 2: create_task — solo, capture IDs
					assert: [{ block: 0, type: "tool_result", contains: "WORK" }],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__create_task",
							input: { title: "Fork Target", description: "test" },
						},
					],
				},
				{
					// Turn 3: fork (solo turn)
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
							capture: {
								childId: 'regex:"id":\\s*"([A-Z0-9]+)"',
								rootId: 'regex:"parentId":\\s*"([^"]+)"',
							},
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__fork_task_context",
							input: { sourceTaskId: "$rootId", targetTaskId: "$childId" },
						},
					],
				},
				{
					// Turn 4: send_message
					assert: [
						{ block: 0, type: "tool_result", contains: "You are the PARENT" },
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__send_message",
							input: {
								taskId: "$childId",
								title: "Go",
								message: childInstruction,
							},
						},
					],
				},
				{
					assert: [{ block: 0, type: "tool_result", isError: false }],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__yield",
							input: {},
						},
					],
				},
				{
					assert: [{ block: 0, type: "tool_result", contains: "## Pending" }],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "done" },
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, parentInstruction);
		expect(resp.status).toBe(200);
		const status = await waitForDone(ctx, 30000);
		expect(status).toBe("passed");

		// Get child's JSONL events
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNode = tracker.get(tracker.rootNodeId);
		const childNodeId = rootNode?.children?.[0] as string;
		const childEvents = await readSessionEvents(ctx, childNodeId);

		const forkIdx = childEvents.findIndex((e) => e.type === "fork_marker");
		expect(forkIdx).toBeGreaterThan(0);

		// KEY CHECK: All tool_calls before fork_marker should have matching
		// tool_results also before fork_marker. copySessionFrom should write
		// synthetic results for the in-progress turn's orphaned tool_calls.
		const eventsBeforeFork = childEvents.slice(0, forkIdx);
		const toolCallIds = new Set<string>();
		const toolResultIds = new Set<string>();
		for (const e of eventsBeforeFork) {
			if (e.type === "tool_call") toolCallIds.add(e.toolCallId);
			if (e.type === "tool_result") toolResultIds.add(e.toolCallId);
		}

		// Every tool_call before fork_marker must have a tool_result before fork_marker
		for (const id of toolCallIds) {
			expect(toolResultIds.has(id)).toBe(true);
		}

		// The fork tool_result should tell the child who it is
		const forkResults = eventsBeforeFork.filter(
			(e) =>
				e.type === "tool_result" && e.content.includes("You are the CHILD"),
		);
		expect(forkResults.length).toBe(1);
		expect(
			forkResults[0]?.type === "tool_result" && forkResults[0]?.isError,
		).toBe(false);

		// buildSessionRepair should find no problems in the child's events
		const { buildSessionRepair } = await import("./events.ts");
		const repair = buildSessionRepair(childEvents, childNodeId);
		expect(repair).toBeNull();

		// Fork's own tool_call should be in the child's events (copySessionFrom
		// should flush pending writes before reading). And it should have a
		// synthetic tool_result before fork_marker.
		const forkToolCall = eventsBeforeFork.find(
			(e) => e.type === "tool_call" && e.tool === "mcp__mxd__fork_task_context",
		);
		expect(forkToolCall).toBeDefined();
		if (forkToolCall && forkToolCall.type === "tool_call") {
			const forkToolResult = eventsBeforeFork.find(
				(e) =>
					e.type === "tool_result" && e.toolCallId === forkToolCall.toolCallId,
			);
			expect(forkToolResult).toBeDefined();
			if (forkToolResult && forkToolResult.type === "tool_result") {
				expect(forkToolResult.isError).toBe(false);
				expect(forkToolResult.content).toContain("You are the CHILD");
			}
		}
	}, 45000);

	test("Fork from closed agent injects synthetic tool_call + tool_result", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Scenario: parent creates child A → A does work and completes →
		// parent creates child B → forks A's context to B → B launches
		//
		// A's JSONL has NO fork tool_call. B should get synthetic call + result.
		const childAInstruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo CHILD_A_WORK" },
						},
					],
				},
				{
					assert: [{ block: 0, type: "tool_result", contains: "CHILD_A_WORK" }],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "A done" },
						},
					],
				},
			],
		});

		const childBInstruction = JSON.stringify({
			blocks: [
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "child B done" },
				},
			],
		});

		// Parent: create A → send to A (cold start) → yield for A → create B →
		// fork A to B → send to B → yield for B → done
		const parentInstruction = JSON.stringify({
			turns: [
				{
					// Turn 1: create child A
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__create_task",
							input: { title: "Child A", description: "source agent" },
						},
					],
				},
				{
					// Turn 2: send_message to A (cold start, no fork)
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
							capture: { childAId: 'regex:"id":\\s*"([A-Z0-9]+)"' },
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__send_message",
							input: {
								taskId: "$childAId",
								title: "Do work",
								message: childAInstruction,
							},
						},
					],
				},
				{
					// Turn 3: yield waiting for A
					assert: [{ block: 0, type: "tool_result", isError: false }],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__yield",
							input: {},
						},
					],
				},
				{
					// Turn 4: A completed, create child B
					assert: [{ block: 0, type: "tool_result", contains: "## Pending" }],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__create_task",
							input: { title: "Child B", description: "forked from A" },
						},
					],
				},
				{
					// Turn 5: fork A's context to B
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
							capture: { childBId: 'regex:"id":\\s*"([A-Z0-9]+)"' },
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__fork_task_context",
							input: { sourceTaskId: "$childAId", targetTaskId: "$childBId" },
						},
					],
				},
				{
					// Turn 6: send_message to B
					assert: [
						{ block: 0, type: "tool_result", contains: "You are the PARENT" },
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__send_message",
							input: {
								taskId: "$childBId",
								title: "Continue from A",
								message: childBInstruction,
							},
						},
					],
				},
				{
					// Turn 7: yield for B
					assert: [{ block: 0, type: "tool_result", isError: false }],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__yield",
							input: {},
						},
					],
				},
				{
					// Turn 8: done
					assert: [{ block: 0, type: "tool_result", contains: "## Pending" }],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "all done" },
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, parentInstruction);
		expect(resp.status).toBe(200);
		const status = await waitForDone(ctx, 30000);
		expect(status).toBe("passed");

		// Find child B's node
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNode = tracker.get(tracker.rootNodeId);
		// Children: A and B in order
		expect(rootNode?.children?.length).toBe(2);
		const childBId = rootNode?.children?.[1] as string;
		const childBNode = tracker.get(childBId);
		expect(childBNode?.title).toBe("Child B");

		// Read child B's JSONL
		const childBEvents = await readSessionEvents(ctx, childBId);
		const forkIdx = childBEvents.findIndex((e) => e.type === "fork_marker");
		expect(forkIdx).toBeGreaterThan(0);

		const eventsBeforeFork = childBEvents.slice(0, forkIdx);

		// Case 2 check: synthetic fork tool_call should be injected
		// (A's JSONL has no fork tool_call — A was cold-started, not forked)
		const syntheticForkCall = eventsBeforeFork.find(
			(e) => e.type === "tool_call" && e.tool === "mcp__mxd__fork_task_context",
		);
		expect(syntheticForkCall).toBeDefined();

		// Synthetic fork tool_result should be paired with it
		if (syntheticForkCall && syntheticForkCall.type === "tool_call") {
			const syntheticForkResult = eventsBeforeFork.find(
				(e) =>
					e.type === "tool_result" &&
					e.toolCallId === syntheticForkCall.toolCallId,
			);
			expect(syntheticForkResult).toBeDefined();
			if (syntheticForkResult && syntheticForkResult.type === "tool_result") {
				expect(syntheticForkResult.isError).toBe(false);
				expect(syntheticForkResult.content).toContain("You are the CHILD");
			}
		}

		// No problems in child B's events
		const { buildSessionRepair } = await import("./events.ts");
		const repair = buildSessionRepair(childBEvents, childBId);
		expect(repair).toBeNull();
	}, 45000);

	test("Fork + other tools in same turn: fork returns error", async () => {
		ctx = await setupTestContext();

		// Parent: create_task → (bash + fork in SAME turn) → assert fork errored → done
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__create_task",
							input: { title: "Target", description: "test" },
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
							capture: {
								childId: 'regex:"id":\\s*"([A-Z0-9]+)"',
								rootId: 'regex:"parentId":\\s*"([^"]+)"',
							},
						},
					],
					// Same turn: bash + fork → fork should error
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo HI" },
						},
						{
							type: "tool_use",
							name: "mcp__mxd__fork_task_context",
							input: { sourceTaskId: "$rootId", targetTaskId: "$childId" },
						},
					],
				},
				{
					// bash result OK, fork result is error
					assert: [
						{ block: 0, type: "tool_result", contains: "HI", isError: false },
						{
							block: 1,
							type: "tool_result",
							isError: true,
							contains: "must be the only tool",
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "fork rejected as expected" },
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);
		const status = await waitForDone(ctx, 15000);
		expect(status).toBe("passed");
	}, 30000);

	test("Cross-fork prefix: forked child's pre-fork messages exactly match source's", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Child: simple done
		const childInstruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Forked child reporting." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "child done" },
				},
			],
		});

		// Parent: bash work → create → fork → send → yield → done
		const parentInstruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Doing work before fork." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo PRE_FORK_WORK" },
						},
					],
				},
				{
					assert: [
						{ block: 0, type: "tool_result", contains: "PRE_FORK_WORK" },
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__create_task",
							input: {
								title: "Fork Target",
								description: "Cross-fork prefix test",
							},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
							capture: {
								childId: 'regex:"id":\\s*"([A-Z0-9]+)"',
								rootId: 'regex:"parentId":\\s*"([^"]+)"',
							},
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__fork_task_context",
							input: { sourceTaskId: "$rootId", targetTaskId: "$childId" },
						},
					],
				},
				{
					assert: [
						{ block: 0, type: "tool_result", contains: "You are the PARENT" },
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__send_message",
							input: {
								taskId: "$childId",
								title: "Go",
								message: childInstruction,
							},
						},
					],
				},
				{
					blocks: [{ type: "tool_use", name: "mcp__mxd__yield", input: {} }],
				},
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "fork prefix validated" },
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, parentInstruction);
		expect(resp.status).toBe(200);
		const status = await waitForDone(ctx, 30000);
		expect(status).toBe("passed");

		// Use validateForkPrefix to check cross-conversation prefix consistency
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNodeId = tracker.rootNodeId;
		const childId = tracker.get(rootNodeId)?.children?.[0] as string;

		const matchCount = ctx.mockAPI.validateForkPrefix(rootNodeId, childId);
		// Pre-fork messages should all match (everything before the fork tool_result)
		expect(matchCount).toBeGreaterThanOrEqual(3);
	}, 45000);
});

// ── Race condition: message near done() ──

describe("Integration: message near done() race condition", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	/**
	 * Bug: message sent to a passed child task via REST gets duplicated on resume.
	 *
	 * The /tasks/:nodeId/message endpoint writes the message to JSONL (event body
	 * WITHOUT id) and to persistent queue (WITH id). On resume, findUnconsumedMessages
	 * recovers it from JSONL, but the dedup against persistent queue fails because
	 * the JSONL body has no id. Result: message appears twice.
	 */
	test("Message to passed child → resume → no duplication", async () => {
		ctx = await setupTestContext();

		// Child instruction (first run): just call done immediately
		const childInstruction = JSON.stringify({
			blocks: [
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "initial work done" },
				},
			],
		});

		// Parent: create_task → send_message → yield → done
		const parentInstruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__create_task",
							input: {
								title: "Race Test Child",
								description: "Child for message race test",
							},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
							capture: {
								childId: 'regex:"id":\\s*"([A-Z0-9]+)"',
							},
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__send_message",
							input: {
								taskId: "$childId",
								title: "Start",
								message: childInstruction,
							},
						},
					],
				},
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__yield",
							input: {},
						},
					],
				},
				{
					// After yield: task_complete from child
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: {
								status: "passed",
								summary: "parent done after child passed",
							},
						},
					],
				},
			],
		});

		// Start parent
		const resp = await startAgent(ctx, parentInstruction);
		expect(resp.status).toBe(200);

		const status = await waitForDone(ctx, 30000);
		expect(status).toBe("passed");

		// Verify child is passed
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNode = tracker.get(tracker.rootNodeId);
		expect(rootNode?.children?.length).toBeGreaterThanOrEqual(1);
		const childId = rootNode?.children?.[0] as string;
		const childNode = tracker.get(childId);
		expect(childNode?.status).toBe("passed");

		// The message sent to the passed child will contain a JSON instruction
		// for the mock API: the resumed child should call done after seeing it.
		const resumeInstruction = JSON.stringify({
			blocks: [
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: {
						status: "passed",
						summary: "resumed and saw messages",
					},
				},
			],
		});

		// === KEY STEP: send message to the passed child via REST ===
		// deliverMessage will: fail queue enqueue (closed) → persist to disk → auto-launch child
		// The child resumes: loads unconsumed from JSONL + persisted from disk
		// BUG: message appears twice because JSONL body lacks 'id' for dedup
		const msgResp = await ctx.app.app.request(
			`/projects/${ctx.projectId}/tasks/${childId}/message`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					content: `UNIQUE_MSG_AFTER_DONE_XYZ ${resumeInstruction}`,
				}),
			},
		);
		expect(msgResp.status).toBe(200);

		// Wait for the auto-launched child to complete (done again)
		const startTime = Date.now();
		while (Date.now() - startTime < 15000) {
			const updated = tracker.get(childId);
			// After message endpoint: status goes to in_progress, then back to passed on done()
			if (updated?.status === "passed" && updated.session == null) {
				break;
			}
			await new Promise((r) => setTimeout(r, 50));
		}

		// Verify the child's resumed API request.
		// The child agent's first user message starts with memory.md (header).
		// Find its API call and check the unique message appears exactly once.
		const history = ctx.mockAPI.getRequestHistory();
		const childResumedReq = history.find((req) => {
			const firstUser = req.messages.find((m) => m.role === "user");
			if (!firstUser) return false;
			const firstText = getTextContent(firstUser);
			// Child agent requests start with memory.md header
			return (
				firstText.includes("memory.md") &&
				req.messages
					.filter((m) => m.role === "user")
					.some((m) => getTextContent(m).includes("UNIQUE_MSG_AFTER_DONE_XYZ"))
			);
		});
		expect(childResumedReq).toBeDefined();

		// Count occurrences of the unique message across all user messages — MUST be exactly 1
		const resumedReq = childResumedReq as (typeof history)[0];
		const allUserText = resumedReq.messages
			.filter((m) => m.role === "user")
			.map((m) => getTextContent(m))
			.join("|||");
		const occurrences =
			allUserText.split("UNIQUE_MSG_AFTER_DONE_XYZ").length - 1;
		expect(occurrences).toBe(1);
	}, 45000);
});

// ── session_config tests ──

describe("Integration: session_config in JSONL", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("Fresh start writes session_config as first event in JSONL", async () => {
		ctx = await setupTestContext();

		const instruction = JSON.stringify({
			blocks: [
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "done" },
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);
		await waitForDone(ctx, 15000);

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootId = tracker.rootNodeId;
		const events = await readSessionEvents(ctx, rootId);

		// session_config should be early in JSONL (after the initial user message)
		const config = events.find((e) => e.type === "session_config") as
			| {
					type: "session_config";
					systemStable: string;
					systemVariable: string;
					tools: unknown[];
			  }
			| undefined;
		expect(config).toBeDefined();
		// stable part should contain the SYSTEM_PROMPT content
		expect(config?.systemStable.length).toBeGreaterThan(100);
		expect(config?.systemStable).toContain("autonomous programming agent");
		// variable part should contain the date
		expect(config?.systemVariable).toContain(
			new Date().toISOString().split("T")[0] as string,
		);
	}, 30000);

	test("Resume uses frozen system prompt from session_config", async () => {
		ctx = await setupTestContext();

		// First run: bash → done (two turns)
		const doneInstruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo FIRST_RUN" },
						},
					],
				},
				{
					assert: [{ block: 0, type: "tool_result", contains: "FIRST_RUN" }],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "first done" },
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, doneInstruction);
		expect(resp.status).toBe(200);
		await waitForDone(ctx, 15000);

		// Verify session_config was written
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootId = tracker.rootNodeId;
		const events = await readSessionEvents(ctx, rootId);
		const configEvt = events.find((e) => e.type === "session_config");
		expect(configEvt).toBeDefined();

		// Restart the app (simulates daemon restart)
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);

		// Send a new message to trigger resume
		const resumeInstruction = JSON.stringify({
			blocks: [
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "resumed done" },
				},
			],
		});

		const resumeResp = await sendMessage(ctx, resumeInstruction);
		expect(resumeResp.status).toBe(200);
		await waitForDone(ctx, 15000);

		// Verify the resumed API request uses the stored system prompt from session_config
		const history = ctx.mockAPI.getRequestHistory();
		// Should have at least 3 requests (first run = 2 turns, resume = 1)
		expect(history.length).toBeGreaterThanOrEqual(3);

		// The resume request's system should match the first request's system
		const firstReqSystem = history[0]?.system;
		const resumeReq = history[history.length - 1] as (typeof history)[0];
		expect(resumeReq.system).toEqual(firstReqSystem);
	}, 45000);

	test("Forked child inherits session_config from parent", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const childInstruction = JSON.stringify({
			blocks: [
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "forked child done" },
				},
			],
		});

		const parentInstruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__create_task",
							input: {
								title: "Config Fork Child",
								description: "Testing session_config fork",
							},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
							capture: {
								childId: 'regex:"id":\\s*"([A-Z0-9]+)"',
								rootId: 'regex:"parentId":\\s*"([^"]+)"',
							},
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__fork_task_context",
							input: { sourceTaskId: "$rootId", targetTaskId: "$childId" },
						},
					],
				},
				{
					assert: [
						{ block: 0, type: "tool_result", contains: "You are the PARENT" },
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__send_message",
							input: {
								taskId: "$childId",
								title: "Start",
								message: childInstruction,
							},
						},
					],
				},
				{
					assert: [{ block: 0, type: "tool_result", isError: false }],
					blocks: [{ type: "tool_use", name: "mcp__mxd__yield", input: {} }],
				},
				{
					assert: [{ block: 0, type: "tool_result", contains: "## Pending" }],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: {
								status: "passed",
								summary: "fork config test done",
							},
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, parentInstruction);
		expect(resp.status).toBe(200);
		await waitForDone(ctx, 30000);

		// Get child node ID
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootId = tracker.rootNodeId;
		const childNodeId = tracker.get(rootId)?.children?.[0] as string;

		// Parent JSONL should have session_config
		const parentEvents = await readSessionEvents(ctx, rootId);
		const parentConfig = parentEvents.find((e) => e.type === "session_config");
		expect(parentConfig).toBeDefined();

		// Child JSONL should have session_config inherited from parent
		const childEvents = await readSessionEvents(ctx, childNodeId);
		const childConfig = childEvents.find((e) => e.type === "session_config");
		expect(childConfig).toBeDefined();

		// Both should have the same stable system prompt
		const pc = parentConfig as { systemStable: string; systemVariable: string };
		const cc = childConfig as { systemStable: string; systemVariable: string };
		expect(cc.systemStable).toBe(pc.systemStable);
	}, 45000);

	test("get_tree marks calling agent's node with (you)", async () => {
		ctx = await setupTestContext();

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__get_tree",
							input: {},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							contains: "(you)",
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "tree test done" },
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);
		await waitForDone(ctx, 15000);

		// Verify the get_tree result in request history contains "(you)"
		const history = ctx.mockAPI.getRequestHistory();
		const treeReq = history.find((req) =>
			req.messages.some((m) => {
				if (m.role !== "user") return false;
				const text =
					typeof m.content === "string"
						? m.content
						: Array.isArray(m.content)
							? (m.content as Array<{ text?: string }>)
									.map((b) => b.text ?? "")
									.join("")
							: "";
				return text.includes("(you)");
			}),
		);
		expect(treeReq).toBeDefined();
	}, 30000);
});

describe("Integration: root done then resume", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("root agent done(passed) then new user message resumes without error", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Turn 1: agent calls done(passed) — enters idle-yield inside done() handler
		// Turn 2: after done() wakes with new user message, call done again
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "All done." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "first pass complete" },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Handling new message after resume." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: {
								status: "passed",
								summary: "second pass after resume",
							},
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		// Wait for root to reach "passed" status from the first done()
		const firstStatus = await waitForDone(ctx);
		expect(firstStatus).toBe("passed");

		// The agent session is still alive (root agents don't close queue on done(),
		// they enter idle-yield inside the done() tool handler).
		// Send a new user message — this should wake done()'s waitForQueueMessages()
		// and the provider loop should make a second API call without error.
		const msgResp = await sendMessage(ctx, "Please do more work");
		expect(msgResp.status).toBe(200);

		// The agent resumes: tracker briefly goes to in_progress, then done() again → passed.
		// Since the agent was woken from done()'s idle-yield, we need to wait for a fresh
		// done cycle. The status may already be "passed" from the first done, so we poll
		// for in_progress first, then passed again.
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNodeId = tracker.rootNodeId;

		// Wait for status to cycle through in_progress (agent woke up and started processing)
		const start = Date.now();
		let sawInProgress = false;
		while (Date.now() - start < 10000) {
			const node = tracker.get(rootNodeId);
			if (node?.status === "in_progress") {
				sawInProgress = true;
				break;
			}
			await new Promise((r) => setTimeout(r, 50));
		}

		if (sawInProgress) {
			// Now wait for the second done
			const secondStatus = await waitForDone(ctx, 20000);
			expect(secondStatus).toBe("passed");
		}

		// Verify the provider loop made at least 2 API calls (one per done cycle)
		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThanOrEqual(2);
	}, 30000);

	test("root agent done(passed), shutdown, restart, new message resumes without error", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Turn 1: agent calls done(passed)
		const instruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "All done." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "first pass complete" },
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		const firstStatus = await waitForDone(ctx);
		expect(firstStatus).toBe("passed");

		const preRestartRequests = ctx.mockAPI.getRequestCount();

		// === SHUTDOWN: session fully exits ===
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		// === RESTART ===
		ctx.app = await recreateApp(ctx);
		await ctx.app.autoResumeProjects();

		// Root status was "passed" → autoResume skips (only resumes in_progress)
		expect(ctx.mockAPI.getRequestCount()).toBe(preRestartRequests);

		// Send a new message with JSON instruction → triggers launchAgent(resume: true)
		// Message must contain JSON instruction so mock knows to call done()
		const wakeInstruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "New task after done." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "second pass after resume" },
				},
			],
		});
		const msgResp = await sendMessage(ctx, wakeInstruction);
		expect(msgResp.status).toBe(200);

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNodeId = tracker.rootNodeId;

		// Wait for in_progress transition
		const start = Date.now();
		while (Date.now() - start < 5000) {
			const node = tracker.get(rootNodeId);
			if (node?.status === "in_progress") break;
			await new Promise((r) => setTimeout(r, 50));
		}

		const secondStatus = await waitForDone(ctx, 15000);
		expect(secondStatus).toBe("passed");

		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThan(preRestartRequests);
	}, 30000);

	test("root agent done(passed), session exits, new message triggers JSONL resume", async () => {
		ctx = await setupTestContext();

		// Disable prefix validation — post-done JSONL has lifecycle events
		// that may reconstruct differently on resume.

		// Turn 1: agent calls done(passed)
		const instruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "All done." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "first pass" },
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		const firstStatus = await waitForDone(ctx);
		expect(firstStatus).toBe("passed");

		const firstRequests = ctx.mockAPI.getRequestCount();
		expect(firstRequests).toBe(1);

		// === SHUTDOWN: force the session to fully exit ===
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		// === RESTART ===
		ctx.app = await recreateApp(ctx);
		await ctx.app.autoResumeProjects();

		// Root status was "passed" → autoResume skips
		expect(ctx.mockAPI.getRequestCount()).toBe(firstRequests);

		// Send a new user message with instruction → triggers launchAgent(resume: true)
		// This reconstructs messages from JSONL + new message → makes API call.
		// The bug: JSONL has events after done's tool_result (assistant_text, orchestration_completed,
		// agent_stopped) that may produce empty text content blocks.
		const wakeInstruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "New task." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "resumed ok" },
				},
			],
		});
		const msgResp = await sendMessage(ctx, wakeInstruction);
		expect(msgResp.status).toBe(200);

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNodeId = tracker.rootNodeId;

		// Wait for in_progress
		const start = Date.now();
		while (Date.now() - start < 5000) {
			const node = tracker.get(rootNodeId);
			if (node?.status === "in_progress") break;
			await new Promise((r) => setTimeout(r, 50));
		}

		const secondStatus = await waitForDone(ctx, 15000);
		expect(secondStatus).toBe("passed");

		// Must have made at least one new API call
		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThan(firstRequests);
	}, 30000);

	test("multiple done+resume cycles then restart resume", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Simulate: tool work → done → wake → tool work → done → shutdown → restart → resume.
		// Tests JSONL reconstruction with multiple done+wake patterns in the history.
		const instruction = JSON.stringify({
			turns: [
				// Turn 1: tool work
				{
					blocks: [
						{ type: "text", text: "Doing initial work." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo hello" },
						},
					],
				},
				// Turn 2: done (enters idle-yield)
				{
					blocks: [
						{ type: "text", text: "Finished first pass." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "first pass" },
						},
					],
				},
				// Turn 3 (after wake): tool work
				{
					blocks: [
						{ type: "text", text: "More work after wake." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo world" },
						},
					],
				},
				// Turn 4: done again (enters idle-yield again)
				{
					blocks: [
						{ type: "text", text: "Finished second pass." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "second pass" },
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		// Wait for first done
		await waitForDone(ctx);

		// Wake from done's idle-yield → cycle 2. Status stays "passed" from first done
		// so we can't use waitForDone again. Instead, send message and wait for the
		// mock to have processed all 4 turns.
		await sendMessage(ctx, "More work please");
		const startPoll = Date.now();
		while (Date.now() - startPoll < 10000) {
			if (ctx.mockAPI.getRequestCount() >= 4) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(ctx.mockAPI.getRequestCount()).toBe(4);

		const preRestartRequests = ctx.mockAPI.getRequestCount();

		// === SHUTDOWN + RESTART ===
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await ctx.app.autoResumeProjects();

		// Send new message → JSONL resume with multiple done+resume cycles in history
		const wakeInstruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Final task after restart." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "post-restart pass" },
				},
			],
		});
		await sendMessage(ctx, wakeInstruction);

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNodeId = tracker.rootNodeId;
		const start = Date.now();
		while (Date.now() - start < 5000) {
			if (tracker.get(rootNodeId)?.status === "in_progress") break;
			await new Promise((r) => setTimeout(r, 50));
		}

		const finalStatus = await waitForDone(ctx, 15000);
		expect(finalStatus).toBe("passed");
		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThan(preRestartRequests);
	}, 45000);
});

// ── Nested parent-child tests ──

describe("Integration: nested parent-child", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("NEST1: Parent → Child → Grandchild lifecycle", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Grandchild: bash echo + done(passed)
		const grandchildInstruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Grandchild working." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo GRANDCHILD_OUTPUT" },
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							contains: "GRANDCHILD_OUTPUT",
							isError: false,
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "grandchild done" },
						},
					],
				},
			],
		});

		// Child: create grandchild → send message → yield → done(passed)
		const childInstruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Child creating grandchild." },
						{
							type: "tool_use",
							name: "mcp__mxd__create_task",
							input: {
								title: "Grandchild Task",
								description: "A grandchild task",
							},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
							capture: {
								grandchildId: 'regex:"id":\\s*"([A-Z0-9]+)"',
							},
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__send_message",
							input: {
								taskId: "$grandchildId",
								title: "Start grandchild",
								message: grandchildInstruction,
							},
						},
					],
				},
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__yield",
							input: {},
						},
					],
				},
				{
					assert: [
						{
							block: 1,
							type: "text",
							contains: "task_complete",
						},
					],
					blocks: [
						{ type: "text", text: "Grandchild completed." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: {
								status: "passed",
								summary: "child done, grandchild passed",
							},
						},
					],
				},
			],
		});

		// Parent: create child → send message → yield → done(passed)
		const parentInstruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Parent creating child." },
						{
							type: "tool_use",
							name: "mcp__mxd__create_task",
							input: {
								title: "Child Task",
								description: "A child task that creates a grandchild",
							},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
							capture: {
								childId: 'regex:"id":\\s*"([A-Z0-9]+)"',
							},
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__send_message",
							input: {
								taskId: "$childId",
								title: "Start child",
								message: childInstruction,
							},
						},
					],
				},
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__yield",
							input: {},
						},
					],
				},
				{
					assert: [
						{
							block: 1,
							type: "text",
							contains: "task_complete",
						},
					],
					blocks: [
						{ type: "text", text: "Child completed. All done." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "full tree done" },
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, parentInstruction);
		expect(resp.status).toBe(200);

		const status = await waitForDone(ctx, 60000);
		expect(status).toBe("passed");

		// Verify tree structure: root → child → grandchild, all passed
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNode = tracker.get(tracker.rootNodeId);
		expect(rootNode?.status).toBe("passed");
		expect(rootNode?.children?.length).toBeGreaterThanOrEqual(1);

		const childId = rootNode?.children?.[0] as string;
		const childNode = tracker.get(childId);
		expect(childNode?.status).toBe("passed");
		expect(childNode?.title).toBe("Child Task");
		expect(childNode?.children?.length).toBeGreaterThanOrEqual(1);

		const grandchildId = childNode?.children?.[0] as string;
		const grandchildNode = tracker.get(grandchildId);
		expect(grandchildNode?.status).toBe("passed");
		expect(grandchildNode?.title).toBe("Grandchild Task");

		// Verify grandchild JSONL has bash events
		const grandchildEvents = await readSessionEvents(ctx, grandchildId);
		const bashCalls = grandchildEvents.filter(
			(e) => e.type === "tool_call" && e.tool === "mcp__mxd__bash",
		);
		expect(bashCalls.length).toBe(1);
	}, 90000);

	test("NEST2: Grandchild fails → propagates up", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Grandchild: done(failed)
		const grandchildInstruction = JSON.stringify({
			blocks: [
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "failed", summary: "grandchild error" },
				},
			],
		});

		// Child: create grandchild → send → yield → handles failure → done(passed)
		const childInstruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__create_task",
							input: {
								title: "Failing Grandchild",
								description: "Will fail",
							},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
							capture: {
								grandchildId: 'regex:"id":\\s*"([A-Z0-9]+)"',
							},
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__send_message",
							input: {
								taskId: "$grandchildId",
								title: "Go",
								message: grandchildInstruction,
							},
						},
					],
				},
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__yield",
							input: {},
						},
					],
				},
				{
					assert: [
						{
							block: 1,
							type: "text",
							contains: "failed",
						},
					],
					blocks: [
						{ type: "text", text: "Handled grandchild failure." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "handled failure" },
						},
					],
				},
			],
		});

		// Parent: create child → send → yield → done(passed)
		const parentInstruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__create_task",
							input: {
								title: "Child With Failing Grandchild",
								description: "Handles grandchild failure",
							},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
							capture: {
								childId: 'regex:"id":\\s*"([A-Z0-9]+)"',
							},
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__send_message",
							input: {
								taskId: "$childId",
								title: "Start",
								message: childInstruction,
							},
						},
					],
				},
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__yield",
							input: {},
						},
					],
				},
				{
					assert: [
						{
							block: 1,
							type: "text",
							contains: "task_complete",
						},
					],
					blocks: [
						{ type: "text", text: "All handled." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "failure handled" },
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, parentInstruction);
		expect(resp.status).toBe(200);

		const status = await waitForDone(ctx, 60000);
		expect(status).toBe("passed");

		// Verify: grandchild=failed, child=passed, root=passed
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNode = tracker.get(tracker.rootNodeId);
		expect(rootNode?.status).toBe("passed");

		const childId = rootNode?.children?.[0] as string;
		const childNode = tracker.get(childId);
		expect(childNode?.status).toBe("passed");

		const grandchildId = childNode?.children?.[0] as string;
		const grandchildNode = tracker.get(grandchildId);
		expect(grandchildNode?.status).toBe("failed");
	}, 90000);
});

// ── Child restart tests ──

describe("Integration: child restart scenarios", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("CHILD_RESTART1: Child crashes during bash → parent still gets task_complete", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Child turn 1: bash sleep (will be interrupted by crash)
		// Child turn 2 (after restart + wake message): done(passed)
		const childInstruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Child running long task." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "sleep 30" },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Resumed after crash." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "child survived restart" },
						},
					],
				},
			],
		});

		// Parent: create child → send → yield → receive task_complete → done
		const parentInstruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__create_task",
							input: {
								title: "Restartable Child",
								description: "Child that survives restart",
							},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
							capture: {
								childId: 'regex:"id":\\s*"([A-Z0-9]+)"',
							},
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__send_message",
							input: {
								taskId: "$childId",
								title: "Start",
								message: childInstruction,
							},
						},
					],
				},
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__yield",
							input: {},
						},
					],
				},
				{
					// Yield may wake with tree_change + task_complete — don't assert specific block positions
					blocks: [
						{ type: "text", text: "Child done after restart." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "parent done" },
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, parentInstruction);
		expect(resp.status).toBe(200);

		// Wait for child to start bash (parent 3 API calls + child 1)
		const start = Date.now();
		while (Date.now() - start < 15000) {
			if (ctx.mockAPI.getRequestCount() >= 4) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThanOrEqual(4);
		await new Promise((r) => setTimeout(r, 300));

		// Get child ID before crash
		const tracker1 = await ctx.app.getTracker(ctx.projectId);
		const rootNode1 = tracker1.get(tracker1.rootNodeId);
		const childId = rootNode1?.children?.[0] as string;

		const preRestartRequests = ctx.mockAPI.getRequestCount();

		// === CRASH ===
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		// === RESTART ===
		ctx.app = await recreateApp(ctx);
		await ctx.app.autoResumeProjects();

		// autoResumeProjects resumes both:
		// - Parent: yielding → bypass to queue.wait
		// - Child: interrupted bash → persists resume message + runChildAgentInBackground
		// Child resumes → orphan bash + resume message → API call → done(passed)
		// Parent wakes from yield → receives task_complete → done(passed)
		const status = await waitForDone(ctx, 20000);
		expect(status).toBe("passed");

		// Verify child status
		const tracker2 = await ctx.app.getTracker(ctx.projectId);
		const childNode = tracker2.get(childId);
		expect(childNode?.status).toBe("passed");

		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThan(preRestartRequests);
	}, 60000);

	test("CHILD_RESTART2: Parent crashes while child running → both resume correctly", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Child: bash sleep (will be interrupted) → on resume, done(passed)
		const childInstruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Child doing work." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "sleep 30" },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Resumed child." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "child survived" },
						},
					],
				},
			],
		});

		// Parent: create → send → yield → done (no strict assertion on yield content)
		const parentInstruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__create_task",
							input: {
								title: "Child For Restart",
								description: "Both crash and resume",
							},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
							capture: {
								childId: 'regex:"id":\\s*"([A-Z0-9]+)"',
							},
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__send_message",
							input: {
								taskId: "$childId",
								title: "Go",
								message: childInstruction,
							},
						},
					],
				},
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__yield",
							input: {},
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Both survived." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "both resumed" },
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, parentInstruction);
		expect(resp.status).toBe(200);

		// Wait for child to start (at least 4 requests: parent 3 turns + child 1)
		const start = Date.now();
		while (Date.now() - start < 15000) {
			if (ctx.mockAPI.getRequestCount() >= 4) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThanOrEqual(4);

		// Get child ID before crash
		const tracker1 = await ctx.app.getTracker(ctx.projectId);
		const childId = tracker1.get(tracker1.rootNodeId)?.children?.[0] as string;

		await new Promise((r) => setTimeout(r, 300));

		// === CRASH (both parent and child die) ===
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		// === RESTART ===
		ctx.app = await recreateApp(ctx);
		await ctx.app.autoResumeProjects();

		// autoResumeProjects persists resume message for interrupted child + launches it.
		// Child resumes → done → task_complete → parent wakes → done
		const status = await waitForDone(ctx, 30000);
		expect(status).toBe("passed");

		const tracker2 = await ctx.app.getTracker(ctx.projectId);
		expect(tracker2.get(childId)?.status).toBe("passed");
	}, 60000);

	test("CHILD_RESTART3: Parent yielding + daemon restart + child completes multi-step work + parent receives task_complete", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Child: 3-turn workflow
		// Turn 1: bash echo (will be interrupted by crash)
		// Turn 2 (after restart): second bash producing output
		// Turn 3: done(passed) with summary referencing earlier work
		const childInstruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Starting multi-step work." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "sleep 30" },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Resumed, doing real work now." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo STEP_TWO_COMPLETE" },
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							contains: "STEP_TWO_COMPLETE",
							isError: false,
						},
					],
					blocks: [
						{ type: "text", text: "All steps done." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: {
								status: "passed",
								summary: "completed multi-step after restart",
							},
						},
					],
				},
			],
		});

		// Parent: create → send → yield → (wake from task_complete) → done
		const parentInstruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__create_task",
							input: {
								title: "Multi-Step Child",
								description: "Child doing multi-step work across restart",
							},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
							capture: {
								childId: 'regex:"id":\\s*"([A-Z0-9]+)"',
							},
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__send_message",
							input: {
								taskId: "$childId",
								title: "Begin work",
								message: childInstruction,
							},
						},
					],
				},
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__yield",
							input: {},
						},
					],
				},
				{
					// After restart, parent wakes from yield with task_complete
					blocks: [
						{ type: "text", text: "Child completed after restart." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: {
								status: "passed",
								summary: "parent received task_complete post-restart",
							},
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, parentInstruction);
		expect(resp.status).toBe(200);

		// Wait for child to start its bash (parent 3 API calls + child 1 = 4)
		const start = Date.now();
		while (Date.now() - start < 15000) {
			if (ctx.mockAPI.getRequestCount() >= 4) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThanOrEqual(4);
		await new Promise((r) => setTimeout(r, 300));

		// Capture child ID and pre-restart state
		const tracker1 = await ctx.app.getTracker(ctx.projectId);
		const rootNode1 = tracker1.get(tracker1.rootNodeId);
		const childId = rootNode1?.children?.[0] as string;
		expect(tracker1.get(childId)?.status).toBe("in_progress");

		const preRestartRequests = ctx.mockAPI.getRequestCount();

		// === CRASH ===
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		// === RESTART ===
		ctx.app = await recreateApp(ctx);
		await ctx.app.autoResumeProjects();

		// autoResumeProjects should:
		// - Parent: yielding → bypass to queue.wait (no API call)
		// - Child: interrupted → resume message + runChildAgentInBackground
		// Child resumes → orphan bash result → turn 2 (echo) → turn 3 (done)
		// done() delivers task_complete to parent
		// Parent wakes from yield → turn 4 (done)

		const status = await waitForDone(ctx, 30000);
		expect(status).toBe("passed");

		// Verify child completed successfully
		const tracker2 = await ctx.app.getTracker(ctx.projectId);
		const childNode = tracker2.get(childId);
		expect(childNode?.status).toBe("passed");

		// Verify post-restart API calls happened (child 2 turns + parent 1 turn = at least 3 more)
		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThan(preRestartRequests);

		// Verify child JSONL has all 3 bash calls (1 interrupted + 1 real + done)
		const childEvents = await readSessionEvents(ctx, childId);
		const childBashCalls = childEvents.filter(
			(e) => e.type === "tool_call" && e.tool === "mcp__mxd__bash",
		);
		expect(childBashCalls.length).toBe(2);

		const childDoneCalls = childEvents.filter(
			(e) => e.type === "tool_call" && e.tool === "mcp__mxd__done",
		);
		expect(childDoneCalls.length).toBe(1);

		// Verify parent JSONL has yield and done
		const rootNodeId = tracker2.rootNodeId;
		const parentEvents = await readSessionEvents(ctx, rootNodeId);
		const parentYieldCalls = parentEvents.filter(
			(e) => e.type === "tool_call" && e.tool === "mcp__mxd__yield",
		);
		expect(parentYieldCalls.length).toBe(1);

		const parentDoneCalls = parentEvents.filter(
			(e) => e.type === "tool_call" && e.tool === "mcp__mxd__done",
		);
		expect(parentDoneCalls.length).toBe(1);
	}, 60000);
});

// ── Triple restart test ──

describe("Integration: multiple restarts with accumulated state", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("Restart N: Triple restart with accumulated tool results", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Turn 1: bash echo → result
		// Turn 2: second bash sleep → CRASH
		// Turn 3 (after restart 1): third bash sleep → CRASH
		// Turn 4 (after restart 2): done(passed)
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "First bash." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo FIRST_RESULT" },
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							contains: "FIRST_RESULT",
							isError: false,
						},
					],
					blocks: [
						{ type: "text", text: "Second bash." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "sleep 30" },
						},
					],
				},
				{
					// After restart 1: orphan result for sleep + third bash
					blocks: [
						{ type: "text", text: "Third bash after first restart." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "sleep 30" },
						},
					],
				},
				{
					// After restart 2: orphan result for third bash + done
					blocks: [
						{ type: "text", text: "Final after second restart." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "survived triple restart" },
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		// Wait for second bash to start (turn 1 echo + turn 2 sleep = 2 API calls)
		const start1 = Date.now();
		while (Date.now() - start1 < 10000) {
			if (ctx.mockAPI.getRequestCount() >= 2) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(ctx.mockAPI.getRequestCount()).toBe(2);
		await new Promise((r) => setTimeout(r, 200));

		// === CRASH 1 ===
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		// === RESTART 1 ===
		ctx.app = await recreateApp(ctx);
		await ctx.app.autoResumeProjects();

		// Agent resumes → orphan for 2nd bash → turn 3 (3rd bash sleep)
		const start2 = Date.now();
		while (Date.now() - start2 < 10000) {
			if (ctx.mockAPI.getRequestCount() >= 3) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThanOrEqual(3);
		await new Promise((r) => setTimeout(r, 200));

		// === CRASH 2 ===
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		// === RESTART 2 ===
		ctx.app = await recreateApp(ctx);
		await ctx.app.autoResumeProjects();

		// Agent resumes → orphan for 3rd bash → turn 4 (done)
		const status = await waitForDone(ctx, 30000);
		expect(status).toBe("passed");

		// Verify JSONL has 3 bash tool_calls
		const rootNodeId = await getRootNodeId(ctx);
		const events = await readSessionEvents(ctx, rootNodeId);
		const bashCalls = events.filter(
			(e) => e.type === "tool_call" && e.tool === "mcp__mxd__bash",
		);
		expect(bashCalls.length).toBe(3);

		// At least 2 orphan tool_results (from the 2 crashes during bash)
		const orphanResults = events.filter(
			(e) =>
				e.type === "tool_result" &&
				e.isError === true &&
				(e.content?.includes("interrupted") ||
					e.content?.includes("Interrupted")),
		);
		expect(orphanResults.length).toBeGreaterThanOrEqual(2);

		// Prefix validation passed (mock throws on violation)
		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThanOrEqual(4);
	}, 45000);
});

// ── Default branch detection tests ──
describe("Default branch", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("root node gets branch set from git HEAD at tracker load time", async () => {
		ctx = await setupTestContext();

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNode = tracker.get(tracker.rootNodeId);
		expect(rootNode).toBeDefined();
		// git init creates a default branch (main or master depending on config)
		expect(rootNode?.branch).toBeTruthy();
		expect(typeof rootNode?.branch).toBe("string");
	});

	test("root node branch persists across save/load", async () => {
		ctx = await setupTestContext();

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNode = tracker.get(tracker.rootNodeId);
		const branch = rootNode?.branch;
		expect(branch).toBeTruthy();

		await tracker.save();

		// Verify the saved tree.json has the branch persisted.
		const { readFile } = await import("node:fs/promises");
		const treePath = join(ctx.dataDir, "projects", ctx.projectId, "tree.json");
		const raw = JSON.parse(await readFile(treePath, "utf-8"));
		const rootInJson = raw.nodes.find(
			(n: { id: string }) => n.id === tracker.rootNodeId,
		);
		expect(rootInJson.branch).toBe(branch);
	});

	test("child task worktree branches from parent's branch", async () => {
		ctx = await setupTestContext();

		// Child does bash to check its branch, then done()
		const childInstruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "git rev-parse --abbrev-ref HEAD" },
						},
					],
				},
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "checked branch" },
						},
					],
				},
			],
		});

		// Parent: create_task → send_message → yield → done
		const parentInstruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__create_task",
							input: {
								title: "Branch Check Child",
								description: "Verify child branches from parent",
							},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
							capture: {
								childId: 'regex:"id":\\s*"([A-Z0-9]+)"',
							},
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__send_message",
							input: {
								taskId: "$childId",
								title: "Start",
								message: childInstruction,
							},
						},
					],
				},
				{
					assert: [{ block: 0, type: "tool_result", isError: false }],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__yield",
							input: {},
						},
					],
				},
				{
					assert: [{ block: 0, type: "tool_result", isError: false }],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "done" },
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, parentInstruction);
		expect(resp.status).toBe(200);

		const status = await waitForDone(ctx, 30000);
		expect(status).toBe("passed");

		// Verify child got a worktree with branch based off parent's branch
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNode = tracker.get(tracker.rootNodeId) as TaskNode;
		const childId = rootNode.children[0] as string;
		const childNode = tracker.get(childId) as TaskNode;

		// Child's branch should start with mxd/ prefix
		expect(childNode.branch).toBeTruthy();
		expect(childNode.branch?.startsWith("mxd/")).toBe(true);

		// Child's worktree should exist
		expect(childNode.worktreePath).toBeTruthy();

		// The child's branch was created from parent's branch — verify by checking
		// that child JSONL has a bash tool_result with a branch name starting with mxd/
		const childEvents = await readSessionEvents(ctx, childId);
		const bashResults = childEvents.filter(
			(e) => e.type === "tool_result" && !e.isError,
		);
		expect(bashResults.length).toBeGreaterThanOrEqual(1);
		// The bash output is the child's own branch name (git rev-parse --abbrev-ref HEAD)
		const firstResult = bashResults[0];
		const branchOutput =
			firstResult && "content" in firstResult ? firstResult.content : "";
		expect(branchOutput).toContain("mxd/");
	}, 45000);

	test("project on non-main branch gets correct root node branch", async () => {
		// Create a project with a "develop" branch
		const dataDir = await mkdtemp(join(tmpdir(), "mxd-integ-data-"));
		const projectDir = await mkdtemp(join(tmpdir(), "mxd-integ-project-"));

		// Init git and switch to "develop" branch
		Bun.spawnSync(["git", "init"], { cwd: projectDir });
		Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
			cwd: projectDir,
		});
		Bun.spawnSync(["git", "config", "user.name", "Test"], {
			cwd: projectDir,
		});
		await Bun.write(join(projectDir, "README.md"), "# Dev Project\n");
		Bun.spawnSync(["git", "add", "."], { cwd: projectDir });
		Bun.spawnSync(["git", "commit", "-m", "initial"], { cwd: projectDir });
		Bun.spawnSync(["git", "checkout", "-b", "develop"], { cwd: projectDir });

		const mockAPI = new ValidatingMockAPI();
		const provider = createMockedProviderWithMock(mockAPI);

		const appResult = createApp({
			dataDir,
			agentProvider: provider,
		});

		await appResult.pm.load();
		const project = await appResult.pm.init(projectDir);

		// Activate setup hook
		const hookExample = join(
			projectDir,
			".mxd",
			"hooks",
			"setup_worktree.sh.example",
		);
		const hookActive = join(projectDir, ".mxd", "hooks", "setup_worktree.sh");
		if (existsSync(hookExample)) {
			await rename(hookExample, hookActive);
		}
		Bun.spawnSync(["git", "add", "."], { cwd: projectDir });
		Bun.spawnSync(["git", "commit", "-m", "activate hook"], {
			cwd: projectDir,
		});

		appResult.markReady();

		ctx = {
			dataDir,
			projectDir,
			app: appResult,
			mockAPI,
			projectId: project.id,
		};

		// Verify root node has "develop" as its branch
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNode = tracker.get(tracker.rootNodeId);
		expect(rootNode?.branch).toBe("develop");
	});

	test("project on 'master' branch works correctly", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "mxd-integ-data-"));
		const projectDir = await mkdtemp(join(tmpdir(), "mxd-integ-project-"));

		Bun.spawnSync(["git", "init", "-b", "master"], { cwd: projectDir });
		Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
			cwd: projectDir,
		});
		Bun.spawnSync(["git", "config", "user.name", "Test"], {
			cwd: projectDir,
		});
		await Bun.write(join(projectDir, "README.md"), "# Master Project\n");
		Bun.spawnSync(["git", "add", "."], { cwd: projectDir });
		Bun.spawnSync(["git", "commit", "-m", "initial"], { cwd: projectDir });

		const mockAPI = new ValidatingMockAPI();
		const provider = createMockedProviderWithMock(mockAPI);
		const appResult = createApp({ dataDir, agentProvider: provider });
		await appResult.pm.load();
		const project = await appResult.pm.init(projectDir);

		const hookExample = join(
			projectDir,
			".mxd",
			"hooks",
			"setup_worktree.sh.example",
		);
		const hookActive = join(projectDir, ".mxd", "hooks", "setup_worktree.sh");
		if (existsSync(hookExample)) await rename(hookExample, hookActive);
		Bun.spawnSync(["git", "add", "."], { cwd: projectDir });
		Bun.spawnSync(["git", "commit", "-m", "activate hook"], {
			cwd: projectDir,
		});

		appResult.markReady();
		ctx = {
			dataDir,
			projectDir,
			app: appResult,
			mockAPI,
			projectId: project.id,
		};

		const tracker = await ctx.app.getTracker(ctx.projectId);
		expect(tracker.get(tracker.rootNodeId)?.branch).toBe("master");
	});

	test("child worktree on non-main branch contains correct content", async () => {
		// Use standard setupTestContext, then add a file and switch to develop
		ctx = await setupTestContext();

		// Add a develop-only file on a new branch
		Bun.spawnSync(["git", "checkout", "-b", "develop"], {
			cwd: ctx.projectDir,
		});
		await Bun.write(join(ctx.projectDir, "develop-only.txt"), "on develop\n");
		Bun.spawnSync(["git", "add", "."], { cwd: ctx.projectDir });
		Bun.spawnSync(["git", "commit", "-m", "develop content"], {
			cwd: ctx.projectDir,
		});

		// Update root node branch to "develop" (simulating tracker reload)
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNode = tracker.get(tracker.rootNodeId) as TaskNode;
		rootNode.branch = "develop";
		await tracker.save();

		// Child checks for develop-only.txt — should exist since branched from develop
		const childInstruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "cat develop-only.txt" },
						},
					],
				},
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "verified develop content" },
						},
					],
				},
			],
		});

		const parentInstruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__create_task",
							input: {
								title: "Develop Branch Child",
								description: "Check develop content exists",
							},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
							capture: { childId: 'regex:"id":\\s*"([A-Z0-9]+)"' },
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__send_message",
							input: {
								taskId: "$childId",
								title: "Start",
								message: childInstruction,
							},
						},
					],
				},
				{
					assert: [{ block: 0, type: "tool_result", isError: false }],
					blocks: [{ type: "tool_use", name: "mcp__mxd__yield", input: {} }],
				},
				{
					assert: [{ block: 0, type: "tool_result", isError: false }],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "done" },
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, parentInstruction);
		expect(resp.status).toBe(200);

		const status = await waitForDone(ctx, 30000);
		expect(status).toBe("passed");

		// Verify the child's bash saw develop-only.txt content
		const rootNode2 = tracker.get(tracker.rootNodeId) as TaskNode;
		const childId = rootNode2.children[0] as string;
		const childEvents = await readSessionEvents(ctx, childId);
		const bashResults = childEvents.filter(
			(e) => e.type === "tool_result" && !e.isError,
		);
		// First tool_result should be the cat output containing "on develop"
		const firstResult = bashResults[0];
		const catOutput =
			firstResult && "content" in firstResult ? firstResult.content : "";
		expect(catOutput).toContain("on develop");
	}, 45000);

	test("system prompt has no hardcoded 'main' branch references", () => {
		// Import directly to verify the static content
		const { SYSTEM_PROMPT, buildSystemPrompt } = require("./system-prompts.ts");

		// No "git checkout main", "git merge main", "git log main.." etc.
		// The word "main" may appear in non-git contexts (e.g. "main repo", "import.meta.main")
		// but should NOT appear as a git branch reference
		const gitMainPatterns = [
			/git checkout main/,
			/git merge main/,
			/git log main/,
			/checkout main/,
			/merge main\b/,
			/\bmain branch\b/,
		];

		for (const pattern of gitMainPatterns) {
			expect(SYSTEM_PROMPT).not.toMatch(pattern);
		}

		// Also check built prompt
		const built = buildSystemPrompt();
		const fullPrompt = `${built.stable}\n\n${built.variable}`;
		for (const pattern of gitMainPatterns) {
			expect(fullPrompt).not.toMatch(pattern);
		}
	});
});

// ── stopTask integration tests ──

describe("Integration: stopTask lifecycle", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("stopTask during bash: stop → orphan cleanup → resume succeeds", async () => {
		ctx = await setupTestContext();

		// Turn 1: start a long-running bash command
		// Turn 2: after resume (interrupted bash result), call done
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Running a long command." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "sleep 30" },
						},
					],
				},
				{
					// After stop+resume, agent sees the interrupted bash and new message
					blocks: [
						{ type: "text", text: "Bash was interrupted by stop, finishing." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: {
								status: "passed",
								summary: "handled stop during bash",
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
		// Give bash a moment to actually start
		await new Promise((r) => setTimeout(r, 200));

		const rootNodeId = await getRootNodeId(ctx);
		const tracker = await ctx.app.getTracker(ctx.projectId);

		// Verify agent is running
		const nodeBefore = tracker.get(rootNodeId) as TaskNode;
		expect(nodeBefore.session).toBeTruthy();
		expect(nodeBefore.status).toBe("in_progress");

		// === STOP via REST endpoint ===
		const stopResp = await ctx.app.app.request(
			`/projects/${ctx.projectId}/tasks/${rootNodeId}/stop`,
			{ method: "POST" },
		);
		expect(stopResp.status).toBe(200);
		const stopBody = (await stopResp.json()) as { ok: boolean };
		expect(stopBody.ok).toBe(true);

		// Wait for stop to fully complete
		await new Promise((r) => setTimeout(r, 200));

		// Verify: session cleared
		const nodeAfterStop = tracker.get(rootNodeId) as TaskNode;
		expect(nodeAfterStop.session).toBeUndefined();

		// Verify: status is still in_progress (NOT failed)
		expect(nodeAfterStop.status).toBe("in_progress");

		// Verify: the original tool_call for bash is in JSONL
		const events = await readSessionEvents(ctx, rootNodeId);
		const toolCalls = events.filter((e) => e.type === "tool_call");
		const bashCall = toolCalls.find(
			(e) => "tool" in e && e.tool === "mcp__mxd__bash",
		);
		expect(bashCall).toBeDefined();

		// NOTE: orphan tool_results are NOT written during stopTask — they're deferred
		// to resume time (buildSessionRepair in runAgentForNode) to avoid racing
		// with the provider loop's async tool_result emission.

		const preResumeRequests = ctx.mockAPI.getRequestCount();

		// === RESUME: send a message to wake the agent ===
		const wakeInstruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Continue after stop." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "recovered from stop" },
				},
			],
		});
		const msgResp = await sendMessage(ctx, wakeInstruction);
		expect(msgResp.status).toBe(200);

		const status = await waitForDone(ctx);
		expect(status).toBe("passed");

		// Verify new API calls were made for the resume
		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThan(preResumeRequests);
	}, 30000);

	test("stopTask during yield: stop → resume succeeds", async () => {
		ctx = await setupTestContext();

		// Turn 1: agent yields
		const instruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Waiting for input." },
				{
					type: "tool_use",
					name: "mcp__mxd__yield",
					input: {},
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		// Wait for agent to enter yield state
		await waitForIdle(ctx);

		const rootNodeId = await getRootNodeId(ctx);
		const tracker = await ctx.app.getTracker(ctx.projectId);

		// Verify agent is running (in yield)
		expect(tracker.get(rootNodeId)?.session).toBeTruthy();
		expect(tracker.get(rootNodeId)?.status).toBe("in_progress");

		// === STOP ===
		const stopResp = await ctx.app.app.request(
			`/projects/${ctx.projectId}/tasks/${rootNodeId}/stop`,
			{ method: "POST" },
		);
		expect(stopResp.status).toBe(200);

		await new Promise((r) => setTimeout(r, 200));

		// Session cleared, status stays in_progress
		expect(tracker.get(rootNodeId)?.session).toBeUndefined();
		expect(tracker.get(rootNodeId)?.status).toBe("in_progress");

		// JSONL should have the yield tool_call (no orphan result for yield - it's excluded)
		const events = await readSessionEvents(ctx, rootNodeId);
		const yieldCalls = events.filter(
			(e) =>
				e.type === "tool_call" && "tool" in e && e.tool === "mcp__mxd__yield",
		);
		expect(yieldCalls.length).toBe(1);

		// === RESUME ===
		const wakeInstruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Done after stop." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "resumed after yield stop" },
				},
			],
		});
		await sendMessage(ctx, wakeInstruction);

		const status = await waitForDone(ctx);
		expect(status).toBe("passed");
	}, 30000);

	test("stopTask on non-running agent returns 404", async () => {
		ctx = await setupTestContext();

		const rootNodeId = await getRootNodeId(ctx);

		// No agent is running, so stop should return 404
		const stopResp = await ctx.app.app.request(
			`/projects/${ctx.projectId}/tasks/${rootNodeId}/stop`,
			{ method: "POST" },
		);
		expect(stopResp.status).toBe(404);
	}, 10000);

	test("Fork + child interrupt: no duplicate tool_result on restart", async () => {
		// Bug scenario: fork copies parent events → child starts → crash →
		// orphan cleanup writes synthetic tool_results → child resumes.
		// If orphan cleanup doesn't check for existing synthetic results from
		// copySessionFrom, it may write DUPLICATE tool_results → API 400.
		ctx = await setupTestContext();

		// Child: bash (will be interrupted) → on resume, done(passed)
		const childInstruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Child starting work." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "sleep 30" },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Resumed after crash." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "child survived fork+crash" },
						},
					],
				},
			],
		});

		// Parent: bash (creates context) → create_task → fork (solo turn) →
		//         send_message → yield → done
		const parentInstruction = JSON.stringify({
			turns: [
				{
					// Turn 1: bash to create some context in the parent's events
					blocks: [
						{ type: "text", text: "Building context." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo PARENT_CONTEXT" },
						},
					],
				},
				{
					// Turn 2: create task
					assert: [
						{ block: 0, type: "tool_result", contains: "PARENT_CONTEXT" },
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__create_task",
							input: {
								title: "Fork Crash Child",
								description: "Test fork + crash recovery",
							},
						},
					],
				},
				{
					// Turn 3: fork (must be solo turn)
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
							capture: {
								childId: 'regex:"id":\\s*"([A-Z0-9]+)"',
								rootId: 'regex:"parentId":\\s*"([^"]+)"',
							},
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__fork_task_context",
							input: { sourceTaskId: "$rootId", targetTaskId: "$childId" },
						},
					],
				},
				{
					// Turn 4: send_message to start child
					assert: [
						{ block: 0, type: "tool_result", contains: "You are the PARENT" },
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__send_message",
							input: {
								taskId: "$childId",
								title: "Start",
								message: childInstruction,
							},
						},
					],
				},
				{
					// Turn 5: yield (waits for child)
					assert: [{ block: 0, type: "tool_result", isError: false }],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__yield",
							input: {},
						},
					],
				},
				{
					// Turn 6: done (after child completes)
					blocks: [
						{ type: "text", text: "Child completed after crash." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "fork+crash recovery done" },
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, parentInstruction);
		expect(resp.status).toBe(200);

		// Wait for child to start bash sleep (parent needs ~5 turns, child 1)
		const start = Date.now();
		while (Date.now() - start < 20000) {
			if (ctx.mockAPI.getRequestCount() >= 6) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThanOrEqual(6);
		await new Promise((r) => setTimeout(r, 300));

		// Get child ID before crash
		const tracker1 = await ctx.app.getTracker(ctx.projectId);
		const rootNode1 = tracker1.get(tracker1.rootNodeId);
		const childId = rootNode1?.children?.[0] as string;

		// Verify child JSONL has fork_marker (fork was successful)
		const precrashEvents = await readSessionEvents(ctx, childId);
		const hasForkMarker = precrashEvents.some((e) => e.type === "fork_marker");
		expect(hasForkMarker).toBe(true);

		// Verify child has some tool_calls (at least bash sleep)
		const preCrashToolCalls = precrashEvents.filter(
			(e) => e.type === "tool_call",
		);
		expect(preCrashToolCalls.length).toBeGreaterThan(0);

		// === CRASH (both parent and child die) ===
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		// === RESTART: recreate app from disk ===
		ctx.app = await recreateApp(ctx);
		await ctx.app.autoResumeProjects();

		// KEY CHECK before resume completes: verify no duplicate tool_results
		// in child's JSONL after orphan cleanup
		const postCrashEvents = await readSessionEvents(ctx, childId);
		const toolResultsByCallId = new Map<string, number>();
		for (const e of postCrashEvents) {
			if (e.type === "tool_result") {
				const count = toolResultsByCallId.get(e.toolCallId) ?? 0;
				toolResultsByCallId.set(e.toolCallId, count + 1);
			}
		}

		// No tool_call should have more than one tool_result
		for (const [callId, count] of toolResultsByCallId) {
			if (count > 1) {
				// Find the tool_call for debugging
				const tc = postCrashEvents.find(
					(e) => e.type === "tool_call" && e.toolCallId === callId,
				);
				const toolName = tc && tc.type === "tool_call" ? tc.tool : "unknown";
				throw new Error(
					`Duplicate tool_result for tool_call ${callId} (${toolName}): found ${count} results`,
				);
			}
		}

		// Child should resume → done → parent wakes → done
		const status = await waitForDone(ctx, 30000);
		expect(status).toBe("passed");

		// Verify child completed successfully
		const tracker2 = await ctx.app.getTracker(ctx.projectId);
		expect(tracker2.get(childId)?.status).toBe("passed");
	}, 60000);

	test("stop → immediate restart: old session settles quickly, no stale events leak", async () => {
		// Bug: After stopTask, the old runAgentForNode's foreground bash execution
		// isn't killed — it keeps running (up to 30s for sleep, or 120s for timeout).
		// When it finally settles, the old finally block emits a stale agent_stopped
		// and the catch block may emit "Request was aborted" errors — both appearing
		// long after the new session started.
		//
		// Two-part fix:
		// 1. stopTask resolves foreground executions so bash returns quickly
		// 2. runAgentForNode's catch/finally suppress events when session was replaced
		ctx = await setupTestContext();

		// Turn 1: agent starts a bash command (will be interrupted by stop)
		// Turn 2 (after resume): agent sees interrupted bash result + new message → done
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Running a long command." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "sleep 30" },
						},
					],
				},
				{
					// After stop+resume, agent sees the interrupted bash and new message
					blocks: [
						{ type: "text", text: "Recovered after stop." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: {
								status: "passed",
								summary: "survived stop and restart",
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

		const rootNodeId = await getRootNodeId(ctx);

		// === STOP ===
		const stopResp = await ctx.app.app.request(
			`/projects/${ctx.projectId}/tasks/${rootNodeId}/stop`,
			{ method: "POST" },
		);
		expect(stopResp.status).toBe(200);

		// Small delay, then send new message
		await new Promise((r) => setTimeout(r, 50));

		// === IMMEDIATE RESTART via new message ===
		const wakeInstruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Continue after stop." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "recovered from stop" },
				},
			],
		});
		const msgResp = await sendMessage(ctx, wakeInstruction);
		expect(msgResp.status).toBe(200);

		// New agent should complete normally
		const status = await waitForDone(ctx);
		expect(status).toBe("passed");

		// Wait for old session to fully settle (with fix: should be fast, <1s)
		// Without fix: old bash takes 30s, so old finally runs 30s later
		await new Promise((r) => setTimeout(r, 1500));

		const events = await readSessionEvents(ctx, rootNodeId);

		// No error events containing "abort" — those are stale leaks from old session
		const abortErrors = events.filter(
			(e) =>
				e.type === "error" &&
				"message" in e &&
				typeof e.message === "string" &&
				e.message.toLowerCase().includes("abort"),
		);
		expect(abortErrors).toEqual([]);

		// The agent_stopped from stopTask should be BEFORE the second orchestration_started.
		// With the fix, the old runAgentForNode suppresses its stale agent_stopped.
		// The new session's agent_stopped only appears on shutdown (root agents stay alive).
		const stoppedEvents = events.filter((e) => e.type === "agent_stopped");
		const orcStartEvents = events
			.map((e, i) => ({ type: e.type, idx: i }))
			.filter((e) => e.type === "orchestration_started");

		// There should be exactly 2 orchestration_started events (first + resume)
		expect(orcStartEvents.length).toBe(2);

		// There should be 1 agent_stopped (from stopTask), not 2+ (no stale leak)
		// The new session's agent_stopped will come later at shutdown
		expect(stoppedEvents.length).toBe(1);

		// The agent_stopped should be between the two orchestration_started events
		const stoppedIdx = events.findIndex((e) => e.type === "agent_stopped");
		expect(stoppedIdx).toBeGreaterThan(orcStartEvents[0]?.idx ?? -1);
		expect(stoppedIdx).toBeLessThan(orcStartEvents[1]?.idx ?? events.length);

		// KEY CHECK: verify the old session settled quickly (foreground bash was killed).
		// If the bash wasn't killed, the old runAgentForNode would still be hanging,
		// and when it eventually settled, it would emit stale events.
		// We prove it settled by checking no stale events appeared after 1.5s wait.
		// Without the fix, this would only fail after waiting 30s+ (bash sleep duration).
		const tracker2 = await ctx.app.getTracker(ctx.projectId);
		const rootNode = tracker2.get(rootNodeId);
		// New session is running (root agents stay alive after done)
		expect(rootNode?.session).toBeTruthy();
	}, 30000);
});

// ── deliverMessage shouldResume ordering ──

describe("deliverMessage: shouldResume ordering invariant", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("first message → cold start (resume=false), restart + second message → resume=true", async () => {
		ctx = await setupTestContext();

		// First run: agent calls done immediately
		const instruction1 = JSON.stringify({
			blocks: [
				{ type: "text", text: "Got it." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "first run complete" },
				},
			],
		});

		await startAgent(ctx, instruction1);
		const status1 = await waitForDone(ctx);
		expect(status1).toBe("passed");

		// Read JSONL — should have orchestration_started with resume=false
		const rootNodeId = await getRootNodeId(ctx);
		const events1 = await readSessionEvents(ctx, rootNodeId);
		const orch1 = events1.filter((e) => e.type === "orchestration_started");
		expect(orch1).toHaveLength(1);
		expect((orch1[0] as { resume: boolean }).resume).toBe(false);

		// === RESTART: agent stops, in-memory state is lost ===
		await ctx.app.shutdown();
		ctx.app = await recreateApp(ctx);

		// Now send a second message — agent should resume (not cold start)
		// because JSONL already exists for this node.
		// The key invariant: shouldResume is checked BEFORE emitEvent writes
		// the new message → shouldResume = true (JSONL exists from first run).
		const instruction2 = JSON.stringify({
			blocks: [
				{ type: "text", text: "Resuming after restart." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "second run complete" },
				},
			],
		});

		await sendMessage(ctx, instruction2);
		const status2 = await waitForDone(ctx);
		expect(status2).toBe("passed");

		// Read JSONL — should now have TWO orchestration_started events
		const events2 = await readSessionEvents(ctx, rootNodeId);
		const orch2 = events2.filter((e) => e.type === "orchestration_started");
		expect(orch2).toHaveLength(2);
		// First was cold start
		expect((orch2[0] as { resume: boolean }).resume).toBe(false);
		// Second was resume — this proves shouldResume was correctly
		// evaluated BEFORE the message was written to JSONL.
		// If shouldResume were checked AFTER emitEvent, a fresh node
		// would incorrectly get resume=true (because its own message
		// just populated the JSONL).
		expect((orch2[1] as { resume: boolean }).resume).toBe(true);
	}, 30000);
});
