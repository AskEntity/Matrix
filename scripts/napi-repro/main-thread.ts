/**
 * Control: does an ORT session on the MAIN thread abort at process exit?
 *
 * The worker hazard is "a live session in a thread that is ending". The main
 * thread only ends when the process ends — so if the abort is specifically
 * about *worker* thread teardown, this exits 0. If it aborts too, then moving
 * inference to the main thread does NOT avoid the hazard and that option dies.
 *
 * Exit 0 = main thread is safe. Exit 133 = main thread is also unsafe.
 */

const MODEL = "onnx-community/embeddinggemma-300m-ONNX";
const DEVICE = process.env.DEVICE ?? "cpu";

const { pipeline } = await import("@huggingface/transformers");

const extractor = await pipeline("feature-extraction", MODEL, {
	dtype: "q8",
	device: DEVICE,
} as Record<string, unknown>);

const out = (await extractor("hello world", {
	pooling: "mean",
	normalize: true,
})) as { data: Float32Array };

console.log(`[main-thread] inference ok, dim=${out.data.length}`);
console.log("[main-thread] exiting with a LIVE session on this thread...");
process.exit(0);
