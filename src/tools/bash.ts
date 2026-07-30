import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageQueue } from "../message-queue.ts";
import { createBackgroundComplete } from "../queue-message-factory.ts";
import { realpathOr } from "../real-path.ts";
import { ulid } from "../ulid.ts";

// ── Output directory ──

/**
 * Temp directory for bash tool output files — foreground AND background.
 * Persists across agent turns; cleaned on session end.
 */
const MXD_TMP_DIR = join(tmpdir(), "mxd");

/**
 * First line of an interrupted command's tool_result. The output the command
 * produced before it was stopped follows it, in the normal format.
 *
 * Deliberately NOT the "interrupted by daemon restart" wording that
 * `buildSessionRepair` synthesizes: that one is a guess made after the fact by
 * a process that wasn't there, and it is false whenever a user pressed stop.
 * This one is written by the code that did the stopping.
 */
export const INTERRUPTED_BY_USER =
	"[Command terminated: interrupted by user. Output produced before the interrupt follows.]";

/**
 * A foreground command that can be reached from outside while it runs.
 * Two verbs, opposite outcomes for the command itself — see TaskSession.
 */
export interface ForegroundExecution {
	/** Move to background. The command KEEPS RUNNING. */
	resolve: () => void;
	/** The user pressed stop: TERMINATE, reporting the output produced so far. */
	interrupt: () => void;
	command: string;
}

function ensureTmpDir(): void {
	if (!existsSync(MXD_TMP_DIR)) {
		mkdirSync(MXD_TMP_DIR, { recursive: true });
	}
}

// ── Tiered display thresholds ──

/** Below this, no file needed — output inlined in full. */
const SMALL_MAX = 1024;

/**
 * Below this, file saved, full content still inlined with banners.
 * Above this, file saved, display is head/tail-truncated.
 */
const MEDIUM_MAX = 10 * 1024;

/** Per-side byte budget in merged-mode head/tail truncation. */
const MERGED_HALF_BUDGET = 5 * 1024;

/** Total display budget across stdout+stderr in separate-mode large case. */
const SEPARATE_BUDGET = 10 * 1024;

/**
 * Trivial threshold in separate-mode large case. A stream ≤ this gets shown
 * in full; the other stream gets whatever budget remains split head/tail.
 */
const SEPARATE_TRIVIAL = 5 * 1024;

// ── Background Process Manager ──

/** A background process tracked by the server. */
export interface BackgroundProcess {
	id: string;
	command: string;
	/** Whether command ran in separate-streams mode (stdout + stderr files). */
	separate: boolean;
	startTime: number;
	/** Set when process completes (status changes from "running"). */
	endTime?: number;
	exitCode: number | null;
	status: "running" | "completed" | "failed";
	/** Kill the underlying process. Only available while status is "running". */
	kill: (() => void) | null;
	/**
	 * Primary output path.
	 * - Merged mode (separate=false): the single `.out` file.
	 * - Separate mode (separate=true): the `.stdout` file.
	 */
	stdoutPath: string | null;
	/**
	 * Secondary output path.
	 * - Merged mode: null.
	 * - Separate mode: the `.stderr` file.
	 */
	stderrPath: string | null;
	/** Temp file the shell's EXIT trap writes pwd + git toplevel to. */
	cwdPath: string | null;
	/**
	 * Which directory this process's output describes, formatted, or null when
	 * that is the agent's worktree root. Filled in when the process exits —
	 * before then there is nothing to report a result about.
	 */
	cwdNotice?: string | null;
	/** Resolves when the process completes. Used internally for cleanup tracking. */
	completionPromise?: Promise<void>;
	/** Call to resolve the completion promise. */
	resolveCompletion?: () => void;
}

