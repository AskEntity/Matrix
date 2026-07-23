/**
 * task-index.ts — Matrix's hybrid-search index (Orama BM25 + vector semantic).
 *
 * Per-project Orama database indexing every task's title, description, and each
 * done() round's result — at per-field + per-round granularity, so every hit
 * carries an exact location (which task, which field, which round).
 *
 * ── Hybrid search ──
 * When the embedding pipeline is available, searches use `mode: "hybrid"` —
 * simultaneous BM25 keyword match + cosine-similarity vector match, with
 * Orama's built-in fusion ranking. Supports cross-lingual semantic matching
 * (e.g. "fix session recovery" finds "修复会话恢复的 bug").
 *
 * If the embedding model fails to load (missing, network error, OOM), the index
 * gracefully degrades to pure BM25 fulltext search (`mode: "fulltext"`). The
 * daemon is never blocked by a model failure.
 *
 * ── Chinese + English ──
 * Uses `@orama/tokenizers/mandarin` (jieba WASM) for CJK-aware tokenization.
 * Both Chinese and English queries work natively.
 *
 * ── Boundary (mirrors done-payload.ts) ──
 * This is Matrix-specific: it reads `resultRounds` (Matrix's data model). It
 * lives in src/ as a LEAF so it can be imported by BOTH
 *   - the matrix plugin (`.mxd/plugin/scope-opts.ts` — index-on-done + the
 *     startup reconcile hook), AND
 *   - the `search_tasks` tool (`orchestrator-tools.ts`, which must be in
 *     `buildAllToolDefs` for external-MCP `availability: "both"`).
 * The plugin-agnostic runtime (`src/runtime/*`, `runtime.ts`,
 * `provider-shared.ts`) has ZERO knowledge of it.
 *
 * ── Persistence ──
 * Two files per project:
 *   - `index.msp` — Orama binary (msgpack), the searchable data.
 *   - `index-meta.json` — sidecar: per-task `{ indexedAt, docIds }` for
 *     staleness tracking and targeted document removal.
 * Both live in the plugin's dataRoot directory (same as tree.json).
 *
 * ── Embedding pipeline ──
 * Lazily loaded on first use via `@huggingface/transformers` with the
 * `onnx-community/embeddinggemma-300m-ONNX` model (q8 quantization, 768-dim).
 * Module-level singleton — loaded once, reused across all projects.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AnyOrama, Results } from "@orama/orama";
import { create, insert, remove, search } from "@orama/orama";
import {
	persistToFile,
	restoreFromFile,
} from "@orama/plugin-data-persistence/server";
import { createTokenizer } from "@orama/tokenizers/mandarin";
import type { TaskTracker } from "./task-tracker.ts";
import { isTask, type TaskNode } from "./types.ts";

// ── Constants ──

const EMBEDDING_MODEL = "onnx-community/embeddinggemma-300m-ONNX";
const EMBEDDING_DTYPE = "q8";
const EMBEDDING_DIM = 768;

/** Minimum cosine similarity for vector results in hybrid mode. */
const SIMILARITY_THRESHOLD = 0.5;

// ── Types ──

/** One search hit — an exact location in the index. */
export interface SearchHit {
	taskId: string;
	/** Which field matched: "title" | "description" | "result". */
	field: string;
	/** Round index for result hits; undefined for title/description. */
	roundIndex?: number;
	/** Excerpt of the matched text. */
	snippet: string;
	/** Relevance score (higher = better; results are returned best-first). */
	score: number;
}

/** Sidecar metadata per task: tracks staleness + document IDs for removal. */
interface TaskMeta {
	indexedAt: string;
	docIds: string[];
}

/** Full sidecar structure. */
type IndexMeta = Record<string, TaskMeta>;

/** The Orama schema for our index documents. */
const INDEX_SCHEMA = {
	taskId: "string",
	field: "string",
	round: "string",
	text: "string",
	embedding: `vector[${EMBEDDING_DIM}]`,
} as const;

type IndexDb = ReturnType<typeof createDb>;

// ── Embedding pipeline (lazy singleton) ──

type EmbeddingPipeline = {
	embed: (text: string) => Promise<number[]>;
};

