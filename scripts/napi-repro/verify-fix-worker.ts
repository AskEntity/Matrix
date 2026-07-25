/**
 * Stands in for a Matrix plugin worker: computes an embedding through the real
 * `embedder-client`, the same path `searchIndex` and `applyIndexPlan` take.
 *
 * The point of the test is what this worker does NOT do — load ORT into its
 * own thread. If that ever regresses, terminating this worker aborts the
 * process and `verify-fix.ts` reports exit 133.
 */

import {
	createChildPipeline,
	embedderDevice,
} from "../../src/embedder-client.ts";

async function main() {
	const pipe = await createChildPipeline();
	if (!pipe) {
		postMessage({ ok: false, error: "no pipeline" });
		return;
	}
	const v = await pipe.embed("hello world");
	const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
	postMessage({
		ok: true,
		dim: v.length,
		norm,
		device: embedderDevice(),
	});
}

main().catch((e) => {
	postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
});
