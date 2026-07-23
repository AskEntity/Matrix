/**
 * Unit tests for formatTieredHits — the shared formatter used by both
 * search_tasks and create_task's related-tasks appendix.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { formatTieredHits } from "./orchestrator-tools.ts";
import { TaskTracker } from "./task-tracker.ts";

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
		(child as Record<string, unknown>).status = "closed";
		(child as Record<string, unknown>).resultRounds = [
			{ result: "Fixed cache invalidation bug by switching to LRU eviction" },
		];

		const hits = [
			{
				taskId: child.id,
				field: "description",
				snippet: "frobnicator cache via a ring buffer",
				score: 0.85,
			},
		];

		const result = formatTieredHits(hits, tracker, 1);
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
		(child as Record<string, unknown>).status = "closed";
		(child as Record<string, unknown>).resultRounds = [
			{ result: "Fixed the repair logic for compacted sessions" },
		];

		const hits = [
			{
				taskId: child.id,
				field: "description",
				snippet: "JSONL corruption scenarios",
				score: 0.42,
			},
		];

		// fullCount=0 → all hits are brief.
		const result = formatTieredHits(hits, tracker, 0);
		expect(result).toContain("Debug JSONL repair");
		expect(result).toContain("closed");
		expect(result).toContain("score: 0.42");
		// Brief hits should NOT contain description or result text.
		expect(result).not.toContain("Description:");
		expect(result).not.toContain("Latest result:");
		expect(result).not.toContain("Matched:");
	});

	test("mixed full + brief hits in correct order", () => {
		const task1 = tracker.addChild(tracker.rootNodeId, "Alpha task", "alpha description");
		(task1 as Record<string, unknown>).status = "verify";
		const task2 = tracker.addChild(tracker.rootNodeId, "Beta task", "beta description");
		(task2 as Record<string, unknown>).status = "closed";

		const hits = [
			{ taskId: task1.id, field: "title", snippet: "Alpha task", score: 0.9 },
			{ taskId: task2.id, field: "title", snippet: "Beta task", score: 0.5 },
		];

		// fullCount=1 → first hit is full, second is brief.
		const result = formatTieredHits(hits, tracker, 1);
		// Full hit has "Description:" and "Score:"
		expect(result).toContain("Description:");
		expect(result).toContain("Score: 0.90");
		// Brief hit has "score:" (lowercase in the "— score:" format)
		expect(result).toContain("score: 0.50");
	});

	test("header is prepended when provided", () => {
		const task = tracker.addChild(tracker.rootNodeId, "Some task", "desc");
		(task as Record<string, unknown>).status = "closed";

		const hits = [
			{ taskId: task.id, field: "title", snippet: "Some task", score: 0.7 },
		];

		const result = formatTieredHits(hits, tracker, 1, "[Related existing tasks]");
		expect(result.startsWith("[Related existing tasks]")).toBe(true);
	});

	test("returns empty string when no live tasks match", () => {
		// Hit references a non-existent task.
		const hits = [
			{ taskId: "nonexistent-id-12345", field: "title", snippet: "ghost", score: 0.9 },
		];
		const result = formatTieredHits(hits, tracker, 1);
		expect(result).toBe("");
	});

	test("description truncated at 500 chars", () => {
		const longDesc = "x".repeat(1000);
		const task = tracker.addChild(tracker.rootNodeId, "Long desc task", longDesc);
		(task as Record<string, unknown>).status = "closed";

		const hits = [
			{ taskId: task.id, field: "title", snippet: "Long desc task", score: 0.8 },
		];

		const result = formatTieredHits(hits, tracker, 1);
		// The description in the output should be at most 500 chars.
		const descMatch = result.match(/Description: "([^"]*)"/);
		expect(descMatch).toBeDefined();
		expect(descMatch![1]!.length).toBeLessThanOrEqual(500);
	});

	test("result truncated at 300 chars", () => {
		const task = tracker.addChild(tracker.rootNodeId, "Long result task", "short desc");
		(task as Record<string, unknown>).status = "closed";
		(task as Record<string, unknown>).resultRounds = [
			{ result: "y".repeat(600) },
		];

		const hits = [
			{ taskId: task.id, field: "title", snippet: "Long result task", score: 0.8 },
		];

		const result = formatTieredHits(hits, tracker, 1);
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
			(t as Record<string, unknown>).status = "closed";
			(t as Record<string, unknown>).resultRounds = [
				{ result: "r".repeat(250) },
			];
			tasks.push(t);
		}

		const hits = tasks.map((t, i) => ({
			taskId: t.id,
			field: "title" as const,
			snippet: `Task number ${i}`,
			score: 1 - i * 0.01,
		}));

		// All 30 as full hits — should stop before all 30 fit.
		const result = formatTieredHits(hits, tracker, 30);
		expect(result.length).toBeLessThanOrEqual(8000);
		// But should have SOME entries.
		expect(result).toContain("Task number 0");
		// The last ones should be cut off.
		expect(result).not.toContain("Task number 29");
	});

	test("result from latest round only (not older rounds)", () => {
		const task = tracker.addChild(tracker.rootNodeId, "Multi-round task", "desc");
		(task as Record<string, unknown>).status = "closed";
		(task as Record<string, unknown>).resultRounds = [
			{ result: "old round result" },
			{ result: "latest round result" },
		];

		const hits = [
			{ taskId: task.id, field: "title", snippet: "Multi-round task", score: 0.9 },
		];

		const result = formatTieredHits(hits, tracker, 1);
		expect(result).toContain("latest round result");
		expect(result).not.toContain("old round result");
	});
});
