import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { getImageDimensions } from "../image-dimensions.ts";
import * as R from "../resource-registry.ts";
import { defineTool } from "../tool-def.ts";
import { executeBackgroundTool } from "./background.ts";
import { executeBashWithTimeout } from "./bash.ts";
import { jsSearch } from "./search.ts";

/** Resolve a path relative to cwd if not absolute. */
export function resolvePath(p: string, cwd: string): string {
	return isAbsolute(p) ? p : join(cwd, p);
}

/** Helper to build a text result with optional extended properties. */
function textResult(
	text: string,
	isError?: boolean,
	extra?: Record<string, unknown>,
) {
	return {
		content: [{ type: "text" as const, text }],
		...(isError ? { isError } : {}),
		...extra,
	};
}

/** Get cwd for a task: node.cwd → node.worktreePath. Throws if neither set. */
function getTaskCwd(projectId: string, taskId: string | null): string {
	if (taskId) {
		const tracker = R.getTracker(projectId);
		const node = tracker?.getTask(taskId);
		if (node?.cwd) return node.cwd;
		if (node?.worktreePath) return node.worktreePath;
	}
	throw new Error(
		`No working directory for task ${taskId} in project ${projectId}`,
	);
}

/** Common bind params for all builtin tools (projectId + taskId). */
const bindParams = {
	projectId: {
		schema: z.string(),
		decl: {
			kind: "bind" as const,
			from: "projectId" as const,
		},
	},
	taskId: {
		schema: z.string(),
		decl: {
			kind: "bind" as const,
			from: "taskId" as const,
		},
	},
};

// ── bash ──

