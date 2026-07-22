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
