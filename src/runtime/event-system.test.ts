/**
 * Unit tests for the event-system broadcast / subscriber machinery.
 *
 * These test the in-process event subscription primitive in isolation — no
 * real daemon, no agents. Just verify the contract:
 *   - subscribeToEvents returns an unsubscribe fn
 *   - broadcast fans out to SSE clients AND project-bucketed subscribers
 *   - subscribers are scoped per-project (no cross-project leakage)
 *   - unsubscribe is idempotent and cleans up empty buckets
 *   - throwing callbacks don't kill the broadcast
 */

import { describe, expect, test } from "bun:test";
import type { RuntimeContext } from "./context.ts";
import { broadcast, subscribeToEvents } from "./event-system.ts";

function makeCtx(): RuntimeContext {
	return {
		eventSubscribers: new Map(),
		// deliberately cast — tests only touch eventSubscribers
	} as unknown as RuntimeContext;
}

describe("event-system: subscribeToEvents + broadcast", () => {
	test("subscriber receives broadcast events for its project", () => {
		const ctx = makeCtx();
		const received: Array<Record<string, unknown>> = [];
		subscribeToEvents(ctx, "proj-A", (evt) => received.push(evt));

		broadcast(ctx, "proj-A", { type: "hello", taskId: "t1" });
		broadcast(ctx, "proj-A", { type: "world", taskId: "t2" });

		expect(received.length).toBe(2);
		expect(received[0]?.type).toBe("hello");
		expect(received[1]?.type).toBe("world");
	});

	test("subscriber does NOT receive events for other projects", () => {
		const ctx = makeCtx();
		const receivedA: Array<Record<string, unknown>> = [];
		const receivedB: Array<Record<string, unknown>> = [];
		subscribeToEvents(ctx, "proj-A", (evt) => receivedA.push(evt));
		subscribeToEvents(ctx, "proj-B", (evt) => receivedB.push(evt));

		broadcast(ctx, "proj-A", { type: "for-A" });
		broadcast(ctx, "proj-B", { type: "for-B" });

		expect(receivedA.length).toBe(1);
		expect(receivedA[0]?.type).toBe("for-A");
		expect(receivedB.length).toBe(1);
		expect(receivedB[0]?.type).toBe("for-B");
	});

	test("unsubscribe removes the callback", () => {
		const ctx = makeCtx();
		const received: Array<Record<string, unknown>> = [];
		const unsub = subscribeToEvents(ctx, "proj-A", (evt) => received.push(evt));

		broadcast(ctx, "proj-A", { type: "first" });
		unsub();
		broadcast(ctx, "proj-A", { type: "second" });

		expect(received.length).toBe(1);
		expect(received[0]?.type).toBe("first");
	});

	test("unsubscribe is idempotent (double-call no-op)", () => {
		const ctx = makeCtx();
		const unsub = subscribeToEvents(ctx, "proj-A", () => {});
		unsub();
		expect(() => unsub()).not.toThrow();
	});

	test("unsubscribe cleans up empty project bucket", () => {
		const ctx = makeCtx();
		const unsub = subscribeToEvents(ctx, "proj-A", () => {});
		expect(ctx.eventSubscribers.has("proj-A")).toBe(true);
		unsub();
		// Bucket should be cleaned up to prevent unbounded map growth
		expect(ctx.eventSubscribers.has("proj-A")).toBe(false);
	});

	test("bucket persists while other subscribers remain", () => {
		const ctx = makeCtx();
		const unsubA = subscribeToEvents(ctx, "proj-A", () => {});
		const unsubB = subscribeToEvents(ctx, "proj-A", () => {});
		expect(ctx.eventSubscribers.get("proj-A")?.size).toBe(2);
		unsubA();
		expect(ctx.eventSubscribers.get("proj-A")?.size).toBe(1);
		unsubB();
		expect(ctx.eventSubscribers.has("proj-A")).toBe(false);
	});

	test("multiple subscribers for same project all fire", () => {
		const ctx = makeCtx();
		const received1: number[] = [];
		const received2: number[] = [];
		subscribeToEvents(ctx, "proj-A", () => received1.push(1));
		subscribeToEvents(ctx, "proj-A", () => received2.push(2));

		broadcast(ctx, "proj-A", { type: "x" });

		expect(received1).toEqual([1]);
		expect(received2).toEqual([2]);
	});

	test("throwing subscriber does not interrupt broadcast", () => {
		const ctx = makeCtx();
		const received: string[] = [];
		subscribeToEvents(ctx, "proj-A", () => {
			throw new Error("boom");
		});
		subscribeToEvents(ctx, "proj-A", () => received.push("second ran"));

		// Should not throw — broadcast catches subscriber exceptions
		expect(() => broadcast(ctx, "proj-A", { type: "x" })).not.toThrow();
		// Second subscriber still fires despite first throwing
		expect(received).toEqual(["second ran"]);
	});

	test("callback receives RAW event object (not stripped)", () => {
		const ctx = makeCtx();
		let got: Record<string, unknown> | undefined;
		subscribeToEvents(ctx, "proj-A", (evt) => {
			got = evt;
		});

		const evt = {
			type: "tool_result",
			taskId: "t1",
			content: "hello",
			// stripEventForUI truncates large content — subscribers see the raw value
		};
		broadcast(ctx, "proj-A", evt);

		expect(got).toBeDefined();
		expect(got?.taskId).toBe("t1");
		expect(got?.content).toBe("hello");
		expect(got?.type).toBe("tool_result");
	});

	test("broadcast with no subscribers is a no-op (empty map)", () => {
		const ctx = makeCtx();
		expect(() => broadcast(ctx, "proj-A", { type: "x" })).not.toThrow();
	});

	test("unsubscribe from one subscriber doesn't affect others", () => {
		const ctx = makeCtx();
		const got1: string[] = [];
		const got2: string[] = [];
		const unsub1 = subscribeToEvents(ctx, "proj-A", () => got1.push("1"));
		subscribeToEvents(ctx, "proj-A", () => got2.push("2"));

		broadcast(ctx, "proj-A", { type: "first" });
		unsub1();
		broadcast(ctx, "proj-A", { type: "second" });

		expect(got1).toEqual(["1"]);
		expect(got2).toEqual(["2", "2"]);
	});
});
