/**
 * Tests for `search_logs`' engine.
 *
 * ⚠️ THE FIXTURE IS SHAPE-FAITHFUL ON PURPOSE, and this is the whole reason the
 * file is written the way it is. The failure this feature exists to prevent was
 * an implementation that assumed every event keeps its text in one field: it
 * returned nothing for whole event categories while looking like it had worked,
 * and three consecutive tool calls produced empty results that read as real
 * answers. A tidy fixture where every event has `body` cannot express that
 * difference — it would pass against exactly the broken implementation.
 *
 * So the key sets below are COPIED FROM MEASUREMENT, not invented: a scan of
 * all 454 session files of this project's data root (397,771 events, 600.1MB,
 * 2026-07-30). `assistant_text` really does use `content`, `thinking` really
 * does use `thinking`, `tool_call` really has no `body` at all. `fixtureIsNonUniform`
 * below asserts that property of the fixture itself, so a later "cleanup" that
 * regularises the shapes fails instead of quietly disarming every other test.
 *
 * Measurements quoted in `log-search.ts` came from the largest real file in the
 * system, root's own session:
 * `~/.mxd/projects/<p>/plugin/matrix/tasks/01KPGSJNKG08CWNPZCQ9YY51C3.jsonl`
 * — 113.5MB, 71,148 events, full streaming search in ~300ms. Re-runnable by
 * hand; not asserted here, because a test may not depend on one machine's data.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_EXCLUDED_KINDS,
	eventKind,
	extractTextLeaves,
	formatLogSearchResult,
	LOG_SEARCH_LIMITS,
	type LogSearchOptions,
	searchTaskLog,
} from "./log-search.ts";

// ── Fixture ──

let seq = 0;
const eid = () => (0x1000_0000_0000 + ++seq).toString(16).padStart(12, "0");

/** Key layouts copied verbatim from the real corpus — see the file header. */
const ev = {
	message: (
		source: string,
		body: Record<string, unknown>,
		ts = 1_775_000_000_000,
	) => ({
		type: "message",
		id: `msg${++seq}`,
		taskId: "T",
		body: { source, id: `msg${seq}`, ts, ...body },
		ts,
		eid: eid(),
		parentEid: null,
	}),
	assistantText: (content: string, ts = 1_775_000_000_000) => ({
		type: "assistant_text",
		content, // NOT `body`
		taskId: "T",
		ts,
		traceId: "tr",
		eid: eid(),
		parentEid: null,
	}),
	thinking: (thinking: string, ts = 1_775_000_000_000) => ({
		type: "thinking",
		provider: "anthropic",
		thinking, // NOT `body`, NOT `content`
		signature: "BASE64SIGNATUREBLOBshouldNeverBeSearched",
		taskId: "T",
		ts,
		traceId: "tr",
		eid: eid(),
		parentEid: null,
	}),
	toolCall: (
		tool: string,
		input: Record<string, unknown>,
		ts = 1_775_000_000_000,
	) => ({
		type: "tool_call",
		tool,
		toolCallId: "tc1",
		input, // no `body` anywhere on this event
		taskId: "T",
		ts,
		eid: eid(),
		parentEid: null,
	}),
	toolResult: (tool: string, content: string, ts = 1_775_000_000_000) => ({
		type: "tool_result",
		tool,
		toolCallId: "tc1",
		content,
		isError: false,
		taskId: "T",
		ts,
		eid: eid(),
		parentEid: null,
	}),
	usage: (ts = 1_775_000_000_000) => ({
		type: "usage",
		inputTokens: 100,
		outputTokens: 20,
		contextWindow: 200_000,
		taskId: "T",
		ts,
		eid: eid(),
		parentEid: null,
	}),
	messagesConsumed: (ts = 1_775_000_000_000) => ({
		type: "messages_consumed",
		messageIds: ["msg1"],
		taskId: "T",
		ts,
		eid: eid(),
		parentEid: null,
	}),
	/** Pre-eid history: measured, 3296 such events, newest 2026-04-16. */
	preEid: (content: string, ts = 1_774_000_000_000) => ({
		type: "assistant_text",
		content,
		taskId: "T",
		ts,
	}),
};

