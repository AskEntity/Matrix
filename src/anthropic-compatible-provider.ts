import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import Anthropic from "@anthropic-ai/sdk";
import type {
	MessageParam,
	TextBlockParam,
	Tool,
	ToolResultBlockParam,
	ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type {
	AgentEvent,
	AgentProvider,
	AgentRequest,
	AgentSession,
} from "./agent-provider.ts";
import { formatQueueMessage } from "./agent-tools.ts";
import { MessageQueue, type QueueMessage } from "./message-queue.ts";
import type { AgentResult } from "./types.ts";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 16384;

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** Extract images from queue messages and return Anthropic image content blocks. */
function extractQueueImages(msgs: QueueMessage[]): Array<{
	type: "image";
	source: { type: "base64"; media_type: ImageMediaType; data: string };
}> {
	const blocks: Array<{
		type: "image";
		source: { type: "base64"; media_type: ImageMediaType; data: string };
	}> = [];
	for (const msg of msgs) {
		if (msg.source === "user" && msg.images) {
			for (const img of msg.images) {
				blocks.push({
					type: "image",
					source: {
						type: "base64",
						media_type: img.mediaType as ImageMediaType,
						data: img.base64,
					},
				});
			}
		}
	}
	return blocks;
}
/** Reserve ~17% as compaction buffer — compress when messages exceed this */
const COMPACT_BUFFER_RATIO = 0.17;

/**
 * Get context window size for a model.
 * Claude Opus 4.6 and Sonnet 4.6 have 1M context by default.
 * Older models and Haiku use the standard 200k context window.
 * @internal Exported for testing
 */
export function getContextWindow(model: string): number {
	// Opus 4.6+ and Sonnet 4.6+ support 1M context natively
	if (model.includes("opus") || model.includes("sonnet-4")) return 1_000_000;
	return 200_000;
}

/**
 * Get compaction thresholds derived from the context window.
 * @internal Exported for testing
 */
export function getCompactionThresholds(contextWindow: number): {
	compressThreshold: number;
	lazyCountThreshold: number;
} {
	const compressThreshold = Math.floor(
		contextWindow * (1 - COMPACT_BUFFER_RATIO),
	);
	return {
		compressThreshold,
		lazyCountThreshold: compressThreshold - 16_000,
	};
}

/** Per-million-token pricing by model family. */
const MODEL_PRICING: Record<
	string,
	{ inputPer1M: number; outputPer1M: number }
> = {
	opus: { inputPer1M: 5, outputPer1M: 25 },
	sonnet: { inputPer1M: 3, outputPer1M: 15 },
	haiku: { inputPer1M: 1, outputPer1M: 5 },
};

/** @internal Exported for testing */
export function getModelPricing(model: string): {
	inputPer1M: number;
	outputPer1M: number;
} {
	for (const [family, pricing] of Object.entries(MODEL_PRICING)) {
		if (model.includes(family)) return pricing;
	}
	// Default to Sonnet pricing for unknown models
	return MODEL_PRICING.sonnet as { inputPer1M: number; outputPer1M: number };
}

/**
 * Compact conversation by summarizing ALL messages into a structured checkpoint,
 * then rebuilding context from scratch (like Claude Code's compaction model).
 *
 * After compaction, messages = [task context + fresh memory + checkpoint].
 * System prompt is re-sent every API call so it's always fresh.
 */
/** @internal Exported for testing */
export async function compressMessages(
	client: Anthropic,
	messages: MessageParam[],
	model: string,
	/** Original task context to re-inject after compression (task description, memory, etc.) */
	taskContext?: string,
	/** Working directory — used to re-read fresh memory from disk */
	cwd?: string,
): Promise<{
	compressed: MessageParam[];
	savedTokens: number;
	checkpoint: string;
}> {
	if (messages.length < 4) {
		return { compressed: messages, savedTokens: 0, checkpoint: "" };
	}

	// Serialize ALL messages into text for the checkpoint generator — no truncation
	const fullTranscript = messages
		.map((m, i) => {
			const content =
				typeof m.content === "string"
					? m.content
					: Array.isArray(m.content)
						? m.content
								.map((b) => {
									if (typeof b === "string") return b;
									if ("text" in b && typeof b.text === "string") return b.text;
									if ("type" in b && b.type === "tool_use") {
										const tu = b as ToolUseBlock;
										const inputStr = JSON.stringify(tu.input);
										return `[tool_use: ${tu.name}(${inputStr})]`;
									}
									if ("type" in b && b.type === "tool_result") {
										const tr = b as ToolResultBlockParam;
										let text: string;
										if (typeof tr.content === "string") {
											text = tr.content;
										} else if (Array.isArray(tr.content)) {
											text =
												tr.content
													.filter(
														(p): p is { type: "text"; text: string } =>
															typeof p === "object" &&
															p !== null &&
															"type" in p &&
															p.type === "text",
													)
													.map((p) => p.text)
													.join("\n") || "[result]";
										} else {
											text = "[result]";
										}
										return `[tool_result: ${text}]`;
									}
									return "[block]";
								})
								.join("\n")
						: String(m.content);
			return `[${i}] ${m.role}: ${content}`;
		})
		.join("\n---\n");

	// Context window is ~200k tokens. Reserve max_tokens for output, send the rest as input.
	// ~160k tokens input ≈ ~640k chars. Truncate from head (keep newest) if transcript exceeds this.
	const SUMMARY_MAX_TOKENS = 32768;
	const TRANSCRIPT_CHAR_LIMIT = 640_000;
	const transcriptForApi =
		fullTranscript.length > TRANSCRIPT_CHAR_LIMIT
			? `[Earlier conversation truncated]\n\n${fullTranscript.slice(-TRANSCRIPT_CHAR_LIMIT)}`
			: fullTranscript;

	// Use sonnet for high-quality checkpoint (haiku loses too much nuance)
	const summaryModel = model.includes("haiku")
		? model
		: model.includes("opus")
			? model.replace("opus", "sonnet")
			: model;

	// Use streaming to avoid 10-minute timeout for long summary generation
	const stream = client.messages.stream({
		model: summaryModel,
		max_tokens: SUMMARY_MAX_TOKENS,
		system: CHECKPOINT_SYSTEM_PROMPT,
		messages: [{ role: "user", content: transcriptForApi }],
	});
	const summaryResponse = await stream.finalMessage();

	const checkpoint =
		summaryResponse.content[0]?.type === "text"
			? summaryResponse.content[0].text
			: "Failed to generate checkpoint";

	// Include recent conversation as text dump (~80k chars) for detailed context
	const RECENT_CHARS = 80_000;
	const recentTranscript =
		fullTranscript.length > RECENT_CHARS
			? fullTranscript.slice(-RECENT_CHARS)
			: fullTranscript;

	// Re-read fresh memory from disk (agent may have updated it during session)
	let freshMemory = "";
	if (cwd) {
		try {
			const memPath = join(cwd, ".opengraft", "memory.md");
			freshMemory = await readFile(memPath, "utf-8");
		} catch {
			// No memory file — that's fine
		}
	}

	// Estimate saved tokens (~4 chars per token)
	const oldChars = fullTranscript.length;
	const newChars =
		checkpoint.length +
		recentTranscript.length +
		(taskContext?.length ?? 0) +
		freshMemory.length;
	const savedTokens = Math.max(0, Math.floor((oldChars - newChars) / 4));

	// Build single user message: task context + memory + checkpoint + recent transcript
	const parts: string[] = [];
	if (taskContext) {
		parts.push(`## Original Task\n${taskContext}`);
	}
	if (freshMemory) {
		parts.push(`## Project Memory (fresh)\n${freshMemory}`);
	}
	parts.push(`## Checkpoint Summary\n\n${checkpoint}`);
	parts.push(
		`## Recent Conversation (last ~${Math.round(recentTranscript.length / 1000)}k chars)\nThe following is a text transcript of the most recent conversation before compaction.\nThis gives you detailed context for what was happening right before the compaction.\n\n${recentTranscript}`,
	);
	parts.push(
		'Resume from this checkpoint. Your task is NOT done unless the checkpoint says "Current Phase: done". Continue working — check get_tree, follow the stimulus priority, and drive to completion.',
	);

	const compressed: MessageParam[] = [
		{ role: "user" as const, content: parts.join("\n\n---\n\n") },
	];

	return { compressed, savedTokens, checkpoint };
}

/** Structured checkpoint prompt for context compression. */
export const CHECKPOINT_SYSTEM_PROMPT = `You are generating a structured checkpoint for an autonomous coding agent.
The agent will resume from this checkpoint after context compression — it must be able to
continue working as if it never stopped.

CRITICAL: The agent resuming from this checkpoint cannot see any previous conversation.
Whatever you omit, the agent will not know. Whatever you write, the agent will remember.
Err on the side of more detail in Rejected Approaches — the cost of repeating failed work far
exceeds the cost of a slightly longer checkpoint.

Analyze the conversation and output a checkpoint in EXACTLY this format (all sections required):

## Current Phase
[What phase of the task the agent is in: design / implementation / testing / fixing / done]

## Completed Work
[What has been implemented, tested, and committed successfully — with specific file paths and line numbers]
[Key decisions made and WHY, not just what]

## Modified Files
- [path/to/file — what was changed and why]

## Current State
[What the agent was doing RIGHT NOW when compression happened]
[If debugging: the exact error message, what's been tried, what hasn't]
[If implementing: what's done, what remains in progress]

## Rejected Approaches
[THE MOST IMPORTANT SECTION — read every past message carefully for failures]
[For EVERY failed attempt, test failure, or dead end: describe it here]
[Format: "- Tried: <what was attempted> | Failed: <exact error/reason> | Do not retry: <why>"]
[Search for: test failures, compile errors, "doesn't work", "failed", wrong approaches]
[If truly nothing failed: "None so far" — but re-read carefully first]
[This section prevents the agent from wasting turns re-trying the same failed approaches]

## Open Questions
[Unresolved uncertainties that may affect next steps]
[Things the agent was unsure about that still need verification]
[If none, write "None"]
[Example: "Need to verify whether X API is available in this environment"]

## Remaining Work
[List ALL tasks/steps still needed to complete the goal — not just the next one]
[Be specific: "implement X in file Y", "add test for Z", "merge child branch A"]
[If orchestrator: list unmerged children and integration steps remaining]
[If task is nearly done: "Run final checks and call done('passed')"]

## Next Action
[Single, specific, concrete action to take IMMEDIATELY — start with a verb]
[e.g. "Run \`bun test src/foo.test.ts\` to verify the fix" not "continue testing"]
[e.g. "Edit src/bar.ts line 42 to change X to Y" not "fix the bug"]

## Agent Tree State
[Is this agent an orchestrator (has children) or a leaf worker?]
[List all child tasks with their IDs, titles, branches, and current statuses (pending/in_progress/passed/failed)]
[Which children have been merged? Which are still running? Which failed and need retry?]
[If orchestrator: what's the merge/integration plan?]
[If leaf worker: who is the parent, and what was the parent's instruction?]

## Communication State
[Any pending messages from parent that haven't been fully addressed?]
[Any pending clarifications awaiting user response?]
[Recent report_to_parent messages sent — what was communicated?]
[Recent send_message_to_child instructions — what was told to which child?]
[Has done() been called? If so, with what status and summary?]

Rules:
- Be precise: file paths, line numbers, function names, exact error messages
- Be forward-looking: the checkpoint exists to RESUME work, not to document history
- Do NOT repeat information from the system prompt (task description, methodology, instructions)
- Do NOT include file contents that can be re-read — only state/context hard to reconstruct
- Rejected Approaches is the highest-value section — fill it thoroughly even if it seems obvious
- Output ONLY the checkpoint, no preamble or commentary
- Length: aim for under 10,000 tokens. Use more if the conversation was complex and detail is critical — better to be thorough than to lose important context. Never truncate mid-sentence.`;

export const TOOLS: Tool[] = [
	{
		name: "bash",
		description:
			"Execute a bash command. Use for: running tests, git operations, build tools, package management, and system commands. Do NOT use bash for file operations — use the dedicated tools instead (read_file, write_file, edit_file, list_files, search). Working directory is automatically tracked across calls — if you `cd` in one command, subsequent commands run from the new directory. No need to prefix every command with `cd /path &&`. Exception: after a daemon restart, your workdir resets to the project root. If you navigate outside your worktree, you'll be warned — remember to cd back when done.\n\nforeground_timeout controls how long to wait in the foreground before backgrounding the command. Use 0 for immediate background (fire-and-forget). If the command finishes before the timeout, results are returned immediately. If not, the command moves to background and you get partial output + a background handle. Background completions are delivered as messages on your next yield() or tool call.",
		input_schema: {
			type: "object" as const,
			properties: {
				command: {
					type: "string",
					description: "The bash command to execute",
				},
				timeout: {
					type: "number",
					description:
						"Timeout in milliseconds (default: 120000, max: 600000). Hard kill timeout — command is killed after this.",
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
						"Enable multiline matching with RegExp 's' flag, allowing '.' to match newlines (default: false). NOTE: not yet implemented — reserved for future use.",
				},
			},
			required: ["pattern"],
		},
	},
];

/**
 * Truncate search output to a maximum number of entries.
 * For context mode (rg -C), entries are separated by "--" lines.
 * For other modes, each line is an entry.
 */
export function truncateSearchOutput(
	output: string,
	limit: number,
	hasContext: boolean,
): string {
	if (hasContext) {
		// Context mode: entries are blocks separated by "--" on its own line
		const blocks = output.split(/\n--\n/);
		if (blocks.length <= limit) return output;
		return `${blocks.slice(0, limit).join("\n--\n")}\n[... truncated at ${limit} entries]`;
	}
	// Line-based modes: each line is an entry
	const lines = output.split("\n");
	// Trailing newline produces an empty last element — don't count it
	const hasTrailingNewline = lines.length > 0 && lines[lines.length - 1] === "";
	const contentLines = hasTrailingNewline ? lines.slice(0, -1) : lines;
	if (contentLines.length <= limit) return output;
	const result = contentLines.slice(0, limit).join("\n");
	return `${result}\n[... truncated at ${limit} entries]`;
}

/**
 * Pure JS search implementation using Bun.Glob + RegExp.
 * Replaces external rg/grep dependency for cross-platform reliability.
 */
export async function jsSearch(opts: {
	pattern: string;
	searchPath: string;
	glob?: string;
	contextLines?: number;
	outputMode: string;
	headLimit: number;
	caseInsensitive: boolean;
	cwd: string;
}): Promise<string> {
	const {
		pattern,
		searchPath,
		glob,
		contextLines,
		outputMode,
		headLimit,
		caseInsensitive,
		cwd: baseCwd,
	} = opts;

	const regex = new RegExp(pattern, caseInsensitive ? "i" : "");
	let absSearchPath = isAbsolute(searchPath)
		? searchPath
		: join(baseCwd, searchPath);

	// Discover files — handle path pointing to a file vs directory
	let adjustedSearchPath = searchPath;
	const pathStat = statSync(absSearchPath, { throwIfNoEntry: false });
	let files: string[];
	if (pathStat?.isFile()) {
		// Single file mode — path points to a file, not a directory
		files = [basename(absSearchPath)];
		absSearchPath = dirname(absSearchPath);
		adjustedSearchPath = isAbsolute(searchPath)
			? dirname(searchPath)
			: dirname(searchPath) === "."
				? ""
				: dirname(searchPath);
	} else if (glob) {
		// Use Bun.Glob to match files within searchPath
		const g = new Bun.Glob(glob);
		files = Array.from(g.scanSync({ cwd: absSearchPath, onlyFiles: true }));
	} else {
		// No glob — scan all files recursively
		const g = new Bun.Glob("**/*");
		files = Array.from(g.scanSync({ cwd: absSearchPath, onlyFiles: true }));
	}

	// Sort for deterministic output
	files.sort();

	const ctxRange =
		contextLines && contextLines > 0 ? Math.min(contextLines, 10) : 0;
	const useContext = ctxRange > 0 && outputMode === "content";

	const outputLines: string[] = [];
	let entryCount = 0;

	for (const relFile of files) {
		if (entryCount >= headLimit) break;

		const filePath = join(absSearchPath, relFile);
		// Compute display path relative to baseCwd
		const displayPath =
			absSearchPath === baseCwd
				? relFile
				: adjustedSearchPath
					? join(adjustedSearchPath, relFile)
					: relFile;

		let content: string;
		try {
			content = await readFile(filePath, "utf-8");
		} catch {
			continue; // skip unreadable files (binary, permissions, etc.)
		}

		// Skip likely binary files (contains null bytes in first 8KB)
		if (content.slice(0, 8192).includes("\0")) continue;

		const lines = content.split("\n");

		if (outputMode === "files_with_matches") {
			for (const line of lines) {
				if (regex.test(line)) {
					outputLines.push(displayPath);
					entryCount++;
					break;
				}
			}
		} else if (outputMode === "count") {
			let count = 0;
			for (const line of lines) {
				if (regex.test(line)) count++;
			}
			if (count > 0) {
				outputLines.push(`${displayPath}:${count}`);
				entryCount++;
			}
		} else {
			// content mode — with optional context lines
			const matchIndices: number[] = [];
			for (let i = 0; i < lines.length; i++) {
				if (regex.test(lines[i] ?? "")) matchIndices.push(i);
			}
			if (matchIndices.length === 0) continue;

			if (useContext) {
				// Group matches into context blocks
				const blocks: string[] = [];
				// biome-ignore lint/style/noNonNullAssertion: length checked above
				let blockStart = Math.max(0, matchIndices[0]! - ctxRange);
				// biome-ignore lint/style/noNonNullAssertion: length checked above
				let blockEnd = Math.min(lines.length - 1, matchIndices[0]! + ctxRange);

				for (let m = 1; m < matchIndices.length; m++) {
					const mi = matchIndices[m] as number;
					const newStart = Math.max(0, mi - ctxRange);
					const newEnd = Math.min(lines.length - 1, mi + ctxRange);
					if (newStart <= blockEnd + 1) {
						// Merge with current block
						blockEnd = newEnd;
					} else {
						// Emit current block
						blocks.push(
							formatContextBlock(
								lines,
								blockStart,
								blockEnd,
								matchIndices,
								displayPath,
							),
						);
						blockStart = newStart;
						blockEnd = newEnd;
					}
				}
				blocks.push(
					formatContextBlock(
						lines,
						blockStart,
						blockEnd,
						matchIndices,
						displayPath,
					),
				);

				for (const block of blocks) {
					if (entryCount >= headLimit) break;
					if (outputLines.length > 0) outputLines.push("--");
					outputLines.push(block);
					entryCount++;
				}
			} else {
				// No context — just matching lines
				for (const idx of matchIndices) {
					if (entryCount >= headLimit) break;
					outputLines.push(`${displayPath}:${idx + 1}:${lines[idx]}`);
					entryCount++;
				}
			}
		}
	}

	let result = outputLines.join("\n");
	if (entryCount >= headLimit) {
		result += `\n[... truncated at ${headLimit} entries]`;
	}
	return result.slice(0, 20000);
}

function formatContextBlock(
	lines: string[],
	start: number,
	end: number,
	matchIndices: number[],
	filePath: string,
): string {
	const matchSet = new Set(matchIndices);
	const blockLines: string[] = [];
	for (let i = start; i <= end; i++) {
		const sep = matchSet.has(i) ? ":" : "-";
		blockLines.push(`${filePath}${sep}${i + 1}${sep}${lines[i]}`);
	}
	return blockLines.join("\n");
}

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
	queue: import("./message-queue.ts").MessageQueue | undefined,
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

	const cdWrapper = `cd() { local t="${"$"}{1:-${"$"}HOME}"; local r; r=${"$"}(builtin cd "${"$"}t" 2>/dev/null && pwd); if [ "${"$"}(pwd)" = "${"$"}r" ]; then echo "\u26a0 Already in ${"$"}(pwd) \u2014 no need to cd" >&2; fi; builtin cd "${"$"}t"; }; `;
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

/** @internal Exported for testing */
export function resolvePath(p: string, cwd: string): string {
	return isAbsolute(p) ? p : join(cwd, p);
}

/** @internal Exported for testing */
export async function executeTool(
	name: string,
	input: Record<string, unknown>,
	cwd: string,
	fallbackCwd?: string,
	sessionId?: string,
	queue?: MessageQueue,
): Promise<{
	content: string;
	isError: boolean;
	cwd?: string;
	isImage?: boolean;
	imageData?: string;
	mediaType?: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
}> {
	switch (name) {
		case "bash": {
			const command = input.command as string;
			const hardTimeout = Math.min(
				Math.max((input.timeout as number) ?? 120000, 1000),
				600000,
			);
			const foregroundTimeout = Math.min(
				Math.max((input.foreground_timeout as number) ?? hardTimeout, 0),
				hardTimeout,
			);

			// Warn about running background commands
			const bgWarning =
				sessionId && getRunningBackgroundCount(sessionId) > 0
					? `[Note: ${getRunningBackgroundCount(sessionId)} background command(s) still running]\n${getRunningBackgroundSummary(sessionId)}\n\n`
					: "";

			try {
				const result = await executeBashWithTimeout(
					command,
					cwd,
					fallbackCwd,
					foregroundTimeout,
					hardTimeout,
					sessionId,
					queue,
				);
				return {
					...result,
					content: bgWarning + result.content,
				};
			} catch (e) {
				return {
					content: `${bgWarning}Error: ${e instanceof Error ? e.message : String(e)}`,
					isError: true,
				};
			}
		}

		case "read_file": {
			const path = resolvePath(input.path as string, cwd);
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
						content: `[Image: ${basename(path)}]`,
						isError: false,
						isImage: true,
						imageData: base64,
						mediaType: imageMediaType,
					};
				} catch (e) {
					return {
						content: `Error reading file: ${e instanceof Error ? e.message : String(e)}`,
						isError: true,
					};
				}
			}

			const offset = Math.max(1, (input.offset as number) ?? 1);
			const limit = input.limit as number | undefined;
			try {
				const raw = readFileSync(path, "utf-8");
				if (offset === 1 && !limit) {
					return { content: raw, isError: false };
				}
				const lines = raw.split("\n");
				const start = offset - 1; // convert to 0-based
				const sliced =
					limit !== undefined
						? lines.slice(start, start + limit)
						: lines.slice(start);
				const remaining = lines.length - (start + sliced.length);
				let content = sliced.join("\n");
				if (remaining > 0) {
					content += `\n[... ${remaining} more lines, use offset=${offset + sliced.length} to continue]`;
				}
				return { content, isError: false };
			} catch (e) {
				return {
					content: `Error reading file: ${e instanceof Error ? e.message : String(e)}`,
					isError: true,
				};
			}
		}

		case "write_file": {
			const path = resolvePath(input.path as string, cwd);
			const content = input.content as string;
			try {
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, content, "utf-8");
				return { content: `File written: ${path}`, isError: false };
			} catch (e) {
				return {
					content: `Error writing file: ${e instanceof Error ? e.message : String(e)}`,
					isError: true,
				};
			}
		}

		case "edit_file": {
			const path = resolvePath(input.path as string, cwd);
			const oldStr = input.old_string as string;
			const newStr = input.new_string as string;
			const replaceAll = (input.replace_all as boolean) ?? false;
			try {
				if (!existsSync(path)) {
					return { content: `File not found: ${path}`, isError: true };
				}
				const content = readFileSync(path, "utf-8");
				const occurrences = content.split(oldStr).length - 1;
				if (occurrences === 0) {
					return { content: "old_string not found in file", isError: true };
				}
				if (!replaceAll && occurrences > 1) {
					return {
						content: `old_string found ${occurrences} times — must be unique. Use replace_all=true to replace all.`,
						isError: true,
					};
				}
				const updated = replaceAll
					? content.replaceAll(oldStr, newStr)
					: content.replace(oldStr, newStr);
				writeFileSync(path, updated, "utf-8");
				const msg =
					replaceAll && occurrences > 1
						? `File edited: ${path} (${occurrences} replacements)`
						: `File edited: ${path}`;
				return { content: msg, isError: false };
			} catch (e) {
				return {
					content: `Error editing file: ${e instanceof Error ? e.message : String(e)}`,
					isError: true,
				};
			}
		}

		case "list_files": {
			const pattern = (input.pattern as string) ?? "*";
			try {
				const glob = new Bun.Glob(pattern);
				const files: string[] = [];
				for await (const file of glob.scan({ cwd, dot: false })) {
					files.push(file);
					if (files.length >= 500) break;
				}
				return { content: files.join("\n") || "(no files)", isError: false };
			} catch (e) {
				return {
					content: `Error: ${e instanceof Error ? e.message : String(e)}`,
					isError: true,
				};
			}
		}

		case "search": {
			const pattern = input.pattern as string;
			const searchPath = (input.path as string) ?? ".";
			const glob = input.glob as string | undefined;
			const contextLines = input.context as number | undefined;
			const outputMode = (input.output_mode as string) ?? "content";
			const headLimit = Math.min((input.head_limit as number) ?? 50, 200);
			const caseInsensitive = (input.case_insensitive as boolean) ?? false;
			// TODO: implement multiline search — currently jsSearch uses line-by-line matching,
			// so the 'multiline' param (input.multiline) is accepted in the schema but ignored here.

			try {
				const result = await jsSearch({
					pattern,
					searchPath,
					glob,
					contextLines,
					outputMode,
					headLimit,
					caseInsensitive,
					cwd,
				});
				return { content: result || "(no matches)", isError: false };
			} catch (e) {
				return {
					content: `Error: ${e instanceof Error ? e.message : String(e)}`,
					isError: true,
				};
			}
		}

		default:
			return { content: `Unknown tool: ${name}`, isError: true };
	}
}

