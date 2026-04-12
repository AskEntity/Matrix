import OpenAI from "openai";
import type {
	Response as OAIResponse,
	ResponseCreateParams,
	ResponseFunctionToolCall,
	ResponseOutputMessage,
} from "openai/resources/responses/responses";
import type { AgentProvider, AgentRequest } from "./agent-provider.ts";
import {
	debugResponsePath,
	writeDebugResponse,
	writeDebugSnapshot,
} from "./debug-snapshot.ts";
import {
	type AssistantContent,
	type AssistantToolCall,
	type ConsumedMessages,
	type EventImageData,
	type ToolResultData,
	walkEventsToMessages,
} from "./event-converter.ts";
import type { Event } from "./events.ts";
import { MessageQueue, type QueueMessage } from "./message-queue.ts";
import {
	extractQueueImageParts,
	type ProviderAdapter,
	type ProviderTokenUsage,
	type ProviderToolUse,
	runProviderLoop,
	type ToolResult,
} from "./provider-shared.ts";
import { formatQueueMessage } from "./task-utils.ts";
import type { JsonTool } from "./tool-definition.ts";
import type { AgentResult } from "./types.ts";
import { ulid } from "./ulid.ts";

interface HistoryMessage {
	role: "user" | "assistant" | "tool";
	content:
		| string
		| null
		| Array<
				| { type: "text"; text: string }
				| { type: "image_url"; image_url: { url: string; detail: "auto" } }
		  >;
	tool_calls?: HistoryToolCall[];
	tool_call_id?: string;
	name?: string;
}

interface HistoryToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

/** SDK tool shape for function tools (used in prepareTools). */
interface ResponsesTool {
	type: "function";
	name: string;
	description: string;
	strict: false;
	parameters: Record<string, unknown>;
}

const OPENAI_PRICING: Record<
	string,
	{ inputPer1M: number; outputPer1M: number }
> = {
	"gpt-4.1": { inputPer1M: 2.0, outputPer1M: 8.0 },
	"gpt-4.1-mini": { inputPer1M: 0.4, outputPer1M: 1.6 },
	"gpt-4.1-nano": { inputPer1M: 0.1, outputPer1M: 0.4 },
	"gpt-4o": { inputPer1M: 2.5, outputPer1M: 10 },
	"gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
	"gpt-4-turbo": { inputPer1M: 10, outputPer1M: 30 },
	"gpt-5": { inputPer1M: 1.25, outputPer1M: 10 },
	"gpt-5.4": { inputPer1M: 1.25, outputPer1M: 10 },
	"gpt-5.4-mini": { inputPer1M: 0.25, outputPer1M: 2 },
	"gpt-5.4-nano": { inputPer1M: 0.05, outputPer1M: 0.4 },
	o3: { inputPer1M: 10, outputPer1M: 40 },
	"o3-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },
	"o4-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },
	o1: { inputPer1M: 15, outputPer1M: 60 },
	"o1-mini": { inputPer1M: 3, outputPer1M: 12 },
	"o1-pro": { inputPer1M: 150, outputPer1M: 600 },
	"gpt-5-codex": { inputPer1M: 1.5, outputPer1M: 6 },
	"gpt-5.1-codex": { inputPer1M: 1.5, outputPer1M: 6 },
	"gpt-5.2-codex": { inputPer1M: 1.5, outputPer1M: 6 },
	"gpt-5.3-codex": { inputPer1M: 1.5, outputPer1M: 6 },
};

const CONTEXT_WINDOWS: Record<string, number> = {
	"gpt-4.1": 1_047_576,
	"gpt-4.1-mini": 1_047_576,
	"gpt-4.1-nano": 1_047_576,
	"gpt-4o": 128_000,
	"gpt-4o-mini": 128_000,
	"gpt-4-turbo": 128_000,
	"gpt-5": 400_000,
	"gpt-5.4": 1_050_000,
	"gpt-5.4-mini": 400_000,
	"gpt-5.4-nano": 400_000,
	o3: 200_000,
	"o3-mini": 200_000,
	"o4-mini": 200_000,
	o1: 200_000,
	"o1-mini": 128_000,
	"o1-pro": 200_000,
	"gpt-5-codex": 400_000,
	"gpt-5.1-codex": 400_000,
	"gpt-5.2-codex": 400_000,
	"gpt-5.3-codex": 400_000,
};

