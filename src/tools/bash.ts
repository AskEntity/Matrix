import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import type { MessageQueue } from "../message-queue.ts";

// ── Background Process Manager ──

/** A background process tracked by the server. */
export interface BackgroundProcess {
	id: string;
	command: string;
	startTime: number;
	stdout: string;
	stderr: string;
	exitCode: number | null;
	status: "running" | "completed" | "failed";
}

/**
 * Per-session map of background processes.
 * Outer key = session/agent identifier, inner key = background process ID.
 * Cleaned up when session ends.
 */
export const backgroundProcesses = new Map<
	string,
	Map<string, BackgroundProcess>
>();

/** Get the background process map for a session, creating if needed. */
export function getSessionBackgroundProcesses(
	sessionId: string,
): Map<string, BackgroundProcess> {
	let map = backgroundProcesses.get(sessionId);
	if (!map) {
		map = new Map();
		backgroundProcesses.set(sessionId, map);
	}
	return map;
}

/** Get running background process count for a session. */
export function getRunningBackgroundCount(sessionId: string): number {
	const map = backgroundProcesses.get(sessionId);
	if (!map) return 0;
	let count = 0;
	for (const bg of map.values()) {
		if (bg.status === "running") count++;
	}
	return count;
}

/** Get running background commands summary for a session. */
export function getRunningBackgroundSummary(sessionId: string): string {
	const map = backgroundProcesses.get(sessionId);
	if (!map) return "";
	const running: string[] = [];
	for (const bg of map.values()) {
		if (bg.status === "running") {
			const elapsed = Date.now() - bg.startTime;
			running.push(
				`  ${bg.id}: "${bg.command}" (running ${Math.round(elapsed / 1000)}s)`,
			);
		}
	}
	return running.join("\n");
}

/** Clean up all background processes for a session. */
export function cleanupSessionBackgroundProcesses(sessionId: string): void {
	backgroundProcesses.delete(sessionId);
}

/**
 * Spawn a bash command with foreground timeout support.
 * If the command completes within foregroundTimeout, returns the result directly.
 * If foregroundTimeout is 0 or the command exceeds it, moves to background and returns partial output.
 *
 * @param command - The bash command to execute
 * @param cwd - Working directory
 * @param fallbackCwd - Fallback if cwd doesn't exist (worktree root)
 * @param foregroundTimeout - Ms to wait in foreground (0 = immediate background)
 * @param hardTimeout - Hard kill timeout in ms (default 120000)
 * @param sessionId - Session ID for background tracking
 * @param queue - Message queue for background completion notifications
 */
