/**
 * The interrupt notice: the mark the provider loop leaves on the log when a
 * user interrupt parked it.
 *
 * Two properties are pinned here, and both fail SILENTLY when broken:
 *
 *  1. **The enqueue happens AFTER the park is registered.** Both orderings
 *     compile, neither throws, and the wrong one makes the agent wake itself
 *     with its own interruption notice.
 *  2. **The notice lands unconsumed.** `messages_consumed` is written on
 *     drain, and rule 2 of `shouldLaunchAgent` collapses if a future change to
 *     drain timing starts consuming it — with nothing anywhere going red.
 */
import { describe, expect, test } from "bun:test";
import {
	INTERRUPT_NOTICE,
	MessageQueue,
	type QueueMessage,
} from "./message-queue.ts";
import {
	createInterruptNotice,
	createUserMessage,
} from "./queue-message-factory.ts";

describe("MessageQueue: the ordering the interrupt notice depends on", () => {
	// The property `handleImplicitYield` relies on: a quiet enqueue that lands
	// AFTER wait() has registered its waiter does not resolve that waiter.
	test("park first, then quiet enqueue → the waiter stays parked", async () => {
		const q = new MessageQueue({ onPersist: () => {} });
		let woke = false;
		const parked = q.wait().then((m) => {
			woke = true;
			return m;
		});
		parked.catch(() => {});

		q.enqueue(createInterruptNotice(), { quiet: true });
		await new Promise((r) => setTimeout(r, 20));

		expect(woke).toBe(false);
		expect(q.pending).toBe(1);
	});

	// The inverted order, asserted as a REAL behaviour rather than described in
	// a comment. This is what the loop would do if someone hoisted the enqueue
	// above `queue.wait()`: the notice is already sitting in the queue, wait()
	// takes its non-empty branch, and the agent is handed its own interruption
	// notice as if it were input.
	test("enqueue first, then park → wait() hands back the notice immediately", async () => {
		const q = new MessageQueue({ onPersist: () => {} });
		q.enqueue(createInterruptNotice(), { quiet: true });

		const got = await q.wait();

		expect(got.source).toBe("interrupt");
	});

	// wait() must register its waiter synchronously — the whole ordering
	// argument rests on this. If registration were deferred by even a
	// microtask, "park first" would not actually be parked yet.
	test("wait() registers its waiter synchronously", async () => {
		const q = new MessageQueue({ onPersist: () => {} });
		const parked = q.wait();
		parked.catch(() => {});
		// No await between wait() and enqueue — if the waiter were registered
		// asynchronously this quiet enqueue would land first and be shifted out.
		q.enqueue(createInterruptNotice(), { quiet: true });
		q.enqueue(createUserMessage("real input"));
		const first = await parked;
		// The waiter got the non-quiet message; the notice stayed in the array.
		expect(first.source).toBe("user");
		expect(q.drain().map((m) => m.source)).toEqual(["interrupt"]);
	});
});

describe("interrupt notice content", () => {
	test("carries no per-instance fields beyond the queue envelope", () => {
		const m = createInterruptNotice();
		expect(Object.keys(m).sort()).toEqual(["id", "source", "ts"]);
	});

	test("deliberately carries no character count", () => {
		// A number invites the model to discuss how much it lost. Pinned so a
		// well-meaning "…(142 characters lost)" has to argue with a test.
		expect(INTERRUPT_NOTICE).not.toMatch(/\d/);
	});

	test("each notice gets a distinct id", () => {
		const a = createInterruptNotice();
		const b = createInterruptNotice();
		expect(a.id).not.toBe(b.id);
	});
});

describe("what the model reads", () => {
	test("formatEventForAI renders the notice text", async () => {
		const { formatEventForAI, queueMessageToEvent } = await import(
			"./events.ts"
		);
		const evt = queueMessageToEvent(
			createInterruptNotice() as QueueMessage,
			"t1",
		);
		expect(formatEventForAI(evt)).toContain(INTERRUPT_NOTICE);
	});
});