let embeddingPipelinePromise: Promise<EmbeddingPipeline | null> | null = null;
let embeddingPipeline: EmbeddingPipeline | null | undefined; // undefined = not attempted

/**
 * Get or lazily initialize the embedding pipeline. Returns null if the model
 * cannot be loaded (graceful degradation to BM25-only). The promise is cached
 * so concurrent callers share the same load attempt.
 *
 * When MXD_DISABLE_EMBEDDINGS is set (test environment), short-circuits to
 * null immediately — prevents loading onnxruntime-node (NAPI module) inside
 * worker threads, where worker teardown triggers a fatal NAPI crash
 * (SIGTRAP / exit 133) that kills the entire bun test process.
 */
async function getEmbeddingPipeline(): Promise<EmbeddingPipeline | null> {
	// Explicit mock (via _setEmbeddingPipeline) takes priority — lets tests
	// exercise hybrid search paths even when MXD_DISABLE_EMBEDDINGS is set.
	if (embeddingPipeline !== undefined) return embeddingPipeline;
	if (process.env.MXD_DISABLE_EMBEDDINGS) {
		embeddingPipeline = null;
		return null;
	}
	if (embeddingPipelinePromise) return embeddingPipelinePromise;

	embeddingPipelinePromise = (async () => {
		try {
			const { pipeline } = await import("@huggingface/transformers");
			const extractor = await pipeline("feature-extraction", EMBEDDING_MODEL, {
				dtype: EMBEDDING_DTYPE,
			} as Record<string, unknown>);
			const result: EmbeddingPipeline = {
				embed: async (text: string) => {
					const output = await extractor(text, {
						pooling: "mean",
						normalize: true,
					});
					return Array.from(
						(output as { data: Float32Array }).data as Float32Array,
					);
				},
			};
			embeddingPipeline = result;
			return result;
		} catch (e) {
			console.warn(
				`[task-index] Embedding pipeline failed to load (degrading to BM25-only):`,
				e instanceof Error ? e.message : String(e),
			);
			embeddingPipeline = null;
			return null;
		}
	})();
	return embeddingPipelinePromise;
}

// ── Orama database management ──

const dbCache = new Map<string, IndexDb>();

function createDb(): AnyOrama {
	return create({
		schema: INDEX_SCHEMA,
		components: { tokenizer: createTokenizer() },
	});
}

async function getDb(dbPath: string): Promise<IndexDb> {
	const cached = dbCache.get(dbPath);
	if (cached) return cached;

	let db: IndexDb;
	if (existsSync(dbPath)) {
		try {
			db = (await restoreFromFile("binary", dbPath)) as IndexDb;
			// restoreFromFile does NOT preserve custom tokenizer components —
			// the restored DB silently falls back to Orama's default tokenizer.
			// Re-apply the mandarin tokenizer so multi-token queries (Chinese
			// AND English) match correctly. Without this, single-token queries
			// like "消息" or "pending" work (exact token match) but multi-token
			// queries like "消息栏" or "pending banner" fail (tokenized differently
			// at query time vs index time).
			(db as Record<string, unknown>).tokenizer = createTokenizer();
		} catch {
			db = createDb();
		}
	} else {
		db = createDb();
	}
	dbCache.set(dbPath, db);
	return db;
}

async function persistDb(dbPath: string, db: IndexDb): Promise<void> {
	mkdirSync(dirname(dbPath), { recursive: true });
	await persistToFile(db, "binary", dbPath);
}

// ── Sidecar metadata ──

function metaPath(dbPath: string): string {
	return dbPath.replace(/\.msp$/, "-meta.json");
}

function readMeta(dbPath: string): IndexMeta {
	const p = metaPath(dbPath);
	if (!existsSync(p)) return {};
	try {
		return JSON.parse(readFileSync(p, "utf-8"));
	} catch {
		return {};
	}
}

function writeMeta(dbPath: string, meta: IndexMeta): void {
	const p = metaPath(dbPath);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, JSON.stringify(meta));
}

// ── Document ID convention ──
// `${taskId}:${field}:${round}` — deterministic, targeted removal by ID.

function docId(taskId: string, field: string, round: string): string {
	return `${taskId}:${field}:${round}`;
}

