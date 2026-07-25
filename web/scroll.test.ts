/**
 * Unit tests for the pure scroll-position predicate driving both auto-follow
 * re-engagement and the scroll-to-bottom button's visibility.
 *
 * isNearBottom(scrollTop, scrollHeight, clientHeight, threshold?) is true
 * when the remaining scroll distance (scrollHeight - scrollTop - clientHeight)
 * is strictly less than the threshold (default 40px — the historical inline
 * value in ActivityLog's handleScroll).
 */

import { describe, expect, test } from "bun:test";
import {
	isNearBottom,
	NEAR_BOTTOM_THRESHOLD,
	scrollRange,
	scrollRangeShrank,
} from "../.mxd/plugin/web/scroll.ts";

describe("isNearBottom", () => {
	test("exactly at the bottom → true", () => {
		// scrollTop maxes out at scrollHeight - clientHeight
		expect(isNearBottom(700, 1000, 300)).toBe(true);
	});

	test("within the threshold (39px away) → true", () => {
		expect(isNearBottom(661, 1000, 300)).toBe(true);
	});

	test("exactly at the threshold (40px away) → false (strict <)", () => {
		// Pins the strict `<` comparison — the historical `< 40` behavior.
		expect(isNearBottom(660, 1000, 300)).toBe(false);
	});

	test("far from the bottom → false", () => {
		expect(isNearBottom(0, 1000, 300)).toBe(false);
		expect(isNearBottom(200, 5000, 400)).toBe(false);
	});

	test("non-overflowing container (scrollHeight <= clientHeight) → true", () => {
		// Nothing to scroll — the button must never show.
		expect(isNearBottom(0, 200, 300)).toBe(true);
		expect(isNearBottom(0, 300, 300)).toBe(true);
	});

	test("empty container (all zeros) → true", () => {
		expect(isNearBottom(0, 0, 0)).toBe(true);
	});

	test("overscroll past the max (iOS rubber-band) → true", () => {
		// scrollTop beyond scrollHeight - clientHeight → negative distance
		expect(isNearBottom(750, 1000, 300)).toBe(true);
	});

	test("fractional pixel positions (browsers report fractions)", () => {
		expect(isNearBottom(660.5, 1000, 300)).toBe(true); // 39.5 < 40
		expect(isNearBottom(659.5, 1000, 300)).toBe(false); // 40.5 >= 40
	});

	test("custom threshold overrides the default", () => {
		expect(isNearBottom(500, 1000, 300, 250)).toBe(true); // 200 < 250
		expect(isNearBottom(500, 1000, 300, 100)).toBe(false); // 200 >= 100
		expect(isNearBottom(700, 1000, 300, 0)).toBe(false); // 0 < 0 is false
	});

	test("default threshold is the exported constant (40)", () => {
		expect(NEAR_BOTTOM_THRESHOLD).toBe(40);
		// distance 39 with implicit default === explicit constant
		expect(isNearBottom(661, 1000, 300)).toBe(
			isNearBottom(661, 1000, 300, NEAR_BOTTOM_THRESHOLD),
		);
	});
});

describe("scrollRange / scrollRangeShrank", () => {
	test("range is how far the container can scroll", () => {
		expect(scrollRange(1000, 300)).toBe(700);
	});

	test("a container that does not overflow has zero range, never negative", () => {
		expect(scrollRange(300, 300)).toBe(0);
		expect(scrollRange(200, 300)).toBe(0);
	});

	test("shrinking range → true (the content or viewport came up under the offset)", () => {
		expect(scrollRangeShrank(700, 0)).toBe(true); // log search matched nothing
		expect(scrollRangeShrank(1549, 449)).toBe(true); // search result still overflows
		expect(scrollRangeShrank(700, 665)).toBe(true); // composer grew 35px
	});

	test("unchanged range → false (an ordinary user scroll)", () => {
		expect(scrollRangeShrank(700, 700)).toBe(false);
	});

	test("growing range → false — streaming must not block re-arming follow", () => {
		expect(scrollRangeShrank(700, 900)).toBe(false);
	});

	test("no previous measurement (starts at 0) never reports a shrink", () => {
		expect(scrollRangeShrank(0, 700)).toBe(false);
		expect(scrollRangeShrank(0, 0)).toBe(false);
	});
});
