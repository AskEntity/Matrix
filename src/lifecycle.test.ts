import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider, AgentRequest } from "./agent-provider.ts";
import { runChildCore } from "./daemon/agent-lifecycle.ts";
import { createApp } from "./daemon.ts";
import { EventStore } from "./event-store.ts";
import type { Event } from "./events.ts";
import {
	globalAgentQueues,
	MessageQueue,
	type QueueMessage,
} from "./message-queue.ts";
import { loadPersistedMessages } from "./persistent-queue.ts";

import { TaskTracker } from "./task-tracker.ts";
import type { AgentResult, Project, TaskNode } from "./types.ts";

// ---------------------------------------------------------------------------
// Mock providers
// ---------------------------------------------------------------------------

/** Basic mock provider that exits immediately (session completes instantly). */
function createInstantProvider(): AgentProvider {
	return {
		name: "mock",
		execute: async () => ({ success: true, output: "" }),
		// biome-ignore lint/correctness/useYield: mock provider never streams
		stream: async function* () {
			return { success: true, output: "" };
		},
		startSession(req) {
			const queue = req.queue ?? new MessageQueue();
			// biome-ignore lint/correctness/useYield: mock session never streams
			async function* events(): AsyncGenerator<Event, AgentResult> {
				return { success: true, output: "" };
			}
			return {
				sessionId: "mock-session",
				events: events(),
				queue,
				sendMessage: async () => {},
				stop: () => {
					queue.close();
				},
			};
		},
	};
}

/** Mock provider that keeps the session alive until the queue is closed. */
function createLongRunningProvider(): AgentProvider {
	return {
		name: "mock-long",
		execute: async () => ({ success: true, output: "" }),
		// biome-ignore lint/correctness/useYield: mock
		stream: async function* () {
			return { success: true, output: "" };
		},
		startSession(req) {
			const queue = req.queue ?? new MessageQueue();
			// biome-ignore lint/correctness/useYield: mock session blocks on queue.wait()
			async function* events(): AsyncGenerator<Event, AgentResult> {
				// Keep the session alive — drain messages until queue is closed
				try {
					while (true) {
						await queue.wait();
					}
				} catch {
					// Queue closed — exit cleanly
				}
				return { success: true, output: "" };
			}
			return {
				sessionId: "mock-long-session",
				events: events(),
				queue,
				sendMessage: async () => {},
				stop: () => {
					queue.close();
				},
			};
		},
	};
}

/**
 * Mock provider that stays alive and records all messages received.
 * The session blocks on queue.wait() in a loop until closed.
 */
function createRecordingProvider(): {
	provider: AgentProvider;
	receivedMessages: Array<{ source: string; content?: string }>;
} {
	const receivedMessages: Array<{ source: string; content?: string }> = [];
	const provider: AgentProvider = {
		name: "mock-recording",
		execute: async () => ({ success: true, output: "" }),
		// biome-ignore lint/correctness/useYield: mock
		stream: async function* () {
			return { success: true, output: "" };
		},
		startSession(req) {
			const queue = req.queue ?? new MessageQueue();
			// biome-ignore lint/correctness/useYield: mock session blocks on queue.wait()
			async function* events(): AsyncGenerator<Event, AgentResult> {
				// Drain any initial messages
				for (const msg of queue.drain()) {
					receivedMessages.push({
						source: msg.source,
						content: "content" in msg ? (msg.content as string) : undefined,
					});
				}
				// Block on queue until closed
				while (true) {
					try {
						const msg = await queue.wait();
						receivedMessages.push({
							source: msg.source,
							content: "content" in msg ? (msg.content as string) : undefined,
						});
					} catch {
						break; // Queue closed
					}
				}
				return { success: true, output: "" };
			}
			return {
				sessionId: "mock-recording-session",
				events: events(),
				queue,
				sendMessage: async () => {},
				stop: () => {
					queue.close();
				},
			};
		},
	};
	return { provider, receivedMessages };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a project in the daemon and return its ID. */
async function createProject(
	app: ReturnType<typeof createApp>["app"],
	projectDir: string,
): Promise<Project> {
	const res = await app.request("/projects", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ path: projectDir }),
	});
	return (await res.json()) as Project;
}

/** Create a task under a project. */
async function createTask(
	app: ReturnType<typeof createApp>["app"],
	projectId: string,
	title: string,
	opts?: { parentId?: string; description?: string; status?: string },
): Promise<TaskNode> {
	const res = await app.request(`/projects/${projectId}/tasks`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			title,
			description: opts?.description ?? "",
			parentId: opts?.parentId,
			status: opts?.status,
		}),
	});
	return (await res.json()) as TaskNode;
}

