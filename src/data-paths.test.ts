/**
 * Audit FU5 — dataRoot hardening tests.
 *
 * Covers:
 *  - Schema validation (traversal, absolute, empty, non-ASCII)
 *  - Post-resolve invariant
 *  - Collision detection is path-based
 *  - projectId validation
 *  - Single resolver (grep test: only data-paths.ts constructs paths from dataRoot)
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	DATA_ROOT_PATTERN,
	PROJECT_ID_PATTERN,
	projectDebugDir,
	projectTasksDir,
	projectTreeJsonPath,
	resolveDataRoot,
	validateDataRoot,
	validateProjectId,
} from "./data-paths.ts";
import { checkDataRootCollisions, validatePluginManifest } from "./plugin.ts";

describe("validateDataRoot — shape regex rejects malformed input", () => {
	test("accepts @", () => {
		expect(() => validateDataRoot("@")).not.toThrow();
	});
	test("accepts @/plugin/foo", () => {
		expect(() => validateDataRoot("@/plugin/foo")).not.toThrow();
	});
	test("accepts nested segments with - and _", () => {
		expect(() => validateDataRoot("@/plugin/story-1001_beta")).not.toThrow();
	});
	test("accepts undefined (caller may fill default)", () => {
		expect(() => validateDataRoot(undefined)).not.toThrow();
	});

	test("rejects traversal: @/../etc", () => {
		expect(() => validateDataRoot("@/../etc")).toThrow(/Invalid dataRoot/);
	});
	test("rejects traversal: @/foo/..", () => {
		expect(() => validateDataRoot("@/foo/..")).toThrow(/Invalid dataRoot/);
	});
	test("rejects absolute: /etc", () => {
		expect(() => validateDataRoot("/etc")).toThrow(/Invalid dataRoot/);
	});
	test("rejects no-prefix: foo", () => {
		expect(() => validateDataRoot("foo")).toThrow(/Invalid dataRoot/);
	});
	test("rejects empty string", () => {
		expect(() => validateDataRoot("")).toThrow(/Invalid dataRoot/);
	});
	test("rejects double slashes: @//", () => {
		expect(() => validateDataRoot("@//")).toThrow(/Invalid dataRoot/);
	});
	test("rejects trailing slash: @/", () => {
		// @/ is really "@" + "/" — regex demands /segment after @, not bare /.
		expect(() => validateDataRoot("@/")).toThrow(/Invalid dataRoot/);
	});
	test("rejects backslash: @\\foo", () => {
		expect(() => validateDataRoot("@\\foo")).toThrow(/Invalid dataRoot/);
	});
	test("rejects null byte: @/foo\\0bar", () => {
		expect(() => validateDataRoot("@/foo\0bar")).toThrow(/Invalid dataRoot/);
	});
	test("rejects leading slash after @: @//foo", () => {
		expect(() => validateDataRoot("@//foo")).toThrow(/Invalid dataRoot/);
	});
	test("rejects single dot segment: @/.", () => {
		expect(() => validateDataRoot("@/.")).toThrow(/Invalid dataRoot/);
	});
	test("pattern matches exactly the documented shape", () => {
		// Sanity: keep the regex public constant and the validator in sync.
		expect(DATA_ROOT_PATTERN.test("@")).toBe(true);
		expect(DATA_ROOT_PATTERN.test("@/foo")).toBe(true);
		expect(DATA_ROOT_PATTERN.test("@/../etc")).toBe(false);
	});
});

describe("validateProjectId — shape regex rejects malformed input", () => {
	test("accepts ULID-like strings", () => {
		expect(() => validateProjectId("01KPCY0GC8DBTTHZYH3PRPCT6T")).not.toThrow();
	});
	test("accepts alphanumeric + dash + underscore", () => {
		expect(() => validateProjectId("test-project_42")).not.toThrow();
	});

	test("rejects ..", () => {
		expect(() => validateProjectId("..")).toThrow(/Invalid projectId/);
	});
	test("rejects path separator /", () => {
		expect(() => validateProjectId("foo/bar")).toThrow(/Invalid projectId/);
	});
	test("rejects backslash", () => {
		expect(() => validateProjectId("foo\\bar")).toThrow(/Invalid projectId/);
	});
	test("rejects empty string", () => {
		expect(() => validateProjectId("")).toThrow(/Invalid projectId/);
	});
	test("rejects spaces", () => {
		expect(() => validateProjectId("foo bar")).toThrow(/Invalid projectId/);
	});
	test("rejects dots", () => {
		// Dots could be used to escape via "..", so excluded entirely.
		expect(() => validateProjectId("foo.bar")).toThrow(/Invalid projectId/);
	});
	test("pattern matches documented shape", () => {
		expect(PROJECT_ID_PATTERN.test("01HXYZ")).toBe(true);
		expect(PROJECT_ID_PATTERN.test("..")).toBe(false);
	});
});

describe("resolveDataRoot — canonical resolution + post-resolve invariant", () => {
	test("@ resolves to project root", () => {
		expect(resolveDataRoot("/data", "proj1", "@")).toBe("/data/projects/proj1");
	});
	test("@/plugin/foo resolves under project root", () => {
		expect(resolveDataRoot("/data", "proj1", "@/plugin/foo")).toBe(
			"/data/projects/proj1/plugin/foo",
		);
	});
	test("undefined resolves to project root (same as @)", () => {
		expect(resolveDataRoot("/data", "proj1", undefined)).toBe(
			"/data/projects/proj1",
		);
	});

	test("throws on malformed dataRoot — @/../etc", () => {
		expect(() => resolveDataRoot("/data", "proj1", "@/../etc")).toThrow(
			/Invalid dataRoot/,
		);
	});
	test("throws on absolute dataRoot — /etc", () => {
		expect(() => resolveDataRoot("/data", "proj1", "/etc")).toThrow(
			/Invalid dataRoot/,
		);
	});
	test("throws on malformed projectId — ..", () => {
		expect(() => resolveDataRoot("/data", "..", "@")).toThrow(
			/Invalid projectId/,
		);
	});
	test("throws on malformed projectId with slash", () => {
		expect(() => resolveDataRoot("/data", "../escaped", "@")).toThrow(
			/Invalid projectId/,
		);
	});

	test("resolved path starts with <dataDir>/projects/<projectId>/", () => {
		// Parametric check over every legal dataRoot we can think of.
		const legal = ["@", "@/plugin/foo", "@/a/b/c", "@/x_1"];
		for (const dr of legal) {
			const resolved = resolveDataRoot("/data", "proj1", dr);
			expect(
				resolved === "/data/projects/proj1" ||
					resolved.startsWith("/data/projects/proj1/"),
			).toBe(true);
		}
	});
});

describe("projectTasksDir + projectDebugDir — respect dataRoot", () => {
	test("default layout (no dataRoot) — tasks/ and debug/ at project root", () => {
		expect(projectTasksDir("/data", "proj1")).toBe(
			"/data/projects/proj1/tasks",
		);
		expect(projectDebugDir("/data", "proj1")).toBe(
			"/data/projects/proj1/debug",
		);
	});
	test("nested dataRoot — tasks/ and debug/ inside the plugin subdir", () => {
		expect(projectTasksDir("/data", "proj1", "@/plugin/story1001")).toBe(
			"/data/projects/proj1/plugin/story1001/tasks",
		);
		expect(projectDebugDir("/data", "proj1", "@/plugin/story1001")).toBe(
			"/data/projects/proj1/plugin/story1001/debug",
		);
	});
	test("traversal in dataRoot — throws from projectTasksDir", () => {
		expect(() => projectTasksDir("/data", "proj1", "@/../etc")).toThrow(
			/Invalid dataRoot/,
		);
	});
	test("traversal in dataRoot — throws from projectDebugDir", () => {
		expect(() => projectDebugDir("/data", "proj1", "@/../etc")).toThrow(
			/Invalid dataRoot/,
		);
	});

	test("mutation guard: projectDebugDir output MUST live under projects/<id>/", () => {
		// If someone mutates projectDebugDir to include a '..' in the output
		// or to bypass resolveDataRoot, this invariant fires. Parametric check
		// across several legal dataRoots: every result stays under project root.
		const projectRoot = "/data/projects/proj1";
		for (const dr of [undefined, "@", "@/plugin/foo", "@/a/b"]) {
			const tasksOut = projectTasksDir("/data", "proj1", dr);
			const debugOut = projectDebugDir("/data", "proj1", dr);
			expect(tasksOut.startsWith(`${projectRoot}/`)).toBe(true);
			expect(debugOut.startsWith(`${projectRoot}/`)).toBe(true);
			// Specifically: output must NOT contain ".."
			expect(tasksOut).not.toMatch(/\/\.\.(\/|$)/);
			expect(debugOut).not.toMatch(/\/\.\.(\/|$)/);
		}
	});
});

describe("projectTreeJsonPath — respects dataRoot (P4)", () => {
	test("default layout (no dataRoot) → tree.json at project root", () => {
		expect(projectTreeJsonPath("/data", "proj1")).toBe(
			"/data/projects/proj1/tree.json",
		);
	});
	test("matrix P4 layout — tree.json under plugin/matrix/", () => {
		expect(projectTreeJsonPath("/data", "proj1", "@/plugin/matrix")).toBe(
			"/data/projects/proj1/plugin/matrix/tree.json",
		);
	});
	test("nested dataRoot — tree.json lives inside the resolved subdir", () => {
		expect(projectTreeJsonPath("/data", "proj1", "@/plugin/story1001")).toBe(
			"/data/projects/proj1/plugin/story1001/tree.json",
		);
	});
	test("traversal in dataRoot — throws", () => {
		expect(() => projectTreeJsonPath("/data", "proj1", "@/../etc")).toThrow(
			/Invalid dataRoot/,
		);
	});
	test("mutation guard: output ALWAYS lives under projects/<id>/", () => {
		const projectRoot = "/data/projects/proj1";
		for (const dr of [undefined, "@", "@/plugin/foo", "@/a/b/c"]) {
			const out = projectTreeJsonPath("/data", "proj1", dr);
			expect(out.startsWith(`${projectRoot}/`)).toBe(true);
			expect(out).not.toMatch(/\/\.\.(\/|$)/);
			// All variants end in "tree.json"
			expect(out.endsWith("/tree.json")).toBe(true);
		}
	});
});

describe("validatePluginManifest — rejected malformed manifests", () => {
	test("traversal fails — dataRoot: '@/../etc'", () => {
		expect(() =>
			validatePluginManifest({
				name: "evil",
				scope: "global",
				dataRoot: "@/../etc",
			}),
		).toThrow(/Plugin "evil": Invalid dataRoot/);
	});
	test("no-prefix fails — dataRoot: 'foo'", () => {
		expect(() =>
			validatePluginManifest({
				name: "bad",
				scope: "global",
				dataRoot: "foo",
			}),
		).toThrow(/Plugin "bad": Invalid dataRoot/);
	});
	test("empty string fails — dataRoot: ''", () => {
		expect(() =>
			validatePluginManifest({
				name: "x",
				scope: "global",
				dataRoot: "",
			}),
		).toThrow(/Plugin "x": Invalid dataRoot/);
	});
	test("absolute fails — dataRoot: '/etc'", () => {
		expect(() =>
			validatePluginManifest({
				name: "bad",
				scope: "global",
				dataRoot: "/etc",
			}),
		).toThrow(/Plugin "bad": Invalid dataRoot/);
	});
	test("undefined dataRoot — defaults to @/plugin/<name>, passes", () => {
		expect(() =>
			validatePluginManifest({
				name: "nicely-scoped",
				scope: "global",
			}),
		).not.toThrow();
	});
});

describe("checkDataRootCollisions — path-based, not raw string", () => {
	test("identical @ collides with identical @", () => {
		const plugins = [
			{ name: "alpha", dataRoot: "@" },
			{ name: "beta", dataRoot: "@" },
		];
		expect(checkDataRootCollisions(plugins)).toMatch(/collision/);
	});
	test("empty-string dataRoot throws from collision check (invalid shape)", () => {
		// "" is not a legal dataRoot — collision check runs resolveDataRoot
		// on each plugin, which validates shape and throws. Better than silent
		// "empty means @" normalization that used to hide this class of bug.
		expect(() =>
			checkDataRootCollisions([
				{ name: "bad", dataRoot: "" },
				{ name: "ok", dataRoot: "@" },
			]),
		).toThrow(/Invalid dataRoot/);
	});
	test("trailing slash '@/plugin/foo/' collides with '@/plugin/foo'", () => {
		const plugins = [
			{ name: "a", dataRoot: "@/plugin/foo/" },
			{ name: "b", dataRoot: "@/plugin/foo" },
		];
		expect(checkDataRootCollisions(plugins)).toMatch(/collision/);
	});
	test("different dataRoots do NOT collide", () => {
		const plugins = [
			{ name: "matrix", dataRoot: "@" },
			{ name: "story", dataRoot: "@/plugin/story" },
			{ name: "other", dataRoot: "@/plugin/other" },
		];
		expect(checkDataRootCollisions(plugins)).toBeNull();
	});
	test("defaults (omitted) produce non-colliding paths under plugin/<name>", () => {
		// Each plugin's default is @/plugin/<name> — unique per name.
		const plugins = [{ name: "foo" }, { name: "bar" }];
		expect(checkDataRootCollisions(plugins)).toBeNull();
	});
});

/**
 * Directories that are not our source. SUBTRACTION, not addition: this audit
 * walks the whole repo and removes these, rather than naming the places to
 * look. An include-list fails SILENTLY — new code simply is not covered and
 * nothing anywhere says so — which is exactly what happened here.
 */
