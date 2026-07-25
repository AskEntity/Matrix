/**
 * Repro harness for: an ORT InferenceSession living in a Bun Worker aborts
 * the whole process when that thread exits.
 *
 * Usage:
 *   bun scripts/napi-repro/run.ts                     # default: session + terminate
 *   MODE=import-only bun scripts/napi-repro/run.ts    # control — should survive
 *   MODE=dispose     bun scripts/napi-repro/run.ts
 *   MODE=self-exit   bun scripts/napi-repro/run.ts
 *   DEVICE=webgpu    bun scripts/napi-repro/run.ts
 *
 * Exit code IS the result:
 *   0   — the process exited cleanly (bug absent / fixed)
 *   133 — SIGTRAP from `panic: NAPI FATAL ERROR` (bug present)
 *
 * Keep this harness. It is the only way to tell a fix from a coincidence,
 * and it is device- and version-independent.
 */

const MODE = process.env.MODE ?? "session";
const DEVICE = process.env.DEVICE ?? "cpu";

console.log(`[repro] MODE=${MODE} DEVICE=${DEVICE} bun=${Bun.version}`);

const worker = new Worker(new URL("./worker.ts", import.meta.url).href, {
	env: { ...process.env, MODE, DEVICE } as Record<string, string>,
});

const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
	const timer = setTimeout(
		() => reject(new Error("worker timed out after 180s")),
		180_000,
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

console.log("[repro] worker reported:", JSON.stringify(result));

if (MODE === "self-exit") {
	// The worker exits itself; just wait long enough for the abort to land.
	console.log("[repro] waiting for worker self-exit...");
	await Bun.sleep(2000);
} else {
	console.log("[repro] terminating worker...");
	worker.terminate();
	await Bun.sleep(1000);
}

console.log("[repro] SURVIVED — exiting 0");
process.exit(0);
