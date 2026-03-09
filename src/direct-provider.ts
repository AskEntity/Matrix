import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import Anthropic from "@anthropic-ai/sdk";
import type {
	MessageParam,
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
import type { AgentResult } from "./types.ts";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 16384;
/** Trigger compression at 80% of 200k context window */
const COMPRESS_THRESHOLD = 160_000;

/** Per-million-token pricing by model family. */
const MODEL_PRICING: Record<
	string,
	{ inputPer1M: number; outputPer1M: number }
> = {
	opus: { inputPer1M: 15, outputPer1M: 75 },
	sonnet: { inputPer1M: 3, outputPer1M: 15 },
	haiku: { inputPer1M: 0.8, outputPer1M: 4 },
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
 * After compaction, messages = [task context + fresh memory + checkpoint, assistant ack].
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

	// Serialize ALL messages into text for the checkpoint generator
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
										const inputStr = JSON.stringify(tu.input).slice(0, 500);
										return `[tool_use: ${tu.name}(${inputStr})]`;
									}
									if ("type" in b && b.type === "tool_result") {
										const tr = b as ToolResultBlockParam;
										const text =
											typeof tr.content === "string"
												? tr.content.slice(0, 500)
												: "[result]";
										return `[tool_result: ${text}]`;
									}
									return "[block]";
								})
								.join("\n")
						: String(m.content);
			return `[${i}] ${m.role}: ${content.slice(0, 2000)}`;
		})
		.join("\n---\n");

	// Use sonnet for high-quality checkpoint (haiku loses too much nuance)
	const summaryModel = model.includes("haiku")
		? model
		: model.includes("opus")
			? model.replace("opus", "sonnet")
			: model;

	const summaryResponse = await client.messages.create({
		model: summaryModel,
		max_tokens: 8192,
		system: CHECKPOINT_SYSTEM_PROMPT,
		messages: [{ role: "user", content: fullTranscript.slice(0, 100000) }],
	});

	const checkpoint =
		summaryResponse.content[0]?.type === "text"
			? summaryResponse.content[0].text
			: "Failed to generate checkpoint";

	// Estimate saved tokens (~4 chars per token)
	const oldChars = fullTranscript.length;
	const newChars = checkpoint.length;
	const savedTokens = Math.max(0, Math.floor((oldChars - newChars) / 4));

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

	// Rebuild from scratch: task context + fresh memory + checkpoint
	const parts: string[] = [];
	if (taskContext) {
		parts.push(`## Original Task\n${taskContext}`);
	}
	if (freshMemory) {
		parts.push(`## Project Memory (fresh)\n${freshMemory}`);
	}
	parts.push(
		`## Checkpoint (conversation compacted)\n\n${checkpoint}\n\nResume from this checkpoint. Continue working — do not repeat completed steps.`,
	);

	const compressed: MessageParam[] = [
		{ role: "user" as const, content: parts.join("\n\n---\n\n") },
		{
			role: "assistant" as const,
			content:
				"I have the full checkpoint context and fresh memory. Continuing where I left off.",
		},
	];

	return { compressed, savedTokens, checkpoint };
}

/** Structured checkpoint prompt for context compression. */
const CHECKPOINT_SYSTEM_PROMPT = `You are generating a structured checkpoint for an autonomous coding agent.
The agent will resume from this checkpoint after context compression — it must be able to
continue working as if it never stopped.

Analyze the conversation and output a checkpoint in EXACTLY this format:

## Task
[What the agent is working on — the original goal]

## Current Phase
[Where in the workflow: exploring / implementing / testing / debugging / done]

## Completed
- [What's been done, with specific file paths and line numbers]
- [Key decisions made and WHY (not just what)]

## Files Modified
- [path/to/file — what was changed and why]

## Current State
[What the agent was doing RIGHT NOW when compression happened]
[If debugging: the exact error, what's been tried, what hasn't]
[If implementing: what's done, what remains]

## Next Action
[The specific next thing the agent should do — not vague, but actionable]
[e.g. "Run bun test to verify the fix in src/foo.ts:42" not "continue testing"]

## Key Context
[Any critical details that would be lost: env vars, API quirks, gotchas discovered]
[Errors that were encountered and their root causes]
[Approaches that were tried and REJECTED (so the agent doesn't retry them)]

Rules:
- Be precise: file paths, line numbers, function names, error messages
- Be forward-looking: the checkpoint exists to RESUME work, not to document history
- Omit anything that's in the system prompt (no need to repeat task descriptions)
- Include rejected approaches — preventing re-exploration is the highest-value information
- Output ONLY the checkpoint, no preamble or commentary`;

