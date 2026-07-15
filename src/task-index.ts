/**
 * task-index.ts — Matrix's keyword-search index (FTS5 over the task tree).
 *
 * Memory-index Step 2 (mode b: explicit keyword search). A per-project SQLite
 * database (bun:sqlite, zero external deps) holds an FTS5 table indexing every
 * task's title, description, and each done() round's result + lessons — at
 * per-field + per-round granularity, so every hit carries an exact location
 * (which task, which field, which round).
 *
 * ── Boundary (mirrors done-payload.ts) ──
 * This is Matrix-specific: it reads `resultRounds` (Matrix's data model). It
 * lives in src/ as a LEAF so it can be imported by BOTH
 *   - the matrix plugin (`.mxd/plugin/scope-opts.ts` — index-on-done + the
 *     startup reconcile hook), AND
 *   - the `search_tasks` tool (`orchestrator-tools.ts`, which must be in
 *     `buildAllToolDefs` for external-MCP `availability: "both"`).
 * The plugin-agnostic runtime (`src/runtime/*`, `runtime.ts`,
 * `provider-shared.ts`) has ZERO knowledge of it — those files never import
 * this module and never mention the index / FTS / resultRounds.
 *
 * ── Connection model ──
 * Each public operation opens a fresh connection and closes it in a `finally`.
 * bun:sqlite is synchronous + single-threaded, so operations never overlap;
 * a per-op open on a small local file is sub-millisecond, and closing every
 * time keeps things leak-free (no long-lived handles to clean up).
 *
 * ── Scope discipline (anti-pattern #6) ──
 * Raw FTS5 + BM25 only. No ranking heuristics, field weighting, category
 * filters, or query rewriting — add those only when real use exposes a need.
 * Phase C (embeddings / semantic search) is out of scope; the schema reserves a
 * placeholder `task_vec` table + a `schema_version` so Phase C can migrate.
 * (bun:sqlite cannot `loadExtension`, so Phase C picks the concrete vector
 * mechanism later — a custom libsqlite3 vec0 table, or BLOB + JS cosine.)
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TaskTracker } from "./task-tracker.ts";
import { isTask, type TaskNode } from "./types.ts";

/** Current index schema version. Bump + migrate when the schema changes. */
export const SCHEMA_VERSION = 1;

/** One search hit — an exact location in the index. */
export interface SearchHit {
	taskId: string;
	/** Which field matched: "title" | "description" | "result" | "lessons". */
	field: string;
	/** Round index for result/lessons hits; undefined for title/description. */
	roundIndex?: number;
	/** Highlighted excerpt of the matched text (match wrapped in `[ ]`). */
	snippet: string;
	/** BM25 relevance score (lower = better; rows are returned best-first). */
	score: number;
}

