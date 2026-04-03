import Anthropic from "@anthropic-ai/sdk";
import type {
	MessageParam,
	TextBlockParam,
	Tool,
	ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type { AgentProvider, AgentRequest } from "./agent-provider.ts";
import { DEFAULT_MODEL } from "./config.ts";
import {
	type AssistantContent,
	type ConsumedMessages,
	type EventImageData,
	type ToolResultData,
	walkEventsToMessages,
} from "./event-converter.ts";
import type { Event } from "./events.ts";
import { MessageQueue } from "./message-queue.ts";
import {
	extractQueueImages,
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
	ttl?: "5m" | "1h",
): MessageParam[] {
	if (messages.length === 0) return messages;

	// Last message is always a user message (tool_results are in user role).
	// Anthropic's lookback caches all preceding history from this breakpoint.
	const lastIdx = messages.length - 1;

	// Build cache_control value — include ttl only when explicitly set
	const cacheControl = ttl
		? ({ type: "ephemeral" as const, ttl } as const)
		: ({ type: "ephemeral" as const } as const);

	return messages.map((msg, i) => {
		if (i !== lastIdx) return msg;

		const content = msg.content;
		if (typeof content === "string") {
			// Convert string content to array with cache_control
			return {
				...msg,
				content: [
					{
						type: "text" as const,
						text: content,
						cache_control: cacheControl,
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
					{ ...last, cache_control: cacheControl },
				];
				return { ...msg, content: updatedContent };
			}
		}

		return msg;
	});
}

// ── Anthropic Event Converter ──

/** Build an Anthropic image block from event image data. */
function anthropicImageBlock(img: EventImageData): unknown {
	return {
		type: "image",
		source: { type: "base64", media_type: img.mediaType, data: img.base64 },
	};
}

/** Check if last message is a user message containing tool_result blocks (working context). */
function isAnthropicWorkingContext(messages: unknown[]): boolean {
	const lastMsg = messages[messages.length - 1] as
		| { role: string; content: unknown }
		| undefined;
	return (
		lastMsg?.role === "user" &&
		Array.isArray(lastMsg.content) &&
		(lastMsg.content as unknown[]).some(
			(b) =>
				b &&
				typeof b === "object" &&
				(b as Record<string, unknown>).type === "tool_result",
		)
	);
}

/**
 * Reconstruct Anthropic-format messages from JSONL events.
 * Uses the shared event walker with Anthropic-specific callbacks.
 * @internal Exported for testing
 */
export function eventsToAnthropicMessages(events: Event[]): unknown[] {
	return walkEventsToMessages(events, {
		onUserMessage(content: string): unknown {
			return { role: "user", content };
		},

		onAssistantContent(content: AssistantContent): unknown {
			const blocks: unknown[] = [];
			// Use ordered items to preserve interleaved thinking/text/tool_call sequence
			for (const item of content.items) {
				if (item.type === "thinking") {
					blocks.push({
						type: "thinking",
						thinking: item.thinking,
						signature: item.signature,
					});
				} else if (item.type === "text") {
					blocks.push({ type: "text", text: item.text });
				} else {
					blocks.push({
						type: "tool_use",
						id: item.call.id,
						name: item.call.name,
						input: item.call.input,
						caller: { type: "direct" },
					});
				}
			}
			// Defensive: ensure content array is never empty (causes Anthropic 400)
			if (blocks.length === 0) {
				console.warn(
					"[event-converter] Empty assistant content blocks — inserting (empty) fallback",
				);
				blocks.push({ type: "text", text: "(empty)" });
			}
			return { role: "assistant", content: blocks };
		},

		onToolResults(
			results: ToolResultData[],
			interleaved: Array<{ type: "text"; text: string }>,
			queueImages: EventImageData[],
		): unknown[] {
			const resultBlocks: unknown[] = [];

			for (const result of results) {
				if (result.images && result.images.length > 0) {
					const contentParts: unknown[] = [];
					for (const img of result.images) {
						contentParts.push(anthropicImageBlock(img));
					}
					contentParts.push({
						type: "text",
						text: result.content || "(empty)",
					});
					resultBlocks.push({
						type: "tool_result",
						tool_use_id: result.toolCallId,
						content: contentParts,
					});
				} else {
					resultBlocks.push({
						type: "tool_result",
						tool_use_id: result.toolCallId,
						content: result.content || "(empty)",
						is_error: result.isError,
					});
				}

				// NOTE: result.pending is metadata only — the pending section text is already
				// embedded in the tool_result content string. Don't add a separate text block
				// here or it will duplicate what's in content, causing prefix mismatch on resume.
			}

			// Add interleaved messages_consumed text blocks
			resultBlocks.push(...interleaved);

			// Defensive: ensure content array is never empty
			if (resultBlocks.length === 0) {
				console.warn(
					"[event-converter] Empty tool_result blocks — inserting (empty) fallback",
				);
				resultBlocks.push({ type: "text", text: "(empty)" });
			}

			if (queueImages.length > 0) {
				return [
					{
						role: "user",
						content: [
							...resultBlocks,
							...queueImages.map(anthropicImageBlock),
							{
								type: "text",
								text: `[${queueImages.length} image(s) attached by user]`,
							},
						],
					},
				];
			}
			return [{ role: "user", content: resultBlocks }];
		},

		onConsumedMessages(messages: unknown[], consumed: ConsumedMessages): void {
			const textBlocks = consumed.formattedTexts.map((t) => ({
				type: "text" as const,
				text: t,
			}));
			const imageBlocks = consumed.images.map(anthropicImageBlock);

			// In working context (last message has tool_results), append to it
			if (isAnthropicWorkingContext(messages)) {
				const lastMsg = messages[messages.length - 1] as
					| { role: string; content: unknown[] }
					| undefined;
				if (lastMsg && Array.isArray(lastMsg.content)) {
					(lastMsg.content as unknown[]).push(...textBlocks);
					if (imageBlocks.length > 0) {
						(lastMsg.content as unknown[]).push(...imageBlocks);
						(lastMsg.content as unknown[]).push({
							type: "text",
							text: `[${imageBlocks.length} image(s) attached by user]`,
						});
					}
					return;
				}
			}

			// Idle context — create new user message
			if (imageBlocks.length > 0) {
				messages.push({
					role: "user",
					content: [...textBlocks, ...imageBlocks],
				});
			} else if (textBlocks.length === 1) {
				messages.push({
					role: "user",
					content: textBlocks[0]?.text ?? "(empty)",
				});
			} else {
				messages.push({
					role: "user",
					content: textBlocks,
				});
			}
		},

		isWorkingContext: isAnthropicWorkingContext,
	});
}

// ── Anthropic Provider Adapter ──

/**
 * Create an Anthropic adapter for the unified run loop.
 * Encapsulates all Anthropic-specific API call format, streaming, caching, etc.
 */
function createAnthropicAdapter(
	client: Anthropic,
	useOAuth: boolean,
	opts?: {
		outerRetryDelayMs?: (attempt: number, error: unknown) => number;
		thinking?: { budgetTokens: number };
	},
): ProviderAdapter {
	return {
		getContextWindow(model: string): number {
			return getContextWindow(model);
		},

		getModelPricing(model: string) {
			return getModelPricing(model);
		},

		convertEventsToMessages(events: Event[]): unknown[] {
			return eventsToAnthropicMessages(events) as unknown[];
		},

		prepareTools(jsonTools: JsonTool[]): unknown[] {
			return jsonTools.map(
				(t) =>
					({
						name: t.name,
						description: t.description,
						input_schema: t.jsonSchema as Tool["input_schema"],
					}) satisfies Tool,
			);
		},

		async *callAPI(params) {
			const messages = params.messages as MessageParam[];
			const tools = params.tools as Tool[];

			// Cache control: all breakpoints use consistent TTL from session_config.
			// Root: "1h" (long-lived). Regular children: undefined (default 5min).
			// Anthropic requires longer TTLs before shorter TTLs in the same request.
			// With consistent TTL, all breakpoints use the same value — no ordering issues.
			const cacheControl = params.cacheTtl
				? ({ type: "ephemeral" as const, ttl: params.cacheTtl } as const)
				: ({ type: "ephemeral" as const } as const);

			// System prompt split into stable + variable for optimal caching.
			// Stable part is shared by ALL agents — auto-hits via Anthropic's 20-block lookback.
			// Variable part (role + date) gets its own cache breakpoint.
			// OAuth mode adds Claude Code preamble as a separate block.
			const { stable, variable } = params.systemPrompt;
			const systemBlocks: TextBlockParam[] = useOAuth
				? [
						{
							type: "text",
							text: "You are Claude Code, Anthropic's official CLI for Claude.",
							cache_control: cacheControl,
						},
						// Stable part — shared across all agents, auto-cached via lookback
						...(stable ? [{ type: "text" as const, text: stable }] : []),
						// Variable part — per-agent, gets its own cache breakpoint
						...(variable
							? [
									{
										type: "text" as const,
										text: variable,
										cache_control: cacheControl,
									},
								]
							: []),
					]
				: [
						// Stable part — shared across all agents, auto-cached via lookback
						...(stable ? [{ type: "text" as const, text: stable }] : []),
						// Variable part — per-agent, gets its own cache breakpoint
						{
							type: "text",
							text: variable || "(no variable prompt)",
							cache_control: cacheControl,
						},
					];

			// Cache control: add cache breakpoint on the last tool definition
			const toolsWithCache: Tool[] =
				tools.length > 0
					? tools.map((tool, i) =>
							i === tools.length - 1
								? { ...tool, cache_control: cacheControl }
								: tool,
						)
					: tools;

			// Cache control: add a cache breakpoint at the second-to-last user message.
			// Uses same TTL as system/tools for consistency.
			const messagesWithCache = addMessagesCacheControl(
				messages,
				params.cacheTtl,
			);

			const createParams = {
				model: params.model,
				max_tokens: params.maxTokens,
				system: systemBlocks,
				messages: messagesWithCache,
				tools: toolsWithCache,
				...(opts?.thinking
					? {
							thinking: {
								type: "enabled" as const,
								budget_tokens: opts.thinking.budgetTokens,
							},
						}
					: {}),
			} as Parameters<typeof client.messages.stream>[0];

			// Store sessionId on client object for test mock conversation keying.
			// The mock wrapper reads this; the real SDK ignores it (never serialized).
			// biome-ignore lint/suspicious/noExplicitAny: test-only side channel
			(client as any)._currentSessionId = params.sessionId ?? undefined;

			let response: Anthropic.Messages.Message | undefined;
			for (let attempt = 0; attempt < 5; attempt++) {
				try {
					// Build request options: abort signal only.
					// 1h cache TTL (extended-cache-ttl) is GA — no beta header needed.
					const requestOpts = params.signal
						? { signal: params.signal }
						: undefined;
					const stream = useOAuth
						? // biome-ignore lint/suspicious/noExplicitAny: beta types are compatible but not identical
							(client.beta.messages as any).stream(createParams, requestOpts)
						: client.messages.stream(createParams, requestOpts);

					// Stream text and thinking deltas to UI (throttled to ~12 yields/sec)
					let textBuffer = "";
					let thinkingBuffer = "";
					let lastFlushTime = Date.now();
					const TEXT_FLUSH_INTERVAL = 80;

					for await (const event of stream) {
						if (event.type === "content_block_delta" && !params.isCompacting) {
							const deltaType = (event.delta as { type?: string })?.type;
							if (deltaType === "text_delta") {
								textBuffer += (event.delta as { text: string }).text;
							} else if (deltaType === "thinking_delta") {
								thinkingBuffer += (event.delta as { thinking: string })
									.thinking;
							}
							const now = Date.now();
							if (now - lastFlushTime >= TEXT_FLUSH_INTERVAL) {
								if (thinkingBuffer) {
									yield {
										type: "thinking_delta" as const,
										thinking: thinkingBuffer,
										taskId: "",
										ts: Date.now(),
									};
									thinkingBuffer = "";
								}
								if (textBuffer) {
									yield {
										type: "text_delta" as const,
										content: textBuffer,
										taskId: "",
										ts: Date.now(),
									};
									textBuffer = "";
								}
								lastFlushTime = now;
							}
						}
					}
					if (thinkingBuffer) {
						yield {
							type: "thinking_delta" as const,
							thinking: thinkingBuffer,
							taskId: "",
							ts: Date.now(),
						};
					}
					if (textBuffer) {
						yield {
							type: "text_delta" as const,
							content: textBuffer,
							taskId: "",
							ts: Date.now(),
						};
					}
					response = await stream.finalMessage();
					break;
				} catch (e) {
					const isTransient =
						e instanceof Anthropic.RateLimitError ||
						e instanceof Anthropic.APIConnectionError ||
						e instanceof Anthropic.InternalServerError ||
						(e instanceof Anthropic.APIError && e.status === 529) ||
						// SSE stream errors (overloaded, etc.) have status=undefined
						(e instanceof Anthropic.APIError && e.status === undefined);
					if (!isTransient || attempt >= 4) throw e;
					const delay = Math.min(2000 * 2 ** attempt, 60000);
					yield {
						type: "error" as const,
						taskId: "",
						message: `API error (retry ${attempt + 1}/4): ${e.message}`,
						ts: Date.now(),
					};
					await new Promise((r) => setTimeout(r, delay));
				}
			}
			if (!response) throw new Error("Failed to get API response");
			return response;
		},

		getResponseText(response: unknown): string {
			const msg = response as Anthropic.Messages.Message;
			const texts: string[] = [];
			for (const block of msg.content) {
				if (block.type === "text") {
					texts.push(block.text);
				}
			}
			return texts.join("\n");
		},

		getToolUses(response: unknown): ProviderToolUse[] {
			const msg = response as Anthropic.Messages.Message;
			const result: ProviderToolUse[] = [];
			for (const block of msg.content) {
				if (block.type === "tool_use") {
					result.push({
						id: block.id,
						name: block.name,
						input: block.input as Record<string, unknown>,
					});
				}
			}
			return result;
		},

		getTokenUsage(response: unknown): ProviderTokenUsage {
			const msg = response as Anthropic.Messages.Message;
			const cacheCreation = msg.usage.cache_creation_input_tokens ?? 0;
			const cacheRead = msg.usage.cache_read_input_tokens ?? 0;
			// input_tokens is ONLY non-cached tokens; must include cache_read and
			// cache_creation to get the true context size for threshold comparison.
			const totalContextTokens =
				msg.usage.input_tokens + cacheCreation + cacheRead;
			return {
				inputTokens: msg.usage.input_tokens,
				outputTokens: msg.usage.output_tokens,
				totalContextTokens,
				cacheCreationTokens: cacheCreation,
				cacheReadTokens: cacheRead,
			};
		},

		getStopReason(response: unknown): "end_turn" | "tool_use" {
			const msg = response as Anthropic.Messages.Message;
			return msg.stop_reason === "end_turn" ? "end_turn" : "tool_use";
		},

		supportsTokenCounting: true,

		async countTokens(params) {
			const result = await client.messages.countTokens({
				model: params.model,
				system: [{ type: "text", text: params.system }],
				messages: params.messages as MessageParam[],
				tools: params.tools as Tool[],
			});
			return result.input_tokens;
		},

		buildResponseEvents(response: unknown, isCompacting: boolean): Event[] {
			const msg = response as Anthropic.Messages.Message;
			const events: Event[] = [];
			for (const block of msg.content) {
				if (block.type === "thinking") {
					events.push({
						type: "thinking",
						thinking: block.thinking,
						signature: block.signature,
						taskId: "",
						ts: Date.now(),
					});
				} else if (block.type === "text") {
					events.push({
						type: "assistant_text",
						content: block.text,
						taskId: "",
						ts: Date.now(),
					});
				} else if (block.type === "tool_use" && !isCompacting) {
					events.push({
						type: "tool_call",
						tool: block.name,
						toolCallId: block.id,
						input: block.input as Record<string, unknown>,
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
			_isCompacting: boolean,
		): void {
			const msg = response as Anthropic.Messages.Message;
			(messages as MessageParam[]).push({
				role: "assistant",
				content: msg.content,
			});
		},

		buildUserTurn(params): unknown[] {
			type ImageMediaType =
				| "image/jpeg"
				| "image/png"
				| "image/gif"
				| "image/webp";

			const toolResults: ToolResultBlockParam[] = [];
			for (let i = 0; i < params.toolUses.length; i++) {
				const toolUse = params.toolUses[i] as ProviderToolUse;
				const exec = params.execResults[i] as ToolResult;

				// Collect images from either direct imageData or MCP images.
				// Both go into tool_result content blocks: images first, then text.
				// This matches JSONL reconstruction order in onToolResults.
				const hasDirectImage = exec.isImage && exec.imageData && exec.mediaType;
				const hasMcpImages =
					!exec.formattedQueueMessages && exec.mcpImages?.length;

				if (hasDirectImage || hasMcpImages) {
					const contentParts: Array<
						| {
								type: "image";
								source: {
									type: "base64";
									media_type: ImageMediaType;
									data: string;
								};
						  }
						| { type: "text"; text: string }
					> = [];

					// Direct image (e.g. built-in read_file on an image)
					if (hasDirectImage) {
						contentParts.push({
							type: "image",
							source: {
								type: "base64",
								media_type: exec.mediaType as ImageMediaType,
								data: exec.imageData as string,
							},
						});
					}

					// MCP images (e.g. Chrome DevTools take_screenshot)
					if (hasMcpImages && exec.mcpImages) {
						for (const img of exec.mcpImages) {
							contentParts.push({
								type: "image",
								source: {
									type: "base64",
									media_type: img.mediaType as ImageMediaType,
									data: img.base64 ?? img.data ?? "",
								},
							});
						}
					}

					contentParts.push({ type: "text", text: exec.content });

					toolResults.push({
						type: "tool_result",
						tool_use_id: toolUse.id,
						content: contentParts,
					});
				} else {
					toolResults.push({
						type: "tool_result",
						tool_use_id: toolUse.id,
						content: exec.content,
						is_error: exec.isError,
					});
				}
			}

			// Collect queue text blocks and images from two sources:
			// 1. execResults[].formattedQueueMessages — from yield/done tool handlers
			// 2. params.queueMessages — from cancellation point or implicit yield
			const queueTextBlocks: Array<{ type: "text"; text: string }> = [];
			const queueImageBlocks: Array<{
				type: "image";
				source: {
					type: "base64";
					media_type: ImageMediaType;
					data: string;
				};
			}> = [];

			// Source 1: Queue messages embedded in tool execution results (yield/done)
			for (const exec of params.execResults) {
				if (exec.formattedQueueMessages) {
					// Keep as a single text block — must match JSONL reconstruction.
					queueTextBlocks.push({
						type: "text" as const,
						text: exec.formattedQueueMessages,
					});
					if (exec.mcpImages?.length) {
						for (const img of exec.mcpImages) {
							queueImageBlocks.push({
								type: "image" as const,
								source: {
									type: "base64" as const,
									media_type: img.mediaType as ImageMediaType,
									data: img.base64 ?? img.data ?? "",
								},
							});
						}
					}
				}
			}

			// Source 2: Raw queue messages — format each as its own text block.
			// Each message becomes a separate text block to match JSONL reconstruction,
			// which produces one text block per consumed message via formatEventForAI.
			if (params.queueMessages.length > 0) {
				for (const msg of params.queueMessages) {
					const text = formatQueueMessage(msg);
					if (text) {
						queueTextBlocks.push({
							type: "text" as const,
							text,
						});
					}
				}
				const imageBlocks = extractQueueImages(params.queueMessages);
				for (const img of imageBlocks) {
					queueImageBlocks.push(img);
				}
			}

			// Anthropic: single user message — tool_results first, then text, then images
			const userContentBlocks = [
				...toolResults,
				...queueTextBlocks,
				...queueImageBlocks,
				...(queueImageBlocks.length > 0
					? [
							{
								type: "text" as const,
								text: `[${queueImageBlocks.length} image(s) attached by user]`,
							},
						]
					: []),
			];

			// No tool results + no images + single text → string content (matches JSONL reconstruction)
			if (
				toolResults.length === 0 &&
				queueImageBlocks.length === 0 &&
				queueTextBlocks.length === 1
			) {
				return [
					{
						role: "user" as const,
						content: queueTextBlocks[0]?.text ?? "",
					},
				];
			}

			// No content at all → empty array (shouldn't happen in practice)
			if (userContentBlocks.length === 0) {
				return [];
			}

			return [
				{
					role: "user" as const,
					content: userContentBlocks as MessageParam["content"],
				},
			];
		},

		computeCost(
			model: string,
			totalInputTokens: number,
			totalOutputTokens: number,
			totalCacheCreationTokens: number,
			totalCacheReadTokens: number,
		): number {
			const { inputPer1M: ip, outputPer1M: op } = getModelPricing(model);
			// Anthropic API: input_tokens = non-cached tokens only (excludes cache_creation
			// and cache_read tokens — those are reported separately). Do NOT subtract them.
			return (
				(totalInputTokens * ip) / 1_000_000 +
				(totalCacheCreationTokens * ip * 1.25) / 1_000_000 +
				(totalCacheReadTokens * ip * 0.1) / 1_000_000 +
				(totalOutputTokens * op) / 1_000_000
			);
		},

		validateImage(base64: string, _mediaType: string) {
			// Anthropic rejects images where decoded byte size exceeds 5MB.
			// Use actual Buffer decode for exact byte count — no estimation.
			const MAX_BYTES = 5_242_880; // 5MB
			const byteLength = Buffer.from(base64, "base64").byteLength;
			if (byteLength > MAX_BYTES) {
				const sizeMB = (byteLength / 1_048_576).toFixed(1);
				return {
					ok: false as const,
					reason: `image size (${sizeMB} MB) exceeds Anthropic API limit (5.0 MB)`,
				};
			}
			return { ok: true as const };
		},

		getOuterRetryDelayMs: opts?.outerRetryDelayMs,

		buildResult(params): AgentResult {
			return {
				exitReason: params.exitReason,
				output: params.output,
				costUsd: params.costUsd,
				turns: params.turns,
				sessionId: params.sessionId,
				inputTokens: params.totalInputTokens,
				cacheCreationTokens: params.totalCacheCreationTokens,
				cacheReadTokens: params.totalCacheReadTokens,
				outputTokens: params.totalOutputTokens,
				doneSummary: params.doneSummary,
			};
		},
	};
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
	/** Extended thinking configuration. */
	private thinking?: { budgetTokens: number };
	/** Override outer retry delay for testing. Production uses default (30s+ exponential). */
	outerRetryDelayMs?: (attempt: number, error: unknown) => number;

	constructor(
		model?: string,
		opts?: {
			apiKey?: string;
			oauthToken?: string;
			thinking?: { budgetTokens: number };
		},
	) {
		const apiKey = opts?.apiKey ?? process.env.ANTHROPIC_API_KEY;
		const oauthToken = opts?.oauthToken ?? process.env.CLAUDE_CODE_OAUTH_TOKEN;
		this.useOAuth = Boolean(oauthToken && !apiKey);
		// 1 hour timeout — compaction with very large contexts under API load can be slow
		const timeout = 60 * 60 * 1000;
		if (this.useOAuth) {
			this.client = new Anthropic({
				authToken: oauthToken,
				timeout,
				defaultHeaders: {
					"anthropic-beta": "oauth-2025-04-20",
				},
			});
		} else if (apiKey) {
			this.client = new Anthropic({ apiKey, timeout });
		} else {
			this.client = new Anthropic({ timeout });
		}
		this.model = model ?? DEFAULT_MODEL;
		this.thinking = opts?.thinking;
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
		let lastResult: AgentResult = {
			exitReason: "interrupted",
			output: "",
			costUsd: 0,
			turns: 0,
			sessionId,
		};
		let result = await gen.next();
		while (!result.done) {
			result = await gen.next();
		}
		lastResult = result.value;
		return lastResult;
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
		const adapter = createAnthropicAdapter(this.client, this.useOAuth, {
			outerRetryDelayMs: this.outerRetryDelayMs,
			thinking: this.thinking,
		});
		// Override the default model in the request
		const effectiveRequest = {
			...request,
			model: request.model ?? this.model,
		};
		return yield* runProviderLoop(adapter, effectiveRequest, sessionId, queue);
	}
}
