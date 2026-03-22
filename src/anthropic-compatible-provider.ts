import Anthropic from "@anthropic-ai/sdk";
import type {
	MessageParam,
	TextBlockParam,
	Tool,
	ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type {
	AgentProvider,
	AgentRequest,
	AgentSession,
} from "./agent-provider.ts";
import { DEFAULT_MODEL } from "./config.ts";
import { type Event, formatPendingSection } from "./events.ts";
import { MessageQueue } from "./message-queue.ts";
import {
	type AssistantContent,
	type ConsumedMessages,
	type EventImageData,
	extractQueueImages,
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

// ── Re-exports from provider-shared.ts for backward compatibility ──
export {
	buildCompactedContext,
	buildSummarizationInstruction,
	extractCheckpoint,
	getCompactionThresholds,
	SUMMARIZATION_INSTRUCTION,
	zodShapeToJsonSchema,
} from "./provider-shared.ts";

export type { BackgroundProcess } from "./tools/index.ts";
// ── Re-exports from extracted tool modules ──
// These were extracted from this file; re-exported to preserve backward compatibility.
export {
	backgroundProcesses,
	cleanupSessionBackgroundProcesses,
	executeBashWithTimeout,
	executeTool,
	getBackgroundStatus,
	getRunningBackgroundCount,
	getRunningBackgroundSummary,
	getSessionBackgroundProcesses,
	jsSearch,
	killBackgroundProcess,
	resolvePath,
	TOOLS,
	truncateSearchOutput,
} from "./tools/index.ts";

import {
	cleanupSessionBackgroundProcesses as _cleanupBg,
	TOOLS as _TOOLS,
} from "./tools/index.ts";

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

// ── Anthropic Event Converter ──

/** Build an Anthropic image block from event image data. */
function anthropicImageBlock(img: EventImageData): unknown {
	return {
		type: "image",
		source: { type: "base64", media_type: img.mediaType, data: img.base64 },
	};
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
			for (const text of content.texts) {
				blocks.push({ type: "text", text });
			}
			for (const tc of content.toolCalls) {
				blocks.push({
					type: "tool_use",
					id: tc.id,
					name: tc.name,
					input: tc.input,
					caller: { type: "direct" },
				});
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
						text: result.content ?? "(empty)",
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
						content: result.content ?? "(empty)",
						is_error: result.isError,
					});
				}

				if (result.pending) {
					resultBlocks.push({
						type: "text",
						text: formatPendingSection(result.pending),
					});
				}
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
			const wrapper = consumed.isWorkingContext
				? "[Messages received while you were working:]"
				: "[Messages received while you were idle:]";
			const text = `${wrapper}\n${consumed.formattedTexts.join("\n")}`;
			const imageBlocks = consumed.images.map(anthropicImageBlock);

			if (consumed.isWorkingContext) {
				const lastMsg = messages[messages.length - 1] as
					| { role: string; content: unknown[] }
					| undefined;
				if (lastMsg && Array.isArray(lastMsg.content)) {
					(lastMsg.content as unknown[]).push({ type: "text", text });
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

			if (imageBlocks.length > 0) {
				messages.push({
					role: "user",
					content: [{ type: "text", text }, ...imageBlocks],
				});
			} else {
				messages.push({ role: "user", content: text });
			}
		},

		isWorkingContext(messages: unknown[]): boolean {
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
		},

		fixOrphans: fixOrphanedAnthropicToolUse,
	});
}

/**
 * Detect and fix orphaned tool_use blocks in Anthropic message arrays.
 * Scans ALL assistant messages for tool_use blocks without matching
 * tool_result blocks in the following user message.
 */
function fixOrphanedAnthropicToolUse(messages: unknown[]): void {
	for (let mi = messages.length - 1; mi >= 0; mi--) {
		const msg = messages[mi] as { role?: string; content?: unknown[] };
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

		const toolUseIds: string[] = [];
		for (const block of msg.content) {
			if (
				block &&
				typeof block === "object" &&
				(block as Record<string, unknown>).type === "tool_use"
			) {
				toolUseIds.push((block as Record<string, unknown>).id as string);
			}
		}
		if (toolUseIds.length === 0) continue;

		const nextMsg = messages[mi + 1] as
			| { role?: string; content?: unknown[] }
			| undefined;
		const existingResultIds = new Set<string>();
		if (nextMsg?.role === "user" && Array.isArray(nextMsg.content)) {
			for (const block of nextMsg.content) {
				if (
					block &&
					typeof block === "object" &&
					(block as Record<string, unknown>).type === "tool_result"
				) {
					existingResultIds.add(
						(block as Record<string, unknown>).tool_use_id as string,
					);
				}
			}
		}

		const orphanedIds = toolUseIds.filter((id) => !existingResultIds.has(id));
		if (orphanedIds.length === 0) continue;

		console.warn(
			"[event-converter] Orphaned tool_use blocks found at message index",
			mi,
			"- ids:",
			orphanedIds,
		);

		const syntheticResults: unknown[] = orphanedIds.map((id) => ({
			type: "tool_result",
			tool_use_id: id,
			content:
				"Tool execution was interrupted by daemon restart. Results were lost.",
			is_error: true,
		}));

		if (nextMsg?.role === "user" && Array.isArray(nextMsg.content)) {
			(nextMsg.content as unknown[]).push(...syntheticResults);
		} else {
			messages.splice(mi + 1, 0, {
				role: "user",
				content: syntheticResults,
			});
		}
	}
}

