/**
 * Search ONE task's conversation, on demand, by streaming that task's JSONL.
 *
 * WHY this exists: `search_tasks` indexes a task's title, description and each
 * done() round's result. The CONVERSATION is not in that index, and the
 * conversation is the only place a user's own words survive — a description is
 * written after the decision and is already one retelling, a result round is
 * written after the work and is another. Twice in one evening (2026-07-29) the
 * only way to answer "where did this claim come from" was to hand-scan JSONL,
 * and what that recovered was a hedged recollection ("我记得…") which had been
 * restated as an absolute assertion 30 seconds later and carried a design
 * conclusion for four months. It existed nowhere but the conversation.
 *
 * ⚠️ SCOPE, decided before any code was written: ONE task, scanned on demand.
 * No index, no embeddings, no staleness tracking, and deliberately NOT folded
 * into `search_tasks`. The measured cost of rebuilding the existing index over
 * 1115 SHORT documents is 697s of wall clock and 3044s of CPU; conversations
 * are three orders of magnitude larger than that corpus (this project's 454
 * session files are 600MB). A global conversation index is not a smaller
 * version of that problem, it is a much larger one.
 *
 * A closed task must be searchable — that is where most of the value is, since
 * a running task can still be asked directly. So this reads from the data root
 * (`projectTasksDir`), never from a worktree: `close_task` removes the worktree
 * and the branch, and leaves the JSONL untouched.
 *
 * Leaf module: streams a file, matches, truncates. It does not know what a
 * task is, does not touch the tracker, and does not import the runtime.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { relativeAge } from "./search-hit-format.ts";

// ── The vocabulary: what an event's "kind" is ──

/**
 * The searchable kind of one raw event: its `type`, plus the discriminator that
 * actually decides what it contains.
 *
 * `message` → `message:<body.source>`, `tool_call`/`tool_result` →
 * `<type>:<tool>`. Messages are 8062 of root's 70,991 events and are wildly
 * heterogeneous — `user` (3972 events, 18.2MB, largest single 1.68MB),
 * `work_context` (22 events, 4.5MB of copied memory.md), `task_complete`,
 * `interrupt`, `compact`. Collapsing that under one name would make "find what
 * the USER said" — the motivating query — unaskable, and would put a verbatim
 * copy of memory.md in the same bucket as human speech.
 *
 * Filters match a whole group by prefix (see `kindMatches`), so `tool_result`
 * still names every tool's results and `message` still names every source.
 *
 * A malformed event with no `type` is kind `(unknown)` rather than being
 * dropped: it still carries text, and dropping it silently is the under-report
 * this whole module is built to avoid.
 */
export function eventKind(event: Record<string, unknown>): string {
	const type = typeof event.type === "string" ? event.type : "(unknown)";
	if (type === "message") {
		const body = event.body;
		const source =
			body && typeof body === "object"
				? (body as Record<string, unknown>).source
				: undefined;
		return typeof source === "string" ? `message:${source}` : "message";
	}
	if (type === "tool_call" || type === "tool_result") {
		return typeof event.tool === "string" ? `${type}:${event.tool}` : type;
	}
	return type;
}

/**
 * Kinds NOT searched unless the caller names them.
 *
 * ⚠️ This is a SUBTRACT-list and must stay one. An include-list of "the kinds
 * worth searching" fails silently — a new event type simply is not searchable
 * and nothing anywhere says so. Here a new type IS searched by default, and if
 * it turns out to be noise somebody sees the noise and adds a line.
 *
 * Every member is here for a measured reason, and every member is reachable
 * through the `kinds` parameter. Counts are root's own session (2026-07-30,
 * 70,991 events, 113.3MB):
 *
 * | kind | size | why it is not conversation |
 * |---|---|---|
 * | `tool_result` | 14,320 events, 33.9MB | file contents, command output, test logs — the largest category by count AND by bytes |
 * | `message:work_context` | 22 events, 4.5MB, max 535KB | body preloads all of `memory.md`; a hit is a duplicate of a file every agent already has in context |
 * | `session_config` | 31 events, 3.0MB | verbatim copy of the system prompt + every tool's JSON schema, both readable at their source |
 *
 * ⭐ The shared principle, and the one to apply when adding a fourth: these are
 * COPIES OF SOMETHING ELSE. A hit inside one is a hit you could have got from
 * the original, so it crowds out the content that exists nowhere else. Size
 * alone is not the criterion — `message:user` is the biggest thing here and is
 * the whole point.
 */
