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

describe("source audit — ONLY data-paths.ts performs .slice(2) on dataRoot", () => {
	const REPO_ROOT = join(import.meta.dir, "..");

	test("no file outside data-paths.ts slices a dataRoot string by 2", () => {
		// This walked `src/` only, for years, while `.mxd/plugin/` — where
		// dataRoot is DEFINED (`dataRoot: "@/plugin/matrix"` in index.ts) and
		// where three files pass it around — sat outside its reach. Verified by
		// experiment, not by reading: a `dataRoot.slice(2)` planted in
		// `.mxd/plugin/scope-opts.ts` left the audit at 54 pass / 0 fail.
		const offenders = auditableSourceFiles(REPO_ROOT)
			.filter((f) => !f.endsWith("/src/data-paths.ts")) // the ONE allowed
			.filter((f) => /dataRoot\.slice\(2\)/.test(readFileSync(f, "utf-8")))
			.map((f) => f.slice(REPO_ROOT.length + 1));
		expect(offenders).toEqual([]);
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
