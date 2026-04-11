/**
 * MessageQueue onPersist unit contract.
 *
 * The `enqueue === persist` refactor: `queue.enqueue(msg)` synchronously
 * calls `onPersist(msg)` before delivering the message. `replay: true`
 * skips onPersist. `quiet: true` is orthogonal — controls waiter waking
 * only. These tests pin the contract so downstream subsystems can rely
 * on "queue.enqueue is the single persistence path" without surprises.
 */
import { describe, expect, test } from "bun:test";
import { MessageQueue, type QueueMessage } from "./message-queue.ts";
import { createUserMessage } from "./queue-message-factory.ts";

describe("MessageQueue: onPersist contract", () => {
	test("enqueue calls onPersist synchronously exactly once", () => {
		const calls: QueueMessage[] = [];
		const q = new MessageQueue({ onPersist: (m) => calls.push(m) });
		const msg = createUserMessage("hi");
		q.enqueue(msg);
		expect(calls.length).toBe(1);
		expect(calls[0]).toBe(msg);
	});

	test("enqueue delivers message AFTER onPersist returns", () => {
		const order: string[] = [];
		const q = new MessageQueue({
			onPersist: () => order.push("persist"),
		});
		q.enqueue(createUserMessage("a"));
		order.push("enqueue-done");
		expect(order).toEqual(["persist", "enqueue-done"]);
	});

	test("replay: true skips onPersist", () => {
		let called = 0;
		const q = new MessageQueue({ onPersist: () => called++ });
		q.enqueue(createUserMessage("hi"), { replay: true });
		expect(called).toBe(0);
	});

	test("replay: true still delivers to waiter", async () => {
		const q = new MessageQueue({ onPersist: () => {} });
		const p = q.wait();
		q.enqueue(createUserMessage("hi"), { replay: true });
		const received = await p;
		if (received.source !== "user") throw new Error("expected user msg");
		expect(received.content).toBe("hi");
	});

	test("quiet: true still calls onPersist", () => {
		let called = 0;
		const q = new MessageQueue({ onPersist: () => called++ });
		q.enqueue(createUserMessage("hi"), { quiet: true });
		expect(called).toBe(1);
	});

	test("quiet: true does NOT wake a waiter", async () => {
		const q = new MessageQueue({ onPersist: () => {} });
		let waiterFired = false;
		const p = q.wait().then(() => {
			waiterFired = true;
		});
		p.catch(() => {});
		q.enqueue(createUserMessage("hi"), { quiet: true });
		await new Promise((r) => setTimeout(r, 20));
		expect(waiterFired).toBe(false);
		expect(q.pending).toBe(1);
		q.close();
	});

	test("onPersist undefined (no opts) — enqueue still works", () => {
		const q = new MessageQueue();
		q.enqueue(createUserMessage("hi"));
		expect(q.pending).toBe(1);
	});

	test("onPersist throws — enqueue propagates, message NOT delivered", () => {
		const q = new MessageQueue({
			onPersist: () => {
				throw new Error("disk full");
			},
		});
		expect(() => q.enqueue(createUserMessage("hi"))).toThrow("disk full");
		expect(q.pending).toBe(0);
	});

	test("onPersist called with same reference as delivered message", async () => {
		const persisted: QueueMessage[] = [];
		const q = new MessageQueue({
			onPersist: (m) => {
				persisted.push(m);
			},
		});
		const originalMsg = createUserMessage("same ref");
		const p = q.wait();
		q.enqueue(originalMsg);
		const deliveredMsg = await p;
		expect(persisted.length).toBe(1);
		expect(persisted[0]).toBe(originalMsg);
		expect(deliveredMsg).toBe(originalMsg);
	});

	test("multiple enqueues each trigger onPersist", () => {
		const calls: string[] = [];
		const q = new MessageQueue({
			onPersist: (m) => {
				if (m.source === "user") calls.push(m.content);
			},
		});
		q.enqueue(createUserMessage("a"));
		q.enqueue(createUserMessage("b"));
		q.enqueue(createUserMessage("c"));
		expect(calls).toEqual(["a", "b", "c"]);
	});

	test("enqueue on closed queue throws and does NOT call onPersist", () => {
		let called = 0;
		const q = new MessageQueue({ onPersist: () => called++ });
		q.close();
		expect(() => q.enqueue(createUserMessage("hi"))).toThrow("Queue closed");
		expect(called).toBe(0);
	});

	test("enqueue with missing id throws BEFORE calling onPersist", () => {
		let called = 0;
		const q = new MessageQueue({ onPersist: () => called++ });
		expect(() =>
			q.enqueue({ source: "user", id: "", ts: 0, content: "x" }),
		).toThrow();
		expect(called).toBe(0);
	});

	test("drain returns enqueued messages in FIFO order", () => {
		const q = new MessageQueue({ onPersist: () => {} });
		q.enqueue(createUserMessage("1"), { quiet: true });
		q.enqueue(createUserMessage("2"), { quiet: true });
		q.enqueue(createUserMessage("3"), { quiet: true });
		const msgs = q.drain();
		expect(msgs.length).toBe(3);
		expect((msgs[0] as { content: string }).content).toBe("1");
		expect((msgs[1] as { content: string }).content).toBe("2");
		expect((msgs[2] as { content: string }).content).toBe("3");
	});

	test("replay and non-replay in same queue both enqueue", () => {
		const persisted: string[] = [];
		const q = new MessageQueue({
			onPersist: (m) => {
				if (m.source === "user") persisted.push(m.content);
			},
		});
		q.enqueue(createUserMessage("replayed"), { quiet: true, replay: true });
		q.enqueue(createUserMessage("fresh"), { quiet: true });
		expect(persisted).toEqual(["fresh"]);
		expect(q.pending).toBe(2);
	});

	test("onEnqueue callback still fires (unchanged)", () => {
		const persisted: QueueMessage[] = [];
		const enqueued: QueueMessage[] = [];
		const q = new MessageQueue({
			onPersist: (m) => persisted.push(m),
		});
		q.onEnqueue = (m) => enqueued.push(m);
		q.enqueue(createUserMessage("hi"));
		expect(persisted.length).toBe(1);
		expect(enqueued.length).toBe(1);
	});

	test("setOnPersist wires a callback post-construction", () => {
		const persisted: QueueMessage[] = [];
		const q = new MessageQueue();
		expect(q.hasOnPersist()).toBe(false);
		q.setOnPersist((m) => persisted.push(m));
		expect(q.hasOnPersist()).toBe(true);
		q.enqueue(createUserMessage("late wire"));
		expect(persisted.length).toBe(1);
	});

	test("setOnPersist refuses to overwrite an existing callback", () => {
		const q = new MessageQueue({ onPersist: () => {} });
		expect(() => q.setOnPersist(() => {})).toThrow("already set");
	});
});
