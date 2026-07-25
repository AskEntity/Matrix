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
 *   - the matrix plugin (`.mxd/plugin/scope-opts.ts` — the startup reconcile
 *     hook + index-on-done), AND
 *   - `src/task-operations.ts` (the ONE codepath per task operation), AND
 *   - the `search_tasks` tool (`orchestrator-tools.ts`, which must be in
 *     `buildAllToolDefs` for external-MCP `availability: "both"`).
 * The plugin-agnostic runtime (`src/runtime/*`, `runtime.ts`,
 * `provider-shared.ts`) has ZERO knowledge of it.
 *
 * ── Plan / apply: why staleness is a CONTENT hash, and why it is per document ──
 * Staleness used to be `sidecar.indexedAt !== node.updatedAt`. `updatedAt` is
 * written in 16 places in task-tracker.ts and only 3 of them touch a field we
 * index — a status transition, a cost update, or merely CREATING A CHILD (which
 * bumps the parent) all marked a task stale. The backlog therefore grew with
 * ACTIVITY rather than with content change, and it was only paid at boot: the
 * longer the daemon stayed up, the more expensive starting it became. Measured
 * 2026-07-25: a full backfill took 4m13s for one project against a 30s worker
 * init budget, so the daemon was unbootable for hours.
 *
 * Every write therefore goes through ONE mechanism, split in two halves:
 *   - `planIndex()`  — pure + cheap. Reads only the small sidecar JSON, walks
 *     the given tasks, hashes each document's text, diffs. Touches neither the
 *     `.msp` nor the embedding model. Measured: 3ms for 1200 documents.
 *   - `applyIndexPlan()` — the expensive half. Loads the DB, lazily loads the
 *     model at the FIRST document that actually needs an embedding, embeds,
 *     persists.
 * The split is what lets the startup path stay off the boot budget: see
 * `reconcileIndexDeferred`.
 *
 * Hashing is PER DOCUMENT (per field, per round), not per task. A whole-task
 * hash would re-embed every round of a task because one word of its title
 * changed — and the root task has dozens of rounds.
 *
 * ── Persistence ──
 * Two files per project:
 *   - `index.msp` — Orama binary (msgpack), the searchable data.
 *   - `index-meta.json` — sidecar: per-task `{ docs: { docId: {h, e} } }`.
 * Both live in the plugin's dataRoot directory (same as tree.json).
 *
 * ⚠️ ORDERING INVARIANT: the DB is persisted BEFORE the sidecar that claims it.
 * The reverse order turns any failed `.msp` write into a silent permanent hole
 * — the sidecar says "indexed", so nothing ever re-indexes it. In this order a
 * failure always lands on "the sidecar is behind", which the next plan repairs.
 * That is what makes an index write safe to treat as non-fatal.
 */

import { createHash } from "node:crypto";
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

/**
 * Persist every N inserted documents during a long apply, so a crash mid-way
 * through a backfill keeps what it already earned. Without this, a restart
 * during a multi-minute backfill starts from zero — which is the same "boots
 * are expensive" problem this module exists to remove.
 */
const FLUSH_EVERY = 50;

/**
 * Embed in batches. Measured 2026-07-25 over 64 mixed-length documents: on
 * webgpu, batch 1 → 70.8ms and 38.1ms CPU per document; batch 32 → 43.5ms and
 * 5.3ms CPU. Per-call dispatch overhead is most of the single-document cost.
 *
 * The same sweep is also the evidence that webgpu is genuinely the GPU rather
 * than a software fallback: CPU's wall time barely moves with batch size
 * (62.6 → 53.3ms, 15%) while webgpu's CPU cost collapses 7×. A fallback would
 * scale like the CPU path.
 */
const EMBED_BATCH_SIZE = 32;

/**
 * Bound on `batch size × longest member`, in characters. A batch is padded to
 * its longest member, so 32 result rounds of 20KB each is not 32× the work of
 * one — it is 32× the work of the LONGEST. This caps that product instead of
 * the count, which is the quantity that actually drives time and memory.
 */
const EMBED_BATCH_WORK_CAP = 64_000;

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

/** What the sidecar remembers about one indexed document. */
interface DocMeta {
	/** Content hash — see `contentHash`. */
	h: string;
	/** Was a real embedding stored, or the zero vector? */
	e: boolean;
}

/** Sidecar entry for one task: its documents, keyed by document id. */
interface TaskMeta {
	docs: Record<string, DocMeta>;
}