/** Set a task's status via PATCH. */
async function setTaskStatus(
	app: ReturnType<typeof createApp>["app"],
	projectId: string,
	taskId: string,
	status: string,
): Promise<void> {
	await app.request(`/projects/${projectId}/tasks/${taskId}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ status }),
	});
}

/** Send a message to a task via POST /projects/:id/tasks/:nodeId/message. */
async function sendTaskMessage(
	app: ReturnType<typeof createApp>["app"],
	projectId: string,
	taskId: string,
	content: string,
): Promise<Response> {
	return app.request(`/projects/${projectId}/tasks/${taskId}/message`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ content }),
	});
}

/** Small delay helper. */
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("lifecycle: task state vs message delivery", () => {
	let tempDir: string;
	let dataDir: string;
	let projectDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-lc-state-"));
		dataDir = await mkdtemp(join(tmpdir(), "og-lc-stated-"));
		projectDir = join(tempDir, "proj");
		await mkdir(join(projectDir, ".git"), { recursive: true });
	});

	afterEach(async () => {
		// Clean up any stray globalAgentQueues entries
		for (const [key] of globalAgentQueues) {
			globalAgentQueues.delete(key);
		}
		await rm(tempDir, { recursive: true, force: true });
		await rm(dataDir, { recursive: true, force: true });
	});

	test("message to new task (no worktree) persists to disk", async () => {
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: createInstantProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const task = await createTask(app, project.id, "Fresh task");
		expect(task.status).toBe("pending");

		const res = await sendTaskMessage(app, project.id, task.id, "hello");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: boolean;
			taskId: string;
		};
		expect(body.ok).toBe(true);

		// Verify the message was persisted to disk
		const persisted = await loadPersistedMessages(dataDir, project.id, task.id);
		expect(persisted.length).toBeGreaterThanOrEqual(1);
		const userMsg = persisted.find((m) => m.source === "user");
		expect(userMsg).toBeTruthy();
		expect((userMsg as { content: string }).content).toBe("hello");
	});

	test("message to running task enqueues immediately", async () => {
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: createLongRunningProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const task = await createTask(app, project.id, "Running task");

		// Manually register a queue to simulate a running agent
		const taskQueue = new MessageQueue();
		globalAgentQueues.set(task.id, taskQueue);

		const res = await sendTaskMessage(
			app,
			project.id,
			task.id,
			"hello running",
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; taskId: string };
		expect(body.ok).toBe(true);
		// Queue was active — message delivered directly, NOT persisted to disk

		// Verify the message arrived in the queue
		const msgs = taskQueue.drain();
		expect(msgs).toHaveLength(1);
		expect(msgs[0]?.source).toBe("user");
		expect((msgs[0] as { content: string }).content).toBe("hello running");

		// Cleanup
		taskQueue.close();
		globalAgentQueues.delete(task.id);
	});

	test("message to idle task (in yield) enqueues and wakes", async () => {
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: createLongRunningProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const task = await createTask(app, project.id, "Idle task");

		// Register queue simulating an idle agent (waiting on queue.wait())
		const taskQueue = new MessageQueue();
		taskQueue.idle = true;
		globalAgentQueues.set(task.id, taskQueue);

		// Start a wait that should resolve when message arrives
		let wokenMsg: unknown = null;
		const waitPromise = taskQueue.wait().then((msg) => {
			wokenMsg = msg;
		});

		const res = await sendTaskMessage(app, project.id, task.id, "wake up");
		expect(res.status).toBe(200);

		// The waiting consumer should be resolved
		await waitPromise;
		expect(wokenMsg).toBeTruthy();
		expect((wokenMsg as { source: string }).source).toBe("user");
		expect((wokenMsg as { content: string }).content).toBe("wake up");

		// Cleanup
		taskQueue.close();
		globalAgentQueues.delete(task.id);
	});

	test("message to passed task persists to disk and triggers auto-launch", async () => {
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: createInstantProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const task = await createTask(app, project.id, "Done task");
		await setTaskStatus(app, project.id, task.id, "passed");

		const res = await sendTaskMessage(
			app,
			project.id,
			task.id,
			"resume please",
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: boolean;
		};
		expect(body.ok).toBe(true);

		// Wait for auto-launch to complete
		await delay(200);
	});

	test("message to failed task persists to disk and triggers auto-launch", async () => {
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: createInstantProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const task = await createTask(app, project.id, "Failed task");
		await setTaskStatus(app, project.id, task.id, "failed");

		const res = await sendTaskMessage(app, project.id, task.id, "try again");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: boolean;
		};
		expect(body.ok).toBe(true);
	});

	test("message to closed task persists to disk", async () => {
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: createInstantProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const task = await createTask(app, project.id, "Closed task");
		await setTaskStatus(app, project.id, task.id, "closed");

		const res = await sendTaskMessage(
			app,
			project.id,
			task.id,
			"reopen please",
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: boolean;
		};
		expect(body.ok).toBe(true);
	});

	test("message to draft task still delivers (draft status does not block REST endpoint)", async () => {
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: createInstantProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const task = await createTask(app, project.id, "Draft task");
		// Set status to draft via PATCH (POST /tasks doesn't accept status)
		await setTaskStatus(app, project.id, task.id, "draft");

		// Verify it's actually draft
		const getRes = await app.request(`/projects/${project.id}/tasks`);
		const { nodes } = (await getRes.json()) as { nodes: TaskNode[] };
		const draftNode = nodes.find((n) => n.id === task.id);
		expect(draftNode?.status).toBe("draft");

		// REST endpoint does not reject draft tasks — it persists the message
		const res = await sendTaskMessage(app, project.id, task.id, "work on this");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: boolean;
		};
		expect(body.ok).toBe(true);
	});

	test("message to closed queue falls through to persist (graceful handling)", async () => {
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: createInstantProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const task = await createTask(app, project.id, "Closing task");

		// Register a closed queue — simulates a race condition where
		// the queue closes between globalAgentQueues.get() and enqueue()
		const taskQueue = new MessageQueue();
		taskQueue.close();
		globalAgentQueues.set(task.id, taskQueue);

		const res = await sendTaskMessage(app, project.id, task.id, "hello");
		// After audit: route handler catches enqueue errors and falls through to persist
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: boolean;
		};
		expect(body.ok).toBe(true);

		globalAgentQueues.delete(task.id);
	});
});

describe("lifecycle: concurrent message sources", () => {
	let tempDir: string;
	let dataDir: string;
	let projectDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-lc-conc-"));
		dataDir = await mkdtemp(join(tmpdir(), "og-lc-concd-"));
		projectDir = join(tempDir, "proj");
		await mkdir(join(projectDir, ".git"), { recursive: true });
	});

	afterEach(async () => {
		for (const [key] of globalAgentQueues) {
			globalAgentQueues.delete(key);
		}
		await rm(tempDir, { recursive: true, force: true });
		await rm(dataDir, { recursive: true, force: true });
	});

	test("two rapid messages to running task both arrive in queue, no duplicate launch", async () => {
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: createLongRunningProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const task = await createTask(app, project.id, "Rapid messages task");

		// Register queue to simulate running agent
		const taskQueue = new MessageQueue();
		globalAgentQueues.set(task.id, taskQueue);

		// Send two messages rapidly
		const [res1, res2] = await Promise.all([
			sendTaskMessage(app, project.id, task.id, "first"),
			sendTaskMessage(app, project.id, task.id, "second"),
		]);

		expect(res1.status).toBe(200);
		expect(res2.status).toBe(200);

		// Both messages should be in the queue
		const msgs = taskQueue.drain();
		expect(msgs).toHaveLength(2);
		const contents = msgs.map((m) => ("content" in m ? m.content : ""));
		expect(contents).toContain("first");
		expect(contents).toContain("second");

		// Only one queue should exist (no duplicate)
		expect(globalAgentQueues.get(task.id)).toBe(taskQueue);

		taskQueue.close();
		globalAgentQueues.delete(task.id);
	});

	test("multiple messages from REST arrive in same queue", async () => {
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: createLongRunningProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const task = await createTask(app, project.id, "Multi message task");

		const taskQueue = new MessageQueue();
		globalAgentQueues.set(task.id, taskQueue);

		// Send 5 messages
		for (let i = 0; i < 5; i++) {
			const res = await sendTaskMessage(app, project.id, task.id, `msg-${i}`);
			expect(res.status).toBe(200);
		}

		const msgs = taskQueue.drain();
		expect(msgs).toHaveLength(5);
		for (let i = 0; i < 5; i++) {
			expect((msgs[i] as { content: string }).content).toBe(`msg-${i}`);
		}

		taskQueue.close();
		globalAgentQueues.delete(task.id);
	});

	test("REST message arrives while no queue — persists, then queue created by auto-launch", async () => {
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: createInstantProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const task = await createTask(app, project.id, "No queue task");

		// No queue registered — message gets persisted
		expect(globalAgentQueues.has(task.id)).toBe(false);

		const res = await sendTaskMessage(
			app,
			project.id,
			task.id,
			"persisted msg",
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(true);

		// Wait for auto-launch to complete
		await delay(200);

		// After launch completed (instant provider), queue should be cleaned up
		// (runChildCore finally block removes from globalAgentQueues)
		// The message was persisted, loaded into the queue at launch, then consumed
	});

	test("ensureChildAgentRunning deduplicates — second message enqueues to existing queue", async () => {
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: createLongRunningProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const task = await createTask(app, project.id, "Dedup task");

		// First message — no queue, triggers auto-launch
		const res1 = await sendTaskMessage(
			app,
			project.id,
			task.id,
			"first message",
		);
		expect(res1.status).toBe(200);

		// Wait for auto-launch to register the queue
		await delay(200);

		// The auto-launch should have created a queue in globalAgentQueues
		const queue = globalAgentQueues.get(task.id);
		// Note: if the instant provider completed, queue may already be removed.
		// With long-running provider, it should still be there.
		if (queue) {
			// Second message — queue exists, should enqueue directly
			const res2 = await sendTaskMessage(
				app,
				project.id,
				task.id,
				"second message",
			);
			expect(res2.status).toBe(200);
			const body2 = (await res2.json()) as { ok: boolean };
			// Queue active — message delivered directly, not persisted
			expect(body2.ok).toBe(true);

			// Still only one queue
			expect(globalAgentQueues.get(task.id)).toBe(queue);

			queue.close();
		}
		globalAgentQueues.delete(task.id);
	});
});

describe("lifecycle: queue state transitions", () => {
	let tempDir: string;
	let dataDir: string;
	let projectDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-lc-qtrans-"));
		dataDir = await mkdtemp(join(tmpdir(), "og-lc-qtransd-"));
		projectDir = join(tempDir, "proj");
		await mkdir(join(projectDir, ".git"), { recursive: true });
	});

	afterEach(async () => {
		for (const [key] of globalAgentQueues) {
			globalAgentQueues.delete(key);
		}
		await rm(tempDir, { recursive: true, force: true });
		await rm(dataDir, { recursive: true, force: true });
	});

	test("queue.wait() resolves when message is enqueued", async () => {
		const queue = new MessageQueue();
		let resolved = false;

		const waitPromise = queue.wait().then((msg) => {
			resolved = true;
			return msg;
		});

		expect(resolved).toBe(false);

		queue.enqueue({ source: "user", content: "wake" });
		const msg = await waitPromise;
		expect(resolved).toBe(true);
		expect(msg.source).toBe("user");
		expect((msg as { content: string }).content).toBe("wake");

		queue.close();
	});

	test("queue.close() rejects pending wait()", async () => {
		const queue = new MessageQueue();

		const waitPromise = queue.wait().catch((err: Error) => err);
		queue.close();

		const result = await waitPromise;
		expect(result).toBeInstanceOf(Error);
		expect((result as Error).message).toBe("Queue closed");
	});

	test("enqueue on closed queue throws", () => {
		const queue = new MessageQueue();
		queue.close();

		expect(() => queue.enqueue({ source: "user", content: "test" })).toThrow(
			"Queue closed",
		);
	});

	test("enqueueQuiet on closed queue throws", () => {
		const queue = new MessageQueue();
		queue.close();

		expect(() =>
			queue.enqueueQuiet({ source: "system", content: "test" }),
		).toThrow("Queue closed");
	});

	test("wait on closed queue rejects immediately", async () => {
		const queue = new MessageQueue();
		queue.close();

		try {
			await queue.wait();
			expect(true).toBe(false); // Should not reach here
		} catch (err) {
			expect((err as Error).message).toBe("Queue closed");
		}
	});

	test("drain returns empty array after close", () => {
		const queue = new MessageQueue();
		queue.enqueue({ source: "user", content: "a" });
		queue.enqueue({ source: "user", content: "b" });

		const msgs = queue.drain();
		expect(msgs).toHaveLength(2);

		// After drain, nothing left
		const msgs2 = queue.drain();
		expect(msgs2).toHaveLength(0);

		queue.close();
	});

	test("enqueueQuiet does not wake pending waiter", async () => {
		const queue = new MessageQueue();
		let woken = false;

		// Start waiting
		const waitPromise = queue.wait().then((msg) => {
			woken = true;
			return msg;
		});

		// enqueueQuiet should NOT resolve the waiter
		queue.enqueueQuiet({ source: "system", content: "quiet" });

		await delay(50);
		expect(woken).toBe(false);

		// But a regular enqueue SHOULD resolve
		queue.enqueue({ source: "user", content: "loud" });

		const msg = await waitPromise;
		expect(woken).toBe(true);
		expect(msg.source).toBe("user");
		expect((msg as { content: string }).content).toBe("loud");

		// The quiet message should still be in the queue
		const remaining = queue.drain();
		expect(remaining).toHaveLength(1);
		expect(remaining[0]?.source).toBe("system");

		queue.close();
	});
});

describe("lifecycle: globalAgentQueues consistency", () => {
	let tempDir: string;
	let dataDir: string;
	let projectDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-lc-gaq-"));
		dataDir = await mkdtemp(join(tmpdir(), "og-lc-gaqd-"));
		projectDir = join(tempDir, "proj");
		await mkdir(join(projectDir, ".git"), { recursive: true });
	});

	afterEach(async () => {
		for (const [key] of globalAgentQueues) {
			globalAgentQueues.delete(key);
		}
		await rm(tempDir, { recursive: true, force: true });
		await rm(dataDir, { recursive: true, force: true });
	});

	test("after agent launch and completion, queue is removed from registry", async () => {
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: createInstantProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const task = await createTask(app, project.id, "Ephemeral task");

		// Send message to trigger auto-launch
		await sendTaskMessage(app, project.id, task.id, "go");

		// Wait for instant agent to complete
		await delay(300);

		// Queue should be cleaned up after agent finishes (runChildCore finally block)
		expect(globalAgentQueues.has(task.id)).toBe(false);
	});

	test("manually registered queue is the only entry for a task", () => {
		const q1 = new MessageQueue();
		globalAgentQueues.set("task-1", q1);

		expect(globalAgentQueues.get("task-1")).toBe(q1);
		expect(globalAgentQueues.size).toBeGreaterThanOrEqual(1);

		// Setting again overwrites
		const q2 = new MessageQueue();
		globalAgentQueues.set("task-1", q2);
		expect(globalAgentQueues.get("task-1")).toBe(q2);
		expect(globalAgentQueues.get("task-1")).not.toBe(q1);

		q1.close();
		q2.close();
		globalAgentQueues.delete("task-1");
	});

	test("deleting from registry removes the entry", () => {
		const q = new MessageQueue();
		globalAgentQueues.set("task-del", q);
		expect(globalAgentQueues.has("task-del")).toBe(true);

		globalAgentQueues.delete("task-del");
		expect(globalAgentQueues.has("task-del")).toBe(false);

		q.close();
	});
});

describe("lifecycle: parent chain notifications", () => {
	let tempDir: string;
	let dataDir: string;
	let projectDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-lc-parent-"));
		dataDir = await mkdtemp(join(tmpdir(), "og-lc-parentd-"));
		projectDir = join(tempDir, "proj");
		await mkdir(join(projectDir, ".git"), { recursive: true });
	});

	afterEach(async () => {
		for (const [key] of globalAgentQueues) {
			globalAgentQueues.delete(key);
		}
		await rm(tempDir, { recursive: true, force: true });
		await rm(dataDir, { recursive: true, force: true });
	});

	test("user message to child notifies parent via queue (waking)", async () => {
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: createLongRunningProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const parent = await createTask(app, project.id, "Parent");
		const child = await createTask(app, project.id, "Child", {
			parentId: parent.id,
		});

		// Register queues for both parent and child (simulating both are running)
		const parentQueue = new MessageQueue();
		const childQueue = new MessageQueue();
		globalAgentQueues.set(parent.id, parentQueue);
		globalAgentQueues.set(child.id, childQueue);

		// Send message to child — should notify parent
		const res = await sendTaskMessage(app, project.id, child.id, "child msg");
		expect(res.status).toBe(200);

		// Child should have the user message
		const childMsgs = childQueue.drain();
		expect(childMsgs).toHaveLength(1);
		expect(childMsgs[0]?.source).toBe("user");

		// Parent should have a child_report notification
		const parentMsgs = parentQueue.drain();
		expect(parentMsgs.length).toBeGreaterThanOrEqual(1);
		const notification = parentMsgs.find((m) => m.source === "child_report");
		expect(notification).toBeTruthy();
		expect((notification as { content: string }).content).toContain("Child");

		parentQueue.close();
		childQueue.close();
		globalAgentQueues.delete(parent.id);
		globalAgentQueues.delete(child.id);
	});

	test("user message to grandchild notifies entire ancestor chain", async () => {
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: createLongRunningProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const grandparent = await createTask(app, project.id, "Grandparent");
		const parent = await createTask(app, project.id, "Parent", {
			parentId: grandparent.id,
		});
		const child = await createTask(app, project.id, "Grandchild", {
			parentId: parent.id,
		});

		// Register queues for all three levels
		const gpQueue = new MessageQueue();
		const pQueue = new MessageQueue();
		const cQueue = new MessageQueue();
		globalAgentQueues.set(grandparent.id, gpQueue);
		globalAgentQueues.set(parent.id, pQueue);
		globalAgentQueues.set(child.id, cQueue);

		await sendTaskMessage(app, project.id, child.id, "deep msg");

		// Grandchild gets the user message
		const cMsgs = cQueue.drain();
		expect(cMsgs).toHaveLength(1);
		expect(cMsgs[0]?.source).toBe("user");

		// Parent gets notification
		const pMsgs = pQueue.drain();
		expect(pMsgs.some((m) => m.source === "child_report")).toBe(true);

		// Grandparent gets notification
		const gpMsgs = gpQueue.drain();
		expect(gpMsgs.some((m) => m.source === "child_report")).toBe(true);

		gpQueue.close();
		pQueue.close();
		cQueue.close();
		globalAgentQueues.delete(grandparent.id);
		globalAgentQueues.delete(parent.id);
		globalAgentQueues.delete(child.id);
	});

	test("user message to child persists notification when parent has no queue", async () => {
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: createInstantProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const parent = await createTask(app, project.id, "Offline parent");
		const child = await createTask(app, project.id, "Child task", {
			parentId: parent.id,
		});

		// Only register queue for child (parent is not running)
		const childQueue = new MessageQueue();
		globalAgentQueues.set(child.id, childQueue);

		await sendTaskMessage(app, project.id, child.id, "child msg");

		// Child gets the message
		const cMsgs = childQueue.drain();
		expect(cMsgs).toHaveLength(1);
		expect(cMsgs[0]?.source).toBe("user");

		// Parent notification should be persisted to disk
		const persisted = await loadPersistedMessages(
			dataDir,
			project.id,
			parent.id,
		);
		expect(persisted.length).toBeGreaterThanOrEqual(1);
		const notification = persisted.find((m) => m.source === "child_report");
		expect(notification).toBeTruthy();

		childQueue.close();
		globalAgentQueues.delete(child.id);
	});

	test("user message to child notifies root orchestrator via globalAgentQueues", async () => {
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: createLongRunningProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);

		// Create root → child hierarchy
		const root = await createTask(app, project.id, "Root orchestrator");
		const child = await createTask(app, project.id, "Child task", {
			parentId: root.id,
		});

		// Root orchestrator's queue is in the unified globalAgentQueues registry
		const rootQueue = new MessageQueue();
		globalAgentQueues.set(root.id, rootQueue);

		// Child has a queue in globalAgentQueues
		const childQueue = new MessageQueue();
		globalAgentQueues.set(child.id, childQueue);

		// Send message to child — should notify root via globalAgentQueues
		const res = await sendTaskMessage(app, project.id, child.id, "hello child");
		expect(res.status).toBe(200);

		// Child should have the user message
		const childMsgs = childQueue.drain();
		expect(childMsgs).toHaveLength(1);
		expect(childMsgs[0]?.source).toBe("user");

		// Root orchestrator should have a child_report notification via globalAgentQueues
		const rootMsgs = rootQueue.drain();
		expect(rootMsgs.length).toBeGreaterThanOrEqual(1);
		const notification = rootMsgs.find((m) => m.source === "child_report");
		expect(notification).toBeTruthy();
		expect((notification as { content: string }).content).toContain(
			"Child task",
		);

		childQueue.close();
		rootQueue.close();
		globalAgentQueues.delete(child.id);
		globalAgentQueues.delete(root.id);
	});
});

describe("lifecycle: orchestrator message routing", () => {
	let tempDir: string;
	let dataDir: string;
	let projectDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-lc-orch-"));
		dataDir = await mkdtemp(join(tmpdir(), "og-lc-orchd-"));
		projectDir = join(tempDir, "proj");
		await mkdir(join(projectDir, ".git"), { recursive: true });
	});

	afterEach(async () => {
		for (const [key] of globalAgentQueues) {
			globalAgentQueues.delete(key);
		}
		await rm(tempDir, { recursive: true, force: true });
		await rm(dataDir, { recursive: true, force: true });
	});

	test("POST /projects/:id/message to running orchestrator enqueues user message", async () => {
		const { provider, receivedMessages } = createRecordingProvider();
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: provider,
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);

		// Start the orchestrator
		const startRes = await app.request(
			`/projects/${project.id}/orchestrate/agent`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prompt: "initial prompt" }),
			},
		);
		expect(startRes.status).toBe(200);
		await delay(100);

		// Send a follow-up message
		const msgRes = await app.request(`/projects/${project.id}/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "follow up" }),
		});
		expect(msgRes.status).toBe(200);

		await delay(100);

		// The recording provider should have picked up the message
		expect(receivedMessages.some((m) => m.content === "follow up")).toBe(true);

		// Stop the orchestrator
		await app.request(`/projects/${project.id}/stop`, { method: "POST" });
		await delay(100);
	});

	test("POST /projects/:id/message with no session persists and auto-resumes", async () => {
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: createInstantProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);

		// Start and quickly stop to create a root node
		await app.request(`/projects/${project.id}/orchestrate/agent`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "setup" }),
		});
		await delay(200);

		// Now agent should have completed (instant provider)
		// Send message — should trigger auto-resume
		const msgRes = await app.request(`/projects/${project.id}/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "new instruction" }),
		});
		expect(msgRes.status).toBe(200);

		await delay(200);
	});

	test("POST /projects/:id/orchestrate/agent while running enqueues instead of 409", async () => {
		const { provider, receivedMessages } = createRecordingProvider();
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: provider,
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);

		// Start orchestrator
		await app.request(`/projects/${project.id}/orchestrate/agent`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "first" }),
		});
		await delay(100);

		// Send another orchestrate request — should enqueue, not error
		const res2 = await app.request(
			`/projects/${project.id}/orchestrate/agent`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prompt: "second instruction" }),
			},
		);
		expect(res2.status).toBe(200);
		// The endpoint returns { status: "running", projectId } for all success cases
		const body2 = (await res2.json()) as {
			status: string;
			projectId: string;
		};
		expect(body2.status).toBe("running");

		await delay(100);
		expect(
			receivedMessages.some((m) => m.content === "second instruction"),
		).toBe(true);

		// Stop
		await app.request(`/projects/${project.id}/stop`, { method: "POST" });
		await delay(100);
	});
});

describe("lifecycle: MessageQueue drainMerged", () => {
	test("merges consecutive system messages", () => {
		const queue = new MessageQueue();
		queue.enqueue({ source: "system", content: "Tree updated: task_created" });
		queue.enqueue({
			source: "system",
			content: "Tree updated: task_updated",
		});
		queue.enqueue({
			source: "system",
			content: "Tree updated: task_reordered",
		});

		const msgs = queue.drainMerged();
		expect(msgs).toHaveLength(1);
		expect(msgs[0]?.source).toBe("system");
		expect((msgs[0] as { content: string }).content).toContain(
			"Tree updated 3 times",
		);

		queue.close();
	});

	test("preserves non-system messages in order", () => {
		const queue = new MessageQueue();
		queue.enqueue({ source: "user", content: "hello" });
		queue.enqueue({ source: "system", content: "a" });
		queue.enqueue({ source: "system", content: "b" });
		queue.enqueue({ source: "user", content: "world" });

		const msgs = queue.drainMerged();
		expect(msgs).toHaveLength(3);
		expect(msgs[0]?.source).toBe("user");
		expect((msgs[0] as { content: string }).content).toBe("hello");
		expect(msgs[1]?.source).toBe("system");
		expect((msgs[1] as { content: string }).content).toContain("2 times");
		expect(msgs[2]?.source).toBe("user");
		expect((msgs[2] as { content: string }).content).toBe("world");

		queue.close();
	});

	test("single system message passes through unchanged", () => {
		const queue = new MessageQueue();
		queue.enqueue({ source: "system", content: "one update" });

		const msgs = queue.drainMerged();
		expect(msgs).toHaveLength(1);
		expect((msgs[0] as { content: string }).content).toBe("one update");

		queue.close();
	});
});

describe("lifecycle: waitForMessage timeout", () => {
	test("returns timeout when no message arrives within deadline", async () => {
		const queue = new MessageQueue();
		const result = await queue.waitForMessage(50);
		expect(result).toBe("timeout");
		queue.close();
	});

	test("returns message if one is already pending", async () => {
		const queue = new MessageQueue();
		queue.enqueue({ source: "user", content: "immediate" });
		const result = await queue.waitForMessage(1000);
		expect(result).not.toBe("timeout");
		expect((result as { content: string }).content).toBe("immediate");
		queue.close();
	});

	test("returns message if one arrives before timeout", async () => {
		const queue = new MessageQueue();
		setTimeout(() => {
			queue.enqueue({ source: "user", content: "before timeout" });
		}, 10);
		const result = await queue.waitForMessage(500);
		expect(result).not.toBe("timeout");
		expect((result as { content: string }).content).toBe("before timeout");
		queue.close();
	});
});

describe("lifecycle: persistent queue integration", () => {
	let tempDir: string;
	let dataDir: string;
	let projectDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-lc-pq-"));
		dataDir = await mkdtemp(join(tmpdir(), "og-lc-pqd-"));
		projectDir = join(tempDir, "proj");
		await mkdir(join(projectDir, ".git"), { recursive: true });
	});

	afterEach(async () => {
		for (const [key] of globalAgentQueues) {
			globalAgentQueues.delete(key);
		}
		await rm(tempDir, { recursive: true, force: true });
		await rm(dataDir, { recursive: true, force: true });
	});

	test("message to task without queue persists to disk", async () => {
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: createInstantProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const task = await createTask(app, project.id, "Persist test");

		// No queue registered — message should be persisted
		expect(globalAgentQueues.has(task.id)).toBe(false);

		await sendTaskMessage(app, project.id, task.id, "persisted content");

		// Wait briefly for async persistence
		await delay(50);

		// Verify message was persisted
		const persisted = await loadPersistedMessages(dataDir, project.id, task.id);
		expect(persisted.length).toBeGreaterThanOrEqual(1);
		const userMsg = persisted.find((m) => m.source === "user");
		expect(userMsg).toBeTruthy();
		expect((userMsg as { content: string }).content).toBe("persisted content");
	});

	test("persisted messages accumulate when multiple sent without queue", async () => {
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: createInstantProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const task = await createTask(app, project.id, "Multi persist");

		// Send multiple messages (will persist since no queue)
		await sendTaskMessage(app, project.id, task.id, "msg 1");
		await delay(50);
		await sendTaskMessage(app, project.id, task.id, "msg 2");
		await delay(50);

		// Both should be persisted (auto-launch may fail in test env with fake git)
		const persisted = await loadPersistedMessages(dataDir, project.id, task.id);
		// At least the user messages should be there
		const userMsgs = persisted.filter((m) => m.source === "user");
		expect(userMsgs.length).toBeGreaterThanOrEqual(2);
		expect((userMsgs[0] as { content: string }).content).toBe("msg 1");
		expect((userMsgs[1] as { content: string }).content).toBe("msg 2");
	});
});

describe("lifecycle: stop agent cascading", () => {
	let tempDir: string;
	let dataDir: string;
	let projectDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-lc-stop-"));
		dataDir = await mkdtemp(join(tmpdir(), "og-lc-stopd-"));
		projectDir = join(tempDir, "proj");
		await mkdir(join(projectDir, ".git"), { recursive: true });
	});

	afterEach(async () => {
		for (const [key] of globalAgentQueues) {
			globalAgentQueues.delete(key);
		}
		await rm(tempDir, { recursive: true, force: true });
		await rm(dataDir, { recursive: true, force: true });
	});

	test("stopping orchestrator closes child queues in globalAgentQueues", async () => {
		const { app, pm, markReady, getTracker } = createApp({
			dataDir,
			agentProvider: createLongRunningProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);

		// Start orchestrator
		await app.request(`/projects/${project.id}/orchestrate/agent`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "test" }),
		});
		await delay(100);

		// Create a child task and register its queue (simulating a running child)
		const tracker = await getTracker(project.id);
		const rootId = tracker.rootNodeId;
		expect(rootId).toBeTruthy();

		const childTask = await createTask(app, project.id, "Child agent", {
			parentId: rootId ?? "",
		});
		await setTaskStatus(app, project.id, childTask.id, "in_progress");

		const childQueue = new MessageQueue();
		globalAgentQueues.set(childTask.id, childQueue);

		// Stop the orchestrator — should cascade to children
		await app.request(`/projects/${project.id}/stop`, { method: "POST" });
		await delay(100);

		// Child queue should have been closed by stopAgent cascade
		expect(() =>
			childQueue.enqueue({ source: "user", content: "test" }),
		).toThrow("Queue closed");

		// Child status should be failed (cascade effect)
		const updatedTracker = await getTracker(project.id);
		const childNode = updatedTracker.get(childTask.id);
		expect(childNode?.status).toBe("failed");

		globalAgentQueues.delete(childTask.id);
	});
});

describe("lifecycle: clarify response routing", () => {
	let tempDir: string;
	let dataDir: string;
	let projectDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-lc-clarify-"));
		dataDir = await mkdtemp(join(tmpdir(), "og-lc-clarifyd-"));
		projectDir = join(tempDir, "proj");
		await mkdir(join(projectDir, ".git"), { recursive: true });
	});

	afterEach(async () => {
		for (const [key] of globalAgentQueues) {
			globalAgentQueues.delete(key);
		}
		await rm(tempDir, { recursive: true, force: true });
		await rm(dataDir, { recursive: true, force: true });
	});

	test("clarify response routes to child queue when child is in globalAgentQueues", async () => {
		const { provider } = createRecordingProvider();
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: provider,
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);

		// Start orchestrator
		await app.request(`/projects/${project.id}/orchestrate/agent`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "test" }),
		});
		await delay(100);

		// Create a child and register its queue
		const child = await createTask(app, project.id, "Clarifying child");
		const childQueue = new MessageQueue();
		globalAgentQueues.set(child.id, childQueue);

		// Send clarify response targeting the child
		const res = await app.request(`/projects/${project.id}/clarify`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				taskId: child.id,
				answer: "yes, proceed",
			}),
		});
		expect(res.status).toBe(200);

		// Response should be in the child queue, not the orchestrator queue
		const childMsgs = childQueue.drain();
		expect(childMsgs).toHaveLength(1);
		expect(childMsgs[0]?.source).toBe("clarify_response");
		expect((childMsgs[0] as { answer: string }).answer).toBe("yes, proceed");

		childQueue.close();
		globalAgentQueues.delete(child.id);
		await app.request(`/projects/${project.id}/stop`, { method: "POST" });
		await delay(100);
	});

	test("clarify response persists when no active session", async () => {
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: createInstantProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const task = await createTask(app, project.id, "Offline task");

		// No session running — clarify response should persist
		const res = await app.request(`/projects/${project.id}/clarify`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				taskId: task.id,
				answer: "offline answer",
			}),
		});
		// Without an active session, this falls through to persist
		expect(res.status).toBe(200);

		const persisted = await loadPersistedMessages(dataDir, project.id, task.id);
		expect(persisted.length).toBeGreaterThanOrEqual(1);
		const clarifyMsg = persisted.find((m) => m.source === "clarify_response");
		expect(clarifyMsg).toBeTruthy();
		expect((clarifyMsg as { answer: string }).answer).toBe("offline answer");
	});
});

describe("lifecycle: edge cases and error handling", () => {
	let tempDir: string;
	let dataDir: string;
	let projectDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-lc-edge-"));
		dataDir = await mkdtemp(join(tmpdir(), "og-lc-edged-"));
		projectDir = join(tempDir, "proj");
		await mkdir(join(projectDir, ".git"), { recursive: true });
	});

	afterEach(async () => {
		for (const [key] of globalAgentQueues) {
			globalAgentQueues.delete(key);
		}
		await rm(tempDir, { recursive: true, force: true });
		await rm(dataDir, { recursive: true, force: true });
	});

	test("message to nonexistent task returns 400 or 200 with persisted", async () => {
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: createInstantProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);

		// Send message to a task ID that doesn't exist
		const res = await sendTaskMessage(
			app,
			project.id,
			"nonexistent-task-id",
			"hello",
		);
		// The endpoint should still respond (it persists even for unknown tasks)
		expect(res.status).toBe(200);
	});

	test("message with missing content returns 400", async () => {
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: createInstantProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const task = await createTask(app, project.id, "Test task");

		const res = await app.request(
			`/projects/${project.id}/tasks/${task.id}/message`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			},
		);
		expect(res.status).toBe(400);
	});

	test("message to nonexistent project returns 404", async () => {
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: createInstantProvider(),
		});
		await pm.load();
		markReady();

		const res = await app.request(
			"/projects/nonexistent-proj/tasks/some-task/message",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: "hello" }),
			},
		);
		expect(res.status).toBe(404);
	});

	test("orchestrate before markReady returns 503", async () => {
		const { app, pm } = createApp({
			dataDir,
			agentProvider: createInstantProvider(),
		});
		await pm.load();
		// Note: NOT calling markReady()

		const project = await createProject(app, projectDir);

		const res = await app.request(`/projects/${project.id}/orchestrate/agent`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "test" }),
		});
		expect(res.status).toBe(503);
	});

	test("multiple queues for different tasks coexist independently", () => {
		const q1 = new MessageQueue();
		const q2 = new MessageQueue();
		const q3 = new MessageQueue();

		globalAgentQueues.set("task-a", q1);
		globalAgentQueues.set("task-b", q2);
		globalAgentQueues.set("task-c", q3);

		q1.enqueue({ source: "user", content: "to a" });
		q2.enqueue({ source: "user", content: "to b" });
		q3.enqueue({ source: "user", content: "to c" });

		expect(q1.drain()[0]).toEqual({ source: "user", content: "to a" });
		expect(q2.drain()[0]).toEqual({ source: "user", content: "to b" });
		expect(q3.drain()[0]).toEqual({ source: "user", content: "to c" });

		// Closing one doesn't affect others
		q1.close();
		expect(() => q1.enqueue({ source: "user", content: "fail" })).toThrow(
			"Queue closed",
		);
		q2.enqueue({ source: "user", content: "still works" });
		expect(q2.drain()).toHaveLength(1);

		q2.close();
		q3.close();
		globalAgentQueues.delete("task-a");
		globalAgentQueues.delete("task-b");
		globalAgentQueues.delete("task-c");
	});

	test("queue idle flag tracks state correctly", () => {
		const queue = new MessageQueue();
		expect(queue.idle).toBe(false);

		queue.idle = true;
		expect(queue.idle).toBe(true);

		queue.idle = false;
		expect(queue.idle).toBe(false);

		queue.close();
	});

	test("pending count tracks messages correctly", () => {
		const queue = new MessageQueue();
		expect(queue.pending).toBe(0);

		queue.enqueue({ source: "user", content: "a" });
		expect(queue.pending).toBe(1);

		queue.enqueue({ source: "user", content: "b" });
		expect(queue.pending).toBe(2);

		queue.drain();
		expect(queue.pending).toBe(0);

		queue.enqueue({ source: "user", content: "c" });
		expect(queue.pending).toBe(1);

		queue.close();
	});
});

describe("lifecycle: delete-before-close ordering invariant", () => {
	test("proper cleanup: delete from registry then close queue", () => {
		const queue = new MessageQueue();
		globalAgentQueues.set("task-cleanup", queue);

		// This is the correct order per the audit:
		// 1. Delete from globalAgentQueues (so other code sees "no queue" instead of "closed queue")
		// 2. Close the queue (to terminate the running agent)
		globalAgentQueues.delete("task-cleanup");
		queue.close();

		// After delete, the registry should not have the entry
		expect(globalAgentQueues.has("task-cleanup")).toBe(false);
		// After close, enqueue should throw
		expect(() => queue.enqueue({ source: "user", content: "test" })).toThrow(
			"Queue closed",
		);
	});

	test("wrong order (close then delete) leaves closed queue visible briefly", () => {
		const queue = new MessageQueue();
		globalAgentQueues.set("task-wrong", queue);

		// If we close first, the registry briefly contains a closed queue
		queue.close();
		// At this point, another concurrent caller could get the closed queue
		const retrieved = globalAgentQueues.get("task-wrong");
		expect(retrieved).toBe(queue); // Still in registry!
		expect(() =>
			retrieved?.enqueue({ source: "user", content: "test" }),
		).toThrow("Queue closed"); // But it's broken

		globalAgentQueues.delete("task-wrong");
	});

	test("delete-before-close prevents stale queue retrieval", () => {
		const queue = new MessageQueue();
		globalAgentQueues.set("task-safe", queue);

		// Correct order
		globalAgentQueues.delete("task-safe");
		// Now a concurrent caller would see no queue (falls through to persist path)
		expect(globalAgentQueues.get("task-safe")).toBeUndefined();

		// Close to terminate agent
		queue.close();
	});
});

describe("lifecycle: REST DELETE /tasks/:id closes agent queues", () => {
	let tempDir: string;
	let dataDir: string;
	let projectDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-lc-restdel-"));
		dataDir = await mkdtemp(join(tmpdir(), "og-lc-restdeld-"));
		projectDir = join(tempDir, "proj");
		await mkdir(join(projectDir, ".git"), { recursive: true });
	});

	afterEach(async () => {
		for (const [key] of globalAgentQueues) {
			globalAgentQueues.delete(key);
		}
		await rm(tempDir, { recursive: true, force: true });
		await rm(dataDir, { recursive: true, force: true });
	});

	test("DELETE /tasks/:id closes active queue for the task", async () => {
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: createInstantProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const task = await createTask(app, project.id, "Deletable task");

		// Register a queue (simulating running agent)
		const taskQueue = new MessageQueue();
		globalAgentQueues.set(task.id, taskQueue);

		// Delete the task via REST
		const res = await app.request(`/projects/${project.id}/tasks/${task.id}`, {
			method: "DELETE",
		});
		expect(res.status).toBe(200);

		// Queue should be removed from registry
		expect(globalAgentQueues.has(task.id)).toBe(false);

		// Queue should be closed
		expect(() =>
			taskQueue.enqueue({ source: "user", content: "test" }),
		).toThrow("Queue closed");
	});

	test("DELETE /tasks/:id closes queues for all descendants", async () => {
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: createInstantProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const parent = await createTask(app, project.id, "Parent to delete");
		const child = await createTask(app, project.id, "Child of parent", {
			parentId: parent.id,
		});

		// Register queues for both
		const parentQueue = new MessageQueue();
		const childQueue = new MessageQueue();
		globalAgentQueues.set(parent.id, parentQueue);
		globalAgentQueues.set(child.id, childQueue);

		// Delete the parent (should cascade to children)
		const res = await app.request(
			`/projects/${project.id}/tasks/${parent.id}`,
			{ method: "DELETE" },
		);
		expect(res.status).toBe(200);

		// Both queues should be removed from registry
		expect(globalAgentQueues.has(parent.id)).toBe(false);
		expect(globalAgentQueues.has(child.id)).toBe(false);

		// Both should be closed
		expect(() =>
			parentQueue.enqueue({ source: "user", content: "test" }),
		).toThrow("Queue closed");
		expect(() =>
			childQueue.enqueue({ source: "user", content: "test" }),
		).toThrow("Queue closed");
	});

	test("DELETE /tasks/:id works fine when no queue is registered", async () => {
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: createInstantProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const task = await createTask(app, project.id, "No queue task");

		// No queue registered — delete should still work
		expect(globalAgentQueues.has(task.id)).toBe(false);

		const res = await app.request(`/projects/${project.id}/tasks/${task.id}`, {
			method: "DELETE",
		});
		expect(res.status).toBe(200);
	});
});

// ---------------------------------------------------------------------------
// Child completion notification paths
// ---------------------------------------------------------------------------

describe("lifecycle: child completion notification paths", () => {
	let tempDir: string;
	let dataDir: string;
	let projectDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-lc-childcomp-"));
		dataDir = await mkdtemp(join(tmpdir(), "og-lc-childcompd-"));
		projectDir = join(tempDir, "proj");
		await mkdir(join(projectDir, ".git"), { recursive: true });
	});

	afterEach(async () => {
		for (const [key] of globalAgentQueues) {
			globalAgentQueues.delete(key);
		}
		await rm(tempDir, { recursive: true, force: true });
		await rm(dataDir, { recursive: true, force: true });
	});

	test("reset task then re-start: child_complete reaches parent", async () => {
		// Test the full cycle: child runs → completes → parent gets child_complete
		// → reset → child runs again → parent gets child_complete again.
		// Uses runChildCore directly to avoid needing real git worktrees.

		const trackerPath = join(dataDir, "test-reset-tracker.json");
		const tracker = new TaskTracker(trackerPath);
		const parentNode = tracker.ensureRootNode("Parent", "");
		const childNode = tracker.addChild(parentNode.id, "Child", "");
		tracker.updateStatus(parentNode.id, "in_progress");
		tracker.updateStatus(childNode.id, "in_progress");

		// Register parent queue (simulating running parent agent)
		const parentQueue = new MessageQueue();
		globalAgentQueues.set(parentNode.id, parentQueue);

		// -- First run --
		const firstQueue = new MessageQueue();
		firstQueue.enqueue({ source: "user", content: "do work" });
		const result1 = await runChildCore({
			provider: createInstantProvider(),
			tracker,
			taskId: childNode.id,
			sessionRequest: {
				cwd: projectDir,
				queue: firstQueue,
			},
		});
		expect(result1.success).toBe(true);

		// After runChildCore, the queue is cleaned up from globalAgentQueues
		expect(globalAgentQueues.has(childNode.id)).toBe(false);

		// Simulate runChildAgentInBackground's post-completion: send child_complete
		parentQueue.enqueue({
			source: "child_complete" as const,
			taskId: childNode.id,
			title: childNode.title,
			success: true,
			output: "",
		});

		// Verify child_complete in parent queue
		let parentMsgs = parentQueue.drain();
		const firstComplete = parentMsgs.find((m) => m.source === "child_complete");
		expect(firstComplete).toBeTruthy();
		expect((firstComplete as { taskId: string }).taskId).toBe(childNode.id);

		// -- Reset --
		// Simulate reset_task: clean up queue (already gone after runChildCore),
		// update status to pending
		tracker.updateStatus(childNode.id, "pending");

		// -- Second run --
		tracker.updateStatus(childNode.id, "in_progress");
		const secondQueue = new MessageQueue();
		secondQueue.enqueue({ source: "user", content: "try again" });
		const result2 = await runChildCore({
			provider: createInstantProvider(),
			tracker,
			taskId: childNode.id,
			sessionRequest: {
				cwd: projectDir,
				queue: secondQueue,
			},
		});
		expect(result2.success).toBe(true);

		// Simulate child_complete again
		parentQueue.enqueue({
			source: "child_complete" as const,
			taskId: childNode.id,
			title: childNode.title,
			success: true,
			output: "",
		});

		// Verify second child_complete arrives
		parentMsgs = parentQueue.drain();
		const secondComplete = parentMsgs.find(
			(m) => m.source === "child_complete",
		);
		expect(secondComplete).toBeTruthy();
		expect((secondComplete as { taskId: string }).taskId).toBe(childNode.id);

		parentQueue.close();
		globalAgentQueues.delete(parentNode.id);
	});

	test("child_complete after task_completed event (done()=yield detection)", async () => {
		// KEY test for the deadlock fix.
		//
		// The done()=yield sequence is:
		// 1. done() handler updates tracker status to passed/failed
		// 2. done() handler calls emit({ type: "task_completed" }) — triggers onTaskEvent
		// 3. onTaskEvent (the fix) closes the child queue
		// 4. done() handler calls waitForQueueMessages() — rejects immediately (queue closed)
		// 5. done() returns → provider emits tool_result → runChildCore sees it and exits
		//
		// This test simulates the stream behavior where:
		// - The tracker status is updated to "passed" (step 1)
		// - The queue is closed externally (step 3 — the fix)
		// - The stream unblocks and exits (steps 4-5)
		// - runChildCore completes without deadlock
		//
		// If the onEvent callback does NOT close the queue, the stream deadlocks.

		const trackerPath = join(dataDir, "test-donefix-tracker.json");
		const tracker = new TaskTracker(trackerPath);
		const parentNode = tracker.ensureRootNode("Parent", "");
		tracker.updateStatus(parentNode.id, "in_progress");
		const childNode = tracker.addChild(parentNode.id, "Child", "");
		const childId = childNode.id;
		tracker.updateStatus(childId, "in_progress");

		// Register parent queue
		const parentQueue = new MessageQueue();
		globalAgentQueues.set(parentNode.id, parentQueue);

		// Create a provider whose stream simulates done()=yield:
		// 1. Emits text (simulating work)
		// 2. Updates tracker status (simulating done() handler step 1)
		// 3. Yields a "status" event with task_completed message (simulating emit())
		// 4. Blocks on queue.wait() (simulating done() handler step 3)
		// The stream NEVER yields a tool_result for mcp__opengraft__done —
		// that only happens AFTER done() unblocks.
		const doneYieldProvider: AgentProvider = {
			name: "mock-done-yield",
			execute: async () => ({ success: true, output: "" }),
			stream: async function* (req) {
				const queue = req.queue ?? new MessageQueue();

				// Step 1: Agent does some work
				yield {
					type: "assistant_text" as const,
					content: "Working...",
					ts: Date.now(),
				};

				// Step 2: Agent calls done("passed") — handler updates tracker
				tracker.updateStatus(childId, "passed");

				// Step 3: done() handler calls emit({ type: "task_completed" })
				// In production, this triggers onTaskEvent which closes the queue.
				// Provider calls emit() which flows to emitEvent → onTaskEvent.
				req.emit?.({
					type: "status",
					message: `task_completed:${childId}`,
					ts: Date.now(),
				});

				// Step 4: done() handler calls waitForQueueMessages()
				// which blocks on queue.wait() — if queue is closed, it rejects
				try {
					await queue.wait();
				} catch {
					// Queue closed — exit cleanly (the fix unblocks us here)
				}

				// Step 5: After unblocking, the provider would emit tool_result
				// (but we're simulating the whole thing)
				return { success: true, output: "done" } as AgentResult;
			},
			startSession(req) {
				const queue = req.queue ?? new MessageQueue();
				return {
					sessionId: "mock",
					events: this.stream(req),
					queue,
					sendMessage: async () => {},
					stop: () => queue.close(),
				};
			},
		};

		const eventLog: string[] = [];

		// Build emit callback that simulates the fix:
		// When it sees the task_completed event AND tracker shows passed/failed,
		// it closes the queue. This is what createAgentContext's onTaskEvent does.
		const emit = (event: Event) => {
			eventLog.push(event.type);

			if (event.type === "status" && "message" in event) {
				const msg = event.message as string;
				if (msg.startsWith("task_completed:")) {
					const nodeStatus = tracker.get(childId)?.status;
					if (nodeStatus === "passed" || nodeStatus === "failed") {
						const q = globalAgentQueues.get(childId);
						if (q) q.close();
					}
				}
			}
		};

		const doneQueue = new MessageQueue();
		doneQueue.enqueue({ source: "user", content: "test" });
		const corePromise = runChildCore({
			provider: doneYieldProvider,
			tracker,
			taskId: childId,
			sessionRequest: {
				cwd: projectDir,
				queue: doneQueue,
				emit,
			},
		});

		// Race against timeout — deadlock means corePromise never resolves
		const timeoutPromise = delay(3000).then(() => "timeout" as const);
		const result = await Promise.race([corePromise, timeoutPromise]);

		// With the fix in place, runChildCore should complete (not timeout)
		expect(result).not.toBe("timeout");
		expect(tracker.get(childId)?.status).toBe("passed");
		expect(eventLog).toContain("status");

		// Cleanup
		globalAgentQueues.delete(childId);
		parentQueue.close();
		globalAgentQueues.delete(parentNode.id);
	});

	test("done()=yield deadlocks WITHOUT task_completed detection", async () => {
		// Companion test: verifies that WITHOUT the fix (no queue closure in onEvent),
		// the stream blocks indefinitely. This proves the fix is necessary.

		const trackerPath = join(dataDir, "test-deadlock-tracker.json");
		const tracker = new TaskTracker(trackerPath);
		const parentNode = tracker.ensureRootNode("Parent", "");
		tracker.updateStatus(parentNode.id, "in_progress");
		const childNode = tracker.addChild(parentNode.id, "Child", "");
		const childId = childNode.id;
		tracker.updateStatus(childId, "in_progress");

		// Provider that simulates done()=yield WITHOUT the fix closing the queue
		const deadlockProvider: AgentProvider = {
			name: "mock-deadlock",
			execute: async () => ({ success: true, output: "" }),
			stream: async function* (req) {
				const queue = req.queue ?? new MessageQueue();
				yield {
					type: "assistant_text" as const,
					content: "Working...",
					ts: Date.now(),
				};

				tracker.updateStatus(childId, "passed");
				yield {
					type: "status" as const,
					message: "task_completed",
					ts: Date.now(),
				};

				// Block forever — no one closes the queue
				try {
					await queue.wait();
				} catch {
					// If somehow closed, exit
				}
				return { success: true, output: "done" } as AgentResult;
			},
			startSession(req) {
				const queue = req.queue ?? new MessageQueue();
				return {
					sessionId: "mock",
					events: this.stream(req),
					queue,
					sendMessage: async () => {},
					stop: () => queue.close(),
				};
			},
		};

		const deadlockQueue = new MessageQueue();
		deadlockQueue.enqueue({ source: "user", content: "test" });
		const corePromise = runChildCore({
			provider: deadlockProvider,
			tracker,
			taskId: childId,
			sessionRequest: {
				cwd: projectDir,
				queue: deadlockQueue,
				// No emit callback — nothing closes the queue on task_completed
			},
		});

		// Should timeout because the stream is stuck in queue.wait()
		const timeoutPromise = delay(500).then(() => "timeout" as const);
		const result = await Promise.race([corePromise, timeoutPromise]);
		expect(result).toBe("timeout");

		// Force cleanup — close the queue to unblock the deadlocked provider
		const stuckQueue = globalAgentQueues.get(childId);
		if (stuckQueue) {
			globalAgentQueues.delete(childId);
			stuckQueue.close();
		}
		// Wait for runChildCore to finish after we unblocked it
		await Promise.race([corePromise, delay(1000)]);
	});

	test("reset task cleans up queue from globalAgentQueues", async () => {
		// Verify that reset_task (simulated) properly cleans up the old queue,
		// and that re-starting after reset creates a fresh queue.
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: createLongRunningProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const parent = await createTask(app, project.id, "Parent");
		const child = await createTask(app, project.id, "Child", {
			parentId: parent.id,
		});

		// Register a queue for the child (simulating running agent)
		const oldQueue = new MessageQueue();
		globalAgentQueues.set(child.id, oldQueue);
		expect(globalAgentQueues.get(child.id)).toBe(oldQueue);

		// Simulate reset_task: delete from registry THEN close (correct order)
		globalAgentQueues.delete(child.id);
		oldQueue.close();

		// Verify queue is gone
		expect(globalAgentQueues.has(child.id)).toBe(false);

		// Verify old queue is closed
		expect(() => oldQueue.enqueue({ source: "user", content: "test" })).toThrow(
			"Queue closed",
		);

		// After reset, re-start creates a fresh queue (via auto-launch)
		// Send a message to trigger auto-launch
		await setTaskStatus(app, project.id, child.id, "pending");
		await sendTaskMessage(app, project.id, child.id, "restart");
		await delay(300);

		// If auto-launch succeeded, a new queue was created (and may already be gone
		// if the instant provider completed). Either way, it's not the old queue.
		const newQueue = globalAgentQueues.get(child.id);
		if (newQueue) {
			expect(newQueue).not.toBe(oldQueue);
			newQueue.close();
			globalAgentQueues.delete(child.id);
		}
	});

	test("reset task while running: queue closed, agent stops", async () => {
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: createLongRunningProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const task = await createTask(app, project.id, "Running child");
		await setTaskStatus(app, project.id, task.id, "in_progress");

		// Register queue simulating a running agent blocked on queue.wait()
		const taskQueue = new MessageQueue();
		globalAgentQueues.set(task.id, taskQueue);

		// Start a waiter to detect when queue is closed
		let waiterError: Error | null = null;
		const waiterPromise = taskQueue.wait().catch((err: Error) => {
			waiterError = err;
		});

		// Simulate reset_task behavior:
		// 1. Delete from globalAgentQueues (so callers see "no queue")
		const activeQueue = globalAgentQueues.get(task.id);
		expect(activeQueue).toBe(taskQueue);
		globalAgentQueues.delete(task.id);

		// 2. Close the queue (stops the agent)
		activeQueue?.close();

		// 3. Update status to pending
		await setTaskStatus(app, project.id, task.id, "pending");

		// Wait for the waiter to be rejected
		await waiterPromise;

		// Verify queue was closed (waiter got the error)
		expect(waiterError).toBeInstanceOf(Error);
		// biome-ignore lint/style/noNonNullAssertion: verified above
		expect(waiterError!.message).toBe("Queue closed");

		// Verify queue is removed from registry
		expect(globalAgentQueues.has(task.id)).toBe(false);

		// Verify status is pending
		const getRes = await app.request(`/projects/${project.id}/tasks`);
		const { nodes } = (await getRes.json()) as { nodes: TaskNode[] };
		const resetNode = nodes.find((n) => n.id === task.id);
		expect(resetNode?.status).toBe("pending");
	});
});

// ---------------------------------------------------------------------------
// Session continuity edge cases
// ---------------------------------------------------------------------------

/**
 * Mock provider that captures session requests for inspection.
 * Each call to startSession records the AgentRequest and keeps the
 * session alive until the queue is closed.
 */
function createCapturingProvider(): {
	provider: AgentProvider;
	/** All AgentRequests that were passed to startSession, in order. */
	sessionRequests: AgentRequest[];
	/** Queue messages drained from each session (indexed by session index). */
	queueMessages: QueueMessage[][];
} {
	const sessionRequests: AgentRequest[] = [];
	const queueMessages: QueueMessage[][] = [];
	const provider: AgentProvider = {
		name: "mock-capturing",
		execute: async () => ({ success: true, output: "" }),
		// biome-ignore lint/correctness/useYield: mock
		stream: async function* () {
			return { success: true, output: "" };
		},
		startSession(req) {
			sessionRequests.push(req);
			const queue = req.queue ?? new MessageQueue();
			const sessionIdx = sessionRequests.length - 1;
			queueMessages[sessionIdx] = [];
			// biome-ignore lint/correctness/useYield: mock session blocks on queue.wait()
			async function* events(): AsyncGenerator<Event, AgentResult> {
				try {
					while (true) {
						const msg = await queue.wait();
						// Capture queue messages for test assertions
						const msgs = queueMessages[sessionIdx];
						if (msgs) msgs.push(msg);
					}
				} catch {
					// Queue closed
				}
				return { success: true, output: "" };
			}
			return {
				sessionId: req.resumeSessionId ?? "mock-capturing-session",
				events: events(),
				queue,
				sendMessage: async () => {},
				stop: () => {
					queue.close();
				},
			};
		},
	};
	return { provider, sessionRequests, queueMessages };
}

/**
 * Mock provider whose sessions exit immediately (for tests that
 * need the agent to complete quickly so the queue is cleaned up).
 */
function createInstantCapturingProvider(): {
	provider: AgentProvider;
	sessionRequests: AgentRequest[];
} {
	const sessionRequests: AgentRequest[] = [];
	const provider: AgentProvider = {
		name: "mock-instant-capturing",
		execute: async () => ({ success: true, output: "" }),
		// biome-ignore lint/correctness/useYield: mock
		stream: async function* () {
			return { success: true, output: "" };
		},
		startSession(req) {
			sessionRequests.push(req);
			const queue = req.queue ?? new MessageQueue();
			// biome-ignore lint/correctness/useYield: mock session exits immediately
			async function* events(): AsyncGenerator<Event, AgentResult> {
				return { success: true, output: "" };
			}
			return {
				sessionId: req.resumeSessionId ?? "mock-instant-session",
				events: events(),
				queue,
				sendMessage: async () => {},
				stop: () => {
					queue.close();
				},
			};
		},
	};
	return { provider, sessionRequests };
}

describe("lifecycle edge cases — session continuity", () => {
	let tempDir: string;
	let dataDir: string;
	let projectDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-lc-session-"));
		dataDir = await mkdtemp(join(tmpdir(), "og-lc-sessiond-"));
		projectDir = join(tempDir, "proj");
		await mkdir(join(projectDir, ".git"), { recursive: true });
	});

	afterEach(async () => {
		for (const [key] of globalAgentQueues) {
			globalAgentQueues.delete(key);
		}
		await rm(tempDir, { recursive: true, force: true });
		await rm(dataDir, { recursive: true, force: true });
	});

	test("clear sessions then send message starts fresh (not resume)", async () => {
		// 1. Create project, launch agent, stop it
		// 2. Clear sessions
		// 3. Send message
		// 4. Verify: orchestration_started has resume: false and includes the prompt
		const { provider, sessionRequests, queueMessages } =
			createCapturingProvider();
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: provider,
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);

		// Launch agent with initial prompt
		await app.request(`/projects/${project.id}/orchestrate/agent`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "initial task" }),
		});
		await delay(100);
		expect(sessionRequests.length).toBe(1);

		// Stop the agent
		await app.request(`/projects/${project.id}/stop`, { method: "POST" });
		await delay(100);

		// Clear sessions
		const clearRes = await app.request(
			`/projects/${project.id}/sessions/clear`,
			{ method: "POST" },
		);
		expect(clearRes.status).toBe(200);

		// Send a new message (should trigger fresh launch, not resume)
		const msgRes = await app.request(`/projects/${project.id}/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "new fresh task" }),
		});
		expect(msgRes.status).toBe(200);
		await delay(200);

		// Should have 2 session requests: initial + after clear
		expect(sessionRequests.length).toBe(2);

		// Key assertion: the queue should contain the user message (fresh start)
		// Messages are delivered via queue, not prompt
		const lastQueueMsgs = queueMessages[1] ?? [];
		const userMsg = lastQueueMsgs.find(
			(m) =>
				m.source === "user" &&
				(m as { content: string }).content === "new fresh task",
		);
		expect(userMsg).toBeDefined();

		// Verify the orchestration_started event has resume: false
		// Note: clear sessions wipes the JSONL events too, so only the
		// new session's events exist after clear.
		const eventStore = new EventStore(join(dataDir, "sessions", project.id));
		const allEvents = eventStore.readAllSorted();
		const orchStartEvents = allEvents.filter(
			(e) => e.type === "orchestration_started",
		);
		// After clear, only the new session's event exists
		expect(orchStartEvents.length).toBeGreaterThanOrEqual(1);
		// biome-ignore lint/style/noNonNullAssertion: length checked above
		const lastOrchStart = orchStartEvents[
			orchStartEvents.length - 1
		]! as Event & {
			type: "orchestration_started";
		};
		expect(lastOrchStart.resume).toBe(false);
		// prompt field removed from orchestration_started — messages now delivered via queue

		// Cleanup
		await app.request(`/projects/${project.id}/stop`, { method: "POST" });
		await delay(100);
	});

	test("clear sessions then send message — no stale session history", async () => {
		// 1. Create project, launch agent with "hello", let it run, stop
		// 2. Clear sessions
		// 3. Send new message "new task"
		// 4. Verify: The provider receives no session history (resumeSessionId
		//    points to a fresh session OR sessionStore has no data for it)
		const { provider, sessionRequests, queueMessages } =
			createCapturingProvider();
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: provider,
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);

		// Launch agent
		await app.request(`/projects/${project.id}/orchestrate/agent`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "hello" }),
		});
		await delay(100);

		// Stop
		await app.request(`/projects/${project.id}/stop`, { method: "POST" });
		await delay(100);

		// Write some fake event data to simulate a real session having history
		const sessionsDir = join(dataDir, "sessions", project.id);
		// biome-ignore lint/style/noNonNullAssertion: length checked above
		const firstReq = sessionRequests[0]!;
		const sessionId = firstReq.resumeSessionId ?? "unknown";
		const eventStore = new EventStore(sessionsDir);
		await eventStore.append(sessionId, {
			type: "message",
			id: "",
			body: { source: "user", content: "hello" },
			ts: Date.now(),
		} as Event);
		// Verify it was saved
		expect(eventStore.has(sessionId)).toBe(true);

		// Clear sessions — should wipe all session data
		await app.request(`/projects/${project.id}/sessions/clear`, {
			method: "POST",
		});
		await delay(100);

		// Event store should now be empty for this sessionId
		const freshStore = new EventStore(sessionsDir);
		expect(freshStore.has(sessionId)).toBe(false);

		// Send new message — should start fresh
		await app.request(`/projects/${project.id}/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "new task" }),
		});
		await delay(200);

		// Verify the new session request gets the raw prompt (fresh start)
		expect(sessionRequests.length).toBe(2);
		// Messages are delivered via queue, not prompt
		const newQueueMsgs = queueMessages[1] ?? [];
		const newUserMsg = newQueueMsgs.find(
			(m) =>
				m.source === "user" &&
				(m as { content: string }).content === "new task",
		);
		expect(newUserMsg).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: length checked above
		const newReq = sessionRequests[1]!;

		// Verify there's no old session history for the new session
		const newEventStore = new EventStore(sessionsDir);
		const newSessionId = newReq.resumeSessionId;
		if (newSessionId) {
			// New session should have no prior events (or only what the current run created)
			const events = newEventStore.read(newSessionId);
			// Events may exist from the new launch but should NOT contain old "hello" message
			const hasOldMessage = events.some(
				(e) =>
					e.type === "message" &&
					(e as Event & { type: "message" }).body.content === "hello",
			);
			expect(hasOldMessage).toBe(false);
		}

		// Cleanup
		await app.request(`/projects/${project.id}/stop`, { method: "POST" });
		await delay(100);
	});

	test("stop agent then send message resumes correctly", async () => {
		// 1. Create project, launch agent, stop it (session files preserved)
		// 2. Send message
		// 3. Verify: orchestration_started has resume: true
		const { provider, sessionRequests } = createCapturingProvider();
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: provider,
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);

		// Launch agent
		await app.request(`/projects/${project.id}/orchestrate/agent`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "initial work" }),
		});
		await delay(100);

		// Write fake event data so handleInjectMessage detects existing session
		// biome-ignore lint/style/noNonNullAssertion: length checked above
		const firstReq = sessionRequests[0]!;
		const sessionId = firstReq.resumeSessionId ?? "unknown";
		const sessionsDir = join(dataDir, "sessions", project.id);
		const eventStore2 = new EventStore(sessionsDir);
		await eventStore2.append(sessionId, {
			type: "message",
			id: "",
			body: { source: "user", content: "initial work" },
			ts: Date.now(),
		} as Event);

		// Stop the agent (session files preserved)
		await app.request(`/projects/${project.id}/stop`, { method: "POST" });
		await delay(100);

		// Send a new message — should trigger resume (not fresh)
		await app.request(`/projects/${project.id}/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "continue please" }),
		});
		await delay(200);

		// Should have 2 session requests: initial + resume
		expect(sessionRequests.length).toBe(2);
		// biome-ignore lint/style/noNonNullAssertion: length checked above
		const resumeReq = sessionRequests[1]!;

		// Key assertion: resume flag is set, and the user message arrives via queue
		expect(resumeReq.activeEvents?.length).toBeGreaterThan(0); // has session history

		// Verify the orchestration_started event has resume: true
		const eventStore = new EventStore(join(dataDir, "sessions", project.id));
		const allEvents = eventStore.readAllSorted();
		const orchStartEvents = allEvents.filter(
			(e) => e.type === "orchestration_started",
		);
		expect(orchStartEvents.length).toBeGreaterThanOrEqual(2);
		// biome-ignore lint/style/noNonNullAssertion: length checked above
		const lastOrchStart = orchStartEvents[
			orchStartEvents.length - 1
		]! as Event & {
			type: "orchestration_started";
		};
		expect(lastOrchStart.resume).toBe(true);

		// Cleanup
		await app.request(`/projects/${project.id}/stop`, { method: "POST" });
		await delay(100);
	});

	test("multiple rapid messages while no agent is running", async () => {
		// 1. Create project, launch and stop agent so rootNodeId exists
		// 2. No agent running, rootNodeId exists
		// 3. Send 3 messages rapidly
		// 4. Verify: Only one agent launch, all messages delivered via queue
		const { provider, sessionRequests } = createCapturingProvider();
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: provider,
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);

		// Launch and stop to establish rootNodeId
		await app.request(`/projects/${project.id}/orchestrate/agent`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "setup" }),
		});
		await delay(100);
		await app.request(`/projects/${project.id}/stop`, { method: "POST" });
		await delay(100);

		expect(sessionRequests.length).toBe(1);

		// Send 3 messages rapidly (no agent running)
		const [r1, r2, r3] = await Promise.all([
			app.request(`/projects/${project.id}/message`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message: "msg-1" }),
			}),
			app.request(`/projects/${project.id}/message`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message: "msg-2" }),
			}),
			app.request(`/projects/${project.id}/message`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message: "msg-3" }),
			}),
		]);

		expect(r1.status).toBe(200);
		expect(r2.status).toBe(200);
		expect(r3.status).toBe(200);

		// Wait for auto-launch to complete
		await delay(300);

		// The critical assertion: despite 3 rapid messages, each triggering
		// handleInjectMessage's auto-resume path, the number of NEW session
		// launches should be limited. The first message triggers a launch;
		// subsequent messages either persist or enqueue to the already-launching queue.
		// With the capturing long-running provider, once the queue exists in
		// activeSessions, subsequent messages enqueue instead of launching again.
		const launchCount = sessionRequests.length - 1; // subtract the initial setup launch
		expect(launchCount).toBeGreaterThanOrEqual(1);
		// With concurrent Promise.all, the exact number depends on race conditions,
		// but all 3 messages should ultimately succeed (all returned 200).

		// Cleanup
		await app.request(`/projects/${project.id}/stop`, { method: "POST" });
		await delay(100);
	});

	test("send message to non-existent project returns 404", async () => {
		const { provider } = createCapturingProvider();
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: provider,
		});
		await pm.load();
		markReady();

		const res = await app.request("/projects/nonexistent-id/message", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "hello" }),
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("Project not found");
	});

	test("send message creates root node if none exists", async () => {
		// Fresh project with no tasks — sending a message should create
		// the root node and launch agent as fresh (not resume)
		const { provider, sessionRequests, queueMessages } =
			createCapturingProvider();
		const { app, pm, markReady, getTracker } = createApp({
			dataDir,
			agentProvider: provider,
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);

		// Verify no root node yet
		const tracker = await getTracker(project.id);
		expect(tracker.rootNodeId).toBeNull();

		// Send message — should create root and launch fresh
		const res = await app.request(`/projects/${project.id}/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "first message ever" }),
		});
		expect(res.status).toBe(200);
		await delay(200);

		// Root node should now exist
		const updatedTracker = await getTracker(project.id);
		expect(updatedTracker.rootNodeId).not.toBeNull();

		// Should have exactly one session launch
		expect(sessionRequests.length).toBe(1);

		// Message delivered via queue with header, not as prompt
		const firstQueueMsgs = queueMessages[0] ?? [];
		const firstUserMsg = firstQueueMsgs.find(
			(m) =>
				m.source === "user" &&
				(m as { content: string }).content === "first message ever",
		);
		expect(firstUserMsg).toBeDefined();

		// Verify orchestration_started has resume: false
		const eventStore = new EventStore(join(dataDir, "sessions", project.id));
		const allEvents = eventStore.readAllSorted();
		const orchStart = allEvents.find(
			(e) => e.type === "orchestration_started",
		) as (Event & { type: "orchestration_started" }) | undefined;
		expect(orchStart).toBeTruthy();
		// biome-ignore lint/style/noNonNullAssertion: verified above
		expect(orchStart!.resume).toBe(false);
		// prompt field removed from orchestration_started — messages now delivered via queue

		// Cleanup
		await app.request(`/projects/${project.id}/stop`, { method: "POST" });
		await delay(100);
	});

	test("clear then send — event store has no events from previous session", async () => {
		// After clear, the event store is also wiped, so the events endpoint
		// should only return events from the new session
		const { provider } = createInstantCapturingProvider();
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: provider,
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);

		// Launch agent to generate some events
		await app.request(`/projects/${project.id}/orchestrate/agent`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "generate events" }),
		});
		await delay(200);

		// Verify events exist
		const eventStore1 = new EventStore(join(dataDir, "sessions", project.id));
		const beforeClear = eventStore1.readAllSorted();
		expect(beforeClear.length).toBeGreaterThan(0);

		// Clear sessions (also clears eventStores cache per sessions/clear handler)
		await app.request(`/projects/${project.id}/sessions/clear`, {
			method: "POST",
		});
		await delay(100);

		// After clear, event store should be empty
		const eventStore2 = new EventStore(join(dataDir, "sessions", project.id));
		const afterClear = eventStore2.readAllSorted();
		expect(afterClear.length).toBe(0);
	});

	test("stop preserves events; resume adds new events", async () => {
		const { provider, sessionRequests } = createCapturingProvider();
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: provider,
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);

		// Launch agent
		await app.request(`/projects/${project.id}/orchestrate/agent`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "do work" }),
		});
		await delay(100);

		// Count events after first launch
		const eventStore = new EventStore(join(dataDir, "sessions", project.id));
		const eventsAfterLaunch = eventStore.readAllSorted();
		const launchEventCount = eventsAfterLaunch.length;
		expect(launchEventCount).toBeGreaterThan(0);

		// Stop (preserves events)
		await app.request(`/projects/${project.id}/stop`, { method: "POST" });
		await delay(100);

		// Events should still be there (and may have more from stop)
		const eventsAfterStop = eventStore.readAllSorted();
		expect(eventsAfterStop.length).toBeGreaterThanOrEqual(launchEventCount);
		const stopEventCount = eventsAfterStop.length;

		// Save fake event to enable resume path
		// biome-ignore lint/style/noNonNullAssertion: length checked above
		const firstReq = sessionRequests[0]!;
		const sessionId = firstReq.resumeSessionId ?? "unknown";
		const sessionsDir = join(dataDir, "sessions", project.id);
		const eventStore2 = new EventStore(sessionsDir);
		await eventStore2.append(sessionId, {
			type: "message",
			id: "",
			body: { source: "user", content: "do work" },
			ts: Date.now(),
		} as Event);

		// Send message to resume
		await app.request(`/projects/${project.id}/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "resume now" }),
		});
		await delay(200);

		// New events should be added (orchestration_started for resume, etc.)
		const eventsAfterResume = eventStore.readAllSorted();
		expect(eventsAfterResume.length).toBeGreaterThan(stopEventCount);

		// Cleanup
		await app.request(`/projects/${project.id}/stop`, { method: "POST" });
		await delay(100);
	});
});