const DEFAULT_CONTEXT_WINDOW = 128_000;
const contextWindowCache = new Map<string, number>();

export function clearContextWindowCache(): void {
	contextWindowCache.clear();
}

export function getModelPricing(model: string): {
	inputPer1M: number;
	outputPer1M: number;
} {
	if (OPENAI_PRICING[model]) return OPENAI_PRICING[model];
	const sortedKeys = Object.keys(OPENAI_PRICING).sort(
		(a, b) => b.length - a.length,
	);
	for (const key of sortedKeys) {
		const pricing = OPENAI_PRICING[key];
		if (model.startsWith(key) && pricing) return pricing;
	}
	return OPENAI_PRICING["gpt-4o"] as {
		inputPer1M: number;
		outputPer1M: number;
	};
}

export function getContextWindow(model: string): number {
	if (CONTEXT_WINDOWS[model]) return CONTEXT_WINDOWS[model];
	const sortedKeys = Object.keys(CONTEXT_WINDOWS).sort(
		(a, b) => b.length - a.length,
	);
	for (const key of sortedKeys) {
		const window = CONTEXT_WINDOWS[key];
		if (model.startsWith(key) && window) return window;
	}
	return DEFAULT_CONTEXT_WINDOW;
}

function resolveResponsesEndpoint(baseUrl: string): string {
	return baseUrl.endsWith("/responses") ? baseUrl : `${baseUrl}/responses`;
}

function canFetchModels(baseUrl: string): boolean {
	return !baseUrl.endsWith("/responses");
}

function isCodexEndpoint(endpoint: string): boolean {
	return endpoint.includes("chatgpt.com/backend-api/codex/responses");
}