/** Remove temp output files for a background process. */
function cleanupBgFiles(bg: BackgroundProcess): void {
	for (const p of [bg.stdoutPath, bg.stderrPath, bg.cwdPath]) {
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
	bg.cwdPath = null;
}

// ── Which directory a result came from ──

/** Where a directory stands relative to the agent's own checkout. */
export type CwdRelation = "own_root" | "inside_own" | "outside";

/**
 * Three states. The quiet one is EXACTLY the worktree root — not the subtree
 * under it: `ls` run from `src/tools` means something different from `ls` run
 * at the root, so a result taken below the root should say where it was taken.
 * Silence is reserved for the one directory the agent is assumed to be in.
 *
 * `gitTop` is `git rev-parse --show-toplevel` **run by the command's own
 * shell**, in the directory the command finished in. ⚠️ It is an INPUT here
 * rather than something this function computes, and that is deliberate: the
 * question "which checkout am I in" has exactly one authority, and it is git.
 * A hand-written walk up to the nearest `.git` gets `.worktrees/<other-task>`
 * wrong in the naive version (a linked worktree's `.git` is a FILE, not a
 * directory, so a `isDirectory()` test resolves every agent worktree to the
 * main repo — the one answer that makes another agent's checkout look like
 * home), and would still have to grow `GIT_DIR` and submodule handling to stay
 * correct. Asking git cannot drift from git.
 *
 * That per-worktree answer is what makes this beat a path-prefix test:
 * `<repo>/.worktrees/<other-task>` is UNDER the main repo root, so a prefix
 * test calls it "inside" — while it is another agent's checkout on another
 * branch, where a write or a commit lands in someone else's in-flight work and
 * looks entirely normal going in.
 *
 * Both sides are compared RESOLVED — `--show-toplevel` already returns a
 * resolved path, and the worktree root is resolved to match, because two
 * spellings of one directory (a symlink, or `/tmp` vs `/private/tmp` on macOS,
 * which has bitten this repo before) must not read as two checkouts.
 */
export function classifyCwd(
	dir: string,
	worktreeRoot: string,
	gitTop?: string | null,
): CwdRelation {
	const here = realpathOr(dir);
	const root = realpathOr(worktreeRoot);
	if (here === root) return "own_root";
	if (gitTop) return realpathOr(gitTop) === root ? "inside_own" : "outside";
	// `git rev-parse` found no repository — /tmp, ~/.mxd, anywhere outside a
	// checkout. That is "outside" by the rule, EXCEPT where the worktree root is
	// itself not a checkout (test fixtures, nothing this repo ships), where
	// reporting a subdirectory of your own root as "outside" would be a plain
	// lie. Containment is the last resort and cannot resurrect the case above: a
	// linked worktree always answers `--show-toplevel`, so another agent's
	// checkout never reaches this line.
	return here.startsWith(`${root}/`) ? "inside_own" : "outside";
}

/**
 * The one line that tells a result which directory it came from. Null at the
 * worktree root, which is the overwhelmingly common case, so an agent that has
 * not moved pays nothing.
 *
 * ⚠️ **This rides on EVERY affected result, not only on the one that moved**,
 * and that is the fix rather than an implementation detail. Being somewhere
 * other than your worktree root is a persistent CONDITION; the warning it
 * replaces fired once, at the `cd`. A one-shot signal for a persistent state
 * leaves every later result silent, and those later results are maximally
 * deceptive because nothing goes wrong in them: commands succeed, git reports
 * cleanly, output looks authoritative. Three observed incidents, two agents;
 * in the worst one an agent built a five-link evidence chain and filed a bug
 * report against this daemon — every link individually valid, all of them
 * answers about a different repository.
 *
 * `workdir set to X from now on` is NOT redundant with this and stays. That
 * line reports an EVENT (you just moved); this one reports a STATE (this is
 * where the output above came from). Neither substitutes for the other.
 */
export function formatCwdNotice(
	dir: string,
	worktreeRoot?: string | null,
	gitTop?: string | null,
): string | null {
	if (!worktreeRoot) return null;
	const relation = classifyCwd(dir, worktreeRoot, gitTop);
	if (relation === "own_root") return null;
	const here = realpathOr(dir);
	if (relation === "inside_own") return `[cwd: ${here}]`;
	// Naming YOUR root beside the foreign path is what keeps this legible when
	// the foreign path is another checkout of this same repo: the two sit side
	// by side and the difference is the whole message. "outside" alone would
	// read like you had wandered into /tmp.
	return `[cwd: ${here} — OUTSIDE your worktree, which is ${realpathOr(worktreeRoot)}]`;
}

/**
 * Read what the shell's EXIT trap wrote: line 1 the final pwd, line 2 the
 * checkout it belongs to. The second line is absent when `git rev-parse` failed
 * (not a repository), which is a normal answer rather than an error, and BOTH
 * are absent when the shell was killed by a signal before its trap could run.
 */
function readCwdProbe(path: string): { pwd?: string; gitTop?: string } {
	try {
		const [pwdLine, topLine] = readFileSync(path, "utf-8").split("\n");
		return {
			pwd: pwdLine?.trim() || undefined,
			gitTop: topLine?.trim() || undefined,
		};
	} catch {
		return {};
	}
}

// ── Pure formatting helpers ──

function fileSize(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	const kb = bytes / 1024;
	if (kb < 10) return `${kb.toFixed(1)}KB`;
	if (kb < 1024) return `${Math.round(kb)}KB`;
	return `${(kb / 1024).toFixed(1)}MB`;
}

function countLines(buf: Buffer | string): number {
	if (typeof buf === "string") {
		if (buf.length === 0) return 0;
		let count = 0;
		for (let i = 0; i < buf.length; i++)
			if (buf.charCodeAt(i) === 0x0a) count++;
		// Trailing non-newline content is a partial last line
		if (buf.charCodeAt(buf.length - 1) !== 0x0a) count++;
		return count;
	}
	if (buf.length === 0) return 0;
	let count = 0;
	for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) count++;
	if (buf[buf.length - 1] !== 0x0a) count++;
	return count;
}

