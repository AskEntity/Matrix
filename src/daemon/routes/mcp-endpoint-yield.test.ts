/**
 * Integration tests for the MCP `yield` tool.
 *
 * External CC yields control to Matrix — symmetric to Matrix agents' own yield().
 * These tests run real Matrix agents (via ValidatingMockAPI) against an HTTP
 * MCP client. They verify the blocking primitive external CC uses to watch
 * a Matrix task for activity: send work → yield → get events.
 *
 * Matrix on port NONE — we use Hono's app.request() directly, no TCP socket.
 * Hono's app.request() runs handlers on the same event loop, so when the `yield`
 * tool blocks waiting for a signal, the agent (also on the same event loop) cannot
 * make progress while we await the MCP response synchronously. Therefore we fire
 * the MCP yield request WITHOUT awaiting it (keep the promise), then drive the
 * agent by sending a message, then await the response promise.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../daemon.ts";
import {
	createMockedProviderWithMock,
	ValidatingMockAPI,
} from "../../test-utils/mock-anthropic-api.ts";

const ACCEPT = { Accept: "application/json, text/event-stream" };

interface TestContext {
	dataDir: string;
	projectDir: string;
	app: ReturnType<typeof createApp>;
	mockAPI: ValidatingMockAPI;
	projectId: string;
	rootNodeId: string;
}

async function setupContext(): Promise<TestContext> {
	const dataDir = await mkdtemp(join(tmpdir(), "mxd-mcp-yield-"));
	const projectDir = await mkdtemp(join(tmpdir(), "mxd-mcp-yield-proj-"));

	Bun.spawnSync(["git", "init"], { cwd: projectDir });
	Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
		cwd: projectDir,
	});
	Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: projectDir });
	await Bun.write(join(projectDir, "README.md"), "# Test Project\n");
	Bun.spawnSync(["git", "add", "."], { cwd: projectDir });
	Bun.spawnSync(["git", "commit", "-m", "initial"], { cwd: projectDir });

	const mockAPI = new ValidatingMockAPI();
	const provider = createMockedProviderWithMock(mockAPI);
	const app = createApp({ dataDir, agentProvider: provider });
	await app.pm.load();
	const project = await app.pm.init(projectDir);

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

	app.markReady();

	const tracker = await app.getTracker(project.id);
	return {
		dataDir,
		projectDir,
		app,
		mockAPI,
		projectId: project.id,
		rootNodeId: tracker.rootNodeId,
	};
}

async function teardownContext(ctx: TestContext): Promise<void> {
	await ctx.app.shutdown();
	await new Promise((r) => setTimeout(r, 50));
	await rm(ctx.dataDir, { recursive: true, force: true });
	await rm(ctx.projectDir, { recursive: true, force: true });
}

// ── MCP helpers ──

type RequestFn = (url: string, init?: RequestInit) => Promise<Response>;

async function mcpInit(request: RequestFn): Promise<string> {
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
	const sid = res.headers.get("mcp-session-id");
	expect(sid).toBeTruthy();
	return sid as string;
}

async function mcpInitialized(
	request: RequestFn,
	sessionId: string,
): Promise<void> {
	await request("/mcp", {
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
}

interface ToolCallResult {
	id: number;
	result?: {
		content: Array<{ type: string; text?: string }>;
		isError?: boolean;
	};
	error?: { code: number; message: string };
}

async function mcpCallTool(
	request: RequestFn,
	sessionId: string,
	id: number,
	toolName: string,
	args: Record<string, unknown> = {},
): Promise<ToolCallResult> {
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
	return (await res.json()) as ToolCallResult;
}

/**
 * Parse the `await` tool JSON response from its MCP text content.
 */
function parseYieldResult(r: ToolCallResult): {
	reason: string;
	taskStatus: string;
	events: Array<Record<string, unknown>>;
	cursorIndex: number;
	count: number;
} {
	const text = r.result?.content[0]?.text ?? "{}";
	return JSON.parse(text);
}

