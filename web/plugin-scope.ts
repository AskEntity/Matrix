/**
 * Pure plugin-scope selection for the shell — extracted from ShellApp so it can
 * be unit-tested without a DOM.
 *
 * Mirrors the daemon's `scopesForProject` ADDITIVE rule: a project is served by
 * every global plugin (matrix — the dev lens) PLUS its own `scope:"project"`
 * plugin if it ships one (its product lens). Shipping a plugin ADDS a lens; it
 * never removes the matrix dev lens. The shell uses this to populate the
 * per-project scope SELECTOR and to pick the default lens.
 *
 * GLOBALS-FIRST ordering = the default lens is matrix/dev. Dev-first is the
 * additive-consistent default: matrix is the foundation lens every project
 * always has, the product lens is the addition. Defaulting to product would
 * make first-load identical to the (reverted) exclusive model and hide the
 * addition. (Future: a per-project configurable default — task
 * 01KTJZ07MC0VWM923SBDZHDRP8.)
 */

export interface PluginScope {
	name: string;
	scope: "global" | "project";
	/** The project a `scope:"project"` plugin serves (its product lens). */
	projectId?: string;
}

/**
 * Plugins available for `projectId`: all global plugins, PLUS that project's own
 * project-scoped plugin if it ships one (appended last → globals/dev-first).
 * Preserves the input element type so callers keep their richer `PluginInfo`
 * fields. A null `projectId` (nothing selected yet) → globals only.
 */
export function pluginsForProject<T extends PluginScope>(
	plugins: T[],
	projectId: string | null,
): T[] {
	const globals = plugins.filter((p) => p.scope === "global");
	const own =
		projectId == null
			? undefined
			: plugins.find((p) => p.scope === "project" && p.projectId === projectId);
	return own ? [...globals, own] : globals;
}
