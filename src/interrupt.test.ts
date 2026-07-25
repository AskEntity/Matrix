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

	// ── 6. Reconstruction obeys the REAL pairing rule ──
	//
	// Measured against the live API (audit 01KYCQ856M): flatten everything after
	// an assistant turn that used tools into one block stream, take the LEADING
	// run of tool_result blocks, and every tool_use must be answered inside it.
	// Splitting the results across several user messages is fine; a non-
	// tool_result block appearing before the last of them is NOT — it ends the
	// run and orphans whatever came after.
	//
	// This matters here because the interrupt path is what decides whether queue
	// content gets merged into the turn, and because the interrupt announces
	// itself with a `status` event WHILE the tools are still running — i.e.
	// between the tool_calls and their results.
	//
	// That status turns out to be doubly harmless, and the second reason is the
	// load-bearing one: `isPersistedByEmitEvent` returns false for `status`, so
	// it is broadcast to clients and never written to the log at all. It cannot
	// sit between tool_results in a reconstruction that never sees it. (The
	// walker also has no case for it — but that would only matter if it were on
	// disk.) The test pins both halves: the interrupt really did announce
	// itself, AND the announcement contributes nothing to the rebuilt stream.
	test("the interrupted turn's tool_results form an unbroken leading run", async () => {
		ctx = await setupEmissionTestContext();
		ctx.mockAPI.disableStrictToolErrors();
		const nodeId = await rootId(ctx);

		const broadcast: string[] = [];
		const unsubscribe = subscribeToEvents(ctx.app.ctx, ctx.projectId, (e) => {
			if (e.type === "status") broadcast.push(String(e.message));
		});

		try {
			await startAgent(ctx, bashTurn("sleep 30", "sleep 30"));
			await waitForActivity(ctx, nodeId, "tool");
			await waitFor(
				() => session(ctx, nodeId).foregroundExecutions.size >= 2,
				"both commands to register",
			);
			interruptTask(ctx.app.ctx, ctx.projectId, nodeId);
			await waitForIdle(ctx);
		} finally {
			unsubscribe();
		}

		const events = readActiveEvents(ctx, nodeId);

		// The interrupt announced itself to clients…
		expect(broadcast).toContain("Interrupted by user");
		// …and left nothing on disk to sit between the tool_results.
		expect(events.some((e) => e.type === "status")).toBe(false);

		const messages = eventsToAnthropicMessages(events) as Array<{
			role: string;
			content: unknown;
		}>;

		// Every tool_use of the last tool-using assistant turn…
		let callIds: string[] = [];
		let assistantIdx = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
			const uses = (m.content as Array<{ type: string; id?: string }>).filter(
				(b) => b.type === "tool_use",
			);
			if (uses.length > 0) {
				callIds = uses.map((u) => u.id ?? "");
				assistantIdx = i;
				break;
			}
		}
		expect(callIds.length).toBe(2);

		// …must be answered inside the LEADING run of tool_result blocks of the
		// flattened remainder. Crossing message boundaries is allowed; a
		// non-tool_result block before the last answer is not.
		const flattened: Array<{ type: string; tool_use_id?: string }> = [];
		for (let i = assistantIdx + 1; i < messages.length; i++) {
			const c = messages[i]?.content;
			if (typeof c === "string") flattened.push({ type: "text" });
			else if (Array.isArray(c))
				flattened.push(...(c as Array<{ type: string; tool_use_id?: string }>));
		}
		const answered = new Set<string>();
		for (const b of flattened) {
			if (b.type !== "tool_result") break; // the run ends here
			if (b.tool_use_id) answered.add(b.tool_use_id);
		}
		for (const id of callIds) expect(answered.has(id)).toBe(true);
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

	// ── 9. Interrupting a `thinking` turn ──
	//
	// The other half of the state table, and the one the design argument was
	// about. `delay_ms` gives the mock a window where it is mid-stream, and the
	// mock honors the request's abort signal inside that window exactly as the
	// SDK does — so this drives the real path: the composed turn signal aborts
	// the call, the catch recognises an interrupt (rather than treating an abort
	// error as non-transient and taking the agent down with it), and the loop
	// parks instead of dying.
	test("interrupting a thinking turn parks the agent instead of killing it", async () => {
		ctx = await setupEmissionTestContext();
		const nodeId = await rootId(ctx);

		await startAgent(
			ctx,
			JSON.stringify({
				turns: [
					{
						delay_ms: 8000,
						blocks: [{ type: "text", text: "This never arrives." }],
					},
					{
						blocks: [
							{ type: "text", text: "Picked up after the interrupt." },
							{
								type: "tool_use",
								name: "mcp__mxd__done",
								input: { status: "passed", result: "resumed" },
							},
						],
					},
				],
			}),
		);

		// ⚠️ NOT waitForActivity("thinking"): `thinking` is the residual state and
		// a session is BORN in it — setup (MCP connect, repair, work context) is
		// thinking too. Waiting for it returns before the first API call exists,
		// so the interrupt would land during setup and the loop would park having
		// never called the API — a different path that quietly passes the park
		// assertions while testing nothing about aborting a request.
		// The request being recorded is the precise "a call is in flight" signal.
		await waitFor(
			() => ctx.mockAPI.getRequestHistory().length >= 1,
			"the API call to be in flight",
		);
		const liveSession = session(ctx, nodeId);
		expect(interruptTask(ctx.app.ctx, ctx.projectId, nodeId)).toBe(true);

		// Parked, not dead: the loop reaches the queue rather than unwinding.
		await waitForIdle(ctx);
		expect(session(ctx, nodeId)).toBe(liveSession);
		expect(liveSession.queue.isClosed).toBe(false);

		// The abandoned turn left nothing to repair and no error event.
		const events = await readSessionEvents(ctx, nodeId);
		expect(events.some((e) => e.type === "error")).toBe(false);
		expect(
			buildSessionRepair(readActiveEvents(ctx, nodeId), nodeId),
		).toBeNull();
		// The turn genuinely never landed. Assert on the EVENT TYPE, not on the
		// serialized log: the mock instruction is itself the user's message, so
		// it carries this turn's script verbatim and a substring search over the
		// whole log matches it for entirely the wrong reason.
		expect(
			events.some(
				(e) =>
					e.type === "assistant_text" &&
					e.content.includes("This never arrives"),
			),
		).toBe(false);

		// …and carries on when the user says something. This is a DIFFERENT
		// codepath from the `tool`-state sibling above: nothing streamed, so the
		// park leaves messages[] ending in the turn's own user message and the
		// wake starts a NEW user turn rather than merging into a working context.
		// Two consecutive user messages, which the API accepts.
		await injectMessage(ctx, createUserMessage("go on then"));
		const deadline = Date.now() + 10000;
		for (;;) {
			const tracker = await ctx.app.getTracker(ctx.projectId);
			if (tracker.getTask(nodeId)?.status === "verify") break;
			if (Date.now() > deadline) {
				// A bare "timed out" here says nothing about WHY the agent did not
				// pick the message up. Dump the tail of the log with it.
				const tail = (await readSessionEvents(ctx, nodeId))
					.slice(-8)
					.map((e) => JSON.stringify(e).slice(0, 220));
				throw new Error(
					`agent did not finish after a thinking-state interrupt. Last events:\n${tail.join("\n")}`,
				);
			}
			await new Promise((r) => setTimeout(r, 25));
		}
	}, 30000);

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