export const DEFAULT_EXCLUDED_KINDS: readonly string[] = [
	"tool_result",
	"message:work_context",
	"session_config",
];

/**
 * Fields that are identifiers or opaque blobs rather than text.
 *
 * ⚠️ SUBTRACT-list again, and it is what makes extraction survive the event
 * shapes being non-uniform. Text lives in `body` for a `message`, `content` for
 * an `assistant_text`, `thinking` for a `thinking`, `input` for a `tool_call`
 * — an implementation that reaches for one field name returns nothing for whole
 * categories while looking like it worked. (That failure is why this module
 * exists in the shape it does: three consecutive tool calls returned empty
 * results that read as real answers.) So we take every string leaf and remove
 * the ones that are not prose.
 *
 * `signature` is the expensive one: thinking events are 22MB of root's session
 * and a large share of that is base64 signature blobs.
 */
const NON_TEXT_FIELDS: ReadonlySet<string> = new Set([
	// event identity + routing
	"eid",
	"parentEid",
	"taskId",
	"traceId",
	"toolCallId",
	"id",
	"type",
	"messageIds",
	// discriminator — already surfaced as the kind
	"source",
	// cross-references
	"fromTaskId",
	"nodeId",
	"commandId",
	"fromProjectId",
	"sourceTaskId",
	"targetEid",
	// opaque blobs
	"signature",
	"images",
	"base64",
]);

/** Guard against pathological nesting; real events are 3 deep at most. */
const MAX_WALK_DEPTH = 8;

// ── Limits. Decided BEFORE the search worked, not after. ──

/**
 * ⚠️ Every cap here is on BYTES, never on the number of events, and that is
 * the whole lesson of `01KXNZHYSJFF0BVQJVPG2WC1RV`: on 2026-07-15 one
 * `get_logs` result of ~600K tokens took root from 810K to 1.42M, past the 1M
 * limit, into a 400 on every subsequent request including the compaction that
 * would have rescued it — recovered only by hand-editing the session JSONL.
 *
 * Why a count cannot stand in for a size: one `message:user` in root's session
 * is 1.68MB on its own, so a single event can outweigh every other event
 * combined and "return at most N events" bounds nothing.
 *
 * ⭐ And why the cap must be keyed on bytes rather than on which event types
 * are known to be big — this is the part with a four-month history rather than
 * a measurement from today. `01KP1B56XZX4BT56EGTKS5K74Y` measured `get_logs` at
 * 60KB+ per call in April 2026 and traced it to `tool_result` content and
 * thinking-signature blobs; that is why `hideToolResults` defaults to true and
 * why signatures are stripped. RE-MEASURED 2026-07-30: `get_logs(begin=0,
 * end=2)` — TWO events — still returns ~60KB, but now from `work_context`
 * preloading the whole of `memory.md`. **The April fix works and simply does
 * not cover this path.** One oversized category was identified and mitigated
 * and a different one grew into the same envelope, so a type-keyed cap would
 * have been right in April and wrong today. A byte-keyed cap survives the
 * substitution.
 */
export const LOG_SEARCH_LIMITS = {
	/** Chars of the matching field kept per hit, centred on the first match. */
	matchExcerptChars: 400,
	/** Chars kept for each surrounding-context event. */
	contextExcerptChars: 160,
	/**
	 * Hard ceiling on the whole formatted result (~3K tokens). This is the cap
	 * that actually binds: with default context, hits cost ~700 chars each, so
	 * the budget stops emission around 16 hits well before `maxHits` does.
	 */
	totalChars: 12_000,
	/** Default / maximum number of hits rendered. */
	defaultHits: 20,
	maxHits: 100,
	/** Default / maximum surrounding events shown either side of a hit. */
	defaultContext: 1,
	maxContext: 5,
} as const;

// ── Result types ──

/**
 * One event rendered as surrounding context for a hit.
 *
 * ⚠️ Context is drawn from the SAME filtered population as the search, and only
 * from events that actually carry text. Both halves were measured on real
 * output rather than reasoned: without the type filter, ±1 event is almost
 * always `usage` or `messages_consumed`, and the first real render came back
 * with `(no text)` under half the hits. Bookkeeping records are not context —
 * they are what the reader has to look past to find it.
 */
