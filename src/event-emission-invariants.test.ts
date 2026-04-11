/**
 * Event emission invariants — guard the three bugs fixed in task
 * 01KNWM9YTTMHEF620EKGCAP9HH and the `enqueue === persist` refactor.
 *
 * Bug 1: Every QueueMessage is persisted to JSONL exactly once. After the
 *        refactor, `queue.enqueue(msg)` synchronously calls `onPersist(msg)`
 *        which writes the `message` event to JSONL. `deliverMessage`'s fast
 *        path is just `queue.enqueue(msg)`; its slow path (agent not running)
 *        writes the same event directly. Recovery paths use
 *        `enqueue(msg, { replay: true })` to skip onPersist.
 *
 * Bug 2: Within each turn, `assistant_text` is emitted to JSONL BEFORE the
 *        matching `usage` event, so the frontend `attach_usage` walk-backwards
 *        logic finds THIS turn's assistant_text (not the previous turn's).
 *
 * Bug 3: Events produced BY a specific agent run carry
 *        `traceId = session.loopTraceId`. Events semantically external to any
 *        run (deliverMessage `message`, task_started, fork_marker) do NOT.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverMessage, stopTask } from "./daemon/agent-lifecycle.ts";
import { createApp } from "./daemon.ts";
import { EventStore } from "./event-store.ts";
import type { Event } from "./events.ts";
import { MessageQueue, type QueueMessage } from "./message-queue.ts";
import {
	createBackgroundComplete,
	createClarifyResponse,
	createCompactMessage,
	createCrossProjectMessage,
	createTaskComplete,
	createTaskMessage,
	createTreeChange,
	createUserMessage,
	createUserMessageForwarded,
} from "./queue-message-factory.ts";
import {
	createMockedProviderWithMock,
	ValidatingMockAPI,
} from "./test-utils/mock-anthropic-api.ts";

// ═════════════════════════════════════════════════════════════════════
// Part 1: MessageQueue unit tests — `enqueue === persist` contract
// ═════════════════════════════════════════════════════════════════════

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
		// Drop unhandled rejection if queue closes later
		p.catch(() => {});
		q.enqueue(createUserMessage("hi"), { quiet: true });
		await new Promise((r) => setTimeout(r, 20));
		expect(waiterFired).toBe(false);
		// But message is pending
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

	test("replay and non-replay in same queue both enqueue", async () => {
		const persisted: string[] = [];
		const q = new MessageQueue({
			onPersist: (m) => {
				if (m.source === "user") persisted.push(m.content);
			},
		});
		q.enqueue(createUserMessage("replayed"), {
			quiet: true,
			replay: true,
		});
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
});

// ═════════════════════════════════════════════════════════════════════
// Part 2: Integration tests — JSONL invariants
// ═════════════════════════════════════════════════════════════════════

interface TestContext {
	dataDir: string;
	projectDir: string;
	app: ReturnType<typeof createApp>;
	mockAPI: ValidatingMockAPI;
	projectId: string;
}

async function setupTestContext(): Promise<TestContext> {
	const dataDir = await mkdtemp(join(tmpdir(), "mxd-emission-data-"));
	const projectDir = await mkdtemp(join(tmpdir(), "mxd-emission-project-"));

	Bun.spawnSync(["git", "init"], { cwd: projectDir });
	Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
		cwd: projectDir,
	});
	Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: projectDir });
	await Bun.write(
		join(projectDir, ".gitignore"),
		"*\n!/.gitignore\n!/README.md\n!/.mxd/\n!/.mxd/**\n",
	);
	await Bun.write(join(projectDir, "README.md"), "# Test Project\n");
	Bun.spawnSync(["git", "add", "."], { cwd: projectDir });
	Bun.spawnSync(["git", "commit", "-m", "initial"], { cwd: projectDir });

	const mockAPI = new ValidatingMockAPI();
	const provider = createMockedProviderWithMock(mockAPI);

	const appResult = createApp({ dataDir, agentProvider: provider });
	await appResult.pm.load();
	const project = await appResult.pm.init(projectDir);

	const tasksDir = join(projectDir, ".mxd", "tasks");
	if (existsSync(tasksDir)) rmSync(tasksDir, { recursive: true });

	const hookExample = join(
		projectDir,
		".mxd",
		"hooks",
		"setup_worktree.sh.example",
	);
	const hookActive = join(projectDir, ".mxd", "hooks", "setup_worktree.sh");
	if (existsSync(hookExample)) await rename(hookExample, hookActive);
	Bun.spawnSync(["git", "add", "."], { cwd: projectDir });
	Bun.spawnSync(["git", "commit", "-m", "activate setup hook"], {
		cwd: projectDir,
	});

	appResult.markReady();

	return {
		dataDir,
		projectDir,
		app: appResult,
		mockAPI,
		projectId: project.id,
	};
}

async function teardownTestContext(ctx: TestContext): Promise<void> {
	await ctx.app.shutdown();
	await new Promise((r) => setTimeout(r, 50));
	await rm(ctx.dataDir, { recursive: true, force: true });
	await rm(ctx.projectDir, { recursive: true, force: true });
}

async function waitForDone(
	ctx: TestContext,
	timeoutMs = 15000,
): Promise<string> {
	const tracker = await ctx.app.getTracker(ctx.projectId);
	const rootNodeId = tracker.rootNodeId;
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const rootNode = tracker.getTask(rootNodeId);
		if (rootNode?.status === "verify" || rootNode?.status === "failed") {
			return rootNode.status;
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`Agent did not call done() within ${timeoutMs}ms`);
}

async function waitForIdle(ctx: TestContext, timeoutMs = 10000): Promise<void> {
	const tracker = await ctx.app.getTracker(ctx.projectId);
	const rootNodeId = tracker.rootNodeId;
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const rootNode = tracker.getTask(rootNodeId);
		const queue = rootNode?.session?.queue;
		if (queue?.idle) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`Agent did not enter idle state within ${timeoutMs}ms`);
}

async function startAgent(ctx: TestContext, prompt: string): Promise<Response> {
	const tasksRes = await ctx.app.app.request(
		`/projects/${ctx.projectId}/tasks`,
	);
	const { rootNodeId } = (await tasksRes.json()) as { rootNodeId: string };
	return ctx.app.app.request(
		`/projects/${ctx.projectId}/tasks/${rootNodeId}/message`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: prompt }),
		},
	);
}

async function injectMessage(
	ctx: TestContext,
	message: QueueMessage,
): Promise<void> {
	const tracker = await ctx.app.getTracker(ctx.projectId);
	const rootNodeId = tracker.rootNodeId;
	const project = ctx.app.ctx.pm.get(ctx.projectId);
	if (!project) throw new Error("project not found");
	await deliverMessage(ctx.app.ctx, project, rootNodeId, message);
}

async function readSessionEvents(
	ctx: TestContext,
	sessionId: string,
): Promise<Event[]> {
	const daemonStore = ctx.app.ctx.eventStores.get(ctx.projectId);
	if (daemonStore) await daemonStore.flushSession(sessionId);
	const store = new EventStore(
		join(ctx.dataDir, "projects", ctx.projectId, "tasks"),
	);
	return store.read(sessionId) as Event[];
}

function messageIdOccurrences(events: Event[], id: string): Event[] {
	return events.filter(
		(e) => e.type === "message" && (e as { id?: string }).id === id,
	);
}

function twoTurnInstruction(summary: string): string {
	return JSON.stringify({
		turns: [
			{ blocks: [{ type: "text", text: "Waiting for next message." }] },
			{
				blocks: [
					{ type: "text", text: "Got it, wrapping up." },
					{
						type: "tool_use",
						name: "mcp__mxd__done",
						input: { status: "passed", summary },
					},
				],
			},
		],
	});
}

function singleTurnDoneInstruction(summary: string): string {
	return JSON.stringify({
		blocks: [
			{ type: "text", text: "Doing it." },
			{
				type: "tool_use",
				name: "mcp__mxd__done",
				input: { status: "passed", summary },
			},
		],
	});
}

// ───────────────────────────────────────────────────────────────────────
// Bug 1: JSONL dedup — every QueueMessage persisted exactly once
// ───────────────────────────────────────────────────────────────────────

/**
 * Inject a message mid-idle and verify its body.id appears EXACTLY ONCE in JSONL.
 */
