/**
 * Pre-API-call debug snapshot: persist the exact bytes sent to the API.
 *
 * When a provider is about to call the API, it writes the FULLY-ASSEMBLED
 * request (post-cache-control messages, system prompt, tools, model, etc.)
 * to disk.
 *
 * WHY: post-mortem evidence for cache-drift debugging. When a daemon restart
 * causes unexpected cache miss, the pre-restart snapshot is the "last state
 * the API saw". Compare it to walker(JSONL) to find exact divergence points.
 *
 * LAYOUT (v2): snapshots are grouped by loop run (traceId epoch):
 *   `<projectPath>/debug/<taskId>/<traceId>/last.json`
 *
 * Each run of `runAgentForNode` has a unique `loopTraceId` (ULID). Every API
 * call within that run overwrites the SAME file (we only need the latest per
 * run). On daemon restart, a new run starts → new traceId → new directory.
 * The previous run's `last.json` is automatically preserved with its final
 * pre-restart state — diff the two to find drift.
 *
 * RETENTION: the oldest traceId directories are rolled off by
 * `rollOldTraceIdDirs`, keeping only the N most recent (by mtime).
 *
 * NON-FATAL: snapshot failure never blocks an API call. Errors are logged
 * to stderr only. The snapshot is diagnostic infrastructure, not load-bearing.
 */

import {
	mkdirSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export interface DebugSnapshot {
	/** Timestamp when snapshot was written (ms since epoch). */
	ts: number;
	/** Session ID (= taskId). */
	sessionId: string;
	/** Model name sent to the API (e.g. "claude-opus-4-6"). */
	model: string;
	/** System prompt (as sent — may be array of blocks for Anthropic). */
	system?: unknown;
	/** Tools (as sent). */
	tools?: unknown;
	/** Cache TTL applied to message breakpoints ("1h" | "5m" | undefined). */
	cacheTtl?: string;
	/** Messages (post-cache-control, post-image-filter — exactly as sent). */
	messages: unknown;
	/** Provider name (anthropic / openai / openai-responses). */
	provider: string;
}

/**
 * Write a debug snapshot synchronously. Non-fatal on error.
 * Creates parent directory if missing.
 */
export function writeDebugSnapshot(
	filePath: string | undefined,
	snapshot: Omit<DebugSnapshot, "ts">,
): void {
	if (!filePath) return;
	try {
		mkdirSync(dirname(filePath), { recursive: true });
		const full: DebugSnapshot = { ts: Date.now(), ...snapshot };
		writeFileSync(filePath, JSON.stringify(full, null, 2));
	} catch (e) {
		// Non-fatal — the snapshot is diagnostic, not load-bearing.
		console.warn(
			`[debug-snapshot] Failed to write ${filePath}:`,
			e instanceof Error ? e.message : String(e),
		);
	}
}

/** ULID = 26 chars, Crockford base32 (0-9, A-H, J, K, M, N, P-T, V-Z). */
const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Keep only the N most recent traceId subdirectories under `taskDebugDir`.
 *
 * "Most recent" = highest mtime (directory modification time).
 * Non-ULID entries are ignored. Errors are non-fatal (logged to stderr).
 *
 * Called at the start of each `runAgentForNode` run — BEFORE the new run's
 * directory is created — so the cleanup never races with the active run's
 * writes. (The active run's dir doesn't exist yet when roll runs; the
 * previous run's dir gets a fresh mtime here only if we touch it, which we
 * don't — we just stat and compare.)
 *
 * @param taskDebugDir - Path to `<debug>/<taskId>/` (may not exist yet).
 * @param keepCount    - Number of most-recent dirs to retain.
 */
export function rollOldTraceIdDirs(
	taskDebugDir: string,
	keepCount: number,
): void {
	if (keepCount < 0) return;
	let entries: string[];
	try {
		entries = readdirSync(taskDebugDir);
	} catch {
		// Dir doesn't exist yet — nothing to roll.
		return;
	}

	const dirs: Array<{ name: string; mtimeMs: number }> = [];
	for (const name of entries) {
		if (!ULID_REGEX.test(name)) continue;
		try {
			const st = statSync(join(taskDebugDir, name));
			if (!st.isDirectory()) continue;
			dirs.push({ name, mtimeMs: st.mtimeMs });
		} catch {
			// Entry vanished or not statable — skip.
		}
	}

	if (dirs.length <= keepCount) return;

	// Descending by mtime: newest first. Slice off the tail beyond keepCount.
	dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const toRemove = dirs.slice(keepCount);
	for (const { name } of toRemove) {
		try {
			rmSync(join(taskDebugDir, name), { recursive: true, force: true });
		} catch (e) {
			console.warn(
				`[debug-snapshot] Failed to remove ${join(taskDebugDir, name)}:`,
				e instanceof Error ? e.message : String(e),
			);
		}
	}
}
