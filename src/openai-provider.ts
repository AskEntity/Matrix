import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import type {
	AgentEvent,
	AgentProvider,
	AgentRequest,
	AgentSession,
} from "./agent-provider.ts";
import { formatQueueMessage } from "./agent-tools.ts";
import {
	CHECKPOINT_SYSTEM_PROMPT,
	executeTool,
	TOOLS,
	zodShapeToJsonSchema,
} from "./direct-provider.ts";
import { MessageQueue } from "./message-queue.ts";
import type { AgentResult } from "./types.ts";

// ── Types ──

export interface OpenAIMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | null;
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
	name?: string;
}

interface OpenAIToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

interface OpenAITool {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

interface OpenAIUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
}

interface OpenAIChoice {
	index: number;
	message: {
		role: "assistant";
		content: string | null;
		tool_calls?: OpenAIToolCall[];
	};
	finish_reason: string | null;
}

interface OpenAIChatResponse {
	id: string;
	object: "chat.completion";
	choices: OpenAIChoice[];
	usage: OpenAIUsage;
}

// ── Pricing & context windows ──

const OPENAI_PRICING: Record<
	string,
	{ inputPer1M: number; outputPer1M: number }
> = {
	"gpt-4o": { inputPer1M: 2.5, outputPer1M: 10 },
	"gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
	o3: { inputPer1M: 10, outputPer1M: 40 },
	"o3-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },
	"deepseek-chat": { inputPer1M: 0.14, outputPer1M: 0.28 },
	"deepseek-reasoner": { inputPer1M: 0.55, outputPer1M: 2.19 },
};

const CONTEXT_WINDOWS: Record<string, number> = {
	"gpt-4o": 128_000,
	"gpt-4o-mini": 128_000,
	o3: 200_000,
	"o3-mini": 200_000,
	"deepseek-chat": 64_000,
	"deepseek-reasoner": 64_000,
};

const DEFAULT_CONTEXT_WINDOW = 128_000;
const COMPACT_BUFFER_RATIO = 0.17;
const DEFAULT_MAX_TOKENS = 16384;

// ── Dynamic context window cache ──

const contextWindowCache = new Map<string, number>();

/** @internal Exported for testing */
export function clearContextWindowCache(): void {
	contextWindowCache.clear();
}

/**
 * Fetch context window from the API's /v1/models endpoint.
 * Returns null if the model isn't found or the request fails.
 * Results are cached per model name.
 */
export async function fetchContextWindowFromAPI(
	baseUrl: string,
	apiKey: string,
	model: string,
): Promise<number | null> {
	const cached = contextWindowCache.get(model);
	if (cached !== undefined) {
		return cached;
	}

	try {
		const response = await fetch(`${baseUrl}/models`, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
		});

		if (!response.ok) {
			return null;
		}

		const data = (await response.json()) as {
			data?: Array<{ id: string; context_length?: number }>;
		};

		if (!Array.isArray(data.data)) {
			return null;
		}

		// Exact match first, then prefix match
		let contextLength: number | undefined;
		for (const m of data.data) {
			if (m.id === model) {
				contextLength = m.context_length;
				break;
			}
		}
		if (contextLength === undefined) {
			for (const m of data.data) {
				if (m.id.startsWith(model) || model.startsWith(m.id)) {
					contextLength = m.context_length;
					break;
				}
			}
		}

		if (typeof contextLength === "number" && contextLength > 0) {
			contextWindowCache.set(model, contextLength);
			return contextLength;
		}
	} catch {
		// Network or parse error — fall through to null
	}

	return null;
}

/** @internal Exported for testing */
export function getModelPricing(model: string): {
	inputPer1M: number;
	outputPer1M: number;
} {
	// Exact match first
	if (OPENAI_PRICING[model]) return OPENAI_PRICING[model];
	// Prefix match (e.g. "gpt-4o-2024-08-06" → "gpt-4o")
	for (const [key, pricing] of Object.entries(OPENAI_PRICING)) {
		if (model.startsWith(key)) return pricing;
	}
	// Default to gpt-4o pricing
	return OPENAI_PRICING["gpt-4o"] as {
		inputPer1M: number;
		outputPer1M: number;
	};
}

/** @internal Exported for testing */
export function getContextWindow(model: string): number {
	if (CONTEXT_WINDOWS[model]) return CONTEXT_WINDOWS[model];
	for (const [key, window] of Object.entries(CONTEXT_WINDOWS)) {
		if (model.startsWith(key)) return window;
	}
	return DEFAULT_CONTEXT_WINDOW;
}

