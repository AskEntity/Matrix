import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * One cache miss row, ready for printing.
 */
export interface CacheMissRow {
	lineNumber: number; // 1-based line number in JSONL
	ts: number;
	inputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	outputTokens: number;
	hitPct: number; // 0..100
	gapMs: number | null; // null if first event in file
	/**
	 * Was there an `agent_stopped` event between the previous usage and this
	 * one? This is the precise "crossed an agent lifecycle boundary" signal —
	 * `orchestration_started` alone is ambiguous (fresh spawn, idle resume,
	 * post-compact restart all emit it), but `agent_stopped` unambiguously
	 * means the previous agent died.
	 *
	 * For the first usage (no prior usage), this is false — the flag describes
	 * "what happened IN the gap", and there is no gap.
	 */
	stoppedInGap: boolean;
}

export interface AnalyzeResult {
	misses: CacheMissRow[];
	totalUsageEvents: number;
}

const HIT_THRESHOLD = 0.93;

/**
 * Parse a JSONL file line-by-line, returning cache miss rows for every usage
 * event where cacheReadTokens / inputTokens < HIT_THRESHOLD.
 *
 * `gapMs` is wall-clock delta to the previous VALID usage event (inputTokens>0).
 * Measuring against "any event" is useless in practice because the line right
 * before a usage is almost always that turn's own tool_result — gap is then
 * 0-25s and tells you nothing. Gap-between-usages is the signal that matters:
 *   gap > 1h  → TTL expiry suspect
 *   gap < 60s → not TTL; drift / restart / anti-distillation injection
 *
 * Every valid usage updates prevUsageTs regardless of hit/miss status — a hit
 * in the middle must still reset the clock, otherwise the next miss's gap
 * would be inflated across the intervening hits and misread as TTL expiry.
 *
 * Synchronous on purpose: this is a CLI one-shot; readFileSync is simpler than
 * a line-streaming abstraction and fast enough for realistic session sizes.
 */
export function analyzeCacheMisses(jsonlContent: string): AnalyzeResult {
	const lines = jsonlContent.split("\n");
	const misses: CacheMissRow[] = [];
	let totalUsageEvents = 0;
	let prevUsageTs: number | null = null;
	let stoppedSinceLastUsage = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line) continue;
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}

		if (event.type === "agent_stopped") {
			stoppedSinceLastUsage = true;
			continue;
		}

		if (event.type !== "usage") continue;

		const inputTokens =
			typeof event.inputTokens === "number" ? event.inputTokens : 0;
		if (inputTokens === 0) continue; // garbage row — skip

		totalUsageEvents++;

		const ts = typeof event.ts === "number" ? event.ts : null;
		const gapMs = prevUsageTs != null && ts != null ? ts - prevUsageTs : null;
		// Capture BEFORE reset — this row's hasStopped reflects the just-ended gap.
		// First usage (prevUsageTs === null): no gap exists, so stoppedInGap is
		// false regardless of any agent_stopped events before it.
		const hasStopped = prevUsageTs != null && stoppedSinceLastUsage;

		// Update prevUsageTs regardless of hit/miss: a hit still resets the clock
		// so the next miss's gap reflects the real inter-usage interval.
		if (ts != null) prevUsageTs = ts;
		stoppedSinceLastUsage = false;

		const cacheReadTokens =
			typeof event.cacheReadTokens === "number" ? event.cacheReadTokens : 0;
		const cacheCreationTokens =
			typeof event.cacheCreationTokens === "number"
				? event.cacheCreationTokens
				: 0;
		const outputTokens =
			typeof event.outputTokens === "number" ? event.outputTokens : 0;

		const ratio = cacheReadTokens / inputTokens;
		if (ratio >= HIT_THRESHOLD) continue;

		misses.push({
			lineNumber: i + 1,
			ts: ts ?? 0,
			inputTokens,
			cacheReadTokens,
			cacheCreationTokens,
			outputTokens,
			hitPct: ratio * 100,
			gapMs,
			stoppedInGap: hasStopped,
		});
	}

	return { misses, totalUsageEvents };
}

/**
 * Format a wall-clock duration in milliseconds using compact SI-style units.
 *   null          → "—"
 *   < 60s         → "Xs"
 *   < 60min       → "Xm" (1 decimal)
 *   otherwise     → "Xh" (1 decimal)
 */
export function formatGap(gapMs: number | null): string {
	if (gapMs == null) return "—";
	const s = gapMs / 1000;
	if (s < 60) return `${Math.round(s)}s`;
	const m = s / 60;
	if (m < 60) return `${m.toFixed(1)}m`;
	return `${(m / 60).toFixed(1)}h`;
}

/** Format unix ms as `YYYY-MM-DD HH:MM:SS` in local time. */
export function formatTimestamp(ts: number): string {
	const d = new Date(ts);
	const pad = (n: number) => String(n).padStart(2, "0");
	return (
		`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
		`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
	);
}

/** Format a number with thousands separators (e.g. 104188 → "104,188"). */
export function formatNum(n: number): string {
	return n.toLocaleString("en-US");
}

/** Format one miss row as a single output line. */
export function formatRow(row: CacheMissRow): string {
	return (
		`line ${row.lineNumber}  ${formatTimestamp(row.ts)}  ` +
		`inp=${formatNum(row.inputTokens)}  ` +
		`cr=${formatNum(row.cacheReadTokens)}  ` +
		`cc=${formatNum(row.cacheCreationTokens)}  ` +
		`out=${formatNum(row.outputTokens)}  ` +
		`hit=${row.hitPct.toFixed(1)}%  ` +
		`gap=${formatGap(row.gapMs)}  ` +
		`stopped=${row.stoppedInGap ? "yes" : "no"}`
	);
}

/**
 * Resolve the JSONL path for a task.
 * `{dataDir}/projects/{projectId}/tasks/{taskId}.jsonl`
 */
export function resolveTaskJsonlPath(
	projectId: string,
	taskId: string,
	dataDir: string = join(homedir(), ".mxd"),
): string {
	return join(dataDir, "projects", projectId, "tasks", `${taskId}.jsonl`);
}

/**
 * Top-level CLI handler for `mxd analyze-cache <projectId> <taskId>`.
 * Does NOT need the daemon running — reads JSONL directly from disk.
 * Exits process on error.
 */
export function runAnalyzeCache(args: string[]): void {
	const projectId = args[0];
	const taskId = args[1];
	if (!projectId || !taskId) {
		console.error("Usage: mxd analyze-cache <projectId> <taskId>");
		process.exit(1);
	}

	const path = resolveTaskJsonlPath(projectId, taskId);
	if (!existsSync(path)) {
		console.error(`JSONL not found: ${path}`);
		process.exit(1);
	}

	const content = readFileSync(path, "utf-8");
	const { misses, totalUsageEvents } = analyzeCacheMisses(content);

	for (const row of misses) {
		console.log(formatRow(row));
	}

	console.log(
		`\n${misses.length} misses found out of ${totalUsageEvents} total usage events`,
	);
}
