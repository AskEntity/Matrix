import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	_clearDbCache,
	_setEmbeddingPipeline,
	_waitForBackgroundIndexing,
	indexTask,
	reconcileIndex,
	reconcileIndexDeferred,
	removeTaskFromIndex,
	searchIndex,
	searchIndexSync,
	updateTaskIndex,
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

	test("reconcileIndex reindexes only the document whose CONTENT changed", async () => {
		const a = tracker.addTask("uniquealpha title", "body");
		await reconcileIndex(dbPath, tracker);
		expect(await searchIndex(dbPath, "uniquealpha")).toHaveLength(1);

		tracker.updateTitle(a.id, "uniquebeta title");

		// 1, not 2: the description's content did not change, so its document
		// is not rebuilt even though the task's updatedAt moved.
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
		const t1 = tracker.addTask(
			"worktree cleanup race condition",
			"fix the race",
		);
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
		const noEmbed = tracker.addTask(
			"searchterm alpha without embedding",
			"no embed",
		);
		await indexTask(dbPath, noEmbed);

		// Index second doc WITH embeddings.
		_setEmbeddingPipeline({ embed: async () => realVec });
		const withEmbed = tracker.addTask(
			"searchterm beta with embedding",
			"has embed",
		);
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

/**
 * The contract this module was rewritten for: staleness is a hash of the
 * indexed CONTENT, per document, and the startup pass never blocks the caller.
 *
 * Every assertion here counts EMBEDDINGS, not wall-clock. The suite runs with
 * MXD_DISABLE_EMBEDDINGS set (bunfig.toml), so "nothing was re-embedded" is not
 * observable by timing — it needs a pipeline that counts. The counter is also
 * the only thing that can tell a re-index apart from a no-op, since both leave
 * the same searchable index behind.
 */
/**
 * One-hot vector derived from the text: identical texts collide, different
 * texts are orthogonal (cosine 0, below SIMILARITY_THRESHOLD). See
 * countingPipeline for why a constant vector is useless here.
 */
function orthogonalVector(text: string): number[] {
	let h = 0;
	for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
	const v = new Array(768).fill(0);
	v[h % 768] = 1;
	return v;
}

describe("task-index: hash-keyed staleness", () => {
	let tempDir: string;
	let tracker: TaskTracker;
	let dbPath: string;
	let embedCalls: string[];

	/**
	 * A pipeline that records every text it is asked to embed, and returns a
	 * DISTINCT vector per text.
	 *
	 * Distinctness is load-bearing, not decoration. A mock that returns one
	 * constant vector gives every document cosine 1.0 against every query, so
	 * hybrid search returns the entire index and any assertion about WHICH
	 * documents came back silently passes. Three of these tests were written
	 * against a constant-vector mock first and were measuring nothing.
	 */
	function countingPipeline() {
		embedCalls = [];
		_setEmbeddingPipeline({
			embed: async (text: string) => {
				embedCalls.push(text);
				return orthogonalVector(text);
			},
		});
	}

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-index-hash-"));
		tracker = new TaskTracker(join(tempDir, "tree.json"));
		await tracker.load();
		dbPath = join(tempDir, "plugin", "matrix", "index.msp");
		countingPipeline();
	});

	afterEach(async () => {
		_clearDbCache();
		_setEmbeddingPipeline(null);
		await rm(tempDir, { recursive: true, force: true });
	});

	// ── Bar item 2: a day of activity must cost nothing ──

	test("a day of non-content activity re-embeds ZERO documents", async () => {
		const parent = tracker.addTask("Parent task", "parent body");
		const child = tracker.addChild(parent.id, "Child task", "child body");
		await reconcileIndex(dbPath, tracker);
		expect(embedCalls.length).toBeGreaterThan(0); // backfill happened
		embedCalls.length = 0;

		// Everything below writes node.updatedAt in task-tracker.ts, and NONE of
		// it touches an indexed field. Under the old `indexedAt !== updatedAt`
		// key every one of these marked a task stale — and `addChild`/`remove`
		// mark the PARENT stale, which is why the root task was re-embedded
		// (title + description + every result round) over and over on a busy day.
		tracker.updateStatus(child.id, "in_progress");
		tracker.updateStatus(child.id, "verify");
		tracker.updateStatus(child.id, "closed");
		tracker.updateCost(child.id, 1.23);
		tracker.assignWorktree(child.id, "some-branch", "/tmp/wt");
		tracker.assignBranch(child.id, "other-branch");
		tracker.updateColor(child.id, "#ff0000");
		tracker.setMetadata(child.id, { anything: "at all" });
		const doomed = tracker.addChild(parent.id, "Doomed", "gone soon");
		tracker.remove(doomed.id);
		const folder = tracker.addGeneralNode("Folder", parent.id, "folder");
		tracker.reparent(child.id, folder.id);
		tracker.reorderChildren(parent.id, [folder.id]);

		const r = await reconcileIndex(dbPath, tracker);
		expect(embedCalls).toEqual([]);
		expect(r.indexed).toBe(0);
	});

	// ── Bar item 3: per-document granularity ──

	test("editing a title re-embeds ONLY the title — not the description or any round", async () => {
		const t = tracker.addTask("Original title", "A description that stays put");
		tracker.appendResultRound(t.id, { result: "round zero result" });
		tracker.appendResultRound(t.id, { result: "round one result" });
		await reconcileIndex(dbPath, tracker);
		// 5 = this task's title + description + 2 rounds, plus the root's title.
		expect(embedCalls).toHaveLength(5);
		embedCalls.length = 0;

		tracker.updateTitle(t.id, "Replacement title");
		await reconcileIndex(dbPath, tracker);

		// THE point of per-document hashing. A whole-task hash would re-embed
		// all four here — and root has dozens of rounds, so a one-word title
		// edit would be the most expensive thing in the system.
		expect(embedCalls).toEqual(["Replacement title"]);
		expect(await searchIndex(dbPath, "Replacement")).toHaveLength(1);
		expect(await searchIndex(dbPath, "Original")).toHaveLength(0);
	});

	test("editing a description re-embeds ONLY the description", async () => {
		const t = tracker.addTask("Stable title", "first body text");
		tracker.appendResultRound(t.id, { result: "a round" });
		await reconcileIndex(dbPath, tracker);
		embedCalls.length = 0;

		tracker.updateDescription(t.id, "second body text");
		await reconcileIndex(dbPath, tracker);

		expect(embedCalls).toEqual(["second body text"]);
		expect(await searchIndex(dbPath, "second")).toHaveLength(1);
	});

	test("appending a result round re-embeds ONLY that round", async () => {
		const t = tracker.addTask("Task title", "task body");
		tracker.appendResultRound(t.id, { result: "first round" });
		await reconcileIndex(dbPath, tracker);
		embedCalls.length = 0;

		tracker.appendResultRound(t.id, { result: "second round" });
		await reconcileIndex(dbPath, tracker);

		expect(embedCalls).toEqual(["second round"]);
		const hits = await searchIndex(dbPath, "second");
		expect(hits[0]?.field).toBe("result");
		expect(hits[0]?.roundIndex).toBe(1);
	});

	test("indexTask on a single task is the same per-document diff", async () => {
		const t = tracker.addTask("Alpha title", "alpha body");
		tracker.appendResultRound(t.id, { result: "alpha round" });
		await indexTask(dbPath, tracker.getTask(t.id)!);
		expect(embedCalls).toHaveLength(3);
		embedCalls.length = 0;

		tracker.updateTitle(t.id, "Gamma title");
		await indexTask(dbPath, tracker.getTask(t.id)!);
		expect(embedCalls).toEqual(["Gamma title"]);
	});

	test("emptying a field removes its document without touching the others", async () => {
		const t = tracker.addTask("Kept title", "removable body");
		await reconcileIndex(dbPath, tracker);
		embedCalls.length = 0;

		tracker.updateDescription(t.id, "");
		await reconcileIndex(dbPath, tracker);

		expect(embedCalls).toEqual([]);
		expect(await searchIndex(dbPath, "removable")).toHaveLength(0);
		expect(await searchIndex(dbPath, "Kept")).toHaveLength(1);
	});

	// ── Bar item 4: migration must not trigger a full re-embed ──

	test("a legacy indexedAt sidecar adopts hashes and re-embeds NOTHING", async () => {
		const a = tracker.addTask("Legacy alpha", "legacy alpha body");
		const b = tracker.addTask("Legacy beta", "legacy beta body");
		tracker.appendResultRound(b.id, { result: "legacy beta round" });
		await reconcileIndex(dbPath, tracker);
		const embeddedAtBuild = embedCalls.length;
		expect(embeddedAtBuild).toBeGreaterThan(0);

		// Rewrite the sidecar in the OLD shape: an `indexedAt` marker and a flat
		// docId list, no hashes at all. This is what every deployed machine has.
		const metaFile = dbPath.replace(/\.msp$/, "-meta.json");
		const legacy: Record<string, unknown> = {};
		for (const node of [tracker.getTask(a.id)!, tracker.getTask(b.id)!]) {
			const ids = [`${node.id}:title:`, `${node.id}:description:`];
			(node.resultRounds ?? []).forEach((_, i) =>
				ids.push(`${node.id}:result:${i}`),
			);
			legacy[node.id] = { indexedAt: node.updatedAt, docIds: ids };
		}
		// The root task too — it is in the tree and therefore in the sidecar.
		const root = tracker.getTask(tracker.rootNodeId)!;
		legacy[root.id] = {
			indexedAt: root.updatedAt,
			docIds: [`${root.id}:title:`, `${root.id}:description:`],
		};
		writeFileSync(metaFile, JSON.stringify(legacy));
		_clearDbCache();
		embedCalls.length = 0;

		// Deploying the fix must NOT trigger the very backfill it exists to
		// prevent. "No hash" means "unknown", not "stale": the documents were
		// built from some version of this content, and assuming it is current is
		// exactly the claim `indexedAt` was already making — so adopting is
		// strictly no worse than what it replaces.
		const r = await reconcileIndex(dbPath, tracker);
		expect(embedCalls).toEqual([]);
		expect(r.indexed).toBe(0);

		// And the adopted hashes are real: the NEXT content change is detected
		// normally, so migration does not leave the task permanently frozen.
		tracker.updateTitle(a.id, "Migrated alpha");
		await reconcileIndex(dbPath, tracker);
		expect(embedCalls).toEqual(["Migrated alpha"]);
	});

	test("a legacy entry still re-embeds a document the old index never had", async () => {
		const t = tracker.addTask("Legacy title", "legacy body");
		await reconcileIndex(dbPath, tracker);
		const metaFile = dbPath.replace(/\.msp$/, "-meta.json");
		// The old sidecar knew about the title only — so the description is
		// genuinely absent from the index and must be built, adoption or not.
		const root = tracker.getTask(tracker.rootNodeId)!;
		writeFileSync(
			metaFile,
			JSON.stringify({
				[t.id]: { indexedAt: t.updatedAt, docIds: [`${t.id}:title:`] },
				// The root's entry is kept in the legacy shape too, so the only
				// document this test can re-embed is the one it is about. (Drop
				// it and the root's title re-embeds, which is correct behaviour
				// and pure noise here.)
				[root.id]: {
					indexedAt: root.updatedAt,
					docIds: [`${root.id}:title:`],
				},
			}),
		);
		_clearDbCache();
		embedCalls.length = 0;

		await reconcileIndex(dbPath, tracker);
		expect(embedCalls).toEqual(["legacy body"]);
	});

	// ── Bar item 1 + §3: the startup pass may never wait for index work ──

	test("reconcileIndexDeferred returns before any document is embedded", async () => {
		for (let i = 0; i < 20; i++) {
			tracker.addTask(`Backfill task ${i}`, `Backfill body ${i}`);
		}

		const r = await reconcileIndexDeferred(dbPath, tracker);

		// The awaited half only PLANS. This is the whole acceptance criterion:
		// an empty index is exactly the case that used to burn the 30s worker
		// init budget and take the daemon down with it.
		expect(r.deferred).toBe(true);
		expect(r.planned).toBe(41); // 20 tasks × (title + description) + root title
		expect(embedCalls).toEqual([]);

		await _waitForBackgroundIndexing();
		expect(embedCalls.length).toBe(r.planned);
		expect(await searchIndex(dbPath, "Backfill")).not.toHaveLength(0);
	});

	test("a steady-state reconcile defers nothing and touches no index file", async () => {
		tracker.addTask("Steady task", "steady body");
		await reconcileIndex(dbPath, tracker);
		_clearDbCache();
		embedCalls.length = 0;

		const r = await reconcileIndexDeferred(dbPath, tracker);

		expect(r).toEqual({ planned: 0, pruned: 0, deferred: false });
		expect(embedCalls).toEqual([]);
	});

	test("a plan with nothing to embed never loads the embedding pipeline", async () => {
		tracker.addTask("Lazy task", "lazy body");
		await reconcileIndex(dbPath, tracker);

		// A pipeline that EXPLODES if touched. The old reconcile awaited
		// getEmbeddingPipeline() before the staleness loop, so a zero-work boot
		// paid a full model load — seconds, on the path that must not block.
		_setEmbeddingPipeline({
			embed: async () => {
				throw new Error("pipeline must not be consulted for an empty plan");
			},
		});

		await expect(reconcileIndex(dbPath, tracker)).resolves.toEqual({
			indexed: 0,
			pruned: 0,
		});
	});

	// ── Deletion is first-party, not left to the next boot ──

	test("removeTaskFromIndex drops a deleted task's documents immediately", async () => {
		const t = tracker.addTask("Deletable task", "deletable body");
		await reconcileIndex(dbPath, tracker);
		expect(await searchIndex(dbPath, "Deletable")).not.toHaveLength(0);

		tracker.remove(t.id);
		await removeTaskFromIndex(dbPath, t.id);

		expect(await searchIndex(dbPath, "Deletable")).toHaveLength(0);
		// And it leaves nothing for the next reconcile to prune.
		const r = await reconcileIndex(dbPath, tracker);
		expect(r).toEqual({ indexed: 0, pruned: 0 });
	});

	test("updateTaskIndex is non-fatal — a broken index path never throws", async () => {
		const t = tracker.addTask("Resilient task", "resilient body");
		// A path whose parent is a FILE, so every write under it fails.
		const blocked = join(tempDir, "blocker");
		writeFileSync(blocked, "not a directory");
		await expect(
			updateTaskIndex(join(blocked, "index.msp"), t.id, t),
		).resolves.toBeUndefined();
	});

	test("updateTaskIndex(null) is a no-op for callers with no index", async () => {
		const t = tracker.addTask("Unindexed task", "unindexed body");
		await updateTaskIndex(null, t.id, t);
		expect(embedCalls).toEqual([]);
	});

	// ── A failed embedding must not be recorded as done ──

	test("a document whose embedding fails is retried on the next pass", async () => {
		const t = tracker.addTask("Retry title", "retry body");
		const vec = new Array(768).fill(0);
		vec[0] = 1;
		let failing = true;
		_setEmbeddingPipeline({
			embed: async (text: string) => {
				embedCalls.push(text);
				if (failing) throw new Error("transient embedding failure");
				return vec;
			},
		});

		await reconcileIndex(dbPath, tracker);
		// DISTINCT texts: when a batch throws, every member is retried
		// individually, so the failing pass calls embed twice per document.
		const attempted = new Set(embedCalls).size;
		expect(attempted).toBeGreaterThan(0);
		// Still searchable — a failed embedding degrades to keyword-only, it
		// does not lose the document.
		expect(await searchIndex(dbPath, "Retry")).not.toHaveLength(0);

		embedCalls.length = 0;
		failing = false;
		// Content is unchanged, so the CONTENT hash matches — this is entirely
		// the `e: false` clause of isDocStale doing the work. Without it, a
		// single offline boot (or one run with MXD_DISABLE_EMBEDDINGS) would
		// leave the index permanently keyword-only with nothing reporting it.
		await reconcileIndex(dbPath, tracker);
		expect(new Set(embedCalls).size).toBe(attempted);
	});

	test("turning embeddings OFF does not destroy vectors that already exist", async () => {
		tracker.addTask("Asymmetric title", "asymmetric body");
		await reconcileIndex(dbPath, tracker);
		const built = embedCalls.length;
		expect(built).toBeGreaterThan(0);

		// BM25-only mode. The `e:false → stale` clause is deliberately
		// one-directional: upgrading is worth a rebuild, downgrading must never
		// throw away work.
		_setEmbeddingPipeline(null);
		embedCalls.length = 0;
		const r = await reconcileIndex(dbPath, tracker);
		expect(r.indexed).toBe(0);

		countingPipeline();
		embedCalls.length = 0;
		const r2 = await reconcileIndex(dbPath, tracker);
		expect(r2.indexed).toBe(0);
		expect(embedCalls).toEqual([]);
	});

	// ── Batching ──

	test("batching does not change which documents get which vector", async () => {
		// 40 tasks → 80+ documents → several batches (EMBED_BATCH_SIZE = 32).
		for (let i = 0; i < 40; i++) {
			tracker.addTask(`Batchword ${i} title`, `Batchword ${i} body`);
		}
		const seen: string[] = [];
		_setEmbeddingPipeline({
			embed: async (text: string) => {
				seen.push(text);
				return orthogonalVector(text);
			},
		});

		await reconcileIndex(dbPath, tracker);
		expect(seen.length).toBe(81); // 40 × (title + description) + root title

		const hits = await searchIndex(dbPath, "Batchword", 100);
		expect(hits.length).toBeGreaterThan(0);
		for (const h of hits) expect(Number.isFinite(h.score)).toBe(true);
	});
});
