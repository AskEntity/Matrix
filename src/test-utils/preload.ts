/**
 * bun test preload — runs ONCE per test process, before any test file.
 *
 * ── React scheduler binding ──
 * Imports react-dom/client while NO happy-dom environment is registered.
 * React's scheduler picks its timer machinery (MessageChannel & friends) at
 * FIRST IMPORT and react-dom is a process-wide singleton, so whoever imports
 * it first decides whether React's render flushing survives the rest of the
 * run:
 *
 *   - First import under plain bun globals → scheduler binds bun-native
 *     timers → immortal; every happy-dom register/unregister cycle in every
 *     subsequent web test file renders fine.
 *   - First import inside a registered happy-dom environment → scheduler
 *     binds THAT window's machinery → when the file's afterAll calls
 *     GlobalRegistrator.unregister(), scheduled render work stops flushing
 *     → every LATER test file's React renders silently produce nothing
 *     (assertion failures / 5s render timeouts across the whole web suite).
 *
 * bun's test-file execution order is filesystem-dependent (NOT alphabetical),
 * so without this preload the suite's fate depends on which web test file
 * happens to run first — adding an unrelated test file can reshuffle the
 * order and break dozens of green tests. This was observed live: the suite
 * was green with web/ShellApp.test.tsx first; adding new web test files
 * moved a happy-dom-registering file into pole position and 52 tests across
 * 11 web files started failing.
 *
 * Empirical proof of the mechanism (2026-07-02): a probe file that
 * register()s happy-dom → dynamically imports react-dom → renders →
 * unregister()s breaks all React rendering in subsequent test files; the
 * identical probe with a TOP-LEVEL react-dom import (bound before
 * registration) leaves subsequent files green.
 *
 * Cost: one react-dom parse (~tens of ms) per test process, including
 * src-only runs. No side effects beyond module initialization.
 *
 * ── NAPI crash prevention ──
 * MXD_DISABLE_EMBEDDINGS prevents @huggingface/transformers (and its
 * onnxruntime-node NAPI dependency) from loading inside worker threads.
 * Without this, worker teardown in daemon tests triggers a fatal NAPI crash
 * (SIGTRAP / exit 133) that kills the entire bun test process. The env var
 * is checked by getEmbeddingPipeline() in src/task-index.ts, which short-
 * circuits to null (BM25-only mode). Workers inherit process.env from the
 * parent thread, so setting it here covers both the main process and all
 * spawned workers.
 */
process.env.MXD_DISABLE_EMBEDDINGS = "1";
import "react-dom/client";
