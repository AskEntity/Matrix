/**
 * Unit tests for formatTieredHits — the shared formatter used by both
 * search_tasks and create_task's related-tasks appendix.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatTieredHits, searchTasks } from "./orchestrator-tools.ts";
import type { ExecutionProbe } from "./search-hit-format.ts";
import {
	_clearDbCache,
	_setEmbeddingPipeline,
	reconcileIndex,
} from "./task-index.ts";
import { TaskTracker } from "./task-tracker.ts";

/**
 * Execution probes as fixtures. The real one reads the filesystem; these two
 * pin the two answers so a test can state which case it is exercising instead
 * of arranging evidence on disk. `createExecutionProbe` itself is covered in
 * search-hit-format.test.ts.
 */
const ranProbe: ExecutionProbe = () => true;
const neverRanProbe: ExecutionProbe = () => false;

describe("formatTieredHits", () => {
	let tempDir: string;
	let tracker: TaskTracker;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-search-fmt-"));
		tracker = new TaskTracker(join(tempDir, "tree.json"));
		await tracker.load();
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("full hits include description, latest result, matched field, score", () => {
		const child = tracker.addChild(
			tracker.rootNodeId,
			"Fix session recovery",
			"Implemented the frobnicator cache via a ring buffer",
		);
		tracker.updateStatus(child.id, "closed");
		tracker.appendResultRound(child.id, {
			result: "Fixed cache invalidation bug by switching to LRU eviction",
		});

		const hits = [
			{
				taskId: child.id,
				field: "description",
				snippet: "frobnicator cache via a ring buffer",
				score: 0.85,
			},
		];

		const result = formatTieredHits(hits, tracker, 1, ranProbe);
		expect(result).toContain("Fix session recovery");
		expect(result).toContain("closed");
		expect(result).toContain("Description:");
		expect(result).toContain("frobnicator cache");
		expect(result).toContain("Latest result:");
		expect(result).toContain("LRU eviction");
		expect(result).toContain("Matched: description");
		expect(result).toContain("Score: 0.85");
	});

	test("brief hits show only title, full taskId, status, score", () => {
		const child = tracker.addChild(
			tracker.rootNodeId,
			"Debug JSONL repair",
			"investigated JSONL corruption scenarios in detail",
		);
		tracker.updateStatus(child.id, "closed");
		tracker.appendResultRound(child.id, {
			result: "Fixed the repair logic for compacted sessions",
		});

		const hits = [
			{
				taskId: child.id,
				field: "description",
				snippet: "JSONL corruption scenarios",
				score: 0.42,
			},
		];

		// fullCount=0 → all hits are brief.
		const result = formatTieredHits(hits, tracker, 0, ranProbe);
		expect(result).toContain("Debug JSONL repair");
		expect(result).toContain("closed");
		expect(result).toContain("score: 0.42");
		// Brief hits should NOT contain description or result text.
		expect(result).not.toContain("Description:");
		expect(result).not.toContain("Latest result:");
		expect(result).not.toContain("Matched:");
	});

	test("mixed full + brief hits in correct order", () => {
		const task1 = tracker.addChild(
			tracker.rootNodeId,
			"Alpha task",
			"alpha description",
		);
		tracker.updateStatus(task1.id, "verify");
		const task2 = tracker.addChild(
			tracker.rootNodeId,
			"Beta task",
			"beta description",
		);
		tracker.updateStatus(task2.id, "closed");

		const hits = [
			{ taskId: task1.id, field: "title", snippet: "Alpha task", score: 0.9 },
			{ taskId: task2.id, field: "title", snippet: "Beta task", score: 0.5 },
		];

		// fullCount=1 → first hit is full, second is brief.
		const result = formatTieredHits(hits, tracker, 1, ranProbe);
		// Full hit has "Description:" and "Score:"
		expect(result).toContain("Description:");
		expect(result).toContain("Score: 0.90");
		// Brief hit has "score:" (lowercase in the "— score:" format)
		expect(result).toContain("score: 0.50");
	});

	test("header is prepended when provided", () => {
		const task = tracker.addChild(tracker.rootNodeId, "Some task", "desc");
		tracker.updateStatus(task.id, "closed");

		const hits = [
			{ taskId: task.id, field: "title", snippet: "Some task", score: 0.7 },
		];

		const result = formatTieredHits(
			hits,
			tracker,
			1,
			ranProbe,
			"[Related existing tasks]",
		);
		expect(result.startsWith("[Related existing tasks]")).toBe(true);
	});

	test("returns empty string when no live tasks match", () => {
		// Hit references a non-existent task.
		const hits = [
			{
				taskId: "nonexistent-id-12345",
				field: "title",
				snippet: "ghost",
				score: 0.9,
			},
		];
		const result = formatTieredHits(hits, tracker, 1, ranProbe);
		expect(result).toBe("");
	});

	test("description truncated at 500 chars", () => {
		const longDesc = "x".repeat(1000);
		const task = tracker.addChild(
			tracker.rootNodeId,
			"Long desc task",
			longDesc,
		);
		tracker.updateStatus(task.id, "closed");

		const hits = [
			{
				taskId: task.id,
				field: "title",
				snippet: "Long desc task",
				score: 0.8,
			},
		];

		const result = formatTieredHits(hits, tracker, 1, ranProbe);
		// The description in the output should be at most 500 chars.
		const descMatch = result.match(/Description: "([^"]*)"/);
		expect(descMatch).toBeDefined();
		expect(descMatch![1]!.length).toBeLessThanOrEqual(500);
	});

	test("result truncated at 300 chars", () => {
		const task = tracker.addChild(
			tracker.rootNodeId,
			"Long result task",
			"short desc",
		);
		tracker.updateStatus(task.id, "closed");
		tracker.appendResultRound(task.id, { result: "y".repeat(600) });

		const hits = [
			{
				taskId: task.id,
				field: "title",
				snippet: "Long result task",
				score: 0.8,
			},
		];

		const result = formatTieredHits(hits, tracker, 1, ranProbe);
		const resultMatch = result.match(/Latest result: "([^"]*)"/);
		expect(resultMatch).toBeDefined();
		expect(resultMatch![1]!.length).toBeLessThanOrEqual(300);
	});

	test("total output capped at 8000 chars — stops appending entries", () => {
		// Create many tasks with long descriptions to blow the budget.
		const tasks = [];
		for (let i = 0; i < 30; i++) {
			const t = tracker.addChild(
				tracker.rootNodeId,
				`Task number ${i}`,
				"d".repeat(400),
			);
			tracker.updateStatus(t.id, "closed");
			tracker.appendResultRound(t.id, { result: "r".repeat(250) });
			tasks.push(t);
		}

		const hits = tasks.map((t, i) => ({
			taskId: t.id,
			field: "title" as const,
			snippet: `Task number ${i}`,
			score: 1 - i * 0.01,
		}));

		// All 30 as full hits — should stop before all 30 fit.
		const result = formatTieredHits(hits, tracker, 30, ranProbe);
		expect(result.length).toBeLessThanOrEqual(8000);
		// But should have SOME entries.
		expect(result).toContain("Task number 0");
		// The last ones should be cut off.
		expect(result).not.toContain("Task number 29");
	});

	// ── Identity: every tier answers what the task IS before its body is read ──

	test("the entry LEADS with status, ahead of the title and the body", () => {
		const t = tracker.addChild(
			tracker.rootNodeId,
			"A title long enough to push a trailing status off to the right margin",
			"# GOAL … a description that reads like a conclusion",
		);
		tracker.updateStatus(t.id, "draft");
		const hits = [
			{ taskId: t.id, field: "description", snippet: "GOAL", score: 0.9 },
		];

		const result = formatTieredHits(hits, tracker, 1, neverRanProbe);
		expect(result.startsWith("- [draft] ")).toBe(true);
		// And it is genuinely ahead of both the title and the description.
		expect(result.indexOf("[draft]")).toBeLessThan(result.indexOf("A title"));
		expect(result.indexOf("[draft]")).toBeLessThan(
			result.indexOf("Description:"),
		);
	});

	test("closed splits on whether it ever ran — the two must not render alike", () => {
		const t = tracker.addChild(tracker.rootNodeId, "Some task", "desc");
		tracker.updateStatus(t.id, "closed");
		const hits = [
			{ taskId: t.id, field: "title", snippet: "Some task", score: 0.9 },
		];

		expect(formatTieredHits(hits, tracker, 1, ranProbe)).toContain(
			"[closed · ran]",
		);
		expect(formatTieredHits(hits, tracker, 1, neverRanProbe)).toContain(
			"[closed · never ran]",
		);
	});

	test("both dates ride on full AND brief entries", () => {
		const t = tracker.addChild(tracker.rootNodeId, "Dated task", "desc");
		tracker.updateStatus(t.id, "closed");
		const node = tracker.getTask(t.id)!;
		node.createdAt = "2026-04-01T09:00:00.000Z";
		node.updatedAt = "2026-07-13T09:00:00.000Z";
		const hits = [
			{ taskId: t.id, field: "title", snippet: "Dated task", score: 0.9 },
		];

		for (const fullCount of [1, 0]) {
			const out = formatTieredHits(hits, tracker, fullCount, ranProbe);
			expect(out).toContain("created 2026-04-01 (");
			expect(out).toContain("record touched 2026-07-13 (");
		}
	});

	/**
	 * ⚠️ The brief tier is the one a reader SCANS, so it is where an unlabelled
	 * old proposal is most likely to be taken for live work. Brevity may cost
	 * the excerpts; it may not cost the identity.
	 */
	test("a brief entry keeps status + execution + id, and drops only the excerpts", () => {
		const t = tracker.addChild(tracker.rootNodeId, "Brief task", "the desc");
		tracker.updateStatus(t.id, "closed");
		const hits = [
			{ taskId: t.id, field: "title", snippet: "Brief task", score: 0.42 },
		];

		const out = formatTieredHits(hits, tracker, 0, neverRanProbe);
		expect(out).toContain("[closed · never ran]");
		expect(out).toContain(t.id);
		expect(out).toContain("created ");
		expect(out).toContain("score: 0.42");
		expect(out).not.toContain("Description:");
	});

	// ── Dedup ──

	test("one task matching several fields collapses to ONE entry", () => {
		const t = tracker.addChild(tracker.rootNodeId, "Scroll bug", "follow mode");
		tracker.updateStatus(t.id, "closed");
		const hits = [
			{
				taskId: t.id,
				field: "description",
				snippet: "follow mode",
				score: 0.9,
			},
			{ taskId: t.id, field: "title", snippet: "Scroll bug", score: 0.6 },
		];

		const out = formatTieredHits(hits, tracker, 5, ranProbe);
		// One entry: the bullet appears once, and so does the description body
		// that used to be repeated verbatim.
		expect(out.split("\n").filter((l) => l.startsWith("- [")).length).toBe(1);
		expect(out.split("Description:").length - 1).toBe(1);
		// The extra match is kept as evidence, not discarded.
		expect(out).toContain("Matched: description, title");
	});

	/**
	 * ⚠️ Dedup must run BEFORE the tier split. Measured on a real
	 * search_tasks(limit 6): three tasks filled all six slots, one of them
	 * appearing once as a full entry and once as a brief one. Deduping after
	 * the split leaves the slot arithmetic running on duplicates.
	 */
	test("dedup runs before the tier split — a duplicate cannot eat the second full slot", () => {
		const a = tracker.addChild(tracker.rootNodeId, "Alpha", "alpha desc");
		const b = tracker.addChild(tracker.rootNodeId, "Beta", "beta desc");
		tracker.updateStatus(a.id, "closed");
		tracker.updateStatus(b.id, "closed");
		const hits = [
			{ taskId: a.id, field: "description", snippet: "alpha desc", score: 0.9 },
			{ taskId: a.id, field: "title", snippet: "Alpha", score: 0.8 },
			{ taskId: b.id, field: "description", snippet: "beta desc", score: 0.7 },
		];

		// Two FULL slots for two distinct tasks: Beta must get the second one,
		// not be demoted to brief by Alpha's duplicate.
		const out = formatTieredHits(hits, tracker, 2, ranProbe);
		expect(out.split("\n").filter((l) => l.startsWith("- [")).length).toBe(2);
		expect(out).toContain("alpha desc");
		expect(out).toContain("beta desc");
		expect(out.split("Description:").length - 1).toBe(2);
	});

	test("a hit whose task left the tree does not consume a full slot either", () => {
		const live = tracker.addChild(tracker.rootNodeId, "Live", "live desc");
		tracker.updateStatus(live.id, "closed");
		const hits = [
			{ taskId: "gone-task-id", field: "title", snippet: "ghost", score: 0.99 },
			{
				taskId: live.id,
				field: "description",
				snippet: "live desc",
				score: 0.5,
			},
		];

		const out = formatTieredHits(hits, tracker, 1, ranProbe);
		// The one full slot goes to the only renderable task.
		expect(out).toContain("Description:");
		expect(out).toContain("live desc");
	});

	test("result from latest round only (not older rounds)", () => {
		const task = tracker.addChild(
			tracker.rootNodeId,
			"Multi-round task",
			"desc",
		);
		tracker.updateStatus(task.id, "closed");
		tracker.appendResultRound(task.id, { result: "old round result" });
		tracker.appendResultRound(task.id, { result: "latest round result" });

		const hits = [
			{
				taskId: task.id,
				field: "title",
				snippet: "Multi-round task",
				score: 0.9,
			},
		];

		const result = formatTieredHits(hits, tracker, 1, ranProbe);
		expect(result).toContain("latest round result");
		expect(result).not.toContain("old round result");
	});
});

