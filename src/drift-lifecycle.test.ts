/**
 * Drift-prevention tests: yield/done/fork/compact lifecycle transitions.
 *
 * TWO LAYERS:
 *
 * 1. **Golden walker tests** (describe "Golden: walker output ..."):
 *    Build known Event[] sequences, call eventsToAnthropicMessages() directly,
 *    assert EXACT byte-level output. These catch WALKER CORRECTNESS bugs —
 *    they would have caught the caption bug directly (no restart needed).
 *
 * 2. **Integration prefix-validation tests** (describe "Drift: ..."):
 *    End-to-end scenarios with restart + prefix validation. These catch DRIFT
 *    between walker and non-walker code (initial drain, buildSessionRepair,
 *    cache control) and EventStore/JSONL corruption. They are architectural
 *    guardrails proving the unified architecture is stable across lifecycle
 *    transitions.
 *
 * After the unification fix, live path and reconstruction both delegate to
 * the walker — so prefix validation alone has a BLIND SPOT for walker bugs
 * (both paths produce the same wrong output → validation passes). Golden
 * tests close that gap.
 *
 * WHY: The 2026-04-05 caption bug (live path added `[N image(s) attached by
 * user]` caption, reconstruction idle branch did not) caused 580K token cache
 * misses in production. These tests catch ANY similar byte-drift regression.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventsToAnthropicMessages } from "./anthropic-compatible-provider.ts";
import { createApp } from "./daemon.ts";
import { EventStore } from "./event-store.ts";
import type { Event } from "./events.ts";
import {
	createMockedProviderWithMock,
	ValidatingMockAPI,
} from "./test-utils/mock-anthropic-api.ts";
import { TOOL_DONE, TOOL_YIELD } from "./tool-names.ts";

// ── Test infrastructure (copied from integration.test.ts — kept local to avoid cross-file deps) ──

interface TestContext {
	dataDir: string;
	projectDir: string;
	app: ReturnType<typeof createApp>;
	mockAPI: ValidatingMockAPI;
	projectId: string;
}

async function setupTestContext(): Promise<TestContext> {
	const dataDir = await mkdtemp(join(tmpdir(), "mxd-drift-data-"));
	const projectDir = await mkdtemp(join(tmpdir(), "mxd-drift-project-"));

	Bun.spawnSync(["git", "init"], { cwd: projectDir });
	Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
		cwd: projectDir,
	});
	Bun.spawnSync(["git", "config", "user.name", "Test"], {
		cwd: projectDir,
	});
	// Test gitignore: agent scenarios write scratch files but don't commit;
	// done() now rejects dirty worktrees. Ignore all but explicitly tracked files.
	await Bun.write(
		join(projectDir, ".gitignore"),
		"*\n!/.gitignore\n!/README.md\n!/.mxd/\n!/.mxd/**\n",
	);
	await Bun.write(join(projectDir, "README.md"), "# Test Project\n");
	Bun.spawnSync(["git", "add", "."], { cwd: projectDir });
	Bun.spawnSync(["git", "commit", "-m", "initial"], { cwd: projectDir });

	const mockAPI = new ValidatingMockAPI();
	const provider = createMockedProviderWithMock(mockAPI);
	const appResult = createApp({ dataDir, agentProvider: provider });

	await appResult.pm.load();
	const project = await appResult.pm.init(projectDir);

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
	Bun.spawnSync(["git", "commit", "-m", "activate hook"], { cwd: projectDir });

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
	const newApp = createApp({ dataDir: ctx.dataDir, agentProvider: provider });
	await newApp.pm.load();
	newApp.markReady();
	return newApp;
}

// Standard tiny PNG for image tests (1×1 transparent)
const TINY_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** Build a wake+done instruction (single turn). */
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

// ══════════════════════════════════════════════════════════════════════
// GOLDEN TESTS: walker correctness for lifecycle events
// ══════════════════════════════════════════════════════════════════════
//
// These tests build synthetic Event[] sequences and call eventsToAnthropicMessages
// directly, asserting EXACT byte-level output. They catch walker bugs that
// prefix-validation would miss (since live path now delegates to walker).
//
// Build patterns follow the production flow:
// - yield+queue: tool_call(yield) + tool_result(yield,"resumed.") + message events + messages_consumed
// - done resume: tool_call(done) + tool_result(done,"You previously called...") + queue events
// - fork_marker: tool_call + tool_result + fork_marker + tool_call + tool_result
// ══════════════════════════════════════════════════════════════════════

