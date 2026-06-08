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

// `pluginApiPrefix` lives in ./plugin-url.ts (zero-import file) so plugin
// web bundles can re-export it via @mxd/types without dragging this module's
// `node:path` transitive dependency into the browser. Server-side callers
// (cli, daemon, tests) import from ./plugin-url.ts directly — one canonical
// location, no re-export.

export interface PluginManifest {
	/** Unique plugin name (e.g., "matrix", "story1001") */
	name: string;

	/**
	 * Plugin scope — additive, never exclusive. A project can be served by
	 * MULTIPLE plugins at once; each plugin ADDS a lens, it never replaces
	 * another. The `<scope>:<project>` address space exists precisely because
	 * one project can have more than one lens.
	 *
	 * - `"global"`: available in EVERY project (e.g. matrix — the coding/dev
	 *   lens). Keyed by plugin name; one worker serves every project, reachable
	 *   for any project under `/api/<name>/...`.
	 * - `"project"`: shipped by the single project that contains it (the
	 *   `.mxd/plugin/` discovered under that project — its product lens). Gets
	 *   its OWN worker, keyed `<projectId>:<name>` so two different projects can
	 *   each ship a same-named plugin without colliding.
	 *
	 * A project that ships its own `scope:"project"` plugin is served by BOTH
	 * its own scope AND every global scope (e.g. `matrix:dchat` dev lens +
	 * `group-chat:dchat` product lens coexist). Shipping a plugin NEVER removes
	 * the matrix dev lens — see `scopesForProject` in daemon.ts.
	 */
	scope: "global" | "project";

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
	 * Called when a project is registered. Runs DAEMON-SIDE, where there is no
	 * TaskTracker — so this hook can create project FILES (memory.md, hooks, git
	 * init, etc.) but CANNOT seed initial tree NODES. To seed starting nodes a
	 * plugin uses the worker-side `ScopeOpts.seedTree` hook (which runs the first
	 * time the worker builds the project's tree). The two are complementary:
	 * onProjectInit = files, seedTree = tree nodes.
	 *
	 * Daemon handles registry only — plugin handles project initialization.
	 *
	 * `globalContext` (installRoot, gitHash, version) is passed so the plugin
	 * can decide its own project-level semantics — e.g., matrix detects
	 * "production install" (projectPath === installRoot && no gitHash) and
	 * skips git init to avoid corrupting an npm-distributed install.
	 */
	onProjectInit?: (
		projectPath: string,
		opts: {
			isNew: boolean;
			globalContext: {
				installRoot: string;
				gitHash: string | null;
				version: string;
			};
		},
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
 * Two plugins collide only when they would write to the same on-disk
 * directory. The resolved data dir is `~/.mxd/projects/<projectId>/<dataRoot>`,
 * so a collision requires BOTH the same resolved dataRoot AND overlapping
 * "project domains":
 *
 * - a `global` plugin writes into EVERY project's dir → universe domain
 * - a `project` plugin writes only into its own project's dir → {projectId}
 *
 * global∩global and global∩project domains always overlap. project(P)∩project(Q)
 * overlaps iff P === Q. So two project-scoped plugins that share a dataRoot but
 * live in DIFFERENT projects (e.g. two projects each shipping a `group-chat`
 * plugin with the default `@/plugin/group-chat`) do NOT collide — their data
 * lands under distinct `projects/<id>/` roots.
 *
 * NOTE this is independent of the additive routing model: even though matrix
 * (global) and a project's own plugin BOTH serve that project, their dataRoots
 * differ (`@/plugin/matrix` vs `@/plugin/<own>`), so the two lenses never write
 * to the same directory. The check guards genuine same-directory clashes only.
 *
 * `scope` defaults to `"global"` when omitted, preserving the original
 * "any two same-dataRoot plugins collide" behavior for callers that don't
 * supply scope/projectId.
 *
 * Compares canonical resolved paths, not raw strings, so `"@"` and a
 * hypothetical `"@/foo/.."` (were it to slip past {@link validateDataRoot})
 * would be caught. Returns null if no collision, else an error message.
 */
export function checkDataRootCollisions(
	plugins: ReadonlyArray<
		Pick<PluginManifest, "name" | "dataRoot"> & {
			scope?: PluginManifest["scope"];
			projectId?: string;
		}
	>,
): string | null {
	// Placeholder dataDir + projectId — values only need to be consistent; the
	// relative subpath is what determines whether two dataRoots collide.
	const CANON_DATA_DIR = "/_mxd_collision_check";
	const CANON_PROJECT_ID = "_canon_project_";
	interface Entry {
		name: string;
		effective: string;
		scope: "global" | "project";
		projectId?: string;
	}
	// canonical resolved dataRoot → plugins that resolve there
	const byRoot = new Map<string, Entry[]>();
	for (const plugin of plugins) {
		const effective = effectiveDataRoot(plugin as PluginManifest);
		const canonical = resolveDataRoot(
			CANON_DATA_DIR,
			CANON_PROJECT_ID,
			effective,
		);
		const entry: Entry = {
			name: plugin.name,
			effective,
			scope: plugin.scope ?? "global",
			projectId: plugin.projectId,
		};
		const group = byRoot.get(canonical);
		if (group) group.push(entry);
		else byRoot.set(canonical, [entry]);
	}

	const collision = (a: Entry, b: Entry): string =>
		`Plugin dataRoot collision: "${a.name}" and "${b.name}" both resolve to "${a.effective}"`;

	for (const [, group] of byRoot) {
		if (group.length < 2) continue;
		// A global plugin shares its dir with every other plugin in the group.
		const firstGlobal = group.find((g) => g.scope === "global");
		if (firstGlobal) {
			const other = group.find((g) => g !== firstGlobal);
			if (other) return collision(firstGlobal, other);
		}
		// No globals: all project-scoped → collide only if two share a projectId.
		const seenPid = new Map<string, Entry>();
		for (const g of group) {
			if (g.projectId === undefined) continue;
			const existing = seenPid.get(g.projectId);
			if (existing) return collision(existing, g);
			seenPid.set(g.projectId, g);
		}
	}
	return null;
}
