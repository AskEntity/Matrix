import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	_clearDbCache,
	_setEmbeddingPipeline,
	indexTask,
	reconcileIndex,
	searchIndex,
	searchIndexSync,
} from "./task-index.ts";
import { TaskTracker } from "./task-tracker.ts";

describe("task-index (Orama hybrid search)", () => {
	let tempDir: string;
	let tracker: TaskTracker;
	let dbPath: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-task-index-"));
		tracker = new TaskTracker(join(tempDir, "tree.json"));
		await tracker.load();
		// nested path exercises mkdir-parents.
		dbPath = join(tempDir, "plugin", "matrix", "index.msp");
		// Use null pipeline (no embeddings) — pure BM25 tests.
		// Tests that need hybrid search set a mock pipeline explicitly.
		_setEmbeddingPipeline(null);
	});

	afterEach(async () => {
		_clearDbCache();
		_setEmbeddingPipeline(null);
		await rm(tempDir, { recursive: true, force: true });
	});

	// ── indexTask + searchIndex: provenance ──

	test("indexTask + searchIndex finds a title match with field provenance", async () => {
		const t = tracker.addTask("Fix worktree cleanup race", "unrelated body");
		await indexTask(dbPath, t);

		const hits = await searchIndex(dbPath, "worktree");
		const h = hits.find((x) => x.field === "title");
		expect(h).toBeDefined();
		expect(h?.taskId).toBe(t.id);
		expect(h?.roundIndex).toBeUndefined();
		expect(h?.snippet).toContain("worktree");
	});

	test("searchIndex matches the description field", async () => {
		const t = tracker.addTask(
			"Neutral title",
			"the reconcile pass scans updatedAt against indexedAt",
		);
		await indexTask(dbPath, t);
		const hits = await searchIndex(dbPath, "reconcile");
		expect(
			hits.some((x) => x.taskId === t.id && x.field === "description"),
		).toBe(true);
	});

	test("indexes result per round, with correct round provenance", async () => {
		const t = tracker.addTask("Round task", "desc");
		tracker.appendResultRound(t.id, {
			result: "shipped the alphamodule feature",
		});
		tracker.appendResultRound(t.id, {
			result: "fixed the betamodule regression",
		});
		const node = tracker.getTask(t.id);
		expect(node).toBeDefined();
		if (node) await indexTask(dbPath, node);

		const alpha = await searchIndex(dbPath, "alphamodule");
		expect(alpha.find((h) => h.field === "result")?.roundIndex).toBe(0);

		const beta = await searchIndex(dbPath, "betamodule");
		expect(beta.find((h) => h.field === "result")?.roundIndex).toBe(1);
	});

	test("re-indexing a task REPLACES its old rows (stale terms disappear)", async () => {
		const t = tracker.addTask("alphaword title", "desc");
		await indexTask(dbPath, t);
		expect(await searchIndex(dbPath, "alphaword")).toHaveLength(1);

		tracker.updateTitle(t.id, "betaword title");
		const fresh = tracker.getTask(t.id);
		if (fresh) await indexTask(dbPath, fresh);

		expect(await searchIndex(dbPath, "alphaword")).toHaveLength(0);
		expect(await searchIndex(dbPath, "betaword")).toHaveLength(1);
	});

	// ── reconcile: backfill + incremental + prune ──

	test("reconcileIndex backfills all tasks; a second pass indexes nothing", async () => {
		tracker.addTask("Auth module", "login and session handling");
		tracker.addTask("Cache layer", "prefix cache stability work");

		const r1 = await reconcileIndex(dbPath, tracker);
		expect(r1.indexed).toBeGreaterThanOrEqual(2); // root + a + b
		const loginHits = await searchIndex(dbPath, "login");
		expect(loginHits.some((h) => h.field === "description")).toBe(true);
		const prefixHits = await searchIndex(dbPath, "prefix");
		expect(prefixHits.some((h) => h.field === "description")).toBe(true);

		const r2 = await reconcileIndex(dbPath, tracker);
		expect(r2.indexed).toBe(0);
		expect(r2.pruned).toBe(0);
	});

	test("reconcileIndex reindexes only a task whose updatedAt changed", async () => {
		const a = tracker.addTask("uniquealpha title", "body");
		await reconcileIndex(dbPath, tracker);
		expect(await searchIndex(dbPath, "uniquealpha")).toHaveLength(1);

		await Bun.sleep(2); // guarantee a later ISO timestamp
		tracker.updateTitle(a.id, "uniquebeta title");

		const r = await reconcileIndex(dbPath, tracker);
		expect(r.indexed).toBe(1);
		expect(await searchIndex(dbPath, "uniquealpha")).toHaveLength(0);
		expect(await searchIndex(dbPath, "uniquebeta")).toHaveLength(1);
	});

	test("reconcileIndex prunes index rows for tasks removed from the tree", async () => {
		const a = tracker.addTask("prunablealpha task", "body");
		await reconcileIndex(dbPath, tracker);
		expect(await searchIndex(dbPath, "prunablealpha")).toHaveLength(1);

		tracker.remove(a.id);
		const r = await reconcileIndex(dbPath, tracker);
		expect(r.pruned).toBe(1);
		expect(await searchIndex(dbPath, "prunablealpha")).toHaveLength(0);
	});

	test("reconcileIndex does NOT index general (folder) nodes", async () => {
		tracker.addGeneralNode("foldernameunique", tracker.rootNodeId, "folder");
		await reconcileIndex(dbPath, tracker);
		expect(await searchIndex(dbPath, "foldernameunique")).toHaveLength(0);
	});

	// ── query safety + ranking ──

	test("empty / whitespace query returns no hits", async () => {
		const t = tracker.addTask("anything", "here");
		await indexTask(dbPath, t);
		expect(await searchIndex(dbPath, "")).toHaveLength(0);
		expect(await searchIndex(dbPath, "   ")).toHaveLength(0);
	});

	test("punctuation in the query never throws", async () => {
		const t = tracker.addTask("call done when finished", "body");
		await indexTask(dbPath, t);
		expect(async () => await searchIndex(dbPath, "done()")).not.toThrow();
		const r = await searchIndex(dbPath, "done");
		expect(r.some((h) => h.taskId === t.id)).toBe(true);
		expect(async () => await searchIndex(dbPath, "((( AND OR")).not.toThrow();
	});

	test("results are ranked by relevance", async () => {
		const titleHit = tracker.addTask("rankterm here", "unrelated words only");
		const buried = tracker.addTask(
			"unrelated",
			`${"filler ".repeat(200)} rankterm ${"filler ".repeat(200)}`,
		);
		await indexTask(dbPath, titleHit);
		await indexTask(dbPath, buried);

		const hits = await searchIndex(dbPath, "rankterm");
		expect(hits.length).toBeGreaterThanOrEqual(2);
		// Title hit should outrank a buried description hit.
		expect(hits[0]?.taskId).toBe(titleHit.id);
	});

	test("limit caps the number of hits", async () => {
		for (let i = 0; i < 5; i++) {
			await indexTask(dbPath, tracker.addTask(`capterm task ${i}`, "b"));
		}
		expect(await searchIndex(dbPath, "capterm", 2)).toHaveLength(2);
	});

	// ── Chinese search (mandarin tokenizer) ──

	test("Chinese text is searchable via mandarin tokenizer", async () => {
		const t = tracker.addTask("修复会话恢复", "处理 JSONL 事件重放");
		await indexTask(dbPath, t);

		const hits1 = await searchIndex(dbPath, "会话");
		expect(hits1.some((h) => h.taskId === t.id)).toBe(true);

		const hits2 = await searchIndex(dbPath, "重放");
		expect(hits2.some((h) => h.taskId === t.id)).toBe(true);
	});

	// ── Embedding degradation ──

	test("embedding pipeline failure degrades gracefully to BM25-only", async () => {
		// Pipeline is already null from beforeEach — pure BM25 mode.
		const t = tracker.addTask("degradation test", "keyword search still works");
		await indexTask(dbPath, t);
		const hits = await searchIndex(dbPath, "degradation");
		expect(hits.some((h) => h.taskId === t.id)).toBe(true);
	});

	// ── Persistence round-trip ──

	test("index persists to disk and survives cache clear + reload", async () => {
		const t = tracker.addTask("persist round trip", "survives reload");
		await indexTask(dbPath, t);

		// Clear in-memory cache — forces reload from disk on next access.
		_clearDbCache();

		const hits = await searchIndex(dbPath, "persist");
		expect(hits.some((h) => h.taskId === t.id)).toBe(true);
	});

	// ── Tokenizer survives persist → restore (bug fix regression) ──
	// restoreFromFile does NOT preserve custom tokenizer components. Without
	// the fix (re-applying the mandarin tokenizer after restore), multi-token
	// queries silently fail — the restored DB's default tokenizer splits
	// differently than the mandarin tokenizer used at index time.

	test("Chinese multi-token query works after persist → cache clear → restore", async () => {
		const t = tracker.addTask(
			"Bug: pending 消息栏未清除 — 已被 agent 处理的消息仍显示为 pending",
			"修复 pending 消息栏在 agent 已处理消息后仍然显示的问题",
		);
		await indexTask(dbPath, t);

		// Force restore from disk (the path where the tokenizer was lost).
		_clearDbCache();

		// Single-token query — works even without the fix (exact match).
		const single = await searchIndex(dbPath, "消息");
		expect(single.some((h) => h.taskId === t.id)).toBe(true);

		// Multi-token query — FAILS without the fix (tokenizer mismatch).
		const multi = await searchIndex(dbPath, "消息栏");
		expect(multi.some((h) => h.taskId === t.id)).toBe(true);

		const full = await searchIndex(dbPath, "消息栏未清除");
		expect(full.some((h) => h.taskId === t.id)).toBe(true);
	});

	test("English multi-token query works after persist → cache clear → restore", async () => {
		const t = tracker.addTask(
			"Fix pending banner not cleared after agent processes message",
			"The pending banner filter must be checked and cleared properly",
		);
		await indexTask(dbPath, t);

		_clearDbCache();

		const single = await searchIndex(dbPath, "pending");
		expect(single.some((h) => h.taskId === t.id)).toBe(true);

		// Multi-word English query — also FAILS without the fix.
		const multi = await searchIndex(dbPath, "pending banner");
		expect(multi.some((h) => h.taskId === t.id)).toBe(true);

		const full = await searchIndex(dbPath, "banner not cleared");
		expect(full.some((h) => h.taskId === t.id)).toBe(true);
	});

	test("searchIndexSync multi-token query works after persist → restore", async () => {
		const t = tracker.addTask(
			"Bug: pending 消息栏未清除",
			"Fix pending banner not cleared",
		);
		await indexTask(dbPath, t);

		// Force restore.
		_clearDbCache();
		// Warm the cache via async searchIndex (getDb loads from disk).
		await searchIndex(dbPath, "x");

		// Now searchIndexSync uses the cached (restored) DB.
		const zhHits = searchIndexSync(dbPath, "消息栏");
		expect(zhHits.some((h) => h.taskId === t.id)).toBe(true);

		const enHits = searchIndexSync(dbPath, "pending banner");
		expect(enHits.some((h) => h.taskId === t.id)).toBe(true);
	});

	// ── NaN-score fallback (Score NaN bug fix) ──

	test("hybrid search falls back to BM25 when docs have zero-vector embeddings (NaN scores)", async () => {
		// Reproduce the bug: index documents WITHOUT embeddings (pipeline null),
		// then search WITH the pipeline available. Zero-vector cosine → NaN.
		_setEmbeddingPipeline(null); // pipeline unavailable at index time
		const t1 = tracker.addTask("worktree cleanup race condition", "fix the race");
		const t2 = tracker.addTask("session recovery bug", "restore JSONL state");
		await indexTask(dbPath, t1);
		await indexTask(dbPath, t2);

		// Now enable the pipeline at search time — hybrid mode activates.
		const dim = 768;
		const queryVec = new Array(dim).fill(0);
		queryVec[0] = 0.9;
		queryVec[1] = 0.1;
		_setEmbeddingPipeline({
			embed: async () => queryVec,
		});

		// Without the fix, this would return NaN scores.
		// With the fix, it detects NaN and falls back to fulltext.
		const hits = await searchIndex(dbPath, "worktree");
		expect(hits.length).toBeGreaterThanOrEqual(1);
		const h = hits.find((x) => x.taskId === t1.id);
		expect(h).toBeDefined();
		// Score MUST be a finite number, not NaN.
		expect(Number.isFinite(h!.score)).toBe(true);
		expect(h!.score).toBeGreaterThan(0);
	});

	test("hybrid search works normally when ALL docs have valid embeddings", async () => {
		// Ensure the fallback doesn't trigger when embeddings are valid.
		const dim = 768;
		const goodVec = new Array(dim).fill(0);
		goodVec[0] = 0.8;
		goodVec[1] = 0.2;
		_setEmbeddingPipeline({
			embed: async () => goodVec,
		});

		const t = tracker.addTask("valid embedding task", "has real vectors");
		await indexTask(dbPath, t);

		const hits = await searchIndex(dbPath, "embedding");
		expect(hits.length).toBeGreaterThanOrEqual(1);
		// All scores should be finite.
		for (const h of hits) {
			expect(Number.isFinite(h.score)).toBe(true);
		}
	});

	test("mixed coverage: some docs have embeddings, some have zero vectors → falls back", async () => {
		const dim = 768;
		const realVec = new Array(dim).fill(0);
		realVec[0] = 0.9;
		realVec[1] = 0.1;

		// Index first doc WITHOUT embeddings.
		_setEmbeddingPipeline(null);
		const noEmbed = tracker.addTask("searchterm alpha without embedding", "no embed");
		await indexTask(dbPath, noEmbed);

		// Index second doc WITH embeddings.
		_setEmbeddingPipeline({ embed: async () => realVec });
		const withEmbed = tracker.addTask("searchterm beta with embedding", "has embed");
		await indexTask(dbPath, withEmbed);

		// Search with pipeline available — hybrid would produce NaN for alpha.
		const hits = await searchIndex(dbPath, "searchterm");
		expect(hits.length).toBeGreaterThanOrEqual(2);
		// ALL scores must be finite after fallback.
		for (const h of hits) {
			expect(Number.isFinite(h.score)).toBe(true);
			expect(h.score).toBeGreaterThan(0);
		}
	});

	// ── Hybrid search (with mock embeddings) ──

	test("hybrid search finds semantically similar results via embeddings", async () => {
		// Set up a mock embedding pipeline that maps known texts to specific vectors.
		const vectors = new Map<string, number[]>();
		const dim = 768;

		// Simulate: "fix session recovery" and "修复会话恢复" have similar embeddings.
		const fixVec = new Array(dim).fill(0);
		fixVec[0] = 0.9;
		fixVec[1] = 0.1;
		const zhVec = new Array(dim).fill(0);
		zhVec[0] = 0.85;
		zhVec[1] = 0.15;
		// Unrelated text gets a distant vector.
		const unrelatedVec = new Array(dim).fill(0);
		unrelatedVec[2] = 0.9;
		unrelatedVec[3] = 0.1;

		vectors.set("修复会话恢复", zhVec);
		vectors.set("implement caching layer", unrelatedVec);

		_setEmbeddingPipeline({
			embed: async (text: string) => {
				return vectors.get(text) ?? fixVec;
			},
		});

		const t1 = tracker.addTask("修复会话恢复", "desc");
		const t2 = tracker.addTask("implement caching layer", "desc");
		await indexTask(dbPath, t1);
		await indexTask(dbPath, t2);

		// Search with semantically similar query.
		const hits = await searchIndex(dbPath, "fix session recovery");
		// The Chinese task should rank higher due to vector similarity.
		expect(hits.length).toBeGreaterThanOrEqual(1);
		const zhHit = hits.find((h) => h.taskId === t1.id);
		expect(zhHit).toBeDefined();
		if (hits.length >= 2) {
			expect(hits[0]?.taskId).toBe(t1.id);
		}
	});

	// ── searchIndexSync (BM25-only, uses cached DB) ──

	test("searchIndexSync returns results when DB is cached", async () => {
		const t = tracker.addTask(
			"Fix session recovery bug",
			"restore worktree state",
		);
		await indexTask(dbPath, t);

		// DB is now in the cache (indexTask loaded it).
		const hits = searchIndexSync(dbPath, "session recovery");
		expect(hits.length).toBeGreaterThanOrEqual(1);
		expect(hits[0]?.taskId).toBe(t.id);
		expect(hits[0]?.field).toBe("title");
	});

	test("searchIndexSync returns [] when DB is NOT cached", () => {
		// dbPath not loaded — no indexTask/reconcileIndex called.
		const uncachedPath = join(tempDir, "nonexistent", "index.msp");
		const hits = searchIndexSync(uncachedPath, "anything");
		expect(hits).toEqual([]);
	});

	test("searchIndexSync returns [] for empty query", async () => {
		const t = tracker.addTask("Something", "body");
		await indexTask(dbPath, t);
		expect(searchIndexSync(dbPath, "")).toEqual([]);
		expect(searchIndexSync(dbPath, "   ")).toEqual([]);
	});
});