const bashTool = defineTool({
	name: "bash",
	availability: "internal",
	description:
		"Execute a bash command. Use for: running tests, git operations, build tools, package management, and system commands. Do NOT use bash for file operations — use the dedicated tools instead (read_file, write_file, edit_file, list_files, search). The `cd` command has special behavior: working directory is tracked across calls, so if you `cd` in one command, subsequent commands automatically run from the new directory. Do NOT cd to your current working directory — it will return an error. No need to prefix every command with `cd /path &&`. Exception: after a daemon restart, your workdir resets to the project root. If you navigate outside your worktree, you'll be warned — remember to cd back when done.\n\nforeground_timeout controls how long to wait in the foreground before backgrounding the command. Use `run_in_background: true` as the preferred way to intentionally run a command in the background (equivalent to foreground_timeout=0). If the command finishes before the timeout, results are returned immediately. If not, the command moves to background and you get a background handle + the path to the output file (you can read_file on it anytime while the command runs). Background completions are delivered as messages on your next yield() or tool call.\n\nForeground bash commands automatically track CWD changes (cd commands update the working directory for subsequent calls). Background commands (run_in_background=true or commands that exceeded foreground_timeout) do NOT affect CWD — your working directory stays at whatever it was before the backgrounded command. You can read_file on the output file paths to check partial output while the process runs.\n\nOutput handling: the tool **by default** (unless `separate: true` is passed) captures stdout+stderr merged — no need for `2>&1`. Small outputs (<1KB) are shown inline only. Medium outputs (≥1KB) are saved to a file AND shown in full inline, with the path announced at the top and bottom of the tool result. Large outputs (>10KB) show a head/tail slice plus the file path — the complete output is in the file, not in the inline tool result.\n\nPipe when the output shape is deterministic and the pipe is the thing you actually want: `ls | wc -l`, `git log --oneline | head -10`, `find . | xargs grep X`. Don't pipe when the output shape is uncertain — tests, debug sessions, long-running commands, anything whose failure mode you can't predict. **\"I've run this before\" doesn't make it predictable** — tests are the canonical trap: every run you confidently expect pass, every run you pipe to save space, and the one run that fails is the one that burns you.\n\nFor these uncertain-outcome commands, if you're tempted to pipe through `head`, `tail`, or `grep` to prevent your context from blowing up — don't. Your context is safe without any of those. The inline tool result is bounded (~10KB maximum, regardless of whether the command produced 10KB or 10MB). You don't need to pipe to protect context size; the bound is already predictable. Just run the command as-is.\n\nWhen you pipe, you break the full-output preservation. `command | head -30` means the tool only ever sees the 30 lines your pipe produced — the original full stream went through your pipe, not to us. If it turns out the line you needed was at position 47, it doesn't exist anywhere: not in the tool's memory, not on disk, not recoverable.\n\nImagine a flaky test you ran 1000 times to catch a single failure. The stack trace prints. You piped to `tail -30` because \"usually the last few lines are enough\" — but this time the real clue was at line 47. Gone — your pipe consumed the stream, the tool never saw it.\n\nPass `separate: true` if you genuinely need stdout and stderr distinguished (rare). The output then appears as two labeled sections with separate file paths. The same 10KB inline bound applies and they share the budget.",
	params: {
		...bindParams,
		command: {
			schema: z.string().describe("The bash command to execute"),
			decl: { kind: "explicit" },
		},
		run_in_background: {
			schema: z.boolean().optional(),
			decl: { kind: "optional" },
			description:
				"If true, run command in background immediately (equivalent to foreground_timeout=0). Preferred way to intentionally background a command.",
		},
		foreground_timeout: {
			schema: z.number().optional(),
			decl: { kind: "optional" },
			description:
				"Maximum time in ms to run in foreground before backgrounding. 0 = immediate background. Default: 120000 (2 minutes).",
		},
		separate: {
			schema: z.boolean().optional(),
			decl: { kind: "optional" },
			description:
				"If true, capture stdout and stderr as two separate streams with labeled sections and separate file paths. Default (false) merges both streams into one output, so you don't need `2>&1`. Set to true only when you genuinely need to distinguish the two (rare).",
		},
	},
	handler: async (args, _auth, toolCallId) => {
		const projectId = args.projectId;
		const taskId = args.taskId;
		const command = args.command;
		const runInBackground = args.run_in_background;
		const foregroundTimeout = runInBackground
			? 0
			: Math.max(args.foreground_timeout ?? 120000, 0);

		const session = R.getSession(projectId, taskId);
		const cwd = getTaskCwd(projectId, taskId);
		const tracker = R.getTracker(projectId);
		const node = taskId ? tracker?.getTask(taskId) : undefined;
		const fallbackCwd = node?.worktreePath ?? undefined;
		const queue = session?.queue;

		try {
			const result = await executeBashWithTimeout(
				command,
				cwd,
				fallbackCwd,
				foregroundTimeout,
				taskId,
				queue,
				toolCallId,
				session?.backgroundProcesses,
				session?.foregroundExecutions,
				args.separate ?? false,
			);
			// Update node.cwd if bash cd changed it — persisted on node, survives restart
			if (result.cwd && taskId) {
				const t = R.getTracker(projectId);
				const n = t?.getTask(taskId);
				if (n) {
					n.cwd = result.cwd;
					await t?.save();
				}
			}
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
});

// ── background ──

const backgroundTool = defineTool({
	name: "background",
	availability: "internal",
	description:
		"Manage background processes. Use to list, check status, or kill background processes that were started via bash with run_in_background=true or that exceeded foreground_timeout.\n\nActions:\n- list: Show all background processes for this session\n- status: Get detailed status of a specific background process\n- kill: Terminate a running background process\n\nTo wait for background process completion, use yield() — background completions are delivered as queue messages.",
	params: {
		...bindParams,
		action: {
			schema: z
				.enum(["list", "status", "kill"])
				.describe(
					"Action to take. 'list': show all background processes. 'status': get status of a specific process. 'kill': terminate a process.",
				),
			decl: { kind: "explicit" },
		},
		id: {
			schema: z.string().optional(),
			decl: { kind: "optional" },
			description:
				"Background process ID (e.g. 'bg-A1B2C3D4'). Required for status and kill actions.",
		},
	},
	handler: async (args) => {
		const projectId = args.projectId;
		const taskId = args.taskId;
		const session = R.getSession(projectId, taskId);
		if (!session) {
			return textResult(
				"Error: no session context for background process management.",
				true,
			);
		}

		const result = await executeBackgroundTool(
			args.action,
			args.id,
			session.backgroundProcesses,
		);
		return textResult(result.content, result.isError);
	},
});

// ── read_file ──

const readFileTool = defineTool({
	name: "read_file",
	availability: "internal",
	description:
		"Read the contents of a file with line numbers. You MUST read a file before editing it to understand existing code. For large files, use offset and limit to read in chunks.",
	params: {
		...bindParams,
		path: {
			schema: z.string().describe("Absolute or relative path to the file"),
			decl: { kind: "explicit" },
		},
		offset: {
			schema: z.number().optional(),
			decl: { kind: "optional" },
			description: "Start reading from this line number, 1-based (default: 1)",
		},
		limit: {
			schema: z.number().optional(),
			decl: { kind: "optional" },
			description:
				"Maximum number of lines to return (default: all). Use with offset for paginating large files.",
		},
	},
	handler: async (args) => {
		const cwd = getTaskCwd(args.projectId, args.taskId);
		const path = resolvePath(args.path, cwd);
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
				const MAX_DIMENSION = 8000;
				const dims = getImageDimensions(data);
				if (
					dims &&
					(dims.width > MAX_DIMENSION || dims.height > MAX_DIMENSION)
				) {
					return textResult(
						`Image too large (${dims.width}x${dims.height} pixels, max ${MAX_DIMENSION}px per dimension). Consider resizing with: magick ${basename(path)} -resize ${MAX_DIMENSION}x${MAX_DIMENSION}\\> resized_${basename(path)}`,
						true,
					);
				}
				const base64 = data.toString("base64");
				return {
					content: [
						{
							type: "text" as const,
							text: `[Image: ${basename(path)}]`,
						},
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
});

// ── write_file ──

const writeFileTool = defineTool({
	name: "write_file",
	availability: "internal",
	description:
		"Write content to a file. Creates parent directories automatically. Use for new files or complete rewrites. For modifying existing files, prefer edit_file.",
	params: {
		...bindParams,
		path: {
			schema: z.string().describe("Path to the file"),
			decl: { kind: "explicit" },
		},
		content: {
			schema: z.string().describe("Content to write"),
			decl: { kind: "explicit" },
		},
	},
	handler: async (args) => {
		const cwd = getTaskCwd(args.projectId, args.taskId);
		const path = resolvePath(args.path, cwd);
		try {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, args.content, "utf-8");
			return textResult(`File written: ${path}`);
		} catch (e) {
			return textResult(
				`Error writing file: ${e instanceof Error ? e.message : String(e)}`,
				true,
			);
		}
	},
});

// ── edit_file ──

const editFileTool = defineTool({
	name: "edit_file",
	availability: "internal",
	description:
		"Replace a specific string in a file. The old_string must be an EXACT match (including whitespace and indentation). If old_string is not unique, provide more surrounding context lines to make it unique, or use replace_all=true for bulk renames. You must read_file first to see the exact content.",
	params: {
		...bindParams,
		path: {
			schema: z.string().describe("Path to the file"),
			decl: { kind: "explicit" },
		},
		old_string: {
			schema: z
				.string()
				.describe(
					"The exact string to find and replace. Must match file content exactly, including whitespace.",
				),
			decl: { kind: "explicit" },
		},
		new_string: {
			schema: z.string().describe("The replacement string"),
			decl: { kind: "explicit" },
		},
		replace_all: {
			schema: z.boolean().optional(),
			decl: { kind: "optional" },
			description:
				"If true, replace all occurrences (default: false, which requires old_string to be unique in file)",
		},
	},
	handler: async (args) => {
		const cwd = getTaskCwd(args.projectId, args.taskId);
		const path = resolvePath(args.path, cwd);
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
});

// ── list_files ──

const listFilesTool = defineTool({
	name: "list_files",
	availability: "internal",
	description:
		'List files matching a glob pattern. Use to discover project structure and find relevant files before reading them. Examples: "src/**/*.ts", "**/*.test.ts", "*.json".',
	params: {
		...bindParams,
		pattern: {
			schema: z.string().optional(),
			decl: { kind: "optional" },
			description: 'Glob pattern (e.g. "src/**/*.ts", "*.json"). Default: "*"',
		},
	},
	handler: async (args) => {
		const cwd = getTaskCwd(args.projectId, args.taskId);
		const pattern = args.pattern ?? "*";
		try {
			const glob = new Bun.Glob(pattern);
			const files: string[] = [];
			for await (const file of glob.scan({ cwd, dot: false })) {
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
});

// ── search ──

const searchTool = defineTool({
	name: "search",
	availability: "internal",
	description:
		'A powerful regex search tool. ALWAYS use this for search tasks — NEVER invoke grep or rg via bash. Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+"). The path parameter accepts a directory or a single file. Filter files with glob parameter (e.g., "*.ts", "*.{ts,tsx}"). Output modes: "content" (default) shows matching lines with line numbers, "files_with_matches" shows only file paths (fast discovery), "count" shows match counts per file.',
	params: {
		...bindParams,
		pattern: {
			schema: z
				.string()
				.describe("Regex pattern to search for (ripgrep syntax, not grep)"),
			decl: { kind: "explicit" },
		},
		path: {
			schema: z.string().optional(),
			decl: { kind: "optional" },
			description: "Directory or file to search in (default: .)",
		},
		glob: {
			schema: z.string().optional(),
			decl: { kind: "optional" },
			description: 'File glob filter (e.g. "*.ts", "*.{ts,tsx}")',
		},
		context: {
			schema: z.number().optional(),
			decl: { kind: "optional" },
			description:
				"Number of context lines before and after each match (default: 0)",
		},
		output_mode: {
			schema: z.enum(["content", "files_with_matches", "count"]).optional(),
			decl: { kind: "optional" },
			description:
				"'content' (default): matching lines with line numbers. 'files_with_matches': file paths only (fast discovery). 'count': match counts per file.",
		},
		head_limit: {
			schema: z.number().optional(),
			decl: { kind: "optional" },
			description: "Max number of output entries (default: 50, max: 200)",
		},
		case_insensitive: {
			schema: z.boolean().optional(),
			decl: { kind: "optional" },
			description: "Case-insensitive search (default: false)",
		},
		multiline: {
			schema: z.boolean().optional(),
			decl: { kind: "optional" },
			description:
				"Enable multiline matching with RegExp 's' flag, allowing '.' to match newlines (default: false).",
		},
		excluded_dirs: {
			schema: z.array(z.string()).optional(),
			decl: { kind: "optional" },
			description:
				"Directories to exclude from search. Defaults to: node_modules, .git, dist, out, .worktrees, .cache, coverage, .next, build. Pass empty array to include all.",
		},
	},
	handler: async (args) => {
		const cwd = getTaskCwd(args.projectId, args.taskId);
		try {
			const result = await jsSearch({
				pattern: args.pattern,
				searchPath: args.path ?? ".",
				glob: args.glob,
				contextLines: args.context,
				outputMode: args.output_mode ?? "content",
				headLimit: Math.min(args.head_limit ?? 50, 200),
				caseInsensitive: args.case_insensitive ?? false,
				multiline: args.multiline ?? false,
				excludedDirs: args.excluded_dirs,
				cwd,
			});
			return textResult(result || "(no matches)");
		} catch (e) {
			return textResult(
				`Error: ${e instanceof Error ? e.message : String(e)}`,
				true,
			);
		}
	},
});

// ── Public API ──

/** All builtin tool definitions. */
export function buildBuiltinToolDefs() {
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
