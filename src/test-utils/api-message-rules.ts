/**
 * The Anthropic message-shape rules, MEASURED — and split into the TWO
 * predicates the codebase always needed.
 *
 * ── Why two ────────────────────────────────────────────────────────────────
 *
 * "Valid API request" is a property of a REQUEST, not of a message array. An
 * array that ends on an assistant turn is a perfectly good CONVERSATION PREFIX
 * — it just is not a SENDABLE REQUEST yet. Fusing those into one predicate is
 * what forced an either/or, and the either/or is how a fictional rule got in:
 *
 *   `jsonl-stress.test.ts`'s old `assertStructurallyValidApiMessages` wrote
 *   BOTH rules down in its own comment, then said "we don't assert the
 *   trailing-role rule because some walker outputs are intermediate and meant
 *   to be extended. We DO assert the alternation." The reasoning was CORRECT —
 *   some walker outputs really are prefixes. But role-alternation does not
 *   exist in the API, so the helper enforced a fiction and skipped the truth.
 *   628 "Messages must alternate roles" errors in our JSONL history, every one
 *   thrown by our own test double, none by Anthropic. Four production
 *   mechanisms were built to avoid that 400. See task 01KYCQ85 / memory.md.
 *
 * The missing thing was never rigor — it was a CONCEPT. Note that the pairing
 * rule has the same intermediate-state problem as the trailing-role rule (an
 * assistant's tool_results legitimately arrive after the prefix ends), so
 * courage alone would not have been enough: whoever tried to assert the true
 * rule would have gone red on correct fixtures twice, not once.
 *
 * ── The rules ──────────────────────────────────────────────────────────────
 *
 * Every rule carries the day it last met the real API. The shapes that were
 * SENT and what came back are in {@link PROBED_SHAPES}; anything this file
 * asserts WITHOUT ever having sent it is in {@link UNPROBED}. "We measured it
 * and it is fine" and "nobody has ever tried" must not read the same.
 *
 *   1. First message must be `user`.                              [2026-07-25]
 *   2. The conversation must END with a `user` message — SENDABLE ONLY.
 *      400 "This model does not support assistant message prefill."
 *                                                                 [2026-07-25]
 *   3. tool_use answering: flatten the user messages after an
 *      assistant-with-tool_use into one block stream and take the MAXIMAL
 *      LEADING RUN of `tool_result` blocks. It crosses message boundaries
 *      freely; ANY non-tool_result block ends it — including a *trailing*
 *      text block in an otherwise-fine message, and including a plain-string
 *      user message. Every tool_use must be answered inside that run.
 *                                                                 [2026-07-25]
 *   4. Every `tool_result` must answer a `tool_use` in the preceding assistant
 *      message.                                                   [2026-07-25]
 *   5. No EMPTY and no WHITESPACE-ONLY `text` block, at ANY position, on
 *      EITHER role — and no bare `""` as a USER message's whole content.
 *      Three separate 400s, one of which this file called LEGAL for two days
 *      — see the tombstone.                                       [2026-07-25]
 *
 * NOT rules — each measured LEGAL, not merely never-objected-to:
 *   - role alternation: user/user, user/user/user, assistant/assistant
 *                                                                 [2026-07-25]
 *   - an empty content ARRAY, `[]`                                 [2026-07-25]
 *   - a bare `""` as an ASSISTANT message's whole content          [2026-07-25]
 *
 * Rule 3 is why `buildUserTurn` packs `[...tool_results, ...queueMessages]`
 * with the tool_results FIRST. That order is an API requirement, not a style
 * choice, and this module is the only thing guarding it.
 *
 * ── ⚠️ Two guards, and this file was born with only the first ──────────────
 *
 * IN — a rule ADDED here MUST carry the real API error string it mirrors.
 * Cannot quote one? Then you have not verified it, and it does not belong in a
 * predicate named after the API; see {@link emptyContentViolations} for where
 * OUR OWN expectations go, and {@link UNPROBED} for how to say "we check this
 * but the API has never been asked".
 *
 * OUT — a rule KEPT here MUST carry the day it last met the API. Nothing can
 * make a MISSING rule announce itself; a STALE one can be made to look stale,
 * and until 2026-07-27 nothing here could.
 *
 * ⚠️ TOMBSTONE — the reason the dates exist. This file shipped at 15:28 on
 * 2026-07-25 listing `[{type:"text",text:""}]` under NOT rules as "all OK".
 * It is a 400. The BLOCK form had never been probed — the audit sent a bare
 * `""` and its write-up then listed all three "empty contents" together — so a
 * generalisation ended up inside a file whose name says MEASURED. (That
 * account is the later task's reading of how the two disagree. If a transcript
 * ever turns up showing the block form really was sent and really did return
 * 200, this stops being a stale line and becomes two contradictory
 * measurements, which is a much bigger thing to chase.)
 * memory.md was corrected at 22:43 the SAME DAY; this file was not,
 * and for two days the repo's designated record of the API's rules said a
 * reachable 400 was legal. A downstream agent then quoted three passages from
 * here word for word and derived a wrong correction from them, which is the
 * failure mode nothing else catches: the branch was opened, the citation was
 * exact, and the answer was still wrong.
 *
 * The mechanism is worth more than the instance. **An absent rule reads
 * exactly like a measured "legal", and a claim about ABSENCE — everything
 * under "NOT rules" — is where that costs the most.** A date does not detect
 * the omission either; what it buys is a reader who can see that a line has
 * not met the API since before the thing they are debugging.
 */

