/**
 * Render all three search-hit surfaces against the REAL project tree and the
 * REAL index, so the thing being judged is what an agent would actually read.
 *
 * The three blocks' entire value is what they look like in the half-second
 * they get, and no unit test can assert that. This is the instrument for the
 * acceptance question: scanning the output, can you separate a draft proposal
 * from a closed task that actually ran?
 *
 * Reads a COPY of the live data (tree.json + index.msp) in a temp dir —
 * `TaskTracker.load()` migrates, and this must never touch a running tree.
 *
 * Run: MXD_DISABLE_EMBEDDINGS=1 bun scripts/render-hit-samples.ts "<query>"
 * (BM25-only: the sample is about FORMAT, and skipping embeddings avoids a
 * 500MB model load for it.)
 */
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatRelatedTasks } from "../.mxd/plugin/scope-opts.ts";
import {
	projectIndexDbPath,
	projectTasksDir,
	projectTreeJsonPath,
} from "../src/data-paths.ts";
import { formatTieredHits } from "../src/orchestrator-tools.ts";
import { resolveDataDir } from "../src/data-paths.ts";
import { createExecutionProbe } from "../src/search-hit-format.ts";
import { searchIndex } from "../src/task-index.ts";
import { TaskTracker } from "../src/task-tracker.ts";

const liveDataDir = resolveDataDir();
const projectId = process.env.MXD_PROJECT_ID ?? "01KN0H3365HN9W560R7WC3XQ10";
const dataRoot = "@/plugin/matrix";
const query = process.argv[2] ?? "scroll position follow mode activity log";

const sandbox = mkdtempSync(join(tmpdir(), "mxd-hit-sample-"));
try {
	// Copy tree + index into the sandbox, preserving the layout the path
	// builders expect. The tasks dir is NOT copied — the execution probe only
	// asks whether a file exists, so it must point at the live directory to
	// give a real answer.
	cpSync(
		projectTreeJsonPath(liveDataDir, projectId, dataRoot),
		projectTreeJsonPath(sandbox, projectId, dataRoot),
		{ recursive: true },
	);
	cpSync(
		projectIndexDbPath(liveDataDir, projectId, dataRoot),
		projectIndexDbPath(sandbox, projectId, dataRoot),
	);

	const tracker = new TaskTracker(
		projectTreeJsonPath(sandbox, projectId, dataRoot),
	);
	await tracker.load();
	const hasExecuted = createExecutionProbe(liveDataDir, projectId, dataRoot);
	const dbPath = projectIndexDbPath(sandbox, projectId, dataRoot);

	console.log(`query: "${query}"`);
	console.log(
		`tasks dir probed: ${projectTasksDir(liveDataDir, projectId, dataRoot)}`,
	);

	// ── Surface 1+2: search_tasks / create_task, via the shared formatter ──
	const hits = await searchIndex(dbPath, query, 6);
	console.log(
		`\n${"=".repeat(78)}\nSURFACE 1 — search_tasks (limit 6 → fullCount 5)\n${"=".repeat(78)}`,
	);
	console.log(formatTieredHits(hits, tracker, 5, hasExecuted));

	console.log(
		`\n${"=".repeat(78)}\nSURFACE 2 — create_task's [Related existing tasks] (fullCount 2)\n${"=".repeat(78)}`,
	);
	const createHits = await searchIndex(dbPath, query, 5);
	console.log(formatTieredHits(createHits, tracker, 2, hasExecuted));

	// ── Surface 3: work_context's [Related past tasks] ──
	console.log(
		`\n${"=".repeat(78)}\nSURFACE 3 — work_context's [Related past tasks] (5 hits)\n${"=".repeat(78)}`,
	);
	const wcHits = await searchIndex(dbPath, query, 5);
	console.log(formatRelatedTasks(wcHits, tracker, hasExecuted));

	// ── Budget: the block is capped at 8000 chars to protect the window ──
	console.log(`\n${"=".repeat(78)}\nBUDGET\n${"=".repeat(78)}`);
	for (const [label, text] of [
		["search_tasks(6)", formatTieredHits(hits, tracker, 5, hasExecuted)],
		["create_task(5)", formatTieredHits(createHits, tracker, 2, hasExecuted)],
		["work_context(5)", formatRelatedTasks(wcHits, tracker, hasExecuted)],
	] as const) {
		// Count "- [" and not "- ": a description body full of markdown bullets
		// otherwise inflates the count, which is how this line first reported 7
		// entries for 5. Leading with the status tag is what makes an entry
		// distinguishable from the text inside one.
		const entries = text.split("\n").filter((l) => l.startsWith("- [")).length;
		console.log(
			`${label.padEnd(18)} ${String(text.length).padStart(5)} chars, ${entries} entries, ${
				new Set(hits.map((h) => h.taskId)).size
			} distinct tasks in the raw hits`,
		);
	}
} finally {
	rmSync(sandbox, { recursive: true, force: true });
}
