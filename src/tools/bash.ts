import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageQueue } from "../message-queue.ts";

// ── Background Process Manager ──

/** Temp directory for background process output files. */
const BG_TMP_DIR = join(tmpdir(), "opengraft-bg");

/** Ensure the temp directory exists. */
function ensureBgTmpDir(): void {
	if (!existsSync(BG_TMP_DIR)) {
		mkdirSync(BG_TMP_DIR, { recursive: true });
	}
}

/** A background process tracked by the server. */
export interface BackgroundProcess {
	id: string;
	command: string;
	startTime: number;
	stdout: string;
	stderr: string;
	exitCode: number | null;
	status: "running" | "completed" | "failed";
	/** Kill the underlying process. Only available while status is "running". */
	kill: (() => void) | null;
	/** Path to the stdout output file (while running, for partial reads). */
	stdoutPath: string | null;
	/** Path to the stderr output file (while running, for partial reads). */
	stderrPath: string | null;
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

/** Remove temp output files for a background process. */
function cleanupBgFiles(bg: BackgroundProcess): void {
	for (const p of [bg.stdoutPath, bg.stderrPath]) {
		if (p) {
			try {
				unlinkSync(p);
			} catch {
				// File may already be removed
			}
		}
	}
	bg.stdoutPath = null;
	bg.stderrPath = null;
}

/** Clean up all background processes for a session. */
export function cleanupSessionBackgroundProcesses(sessionId: string): void {
	const map = backgroundProcesses.get(sessionId);
	if (map) {
		for (const bg of map.values()) {
			if (bg.status === "running" && bg.kill) {
				bg.kill();
			}
			cleanupBgFiles(bg);
		}
	}
	backgroundProcesses.delete(sessionId);
}

/** Kill a background process. Returns a status message or null if not found. */
export function killBackgroundProcess(
	sessionId: string,
	bgId: string,
): string | null {
	const map = backgroundProcesses.get(sessionId);
	if (!map) return null;
	const bg = map.get(bgId);
	if (!bg) return null;

	if (bg.status !== "running") {
		return `Process ${bgId} is not running (status: ${bg.status}, exit code: ${bg.exitCode}).`;
	}

	if (bg.kill) {
		bg.kill();
		bg.status = "failed";
		bg.kill = null;
		// Read any partial output before cleaning up files
		let partialStdout = "";
		let partialStderr = "";
		if (bg.stdoutPath) {
			try {
				partialStdout = readFileSync(bg.stdoutPath, "utf-8");
			} catch {
				// File may not exist yet
			}
		}
		if (bg.stderrPath) {
			try {
				partialStderr = readFileSync(bg.stderrPath, "utf-8");
			} catch {
				// File may not exist yet
			}
		}
		cleanupBgFiles(bg);
		const parts = [
			`Process ${bgId} killed.`,
			`Command: ${bg.command}`,
			`Ran for ${Math.round((Date.now() - bg.startTime) / 1000)}s.`,
		];
		if (partialStdout) {
			parts.push(`stdout:\n${partialStdout.slice(0, 10000)}`);
		}
		if (partialStderr) {
			parts.push(`stderr:\n${partialStderr.slice(0, 5000)}`);
		}
		return parts.join("\n");
	}

	return `Process ${bgId} is running but has no kill handle.`;
}

/** Get status of a background process. Returns a status message or null if not found. */
export function getBackgroundStatus(
	sessionId: string,
	bgId: string,
): string | null {
	const map = backgroundProcesses.get(sessionId);
	if (!map) return null;
	const bg = map.get(bgId);
	if (!bg) return null;

	const durationMs = Date.now() - bg.startTime;
	const parts: string[] = [
		`Background ID: ${bg.id}`,
		`Command: ${bg.command}`,
		`Status: ${bg.status}`,
		`Duration: ${Math.round(durationMs / 1000)}s`,
	];

	if (bg.exitCode !== null) {
		parts.push(`Exit code: ${bg.exitCode}`);
	}

	if (bg.status === "running") {
		// For running processes, provide file paths for partial output reading
		if (bg.stdoutPath) {
			parts.push(`stdout file: ${bg.stdoutPath}`);
		}
		if (bg.stderrPath) {
			parts.push(`stderr file: ${bg.stderrPath}`);
		}
		parts.push(
			"\n(Process still running. Use read_file on the paths above for partial output.)",
		);
	} else {
		// For completed processes, return the stored output directly
		if (bg.stdout) {
			parts.push(`stdout:\n${bg.stdout.slice(0, 10000)}`);
		}
		if (bg.stderr) {
			parts.push(`stderr:\n${bg.stderr.slice(0, 5000)}`);
		}
	}

	return parts.join("\n");
}

/**
 * Spawn a bash command with foreground timeout support.
 * All commands use file-based stdout/stderr redirection for consistent partial output reading.
 * If the command completes within foregroundTimeout, returns the result directly.
 * If foregroundTimeout is 0 or the command exceeds it, moves to background.
 *
 * @param command - The bash command to execute
 * @param cwd - Working directory
 * @param fallbackCwd - Fallback if cwd doesn't exist (worktree root)
 * @param foregroundTimeout - Ms to wait in foreground (0 = immediate background, undefined = wait forever)
 * @param sessionId - Session ID for background tracking
 * @param queue - Message queue for background completion notifications
 */
export async function executeBashWithTimeout(
	command: string,
	cwd: string,
	fallbackCwd: string | undefined,
	foregroundTimeout: number,
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

	// All commands use file-based output redirection
	const execId = randomUUID().slice(0, 8);
	ensureBgTmpDir();
	const stdoutPath = join(BG_TMP_DIR, `exec-${execId}.stdout`);
	const stderrPath = join(BG_TMP_DIR, `exec-${execId}.stderr`);

	// For foreground commands, include CWD tracking wrapper.
	// For immediate background (foregroundTimeout === 0), use plain command (no CWD tracking).
	const isImmediateBackground = foregroundTimeout === 0 && !!sessionId;
	const shellCommand = isImmediateBackground
		? command
		: `___og_trap() { echo "${CWD_MARKER}"; pwd; }; trap ___og_trap EXIT; ${cdWrapper}${command}`;

	const proc = Bun.spawn(["bash", "-c", shellCommand], {
		cwd: effectiveCwd,
		stdout: Bun.file(stdoutPath),
		stderr: Bun.file(stderrPath),
		env: process.env,
	});

	const startTime = Date.now();

	/** Read output files and clean them up. */
	function readAndCleanup(): { stdout: string; stderr: string } {
		let stdout = "";
		let stderr = "";
		try {
			stdout = readFileSync(stdoutPath, "utf-8");
		} catch {
			// File may not exist
		}
		try {
			stderr = readFileSync(stderrPath, "utf-8");
		} catch {
			// File may not exist
		}
		try {
			unlinkSync(stdoutPath);
		} catch {
			// Already removed
		}
		try {
			unlinkSync(stderrPath);
		} catch {
			// Already removed
		}
		return { stdout, stderr };
	}

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
	if (isImmediateBackground) {
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
			kill: () => proc.kill(),
			stdoutPath,
			stderrPath,
		};
		bgMap.set(bgId, bgEntry);

		// Monitor in background
		(async () => {
			try {
				const exitCode = await proc.exited;
				const output = readAndCleanup();
				bgEntry.stdout = output.stdout;
				bgEntry.stderr = output.stderr;
				bgEntry.exitCode = exitCode;
				bgEntry.status = exitCode === 0 ? "completed" : "failed";
				bgEntry.kill = null;
				bgEntry.stdoutPath = null;
				bgEntry.stderrPath = null;

				// Notify via queue
				if (queue) {
					try {
						queue.enqueue({
							source: "background_complete",
							commandId: bgId,
							command,
							exitCode,
							stdout: output.stdout.slice(0, 10000),
							stderr: output.stderr.slice(0, 5000),
							durationMs: Date.now() - startTime,
						});
					} catch {
						// Queue may be closed
					}
				}
			} catch {
				bgEntry.status = "failed";
				cleanupBgFiles(bgEntry);
			}
		})();

		return {
			content: `Command backgrounded immediately.\nBackground ID: ${bgId}\nCommand: ${command}\nOutput files: ${stdoutPath}, ${stderrPath}\nUse read_file on the output files for partial output. Results will be delivered when complete.\nCWD is not affected by backgrounded commands. Your current working directory remains: ${cwd}`,
			isError: false,
		};
	}

