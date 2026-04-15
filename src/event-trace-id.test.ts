/**
 * Bug 3: traceId semantics.
 *
 * Events produced BY a specific agent run carry `traceId = session.loopTraceId`.
 * Events that exist independently of any run (deliverMessage `message`,
 * `task_started` before spawn, etc.) do NOT carry traceId — semantic
 * distinction that lets downstream tools correlate events back to their
 * run.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { stopTask } from "./runtime/agent-lifecycle.ts";
import { createApp } from "./runtime.ts";
import type { Event } from "./events.ts";
import {
	createTaskComplete,
	createTaskMessage,
	createUserMessage,
} from "./queue-message-factory.ts";
import {
	type EmissionTestContext,
	injectMessage,
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

describe("Bug 3: traceId semantics — run-bound vs external", () => {
	let ctx: EmissionTestContext;
	afterEach(async () => {
		if (ctx) await teardownEmissionTestContext(ctx);
	});

	test("orchestration_started carries a non-empty traceId", async () => {
		ctx = await setupEmissionTestContext();
		await startAgent(ctx, singleTurnDoneInstruction("started ok"));
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const events = await readSessionEvents(ctx, tracker.rootNodeId);
		const started = events.find((e) => e.type === "agent_start") as
			| (Event & { traceId?: string })
			| undefined;
		expect(started?.traceId).toBeDefined();
		expect(typeof started?.traceId).toBe("string");
		expect((started?.traceId ?? "").length).toBeGreaterThan(0);
	}, 30000);

	test("orchestration_completed + done_notified share orchestration_started's traceId", async () => {
		ctx = await setupEmissionTestContext();
		await startAgent(ctx, singleTurnDoneInstruction("lifecycle trace ok"));
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const events = await readSessionEvents(ctx, tracker.rootNodeId);

		const started = events.find((e) => e.type === "agent_start") as
			| (Event & { traceId?: string })
			| undefined;
		const expectedTrace = started?.traceId;
		expect(expectedTrace).toBeDefined();

		const completed = events.find((e) => e.type === "agent_end") as
			| (Event & { traceId?: string })
			| undefined;
		if (completed) {
			expect(completed.traceId).toBe(expectedTrace as string);
		}

		const done = events.find((e) => e.type === "done_notified") as
			| (Event & { traceId?: string })
			| undefined;
		if (done) {
			expect(done.traceId).toBe(expectedTrace as string);
		}
	}, 30000);

	test("provider events (assistant_text, tool_call, tool_result, usage) all carry traceId", async () => {
		ctx = await setupEmissionTestContext();
		await startAgent(ctx, singleTurnDoneInstruction("provider trace ok"));
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const events = await readSessionEvents(ctx, tracker.rootNodeId);
		const started = events.find((e) => e.type === "agent_start") as
			| (Event & { traceId?: string })
			| undefined;
		const expectedTrace = started?.traceId;
		expect(expectedTrace).toBeDefined();

		const providerTypes = [
			"assistant_text",
			"tool_call",
			"tool_result",
			"usage",
		];
		for (const t of providerTypes) {
			const matching = events.filter((e) => e.type === t) as Array<
				Event & { traceId?: string }
			>;
			for (const e of matching) {
				expect(e.traceId).toBe(expectedTrace as string);
			}
		}
	}, 30000);

	test("deliverMessage-sourced message events while agent is running carry the run's traceId (onPersist path)", async () => {
		// Semantic: persistence happens through the running queue's onPersist
		// callback → the CURRENT run performed the JSONL write → it carries the
		// run's traceId. Content origin (task_message) doesn't matter — the
		// A/B distinction is persistence timestamp, not semantic origin.
		ctx = await setupEmissionTestContext();
		await startAgent(ctx, twoTurnInstruction("ext trace ok"));
		await waitForIdle(ctx);

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const before = await readSessionEvents(ctx, tracker.rootNodeId);
		const started = before.find((e) => e.type === "agent_start") as
			| (Event & { traceId?: string })
			| undefined;
		const expectedTrace = started?.traceId;
		expect(expectedTrace).toBeDefined();

		const injected = createTaskMessage("01EXT000001", "Peer", "external msg");
		await injectMessage(ctx, injected);

		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		const events = await readSessionEvents(ctx, tracker.rootNodeId);
		const msg = events.find(
			(e) => e.type === "message" && (e as { id?: string }).id === injected.id,
		) as (Event & { traceId?: string }) | undefined;
		expect(msg).toBeDefined();
		expect(msg?.traceId).toBe(expectedTrace as string);
	}, 30000);

	test("user-source deliverMessage arriving before the loop exists (cold-start) has no traceId", async () => {
		// Semantic: the first prompt hits the task BEFORE any run has started.
		// deliverMessage takes the direct-emitEvent fallback (queue unavailable)
		// → no run to attribute the write to → no traceId. After the agent
		// starts, that same message will be recovered by findUnconsumedMessages
		// and replayed into the queue with `replay: true`, skipping onPersist
		// — so the JSONL entry stays without traceId.
		ctx = await setupEmissionTestContext();
		await startAgent(ctx, singleTurnDoneInstruction("http no trace ok"));
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const events = await readSessionEvents(ctx, tracker.rootNodeId);
		const userMessages = events.filter(
			(e) =>
				e.type === "message" &&
				"body" in e &&
				e.body &&
				typeof e.body === "object" &&
				"source" in e.body &&
				(e.body as { source: string }).source === "user",
		) as Array<Event & { traceId?: string }>;
		expect(userMessages.length).toBeGreaterThanOrEqual(1);
		for (const m of userMessages) {
			expect(m.traceId).toBeUndefined();
		}
	}, 30000);

	test("agent_start carries the loop's traceId", async () => {
		ctx = await setupEmissionTestContext();
		await startAgent(ctx, singleTurnDoneInstruction("agent_start has traceId"));
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const events = await readSessionEvents(ctx, tracker.rootNodeId);
		const agentStartEvents = events.filter(
			(e) => e.type === "agent_start",
		) as Array<Event & { traceId?: string }>;
		expect(agentStartEvents.length).toBeGreaterThanOrEqual(1);
		for (const e of agentStartEvents) {
			// agent_start is emitted inside runAgentForNode → has traceId
			expect(e.traceId).toBeDefined();
		}
	}, 30000);

	test("agent_stopped (from stopTask) carries the stopped run's traceId", async () => {
		ctx = await setupEmissionTestContext();
		const instruction = JSON.stringify({
			turns: [{ blocks: [{ type: "text", text: "idle forever" }] }],
		});
		await startAgent(ctx, instruction);
		await waitForIdle(ctx);

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const before = await readSessionEvents(ctx, tracker.rootNodeId);
		const started = before.find((e) => e.type === "agent_start") as
			| (Event & { traceId?: string })
			| undefined;
		expect(started?.traceId).toBeDefined();
		const expected = started?.traceId;

		const stopped = await stopTask(
			ctx.app.ctx,
			ctx.projectId,
			tracker.rootNodeId,
		);
		expect(stopped).toBe(true);
		await new Promise((r) => setTimeout(r, 200));

		const after = await readSessionEvents(ctx, tracker.rootNodeId);
		const stoppedEvents = after.filter((e) => e.type === "agent_end") as Array<
			Event & { traceId?: string }
		>;
		expect(stoppedEvents.length).toBeGreaterThanOrEqual(1);
		for (const s of stoppedEvents) {
			expect(s.traceId).toBe(expected as string);
		}
	}, 30000);

	test("all events in one run share one traceId (no mixing)", async () => {
		ctx = await setupEmissionTestContext();
		await startAgent(
			ctx,
			JSON.stringify({
				blocks: [
					{ type: "text", text: "Text content for trace consistency" },
					{
						type: "tool_use",
						name: "mcp__mxd__done",
						input: {
							status: "passed",
							summary: "trace consistency ok",
						},
					},
				],
			}),
		);
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const events = await readSessionEvents(ctx, tracker.rootNodeId);

		const traceIds = new Set<string>();
		for (const e of events) {
			const t = (e as { traceId?: string }).traceId;
			if (t) traceIds.add(t);
		}
		expect(traceIds.size).toBe(1);
	}, 30000);
});

describe("Bug 3: R.emit traceId auto-injection from tool handlers", () => {
	let ctx: EmissionTestContext;
	afterEach(async () => {
		if (ctx) await teardownEmissionTestContext(ctx);
	});

	test("clarification_requested event has the current run's traceId", async () => {
		ctx = await setupEmissionTestContext();

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__clarify",
							input: { question: "proceed?" },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Got answer." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "clarify trace ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);

		const tracker = await ctx.app.getTracker(ctx.projectId);
		let events: Event[] = [];
		const start = Date.now();
		while (Date.now() - start < 15000) {
			events = await readSessionEvents(ctx, tracker.rootNodeId);
			if (events.some((e) => e.type === "clarification_requested")) break;
			await new Promise((r) => setTimeout(r, 100));
		}

		const clarify = events.find((e) => e.type === "clarification_requested") as
			| (Event & { traceId?: string })
			| undefined;
		expect(clarify).toBeDefined();
		expect(clarify?.traceId).toBeDefined();

		const started = events.find((e) => e.type === "agent_start") as
			| (Event & { traceId?: string })
			| undefined;
		expect(started?.traceId).toBeDefined();
		expect(clarify?.traceId).toBe(started?.traceId as string);

		// Agent already completed (clarify tool_result → done in same turn).
		// Verify status before sending clarify_response — sending it after done
		// would re-launch the root agent (expected behavior: messages wake done agents).
		const status = await waitForDone(ctx, 20000);
		expect(status).toBe("verify");

		// Clarify response after done is still valid — it would re-launch,
		// but for this test we only need the traceId assertion above.
	}, 40000);
});

describe("Bug 3: traceId distinct across restarts", () => {
	let ctx: EmissionTestContext;
	afterEach(async () => {
		if (ctx) await teardownEmissionTestContext(ctx);
	});

	test("two runs produce two distinct traceIds", async () => {
		ctx = await setupEmissionTestContext();

		await startAgent(ctx, singleTurnDoneInstruction("run 1 ok"));
		const status1 = await waitForDone(ctx);
		expect(status1).toBe("verify");

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const events1 = await readSessionEvents(ctx, tracker.rootNodeId);
		const started1 = events1.find((e) => e.type === "agent_start") as
			| (Event & { traceId?: string })
			| undefined;
		const trace1 = started1?.traceId;
		expect(trace1).toBeDefined();

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		const provider = createMockedProviderWithMock(ctx.mockAPI);
		ctx.app = createApp({ dataDir: ctx.dataDir, agentProvider: provider });
		await ctx.app.autoResumeProjects();
		ctx.app.markReady();
		await new Promise((r) => setTimeout(r, 200));

		await ctx.app.app.request(
			`/projects/${ctx.projectId}/tasks/${tracker.rootNodeId}/message`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					content: singleTurnDoneInstruction("run 2 ok"),
				}),
			},
		);

		const status2 = await waitForDone(ctx, 20000);
		expect(status2).toBe("verify");

		const events2 = await readSessionEvents(ctx, tracker.rootNodeId);
		const allStarted = events2.filter((e) => e.type === "agent_start") as Array<
			Event & { traceId?: string }
		>;
		expect(allStarted.length).toBe(2);

		const trace2 = allStarted[1]?.traceId;
		expect(trace2).toBeDefined();
		expect(trace1).not.toBe(trace2);

		const firstStartedIdx = events2.findIndex((e) => e.type === "agent_start");
		const secondStartedIdx = events2.findIndex(
			(e, i) => i > firstStartedIdx && e.type === "agent_start",
		);

		for (let i = secondStartedIdx; i < events2.length; i++) {
			const e = events2[i] as Event & { traceId?: string };
			if (e.traceId) {
				expect(e.traceId).toBe(trace2 as string);
			}
		}
	}, 60000);
});

// Suppress unused-import warning for stopTask and createTaskComplete
void stopTask;
void createTaskComplete;
void createUserMessage;
