import { describe, expect, test } from "bun:test";
import {
	analyzeCacheMisses,
	type CacheMissRow,
	filterByMaxGap,
	formatGap,
	formatRow,
	formatTimestamp,
	parseDuration,
} from "./cli-analyze-cache.ts";

function buildJsonl(lines: Array<Record<string, unknown>>): string {
	return lines.map((l) => JSON.stringify(l)).join("\n");
}

describe("analyzeCacheMisses", () => {
	test("flags events with hit < 93%", () => {
		const jsonl = buildJsonl([
			// miss: 32% hit
			{
				type: "usage",
				taskId: "t",
				inputTokens: 100,
				cacheReadTokens: 32,
				cacheCreationTokens: 68,
				outputTokens: 10,
				contextWindow: 200_000,
				ts: 1_000_000,
			},
			// hit: 95%
			{
				type: "usage",
				taskId: "t",
				inputTokens: 100,
				cacheReadTokens: 95,
				cacheCreationTokens: 5,
				outputTokens: 10,
				contextWindow: 200_000,
				ts: 1_000_500,
			},
			// miss: 50%
			{
				type: "usage",
				taskId: "t",
				inputTokens: 200,
				cacheReadTokens: 100,
				cacheCreationTokens: 100,
				outputTokens: 20,
				contextWindow: 200_000,
				ts: 1_001_000,
			},
		]);
		const r = analyzeCacheMisses(jsonl);
		expect(r.totalUsageEvents).toBe(3);
		expect(r.misses).toHaveLength(2);
		const first = r.misses[0];
		if (!first) throw new Error("no first miss");
		expect(first.lineNumber).toBe(1);
		expect(first.hitPct).toBeCloseTo(32);
		const second = r.misses[1];
		if (!second) throw new Error("no second miss");
		expect(second.lineNumber).toBe(3);
		expect(second.hitPct).toBeCloseTo(50);
	});

	test("hit exactly 93% is NOT a miss", () => {
		const jsonl = buildJsonl([
			{
				type: "usage",
				taskId: "t",
				inputTokens: 100,
				cacheReadTokens: 93,
				outputTokens: 10,
				contextWindow: 200_000,
				ts: 1_000,
			},
		]);
		const r = analyzeCacheMisses(jsonl);
		expect(r.misses).toHaveLength(0);
		expect(r.totalUsageEvents).toBe(1);
	});

	test("skips inputTokens === 0 (garbage row)", () => {
		const jsonl = buildJsonl([
			{
				type: "usage",
				taskId: "t",
				inputTokens: 0,
				cacheReadTokens: 0,
				outputTokens: 0,
				contextWindow: 200_000,
				ts: 1_000,
			},
		]);
		const r = analyzeCacheMisses(jsonl);
		expect(r.totalUsageEvents).toBe(0);
		expect(r.misses).toHaveLength(0);
	});

	test("gap is measured against previous usage event, ignoring intervening events", () => {
		const jsonl = buildJsonl([
			// first usage — gap=null (no prior usage)
			{
				type: "usage",
				taskId: "t",
				inputTokens: 100,
				cacheReadTokens: 10,
				outputTokens: 5,
				contextWindow: 200_000,
				ts: 1_000_000,
			},
			// between the two usage events: tool_call, tool_result, messages_consumed
			{ type: "tool_call", taskId: "t", tool: "bash", ts: 1_005_000 },
			{ type: "tool_result", taskId: "t", ts: 1_008_000 },
			{ type: "messages_consumed", taskId: "t", messageIds: [], ts: 1_008_100 },
			// second usage at ts=1_360_000 → gap=360_000ms from prev usage
			{
				type: "usage",
				taskId: "t",
				inputTokens: 200,
				cacheReadTokens: 20,
				outputTokens: 10,
				contextWindow: 200_000,
				ts: 1_360_000,
			},
		]);
		const r = analyzeCacheMisses(jsonl);
		expect(r.misses).toHaveLength(2);
		const first = r.misses[0];
		if (!first) throw new Error("no first miss");
		expect(first.gapMs).toBeNull();
		const second = r.misses[1];
		if (!second) throw new Error("no second miss");
		// Real inter-usage gap — NOT the tiny 352_000/100/etc. from last line before.
		expect(second.gapMs).toBe(360_000);
	});

	test("hit in the middle still resets the clock (prevUsageTs updates on hit)", () => {
		const jsonl = buildJsonl([
			// miss at t=0
			{
				type: "usage",
				taskId: "t",
				inputTokens: 100,
				cacheReadTokens: 10,
				outputTokens: 5,
				contextWindow: 200_000,
				ts: 0,
			},
			// HIT at t=10 min — not in misses, but must update prevUsageTs
			{
				type: "usage",
				taskId: "t",
				inputTokens: 100,
				cacheReadTokens: 100,
				outputTokens: 5,
				contextWindow: 200_000,
				ts: 600_000,
			},
			// miss at t=12 min → gap should be 120_000 (from the hit), not 720_000
			// (from the first miss). If the hit didn't update prevUsageTs, this would
			// wrongly look like a 12-minute gap.
			{
				type: "usage",
				taskId: "t",
				inputTokens: 100,
				cacheReadTokens: 10,
				outputTokens: 5,
				contextWindow: 200_000,
				ts: 720_000,
			},
		]);
		const r = analyzeCacheMisses(jsonl);
		expect(r.misses).toHaveLength(2);
		expect(r.totalUsageEvents).toBe(3);
		const second = r.misses[1];
		if (!second) throw new Error("no second miss");
		expect(second.gapMs).toBe(120_000);
	});

	test("first valid usage has gap=null", () => {
		const jsonl = buildJsonl([
			{
				type: "usage",
				taskId: "t",
				inputTokens: 100,
				cacheReadTokens: 10,
				outputTokens: 5,
				contextWindow: 200_000,
				ts: 1_000,
			},
		]);
		const r = analyzeCacheMisses(jsonl);
		expect(r.misses[0]?.gapMs).toBeNull();
	});

	test("ignores non-JSON lines and blanks", () => {
		const jsonl = [
			"",
			"not-json",
			JSON.stringify({
				type: "usage",
				taskId: "t",
				inputTokens: 100,
				cacheReadTokens: 10,
				outputTokens: 5,
				contextWindow: 200_000,
				ts: 1_000,
			}),
			"",
		].join("\n");
		const r = analyzeCacheMisses(jsonl);
		expect(r.misses).toHaveLength(1);
		// The usage event was on line 3 (1-indexed)
		expect(r.misses[0]?.lineNumber).toBe(3);
	});

	test("stoppedInGap is true when agent_stopped appears between usages", () => {
		const jsonl = buildJsonl([
			{
				type: "usage",
				taskId: "t",
				inputTokens: 100,
				cacheReadTokens: 10,
				outputTokens: 5,
				contextWindow: 200_000,
				ts: 1_000,
			},
			{ type: "agent_stopped", taskId: "t", ts: 2_000 },
			{
				type: "usage",
				taskId: "t",
				inputTokens: 100,
				cacheReadTokens: 10,
				outputTokens: 5,
				contextWindow: 200_000,
				ts: 3_000,
			},
		]);
		const r = analyzeCacheMisses(jsonl);
		expect(r.misses).toHaveLength(2);
		expect(r.misses[0]?.stoppedInGap).toBe(false); // first usage, no gap
		expect(r.misses[1]?.stoppedInGap).toBe(true);
	});

	test("stoppedInGap is true when MULTIPLE agent_stopped appear in gap", () => {
		const jsonl = buildJsonl([
			{
				type: "usage",
				taskId: "t",
				inputTokens: 100,
				cacheReadTokens: 10,
				outputTokens: 5,
				contextWindow: 200_000,
				ts: 1_000,
			},
			{ type: "agent_stopped", taskId: "t", ts: 2_000 },
			{ type: "agent_stopped", taskId: "t", ts: 2_500 },
			{
				type: "usage",
				taskId: "t",
				inputTokens: 100,
				cacheReadTokens: 10,
				outputTokens: 5,
				contextWindow: 200_000,
				ts: 3_000,
			},
		]);
		const r = analyzeCacheMisses(jsonl);
		expect(r.misses[1]?.stoppedInGap).toBe(true);
	});

	test("stoppedInGap is false when no restart in gap", () => {
		const jsonl = buildJsonl([
			{
				type: "usage",
				taskId: "t",
				inputTokens: 100,
				cacheReadTokens: 10,
				outputTokens: 5,
				contextWindow: 200_000,
				ts: 1_000,
			},
			{ type: "tool_call", taskId: "t", tool: "bash", ts: 1_500 },
			{
				type: "usage",
				taskId: "t",
				inputTokens: 100,
				cacheReadTokens: 10,
				outputTokens: 5,
				contextWindow: 200_000,
				ts: 2_000,
			},
		]);
		const r = analyzeCacheMisses(jsonl);
		expect(r.misses).toHaveLength(2);
		expect(r.misses[1]?.stoppedInGap).toBe(false);
	});

	test("agent_stopped BEFORE first usage → first usage stoppedInGap=false (no prior gap)", () => {
		// Edge case decision: the flag describes "what happened IN the gap between
		// prev and current usage". No prior usage means no gap, so the flag is
		// false (not applicable), regardless of any pre-existing restart events.
		const jsonl = buildJsonl([
			{ type: "agent_stopped", taskId: "t", ts: 500 },
			{
				type: "usage",
				taskId: "t",
				inputTokens: 100,
				cacheReadTokens: 10,
				outputTokens: 5,
				contextWindow: 200_000,
				ts: 1_000,
			},
		]);
		const r = analyzeCacheMisses(jsonl);
		expect(r.misses).toHaveLength(1);
		expect(r.misses[0]?.stoppedInGap).toBe(false);
	});

	test("stoppedInGap resets between consecutive usages (three-usage sequence)", () => {
		// Sequence: usage → restart → usage → usage
		// Second usage should have stoppedInGap=true.
		// Third usage should have stoppedInGap=false — the restart belongs to
		// the PREVIOUS gap, not this one.
		const jsonl = buildJsonl([
			{
				type: "usage",
				taskId: "t",
				inputTokens: 100,
				cacheReadTokens: 10,
				outputTokens: 5,
				contextWindow: 200_000,
				ts: 1_000,
			},
			{ type: "agent_stopped", taskId: "t", ts: 2_000 },
			{
				type: "usage",
				taskId: "t",
				inputTokens: 100,
				cacheReadTokens: 10,
				outputTokens: 5,
				contextWindow: 200_000,
				ts: 3_000,
			},
			{
				type: "usage",
				taskId: "t",
				inputTokens: 100,
				cacheReadTokens: 10,
				outputTokens: 5,
				contextWindow: 200_000,
				ts: 4_000,
			},
		]);
		const r = analyzeCacheMisses(jsonl);
		expect(r.misses).toHaveLength(3);
		expect(r.misses[0]?.stoppedInGap).toBe(false);
		expect(r.misses[1]?.stoppedInGap).toBe(true);
		expect(r.misses[2]?.stoppedInGap).toBe(false);
	});

	test("missing cacheCreationTokens/cacheReadTokens default to 0", () => {
		const jsonl = buildJsonl([
			{
				type: "usage",
				taskId: "t",
				inputTokens: 100,
				outputTokens: 10,
				contextWindow: 200_000,
				ts: 1_000,
			},
		]);
		const r = analyzeCacheMisses(jsonl);
		expect(r.misses).toHaveLength(1);
		const first = r.misses[0];
		if (!first) throw new Error("no first miss");
		expect(first.cacheReadTokens).toBe(0);
		expect(first.cacheCreationTokens).toBe(0);
		expect(first.hitPct).toBe(0);
	});
});

