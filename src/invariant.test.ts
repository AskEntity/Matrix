/**
 * Cross-boundary invariant tests.
 *
 * These tests verify architectural invariants that unit tests miss:
 * - Session isolation: forked sessions don't leak parent events
 * - Compact barrier correctness: the last barrier (compact/fork) wins
 * - Event ownership: post-fork events have the correct taskId
 * - Task events endpoint isolation: GET /tasks/:id/events returns only that session's data
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./daemon.ts";
import { EventStore } from "./event-store.ts";
import type { Event } from "./events.ts";
import {
	createMockedProviderWithMock,
	ValidatingMockAPI,
} from "./test-utils/mock-anthropic-api.ts";

// ── Test infrastructure ──

interface TestContext {
	dataDir: string;
	projectDir: string;
	app: ReturnType<typeof createApp>;
	mockAPI: ValidatingMockAPI;
	projectId: string;
}

async function setupTestContext(): Promise<TestContext> {
	const dataDir = await mkdtemp(join(tmpdir(), "mxd-invariant-data-"));
	const projectDir = await mkdtemp(join(tmpdir(), "mxd-invariant-project-"));

	Bun.spawnSync(["git", "init"], { cwd: projectDir });
	Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
		cwd: projectDir,
	});
	Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: projectDir });
	// Test gitignore: agent scenarios write scratch files but don't commit;
	// done() now rejects dirty worktrees. Ignore all but explicitly tracked files.
	await Bun.write(
		join(projectDir, ".gitignore"),
		"*\n!/.gitignore\n!/README.md\n!/.mxd/\n!/.mxd/**\n",
	);
	await Bun.write(join(projectDir, "README.md"), "# Test Project\n");
	Bun.spawnSync(["git", "add", "."], { cwd: projectDir });
	Bun.spawnSync(["git", "commit", "-m", "initial"], { cwd: projectDir });

	const mockAPI = new ValidatingMockAPI();
	const provider = createMockedProviderWithMock(mockAPI);

	const appResult = createApp({
		dataDir,
		agentProvider: provider,
	});

	await appResult.pm.load();
	const project = await appResult.pm.init(projectDir);

	// Clean up quality task templates
	const tasksDir = join(projectDir, ".mxd", "tasks");
	if (existsSync(tasksDir)) {
		rmSync(tasksDir, { recursive: true });
	}

	// Activate setup hook
	const hookExample = join(
		projectDir,
		".mxd",
		"hooks",
		"setup_worktree.sh.example",
	);
	const hookActive = join(projectDir, ".mxd", "hooks", "setup_worktree.sh");
	if (existsSync(hookExample)) {
		await rename(hookExample, hookActive);
	}
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

// ── Invariant 1: Session Isolation ──

describe("Invariant: Session Isolation", () => {
	test("readFromLastCompactMarker on forked session excludes pre-fork parent events", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mxd-inv-store-"));
		const store = new EventStore(dir);

		try {
			// Write parent session events
			const parentEvents: Event[] = [
				{
					type: "session_config",
					tools: [],
					systemStable: "stable",
					systemVariable: "var",
					taskId: "parent-task",
					ts: 1000,
				},
				{
					type: "message",
					id: "msg-1",
					body: {
						source: "user",
						id: "msg-1",
						ts: 1001,
						content: "hello parent",
					},
					taskId: "parent-task",
					ts: 1001,
				},
				{
					type: "assistant_text",
					content: "parent response",
					taskId: "parent-task",
					ts: 1002,
				},
				{
					type: "tool_call",
					tool: "mcp__mxd__bash",
					toolCallId: "tc-parent-1",
					input: { command: "ls" },
					taskId: "parent-task",
					ts: 1003,
				},
				{
					type: "tool_result",
					tool: "mcp__mxd__bash",
					toolCallId: "tc-parent-1",
					content: "file1.ts\nfile2.ts",
					isError: false,
					taskId: "parent-task",
					ts: 1004,
				},
			];
			await store.appendBatch("parent-task", parentEvents);

			// Fork: copy parent events to child session, add fork_marker
			await store.copySessionFrom("parent-task", "child-task", {
				targetTitle: "Child Task",
				targetDescription: "Do child work",
			});

			// Add child's own events after fork
			const childEvents: Event[] = [
				{
					type: "assistant_text",
					content: "child response after fork",
					taskId: "child-task",
					ts: 3000,
				},
				{
					type: "tool_call",
					tool: "mcp__mxd__read_file",
					toolCallId: "tc-child-1",
					input: { path: "file1.ts" },
					taskId: "child-task",
					ts: 3001,
				},
				{
					type: "tool_result",
					tool: "mcp__mxd__read_file",
					toolCallId: "tc-child-1",
					content: "file contents",
					isError: false,
					taskId: "child-task",
					ts: 3002,
				},
			];
			await store.appendBatch("child-task", childEvents);

			// readFromLastCompactMarker should use fork_marker as barrier
			const result = store.readFromLastCompactMarker("child-task");

			expect(result.hasOlderEvents).toBe(true);

			// The barrier is the fork_marker — no parent-taskId events should appear
			// (except the fork_marker itself which has taskId=child-task)
			for (const event of result.events) {
				expect(event.taskId).toBe("child-task");
			}

			// Fork marker should be the first event
			expect(result.events[0]?.type).toBe("fork_marker");

			// Parent events must NOT appear
			const parentTaskEvents = result.events.filter(
				(e) => e.taskId === "parent-task",
			);
			expect(parentTaskEvents).toHaveLength(0);

			// Child's own events must appear
			const childTexts = result.events.filter(
				(e) => e.type === "assistant_text",
			);
			expect(childTexts.length).toBeGreaterThanOrEqual(1);
			expect(
				childTexts.some(
					(e) =>
						e.type === "assistant_text" &&
						e.content === "child response after fork",
				),
			).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("readActive on forked session returns only post-compact events (ignores fork)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mxd-inv-store-"));
		const store = new EventStore(dir);

		try {
			// Create parent session
			await store.append("parent-task", {
				type: "assistant_text",
				content: "parent work",
				taskId: "parent-task",
				ts: 1000,
			});

			// Fork to child
			await store.copySessionFrom("parent-task", "child-task");

			// Child works, then gets compacted
			await store.appendBatch("child-task", [
				{
					type: "assistant_text",
					content: "child pre-compact",
					taskId: "child-task",
					ts: 3000,
				},
				{
					type: "compact_marker",
					checkpoint: "child checkpoint",
					savedTokens: 5000,
					taskId: "child-task",
					ts: 4000,
				},
				{
					type: "compacted_resume",
					content: "child checkpoint",
					taskId: "child-task",
					ts: 4001,
				},
				{
					type: "assistant_text",
					content: "child post-compact",
					taskId: "child-task",
					ts: 5000,
				},
			]);

			// readActive uses compact_marker only (not fork_marker)
			const active = store.readActive("child-task");

			// Should only have events after the compact_marker
			expect(active).toEqual([
				{
					type: "compacted_resume",
					content: "child checkpoint",
					taskId: "child-task",
					ts: 4001,
				},
				{
					type: "assistant_text",
					content: "child post-compact",
					taskId: "child-task",
					ts: 5000,
				},
			]);

			// No parent events
			expect(active.every((e) => e.taskId === "child-task")).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

// ── Invariant 2: Compact Barrier Correctness ──

describe("Invariant: Compact Barrier Correctness", () => {
	test("fork_marker after compact_marker: fork is the barrier", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mxd-inv-barrier-"));
		const store = new EventStore(dir);

		try {
			const events: Event[] = [
				{
					type: "assistant_text",
					content: "very old",
					taskId: "task-1",
					ts: 1000,
				},
				{
					type: "compact_marker",
					checkpoint: "cp1",
					savedTokens: 1000,
					taskId: "task-1",
					ts: 2000,
				},
				{
					type: "assistant_text",
					content: "between barriers",
					taskId: "task-1",
					ts: 3000,
				},
				{
					type: "fork_marker",
					sourceTaskId: "other-task",
					taskId: "task-1",
					ts: 4000,
				},
				{
					type: "assistant_text",
					content: "after fork",
					taskId: "task-1",
					ts: 5000,
				},
			];
			await store.appendBatch("task-1", events);

			const result = store.readFromLastCompactMarker("task-1");

			// Fork at index 3 > compact at index 1 → fork is the barrier
			expect(result.hasOlderEvents).toBe(true);
			expect(result.events[0]?.type).toBe("fork_marker");
			expect(result.events).toHaveLength(2);
			expect(result.events[1]).toEqual({
				type: "assistant_text",
				content: "after fork",
				taskId: "task-1",
				ts: 5000,
			});

			// "between barriers" must NOT be in the result
			expect(
				result.events.some(
					(e) =>
						e.type === "assistant_text" && e.content === "between barriers",
				),
			).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("compact_marker after fork_marker: compact is the barrier", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mxd-inv-barrier-"));
		const store = new EventStore(dir);

		try {
			const events: Event[] = [
				{
					type: "assistant_text",
					content: "pre-fork",
					taskId: "parent-id",
					ts: 1000,
				},
				{
					type: "fork_marker",
					sourceTaskId: "parent-id",
					taskId: "task-1",
					ts: 2000,
				},
				{
					type: "assistant_text",
					content: "between barriers",
					taskId: "task-1",
					ts: 3000,
				},
				{
					type: "compact_marker",
					checkpoint: "post-fork compact",
					savedTokens: 2000,
					taskId: "task-1",
					ts: 4000,
				},
				{
					type: "assistant_text",
					content: "after compact",
					taskId: "task-1",
					ts: 5000,
				},
			];
			await store.appendBatch("task-1", events);

			const result = store.readFromLastCompactMarker("task-1");

			// Compact at index 3 > fork at index 1 → compact is the barrier
			expect(result.hasOlderEvents).toBe(true);
			expect(result.events[0]?.type).toBe("compact_marker");
			expect(result.events).toHaveLength(2);
			expect(result.events[1]).toEqual({
				type: "assistant_text",
				content: "after compact",
				taskId: "task-1",
				ts: 5000,
			});

			// "between barriers" must NOT be in the result
			expect(
				result.events.some(
					(e) =>
						e.type === "assistant_text" && e.content === "between barriers",
				),
			).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("multiple compactions + fork: last barrier wins", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mxd-inv-barrier-"));
		const store = new EventStore(dir);

		try {
			const events: Event[] = [
				{
					type: "assistant_text",
					content: "ancient",
					taskId: "task-1",
					ts: 1000,
				},
				{
					type: "compact_marker",
					checkpoint: "cp1",
					savedTokens: 500,
					taskId: "task-1",
					ts: 2000,
				},
				{
					type: "fork_marker",
					sourceTaskId: "other",
					taskId: "task-1",
					ts: 3000,
				},
				{
					type: "compact_marker",
					checkpoint: "cp2",
					savedTokens: 1000,
					taskId: "task-1",
					ts: 4000,
				},
				{
					type: "assistant_text",
					content: "latest",
					taskId: "task-1",
					ts: 5000,
				},
			];
			await store.appendBatch("task-1", events);

			const result = store.readFromLastCompactMarker("task-1");

			// Last compact at index 3 > fork at index 2 > first compact at index 1
			expect(result.hasOlderEvents).toBe(true);
			expect(result.events[0]?.type).toBe("compact_marker");
			if (result.events[0]?.type === "compact_marker") {
				expect(result.events[0].checkpoint).toBe("cp2");
			}
			expect(result.events).toHaveLength(2);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("no barriers: returns all events", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mxd-inv-barrier-"));
		const store = new EventStore(dir);

		try {
			const events: Event[] = [
				{
					type: "assistant_text",
					content: "first",
					taskId: "task-1",
					ts: 1000,
				},
				{
					type: "assistant_text",
					content: "second",
					taskId: "task-1",
					ts: 2000,
				},
			];
			await store.appendBatch("task-1", events);

			const result = store.readFromLastCompactMarker("task-1");
			expect(result.hasOlderEvents).toBe(false);
			expect(result.events).toEqual(events);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

// ── Invariant 3: Event Ownership ──

describe("Invariant: Event Ownership", () => {
	test("every event after fork_marker has correct child taskId", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mxd-inv-ownership-"));
		const store = new EventStore(dir);

		try {
			// Create parent session with multiple events
			const parentEvents: Event[] = [
				{
					type: "session_config",
					tools: [],
					systemStable: "stable",
					systemVariable: "var",
					taskId: "parent-task",
					ts: 1000,
				},
				{
					type: "message",
					id: "msg-1",
					body: { source: "user", id: "msg-1", ts: 1001, content: "do work" },
					taskId: "parent-task",
					ts: 1001,
				},
				{
					type: "assistant_text",
					content: "working on it",
					taskId: "parent-task",
					ts: 1002,
				},
				{
					type: "tool_call",
					tool: "mcp__mxd__create_task",
					toolCallId: "tc-1",
					input: { title: "sub task" },
					taskId: "parent-task",
					ts: 1003,
				},
				{
					type: "tool_result",
					tool: "mcp__mxd__create_task",
					toolCallId: "tc-1",
					content: "Task created",
					isError: false,
					taskId: "parent-task",
					ts: 1004,
				},
			];
			await store.appendBatch("parent-task", parentEvents);

			// Fork creates child session
			await store.copySessionFrom("parent-task", "child-task", {
				targetTitle: "Child",
				targetDescription: "Do child work",
			});

			// Read all events in child session
			const childAllEvents = store.read("child-task");

			// Find fork_marker index
			const forkIdx = childAllEvents.findIndex((e) => e.type === "fork_marker");
			expect(forkIdx).toBeGreaterThan(0);

			// Every event AT and AFTER fork_marker must have taskId = "child-task"
			const postForkEvents = childAllEvents.slice(forkIdx);
			for (const event of postForkEvents) {
				expect(event.taskId).toBe("child-task");
			}

			// Verify the fork_marker itself
			const forkMarker = childAllEvents[forkIdx];
			expect(forkMarker?.type).toBe("fork_marker");
			if (forkMarker?.type === "fork_marker") {
				expect(forkMarker.sourceTaskId).toBe("parent-task");
				expect(forkMarker.taskId).toBe("child-task");
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("synthetic tool_results from fork have child taskId", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mxd-inv-ownership-"));
		const store = new EventStore(dir);

		try {
			// Parent with an orphaned tool_call (no result yet — simulates mid-execution fork)
			const parentEvents: Event[] = [
				{
					type: "message",
					id: "msg-1",
					body: { source: "user", id: "msg-1", ts: 1000, content: "go" },
					taskId: "parent-task",
					ts: 1000,
				},
				{
					type: "tool_call",
					tool: "mcp__mxd__bash",
					toolCallId: "tc-orphan",
					input: { command: "sleep 10" },
					taskId: "parent-task",
					ts: 1001,
				},
			];
			await store.appendBatch("parent-task", parentEvents);

			// Fork child from parent — orphaned tool_call gets synthetic result
			await store.copySessionFrom("parent-task", "child-task");

			const childAllEvents = store.read("child-task");

			// Find all synthetic events (tool_result for orphaned tool_call + fork tool_call/result)
			const syntheticResults = childAllEvents.filter(
				(e) => e.type === "tool_result" && e.taskId === "child-task",
			);

			// Should have at least 2 synthetic results: orphan fix + fork result
			expect(syntheticResults.length).toBeGreaterThanOrEqual(2);

			// Every synthetic tool_result must have child-task as taskId
			for (const result of syntheticResults) {
				expect(result.taskId).toBe("child-task");
			}

			// The orphan's synthetic result should reference the original toolCallId
			const orphanResult = syntheticResults.find(
				(e) => e.type === "tool_result" && e.toolCallId === "tc-orphan",
			);
			expect(orphanResult).toBeDefined();
			expect(orphanResult?.taskId).toBe("child-task");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("pre-fork events retain parent taskId (historical preservation)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mxd-inv-ownership-"));
		const store = new EventStore(dir);

		try {
			await store.append("parent-task", {
				type: "assistant_text",
				content: "parent work",
				taskId: "parent-task",
				ts: 1000,
			});

			await store.copySessionFrom("parent-task", "child-task");

			const childAllEvents = store.read("child-task");
			const forkIdx = childAllEvents.findIndex((e) => e.type === "fork_marker");

			// Pre-fork events should have parent's taskId (they are copied as-is)
			const preForkEvents = childAllEvents.slice(0, forkIdx);
			expect(preForkEvents.length).toBeGreaterThan(0);
			for (const event of preForkEvents) {
				if (event.type !== "tool_call" && event.type !== "tool_result") {
					// Copied events retain parent taskId
					expect(event.taskId).toBe("parent-task");
				}
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

// ── Invariant 4: Task Events Endpoint Isolation ──

describe("Invariant: Task Events Endpoint Isolation", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("GET /tasks/:id/events?after=compact returns only that session's events", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();
		const { app, projectId } = ctx;

		// Get the root node via tracker
		const tracker = await app.getTracker(projectId);
		const rootId = tracker.rootNodeId;

		// Write events to root session via EventStore directly
		const eventStore = new EventStore(
			join(ctx.dataDir, "projects", projectId, "tasks"),
		);

		const rootEvents: Event[] = [
			{
				type: "session_config",
				tools: [],
				systemStable: "test",
				systemVariable: "test",
				taskId: rootId,
				ts: 1000,
			},
			{
				type: "message",
				id: "root-msg-1",
				body: {
					source: "user",
					id: "root-msg-1",
					ts: 1001,
					content: "root message",
				},
				taskId: rootId,
				ts: 1001,
			},
			{
				type: "assistant_text",
				content: "root response",
				taskId: rootId,
				ts: 1002,
			},
		];
		await eventStore.appendBatch(rootId, rootEvents);

		// Create a child task
		const createRes = await app.app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Child Task",
				description: "test child",
				parentId: rootId,
			}),
		});
		const { id: childId } = (await createRes.json()) as { id: string };

		// Fork root session to child (simulating fork)
		await eventStore.copySessionFrom(rootId, childId, {
			targetTitle: "Child Task",
			targetDescription: "test child",
		});

		// Add child's own events
		await eventStore.appendBatch(childId, [
			{
				type: "assistant_text",
				content: "child-only content",
				taskId: childId,
				ts: 5000,
			},
		]);

		// Fetch root events — should NOT contain child events
		const rootEventsRes = await app.app.request(
			`/projects/${projectId}/tasks/${rootId}/events?after=compact`,
			{ method: "GET" },
		);
		const rootEventsData = (await rootEventsRes.json()) as {
			events: Array<{ taskId: string; type: string; content?: string }>;
			hasOlderEvents: boolean;
		};

		// Root events should only contain root's own events
		for (const event of rootEventsData.events) {
			expect(event.taskId).toBe(rootId);
		}

		// "child-only content" must NOT appear in root's event stream
		expect(
			rootEventsData.events.some(
				(e) =>
					e.type === "assistant_text" && e.content === "child-only content",
			),
		).toBe(false);

		// Fetch child events with after=compact — fork_marker is the barrier
		const childEventsRes = await app.app.request(
			`/projects/${projectId}/tasks/${childId}/events?after=compact`,
			{ method: "GET" },
		);
		const childEventsData = (await childEventsRes.json()) as {
			events: Array<{ taskId: string; type: string; content?: string }>;
			hasOlderEvents: boolean;
		};

		// Child events after barrier should only have child's taskId
		for (const event of childEventsData.events) {
			expect(event.taskId).toBe(childId);
		}

		// "child-only content" MUST appear in child's event stream
		expect(
			childEventsData.events.some(
				(e) =>
					e.type === "assistant_text" && e.content === "child-only content",
			),
		).toBe(true);

		// "root response" must NOT appear in child's post-barrier events
		expect(
			childEventsData.events.some(
				(e) => e.type === "assistant_text" && e.content === "root response",
			),
		).toBe(false);

		// hasOlderEvents should be true (fork_marker is a barrier with pre-fork events before it)
		expect(childEventsData.hasOlderEvents).toBe(true);
	});

	test("GET /tasks/:id/events (no after param) returns all events for that session only", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();
		const { app, projectId } = ctx;

		const tracker = await app.getTracker(projectId);
		const rootId = tracker.rootNodeId;

		const eventStore = new EventStore(
			join(ctx.dataDir, "projects", projectId, "tasks"),
		);

		// Write to root
		await eventStore.append(rootId, {
			type: "assistant_text",
			content: "root only",
			taskId: rootId,
			ts: 1000,
		});

		// Write to a completely separate session (simulates a sibling)
		const fakeSiblingId = "fake-sibling-id";
		await eventStore.append(fakeSiblingId, {
			type: "assistant_text",
			content: "sibling only",
			taskId: fakeSiblingId,
			ts: 2000,
		});

		// Fetch root events — must NOT leak sibling events
		const res = await app.app.request(
			`/projects/${projectId}/tasks/${rootId}/events`,
			{ method: "GET" },
		);
		const data = (await res.json()) as {
			events: Array<{ taskId: string; type: string; content?: string }>;
		};

		for (const event of data.events) {
			expect(event.taskId).toBe(rootId);
		}

		expect(
			data.events.some(
				(e) => e.type === "assistant_text" && e.content === "sibling only",
			),
		).toBe(false);
	});
});

// ── Invariant 5: copySessionFrom Correctness ──

describe("Invariant: copySessionFrom Correctness", () => {
	test("fork does not mutate the source session", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mxd-inv-fork-"));
		const store = new EventStore(dir);

		try {
			const sourceEvents: Event[] = [
				{
					type: "message",
					id: "msg-1",
					body: { source: "user", id: "msg-1", ts: 1000, content: "hello" },
					taskId: "source",
					ts: 1000,
				},
				{
					type: "assistant_text",
					content: "response",
					taskId: "source",
					ts: 1001,
				},
			];
			await store.appendBatch("source", sourceEvents);

			// Snapshot source before fork
			const beforeFork = store.read("source");

			// Fork
			await store.copySessionFrom("source", "target");

			// Source must be unchanged
			const afterFork = store.read("source");
			expect(afterFork).toEqual(beforeFork);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("double fork from same source creates independent children", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mxd-inv-fork-"));
		const store = new EventStore(dir);

		try {
			await store.append("source", {
				type: "assistant_text",
				content: "shared context",
				taskId: "source",
				ts: 1000,
			});

			await store.copySessionFrom("source", "child-1");
			await store.copySessionFrom("source", "child-2");

			// Add different events to each child
			await store.append("child-1", {
				type: "assistant_text",
				content: "child-1 work",
				taskId: "child-1",
				ts: 3000,
			});
			await store.append("child-2", {
				type: "assistant_text",
				content: "child-2 work",
				taskId: "child-2",
				ts: 3000,
			});

			// Each child's post-barrier events are isolated
			const child1Result = store.readFromLastCompactMarker("child-1");
			const child2Result = store.readFromLastCompactMarker("child-2");

			// child-1 must not see child-2's work and vice versa
			expect(
				child1Result.events.some(
					(e) => e.type === "assistant_text" && e.content === "child-2 work",
				),
			).toBe(false);
			expect(
				child2Result.events.some(
					(e) => e.type === "assistant_text" && e.content === "child-1 work",
				),
			).toBe(false);

			// Each child sees its own work
			expect(
				child1Result.events.some(
					(e) => e.type === "assistant_text" && e.content === "child-1 work",
				),
			).toBe(true);
			expect(
				child2Result.events.some(
					(e) => e.type === "assistant_text" && e.content === "child-2 work",
				),
			).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("fork from compacted source only includes post-compact events", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mxd-inv-fork-"));
		const store = new EventStore(dir);

		try {
			const sourceEvents: Event[] = [
				{
					type: "assistant_text",
					content: "pre-compact",
					taskId: "source",
					ts: 1000,
				},
				{
					type: "compact_marker",
					checkpoint: "checkpoint",
					savedTokens: 3000,
					taskId: "source",
					ts: 2000,
				},
				{
					type: "compacted_resume",
					content: "checkpoint",
					taskId: "source",
					ts: 2001,
				},
				{
					type: "assistant_text",
					content: "post-compact",
					taskId: "source",
					ts: 3000,
				},
			];
			await store.appendBatch("source", sourceEvents);

			const result = await store.copySessionFrom("source", "target");

			// Only post-compact events should be copied (compacted_resume + assistant_text)
			expect(result.eventCount).toBe(2);

			const targetAll = store.read("target");

			// "pre-compact" must NOT be in target
			expect(
				targetAll.some(
					(e) => e.type === "assistant_text" && e.content === "pre-compact",
				),
			).toBe(false);

			// "post-compact" MUST be in target
			expect(
				targetAll.some(
					(e) => e.type === "assistant_text" && e.content === "post-compact",
				),
			).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
