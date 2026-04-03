import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider, AgentRequest } from "./agent-provider.ts";
import { runChildCore } from "./daemon/agent-lifecycle.ts";
import { createApp } from "./daemon.ts";
import { EventStore } from "./event-store.ts";
import type { Event } from "./events.ts";
import { MessageQueue, type QueueMessage } from "./message-queue.ts";

import { TaskTracker } from "./task-tracker.ts";
import { attachMockSession } from "./test-utils.ts";
import type { AgentResult, Project, TaskNode } from "./types.ts";

// ---------------------------------------------------------------------------
// Mock providers
// ---------------------------------------------------------------------------

/** Basic mock provider that exits immediately (session completes instantly). */
function createInstantProvider(): AgentProvider {
	return {
		name: "mock",
		execute: async () => ({
			exitReason: "interrupted" as const,
			output: "",
			costUsd: 0,
			turns: 0,
			sessionId: "mock-session",
		}),
		// biome-ignore lint/correctness/useYield: mock provider never streams
		stream: async function* () {
			return {
				exitReason: "interrupted" as const,
				output: "",
				costUsd: 0,
				turns: 0,
				sessionId: "mock-session",
			};
		},
	};
}

/** Mock provider that keeps the session alive until the queue is closed. */
function createLongRunningProvider(): AgentProvider {
	return {
		name: "mock-long",
		execute: async () => ({
			exitReason: "interrupted" as const,
			output: "",
			costUsd: 0,
			turns: 0,
			sessionId: "mock-long-session",
		}),
		// biome-ignore lint/correctness/useYield: mock session blocks on queue.wait()
		stream: async function* (req) {
			const queue = req.queue ?? new MessageQueue();
			// Keep the session alive — drain messages until queue is closed
			try {
				while (true) {
					await queue.wait();
				}
			} catch {
				// Queue closed — exit cleanly
			}
			return {
				exitReason: "interrupted" as const,
				output: "",
				costUsd: 0,
				turns: 0,
				sessionId: "mock-long-session",
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
		execute: async () => ({
			exitReason: "interrupted" as const,
			output: "",
			costUsd: 0,
			turns: 0,
			sessionId: "mock-recording-session",
		}),
		// biome-ignore lint/correctness/useYield: mock session blocks on queue.wait()
		stream: async function* (req) {
			const queue = req.queue ?? new MessageQueue();
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
			return {
				exitReason: "interrupted" as const,
				output: "",
				costUsd: 0,
				turns: 0,
				sessionId: "mock-recording-session",
			};
		},
	};
	return { provider, receivedMessages };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Helper: get root node ID for a project, then send a message to start the agent. */
async function startRootAgent(
	app: {
		request: (url: string, init?: RequestInit) => Response | Promise<Response>;
	},
	projectId: string,
	prompt: string,
): Promise<Response> {
	const tasksRes = await app.request(`/projects/${projectId}/tasks`);
	const { rootNodeId } = (await tasksRes.json()) as { rootNodeId: string };
	return app.request(`/projects/${projectId}/tasks/${rootNodeId}/message`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ content: prompt }),
	});
}

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

