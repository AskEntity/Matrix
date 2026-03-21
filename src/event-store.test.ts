import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EventStore, runEventMigrations } from "./event-store.ts";
import type { Event } from "./events.ts";

const TEST_DIR = join(import.meta.dir, "..", ".test-event-store");

describe("EventStore", () => {
	let store: EventStore;

	beforeEach(() => {
		if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
		store = new EventStore(TEST_DIR);
	});

	afterEach(() => {
		if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	});

	test("creates directory if it does not exist", () => {
		const dir = join(TEST_DIR, "sub", "dir");
		new EventStore(dir);
		expect(existsSync(dir)).toBe(true);
	});

	test("has returns false for non-existent session", () => {
		expect(store.has("no-such-session")).toBe(false);
	});

	test("append + read single event", async () => {
		const event: Event = {
			type: "message",
			content: "hello",
			ts: 1000,
		};
		await store.append("s1", event);
		expect(store.has("s1")).toBe(true);
		expect(store.read("s1")).toEqual([event]);
	});

	test("append multiple events sequentially", async () => {
		const e1: Event = {
			type: "message",
			content: "hello",
			ts: 1000,
		};
		const e2: Event = {
			type: "assistant_text",
			content: "hi there",
			ts: 1001,
		};
		await store.append("s1", e1);
		await store.append("s1", e2);
		expect(store.read("s1")).toEqual([e1, e2]);
	});

	test("appendBatch writes multiple events", async () => {
		const events: Event[] = [
			{ type: "message", content: "hello", ts: 1000 },
			{ type: "assistant_text", content: "hi", ts: 1001 },
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "tc1",
				input: { command: "ls" },
				ts: 1002,
			},
		];
		await store.appendBatch("s1", events);
		expect(store.read("s1")).toEqual(events);
	});

	test("appendBatch with empty array is a no-op", async () => {
		await store.appendBatch("s1", []);
		expect(store.has("s1")).toBe(false);
	});

	test("read returns empty array for non-existent session", () => {
		expect(store.read("missing")).toEqual([]);
	});

	test("clear removes the file", async () => {
		await store.append("s1", {
			type: "message",
			content: "hello",
			ts: 1000,
		});
		expect(store.has("s1")).toBe(true);
		store.clear("s1");
		expect(store.has("s1")).toBe(false);
		expect(store.read("s1")).toEqual([]);
	});

	test("clear on non-existent session is a no-op", () => {
		// Should not throw
		store.clear("missing");
	});

	test("readActive returns all events when no compact_marker", async () => {
		const events: Event[] = [
			{ type: "message", content: "hello", ts: 1000 },
			{ type: "assistant_text", content: "hi", ts: 1001 },
		];
		await store.appendBatch("s1", events);
		expect(store.readActive("s1")).toEqual(events);
	});

	test("readActive returns events after last compact_marker", async () => {
		const events: Event[] = [
			{ type: "message", content: "old msg", ts: 1000 },
			{ type: "assistant_text", content: "old response", ts: 1001 },
			{
				type: "compact_marker",
				checkpoint: "checkpoint text",
				savedTokens: 5000,
				ts: 2000,
			},
			{ type: "compacted_resume", content: "checkpoint text", ts: 2001 },
			{ type: "assistant_text", content: "new response", ts: 2002 },
		];
		await store.appendBatch("s1", events);

		const active = store.readActive("s1");
		expect(active).toEqual([
			{ type: "compacted_resume", content: "checkpoint text", ts: 2001 },
			{ type: "assistant_text", content: "new response", ts: 2002 },
		]);
	});

	test("readActive with multiple compact_markers uses the last one", async () => {
		const events: Event[] = [
			{ type: "message", content: "very old", ts: 1000 },
			{
				type: "compact_marker",
				checkpoint: "first",
				savedTokens: 1000,
				ts: 2000,
			},
			{ type: "message", content: "somewhat old", ts: 2001 },
			{
				type: "compact_marker",
				checkpoint: "second",
				savedTokens: 2000,
				ts: 3000,
			},
			{ type: "compacted_resume", content: "second checkpoint", ts: 3001 },
		];
		await store.appendBatch("s1", events);

		const active = store.readActive("s1");
		expect(active).toEqual([
			{ type: "compacted_resume", content: "second checkpoint", ts: 3001 },
		]);
	});

	test("readActive returns empty when file does not exist", () => {
		expect(store.readActive("missing")).toEqual([]);
	});

	test("preserves all event fields through round-trip", async () => {
		const event: Event = {
			type: "tool_result",
			toolCallId: "tc1",
			content: 'result with "quotes" and\nnewlines',
			isError: false,
			images: [{ base64: "abc123", mediaType: "image/png" }],
			ts: 1234,
		};
		await store.append("s1", event);
		expect(store.read("s1")).toEqual([event]);
	});

	test("separate sessions do not interfere", async () => {
		const e1: Event = {
			type: "message",
			content: "session 1",
			ts: 1000,
		};
		const e2: Event = {
			type: "message",
			content: "session 2",
			ts: 2000,
		};
		await store.append("s1", e1);
		await store.append("s2", e2);
		expect(store.read("s1")).toEqual([e1]);
		expect(store.read("s2")).toEqual([e2]);
		store.clear("s1");
		expect(store.has("s1")).toBe(false);
		expect(store.has("s2")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Migration tests
// ---------------------------------------------------------------------------

const MIGRATION_DIR = join(import.meta.dir, "..", ".test-migration");

describe("runEventMigrations", () => {
	beforeEach(() => {
		if (existsSync(MIGRATION_DIR)) rmSync(MIGRATION_DIR, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(MIGRATION_DIR)) rmSync(MIGRATION_DIR, { recursive: true });
	});

	function writeJsonl(
		projectId: string,
		sessionId: string,
		events: Record<string, unknown>[],
	): string {
		const dir = join(MIGRATION_DIR, projectId);
		mkdirSync(dir, { recursive: true });
		const path = join(dir, `${sessionId}.events.jsonl`);
		writeFileSync(path, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
		return path;
	}

	function readJsonl(path: string): Record<string, unknown>[] {
		const { readFileSync } = require("node:fs");
		return readFileSync(path, "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line: string) => JSON.parse(line));
	}

	test("migrates user_message → message", () => {
		const path = writeJsonl("proj1", "sess1", [
			{ type: "user_message", content: "hello", ts: 1000 },
			{ type: "assistant_text", content: "hi", ts: 1001 },
		]);

		const count = runEventMigrations(MIGRATION_DIR);
		expect(count).toBe(1);

		const events = readJsonl(path);
		expect(events[0]?.type).toBe("message");
		expect(events[0]?.content).toBe("hello");
		// assistant_text unchanged
		expect(events[1]?.type).toBe("assistant_text");
	});

	test("migrates queueEntry → body", () => {
		const path = writeJsonl("proj1", "sess1", [
			{
				type: "user_message",
				id: "msg-1",
				source: "child_complete",
				queueEntry: {
					source: "child_complete",
					taskId: "t1",
					title: "Auth",
					success: true,
					output: "done",
				},
				ts: 1000,
			},
		]);

		runEventMigrations(MIGRATION_DIR);
		const events = readJsonl(path);

		expect(events[0]?.type).toBe("message");
		expect(events[0]?.body).toBeDefined();
		expect((events[0]?.body as Record<string, unknown>)?.source).toBe(
			"child_complete",
		);
		expect(events[0]?.queueEntry).toBeUndefined();
	});

	test("migrates standalone child_complete → message with body", () => {
		const path = writeJsonl("proj1", "sess1", [
			{
				type: "child_complete",
				id: "msg-1",
				taskId: "t1",
				title: "Build",
				success: true,
				output: "done",
				ts: 1000,
			},
		]);

		runEventMigrations(MIGRATION_DIR);
		const events = readJsonl(path);

		expect(events[0]?.type).toBe("message");
		expect(events[0]?.source).toBe("child_complete");
		const body = events[0]?.body as Record<string, unknown>;
		expect(body?.source).toBe("child_complete");
		expect(body?.taskId).toBe("t1");
		expect(body?.title).toBe("Build");
		expect(body?.success).toBe(true);
	});

	test("migrates tree_mutation → message with system body", () => {
		const path = writeJsonl("proj1", "sess1", [
			{
				type: "tree_mutation",
				action: "task_created",
				nodeId: "n1",
				title: "New task",
				ts: 1000,
			},
		]);

		runEventMigrations(MIGRATION_DIR);
		const events = readJsonl(path);

		expect(events[0]?.type).toBe("message");
		expect(events[0]?.source).toBe("system");
		const body = events[0]?.body as Record<string, unknown>;
		expect(body?.source).toBe("system");
		expect(body?.content).toContain("task_created");
		expect(body?.content).toContain("New task");
		expect(body?.content).toContain("n1");
	});

	test("migrates message_injected → message", () => {
		const path = writeJsonl("proj1", "sess1", [
			{
				type: "message_injected",
				content: "User said this",
				taskId: "root",
				ts: 1000,
			},
		]);

		runEventMigrations(MIGRATION_DIR);
		const events = readJsonl(path);

		expect(events[0]?.type).toBe("message");
		expect(events[0]?.content).toBe("User said this");
		expect(events[0]?.taskId).toBe("root");
	});

	test("migrates standalone parent_update with requestReply", () => {
		const path = writeJsonl("proj1", "sess1", [
			{
				type: "parent_update",
				id: "msg-2",
				content: "Do this",
				requestReply: true,
				ts: 1000,
			},
		]);

		runEventMigrations(MIGRATION_DIR);
		const events = readJsonl(path);

		expect(events[0]?.type).toBe("message");
		const body = events[0]?.body as Record<string, unknown>;
		expect(body?.source).toBe("parent_update");
		expect(body?.content).toBe("Do this");
		expect(body?.requestReply).toBe(true);
	});

	test("migrates compact_request → message with compact body", () => {
		const path = writeJsonl("proj1", "sess1", [
			{ type: "compact_request", id: "msg-3", ts: 1000 },
		]);

		runEventMigrations(MIGRATION_DIR);
		const events = readJsonl(path);

		expect(events[0]?.type).toBe("message");
		expect(events[0]?.source).toBe("compact");
		const body = events[0]?.body as Record<string, unknown>;
		expect(body?.source).toBe("compact");
	});

	test("migrates system_notification → message with system source", () => {
		const path = writeJsonl("proj1", "sess1", [
			{ type: "system_notification", content: "Tree changed", ts: 1000 },
		]);

		runEventMigrations(MIGRATION_DIR);
		const events = readJsonl(path);

		expect(events[0]?.type).toBe("message");
		expect(events[0]?.source).toBe("system");
		const body = events[0]?.body as Record<string, unknown>;
		expect(body?.source).toBe("system");
		expect(body?.content).toBe("Tree changed");
	});

	test("skips files already in new format", () => {
		writeJsonl("proj1", "sess1", [
			{ type: "message", content: "hello", ts: 1000 },
			{ type: "assistant_text", content: "hi", ts: 1001 },
		]);

		const count = runEventMigrations(MIGRATION_DIR);
		expect(count).toBe(0);
	});

	test("is idempotent — second run produces no changes", () => {
		const path = writeJsonl("proj1", "sess1", [
			{ type: "user_message", content: "hello", ts: 1000 },
			{
				type: "child_complete",
				taskId: "t1",
				title: "X",
				success: true,
				output: "ok",
				ts: 1001,
			},
		]);

		runEventMigrations(MIGRATION_DIR);
		const afterFirst = readJsonl(path);

		const count = runEventMigrations(MIGRATION_DIR);
		expect(count).toBe(0);

		const afterSecond = readJsonl(path);
		expect(afterSecond).toEqual(afterFirst);
	});

	test("handles multiple projects and sessions", () => {
		writeJsonl("proj1", "sess1", [
			{ type: "user_message", content: "a", ts: 1 },
		]);
		writeJsonl("proj1", "sess2", [{ type: "message", content: "b", ts: 2 }]);
		writeJsonl("proj2", "sess3", [
			{ type: "tree_mutation", action: "task_created", nodeId: "n1", ts: 3 },
		]);

		const count = runEventMigrations(MIGRATION_DIR);
		// proj1/sess1 and proj2/sess3 need migration, proj1/sess2 is already new
		expect(count).toBe(2);
	});

	test("returns 0 for non-existent directory", () => {
		expect(runEventMigrations("/nonexistent/path")).toBe(0);
	});

	test("returns 0 when ACTIVE_MIGRATIONS would be empty (no-op scenario)", () => {
		// We can't actually empty ACTIVE_MIGRATIONS from tests, but verify
		// the existing migrations don't touch non-legacy types
		writeJsonl("proj1", "sess1", [
			{ type: "assistant_text", content: "hi", ts: 1 },
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "tc1",
				input: {},
				ts: 2,
			},
			{
				type: "orchestration_started",
				taskId: "t1",
				resume: false,
				ts: 3,
			},
		]);

		const count = runEventMigrations(MIGRATION_DIR);
		expect(count).toBe(0);
	});

	test("preserves non-legacy event types unchanged", () => {
		const path = writeJsonl("proj1", "sess1", [
			{ type: "user_message", content: "hello", ts: 1 },
			{ type: "assistant_text", content: "hi", ts: 2 },
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "tc1",
				input: { command: "ls" },
				ts: 3,
			},
			{
				type: "tool_result",
				toolCallId: "tc1",
				content: "ok",
				isError: false,
				ts: 4,
			},
			{
				type: "messages_consumed",
				messageIds: ["msg-1"],
				ts: 5,
			},
		]);

		runEventMigrations(MIGRATION_DIR);
		const events = readJsonl(path);

		expect(events[0]?.type).toBe("message"); // migrated
		expect(events[1]?.type).toBe("assistant_text"); // unchanged
		expect(events[2]?.type).toBe("tool_call"); // unchanged
		expect(events[3]?.type).toBe("tool_result"); // unchanged
		expect(events[4]?.type).toBe("messages_consumed"); // unchanged
	});
});
