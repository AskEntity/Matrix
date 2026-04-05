import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	atBottomPure,
	clearScrollTarget,
	selectTopAnchor,
} from "./useScrollTarget.ts";

// Provide a minimal in-memory localStorage for Bun (no DOM).
const originalLocalStorage = globalThis.localStorage;
beforeEach(() => {
	const store = new Map<string, string>();
	Object.defineProperty(globalThis, "localStorage", {
		value: {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => store.set(k, v),
			removeItem: (k: string) => store.delete(k),
			clear: () => store.clear(),
		},
		configurable: true,
	});
});
afterEach(() => {
	if (originalLocalStorage) {
		Object.defineProperty(globalThis, "localStorage", {
			value: originalLocalStorage,
			configurable: true,
		});
	}
});

describe("clearScrollTarget", () => {
	it("removes the saved target for a task", () => {
		localStorage.setItem(
			"mxd-scroll-state:task-1",
			JSON.stringify({ kind: "follow" }),
		);
		expect(localStorage.getItem("mxd-scroll-state:task-1")).toBeTruthy();
		clearScrollTarget("task-1");
		expect(localStorage.getItem("mxd-scroll-state:task-1")).toBeNull();
	});

	it("is a no-op for unknown taskId", () => {
		// Should not throw
		clearScrollTarget("never-existed");
		expect(localStorage.getItem("mxd-scroll-state:never-existed")).toBeNull();
	});

	it("does not affect other tasks' state", () => {
		localStorage.setItem(
			"mxd-scroll-state:task-a",
			JSON.stringify({ kind: "follow" }),
		);
		localStorage.setItem(
			"mxd-scroll-state:task-b",
			JSON.stringify({ kind: "anchored", ts: 123, offsetPx: 10 }),
		);
		clearScrollTarget("task-a");
		expect(localStorage.getItem("mxd-scroll-state:task-a")).toBeNull();
		expect(localStorage.getItem("mxd-scroll-state:task-b")).toBeTruthy();
	});
});

describe("selectTopAnchor", () => {
	// Scenario: container viewport starts at y=100. Three entries:
	//   A: top=50,  bottom=150  (straddling, bottom below container top → anchor)
	//   B: top=150, bottom=300
	//   C: top=300, bottom=450
	it("picks first entry whose bottom is below container top", () => {
		const anchor = selectTopAnchor(100, [
			{ top: 50, bottom: 150, ts: 1 },
			{ top: 150, bottom: 300, ts: 2 },
			{ top: 300, bottom: 450, ts: 3 },
		]);
		expect(anchor).toEqual({ ts: 1, offsetPx: 100 - 50 });
	});

	// Scenario: user scrolled past entry A entirely. A's bottom is above
	// container top — skip to entry B.
	it("skips entries whose bottom is above container top", () => {
		const anchor = selectTopAnchor(200, [
			{ top: 50, bottom: 150, ts: 1 }, // fully above viewport
			{ top: 150, bottom: 300, ts: 2 }, // straddling (bottom 300 >= 200)
			{ top: 300, bottom: 450, ts: 3 },
		]);
		expect(anchor).toEqual({ ts: 2, offsetPx: 200 - 150 });
	});

	it("returns null when all entries are above viewport", () => {
		const anchor = selectTopAnchor(500, [
			{ top: 50, bottom: 150, ts: 1 },
			{ top: 150, bottom: 300, ts: 2 },
		]);
		expect(anchor).toBeNull();
	});

	it("returns null for empty list", () => {
		expect(selectTopAnchor(100, [])).toBeNull();
	});

	it("skips NaN ts values (e.g. missing data-entry-ts)", () => {
		const anchor = selectTopAnchor(100, [
			{ top: 50, bottom: 150, ts: Number.NaN },
			{ top: 150, bottom: 300, ts: 2 },
		]);
		expect(anchor).toEqual({ ts: 2, offsetPx: 100 - 150 });
	});

	// Scenario: entry whose top IS container top exactly (boundary).
	// offsetPx should be 0 — entry sits flush with viewport top.
	it("offsetPx is 0 when entry top equals container top", () => {
		const anchor = selectTopAnchor(100, [{ top: 100, bottom: 250, ts: 42 }]);
		expect(anchor).toEqual({ ts: 42, offsetPx: 0 });
	});

	// Negative offset: entry's top is BELOW container top (entry is fully
	// below viewport start). offsetPx would be negative. This happens on
	// mount before any scroll. Caller should treat any anchor result as
	// usable regardless of sign.
	it("allows negative offsetPx when entry top is below container top", () => {
		const anchor = selectTopAnchor(100, [{ top: 120, bottom: 250, ts: 7 }]);
		expect(anchor).toEqual({ ts: 7, offsetPx: 100 - 120 });
	});
});

describe("atBottomPure", () => {
	it("true when scrolled to exact bottom", () => {
		// scrollHeight=1000, scrollTop=800, clientHeight=200 → distance 0
		expect(atBottomPure(1000, 800, 200)).toBe(true);
	});

	it("true when within 40px of bottom", () => {
		// scrollHeight=1000, scrollTop=761, clientHeight=200 → distance 39
		expect(atBottomPure(1000, 761, 200)).toBe(true);
	});

	it("false when 40px from bottom", () => {
		// scrollHeight=1000, scrollTop=760, clientHeight=200 → distance 40
		expect(atBottomPure(1000, 760, 200)).toBe(false);
	});

	it("false when scrolled far up", () => {
		expect(atBottomPure(2000, 100, 500)).toBe(false);
	});

	it("true when content fits in viewport (no overflow)", () => {
		// scrollHeight == clientHeight, scrollTop=0 → distance 0
		expect(atBottomPure(400, 0, 400)).toBe(true);
	});
});

describe("ScrollTarget localStorage format", () => {
	it("follow target round-trips through JSON", () => {
		const target = { kind: "follow" };
		localStorage.setItem("mxd-scroll-state:t", JSON.stringify(target));
		const raw = localStorage.getItem("mxd-scroll-state:t");
		expect(raw).toBeTruthy();
		const parsed = JSON.parse(raw ?? "null");
		expect(parsed).toEqual({ kind: "follow" });
	});

	it("anchored target round-trips through JSON", () => {
		const target = { kind: "anchored", ts: 1712345678900, offsetPx: 42 };
		localStorage.setItem("mxd-scroll-state:t", JSON.stringify(target));
		const raw = localStorage.getItem("mxd-scroll-state:t");
		expect(raw).toBeTruthy();
		const parsed = JSON.parse(raw ?? "null");
		expect(parsed).toEqual({
			kind: "anchored",
			ts: 1712345678900,
			offsetPx: 42,
		});
	});
});