export interface ApiMessage {
	role: "user" | "assistant";
	content: unknown;
}

interface Block {
	type?: string;
	id?: string;
	tool_use_id?: string;
	text?: unknown;
}

/**
 * The API's own error texts, verbatim, quoted ONCE so that a violation message
 * and its provenance row cannot drift apart. Every string here appears in
 * {@link PROBED_SHAPES} with the day it was observed.
 */
export const API_ERROR = {
	firstMessageUser: 'first message must use the "user" role',
	assistantPrefill:
		"This model does not support assistant message prefill. The conversation must end with a user message.",
	unansweredToolUse:
		"`tool_use` ids were found without `tool_result` blocks immediately after. " +
		"Each `tool_use` block must have a corresponding `tool_result` block in the next message.",
	orphanToolResult:
		"unexpected `tool_use_id` found in `tool_result` blocks. " +
		"Each `tool_result` block must have a corresponding `tool_use` block in the previous message.",
	emptyTextBlock: "text content blocks must be non-empty",
	whitespaceTextBlock: "text content blocks must contain non-whitespace text",
	emptyUserContent: "user messages must have non-empty content",
	trailingThinkingBlock:
		"The final block in an assistant message cannot be `thinking`",
} as const;

/**
 * One shape that was actually SENT to production Anthropic, and what came
 * back. This is the provenance record for the rules above: a rule is either
 * here with a date, or in {@link UNPROBED} with the reason it is not.
 *
 * ⚠️ `lastProbed` is the day the shape was SENT — not the day someone re-read
 * this table and agreed with it. Bumping it without sending anything converts
 * the only signal here into decoration.
 *
 * ⚠️ Re-probing is a manual job and deliberately has no script. It needs live
 * OAuth credentials, so it cannot live in the test suite, and the auth group's
 * `systemPreamble` MUST be the first system block or every call comes back 429
 * — which reads exactly like a validation failure and nearly produced the
 * opposite conclusion the first time round.
 */
export interface ProbedShape {
	/** What was sent. `u`/`a` are roles, `|` separates messages, `[…]` is content. */
	shape: string;
	/** What production Anthropic answered. */
	status: 200 | 400;
	/** The API's own error text, as recorded by the probe. 400 rows only. */
	apiError?: string;
	/** ISO day this shape was last SENT to production Anthropic. */
	lastProbed: string;
	/** Task whose description / result rounds hold the probe's raw output. */
	probe: string;
	/** Anything a future re-prober needs to know before trusting this row. */
	note?: string;
}

