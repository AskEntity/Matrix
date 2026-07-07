/**
 * SSE ring-buffer stale-ahead regression (P2.9 / Audit 7G H1).
 *
 * Bug: on daemon restart, `sseSeqCounters` resets to 0 and the ring buffer
 * empties. The browser's EventSource reconnects with `Last-Event-ID: 5000`
 * (the previous epoch's counter). The old `getEventsSince` did
 * `buffer.findIndex(e => e.seqId > 5000)` → -1 → returned `[]` meaning
 * "client is up to date". The UI kept the stale tree forever until a manual
 * reload.
 *
 * Fix: an explicit `lastSeqId > lastEntry.seqId` check returns `null`,
 * which the SSE endpoint interprets as "gap too large — send initial
 * state". This regresses the class of bug at the pure-function boundary,
 * so a future refactor that drops the check (e.g. "clean up the
 * redundant branch") will trip this test.
 *
 * Audit FU3 later shipped the proper fix on top: every SSE id carries a
 * per-daemon-incarnation epoch prefix (`<epoch>-<seq>`, see
 * `formatSseEventId` / `parseSseLastEventId` below). The seq-level checks
 * here remain the same-epoch guarantees; the epoch layer catches the case
 * these checks structurally cannot — an old-epoch cursor whose seq falls
 * INSIDE the new epoch's buffered range.
 */
import { describe, expect, test } from "bun:test";
import {
	formatSseEventId,
	getEventsSinceFromBuffer,
	parseSseLastEventId,
} from "./daemon.ts";

describe("getEventsSinceFromBuffer: stale-ahead recovery", () => {
	test("lastSeqId past the buffer tail returns null (post-restart Last-Event-ID)", () => {
		const buffer = [
			{ seqId: 1, data: "a" },
			{ seqId: 2, data: "b" },
			{ seqId: 3, data: "c" },
		];
		// Client reconnects claiming Last-Event-ID: 5000. Daemon restarted,
		// buffer is fresh (only seq 1..3). Returning `[]` would claim
		// "up to date" — wrong, the client has no events from this epoch.
		expect(getEventsSinceFromBuffer(buffer, 5000)).toBeNull();
	});

	test("lastSeqId one-past-tail returns null, not empty array", () => {
		const buffer = [
			{ seqId: 1, data: "a" },
			{ seqId: 2, data: "b" },
			{ seqId: 3, data: "c" },
		];
		// Client at 4 claims to be ahead of our current tail (3). Previous
		// implementation returned `[]`; new behavior forces initial-state.
		expect(getEventsSinceFromBuffer(buffer, 4)).toBeNull();
	});

	test("lastSeqId === tail returns empty array (genuinely up to date)", () => {
		const buffer = [
			{ seqId: 1, data: "a" },
			{ seqId: 2, data: "b" },
			{ seqId: 3, data: "c" },
		];
		expect(getEventsSinceFromBuffer(buffer, 3)).toEqual([]);
	});

	test("lastSeqId in buffer range returns missed tail slice", () => {
		const buffer = [
			{ seqId: 1, data: "a" },
			{ seqId: 2, data: "b" },
			{ seqId: 3, data: "c" },
		];
		expect(getEventsSinceFromBuffer(buffer, 1)).toEqual([
			{ seqId: 2, data: "b" },
			{ seqId: 3, data: "c" },
		]);
	});

	test("gap-too-large (lastSeqId way before head) also returns null", () => {
		// firstEntry.seqId=100 and lastSeqId=5 → gap of 95 events can't be
		// reconstructed from our ring (those entries were evicted).
		const buffer = [
			{ seqId: 100, data: "a" },
			{ seqId: 101, data: "b" },
		];
		expect(getEventsSinceFromBuffer(buffer, 5)).toBeNull();
	});

	test("empty / undefined buffer returns null", () => {
		expect(getEventsSinceFromBuffer(undefined, 0)).toBeNull();
		expect(getEventsSinceFromBuffer([], 0)).toBeNull();
	});

	test("lastSeqId === head - 1 returns full buffer (common fresh-reconnect case)", () => {
		const buffer = [
			{ seqId: 1, data: "a" },
			{ seqId: 2, data: "b" },
		];
		// firstEntry.seqId - 1 = 0 — fresh client that hasn't seen anything
		// yet from this buffer's range. Should get the whole buffer.
		expect(getEventsSinceFromBuffer(buffer, 0)).toEqual([
			{ seqId: 1, data: "a" },
			{ seqId: 2, data: "b" },
		]);
	});
});

describe("SSE epoch ids: formatSseEventId / parseSseLastEventId (Audit FU3)", () => {
	test("format emits <epoch>-<seq>", () => {
		expect(formatSseEventId("1780000000000", 42)).toBe("1780000000000-42");
	});

	test("parse ∘ format is identity", () => {
		const id = formatSseEventId("1780000000000", 7);
		expect(parseSseLastEventId(id)).toEqual({
			epoch: "1780000000000",
			seq: 7,
		});
	});

	test("legacy bare-numeric id parses with a null epoch (pre-epoch daemon cursor)", () => {
		// A client whose cursor was minted by a pre-FU3 daemon sends a bare
		// number. epoch:null never equals a real epoch → the caller treats it
		// as foreign and sends full initial state. That is the safe behavior.
		expect(parseSseLastEventId("123")).toEqual({ epoch: null, seq: 123 });
	});

	test("whitespace-padded header still parses", () => {
		expect(parseSseLastEventId(" 1780000000000-3 ")).toEqual({
			epoch: "1780000000000",
			seq: 3,
		});
	});

	test("epoch containing dashes splits on the LAST dash", () => {
		expect(parseSseLastEventId("epoch-with-dash-42")).toEqual({
			epoch: "epoch-with-dash",
			seq: 42,
		});
	});

	test("garbage headers parse to null", () => {
		expect(parseSseLastEventId(null)).toBeNull();
		expect(parseSseLastEventId("")).toBeNull();
		expect(parseSseLastEventId("abc")).toBeNull(); // no dash, not numeric
		expect(parseSseLastEventId("12-")).toBeNull(); // empty seq part
		expect(parseSseLastEventId("-5")).toBeNull(); // empty epoch part
		expect(parseSseLastEventId("12-3.5")).toBeNull(); // non-integer seq
		expect(parseSseLastEventId("12-abc")).toBeNull(); // non-numeric seq
	});
});
