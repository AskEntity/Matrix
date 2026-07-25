/**
 * Interrupt: end the current turn without dismantling the session.
 *
 * The two tests this feature exists for are the first two:
 *
 * 1. A background process survives an interrupt. `stopTask` kills them, which
 *    is why pressing "stop" three minutes into a `bun test` used to throw the
 *    test run away.
 * 2. An interrupted session needs NO repair. `stopTask` deliberately leaves
 *    unclosed tool_calls for the next launch to paper over with a synthetic
 *    "Tool execution was interrupted by daemon restart" result — a sentence
 *    that is false whenever a human pressed stop, and that the model then reads
 *    on every subsequent turn. An interrupt leaves the loop alive, so the loop
 *    closes its own tool_calls and `buildSessionRepair` finds nothing to do.
 *
 * The rest pin the properties those two rest on: every tool_use of the turn
 * gets a result, an interrupted command reports what it printed before it was
 * stopped, the same agent continues afterwards, and reconstruction from JSONL
 * still builds the tool_results as ONE user turn.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { eventsToAnthropicMessages } from "./anthropic-compatible-provider.ts";
import { EventStore } from "./event-store.ts";
import { buildSessionRepair, type Event } from "./events.ts";
import { createUserMessage } from "./queue-message-factory.ts";
import { interruptTask } from "./runtime/agent-lifecycle.ts";
import { subscribeToEvents } from "./runtime/event-system.ts";
import {
	type EmissionTestContext,
	injectMessage,
	readSessionEvents,
	setupEmissionTestContext,
	startAgent,
	teardownEmissionTestContext,
	waitForIdle,
} from "./test-utils/emission-harness.ts";
import { INTERRUPTED_BY_USER } from "./tools/bash.ts";
import type { AgentActivity, TaskSession } from "./types.ts";

/** The lie an interrupt must never produce. */
const RESTART_REPAIR_TEXT = "Tool execution was interrupted by daemon restart";

function session(ctx: EmissionTestContext, nodeId: string): TaskSession {
	const tracker = ctx.app.ctx.trackers.get(ctx.projectId);
	const s = tracker?.getTask(nodeId)?.session;
	if (!s) throw new Error("no live session");
	return s;
}

async function rootId(ctx: EmissionTestContext): Promise<string> {
	return (await ctx.app.getTracker(ctx.projectId)).rootNodeId;
}

/** Wait until the loop reports a given activity. */
async function waitForActivity(
	ctx: EmissionTestContext,
	nodeId: string,
	state: AgentActivity,
	timeoutMs = 10000,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const tracker = ctx.app.ctx.trackers.get(ctx.projectId);
		if (tracker?.getTask(nodeId)?.session?.activity === state) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error(`activity did not reach "${state}" within ${timeoutMs}ms`);
}

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	what: string,
	timeoutMs = 10000,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await predicate()) return;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** The active chain — what a fresh daemon would feed to repair and the walker. */
function readActiveEvents(
	ctx: EmissionTestContext,
	sessionId: string,
): Event[] {
	const store = new EventStore(
		join(ctx.dataDir, "projects", ctx.projectId, "tasks"),
	);
	return store.readActive(sessionId) as Event[];
}

/** One bash tool_use per command, in a single assistant turn. */
function bashTurn(...commands: string[]): string {
	return JSON.stringify({
		blocks: [
			{ type: "text", text: "Working." },
			...commands.map((command) => ({
				type: "tool_use",
				name: "mcp__mxd__bash",
				input: { command },
			})),
		],
	});
}