const TOOLS: Tool[] = [
	{
		name: "bash",
		description:
			"Execute a bash command. Returns stdout and stderr. Use this for running tests, git operations, installing packages, etc.",
		input_schema: {
			type: "object" as const,
			properties: {
				command: {
					type: "string",
					description: "The bash command to execute",
				},
				timeout: {
					type: "number",
					description: "Timeout in milliseconds (default: 120000)",
				},
			},
			required: ["command"],
		},
	},
	{
		name: "read_file",
		description:
			"Read the contents of a file. Returns the file content as text.",
		input_schema: {
			type: "object" as const,
			properties: {
				path: {
					type: "string",
					description: "Absolute or relative path to the file",
				},
			},
			required: ["path"],
		},
	},
	{
		name: "write_file",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does.",
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
			"Replace a specific string in a file. The old_string must be unique in the file.",
		input_schema: {
			type: "object" as const,
			properties: {
				path: {
					type: "string",
					description: "Path to the file",
				},
				old_string: {
					type: "string",
					description: "The exact string to find and replace",
				},
				new_string: {
					type: "string",
					description: "The replacement string",
				},
			},
			required: ["path", "old_string", "new_string"],
		},
	},
	{
		name: "list_files",
		description: "List files matching a glob pattern in the working directory.",
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
			"Search for a pattern in files using ripgrep (rg). Returns matching lines with file paths and line numbers.",
		input_schema: {
			type: "object" as const,
			properties: {
				pattern: {
					type: "string",
					description: "Regex pattern to search for",
				},
				path: {
					type: "string",
					description: "Directory or file to search in (default: .)",
				},
				glob: {
					type: "string",
					description: 'File glob filter (e.g. "*.ts")',
				},
				context: {
					type: "number",
					description:
						"Number of context lines before and after each match (default: 0)",
				},
			},
			required: ["pattern"],
		},
	},
];

