/**
 * Plugin manifest — the contract between daemon and plugins.
 *
 * Each project can have a plugin at .mxd/plugin/index.ts.
 * Daemon discovers plugins by scanning projects.
 *
 * Plugin declares:
 * - name: unique identifier
 * - scope: "global" (available in all projects) or "project" (this project only)
 * - web: path to React component for UI
 * - runtime: path to module exporting ScopeOpts builder
 */

export interface PluginManifest {
	/** Unique plugin name (e.g., "matrix", "story1001") */
	name: string;

	/** Scope: global plugins are available in ALL projects, project plugins only in their own */
	scope: "global" | "project";

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
}
