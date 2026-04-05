import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	anchoredScrollTopPure,
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

describe("anchoredScrollTopPure", () => {
	// The round-trip invariant: capture an anchor from a given scroll
	// position, apply it back → scroll position unchanged. If this breaks
	// (e.g. sign flipped) every reapply shifts scroll → jitter + drift.
	//
	// Setup: container at viewport y=100, scrollTop=200. An entry with
	// offsetTop=150 (inside the container) renders at:
	//   entryViewportTop = containerTop + (offsetTop - scrollTop)
	//                    = 100 + (150 - 200) = 50
	// So the entry is 50px ABOVE the container top — partially scrolled out.
	//
	// Anchor capture: selectTopAnchor(containerTop=100, [{top:50, bottom:200}])
	//                 → offsetPx = 100 - 50 = 50
	//
	// Anchor restore: anchoredScrollTopPure(offsetTop=150, offsetPx=50)
	//                 → 200 (matches original scrollTop)  ✓
	it("round-trips: capture then apply reproduces original scrollTop (entry above)", () => {
		const containerTop = 100;
		const entryTop = 50;
		const entryOffsetTop = 150;
		const originalScrollTop = 200;
		const anchor = selectTopAnchor(containerTop, [
			{ top: entryTop, bottom: entryTop + 150, ts: 1 },
		]);
		expect(anchor).not.toBeNull();
		const newScrollTop = anchoredScrollTopPure(
			entryOffsetTop,
			anchor?.offsetPx ?? 0,
		);
		expect(newScrollTop).toBe(originalScrollTop);
	});

	// Negative offsetPx case: entry flush with / below container top (e.g.
	// after jump-to-center scrolled the entry into view). offsetPx<0.
	// The restored scrollTop must still be < offsetTop (entry appears below
	// container top). If sign is wrong, scrollTop > offsetTop → entry
	// appears ABOVE the viewport → drift.
	it("round-trips: entry centered below container top yields smaller scrollTop", () => {
		const containerTop = 100;
		const entryTop = 150; // entry top 50px BELOW container top
		const entryOffsetTop = 400;
		// selectTopAnchor: containerTop(100) - entryTop(150) = -50
		const anchor = selectTopAnchor(containerTop, [
			{ top: entryTop, bottom: entryTop + 200, ts: 7 },
		]);
		expect(anchor).toEqual({ ts: 7, offsetPx: -50 });
		const newScrollTop = anchoredScrollTopPure(
			entryOffsetTop,
			anchor?.offsetPx ?? 0,
		);
		// Expected: entry ends up 50px below container top. That means
		// newScrollTop = entryOffsetTop - 50 = 350. So newScrollTop < offsetTop.
		expect(newScrollTop).toBe(350);
		expect(newScrollTop).toBeLessThan(entryOffsetTop);
	});

	it("offset 0 → scrollTop == offsetTop (entry flush with container top)", () => {
		expect(anchoredScrollTopPure(500, 0)).toBe(500);
	});

	// Regression test for the "stuck at bottom, jumping around" bug
	// (commit 9449b55). The old code did `offsetTop - offsetPx` which
	// inverted the sign → every reapply shifted scroll toward bottom.
	// We assert the exact formula so a future sign flip is caught.
	it("formula matches documented invariant (regression guard)", () => {
		expect(anchoredScrollTopPure(100, 25)).toBe(125);
		expect(anchoredScrollTopPure(100, -25)).toBe(75);
		expect(anchoredScrollTopPure(500, 0)).toBe(500);
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
