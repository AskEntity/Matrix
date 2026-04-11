/**
 * Bug 2: assistant_text is emitted to JSONL BEFORE the matching usage event.
 *
 * The frontend's `attach_usage` walk-backwards logic finds "most recent
 * assistant_text for this task" and attaches usage to it. If usage is
 * emitted before assistant_text, the walk finds the PREVIOUS turn's text
 * and attaches the current turn's tokens to the wrong message — the
 * cache badge shows tokens from the wrong turn.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createUserMessage } from "./queue-message-factory.ts";
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

describe("Bug 2: usage emission order", () => {
	let ctx: EmissionTestContext;
	afterEach(async () => {
		if (ctx) await teardownEmissionTestContext(ctx);
	});

	test("single turn: assistant_text index < usage index", async () => {
		ctx = await setupEmissionTestContext();
		await startAgent(ctx, singleTurnDoneInstruction("order ok"));
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const events = await readSessionEvents(ctx, tracker.rootNodeId);

		const firstText = events.findIndex((e) => e.type === "assistant_text");
		const firstUsage = events.findIndex((e) => e.type === "usage");
		expect(firstText).toBeGreaterThanOrEqual(0);
		expect(firstUsage).toBeGreaterThanOrEqual(0);
		expect(firstText).toBeLessThan(firstUsage);
	}, 30000);

	test("multi-turn: every usage preceded by assistant_text in its own segment", async () => {
		ctx = await setupEmissionTestContext();
		await startAgent(ctx, twoTurnInstruction("multi order ok"));
		await waitForIdle(ctx);
		await injectMessage(ctx, createUserMessage("wake"));
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const events = await readSessionEvents(ctx, tracker.rootNodeId);

		const markers: Array<{ type: "assistant_text" | "usage"; idx: number }> =
			[];
		events.forEach((e, idx) => {
			if (e.type === "assistant_text" || e.type === "usage") {
				markers.push({ type: e.type, idx });
			}
		});

		// Sequence must be `text+ usage` segments — never an empty segment.
		let lastUsage = -1;
		let textsInCurrentSegment = 0;
		for (const m of markers) {
			if (m.type === "assistant_text") {
				textsInCurrentSegment++;
			} else {
				if (textsInCurrentSegment === 0) {
					throw new Error(
						`usage at index ${m.idx} has no preceding assistant_text since last usage (index ${lastUsage})`,
					);
				}
				lastUsage = m.idx;
				textsInCurrentSegment = 0;
			}
		}
	}, 30000);

	test("tool-only turn (no text): usage still after tool_call", async () => {
		ctx = await setupEmissionTestContext();
		const instruction = JSON.stringify({
			blocks: [
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "tool-only ok" },
				},
			],
		});
		await startAgent(ctx, instruction);
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const events = await readSessionEvents(ctx, tracker.rootNodeId);

		const firstToolCall = events.findIndex((e) => e.type === "tool_call");
		const firstUsage = events.findIndex((e) => e.type === "usage");
		expect(firstToolCall).toBeGreaterThanOrEqual(0);
		expect(firstUsage).toBeGreaterThanOrEqual(0);
		expect(firstToolCall).toBeLessThan(firstUsage);
	}, 30000);
});