export const PROBED_SHAPES: readonly ProbedShape[] = [
	// ── Rule 1 — the first message must be `user` ──
	{
		shape: "a[text] | u",
		status: 400,
		apiError: API_ERROR.firstMessageUser,
		lastProbed: "2026-07-25",
		probe: "01KYCQ856M3Z6F4EN247C4GW69",
		note:
			"Adopted into the four rules by the 19-shape audit; the quoted text comes from a " +
			"production 400 (FIX-5 R8-B#1 — a bare compact_marker left readActive() starting on " +
			"an assistant turn and bricked the session). No transcript of a deliberate " +
			"assistant-first probe survives, so treat the DATE as the audit's, not the string's.",
	},

	// ── Rule 2 — the conversation must END with `user` (sendable only) ──
	{
		shape: "u | a[text]",
		status: 400,
		apiError: API_ERROR.assistantPrefill,
		lastProbed: "2026-07-25",
		probe: "01KYCQ856M3Z6F4EN247C4GW69",
	},
	{
		shape: "u | a[thinking]",
		status: 400,
		apiError: API_ERROR.trailingThinkingBlock,
		lastProbed: "2026-07-25",
		probe: "01KYCQ856M3Z6F4EN247C4GW69",
		note:
			"⚠️ NOT a separate rule. It is rule 2 wearing a different error string — the SAME " +
			"assistant message is accepted when it is not last. Reading it as its own rule is how " +
			"someone builds a repair step that strips thinking tails, which was proposed and " +
			"cancelled by this measurement. Positionally a thinking block is identical to a text " +
			"block; that is why no rule here mentions thinking.",
	},

	// ── Rule 3 — tool_use answering is the maximal LEADING RUN of tool_results ──
	{
		shape: "u | a[tool_use] | u[text]",
		status: 400,
		apiError: API_ERROR.unansweredToolUse,
		lastProbed: "2026-07-25",
		probe: "01KYCQ856M3Z6F4EN247C4GW69",
	},
	{
		shape: "u | a[tool_use] | u[tool_result] | u[text]",
		status: 200,
		lastProbed: "2026-07-25",
		probe: "01KYCQ856M3Z6F4EN247C4GW69",
		note: "The run may be followed by ordinary user turns once it is complete.",
	},
	{
		shape: "u | a[tool_use ×2] | u[R1, text] | u[R2]",
		status: 400,
		apiError: API_ERROR.unansweredToolUse,
		lastProbed: "2026-07-25",
		probe: "01KYCQ856M3Z6F4EN247C4GW69",
		note: "The TRAILING text block ends the run, so R2 arrives after it has closed.",
	},
	{
		shape: "u | a[tool_use] | u[text, R1]",
		status: 400,
		apiError: API_ERROR.unansweredToolUse,
		lastProbed: "2026-07-25",
		probe: "01KYCQ856M3Z6F4EN247C4GW69",
		note: "Block order INSIDE one message matters — this is what pins tool_results-first.",
	},
	{
		shape: "u | a[tool_use ×2] | u[R2] | u[R1, text]",
		status: 200,
		lastProbed: "2026-07-25",
		probe: "01KYCQ856M3Z6F4EN247C4GW69",
		note: "Split across messages, in any order, is fine — the run crosses boundaries.",
	},

	// ── Rule 4 — every tool_result answers a tool_use in the previous assistant ──
	{
		shape: "u | a[tool_use tc_1] | u[tool_result tc_999]",
		status: 400,
		apiError: API_ERROR.orphanToolResult,
		lastProbed: "2026-07-25",
		probe: "01KYCQ856M3Z6F4EN247C4GW69",
		note:
			"Rule and error string recorded by the audit; the exact probe shape is not preserved " +
			"in a durable record, so the shape above is this file's reconstruction of it.",
	},

	// ── Rule 5 — empty / whitespace-only content ──
	// Probed SEVEN HOURS after this file shipped, by a different task, and
	// landed only in memory.md (commit 10e018e4). That gap is the tombstone.
	{
		shape: 'u | a[{type:"text",text:""}] | u',
		status: 400,
		apiError: API_ERROR.emptyTextBlock,
		lastProbed: "2026-07-25",
		probe: "01KYDKK0FTM9QGNJTK6TH67C6H",
		note: "Mid-conversation, and on either role — this is NOT a tail rule.",
	},
	{
		shape: 'u | a[{type:"text",text:"  "}] | u',
		status: 400,
		apiError: API_ERROR.whitespaceTextBlock,
		lastProbed: "2026-07-25",
		probe: "01KYDKK0FTM9QGNJTK6TH67C6H",
		note:
			"A separate error string from the empty case, which is itself the evidence that both " +
			"were really sent rather than generalised from one another.",
	},
	{
		shape: 'u (content: "")',
		status: 400,
		apiError: API_ERROR.emptyUserContent,
		lastProbed: "2026-07-25",
		probe: "01KYDKK0FTM9QGNJTK6TH67C6H",
		note:
			"Recorded as a per-message rejection; the position it was sent in is not preserved. " +
			"Checked as a PREFIX violation because no later append can rescue a message that is " +
			"already in the array — if it ever turns out to be tail-only, it belongs in " +
			"sendableRequestViolations instead.",
	},

	// ── Measured LEGAL. These are the "NOT rules", and they are load-bearing:
	//    the mock enforced the first three as 400s for months. ──
	{
		shape: "u | u",
		status: 200,
		lastProbed: "2026-07-25",
		probe: "01KYCQ856M3Z6F4EN247C4GW69",
	},
	{
		shape: "u | u | u",
		status: 200,
		lastProbed: "2026-07-25",
		probe: "01KYCQ856M3Z6F4EN247C4GW69",
	},
	{
		shape: "u | a | a | u",
		status: 200,
		lastProbed: "2026-07-25",
		probe: "01KYCQ856M3Z6F4EN247C4GW69",
	},
	{
		shape: "u | a[] | u",
		status: 200,
		lastProbed: "2026-07-25",
		probe: "01KYDKK0FTM9QGNJTK6TH67C6H",
		note: "An empty content ARRAY is legal; an array holding an empty text block is not.",
	},
	{
		shape: 'u | a (content: "") | u',
		status: 200,
		lastProbed: "2026-07-25",
		probe: "01KYDKK0FTM9QGNJTK6TH67C6H",
		note:
			"⚠️ The legal empty case is the BARE STRING on an ASSISTANT message — never a block " +
			"wrapping one, and never the user role. Widening this row is exactly the mistake the " +
			"tombstone records.",
	},
	{
		shape: "u | a[thinking] | u   ·   u | a[text, thinking] | u",
		status: 200,
		lastProbed: "2026-07-25",
		probe: "01KYCQ856M3Z6F4EN247C4GW69",
		note: "Probed with real signed thinking blocks. See the trailing-thinking row.",
	},
];

