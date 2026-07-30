import { randomBytes } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ChainLink, CompactionBoundary, Event } from "./events.ts";
import { walkActiveChainIndices } from "./events.ts";

/**
 * Read chunk for the streaming walk. 256KB is comfortably above the largest
 * single event measured in production (a 1.68MB `message:user` spans several
 * chunks, which the line loop handles) and small enough that the buffer is
 * never the memory story.
 */
const STREAM_CHUNK_BYTES = 256 * 1024;

import { TOOL_FORK_TASK_CONTEXT } from "./tool-names.ts";
import { ulid } from "./ulid.ts";

/** Generate a 12-char hex event ID (48-bit, collision-safe for 50K+ events per file). */
function generateEid(): string {
	return randomBytes(6).toString("hex");
}

/**
 * Build the persisted form of an event: `eid` / `parentEid` FIRST, then the
 * event's own fields. `JSON.stringify` follows insertion order, so every line
 * this store writes starts with the chain links instead of hiding them behind
 * a long `content`.
 *
 * Order is a readability property only — `JSON.parse` is order-agnostic, so
 * lines written before this change (chain fields at the tail) read back
 * identically and old files need no migration.
 *
 * Returns a NEW object; the caller's event is never mutated. Any eid /
 * parentEid ALREADY on the input is dropped before the spread — otherwise the
 * spread would restore the stale link. That case is real: `buildSessionRepair`
 * re-appends unconsumed `message` events read from the region it is about to
 * truncate, and their original parent is exactly what truncation deletes.
 */
function withChainFields(
	event: Event,
	eid: string,
	parentEid: string | null,
): Event {
	const { eid: _staleEid, parentEid: _staleParentEid, ...rest } = event;
	return { eid, parentEid, ...rest } as Event;
}

/**
 * JSONL-based event store for Event persistence.
 * Append-only: one JSON line per event. File path: `{dir}/{sessionId}.jsonl`
 *
 * append/appendBatch are FULLY SYNCHRONOUS: they stamp the event's place in
 * the chain and write it in one uninterruptible step, and return the persisted
 * form so the caller can hand the same object to anyone else (`emitEvent`
 * broadcasts exactly what went to disk, eid included).
 *
 * That is what lets the chain have ONE writer. It used to stamp inside a write
 * queue, one microtask later, which meant anything wanting the eid earlier had
 * to stamp it too — and two writers of `lastEventIds` is a TOCTOU that breaks
 * the chain under bursts (measured; see 01KY54YT round 11).
 *
 * Fully synchronous rather than "stamp now, write later" because of the write
 * FAILURE path. `rewindChainHead` restores the head so a failed event is not
 * left in the chain, and that is only correct while nothing can be stamped
 * between the stamp and the write. Defer the write and a burst in one tick
 * gets stamped first: the event after a failed one then names a parent no line
 * carries, the walk stops dead there (there is no dangling-link fallback, by
 * design), and the agent resumes with a silently truncated context. Synchronous
 * keeps the cost of a failed write at "one event lost", never "history lost".
 *
 * Read operations remain synchronous for simplicity (only called during resume).
 */
export class EventStore {
	/** Per-session write queue to serialize async appends and prevent interleaving */
	private writeQueues = new Map<string, Promise<void>>();
	/**
	 * Per-session generation counter. Incremented on clear().
	 * Writes capture the generation at enqueue time; if it changes before
	 * the write executes (because clear() was called), the write is dropped.
	 * This prevents async writes from re-creating a deleted JSONL file.
	 */
	private sessionGenerations = new Map<string, number>();
	/**
	 * Per-session last event ID. Tracks the eid of the most recently persisted
	 * event so that the NEXT event's parentEid can point to it. null = next
	 * event is the first in the session (parentEid = null). undefined (absent
	 * from map) = unknown, will be populated on next read or append.
	 */
	private lastEventIds = new Map<string, string | null>();

	constructor(private dir: string) {
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	}

	private path(sessionId: string): string {
		return join(this.dir, `${sessionId}.jsonl`);
	}

	/** Get the current generation for a session. */
	private getGeneration(sessionId: string): number {
		return this.sessionGenerations.get(sessionId) ?? 0;
	}