describe("formatGap", () => {
	test("null → em dash", () => {
		expect(formatGap(null)).toBe("—");
	});
	test("zero → 0s", () => {
		expect(formatGap(0)).toBe("0s");
	});
	test("sub-minute → Xs", () => {
		expect(formatGap(45_000)).toBe("45s");
		expect(formatGap(30_000)).toBe("30s");
		expect(formatGap(1_000)).toBe("1s");
	});
	test("sub-hour → XmYs", () => {
		expect(formatGap(65_000)).toBe("1m5s");
		expect(formatGap(60_000)).toBe("1m0s");
		expect(formatGap(5 * 60_000)).toBe("5m0s");
	});
	test("hours → XhYmZs with zero components kept", () => {
		expect(formatGap(3_600_000)).toBe("1h0m0s");
		expect(formatGap(5_460_000)).toBe("1h31m0s");
	});
	test("23 seconds past 1h is visible (not rounded to 1.0h)", () => {
		// This is the motivating case: user saw gap=1.0h and couldn't tell
		// whether it was 1h0m23s (23s past TTL) or 1h5m (5m past TTL).
		expect(formatGap(3_623_538)).toBe("1h0m24s"); // 3623.538s rounds to 3624s
		expect(formatGap(3_623_000)).toBe("1h0m23s");
	});
	test("rounds sub-second to nearest second", () => {
		expect(formatGap(499)).toBe("0s");
		expect(formatGap(500)).toBe("1s");
		expect(formatGap(59_500)).toBe("1m0s"); // rolls into minute
	});
});

