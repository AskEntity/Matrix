import { describe, expect, test } from "bun:test";
import { clamp } from "./clamp.ts";

describe("clamp", () => {
	test("returns value when within range", () => {
		expect(clamp(5, 0, 10)).toBe(5);
	});

	test("clamps value below min to min", () => {
		expect(clamp(-5, 0, 10)).toBe(0);
	});

	test("clamps value above max to max", () => {
		expect(clamp(15, 0, 10)).toBe(10);
	});

	test("returns min when value equals min", () => {
		expect(clamp(0, 0, 10)).toBe(0);
	});

	test("returns max when value equals max", () => {
		expect(clamp(10, 0, 10)).toBe(10);
	});

	test("handles negative ranges", () => {
		expect(clamp(-5, -10, -1)).toBe(-5);
		expect(clamp(-15, -10, -1)).toBe(-10);
		expect(clamp(0, -10, -1)).toBe(-1);
	});

	test("handles zero as min and max", () => {
		expect(clamp(5, 0, 0)).toBe(0);
		expect(clamp(-5, 0, 0)).toBe(0);
		expect(clamp(0, 0, 0)).toBe(0);
	});

	test("handles equal min and max", () => {
		expect(clamp(10, 5, 5)).toBe(5);
		expect(clamp(0, 5, 5)).toBe(5);
		expect(clamp(5, 5, 5)).toBe(5);
	});

	test("handles fractional values", () => {
		expect(clamp(0.5, 0, 1)).toBe(0.5);
		expect(clamp(-0.1, 0, 1)).toBe(0);
		expect(clamp(1.1, 0, 1)).toBe(1);
	});

	test("handles large numbers", () => {
		expect(clamp(1e15, 0, 1e10)).toBe(1e10);
		expect(clamp(-1e15, -1e10, 0)).toBe(-1e10);
	});

	test("throws RangeError when min is greater than max", () => {
		expect(() => clamp(5, 10, 0)).toThrow(RangeError);
	});
});
