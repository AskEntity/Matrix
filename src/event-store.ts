import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { appendFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Event } from "./events.ts";
import { migrateQueueMessage } from "./message-queue.ts";

/**
 * JSONL-based event store for Event persistence.
 * Append-only: one JSON line per event. File path: `{dir}/{sessionId}.events.jsonl`
 *
 * Write operations (append/appendBatch) are async and non-blocking.
 * Read operations remain synchronous for simplicity (only called during resume).
 */
export class EventStore {
	/** Per-session write queue to serialize async appends and prevent interleaving */
	private writeQueues = new Map<string, Promise<void>>();

	constructor(private dir: string) {
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	}

	private path(sessionId: string): string {
		return join(this.dir, `${sessionId}.events.jsonl`);
	}

	/** Serialize a write operation for a given session */
	private enqueueWrite(
		sessionId: string,
		writeFn: () => Promise<void>,
	): Promise<void> {
		const prev = this.writeQueues.get(sessionId) ?? Promise.resolve();
		const next = prev.then(writeFn, writeFn); // run even if previous failed
		this.writeQueues.set(sessionId, next);
		// Clean up completed queues to prevent memory leak
		next.then(() => {
			if (this.writeQueues.get(sessionId) === next) {
				this.writeQueues.delete(sessionId);
			}
		});
		return next;
	}

	/** Append a single event to the JSONL file (async, serialized per session) */
	append(sessionId: string, event: Event): Promise<void> {
		return this.enqueueWrite(sessionId, () =>
			appendFile(this.path(sessionId), `${JSON.stringify(event)}\n`).catch(
				() => {
					/* non-fatal — don't break caller if write fails */
				},
			),
		);
	}

	/** Append multiple events (async, serialized per session) */
	appendBatch(sessionId: string, events: Event[]): Promise<void> {
		if (events.length === 0) return Promise.resolve();
		return this.enqueueWrite(sessionId, () => {
			const lines = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
			return appendFile(this.path(sessionId), lines).catch((e) => {
				console.warn(
					`[EventStore] Failed to append events for session ${sessionId}:`,
					e,
				);
			});
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
			let event: Event;
			try {
				event = JSON.parse(line) as Event;
			} catch {
				console.warn(
					`[EventStore] Skipping malformed JSONL line in session ${sessionId}`,
				);
				continue;
			}
			const raw = event as Record<string, unknown>;
			// Backward compat: old JSONL files may not have taskId
			if (!("taskId" in event) || event.taskId === undefined) {
				raw.taskId = sessionId;
			}
			// Backward compat: old JSONL may be missing fields that are now required
			if (event.type === "orchestration_started") {
				if (!raw.provider) raw.provider = "unknown";
				if (!raw.model) raw.model = "unknown";
			}
			if (event.type === "budget_exceeded") {
				if (raw.costUsd === undefined) raw.costUsd = 0;
				if (raw.budgetUsd === undefined) raw.budgetUsd = 0;
			}
			if (event.type === "clarification_requested") {
				if (!raw.title) raw.title = (raw.question as string) ?? "";
			}
			// Backward compat: migrate old QueueMessage source names in message events
			if (event.type === "message" && raw.body) {
				raw.body = migrateQueueMessage(raw.body);
			}
			events.push(event);
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
	 */
	readFromLastCompactMarker(sessionId: string): {
		events: Event[];
		hasOlderEvents: boolean;
	} {
		const all = this.read(sessionId);
		const lastMarker = all.findLastIndex((e) => e.type === "compact_marker");
		if (lastMarker === -1) {
			return { events: all, hasOlderEvents: false };
		}
		return {
			events: all.slice(lastMarker),
			hasOlderEvents: lastMarker > 0,
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

	/**
	 * Copy events from a source session to a target session, then append a fork_marker.
	 * Only copies events after the last compact_marker (active context) from the source.
	 * Target must NOT already have a session file — call has() first to check.
	 * Returns the number of events copied (excluding the fork_marker).
	 */
	async copySessionFrom(
		sourceId: string,
		targetId: string,
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

		// Read source events, find last compact_marker to only copy active context
		const allEvents = this.read(sourceId);
		const lastMarker = allEvents.findLastIndex(
			(e) => e.type === "compact_marker",
		);
		const activeEvents =
			lastMarker === -1 ? allEvents : allEvents.slice(lastMarker + 1);

		// Write active events to target
		if (activeEvents.length > 0) {
			const lines = `${activeEvents.map((e) => JSON.stringify(e)).join("\n")}\n`;
			await appendFile(targetPath, lines);
		}

		// Append fork_marker
		const forkMarker: Event = {
			type: "fork_marker",
			sourceTaskId: sourceId,
			taskId: targetId,
			ts: Date.now(),
		};
		await appendFile(targetPath, `${JSON.stringify(forkMarker)}\n`);

		return { eventCount: activeEvents.length };
	}

	/** Clear all events for a session */
	clear(sessionId: string): void {
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

	/** Delete all event files in the directory */
	async clearAll(): Promise<void> {
		try {
			await rm(this.dir, { recursive: true, force: true });
			await mkdir(this.dir, { recursive: true });
		} catch {
			/* ok */
		}
	}

	/** List all session IDs that have event files */
	listSessions(): string[] {
		try {
			return readdirSync(this.dir)
				.filter((f) => f.endsWith(".events.jsonl"))
				.map((f) => f.replace(".events.jsonl", ""));
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

/**
 * Run event migrations on all JSONL files.
 * Migrations are idempotent — safe to re-run.
 *
 * Active migrations:
 * - Remove `tree_updated` events: old code versions persisted these ephemeral events.
 *   They cause UI state corruption when loaded from REST (stale/empty nodes arrays).
 */
export function runEventMigrations(sessionsDir: string): number {
	if (!existsSync(sessionsDir)) return 0;

	let migrated = 0;
	const files = readdirSync(sessionsDir).filter((f) =>
		f.endsWith(".events.jsonl"),
	);

	for (const file of files) {
		const filePath = join(sessionsDir, file);
		const content = readFileSync(filePath, "utf-8");

		// Check if file contains tree_updated events (fast check before parsing lines)
		if (!content.includes('"tree_updated"')) continue;

		const lines = content.split("\n");
		const filtered = lines.filter((line) => {
			if (!line.trim()) return true; // keep empty lines
			if (!line.includes('"tree_updated"')) return true; // fast path
			try {
				const parsed = JSON.parse(line);
				return parsed.type !== "tree_updated";
			} catch {
				return true; // keep unparseable lines
			}
		});

		if (filtered.length < lines.length) {
			writeFileSync(filePath, filtered.join("\n"));
			migrated++;
		}
	}

	return migrated;
}