export interface LogContextEvent {
	kind: string;
	ts: number;
	/** Absent for events written before eid stamping (last one 2026-04-16). */
	eid?: string;
	/** Already truncated to `contextExcerptChars`. */
	text: string;
}

export interface LogSearchHit {
	kind: string;
	ts: number;
	/**
	 * The event's durable name. ⚠️ ABSENT for events that predate eid stamping
	 * — measured across this project's 454 session files: 3296 of 397,771
	 * events (0.83%), the newest of them 2026-04-16.
	 *
	 * Those are not a rounding error to be dropped: they are the OLDEST history,
	 * which is exactly what an archaeology tool is reaching for. The motivating
	 * find for this whole module is a 2026-04-05 `task_message`, inside that
	 * window. Renderers must show the hit and say the name is missing — never
	 * omit the hit, and never manufacture a stand-in that could be read as a
	 * real eid. Same migration rule as the commit-trailer `Task-Id:`, where
	 * 1280 historical commits will never carry one.
	 */
	eid?: string;
	/** Dotted path of the field that matched, e.g. `body.content`, `input.command`. */
	field: string;
	/** Number of matches inside that field. */
	matches: number;
	/** Length of the full field text, so a truncated excerpt says what it cut. */
	fieldChars: number;
	/** Whitespace-collapsed window centred on the first match. */
	excerpt: string;
	before: LogContextEvent[];
	after: LogContextEvent[];
}

export interface LogSearchResult {
	/** False when the task has no session file at all — never conflate with "no matches". */
	fileExists: boolean;
	hits: LogSearchHit[];
	/** Events containing at least one match, across the WHOLE file. */
	matchingEvents: number;
	/** Total matches across the whole file — the answer to "how many times did we say X". */
	totalMatches: number;
	/** Events actually searched, i.e. after the kind filter. */
	searchedEvents: number;
	/** Every event in the file, so the header can show what the filter removed. */
	totalEvents: number;
	fileBytes: number;
	/** Lines that would not parse. Reported, never silently skipped. */
	malformedLines: number;
	elapsedMs: number;
	/** Kinds excluded from this scan, so a zero result can never be read as "we looked everywhere". */
	skippedKinds: string[];
	/** Kind → event count, for every kind present in the file. Lets an empty result be diagnosed. */
	kindCounts: Record<string, number>;
	/** Set when `hits` was cut short by `maxHits`. */
	hitsTruncated: boolean;
}

export interface LogSearchOptions {
	/** Regex source, matched against every string leaf of every searched event. */
	query: string;
	caseInsensitive?: boolean;
	/** Kinds to search. Omitted → everything except {@link DEFAULT_EXCLUDED_KINDS}. */
	kinds?: string[];
	/** Surrounding searched events shown either side of a hit. */
	context?: number;
	/** Maximum hits collected. The byte budget usually binds first. */
	limit?: number;
}

// ── Extraction ──

interface TextLeaf {
	path: string;
	text: string;
}

function collectText(
	value: unknown,
	path: string,
	out: TextLeaf[],
	depth: number,
): void {
	if (depth > MAX_WALK_DEPTH) return;
	if (typeof value === "string") {
		if (value.length > 0) out.push({ path, text: value });
		return;
	}
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			collectText(value[i], `${path}[${i}]`, out, depth + 1);
		}
		return;
	}
	if (value && typeof value === "object") {
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (NON_TEXT_FIELDS.has(k)) continue;
			collectText(v, path ? `${path}.${k}` : k, out, depth + 1);
		}
	}
}

/** Every prose string in an event, with its dotted path. */
export function extractTextLeaves(event: Record<string, unknown>): TextLeaf[] {
	const out: TextLeaf[] = [];
	collectText(event, "", out, 0);
	return out;
}

// ── Matching helpers ──

/**
 * A kind filter entry matches an exact kind, or a whole `message:*` group by
 * its prefix — so `kinds: ["message"]` means every message source rather than
 * silently matching nothing.
 */
function kindMatches(kind: string, filters: readonly string[]): boolean {
	for (const f of filters) {
		if (kind === f) return true;
		if (kind.startsWith(`${f}:`)) return true;
	}
	return false;
}

