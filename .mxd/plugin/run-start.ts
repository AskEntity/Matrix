/**
 * Was this message sent on its own?
 *
 * The user's own words for what this decides: **只有独立发送的消息才能回滚** —
 * only a message you sent on its own can be rewound. Everything below is how
 * that is established; this sentence is what the function means, and it is
 * the one every outward-facing string should use.
 *
 * A message is either the thing that set the agent going, or it got swept up
 * into work the agent was already doing. Rewinding means "run again starting
 * from this message", and for the second kind the agent never ran from it —
 * the work around it was set off by something earlier. So the operation isn't
 * dangerous, it's **undefined**: it doesn't point at anything.
 *
 * (Such a rollback also tends to produce a conversation the API rejects, an
 * unanswered tool call. That is a symptom, and a useful one, but not the
 * reason. If the API accepted it the operation would still be empty.)
 *
 * ── The evidence: which user turn it was consumed into ────────────────────
 *
 * The loop builds one user turn out of `[...tool_results, ...queued messages]`
 * (`buildUserTurn`). So a turn carrying a tool_result is ANSWERING the agent's
 * previous output — the messages riding along in it did not start it. A turn
 * with no tool_result has nothing to answer: it exists because a message
 * arrived.
 *
 * That is decidable from the log, because `messages_consumed` and the
 * tool_results before it are both persisted.
 *
 * **Not every tool_result points backwards.** The rule is about CAUSATION,
 * and for two of them the arrow is reversed:
 *
 *   bash, read_file, … — the call was already made, so the result was coming
 *      no matter what the user did. It is the message's CAUSE: the message
 *      landed in work that was already on its way.
 *
 *   yield, done — the loop leaves the park unanswered while it waits and
 *      writes the result as it WAKES. What woke it is this message. The
 *      result is the message's CONSEQUENCE, not its cause; the agent was
 *      doing nothing at all when the message arrived.
 *
 * So a turn whose only tool_results are parks is answering nothing. This is
 * not a third exemption for yield/done — it is the same fact as "they are the
 * park" and "they are the turn boundary", read causally. Comparing two tool
 * names is only how the direction is DETECTED.
 *
 * Measured: 1513 of root's 3621 user messages sit in the park shape, and it
 * is the DOMINANT shape for sub-agents — every task ends in `done()` and is
 * later woken by a message, which is the most independent message there is.
 * Treating parks as prior work would call the most common editable case
 * un-editable.
 *
 * **Other messages in the same turn don't matter.** Two messages that arrive
 * while the agent is parked are consumed together, and both started that run
 * — rewinding to the first replaces both, rewinding to the second keeps the
 * first. Both are meaningful. Only tool_results decide.
 *
 * ── Why not "was there an unclosed tool call when it arrived?" ────────────
 *
 * That was the first implementation, and it is a PROXY for the question above
 * that fails in the gap where the agent is thinking. This module's header
 * used to argue the log couldn't do better:
 *
 *   > Parking on end_turn writes no event, and activity is live process state
 *   > that is deliberately never persisted, so "parked, waiting for you" and
 *   > "waiting for the model" leave the identical trace: none.
 *
 * **That argument is wrong, and it is worth knowing where.** The DELIVERY
 * moment leaves no trace — true. But the CONSUMPTION moment does, and that is
 * the moment that actually answers the question. Looking for evidence at the
 * wrong instant is what made the log look mute.
 *
 * It was not a corner case. The first real test of the feature hit it: a
 * message typed while the agent was composing a bash call, ten seconds before
 * the `tool_call` was written. No outstanding call at delivery, so the proxy
 * said "sent on its own" — but it was consumed together with that bash's
 * result, so it plainly wasn't. Wall-clock the thinking gap is small; as a
 * share of user actions it is not, because "ask for something, then add one
 * more thing while it starts" is the most natural way to add to a request.
 *
 * Measured on the root session (3621 user messages): the proxy called 97.2%
 * editable, this rule calls 79.8%. The 629 it newly blocks were all consumed
 * into turns answering real work (160 bash, 89 create_task, 72 search, …).
 * **It opens nothing the proxy blocked** — strictly stricter, never looser.
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
 */
export type RunEvent = {
	type: string;
	tool?: string;
	eid?: string;
	taskId?: string;
	/** On a `message`: the queue id `messages_consumed` will refer to. */
	id?: string;
	/** On a `messages_consumed`: the queue ids this turn picked up. */
	messageIds?: string[];
};

/**
 * Does this tool_result mean the turn is answering work that was already
 * under way — was it CAUSED by something that happened before the message?
 *
 * True for real tools: the call had been made, the result was going to land
 * regardless. False for `yield`/`done`: the loop writes those at wake, and
 * what woke it is the very message being judged, so the result is that
 * message's consequence. Name comparison is the detection; the direction of
 * causation is the rule.
 */