/**
 * Head/tail truncation with newline alignment.
 * Returns head+tail slices of the content. When no newline exists in the
 * head (or tail) window, falls back to a hard byte cut and sets `midCut`.
 *
 * Caller is responsible for deciding whether to truncate — this just slices.
 * Works on bytes via Buffer so non-ASCII is sliced cleanly at newlines (or
 * hard-cut at byte boundaries if absolutely no newline in window).
 */
export function truncateMiddle(
	content: Buffer,
	headBudget: number,
	tailBudget: number,
): { head: Buffer; tail: Buffer; midCut: boolean } {
	const total = content.length;

	// Head: last '\n' at or before (headBudget - 1), prefer to keep the newline
	const headEnd = content.lastIndexOf(0x0a, Math.max(0, headBudget - 1));
	let midCutHead = false;
	let head: Buffer;
	if (headEnd === -1) {
		// No newline in head window → hard byte cut
		head = content.subarray(0, Math.min(headBudget, total));
		midCutHead = true;
	} else {
		// Include the newline for a clean line boundary
		head = content.subarray(0, headEnd + 1);
	}

	// Tail: first '\n' at or after (total - tailBudget)
	const tailSearchFrom = Math.max(0, total - tailBudget);
	const tailStart = content.indexOf(0x0a, tailSearchFrom);
	let midCutTail = false;
	let tail: Buffer;
	if (tailStart === -1 || tailStart >= total - 1) {
		// No useful newline in tail window → hard byte cut
		tail = content.subarray(Math.max(0, total - tailBudget));
		midCutTail = true;
	} else {
		// Start after the newline — tail begins at a line boundary
		tail = content.subarray(tailStart + 1);
	}

	return { head, tail, midCut: midCutHead || midCutTail };
}

/**
 * Format merged-mode output: one file holding stdout+stderr.
 * Returns the AI-visible content block. Caller handles deletion based on
 * {@link keepFile} flag.
 */
