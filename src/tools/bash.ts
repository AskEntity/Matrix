import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageQueue } from "../message-queue.ts";
import { ulid } from "../ulid.ts";

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
		// Keep temp files alive — agent can read via read_file, cleaned up on session end
		const parts = [
			`Process ${bgId} killed.`,
			`Command: ${bg.command}`,
			`Ran for ${Math.round((Date.now() - bg.startTime) / 1000)}s.`,
		];
		if (bg.stdoutPath) {
			parts.push(`stdout file: ${bg.stdoutPath}`);
		}
		if (bg.stderrPath) {
			parts.push(`stderr file: ${bg.stderrPath}`);
		}
		parts.push(
			"Use read_file on the output files above to see what was captured.",
		);
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

	// Always include file paths for output reading
	if (bg.stdoutPath) {
		parts.push(`stdout file: ${bg.stdoutPath}`);
	}
	if (bg.stderrPath) {
		parts.push(`stderr file: ${bg.stderrPath}`);
	}

	if (bg.status === "running") {
		parts.push(
			"\n(Process still running. Use read_file on the paths above for partial output.)",
		);
	} else {
		parts.push(
			"\n(Process completed. Use read_file on the paths above to see output.)",
		);
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
		if (fallbackCwd && existsSync(fallbackCwd)) {
			effectiveCwd = fallbackCwd;
		} else {
			// Last resort: use process working directory
			effectiveCwd = process.cwd();
		}
	}

	const cdWrapper = `cd() { local t="${"$"}{1:-${"$"}HOME}"; local r; r=${"$"}(builtin cd "${"$"}t" 2>/dev/null && pwd); if [ "${"$"}(pwd)" = "${"$"}r" ]; then echo "bash: cd: ${"$"}(pwd): already in this directory" >&2; return 1; fi; builtin cd "${"$"}t"; }; `;

	// All commands use file-based output redirection
	const execId = ulid().slice(0, 8);
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

	/** Max file size (bytes) to inline in foreground response. Above this, return a preview + file path. */
	const LARGE_OUTPUT_THRESHOLD = 50 * 1024; // 50KB
	/** Preview size for large output. */
	const PREVIEW_SIZE = 5 * 1024; // 5KB

	/** Get file size in bytes, or 0 if file doesn't exist. */
	function fileSize(path: string): number {
		try {
			return statSync(path).size;
		} catch {
			return 0;
		}
	}

	/** Read output files. If small, clean up files; if large, keep files and return preview + path. */
	function readOutput(): {
		stdout: string;
		stderr: string;
		/** Set if stdout was too large — file kept for read_file access. */
		stdoutTruncatedPath?: string;
		/** Set if stderr was too large — file kept for read_file access. */
		stderrTruncatedPath?: string;
	} {
		let stdout = "";
		let stderr = "";
		let stdoutTruncatedPath: string | undefined;
		let stderrTruncatedPath: string | undefined;
		const stdoutSize = fileSize(stdoutPath);
		const stderrSize = fileSize(stderrPath);

		// Read stdout
		if (stdoutSize > LARGE_OUTPUT_THRESHOLD) {
			// Large output — read preview only, keep file
			try {
				const buf = Buffer.alloc(PREVIEW_SIZE);
				const fd = openSync(stdoutPath, "r");
				const bytesRead = readSync(fd, buf, 0, PREVIEW_SIZE, 0);
				closeSync(fd);
				stdout = buf.toString("utf-8", 0, bytesRead);
			} catch {
				// File may not exist
			}
			stdoutTruncatedPath = stdoutPath;
		} else {
			try {
				stdout = readFileSync(stdoutPath, "utf-8");
			} catch {
				// File may not exist
			}
			try {
				unlinkSync(stdoutPath);
			} catch {
				// Already removed
			}
		}

		// Read stderr
		if (stderrSize > LARGE_OUTPUT_THRESHOLD) {
			try {
				const buf = Buffer.alloc(PREVIEW_SIZE);
				const fd = openSync(stderrPath, "r");
				const bytesRead = readSync(fd, buf, 0, PREVIEW_SIZE, 0);
				closeSync(fd);
				stderr = buf.toString("utf-8", 0, bytesRead);
			} catch {
				// File may not exist
			}
			stderrTruncatedPath = stderrPath;
		} else {
			try {
				stderr = readFileSync(stderrPath, "utf-8");
			} catch {
				// File may not exist
			}
			try {
				unlinkSync(stderrPath);
			} catch {
				// Already removed
			}
		}

		return { stdout, stderr, stdoutTruncatedPath, stderrTruncatedPath };
	}

	// Helper: parse stdout for CWD marker and build result
	function parseResult(
		stdout: string,
		stderr: string,
		exitCode: number,
		opts?: {
			stdoutTruncatedPath?: string;
			stderrTruncatedPath?: string;
		},
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

		// Format stdout — with truncation notice for large output
		if (cleanStdout) {
			if (opts?.stdoutTruncatedPath) {
				const size = fileSize(opts.stdoutTruncatedPath);
				const sizeKb = Math.round(size / 1024);
				parts.push(
					`stdout (truncated, ${sizeKb}KB total):\n${cleanStdout}\n(Output too large. Full output: ${opts.stdoutTruncatedPath} — use read_file with offset/limit.)`,
				);
			} else {
				parts.push(`stdout:\n${cleanStdout}`);
			}
		}
		// Format stderr — with truncation notice for large output
		if (stderr) {
			if (opts?.stderrTruncatedPath) {
				const size = fileSize(opts.stderrTruncatedPath);
				const sizeKb = Math.round(size / 1024);
				parts.push(
					`stderr (truncated, ${sizeKb}KB total):\n${stderr}\n(Output too large. Full output: ${opts.stderrTruncatedPath} — use read_file with offset/limit.)`,
				);
			} else {
				parts.push(`stderr:\n${stderr}`);
			}
		}
		parts.push(`exit code: ${exitCode}`);

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
		const bgId = `bg-${ulid().slice(0, 8)}`;
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
				bgEntry.exitCode = exitCode;
				bgEntry.status = exitCode === 0 ? "completed" : "failed";
				bgEntry.kill = null;
				// Keep temp files alive — agent reads via read_file, cleaned up on session end

				// Notify via queue (metadata only — no stdout/stderr content)
				if (queue) {
					try {
						queue.enqueue({
							source: "background_complete",
							commandId: bgId,
							command,
							exitCode,
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
		const { stdout, stderr, stdoutTruncatedPath, stderrTruncatedPath } =
			readOutput();
		return parseResult(stdout, stderr, result.exitCode, {
			stdoutTruncatedPath,
			stderrTruncatedPath,
		});
	}

	// Foreground timeout hit — move to background
	if (!sessionId) {
		// No session to track background — just kill and return
		proc.kill();
		readOutput();
		return {
			content: `Command timed out after ${foregroundTimeout}ms and was killed (no session for backgrounding).`,
			isError: true,
		};
	}

	const bgId = `bg-${ulid().slice(0, 8)}`;
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
			bgEntry.exitCode = exitCode;
			bgEntry.status = exitCode === 0 ? "completed" : "failed";
			bgEntry.kill = null;
			// Keep temp files alive — agent reads via read_file, cleaned up on session end

			if (queue) {
				try {
					queue.enqueue({
						source: "background_complete",
						commandId: bgId,
						command,
						exitCode,
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
