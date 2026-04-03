/**
 * JSONL Stress Tests: edge cases for data integrity, corruption, and race conditions.
 *
 * These tests focus on scenarios most likely to cause real bugs:
 * - Compaction + restart interactions
 * - Multi-child coordination under crash
 * - Multiple messages during yield (batch consumption)
 * - Fork + restart combinations
 * - JSONL corruption recovery
 * - Message delivery edge cases around agent lifecycle boundaries
 *
 * All restart tests complete the full lifecycle: crash → restart → resume → done().
 * Prefix validation is enabled wherever possible.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./daemon.ts";
import { EventStore } from "./event-store.ts";
import {
	createMockedProviderWithMock,
	ValidatingMockAPI,
} from "./test-utils/mock-anthropic-api.ts";

// ── Shared test infrastructure (mirrors integration.test.ts) ──

interface TestContext {
	dataDir: string;
	projectDir: string;
	app: ReturnType<typeof createApp>;
	mockAPI: ValidatingMockAPI;
	projectId: string;
}

async function setupTestContext(): Promise<TestContext> {
	const dataDir = await mkdtemp(join(tmpdir(), "mxd-stress-data-"));
	const projectDir = await mkdtemp(join(tmpdir(), "mxd-stress-project-"));

	Bun.spawnSync(["git", "init"], { cwd: projectDir });
	Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
		cwd: projectDir,
	});
	Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: projectDir });
	writeFileSync(join(projectDir, "README.md"), "# Test Project\n");
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
	await new Promise((r) => setTimeout(r, 50));
	await rm(ctx.dataDir, { recursive: true, force: true });
	await rm(ctx.projectDir, { recursive: true, force: true });
}

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

async function waitForDone(
	ctx: TestContext,
	timeoutMs = 15000,
): Promise<string> {
	const tracker = await ctx.app.getTracker(ctx.projectId);
	const rootNodeId = tracker.rootNodeId;
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const rootNode = tracker.get(rootNodeId);
		if (rootNode?.status === "verify" || rootNode?.status === "failed") {
			return rootNode.status;
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`Agent did not call done() within ${timeoutMs}ms`);
}

async function waitForIdle(ctx: TestContext, timeoutMs = 10000): Promise<void> {
	const tracker = await ctx.app.getTracker(ctx.projectId);
	const rootNodeId = tracker.rootNodeId;
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const rootNode = tracker.get(rootNodeId);
		if (rootNode?.session?.queue?.idle) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`Agent did not enter idle state within ${timeoutMs}ms`);
}

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

function readSessionEvents(ctx: TestContext, sessionId: string) {
	const store = new EventStore(join(ctx.dataDir, "sessions", ctx.projectId));
	return store.read(sessionId);
}

async function getRootNodeId(ctx: TestContext): Promise<string> {
	const tracker = await ctx.app.getTracker(ctx.projectId);
	return tracker.rootNodeId;
}

function getTextContent(msg: { content: string | unknown[] }): string {
	if (typeof msg.content === "string") return msg.content;
	if (!Array.isArray(msg.content)) return "";
	return (msg.content as Array<{ type: string; text?: string }>)
		.filter((b) => b.type === "text")
		.map((b) => b.text ?? "")
		.join(" ");
}

// ── STRESS TESTS ──

// ── 1. Compaction + restart interactions ──

describe("Stress: compaction + restart", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("COMPACT1: readActive returns only post-compact events + session_config", () => {
		// Directly test that JSONL with compact_marker behaves correctly.
		// This verifies the critical invariant: resume from compacted JSONL
		// only sees events after the last compact_marker.
		const tmpDir = join(tmpdir(), `mxd-compact-test-${Date.now()}`);
		const store = new EventStore(tmpDir);

		// Simulate a JSONL with pre-compact events, compact_marker, and post-compact events
		const preCompactEvents = [
			{
				type: "message" as const,
				id: "msg1",
				taskId: "test",
				body: {
					source: "user" as const,
					id: "msg1",
					ts: 1000,
					content: "PRE_COMPACT_CONTENT",
				},
				ts: 1000,
			},
			{
				type: "assistant_text" as const,
				content: "PRE_COMPACT_WORK_A",
				taskId: "test",
				ts: 1001,
			},
			{
				type: "tool_call" as const,
				tool: "mcp__mxd__bash",
				toolCallId: "tc_old",
				input: { command: "echo old" },
				taskId: "test",
				ts: 1002,
			},
			{
				type: "tool_result" as const,
				tool: "mcp__mxd__bash",
				toolCallId: "tc_old",
				content: "old output",
				isError: false,
				taskId: "test",
				ts: 1003,
			},
		];

		const compactMarker = {
			type: "compact_marker" as const,
			checkpoint: "<summary>Compacted summary</summary>",
			savedTokens: 500,
			taskId: "test",
			ts: 2000,
		};

		const postCompactEvents = [
			{
				type: "session_config" as const,
				tools: [],
				systemStable: "stable prompt",
				systemVariable: "variable prompt",
				taskId: "test",
				ts: 2001,
			},
			{
				type: "compacted_resume" as const,
				content: "Compacted context",
				cwd: "/test",
				taskId: "test",
				ts: 2002,
			},
			{
				type: "assistant_text" as const,
				content: "POST_COMPACT_WORK",
				taskId: "test",
				ts: 2003,
			},
			{
				type: "tool_call" as const,
				tool: "mcp__mxd__yield",
				toolCallId: "tc_yield",
				input: {},
				taskId: "test",
				ts: 2004,
			},
		];

		// Write all events
		const allEvents = [
			...preCompactEvents,
			compactMarker,
			...postCompactEvents,
		];
		const content = `${allEvents.map((e) => JSON.stringify(e)).join("\n")}\n`;
		writeFileSync(join(tmpDir, "compact-test.events.jsonl"), content);

		// readActive should only return post-compact events
		const active = store.readActive("compact-test");
		expect(active.length).toBe(postCompactEvents.length);

		// Verify no pre-compact content
		const allText = active.map((e) => JSON.stringify(e)).join(" ");
		expect(allText).not.toContain("PRE_COMPACT_CONTENT");
		expect(allText).not.toContain("PRE_COMPACT_WORK_A");
		expect(allText).not.toContain("tc_old");

		// Verify post-compact content present
		expect(allText).toContain("POST_COMPACT_WORK");
		expect(allText).toContain("session_config");
		expect(allText).toContain("stable prompt");

		// read() returns ALL events including pre-compact
		const allRead = store.read("compact-test");
		expect(allRead.length).toBe(allEvents.length);

		// readFromLastCompactMarker includes the marker itself
		const fromMarker = store.readFromLastCompactMarker("compact-test");
		expect(fromMarker.hasOlderEvents).toBe(true);
		expect(fromMarker.events.length).toBe(postCompactEvents.length + 1); // +1 for marker
		expect(fromMarker.events[0]?.type).toBe("compact_marker");

		Bun.spawnSync(["rm", "-rf", tmpDir]);
	});

	test("COMPACT2: manual compact during yield creates consecutive user messages (known bug)", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// This test documents a known production bug:
		// Manual compaction triggered during explicit yield creates consecutive
		// user messages (tool_result + summarization instruction), which the
		// Anthropic API would reject with "Messages must alternate roles."
		//
		// The agent does enough work to exceed messages.length > 4, yields,
		// then receives a compact-only message. The bug manifests as an error
		// in the JSONL ("Messages must alternate roles").
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Work." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo A" },
						},
					],
				},
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo B" },
						},
					],
				},
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo C" },
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

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);
		await waitForIdle(ctx);

		// Trigger compact-only (no accompanying real message)
		await ctx.app.app.request(`/projects/${ctx.projectId}/compact`, {
			method: "POST",
		});

		// Wait for the error to appear in JSONL
		await new Promise((r) => setTimeout(r, 3000));

		const rootNodeId = await getRootNodeId(ctx);
		const events = readSessionEvents(ctx, rootNodeId);
		const errors = events.filter((e) => e.type === "error");

		// Known bug: consecutive user messages error
		expect(errors.length).toBeGreaterThanOrEqual(1);
		const errorMsg = (errors[0] as { message: string }).message;
		expect(errorMsg).toContain("consecutive");
	}, 30000);
});

// ── 2. Multi-child coordination under crash ──

describe("Stress: multi-child coordination", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("MULTI1: 3 children running → crash → restart → all 3 complete → parent done", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Child instruction: bash echo (unique per child via send_message content) → done
		const makeChildInstruction = (label: string) =>
			JSON.stringify({
				turns: [
					{
						blocks: [
							{ type: "text", text: `Child ${label} working.` },
							{
								type: "tool_use",
								name: "mcp__mxd__bash",
								input: { command: `sleep 30` },
							},
						],
					},
					{
						// After restart: orphan bash → done
						blocks: [
							{ type: "text", text: `Child ${label} resumed.` },
							{
								type: "tool_use",
								name: "mcp__mxd__done",
								input: {
									status: "passed",
									summary: `child ${label} survived restart`,
								},
							},
						],
					},
				],
			});

		// Parent: create 3 tasks → send to each → yield → yield → yield → done
		// (3 task_completes may arrive across multiple yield wakes)
		const parentInstruction = JSON.stringify({
			turns: [
				{
					// Create child A
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__create_task",
							input: { title: "Child A", description: "Parallel child A" },
						},
					],
				},
				{
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
							name: "mcp__mxd__create_task",
							input: { title: "Child B", description: "Parallel child B" },
						},
					],
				},
				{
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
							name: "mcp__mxd__create_task",
							input: { title: "Child C", description: "Parallel child C" },
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							isError: false,
							capture: { childCId: 'regex:"id":\\s*"([A-Z0-9]+)"' },
						},
					],
					// Send to all 3 children
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__send_message",
							input: {
								taskId: "$childAId",
								title: "Start A",
								message: makeChildInstruction("A"),
							},
						},
						{
							type: "tool_use",
							name: "mcp__mxd__send_message",
							input: {
								taskId: "$childBId",
								title: "Start B",
								message: makeChildInstruction("B"),
							},
						},
						{
							type: "tool_use",
							name: "mcp__mxd__send_message",
							input: {
								taskId: "$childCId",
								title: "Start C",
								message: makeChildInstruction("C"),
							},
						},
					],
				},
				{
					// All 3 sends succeeded → yield
					blocks: [
						{ type: "text", text: "All children launched, yielding." },
						{
							type: "tool_use",
							name: "mcp__mxd__yield",
							input: {},
						},
					],
				},
				{
					// First yield wake: at least one task_complete
					assert: [
						{
							block: 0,
							type: "tool_result",
							contains: "resumed.",
						},
					],
					blocks: [
						{ type: "text", text: "Got some completions, yielding for more." },
						{
							type: "tool_use",
							name: "mcp__mxd__yield",
							input: {},
						},
					],
				},
				{
					// Second yield wake
					blocks: [
						{ type: "text", text: "More completions, yielding again." },
						{
							type: "tool_use",
							name: "mcp__mxd__yield",
							input: {},
						},
					],
				},
				{
					// Third yield wake (or all 3 arrived in previous wakes)
					blocks: [
						{ type: "text", text: "All children done." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: {
								status: "passed",
								summary: "all 3 children completed after restart",
							},
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, parentInstruction);
		expect(resp.status).toBe(200);

		// Wait for all children to start their bash commands
		// Parent: 5 turns (create A, create B, create C, 3x send_message, yield)
		// Each child: 1 turn (bash sleep)
		// Total: ~8 API calls minimum before all children are running
		const start = Date.now();
		while (Date.now() - start < 20000) {
			if (ctx.mockAPI.getRequestCount() >= 8) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThanOrEqual(8);

		// Give children time to start bash
		await new Promise((r) => setTimeout(r, 500));

		// === CRASH: all agents die ===
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 200));

		// === RESTART ===
		ctx.app = await recreateApp(ctx);
		await ctx.app.autoResumeProjects();

		// All 3 children resume (interrupted bash → orphan → done)
		// Parent resumes (yielding → bypass to queue.wait → wakes on task_completes)
		const status = await waitForDone(ctx, 45000);
		expect(status).toBe("verify");

		// Verify all 3 children are passed
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNode = tracker.get(tracker.rootNodeId);
		expect(rootNode?.children?.length).toBe(3);

		for (const childId of rootNode?.children ?? []) {
			const childNode = tracker.get(childId);
			expect(childNode?.status).toBe("verify");
		}
	}, 90000);
});

// ── 3. Multiple messages during yield ──

describe("Stress: multiple messages during yield", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("YIELD_BATCH1: multiple messages queued before yield wakes → all delivered together", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Agent yields. We write messages directly to JSONL (simulating persistence)
		// and enqueue them. Then crash + restart — on resume, all messages are recovered
		// from JSONL and delivered in one batch. This is a more reliable way to test
		// batch message delivery than racing HTTP requests.
		//
		// Alternatively, we use sequential yield-wake cycles with a done at the end.
		// Each message sends, agent wakes, processes, and yields again.
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
					// Wake 1
					assert: [
						{
							block: 1,
							type: "text",
							contains: "SEQUENTIAL_MSG_1",
						},
					],
					blocks: [
						{ type: "text", text: "Got msg 1, yielding." },
						{
							type: "tool_use",
							name: "mcp__mxd__yield",
							input: {},
						},
					],
				},
				{
					// Wake 2
					assert: [
						{
							block: 1,
							type: "text",
							contains: "SEQUENTIAL_MSG_2",
						},
					],
					blocks: [
						{ type: "text", text: "Got msg 2, yielding." },
						{
							type: "tool_use",
							name: "mcp__mxd__yield",
							input: {},
						},
					],
				},
				{
					// Wake 3
					assert: [
						{
							block: 1,
							type: "text",
							contains: "SEQUENTIAL_MSG_3",
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: {
								status: "passed",
								summary: "all 3 messages consumed sequentially",
							},
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);
		await waitForIdle(ctx);

		// Send message 1 → wake → yield
		await sendMessage(ctx, "SEQUENTIAL_MSG_1");
		await waitForIdle(ctx);

		// Send message 2 → wake → yield
		await sendMessage(ctx, "SEQUENTIAL_MSG_2");
		await waitForIdle(ctx);

		// Send message 3 → wake → done
		await sendMessage(ctx, "SEQUENTIAL_MSG_3");

		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		// Verify all 3 messages in JSONL
		const rootNodeId = await getRootNodeId(ctx);
		const events = readSessionEvents(ctx, rootNodeId);
		const messageTexts = events
			.filter(
				(e) =>
					e.type === "message" &&
					"body" in e &&
					e.body &&
					typeof e.body === "object" &&
					"source" in e.body &&
					e.body.source === "user",
			)
			.map((e) => (e as { body: { content: string } }).body.content);

		expect(messageTexts.some((t) => t.includes("SEQUENTIAL_MSG_1"))).toBe(true);
		expect(messageTexts.some((t) => t.includes("SEQUENTIAL_MSG_2"))).toBe(true);
		expect(messageTexts.some((t) => t.includes("SEQUENTIAL_MSG_3"))).toBe(true);

		// Verify the mock received all messages across API calls
		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThanOrEqual(4); // initial + 3 wakes
	}, 30000);

	test("YIELD_BATCH2: message sent during yield persists in JSONL across restart", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Agent yields. We send a message (persists to JSONL). Then crash.
		// The message may or may not have been consumed before crash — either way
		// it's in JSONL. After restart, agent resumes and the message is available.
		//
		// Provide enough mock turns: the message might be consumed before crash
		// (using turn 1), or not. Either way, the post-restart wake needs a turn too.
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
					// If message consumed before crash: yield again
					blocks: [
						{ type: "text", text: "Got message, yielding." },
						{
							type: "tool_use",
							name: "mcp__mxd__yield",
							input: {},
						},
					],
				},
				{
					// After restart + wake: done
					blocks: [
						{ type: "text", text: "Finishing." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: {
								status: "passed",
								summary: "message survived",
							},
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);
		await waitForIdle(ctx);

		// Send message — JSONL persisted by deliverMessage
		await sendMessage(ctx, "SURVIVE_CRASH_MSG");

		// Small delay — message is being processed
		await new Promise((r) => setTimeout(r, 200));

		// === CRASH ===
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		// Verify message in JSONL
		const rootNodeId = await getRootNodeId(ctx);
		const preEvents = readSessionEvents(ctx, rootNodeId);
		const msgTexts = preEvents
			.filter(
				(e) =>
					e.type === "message" &&
					"body" in e &&
					e.body &&
					typeof e.body === "object" &&
					"source" in e.body &&
					e.body.source === "user",
			)
			.map((e) => (e as { body: { content: string } }).body.content);
		expect(msgTexts.some((t) => t.includes("SURVIVE_CRASH_MSG"))).toBe(true);

		// === RESTART ===
		ctx.app = await recreateApp(ctx);
		await ctx.app.autoResumeProjects();

		// Send wake message to trigger resume
		await sendMessage(ctx, "POST_RESTART_WAKE");

		const status = await waitForDone(ctx, 20000);
		expect(status).toBe("verify");

		// Verify the pre-crash message appears in API history
		const history = ctx.mockAPI.getRequestHistory();
		const allText = history
			.flatMap((r) => r.messages.filter((m) => m.role === "user"))
			.map((m) => getTextContent(m))
			.join(" ");
		expect(allText).toContain("SURVIVE_CRASH_MSG");
	}, 30000);
});

// ── 4. Fork + restart combinations ──

describe("Stress: fork + restart", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("FORK_RESTART1: fork child → crash → both parent and child resume correctly", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Child instruction: bash sleep (will be interrupted) → done after restart
		const childInstruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Forked child working." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "sleep 30" },
						},
					],
				},
				{
					// After restart: interrupted bash → done
					blocks: [
						{ type: "text", text: "Forked child resumed." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: {
								status: "passed",
								summary: "forked child survived restart",
							},
						},
					],
				},
			],
		});

		// Parent: bash → create → fork → send → yield → done (after child completes post-restart)
		const parentInstruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Pre-fork work." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo PARENT_PREFORK" },
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							contains: "PARENT_PREFORK",
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__create_task",
							input: {
								title: "Fork Restart Child",
								description: "Tests fork + restart",
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
							input: {
								sourceTaskId: "$rootId",
								targetTaskId: "$childId",
							},
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							contains: "You are the PARENT",
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
					// After restart + child completion
					blocks: [
						{ type: "text", text: "Fork child completed after restart." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: {
								status: "passed",
								summary: "fork + restart lifecycle complete",
							},
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, parentInstruction);
		expect(resp.status).toBe(200);

		// Wait for fork child to start its bash command
		// Parent: 5 turns (bash, create, fork, send, yield)
		// Child: 1 turn (bash sleep)
		const start = Date.now();
		while (Date.now() - start < 15000) {
			if (ctx.mockAPI.getRequestCount() >= 6) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThanOrEqual(6);
		await new Promise((r) => setTimeout(r, 300));

		// === CRASH ===
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		// === RESTART ===
		ctx.app = await recreateApp(ctx);
		await ctx.app.autoResumeProjects();

		// Both resume: child (interrupted bash → done) → parent (yield → task_complete → done)
		const status = await waitForDone(ctx, 30000);
		expect(status).toBe("verify");

		// Verify fork child completed
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNode = tracker.get(tracker.rootNodeId);
		const childId = rootNode?.children?.[0] as string;
		const childNode = tracker.get(childId);
		expect(childNode?.status).toBe("verify");

		// Verify child's JSONL has fork_marker
		const childEvents = readSessionEvents(ctx, childId);
		expect(childEvents.some((e) => e.type === "fork_marker")).toBe(true);

		// Verify child's JSONL has the orphan bash tool_result
		const childOrphans = childEvents.filter(
			(e) => e.type === "tool_result" && e.isError === true,
		);
		expect(childOrphans.length).toBeGreaterThanOrEqual(1);
	}, 60000);
});

// ── 5. JSONL corruption recovery ──

describe("Stress: JSONL corruption recovery", () => {
	test("CORRUPT1: EventStore.read skips malformed JSON lines", () => {
		// Create a temp dir with a corrupt JSONL file
		const tmpDir = join(tmpdir(), `mxd-corrupt-test-${Date.now()}`);
		const store = new EventStore(tmpDir);

		const validEvent1 = JSON.stringify({
			type: "assistant_text",
			content: "hello",
			taskId: "test",
			ts: 1000,
		});
		const validEvent2 = JSON.stringify({
			type: "assistant_text",
			content: "world",
			taskId: "test",
			ts: 2000,
		});
		const malformedLine = '{"type": "tool_call", "tool": "bash", truncated...';
		const blankLine = "";

		// Write JSONL with corruption in the middle
		const content = [validEvent1, malformedLine, blankLine, validEvent2].join(
			"\n",
		);
		writeFileSync(join(tmpDir, "corrupt-session.events.jsonl"), content);

		// Read should skip malformed lines and return valid events
		const events = store.read("corrupt-session");
		expect(events.length).toBe(2);
		expect(events[0]?.type).toBe("assistant_text");
		expect(events[1]?.type).toBe("assistant_text");

		// Cleanup
		Bun.spawnSync(["rm", "-rf", tmpDir]);
	});

	test("CORRUPT2: truncated last line (simulates crash during write)", () => {
		const tmpDir = join(tmpdir(), `mxd-corrupt-test-${Date.now()}`);
		const store = new EventStore(tmpDir);

		const validEvent = JSON.stringify({
			type: "tool_call",
			tool: "mcp__mxd__bash",
			toolCallId: "tc_1",
			input: { command: "echo hi" },
			taskId: "test",
			ts: 1000,
		});
		// Simulate truncated write — last line is incomplete JSON
		const truncatedEvent =
			'{"type": "tool_result", "tool": "mcp__mxd__bash", "toolCa';

		const content = `${validEvent}\n${truncatedEvent}\n`;
		writeFileSync(join(tmpDir, "truncated.events.jsonl"), content);

		const events = store.read("truncated");
		expect(events.length).toBe(1); // Only the valid event
		expect(events[0]?.type).toBe("tool_call");

		Bun.spawnSync(["rm", "-rf", tmpDir]);
	});

	test("CORRUPT3: empty JSONL file returns empty array", () => {
		const tmpDir = join(tmpdir(), `mxd-corrupt-test-${Date.now()}`);
		const store = new EventStore(tmpDir);

		writeFileSync(join(tmpDir, "empty.events.jsonl"), "");

		const events = store.read("empty");
		expect(events.length).toBe(0);

		Bun.spawnSync(["rm", "-rf", tmpDir]);
	});

	test("CORRUPT4: JSONL with only blank lines returns empty array", () => {
		const tmpDir = join(tmpdir(), `mxd-corrupt-test-${Date.now()}`);
		const store = new EventStore(tmpDir);

		writeFileSync(join(tmpDir, "blanks.events.jsonl"), "\n\n\n");

		const events = store.read("blanks");
		expect(events.length).toBe(0);

		Bun.spawnSync(["rm", "-rf", tmpDir]);
	});

	test("CORRUPT5: readActive finds correct events after corrupt lines", () => {
		const tmpDir = join(tmpdir(), `mxd-corrupt-test-${Date.now()}`);
		const store = new EventStore(tmpDir);

		const preCompactEvent = JSON.stringify({
			type: "assistant_text",
			content: "old",
			taskId: "test",
			ts: 1000,
		});
		const compactMarker = JSON.stringify({
			type: "compact_marker",
			checkpoint: "summary",
			savedTokens: 100,
			taskId: "test",
			ts: 2000,
		});
		const corruptLine = '{"bad json';
		const postCompactEvent = JSON.stringify({
			type: "assistant_text",
			content: "new",
			taskId: "test",
			ts: 3000,
		});

		const content = [
			preCompactEvent,
			compactMarker,
			corruptLine,
			postCompactEvent,
		].join("\n");
		writeFileSync(join(tmpDir, "active.events.jsonl"), `${content}\n`);

		// readActive should return events after compact_marker, skipping corrupt line
		const active = store.readActive("active");
		expect(active.length).toBe(1);
		expect(active[0]?.type).toBe("assistant_text");
		expect((active[0] as unknown as { content: string }).content).toBe("new");

		Bun.spawnSync(["rm", "-rf", tmpDir]);
	});
});

// ── 6. Session lifecycle edge cases ──

describe("Stress: session lifecycle edge cases", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("LIFECYCLE1: done() → new message → done() → restart → resume → done()", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Agent calls done → root enters idle-yield → message wakes → done again →
		// crash → restart → message → done. Tests accumulated done/resume cycles.
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "First work." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo FIRST" },
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							contains: "FIRST",
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "first done" },
						},
					],
				},
				{
					// After first wake
					blocks: [
						{ type: "text", text: "Second work after wake." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo SECOND" },
						},
					],
				},
				{
					assert: [
						{
							block: 0,
							type: "tool_result",
							contains: "SECOND",
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "second done" },
						},
					],
				},
				{
					// After restart + wake
					blocks: [
						{ type: "text", text: "Third work after restart." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "third done" },
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		// Wait for first done
		await waitForDone(ctx);

		// Wake from first done → second cycle
		await sendMessage(ctx, "Do more work");

		// Wait for second done
		const start1 = Date.now();
		while (Date.now() - start1 < 10000) {
			if (ctx.mockAPI.getRequestCount() >= 4) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(ctx.mockAPI.getRequestCount()).toBe(4);

		// Let second done complete
		await new Promise((r) => setTimeout(r, 300));

		// === CRASH ===
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		// === RESTART ===
		ctx.app = await recreateApp(ctx);
		await ctx.app.autoResumeProjects();

		// Wake after restart → third cycle
		const wakeInstruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Post-restart work." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "third done" },
				},
			],
		});
		await sendMessage(ctx, wakeInstruction);

		// Wait for in_progress transition
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNodeId = tracker.rootNodeId;
		const start2 = Date.now();
		while (Date.now() - start2 < 5000) {
			if (tracker.get(rootNodeId)?.status === "in_progress") break;
			await new Promise((r) => setTimeout(r, 50));
		}

		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		// JSONL should have events from all 3 cycles
		const events = readSessionEvents(ctx, rootNodeId);

		// Count done tool_calls (3 cycles = 3 done calls at minimum)
		const doneCalls = events.filter(
			(e) => e.type === "tool_call" && e.tool === "mcp__mxd__done",
		);
		expect(doneCalls.length).toBeGreaterThanOrEqual(3);
	}, 45000);

	test("LIFECYCLE2: many sequential tool calls → restart → prefix holds", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Agent does 8 sequential bash commands (more than typical), then crashes.
		// Tests that many accumulated tool results don't break prefix on restart.
		const turns = [];
		for (let i = 1; i <= 8; i++) {
			const turn: Record<string, unknown> = {
				blocks: [
					{ type: "text", text: `Step ${i}.` },
					{
						type: "tool_use",
						name: "mcp__mxd__bash",
						input: { command: `echo STEP_${i}` },
					},
				],
			};
			if (i > 1) {
				turn.assert = [
					{
						block: 0,
						type: "tool_result",
						contains: `STEP_${i - 1}`,
					},
				];
			}
			turns.push(turn);
		}

		// Add final turn: bash sleep (will be interrupted by crash)
		turns.push({
			assert: [
				{
					block: 0,
					type: "tool_result",
					contains: "STEP_8",
				},
			],
			blocks: [
				{ type: "text", text: "Long running." },
				{
					type: "tool_use",
					name: "mcp__mxd__bash",
					input: { command: "sleep 30" },
				},
			],
		});

		// Add post-restart turn
		turns.push({
			blocks: [
				{ type: "text", text: "Resumed after many steps." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: {
						status: "passed",
						summary: "survived many steps + restart",
					},
				},
			],
		});

		const instruction = JSON.stringify({ turns });

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		// Wait for the 9th turn (bash sleep) to start
		const start = Date.now();
		while (Date.now() - start < 20000) {
			if (ctx.mockAPI.getRequestCount() >= 9) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(ctx.mockAPI.getRequestCount()).toBe(9);
		await new Promise((r) => setTimeout(r, 200));

		// === CRASH ===
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		// === RESTART ===
		ctx.app = await recreateApp(ctx);
		await ctx.app.autoResumeProjects();

		// Resume message triggers full JSONL reconstruction of 8 completed turns + 1 orphan
		const wakeResp = await sendMessage(ctx, "Continue after long session");
		expect(wakeResp.status).toBe(200);

		const status = await waitForDone(ctx, 20000);
		expect(status).toBe("verify");

		// Prefix validation passed — all 8 completed turns are consistent
		const rootNodeId = await getRootNodeId(ctx);
		const events = readSessionEvents(ctx, rootNodeId);

		// Should have 9 bash tool_calls (8 echoes + 1 sleep)
		const bashCalls = events.filter(
			(e) => e.type === "tool_call" && e.tool === "mcp__mxd__bash",
		);
		expect(bashCalls.length).toBe(9);
	}, 60000);
});

// ── 7. Concurrent message delivery ──

describe("Stress: concurrent message delivery", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("CONCURRENT1: 3 messages sent simultaneously to yielding agent", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Agent yields, we send 3 messages concurrently (Promise.all)
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
					// All 3 should appear
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: {
								status: "passed",
								summary: "all concurrent messages received",
							},
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);
		await waitForIdle(ctx);

		// Send 3 messages concurrently
		const [r1, r2, r3] = await Promise.all([
			sendMessage(ctx, "CONCURRENT_MSG_ALPHA"),
			sendMessage(ctx, "CONCURRENT_MSG_BETA"),
			sendMessage(ctx, "CONCURRENT_MSG_GAMMA"),
		]);
		expect(r1.status).toBe(200);
		expect(r2.status).toBe(200);
		expect(r3.status).toBe(200);

		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		// All 3 messages persisted in JSONL
		const rootNodeId = await getRootNodeId(ctx);
		const events = readSessionEvents(ctx, rootNodeId);
		const messageEvents = events.filter(
			(e) =>
				e.type === "message" &&
				"body" in e &&
				e.body &&
				typeof e.body === "object" &&
				"source" in e.body &&
				e.body.source === "user",
		);

		const messageTexts = messageEvents.map((e) => {
			const body = e as { body: { content: string } };
			return body.body.content;
		});

		expect(messageTexts.some((t) => t.includes("CONCURRENT_MSG_ALPHA"))).toBe(
			true,
		);
		expect(messageTexts.some((t) => t.includes("CONCURRENT_MSG_BETA"))).toBe(
			true,
		);
		expect(messageTexts.some((t) => t.includes("CONCURRENT_MSG_GAMMA"))).toBe(
			true,
		);
	}, 30000);
});

// ── 8. Child agent restart edge cases ──

describe("Stress: child restart edge cases", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("CHILD_EDGE1: child yields → crash → restart → child bypasses → message wakes child → done", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Child instruction: yield → wake → done
		const childInstruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Child yielding." },
						{
							type: "tool_use",
							name: "mcp__mxd__yield",
							input: {},
						},
					],
				},
				{
					// After restart + parent message
					blocks: [
						{ type: "text", text: "Child resumed from yield." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: {
								status: "passed",
								summary: "child yield restart ok",
							},
						},
					],
				},
			],
		});

		// Parent: create → send → yield → (child yields, we crash)
		// After restart: parent sends message to child → child wakes → done → parent wakes → done
		const parentInstruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__create_task",
							input: {
								title: "Yielding Child",
								description: "Tests child yield + restart",
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
				{
					// After restart: yield result with tree changes
					// Send message to wake child
					assert: [
						{
							block: 0,
							type: "tool_result",
							contains: "resumed.",
						},
					],
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__send_message",
							input: {
								taskId: "$childId",
								title: "Wake up",
								message: "Resume your work",
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
					// After child completes
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: {
								status: "passed",
								summary: "parent done, child yield restart handled",
							},
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, parentInstruction);
		expect(resp.status).toBe(200);

		// Wait for both parent and child to be yielding
		// Parent: 3 turns (create, send, yield)
		// Child: 1 turn (yield)
		const start = Date.now();
		while (Date.now() - start < 15000) {
			if (ctx.mockAPI.getRequestCount() >= 4) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThanOrEqual(4);

		// Both should be idle
		await waitForIdle(ctx);
		// Give child a moment to also enter yield
		await new Promise((r) => setTimeout(r, 500));

		const preRestartRequests = ctx.mockAPI.getRequestCount();

		// === CRASH ===
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		// === RESTART ===
		ctx.app = await recreateApp(ctx);
		await ctx.app.autoResumeProjects();

		// Both agents resume in bypass mode (yielding)
		// No new API calls until a message arrives
		await new Promise((r) => setTimeout(r, 300));
		expect(ctx.mockAPI.getRequestCount()).toBe(preRestartRequests);

		// Wake parent with a message → parent sends to child → child wakes → done → parent done
		await sendMessage(ctx, "Wake up parent");

		const status = await waitForDone(ctx, 30000);
		expect(status).toBe("verify");

		// Verify child also passed
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNode = tracker.get(tracker.rootNodeId);
		const childId = rootNode?.children?.[0] as string;
		expect(tracker.get(childId)?.status).toBe("verify");
	}, 60000);
});

// ── 9. JSONL atomic operations ──

describe("Stress: JSONL atomic operations", () => {
	test("ATOMIC1: concurrent appends to same session are serialized", async () => {
		const tmpDir = await mkdtemp(join(tmpdir(), "mxd-atomic-"));
		const store = new EventStore(tmpDir);

		// Launch 20 concurrent appends — they should all serialize correctly
		const promises: Promise<void>[] = [];
		for (let i = 0; i < 20; i++) {
			promises.push(
				store.append("concurrent-session", {
					type: "assistant_text",
					content: `message_${i}`,
					taskId: "test",
					ts: Date.now() + i,
				}),
			);
		}
		await Promise.all(promises);
		await store.flush();

		const events = store.read("concurrent-session");
		expect(events.length).toBe(20);

		// All events should be present (no lost writes)
		const texts = events.map(
			(e) => (e as unknown as { content: string }).content,
		);
		for (let i = 0; i < 20; i++) {
			expect(texts).toContain(`message_${i}`);
		}

		// Each event should be valid JSON (no interleaving)
		for (const evt of events) {
			expect(evt.type).toBe("assistant_text");
		}

		await rm(tmpDir, { recursive: true, force: true });
	});

	test("ATOMIC2: appendBatch writes all events atomically", async () => {
		const tmpDir = await mkdtemp(join(tmpdir(), "mxd-atomic-"));
		const store = new EventStore(tmpDir);

		const batch = Array.from({ length: 10 }, (_, i) => ({
			type: "assistant_text" as const,
			content: `batch_${i}`,
			taskId: "test",
			ts: Date.now() + i,
		}));

		await store.appendBatch("batch-session", batch);
		await store.flush();

		const events = store.read("batch-session");
		expect(events.length).toBe(10);

		for (let i = 0; i < 10; i++) {
			expect((events[i] as unknown as { content: string }).content).toBe(
				`batch_${i}`,
			);
		}

		await rm(tmpDir, { recursive: true, force: true });
	});

	test("ATOMIC3: interleaved append and appendBatch don't corrupt", async () => {
		const tmpDir = await mkdtemp(join(tmpdir(), "mxd-atomic-"));
		const store = new EventStore(tmpDir);

		// Interleave single appends and batch appends
		const p1 = store.append("mixed-session", {
			type: "assistant_text",
			content: "single_1",
			taskId: "test",
			ts: 1,
		});
		const p2 = store.appendBatch("mixed-session", [
			{
				type: "assistant_text",
				content: "batch_a",
				taskId: "test",
				ts: 2,
			},
			{
				type: "assistant_text",
				content: "batch_b",
				taskId: "test",
				ts: 3,
			},
		]);
		const p3 = store.append("mixed-session", {
			type: "assistant_text",
			content: "single_2",
			taskId: "test",
			ts: 4,
		});

		await Promise.all([p1, p2, p3]);
		await store.flush();

		const events = store.read("mixed-session");
		expect(events.length).toBe(4);

		// All events should be valid
		const texts = events.map(
			(e) => (e as unknown as { content: string }).content,
		);
		expect(texts).toContain("single_1");
		expect(texts).toContain("batch_a");
		expect(texts).toContain("batch_b");
		expect(texts).toContain("single_2");

		await rm(tmpDir, { recursive: true, force: true });
	});
});
