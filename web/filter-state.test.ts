/**
 * Pure unit tests for the sidebar search/filter toggle reducer.
 *
 * This is the "extract the toggle as testable state" deliverable: the whole
 * open/close/clear behaviour is a pure function, so the core contract is
 * verified with zero DOM/happy-dom fragility.
 *
 * Regression target: clicking the toggle button to CLOSE the input used to
 * re-open it ("又弹出来") because a blur-driven close raced the button's toggle.
 * With one atomic reducer there is no competing mutation — `toggle` is
 * deterministic and closing always clears the query.
 */

import { describe, expect, test } from "bun:test";
import {
	type FilterState,
	filterReducer,
	INITIAL_FILTER_STATE,
} from "../.mxd/plugin/web/filter-state.ts";

describe("filterReducer", () => {
	test("initial state is closed with empty query", () => {
		expect(INITIAL_FILTER_STATE).toEqual({ open: false, query: "" });
	});

	test("toggle from closed → open (query stays empty)", () => {
		const next = filterReducer(INITIAL_FILTER_STATE, { type: "toggle" });
		expect(next).toEqual({ open: true, query: "" });
	});

	test("toggle from open → closed", () => {
		const open: FilterState = { open: true, query: "" };
		expect(filterReducer(open, { type: "toggle" })).toEqual({
			open: false,
			query: "",
		});
	});

	test("toggle-close clears a non-empty query (no silent hidden filter)", () => {
		const openWithQuery: FilterState = { open: true, query: "auth" };
		const closed = filterReducer(openWithQuery, { type: "toggle" });
		expect(closed).toEqual({ open: false, query: "" });
	});

	test("open → type → close → open sequence: reopened input is empty", () => {
		// The exact "click open, type, click close, click open again" journey.
		let s = INITIAL_FILTER_STATE;
		s = filterReducer(s, { type: "toggle" }); // open
		expect(s).toEqual({ open: true, query: "" });
		s = filterReducer(s, { type: "setQuery", query: "cache" }); // type
		expect(s).toEqual({ open: true, query: "cache" });
		s = filterReducer(s, { type: "toggle" }); // close (clears)
		expect(s).toEqual({ open: false, query: "" });
		s = filterReducer(s, { type: "toggle" }); // open again
		expect(s).toEqual({ open: true, query: "" }); // NOT "cache"
	});

	test("toggle is a pure alternation — no reopen after close (the '又弹出来' guard)", () => {
		// Old bug: close then an implicit reopen. Here toggle strictly alternates.
		let s: FilterState = INITIAL_FILTER_STATE;
		const seen: boolean[] = [];
		for (let i = 0; i < 6; i++) {
			s = filterReducer(s, { type: "toggle" });
			seen.push(s.open);
		}
		expect(seen).toEqual([true, false, true, false, true, false]);
	});

	test("close action clears query and closes", () => {
		const open: FilterState = { open: true, query: "bug" };
		expect(filterReducer(open, { type: "close" })).toEqual({
			open: false,
			query: "",
		});
	});

	test("close is idempotent when already closed", () => {
		expect(filterReducer(INITIAL_FILTER_STATE, { type: "close" })).toEqual({
			open: false,
			query: "",
		});
	});

	test("setQuery updates the query while open", () => {
		const open: FilterState = { open: true, query: "" };
		expect(filterReducer(open, { type: "setQuery", query: "foo" })).toEqual({
			open: true,
			query: "foo",
		});
	});

	test("setQuery is ignored while closed (invariant: closed ⟹ empty query)", () => {
		const closed = INITIAL_FILTER_STATE;
		expect(filterReducer(closed, { type: "setQuery", query: "foo" })).toBe(
			closed,
		);
	});

	test("invariant: every closed state has an empty query across all actions", () => {
		const states: FilterState[] = [
			{ open: false, query: "" },
			{ open: true, query: "" },
			{ open: true, query: "x" },
		];
		const actions = [
			{ type: "toggle" as const },
			{ type: "close" as const },
			{ type: "setQuery" as const, query: "y" },
		];
		for (const s of states) {
			for (const a of actions) {
				const next = filterReducer(s, a);
				if (!next.open) expect(next.query).toBe("");
			}
		}
	});
});
