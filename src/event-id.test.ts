import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "./event-store.ts";
import type { Event } from "./events.ts";

const EID_PATTERN = /^[0-9a-f]{12}$/;

function makeEvent(type: string, taskId = "task-1", ts = Date.now()): Event {
	return { type, taskId, ts } as Event;
}

describe("JSONL event eid + parentEid", () => {
	let dir: string;
	let store: EventStore;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "eid-test-"));
		store = new EventStore(dir);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	// ── append stamps eid + parentEid ──

	test("append stamps eid (12-char hex) and parentEid on every event", async () => {
		const e1 = makeEvent("agent_start");
		const e2 = makeEvent("assistant_text");
		const e3 = makeEvent("tool_call");

		await store.append("s1", e1);
		await store.append("s1", e2);
		await store.append("s1", e3);

		const events = store.read("s1");
		expect(events).toHaveLength(3);

		for (const e of events) {
			expect(e.eid).toMatch(EID_PATTERN);
		}

		// First event: parentEid = null
		expect(events[0]!.parentEid).toBeNull();
		// Second event: parentEid = first event's eid
		expect(events[1]!.parentEid).toBe(events[0]!.eid);
		// Third event: parentEid = second event's eid
		expect(events[2]!.parentEid).toBe(events[1]!.eid);
	});

	test("eids are unique within a session", async () => {
		for (let i = 0; i < 100; i++) {
			await store.append("s1", makeEvent("status", "t", Date.now() + i));
		}
		const events = store.read("s1");
		const eids = events.map((e) => e.eid);
		expect(new Set(eids).size).toBe(100);
	});

	// ── appendBatch stamps correctly ──

	test("appendBatch stamps eids with correct parent chain", async () => {
		// Pre-append one event so the batch chains from it
		await store.append("s1", makeEvent("session_config"));
		const [pre] = store.read("s1");

		const batch = [
			makeEvent("assistant_text"),
			makeEvent("tool_call"),
			makeEvent("tool_result"),
		];
		await store.appendBatch("s1", batch);

		const events = store.read("s1");
		expect(events).toHaveLength(4);
		// batch[0] chains from the pre-appended event
		expect(events[1]!.parentEid).toBe(pre!.eid);
		// batch[1] chains from batch[0]
		expect(events[2]!.parentEid).toBe(events[1]!.eid);
		// batch[2] chains from batch[1]
		expect(events[3]!.parentEid).toBe(events[2]!.eid);
	});

	// ── separate sessions are independent ──

	test("sessions have independent eid chains", async () => {
		await store.append("s1", makeEvent("agent_start"));
		await store.append("s2", makeEvent("agent_start"));

		const s1 = store.read("s1");
		const s2 = store.read("s2");

		// Both first events have parentEid = null
		expect(s1[0]!.parentEid).toBeNull();
		expect(s2[0]!.parentEid).toBeNull();

		// Different eids
		expect(s1[0]!.eid).not.toBe(s2[0]!.eid);
	});

	// ── clear resets the chain ──

	test("clear resets the eid chain — next append starts fresh", async () => {
		await store.append("s1", makeEvent("agent_start"));
		store.clear("s1");

		await store.append("s1", makeEvent("agent_start"));
		const events = store.read("s1");
		expect(events).toHaveLength(1);
		expect(events[0]!.parentEid).toBeNull();
	});

	// ── migration on first read ──

	test("old JSONL without eids is auto-migrated on first read", async () => {
		// Write raw events WITHOUT eid/parentEid (simulating legacy data)
		const legacy: Event[] = [
			{
				type: "session_config",
				tools: [],
				systemStable: "",
				systemVariable: "",
				taskId: "t1",
				ts: 1000,
			} as Event,
			{
				type: "agent_start",
				taskId: "t1",
				resume: false,
				model: "test",
				provider: "test",
				ts: 2000,
			} as Event,
			{
				type: "assistant_text",
				content: "hello",
				taskId: "t1",
				ts: 3000,
			} as Event,
		];
		const filePath = join(dir, "legacy.jsonl");
		const rawContent = `${legacy.map((e) => JSON.stringify(e)).join("\n")}\n`;
		require("node:fs").writeFileSync(filePath, rawContent);

		const events = store.read("legacy");
		expect(events).toHaveLength(3);

		// All events now have eids
		for (const e of events) {
			expect(e.eid).toMatch(EID_PATTERN);
		}

		// Linear parent chain
		expect(events[0]!.parentEid).toBeNull();
		expect(events[1]!.parentEid).toBe(events[0]!.eid);
		expect(events[2]!.parentEid).toBe(events[1]!.eid);

		// File on disk was rewritten with eids
		const onDisk = readFileSync(filePath, "utf-8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		expect(onDisk[0].eid).toBe(events[0]!.eid);
		expect(onDisk[2].parentEid).toBe(events[1]!.eid);
	});

	test("migration is idempotent — second read does not re-generate eids", async () => {
		// Write legacy events
		const legacy = [
			{
				type: "agent_start",
				taskId: "t1",
				resume: false,
				model: "m",
				provider: "p",
				ts: 1000,
			},
		];
		const filePath = join(dir, "idem.jsonl");
		require("node:fs").writeFileSync(
			filePath,
			JSON.stringify(legacy[0]) + "\n",
		);

		// First read triggers migration
		const first = store.read("idem");
		const eid1 = first[0]!.eid;

		// Second read should NOT re-migrate (eid already present)
		const second = store.read("idem");
		expect(second[0]!.eid).toBe(eid1);
	});

	test("appending after migration chains from the last migrated event", async () => {
		// Write legacy event
		const filePath = join(dir, "chain.jsonl");
		require("node:fs").writeFileSync(
			filePath,
			JSON.stringify({
				type: "agent_start",
				taskId: "t1",
				resume: false,
				model: "m",
				provider: "p",
				ts: 1000,
			}) + "\n",
		);

		// Read triggers migration — sets lastEventId
		const migrated = store.read("chain");

		// Append a new event — should chain from the migrated event
		await store.append("chain", makeEvent("assistant_text"));
		const all = store.read("chain");
		expect(all).toHaveLength(2);
		expect(all[1]!.parentEid).toBe(migrated[0]!.eid);
	});

	// ── truncation updates lastEventId ──

	test("truncation updates eid chain — next append chains from last kept event", async () => {
		await store.append("s1", makeEvent("session_config"));
		await store.append("s1", makeEvent("assistant_text"));
		await store.append("s1", makeEvent("tool_call"));

		const beforeTrunc = store.read("s1");
		// Keep first 2 events (lines 0,1), truncate event at line 2
		await store.truncateAfterLine("s1", 1);

		// Append after truncation
		await store.append("s1", makeEvent("error"));

		const afterTrunc = store.read("s1");
		expect(afterTrunc).toHaveLength(3);
		// New event chains from the second (last kept) event
		expect(afterTrunc[2]!.parentEid).toBe(beforeTrunc[1]!.eid);
	});

	// ── copySessionFrom stamps synthetic events ──

	test("copySessionFrom preserves source eids and stamps synthetics + fork_marker", async () => {
		// Create source session with events
		await store.append("src", makeEvent("session_config"));
		await store.append("src", makeEvent("assistant_text"));

		const sourceEvents = store.read("src");

		// Copy to target
		await store.copySessionFrom("src", "tgt");

		const targetEvents = store.read("tgt");
		// Source events (2) + synthetic fork tool_call + tool_result + fork_marker = 5
		expect(targetEvents.length).toBeGreaterThanOrEqual(4);

		// First 2 events are copied from source — eids preserved
		expect(targetEvents[0]!.eid).toBe(sourceEvents[0]!.eid);
		expect(targetEvents[1]!.eid).toBe(sourceEvents[1]!.eid);

		// All events have eids
		for (const e of targetEvents) {
			expect(e.eid).toMatch(EID_PATTERN);
		}

		// Synthetic events chain from the last source event
		expect(targetEvents[2]!.parentEid).toBe(sourceEvents[1]!.eid);

		// Fork marker is the last event
		const forkMarker = targetEvents[targetEvents.length - 1]!;
		expect(forkMarker.type).toBe("fork_marker");
		expect(forkMarker.eid).toMatch(EID_PATTERN);

		// Appending to target chains from the fork_marker
		await store.append("tgt", makeEvent("agent_start"));
		const afterAppend = store.read("tgt");
		const last = afterAppend[afterAppend.length - 1]!;
		expect(last.parentEid).toBe(forkMarker.eid);
	});

	// ── readWithLineMap returns correct physical lines ──

	test("readWithLineMap returns events with eids and correct physical lines", async () => {
		await store.append("s1", makeEvent("session_config"));
		await store.append("s1", makeEvent("assistant_text"));

		const { events, physicalLines } = store.readWithLineMap("s1");
		expect(events).toHaveLength(2);
		expect(physicalLines).toEqual([0, 1]);
		expect(events[0]!.eid).toMatch(EID_PATTERN);
		expect(events[1]!.eid).toMatch(EID_PATTERN);
	});

	// ── eid does NOT collide with MessageEvent.id ──

	test("MessageEvent retains its own id field alongside eid", async () => {
		const msgEvent: Event = {
			type: "message",
			id: "msg-ulid-123",
			taskId: "t1",
			body: {
				source: "user",
				id: "msg-ulid-123",
				ts: Date.now(),
				content: "hello",
			} as any,
			ts: Date.now(),
		};
		await store.append("s1", msgEvent);
		const stored = store.read("s1")[0];

		// Round-trips as a MessageEvent (narrow on the discriminant — `id` is a
		// MessageEvent field, not an Event-wide one).
		expect(stored?.type).toBe("message");
		if (stored?.type !== "message") throw new Error("expected a message event");

		// MessageEvent.id (ULID) is preserved
		expect(stored.id).toBe("msg-ulid-123");
		// Event.eid (12-char hex) is added separately
		expect(stored.eid).toMatch(EID_PATTERN);
		expect(stored.eid).not.toBe("msg-ulid-123");
	});

	// ── empty appendBatch is a no-op ──

	test("appendBatch with empty array does not affect the chain", async () => {
		await store.append("s1", makeEvent("agent_start"));
		await store.appendBatch("s1", []);
		await store.append("s1", makeEvent("assistant_text"));

		const events = store.read("s1");
		expect(events).toHaveLength(2);
		expect(events[1]!.parentEid).toBe(events[0]!.eid);
	});
});