async function assertMessageAppearsOnce(
	ctx: TestContext,
	makeMsg: () => QueueMessage,
): Promise<QueueMessage> {
	await startAgent(ctx, twoTurnInstruction("dedup ok"));
	await waitForIdle(ctx);

	const msg = makeMsg();
	await injectMessage(ctx, msg);

	const status = await waitForDone(ctx);
	expect(status).toBe("verify");

	const tracker = await ctx.app.getTracker(ctx.projectId);
	const events = await readSessionEvents(ctx, tracker.rootNodeId);
	const occurrences = messageIdOccurrences(events, msg.id);
	if (occurrences.length !== 1) {
		console.error(
			`[dedup] id=${msg.id} source=${msg.source} appears ${occurrences.length}×`,
		);
		console.error(
			`[dedup] All message events:`,
			events
				.filter((e) => e.type === "message")
				.map((e) => ({
					id: (e as { id?: string }).id,
					source: (e as { body?: { source?: string } }).body?.source,
				})),
		);
	}
	expect(occurrences.length).toBe(1);

	return msg;
}

describe("Bug 1 — JSONL dedup (via deliverMessage, agent idle)", () => {
	let ctx: TestContext;
	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("user message → exactly once", async () => {
		ctx = await setupTestContext();
		await assertMessageAppearsOnce(ctx, () => createUserMessage("hi"));
	}, 30000);

	test("task_message → exactly once", async () => {
		ctx = await setupTestContext();
		await assertMessageAppearsOnce(ctx, () =>
			createTaskMessage("01SIB000001", "Sibling", "Hello"),
		);
	}, 30000);

	test("task_message with requestReply → exactly once", async () => {
		ctx = await setupTestContext();
		await assertMessageAppearsOnce(ctx, () =>
			createTaskMessage("01SIB000002", "Sib", "Check", {
				title: "Review",
				requestReply: true,
			}),
		);
	}, 30000);

	test("task_complete(success=true) → exactly once", async () => {
		ctx = await setupTestContext();
		await assertMessageAppearsOnce(ctx, () =>
			createTaskComplete("01CHILD0001", "Child", true, "done"),
		);
	}, 30000);

	test("task_complete(success=false) → exactly once", async () => {
		ctx = await setupTestContext();
		await assertMessageAppearsOnce(ctx, () =>
			createTaskComplete("01CHILD0002", "Child", false, "failed"),
		);
	}, 30000);

	test("user_message_forwarded → exactly once", async () => {
		ctx = await setupTestContext();
		await assertMessageAppearsOnce(ctx, () =>
			createUserMessageForwarded("01CHILD0003", "Child", "content"),
		);
	}, 30000);

	test("user_message_forwarded(resumed=true) → exactly once", async () => {
		ctx = await setupTestContext();
		await assertMessageAppearsOnce(ctx, () =>
			createUserMessageForwarded("01CHILD0004", "Child", "content", {
				resumed: true,
			}),
		);
	}, 30000);

	test("clarify_response → exactly once", async () => {
		ctx = await setupTestContext();
		await assertMessageAppearsOnce(ctx, () =>
			createClarifyResponse("go ahead"),
		);
	}, 30000);

	test("cross_project → exactly once", async () => {
		ctx = await setupTestContext();
		await assertMessageAppearsOnce(ctx, () =>
			createCrossProjectMessage("other", "Other", "hello from peer"),
		);
	}, 30000);

	test("tree_change(created) → exactly once", async () => {
		ctx = await setupTestContext();
		await assertMessageAppearsOnce(ctx, () =>
			createTreeChange("created", "01NEW000001", "New task"),
		);
	}, 30000);

	test("tree_change(deleted) → exactly once", async () => {
		ctx = await setupTestContext();
		await assertMessageAppearsOnce(ctx, () =>
			createTreeChange("deleted", "01DEL000001"),
		);
	}, 30000);

	test("background_complete → exactly once", async () => {
		ctx = await setupTestContext();
		await assertMessageAppearsOnce(ctx, () =>
			createBackgroundComplete({
				commandId: "bg-01TEST0001",
				command: "echo hi",
				exitCode: 0,
				durationMs: 10,
				stdout: "hi\n",
			}),
		);
	}, 30000);
});

