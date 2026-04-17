/**
 * Plugin manifest — the contract between daemon and plugins.
 *
 * Each project can have a plugin at .mxd/plugin/index.ts.
 * Daemon discovers plugins by scanning projects.
 *
 * Plugin declares:
 * - name: unique identifier
 * - scope: "global" (available in all projects) or "project" (this project only)
 * - dataRoot: where plugin data lives (default: "@/plugin/<name>/")
 * - web: path to React component for UI
 * - runtime: path to module exporting ScopeOpts builder
 */

import { resolveDataRoot, validateDataRoot } from "./data-paths.ts";

export interface PluginManifest {
	/** Unique plugin name (e.g., "matrix", "story1001") */
	name: string;

	/**
	 * Scope. Only "global" is implemented — every global plugin is available
	 * in every project. "project" (per-project plugin variant) was declared
	 * during design; no code path handles it. Re-introduce when the variant
	 * is genuinely needed.
	 */
	scope: "global";

	/**
	 * Where this plugin's data lives, relative to `~/.mxd/projects/<projectId>/`.
	 *
	 * - `"@"` = project data root (`~/.mxd/projects/<projectId>/`)
	 * - Default (omitted) = `"@/plugin/<name>/"` — namespaced under plugin/<name>/
	 *
	 * Shape must match `/^@(\/[A-Za-z0-9_-]+)*$/` — enforced at daemon startup.
	 *
	 * Used for: EventStore (JSONL), TaskTracker (tree.json), debug snapshots.
	 * Collision: two plugins with the same resolved dataRoot → daemon rejects startup.
	 */
	dataRoot?: string;

	/**
	 * Path to the web UI React component (relative to plugin root).
	 * Exported as default export or named `App`.
	 * Shell dynamically imports this.
	 */
	web?: string;

	/**
	 * Path to the runtime module (relative to plugin root).
	 * Exports a function that builds ScopeOpts for the worker.
	 * Worker dynamically imports this.
	 */
	runtime?: string;

	/**
	 * Called when a project is registered.
	 * Plugin sets up project-specific files (memory.md, hooks, git init, etc.).
	 * Daemon handles registry only — plugin handles project initialization.
	 */
	onProjectInit?: (
		projectPath: string,
		opts: { isNew: boolean },
	) => Promise<void>;
}

// ── dataRoot helpers ──

/**
 * Get the effective dataRoot for a plugin (normalized, no trailing slash).
 * Default: `@/plugin/<name>` when `dataRoot` is omitted.
 *
 * Only two normalizations happen here:
 *  - `undefined` → auto-default (based on plugin name)
 *  - trailing slashes stripped
 *
 * We deliberately do NOT fall back from empty string to `"@"`. An empty string
 * is a user-supplied value; silently reinterpreting it would be the exact
 * "silent misbehavior on malformed input" pattern this audit removes.
 * Validation catches empty string and throws.
 */
export function effectiveDataRoot(manifest: PluginManifest): string {
	if (manifest.dataRoot === undefined) return `@/plugin/${manifest.name}`;
	// Normalize: strip trailing slashes. No further fallback.
	return manifest.dataRoot.replace(/\/+$/, "");
}

/**
 * Validate a plugin manifest — currently just its dataRoot.
 * Runs at daemon startup; throws with a clear message on malformed input.
 */
export function validatePluginManifest(manifest: PluginManifest): void {
	const effective = effectiveDataRoot(manifest);
	try {
		validateDataRoot(effective);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new Error(`Plugin "${manifest.name}": ${msg}`);
	}
}

/**
 * Check for dataRoot collisions among plugins.
 *
 * Two plugins with the same *resolved* dataRoot path would write to the same
 * directory — compare canonical paths, not raw strings, so that `"@"` and a
 * hypothetical `"@/foo/.."` (were it to slip past validation) would be caught.
 *
 * In practice {@link validateDataRoot} is run before this (at daemon startup),
 * so inputs here are already canonical strings. The canonical-path compare is
 * the belt to the validator's braces.
 *
 * Returns null if no collision, or an error message string if collision detected.
 */
export function checkDataRootCollisions(
	plugins: ReadonlyArray<Pick<PluginManifest, "name" | "dataRoot">>,
): string | null {
	const seen = new Map<string, string>(); // canonical resolved path → plugin name
	// Placeholder dataDir + projectId — values only need to be consistent, the
	// relative subpath is what determines collision.
	const CANON_DATA_DIR = "/_mxd_collision_check";
	const CANON_PROJECT_ID = "_canon_project_";
	for (const plugin of plugins) {
		const effective = effectiveDataRoot(plugin as PluginManifest);
		const canonical = resolveDataRoot(
			CANON_DATA_DIR,
			CANON_PROJECT_ID,
			effective,
		);
		const existing = seen.get(canonical);
		if (existing) {
			return `Plugin dataRoot collision: "${existing}" and "${plugin.name}" both resolve to "${effective}"`;
		}
		seen.set(canonical, plugin.name);
	}
	return null;
}
