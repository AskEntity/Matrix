/**
 * One-shot migration: normalize missing `type` on TaskNode entries in tree.json.
 *
 * Pre-P3 (the "Generalize tree to TaskNode | GeneralNode" refactor):
 *   - TaskNode.type was optional (`type?: "task"`), so existing tree.json
 *     files have TaskNode entries with NO `type` field at all.
 *   - FolderNode entries already carried `type: "folder"` explicitly.
 *
 * Post-P3:
 *   - TaskNode.type is required (`type: "task"`). The runtime type guard
 *     `isTask(node)` narrows on `node.type === "task"` — missing type would
 *     misclassify.
 *
 * This module walks every project's `plugin/matrix/tree.json` and injects
 * `type: "task"` on any node missing it. Idempotent: nodes already having a
 * `type` are left untouched.
 *
 * Called from `createDaemon` after `pm.load()`, before worker startup. Same
 * slot as the (now-deleted) P4 plugin-namespace migration.
 *
 * One-shot: code may be cleaned up in a later round once we're confident all
 * installs have rebooted since P3.
 */

import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectTreeJsonPath } from "./data-paths.ts";

/** Matrix plugin's dataRoot — see `.mxd/plugin/index.ts`. */
const MATRIX_DATA_ROOT = "@/plugin/matrix";

interface TreeFile {
	rootNodeId: string;
	nodes: Array<Record<string, unknown>>;
}

/**
 * Run the migration over all projects in `<dataDir>/projects/*`.
 * Returns a one-line summary of work done (for logging).
 */
export async function migrateTreeNodeTypes(dataDir: string): Promise<{
	projectsScanned: number;
	projectsModified: number;
	nodesFixed: number;
}> {
	const projectsDir = join(dataDir, "projects");
	if (!existsSync(projectsDir)) {
		return { projectsScanned: 0, projectsModified: 0, nodesFixed: 0 };
	}

	let projectsScanned = 0;
	let projectsModified = 0;
	let nodesFixed = 0;

	let entries: string[];
	try {
		entries = await readdir(projectsDir);
	} catch {
		return { projectsScanned: 0, projectsModified: 0, nodesFixed: 0 };
	}

	for (const entry of entries) {
		// Skip dotfiles (e.g. lock files) and any non-projectId entries.
		if (entry.startsWith(".")) continue;

		const treePath = projectTreeJsonPath(dataDir, entry, MATRIX_DATA_ROOT);
		if (!existsSync(treePath)) continue;

		projectsScanned++;

		let raw: string;
		try {
			raw = await readFile(treePath, "utf-8");
		} catch {
			continue; // unreadable — skip, leave untouched
		}

		let data: TreeFile;
		try {
			data = JSON.parse(raw) as TreeFile;
		} catch {
			continue; // unparseable — skip, leave untouched
		}
		if (!Array.isArray(data.nodes)) continue;

		let changedInFile = 0;
		for (const node of data.nodes) {
			// Skip nodes that already have a type (folder or future general types,
			// and already-migrated task nodes).
			if (typeof node.type === "string") continue;

			// A pre-migration TaskNode: missing `type`. Inject "task".
			// We intentionally do NOT try to guess: every node without a `type`
			// field in the pre-migration format was a TaskNode.
			node.type = "task";
			changedInFile++;
		}

		if (changedInFile > 0) {
			projectsModified++;
			nodesFixed += changedInFile;
			await writeFile(treePath, JSON.stringify(data, null, "\t"), "utf-8");
		}
	}

	return { projectsScanned, projectsModified, nodesFixed };
}
