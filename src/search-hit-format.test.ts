/**
 * Unit tests for the shared hit-identity primitives — the vocabulary all three
 * rendering surfaces are built from.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectTasksDir } from "./data-paths.ts";
import {
	createExecutionProbe,
	dateWithAge,
	dedupeHitsByTask,
	inMemoryExecutionProbe,
	matchedFieldLabel,
	relativeAge,
	statusTag,
	taskAges,
} from "./search-hit-format.ts";
import type { SearchHit } from "./task-index.ts";
import { TaskTracker } from "./task-tracker.ts";

const DAY = 86_400_000;

describe("relativeAge / dateWithAge", () => {
	const now = Date.parse("2026-07-27T12:00:00.000Z");
	const ago = (ms: number) => new Date(now - ms).toISOString();

	test("buckets: hours, days, months, years", () => {
		expect(relativeAge(ago(5 * 60_000), now)).toBe("just now");
		expect(relativeAge(ago(5 * 3_600_000), now)).toBe("5h");
		expect(relativeAge(ago(3 * DAY), now)).toBe("3d");
		expect(relativeAge(ago(29 * DAY), now)).toBe("29d");
		expect(relativeAge(ago(30 * DAY), now)).toBe("1mo");
		expect(relativeAge(ago(117 * DAY), now)).toBe("4mo");
		expect(relativeAge(ago(400 * DAY), now)).toBe("1y");
	});

	test("dateWithAge pairs the absolute date with the age", () => {
		// The real case from a root session: a task filed 2026-04-01, read on
		// 2026-07-27 as if it were outstanding work.
		expect(dateWithAge("2026-04-01T09:00:00.000Z", now)).toBe(
			"2026-04-01 (4mo ago)",
		);
	});

	test("a malformed timestamp says so rather than rendering garbage", () => {
		expect(relativeAge("not-a-date", now)).toBe("?");
		expect(dateWithAge("not-a-date", now)).toBe("unknown");
	});
});

describe("statusTag", () => {
	let tempDir: string;
	let tracker: TaskTracker;
	const ran = () => true;
	const neverRan = () => false;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-hit-id-"));
		tracker = new TaskTracker(join(tempDir, "tree.json"));
		await tracker.load();
	});
	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("terminal statuses carry the execution marker, both ways", () => {
		const t = tracker.addChild(tracker.rootNodeId, "T", "d");
		tracker.updateStatus(t.id, "closed");
		expect(statusTag(tracker.getTask(t.id)!, ran)).toBe("[closed · ran]");
		expect(statusTag(tracker.getTask(t.id)!, neverRan)).toBe(
			"[closed · never ran]",
		);
		tracker.updateStatus(t.id, "failed");
		expect(statusTag(tracker.getTask(t.id)!, neverRan)).toBe(
			"[failed · never ran]",
		);
	});

	test("live statuses carry no marker — the question is still open", () => {
		const t = tracker.addChild(tracker.rootNodeId, "T", "d");
		for (const s of ["draft", "pending", "in_progress", "verify"] as const) {
			tracker.updateStatus(t.id, s);
			// The probe would answer true, and it must still not be rendered.
			expect(statusTag(tracker.getTask(t.id)!, ran)).toBe(`[${s}]`);
		}
	});

	test("the tag LEADS the line it is put in — status must not lose to the body", () => {
		const t = tracker.addChild(tracker.rootNodeId, "T", "d");
		tracker.updateStatus(t.id, "closed");
		expect(statusTag(tracker.getTask(t.id)!, ran).startsWith("[")).toBe(true);
	});
});

describe("taskAges", () => {
	let tempDir: string;
	let tracker: TaskTracker;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-hit-age-"));
		tracker = new TaskTracker(join(tempDir, "tree.json"));
		await tracker.load();
	});
	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("renders both dates, and labels updatedAt as a RECORD touch", () => {
		const now = Date.parse("2026-07-27T12:00:00.000Z");
		const t = tracker.addChild(tracker.rootNodeId, "T", "d");
		const node = tracker.getTask(t.id)!;
		node.createdAt = "2026-04-01T09:00:00.000Z";
		node.updatedAt = "2026-07-13T09:00:00.000Z";

		expect(taskAges(node, now)).toBe(
			"created 2026-04-01 (4mo ago) · record touched 2026-07-13 (14d ago)",
		);
	});

	/**
	 * ⚠️ Contract test, not a scenario. `updatedAt` is bumped by 16 call sites
	 * and only 3 of them touch content, so any label promising that WORK
	 * happened at that moment is a wrong number wearing authority. This asserts
	 * the wording because the wording is the entire fix — the field itself was
	 * always renderable.
	 */
	test("updatedAt is never labelled as work / activity", () => {
		const t = tracker.addChild(tracker.rootNodeId, "T", "d");
		const rendered = taskAges(tracker.getTask(t.id)!);
		for (const lie of [
			"last active",
			"last worked",
			"last activity",
			"updated",
			"modified",
		])
			expect(rendered.toLowerCase()).not.toContain(lie);
		// Positive control: the same string DOES carry both timestamps, so the
		// negative assertions above are about the label and not about an empty
		// render that would pass them all.
		expect(rendered).toContain("created ");
		expect(rendered).toContain("record touched ");
	});

	test("creating a CHILD bumps the parent's record touch — the reason for the label", () => {
		const parent = tracker.addChild(tracker.rootNodeId, "Parent", "d");
		const node = tracker.getTask(parent.id)!;
		node.createdAt = "2026-04-01T09:00:00.000Z";
		node.updatedAt = "2026-04-01T09:00:00.000Z";

		tracker.addChild(parent.id, "Child", "d");

		// The parent did no work; its record moved anyway.
		expect(tracker.getTask(parent.id)!.updatedAt).not.toBe(
			"2026-04-01T09:00:00.000Z",
		);
		expect(tracker.getTask(parent.id)!.createdAt).toBe(
			"2026-04-01T09:00:00.000Z",
		);
	});
});