/**
 * Serialization ORDER: every line this codebase writes must start with the
 * chain fields, so a human tailing the JSONL sees the links without scanning
 * past a long `content`. Asserted on the RAW text, before JSON.parse —
 * JSON.parse is order-agnostic and would happily pass either layout.
 */
describe("JSONL eid/parentEid serialize first", () => {
	let dir: string;
	let store: EventStore;

	/** `{"eid":"<12hex>","parentEid":null|"<12hex>",` at the head of the line. */
	const CHAIN_FIRST =
		/^\{"eid":"[0-9a-f]{12}","parentEid":(null|"[0-9a-f]{12}"),/;

	function rawLines(sessionId: string): string[] {
		return readFileSync(join(dir, `${sessionId}.jsonl`), "utf-8")
			.split("\n")
			.filter(Boolean);
	}

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "eid-order-test-"));
		store = new EventStore(dir);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("append writes eid + parentEid as the first two fields", async () => {
		await store.append("s1", makeEvent("agent_start"));
		await store.append("s1", {
			type: "assistant_text",
			content: "a long reply that used to push the chain fields off screen",
			taskId: "task-1",
			ts: 1000,
		} as Event);

		const lines = rawLines("s1");
		expect(lines).toHaveLength(2);
		for (const line of lines) {
			expect(line).toMatch(CHAIN_FIRST);
		}
		// First line's parentEid is literally null, not the string "null"
		expect(lines[0]!.startsWith('{"eid":"')).toBe(true);
		expect(JSON.parse(lines[0]!).parentEid).toBeNull();
		// The event's own fields survive untouched after the chain fields
		expect(JSON.parse(lines[1]!)).toMatchObject({
			type: "assistant_text",
			content: "a long reply that used to push the chain fields off screen",
			taskId: "task-1",
			ts: 1000,
		});
	});

	test("appendBatch writes every line chain-first", async () => {
		await store.appendBatch("s1", [
			makeEvent("assistant_text"),
			makeEvent("tool_call"),
			makeEvent("tool_result"),
		]);

		const lines = rawLines("s1");
		expect(lines).toHaveLength(3);
		for (const line of lines) {
			expect(line).toMatch(CHAIN_FIRST);
		}
	});

	test("re-appending an event that already carries eid gets a FRESH chain", async () => {
		// buildSessionRepair re-appends unconsumed `message` events read from
		// the truncated region — those objects still carry their old eid /
		// parentEid. A rebuild that spread them back would re-emit a stale
		// link pointing at an event truncation just deleted.
		await store.append("s1", makeEvent("session_config"));
		await store.append("s1", makeEvent("assistant_text"));
		const [first, second] = store.read("s1");

		// Take the FIRST event (already stamped) and append it again.
		await store.append("s1", second as Event);

		const lines = rawLines("s1");
		expect(lines).toHaveLength(3);
		expect(lines[2]!).toMatch(CHAIN_FIRST);

		const reappended = JSON.parse(lines[2]!) as Event;
		// Fresh identity, not the stale one
		expect(reappended.eid).not.toBe(second!.eid);
		// Chains from the current tail, not from its original parent
		expect(reappended.parentEid).toBe(second!.eid);
		expect(reappended.parentEid).not.toBe(first!.eid);
		// Exactly one eid/parentEid key each — no duplicate leftovers
		expect(lines[2]!.match(/"eid":/g)).toHaveLength(1);
		expect(lines[2]!.match(/"parentEid":/g)).toHaveLength(1);
	});

	test("append does not mutate the caller's event object", async () => {
		const event = makeEvent("agent_start");
		await store.append("s1", event);

		expect(event.eid).toBeUndefined();
		expect(event.parentEid).toBeUndefined();
		// …but the persisted copy has both
		expect(store.read("s1")[0]!.eid).toMatch(EID_PATTERN);
	});

	test("copySessionFrom writes every line chain-first (copies + synthetics + fork_marker)", async () => {
		await store.append("src", makeEvent("session_config"));
		await store.append("src", makeEvent("assistant_text"));

		await store.copySessionFrom("src", "tgt", { targetTitle: "Child" });

		const lines = rawLines("tgt");
		expect(lines.length).toBeGreaterThanOrEqual(4);
		for (const line of lines) {
			expect(line).toMatch(CHAIN_FIRST);
		}
		// Last line is the fork_marker
		expect(JSON.parse(lines[lines.length - 1]!).type).toBe("fork_marker");
	});

	test("old tail-ordered lines and new head-ordered lines coexist in one file", async () => {
		// Files written before this change carry eid/parentEid at the END of the
		// line. They are NOT migrated (JSON.parse is order-agnostic), so a live
		// session keeps appending head-ordered lines onto tail-ordered history.
		const filePath = join(dir, "mixed.jsonl");
		const legacyTail = [
			{
				type: "agent_start",
				taskId: "t1",
				ts: 1000,
				eid: "aaaaaaaaaaaa",
				parentEid: null,
			},
			{
				type: "assistant_text",
				content: "written by the old serializer",
				taskId: "t1",
				ts: 2000,
				eid: "bbbbbbbbbbbb",
				parentEid: "aaaaaaaaaaaa",
			},
		];
		writeFileSync(
			filePath,
			`${legacyTail.map((e) => JSON.stringify(e)).join("\n")}\n`,
		);

		// Reading syncs the chain head; no migration (eid already present).
		expect(store.read("mixed")).toHaveLength(2);
		await store.append("mixed", makeEvent("tool_call"));

		const lines = rawLines("mixed");
		expect(lines).toHaveLength(3);
		// Old lines untouched, new line chain-first
		expect(lines[0]!.startsWith('{"type":"agent_start"')).toBe(true);
		expect(lines[2]!).toMatch(CHAIN_FIRST);

		// The chain reads back as one continuous history regardless of order
		const events = store.read("mixed");
		expect(events.map((e) => e.eid)).toEqual([
			"aaaaaaaaaaaa",
			"bbbbbbbbbbbb",
			expect.any(String),
		]);
		expect(events[2]!.parentEid).toBe("bbbbbbbbbbbb");
		expect(store.readActive("mixed")).toHaveLength(3);
	});

	test("legacy-file migration rewrites lines chain-first", async () => {
		const filePath = join(dir, "legacy.jsonl");
		const legacy = [
			{ type: "agent_start", taskId: "t1", ts: 1000 },
			{ type: "assistant_text", content: "hi", taskId: "t1", ts: 2000 },
		];
		writeFileSync(
			filePath,
			`${legacy.map((e) => JSON.stringify(e)).join("\n")}\n`,
		);

		// First read migrates the file in place
		const events = store.read("legacy");
		expect(events).toHaveLength(2);

		for (const line of rawLines("legacy")) {
			expect(line).toMatch(CHAIN_FIRST);
		}
	});
});
