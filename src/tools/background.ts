/**
 * Background process management — first-class tool.
 * Extracted from bash.ts to provide a clean separation between command execution
 * and background process lifecycle management.
 *
 * Reuses the same BackgroundProcess infrastructure from bash.ts.
 */
import {
	awaitBackgroundProcess,
	backgroundProcesses,
	getBackgroundStatus,
	killBackgroundProcess,
} from "./bash.ts";

/** List all background processes for a session. */
export function listBackgroundProcesses(
	sessionId: string,
): { id: string; command: string; status: string; durationMs: number }[] {
	const map = backgroundProcesses.get(sessionId);
	if (!map) return [];
	const now = Date.now();
	const result: {
		id: string;
		command: string;
		status: string;
		durationMs: number;
	}[] = [];
	for (const bg of map.values()) {
		result.push({
			id: bg.id,
			command: bg.command,
			status: bg.status,
			durationMs: now - bg.startTime,
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
	sessionId: string,
	execId: string,
): string | null {
	const entry = foregroundExecutions.get(`${sessionId}:${execId}`);
	if (!entry) return null;
	entry.resolve();
	foregroundExecutions.delete(`${sessionId}:${execId}`);
	return execId;
}

/**
 * Cancel an active await on a background process.
 * Currently a no-op since await uses completionPromise which resolves on process exit.
 * Reserved for future use with timeout-based await cancellation.
 */
export function cancelAwait(_sessionId: string, _bgId: string): string | null {
	// Await is blocking on completionPromise — we can't cancel it without
	// killing the process. If the caller wants to stop waiting, they should
	// kill the process instead.
	return "Cannot cancel await — use kill to terminate the process instead.";
}

// foregroundExecutions lives in bash.ts to avoid circular imports.
// It's imported here for moveToBackground.
import { foregroundExecutions } from "./bash.ts";

/**
 * Execute the background management tool.
 * Handles list/status/kill/await actions on background processes.
 */
export async function executeBackgroundTool(
	action: string,
	id: string | undefined,
	_timeout: number | undefined,
	sessionId: string,
): Promise<{ content: string; isError: boolean }> {
	if (action === "list") {
		const processes = listBackgroundProcesses(sessionId);
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
			content: "Error: id is required for status/kill/await actions.",
			isError: true,
		};
	}

	if (action === "kill") {
		const result = killBackgroundProcess(sessionId, id);
		if (result === null) {
			return {
				content: `Background process ${id} not found.`,
				isError: true,
			};
		}
		return { content: result, isError: false };
	}

	if (action === "status") {
		const result = getBackgroundStatus(sessionId, id);
		if (result === null) {
			return {
				content: `Background process ${id} not found.`,
				isError: true,
			};
		}
		return { content: result, isError: false };
	}

	if (action === "await") {
		const result = await awaitBackgroundProcess(sessionId, id);
		if (result === null) {
			return {
				content: `Background process ${id} not found.`,
				isError: true,
			};
		}
		return result;
	}

	return {
		content: `Unknown action: ${action}. Use 'list', 'status', 'kill', or 'await'.`,
		isError: true,
	};
}
