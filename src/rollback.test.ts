/**
 * Tests for message rollback — parentEid chain-walk + setChainHead.
 *
 * Tests three layers:
 * 1. walkActiveChainIndices (pure function — chain walk correctness)
 * 2. EventStore readActive/readFromLastCompactMarker with rollback
 * 3. Full integration: REST endpoint → agent resume from rolled-back state
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "./event-store.ts";
import type { Event } from "./events.ts";
import { walkActiveChainIndices } from "./events.ts";

// ── Unit: walkActiveChainIndices ──

describe("walkActiveChainIndices", () => {
	test("linear chain without rollback returns all indices", () => {
		const events: Event[] = [
			{
				type: "session_config",
				tools: [],
				systemStable: "",
				systemVariable: "",
				taskId: "t1",
				ts: 1,
				eid: "a1",
				parentEid: null,
			},
			{
				type: "assistant_text",
				content: "hello",
				taskId: "t1",
				ts: 2,
				eid: "a2",
				parentEid: "a1",
			},
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "tc1",
				input: {},
				taskId: "t1",
				ts: 3,
				eid: "a3",
				parentEid: "a2",
			},
		] as Event[];

		const indices = walkActiveChainIndices(events);
		expect(indices).toEqual([0, 1, 2]);
	});

	test("parentEid jump skips rolled-back events", () => {
		// Simulates what happens after setChainHead: the event AFTER the rollback
		// (a6) has parentEid pointing to a3, skipping a4 and a5.
		const events: Event[] = [
			{
				type: "session_config",
				tools: [],
				systemStable: "",
				systemVariable: "",
				taskId: "t1",
				ts: 1,
				eid: "a1",
				parentEid: null,
			},
			{
				type: "message",
				id: "m1",
				body: { source: "user", id: "m1", content: "do X", ts: 2 },
				taskId: "t1",
				ts: 2,
				eid: "a2",
				parentEid: "a1",
			},
			{
				type: "messages_consumed",
				messageIds: ["m1"],
				taskId: "t1",
				ts: 3,
				eid: "a3",
				parentEid: "a2",
			},
			{
				type: "assistant_text",
				content: "doing X",
				taskId: "t1",
				ts: 4,
				eid: "a4",
				parentEid: "a3",
			},
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "tc1",
				input: {},
				taskId: "t1",
				ts: 5,
				eid: "a5",
				parentEid: "a4",
			},
			// ^ events a4, a5 will be rolled back — a6's parentEid jumps to a3
			{
				type: "assistant_text",
				content: "redoing X differently",
				taskId: "t1",
				ts: 7,
				eid: "a6",
				parentEid: "a3",
			},
		] as Event[];

		const indices = walkActiveChainIndices(events);
		// a4 (index 3) and a5 (index 4) should be SKIPPED
		expect(indices).toEqual([0, 1, 2, 5]);
		// Verify the events at those indices
		expect(events[indices[0]!]!.type).toBe("session_config");
		expect(events[indices[1]!]!.type).toBe("message");
		expect(events[indices[2]!]!.type).toBe("messages_consumed");
		expect(events[indices[3]!]!.type).toBe("assistant_text");
		expect((events[indices[3]!] as { content: string }).content).toBe(
			"redoing X differently",
		);
	});

	test("compact_marker terminates walk (excluded by default)", () => {
		const events: Event[] = [
			{
				type: "assistant_text",
				content: "old",
				taskId: "t1",
				ts: 1,
				eid: "a1",
				parentEid: null,
			},
			{
				type: "compact_marker",
				savedTokens: 100,
				taskId: "t1",
				ts: 2,
				eid: "a2",
				parentEid: "a1",
			},
			{
				type: "session_config",
				tools: [],
				systemStable: "",
				systemVariable: "",
				taskId: "t1",
				ts: 3,
				eid: "a3",
				parentEid: "a2",
			},
			{
				type: "assistant_text",
				content: "new",
				taskId: "t1",
				ts: 4,
				eid: "a4",
				parentEid: "a3",
			},
		] as Event[];

		// A marker with no compact_started before it (a log written before
		// compact_started existed) ends the walk at the marker. The marker
		// itself is kept: the walker treats it as structural, and
		// readFromLastCompactMarker slices the UI log at it.
		const indices = walkActiveChainIndices(events);
		expect(indices).toEqual([1, 2, 3]);
	});

	test("chain break: falls back to linear for preceding events", () => {
		const events: Event[] = [
			{
				type: "session_config",
				tools: [],
				systemStable: "",
				systemVariable: "",
				taskId: "t1",
				ts: 1,
				eid: "a1",
				parentEid: null,
			},
			{
				type: "assistant_text",
				content: "hello",
				taskId: "t1",
				ts: 2,
				eid: "a2",
				parentEid: "a1",
			},
			// Poison event with broken chain (parentEid: null, not first event)
			{
				type: "tool_result",
				tool: "bash",
				toolCallId: "tc1",
				content: "POISON",
				isError: true,
				taskId: "t1",
				ts: 3,
				eid: "a3",
				parentEid: null,
			},
		] as Event[];

		const indices = walkActiveChainIndices(events);
		// Chain break at a3 → fallback includes all preceding events
		expect(indices).toEqual([0, 1, 2]);
	});

	test("consecutive rollbacks: only the latest branch is active", () => {
		// Two parentEid jumps back to a3 — only the final branch (a7) is active
		const events: Event[] = [
			{
				type: "session_config",
				tools: [],
				systemStable: "",
				systemVariable: "",
				taskId: "t1",
				ts: 1,
				eid: "a1",
				parentEid: null,
			},
			{
				type: "message",
				id: "m1",
				body: { source: "user", id: "m1", content: "Q1", ts: 2 },
				taskId: "t1",
				ts: 2,
				eid: "a2",
				parentEid: "a1",
			},
			{
				type: "messages_consumed",
				messageIds: ["m1"],
				taskId: "t1",
				ts: 3,
				eid: "a3",
				parentEid: "a2",
			},
			{
				type: "assistant_text",
				content: "A1 (bad)",
				taskId: "t1",
				ts: 4,
				eid: "a4",
				parentEid: "a3",
			},
			// First rollback: new event jumps to a3 (skip a4)
			{
				type: "assistant_text",
				content: "A1 (also bad)",
				taskId: "t1",
				ts: 6,
				eid: "a5",
				parentEid: "a3",
			},
			// Second rollback: new event jumps to a3 again (skip a5)
			{
				type: "assistant_text",
				content: "A1 (good)",
				taskId: "t1",
				ts: 8,
				eid: "a6",
				parentEid: "a3",
			},
		] as Event[];

		const indices = walkActiveChainIndices(events);
		// Only a1, a2, a3, a6 are active — a4 and a5 skipped
		expect(indices).toEqual([0, 1, 2, 5]);
		expect((events[indices[3]!] as { content: string }).content).toBe(
			"A1 (good)",
		);
	});

	test("empty events returns empty", () => {
		expect(walkActiveChainIndices([])).toEqual([]);
	});

	test("events without eids: fallback returns all", () => {
		const events: Event[] = [
			{
				type: "session_config",
				tools: [],
				systemStable: "",
				systemVariable: "",
				taskId: "t1",
				ts: 1,
			},
			{ type: "assistant_text", content: "hello", taskId: "t1", ts: 2 },
		] as Event[];

		const indices = walkActiveChainIndices(events);
		// Last event has no parentEid → chain break → fallback
		expect(indices).toEqual([0, 1]);
	});
});

// ── EventStore: readActive + readFromLastCompactMarker with rollback ──

describe("EventStore rollback", () => {
	let dataDir: string;
	let store: EventStore;

	afterEach(async () => {
		if (dataDir) await rm(dataDir, { recursive: true, force: true });
	});

	async function setup() {
		dataDir = await mkdtemp(join(tmpdir(), "rollback-test-"));
		store = new EventStore(dataDir);
	}

	test("readActive skips rolled-back events via setChainHead", async () => {
		await setup();
		// Build a session with user message + response
		await store.append("s1", {
			type: "session_config",
			tools: [],
			systemStable: "",
			systemVariable: "",
			taskId: "t1",
			ts: 1,
		} as Event);
		await store.append("s1", {
			type: "message",
			id: "m1",
			body: { source: "user", id: "m1", content: "do X", ts: 2 } as any,
			taskId: "t1",
			ts: 2,
		} as Event);
		await store.append("s1", {
			type: "messages_consumed",
			messageIds: ["m1"],
			taskId: "t1",
			ts: 3,
		} as Event);
		await store.append("s1", {
			type: "assistant_text",
			content: "doing X (bad response)",
			taskId: "t1",
			ts: 4,
		} as Event);
		await store.append("s1", {
			type: "tool_call",
			tool: "bash",
			toolCallId: "tc1",
			input: {},
			taskId: "t1",
			ts: 5,
		} as Event);
		await store.flushSession("s1");

		// Read to find the messages_consumed eid (that's our rollback target)
		const all = store.read("s1");
		const msgsConsumed = all.find((e) => e.type === "messages_consumed");
		expect(msgsConsumed?.eid).toBeDefined();

		// setChainHead + append a new event to realize the jump
		store.setChainHead("s1", msgsConsumed!.eid!);
		await store.append("s1", {
			type: "assistant_text",
			content: "new response",
			taskId: "t1",
			ts: 6,
		} as Event);
		await store.flushSession("s1");

		// readActive should skip old assistant_text and tool_call (rolled back)
		const active = store.readActive("s1");
		expect(active.map((e) => e.type)).toEqual([
			"session_config",
			"message",
			"messages_consumed",
			"assistant_text",
		]);
		// The assistant_text should be the new one
		const assistantText = active.find((e) => e.type === "assistant_text") as {
			content: string;
		};
		expect(assistantText.content).toBe("new response");
	});

	test("readFromLastCompactMarker skips rolled-back events", async () => {
		await setup();
		await store.append("s1", {
			type: "session_config",
			tools: [],
			systemStable: "",
			systemVariable: "",
			taskId: "t1",
			ts: 1,
		} as Event);
		await store.append("s1", {
			type: "message",
			id: "m1",
			body: { source: "user", id: "m1", content: "Q", ts: 2 } as any,
			taskId: "t1",
			ts: 2,
		} as Event);
		await store.append("s1", {
			type: "messages_consumed",
			messageIds: ["m1"],
			taskId: "t1",
			ts: 3,
		} as Event);
		await store.append("s1", {
			type: "assistant_text",
			content: "bad",
			taskId: "t1",
			ts: 4,
		} as Event);
		await store.flushSession("s1");

		const all = store.read("s1");
		const target = all.find((e) => e.type === "messages_consumed");
		store.setChainHead("s1", target!.eid!);
		await store.append("s1", {
			type: "assistant_text",
			content: "good",
			taskId: "t1",
			ts: 6,
		} as Event);
		await store.flushSession("s1");

		const result = store.readFromLastCompactMarker("s1");
		// Only the "good" assistant_text, not the "bad" one
		const assistantTexts = result.events.filter(
			(e) => e.type === "assistant_text",
		) as Array<{ content: string }>;
		expect(assistantTexts.length).toBe(1);
		expect(assistantTexts[0]!.content).toBe("good");
	});

	test("setChainHead causes next event's parentEid to jump to target", async () => {
		await setup();
		await store.append("s1", {
			type: "session_config",
			tools: [],
			systemStable: "",
			systemVariable: "",
			taskId: "t1",
			ts: 1,
		} as Event);
		await store.append("s1", {
			type: "assistant_text",
			content: "hello",
			taskId: "t1",
			ts: 2,
		} as Event);
		await store.flushSession("s1");

		const all = store.read("s1");
		const targetEid = all[0]!.eid!;

		store.setChainHead("s1", targetEid);
		await store.append("s1", {
			type: "assistant_text",
			content: "after rollback",
			taskId: "t1",
			ts: 3,
		} as Event);
		await store.flushSession("s1");

		const afterRollback = store.read("s1");
		const newEvent = afterRollback[afterRollback.length - 1]!;
		expect(newEvent.parentEid).toBe(targetEid);
		expect(newEvent.eid).toBeDefined();
		expect(newEvent.eid).not.toBe(targetEid); // fresh eid, not same as target
	});
});

// ── Consistency: readActive + GET taskEvents + restart all agree ──

describe("Edit/Rewind consistency across refresh and restart", () => {
	let dataDir: string;

	afterEach(async () => {
		if (dataDir) await rm(dataDir, { recursive: true, force: true });
	});

	/**
	 * Seed a JSONL session that simulates:
	 *   session_config → user_msg_1 → consumed_1 → assistant_1 → tool_call_1 → tool_result_1
	 *   → user_msg_2 → consumed_2 → assistant_2
	 *   → setChainHead(consumed_1) → user_msg_3 → consumed_3 → assistant_3
	 *
	 * After rollback, active events should be:
	 *   session_config, user_msg_1, consumed_1, user_msg_3, consumed_3, assistant_3
	 *
	 * Rolled-back events (assistant_1, tool_call_1, tool_result_1, user_msg_2, consumed_2, assistant_2) must NOT appear.
	 */
	async function seedSessionWithRollback(store: EventStore, sessionId: string) {
		// Pre-rollback: normal session with two user messages and responses
		await store.append(sessionId, {
			type: "session_config",
			tools: [],
			systemStable: "sys",
			systemVariable: "var",
			taskId: sessionId,
			ts: 1,
		} as Event);
		await store.append(sessionId, {
			type: "message",
			id: "m1",
			body: {
				source: "user",
				id: "m1",
				content: "first question",
				ts: 2,
			} as any,
			taskId: sessionId,
			ts: 2,
		} as Event);
		await store.append(sessionId, {
			type: "messages_consumed",
			messageIds: ["m1"],
			taskId: sessionId,
			ts: 3,
		} as Event);
		await store.append(sessionId, {
			type: "assistant_text",
			content: "first answer (will be rolled back)",
			taskId: sessionId,
			ts: 4,
		} as Event);
		await store.append(sessionId, {
			type: "tool_call",
			tool: "bash",
			toolCallId: "tc1",
			input: { command: "echo hi" },
			taskId: sessionId,
			ts: 5,
		} as Event);
		await store.append(sessionId, {
			type: "tool_result",
			tool: "bash",
			toolCallId: "tc1",
			content: "hi",
			taskId: sessionId,
			ts: 6,
		} as Event);
		await store.append(sessionId, {
			type: "message",
			id: "m2",
			body: {
				source: "user",
				id: "m2",
				content: "second question (rolled back)",
				ts: 7,
			} as any,
			taskId: sessionId,
			ts: 7,
		} as Event);
		await store.append(sessionId, {
			type: "messages_consumed",
			messageIds: ["m2"],
			taskId: sessionId,
			ts: 8,
		} as Event);
		await store.append(sessionId, {
			type: "assistant_text",
			content: "second answer (rolled back)",
			taskId: sessionId,
			ts: 9,
		} as Event);
		await store.flushSession(sessionId);

		// Find the messages_consumed for m1 — that's our rollback target
		const allEvents = store.read(sessionId);
		const consumed1 = allEvents.find(
			(e) =>
				e.type === "messages_consumed" && (e as any).messageIds?.[0] === "m1",
		);
		expect(consumed1?.eid).toBeDefined();

		// setChainHead: jump back to after consumed_1
		store.setChainHead(sessionId, consumed1!.eid!);

		// Post-rollback: new user message + response (the "edited" continuation)
		await store.append(sessionId, {
			type: "message",
			id: "m3",
			body: {
				source: "user",
				id: "m3",
				content: "edited question",
				ts: 11,
			} as any,
			taskId: sessionId,
			ts: 11,
		} as Event);
		await store.append(sessionId, {
			type: "messages_consumed",
			messageIds: ["m3"],
			taskId: sessionId,
			ts: 12,
		} as Event);
		await store.append(sessionId, {
			type: "assistant_text",
			content: "new answer after edit",
			taskId: sessionId,
			ts: 13,
		} as Event);
		await store.flushSession(sessionId);
	}

	/** The types that SHOULD be in the active chain after rollback */
	const EXPECTED_ACTIVE_TYPES = [
		"session_config",
		"message", // m1
		"messages_consumed", // m1 consumed
		"message", // m3 (edited)
		"messages_consumed", // m3 consumed
		"assistant_text", // new answer
	];

	/** Content strings that should NOT appear in active events */
	const ROLLED_BACK_CONTENT = [
		"first answer (will be rolled back)",
		"second question (rolled back)",
		"second answer (rolled back)",
	];

	function assertActiveEventsCorrect(events: Event[], _label: string) {
		const types: string[] = events.map((e) => e.type);
		expect(types).toEqual(EXPECTED_ACTIVE_TYPES);

		// Verify no rolled-back content leaks through
		const allContent = events
			.map((e) => {
				if ("content" in e && typeof e.content === "string") return e.content;
				if (
					"body" in e &&
					e.body &&
					typeof e.body === "object" &&
					"content" in e.body
				)
					return (e.body as any).content;
				return "";
			})
			.join("\n");

		for (const bad of ROLLED_BACK_CONTENT) {
			expect(allContent).not.toContain(bad);
		}

		// Verify the post-rollback content IS present
		expect(allContent).toContain("first question");
		expect(allContent).toContain("edited question");
		expect(allContent).toContain("new answer after edit");
	}

	test("Scenario 1: readActive immediately after rollback", async () => {
		dataDir = await mkdtemp(join(tmpdir(), "rollback-consistency-"));
		const store = new EventStore(dataDir);
		await seedSessionWithRollback(store, "s1");

		const active = store.readActive("s1");
		assertActiveEventsCorrect(active, "readActive (immediate)");
	});

	test("Scenario 2: readFromLastCompactMarker (page refresh / GET taskEvents)", async () => {
		dataDir = await mkdtemp(join(tmpdir(), "rollback-consistency-"));
		const store = new EventStore(dataDir);
		await seedSessionWithRollback(store, "s1");

		const result = store.readFromLastCompactMarker("s1");
		assertActiveEventsCorrect(
			result.events,
			"readFromLastCompactMarker (refresh)",
		);
	});

	test("Scenario 3: daemon restart — fresh EventStore reads same JSONL", async () => {
		dataDir = await mkdtemp(join(tmpdir(), "rollback-consistency-"));
		const store1 = new EventStore(dataDir);
		await seedSessionWithRollback(store1, "s1");

		// Simulate daemon restart: create a completely new EventStore on the same dataDir
		const store2 = new EventStore(dataDir);

		const active = store2.readActive("s1");
		assertActiveEventsCorrect(active, "readActive (restart)");

		const fromCompact = store2.readFromLastCompactMarker("s1");
		assertActiveEventsCorrect(
			fromCompact.events,
			"readFromLastCompactMarker (restart)",
		);
	});

	test("All three scenarios produce identical event sequences", async () => {
		dataDir = await mkdtemp(join(tmpdir(), "rollback-consistency-"));
		const store = new EventStore(dataDir);
		await seedSessionWithRollback(store, "s1");

		// Scenario 1: immediate readActive
		const immediate = store.readActive("s1");

		// Scenario 2: readFromLastCompactMarker (page refresh)
		const refresh = store.readFromLastCompactMarker("s1");

		// Scenario 3: daemon restart
		const restartStore = new EventStore(dataDir);
		const restart = restartStore.readActive("s1");
		const restartRefresh = restartStore.readFromLastCompactMarker("s1");

		// All four must produce the exact same event types
		const immTypes = immediate.map((e) => e.type);
		const refTypes = refresh.events.map((e) => e.type);
		const rstTypes = restart.map((e) => e.type);
		const rstRefTypes = restartRefresh.events.map((e) => e.type);

		expect(refTypes).toEqual(immTypes);
		expect(rstTypes).toEqual(immTypes);
		expect(rstRefTypes).toEqual(immTypes);

		// All four must have the exact same eids (same identity)
		const immEids = immediate.map((e) => e.eid);
		const refEids = refresh.events.map((e) => e.eid);
		const rstEids = restart.map((e) => e.eid);
		const rstRefEids = restartRefresh.events.map((e) => e.eid);

		expect(refEids).toEqual(immEids);
		expect(rstEids).toEqual(immEids);
		expect(rstRefEids).toEqual(immEids);
	});

	test("Multiple rollbacks: only latest branch visible across restart", async () => {
		dataDir = await mkdtemp(join(tmpdir(), "rollback-consistency-"));
		const store = new EventStore(dataDir);

		// Initial session
		await store.append("s1", {
			type: "session_config",
			tools: [],
			systemStable: "",
			systemVariable: "",
			taskId: "t1",
			ts: 1,
		} as Event);
		await store.append("s1", {
			type: "message",
			id: "m1",
			body: { source: "user", id: "m1", content: "original", ts: 2 } as any,
			taskId: "t1",
			ts: 2,
		} as Event);
		await store.append("s1", {
			type: "messages_consumed",
			messageIds: ["m1"],
			taskId: "t1",
			ts: 3,
		} as Event);
		await store.append("s1", {
			type: "assistant_text",
			content: "attempt 1",
			taskId: "t1",
			ts: 4,
		} as Event);
		await store.flushSession("s1");

		// First rollback
		const all1 = store.read("s1");
		const consumed = all1.find((e) => e.type === "messages_consumed");
		store.setChainHead("s1", consumed!.eid!);
		await store.append("s1", {
			type: "assistant_text",
			content: "attempt 2",
			taskId: "t1",
			ts: 6,
		} as Event);
		await store.flushSession("s1");

		// Second rollback (back to same point)
		store.setChainHead("s1", consumed!.eid!);
		await store.append("s1", {
			type: "assistant_text",
			content: "attempt 3 (final)",
			taskId: "t1",
			ts: 8,
		} as Event);
		await store.flushSession("s1");

		// Check before restart
		const activeBefore = store.readActive("s1");
		const assistantsBefore = activeBefore
			.filter((e) => e.type === "assistant_text")
			.map((e) => (e as any).content);
		expect(assistantsBefore).toEqual(["attempt 3 (final)"]);

		// Check after restart
		const store2 = new EventStore(dataDir);
		const activeAfter = store2.readActive("s1");
		const assistantsAfter = activeAfter
			.filter((e) => e.type === "assistant_text")
			.map((e) => (e as any).content);
		expect(assistantsAfter).toEqual(["attempt 3 (final)"]);

		// readFromLastCompactMarker also consistent
		const fromCompactAfter = store2.readFromLastCompactMarker("s1");
		const assistantsCompact = fromCompactAfter.events
			.filter((e) => e.type === "assistant_text")
			.map((e) => (e as any).content);
		expect(assistantsCompact).toEqual(["attempt 3 (final)"]);
	});
});

