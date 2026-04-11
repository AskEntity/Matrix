import { describe, expect, test } from "bun:test";
import {
	analyzeCacheMisses,
	formatGap,
	formatRow,
	formatTimestamp,
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
	test("seconds", () => {
		expect(formatGap(6000)).toBe("6s");
		expect(formatGap(30_000)).toBe("30s");
	});
	test("minutes with one decimal", () => {
		expect(formatGap(5.8 * 60 * 1000)).toBe("5.8m");
	});
	test("hours with one decimal", () => {
		expect(formatGap(1.4 * 60 * 60 * 1000)).toBe("1.4h");
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
		expect(line).toContain("gap=5.8m");
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