/**
 * Claims this file MAKES but has never SENT. Everything here is either our own
 * expectation or a deliberate scope limit — never a measurement, and never to
 * be quoted as API behaviour.
 *
 * This list exists because the tombstone's fiction did not arrive as a guess:
 * it arrived as a generalisation sitting in a MEASURED file, where it was
 * indistinguishable from the rows above. An unknown that has nowhere to live
 * gets filed as a fact.
 */
export interface UnprobedClaim {
	/** The claim, in the same shorthand as {@link PROBED_SHAPES}. */
	claim: string;
	/** Why it has never been sent, and what must NOT be read into it. */
	note: string;
}

export const UNPROBED: readonly UnprobedClaim[] = [
	{
		claim: "two tool_result blocks answering the same tool_use_id",
		note:
			"`wellFormedPrefixViolations` reports it and the API's verdict has never been probed. " +
			"The check earns its place — buildSessionRepair treats a duplicate result as a " +
			"corruption shape and chains back before it — but its message deliberately does not " +
			"quote an API error, because there is none to quote.",
	},
	{
		claim: "an EMPTY messages array",
		note:
			"`wellFormedPrefixViolations` rejects it and the API has never been asked. It is " +
			"almost certainly a 400 — which is exactly the reasoning that put the tombstone in " +
			"this file, so it stays here until somebody sends one.",
	},
	{
		claim: "content: undefined / null",
		note:
			"OUR rule, in `emptyContentViolations`. Not sendable through the SDK at all, so there " +
			"is nothing to probe; it means a bug on our side.",
	},
	{
		claim:
			"an empty or whitespace-only `thinking` block, or an empty `tool_result`",
		note:
			"Rule 5's check covers `text` blocks ONLY, because `text` is what was measured. Do " +
			"NOT widen it by analogy with the thinking/text positional equivalence — that " +
			"equivalence is about POSITION, and rule 5 is about a block's own content.",
	},
];

