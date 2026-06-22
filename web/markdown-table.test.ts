/**
 * Unit tests for the focused markdown TABLE parser (no DOM).
 *
 * The parser is the correctness core of the table-rendering feature: it decides
 * what counts as a table vs plain text. These tests are adversarial on purpose
 * — the dangerous failure mode is a FALSE POSITIVE (treating a thematic break or
 * random pipe text as a table), so the bulk of the cases pin "this is NOT a
 * table". Mutation-proof: each behavior has at least one test that fails if the
 * corresponding rule is removed.
 */

import { describe, expect, test } from "bun:test";
import {
	hasTable,
	isDelimiterRow,
	parseTextSegments,
	splitRow,
} from "../.mxd/plugin/web/markdown-table.ts";

describe("splitRow", () => {
	test("splits a fully-piped row, dropping boundary cells", () => {
		expect(splitRow("| a | b | c |")).toEqual(["a", "b", "c"]);
	});

	test("splits a borderless row (no leading/trailing pipe)", () => {
		expect(splitRow("a | b")).toEqual(["a", "b"]);
	});

	test("preserves interior empty cells", () => {
		expect(splitRow("| a || c |")).toEqual(["a", "", "c"]);
	});

	test("unescapes \\| inside a cell and does not split on it", () => {
		expect(splitRow("| a \\| b | c |")).toEqual(["a | b", "c"]);
	});

	test("single-column row", () => {
		expect(splitRow("| only |")).toEqual(["only"]);
	});
});

describe("isDelimiterRow", () => {
	test("accepts plain dashes", () => {
		expect(isDelimiterRow("| --- | --- |")).toBe(true);
	});

	test("accepts alignment colons", () => {
		expect(isDelimiterRow("| :--- | ---: | :---: |")).toBe(true);
		expect(isDelimiterRow(":-|-:")).toBe(true);
	});

	test("accepts a single dash cell", () => {
		expect(isDelimiterRow("| - | - |")).toBe(true);
	});

	test("rejects a row with non-dash content", () => {
		expect(isDelimiterRow("| a | b |")).toBe(false);
	});

	test("rejects a row with an empty cell", () => {
		expect(isDelimiterRow("| --- | |")).toBe(false);
	});

	test("rejects a line with no dash at all", () => {
		expect(isDelimiterRow("| : | : |")).toBe(false);
	});
});

describe("parseTextSegments — plain text (no table)", () => {
	test("returns a single verbatim text segment", () => {
		const text = "Just some prose.\nWith two lines.";
		const segs = parseTextSegments(text);
		expect(segs).toEqual([{ type: "text", content: text }]);
	});

	test("empty string → single empty text segment", () => {
		expect(parseTextSegments("")).toEqual([{ type: "text", content: "" }]);
	});

	test("a lone thematic break `---` is NOT a table", () => {
		const text = "Before\n\n---\n\nAfter";
		const segs = parseTextSegments(text);
		expect(segs).toEqual([{ type: "text", content: text }]);
		expect(hasTable(text)).toBe(false);
	});

	test("pipes without a delimiter row are NOT a table", () => {
		const text = "a | b\nc | d"; // no `---` separator
		expect(hasTable(text)).toBe(false);
	});

	test("header/delimiter column-count MISMATCH is NOT a table", () => {
		// `a | b` (2 cols) followed by `---` (1 col) must not parse as a table —
		// this is the guard that stops a thematic break after a piped line.
		const text = "a | b\n---\nc | d";
		expect(hasTable(text)).toBe(false);
	});
});

