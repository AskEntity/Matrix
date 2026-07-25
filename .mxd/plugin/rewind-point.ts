/**
 * Is there a point in the conversation to rewind this message to?
 *
 * Rewinding cuts the chain at the target's parent, and that is only defined
 * where the active conversation IS the parentEid chain. Compaction breaks
 * that: messages delivered while the summarizer was running are SPLICED into
 * the active chain by the walk (see walkActiveChainIndices), not reached
 * through it. Their parent links still point into the region the summary
 * replaced.
 *
 * Cutting there un-compacts the session. Measured, not reasoned: rewinding to
 * a message from a compaction window puts the entire summarized-away history
 * back on the active chain and drops the summary and the marker onto the
 * abandoned branch — because the walk, restarted from inside the window,
 * never meets the `compact_marker` that would have opened the window, so it
 * walks all the way back to the first line of the file. On a large session
 * that is the whole history returning at once and the summary gone for good.
 *
 * So the question is not "is this message in the conversation" — a spliced
 * message is — but "does it have somewhere to go back to". Everything from
 * the last completed compaction onward does. Anything the compaction carried
 * across does not: the state before it no longer exists.
 *
 * ⚠️ Feed this the ACTIVE chain (`readActive`), not the file. This used to be
 * an index comparison against the raw log, which happened to give the right
 * answer for the wrong reason — it encoded where the boundary sat at the time
 * rather than what the boundary is, and silently stopped matching when the
 * boundary rule changed under it.
 */

/** The minimal shape needed: an event's kind and its chain id. */
export type ChainEvent = {
	type: string;
	eid?: string;
};

/**
 * True when the conversation still holds a state this message could return
 * to. False for a message the last compaction carried across, and for an eid
 * the active chain doesn't contain at all (nothing to rewind either way).
 */
export function hasRewindPoint(
	activeEvents: readonly ChainEvent[],
	targetEid: string,
): boolean {
	const target = activeEvents.findIndex((e) => e.eid === targetEid);
	if (target < 0) return false;
	const lastCompaction = activeEvents.findLastIndex(
		(e) => e.type === "compact_marker",
	);
	// No compaction in this conversation: the chain is plain all the way
	// back, so every position is a valid cut.
	if (lastCompaction < 0) return true;
	return target > lastCompaction;
}
