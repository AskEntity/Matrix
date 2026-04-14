/**
 * Matrix plugin manifest — the coding IDE.
 *
 * Registered as scope: "global" — available in all projects.
 * This is NOT special-cased. Any plugin can register as global.
 */
import type { PluginManifest } from "../../src/plugin.ts";

const manifest: PluginManifest = {
	name: "matrix",
	scope: "global",
	web: "./web/App.tsx",
	runtime: "./runtime.ts",
};

export default manifest;
