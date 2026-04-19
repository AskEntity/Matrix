/**
 * One-shot migration: move per-project runtime data into a plugin namespace.
 *
 * Before:
 *   ~/.mxd/projects/<projectId>/
 *     ├── config.json     (daemon-owned — untouched)
 *     ├── tree.json       → plugin/matrix/tree.json
 *     ├── tasks/          → plugin/matrix/tasks/
 *     └── debug/          → plugin/matrix/debug/
 *
 * After:
 *   ~/.mxd/projects/<projectId>/
 *     ├── config.json                (unchanged)
 *     └── plugin/matrix/
 *         ├── tree.json
 *         ├── tasks/
 *         └── debug/
 *
 * WHY: Under the "matrix is just a plugin" framing, matrix's runtime data
 * belongs in its own plugin-namespaced directory — the same shape any future
 * plugin (e.g. plugin/story1001/) already uses. Currently matrix's data sits
 * at the project top-level because matrix was born as the only plugin, and
 * that special-casing blocks clean plugin growth (`plugin/matrix/tree.json`
 * vs `projects/<id>/tree.json` with `projects/<id>/plugin/story1001/...`
 * alongside — inconsistent).
 *
 * DESIGN:
 * - One-shot: runs once at daemon startup. After success, the new layout
 *   is used forever — no read-side fallback to the old paths.
 * - Idempotent: if `plugin/matrix/tree.json` already exists for a project,
 *   skip it. Safe to re-run.
 * - Per-project isolation: an error on one project logs and continues —
 *   other projects still migrate. No "crash mid-migration" design (user
 *   explicit: "一次成功就好"). A half-moved project is a genuine FS error,
 *   not a scenario we engineer around.
 * - Best-effort scan: listing `projects/` returns all subdirs regardless of
 *   whether they appear in `projects.json`. This handles projects added by
 *   hand or orphaned registry entries.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	statSync,
} from "node:fs";
import { join } from "node:path";

/** Relative path under each project dir where the Matrix plugin's data lives. */
const MATRIX_DATA_REL = join("plugin", "matrix");

/** Files / dirs that live at the top of `projects/<id>/` in the OLD layout. */
const LEGACY_ENTRIES = ["tree.json", "tasks", "debug"] as const;

/** Result of migrating one project. `"skipped"` means already migrated. */
export type ProjectMigrationResult =
	| { projectId: string; status: "migrated"; moved: string[] }
	| { projectId: string; status: "skipped"; reason: string }
	| { projectId: string; status: "error"; message: string };

/** Summary of migrating a whole dataDir. */
export interface MigrationSummary {
	projectsScanned: number;
	migrated: number;
	skipped: number;
	errors: number;
	details: ProjectMigrationResult[];
}

/**
 * Migrate every project under `<dataDir>/projects/` to the plugin-namespace
 * layout.
 *
 * Runs synchronously using `fs.renameSync` + `fs.mkdirSync`; the caller
 * awaits the returned Promise, but internally there's no async I/O —
 * `renameSync` on the same filesystem is an atomic metadata op, much less
 * expensive than a read+write copy.
 *
 * MUST run before any code opens tree.json / tasks/*.jsonl / debug/ paths.
 * In `createDaemon` the call is placed after lock acquisition, before plugin
 * workers spawn (workers' `autoResumeProjects()` is what first reads
 * tree.json).
 */
export async function migrateToPluginNamespace(
	dataDir: string,
): Promise<MigrationSummary> {
	const projectsDir = join(dataDir, "projects");

	if (!existsSync(projectsDir)) {
		// Fresh install — nothing to migrate.
		return {
			projectsScanned: 0,
			migrated: 0,
			skipped: 0,
			errors: 0,
			details: [],
		};
	}

	const entries = safeReaddir(projectsDir);
	const results: ProjectMigrationResult[] = [];

	for (const entry of entries) {
		const projectDir = join(projectsDir, entry);
		// Skip files (e.g. the occasional .DS_Store). Only real dirs are
		// projects.
		if (!isDir(projectDir)) continue;

		const result = migrateProject(projectDir, entry);
		results.push(result);
	}

	const migrated = results.filter((r) => r.status === "migrated").length;
	const skipped = results.filter((r) => r.status === "skipped").length;
	const errors = results.filter((r) => r.status === "error").length;

	return {
		projectsScanned: results.length,
		migrated,
		skipped,
		errors,
		details: results,
	};
}

/**
 * Migrate a single project dir. Exposed for tests; `migrateToPluginNamespace`
 * is the caller everywhere else.
 */
export function migrateProject(
	projectDir: string,
	projectId: string,
): ProjectMigrationResult {
	const targetBase = join(projectDir, MATRIX_DATA_REL);
	const targetTree = join(targetBase, "tree.json");

	// Idempotency gate: if the target already has a tree.json, the project
	// has been migrated before. Skip.
	if (existsSync(targetTree)) {
		return {
			projectId,
			status: "skipped",
			reason: "already migrated (plugin/matrix/tree.json exists)",
		};
	}

	// Nothing to migrate if the project has no legacy files at all (fresh
	// project with no tree.json yet — no-op).
	const legacyPresent = LEGACY_ENTRIES.filter((name) =>
		existsSync(join(projectDir, name)),
	);
	if (legacyPresent.length === 0) {
		return {
			projectId,
			status: "skipped",
			reason: "no legacy data (fresh project)",
		};
	}

	try {
		// Ensure the plugin/matrix/ dir exists. `recursive: true` creates
		// any missing parent (`plugin/`).
		mkdirSync(targetBase, { recursive: true });

		const moved: string[] = [];
		for (const name of legacyPresent) {
			const src = join(projectDir, name);
			const dst = join(targetBase, name);
			// Extremely defensive: if dst already exists, we can't rename
			// over it cleanly on all POSIX variants. This shouldn't happen —
			// the idempotency gate above covers tree.json, and tasks/debug
			// don't exist in the new layout unless they were migrated. But
			// fall back to a descriptive error rather than a cryptic EEXIST.
			if (existsSync(dst)) {
				throw new Error(
					`migration target already exists: ${dst} (old layout still has ${name} at project root)`,
				);
			}
			renameSync(src, dst);
			moved.push(name);
		}

		return { projectId, status: "migrated", moved };
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		console.error(
			`[migration] Failed to migrate project ${projectId} at ${projectDir}:`,
			message,
		);
		return { projectId, status: "error", message };
	}
}

function safeReaddir(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		console.warn(`[migration] Failed to read ${dir}:`, message);
		return [];
	}
}

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}
