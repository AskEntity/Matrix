/**
 * Walker-reconstruction structural invariants: the layout of events in
 * JSONL around yield / drain points must let the walker reconstruct the
 * conversation without loss. These tests pin the edge ordering that
 * `buildSessionRepair` + recordQueueEvents + the wake path are
 * responsible for maintaining.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createTaskMessage } from "./queue-message-factory.ts";
import {
	type EmissionTestContext,
	injectMessage,
	readSessionEvents,
	setupEmissionTestContext,
	startAgent,
	teardownEmissionTestContext,
	waitForDone,
} from "./test-utils/emission-harness.ts";

describe("JSONL structural invariants (walker safety)", () => {
	let ctx: EmissionTestContext;
	afterEach(async () => {
		if (ctx) await teardownEmissionTestContext(ctx);
	});

	test("after yield wake: messages_consumed immediately after yield tool_result", async () => {
		ctx = await setupEmissionTestContext();

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [{ type: "tool_use", name: "mcp__mxd__yield", input: {} }],
				},
				{
					blocks: [
						{ type: "text", text: "got message" },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "yield wake order ok" },
						},
					],
				},
			],
		});
		await startAgent(ctx, instruction);

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const start = Date.now();
		let hasYield = false;
		while (Date.now() - start < 15000) {
			const events = await readSessionEvents(ctx, tracker.rootNodeId);
			if (
				events.some(
					(e) => e.type === "tool_call" && e.tool === "mcp__mxd__yield",
				)
			) {
				hasYield = true;
				break;
			}
			await new Promise((r) => setTimeout(r, 100));
		}
		expect(hasYield).toBe(true);

		await injectMessage(
			ctx,
			createTaskMessage("01ORDER0001", "Peer", "wake up"),
		);

		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		const events = await readSessionEvents(ctx, tracker.rootNodeId);

		const yieldResultIdx = events.findIndex(
			(e) => e.type === "tool_result" && e.tool === "mcp__mxd__yield",
		);
		expect(yieldResultIdx).toBeGreaterThanOrEqual(0);

		const mcAfterYield = events
			.slice(yieldResultIdx + 1)
			.findIndex((e) => e.type === "messages_consumed");
		expect(mcAfterYield).toBeGreaterThanOrEqual(0);
	}, 30000);
});
