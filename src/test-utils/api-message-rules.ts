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
 * ── The rules (19 shapes measured against production Anthropic, 2026-07-25) ──
 *
 *   1. First message must be `user`.
 *   2. The conversation must END with a `user` message — SENDABLE ONLY.
 *      400 "This model does not support assistant message prefill."
 *   3. tool_use answering: flatten the user messages after an
 *      assistant-with-tool_use into one block stream and take the MAXIMAL
 *      LEADING RUN of `tool_result` blocks. It crosses message boundaries
 *      freely; ANY non-tool_result block ends it — including a *trailing*
 *      text block in an otherwise-fine message, and including a plain-string
 *      user message. Every tool_use must be answered inside that run.
 *   4. Every `tool_result` must answer a `tool_use` in the preceding assistant
 *      message.
 *
 * NOT rules, though our mock used to enforce them:
 *   - role alternation (user/user, user/user/user, assistant/assistant: all OK)
 *   - non-empty content ("", [], [{type:"text",text:""}]: all OK)
 *
 * Rule 3 is why `buildUserTurn` packs `[...tool_results, ...queueMessages]`
 * with the tool_results FIRST. That order is an API requirement, not a style
 * choice, and this module is the only thing guarding it.
 *
 * ⚠️ If you add a rule here, it MUST carry the real API error string it
 * mirrors. Cannot quote one? Then you have not verified it, and it does not
 * belong in a predicate named after the API — see `assertNoEmptyContent` for
 * where OUR OWN expectations go.
 */

export interface ApiMessage {
	role: "user" | "assistant";
	content: unknown;
}

interface Block {
	type?: string;
	id?: string;
	tool_use_id?: string;
}

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
 * Rules that hold for ANY message array, including one that is still being
 * built up. Deliberately silent about the trailing role, and about a trailing
 * assistant whose tool_results have simply not been appended yet.
 */
export function wellFormedPrefixViolations(messages: ApiMessage[]): string[] {
	const out: string[] = [];
	if (messages.length === 0) return ["Messages array must not be empty"];

	if (messages[0]?.role !== "user") {
		out.push(
			`First message must be role 'user', got '${messages[0]?.role}'. ` +
				"Real API: 'first message must use the \"user\" role'.",
		);
	}

	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (!m || m.role !== "assistant") continue;
		const ids = toolUseIdsOf(m);
		if (ids.size === 0) continue;

		const { answered, terminated, dupes } = collectAnswerRun(messages, i);
		for (const id of dupes) {
			out.push(
				`Duplicate tool_result for tool_use_id '${id}' after assistant at index ${i}.`,
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
							"Real API: '`tool_use` ids were found without `tool_result` blocks immediately after. " +
							"Each `tool_use` block must have a corresponding `tool_result` block in the next message.'",
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
						"Real API: 'unexpected `tool_use_id` found in `tool_result` blocks. " +
						"Each `tool_result` block must have a corresponding `tool_use` block in the previous message.'",
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
				"Real API: 'This model does not support assistant message prefill. " +
				"The conversation must end with a user message.'",
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
						"Real API: '`tool_use` ids were found without `tool_result` blocks immediately after.'",
				);
			}
		}
	}

	return [...new Set(out)];
}

/**
 * OUR OWN expectation, not an API rule — the real API accepts `""`, `[]` and
 * `[{type:"text",text:""}]` (measured). An empty user message almost certainly
 * means a bug on our side, so tests may opt in; it must never live inside a
 * predicate named after the API.
 */
export function emptyContentViolations(messages: ApiMessage[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (!m) continue;
		if (m.content === undefined || m.content === null) {
			out.push(`Message at index ${i} has empty content`);
		} else if (typeof m.content === "string" && m.content.length === 0) {
			out.push(`Message at index ${i} has empty string content`);
		} else if (Array.isArray(m.content) && m.content.length === 0) {
			out.push(`Message at index ${i} has empty content array`);
		}
	}
	return out;
}