describe("Interrupt: end the turn, keep the session", () => {
	let ctx: EmissionTestContext;
	afterEach(async () => {
		if (ctx) await teardownEmissionTestContext(ctx);
	});

	// ── 1. The headline: background processes survive ──
	//
	// Asserted behaviourally, not by bookkeeping: the background command writes
	// a file AFTER the interrupt happens. A status field could say "running"
	// while the process was already dead; a file that appears afterwards could
	// only have been written by a process that was still alive.
	test("a background process keeps running through an interrupt", async () => {
		ctx = await setupEmissionTestContext();
		ctx.mockAPI.disableStrictToolErrors(); // the interrupted command reports isError
		const nodeId = await rootId(ctx);
		const marker = join(ctx.projectDir, "bg-alive.txt");

		await startAgent(
			ctx,
			JSON.stringify({
				turns: [
					{
						blocks: [
							{ type: "text", text: "Starting background work." },
							{
								type: "tool_use",
								name: "mcp__mxd__bash",
								input: {
									command: `sleep 1; echo ALIVE > ${marker}`,
									run_in_background: true,
								},
							},
						],
					},
					{
						blocks: [
							{ type: "text", text: "Now the slow one." },
							{
								type: "tool_use",
								name: "mcp__mxd__bash",
								input: { command: "sleep 30" },
							},
						],
					},
				],
			}),
		);

		// Turn 2 is running the foreground sleep — that is the `tool` state.
		await waitForActivity(ctx, nodeId, "tool");
		await waitFor(
			() => session(ctx, nodeId).foregroundExecutions.size > 0,
			"the foreground bash to register",
		);
		expect(existsSync(marker)).toBe(false); // not written yet — so it proves liveness

		expect(interruptTask(ctx.app.ctx, ctx.projectId, nodeId)).toBe(true);

		// The agent parks…
		await waitForIdle(ctx);
		// …and the background process, untouched, finishes its work.
		await waitFor(() => existsSync(marker), "the background process to finish");

		const bg = [...session(ctx, nodeId).backgroundProcesses.values()];
		expect(bg.length).toBe(1);
		expect(bg[0]?.status).not.toBe("failed");
	}, 30000);

	// ── 2. The definition: no repair, ever ──
	test("after an interrupt the session needs NO repair", async () => {
		ctx = await setupEmissionTestContext();
		ctx.mockAPI.disableStrictToolErrors();
		const nodeId = await rootId(ctx);

		await startAgent(ctx, bashTurn("sleep 30"));
		await waitForActivity(ctx, nodeId, "tool");
		interruptTask(ctx.app.ctx, ctx.projectId, nodeId);
		await waitForIdle(ctx);

		// Exactly what a fresh daemon does before starting the provider loop.
		const active = readActiveEvents(ctx, nodeId);
		expect(buildSessionRepair(active, nodeId)).toBeNull();

		// And the lie never entered the log by any other route.
		const all = await readSessionEvents(ctx, nodeId);
		expect(JSON.stringify(all)).not.toContain(RESTART_REPAIR_TEXT);
	}, 30000);

	// ── 3. Every tool_use of the turn gets a result ──
	//
	// Completeness here is structural (Promise.all settles for all of them and
	// executeTool never throws) — the point of the test is that the interrupt
	// does not break the structure by bailing out early.
	test("a multi-tool turn interrupted mid-flight closes ALL of its tool_calls", async () => {
		ctx = await setupEmissionTestContext();
		ctx.mockAPI.disableStrictToolErrors();
		const nodeId = await rootId(ctx);

		await startAgent(
			ctx,
			bashTurn("echo FAST_ONE", "echo SLOW_ONE; sleep 30", "sleep 30"),
		);
		await waitForActivity(ctx, nodeId, "tool");
		await waitFor(
			() => session(ctx, nodeId).foregroundExecutions.size >= 2,
			"both slow commands to register",
		);
		interruptTask(ctx.app.ctx, ctx.projectId, nodeId);
		await waitForIdle(ctx);

		const events = await readSessionEvents(ctx, nodeId);
		const calls = events.filter((e) => e.type === "tool_call");
		const results = events.filter((e) => e.type === "tool_result");
		expect(calls.length).toBe(3);
		expect(results.length).toBe(3);
		const callIds = new Set(
			calls.map((e) => (e as { toolCallId: string }).toolCallId),
		);
		for (const r of results) {
			expect(callIds.has((r as { toolCallId: string }).toolCallId)).toBe(true);
		}
		// The one that finished before the interrupt reports its real output.
		expect(
			results.some((r) =>
				(r as { content: string }).content.includes("FAST_ONE"),
			),
		).toBe(true);
	}, 30000);

	// ── 4. An interrupted command reports what it already produced ──
	//
	// "interrupted" alone would tell the model it ran a command and lost the
	// result, which invites re-running something that already had side effects.
	test("an interrupted command's output is preserved in its tool_result", async () => {
		ctx = await setupEmissionTestContext();
		ctx.mockAPI.disableStrictToolErrors();
		const nodeId = await rootId(ctx);

		await startAgent(ctx, bashTurn("echo CANARY_OUTPUT_KEPT; sleep 30"));
		await waitForActivity(ctx, nodeId, "tool");
		await waitFor(
			() => session(ctx, nodeId).foregroundExecutions.size > 0,
			"the command to register",
		);
		// Give the echo a moment to reach the output file.
		await new Promise((r) => setTimeout(r, 150));
		interruptTask(ctx.app.ctx, ctx.projectId, nodeId);
		await waitForIdle(ctx);

		const events = await readSessionEvents(ctx, nodeId);
		const result = events.find((e) => e.type === "tool_result") as
			| { content: string }
			| undefined;
		expect(result).toBeTruthy();
		expect(result?.content).toContain("CANARY_OUTPUT_KEPT");
		expect(result?.content).toContain(INTERRUPTED_BY_USER);
	}, 30000);

	// ── 5. The session is intact: same agent, delivered messages, no relaunch ──
	test("after an interrupt the SAME agent continues on the next message", async () => {
		ctx = await setupEmissionTestContext();
		ctx.mockAPI.disableStrictToolErrors();
		const nodeId = await rootId(ctx);

		await startAgent(
			ctx,
			JSON.stringify({
				turns: [
					{
						blocks: [
							{ type: "text", text: "Working." },
							{
								type: "tool_use",
								name: "mcp__mxd__bash",
								input: { command: "sleep 30" },
							},
						],
					},
					{
						blocks: [
							{ type: "text", text: "Picked it up." },
							{
								type: "tool_use",
								name: "mcp__mxd__done",
								input: { status: "passed", result: "resumed after interrupt" },
							},
						],
					},
				],
			}),
		);
		await waitForActivity(ctx, nodeId, "tool");
		const liveSession = session(ctx, nodeId);
		interruptTask(ctx.app.ctx, ctx.projectId, nodeId);
		await waitForIdle(ctx);

		// The session object itself survived — not a replacement.
		expect(session(ctx, nodeId)).toBe(liveSession);
		expect(liveSession.queue.isClosed).toBe(false);

		const startsBefore = (await readSessionEvents(ctx, nodeId)).filter(
			(e) => e.type === "agent_start",
		).length;

		await injectMessage(ctx, createUserMessage("do the other thing instead"));
		await waitFor(async () => {
			const tracker = await ctx.app.getTracker(ctx.projectId);
			return tracker.getTask(nodeId)?.status === "verify";
		}, "the agent to finish after the interrupt");

		const events = await readSessionEvents(ctx, nodeId);
		// No relaunch: the interrupt resumed the SAME loop.
		expect(events.filter((e) => e.type === "agent_start").length).toBe(
			startsBefore,
		);
		// The message sent during the interrupt was read normally.
		const consumed = events.filter((e) => e.type === "messages_consumed");
		expect(consumed.length).toBeGreaterThan(0);
		expect(JSON.stringify(events)).toContain("do the other thing instead");
	}, 30000);

	// ── 6. Reconstruction shape ──
	//
	// The interrupt's own `status` event lands BEFORE the tool_results (it is
	// written while the tools are still running). That position matters: the
	// walker's tool_result collection loop breaks on any unrecognised event, so
	// a status landing INSIDE the run would split one user turn into two. The
	// repair path has the mirror-image rule for the same reason — its status
	// event must come last. Reasoning is not enough here; pin it.
	test("reconstruction keeps the interrupted turn's tool_results in ONE user message", async () => {
		ctx = await setupEmissionTestContext();
		ctx.mockAPI.disableStrictToolErrors();
		const nodeId = await rootId(ctx);

		await startAgent(ctx, bashTurn("sleep 30", "sleep 30"));
		await waitForActivity(ctx, nodeId, "tool");
		await waitFor(
			() => session(ctx, nodeId).foregroundExecutions.size >= 2,
			"both commands to register",
		);
		interruptTask(ctx.app.ctx, ctx.projectId, nodeId);
		await waitForIdle(ctx);

		const messages = eventsToAnthropicMessages(
			readActiveEvents(ctx, nodeId),
		) as Array<{ role: string; content: unknown }>;
		const last = messages[messages.length - 1];
		expect(last?.role).toBe("user");
		const blocks = last?.content as Array<{ type: string }>;
		expect(blocks.filter((b) => b.type === "tool_result").length).toBe(2);
	}, 30000);

	// ── 7. The window where the batch never started ──
	//
	// The only granularity at which "this tool had not been reached yet" exists:
	// the tools all start together, so either the batch ran or it did not.
	// Reached deterministically by requesting the interrupt from an event
	// subscriber during the tool_call emission — that emission happens after the
	// response is processed and before execution begins. Uses the raw signal
	// rather than interruptTask to keep the emit non-reentrant.
	test("an interrupt landing before execution marks every tool NOT executed", async () => {
		ctx = await setupEmissionTestContext();
		ctx.mockAPI.disableStrictToolErrors();
		const nodeId = await rootId(ctx);
		const marker = join(ctx.projectDir, "must-not-exist.txt");

		const unsubscribe = subscribeToEvents(ctx.app.ctx, ctx.projectId, (e) => {
			if (e.type === "tool_call") {
				ctx.app.ctx.trackers
					.get(ctx.projectId)
					?.getTask(nodeId)
					?.session?.interrupt.request();
			}
		});

		try {
			await startAgent(ctx, bashTurn(`echo x > ${marker}`, "echo y"));
			await waitForIdle(ctx);
		} finally {
			unsubscribe();
		}

		// Nothing ran — the side effect the first command would have had is absent.
		expect(existsSync(marker)).toBe(false);

		const events = await readSessionEvents(ctx, nodeId);
		const results = events.filter((e) => e.type === "tool_result");
		expect(results.length).toBe(2);
		for (const r of results) {
			expect((r as { content: string }).content).toContain("Not executed");
		}
		// Still no repair owed: unexecuted is not unclosed.
		expect(
			buildSessionRepair(readActiveEvents(ctx, nodeId), nodeId),
		).toBeNull();
	}, 30000);

	// ── 8. done() wins a race with the stop button ──
	//
	// A stop that lands on a done() is the task finishing, not being cut off.
	// Turning done() into "not executed" would leave the parent waiting forever.
	test("done() still completes when an interrupt lands in the same turn", async () => {
		ctx = await setupEmissionTestContext();
		const nodeId = await rootId(ctx);

		const unsubscribe = subscribeToEvents(ctx.app.ctx, ctx.projectId, (e) => {
			if (e.type === "tool_call") {
				ctx.app.ctx.trackers
					.get(ctx.projectId)
					?.getTask(nodeId)
					?.session?.interrupt.request();
			}
		});

		try {
			await startAgent(
				ctx,
				JSON.stringify({
					blocks: [
						{ type: "text", text: "Finishing." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", result: "finished despite the stop" },
						},
					],
				}),
			);
			await waitFor(async () => {
				const tracker = await ctx.app.getTracker(ctx.projectId);
				return tracker.getTask(nodeId)?.status === "verify";
			}, "done() to complete");
		} finally {
			unsubscribe();
		}

		const tracker = await ctx.app.getTracker(ctx.projectId);
		expect(tracker.getTask(nodeId)?.status).toBe("verify");
	}, 30000);

	// ── 9. Interrupting a thinking turn ──
	test("interrupting an idle agent is a no-op, not an error", async () => {
		ctx = await setupEmissionTestContext();
		const nodeId = await rootId(ctx);

		await startAgent(
			ctx,
			JSON.stringify({ blocks: [{ type: "text", text: "Waiting for you." }] }),
		);
		await waitForIdle(ctx);

		expect(interruptTask(ctx.app.ctx, ctx.projectId, nodeId)).toBe(false);
		expect(session(ctx, nodeId).queue.isClosed).toBe(false);
	}, 30000);
});
