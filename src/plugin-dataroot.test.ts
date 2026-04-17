import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveDataRoot as resolveLowLevel } from "./data-paths.ts";
import {
	checkDataRootCollisions,
	effectiveDataRoot,
	type PluginManifest,
} from "./plugin.ts";

// Convenience wrapper — plugin.ts used to host a manifest-oriented resolver;
// after the dataRoot unification (Audit FU5) the canonical resolver lives in
// data-paths.ts. This test keeps its original shape by wrapping it.
function resolveFromManifest(
	manifest: PluginManifest,
	dataDir: string,
	projectId: string,
): string {
	return resolveLowLevel(dataDir, projectId, effectiveDataRoot(manifest));
}

describe("plugin dataRoot", () => {
	const dataDir = "/tmp/test-mxd";
	const projectId = "proj1";

	test("Matrix plugin with dataRoot '@' resolves to project root", () => {
		const manifest: PluginManifest = {
			name: "matrix",
			scope: "global",
			dataRoot: "@",
		};

		expect(effectiveDataRoot(manifest)).toBe("@");
		expect(resolveFromManifest(manifest, dataDir, projectId)).toBe(
			join(dataDir, "projects", projectId),
		);
	});

	test("plugin without dataRoot defaults to @/plugin/<name>/", () => {
		const manifest: PluginManifest = {
			name: "story1001",
			scope: "global",
			// dataRoot omitted — should default
		};

		expect(effectiveDataRoot(manifest)).toBe("@/plugin/story1001");
		expect(resolveFromManifest(manifest, dataDir, projectId)).toBe(
			join(dataDir, "projects", projectId, "plugin", "story1001"),
		);
	});

	test("two plugins with same dataRoot — collision detected", () => {
		const plugins = [
			{ name: "alpha", dataRoot: "@" },
			{ name: "beta", dataRoot: "@" },
		];

		const result = checkDataRootCollisions(plugins);
		expect(result).not.toBeNull();
		expect(result).toContain("alpha");
		expect(result).toContain("beta");
		expect(result).toContain("collision");
	});

	test("two plugins with different dataRoots — no collision", () => {
		const plugins = [
			{ name: "matrix", dataRoot: "@" },
			{ name: "story1001" }, // defaults to @/plugin/story1001
		];

		const result = checkDataRootCollisions(plugins);
		expect(result).toBeNull();
	});
});