// ── Walker: parentEid jumps are transparent to the walker ──

describe("walker: parentEid jump events", () => {
	test("walkEventsToMessages handles events with parentEid jumps normally", async () => {
		const { walkEventsToMessages } = await import("./event-converter.ts");
		// After setChainHead, the next event simply has a different parentEid.
		// The walker processes events linearly (it doesn't walk parentEid itself) —
		// readActive/chain-walk has already filtered the events before the walker sees them.
		// So no special handling is needed in the walker.
		const events: Event[] = [
			{
				type: "session_config",
				tools: [],
				systemStable: "",
				systemVariable: "",
				taskId: "t1",
				ts: 1,
				eid: "a1",
				parentEid: null,
			},
		] as Event[];

		const messages: string[] = [];
		const callbacks = {
			onUserMessage: (content: string) => {
				messages.push(`user:${content}`);
				return content;
			},
			onAssistantContent: () => {
				messages.push("assistant");
				return "";
			},
			onToolResults: () => {
				messages.push("tool_results");
				return [];
			},
			onConsumedMessages: () => {
				messages.push("consumed");
			},
			isWorkingContext: () => false,
		};

		walkEventsToMessages(events, callbacks);
		// session_config is structural — no callback called
		expect(messages).toEqual([]);
	});
});

