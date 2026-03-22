import type {
	AgentProvider,
	AgentRequest,
	AgentSession,
} from "./agent-provider.ts";
import { type Event, formatPendingSection } from "./events.ts";
import { MessageQueue, type QueueMessage } from "./message-queue.ts";
import {
	type AssistantContent,
	type AssistantToolCall,
	type ConsumedMessages,
	type EventImageData,
	extractQueueImageParts,
	type ProviderAdapter,
	type ProviderTokenUsage,
	type ProviderToolUse,
	runProviderLoop,
	type ToolExecResult,
	type ToolResultData,
	walkEventsToMessages,
	zodShapeToJsonSchema,
} from "./provider-shared.ts";
import type { ToolDefinition } from "./tool-definition.ts";
import { cleanupSessionBackgroundProcesses, TOOLS } from "./tools/index.ts";
import type { AgentResult } from "./types.ts";
import { ulid } from "./ulid.ts";

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
	// GPT-4.1 family
	"gpt-4.1": { inputPer1M: 2.0, outputPer1M: 8.0 },
	"gpt-4.1-mini": { inputPer1M: 0.4, outputPer1M: 1.6 },
	"gpt-4.1-nano": { inputPer1M: 0.1, outputPer1M: 0.4 },
	// GPT-4o family
	"gpt-4o": { inputPer1M: 2.5, outputPer1M: 10 },
	"gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
	// GPT-4 Turbo
	"gpt-4-turbo": { inputPer1M: 10, outputPer1M: 30 },
	// o-series reasoning models
	o3: { inputPer1M: 10, outputPer1M: 40 },
	"o3-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },
	"o4-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },
	o1: { inputPer1M: 15, outputPer1M: 60 },
	"o1-mini": { inputPer1M: 3, outputPer1M: 12 },
	"o1-pro": { inputPer1M: 150, outputPer1M: 600 },
	// DeepSeek
	"deepseek-chat": { inputPer1M: 0.14, outputPer1M: 0.28 },
	"deepseek-reasoner": { inputPer1M: 0.55, outputPer1M: 2.19 },
};

const CONTEXT_WINDOWS: Record<string, number> = {
	// GPT-4.1 family — 1M context
	"gpt-4.1": 1_047_576,
	"gpt-4.1-mini": 1_047_576,
	"gpt-4.1-nano": 1_047_576,
	// GPT-4o family
	"gpt-4o": 128_000,
	"gpt-4o-mini": 128_000,
	// GPT-4 Turbo
	"gpt-4-turbo": 128_000,
	// o-series reasoning models
	o3: 200_000,
	"o3-mini": 200_000,
	"o4-mini": 200_000,
	o1: 200_000,
	"o1-mini": 128_000,
	"o1-pro": 200_000,
	// DeepSeek
	"deepseek-chat": 64_000,
	"deepseek-reasoner": 64_000,
};

