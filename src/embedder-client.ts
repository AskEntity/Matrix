/**
 * embedder-client.ts — an EmbeddingPipeline backed by a child process.
 *
 * Callers see the same `{ embed, embedMany }` interface an in-process pipeline
 * would give them. The difference is where the ORT session lives: in a child
 * process's MAIN thread rather than in this worker thread.
 *
 * ── Why ──
 * A live onnxruntime-node InferenceSession in a thread that is ENDING aborts
 * the process (`NAPI FATAL ERROR`, exit 133). Matrix's worker threads end
 * routinely — on daemon shutdown, and on the daemon's own crash-recovery
 * worker restart. Before this, one hybrid search was enough to arm the hazard
 * for the rest of the daemon's life: 13 of the last 20 process deaths in
 * daemon.err were this abort, at uptimes up to 18.4 hours, and the daemon had
 * never once exited cleanly. It also converted a slow startup into an
 * unbootable machine — init exceeded the 30s budget, the daemon terminated the
 * worker, the worker held a session, and a recoverable "one plugin failed to
 * load" became a hard failure 23 times over.
 *
 * See `embedder-child.ts` for the measurement table that isolates the trigger,
 * and `scripts/napi-repro/` for the harness that reproduces it in ~2s.
 *
 * ── Failure is degradation, never an exception ──
 * Everything here resolves to null rather than throwing. No embeddings means
 * BM25-only search, which is a worse product but a working one; an exception
 * on the search path or the done() path is not. A child that dies takes the
 * pipeline down with it and search silently becomes BM25 — `childAlive()`
 * exists so tests can assert on that rather than infer it.
 */

import { EMBEDDING_DIM, type EmbeddingPipeline } from "./embedding.ts";

type ChildMsg =
	| { type: "ready"; device: string }
	| { type: "unavailable"; message?: string }
	| { type: "result"; id: number; vectors: number[][] }
	| { type: "error"; id: number; message: string };

/** How long to wait for the child to load + verify a model before giving up. */
const READY_TIMEOUT_MS = 180_000;
/** How long any single embed request may take before it is abandoned. */
const REQUEST_TIMEOUT_MS = 120_000;

type Pending = {
	resolve: (v: number[][]) => void;
	reject: (e: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

let child: ReturnType<typeof Bun.spawn> | null = null;
let selectedDevice: string | null = null;
const pending = new Map<number, Pending>();
let nextId = 1;

/** The device the child verified, or null if no child is running. */
export function embedderDevice(): string | null {
	return selectedDevice;
}

/** Whether a child process is currently up. Test/diagnostic use. */
export function childAlive(): boolean {
	return child !== null;
}

/**
 * Tear down the child. Safe to call when there is none.
 *
 * Callers do NOT need this for normal lifecycle — `disconnect` in the child
 * covers worker terminate, worker restart and daemon shutdown by itself. It
 * exists for tests, and for the case where a caller knows it is finished.
 */
export function stopEmbedderChild(): void {
	failAllPending(new Error("embedder child stopped"));
	if (child) {
		child.kill();
		child = null;
	}
	selectedDevice = null;
}

function failAllPending(err: Error): void {
	for (const p of pending.values()) {
		clearTimeout(p.timer);
		p.reject(err);
	}
	pending.clear();
}

function onChildMessage(raw: unknown): void {
	const msg = raw as ChildMsg;
	if (msg.type === "result") {
		const p = pending.get(msg.id);
		if (!p) return;
		pending.delete(msg.id);
		clearTimeout(p.timer);
		p.resolve(msg.vectors);
		return;
	}
	if (msg.type === "error") {
		const p = pending.get(msg.id);
		if (!p) return;
		pending.delete(msg.id);
		clearTimeout(p.timer);
		p.reject(new Error(msg.message));
	}
}

/**
 * Spawn the child and wait for it to report a verified device.
 *
 * Resolves to null — never throws — when the child cannot produce usable
 * vectors, dies during startup, or takes longer than READY_TIMEOUT_MS. All
 * three mean the same thing to the caller: BM25-only from here.
 */
export async function createChildPipeline(): Promise<EmbeddingPipeline | null> {
	if (child) stopEmbedderChild();

	const childPath = new URL("./embedder-child.ts", import.meta.url).pathname;

	let onReady: (v: string | null) => void = () => {};
	const ready = new Promise<string | null>((resolve) => {
		onReady = resolve;
	});

	try {
		child = Bun.spawn([process.execPath, childPath], {
			ipc(raw) {
				const msg = raw as ChildMsg;
				if (msg.type === "ready") {
					onReady(msg.device);
					return;
				}
				if (msg.type === "unavailable") {
					console.warn(
						`[embedder] child reported no usable device${
							msg.message ? `: ${msg.message}` : ""
						} — degrading to BM25-only`,
					);
					onReady(null);
					return;
				}
				onChildMessage(msg);
			},
			serialization: "advanced",
			// stdout/stderr inherit so the child's device-rejection warnings and
			// any model-download progress land in the daemon log like they did
			// when this ran in-process.
			stdio: ["ignore", "inherit", "inherit"],
			env: process.env as Record<string, string>,
			onExit() {
				child = null;
				selectedDevice = null;
				failAllPending(new Error("embedder child exited"));
				onReady(null);
			},
		});
	} catch (e) {
		console.warn(
			`[embedder] failed to spawn child: ${
				e instanceof Error ? e.message : String(e)
			} — degrading to BM25-only`,
		);
		child = null;
		return null;
	}

	const timer = setTimeout(() => onReady(null), READY_TIMEOUT_MS);
	const device = await ready;
	clearTimeout(timer);

	if (!device) {
		stopEmbedderChild();
		return null;
	}

	selectedDevice = device;
	console.log(
		`[embedder] device: ${device} — verified in child process (pid ${child?.pid}), ORT never loads on a worker thread`,
	);

	const embedMany = (texts: string[]): Promise<number[][]> => {
		if (!child) return Promise.reject(new Error("embedder child not running"));
		if (texts.length === 0) return Promise.resolve([]);
		const id = nextId++;
		return new Promise<number[][]>((resolve, reject) => {
			const timeout = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`embed request ${id} timed out`));
			}, REQUEST_TIMEOUT_MS);
			pending.set(id, { resolve, reject, timer: timeout });
			try {
				child?.send({ type: "embed", id, texts });
			} catch (e) {
				pending.delete(id);
				clearTimeout(timeout);
				reject(e instanceof Error ? e : new Error(String(e)));
			}
		});
	};

	const embed = async (text: string): Promise<number[]> => {
		const [v] = await embedMany([text]);
		if (!v || v.length !== EMBEDDING_DIM) {
			throw new Error("embedder returned no vector");
		}
		return v;
	};

	return { embed, embedMany };
}