	/**
	 * Serialize a write operation for a given session, with a two-layer
	 * generation guard defending against `clear()` racing the write:
	 *
	 *   Layer 1 — pre-check: before calling writeFn, verify clear() has
	 *   not run since this write was enqueued. If the generation was bumped,
	 *   silently drop the write.
	 *
	 *   Layer 2 — post-check: after writeFn returns, verify clear() did not
	 *   run DURING writeFn's work. If it did, the writeFn may have created a
	 *   zombie file (appendFile with O_CREAT recreates a just-unlinked file,
	 *   which caused the 2026-04-18 flake). Remove the zombie.
	 *
	 * ⚠️ **This guard has no reachable failure path today.** `append` and
	 * `appendBatch` no longer come through here at all — they are synchronous,
	 * so `clear()` cannot interleave with them by construction, and there is
	 * no deferred write left for a generation bump to catch. The one caller
	 * is `copySessionFrom`, whose write IS genuinely async — and fork is
	 * structurally exclusive with reset at the task level, so even that one
	 * cannot race a clear in practice.
	 *
	 * It stays for two reasons, both about the future rather than the present:
	 * any async writeFn added later gets the protection without having to
	 * rediscover why it is needed, and the two regression tests below record a
	 * real bug that cost real time to diagnose. **Do not read "there is a
	 * queue" as "there is protection" for the append path — there is nothing
	 * left there to protect.** (Deciding whether this should exist at all, once
	 * synchronous appends have run in production for a while: draft task
	 * 01KYCQDJRF8Z8S6YC39F7ECVZ8.)
	 *
	 * Historical context: the original implementation used `fs.promises.
	 * appendFile` (async libuv) and had only Layer 1. Under CPU contention
	 * the libuv thread pool would delay the `open(O_CREAT)` syscall, letting
	 * clear() sneak in between pre-check and open, after which the open
	 * recreated the file. Sync I/O closed that window; synchronous appends
	 * then removed the window's last inhabitant.
	 */
	private enqueueWrite(
		sessionId: string,
		writeFn: () => Promise<void>,
	): Promise<void> {
		const generation = this.getGeneration(sessionId);
		const guardedFn = async () => {
			// Layer 1 (pre-check): clear ran between enqueue and execution.
			if (this.getGeneration(sessionId) !== generation) return;
			await writeFn();
			// Layer 2 (post-check): clear ran DURING writeFn's work. Any file
			// writeFn created is a zombie — remove it.
			if (this.getGeneration(sessionId) !== generation) {
				try {
					unlinkSync(this.path(sessionId));
				} catch {
					/* already gone — treat as success */
				}
			}
		};
		const prev = this.writeQueues.get(sessionId) ?? Promise.resolve();
		const next = prev.then(guardedFn, guardedFn); // run even if previous failed
		this.writeQueues.set(sessionId, next);
		// Clean up completed queues to prevent memory leak
		next.then(() => {
			if (this.writeQueues.get(sessionId) === next) {
				this.writeQueues.delete(sessionId);
			}
		});
		return next;
	}

	/**
	 * Stamp an event with eid + parentEid before persistence and advance the
	 * session's chain head.
	 *
	 * Returns the persisted form (a new object with the chain fields first —
	 * see `withChainFields`); the caller's event is left untouched. Nothing
	 * reads eid off an event it handed to `append` — `emitEvent` broadcasts to
	 * SSE before persisting, and every consumer of eid reads events back from
	 * disk.
	 */
	private stampEvent(sessionId: string, event: Event): Event {
		const eid = generateEid();
		const parentEid = this.lastEventIds.get(sessionId) ?? null;
		this.lastEventIds.set(sessionId, eid);
		return withChainFields(event, eid, parentEid);
	}

	/**
	 * Append a single event to the JSONL file. Synchronous; returns the
	 * persisted form — the same object shape the file now holds, chain fields
	 * included. Callers that want to show the event to anyone else should pass
	 * on THIS object, not the one they built.
	 *
	 * Blocking the main thread for one small write costs tens of microseconds,
	 * which is nothing next to provider streaming latency — and it was already
	 * being paid, just one microtask later.
	 */
	append(sessionId: string, event: Event): Event {
		const headBeforeWrite = this.lastEventIds.get(sessionId) ?? null;
		const stamped = this.stampEvent(sessionId, event);
		try {
			appendFileSync(this.path(sessionId), `${JSON.stringify(stamped)}\n`);
		} catch (e) {
			// The event never reached disk, so the chain must not point at it:
			// the next event's parentEid would name an eid no line carries, and
			// the walk (which has no dangling-link fallback, by design) would
			// stop dead there and strand the whole session. Non-fatal for the
			// caller either way.
			this.rewindChainHead(sessionId, headBeforeWrite, e);
		}
		return stamped;
	}

