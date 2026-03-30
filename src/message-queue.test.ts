import { describe, expect, test } from "bun:test";
import { MessageQueue, type QueueMessage } from "./message-queue.ts";

describe("MessageQueue", () => {
	test("enqueue + drain: messages accumulate and drain returns them all", () => {
		const q = new MessageQueue();
		q.enqueue({ source: "user", id: "test-id", ts: 0, content: "hello" });
		q.enqueue({ source: "user", id: "test-id", ts: 0, content: "world" });

		const msgs = q.drain();
		expect(msgs).toHaveLength(2);
		expect(msgs[0]).toEqual({
			source: "user",
			id: "test-id",
			ts: 0,
			content: "hello",
		});
		expect(msgs[1]).toEqual({
			source: "user",
			id: "test-id",
			ts: 0,
			content: "world",
		});
	});

	test("drain returns empty array after draining", () => {
		const q = new MessageQueue();
		q.enqueue({ source: "user", id: "test-id", ts: 0, content: "hello" });
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
		q.enqueue({ source: "user", id: "test-id", ts: 0, content: "already here" });

		const msg = await q.wait();
		expect(msg).toEqual({
			source: "user",
			id: "test-id",
			ts: 0,
			content: "already here",
		});
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
		q.enqueue({ source: "clarify_response", id: "test-id", ts: 0, answer: "yes" });
		const msg = await promise;
		expect(msg).toEqual({
			source: "clarify_response",
			id: "test-id",
			ts: 0,
			answer: "yes",
		});
	});

	test("multiple enqueues before wait — wait returns first, drain gets rest", async () => {
		const q = new MessageQueue();
		q.enqueue({ source: "user", id: "test-id", ts: 0, content: "first" });
		q.enqueue({ source: "user", id: "test-id", ts: 0, content: "second" });
		q.enqueue({ source: "user", id: "test-id", ts: 0, content: "third" });

		const first = await q.wait();
		expect(first).toEqual({ source: "user", id: "test-id", ts: 0, content: "first" });

		const rest = q.drain();
		expect(rest).toHaveLength(2);
		expect(rest[0]).toEqual({
			source: "user",
			id: "test-id",
			ts: 0,
			content: "second",
		});
		expect(rest[1]).toEqual({
			source: "user",
			id: "test-id",
			ts: 0,
			content: "third",
		});
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

		expect(() =>
			q.enqueue({ source: "user", id: "test-id", ts: 0, content: "nope" }),
		).toThrow("Queue closed");
	});

	test("wait() after close() rejects immediately", async () => {
		const q = new MessageQueue();
		q.close();

		await expect(q.wait()).rejects.toThrow("Queue closed");
	});

	test("pending getter returns correct count", () => {
		const q = new MessageQueue();
		expect(q.pending).toBe(0);

		q.enqueue({ source: "user", id: "test-id", ts: 0, content: "a" });
		expect(q.pending).toBe(1);

		q.enqueue({ source: "user", id: "test-id", ts: 0, content: "b" });
		expect(q.pending).toBe(2);

		q.drain();
		expect(q.pending).toBe(0);
	});

	test("pending decreases when wait() consumes a message", async () => {
		const q = new MessageQueue();
		q.enqueue({ source: "user", id: "test-id", ts: 0, content: "a" });
		q.enqueue({ source: "user", id: "test-id", ts: 0, content: "b" });
		expect(q.pending).toBe(2);

		await q.wait();
		expect(q.pending).toBe(1);
	});

	test("enqueue to waiting consumer does not increase pending", async () => {
		const q = new MessageQueue();
		const promise = q.wait();

		// Enqueue while someone is waiting — message goes directly to waiter
		q.enqueue({ source: "user", id: "test-id", ts: 0, content: "direct" });
		expect(q.pending).toBe(0);

		const msg = await promise;
		expect(msg).toEqual({ source: "user", id: "test-id", ts: 0, content: "direct" });
	});

	test("different message types: user", () => {
		const q = new MessageQueue();
		const msg: QueueMessage = {
			source: "user",
			id: "test-id",
			ts: 0,
			content: "hello",
		};
		q.enqueue(msg);
		expect(q.drain()).toEqual([msg]);
	});

	test("different message types: task_complete", () => {
		const q = new MessageQueue();
		const msg: QueueMessage = {
			source: "task_complete",
			id: "test-id",
			ts: 0,
			taskId: "task-123",
			title: "Auth module",
			success: true,
			output: "All tests passing",
		};
		q.enqueue(msg);
		expect(q.drain()).toEqual([msg]);
	});

	test("different message types: task_message", () => {
		const q = new MessageQueue();
		const msg: QueueMessage = {
			source: "task_message",
			id: "test-id",
			ts: 0,
			fromTaskId: "p1",
			fromTitle: "Orchestrator",
			content: "Priority changed",
		};
		q.enqueue(msg);
		expect(q.drain()).toEqual([msg]);
	});

	test("task_message with requestReply flag", () => {
		const q = new MessageQueue();
		const msg: QueueMessage = {
			source: "task_message",
			id: "test-id",
			ts: 0,
			fromTaskId: "p1",
			fromTitle: "Orchestrator",
			content: "What is the status?",
			requestReply: true,
		};
		q.enqueue(msg);
		const drained = q.drain();
		expect(drained).toEqual([msg]);
		expect(
			drained[0]?.source === "task_message" && drained[0].requestReply,
		).toBe(true);
	});

	test("task_message from sub task with requestReply flag", () => {
		const q = new MessageQueue();
		const msg: QueueMessage = {
			source: "task_message",
			id: "test-id",
			ts: 0,
			fromTaskId: "task-1",
			fromTitle: "Auth",
			content: "Need help",
			requestReply: true,
		};
		q.enqueue(msg);
		const drained = q.drain();
		expect(drained).toEqual([msg]);
		expect(
			drained[0]?.source === "task_message" && drained[0].requestReply,
		).toBe(true);
	});

	test("different message types: clarify_response", () => {
		const q = new MessageQueue();
		const msg: QueueMessage = {
			source: "clarify_response",
			id: "test-id",
			ts: 0,
			answer: "Use PostgreSQL",
		};
		q.enqueue(msg);
		expect(q.drain()).toEqual([msg]);
	});

	test("mixed message types flow through correctly", async () => {
		const q = new MessageQueue();
		q.enqueue({ source: "user", id: "test-id", ts: 0, content: "start" });
		q.enqueue({
			source: "task_complete",
			id: "test-id",
			ts: 0,
			taskId: "t1",
			title: "DB",
			success: true,
			output: "done",
		});
		q.enqueue({
			source: "task_message",
			id: "test-id",
			ts: 0,
			fromTaskId: "p1",
			fromTitle: "Orchestrator",
			content: "hurry up",
		});
		q.enqueue({ source: "clarify_response", id: "test-id", ts: 0, answer: "42" });

		const first = await q.wait();
		expect(first.source).toBe("user");

		const rest = q.drain();
		expect(rest).toHaveLength(3);
		expect(rest[0]?.source).toBe("task_complete");
		expect(rest[1]?.source).toBe("task_message");
		expect(rest[2]?.source).toBe("clarify_response");
	});

	test("waitForMessage() with no timeout behaves like wait()", async () => {
		const q = new MessageQueue();
		q.enqueue({ source: "user", id: "test-id", ts: 0, content: "hello" });
		const result = await q.waitForMessage(undefined);
		expect(result).toEqual({ source: "user", id: "test-id", ts: 0, content: "hello" });
	});

	test("waitForMessage() returns message before timeout fires", async () => {
		const q = new MessageQueue();
		const promise = q.waitForMessage(200);

		// Deliver message quickly
		setTimeout(
			() => q.enqueue({ source: "user", id: "test-id", ts: 0, content: "fast" }),
			10,
		);

		const result = await promise;
		expect(result).toEqual({ source: "user", id: "test-id", ts: 0, content: "fast" });
	});

	test("waitForMessage() returns 'timeout' sentinel when no message arrives", async () => {
		const q = new MessageQueue();
		const result = await q.waitForMessage(20);
		expect(result).toBe("timeout");
	});

	test("waitForMessage() resolves immediately if messages already pending", async () => {
		const q = new MessageQueue();
		q.enqueue({
			source: "clarify_response",
			id: "test-id",
			ts: 0,
			answer: "already here",
		});
		const result = await q.waitForMessage(20);
		expect(result).toEqual({
			source: "clarify_response",
			id: "test-id",
			ts: 0,
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

	test("enqueue with quiet option does not resolve a pending wait()", async () => {
		const q = new MessageQueue();

		const promise = q.wait();
		let resolved = false;
		promise.then(() => {
			resolved = true;
		});

		// Quiet enqueue should NOT wake the waiter
		q.enqueue(
			{
				source: "tree_change",
				id: "test-id",
				ts: 0,
				action: "created",
				nodeId: "n1",
				title: "Task A",
			},
			{ quiet: true },
		);
		await Promise.resolve();
		await Promise.resolve();
		expect(resolved).toBe(false);

		// But the message IS in the queue
		expect(q.pending).toBe(1);

		// A normal enqueue DOES wake the waiter
		q.enqueue({ source: "user", id: "test-id", ts: 0, content: "hello" });
		const msg = await promise;
		expect(msg).toEqual({ source: "user", id: "test-id", ts: 0, content: "hello" });
	});

	test("quiet enqueue message is included in drain()", () => {
		const q = new MessageQueue();
		q.enqueue(
			{
				source: "tree_change",
				id: "test-id",
				ts: 0,
				action: "created",
				nodeId: "n1",
				title: "Task A",
			},
			{ quiet: true },
		);
		q.enqueue({ source: "user", id: "test-id", ts: 0, content: "normal msg" });

		const msgs = q.drain();
		expect(msgs).toHaveLength(2);
		expect(msgs[0]?.source).toBe("tree_change");
		expect(msgs[1]).toEqual({
			source: "user",
			id: "test-id",
			ts: 0,
			content: "normal msg",
		});
	});

	test("quiet enqueue message is picked up by wait() when already pending", async () => {
		const q = new MessageQueue();
		q.enqueue(
			{
				source: "tree_change",
				id: "test-id",
				ts: 0,
				action: "updated",
				nodeId: "n2",
			},
			{ quiet: true },
		);

		// wait() checks pending messages first — should resolve immediately
		const msg = await q.wait();
		expect(msg.source).toBe("tree_change");
	});

	test("quiet enqueue throws on closed queue", () => {
		const q = new MessageQueue();
		q.close();
		expect(() =>
			q.enqueue(
				{
					source: "tree_change",
					id: "test-id",
					ts: 0,
					action: "created",
					nodeId: "n1",
				},
				{ quiet: true },
			),
		).toThrow("Queue closed");
	});

	test("quiet enqueue increments pending count", () => {
		const q = new MessageQueue();
		expect(q.pending).toBe(0);
		q.enqueue(
			{
				source: "tree_change",
				id: "test-id-1",
				ts: 0,
				action: "created",
				nodeId: "n1",
			},
			{ quiet: true },
		);
		expect(q.pending).toBe(1);
		q.enqueue(
			{
				source: "tree_change",
				id: "test-id-2",
				ts: 0,
				action: "updated",
				nodeId: "n2",
			},
			{ quiet: true },
		);
		expect(q.pending).toBe(2);
	});

	test("onEnqueue fires when message goes to array (no waiter)", () => {
		const q = new MessageQueue();
		const received: QueueMessage[] = [];
		q.onEnqueue = (msg) => received.push(msg);

		q.enqueue({ source: "user", id: "test-id", ts: 0, content: "hello" });
		q.enqueue({ source: "user", id: "test-id", ts: 0, content: "world" });

		expect(received).toHaveLength(2);
		expect(received[0]).toEqual({
			source: "user",
			id: "test-id",
			ts: 0,
			content: "hello",
		});
		expect(received[1]).toEqual({
			source: "user",
			id: "test-id",
			ts: 0,
			content: "world",
		});
	});

	test("onEnqueue fires when message goes directly to waiter", async () => {
		const q = new MessageQueue();
		const received: QueueMessage[] = [];
		q.onEnqueue = (msg) => received.push(msg);

		// Start waiting — creates a waiter
		const promise = q.wait();

		// Enqueue while waiter exists — message bypasses array
		q.enqueue({ source: "user", id: "test-id", ts: 0, content: "direct to waiter" });

		// onEnqueue should still have fired
		expect(received).toHaveLength(1);
		expect(received[0]).toEqual({
			source: "user",
			id: "test-id",
			ts: 0,
			content: "direct to waiter",
		});

		// Waiter should resolve with the message
		const msg = await promise;
		expect(msg).toEqual({
			source: "user",
			id: "test-id",
			ts: 0,
			content: "direct to waiter",
		});
	});

	test("onEnqueue does not fire for quiet enqueue", () => {
		const q = new MessageQueue();
		const received: QueueMessage[] = [];
		q.onEnqueue = (msg) => received.push(msg);

		q.enqueue(
			{
				source: "tree_change",
				id: "test-id-quiet",
				ts: 0,
				action: "created",
				nodeId: "n1",
			},
			{ quiet: true },
		);
		expect(received).toHaveLength(0);

		// But normal enqueue does fire it
		q.enqueue({ source: "user", id: "test-id", ts: 0, content: "loud" });
		expect(received).toHaveLength(1);
	});

	test("enqueue rejects messages without id", () => {
		const q = new MessageQueue();
		// Runtime validation: empty id should throw
		expect(() =>
			// biome-ignore lint/suspicious/noExplicitAny: testing runtime validation
			q.enqueue({ source: "user", id: "", ts: 0, content: "no id" } as any),
		).toThrow("QueueMessage must have a non-empty id");
		// Missing id entirely should throw
		expect(() =>
			// biome-ignore lint/suspicious/noExplicitAny: testing runtime validation
			q.enqueue({ source: "user", content: "no id at all" } as any),
		).toThrow("QueueMessage must have a non-empty id");
	});
});
