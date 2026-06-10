/**
 * FIX-7 regression tests: lifecycle guards — root delete, status validation,
 * prefix canonicalization, and REST message delivery validation.
 *
 * TDD: every test written FIRST (failing), then code fixed to pass.
 *
 * R8-C#1 — DELETE root node destroys tree
 * R8-C#2 — Status transitions unvalidated → worktree leak
 * R8-C#3 — Prefix resolution split-brain (deliverMessage uses raw prefix)
 * R8-C#4 — REST /message + /clarify accept nonexistent/folder ids
 * R8-C#5 — No draft guard on REST /message
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider } from "./agent-provider.ts";
import { MessageQueue } from "./message-queue.ts";
import { getEventStore } from "./runtime/helpers.ts";
import {
	closeTaskOp,
	deleteTaskOp,
	resetTaskOp,
	TaskOperationError,
	updateTaskOp,
} from "./task-operations.ts";
import { TaskTracker } from "./task-tracker.ts";
import { createMatrixApp as createApp } from "./test-utils/create-matrix-app.ts";
import { ulid } from "./ulid.ts";

// ── Shared helpers ──

const mockProvider: AgentProvider = {
	name: "mock",
	execute: async () => ({
		exitReason: "interrupted" as const,
		output: "",
		costUsd: 0,
		turns: 0,
		sessionId: "mock-session",
	}),
	// biome-ignore lint/correctness/useYield: mock provider
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

function makeCallbacks(projectPath: string) {
	return {
		broadcastTree: () => {},
		notifyTreeChange: () => {},
		notifyTargetNode: () => {},
		projectPath,
		removeWorktree: async () => {},
		clearEventStore: () => {},
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// R8-C#1 — DELETE / CLOSE / RESET root node must be rejected
// ═══════════════════════════════════════════════════════════════════════════

describe("R8-C#1: root node protection", () => {
	let tempDir: string;
	let tracker: TaskTracker;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-c1-"));
		tracker = new TaskTracker(join(tempDir, "tree.json"));
		await tracker.load("main");
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("deleteTaskOp rejects deleting the root node", async () => {
		const rootId = tracker.rootNodeId;
		// Root is childless — would pass the children check without a root guard
		expect(tracker.get(rootId)!.children.length).toBe(0);

		await expect(
			deleteTaskOp(tracker, rootId, "user", makeCallbacks(tempDir)),
		).rejects.toThrow(/root/i);

		// Root must still exist
		expect(tracker.get(rootId)).toBeDefined();
	});

	test("closeTaskOp rejects closing the root node", async () => {
		const rootId = tracker.rootNodeId;
		// Put root in verify so it passes the status check
		tracker.updateStatus(rootId, "in_progress");
		tracker.updateStatus(rootId, "verify");

		await expect(
			closeTaskOp(tracker, rootId, {
				broadcastTree: () => {},
				removeWorktree: async () => {},
				clearEventStore: () => {},
			}),
		).rejects.toThrow(/root/i);

		// Root must still be in verify status (not closed)
		const root = tracker.getTask(rootId);
		expect(root!.status).toBe("verify");
	});

	test("resetTaskOp rejects resetting the root node", async () => {
		const rootId = tracker.rootNodeId;

		await expect(
			resetTaskOp(tracker, rootId, {
				broadcastTree: () => {},
				removeWorktree: async () => {},
				clearEventStore: () => {},
			}),
		).rejects.toThrow(/root/i);
	});

	test("REST DELETE /tasks/:rootId returns 400", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "mxd-c1-data-"));
		try {
			const project = {
				id: ulid(),
				name: "c1-rest",
				path: join(tempDir, "c1-rest"),
			};
			const result = createApp({
				dataDir,
				agentProvider: mockProvider,
				projects: [project],
			});
			result.markReady();
			const t = await result.getTracker(project.id);
			const rootId = t.rootNodeId;

			const res = await result.app.fetch(
				new Request(
					`http://localhost/projects/${project.id}/tasks/${rootId}`,
					{ method: "DELETE" },
				),
			);
			expect(res.status).toBe(400);
			const body = await res.json();
			expect(body.error).toMatch(/root/i);
		} finally {
			await rm(dataDir, { recursive: true, force: true });
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// R8-C#2 — Status transitions must be validated
// ═══════════════════════════════════════════════════════════════════════════

describe("R8-C#2: status transition validation", () => {
	let tempDir: string;
	let tracker: TaskTracker;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-c2-"));
		tracker = new TaskTracker(join(tempDir, "tree.json"));
		await tracker.load("main");
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("updateTaskOp rejects status change to 'closed' (must use closeTaskOp)", async () => {
		const node = tracker.addChild(
			tracker.rootNodeId,
			"test-task",
			"desc",
		);
		tracker.updateStatus(node.id, "in_progress");
		tracker.updateStatus(node.id, "verify");

		await expect(
			updateTaskOp(
				tracker,
				node.id,
				{ status: "closed" },
				"user",
				makeCallbacks(tempDir),
			),
		).rejects.toThrow(/closed|lifecycle|closeTaskOp/i);

		// Status must NOT have changed
		expect(tracker.getTask(node.id)!.status).toBe("verify");
	});

	test("updateTaskOp rejects status change to 'failed' (must use lifecycle ops)", async () => {
		const node = tracker.addChild(
			tracker.rootNodeId,
			"test-task",
			"desc",
		);

		await expect(
			updateTaskOp(
				tracker,
				node.id,
				{ status: "failed" },
				"user",
				makeCallbacks(tempDir),
			),
		).rejects.toThrow(/failed|lifecycle/i);

		// Status must NOT have changed
		expect(tracker.getTask(node.id)!.status).toBe("pending");
	});

	test("REST PATCH with status=closed returns 400", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "mxd-c2-data-"));
		try {
			const project = {
				id: ulid(),
				name: "c2-rest",
				path: join(tempDir, "c2-rest"),
			};
			const result = createApp({
				dataDir,
				agentProvider: mockProvider,
				projects: [project],
			});
			result.markReady();
			const t = await result.getTracker(project.id);
			const node = t.addChild(t.rootNodeId, "task", "desc");
			t.updateStatus(node.id, "in_progress");
			t.updateStatus(node.id, "verify");
			await t.save();

			const res = await result.app.fetch(
				new Request(
					`http://localhost/projects/${project.id}/tasks/${node.id}`,
					{
						method: "PATCH",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ status: "closed" }),
					},
				),
			);
			expect(res.status).toBe(400);
		} finally {
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	test("updateTaskOp allows valid status transitions (pending → in_progress)", async () => {
		const node = tracker.addChild(
			tracker.rootNodeId,
			"test-task",
			"desc",
		);
		// pending → in_progress should be fine
		const result = await updateTaskOp(
			tracker,
			node.id,
			{ status: "in_progress" },
			"user",
			makeCallbacks(tempDir),
		);
		expect(result.status).toBe("in_progress");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// R8-C#3 — Prefix resolution split-brain
// ═══════════════════════════════════════════════════════════════════════════

describe("R8-C#3: prefix canonicalization", () => {
	// Use a fixed child ID that won't collide with any ULID root
	const CHILD_FULL_ID = "99TESTPREFIX1234567890ABCD";
	const CHILD_PREFIX = "99TESTPREFIX"; // 12 chars — unique vs ULID roots (start with 01K...)

	test("deliverMessage canonicalizes prefix to full node ID for JSONL", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "mxd-c3-"));
		const dataDir = await mkdtemp(join(tmpdir(), "mxd-c3-data-"));
		try {
			const project = {
				id: ulid(),
				name: "c3-prefix",
				path: join(tempDir, "c3-prefix"),
			};
			const result = createApp({
				dataDir,
				agentProvider: mockProvider,
				projects: [project],
			});
			result.markReady();
			const tracker = await result.getTracker(project.id);
			const child = tracker.addChild(tracker.rootNodeId, "child", "desc", {
				id: CHILD_FULL_ID,
			});
			await tracker.save();

			// Verify prefix resolves to the node
			expect(tracker.get(CHILD_PREFIX)?.id).toBe(CHILD_FULL_ID);

			// Send message via REST using the PREFIX
			const res = await result.app.fetch(
				new Request(
					`http://localhost/projects/${project.id}/tasks/${CHILD_PREFIX}/message`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ content: "hello via prefix" }),
					},
				),
			);
			expect(res.status).toBe(200);

			// The JSONL must be under the CANONICAL (full) id, NOT the prefix
			const eventStore = getEventStore(result.ctx, project.id);
			expect(eventStore.has(CHILD_FULL_ID)).toBe(true);
			// The prefix must NOT have its own JSONL file
			expect(eventStore.has(CHILD_PREFIX)).toBe(false);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	test("REST /message response returns canonical taskId, not prefix", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "mxd-c3b-"));
		const dataDir = await mkdtemp(join(tmpdir(), "mxd-c3b-data-"));
		try {
			const project = {
				id: ulid(),
				name: "c3b-prefix",
				path: join(tempDir, "c3b-prefix"),
			};
			const result = createApp({
				dataDir,
				agentProvider: mockProvider,
				projects: [project],
			});
			result.markReady();
			const tracker = await result.getTracker(project.id);
			tracker.addChild(tracker.rootNodeId, "child", "desc", {
				id: CHILD_FULL_ID,
			});
			await tracker.save();

			const res = await result.app.fetch(
				new Request(
					`http://localhost/projects/${project.id}/tasks/${CHILD_PREFIX}/message`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ content: "hello" }),
					},
				),
			);
			const body = await res.json();
			expect(body.taskId).toBe(CHILD_FULL_ID);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
			await rm(dataDir, { recursive: true, force: true });
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// R8-C#4 — REST /message + /clarify accept nonexistent/folder ids
// ═══════════════════════════════════════════════════════════════════════════

describe("R8-C#4: REST message validation", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createApp>["app"];
	let ctx: ReturnType<typeof createApp>["ctx"];
	let getTracker: ReturnType<typeof createApp>["getTracker"];
	let projectId: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-c4-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-c4-data-"));
		const project = {
			id: ulid(),
			name: "c4-validate",
			path: join(tempDir, "c4-validate"),
		};
		const result = createApp({
			dataDir,
			agentProvider: mockProvider,
			projects: [project],
		});
		result.markReady();
		app = result.app;
		ctx = result.ctx;
		getTracker = result.getTracker;
		projectId = project.id;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		await rm(dataDir, { recursive: true, force: true });
	});

	test("POST /message to nonexistent nodeId returns 404", async () => {
		const res = await app.fetch(
			new Request(
				`http://localhost/projects/${projectId}/tasks/NONEXISTENT_ID_12345678/message`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ content: "hello" }),
				},
			),
		);
		expect(res.status).toBe(404);

		// Must NOT create a JSONL file for the bogus id
		const eventStore = getEventStore(ctx, projectId);
		expect(eventStore.has("NONEXISTENT_ID_12345678")).toBe(false);
	});

	test("POST /message to a folder id returns 400", async () => {
		const tracker = await getTracker(projectId);
		const folder = tracker.addGeneralNode(
			"test-folder",
			tracker.rootNodeId,
			"folder",
		);
		await tracker.save();

		const res = await app.fetch(
			new Request(
				`http://localhost/projects/${projectId}/tasks/${folder.id}/message`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ content: "hello" }),
				},
			),
		);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toMatch(/folder|non-task|not a task/i);
	});

	test("POST /clarify to nonexistent nodeId returns 404", async () => {
		const res = await app.fetch(
			new Request(
				`http://localhost/projects/${projectId}/clarify`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						taskId: "NONEXISTENT_ID_12345678",
						answer: "yes",
					}),
				},
			),
		);
		// handleClarifyResponse should return 404 for bogus task
		expect(res.status).toBe(404);
	});

	test("POST /clarify to a folder id returns 400", async () => {
		const tracker = await getTracker(projectId);
		const folder = tracker.addGeneralNode(
			"test-folder",
			tracker.rootNodeId,
			"folder",
		);
		await tracker.save();

		const res = await app.fetch(
			new Request(
				`http://localhost/projects/${projectId}/clarify`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						taskId: folder.id,
						answer: "yes",
					}),
				},
			),
		);
		expect(res.status).toBe(400);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// R8-C#5 — No draft guard on REST /message
// ═══════════════════════════════════════════════════════════════════════════

describe("R8-C#5: draft guard on REST /message", () => {
	test("POST /message to a draft task returns 400", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "mxd-c5-"));
		const dataDir = await mkdtemp(join(tmpdir(), "mxd-c5-data-"));
		try {
			const project = {
				id: ulid(),
				name: "c5-draft",
				path: join(tempDir, "c5-draft"),
			};
			const result = createApp({
				dataDir,
				agentProvider: mockProvider,
				projects: [project],
			});
			result.markReady();
			const tracker = await result.getTracker(project.id);
			const node = tracker.addChild(tracker.rootNodeId, "draft-task", "desc", {
				draft: true,
			});
			await tracker.save();
			expect(tracker.getTask(node.id)!.status).toBe("draft");

			const res = await result.app.fetch(
				new Request(
					`http://localhost/projects/${project.id}/tasks/${node.id}/message`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ content: "hello draft" }),
					},
				),
			);
			expect(res.status).toBe(400);
			const body = await res.json();
			expect(body.error).toMatch(/draft/i);

			// Must NOT create a JSONL file or mutate the draft's status
			const eventStore = getEventStore(result.ctx, project.id);
			expect(eventStore.has(node.id)).toBe(false);
			expect(tracker.getTask(node.id)!.status).toBe("draft");
		} finally {
			await rm(tempDir, { recursive: true, force: true });
			await rm(dataDir, { recursive: true, force: true });
		}
	});
});
