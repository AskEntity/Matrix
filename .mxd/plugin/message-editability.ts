/**
 * Should Edit / Rewind be available on this message?
 *
 * Edit and Rewind are one backend operation (Rewind = an Edit whose content
 * didn't change), so one answer governs both buttons.
 *
 * ── Three conditions, and they are NOT the same kind of thing ─────────────
 *
 * They are judged independently, by three modules that don't know about each
 * other, because they answer unrelated questions:
 *
 *   `isWorking` (agent-activity.ts) — is the agent busy RIGHT NOW? A limit in
 *      TIME. The operation is perfectly meaningful; you just can't do it this
 *      second, because it rewrites the conversation the agent is reasoning
 *      from. What the user needs to hear: *wait*.
 *
 *   `messageStartsRun` (run-start.ts) — did this message start a run? A limit
 *      in MEANING. Not "unsafe": undefined. The agent never ran from this
 *      message, so "run again from here" doesn't name anything. What the user
 *      needs to hear: *this one isn't a starting point*.
 *
 *   `hasRewindPoint` (rewind-point.ts) — is there a state to go back to? A
 *      limit in HISTORY. The message is in the conversation, but a compaction
 *      carried it across and the state around it was summarized away. What
 *      the user needs to hear: *that history is gone*.
 *
 * Their only shared property is that all three make the button grey. That is
 * a fact about rendering, not a common concept — resist the pull to give them
 * a shared abstraction just because the pixels agree.
 *
 * ── What THIS module is, and the line it must not cross ───────────────────
 *
 * It encodes one thing the three judgments can't: WHICH SENTENCE WINS. That
 * is a single product decision, and writing it as an if-chain on each side
 * would drift — the drift being a button that says "wait a moment" while the
 * 400 says "this one isn't a starting point", so the user waits, the agent
 * stops, and the button is still grey.
 *
 * ⚠️ The boundary, and it is checkable by grep: **this file has NO imports.**
 * `editVerdict` CONSUMES three verdicts and COMPUTES none of them. The moment
 * it starts deciding anything itself — reaching for an event, testing a tool
 * name, asking what the agent is doing — it has stopped being a presentation
 * rule and become the shared abstraction the three judgments are deliberately
 * not allowed to have. Split it then, not before: splitting it while it only
 * consumes costs you the one copy of the precedence.
 *
 * ── Precedence ────────────────────────────────────────────────────────────
 *
 * Not "whichever the code tests first". PERMANENT reasons outrank TRANSIENT
 * ones. "Wait for the agent to stop" promises a remedy; on a message that can
 * never be edited that promise is false, and the user who follows it comes
 * back to the same grey button unable to tell whether they waited wrong or
 * the product is broken. Never offer a remedy that won't work.
 *
 * Pure. The UI runs it to render the buttons, the `/edit` route runs it to
 * decide whether to accept.
 */

/** Why the buttons are grey. Each reason is its own sentence to the user. */
export type EditBlockedReason =
	/**
	 * PERMANENT. The message landed inside a run that was already going, so
	 * there is nothing to regenerate from here.
	 */
	| "did_not_start_run"
	/**
	 * PERMANENT. A compaction carried this message across; the state around
	 * it was summarized away, so there is no point to return to.
	 */
	| "no_rewind_point"
	/**
	 * PERMANENT. The eid names no message we can see. On the backend that
	 * means it is not on the active chain — an earlier rewind cut it away.
	 */
	| "unknown_message"
	/** TRANSIENT. The agent is working; stopping it opens the gate. */
	| "agent_busy";

export type EditVerdict =
	| { editable: true }
	| { editable: false; reason: EditBlockedReason };

const EDITABLE: EditVerdict = { editable: true };

/**
 * Every field is somebody else's answer. Nothing here is derived.
 *
 * @param startsRun       from `messageStartsRun` — `undefined` = couldn't tell.
 * @param hasRewindPoint  from `hasRewindPoint`.
 * @param agentBusy       from `isWorking`.
 */
export function editVerdict(judgments: {
	startsRun: boolean | undefined;
	hasRewindPoint: boolean;
	agentBusy: boolean;
}): EditVerdict {
	const { startsRun, hasRewindPoint, agentBusy } = judgments;
	// Permanent first, and among the permanent ones the most fundamental
	// first: a message we can't locate, then one whose history is gone, then
	// one that never started anything.
	if (startsRun === undefined)
		return { editable: false, reason: "unknown_message" };
	if (!hasRewindPoint) return { editable: false, reason: "no_rewind_point" };
	if (!startsRun) return { editable: false, reason: "did_not_start_run" };
	if (agentBusy) return { editable: false, reason: "agent_busy" };
	return EDITABLE;
}

/**
 * What the backend says when it refuses. Distinct text per reason — a shared
 * "not editable" would throw away the only part the caller can act on.
 */
export function editRefusalMessage(reason: EditBlockedReason): string {
	switch (reason) {
		case "agent_busy":
			return "The agent is working. Stop it first, then edit.";
		case "did_not_start_run":
			return "This message arrived while the agent was already working, so it never started a run — there is nothing to regenerate from here.";
		case "no_rewind_point":
			return "The history around this message was summarized away by a context compaction, so there is no state left to return to.";
		case "unknown_message":
			return "That message is not part of the current conversation — an earlier rewind replaced it.";
	}
}
