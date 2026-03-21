import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
import { formatQueueMessage, toRawMessage } from "./agent-tools.ts";
import { DEFAULT_MODEL } from "./config.ts";
import {
	type Event,
	eventsToAnthropicMessages,
	queueMessageToEvent,
} from "./events.ts";
import { MessageQueue, type QueueMessage } from "./message-queue.ts";
import type { ToolDefinition } from "./tool-definition.ts";
import type { AgentResult } from "./types.ts";

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

/** Summarization instruction injected as a user message for in-context compaction. */
export const SUMMARIZATION_INSTRUCTION = `[SYSTEM: Context compression required. Generate a checkpoint summary NOW.

Do NOT use any tools. Respond with ONLY the checkpoint in <summary>...</summary> tags.

Write the checkpoint with these sections IN ORDER. Every section is required.

## 1. User Requests (MOST CRITICAL)
Chronological timeline of every user message or parent instruction received, with the tasks created/completed in response to each. For each entry:
- The message (verbatim or close paraphrase)
- Tasks created in response (IDs, titles)
- Tasks completed/merged in response (what was accomplished)
- Decisions made or deferred
This creates a complete narrative thread. The resuming agent has NO access to previous messages — this is the only record.
For resolved requests, state the outcome concisely. Do not carry forward debugging narratives or step-by-step problem-solving details from issues that are fully resolved.

## 2. Current Phase
What the agent is doing RIGHT NOW: planning / implementing / testing / debugging / reviewing / orchestrating / done
If debugging: include the exact error message and what has been tried.

## 3. Completed Work
What has been built, tested, committed, and merged — with key architectural and technical decisions.
Include specific file paths and function names. Note WHY decisions were made, not just what.
Focus on outcomes and key decisions. Omit debugging journeys and error traces for issues already resolved.

## 4. Task Tree State
Current live task tree. Only tasks that currently exist (pending/in_progress/failed/draft). For each: ID, title, status, branch. Omit completed/merged tasks (they're recorded in Section 1's timeline). Group: Running → Failed → Pending → Draft.

## 5. Key Insights & Rejected Approaches
Design principles and mental models discovered during this session — especially from failed approaches.
Focus on HIGH-LEVEL insights that prevent entire CLASSES of bugs, not one-off technical fixes.

Good examples:
- "Auth should always be on — 'enforced' only controls registration, not authentication"
- "MCP and HTTP code paths must share implementation, not duplicate logic"
- "Cache invariant: all in-memory state is a cache of disk state — destroying and recreating it should be invisible"
- "Never split by step (types → implementation → tests) — split by module/feature for parallelism"

Bad examples (these belong in code comments, not in the checkpoint):
- "startRegistration(options) directly doesn't work, need {optionsJSON: options}"
- "Cookie secure:true doesn't work on HTTP localhost"
- "CDN path /v3/fonts returns 404, use /v2/fonts instead"

For each insight: state the principle, and briefly note what triggered the discovery.
If truly nothing was learned, write "None so far."

## 6. Key Context
Important state and knowledge that is HARD to reconstruct from disk:
- Constraints or invariants that affect the remaining work
- Environment or configuration state
- Communication state: pending clarifications, recent messages to/from parent or children

## 7. Pending Work
Numbered list of ALL remaining tasks/steps to complete the goal.
Be specific: "implement X in file Y", "add test for Z", "merge child branch A".

Rules:
- Be precise: file paths, function names, exact error messages, task IDs
- Do NOT repeat system prompt or task description content — the agent already has those
- Do NOT include file contents that can be re-read from disk
- Focus on context that is HARD to reconstruct: decisions, state, user intent, failures
- Include ALL user messages/requests — verbatim or close paraphrase, never summarize away
- Each user request must note: what was asked → what was done → what was the outcome
- Aim for thoroughness — lost context is far more expensive than a longer checkpoint
- Length: use as many tokens as needed for complex sessions. Never truncate mid-thought.
- On re-compaction, resolved issues need only their resolution noted — not the journey to get there. Retain useful architectural and decision context.]`;

/** Build the full summarization instruction with the current working directory appended. */
export function buildSummarizationInstruction(cwd?: string): string {
	if (!cwd) return SUMMARIZATION_INSTRUCTION;
	return `${SUMMARIZATION_INSTRUCTION}\n\nCurrent working directory: ${cwd}`;
}

/**
 * Extract checkpoint text from an assistant response that should contain <summary>...</summary> tags.
 * If no tags found, uses the full response text as the checkpoint.
 * When `cwd` is provided, appends a system-generated context block with the working directory
 * and resume instructions (these are injected by the system, not written by the AI).
 * @internal Exported for testing
 */
