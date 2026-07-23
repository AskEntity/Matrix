/**
 * Tests for message rollback — parentEid chain-walk + rollback_marker.
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
			{ type: "session_config", tools: [], systemStable: "", systemVariable: "", taskId: "t1", ts: 1, eid: "a1", parentEid: null },
			{ type: "assistant_text", content: "hello", taskId: "t1", ts: 2, eid: "a2", parentEid: "a1" },
			{ type: "tool_call", tool: "bash", toolCallId: "tc1", input: {}, taskId: "t1", ts: 3, eid: "a3", parentEid: "a2" },
		] as Event[];

		const indices = walkActiveChainIndices(events);
		expect(indices).toEqual([0, 1, 2]);
	});

	test("rollback_marker skips rolled-back events", () => {
		const events: Event[] = [
			{ type: "session_config", tools: [], systemStable: "", systemVariable: "", taskId: "t1", ts: 1, eid: "a1", parentEid: null },
			{ type: "message", id: "m1", body: { source: "user", id: "m1", content: "do X", ts: 2 }, taskId: "t1", ts: 2, eid: "a2", parentEid: "a1" },
			{ type: "messages_consumed", messageIds: ["m1"], taskId: "t1", ts: 3, eid: "a3", parentEid: "a2" },
			{ type: "assistant_text", content: "doing X", taskId: "t1", ts: 4, eid: "a4", parentEid: "a3" },
			{ type: "tool_call", tool: "bash", toolCallId: "tc1", input: {}, taskId: "t1", ts: 5, eid: "a5", parentEid: "a4" },
			// ^ events a4, a5 will be rolled back
			{ type: "rollback_marker", targetEid: "a3", taskId: "t1", ts: 6, eid: "a6", parentEid: "a3" },
			{ type: "assistant_text", content: "redoing X differently", taskId: "t1", ts: 7, eid: "a7", parentEid: "a6" },
		] as Event[];

		const indices = walkActiveChainIndices(events);
		// a4 (index 3) and a5 (index 4) should be SKIPPED
		expect(indices).toEqual([0, 1, 2, 5, 6]);
		// Verify the events at those indices
		expect(events[indices[0]]!.type).toBe("session_config");
		expect(events[indices[1]]!.type).toBe("message");
		expect(events[indices[2]]!.type).toBe("messages_consumed");
		expect(events[indices[3]]!.type).toBe("rollback_marker");
		expect(events[indices[4]]!.type).toBe("assistant_text");
		expect((events[indices[4]] as { content: string }).content).toBe("redoing X differently");
	});

	test("compact_marker terminates walk (excluded by default)", () => {
		const events: Event[] = [
			{ type: "assistant_text", content: "old", taskId: "t1", ts: 1, eid: "a1", parentEid: null },
			{ type: "compact_marker", savedTokens: 100, taskId: "t1", ts: 2, eid: "a2", parentEid: "a1" },
			{ type: "session_config", tools: [], systemStable: "", systemVariable: "", taskId: "t1", ts: 3, eid: "a3", parentEid: "a2" },
			{ type: "assistant_text", content: "new", taskId: "t1", ts: 4, eid: "a4", parentEid: "a3" },
		] as Event[];

		const indices = walkActiveChainIndices(events, false);
		// compact_marker excluded → only post-compact events
		expect(indices).toEqual([2, 3]);
	});

	test("compact_marker included when includeBarrier=true", () => {
		const events: Event[] = [
			{ type: "assistant_text", content: "old", taskId: "t1", ts: 1, eid: "a1", parentEid: null },
			{ type: "compact_marker", savedTokens: 100, taskId: "t1", ts: 2, eid: "a2", parentEid: "a1" },
			{ type: "assistant_text", content: "new", taskId: "t1", ts: 3, eid: "a3", parentEid: "a2" },
		] as Event[];

		const indices = walkActiveChainIndices(events, true);
		// compact_marker included
		expect(indices).toEqual([1, 2]);
	});

	test("chain break: falls back to linear for preceding events", () => {
		const events: Event[] = [
			{ type: "session_config", tools: [], systemStable: "", systemVariable: "", taskId: "t1", ts: 1, eid: "a1", parentEid: null },
			{ type: "assistant_text", content: "hello", taskId: "t1", ts: 2, eid: "a2", parentEid: "a1" },
			// Poison event with broken chain (parentEid: null, not first event)
			{ type: "tool_result", tool: "bash", toolCallId: "tc1", content: "POISON", isError: true, taskId: "t1", ts: 3, eid: "a3", parentEid: null },
		] as Event[];

		const indices = walkActiveChainIndices(events);
		// Chain break at a3 → fallback includes all preceding events
		expect(indices).toEqual([0, 1, 2]);
	});

	test("consecutive rollbacks: only the latest branch is active", () => {
		const events: Event[] = [
			{ type: "session_config", tools: [], systemStable: "", systemVariable: "", taskId: "t1", ts: 1, eid: "a1", parentEid: null },
			{ type: "message", id: "m1", body: { source: "user", id: "m1", content: "Q1", ts: 2 }, taskId: "t1", ts: 2, eid: "a2", parentEid: "a1" },
			{ type: "messages_consumed", messageIds: ["m1"], taskId: "t1", ts: 3, eid: "a3", parentEid: "a2" },
			{ type: "assistant_text", content: "A1 (bad)", taskId: "t1", ts: 4, eid: "a4", parentEid: "a3" },
			// First rollback: roll back to a3 (skip a4)
			{ type: "rollback_marker", targetEid: "a3", taskId: "t1", ts: 5, eid: "a5", parentEid: "a3" },
			{ type: "assistant_text", content: "A1 (also bad)", taskId: "t1", ts: 6, eid: "a6", parentEid: "a5" },
			// Second rollback: roll back to a3 again (skip a5, a6)
			{ type: "rollback_marker", targetEid: "a3", taskId: "t1", ts: 7, eid: "a7", parentEid: "a3" },
			{ type: "assistant_text", content: "A1 (good)", taskId: "t1", ts: 8, eid: "a8", parentEid: "a7" },
		] as Event[];

		const indices = walkActiveChainIndices(events);
		// Only a1, a2, a3, a7 (latest rollback_marker), a8 are active
		// a4, a5, a6 are all skipped
		expect(indices).toEqual([0, 1, 2, 6, 7]);
		expect((events[indices[3]] as { type: string }).type).toBe("rollback_marker");
		expect((events[indices[4]] as { content: string }).content).toBe("A1 (good)");
	});

	test("empty events returns empty", () => {
		expect(walkActiveChainIndices([])).toEqual([]);
	});

	test("events without eids: fallback returns all", () => {
		const events: Event[] = [
			{ type: "session_config", tools: [], systemStable: "", systemVariable: "", taskId: "t1", ts: 1 },
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

	test("readActive skips rolled-back events", async () => {
		await setup();
		// Build a session with user message + response + rollback
		await store.append("s1", {
			type: "session_config", tools: [], systemStable: "", systemVariable: "", taskId: "t1", ts: 1,
		} as Event);
		await store.append("s1", {
			type: "message", id: "m1", body: { source: "user", id: "m1", content: "do X", ts: 2 } as any, taskId: "t1", ts: 2,
		} as Event);
		await store.append("s1", {
			type: "messages_consumed", messageIds: ["m1"], taskId: "t1", ts: 3,
		} as Event);
		await store.append("s1", {
			type: "assistant_text", content: "doing X (bad response)", taskId: "t1", ts: 4,
		} as Event);
		await store.append("s1", {
			type: "tool_call", tool: "bash", toolCallId: "tc1", input: {}, taskId: "t1", ts: 5,
		} as Event);
		await store.flushSession("s1");

		// Read to find the messages_consumed eid (that's our rollback target)
		const all = store.read("s1");
		const msgsConsumed = all.find(e => e.type === "messages_consumed");
		expect(msgsConsumed?.eid).toBeDefined();

		// Append rollback_marker pointing to messages_consumed
		await store.appendRollback("s1", msgsConsumed!.eid!, "t1");
		await store.flushSession("s1");

		// readActive should skip assistant_text and tool_call (rolled back)
		const active = store.readActive("s1");
		expect(active.map(e => e.type)).toEqual([
			"session_config",
			"message",
			"messages_consumed",
			"rollback_marker",
		]);
	});

	test("readFromLastCompactMarker includes rollback_marker in UI log", async () => {
		await setup();
		await store.append("s1", {
			type: "session_config", tools: [], systemStable: "", systemVariable: "", taskId: "t1", ts: 1,
		} as Event);
		await store.append("s1", {
			type: "message", id: "m1", body: { source: "user", id: "m1", content: "Q", ts: 2 } as any, taskId: "t1", ts: 2,
		} as Event);
		await store.append("s1", {
			type: "messages_consumed", messageIds: ["m1"], taskId: "t1", ts: 3,
		} as Event);
		await store.append("s1", {
			type: "assistant_text", content: "bad", taskId: "t1", ts: 4,
		} as Event);
		await store.flushSession("s1");

		const all = store.read("s1");
		const target = all.find(e => e.type === "messages_consumed");
		await store.appendRollback("s1", target!.eid!, "t1");
		await store.append("s1", {
			type: "assistant_text", content: "good", taskId: "t1", ts: 6,
		} as Event);
		await store.flushSession("s1");

		const result = store.readFromLastCompactMarker("s1");
		// Should include rollback_marker + new events, skip rolled-back
		const types = result.events.map(e => e.type);
		expect(types).toContain("rollback_marker");
		expect(types).toContain("assistant_text");
		// Only the "good" assistant_text, not the "bad" one
		const assistantTexts = result.events.filter(
			e => e.type === "assistant_text"
		) as Array<{ content: string }>;
		expect(assistantTexts.length).toBe(1);
		expect(assistantTexts[0]!.content).toBe("good");
	});

	test("appendRollback creates event with correct parentEid", async () => {
		await setup();
		await store.append("s1", {
			type: "session_config", tools: [], systemStable: "", systemVariable: "", taskId: "t1", ts: 1,
		} as Event);
		await store.append("s1", {
			type: "assistant_text", content: "hello", taskId: "t1", ts: 2,
		} as Event);
		await store.flushSession("s1");

		const all = store.read("s1");
		const targetEid = all[0]!.eid!;

		await store.appendRollback("s1", targetEid, "t1");
		await store.flushSession("s1");

		const afterRollback = store.read("s1");
		const marker = afterRollback.find(e => e.type === "rollback_marker");
		expect(marker).toBeDefined();
		expect(marker!.parentEid).toBe(targetEid);
		expect((marker as any).targetEid).toBe(targetEid);
		expect(marker!.eid).toBeDefined();
		expect(marker!.eid).not.toBe(targetEid); // fresh eid, not same as target
	});

	test("readActiveWithLineMap returns correct physical lines for chain-walked events", async () => {
		await setup();
		await store.append("s1", {
			type: "session_config", tools: [], systemStable: "", systemVariable: "", taskId: "t1", ts: 1,
		} as Event);
		await store.append("s1", {
			type: "message", id: "m1", body: { source: "user", id: "m1", content: "Q", ts: 2 } as any, taskId: "t1", ts: 2,
		} as Event);
		await store.append("s1", {
			type: "messages_consumed", messageIds: ["m1"], taskId: "t1", ts: 3,
		} as Event);
		await store.append("s1", {
			type: "assistant_text", content: "bad", taskId: "t1", ts: 4,
		} as Event);
		await store.flushSession("s1");

		const all = store.read("s1");
		const target = all.find(e => e.type === "messages_consumed");
		await store.appendRollback("s1", target!.eid!, "t1");
		await store.append("s1", {
			type: "assistant_text", content: "good", taskId: "t1", ts: 6,
		} as Event);
		await store.flushSession("s1");

		const { events, physicalLines } = store.readActiveWithLineMap("s1");
		// 6 events total on disk (0..5), active chain skips index 3 (bad assistant_text)
		// Active: session_config(0), message(1), messages_consumed(2), rollback_marker(4), good_text(5)
		expect(events.length).toBe(5);
		expect(events.map(e => e.type)).toEqual([
			"session_config", "message", "messages_consumed", "rollback_marker", "assistant_text",
		]);
		// Physical lines skip line 3 (bad assistant_text)
		expect(physicalLines).toEqual([0, 1, 2, 4, 5]);
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
	 *   session_config → user_msg_1 → consumed_1 → assistant_1 → tool_call_1
	 *   → user_msg_2 → consumed_2 → assistant_2
	 *   → rollback_marker (back to consumed_1, rolling back everything after msg_1's response)
	 *   → user_msg_3 → consumed_3 → assistant_3  (the "edited" flow)
	 *
	 * After rollback, active events should be:
	 *   session_config, user_msg_1, consumed_1, rollback_marker, user_msg_3, consumed_3, assistant_3
	 *
	 * Rolled-back events (assistant_1, tool_call_1, user_msg_2, consumed_2, assistant_2) must NOT appear.
	 */
	async function seedSessionWithRollback(store: EventStore, sessionId: string) {
		// Pre-rollback: normal session with two user messages and responses
		await store.append(sessionId, {
			type: "session_config", tools: [], systemStable: "sys", systemVariable: "var", taskId: sessionId, ts: 1,
		} as Event);
		await store.append(sessionId, {
			type: "message", id: "m1", body: { source: "user", id: "m1", content: "first question", ts: 2 } as any, taskId: sessionId, ts: 2,
		} as Event);
		await store.append(sessionId, {
			type: "messages_consumed", messageIds: ["m1"], taskId: sessionId, ts: 3,
		} as Event);
		await store.append(sessionId, {
			type: "assistant_text", content: "first answer (will be rolled back)", taskId: sessionId, ts: 4,
		} as Event);
		await store.append(sessionId, {
			type: "tool_call", tool: "bash", toolCallId: "tc1", input: { command: "echo hi" }, taskId: sessionId, ts: 5,
		} as Event);
		await store.append(sessionId, {
			type: "tool_result", tool: "bash", toolCallId: "tc1", content: "hi", taskId: sessionId, ts: 6,
		} as Event);
		await store.append(sessionId, {
			type: "message", id: "m2", body: { source: "user", id: "m2", content: "second question (rolled back)", ts: 7 } as any, taskId: sessionId, ts: 7,
		} as Event);
		await store.append(sessionId, {
			type: "messages_consumed", messageIds: ["m2"], taskId: sessionId, ts: 8,
		} as Event);
		await store.append(sessionId, {
			type: "assistant_text", content: "second answer (rolled back)", taskId: sessionId, ts: 9,
		} as Event);
		await store.flushSession(sessionId);

		// Find the messages_consumed for m1 — that's our rollback target
		const allEvents = store.read(sessionId);
		const consumed1 = allEvents.find(
			e => e.type === "messages_consumed" && (e as any).messageIds?.[0] === "m1"
		);
		expect(consumed1?.eid).toBeDefined();

		// Append rollback_marker: jump back to after consumed_1
		await store.appendRollback(sessionId, consumed1!.eid!, sessionId);

		// Post-rollback: new user message + response (the "edited" continuation)
		await store.append(sessionId, {
			type: "message", id: "m3", body: { source: "user", id: "m3", content: "edited question", ts: 11 } as any, taskId: sessionId, ts: 11,
		} as Event);
		await store.append(sessionId, {
			type: "messages_consumed", messageIds: ["m3"], taskId: sessionId, ts: 12,
		} as Event);
		await store.append(sessionId, {
			type: "assistant_text", content: "new answer after edit", taskId: sessionId, ts: 13,
		} as Event);
		await store.flushSession(sessionId);
	}

	/** The types that SHOULD be in the active chain after rollback */
	const EXPECTED_ACTIVE_TYPES = [
		"session_config",
		"message",           // m1
		"messages_consumed", // m1 consumed
		"rollback_marker",
		"message",           // m3 (edited)
		"messages_consumed", // m3 consumed
		"assistant_text",    // new answer
	];

	/** Content strings that should NOT appear in active events */
	const ROLLED_BACK_CONTENT = [
		"first answer (will be rolled back)",
		"second question (rolled back)",
		"second answer (rolled back)",
	];

	function assertActiveEventsCorrect(events: Event[], label: string) {
		const types = events.map(e => e.type);
		expect(types).toEqual(EXPECTED_ACTIVE_TYPES);

		// Verify no rolled-back content leaks through
		const allContent = events.map(e => {
			if ("content" in e && typeof e.content === "string") return e.content;
			if ("body" in e && e.body && typeof e.body === "object" && "content" in e.body) return (e.body as any).content;
			return "";
		}).join("\n");

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
		assertActiveEventsCorrect(result.events, "readFromLastCompactMarker (refresh)");
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
		assertActiveEventsCorrect(fromCompact.events, "readFromLastCompactMarker (restart)");
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
		const immTypes = immediate.map(e => e.type);
		const refTypes = refresh.events.map(e => e.type);
		const rstTypes = restart.map(e => e.type);
		const rstRefTypes = restartRefresh.events.map(e => e.type);

		expect(refTypes).toEqual(immTypes);
		expect(rstTypes).toEqual(immTypes);
		expect(rstRefTypes).toEqual(immTypes);

		// All four must have the exact same eids (same identity)
		const immEids = immediate.map(e => e.eid);
		const refEids = refresh.events.map(e => e.eid);
		const rstEids = restart.map(e => e.eid);
		const rstRefEids = restartRefresh.events.map(e => e.eid);

		expect(refEids).toEqual(immEids);
		expect(rstEids).toEqual(immEids);
		expect(rstRefEids).toEqual(immEids);
	});

	test("readActiveWithLineMap consistency after restart", async () => {
		dataDir = await mkdtemp(join(tmpdir(), "rollback-consistency-"));
		const store1 = new EventStore(dataDir);
		await seedSessionWithRollback(store1, "s1");

		const map1 = store1.readActiveWithLineMap("s1");

		// Restart
		const store2 = new EventStore(dataDir);
		const map2 = store2.readActiveWithLineMap("s1");

		// Same events and same physical lines
		expect(map2.events.map(e => e.type)).toEqual(map1.events.map(e => e.type));
		expect(map2.physicalLines).toEqual(map1.physicalLines);
	});

	test("Multiple rollbacks: only latest branch visible across restart", async () => {
		dataDir = await mkdtemp(join(tmpdir(), "rollback-consistency-"));
		const store = new EventStore(dataDir);

		// Initial session
		await store.append("s1", {
			type: "session_config", tools: [], systemStable: "", systemVariable: "", taskId: "t1", ts: 1,
		} as Event);
		await store.append("s1", {
			type: "message", id: "m1", body: { source: "user", id: "m1", content: "original", ts: 2 } as any, taskId: "t1", ts: 2,
		} as Event);
		await store.append("s1", {
			type: "messages_consumed", messageIds: ["m1"], taskId: "t1", ts: 3,
		} as Event);
		await store.append("s1", {
			type: "assistant_text", content: "attempt 1", taskId: "t1", ts: 4,
		} as Event);
		await store.flushSession("s1");

		// First rollback
		const all1 = store.read("s1");
		const consumed = all1.find(e => e.type === "messages_consumed");
		await store.appendRollback("s1", consumed!.eid!, "t1");
		await store.append("s1", {
			type: "assistant_text", content: "attempt 2", taskId: "t1", ts: 6,
		} as Event);
		await store.flushSession("s1");

		// Second rollback (back to same point)
		const all2 = store.read("s1");
		const consumed2 = all2.find(e => e.type === "messages_consumed");
		await store.appendRollback("s1", consumed2!.eid!, "t1");
		await store.append("s1", {
			type: "assistant_text", content: "attempt 3 (final)", taskId: "t1", ts: 8,
		} as Event);
		await store.flushSession("s1");

		// Check before restart
		const activeBefore = store.readActive("s1");
		const assistantsBefore = activeBefore
			.filter(e => e.type === "assistant_text")
			.map(e => (e as any).content);
		expect(assistantsBefore).toEqual(["attempt 3 (final)"]);

		// Check after restart
		const store2 = new EventStore(dataDir);
		const activeAfter = store2.readActive("s1");
		const assistantsAfter = activeAfter
			.filter(e => e.type === "assistant_text")
			.map(e => (e as any).content);
		expect(assistantsAfter).toEqual(["attempt 3 (final)"]);

		// readFromLastCompactMarker also consistent
		const fromCompactAfter = store2.readFromLastCompactMarker("s1");
		const assistantsCompact = fromCompactAfter.events
			.filter(e => e.type === "assistant_text")
			.map(e => (e as any).content);
		expect(assistantsCompact).toEqual(["attempt 3 (final)"]);
	});
});

// ── Walker: rollback_marker is skipped ──

describe("walker: rollback_marker", () => {
	test("walkEventsToMessages skips rollback_marker", async () => {
		const { walkEventsToMessages } = await import("./event-converter.ts");
		const events: Event[] = [
			{ type: "rollback_marker", targetEid: "a3", taskId: "t1", ts: 1, eid: "a6", parentEid: "a3" },
		] as Event[];

		// Simple callbacks that track what was called
		const messages: string[] = [];
		const callbacks = {
			onUserMessage: (content: string) => { messages.push(`user:${content}`); return content; },
			onAssistantContent: () => { messages.push("assistant"); return ""; },
			onToolResults: () => { messages.push("tool_results"); return []; },
			onConsumedMessages: () => { messages.push("consumed"); },
			isWorkingContext: () => false,
		};

		walkEventsToMessages(events, callbacks);
		// rollback_marker should be skipped — no callback called
		expect(messages).toEqual([]);
	});
});
