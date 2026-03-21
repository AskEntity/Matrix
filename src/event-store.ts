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
import type { Event, MessageBody } from "./events.ts";

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
			return appendFile(this.path(sessionId), lines).catch(() => {
				/* non-fatal */
			});
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

// ---------------------------------------------------------------------------
// JSONL Event Migration Runner
// ---------------------------------------------------------------------------

/**
 * Each migration transforms one parsed JSONL event. Must be idempotent —
 * running twice on the same event produces the same result.
 */
type EventMigration = (
	event: Record<string, unknown>,
) => Record<string, unknown>;

// ── Migration: user_message → message, queueEntry → body ──────────────────

/** Old event types that should become `message` with appropriate `body`. */
const LEGACY_STANDALONE_TYPES = new Set([
	"child_complete",
	"parent_update",
	"clarify_response",
	"child_report",
	"cross_project",
	"background_complete",
	"system_notification",
	"compact_request",
]);

/**
 * Migrate old event formats to the unified `message` type:
 * - `user_message` → `message`, `queueEntry` → `body`
 * - `message_injected` → `message`
 * - `tree_mutation` → `message` with system body
 * - Standalone queue types (child_complete, parent_update, etc.) → `message` with body
 *
 * Idempotent: events already in `message` format pass through unchanged.
 */
function migrateUserMessageToMessage(
	raw: Record<string, unknown>,
): Record<string, unknown> {
	const type = raw.type as string;

	// Already new format
	if (type === "message") return raw;

	// user_message → message, queueEntry → body
	if (type === "user_message") {
		const migrated: Record<string, unknown> = { ...raw, type: "message" };
		if ("queueEntry" in raw) {
			migrated.body = raw.queueEntry;
			delete migrated.queueEntry;
		}
		return migrated;
	}

	// message_injected → message (legacy type from before two-phase lifecycle)
	if (type === "message_injected") {
		return {
			type: "message",
			content: raw.content,
			...(raw.taskId !== undefined ? { taskId: raw.taskId } : {}),
			ts: raw.ts,
		};
	}

	// tree_mutation → message with system body
	if (type === "tree_mutation") {
		const action = raw.action as string;
		const title = raw.title as string | undefined;
		const nodeId = raw.nodeId as string;
		const content = title
			? `Tree ${action}: "${title}" (${nodeId})`
			: `Tree ${action} (${nodeId})`;
		return {
			type: "message",
			source: "system",
			body: { source: "system", content } satisfies MessageBody,
			ts: raw.ts,
		};
	}

	// Standalone queue types → message with body
	if (LEGACY_STANDALONE_TYPES.has(type)) {
		const body: Record<string, unknown> = { source: type };

		switch (type) {
			case "child_complete":
				body.taskId = raw.taskId;
				body.title = raw.title;
				body.success = raw.success;
				body.output = raw.output;
				break;
			case "parent_update":
				body.content = raw.content;
				if (raw.requestReply) body.requestReply = raw.requestReply;
				break;
			case "clarify_response":
				body.answer = raw.answer;
				break;
			case "child_report":
				body.taskId = raw.taskId;
				body.title = raw.title;
				body.content = raw.content;
				if (raw.requestReply) body.requestReply = raw.requestReply;
				break;
			case "cross_project":
				body.fromProjectId = raw.fromProjectId;
				body.fromProjectName = raw.fromProjectName;
				body.content = raw.content;
				break;
			case "background_complete":
				body.command = raw.command;
				body.commandId = raw.commandId;
				body.exitCode = raw.exitCode;
				body.durationMs = raw.durationMs;
				break;
			case "system_notification":
				body.source = "system";
				body.content = raw.content;
				break;
			case "compact_request":
				body.source = "compact";
				break;
		}

		const source =
			type === "system_notification"
				? "system"
				: type === "compact_request"
					? "compact"
					: type;

		return {
			type: "message",
			...(raw.id !== undefined ? { id: raw.id } : {}),
			source,
			body: body as unknown as MessageBody,
			ts: raw.ts,
		};
	}

	return raw;
}

// ── Migration runner ──────────────────────────────────────────────────────

/**
 * Active migrations — add new ones, remove old ones when no longer needed.
 * Each migration is idempotent. They run in order on every event.
 */
const ACTIVE_MIGRATIONS: EventMigration[] = [migrateUserMessageToMessage];

/**
 * Apply all active migrations to a single event.
 */
function applyMigrations(
	event: Record<string, unknown>,
): Record<string, unknown> {
	let result = event;
	for (const migrate of ACTIVE_MIGRATIONS) {
		result = migrate(result);
	}
	return result;
}

/**
 * Migrate a single JSONL file by running all active migrations on each event.
 * Returns true if the file was modified, false if already up-to-date.
 */
function migrateJsonlFile(filePath: string): boolean {
	if (!existsSync(filePath)) return false;

	const text = readFileSync(filePath, "utf-8");
	const lines = text.trim().split("\n").filter(Boolean);
	if (lines.length === 0) return false;

	const migratedLines: string[] = [];
	let changed = false;
	for (const line of lines) {
		try {
			const parsed = JSON.parse(line) as Record<string, unknown>;
			const migrated = applyMigrations(parsed);
			const serialized = JSON.stringify(migrated);
			if (serialized !== line.trim()) {
				changed = true;
			}
			migratedLines.push(serialized);
		} catch {
			// Preserve unparseable lines as-is
			migratedLines.push(line);
		}
	}

	if (!changed) return false;

	writeFileSync(filePath, `${migratedLines.join("\n")}\n`);
	return true;
}

/**
 * Run all active event migrations on all JSONL files.
 * Scans `{sessionsDir}/{projectId}/*.events.jsonl`.
 *
 * Call at daemon startup before auto-resume. No-op when ACTIVE_MIGRATIONS is empty.
 * Returns count of files that were modified.
 */
export function runEventMigrations(sessionsDir: string): number {
	if (ACTIVE_MIGRATIONS.length === 0) return 0;
	if (!existsSync(sessionsDir)) return 0;

	let migratedCount = 0;
	try {
		const projectDirs = readdirSync(sessionsDir);
		for (const projectDir of projectDirs) {
			const projectPath = join(sessionsDir, projectDir);
			try {
				const files = readdirSync(projectPath);
				for (const file of files) {
					if (!file.endsWith(".events.jsonl")) continue;
					if (migrateJsonlFile(join(projectPath, file))) {
						migratedCount++;
					}
				}
			} catch {
				// Skip unreadable project directories
			}
		}
	} catch {
		// sessionsDir doesn't exist or is unreadable
	}

	return migratedCount;
}