export function extractCheckpoint(responseText: string, cwd?: string): string {
	const match = responseText.match(/<summary>([\s\S]*?)<\/summary>/);
	let checkpoint: string;
	if (match && match[1] !== undefined) {
		checkpoint = match[1].trim();
	} else {
		// No summary tags found — use full response text as checkpoint
		checkpoint = responseText.trim();
	}

	if (cwd) {
		checkpoint += `\n\n---\n\n## System Context (auto-generated)\nWorking directory: ${cwd}\n\nResume from this checkpoint. Your task is NOT done unless the checkpoint says "Current Phase: done". Continue working — check get_tree, follow the stimulus priority, and drive to completion.\nDo not cd to your current working directory — you are already there.`;
	}

	return checkpoint;
}

/**
 * Build the compacted context message after checkpoint generation.
 * Combines task context, fresh memory, checkpoint, and recent transcript into a single user message.
 * @internal Exported for testing
 */
export async function buildCompactedContext(
	taskContext: string | undefined,
	checkpoint: string,
	cwd?: string,
): Promise<string> {
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

	const parts: string[] = [];
	if (taskContext) {
		parts.push(`## Original Task\n${taskContext}`);
	}
	if (freshMemory) {
		parts.push(`## Project Memory (fresh)\n${freshMemory}`);
	}
	parts.push(`## Checkpoint Summary\n\n${checkpoint}`);

	return parts.join("\n\n---\n\n");
}

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
	executeTool as _executeTool,
	TOOLS as _TOOLS,
} from "./tools/index.ts";

