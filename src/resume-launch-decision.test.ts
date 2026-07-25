/**
 * "Only launch what will actually do something" — across a real restart.
 *
 * ## Why these tests must cross a persist/reload boundary
 *
 * The launch decision is only interesting on the path where in-memory state is
 * gone. `quiet` is an argument to `enqueue`, not a field on the message, so it
 * does not survive to JSONL — an in-process test still has the flag in memory
 * and behaves correctly no matter what the predicate keys on. Only a real
 * restart drops it, and a predicate that leaned on quietness would then read
 * the interrupt notice as ordinary pending input, launch the agent, and hand
 * it its own interruption notice.
 *
 * So every test here shuts the app down, builds a new one over the SAME
 * dataDir, and runs `autoResumeProjects` — the production boot path.
 *
 * The observable asserted is deliberately "did a session get built", not "did
 * the agent produce output": session construction (MCP connect, work context,
 * session_config) is the entire cost being avoided, and it happens before the
 * loop ever looks at the conversation.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { basename, join } from "node:path";
import { EventStore } from "./event-store.ts";
import { type Event, findUnconsumedMessages } from "./events.ts";
import { INTERRUPT_NOTICE } from "./message-queue.ts";
import { createUserMessage } from "./queue-message-factory.ts";
import { interruptTask } from "./runtime/agent-lifecycle.ts";
import { createMatrixApp as createApp } from "./test-utils/create-matrix-app.ts";
import {
	type EmissionTestContext,
	injectMessage,
	readSessionEvents,
	setupEmissionTestContext,
	startAgent,
	teardownEmissionTestContext,
	waitForIdle,
} from "./test-utils/emission-harness.ts";
import { matrixBuildScopeOpts } from "./test-utils/matrix-scope.ts";
import { createMockedProviderWithMock } from "./test-utils/mock-anthropic-api.ts";

/** Rebuild the app over the same dataDir — a daemon restart. */
function recreateApp(ctx: EmissionTestContext): ReturnType<typeof createApp> {
	const app = createApp({
		dataDir: ctx.dataDir,
		agentProvider: createMockedProviderWithMock(ctx.mockAPI),
		projects: [
			{
				id: ctx.projectId,
				name: basename(ctx.projectDir),
				path: ctx.projectDir,
			},
		],
		buildScopeOpts: matrixBuildScopeOpts,
	});
	app.markReady();
	return app;
}

async function waitFor(
	pred: () => boolean | Promise<boolean>,
	what: string,
	timeoutMs = 5000,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await pred()) return;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** Does this node have a live session — i.e. did the boot pay for one? */
function hasSession(
	app: ReturnType<typeof createApp>,
	projectId: string,
	nodeId: string,
): boolean {
	return !!app.ctx.trackers.get(projectId)?.getTask(nodeId)?.session;
}

/** One bash tool_use, long enough to be interrupted mid-turn. */
const SLOW_TURN = JSON.stringify({
	turns: [
		{
			blocks: [
				{ type: "text", text: "Working on it." },
				{
					type: "tool_use",
					name: "mcp__mxd__bash",
					input: { command: "sleep 30" },
				},
			],
		},
	],
});

