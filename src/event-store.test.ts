import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EventStore } from "./event-store.ts";
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
			body: { source: "user", id: "test-id", ts: 0, content: "hello" },
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
			body: { source: "user", id: "test-id", ts: 0, content: "hello" },
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
				body: { source: "user", id: "test-id", ts: 0, content: "hello" },
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
			body: { source: "user", id: "test-id", ts: 0, content: "hello" },
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
				body: { source: "user", id: "test-id", ts: 0, content: "hello" },
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
				body: { source: "user", id: "test-id", ts: 0, content: "old msg" },
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
				savedTokens: 5000,
				taskId: "test",
				ts: 2000,
			},
			{
				type: "assistant_text",
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
				type: "assistant_text",
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
				body: { source: "user", id: "test-id", ts: 0, content: "very old" },
				taskId: "test",
				ts: 1000,
			},
			{
				type: "compact_marker",
				savedTokens: 1000,
				taskId: "test",
				ts: 2000,
			},
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", ts: 0, content: "somewhat old" },
				taskId: "test",
				ts: 2001,
			},
			{
				type: "compact_marker",
				savedTokens: 2000,
				taskId: "test",
				ts: 3000,
			},
			{
				type: "assistant_text",
				content: "second checkpoint",
				taskId: "test",
				ts: 3001,
			},
		];
		await store.appendBatch("s1", events);

		const active = store.readActive("s1");
		expect(active).toEqual([
			{
				type: "assistant_text",
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
				body: { source: "user", id: "test-id", ts: 0, content: "hello" },
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
				body: { source: "user", id: "test-id", ts: 0, content: "old msg" },
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
				body: { source: "user", id: "test-id", ts: 0, content: "very old" },
				taskId: "test",
				ts: 1000,
			},
			{
				type: "compact_marker",
				savedTokens: 1000,
				taskId: "test",
				ts: 2000,
			},
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", ts: 0, content: "mid" },
				taskId: "test",
				ts: 2001,
			},
			{
				type: "compact_marker",
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

	test("readFromLastCompactMarker skips pre-fork events in forked session", async () => {
		const events: Event[] = [
			// Pre-fork: copied from parent session (with parent's taskId)
			{
				type: "assistant_text",
				content: "parent content",
				taskId: "parent-id",
				ts: 1000,
			},
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "tc-1",
				input: {},
				taskId: "parent-id",
				ts: 1001,
			},
			// Fork barrier
			{
				type: "fork_marker",
				sourceTaskId: "parent-id",
				taskId: "child-id",
				ts: 2000,
			},
			// Post-fork: child's own events
			{
				type: "assistant_text",
				content: "child content",
				taskId: "child-id",
				ts: 3000,
			},
		];
		await store.appendBatch("forked", events);

		const result = store.readFromLastCompactMarker("forked");
		expect(result.hasOlderEvents).toBe(true);
		expect(result.events).toEqual([
			{
				type: "fork_marker",
				sourceTaskId: "parent-id",
				taskId: "child-id",
				ts: 2000,
			},
			{
				type: "assistant_text",
				content: "child content",
				taskId: "child-id",
				ts: 3000,
			},
		]);
	});

	test("readFromLastCompactMarker uses compact_marker when it comes after fork_marker", async () => {
		const events: Event[] = [
			{
				type: "assistant_text",
				content: "parent content",
				taskId: "parent-id",
				ts: 1000,
			},
			{
				type: "fork_marker",
				sourceTaskId: "parent-id",
				taskId: "child-id",
				ts: 2000,
			},
			{
				type: "assistant_text",
				content: "child early",
				taskId: "child-id",
				ts: 2500,
			},
			{
				type: "compact_marker",
				savedTokens: 1000,
				taskId: "child-id",
				ts: 3000,
			},
			{
				type: "assistant_text",
				content: "child latest",
				taskId: "child-id",
				ts: 4000,
			},
		];
		await store.appendBatch("forked-compact", events);

		const result = store.readFromLastCompactMarker("forked-compact");
		expect(result.hasOlderEvents).toBe(true);
		expect(result.events).toEqual([
			{
				type: "compact_marker",
				savedTokens: 1000,
				taskId: "child-id",
				ts: 3000,
			},
			{
				type: "assistant_text",
				content: "child latest",
				taskId: "child-id",
				ts: 4000,
			},
		]);
	});

	// ── readBefore ───────────────────────────────────────────────────────

	test("readBefore returns events before timestamp", async () => {
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", ts: 0, content: "first" },
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
				body: { source: "user", id: "test-id", ts: 0, content: "first" },
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
			tool: "mcp__mxd__bash",
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
			body: { source: "user", id: "test-id", ts: 0, content: "session 1" },
			taskId: "test",
			ts: 1000,
		};
		const e2: Event = {
			type: "message",
			id: "",
			body: { source: "user", id: "test-id", ts: 0, content: "session 2" },
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
				body: { source: "user", id: "test-id", ts: 0, content: "hello" },
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
				body: { source: "user", id: "test-id", ts: 0, content: "old msg" },
				taskId: "source",
				ts: 1000,
			},
			{
				type: "compact_marker",
				savedTokens: 5000,
				taskId: "source",
				ts: 2000,
			},
			{
				type: "assistant_text",
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
		expect(targetEvents[0]?.type).toBe("assistant_text");
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
				body: { source: "user", id: "test-id", ts: 0, content: "old" },
				taskId: "source",
				ts: 1000,
			},
			{
				type: "compact_marker",
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

	// ── clear() generation guard tests ──

	test("clear drops pending async writes — file stays deleted", async () => {
		// Simulate the reset_task race: writes are enqueued, then clear() is called.
		// The pending writes must NOT re-create the file after deletion.
		const event: Event = {
			type: "agent_end",
			reason: "stopped",
			taskId: "race-test",
			ts: 1000,
		};

		// Enqueue several writes (fire-and-forget, like emitEvent does)
		store.append("race-test", event);
		store.append("race-test", event);
		store.append("race-test", event);

		// Clear before writes complete — bumps generation
		store.clear("race-test");

		// Wait for all pending writes to settle
		await store.flush();

		// KEY: file must NOT exist — writes were dropped by generation guard
		expect(store.has("race-test")).toBe(false);
	});

	test("clear then new write: new write succeeds", async () => {
		// After clear, new writes (from a new agent session) should work normally.
		const oldEvent: Event = {
			type: "agent_end",
			reason: "stopped",
			taskId: "s1",
			ts: 1000,
		};
		const newEvent: Event = {
			type: "agent_start",
			taskId: "s1",
			ts: 2000,
		} as Event;

		// Old writes
		store.append("s1", oldEvent);
		store.append("s1", oldEvent);

		// Clear
		store.clear("s1");

		// New write after clear — should succeed
		await store.append("s1", newEvent);

		expect(store.has("s1")).toBe(true);
		const events = store.read("s1");
		expect(events).toHaveLength(1);
		expect(events[0]?.type).toBe("agent_start");
	});

	test("double clear: second clear is safe even with no writes", async () => {
		const event: Event = {
			type: "message",
			id: "",
			body: { source: "user", id: "dc", ts: 0, content: "x" },
			taskId: "dc-test",
			ts: 1000,
		};

		await store.append("dc-test", event);
		expect(store.has("dc-test")).toBe(true);

		store.clear("dc-test");
		store.clear("dc-test"); // second clear — no crash, no stale writes

		await store.flush();
		expect(store.has("dc-test")).toBe(false);
	});

	test("clear between appendBatch calls: only post-clear batch survives", async () => {
		const ev1: Event = {
			type: "agent_end",
			reason: "stopped",
			taskId: "ab",
			ts: 1,
		};
		const ev2: Event = {
			type: "agent_end",
			reason: "stopped",
			taskId: "ab",
			ts: 2,
		};
		const ev3: Event = {
			type: "agent_start",
			taskId: "ab",
			ts: 3,
		} as Event;

		// Enqueue batch (fire-and-forget)
		store.appendBatch("ab", [ev1, ev2]);

		// Clear before batch completes
		store.clear("ab");

		// New batch after clear
		await store.appendBatch("ab", [ev3]);

		const events = store.read("ab");
		expect(events).toHaveLength(1);
		expect(events[0]?.ts).toBe(3);
	});

	test("interleaved append-clear-append-clear: final state is empty", async () => {
		const event: Event = {
			type: "agent_end",
			reason: "stopped",
			taskId: "ic",
			ts: 1,
		};

		store.append("ic", event);
		store.clear("ic");
		store.append("ic", event);
		store.clear("ic");

		await store.flush();
		expect(store.has("ic")).toBe(false);
	});

	test("clear does not affect other sessions", async () => {
		const ev1: Event = {
			type: "agent_end",
			reason: "stopped",
			taskId: "s1",
			ts: 1,
		};
		const ev2: Event = {
			type: "agent_end",
			reason: "stopped",
			taskId: "s2",
			ts: 2,
		};

		await store.append("s1", ev1);
		await store.append("s2", ev2);

		store.clear("s1");
		await store.flush();

		expect(store.has("s1")).toBe(false);
		expect(store.has("s2")).toBe(true);
		expect(store.read("s2")).toHaveLength(1);
	});

	// ── Flake 2026-04-18: guard + write must be atomic ──

	test("race: clear during async writeFn delay → post-check unlinks zombie", async () => {
		// Regression for the 2026-04-18 flake ("Integration: resetTask JSONL
		// cleanup race > reset running agent during bash: JSONL stays deleted").
		//
		// The original bug: `enqueueWrite` only had a PRE-check — it verified
		// generation before calling writeFn but not after. Production writeFn
		// used `fs.promises.appendFile` (async libuv). Under CPU contention,
		// libuv's open(O_CREAT) could be delayed long enough that clear()
		// (running on the main thread as sync unlinkSync) would sneak in
		// between the pre-check and the actual filesystem open. The open
		// then recreated the file. JSONL "reappeared after clear".
		//
		// The production fix switches to `appendFileSync` — guard + write
		// are one atomic microtask, no window. But the guard itself also
		// gained a POST-check as defense in depth against any future caller
		// that re-introduces an async writeFn.
		//
		// This test simulates the historical race by calling the private
		// `enqueueWrite` with a deliberately slow async writeFn. The guard's
		// post-check must remove the zombie even though the writeFn completed
		// its file creation AFTER clear() ran.
		const event: Event = {
			type: "agent_end",
			reason: "stopped",
			taskId: "race",
			ts: 1,
		};
		await store.append("race", event);
		expect(store.has("race")).toBe(true);

		// Access private enqueueWrite + path via reflection. This is the
		// explicit simulation of "async writeFn with delay" — otherwise
		// unreachable via the public API after the appendFileSync switch.
		const privateStore = store as unknown as {
			enqueueWrite(sessionId: string, fn: () => Promise<void>): Promise<void>;
			path(sessionId: string): string;
		};
		const { appendFileSync: syncAppend } = await import("node:fs");

		const slowAsyncWrite = privateStore.enqueueWrite("race", async () => {
			// Simulate libuv thread pool contention: guard already passed,
			// now we delay before touching disk.
			await new Promise((r) => setTimeout(r, 30));
			// Late write — without the post-check, this creates a zombie file.
			syncAppend(privateStore.path("race"), "late write\n");
		});

		// Let guardedFn start so its pre-check runs and writeFn begins sleeping.
		await new Promise((r) => setTimeout(r, 5));

		// Clear during the sleep — file goes away, generation bumped.
		store.clear("race");
		expect(store.has("race")).toBe(false);

		// Wait for the slow write to finish. Internally it will call
		// syncAppend which (re)creates the file; the post-check must
		// detect the generation mismatch and unlink the zombie.
		await slowAsyncWrite;
		await store.flush();

		expect(store.has("race")).toBe(false);
	});

	test("race: new agent enqueues AFTER clear — new write survives post-check", async () => {
		// Critical edge: post-check MUST NOT unlink legitimate writes from a
		// NEW generation enqueued after clear. Serialization via writeQueues
		// guarantees ordering — W1 (old gen) completes (+ post-check unlinks)
		// BEFORE W2 (new gen) runs, so W2's write is not touched.
		const event: Event = {
			type: "agent_end",
			reason: "stopped",
			taskId: "g",
			ts: 1,
		};
		await store.append("g", event);
		expect(store.has("g")).toBe(true);

		const privateStore = store as unknown as {
			enqueueWrite(sessionId: string, fn: () => Promise<void>): Promise<void>;
			path(sessionId: string): string;
		};
		const { appendFileSync: syncAppend } = await import("node:fs");

		// W1 — slow async write, captures gen G0. The zombie event is VALID
		// JSON so that, if the post-check fails to remove it, `read()` returns
		// it as a real event (not silently skipped as malformed) — making the
		// test's "only agent_start survives" assertion a true mutation guard.
		const zombieEvent: Event = {
			type: "error",
			taskId: "g",
			message: "zombie from slow-async-write",
			ts: 999,
		};
		const w1 = privateStore.enqueueWrite("g", async () => {
			await new Promise((r) => setTimeout(r, 30));
			syncAppend(privateStore.path("g"), `${JSON.stringify(zombieEvent)}\n`);
		});
		await new Promise((r) => setTimeout(r, 5));

		// Clear between W1's pre-check and W1's disk write.
		store.clear("g");

		// New agent enqueues W2 (captures gen G1). Serialized behind W1.
		const newEvent: Event = {
			type: "agent_start",
			taskId: "g",
			ts: 2,
		} as Event;
		const w2 = store.append("g", newEvent);

		await Promise.all([w1, w2]);
		await store.flush();

		// W1 wrote the zombie event, post-check unlinked it. W2 then wrote
		// agent_start. Final state: file exists, contains exactly W2's event,
		// NO zombie.
		expect(store.has("g")).toBe(true);
		const events = store.read("g");
		expect(events).toHaveLength(1);
		expect(events[0]?.type).toBe("agent_start");
		expect(events.find((e) => e.type === "error")).toBeUndefined();
	});

	// ── R8-B#4: malformed lines shift truncation index ──
	// read() skips malformed JSONL lines, so parsed-event indices don't match
	// physical file lines. truncateAfterLine operates on physical lines.
	// buildSessionRepair returns event-array-relative indices. With malformed
	// lines before the cut point, the physical cut lands N lines early (one
	// per malformed line) → silently destroys valid events.
	describe("R8-B#4: malformed lines shift truncation index", () => {
		test("readWithLineMap returns events with their physical line numbers", async () => {
			const { appendFileSync } = await import("node:fs");
			const e0: Event = {
				type: "assistant_text",
				content: "event zero",
				taskId: "t",
				ts: 1000,
			};
			const e1: Event = {
				type: "assistant_text",
				content: "event one",
				taskId: "t",
				ts: 2000,
			};
			const e2: Event = {
				type: "assistant_text",
				content: "event two",
				taskId: "t",
				ts: 3000,
			};

			// Seed file: [e0, GARBAGE, e1, GARBAGE2, e2]
			// Physical lines: 0=e0, 1=GARBAGE, 2=e1, 3=GARBAGE2, 4=e2
			await store.append("m", e0);
			appendFileSync(join(TEST_DIR, "m.jsonl"), "this is not valid json\n");
			await store.append("m", e1);
			appendFileSync(join(TEST_DIR, "m.jsonl"), "another broken line\n");
			await store.append("m", e2);

			const { events, physicalLines } = store.readWithLineMap("m");
			expect(events).toHaveLength(3);
			const texts = events
				.filter((e): e is Event & { content: string } => e.type === "assistant_text")
				.map((e) => e.content);
			expect(texts).toEqual(["event zero", "event one", "event two"]);

			// Physical lines: e0=0, e1=2, e2=4 (malformed at 1 and 3)
			expect(physicalLines).toEqual([0, 2, 4]);
		});

		test("truncation after event index 2 with malformed lines preserves all 3 valid events", async () => {
			const { appendFileSync } = await import("node:fs");

			const e0: Event = {
				type: "assistant_text",
				content: "event zero",
				taskId: "t",
				ts: 1000,
			};
			const e1: Event = {
				type: "assistant_text",
				content: "event one",
				taskId: "t",
				ts: 2000,
			};
			const e2: Event = {
				type: "assistant_text",
				content: "event two",
				taskId: "t",
				ts: 3000,
			};

			// File: [e0, GARBAGE, e1, e2] — 4 physical lines
			// read() → [e0, e1, e2] — 3 events
			// physicalLines → [0, 2, 3]
			await store.append("m2", e0);
			appendFileSync(join(TEST_DIR, "m2.jsonl"), "GARBAGE\n");
			await store.append("m2", e1);
			await store.append("m2", e2);

			// To keep all 3 events, truncation must use physical line 3, not event-index 2.
			// Use readWithLineMap to get the correct physical line.
			const { events, physicalLines } = store.readWithLineMap("m2");
			expect(events).toHaveLength(3);

			// "Keep everything" = truncate after physical line of last event
			const keepAllPhysicalLine = physicalLines[events.length - 1]!;
			expect(keepAllPhysicalLine).toBe(3); // physical line 3, not event-index 2

			await store.truncateAfterLine("m2", keepAllPhysicalLine);

			// All 3 valid events survive
			const after = store.read("m2");
			expect(after).toHaveLength(3);
			const afterTexts = after
				.filter((e): e is Event & { content: string } => e.type === "assistant_text")
				.map((e) => e.content);
			expect(afterTexts).toEqual(["event zero", "event one", "event two"]);
		});

		test("BUG REPRO: using event-array index as physical line destroys the last event", async () => {
			const { appendFileSync } = await import("node:fs");

			const e0: Event = {
				type: "assistant_text",
				content: "event zero",
				taskId: "t",
				ts: 1000,
			};
			const e1: Event = {
				type: "assistant_text",
				content: "event one",
				taskId: "t",
				ts: 2000,
			};
			const e2: Event = {
				type: "assistant_text",
				content: "event two",
				taskId: "t",
				ts: 3000,
			};

			// File: [e0, GARBAGE, e1, e2] — 4 physical lines, 3 valid events
			await store.append("bug", e0);
			appendFileSync(join(TEST_DIR, "bug.jsonl"), "GARBAGE\n");
			await store.append("bug", e1);
			await store.append("bug", e2);

			// Bug: event-array index 2 (last event) used as physical line → keeps lines 0,1,2
			// Physical line 2 = e1, so e2 (physical line 3) is destroyed
			await store.truncateAfterLine("bug", 2);
			const after = store.read("bug");

			// With the bug: only 2 events survive (e0, e1). e2 at physical line 3 is gone.
			// After fix: callers would use readWithLineMap and pass physical line 3 instead.
			// This test documents the BUG behavior to prove it exists before the fix.
			expect(after).toHaveLength(2);
			const bugTexts = after
				.filter((e): e is Event & { content: string } => e.type === "assistant_text")
				.map((e) => e.content);
			expect(bugTexts).toEqual(["event zero", "event one"]);
			// e2 was destroyed — this IS the bug
		});
	});

	// ── R8-B#5: truncateAfterLine must serialize with write queue ──
	// truncateAfterLine bypasses enqueueWrite. A message persisted by
	// deliverMessage in the flush-to-truncate window lands physically then
	// gets cut by writeFileSync.
	describe("R8-B#5: truncateAfterLine serialization with write queue", () => {
		test("truncation waits for pending writes before executing", async () => {
			// Seed 2 events synchronously
			const e0: Event = {
				type: "assistant_text",
				content: "base",
				taskId: "t",
				ts: 1000,
			};
			const e1: Event = {
				type: "assistant_text",
				content: "second",
				taskId: "t",
				ts: 2000,
			};
			await store.append("q", e0);
			await store.append("q", e1);

			// Enqueue a slow write (simulating a concurrent deliverMessage)
			const e2: Event = {
				type: "assistant_text",
				content: "slow write",
				taskId: "t",
				ts: 3000,
			};
			// Use private enqueueWrite with a delay to simulate slow I/O
			const privateStore = store as unknown as {
				enqueueWrite(sessionId: string, fn: () => Promise<void>): Promise<void>;
				path(sessionId: string): string;
			};
			const { appendFileSync: syncAppend } = await import("node:fs");
			const slowWrite = privateStore.enqueueWrite("q", async () => {
				await new Promise((r) => setTimeout(r, 30));
				syncAppend(
					privateStore.path("q"),
					`${JSON.stringify(e2)}\n`,
				);
			});

			// Call truncateAfterLine immediately — should wait for the slow write
			// to complete FIRST, then truncate (keeping lines 0..2 = all 3 events)
			const truncation = store.truncateAfterLine("q", 2);

			await Promise.all([slowWrite, truncation]);

			// After fix: all 3 events present (slow write landed, truncation kept all)
			const readEvents = store.read("q");
			expect(readEvents).toHaveLength(3);
			const qTexts = readEvents
				.filter((e): e is Event & { content: string } => e.type === "assistant_text")
				.map((e) => e.content);
			expect(qTexts).toEqual(["base", "second", "slow write"]);
		});

		test("writes enqueued after truncation wait for truncation to complete", async () => {
			// Seed 4 events
			const events: Event[] = [];
			for (let i = 0; i < 4; i++) {
				const e: Event = {
					type: "assistant_text",
					content: `event-${i}`,
					taskId: "t",
					ts: 1000 + i,
				};
				events.push(e);
				await store.append("q2", e);
			}

			// Truncate to keep first 2 events (lines 0,1)
			const truncation = store.truncateAfterLine("q2", 1);

			// Immediately enqueue a new write — should execute AFTER truncation
			const newEvent: Event = {
				type: "assistant_text",
				content: "post-truncation",
				taskId: "t",
				ts: 5000,
			};
			const write = store.append("q2", newEvent);

			await Promise.all([truncation, write]);

			// After fix: [event-0, event-1, post-truncation]
			const result = store.read("q2");
			expect(result).toHaveLength(3);
			const q2Texts = result
				.filter((e): e is Event & { content: string } => e.type === "assistant_text")
				.map((e) => e.content);
			expect(q2Texts).toEqual(["event-0", "event-1", "post-truncation"]);
		});
	});
});
