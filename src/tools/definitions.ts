import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { z } from "zod";
import type { MessageQueue } from "../message-queue.ts";
import { tool } from "../tool-definition.ts";
import type { TaskSession } from "../types.ts";
import { executeBackgroundTool } from "./background.ts";
import { executeBashWithTimeout } from "./bash.ts";
import { jsSearch } from "./search.ts";

/**
 * Callback to look up a TaskSession by sessionId.
 * Used by tool handlers to access session-scoped state.
 */
export type GetSessionFn = (sessionId: string) => TaskSession | undefined;

import { isAbsolute, join } from "node:path";

/** Resolve a path relative to cwd if not absolute. */
export function resolvePath(p: string, cwd: string): string {
	return isAbsolute(p) ? p : join(cwd, p);
}

/**
 * Handler return type for built-in tools. Content is MCP Array format (executeTool converts to string).
 * Extra fields are passed through to ToolResult by executeTool().
 * The index signature satisfies CallToolResult compatibility from the MCP SDK.
 */
interface BuiltinToolResult {
	[key: string]: unknown;
	content: Array<
		| { type: "text"; text: string }
		| { type: "image"; data: string; mimeType: string }
	>;
	isError?: boolean;
	cwd?: string;
	backgroundId?: string;
	backgroundCommand?: string;
	isImage?: boolean;
	imageData?: string;
	mediaType?: string;
}

/** Helper to build a text CallToolResult with optional extended properties. */
function textResult(
	text: string,
	isError?: boolean,
	extra?: Partial<BuiltinToolResult>,
): BuiltinToolResult {
	return {
		content: [{ type: "text", text }],
		...(isError ? { isError } : {}),
		...extra,
	};
}

/**
 * Create built-in tool definitions with handler closures.
 * Each handler wraps the existing implementation, passing session state where needed.
 *
 * @param getSession - Callback to look up TaskSession by sessionId
 * @param sessionId - Current session ID (= taskId)
 * @param getCwd - Returns the current working directory (mutable via bash cd)
 * @param getFallbackCwd - Returns the fallback CWD (project/worktree root)
 * @param queue - Optional message queue for background completion notifications
 */
