import { describe, expect, test } from "bun:test";
import {
	COMPACTION_MAX_TOKENS,
	getCompactionThresholds,
} from "./compaction.ts";

describe("getCompactionThresholds", () => {
	test("1M context window triggers compaction at 920K (8% buffer)", () => {
		const { compressThreshold, lazyCountThreshold } =
			getCompactionThresholds(1_000_000);
		expect(compressThreshold).toBe(920_000);
		expect(lazyCountThreshold).toBe(920_000 - 16_000);
	});

	test("200K context window triggers compaction at 166K (17% buffer)", () => {
		const { compressThreshold, lazyCountThreshold } =
			getCompactionThresholds(200_000);
		expect(compressThreshold).toBe(Math.floor(200_000 * 0.83));
		expect(lazyCountThreshold).toBe(Math.floor(200_000 * 0.83) - 16_000);
	});

	test("context windows just below 1M use small-window ratio", () => {
		const { compressThreshold } = getCompactionThresholds(999_999);
		// 999_999 * 0.83 = 829_999.17 → floor = 829_999
		expect(compressThreshold).toBe(Math.floor(999_999 * 0.83));
	});

	test("context windows exactly at 1M use large-window ratio", () => {
		const { compressThreshold } = getCompactionThresholds(1_000_000);
		expect(compressThreshold).toBe(920_000);
	});

	test("context windows larger than 1M use large-window ratio", () => {
		const { compressThreshold } = getCompactionThresholds(2_000_000);
		expect(compressThreshold).toBe(Math.floor(2_000_000 * 0.92));
	});

	test("lazyCountThreshold is always 16K below compressThreshold", () => {
		for (const contextWindow of [
			100_000, 200_000, 500_000, 1_000_000, 2_000_000,
		]) {
			const { compressThreshold, lazyCountThreshold } =
				getCompactionThresholds(contextWindow);
			expect(lazyCountThreshold).toBe(compressThreshold - 16_000);
		}
	});
});

describe("COMPACTION_MAX_TOKENS", () => {
	test("is 64K", () => {
		expect(COMPACTION_MAX_TOKENS).toBe(64_000);
	});
});
