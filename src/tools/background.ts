/**
 * Background process management — first-class tool.
 * Extracted from bash.ts to provide a clean separation between command execution
 * and background process lifecycle management.
 *
 * All functions take Maps (from TaskSession) instead of using module-level globals.
 */
import {
	type BackgroundProcess,
	getBackgroundStatus,
	killBackgroundProcess,
} from "./bash.ts";

/** List all background processes from a session's bgMap. */
export function listBackgroundProcesses(
	bgMap: Map<string, BackgroundProcess>,
): { id: string; command: string; status: string; durationMs: number }[] {
	const now = Date.now();
	const result: {
		id: string;
		command: string;
		status: string;
		durationMs: number;
	}[] = [];
	for (const bg of bgMap.values()) {
		// Use endTime for completed processes, now for running ones
		const endPoint = bg.endTime ?? now;
		result.push({
			id: bg.id,
			command: bg.command,
			status: bg.status,
			durationMs: endPoint - bg.startTime,
		});
	}
	return result;
}

/**
 * Move a foreground execution to background.
 * Resolves the external signal promise on the foreground execution,
 * causing the Promise.race in executeBashWithTimeout to finish and return a background handle.
 *
 * Returns null if the execution is not found or already completed.
 */
export function moveToBackground(
	fgMap: Map<string, { resolve: () => void; command: string }>,
	sessionId: string,
	execId: string,
): string | null {
	const entry = fgMap.get(`${sessionId}:${execId}`);
	if (!entry) return null;
	entry.resolve();
	fgMap.delete(`${sessionId}:${execId}`);
	return execId;
}

/**
 * Execute the background management tool.
 * Handles list/status/kill actions on background processes.
 */
export function executeBackgroundTool(
	action: string,
	id: string | undefined,
	bgMap: Map<string, BackgroundProcess>,
): { content: string; isError: boolean } {
	if (action === "list") {
		const processes = listBackgroundProcesses(bgMap);
		if (processes.length === 0) {
			return { content: "No background processes.", isError: false };
		}
		const lines = processes.map((p) => {
			const elapsed = Math.round(p.durationMs / 1000);
			return `  ${p.id}: "${p.command}" (${p.status}, ${elapsed}s)`;
		});
		return {
			content: `Background processes:\n${lines.join("\n")}`,
			isError: false,
		};
	}

	if (!id) {
		return {
			content: "Error: id is required for status and kill actions.",
			isError: true,
		};
	}

	if (action === "kill") {
		const result = killBackgroundProcess(bgMap, id);
		if (result === null) {
			return {
				content: `Background process ${id} not found.`,
				isError: true,
			};
		}
		return { content: result, isError: false };
	}

	if (action === "status") {
		const result = getBackgroundStatus(bgMap, id);
		if (result === null) {
			return {
				content: `Background process ${id} not found.`,
				isError: true,
			};
		}
		return { content: result, isError: false };
	}

	return {
		content: `Unknown action: ${action}. Use 'list', 'status', or 'kill'.`,
		isError: true,
	};
}
