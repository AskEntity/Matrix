import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
		description: "Search for a pattern in files using ripgrep (rg).",
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
			},
			required: ["pattern"],
		},
	},
];

async function executeTool(
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
			const path = input.path as string;
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
			const path = input.path as string;
			const content = input.content as string;
			try {
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
			const path = input.path as string;
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
			const path = (input.path as string) ?? ".";
			const glob = input.glob as string | undefined;
			const args = ["rg", "--no-heading", "-n", pattern, path];
			if (glob) args.push("--glob", glob);
			args.push("--max-count", "50");
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
function zodShapeToJsonSchema(
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
				enum: def?.values ?? [],
				...(description ? { description } : {}),
			},
			optional: false,
		};
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

	constructor(model?: string) {
		this.client = new Anthropic();
		this.model = model ?? DEFAULT_MODEL;
	}

	async execute(request: AgentRequest): Promise<AgentResult> {
		const gen = this.runLoop(request);
		let lastResult: AgentResult = { success: false, output: "" };
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
		const gen = this.runLoop(request);
		let result = await gen.next();
		while (!result.done) {
			yield result.value;
			result = await gen.next();
		}
		return result.value;
	}

	startSession(request: AgentRequest): AgentSession {
		const sessionId = randomUUID();
		const injectedMessages: string[] = [];
		let closed = false;

		const self = this;

		async function* eventStream(): AsyncGenerator<AgentEvent, AgentResult> {
			const gen = self.runLoop(request, () => {
				if (injectedMessages.length > 0) {
					return injectedMessages.shift() as string;
				}
				return undefined;
			});
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
			},
		};
	}

	private async *runLoop(
		request: AgentRequest,
		checkInjectedMessage?: () => string | undefined,
	): AsyncGenerator<AgentEvent, AgentResult> {
		const model = request.model ?? this.model;
		const maxTurns = request.maxTurns ?? 30;
		const cwd = request.cwd;

		const messages: MessageParam[] = [
			{ role: "user", content: request.prompt },
		];

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

		while (turns < maxTurns) {
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

			const response = await this.client.messages.create({
				model,
				max_tokens: DEFAULT_MAX_TOKENS,
				system: request.systemPrompt ?? undefined,
				messages,
				tools: allTools,
			});

			totalInputTokens += response.usage.input_tokens;
			totalOutputTokens += response.usage.output_tokens;

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

			// Execute tools and collect results
			const toolResults: ToolResultBlockParam[] = [];
			for (const toolUse of toolUses) {
				const mcpHandler = mcpHandlers.get(toolUse.name);
				if (mcpHandler) {
					// Route to MCP tool handler
					const mcpResult = await mcpHandler.handler(
						toolUse.input as Record<string, unknown>,
						{},
					);
					const text = mcpResult.content
						.map((c: { type: string; text?: string }) =>
							c.type === "text" ? (c.text ?? "") : JSON.stringify(c),
						)
						.join("\n");
					toolResults.push({
						type: "tool_result",
						tool_use_id: toolUse.id,
						content: text,
						is_error: mcpResult.isError ?? false,
					});
				} else {
					const result = await executeTool(
						toolUse.name,
						toolUse.input as Record<string, unknown>,
						cwd,
					);
					toolResults.push({
						type: "tool_result",
						tool_use_id: toolUse.id,
						content: result.content,
						is_error: result.isError,
					});
				}
			}

			// Add tool results to history
			messages.push({ role: "user", content: toolResults });
		}

		// Estimate cost (Claude Sonnet 4 pricing: $3/MTok input, $15/MTok output)
		const costUsd =
			(totalInputTokens * 3) / 1_000_000 + (totalOutputTokens * 15) / 1_000_000;

		return {
			success: true,
			output: lastText,
			costUsd,
			turns,
		};
	}
}