function writeLog(events: unknown[], extraLines: string[] = []): string {
	const dir = mkdtempSync(join(tmpdir(), "log-search-"));
	const file = join(dir, "T.jsonl");
	writeFileSync(
		file,
		`${[...events.map((e) => JSON.stringify(e)), ...extraLines].join("\n")}\n`,
	);
	return file;
}

const search = (file: string, opts: LogSearchOptions) =>
	searchTaskLog(file, opts);

const render = async (file: string, opts: LogSearchOptions) =>
	formatLogSearchResult(await search(file, opts), "T", opts.query);

// ── The fixture's own property ──

describe("the fixture can express the difference", () => {
	test("no single field name carries the text of every event kind", () => {
		// The guard on every test below. If a cleanup ever regularises these
		// shapes, this fails FIRST and names why — rather than leaving a suite
		// that is green against an implementation reading one field.
		const events = [
			ev.message("user", { content: "alpha" }),
			ev.assistantText("alpha"),
			ev.thinking("alpha"),
			ev.toolCall("bash", { command: "alpha" }),
		];
		const topLevelTextFields = events.map(
			(e) =>
				Object.entries(e).find(
					([k, v]) =>
						typeof v === "string" && v.includes("alpha") && k !== "type",
				)?.[0] ?? "(nested)",
		);
		expect(new Set(topLevelTextFields).size).toBeGreaterThan(1);
		expect(topLevelTextFields).toEqual([
			"(nested)",
			"content",
			"thinking",
			"(nested)",
		]);
	});
});

// ── Extraction across non-uniform shapes ──

describe("text extraction does not assume one field", () => {
	test("finds the same word in four different layouts", async () => {
		const file = writeLog([
			ev.message("user", { content: "the wombat decided" }),
			ev.assistantText("a wombat reply"),
			ev.thinking("wombat reasoning"),
			ev.toolCall("mcp__mxd__bash", { command: "echo wombat" }),
		]);
		const r = await search(file, { query: "wombat" });
		expect(r.matchingEvents).toBe(4);
		expect(r.hits.map((h) => h.field).sort()).toEqual([
			"body.content",
			"content",
			"input.command",
			"thinking",
		]);
	});

	test("a `body`-only implementation would find exactly one of them", async () => {
		// The mutation this suite exists to catch, stated as a measurement:
		// three of the four carry no `body` at all.
		const events = [
			ev.message("user", { content: "wombat" }),
			ev.assistantText("wombat"),
			ev.thinking("wombat"),
			ev.toolCall("bash", { command: "wombat" }),
		];
		const withBody = events.filter(
			(e) => (e as Record<string, unknown>).body !== undefined,
		);
		expect(withBody).toHaveLength(1);
	});

	test("identifiers and blobs are not text", () => {
		const leaves = extractTextLeaves(ev.thinking("real prose"));
		const paths = leaves.map((l) => l.path);
		expect(paths).toContain("thinking");
		expect(paths).not.toContain("signature"); // base64 blob
		expect(paths).not.toContain("eid");
		expect(paths).not.toContain("taskId");
	});

	test("a signature blob is never searchable", async () => {
		const file = writeLog([ev.thinking("prose")]);
		const r = await search(file, { query: "BASE64SIGNATUREBLOB" });
		expect(r.matchingEvents).toBe(0);
	});
});

// ── Kinds ──