	/** Append multiple events in one write. Synchronous, like `append`. */
	appendBatch(sessionId: string, events: Event[]): Event[] {
		if (events.length === 0) return [];
		const headBeforeWrite = this.lastEventIds.get(sessionId) ?? null;
		const stamped = events.map((e) => this.stampEvent(sessionId, e));
		const lines = `${stamped.map((e) => JSON.stringify(e)).join("\n")}\n`;
		try {
			appendFileSync(this.path(sessionId), lines);
		} catch (e) {
			this.rewindChainHead(sessionId, headBeforeWrite, e);
		}
		return stamped;
	}

	/** Undo a stamp whose write failed — see the call sites in append/appendBatch. */
	private rewindChainHead(
		sessionId: string,
		head: string | null,
		cause: unknown,
	): void {
		this.lastEventIds.set(sessionId, head);
		console.warn(
			`[EventStore] Failed to append events for session ${sessionId}:`,
			cause,
		);
	}

	/**
	 * Set the chain head for a session so the NEXT appended event's parentEid
	 * points to `eid` instead of the most recently written event. This is
	 * the rollback mechanism: setChainHead(targetEid) → deliverMessage writes
	 * the new user message whose parentEid = targetEid → chain-walk skips
	 * everything between target and the new message.
	 *
	 * Pure in-memory operation — no disk I/O. The parentEid jump is persisted
	 * naturally when the next event is appended via stampEvent.
	 */
	setChainHead(sessionId: string, eid: string): void {
		this.lastEventIds.set(sessionId, eid);
	}

	/**
	 * THE file walk: one session's JSONL, one event at a time, in file order.
	 * Malformed and blank lines are skipped, with the same warning `read` has
	 * always emitted and the same line numbering.
	 *
	 * ⚠️ Two properties this has that {@link read} does not, and both are the
	 * reason it exists rather than being a tidier spelling of the same thing:
	 *
	 * 1. **It never materialises the log.** MEASURED on root's 115MB session
	 *    (71,506 events): `read()` costs **+592MB RSS / 222MB live heap**,
	 *    because the file text, the split array and every parsed event are all
	 *    resident at once. Streaming holds one line at a time — 18MB live. The
	 *    worker doing this is the one running live agents, so that difference
	 *    is the difference between a feature and an outage.
	 *
	 * 2. **It does NOT migrate.** `read()` rewrites the whole file when the
	 *    first event lacks an `eid` — MEASURED on a copy of a real session:
	 *    154,958 bytes in, 158,980 bytes out, first event stamped. Nothing in
	 *    that method's name says so. A reader that only wants to LOOK must not
	 *    rewrite what it looks at, and the files this matters for are the
	 *    oldest ones (3296 unstamped events, newest 2026-04-16) — exactly the
	 *    population a search of old history is reaching for. Callers that want
	 *    migration keep calling `read()`.
	 *
	 * Synchronous on purpose: `read` is sync and is called from sync paths all
	 * over the runtime, so making the shared walk async would ripple outward
	 * for no gain. Chunked `readSync` + `StringDecoder` gives bounded memory
	 * without that — the decoder is what keeps a multi-byte character split
	 * across a chunk boundary from being corrupted.
	 */
	streamEvents(sessionId: string, onEvent: (event: Event) => void): number {
		const p = this.path(sessionId);
		if (!existsSync(p)) return 0;
		let malformed = 0;
		const fd = openSync(p, "r");
		try {
			const buf = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
			const decoder = new StringDecoder("utf8");
			let pending = "";
			// Counts EVERY line including blanks, so the malformed-line warning
			// names the same line number the whole-file read used to.
			let lineNo = 0;
			const take = (line: string): void => {
				const n = lineNo++;
				if (!line) return;
				try {
					onEvent(JSON.parse(line) as Event);
				} catch {
					malformed++;
					console.warn(
						`[EventStore] Skipping malformed JSONL line ${n} in session ${sessionId}`,
					);
				}
			};
			// Scan with an INDEX rather than re-slicing `pending` per line. The
			// re-slicing form is the one you write first and it is quadratic in
			// lines-per-chunk on paper — ~2500 lines in a 256KB chunk, each
			// copying the remainder. It does not show up in timings here because
			// JSC shares substring storage, which is a property of the engine
			// rather than of the code; this version does not depend on it.
			let bytes = readSync(fd, buf, 0, STREAM_CHUNK_BYTES, null);
			while (bytes > 0) {
				pending += decoder.write(buf.subarray(0, bytes));
				let from = 0;
				let nl = pending.indexOf("\n", from);
				while (nl !== -1) {
					take(pending.slice(from, nl));
					from = nl + 1;
					nl = pending.indexOf("\n", from);
				}
				pending = from > 0 ? pending.slice(from) : pending;
				bytes = readSync(fd, buf, 0, STREAM_CHUNK_BYTES, null);
			}
			pending += decoder.end();
			take(pending);
		} finally {
			closeSync(fd);
		}
		return malformed;
	}