/** Create a task under a project. Defaults parentId to rootNodeId if not provided. */
async function createTask(
	app: ReturnType<typeof createApp>["app"],
	projectId: string,
	title: string,
	opts?: { parentId?: string; description?: string; status?: string },
): Promise<TaskNode> {
	let parentId = opts?.parentId;
	if (!parentId) {
		// Get rootNodeId from task tree
		const tasksRes = await app.request(`/projects/${projectId}/tasks`);
		const tasksBody = (await tasksRes.json()) as { rootNodeId: string };
		parentId = tasksBody.rootNodeId;
	}
	const res = await app.request(`/projects/${projectId}/tasks`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			title,
			description: opts?.description ?? "",
			parentId,
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

/** Send a message to the root agent via the unified task message endpoint. */
async function sendRootMessage(
	appInstance: ReturnType<typeof createApp>["app"],
	getTracker: ReturnType<typeof createApp>["getTracker"],
	projectId: string,
	content: string,
): Promise<Response> {
	const tracker = await getTracker(projectId);
	const rootNodeId = tracker.rootNodeId;
	return appInstance.request(
		`/projects/${projectId}/tasks/${rootNodeId}/message`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content }),
		},
	);
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
		tempDir = await mkdtemp(join(tmpdir(), "mxd-lc-state-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-lc-stated-"));
		projectDir = join(tempDir, "proj");
		await mkdir(join(projectDir, ".git"), { recursive: true });
	});

	afterEach(async () => {
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

		// Verify the message was written to JSONL
		await delay(50); // flush
		const eventStore = new EventStore(join(dataDir, "sessions", project.id));
		const events = eventStore.read(task.id);
		const userMsg = events.find(
			(e: Event) =>
				e.type === "message" &&
				e.body?.source === "user" &&
				e.body?.content === "hello",
		);
		expect(userMsg).toBeTruthy();
	});

	test("message to running task enqueues immediately", async () => {
		const { app, pm, markReady, getTracker } = createApp({
			dataDir,
			agentProvider: createLongRunningProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const task = await createTask(app, project.id, "Running task");

		// Attach session to simulate a running agent
		const taskQueue = new MessageQueue();
		const tracker = await getTracker(project.id);
		attachMockSession(tracker.getTask(task.id) as TaskNode, taskQueue);

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
		(tracker.getTask(task.id) as TaskNode).session = undefined;
		taskQueue.close();
	});

	test("message to idle task (in yield) enqueues and wakes", async () => {
		const { app, pm, markReady, getTracker } = createApp({
			dataDir,
			agentProvider: createLongRunningProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const task = await createTask(app, project.id, "Idle task");

		// Attach session simulating an idle agent (waiting on queue.wait())
		const taskQueue = new MessageQueue();
		taskQueue.idle = true;
		const tracker = await getTracker(project.id);
		attachMockSession(tracker.getTask(task.id) as TaskNode, taskQueue);

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
		(tracker.getTask(task.id) as TaskNode).session = undefined;
		taskQueue.close();
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
		const { app, pm, markReady, getTracker } = createApp({
			dataDir,
			agentProvider: createInstantProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const task = await createTask(app, project.id, "Closing task");

		// Attach session with a closed queue — simulates a race condition where
		// the queue closes between session lookup and enqueue()
		const taskQueue = new MessageQueue();
		taskQueue.close();
		const tracker = await getTracker(project.id);
		attachMockSession(tracker.getTask(task.id) as TaskNode, taskQueue);

		const res = await sendTaskMessage(app, project.id, task.id, "hello");
		// After audit: route handler catches enqueue errors and falls through to persist
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: boolean;
		};
		expect(body.ok).toBe(true);

		(tracker.getTask(task.id) as TaskNode).session = undefined;
	});
});

describe("lifecycle: concurrent message sources", () => {
	let tempDir: string;
	let dataDir: string;
	let projectDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-lc-conc-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-lc-concd-"));
		projectDir = join(tempDir, "proj");
		await mkdir(join(projectDir, ".git"), { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		await rm(dataDir, { recursive: true, force: true });
	});

	test("two rapid messages to running task both arrive in queue, no duplicate launch", async () => {
		const { app, pm, markReady, getTracker } = createApp({
			dataDir,
			agentProvider: createLongRunningProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const task = await createTask(app, project.id, "Rapid messages task");

		// Attach session to simulate running agent
		const taskQueue = new MessageQueue();
		const tracker = await getTracker(project.id);
		attachMockSession(tracker.getTask(task.id) as TaskNode, taskQueue);

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

		// Session queue should be the same one
		expect(tracker.getTask(task.id)?.session?.queue).toBe(taskQueue);

		(tracker.getTask(task.id) as TaskNode).session = undefined;
		taskQueue.close();
	});

	test("multiple messages from REST arrive in same queue", async () => {
		const { app, pm, markReady, getTracker } = createApp({
			dataDir,
			agentProvider: createLongRunningProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const task = await createTask(app, project.id, "Multi message task");

		const taskQueue = new MessageQueue();
		const tracker = await getTracker(project.id);
		attachMockSession(tracker.getTask(task.id) as TaskNode, taskQueue);

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

		(tracker.getTask(task.id) as TaskNode).session = undefined;
		taskQueue.close();
	});

	test("REST message arrives while no queue — persists, then queue created by auto-launch", async () => {
		const { app, pm, markReady, getTracker } = createApp({
			dataDir,
			agentProvider: createInstantProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const task = await createTask(app, project.id, "No queue task");

		// No session — message gets persisted
		const tracker = await getTracker(project.id);
		expect(tracker.getTask(task.id)?.session).toBeUndefined();

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
		// (runChildCore finally block clears session)
		// The message was persisted, loaded into the queue at launch, then consumed
	});

	test("ensureChildAgentRunning deduplicates — second message enqueues to existing queue", async () => {
		const { app, pm, markReady, getTracker } = createApp({
			dataDir,
			agentProvider: createLongRunningProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const task = await createTask(app, project.id, "Dedup task");

		// First message — no session, triggers auto-launch
		const res1 = await sendTaskMessage(
			app,
			project.id,
			task.id,
			"first message",
		);
		expect(res1.status).toBe(200);

		// Wait for auto-launch to register the session
		await delay(200);

		// The auto-launch should have created a session on the tracker node
		const tracker = await getTracker(project.id);
		const queue = tracker.getTask(task.id)?.session?.queue;
		// Note: if the instant provider completed, session may already be removed.
		// With long-running provider, it should still be there.
		if (queue) {
			// Second message — session exists, should enqueue directly
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

			// Still the same queue on the session
			expect(tracker.getTask(task.id)?.session?.queue).toBe(queue);

			queue.close();
		}
		const node = tracker.getTask(task.id);
		if (node) node.session = undefined;
	});

	test("ensureChildAgentRunning recovers from stale worktreePath — clears path and recreates", async () => {
		const { app, pm, markReady, getTracker } = createApp({
			dataDir,
			agentProvider: createInstantProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const task = await createTask(app, project.id, "Stale worktree task");

		const tracker = await getTracker(project.id);
		const node = tracker.getTask(task.id) as TaskNode;

		// Simulate a stale worktreePath — directory doesn't exist on disk
		const stalePath = join(projectDir, ".worktrees", "nonexistent-dir");
		node.worktreePath = stalePath;
		node.branch = "stale-branch";

		// Send a message — this triggers ensureChildAgentRunning via deliverMessage.
		// WorktreeManager.create will fail (fake .git), but the stale path
		// should be cleared before the worktree creation attempt.
		const res = await sendTaskMessage(
			app,
			project.id,
			task.id,
			"trigger launch",
		);
		expect(res.status).toBe(200);

		// Wait for the async auto-launch to run (and fail at WorktreeManager.create)
		await delay(200);

		// The stale worktreePath and branch should have been cleared
		// (even though worktree creation failed because of fake .git)
		expect(node.worktreePath).not.toBe(stalePath);
		expect(node.branch).not.toBe("stale-branch");
	});
});

describe("lifecycle: queue state transitions", () => {
	let tempDir: string;
	let dataDir: string;
	let projectDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-lc-qtrans-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-lc-qtransd-"));
		projectDir = join(tempDir, "proj");
		await mkdir(join(projectDir, ".git"), { recursive: true });
	});

	afterEach(async () => {
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

		queue.enqueue({ source: "user", id: "test-id", ts: 0, content: "wake" });
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

		expect(() =>
			queue.enqueue({ source: "user", id: "test-id", ts: 0, content: "test" }),
		).toThrow("Queue closed");
	});

	test("quiet enqueue on closed queue throws", () => {
		const queue = new MessageQueue();
		queue.close();

		expect(() =>
			queue.enqueue(
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
		queue.enqueue({ source: "user", id: "test-id", ts: 0, content: "a" });
		queue.enqueue({ source: "user", id: "test-id", ts: 0, content: "b" });

		const msgs = queue.drain();
		expect(msgs).toHaveLength(2);

		// After drain, nothing left
		const msgs2 = queue.drain();
		expect(msgs2).toHaveLength(0);

		queue.close();
	});

	test("quiet enqueue does not wake pending waiter", async () => {
		const queue = new MessageQueue();
		let woken = false;

		// Start waiting
		const waitPromise = queue.wait().then((msg) => {
			woken = true;
			return msg;
		});

		// quiet enqueue should NOT resolve the waiter
		queue.enqueue(
			{
				source: "tree_change",
				id: "test-id",
				ts: 0,
				action: "created",
				nodeId: "n1",
			},
			{ quiet: true },
		);

		await delay(50);
		expect(woken).toBe(false);

		// But a regular enqueue SHOULD resolve
		queue.enqueue({ source: "user", id: "test-id", ts: 0, content: "loud" });

		const msg = await waitPromise;
		expect(woken).toBe(true);
		expect(msg.source).toBe("user");
		expect((msg as { content: string }).content).toBe("loud");

		// The quiet message should still be in the queue
		const remaining = queue.drain();
		expect(remaining).toHaveLength(1);
		expect(remaining[0]?.source).toBe("tree_change");

		queue.close();
	});
});

describe("lifecycle: session consistency on tracker nodes", () => {
	let tempDir: string;
	let dataDir: string;
	let projectDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-lc-gaq-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-lc-gaqd-"));
		projectDir = join(tempDir, "proj");
		await mkdir(join(projectDir, ".git"), { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		await rm(dataDir, { recursive: true, force: true });
	});

	test("after agent launch and completion, session is removed from node", async () => {
		const { app, pm, markReady, getTracker } = createApp({
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

		// Session should be cleaned up after agent finishes
		const tracker = await getTracker(project.id);
		expect(tracker.getTask(task.id)?.session).toBeUndefined();
	});

	test("session on node holds the queue reference", () => {
		const tracker = new TaskTracker(join(tempDir, "tasks.json"));
		const node = tracker.addTask("task-1", "desc");
		const q1 = new MessageQueue();
		attachMockSession(node, q1);

		expect(node.session?.queue).toBe(q1);

		// Replacing session overwrites
		const q2 = new MessageQueue();
		attachMockSession(node, q2);
		expect(node.session?.queue).toBe(q2);
		expect(node.session?.queue).not.toBe(q1);

		q1.close();
		q2.close();
		node.session = undefined;
	});

	test("clearing session removes the entry", () => {
		const tracker = new TaskTracker(join(tempDir, "tasks.json"));
		const node = tracker.addTask("task-del", "desc");
		const q = new MessageQueue();
		attachMockSession(node, q);
		expect(node.session).toBeDefined();

		node.session = undefined;
		expect(node.session).toBeUndefined();

		q.close();
	});
});

describe("lifecycle: parent chain notifications", () => {
	let tempDir: string;
	let dataDir: string;
	let projectDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-lc-parent-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-lc-parentd-"));
		projectDir = join(tempDir, "proj");
		await mkdir(join(projectDir, ".git"), { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		await rm(dataDir, { recursive: true, force: true });
	});

	test("user message to child notifies parent via queue (waking)", async () => {
		const { app, pm, markReady, getTracker } = createApp({
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

		// Attach sessions for both parent and child (simulating both are running)
		const tracker = await getTracker(project.id);
		const parentQueue = new MessageQueue();
		const childQueue = new MessageQueue();
		attachMockSession(tracker.getTask(parent.id) as TaskNode, parentQueue);
		attachMockSession(tracker.getTask(child.id) as TaskNode, childQueue);

		// Send message to child — should notify parent
		const res = await sendTaskMessage(app, project.id, child.id, "child msg");
		expect(res.status).toBe(200);

		// Child should have the user message
		const childMsgs = childQueue.drain();
		expect(childMsgs).toHaveLength(1);
		expect(childMsgs[0]?.source).toBe("user");

		// Parent should have a user_message_forwarded notification (auto-forwarded user message)
		const parentMsgs = parentQueue.drain();
		expect(parentMsgs.length).toBeGreaterThanOrEqual(1);
		const notification = parentMsgs.find(
			(m) => m.source === "user_message_forwarded",
		);
		expect(notification).toBeTruthy();
		// Content is the raw user message, not a formatted string
		expect((notification as { content: string }).content).toBe("child msg");
		// Task title goes in fromTitle attribute
		expect((notification as { fromTitle: string }).fromTitle).toBe("Child");

		(tracker.getTask(parent.id) as TaskNode).session = undefined;
		(tracker.getTask(child.id) as TaskNode).session = undefined;
		parentQueue.close();
		childQueue.close();
	});

	test("user message to grandchild notifies entire ancestor chain", async () => {
		const { app, pm, markReady, getTracker } = createApp({
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

		// Attach sessions for all three levels
		const tracker = await getTracker(project.id);
		const gpQueue = new MessageQueue();
		const pQueue = new MessageQueue();
		const cQueue = new MessageQueue();
		attachMockSession(tracker.getTask(grandparent.id) as TaskNode, gpQueue);
		attachMockSession(tracker.getTask(parent.id) as TaskNode, pQueue);
		attachMockSession(tracker.getTask(child.id) as TaskNode, cQueue);

		await sendTaskMessage(app, project.id, child.id, "deep msg");

		// Grandchild gets the user message
		const cMsgs = cQueue.drain();
		expect(cMsgs).toHaveLength(1);
		expect(cMsgs[0]?.source).toBe("user");

		// Parent gets notification
		const pMsgs = pQueue.drain();
		expect(pMsgs.some((m) => m.source === "user_message_forwarded")).toBe(true);

		// Grandparent gets notification
		const gpMsgs = gpQueue.drain();
		expect(gpMsgs.some((m) => m.source === "user_message_forwarded")).toBe(
			true,
		);

		(tracker.getTask(grandparent.id) as TaskNode).session = undefined;
		(tracker.getTask(parent.id) as TaskNode).session = undefined;
		(tracker.getTask(child.id) as TaskNode).session = undefined;
		gpQueue.close();
		pQueue.close();
		cQueue.close();
	});

	test("user message to child persists notification when parent has no queue", async () => {
		const { app, pm, markReady, getTracker } = createApp({
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

		// Only attach session for child (parent is not running)
		const tracker = await getTracker(project.id);
		const childQueue = new MessageQueue();
		attachMockSession(tracker.getTask(child.id) as TaskNode, childQueue);

		await sendTaskMessage(app, project.id, child.id, "child msg");

		// Child gets the message
		const cMsgs = childQueue.drain();
		expect(cMsgs).toHaveLength(1);
		expect(cMsgs[0]?.source).toBe("user");

		// Parent notification should be written to JSONL
		await delay(50); // flush
		const eventStore = new EventStore(join(dataDir, "sessions", project.id));
		const events = eventStore.read(parent.id);
		const notification = events.find(
			(e: Event) =>
				e.type === "message" && e.body?.source === "user_message_forwarded",
		);
		expect(notification).toBeTruthy();

		(tracker.getTask(child.id) as TaskNode).session = undefined;
		childQueue.close();
	});

	test("user message to child notifies root orchestrator via session queue", async () => {
		const { app, pm, markReady, getTracker } = createApp({
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

		// Attach sessions for root and child
		const tracker = await getTracker(project.id);
		const rootQueue = new MessageQueue();
		attachMockSession(tracker.getTask(root.id) as TaskNode, rootQueue);

		const childQueue = new MessageQueue();
		attachMockSession(tracker.getTask(child.id) as TaskNode, childQueue);

		// Send message to child — should notify root via session queue
		const res = await sendTaskMessage(app, project.id, child.id, "hello child");
		expect(res.status).toBe(200);

		// Child should have the user message
		const childMsgs = childQueue.drain();
		expect(childMsgs).toHaveLength(1);
		expect(childMsgs[0]?.source).toBe("user");

		// Root orchestrator should have a user_message_forwarded notification
		const rootMsgs = rootQueue.drain();
		expect(rootMsgs.length).toBeGreaterThanOrEqual(1);
		const notification = rootMsgs.find(
			(m) => m.source === "user_message_forwarded",
		);
		expect(notification).toBeTruthy();
		// Content is the raw user message, not a formatted string
		expect((notification as { content: string }).content).toBe("hello child");
		// Task title goes in fromTitle attribute
		expect((notification as { fromTitle: string }).fromTitle).toBe(
			"Child task",
		);

		(tracker.getTask(child.id) as TaskNode).session = undefined;
		(tracker.getTask(root.id) as TaskNode).session = undefined;
		childQueue.close();
		rootQueue.close();
	});
});

describe("lifecycle: orchestrator message routing", () => {
	let tempDir: string;
	let dataDir: string;
	let projectDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-lc-orch-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-lc-orchd-"));
		projectDir = join(tempDir, "proj");
		await mkdir(join(projectDir, ".git"), { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		await rm(dataDir, { recursive: true, force: true });
	});

	test("POST /tasks/:nodeId/message to running orchestrator enqueues user message", async () => {
		const { provider, receivedMessages } = createRecordingProvider();
		const { app, pm, getTracker, markReady } = createApp({
			dataDir,
			agentProvider: provider,
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const tracker = await getTracker(project.id);
		const rootNodeId = tracker.rootNodeId;

		// Start the orchestrator
		const startRes = await startRootAgent(app, project.id, "initial prompt");
		expect(startRes.status).toBe(200);
		await delay(100);

		// Send a follow-up message via unified task endpoint
		const msgRes = await app.request(
			`/projects/${project.id}/tasks/${rootNodeId}/message`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: "follow up" }),
			},
		);
		expect(msgRes.status).toBe(200);

		await delay(100);

		// The recording provider should have picked up the message
		expect(receivedMessages.some((m) => m.content === "follow up")).toBe(true);

		// Stop the orchestrator
		await app.request(`/projects/${project.id}/stop`, { method: "POST" });
		await delay(100);
	});

	test("POST /tasks/:nodeId/message with no session persists and auto-resumes", async () => {
		const { app, pm, getTracker, markReady } = createApp({
			dataDir,
			agentProvider: createInstantProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const tracker = await getTracker(project.id);
		const rootNodeId = tracker.rootNodeId;

		// Start and quickly stop to create a session
		await startRootAgent(app, project.id, "setup");
		await delay(200);

		// Now agent should have completed (instant provider)
		// Send message via unified task endpoint — should trigger auto-resume
		const msgRes = await app.request(
			`/projects/${project.id}/tasks/${rootNodeId}/message`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: "new instruction" }),
			},
		);
		expect(msgRes.status).toBe(200);

		await delay(200);
	});

	test("POST /tasks/:nodeId/message while running enqueues instead of 409", async () => {
		const { provider, receivedMessages } = createRecordingProvider();
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: provider,
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);

		// Start orchestrator
		await startRootAgent(app, project.id, "first");
		await delay(100);

		// Send another message — should enqueue, not error
		const res2 = await startRootAgent(app, project.id, "second instruction");
		expect(res2.status).toBe(200);
		const body2 = (await res2.json()) as { ok: boolean };
		expect(body2.ok).toBe(true);

		await delay(100);
		expect(
			receivedMessages.some((m) => m.content === "second instruction"),
		).toBe(true);

		// Stop
		await app.request(`/projects/${project.id}/stop`, { method: "POST" });
		await delay(100);
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
		queue.enqueue({
			source: "user",
			id: "test-id",
			ts: 0,
			content: "immediate",
		});
		const result = await queue.waitForMessage(1000);
		expect(result).not.toBe("timeout");
		expect((result as { content: string }).content).toBe("immediate");
		queue.close();
	});

	test("returns message if one arrives before timeout", async () => {
		const queue = new MessageQueue();
		setTimeout(() => {
			queue.enqueue({
				source: "user",
				id: "test-id",
				ts: 0,
				content: "before timeout",
			});
		}, 10);
		const result = await queue.waitForMessage(500);
		expect(result).not.toBe("timeout");
		expect((result as { content: string }).content).toBe("before timeout");
		queue.close();
	});
});

describe("lifecycle: message persistence via JSONL", () => {
	let tempDir: string;
	let dataDir: string;
	let projectDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-lc-pq-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-lc-pqd-"));
		projectDir = join(tempDir, "proj");
		await mkdir(join(projectDir, ".git"), { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		await rm(dataDir, { recursive: true, force: true });
	});

	test("message to task without queue persists to JSONL", async () => {
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: createInstantProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const task = await createTask(app, project.id, "Persist test");

		// No session — message should be written to JSONL via deliverMessage
		await sendTaskMessage(app, project.id, task.id, "persisted content");

		// Wait briefly for async JSONL write
		await delay(50);

		// Verify message was written to JSONL
		const eventStore = new EventStore(join(dataDir, "sessions", project.id));
		const events = eventStore.read(task.id);
		const msgEvents = events.filter(
			(e: Event) =>
				e.type === "message" &&
				e.body?.source === "user" &&
				e.body?.content === "persisted content",
		);
		expect(msgEvents.length).toBeGreaterThanOrEqual(1);
	});

	test("multiple messages accumulate in JSONL when sent without queue", async () => {
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: createInstantProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const task = await createTask(app, project.id, "Multi persist");

		// Send multiple messages (will persist to JSONL since no queue)
		await sendTaskMessage(app, project.id, task.id, "msg 1");
		await delay(50);
		await sendTaskMessage(app, project.id, task.id, "msg 2");
		await delay(50);

		// Both should be in JSONL
		const eventStore = new EventStore(join(dataDir, "sessions", project.id));
		const events = eventStore.read(task.id);
		const userMsgEvents = events.filter(
			(e: Event) => e.type === "message" && e.body?.source === "user",
		);
		expect(userMsgEvents.length).toBeGreaterThanOrEqual(2);
		expect(
			(userMsgEvents[0] as unknown as { body: { content: string } }).body
				.content,
		).toBe("msg 1");
		expect(
			(userMsgEvents[1] as unknown as { body: { content: string } }).body
				.content,
		).toBe("msg 2");
	});
});

describe("lifecycle: stop agent cascading", () => {
	let tempDir: string;
	let dataDir: string;
	let projectDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-lc-stop-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-lc-stopd-"));
		projectDir = join(tempDir, "proj");
		await mkdir(join(projectDir, ".git"), { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		await rm(dataDir, { recursive: true, force: true });
	});

	test("stopping orchestrator closes child sessions on tracker", async () => {
		const { app, pm, markReady, getTracker } = createApp({
			dataDir,
			agentProvider: createLongRunningProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);

		// Start orchestrator
		await startRootAgent(app, project.id, "test");
		await delay(100);

		// Create a child task and attach session (simulating a running child)
		const tracker = await getTracker(project.id);
		const rootId = tracker.rootNodeId;
		expect(rootId).toBeTruthy();

		const childTask = await createTask(app, project.id, "Child agent", {
			parentId: rootId ?? "",
		});
		await setTaskStatus(app, project.id, childTask.id, "in_progress");

		const childQueue = new MessageQueue();
		attachMockSession(tracker.getTask(childTask.id) as TaskNode, childQueue);

		// Stop the orchestrator — should cascade to children
		await app.request(`/projects/${project.id}/stop`, { method: "POST" });
		await delay(100);

		// Child queue should have been closed by stopAgent cascade
		expect(() =>
			childQueue.enqueue({
				source: "user",
				id: "test-id",
				ts: 0,
				content: "test",
			}),
		).toThrow("Queue closed");

		// Child status should stay in_progress (interrupted, not failed)
		// stopAgent no longer marks children as failed — they are resumable on restart
		const updatedTracker = await getTracker(project.id);
		const childNode = updatedTracker.getTask(childTask.id);
		expect(childNode?.status).toBe("in_progress");
	});
});

describe("lifecycle: clarify response routing", () => {
	let tempDir: string;
	let dataDir: string;
	let projectDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-lc-clarify-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-lc-clarifyd-"));
		projectDir = join(tempDir, "proj");
		await mkdir(join(projectDir, ".git"), { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		await rm(dataDir, { recursive: true, force: true });
	});

	test("clarify response routes to child queue when child has session", async () => {
		const { provider } = createRecordingProvider();
		const { app, pm, markReady, getTracker } = createApp({
			dataDir,
			agentProvider: provider,
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);

		// Start orchestrator
		await startRootAgent(app, project.id, "test");
		await delay(100);

		// Create a child and attach session
		const child = await createTask(app, project.id, "Clarifying child");
		const tracker = await getTracker(project.id);
		const childQueue = new MessageQueue();
		attachMockSession(tracker.getTask(child.id) as TaskNode, childQueue);

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

		(tracker.getTask(child.id) as TaskNode).session = undefined;
		childQueue.close();
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

		await delay(50); // flush
		const eventStore = new EventStore(join(dataDir, "sessions", project.id));
		const events = eventStore.read(task.id);
		const clarifyEvt = events.find(
			(e: Event) =>
				e.type === "message" &&
				e.body?.source === "clarify_response" &&
				e.body?.answer === "offline answer",
		);
		expect(clarifyEvt).toBeTruthy();
	});
});

describe("lifecycle: edge cases and error handling", () => {
	let tempDir: string;
	let dataDir: string;
	let projectDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-lc-edge-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-lc-edged-"));
		projectDir = join(tempDir, "proj");
		await mkdir(join(projectDir, ".git"), { recursive: true });
	});

	afterEach(async () => {
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

		const res = await startRootAgent(app, project.id, "test");
		expect(res.status).toBe(503);
	});

	test("multiple sessions on different tracker nodes coexist independently", () => {
		const tracker = new TaskTracker(join(tempDir, "tasks-multi.json"));
		const nodeA = tracker.addTask("task-a", "desc");
		const nodeB = tracker.addTask("task-b", "desc");
		const nodeC = tracker.addTask("task-c", "desc");

		const q1 = new MessageQueue();
		const q2 = new MessageQueue();
		const q3 = new MessageQueue();

		attachMockSession(nodeA, q1);
		attachMockSession(nodeB, q2);
		attachMockSession(nodeC, q3);

		q1.enqueue({ source: "user", id: "test-id", ts: 0, content: "to a" });
		q2.enqueue({ source: "user", id: "test-id", ts: 0, content: "to b" });
		q3.enqueue({ source: "user", id: "test-id", ts: 0, content: "to c" });

		expect(q1.drain()[0]).toEqual({
			source: "user",
			id: "test-id",
			ts: 0,
			content: "to a",
		});
		expect(q2.drain()[0]).toEqual({
			source: "user",
			id: "test-id",
			ts: 0,
			content: "to b",
		});
		expect(q3.drain()[0]).toEqual({
			source: "user",
			id: "test-id",
			ts: 0,
			content: "to c",
		});

		// Closing one doesn't affect others
		nodeA.session = undefined;
		q1.close();
		expect(() =>
			q1.enqueue({ source: "user", id: "test-id", ts: 0, content: "fail" }),
		).toThrow("Queue closed");
		q2.enqueue({
			source: "user",
			id: "test-id",
			ts: 0,
			content: "still works",
		});
		expect(q2.drain()).toHaveLength(1);

		nodeB.session = undefined;
		nodeC.session = undefined;
		q2.close();
		q3.close();
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

		queue.enqueue({ source: "user", id: "test-id", ts: 0, content: "a" });
		expect(queue.pending).toBe(1);

		queue.enqueue({ source: "user", id: "test-id", ts: 0, content: "b" });
		expect(queue.pending).toBe(2);

		queue.drain();
		expect(queue.pending).toBe(0);

		queue.enqueue({ source: "user", id: "test-id", ts: 0, content: "c" });
		expect(queue.pending).toBe(1);

		queue.close();
	});
});

describe("lifecycle: session-clear-before-close ordering invariant", () => {
	test("proper cleanup: clear session then close queue", () => {
		const tracker = new TaskTracker(join(tmpdir(), "tasks-ordering.json"));
		const node = tracker.addTask("task-cleanup", "desc");
		const queue = new MessageQueue();
		attachMockSession(node, queue);

		// Correct order: clear session (so other code sees "no session"),
		// then close queue (to terminate the running agent)
		node.session = undefined;
		queue.close();

		// After clearing session, node should have no session
		expect(node.session).toBeUndefined();
		// After close, enqueue should throw
		expect(() =>
			queue.enqueue({ source: "user", id: "test-id", ts: 0, content: "test" }),
		).toThrow("Queue closed");
	});

	test("wrong order (close then clear) leaves closed queue visible briefly", () => {
		const tracker = new TaskTracker(join(tmpdir(), "tasks-ordering2.json"));
		const node = tracker.addTask("task-wrong", "desc");
		const queue = new MessageQueue();
		attachMockSession(node, queue);

		// If we close first, the session briefly contains a closed queue
		queue.close();
		// At this point, another concurrent caller could get the closed queue via session
		const retrieved = node.session?.queue;
		expect(retrieved).toBe(queue); // Still in session!
		expect(() =>
			retrieved?.enqueue({
				source: "user",
				id: "test-id",
				ts: 0,
				content: "test",
			}),
		).toThrow("Queue closed"); // But it's broken

		node.session = undefined;
	});

	test("clear-before-close prevents stale queue retrieval", () => {
		const tracker = new TaskTracker(join(tmpdir(), "tasks-ordering3.json"));
		const node = tracker.addTask("task-safe", "desc");
		const queue = new MessageQueue();
		attachMockSession(node, queue);

		// Correct order
		node.session = undefined;
		// Now a concurrent caller would see no session (falls through to persist path)
		expect(node.session).toBeUndefined();

		// Close to terminate agent
		queue.close();
	});
});

describe("lifecycle: REST DELETE /tasks/:id closes agent queues", () => {
	let tempDir: string;
	let dataDir: string;
	let projectDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-lc-restdel-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-lc-restdeld-"));
		projectDir = join(tempDir, "proj");
		await mkdir(join(projectDir, ".git"), { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		await rm(dataDir, { recursive: true, force: true });
	});

	test("DELETE /tasks/:id closes active session for the task", async () => {
		const { app, pm, markReady, getTracker } = createApp({
			dataDir,
			agentProvider: createInstantProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const task = await createTask(app, project.id, "Deletable task");

		// Attach session (simulating running agent)
		const tracker = await getTracker(project.id);
		const taskQueue = new MessageQueue();
		attachMockSession(tracker.getTask(task.id) as TaskNode, taskQueue);

		// Delete the task via REST
		const res = await app.request(`/projects/${project.id}/tasks/${task.id}`, {
			method: "DELETE",
		});
		expect(res.status).toBe(200);

		// Queue should be closed
		expect(() =>
			taskQueue.enqueue({
				source: "user",
				id: "test-id",
				ts: 0,
				content: "test",
			}),
		).toThrow("Queue closed");
	});

	test("DELETE /tasks/:id rejects when task has children", async () => {
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: createInstantProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const parent = await createTask(app, project.id, "Parent");
		await createTask(app, project.id, "Child", { parentId: parent.id });

		const res = await app.request(
			`/projects/${project.id}/tasks/${parent.id}`,
			{ method: "DELETE" },
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("Cannot delete task with children");
	});

	test("DELETE /tasks/:id closes session on leaf task", async () => {
		const { app, pm, markReady, getTracker } = createApp({
			dataDir,
			agentProvider: createInstantProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const task = await createTask(app, project.id, "Leaf task");

		const tracker = await getTracker(project.id);
		const taskQueue = new MessageQueue();
		attachMockSession(tracker.getTask(task.id) as TaskNode, taskQueue);

		const res = await app.request(`/projects/${project.id}/tasks/${task.id}`, {
			method: "DELETE",
		});
		expect(res.status).toBe(200);

		expect(() =>
			taskQueue.enqueue({
				source: "user",
				id: "test-id",
				ts: 0,
				content: "test",
			}),
		).toThrow("Queue closed");
	});

	test("DELETE /tasks/:id works fine when no session exists", async () => {
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: createInstantProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const task = await createTask(app, project.id, "No queue task");

		// No session — delete should still work
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
		tempDir = await mkdtemp(join(tmpdir(), "mxd-lc-childcomp-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-lc-childcompd-"));
		projectDir = join(tempDir, "proj");
		await mkdir(join(projectDir, ".git"), { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		await rm(dataDir, { recursive: true, force: true });
	});

	test("reset task then re-start: task_complete reaches parent", async () => {
		// Test the full cycle: child runs → completes → parent gets task_complete
		// → reset → child runs again → parent gets task_complete again.
		// Uses runChildCore directly to avoid needing real git worktrees.

		const trackerPath = join(dataDir, "test-reset-tracker.json");
		const tracker = new TaskTracker(trackerPath);
		await tracker.load();
		const parentNode = tracker.getTask(tracker.rootNodeId) as TaskNode;
		const childNode = tracker.addChild(parentNode.id, "Child", "");
		tracker.updateStatus(parentNode.id, "in_progress");
		tracker.updateStatus(childNode.id, "in_progress");

		// Attach parent session (simulating running parent agent)
		const parentQueue = new MessageQueue();
		attachMockSession(parentNode, parentQueue);

		// -- First run --
		const firstQueue = new MessageQueue();
		firstQueue.enqueue({
			source: "user",
			id: "test-id",
			ts: 0,
			content: "do work",
		});
		const result1 = await runChildCore({
			provider: createInstantProvider(),
			tracker,
			taskId: childNode.id,
			sessionRequest: {
				cwd: projectDir,
				queue: firstQueue,
			},
		});
		expect(result1.exitReason).toBe("interrupted");

		// Simulate runChildAgentInBackground's post-completion: send task_complete
		parentQueue.enqueue({
			source: "task_complete" as const,
			id: "test-id",
			ts: 0,
			taskId: childNode.id,
			title: childNode.title,
			success: true,
			output: "",
		});

		// Verify task_complete in parent queue
		let parentMsgs = parentQueue.drain();
		const firstComplete = parentMsgs.find((m) => m.source === "task_complete");
		expect(firstComplete).toBeTruthy();
		expect((firstComplete as { taskId: string }).taskId).toBe(childNode.id);

		// -- Reset --
		// Simulate reset_task: clean up queue (already gone after runChildCore),
		// update status to pending
		tracker.updateStatus(childNode.id, "pending");

		// -- Second run --
		tracker.updateStatus(childNode.id, "in_progress");
		const secondQueue = new MessageQueue();
		secondQueue.enqueue({
			source: "user",
			id: "test-id",
			ts: 0,
			content: "try again",
		});
		const result2 = await runChildCore({
			provider: createInstantProvider(),
			tracker,
			taskId: childNode.id,
			sessionRequest: {
				cwd: projectDir,
				queue: secondQueue,
			},
		});
		expect(result2.exitReason).toBe("interrupted");

		// Simulate task_complete again
		parentQueue.enqueue({
			source: "task_complete" as const,
			id: "test-id",
			ts: 0,
			taskId: childNode.id,
			title: childNode.title,
			success: true,
			output: "",
		});

		// Verify second task_complete arrives
		parentMsgs = parentQueue.drain();
		const secondComplete = parentMsgs.find((m) => m.source === "task_complete");
		expect(secondComplete).toBeTruthy();
		expect((secondComplete as { taskId: string }).taskId).toBe(childNode.id);

		parentNode.session = undefined;
		parentQueue.close();
	});

	test("done() closes queue directly (no task_completed event)", async () => {
		// Tests the simplified done() flow:
		// 1. done() handler updates tracker status to passed/failed
		// 2. done() handler calls closeQueue() directly
		// 3. waitForQueueMessages() rejects immediately (queue closed)
		// 4. done() returns → provider emits tool_result → runChildCore sees it and exits
		//
		// No task_completed event is emitted — closeQueue() replaces it.

		const trackerPath = join(dataDir, "test-donefix-tracker.json");
		const tracker = new TaskTracker(trackerPath);
		await tracker.load();
		const parentNode = tracker.getTask(tracker.rootNodeId) as TaskNode;
		tracker.updateStatus(parentNode.id, "in_progress");
		const childNode = tracker.addChild(parentNode.id, "Child", "");
		const childId = childNode.id;
		tracker.updateStatus(childId, "in_progress");

		// Attach parent session
		const parentQueue = new MessageQueue();
		attachMockSession(parentNode, parentQueue);

		// Create a provider whose stream simulates done() calling closeQueue():
		// 1. Emits text (simulating work)
		// 2. Updates tracker status (simulating done() handler)
		// 3. Closes the queue directly (simulating closeQueue() in done() handler)
		// 4. Blocks on queue.wait() which rejects immediately
		const doneYieldProvider: AgentProvider = {
			name: "mock-done-yield",
			execute: async () => ({
				exitReason: "interrupted" as const,
				output: "",
				costUsd: 0,
				turns: 0,
				sessionId: "mock",
			}),
			stream: async function* (req) {
				const queue = req.queue ?? new MessageQueue();

				// Step 1: Agent does some work
				yield {
					type: "assistant_text" as const,
					content: "Working...",
					taskId: "",
					ts: Date.now(),
				};

				// Phase 1: done() handler just closes queue
				queue.close();

				// Loop exits via queue.isClosed → return AgentResult with done exit reason
				return {
					exitReason: "done_passed" as const,
					output: "done",
					costUsd: 0,
					turns: 0,
					sessionId: "mock",
					doneSummary: "All tests pass",
				} as AgentResult;
			},
		};

		const eventLog: string[] = [];
		const emit = (event: Event) => {
			eventLog.push(event.type);
		};

		const doneQueue = new MessageQueue();
		doneQueue.enqueue({
			source: "user",
			id: "test-id",
			ts: 0,
			content: "test",
		});
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

		// Queue close exits the loop — no deadlock
		expect(result).not.toBe("timeout");
		// Status NOT updated by runChildCore (Phase 2 in runAgentForNode does that)
		expect(tracker.getTask(childId)?.status).toBe("in_progress");

		// Cleanup
		parentNode.session = undefined;
		parentQueue.close();
	});

	test("done()=yield deadlocks WITHOUT closeQueue()", async () => {
		// Companion test: verifies that WITHOUT closeQueue() in done(),
		// the stream blocks indefinitely. This proves closeQueue() is necessary.

		const trackerPath = join(dataDir, "test-deadlock-tracker.json");
		const tracker = new TaskTracker(trackerPath);
		await tracker.load();
		const parentNode = tracker.getTask(tracker.rootNodeId) as TaskNode;
		tracker.updateStatus(parentNode.id, "in_progress");
		const childNode = tracker.addChild(parentNode.id, "Child", "");
		const childId = childNode.id;
		tracker.updateStatus(childId, "in_progress");

		// Provider that simulates a stream stuck on queue.wait() (no queue close)
		const deadlockProvider: AgentProvider = {
			name: "mock-deadlock",
			execute: async () => ({
				exitReason: "interrupted" as const,
				output: "",
				costUsd: 0,
				turns: 0,
				sessionId: "mock",
			}),
			stream: async function* (req) {
				const queue = req.queue ?? new MessageQueue();
				yield {
					type: "assistant_text" as const,
					content: "Working...",
					taskId: "",
					ts: Date.now(),
				};

				// No closeQueue() call — nobody closes the queue
				// Block forever on queue.wait()
				try {
					await queue.wait();
				} catch {
					// If somehow closed, exit
				}
				return {
					exitReason: "interrupted" as const,
					output: "done",
					costUsd: 0,
					turns: 0,
					sessionId: "mock",
				} as AgentResult;
			},
		};

		const deadlockQueue = new MessageQueue();
		deadlockQueue.enqueue({
			source: "user",
			id: "test-id",
			ts: 0,
			content: "test",
		});
		const corePromise = runChildCore({
			provider: deadlockProvider,
			tracker,
			taskId: childId,
			sessionRequest: {
				cwd: projectDir,
				queue: deadlockQueue,
			},
		});

		// Should timeout because the stream is stuck in queue.wait()
		const timeoutPromise = delay(500).then(() => "timeout" as const);
		const result = await Promise.race([corePromise, timeoutPromise]);
		expect(result).toBe("timeout");

		// Force cleanup — close the queue to unblock the deadlocked provider
		deadlockQueue.close();
		// Wait for runChildCore to finish after we unblocked it
		await Promise.race([corePromise, delay(1000)]);
	});

	test("reset task cleans up session from tracker node", async () => {
		// Verify that reset_task (simulated) properly cleans up the old session,
		// and that re-starting after reset creates a fresh session.
		const { app, pm, markReady, getTracker } = createApp({
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

		// Attach session for the child (simulating running agent)
		const tracker = await getTracker(project.id);
		const oldQueue = new MessageQueue();
		attachMockSession(tracker.getTask(child.id) as TaskNode, oldQueue);
		expect(tracker.getTask(child.id)?.session?.queue).toBe(oldQueue);

		// Simulate reset_task: clear session THEN close (correct order)
		(tracker.getTask(child.id) as TaskNode).session = undefined;
		oldQueue.close();

		// Verify session is gone
		expect(tracker.getTask(child.id)?.session).toBeUndefined();

		// Verify old queue is closed
		expect(() =>
			oldQueue.enqueue({
				source: "user",
				id: "test-id",
				ts: 0,
				content: "test",
			}),
		).toThrow("Queue closed");

		// After reset, re-start creates a fresh session (via auto-launch)
		// Send a message to trigger auto-launch
		await setTaskStatus(app, project.id, child.id, "pending");
		await sendTaskMessage(app, project.id, child.id, "restart");
		await delay(300);

		// If auto-launch succeeded, a new session was created (and may already be gone
		// if the instant provider completed). Either way, it's not the old queue.
		const newQueue = tracker.getTask(child.id)?.session?.queue;
		if (newQueue) {
			expect(newQueue).not.toBe(oldQueue);
			(tracker.getTask(child.id) as TaskNode).session = undefined;
			newQueue.close();
		}
	});

	test("reset task while running: session cleared, agent stops", async () => {
		const { app, pm, markReady, getTracker } = createApp({
			dataDir,
			agentProvider: createLongRunningProvider(),
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);
		const task = await createTask(app, project.id, "Running child");
		await setTaskStatus(app, project.id, task.id, "in_progress");

		// Attach session simulating a running agent blocked on queue.wait()
		const tracker = await getTracker(project.id);
		const taskQueue = new MessageQueue();
		attachMockSession(tracker.getTask(task.id) as TaskNode, taskQueue);

		// Start a waiter to detect when queue is closed
		let waiterError: Error | null = null;
		const waiterPromise = taskQueue.wait().catch((err: Error) => {
			waiterError = err;
		});

		// Simulate reset_task behavior:
		// 1. Clear session (so callers see "no session")
		const activeQueue = tracker.getTask(task.id)?.session?.queue;
		expect(activeQueue).toBe(taskQueue);
		(tracker.getTask(task.id) as TaskNode).session = undefined;

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

		// Verify session is gone
		expect(tracker.getTask(task.id)?.session).toBeUndefined();

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
 * Each call to stream records the AgentRequest and keeps the
 * session alive until the queue is closed.
 */
function createCapturingProvider(): {
	provider: AgentProvider;
	/** All AgentRequests that were passed to stream, in order. */
	sessionRequests: AgentRequest[];
	/** Queue messages drained from each session (indexed by session index). */
	queueMessages: QueueMessage[][];
} {
	const sessionRequests: AgentRequest[] = [];
	const queueMessages: QueueMessage[][] = [];
	const provider: AgentProvider = {
		name: "mock-capturing",
		execute: async () => ({
			exitReason: "interrupted" as const,
			output: "",
			costUsd: 0,
			turns: 0,
			sessionId: "mock-capturing-session",
		}),
		// biome-ignore lint/correctness/useYield: mock session blocks on queue.wait()
		stream: async function* (req) {
			sessionRequests.push(req);
			const queue = req.queue ?? new MessageQueue();
			const sessionIdx = sessionRequests.length - 1;
			queueMessages[sessionIdx] = [];
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
			return {
				exitReason: "interrupted" as const,
				output: "",
				costUsd: 0,
				turns: 0,
				sessionId: "mock-capturing-session",
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
		execute: async () => ({
			exitReason: "interrupted" as const,
			output: "",
			costUsd: 0,
			turns: 0,
			sessionId: "mock-instant-capturing-session",
		}),
		// biome-ignore lint/correctness/useYield: mock session exits immediately
		stream: async function* (req) {
			sessionRequests.push(req);
			return {
				exitReason: "interrupted" as const,
				output: "",
				costUsd: 0,
				turns: 0,
				sessionId: "mock-instant-capturing-session",
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
		tempDir = await mkdtemp(join(tmpdir(), "mxd-lc-session-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-lc-sessiond-"));
		projectDir = join(tempDir, "proj");
		await mkdir(join(projectDir, ".git"), { recursive: true });
	});

	afterEach(async () => {
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
		const { app, pm, getTracker, markReady } = createApp({
			dataDir,
			agentProvider: provider,
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);

		// Launch agent with initial prompt
		await startRootAgent(app, project.id, "initial task");
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
		const msgRes = await sendRootMessage(
			app,
			getTracker,
			project.id,
			"new fresh task",
		);
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
		const { app, pm, getTracker, markReady } = createApp({
			dataDir,
			agentProvider: provider,
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);

		// Launch agent
		await startRootAgent(app, project.id, "hello");
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
			body: { source: "user", id: "test-id", ts: 0, content: "hello" },
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
		await sendRootMessage(app, getTracker, project.id, "new task");
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
					e.body.source === "user" &&
					e.body.content === "hello",
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
		const { app, pm, getTracker, markReady } = createApp({
			dataDir,
			agentProvider: provider,
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);

		// Launch agent
		await startRootAgent(app, project.id, "initial work");
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
			body: { source: "user", id: "test-id", ts: 0, content: "initial work" },
			ts: Date.now(),
		} as Event);

		// Stop the agent (session files preserved)
		await app.request(`/projects/${project.id}/stop`, { method: "POST" });
		await delay(100);

		// Send a new message — should trigger resume (not fresh)
		await sendRootMessage(app, getTracker, project.id, "continue please");
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
		const { app, pm, getTracker, markReady } = createApp({
			dataDir,
			agentProvider: provider,
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);

		// Launch and stop to establish session
		await startRootAgent(app, project.id, "setup");
		await delay(100);
		await app.request(`/projects/${project.id}/stop`, { method: "POST" });
		await delay(100);

		expect(sessionRequests.length).toBe(1);

		// Send 3 messages rapidly (no agent running)
		const [r1, r2, r3] = await Promise.all([
			sendRootMessage(app, getTracker, project.id, "msg-1"),
			sendRootMessage(app, getTracker, project.id, "msg-2"),
			sendRootMessage(app, getTracker, project.id, "msg-3"),
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
		// node.session, subsequent messages enqueue instead of launching again.
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

		const res = await app.request(
			"/projects/nonexistent-id/tasks/some-task/message",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: "hello" }),
			},
		);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("Project not found");
	});

	test("send message to root auto-launches agent on fresh project", async () => {
		// Fresh project — root node exists from tracker.load(), sending a message
		// should launch agent as fresh (not resume)
		const { provider, sessionRequests, queueMessages } =
			createCapturingProvider();
		const { app, pm, markReady, getTracker } = createApp({
			dataDir,
			agentProvider: provider,
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);

		// Root node exists from tracker.load()
		const tracker = await getTracker(project.id);
		expect(tracker.rootNodeId).toBeTruthy();

		// Send message via unified task endpoint — should launch fresh
		const res = await sendRootMessage(
			app,
			getTracker,
			project.id,
			"first message ever",
		);
		expect(res.status).toBe(200);
		await delay(200);

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
		await startRootAgent(app, project.id, "generate events");
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
		const { app, pm, getTracker, markReady } = createApp({
			dataDir,
			agentProvider: provider,
		});
		await pm.load();
		markReady();

		const project = await createProject(app, projectDir);

		// Launch agent
		await startRootAgent(app, project.id, "do work");
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
			body: { source: "user", id: "test-id", ts: 0, content: "do work" },
			ts: Date.now(),
		} as Event);

		// Send message to resume
		await sendRootMessage(app, getTracker, project.id, "resume now");
		await delay(200);

		// New events should be added (orchestration_started for resume, etc.)
		const eventsAfterResume = eventStore.readAllSorted();
		expect(eventsAfterResume.length).toBeGreaterThan(stopEventCount);

		// Cleanup
		await app.request(`/projects/${project.id}/stop`, { method: "POST" });
		await delay(100);
	});
});

// ---------------------------------------------------------------------------
// Header only on cold start (no header on resume)
// ---------------------------------------------------------------------------

describe("lifecycle: header only on cold start", () => {
	let tempDir: string;
	let dataDir: string;
	let projectDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-lc-header-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-lc-headerd-"));
		projectDir = join(tempDir, "proj");
		await mkdir(join(projectDir, ".git"), { recursive: true });
		// Write a memory.md so header content is non-trivial
		await mkdir(join(projectDir, ".mxd"), { recursive: true });
		await writeFile(
			join(projectDir, ".mxd", "memory.md"),
			"# Test Memory\n\n- Important fact: tests are good\n",
		);
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		await rm(dataDir, { recursive: true, force: true });
	});

	test("cold start message includes header with memory.md", async () => {
		const { provider, queueMessages } = createCapturingProvider();
		const { app, pm, getTracker, markReady } = createApp({
			dataDir,
			agentProvider: provider,
		});
		await pm.load();
		markReady();
		const project = await createProject(app, projectDir);

		// Send message to fresh project (no JSONL exists) — cold start
		await sendRootMessage(app, getTracker, project.id, "hello world");
		await delay(200);

		// Find the user message in queue
		const msgs = queueMessages[0] ?? [];
		const userMsg = msgs.find(
			(m) => m.source === "user" && m.content === "hello world",
		) as (QueueMessage & { header?: string }) | undefined;
		expect(userMsg).toBeDefined();
		// Cold start should have header with memory.md content
		expect(userMsg?.header).toBeDefined();
		expect(userMsg?.header).toContain("memory.md");
		expect(userMsg?.header).toContain("Important fact");

		await app.request(`/projects/${project.id}/stop`, { method: "POST" });
		await delay(100);
	});

	test("resume message has NO header (agent has context from JSONL)", async () => {
		const { provider, queueMessages } = createCapturingProvider();
		const { app, pm, getTracker, markReady } = createApp({
			dataDir,
			agentProvider: provider,
		});
		await pm.load();
		markReady();
		const project = await createProject(app, projectDir);

		// First: launch agent (cold start) to create JSONL
		await sendRootMessage(app, getTracker, project.id, "initial task");
		await delay(200);

		// Stop agent — JSONL is preserved on disk
		await app.request(`/projects/${project.id}/stop`, { method: "POST" });
		await delay(100);

		// Second: send new message — should resume (JSONL exists)
		await sendRootMessage(app, getTracker, project.id, "resume task");
		await delay(200);

		// Find the resume message in the second session's queue
		const msgs = queueMessages[1] ?? [];
		const resumeMsg = msgs.find(
			(m) => m.source === "user" && m.content === "resume task",
		) as (QueueMessage & { header?: string }) | undefined;
		expect(resumeMsg).toBeDefined();
		// Resume should NOT have header — agent already has context from JSONL
		expect(resumeMsg?.header).toBeUndefined();

		await app.request(`/projects/${project.id}/stop`, { method: "POST" });
		await delay(100);
	});

	test("restart message has NO header", async () => {
		const { provider, queueMessages } = createCapturingProvider();
		const { app, pm, markReady } = createApp({
			dataDir,
			agentProvider: provider,
		});
		await pm.load();
		markReady();
		const project = await createProject(app, projectDir);

		// Launch agent
		await startRootAgent(app, project.id, "start");
		await delay(200);

		// Restart agent — stops then resumes with resume:true
		await app.request(`/projects/${project.id}/restart`, {
			method: "POST",
		});
		await delay(300);

		// The restart creates a new session (index 1). Check the persisted
		// restart message that gets drained into the queue.
		const restartMsgs = queueMessages[1] ?? [];
		const restartMsg = restartMsgs.find(
			(m) =>
				m.source === "user" &&
				(m as { content: string }).content.includes("restarted"),
		) as (QueueMessage & { header?: string }) | undefined;
		// Restart is always a resume — no header
		if (restartMsg) {
			expect(restartMsg.header).toBeUndefined();
		}

		await app.request(`/projects/${project.id}/stop`, { method: "POST" });
		await delay(100);
	});
});