/** Collapse whitespace so an excerpt stays one compact readable run. */
function collapse(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

/**
 * Window of `width` chars centred on `[from, to)`, whitespace-collapsed, with
 * ellipses marking what was cut. Matching happens on the RAW text — truncating
 * first would silently lose every match past the cut, which is the under-report
 * this module refuses to produce.
 */
function excerptAround(
	text: string,
	from: number,
	to: number,
	width: number,
): string {
	if (text.length <= width) return collapse(text);
	const matchLen = Math.min(to - from, width);
	const pad = Math.floor((width - matchLen) / 2);
	let start = Math.max(0, from - pad);
	const end = Math.min(text.length, start + width);
	start = Math.max(0, end - width);
	return (
		(start > 0 ? "…" : "") +
		collapse(text.slice(start, end)) +
		(end < text.length ? "…" : "")
	);
}

function truncate(text: string, width: number): string {
	const flat = collapse(text);
	return flat.length <= width ? flat : `${flat.slice(0, width)}…`;
}

function optionalEid(event: Record<string, unknown>): string | undefined {
	return typeof event.eid === "string" && event.eid ? event.eid : undefined;
}

// ── The scan ──

/**
 * Stream `filePath`, one JSON line at a time, matching `query`.
 *
 * ⚠️ STREAMS AND NEVER ACCUMULATES. The file is read line by line and every
 * event is reduced immediately to a truncated record; nothing holds the parsed
 * events. Reading root's 113MB session into an array of objects would cost
 * hundreds of MB of heap inside the worker that runs the agent loop, next to
 * live agents. MEASURED on that file: full streaming parse of all 70,991 events
 * is 154ms, so the cost that needed bounding was memory, not time.
 *
 * NEGATIVE RESULT, so nobody re-derives it: a raw substring pre-filter (test
 * the undecoded line before parsing it) measured 51ms against 154ms — a real
 * 3× on an operation that is already negligible, bought with a soundness hole.
 * JSON escapes `"`, `\` and control characters, so any query containing one
 * would silently fail to match lines that do contain it. Not worth it.
 */
export async function searchTaskLog(
	filePath: string,
	opts: LogSearchOptions,
): Promise<LogSearchResult> {
	const started = performance.now();
	const limit = Math.min(
		Math.max(1, opts.limit ?? LOG_SEARCH_LIMITS.defaultHits),
		LOG_SEARCH_LIMITS.maxHits,
	);
	const contextSize = Math.min(
		Math.max(0, opts.context ?? LOG_SEARCH_LIMITS.defaultContext),
		LOG_SEARCH_LIMITS.maxContext,
	);
	const includeKinds = opts.kinds?.length ? opts.kinds : null;
	const skippedKinds = includeKinds ? [] : [...DEFAULT_EXCLUDED_KINDS];

	const empty: LogSearchResult = {
		fileExists: false,
		hits: [],
		matchingEvents: 0,
		totalMatches: 0,
		searchedEvents: 0,
		totalEvents: 0,
		fileBytes: 0,
		malformedLines: 0,
		elapsedMs: 0,
		skippedKinds,
		kindCounts: {},
		hitsTruncated: false,
	};

	let size = 0;
	try {
		size = (await stat(filePath)).size;
	} catch {
		return { ...empty, elapsedMs: performance.now() - started };
	}

	const flags = opts.caseInsensitive ? "gi" : "g";
	const re = new RegExp(opts.query, flags);

	const hits: LogSearchHit[] = [];
	const kindCounts: Record<string, number> = {};
	const ring: LogContextEvent[] = [];
	/** Hits still waiting for their trailing context events. */
	let awaitingAfter: LogSearchHit[] = [];
	let matchingEvents = 0;
	let totalMatches = 0;
	let searchedEvents = 0;
	let totalEvents = 0;
	let malformedLines = 0;

	const handleEvent = (event: Record<string, unknown>): void => {
		totalEvents++;
		const kind = eventKind(event);
		kindCounts[kind] = (kindCounts[kind] ?? 0) + 1;

		const searched = includeKinds
			? kindMatches(kind, includeKinds)
			: !kindMatches(kind, DEFAULT_EXCLUDED_KINDS);
		if (!searched) return;

		searchedEvents++;
		const ts = typeof event.ts === "number" ? event.ts : 0;
		const eid = optionalEid(event);
		const leaves = extractTextLeaves(event);

		// Best match in this event: first field that matches, all matches counted.
		let best: { leaf: TextLeaf; from: number; to: number } | null = null;
		let eventMatches = 0;
		for (const leaf of leaves) {
			re.lastIndex = 0;
			let m = re.exec(leaf.text);
			while (m) {
				eventMatches++;
				if (!best) best = { leaf, from: m.index, to: m.index + m[0].length };
				// Zero-length matches would spin forever; step past them.
				if (m[0].length === 0) re.lastIndex++;
				m = re.exec(leaf.text);
			}
		}

		/** The hit created by THIS event, if any — it must not be its own context. */
		let ownHit: LogSearchHit | null = null;

		if (best) {
			matchingEvents++;
			totalMatches += eventMatches;
			if (hits.length < limit) {
				const hit: LogSearchHit = {
					kind,
					ts,
					...(eid ? { eid } : {}),
					field: best.leaf.path,
					matches: eventMatches,
					fieldChars: best.leaf.text.length,
					excerpt: excerptAround(
						best.leaf.text,
						best.from,
						best.to,
						LOG_SEARCH_LIMITS.matchExcerptChars,
					),
					before: contextSize ? ring.slice(-contextSize) : [],
					after: [],
				};
				hits.push(hit);
				ownHit = hit;
				if (contextSize > 0) awaitingAfter.push(hit);
			}
		}

		if (contextSize === 0) return;

		// Context text is the LONGEST leaf, not the first. For a tool_call the
		// first leaf is the tool NAME, so "first" rendered every bash call as the
		// bare string `mcp__mxd__bash` while the command sat one field away.
		let longest = "";
		for (const leaf of leaves) {
			if (leaf.text.length > longest.length) longest = leaf.text;
		}
		if (!longest) return; // textless event — not context, see LogContextEvent

		const ctx: LogContextEvent = {
			kind,
			ts,
			...(eid ? { eid } : {}),
			text: truncate(longest, LOG_SEARCH_LIMITS.contextExcerptChars),
		};

		// Feed trailing context to every hit still collecting it — including when
		// THIS event matched too. Two adjacent matches are each other's context,
		// and the first version's `else` branch silently dropped exactly that
		// case, so a cluster of hits rendered with nothing after it.
		if (awaitingAfter.length > 0) {
			for (const h of awaitingAfter) {
				if (h !== ownHit) h.after.push(ctx);
			}
			awaitingAfter = awaitingAfter.filter((h) => h.after.length < contextSize);
		}

		ring.push(ctx);
		if (ring.length > contextSize) ring.shift();
	};

	await new Promise<void>((resolve, reject) => {
		const stream = createReadStream(filePath, { encoding: "utf-8" });
		let buf = "";
		const consume = (line: string) => {
			if (!line.trim()) return;
			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(line) as Record<string, unknown>;
			} catch {
				malformedLines++;
				return;
			}
			handleEvent(parsed);
		};
		stream.on("data", (chunk) => {
			buf += chunk;
			let nl = buf.indexOf("\n");
			while (nl !== -1) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				nl = buf.indexOf("\n");
				consume(line);
			}
		});
		stream.on("error", reject);
		stream.on("end", () => {
			consume(buf);
			resolve();
		});
	});

	return {
		fileExists: true,
		hits,
		matchingEvents,
		totalMatches,
		searchedEvents,
		totalEvents,
		fileBytes: size,
		malformedLines,
		elapsedMs: performance.now() - started,
		skippedKinds,
		kindCounts,
		hitsTruncated: matchingEvents > hits.length,
	};
}