// ── Tool format conversion ──

/** Convert Anthropic-format tools to OpenAI function calling format. */
export function convertToolsToOpenAI(tools: typeof TOOLS): OpenAITool[] {
	return tools.map((tool) => ({
		type: "function" as const,
		function: {
			name: tool.name,
			description: tool.description ?? "",
			parameters: tool.input_schema as Record<string, unknown>,
		},
	}));
}

// ── Compaction ──

/** @internal Exported for testing */
export async function compressMessages(
	messages: OpenAIMessage[],
	model: string,
	baseUrl: string,
	apiKey: string,
	taskContext?: string,
	cwd?: string,
): Promise<{
	compressed: OpenAIMessage[];
	savedTokens: number;
	checkpoint: string;
}> {
	if (messages.length < 4) {
		return { compressed: messages, savedTokens: 0, checkpoint: "" };
	}

	// Serialize all messages into text for the checkpoint generator
	const fullTranscript = messages
		.map((m, i) => {
			let content = m.content ?? "";
			if (m.tool_calls) {
				const calls = m.tool_calls
					.map(
						(tc) =>
							`[tool_call: ${tc.function.name}(${tc.function.arguments})]`,
					)
					.join("\n");
				content = content ? `${content}\n${calls}` : calls;
			}
			if (m.role === "tool") {
				content = `[tool_result for ${m.name ?? m.tool_call_id ?? "unknown"}]: ${m.content ?? ""}`;
			}
			return `[${i}] ${m.role}: ${content}`;
		})
		.join("\n---\n");

	const SUMMARY_MAX_TOKENS = 32768;
	const TRANSCRIPT_CHAR_LIMIT = 640_000;
	const transcriptForApi =
		fullTranscript.length > TRANSCRIPT_CHAR_LIMIT
			? `[Earlier conversation truncated]\n\n${fullTranscript.slice(-TRANSCRIPT_CHAR_LIMIT)}`
			: fullTranscript;

	const response = await fetch(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model,
			max_tokens: SUMMARY_MAX_TOKENS,
			messages: [
				{ role: "system", content: CHECKPOINT_SYSTEM_PROMPT },
				{ role: "user", content: transcriptForApi },
			],
		}),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Compaction API error (${response.status}): ${errorText}`);
	}

	const data = (await response.json()) as OpenAIChatResponse;
	const checkpoint =
		data.choices[0]?.message?.content ?? "Failed to generate checkpoint";

	// Include recent conversation as text dump
	const RECENT_CHARS = 80_000;
	const recentTranscript =
		fullTranscript.length > RECENT_CHARS
			? fullTranscript.slice(-RECENT_CHARS)
			: fullTranscript;

	// Re-read fresh memory from disk
	let freshMemory = "";
	if (cwd) {
		try {
			const memPath = join(cwd, ".opengraft", "memory.md");
			freshMemory = await readFile(memPath, "utf-8");
		} catch {
			// No memory file
		}
	}

	const oldChars = fullTranscript.length;
	const newChars =
		checkpoint.length +
		recentTranscript.length +
		(taskContext?.length ?? 0) +
		freshMemory.length;
	const savedTokens = Math.max(0, Math.floor((oldChars - newChars) / 4));

	// Build single user message
	const parts: string[] = [];
	if (taskContext) parts.push(`## Original Task\n${taskContext}`);
	if (freshMemory) parts.push(`## Project Memory (fresh)\n${freshMemory}`);
	parts.push(`## Checkpoint Summary\n\n${checkpoint}`);
	parts.push(
		`## Recent Conversation (last ~${Math.round(recentTranscript.length / 1000)}k chars)\n${recentTranscript}`,
	);
	parts.push(
		'Resume from this checkpoint. Your task is NOT done unless the checkpoint says "Current Phase: done". Continue working — check get_tree, follow the stimulus priority, and drive to completion.',
	);

	const compressed: OpenAIMessage[] = [
		{ role: "user", content: parts.join("\n\n---\n\n") },
	];

	return { compressed, savedTokens, checkpoint };
}

// ── Provider ──

export class OpenAIProvider implements AgentProvider {
	readonly name = "openai";
	private baseUrl: string;
	private apiKey: string;
	private model: string;
	private sessionHistory = new Map<string, OpenAIMessage[]>();