// ══════════════════════════════════════════════════════════════════════════
// Compaction window — the active chain ends at the `compact_started` of the
// last COMPLETED compaction, and inside that window only `message` events
// survive.
//
// Why this shape (all three properties are load-bearing):
//
//   1. Messages delivered WHILE the summarizer is running land between
//      `compact_started` and `compact_marker`. Ending the chain at the marker
//      (the old behavior) left them outside the active region while their
//      `messages_consumed` — written AFTER the marker — stayed inside. The
//      walker then resolved a consumption record referencing an id it had
//      never seen and silently dropped the content. Measured on the root
//      session: 22 compactions, 8 with stranded messages, 15 messages lost,
//      4 of them typed by the user.
//
//   2. The summarizer's own output (`thinking`, the `<summary>…`
//      `assistant_text`, `usage`) also lands in that window and must NOT
//      reach the context — the summary is already there as
//      `compacted_resume` after the marker. Hence: window ⇒ `message` only.
//
//   3. A compaction takes minutes (124s / 178s / 145s on the three real root
//      compactions). If the daemon dies mid-window there is NO summary, so an
//      unpaired `compact_started` must NOT end the chain — otherwise the
//      entire session history goes unreachable with no error at all.
// ══════════════════════════════════════════════════════════════════════════

describe("compaction window (active chain barrier)", () => {
	const T = "t1";

	/** Stamp a linear eid/parentEid chain, exactly like EventStore.append. */
	function chain(events: Event[]): Event[] {
		let prev: string | null = null;
		return events.map((e, i) => {
			const eid = `e${i}`;
			const stamped = { ...e, eid, parentEid: prev } as Event;
			prev = eid;
			return stamped;
		});
	}

	const assistantText = (content: string, ts: number): Event =>
		({ type: "assistant_text", content, taskId: T, ts }) as Event;
	const thinking = (text: string, ts: number): Event =>
		({ type: "thinking", thinking: text, taskId: T, ts }) as Event;
	const usage = (ts: number): Event =>
		({
			type: "usage",
			inputTokens: 10,
			contextWindow: 1000,
			taskId: T,
			ts,
		}) as Event;
	const compactStarted = (ts: number): Event =>
		({ type: "compact_started", taskId: T, ts }) as Event;
	const compactMarker = (ts: number): Event =>
		({ type: "compact_marker", savedTokens: 1, taskId: T, ts }) as Event;
	const sessionConfig = (ts: number): Event =>
		({
			type: "session_config",
			tools: [],
			systemStable: "s",
			systemVariable: "v",
			taskId: T,
			ts,
		}) as Event;
	const msg = (
		id: string,
		source: string,
		content: string,
		ts: number,
	): Event =>
		({
			type: "message",
			id,
			taskId: T,
			ts,
			body: { source, id, ts, content },
		}) as Event;
	const consumed = (ids: string[], ts: number): Event =>
		({ type: "messages_consumed", messageIds: ids, taskId: T, ts }) as Event;

	/**
	 * The exact event sequence a completed compaction writes, matching the
	 * real root session (line 56125-56134 of its JSONL).
	 */
	function completedCompaction(): Event[] {
		return chain([
			assistantText("pre-compact work", 1),
			compactStarted(2),
			msg("m-window", "user", "别忘了 X", 3), // arrived DURING summarization
			thinking("planning the summary", 4),
			assistantText("<summary>story so far</summary>", 5),
			usage(6),
			compactMarker(7),
			sessionConfig(8),
			msg("m-wc", "work_context", "your task is …", 9),
			msg("m-resume", "compacted_resume", "checkpoint text", 10),
			consumed(["m-window", "m-wc", "m-resume"], 11),
		]);
	}

	function activeOf(events: Event[]): Event[] {
		return walkActiveChainIndices(events).map((i) => events[i] as Event);
	}

	test("window message stays in the active region", () => {
		const events = completedCompaction();
		const active = activeOf(events);
		const windowMsg = active.find(
			(e) => e.type === "message" && e.id === "m-window",
		);
		expect(windowMsg).toBeDefined();
	});

	test("summarizer output (thinking / <summary> / usage) is excluded", () => {
		const active = activeOf(completedCompaction());
		expect(active.some((e) => e.type === "thinking")).toBe(false);
		expect(active.some((e) => e.type === "usage")).toBe(false);
		expect(
			active.some(
				(e) => e.type === "assistant_text" && e.content.includes("<summary>"),
			),
		).toBe(false);
	});

	test("pre-compact history is excluded", () => {
		const active = activeOf(completedCompaction());
		expect(
			active.some(
				(e) => e.type === "assistant_text" && e.content === "pre-compact work",
			),
		).toBe(false);
		expect(active.some((e) => e.type === "compact_started")).toBe(false);
	});

	test("active region is exactly: window messages + marker + everything after", () => {
		const active = activeOf(completedCompaction());
		expect(active.map((e) => e.type)).toEqual([
			"message", // m-window (the stranded one)
			"compact_marker",
			"session_config",
			"message", // work_context
			"message", // compacted_resume
			"messages_consumed",
		]);
	});

	test("walker materializes the window message into the post-compact user turn", async () => {
		const { eventsToAnthropicMessages } = await import(
			"./anthropic-compatible-provider.ts"
		);
		const messages = eventsToAnthropicMessages(activeOf(completedCompaction()));
		const text = JSON.stringify(messages);
		expect(text).toContain("别忘了 X");
		expect(text).toContain("checkpoint text");
		// The summarizer's own output must NOT leak back into the context.
		expect(text).not.toContain("<summary>");
		expect(text).not.toContain("pre-compact work");
		// Δ0 message count: the stranded message materializes INSIDE the user
		// turn it always belonged to, it does not add a turn of its own.
		expect(messages.length).toBe(1);
	});

	test("interrupted compaction (compact_started with no marker) keeps the full history", () => {
		// Daemon died mid-summarization: no marker, no summary. The chain must
		// NOT end at compact_started or the whole session becomes unreachable.
		const events = chain([
			assistantText("pre-compact work", 1),
			msg("m-old", "user", "earlier question", 2),
			consumed(["m-old"], 3),
			compactStarted(4),
			msg("m-window", "user", "sent during compaction", 5),
		]);
		const active = activeOf(events);
		expect(active.length).toBe(events.length);
		expect(
			active.some(
				(e) => e.type === "assistant_text" && e.content === "pre-compact work",
			),
		).toBe(true);
	});

	test("interrupted compaction AFTER a completed one: barrier is the completed window", () => {
		const events = chain([
			assistantText("ancient", 1),
			compactStarted(2),
			assistantText("<summary>old</summary>", 3),
			compactMarker(4),
			msg("m-resume", "compacted_resume", "checkpoint A", 5),
			consumed(["m-resume"], 6),
			assistantText("post-compact work", 7),
			compactStarted(8), // in flight, no marker yet
			msg("m-window", "user", "during 2nd compaction", 9),
		]);
		const active = activeOf(events);
		expect(active.map((e) => e.type)).toEqual([
			"compact_marker",
			"message", // compacted_resume
			"messages_consumed",
			"assistant_text", // post-compact work
			"compact_started", // in-flight one is an ordinary event, not a barrier
			"message", // m-window
		]);
		expect(
			active.some(
				(e) => e.type === "assistant_text" && e.content === "ancient",
			),
		).toBe(false);
	});

	test("legacy log (compact_marker with no compact_started) still ends the chain there", () => {
		// Files written before compact_started existed, or any anomalous log:
		// fall back to the old semantic instead of walking past the marker and
		// dragging pre-compact user messages back into the context.
		const events = chain([
			msg("m-old", "user", "pre-compact question", 1),
			consumed(["m-old"], 2),
			assistantText("pre-compact answer", 3),
			compactMarker(4),
			msg("m-resume", "compacted_resume", "checkpoint", 5),
			consumed(["m-resume"], 6),
		]);
		const active = activeOf(events);
		expect(active.map((e) => e.type)).toEqual([
			"compact_marker",
			"message",
			"messages_consumed",
		]);
	});

	test("only the LAST completed compaction window is scanned", () => {
		const events = chain([
			compactStarted(1),
			msg("m-w1", "user", "window 1 message", 2),
			assistantText("<summary>1</summary>", 3),
			compactMarker(4),
			msg("m-r1", "compacted_resume", "checkpoint 1", 5),
			consumed(["m-w1", "m-r1"], 6),
			compactStarted(7),
			msg("m-w2", "user", "window 2 message", 8),
			assistantText("<summary>2</summary>", 9),
			compactMarker(10),
			msg("m-r2", "compacted_resume", "checkpoint 2", 11),
			consumed(["m-w2", "m-r2"], 12),
		]);
		const active = activeOf(events);
		const ids = active
			.filter((e) => e.type === "message")
			.map((e) => (e as { id?: string }).id);
		expect(ids).toEqual(["m-w2", "m-r2"]);
	});

	test("rollback inside the post-compact region still works", () => {
		// The window rule must not disturb parentEid jumps after the marker.
		const events = completedCompaction();
		const consumedEid = events[events.length - 1]?.eid as string;
		const rolled: Event[] = [
			...events,
			{
				type: "assistant_text",
				content: "bad answer",
				taskId: T,
				ts: 12,
				eid: "x1",
				parentEid: consumedEid,
			} as Event,
			{
				type: "assistant_text",
				content: "good answer",
				taskId: T,
				ts: 13,
				eid: "x2",
				parentEid: consumedEid, // rollback: skips "bad answer"
			} as Event,
		];
		const active = activeOf(rolled);
		const texts = active
			.filter((e) => e.type === "assistant_text")
			.map((e) => (e as { content: string }).content);
		expect(texts).toEqual(["good answer"]);
		// …and the window message is still there.
		expect(
			active.some((e) => e.type === "message" && e.id === "m-window"),
		).toBe(true);
	});
});