/**
 * Convert a Zod raw shape (from SdkMcpToolDefinition.inputSchema) to JSON Schema.
 * Handles the types used in our orchestrator tools: string, enum, optional.
 */
export function zodShapeToJsonSchema(
	shape: Record<string, unknown>,
): Record<string, unknown> {
	const properties: Record<string, unknown> = {};
	const required: string[] = [];

	for (const [key, zodType] of Object.entries(shape)) {
		const prop = zodTypeToJsonProp(zodType);
		properties[key] = prop.schema;
		if (!prop.optional) {
			required.push(key);
		}
	}

	return {
		type: "object",
		properties,
		...(required.length > 0 ? { required } : {}),
	};
}

function zodTypeToJsonProp(zodType: unknown): {
	schema: Record<string, unknown>;
	optional: boolean;
} {
	// Walk the Zod type to extract JSON Schema info
	// Uses internal Zod structures — works with both v3 and v4
	// biome-ignore lint/suspicious/noExplicitAny: introspecting Zod internals
	const t = zodType as any;

	// Zod v4: _zod.def.type, Zod v3: _def.typeName
	const def = t._zod?.def ?? t._def ?? {};
	const typeName: string = def.type ?? def.typeName ?? "";
	const description: string | undefined =
		t._zod?.bag?.description ?? def.description ?? t.description;

	if (typeName === "optional" || typeName === "ZodOptional") {
		const inner = zodTypeToJsonProp(def?.innerType);
		return {
			schema: { ...inner.schema, ...(description ? { description } : {}) },
			optional: true,
		};
	}

	if (typeName === "default" || typeName === "ZodDefault") {
		const inner = zodTypeToJsonProp(def?.innerType);
		return {
			schema: { ...inner.schema, ...(description ? { description } : {}) },
			optional: true,
		};
	}

	if (typeName === "enum" || typeName === "ZodEnum") {
		return {
			schema: {
				type: "string",
				enum: def?.values ?? (def?.entries ? Object.values(def.entries) : []),
				...(description ? { description } : {}),
			},
			optional: false,
		};
	}

	if (typeName === "number" || typeName === "ZodNumber") {
		return {
			schema: {
				type: "number",
				...(description ? { description } : {}),
			},
			optional: false,
		};
	}

	if (typeName === "boolean" || typeName === "ZodBoolean") {
		return {
			schema: {
				type: "boolean",
				...(description ? { description } : {}),
			},
			optional: false,
		};
	}

	if (typeName === "array" || typeName === "ZodArray") {
		// Zod v4: def.element, Zod v3: def.type (non-string) or def.innerType
		const elementType =
			def?.element ??
			(typeof def?.type !== "string" ? def?.type : undefined) ??
			def?.innerType;
		const inner = zodTypeToJsonProp(elementType);
		return {
			schema: {
				type: "array",
				items: inner.schema,
				...(description ? { description } : {}),
			},
			optional: false,
		};
	}

	if (typeName === "object" || typeName === "ZodObject") {
		const shape = typeof def?.shape === "function" ? def.shape() : def?.shape;
		if (shape) {
			return {
				schema: {
					...zodShapeToJsonSchema(shape),
					...(description ? { description } : {}),
				},
				optional: false,
			};
		}
	}

	// Default to string
	return {
		schema: {
			type: "string",
			...(description ? { description } : {}),
		},
		optional: false,
	};
}

