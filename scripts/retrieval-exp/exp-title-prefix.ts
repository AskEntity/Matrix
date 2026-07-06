/**
 * Experiment: does prepending the title to the description TEXT (before
 * embedding) improve retrieval, vs description-alone and vs title-alone?
 *
 * Protocol (mirrors the 2026-06 /tmp/embed-exp scale runs; pairs regenerated —
 * absolute numbers are NOT comparable to the old 37%/22%, only conditions
 * within THIS run are comparable to each other):
 *   - Corpus: all task nodes with non-empty title+description from the live
 *     matrix tree.json (452 tasks at time of writing).
 *   - Ground-truth pairs: zero-bias automatic "title overlap" — two tasks
 *     whose normalized titles share >= 2 content tokens (len>=3, minus a
 *     small English stopword list). Both directions queried.
 *   - Conditions (same representation on BOTH query and corpus side):
 *       title      = title
 *       desc       = description
 *       titledesc  = title + "\n" + description   <-- the hypothesis under test
 *   - Model: Xenova/multilingual-e5-small (q8), e5 protocol: "passage: "
 *     prefix for corpus, "query: " for queries, mean pooling, normalized.
 *   - Metric: recall@5 / recall@10 — target task ranks in top-k by cosine,
 *     self excluded.
 */
import { pipeline } from "@huggingface/transformers";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TREE = join(
	homedir(),
	".mxd/projects/01KN0H3365HN9W560R7WC3XQ10/plugin/matrix/tree.json",
);

interface Node {
	id: string;
	type?: string;
	title?: string;
	description?: string;
}

// ── corpus ──
const raw = JSON.parse(readFileSync(TREE, "utf8"));
const nodesAny = raw.nodes ?? raw;
const nodes: Node[] = Array.isArray(nodesAny)
	? nodesAny
	: Object.values(nodesAny);
const tasks = nodes.filter(
	(n) => (n.type ?? "task") === "task" && n.title && n.description,
);
console.log(`corpus: ${tasks.length} tasks`);

// ── pairs: title token overlap >= 2 ──
const STOP = new Set(
	"the and for with from into that this when not are its via per after all can use new old out off between over under should would could does don won has have had been was were will its our your their about only more than then them they you what which where how why also just like some any each most very much".split(
		" ",
	),
);
function tokens(title: string): Set<string> {
	return new Set(
		title
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, " ")
			.split(/\s+/)
			.filter((t) => t.length >= 3 && !STOP.has(t)),
	);
}
const toks = tasks.map((t) => tokens(t.title as string));
const pairs: Array<[number, number]> = [];
for (let i = 0; i < tasks.length; i++) {
	for (let j = i + 1; j < tasks.length; j++) {
		let shared = 0;
		for (const t of toks[i] as Set<string>) if ((toks[j] as Set<string>).has(t)) shared++;
		if (shared >= 2) pairs.push([i, j]);
	}
}
console.log(`pairs (shared>=2 title tokens): ${pairs.length} → ${pairs.length * 2} queries`);

// ── embedding ──
const fe = await pipeline("feature-extraction", "Xenova/multilingual-e5-small", {
	dtype: "q8",
});
async function embedAll(texts: string[], tag: string): Promise<Float32Array[]> {
	const out: Float32Array[] = [];
	const B = 16;
	for (let i = 0; i < texts.length; i += B) {
		const batch = texts.slice(i, i + B);
		const res = await fe(batch, { pooling: "mean", normalize: true });
		const [n, d] = res.dims as [number, number];
		const data = res.data as Float32Array;
		for (let r = 0; r < n; r++) out.push(data.slice(r * d, (r + 1) * d));
		if ((i / B) % 8 === 0)
			process.stdout.write(`\r${tag}: ${Math.min(i + B, texts.length)}/${texts.length}   `);
	}
	console.log(`\r${tag}: ${texts.length}/${texts.length} done`);
	return out;
}
function cos(a: Float32Array, b: Float32Array): number {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number);
	return s; // both normalized
}

// ── conditions ──
const conditions: Record<string, (t: Node) => string> = {
	title: (t) => t.title as string,
	desc: (t) => t.description as string,
	titledesc: (t) => `${t.title}\n${t.description}`,
};

const results: Record<string, { r5: number; r10: number }> = {};
for (const [name, repr] of Object.entries(conditions)) {
	const passageVecs = await embedAll(
		tasks.map((t) => `passage: ${repr(t)}`),
		`${name}/passages`,
	);
	const queryVecs = await embedAll(
		tasks.map((t) => `query: ${repr(t)}`),
		`${name}/queries`,
	);
	let hit5 = 0;
	let hit10 = 0;
	let total = 0;
	const evalDir = (qi: number, ti: number) => {
		const q = queryVecs[qi] as Float32Array;
		const scores: Array<[number, number]> = [];
		for (let k = 0; k < tasks.length; k++) {
			if (k === qi) continue;
			scores.push([cos(q, passageVecs[k] as Float32Array), k]);
		}
		scores.sort((a, b) => b[0] - a[0]);
		const rank = scores.findIndex((s) => s[1] === ti);
		if (rank >= 0 && rank < 5) hit5++;
		if (rank >= 0 && rank < 10) hit10++;
		total++;
	};
	for (const [i, j] of pairs) {
		evalDir(i, j);
		evalDir(j, i);
	}
	results[name] = { r5: hit5 / total, r10: hit10 / total };
	console.log(
		`${name}: recall@5=${((hit5 / total) * 100).toFixed(1)}%  recall@10=${((hit10 / total) * 100).toFixed(1)}%  (n=${total})`,
	);
}

console.log("\n=== SUMMARY ===");
for (const [name, r] of Object.entries(results))
	console.log(
		`${name.padEnd(10)} recall@5=${(r.r5 * 100).toFixed(1)}%  recall@10=${(r.r10 * 100).toFixed(1)}%`,
	);
