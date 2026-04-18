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
 * The proper fix (epoch ULID in every SSE id) is out of scope. This test
 * pins the minimum guarantee we shipped under P2.9.
 */
import { describe, expect, test } from "bun:test";
import { getEventsSinceFromBuffer } from "./daemon.ts";

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