describe("formatTimestamp", () => {
	test("formats YYYY-MM-DD HH:MM:SS", () => {
		// Use a specific known timestamp and just check shape
		const out = formatTimestamp(Date.now());
		expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
	});
});

describe("formatRow", () => {
	test("matches example format with stopped=no", () => {
		const line = formatRow({
			lineNumber: 15234,
			ts: Date.now(),
			inputTokens: 104_188,
			cacheReadTokens: 33_575,
			cacheCreationTokens: 70_607,
			outputTokens: 892,
			hitPct: 32.2,
			gapMs: 5.8 * 60 * 1000,
			stoppedInGap: false,
		});
		expect(line).toContain("line 15234");
		expect(line).toContain("inp=104,188");
		expect(line).toContain("cr=33,575");
		expect(line).toContain("cc=70,607");
		expect(line).toContain("out=892");
		expect(line).toContain("hit=32.2%");
		expect(line).toContain("gap=5m48s");
		expect(line).toContain("stopped=no");
	});

	test("stopped=yes when stoppedInGap is true", () => {
		const line = formatRow({
			lineNumber: 1,
			ts: Date.now(),
			inputTokens: 100,
			cacheReadTokens: 10,
			cacheCreationTokens: 0,
			outputTokens: 5,
			hitPct: 10,
			gapMs: 1000,
			stoppedInGap: true,
		});
		expect(line).toContain("stopped=yes");
	});
});