describe("Golden: walker output for yield lifecycle", () => {
	test("yield + no queue messages → tool_result with 'resumed.' only", () => {
		// Agent called yield, no messages arrived (normally impossible, but
		// walker should still handle empty-queue case safely).
		const events: Event[] = [
			{
				type: "tool_call",
				tool: TOOL_YIELD,
				toolCallId: "tc-yield",
				input: {},
				taskId: "t1",
				ts: 1000,
			},
			{
				type: "tool_result",
				tool: TOOL_YIELD,
				toolCallId: "tc-yield",
				content: "resumed.",
				isError: false,
				taskId: "t1",
				ts: 2000,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toHaveLength(2);
		// Assistant with yield tool_use
		expect(messages[0]).toEqual({
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id: "tc-yield",
					name: TOOL_YIELD,
					input: {},
					caller: { type: "direct" },
				},
			],
		});
		// User with yield tool_result — no interleaved text blocks, no caption
		expect(messages[1]).toEqual({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "tc-yield",
					content: "resumed.",
					is_error: false,
				},
			],
		});
	});

	test("yield + 1 text queue message → tool_result + 1 interleaved text block", () => {
		// The production yield-wake flow: yield → wake message → tool_result + text block.
		const events: Event[] = [
			{
				type: "tool_call",
				tool: TOOL_YIELD,
				toolCallId: "tc-yield",
				input: {},
				taskId: "t1",
				ts: 1000,
			},
			{
				type: "tool_result",
				tool: TOOL_YIELD,
				toolCallId: "tc-yield",
				content: "resumed.",
				isError: false,
				taskId: "t1",
				ts: 2000,
			},
			// Queue message that woke the agent (id must match messages_consumed).
			// NOTE: formatEventForAI uses EVENT ts, not body.ts — so the timestamp
			// rendered is [00:25:01] (from ts=1_501_000), not body.ts.
			{
				type: "message",
				id: "wake-msg-1",
				body: {
					source: "user",
					id: "wake-msg-1",
					ts: 0, // body.ts is unused by formatter
					content: "work on this",
				},
				taskId: "t1",
				ts: 1_501_000, // 00:25:01 in UTC
			},
			{
				type: "messages_consumed",
				messageIds: ["wake-msg-1"],
				taskId: "t1",
				ts: 2002,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toHaveLength(2);
		const userMsg = messages[1] as { role: string; content: unknown[] };
		expect(userMsg.role).toBe("user");
		expect(userMsg.content).toHaveLength(2);
		expect(userMsg.content[0]).toEqual({
			type: "tool_result",
			tool_use_id: "tc-yield",
			content: "resumed.",
			is_error: false,
		});
		// Interleaved text block for the wake message, with [HH:MM:SS] prefix.
		// Timestamp is from the OUTER event.ts (not body.ts) via formatEventForAI.
		expect(userMsg.content[1]).toEqual({
			type: "text",
			text: "[00:25:01] work on this",
		});
	});

	test("yield + 3 text queue messages → 3 separate text blocks (one per message)", () => {
		// Production invariant: each queue message becomes its OWN text block.
		// NOT joined into a single block, NOT embedded in tool_result content.
		const events: Event[] = [
			{
				type: "tool_call",
				tool: TOOL_YIELD,
				toolCallId: "tc-yield",
				input: {},
				taskId: "t1",
				ts: 1000,
			},
			{
				type: "tool_result",
				tool: TOOL_YIELD,
				toolCallId: "tc-yield",
				content: "resumed.",
				isError: false,
				taskId: "t1",
				ts: 2000,
			},
			// Event ts values are distinct so each text block is verifiable.
			{
				type: "message",
				id: "m1",
				body: { source: "user", id: "m1", ts: 0, content: "first" },
				taskId: "t1",
				ts: 1000, // 00:00:01
			},
			{
				type: "message",
				id: "m2",
				body: { source: "user", id: "m2", ts: 0, content: "second" },
				taskId: "t1",
				ts: 2000, // 00:00:02
			},
			{
				type: "message",
				id: "m3",
				body: { source: "user", id: "m3", ts: 0, content: "third" },
				taskId: "t1",
				ts: 3000, // 00:00:03
			},
			{
				type: "messages_consumed",
				messageIds: ["m1", "m2", "m3"],
				taskId: "t1",
				ts: 3001,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toHaveLength(2);
		const userMsg = messages[1] as { role: string; content: unknown[] };
		expect(userMsg.content).toHaveLength(4);
		expect(userMsg.content[0]).toEqual({
			type: "tool_result",
			tool_use_id: "tc-yield",
			content: "resumed.",
			is_error: false,
		});
		// Each message is its OWN text block, in order, with its own timestamp
		expect(userMsg.content[1]).toEqual({
			type: "text",
			text: "[00:00:01] first",
		});
		expect(userMsg.content[2]).toEqual({
			type: "text",
			text: "[00:00:02] second",
		});
		expect(userMsg.content[3]).toEqual({
			type: "text",
			text: "[00:00:03] third",
		});
	});

	test("yield + queue message with image → images after text blocks, caption at end", () => {
		// The production caption rule: images appear AFTER all text blocks,
		// followed by the "[N image(s) attached by user]" caption text block.
		const events: Event[] = [
			{
				type: "tool_call",
				tool: TOOL_YIELD,
				toolCallId: "tc-yield",
				input: {},
				taskId: "t1",
				ts: 1000,
			},
			{
				type: "tool_result",
				tool: TOOL_YIELD,
				toolCallId: "tc-yield",
				content: "resumed.",
				isError: false,
				taskId: "t1",
				ts: 2000,
			},
			{
				type: "message",
				id: "m1",
				body: {
					source: "user",
					id: "m1",
					ts: 0,
					content: "see this",
					images: [{ base64: "ABCDEF", mediaType: "image/png" }],
				},
				taskId: "t1",
				ts: 5000, // 00:00:05
			},
			{
				type: "messages_consumed",
				messageIds: ["m1"],
				taskId: "t1",
				ts: 5001,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toHaveLength(2);
		const userMsg = messages[1] as { role: string; content: unknown[] };
		// Order: tool_result, text block, image, caption
		expect(userMsg.content).toHaveLength(4);
		expect(userMsg.content[0]).toEqual({
			type: "tool_result",
			tool_use_id: "tc-yield",
			content: "resumed.",
			is_error: false,
		});
		expect(userMsg.content[1]).toEqual({
			type: "text",
			text: "[00:00:05] see this",
		});
		expect(userMsg.content[2]).toEqual({
			type: "image",
			source: {
				type: "base64",
				media_type: "image/png",
				data: "ABCDEF",
			},
		});
		expect(userMsg.content[3]).toEqual({
			type: "text",
			text: "[1 image(s) attached by user]",
		});
	});

	test("yield + 2 messages with 3 images total → caption reports 3", () => {
		// Caption shows TOTAL image count across all queue messages, not per-message.
		const events: Event[] = [
			{
				type: "tool_call",
				tool: TOOL_YIELD,
				toolCallId: "tc-yield",
				input: {},
				taskId: "t1",
				ts: 1000,
			},
			{
				type: "tool_result",
				tool: TOOL_YIELD,
				toolCallId: "tc-yield",
				content: "resumed.",
				isError: false,
				taskId: "t1",
				ts: 2000,
			},
			{
				type: "message",
				id: "m1",
				body: {
					source: "user",
					id: "m1",
					ts: 0,
					content: "first batch",
					images: [
						{ base64: "IMG1", mediaType: "image/png" },
						{ base64: "IMG2", mediaType: "image/jpeg" },
					],
				},
				taskId: "t1",
				ts: 10_000, // 00:00:10
			},
			{
				type: "message",
				id: "m2",
				body: {
					source: "user",
					id: "m2",
					ts: 0,
					content: "second batch",
					images: [{ base64: "IMG3", mediaType: "image/png" }],
				},
				taskId: "t1",
				ts: 11_000, // 00:00:11
			},
			{
				type: "messages_consumed",
				messageIds: ["m1", "m2"],
				taskId: "t1",
				ts: 11_001,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		const userMsg = messages[1] as { role: string; content: unknown[] };
		// Order: tool_result, 2 text blocks, 3 images, caption
		expect(userMsg.content).toHaveLength(7);
		expect(userMsg.content[0]).toEqual({
			type: "tool_result",
			tool_use_id: "tc-yield",
			content: "resumed.",
			is_error: false,
		});
		expect(userMsg.content[1]).toEqual({
			type: "text",
			text: "[00:00:10] first batch",
		});
		expect(userMsg.content[2]).toEqual({
			type: "text",
			text: "[00:00:11] second batch",
		});
		expect(userMsg.content[3]).toEqual({
			type: "image",
			source: { type: "base64", media_type: "image/png", data: "IMG1" },
		});
		expect(userMsg.content[4]).toEqual({
			type: "image",
			source: { type: "base64", media_type: "image/jpeg", data: "IMG2" },
		});
		expect(userMsg.content[5]).toEqual({
			type: "image",
			source: { type: "base64", media_type: "image/png", data: "IMG3" },
		});
		// Caption count = 3 (total across all messages)
		expect(userMsg.content[6]).toEqual({
			type: "text",
			text: "[3 image(s) attached by user]",
		});
	});
});

describe("Golden: walker output for done resume lifecycle", () => {
	test("done tool_result with wake context → correct user message", () => {
		// Production done-resume flow: agent calls done() → crashes → restart →
		// wake message → provider writes tool_result("You previously called done...") +
		// queue messages as text blocks.
		const events: Event[] = [
			{
				type: "tool_call",
				tool: TOOL_DONE,
				toolCallId: "tc-done",
				input: { status: "passed", summary: "first done" },
				taskId: "t1",
				ts: 1000,
			},
			{
				type: "tool_result",
				tool: TOOL_DONE,
				toolCallId: "tc-done",
				content:
					"You previously called done(). New messages woke you up:\n\n## Working Directory\n/tmp/project",
				isError: false,
				taskId: "t1",
				ts: 2000,
			},
			{
				type: "message",
				id: "wake",
				body: {
					source: "user",
					id: "wake",
					ts: 0,
					content: "more work",
				},
				taskId: "t1",
				ts: 7000, // 00:00:07
			},
			{
				type: "messages_consumed",
				messageIds: ["wake"],
				taskId: "t1",
				ts: 7001,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toHaveLength(2);
		// Assistant with done tool_use preserved in history
		expect(messages[0]).toEqual({
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id: "tc-done",
					name: TOOL_DONE,
					input: { status: "passed", summary: "first done" },
					caller: { type: "direct" },
				},
			],
		});
		// User with done tool_result (wake context) + text block for wake message
		const userMsg = messages[1] as { role: string; content: unknown[] };
		expect(userMsg.content).toHaveLength(2);
		expect(userMsg.content[0]).toEqual({
			type: "tool_result",
			tool_use_id: "tc-done",
			content:
				"You previously called done(). New messages woke you up:\n\n## Working Directory\n/tmp/project",
			is_error: false,
		});
		expect(userMsg.content[1]).toEqual({
			type: "text",
			text: "[00:00:07] more work",
		});
	});
});

describe("Golden: walker output for fork_marker interleaving", () => {
	test("fork_marker between tool_results → text block inserted inline", () => {
		// Production fork flow: agent calls fork_task_context → tool_result written →
		// fork_marker event emitted → subsequent tool_results follow.
		// Walker must insert the fork_marker as an interleaved text block.
		const events: Event[] = [
			{
				type: "tool_call",
				tool: "mcp__mxd__fork_task_context",
				toolCallId: "tc-fork",
				input: { sourceTaskId: "t0", targetTaskId: "t1" },
				taskId: "t1",
				ts: 1000,
			},
			{
				type: "tool_result",
				tool: "mcp__mxd__fork_task_context",
				toolCallId: "tc-fork",
				content: "Forked context from t0",
				isError: false,
				taskId: "t1",
				ts: 2000,
			},
			{
				type: "fork_marker",
				sourceTaskId: "t0",
				targetTitle: "Child Task",
				targetDescription: "Do some child work",
				taskId: "t1",
				ts: 2001,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toHaveLength(2);
		const userMsg = messages[1] as { role: string; content: unknown[] };
		// Order: tool_result, fork_marker text block
		expect(userMsg.content).toHaveLength(2);
		expect(userMsg.content[0]).toEqual({
			type: "tool_result",
			tool_use_id: "tc-fork",
			content: "Forked context from t0",
			is_error: false,
		});
		// fork_marker as text block with the reassignment instruction
		const forkBlock = userMsg.content[1] as { type: string; text: string };
		expect(forkBlock.type).toBe("text");
		expect(forkBlock.text).toContain(
			'<fork_marker source="t0" task="Child Task">',
		);
		expect(forkBlock.text).toContain("You've been reassigned to a new role.");
		expect(forkBlock.text).toContain("Task description: Do some child work");
		expect(forkBlock.text).toContain("</fork_marker>");
	});

	test("fork_marker without targetTitle/targetDescription → minimal text block", () => {
		// Defensive: targetTitle and targetDescription are optional.
		const events: Event[] = [
			{
				type: "tool_call",
				tool: "mcp__mxd__fork_task_context",
				toolCallId: "tc-fork",
				input: {},
				taskId: "t1",
				ts: 1000,
			},
			{
				type: "tool_result",
				tool: "mcp__mxd__fork_task_context",
				toolCallId: "tc-fork",
				content: "ok",
				isError: false,
				taskId: "t1",
				ts: 2000,
			},
			{
				type: "fork_marker",
				sourceTaskId: "t0",
				taskId: "t1",
				ts: 2001,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		const userMsg = messages[1] as { role: string; content: unknown[] };
		const forkBlock = userMsg.content[1] as { type: string; text: string };
		expect(forkBlock.type).toBe("text");
		// No task="..." attribute when targetTitle absent
		expect(forkBlock.text).toContain('<fork_marker source="t0">');
		expect(forkBlock.text).not.toContain("task=");
		// No "Task description:" line when targetDescription absent
		expect(forkBlock.text).not.toContain("Task description:");
	});
});

describe("Golden: walker output for idle-context user messages (caption bug regression)", () => {
	test("idle context: single user message with image → caption present", () => {
		// THE CAPTION BUG REGRESSION TEST. Prior to 2026-04-05, walker's
		// onConsumedMessages idle branch did NOT add the caption. Live path's
		// buildUserTurn DID. One missing block → prefix mismatch → cache miss.
		// Golden test: verify walker now produces caption even in idle context.
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: {
					source: "user",
					id: "start",
					ts: 0,
					content: "initial",
				},
				taskId: "t1",
				ts: 1000,
			},
			{
				type: "assistant_text",
				content: "working",
				taskId: "t1",
				ts: 1001,
			},
			// Agent ends turn → idle. User sends image message.
			{
				type: "message",
				id: "img-msg",
				body: {
					source: "user",
					id: "img-msg",
					ts: 2000,
					content: "see this",
					images: [{ base64: "IMGDATA", mediaType: "image/png" }],
				},
				taskId: "t1",
				ts: 2001,
			},
			{
				type: "messages_consumed",
				messageIds: ["img-msg"],
				taskId: "t1",
				ts: 2002,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toHaveLength(3);
		// Idle-context user message: text + image + caption
		const idleMsg = messages[2] as { role: string; content: unknown[] };
		expect(idleMsg.role).toBe("user");
		expect(idleMsg.content).toHaveLength(3);
		expect(idleMsg.content[0]).toEqual({
			type: "text",
			text: "[00:00:02] see this",
		});
		expect(idleMsg.content[1]).toEqual({
			type: "image",
			source: {
				type: "base64",
				media_type: "image/png",
				data: "IMGDATA",
			},
		});
		// THIS is the bug regression check:
		expect(idleMsg.content[2]).toEqual({
			type: "text",
			text: "[1 image(s) attached by user]",
		});
	});

	test("idle context: 2 images → caption reports 2", () => {
		const events: Event[] = [
			{ type: "assistant_text", content: "done", taskId: "t1", ts: 1001 },
			{
				type: "message",
				id: "m",
				body: {
					source: "user",
					id: "m",
					ts: 1000,
					content: "both",
					images: [
						{ base64: "A", mediaType: "image/png" },
						{ base64: "B", mediaType: "image/jpeg" },
					],
				},
				taskId: "t1",
				ts: 2001,
			},
			{
				type: "messages_consumed",
				messageIds: ["m"],
				taskId: "t1",
				ts: 2002,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		const idleMsg = messages[1] as { role: string; content: unknown[] };
		// text + 2 images + caption
		expect(idleMsg.content).toHaveLength(4);
		expect(idleMsg.content[3]).toEqual({
			type: "text",
			text: "[2 image(s) attached by user]",
		});
	});

	test("idle context: text-only message → string content (no caption)", () => {
		// No images → no caption, content remains a simple string.
		const events: Event[] = [
			{ type: "assistant_text", content: "done", taskId: "t1", ts: 1001 },
			{
				type: "message",
				id: "m",
				body: { source: "user", id: "m", ts: 0, content: "just text" },
				taskId: "t1",
				ts: 3000, // 00:00:03
			},
			{
				type: "messages_consumed",
				messageIds: ["m"],
				taskId: "t1",
				ts: 3001,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		// Idle-context single text message → string content (NOT content array)
		expect(messages[1]).toEqual({
			role: "user",
			content: "[00:00:03] just text",
		});
	});

	test("idle context: multiple text messages → text blocks array (no caption)", () => {
		// 2+ text messages → content becomes an array of text blocks, no caption.
		const events: Event[] = [
			{ type: "assistant_text", content: "done", taskId: "t1", ts: 1001 },
			{
				type: "message",
				id: "m1",
				body: { source: "user", id: "m1", ts: 0, content: "first" },
				taskId: "t1",
				ts: 4000, // 00:00:04
			},
			{
				type: "message",
				id: "m2",
				body: { source: "user", id: "m2", ts: 0, content: "second" },
				taskId: "t1",
				ts: 5000, // 00:00:05
			},
			{
				type: "messages_consumed",
				messageIds: ["m1", "m2"],
				taskId: "t1",
				ts: 5001,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		const userMsg = messages[1] as { role: string; content: unknown[] };
		expect(userMsg.content).toHaveLength(2);
		expect(userMsg.content[0]).toEqual({
			type: "text",
			text: "[00:00:04] first",
		});
		expect(userMsg.content[1]).toEqual({
			type: "text",
			text: "[00:00:05] second",
		});
	});
});

describe("Golden: walker output for messages_consumed resolution edge cases", () => {
	test("messages_consumed with unknown ID: skipped gracefully, no error", () => {
		// If a messages_consumed references an ID not in the event index,
		// walker should skip it cleanly (defensive behavior).
		const events: Event[] = [
			{ type: "assistant_text", content: "done", taskId: "t1", ts: 1001 },
			{
				type: "messages_consumed",
				messageIds: ["unknown-id"],
				taskId: "t1",
				ts: 2002,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		// No user message appended — the unknown ID is silently skipped
		expect(messages).toHaveLength(1);
	});

	test("messages_consumed with empty messageIds: no-op", () => {
		const events: Event[] = [
			{ type: "assistant_text", content: "done", taskId: "t1", ts: 1001 },
			{
				type: "messages_consumed",
				messageIds: [],
				taskId: "t1",
				ts: 2002,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toHaveLength(1);
	});

	test("messages_consumed with mixed known/unknown IDs: only known resolved", () => {
		const events: Event[] = [
			{ type: "assistant_text", content: "done", taskId: "t1", ts: 1001 },
			{
				type: "message",
				id: "known",
				body: { source: "user", id: "known", ts: 0, content: "real" },
				taskId: "t1",
				ts: 6000, // 00:00:06
			},
			{
				type: "messages_consumed",
				messageIds: ["unknown", "known", "also-unknown"],
				taskId: "t1",
				ts: 6001,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toHaveLength(2);
		expect(messages[1]).toEqual({
			role: "user",
			content: "[00:00:06] real",
		});
	});
});

describe("Golden: walker output for task_complete messages (child → parent)", () => {
	test("task_complete from passed child → correct XML tag formatting", () => {
		// Parent receives task_complete queue message. formatBodyForAI wraps it
		// in <task_complete from_task="..." task_name="..." status="passed">...</task_complete>.
		const events: Event[] = [
			{ type: "assistant_text", content: "waiting", taskId: "t1", ts: 1001 },
			{
				type: "message",
				id: "tc-msg",
				body: {
					source: "task_complete",
					id: "tc-msg",
					ts: 0,
					taskId: "child-1",
					title: "Do work",
					success: true,
					output: "child finished all work",
				},
				taskId: "t1",
				ts: 8000, // 00:00:08
			},
			{
				type: "messages_consumed",
				messageIds: ["tc-msg"],
				taskId: "t1",
				ts: 8001,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toHaveLength(2);
		// Should be string content (single formatted message, no images)
		expect(messages[1]).toEqual({
			role: "user",
			content:
				'[00:00:08] <task_complete from_task="child-1" task_name="Do work" status="passed">child finished all work</task_complete>',
		});
	});

	test("task_complete from failed child → status='failed' in tag", () => {
		const events: Event[] = [
			{ type: "assistant_text", content: "waiting", taskId: "t1", ts: 1001 },
			{
				type: "message",
				id: "tc-msg",
				body: {
					source: "task_complete",
					id: "tc-msg",
					ts: 0,
					taskId: "child-1",
					title: "Do work",
					success: false,
					output: "child gave up",
				},
				taskId: "t1",
				ts: 9000, // 00:00:09
			},
			{
				type: "messages_consumed",
				messageIds: ["tc-msg"],
				taskId: "t1",
				ts: 9001,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages[1]).toEqual({
			role: "user",
			content:
				'[00:00:09] <task_complete from_task="child-1" task_name="Do work" status="failed">child gave up</task_complete>',
		});
	});
});

// ══════════════════════════════════════════════════════════════════════
// 1. Explicit yield + queue messages
// ══════════════════════════════════════════════════════════════════════

describe("Drift: explicit yield lifecycle", () => {
	let ctx: TestContext;
	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("yield + single text message: reconstruction matches after restart", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const instruction = JSON.stringify({
			turns: [
				// Turn 1: explicit yield
				{
					blocks: [
						{ type: "text", text: "Waiting for work." },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
					],
				},
				// Turn 2: after wake → done
				{
					blocks: [
						{ type: "text", text: "Got message." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "yield+single msg ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		await waitForIdle(ctx);
		await sendMessage(ctx, "Here is some work.");
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		// Restart: reconstruction must match the live prefix
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, wakeDoneInstruction("yield+single msg restart ok"));
		const status2 = await waitForDone(ctx);
		expect(status2).toBe("verify");
	}, 30000);

	test("yield + multiple text messages rapidly: each becomes own text block", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Waiting." },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
					],
				},
				{
					blocks: [
						{ type: "text", text: "Got all messages." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "multi msg ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		await waitForIdle(ctx);
		// Send 3 messages before the first wake — they should all be in the queue
		// drained together by the yield handler, each as own text block
		await sendMessage(ctx, "msg one");
		await sendMessage(ctx, "msg two");
		await sendMessage(ctx, "msg three");
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, wakeDoneInstruction("multi msg restart ok"));
		const status2 = await waitForDone(ctx);
		expect(status2).toBe("verify");
	}, 30000);

	test("yield + images in queue: caption appears in working context", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Waiting for image." },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
					],
				},
				{
					blocks: [
						{ type: "text", text: "Got the screenshot." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "yield+image ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		await waitForIdle(ctx);
		await sendMessageWithImages(ctx, "Screenshot attached", [
			{ base64: TINY_PNG, mediaType: "image/png" },
		]);
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, wakeDoneInstruction("yield+image restart ok"));
		const status2 = await waitForDone(ctx);
		expect(status2).toBe("verify");
	}, 30000);

	test("yield + 3 images across 2 messages: multi-image caption count", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Waiting." },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
					],
				},
				{
					blocks: [
						{ type: "text", text: "Got 3 images." },
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
		await waitForIdle(ctx);
		// First message: 2 images
		await sendMessageWithImages(ctx, "Batch 1", [
			{ base64: TINY_PNG, mediaType: "image/png" },
			{ base64: TINY_PNG, mediaType: "image/png" },
		]);
		// Second message: 1 image
		await sendMessageWithImages(ctx, "Batch 2", [
			{ base64: TINY_PNG, mediaType: "image/png" },
		]);
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, wakeDoneInstruction("3 images restart ok"));
		const status2 = await waitForDone(ctx);
		expect(status2).toBe("verify");
	}, 30000);
});

// ══════════════════════════════════════════════════════════════════════
// 2. Duplicate yield in same turn
// ══════════════════════════════════════════════════════════════════════

describe("Drift: duplicate yield in same turn", () => {
	let ctx: TestContext;
	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	// Regression: duplicate-yield flow previously created consecutive user messages.
	// Old flow:
	//   1. Extra yield → buildUserTurn pushed user message with extra tool_results
	//   2. pendingYieldToolCall set → continue → yield wait → wake
	//   3. Real yield → buildUserTurn pushed ANOTHER user message with real tool_result
	//   → 2 consecutive user messages → API 400 "Messages must alternate roles"
	// Fix: extras are now BUNDLED into the real-yield tool_result user turn (built
	// when yield wakes up). pendingDuplicateYieldExtras carries them across the
	// continue/wait boundary. Extras' tool_result events still emit to JSONL
	// immediately (orphan prevention) — walker processes all yield tool_results
	// into the same user turn matching live.
	test("2 yield calls in same turn: first real, extras no-op — restart ok", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		// Turn 1: API returns 2 yield tool_uses — first is real, 2nd becomes
		// a no-op "yield() ignored" tool_result.
		// Turn 2: after wake — done.
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Double yielding." },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
					],
				},
				{
					blocks: [
						{ type: "text", text: "Woken." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "dup yield ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		await waitForIdle(ctx);
		await sendMessage(ctx, "wake up");
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		// Verify the extra-yield no-op tool_result is in JSONL
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const events = await readSessionEvents(ctx, tracker.rootNodeId);
		const extraYieldResults = events.filter(
			(e: Event) =>
				e.type === "tool_result" &&
				e.tool === "mcp__mxd__yield" &&
				typeof e.content === "string" &&
				e.content.includes("ignored"),
		);
		expect(extraYieldResults.length).toBeGreaterThanOrEqual(1);

		// Restart
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, wakeDoneInstruction("dup yield restart ok"));
		const status2 = await waitForDone(ctx);
		expect(status2).toBe("verify");
	}, 30000);

	// Same scenario, 3 yields — now fixed.
	test("3 yield calls in same turn: all extras get no-op tool_results", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Triple yielding." },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
					],
				},
				{
					blocks: [
						{ type: "text", text: "Done." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "triple yield ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		await waitForIdle(ctx);
		await sendMessage(ctx, "wake");
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, wakeDoneInstruction("triple yield restart ok"));
		const status2 = await waitForDone(ctx);
		expect(status2).toBe("verify");
	}, 30000);
});

// ══════════════════════════════════════════════════════════════════════
// 3. Done resume: crash after done → wake → done again
// ══════════════════════════════════════════════════════════════════════

describe("Drift: done resume from crash", () => {
	let ctx: TestContext;
	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("done → crash → restart → wake → done again: prefix survives", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "First pass." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "first done" },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Second pass." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "second done" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		await waitForDone(ctx);

		// Restart (simulating crash-before-wake)
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);

		// Send wake message — triggers the done-resume path
		await sendMessage(ctx, "Additional work needed after done.");
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNodeId = tracker.rootNodeId;
		// wait for status transition back to in_progress then back to verify
		const start = Date.now();
		while (Date.now() - start < 5000) {
			if (tracker.getTask(rootNodeId)?.status === "in_progress") break;
			await new Promise((r) => setTimeout(r, 50));
		}
		await waitForDone(ctx, 15000);

		// Verify done tool_result has the wake context
		const events = await readSessionEvents(ctx, rootNodeId);
		const doneResumeResults = events.filter(
			(e: Event) =>
				e.type === "tool_result" &&
				e.tool === "mcp__mxd__done" &&
				typeof e.content === "string" &&
				e.content.includes("previously called done"),
		);
		expect(doneResumeResults.length).toBeGreaterThanOrEqual(1);
	}, 30000);

	test("done resume with 2 wake messages: each becomes own text block", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "First." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "first" },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Second." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "second" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		await waitForDone(ctx);

		// Restart
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);

		// Wake with 2 messages back-to-back
		await sendMessage(ctx, "first wake message");
		await sendMessage(ctx, "second wake message");

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const start = Date.now();
		while (Date.now() - start < 5000) {
			if (tracker.getTask(tracker.rootNodeId)?.status === "in_progress") break;
			await new Promise((r) => setTimeout(r, 50));
		}
		await waitForDone(ctx, 15000);
	}, 30000);
});

// ══════════════════════════════════════════════════════════════════════
// 4. Multi-cycle yield → wake → yield → wake → done
// ══════════════════════════════════════════════════════════════════════

describe("Drift: multi-cycle yield/wake", () => {
	let ctx: TestContext;
	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("yield → wake → yield → wake → done: prefix survives every cycle", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const instruction = JSON.stringify({
			turns: [
				// Turn 1: yield
				{
					blocks: [
						{ type: "text", text: "Yielding 1." },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
					],
				},
				// Turn 2: yield again
				{
					blocks: [
						{ type: "text", text: "Woken, yielding again." },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
					],
				},
				// Turn 3: done
				{
					blocks: [
						{ type: "text", text: "Done after two cycles." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "multi-cycle ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		await waitForIdle(ctx);
		await sendMessage(ctx, "wake 1");
		await waitForIdle(ctx);
		await sendMessage(ctx, "wake 2");
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		// Restart and wake again
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, wakeDoneInstruction("multi-cycle restart ok"));
		const status2 = await waitForDone(ctx);
		expect(status2).toBe("verify");
	}, 45000);

	test("implicit yield (end_turn) → wake → implicit yield → wake → done", async () => {
		// Agent ends each turn with pure text (end_turn / implicit yield).
		// Each wake becomes a new user message via onConsumedMessages idle branch.
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const instruction = JSON.stringify({
			turns: [
				{ blocks: [{ type: "text", text: "End 1." }] },
				{ blocks: [{ type: "text", text: "End 2." }] },
				{
					blocks: [
						{ type: "text", text: "Final." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "implicit cycles ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		await waitForIdle(ctx);
		await sendMessage(ctx, "wake 1");
		await waitForIdle(ctx);
		await sendMessage(ctx, "wake 2");
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, wakeDoneInstruction("implicit cycles restart ok"));
		const status2 = await waitForDone(ctx);
		expect(status2).toBe("verify");
	}, 45000);
});

// ══════════════════════════════════════════════════════════════════════
// 5. task_complete delivery: child done → parent wakes
// ══════════════════════════════════════════════════════════════════════

describe("Drift: child → parent task_complete lifecycle", () => {
	let ctx: TestContext;
	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("parent yield → child done(passed) → parent wakes → done: prefix survives", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();
		const tracker1 = await ctx.app.getTracker(ctx.projectId);
		ctx.mockAPI.setCapturedVar("rootId", tracker1.rootNodeId);

		const childInstruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Child working." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "child finished" },
				},
			],
		});

		const parentInstruction = JSON.stringify({
			turns: [
				// Turn 1: create child
				{
					blocks: [
						{ type: "text", text: "Creating child." },
						{
							type: "tool_use",
							name: "mcp__mxd__create_task",
							input: {
								parentId: "$rootId",
								title: "Child Task",
								description: "Child does work.",
							},
						},
					],
				},
				// Turn 2: capture childId + send_message
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
						{ type: "text", text: "Sending work to child." },
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
				// Turn 3: yield waiting for child
				{
					blocks: [
						{ type: "text", text: "Waiting." },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
					],
				},
				// Turn 4: task_complete received → done
				{
					blocks: [
						{ type: "text", text: "Child done, finishing." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "parent+child ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, parentInstruction);
		const status = await waitForDone(ctx, 30000);
		expect(status).toBe("verify");

		// Restart parent — its session has task_complete in its JSONL
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, wakeDoneInstruction("parent+child restart ok"));
		const status2 = await waitForDone(ctx);
		expect(status2).toBe("verify");
	}, 45000);

	test("parent yield → child done(failed) → parent wakes → done: failed task_complete ok", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();
		const tracker2 = await ctx.app.getTracker(ctx.projectId);
		ctx.mockAPI.setCapturedVar("rootId", tracker2.rootNodeId);

		const childInstruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Child failing." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "failed", summary: "child gave up" },
				},
			],
		});

		const parentInstruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Creating." },
						{
							type: "tool_use",
							name: "mcp__mxd__create_task",
							input: {
								parentId: "$rootId",
								title: "Child",
								description: "Will fail.",
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
						{ type: "text", text: "Sending." },
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
						{ type: "text", text: "Child failed. Cleaning up." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "handled child failure" },
						},
					],
				},
			],
		});

		await startAgent(ctx, parentInstruction);
		const status = await waitForDone(ctx, 30000);
		expect(status).toBe("verify");

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(
			ctx,
			wakeDoneInstruction("parent+failed-child restart ok"),
		);
		const status2 = await waitForDone(ctx);
		expect(status2).toBe("verify");
	}, 45000);
});

// ══════════════════════════════════════════════════════════════════════
// 6. yield + tool_use same turn — tool executes, yield no-op
// ══════════════════════════════════════════════════════════════════════

describe("Drift: yield + other tool same turn", () => {
	let ctx: TestContext;
	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("yield + bash same turn → restart: prefix survives the conflict path", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Running bash and yielding." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "echo BASH_YIELD_CONFLICT" },
						},
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
					],
				},
				{
					assert: [
						{ length: 2 },
						{
							block: 0,
							type: "tool_result",
							contains: "BASH_YIELD_CONFLICT",
						},
						{ block: 1, type: "tool_result", contains: "yield() ignored" },
					],
					blocks: [
						{ type: "text", text: "Done." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "yield+bash ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		// Restart — prefix includes both tool_results from the conflict turn
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, wakeDoneInstruction("yield+bash restart ok"));
		const status2 = await waitForDone(ctx);
		expect(status2).toBe("verify");
	}, 30000);
});

// ══════════════════════════════════════════════════════════════════════
// 7. Fork lifecycle: create → fork → send → wake → restart
// ══════════════════════════════════════════════════════════════════════

describe("Drift: fork lifecycle", () => {
	let ctx: TestContext;
	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("fork → child with fork_marker: parent restart prefix survives", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();
		const tracker3 = await ctx.app.getTracker(ctx.projectId);
		ctx.mockAPI.setCapturedVar("rootId", tracker3.rootNodeId);

		const childInstruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Forked child." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "fork child ok" },
				},
			],
		});

		// Parent: create → fork → send → yield → done
		const parentInstruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Creating child." },
						{
							type: "tool_use",
							name: "mcp__mxd__create_task",
							input: {
								parentId: "$rootId",
								title: "Fork Target",
								description: "For fork test",
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
						{ type: "text", text: "Fork done, wrapping up." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "parent+fork ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, parentInstruction);
		const status = await waitForDone(ctx, 30000);
		expect(status).toBe("verify");

		// Verify child has fork_marker in its JSONL
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNode = tracker.getTask(tracker.rootNodeId);
		const childId = rootNode?.children?.[0] as string;
		expect(childId).toBeTruthy();
		const childEvents = await readSessionEvents(ctx, childId);
		expect(childEvents.some((e) => e.type === "fork_marker")).toBe(true);

		// Restart parent — its prefix has fork tool_result + task_complete
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, wakeDoneInstruction("parent restart after fork ok"));
		const status2 = await waitForDone(ctx);
		expect(status2).toBe("verify");
	}, 45000);
});

// ══════════════════════════════════════════════════════════════════════
// 8. Crash during tool execution (interrupted orphan repair)
// ══════════════════════════════════════════════════════════════════════

describe("Drift: interrupted tool_call repair", () => {
	let ctx: TestContext;
	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("crash during long bash: orphan repair + prefix survives restart", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Running long command." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "sleep 10" },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Bash interrupted. Done." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "recovered bash" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		// Wait for bash to actually be running
		const start = Date.now();
		while (ctx.mockAPI.getRequestCount() < 1 && Date.now() - start < 5000) {
			await new Promise((r) => setTimeout(r, 50));
		}
		await new Promise((r) => setTimeout(r, 200));

		// Crash
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		// Restart — orphan repair runs
		ctx.app = await recreateApp(ctx);
		await ctx.app.autoResumeProjects();

		// Wake agent to process repaired orphan tool_result
		await sendMessage(ctx, wakeDoneInstruction("interrupted tool restart ok"));
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		// Verify JSONL has interrupted bash tool_result with isError=true
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const events = await readSessionEvents(ctx, tracker.rootNodeId);
		const errorResults = events.filter(
			(e: Event) =>
				e.type === "tool_result" && "isError" in e && e.isError === true,
		);
		expect(errorResults.length).toBeGreaterThanOrEqual(1);
	}, 30000);
});

// ══════════════════════════════════════════════════════════════════════
// 9. Queue messages arriving at cancellation point
// ══════════════════════════════════════════════════════════════════════

describe("Drift: queue messages at cancellation point", () => {
	let ctx: TestContext;
	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("bash + cancellation-point queue message: text block bundled with tool_result", async () => {
		// Send a message WHILE a tool is executing. The queue drain at the
		// cancellation point (between tool exec and next API call) bundles
		// the queue text into the SAME user message as the tool_result.
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Running." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							// Short command + small sleep so we can race a message in
							input: { command: "sleep 0.3 && echo CANCEL_POINT_TEST" },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Done." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "cancel point ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		// Wait for first API call to land (so agent is running tool)
		const start = Date.now();
		while (ctx.mockAPI.getRequestCount() < 1 && Date.now() - start < 5000) {
			await new Promise((r) => setTimeout(r, 20));
		}
		// Send message while bash is executing
		await sendMessage(ctx, "injected during tool exec");
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		// Restart
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, wakeDoneInstruction("cancel point restart ok"));
		const status2 = await waitForDone(ctx);
		expect(status2).toBe("verify");
	}, 30000);
});

// ══════════════════════════════════════════════════════════════════════
// 10. Restart mid-flight: crash during yield wake (messages consumed but API not called)
// ══════════════════════════════════════════════════════════════════════

describe("Drift: crash immediately after wake", () => {
	let ctx: TestContext;
	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("yield → message arrives → crash → restart: no drift (wake message recovered)", async () => {
		// Send message during yield, THEN crash. Message persists in JSONL
		// (written at send time via deliverMessage). On restart, the unconsumed
		// message is recovered by findUnconsumedMessages and woken agent
		// processes it.
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Yielding." },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
					],
				},
				// Turn 2: fires AFTER wake-on-restart
				{
					blocks: [
						{ type: "text", text: "Survived." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "survived interrupt" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		await waitForIdle(ctx);

		// Send message while yielding, then crash immediately
		await sendMessage(ctx, "wake message mid-flight");
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		ctx.app = await recreateApp(ctx);
		await ctx.app.autoResumeProjects();

		// autoResume should wake the agent with the unconsumed message.
		// If for some reason it isn't recovered, we can still wait.
		const status = await waitForDone(ctx, 15000);
		expect(status).toBe("verify");
	}, 30000);
});

// ══════════════════════════════════════════════════════════════════════
// 11. send_message content: test message with special characters and XML tags
// ══════════════════════════════════════════════════════════════════════

describe("Drift: special character content in messages", () => {
	let ctx: TestContext;
	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("message with XML-like content: formatBodyForAI tags correctly escaped", async () => {
		// User sends a message containing `<task_message>...</task_message>`
		// literal text. This tests that formatBodyForAI doesn't double-wrap
		// or produce identical bytes in live vs reconstruction.
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Waiting." },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
					],
				},
				{
					blocks: [
						{ type: "text", text: "Got funky content." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "xml content ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		await waitForIdle(ctx);
		await sendMessage(
			ctx,
			'User sending <task_message from_task="x">fake</task_message> and "quoted" & special chars\nwith\nnewlines',
		);
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, wakeDoneInstruction("xml content restart ok"));
		const status2 = await waitForDone(ctx);
		expect(status2).toBe("verify");
	}, 30000);

	test("multiple messages with empty content and whitespace: no drift", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Waiting." },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
					],
				},
				{
					blocks: [
						{ type: "text", text: "Got whitespace messages." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "whitespace ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		await waitForIdle(ctx);
		// Each line tests a different formatting edge case
		await sendMessage(ctx, "a");
		await sendMessage(ctx, "b\n\n\n");
		await sendMessage(ctx, "   c   ");
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, wakeDoneInstruction("whitespace restart ok"));
		const status2 = await waitForDone(ctx);
		expect(status2).toBe("verify");
	}, 30000);
});

// ══════════════════════════════════════════════════════════════════════
// 12. Multiple wake cycles through different drain paths
// (yield handler drain vs implicit yield drain vs cancellation drain)
// ══════════════════════════════════════════════════════════════════════

describe("Drift: mixed drain paths in one session", () => {
	let ctx: TestContext;
	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("explicit yield drain + cancellation drain in one session", async () => {
		// Goal: exercise 2 drain paths in one session:
		//   1. Explicit yield drain (yield handler)
		//   2. Cancellation-point drain (between tool exec + next API call)
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const instruction = JSON.stringify({
			turns: [
				// Turn 1: explicit yield
				{
					blocks: [
						{ type: "text", text: "Yield 1." },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
					],
				},
				// Turn 2: bash (cancellation drain possible)
				{
					blocks: [
						{ type: "text", text: "Tool time." },
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "sleep 0.3 && echo DRAIN_PATH_TEST" },
						},
					],
				},
				// Turn 3: done
				{
					blocks: [
						{ type: "text", text: "Done both." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "2 drain paths ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);

		// Wait for explicit yield
		await waitForIdle(ctx);
		await sendMessage(ctx, "wake from explicit yield");

		// Wait for turn 2's API call to start (bash launches)
		const start = Date.now();
		while (ctx.mockAPI.getRequestCount() < 2 && Date.now() - start < 3000) {
			await new Promise((r) => setTimeout(r, 20));
		}
		// Inject message while bash is running
		await sendMessage(ctx, "injected at cancellation point");

		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		// Restart
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, wakeDoneInstruction("2 drain paths restart ok"));
		const status2 = await waitForDone(ctx);
		expect(status2).toBe("verify");
	}, 45000);
});

// ══════════════════════════════════════════════════════════════════════
// 13. Extreme stress: many lifecycle transitions in one test
// ══════════════════════════════════════════════════════════════════════

describe("Drift: high-pressure lifecycle chains", () => {
	let ctx: TestContext;
	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("5 yield+wake cycles with mixed-format messages: no drift", async () => {
		// Hammer the yield path with many cycles, mixing text-only messages
		// and image messages. Any drift accumulates across 5 cycles.
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const yieldTurn = {
			blocks: [
				{ type: "text", text: "Yield." },
				{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
			],
		};

		const instruction = JSON.stringify({
			turns: [
				yieldTurn, // 1
				yieldTurn, // 2
				yieldTurn, // 3
				yieldTurn, // 4
				yieldTurn, // 5
				{
					blocks: [
						{ type: "text", text: "Final." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "5 cycles ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		await waitForIdle(ctx);
		await sendMessage(ctx, "cycle 1 text only");
		await waitForIdle(ctx);
		await sendMessageWithImages(ctx, "cycle 2 with image", [
			{ base64: TINY_PNG, mediaType: "image/png" },
		]);
		await waitForIdle(ctx);
		await sendMessage(ctx, "cycle 3 text");
		await waitForIdle(ctx);
		await sendMessageWithImages(ctx, "cycle 4 image", [
			{ base64: TINY_PNG, mediaType: "image/png" },
			{ base64: TINY_PNG, mediaType: "image/png" },
		]);
		await waitForIdle(ctx);
		await sendMessage(ctx, "cycle 5 text done");
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		// Restart — prefix has all 5 cycles with mixed content
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(ctx, wakeDoneInstruction("5 cycles restart ok"));
		const status2 = await waitForDone(ctx);
		expect(status2).toBe("verify");
	}, 60000);
});

// ══════════════════════════════════════════════════════════════════════
// COMPACTION DRIFT TESTS
// ══════════════════════════════════════════════════════════════════════
//
// WHY these tests: production cache miss observed on 2026-04-05 after a
// daemon restart that followed a compaction ~32min earlier. 70K tokens
// drifted between live messages[] (pre-restart) and walker reconstruction
// (post-restart). This is the same bug class as the caption-bug — two
// independent codepaths (live vs walker) producing different bytes.
//
// These tests compare:
//   1. The messages[] that was SENT to the API in the post-compact call
//      (captured via mockAPI.getRequestHistory())
//   2. The messages[] produced by running the walker over the JSONL events
//      after the last compact_marker (what a restart would produce)
//
// They MUST be byte-identical (modulo cache_control positions). If not,
// restart after compact loses cache.
// ══════════════════════════════════════════════════════════════════════

describe("Drift: compaction lifecycle", () => {
	let ctx: TestContext;
	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	// Regression test: /compact triggered while agent is at pending-yield must NOT
	// produce consecutive user messages (API 400 "Messages must alternate roles").
	//
	// Bug history: two codepaths pushed user messages back-to-back:
	//   1. handleImplicitYield returns {compactOnly:true}, provider-shared.ts
	//      (pending-yield branch) pushed yield tool_result as user message.
	//   2. Next loop iteration: compact path pushed summarization instruction
	//      as another user message → consecutive user → API 400.
	//
	// Fix: defer the yield tool_result push via pendingCompactYieldToolCall; the
	// compact path bundles tool_result + summarization text into ONE user turn.
	//
	// This bug only manifested when messages.length > 4 (below that threshold,
	// the compact path bails out with "Context too short" and masks the bug).
	test("compact triggered while agent in pending yield completes without API 400", async () => {
		ctx = await setupTestContext();

		// Need messages.length > 4 at compact time. Use multi-cycle conversation.
		// Each yield+wake cycle adds 2 messages (assistant+user). After 3 cycles:
		// messages has system + user + assistant + user + assistant + user = 6.
		const instruction = JSON.stringify({
			turns: [
				// Turn 1: yield
				{
					blocks: [
						{ type: "text", text: "Turn 1." },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
					],
				},
				// Turn 2: yield
				{
					blocks: [
						{ type: "text", text: "Turn 2." },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
					],
				},
				// Turn 3: yield (now messages will have >4 entries when compact arrives)
				{
					blocks: [
						{ type: "text", text: "Turn 3." },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
					],
				},
				// Turn 4 (post-compact): done
				{
					blocks: [
						{ type: "text", text: "Done after compact." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		await waitForIdle(ctx);
		await sendMessage(ctx, "wake 1");
		await waitForIdle(ctx);
		await sendMessage(ctx, "wake 2");
		await waitForIdle(ctx);
		// Now messages.length > 4. Agent is idle at yield. Trigger compact.

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNodeId = tracker.rootNodeId;
		const compactRes = await ctx.app.app.request(
			`/projects/${ctx.projectId}/compact`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ nodeId: rootNodeId }),
			},
		);
		expect(compactRes.status).toBe(200);

		// Agent should complete Turn 4 cleanly (no API 400).
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		// Verify the event sequence: compact_marker must be present (compaction
		// actually completed, not crashed mid-flight).
		const events = await readSessionEvents(ctx, rootNodeId);
		const hasCompactMarker = events.some((e) => e.type === "compact_marker");
		const hasError = events.some((e) => e.type === "error");
		expect(hasCompactMarker).toBe(true);
		expect(hasError).toBe(false);
	}, 15000);

	// ── compact refreshes tools + system prompt (fix commit e828b9d) ──
	//
	// Pre-fix bug: jsonTools + systemPrompt were frozen from the stored
	// session_config on resume and propagated through every subsequent
	// session_config emission (including post-compact). Tools/system added
	// to the codebase AFTER a session's first session_config were invisible
	// to that session forever.
	//
	// Fix: compact is the natural refresh boundary. Compaction wipes cache
	// (messages[] replaced with compacted_resume), so rebuilding tools +
	// system from current code at that moment costs NO additional cache.
	//
	// Test strategy: pre-seed the session's JSONL with INTENTIONALLY-BOGUS
	// session_config values (tools=[bogus_tool_*], system="BOGUS_*"). On
	// resume, observe what the API request carries:
	//   - No compact: request has BOGUS values (frozen resume — intact)
	//   - After compact: request has REAL values (refresh path triggered)
	//
	// The mock's response script is irrelevant — we assert on what the
	// PROVIDER sent to the API via mockAPI.getToolNames / getSystemText.
	//
	// Mutation test: if fix is reverted, post-compact request will carry
	// BOGUS values (never rebuilt from current code) → Invariant A fails.

	const BOGUS_STABLE = "BOGUS_STABLE_PROMPT_FOR_TEST_ONLY_DO_NOT_MATCH_REAL";
	const BOGUS_VARIABLE = "BOGUS_VARIABLE_PROMPT_FOR_TEST_ONLY_DO_NOT_MATCH";
	const BOGUS_TOOL_ONE = "bogus_tool_one_never_in_real_code";
	const BOGUS_TOOL_TWO = "bogus_tool_two_never_in_real_code";

	async function seedBogusSessionConfig(
		ctx: TestContext,
		taskId: string,
	): Promise<void> {
		const tasksDir = join(ctx.dataDir, "projects", ctx.projectId, "tasks");
		await mkdir(tasksDir, { recursive: true });
		const sessionConfigEvt = {
			type: "session_config" as const,
			tools: [
				{
					name: BOGUS_TOOL_ONE,
					description: "fake tool for frozen-resume test",
					jsonSchema: { type: "object", properties: {} },
				},
				{
					name: BOGUS_TOOL_TWO,
					description: "fake tool for frozen-resume test",
					jsonSchema: { type: "object", properties: {} },
				},
			],
			systemStable: BOGUS_STABLE,
			systemVariable: BOGUS_VARIABLE,
			cacheTtl: "1h" as const,
			taskId: "",
			ts: Date.now() - 1000,
		};
		const line = `${JSON.stringify(sessionConfigEvt)}\n`;
		await writeFile(join(tasksDir, `${taskId}.jsonl`), line);
	}

	test("Invariant B: no-compact resume preserves frozen tools/system from stored session_config", async () => {
		ctx = await setupTestContext();
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNodeId = tracker.rootNodeId;

		// Pre-seed JSONL with bogus session_config BEFORE agent starts.
		await seedBogusSessionConfig(ctx, rootNodeId);

		// Start agent — resume path loads bogus storedConfig.
		// Mock instruction just calls done() immediately to end the run cleanly.
		const instruction = JSON.stringify({
			blocks: [
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "ok" },
				},
			],
		});
		await startAgent(ctx, instruction);
		await waitForDone(ctx);

		// Agent made at least one API call. Inspect what the provider SENT.
		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThan(0);

		// Tools sent to API must be ONLY the bogus ones (frozen from storedConfig).
		const toolNames = ctx.mockAPI.getToolNames(0);
		expect(toolNames).toContain(BOGUS_TOOL_ONE);
		expect(toolNames).toContain(BOGUS_TOOL_TWO);
		// Must NOT contain real mxd tools — freeze is intact.
		expect(toolNames).not.toContain("mcp__mxd__bash");
		expect(toolNames).not.toContain("mcp__mxd__yield");
		expect(toolNames).not.toContain("mcp__mxd__done");

		// System prompt sent to API must be the bogus frozen one.
		const systemText = ctx.mockAPI.getSystemText(0);
		expect(systemText).toContain(BOGUS_STABLE);
		expect(systemText).toContain(BOGUS_VARIABLE);
	}, 15000);

	test("Invariant A: compact refreshes tools + system to current code (bogus values replaced)", async () => {
		ctx = await setupTestContext();
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNodeId = tracker.rootNodeId;

		// Pre-seed bogus session_config.
		await seedBogusSessionConfig(ctx, rootNodeId);

		// Drive 3 yield cycles to reach messages.length > 4, then compact, then done.
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Turn 1." },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
					],
				},
				{
					blocks: [
						{ type: "text", text: "Turn 2." },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
					],
				},
				{
					blocks: [
						{ type: "text", text: "Turn 3." },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
					],
				},
				{
					blocks: [
						{ type: "text", text: "Done after compact." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		await waitForIdle(ctx);
		await sendMessage(ctx, "wake 1");
		await waitForIdle(ctx);
		await sendMessage(ctx, "wake 2");
		await waitForIdle(ctx);

		// Record BEFORE compact: first request should have bogus values (frozen).
		const preCompactCount = ctx.mockAPI.getRequestCount();
		expect(preCompactCount).toBeGreaterThan(0);
		const firstToolNames = ctx.mockAPI.getToolNames(0);
		expect(firstToolNames).toContain(BOGUS_TOOL_ONE); // proves bogus was sent initially

		// Trigger compact.
		const compactRes = await ctx.app.app.request(
			`/projects/${ctx.projectId}/compact`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ nodeId: rootNodeId }),
			},
		);
		expect(compactRes.status).toBe(200);

		await waitForDone(ctx);

		// Agent made MORE API calls post-compact (compaction request +
		// subsequent turn after rebuild). Latest request must carry REAL
		// tools + system, not the frozen bogus ones.
		const postCompactCount = ctx.mockAPI.getRequestCount();
		expect(postCompactCount).toBeGreaterThan(preCompactCount);

		// Final (post-compact) request's tools should be REAL, not BOGUS.
		const lastToolNames = ctx.mockAPI.getToolNames(postCompactCount - 1);
		// Must contain at least some real mxd tools (refresh happened).
		expect(lastToolNames.some((n) => n.startsWith("mcp__mxd__"))).toBe(true);
		// Must NOT contain the bogus ones anymore (refresh path overwrote).
		expect(lastToolNames).not.toContain(BOGUS_TOOL_ONE);
		expect(lastToolNames).not.toContain(BOGUS_TOOL_TWO);

		// Final system prompt must not contain bogus markers (refreshed from code).
		const lastSystemText = ctx.mockAPI.getSystemText(postCompactCount - 1);
		expect(lastSystemText).not.toContain(BOGUS_STABLE);
		expect(lastSystemText).not.toContain(BOGUS_VARIABLE);
	}, 20000);

	// ── Test 1: Full compact lifecycle with prefix validation ──
	// Pre-seed bogus session_config → drive pre-compact cycles (frozen bogus prefix)
	// → trigger compact (prefix resets) → drive post-compact cycles (fresh prefix)
	// → restart (reconstruction from JSONL) → verify post-restart prefix extends
	// the post-compact chain. enablePrefixValidation() is on throughout.
	//
	// WHY: proves that both pre-compact and post-compact halves independently
	// maintain prefix consistency, and the compact transition is a clean reset
	// (no cross-epoch drift). Previous tests only checked "are tools refreshed?"
	// (Invariant A) and "are tools frozen?" (Invariant B), not "does the prefix
	// chain remain valid across the transition?"
	test("Full compact lifecycle: prefix valid pre-compact, post-compact, and post-restart", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNodeId = tracker.rootNodeId;

		// Pre-seed bogus session_config so pre-compact uses frozen bogus tools/system
		await seedBogusSessionConfig(ctx, rootNodeId);

		// Drive 3 yield cycles to accumulate enough messages for compact (>4).
		// After compact, do 2 more yield cycles to prove post-compact prefix
		// grows correctly. Then restart and wake to prove reconstruction matches.
		const instruction = JSON.stringify({
			turns: [
				// Pre-compact turns (3 yield cycles with frozen bogus config)
				{
					blocks: [
						{ type: "text", text: "Pre-compact turn 1." },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
					],
				},
				{
					blocks: [
						{ type: "text", text: "Pre-compact turn 2." },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
					],
				},
				{
					blocks: [
						{ type: "text", text: "Pre-compact turn 3." },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
					],
				},
				// Post-compact turn 1: first API call with refreshed tools/system
				{
					blocks: [
						{ type: "text", text: "Post-compact turn 1." },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
					],
				},
				// Post-compact turn 2: prefix must extend from post-compact turn 1
				{
					blocks: [
						{ type: "text", text: "Post-compact turn 2." },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
					],
				},
				// Post-compact turn 3: done
				{
					blocks: [
						{ type: "text", text: "All done after compact." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "full compact lifecycle ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);

		// Pre-compact cycles
		await waitForIdle(ctx);
		await sendMessage(ctx, "pre-compact wake 1");
		await waitForIdle(ctx);
		await sendMessage(ctx, "pre-compact wake 2");
		await waitForIdle(ctx);

		// Verify pre-compact calls used bogus values (frozen)
		const preCompactCount = ctx.mockAPI.getRequestCount();
		expect(preCompactCount).toBeGreaterThan(0);
		expect(ctx.mockAPI.getToolNames(0)).toContain(BOGUS_TOOL_ONE);

		// Trigger compact
		const compactRes = await ctx.app.app.request(
			`/projects/${ctx.projectId}/compact`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ nodeId: rootNodeId }),
			},
		);
		expect(compactRes.status).toBe(200);

		// Post-compact cycles (prefix validation ensures no drift within post-compact epoch)
		await waitForIdle(ctx);
		await sendMessage(ctx, "post-compact wake 1");
		await waitForIdle(ctx);
		await sendMessage(ctx, "post-compact wake 2");
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		// Verify post-compact calls used real tools (refresh happened)
		const postCompactCount = ctx.mockAPI.getRequestCount();
		const lastToolNames = ctx.mockAPI.getToolNames(postCompactCount - 1);
		expect(lastToolNames.some((n) => n.startsWith("mcp__mxd__"))).toBe(true);
		expect(lastToolNames).not.toContain(BOGUS_TOOL_ONE);

		// Restart — reconstruction from JSONL must produce same prefix as live
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await sendMessage(
			ctx,
			wakeDoneInstruction("full compact lifecycle restart ok"),
		);
		const status2 = await waitForDone(ctx);
		expect(status2).toBe("verify");
	}, 30000);

	// ── Test 2: Post-compact session_config matches actual API call ──
	// After compact, a session_config event is emitted declaring tools + system.
	// The very next API call must send exactly those tools and system. If they
	// don't match, the cache prefix identity is wrong — stored session_config
	// would tell a future restart to use one set of values, but the API call
	// actually used different ones.
	test("Post-compact session_config event matches what API actually receives", async () => {
		ctx = await setupTestContext();
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNodeId = tracker.rootNodeId;

		// Pre-seed bogus session_config to make the transition visible
		await seedBogusSessionConfig(ctx, rootNodeId);

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Turn 1." },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
					],
				},
				{
					blocks: [
						{ type: "text", text: "Turn 2." },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
					],
				},
				{
					blocks: [
						{ type: "text", text: "Turn 3." },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
					],
				},
				{
					blocks: [
						{ type: "text", text: "Done after compact." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "session_config match ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		await waitForIdle(ctx);
		await sendMessage(ctx, "wake 1");
		await waitForIdle(ctx);
		await sendMessage(ctx, "wake 2");
		await waitForIdle(ctx);

		// Trigger compact
		const compactRes = await ctx.app.app.request(
			`/projects/${ctx.projectId}/compact`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ nodeId: rootNodeId }),
			},
		);
		expect(compactRes.status).toBe(200);
		await waitForDone(ctx);

		// Read the post-compact session_config from JSONL (should be after compact_marker)
		const events = await readSessionEvents(ctx, rootNodeId);
		const compactMarkerIdx = events.findLastIndex(
			(e) => e.type === "compact_marker",
		);
		expect(compactMarkerIdx).toBeGreaterThan(-1);

		const postCompactSessionConfig = events
			.slice(compactMarkerIdx + 1)
			.find((e) => e.type === "session_config") as
			| {
					type: "session_config";
					tools: Array<{ name: string }>;
					systemStable: string;
					systemVariable: string;
			  }
			| undefined;
		expect(postCompactSessionConfig).toBeTruthy();

		// Find the first post-compact non-compaction API request
		const history = ctx.mockAPI.getRequestHistory();
		let postCompactRequestIdx = -1;
		let seenCompaction = false;
		for (let i = 0; i < history.length; i++) {
			const req = history[i];
			if (!req) continue;
			// Check if this request is a compaction request
			const lastUser = [...req.messages]
				.reverse()
				.find((m) => m.role === "user");
			if (lastUser) {
				const texts: string[] = [];
				if (typeof lastUser.content === "string") {
					texts.push(lastUser.content);
				} else if (Array.isArray(lastUser.content)) {
					for (const b of lastUser.content as Array<{
						type: string;
						text?: string;
					}>) {
						if (b.type === "text" && b.text) texts.push(b.text);
					}
				}
				const combined = texts.join(" ");
				if (
					combined.includes("ENTIRE history") &&
					combined.includes("<summary>")
				) {
					seenCompaction = true;
					continue;
				}
			}
			if (seenCompaction) {
				postCompactRequestIdx = i;
				break;
			}
		}
		expect(postCompactRequestIdx).toBeGreaterThan(-1);

		// Compare session_config tools with what was actually sent to API
		const apiToolNames = ctx.mockAPI.getToolNames(postCompactRequestIdx);
		if (!postCompactSessionConfig)
			throw new Error("postCompactSessionConfig missing");
		const configToolNames = postCompactSessionConfig.tools.map((t) => t.name);

		// Same set of tools (order matters for cache, but we'll check sorted for robustness)
		expect(apiToolNames.sort()).toEqual(configToolNames.sort());

		// Compare session_config system with what was actually sent to API
		const apiSystemText = ctx.mockAPI.getSystemText(postCompactRequestIdx);
		expect(apiSystemText).toContain(postCompactSessionConfig.systemStable);
		expect(apiSystemText).toContain(postCompactSessionConfig.systemVariable);

		// Must NOT contain bogus values anymore
		expect(apiSystemText).not.toContain(BOGUS_STABLE);
		expect(apiToolNames).not.toContain(BOGUS_TOOL_ONE);
	}, 20000);

	// ── Test 3: Post-compact first API call's messages[0] matches compacted_resume ──
	// After compaction, messages[] is rebuilt with a single user message containing
	// the compacted summary. This must match the compacted_resume event in JSONL,
	// because on restart the walker builds messages from JSONL events — if the live
	// messages[0] differs from what the walker produces from compacted_resume,
	// prefix cache misses occur.
	test("Post-compact API call messages[0] matches compacted_resume event content", async () => {
		ctx = await setupTestContext();
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNodeId = tracker.rootNodeId;

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Turn 1." },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
					],
				},
				{
					blocks: [
						{ type: "text", text: "Turn 2." },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
					],
				},
				{
					blocks: [
						{ type: "text", text: "Turn 3." },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
					],
				},
				{
					blocks: [
						{ type: "text", text: "Done." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "compacted_resume match ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		await waitForIdle(ctx);
		await sendMessage(ctx, "wake 1");
		await waitForIdle(ctx);
		await sendMessage(ctx, "wake 2");
		await waitForIdle(ctx);

		// Trigger compact
		const compactRes = await ctx.app.app.request(
			`/projects/${ctx.projectId}/compact`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ nodeId: rootNodeId }),
			},
		);
		expect(compactRes.status).toBe(200);
		await waitForDone(ctx);

		// Read compacted_resume event from JSONL
		const events = await readSessionEvents(ctx, rootNodeId);
		const compactedResume = events.find((e) => e.type === "compacted_resume") as
			| { type: "compacted_resume"; content: string; cwd?: string }
			| undefined;
		expect(compactedResume).toBeTruthy();

		// Find the first post-compact non-compaction API request
		const history = ctx.mockAPI.getRequestHistory();
		let postCompactRequestIdx = -1;
		let seenCompaction = false;
		for (let i = 0; i < history.length; i++) {
			const req = history[i];
			if (!req) continue;
			const lastUser = [...req.messages]
				.reverse()
				.find((m) => m.role === "user");
			if (lastUser) {
				const texts: string[] = [];
				if (typeof lastUser.content === "string") {
					texts.push(lastUser.content);
				} else if (Array.isArray(lastUser.content)) {
					for (const b of lastUser.content as Array<{
						type: string;
						text?: string;
					}>) {
						if (b.type === "text" && b.text) texts.push(b.text);
					}
				}
				const combined = texts.join(" ");
				if (
					combined.includes("ENTIRE history") &&
					combined.includes("<summary>")
				) {
					seenCompaction = true;
					continue;
				}
			}
			if (seenCompaction) {
				postCompactRequestIdx = i;
				break;
			}
		}
		expect(postCompactRequestIdx).toBeGreaterThan(-1);

		// The first post-compact API call should have messages[0] as user role
		// containing the compacted_resume content
		const postCompactRequest = history[postCompactRequestIdx];
		expect(postCompactRequest).toBeTruthy();
		expect(postCompactRequest?.messages.length).toBeGreaterThanOrEqual(1);
		const firstMsg = postCompactRequest?.messages[0];
		expect(firstMsg).toBeTruthy();
		expect(firstMsg?.role).toBe("user");

		// Extract the text content from messages[0]
		let msgText = "";
		if (firstMsg && typeof firstMsg.content === "string") {
			msgText = firstMsg.content;
		} else if (firstMsg && Array.isArray(firstMsg.content)) {
			for (const b of firstMsg.content as Array<{
				type: string;
				text?: string;
			}>) {
				if (b.type === "text" && b.text) msgText += b.text;
			}
		}

		// The compacted_resume content should appear in the first message.
		// The live path sets messages[0] = { role: "user", content: compactResult.userContent }
		// which includes the compacted_resume text. The walker rebuilds from the
		// compacted_resume event. Both must produce the same content.
		if (!compactedResume) throw new Error("compactedResume missing");
		expect(msgText).toContain(compactedResume.content);

		// Also verify the cwd is included if present
		if (compactedResume.cwd) {
			expect(msgText).toContain(compactedResume.cwd);
		}
	}, 20000);

	// Related class of bug (not yet fixed): compact arrives WITH regular messages
	// in the same drain. When handleImplicitYield returns compactOnly=false BUT
	// manualCompactRequested=true (queue had [regular_msg, compact_msg]), the yield
	// path builds its normal user message (tool_result + queue content), then the
	// compact path IMMEDIATELY pushes summarization as another user message →
	// consecutive user → API 400.
	//
	// The same asymmetry fires for:
	//   - pending-done + nonCompact + compact (all drained together)
	//   - implicit-yield-resume + nonCompact + compact
	//   - end_turn + nonCompact + compact
	//
	// AND the walker has a matching latent bug: reading events
	//   [tool_result, messages_consumed, summarization_request]
	// produces TWO consecutive user messages. If daemon crashes mid-compaction,
	// walker reconstruction produces API-invalid output.
	//
	// The right fix is structural: summarization_request should NOT create a
	// separate user message — it should append to the user turn being built.
	// This requires walker changes too. Deferred to follow-up work.
	test.todo("compact + regular message in same drain during pending yield → no API 400", () => {
		// See comment above: the walker has a matching latent bug. Fix requires
		// restructuring summarization_request to append to the user turn being
		// built instead of creating a separate user message.
	});

	// Sibling bug (not yet fixed, hard to reach via integration):
	// pendingDoneToolCall + compactOnly has the same asymmetry. The pending-done
	// path at provider-shared.ts line 842 does NOT check for compactOnly — it
	// always pushes the done tool_result as a user message, then the compact path
	// pushes summarization → consecutive user → API 400.
	//
	// Hard to reach because: compact messages don't persist to JSONL, so after
	// daemon restart the queue is empty on resume. The only reachable path is
	// a narrow window between done() Phase 1 and Phase 2 session cleanup,
	// which rejects /compact via a 404.
	//
	// Deferred with the bug #2 walker-drift fix (requires the same structural
	// change: summarization_request should append to the user turn being built,
	// not produce a separate user message).
	test.todo("compact triggered while agent in pending-done (done resume) completes without API 400", () => {
		// See comment above: very narrow window, hard to reach via integration.
		// Fix bundled with the pending-yield+regular bug (both need structural
		// change to summarization_request injection).
	});
});
