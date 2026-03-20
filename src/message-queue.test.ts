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

	test("parent_update with requestReply flag", () => {
		const q = new MessageQueue();
		const msg: QueueMessage = {
			source: "parent_update",
			content: "What is the status?",
			requestReply: true,
		};
		q.enqueue(msg);
		const drained = q.drain();
		expect(drained).toEqual([msg]);
		expect(
			drained[0]?.source === "parent_update" && drained[0].requestReply,
		).toBe(true);
	});

	test("child_report with requestReply flag", () => {
		const q = new MessageQueue();
		const msg: QueueMessage = {
			source: "child_report",
			taskId: "task-1",
			title: "Auth",
			content: "Need help",
			requestReply: true,
		};
		q.enqueue(msg);
		const drained = q.drain();
		expect(drained).toEqual([msg]);
		expect(
			drained[0]?.source === "child_report" && drained[0].requestReply,
		).toBe(true);
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

	test("enqueueQuiet does not resolve a pending wait()", async () => {
		const q = new MessageQueue();

		const promise = q.wait();
		let resolved = false;
		promise.then(() => {
			resolved = true;
		});

		// Quiet enqueue should NOT wake the waiter
		q.enqueueQuiet({ source: "system", content: "tree changed" });
		await Promise.resolve();
		await Promise.resolve();
		expect(resolved).toBe(false);

		// But the message IS in the queue
		expect(q.pending).toBe(1);

		// A normal enqueue DOES wake the waiter
		q.enqueue({ source: "user", content: "hello" });
		const msg = await promise;
		expect(msg).toEqual({ source: "user", content: "hello" });
	});

	test("enqueueQuiet message is included in drain()", () => {
		const q = new MessageQueue();
		q.enqueueQuiet({ source: "system", content: "quiet msg" });
		q.enqueue({ source: "user", content: "normal msg" });

		const msgs = q.drain();
		expect(msgs).toHaveLength(2);
		expect(msgs[0]).toEqual({ source: "system", content: "quiet msg" });
		expect(msgs[1]).toEqual({ source: "user", content: "normal msg" });
	});

	test("enqueueQuiet message is picked up by wait() when already pending", async () => {
		const q = new MessageQueue();
		q.enqueueQuiet({ source: "system", content: "quiet" });

		// wait() checks pending messages first — should resolve immediately
		const msg = await q.wait();
		expect(msg).toEqual({ source: "system", content: "quiet" });
	});

	test("enqueueQuiet throws on closed queue", () => {
		const q = new MessageQueue();
		q.close();
		expect(() => q.enqueueQuiet({ source: "system", content: "nope" })).toThrow(
			"Queue closed",
		);
	});

	test("enqueueQuiet increments pending count", () => {
		const q = new MessageQueue();
		expect(q.pending).toBe(0);
		q.enqueueQuiet({ source: "system", content: "a" });
		expect(q.pending).toBe(1);
		q.enqueueQuiet({ source: "system", content: "b" });
		expect(q.pending).toBe(2);
	});

	test("drainMerged returns empty array on empty queue", () => {
		const q = new MessageQueue();
		expect(q.drainMerged()).toEqual([]);
	});

	test("drainMerged passes through single message unchanged", () => {
		const q = new MessageQueue();
		q.enqueue({ source: "system", content: "tree updated" });
		const msgs = q.drainMerged();
		expect(msgs).toHaveLength(1);
		expect(msgs[0]).toEqual({ source: "system", content: "tree updated" });
	});

	test("drainMerged merges consecutive system messages", () => {
		const q = new MessageQueue();
		q.enqueueQuiet({ source: "system", content: "tree updated: task A" });
		q.enqueueQuiet({ source: "system", content: "tree updated: task B" });
		q.enqueueQuiet({ source: "system", content: "tree updated: task C" });

		const msgs = q.drainMerged();
		expect(msgs).toHaveLength(1);
		expect(msgs[0]?.source).toBe("system");
		expect(
			(msgs[0] as { source: "system"; content: string }).content,
		).toContain("3 times");
	});

	test("drainMerged preserves non-system messages in order", () => {
		const q = new MessageQueue();
		q.enqueue({ source: "user", content: "hello" });
		q.enqueue({ source: "user", content: "world" });

		const msgs = q.drainMerged();
		expect(msgs).toHaveLength(2);
		expect(msgs[0]).toEqual({ source: "user", content: "hello" });
		expect(msgs[1]).toEqual({ source: "user", content: "world" });
	});

	test("drainMerged merges system messages between non-system messages", () => {
		const q = new MessageQueue();
		q.enqueueQuiet({ source: "system", content: "update 1" });
		q.enqueueQuiet({ source: "system", content: "update 2" });
		q.enqueue({ source: "user", content: "hello" });
		q.enqueueQuiet({ source: "system", content: "update 3" });

		const msgs = q.drainMerged();
		expect(msgs).toHaveLength(3);
		// First: merged system messages
		expect(msgs[0]?.source).toBe("system");
		expect(
			(msgs[0] as { source: "system"; content: string }).content,
		).toContain("2 times");
		// Second: user message
		expect(msgs[1]).toEqual({ source: "user", content: "hello" });
		// Third: single system message passes through
		expect(msgs[2]).toEqual({ source: "system", content: "update 3" });
	});

	test("drainMerged clears the queue", () => {
		const q = new MessageQueue();
		q.enqueue({ source: "system", content: "a" });
		q.enqueue({ source: "system", content: "b" });
		q.drainMerged();
		expect(q.pending).toBe(0);
		expect(q.drainMerged()).toEqual([]);
	});

	test("onEnqueue fires when message goes to array (no waiter)", () => {
		const q = new MessageQueue();
		const received: QueueMessage[] = [];
		q.onEnqueue = (msg) => received.push(msg);

		q.enqueue({ source: "user", content: "hello" });
		q.enqueue({ source: "user", content: "world" });

		expect(received).toHaveLength(2);
		expect(received[0]).toEqual({ source: "user", content: "hello" });
		expect(received[1]).toEqual({ source: "user", content: "world" });
	});

	test("onEnqueue fires when message goes directly to waiter", async () => {
		const q = new MessageQueue();
		const received: QueueMessage[] = [];
		q.onEnqueue = (msg) => received.push(msg);

		// Start waiting — creates a waiter
		const promise = q.wait();

		// Enqueue while waiter exists — message bypasses array
		q.enqueue({ source: "user", content: "direct to waiter" });

		// onEnqueue should still have fired
		expect(received).toHaveLength(1);
		expect(received[0]).toEqual({
			source: "user",
			content: "direct to waiter",
		});

		// Waiter should resolve with the message
		const msg = await promise;
		expect(msg).toEqual({ source: "user", content: "direct to waiter" });
	});

	test("onEnqueue does not fire for enqueueQuiet", () => {
		const q = new MessageQueue();
		const received: QueueMessage[] = [];
		q.onEnqueue = (msg) => received.push(msg);

		q.enqueueQuiet({ source: "system", content: "quiet" });
		expect(received).toHaveLength(0);

		// But normal enqueue does fire it
		q.enqueue({ source: "user", content: "loud" });
		expect(received).toHaveLength(1);
	});
});