export async function executeBashWithTimeout(
	command: string,
	cwd: string,
	fallbackCwd: string | undefined,
	foregroundTimeout: number,
	hardTimeout: number,
	sessionId: string | undefined,
	queue: MessageQueue | undefined,
): Promise<{
	content: string;
	isError: boolean;
	cwd?: string;
}> {
	const CWD_MARKER = "___OPENGRAFT_CWD___";

	// Fall back if tracked CWD no longer exists
	let effectiveCwd = cwd;
	if (!existsSync(cwd)) {
		effectiveCwd = fallbackCwd ?? cwd;
	}

	const cdWrapper = `cd() { local t="${"$"}{1:-${"$"}HOME}"; local r; r=${"$"}(builtin cd "${"$"}t" 2>/dev/null && pwd); if [ "${"$"}(pwd)" = "${"$"}r" ]; then echo "bash: cd: ${"$"}(pwd): already in this directory" >&2; return 1; fi; builtin cd "${"$"}t"; }; `;
	const wrappedCommand = `___og_trap() { echo "${CWD_MARKER}"; pwd; }; trap ___og_trap EXIT; ${cdWrapper}${command}`;
	const proc = Bun.spawn(["bash", "-c", wrappedCommand], {
		cwd: effectiveCwd,
		stdout: "pipe",
		stderr: "pipe",
		env: process.env,
	});

	const startTime = Date.now();

	// Helper: parse stdout for CWD marker and build result
	function parseResult(
		stdout: string,
		stderr: string,
		exitCode: number,
	): {
		content: string;
		isError: boolean;
		cwd?: string;
	} {
		let cleanStdout = stdout;
		let newCwd: string | undefined;
		const markerIdx = cleanStdout.lastIndexOf(CWD_MARKER);
		if (markerIdx !== -1) {
			const afterMarker = cleanStdout
				.slice(markerIdx + CWD_MARKER.length)
				.trim();
			const pwdLine = afterMarker.split("\n")[0]?.trim();
			if (pwdLine) {
				let resolvedCwd: string;
				try {
					resolvedCwd = realpathSync(effectiveCwd);
				} catch {
					resolvedCwd = effectiveCwd;
				}
				if (pwdLine !== resolvedCwd) {
					newCwd = pwdLine;
				}
			}
			cleanStdout = cleanStdout.slice(0, markerIdx);
		}

		const parts: string[] = [];
		if (effectiveCwd !== cwd) {
			parts.push(
				`workdir reset to ${effectiveCwd} (previous dir '${cwd}' no longer exists)`,
			);
			if (!newCwd) newCwd = effectiveCwd;
		}
		parts.push(
			...[
				cleanStdout ? `stdout:\n${cleanStdout.slice(0, 10000)}` : "",
				stderr ? `stderr:\n${stderr.slice(0, 5000)}` : "",
				`exit code: ${exitCode}`,
			].filter(Boolean),
		);

		if (newCwd) {
			parts.push(`\nworkdir set to ${newCwd} from now on`);
			if (fallbackCwd) {
				let resolvedWorktree: string;
				let resolvedNew: string;
				try {
					resolvedWorktree = realpathSync(fallbackCwd);
				} catch {
					resolvedWorktree = fallbackCwd;
				}
				try {
					resolvedNew = realpathSync(newCwd);
				} catch {
					resolvedNew = newCwd;
				}
				const isOutside =
					resolvedNew !== resolvedWorktree &&
					!resolvedNew.startsWith(`${resolvedWorktree}/`);
				if (isOutside) {
					parts.push(
						`[Note: CWD is outside your worktree. Your worktree root is ${resolvedWorktree}. Remember to cd back when done.]`,
					);
				}
			}
		}

		return {
			content: parts.join("\n"),
			isError: exitCode !== 0,
			cwd: newCwd,
		};
	}

	// Immediate background: foregroundTimeout === 0
	if (foregroundTimeout === 0 && sessionId) {
		const bgId = `bg-${randomUUID().slice(0, 8)}`;
		const bgMap = getSessionBackgroundProcesses(sessionId);
		const bgEntry: BackgroundProcess = {
			id: bgId,
			command,
			startTime,
			stdout: "",
			stderr: "",
			exitCode: null,
			status: "running",
		};
		bgMap.set(bgId, bgEntry);

		// Set up hard timeout kill
		const killTimer = setTimeout(() => proc.kill(), hardTimeout);

		// Monitor in background
		(async () => {
			try {
				const exitCode = await proc.exited;
				clearTimeout(killTimer);
				const stdout = await new Response(proc.stdout).text();
				const stderr = await new Response(proc.stderr).text();
				bgEntry.stdout = stdout;
				bgEntry.stderr = stderr;
				bgEntry.exitCode = exitCode;
				bgEntry.status = exitCode === 0 ? "completed" : "failed";

				// Notify via queue
				if (queue) {
					try {
						queue.enqueue({
							source: "background_complete",
							commandId: bgId,
							command,
							exitCode,
							stdout: stdout.slice(0, 10000),
							stderr: stderr.slice(0, 5000),
							durationMs: Date.now() - startTime,
						});
					} catch {
						// Queue may be closed
					}
				}
			} catch {
				bgEntry.status = "failed";
			}
		})();

		return {
			content: `Command backgrounded immediately.\nBackground ID: ${bgId}\nCommand: ${command}\nResults will be delivered when complete.`,
			isError: false,
		};
	}

	// Foreground execution with timeout race
	const exitPromise = (async () => {
		const exitCode = await proc.exited;
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		return { exitCode, stdout, stderr, timedOut: false as const };
	})();

	// If foregroundTimeout >= hardTimeout, just wait with hard timeout (original behavior)
	if (foregroundTimeout >= hardTimeout) {
		const timer = setTimeout(() => proc.kill(), hardTimeout);
		try {
			const { exitCode, stdout, stderr } = await exitPromise;
			clearTimeout(timer);
			return parseResult(stdout, stderr, exitCode);
		} catch (e) {
			clearTimeout(timer);
			return {
				content: `Error: ${e instanceof Error ? e.message : String(e)}`,
				isError: true,
			};
		}
	}

	// Race: foreground timeout vs process completion
	const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
		setTimeout(() => resolve({ timedOut: true }), foregroundTimeout);
	});

	const result = await Promise.race([exitPromise, timeoutPromise]);

	if (!result.timedOut) {
		// Process completed within foreground timeout — return normally
		// Still need hard timeout for safety, but process already exited
		return parseResult(result.stdout, result.stderr, result.exitCode);
	}

	// Foreground timeout hit — move to background
	if (!sessionId) {
		// No session to track background — just kill and return
		proc.kill();
		return {
			content: `Command timed out after ${foregroundTimeout}ms and was killed (no session for backgrounding).`,
			isError: true,
		};
	}

	const bgId = `bg-${randomUUID().slice(0, 8)}`;
	const bgMap = getSessionBackgroundProcesses(sessionId);
	const bgEntry: BackgroundProcess = {
		id: bgId,
		command,
		startTime,
		stdout: "",
		stderr: "",
		exitCode: null,
		status: "running",
	};
	bgMap.set(bgId, bgEntry);

	// Set up hard timeout kill
	const killTimer = setTimeout(
		() => proc.kill(),
		hardTimeout - foregroundTimeout,
	);

	// Monitor in background
	(async () => {
		try {
			const { exitCode, stdout, stderr } = await exitPromise;
			clearTimeout(killTimer);
			bgEntry.stdout = stdout;
			bgEntry.stderr = stderr;
			bgEntry.exitCode = exitCode;
			bgEntry.status = exitCode === 0 ? "completed" : "failed";

			if (queue) {
				try {
					queue.enqueue({
						source: "background_complete",
						commandId: bgId,
						command,
						exitCode,
						stdout: stdout.slice(0, 10000),
						stderr: stderr.slice(0, 5000),
						durationMs: Date.now() - startTime,
					});
				} catch {
					// Queue may be closed
				}
			}
		} catch {
			bgEntry.status = "failed";
		}
	})();

	return {
		content: `Command moved to background after ${foregroundTimeout}ms.\nBackground ID: ${bgId}\nCommand: ${command}\nPartial output will be available. Full results delivered on completion.`,
		isError: false,
	};
}
