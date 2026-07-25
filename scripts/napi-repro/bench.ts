/**
 * Cost of moving embedding into a child process.
 *
 * The comparison that matters is against the in-process numbers measured by
 * 01KYD25J on this machine (webgpu, embeddinggemma-300m q8): batch 32 →
 * 43.5ms wall and 5.3ms CPU per document. This measures the same shape through
 * IPC, so the delta is the process boundary and the structured-clone of the
 * vectors — nothing else changed.
 */

import {
	createChildPipeline,
	embedderDevice,
} from "../../src/embedder-client.ts";

const DOCS = Array.from(
	{ length: 64 },
	(_, i) =>
		`Document ${i}: the daemon became unbootable because the startup reconcile ran on the worker's ready path, and the staleness key was a timestamp that moved for reasons unrelated to indexed content.`,
);

const t0 = Date.now();
const pipe = await createChildPipeline();
const spawnMs = Date.now() - t0;
if (!pipe) {
	console.error("no pipeline — cannot benchmark");
	process.exit(1);
}
console.log(
	`spawn + model load + verify : ${spawnMs}ms   (device ${embedderDevice()})`,
);

// Single embed — the search-query shape. Latency is what matters here; a user
// is waiting on it.
const singleTimes: number[] = [];
for (let i = 0; i < 10; i++) {
	const s = Date.now();
	await pipe.embed(`query number ${i} about session recovery`);
	singleTimes.push(Date.now() - s);
}
singleTimes.sort((a, b) => a - b);
console.log(
	`single embed (search query)  : median ${singleTimes[5]}ms  min ${singleTimes[0]}ms  max ${singleTimes[9]}ms`,
);

// Batched — the backfill shape. Throughput is what matters; it runs in the
// background next to agents.
const b0 = Date.now();
for (let i = 0; i < DOCS.length; i += 32) {
	await pipe.embedMany(DOCS.slice(i, i + 32));
}
const batchMs = Date.now() - b0;
console.log(
	`batch 32 over ${DOCS.length} docs        : ${batchMs}ms total = ${(batchMs / DOCS.length).toFixed(1)}ms/doc wall`,
);
console.log(`  (in-process baseline was 43.5ms/doc wall on webgpu)`);

process.exit(0);