/**
 * Add cache_control breakpoints to the messages array for prompt caching.
 *
 * Strategy: Mark the second-to-last user message with a cache breakpoint.
 * This caches all accumulated history up to the previous turn, which is the
 * stable portion of the conversation. The very last user message is the new
 * input and must not be cached (it changes every turn).
 *
 * Anthropic supports up to 4 cache breakpoints. We use 1 here to keep it
 * simple and predictable.
 *
 * Returns a new array — does NOT mutate the original messages.
 */
export function addMessagesCacheControl(
	messages: MessageParam[],
): MessageParam[] {
	if (messages.length < 3) {
		// Not enough history to be worth caching
		return messages;
	}

	// Find the index of the second-to-last user message (skip the last one which is the
	// current turn's input).
	let lastUserIdx = -1;
	let secondToLastUserIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "user") {
			if (lastUserIdx === -1) {
				lastUserIdx = i;
			} else {
				secondToLastUserIdx = i;
				break;
			}
		}
	}

	if (secondToLastUserIdx === -1) {
		// Fewer than 2 user messages — nothing to cache yet
		return messages;
	}

	// Clone messages and add cache_control to the second-to-last user message.
	// If its content is a string, convert to TextBlockParam array first.
	return messages.map((msg, i) => {
		if (i !== secondToLastUserIdx) return msg;

		const content = msg.content;
		if (typeof content === "string") {
			// Convert string content to array with cache_control
			return {
				...msg,
				content: [
					{
						type: "text" as const,
						text: content,
						cache_control: { type: "ephemeral" as const },
					},
				],
			};
		}

		// Array content: add cache_control to the last block
		if (Array.isArray(content) && content.length > 0) {
			const last = content[content.length - 1];
			// Only add cache_control to text or tool_result blocks (supported types)
			if (
				last &&
				(last.type === "text" || last.type === "tool_result") &&
				!("cache_control" in last && last.cache_control)
			) {
				const updatedContent = [
					...content.slice(0, -1),
					{ ...last, cache_control: { type: "ephemeral" as const } },
				];
				return { ...msg, content: updatedContent };
			}
		}

		return msg;
	});
}