/**
 * The pre-hash sidecar shape (`indexedAt` + a flat id list, no hashes).
 * Read-only: `planIndex` migrates these in place. Never written.
 */
interface LegacyTaskMeta {
	indexedAt: string;
	docIds: string[];
}

/** Full sidecar structure. Entries are either current or legacy. */
type IndexMeta = Record<string, TaskMeta | LegacyTaskMeta>;

function isLegacy(m: TaskMeta | LegacyTaskMeta): m is LegacyTaskMeta {
	return Array.isArray((m as LegacyTaskMeta).docIds);
}

/** The Orama schema for our index documents. */
const INDEX_SCHEMA = {
	taskId: "string",
	field: "string",
	round: "string",
	text: "string",
	embedding: `vector[${EMBEDDING_DIM}]`,
} as const;

type IndexDb = ReturnType<typeof createDb>;

// ── Embedding device selection ──

/**
 * Device candidates per platform, best first. `cpu` is always last and always
 * works. Every candidate is VERIFIED before use (see `verifyEmbedder`) — a
 * device is selected because it produced a usable vector, never because a
 * config value said it should.
 *
 * ⚠️ DO NOT "simplify" this to `device: "auto"`. It is the obvious answer and
 * it silently corrupts the index. On darwin, transformers.js resolves `auto`
 * to the execution-provider list ["coreml","webgpu","cpu"], so CoreML claims
 * the graph — and CoreML returns a 768-dim vector of NaN for any text longer
 * than a couple dozen characters (measured 2026-07-25: fine at 24 chars, all
 * NaN at 336). Nothing raises. `searchIndex`'s NaN-score guard then quietly
 * redoes every query as pure BM25, so the product keeps working with semantic
 * search deleted and no error anywhere. `auto` is also 7.4× slower than CPU.
 *
 * Measured on the same machine (M-series, bun, transformers.js 4.2.0,
 * embeddinggemma-300m q8, 24 embeddings): cpu 52.9ms/embed at 5.4s user CPU;
 * webgpu 59.0ms/embed at 0.8s user CPU, output bit-identical to CPU;
 * coreml 226.7ms/embed at 19.4s user CPU, output NaN.
 *
 * webgpu is first on darwin for the CPU number, not the wall-clock one: the
 * backfill now runs in the background NEXT TO agents, so not saturating four
 * cores is the property that matters. Non-darwin candidates are unmeasured —
 * they are safe only because verification gates them, and they fall through to
 * cpu when the runtime cannot provide them.
 */
const DEVICE_CANDIDATES: Record<string, string[]> = {
	darwin: ["webgpu", "cpu"],
	win32: ["dml", "webgpu", "cpu"],
	linux: ["cuda", "webgpu", "cpu"],
};

/**
 * Verification inputs. SEVERAL, of deliberately different shapes, and every one
 * must come back usable.
 *
 * ⚠️ One probe string is not enough, and the reason is worth knowing before
 * anyone trims this list. CoreML's failure on this model is **deterministic per
 * input and NOT monotonic in length** — measured 2026-07-25, repeatably, in any
 * order: a 24-character string is CORRECT, a 10-character string is NaN, a
 * 336-character string is NaN. So there is no "safe length" to probe at, and a
 * single probe that happens to draw a good input certifies a device that is
 * broken for nearly everything else. (The first pass here drew exactly 24 and
 * 336 characters and read it as a length threshold. It was a coincidence of two
 * strings, and it would have shipped as a one-string probe.)
 */
const DEVICE_PROBE_TEXTS = [
	"reconcile ",
	"Fix session recovery bug",
	"The daemon became unbootable because the startup reconcile ran on the worker's ready path, " +
		"and the staleness key was a timestamp that moved for reasons unrelated to indexed content.",
	"这段文字同时包含中文，用来确认分词与嵌入在真实内容上都能正常工作。",
];

// ── Embedding pipeline (lazy singleton) ──

type EmbeddingPipeline = {
	/** One text — used for search queries. */
	embed: (text: string) => Promise<number[]>;
	/** Many texts in one session run — used for indexing. See EMBED_BATCH_SIZE. */
	embedMany: (texts: string[]) => Promise<number[][]>;
};

let embeddingPipelinePromise: Promise<EmbeddingPipeline | null> | null = null;
let embeddingPipeline: EmbeddingPipeline | null | undefined; // undefined = not attempted