export function formatMergedOutput(
	outputPath: string,
	exitCode: number,
): { content: string; keepFile: boolean } {
	const size = fileSize(outputPath);

	if (size === 0) {
		return { content: `exit code: ${exitCode}`, keepFile: false };
	}

	const buf = readFileSync(outputPath);
	const lines = countLines(buf);
	const text = buf.toString("utf-8");

	if (size < SMALL_MAX) {
		// Inline only, no file kept.
		return {
			content: `exit code: ${exitCode}\n${text}`,
			keepFile: false,
		};
	}

	const banner = `Full output: ${outputPath} (${formatSize(size)}, ${lines} lines)`;

	// Boundary: head+tail budget covers the whole file → show full.
	// Naturally handles size===MEDIUM_MAX (5k+5k === 10k).
	if (size <= MEDIUM_MAX) {
		return {
			content: `${banner}\nexit code: ${exitCode}\n${text}\n${banner}`,
			keepFile: true,
		};
	}

	const { head, tail, midCut } = truncateMiddle(
		buf,
		MERGED_HALF_BUDGET,
		MERGED_HALF_BUDGET,
	);
	const truncatedBytes = size - head.length - tail.length;
	const truncatedLines = Math.max(
		0,
		lines - countLines(head) - countLines(tail),
	);
	const marker = midCut
		? `... [${formatSize(truncatedBytes)} / ${truncatedLines} lines truncated, mid-line cut] ...`
		: `... [${formatSize(truncatedBytes)} / ${truncatedLines} lines truncated] ...`;
	const readHint = `Read: bash "grep X ${outputPath}" or read_file`;

	return {
		content: [
			banner,
			`exit code: ${exitCode}`,
			head.toString("utf-8"),
			marker,
			tail.toString("utf-8"),
			banner,
			readHint,
		].join("\n"),
		keepFile: true,
	};
}

/** Budget allocation in separate-mode large case. */
export function allocateSeparateBudget(
	stdoutSize: number,
	stderrSize: number,
): {
	stdout: "full" | { head: number; tail: number };
	stderr: "full" | { head: number; tail: number };
} {
	if (stdoutSize <= SEPARATE_TRIVIAL) {
		const remaining = SEPARATE_BUDGET - stdoutSize;
		const half = Math.floor(remaining / 2);
		return {
			stdout: "full",
			stderr: { head: half, tail: half },
		};
	}
	if (stderrSize <= SEPARATE_TRIVIAL) {
		const remaining = SEPARATE_BUDGET - stderrSize;
		const half = Math.floor(remaining / 2);
		return {
			stdout: { head: half, tail: half },
			stderr: "full",
		};
	}
	const half = Math.floor(SEPARATE_BUDGET / 4);
	return {
		stdout: { head: half, tail: half },
		stderr: { head: half, tail: half },
	};
}

/** Render one stream in separate-mode large case. */
function renderSeparateStream(
	label: "stdout" | "stderr",
	buf: Buffer,
	size: number,
	lines: number,
	spec: "full" | { head: number; tail: number },
): string {
	if (spec === "full") {
		return `${label}:\n${buf.toString("utf-8")}`;
	}
	const { head, tail, midCut } = truncateMiddle(buf, spec.head, spec.tail);
	const truncatedBytes = size - head.length - tail.length;
	const truncatedLines = Math.max(
		0,
		lines - countLines(head) - countLines(tail),
	);
	const marker = midCut
		? `... [${formatSize(truncatedBytes)} / ${truncatedLines} lines truncated, mid-line cut] ...`
		: `... [${formatSize(truncatedBytes)} / ${truncatedLines} lines truncated] ...`;
	return `${label}:\n${head.toString("utf-8")}\n${marker}\n${tail.toString("utf-8")}`;
}

/**
 * Format separate-mode output: one file per stream.
 * Returns the AI-visible content block. Caller handles deletion based on
 * {@link keepFiles} flag.
 */
