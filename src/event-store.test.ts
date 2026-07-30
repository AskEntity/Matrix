import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EventStore } from "./event-store.ts";
import type { Event } from "./events.ts";
import { stripChainFields } from "./test-utils/strip-chain-fields.ts";

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
		expect(stripChainFields(store.read("s1"))).toEqual([event]);
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
		expect(stripChainFields(store.read("s1"))).toEqual([e1, e2]);
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
		expect(stripChainFields(store.read("s1"))).toEqual(events);
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
		expect(stripChainFields(store.readActive("s1"))).toEqual(events);
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
		// The marker itself is kept — the walker treats it as structural, and
		// buildSessionRepair needs it to locate the repairable region.
		expect(active).toMatchObject([
			{ type: "compact_marker", savedTokens: 5000 },
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
		expect(active).toMatchObject([
			{ type: "compact_marker", savedTokens: 2000 },
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

	// ── readActive: the boundary that used to be a second function ───────
	//
	// These were `readFromLastCompactMarker` tests. That function applied a
	// SECOND truncation on top of the chain walk, starting at `compact_marker`,
	// and it is deleted. Where the answer is genuinely unchanged the test is
	// re-pointed; where it asserted the deleted behaviour it is INVERTED, so
	// the file says what changed instead of quietly pinning whatever falls out.

	/** The flag the deleted function returned, expressed as what it means. */
	const hasOlder = (id: string) =>
		store.readActive(id).length < store.countEvents(id);

	test("no compact_marker → every event, and no older history", async () => {
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
		expect(stripChainFields(store.readActive("s1"))).toEqual(events);
		expect(hasOlder("s1")).toBe(false);
	});

	test("an UNPAIRED compact_marker still ends the chain at the marker", async () => {
		// Unchanged behaviour, and it is the walk's own rule rather than the
		// deleted truncation: a `compact_marker` with no `compact_started`
		// before it is a log written before `compact_started` existed, so the
		// marker is all there is to stop at.
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
			{ type: "compact_marker", savedTokens: 5000, taskId: "test", ts: 2000 },
			{
				type: "assistant_text",
				content: "new response",
				taskId: "test",
				ts: 2002,
			},
		];
		await store.appendBatch("s1", events);

		expect(hasOlder("s1")).toBe(true);
		expect(store.readActive("s1")).toMatchObject([
			{ type: "compact_marker", savedTokens: 5000, taskId: "test", ts: 2000 },
			{
				type: "assistant_text",
				content: "new response",
				taskId: "test",
				ts: 2002,
			},
		]);
	});

	test("multiple unpaired markers stop at the last one", async () => {
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", ts: 0, content: "very old" },
				taskId: "test",
				ts: 1000,
			},
			{ type: "compact_marker", savedTokens: 1000, taskId: "test", ts: 2000 },
			{ type: "assistant_text", content: "middle", taskId: "test", ts: 2001 },
			{ type: "compact_marker", savedTokens: 2000, taskId: "test", ts: 3000 },
			{ type: "assistant_text", content: "newest", taskId: "test", ts: 3001 },
		];
		await store.appendBatch("s1", events);

		expect(store.readActive("s1")).toMatchObject([
			{ type: "compact_marker", savedTokens: 2000, taskId: "test", ts: 3000 },
			{ type: "assistant_text", content: "newest", taskId: "test", ts: 3001 },
		]);
	});

	test("a marker at index 0 leaves nothing older", async () => {
		const events: Event[] = [
			{ type: "compact_marker", savedTokens: 100, taskId: "test", ts: 1000 },
			{
				type: "assistant_text",
				content: "after marker",
				taskId: "test",
				ts: 1001,
			},
		];
		await store.appendBatch("s1", events);

		expect(hasOlder("s1")).toBe(false);
		expect(stripChainFields(store.readActive("s1"))).toEqual(events);
	});

	test("a non-existent session is empty, not an error", () => {
		expect(store.readActive("missing")).toEqual([]);
		expect(hasOlder("missing")).toBe(false);
	});

	// ── INVERTED: the fork truncation is gone ────────────────────────────

	test("a forked session now KEEPS its inherited parent history", async () => {
		// ⚠️ INVERTED, not re-pointed. The deleted function treated
		// `fork_marker` as a start point, so the UI hid history the model could
		// see. A forked session's context legitimately includes it — that
		// disagreement between what the model reads and what the user is shown
		// is the thing being removed, and this test now asserts the new answer
		// rather than being re-aimed at whatever falls out.
		const events: Event[] = [
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
		];
		await store.appendBatch("forked", events);

		const active = store.readActive("forked");
		expect(active).toHaveLength(4);
		expect(active[0]).toMatchObject({ content: "parent content" });
		expect(hasOlder("forked")).toBe(false);
	});

	test("in a forked session an unpaired compact_marker still stops the walk", async () => {
		// The other half of the inversion: `fork_marker` no longer acts as a
		// barrier, but a `compact_marker` after it still does — so the change is
		// specific to fork rather than a general loosening.
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

		expect(hasOlder("forked-compact")).toBe(true);
		expect(store.readActive("forked-compact")).toMatchObject([
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

	// ── THE REGRESSION: messages delivered while the summarizer ran ──────

	test("a message inside the compaction window survives — the reason the second truncation was deleted", async () => {
		// ⚠️ THE FIXTURE HAS TO BE CONSTRUCTED, and this note is why nobody
		// should simplify it later. The chain walk ends at `compact_started`;
		// the marker is LATER; the messages delivered while the summarizer ran
		// lie between them, and `walkActiveChainIndices` splices them in
		// deliberately. `readFromLastCompactMarker` then sliced from the MARKER
		// — dropping exactly what the walk exists to preserve.
		//
		// MEASURED across this project's sessions: 38 completed compactions, 15
		// with at least one message in the window, 27 messages, overwhelmingly
		// `user` and `user_message_forwarded` — e.g. "我发现了，orchestrator根本
		// compact不了，这怎么办". Not a corner case.
		//
		// A fixture drawn from root's CURRENT tail cannot show this: its barrier
		// sits at index 0, so both behaviours return the same thing. The window
		// has to contain a message, which is why this fixture is built by hand.
		const events: Event[] = [
			{
				type: "assistant_text",
				content: "summarized away",
				taskId: "test",
				ts: 1000,
			},
			{ type: "compact_started", taskId: "test", ts: 2000 },
			{
				type: "message",
				id: "in-window",
				body: {
					source: "user",
					id: "in-window",
					ts: 2100,
					content: "typed while the summarizer was running",
				},
				taskId: "test",
				ts: 2100,
			},
			{ type: "compact_marker", savedTokens: 9000, taskId: "test", ts: 3000 },
			{
				type: "assistant_text",
				content: "after compaction",
				taskId: "test",
				ts: 4000,
			},
		];
		await store.appendBatch("s1", events);

		const active = store.readActive("s1");
		const contents = active.map((e) =>
			e.type === "message" && "content" in e.body ? e.body.content : null,
		);
		expect(contents).toContain("typed while the summarizer was running");
		// and the summarized-away history really is gone
		expect(active.map((e) => e.type)).not.toContain("assistant_text_missing");
		expect(
			active.some(
				(e) => e.type === "assistant_text" && e.content === "summarized away",
			),
		).toBe(false);
	});

	test("boundary 'past' walks through the compaction, 'stop' does not", async () => {
		const events: Event[] = [
			{
				type: "assistant_text",
				content: "summarized away",
				taskId: "test",
				ts: 1000,
			},
			{ type: "compact_started", taskId: "test", ts: 2000 },
			{ type: "compact_marker", savedTokens: 9000, taskId: "test", ts: 3000 },
			{
				type: "assistant_text",
				content: "after compaction",
				taskId: "test",
				ts: 4000,
			},
		];
		await store.appendBatch("s1", events);

		const stopped = store.readActive("s1", "stop");
		const past = store.readActive("s1", "past");
		expect(
			stopped.some(
				(e) => e.type === "assistant_text" && e.content === "summarized away",
			),
		).toBe(false);
		expect(
			past.some(
				(e) => e.type === "assistant_text" && e.content === "summarized away",
			),
		).toBe(true);
		expect(past.length).toBeGreaterThan(stopped.length);
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
		expect(result.events).toMatchObject([
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
		expect(stripChainFields(store.read("s1"))).toEqual([event]);
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
		expect(stripChainFields(store.read("s1"))).toEqual([e1]);
		expect(stripChainFields(store.read("s2"))).toEqual([e2]);
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
		//
		// BOTH writes go through the queue by reflection. They used to be W1
		// (reflection) + a real `store.append`, which no longer models this at
		// all: appends are synchronous and do not enter the queue, so W2 would
		// land BEFORE W1's slow write and the zombie's post-check would take
		// the legitimate file with it. That is not a regression in the guard —
		// it is this test's setup ceasing to describe the guard's world. The
		// guard is about queued writes; the test now uses queued writes.
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
		const w2 = privateStore.enqueueWrite("g", async () => {
			syncAppend(privateStore.path("g"), `${JSON.stringify(newEvent)}\n`);
		});

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
});

// ── streamEvents: the ONE file walk ──────────────────────────────────────

describe("EventStore.streamEvents — the one file walk", () => {
	let dir: string;
	let store: EventStore;

	beforeEach(() => {
		dir = join(TEST_DIR, "stream");
		if (existsSync(dir)) rmSync(dir, { recursive: true });
		store = new EventStore(dir);
	});
	afterEach(() => {
		if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	});

	const sample = (n: number): Event[] =>
		Array.from({ length: n }, (_, i) => ({
			type: "assistant_text" as const,
			content: `event ${i} ${"padding ".repeat(20)}`,
			taskId: "t",
			ts: 1000 + i,
		}));

	test("yields exactly what read() returns, event for event", async () => {
		// ⭐ The instrument for a driver swap: byte-identity over WHOLE outputs,
		// not over the cases someone thought to assert. Run against the real
		// 114.9MB session while building this, it compared 71,571 events and
		// found every one `JSON.stringify`-identical at the same index.
		await store.appendBatch("s1", sample(200));
		const viaRead = store.read("s1");
		const viaStream: Event[] = [];
		store.streamEvents("s1", (e) => {
			viaStream.push(e);
		});
		expect(viaStream.map((e) => JSON.stringify(e))).toEqual(
			viaRead.map((e) => JSON.stringify(e)),
		);
	});

	test("survives an event larger than the read chunk", async () => {
		// A single 1.68MB `message:user` exists in production and spans many
		// 256KB chunks. The line loop has to reassemble it.
		const big = "x".repeat(700_000);
		await store.appendBatch("s1", [
			{ type: "assistant_text", content: big, taskId: "t", ts: 1 },
			{ type: "assistant_text", content: "after", taskId: "t", ts: 2 },
		]);
		const got: Event[] = [];
		store.streamEvents("s1", (e) => {
			got.push(e);
		});
		expect(got).toHaveLength(2);
		expect((got[0] as { content: string }).content.length).toBe(700_000);
		expect((got[1] as { content: string }).content).toBe("after");
	});

	test("a multi-byte character split across a chunk boundary is not corrupted", async () => {
		// The reason a StringDecoder is used rather than a plain toString():
		// a chunk boundary can land mid-sequence, and the naive form yields
		// U+FFFD. CJK is 3 bytes each, so a long run crosses many boundaries.
		const cjk = "我记得之前做过这个优化。".repeat(30_000);
		await store.appendBatch("s1", [
			{ type: "assistant_text", content: cjk, taskId: "t", ts: 1 },
		]);
		const got: Event[] = [];
		store.streamEvents("s1", (e) => {
			got.push(e);
		});
		expect((got[0] as { content: string }).content).toBe(cjk);
		expect((got[0] as { content: string }).content).not.toContain("\uFFFD");
	});

	test("malformed lines are counted and skipped, not thrown", async () => {
		await store.appendBatch("s1", sample(2));
		await Bun.write(
			join(dir, "s1.jsonl"),
			`${await Bun.file(join(dir, "s1.jsonl")).text()}{not json\n`,
		);
		const got: Event[] = [];
		const malformed = store.streamEvents("s1", (e) => {
			got.push(e);
		});
		expect(got).toHaveLength(2);
		expect(malformed).toBe(1);
	});

	test("a missing session yields nothing and reports no damage", () => {
		let n = 0;
		expect(
			store.streamEvents("nope", () => {
				n++;
			}),
		).toBe(0);
		expect(n).toBe(0);
	});

	// ⚠️ THE property that made this a separate method rather than a tidier
	// spelling of read().
	test("streamEvents does NOT migrate an eid-less file, while read() DOES", async () => {
		// MEASURED on a copy of a real session: read() took it from 154,958 to
		// 158,980 bytes and stamped the first event. 3296 events in this
		// project carry no eid (newest 2026-04-16) and they live in the OLDEST
		// files — exactly what a search of old history is reaching for. A
		// reader that only wants to LOOK must not rewrite what it looks at.
		const path = join(dir, "old.jsonl");
		const legacy = [
			{ type: "assistant_text", content: "one", taskId: "t", ts: 1 },
			{ type: "assistant_text", content: "two", taskId: "t", ts: 2 },
		];
		await Bun.write(
			path,
			`${legacy.map((e) => JSON.stringify(e)).join("\n")}\n`,
		);
		const before = await Bun.file(path).text();

		const seen: Event[] = [];
		store.streamEvents("old", (e) => {
			seen.push(e);
		});
		expect(seen).toHaveLength(2);
		expect(await Bun.file(path).text()).toBe(before); // untouched

		// and the positive control: read() really does rewrite it, so the test
		// above is asserting a difference rather than the absence of a mechanism
		store.read("old");
		const after = await Bun.file(path).text();
		expect(after).not.toBe(before);
		expect(JSON.parse(after.split("\n")[0] as string).eid).toBeTruthy();
	});

	test("countEvents counts without materialising", async () => {
		await store.appendBatch("s1", sample(37));
		expect(store.countEvents("s1")).toBe(37);
		expect(store.countEvents("missing")).toBe(0);
	});
});

describe("EventStore.streamActive — the boundary is an argument", () => {
	let dir: string;
	let store: EventStore;

	beforeEach(() => {
		dir = join(TEST_DIR, "stream-active");
		if (existsSync(dir)) rmSync(dir, { recursive: true });
		store = new EventStore(dir);
	});
	afterEach(() => {
		if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	});

	const compacted: Event[] = [
		{ type: "assistant_text", content: "old", taskId: "t", ts: 1 },
		{ type: "compact_started", taskId: "t", ts: 2 },
		{ type: "compact_marker", savedTokens: 1, taskId: "t", ts: 3 },
		{ type: "assistant_text", content: "new", taskId: "t", ts: 4 },
	];

	const contents = (b?: "stop" | "past") => {
		const out: string[] = [];
		store.streamActive(
			"s1",
			(e) => {
				if (e.type === "assistant_text") out.push(e.content);
			},
			b,
		);
		return out;
	};

	test("'stop' hides summarized history, 'past' reaches it", async () => {
		await store.appendBatch("s1", compacted);
		expect(contents("stop")).toEqual(["new"]);
		expect(contents("past")).toEqual(["old", "new"]);
	});

	test("defaults to 'stop' — the caller that does not ask is unaffected", async () => {
		await store.appendBatch("s1", compacted);
		expect(contents()).toEqual(["new"]);
	});

	test("agrees with readActive at both settings", async () => {
		// The two forms differ only in whether they materialise. If they ever
		// disagree, one of them has grown its own idea of which events count.
		await store.appendBatch("s1", compacted);
		for (const b of ["stop", "past"] as const) {
			const streamed: string[] = [];
			store.streamActive("s1", (e) => streamed.push(e.eid ?? ""), b);
			expect(streamed).toEqual(
				store.readActive("s1", b).map((e) => e.eid ?? ""),
			);
		}
	});

	test("'past' still excludes a rolled-back branch", async () => {
		// Walking past the compaction is not walking off the chain. This is
		// what makes search unable to find text the user explicitly rewound —
		// measured at 265 of 71,524 events on the largest real session, and 0
		// on 454 of the 455 others.
		await store.appendBatch("s1", [
			{ type: "assistant_text", content: "keep", taskId: "t", ts: 1 },
		]);
		await store.flushSession("s1");
		const head = store.read("s1")[0]?.eid;
		await store.append("s1", {
			type: "assistant_text",
			content: "abandoned",
			taskId: "t",
			ts: 2,
		} as Event);
		await store.flushSession("s1");
		store.setChainHead("s1", head as string);
		await store.append("s1", {
			type: "assistant_text",
			content: "after rewind",
			taskId: "t",
			ts: 3,
		} as Event);
		await store.flushSession("s1");

		expect(contents("past")).toEqual(["keep", "after rewind"]);
	});

	test("a missing session streams nothing", () => {
		let n = 0;
		store.streamActive("nope", () => {
			n++;
		});
		expect(n).toBe(0);
	});
});

describe("EventStore.streamEvents — a file with no trailing newline", () => {
	const dir = join(TEST_DIR, "no-trailing-nl");
	afterEach(() => {
		if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	});

	test("the last line is still an event", async () => {
		// Every file this store WRITES ends in a newline, so no fixture built
		// from appendBatch can see this — the mutation that dropped the final
		// `take(pending)` survived the whole suite. `read()` returned that
		// trailing partial line (split("\n") yields it), so the streaming walk
		// has to as well or a truncated write silently loses its last event.
		const store = new EventStore(dir);
		await Bun.write(
			join(dir, "s1.jsonl"),
			`${JSON.stringify({ type: "assistant_text", content: "first", taskId: "t", ts: 1 })}\n${JSON.stringify({ type: "assistant_text", content: "last", taskId: "t", ts: 2 })}`,
		);
		const got: Event[] = [];
		store.streamEvents("s1", (e) => {
			got.push(e);
		});
		expect(got).toHaveLength(2);
		expect((got[1] as { content: string }).content).toBe("last");
		expect(store.countEvents("s1")).toBe(2);
	});
});
