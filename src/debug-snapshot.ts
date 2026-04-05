/**
 * Pre-API-call debug snapshot: persist the exact bytes sent to the API.
 *
 * When a provider is about to call the API, it writes the FULLY-ASSEMBLED
 * request (post-cache-control messages, system prompt, tools, model, etc.)
 * to disk, overwriting on each call.
 *
 * WHY: post-mortem evidence for cache-drift debugging. When a daemon restart
 * causes unexpected cache miss, this file is the "last pre-restart state"
 * the API saw. Compare it to walker(JSONL) to find exact divergence points.
 *
 * FORMAT: one file per task, path = `<projectPath>/debug/<taskId>.last-messages.json`.
 * Overwritten on every API call (not rolling — we only need the latest).
 *
 * NON-FATAL: snapshot failure never blocks an API call. Errors are logged
 * to stderr only. The snapshot is diagnostic infrastructure, not load-bearing.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
