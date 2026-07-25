/**
 * Repro worker: creates an ORT InferenceSession (via transformers.js
 * feature-extraction pipeline), runs one inference, then signals the parent.
 *
 * The parent then terminates this worker. The bug: a live ORT
 * InferenceSession in a thread that is ending aborts the whole process
 * with `panic: NAPI FATAL ERROR: Error::New napi_create_error` (exit 133).
 *
 * Variants are selected by the MODE env var:
 *   import-only  — import the module, never create a session (control: survives)
 *   session      — create a session + infer (the trigger)
 *   dispose      — create a session + infer + dispose() before exiting
 *   self-exit    — create a session + infer, then process.exit(0) from here
 */

const MODE = process.env.MODE ?? "session";
const DEVICE = process.env.DEVICE ?? "cpu";
const MODEL = "onnx-community/embeddinggemma-300m-ONNX";

async function main() {
	const { pipeline } = await import("@huggingface/transformers");

	if (MODE === "import-only") {
		postMessage({ ok: true, mode: MODE });
		return;
	}

	const extractor = await pipeline("feature-extraction", MODEL, {
		dtype: "q8",
		device: DEVICE,
	} as Record<string, unknown>);

	const out = await extractor("hello world", {
		pooling: "mean",
		normalize: true,
	});
	const dim = (out as { data: Float32Array }).data.length;

	if (MODE === "dispose") {
		await (extractor as unknown as { dispose: () => Promise<void> }).dispose();
	}

	postMessage({ ok: true, mode: MODE, device: DEVICE, dim });

	if (MODE === "self-exit") {
		// Give postMessage a tick to flush, then exit from inside the worker.
		setTimeout(() => process.exit(0), 50);
	}
}

main().catch((e) => {
	postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
});
