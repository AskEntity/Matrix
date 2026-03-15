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
import { formatQueueMessage, toRawMessage } from "./agent-tools.ts";
import {
	buildCompactedContext,
	cleanupSessionBackgroundProcesses,
	executeTool,
	extractCheckpoint,
	SUMMARIZATION_INSTRUCTION,
	TOOLS,
	zodShapeToJsonSchema,
} from "./anthropic-compatible-provider.ts";
import { MessageQueue, type QueueMessage } from "./message-queue.ts";
import type { AgentResult } from "./types.ts";

/** Extract image_url parts from queue messages for OpenAI format. */
function extractQueueImageParts(
	msgs: QueueMessage[],
): Array<{ type: "image_url"; image_url: { url: string; detail: "auto" } }> {
	const parts: Array<{
		type: "image_url";
		image_url: { url: string; detail: "auto" };
	}> = [];
	for (const msg of msgs) {
		if (msg.source === "user" && msg.images) {
			for (const img of msg.images) {
				parts.push({
					type: "image_url",
					image_url: {
						url: `data:${img.mediaType};base64,${img.base64}`,
						detail: "auto",
					},
				});
			}
		}
	}
	return parts;
}

// ── Types ──

export interface OpenAIMessage {
	role: "system" | "user" | "assistant" | "tool";
	content:
		| string
		| null
		| Array<
				| { type: "text"; text: string }
				| { type: "image_url"; image_url: { url: string; detail: "auto" } }
		  >;
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

// ── Compaction (in-context) ──
// Compaction is now done in-context: a summarization instruction is pushed as a user
// message, the model generates the checkpoint in its next response, and the context
// is rebuilt. No separate API call is needed. See SUMMARIZATION_INSTRUCTION and
// extractCheckpoint in anthropic-compatible-provider.ts.

// ── Provider ──

export class OpenAICompatibleProvider implements AgentProvider {
	readonly name = "openai";
	private baseUrl: string;
	private apiKey: string;
	private model: string;
	private sessionHistory = new Map<string, OpenAIMessage[]>();

	constructor(model?: string, opts?: { apiKey?: string; baseUrl?: string }) {
		this.baseUrl =
			opts?.baseUrl ??
			process.env.OPENAI_BASE_URL ??
			process.env.OPENAI_API_BASE ??
			"https://api.openai.com/v1";
		this.apiKey = opts?.apiKey ?? process.env.OPENAI_API_KEY ?? "";
		if (!this.apiKey) {
			console.warn(
				"OpenAICompatibleProvider: no API key configured. Calls will fail.",
			);
			// Don't throw — let it fail gracefully on first API call
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
				cleanupSessionBackgroundProcesses(sessionId);
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

		const firstContent = existingHistory?.[0]?.content;
		const taskContext =
			isResume && existingHistory
				? typeof firstContent === "string"
					? firstContent
					: request.prompt
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
		let manualCompactRequested = false;
		let compactionPending = false;
		let preCompactTokenCount = 0;

		yield { type: "status", message: `Starting agent loop (model: ${model})` };

		while (true) {
			if (request.signal?.aborted) {
				yield { type: "status", message: "Aborted" };
				break;
			}

			// ── Handle compaction response: extract checkpoint and rebuild context ──
			if (compactionPending) {
				compactionPending = false;
				const lastMsg = messages[messages.length - 1];
				let responseText = "";
				if (lastMsg?.role === "assistant") {
					const content = lastMsg.content;
					if (typeof content === "string") {
						responseText = content;
					} else if (content === null) {
						responseText = "";
					}
				}
				const checkpoint = extractCheckpoint(responseText);

				try {
					const compactedContent = await buildCompactedContext(
						taskContext,
						checkpoint,
						cwd,
					);
					const oldTokens = preCompactTokenCount;
					messages.length = 0;
					const userContent = cwd
						? `Working directory: ${cwd}\n\n${compactedContent}`
						: compactedContent;
					messages.push({
						role: "user" as const,
						content: userContent,
					});
					const postCompactChars = userContent.length;
					const estimatedPostCompactTokens = Math.floor(postCompactChars / 4);
					const savedTokens = Math.max(
						0,
						oldTokens - estimatedPostCompactTokens,
					);
					estimatedInputTokens = estimatedPostCompactTokens;
					yield {
						type: "usage",
						inputTokens: estimatedPostCompactTokens,
						compressThreshold,
						contextWindow,
						estimated: true,
					};
					yield { type: "compact", checkpoint, savedTokens };
					manualCompactRequested = false;
				} catch (e) {
					yield {
						type: "error",
						message: `Compaction rebuild failed: ${e instanceof Error ? e.message : String(e)}`,
					};
				}
				continue; // Skip normal processing, go to next API call with rebuilt context
			}

			// ── Pre-call compression: inject summarization instruction if over threshold ──
			if (
				messages.length > 4 &&
				(manualCompactRequested || estimatedInputTokens > compressThreshold)
			) {
				yield { type: "compact_started" };
				yield {
					type: "status",
					message: manualCompactRequested
						? "Manual compaction triggered"
						: `Compressing conversation (est. ${estimatedInputTokens} tokens, threshold: ${compressThreshold})`,
				};
				// Inject summarization instruction as a user message instead of making a separate API call
				messages.push({
					role: "user" as const,
					content: SUMMARIZATION_INSTRUCTION,
				});
				compactionPending = true;
				preCompactTokenCount = estimatedInputTokens;
				// Fall through to the normal API call — the model will generate the checkpoint
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

			// Emit text content (skip during compaction — checkpoint text is not user-facing)
			if (assistantMsg.content) {
				lastText = assistantMsg.content;
				if (!compactionPending) {
					yield { type: "text", content: assistantMsg.content };
				}
			}

			// Add assistant message to history
			const historyMsg: OpenAIMessage = {
				role: "assistant",
				content: assistantMsg.content,
			};
			if (
				!compactionPending &&
				assistantMsg.tool_calls &&
				assistantMsg.tool_calls.length > 0
			) {
				historyMsg.tool_calls = assistantMsg.tool_calls;
			}
			messages.push(historyMsg);

			// If compaction is pending, skip tool execution and continue to next iteration
			// where the checkpoint will be extracted and context rebuilt
			if (compactionPending) {
				continue;
			}

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
						if (all.some((m) => m.source === "compact")) {
							manualCompactRequested = true;
						}
						const nonCompact = all.filter((m) => m.source !== "compact");
						if (nonCompact.length === 0) {
							continue;
						}
						const formatted = nonCompact.map(formatQueueMessage).join("\n");
						yield {
							type: "queue_message",
							messages: formatted,
							rawMessages: nonCompact.map(toRawMessage),
						};
						const imageParts = extractQueueImageParts(nonCompact);
						if (imageParts.length > 0) {
							messages.push({
								role: "user",
								content: [
									{
										type: "text" as const,
										text: `[Messages received while you were idle:]\n${formatted}\n\nProcess these messages and continue working. Remember to call done() when finished.`,
									},
									...imageParts,
								],
							});
						} else {
							messages.push({
								role: "user",
								content: `[Messages received while you were idle:]\n${formatted}\n\nProcess these messages and continue working. Remember to call done() when finished.`,
							});
						}
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
							// Separate text and image parts
							const textParts: string[] = [];
							const mcpImages: Array<{
								mediaType: string;
								data: string;
							}> = [];
							for (const c of parts as Array<{
								type: string;
								text?: string;
								data?: string;
								mimeType?: string;
								source?: {
									type: string;
									media_type: string;
									data: string;
								};
							}>) {
								if (c.type === "text") {
									textParts.push(c.text ?? "");
								} else if (c.type === "image" && c.data) {
									// MCP format: { type: "image", data, mimeType }
									mcpImages.push({
										mediaType: c.mimeType ?? "image/png",
										data: c.data,
									});
								} else if (c.type === "image" && c.source?.type === "base64") {
									// Anthropic format: { type: "image", source: { type: "base64", media_type, data } }
									mcpImages.push({
										mediaType: c.source.media_type,
										data: c.source.data,
									});
								} else {
									textParts.push(JSON.stringify(c));
								}
							}
							return {
								content: textParts.join("\n"),
								isError: mcpResult.isError ?? false,
								// Pass images through for injection as user message
								isImage: mcpImages.length > 0,
								mcpImages,
							};
						} catch (e) {
							return {
								content: `MCP tool error: ${e instanceof Error ? e.message : String(e)}`,
								isError: true,
							};
						}
					}

					return executeTool(
						tc.function.name,
						parsedInput,
						cwd,
						request.cwd,
						sessionId,
						queue,
					);
				}),
			);

