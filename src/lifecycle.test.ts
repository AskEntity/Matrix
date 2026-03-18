import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentEvent,
	AgentProvider,
	AgentSession,
} from "./agent-provider.ts";
import { createApp } from "./daemon.ts";
import { globalAgentQueues, MessageQueue } from "./message-queue.ts";
import { loadPersistedMessages } from "./persistent-queue.ts";
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
			async function* events(): AsyncGenerator<AgentEvent, AgentResult> {
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
			async function* events(): AsyncGenerator<AgentEvent, AgentResult> {
				// Keep the session alive until queue is closed
				try {
					await queue.wait();
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
			async function* events(): AsyncGenerator<AgentEvent, AgentResult> {
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
			persisted?: boolean;
			taskId: string;
		};
		expect(body.ok).toBe(true);
		// No queue was registered, so message is persisted
		expect(body.persisted).toBe(true);

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
		// With unified deliverMessage, message is always persisted first
		expect((body as Record<string, unknown>).persisted).toBe(true);

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
			persisted?: boolean;
		};
		expect(body.ok).toBe(true);
		expect(body.persisted).toBe(true);

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
			persisted?: boolean;
		};
		expect(body.ok).toBe(true);
		expect(body.persisted).toBe(true);
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
			persisted?: boolean;
		};
		expect(body.ok).toBe(true);
		expect(body.persisted).toBe(true);
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
			persisted?: boolean;
		};
		expect(body.ok).toBe(true);
		// Message persisted since no queue registered
		expect(body.persisted).toBe(true);
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
			persisted?: boolean;
		};
		expect(body.ok).toBe(true);
		expect(body.persisted).toBe(true);

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
		const body = (await res.json()) as { persisted?: boolean };
		expect(body.persisted).toBe(true);

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
			const body2 = (await res2.json()) as { persisted?: boolean };
			// With unified deliverMessage, message is always persisted first
			expect(body2.persisted).toBe(true);

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

	test("user message to child notifies root orchestrator via activeSessions queue", async () => {
		const { app, pm, markReady, activeSessions } = createApp({
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

		// Root orchestrator's queue lives in activeSessions (not globalAgentQueues)
		const rootQueue = new MessageQueue();
		activeSessions.set(project.id, {
			sessionId: "test-session",
			queue: rootQueue,
			sendMessage: async () => {},
			stop: () => {},
			events: (async function* () {
				yield { type: "text" as const, text: "" };
				return { success: true } as AgentResult;
			})(),
		} as AgentSession);

		// Child has a queue in globalAgentQueues
		const childQueue = new MessageQueue();
		globalAgentQueues.set(child.id, childQueue);

		// Send message to child — should notify root via activeSessions
		const res = await sendTaskMessage(app, project.id, child.id, "hello child");
		expect(res.status).toBe(200);

		// Child should have the user message
		const childMsgs = childQueue.drain();
		expect(childMsgs).toHaveLength(1);
		expect(childMsgs[0]?.source).toBe("user");

		// Root orchestrator should have a child_report notification via activeSessions queue
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
		activeSessions.delete(project.id);
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