	/**
	 * Stream the events the chain still reaches, without materialising the log.
	 *
	 * Same boundary question as {@link readActive} and the same one walk — this
	 * is its streaming form, for the caller that cannot afford the array.
	 *
	 * Two passes, deliberately. Pass 1 keeps only `(eid, parentEid, type)` per
	 * event — MEASURED at **13MB of live heap** for root's 71,506 events,
	 * against 222MB for the parsed events — which is what makes the backward
	 * walk affordable at all. Pass 2 re-streams and emits the kept indices, so
	 * every consumer downstream sees an ordinary event stream and none of this
	 * logic leaks into it. One pass is possible by index-tagging everything the
	 * consumer accumulates and filtering afterwards; that pushes the boundary
	 * question into the consumer, which is what having one walk is for.
	 *
	 * ⚠️ The log may grow between the passes (append-only, so never shrink).
	 * Events appended after pass 1 fall outside the computed index set and are
	 * skipped — the answer is a consistent snapshot of the file as pass 1 saw
	 * it, rather than a torn mix of two.
	 */
	streamActive(
		sessionId: string,
		onEvent: (event: Event) => void,
		boundary: CompactionBoundary = "stop",
	): number {
		const links: ChainLink[] = [];
		const malformed = this.streamEvents(sessionId, (e) => {
			links.push({ eid: e.eid, parentEid: e.parentEid, type: e.type });
		});
		if (links.length === 0) return malformed;
		const keep = new Set(walkActiveChainIndices(links, boundary));
		let i = 0;
		this.streamEvents(sessionId, (e) => {
			if (keep.has(i++)) onEvent(e);
		});
		return malformed;
	}

	/**
	 * Read all events for a session. Malformed and blank lines are skipped.
	 *
	 * ⚠️ This MIGRATES: a file whose first event lacks an `eid` is rewritten in
	 * place. That is deliberate and long-standing, but it means `read` is not a
	 * read — see {@link streamEvents} for the one that only looks.
	 *
	 * Physical line numbers are deliberately NOT surfaced: nothing operates on
	 * file positions any more. Repair and rollback both address events by eid,
	 * so the event-index-vs-file-line translation that once produced silent
	 * data loss (FIX-8 R8-B#4) has no place left to happen.
	 */
	read(sessionId: string): Event[] {
		const events: Event[] = [];
		this.streamEvents(sessionId, (e) => {
			events.push(e);
		});
		if (events.length === 0) return events;

		// Auto-migrate: if events exist but first one lacks eid, assign eids
		// to the whole file and rewrite atomically (temp + rename).
		const firstEvent = events[0];
		if (firstEvent && !firstEvent.eid) {
			this.migrateEventIds(sessionId, this.path(sessionId), events);
		}

		// Sync lastEventIds so subsequent appends chain correctly.
		const lastEvent = events[events.length - 1];
		if (lastEvent) {
			this.lastEventIds.set(sessionId, lastEvent.eid ?? null);
		}

		return events;
	}