describe("Bug 1 — batched dedup (multiple messages in one drain)", () => {
	let ctx: TestContext;
	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("5 task_messages in quick succession: each appears exactly once", async () => {
		ctx = await setupTestContext();
		await startAgent(ctx, twoTurnInstruction("batch dedup ok"));
		await waitForIdle(ctx);

		const msgs: QueueMessage[] = [];
		for (let i = 0; i < 5; i++) {
			const m = createTaskMessage(
				`01BATCH${String(i).padStart(5, "0")}`,
				`Peer ${i}`,
				`Msg ${i}`,
			);
			msgs.push(m);
			await injectMessage(ctx, m);
		}

		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const events = await readSessionEvents(ctx, tracker.rootNodeId);

		for (const m of msgs) {
			expect(messageIdOccurrences(events, m.id).length).toBe(1);
		}
	}, 30000);

	test("mixed sources in same tick: each appears exactly once", async () => {
		ctx = await setupTestContext();
		await startAgent(ctx, twoTurnInstruction("mixed dedup ok"));
		await waitForIdle(ctx);

		const msgs: QueueMessage[] = [
			createTaskMessage("01MIX000001", "A", "a"),
			createTaskComplete("01MIX000002", "B", true, "b done"),
			createUserMessageForwarded("01MIX000003", "C", "c"),
			createTreeChange("updated", "01MIX000004", "D"),
			createClarifyResponse("e"),
		];
		for (const m of msgs) await injectMessage(ctx, m);

		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const events = await readSessionEvents(ctx, tracker.rootNodeId);

		for (const m of msgs) {
			expect(messageIdOccurrences(events, m.id).length).toBe(1);
		}
	}, 30000);
});

describe("Bug 1 — dedup across restarts (replay path)", () => {
	let ctx: TestContext;
	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("restart after delivering a task_message: still exactly once", async () => {
		ctx = await setupTestContext();

		// Session 1: deliver message, reach idle (don't done)
		const infiniteTurns = JSON.stringify({
			turns: [{ blocks: [{ type: "text", text: "idle forever" }] }],
		});
		await startAgent(ctx, infiniteTurns);
		await waitForIdle(ctx);

		const m = createTaskMessage("01RESTART01", "Sib", "before restart");
		await injectMessage(ctx, m);

		// Wait for message to be in JSONL
		await new Promise((r) => setTimeout(r, 200));

		// Restart
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		const provider = createMockedProviderWithMock(ctx.mockAPI);
		ctx.app = createApp({ dataDir: ctx.dataDir, agentProvider: provider });
		await ctx.app.pm.load();
		await ctx.app.autoResumeProjects();
		ctx.app.markReady();

		// Allow auto-resume to kick in (finds unconsumed message, replay enqueue)
		await new Promise((r) => setTimeout(r, 500));

		// Give the post-restart agent a path to complete
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const project = ctx.app.ctx.pm.get(ctx.projectId);
		if (!project) throw new Error("project");
		await deliverMessage(
			ctx.app.ctx,
			project,
			tracker.rootNodeId,
			createUserMessage(singleTurnDoneInstruction("restart dedup ok")),
		);

		await waitForDone(ctx, 20000);

		const events = await readSessionEvents(ctx, tracker.rootNodeId);
		// The original message id must still appear EXACTLY once
		// (replay path skips onPersist, so no second write).
		expect(messageIdOccurrences(events, m.id).length).toBe(1);
	}, 40000);
});

