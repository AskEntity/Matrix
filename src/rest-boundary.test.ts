/**
 * FIX-2 regression tests: the REST boundary must use the same shared-op
 * discipline as the MCP path. Each test below guards one bug where a REST
 * route bypassed a fix that the MCP/shared ops already had:
 *
 *  - cc#5 session leak: REST responses serialized the live `session` (full
 *    conversation history + tool defs) because `c.json` doesn't throw on it
 *    (unlike SSE's structuredClone). Every node response must stripSession.
 *  - cc#2 clear-race: `/sessions/clear` cleared JSONL WITHOUT awaiting the
 *    agent loop's exit — the loop's finally could re-pollute the file right
 *    after the clear. Must stop+await (mirrors resetTaskOp).
 *  - B-H1 delete-race: DELETE cleaned up worktree/JSONL WITHOUT stopping the
 *    live loop — destroying unmerged work, removing a worktree under a running
 *    process, and orphaning a pending done()'s Phase 2. Must stop+await.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider } from "./agent-provider.ts";
import { MessageQueue } from "./message-queue.ts";
import { getEventStore } from "./runtime/helpers.ts";
import { createMatrixApp as createApp } from "./test-utils/create-matrix-app.ts";
import { attachMockSession } from "./test-utils.ts";
import type { TaskNode } from "./types.ts";
import { ulid } from "./ulid.ts";

const mockProvider: AgentProvider = {
	name: "mock",
	execute: async () => ({
		exitReason: "interrupted" as const,
		output: "",
		costUsd: 0,
		turns: 0,
		sessionId: "mock-session",
	}),
	// biome-ignore lint/correctness/useYield: mock provider — drains then exits
	stream: async function* (req) {
		const queue = req.queue ?? new MessageQueue();
		if (queue.pending > 0) queue.drain();
		return {
			exitReason: "interrupted" as const,
			output: "",
			costUsd: 0,
			turns: 0,
			sessionId: "mock-session",
		};
	},
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("FIX-2: REST boundary shared-op discipline", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createApp>["app"];
	let ctx: ReturnType<typeof createApp>["ctx"];
	let getTracker: ReturnType<typeof createApp>["getTracker"];
	let projectId: string;
	let rootNodeId: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-restb-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-restb-data-"));
		const project = {
			id: ulid(),
			name: "rest-boundary",
			path: join(tempDir, "rest-boundary"),
		};
		const result = createApp({
			dataDir,
			agentProvider: mockProvider,
			projects: [project],
		});
		app = result.app;
		ctx = result.ctx;
		getTracker = result.getTracker;
		projectId = project.id;
		const tracker = await getTracker(projectId);
		rootNodeId = tracker.rootNodeId;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		await rm(dataDir, { recursive: true, force: true });
	});

	// ── cc#5: session leak ──

	test("GET /tasks strips the live session from every node", async () => {
		// Create a task and attach a live session (simulating a running agent).
		const tracker = await getTracker(projectId);
		const task = tracker.addChild(rootNodeId, "Running", "", {
			editedBy: "user",
		});
		await tracker.save();
		const taskNode = tracker.getTask(task.id) as TaskNode;
		attachMockSession(taskNode, new MessageQueue());
		// Sanity: the in-memory node really does carry a session right now.
		expect(taskNode.session).toBeDefined();

		const res = await app.request(`/projects/${projectId}/tasks`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			nodes: Array<TaskNode & { session?: unknown }>;
		};
		const serialized = body.nodes.find((n) => n.id === task.id);
		expect(serialized).toBeDefined();
		// The live session must NOT cross the wire.
		expect(serialized?.session).toBeUndefined();
		// Every node in the response is stripped, not just the one we attached.
		for (const n of body.nodes) {
			expect("session" in n).toBe(false);
		}
	});

	test("PATCH /tasks/:nodeId strips the live session from the response", async () => {
		const tracker = await getTracker(projectId);
		const task = tracker.addChild(rootNodeId, "Patch me", "", {
			editedBy: "user",
		});
		await tracker.save();
		const taskNode = tracker.getTask(task.id) as TaskNode;
		attachMockSession(taskNode, new MessageQueue());

		const res = await app.request(`/projects/${projectId}/tasks/${task.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Renamed" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as TaskNode & { session?: unknown };
		expect(body.title).toBe("Renamed");
		expect(body.session).toBeUndefined();
		expect("session" in body).toBe(false);
	});

	// ── cc#2: clear-race ──

	test("POST /sessions/clear awaits the running loop before clearing (JSONL stays gone)", async () => {
		const tracker = await getTracker(projectId);
		const child = tracker.addChild(rootNodeId, "Clearing", "", {
			editedBy: "user",
		});
		await tracker.save();
		const childNode = tracker.getTask(child.id) as TaskNode;
		attachMockSession(childNode, new MessageQueue());

		const eventStore = getEventStore(ctx, projectId);

		// Simulate a still-running agent loop that writes to JSONL only AFTER a
		// delay, then resolves its loop promise. stopTask must await this so the
		// late write lands BEFORE the clear (and is therefore wiped).
		let resolveLoop: (() => void) | undefined;
		const loopPromise = new Promise<void>((r) => {
			resolveLoop = r;
		});
		ctx.agentLoopPromises.set(child.id, loopPromise);
		const simulatedLoop = (async () => {
			await sleep(50);
			await eventStore.append(child.id, {
				type: "agent_start" as const,
				taskId: child.id,
				ts: Date.now(),
				resume: false,
				provider: "test",
				model: "test",
			});
			ctx.agentLoopPromises.delete(child.id);
			resolveLoop?.();
		})();

		const res = await app.request(
			`/projects/${projectId}/tasks/${child.id}/sessions/clear`,
			{ method: "POST" },
		);
		expect(res.status).toBe(200);

		await simulatedLoop;
		await eventStore.flush();

		// The loop's write happened before the clear → JSONL is empty.
		expect(eventStore.has(child.id)).toBe(false);
	});

	test("POST /sessions/clear awaits the launchingNodes-gap loop (no session yet)", async () => {
		const tracker = await getTracker(projectId);
		const child = tracker.addChild(rootNodeId, "Launching", "", {
			editedBy: "user",
		});
		await tracker.save();
		// NOTE: no session attached — the launchingNodes gap (worktree creation /
		// MCP connect in flight; loop promise exists, session does not).

		const eventStore = getEventStore(ctx, projectId);
		ctx.launchingNodes.add(child.id);
		let resolveLoop: (() => void) | undefined;
		const loopPromise = new Promise<void>((r) => {
			resolveLoop = r;
		});
		ctx.agentLoopPromises.set(child.id, loopPromise);
		const simulatedLoop = (async () => {
			await sleep(50);
			await eventStore.append(child.id, {
				type: "agent_start" as const,
				taskId: child.id,
				ts: Date.now(),
				resume: false,
				provider: "test",
				model: "test",
			});
			ctx.launchingNodes.delete(child.id);
			ctx.agentLoopPromises.delete(child.id);
			resolveLoop?.();
		})();

		const res = await app.request(
			`/projects/${projectId}/tasks/${child.id}/sessions/clear`,
			{ method: "POST" },
		);
		expect(res.status).toBe(200);

		await simulatedLoop;
		await eventStore.flush();

		expect(eventStore.has(child.id)).toBe(false);
	});

	// ── B-H1: delete-race ──

	test("DELETE /tasks/:nodeId awaits the running loop before cleanup (JSONL stays gone)", async () => {
		const tracker = await getTracker(projectId);
		const child = tracker.addChild(rootNodeId, "Deleting", "", {
			editedBy: "user",
		});
		await tracker.save();
		const childNode = tracker.getTask(child.id) as TaskNode;
		attachMockSession(childNode, new MessageQueue());

		const eventStore = getEventStore(ctx, projectId);
		let resolveLoop: (() => void) | undefined;
		const loopPromise = new Promise<void>((r) => {
			resolveLoop = r;
		});
		ctx.agentLoopPromises.set(child.id, loopPromise);
		const simulatedLoop = (async () => {
			await sleep(50);
			await eventStore.append(child.id, {
				type: "agent_start" as const,
				taskId: child.id,
				ts: Date.now(),
				resume: false,
				provider: "test",
				model: "test",
			});
			ctx.agentLoopPromises.delete(child.id);
			resolveLoop?.();
		})();

		const res = await app.request(`/projects/${projectId}/tasks/${child.id}`, {
			method: "DELETE",
		});
		expect(res.status).toBe(200);

		await simulatedLoop;
		await eventStore.flush();

		// cleanup ran AFTER loop exit → the loop's late write was wiped.
		expect(eventStore.has(child.id)).toBe(false);
		// Node is gone from the tree.
		expect(tracker.getTask(child.id)).toBeUndefined();
	});

	test("DELETE /tasks/:nodeId stops a running leaf agent's queue + session", async () => {
		const tracker = await getTracker(projectId);
		const child = tracker.addChild(rootNodeId, "Running leaf", "", {
			editedBy: "user",
		});
		await tracker.save();
		const childNode = tracker.getTask(child.id) as TaskNode;
		const queue = new MessageQueue();
		attachMockSession(childNode, queue);

		const res = await app.request(`/projects/${projectId}/tasks/${child.id}`, {
			method: "DELETE",
		});
		expect(res.status).toBe(200);

		// Queue closed (stopTask) — enqueue throws on a closed queue.
		expect(queue.isClosed).toBe(true);
		expect(childNode.session).toBeUndefined();
	});
});