describe("kinds", () => {
	test("a message's kind carries its source; a tool event's carries its tool", () => {
		expect(eventKind(ev.message("user", { content: "x" }))).toBe(
			"message:user",
		);
		expect(eventKind(ev.message("work_context", { content: "x" }))).toBe(
			"message:work_context",
		);
		expect(eventKind(ev.assistantText("x"))).toBe("assistant_text");
		expect(eventKind(ev.toolCall("mcp__mxd__bash", {}))).toBe(
			"tool_call:mcp__mxd__bash",
		);
	});

	test("an event with no type is named, not dropped", () => {
		expect(eventKind({ body: "x" })).toBe("(unknown)");
	});

	test("a bare group name selects every member", async () => {
		const file = writeLog([
			ev.message("user", { content: "shared" }),
			ev.message("task_message", { content: "shared" }),
			ev.assistantText("shared"),
		]);
		const r = await search(file, { query: "shared", kinds: ["message"] });
		expect(r.matchingEvents).toBe(2);
		expect(r.hits.map((h) => h.kind)).toEqual([
			"message:user",
			"message:task_message",
		]);
	});

	test("an exact kind selects only itself", async () => {
		const file = writeLog([
			ev.message("user", { content: "shared" }),
			ev.message("task_message", { content: "shared" }),
		]);
		const r = await search(file, { query: "shared", kinds: ["message:user"] });
		expect(r.matchingEvents).toBe(1);
	});
});

// ── The default exclusions, and the fact that they are DISCLOSED ──

describe("default exclusions are honest", () => {
	test("tool_result and work_context are not searched by default", async () => {
		const file = writeLog([
			ev.toolResult("bash", "needle in command output"),
			ev.message("work_context", { content: "needle inside copied memory.md" }),
			ev.assistantText("needle in a reply"),
		]);
		const r = await search(file, { query: "needle" });
		expect(r.matchingEvents).toBe(1);
		expect(r.hits[0]?.kind).toBe("assistant_text");
	});

	test("both are reachable when named — default-off is not off", async () => {
		const file = writeLog([
			ev.toolResult("bash", "needle in command output"),
			ev.message("work_context", { content: "needle inside copied memory.md" }),
		]);
		const r = await search(file, {
			query: "needle",
			kinds: ["tool_result", "message:work_context"],
		});
		expect(r.matchingEvents).toBe(2);
	});

	test("the header names what it did not search", async () => {
		// ⚠️ The load-bearing assertion of this file. A zero result and a result
		// that never looked are byte-identical without this line, and the wrong
		// one silently confirms whatever the caller already believed.
		const file = writeLog([ev.toolResult("bash", "needle")]);
		const out = await render(file, { query: "needle" });
		for (const kind of DEFAULT_EXCLUDED_KINDS) expect(out).toContain(kind);
		expect(out).toContain("NOT searched");
	});

	test("naming kinds explicitly means nothing is silently skipped", async () => {
		const file = writeLog([ev.assistantText("needle")]);
		const out = await render(file, {
			query: "needle",
			kinds: ["assistant_text"],
		});
		expect(out).not.toContain("NOT searched");
	});
});

// ── Under-report guards ──

