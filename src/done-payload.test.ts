/**
 * DonePayload normalization — the ONE raw-input → round normalizer.
 *
 * These guard the DEFENSIVE contract: `parseDonePayload` reads a raw done()
 * tool_call input (which, across schema evolution / JSONL migrations, may be
 * partial or malformed) and always yields a well-formed DonePayload. Extra
 * fields the round shape doesn't know about are dropped; missing / malformed
 * fields fall back to their empty form. Never throws.
 */
import { describe, expect, test } from "bun:test";
import { type DonePayload, parseDonePayload } from "./done-payload.ts";

describe("parseDonePayload", () => {
	test("full, well-formed input round-trips", () => {
		expect(
			parseDonePayload({ result: "did the work", lessons: ["a", "b"] }),
		).toEqual({ result: "did the work", lessons: ["a", "b"] });
	});

	test("missing lessons → []", () => {
		expect(parseDonePayload({ result: "did it" })).toEqual({
			result: "did it",
			lessons: [],
		});
	});

	test("missing result → ''", () => {
		expect(parseDonePayload({ lessons: ["x"] })).toEqual({
			result: "",
			lessons: ["x"],
		});
	});

	test("undefined input → empty payload", () => {
		expect(parseDonePayload(undefined)).toEqual({ result: "", lessons: [] });
	});

	test("empty object → empty payload", () => {
		expect(parseDonePayload({})).toEqual({ result: "", lessons: [] });
	});

	test("EXTRA fields the round shape doesn't know about are dropped", () => {
		// A plugin-custom field (or a stale/future field) must NOT bleed into the
		// stored round — the round is bounded by the DonePayload shape.
		const out = parseDonePayload({
			result: "r",
			lessons: [],
			wordCount: 42,
			mood: "triumphant",
		});
		expect(out).toEqual({ result: "r", lessons: [] });
		expect("wordCount" in out).toBe(false);
		expect("mood" in out).toBe(false);
	});

	test("non-string result → '' (malformed value)", () => {
		expect(parseDonePayload({ result: 123, lessons: [] })).toEqual({
			result: "",
			lessons: [],
		});
	});

	test("non-array lessons → [] (malformed value)", () => {
		expect(parseDonePayload({ result: "r", lessons: "not an array" })).toEqual({
			result: "r",
			lessons: [],
		});
	});

	test("lessons array with non-string entries → only strings kept", () => {
		expect(
			parseDonePayload({ result: "r", lessons: ["keep", 1, null, "also"] }),
		).toEqual({ result: "r", lessons: ["keep", "also"] });
	});

	test("output is always a fresh, well-formed DonePayload (never throws)", () => {
		// Adversarial garbage inputs — the normalizer must never throw.
		const garbage: unknown[] = [
			null,
			{ result: {}, lessons: {} },
			{ result: [], lessons: 7 },
			{ result: true },
		];
		for (const g of garbage) {
			const out: DonePayload = parseDonePayload(
				g as Record<string, unknown> | undefined,
			);
			expect(typeof out.result).toBe("string");
			expect(Array.isArray(out.lessons)).toBe(true);
		}
	});
});