/** Which device the loaded pipeline actually verified on (for logging/tests). */
let selectedDevice: string | null = null;

/** Is the embedding pipeline allowed to load at all? Cheap — no model I/O. */
function embeddingsEnabled(): boolean {
	if (embeddingPipeline !== undefined) return embeddingPipeline !== null;
	return !process.env.MXD_DISABLE_EMBEDDINGS;
}

/** The device actually in use, or null if no pipeline has been loaded. */
export function embeddingDevice(): string | null {
	return selectedDevice;
}

/**
 * Build a pipeline on one device and prove it works before returning it.
 *
 * "Works" is checked by embedding real-length text and requiring a finite,
 * unit-norm vector of the right dimension — NOT by reading a config field.
 * `session.config.device` reports the device that was REQUESTED, so it says
 * "coreml" just as confidently when CoreML is emitting NaN. A configuration
 * that claims acceleration and silently does something else is worse than an
 * honest CPU path, so the only accepted evidence is an actual vector.
 */
async function tryDevice(device: string): Promise<EmbeddingPipeline | null> {
	const { pipeline } = await import("@huggingface/transformers");
	const opts: Record<string, unknown> = { dtype: EMBEDDING_DTYPE };
	// "cpu" is passed explicitly rather than left to the library default, so
	// the selected device is always something we chose and can print.
	opts.device = device;

	let extractor: Awaited<ReturnType<typeof pipeline>> | null = null;
	try {
		extractor = await pipeline(
			"feature-extraction",
			EMBEDDING_MODEL,
			opts as never,
		);
		const run = extractor as unknown as (
			t: string | string[],
			o: Record<string, unknown>,
		) => Promise<{ data: Float32Array }>;
		const embedMany = async (texts: string[]): Promise<number[][]> => {
			const output = await run(texts, { pooling: "mean", normalize: true });
			// One flat Float32Array of texts.length × EMBEDDING_DIM.
			const flat = output.data;
			return texts.map((_, i) =>
				Array.from(flat.subarray(i * EMBEDDING_DIM, (i + 1) * EMBEDDING_DIM)),
			);
		};
		const embed = async (text: string): Promise<number[]> => {
			const output = await run(text, { pooling: "mean", normalize: true });
			return Array.from(output.data);
		};

		const check = (label: string, vectors: number[][]): void => {
			vectors.forEach((v, i) => {
				if (v.length !== EMBEDDING_DIM) {
					throw new Error(
						`${label}[${i}] returned ${v.length} dims, expected ${EMBEDDING_DIM}`,
					);
				}
				if (!v.every((x) => Number.isFinite(x))) {
					throw new Error(`${label}[${i}] returned non-finite values`);
				}
				const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
				if (!(norm > 0.5)) {
					throw new Error(`${label}[${i}] is degenerate (L2 norm ${norm})`);
				}
			});
		};

		// Both call shapes are verified because indexing uses `embedMany` and
		// search uses `embed`, and they take different paths through the model
		// (a batch is padded to its longest member). A device that is fine
		// one-at-a-time is not thereby fine batched.
		for (const text of DEVICE_PROBE_TEXTS) {
			check("probe", [await embed(text)]);
		}
		check("batched probe", await embedMany(DEVICE_PROBE_TEXTS));
		return { embed, embedMany };
	} catch (e) {
		console.warn(
			`[task-index] embedding device "${device}" rejected: ${
				e instanceof Error ? e.message : String(e)
			}`,
		);
		try {
			(extractor as unknown as { dispose?: () => unknown } | null)?.dispose?.();
		} catch {
			// Best-effort teardown of the rejected session.
		}
		return null;
	}
}

