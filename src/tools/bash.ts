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
import { createBackgroundComplete } from "../queue-message-factory.ts";
import { ulid } from "../ulid.ts";

// ── Background Process Manager ──

/** Temp directory for background process output files. */
const BG_TMP_DIR = join(tmpdir(), "mxd-bg");

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
	/** Set when process completes (status changes from "running"). */
	endTime?: number;
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
	/** Resolves when the process completes. Used internally for cleanup tracking. */
	completionPromise?: Promise<void>;
	/** Call to resolve the completion promise. */
	resolveCompletion?: () => void;
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

// ── Shared Output Formatting ──

/** Max file size (bytes) to inline in response. Above this, return a preview + file path. */
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

/**
 * Read and format output from stdout/stderr files.
 * Small output (< 50KB): inline content, clean up temp files.
 * Large output (> 50KB): preview + file path for read_file, keep temp files.
 *
 * This is THE formatting function — ALL paths use it:
 * - Foreground completion
 * - Background completion notification (queue message)
 * - background tool "status" on completed process
 */
function formatBashResult(
	stdoutPath: string | null,
	stderrPath: string | null,
	exitCode: number,
): {
	stdout: string;
	stderr: string;
	content: string;
	isError: boolean;
	/** Set if stdout was too large — file kept for read_file access. */
	stdoutTruncatedPath?: string;
	/** Set if stderr was too large — file kept for read_file access. */
	stderrTruncatedPath?: string;
} {
	let stdout = "";
	let stderr = "";
	let stdoutTruncatedPath: string | undefined;
	let stderrTruncatedPath: string | undefined;

	// Read stdout
	if (stdoutPath) {
		const stdoutSize = fileSize(stdoutPath);
		if (stdoutSize > LARGE_OUTPUT_THRESHOLD) {
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
	}

	// Read stderr
	if (stderrPath) {
		const stderrSize = fileSize(stderrPath);
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
	}

	// Build content string
	const parts: string[] = [];
	if (stdout) {
		if (stdoutTruncatedPath) {
			const size = fileSize(stdoutTruncatedPath);
			const sizeKb = Math.round(size / 1024);
			parts.push(
				`stdout (truncated, ${sizeKb}KB total):\n${stdout}\n(Output too large. Full output: ${stdoutTruncatedPath} — use read_file with offset/limit.)`,
			);
		} else {
			parts.push(`stdout:\n${stdout}`);
		}
	}
	if (stderr) {
		if (stderrTruncatedPath) {
			const size = fileSize(stderrTruncatedPath);
			const sizeKb = Math.round(size / 1024);
			parts.push(
				`stderr (truncated, ${sizeKb}KB total):\n${stderr}\n(Output too large. Full output: ${stderrTruncatedPath} — use read_file with offset/limit.)`,
			);
		} else {
			parts.push(`stderr:\n${stderr}`);
		}
	}
	parts.push(`exit code: ${exitCode}`);

	return {
		stdout,
		stderr,
		content: parts.join("\n"),
		isError: exitCode !== 0,
		stdoutTruncatedPath,
		stderrTruncatedPath,
	};
}

/** Clean up all background processes for a session. Takes the bgMap directly. */
export function cleanupSessionBackgroundProcesses(
	bgMap: Map<string, BackgroundProcess>,
): void {
	for (const bg of bgMap.values()) {
		if (bg.status === "running" && bg.kill) {
			bg.kill();
		}
		cleanupBgFiles(bg);
	}
	bgMap.clear();
}

/** Kill a background process. Returns a status message or null if not found. */
export function killBackgroundProcess(
	bgMap: Map<string, BackgroundProcess>,
	bgId: string,
): string | null {
	const bg = bgMap.get(bgId);
	if (!bg) return null;

	if (bg.status !== "running") {
		return `Process ${bgId} is not running (status: ${bg.status}, exit code: ${bg.exitCode}).`;
	}

	if (bg.kill) {
		bg.kill();
		bg.status = "failed";
		bg.endTime = Date.now();
		bg.kill = null;
		// Keep temp files alive — agent can read via read_file, cleaned up on session end
		const durationMs = (bg.endTime ?? Date.now()) - bg.startTime;
		const parts = [
			`Process ${bgId} killed.`,
			`Command: ${bg.command}`,
			`Ran for ${Math.round(durationMs / 1000)}s.`,
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
	bgMap: Map<string, BackgroundProcess>,
	bgId: string,
): string | null {
	const bg = bgMap.get(bgId);
	if (!bg) return null;

	const durationMs = (bg.endTime ?? Date.now()) - bg.startTime;

	// For completed processes, use formatBashResult (shared formatting)
	if (bg.status !== "running" && bg.exitCode !== null) {
		const result = formatBashResult(bg.stdoutPath, bg.stderrPath, bg.exitCode);
		const parts: string[] = [
			`Background ID: ${bg.id}`,
			`Command: ${bg.command}`,
			`Status: ${bg.status}`,
			`Duration: ${Math.round(durationMs / 1000)}s`,
			"",
			result.content,
		];
		return parts.join("\n");
	}

	// Still running — show file paths for partial output
	const parts: string[] = [
		`Background ID: ${bg.id}`,
		`Command: ${bg.command}`,
		`Status: ${bg.status}`,
		`Duration: ${Math.round(durationMs / 1000)}s`,
	];

	if (bg.stdoutPath) {
		parts.push(`stdout file: ${bg.stdoutPath}`);
	}
	if (bg.stderrPath) {
		parts.push(`stderr file: ${bg.stderrPath}`);
	}

	parts.push(
		"\n(Process still running. Use read_file on the paths above for partial output.)",
	);

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
 * @param sessionId - Session ID for background tracking (bgId prefix, temp file paths)
 * @param queue - Message queue for background completion notifications
 * @param toolCallId - Tool call ID for foreground execution tracking
 * @param bgMap - Background processes map from TaskSession
 * @param fgMap - Foreground executions map from TaskSession
 */
export async function executeBashWithTimeout(
	command: string,
	cwd: string,
	fallbackCwd: string | undefined,
	foregroundTimeout: number,
	sessionId: string | undefined,
	queue: MessageQueue | undefined,
	toolCallId?: string,
	bgMap?: Map<string, BackgroundProcess>,
	fgMap?: Map<string, { resolve: () => void; command: string }>,
): Promise<{
	content: string;
	isError: boolean;
	cwd?: string;
	backgroundId?: string;
	backgroundCommand?: string;
}> {
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

	// All commands use file-based output redirection
	const execId = ulid();
	ensureBgTmpDir();
	const stdoutPath = join(BG_TMP_DIR, `exec-${execId}.stdout`);
	const stderrPath = join(BG_TMP_DIR, `exec-${execId}.stderr`);
	const cwdPath = join(BG_TMP_DIR, `cwd-${execId}`);

	// cd wrapper writes resolved pwd to temp file on every cd — no stdout pollution.
	// EXIT trap writes final pwd to temp file (catches cd in subshells/scripts too).
	const isImmediateBackground = foregroundTimeout === 0 && !!sessionId;
	const cdWrapper = `cd() { local t="${"$"}{1:-${"$"}HOME}"; local r; r=${"$"}(builtin cd "${"$"}t" 2>/dev/null && pwd); if [ "${"$"}(pwd)" = "${"$"}r" ]; then echo "bash: cd: ${"$"}(pwd): already in this directory" >&2; return 1; fi; builtin cd "${"$"}t"; }; `;
	const exitTrap = `___mxd_trap() { pwd > "${cwdPath}"; }; trap ___mxd_trap EXIT; `;
	const shellCommand = isImmediateBackground
		? command
		: `${exitTrap}${cdWrapper}${command}`;

	const proc = Bun.spawn(["bash", "-c", shellCommand], {
		cwd: effectiveCwd,
		stdout: Bun.file(stdoutPath),
		stderr: Bun.file(stderrPath),
		env: process.env,
	});

	const startTime = Date.now();

	// Helper: use formatBashResult + read CWD from temp file for foreground results
	function parseForegroundResult(exitCode: number): {
		content: string;
		isError: boolean;
		cwd?: string;
	} {
		const result = formatBashResult(stdoutPath, stderrPath, exitCode);

		let content = result.content;
		let newCwd: string | undefined;

		// Read CWD from temp file (written by cd wrapper or EXIT trap)
		try {
			const cwdFromFile = readFileSync(cwdPath, "utf-8").trim();
			if (cwdFromFile) {
				let resolvedCwd: string;
				try {
					resolvedCwd = realpathSync(effectiveCwd);
				} catch {
					resolvedCwd = effectiveCwd;
				}
				if (cwdFromFile !== resolvedCwd) {
					newCwd = cwdFromFile;
				}
			}
		} catch {
			// No CWD file — command didn't cd
		} finally {
			// Clean up CWD temp file
			try {
				unlinkSync(cwdPath);
			} catch {
				// Already removed or never created
			}
		}

		// Prepend workdir reset if CWD was invalid
		if (effectiveCwd !== cwd) {
			const resetMsg = `workdir reset to ${effectiveCwd} (previous dir '${cwd}' no longer exists)`;
			content = `${resetMsg}\n${content}`;
			if (!newCwd) newCwd = effectiveCwd;
		}

		if (newCwd) {
			content += `\n\nworkdir set to ${newCwd} from now on`;
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
					content += `\n[Note: CWD is outside your worktree. Your worktree root is ${resolvedWorktree}. Remember to cd back when done.]`;
				}
			}
		}

		return {
			content,
			isError: result.isError,
			cwd: newCwd,
		};
	}

	// Immediate background: foregroundTimeout === 0
	if (isImmediateBackground) {
		const bgId = `bg-${ulid()}`;
		if (!bgMap) {
			// No session background map — can't track background processes
			proc.kill();
			formatBashResult(stdoutPath, stderrPath, 1);
			return {
				content: "Command cannot be backgrounded (no session for tracking).",
				isError: true,
			};
		}
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
		bgEntry.completionPromise = new Promise<void>((resolve) => {
			bgEntry.resolveCompletion = resolve;
		});
		bgMap.set(bgId, bgEntry);

		// Monitor in background
		(async () => {
			try {
				const exitCode = await proc.exited;
				bgEntry.exitCode = exitCode;
				bgEntry.status = exitCode === 0 ? "completed" : "failed";
				bgEntry.endTime = Date.now();
				bgEntry.kill = null;

				// Format output using shared formatBashResult
				const result = formatBashResult(stdoutPath, stderrPath, exitCode);

				// Notify via queue with content when small
				if (queue) {
					try {
						queue.enqueue(
							createBackgroundComplete({
								commandId: bgId,
								command,
								exitCode,
								durationMs: Date.now() - startTime,
								stdout: result.stdout || undefined,
								stderr: result.stderr || undefined,
							}),
						);
					} catch {
						// Queue may be closed
					}
				}
			} catch (e) {
				console.warn(`[bash] Background process ${bgId} failed:`, e);
				bgEntry.status = "failed";
			} finally {
				bgEntry.resolveCompletion?.();
			}
		})();

		return {
			content: `Command backgrounded immediately.\nBackground ID: ${bgId}\nCommand: ${command}\nOutput files: ${stdoutPath}, ${stderrPath}\nYou will be notified with output when it completes.\nCWD is not affected by backgrounded commands. Your current working directory remains: ${cwd}`,
			isError: false,
			backgroundId: bgId,
			backgroundCommand: command,
		};
	}

	// Foreground execution with timeout race
	const exitPromise = proc.exited.then((exitCode) => ({
		exitCode,
		timedOut: false as const,
	}));

	// Race: foreground timeout vs process completion vs external signal
	// Reason distinguishes timeout (automatic) from user-initiated move-to-background
	type BackgroundReason = "timeout" | "user";
	const timeoutPromise = new Promise<{
		timedOut: true;
		reason: BackgroundReason;
	}>((resolve) => {
		setTimeout(
			() => resolve({ timedOut: true, reason: "timeout" }),
			foregroundTimeout,
		);
	});

	// External signal: allows moveToBackground() to interrupt the foreground wait
	// Use toolCallId as key when available (allows frontend to reference via tool_call event ID)
	const fgKey = toolCallId ?? execId;
	const externalSignalPromise = new Promise<{
		timedOut: true;
		reason: BackgroundReason;
	}>((resolve) => {
		if (sessionId && fgMap) {
			const key = `${sessionId}:${fgKey}`;
			fgMap.set(key, {
				resolve: () => resolve({ timedOut: true, reason: "user" }),
				command,
			});
		}
	});

	const result = await Promise.race([
		exitPromise,
		timeoutPromise,
		externalSignalPromise,
	]);

	// Clean up the foreground execution tracking
	if (sessionId && fgMap) {
		fgMap.delete(`${sessionId}:${fgKey}`);
	}

	if (!result.timedOut) {
		// Process completed within foreground timeout — return normally
		return parseForegroundResult(result.exitCode);
	}

	// Foreground timeout hit — move to background
	if (!sessionId) {
		// No session to track background — just kill and return
		proc.kill();
		formatBashResult(stdoutPath, stderrPath, 1); // clean up temp files
		return {
			content: `Command timed out after ${foregroundTimeout}ms and was killed (no session for backgrounding).`,
			isError: true,
		};
	}

	const bgId = `bg-${ulid()}`;
	if (!bgMap) {
		// No session background map — kill and return
		proc.kill();
		formatBashResult(stdoutPath, stderrPath, 1);
		return {
			content: `Command timed out after ${foregroundTimeout}ms and was killed (no session for backgrounding).`,
			isError: true,
		};
	}
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
	bgEntry.completionPromise = new Promise<void>((resolve) => {
		bgEntry.resolveCompletion = resolve;
	});
	bgMap.set(bgId, bgEntry);

	// Monitor in background
	(async () => {
		try {
			const { exitCode } = await exitPromise;
			bgEntry.exitCode = exitCode;
			bgEntry.status = exitCode === 0 ? "completed" : "failed";
			bgEntry.endTime = Date.now();
			bgEntry.kill = null;

			// Format output using shared formatBashResult
			const result = formatBashResult(stdoutPath, stderrPath, exitCode);

			if (queue) {
				try {
					queue.enqueue(
						createBackgroundComplete({
							commandId: bgId,
							command,
							exitCode,
							durationMs: Date.now() - startTime,
							stdout: result.stdout || undefined,
							stderr: result.stderr || undefined,
						}),
					);
				} catch {
					// Queue may be closed
				}
			}
		} catch (e) {
			console.warn(`[bash] Background process ${bgId} failed:`, e);
			bgEntry.status = "failed";
		} finally {
			bgEntry.resolveCompletion?.();
		}
	})();

	// Read partial output accumulated so far
	let partialStdout = "";
	try {
		partialStdout = readFileSync(stdoutPath, "utf-8");
	} catch {
		// File may be empty
	}

	const movedReason =
		result.reason === "user"
			? "Command moved to background."
			: `Command moved to background after ${foregroundTimeout}ms.`;

	return {
		content: `${movedReason}\nBackground ID: ${bgId}\nCommand: ${command}\nOutput files: ${stdoutPath}, ${stderrPath}\nYou will be notified with output when it completes.\nCWD is not affected by backgrounded commands. Your current working directory remains: ${cwd}${partialStdout ? `\n\nPartial stdout so far:\n${partialStdout.slice(0, 5000)}` : ""}`,
		isError: false,
		backgroundId: bgId,
		backgroundCommand: command,
	};
}
