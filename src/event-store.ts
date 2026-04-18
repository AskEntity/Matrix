import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { Event } from "./events.ts";
import { TOOL_FORK_TASK_CONTEXT } from "./tool-names.ts";
import { ulid } from "./ulid.ts";

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
	 * Append a single event to the JSONL file.
	 *
	 * Uses `appendFileSync` intentionally: the filesystem write must complete
	 * in the same microtask as the generation guard check (see `enqueueWrite`).
	 * Writes are small (one JSON line), blocking the main thread for tens of
	 * microseconds, which is negligible next to provider streaming latency.
	 */
	append(sessionId: string, event: Event): Promise<void> {
		return this.enqueueWrite(sessionId, () => {
			try {
				appendFileSync(
					this.path(sessionId),
					`${JSON.stringify(event)}\n`,
				);
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
			const lines = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
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

	/** Read all events for a session */
	read(sessionId: string): Event[] {
		const p = this.path(sessionId);
		if (!existsSync(p)) return [];
		const text = readFileSync(p, "utf-8");
		const events: Event[] = [];
		for (const line of text.trim().split("\n")) {
			if (!line) continue;
			try {
				events.push(JSON.parse(line) as Event);
			} catch {
				console.warn(
					`[EventStore] Skipping malformed JSONL line in session ${sessionId}`,
				);
			}
		}
		return events;
	}

	/** Read events after the last compact_marker (for provider message reconstruction) */
	readActive(sessionId: string): Event[] {
		const all = this.read(sessionId);
		const lastMarker = all.findLastIndex((e) => e.type === "compact_marker");
		return lastMarker === -1 ? all : all.slice(lastMarker + 1);
	}

	/**
	 * Read events from the last compact_marker onward (for UI activity log).
	 * Returns the compact_marker itself plus all events after it.
	 * Also indicates whether there are older events before the marker.
	 *
	 * For forked sessions, pre-fork events (copies of the parent's history) are
	 * excluded: fork_marker acts as a barrier just like compact_marker. The barrier
	 * used is whichever comes last — compact_marker or fork_marker.
	 */
	readFromLastCompactMarker(sessionId: string): {
		events: Event[];
		hasOlderEvents: boolean;
	} {
		const all = this.read(sessionId);
		const lastCompact = all.findLastIndex((e) => e.type === "compact_marker");
		const lastFork = all.findLastIndex((e) => e.type === "fork_marker");
		const barrier = Math.max(lastCompact, lastFork);
		if (barrier === -1) {
			return { events: all, hasOlderEvents: false };
		}
		return {
			events: all.slice(barrier),
			hasOlderEvents: barrier > 0,
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
	 * Everything after lineIndex is removed. Serialized per-session to prevent interleaving.
	 * Flushes pending writes before truncating to ensure consistency.
	 */
	async truncateAfterLine(sessionId: string, lineIndex: number): Promise<void> {
		// Flush first so we read the complete file
		await this.flushSession(sessionId);

		const p = this.path(sessionId);
		if (!existsSync(p)) return;

		const text = readFileSync(p, "utf-8");
		const lines = text.split("\n");
		// Remove trailing empty line from split
		if (lines.length > 0 && lines[lines.length - 1] === "") {
			lines.pop();
		}

		if (lineIndex >= lines.length - 1) return; // nothing to truncate

		const kept = lines.slice(0, lineIndex + 1);
		writeFileSync(p, `${kept.join("\n")}\n`);
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
		const allLines: string[] = [];
		for (const e of activeEvents) {
			allLines.push(JSON.stringify(e));
		}
		for (const e of syntheticEvents) {
			allLines.push(JSON.stringify(e));
		}

		const forkMarker: Event = {
			type: "fork_marker",
			sourceTaskId: sourceId,
			...(opts?.targetTitle && { targetTitle: opts.targetTitle }),
			...(opts?.targetDescription && {
				targetDescription: opts.targetDescription,
			}),
			taskId: targetId,
			ts: Date.now(),
		};
		allLines.push(JSON.stringify(forkMarker));

		await appendFile(targetPath, `${allLines.join("\n")}\n`);

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
