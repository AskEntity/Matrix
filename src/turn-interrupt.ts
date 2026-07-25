/**
 * "Stop this turn, but stay alive."
 *
 * The provider loop already has an abort channel — `TaskSession.abortController`,
 * whose meaning is **this session is being torn down** (stop / reset / delete).
 * Three places in the loop read it and clean up accordingly: the API call, the
 * outer-retry backoff, and the top of the loop. An interrupt must NOT reuse it:
 * sharing one channel for two meanings gives you either "an interrupt tore the
 * session down" or "a teardown was mistaken for an interrupt so it couldn't tear
 * down", and neither shows up as a crash.
 *
 * So this is a SECOND, narrower channel:
 *
 * | channel                     | means                      | loop's reaction            |
 * |-----------------------------|----------------------------|----------------------------|
 * | `TaskSession.abortController`| the session is dying      | run finally, tear down     |
 * | `TaskSession.interrupt`      | end this turn, I'm alive  | park on the queue at idle  |
 *
 * The two meet in exactly one place: the API call's signal, which is
 * `AbortSignal.any([session abort, turn interrupt])`. After it throws, the loop
 * asks `request.signal.aborted` FIRST — teardown always wins.
 */
export class TurnInterrupt {
	#controller = new AbortController();
	#requested = false;

	/** Someone asked to stop the current turn, and no park has satisfied it yet. */
	get requested(): boolean {
		return this.#requested;
	}

	/**
	 * Aborts the CURRENT turn's API call / retry backoff only. Re-armed by
	 * `consume()`, so a turn is never born already-aborted.
	 */
	get signal(): AbortSignal {
		return this.#controller.signal;
	}

	/** Ask the loop to end the current turn and park. Idempotent. */
	request(): void {
		this.#requested = true;
		this.#controller.abort();
	}

	/**
	 * Read-and-clear, re-arming the turn signal.
	 *
	 * ⭐ Called when the loop PARKS (top of `handleImplicitYield`), not when it
	 * decides to park. The rule is "**the loop actually parking is what satisfies
	 * an interrupt**", whichever path parked it — including a park the agent
	 * reached on its own. Clearing at the decision point instead would leave the
	 * flag set whenever a stop lands in the same moment the agent goes idle by
	 * itself, and the next message would then be swallowed into a park.
	 *
	 * That leaves one window: a request landing between "woke from the queue" and
	 * "reached the top of the loop". The flag survives into the next iteration and
	 * parks again. It costs nothing — the just-consumed message is already in
	 * `messages[]`, `handleImplicitYield` returns immediately if anything else is
	 * queued, and the next message merges into the same user turn. Nothing is
	 * dropped and nothing hangs; the only effect is that one message alone does
	 * not trigger a turn. The window is microseconds wide and requires the user to
	 * press stop inside it.
	 */
	consume(): boolean {
		const was = this.#requested;
		this.#requested = false;
		if (was) this.#controller = new AbortController();
		return was;
	}
}
