/**
 * Pure drop-routing helpers (no DOM): isFileDrag gates external-file drags vs
 * internal HTML5 drags (the red line), extractImageFiles picks image files.
 */
import { describe, expect, test } from "bun:test";
import { extractImageFiles, isFileDrag } from "../.mxd/plugin/web/file-drop.ts";

const img = (name: string, type: string) =>
	new File([new Uint8Array([1, 2, 3])], name, { type });

describe("isFileDrag", () => {
	test("true when types includes 'Files' (external file drag)", () => {
		expect(isFileDrag({ types: ["Files"], files: [] })).toBe(true);
		expect(isFileDrag({ types: ["Files", "text/uri-list"], files: [] })).toBe(
			true,
		);
	});

	test("false for internal HTML5 drag (text/plain payload — task-tree reorder)", () => {
		// The red line: task-tree/tab reorder sets text/plain, never Files.
		expect(isFileDrag({ types: ["text/plain"], files: [] })).toBe(false);
	});

	test("false for empty / missing dataTransfer", () => {
		expect(isFileDrag({ types: [], files: [] })).toBe(false);
		expect(isFileDrag(null)).toBe(false);
		expect(isFileDrag(undefined)).toBe(false);
	});
});

describe("extractImageFiles", () => {
	test("returns only image/* files", () => {
		const files = [
			img("a.png", "image/png"),
			img("b.txt", "text/plain"),
			img("c.jpg", "image/jpeg"),
		];
		const out = extractImageFiles({ types: ["Files"], files });
		expect(out.map((f) => f.name)).toEqual(["a.png", "c.jpg"]);
	});

	test("empty when no image files", () => {
		expect(
			extractImageFiles({
				types: ["Files"],
				files: [img("a.txt", "text/plain")],
			}),
		).toEqual([]);
		expect(extractImageFiles({ types: ["Files"], files: [] })).toEqual([]);
	});

	test("empty for missing dataTransfer", () => {
		expect(extractImageFiles(null)).toEqual([]);
		expect(extractImageFiles(undefined)).toEqual([]);
	});
});