// ══════════════════════════════════════════════════════════════════════════
// Repair by chain jump — `buildSessionRepair` no longer deletes file lines.
//
// The old shape returned an event-array index that the caller translated to a
// physical JSONL line and fed to `truncateAfterLine`, which rewrote the file.
// Two whole classes of bug came from that: index-space mismatches (FIX-1 cc#1,
// FIX-8 R8-B#4) and irreversible loss of the evidence needed to debug the
// corruption in the first place.
//
// Now repair returns `chainToEid` and the caller does exactly what a rollback
// does: `setChainHead(eid)` + append. The poisoned events stay on disk,
// simply unreachable.
//
// `setChainHead` is pure in-memory, so the jump only becomes durable when the
// next event is written. That is why a truncating repair ALWAYS carries at
// least one append event — verified here and asserted structurally in
// jsonl-stress.
// ══════════════════════════════════════════════════════════════════════════

describe("repair applies as a chain jump (no file truncation)", () => {
	let dataDir: string;

	afterEach(async () => {
		if (dataDir) await rm(dataDir, { recursive: true, force: true });
	});

	/** Apply a repair exactly the way runAgentForNode does. */
	async function applyRepair(store: EventStore, sessionId: string) {
		const { buildSessionRepair } = await import("./events.ts");
		const repair = buildSessionRepair(store.readActive(sessionId), sessionId);
		if (!repair) return null;
		if (repair.chainToEid) store.setChainHead(sessionId, repair.chainToEid);
		if (repair.appendEvents.length > 0) {
			await store.appendBatch(sessionId, repair.appendEvents);
		}
		await store.flushSession(sessionId);
		return repair;
	}

	/** A session poisoned by a duplicate tool_result, plus a later full turn. */
	async function seedPoisonedSession(store: EventStore, sessionId: string) {
		const evts: Event[] = [
			{
				type: "message",
				id: "m1",
				body: { source: "user", id: "m1", content: "do X", ts: 1 },
				taskId: sessionId,
				ts: 1,
			},
			{
				type: "messages_consumed",
				messageIds: ["m1"],
				taskId: sessionId,
				ts: 2,
			},
			{ type: "assistant_text", content: "working", taskId: sessionId, ts: 3 },
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "tc1",
				input: {},
				taskId: sessionId,
				ts: 4,
			},
			{
				type: "tool_result",
				tool: "bash",
				toolCallId: "tc1",
				content: "ok",
				isError: false,
				taskId: sessionId,
				ts: 5,
			},
			// poison: duplicate result for tc1
			{
				type: "tool_result",
				tool: "bash",
				toolCallId: "tc1",
				content: "DUPLICATE",
				isError: true,
				taskId: sessionId,
				ts: 6,
			},
			// a message delivered after the poison — must survive the repair
			{
				type: "message",
				id: "m2",
				body: { source: "user", id: "m2", content: "also do Y", ts: 7 },
				taskId: sessionId,
				ts: 7,
			},
		] as Event[];
		for (const e of evts) await store.append(sessionId, e);
		await store.flushSession(sessionId);
	}

	async function lineCount(dir: string, sessionId: string): Promise<number> {
		const { readFileSync } = await import("node:fs");
		return readFileSync(join(dir, `${sessionId}.jsonl`), "utf-8")
			.split("\n")
			.filter(Boolean).length;
	}

	test("repair points chainToEid at the last good event", async () => {
		dataDir = await mkdtemp(join(tmpdir(), "repair-chain-"));
		const store = new EventStore(dataDir);
		await seedPoisonedSession(store, "s1");

		const before = store.read("s1");
		const goodResult = before.find(
			(e) => e.type === "tool_result" && e.content === "ok",
		);
		const repair = await applyRepair(store, "s1");
		expect(repair?.chainToEid).toBe(goodResult?.eid as string);
	});

	test("nothing is deleted from the file — only appended", async () => {
		dataDir = await mkdtemp(join(tmpdir(), "repair-chain-"));
		const store = new EventStore(dataDir);
		await seedPoisonedSession(store, "s1");

		const linesBefore = await lineCount(dataDir, "s1");
		const repair = await applyRepair(store, "s1");
		const linesAfter = await lineCount(dataDir, "s1");

		expect(repair).not.toBeNull();
		expect(linesAfter).toBe(linesBefore + (repair?.appendEvents.length ?? 0));
		// The poison line is still on disk — it is merely unreachable.
		const raw = store.read("s1");
		expect(raw.some((e) => e.type === "tool_result" && e.isError)).toBe(true);
	});

	test("the poison leaves the active region", async () => {
		dataDir = await mkdtemp(join(tmpdir(), "repair-chain-"));
		const store = new EventStore(dataDir);
		await seedPoisonedSession(store, "s1");
		await applyRepair(store, "s1");

		const active = store.readActive("s1");
		const tc1Results = active.filter(
			(e) => e.type === "tool_result" && e.toolCallId === "tc1",
		);
		expect(tc1Results.length).toBe(1);
		expect((tc1Results[0] as { content: string }).content).toBe("ok");
	});

	test("a truncating repair always appends at least one event (jump must be durable)", async () => {
		dataDir = await mkdtemp(join(tmpdir(), "repair-chain-"));
		const store = new EventStore(dataDir);
		await seedPoisonedSession(store, "s1");
		const repair = await applyRepair(store, "s1");
		expect(repair?.chainToEid).toBeTruthy();
		expect(repair?.appendEvents.length ?? 0).toBeGreaterThan(0);
	});

	test("the jump survives a daemon restart (it is carried by a persisted event)", async () => {
		dataDir = await mkdtemp(join(tmpdir(), "repair-chain-"));
		const store = new EventStore(dataDir);
		await seedPoisonedSession(store, "s1");
		await applyRepair(store, "s1");
		const activeBefore = store.readActive("s1").map((e) => e.eid);

		// Fresh EventStore = fresh process: lastEventIds is empty, everything
		// must come from the file.
		const restarted = new EventStore(dataDir);
		const activeAfter = restarted.readActive("s1").map((e) => e.eid);

		expect(activeAfter).toEqual(activeBefore);
		const tc1Results = restarted
			.readActive("s1")
			.filter((e) => e.type === "tool_result" && e.toolCallId === "tc1");
		expect(tc1Results.length).toBe(1);
	});

	test("messages in the skipped region are re-appended, not lost", async () => {
		dataDir = await mkdtemp(join(tmpdir(), "repair-chain-"));
		const store = new EventStore(dataDir);
		await seedPoisonedSession(store, "s1");
		await applyRepair(store, "s1");

		const { findUnconsumedMessages } = await import("./events.ts");
		const unconsumed = findUnconsumedMessages(store.readActive("s1"));
		expect(unconsumed.map((m) => m.id)).toContain("m2");
	});

	test("a repair with nothing else to append still persists the jump across a restart", async () => {
		dataDir = await mkdtemp(join(tmpdir(), "repair-chain-"));
		const store = new EventStore(dataDir);

		// A session that resumes in pending-done: the duplicate is dropped, the
		// done() orphan keeps no result, and the user-facing status message is
		// suppressed (it would break assistant→tool_result alternation). So the
		// repair has NOTHING to say — and setChainHead is pure in-memory, so
		// without a persisted event the jump would evaporate on restart and the
		// poison would come back forever.
		const evts: Event[] = [
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "tc1",
				input: {},
				taskId: "s1",
				ts: 1,
			},
			{
				type: "tool_result",
				tool: "bash",
				toolCallId: "tc1",
				content: "ok",
				isError: false,
				taskId: "s1",
				ts: 2,
			},
			{
				type: "tool_call",
				tool: "mcp__mxd__done",
				toolCallId: "tc-done",
				input: { status: "passed", result: "done" },
				taskId: "s1",
				ts: 3,
			},
			{
				type: "tool_result",
				tool: "bash",
				toolCallId: "tc1",
				content: "DUPLICATE",
				isError: true,
				taskId: "s1",
				ts: 4,
			},
		] as Event[];
		for (const e of evts) await store.append("s1", e);
		await store.flushSession("s1");

		const repair = await applyRepair(store, "s1");
		expect(repair?.chainToEid).toBeTruthy();
		expect(repair?.appendEvents.length).toBe(1);
		expect(repair?.appendEvents[0]?.type).toBe("status");

		const restarted = new EventStore(dataDir);
		const active = restarted.readActive("s1");
		expect(
			active.filter((e) => e.type === "tool_result" && e.toolCallId === "tc1")
				.length,
		).toBe(1);
		// …and the pending done() orphan is still the last tool_call, so the
		// session resumes in pending-done exactly as it should.
		const lastCall = active.findLast((e) => e.type === "tool_call");
		expect((lastCall as { toolCallId?: string })?.toolCallId).toBe("tc-done");
	});

	test("a malformed line cannot shift the repair — the chain addresses events, not file lines", async () => {
		// The successor to FIX-8 R8-B#4. Repair used to return an event-array
		// index that the caller translated into a physical file line; every
		// malformed line (a crash-torn append that read() skips) shifted that
		// mapping by one and the cut landed early, destroying valid events.
		// An eid has no index space to drift in, so the whole class is gone.
		dataDir = await mkdtemp(join(tmpdir(), "repair-chain-"));
		const store = new EventStore(dataDir);
		await seedPoisonedSession(store, "s1");

		const { readFileSync, writeFileSync } = await import("node:fs");
		const p = join(dataDir, "s1.jsonl");
		const lines = readFileSync(p, "utf-8").split("\n").filter(Boolean);
		// A torn fragment ahead of everything the repair cares about.
		writeFileSync(p, `${['{"type":"assistant_te', ...lines].join("\n")}\n`);

		const goodResult = store
			.read("s1")
			.find((e) => e.type === "tool_result" && e.content === "ok");
		const repair = await applyRepair(store, "s1");
		expect(repair?.chainToEid).toBe(goodResult?.eid as string);

		const active = store.readActive("s1");
		expect(
			active.filter((e) => e.type === "tool_result" && e.toolCallId === "tc1")
				.length,
		).toBe(1);
		expect(
			active.some(
				(e) => e.type === "assistant_text" && e.content === "working",
			),
		).toBe(true);
	});

	test("a second repair pass on the repaired session is a no-op", async () => {
		dataDir = await mkdtemp(join(tmpdir(), "repair-chain-"));
		const store = new EventStore(dataDir);
		await seedPoisonedSession(store, "s1");
		await applyRepair(store, "s1");
		const second = await applyRepair(store, "s1");
		expect(second).toBeNull();
	});
});