	/**
	 * Auto-migrate a JSONL file that lacks eid/parentEid. Assigns a fresh
	 * linear chain of eids and rewrites the file atomically (temp + rename).
	 * Called once per file on first read; idempotent (skipped when first
	 * event already has eid).
	 *
	 * Rewrites `events` in place (the caller returns that array), so the
	 * stamped copies — not the eid-less originals — reach the reader.
	 */
	private migrateEventIds(
		sessionId: string,
		filePath: string,
		events: Event[],
	): void {
		let prevEid: string | null = null;
		for (let i = 0; i < events.length; i++) {
			const eid = generateEid();
			events[i] = withChainFields(events[i] as Event, eid, prevEid);
			prevEid = eid;
		}
		// Atomic rewrite: temp file + rename (same pattern as tracker.save()).
		const tmpPath = join(
			this.dir,
			`.${sessionId}.jsonl.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`,
		);
		const content = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
		writeFileSync(tmpPath, content);
		renameSync(tmpPath, filePath);
	}

	/**
	 * Read the events the chain still reaches.
	 *
	 * Walks the parentEid chain from the last event backward, so a rolled-back
	 * branch is never visited. `boundary` decides the SECOND question — whether
	 * the walk also stops at the last completed compaction:
	 *
	 * - `"stop"` (default) is what provider reconstruction and the UI want:
	 *   the conversation as it currently stands.
	 * - `"past"` keeps going, for a caller that wants the history a summary
	 *   was written to replace.
	 *
	 * ⚠️ There used to be a `readFromLastCompactMarker` beside this, applying a
	 * SECOND truncation from the `compact_marker` onward, and deleting it is
	 * the point of the parameter rather than a tidy-up. The chain walk ends at
	 * `compact_started`; the marker is later; between them lie the messages
	 * delivered while the summarizer was running — which `walkActiveChainIndices`
	 * splices in DELIBERATELY, because reconstruction loses them otherwise.
	 * MEASURED across this project's sessions: **38 completed compactions, 15
	 * with at least one message in the window, 27 messages**, overwhelmingly
	 * `user` and `user_message_forwarded` (e.g. *"我发现了，orchestrator根本
	 * compact不了，这怎么办"*). **The second truncation was excluding exactly
	 * what the first one exists to preserve.**
	 *
	 * That function also treated `fork_marker` as a start point, so a forked
	 * session's UI hid the inherited parent history while the model could see
	 * it. That disagreement goes with it.
	 */
	readActive(
		sessionId: string,
		boundary: CompactionBoundary = "stop",
	): Event[] {
		const all = this.read(sessionId);
		return walkActiveChainIndices(all, boundary).map((i) => all[i] as Event);
	}

	/**
	 * How many events the file holds — the population {@link readActive} is a
	 * subset of.
	 *
	 * Exists so a caller can answer "is there history this view excludes?"
	 * without a second copy of the chain walk. That question used to be
	 * answered by `readFromLastCompactMarker`'s `hasOlderEvents`, computed off
	 * a barrier that no longer exists; comparing the two counts is the same
	 * answer with nothing to keep in sync.
	 *
	 * Streams, so it costs no memory beyond one line.
	 */
	countEvents(sessionId: string): number {
		let n = 0;
		this.streamEvents(sessionId, () => {
			n++;
		});
		return n;
	}

	/**
	 * Read events before a given timestamp, up to a limit (for "load older" pagination).
	 * Returns events in chronological order (oldest first).
	 */
	readBefore(
		sessionId: string,
		beforeTs: number,
		limit: number,
	): { events: Event[]; hasMore: boolean } {
		const all = this.read(sessionId);
		// Find events strictly before the timestamp
		const beforeEvents = all.filter((e) => e.ts < beforeTs);
		if (beforeEvents.length <= limit) {
			return { events: beforeEvents, hasMore: false };
		}
		// Return the last `limit` events (most recent ones before the timestamp)
		return {
			events: beforeEvents.slice(-limit),
			hasMore: true,
		};
	}

	/** Flush pending writes for a specific session */
	async flushSession(sessionId: string): Promise<void> {
		const pending = this.writeQueues.get(sessionId);
		if (pending) await pending;
	}