/**
 * Direct Anthropic API provider.
 * Uses the Messages API with tool use for a lightweight, controllable agent loop.
 * No Claude Code subprocess — direct API calls with custom tool execution.
 */
export class AnthropicCompatibleProvider implements AgentProvider {
	readonly name = "anthropic";
	private client: Anthropic;
	private model: string;
	private useOAuth: boolean;
	/** Persisted conversation histories keyed by session ID. */
	private sessionHistory = new Map<string, MessageParam[]>();

	constructor(model?: string) {
		const apiKey = process.env.ANTHROPIC_API_KEY;
		const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
		this.useOAuth = Boolean(oauthToken && !apiKey);
		if (this.useOAuth) {
			this.client = new Anthropic({
				authToken: oauthToken,
				defaultHeaders: {
					"anthropic-beta": "oauth-2025-04-20",
				},
			});
		} else {
			this.client = new Anthropic();
		}
		this.model = model ?? DEFAULT_MODEL;
	}

	/** Create a message, using beta endpoint for OAuth auth. */
	private createMessage(
		params: Anthropic.Messages.MessageCreateParamsNonStreaming,
	): Promise<Anthropic.Messages.Message> {
		if (this.useOAuth) {
			// biome-ignore lint/suspicious/noExplicitAny: beta types are compatible but not identical
			return this.client.beta.messages.create(params as any) as any;
		}
		return this.client.messages.create(params);
	}