/** The index rows a single task contributes (empty text is skipped). */
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
	(node.resultRounds ?? []).forEach((r, i) => {
		if (r.result?.trim()) {
			rows.push({ field: "result", round: String(i), text: r.result });
		}
	});
	return rows;
}

/** Remove all docs for a task from the DB using stored doc IDs from meta. */
function removeTaskDocs(db: IndexDb, docIds: string[]): void {
	for (const id of docIds) {
		try {
			remove(db, id);
		} catch {
			// Already removed or doesn't exist — fine.
		}
	}
}

/** A zero vector of the correct dimension (used when embeddings unavailable). */
const ZERO_EMBEDDING = new Array(EMBEDDING_DIM).fill(0);

/**
 * (Re)index one task: delete its old documents, insert fresh ones with
 * embeddings (if the pipeline is available), update the sidecar metadata,
 * and persist to disk.
 *
 * Callers on the lifecycle path (onDone) wrap this in try/catch — an index
 * write must NEVER break the task lifecycle. The startup reconcile retries any
 * miss (a task whose `updatedAt` no longer matches its stored `indexedAt`).
 */
export async function indexTask(dbPath: string, node: TaskNode): Promise<void> {
	const db = await getDb(dbPath);
	const pipe = await getEmbeddingPipeline();
	const meta = readMeta(dbPath);

	// Remove old docs.
	const oldMeta = meta[node.id];
	if (oldMeta) {
		removeTaskDocs(db, oldMeta.docIds);
	}

	// Insert new docs.
	const rows = taskRows(node);
	const newDocIds: string[] = [];
	for (const row of rows) {
		const id = docId(node.id, row.field, row.round);
		let embedding: number[] | undefined;
		if (pipe) {
			try {
				embedding = await pipe.embed(row.text);
			} catch {
				// Embedding failed for this row — use zero vector.
			}
		}
		insert(db, {
			id,
			taskId: node.id,
			field: row.field,
			round: row.round,
			text: row.text,
			embedding: embedding ?? ZERO_EMBEDDING,
		});
		newDocIds.push(id);
	}

	// Update sidecar.
	meta[node.id] = {
		indexedAt: node.updatedAt ?? "",
		docIds: newDocIds,
	};
	writeMeta(dbPath, meta);

	await persistDb(dbPath, db);
}

/**
 * Reconcile the whole project index against the current tree:
 *  - (re)index every task whose `updatedAt` differs from its stored marker;
 *  - prune index rows for tasks that no longer exist in the tree.
 *
 * Idempotent + incremental. Best-effort — callers may swallow errors.
 */
export async function reconcileIndex(
	dbPath: string,
	tracker: TaskTracker,
): Promise<{ indexed: number; pruned: number }> {
	const db = await getDb(dbPath);
	const tasks = tracker.allNodes().filter(isTask);
	const liveIds = new Set(tasks.map((t) => t.id));
	const pipe = await getEmbeddingPipeline();
	const meta = readMeta(dbPath);

	let indexed = 0;
	for (const node of tasks) {
		const stored = meta[node.id];
		if (stored?.indexedAt === node.updatedAt) continue;

		// Remove old docs.
		if (stored) {
			removeTaskDocs(db, stored.docIds);
		}

		// Insert new docs.
		const rows = taskRows(node);
		const newDocIds: string[] = [];
		for (const row of rows) {
			const id = docId(node.id, row.field, row.round);
			let embedding: number[] | undefined;
			if (pipe) {
				try {
					embedding = await pipe.embed(row.text);
				} catch {
					// skip
				}
			}
			insert(db, {
				id,
				taskId: node.id,
				field: row.field,
				round: row.round,
				text: row.text,
				embedding: embedding ?? ZERO_EMBEDDING,
			});
			newDocIds.push(id);
		}

		meta[node.id] = {
			indexedAt: node.updatedAt ?? "",
			docIds: newDocIds,
		};
		indexed++;
	}

	// Prune tasks removed from the tree.
	let pruned = 0;
	for (const taskId of Object.keys(meta)) {
		if (liveIds.has(taskId)) continue;
		const stored = meta[taskId];
		if (stored) {
			removeTaskDocs(db, stored.docIds);
		}
		delete meta[taskId];
		pruned++;
	}

	writeMeta(dbPath, meta);
	if (indexed > 0 || pruned > 0) {
		await persistDb(dbPath, db);
	}
	return { indexed, pruned };
}