	/**
	 * Copy events from a source session to a target session, then append a fork_marker.
	 * Copies the source's ACTIVE context — `readActive`, the same boundary the
	 * source agent's own conversation is built from. Fork means "wake up with
	 * the source's current context", so it must not compute its own answer to
	 * "which events count": doing that used to leak rolled-back events into the
	 * child (a plain slice ignores parentEid jumps entirely) and drop the
	 * messages stranded in the source's last compaction window.
	 *
	 * Target must NOT already have a session file — call has() first to check.
	 *
	 * Like unix fork(): the child "wakes up" from a fork_task_context call.
	 *
	 * - Case 1 (source is the calling agent — fork's own tool_call is in the events):
	 *   Write a child-side tool_result for the existing fork tool_call.
	 *
	 * - Case 2 (source is a different/closed agent — no fork tool_call):
	 *   Inject a synthetic tool_call + tool_result pair so the child always sees
	 *   "fork_task_context completed. You are the CHILD."
	 *
	 * Any OTHER orphaned tool_calls (non-fork tools without results) also get
	 * synthetic tool_results so the message structure is clean.
	 *
	 * Returns the number of source events copied (excluding synthetics and fork_marker).
	 */
	async copySessionFrom(
		sourceId: string,
		targetId: string,
		opts?: { targetTitle?: string; targetDescription?: string },
	): Promise<{ eventCount: number }> {
		const sourcePath = this.path(sourceId);
		const targetPath = this.path(targetId);

		if (!existsSync(sourcePath)) {
			throw new Error(`Source session "${sourceId}" has no events`);
		}
		if (existsSync(targetPath)) {
			throw new Error(
				`Target session "${targetId}" already has session data. Use reset_task first to clear it.`,
			);
		}

		// Flush pending writes so we get all events including the current turn's tool_calls
		await this.flushSession(sourceId);

		// The child inherits the source's CONTENT, not its file structure. A
		// compaction boundary describes where the SOURCE's log was cut, and only
		// half of one can even be copied: `compact_started` sits outside the
		// active region by definition. A lone `compact_marker` in the child
		// would read as an unpaired marker — the legacy shape — so the child's
		// own walk would discard exactly the window messages we just went to the
		// trouble of inheriting, with no `compact_started` left anywhere in its
		// file to ever recover them. That is the one genuinely irreversible
		// version of this bug, which is why the boundary events are dropped and
		// the inherited context becomes one flat run.
		const activeEvents = this.readActive(sourceId).filter(
			(e) => e.type !== "compact_marker" && e.type !== "compact_started",
		);

		// Detect orphaned tool_calls (tool_call without matching tool_result)
		const toolCallIds = new Map<string, string>(); // id → tool name
		const toolResultIds = new Set<string>();
		for (const e of activeEvents) {
			if (e.type === "tool_call") toolCallIds.set(e.toolCallId, e.tool);
			else if (e.type === "tool_result") toolResultIds.add(e.toolCallId);
		}

		const titleInfo = opts?.targetTitle
			? `\nYour task: "${opts.targetTitle}"`
			: "";
		const descInfo = opts?.targetDescription
			? `\nTask description: ${opts.targetDescription}`
			: "";
		const childForkResult =
			`fork_task_context completed. You are the CHILD (forked from ${sourceId}).` +
			`${titleInfo}${descInfo}\n` +
			`The conversation above is background knowledge from your previous assignment. ` +
			`Read your new task description and start working.`;

		// Check if fork's own tool_call is among the orphans
		let hasForkToolCall = false;
		const syntheticEvents: Event[] = [];
		const now = Date.now();

		for (const [id, tool] of toolCallIds) {
			if (toolResultIds.has(id)) continue;

			if (tool === TOOL_FORK_TASK_CONTEXT) {
				// Case 1: fork's own tool_call is in the events — write child-side result
				hasForkToolCall = true;
				syntheticEvents.push({
					type: "tool_result" as const,
					tool,
					toolCallId: id,
					content: childForkResult,
					isError: false,
					taskId: targetId,
					ts: now,
				});
			} else {
				// Other orphaned tool — parent executed it, result not available to child
				syntheticEvents.push({
					type: "tool_result" as const,
					tool,
					toolCallId: id,
					content:
						"This tool was executed by the source agent. Results are not available in this forked context.",
					isError: false,
					taskId: targetId,
					ts: now,
				});
			}
		}

		// Case 2: no fork tool_call in events — inject synthetic call + result
		if (!hasForkToolCall) {
			const syntheticCallId = `toolu_fork_${ulid()}`;
			syntheticEvents.push({
				type: "tool_call" as const,
				tool: TOOL_FORK_TASK_CONTEXT,
				toolCallId: syntheticCallId,
				input: { sourceTaskId: sourceId, targetTaskId: targetId },
				taskId: targetId,
				ts: now,
			});
			syntheticEvents.push({
				type: "tool_result" as const,
				tool: TOOL_FORK_TASK_CONTEXT,
				toolCallId: syntheticCallId,
				content: childForkResult,
				isError: false,
				taskId: targetId,
				ts: now,
			});
		}

		// Write: active events → synthetic events → fork_marker.
		//
		// The copied events keep their SOURCE eids (identity survives the fork)
		// but are RE-LINKED into one contiguous chain: the active context is a
		// filtered subset of the source log, so their original parents (the
		// source's compact_started, a rolled-back branch, the event before the
		// window) are not in this file. Leaving those links would strand
		// everything before the first hole.
		let prevEid: string | null = null;
		const chainedActive = activeEvents.map((e) => {
			const eid = e.eid ?? generateEid();
			const linked = withChainFields(e, eid, prevEid);
			prevEid = eid;
			return linked;
		});

		const stampedSynthetics = syntheticEvents.map((e) => {
			const eid = generateEid();
			const stamped = withChainFields(e, eid, prevEid);
			prevEid = eid;
			return stamped;
		});

		const forkEid = generateEid();
		const forkMarker = withChainFields(
			{
				type: "fork_marker",
				sourceTaskId: sourceId,
				...(opts?.targetTitle && { targetTitle: opts.targetTitle }),
				...(opts?.targetDescription && {
					targetDescription: opts.targetDescription,
				}),
				taskId: targetId,
				ts: Date.now(),
			} as Event,
			forkEid,
			prevEid,
		);

		const allLines: string[] = [];
		for (const e of chainedActive) {
			allLines.push(JSON.stringify(e));
		}
		for (const e of stampedSynthetics) {
			allLines.push(JSON.stringify(e));
		}
		allLines.push(JSON.stringify(forkMarker));

		// The one genuinely async write left in this class, and therefore the
		// only remaining user of the write queue's generation guard.
		await this.enqueueWrite(targetId, () =>
			appendFile(targetPath, `${allLines.join("\n")}\n`),
		);

		// Set lastEventId for the target session so subsequent appends chain.
		this.lastEventIds.set(targetId, forkEid);

		return { eventCount: activeEvents.length };
	}

