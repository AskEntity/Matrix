/**
 * Verification for the child-process embedder, run against the REAL modules.
 *
 * Spawns a Bun Worker that does what a Matrix plugin worker does — computes an
 * embedding through `task-index.ts` — and then terminates that worker, which is
 * exactly the daemon's shutdown and crash-recovery path.
 *
 * Before the fix this is exit 133. After it, exit 0, and the vector must still
 * be a real one (a fix that quietly degraded to BM25 would also "pass" a
 * crash test, so the dimension and norm are checked too).
 */

const worker = new Worker(
	new URL("./verify-fix-worker.ts", import.meta.url).href,
	{ env: process.env as Record<string, string> },
);

const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
	const timer = setTimeout(
		() => reject(new Error("worker timed out after 240s")),
		240_000,
	);
	worker.onmessage = (e: MessageEvent) => {
		clearTimeout(timer);
		resolve(e.data as Record<string, unknown>);
	};
	worker.onerror = (e: ErrorEvent) => {
		clearTimeout(timer);
		reject(new Error(`worker error: ${e.message}`));
	};
});

console.log("[verify] worker reported:", JSON.stringify(result));

if (!result.ok) {
	console.error("[verify] FAIL — worker could not embed");
	process.exit(1);
}
if (result.dim !== 768) {
	console.error(`[verify] FAIL — expected 768 dims, got ${result.dim}`);
	process.exit(1);
}
const norm = result.norm as number;
if (!(norm > 0.5)) {
	console.error(`[verify] FAIL — degenerate vector (L2 ${norm})`);
	process.exit(1);
}
console.log(
	`[verify] real vector: dim=${result.dim} L2=${norm.toFixed(4)} device=${result.device}`,
);

console.log(
	"[verify] terminating the worker (daemon shutdown / restart path)...",
);
worker.terminate();
await Bun.sleep(2500);

console.log("[verify] PASS — worker terminated, process alive, exiting 0");
process.exit(0);
