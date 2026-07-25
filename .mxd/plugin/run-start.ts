/**
 * Did this message start a run?
 *
 * A *run* is one wake→park cycle of the agent loop: it picks up pending
 * messages, works — possibly across several API round-trips and tool calls —
 * and parks again at `yield` / `done` / end_turn.
 *
 * Every message is one of two kinds. Either it STARTED a run (it arrived
 * while the agent was parked, and that run happened because of it), or it
 * landed inside a run that was ALREADY GOING (the user typed while the agent
 * was mid-work, and the message got picked up along the way).
 *
 * Only the first kind has a "regenerate from here". Rewinding means "run
 * again starting from this message" — and for the second kind the agent never
 * ran from that message in the first place. The run around it was started by
 * something earlier. There is no earlier state to return to that this message
 * is the beginning of, so the operation isn't dangerous, it's **undefined**:
 * it doesn't point at anything.
 *
 * (Such a rollback also produces a conversation the API rejects — an
 * unanswered tool call. That is a symptom, and a useful one, but it is not
 * the reason. If the API accepted it the operation would still be empty.)
 *
 * ── How it is decided ─────────────────────────────────────────────────────
 *
 * A run is provably still going when a tool call has been made and its result
 * has not been written yet. `yield` and `done` are excluded — and they are
 * not a special case, they are the clearest instance of the rule: those two
 * ARE the park. The loop deliberately leaves them unanswered while it waits
 * (buildSessionRepair calls this the intended orphan). A message arriving
 * after one of them lands on a parked agent, so it starts the next run.
 *
 * ── Where the log runs out of evidence ────────────────────────────────────
 *
 * There is one window the log cannot speak about: a message that arrives
 * while an API call is in flight with no tool outstanding. The agent was
 * working, so that message did not start the run — but nothing on disk says
 * so. Parking on `end_turn` writes no event, and activity is live process
 * state that is deliberately never persisted, so "parked, waiting for you"
 * and "waiting for the model" leave the identical trace: none. This module
 * answers with what the log supports and calls that message a run start.
 *
 * Being wrong in that direction costs an edit that regenerates slightly more
 * than the user pictured. Being wrong in the other direction would grey out
 * buttons on ordinary messages with an explanation the user can't verify.
 *
 * Pure: no DOM, no fetch, no node built-ins. The UI runs it to decide what
 * the buttons look like; the `/edit` route runs it to decide whether to
 * accept. Two implementations would drift, and drift here is a button that
 * lies in one direction or the other.
 */

import { TOOL_DONE, TOOL_YIELD } from "./tool-names.ts";

/**
 * The minimal structural shape this needs from a persisted event. Both a
 * backend `Event` and the raw events the UI fetches satisfy it.
 *
 * ⚠️ Feed these in DELIVERY order — the order they were written to the log.
 * The activity log RENDERS a user message where it was consumed, which for a
 * message typed mid-tool-call is a different place entirely. Judging by the
 * rendered order would call exactly the blocked case a run start.
 */
export type RunEvent = {
	type: string;
	tool?: string;
	toolCallId?: string;
	eid?: string;
	taskId?: string;
};

/** The two tool calls the loop leaves unanswered on purpose — the park. */
function isPark(tool: string | undefined): boolean {
	return tool === TOOL_YIELD || tool === TOOL_DONE;
}

/**
 * Fold state: tool calls seen so far with no result yet. Non-empty means a
 * run is provably still going at this point in the log.
 */
export interface RunScan {
	readonly outstanding: Set<string>;
}

export function beginRunScan(): RunScan {
	return { outstanding: new Set() };
}

/** Feed one event, in delivery order. */
export function scanRunEvent(scan: RunScan, event: RunEvent): void {
	if (event.type === "tool_call") {
		// The park is not outstanding work. Note it is skipped, not treated
		// as "everything before it finished": an agent that called `yield`
		// alongside a real tool still has that tool going.
		if (isPark(event.tool)) return;
		if (event.toolCallId) scan.outstanding.add(event.toolCallId);
		return;
	}
	if (event.type === "tool_result" && event.toolCallId) {
		scan.outstanding.delete(event.toolCallId);
	}
}

/** Would a message arriving at this point in the log start a run? */
export function atRunStart(scan: RunScan): boolean {
	return scan.outstanding.size === 0;
}

/**
 * One pass over a log: for every message carrying an eid, whether it started
 * a run. THE walk — the single-message lookup below and the UI's bulk
 * annotation both go through it, so there is one traversal to get right.
 *
 * Scans are kept per task: a sibling agent's tool calls say nothing about
 * what this task's agent was doing.
 */
export function messageRunStarts(
	events: readonly RunEvent[],
): Map<string, boolean> {
	const scans = new Map<string, RunScan>();
	const starts = new Map<string, boolean>();
	for (const event of events) {
		const key = event.taskId ?? "";
		let scan = scans.get(key);
		if (!scan) {
			scan = beginRunScan();
			scans.set(key, scan);
		}
		if (event.type === "message") {
			if (event.eid) starts.set(event.eid, atRunStart(scan));
			continue;
		}
		scanRunEvent(scan, event);
	}
	return starts;
}

/**
 * Did the message with this eid start a run? `undefined` when the eid names
 * no message in the sequence — "we can't tell", which is not the same as
 * "no". On the backend that happens when the message is not on the active
 * chain: an earlier rewind already cut it away.
 */
export function messageStartsRun(
	events: readonly RunEvent[],
	targetEid: string,
): boolean | undefined {
	return messageRunStarts(events).get(targetEid);
}