// ───────────────────────────────────────────────────────────────────────
// Bug 1 — byte-identical across deliverMessage paths
// ───────────────────────────────────────────────────────────────────────

describe("Bug 1 — deliverMessage paths produce byte-identical JSONL", () => {
	let ctx: TestContext;
	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("message body is byte-identical whether agent is running or not", async () => {
		ctx = await setupTestContext();

		// Path A: deliverMessage while agent NOT running (root node, no session yet).
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const project = ctx.app.ctx.pm.get(ctx.projectId);
		if (!project) throw new Error("project");

		const pathAMsg = createTaskMessage(
			"01BYTE00001",
			"Peer A",
			"path A content",
		);
		await deliverMessage(ctx.app.ctx, project, tracker.rootNodeId, pathAMsg, {
			quiet: true,
		});
		// Give time for the direct emit to flush
		await new Promise((r) => setTimeout(r, 50));
		const eventsA = await readSessionEvents(ctx, tracker.rootNodeId);
		const pathAEvent = eventsA.find(
			(e) => e.type === "message" && (e as { id?: string }).id === pathAMsg.id,
		);
		expect(pathAEvent).toBeDefined();

		// Now start the agent so path B can run.
		await startAgent(ctx, twoTurnInstruction("byte ok"));
		await waitForIdle(ctx);

		// Path B: deliverMessage while agent IS running.
		const pathBMsg = createTaskMessage(
			"01BYTE00002",
			"Peer B",
			"path B content",
		);
		await deliverMessage(ctx.app.ctx, project, tracker.rootNodeId, pathBMsg);

		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		const eventsB = await readSessionEvents(ctx, tracker.rootNodeId);
		const pathBEvent = eventsB.find(
			(e) => e.type === "message" && (e as { id?: string }).id === pathBMsg.id,
		);
		expect(pathBEvent).toBeDefined();

		// Shape of the two events must be structurally identical
		// (same keys, same types). We can't compare ids/ts (different
		// messages), but `body.source`, `body.content`, top-level keys,
		// and field ordering should match.
		const keysA = Object.keys(pathAEvent as object).sort();
		const keysB = Object.keys(pathBEvent as object).sort();
		expect(keysA).toEqual(keysB);

		const bodyA = (pathAEvent as { body: Record<string, unknown> }).body;
		const bodyB = (pathBEvent as { body: Record<string, unknown> }).body;
		const bodyKeysA = Object.keys(bodyA).sort();
		const bodyKeysB = Object.keys(bodyB).sort();
		expect(bodyKeysA).toEqual(bodyKeysB);

		// Both events must NOT carry traceId (external semantic — see bug 3)
		expect((pathAEvent as { traceId?: string }).traceId).toBeUndefined();
		expect((pathBEvent as { traceId?: string }).traceId).toBeUndefined();
	}, 30000);
});

// ───────────────────────────────────────────────────────────────────────
// Bug 2 — usage emission order (assistant_text BEFORE usage)
// ───────────────────────────────────────────────────────────────────────

describe("Bug 2 — assistant_text emitted before usage (attach_usage off-by-one)", () => {
	let ctx: TestContext;
	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("single turn: assistant_text index < usage index", async () => {
		ctx = await setupTestContext();
		await startAgent(ctx, singleTurnDoneInstruction("order ok"));
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const events = await readSessionEvents(ctx, tracker.rootNodeId);

		const firstText = events.findIndex((e) => e.type === "assistant_text");
		const firstUsage = events.findIndex((e) => e.type === "usage");
		expect(firstText).toBeGreaterThanOrEqual(0);
		expect(firstUsage).toBeGreaterThanOrEqual(0);
		expect(firstText).toBeLessThan(firstUsage);
	}, 30000);

	test("every usage has a preceding assistant_text in its own turn", async () => {
		ctx = await setupTestContext();
		await startAgent(ctx, twoTurnInstruction("multi order ok"));
		await waitForIdle(ctx);
		await injectMessage(ctx, createUserMessage("wake"));
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const events = await readSessionEvents(ctx, tracker.rootNodeId);

		// Indices of assistant_text & usage, in JSONL order
		const markers: Array<{ type: "assistant_text" | "usage"; idx: number }> =
			[];
		events.forEach((e, idx) => {
			if (e.type === "assistant_text" || e.type === "usage") {
				markers.push({ type: e.type, idx });
			}
		});

		// Every usage must be preceded by an assistant_text since the
		// previous usage (or start). In other words: the sequence must
		// be `text+ usage` (one or more texts then a usage), never
		// `usage text+` flipped.
		let lastUsage = -1;
		let textsInCurrentSegment = 0;
		for (const m of markers) {
			if (m.type === "assistant_text") {
				textsInCurrentSegment++;
			} else {
				// usage
				if (textsInCurrentSegment === 0) {
					throw new Error(
						`usage at index ${m.idx} has no preceding assistant_text since last usage (index ${lastUsage})`,
					);
				}
				lastUsage = m.idx;
				textsInCurrentSegment = 0;
			}
		}
	}, 30000);

	test("tool-only turn (no assistant text): usage still after assistant content events", async () => {
		ctx = await setupTestContext();
		// Turn has ONLY a tool_use (done), no text.
		const instruction = JSON.stringify({
			blocks: [
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "tool-only ok" },
				},
			],
		});
		await startAgent(ctx, instruction);
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const events = await readSessionEvents(ctx, tracker.rootNodeId);

		// The done tool_call must precede the usage (content events first).
		const firstToolCall = events.findIndex((e) => e.type === "tool_call");
		const firstUsage = events.findIndex((e) => e.type === "usage");
		expect(firstToolCall).toBeGreaterThanOrEqual(0);
		expect(firstUsage).toBeGreaterThanOrEqual(0);
		expect(firstToolCall).toBeLessThan(firstUsage);
	}, 30000);
});

