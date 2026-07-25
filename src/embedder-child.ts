/**
 * embedder-child.ts — the ONLY place in Matrix that constructs an ORT session.
 *
 * Runs as its own process (`bun src/embedder-child.ts`), spawned by
 * `embedder-client.ts`. It exists for exactly one reason:
 *
 *   A live onnxruntime-node InferenceSession in a thread that is ENDING
 *   aborts the whole process with
 *   `panic: NAPI FATAL ERROR: Error::New napi_create_error` (exit 133).
 *
 * Measured 2026-07-25, one variable at a time (`scripts/napi-repro/`):
 *
 *   | where the session lives        | thread ends by        | result   |
 *   |--------------------------------|-----------------------|----------|
 *   | worker thread                  | parent terminate()    | exit 133 |
 *   | worker thread                  | own process.exit(0)   | exit 133 |
 *   | worker thread, dispose() first | parent terminate()    | exit 133 |
 *   | worker thread, device=webgpu   | parent terminate()    | exit 133 |
 *   | worker thread, NO session      | parent terminate()    | exit 0   |
 *   | MAIN thread                    | process.exit(0)       | exit 0   |
 *
 * The last row is the whole design. A process's main thread only ends when the
 * process ends, and that path is clean. So the session is given a process whose
 * main thread owns it, and Matrix's worker threads — which ARE terminated, both
 * on shutdown and by the daemon's own crash-recovery restart — never load ORT.
 *
 * Lifecycle is inherited rather than managed: when the thread that spawned this
 * child goes away, Bun closes the IPC channel and `disconnect` fires here. We
 * exit on it. That covers worker terminate, worker restart, and daemon
 * shutdown with one mechanism and no bookkeeping in the parent.
 *
 * Protocol (structured clone, so Float32Array crosses without JSON):
 *   parent → child   { type: "embed",  id, texts }
 *   child  → parent  { type: "ready",  device }        once, after verification
 *                    { type: "unavailable" }           verification found no device
 *                    { type: "result", id, vectors }
 *                    { type: "error",  id, message }
 */

import { createVerifiedPipeline, type EmbeddingPipeline } from "./embedding.ts";

type Incoming = { type: "embed"; id: number; texts: string[] };

let pipe: EmbeddingPipeline | null = null;

// The reason this process is allowed to hold a session at all: it exits from
// its own main thread, which is the one teardown path ORT survives.
process.on("disconnect", () => process.exit(0));

/**
 * Requests are serialized through this chain. Concurrent `run()` calls on one
 * transformers.js session interleave badly (the session is stateful about
 * padding), and the parent may legitimately have a backfill batch and a search
 * query in flight at once. Queueing is cheaper than a second session.
 */
let chain: Promise<void> = Promise.resolve();

async function handleEmbed(msg: Incoming): Promise<void> {
	if (!pipe) {
		process.send?.({ type: "error", id: msg.id, message: "no pipeline" });
		return;
	}
	try {
		const vectors = await pipe.embedMany(msg.texts);
		process.send?.({ type: "result", id: msg.id, vectors });
	} catch (e) {
		process.send?.({
			type: "error",
			id: msg.id,
			message: e instanceof Error ? e.message : String(e),
		});
	}
}

process.on("message", (raw: unknown) => {
	const msg = raw as Incoming;
	if (msg?.type !== "embed") return;
	chain = chain.then(() => handleEmbed(msg));
});

async function main(): Promise<void> {
	const selected = await createVerifiedPipeline();
	if (!selected) {
		process.send?.({ type: "unavailable" });
		return;
	}
	pipe = selected.pipe;
	process.send?.({ type: "ready", device: selected.device });
}

main().catch((e) => {
	process.send?.({
		type: "unavailable",
		message: e instanceof Error ? e.message : String(e),
	});
});
