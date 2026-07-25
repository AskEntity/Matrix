/**
 * embedding.ts — building a VERIFIED embedding pipeline, and nothing else.
 *
 * Split out of task-index.ts so the code that loads onnxruntime-node can be
 * imported by the embedder child process without dragging in Orama, the
 * tokenizer, or any index machinery. See `embedder-client.ts` for WHY the
 * child process exists at all — the short version is that a live ORT session
 * in a thread that is ending aborts the whole process, so ORT is only ever
 * allowed to live on a process's MAIN thread.
 *
 * This module holds no state. `createVerifiedPipeline()` returns a pipeline or
 * null; the caller owns the singleton. That is what lets the child be the only
 * place a session is ever constructed.
 */

// ── Constants ──

export const EMBEDDING_MODEL = "onnx-community/embeddinggemma-300m-ONNX";
export const EMBEDDING_DTYPE = "q8";
export const EMBEDDING_DIM = 768;

/**
 * Device candidates per platform, best first. `cpu` is always last and always
 * works. Every candidate is VERIFIED before use — a device is selected because
 * it produced a usable vector, never because a config value said it should.
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
export const DEVICE_CANDIDATES: Record<string, string[]> = {
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
export const DEVICE_PROBE_TEXTS = [
	"reconcile ",
	"Fix session recovery bug",
	"The daemon became unbootable because the startup reconcile ran on the worker's ready path, " +
		"and the staleness key was a timestamp that moved for reasons unrelated to indexed content.",
	"这段文字同时包含中文，用来确认分词与嵌入在真实内容上都能正常工作。",
];

// ── Types ──

export type EmbeddingPipeline = {
	/** One text — used for search queries. */
	embed: (text: string) => Promise<number[]>;
	/** Many texts in one session run — used for indexing. */
	embedMany: (texts: string[]) => Promise<number[][]>;
};

// ── Device selection ──

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
export async function tryDevice(
	device: string,
): Promise<EmbeddingPipeline | null> {
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
			`[embedding] device "${device}" rejected: ${
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
 * Walk the platform's candidate list and return the first device that passes
 * verification, together with its name. Returns null if none does — the caller
 * degrades to BM25-only.
 *
 * MXD_EMBEDDING_DEVICE forces a single candidate. It is still verified: an
 * explicit request is not a reason to accept a corrupt index, so a device that
 * fails its probe still falls back to CPU (loudly).
 */
export async function createVerifiedPipeline(): Promise<{
	pipe: EmbeddingPipeline;
	device: string;
} | null> {
	const forced = process.env.MXD_EMBEDDING_DEVICE;
	const candidates = forced
		? [forced, ...(forced === "cpu" ? [] : ["cpu"])]
		: (DEVICE_CANDIDATES[process.platform] ?? ["cpu"]);

	for (const device of candidates) {
		const pipe = await tryDevice(device);
		if (pipe) return { pipe, device };
	}
	return null;
}
