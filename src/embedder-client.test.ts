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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("./", import.meta.url).pathname;

/** A static import is what loads the module. `await import(...)` does not. */
const STATIC_TRANSFORMERS_IMPORT =
	/^\s*import\s[^;]*from\s+["']@huggingface\/transformers["']/m;

/**
 * Files permitted to statically import the package. **Empty, and it should
 * stay that way** — even `embedder-child.ts` reaches ORT lazily, through
 * `embedding.ts`.
 *
 * If one is ever genuinely needed, adding it here is fine: an entry is a
 * documented exception with a reason next to it. What must not happen is the
 * inverse — a checker that lists what it COVERS, because such a list silently
 * stops covering things (a module gains the property and is never added), and
 * it cannot tell "we chose not to check this" from "this evaporated".
 */
const STATIC_IMPORT_EXEMPT: string[] = [];

/** Every `.ts` under src/, recursively, as paths relative to src/. */
function allSourceFiles(dir = SRC, prefix = ""): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			out.push(...allSourceFiles(join(dir, entry.name), rel));
		} else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
			out.push(rel);
		}
	}
	return out;
}

describe("embedder: ORT stays off worker threads", () => {
	/**
	 * The regression that matters, and the reason this walks rather than lists.
	 *
	 * `task-index.ts` runs ON a worker thread, so if it — or anything it
	 * imports at module scope — pulls in `@huggingface/transformers`, the
	 * session is back on the worker and the abort returns. Silently: everything
	 * keeps working until the next shutdown, which is how this sat unexamined
	 * for two days.
	 *
	 * Reachability is transitive and nobody maintains it by hand. The first
	 * version of this test named three files; `orchestrator-tools.ts` was on it
	 * only because it happens to reach the index today, which is exactly the
	 * kind of fact that changes without anyone noticing. So the check is a
	 * SUBTRACTION over all of src/ instead — it cannot drain, and a new module
	 * is covered the moment it exists.
	 */
	test("NO file in src/ statically imports @huggingface/transformers", () => {
		const offenders = allSourceFiles()
			.filter((f) => !STATIC_IMPORT_EXEMPT.includes(f))
			.filter((f) =>
				STATIC_TRANSFORMERS_IMPORT.test(readFileSync(join(SRC, f), "utf-8")),
			);
		expect(offenders).toEqual([]);
	});

	/** The walk is worthless if it silently covers nothing. */
	test("the walk actually reaches the modules this is about", () => {
		const files = allSourceFiles();
		expect(files.length).toBeGreaterThan(50);
		expect(files).toContain("task-index.ts");
		expect(files).toContain("embedder-child.ts");
		expect(files).toContain("runtime/scope-worker.ts"); // nested dirs too
	});

	/**
	 * A name in an explicit list that no longer exists must be an ERROR, not a
	 * shrug. Found the hard way elsewhere tonight: the pre-commit hook named
	 * five test files and ran four — one had been deleted four days after being
	 * listed, and the runner exits 0 on a path that is not there. A checker
	 * that tolerates a missing entry cannot distinguish "we chose not to check
	 * this" from "this evaporated".
	 */
	test("every exemption names a file that exists", () => {
		for (const f of STATIC_IMPORT_EXEMPT) {
			expect(existsSync(join(SRC, f))).toBe(true);
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