describe("parseDuration", () => {
	test("seconds", () => {
		expect(parseDuration("30s")).toBe(30_000);
		expect(parseDuration("1s")).toBe(1_000);
	});
	test("minutes", () => {
		expect(parseDuration("5m")).toBe(300_000);
		expect(parseDuration("61m")).toBe(61 * 60_000);
	});
	test("hours", () => {
		expect(parseDuration("1h")).toBe(3_600_000);
	});
	test("fractional values", () => {
		expect(parseDuration("1.5h")).toBe(5_400_000);
		expect(parseDuration("0.5m")).toBe(30_000);
	});
	test("invalid format returns null", () => {
		expect(parseDuration("")).toBeNull();
		expect(parseDuration("invalid")).toBeNull();
		expect(parseDuration("1x")).toBeNull();
		expect(parseDuration("5")).toBeNull(); // no unit
		expect(parseDuration("m5")).toBeNull();
		expect(parseDuration("-1m")).toBeNull(); // regex rejects leading sign
	});
});

describe("filterByMaxGap", () => {
	function row(
		gapMs: number | null,
		extra: Partial<CacheMissRow> = {},
	): CacheMissRow {
		return {
			lineNumber: 1,
			ts: 0,
			inputTokens: 100,
			cacheReadTokens: 10,
			cacheCreationTokens: 0,
			outputTokens: 5,
			hitPct: 10,
			gapMs,
			stoppedInGap: false,
			...extra,
		};
	}

	test("null maxGap returns all rows unchanged", () => {
		const rows = [row(null), row(60_000), row(10 * 60 * 60 * 1000)];
		expect(filterByMaxGap(rows, null)).toEqual(rows);
	});

	test("filters out rows with gap > maxGap", () => {
		const rows = [
			row(30_000), // 30s
			row(5 * 60_000), // 5m
			row(60 * 60_000), // 60m
			row(90 * 60_000), // 90m
		];
		const filtered = filterByMaxGap(rows, 61 * 60_000); // <= 61m
		expect(filtered).toHaveLength(3);
		expect(filtered.map((r) => r.gapMs)).toEqual([30_000, 300_000, 3_600_000]);
	});

	test("keeps rows with gap === maxGap (boundary is inclusive)", () => {
		const rows = [row(60_000)];
		expect(filterByMaxGap(rows, 60_000)).toHaveLength(1);
	});

	test("always keeps rows with gapMs === null (first usage, unknowable)", () => {
		const rows = [
			row(null), // first usage
			row(10 * 60 * 60 * 1000), // 10h — would be filtered
		];
		const filtered = filterByMaxGap(rows, 60_000);
		expect(filtered).toHaveLength(1);
		expect(filtered[0]?.gapMs).toBeNull();
	});

	test("empty input returns empty", () => {
		expect(filterByMaxGap([], 60_000)).toEqual([]);
	});
});
