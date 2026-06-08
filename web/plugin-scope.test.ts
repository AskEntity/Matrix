/**
 * Pure shell scope-selection logic. Mirrors the daemon's ADDITIVE ownership
 * rule: a project that ships its own project-scoped plugin sees BOTH that
 * plugin's scope AND the global plugins (dual lenses); every other project sees
 * the global plugins. GLOBALS-FIRST → the default (first) lens is matrix/dev,
 * with the product lens offered in the selector.
 *
 * This is the redo of the REVERTED exclusive logic, where a project with its
 * own plugin saw ONLY that plugin. The key inversion: dchat now sees BOTH
 * `matrix` AND `dchat`, defaulting to `matrix`.
 */
import { describe, expect, test } from "bun:test";
import { type PluginScope, pluginsForProject } from "./plugin-scope.ts";

const MATRIX: PluginScope = {
	name: "matrix",
	scope: "global",
	projectId: "matrix",
};
const DCHAT: PluginScope = {
	name: "dchat",
	scope: "project",
	projectId: "own",
};

describe("pluginsForProject — additive dual lenses in the shell", () => {
	test("a project WITH its own plugin sees BOTH the global AND its own scope", () => {
		const result = pluginsForProject([MATRIX, DCHAT], "own");
		// globals-first → matrix is the default (first) lens, dchat is offered too.
		expect(result.map((p) => p.name)).toEqual(["matrix", "dchat"]);
	});

	test("default (first) lens for a project with its own plugin is the DEV lens", () => {
		const result = pluginsForProject([MATRIX, DCHAT], "own");
		expect(result[0]?.name).toBe("matrix");
	});

	test("a project WITHOUT its own plugin sees the global plugin(s) only", () => {
		const result = pluginsForProject([MATRIX, DCHAT], "some-other-project");
		expect(result.map((p) => p.name)).toEqual(["matrix"]);
	});

	test("null projectId (nothing selected yet) → global plugin(s)", () => {
		const result = pluginsForProject([MATRIX, DCHAT], null);
		expect(result.map((p) => p.name)).toEqual(["matrix"]);
	});

	test("a project plugin is offered only for ITS project, not another's", () => {
		const gcP1: PluginScope = {
			name: "group-chat",
			scope: "project",
			projectId: "p1",
		};
		const gcP2: PluginScope = {
			name: "group-chat",
			scope: "project",
			projectId: "p2",
		};
		// Two same-named project plugins → each project sees matrix + ITS own one.
		expect(
			pluginsForProject([MATRIX, gcP1, gcP2], "p1").map((p) => p.name),
		).toEqual(["matrix", "group-chat"]);
		expect(pluginsForProject([MATRIX, gcP1, gcP2], "p1")[1]).toBe(gcP1);
		expect(pluginsForProject([MATRIX, gcP1, gcP2], "p2")[1]).toBe(gcP2);
		// A third project with neither → just the global.
		expect(
			pluginsForProject([MATRIX, gcP1, gcP2], "p3").map((p) => p.name),
		).toEqual(["matrix"]);
	});

	test("the owning plugin is appended even when listed before the global", () => {
		// Order independence of the INPUT: own is still appended after globals.
		const result = pluginsForProject([DCHAT, MATRIX], "own");
		expect(result.map((p) => p.name)).toEqual(["matrix", "dchat"]);
	});

	test("multiple global plugins are all offered, own appended last", () => {
		const other: PluginScope = { name: "other", scope: "global" };
		const result = pluginsForProject([MATRIX, other, DCHAT], "own");
		expect(result.map((p) => p.name)).toEqual(["matrix", "other", "dchat"]);
	});

	test("multiple globals, project without own plugin → all globals, no project scope", () => {
		const other: PluginScope = { name: "other", scope: "global" };
		const result = pluginsForProject([MATRIX, other, DCHAT], "plain");
		expect(result.map((p) => p.name)).toEqual(["matrix", "other"]);
	});
});