// ── Anthropic Provider Adapter ──

/**
 * Create an Anthropic adapter for the unified run loop.
 * Encapsulates all Anthropic-specific API call format, streaming, caching, etc.
 */
function createAnthropicAdapter(
	client: Anthropic,
	useOAuth: boolean,
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

		prepareTools(
			// biome-ignore lint/suspicious/noExplicitAny: ToolDefinition generic varies
			mcpToolDefs: Record<string, ToolDefinition<any>[]> | undefined,
			// biome-ignore lint/suspicious/noExplicitAny: ToolDefinition generic varies
			mcpHandlers: Map<string, ToolDefinition<any>>,
		): unknown[] {
			const allTools: Tool[] = [..._TOOLS];
			if (mcpToolDefs) {
				for (const [serverName, defs] of Object.entries(mcpToolDefs)) {
					for (const def of defs) {
						const toolName = `mcp__${serverName}__${def.name}`;
						mcpHandlers.set(toolName, def);
						const jsonSchema =
							def.jsonSchema ?? zodShapeToJsonSchema(def.inputSchema);
						allTools.push({
							name: toolName,
							description: def.description,
							input_schema: jsonSchema as Tool["input_schema"],
						});
					}
				}
			}
			return allTools;
		},

		async *callAPI(params) {
			const messages = params.messages as MessageParam[];
			const tools = params.tools as Tool[];

			// Cache control: system prompt cached as array of TextBlockParam
			const systemText = params.systemPrompt;
			const systemBlocks: TextBlockParam[] = useOAuth
				? [
						{
							type: "text",
							text: "You are Claude Code, Anthropic's official CLI for Claude.",
							cache_control: { type: "ephemeral" },
						},
						...(systemText
							? [
									{
										type: "text" as const,
										text: systemText,
										cache_control: {
											type: "ephemeral" as const,
										},
									},
								]
							: []),
					]
				: [
						{
							type: "text",
							text: systemText,
							cache_control: { type: "ephemeral" },
						},
					];

			// Cache control: add cache breakpoint on the last tool definition
			const toolsWithCache: Tool[] =
				tools.length > 0
					? tools.map((tool, i) =>
							i === tools.length - 1
								? { ...tool, cache_control: { type: "ephemeral" } }
								: tool,
						)
					: tools;

			// Cache control: add a cache breakpoint at the second-to-last user message
			const messagesWithCache = addMessagesCacheControl(messages);

			const createParams = {
				model: params.model,
				max_tokens: params.maxTokens,
				system: systemBlocks,
				messages: messagesWithCache,
				tools: toolsWithCache,
			};

			let response: Anthropic.Messages.Message | undefined;
			for (let attempt = 0; attempt < 5; attempt++) {
				try {
					const stream = useOAuth
						? // biome-ignore lint/suspicious/noExplicitAny: beta types are compatible but not identical
							(client.beta.messages as any).stream(createParams)
						: client.messages.stream(createParams);

					// Stream text deltas to UI (throttled to ~12 yields/sec)
					let textBuffer = "";
					let lastFlushTime = Date.now();
					const TEXT_FLUSH_INTERVAL = 80;

					for await (const event of stream) {
						if (
							event.type === "content_block_delta" &&
							(event.delta as { type?: string })?.type === "text_delta" &&
							!params.isCompacting
						) {
							textBuffer += (event.delta as { text: string }).text;
							const now = Date.now();
							if (now - lastFlushTime >= TEXT_FLUSH_INTERVAL) {
								yield {
									type: "text_delta" as const,
									content: textBuffer,
									ts: Date.now(),
								};
								textBuffer = "";
								lastFlushTime = now;
							}
						}
					}
					if (textBuffer) {
						yield {
							type: "text_delta" as const,
							content: textBuffer,
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
				if (block.type === "text") {
					events.push({
						type: "assistant_text",
						content: block.text,
						ts: Date.now(),
					});
				} else if (block.type === "tool_use" && !isCompacting) {
					events.push({
						type: "tool_call",
						tool: block.name,
						toolCallId: block.id,
						input: block.input as Record<string, unknown>,
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

		buildToolResultsMessage(params): unknown[] {
			type ImageMediaType =
				| "image/jpeg"
				| "image/png"
				| "image/gif"
				| "image/webp";

			const toolResults: ToolResultBlockParam[] = [];
			for (let i = 0; i < params.toolUses.length; i++) {
				const toolUse = params.toolUses[i] as ProviderToolUse;
				const exec = params.execResults[i] as ToolExecResult;

				if (exec.isImage && exec.imageData && exec.mediaType) {
					toolResults.push({
						type: "tool_result",
						tool_use_id: toolUse.id,
						content: [
							{
								type: "image",
								source: {
									type: "base64",
									media_type: exec.mediaType as ImageMediaType,
									data: exec.imageData,
								},
							},
							{ type: "text", text: exec.content },
						],
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

			// Collect formatted queue messages from yield/done tools
			const yieldQueueTextBlocks: Array<{ type: "text"; text: string }> = [];
			const yieldQueueImageBlocks: Array<{
				type: "image";
				data: string;
				mimeType: string;
			}> = [];
			for (const exec of params.execResults) {
				if (exec._formattedQueueMessages) {
					yieldQueueTextBlocks.push({
						type: "text" as const,
						text: `[Messages received while you were idle:]\n${exec._formattedQueueMessages}`,
					});
					if (exec.mcpImages?.length) {
						for (const img of exec.mcpImages) {
							yieldQueueImageBlocks.push({
								type: "image",
								data: img.base64 ?? img.data ?? "",
								mimeType: img.mediaType,
							});
						}
					}
				}
			}

			// Build cancellation blocks
			const cancellationTextBlocks: Array<{ type: "text"; text: string }> = [];
			const cancellationImageBlocks = extractQueueImages(
				params.cancellationQueueMsgs,
			);
			if (
				params.cancellationQueueMsgs.length > 0 &&
				params.cancellationFormatted
			) {
				cancellationTextBlocks.push({
					type: "text" as const,
					text: `[Messages received while you were working:]\n${params.cancellationFormatted}`,
				});
			}

			// Anthropic user message content can mix tool_result, text, and image blocks
			const userContentBlocks = [
				...toolResults,
				...yieldQueueTextBlocks,
				...yieldQueueImageBlocks.map((img) => ({
					type: "image" as const,
					source: {
						type: "base64" as const,
						media_type: img.mimeType as ImageMediaType,
						data: img.data,
					},
				})),
				...(yieldQueueImageBlocks.length > 0
					? [
							{
								type: "text" as const,
								text: `[${yieldQueueImageBlocks.length} image(s) attached by user]`,
							},
						]
					: []),
				...cancellationTextBlocks,
				...cancellationImageBlocks,
				...(cancellationImageBlocks.length > 0
					? [
							{
								type: "text" as const,
								text: `[${cancellationImageBlocks.length} image(s) attached by user]`,
							},
						]
					: []),
			];

			return [
				{
					role: "user" as const,
					content: userContentBlocks as MessageParam["content"],
				},
			];
		},

		buildImplicitYieldMessage(formatted: string, nonCompact) {
			const imageBlocks = extractQueueImages(nonCompact);
			if (imageBlocks.length > 0) {
				return {
					role: "user" as const,
					content: [
						{
							type: "text" as const,
							text: `[Messages received while you were idle:]\n${formatted}`,
						},
						...imageBlocks,
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

		buildResult(params): AgentResult {
			return {
				success: params.success,
				output: params.output,
				costUsd: params.costUsd,
				turns: params.turns,
				sessionId: params.sessionId,
				inputTokens: params.totalInputTokens,
				cacheCreationTokens: params.totalCacheCreationTokens,
				cacheReadTokens: params.totalCacheReadTokens,
				outputTokens: params.totalOutputTokens,
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

	constructor(model?: string, opts?: { apiKey?: string; oauthToken?: string }) {
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
		let lastResult: AgentResult = { success: false, output: "", sessionId };
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
				_cleanupBg(sessionId);
			},
		};
	}

	private async *runLoop(
		request: AgentRequest,
		sessionId: string,
		queue?: MessageQueue,
	): AsyncGenerator<Event, AgentResult> {
		const adapter = createAnthropicAdapter(this.client, this.useOAuth);
		// Override the default model in the request
		const effectiveRequest = {
			...request,
			model: request.model ?? this.model,
		};
		return yield* runProviderLoop(adapter, effectiveRequest, sessionId, queue);
	}
}