describe("parseTextSegments — real tables", () => {
	test("simple fully-piped table: headers, align, rows", () => {
		const text = ["| A | B |", "| --- | --- |", "| 1 | 2 |", "| 3 | 4 |"].join(
			"\n",
		);
		const segs = parseTextSegments(text);
		expect(segs).toHaveLength(1);
		const seg = segs[0];
		if (seg?.type !== "table") throw new Error("expected a table segment");
		expect(seg.table.headers).toEqual(["A", "B"]);
		expect(seg.table.align).toEqual(["none", "none"]);
		expect(seg.table.rows).toEqual([
			["1", "2"],
			["3", "4"],
		]);
		// raw must be the exact original block (used by the copy button).
		expect(seg.raw).toBe(text);
	});

	test("borderless table (no outer pipes) parses", () => {
		const text = ["A | B", "--- | ---", "1 | 2"].join("\n");
		const segs = parseTextSegments(text);
		const seg = segs[0];
		if (seg?.type !== "table") throw new Error("expected a table segment");
		expect(seg.table.headers).toEqual(["A", "B"]);
		expect(seg.table.rows).toEqual([["1", "2"]]);
	});

	test("alignment markers map to left/right/center/none", () => {
		const text = [
			"| L | R | C | D |",
			"| :--- | ---: | :---: | --- |",
			"| a | b | c | d |",
		].join("\n");
		const seg = parseTextSegments(text)[0];
		if (seg?.type !== "table") throw new Error("expected a table segment");
		expect(seg.table.align).toEqual(["left", "right", "center", "none"]);
	});

	test("header + delimiter but ZERO body rows is still a valid table", () => {
		const text = ["| A | B |", "| --- | --- |"].join("\n");
		const seg = parseTextSegments(text)[0];
		if (seg?.type !== "table") throw new Error("expected a table segment");
		expect(seg.table.headers).toEqual(["A", "B"]);
		expect(seg.table.rows).toEqual([]);
	});

	test("ragged body rows are padded / truncated to header width", () => {
		const text = [
			"| A | B | C |",
			"| --- | --- | --- |",
			"| 1 |", // too few → padded with ""
			"| 1 | 2 | 3 | 4 |", // too many → truncated
		].join("\n");
		const seg = parseTextSegments(text)[0];
		if (seg?.type !== "table") throw new Error("expected a table segment");
		expect(seg.table.rows).toEqual([
			["1", "", ""],
			["1", "2", "3"],
		]);
	});

	test("escaped pipes inside cells survive into the parsed cell", () => {
		const text = ["| Code | Note |", "| --- | --- |", "| a \\| b | ok |"].join(
			"\n",
		);
		const seg = parseTextSegments(text)[0];
		if (seg?.type !== "table") throw new Error("expected a table segment");
		expect(seg.table.rows).toEqual([["a | b", "ok"]]);
	});
});

describe("parseTextSegments — mixed text + tables (segment order)", () => {
	test("text before, table, text after → 3 ordered segments", () => {
		const text = [
			"Here is a comparison:",
			"",
			"| Opt | Score |",
			"| --- | --- |",
			"| X | 9 |",
			"",
			"That's the result.",
		].join("\n");
		const segs = parseTextSegments(text);
		expect(segs.map((s) => s.type)).toEqual(["text", "table", "text"]);
		const before = segs[0];
		const table = segs[1];
		const after = segs[2];
		if (before?.type !== "text") throw new Error("seg0 not text");
		if (table?.type !== "table") throw new Error("seg1 not table");
		if (after?.type !== "text") throw new Error("seg2 not text");
		expect(before.content).toContain("Here is a comparison:");
		expect(table.table.headers).toEqual(["Opt", "Score"]);
		expect(after.content).toContain("That's the result.");
		// raw is only the table block — not the surrounding prose.
		expect(table.raw).toBe(
			["| Opt | Score |", "| --- | --- |", "| X | 9 |"].join("\n"),
		);
	});

	test("two separate tables in one message → two table segments", () => {
		const text = [
			"| A |",
			"| --- |",
			"| 1 |",
			"",
			"between",
			"",
			"| B |",
			"| --- |",
			"| 2 |",
		].join("\n");
		const segs = parseTextSegments(text);
		const tables = segs.filter((s) => s.type === "table");
		expect(tables).toHaveLength(2);
	});

	test("table at the very start (no preceding text)", () => {
		const text = [
			"| A | B |",
			"| --- | --- |",
			"| 1 | 2 |",
			"",
			"trailing",
		].join("\n");
		const segs = parseTextSegments(text);
		expect(segs[0]?.type).toBe("table");
	});

	test("a table immediately followed by a non-table piped line ends the table", () => {
		const text = [
			"| A | B |",
			"| --- | --- |",
			"| 1 | 2 |",
			"not a row, just prose",
		].join("\n");
		const segs = parseTextSegments(text);
		expect(segs.map((s) => s.type)).toEqual(["table", "text"]);
		const table = segs[0];
		if (table?.type !== "table") throw new Error("seg0 not table");
		expect(table.table.rows).toEqual([["1", "2"]]);
	});
});
