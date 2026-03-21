import { randomUUID } from "node:crypto";
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
import { toRawMessage } from "./agent-tools.ts";
import { DEFAULT_MODEL } from "./config.ts";
import {
	type Event,
	eventsToAnthropicMessages,
	findOrphanedToolCalls,
} from "./events.ts";
import { MessageQueue, type QueueMessage } from "./message-queue.ts";
import {
	buildSummarizationInstruction,
	buildToolResultEvents,
	checkBudget,
	collectToolResultImages,
	DEFAULT_MAX_TOKENS,
	drainQueueAtCancellationPoint,
	executeToolUnified,
	extractQueueImages,
	getCompactionThresholds,
	handleImplicitYield,
	processCompaction,
	recordBudgetWarning,
	recordQueueEvents,
	zodShapeToJsonSchema,
} from "./provider-shared.ts";
import type { ToolDefinition } from "./tool-definition.ts";
import type { AgentResult } from "./types.ts";

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
				_cleanupBg(sessionId);
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

		// ── Event recording via EventStore (JSONL append-only) ──
		const eventStore = request.eventStore;

		// Load session from EventStore (survives daemon restart)
		let activeEvents = eventStore ? eventStore.readActive(sessionId) : [];
		const isResume = activeEvents.length > 0;

		// Fix orphaned tool_calls: persist synthetic tool_results to JSONL so the
		// fix survives future restarts (no repeated re-fixing on each resume)
		if (isResume && eventStore) {
			const orphanFixes = findOrphanedToolCalls(activeEvents);
			if (orphanFixes.length > 0) {
				await eventStore.appendBatch(sessionId, orphanFixes);
				activeEvents = [...activeEvents, ...orphanFixes];
			}
		}

		// Prepend working directory to the first user message (not on resume turns) so that
		// the system prompt stays identical across agents in different worktrees, enabling
		// Anthropic prompt caching to cache the system prompt once and share it across agents.
		const firstUserContent =
			cwd && !isResume
				? `Working directory: ${cwd}\n\n${request.prompt}`
				: request.prompt;

		// Reconstruct messages from EventStore on resume, or start fresh
		const messages: MessageParam[] = isResume
			? [
					...(eventsToAnthropicMessages(activeEvents) as MessageParam[]),
					{ role: "user" as const, content: request.prompt },
				]
			: [{ role: "user" as const, content: firstUserContent }];

		// Record the new user message event
		if (eventStore) {
			if (isResume) {
				eventStore.append(sessionId, {
					type: "message",
					content: request.prompt,
					isResume: true,
					ts: Date.now(),
				});
			} else {
				eventStore.append(sessionId, {
					type: "message",
					content: firstUserContent,
					cwd,
					ts: Date.now(),
				});
			}
		}

		// Add MCP tool definitions from mcpToolDefs
		const allTools: Tool[] = [..._TOOLS];
		// biome-ignore lint/suspicious/noExplicitAny: ToolDefinition generic varies
		const mcpHandlers = new Map<string, ToolDefinition<any>>();

		if (request.mcpToolDefs) {
			for (const [serverName, defs] of Object.entries(request.mcpToolDefs)) {
				for (const def of defs) {
					const toolName = `mcp__${serverName}__${def.name}`;
					mcpHandlers.set(toolName, def);

					// Use pre-computed JSON Schema if available (external MCP tools),
					// otherwise convert Zod schema
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

		let turns = 0;
		let totalInputTokens = 0;
		let totalOutputTokens = 0;
		let totalCacheCreationTokens = 0;
		let totalCacheReadTokens = 0;
		let estimatedInputTokens = 0;
		let lastText = "";
		let manualCompactRequested = false;
		let compactionPending = false;
		let preCompactTokenCount = 0;
		yield { type: "status", message: `Starting agent loop (model: ${model})` };

		while (true) {
			// Check abort signal
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
					} else if (Array.isArray(content)) {
						responseText = content
							.filter(
								(b): b is { type: "text"; text: string } =>
									typeof b === "object" &&
									b !== null &&
									"type" in b &&
									b.type === "text",
							)
							.map((b) => b.text)
							.join("\n");
					}
				}

				const compactGen = processCompaction(
					responseText,
					cwd,
					preCompactTokenCount,
					eventStore,
					sessionId,
					contextWindow,
					compressThreshold,
				);
				let compactStep = await compactGen.next();
				while (!compactStep.done) {
					yield compactStep.value;
					compactStep = await compactGen.next();
				}
				const compactResult = compactStep.value;

				if (compactResult) {
					messages.length = 0;
					messages.push({
						role: "user" as const,
						content: compactResult.userContent,
					});
					estimatedInputTokens = compactResult.estimatedInputTokens;
					manualCompactRequested = false;
				}
				continue; // Skip normal processing, go to next API call with rebuilt context
			}

			// ── Pre-call compression: count tokens, inject summarization instruction if over threshold ──
			if (manualCompactRequested && messages.length <= 4) {
				yield { type: "status", message: "Context is too short to compact" };
				yield { type: "compact_started" };
				yield {
					type: "compact",
					checkpoint: "Context too short for meaningful compaction",
					savedTokens: 0,
				};
				manualCompactRequested = false;
				continue;
			}
			if (messages.length > 4) {
				let tokenCount = estimatedInputTokens;
				let isEstimated = true;

				if (
					manualCompactRequested ||
					estimatedInputTokens >= lazyCountThreshold
				) {
					if (!manualCompactRequested) {
						const result = await this.client.messages.countTokens({
							model,
							system: [{ type: "text", text: request.systemPrompt ?? "" }],
							messages,
							tools: allTools,
						});
						tokenCount = result.input_tokens;
						isEstimated = false;
					}
				}

				if (
					manualCompactRequested ||
					(!isEstimated && tokenCount > compressThreshold)
				) {
					yield { type: "compact_started" };
					yield {
						type: "status",
						message: manualCompactRequested
							? "Manual compaction triggered"
							: `Compressing conversation (${tokenCount} tokens, threshold: ${compressThreshold})`,
					};
					// Inject summarization instruction as a user message instead of making a separate API call
					const summarizationInstruction = buildSummarizationInstruction(cwd);
					messages.push({
						role: "user" as const,
						content: summarizationInstruction,
					});
					if (eventStore) {
						eventStore.append(sessionId, {
							type: "summarization_request",
							instruction: summarizationInstruction,
							ts: Date.now(),
						});
					}
					compactionPending = true;
					preCompactTokenCount = tokenCount;
					// Fall through to the normal API call — the model will generate the checkpoint
				}
			}

			turns++;

			const systemParts = [request.systemPrompt].filter(Boolean);

			// Cache control: system prompt cached as array of TextBlockParam
			// OAuth tokens require the Claude Code identity prefix in the system prompt.
			const systemText = systemParts.join("\n\n");
			const systemBlocks: TextBlockParam[] = this.useOAuth
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
			const systemWithCache: TextBlockParam[] = systemBlocks;

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
					const stream = this.useOAuth
						? // biome-ignore lint/suspicious/noExplicitAny: beta types are compatible but not identical
							(this.client.beta.messages as any).stream(createParams)
						: this.client.messages.stream(createParams);

					// Stream text deltas to UI (throttled to ~12 yields/sec)
					let textBuffer = "";
					let lastFlushTime = Date.now();
					const TEXT_FLUSH_INTERVAL = 80;

					for await (const event of stream) {
						if (
							event.type === "content_block_delta" &&
							(event.delta as { type?: string })?.type === "text_delta" &&
							!compactionPending
						) {
							textBuffer += (event.delta as { text: string }).text;
							const now = Date.now();
							if (now - lastFlushTime >= TEXT_FLUSH_INTERVAL) {
								yield {
									type: "text_delta" as const,
									content: textBuffer,
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
					// Yield consolidated text event for persistence (text_delta is not persisted)
					if (!compactionPending && block.text) {
						yield { type: "text" as const, content: block.text };
					}
				} else if (block.type === "tool_use") {
					if (!compactionPending) {
						toolUses.push(block);
						yield {
							type: "tool_use",
							tool: block.name,
							toolUseId: block.id,
							input: block.input as Record<string, unknown>,
						};
					}
					// Skip tool uses during compaction — we only want the text checkpoint
				}
			}

			// Add assistant message to history
			messages.push({ role: "assistant", content: response.content });
			// Record individual Events for each content block
			if (eventStore) {
				const contentEvents: Event[] = [];
				for (const block of response.content) {
					if (block.type === "text") {
						contentEvents.push({
							type: "assistant_text",
							content: block.text,
							ts: Date.now(),
						});
					} else if (block.type === "tool_use") {
						contentEvents.push({
							type: "tool_call",
							tool: block.name,
							toolCallId: block.id,
							input: block.input as Record<string, unknown>,
							ts: Date.now(),
						});
					}
				}
				eventStore.appendBatch(sessionId, contentEvents);
			}

			// If compaction is pending, skip tool execution and continue to next iteration
			// where the checkpoint will be extracted and context rebuilt
			if (compactionPending) {
				continue;
			}

			// If no tool use, handle end_turn — enter implicit yield
			if (response.stop_reason === "end_turn" || toolUses.length === 0) {
				if (!queue) {
					// No queue — cannot yield, just exit
					yield {
						type: "status",
						message: "Agent ended turn (no queue for yield)",
					};
					break;
				}

				yield {
					type: "status",
					message:
						"Agent ended turn — entering idle state (waiting for messages)",
				};

				const yieldGen = handleImplicitYield(queue);
				let yieldStep = await yieldGen.next();
				while (!yieldStep.done) {
					yield yieldStep.value;
					yieldStep = await yieldGen.next();
				}
				const yieldResult = yieldStep.value;

				if (yieldResult === null) {
					// Queue closed — normal exit path (stop was called or done() was called).
					// Use direct return instead of break (break hangs in Bun async generators
					// under certain conditions with concurrent I/O).
					const { inputPer1M: ip, outputPer1M: op } = getModelPricing(model);
					return {
						success: true,
						output: lastText,
						costUsd:
							(totalInputTokens * ip) / 1_000_000 +
							(totalCacheCreationTokens * ip * 1.25) / 1_000_000 +
							(totalCacheReadTokens * ip * 0.1) / 1_000_000 +
							(totalOutputTokens * op) / 1_000_000,
						turns,
						sessionId,
						inputTokens: totalInputTokens,
						cacheCreationTokens: totalCacheCreationTokens,
						cacheReadTokens: totalCacheReadTokens,
						outputTokens: totalOutputTokens,
					};
				}

				if (yieldResult.manualCompactRequested) {
					manualCompactRequested = true;
				}
				if (yieldResult.compactOnly) {
					continue;
				}

				// Inject messages as a new user turn and continue the loop
				const { formatted, nonCompact } = yieldResult;
				const imageBlocks = extractQueueImages(nonCompact);
				if (imageBlocks.length > 0) {
					messages.push({
						role: "user" as const,
						content: [
							{
								type: "text" as const,
								text: `[Messages received while you were idle:]\n${formatted}`,
							},
							...imageBlocks,
						],
					});
				} else {
					messages.push({
						role: "user" as const,
						content: `[Messages received while you were idle:]\n${formatted}`,
					});
				}
				// Record queue events and messages_consumed
				if (eventStore) {
					recordQueueEvents(eventStore, sessionId, nonCompact);
				}
				continue;
			}

			// Execute tools concurrently
			const execResults = await Promise.all(
				toolUses.map((toolUse) =>
					executeToolUnified(
						toolUse.name,
						toolUse.input as Record<string, unknown>,
						mcpHandlers,
						cwd,
						request.cwd,
						sessionId,
						queue,
					),
				),
			);

			// Emit tool_result events and build API result array
			type ImageMediaType =
				| "image/jpeg"
				| "image/png"
				| "image/gif"
				| "image/webp";
			const toolResults: ToolResultBlockParam[] = [];
			for (let i = 0; i < toolUses.length; i++) {
				const toolUse = toolUses[i] as ToolUseBlock;
				const exec = execResults[i] as (typeof execResults)[number];

				// Update cwd if bash tool changed it
				if (exec.cwd) {
					cwd = exec.cwd;
				}

				const text = exec.content;
				const isError = exec.isError;

				const images = collectToolResultImages(exec);

				yield {
					type: "tool_result",
					tool: toolUse.name,
					toolUseId: toolUse.id,
					content: text.slice(0, 500),
					isError,
					...(images.length > 0 ? { images } : {}),
					...(exec._consumedMessageIds?.length
						? { _consumedMessageIds: exec._consumedMessageIds }
						: {}),
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
									media_type: exec.mediaType as ImageMediaType,
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

			// Cancellation point: drain queue and add messages as text blocks alongside tool results
			let cancellationQueueMsgs: QueueMessage[] = [];
			const cancellationTextBlocks: Array<{ type: "text"; text: string }> = [];
			const cancellationImageBlocks: ReturnType<typeof extractQueueImages> = [];
			if (queue) {
				const drained = drainQueueAtCancellationPoint(queue);
				if (drained) {
					if (drained.manualCompactRequested) {
						manualCompactRequested = true;
					}
					if (drained.messages.length > 0) {
						cancellationTextBlocks.push({
							type: "text" as const,
							text: `[Messages received while you were working:]\n${drained.formatted}`,
						});
						cancellationImageBlocks.push(
							...extractQueueImages(drained.messages),
						);
						cancellationQueueMsgs = drained.messages;
						yield {
							type: "queue_message",
							messages: drained.formatted,
							rawMessages: drained.messages.map(toRawMessage),
						};
					}
				}
			}

			// Collect formatted queue messages from yield/done tools (separate from tool_result content)
			const yieldQueueTextBlocks: Array<{ type: "text"; text: string }> = [];
			const yieldQueueImageBlocks: Array<{
				type: "image";
				data: string;
				mimeType: string;
			}> = [];
			for (const exec of execResults) {
				if (exec._formattedQueueMessages) {
					yieldQueueTextBlocks.push({
						type: "text" as const,
						text: `[Messages received while you were idle:]\n${exec._formattedQueueMessages}`,
					});
					// Images from yield/done are in mcpImages when _formattedQueueMessages is set
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

			// Add tool results to history — queue messages as separate text/image blocks
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
			messages.push({
				role: "user" as const,
				content: userContentBlocks as MessageParam["content"],
			});

			// Record individual tool_result Events
			if (eventStore) {
				const toolEvents = buildToolResultEvents(
					toolUses.map((tu) => ({ id: tu.id })),
					execResults,
					cancellationQueueMsgs,
				);
				eventStore.appendBatch(sessionId, toolEvents);
			}

			// If queue was closed during tool execution (done() was called),
			// exit after recording events but before sending results to the API.
			if (queue?.isClosed) {
				const { inputPer1M: ip, outputPer1M: op } = getModelPricing(model);
				const exitCost =
					(totalInputTokens * ip) / 1_000_000 +
					(totalCacheCreationTokens * ip * 1.25) / 1_000_000 +
					(totalCacheReadTokens * ip * 0.1) / 1_000_000 +
					(totalOutputTokens * op) / 1_000_000;
				return {
					success: true,
					output: lastText,
					costUsd: exitCost,
					turns,
					sessionId,
					inputTokens: totalInputTokens,
					cacheCreationTokens: totalCacheCreationTokens,
					cacheReadTokens: totalCacheReadTokens,
					outputTokens: totalOutputTokens,
				};
			}

			// Budget check: compute running cost and warn the agent if approaching limit
			if (request.budgetUsd && request.budgetUsd > 0) {
				const { inputPer1M, outputPer1M } = getModelPricing(model);
				const runningCost =
					(totalInputTokens * inputPer1M) / 1_000_000 +
					(totalCacheCreationTokens * inputPer1M * 1.25) / 1_000_000 +
					(totalCacheReadTokens * inputPer1M * 0.1) / 1_000_000 +
					(totalOutputTokens * outputPer1M) / 1_000_000;
				const budgetResult = checkBudget(request.budgetUsd, runningCost);
				if (budgetResult) {
					messages.push({
						role: "user" as const,
						content: budgetResult.warning,
					});
					recordBudgetWarning(eventStore, sessionId, budgetResult.warning);
					yield { type: "status", message: budgetResult.warning };
				}
			}
		}

		// Deterministic verification: compare reconstructed messages from Events
		if (eventStore) {
			const activeEvents = eventStore.readActive(sessionId);
			if (activeEvents.length > 0) {
				const reconstructed = eventsToAnthropicMessages(activeEvents);
				const match =
					JSON.stringify(messages) === JSON.stringify(reconstructed);
				if (!match) {
					console.error("[EVENTS MISMATCH]", {
						messagesLen: messages.length,
						eventsLen: activeEvents.length,
						reconstructedLen: reconstructed.length,
					});
				}
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

		return {
			success: true,
			output: lastText,
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
