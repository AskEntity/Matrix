/**
 * Path-based URL routing utilities shared by shell and plugin.
 *
 * URL format: `/<projectId>/<pluginScope>/<pluginPath>`
 * - `<projectId>` — shell's segment. Shell reads/writes it.
 * - `<pluginScope>` — which plugin is active (e.g., "matrix"). Shell reads;
 *   a plugin-switch UI would write it via shell's handlers.
 * - `<pluginPath>` — everything after `<pluginScope>/`. The plugin's
 *   territory; shell passes it to the plugin and the plugin normalizes /
 *   navigates within it via the shell-provided `pushPluginPath` callback.
 *
 * Normalization:
 * - `/` → shell replaceState → `/<firstProjectId>/matrix/`
 * - `/<projectId>` → shell replaceState → `/<projectId>/matrix/`
 * - `/<projectId>/matrix/` → plugin replaceState → `/<projectId>/matrix/<rootTaskId>`
 *   (via shell's pushPluginPath with replace=true once useTasks resolves)
 *
 * Both layers use `replaceState` for normalization (no history pollution)
 * and `pushState` for user-initiated navigation (back/forward preserves
 * view state).
 */

export interface ParsedPath {
	projectId: string | null;
	pluginScope: string | null;
	/** Everything after `/<projectId>/<pluginScope>/`. Never leading-slash. */
	pluginPath: string;
}

export function parsePath(pathname: string): ParsedPath {
	const segments = pathname.split("/").filter(Boolean);
	const projectId = segments[0] ?? null;
	const pluginScope = segments[1] ?? null;
	const pluginPath = segments.slice(2).join("/");
	return { projectId, pluginScope, pluginPath };
}

/**
 * Build a URL path. `pluginPath` may be empty (→ trailing-slash URL) or
 * arbitrary (→ concatenated). Always produces a canonical form; safe to
 * pass to `history.pushState` / `replaceState`.
 */
export function buildPath(
	projectId: string,
	pluginScope: string,
	pluginPath: string,
): string {
	if (pluginPath === "") return `/${projectId}/${pluginScope}/`;
	return `/${projectId}/${pluginScope}/${pluginPath}`;
}