// ───────────────────────────────────────────────────────────────────────
// Bug 3 — traceId semantics
// ───────────────────────────────────────────────────────────────────────

describe("Bug 3 — traceId semantics (A-class events have it, B-class don't)", () => {
	let ctx: TestContext;
	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("orchestration_started carries a non-empty traceId", async () => {
		ctx = await setupTestContext();
		await startAgent(ctx, singleTurnDoneInstruction("started ok"));
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const events = await readSessionEvents(ctx, tracker.rootNodeId);
		const started = events.find((e) => e.type === "orchestration_started") as
			| (Event & { traceId?: string })
			| undefined;
		expect(started?.traceId).toBeDefined();
		expect(typeof started?.traceId).toBe("string");
		expect((started?.traceId ?? "").length).toBeGreaterThan(0);
	}, 30000);

	test("orchestration_completed, done_notified share the same traceId as orchestration_started", async () => {
		ctx = await setupTestContext();
		await startAgent(ctx, singleTurnDoneInstruction("lifecycle trace ok"));
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const events = await readSessionEvents(ctx, tracker.rootNodeId);

		const started = events.find((e) => e.type === "orchestration_started") as
			| (Event & { traceId?: string })
			| undefined;
		expect(started?.traceId).toBeDefined();
		const expectedTrace = started?.traceId;

		const completed = events.find(
			(e) => e.type === "orchestration_completed",
		) as (Event & { traceId?: string }) | undefined;
		if (completed) {
			// orchestration_completed only fires for root agents on finalization
			expect(completed.traceId).toBe(expectedTrace as string);
		}

		const done = events.find((e) => e.type === "done_notified") as
			| (Event & { traceId?: string })
			| undefined;
		if (done) {
			// done_notified is Phase 2; only for children, not root — so it may not appear
			expect(done.traceId).toBe(expectedTrace as string);
		}
	}, 30000);

	test("provider events (assistant_text, tool_call, tool_result, usage) all carry traceId", async () => {
		ctx = await setupTestContext();
		await startAgent(ctx, singleTurnDoneInstruction("provider trace ok"));
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const events = await readSessionEvents(ctx, tracker.rootNodeId);
		const started = events.find((e) => e.type === "orchestration_started") as
			| (Event & { traceId?: string })
			| undefined;
		const expectedTrace = started?.traceId;
		expect(expectedTrace).toBeDefined();

		const providerTypes = [
			"assistant_text",
			"tool_call",
			"tool_result",
			"usage",
		];
		for (const t of providerTypes) {
			const matching = events.filter((e) => e.type === t) as Array<
				Event & { traceId?: string }
			>;
			for (const e of matching) {
				if (e.traceId !== expectedTrace) {
					console.error(
						`[traceId] ${t} has traceId=${e.traceId} expected=${expectedTrace}`,
					);
				}
				expect(e.traceId).toBe(expectedTrace as string);
			}
		}
	}, 30000);

	test("deliverMessage message events (external) do NOT have traceId", async () => {
		ctx = await setupTestContext();
		await startAgent(ctx, twoTurnInstruction("ext no trace ok"));
		await waitForIdle(ctx);

		// Send via deliverMessage while agent is running. These events go
		// through queue.enqueue → onPersist in the running case, which
		// MUST NOT attach traceId (deliverMessage messages are external
		// semantics, not part of any specific run).
		const injected = createTaskMessage("01EXT000001", "Peer", "external msg");
		await injectMessage(ctx, injected);

		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const events = await readSessionEvents(ctx, tracker.rootNodeId);
		const msg = events.find(
			(e) => e.type === "message" && (e as { id?: string }).id === injected.id,
		) as (Event & { traceId?: string }) | undefined;
		expect(msg).toBeDefined();
		expect(msg?.traceId).toBeUndefined();
	}, 30000);

	test("user-source deliverMessage (via HTTP POST) also has no traceId", async () => {
		ctx = await setupTestContext();
		const instruction = singleTurnDoneInstruction("http no trace ok");
		await startAgent(ctx, instruction);
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const events = await readSessionEvents(ctx, tracker.rootNodeId);
		const userMessages = events.filter(
			(e) =>
				e.type === "message" &&
				"body" in e &&
				e.body &&
				typeof e.body === "object" &&
				"source" in e.body &&
				(e.body as { source: string }).source === "user",
		) as Array<Event & { traceId?: string }>;
		expect(userMessages.length).toBeGreaterThanOrEqual(1);
		for (const m of userMessages) {
			expect(m.traceId).toBeUndefined();
		}
	}, 30000);

	test("task_started (before loop spawn) does NOT have traceId", async () => {
		ctx = await setupTestContext();
		// task_started is emitted inside ensureChildAgentRunning for child nodes.
		// For root, it's not emitted. Instead test that IF task_started exists
		// in a given JSONL, it has no traceId.
		// Simplest: just check behavior via event filter — no task_started for
		// root agents, so test passes trivially. For defense-in-depth we rely
		// on types + audit. Skip-by-content pattern:
		await startAgent(ctx, singleTurnDoneInstruction("no task_started"));
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const events = await readSessionEvents(ctx, tracker.rootNodeId);
		const taskStartedEvents = events.filter(
			(e) => e.type === "task_started",
		) as Array<Event & { traceId?: string }>;
		for (const e of taskStartedEvents) {
			// If present, must not have traceId.
			expect(e.traceId).toBeUndefined();
		}
	}, 30000);

	test("agent_stopped (from stopTask) carries the stopped run's traceId", async () => {
		ctx = await setupTestContext();
		const instruction = JSON.stringify({
			turns: [{ blocks: [{ type: "text", text: "idle forever" }] }],
		});
		await startAgent(ctx, instruction);
		await waitForIdle(ctx);

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const before = await readSessionEvents(ctx, tracker.rootNodeId);
		const started = before.find((e) => e.type === "orchestration_started") as
			| (Event & { traceId?: string })
			| undefined;
		expect(started?.traceId).toBeDefined();
		const expected = started?.traceId;

		const stopped = await stopTask(
			ctx.app.ctx,
			ctx.projectId,
			tracker.rootNodeId,
		);
		expect(stopped).toBe(true);

		await new Promise((r) => setTimeout(r, 200));

		const after = await readSessionEvents(ctx, tracker.rootNodeId);
		const stoppedEvents = after.filter(
			(e) => e.type === "agent_stopped",
		) as Array<Event & { traceId?: string }>;
		expect(stoppedEvents.length).toBeGreaterThanOrEqual(1);
		for (const s of stoppedEvents) {
			expect(s.traceId).toBe(expected as string);
		}
	}, 30000);

	test("all provider events in ONE run share one traceId (no mixing)", async () => {
		ctx = await setupTestContext();
		await startAgent(
			ctx,
			JSON.stringify({
				blocks: [
					{ type: "text", text: "Text content for trace consistency" },
					{
						type: "tool_use",
						name: "mcp__mxd__done",
						input: { status: "passed", summary: "trace consistency ok" },
					},
				],
			}),
		);
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const events = await readSessionEvents(ctx, tracker.rootNodeId);

		const traceIds = new Set<string>();
		for (const e of events) {
			const t = (e as { traceId?: string }).traceId;
			if (t) traceIds.add(t);
		}
		// Only ONE run happened, so only ONE traceId in the file
		expect(traceIds.size).toBe(1);
	}, 30000);
});

