/**
 * Bug 1 integration: every QueueMessage is persisted to JSONL exactly once.
 *
 * The `enqueue === persist` refactor makes `queue.enqueue(msg)` the single
 * write path. These tests verify that across every message source type
 * (deliverMessage paths + direct-enqueue paths), the resulting JSONL
 * contains each body.id exactly once, no byte-identical duplicates.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { deliverMessage } from "./daemon/agent-lifecycle.ts";
import { createApp } from "./daemon.ts";
import type { Event } from "./events.ts";
import type { QueueMessage } from "./message-queue.ts";
import {
	createBackgroundComplete,
	createClarifyResponse,
	createCrossProjectMessage,
	createTaskComplete,
	createTaskMessage,
	createTreeChange,
	createUserMessage,
	createUserMessageForwarded,
} from "./queue-message-factory.ts";
import {
	type EmissionTestContext,
	injectMessage,
	messageIdOccurrences,
	readSessionEvents,
	setupEmissionTestContext,
	singleTurnDoneInstruction,
	startAgent,
	teardownEmissionTestContext,
	twoTurnInstruction,
	waitForDone,
	waitForIdle,
} from "./test-utils/emission-harness.ts";
import { createMockedProviderWithMock } from "./test-utils/mock-anthropic-api.ts";

async function assertMessageAppearsOnce(
	ctx: EmissionTestContext,
	makeMsg: () => QueueMessage,
): Promise<QueueMessage> {
	await startAgent(ctx, twoTurnInstruction("dedup ok"));
	await waitForIdle(ctx);

	const msg = makeMsg();
	await injectMessage(ctx, msg);

	const status = await waitForDone(ctx);
	expect(status).toBe("verify");

	const tracker = await ctx.app.getTracker(ctx.projectId);
	const events = await readSessionEvents(ctx, tracker.rootNodeId);
	const occurrences = messageIdOccurrences(events, msg.id);
	if (occurrences.length !== 1) {
		console.error(
			`[dedup] id=${msg.id} source=${msg.source} appears ${occurrences.length}×`,
		);
	}
	expect(occurrences.length).toBe(1);
	return msg;
}

describe("Bug 1: JSONL dedup via deliverMessage (agent idle)", () => {
	let ctx: EmissionTestContext;
	afterEach(async () => {
		if (ctx) await teardownEmissionTestContext(ctx);
	});

	test("user message", async () => {
		ctx = await setupEmissionTestContext();
		await assertMessageAppearsOnce(ctx, () => createUserMessage("hi"));
	}, 30000);

	test("task_message", async () => {
		ctx = await setupEmissionTestContext();
		await assertMessageAppearsOnce(ctx, () =>
			createTaskMessage("01SIB000001", "Sibling", "Hello"),
		);
	}, 30000);

	test("task_message with requestReply", async () => {
		ctx = await setupEmissionTestContext();
		await assertMessageAppearsOnce(ctx, () =>
			createTaskMessage("01SIB000002", "Sib", "Check", {
				title: "Review",
				requestReply: true,
			}),
		);
	}, 30000);

	test("task_complete(success=true)", async () => {
		ctx = await setupEmissionTestContext();
		await assertMessageAppearsOnce(ctx, () =>
			createTaskComplete("01CHILD0001", "Child", true, "done"),
		);
	}, 30000);

	test("task_complete(success=false)", async () => {
		ctx = await setupEmissionTestContext();
		await assertMessageAppearsOnce(ctx, () =>
			createTaskComplete("01CHILD0002", "Child", false, "failed"),
		);
	}, 30000);

	test("user_message_forwarded", async () => {
		ctx = await setupEmissionTestContext();
		await assertMessageAppearsOnce(ctx, () =>
			createUserMessageForwarded("01CHILD0003", "Child", "content"),
		);
	}, 30000);

	test("user_message_forwarded(resumed=true)", async () => {
		ctx = await setupEmissionTestContext();
		await assertMessageAppearsOnce(ctx, () =>
			createUserMessageForwarded("01CHILD0004", "Child", "content", {
				resumed: true,
			}),
		);
	}, 30000);

	test("clarify_response", async () => {
		ctx = await setupEmissionTestContext();
		await assertMessageAppearsOnce(ctx, () =>
			createClarifyResponse("go ahead"),
		);
	}, 30000);

	test("cross_project", async () => {
		ctx = await setupEmissionTestContext();
		await assertMessageAppearsOnce(ctx, () =>
			createCrossProjectMessage("other", "Other", "hello from peer"),
		);
	}, 30000);

	test("tree_change(created)", async () => {
		ctx = await setupEmissionTestContext();
		await assertMessageAppearsOnce(ctx, () =>
			createTreeChange("created", "01NEW000001", "New task"),
		);
	}, 30000);

	test("tree_change(deleted)", async () => {
		ctx = await setupEmissionTestContext();
		await assertMessageAppearsOnce(ctx, () =>
			createTreeChange("deleted", "01DEL000001"),
		);
	}, 30000);

	test("background_complete", async () => {
		ctx = await setupEmissionTestContext();
		await assertMessageAppearsOnce(ctx, () =>
			createBackgroundComplete({
				commandId: "bg-01TEST0001",
				command: "echo hi",
				exitCode: 0,
				durationMs: 10,
				stdout: "hi\n",
			}),
		);
	}, 30000);
});

describe("Bug 1: batched dedup (multiple messages in one drain)", () => {
	let ctx: EmissionTestContext;
	afterEach(async () => {
		if (ctx) await teardownEmissionTestContext(ctx);
	});

	test("5 task_messages in quick succession", async () => {
		ctx = await setupEmissionTestContext();
		await startAgent(ctx, twoTurnInstruction("batch dedup ok"));
		await waitForIdle(ctx);

		const msgs: QueueMessage[] = [];
		for (let i = 0; i < 5; i++) {
			const m = createTaskMessage(
				`01BATCH${String(i).padStart(5, "0")}`,
				`Peer ${i}`,
				`Msg ${i}`,
			);
			msgs.push(m);
			await injectMessage(ctx, m);
		}

		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const events = await readSessionEvents(ctx, tracker.rootNodeId);
		for (const m of msgs) {
			expect(messageIdOccurrences(events, m.id).length).toBe(1);
		}
	}, 30000);

	test("mixed sources in same tick", async () => {
		ctx = await setupEmissionTestContext();
		await startAgent(ctx, twoTurnInstruction("mixed dedup ok"));
		await waitForIdle(ctx);

		const msgs: QueueMessage[] = [
			createTaskMessage("01MIX000001", "A", "a"),
			createTaskComplete("01MIX000002", "B", true, "b done"),
			createUserMessageForwarded("01MIX000003", "C", "c"),
			createTreeChange("updated", "01MIX000004", "D"),
			createClarifyResponse("e"),
		];
		for (const m of msgs) await injectMessage(ctx, m);

		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const events = await readSessionEvents(ctx, tracker.rootNodeId);
		for (const m of msgs) {
			expect(messageIdOccurrences(events, m.id).length).toBe(1);
		}
	}, 30000);
});

describe("Bug 1: dedup across restarts (replay path)", () => {
	let ctx: EmissionTestContext;
	afterEach(async () => {
		if (ctx) await teardownEmissionTestContext(ctx);
	});

	test("restart after delivering a task_message: still exactly once", async () => {
		ctx = await setupEmissionTestContext();

		const infiniteTurns = JSON.stringify({
			turns: [{ blocks: [{ type: "text", text: "idle forever" }] }],
		});
		await startAgent(ctx, infiniteTurns);
		await waitForIdle(ctx);

		const m = createTaskMessage("01RESTART01", "Sib", "before restart");
		await injectMessage(ctx, m);
		await new Promise((r) => setTimeout(r, 200));

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		const provider = createMockedProviderWithMock(ctx.mockAPI);
		ctx.app = createApp({ dataDir: ctx.dataDir, agentProvider: provider });
		await ctx.app.pm.load();
		await ctx.app.autoResumeProjects();
		ctx.app.markReady();
		await new Promise((r) => setTimeout(r, 500));

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const project = ctx.app.ctx.pm.get(ctx.projectId);
		if (!project) throw new Error("project");
		await deliverMessage(
			ctx.app.ctx,
			project,
			tracker.rootNodeId,
			createUserMessage(singleTurnDoneInstruction("restart dedup ok")),
		);

		await waitForDone(ctx, 20000);

		const events = await readSessionEvents(ctx, tracker.rootNodeId);
		expect(messageIdOccurrences(events, m.id).length).toBe(1);
	}, 40000);
});

describe("Bug 1: deliverMessage byte-identical across paths", () => {
	let ctx: EmissionTestContext;
	afterEach(async () => {
		if (ctx) await teardownEmissionTestContext(ctx);
	});

	test("message body structurally identical whether agent is running or not", async () => {
		// Both paths (direct-emit fallback when agent not running, onPersist
		// when agent is running) produce a `message` event with an identical
		// body shape. Top-level envelope differs only in traceId: the onPersist
		// path is attributable to the running loop, the direct-emit path is not.
		ctx = await setupEmissionTestContext();

		// Path A: deliverMessage while agent NOT running (quiet skips auto-launch)
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const project = ctx.app.ctx.pm.get(ctx.projectId);
		if (!project) throw new Error("project");

		const pathAMsg = createTaskMessage(
			"01BYTE00001",
			"Peer A",
			"path A content",
		);
		await deliverMessage(ctx.app.ctx, project, tracker.rootNodeId, pathAMsg, {
			quiet: true,
		});
		await new Promise((r) => setTimeout(r, 50));
		const eventsA = await readSessionEvents(ctx, tracker.rootNodeId);
		const pathAEvent = eventsA.find(
			(e) => e.type === "message" && (e as { id?: string }).id === pathAMsg.id,
		);
		expect(pathAEvent).toBeDefined();

		// Path B: deliverMessage while agent IS running
		await startAgent(ctx, twoTurnInstruction("byte ok"));
		await waitForIdle(ctx);

		const pathBMsg = createTaskMessage(
			"01BYTE00002",
			"Peer B",
			"path B content",
		);
		await deliverMessage(ctx.app.ctx, project, tracker.rootNodeId, pathBMsg);

		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		const eventsB = await readSessionEvents(ctx, tracker.rootNodeId);
		const pathBEvent = eventsB.find(
			(e) => e.type === "message" && (e as { id?: string }).id === pathBMsg.id,
		);
		expect(pathBEvent).toBeDefined();

		// Same top-level keys aside from traceId (the only semantic difference).
		const keysA = Object.keys(pathAEvent as object)
			.filter((k) => k !== "traceId")
			.sort();
		const keysB = Object.keys(pathBEvent as object)
			.filter((k) => k !== "traceId")
			.sort();
		expect(keysA).toEqual(keysB);

		// Same body keys
		const bodyA = (pathAEvent as { body: Record<string, unknown> }).body;
		const bodyB = (pathBEvent as { body: Record<string, unknown> }).body;
		expect(Object.keys(bodyA).sort()).toEqual(Object.keys(bodyB).sort());

		// Path A (no running loop) has no traceId; path B (onPersist) does.
		expect((pathAEvent as { traceId?: string }).traceId).toBeUndefined();
		expect((pathBEvent as { traceId?: string }).traceId).toBeDefined();
		expect(
			typeof (pathBEvent as { traceId?: string }).traceId === "string",
		).toBe(true);
	}, 30000);
});

describe("Bug 1: direct-enqueue bash bg_complete persisted exactly once", () => {
	let ctx: EmissionTestContext;
	afterEach(async () => {
		if (ctx) await teardownEmissionTestContext(ctx);
	});

	test("agent runs bash bg, completes, JSONL has each bg_complete exactly once", async () => {
		ctx = await setupEmissionTestContext();

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: {
								command: "echo bg-output-marker; sleep 0.2",
								run_in_background: true,
							},
						},
					],
				},
				{
					blocks: [{ type: "tool_use", name: "mcp__mxd__yield", input: {} }],
				},
				{
					blocks: [
						{ type: "text", text: "bg done, wrapping up." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "bg one-shot ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		const status = await waitForDone(ctx, 30000);
		expect(status).toBe("verify");

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const events = await readSessionEvents(ctx, tracker.rootNodeId);

		const bgCompleteEvents = events.filter(
			(e) =>
				e.type === "message" &&
				"body" in e &&
				e.body &&
				typeof e.body === "object" &&
				"source" in e.body &&
				(e.body as { source: string }).source === "background_complete",
		);
		expect(bgCompleteEvents.length).toBeGreaterThanOrEqual(1);

		const ids = new Set<string>();
		for (const e of bgCompleteEvents) {
			const id = (e as { id?: string }).id;
			expect(id).toBeDefined();
			if (id) {
				expect(ids.has(id)).toBe(false);
				ids.add(id);
				expect(messageIdOccurrences(events, id).length).toBe(1);
			}
		}
	}, 40000);
});

describe("Bug 1: yield wake bgOrphans persisted exactly once", () => {
	let ctx: EmissionTestContext;
	afterEach(async () => {
		if (ctx) await teardownEmissionTestContext(ctx);
	});

	test("bg mid-exec during yield: after restart, bg_orphan appears exactly once", async () => {
		ctx = await setupEmissionTestContext();

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "sleep 60", run_in_background: true },
						},
					],
				},
				{
					blocks: [{ type: "tool_use", name: "mcp__mxd__yield", input: {} }],
				},
				{
					blocks: [
						{ type: "text", text: "after wake" },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "yield bg orphan ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);

		const tracker = await ctx.app.getTracker(ctx.projectId);
		let reachedYield = false;
		const start = Date.now();
		while (Date.now() - start < 15000) {
			const events = await readSessionEvents(ctx, tracker.rootNodeId);
			const lastTool = [...events]
				.reverse()
				.find((e) => e.type === "tool_call");
			if (
				lastTool?.type === "tool_call" &&
				lastTool.tool === "mcp__mxd__yield"
			) {
				const hasResult = events.some(
					(e) =>
						e.type === "tool_result" && e.toolCallId === lastTool.toolCallId,
				);
				if (!hasResult) {
					reachedYield = true;
					break;
				}
			}
			await new Promise((r) => setTimeout(r, 100));
		}
		expect(reachedYield).toBe(true);

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 200));

		const provider = createMockedProviderWithMock(ctx.mockAPI);
		ctx.app = createApp({ dataDir: ctx.dataDir, agentProvider: provider });
		await ctx.app.pm.load();
		await ctx.app.autoResumeProjects();
		ctx.app.markReady();

		const status = await waitForDone(ctx, 30000);
		expect(status).toBe("verify");

		const finalEvents = await readSessionEvents(ctx, tracker.rootNodeId);

		const bgOrphanEvents = finalEvents.filter(
			(e) =>
				e.type === "message" &&
				"body" in e &&
				e.body &&
				typeof e.body === "object" &&
				"source" in e.body &&
				(e.body as { source: string }).source === "background_complete",
		);
		expect(bgOrphanEvents.length).toBeGreaterThanOrEqual(1);

		const ids = new Set<string>();
		for (const e of bgOrphanEvents) {
			const id = (e as { id?: string }).id;
			expect(id).toBeDefined();
			if (id) {
				expect(ids.has(id)).toBe(false);
				ids.add(id);
				expect(messageIdOccurrences(finalEvents, id).length).toBe(1);
			}
		}

		// Every yield tool_call must have a tool_result
		const yieldCalls = finalEvents.filter(
			(e) => e.type === "tool_call" && e.tool === "mcp__mxd__yield",
		);
		expect(yieldCalls.length).toBeGreaterThanOrEqual(1);
		for (const yc of yieldCalls) {
			const yieldCall = yc as Event & {
				type: "tool_call";
				toolCallId: string;
			};
			const hasResult = finalEvents.some(
				(e) =>
					e.type === "tool_result" && e.toolCallId === yieldCall.toolCallId,
			);
			expect(hasResult).toBe(true);
		}
	}, 60000);
});

describe("Bug 1: no duplicate message ids in JSONL", () => {
	let ctx: EmissionTestContext;
	afterEach(async () => {
		if (ctx) await teardownEmissionTestContext(ctx);
	});

	test("every message event appears exactly once (after batched injects)", async () => {
		ctx = await setupEmissionTestContext();
		await startAgent(ctx, twoTurnInstruction("no dupes ok"));
		await waitForIdle(ctx);

		await injectMessage(
			ctx,
			createTaskMessage("01REF000001", "Peer", "content"),
		);
		await injectMessage(
			ctx,
			createTreeChange("created", "01REF000002", "Tree node"),
		);

		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const events = await readSessionEvents(ctx, tracker.rootNodeId);

		const idCounts = new Map<string, number>();
		for (const e of events) {
			if (e.type === "message") {
				const id = (e as { id?: string }).id;
				if (id) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
			}
		}
		for (const [id, count] of idCounts) {
			if (count !== 1) {
				console.error(`[dup] id=${id} appears ${count} times`);
			}
			expect(count).toBe(1);
		}
	}, 30000);
});