	async execute(request: AgentRequest): Promise<AgentResult> {
		const sessionId = request.resumeSessionId ?? randomUUID();
		const gen = this.runLoop(request, sessionId);
		let lastResult: AgentResult = { success: false, output: "", sessionId };
		let result = await gen.next();
		while (!result.done) {
			result = await gen.next();
		}
		lastResult = result.value;
		return lastResult;
	}

	async *stream(
		request: AgentRequest,
	): AsyncGenerator<AgentEvent, AgentResult> {
		const sessionId = request.resumeSessionId ?? randomUUID();
		const gen = this.runLoop(request, sessionId, request.queue);
		let result = await gen.next();
		while (!result.done) {
			yield result.value;
			result = await gen.next();
		}
		return result.value;
	}

	startSession(request: AgentRequest): AgentSession {
		const sessionId = request.resumeSessionId ?? randomUUID();
		const queue = request.queue ?? new MessageQueue();
		const abortController = new AbortController();

		const self = this;

		async function* eventStream(): AsyncGenerator<AgentEvent, AgentResult> {
			const gen = self.runLoop(
				{ ...request, signal: abortController.signal },
				sessionId,
				queue,
			);
			let result = await gen.next();
			while (!result.done) {
				yield result.value;
				result = await gen.next();
			}
			return result.value;
		}

		return {
			sessionId,
			events: eventStream(),
			queue,
			async sendMessage(text: string): Promise<void> {
				try {
					queue.enqueue({ source: "user", content: text });
				} catch {
					// Queue may be closed
				}
			},
			stop() {
				queue.close();
				abortController.abort();
				cleanupSessionBackgroundProcesses(sessionId);
			},
		};
	}

