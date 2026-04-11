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

	test("gap is measured against previous event of ANY type, not previous usage", () => {
		const jsonl = buildJsonl([
			{ type: "assistant_text", taskId: "t", content: "a", ts: 1_000_000 },
			{ type: "tool_call", taskId: "t", tool: "bash", ts: 1_000_500 },
			// usage at +600 from tool_call, NOT +1100 from start
			{
				type: "usage",
				taskId: "t",
				inputTokens: 100,
				cacheReadTokens: 10,
				outputTokens: 5,
				contextWindow: 200_000,
				ts: 1_001_100,
			},
		]);
		const r = analyzeCacheMisses(jsonl);
		expect(r.misses).toHaveLength(1);
		const first = r.misses[0];
		if (!first) throw new Error("no first miss");
		expect(first.gapMs).toBe(600);
		expect(first.lineNumber).toBe(3);
	});

	test("first event in file has gap=null", () => {
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
	test("matches example format", () => {
		const line = formatRow({
			lineNumber: 15234,
			ts: Date.now(),
			inputTokens: 104_188,
			cacheReadTokens: 33_575,
			cacheCreationTokens: 70_607,
			outputTokens: 892,
			hitPct: 32.2,
			gapMs: 5.8 * 60 * 1000,
		});
		expect(line).toContain("line 15234");
		expect(line).toContain("inp=104,188");
		expect(line).toContain("cr=33,575");
		expect(line).toContain("cc=70,607");
		expect(line).toContain("out=892");
		expect(line).toContain("hit=32.2%");
		expect(line).toContain("gap=5.8m");
	});
});
