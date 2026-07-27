import { describe, expect, test } from "bun:test";
import {
	API_ERROR,
	type ApiMessage,
	emptyContentViolations,
	PROBED_SHAPES,
	sendableRequestViolations,
	UNPROBED,
	wellFormedPrefixViolations,
} from "./api-message-rules.ts";

/**
 * The rules module's own tests. It had none: it was exercised only through the
 * mock, which meant the one thing nobody could see was a rule that was MISSING
 * — and that is precisely what happened. `[{type:"text",text:""}]` sat under
 * "NOT rules" as legal for two days after being measured a 400, and no test
 * anywhere could have gone red about it, because a rule that does not exist
 * has no test.
 *
 * So this file pins BOTH directions of every content rule. The over-strict
 * direction is not padding: a guard that rejects too much reddens nothing, it
 * just silently stops a legal path working, which is the typical way a guard
 * fails here.
 */

const userText = (text: string): ApiMessage => ({ role: "user", content: text });

describe("rule 5 — empty and whitespace-only content (measured 2026-07-25)", () => {
	// ── The rule fires ──

	test("an empty text block is reported, quoting the API's own error", () => {
		const msgs: ApiMessage[] = [
			userText("hi"),
			{ role: "assistant", content: [{ type: "text", text: "" }] },
			userText("go on"),
		];
		const violations = wellFormedPrefixViolations(msgs);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toContain(API_ERROR.emptyTextBlock);
		expect(violations[0]).toContain("index 1");
	});

	test("a whitespace-only text block is reported, with its OWN error string", () => {
		const msgs: ApiMessage[] = [
			userText("hi"),
			{ role: "assistant", content: [{ type: "text", text: "  " }] },
			userText("go on"),
		];
		const violations = wellFormedPrefixViolations(msgs);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toContain(API_ERROR.whitespaceTextBlock);
		// The API answers these two differently, and keeping them apart is what
		// says the pair was really sent rather than generalised from one case.
		expect(violations[0]).not.toContain(API_ERROR.emptyTextBlock);
	});

	test("a newline-only text block is reported — the reachable production shape", () => {
		// Both emit sites guard on TRUTHINESS (`if (partialText)`), so "" cannot
		// be produced but "\n" can: a model whose first streamed token is a
		// newline, interrupted in that window. Draft 01KYDKK0.
		const msgs: ApiMessage[] = [
			userText("hi"),
			{ role: "assistant", content: [{ type: "text", text: "\n" }] },
			userText("go on"),
		];
		expect(wellFormedPrefixViolations(msgs)[0]).toContain(
			API_ERROR.whitespaceTextBlock,
		);
	});

	test("it fires on the USER role too, not only the assistant", () => {
		const msgs: ApiMessage[] = [
			{ role: "user", content: [{ type: "text", text: "" }] },
		];
		expect(wellFormedPrefixViolations(msgs)[0]).toContain(
			API_ERROR.emptyTextBlock,
		);
	});

	test("it is a PREFIX violation — reported at every position, not just the tail", () => {
		// Measured mid-conversation as readily as at the tail, so no future
		// append can rescue it. This is why the check does not live in
		// sendableRequestViolations.
		const mid: ApiMessage[] = [
			userText("hi"),
			{ role: "assistant", content: [{ type: "text", text: "" }] },
			userText("a"),
			{ role: "assistant", content: [{ type: "text", text: "real" }] },
			userText("b"),
		];
		expect(wellFormedPrefixViolations(mid)).toHaveLength(1);
		// And an INCOMPLETE prefix — one that is not sendable yet — still gets
		// it, which is the whole point of putting it in the prefix predicate.
		const incomplete: ApiMessage[] = [
			userText("hi"),
			{ role: "assistant", content: [{ type: "text", text: "" }] },
		];
		expect(wellFormedPrefixViolations(incomplete)).toHaveLength(1);
	});

	test('a bare "" as a USER message\'s content is reported', () => {
		const msgs: ApiMessage[] = [userText("hi"), userText("")];
		const violations = wellFormedPrefixViolations(msgs);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toContain(API_ERROR.emptyUserContent);
	});

	test("sendableRequestViolations inherits it", () => {
		const msgs: ApiMessage[] = [
			userText("hi"),
			{ role: "assistant", content: [{ type: "text", text: " " }] },
			userText("go on"),
		];
		expect(sendableRequestViolations(msgs)[0]).toContain(
			API_ERROR.whitespaceTextBlock,
		);
	});

	// ── The rule does NOT fire: the over-strict direction ──
	//
	// Every shape below was MEASURED 200. A check that reddens on one of these
	// costs us a legal path with nothing to show it, which is how a guard
	// usually fails.

	test("an empty content ARRAY is NOT reported", () => {
		const msgs: ApiMessage[] = [
			userText("hi"),
			{ role: "assistant", content: [] },
			userText("go on"),
		];
		expect(wellFormedPrefixViolations(msgs)).toEqual([]);
		expect(sendableRequestViolations(msgs)).toEqual([]);
	});

	test('a bare "" as an ASSISTANT message\'s content is NOT reported', () => {
		const msgs: ApiMessage[] = [
			userText("hi"),
			{ role: "assistant", content: "" },
			userText("go on"),
		];
		expect(wellFormedPrefixViolations(msgs)).toEqual([]);
		expect(sendableRequestViolations(msgs)).toEqual([]);
	});

	test("text that is merely PADDED with whitespace is NOT reported", () => {
		const msgs: ApiMessage[] = [
			userText("hi"),
			{ role: "assistant", content: [{ type: "text", text: "  hello  " }] },
			userText("go on"),
		];
		expect(wellFormedPrefixViolations(msgs)).toEqual([]);
	});

	test("rule 5 keys on the block TYPE, not on having a `text` field", () => {
		// ⚠️ The fixture is synthetic on purpose, and that is the finding. The
		// first two versions of this test used real shapes — an empty
		// tool_result and `{type:"thinking",thinking:""}` — and BOTH passed
		// against an implementation with the `b.type !== "text"` filter deleted,
		// because no real block type carries a `text` field at all. So the type
		// filter and the `typeof b.text === "string"` narrowing cover for each
		// other, and a pair that covers for itself is a pair where neither half
		// is pinned. Only a block that is both non-text AND text-bearing can
		// see the line.
		const msgs: ApiMessage[] = [
			userText("hi"),
			{ role: "assistant", content: [{ type: "thinking", text: "  " }] },
			userText("go on"),
		];
		expect(wellFormedPrefixViolations(msgs)).toEqual([]);
	});

	test("CONTRACT: rule 5 walks TOP-LEVEL blocks only, and only `text` ones", () => {
		// Not a scenario — nothing produces these today, so do not try to
		// reproduce it. It states the scope limit recorded in UNPROBED: `text`
		// blocks are what was measured, and nesting was never sent at all.
		// Widening by analogy is the exact move that put the fiction in this
		// file, so it should be a decision somebody makes on purpose.
		const nested: ApiMessage[] = [
			userText("hi"),
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "tc_1", name: "bash", input: {} }],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tc_1",
						content: [{ type: "text", text: "" }],
					},
				],
			},
		];
		expect(sendableRequestViolations(nested)).toEqual([]);

		const realThinking: ApiMessage[] = [
			userText("hi"),
			{
				role: "assistant",
				content: [{ type: "thinking", thinking: "", signature: "sig" }],
			},
			userText("go on"),
		];
		expect(wellFormedPrefixViolations(realThinking)).toEqual([]);
	});
});