	/**
	 * Clear all events for a session.
	 * Increments the session generation so any pending async writes (enqueued
	 * before this call) are silently dropped — they won't re-create the file.
	 */
	clear(sessionId: string): void {
		// Bump generation: all writes enqueued before this point see a stale
		// generation and become no-ops when they eventually execute.
		this.sessionGenerations.set(sessionId, this.getGeneration(sessionId) + 1);
		this.lastEventIds.delete(sessionId);
		const p = this.path(sessionId);
		if (existsSync(p)) unlinkSync(p);
	}

	/** Check if events exist */
	has(sessionId: string): boolean {
		return existsSync(this.path(sessionId));
	}

	/** Wait for all pending writes across all sessions to complete */
	async flush(): Promise<void> {
		const pending = Array.from(this.writeQueues.values());
		if (pending.length > 0) {
			await Promise.all(pending);
		}
	}

	/** List all session IDs that have event files */
	listSessions(): string[] {
		try {
			return readdirSync(this.dir)
				.filter((f) => f.endsWith(".jsonl"))
				.map((f) => f.replace(/\.jsonl$/, ""));
		} catch {
			return [];
		}
	}

	/** Read all events across all sessions, sorted by timestamp */
	readAllSorted(): Event[] {
		const sessions = this.listSessions();
		const all: Event[] = [];
		for (const sessionId of sessions) {
			all.push(...this.read(sessionId));
		}
		all.sort((a, b) => a.ts - b.ts);
		return all;
	}
}
