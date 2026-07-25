/**
 * WASM-backend variant of the repro worker.
 *
 * Imports the transformers WEB build, which is compiled with
 * `// ignore-modules:onnxruntime-node` — it has no import of the NAPI module
 * at all, and runs inference through onnxruntime-web (WASM) instead.
 *
 * If the hazard is genuinely "a live ORT *native* session in an exiting
 * thread", this variant must exit 0 AND must not dlopen the native binding.
 */

const MODEL = "onnx-community/embeddinggemma-300m-ONNX";

async function main() {
	// Import the web build explicitly. The package's "node" export condition
	// would otherwise resolve to the onnxruntime-node flavour, and its exports
	// map blocks deep subpath imports — so resolve the file path directly.
	const pkgJson = Bun.resolveSync(
		"@huggingface/transformers/package.json",
		import.meta.dir,
	);
	const webBuild = `${pkgJson.replace(/package\.json$/, "")}dist/transformers.web.js`;

	const tf = (await import(webBuild)) as {
		pipeline: (...a: unknown[]) => Promise<unknown>;
		env: Record<string, unknown>;
	};

	const extractor = (await tf.pipeline("feature-extraction", MODEL, {
		dtype: "q8",
	})) as (
		t: string,
		o: Record<string, unknown>,
	) => Promise<{ data: Float32Array }>;

	const out = await extractor("hello world", {
		pooling: "mean",
		normalize: true,
	});

	postMessage({ ok: true, mode: "wasm", dim: out.data.length });
}

main().catch((e) => {
	postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
});