/**
 * Hybrid-search (or fulltext-search as fallback) the index. Returns ranked
 * hits (best first), each with the matched text, field provenance, and score.
 * An empty/whitespace query returns []. Never throws on punctuation.
 */
export async function searchIndex(
	dbPath: string,
	query: string,
	limit = 20,
): Promise<SearchHit[]> {
	const trimmed = query.trim();
	if (!trimmed) return [];

	const db = await getDb(dbPath);
	const pipe = await getEmbeddingPipeline();

	type HitDoc = {
		taskId: string;
		field: string;
		round: string;
		text: string;
	};

	let results: Results<HitDoc>;

	if (pipe) {
		try {
			const queryEmbedding = await pipe.embed(trimmed);
			results = search(db, {
				mode: "hybrid",
				term: trimmed,
				vector: { value: queryEmbedding, property: "embedding" },
				similarity: SIMILARITY_THRESHOLD,
				properties: ["text"],
				limit,
			}) as Results<HitDoc>;

			// NaN-score fallback: documents indexed without valid embeddings
			// (null or zero-vector) produce NaN cosine similarity, which
			// contaminates the hybrid fusion score. If ANY hit has NaN, redo
			// as pure BM25 — the entire result set is suspect when the index
			// has mixed embedding coverage.
			if (results.hits.some((h) => !Number.isFinite(h.score))) {
				results = search(db, {
					mode: "fulltext",
					term: trimmed,
					properties: ["text"],
					limit,
				}) as Results<HitDoc>;
			}
		} catch {
			results = search(db, {
				mode: "fulltext",
				term: trimmed,
				properties: ["text"],
				limit,
			}) as Results<HitDoc>;
		}
	} else {
		results = search(db, {
			mode: "fulltext",
			term: trimmed,
			properties: ["text"],
			limit,
		}) as Results<HitDoc>;
	}

	return results.hits.map((h) => ({
		taskId: h.document.taskId,
		field: h.document.field,
		...(h.document.round !== ""
			? { roundIndex: Number(h.document.round) }
			: {}),
		snippet: h.document.text.slice(0, 200),
		score: h.score,
	}));
}

/**
 * Synchronous BM25-only search using the ALREADY-CACHED in-memory DB.
 * Returns [] if the DB hasn't been loaded yet (no blocking I/O).
 *
 * Intended for the work_context injection path, which must be sync (the
 * ScopeOpts.buildWorkContext hook is sync). The DB is pre-loaded into
 * `dbCache` by `reconcileIndex` at startup — so by the time any agent
 * launches, the cache is warm.
 *
 * Skips embeddings entirely (no async pipeline call) — pure keyword match.
 */
export function searchIndexSync(
	dbPath: string,
	query: string,
	limit = 20,
): SearchHit[] {
	const trimmed = query.trim();
	if (!trimmed) return [];

	const db = dbCache.get(dbPath);
	if (!db) return []; // Not loaded yet — caller gets nothing, no crash.

	type HitDoc = {
		taskId: string;
		field: string;
		round: string;
		text: string;
	};

	const results = search(db, {
		mode: "fulltext",
		term: trimmed,
		properties: ["text"],
		limit,
	}) as Results<HitDoc>;

	return results.hits.map((h) => ({
		taskId: h.document.taskId,
		field: h.document.field,
		...(h.document.round !== ""
			? { roundIndex: Number(h.document.round) }
			: {}),
		snippet: h.document.text.slice(0, 200),
		score: h.score,
	}));
}

// ── Test helpers ──

/**
 * Reset the embedding pipeline state. Test-only.
 */
export function _resetEmbeddingPipeline(): void {
	embeddingPipeline = undefined;
	embeddingPipelinePromise = null;
}

/**
 * Set a mock embedding pipeline. Test-only.
 */
export function _setEmbeddingPipeline(pipe: EmbeddingPipeline | null): void {
	embeddingPipeline = pipe;
	embeddingPipelinePromise = null;
}

/**
 * Clear the in-memory DB cache for a given path (or all). Test-only.
 */
export function _clearDbCache(dbPath?: string): void {
	if (dbPath) {
		dbCache.delete(dbPath);
	} else {
		dbCache.clear();
	}
}