const AUDIT_PRUNE_DIRS = new Set([
	"node_modules",
	".git",
	".worktrees", // each sub-agent worktree is a full second copy of the repo
	"dist",
	"out",
	"coverage",
	".cache",
	"_vendor_shims",
]);

/** Every non-test .ts/.tsx in the repo, minus AUDIT_PRUNE_DIRS. */
function auditableSourceFiles(root: string): string[] {
	const files: string[] = [];
	function walk(dir: string) {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) {
				if (AUDIT_PRUNE_DIRS.has(entry)) continue;
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

/**
 * Any string operation applied to a dataRoot-named value: `dataRoot.slice(2)`,
 * `dataRoot.substring(2)`, `dataRoot.replace(...)`, `dataRoot.split("@/")[1]`,
 * `dataRoot[2]`. `\s*` spans newlines on purpose — the formatter is free to
 * wrap a long chain, and `manifest.dataRoot\n\t.replace(…)` is the same call.
 *
 * Not matched, correctly: `resolveDataRoot(...)` and friends (a `(` follows the
 * name, not a `.`), and `x.dataRoot === undefined` (no operation at all).
 *
 * The trailing `\(` is what separates code from PROSE. Five doc comments in
 * this repo end a sentence on the word and start the next with a capital —
 * "…respecting the plugin's dataRoot. Creating the directory eagerly…" — which
 * a bare `dataRoot\.\w+` reads as a method call. Requiring the call parens
 * costs nothing real: a property read like `.length` builds no path.
 */
const DATAROOT_STRING_OP = /\b\w*[Dd]ataRoot\s*(\.[a-zA-Z_$][\w$]*\s*\(|\[)/g;

/**
 * Binding a dataRoot value to a name that does not contain "dataRoot" — the
 * one escape a name-based audit cannot otherwise see, since `const r =
 * cfg.dataRoot; r.slice(2)` puts the operation on a name nothing greps for.
 *
 * ZERO hits today, and that is the point: this fires on the day someone opens
 * the bypass, not before. Do not read its silence as it being unnecessary.
 */
const DATAROOT_ALIAS =
	/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[\w$.?[\]]*\.dataRoot\s*;/g;

/**
 * Operations on a dataRoot that are NOT path construction, named individually.
 *
 * This is the subtraction: the audit starts from EVERY string operation on a
 * dataRoot anywhere in the repo and removes these. An entry that stops being
 * true shows up as an unexplained absence rather than as silence, and a new
 * operation nobody listed here goes red on its own.
 */
const ALLOWED_DATAROOT_OPS = [
	{
		file: "src/plugin.ts",
		op: "dataRoot.replace",
		// dataRoot in, dataRoot out — `effectiveDataRoot` strips trailing
		// slashes and hands the result to resolveDataRoot. It never builds a
		// path, so it is not what the invariant is about.
		why: "effectiveDataRoot normalizes trailing slashes; result feeds resolveDataRoot",
	},
];

describe("source audit — ONLY data-paths.ts turns a dataRoot into a path", () => {
	const REPO_ROOT = join(import.meta.dir, "..");

	test("no file outside data-paths.ts applies a string operation to a dataRoot", () => {
		// Two independent axes, both fixed by planting rather than by reading.
		//
		// SCOPE: this walked `src/` only, for years, while `.mxd/plugin/` —
		// where dataRoot is DEFINED (`dataRoot: "@/plugin/matrix"` in index.ts)
		// — sat outside its reach. A `dataRoot.slice(2)` planted in
		// `.mxd/plugin/scope-opts.ts` left the audit at 54 pass / 0 fail.
		//
		// PATTERN: it then matched the literal string `dataRoot.slice(2)`, so
		// `.substring(2)`, `.replace("@/", "")` and `.split("@/")[1]` all passed
		// silently. Its NAME claimed the invariant; its REGEX claimed sixteen
		// characters. Widening it immediately found a real second site
		// (`effectiveDataRoot`), which the narrow pattern could never have seen.
		const offenders: string[] = [];
		for (const f of auditableSourceFiles(REPO_ROOT)) {
			const rel = f.slice(REPO_ROOT.length + 1);
			if (rel === "src/data-paths.ts") continue; // the ONE allowed resolver
			for (const m of readFileSync(f, "utf-8").matchAll(DATAROOT_STRING_OP)) {
				const op = m[0].replace(/\s+/g, "");
				const allowed = ALLOWED_DATAROOT_OPS.some(
					(a) => a.file === rel && op.startsWith(a.op),
				);
				if (allowed) continue;
				offenders.push(`${rel}: ${op}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test("no file binds a dataRoot to a differently-named local", () => {
		// The alias escape, closed. Without this the audit above is one rename
		// away from seeing nothing at all.
		const offenders: string[] = [];
		for (const f of auditableSourceFiles(REPO_ROOT)) {
			const rel = f.slice(REPO_ROOT.length + 1);
			if (rel === "src/data-paths.ts") continue;
			for (const m of readFileSync(f, "utf-8").matchAll(DATAROOT_ALIAS)) {
				if (!/dataroot/i.test(m[1] ?? "")) offenders.push(`${rel}: ${m[0]}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test("every allowlist entry still corresponds to real code", () => {
		// An allowlist is only a subtraction while its entries are real. A stale
		// entry is a standing permission for an operation nobody is performing —
		// which is exactly how the pre-commit hook came to name a test file that
		// had not existed for four months.
		for (const a of ALLOWED_DATAROOT_OPS) {
			const src = readFileSync(join(REPO_ROOT, a.file), "utf-8");
			expect(src.includes(a.op)).toBe(true);
		}
	});

	test("the walk actually reaches the plugin — where dataRoot is defined", () => {
		// The guard half. Without it, pruning everything (or a walk root that
		// resolves somewhere empty) passes the audit above with zero coverage,
		// which is the failure this whole commit is about. Named files, not a
		// count, so adding a plugin file does not rot it.
		const files = auditableSourceFiles(REPO_ROOT).map((f) =>
			f.slice(REPO_ROOT.length + 1),
		);
		expect(files).toContain(".mxd/plugin/index.ts");
		expect(files).toContain(".mxd/plugin/scope-opts.ts");
		expect(files).toContain(".mxd/plugin/runtime.ts");
		expect(files).toContain("src/data-paths.ts");
	});

	test("the walk does NOT descend into pruned directories", () => {
		// The other guard half: a prune that stops working turns this audit into
		// a scan of every node_modules package on the machine, and `.worktrees`
		// alone is a full second copy of this repo per running sub-agent.
		// Relative paths only: this repo checkout IS itself inside a
		// `.worktrees/` directory, so an absolute path always contains one.
		const files = auditableSourceFiles(REPO_ROOT).map((f) =>
			f.slice(REPO_ROOT.length + 1),
		);
		for (const pruned of AUDIT_PRUNE_DIRS) {
			expect(files.some((f) => f.split("/").includes(pruned))).toBe(false);
		}
	});
});

// ── the data dir itself: ONE derivation, and nobody reads HOME for it ──

/**
 * Any read of the user's home directory: `homedir()` or `process.env.HOME`.
 *
 * The audit above polices paths built from a `dataRoot`. This one polices the
 * level above it — WHERE our data dir is — and it exists because that question
 * had FIVE independent answers, three of which silently ignored
 * `MXD_DATA_DIR`:
 *
 *   src/cli.ts        MXD_DATA_DIR ?? join(homedir(), ".mxd")   ✅ correct
 *   src/daemon.ts     the same expression, character for character
 *   src/config.ts     join(homedir(), ".mxd", "config.json")    ❌ ignored it
 *   src/runtime.ts    dataDir: join(homedir(), ".mxd")          ❌ ignored it
 *   src/cli.ts        `${process.env.HOME}/.mxd/logs`           ❌ ignored it
 *
 * ⭐ The two byte-identical duplicates are what let the other three drift:
 * nobody ever had to reconcile anything, because there was never one place to
 * reconcile. So the fix is not "correct the three" — it is that there be one.
 *
 * MEASURED before the fix: this audit listed 6 offenders across 5 files
 * (`cli-analyze-cache.ts` had a sixth, a default parameter). That run is this
 * test's positive control — it has fired, on purpose, once.
 */
const HOME_READ = /\bhomedir\s*\(\s*\)|process\.env\.HOME\b/;

/**
 * A line that opens as a comment. Skipped, because the sibling audit above
 * learned this the expensive way in the other direction: its pattern once
 * matched PROSE and it bought precision with a required `\(`, which cannot help
 * here — the whole point of the comments this fix leaves behind is that they
 * quote `join(homedir(), ".mxd")` as the thing that was deleted.
 *
 * Known hole, deliberate: `const x = /* c *\/ homedir()` on one line would slip
 * through. Nobody writes that, and the alternative — reddening on prose — trains
 * people to weaken the audit, which costs more than the hole.
 */
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/;

/**
 * Home reads that are NOT our data dir, named individually with the reason.
 * Subtraction: the audit starts from EVERY home read in the repo and removes
 * these, so a new one lands on the offending side and goes red by itself.
 */
const ALLOWED_HOME_READS = [
	{
		file: "src/data-paths.ts",
		marker: "MXD_DATA_DIR",
		why: "THE one derivation — resolveDataDir(). Everything else takes it from here.",
	},
	{
		file: "src/codex-auth.ts",
		marker: '"~',
		why: "expanding a `~` the USER typed. That is what `~` means; we are not choosing a location.",
	},
	{
		file: "src/cli.ts",
		marker: "Library/LaunchAgents",
		why: "macOS genuinely puts LaunchAgents under HOME. Not our data dir, and must not move with it.",
	},
];

describe("source audit — ONE derivation of the data dir, and HOME is not it", () => {
	const REPO_ROOT = join(import.meta.dir, "..");

	test("no file derives our data dir from HOME", () => {
		const offenders: string[] = [];
		for (const f of auditableSourceFiles(REPO_ROOT)) {
			const rel = f.slice(REPO_ROOT.length + 1);
			for (const line of readFileSync(f, "utf-8").split("\n")) {
				if (!HOME_READ.test(line) || COMMENT_LINE.test(line)) continue;
				const allowed = ALLOWED_HOME_READS.some(
					(a) => a.file === rel && line.includes(a.marker),
				);
				if (allowed) continue;
				offenders.push(`${rel}: ${line.trim()}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test("every allowlist entry still corresponds to a real home read", () => {
		// An allowlist is a subtraction only while its entries are real. A stale
		// entry is a standing permission for something nobody is doing — and it
		// would also hide the line that replaced it.
		for (const a of ALLOWED_HOME_READS) {
			const lines = readFileSync(join(REPO_ROOT, a.file), "utf-8").split("\n");
			const hit = lines.some((l) => HOME_READ.test(l) && l.includes(a.marker));
			expect(hit).toBe(true);
		}
	});
});