/**
 * Get or lazily initialize the embedding pipeline. Returns null if no device
 * can produce usable vectors (graceful degradation to BM25-only). The promise
 * is cached so concurrent callers share the same load attempt.
 *
 * When MXD_DISABLE_EMBEDDINGS is set (test environment), short-circuits to
 * null immediately — prevents loading onnxruntime-node (NAPI module) inside
 * worker threads, where worker teardown triggers a fatal NAPI crash
 * (SIGTRAP / exit 133) that kills the entire bun test process.
 *
 * MXD_EMBEDDING_DEVICE forces a single candidate. It is still verified: an
 * explicit request is not a reason to accept a corrupt index, so a device that
 * fails its probe still falls back to CPU (loudly).
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
		const forced = process.env.MXD_EMBEDDING_DEVICE;
		const candidates = forced
			? [forced, ...(forced === "cpu" ? [] : ["cpu"])]
			: (DEVICE_CANDIDATES[process.platform] ?? ["cpu"]);

		for (const device of candidates) {
			const pipe = await tryDevice(device);
			if (pipe) {
				selectedDevice = device;
				// Logged once, and it says WHAT WAS PROVEN, not what was asked
				// for. `session.config.device` reports the requested device and
				// would print "coreml" just as confidently while emitting NaN,
				// so a log line sourced from it would be exactly the "claims
				// acceleration, silently does something else" failure.
				console.log(
					`[task-index] embedding device: ${device} — verified on ${DEVICE_PROBE_TEXTS.length} probe inputs, single + batched`,
				);
				embeddingPipeline = pipe;
				return pipe;
			}
		}
		console.warn(
			`[task-index] no embedding device produced usable vectors — degrading to BM25-only`,
		);
		embeddingPipeline = null;
		return null;
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
			db.tokenizer = createTokenizer();
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

// ── Document identity + content hashing ──

// `${taskId}:${field}:${round}` — deterministic, targeted removal by ID.
function docId(taskId: string, field: string, round: string): string {
	return `${taskId}:${field}:${round}`;
}

/**
 * The staleness key for one document.
 *
 * Covers the text AND the model identity, so swapping EMBEDDING_MODEL or
 * EMBEDDING_DTYPE invalidates every document. That matters more than it looks:
 * mixing two vector spaces in one index does not fail, it returns plausible
 * wrong answers. Note this costs nothing on the day the model changes, because
 * the rebuild it triggers runs in the background (see `reconcileIndexDeferred`).
 *
 * Deliberately does NOT cover whether an embedding was actually produced — that
 * is `DocMeta.e`, and it is asymmetric on purpose. See `isDocStale`.
 */
function contentHash(text: string): string {
	return createHash("sha256")
		.update(`v1\u0000${EMBEDDING_MODEL}\u0000${EMBEDDING_DTYPE}\u0000${text}`)
		.digest("hex")
		.slice(0, 16);
}

/**
 * Is this document out of date?
 *
 * Two clauses, and the second is one-directional on purpose:
 *  1. the content (or the model) changed → re-embed;
 *  2. it is stored WITHOUT a real embedding and embeddings are now available
 *     → embed it.
 *
 * (2) exists because otherwise the failure is permanent and silent: a first
 * boot that is offline, or any install that ran once with MXD_DISABLE_EMBEDDINGS,
 * writes zero vectors, and a content hash alone would call them current
 * forever. The index then serves BM25-only results with no error anywhere —
 * the same shape of silent degradation as the CoreML NaN trap. The reverse
 * (embedded document, embeddings now disabled) is deliberately NOT stale:
 * turning embeddings off must never destroy vectors that already exist.
 */