// ── Rendering ──

/**
 * ⚠️ Absolute stamp AND relative age, both, always. Agents are date-blind and
 * confidently so — one read `14:56 → 16:13` as "about 80 minutes" across an
 * 8-day gap. The absolute form is what you carry to another log or to git; the
 * relative form is what answers "does this still count".
 */
function stamp(ts: number, now: number): string {
	if (!ts) return "(no timestamp)";
	const iso = new Date(ts).toISOString();
	return `${iso.replace(/\.\d{3}Z$/, "Z")} (${relativeAge(iso, now)})`;
}

function plural(n: number, one: string, many: string): string {
	return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/**
 * How a hit names itself.
 *
 * ⚠️ An event with no eid emits NO `eid=` token at all, rather than
 * `eid=(none)`. The difference is structural, not typographic: anything parsing
 * this output for `eid=([0-9a-f]+)` finds nothing and correctly concludes the
 * name is absent, instead of capturing a placeholder that reads as a real name.
 */
function identity(hit: LogSearchHit): string {
	return hit.eid
		? `eid=${hit.eid}`
		: "(no eid — predates eid stamping, ≤2026-04-16)";
}

function renderContext(
	marker: string,
	c: LogContextEvent,
	now: number,
): string {
	const head = `    ${marker} ${c.kind}  ${stamp(c.ts, now)}`;
	// A tool_call with empty input has the tool NAME as its longest leaf, which
	// the kind already says. Printing it again renders every `yield` as two
	// identical lines.
	const discriminator = c.kind.slice(c.kind.indexOf(":") + 1);
	if (c.text === discriminator) return head;
	return `${head}\n      ${c.text}`;
}

/**
 * Format a result for an agent, under a hard character budget.
 *
 * The budget is enforced by BUILDING until it is reached and then saying how
 * many hits were dropped — not by trusting the per-hit caps to add up. A cap
 * that is merely expected to hold is the failure this whole module is guarding
 * against.
 */
export function formatLogSearchResult(
	result: LogSearchResult,
	taskId: string,
	query: string,
	now: number = Date.now(),
): string {
	if (!result.fileExists) {
		return (
			`No session file for task ${taskId} — it has never run, or its session was cleared.\n` +
			"This is NOT 'no matches': there was nothing to search."
		);
	}

	const mb = (result.fileBytes / 1e6).toFixed(1);
	const head: string[] = [];
	head.push(
		`search_logs /${query}/ in task ${taskId} — ${plural(result.matchingEvents, "matching event", "matching events")}, ${plural(result.totalMatches, "match", "matches")} in total`,
	);
	head.push(
		`searched ${result.searchedEvents.toLocaleString()} of ${result.totalEvents.toLocaleString()} events (${mb}MB file) in ${Math.round(result.elapsedMs)}ms`,
	);
	if (result.skippedKinds.length > 0) {
		head.push(
			`NOT searched: ${result.skippedKinds.join(", ")} — pass \`kinds\` to include them.`,
		);
	}
	if (result.malformedLines > 0) {
		head.push(
			`${plural(result.malformedLines, "line", "lines")} in this file could not be parsed and ${result.malformedLines === 1 ? "was" : "were"} not searched.`,
		);
	}

	if (result.matchingEvents === 0) {
		// ⚠️ An empty result must be distinguishable from never having looked.
		// "No matches" and "you searched the wrong kinds" are byte-identical
		// otherwise, and the second one silently confirms whatever the caller
		// already believed — so the zero case reports what the file DOES hold.
		const present = Object.entries(result.kindCounts)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 15)
			.map(([k, n]) => `${k} ${n}`)
			.join(", ");
		head.push("");
		head.push(
			`No matches. Kinds present in this task's log: ${present || "(empty file)"}`,
		);
		return head.join("\n");
	}

	const parts: string[] = [];
	let used = head.join("\n").length;
	let shown = 0;
	let budgetStopped = false;

	for (const hit of result.hits) {
		const lines: string[] = [];
		lines.push("");
		lines.push(
			`#${shown + 1}  ${hit.kind}  ${stamp(hit.ts, now)}  ${identity(hit)}`,
		);
		lines.push(
			`    matched ${hit.field} — ${plural(hit.matches, "match", "matches")} in ${hit.fieldChars.toLocaleString()} chars`,
		);
		for (const c of hit.before) lines.push(renderContext("before ", c, now));
		lines.push(`    >>> ${hit.excerpt}`);
		for (const c of hit.after) lines.push(renderContext("after  ", c, now));

		const block = lines.join("\n");
		// `shown > 0` lets a single oversized hit through: one hit is the minimum
		// useful answer, and it is still bounded — excerpt 400 + context
		// 2×maxContext×160 + line overhead is ~3K chars, a quarter of the budget.
		if (used + block.length > LOG_SEARCH_LIMITS.totalChars && shown > 0) {
			budgetStopped = true;
			break;
		}
		parts.push(block);
		used += block.length;
		shown++;
	}

	const tail: string[] = [];
	const omitted = result.matchingEvents - shown;
	if (omitted > 0) {
		tail.push("");
		tail.push(
			budgetStopped
				? `${shown} of ${result.matchingEvents.toLocaleString()} matching events shown — stopped at the ${LOG_SEARCH_LIMITS.totalChars.toLocaleString()}-char output budget. Narrow the query, or lower \`context\`.`
				: `${shown} of ${result.matchingEvents.toLocaleString()} matching events shown, oldest first (\`limit\`=${result.hits.length}). Narrow the query to see the rest.`,
		);
	}

	return `${head.join("\n")}\n${parts.join("\n")}${tail.join("\n")}`;
}
