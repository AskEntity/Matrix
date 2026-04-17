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

import { join } from "node:path";

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
 * Default: `@/plugin/<name>` when omitted.
 */
export function effectiveDataRoot(manifest: PluginManifest): string {
	const raw = manifest.dataRoot ?? `@/plugin/${manifest.name}`;
	// Normalize: strip trailing slashes
	return raw.replace(/\/+$/, "") || "@";
}

/**
 * Resolve a plugin's dataRoot to an absolute path for a specific project.
 *
 * `"@"` → `{dataDir}/projects/{projectId}/`
 * `"@/plugin/foo"` → `{dataDir}/projects/{projectId}/plugin/foo/`
 */
export function resolveDataRoot(
	manifest: PluginManifest,
	dataDir: string,
	projectId: string,
): string {
	const root = effectiveDataRoot(manifest);
	if (root === "@") {
		return join(dataDir, "projects", projectId);
	}
	// "@/some/path" → strip "@/" prefix → join under project dir
	return join(dataDir, "projects", projectId, root.slice(2));
}

/**
 * Check for dataRoot collisions among plugins.
 * Two plugins with the same effective dataRoot would write to the same directory.
 *
 * Returns null if no collision, or an error message string if collision detected.
 */
export function checkDataRootCollisions(
	plugins: ReadonlyArray<Pick<PluginManifest, "name" | "dataRoot">>,
): string | null {
	const seen = new Map<string, string>(); // effectiveRoot → plugin name
	for (const plugin of plugins) {
		const root = effectiveDataRoot(plugin as PluginManifest);
		const existing = seen.get(root);
		if (existing) {
			return `Plugin dataRoot collision: "${existing}" and "${plugin.name}" both resolve to "${root}"`;
		}
		seen.set(root, plugin.name);
	}
	return null;
}