export function formatSeparateOutput(
	stdoutPath: string,
	stderrPath: string,
	exitCode: number,
): { content: string; keepFiles: boolean } {
	const stdoutSize = fileSize(stdoutPath);
	const stderrSize = fileSize(stderrPath);
	const total = stdoutSize + stderrSize;

	if (total === 0) {
		return { content: `exit code: ${exitCode}`, keepFiles: false };
	}

	const stdoutBuf = stdoutSize > 0 ? readFileSync(stdoutPath) : Buffer.alloc(0);
	const stderrBuf = stderrSize > 0 ? readFileSync(stderrPath) : Buffer.alloc(0);
	const stdoutLines = countLines(stdoutBuf);
	const stderrLines = countLines(stderrBuf);

	if (total < SMALL_MAX) {
		return {
			content: [
				`exit code: ${exitCode}`,
				`stdout:\n${stdoutBuf.toString("utf-8")}`,
				`stderr:\n${stderrBuf.toString("utf-8")}`,
			].join("\n"),
			keepFiles: false,
		};
	}

	const stdoutBanner = `Full stdout: ${stdoutPath} (${formatSize(stdoutSize)}, ${stdoutLines} lines)`;
	const stderrBanner = `Full stderr: ${stderrPath} (${formatSize(stderrSize)}, ${stderrLines} lines)`;

	if (total <= MEDIUM_MAX) {
		// Show full content for both, with banners.
		return {
			content: [
				stdoutBanner,
				stderrBanner,
				`exit code: ${exitCode}`,
				`stdout:\n${stdoutBuf.toString("utf-8")}`,
				`stderr:\n${stderrBuf.toString("utf-8")}`,
				stdoutBanner,
				stderrBanner,
			].join("\n"),
			keepFiles: true,
		};
	}

	// Large case: budget allocation.
	const alloc = allocateSeparateBudget(stdoutSize, stderrSize);
	const stdoutBlock = renderSeparateStream(
		"stdout",
		stdoutBuf,
		stdoutSize,
		stdoutLines,
		alloc.stdout,
	);
	const stderrBlock = renderSeparateStream(
		"stderr",
		stderrBuf,
		stderrSize,
		stderrLines,
		alloc.stderr,
	);
	const readHint = `Read: bash "grep X ${stdoutPath} ${stderrPath}" or read_file`;

	return {
		content: [
			stdoutBanner,
			stderrBanner,
			`exit code: ${exitCode}`,
			stdoutBlock,
			stderrBlock,
			stdoutBanner,
			stderrBanner,
			readHint,
		].join("\n"),
		keepFiles: true,
	};
}

/**
 * Format the bash tool result for AI consumption.
 * Unified entry point for both foreground completion and background completion.
 */
function formatBashResult(
	bg: {
		separate: boolean;
		stdoutPath: string | null;
		stderrPath: string | null;
		/**
		 * Where this result came from, or null when that is the worktree root.
		 * Carried on the shape rather than passed per call so that all three
		 * result paths — foreground, background_complete, background status —
		 * get it by construction. It is pre-formatted because the background
		 * paths can only learn it once, when the process exits.
		 */
		cwdNotice?: string | null;
	},
	exitCode: number,
): { content: string; isError: boolean } {
	let content: string;
	if (bg.separate && bg.stdoutPath && bg.stderrPath) {
		const { content: c, keepFiles } = formatSeparateOutput(
			bg.stdoutPath,
			bg.stderrPath,
			exitCode,
		);
		content = c;
		if (!keepFiles) {
			try {
				unlinkSync(bg.stdoutPath);
			} catch {}
			try {
				unlinkSync(bg.stderrPath);
			} catch {}
		}
	} else if (!bg.separate && bg.stdoutPath) {
		const { content: c, keepFile } = formatMergedOutput(
			bg.stdoutPath,
			exitCode,
		);
		content = c;
		if (!keepFile) {
			try {
				unlinkSync(bg.stdoutPath);
			} catch {}
		}
	} else {
		content = `exit code: ${exitCode}`;
	}

	// First line, so it frames the output rather than trailing it: a truncated
	// 10KB result is read from the top, and the whole point is that the reader
	// knows the scope before reading the answer.
	if (bg.cwdNotice) content = `${bg.cwdNotice}\n${content}`;

	return { content, isError: exitCode !== 0 };
}

