import { randomBytes } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { Event } from "./events.ts";
import { walkActiveChainIndices } from "./events.ts";
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
 * append/appendBatch are serialized per session via a Promise queue and return
 * a Promise for test callers that want to `await` visibility — but the
 * underlying disk I/O is synchronous (`appendFileSync`). Sync I/O is load-
 * bearing for the generation guard: the guard check and the filesystem write
 * happen in the SAME microtask, so clear() cannot interleave between them.
 * See the race notes in `enqueueWrite` below.
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
	 * Why two layers. In production, writeFn is synchronous (`appendFileSync`
	 * inside `append`/`appendBatch`), so there is no window for clear() to
	 * interleave between pre-check and post-check — Layer 2 is strictly
	 * decorative in the fast path. Layer 2 exists so that ANY future caller
	 * (or test) passing an async writeFn cannot resurrect the race silently.
	 *
	 * Historical context: the previous implementation used `fs.promises.
	 * appendFile` (async libuv) and had only Layer 1. Under CPU contention
	 * the libuv thread pool would delay the `open(O_CREAT)` syscall, letting
	 * clear() sneak in between pre-check and open, after which the open
	 * recreated the file. Switching to `appendFileSync` closes that window.
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
	 * Append a single event to the JSONL file.
	 *
	 * Uses `appendFileSync` intentionally: the filesystem write must complete
	 * in the same microtask as the generation guard check (see `enqueueWrite`).
	 * Writes are small (one JSON line), blocking the main thread for tens of
	 * microseconds, which is negligible next to provider streaming latency.
	 */
	append(sessionId: string, event: Event): Promise<void> {
		return this.enqueueWrite(sessionId, () => {
			const stamped = this.stampEvent(sessionId, event);
			try {
				appendFileSync(this.path(sessionId), `${JSON.stringify(stamped)}\n`);
			} catch {
				/* non-fatal — don't break caller if write fails */
			}
			return Promise.resolve();
		});
	}

	/** Append multiple events in one write. Sync I/O for the same reason as `append`. */
	appendBatch(sessionId: string, events: Event[]): Promise<void> {
		if (events.length === 0) return Promise.resolve();
		return this.enqueueWrite(sessionId, () => {
			const stamped = events.map((e) => this.stampEvent(sessionId, e));
			const lines = `${stamped.map((e) => JSON.stringify(e)).join("\n")}\n`;
			try {
				appendFileSync(this.path(sessionId), lines);
			} catch (e) {
				console.warn(
					`[EventStore] Failed to append events for session ${sessionId}:`,
					e,
				);
			}
			return Promise.resolve();
		});
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

	/** Read all events for a session */
	read(sessionId: string): Event[] {
		return this.readWithLineMap(sessionId).events;
	}

	/**
	 * Read all events for a session, returning both parsed events AND their
	 * physical 0-based line numbers in the JSONL file. Malformed and blank
	 * lines are skipped but their physical positions are consumed — so
	 * `physicalLines[i]` gives the exact file line of `events[i]`.
	 *
	 * Use this when the physical line number matters (e.g., before calling
	 * `truncateAfterLine`, which operates on raw file lines).
	 */
	readWithLineMap(sessionId: string): {
		events: Event[];
		physicalLines: number[];
	} {
		const p = this.path(sessionId);
		if (!existsSync(p)) return { events: [], physicalLines: [] };
		const text = readFileSync(p, "utf-8");
		const events: Event[] = [];
		const physicalLines: number[] = [];
		const rawLines = text.split("\n");
		for (let i = 0; i < rawLines.length; i++) {
			const line = rawLines[i];
			if (!line) continue;
			try {
				events.push(JSON.parse(line) as Event);
				physicalLines.push(i);
			} catch {
				console.warn(
					`[EventStore] Skipping malformed JSONL line ${i} in session ${sessionId}`,
				);
			}
		}

		// Auto-migrate: if events exist but first one lacks eid, assign eids
		// to the whole file and rewrite atomically (temp + rename).
		const firstEvent = events[0];
		if (firstEvent && !firstEvent.eid) {
			this.migrateEventIds(sessionId, p, events);
		}

		// Sync lastEventIds so subsequent appends chain correctly.
		const lastEvent = events[events.length - 1];
		if (lastEvent) {
			this.lastEventIds.set(sessionId, lastEvent.eid ?? null);
		}

		return { events, physicalLines };
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
	 * Read active events for provider message reconstruction.
	 *
	 * Walks the parentEid chain from the last event backward, collecting only
	 * events reachable via the chain. Stops at compact_marker (excluded).
	 *
	 * Without rollback: every event chains linearly → same result as the old
	 * `findLastIndex(compact_marker) + slice()`.
	 *
	 * With rollback (setChainHead): the new event's parentEid jumps back to
	 * the target event, so rolled-back events are never visited.
	 */
	readActive(sessionId: string): Event[] {
		const all = this.read(sessionId);
		const activeIndices = walkActiveChainIndices(all, false);
		return activeIndices.map((i) => all[i] as Event);
	}

	/**
	 * Read active events with their physical line numbers (for repair).
	 * Same chain-walk as readActive, but also returns the physical JSONL
	 * line of each event so callers can translate event-array indices to
	 * file positions for truncateAfterLine.
	 */
	readActiveWithLineMap(sessionId: string): {
		events: Event[];
		physicalLines: number[];
	} {
		const { events: all, physicalLines: allPhysical } =
			this.readWithLineMap(sessionId);
		const activeIndices = walkActiveChainIndices(all, false);
		return {
			events: activeIndices.map((i) => all[i] as Event),
			physicalLines: activeIndices.map((i) => allPhysical[i] as number),
		};
	}

	/**
	 * Read events from the last compact_marker onward (for UI activity log).
	 * Returns the compact_marker itself plus all events after it.
	 * Also indicates whether there are older events before the marker.
	 *
	 * Uses chain-walk so rolled-back events are excluded. The barrier
	 * (compact_marker or fork_marker, whichever comes last in the active chain)
	 * is included in the result.
	 *
	 * For forked sessions, pre-fork events (copies of the parent's history) are
	 * excluded: fork_marker acts as a barrier just like compact_marker.
	 */
	readFromLastCompactMarker(sessionId: string): {
		events: Event[];
		hasOlderEvents: boolean;
	} {
		const all = this.read(sessionId);
		// Chain-walk including compact_marker (the barrier itself is part of the UI log)
		const activeIndices = walkActiveChainIndices(all, true);
		const activeEvents = activeIndices.map((i) => all[i] as Event);

		// Find the barrier in the active chain
		const lastCompact = activeEvents.findLastIndex(
			(e) => e.type === "compact_marker",
		);
		const lastFork = activeEvents.findLastIndex(
			(e) => e.type === "fork_marker",
		);
		const barrier = Math.max(lastCompact, lastFork);
		if (barrier === -1) {
			// No barrier — return all active events
			// hasOlderEvents = true when some events were excluded by chain-walk
			return {
				events: activeEvents,
				hasOlderEvents: activeEvents.length < all.length,
			};
		}
		// hasOlderEvents = true only if the barrier is NOT the first event
		// in the active chain (i.e., there are chain-walked events before it)
		// OR if the chain-walk excluded some events from the full log
		return {
			events: activeEvents.slice(barrier),
			hasOlderEvents: barrier > 0 || activeIndices[0] !== 0,
		};
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
	 * Truncate a session's JSONL file, keeping only lines 0..lineIndex (inclusive).
	 * Everything after lineIndex is removed.
	 *
	 * Serialized through the per-session write queue: any pending writes complete
	 * before truncation, and any writes enqueued after truncation wait for it.
	 * The generation guard also applies — if clear() runs while truncation is
	 * queued, the truncation is silently dropped (correct: nothing to truncate).
	 */
	truncateAfterLine(sessionId: string, lineIndex: number): Promise<void> {
		return this.enqueueWrite(sessionId, () => {
			const p = this.path(sessionId);
			if (!existsSync(p)) return Promise.resolve();

			const text = readFileSync(p, "utf-8");
			const lines = text.split("\n");
			// Remove trailing empty line from split
			if (lines.length > 0 && lines[lines.length - 1] === "") {
				lines.pop();
			}

			if (lineIndex >= lines.length - 1) return Promise.resolve(); // nothing to truncate

			const kept = lines.slice(0, lineIndex + 1);
			writeFileSync(p, `${kept.join("\n")}\n`);

			// Update lastEventIds from the last kept line so subsequent
			// appends chain correctly after truncation.
			const lastLine = kept[kept.length - 1];
			if (lastLine) {
				try {
					const parsed = JSON.parse(lastLine) as Event;
					this.lastEventIds.set(sessionId, parsed.eid ?? null);
				} catch {
					// Malformed last line — invalidate; next read will re-sync.
					this.lastEventIds.delete(sessionId);
				}
			} else {
				this.lastEventIds.delete(sessionId);
			}
			return Promise.resolve();
		});
	}

	/**
	 * Copy events from a source session to a target session, then append a fork_marker.
	 * Only copies events after the last compact_marker (active context) from the source.
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

		// Read source events, find last compact_marker to only copy active context
		const allEvents = this.read(sourceId);
		const lastMarker = allEvents.findLastIndex(
			(e) => e.type === "compact_marker",
		);
		const activeEvents =
			lastMarker === -1 ? allEvents : allEvents.slice(lastMarker + 1);

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

		// Write: active events → synthetic events → fork_marker
		// Active events already have eids from the source session (via read
		// → migration). Stamp synthetic events + fork_marker with fresh eids
		// chaining from the last active event.
		const lastActive = activeEvents[activeEvents.length - 1];
		let prevEid: string | null = lastActive?.eid ?? null;

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
		for (const e of activeEvents) {
			// Copied verbatim — the fork preserves source identity. Rebuilt only
			// to put the chain fields first, so every line of this brand-new
			// file has the same shape (the source file may predate that order).
			allLines.push(
				JSON.stringify(
					e.eid ? withChainFields(e, e.eid, e.parentEid ?? null) : e,
				),
			);
		}
		for (const e of stampedSynthetics) {
			allLines.push(JSON.stringify(e));
		}
		allLines.push(JSON.stringify(forkMarker));

		await appendFile(targetPath, `${allLines.join("\n")}\n`);

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
