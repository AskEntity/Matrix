import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rmdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Migrate ~/.mxd storage from the old scattered layout to the unified layout.
 *
 * OLD layout:
 *   {dataDir}/
 *     projects/{projectId}/        (config.json, tree.json)
 *     sessions/{projectId}/
 *       {taskId}.events.jsonl
 *
 * NEW layout:
 *   {dataDir}/
 *     projects/{projectId}/
 *       config.json, tree.json
 *       tasks/{taskId}.jsonl       (formerly sessions/{projectId}/{taskId}.events.jsonl)
 *       debug/                     (empty; for drift snapshots etc.)
 *
 * This function is safe to call on every startup:
 * - If `{dataDir}/sessions/` does not exist → no-op.
 * - For each project subdirectory inside sessions/: move every `.events.jsonl`
 *   file into the project's new `tasks/` directory, renaming to `.jsonl`.
 * - Partial runs (crash mid-migration) are idempotent: already-moved files
 *   are skipped.
 * - When the project's sessions dir is emptied, remove it. When ALL project
 *   dirs under sessions/ are emptied, remove `{dataDir}/sessions/`.
 *
 * Returns a summary so startup can log what happened.
 */
export async function migrateStorageLayout(
	dataDir: string,
): Promise<MigrationResult> {
	const oldSessionsRoot = join(dataDir, "sessions");
	const result: MigrationResult = {
		migrated: false,
		projectsScanned: 0,
		filesMoved: 0,
		filesSkipped: 0,
		errors: [],
	};

	if (!existsSync(oldSessionsRoot)) {
		return result;
	}

	let projectDirs: string[];
	try {
		projectDirs = await readdir(oldSessionsRoot);
	} catch (e) {
		result.errors.push(
			`Failed to read ${oldSessionsRoot}: ${e instanceof Error ? e.message : String(e)}`,
		);
		return result;
	}

	result.migrated = true;

	for (const projectId of projectDirs) {
		const oldProjectSessionsDir = join(oldSessionsRoot, projectId);
		const newProjectTasksDir = join(dataDir, "projects", projectId, "tasks");
		const newProjectDebugDir = join(dataDir, "projects", projectId, "debug");

		let files: string[];
		try {
			files = await readdir(oldProjectSessionsDir);
		} catch (e) {
			// Not a directory (stray file in sessions/) — skip with error
			result.errors.push(
				`Skipped ${oldProjectSessionsDir}: ${e instanceof Error ? e.message : String(e)}`,
			);
			continue;
		}
		result.projectsScanned++;

		// Create the destination tasks/ (and debug/) dirs up front.
		await mkdir(newProjectTasksDir, { recursive: true });
		await mkdir(newProjectDebugDir, { recursive: true });

		for (const file of files) {
			// Only move JSONL files — leave anything unexpected alone.
			if (!file.endsWith(".events.jsonl") && !file.endsWith(".jsonl")) {
				continue;
			}
			const taskId = file.endsWith(".events.jsonl")
				? file.slice(0, -".events.jsonl".length)
				: file.slice(0, -".jsonl".length);
			const src = join(oldProjectSessionsDir, file);
			const dst = join(newProjectTasksDir, `${taskId}.jsonl`);

			if (existsSync(dst)) {
				// Crash-safe: previous migration wrote the destination.
				// Trust the destination — remove the stale source copy.
				try {
					await rename(src, `${src}.migrated`);
					// Best-effort cleanup of the .migrated backup
					try {
						const { unlink } = await import("node:fs/promises");
						await unlink(`${src}.migrated`);
					} catch {
						/* leave backup if unlink fails */
					}
					result.filesSkipped++;
				} catch (e) {
					result.errors.push(
						`Failed to remove already-migrated source ${src}: ${e instanceof Error ? e.message : String(e)}`,
					);
				}
				continue;
			}

			try {
				await rename(src, dst);
				result.filesMoved++;
			} catch (e) {
				result.errors.push(
					`Failed to move ${src} → ${dst}: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
		}

		// Remove the emptied old project sessions dir.
		try {
			const remaining = await readdir(oldProjectSessionsDir);
			if (remaining.length === 0) {
				await rmdir(oldProjectSessionsDir);
			}
		} catch (e) {
			result.errors.push(
				`Failed to rmdir ${oldProjectSessionsDir}: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}

	// Try to remove the old sessions/ root if now empty.
	try {
		const remaining = await readdir(oldSessionsRoot);
		if (remaining.length === 0) {
			await rmdir(oldSessionsRoot);
		}
	} catch {
		/* non-fatal */
	}

	return result;
}

export interface MigrationResult {
	/** True if the old sessions/ directory existed (migration actually ran). */
	migrated: boolean;
	projectsScanned: number;
	filesMoved: number;
	/** Files that already existed at the destination (from a previous partial migration). */
	filesSkipped: number;
	errors: string[];
}

/** Log a human-readable summary of the migration result. */
export function logMigrationResult(result: MigrationResult): void {
	if (!result.migrated) return;
	console.log(
		`[migrate-storage] Moved ${result.filesMoved} JSONL file(s) across ${result.projectsScanned} project(s). ` +
			`Skipped ${result.filesSkipped}. ${result.errors.length} error(s).`,
	);
	for (const err of result.errors) {
		console.warn(`[migrate-storage] ${err}`);
	}
}