function initSchema(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT);
		CREATE VIRTUAL TABLE IF NOT EXISTS task_fts USING fts5(
			task_id UNINDEXED,
			field UNINDEXED,
			round UNINDEXED,
			text,
			tokenize = 'porter unicode61'
		);
		CREATE TABLE IF NOT EXISTS task_index_meta (
			task_id TEXT PRIMARY KEY,
			indexed_at TEXT NOT NULL
		);
		-- Reserved for Phase C (semantic/vector search). NOT populated in Step 2.
		-- Placeholder only — reserves the name so the schema is forward-versioned.
		-- Phase C decides the real shape (custom libsqlite3 vec0 table, or BLOB +
		-- JS cosine), since bun:sqlite cannot dynamically load sqlite-vec.
		CREATE TABLE IF NOT EXISTS task_vec (
			task_id TEXT NOT NULL,
			field TEXT NOT NULL,
			round INTEGER,
			embedding BLOB,
			dim INTEGER
		);
	`);
	db.run(
		`INSERT INTO schema_meta(key, value) VALUES ('schema_version', ?)
		 ON CONFLICT(key) DO NOTHING`,
		[String(SCHEMA_VERSION)],
	);
}

/**
 * Open the index DB at `dbPath` (creating the parent directory + schema on
 * first open) and return the connection. The CALLER owns closing it. Prefer
 * the higher-level ops below, which open + close for you; this is exposed for
 * tests that inspect the raw DB.
 */
export function openIndexDb(dbPath: string): Database {
	mkdirSync(dirname(dbPath), { recursive: true });
	const db = new Database(dbPath, { create: true });
	initSchema(db);
	return db;
}

/** Open, run `fn`, always close. */
function withDb<T>(dbPath: string, fn: (db: Database) => T): T {
	const db = openIndexDb(dbPath);
	try {
		return fn(db);
	} finally {
		db.close();
	}
}

/** The FTS rows a single task contributes (empty text is skipped). */
function taskRows(
	node: TaskNode,
): Array<{ field: string; round: string; text: string }> {
	const rows: Array<{ field: string; round: string; text: string }> = [];
	if (node.title?.trim()) {
		rows.push({ field: "title", round: "", text: node.title });
	}
	if (node.description?.trim()) {
		rows.push({ field: "description", round: "", text: node.description });
	}
	// One row per round per non-empty field — preserves exact provenance.
	(node.resultRounds ?? []).forEach((r, i) => {
		if (r.result?.trim()) {
			rows.push({ field: "result", round: String(i), text: r.result });
		}
		const lessons = (r.lessons ?? []).filter((l) => l.trim()).join("\n");
		if (lessons) {
			rows.push({ field: "lessons", round: String(i), text: lessons });
		}
	});
	return rows;
}

/** (Re)index one task on an OPEN db: delete old rows, insert fresh, stamp indexed_at. */
function indexTaskInDb(db: Database, node: TaskNode): void {
	db.transaction(() => {
		db.run(`DELETE FROM task_fts WHERE task_id = ?`, [node.id]);
		const ins = db.prepare(
			`INSERT INTO task_fts(task_id, field, round, text) VALUES (?, ?, ?, ?)`,
		);
		for (const row of taskRows(node)) {
			ins.run(node.id, row.field, row.round, row.text);
		}
		db.run(
			`INSERT INTO task_index_meta(task_id, indexed_at) VALUES (?, ?)
			 ON CONFLICT(task_id) DO UPDATE SET indexed_at = excluded.indexed_at`,
			[node.id, node.updatedAt],
		);
	})();
}

/**
 * (Re)index one task: delete its old rows, insert fresh ones, stamp
 * `indexed_at = node.updatedAt`. Atomic (single transaction).
 *
 * Callers on the lifecycle path (onDone) wrap this in try/catch — an index
 * write must NEVER break the task lifecycle. The startup reconcile retries any
 * miss (a task whose `updatedAt` no longer matches its stored `indexed_at`).
 */
export function indexTask(dbPath: string, node: TaskNode): void {
	withDb(dbPath, (db) => indexTaskInDb(db, node));
}

/**
 * Reconcile the whole project index against the current tree:
 *  - (re)index every task whose `updatedAt` differs from its stored
 *    `indexed_at` — this SUBSUMES the one-time backfill (a never-indexed task
 *    has no `indexed_at`, so it is stale and gets indexed);
 *  - prune index rows for tasks that no longer exist in the tree.
 *
 * Idempotent + incremental: after the first (backfill) pass, later passes only
 * touch changed tasks. Best-effort — callers may swallow errors.
 */
export function reconcileIndex(
	dbPath: string,
	tracker: TaskTracker,
): { indexed: number; pruned: number } {
	return withDb(dbPath, (db) => {
		const tasks = tracker.allNodes().filter(isTask);
		const liveIds = new Set(tasks.map((t) => t.id));

		const stored = new Map<string, string>();
		const metaRows = db
			.prepare(`SELECT task_id, indexed_at FROM task_index_meta`)
			.all() as Array<{ task_id: string; indexed_at: string }>;
		for (const row of metaRows) stored.set(row.task_id, row.indexed_at);

		let indexed = 0;
		for (const node of tasks) {
			if (stored.get(node.id) === node.updatedAt) continue; // up to date
			indexTaskInDb(db, node);
			indexed++;
		}

		// Prune tasks removed from the tree since they were last indexed.
		let pruned = 0;
		for (const taskId of stored.keys()) {
			if (liveIds.has(taskId)) continue;
			db.run(`DELETE FROM task_fts WHERE task_id = ?`, [taskId]);
			db.run(`DELETE FROM task_index_meta WHERE task_id = ?`, [taskId]);
			pruned++;
		}
		return { indexed, pruned };
	});
}

/**
 * Turn a raw query into a safe FTS5 MATCH expression: split on whitespace,
 * quote each term (doubling embedded quotes), join with spaces (implicit AND).
 * This prevents FTS5 syntax errors from stray punctuation — it is input
 * safety, NOT semantic query rewriting. Empty/whitespace → "".
 */
export function toMatchQuery(raw: string): string {
	const terms = raw.match(/\S+/g) ?? [];
	return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

/**
 * Keyword-search the index. Returns BM25-ranked hits (best first), each with a
 * highlighted snippet and exact location (taskId, field, roundIndex). An
 * empty/whitespace query returns []. Never throws on punctuation.
 */
export function searchIndex(
	dbPath: string,
	query: string,
	limit = 20,
): SearchHit[] {
	const match = toMatchQuery(query);
	if (!match) return [];
	return withDb(dbPath, (db) => {
		const rows = db
			.prepare(
				`SELECT task_id, field, round,
				        snippet(task_fts, 3, '[', ']', '…', 16) AS snippet,
				        bm25(task_fts) AS score
				 FROM task_fts
				 WHERE task_fts MATCH ?
				 ORDER BY bm25(task_fts)
				 LIMIT ?`,
			)
			.all(match, limit) as Array<{
			task_id: string;
			field: string;
			round: string;
			snippet: string;
			score: number;
		}>;
		return rows.map((r) => ({
			taskId: r.task_id,
			field: r.field,
			...(r.round !== "" ? { roundIndex: Number(r.round) } : {}),
			snippet: r.snippet,
			score: r.score,
		}));
	});
}
