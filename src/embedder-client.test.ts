/**
 * Tests for the child-process embedder.
 *
 * The property being defended is structural: **ORT must never be loaded on a
 * thread that Matrix terminates.** Matrix terminates worker threads on
 * shutdown AND on crash-recovery restart, and a live ORT session in an ending
 * thread aborts the process (`NAPI FATAL ERROR`, exit 133).
 *
 * The end-to-end proof needs a real 500MB model and takes seconds, so it lives
 * in `scripts/napi-repro/` (verify-fix.ts, verify-daemon-shutdown.ts) rather
 * than here. What this file guards is everything that can be checked without
 * the model, and in particular the one line that would silently undo the fix:
 * a static import of the transformers package from a module the worker loads.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("./", import.meta.url).pathname;

describe("embedder: ORT stays off worker threads", () => {
	/**
	 * The regression that matters. `task-index.ts` runs ON a worker thread, so
	 * if it (or anything it imports at module scope) pulls in
	 * `@huggingface/transformers`, the session is back on the worker and the
	 * abort returns — silently, because everything still works until shutdown.
	 *
	 * `embedding.ts` is allowed to name the package, but only inside a
	 * function: `import()` in a function body does not load anything until
	 * called, and the only caller is the child process.
	 */
	test("no module the worker loads statically imports @huggingface/transformers", () => {
		const workerReachable = [
			"task-index.ts",
			"embedder-client.ts",
			"orchestrator-tools.ts",
		];
		for (const file of workerReachable) {
			const src = readFileSync(join(SRC, file), "utf-8");
			// A static import is `import ... from "@huggingface/transformers"`.
			// A lazy one is `await import("@huggingface/transformers")`.
			const staticImport =
				/^\s*import\s[^;]*from\s+["']@huggingface\/transformers["']/m;
			expect(staticImport.test(src)).toBe(false);
		}
	});

	test("embedding.ts only imports transformers lazily, inside a function", () => {
		const src = readFileSync(join(SRC, "embedding.ts"), "utf-8");
		expect(src).toContain('await import("@huggingface/transformers")');
		const staticImport =
			/^\s*import\s[^;]*from\s+["']@huggingface\/transformers["']/m;
		expect(staticImport.test(src)).toBe(false);
	});

	/**
	 * The child is the one process allowed to hold a session, and it is only
	 * safe because it exits from its own MAIN thread. If the `disconnect`
	 * handler goes away, a terminated worker leaves the child running with a
	 * loaded model — one leaked 500MB process per worker restart.
	 */
	test("the child exits when its spawning thread goes away", () => {
		const src = readFileSync(join(SRC, "embedder-child.ts"), "utf-8");
		expect(src).toContain('process.on("disconnect"');
		expect(src).toContain("process.exit(0)");
	});

	/**
	 * `serialization: "advanced"` is what lets vectors cross as structured
	 * clone. Downgrading to JSON would still work, so nothing would fail
	 * loudly — it would just get slower and lossier for Float32Array.
	 */
	test("the IPC channel uses structured clone", () => {
		const src = readFileSync(join(SRC, "embedder-client.ts"), "utf-8");
		expect(src).toContain('serialization: "advanced"');
	});
});

describe("embedder: failure is degradation, not an exception", () => {
	/**
	 * Every path out of the client resolves rather than throws, because the
	 * callers are `searchIndex` (a user is waiting) and the done() lifecycle
	 * (an exception would break task completion). BM25-only is an acceptable
	 * product; a thrown error on those paths is not.
	 */
	test("a child that cannot start yields null, and the client stays usable", async () => {
		const { createChildPipeline, childAlive, stopEmbedderChild } = await import(
			"./embedder-client.ts"
		);
		// Point the spawn at an interpreter that does not exist, so the child
		// can never come up.
		const realExecPath = process.execPath;
		Object.defineProperty(process, "execPath", {
			value: "/nonexistent/bun-that-is-not-there",
			configurable: true,
		});
		try {
			const pipe = await createChildPipeline();
			expect(pipe).toBeNull();
			expect(childAlive()).toBe(false);
		} finally {
			Object.defineProperty(process, "execPath", {
				value: realExecPath,
				configurable: true,
			});
			stopEmbedderChild();
		}
	}, 30_000);

	test("stopEmbedderChild is safe when no child is running", async () => {
		const { stopEmbedderChild, childAlive } = await import(
			"./embedder-client.ts"
		);
		stopEmbedderChild();
		stopEmbedderChild();
		expect(childAlive()).toBe(false);
	});
});