describe("searchTasks", () => {
	let tempDir: string;
	let tracker: TaskTracker;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-search-fn-"));
		tracker = new TaskTracker(join(tempDir, "tree.json"));
		await tracker.load();
		_setEmbeddingPipeline(null);
	});

	afterEach(async () => {
		_clearDbCache();
		_setEmbeddingPipeline(null);
		await rm(tempDir, { recursive: true, force: true });
	});

	test("combines search + format + excludeId in one call", async () => {
		const task1 = tracker.addChild(
			tracker.rootNodeId,
			"Auth token rotation",
			"rotate JWT tokens",
		);
		tracker.updateStatus(task1.id, "closed");
		const task2 = tracker.addChild(
			tracker.rootNodeId,
			"Auth session fix",
			"fix session bugs",
		);
		tracker.updateStatus(task2.id, "verify");
		await tracker.save();

		const dbPath = join(tempDir, "index.msp");
		await reconcileIndex(dbPath, tracker);

		const result = await searchTasks(dbPath, "auth token", tracker, ranProbe, {
			fullCount: 1,
			briefCount: 5,
			excludeId: task2.id,
		});
		// task1 should be in the output (matches "auth token").
		expect(result).toContain("Auth token rotation");
		expect(result).toContain("closed");
		// task2 is excluded.
		expect(result).not.toContain("Auth session fix");
	});

	test("returns empty string for empty query", async () => {
		const result = await searchTasks(
			join(tempDir, "index.msp"),
			"  ",
			tracker,
			ranProbe,
		);
		expect(result).toBe("");
	});

	test("returns empty string when index is not loaded", async () => {
		// No reconcileIndex called — dbCache is empty.
		const result = await searchTasks(
			join(tempDir, "index.msp"),
			"anything",
			tracker,
			ranProbe,
		);
		expect(result).toBe("");
	});

	test("respects header option", async () => {
		const task = tracker.addChild(
			tracker.rootNodeId,
			"Auth session recovery",
			"fix the auth session timeout",
		);
		tracker.updateStatus(task.id, "closed");
		await tracker.save();

		const dbPath = join(tempDir, "index.msp");
		await reconcileIndex(dbPath, tracker);

		const result = await searchTasks(
			dbPath,
			"auth session",
			tracker,
			ranProbe,
			{
				header: "[Related]",
			},
		);
		expect(result.startsWith("[Related]")).toBe(true);
		expect(result).toContain("Auth session recovery");
	});
});