/** Check if a command is available in PATH. Caches results. */
const commandCache = new Map<string, boolean>();
async function isCommandAvailable(cmd: string): Promise<boolean> {
	if (commandCache.has(cmd)) return commandCache.get(cmd) as boolean;
	try {
		const proc = Bun.spawn(["which", cmd], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const available = (await proc.exited) === 0;
		commandCache.set(cmd, available);
		return available;
	} catch {
		commandCache.set(cmd, false);
		return false;
	}
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
): Promise<{ content: string; isError: boolean }> {
	switch (name) {
		case "bash": {
			const command = input.command as string;
			const timeout = (input.timeout as number) ?? 120000;
			try {
				const proc = Bun.spawn(["bash", "-c", command], {
					cwd,
					stdout: "pipe",
					stderr: "pipe",
					env: process.env,
				});

				const timer = setTimeout(() => proc.kill(), timeout);
				const exitCode = await proc.exited;
				clearTimeout(timer);

				const stdout = await new Response(proc.stdout).text();
				const stderr = await new Response(proc.stderr).text();

				const result = [
					stdout ? `stdout:\n${stdout.slice(0, 10000)}` : "",
					stderr ? `stderr:\n${stderr.slice(0, 5000)}` : "",
					`exit code: ${exitCode}`,
				]
					.filter(Boolean)
					.join("\n");

				return { content: result, isError: exitCode !== 0 };
			} catch (e) {
				return {
					content: `Error: ${e instanceof Error ? e.message : String(e)}`,
					isError: true,
				};
			}
		}

		case "read_file": {
			const path = resolvePath(input.path as string, cwd);
			try {
				const content = readFileSync(path, "utf-8");
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
			try {
				if (!existsSync(path)) {
					return { content: `File not found: ${path}`, isError: true };
				}
				const content = readFileSync(path, "utf-8");
				const occurrences = content.split(oldStr).length - 1;
				if (occurrences === 0) {
					return {
						content: "old_string not found in file",
						isError: true,
					};
				}
				if (occurrences > 1) {
					return {
						content: `old_string found ${occurrences} times — must be unique`,
						isError: true,
					};
				}
				writeFileSync(path, content.replace(oldStr, newStr), "utf-8");
				return { content: `File edited: ${path}`, isError: false };
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

			// Try rg first, fall back to grep if rg is not available
			const useRg = await isCommandAvailable("rg");
			const args: string[] = useRg
				? ["rg", "--no-heading", "-n", pattern, searchPath]
				: ["grep", "-rn", pattern, searchPath];

			if (useRg) {
				if (glob) args.push("--glob", glob);
				if (contextLines && contextLines > 0) {
					args.push("-C", String(Math.min(contextLines, 10)));
				}
				args.push("--max-count", "50");
			} else {
				if (glob) args.push("--include", glob);
				if (contextLines && contextLines > 0) {
					args.push(`-C${Math.min(contextLines, 10)}`);
				}
			}

			try {
				const proc = Bun.spawn(args, {
					cwd,
					stdout: "pipe",
					stderr: "pipe",
				});
				await proc.exited;
				const stdout = await new Response(proc.stdout).text();
				return {
					content: stdout.slice(0, 10000) || "(no matches)",
					isError: false,
				};
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
 * Direct Anthropic API provider.
 * Uses the Messages API with tool use for a lightweight, controllable agent loop.
 * No Claude Code subprocess — direct API calls with custom tool execution.
 */
export class DirectProvider implements AgentProvider {
	readonly name = "direct-api";
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
		const gen = this.runLoop(request, sessionId);
		let result = await gen.next();
		while (!result.done) {
			yield result.value;
			result = await gen.next();
		}
		return result.value;
	}

	startSession(request: AgentRequest): AgentSession {
		const sessionId = request.resumeSessionId ?? randomUUID();
		const injectedMessages: string[] = [];
		let closed = false;
		const abortController = new AbortController();

		const self = this;

		async function* eventStream(): AsyncGenerator<AgentEvent, AgentResult> {
			const gen = self.runLoop(
				{ ...request, signal: abortController.signal },
				sessionId,
				() => {
					if (injectedMessages.length > 0) {
						return injectedMessages.shift() as string;
					}
					return undefined;
				},
			);
			let result = await gen.next();
			while (!result.done) {
				yield result.value;
				result = await gen.next();
			}
			closed = true;
			return result.value;
		}

		return {
			sessionId,
			events: eventStream(),
			async sendMessage(text: string): Promise<void> {
				if (!closed) {
					injectedMessages.push(text);
				}
			},
			stop() {
				closed = true;
				abortController.abort();
			},
		};
	}

	private async *runLoop(
		request: AgentRequest,
		sessionId: string,
		checkInjectedMessage?: () => string | undefined,
	): AsyncGenerator<AgentEvent, AgentResult> {
		const model = request.model ?? this.model;
		const cwd = request.cwd;

		// Restore conversation history if resuming, otherwise start fresh
		const existingHistory = this.sessionHistory.get(sessionId);
		const messages: MessageParam[] = existingHistory
			? [...existingHistory, { role: "user" as const, content: request.prompt }]
			: [{ role: "user" as const, content: request.prompt }];

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
		let lastText = "";

		yield { type: "status", message: `Starting agent loop (model: ${model})` };

		while (true) {
			// Check abort signal
			if (request.signal?.aborted) {
				yield { type: "status", message: "Aborted" };
				break;
			}

			turns++;

			// Check for injected messages between turns
			if (checkInjectedMessage) {
				const injected = checkInjectedMessage();
				if (injected) {
					messages.push({ role: "user", content: injected });
					yield {
						type: "text",
						content: `[Injected message: ${injected}]`,
					};
				}
			}

			const systemParts = [
				request.systemPrompt,
				`Working directory: ${cwd}`,
			].filter(Boolean);

			const createParams = {
				model,
				max_tokens: DEFAULT_MAX_TOKENS,
				system: systemParts.join("\n\n"),
				messages,
				tools: allTools,
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

			// Compress messages if approaching context window limit
			if (response.usage.input_tokens > COMPRESS_THRESHOLD) {
				yield {
					type: "status",
					message: `Compressing conversation (${response.usage.input_tokens} input tokens, threshold: ${COMPRESS_THRESHOLD})`,
				};
				try {
					const { compressed, savedTokens, checkpoint } =
						await compressMessages(
							this.client,
							messages,
							model,
							request.prompt,
							cwd,
						);
					messages.length = 0;
					messages.push(...compressed);
					yield {
						type: "compact",
						checkpoint,
						savedTokens,
					};
				} catch (e) {
					yield {
						type: "error",
						message: `Compression failed: ${e instanceof Error ? e.message : String(e)}`,
					};
				}
			}

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

			// If no tool use, we're done
			if (response.stop_reason === "end_turn" || toolUses.length === 0) {
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
				};
				const text = exec.content;
				const isError = exec.isError;

				yield {
					type: "tool_result",
					tool: toolUse.name,
					content: text.slice(0, 500),
					isError,
				};
				toolResults.push({
					type: "tool_result",
					tool_use_id: toolUse.id,
					content: text,
					is_error: isError,
				});
			}

			// Add tool results to history
			messages.push({ role: "user", content: toolResults });
		}

		// Persist conversation history for future resume
		this.sessionHistory.set(sessionId, [...messages]);

		const { inputPer1M, outputPer1M } = getModelPricing(model);
		const costUsd =
			(totalInputTokens * inputPer1M) / 1_000_000 +
			(totalOutputTokens * outputPer1M) / 1_000_000;

		return {
			success: true,
			output: lastText,
			costUsd,
			turns,
			sessionId,
		};
	}
}
