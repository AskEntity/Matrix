/**
 * The audit that makes "every content change reaches the index" CHECKABLE
 * rather than asserted.
 *
 * Indexing is a first-party part of a task operation, not a side effect bolted
 * on next to one. Two things have to hold for that to be true, and neither is
 * visible in a passing test suite:
 *
 *  1. The only production code that mutates an INDEXED field is the code that
 *     also updates the index. A fourth caller of `tracker.updateTitle` would
 *     otherwise silently stop indexing, and nothing would go red — the tree
 *     would be right and search would quietly drift.
 *  2. Every call site of an operation that changes indexed content actually
 *     supplies its `dataPaths`. The type system already forces the field to be
 *     present; it cannot force it to be non-null, and `null` is a legitimate
 *     value (test harnesses).
 *
 * SUBTRACTION, not addition, per the house rule: walk the whole repo and
 * subtract known-good, rather than listing where to look. An include-list fails
 * silently — new code simply is not covered and nothing says so.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

const PRUNE_DIRS = new Set([
	"node_modules",
	".git",
	".worktrees", // each sub-agent worktree is a full second copy of the repo
	"dist",
	"out",
	"coverage",
	".cache",
	"_vendor_shims",
]);

/** Every non-test .ts/.tsx in the repo, minus PRUNE_DIRS. */
function sourceFiles(root: string): string[] {
	const files: string[] = [];
	function walk(dir: string) {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) {
				if (PRUNE_DIRS.has(entry)) continue;
				walk(full);
				continue;
			}
			if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
			files.push(full);
		}
	}
	walk(root);
	return files;
}

const rel = (f: string) => f.slice(REPO_ROOT.length + 1);

/**
 * The tracker methods that change a field the index stores. Derived from
 * `taskRows()` in task-index.ts: title, description, and each result round.
 */
const CONTENT_MUTATORS = [
	"updateTitle",
	"updateDescription",
	"appendResultRound",
];

/**
 * Matches a CALL (`x.updateTitle(`), not a definition — which is why
 * `src/task-tracker.ts`, where these live, is not in the sanctioned list and
 * must not be added to it.
 */
const CALL_PATTERN = new RegExp(`\\.(${CONTENT_MUTATORS.join("|")})\\s*\\(`);

/**
 * Where a content mutator may be called from, and why each is safe.
 *
 * Adding a row here is a deliberate act: it says "this call site keeps the
 * index in step, or provably does not need to". Do not add one to make a test
 * pass.
 */
const SANCTIONED: Record<string, string> = {
	"src/task-operations.ts":
		"the ONE codepath per task operation — calls syncIndex after tracker.save()",
	".mxd/plugin/scope-opts.ts":
		"onDone appends the round and indexes it through updateTaskIndex",
	"src/orchestrator-tools.ts":
		"rename_folder only — folders are general nodes and are never indexed",
};

describe("audit: every indexed-content mutation is paired with an index write", () => {
	test("no unsanctioned production caller mutates an indexed field", () => {
		const offenders = sourceFiles(REPO_ROOT)
			.filter((f) => CALL_PATTERN.test(readFileSync(f, "utf-8")))
			.map(rel)
			.filter((f) => !(f in SANCTIONED))
			.sort();
		expect(offenders).toEqual([]);
	});

	test("the sanctioned list is not stale — every entry still calls one", () => {
		// The other direction. A sanctioned file that no longer calls anything
		// is a stale exemption, and a stale exemption is how the next real
		// offender gets waved through under a familiar-looking path.
		for (const file of Object.keys(SANCTIONED)) {
			expect({
				file,
				calls: CALL_PATTERN.test(readFileSync(join(REPO_ROOT, file), "utf-8")),
			}).toEqual({ file, calls: true });
		}
	});

	test("the walk reaches both src/ and the plugin", () => {
		// The guard half. A walk that resolves somewhere empty passes the audit
		// above with zero coverage — which is exactly how the data-paths audit
		// was dead for months while reporting green. Named files, not a count,
		// so adding a file does not rot it.
		const files = sourceFiles(REPO_ROOT).map(rel);
		expect(files).toContain("src/task-operations.ts");
		expect(files).toContain("src/task-index.ts");
		expect(files).toContain(".mxd/plugin/scope-opts.ts");
	});

	test("the walk does NOT descend into pruned directories", () => {
		// Relative paths only: this checkout may itself live inside a
		// `.worktrees/` directory, so an absolute path always contains one.
		const files = sourceFiles(REPO_ROOT).map(rel);
		for (const pruned of PRUNE_DIRS) {
			expect(files.some((f) => f.split("/").includes(pruned))).toBe(false);
		}
	});

	test("every production call site of a content-changing op passes a real dataPaths", () => {
		// `dataPaths` is a REQUIRED field, so the compiler guarantees it is
		// present. It cannot guarantee it is not `null`, and `null` is a
		// legitimate value — it means "this caller has no index". Production
		// callers must never say that, and only this audit can tell.
		const callers = sourceFiles(REPO_ROOT).filter((f) =>
			/\b(createTaskOp|updateTaskOp|deleteTaskOp)\s*\(/.test(
				readFileSync(f, "utf-8"),
			),
		);

		// Two call sites, plus the file that defines the ops.
		expect(callers.map(rel).sort()).toEqual([
			"src/orchestrator-tools.ts",
			"src/runtime/routes/tasks.ts",
			"src/task-operations.ts",
		]);

		for (const file of callers) {
			if (rel(file) === "src/task-operations.ts") continue;
			const src = readFileSync(file, "utf-8");
			const nullish = src.match(/dataPaths:\s*(null|undefined)/g) ?? [];
			expect({ file: rel(file), nullDataPaths: nullish }).toEqual({
				file: rel(file),
				nullDataPaths: [],
			});
			// One `dataPaths:` per op invocation in the file.
			const supplied = (src.match(/dataPaths:/g) ?? []).length;
			const invocations = (
				src.match(/\b(createTaskOp|updateTaskOp|deleteTaskOp)\s*\(/g) ?? []
			).length;
			expect({ file: rel(file), supplied }).toEqual({
				file: rel(file),
				supplied: invocations,
			});
		}
	});
});