	// Foreground execution with timeout race
	const exitPromise = proc.exited.then((exitCode) => ({
		exitCode,
		timedOut: false as const,
	}));

	// Race: foreground timeout vs process completion
	const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
		setTimeout(() => resolve({ timedOut: true }), foregroundTimeout);
	});

	const result = await Promise.race([exitPromise, timeoutPromise]);

	if (!result.timedOut) {
		// Process completed within foreground timeout — return normally
		const { stdout, stderr } = readAndCleanup();
		return parseResult(stdout, stderr, result.exitCode);
	}

	// Foreground timeout hit — move to background
	if (!sessionId) {
		// No session to track background — just kill and return
		proc.kill();
		readAndCleanup();
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
		kill: () => proc.kill(),
		stdoutPath,
		stderrPath,
	};
	bgMap.set(bgId, bgEntry);

	// Monitor in background
	(async () => {
		try {
			const { exitCode } = await exitPromise;
			const output = readAndCleanup();
			bgEntry.stdout = output.stdout;
			bgEntry.stderr = output.stderr;
			bgEntry.exitCode = exitCode;
			bgEntry.status = exitCode === 0 ? "completed" : "failed";
			bgEntry.kill = null;
			bgEntry.stdoutPath = null;
			bgEntry.stderrPath = null;

			if (queue) {
				try {
					queue.enqueue({
						source: "background_complete",
						commandId: bgId,
						command,
						exitCode,
						stdout: output.stdout.slice(0, 10000),
						stderr: output.stderr.slice(0, 5000),
						durationMs: Date.now() - startTime,
					});
				} catch {
					// Queue may be closed
				}
			}
		} catch {
			bgEntry.status = "failed";
			cleanupBgFiles(bgEntry);
		}
	})();

	// Read partial output accumulated so far
	let partialStdout = "";
	try {
		partialStdout = readFileSync(stdoutPath, "utf-8");
	} catch {
		// File may be empty
	}

	return {
		content: `Command moved to background after ${foregroundTimeout}ms.\nBackground ID: ${bgId}\nCommand: ${command}\nOutput files: ${stdoutPath}, ${stderrPath}\nUse read_file on the output files for partial output. Full results delivered on completion.\nCWD is not affected by backgrounded commands. Your current working directory remains: ${cwd}${partialStdout ? `\n\nPartial stdout so far:\n${partialStdout.slice(0, 5000)}` : ""}`,
		isError: false,
	};
}