	constructor(model?: string) {
		this.baseUrl =
			process.env.OPENAI_BASE_URL ??
			process.env.OPENAI_API_BASE ??
			"https://api.openai.com/v1";
		this.apiKey = process.env.OPENAI_API_KEY ?? "";
		if (!this.apiKey) {
			throw new Error(
				"OPENAI_API_KEY environment variable is required for OpenAIProvider",
			);
		}
		this.model = model ?? "gpt-4o";
	}

	async execute(request: AgentRequest): Promise<AgentResult> {
		const sessionId = request.resumeSessionId ?? randomUUID();
		const gen = this.runLoop(request, sessionId);
		let result = await gen.next();
		while (!result.done) {
			result = await gen.next();
		}
		return result.value;
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
			},
		};
	}

	private async callAPI(
		messages: OpenAIMessage[],
		tools: OpenAITool[],
		model: string,
		maxTokens: number,
	): Promise<OpenAIChatResponse> {
		const body: Record<string, unknown> = {
			model,
			messages,
			max_tokens: maxTokens,
		};
		if (tools.length > 0) {
			body.tools = tools;
			body.tool_choice = "auto";
		}

		for (let attempt = 0; attempt < 5; attempt++) {
			const response = await fetch(`${this.baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			});

			if (response.ok) {
				return (await response.json()) as OpenAIChatResponse;
			}

			const status = response.status;
			const isTransient =
				status === 429 || status === 500 || status === 503 || status === 529;
			if (!isTransient || attempt >= 4) {
				const errorText = await response.text();
				throw new Error(`OpenAI API error (${status}): ${errorText}`);
			}

			const delay = Math.min(2000 * 2 ** attempt, 60000);
			await new Promise((r) => setTimeout(r, delay));
		}

		throw new Error("Failed to get API response after retries");
	}

	private async *runLoop(
		request: AgentRequest,
		sessionId: string,
		queue?: MessageQueue,
	): AsyncGenerator<AgentEvent, AgentResult> {
		const model = request.model ?? this.model;
		let cwd = request.cwd;
		const sessionsDir = request.sessionsDir;

		// Try to fetch context window from API, fall back to static lookup
		const apiContextWindow = await fetchContextWindowFromAPI(
			this.baseUrl,
			this.apiKey,
			model,
		);
		const contextWindow = apiContextWindow ?? getContextWindow(model);
		const compressThreshold = Math.floor(
			contextWindow * (1 - COMPACT_BUFFER_RATIO),
		);

		// Load session history from disk if not already in memory
		if (sessionId && sessionsDir && !this.sessionHistory.has(sessionId)) {
			try {
				const data = await readFile(
					join(sessionsDir, `${sessionId}.openai.json`),
					"utf-8",
				);
				const history = JSON.parse(data) as OpenAIMessage[];
				this.sessionHistory.set(sessionId, history);
			} catch {
				// File missing or corrupt — start fresh
			}
		}

		const existingHistory = this.sessionHistory.get(sessionId);
		const isResume = Boolean(existingHistory);

		const firstUserContent =
			cwd && !isResume
				? `Working directory: ${cwd}\n\n${request.prompt}`
				: request.prompt;

		const messages: OpenAIMessage[] = existingHistory
			? [...existingHistory, { role: "user" as const, content: request.prompt }]
			: [{ role: "user" as const, content: firstUserContent }];

		const taskContext =
			isResume && existingHistory
				? (existingHistory[0]?.content ?? request.prompt)
				: request.prompt;

		// Build tool list: built-in tools (converted) + MCP tools
		const builtinTools = convertToolsToOpenAI(TOOLS);
		const allTools: OpenAITool[] = [...builtinTools];
		// biome-ignore lint/suspicious/noExplicitAny: SdkMcpToolDefinition generic varies
		const mcpHandlers = new Map<string, SdkMcpToolDefinition<any>>();

		if (request.mcpToolDefs) {
			for (const [serverName, defs] of Object.entries(request.mcpToolDefs)) {
				for (const def of defs) {
					const toolName = `mcp__${serverName}__${def.name}`;
					mcpHandlers.set(toolName, def);
					allTools.push({
						type: "function",
						function: {
							name: toolName,
							description: def.description,
							parameters: zodShapeToJsonSchema(def.inputSchema),
						},
					});
				}
			}
		}

		let turns = 0;
		let totalInputTokens = 0;
		let totalOutputTokens = 0;
		let estimatedInputTokens = 0;
		let lastText = "";

		yield { type: "status", message: `Starting agent loop (model: ${model})` };

		while (true) {
			if (request.signal?.aborted) {
				yield { type: "status", message: "Aborted" };
				break;
			}

			// ── Pre-call compression ──
			if (messages.length > 4 && estimatedInputTokens > compressThreshold) {
				yield {
					type: "status",
					message: `Compressing conversation (est. ${estimatedInputTokens} tokens, threshold: ${compressThreshold})`,
				};
				try {
					const { compressed, savedTokens, checkpoint } =
						await compressMessages(
							messages,
							model,
							this.baseUrl,
							this.apiKey,
							taskContext,
							cwd,
						);
					messages.length = 0;
					messages.push(...compressed);
					// Prepend working directory
					const firstMsg = messages[0];
					if (cwd && firstMsg?.role === "user" && firstMsg.content) {
						if (!firstMsg.content.startsWith("Working directory:")) {
							messages[0] = {
								...firstMsg,
								content: `Working directory: ${cwd}\n\n${firstMsg.content}`,
							};
						}
					}
					const postCompactChars = compressed.reduce(
						(sum, m) => sum + (m.content?.length ?? 0),
						0,
					);
					const estimatedPostCompactTokens = Math.floor(postCompactChars / 4);
					estimatedInputTokens = estimatedPostCompactTokens;
					yield {
						type: "usage",
						inputTokens: estimatedPostCompactTokens,
						compressThreshold,
						contextWindow,
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

			turns++;

			// Build messages for API: system prompt first, then conversation
			// Append tool-use instruction — models on OpenAI-compatible APIs need explicit guidance
			const systemContent = request.systemPrompt
				? `${request.systemPrompt}\n\nIMPORTANT: Always call at least one tool in each response. Use your tools to accomplish the task. Do not generate text responses without making tool calls.`
				: "IMPORTANT: Always call at least one tool in each response.";
			const apiMessages: OpenAIMessage[] = [
				{
					role: "system",
					content: systemContent,
				},
				...messages,
			];

			let data: OpenAIChatResponse;
			try {
				data = await this.callAPI(
					apiMessages,
					allTools,
					model,
					DEFAULT_MAX_TOKENS,
				);
			} catch (e) {
				yield {
					type: "error",
					message: `API error: ${e instanceof Error ? e.message : String(e)}`,
				};
				break;
			}

			const promptTokens = data.usage?.prompt_tokens ?? 0;
			const completionTokens = data.usage?.completion_tokens ?? 0;
			totalInputTokens += promptTokens;
			totalOutputTokens += completionTokens;
			estimatedInputTokens = promptTokens + completionTokens;

			yield {
				type: "usage",
				inputTokens: promptTokens,
				compressThreshold,
				contextWindow,
			};

			const choice = data.choices[0];
			if (!choice) {
				yield { type: "error", message: "No choices in API response" };
				break;
			}

			const assistantMsg = choice.message;

			// Emit text content
			if (assistantMsg.content) {
				lastText = assistantMsg.content;
				yield { type: "text", content: assistantMsg.content };
			}

			// Add assistant message to history
			const historyMsg: OpenAIMessage = {
				role: "assistant",
				content: assistantMsg.content,
			};
			if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
				historyMsg.tool_calls = assistantMsg.tool_calls;
			}
			messages.push(historyMsg);

			const toolCalls = assistantMsg.tool_calls ?? [];

			// If no tool calls, handle end of turn
			if (toolCalls.length === 0 || choice.finish_reason === "stop") {
				if (request.doneRef?.done) break;

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
						messages.push({
							role: "user",
							content: `[Messages received while you were idle:]\n${formatted}\n\nProcess these messages and continue working. Remember to call done() when finished.`,
						});
						continue;
					} catch {
						// Queue closed — fall through
					}
				}

				yield {
					type: "status",
					message:
						"Warning: agent ended without calling done() — treating as success",
				};
				break;
			}

			// Emit tool_use events
			for (const tc of toolCalls) {
				let parsedInput: Record<string, unknown> = {};
				try {
					parsedInput = JSON.parse(tc.function.arguments);
				} catch {
					// Keep empty
				}
				yield {
					type: "tool_use",
					tool: tc.function.name,
					input: parsedInput,
				};
			}

			// Execute tools concurrently
			const execResults = await Promise.all(
				toolCalls.map(async (tc) => {
					let parsedInput: Record<string, unknown> = {};
					try {
						parsedInput = JSON.parse(tc.function.arguments);
					} catch {
						return {
							content: `Invalid JSON arguments: ${tc.function.arguments}`,
							isError: true,
						};
					}

					const mcpHandler = mcpHandlers.get(tc.function.name);
					if (mcpHandler) {
						try {
							const mcpResult = await mcpHandler.handler(parsedInput, {});
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

					return executeTool(tc.function.name, parsedInput, cwd, request.cwd);
				}),
			);

			// Emit tool_result events and build response messages
			for (let i = 0; i < toolCalls.length; i++) {
				const tc = toolCalls[i] as OpenAIToolCall;
				const exec = execResults[i] as {
					content: string;
					isError: boolean;
					cwd?: string;
				};

				if (exec.cwd) cwd = exec.cwd;

				yield {
					type: "tool_result",
					tool: tc.function.name,
					content: exec.content.slice(0, 500),
					isError: exec.isError,
				};

				// OpenAI format: each tool result is a separate message
				messages.push({
					role: "tool",
					tool_call_id: tc.id,
					name: tc.function.name,
					content: exec.content,
				});
			}

			// Append done() reminder to the last tool result
			const lastToolMsg = messages[messages.length - 1];
			if (
				lastToolMsg?.role === "tool" &&
				typeof lastToolMsg.content === "string" &&
				!request.doneRef?.done
			) {
				lastToolMsg.content +=
					"\n\n[CRITICAL: If your work is complete, call done() with status 'passed' or 'failed'. Do NOT stop without calling done().]";
			}

			// Cancellation point: drain queue and append to last tool result
			if (queue && queue.pending > 0) {
				const queueMsgs = queue.drain();
				const formatted = queueMsgs.map(formatQueueMessage).join("\n");
				if (
					lastToolMsg?.role === "tool" &&
					typeof lastToolMsg.content === "string"
				) {
					lastToolMsg.content += `\n\n---\n[Messages received while you were working:]\n${formatted}`;
				}
				yield { type: "queue_message", messages: formatted };
			}

			// Persist after tool results
			this.sessionHistory.set(sessionId, [...messages]);
			if (sessionsDir) {
				writeFile(
					join(sessionsDir, `${sessionId}.openai.json`),
					JSON.stringify(messages),
					"utf-8",
				).catch(() => {});
			}

			// Budget check
			if (request.budgetUsd && request.budgetUsd > 0) {
				const { inputPer1M, outputPer1M } = getModelPricing(model);
				const runningCost =
					(totalInputTokens * inputPer1M) / 1_000_000 +
					(totalOutputTokens * outputPer1M) / 1_000_000;
				const ratio = runningCost / request.budgetUsd;

				if (ratio >= 1.0) {
					const warning = `⚠️ Budget exceeded (${runningCost.toFixed(4)} / ${request.budgetUsd.toFixed(2)} budget). Call done() now.`;
					messages.push({ role: "user", content: warning });
					yield { type: "status", message: warning };
				} else if (ratio >= 0.8) {
					const warning = `⚠️ Warning: task has used ${Math.round(ratio * 100)}% of its ${request.budgetUsd.toFixed(2)} budget (${runningCost.toFixed(4)} spent). Wrap up soon.`;
					messages.push({ role: "user", content: warning });
					yield { type: "status", message: warning };
				}
			}

			if (request.doneRef?.done) break;
		}

		// Persist final conversation history
		const finalMessages = [...messages];
		this.sessionHistory.set(sessionId, finalMessages);
		if (sessionsDir) {
			try {
				await mkdir(sessionsDir, { recursive: true });
				await writeFile(
					join(sessionsDir, `${sessionId}.openai.json`),
					JSON.stringify(finalMessages),
					"utf-8",
				);
			} catch {
				// Non-fatal
			}
		}

		const { inputPer1M, outputPer1M } = getModelPricing(model);
		const costUsd =
			(totalInputTokens * inputPer1M) / 1_000_000 +
			(totalOutputTokens * outputPer1M) / 1_000_000;

		const doneResult = request.doneRef?.done;
		return {
			success: doneResult ? doneResult.status === "passed" : true,
			output: doneResult ? doneResult.summary : lastText,
			costUsd,
			turns,
			sessionId,
			inputTokens: totalInputTokens,
			outputTokens: totalOutputTokens,
		};
	}
}