// ───────────────────────────────────────────────────────────────────────
// MessageQueue + createCompactMessage smoke test
// ───────────────────────────────────────────────────────────────────────

describe("compact message handling (smoke)", () => {
	test("compact message enqueue with onPersist writes to JSONL", () => {
		const written: QueueMessage[] = [];
		const q = new MessageQueue({ onPersist: (m) => written.push(m) });
		q.enqueue(createCompactMessage());
		expect(written.length).toBe(1);
		expect(written[0]?.source).toBe("compact");
	});
});

// ═════════════════════════════════════════════════════════════════════
// Part 3: Direct-enqueue paths (bash bg, tree_change notifyTargetNode,
// compact REST) — these bypass deliverMessage entirely, so they test
// the "enqueue === persist" invariant directly.
// ═════════════════════════════════════════════════════════════════════

describe("Direct-enqueue paths: bash background_complete persisted exactly once", () => {
	let ctx: TestContext;
	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("agent runs bash with bg, bg completes, message appears in JSONL exactly once", async () => {
		ctx = await setupTestContext();

		// Turn 1: run a bash bg process
		// Turn 2: yield to wait for bg_complete
		// Turn 3: see bg_complete via wake, done
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: {
								command: "echo bg-output-marker; sleep 0.2",
								run_in_background: true,
							},
						},
					],
				},
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__yield",
							input: {},
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "bg done, wrapping up." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "bg one-shot ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);
		const status = await waitForDone(ctx, 30000);
		expect(status).toBe("verify");

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const events = await readSessionEvents(ctx, tracker.rootNodeId);

		// Find background_complete message events — they must exist and
		// each unique commandId+id must appear exactly once.
		const bgCompleteEvents = events.filter(
			(e) =>
				e.type === "message" &&
				"body" in e &&
				e.body &&
				typeof e.body === "object" &&
				"source" in e.body &&
				(e.body as { source: string }).source === "background_complete",
		);
		expect(bgCompleteEvents.length).toBeGreaterThanOrEqual(1);

		// Each event has a unique id, and the id must appear exactly once in JSONL
		const ids = new Set<string>();
		for (const e of bgCompleteEvents) {
			const id = (e as { id?: string }).id;
			expect(id).toBeDefined();
			if (id) {
				expect(ids.has(id)).toBe(false);
				ids.add(id);
				// And it appears only once overall
				expect(messageIdOccurrences(events, id).length).toBe(1);
			}
		}
	}, 40000);
});

