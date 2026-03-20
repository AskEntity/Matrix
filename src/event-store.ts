import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
} from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { Event } from "./events.ts";

/**
 * JSONL-based event store for Event persistence.
 * Append-only: one JSON line per event. File path: `{dir}/{sessionId}.events.jsonl`
 *
 * Write operations (append/appendBatch) are async and non-blocking.
 * Read operations remain synchronous for simplicity (only called during resume).
 */
export class EventStore {
	constructor(private dir: string) {
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	}

	private path(sessionId: string): string {
		return join(this.dir, `${sessionId}.events.jsonl`);
	}

	/** Append a single event to the JSONL file (async, non-blocking) */
	append(sessionId: string, event: Event): Promise<void> {
		return appendFile(this.path(sessionId), `${JSON.stringify(event)}\n`).catch(
			() => {
				/* non-fatal — don't break caller if write fails */
			},
		);
	}

	/** Append multiple events (async, non-blocking) */
	appendBatch(sessionId: string, events: Event[]): Promise<void> {
		if (events.length === 0) return Promise.resolve();
		const lines = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
		return appendFile(this.path(sessionId), lines).catch(() => {
			/* non-fatal */
		});
	}

	/** Read all events for a session */
	read(sessionId: string): Event[] {
		const p = this.path(sessionId);
		if (!existsSync(p)) return [];
		const text = readFileSync(p, "utf-8");
		return text
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Event);
	}

	/** Read events after the last compact_marker (for provider message reconstruction) */
	readActive(sessionId: string): Event[] {
		const all = this.read(sessionId);
		const lastMarker = all.findLastIndex((e) => e.type === "compact_marker");
		return lastMarker === -1 ? all : all.slice(lastMarker + 1);
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
