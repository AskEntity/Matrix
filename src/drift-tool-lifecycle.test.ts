/**
 * Drift-prevention + correctness tests: tool lifecycle scenarios.
 *
 * TWO test categories:
 *
 * 1. GOLDEN SNAPSHOT UNIT TESTS (fast, deterministic):
 *    Construct known tool_call + tool_result event sequences, walk them with
 *    `eventsToAnthropicMessages`, and assert EXACT byte-level output.
 *    These catch correctness bugs: walker producing wrong block ordering,
 *    missing caption, wrong is_error presence/absence, etc.
 *    Would have caught the caption bug directly (no restart needed).
 *
 * 2. INTEGRATION PREFIX-VALIDATION TESTS (slow, end-to-end):
 *    Run the agent through a scenario → restart app → wake agent. The
 *    ValidatingMockAPI's prefix validation throws if reconstructed prefix
 *    differs from live-path output. These catch DRIFT between walker and
 *    any non-walker codepaths (initial drain, buildSessionRepair, cache
 *    control, etc.).
 *
 * Architecture: `buildUserTurn` in anthropic-compatible-provider.ts
 * delegates to walker callbacks by constructing synthetic events via
 * `buildToolResultEvents` and walking them with `eventsToAnthropicMessages`.
 * Live path has no independent construction logic. Walker callbacks
 * (`onToolResults`, `onConsumedMessages`, `isAnthropicWorkingContext`) are
 * the SINGLE source of truth for Anthropic user-message construction.
 *
 * Since live delegates to walker, prefix-validation tests cannot catch
 * walker-internal correctness bugs (both paths would produce same wrong
 * output → validation passes). Golden snapshots fill that gap.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventsToAnthropicMessages } from "./anthropic-compatible-provider.ts";
import { createApp } from "./daemon.ts";
import type { Event } from "./events.ts";
import {
	createMockedProviderWithMock,
	ValidatingMockAPI,
} from "./test-utils/mock-anthropic-api.ts";

// ── Test infrastructure (mirrors integration.test.ts) ──

interface TestContext {
	dataDir: string;
	projectDir: string;
	app: ReturnType<typeof createApp>;
	mockAPI: ValidatingMockAPI;
	projectId: string;
}

async function setupTestContext(): Promise<TestContext> {
	const dataDir = await mkdtemp(join(tmpdir(), "mxd-drift-tool-data-"));
	const projectDir = await mkdtemp(join(tmpdir(), "mxd-drift-tool-project-"));

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

	const tasksDir = join(projectDir, ".mxd", "tasks");
	if (existsSync(tasksDir)) {
		rmSync(tasksDir, { recursive: true });
	}

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
			throw new Error(
				`Agent crashed (session gone, status still in_progress). Task: ${ctx.projectDir}`,
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
		if (queue?.idle) {
			return;
		}
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

async function sendMessageWithImages(
	ctx: TestContext,
	message: string,
	images: Array<{ base64: string; mediaType: string }>,
): Promise<Response> {
	const tracker = await ctx.app.getTracker(ctx.projectId);
	const rootNodeId = tracker.rootNodeId;
	return ctx.app.app.request(
		`/projects/${ctx.projectId}/tasks/${rootNodeId}/message`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: message, images }),
		},
	);
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

// Tiny 1x1 PNG for image tests
const TINY_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function writeTestImage(ctx: TestContext, name: string): Promise<string> {
	const buf = Buffer.from(TINY_PNG, "base64");
	const p = join(ctx.projectDir, name);
	await Bun.write(p, buf);
	return p;
}

// Standard wake instruction for tests — just calls done() after restart.
// Short enough that timestamp differences in surrounding messages don't matter.
const WAKE_DONE = JSON.stringify({
	blocks: [
		{ type: "text", text: "Surviving restart." },
		{
			type: "tool_use",
			name: "mcp__mxd__done",
			input: { status: "passed", summary: "prefix validated after restart" },
		},
	],
});

// ── Tests ──

// ── Golden snapshot helpers ──

/**
 * Build a pair of events for a consumed user prompt:
 * - message event (deferred by walker because it has id)
 * - messages_consumed event (materializes the message via onConsumedMessages/onUserMessage)
 * This is how production writes user messages to JSONL.
 */
function userPromptEvents(
	id: string,
	content: string,
	ts = 1000,
	images?: Array<{ base64: string; mediaType: string }>,
): Event[] {
	return [
		{
			type: "message",
			id,
			taskId: "",
			body: { source: "user", id, ts, content, ...(images ? { images } : {}) },
			ts,
		},
		{
			type: "messages_consumed",
			messageIds: [id],
			taskId: "",
			ts: ts + 1,
		},
	];
}

/** Build an assistant tool_call event. */
function toolCallEvent(
	toolCallId: string,
	tool: string,
	input: Record<string, unknown>,
	ts = 2000,
): Event {
	return {
		type: "tool_call",
		tool,
		toolCallId,
		input,
		taskId: "",
		ts,
	};
}

/** Build an assistant text event. */
function assistantTextEvent(content: string, ts = 1500): Event {
	return {
		type: "assistant_text",
		content,
		taskId: "",
		ts,
	};
}

/** Build a tool_result event (optionally with images). */
function toolResultEvent(
	toolCallId: string,
	tool: string,
	content: string,
	isError: boolean,
	opts: {
		images?: Array<{ base64: string; mediaType: string }>;
		backgroundId?: string;
		backgroundCommand?: string;
	} = {},
	ts = 3000,
): Event {
	return {
		type: "tool_result",
		tool,
		toolCallId,
		content,
		isError,
		taskId: "",
		ts,
		...(opts.images ? { images: opts.images } : {}),
		...(opts.backgroundId ? { backgroundId: opts.backgroundId } : {}),
		...(opts.backgroundCommand
			? { backgroundCommand: opts.backgroundCommand }
			: {}),
	};
}

// ── Golden Snapshot Tests: exact byte-level walker output ──