/**
 * Convert a Zod raw shape (from ToolDefinition.inputSchema) to JSON Schema.
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
		const activeEvents = eventStore ? eventStore.readActive(sessionId) : [];
		const isResume = activeEvents.length > 0;

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
					type: "user_message",
					content: request.prompt,
					isResume: true,
					ts: Date.now(),
				});
			} else {
				eventStore.append(sessionId, {
					type: "user_message",
					content: firstUserContent,
					cwd,
					ts: Date.now(),
				});
			}
		}

		// For context compression: use the original task prompt, not the resume prompt.
		// On resume, find the first user_message in the FULL event history.
		let taskContext = request.prompt;
		if (isResume && eventStore) {
			const allEvents = eventStore.read(sessionId);
			const firstUserMsg = allEvents.find((e) => e.type === "user_message");
			if (firstUserMsg && "content" in firstUserMsg) {
				taskContext = firstUserMsg.content as string;
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
				const checkpoint = extractCheckpoint(responseText, cwd);

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
					const estimatedPostCompactTokensForSaved = Math.floor(
						postCompactChars / 4,
					);
					const compactSavedTokens = Math.max(
						0,
						oldTokens - estimatedPostCompactTokensForSaved,
					);
					// Append compact_marker + compacted_resume to EventStore
					if (eventStore) {
						eventStore.append(sessionId, {
							type: "compact_marker",
							checkpoint,
							savedTokens: compactSavedTokens,
							ts: Date.now(),
						});
						eventStore.append(sessionId, {
							type: "compacted_resume",
							content: userContent,
							cwd,
							ts: Date.now(),
						});
					}
					estimatedInputTokens = estimatedPostCompactTokensForSaved;
					yield {
						type: "usage",
						inputTokens: estimatedPostCompactTokensForSaved,
						compressThreshold: compressThreshold,
						contextWindow: contextWindow,
						estimated: true,
					};
					yield {
						type: "compact",
						checkpoint,
						savedTokens: compactSavedTokens,
					};
					manualCompactRequested = false;
				} catch (e) {
					yield {
						type: "error",
						message: `Compaction rebuild failed: ${e instanceof Error ? e.message : String(e)}`,
					};
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

				try {
					queue.idle = true;
					yield { type: "agent_idle" };
					const first = await queue.wait();
					queue.idle = false;
					yield { type: "agent_active" };
					const rest = queue.drain();
					const all = [first, ...rest];
					if (all.some((m) => m.source === "compact")) {
						manualCompactRequested = true;
					}
					const nonCompact = all.filter((m) => m.source !== "compact");
					if (nonCompact.length === 0) {
						// Only compact signal — no messages to inject, just continue to trigger compaction
						continue;
					}
					const formatted = nonCompact.map(formatQueueMessage).join("\n");
					yield {
						type: "queue_message",
						messages: formatted,
						rawMessages: nonCompact.map(toRawMessage),
					};
					// Inject messages as a new user turn and continue the loop
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
						const newEvents: Event[] = [];
						const consumedIds: string[] = [];
						for (const msg of nonCompact) {
							if (msg.source === "user" && msg.id) {
								// user_message already written to JSONL at send time — don't duplicate
								consumedIds.push(msg.id);
							} else {
								const evt = queueMessageToEvent(msg);
								const evtId = (evt as { id?: string }).id;
								if (evtId) consumedIds.push(evtId);
								newEvents.push(evt);
							}
						}
						if (consumedIds.length > 0) {
							newEvents.push({
								type: "messages_consumed",
								messageIds: consumedIds,
								ts: Date.now(),
							});
						}
						eventStore.appendBatch(sessionId, newEvents);
					}
					continue;
				} catch {
					queue.idle = false;
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
							const textParts: string[] = [];
							const imageParts: Array<{
								base64: string;
								mediaType: string;
							}> = [];
							for (const c of parts as Array<Record<string, unknown>>) {
								if (c.type === "text") {
									textParts.push((c.text as string) ?? "");
								} else if (c.type === "image" && c.data) {
									imageParts.push({
										base64: c.data as string,
										mediaType: (c.mimeType as string) ?? "image/png",
									});
								} else {
									textParts.push(JSON.stringify(c));
								}
							}
							// Extract consumed message IDs, pending state, and formatted queue messages from yield/done tools
							const consumedIds = Array.isArray(mcpResult._consumedMessageIds)
								? (mcpResult._consumedMessageIds as string[])
								: undefined;
							const pending = mcpResult._pending as
								| {
										runningChildren: Array<{
											id: string;
											title: string;
										}>;
										pendingClarifications: number;
								  }
								| undefined;
							const formattedQueueMessages =
								typeof mcpResult._formattedQueueMessages === "string"
									? mcpResult._formattedQueueMessages
									: undefined;
							return {
								content: textParts.join("\n"),
								isError: mcpResult.isError ?? false,
								isImage: imageParts.length > 0,
								imageData: imageParts[0]?.base64,
								mediaType: imageParts[0]?.mediaType,
								mcpImages: imageParts,
								...(consumedIds?.length
									? { _consumedMessageIds: consumedIds }
									: {}),
								...(pending ? { _pending: pending } : {}),
								...(formattedQueueMessages
									? { _formattedQueueMessages: formattedQueueMessages }
									: {}),
							};
						} catch (e) {
							return {
								content: `MCP tool error: ${e instanceof Error ? e.message : String(e)}`,
								isError: true,
							};
						}
					}
					return _executeTool(
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
					mcpImages?: Array<{ base64: string; mediaType: string }>;
					_consumedMessageIds?: string[];
					_formattedQueueMessages?: string;
				};

				// Update cwd if bash tool changed it
				if (exec.cwd) {
					cwd = exec.cwd;
				}

				const text = exec.content;
				const isError = exec.isError;

				// Collect images for the UI event
				const images: Array<{ base64: string; mediaType: string }> = [];
				// When _formattedQueueMessages is set, mcpImages are user queue images
				// — they go alongside the queue text block, not in the tool_result
				if (!exec._formattedQueueMessages && exec.mcpImages?.length) {
					images.push(...exec.mcpImages);
				} else if (exec.isImage && exec.imageData && exec.mediaType) {
					images.push({ base64: exec.imageData, mediaType: exec.mediaType });
				}

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

			// Cancellation point: drain queue and add messages as text blocks alongside tool results
			let cancellationQueueMsgs: QueueMessage[] = [];
			const cancellationTextBlocks: Array<{ type: "text"; text: string }> = [];
			const cancellationImageBlocks: ReturnType<typeof extractQueueImages> = [];
			if (queue && queue.pending > 0) {
				const queueMsgs = queue.drain();
				if (queueMsgs.some((m) => m.source === "compact")) {
					manualCompactRequested = true;
				}
				const nonCompactMsgs = queueMsgs.filter((m) => m.source !== "compact");
				if (nonCompactMsgs.length > 0) {
					const formatted = nonCompactMsgs.map(formatQueueMessage).join("\n");
					cancellationTextBlocks.push({
						type: "text" as const,
						text: `[Messages received while you were working:]\n${formatted}`,
					});
					cancellationImageBlocks.push(...extractQueueImages(nonCompactMsgs));
					cancellationQueueMsgs = nonCompactMsgs;
					yield {
						type: "queue_message",
						messages: formatted,
						rawMessages: nonCompactMsgs.map(toRawMessage),
					};
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
				const e = exec as {
					_formattedQueueMessages?: string;
					mcpImages?: Array<{ base64: string; mediaType: string }>;
					_consumedMessageIds?: string[];
				};
				if (e._formattedQueueMessages) {
					yieldQueueTextBlocks.push({
						type: "text" as const,
						text: `[Messages received while you were idle:]\n${e._formattedQueueMessages}`,
					});
					// Images from yield/done are in mcpImages when _formattedQueueMessages is set
					if (e.mcpImages?.length) {
						for (const img of e.mcpImages) {
							yieldQueueImageBlocks.push({
								type: "image",
								data: img.base64,
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
				const toolEvents: Event[] = [];

				// Collect consumed message IDs from cancellation queue messages
				const consumedIds: string[] = [];
				const nonUserQueueEvents: Event[] = [];
				for (const qm of cancellationQueueMsgs) {
					if (qm.source === "user" && qm.id) {
						// user_message already written to JSONL at send time — just track ID
						consumedIds.push(qm.id);
					} else {
						const evt = queueMessageToEvent(qm);
						const evtId = (evt as { id?: string }).id;
						if (evtId) consumedIds.push(evtId);
						nonUserQueueEvents.push(evt);
					}
				}

				for (let idx = 0; idx < toolUses.length; idx++) {
					const toolUse = toolUses[idx] as ToolUseBlock;
					const exec = execResults[idx] as {
						content: string;
						isError: boolean;
						mcpImages?: Array<{ base64: string; mediaType: string }>;
						isImage?: boolean;
						imageData?: string;
						mediaType?: string;
						_consumedMessageIds?: string[];
						_formattedQueueMessages?: string;
						_pending?: {
							runningChildren: Array<{ id: string; title: string }>;
							pendingClarifications: number;
						};
					};
					// Record pure tool output — queue text is NOT embedded.
					// The converter reconstructs queue messages from messagesConsumed + user_message events.
					const resultContent = exec.content;
					const images: Array<{ base64: string; mediaType: string }> = [];
					// When _formattedQueueMessages is set, mcpImages are user queue images
					// — they're already recorded as user_message events, not tool images
					if (!exec._formattedQueueMessages && exec.mcpImages?.length) {
						images.push(...exec.mcpImages);
					} else if (exec.isImage && exec.imageData && exec.mediaType) {
						images.push({
							base64: exec.imageData,
							mediaType: exec.mediaType,
						});
					}
					const isLast = idx === toolUses.length - 1;
					toolEvents.push({
						type: "tool_result",
						toolCallId: toolUse.id,
						content: resultContent,
						isError: exec.isError,
						...(images.length > 0 ? { images } : {}),
						...(isLast && exec._pending ? { pending: exec._pending } : {}),
						ts: Date.now(),
					});
				}
				// Record non-user cancellation-point queue messages as separate Events
				for (const evt of nonUserQueueEvents) {
					toolEvents.push(evt);
				}
				// Record standalone messages_consumed event AFTER tool_results and queue events
				const allConsumedIds = [
					...consumedIds,
					...execResults.flatMap((exec) => {
						const e = exec as { _consumedMessageIds?: string[] };
						return e._consumedMessageIds ?? [];
					}),
				];
				if (allConsumedIds.length > 0) {
					toolEvents.push({
						type: "messages_consumed",
						messageIds: allConsumedIds,
						ts: Date.now(),
					});
				}
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
				const ratio = runningCost / request.budgetUsd;

				if (ratio >= 1.0) {
					const warning = `⚠️ Budget exceeded (${runningCost.toFixed(4)} / ${request.budgetUsd.toFixed(2)} budget). Call done() now.`;
					messages.push({
						role: "user" as const,
						content: warning,
					});
					if (eventStore) {
						eventStore.append(sessionId, {
							type: "budget_warning",
							warning,
							ts: Date.now(),
						});
					}
					yield { type: "status", message: warning };
				} else if (ratio >= 0.8) {
					const warning = `⚠️ Warning: task has used ${Math.round(ratio * 100)}% of its ${request.budgetUsd.toFixed(2)} budget (${runningCost.toFixed(4)} spent). Wrap up soon.`;
					messages.push({
						role: "user" as const,
						content: warning,
					});
					if (eventStore) {
						eventStore.append(sessionId, {
							type: "budget_warning",
							warning,
							ts: Date.now(),
						});
					}
					yield { type: "status", message: warning };
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