describe("emptyContentViolations — OUR expectation, scoped to what is LEGAL", () => {
	test("reports the legal-but-suspicious forms", () => {
		const msgs: ApiMessage[] = [
			{ role: "user", content: [] },
			{ role: "assistant", content: "" },
			{ role: "user", content: undefined },
		];
		expect(emptyContentViolations(msgs)).toHaveLength(3);
	});

	test("does not report ordinary content", () => {
		expect(
			emptyContentViolations([
				userText("hi"),
				{ role: "assistant", content: [{ type: "text", text: "yes" }] },
			]),
		).toEqual([]);
	});

	test("the two forms that are real 400s live in the API predicate, not here", () => {
		// The split IS the fix. This helper's docstring claimed for two days
		// that the API accepts [{type:"text",text:""}]; it does not, so that
		// form must be reported by the predicate named after the API — and by
		// this one never, because this one is opt-in and nothing opts in.
		const emptyBlock: ApiMessage[] = [
			userText("hi"),
			{ role: "assistant", content: [{ type: "text", text: "" }] },
			userText("go on"),
		];
		expect(emptyContentViolations(emptyBlock)).toEqual([]);
		expect(wellFormedPrefixViolations(emptyBlock)).toHaveLength(1);

		const emptyUser: ApiMessage[] = [userText("hi"), userText("")];
		expect(emptyContentViolations(emptyUser)).toEqual([]);
		expect(wellFormedPrefixViolations(emptyUser)).toHaveLength(1);
	});
});

