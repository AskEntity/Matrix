/**
 * Plugin URL prefix — the one place `/api/<name>` is spelled out.
 *
 * Kept in its own file with ZERO imports so that `web/runtime-types.ts` can
 * re-export it to the browser bundle without dragging in `src/plugin.ts`'s
 * transitive chain (data-paths.ts → `node:path`). Before this split, Bun's
 * `target: "browser"` polyfilled the full `node:path` module (~10KB of
 * assertPath/normalize/resolve/join/dirname/...) into every plugin's first
 * load — a 60× regression over the bare prefix function.
 *
 * Single source of truth — both daemon (prefix strip) and plugin web/CLI
 * (prefix prepend) import this function so any format change propagates
 * atomically. There is NO shell wrapper that rewrites URLs; every call site
 * composes the prefix explicitly.
 */
export function pluginApiPrefix(pluginName: string): string {
	return `/api/${pluginName}`;
}