export async function fetchContextWindowFromAPI(
	baseUrl: string,
	authToken: string,
	model: string,
): Promise<number | null> {
	if (!canFetchModels(baseUrl)) return null;
	const cached = contextWindowCache.get(model);
	if (cached !== undefined) return cached;

	try {
		const response = await fetch(`${baseUrl}/models`, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${authToken}`,
			},
		});
		if (!response.ok) return null;

		const data = (await response.json()) as {
			data?: Array<{ id: string; context_length?: number }>;
		};
		if (!Array.isArray(data.data)) return null;

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
		// Ignore network and parse errors, fall back to static table.
	}
	return null;
}

function openaiImagePart(img: EventImageData): {
	type: "image_url";
	image_url: { url: string; detail: "auto" };
} {
	return {
		type: "image_url",
		image_url: {
			url: `data:${img.mediaType};base64,${img.base64}`,
			detail: "auto",
		},
	};
}

function isHistoryWorkingContext(messages: unknown[]): boolean {
	const lastMsg = messages[messages.length - 1] as { role: string } | undefined;
	return lastMsg?.role === "tool";
}

/**
 * Apply queue-message content (texts + images) to an existing messages array.
 * Single source of truth used by both the walker's `onConsumedMessages` callback
 * and the adapter's `appendQueueMessagesToMessages` hook.
 *
 * Both live initial-drain and JSONL reconstruction MUST produce byte-identical
 * output — that's enforced by having this one function be the only implementation.
 */
function applyOpenAIResponsesQueueContent(
	messages: unknown[],
	consumed: ConsumedMessages,
): void {
	if (isHistoryWorkingContext(messages)) {
		const lastMsg = messages[messages.length - 1] as
			| { role: string; content: string }
			| undefined;
		if (lastMsg?.role === "tool" && typeof lastMsg.content === "string") {
			for (const text of consumed.formattedTexts) {
				lastMsg.content += `\n\n---\n${text}`;
			}
			return;
		}
	}

	if (consumed.images.length > 0) {
		const textParts = consumed.formattedTexts.map((t) => ({
			type: "text" as const,
			text: t,
		}));
		const imageParts = consumed.images.flatMap((img) => [
			{ type: "text" as const, text: "[User-attached image]" },
			openaiImagePart(img),
		]);
		messages.push({
			role: "user",
			content: [...textParts, ...imageParts],
		});
	} else if (consumed.formattedTexts.length === 1) {
		messages.push({
			role: "user",
			content: consumed.formattedTexts[0],
		});
	} else {
		messages.push({
			role: "user",
			content: consumed.formattedTexts.map((t) => ({
				type: "text" as const,
				text: t,
			})),
		});
	}
}

export function eventsToOpenAIResponsesMessages(events: Event[]): unknown[] {
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

			if (textContent === null && toolCalls.length === 0) {
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
					content: result.content || "(empty)",
				});

				if (result.images) {
					for (const img of result.images) {
						toolImageResults.push({
							text: result.content || "(empty)",
							dataUri: `data:${img.mediaType};base64,${img.base64}`,
						});
					}
				}
			}

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

			const allImages = [
				...toolImageResults,
				...queueImages.map((img) => ({
					text: "[User-attached image]",
					dataUri: `data:${img.mediaType};base64,${img.base64}`,
				})),
			];
			if (allImages.length > 0) {
				const imageParts: HistoryMessage["content"] = [];
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
			applyOpenAIResponsesQueueContent(messages, consumed);
		},

		isWorkingContext: isHistoryWorkingContext,
	});
}

function historyMessageToResponsesInput(
	msg: HistoryMessage,
): Record<string, unknown>[] {
	if (msg.role === "user") {
		const content =
			typeof msg.content === "string"
				? [{ type: "input_text", text: msg.content }]
				: (msg.content ?? []).map((part) =>
						part.type === "text"
							? { type: "input_text", text: part.text }
							: {
									type: "input_image",
									image_url: part.image_url.url,
									detail: "auto",
								},
					);
		return [{ type: "message", role: "user", content }];
	}

	if (msg.role === "assistant") {
		const items: Record<string, unknown>[] = [];
		if (typeof msg.content === "string" && msg.content) {
			items.push({
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: msg.content }],
			});
		}
		for (const tc of msg.tool_calls ?? []) {
			items.push({
				type: "function_call",
				call_id: tc.id,
				name: tc.function.name,
				arguments: tc.function.arguments,
			});
		}
		return items;
	}

	return [
		{
			type: "function_call_output",
			call_id: msg.tool_call_id,
			output: typeof msg.content === "string" ? msg.content : "(empty)",
		},
	];
}

function historyToResponsesInput(
	messages: HistoryMessage[],
): Record<string, unknown>[] {
	return messages.flatMap(historyMessageToResponsesInput);
}

/**
 * Stream a Responses API call via the OpenAI SDK.
 *
 * Caller owns body construction. This function only does:
 * 1. Create an OpenAI client with the right base URL / headers
 * 2. Call `client.responses.create(body, { signal })` with streaming
 * 3. Yield text_delta events for live UI streaming
 * 4. Return the completed OAIResponse
 *
 * @internal Exported for testing only.
 */
export async function* streamResponsesAPI(params: {
	endpoint: string;
	authToken: string;
	accountId?: string;
	body: ResponseCreateParams;
	signal?: AbortSignal;
	/** Override max retries for testing. SDK default: 2. */
	maxRetries?: number;
}): AsyncGenerator<Event, OAIResponse> {
	const endpoint = resolveResponsesEndpoint(params.endpoint);
	const codex = isCodexEndpoint(endpoint);

	// Build SDK client with appropriate base URL and headers.
	const defaultHeaders: Record<string, string> = {};
	if (params.accountId) {
		defaultHeaders["ChatGPT-Account-Id"] = params.accountId;
	}
	if (codex) {
		defaultHeaders.originator = "matrix";
		defaultHeaders["User-Agent"] = "matrix";
	}

	const client = new OpenAI({
		apiKey: params.authToken,
		baseURL: endpoint.replace(/\/responses$/, ""),
		maxRetries: params.maxRetries ?? 2,
		defaultHeaders,
	});

	const stream = await client.responses.create(
		{ ...params.body, stream: true } as ResponseCreateParams & {
			stream: true;
		},
		{ signal: params.signal },
	);

	let completedResponse: OAIResponse | null = null;

	for await (const event of stream) {
		switch (event.type) {
			case "response.output_text.delta": {
				yield {
					type: "text_delta",
					content: event.delta ?? "",
					taskId: "",
					ts: Date.now(),
				};
				break;
			}
			case "response.completed": {
				completedResponse = event.response;
				break;
			}
			case "response.failed": {
				const err =
					event.response?.error?.message ?? "Responses API stream failed";
				throw new Error(err);
			}
			// All other events (output_item.added, function_call_arguments.done, etc.)
			// are tracked by the SDK internally — completedResponse.output has the final state.
		}
	}

	if (completedResponse) {
		return completedResponse;
	}

	// Fallback: stream ended without response.completed (shouldn't happen with SDK)
	throw new Error("Stream ended without response.completed event");
}

function createOpenAIResponsesAdapter(
	baseUrl: string,
	authToken: string,
	accountId?: string,
	opts?: { maxRetries?: number },
): ProviderAdapter {
	return {
		async getContextWindow(model: string): Promise<number> {
			const apiContextWindow = await fetchContextWindowFromAPI(
				baseUrl,
				authToken,
				model,
			);
			return apiContextWindow ?? getContextWindow(model);
		},

		getModelPricing(model: string) {
			return getModelPricing(model);
		},

		convertEventsToMessages(events: Event[]): unknown[] {
			return eventsToOpenAIResponsesMessages(events);
		},

		prepareTools(jsonTools: JsonTool[]): unknown[] {
			return jsonTools.map(
				(t) =>
					({
						type: "function",
						name: t.name,
						description: t.description,
						strict: false,
						parameters: t.jsonSchema,
					}) satisfies ResponsesTool,
			);
		},

		async *callAPI(params) {
			const instructions =
				`${params.systemPrompt.stable}\n\n${params.systemPrompt.variable}`.trim();
			const endpoint = resolveResponsesEndpoint(baseUrl);
			const codex = isCodexEndpoint(endpoint);

			// Caller builds body — this is the EXACT object passed to the SDK.
			const body: ResponseCreateParams = {
				model: params.model,
				instructions,
				input: historyToResponsesInput(
					params.messages as HistoryMessage[],
				) as unknown as ResponseCreateParams["input"],
				tools: params.tools as unknown as ResponseCreateParams["tools"],
				stream: true,
				store: false,
			};
			if (!codex && params.maxTokens > 0) {
				body.max_output_tokens = params.maxTokens;
			}
			if (codex) {
				body.include = ["reasoning.encrypted_content"];
			}

			// Snapshot the exact body before sending — zero divergence possible.
			writeDebugSnapshot(params.debugSnapshotPath, {
				sessionId: params.sessionId ?? "",
				provider: "openai-responses",
				body: body as unknown as Record<string, unknown>,
			});

			const response = yield* streamResponsesAPI({
				endpoint: baseUrl,
				authToken,
				accountId,
				body,
				signal: params.signal,
				maxRetries: opts?.maxRetries,
			});

			// Snapshot the response too.
			writeDebugResponse(debugResponsePath(params.debugSnapshotPath), response);

			return response;
		},

		getResponseText(response: unknown): string {
			const data = response as OAIResponse;
			return data.output_text ?? "";
		},

		getToolUses(response: unknown): ProviderToolUse[] {
			const data = response as OAIResponse;
			return (data.output ?? [])
				.filter(
					(item): item is ResponseFunctionToolCall =>
						item.type === "function_call",
				)
				.map((item) => {
					let parsedInput: Record<string, unknown> = {};
					try {
						parsedInput = JSON.parse(item.arguments);
					} catch {
						// Ignore malformed args and let tool validation handle it later.
					}
					return {
						id: item.call_id ?? ulid(),
						name: item.name,
						input: parsedInput,
					};
				});
		},

		getTokenUsage(response: unknown): ProviderTokenUsage {
			const data = response as OAIResponse;
			const inputTokens = data.usage?.input_tokens ?? 0;
			const outputTokens = data.usage?.output_tokens ?? 0;
			return {
				inputTokens,
				outputTokens,
				totalContextTokens: inputTokens,
			};
		},

		getStopReason(response: unknown): "end_turn" | "tool_use" {
			const hasToolUse = (response as OAIResponse).output?.some(
				(item) => item.type === "function_call",
			);
			return hasToolUse ? "tool_use" : "end_turn";
		},

		supportsTokenCounting: false,

		buildResponseEvents(response: unknown, isCompacting: boolean): Event[] {
			const data = response as OAIResponse;
			const events: Event[] = [];
			for (const item of data.output ?? []) {
				if (item.type === "message") {
					const msg = item as ResponseOutputMessage;
					const text = msg.content
						.filter((part) => part.type === "output_text")
						.map((part) => (part as { text: string }).text ?? "")
						.join("\n");
					if (text) {
						events.push({
							type: "assistant_text",
							content: text,
							taskId: "",
							ts: Date.now(),
						});
					}
				} else if (item.type === "function_call" && !isCompacting) {
					const fc = item as ResponseFunctionToolCall;
					let parsedInput: Record<string, unknown> = {};
					try {
						parsedInput = JSON.parse(fc.arguments);
					} catch {
						// Keep empty input for malformed function arguments.
					}
					events.push({
						type: "tool_call",
						tool: fc.name,
						toolCallId: fc.call_id ?? ulid(),
						input: parsedInput,
						taskId: "",
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
			const data = response as OAIResponse;
			const contentTexts: string[] = [];
			const toolCalls: HistoryToolCall[] = [];

			for (const item of data.output ?? []) {
				if (item.type === "message") {
					const msg = item as ResponseOutputMessage;
					for (const part of msg.content ?? []) {
						if (
							part.type === "output_text" &&
							(part as { text: string }).text
						) {
							contentTexts.push((part as { text: string }).text);
						}
					}
				} else if (item.type === "function_call" && !isCompacting) {
					const fc = item as ResponseFunctionToolCall;
					toolCalls.push({
						id: fc.call_id ?? ulid(),
						type: "function",
						function: {
							name: fc.name,
							arguments: fc.arguments,
						},
					});
				}
			}

			const historyMsg: HistoryMessage = {
				role: "assistant",
				content: contentTexts.length > 0 ? contentTexts.join("\n") : null,
			};
			if (toolCalls.length > 0) {
				historyMsg.tool_calls = toolCalls;
			}
			(messages as HistoryMessage[]).push(historyMsg);
		},

		buildUserTurn(params): unknown[] {
			const result: HistoryMessage[] = [];
			const imageResults: Array<{ text: string; dataUri: string }> = [];
			const allQueueTexts: string[] = [];
			const allQueueImageParts: Array<
				| { type: "text"; text: string }
				| { type: "image_url"; image_url: { url: string; detail: "auto" } }
			> = [];

			for (let i = 0; i < params.toolUses.length; i++) {
				const toolUse = params.toolUses[i] as ProviderToolUse;
				const exec = params.execResults[i] as ToolResult;

				result.push({
					role: "tool",
					tool_call_id: toolUse.id,
					name: toolUse.name,
					content: exec.content,
				});

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

			if (imageResults.length > 0) {
				const imageParts: NonNullable<HistoryMessage["content"]> = [];
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

			// Raw queue messages — format each individually.
			// Each message becomes its own entry to match JSONL reconstruction.
			if (params.queueMessages.length > 0) {
				for (const msg of params.queueMessages) {
					const text = formatQueueMessage(msg);
					if (text) {
						allQueueTexts.push(text);
					}
				}
				const queueImageParts = extractQueueImageParts(params.queueMessages);
				allQueueImageParts.push(...queueImageParts);
			}

			if (allQueueTexts.length > 0 || allQueueImageParts.length > 0) {
				// Single text, no images, no tool results → string content (matches JSONL reconstruction)
				if (
					allQueueTexts.length === 1 &&
					allQueueImageParts.length === 0 &&
					result.length === 0
				) {
					result.push({
						role: "user",
						content: allQueueTexts[0] ?? "",
					});
				} else {
					result.push({
						role: "user",
						content: [
							...allQueueTexts.map((text) => ({
								type: "text" as const,
								text,
							})),
							...allQueueImageParts,
						],
					});
				}
			}

			return result;
		},

		appendQueueMessagesToMessages(
			messages: unknown[],
			queueMsgs: QueueMessage[],
		): void {
			// Initial-drain path — provider-shared drained queue messages at fresh
			// start / interrupted resume and needs them appended to messages[].
			// Routes through applyOpenAIResponsesQueueContent (same function the
			// walker uses) to guarantee byte-identical output with reconstruction.
			const formattedTexts: string[] = [];
			const images: EventImageData[] = [];
			for (const msg of queueMsgs) {
				const text = formatQueueMessage(msg);
				if (text) formattedTexts.push(text);
				if (msg.source === "user" && msg.images) {
					for (const img of msg.images) {
						images.push({
							base64: img.base64,
							mediaType: img.mediaType,
						});
					}
				}
			}
			applyOpenAIResponsesQueueContent(messages, { formattedTexts, images });
		},

		validateImage(base64: string, _mediaType: string) {
			// OpenAI rejects images where decoded byte size exceeds 20MB.
			// Use actual Buffer decode for exact byte count — no estimation.
			const MAX_BYTES = 20_971_520; // 20MB
			const byteLength = Buffer.from(base64, "base64").byteLength;
			if (byteLength > MAX_BYTES) {
				const sizeMB = (byteLength / 1_048_576).toFixed(1);
				return {
					ok: false as const,
					reason: `image size (${sizeMB} MB) exceeds OpenAI API limit (20.0 MB)`,
				};
			}
			return { ok: true as const };
		},

		computeCost(
			model: string,
			totalInputTokens: number,
			totalOutputTokens: number,
		): number {
			const { inputPer1M: ip, outputPer1M: op } = getModelPricing(model);
			return (
				(totalInputTokens * ip) / 1_000_000 +
				(totalOutputTokens * op) / 1_000_000
			);
		},
	};
}

export class OpenAIResponsesCompatibleProvider implements AgentProvider {
	readonly name = "openai";
	private baseUrl: string;
	private authToken: string;
	private refreshToken: string;
	private accountId?: string;
	private model: string;
	/** Override SDK max retries for testing. SDK default: 2. */
	maxRetries?: number;

	constructor(
		model?: string,
		opts?: {
			apiKey?: string;
			accessToken?: string;
			refreshToken?: string;
			accountId?: string;
			baseUrl?: string;
		},
	) {
		this.baseUrl =
			opts?.baseUrl ??
			process.env.OPENAI_BASE_URL ??
			process.env.OPENAI_API_BASE ??
			"https://api.openai.com/v1";
		this.authToken =
			opts?.apiKey ?? opts?.accessToken ?? process.env.OPENAI_API_KEY ?? "";
		this.refreshToken = opts?.refreshToken ?? "";
		this.accountId = opts?.accountId;
		if (!this.authToken) {
			console.warn(
				"OpenAIResponsesCompatibleProvider: no OpenAI credential configured. Calls will fail.",
			);
		}
		this.model = model ?? "gpt-4o";
	}

	async execute(request: AgentRequest): Promise<AgentResult> {
		const sessionId = request.resumeSessionId ?? ulid();
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

	private async *runLoop(
		request: AgentRequest,
		sessionId: string,
		queue?: MessageQueue,
	): AsyncGenerator<Event, AgentResult> {
		void this.refreshToken;
		const adapter = createOpenAIResponsesAdapter(
			this.baseUrl,
			this.authToken,
			this.accountId,
			{ maxRetries: this.maxRetries },
		);
		const effectiveRequest = {
			...request,
			model: request.model ?? this.model,
		};
		return yield* runProviderLoop(adapter, effectiveRequest, sessionId, queue);
	}
}