describe("an absence always says which absence it is", () => {
	test("no session file is not the same answer as no matches", async () => {
		const out = formatLogSearchResult(
			await search(join(tmpdir(), "does-not-exist-9d8f7.jsonl"), {
				query: "x",
			}),
			"T",
			"x",
		);
		expect(out).toContain("never run");
		expect(out).toContain("NOT 'no matches'");
	});

	test("zero matches reports the kinds the file does hold", async () => {
		const file = writeLog([
			ev.message("user", { content: "hello" }),
			ev.assistantText("hi"),
		]);
		const out = await render(file, { query: "absent-term" });
		expect(out).toContain("No matches");
		expect(out).toContain("message:user 1");
		expect(out).toContain("assistant_text 1");
	});

	test("a malformed line is counted and reported, never silently dropped", async () => {
		// Measured: root's own 113MB session contains exactly one such line.
		const file = writeLog([ev.assistantText("needle")], ["{not json at all"]);
		const r = await search(file, { query: "needle" });
		expect(r.malformedLines).toBe(1);
		const out = formatLogSearchResult(r, "T", "needle");
		expect(out).toContain("could not be parsed");
	});

	test("matching runs on the FULL field, not on the excerpt", async () => {
		// Truncating before matching would lose every match past the cut and
		// report a confident zero. The match here sits far beyond the excerpt.
		const long = `${"x".padEnd(8000, "x")}needle${"y".padEnd(500, "y")}`;
		const file = writeLog([ev.assistantText(long)]);
		const r = await search(file, { query: "needle" });
		expect(r.matchingEvents).toBe(1);
		expect(r.hits[0]?.excerpt).toContain("needle");
		expect(r.hits[0]?.fieldChars).toBe(long.length);
	});

	test("counts cover the whole log even when hits are truncated", async () => {
		// The "how many times did we say X" use case survives truncation.
		const events = Array.from({ length: 50 }, (_, i) =>
			ev.assistantText(`needle ${i} needle`),
		);
		const r = await search(writeLog(events), { query: "needle", limit: 3 });
		expect(r.hits).toHaveLength(3);
		expect(r.matchingEvents).toBe(50);
		expect(r.totalMatches).toBe(100);
		expect(r.hitsTruncated).toBe(true);
	});
});

// ── The byte budget ──

describe("output is bounded by BYTES, never by event count", () => {
	test("a query matching everything still produces a bounded result", async () => {
		// The lesson of the 2026-07-15 incident, as an assertion: no query may
		// produce an unbounded tool result. 400 large events, all matching.
		const events = Array.from({ length: 400 }, () =>
			ev.assistantText(`needle ${"z".repeat(5000)}`),
		);
		const out = await render(writeLog(events), {
			query: "needle",
			limit: LOG_SEARCH_LIMITS.maxHits,
			context: LOG_SEARCH_LIMITS.maxContext,
		});
		expect(out.length).toBeLessThanOrEqual(LOG_SEARCH_LIMITS.totalChars);
		expect(out).toContain("output budget");
		expect(out).toContain("of 400 matching events shown");
	});

	test("one enormous event cannot blow the budget on its own", async () => {
		// MEASURED motivation: `get_logs(begin=0, end=2)` returns ~60KB because
		// event 1 is `work_context`; one `message:user` in root's session is
		// 1.68MB. Capping the number of events bounds nothing at all.
		const file = writeLog([
			ev.message("user", { content: `needle ${"q".repeat(2_000_000)}` }),
		]);
		const out = await render(file, { query: "needle" });
		expect(out.length).toBeLessThan(LOG_SEARCH_LIMITS.totalChars);
		expect(out).toContain("2,000,007 chars");
	});

	test("an excerpt that was cut says so, and says how much", async () => {
		const file = writeLog([
			ev.assistantText(`start needle ${"w".repeat(9000)}`),
		]);
		const r = await search(file, { query: "needle" });
		expect(r.hits[0]?.excerpt.length).toBeLessThanOrEqual(
			LOG_SEARCH_LIMITS.matchExcerptChars + 2,
		);
		expect(r.hits[0]?.excerpt).toContain("…");
		expect(r.hits[0]?.fieldChars).toBe(9013);
	});

	test("context excerpts are truncated too", async () => {
		const file = writeLog([
			ev.assistantText("A".repeat(5000)),
			ev.assistantText("needle"),
		]);
		const r = await search(file, { query: "needle", context: 1 });
		expect(r.hits[0]?.before[0]?.text.length).toBeLessThanOrEqual(
			LOG_SEARCH_LIMITS.contextExcerptChars + 1,
		);
	});

	test("limit and context are clamped, not trusted", async () => {
		const events = Array.from({ length: 300 }, () =>
			ev.assistantText("needle"),
		);
		const r = await search(writeLog(events), {
			query: "needle",
			limit: 100_000,
			context: 100,
		});
		expect(r.hits.length).toBeLessThanOrEqual(LOG_SEARCH_LIMITS.maxHits);
		expect(r.hits[10]?.before.length).toBeLessThanOrEqual(
			LOG_SEARCH_LIMITS.maxContext,
		);
	});
});