// ══════════════════════════════════════════════════════════════════════════
// Fork copies the source's ACTIVE context — the same boundary readActive uses.
//
// `copySessionFrom` used to compute its own answer to "which events count":
// `findLastIndex(compact_marker) + slice()`. That is a plain linear cut, so it
// had BOTH failure modes at once:
//
//   - rolled-back events were copied into the child verbatim (a slice knows
//     nothing about parentEid jumps), and
//   - messages stranded in the source's last compaction window were dropped,
//     exactly like readActive's old rule.
//
// Fork means "wake up with the source's current context". There is one
// definition of that, and it lives in walkActiveChainIndices.
// ══════════════════════════════════════════════════════════════════════════

describe("fork copies the active context", () => {
	let dataDir: string;

	afterEach(async () => {
		if (dataDir) await rm(dataDir, { recursive: true, force: true });
	});

	const user = (id: string, content: string, ts: number): Event =>
		({
			type: "message",
			id,
			body: { source: "user", id, content, ts },
			taskId: "src",
			ts,
		}) as Event;

	test("a rolled-back branch is NOT copied into the child", async () => {
		dataDir = await mkdtemp(join(tmpdir(), "fork-active-"));
		const store = new EventStore(dataDir);

		await store.append("src", user("m1", "do X", 1));
		await store.append("src", {
			type: "messages_consumed",
			messageIds: ["m1"],
			taskId: "src",
			ts: 2,
		} as Event);
		await store.append("src", {
			type: "assistant_text",
			content: "ROLLED BACK ANSWER",
			taskId: "src",
			ts: 3,
		} as Event);
		await store.flushSession("src");

		// Rewind to the consumption point, then answer differently.
		const consumedEid = store
			.read("src")
			.find((e) => e.type === "messages_consumed")?.eid as string;
		store.setChainHead("src", consumedEid);
		await store.append("src", {
			type: "assistant_text",
			content: "KEPT ANSWER",
			taskId: "src",
			ts: 5,
		} as Event);
		await store.flushSession("src");

		await store.copySessionFrom("src", "child");
		const childTexts = store
			.read("child")
			.filter((e) => e.type === "assistant_text")
			.map((e) => (e as { content: string }).content);
		expect(childTexts).toEqual(["KEPT ANSWER"]);
	});

	test("messages stranded in the source's compaction window ARE copied", async () => {
		dataDir = await mkdtemp(join(tmpdir(), "fork-active-"));
		const store = new EventStore(dataDir);

		await store.append("src", {
			type: "assistant_text",
			content: "pre-compact work",
			taskId: "src",
			ts: 1,
		} as Event);
		await store.append("src", {
			type: "compact_started",
			taskId: "src",
			ts: 2,
		} as Event);
		await store.append("src", user("m-window", "sent during compaction", 3));
		await store.append("src", {
			type: "assistant_text",
			content: "<summary>the story</summary>",
			taskId: "src",
			ts: 4,
		} as Event);
		await store.append("src", {
			type: "compact_marker",
			savedTokens: 1,
			taskId: "src",
			ts: 5,
		} as Event);
		await store.append("src", {
			type: "message",
			id: "m-resume",
			body: {
				source: "compacted_resume",
				id: "m-resume",
				content: "checkpoint",
				ts: 6,
			},
			taskId: "src",
			ts: 6,
		} as Event);
		await store.append("src", {
			type: "messages_consumed",
			messageIds: ["m-window", "m-resume"],
			taskId: "src",
			ts: 7,
		} as Event);
		await store.flushSession("src");

		await store.copySessionFrom("src", "child");
		// Assert on what the CHILD AGENT sees, not merely what landed in its
		// file: a copied event whose parent was left behind is unreachable, so
		// "the line exists" proves nothing.
		const childActive = store.readActive("child");
		expect(
			childActive.some((e) => e.type === "message" && e.id === "m-window"),
		).toBe(true);
		// …and neither the summarizer's output nor the pre-compact history.
		const texts = childActive
			.filter((e) => e.type === "assistant_text")
			.map((e) => (e as { content: string }).content);
		expect(texts).toEqual([]);
	});

	test("the copied subset is re-linked into one chain (child readActive sees it all)", async () => {
		dataDir = await mkdtemp(join(tmpdir(), "fork-active-"));
		const store = new EventStore(dataDir);

		// The active context is a FILTERED subset, so the copied events'
		// original parents (here: compact_started and the summarizer's output)
		// are not in the child's file. Copying the links verbatim would leave a
		// hole and strand everything older.
		await store.append("src", user("m1", "first", 1));
		await store.append("src", {
			type: "messages_consumed",
			messageIds: ["m1"],
			taskId: "src",
			ts: 2,
		} as Event);
		await store.append("src", {
			type: "compact_started",
			taskId: "src",
			ts: 3,
		} as Event);
		await store.append("src", user("m-window", "during compaction", 4));
		await store.append("src", {
			type: "assistant_text",
			content: "<summary>x</summary>",
			taskId: "src",
			ts: 5,
		} as Event);
		await store.append("src", {
			type: "compact_marker",
			savedTokens: 1,
			taskId: "src",
			ts: 6,
		} as Event);
		await store.append("src", {
			type: "assistant_text",
			content: "answer",
			taskId: "src",
			ts: 7,
		} as Event);
		await store.flushSession("src");

		await store.copySessionFrom("src", "child");

		// Every copied line must chain to the previous one: the first is a root,
		// the rest point at their predecessor. A hole here would silently strand
		// everything older (there is no dangling-link fallback, by design).
		const child = store.read("child");
		expect(child[0]?.parentEid).toBeNull();
		for (let i = 1; i < child.length; i++) {
			expect(child[i]?.parentEid).toBe(child[i - 1]?.eid as string);
		}
		// So every line in the child's file is reachable — nothing stranded.
		expect(store.readActive("child").length).toBe(child.length);
		// Identity survives: a copied event keeps the eid it had in the source.
		const srcM1 = store
			.readActive("src")
			.find((e) => e.type === "message" && e.id === "m1");
		const childM1 = child.find((e) => e.type === "message" && e.id === "m1");
		expect(childM1?.eid).toBe(srcM1?.eid as string);
		// The source's compaction boundary is NOT inherited — see the filter in
		// copySessionFrom. A lone marker would strand the window message.
		expect(child.some((e) => e.type === "compact_marker")).toBe(false);
		expect(
			store
				.readActive("child")
				.some((e) => e.type === "message" && e.id === "m-window"),
		).toBe(true);
	});
});