function toolUseIdsOf(msg: ApiMessage): Set<string> {
	const ids = new Set<string>();
	if (!Array.isArray(msg.content)) return ids;
	for (const b of msg.content as Block[]) {
		if (b && typeof b === "object" && b.type === "tool_use" && b.id) {
			ids.add(b.id);
		}
	}
	return ids;
}

/**
 * Walk the maximal leading run of tool_result blocks after `from`.
 *
 * `terminated` distinguishes "the run was ended by a non-tool_result block"
 * from "the run ran off the end of the array". Only the first is a definite
 * violation in prefix mode — in the second case the results may still be
 * appended.
 */
function collectAnswerRun(
	messages: ApiMessage[],
	from: number,
): { answered: Set<string>; terminated: boolean; dupes: string[] } {
	const answered = new Set<string>();
	const dupes: string[] = [];
	for (let j = from + 1; j < messages.length; j++) {
		const next = messages[j];
		if (!next || next.role !== "user")
			return { answered, terminated: true, dupes };
		// A plain-string user message carries no tool_result and ends the run.
		if (!Array.isArray(next.content))
			return { answered, terminated: true, dupes };
		for (const b of next.content as Block[]) {
			if (!b || typeof b !== "object" || b.type !== "tool_result") {
				return { answered, terminated: true, dupes };
			}
			const id = b.tool_use_id ?? "";
			if (answered.has(id)) dupes.push(id);
			answered.add(id);
		}
	}
	return { answered, terminated: false, dupes };
}

/**
 * Rule 5 — content that the API rejects wherever it appears.
 *
 * These belong to the PREFIX predicate rather than the sendable one because
 * they are properties of a message that is already in the array: appending
 * more messages cannot rescue an empty text block behind you. Measured
 * mid-conversation as readily as at the tail.
 */
function emptyBlockViolations(messages: ApiMessage[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (!m) continue;

		if (m.role === "user" && m.content === "") {
			out.push(
				`Empty string content on the user message at index ${i}. ` +
					`Real API: '${API_ERROR.emptyUserContent}'. ` +
					"(The same on an ASSISTANT message is legal — measured.)",
			);
		}

		if (!Array.isArray(m.content)) continue;
		for (const b of m.content as Block[]) {
			if (!b || typeof b !== "object" || b.type !== "text") continue;
			if (typeof b.text !== "string") continue;
			if (b.text.length === 0) {
				out.push(
					`Empty text block in the ${m.role} message at index ${i}. ` +
						`Real API: '${API_ERROR.emptyTextBlock}'.`,
				);
			} else if (b.text.trim().length === 0) {
				out.push(
					`Whitespace-only text block in the ${m.role} message at index ${i}. ` +
						`Real API: '${API_ERROR.whitespaceTextBlock}'.`,
				);
			}
		}
	}
	return out;
}

/**
 * Rules that hold for ANY message array, including one that is still being
 * built up. Deliberately silent about the trailing role, and about a trailing
 * assistant whose tool_results have simply not been appended yet.
 */