describe("createExecutionProbe — the union of three one-directional signals", () => {
	let tempDir: string;
	let tracker: TaskTracker;
	const projectId = "proj1";

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-hit-exec-"));
		tracker = new TaskTracker(join(tempDir, "tree.json"));
		await tracker.load();
		mkdirSync(projectTasksDir(tempDir, projectId), { recursive: true });
	});
	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	const probe = () => createExecutionProbe(tempDir, projectId);

	test("no signal at all → never ran", () => {
		const t = tracker.addChild(tracker.rootNodeId, "T", "d");
		expect(probe()(tracker.getTask(t.id)!)).toBe(false);
	});

	test("resultRounds ALONE → ran", () => {
		const t = tracker.addChild(tracker.rootNodeId, "T", "d");
		tracker.appendResultRound(t.id, { result: "did the thing" });
		expect(probe()(tracker.getTask(t.id)!)).toBe(true);
	});

	test("costUsd ALONE → ran (a session that spent but never reported)", () => {
		const t = tracker.addChild(tracker.rootNodeId, "T", "d");
		tracker.updateCost(t.id, 0.02);
		expect(probe()(tracker.getTask(t.id)!)).toBe(true);
	});

	test("session JSONL ALONE → ran (launched, died before cost or done())", async () => {
		const t = tracker.addChild(tracker.rootNodeId, "T", "d");
		await writeFile(
			join(projectTasksDir(tempDir, projectId), `${t.id}.jsonl`),
			'{"type":"agent_start"}\n',
		);
		expect(probe()(tracker.getTask(t.id)!)).toBe(true);
	});

	/**
	 * ⚠️ The measurement that chose the union. On this repo's tree (2026-07-27)
	 * 365 of the 417 closed tasks that had demonstrably run carried no result
	 * round, because the field postdates them. A probe keyed on rounds alone
	 * calls all of those "never ran" — the single worst answer available, since
	 * it relabels finished work as an unexecuted proposal.
	 */
	test("rounds-only would be wrong where the union is right", () => {
		const t = tracker.addChild(tracker.rootNodeId, "Old finished task", "d");
		tracker.updateCost(t.id, 1.5);
		const node = tracker.getTask(t.id)!;
		expect((node.resultRounds?.length ?? 0) > 0).toBe(false);
		expect(probe()(node)).toBe(true);
	});

	test("the JSONL lookup is per-task, not 'any file exists'", async () => {
		const mine = tracker.addChild(tracker.rootNodeId, "Mine", "d");
		const other = tracker.addChild(tracker.rootNodeId, "Other", "d");
		await writeFile(
			join(projectTasksDir(tempDir, projectId), `${other.id}.jsonl`),
			"{}\n",
		);
		expect(probe()(tracker.getTask(mine.id)!)).toBe(false);
		expect(probe()(tracker.getTask(other.id)!)).toBe(true);
	});

	test("inMemoryExecutionProbe is the weaker one, and visibly so", async () => {
		const t = tracker.addChild(tracker.rootNodeId, "T", "d");
		await writeFile(
			join(projectTasksDir(tempDir, projectId), `${t.id}.jsonl`),
			"{}\n",
		);
		const node = tracker.getTask(t.id)!;
		expect(probe()(node)).toBe(true);
		expect(inMemoryExecutionProbe(node)).toBe(false);
	});
});

describe("dedupeHitsByTask", () => {
	const hit = (taskId: string, field: string, score: number): SearchHit => ({
		taskId,
		field,
		snippet: `${field} snippet`,
		score,
	});

	test("one entry per task, best-ranked hit kept, field labels merged", () => {
		const out = dedupeHitsByTask([
			hit("A", "description", 0.92),
			hit("B", "title", 0.8),
			hit("A", "title", 0.5),
		]);
		expect(out.length).toBe(2);
		expect(out[0]!.taskId).toBe("A");
		expect(out[0]!.fields).toEqual(["description", "title"]);
		// The best hit's own snippet and score survive, not the duplicate's.
		expect(out[0]!.score).toBe(0.92);
		expect(out[0]!.snippet).toBe("description snippet");
		expect(out[1]!.fields).toEqual(["title"]);
	});

	test("result rounds keep their round index in the merged label", () => {
		const out = dedupeHitsByTask([
			{ taskId: "A", field: "result", roundIndex: 2, snippet: "s", score: 0.9 },
			{ taskId: "A", field: "result", roundIndex: 5, snippet: "s", score: 0.4 },
		]);
		expect(out[0]!.fields).toEqual(["result round 2", "result round 5"]);
	});

	test("an identical label is not repeated", () => {
		const out = dedupeHitsByTask([
			hit("A", "description", 0.9),
			hit("A", "description", 0.4),
		]);
		expect(out[0]!.fields).toEqual(["description"]);
	});

	test("rank order is preserved", () => {
		const out = dedupeHitsByTask([
			hit("A", "title", 0.9),
			hit("B", "title", 0.8),
			hit("C", "title", 0.7),
		]);
		expect(out.map((h) => h.taskId)).toEqual(["A", "B", "C"]);
	});

	test("matchedFieldLabel: round index only for result hits", () => {
		expect(matchedFieldLabel({ field: "description" })).toBe("description");
		expect(matchedFieldLabel({ field: "result", roundIndex: 0 })).toBe(
			"result round 0",
		);
		expect(matchedFieldLabel({ field: "result" })).toBe("result");
	});
});
