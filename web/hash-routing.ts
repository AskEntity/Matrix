/**
 * URL hash routing for the Matrix UI.
 *
 * Format: `#projectId/taskId/entry=<ts>`
 *
 * - `projectId` — required to show a project
 * - `taskId` — optional (omitted = orchestrator view)
 * - `entry=<ts>` — optional permalink fragment. One-shot: seeds the initial
 *   scroll target to anchor on that entry, then is dropped from the URL.
 *
 * The `entry=` prefix is reserved so future address schemes can be added
 * without breaking backward compatibility (e.g. `entry=id:<n>` or
 * `entry=commit:<sha>`).
 */

export interface ParsedHash {
	projectId?: string;
	taskId?: string;
	entryTs?: number;
}

export function parseHashString(raw: string): ParsedHash {
	const trimmed = raw.replace(/^#/, "");
	if (!trimmed) return {};
	const parts = trimmed.split("/");
	const projectId = parts[0] || undefined;
	const taskId = parts[1] || undefined;
	let entryTs: number | undefined;
	const entrySeg = parts[2];
	if (entrySeg?.startsWith("entry=")) {
		const val = entrySeg.slice("entry=".length);
		const n = Number(val);
		if (Number.isFinite(n)) entryTs = n;
	}
	return { projectId, taskId, entryTs };
}

export function formatHashString(
	projectId: string,
	taskId: string | null,
	rootNodeId: string | null,
): string {
	if (taskId && taskId !== rootNodeId) {
		return `#${projectId}/${taskId}`;
	}
	if (projectId) return `#${projectId}`;
	return "";
}