function isPriorWork(tool: string | undefined): boolean {
	return tool !== TOOL_YIELD && tool !== TOOL_DONE;
}

/**
 * Events that close a user turn when walking backwards from its
 * `messages_consumed`. Everything else (status, usage, session_config, the
 * deferred `message` events themselves) is skipped: an unrecognised event
 * between a tool_result and the consumption must not detach them, because
 * detaching them is the direction that wrongly calls a message editable.
 *
 * Exported because a consumer reading events in ORDER (the UI, which sees
 * them arrive one at a time) has to recognise the same boundary in order to
 * know what the current turn contains.
 */
export function endsTurnLookingBack(type: string): boolean {
	return (
		type === "tool_call" ||
		type === "assistant_text" ||
		type === "thinking" ||
		type === "messages_consumed" ||
		type === "compact_marker" ||
		type === "compact_started" ||
		type === "fork_marker" ||
		type === "agent_start" ||
		type === "agent_end"
	);
}

/**
 * Is this user turn answering work that was already under way?
 *
 * `turn` is the events between the previous turn boundary and the
 * `messages_consumed` — everything the turn is made of except the consumption
 * record itself. A single prior-work tool_result is enough: the turn had
 * something to answer, so nothing riding along in it started anything.
 *
 * THE rule. Both ways of reaching it — a pass over a whole log, and a UI
 * watching events arrive one at a time — call this, so there is one statement
 * of it to get right. (Two implementations of "was this sent on its own"
 * would drift into a button that lies in one direction or the other, which is
 * the failure this module exists to prevent.)
 */
export function turnAnswersPriorWork(turn: readonly RunEvent[]): boolean {
	return turn.some((e) => e.type === "tool_result" && isPriorWork(e.tool));
}

/**
 * One pass over a log: for every message carrying an eid, whether it was sent
 * on its own. The single-message lookup below goes through it too.
 *
 * Scoped per task: a sibling agent's turns say nothing about this one.
 *
 * A message with no `messages_consumed` yet is absent from the result rather
 * than false: the agent has not picked it up, so the question has no answer
 * yet, and saying "it was swept into other work" would be a false statement
 * about the world.
 *
 * ⚠️ **Do not write logic for this branch.** Measured on root's session:
 * 0 of 3621 user messages were unconsumed — delivery and consumption are
 * effectively simultaneous. The UI cannot reach it either: a message becomes
 * a log entry only when it is consumed, so before that it is a pending chip
 * with no buttons to gate. The tri-state is NOT here for this case — it
 * exists for the reachable one, an eid the active chain doesn't contain at
 * all (an earlier rewind cut it away). This case just rides along for free.
 */
export function messageRunStarts(
	events: readonly RunEvent[],
): Map<string, boolean> {
	const eidOf = new Map<string, string>(); // message id → eid
	const byTask = new Map<string, number[]>();
	for (let i = 0; i < events.length; i++) {
		const e = events[i] as RunEvent;
		const key = e.taskId ?? "";
		let idx = byTask.get(key);
		if (!idx) {
			idx = [];
			byTask.set(key, idx);
		}
		idx.push(i);
		if (e.type === "message" && e.id && e.eid) eidOf.set(e.id, e.eid);
	}

	const starts = new Map<string, boolean>();
	for (const indices of byTask.values()) {
		for (let k = 0; k < indices.length; k++) {
			const consumed = events[indices[k] as number] as RunEvent;
			if (consumed.type !== "messages_consumed" || !consumed.messageIds?.length)
				continue;
			// Collect this user turn — back to the previous boundary — and ask
			// what it is answering. A park's result points the other way; see
			// isPriorWork.
			const turn: RunEvent[] = [];
			for (let j = k - 1; j >= 0; j--) {
				const p = events[indices[j] as number] as RunEvent;
				if (endsTurnLookingBack(p.type)) break;
				turn.push(p);
			}
			const answersPriorWork = turnAnswersPriorWork(turn);
			for (const id of consumed.messageIds) {
				const eid = eidOf.get(id);
				if (eid) starts.set(eid, !answersPriorWork);
			}
		}
	}
	return starts;
}

/**
 * Was the message with this eid sent on its own? `undefined` when the log
 * doesn't say — the eid names no message here, or no turn has picked it up
 * yet. That is not the same answer as "no". On the backend, "names no message
 * here" means it is not on the active chain: an earlier rewind cut it away.
 */
export function messageStartsRun(
	events: readonly RunEvent[],
	targetEid: string,
): boolean | undefined {
	return messageRunStarts(events).get(targetEid);
}
