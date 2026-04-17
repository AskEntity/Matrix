import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	checkDataRootCollisions,
	effectiveDataRoot,
	type PluginManifest,
	resolveDataRoot,
} from "./plugin.ts";

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
		expect(resolveDataRoot(manifest, dataDir, projectId)).toBe(
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
		expect(resolveDataRoot(manifest, dataDir, projectId)).toBe(
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