describe("interrupt → restart: the agent is not relaunched", () => {
	let ctx: EmissionTestContext;
	let restarted: ReturnType<typeof createApp> | null = null;
	afterEach(async () => {
		if (restarted) {
			await restarted.shutdown();
			restarted = null;
		}
		if (ctx) await teardownEmissionTestContext(ctx);
	});

	// The headline. Before this change, memory.md documented the boundary as an
	// accepted cost: "I pressed stop, then restarted the daemon, and it started
	// working again." Interrupted during a tool, the repaired tool_results make
	// the conversation end on a user turn, which is indistinguishable from a
	// daemon death mid-work — so the restart resumed it.
	test("interrupted mid-tool, then restarted → no session is built", async () => {
		ctx = await setupEmissionTestContext();
		ctx.mockAPI.disableStrictToolErrors(); // the interrupted bash reports isError
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const nodeId = tracker.rootNodeId;

		await startAgent(ctx, SLOW_TURN);
		await waitFor(
			() => !!ctx.app.ctx.trackers.get(ctx.projectId)?.getTask(nodeId)?.session,
			"the session to exist",
		);
		await waitFor(
			() => ctx.mockAPI.getRequestCount() >= 1,
			"the first API request",
		);

		expect(interruptTask(ctx.app.ctx, ctx.projectId, nodeId)).toBe(true);
		await waitForIdle(ctx);

		const requestsBefore = ctx.mockAPI.getRequestCount();

		// ── the boundary: everything in memory is now gone ──
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		restarted = recreateApp(ctx);
		await restarted.autoResumeProjects();
		await new Promise((r) => setTimeout(r, 300));

		expect(hasSession(restarted, ctx.projectId, nodeId)).toBe(false);
		expect(ctx.mockAPI.getRequestCount()).toBe(requestsBefore);
	}, 30000);

	// The case with no other signal at all. Interrupted before anything
	// streamed, the log is `messages_consumed → message(interrupt)` — and
	// without the notice that is byte-for-byte the shape of a daemon death
	// inside an API call, which MUST relaunch. The notice is the only thing
	// telling the two apart.
	test("the notice lands in JSONL, unconsumed, and survives the restart", async () => {
		ctx = await setupEmissionTestContext();
		ctx.mockAPI.disableStrictToolErrors();
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const nodeId = tracker.rootNodeId;

		await startAgent(ctx, SLOW_TURN);
		await waitFor(
			() => ctx.mockAPI.getRequestCount() >= 1,
			"the first API request",
		);
		interruptTask(ctx.app.ctx, ctx.projectId, nodeId);
		await waitForIdle(ctx);

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		// Read from DISK, not from the app — this is the state a fresh daemon sees.
		const store = new EventStore(
			join(ctx.dataDir, "projects", ctx.projectId, "tasks"),
		);
		const events = store.readActive(nodeId);

		const notices = events.filter(
			(e: Event) =>
				e.type === "message" &&
				(e.body as { source?: string })?.source === "interrupt",
		);
		expect(notices.length).toBe(1);

		// Unconsumed — messages_consumed is written on drain, and a quiet
		// message is never drained until something else wakes the queue. Rule 2
		// collapses silently if a future change to drain timing breaks this.
		const unconsumed = findUnconsumedMessages(events);
		expect(unconsumed.some((m) => m.source === "interrupt")).toBe(true);
	}, 30000);

	// A restart with real work outstanding must still resume — otherwise this
	// whole change is just "stop resuming agents", which would be a regression
	// wearing an optimisation's clothes.
	test("a real message waiting → the agent IS relaunched", async () => {
		ctx = await setupEmissionTestContext();
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const nodeId = tracker.rootNodeId;

		await startAgent(
			ctx,
			JSON.stringify({
				turns: [{ blocks: [{ type: "text", text: "Parked, waiting." }] }],
			}),
		);
		await waitForIdle(ctx);
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		// A message arrives while the daemon is down: write it straight to
		// JSONL, which is what deliverMessage does for a node with no session.
		const store = new EventStore(
			join(ctx.dataDir, "projects", ctx.projectId, "tasks"),
		);
		const id = `msg-${Date.now()}`;
		await store.append(nodeId, {
			type: "message",
			id,
			taskId: nodeId,
			ts: Date.now(),
			body: { source: "user", id, ts: Date.now(), content: "are you there?" },
		} as Event);

		restarted = recreateApp(ctx);
		await restarted.autoResumeProjects();

		await waitFor(
			() =>
				hasSession(
					restarted as ReturnType<typeof createApp>,
					ctx.projectId,
					nodeId,
				),
			"the agent to be relaunched for the pending message",
		);
	}, 30000);

	// The dormant case, measured on the real tree as 15 of 15 nodes: parked on
	// an end_turn with nothing owed. This is the shape the whole change exists
	// to stop paying for.
	test("parked on end_turn with nothing owed → no session is built", async () => {
		ctx = await setupEmissionTestContext();
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const nodeId = tracker.rootNodeId;

		await startAgent(
			ctx,
			JSON.stringify({
				turns: [{ blocks: [{ type: "text", text: "All done for now." }] }],
			}),
		);
		await waitForIdle(ctx);
		const requestsBefore = ctx.mockAPI.getRequestCount();

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));

		restarted = recreateApp(ctx);
		await restarted.autoResumeProjects();
		await new Promise((r) => setTimeout(r, 300));

		expect(hasSession(restarted, ctx.projectId, nodeId)).toBe(false);
		expect(ctx.mockAPI.getRequestCount()).toBe(requestsBefore);
	}, 30000);
});

describe("what the model reads after being interrupted", () => {
	let ctx: EmissionTestContext;
	afterEach(async () => {
		if (ctx) await teardownEmissionTestContext(ctx);
	});

	// The other half of the feature: the model must LEARN it was cut off. The
	// notice is quiet, so it does not wake anything — it rides along with
	// whatever the user says next.
	test("the next turn's request carries the interruption notice", async () => {
		ctx = await setupEmissionTestContext();
		ctx.mockAPI.disableStrictToolErrors();
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const nodeId = tracker.rootNodeId;

		await startAgent(ctx, SLOW_TURN);
		await waitFor(
			() => ctx.mockAPI.getRequestCount() >= 1,
			"the first API request",
		);
		interruptTask(ctx.app.ctx, ctx.projectId, nodeId);
		await waitForIdle(ctx);

		const before = ctx.mockAPI.getRequestCount();
		await injectMessage(
			ctx,
			createUserMessage("no, do something else instead"),
		);
		await waitFor(
			() => ctx.mockAPI.getRequestCount() > before,
			"the woken turn's request",
		);

		const body = JSON.stringify(ctx.mockAPI.getRequestHistory().at(-1));
		expect(body).toContain(INTERRUPT_NOTICE);
		expect(body).toContain("no, do something else instead");
	}, 30000);

	// The notice must never wake the agent by itself — that is what `quiet`
	// buys, and the ordering it depends on is pinned in interrupt-notice.test.ts.
	test("the notice alone does not start a turn", async () => {
		ctx = await setupEmissionTestContext();
		ctx.mockAPI.disableStrictToolErrors();
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const nodeId = tracker.rootNodeId;

		await startAgent(ctx, SLOW_TURN);
		await waitFor(
			() => ctx.mockAPI.getRequestCount() >= 1,
			"the first API request",
		);
		interruptTask(ctx.app.ctx, ctx.projectId, nodeId);
		await waitForIdle(ctx);

		const after = ctx.mockAPI.getRequestCount();
		await new Promise((r) => setTimeout(r, 400));
		expect(ctx.mockAPI.getRequestCount()).toBe(after);

		const events = await readSessionEvents(ctx, nodeId);
		expect(
			events.filter(
				(e: Event) =>
					e.type === "message" &&
					(e.body as { source?: string })?.source === "interrupt",
			).length,
		).toBe(1);
	}, 30000);
});