			// Emit tool_result events and build response messages
			// Collect image results to inject as user message after tool results
			const imageResults: Array<{
				text: string;
				dataUri: string;
			}> = [];

			for (let i = 0; i < toolCalls.length; i++) {
				const tc = toolCalls[i] as OpenAIToolCall;
				const exec = execResults[i] as {
					content: string;
					isError: boolean;
					cwd?: string;
					isImage?: boolean;
					imageData?: string;
					mediaType?: string;
					mcpImages?: Array<{ mediaType: string; data: string }>;
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

				if (exec.isImage && exec.imageData && exec.mediaType) {
					imageResults.push({
						text: exec.content,
						dataUri: `data:${exec.mediaType};base64,${exec.imageData}`,
					});
				}
				// Handle images from MCP tool results (e.g. yield tool with user-attached images)
				if (exec.mcpImages?.length) {
					for (const img of exec.mcpImages) {
						imageResults.push({
							text: "[User-attached image]",
							dataUri: `data:${img.mediaType};base64,${img.data}`,
						});
					}
				}
			}

			// Inject images as a user message (OpenAI tool results are text-only)
			if (imageResults.length > 0) {
				const imageParts: Array<
					| { type: "text"; text: string }
					| {
							type: "image_url";
							image_url: { url: string; detail: "auto" };
					  }
				> = [];
				for (const img of imageResults) {
					imageParts.push(
						{ type: "text", text: img.text },
						{
							type: "image_url",
							image_url: { url: img.dataUri, detail: "auto" },
						},
					);
				}
				messages.push({ role: "user", content: imageParts });
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
				if (queueMsgs.some((m) => m.source === "compact")) {
					manualCompactRequested = true;
				}
				const nonCompactMsgs = queueMsgs.filter((m) => m.source !== "compact");
				if (nonCompactMsgs.length > 0) {
					const formatted = nonCompactMsgs.map(formatQueueMessage).join("\n");
					if (
						lastToolMsg?.role === "tool" &&
						typeof lastToolMsg.content === "string"
					) {
						lastToolMsg.content += `\n\n---\n[Messages received while you were working:]\n${formatted}`;
					}
					// Add any queued images as a user message
					const queueImageParts = extractQueueImageParts(nonCompactMsgs);
					if (queueImageParts.length > 0) {
						messages.push({
							role: "user",
							content: [
								{
									type: "text" as const,
									text: `[${queueImageParts.length} image(s) attached by user]`,
								},
								...queueImageParts,
							],
						});
					}
					yield {
						type: "queue_message",
						messages: formatted,
						rawMessages: nonCompactMsgs.map(toRawMessage),
					};
				}
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