describe("provenance — every rule says when it last met the real API", () => {
	/**
	 * A date cannot be verified from in here; re-probing means re-sending, and
	 * that needs live credentials. What IS checkable is the structure that
	 * makes the record worth reading — which is the half that was missing:
	 * the file guarded what came IN (every rule must quote an API error) and
	 * nothing at all about what a rule carried once it was in.
	 */

	test("every probed shape carries an ISO date and the task that ran it", () => {
		expect(PROBED_SHAPES.length).toBeGreaterThan(0);
		for (const row of PROBED_SHAPES) {
			expect(row.shape.length).toBeGreaterThan(0);
			expect(row.lastProbed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(row.probe.length).toBeGreaterThan(0);
		}
	});

	test("a 400 row quotes an error; a 200 row cannot claim one", () => {
		for (const row of PROBED_SHAPES) {
			if (row.status === 400) {
				expect(row.apiError).toBeTruthy();
			} else {
				expect(row.apiError).toBeUndefined();
			}
		}
	});

	test("no rule may quote an API error with no probe behind it", () => {
		// The IN guard ("quote the real error") and the OUT guard ("say when
		// you last sent it") only meet if the same strings appear on both
		// sides. This is what makes a new rule impossible to add without a
		// dated row — the part prose could never enforce.
		const probed = new Set(
			PROBED_SHAPES.filter((r) => r.apiError).map((r) => r.apiError),
		);
		for (const [name, text] of Object.entries(API_ERROR)) {
			expect(`${name}: ${probed.has(text)}`).toBe(`${name}: true`);
		}
	});

	test("every error a predicate quotes is one of those strings", () => {
		// Extract the "Real API: '…'" citations the predicates actually emit
		// and check each against API_ERROR. An extractor that matches nothing
		// would pass this vacuously, so it must first be made to report ONE.
		const fixtures: ApiMessage[][] = [
			[{ role: "assistant", content: [{ type: "text", text: "x" }] }],
			[
				userText("hi"),
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "tc_1", name: "bash", input: {} }],
				},
				userText("no result here"),
			],
			[
				userText("hi"),
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "tc_1", name: "bash", input: {} }],
				},
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "tc_999", content: "orphan" },
					],
				},
			],
			[
				userText("hi"),
				{ role: "assistant", content: [{ type: "text", text: "" }] },
				userText("go on"),
			],
			[
				userText("hi"),
				{ role: "assistant", content: [{ type: "text", text: " " }] },
				userText("go on"),
			],
			[userText("hi"), userText("")],
			[userText("hi"), { role: "assistant", content: "trailing" }],
		];
		const quoted: string[] = [];
		for (const fixture of fixtures) {
			for (const v of sendableRequestViolations(fixture)) {
				for (const m of v.matchAll(/Real API: '([^']+)'/g)) {
					if (m[1]) quoted.push(m[1]);
				}
			}
		}
		// Made to report ONE (several, in fact) before its verdict means
		// anything — a zero here would be a claim about the regex.
		expect(quoted.length).toBeGreaterThanOrEqual(6);
		const known = new Set<string>(Object.values(API_ERROR));
		for (const q of quoted) expect(known.has(q)).toBe(true);
	});

	test("an UNPROBED check must NOT wear an API citation", () => {
		// The duplicate-tool_result check is ours: the API has never been asked.
		// If someone gives it a "Real API:" clause without sending anything,
		// this is where it stops.
		const msgs: ApiMessage[] = [
			userText("hi"),
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "tc_1", name: "bash", input: {} }],
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "tc_1", content: "ok" },
					{ type: "tool_result", tool_use_id: "tc_1", content: "again" },
				],
			},
		];
		const dupe = sendableRequestViolations(msgs).find((v) =>
			v.startsWith("Duplicate tool_result"),
		);
		expect(dupe).toBeDefined();
		expect(dupe).not.toContain("Real API:");
		expect(dupe).toContain("OUR rule");
		expect(
			UNPROBED.some((u) => u.claim.includes("same tool_use_id")),
		).toBe(true);
	});

	test("no row claims an empty text block is legal", () => {
		// The exact rot this file exists to make visible: a 200 row for the
		// shape that is a 400. Cheap, pointed, and it fires on the way back in.
		for (const row of PROBED_SHAPES) {
			if (row.status !== 200) continue;
			expect(row.shape).not.toContain('text:""');
			expect(row.shape).not.toContain('text:"  "');
		}
	});
});