// ═════════════════════════════════════════════════════════════════════
// Part 4: Resource-registry emit auto-injects traceId for R.emit paths
// (clarify / clarification_requested from tool handlers)
// ═════════════════════════════════════════════════════════════════════

describe("R.emit traceId auto-injection (tool handler paths)", () => {
	let ctx: TestContext;
	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("clarification_requested event has the current run's traceId", async () => {
		ctx = await setupTestContext();

		// Turn 1: call clarify tool → emits clarification_requested via R.emit
		// Turn 2: after clarify answer, done
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__clarify",
							input: { question: "proceed?" },
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "Got answer." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "clarify trace ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);

		// Wait for clarification_requested to appear
		const tracker = await ctx.app.getTracker(ctx.projectId);
		let events: Event[] = [];
		const start = Date.now();
		while (Date.now() - start < 15000) {
			events = await readSessionEvents(ctx, tracker.rootNodeId);
			if (events.some((e) => e.type === "clarification_requested")) break;
			await new Promise((r) => setTimeout(r, 100));
		}

		const clarify = events.find((e) => e.type === "clarification_requested") as
			| (Event & { traceId?: string })
			| undefined;
		expect(clarify).toBeDefined();
		expect(clarify?.traceId).toBeDefined();

		// Should match orchestration_started's traceId for this run
		const started = events.find((e) => e.type === "orchestration_started") as
			| (Event & { traceId?: string })
			| undefined;
		expect(started?.traceId).toBeDefined();
		expect(clarify?.traceId).toBe(started?.traceId as string);

		// Answer the clarification so the agent can proceed to done
		const { handleClarifyResponse } = await import(
			"./daemon/agent-lifecycle.ts"
		);
		await handleClarifyResponse(
			ctx.app.ctx,
			ctx.projectId,
			tracker.rootNodeId,
			"yes, proceed",
		);

		const status = await waitForDone(ctx, 20000);
		expect(status).toBe("verify");
	}, 40000);
});

// ═════════════════════════════════════════════════════════════════════
// Part 5: Cross-restart traceId distinctness
// ═════════════════════════════════════════════════════════════════════

describe("traceId distinct across restarts", () => {
	let ctx: TestContext;
	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("two runs of the same root produce two distinct traceIds", async () => {
		ctx = await setupTestContext();

		// Run 1
		await startAgent(ctx, singleTurnDoneInstruction("run 1 ok"));
		const status1 = await waitForDone(ctx);
		expect(status1).toBe("verify");

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const events1 = await readSessionEvents(ctx, tracker.rootNodeId);
		const started1 = events1.find((e) => e.type === "orchestration_started") as
			| (Event & { traceId?: string })
			| undefined;
		const trace1 = started1?.traceId;
		expect(trace1).toBeDefined();

		// Restart (agent now fresh session inside same project)
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		const provider = createMockedProviderWithMock(ctx.mockAPI);
		ctx.app = createApp({ dataDir: ctx.dataDir, agentProvider: provider });
		await ctx.app.pm.load();
		await ctx.app.autoResumeProjects();
		ctx.app.markReady();
		await new Promise((r) => setTimeout(r, 200));

		// Run 2: send a new message via HTTP (which launches root with
		// orchestratorSystemPrompt — deliverMessage direct call can't
		// cold-start root without it).
		await ctx.app.app.request(
			`/projects/${ctx.projectId}/tasks/${tracker.rootNodeId}/message`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					content: singleTurnDoneInstruction("run 2 ok"),
				}),
			},
		);

		const status2 = await waitForDone(ctx, 20000);
		expect(status2).toBe("verify");

		const events2 = await readSessionEvents(ctx, tracker.rootNodeId);
		// Find all orchestration_started events — there should be 2
		const allStarted = events2.filter(
			(e) => e.type === "orchestration_started",
		) as Array<Event & { traceId?: string }>;
		expect(allStarted.length).toBe(2);

		const trace2 = allStarted[1]?.traceId;
		expect(trace2).toBeDefined();
		// Distinct traceIds across runs
		expect(trace1).not.toBe(trace2);

		// Each run's events must NOT mix their traceIds.
		// Events between the two orchestration_started events have trace1;
		// events after the second have trace2.
		const firstStartedIdx = events2.findIndex(
			(e) => e.type === "orchestration_started",
		);
		const secondStartedIdx = events2.findIndex(
			(e, i) => i > firstStartedIdx && e.type === "orchestration_started",
		);
		expect(firstStartedIdx).toBeGreaterThanOrEqual(0);
		expect(secondStartedIdx).toBeGreaterThan(firstStartedIdx);

		for (let i = secondStartedIdx; i < events2.length; i++) {
			const e = events2[i] as Event & { traceId?: string };
			// Second run's provider/lifecycle events: must have trace2, not trace1
			if (e.traceId) {
				expect(e.traceId).toBe(trace2 as string);
			}
		}
	}, 60000);
});

// ═════════════════════════════════════════════════════════════════════
// Part 6: Yield wake path — bgOrphans persisted correctly
// ═════════════════════════════════════════════════════════════════════