export function wellFormedPrefixViolations(messages: ApiMessage[]): string[] {
	const out: string[] = [];
	if (messages.length === 0) {
		// ⚠️ No "Real API:" clause — see UNPROBED. Obvious is not measured.
		return [
			"Messages array must not be empty. (OUR rule — this shape has never " +
				"been sent to the real API.)",
		];
	}

	if (messages[0]?.role !== "user") {
		out.push(
			`First message must be role 'user', got '${messages[0]?.role}'. ` +
				`Real API: '${API_ERROR.firstMessageUser}'.`,
		);
	}

	out.push(...emptyBlockViolations(messages));

	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (!m || m.role !== "assistant") continue;
		const ids = toolUseIdsOf(m);
		if (ids.size === 0) continue;

		const { answered, terminated, dupes } = collectAnswerRun(messages, i);
		for (const id of dupes) {
			// ⚠️ No "Real API:" clause on purpose — see UNPROBED. The API has
			// never been asked what it does with a duplicate tool_result.
			out.push(
				`Duplicate tool_result for tool_use_id '${id}' after assistant at index ${i}. ` +
					"(OUR rule — this shape has never been sent to the real API; it is a " +
					"corruption shape buildSessionRepair chains back before.)",
			);
		}
		// Unanswered ids are only a definite violation once the run has been
		// ENDED by something else. If it ran off the end of the array, this is
		// an incomplete prefix, not a broken one.
		if (terminated) {
			for (const id of ids) {
				if (!answered.has(id)) {
					out.push(
						`Missing tool_result for tool_use_id '${id}' (assistant at index ${i}). ` +
							`Real API: '${API_ERROR.unansweredToolUse}'`,
					);
				}
			}
		}
	}

	// A tool_result answering nothing is broken at ANY position — no future
	// append can rescue it.
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (!m || m.role !== "user" || !Array.isArray(m.content)) continue;
		for (const b of m.content as Block[]) {
			if (!b || typeof b !== "object" || b.type !== "tool_result") continue;
			const id = b.tool_use_id ?? "";
			let prevAssistant: ApiMessage | undefined;
			for (let j = i - 1; j >= 0; j--) {
				if (messages[j]?.role === "assistant") {
					prevAssistant = messages[j];
					break;
				}
			}
			if (!prevAssistant || !toolUseIdsOf(prevAssistant).has(id)) {
				out.push(
					`Unexpected tool_result for tool_use_id '${id}' at index ${i} — no matching tool_use. ` +
						`Real API: '${API_ERROR.orphanToolResult}'`,
				);
			}
		}
	}

	return [...new Set(out)];
}

/**
 * Everything in {@link wellFormedPrefixViolations}, plus the rules that only
 * bind at the moment you actually send: the conversation must end with a user
 * message, and by then every tool_use must be answered.
 */
export function sendableRequestViolations(messages: ApiMessage[]): string[] {
	const out = wellFormedPrefixViolations(messages);
	if (messages.length === 0) return out;

	const last = messages[messages.length - 1];
	if (last?.role !== "user") {
		out.push(
			`Conversation must end with a user message, got '${last?.role}' at index ${messages.length - 1}. ` +
				`Real API: '${API_ERROR.assistantPrefill}'`,
		);
	}

	// A trailing assistant with unanswered tool_uses: the prefix check let it
	// pass (results might still come), but nothing more is coming now.
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (!m || m.role !== "assistant") continue;
		const ids = toolUseIdsOf(m);
		if (ids.size === 0) continue;
		const { answered, terminated } = collectAnswerRun(messages, i);
		if (terminated) continue; // already reported by the prefix check
		for (const id of ids) {
			if (!answered.has(id)) {
				out.push(
					`Missing tool_result for tool_use_id '${id}' (assistant at index ${i}). ` +
						`Real API: '${API_ERROR.unansweredToolUse}'`,
				);
			}
		}
	}

	return [...new Set(out)];
}

/**
 * OUR OWN expectation, not an API rule. Scoped to the forms the API really
 * does accept and we still do not want to send: an empty content ARRAY, and a
 * bare `""` as an ASSISTANT message's whole content (both measured 200,
 * 2026-07-25). An empty message almost certainly means a bug on our side, so
 * tests may opt in — but it must never live inside a predicate named after the
 * API.
 *
 * ⚠️ The two forms that are NOT here have moved to
 * {@link wellFormedPrefixViolations}, because they are real 400s: a bare `""`
 * on a USER message, and a text block wrapping an empty or whitespace-only
 * string. This docstring asserted the opposite for two days.
 */
export function emptyContentViolations(messages: ApiMessage[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (!m) continue;
		if (m.content === undefined || m.content === null) {
			// Never probed — not sendable through the SDK at all. See UNPROBED.
			out.push(`Message at index ${i} has empty content`);
		} else if (
			typeof m.content === "string" &&
			m.content.length === 0 &&
			m.role === "assistant"
		) {
			out.push(`Message at index ${i} has empty string content`);
		} else if (Array.isArray(m.content) && m.content.length === 0) {
			out.push(`Message at index ${i} has empty content array`);
		}
	}
	return out;
}
