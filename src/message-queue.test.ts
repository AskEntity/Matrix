import { describe, expect, test } from "bun:test";
import { MessageQueue, type QueueMessage } from "./message-queue.ts";

describe("MessageQueue", () => {
	test("enqueue + drain: messages accumulate and drain returns them all", () => {
		const q = new MessageQueue();
		q.enqueue({ source: "user", content: "hello" });
		q.enqueue({ source: "user", content: "world" });

		const msgs = q.drain();
		expect(msgs).toHaveLength(2);
		expect(msgs[0]).toEqual({ source: "user", content: "hello" });
		expect(msgs[1]).toEqual({ source: "user", content: "world" });
	});

	test("drain returns empty array after draining", () => {
		const q = new MessageQueue();
		q.enqueue({ source: "user", content: "hello" });
		q.drain();

		const msgs = q.drain();
		expect(msgs).toEqual([]);
	});

	test("drain on empty queue returns empty array", () => {
		const q = new MessageQueue();
		expect(q.drain()).toEqual([]);
	});

	test("wait() resolves immediately if messages pending", async () => {
		const q = new MessageQueue();
		q.enqueue({ source: "user", content: "already here" });

		const msg = await q.wait();
		expect(msg).toEqual({ source: "user", content: "already here" });
	});

	test("wait() blocks until enqueue() is called", async () => {
		const q = new MessageQueue();

		// Start waiting — should not resolve yet
		const promise = q.wait();
		let resolved = false;
		promise.then(() => {
			resolved = true;
		});

		// Give microtask queue a chance to flush
		await Promise.resolve();
		expect(resolved).toBe(false);

		// Now enqueue — should resolve the waiter
		q.enqueue({ source: "clarify_response", answer: "yes" });
		const msg = await promise;
		expect(msg).toEqual({ source: "clarify_response", answer: "yes" });
	});

	test("multiple enqueues before wait — wait returns first, drain gets rest", async () => {
		const q = new MessageQueue();
		q.enqueue({ source: "user", content: "first" });
		q.enqueue({ source: "user", content: "second" });
		q.enqueue({ source: "user", content: "third" });

		const first = await q.wait();
		expect(first).toEqual({ source: "user", content: "first" });

		const rest = q.drain();
		expect(rest).toHaveLength(2);
		expect(rest[0]).toEqual({ source: "user", content: "second" });
		expect(rest[1]).toEqual({ source: "user", content: "third" });
	});

	test("close() rejects pending wait()", async () => {
		const q = new MessageQueue();
		const promise = q.wait();

		q.close();

		await expect(promise).rejects.toThrow("Queue closed");
	});

	test("enqueue after close() throws", () => {
		const q = new MessageQueue();
		q.close();

		expect(() => q.enqueue({ source: "user", content: "nope" })).toThrow(
			"Queue closed",
		);
	});

	test("wait() after close() rejects immediately", async () => {
		const q = new MessageQueue();
		q.close();

		await expect(q.wait()).rejects.toThrow("Queue closed");
	});

	test("pending getter returns correct count", () => {
		const q = new MessageQueue();
		expect(q.pending).toBe(0);

		q.enqueue({ source: "user", content: "a" });
		expect(q.pending).toBe(1);

		q.enqueue({ source: "user", content: "b" });
		expect(q.pending).toBe(2);

		q.drain();
		expect(q.pending).toBe(0);
	});

	test("pending decreases when wait() consumes a message", async () => {
		const q = new MessageQueue();
		q.enqueue({ source: "user", content: "a" });
		q.enqueue({ source: "user", content: "b" });
		expect(q.pending).toBe(2);

		await q.wait();
		expect(q.pending).toBe(1);
	});

	test("enqueue to waiting consumer does not increase pending", async () => {
		const q = new MessageQueue();
		const promise = q.wait();

		// Enqueue while someone is waiting — message goes directly to waiter
		q.enqueue({ source: "user", content: "direct" });
		expect(q.pending).toBe(0);

		const msg = await promise;
		expect(msg).toEqual({ source: "user", content: "direct" });
	});

	test("different message types: user", () => {
		const q = new MessageQueue();
		const msg: QueueMessage = { source: "user", content: "hello" };
		q.enqueue(msg);
		expect(q.drain()).toEqual([msg]);
	});

	test("different message types: child_complete", () => {
		const q = new MessageQueue();
		const msg: QueueMessage = {
			source: "child_complete",
			taskId: "task-123",
			title: "Auth module",
			success: true,
			output: "All tests passing",
		};
		q.enqueue(msg);
		expect(q.drain()).toEqual([msg]);
	});

	test("different message types: parent_update", () => {
		const q = new MessageQueue();
		const msg: QueueMessage = {
			source: "parent_update",
			content: "Priority changed",
		};
		q.enqueue(msg);
		expect(q.drain()).toEqual([msg]);
	});

	test("different message types: clarify_response", () => {
		const q = new MessageQueue();
		const msg: QueueMessage = {
			source: "clarify_response",
			answer: "Use PostgreSQL",
		};
		q.enqueue(msg);
		expect(q.drain()).toEqual([msg]);
	});

	test("mixed message types flow through correctly", async () => {
		const q = new MessageQueue();
		q.enqueue({ source: "user", content: "start" });
		q.enqueue({
			source: "child_complete",
			taskId: "t1",
			title: "DB",
			success: true,
			output: "done",
		});
		q.enqueue({ source: "parent_update", content: "hurry up" });
		q.enqueue({ source: "clarify_response", answer: "42" });

		const first = await q.wait();
		expect(first.source).toBe("user");

		const rest = q.drain();
		expect(rest).toHaveLength(3);
		expect(rest[0]?.source).toBe("child_complete");
		expect(rest[1]?.source).toBe("parent_update");
		expect(rest[2]?.source).toBe("clarify_response");
	});

	test("waitForMessage() with no timeout behaves like wait()", async () => {
		const q = new MessageQueue();
		q.enqueue({ source: "user", content: "hello" });
		const result = await q.waitForMessage(undefined);
		expect(result).toEqual({ source: "user", content: "hello" });
	});

	test("waitForMessage() returns message before timeout fires", async () => {
		const q = new MessageQueue();
		const promise = q.waitForMessage(200);

		// Deliver message quickly
		setTimeout(() => q.enqueue({ source: "user", content: "fast" }), 10);

		const result = await promise;
		expect(result).toEqual({ source: "user", content: "fast" });
	});

	test("waitForMessage() returns 'timeout' sentinel when no message arrives", async () => {
		const q = new MessageQueue();
		const result = await q.waitForMessage(20);
		expect(result).toBe("timeout");
	});

	test("waitForMessage() resolves immediately if messages already pending", async () => {
		const q = new MessageQueue();
		q.enqueue({ source: "clarify_response", answer: "already here" });
		const result = await q.waitForMessage(20);
		expect(result).toEqual({
			source: "clarify_response",
			answer: "already here",
		});
	});

	test("waitForMessage() rejects when queue is closed while waiting", async () => {
		const q = new MessageQueue();
		const promise = q.waitForMessage(1000);
		q.close();
		await expect(promise).rejects.toThrow("Queue closed");
	});

	test("waitForMessage() rejects immediately on closed queue", async () => {
		const q = new MessageQueue();
		q.close();
		await expect(q.waitForMessage(100)).rejects.toThrow("Queue closed");
	});
});
