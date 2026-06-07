/**
 * Pure shell scope-selection logic. Mirrors the daemon's exclusive-ownership
 * rule: a project that ships its own project-scoped plugin sees ONLY that
 * plugin's scope; every other project sees the global plugins. This is what
 * makes a project like dchat default to ITS scope instead of the global matrix
 * scope (which would 404 against the matrix worker).
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

describe("pluginsForProject — exclusive project ownership in the shell", () => {
	test("a project WITH its own plugin sees ONLY that plugin's scope", () => {
		const result = pluginsForProject([MATRIX, DCHAT], "own");
		expect(result.map((p) => p.name)).toEqual(["dchat"]);
	});

	test("a project WITHOUT its own plugin sees the global plugin(s)", () => {
		const result = pluginsForProject([MATRIX, DCHAT], "some-other-project");
		expect(result.map((p) => p.name)).toEqual(["matrix"]);
	});

	test("null projectId (nothing selected yet) → global plugin(s)", () => {
		const result = pluginsForProject([MATRIX, DCHAT], null);
		expect(result.map((p) => p.name)).toEqual(["matrix"]);
	});

	test("a project plugin only owns ITS project, not another's", () => {
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
		// Two same-named project plugins → each project resolves to ITS own one.
		expect(pluginsForProject([MATRIX, gcP1, gcP2], "p1")).toEqual([gcP1]);
		expect(pluginsForProject([MATRIX, gcP1, gcP2], "p2")).toEqual([gcP2]);
		// A third project with neither → the global.
		expect(
			pluginsForProject([MATRIX, gcP1, gcP2], "p3").map((p) => p.name),
		).toEqual(["matrix"]);
	});

	test("the owning plugin wins even when listed after the global", () => {
		// Order independence: the project match is by projectId, not array order.
		const result = pluginsForProject([MATRIX, DCHAT], "own");
		expect(result).toEqual([DCHAT]);
	});

	test("multiple global plugins are all offered when no project plugin matches", () => {
		const other: PluginScope = { name: "other", scope: "global" };
		const result = pluginsForProject([MATRIX, other, DCHAT], "plain");
		expect(result.map((p) => p.name)).toEqual(["matrix", "other"]);
	});
});