export function createBuiltinTools(
	getSession: GetSessionFn,
	sessionId: string,
	getCwd: () => string,
	getFallbackCwd: () => string | undefined,
	getQueue: () => MessageQueue | undefined,
) {
	// ── bash ──
	const bashTool = tool(
		"bash",
		"Execute a bash command. Use for: running tests, git operations, build tools, package management, and system commands. Do NOT use bash for file operations — use the dedicated tools instead (read_file, write_file, edit_file, list_files, search). The `cd` command has special behavior: working directory is tracked across calls, so if you `cd` in one command, subsequent commands automatically run from the new directory. Do NOT cd to your current working directory — it will return an error. No need to prefix every command with `cd /path &&`. Exception: after a daemon restart, your workdir resets to the project root. If you navigate outside your worktree, you'll be warned — remember to cd back when done.\n\nforeground_timeout controls how long to wait in the foreground before backgrounding the command. Use `run_in_background: true` as the preferred way to intentionally run a command in the background (equivalent to foreground_timeout=0). If the command finishes before the timeout, results are returned immediately. If not, the command moves to background and you get partial output + a background handle. Background completions are delivered as messages on your next yield() or tool call.\n\nForeground bash commands automatically track CWD changes (cd commands update the working directory for subsequent calls). Background commands (run_in_background=true or commands that exceeded foreground_timeout) do NOT affect CWD — your working directory stays at whatever it was before the backgrounded command. You can read_file on the output file paths to check partial output while the process runs.\n\nBackground completion notifications include stdout/stderr content inline when output is small (< 50KB). For large output, use read_file on the output file paths. Output files persist until the session ends.\n\nDo NOT pipe through head, tail, or grep to truncate output. Long output is automatically saved to files for you to read — if the output is short, truncation is pointless; if it's long, the tool saves it and you can read_file or search the saved file afterward. Especially for test runs: NEVER truncate test output. You need to see every failure, every stack trace, and every flaky result to debug effectively.",
		{
			command: z.string().describe("The bash command to execute"),
			run_in_background: z
				.boolean()
				.optional()
				.describe(
					"If true, run command in background immediately (equivalent to foreground_timeout=0). Preferred way to intentionally background a command.",
				),
			foreground_timeout: z
				.number()
				.optional()
				.describe(
					"Maximum time in ms to run in foreground before backgrounding. 0 = immediate background. Default: 120000 (2 minutes).",
				),
		},
		async (args, extra) => {
			const command = args.command;
			const runInBackground = args.run_in_background;
			const foregroundTimeout = runInBackground
				? 0
				: Math.max(args.foreground_timeout ?? 120000, 0);

			const session = getSession(sessionId);
			const toolCallId = (extra as { toolCallId?: string })?.toolCallId;
			try {
				const result = await executeBashWithTimeout(
					command,
					getCwd(),
					getFallbackCwd(),
					foregroundTimeout,
					sessionId,
					getQueue(),
					toolCallId,
					session?.backgroundProcesses,
					session?.foregroundExecutions,
				);
				return textResult(result.content, result.isError, {
					cwd: result.cwd,
					backgroundId: result.backgroundId,
					backgroundCommand: result.backgroundCommand,
				});
			} catch (e) {
				return textResult(
					`Error: ${e instanceof Error ? e.message : String(e)}`,
					true,
				);
			}
		},
	);

	// ── background ──
	const backgroundTool = tool(
		"background",
		"Manage background processes. Use to list, check status, kill, or await background processes that were started via bash with run_in_background=true or that exceeded foreground_timeout.\n\nActions:\n- list: Show all background processes for this session\n- status: Get detailed status of a specific background process\n- kill: Terminate a running background process\n- await: Block until a background process completes and return its full output (like a foreground command)",
		{
			action: z
				.enum(["list", "status", "kill", "await"])
				.describe(
					"Action to take. 'list': show all background processes. 'status': get status of a specific process. 'kill': terminate a process. 'await': block until completion.",
				),
			id: z
				.string()
				.optional()
				.describe(
					"Background process ID (e.g. 'bg-A1B2C3D4'). Required for status, kill, and await actions.",
				),
			timeout: z
				.number()
				.optional()
				.describe(
					"Maximum time in ms to wait for await action. Optional — defaults to waiting indefinitely.",
				),
		},
		async (args) => {
			const action = args.action;
			const id = args.id;
			const timeout = args.timeout;

			const bgSession = getSession(sessionId);
			if (!bgSession) {
				return textResult(
					"Error: no session context for background process management.",
					true,
				);
			}

			const result = await executeBackgroundTool(
				action,
				id,
				timeout,
				bgSession.backgroundProcesses,
			);
			return textResult(result.content, result.isError);
		},
	);

	// ── read_file ──
	const readFileTool = tool(
		"read_file",
		"Read the contents of a file with line numbers. You MUST read a file before editing it to understand existing code. For large files, use offset and limit to read in chunks.",
		{
			path: z.string().describe("Absolute or relative path to the file"),
			offset: z
				.number()
				.optional()
				.describe("Start reading from this line number, 1-based (default: 1)"),
			limit: z
				.number()
				.optional()
				.describe(
					"Maximum number of lines to return (default: all). Use with offset for paginating large files.",
				),
		},
		async (args) => {
			const path = resolvePath(args.path, getCwd());
			const ext = path.split(".").pop()?.toLowerCase();
			const IMAGE_MEDIA_TYPES: Record<
				string,
				"image/jpeg" | "image/png" | "image/gif" | "image/webp"
			> = {
				png: "image/png",
				jpg: "image/jpeg",
				jpeg: "image/jpeg",
				gif: "image/gif",
				webp: "image/webp",
			};
			const imageMediaType = ext ? IMAGE_MEDIA_TYPES[ext] : undefined;

			if (imageMediaType) {
				try {
					const data = readFileSync(path);
					const base64 = data.toString("base64");
					return {
						content: [
							{ type: "text" as const, text: `[Image: ${basename(path)}]` },
						],
						isImage: true,
						imageData: base64,
						mediaType: imageMediaType,
					};
				} catch (e) {
					return textResult(
						`Error reading file: ${e instanceof Error ? e.message : String(e)}`,
						true,
					);
				}
			}

			const offset = Math.max(1, args.offset ?? 1);
			const limit = args.limit;
			try {
				const raw = readFileSync(path, "utf-8");
				if (offset === 1 && !limit) {
					return textResult(raw);
				}
				const lines = raw.split("\n");
				const start = offset - 1;
				const sliced =
					limit !== undefined
						? lines.slice(start, start + limit)
						: lines.slice(start);
				const remaining = lines.length - (start + sliced.length);
				let content = sliced.join("\n");
				if (remaining > 0) {
					content += `\n[... ${remaining} more lines, use offset=${offset + sliced.length} to continue]`;
				}
				return textResult(content);
			} catch (e) {
				return textResult(
					`Error reading file: ${e instanceof Error ? e.message : String(e)}`,
					true,
				);
			}
		},
	);

	// ── write_file ──
	const writeFileTool = tool(
		"write_file",
		"Write content to a file. Creates parent directories automatically. Use for new files or complete rewrites. For modifying existing files, prefer edit_file.",
		{
			path: z.string().describe("Path to the file"),
			content: z.string().describe("Content to write"),
		},
		async (args) => {
			const path = resolvePath(args.path, getCwd());
			const content = args.content;
			try {
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, content, "utf-8");
				return textResult(`File written: ${path}`);
			} catch (e) {
				return textResult(
					`Error writing file: ${e instanceof Error ? e.message : String(e)}`,
					true,
				);
			}
		},
	);

	// ── edit_file ──
	const editFileTool = tool(
		"edit_file",
		"Replace a specific string in a file. The old_string must be an EXACT match (including whitespace and indentation). If old_string is not unique, provide more surrounding context lines to make it unique, or use replace_all=true for bulk renames. You must read_file first to see the exact content.",
		{
			path: z.string().describe("Path to the file"),
			old_string: z
				.string()
				.describe(
					"The exact string to find and replace. Must match file content exactly, including whitespace.",
				),
			new_string: z.string().describe("The replacement string"),
			replace_all: z
				.boolean()
				.optional()
				.describe(
					"If true, replace all occurrences (default: false, which requires old_string to be unique in file)",
				),
		},
		async (args) => {
			const path = resolvePath(args.path, getCwd());
			const oldStr = args.old_string;
			const newStr = args.new_string;
			const replaceAll = args.replace_all ?? false;
			try {
				if (!existsSync(path)) {
					return textResult(`File not found: ${path}`, true);
				}
				const content = readFileSync(path, "utf-8");
				const occurrences = content.split(oldStr).length - 1;
				if (occurrences === 0) {
					return textResult("old_string not found in file", true);
				}
				if (!replaceAll && occurrences > 1) {
					return textResult(
						`old_string found ${occurrences} times — must be unique. Use replace_all=true to replace all.`,
						true,
					);
				}
				const updated = replaceAll
					? content.replaceAll(oldStr, newStr)
					: content.replace(oldStr, newStr);
				writeFileSync(path, updated, "utf-8");
				const msg =
					replaceAll && occurrences > 1
						? `File edited: ${path} (${occurrences} replacements)`
						: `File edited: ${path}`;
				return textResult(msg);
			} catch (e) {
				return textResult(
					`Error editing file: ${e instanceof Error ? e.message : String(e)}`,
					true,
				);
			}
		},
	);

	// ── list_files ──
	const listFilesTool = tool(
		"list_files",
		'List files matching a glob pattern. Use to discover project structure and find relevant files before reading them. Examples: "src/**/*.ts", "**/*.test.ts", "*.json".',
		{
			pattern: z
				.string()
				.optional()
				.describe('Glob pattern (e.g. "src/**/*.ts", "*.json"). Default: "*"'),
		},
		async (args) => {
			const pattern = args.pattern ?? "*";
			try {
				const glob = new Bun.Glob(pattern);
				const files: string[] = [];
				for await (const file of glob.scan({ cwd: getCwd(), dot: false })) {
					files.push(file);
					if (files.length >= 500) break;
				}
				return textResult(files.join("\n") || "(no files)");
			} catch (e) {
				return textResult(
					`Error: ${e instanceof Error ? e.message : String(e)}`,
					true,
				);
			}
		},
	);

	// ── search ──
	const searchTool = tool(
		"search",
		'A powerful regex search tool. ALWAYS use this for search tasks — NEVER invoke grep or rg via bash. Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+"). The path parameter accepts a directory or a single file. Filter files with glob parameter (e.g., "*.ts", "*.{ts,tsx}"). Output modes: "content" (default) shows matching lines with line numbers, "files_with_matches" shows only file paths (fast discovery), "count" shows match counts per file.',
		{
			pattern: z
				.string()
				.describe("Regex pattern to search for (ripgrep syntax, not grep)"),
			path: z
				.string()
				.optional()
				.describe("Directory or file to search in (default: .)"),
			glob: z
				.string()
				.optional()
				.describe('File glob filter (e.g. "*.ts", "*.{ts,tsx}")'),
			context: z
				.number()
				.optional()
				.describe(
					"Number of context lines before and after each match (default: 0)",
				),
			output_mode: z
				.enum(["content", "files_with_matches", "count"])
				.optional()
				.describe(
					"'content' (default): matching lines with line numbers. 'files_with_matches': file paths only (fast discovery). 'count': match counts per file.",
				),
			head_limit: z
				.number()
				.optional()
				.describe("Max number of output entries (default: 50, max: 200)"),
			case_insensitive: z
				.boolean()
				.optional()
				.describe("Case-insensitive search (default: false)"),
			multiline: z
				.boolean()
				.optional()
				.describe(
					"Enable multiline matching with RegExp 's' flag, allowing '.' to match newlines (default: false).",
				),
			excluded_dirs: z
				.array(z.string())
				.optional()
				.describe(
					"Directories to exclude from search. Defaults to: node_modules, .git, dist, out, .worktrees, .cache, coverage, .next, build. Pass empty array to include all.",
				),
		},
		async (args) => {
			const pattern = args.pattern;
			const searchPath = args.path ?? ".";
			const glob = args.glob;
			const contextLines = args.context;
			const outputMode = args.output_mode ?? "content";
			const headLimit = Math.min(args.head_limit ?? 50, 200);
			const caseInsensitive = args.case_insensitive ?? false;
			const excludedDirs = args.excluded_dirs;
			const multiline = args.multiline ?? false;

			try {
				const result = await jsSearch({
					pattern,
					searchPath,
					glob,
					contextLines,
					outputMode,
					headLimit,
					caseInsensitive,
					multiline,
					excludedDirs,
					cwd: getCwd(),
				});
				return textResult(result || "(no matches)");
			} catch (e) {
				return textResult(
					`Error: ${e instanceof Error ? e.message : String(e)}`,
					true,
				);
			}
		},
	);

	return [
		bashTool,
		backgroundTool,
		readFileTool,
		writeFileTool,
		editFileTool,
		listFilesTool,
		searchTool,
	];
}