describe("Golden snapshots: eventsToAnthropicMessages output", () => {
	test("Simple user → assistant text: string user content, array assistant content", () => {
		const events: Event[] = [
			...userPromptEvents("p1", "hi"),
			assistantTextEvent("hello there"),
		];
		const messages = eventsToAnthropicMessages(events);

		expect(messages).toEqual([
			// User message: the formatter adds a [HH:MM:SS] timestamp prefix.
			// We assert the shape here and check the prefix format separately.
			{
				role: "user",
				content: expect.stringMatching(/^\[\d{2}:\d{2}:\d{2}\] hi$/) as string,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "hello there" }],
			},
		]);
	});

	test("Text tool_result: is_error field present, no images, string content", () => {
		const events: Event[] = [
			...userPromptEvents("p1", "run bash"),
			assistantTextEvent("running"),
			toolCallEvent("t1", "mcp__mxd__bash", { command: "echo ok" }),
			toolResultEvent("t1", "mcp__mxd__bash", "ok\n", false),
		];
		const messages = eventsToAnthropicMessages(events);

		// Exact shape for tool_result user message: must have is_error field
		expect(messages).toHaveLength(3);
		const toolResultMsg = messages[2];
		expect(toolResultMsg).toEqual({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "t1",
					content: "ok\n",
					is_error: false,
				},
			],
		});
	});

	test("Error tool_result: is_error: true, no images", () => {
		const events: Event[] = [
			...userPromptEvents("p1", "fail"),
			toolCallEvent("t1", "mcp__mxd__bash", { command: "false" }),
			toolResultEvent("t1", "mcp__mxd__bash", "command failed", true),
		];
		const messages = eventsToAnthropicMessages(events);

		const toolResultMsg = messages[messages.length - 1];
		expect(toolResultMsg).toEqual({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "t1",
					content: "command failed",
					is_error: true,
				},
			],
		});
	});

	test("Image tool_result: NO is_error field, images first then text", () => {
		const events: Event[] = [
			...userPromptEvents("p1", "read image"),
			toolCallEvent("t1", "mcp__mxd__read_file", { path: "/x.png" }),
			toolResultEvent("t1", "mcp__mxd__read_file", "[Image: x.png]", false, {
				images: [{ base64: "IMGDATA", mediaType: "image/png" }],
			}),
		];
		const messages = eventsToAnthropicMessages(events);

		const toolResultMsg = messages[messages.length - 1];
		// Crucial: NO is_error field for image tool_results (3 keys: type, tool_use_id, content).
		// Live path in buildUserTurn omits is_error when content is an array of blocks.
		// Walker MUST match — one extra key = prefix mismatch + cache miss.
		expect(toolResultMsg).toEqual({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "t1",
					content: [
						{
							type: "image",
							source: {
								type: "base64",
								media_type: "image/png",
								data: "IMGDATA",
							},
						},
						{ type: "text", text: "[Image: x.png]" },
					],
				},
			],
		});

		// Explicit: assert is_error key is absent (Object.keys strict check)
		const block = (toolResultMsg as { content: unknown[] })
			.content[0] as Record<string, unknown>;
		expect(Object.keys(block).sort()).toEqual([
			"content",
			"tool_use_id",
			"type",
		]);
	});

	test("Image tool_result with multiple images + text: images first, text last", () => {
		const events: Event[] = [
			...userPromptEvents("p1", "read images"),
			toolCallEvent("t1", "mcp__mxd__read_file", { path: "/y.png" }),
			toolResultEvent("t1", "mcp__mxd__read_file", "Two images read", false, {
				images: [
					{ base64: "A", mediaType: "image/png" },
					{ base64: "B", mediaType: "image/jpeg" },
				],
			}),
		];
		const messages = eventsToAnthropicMessages(events);
		const trMsg = messages[messages.length - 1] as {
			role: string;
			content: unknown[];
		};

		// Order: [img1, img2, text] — text is LAST after images
		expect(trMsg.content).toEqual([
			{
				type: "tool_result",
				tool_use_id: "t1",
				content: [
					{
						type: "image",
						source: { type: "base64", media_type: "image/png", data: "A" },
					},
					{
						type: "image",
						source: { type: "base64", media_type: "image/jpeg", data: "B" },
					},
					{ type: "text", text: "Two images read" },
				],
			},
		]);
	});

	test("Empty tool_result content → '(empty)' fallback for image case", () => {
		const events: Event[] = [
			...userPromptEvents("p1", "img"),
			toolCallEvent("t1", "mcp__mxd__read_file", { path: "/z.png" }),
			toolResultEvent("t1", "mcp__mxd__read_file", "", false, {
				images: [{ base64: "Z", mediaType: "image/png" }],
			}),
		];
		const messages = eventsToAnthropicMessages(events);
		const trMsg = messages[messages.length - 1] as { content: unknown[] };
		const block = trMsg.content[0] as { content: unknown[] };
		// Empty content string is replaced with "(empty)" inside image tool_results
		expect(block.content[1]).toEqual({ type: "text", text: "(empty)" });
	});

	test("Empty tool_result content → '(empty)' fallback for text case", () => {
		const events: Event[] = [
			...userPromptEvents("p1", "x"),
			toolCallEvent("t1", "mcp__mxd__bash", { command: "true" }),
			toolResultEvent("t1", "mcp__mxd__bash", "", false),
		];
		const messages = eventsToAnthropicMessages(events);
		const trMsg = messages[messages.length - 1] as { content: unknown[] };
		expect(trMsg.content[0]).toEqual({
			type: "tool_result",
			tool_use_id: "t1",
			content: "(empty)",
			is_error: false,
		});
	});

	test("Multiple tool_results in same user message: single user message with N blocks", () => {
		const events: Event[] = [
			...userPromptEvents("p1", "multi"),
			toolCallEvent("t1", "mcp__mxd__bash", { command: "echo 1" }, 2000),
			toolCallEvent("t2", "mcp__mxd__bash", { command: "echo 2" }, 2001),
			toolCallEvent("t3", "mcp__mxd__bash", { command: "echo 3" }, 2002),
			toolResultEvent("t1", "mcp__mxd__bash", "1\n", false, {}, 3000),
			toolResultEvent("t2", "mcp__mxd__bash", "2\n", false, {}, 3001),
			toolResultEvent("t3", "mcp__mxd__bash", "3\n", false, {}, 3002),
		];
		const messages = eventsToAnthropicMessages(events);
		// user prompt, assistant(3 tool_uses), user(3 tool_results)
		expect(messages).toHaveLength(3);
		const toolResultMsg = messages[2] as { role: string; content: unknown[] };
		expect(toolResultMsg.role).toBe("user");
		expect(toolResultMsg.content).toEqual([
			{
				type: "tool_result",
				tool_use_id: "t1",
				content: "1\n",
				is_error: false,
			},
			{
				type: "tool_result",
				tool_use_id: "t2",
				content: "2\n",
				is_error: false,
			},
			{
				type: "tool_result",
				tool_use_id: "t3",
				content: "3\n",
				is_error: false,
			},
		]);
	});

	test("Mixed success/error in one turn: is_error values correct per block", () => {
		const events: Event[] = [
			...userPromptEvents("p1", "mixed"),
			toolCallEvent("t1", "mcp__mxd__bash", { command: "ok" }, 2000),
			toolCallEvent("t2", "mcp__mxd__bash", { command: "fail" }, 2001),
			toolResultEvent("t1", "mcp__mxd__bash", "ok", false, {}, 3000),
			toolResultEvent("t2", "mcp__mxd__bash", "fail", true, {}, 3001),
		];
		const messages = eventsToAnthropicMessages(events);
		const trMsg = messages[messages.length - 1] as { content: unknown[] };
		expect(trMsg.content).toEqual([
			{
				type: "tool_result",
				tool_use_id: "t1",
				content: "ok",
				is_error: false,
			},
			{
				type: "tool_result",
				tool_use_id: "t2",
				content: "fail",
				is_error: true,
			},
		]);
	});

	test("Image tool_result interleaved with text tool_result (same turn)", () => {
		const events: Event[] = [
			...userPromptEvents("p1", "mixed-image"),
			toolCallEvent("t1", "mcp__mxd__bash", { command: "echo a" }, 2000),
			toolCallEvent("t2", "mcp__mxd__read_file", { path: "/i.png" }, 2001),
			toolCallEvent("t3", "mcp__mxd__bash", { command: "echo b" }, 2002),
			toolResultEvent("t1", "mcp__mxd__bash", "a", false, {}, 3000),
			toolResultEvent(
				"t2",
				"mcp__mxd__read_file",
				"[Image]",
				false,
				{
					images: [{ base64: "IMG", mediaType: "image/png" }],
				},
				3001,
			),
			toolResultEvent("t3", "mcp__mxd__bash", "b", false, {}, 3002),
		];
		const messages = eventsToAnthropicMessages(events);
		const trMsg = messages[messages.length - 1] as { content: unknown[] };
		// Each block's shape is independent: text ones have is_error, image one does NOT.
		expect(trMsg.content).toHaveLength(3);
		expect(trMsg.content[0]).toEqual({
			type: "tool_result",
			tool_use_id: "t1",
			content: "a",
			is_error: false,
		});
		// Image block: NO is_error
		expect(Object.keys(trMsg.content[1] as object).sort()).toEqual([
			"content",
			"tool_use_id",
			"type",
		]);
		expect(trMsg.content[2]).toEqual({
			type: "tool_result",
			tool_use_id: "t3",
			content: "b",
			is_error: false,
		});
	});

	test("tool_result with messages_consumed (no images) — interleaved text AFTER tool_results, no caption", () => {
		// Simulate queue text message arriving during tool exec → drained at cancellation point
		const events: Event[] = [
			...userPromptEvents("p1", "go"),
			toolCallEvent("t1", "mcp__mxd__bash", { command: "sleep" }, 2000),
			toolResultEvent("t1", "mcp__mxd__bash", "slept", false, {}, 3000),
			// Queue user message arrived during tool exec
			{
				type: "message",
				id: "q1",
				taskId: "",
				body: {
					source: "user",
					id: "q1",
					ts: 3001,
					content: "injected_text",
				},
				ts: 3001,
			},
			{
				type: "messages_consumed",
				messageIds: ["q1"],
				taskId: "",
				ts: 3002,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		// Walker groups tool_result + messages_consumed into ONE user message
		const trMsg = messages[messages.length - 1] as {
			role: string;
			content: unknown[];
		};
		expect(trMsg.role).toBe("user");
		expect(trMsg.content).toHaveLength(2);
		// First: the tool_result
		expect(trMsg.content[0]).toEqual({
			type: "tool_result",
			tool_use_id: "t1",
			content: "slept",
			is_error: false,
		});
		// Second: interleaved text block (the queue message text)
		expect(trMsg.content[1]).toEqual({
			type: "text",
			text: expect.stringMatching(
				/^\[\d{2}:\d{2}:\d{2}\] injected_text$/,
			) as string,
		});
		// NO caption — no images in queue
	});

	test("tool_result with queue image — caption present, correct order", () => {
		const events: Event[] = [
			...userPromptEvents("p1", "go"),
			toolCallEvent("t1", "mcp__mxd__bash", { command: "sleep" }, 2000),
			toolResultEvent("t1", "mcp__mxd__bash", "slept", false, {}, 3000),
			// Queue user message with image
			{
				type: "message",
				id: "q1",
				taskId: "",
				body: {
					source: "user",
					id: "q1",
					ts: 3001,
					content: "look at this",
					images: [{ base64: "QIMG", mediaType: "image/png" }],
				},
				ts: 3001,
			},
			{
				type: "messages_consumed",
				messageIds: ["q1"],
				taskId: "",
				ts: 3002,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		const trMsg = messages[messages.length - 1] as {
			role: string;
			content: unknown[];
		};
		// Order: [tool_result, queue_text, queue_image, caption]
		expect(trMsg.content).toHaveLength(4);
		expect(trMsg.content[0]).toEqual({
			type: "tool_result",
			tool_use_id: "t1",
			content: "slept",
			is_error: false,
		});
		expect(trMsg.content[1]).toEqual({
			type: "text",
			text: expect.stringMatching(
				/^\[\d{2}:\d{2}:\d{2}\] look at this$/,
			) as string,
		});
		expect(trMsg.content[2]).toEqual({
			type: "image",
			source: {
				type: "base64",
				media_type: "image/png",
				data: "QIMG",
			},
		});
		// THE CAPTION: this is what the original bug missed
		expect(trMsg.content[3]).toEqual({
			type: "text",
			text: "[1 image(s) attached by user]",
		});
	});

	test("tool_result with MULTIPLE queue images — caption count matches", () => {
		const events: Event[] = [
			...userPromptEvents("p1", "go"),
			toolCallEvent("t1", "mcp__mxd__bash", { command: "sleep" }, 2000),
			toolResultEvent("t1", "mcp__mxd__bash", "slept", false, {}, 3000),
			// Queue user message with 3 images
			{
				type: "message",
				id: "q1",
				taskId: "",
				body: {
					source: "user",
					id: "q1",
					ts: 3001,
					content: "three images",
					images: [
						{ base64: "A", mediaType: "image/png" },
						{ base64: "B", mediaType: "image/jpeg" },
						{ base64: "C", mediaType: "image/webp" },
					],
				},
				ts: 3001,
			},
			{
				type: "messages_consumed",
				messageIds: ["q1"],
				taskId: "",
				ts: 3002,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		const trMsg = messages[messages.length - 1] as { content: unknown[] };
		// [tool_result, text, img1, img2, img3, caption]
		expect(trMsg.content).toHaveLength(6);
		expect(trMsg.content[5]).toEqual({
			type: "text",
			text: "[3 image(s) attached by user]",
		});
	});

	test("tool_result + multiple queue messages (mixed images/text) — caption total count", () => {
		const events: Event[] = [
			...userPromptEvents("p1", "go"),
			toolCallEvent("t1", "mcp__mxd__bash", { command: "sleep" }, 2000),
			toolResultEvent("t1", "mcp__mxd__bash", "slept", false, {}, 3000),
			{
				type: "message",
				id: "q1",
				taskId: "",
				body: {
					source: "user",
					id: "q1",
					ts: 3001,
					content: "msg1 with img",
					images: [{ base64: "X", mediaType: "image/png" }],
				},
				ts: 3001,
			},
			{
				type: "message",
				id: "q2",
				taskId: "",
				body: {
					source: "user",
					id: "q2",
					ts: 3002,
					content: "msg2 text only",
				},
				ts: 3002,
			},
			{
				type: "message",
				id: "q3",
				taskId: "",
				body: {
					source: "user",
					id: "q3",
					ts: 3003,
					content: "msg3 with 2 imgs",
					images: [
						{ base64: "Y", mediaType: "image/png" },
						{ base64: "Z", mediaType: "image/jpeg" },
					],
				},
				ts: 3003,
			},
			{
				type: "messages_consumed",
				messageIds: ["q1", "q2", "q3"],
				taskId: "",
				ts: 3004,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		const trMsg = messages[messages.length - 1] as { content: unknown[] };
		// Last block: caption with total image count (1 + 0 + 2 = 3)
		const last = trMsg.content[trMsg.content.length - 1];
		expect(last).toEqual({
			type: "text",
			text: "[3 image(s) attached by user]",
		});
		// All 3 text blocks should be present before images
		const textBlocks = (
			trMsg.content as Array<{ type: string; text?: string }>
		).filter((b) => b.type === "text" && !b.text?.includes("image(s)"));
		expect(textBlocks).toHaveLength(3);
		// All 3 image blocks should be present
		const imageBlocks = (trMsg.content as Array<{ type: string }>).filter(
			(b) => b.type === "image",
		);
		expect(imageBlocks).toHaveLength(3);
	});

	test("onConsumedMessages idle context: single text → string content", () => {
		// After end_turn, queue message arrives → idle context.
		// Walker's onConsumedMessages creates a new user message.
		// Single text, no images → string content (matches live).
		const events: Event[] = [
			...userPromptEvents("p1", "start"),
			assistantTextEvent("waiting"),
			// end_turn — no tool_call. Then image message arrives.
			{
				type: "message",
				id: "q1",
				taskId: "",
				body: {
					source: "user",
					id: "q1",
					ts: 4000,
					content: "woke",
				},
				ts: 4000,
			},
			{
				type: "messages_consumed",
				messageIds: ["q1"],
				taskId: "",
				ts: 4001,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		// user, assistant, user (new one from idle branch)
		expect(messages).toHaveLength(3);
		const wakeMsg = messages[2] as { role: string; content: unknown };
		expect(wakeMsg.role).toBe("user");
		// Single text in idle context → string content
		expect(typeof wakeMsg.content).toBe("string");
		expect(wakeMsg.content).toMatch(/^\[\d{2}:\d{2}:\d{2}\] woke$/);
	});

	test("onConsumedMessages idle context: image → array content WITH caption (THE BUG)", () => {
		// THIS IS THE ORIGINAL BUG — reconstructed idle-context image message
		// was MISSING the caption text block. Now it must be present.
		const events: Event[] = [
			...userPromptEvents("p1", "start"),
			assistantTextEvent("waiting"),
			{
				type: "message",
				id: "q1",
				taskId: "",
				body: {
					source: "user",
					id: "q1",
					ts: 4000,
					content: "here is image",
					images: [{ base64: "PNG1", mediaType: "image/png" }],
				},
				ts: 4000,
			},
			{
				type: "messages_consumed",
				messageIds: ["q1"],
				taskId: "",
				ts: 4001,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toHaveLength(3);
		const wakeMsg = messages[2] as { role: string; content: unknown[] };
		expect(wakeMsg.role).toBe("user");
		// Must be array: [text, image, caption]
		expect(Array.isArray(wakeMsg.content)).toBe(true);
		expect(wakeMsg.content).toHaveLength(3);
		expect(wakeMsg.content[0]).toEqual({
			type: "text",
			text: expect.stringMatching(
				/^\[\d{2}:\d{2}:\d{2}\] here is image$/,
			) as string,
		});
		expect(wakeMsg.content[1]).toEqual({
			type: "image",
			source: { type: "base64", media_type: "image/png", data: "PNG1" },
		});
		// THE CAPTION — original bug was missing this block
		expect(wakeMsg.content[2]).toEqual({
			type: "text",
			text: "[1 image(s) attached by user]",
		});
	});

	test("onConsumedMessages idle context: multiple texts (no image) → array content, no caption", () => {
		const events: Event[] = [
			...userPromptEvents("p1", "start"),
			assistantTextEvent("waiting"),
			{
				type: "message",
				id: "q1",
				taskId: "",
				body: { source: "user", id: "q1", ts: 4000, content: "msg one" },
				ts: 4000,
			},
			{
				type: "message",
				id: "q2",
				taskId: "",
				body: { source: "user", id: "q2", ts: 4001, content: "msg two" },
				ts: 4001,
			},
			{
				type: "messages_consumed",
				messageIds: ["q1", "q2"],
				taskId: "",
				ts: 4002,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		const wakeMsg = messages[2] as { role: string; content: unknown[] };
		expect(Array.isArray(wakeMsg.content)).toBe(true);
		expect(wakeMsg.content).toHaveLength(2);
		expect(wakeMsg.content[0]).toEqual({
			type: "text",
			text: expect.stringMatching(/^\[\d{2}:\d{2}:\d{2}\] msg one$/) as string,
		});
		expect(wakeMsg.content[1]).toEqual({
			type: "text",
			text: expect.stringMatching(/^\[\d{2}:\d{2}:\d{2}\] msg two$/) as string,
		});
		// No caption — no images
	});

	test("Assistant message with tool_use blocks: id, name, input, caller fields", () => {
		const events: Event[] = [
			...userPromptEvents("p1", "p"),
			assistantTextEvent("calling tool"),
			toolCallEvent("t1", "mcp__mxd__bash", { command: "echo x" }),
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toHaveLength(2);
		const asstMsg = messages[1] as { role: string; content: unknown[] };
		expect(asstMsg.role).toBe("assistant");
		expect(asstMsg.content).toEqual([
			{ type: "text", text: "calling tool" },
			{
				type: "tool_use",
				id: "t1",
				name: "mcp__mxd__bash",
				input: { command: "echo x" },
				caller: { type: "direct" },
			},
		]);
	});

	test("Defensive: empty assistant content → inserts (empty) text block", () => {
		// Walker's onAssistantContent has a defensive fallback for empty blocks.
		// We can't directly trigger this from normal flow, but if it happens,
		// result must have at least one block to avoid Anthropic API 400.
		// This is hard to reach via walker — skipped direct unit test.
		// Instead, verify via an assistant_text with empty string:
		const events: Event[] = [
			...userPromptEvents("p1", "p"),
			assistantTextEvent(""),
		];
		const messages = eventsToAnthropicMessages(events);
		const asstMsg = messages[1] as { role: string; content: unknown[] };
		// Empty string is still a text block (not empty blocks array)
		expect(asstMsg.content).toEqual([{ type: "text", text: "" }]);
	});

	test("Thinking blocks preserved in assistant message", () => {
		const events: Event[] = [
			...userPromptEvents("p1", "p"),
			{
				type: "thinking",
				thinking: "let me think",
				signature: "sig123",
				taskId: "",
				ts: 1500,
			},
			assistantTextEvent("answer"),
		];
		const messages = eventsToAnthropicMessages(events);
		const asstMsg = messages[1] as { role: string; content: unknown[] };
		expect(asstMsg.content).toEqual([
			{ type: "thinking", thinking: "let me think", signature: "sig123" },
			{ type: "text", text: "answer" },
		]);
	});

	test("Background tool_result: backgroundId/backgroundCommand don't leak into API output", () => {
		// backgroundId/backgroundCommand are metadata on the event but should NOT
		// appear in the Anthropic API tool_result block.
		const events: Event[] = [
			...userPromptEvents("p1", "p"),
			toolCallEvent("t1", "mcp__mxd__bash", { command: "sleep 100" }),
			toolResultEvent("t1", "mcp__mxd__bash", "moved to background", false, {
				backgroundId: "bg-123",
				backgroundCommand: "sleep 100",
			}),
		];
		const messages = eventsToAnthropicMessages(events);
		const trMsg = messages[messages.length - 1] as { content: unknown[] };
		const block = trMsg.content[0] as Record<string, unknown>;
		// Should NOT contain backgroundId or backgroundCommand
		expect(block).toEqual({
			type: "tool_result",
			tool_use_id: "t1",
			content: "moved to background",
			is_error: false,
		});
		expect(block.backgroundId).toBeUndefined();
		expect(block.backgroundCommand).toBeUndefined();
	});

	test("Key ordering: tool_result (text) has exactly {type, tool_use_id, content, is_error}", () => {
		const events: Event[] = [
			...userPromptEvents("p1", "x"),
			toolCallEvent("t1", "mcp__mxd__bash", { command: "echo" }),
			toolResultEvent("t1", "mcp__mxd__bash", "y", false),
		];
		const messages = eventsToAnthropicMessages(events);
		const trMsg = messages[messages.length - 1] as { content: unknown[] };
		const block = trMsg.content[0] as Record<string, unknown>;
		expect(Object.keys(block).sort()).toEqual([
			"content",
			"is_error",
			"tool_use_id",
			"type",
		]);
	});

	test("Key ordering: tool_result (image) has exactly {type, tool_use_id, content}", () => {
		const events: Event[] = [
			...userPromptEvents("p1", "x"),
			toolCallEvent("t1", "mcp__mxd__read_file", { path: "/i.png" }),
			toolResultEvent("t1", "mcp__mxd__read_file", "img", false, {
				images: [{ base64: "D", mediaType: "image/png" }],
			}),
		];
		const messages = eventsToAnthropicMessages(events);
		const trMsg = messages[messages.length - 1] as { content: unknown[] };
		const block = trMsg.content[0] as Record<string, unknown>;
		// Exactly 3 keys: type, tool_use_id, content (NO is_error)
		expect(Object.keys(block).sort()).toEqual([
			"content",
			"tool_use_id",
			"type",
		]);
	});

	test("Empty events → empty messages", () => {
		const messages = eventsToAnthropicMessages([]);
		expect(messages).toEqual([]);
	});

	test("User message WITHOUT messages_consumed → deferred, not materialized", () => {
		// A message event with an ID is deferred by the walker. Without a
		// matching messages_consumed event, it's never materialized.
		// This matches production: message events are always consumed by the
		// provider loop before the API call.
		const events: Event[] = [
			{
				type: "message",
				id: "p1",
				taskId: "",
				body: { source: "user", id: "p1", ts: 1000, content: "hello" },
				ts: 1000,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toEqual([]);
	});

	test("Only user message event + consumed → single materialized message", () => {
		const events: Event[] = [...userPromptEvents("p1", "hello")];
		const messages = eventsToAnthropicMessages(events);
		// Walker's onConsumedMessages idle branch: single text → string content
		expect(messages).toHaveLength(1);
		expect(messages[0]).toEqual({
			role: "user",
			content: expect.stringMatching(/^\[\d{2}:\d{2}:\d{2}\] hello$/) as string,
		});
	});

	test("User message without ID → rendered directly as user message", () => {
		// Production: message events without ID = rendered directly (compacted_resume etc.)
		const events: Event[] = [
			{
				type: "message",
				id: "",
				taskId: "",
				body: { source: "user", id: "", ts: 1000, content: "direct" },
				ts: 1000,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		// Without id, walker uses formatEventForAI directly
		expect(messages).toHaveLength(1);
		expect((messages[0] as { role: string }).role).toBe("user");
	});

	test("compacted_resume event → user message with content", () => {
		const events: Event[] = [
			{
				type: "compacted_resume",
				content: "Previous session summary: X happened.",
				taskId: "",
				ts: 1000,
			},
			assistantTextEvent("got it"),
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toHaveLength(2);
		expect(messages[0]).toEqual({
			role: "user",
			content: "Previous session summary: X happened.",
		});
	});

	test("Structural events (session_config, compact_marker) are skipped", () => {
		const events: Event[] = [
			{
				type: "session_config",
				tools: [],
				systemStable: "x",
				systemVariable: "y",
				taskId: "",
				ts: 1,
			},
			...userPromptEvents("p1", "hi"),
			assistantTextEvent("yo"),
			{
				type: "compact_marker",
				checkpoint: "cp1",
				savedTokens: 100,
				taskId: "",
				ts: 3,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		// Only user message + assistant message (session_config and compact_marker skipped)
		expect(messages).toHaveLength(2);
		expect((messages[0] as { role: string }).role).toBe("user");
		expect((messages[1] as { role: string }).role).toBe("assistant");
	});
});

// ── Integration Prefix-Validation Tests ──

describe("Drift: tool lifecycle (tool_use → tool_result)", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	// ── 1. Multiple tools in same assistant turn ──

	test("Two bash tools in one turn", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Running two." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo a" },
						},
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo b" },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Both done." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "two tools ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		expect(await waitForDone(ctx)).toBe("verify");

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, WAKE_DONE);
		expect(await waitForDone(ctx)).toBe("verify");
	}, 30000);

	test("Five tools in one turn", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Running five." },
						...Array.from({ length: 5 }, (_, i) => ({
							type: "tool_use" as const,
							name: "mcp__mxd__bash",
							input: { command: `echo tool_${i}` },
						})),
					],
				},
				{
					blocks: [
						{ type: "text", text: "All five done." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "five tools ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		expect(await waitForDone(ctx)).toBe("verify");

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, WAKE_DONE);
		expect(await waitForDone(ctx)).toBe("verify");
	}, 30000);

	// ── 2. Tools returning images (direct image path) ──

	test("Single image tool_result (read_file PNG) survives restart", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const imgPath = await writeTestImage(ctx, "a.png");

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__read_file",
							input: { path: imgPath },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Image received." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "single image ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		expect(await waitForDone(ctx)).toBe("verify");

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, WAKE_DONE);
		expect(await waitForDone(ctx)).toBe("verify");
	}, 30000);

	test("Multiple image tool_results in same turn", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const img1 = await writeTestImage(ctx, "one.png");
		const img2 = await writeTestImage(ctx, "two.png");
		const img3 = await writeTestImage(ctx, "three.png");

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Reading 3 images." },
						{
							type: "tool_use",
							name: "mcp__mxd__read_file",
							input: { path: img1 },
						},
						{
							type: "tool_use",
							name: "mcp__mxd__read_file",
							input: { path: img2 },
						},
						{
							type: "tool_use",
							name: "mcp__mxd__read_file",
							input: { path: img3 },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Got all 3." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "3 images ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		expect(await waitForDone(ctx)).toBe("verify");

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, WAKE_DONE);
		expect(await waitForDone(ctx)).toBe("verify");
	}, 30000);

	test("Image tool_result interleaved with text tool_result", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const imgPath = await writeTestImage(ctx, "mid.png");

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Mixed batch." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo first_text" },
						},
						{
							type: "tool_use",
							name: "mcp__mxd__read_file",
							input: { path: imgPath },
						},
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo third_text" },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Got all three." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "mixed ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		expect(await waitForDone(ctx)).toBe("verify");

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, WAKE_DONE);
		expect(await waitForDone(ctx)).toBe("verify");
	}, 30000);

	// ── 3. Tools with errors (is_error field presence) ──

	test("Single error tool_result (bash exit code non-zero)", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Running failing command." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "this_command_does_not_exist_12345" },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Error observed." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "error ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		expect(await waitForDone(ctx)).toBe("verify");

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, WAKE_DONE);
		expect(await waitForDone(ctx)).toBe("verify");
	}, 30000);

	test("read_file on non-existent path (tool error)", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__read_file",
							input: { path: "/nonexistent/path/xyzzy.txt" },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Error seen." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "read_file error ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		expect(await waitForDone(ctx)).toBe("verify");

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, WAKE_DONE);
		expect(await waitForDone(ctx)).toBe("verify");
	}, 30000);

	test("Mixed success and error tools in same turn", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Mix of outcomes." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo success_1" },
						},
						{
							type: "tool_use",
							name: "mcp__mxd__read_file",
							input: { path: "/definitely/does/not/exist/xyz.txt" },
						},
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo success_2" },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Mixed outcomes handled." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "mixed ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		expect(await waitForDone(ctx)).toBe("verify");

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, WAKE_DONE);
		expect(await waitForDone(ctx)).toBe("verify");
	}, 30000);

	// ── 4. Empty/minimal tool_result content ──

	test("Bash with empty stdout (only newline)", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Running true." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							// `true` produces no output
							input: { command: "true" },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Empty output observed." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "empty ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		expect(await waitForDone(ctx)).toBe("verify");

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, WAKE_DONE);
		expect(await waitForDone(ctx)).toBe("verify");
	}, 30000);

	// ── 5. Tool_result + cancellation-point queue message (cross-layer drift) ──

	test("Queue message arrives during tool execution → interleaved text", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Long bash command — gives us time to inject a queue message
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Running slow command." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "sleep 0.3 && echo delayed_output" },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Done with queue." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: {
								status: "passed",
								summary: "cancellation queue ok",
							},
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);

		// Wait until mock received first request (agent issued tool_use),
		// then send a message that will be drained at cancellation point.
		const deadline = Date.now() + 5000;
		while (ctx.mockAPI.getRequestCount() < 1 && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 25));
		}
		// Small delay so bash is actively running, then inject
		await new Promise((r) => setTimeout(r, 50));
		await sendMessage(ctx, "injected_during_tool_exec");

		expect(await waitForDone(ctx)).toBe("verify");

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, WAKE_DONE);
		expect(await waitForDone(ctx)).toBe("verify");
	}, 30000);

	test("Queue message with image arrives during tool execution", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Running slow." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "sleep 0.3 && echo slow_done" },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Got queue image." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "queue image ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);

		// Wait for mock to receive request, then inject image message
		const deadline = Date.now() + 5000;
		while (ctx.mockAPI.getRequestCount() < 1 && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 25));
		}
		await new Promise((r) => setTimeout(r, 50));
		await sendMessageWithImages(ctx, "queue image during tool", [
			{ base64: TINY_PNG, mediaType: "image/png" },
		]);

		expect(await waitForDone(ctx)).toBe("verify");

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, WAKE_DONE);
		expect(await waitForDone(ctx)).toBe("verify");
	}, 30000);

	test("Multiple queue messages with images during tool execution", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Slow tool." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "sleep 0.4 && echo slow" },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Got multiple images." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "multi queue img ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		const deadline = Date.now() + 5000;
		while (ctx.mockAPI.getRequestCount() < 1 && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 25));
		}
		await new Promise((r) => setTimeout(r, 50));
		// Send two image messages in quick succession
		await sendMessageWithImages(ctx, "first queue img", [
			{ base64: TINY_PNG, mediaType: "image/png" },
		]);
		await sendMessageWithImages(ctx, "second queue img", [
			{ base64: TINY_PNG, mediaType: "image/png" },
		]);

		expect(await waitForDone(ctx)).toBe("verify");

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, WAKE_DONE);
		expect(await waitForDone(ctx)).toBe("verify");
	}, 30000);

	test("Queue message during multi-tool turn (3 tools + injected text)", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Three slow tools." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo quick" },
						},
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "sleep 0.3 && echo medium" },
						},
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo another_quick" },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "All plus queue message received." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "multi+queue ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		const deadline = Date.now() + 5000;
		while (ctx.mockAPI.getRequestCount() < 1 && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 25));
		}
		await new Promise((r) => setTimeout(r, 50));
		await sendMessage(ctx, "injected_during_multi_tool");

		expect(await waitForDone(ctx)).toBe("verify");

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, WAKE_DONE);
		expect(await waitForDone(ctx)).toBe("verify");
	}, 30000);

	// ── 6. Tool outputs with special characters / potentially tricky content ──

	test("Bash output with newlines and special chars", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Special chars test." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: {
								command:
									'printf \'line1\\nline2\\n\\ttabbed\\n"quoted"\\n{"json":true}\\n\'',
							},
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Special chars ok." },
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
		expect(await waitForDone(ctx)).toBe("verify");

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, WAKE_DONE);
		expect(await waitForDone(ctx)).toBe("verify");
	}, 30000);

	// ── 7. Multi-turn tool execution (cache prefix grows) ──

	test("Three rounds of tool execution (cache prefix grows each turn)", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Round 1." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo round_1" },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Round 2." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo round_2" },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Round 3." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo round_3" },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "All rounds done." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "3 rounds ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		expect(await waitForDone(ctx)).toBe("verify");

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, WAKE_DONE);
		expect(await waitForDone(ctx)).toBe("verify");
	}, 30000);

	// ── 8. Adversarial: image + queue text + error + success in one round ──

	test("Adversarial: image tool + error tool + queue messages (all at once)", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const imgPath = await writeTestImage(ctx, "adversarial.png");

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Kitchen sink." },
						{
							type: "tool_use",
							name: "mcp__mxd__read_file",
							input: { path: imgPath },
						},
						{
							type: "tool_use",
							name: "mcp__mxd__read_file",
							input: { path: "/nowhere/nope.txt" },
						},
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "sleep 0.3 && echo tail_ok" },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Kitchen sink handled." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "kitchen sink ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		// Inject queue messages during tool exec
		const deadline = Date.now() + 5000;
		while (ctx.mockAPI.getRequestCount() < 1 && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 25));
		}
		await new Promise((r) => setTimeout(r, 50));
		await sendMessage(ctx, "queue_text_1");
		await sendMessageWithImages(ctx, "queue_img_1", [
			{ base64: TINY_PNG, mediaType: "image/png" },
		]);

		expect(await waitForDone(ctx)).toBe("verify");

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, WAKE_DONE);
		expect(await waitForDone(ctx)).toBe("verify");
	}, 30000);

	// ── 9. Restart in the middle (tool executed but agent didn't get response yet) ──

	test("Restart after tool execution, before wake: tool_result in JSONL must match live reconstruction later", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const imgPath = await writeTestImage(ctx, "restart.png");

		// Turn 1: read image + yield (so agent goes idle after tool + yield bundle).
		// Actually — yield with other tools is conflict-rejected. Use end_turn instead.
		// Turn 1: read image. end_turn after tool_result (pure text response).
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__read_file",
							input: { path: imgPath },
						},
					],
				},
				{
					// Pure text = end_turn → implicit yield, agent goes idle.
					blocks: [{ type: "text", text: "Image read, waiting." }],
				},
				{
					// After restart + wake, agent calls done.
					blocks: [
						{ type: "text", text: "Woken, done." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "restart mid-flow ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		await waitForIdle(ctx); // after end_turn

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);

		// Wake — next API call uses reconstructed prefix containing the image tool_result.
		await sendMessage(ctx, "wake up and done");
		expect(await waitForDone(ctx)).toBe("verify");
	}, 30000);

	// ── 10. Large tool output ──

	test("Large bash output (many lines, kilobytes)", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Produce ~2KB of output: 100 lines x ~20 chars
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Large output." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: {
								command: "for i in $(seq 1 100); do echo line_number_$i; done",
							},
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Large output received." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "large output ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		expect(await waitForDone(ctx)).toBe("verify");

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, WAKE_DONE);
		expect(await waitForDone(ctx)).toBe("verify");
	}, 30000);

	// ── 11. Tool output that LOOKS like protocol content (JSON, XML tags) ──

	test("Bash outputs JSON-looking content (must not be misinterpreted)", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Running JSON-like command." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: {
								command:
									'echo \'{"type":"text","content":"[1 image(s) attached by user]"}\'',
							},
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Protocol-looking content handled." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "protocol content ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		expect(await waitForDone(ctx)).toBe("verify");

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, WAKE_DONE);
		expect(await waitForDone(ctx)).toBe("verify");
	}, 30000);

	// ── 12. Very long sequence of small tool calls ──

	test("Many sequential turns with small tool calls (10 rounds)", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const rounds = 10;
		const turns = [];
		for (let i = 0; i < rounds; i++) {
			turns.push({
				blocks: [
					{ type: "text", text: `Round ${i + 1}.` },
					{
						type: "tool_use" as const,
						name: "mcp__mxd__bash",
						input: { command: `echo round_${i + 1}` },
					},
				],
			});
		}
		turns.push({
			blocks: [
				{ type: "text", text: "All rounds done." },
				{
					type: "tool_use" as const,
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "10 rounds ok" },
				},
			],
		});

		const instruction = JSON.stringify({ turns });

		await startAgent(ctx, instruction);
		expect(await waitForDone(ctx)).toBe("verify");

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, WAKE_DONE);
		expect(await waitForDone(ctx)).toBe("verify");
	}, 60000);

	// ── 13. Interleaved images and text across turns ──

	test("Image tool turn followed by text tool turns (cache prefix contains image+text)", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const img1 = await writeTestImage(ctx, "i1.png");
		const img2 = await writeTestImage(ctx, "i2.png");

		const instruction = JSON.stringify({
			turns: [
				// Turn 1: image tool
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__read_file",
							input: { path: img1 },
						},
					],
				},
				// Turn 2: text tool
				{
					blocks: [
						{ type: "text", text: "Now text." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo between_images" },
						},
					],
				},
				// Turn 3: image tool again
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__read_file",
							input: { path: img2 },
						},
					],
				},
				// Turn 4: done
				{
					blocks: [
						{ type: "text", text: "Got both images and text." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "interleaved ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		expect(await waitForDone(ctx)).toBe("verify");

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, WAKE_DONE);
		expect(await waitForDone(ctx)).toBe("verify");
	}, 30000);

	// ── 14. Idle after tool turn, wake with queue messages (tests onConsumedMessages working→idle transition) ──

	test("Tool turn → end_turn → image wake: prefix must survive", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const instruction = JSON.stringify({
			turns: [
				// Turn 1: bash tool
				{
					blocks: [
						{ type: "text", text: "Run tool." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo tool_done" },
						},
					],
				},
				// Turn 2: pure text → end_turn → implicit yield (idle context)
				{
					blocks: [{ type: "text", text: "Waiting for image." }],
				},
				// Turn 3: after image wake → done
				{
					blocks: [
						{ type: "text", text: "Image received, done." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "tool+idle+wake ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		await waitForIdle(ctx);
		await sendMessageWithImages(ctx, "image after tool and idle", [
			{ base64: TINY_PNG, mediaType: "image/png" },
		]);
		expect(await waitForDone(ctx)).toBe("verify");

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, WAKE_DONE);
		expect(await waitForDone(ctx)).toBe("verify");
	}, 30000);
});
