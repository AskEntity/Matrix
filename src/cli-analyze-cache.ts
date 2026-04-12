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
	/**
	 * Was there a `compact_marker` event between the previous usage and this
	 * one? Post-compact misses have a distinctive shape (inp drops to a few K,
	 * cc grows, cr=0, then hit ramps back). This flag makes the pattern
	 * explicit instead of requiring visual inspection of inp column.
	 *
	 * Same first-usage semantic as `stoppedInGap`: false if no prior usage.
	 */
	compactInGap: boolean;
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
	let compactSinceLastUsage = false;

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
		if (event.type === "compact_marker") {
			compactSinceLastUsage = true;
			continue;
		}

		if (event.type !== "usage") continue;

		// Skip compaction-estimated usage: not a real API call, just bookkeeping
		// written by the compaction module. Must be skipped BEFORE touching any
		// state so it doesn't (a) appear in misses, (b) count in totalUsageEvents,
		// (c) update prevUsageTs, or (d) consume the stop/compact flags — the
		// flags belong to the next REAL post-compact API call.
		if (event.estimated === true) continue;

		const inputTokens =
			typeof event.inputTokens === "number" ? event.inputTokens : 0;
		if (inputTokens === 0) continue; // garbage row — skip

		totalUsageEvents++;

		const ts = typeof event.ts === "number" ? event.ts : null;
		const gapMs = prevUsageTs != null && ts != null ? ts - prevUsageTs : null;
		// Capture BEFORE reset — these flags describe the just-ended gap.
		// First usage (prevUsageTs === null): no gap exists, so both flags are
		// false regardless of any pre-existing agent_stopped / compact_marker.
		const hasStopped = prevUsageTs != null && stoppedSinceLastUsage;
		const hasCompact = prevUsageTs != null && compactSinceLastUsage;

		// Update prevUsageTs regardless of hit/miss: a hit still resets the clock
		// so the next miss's gap reflects the real inter-usage interval.
		if (ts != null) prevUsageTs = ts;
		stoppedSinceLastUsage = false;
		compactSinceLastUsage = false;

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
			compactInGap: hasCompact,
		});
	}

	return { misses, totalUsageEvents };
}

/**
 * Format a wall-clock duration in milliseconds as a human-readable string
 * with second-level precision (always — 6-minute rounding errors from a
 * previous "X.Xh" format made TTL analysis guess-work).
 *
 *   null    → "—"
 *   < 60s   → "Xs"          (e.g. "45s")
 *   < 60m   → "XmYs"        (e.g. "1m5s")
 *   ≥ 1h    → "XhYmZs"      (e.g. "1h0m23s" — zero components kept for structure)
 */
export function formatGap(gapMs: number | null): string {
	if (gapMs == null) return "—";
	const totalS = Math.round(gapMs / 1000);
	if (totalS < 60) return `${totalS}s`;
	const s = totalS % 60;
	const totalM = Math.floor(totalS / 60);
	if (totalM < 60) return `${totalM}m${s}s`;
	const m = totalM % 60;
	const h = Math.floor(totalM / 60);
	return `${h}h${m}m${s}s`;
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
		`stopped=${row.stoppedInGap ? "yes" : "no"}  ` +
		`compact=${row.compactInGap ? "yes" : "no"}`
	);
}

/**
 * Parse a compact duration string into milliseconds.
 *   "30s" → 30_000
 *   "5m"  → 300_000
 *   "1.5h" → 5_400_000
 * Returns null for invalid input (caller decides how to report).
 */
export function parseDuration(s: string): number | null {
	const m = s.match(/^(\d+(?:\.\d+)?)(s|m|h)$/);
	if (!m) return null;
	const n = Number.parseFloat(m[1] as string);
	if (!Number.isFinite(n)) return null;
	const unit = m[2];
	if (unit === "s") return n * 1000;
	if (unit === "m") return n * 60 * 1000;
	if (unit === "h") return n * 60 * 60 * 1000;
	return null;
}

/**
 * Filter miss rows by max gap.
 *   maxGapMs == null → no filter (return all)
 *   gapMs === null (first usage, unknowable) → KEEP
 *   gapMs > maxGapMs → drop
 *   gapMs <= maxGapMs → keep
 */
export function filterByMaxGap(
	rows: CacheMissRow[],
	maxGapMs: number | null,
): CacheMissRow[] {
	if (maxGapMs == null) return rows;
	return rows.filter((r) => r.gapMs == null || r.gapMs <= maxGapMs);
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
	// Extract --max-gap <duration> if present
	const positional: string[] = [];
	let maxGapRaw: string | null = null;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--max-gap") {
			maxGapRaw = args[++i] ?? null;
			if (maxGapRaw == null) {
				console.error("--max-gap requires a value (e.g. 61m)");
				process.exit(1);
			}
		} else if (a != null) {
			positional.push(a);
		}
	}

	const projectId = positional[0];
	const taskId = positional[1];
	if (!projectId || !taskId) {
		console.error(
			"Usage: mxd analyze-cache <projectId> <taskId> [--max-gap <duration>]",
		);
		process.exit(1);
	}

	let maxGapMs: number | null = null;
	if (maxGapRaw != null) {
		maxGapMs = parseDuration(maxGapRaw);
		if (maxGapMs == null) {
			console.error(
				`Invalid --max-gap value: "${maxGapRaw}" (expected e.g. 30s, 5m, 1h, 61m)`,
			);
			process.exit(1);
		}
	}

	const path = resolveTaskJsonlPath(projectId, taskId);
	if (!existsSync(path)) {
		console.error(`JSONL not found: ${path}`);
		process.exit(1);
	}

	const content = readFileSync(path, "utf-8");
	const { misses: allMisses, totalUsageEvents } = analyzeCacheMisses(content);
	const shownMisses = filterByMaxGap(allMisses, maxGapMs);

	for (const row of shownMisses) {
		console.log(formatRow(row));
	}

	const filterNote =
		maxGapMs != null ? ` — gap filter <=${maxGapRaw} applied` : "";
	console.log(
		`\n${shownMisses.length} misses shown (out of ${allMisses.length} total misses, ${totalUsageEvents} total usage events)${filterNote}`,
	);
}