	private async *runLoop(
		request: AgentRequest,
		sessionId: string,
		queue?: MessageQueue,
	): AsyncGenerator<AgentEvent, AgentResult> {
		const model = request.model ?? this.model;
		const contextWindow = getContextWindow(model);
		const { compressThreshold, lazyCountThreshold } =
			getCompactionThresholds(contextWindow);

		let cwd = request.cwd;
		const sessionsDir = request.sessionsDir;

		// Load session history from disk if not already in memory (survives daemon restart)
		if (sessionId && sessionsDir && !this.sessionHistory.has(sessionId)) {
			try {
				const data = await readFile(
					join(sessionsDir, `${sessionId}.json`),
					"utf-8",
				);
				const history = JSON.parse(data) as MessageParam[];
				this.sessionHistory.set(sessionId, history);
			} catch {
				// File missing or corrupt — start fresh (expected for new sessions)
			}
		}

		// Restore conversation history if resuming, otherwise start fresh
		const existingHistory = this.sessionHistory.get(sessionId);
		const isResume = Boolean(existingHistory);
		// Prepend working directory to the first user message (not on resume turns) so that
		// the system prompt stays identical across agents in different worktrees, enabling
		// Anthropic prompt caching to cache the system prompt once and share it across agents.
		const firstUserContent =
			cwd && !isResume
				? `Working directory: ${cwd}\n\n${request.prompt}`
				: request.prompt;
		const messages: MessageParam[] = existingHistory
			? [...existingHistory, { role: "user" as const, content: request.prompt }]
			: [{ role: "user" as const, content: firstUserContent }];

		// For context compression: use the original task prompt, not the resume prompt.
		// On resume, the original prompt is the first user message in history.
		const taskContext =
			isResume && existingHistory
				? typeof existingHistory[0]?.content === "string"
					? existingHistory[0].content
					: request.prompt
				: request.prompt;

		// Add MCP tool definitions from mcpToolDefs
		const allTools: Tool[] = [...TOOLS];
		// biome-ignore lint/suspicious/noExplicitAny: SdkMcpToolDefinition generic varies
		const mcpHandlers = new Map<string, SdkMcpToolDefinition<any>>();

		if (request.mcpToolDefs) {
			for (const [serverName, defs] of Object.entries(request.mcpToolDefs)) {
				for (const def of defs) {
					const toolName = `mcp__${serverName}__${def.name}`;
					mcpHandlers.set(toolName, def);

					// Convert Zod schema to JSON Schema for the API
					const jsonSchema = zodShapeToJsonSchema(def.inputSchema);
					allTools.push({
						name: toolName,
						description: def.description,
						input_schema: jsonSchema as Tool["input_schema"],
					});
				}
			}
		}

		let turns = 0;
		let totalInputTokens = 0;
		let totalOutputTokens = 0;
		let totalCacheCreationTokens = 0;
		let totalCacheReadTokens = 0;
		let estimatedInputTokens = 0;
		let lastText = "";
		yield { type: "status", message: `Starting agent loop (model: ${model})` };

		while (true) {
			// Check abort signal
			if (request.signal?.aborted) {
				yield { type: "status", message: "Aborted" };
				break;
			}

			// ── Pre-call compression: count tokens, compress if over threshold ──
			if (messages.length > 4) {
				let tokenCount = estimatedInputTokens;
				let isEstimated = true;

				if (estimatedInputTokens >= lazyCountThreshold) {
					const result = await this.client.messages.countTokens({
						model,
						system: [{ type: "text", text: request.systemPrompt ?? "" }],
						messages,
						tools: allTools,
					});
					tokenCount = result.input_tokens;
					isEstimated = false;
				}

				if (!isEstimated && tokenCount > compressThreshold) {
					yield {
						type: "status",
						message: `Compressing conversation (${tokenCount} tokens, threshold: ${compressThreshold})`,
					};
					try {
						const { compressed, savedTokens, checkpoint } =
							await compressMessages(
								this.client,
								messages,
								model,
								taskContext,
								cwd,
							);
						messages.length = 0;
						messages.push(...compressed);
						const firstMsg = messages[0];
						if (cwd && firstMsg?.role === "user") {
							const content = firstMsg.content;
							if (
								typeof content === "string" &&
								!content.startsWith("Working directory:")
							) {
								messages[0] = {
									role: "user",
									content: `Working directory: ${cwd}\n\n${content}`,
								};
							}
						}
						// Emit usage update so UI badge refreshes after compaction
						const postCompactChars = compressed.reduce((sum, m) => {
							const c =
								typeof m.content === "string"
									? m.content
									: JSON.stringify(m.content);
							return sum + c.length;
						}, 0);
						const estimatedPostCompactTokens = Math.floor(postCompactChars / 4);
						estimatedInputTokens = estimatedPostCompactTokens;
						yield {
							type: "usage",
							inputTokens: estimatedPostCompactTokens,
							compressThreshold: compressThreshold,
							contextWindow: contextWindow,
							estimated: true,
						};
						yield { type: "compact", checkpoint, savedTokens };
					} catch (e) {
						yield {
							type: "error",
							message: `Compression failed: ${e instanceof Error ? e.message : String(e)}`,
						};
					}
				}
			}

			turns++;

			const systemParts = [request.systemPrompt].filter(Boolean);

			// Cache control: system prompt cached as array of TextBlockParam
			const systemWithCache: TextBlockParam[] = [
				{
					type: "text",
					text: systemParts.join("\n\n"),
					cache_control: { type: "ephemeral" },
				},
			];

			// Cache control: add cache breakpoint on the last tool definition so the
			// full tool list is cached across turns.
			const toolsWithCache: Tool[] =
				allTools.length > 0
					? allTools.map((tool, i) =>
							i === allTools.length - 1
								? { ...tool, cache_control: { type: "ephemeral" } }
								: tool,
						)
					: allTools;

			// Cache control: add a cache breakpoint at the second-to-last user message
			// (i.e. the last user turn before the current one), so that accumulated
			// conversation history is cached between turns.
			const messagesWithCache: MessageParam[] =
				addMessagesCacheControl(messages);

			const createParams = {
				model,
				max_tokens: DEFAULT_MAX_TOKENS,
				system: systemWithCache,
				messages: messagesWithCache,
				tools: toolsWithCache,
			};
			let response: Anthropic.Messages.Message | undefined;
			for (let attempt = 0; attempt < 5; attempt++) {
				try {
					response = await this.createMessage(createParams);
					break;
				} catch (e) {
					const isTransient =
						e instanceof Anthropic.RateLimitError ||
						e instanceof Anthropic.APIConnectionError ||
						e instanceof Anthropic.InternalServerError ||
						(e instanceof Anthropic.APIError && e.status === 529);
					if (!isTransient || attempt >= 4) throw e;
					const delay = Math.min(2000 * 2 ** attempt, 60000);
					yield {
						type: "error",
						message: `API error (retry ${attempt + 1}/4): ${e.message}`,
					};
					await new Promise((r) => setTimeout(r, delay));
				}
			}
			if (!response) throw new Error("Failed to get API response");

			totalInputTokens += response.usage.input_tokens;
			totalOutputTokens += response.usage.output_tokens;
			totalCacheCreationTokens +=
				response.usage.cache_creation_input_tokens ?? 0;
			totalCacheReadTokens += response.usage.cache_read_input_tokens ?? 0;

			// Update estimated token count for next turn's lazy threshold check.
			// input_tokens is ONLY non-cached tokens; must include cache_read and
			// cache_creation to get the true context size for threshold comparison.
			const totalTurnInput =
				response.usage.input_tokens +
				(response.usage.cache_creation_input_tokens ?? 0) +
				(response.usage.cache_read_input_tokens ?? 0);
			estimatedInputTokens = totalTurnInput + response.usage.output_tokens;

			// Report actual token usage from the API response
			yield {
				type: "usage",
				inputTokens: totalTurnInput,
				compressThreshold: compressThreshold,
				contextWindow: contextWindow,
			};

			// Process response content
			const toolUses: ToolUseBlock[] = [];
			for (const block of response.content) {
				if (block.type === "text") {
					lastText = block.text;
					yield { type: "text", content: block.text };
				} else if (block.type === "tool_use") {
					toolUses.push(block);
					yield {
						type: "tool_use",
						tool: block.name,
						input: block.input as Record<string, unknown>,
					};
				}
			}

			// Add assistant message to history
			messages.push({ role: "assistant", content: response.content });

			// If no tool use, handle end_turn
			if (response.stop_reason === "end_turn" || toolUses.length === 0) {
				// Check if done() was called in a previous tool batch
				if (request.doneRef?.done) {
					break;
				}

				// Implicit yield: if agent has running children, wait for messages
				if (request.hasRunningChildren?.() && queue) {
					yield {
						type: "status",
						message:
							"Agent ended turn with running children — implicit yield (waiting for messages)",
					};
					try {
						const first = await queue.wait();
						const rest = queue.drain();
						const all = [first, ...rest];
						const formatted = all.map(formatQueueMessage).join("\n");
						yield { type: "queue_message", messages: formatted };
						// Inject messages as a new user turn and continue the loop
						const imageBlocks = extractQueueImages(all);
						if (imageBlocks.length > 0) {
							messages.push({
								role: "user" as const,
								content: [
									{
										type: "text" as const,
										text: `[Messages received while you were idle:]\n${formatted}\n\nProcess these messages and continue working. Remember to call done() when finished.`,
									},
									...imageBlocks,
								],
							});
						} else {
							messages.push({
								role: "user" as const,
								content: `[Messages received while you were idle:]\n${formatted}\n\nProcess these messages and continue working. Remember to call done() when finished.`,
							});
						}
						continue;
					} catch {
						// Queue closed — fall through to normal exit
					}
				}

				// Default exit — agent stopped without calling done()
				yield {
					type: "status",
					message:
						"Warning: agent ended without calling done() — treating as success",
				};
				break;
			}

			// Execute tools concurrently
			const execResults = await Promise.all(
				toolUses.map(async (toolUse) => {
					const mcpHandler = mcpHandlers.get(toolUse.name);
					if (mcpHandler) {
						try {
							const mcpResult = await mcpHandler.handler(
								toolUse.input as Record<string, unknown>,
								{},
							);
							const parts = Array.isArray(mcpResult.content)
								? mcpResult.content
								: [];
							return {
								content: parts
									.map((c: { type: string; text?: string }) =>
										c.type === "text" ? (c.text ?? "") : JSON.stringify(c),
									)
									.join("\n"),
								isError: mcpResult.isError ?? false,
							};
						} catch (e) {
							return {
								content: `MCP tool error: ${e instanceof Error ? e.message : String(e)}`,
								isError: true,
							};
						}
					}
					return executeTool(
						toolUse.name,
						toolUse.input as Record<string, unknown>,
						cwd,
						request.cwd,
						sessionId,
						queue,
					);
				}),
			);

			// Emit tool_result events and build API result array
			const toolResults: ToolResultBlockParam[] = [];
			for (let i = 0; i < toolUses.length; i++) {
				const toolUse = toolUses[i] as ToolUseBlock;
				const exec = execResults[i] as {
					content: string;
					isError: boolean;
					cwd?: string;
					isImage?: boolean;
					imageData?: string;
					mediaType?: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
				};

				// Update cwd if bash tool changed it
				if (exec.cwd) {
					cwd = exec.cwd;
				}

				const text = exec.content;
				const isError = exec.isError;

				yield {
					type: "tool_result",
					tool: toolUse.name,
					content: text.slice(0, 500),
					isError,
				};

				if (exec.isImage && exec.imageData && exec.mediaType) {
					// Image: use array content with image block + text description
					toolResults.push({
						type: "tool_result",
						tool_use_id: toolUse.id,
						content: [
							{
								type: "image",
								source: {
									type: "base64",
									media_type: exec.mediaType,
									data: exec.imageData,
								},
							},
							{ type: "text", text },
						],
					});
				} else {
					toolResults.push({
						type: "tool_result",
						tool_use_id: toolUse.id,
						content: text,
						is_error: isError,
					});
				}
			}

			// Cancellation point: drain queue and append messages to tool results
			let cancellationImages: ReturnType<typeof extractQueueImages> = [];
			if (queue && queue.pending > 0) {
				const queueMsgs = queue.drain();
				const formatted = queueMsgs.map(formatQueueMessage).join("\n");
				const lastResult = toolResults[toolResults.length - 1];
				if (lastResult && typeof lastResult.content === "string") {
					lastResult.content += `\n\n---\n[Messages received while you were working:]\n${formatted}`;
				}
				cancellationImages = extractQueueImages(queueMsgs);
				yield { type: "queue_message", messages: formatted };
			}

			// Add tool results to history (with any queued images appended)
			if (cancellationImages.length > 0) {
				messages.push({
					role: "user",
					content: [
						...toolResults,
						...cancellationImages,
						{
							type: "text" as const,
							text: `[${cancellationImages.length} image(s) attached by user]`,
						},
					],
				});
			} else {
				messages.push({ role: "user", content: toolResults });
			}

			// Persist after tool results too (captures full turn)
			this.sessionHistory.set(sessionId, [...messages]);
			if (sessionsDir) {
				writeFile(
					join(sessionsDir, `${sessionId}.json`),
					JSON.stringify(messages),
					"utf-8",
				).catch(() => {});
			}

			// Budget check: compute running cost and warn the agent if approaching limit
			if (request.budgetUsd && request.budgetUsd > 0) {
				const { inputPer1M, outputPer1M } = getModelPricing(model);
				const runningCost =
					(totalInputTokens * inputPer1M) / 1_000_000 +
					(totalCacheCreationTokens * inputPer1M * 1.25) / 1_000_000 +
					(totalCacheReadTokens * inputPer1M * 0.1) / 1_000_000 +
					(totalOutputTokens * outputPer1M) / 1_000_000;
				const ratio = runningCost / request.budgetUsd;

				if (ratio >= 1.0) {
					const warning = `⚠️ Budget exceeded (${runningCost.toFixed(4)} / ${request.budgetUsd.toFixed(2)} budget). Call done() now.`;
					messages.push({
						role: "user" as const,
						content: warning,
					});
					yield { type: "status", message: warning };
				} else if (ratio >= 0.8) {
					const warning = `⚠️ Warning: task has used ${Math.round(ratio * 100)}% of its ${request.budgetUsd.toFixed(2)} budget (${runningCost.toFixed(4)} spent). Wrap up soon.`;
					messages.push({
						role: "user" as const,
						content: warning,
					});
					yield { type: "status", message: warning };
				}
			}

			// Check if done() was called by a tool in this batch — exit immediately
			if (request.doneRef?.done) {
				break;
			}
		}

		// Persist conversation history for future resume (in memory + on disk)
		const finalMessages = [...messages];
		this.sessionHistory.set(sessionId, finalMessages);
		// Also write to disk so the history survives daemon restarts
		if (sessionsDir) {
			try {
				await mkdir(sessionsDir, { recursive: true });
				await writeFile(
					join(sessionsDir, `${sessionId}.json`),
					JSON.stringify(finalMessages),
					"utf-8",
				);
			} catch {
				// Non-fatal: if we can't persist to disk, in-memory history still works
			}
		}

		const { inputPer1M, outputPer1M } = getModelPricing(model);
		// Anthropic API: input_tokens = non-cached tokens only (excludes cache_creation
		// and cache_read tokens — those are reported separately). Do NOT subtract them.
		const costUsd =
			(totalInputTokens * inputPer1M) / 1_000_000 +
			(totalCacheCreationTokens * inputPer1M * 1.25) / 1_000_000 +
			(totalCacheReadTokens * inputPer1M * 0.1) / 1_000_000 +
			(totalOutputTokens * outputPer1M) / 1_000_000;

		// Use doneRef result if the done() tool was called
		const doneResult = request.doneRef?.done;
		return {
			success: doneResult ? doneResult.status === "passed" : true,
			output: doneResult ? doneResult.summary : lastText,
			costUsd,
			turns,
			sessionId,
			inputTokens: totalInputTokens,
			cacheCreationTokens: totalCacheCreationTokens,
			cacheReadTokens: totalCacheReadTokens,
			outputTokens: totalOutputTokens,
		};
	}
}
