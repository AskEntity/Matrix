/**
 * Unit tests for the select-to-quote ("Ask Matrix") pure helpers.
 *
 * These functions carry all the logic behind the floating quote button that
 * doesn't need live DOM layout:
 *   - selectionQuoteText: which selections qualify as a quote source
 *   - toBlockquote / insertQuote: the selection → InputBar-draft transform
 *   - quoteButtonPosition: viewport-clamped button placement
 */

import { describe, expect, test } from "bun:test";
import {
	type ContainerLike,
	insertQuote,
	QUOTE_BTN_ESTIMATED_HEIGHT,
	QUOTE_BTN_ESTIMATED_WIDTH,
	quoteButtonPosition,
	type SelectionLike,
	selectionQuoteText,
	toBlockquote,
} from "../.mxd/plugin/web/quote.ts";

// ---------------------------------------------------------------------------
// selectionQuoteText — token-based fakes; no DOM required
// ---------------------------------------------------------------------------

/** Fake nodes are plain string tokens; the container knows which are inside. */
function makeContainer(inside: string[]): ContainerLike<string> {
	return { contains: (node) => node !== null && inside.includes(node) };
}

function makeSelection(opts: {
	text: string;
	anchorNode?: string | null;
	focusNode?: string | null;
	isCollapsed?: boolean;
	rangeCount?: number;
}): SelectionLike<string> {
	return {
		isCollapsed: opts.isCollapsed ?? false,
		rangeCount: opts.rangeCount ?? 1,
		anchorNode: opts.anchorNode === undefined ? "a" : opts.anchorNode,
		focusNode: opts.focusNode === undefined ? "b" : opts.focusNode,
		toString: () => opts.text,
	};
}

describe("selectionQuoteText", () => {
	const container = makeContainer(["a", "b"]);

	test("valid selection inside the container returns its text", () => {
		const sel = makeSelection({ text: "hello world" });
		expect(selectionQuoteText(sel, container)).toBe("hello world");
	});

	test("null selection or container returns null", () => {
		expect(selectionQuoteText(null, container)).toBeNull();
		expect(selectionQuoteText(makeSelection({ text: "x" }), null)).toBeNull();
	});

	test("collapsed selection returns null", () => {
		const sel = makeSelection({ text: "x", isCollapsed: true });
		expect(selectionQuoteText(sel, container)).toBeNull();
	});

	test("rangeCount 0 returns null", () => {
		const sel = makeSelection({ text: "x", rangeCount: 0 });
		expect(selectionQuoteText(sel, container)).toBeNull();
	});

	test("whitespace-only selection returns null", () => {
		const sel = makeSelection({ text: "  \n\t  " });
		expect(selectionQuoteText(sel, container)).toBeNull();
	});

	test("anchor outside the container returns null", () => {
		const sel = makeSelection({ text: "x", anchorNode: "outside" });
		expect(selectionQuoteText(sel, container)).toBeNull();
	});

	test("focus outside the container returns null", () => {
		const sel = makeSelection({ text: "x", focusNode: "outside" });
		expect(selectionQuoteText(sel, container)).toBeNull();
	});

	test("null anchor/focus nodes return null", () => {
		expect(
			selectionQuoteText(
				makeSelection({ text: "x", anchorNode: null }),
				container,
			),
		).toBeNull();
		expect(
			selectionQuoteText(
				makeSelection({ text: "x", focusNode: null }),
				container,
			),
		).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// toBlockquote
// ---------------------------------------------------------------------------

describe("toBlockquote", () => {
	test("single line", () => {
		expect(toBlockquote("hello world")).toBe("> hello world");
	});

	test("multi-line: every line gets the > prefix", () => {
		expect(toBlockquote("line one\nline two\nline three")).toBe(
			"> line one\n> line two\n> line three",
		);
	});

	test("outer whitespace is trimmed (selections grab trailing newlines)", () => {
		expect(toBlockquote("\n  hello  \n")).toBe("> hello");
	});

	test("interior empty lines become a bare > (blockquote stays one block)", () => {
		expect(toBlockquote("para one\n\npara two")).toBe(
			"> para one\n>\n> para two",
		);
	});

	test("\\r\\n and \\r normalize to \\n", () => {
		expect(toBlockquote("a\r\nb\rc")).toBe("> a\n> b\n> c");
	});

	test("interior indentation is preserved", () => {
		expect(toBlockquote("if (x) {\n  y();\n}")).toBe(
			"> if (x) {\n>   y();\n> }",
		);
	});
});

// ---------------------------------------------------------------------------
// insertQuote
// ---------------------------------------------------------------------------

describe("insertQuote", () => {
	test("empty draft: quote + blank line, ready for the question", () => {
		expect(insertQuote("", "selected text")).toBe("> selected text\n\n");
	});

	test("existing draft: quote is PREPENDED, draft preserved below", () => {
		expect(insertQuote("my question", "selected text")).toBe(
			"> selected text\n\nmy question",
		);
	});

	test("multi-line selection with existing draft", () => {
		expect(insertQuote("why?", "a\nb")).toBe("> a\n> b\n\nwhy?");
	});

	test("whitespace-only selection leaves the draft unchanged", () => {
		expect(insertQuote("draft", "   \n  ")).toBe("draft");
		expect(insertQuote("", "   ")).toBe("");
	});

	test("quoting twice stacks quotes (most recent first)", () => {
		const once = insertQuote("", "first");
		const twice = insertQuote(once, "second");
		expect(twice).toBe("> second\n\n> first\n\n");
	});
});

// ---------------------------------------------------------------------------
// quoteButtonPosition
// ---------------------------------------------------------------------------

describe("quoteButtonPosition", () => {
	const viewport = { width: 1000, height: 800 };

	test("default placement: below-right of the selection end", () => {
		const pos = quoteButtonPosition(
			{ left: 100, right: 300, top: 200, bottom: 220 },
			viewport,
		);
		expect(pos).toEqual({ left: 308, top: 228 });
	});

	test("clamps to the right viewport edge", () => {
		const pos = quoteButtonPosition(
			{ left: 800, right: 990, top: 200, bottom: 220 },
			viewport,
		);
		expect(pos.left).toBe(1000 - QUOTE_BTN_ESTIMATED_WIDTH - 8);
	});

	test("clamps to the left viewport edge", () => {
		const pos = quoteButtonPosition(
			{ left: -500, right: -100, top: 200, bottom: 220 },
			viewport,
		);
		expect(pos.left).toBe(8);
	});

	test("flips above the selection when there is no room below", () => {
		const rect = { left: 100, right: 300, top: 740, bottom: 795 };
		const pos = quoteButtonPosition(rect, viewport);
		expect(pos.top).toBe(740 - QUOTE_BTN_ESTIMATED_HEIGHT - 8);
	});

	test("never goes above the top viewport edge", () => {
		const pos = quoteButtonPosition(
			{ left: 100, right: 300, top: 2, bottom: 795 },
			viewport,
		);
		expect(pos.top).toBe(8);
	});
});