// ── Surrounding context ──

describe("context", () => {
	test("a hit carries the events either side of it", async () => {
		const file = writeLog([
			ev.message("user", { content: "the question" }),
			ev.assistantText("needle answer"),
			ev.message("user", { content: "the follow-up" }),
		]);
		const r = await search(file, { query: "needle", context: 1 });
		expect(r.hits[0]?.before[0]?.text).toBe("the question");
		expect(r.hits[0]?.after[0]?.text).toBe("the follow-up");
	});

	test("textless bookkeeping events are not context", async () => {
		// Measured on real output: without this, `usage` and `messages_consumed`
		// filled the context slots and rendered as `(no text)`.
		const file = writeLog([
			ev.message("user", { content: "the question" }),
			ev.usage(),
			ev.assistantText("needle answer"),
			ev.messagesConsumed(),
			ev.usage(),
			ev.message("user", { content: "the follow-up" }),
		]);
		const r = await search(file, { query: "needle", context: 1 });
		expect(r.hits[0]?.before[0]?.text).toBe("the question");
		expect(r.hits[0]?.after[0]?.text).toBe("the follow-up");
	});

	test("two adjacent matches are each other's context", async () => {
		// The first implementation fed trailing context only from NON-matching
		// events, so a cluster of hits rendered with nothing after it.
		const file = writeLog([
			ev.assistantText("needle one"),
			ev.assistantText("needle two"),
		]);
		const r = await search(file, { query: "needle", context: 1 });
		expect(r.hits[0]?.after[0]?.text).toBe("needle two");
		expect(r.hits[1]?.before[0]?.text).toBe("needle one");
	});

	test("an event is never its own context", async () => {
		const file = writeLog([ev.assistantText("needle alone")]);
		const r = await search(file, { query: "needle", context: 2 });
		expect(r.hits[0]?.after).toEqual([]);
		expect(r.hits[0]?.before).toEqual([]);
	});

	test("context text is the longest field, not the first", async () => {
		// A tool_call's first leaf is the tool NAME; the command is what matters.
		const file = writeLog([
			ev.toolCall("mcp__mxd__bash", { command: "git log --oneline -20" }),
			ev.assistantText("needle"),
		]);
		const r = await search(file, { query: "needle", context: 1 });
		expect(r.hits[0]?.before[0]?.text).toBe("git log --oneline -20");
	});

	test("context=0 returns none", async () => {
		const file = writeLog([
			ev.assistantText("before"),
			ev.assistantText("needle"),
			ev.assistantText("after"),
		]);
		const r = await search(file, { query: "needle", context: 0 });
		expect(r.hits[0]?.before).toEqual([]);
		expect(r.hits[0]?.after).toEqual([]);
	});
});

// ── Identity ──