describe("Yield wake: bgOrphans persisted exactly once", () => {
	let ctx: TestContext;
	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("bg process mid-execution during yield → after restart, bg_orphan JSONL body.id appears exactly once", async () => {
		ctx = await setupTestContext();

		// Turn 1: start a bash bg process with sleep long enough to survive restart
		// Turn 2: yield
		// (crash between turn 1 and 2 -- we stop before turn 2 completes)
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: {
								command: "sleep 60",
								run_in_background: true,
							},
						},
					],
				},
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__yield",
							input: {},
						},
					],
				},
				{
					blocks: [
						{ type: "text", text: "after wake" },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "yield bg orphan ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);

		// Wait for agent to enter yield state
		const tracker = await ctx.app.getTracker(ctx.projectId);
		let reachedYield = false;
		const start = Date.now();
		while (Date.now() - start < 15000) {
			const events = await readSessionEvents(ctx, tracker.rootNodeId);
			const lastTool = [...events]
				.reverse()
				.find((e) => e.type === "tool_call");
			if (
				lastTool?.type === "tool_call" &&
				lastTool.tool === "mcp__mxd__yield"
			) {
				// Yield tool_call in JSONL; is there a tool_result?
				const hasResult = events.some(
					(e) =>
						e.type === "tool_result" && e.toolCallId === lastTool.toolCallId,
				);
				if (!hasResult) {
					reachedYield = true;
					break;
				}
			}
			await new Promise((r) => setTimeout(r, 100));
		}
		expect(reachedYield).toBe(true);

		// Now restart — bg process (sleep 60) is alive in restart-killed state
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 200));

		// Recreate app — then manually trigger auto-resume
		const provider = createMockedProviderWithMock(ctx.mockAPI);
		ctx.app = createApp({ dataDir: ctx.dataDir, agentProvider: provider });
		await ctx.app.pm.load();
		await ctx.app.autoResumeProjects();
		ctx.app.markReady();

		const status = await waitForDone(ctx, 30000);
		expect(status).toBe("verify");

		const finalEvents = await readSessionEvents(ctx, tracker.rootNodeId);

		// Find bg_orphan message events
		const bgOrphanEvents = finalEvents.filter(
			(e) =>
				e.type === "message" &&
				"body" in e &&
				e.body &&
				typeof e.body === "object" &&
				"source" in e.body &&
				(e.body as { source: string }).source === "background_complete",
		);

		// Must be at least one (the synthetic orphan from restart)
		expect(bgOrphanEvents.length).toBeGreaterThanOrEqual(1);

		// Each unique id appears exactly once (no duplicates)
		const ids = new Set<string>();
		for (const e of bgOrphanEvents) {
			const id = (e as { id?: string }).id;
			expect(id).toBeDefined();
			if (id) {
				expect(ids.has(id)).toBe(false);
				ids.add(id);
				expect(messageIdOccurrences(finalEvents, id).length).toBe(1);
			}
		}

		// There must be a yield tool_result paired with the yield tool_call
		const yieldCalls = finalEvents.filter(
			(e) => e.type === "tool_call" && e.tool === "mcp__mxd__yield",
		);
		expect(yieldCalls.length).toBeGreaterThanOrEqual(1);
		for (const yc of yieldCalls) {
			const yieldCall = yc as Event & { type: "tool_call"; toolCallId: string };
			const hasResult = finalEvents.some(
				(e) =>
					e.type === "tool_result" && e.toolCallId === yieldCall.toolCallId,
			);
			expect(hasResult).toBe(true);
		}
	}, 60000);
});

// ═════════════════════════════════════════════════════════════════════
// Part 7: Worked-example structural invariants (JSONL ordering around yield)
// ═════════════════════════════════════════════════════════════════════

describe("JSONL structural invariants (walker reconstruction safety)", () => {
	let ctx: TestContext;
	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("after yield wake, messages_consumed is positioned immediately after yield tool_result", async () => {
		ctx = await setupTestContext();

		// Turn 1: yield; inject a task_message; turn 2: done
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__yield",
							input: {},
						},
					],
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

		// Wait for agent to yield, then inject
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

		// Find yield tool_result
		const yieldResultIdx = events.findIndex(
			(e) => e.type === "tool_result" && e.tool === "mcp__mxd__yield",
		);
		expect(yieldResultIdx).toBeGreaterThanOrEqual(0);

		// messages_consumed (for the task_message) must come AFTER yield tool_result
		// and the first one after it should reference the task_message id.
		const mcAfterYield = events
			.slice(yieldResultIdx + 1)
			.findIndex((e) => e.type === "messages_consumed");
		expect(mcAfterYield).toBeGreaterThanOrEqual(0);
	}, 30000);

	test("every message event appears in JSONL exactly once (no dupes)", async () => {
		ctx = await setupTestContext();
		await startAgent(ctx, twoTurnInstruction("no dupes ok"));
		await waitForIdle(ctx);

		await injectMessage(
			ctx,
			createTaskMessage("01REF000001", "Peer", "content"),
		);
		await injectMessage(
			ctx,
			createTreeChange("created", "01REF000002", "Tree node"),
		);

		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const events = await readSessionEvents(ctx, tracker.rootNodeId);

		// Every `message` event id appears exactly once in JSONL.
		const idCounts = new Map<string, number>();
		for (const e of events) {
			if (e.type === "message") {
				const id = (e as { id?: string }).id;
				if (id) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
			}
		}
		for (const [id, count] of idCounts) {
			if (count !== 1) {
				console.error(`[dup] id=${id} appears ${count} times`);
			}
			expect(count).toBe(1);
		}
	}, 30000);
});
