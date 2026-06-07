/**
 * Pure plugin-scope selection for the shell — extracted from ShellApp so it can
 * be unit-tested without a DOM.
 *
 * Mirrors the daemon's `pluginForProject` ownership rule: a project that ships
 * its OWN project-scoped plugin is served EXCLUSIVELY by it (routing to the
 * global matrix worker would 404). Every other project sees the global plugins.
 * The shell uses this to decide which scope(s) to offer per project and which
 * scope to default to.
 */

export interface PluginScope {
	name: string;
	scope: "global" | "project";
	/** The project a `scope:"project"` plugin exclusively serves. */
	projectId?: string;
}

/**
 * Plugins available for `projectId`: that project's own project-scoped plugin
 * if it ships one, otherwise all global plugins. Preserves the input element
 * type so callers keep their richer `PluginInfo` fields.
 */
export function pluginsForProject<T extends PluginScope>(
	plugins: T[],
	projectId: string | null,
): T[] {
	const own = plugins.find(
		(p) => p.scope === "project" && p.projectId === projectId,
	);
	return own ? [own] : plugins.filter((p) => p.scope === "global");
}
