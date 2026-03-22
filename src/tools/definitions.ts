import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages";

export const TOOLS: Tool[] = [
	{
		name: "bash",
		description:
			"Execute a bash command. Use for: running tests, git operations, build tools, package management, and system commands. Do NOT use bash for file operations — use the dedicated tools instead (read_file, write_file, edit_file, list_files, search). The `cd` command has special behavior: working directory is tracked across calls, so if you `cd` in one command, subsequent commands automatically run from the new directory. Do NOT cd to your current working directory — it will return an error. No need to prefix every command with `cd /path &&`. Exception: after a daemon restart, your workdir resets to the project root. If you navigate outside your worktree, you'll be warned — remember to cd back when done.\n\nforeground_timeout controls how long to wait in the foreground before backgrounding the command. Use `run_in_background: true` as the preferred way to intentionally run a command in the background (equivalent to foreground_timeout=0). If the command finishes before the timeout, results are returned immediately. If not, the command moves to background and you get partial output + a background handle. Background completions are delivered as messages on your next yield() or tool call.\n\nForeground bash commands automatically track CWD changes (cd commands update the working directory for subsequent calls). Background commands (run_in_background=true or commands that exceeded foreground_timeout) do NOT affect CWD — your working directory stays at whatever it was before the backgrounded command. You can read_file on the output file paths to check partial output while the process runs.\n\nBackground completion notifications include stdout/stderr content inline when output is small (< 50KB). For large output, use read_file on the output file paths. Output files persist until the session ends.",
		input_schema: {
			type: "object" as const,
			properties: {
				command: {
					type: "string",
					description: "The bash command to execute",
				},
				run_in_background: {
					type: "boolean",
					description:
						"If true, run command in background immediately (equivalent to foreground_timeout=0). Preferred way to intentionally background a command.",
				},
				foreground_timeout: {
					type: "number",
					description:
						"Maximum time in ms to run in foreground before backgrounding. 0 = immediate background. Default: 120000 (2 minutes).",
				},
			},
			required: ["command"],
		},
	},
	{
		name: "background",
		description:
			"Manage background processes. Use to list, check status, kill, or await background processes that were started via bash with run_in_background=true or that exceeded foreground_timeout.\n\nActions:\n- list: Show all background processes for this session\n- status: Get detailed status of a specific background process\n- kill: Terminate a running background process\n- await: Block until a background process completes and return its full output (like a foreground command)",
		input_schema: {
			type: "object" as const,
			properties: {
				action: {
					type: "string",
					enum: ["list", "status", "kill", "await"],
					description:
						"Action to take. 'list': show all background processes. 'status': get status of a specific process. 'kill': terminate a process. 'await': block until completion.",
				},
				id: {
					type: "string",
					description:
						"Background process ID (e.g. 'bg-A1B2C3D4'). Required for status, kill, and await actions.",
				},
				timeout: {
					type: "number",
					description:
						"Maximum time in ms to wait for await action. Optional — defaults to waiting indefinitely.",
				},
			},
			required: ["action"],
		},
	},
	{
		name: "read_file",
		description:
			"Read the contents of a file with line numbers. You MUST read a file before editing it to understand existing code. For large files, use offset and limit to read in chunks.",
		input_schema: {
			type: "object" as const,
			properties: {
				path: {
					type: "string",
					description: "Absolute or relative path to the file",
				},
				offset: {
					type: "number",
					description:
						"Start reading from this line number, 1-based (default: 1)",
				},
				limit: {
					type: "number",
					description:
						"Maximum number of lines to return (default: all). Use with offset for paginating large files.",
				},
			},
			required: ["path"],
		},
	},
	{
		name: "write_file",
		description:
			"Write content to a file. Creates parent directories automatically. Use for new files or complete rewrites. For modifying existing files, prefer edit_file.",
		input_schema: {
			type: "object" as const,
			properties: {
				path: {
					type: "string",
					description: "Path to the file",
				},
				content: {
					type: "string",
					description: "Content to write",
				},
			},
			required: ["path", "content"],
		},
	},
	{
		name: "edit_file",
		description:
			"Replace a specific string in a file. The old_string must be an EXACT match (including whitespace and indentation). If old_string is not unique, provide more surrounding context lines to make it unique, or use replace_all=true for bulk renames. You must read_file first to see the exact content.",
		input_schema: {
			type: "object" as const,
			properties: {
				path: {
					type: "string",
					description: "Path to the file",
				},
				old_string: {
					type: "string",
					description:
						"The exact string to find and replace. Must match file content exactly, including whitespace.",
				},
				new_string: {
					type: "string",
					description: "The replacement string",
				},
				replace_all: {
					type: "boolean",
					description:
						"If true, replace all occurrences (default: false, which requires old_string to be unique in file)",
				},
			},
			required: ["path", "old_string", "new_string"],
		},
	},
	{
		name: "list_files",
		description:
			'List files matching a glob pattern. Use to discover project structure and find relevant files before reading them. Examples: "src/**/*.ts", "**/*.test.ts", "*.json".',
		input_schema: {
			type: "object" as const,
			properties: {
				pattern: {
					type: "string",
					description:
						'Glob pattern (e.g. "src/**/*.ts", "*.json"). Default: "*"',
				},
			},
			required: [],
		},
	},
	{
		name: "search",
		description:
			'A powerful regex search tool. ALWAYS use this for search tasks — NEVER invoke grep or rg via bash. Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+"). The path parameter accepts a directory or a single file. Filter files with glob parameter (e.g., "*.ts", "*.{ts,tsx}"). Output modes: "content" (default) shows matching lines with line numbers, "files_with_matches" shows only file paths (fast discovery), "count" shows match counts per file.',
		input_schema: {
			type: "object" as const,
			properties: {
				pattern: {
					type: "string",
					description: "Regex pattern to search for (ripgrep syntax, not grep)",
				},
				path: {
					type: "string",
					description: "Directory or file to search in (default: .)",
				},
				glob: {
					type: "string",
					description: 'File glob filter (e.g. "*.ts", "*.{ts,tsx}")',
				},
				context: {
					type: "number",
					description:
						"Number of context lines before and after each match (default: 0)",
				},
				output_mode: {
					type: "string",
					enum: ["content", "files_with_matches", "count"],
					description:
						"'content' (default): matching lines with line numbers. 'files_with_matches': file paths only (fast discovery). 'count': match counts per file.",
				},
				head_limit: {
					type: "number",
					description: "Max number of output entries (default: 50, max: 200)",
				},
				case_insensitive: {
					type: "boolean",
					description: "Case-insensitive search (default: false)",
				},
				multiline: {
					type: "boolean",
					description:
						"Enable multiline matching with RegExp 's' flag, allowing '.' to match newlines (default: false).",
				},
				excluded_dirs: {
					type: "array",
					items: { type: "string" },
					description:
						"Directories to exclude from search. Defaults to: node_modules, .git, dist, out, .worktrees, .cache, coverage, .next, build. Pass empty array to include all.",
				},
			},
			required: ["pattern"],
		},
	},
];
