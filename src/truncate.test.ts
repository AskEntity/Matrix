import { describe, expect, test } from "bun:test";
import { truncate } from "./truncate.ts";

describe("truncate", () => {
	test("returns text as-is when shorter than maxLen", () => {
		expect(truncate("hello", 10)).toBe("hello");
	});

	test("returns text as-is when equal to maxLen", () => {
		expect(truncate("hello", 5)).toBe("hello");
	});

	test("truncates and appends ellipsis when text exceeds maxLen", () => {
		expect(truncate("hello world", 8)).toBe("hello...");
	});

	test("result length equals maxLen after truncation", () => {
		const result = truncate("a long string here", 10);
		expect(result.length).toBe(10);
		expect(result).toBe("a long ...");
	});

	test("handles maxLen of 3", () => {
		expect(truncate("hello", 3)).toBe("...");
	});

	test("handles maxLen of 2", () => {
		expect(truncate("hello", 2)).toBe("..");
	});

	test("handles maxLen of 1", () => {
		expect(truncate("hello", 1)).toBe(".");
	});

	test("handles maxLen of 0", () => {
		expect(truncate("hello", 0)).toBe("");
	});

	test("handles negative maxLen", () => {
		expect(truncate("hello", -1)).toBe("");
	});

	test("handles empty string", () => {
		expect(truncate("", 5)).toBe("");
		expect(truncate("", 0)).toBe("");
	});

	test("handles maxLen of 4 with long text", () => {
		expect(truncate("hello", 4)).toBe("h...");
	});

	test("does not truncate single character within limit", () => {
		expect(truncate("a", 1)).toBe("a");
	});
});