function isDocStale(
	stored: DocMeta | undefined,
	hash: string,
	canEmbed: boolean,
): boolean {
	if (!stored) return true;
	if (stored.h !== hash) return true;
	return canEmbed && !stored.e;
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

// ── Plan ──

interface PlannedDoc {
	taskId: string;
	id: string;
	field: string;
	round: string;
	text: string;
	hash: string;
}

/**
 * A diff between the tree's current content and what the index holds.
 * Cheap to compute and safe to throw away — nothing has happened yet.
 */
export interface IndexPlan {
	dbPath: string;
	/** Documents that must be (re)built — each needs an embedding. */
	inserts: PlannedDoc[];
	/** Document ids to remove from the DB (replaced, emptied, or pruned). */
	removals: string[];
	/**
	 * The sidecar as it should be once `inserts` land. Inserted documents are
	 * added by `applyIndexPlan` as they actually land, never up front — the
	 * sidecar may only ever claim documents that are already persisted.
	 */
	meta: IndexMeta;
	/** True when `meta` already differs from disk with zero inserts (migration/prune). */
	metaDirty: boolean;
	/** Tasks whose sidecar entries were pruned (gone from the tree). */
	prunedTasks: number;
}

/** Does this plan require the DB or the embedding model at all? */
export function planIsEmpty(plan: IndexPlan): boolean {
	return (
		plan.inserts.length === 0 && plan.removals.length === 0 && !plan.metaDirty
	);
}

/**
 * Compute what the index needs, without touching the index.
 *
 * Reads the sidecar JSON and hashes the given tasks' content — no `.msp`, no
 * embedding model, no network. This is the half that is allowed to run on a
 * latency-sensitive path.
 *
 * `authority` says which sidecar entries this plan speaks for:
 *  - "all"  → entries for tasks NOT in `tasks` are pruned (full reconcile);
 *  - a Set  → only those task ids are touched, everything else is left alone.
 * That one parameter is what makes indexing a single task, removing a deleted
 * task (`tasks: []`), and reconciling the whole tree the SAME mechanism rather
 * than three that can drift.
 */
export function planIndex(
	dbPath: string,
	tasks: TaskNode[],
	authority: "all" | Set<string>,
): IndexPlan {
	const meta = readMeta(dbPath);
	const canEmbed = embeddingsEnabled();

	const inserts: PlannedDoc[] = [];
	const removals: string[] = [];
	let metaDirty = false;

	for (const node of tasks) {
		if (authority !== "all" && !authority.has(node.id)) continue;

		const entry = meta[node.id];
		// Migration: a legacy entry knows WHICH documents exist but not what
		// they contain. Adopt the current content's hashes for the documents it
		// already has, WITHOUT re-embedding. Treating "no hash" as stale would
		// make deploying this fix trigger the exact full backfill it exists to
		// prevent — on every machine, on the next boot. Adopting is strictly no
		// worse than the `indexedAt` marker it replaces, which was already
		// claiming those documents were current.
		let stored: Record<string, DocMeta>;
		if (!entry) {
			stored = {};
		} else if (isLegacy(entry)) {
			stored = {};
			for (const id of entry.docIds) {
				// `e: true` — the legacy index was built by a daemon with
				// embeddings on. If it was not, the model-identity hash cannot
				// tell, and a wrong `true` here costs semantic quality on old
				// documents, never correctness.
				stored[id] = { h: "", e: true };
			}
			metaDirty = true;
		} else {
			stored = entry.docs;
		}

		const rows = taskRows(node);
		const nextDocs: Record<string, DocMeta> = {};
		const liveIds = new Set<string>();

		for (const row of rows) {
			const id = docId(node.id, row.field, row.round);
			liveIds.add(id);
			const hash = contentHash(row.text);
			const prior = stored[id];
			// Legacy adoption: the document exists in the DB but its hash is
			// unknown, so take the current content's hash as given.
			if (prior && prior.h === "") {
				nextDocs[id] = { h: hash, e: prior.e };
				continue;
			}
			if (isDocStale(prior, hash, canEmbed)) {
				if (prior) removals.push(id);
				inserts.push({
					taskId: node.id,
					id,
					field: row.field,
					round: row.round,
					text: row.text,
					hash,
				});
			} else if (prior) {
				nextDocs[id] = prior;
			}
		}

		// Documents the task no longer produces (a round deleted, a description
		// emptied, or a legacy id that no longer corresponds to any content).
		for (const id of Object.keys(stored)) {
			if (!liveIds.has(id)) {
				removals.push(id);
				metaDirty = true;
			}
		}

		if (rows.length === 0 && Object.keys(stored).length === 0) {
			// Nothing to index and nothing indexed — do not create an entry.
			if (entry) {
				delete meta[node.id];
				metaDirty = true;
			}
			continue;
		}
		meta[node.id] = { docs: nextDocs };
	}

	// Prune sidecar entries for tasks that are gone from the tree.
	let prunedTasks = 0;
	if (authority === "all") {
		const liveTaskIds = new Set(tasks.map((t) => t.id));
		for (const taskId of Object.keys(meta)) {
			if (liveTaskIds.has(taskId)) continue;
			const gone = meta[taskId];
			if (gone) {
				removals.push(
					...(isLegacy(gone) ? gone.docIds : Object.keys(gone.docs)),
				);
			}
			delete meta[taskId];
			prunedTasks++;
		}
	} else {
		// Explicit removal: a task id under our authority that we were not given
		// content for (e.g. it was just deleted from the tree).
		for (const taskId of authority) {
			if (tasks.some((t) => t.id === taskId)) continue;
			const gone = meta[taskId];
			if (!gone) continue;
			removals.push(...(isLegacy(gone) ? gone.docIds : Object.keys(gone.docs)));
			delete meta[taskId];
			prunedTasks++;
		}
	}
	if (prunedTasks > 0) metaDirty = true;

	return { dbPath, inserts, removals, meta, metaDirty, prunedTasks };
}

// ── Apply ──

/** Let the event loop breathe between embedding batches. */
const yieldToLoop = (): Promise<void> =>
	new Promise((r) => {
		setTimeout(r, 0);
	});

/**
 * THE only place a vector enters the store.
 *
 * A non-finite embedding is a DEFECT, never a value. Storing one is permanent
 * and silent damage: the sidecar records "this content is indexed", so no
 * future plan revisits it, and `searchIndex`'s NaN guard then quietly serves
 * BM25-only results forever. A device that passes verification can still emit
 * NaN on a particular input, so the check belongs here — at the write — rather
 * than only at device selection.
 *
 * Note the distinction this preserves: a FINITE ZERO vector is legitimate and
 * must keep working (no pipeline, MXD_DISABLE_EMBEDDINGS, BM25-only mode). So
 * "no embedding" is representable and "broken embedding" is not — past this
 * function the only two states are a real unit vector or the canonical zero.
 */
function toStoredVector(v: number[] | undefined): {
	vector: number[];
	embedded: boolean;
} {
	if (!v || v.length !== EMBEDDING_DIM || !v.every(Number.isFinite)) {
		return { vector: ZERO_EMBEDDING, embedded: false };
	}
	return { vector: v, embedded: true };
}

/**
 * Group documents so that `count × longest member` stays under the work cap.
 * Padding is to the longest member, so a single 40KB result round travels
 * alone rather than dragging 31 short titles up to its length.
 */
function batchDocs(docs: PlannedDoc[]): PlannedDoc[][] {
	const out: PlannedDoc[][] = [];
	let cur: PlannedDoc[] = [];
	let longest = 0;
	for (const d of docs) {
		const nextLongest = Math.max(longest, d.text.length);
		if (
			cur.length > 0 &&
			((cur.length + 1) * nextLongest > EMBED_BATCH_WORK_CAP ||
				cur.length >= EMBED_BATCH_SIZE)
		) {
			out.push(cur);
			cur = [];
			longest = 0;
		}
		cur.push(d);
		longest = Math.max(longest, d.text.length);
	}
	if (cur.length > 0) out.push(cur);
	return out;
}

/**
 * Execute a plan: remove replaced documents, embed + insert new ones, persist.
 *
 * Loads the embedding model lazily, at the first document that actually needs
 * one — a plan with nothing to embed must not pay a model load, which is what
 * makes the steady-state reconcile free.
 */
export async function applyIndexPlan(
	plan: IndexPlan,
): Promise<{ indexed: number; pruned: number }> {
	if (planIsEmpty(plan)) return { indexed: 0, pruned: 0 };

	// A migration/prune-only plan changes nothing in the DB — skip loading it.
	if (plan.inserts.length === 0 && plan.removals.length === 0) {
		writeMeta(plan.dbPath, plan.meta);
		return { indexed: 0, pruned: plan.prunedTasks };
	}

	const db = await getDb(plan.dbPath);

	for (const id of plan.removals) {
		try {
			remove(db, id);
		} catch {
			// Already gone — the sidecar and the DB disagreeing in this
			// direction is exactly what the ordering invariant permits.
		}
	}

	let pipe: EmbeddingPipeline | null = null;
	let pipeLoaded = false;
	let landed = 0;
	let sinceFlush = 0;

	const flush = async (): Promise<void> => {
		sinceFlush = 0;
		// DB first, then the sidecar that claims it. Never the reverse.
		await persistDb(plan.dbPath, db);
		writeMeta(plan.dbPath, plan.meta);
	};

	for (const batch of batchDocs(plan.inserts)) {
		if (!pipeLoaded) {
			// Lazily — a plan with nothing to embed must never pay a model load.
			pipe = await getEmbeddingPipeline();
			pipeLoaded = true;
		}

		let vectors: Array<number[] | undefined> = batch.map(() => undefined);
		if (pipe) {
			try {
				vectors = await pipe.embedMany(batch.map((d) => d.text));
			} catch {
				// One bad document must not cost the whole batch. Retry the
				// members individually; whatever still fails lands as `e: false`
				// and is retried by the next plan.
				vectors = [];
				for (const d of batch) {
					try {
						vectors.push(await pipe.embed(d.text));
					} catch {
						vectors.push(undefined);
					}
				}
			}
		}

		for (const [i, doc] of batch.entries()) {
			const { vector, embedded } = toStoredVector(vectors[i]);
			// Remove before every insert, even when the plan saw no prior
			// document. Orama's `insert` THROWS on a duplicate id, and the
			// sidecar under-reporting the DB is a state this design deliberately
			// creates: persisting the DB before the sidecar that claims it means
			// a crash in that window leaves documents on disk that the sidecar
			// has never heard of. The repair pass then plans an insert for a
			// document that is already there. So the very failure mode the
			// ordering invariant exists to make recoverable would throw on the
			// pass that repairs it. (A legacy sidecar listing fewer ids than the
			// index holds reaches the same state, which is how this was found.)
			try {
				remove(db, doc.id);
			} catch {
				// Not present — the normal case.
			}
			insert(db, {
				id: doc.id,
				taskId: doc.taskId,
				field: doc.field,
				round: doc.round,
				text: doc.text,
				embedding: vector,
			});
			const entry = plan.meta[doc.taskId];
			if (entry && !isLegacy(entry)) {
				entry.docs[doc.id] = { h: doc.hash, e: embedded };
			}
			landed++;
			sinceFlush++;
		}

		if (sinceFlush >= FLUSH_EVERY) await flush();
		if (pipe) await yieldToLoop();
	}

	await flush();
	return { indexed: landed, pruned: plan.prunedTasks };
}

/** A zero vector of the correct dimension (used when embeddings unavailable). */
const ZERO_EMBEDDING = new Array(EMBEDDING_DIM).fill(0);

// ── Public operations ──

/**
 * (Re)index one task — the first-party write on every content-change path
 * (create, title/description edit, done() round append).
 *
 * Only documents whose content actually changed are re-embedded; the task's
 * other documents are left untouched. That is the whole point of hashing per
 * document: the root task has dozens of result rounds, and a one-word title
 * edit must not re-embed all of them.
 */
export async function indexTask(dbPath: string, node: TaskNode): Promise<void> {
	await applyIndexPlan(planIndex(dbPath, [node], new Set([node.id])));
}

/** Drop every document belonging to a task (it left the tree). */
export async function removeTaskFromIndex(
	dbPath: string,
	taskId: string,
): Promise<void> {
	await applyIndexPlan(planIndex(dbPath, [], new Set([taskId])));
}

/**
 * THE index write for a task operation — make the index reflect this task's
 * current state. `node === null` means the task no longer exists.
 *
 * Loud on failure, never fatal. Renaming a task must not fail because the
 * search index could not be written — and that is only an honest trade because
 * the failure is RECOVERABLE: the ordering invariant (DB persisted before the
 * sidecar that claims it) means every failure leaves the sidecar behind, which
 * the next plan repairs. With the reverse ordering, "non-fatal" would have
 * meant "silently lose this document forever".
 *
 * `dbPath === null` means this caller has no index (test harnesses). It is a
 * REQUIRED argument at every call site rather than an optional callback,
 * because the property we want is "impossible to forget", and an optional
 * parameter is precisely a forgettable one.
 */
export async function updateTaskIndex(
	dbPath: string | null,
	taskId: string,
	node: TaskNode | null,
): Promise<void> {
	if (!dbPath) return;
	try {
		if (node) await indexTask(dbPath, node);
		else await removeTaskFromIndex(dbPath, taskId);
	} catch (e) {
		console.error(
			`[task-index] index write failed for task ${taskId} (the task operation itself succeeded; the next reconcile will repair the index):`,
			e,
		);
	}
}

/**
 * Reconcile the whole project index against the current tree, and WAIT for it.
 *
 * Callers that must observe the result (tests, tools) use this. The startup
 * path does NOT — see `reconcileIndexDeferred`.
 */
export async function reconcileIndex(
	dbPath: string,
	tracker: TaskTracker,
): Promise<{ indexed: number; pruned: number }> {
	return applyIndexPlan(
		planIndex(dbPath, tracker.allNodes().filter(isTask), "all"),
	);
}

// ── Deferred (startup) reconcile ──

/**
 * Serialized background work. One chain for the whole process, so seven
 * projects reconciling at boot cannot run seven concurrent backfills and
 * fight over the same cores.
 */
let backgroundChain: Promise<unknown> = Promise.resolve();

/**
 * Reconcile without ever extending startup.
 *
 * Awaits the PLAN only — one small JSON read, a tree walk, and a hash per
 * document (measured: 3ms for 1200 documents). Everything that touches the
 * `.msp` (143ms to restore a 21MB index) or the embedding model (minutes for a
 * full backfill) is handed to the serialized background chain and is not
 * awaited by the caller.
 *
 * ⚠️ The rule is "anything that touches the .msp or the model is deferred",
 * NOT "anything expensive". A cheapness judgement is a thing a future change
 * gets wrong silently; a categorical rule is not. This is what stops a large
 * backlog — a fresh install, a deleted index, a model upgrade — from ever
 * putting a multi-minute job back on the 30s worker-init budget.
 */
export async function reconcileIndexDeferred(
	dbPath: string,
	tracker: TaskTracker,
): Promise<{ planned: number; pruned: number; deferred: boolean }> {
	const plan = planIndex(dbPath, tracker.allNodes().filter(isTask), "all");
	if (planIsEmpty(plan)) {
		return { planned: 0, pruned: 0, deferred: false };
	}
	const label = `${plan.inserts.length} document(s), ${plan.prunedTasks} pruned task(s)`;
	if (plan.inserts.length > 0) {
		console.log(`[task-index] reconcile deferred to background: ${label}`);
	}
	backgroundChain = backgroundChain.then(async () => {
		const t0 = Date.now();
		try {
			const r = await applyIndexPlan(plan);
			if (r.indexed > 0) {
				console.log(
					`[task-index] background reconcile finished: ${r.indexed} indexed, ${r.pruned} pruned, ${((Date.now() - t0) / 1000).toFixed(1)}s on device ${selectedDevice ?? "none"}`,
				);
			}
		} catch (e) {
			console.error(`[task-index] background reconcile FAILED:`, e);
		}
	});
	return {
		planned: plan.inserts.length,
		pruned: plan.prunedTasks,
		deferred: true,
	};
}

/** Wait for all queued background index work to settle. Test-only. */
export function _waitForBackgroundIndexing(): Promise<unknown> {
	return backgroundChain;
}

// ── Search ──

/** Once-per-process guard for the degraded-search warning below. */
let warnedNaNFallback = false;

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

			// NaN-score fallback: documents stored with the zero vector produce
			// NaN cosine similarity, which contaminates the hybrid fusion
			// score. If ANY hit has NaN, redo as pure BM25 — the entire result
			// set is suspect when the index has mixed embedding coverage.
			//
			// ⚠️ This silence is dangerous and must announce itself. Firing
			// means SEMANTIC SEARCH IS OFF for this query while the product
			// looks fine — the same shape as a device config reporting the
			// device you asked for rather than the one that ran. It has one
			// legitimate cause (documents indexed while no pipeline was
			// available) and that cause is self-healing: `isDocStale` marks an
			// un-embedded document stale once embeddings work, so the next
			// reconcile fixes it. If this keeps appearing after a reconcile,
			// something is writing unusable vectors and the index is degraded.
			if (results.hits.some((h) => !Number.isFinite(h.score))) {
				if (!warnedNaNFallback) {
					warnedNaNFallback = true;
					console.warn(
						`[task-index] hybrid search fell back to keyword-only: some indexed documents have no embedding. ` +
							`Expected right after a BM25-only period (it self-heals on the next reconcile); persistent means the index is degraded.`,
					);
				}
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
 * ⚠️ Zero production callers today (see task 01KYB46KTM). It also no longer has
 * a warm cache to rely on: the startup reconcile used to load every project's
 * DB, and now defers that with everything else it touches. Kept only because
 * deleting a public export is a separate decision from this change.
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
	selectedDevice = null;
	warnedNaNFallback = false;
}

/**
 * Set a mock embedding pipeline. Test-only.
 *
 * Takes only `embed` and synthesizes `embedMany` from it, so the production
 * code has exactly ONE batched path instead of a "does this pipeline batch?"
 * branch that only tests would ever take.
 */
export function _setEmbeddingPipeline(
	pipe: Pick<EmbeddingPipeline, "embed"> | null,
): void {
	embeddingPipeline = pipe
		? {
				embed: pipe.embed,
				embedMany: (texts) => Promise.all(texts.map((t) => pipe.embed(t))),
			}
		: null;
	embeddingPipelinePromise = null;
	selectedDevice = pipe ? "mock" : null;
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