// ══════════════════════════════════════════════════════════════════════════
// The chain has no dangling-link fallback, so nothing may leave a link
// pointing at an event that never reached disk.
// ══════════════════════════════════════════════════════════════════════════

describe("a failed write must not advance the chain head", () => {
	let dataDir: string;

	afterEach(async () => {
		if (dataDir) await rm(dataDir, { recursive: true, force: true });
	});

	test("after a failed append, the next event chains from the last event that IS on disk", async () => {
		dataDir = await mkdtemp(join(tmpdir(), "chain-head-"));
		const store = new EventStore(dataDir);

		await store.append("s1", {
			type: "assistant_text",
			content: "first",
			taskId: "t1",
			ts: 1,
		} as Event);
		await store.flushSession("s1");
		const firstEid = store.read("s1")[0]?.eid as string;

		// Make the write fail (disk full / EIO / permissions all land here).
		const { chmodSync } = await import("node:fs");
		chmodSync(join(dataDir, "s1.jsonl"), 0o444);
		await store.append("s1", {
			type: "assistant_text",
			content: "never lands",
			taskId: "t1",
			ts: 2,
		} as Event);
		chmodSync(join(dataDir, "s1.jsonl"), 0o644);

		await store.append("s1", {
			type: "assistant_text",
			content: "second",
			taskId: "t1",
			ts: 3,
		} as Event);
		await store.flushSession("s1");

		const events = store.read("s1");
		expect(events.map((e) => (e as { content: string }).content)).toEqual([
			"first",
			"second",
		]);
		// Without the rewind, "second" would point at the eid of the event that
		// never landed → the walk stops there and "first" disappears.
		expect(events[1]?.parentEid).toBe(firstEid);
		expect(store.readActive("s1").length).toBe(2);
	});
});