const DEFAULT_CONTEXT_WINDOW = 128_000;

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
	// Prefix match — longest key first to avoid "gpt-4.1" matching before "gpt-4.1-mini"
	const sortedKeys = Object.keys(OPENAI_PRICING).sort(
		(a, b) => b.length - a.length,
	);
	for (const key of sortedKeys) {
		const pricing = OPENAI_PRICING[key];
		if (model.startsWith(key) && pricing) return pricing;
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
	// Prefix match — longest key first to avoid "gpt-4.1" matching before "gpt-4.1-mini"
	const sortedKeys = Object.keys(CONTEXT_WINDOWS).sort(
		(a, b) => b.length - a.length,
	);
	for (const key of sortedKeys) {
		const window = CONTEXT_WINDOWS[key];
		if (model.startsWith(key) && window) return window;
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

// ── OpenAI API call helper ──

async function callOpenAIAPI(
	baseUrl: string,
	apiKey: string,
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
		const response = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
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

// ── OpenAI Event Converter ──

/** Build an OpenAI image_url part from event image data. */
function openaiImagePart(img: EventImageData): unknown {
	return {
		type: "image_url",
		image_url: {
			url: `data:${img.mediaType};base64,${img.base64}`,
			detail: "auto",
		},
	};
}

/**
 * Reconstruct OpenAI-format messages from JSONL events.
 * Uses the shared event walker with OpenAI-specific callbacks.
 * @internal Exported for testing
 */
export function eventsToOpenAIMessages(events: Event[]): unknown[] {
	// Map toolCallId → tool name for resolving tool_result.name
	const toolNames = new Map<string, string>();

	return walkEventsToMessages(events, {
		onUserMessage(content: string): unknown {
			return { role: "user", content };
		},

		onAssistantContent(content: AssistantContent): unknown {
			const texts = content.items
				.filter((i): i is { type: "text"; text: string } => i.type === "text")
				.map((i) => i.text);
			let textContent: string | null = null;
			if (texts.length > 0) {
				textContent = texts.join("\n");
			}

			const toolCalls = content.items
				.filter(
					(i): i is { type: "tool_call"; call: AssistantToolCall } =>
						i.type === "tool_call",
				)
				.map((i) => {
					const tc = i.call;
					// Register tool name for later tool_result resolution
					toolNames.set(tc.id, tc.name);
					return {
						id: tc.id,
						type: "function" as const,
						function: {
							name: tc.name,
							arguments: JSON.stringify(tc.input),
						},
					};
				});

			// Defensive: ensure assistant message has content or tool_calls
			if (textContent === null && toolCalls.length === 0) {
				console.warn(
					"[event-converter] Empty assistant content — inserting (empty) fallback",
				);
				textContent = "(empty)";
			}

			const msg: Record<string, unknown> = {
				role: "assistant",
				content: textContent,
			};
			if (toolCalls.length > 0) {
				msg.tool_calls = toolCalls;
			}
			return msg;
		},

		onToolResults(
			results: ToolResultData[],
			interleaved: Array<{ type: "text"; text: string }>,
			queueImages: EventImageData[],
		): unknown[] {
			const msgs: unknown[] = [];
			const toolImageResults: Array<{ text: string; dataUri: string }> = [];

			for (const result of results) {
				const toolName = toolNames.get(result.toolCallId) ?? "unknown";
				msgs.push({
					role: "tool",
					tool_call_id: result.toolCallId,
					name: toolName,
					content: result.content ?? "(empty)",
				});

				if (result.images) {
					for (const img of result.images) {
						toolImageResults.push({
							text: result.content ?? "(empty)",
							dataUri: `data:${img.mediaType};base64,${img.base64}`,
						});
					}
				}

				if (result.pending) {
					const pendingText = formatPendingSection(result.pending);
					const lastToolMsg = msgs[msgs.length - 1] as
						| { role: string; content: string }
						| undefined;
					if (
						lastToolMsg?.role === "tool" &&
						typeof lastToolMsg.content === "string"
					) {
						lastToolMsg.content += pendingText;
					}
				}
			}

			// Append interleaved messages_consumed to last tool result
			for (const textBlock of interleaved) {
				const lastToolMsg = msgs[msgs.length - 1] as
					| { role: string; content: string }
					| undefined;
				if (
					lastToolMsg?.role === "tool" &&
					typeof lastToolMsg.content === "string"
				) {
					lastToolMsg.content += `\n\n---\n${textBlock.text}`;
				}
			}

			// Inject tool images + queue images as user message
			const allImages = [
				...toolImageResults,
				...queueImages.map((img) => ({
					text: "[User-attached image]",
					dataUri: `data:${img.mediaType};base64,${img.base64}`,
				})),
			];
			if (allImages.length > 0) {
				const imageParts: unknown[] = [];
				for (const img of allImages) {
					imageParts.push(
						{ type: "text", text: img.text },
						{
							type: "image_url",
							image_url: { url: img.dataUri, detail: "auto" },
						},
					);
				}
				msgs.push({ role: "user", content: imageParts });
			}

			return msgs;
		},

		onConsumedMessages(messages: unknown[], consumed: ConsumedMessages): void {
			const wrapper = consumed.isWorkingContext
				? "[Messages received while you were working:]"
				: "[Messages received while you were idle:]";
			const text = `${wrapper}\n${consumed.formattedTexts.join("\n")}`;

			if (consumed.isWorkingContext) {
				const lastMsg = messages[messages.length - 1] as
					| { role: string; content: string }
					| undefined;
				if (lastMsg?.role === "tool" && typeof lastMsg.content === "string") {
					lastMsg.content += `\n\n---\n${text}`;
					return;
				}
			}

			if (consumed.images.length > 0) {
				const imageParts: unknown[] = consumed.images.flatMap((img) => [
					{ type: "text", text: "[User-attached image]" },
					openaiImagePart(img),
				]);
				messages.push({
					role: "user",
					content: [{ type: "text", text }, ...imageParts],
				});
			} else {
				messages.push({ role: "user", content: text });
			}
		},

		isWorkingContext(messages: unknown[]): boolean {
			const lastMsg = messages[messages.length - 1] as
				| { role: string }
				| undefined;
			return lastMsg?.role === "tool";
		},

		fixOrphans: fixOrphanedOpenAIToolCalls,
	});
}

/**
 * Detect and fix orphaned tool_calls in OpenAI message arrays.
 * Scans ALL assistant messages for tool_calls without matching tool role messages.
 */
function fixOrphanedOpenAIToolCalls(messages: unknown[]): void {
	for (let mi = messages.length - 1; mi >= 0; mi--) {
		const msg = messages[mi] as {
			role?: string;
			tool_calls?: Array<{
				id: string;
				type: string;
				function: { name: string; arguments: string };
			}>;
		};
		if (msg.role !== "assistant" || !msg.tool_calls?.length) continue;

		const existingResultIds = new Set<string>();
		for (let j = mi + 1; j < messages.length; j++) {
			const followingMsg = messages[j] as {
				role?: string;
				tool_call_id?: string;
			};
			if (followingMsg.role === "tool" && followingMsg.tool_call_id) {
				existingResultIds.add(followingMsg.tool_call_id);
			} else if (followingMsg.role !== "tool" && followingMsg.role !== "user") {
				break;
			}
		}

		const orphanedCalls = msg.tool_calls.filter(
			(tc) => !existingResultIds.has(tc.id),
		);
		if (orphanedCalls.length === 0) continue;

		console.warn(
			"[event-converter] Orphaned tool_calls found at message index",
			mi,
			"- ids:",
			orphanedCalls.map((tc) => tc.id),
		);

		let insertAt = mi + 1;
		while (
			insertAt < messages.length &&
			(messages[insertAt] as { role?: string }).role === "tool"
		) {
			insertAt++;
		}

		const syntheticResults = orphanedCalls.map((tc) => ({
			role: "tool",
			tool_call_id: tc.id,
			name: tc.function.name,
			content:
				"Tool execution was interrupted by daemon restart. Results were lost.",
		}));

		messages.splice(insertAt, 0, ...syntheticResults);
	}
}

// ── OpenAI Provider Adapter ──

/**
 * Create an OpenAI adapter for the unified run loop.
 * Encapsulates all OpenAI-specific API call format, response parsing, etc.
 */
function createOpenAIAdapter(baseUrl: string, apiKey: string): ProviderAdapter {
	return {
		async getContextWindow(model: string): Promise<number> {
			const apiContextWindow = await fetchContextWindowFromAPI(
				baseUrl,
				apiKey,
				model,
			);
			return apiContextWindow ?? getContextWindow(model);
		},

		getModelPricing(model: string) {
			return getModelPricing(model);
		},

		convertEventsToMessages(events: Event[]): unknown[] {
			return eventsToOpenAIMessages(events) as unknown[];
		},

		prepareTools(
			// biome-ignore lint/suspicious/noExplicitAny: ToolDefinition generic varies
			mcpToolDefs: Record<string, ToolDefinition<any>[]> | undefined,
			// biome-ignore lint/suspicious/noExplicitAny: ToolDefinition generic varies
			mcpHandlers: Map<string, ToolDefinition<any>>,
		): unknown[] {
			const builtinTools = convertToolsToOpenAI(TOOLS);
			const allTools: OpenAITool[] = [...builtinTools];
			if (mcpToolDefs) {
				for (const [serverName, defs] of Object.entries(mcpToolDefs)) {
					for (const def of defs) {
						const toolName = `mcp__${serverName}__${def.name}`;
						mcpHandlers.set(toolName, def);
						allTools.push({
							type: "function",
							function: {
								name: toolName,
								description: def.description,
								parameters:
									def.jsonSchema ?? zodShapeToJsonSchema(def.inputSchema),
							},
						});
					}
				}
			}
			return allTools;
		},

		// biome-ignore lint/correctness/useYield: OpenAI doesn't stream — no text_delta events to yield
		async *callAPI(params) {
			const tools = params.tools as OpenAITool[];

			// Build messages for API: system prompt first, then conversation
			// Append tool-use instruction — models on OpenAI-compatible APIs need explicit guidance
			const systemContent = params.systemPrompt
				? `${params.systemPrompt}\n\nIMPORTANT: Always call at least one tool in each response. Use your tools to accomplish the task. Do not generate text responses without making tool calls.`
				: "IMPORTANT: Always call at least one tool in each response.";
			const apiMessages: OpenAIMessage[] = [
				{
					role: "system",
					content: systemContent,
				},
				...(params.messages as OpenAIMessage[]),
			];

			const data = await callOpenAIAPI(
				baseUrl,
				apiKey,
				apiMessages,
				tools,
				params.model,
				params.maxTokens,
			);

			return data;
		},

		getResponseText(response: unknown): string {
			const data = response as OpenAIChatResponse;
			const choice = data.choices[0];
			return choice?.message.content ?? "";
		},

		getToolUses(response: unknown): ProviderToolUse[] {
			const data = response as OpenAIChatResponse;
			const choice = data.choices[0];
			const toolCalls = choice?.message.tool_calls ?? [];
			return toolCalls.map((tc) => {
				let parsedInput: Record<string, unknown> = {};
				try {
					parsedInput = JSON.parse(tc.function.arguments);
				} catch {
					// Keep empty
				}
				return {
					id: tc.id,
					name: tc.function.name,
					input: parsedInput,
				};
			});
		},

		getTokenUsage(response: unknown): ProviderTokenUsage {
			const data = response as OpenAIChatResponse;
			const promptTokens = data.usage?.prompt_tokens ?? 0;
			const completionTokens = data.usage?.completion_tokens ?? 0;
			return {
				inputTokens: promptTokens,
				outputTokens: completionTokens,
				totalContextTokens: promptTokens,
			};
		},

		getStopReason(response: unknown): "end_turn" | "tool_use" {
			const data = response as OpenAIChatResponse;
			const choice = data.choices[0];
			const toolCalls = choice?.message.tool_calls ?? [];
			if (toolCalls.length === 0 || choice?.finish_reason === "stop") {
				return "end_turn";
			}
			return "tool_use";
		},

		supportsTokenCounting: false,

		buildResponseEvents(response: unknown, isCompacting: boolean): Event[] {
			const data = response as OpenAIChatResponse;
			const choice = data.choices[0];
			const events: Event[] = [];

			if (choice?.message.content) {
				events.push({
					type: "assistant_text",
					content: choice.message.content,
					ts: Date.now(),
				});
			}

			if (!isCompacting && choice?.message.tool_calls) {
				for (const tc of choice.message.tool_calls) {
					let parsedInput: Record<string, unknown> = {};
					try {
						parsedInput = JSON.parse(tc.function.arguments);
					} catch {
						// Keep empty
					}
					events.push({
						type: "tool_call",
						tool: tc.function.name,
						toolCallId: tc.id,
						input: parsedInput,
						ts: Date.now(),
					});
				}
			}

			return events;
		},

		addAssistantMessage(
			messages: unknown[],
			response: unknown,
			isCompacting: boolean,
		): void {
			const data = response as OpenAIChatResponse;
			const choice = data.choices[0];
			if (!choice) return;

			const historyMsg: OpenAIMessage = {
				role: "assistant",
				content: choice.message.content,
			};
			if (
				!isCompacting &&
				choice.message.tool_calls &&
				choice.message.tool_calls.length > 0
			) {
				historyMsg.tool_calls = choice.message.tool_calls;
			}
			(messages as OpenAIMessage[]).push(historyMsg);
		},

		buildToolResultsMessage(params): unknown[] {
			const result: OpenAIMessage[] = [];

			// Image results to inject as user message (OpenAI tool results are text-only)
			const imageResults: Array<{
				text: string;
				dataUri: string;
			}> = [];

			// Queue messages from yield/done tools
			const yieldQueueTexts: string[] = [];
			const yieldQueueImageParts: Array<
				| { type: "text"; text: string }
				| {
						type: "image_url";
						image_url: { url: string; detail: "auto" };
				  }
			> = [];

			for (let i = 0; i < params.toolUses.length; i++) {
				const toolUse = params.toolUses[i] as ProviderToolUse;
				const exec = params.execResults[i] as ToolExecResult;

				// OpenAI format: each tool result is a separate message
				result.push({
					role: "tool",
					tool_call_id: toolUse.id,
					name: toolUse.name,
					content: exec.content,
				});

				if (exec._formattedQueueMessages) {
					yieldQueueTexts.push(
						`[Messages received while you were idle:]\n${exec._formattedQueueMessages}`,
					);
					if (exec.mcpImages?.length) {
						for (const img of exec.mcpImages) {
							yieldQueueImageParts.push(
								{
									type: "text" as const,
									text: "[User-attached image]",
								},
								{
									type: "image_url" as const,
									image_url: {
										url: `data:${img.mediaType};base64,${img.data ?? img.base64}`,
										detail: "auto" as const,
									},
								},
							);
						}
					}
				} else {
					if (exec.isImage && exec.imageData && exec.mediaType) {
						imageResults.push({
							text: exec.content,
							dataUri: `data:${exec.mediaType};base64,${exec.imageData}`,
						});
					}
					if (exec.mcpImages?.length) {
						for (const img of exec.mcpImages) {
							imageResults.push({
								text: "[User-attached image]",
								dataUri: `data:${img.mediaType};base64,${img.data ?? img.base64}`,
							});
						}
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
				result.push({ role: "user", content: imageParts });
			}

			// Inject queue messages from yield/done as a separate user message
			if (yieldQueueTexts.length > 0 || yieldQueueImageParts.length > 0) {
				const parts: Array<
					| { type: "text"; text: string }
					| {
							type: "image_url";
							image_url: { url: string; detail: "auto" };
					  }
				> = [
					...yieldQueueTexts.map((t) => ({
						type: "text" as const,
						text: t,
					})),
					...yieldQueueImageParts,
				];
				result.push({ role: "user", content: parts });
			}

			// Append done() reminder to the last tool result
			let lastTool: OpenAIMessage | undefined;
			for (let i = result.length - 1; i >= 0; i--) {
				if (result[i]?.role === "tool") {
					lastTool = result[i];
					break;
				}
			}
			if (lastTool?.role === "tool" && typeof lastTool.content === "string") {
				lastTool.content +=
					"\n\n[CRITICAL: If your work is complete, call done() with status 'passed' or 'failed'. Do NOT stop without calling done().]";
			}

			// Cancellation point: append to last tool result
			if (
				params.cancellationQueueMsgs.length > 0 &&
				params.cancellationFormatted
			) {
				if (lastTool?.role === "tool" && typeof lastTool.content === "string") {
					lastTool.content += `\n\n---\n[Messages received while you were working:]\n${params.cancellationFormatted}`;
				}
				// Add any queued images as a user message
				const queueImageParts = extractQueueImageParts(
					params.cancellationQueueMsgs,
				);
				if (queueImageParts.length > 0) {
					result.push({
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
			}

			return result;
		},

		buildImplicitYieldMessage(formatted: string, nonCompact: QueueMessage[]) {
			const imageParts = extractQueueImageParts(nonCompact);
			if (imageParts.length > 0) {
				return {
					role: "user" as const,
					content: [
						{
							type: "text" as const,
							text: `[Messages received while you were idle:]\n${formatted}`,
						},
						...imageParts,
					],
				};
			}
			return {
				role: "user" as const,
				content: `[Messages received while you were idle:]\n${formatted}`,
			};
		},

		computeCost(
			model: string,
			totalInputTokens: number,
			totalOutputTokens: number,
			_totalCacheCreationTokens: number,
			_totalCacheReadTokens: number,
		): number {
			const { inputPer1M: ip, outputPer1M: op } = getModelPricing(model);
			return (
				(totalInputTokens * ip) / 1_000_000 +
				(totalOutputTokens * op) / 1_000_000
			);
		},
	};
}

// ── Provider ──

export class OpenAICompatibleProvider implements AgentProvider {
	readonly name = "openai";
	private baseUrl: string;
	private apiKey: string;
	private model: string;

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
		const sessionId = request.resumeSessionId ?? ulid();
		// For execute(), create a self-closing queue: after draining the initial
		// message, close so the provider exits on end_turn instead of entering
		// implicit yield. If a queue was provided, copy its messages.
		const execQueue = new MessageQueue();
		if (request.queue) {
			for (const msg of request.queue.drain()) {
				execQueue.enqueue(msg);
			}
		}
		execQueue.onDrain = () => {
			execQueue.onDrain = undefined;
			execQueue.close();
		};
		const gen = this.runLoop(request, sessionId, execQueue);
		let result = await gen.next();
		while (!result.done) {
			result = await gen.next();
		}
		return result.value;
	}

	async *stream(request: AgentRequest): AsyncGenerator<Event, AgentResult> {
		const sessionId = request.resumeSessionId ?? ulid();
		const gen = this.runLoop(request, sessionId, request.queue);
		let result = await gen.next();
		while (!result.done) {
			yield result.value;
			result = await gen.next();
		}
		return result.value;
	}

	startSession(request: AgentRequest): AgentSession {
		const sessionId = request.resumeSessionId ?? ulid();
		const queue = request.queue ?? new MessageQueue();
		const abortController = new AbortController();
		const self = this;

		async function* eventStream(): AsyncGenerator<Event, AgentResult> {
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
	): AsyncGenerator<Event, AgentResult> {
		const adapter = createOpenAIAdapter(this.baseUrl, this.apiKey);
		const effectiveRequest = {
			...request,
			model: request.model ?? this.model,
		};
		return yield* runProviderLoop(adapter, effectiveRequest, sessionId, queue);
	}
}
