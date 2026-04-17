/**
 * Thinking + signature consistency tests.
 *
 * TWO LAYERS:
 *
 * 1. **Golden walker tests**: Direct `eventsToAnthropicMessages()` invocation
 *    with synthetic Event[] containing thinking events. Verifies byte-exact
 *    preservation of thinking content and signature through the walker, plus
 *    provider-based filtering.
 *
 * 2. **Drift integration tests**: Full agent loop with mock API returning
 *    thinking blocks, prefix validation, restart, and cache-hit verification.
 *    Proves thinking blocks don't cause live/reconstruction divergence.
 *
 * WHY: Thinking blocks contain encrypted signatures that MUST be preserved
 * byte-for-byte across turns. Any drift between live messages[] and JSONL
 * reconstruction breaks the cache prefix on restart.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { eventsToAnthropicMessages } from "./anthropic-compatible-provider.ts";
import { EventStore } from "./event-store.ts";
import type { Event } from "./events.ts";
import { createMatrixApp as createApp } from "./test-utils/create-matrix-app.ts";
import {
	createMockedProviderWithMock,
	ValidatingMockAPI,
} from "./test-utils/mock-anthropic-api.ts";
import { ulid } from "./ulid.ts";

// ── Realistic signature (long base64 string, matching production format) ──
const MOCK_SIGNATURE_1 =
	"EpUBCkYIAxgCIkD8Y2VjZGM0MjYtNjY1Ny00NTJlLTk5NDAtNjIzMzc4YjFhMTY0LTI4N" +
	"mVhNzJiOGQ0NDRhYmM5MGI2MTgwEgx0aGlua2luZ18yMDI1GglidWlsZGVyXzEiDHRlc3" +
	"RfbW9jaw==";
const MOCK_SIGNATURE_2 =
	"EpUBCkYIAxgCIkA5ZDUzMTMxZC0zNjVhLTQyNDYtYTJmYi1jOWY5ZGViZjYyODEtY2Q0M" +
	"mU5YzlhMzdhNGNiZDgxOGQ2YjI1Egx0aGlua2luZ18yMDI1GglidWlsZGVyXzEiDHRlc3" +
	"RfbW9jaw==";
const MOCK_SIGNATURE_3 =
	"EpUBCkYIAxgCIkBiMzA1NjIwYy02ZjQ0LTRmMzctOGQzYS01NDc5MmFmYjE1NjktNzNlO" +
	"GU0YjMyMjJlNGRjNWE3MzBkN2RhEgx0aGlua2luZ18yMDI1GglidWlsZGVyXzEiDHRlc3" +
	"RfbW9jaw==";

// ── Event helpers ──

function thinkingEvent(
	thinking: string,
	signature: string,
	opts?: { ts?: number; provider?: string },
): Event {
	return {
		type: "thinking",
		thinking,
		signature,
		...(opts?.provider ? { provider: opts.provider } : {}),
		taskId: "",
		ts: opts?.ts ?? 0,
	};
}

function assistantTextEvent(content: string, ts = 0): Event {
	return { type: "assistant_text", content, taskId: "", ts };
}

function toolCallEvent(
	toolCallId: string,
	tool: string,
	input: Record<string, unknown> = {},
	ts = 0,
): Event {
	return { type: "tool_call", toolCallId, tool, input, taskId: "", ts };
}

function toolResultEvent(
	toolCallId: string,
	tool: string,
	content: string,
	ts = 0,
): Event {
	return {
		type: "tool_result",
		toolCallId,
		tool,
		content,
		isError: false,
		taskId: "",
		ts,
	};
}

// ══════════════════════════════════════════════════════════════════════
// GOLDEN WALKER TESTS — thinking blocks
// ══════════════════════════════════════════════════════════════════════

describe("Golden: thinking blocks in walker output", () => {
	test("single thinking block — signature preserved byte-identical", () => {
		const events: Event[] = [
			thinkingEvent("Let me analyze this carefully.", MOCK_SIGNATURE_1, {
				provider: "anthropic",
			}),
			assistantTextEvent("Here's my analysis."),
		];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs).toEqual([
			{
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "Let me analyze this carefully.",
						signature: MOCK_SIGNATURE_1,
					},
					{ type: "text", text: "Here's my analysis." },
				],
			},
		]);
	});

	test("thinking + text + tool_call — full assistant turn", () => {
		const events: Event[] = [
			thinkingEvent("I need to read that file first.", MOCK_SIGNATURE_1, {
				provider: "anthropic",
			}),
			assistantTextEvent("Let me check the file."),
			toolCallEvent("tc_01", "mcp__mxd__read_file", { path: "/src/main.ts" }),
		];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs).toEqual([
			{
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "I need to read that file first.",
						signature: MOCK_SIGNATURE_1,
					},
					{ type: "text", text: "Let me check the file." },
					{
						type: "tool_use",
						id: "tc_01",
						name: "mcp__mxd__read_file",
						input: { path: "/src/main.ts" },
						caller: { type: "direct" },
					},
				],
			},
		]);
	});

	test("legacy thinking without provider field — included (backward compat)", () => {
		// Pre-existing JSONL without provider field → treated as anthropic
		const events: Event[] = [
			thinkingEvent("Legacy thinking content.", MOCK_SIGNATURE_1),
			assistantTextEvent("Legacy response."),
		];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs).toEqual([
			{
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "Legacy thinking content.",
						signature: MOCK_SIGNATURE_1,
					},
					{ type: "text", text: "Legacy response." },
				],
			},
		]);
	});

	test("thinking from different provider — filtered out", () => {
		const events: Event[] = [
			thinkingEvent("OpenAI thinking content.", "openai-sig-xyz", {
				provider: "openai",
			}),
			assistantTextEvent("Response after filtered thinking."),
		];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs).toEqual([
			{
				role: "assistant",
				content: [{ type: "text", text: "Response after filtered thinking." }],
			},
		]);
	});

	test("mixed providers — only anthropic thinking blocks survive", () => {
		const events: Event[] = [
			thinkingEvent("Anthropic thinking.", MOCK_SIGNATURE_1, {
				provider: "anthropic",
			}),
			thinkingEvent("OpenAI thinking.", "openai-sig", { provider: "openai" }),
			assistantTextEvent("Mixed response."),
			toolCallEvent("tc_01", "mcp__mxd__bash", { command: "echo hi" }),
		];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs).toEqual([
			{
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "Anthropic thinking.",
						signature: MOCK_SIGNATURE_1,
					},
					{ type: "text", text: "Mixed response." },
					{
						type: "tool_use",
						id: "tc_01",
						name: "mcp__mxd__bash",
						input: { command: "echo hi" },
						caller: { type: "direct" },
					},
				],
			},
		]);
	});

	test("all thinking blocks filtered → text-only assistant turn", () => {
		const events: Event[] = [
			thinkingEvent("Filtered thinking.", "sig-x", { provider: "openai" }),
			assistantTextEvent("Just the text remains."),
		];
		const msgs = eventsToAnthropicMessages(events);
		const content = (msgs[0] as { content: unknown[] }).content;
		expect(content).toEqual([{ type: "text", text: "Just the text remains." }]);
		// No thinking block in output
		expect(
			content.every(
				(b: unknown) => (b as { type: string }).type !== "thinking",
			),
		).toBe(true);
	});

	test("thinking-only turn from wrong provider → empty assistant fallback", () => {
		// If ALL blocks are thinking from wrong provider, walker pushes empty fallback
		const events: Event[] = [
			thinkingEvent("Filtered.", "sig-x", { provider: "deepseek" }),
		];
		const msgs = eventsToAnthropicMessages(events);
		// Defensive (empty) fallback
		expect(msgs).toEqual([
			{
				role: "assistant",
				content: [{ type: "text", text: "(empty)" }],
			},
		]);
	});
});

describe("Golden: interleaved thinking across multiple tool calls", () => {
	test("thinking → text → tool → result → thinking → text → tool", () => {
		const events: Event[] = [
			// Turn 1: thinking + text + tool_call
			thinkingEvent("First analysis.", MOCK_SIGNATURE_1, {
				provider: "anthropic",
			}),
			assistantTextEvent("Checking file."),
			toolCallEvent("tc_01", "mcp__mxd__read_file", { path: "/a.ts" }),
			// Tool result
			toolResultEvent("tc_01", "mcp__mxd__read_file", "file content here"),
			// Turn 2: thinking + text + tool_call
			thinkingEvent("Now I understand the structure.", MOCK_SIGNATURE_2, {
				provider: "anthropic",
			}),
			assistantTextEvent("Running the command."),
			toolCallEvent("tc_02", "mcp__mxd__bash", { command: "echo done" }),
		];
		const msgs = eventsToAnthropicMessages(events);
		// assistant(thinking+text+tc_01) → user(tool_result) → assistant(thinking+text+tc_02)
		expect(msgs).toHaveLength(3);

		// Turn 1: assistant with thinking
		expect(msgs[0]).toEqual({
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "First analysis.",
					signature: MOCK_SIGNATURE_1,
				},
				{ type: "text", text: "Checking file." },
				{
					type: "tool_use",
					id: "tc_01",
					name: "mcp__mxd__read_file",
					input: { path: "/a.ts" },
					caller: { type: "direct" },
				},
			],
		});

		// Turn 1 result: user message with tool_result
		const userMsg = msgs[1] as { role: string; content: unknown[] };
		expect(userMsg.role).toBe("user");
		expect(userMsg.content[0]).toEqual(
			expect.objectContaining({
				type: "tool_result",
				tool_use_id: "tc_01",
			}),
		);

		// Turn 2: assistant with thinking (different signature)
		expect(msgs[2]).toEqual({
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "Now I understand the structure.",
					signature: MOCK_SIGNATURE_2,
				},
				{ type: "text", text: "Running the command." },
				{
					type: "tool_use",
					id: "tc_02",
					name: "mcp__mxd__bash",
					input: { command: "echo done" },
					caller: { type: "direct" },
				},
			],
		});
	});

	test("three turns with thinking — each has unique signature", () => {
		const events: Event[] = [
			// Turn 1
			thinkingEvent("Turn 1 thinking.", MOCK_SIGNATURE_1, {
				provider: "anthropic",
			}),
			assistantTextEvent("Turn 1 text."),
			toolCallEvent("tc_01", "mcp__mxd__bash", { command: "echo 1" }),
			toolResultEvent("tc_01", "mcp__mxd__bash", "1"),
			// Turn 2
			thinkingEvent("Turn 2 thinking.", MOCK_SIGNATURE_2, {
				provider: "anthropic",
			}),
			assistantTextEvent("Turn 2 text."),
			toolCallEvent("tc_02", "mcp__mxd__bash", { command: "echo 2" }),
			toolResultEvent("tc_02", "mcp__mxd__bash", "2"),
			// Turn 3
			thinkingEvent("Turn 3 thinking.", MOCK_SIGNATURE_3, {
				provider: "anthropic",
			}),
			assistantTextEvent("Turn 3 text."),
			toolCallEvent("tc_03", "mcp__mxd__done", {
				status: "passed",
				summary: "done",
			}),
		];
		const msgs = eventsToAnthropicMessages(events);
		// 3 assistant turns + 2 user turns (tool results) = 5
		expect(msgs).toHaveLength(5);

		// Verify each turn's thinking signature is byte-identical
		const turn1 = msgs[0] as {
			content: Array<{ type: string; signature?: string }>;
		};
		const turn2 = msgs[2] as {
			content: Array<{ type: string; signature?: string }>;
		};
		const turn3 = msgs[4] as {
			content: Array<{ type: string; signature?: string }>;
		};

		expect(turn1.content[0]?.signature).toBe(MOCK_SIGNATURE_1);
		expect(turn2.content[0]?.signature).toBe(MOCK_SIGNATURE_2);
		expect(turn3.content[0]?.signature).toBe(MOCK_SIGNATURE_3);

		// All three signatures are different
		expect(
			new Set([MOCK_SIGNATURE_1, MOCK_SIGNATURE_2, MOCK_SIGNATURE_3]).size,
		).toBe(3);
	});

	test("interleaved providers across turns — only current provider's thinking survives", () => {
		const events: Event[] = [
			// Turn 1: anthropic thinking
			thinkingEvent("Anthropic turn 1.", MOCK_SIGNATURE_1, {
				provider: "anthropic",
			}),
			assistantTextEvent("Text 1."),
			toolCallEvent("tc_01", "mcp__mxd__bash", { command: "echo 1" }),
			toolResultEvent("tc_01", "mcp__mxd__bash", "1"),
			// Turn 2: openai thinking (should be filtered)
			thinkingEvent("OpenAI turn 2.", "openai-sig-2", { provider: "openai" }),
			assistantTextEvent("Text 2."),
			toolCallEvent("tc_02", "mcp__mxd__bash", { command: "echo 2" }),
			toolResultEvent("tc_02", "mcp__mxd__bash", "2"),
			// Turn 3: anthropic thinking
			thinkingEvent("Anthropic turn 3.", MOCK_SIGNATURE_2, {
				provider: "anthropic",
			}),
			assistantTextEvent("Text 3."),
		];
		const msgs = eventsToAnthropicMessages(events);

		// Turn 1: has thinking
		const t1 = (msgs[0] as { content: Array<{ type: string }> }).content;
		expect(t1[0]?.type).toBe("thinking");

		// Turn 2: no thinking (filtered)
		const t2 = (msgs[2] as { content: Array<{ type: string }> }).content;
		expect(t2.every((b) => b.type !== "thinking")).toBe(true);
		expect(t2[0]?.type).toBe("text");

		// Turn 3: has thinking
		const t3 = (msgs[4] as { content: Array<{ type: string }> }).content;
		expect(t3[0]?.type).toBe("thinking");
	});
});

describe("Golden: thinking event provider field preserved through walker", () => {
	test("provider field on AssistantContent items matches event", () => {
		// Verify the walker passes provider through — test by checking the
		// filtering behavior which depends on provider being correctly propagated
		const anthropicEvent = thinkingEvent("A thinking.", MOCK_SIGNATURE_1, {
			provider: "anthropic",
		});
		const openaiEvent = thinkingEvent("O thinking.", "sig-o", {
			provider: "openai",
		});

		// Both in same turn
		const events: Event[] = [
			anthropicEvent,
			openaiEvent,
			assistantTextEvent("text."),
		];
		const msgs = eventsToAnthropicMessages(events);
		const content = (
			msgs[0] as { content: Array<{ type: string; thinking?: string }> }
		).content;

		// Only anthropic thinking survives
		const thinkingBlocks = content.filter((b) => b.type === "thinking");
		expect(thinkingBlocks).toHaveLength(1);
		expect(thinkingBlocks[0]?.thinking).toBe("A thinking.");
	});
});

// ══════════════════════════════════════════════════════════════════════
// DRIFT INTEGRATION TESTS — thinking blocks across restart
// ══════════════════════════════════════════════════════════════════════

interface TestContext {
	dataDir: string;
	projectDir: string;
	app: ReturnType<typeof createApp>;
	mockAPI: ValidatingMockAPI;
	projectId: string;
}

async function setupTestContext(): Promise<TestContext> {
	const dataDir = await mkdtemp(join(tmpdir(), "mxd-think-data-"));
	const projectDir = await mkdtemp(join(tmpdir(), "mxd-think-project-"));

	Bun.spawnSync(["git", "init"], { cwd: projectDir });
	Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
		cwd: projectDir,
	});
	Bun.spawnSync(["git", "config", "user.name", "Test"], {
		cwd: projectDir,
	});
	await Bun.write(
		join(projectDir, ".gitignore"),
		"*\n!/.gitignore\n!/README.md\n!/.mxd/\n!/.mxd/**\n",
	);
	await Bun.write(join(projectDir, "README.md"), "# Test Project\n");
	Bun.spawnSync(["git", "add", "."], { cwd: projectDir });
	Bun.spawnSync(["git", "commit", "-m", "initial"], { cwd: projectDir });

	const mockAPI = new ValidatingMockAPI();
	const provider = createMockedProviderWithMock(mockAPI);
	const projectId = ulid();
	const appResult = createApp({
		dataDir,
		agentProvider: provider,
		projects: [{ id: projectId, name: basename(projectDir), path: projectDir }],
	});

	const tasksDir = join(projectDir, ".mxd", "tasks");
	if (existsSync(tasksDir)) rmSync(tasksDir, { recursive: true });

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

	return {
		dataDir,
		projectDir,
		app: appResult,
		mockAPI,
		projectId,
	};
}

async function teardownTestContext(ctx: TestContext): Promise<void> {
	await ctx.app.shutdown();
	await new Promise((r) => setTimeout(r, 50));
	await rm(ctx.dataDir, { recursive: true, force: true });
	await rm(ctx.projectDir, { recursive: true, force: true });
}

async function waitForDone(
	ctx: TestContext,
	timeoutMs = 15000,
): Promise<string> {
	const tracker = await ctx.app.getTracker(ctx.projectId);
	const rootNodeId = tracker.rootNodeId;
	let prevHadSession = false;
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const rootNode = tracker.getTask(rootNodeId);
		if (rootNode?.status === "verify" || rootNode?.status === "failed") {
			return rootNode.status;
		}
		const hasSession = !!rootNode?.session;
		if (prevHadSession && !hasSession && rootNode?.status === "in_progress") {
			let detail = "(no details)";
			try {
				const events = await readSessionEvents(ctx, rootNodeId);
				const last5 = events
					.slice(-5)
					.map((e) => JSON.stringify(e).slice(0, 400));
				detail = `Last events: ${last5.join(" | ")}`;
			} catch {}
			throw new Error(
				`Agent crashed (session gone, status in_progress). ${detail}`,
			);
		}
		prevHadSession = hasSession;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`Agent did not call done() within ${timeoutMs}ms`);
}

async function waitForIdle(ctx: TestContext, timeoutMs = 10000): Promise<void> {
	const tracker = await ctx.app.getTracker(ctx.projectId);
	const rootNodeId = tracker.rootNodeId;
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const rootNode = tracker.getTask(rootNodeId);
		const queue = rootNode?.session?.queue;
		if (queue?.idle) return;
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

async function readSessionEvents(ctx: TestContext, sessionId: string) {
	const daemonStore = ctx.app.ctx.eventStores.get(ctx.projectId);
	if (daemonStore) await daemonStore.flushSession(sessionId);
	const store = new EventStore(
		join(ctx.dataDir, "projects", ctx.projectId, "tasks"),
	);
	return store.read(sessionId);
}

async function recreateApp(
	ctx: TestContext,
): Promise<ReturnType<typeof createApp>> {
	const provider = createMockedProviderWithMock(ctx.mockAPI);
	const newApp = createApp({
		dataDir: ctx.dataDir,
		agentProvider: provider,
		projects: [
			{
				id: ctx.projectId,
				name: basename(ctx.projectDir),
				path: ctx.projectDir,
			},
		],
	});
	await newApp.autoResumeProjects();
	newApp.markReady();
	return newApp;
}

function wakeDoneInstruction(summary: string) {
	return JSON.stringify({
		blocks: [
			{ type: "text", text: "Woke up, finishing." },
			{
				type: "tool_use",
				name: "mcp__mxd__done",
				input: { status: "passed", summary },
			},
		],
	});
}

describe("Drift: thinking blocks round-trip across restart", () => {
	let ctx: TestContext;
	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("thinking + tool_call: prefix validation passes after restart", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const instruction = JSON.stringify({
			turns: [
				// Turn 1: thinking + text + tool_call
				{
					blocks: [
						{
							type: "thinking",
							thinking: "Analyzing the user request carefully.",
							signature: MOCK_SIGNATURE_1,
						},
						{ type: "text", text: "Let me run a command." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo hello" },
						},
					],
				},
				// Turn 2: thinking + done
				{
					blocks: [
						{
							type: "thinking",
							thinking: "The command succeeded, wrapping up.",
							signature: MOCK_SIGNATURE_2,
						},
						{ type: "text", text: "All done." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "thinking round-trip ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		// Verify thinking events are persisted in JSONL
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const events = await readSessionEvents(ctx, tracker.rootNodeId);
		const thinkingEvents = events.filter((e: Event) => e.type === "thinking");
		expect(thinkingEvents.length).toBe(2);
		expect(
			(thinkingEvents[0] as Extract<Event, { type: "thinking" }>).thinking,
		).toBe("Analyzing the user request carefully.");
		expect(
			(thinkingEvents[0] as Extract<Event, { type: "thinking" }>).signature,
		).toBe(MOCK_SIGNATURE_1);
		expect(
			(thinkingEvents[0] as Extract<Event, { type: "thinking" }>).provider,
		).toBe("anthropic");
		expect(
			(thinkingEvents[1] as Extract<Event, { type: "thinking" }>).thinking,
		).toBe("The command succeeded, wrapping up.");
		expect(
			(thinkingEvents[1] as Extract<Event, { type: "thinking" }>).signature,
		).toBe(MOCK_SIGNATURE_2);

		// Restart: reconstruction must match the live prefix
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		// Send wake message after restart — prefix validation runs on this API call
		await sendMessage(ctx, wakeDoneInstruction("thinking restart ok"));
		const status2 = await waitForDone(ctx);
		expect(status2).toBe("verify");
	}, 30000);

	test("thinking + yield + restart: thinking preserved across yield lifecycle", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const instruction = JSON.stringify({
			turns: [
				// Turn 1: thinking + yield
				{
					blocks: [
						{
							type: "thinking",
							thinking: "I should wait for more information.",
							signature: MOCK_SIGNATURE_1,
						},
						{ type: "text", text: "Waiting for input." },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
					],
				},
				// Turn 2: after wake — thinking + done
				{
					blocks: [
						{
							type: "thinking",
							thinking: "Got the message, finishing up.",
							signature: MOCK_SIGNATURE_2,
						},
						{ type: "text", text: "Received, wrapping up." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "yield+thinking ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		await waitForIdle(ctx);
		await sendMessage(ctx, "Here is more context.");
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		// Restart: reconstruction must match
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, wakeDoneInstruction("yield+thinking restart ok"));
		const status2 = await waitForDone(ctx);
		expect(status2).toBe("verify");
	}, 30000);

	test("multiple tool rounds with thinking each: drift-free across restart", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const instruction = JSON.stringify({
			turns: [
				// Turn 1: thinking + tool
				{
					blocks: [
						{
							type: "thinking",
							thinking: "Step 1: read the file.",
							signature: MOCK_SIGNATURE_1,
						},
						{ type: "text", text: "Reading file." },
						{
							type: "tool_use",
							name: "mcp__mxd__read_file",
							input: { path: "/tmp/test.txt" },
						},
					],
				},
				// Turn 2: thinking + tool
				{
					blocks: [
						{
							type: "thinking",
							thinking: "Step 2: run the test.",
							signature: MOCK_SIGNATURE_2,
						},
						{ type: "text", text: "Running test." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo test" },
						},
					],
				},
				// Turn 3: thinking + done
				{
					blocks: [
						{
							type: "thinking",
							thinking: "Step 3: all complete.",
							signature: MOCK_SIGNATURE_3,
						},
						{ type: "text", text: "Finished." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: {
								status: "passed",
								summary: "multi-round thinking ok",
							},
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		// Verify all 3 thinking events persisted with provider
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const events = await readSessionEvents(ctx, tracker.rootNodeId);
		const thinkingEvents = events.filter((e: Event) => e.type === "thinking");
		expect(thinkingEvents.length).toBe(3);
		for (const te of thinkingEvents) {
			expect((te as Extract<Event, { type: "thinking" }>).provider).toBe(
				"anthropic",
			);
		}

		// Restart + prefix validation
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(
			ctx,
			wakeDoneInstruction("multi-round thinking restart ok"),
		);
		const status2 = await waitForDone(ctx);
		expect(status2).toBe("verify");
	}, 30000);

	test("thinking with special characters in content: preserved byte-identical", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const specialContent =
			'Thinking with "quotes", newlines\n\nand <xml> tags & unicode: 你好世界 🧠';

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "thinking",
							thinking: specialContent,
							signature: MOCK_SIGNATURE_1,
						},
						{ type: "text", text: "Done thinking." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "special chars ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		// Verify exact content preserved in JSONL
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const events = await readSessionEvents(ctx, tracker.rootNodeId);
		const te = events.find((e: Event) => e.type === "thinking") as Extract<
			Event,
			{ type: "thinking" }
		>;
		expect(te).toBeDefined();
		expect(te.thinking).toBe(specialContent);
		expect(te.signature).toBe(MOCK_SIGNATURE_1);

		// Restart
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, wakeDoneInstruction("special chars restart ok"));
		const status2 = await waitForDone(ctx);
		expect(status2).toBe("verify");
	}, 30000);
});

// ── Redacted thinking golden snapshots ──
// Guards the JSONL redacted flag distinction that prevents live/reconstruction drift.

describe("walker: redacted vs display:omitted thinking", () => {
	function userEvents(id: string, content: string, ts = 1000): Event[] {
		return [
			{
				type: "message",
				id,
				taskId: "",
				body: { source: "user", id, ts, content },
				ts,
			},
			{ type: "messages_consumed", messageIds: [id], taskId: "", ts: ts + 1 },
		];
	}

	function thinkEvent(
		thinking: string,
		signature: string,
		opts?: { redacted?: boolean; ts?: number },
	): Event {
		return {
			type: "thinking",
			thinking,
			signature,
			...(opts?.redacted ? { redacted: true } : {}),
			taskId: "",
			ts: opts?.ts ?? 2000,
		};
	}

	test("display:omitted (empty thinking, no redacted flag) → { type: 'thinking', thinking: '', signature }", () => {
		const events: Event[] = [
			...userEvents("p1", "hello"),
			thinkEvent("", "sig-omitted"),
			{ type: "assistant_text", content: "result", taskId: "", ts: 2001 },
		];
		const messages = eventsToAnthropicMessages(events);

		// biome-ignore lint/suspicious/noExplicitAny: test assertion
		const assistant = messages[1] as any;
		const thinkingBlock = assistant.content[0];

		// Must be type: "thinking" — matches live path (SDK finalMessage returns type:"thinking")
		expect(thinkingBlock).toEqual({
			type: "thinking",
			thinking: "",
			signature: "sig-omitted",
		});
	});

	test("redacted_thinking (redacted: true) → { type: 'redacted_thinking', data }", () => {
		const events: Event[] = [
			...userEvents("p1", "hello"),
			thinkEvent("", "encrypted-data-blob", { redacted: true }),
			{ type: "assistant_text", content: "I can help", taskId: "", ts: 2001 },
		];
		const messages = eventsToAnthropicMessages(events);

		// biome-ignore lint/suspicious/noExplicitAny: test assertion
		const assistant = messages[1] as any;
		const redactedBlock = assistant.content[0];

		// Must be type: "redacted_thinking" — API expects this format for round-trip
		expect(redactedBlock).toEqual({
			type: "redacted_thinking",
			data: "encrypted-data-blob",
		});
	});

	test("redacted + normal thinking in same turn → correct types for each", () => {
		const events: Event[] = [
			...userEvents("p1", "complex query"),
			thinkEvent("", "redacted-data-1", { redacted: true, ts: 2000 }),
			thinkEvent("visible reasoning", "sig-normal", { ts: 2001 }),
			{ type: "assistant_text", content: "answer", taskId: "", ts: 2002 },
		];
		const messages = eventsToAnthropicMessages(events);

		// biome-ignore lint/suspicious/noExplicitAny: test assertion
		const assistant = messages[1] as any;
		expect(assistant.content).toHaveLength(3);

		expect(assistant.content[0]).toEqual({
			type: "redacted_thinking",
			data: "redacted-data-1",
		});
		expect(assistant.content[1]).toEqual({
			type: "thinking",
			thinking: "visible reasoning",
			signature: "sig-normal",
		});
		expect(assistant.content[2]).toEqual({
			type: "text",
			text: "answer",
		});
	});
});
