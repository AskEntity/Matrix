/**
 * Should Edit / Rewind be available on this message?
 *
 * Edit and Rewind are one backend operation (Rewind = an Edit whose content
 * didn't change), so one answer governs both buttons.
 *
 * ── Two conditions, and they are NOT the same kind of thing ───────────────
 *
 * They are judged independently, by two modules that don't know about each
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
 * Their only shared property is that both make the button grey. That is a
 * fact about rendering, not a common concept — resist the pull to give them a
 * shared abstraction just because the pixels agree. This module is the one
 * place they meet, and all it does is pick which sentence to show.
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

import type { AgentActivity } from "@mxd/types";
import { isWorking } from "./agent-activity.ts";

/** Why the buttons are grey. Each reason is its own sentence to the user. */
export type EditBlockedReason =
	/**
	 * PERMANENT. The message landed inside a run that was already going, so
	 * there is nothing to regenerate from here.
	 */
	| "did_not_start_run"
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
 * @param startsRun  from `messageStartsRun` — `undefined` = couldn't tell.
 * @param activity   the agent's current state; `undefined` = no agent.
 */
export function editVerdict(
	startsRun: boolean | undefined,
	activity: AgentActivity | undefined,
): EditVerdict {
	if (startsRun === undefined)
		return { editable: false, reason: "unknown_message" };
	if (!startsRun) return { editable: false, reason: "did_not_start_run" };
	if (isWorking(activity)) return { editable: false, reason: "agent_busy" };
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
		case "unknown_message":
			return "That message is not part of the current conversation — an earlier rewind replaced it.";
	}
}