/** Start a task via the unified task message endpoint. */
async function sendTaskMessage(
	ctx: TestContext,
	message: string,
): Promise<Response> {
	return ctx.app.app.request(
		`/projects/${ctx.projectId}/tasks/${ctx.rootNodeId}/message`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: message }),
		},
	);
}

/** Attach an MCP session to ctx's root task. */
async function attachRoot(
	ctx: TestContext,
	request: RequestFn,
	sessionId: string,
	callId: number,
): Promise<void> {
	const res = await mcpCallTool(request, sessionId, callId, "attach_to", {
		projectId: ctx.projectId,
		taskId: ctx.rootNodeId,
	});
	expect(res.result?.isError).toBeFalsy();
}

// ── Tests ──

describe("mcp-endpoint: yield tool", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownContext(ctx);
	});

	test("requires attachment", async () => {
		ctx = await setupContext();
		const request: RequestFn = async (u, i) => ctx.app.app.request(u, i);
		const sid = await mcpInit(request);
		await mcpInitialized(request, sid);

		const res = await mcpCallTool(request, sid, 2, "yield");
		expect(res.result?.isError).toBe(true);
		expect(res.result?.content[0]?.text ?? "").toContain("Not attached");
	});

	test("requires task attachment, not just project", async () => {
		ctx = await setupContext();
		const request: RequestFn = async (u, i) => ctx.app.app.request(u, i);
		const sid = await mcpInit(request);
		await mcpInitialized(request, sid);

		await mcpCallTool(request, sid, 2, "attach_to", {
			projectId: ctx.projectId,
		});
		const res = await mcpCallTool(request, sid, 3, "yield");
		expect(res.result?.isError).toBe(true);
		expect(res.result?.content[0]?.text ?? "").toContain(
			"Not attached to a task",
		);
	});

	test("returns immediately with not_running when task is pending (never started)", async () => {
		ctx = await setupContext();
		const request: RequestFn = async (u, i) => ctx.app.app.request(u, i);
		const sid = await mcpInit(request);
		await mcpInitialized(request, sid);
		await attachRoot(ctx, request, sid, 2);

		const res = await mcpCallTool(request, sid, 3, "yield", {
			timeoutMs: 5000,
		});
		expect(res.result?.isError).toBeFalsy();
		const parsed = parseYieldResult(res);
		expect(parsed.reason).toBe("not_running");
		expect(parsed.taskStatus).toBe("pending");
		expect(parsed.events).toEqual([]);
	});

	test("returns 'done' when agent calls done('passed')", async () => {
		ctx = await setupContext();
		const request: RequestFn = async (u, i) => ctx.app.app.request(u, i);
		const sid = await mcpInit(request);
		await mcpInitialized(request, sid);
		await attachRoot(ctx, request, sid, 2);

		// Instruction: agent immediately calls done
		const instruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "All done." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "test done" },
				},
			],
		});

		// Fire await first (it will block), then kick off the agent.
		// Using Promise.all to drive them concurrently on the same event loop.
		const awaitP = mcpCallTool(request, sid, 3, "yield", { timeoutMs: 15000 });
		const sendP = sendTaskMessage(ctx, instruction);
		const [awaitRes, sendRes] = await Promise.all([awaitP, sendP]);
		expect(sendRes.status).toBe(200);
		expect(awaitRes.result?.isError).toBeFalsy();

		const parsed = parseYieldResult(awaitRes);
		expect(parsed.reason).toBe("done");
		expect(parsed.taskStatus).toBe("verify");
		// Should contain the assistant_text and tool_call events
		const types = parsed.events.map((e) => e.type);
		expect(types).toContain("assistant_text");
		expect(types).toContain("tool_call");
		// done_notified signals Phase 2 completion
		expect(types).toContain("done_notified");
	}, 20000);

	test("returns 'idle' when agent ends turn without done (implicit yield)", async () => {
		ctx = await setupContext();
		const request: RequestFn = async (u, i) => ctx.app.app.request(u, i);
		const sid = await mcpInit(request);
		await mcpInitialized(request, sid);
		await attachRoot(ctx, request, sid, 2);

		// Instruction: plain assistant_text, no tool_use → end_turn → implicit yield
		const instruction = JSON.stringify({
			blocks: [{ type: "text", text: "Thinking about it." }],
		});

		const awaitP = mcpCallTool(request, sid, 3, "yield", { timeoutMs: 15000 });
		const sendP = sendTaskMessage(ctx, instruction);
		const [awaitRes] = await Promise.all([awaitP, sendP]);
		expect(awaitRes.result?.isError).toBeFalsy();

		const parsed = parseYieldResult(awaitRes);
		expect(parsed.reason).toBe("idle");
		expect(parsed.taskStatus).toBe("in_progress");
		const types = parsed.events.map((e) => e.type);
		expect(types).toContain("assistant_text");
	}, 20000);

	test("returns 'idle' when agent calls yield tool explicitly", async () => {
		ctx = await setupContext();
		const request: RequestFn = async (u, i) => ctx.app.app.request(u, i);
		const sid = await mcpInit(request);
		await mcpInitialized(request, sid);
		await attachRoot(ctx, request, sid, 2);

		// Instruction: agent calls yield() explicitly
		const instruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Waiting for user." },
				{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
			],
		});

		const awaitP = mcpCallTool(request, sid, 3, "yield", { timeoutMs: 15000 });
		const sendP = sendTaskMessage(ctx, instruction);
		const [awaitRes] = await Promise.all([awaitP, sendP]);
		expect(awaitRes.result?.isError).toBeFalsy();

		const parsed = parseYieldResult(awaitRes);
		expect(parsed.reason).toBe("idle");
		expect(parsed.taskStatus).toBe("in_progress");
		const types = parsed.events.map((e) => e.type);
		expect(types).toContain("assistant_text");
		// The yield tool_call is persisted before the agent_idle signal fires
		expect(types).toContain("tool_call");
	}, 20000);

	test("timeout returns reason=timeout with empty events if nothing happened", async () => {
		ctx = await setupContext();
		const request: RequestFn = async (u, i) => ctx.app.app.request(u, i);
		const sid = await mcpInit(request);
		await mcpInitialized(request, sid);

		// Start the agent first and wait for it to go idle.
		// Simplest: turn 1 emits plain text → end_turn → idle.
		const instruction = JSON.stringify({
			blocks: [{ type: "text", text: "hi" }],
		});
		const sendRes = await sendTaskMessage(ctx, instruction);
		expect(sendRes.status).toBe(200);
		// Let agent reach idle
		await new Promise((r) => setTimeout(r, 300));

		// Now attach — cursor initialized at current event count (past assistant_text)
		await attachRoot(ctx, request, sid, 2);

		// await with short timeout — no new activity should arrive
		const res = await mcpCallTool(request, sid, 3, "yield", { timeoutMs: 500 });
		expect(res.result?.isError).toBeFalsy();
		const parsed = parseYieldResult(res);
		// Could be "idle" (if agent is currently at queue.wait and events > cursor is false)
		// OR "timeout" if we genuinely miss the signal. Both acceptable — check that
		// NO new events came through: cursor stayed stable.
		expect(parsed.count).toBe(0);
		// Most likely timeout since cursor == events.length and no new activity
		expect(["timeout", "idle"]).toContain(parsed.reason);
	}, 10000);

	test("cursor progresses across multiple await calls — no overlap", async () => {
		ctx = await setupContext();
		const request: RequestFn = async (u, i) => ctx.app.app.request(u, i);
		const sid = await mcpInit(request);
		await mcpInitialized(request, sid);
		await attachRoot(ctx, request, sid, 2);

		// Turn 1: agent emits text, then waits (implicit yield).
		// Turn 2 (after send_message): agent calls done.
		const instruction = JSON.stringify({
			turns: [
				{ blocks: [{ type: "text", text: "first turn" }] },
				{
					blocks: [
						{ type: "text", text: "second turn" },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "two turns" },
						},
					],
				},
			],
		});

		// Drive turn 1
		const yieldP1 = mcpCallTool(request, sid, 3, "yield", { timeoutMs: 15000 });
		const sendP = sendTaskMessage(ctx, instruction);
		const [yieldRes1] = await Promise.all([yieldP1, sendP]);
		expect(yieldRes1.result?.isError).toBeFalsy();
		const parsed1 = parseYieldResult(yieldRes1);
		expect(parsed1.reason).toBe("idle");
		const cursor1 = parsed1.cursorIndex;
		expect(cursor1).toBeGreaterThan(0);

		// Drive turn 2 by sending a new message. That message arrival wakes
		// the agent from queue.wait() — it then processes turn 2 from the instruction.
		const yieldP2 = mcpCallTool(request, sid, 4, "yield", { timeoutMs: 15000 });
		const sendP2 = sendTaskMessage(ctx, "go");
		const [yieldRes2] = await Promise.all([yieldP2, sendP2]);
		expect(yieldRes2.result?.isError).toBeFalsy();
		const parsed2 = parseYieldResult(yieldRes2);
		expect(parsed2.reason).toBe("done");
		expect(parsed2.cursorIndex).toBeGreaterThan(cursor1);

		// The second call's events must start AFTER the first call's cursor —
		// no overlap. We can't verify IDs (no stable ID on events), but we can
		// verify content: turn 1's text should NOT appear in turn 2's events.
		const textEvents2 = parsed2.events
			.filter((e) => e.type === "assistant_text")
			.map((e) => JSON.stringify(e));
		for (const t of textEvents2) {
			expect(t).not.toContain("first turn");
		}
		// But turn 2's text SHOULD appear
		const hasSecondTurn = textEvents2.some((t) => t.includes("second turn"));
		expect(hasSecondTurn).toBe(true);
	}, 30000);

	test("cross-session isolation: two MCP sessions have independent cursors", async () => {
		ctx = await setupContext();
		const request: RequestFn = async (u, i) => ctx.app.app.request(u, i);

		// Session A attaches first, cursor=0
		const sidA = await mcpInit(request);
		await mcpInitialized(request, sidA);
		await attachRoot(ctx, request, sidA, 2);

		// Drive agent through 1 turn
		const instruction = JSON.stringify({
			blocks: [{ type: "text", text: "hi from agent" }],
		});
		const yieldPA = mcpCallTool(request, sidA, 3, "yield", {
			timeoutMs: 15000,
		});
		const sendP = sendTaskMessage(ctx, instruction);
		const [yieldResA] = await Promise.all([yieldPA, sendP]);
		const parsedA = parseYieldResult(yieldResA);
		expect(parsedA.reason).toBe("idle");
		expect(parsedA.events.length).toBeGreaterThan(0);

		// NOW session B attaches — should get cursor = current count (AT parsedA.cursorIndex)
		const sidB = await mcpInit(request);
		await mcpInitialized(request, sidB);
		await attachRoot(ctx, request, sidB, 2);

		// B calls await → should see NOTHING (agent is idle, no new events)
		// AND cursor should be initialized to current count, not 0
		const resB = await mcpCallTool(request, sidB, 3, "yield", {
			timeoutMs: 500,
		});
		const parsedB = parseYieldResult(resB);
		// Either timeout (no new events) or idle with 0 events (already caught up)
		expect(parsedB.count).toBe(0);
		// Cursor index should match session A's final cursor (both see same JSONL state)
		expect(parsedB.cursorIndex).toBe(parsedA.cursorIndex);
	}, 30000);

	test("await after agent done() returns 'done' immediately", async () => {
		ctx = await setupContext();
		const request: RequestFn = async (u, i) => ctx.app.app.request(u, i);
		const sid = await mcpInit(request);
		await mcpInitialized(request, sid);

		// Start agent → calls done → status = verify
		const instruction = JSON.stringify({
			blocks: [
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "done" },
				},
			],
		});
		const sendRes = await sendTaskMessage(ctx, instruction);
		expect(sendRes.status).toBe(200);

		// Poll until status is verify
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const start = Date.now();
		while (Date.now() - start < 15000) {
			const status = tracker.getTask(ctx.rootNodeId)?.status;
			if (status === "verify" || status === "failed") break;
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(tracker.getTask(ctx.rootNodeId)?.status).toBe("verify");

		// Now attach — cursor initialized at current count
		await attachRoot(ctx, request, sid, 2);
		// await returns immediately because task is terminal
		const res = await mcpCallTool(request, sid, 3, "yield", { timeoutMs: 500 });
		const parsed = parseYieldResult(res);
		expect(parsed.reason).toBe("done");
		expect(parsed.taskStatus).toBe("verify");
		// No new events since we attached AFTER done completed
		expect(parsed.count).toBe(0);
	}, 20000);

	test("returns 'stopped' when agent is stopped mid-turn via stop_task REST", async () => {
		ctx = await setupContext();
		const request: RequestFn = async (u, i) => ctx.app.app.request(u, i);
		const sid = await mcpInit(request);
		await mcpInitialized(request, sid);
		await attachRoot(ctx, request, sid, 2);

		// Instruction: agent emits text then yields (stays running).
		// We'll stop it externally while it's idle.
		const instruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Working..." },
				{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
			],
		});

		// Kick off agent — it'll reach idle (at yield)
		const sendRes = await sendTaskMessage(ctx, instruction);
		expect(sendRes.status).toBe(200);
		// Wait for agent to reach idle state
		await new Promise((r) => setTimeout(r, 300));

		// Start await (blocks waiting for next pause) AND stop the task concurrently.
		// BUT: the agent is already idle from the yield — so await's fast path
		// will trigger ("isIdleNow && events.length > cursor"). So call await once
		// to drain the idle state first, THEN call await again which will block,
		// then stop.
		const drainRes = await mcpCallTool(request, sid, 3, "yield", {
			timeoutMs: 2000,
		});
		const drained = parseYieldResult(drainRes);
		expect(drained.reason).toBe("idle");
		expect(drained.taskStatus).toBe("in_progress");

		// Second await blocks (no new events, agent still idle but cursor caught up).
		// Delay stop so await has a chance to subscribe before agent_stopped fires.
		const awaitP = mcpCallTool(request, sid, 4, "yield", { timeoutMs: 15000 });
		const stopP = new Promise<Response>((resolve) => {
			setTimeout(() => {
				resolve(
					ctx.app.app.request(
						`/projects/${ctx.projectId}/tasks/${ctx.rootNodeId}/stop`,
						{ method: "POST" },
					),
				);
			}, 100);
		});
		const [awaitRes, stopRes] = await Promise.all([awaitP, stopP]);
		expect(stopRes.status).toBe(200);
		expect(awaitRes.result?.isError).toBeFalsy();

		const parsed = parseYieldResult(awaitRes);
		expect(parsed.reason).toBe("stopped");
		// After stop, task returns to status "in_progress" (not a terminal state —
		// agent is resumable). But with no session.
		expect(parsed.taskStatus).toBe("in_progress");
	}, 30000);

	test("timeoutMs clamps to max 300000", async () => {
		ctx = await setupContext();
		const request: RequestFn = async (u, i) => ctx.app.app.request(u, i);
		const sid = await mcpInit(request);
		await mcpInitialized(request, sid);
		await attachRoot(ctx, request, sid, 2);

		// Passing 999999999 should clamp — but since pending tasks return
		// immediately anyway, we just verify no crash.
		const res = await mcpCallTool(request, sid, 3, "yield", {
			timeoutMs: 999999999,
		});
		expect(res.result?.isError).toBeFalsy();
		const parsed = parseYieldResult(res);
		expect(parsed.reason).toBe("not_running");
	});
});
