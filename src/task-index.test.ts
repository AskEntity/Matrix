import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	indexTask,
	openIndexDb,
	reconcileIndex,
	SCHEMA_VERSION,
	searchIndex,
	toMatchQuery,
} from "./task-index.ts";
import { TaskTracker } from "./task-tracker.ts";

describe("task-index (FTS keyword search)", () => {
	let tempDir: string;
	let tracker: TaskTracker;
	let dbPath: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-task-index-"));
		tracker = new TaskTracker(join(tempDir, "tree.json"));
		await tracker.load();
		// nested path exercises openIndexDb's mkdir-parents.
		dbPath = join(tempDir, "plugin", "matrix", "index.db");
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	// ── schema ──

	test("openIndexDb creates the file, parent dirs, versioned schema + reserved vec table", () => {
		const db = openIndexDb(dbPath);
		expect(existsSync(dbPath)).toBe(true);

		const ver = db
			.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`)
			.get() as { value: string } | undefined;
		expect(ver?.value).toBe(String(SCHEMA_VERSION));

		const names = (
			db
				.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
				.all() as Array<{ name: string }>
		).map((r) => r.name);
		expect(names).toContain("task_index_meta");
		expect(names).toContain("task_vec"); // reserved for Phase C

		// FTS5 virtual table is queryable.
		const count = db.prepare(`SELECT count(*) AS c FROM task_fts`).get() as {
			c: number;
		};
		expect(count.c).toBe(0);
		db.close();
	});

	// ── indexTask + searchIndex: provenance ──

	test("indexTask + searchIndex finds a title match with field/round provenance + snippet", () => {
		const t = tracker.addTask("Fix worktree cleanup race", "unrelated body");
		indexTask(dbPath, t);

		const hits = searchIndex(dbPath, "worktree");
		const h = hits.find((x) => x.field === "title");
		expect(h).toBeDefined();
		expect(h?.taskId).toBe(t.id);
		expect(h?.roundIndex).toBeUndefined();
		expect(h?.snippet).toContain("[worktree]");
	});

	test("searchIndex matches the description field", () => {
		const t = tracker.addTask(
			"Neutral title",
			"the reconcile pass scans updatedAt against indexedAt",
		);
		indexTask(dbPath, t);
		const hits = searchIndex(dbPath, "reconcile");
		expect(
			hits.some((x) => x.taskId === t.id && x.field === "description"),
		).toBe(true);
	});

	test("indexes result per round, with correct round provenance", () => {
		const t = tracker.addTask("Round task", "desc");
		tracker.appendResultRound(t.id, {
			result: "shipped the alphamodule feature",
		});
		tracker.appendResultRound(t.id, {
			result: "fixed the betamodule regression",
		});
		const node = tracker.getTask(t.id);
		expect(node).toBeDefined();
		if (node) indexTask(dbPath, node);

		const alpha = searchIndex(dbPath, "alphamodule");
		expect(alpha.find((h) => h.field === "result")?.roundIndex).toBe(0);

		const beta = searchIndex(dbPath, "betamodule");
		expect(beta.find((h) => h.field === "result")?.roundIndex).toBe(1);
	});

	test("re-indexing a task REPLACES its old rows (stale terms disappear)", () => {
		const t = tracker.addTask("alphaword title", "desc");
		indexTask(dbPath, t);
		expect(searchIndex(dbPath, "alphaword")).toHaveLength(1);

		tracker.updateTitle(t.id, "betaword title");
		const fresh = tracker.getTask(t.id);
		if (fresh) indexTask(dbPath, fresh);

		expect(searchIndex(dbPath, "alphaword")).toHaveLength(0); // old term gone
		expect(searchIndex(dbPath, "betaword")).toHaveLength(1);
	});

	// ── reconcile: backfill + incremental + prune ──

	test("reconcileIndex backfills all tasks; a second pass indexes nothing", () => {
		const a = tracker.addTask("Auth module", "login and session handling");
		const b = tracker.addTask("Cache layer", "prefix cache stability work");

		const r1 = reconcileIndex(dbPath, tracker);
		expect(r1.indexed).toBeGreaterThanOrEqual(2); // root + a + b
		expect(searchIndex(dbPath, "login").some((h) => h.taskId === a.id)).toBe(
			true,
		);
		expect(searchIndex(dbPath, "prefix").some((h) => h.taskId === b.id)).toBe(
			true,
		);

		const r2 = reconcileIndex(dbPath, tracker);
		expect(r2.indexed).toBe(0); // incremental: nothing changed
		expect(r2.pruned).toBe(0);
	});

	test("reconcileIndex reindexes only a task whose updatedAt changed", async () => {
		const a = tracker.addTask("uniquealpha title", "body");
		reconcileIndex(dbPath, tracker);
		expect(searchIndex(dbPath, "uniquealpha")).toHaveLength(1);

		await Bun.sleep(2); // guarantee a later ISO timestamp
		tracker.updateTitle(a.id, "uniquebeta title");

		const r = reconcileIndex(dbPath, tracker);
		expect(r.indexed).toBe(1); // only the edited task
		expect(searchIndex(dbPath, "uniquealpha")).toHaveLength(0);
		expect(searchIndex(dbPath, "uniquebeta")).toHaveLength(1);
	});

	test("reconcileIndex prunes index rows for tasks removed from the tree", () => {
		const a = tracker.addTask("prunablealpha task", "body");
		reconcileIndex(dbPath, tracker);
		expect(searchIndex(dbPath, "prunablealpha")).toHaveLength(1);

		tracker.remove(a.id);
		const r = reconcileIndex(dbPath, tracker);
		expect(r.pruned).toBe(1);
		expect(searchIndex(dbPath, "prunablealpha")).toHaveLength(0);
	});

	test("reconcileIndex does NOT index general (folder) nodes", () => {
		tracker.addGeneralNode("foldernameunique", tracker.rootNodeId, "folder");
		reconcileIndex(dbPath, tracker);
		expect(searchIndex(dbPath, "foldernameunique")).toHaveLength(0);
	});

	// ── query safety + ranking ──

	test("empty / whitespace query returns no hits", () => {
		const t = tracker.addTask("anything", "here");
		indexTask(dbPath, t);
		expect(searchIndex(dbPath, "")).toHaveLength(0);
		expect(searchIndex(dbPath, "   ")).toHaveLength(0);
	});

	test("punctuation in the query never throws (terms are quoted)", () => {
		const t = tracker.addTask("call done when finished", "body");
		indexTask(dbPath, t);
		// parentheses / operators would be FTS5 syntax without quoting.
		expect(() => searchIndex(dbPath, "done()")).not.toThrow();
		expect(searchIndex(dbPath, "done()").some((h) => h.taskId === t.id)).toBe(
			true,
		);
		expect(() => searchIndex(dbPath, "((( AND OR")).not.toThrow();
	});

	test("multi-term query is an implicit AND", () => {
		const both = tracker.addTask("worktree removal by path", "b");
		const one = tracker.addTask("worktree cleanup race", "b");
		indexTask(dbPath, both);
		indexTask(dbPath, one);
		const hits = searchIndex(dbPath, "worktree path");
		const ids = new Set(hits.map((h) => h.taskId));
		expect(ids.has(both.id)).toBe(true); // has both terms
		expect(ids.has(one.id)).toBe(false); // missing "path"
	});

	test("results are BM25-ranked (title hit outranks a buried description hit)", () => {
		const titleHit = tracker.addTask("rankterm here", "unrelated words only");
		const buried = tracker.addTask(
			"unrelated",
			`${"filler ".repeat(200)} rankterm ${"filler ".repeat(200)}`,
		);
		indexTask(dbPath, titleHit);
		indexTask(dbPath, buried);

		const hits = searchIndex(dbPath, "rankterm");
		expect(hits.length).toBeGreaterThanOrEqual(2);
		expect(hits[0]?.taskId).toBe(titleHit.id); // strongest match first
	});

	test("limit caps the number of hits", () => {
		for (let i = 0; i < 5; i++) {
			indexTask(dbPath, tracker.addTask(`capterm task ${i}`, "b"));
		}
		expect(searchIndex(dbPath, "capterm", 2)).toHaveLength(2);
	});

	// ── toMatchQuery unit ──

	test("toMatchQuery quotes terms + doubles embedded quotes; empty → ''", () => {
		expect(toMatchQuery("worktree cleanup")).toBe(`"worktree" "cleanup"`);
		expect(toMatchQuery("  a  b ")).toBe(`"a" "b"`);
		expect(toMatchQuery("")).toBe("");
		expect(toMatchQuery('say "hi"')).toBe(`"say" """hi"""`);
	});
});