// ── Public background-process helpers ──

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
		if (bg.separate) {
			if (bg.stdoutPath) parts.push(`stdout file: ${bg.stdoutPath}`);
			if (bg.stderrPath) parts.push(`stderr file: ${bg.stderrPath}`);
		} else if (bg.stdoutPath) {
			parts.push(`output file: ${bg.stdoutPath}`);
		}
		parts.push(
			"Use read_file on the output file(s) above to see what was captured.",
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
		const result = formatBashResult(bg, bg.exitCode);
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

	if (bg.separate) {
		if (bg.stdoutPath) parts.push(`stdout file: ${bg.stdoutPath}`);
		if (bg.stderrPath) parts.push(`stderr file: ${bg.stderrPath}`);
	} else if (bg.stdoutPath) {
		parts.push(`output file: ${bg.stdoutPath}`);
	}

	parts.push(
		"\n(Process still running. Call yield() to wait for completion — the background_complete message will wake you up. Or read_file on the paths above for partial output without waiting.)",
	);

	return parts.join("\n");
}

/**
 * Spawn a bash command with foreground timeout support.
 * Merged mode (default): stdout+stderr captured to a single `.out` file.
 * Separate mode (opt-in): captured to `.stdout` + `.stderr` files.
 *
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
 * @param separate - If true, capture stdout and stderr as two separate streams.
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
	fgMap?: Map<string, ForegroundExecution>,
	separate = false,
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

	// Output file paths
	const execId = ulid();
	ensureTmpDir();
	const stdoutPath = separate
		? join(MXD_TMP_DIR, `exec-${execId}.stdout`)
		: join(MXD_TMP_DIR, `exec-${execId}.out`);
	const stderrPath = separate
		? join(MXD_TMP_DIR, `exec-${execId}.stderr`)
		: null;
	const cwdPath = join(MXD_TMP_DIR, `cwd-${execId}`);

	// The EXIT trap is the WHOLE of CWD tracking: it writes the shell's final pwd
	// to a temp file, which catches every way a directory can change — a bare
	// `cd`, one inside a `&&` chain, one inside a sourced script — and touches
	// neither stdout nor stderr.
	//
	// It writes a SECOND line: `git rev-parse --show-toplevel`, i.e. which
	// checkout that final directory belongs to, answered by git itself. It rides
	// here rather than in a daemon-side spawn because we are already paying for
	// this shell, and a few milliseconds inside it beats a whole extra process
	// per bash call. ⚠️ The `2>/dev/null` is load-bearing, not tidiness: outside
	// a repository `git rev-parse` fails LOUDLY on stderr, and that case is
	// normal rather than an error — in merged mode the subshell's stderr is
	// folded into the command's own output, so without it every command run from
	// /tmp would report a git error it did not cause. The trap writes to a file
	// for exactly this reason and must not undo it.
	//
	// Background commands get the trap too. They cannot change the agent's CWD
	// and nothing applies theirs, but their RESULT still has to say which
	// directory it came from, and one mechanism for all three result paths beats
	// a second probe shaped differently.
	//
	// `cd` itself is deliberately left as the builtin. There was an override here
	// that errored on `cd <the directory you are already in>`; the whole of its
	// body existed to produce that error, and cd-ing to where you already are is
	// now a free no-op, because a redundant `cd` costs a few tokens and a command
	// that runs in the wrong repository costs a great deal more. Do not
	// reintroduce a wrapper to reach some other end either: `cd() { builtin cd
	// "$1"; }` is strictly worse than the builtin it replaces — it breaks `cd -`
	// and an empty argument stops meaning $HOME.
	//
	// Immediate-background commands get no prefix at all: they cannot change the
	// agent's CWD, so there is nothing to track.
	const isImmediateBackground = foregroundTimeout === 0 && !!sessionId;
	const wrapperPrefix = `___mxd_trap() { { pwd; git rev-parse --show-toplevel; } > "${cwdPath}" 2>/dev/null; }; trap ___mxd_trap EXIT; `;

	// Merged mode: subshell wrapped with 2>&1 so all output funnels to stdout file.
	// Bash's own stderr is discarded ("ignore"); rare bash-level syntax errors
	// may be lost but normal command stderr flows through.
	const shellCommand = separate
		? `${wrapperPrefix}${command}`
		: `(${wrapperPrefix}${command}) 2>&1`;

	const spawnOpts: Parameters<typeof Bun.spawn>[1] = {
		cwd: effectiveCwd,
		stdout: Bun.file(stdoutPath),
		stderr: separate ? Bun.file(stderrPath as string) : "ignore",
		env: process.env,
	};
	const proc = Bun.spawn(["bash", "-c", shellCommand], spawnOpts);

	const startTime = Date.now();

	// Helper: use formatBashResult + read CWD from temp file for foreground results
	function parseForegroundResult(exitCode: number): {
		content: string;
		isError: boolean;
		cwd?: string;
	} {
		// The directory has to be known BEFORE the output is formatted, because
		// the notice is the result's first line.
		let newCwd: string | undefined;
		const probe = readCwdProbe(cwdPath);
		try {
			unlinkSync(cwdPath);
		} catch {
			// Already removed, or the shell died before its trap ran.
		}
		if (probe.pwd && probe.pwd !== realpathOr(effectiveCwd)) {
			newCwd = probe.pwd;
		}

		// Prepend workdir reset if CWD was invalid
		let resetMsg: string | undefined;
		if (effectiveCwd !== cwd) {
			resetMsg = `workdir reset to ${effectiveCwd} (previous dir '${cwd}' no longer exists)`;
			if (!newCwd) newCwd = effectiveCwd;
		}

		const result = formatBashResult(
			{
				separate,
				stdoutPath,
				stderrPath,
				// The directory the shell ENDED in, which is where the output
				// above came from and where the next command will start. Not the
				// one it started in: `cd ~/.mxd && cat config.json` produces
				// output about ~/.mxd, and naming the worktree there would be the
				// very defect this line exists to remove.
				cwdNotice: formatCwdNotice(
					newCwd ?? effectiveCwd,
					fallbackCwd,
					probe.gitTop,
				),
			},
			exitCode,
		);

		let content = result.content;
		if (resetMsg) content = `${resetMsg}\n${content}`;

		// An EVENT — "you just moved" — which the notice above does not report and
		// cannot: that one is a statement about state. The `[Note: CWD is outside
		// your worktree …]` line that used to follow is GONE, because once every
		// affected result names its own directory, a one-shot warning fires only
		// where the notice already fired and says the same thing twice. Its one
		// piece of unique content, naming the worktree root, moved into the
		// notice; "remember to cd back" was advice that had to survive until the
		// agent acted on it, and a line on every subsequent result does that job
		// better than a reminder it has already scrolled past.
		if (newCwd) {
			content += `\n\nworkdir set to ${newCwd} from now on`;
		}

		// Append execution duration
		const durationMs = Date.now() - startTime;
		const durationStr =
			durationMs >= 1000
				? `${(durationMs / 1000).toFixed(1)}s`
				: `${durationMs}ms`;
		content += `\nDuration: ${durationStr}`;

		return {
			content,
			isError: result.isError,
			cwd: newCwd,
		};
	}

	// Shared helper: move a running process to background tracking.
	// Both immediate-background and timeout-background paths call this.
	function moveToBackground(opts: {
		exitPromise: Promise<number>;
		reason: string;
	}): {
		content: string;
		isError: boolean;
		backgroundId: string;
		backgroundCommand: string;
	} {
		const bgId = `bg-${ulid()}`;
		const bgEntry: BackgroundProcess = {
			id: bgId,
			command,
			separate,
			startTime,
			exitCode: null,
			status: "running",
			kill: () => proc.kill(),
			stdoutPath,
			stderrPath,
			cwdPath,
		};
		bgEntry.completionPromise = new Promise<void>((resolve) => {
			bgEntry.resolveCompletion = resolve;
		});
		// biome-ignore lint/style/noNonNullAssertion: caller guarantees bgMap exists
		bgMap!.set(bgId, bgEntry);

		// Monitor in background
		(async () => {
			try {
				const exitCode = await opts.exitPromise;
				bgEntry.exitCode = exitCode;
				bgEntry.status = exitCode === 0 ? "completed" : "failed";
				bgEntry.endTime = Date.now();
				bgEntry.kill = null;

				// A background result is the one MOST likely to mislead about its
				// directory: it arrives detached from the command that moved
				// there, sometimes many turns later. Stored on the entry so the
				// `background` tool's status action reports the same thing.
				const probe = readCwdProbe(cwdPath);
				bgEntry.cwdNotice = formatCwdNotice(
					probe.pwd ?? effectiveCwd,
					fallbackCwd,
					probe.gitTop,
				);

				const result = formatBashResult(bgEntry, exitCode);

				if (queue) {
					try {
						queue.enqueue(
							createBackgroundComplete({
								commandId: bgId,
								command,
								exitCode,
								durationMs: Date.now() - startTime,
								content: result.content,
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

		const filesLine = separate
			? `Output files: ${stdoutPath}, ${stderrPath}`
			: `Output file: ${stdoutPath}`;
		return {
			content: `${opts.reason}\nBackground ID: ${bgId}\nCommand: ${command}\n${filesLine}\nYou will be notified with output when it completes. Use yield() to wait.\nCWD is not affected by backgrounded commands. Your current working directory remains: ${cwd}`,
			isError: false,
			backgroundId: bgId,
			backgroundCommand: command,
		};
	}

	// Immediate background: foregroundTimeout === 0
	if (isImmediateBackground) {
		if (!bgMap) {
			proc.kill();
			// Clean up the files we'd otherwise orphan
			try {
				unlinkSync(stdoutPath);
			} catch {}
			if (stderrPath) {
				try {
					unlinkSync(stderrPath);
				} catch {}
			}
			return {
				content: "Command cannot be backgrounded (no session for tracking).",
				isError: true,
			};
		}
		return moveToBackground({
			exitPromise: proc.exited,
			reason: "Command backgrounded immediately.",
		});
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

	// External signals: two different verbs on the same running command.
	//   resolve()   — move to background. The command KEEPS RUNNING; the agent
	//                 gets a background id and is told to yield for the result.
	//   interrupt() — the user pressed stop. The command is TERMINATED, and the
	//                 output it already produced comes back as its result.
	// Both are registered under one key so whoever holds the session can reach a
	// running foreground execution without knowing anything about bash.
	// Use toolCallId as key when available (allows frontend to reference via tool_call event ID)
	const fgKey = toolCallId ?? execId;
	const externalSignalPromise = new Promise<
		{ timedOut: true; reason: BackgroundReason } | { interrupted: true }
	>((resolve) => {
		if (sessionId && fgMap) {
			const key = `${sessionId}:${fgKey}`;
			fgMap.set(key, {
				resolve: () => resolve({ timedOut: true, reason: "user" }),
				interrupt: () => resolve({ interrupted: true }),
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

	if ("interrupted" in result) {
		// Terminate, then report through the SAME formatter a normal completion
		// uses. The output file is already on disk, so "what it printed before it
		// was stopped" costs nothing to include — and NOT including it is the
		// expensive option: a model told only "interrupted" knows it ran a command
		// and lost the result, which invites re-running something that already had
		// side effects. An interrupt stops the work; it does not erase what
		// already happened.
		proc.kill();
		const exitCode = await proc.exited;
		const parsed = parseForegroundResult(exitCode);
		return {
			...parsed,
			content: `${INTERRUPTED_BY_USER}\n${parsed.content}`,
			isError: true,
		};
	}

	if (!result.timedOut) {
		// Process completed within foreground timeout — return normally
		return parseForegroundResult(result.exitCode);
	}

	// Foreground timeout hit — move to background
	if (!sessionId || !bgMap) {
		proc.kill();
		try {
			unlinkSync(stdoutPath);
		} catch {}
		if (stderrPath) {
			try {
				unlinkSync(stderrPath);
			} catch {}
		}
		return {
			content: `Command timed out after ${foregroundTimeout}ms and was killed (no session for backgrounding).`,
			isError: true,
		};
	}

	const movedReason =
		result.reason === "user"
			? "Command moved to background."
			: `Command moved to background after ${foregroundTimeout}ms.`;

	return moveToBackground({
		exitPromise: exitPromise.then((r) => r.exitCode),
		reason: movedReason,
	});
}
