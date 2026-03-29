import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
			id: "",
			body: { source: "user", id: "test-id", content: "hello" },
			taskId: "test",
			ts: 1000,
		};
		await store.append("s1", event);
		expect(store.has("s1")).toBe(true);
		expect(store.read("s1")).toEqual([event]);
	});

	test("append multiple events sequentially", async () => {
		const e1: Event = {
			type: "message",
			id: "",
			body: { source: "user", id: "test-id", content: "hello" },
			taskId: "test",
			ts: 1000,
		};
		const e2: Event = {
			type: "assistant_text",
			content: "hi there",
			taskId: "test",
			ts: 1001,
		};
		await store.append("s1", e1);
		await store.append("s1", e2);
		expect(store.read("s1")).toEqual([e1, e2]);
	});

	test("appendBatch writes multiple events", async () => {
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", content: "hello" },
				taskId: "test",
				ts: 1000,
			},
			{ type: "assistant_text", content: "hi", taskId: "test", ts: 1001 },
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "tc1",
				input: { command: "ls" },
				taskId: "test",
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
			id: "",
			body: { source: "user", id: "test-id", content: "hello" },
			taskId: "test",
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
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", content: "hello" },
				taskId: "test",
				ts: 1000,
			},
			{ type: "assistant_text", content: "hi", taskId: "test", ts: 1001 },
		];
		await store.appendBatch("s1", events);
		expect(store.readActive("s1")).toEqual(events);
	});

	test("readActive returns events after last compact_marker", async () => {
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", content: "old msg" },
				taskId: "test",
				ts: 1000,
			},
			{
				type: "assistant_text",
				content: "old response",
				taskId: "test",
				ts: 1001,
			},
			{
				type: "compact_marker",
				checkpoint: "checkpoint text",
				savedTokens: 5000,
				taskId: "test",
				ts: 2000,
			},
			{
				type: "compacted_resume",
				content: "checkpoint text",
				taskId: "test",
				ts: 2001,
			},
			{
				type: "assistant_text",
				content: "new response",
				taskId: "test",
				ts: 2002,
			},
		];
		await store.appendBatch("s1", events);

		const active = store.readActive("s1");
		expect(active).toEqual([
			{
				type: "compacted_resume",
				content: "checkpoint text",
				taskId: "test",
				ts: 2001,
			},
			{
				type: "assistant_text",
				content: "new response",
				taskId: "test",
				ts: 2002,
			},
		]);
	});

	test("readActive with multiple compact_markers uses the last one", async () => {
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", content: "very old" },
				taskId: "test",
				ts: 1000,
			},
			{
				type: "compact_marker",
				checkpoint: "first",
				savedTokens: 1000,
				taskId: "test",
				ts: 2000,
			},
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", content: "somewhat old" },
				taskId: "test",
				ts: 2001,
			},
			{
				type: "compact_marker",
				checkpoint: "second",
				savedTokens: 2000,
				taskId: "test",
				ts: 3000,
			},
			{
				type: "compacted_resume",
				content: "second checkpoint",
				taskId: "test",
				ts: 3001,
			},
		];
		await store.appendBatch("s1", events);

		const active = store.readActive("s1");
		expect(active).toEqual([
			{
				type: "compacted_resume",
				content: "second checkpoint",
				taskId: "test",
				ts: 3001,
			},
		]);
	});

	test("readActive returns empty when file does not exist", () => {
		expect(store.readActive("missing")).toEqual([]);
	});

	// ── readFromLastCompactMarker ────────────────────────────────────────

	test("readFromLastCompactMarker returns all events when no compact_marker", async () => {
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", content: "hello" },
				taskId: "test",
				ts: 1000,
			},
			{ type: "assistant_text", content: "hi", taskId: "test", ts: 1001 },
		];
		await store.appendBatch("s1", events);
		const result = store.readFromLastCompactMarker("s1");
		expect(result.events).toEqual(events);
		expect(result.hasOlderEvents).toBe(false);
	});

	test("readFromLastCompactMarker returns events from last compact_marker (inclusive)", async () => {
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", content: "old msg" },
				taskId: "test",
				ts: 1000,
			},
			{
				type: "assistant_text",
				content: "old response",
				taskId: "test",
				ts: 1001,
			},
			{
				type: "compact_marker",
				checkpoint: "checkpoint text",
				savedTokens: 5000,
				taskId: "test",
				ts: 2000,
			},
			{
				type: "assistant_text",
				content: "new response",
				taskId: "test",
				ts: 2002,
			},
		];
		await store.appendBatch("s1", events);

		const result = store.readFromLastCompactMarker("s1");
		expect(result.hasOlderEvents).toBe(true);
		expect(result.events).toEqual([
			{
				type: "compact_marker",
				checkpoint: "checkpoint text",
				savedTokens: 5000,
				taskId: "test",
				ts: 2000,
			},
			{
				type: "assistant_text",
				content: "new response",
				taskId: "test",
				ts: 2002,
			},
		]);
	});

	test("readFromLastCompactMarker with multiple markers uses the last one", async () => {
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", content: "very old" },
				taskId: "test",
				ts: 1000,
			},
			{
				type: "compact_marker",
				checkpoint: "first",
				savedTokens: 1000,
				taskId: "test",
				ts: 2000,
			},
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", content: "mid" },
				taskId: "test",
				ts: 2001,
			},
			{
				type: "compact_marker",
				checkpoint: "second",
				savedTokens: 2000,
				taskId: "test",
				ts: 3000,
			},
			{
				type: "assistant_text",
				content: "latest",
				taskId: "test",
				ts: 3001,
			},
		];
		await store.appendBatch("s1", events);

		const result = store.readFromLastCompactMarker("s1");
		expect(result.hasOlderEvents).toBe(true);
		expect(result.events).toEqual([
			{
				type: "compact_marker",
				checkpoint: "second",
				savedTokens: 2000,
				taskId: "test",
				ts: 3000,
			},
			{
				type: "assistant_text",
				content: "latest",
				taskId: "test",
				ts: 3001,
			},
		]);
	});

	test("readFromLastCompactMarker with compact_marker at index 0", async () => {
		const events: Event[] = [
			{
				type: "compact_marker",
				checkpoint: "start",
				savedTokens: 100,
				taskId: "test",
				ts: 1000,
			},
			{
				type: "assistant_text",
				content: "after marker",
				taskId: "test",
				ts: 1001,
			},
		];
		await store.appendBatch("s1", events);

		const result = store.readFromLastCompactMarker("s1");
		expect(result.hasOlderEvents).toBe(false);
		expect(result.events).toEqual(events);
	});

	test("readFromLastCompactMarker returns empty for non-existent session", () => {
		const result = store.readFromLastCompactMarker("missing");
		expect(result.events).toEqual([]);
		expect(result.hasOlderEvents).toBe(false);
	});

	// ── readBefore ───────────────────────────────────────────────────────

	test("readBefore returns events before timestamp", async () => {
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", content: "first" },
				taskId: "test",
				ts: 1000,
			},
			{
				type: "assistant_text",
				content: "second",
				taskId: "test",
				ts: 2000,
			},
			{
				type: "compact_marker",
				checkpoint: "cp",
				savedTokens: 500,
				taskId: "test",
				ts: 3000,
			},
			{
				type: "assistant_text",
				content: "fourth",
				taskId: "test",
				ts: 4000,
			},
		];
		await store.appendBatch("s1", events);

		const result = store.readBefore("s1", 3000, 100);
		expect(result.hasMore).toBe(false);
		expect(result.events).toEqual([
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", content: "first" },
				taskId: "test",
				ts: 1000,
			},
			{
				type: "assistant_text",
				content: "second",
				taskId: "test",
				ts: 2000,
			},
		]);
	});

	test("readBefore respects limit and returns most recent events", async () => {
		const events: Event[] = [];
		for (let i = 0; i < 10; i++) {
			events.push({
				type: "assistant_text",
				content: `msg ${i}`,
				taskId: "test",
				ts: 1000 + i * 100,
			});
		}
		await store.appendBatch("s1", events);

		const result = store.readBefore("s1", 1800, 3);
		expect(result.hasMore).toBe(true);
		expect(result.events.length).toBe(3);
		// Should be the 3 most recent events before ts=1800
		expect(result.events[0]?.ts).toBe(1500);
		expect(result.events[1]?.ts).toBe(1600);
		expect(result.events[2]?.ts).toBe(1700);
	});

	test("readBefore returns empty for non-existent session", () => {
		const result = store.readBefore("missing", 5000, 100);
		expect(result.events).toEqual([]);
		expect(result.hasMore).toBe(false);
	});

	test("readBefore returns empty when no events before timestamp", async () => {
		const events: Event[] = [
			{
				type: "assistant_text",
				content: "first",
				taskId: "test",
				ts: 5000,
			},
		];
		await store.appendBatch("s1", events);

		const result = store.readBefore("s1", 1000, 100);
		expect(result.events).toEqual([]);
		expect(result.hasMore).toBe(false);
	});

	test("preserves all event fields through round-trip", async () => {
		const event: Event = {
			type: "tool_result",
			tool: "mcp__opengraft__bash",
			toolCallId: "tc1",
			content: 'result with "quotes" and\nnewlines',
			isError: false,
			images: [{ base64: "abc123", mediaType: "image/png" }],
			taskId: "test",
			ts: 1234,
		};
		await store.append("s1", event);
		expect(store.read("s1")).toEqual([event]);
	});

	test("read skips malformed JSONL lines", async () => {
		const { appendFileSync } = await import("node:fs");
		const validEvent: Event = {
			type: "assistant_text",
			content: "hello",
			taskId: "test",
			ts: 1000,
		};
		await store.append("corrupt", validEvent);
		// Manually inject a corrupted line
		appendFileSync(join(TEST_DIR, "corrupt.jsonl"), "this is not valid json\n");
		const validEvent2: Event = {
			type: "assistant_text",
			content: "world",
			taskId: "test",
			ts: 2000,
		};
		await store.append("corrupt", validEvent2);

		const events = store.read("corrupt");
		expect(events).toHaveLength(2);
		expect(events[0]?.type).toBe("assistant_text");
		expect(events[1]?.type).toBe("assistant_text");
	});

	test("separate sessions do not interfere", async () => {
		const e1: Event = {
			type: "message",
			id: "",
			body: { source: "user", id: "test-id", content: "session 1" },
			taskId: "test",
			ts: 1000,
		};
		const e2: Event = {
			type: "message",
			id: "",
			body: { source: "user", id: "test-id", content: "session 2" },
			taskId: "test",
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

	// ── copySessionFrom ─────────────────────────────────────────────────

	test("copySessionFrom copies all events when no compact_marker", async () => {
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", content: "hello" },
				taskId: "source",
				ts: 1000,
			},
			{
				type: "assistant_text",
				content: "hi there",
				taskId: "source",
				ts: 1001,
			},
		];
		await store.appendBatch("source", events);

		const result = await store.copySessionFrom("source", "target");
		expect(result.eventCount).toBe(2);

		const targetEvents = store.read("target");
		// 2 copied events + synthetic tool_call + synthetic tool_result + fork_marker
		expect(targetEvents).toHaveLength(5);
		expect(targetEvents[0]?.type).toBe("message");
		expect(targetEvents[1]?.type).toBe("assistant_text");
		// Synthetic fork turn (Case 2: source has no fork tool_call)
		expect(targetEvents[2]?.type).toBe("tool_call");
		expect(targetEvents[3]?.type).toBe("tool_result");
		if (targetEvents[3]?.type === "tool_result") {
			expect(targetEvents[3].content).toContain("You are the CHILD");
		}
		expect(targetEvents[4]?.type).toBe("fork_marker");
		const marker = targetEvents[4] as Extract<Event, { type: "fork_marker" }>;
		expect(marker.sourceTaskId).toBe("source");
		expect(marker.taskId).toBe("target");
	});

	test("copySessionFrom copies only post-compact events", async () => {
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", content: "old msg" },
				taskId: "source",
				ts: 1000,
			},
			{
				type: "compact_marker",
				checkpoint: "checkpoint",
				savedTokens: 5000,
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
				content: "new response",
				taskId: "source",
				ts: 2002,
			},
		];
		await store.appendBatch("source", events);

		const result = await store.copySessionFrom("source", "target");
		// Only events after compact_marker: compacted_resume + assistant_text
		expect(result.eventCount).toBe(2);

		const targetEvents = store.read("target");
		// 2 events + synthetic tool_call + synthetic tool_result + fork_marker
		expect(targetEvents).toHaveLength(5);
		expect(targetEvents[0]?.type).toBe("compacted_resume");
		expect(targetEvents[1]?.type).toBe("assistant_text");
		expect(targetEvents[2]?.type).toBe("tool_call");
		expect(targetEvents[3]?.type).toBe("tool_result");
		expect(targetEvents[4]?.type).toBe("fork_marker");
	});

	test("copySessionFrom errors if source has no events", async () => {
		await expect(store.copySessionFrom("missing", "target")).rejects.toThrow(
			'Source session "missing" has no events',
		);
	});

	test("copySessionFrom errors if target already exists", async () => {
		await store.append("source", {
			type: "assistant_text",
			content: "hello",
			taskId: "source",
			ts: 1000,
		});
		await store.append("target", {
			type: "assistant_text",
			content: "existing",
			taskId: "target",
			ts: 2000,
		});

		await expect(store.copySessionFrom("source", "target")).rejects.toThrow(
			"already has session data",
		);
	});

	test("copySessionFrom with empty active context still appends fork_marker", async () => {
		// All events before compact_marker, nothing after it
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", content: "old" },
				taskId: "source",
				ts: 1000,
			},
			{
				type: "compact_marker",
				checkpoint: "cp",
				savedTokens: 100,
				taskId: "source",
				ts: 2000,
			},
		];
		await store.appendBatch("source", events);

		const result = await store.copySessionFrom("source", "target");
		expect(result.eventCount).toBe(0);

		const targetEvents = store.read("target");
		// Empty active context: synthetic tool_call + tool_result + fork_marker
		expect(targetEvents).toHaveLength(3);
		expect(targetEvents[0]?.type).toBe("tool_call");
		expect(targetEvents[1]?.type).toBe("tool_result");
		expect(targetEvents[2]?.type).toBe("fork_marker");
	});

	test("copySessionFrom stores targetTitle and targetDescription in fork_marker", async () => {
		await store.append("source", {
			type: "assistant_text",
			content: "hello",
			taskId: "source",
			ts: 1000,
		});

		const result = await store.copySessionFrom("source", "target", {
			targetTitle: "Auth simplification",
			targetDescription: "Simplify the auth flow by removing legacy endpoints",
		});
		expect(result.eventCount).toBe(1);

		const targetEvents = store.read("target");
		// 1 event + synthetic tool_call + tool_result + fork_marker
		expect(targetEvents).toHaveLength(4);
		const marker = targetEvents[3] as Extract<Event, { type: "fork_marker" }>;
		expect(marker.type).toBe("fork_marker");
		expect(marker.sourceTaskId).toBe("source");
		expect(marker.targetTitle).toBe("Auth simplification");
		expect(marker.targetDescription).toBe(
			"Simplify the auth flow by removing legacy endpoints",
		);
	});

	test("copySessionFrom omits targetTitle/targetDescription when not provided", async () => {
		await store.append("source", {
			type: "assistant_text",
			content: "hello",
			taskId: "source",
			ts: 1000,
		});

		await store.copySessionFrom("source", "target");

		const targetEvents = store.read("target");
		// 1 event + synthetic tool_call + tool_result + fork_marker
		const marker = targetEvents[3] as Extract<Event, { type: "fork_marker" }>;
		expect(marker.targetTitle).toBeUndefined();
		expect(marker.targetDescription).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Migration tests
// ---------------------------------------------------------------------------

describe("runEventMigrations", () => {
	test("returns 0 for nonexistent path", () => {
		expect(runEventMigrations("/nonexistent/path")).toBe(0);
	});

	test("strips tree_updated events from JSONL files", () => {
		const dir = join(TEST_DIR, "migration-test");
		mkdirSync(dir, { recursive: true });
		const filePath = join(dir, "test-session.events.jsonl");

		// Write a JSONL file with mixed events including tree_updated
		const lines = [
			JSON.stringify({ type: "assistant_text", text: "hello", ts: 1 }),
			JSON.stringify({ type: "tree_updated", nodes: [], ts: 2 }),
			JSON.stringify({ type: "tool_call", name: "bash", ts: 3 }),
			JSON.stringify({
				type: "tree_updated",
				nodes: [{ id: "abc" }],
				ts: 4,
			}),
			JSON.stringify({ type: "tool_result", name: "bash", ts: 5 }),
		];
		writeFileSync(filePath, lines.join("\n"));

		const migrated = runEventMigrations(dir);
		expect(migrated).toBe(1);

		// Verify tree_updated lines are removed
		const content = readFileSync(filePath, "utf-8");
		const remaining = content
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l));
		expect(remaining).toHaveLength(3);
		expect(remaining.every((e) => e.type !== "tree_updated")).toBe(true);
		expect(remaining[0]?.type).toBe("assistant_text");
		expect(remaining[1]?.type).toBe("tool_call");
		expect(remaining[2]?.type).toBe("tool_result");
	});

	test("skips files without tree_updated events", () => {
		const dir = join(TEST_DIR, "migration-clean");
		mkdirSync(dir, { recursive: true });
		const filePath = join(dir, "clean.events.jsonl");

		const lines = [
			JSON.stringify({ type: "assistant_text", text: "hello", ts: 1 }),
			JSON.stringify({ type: "tool_call", name: "bash", ts: 2 }),
		];
		writeFileSync(filePath, lines.join("\n"));

		const migrated = runEventMigrations(dir);
		expect(migrated).toBe(0);

		// Content unchanged
		const content = readFileSync(filePath, "utf-8");
		expect(content).toBe(lines.join("\n"));
	});

	test("is idempotent — running twice returns 0 on second run", () => {
		const dir = join(TEST_DIR, "migration-idempotent");
		mkdirSync(dir, { recursive: true });
		const filePath = join(dir, "session.events.jsonl");

		const lines = [
			JSON.stringify({ type: "assistant_text", text: "hello", ts: 1 }),
			JSON.stringify({ type: "tree_updated", nodes: [], ts: 2 }),
		];
		writeFileSync(filePath, lines.join("\n"));

		expect(runEventMigrations(dir)).toBe(1);
		expect(runEventMigrations(dir)).toBe(0); // no more tree_updated to remove
	});
});