describe("hits are named by eid, and the pre-eid half is named as such", () => {
	test("a stamped event renders its eid", async () => {
		const file = writeLog([ev.assistantText("needle")]);
		const out = await render(file, { query: "needle" });
		expect(out).toMatch(/eid=[0-9a-f]{12}/);
	});

	test("an unstamped event is still returned", async () => {
		// MEASURED: 3296 of 397,771 events carry no eid, newest 2026-04-16 —
		// and they are the OLDEST history, which is what this tool reaches for.
		// The motivating find is a 2026-04-05 event, inside that window.
		const file = writeLog([ev.preEid("needle from before stamping")]);
		const r = await search(file, { query: "needle" });
		expect(r.matchingEvents).toBe(1);
		expect(r.hits[0]?.eid).toBeUndefined();
	});

	test("no `eid=` token is emitted for an unstamped event", async () => {
		// ⚠️ Structural, not typographic. Anything parsing for `eid=([0-9a-f]+)`
		// must find NOTHING rather than capture a placeholder that reads like a
		// real name. Same migration rule as the `Task-Id:` commit trailer: a
		// missing identifier may never be presented as a real one.
		const file = writeLog([ev.preEid("needle from before stamping")]);
		const out = await render(file, { query: "needle" });
		expect(out).toContain("predates eid stamping");
		expect(out.includes("eid=")).toBe(false);
	});

	test("nothing positional appears in the output", async () => {
		// `.mxd/memory.md`: "Nothing in this codebase may address an event by
		// file position." A rollback moves the chain head, so an index means
		// different things before and after it while an eid never does.
		const file = writeLog([
			ev.assistantText("filler one"),
			ev.assistantText("needle"),
		]);
		const out = await render(file, { query: "needle", context: 1 });
		expect(out).not.toMatch(/\bline \d+/i);
		expect(out).not.toMatch(/\b(offset|cursor|index)\b/i);
	});
});

// ── Query semantics ──

describe("query is a regular expression", () => {
	test("alternation works — the counting use case", async () => {
		const file = writeLog([
			ev.assistantText("a unified and simplified approach"),
			ev.assistantText("nothing here"),
		]);
		const r = await search(file, { query: "unified|simplified" });
		expect(r.totalMatches).toBe(2);
		expect(r.matchingEvents).toBe(1);
	});

	test("case sensitivity is opt-in", async () => {
		const file = writeLog([ev.assistantText("Widget")]);
		expect((await search(file, { query: "widget" })).matchingEvents).toBe(0);
		expect(
			(await search(file, { query: "widget", caseInsensitive: true }))
				.matchingEvents,
		).toBe(1);
	});

	test("an invalid pattern throws rather than returning a confident zero", async () => {
		const file = writeLog([ev.assistantText("x")]);
		await expect(search(file, { query: "(unclosed" })).rejects.toThrow();
	});

	test("a zero-length match terminates", async () => {
		// `x*` matches the empty string at every position; a naive exec loop
		// never advances and hangs the agent that called it.
		const file = writeLog([ev.assistantText("abc")]);
		const r = await search(file, { query: "q*" });
		expect(r.totalMatches).toBeGreaterThan(0);
		expect(r.hits).toHaveLength(1);
	});

	test("CJK matches without any escaping", async () => {
		// The motivating query was literally a Chinese phrase.
		const file = writeLog([
			ev.message("user", { content: "我记得之前做过这个优化" }),
		]);
		const r = await search(file, { query: "我记得" });
		expect(r.matchingEvents).toBe(1);
		expect(r.hits[0]?.excerpt).toContain("我记得");
	});
});

// ── Rendering ──

describe("rendering", () => {
	test("every hit carries an absolute stamp and a relative age", async () => {
		// Agents are date-blind and confidently so; one read a 8-day gap as 80
		// minutes. The absolute form travels to other logs, the relative one
		// answers "does this still count".
		const file = writeLog([ev.assistantText("needle", 1_775_000_000_000)]);
		const out = formatLogSearchResult(
			await search(file, { query: "needle" }),
			"T",
			"needle",
			1_775_000_000_000 + 86_400_000 * 3,
		);
		expect(out).toContain("2026-03-31T");
		expect(out).toContain("(3d)");
	});

	test("the header states matching events and total matches separately", async () => {
		const file = writeLog([ev.assistantText("needle needle")]);
		const out = await render(file, { query: "needle" });
		expect(out).toContain("1 matching event");
		expect(out).toContain("2 matches in total");
	});

	test("the header states how many events the filter removed", async () => {
		const file = writeLog([
			ev.assistantText("needle"),
			ev.toolResult("bash", "not searched"),
			ev.toolResult("bash", "not searched either"),
		]);
		const out = await render(file, { query: "needle" });
		expect(out).toContain("searched 1 of 3 events");
	});
});
