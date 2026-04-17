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

describe("source audit — ONLY data-paths.ts performs .slice(2) on dataRoot", () => {
	test("no other src/ file slices a dataRoot string by 2", () => {
		const srcDir = new URL("./", import.meta.url).pathname;
		// Walk src/, flag any *.ts (non-test) that contains `dataRoot.slice(2)`.
		// Only data-paths.ts is allowed to do this.
		const offenders: string[] = [];
		function walk(dir: string) {
			for (const entry of readdirSync(dir)) {
				const full = join(dir, entry);
				if (statSync(full).isDirectory()) {
					if (entry === "node_modules" || entry === "web") continue;
					walk(full);
					continue;
				}
				if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
				if (full.endsWith("/data-paths.ts")) continue; // the ONE allowed
				const content = readFileSync(full, "utf-8");
				if (/dataRoot\.slice\(2\)/.test(content)) {
					offenders.push(full.replace(srcDir, ""));
				}
			}
		}
		walk(srcDir);
		expect(offenders).toEqual([]);
	});
});
