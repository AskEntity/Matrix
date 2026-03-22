/**
 * Shared provider logic extracted from anthropic-compatible-provider.ts and
 * openai-compatible-provider.ts. Both providers import these helpers to avoid
 * code duplication.
 *
 * The unified `runProviderLoop()` is the single run loop used by both providers.
 * Each provider implements a `ProviderAdapter` interface with hooks for the
 * API-specific operations (message format, API call, response parsing, etc.).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRequest } from "./agent-provider.ts";
import { formatQueueMessage } from "./agent-tools.ts";
import {
	type Event,
	formatEventForAI,
	isQueueEvent,
	queueMessageToEvent,
} from "./events.ts";
import type { MessageQueue, QueueMessage } from "./message-queue.ts";
import type { ToolDefinition } from "./tool-definition.ts";
import { executeTool } from "./tools/index.ts";
import type { AgentResult } from "./types.ts";

// ── Constants ──

/** Reserve ~17% as compaction buffer — compress when messages exceed this */
export const COMPACT_BUFFER_RATIO = 0.17;

export const DEFAULT_MAX_TOKENS = 16384;

// ── Compaction ──

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
 * Combines fresh memory and checkpoint into a single user message.
 * @internal Exported for testing
 */
export async function buildCompactedContext(
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
	if (freshMemory) {
		parts.push(`## Project Memory (fresh)\n${freshMemory}`);
	}
	parts.push(`## Checkpoint Summary\n\n${checkpoint}`);

	return parts.join("\n\n---\n\n");
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

// ── Zod to JSON Schema ──

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

export function zodTypeToJsonProp(zodType: unknown): {
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

// ── Tool execution result type ──

/**
 * Unified result type from executing a tool (built-in or MCP).
 * Used by both providers' tool execution paths.
 */
export interface ToolExecResult {
	content: string;
	isError: boolean;
	cwd?: string;
	/** Background process ID — set when bash moves a command to background. */
	backgroundId?: string;
	/** Background command — set when bash moves a command to background. */
	backgroundCommand?: string;
	isImage?: boolean;
	imageData?: string;
	mediaType?: string;
	mcpImages?: Array<{ base64: string; mediaType: string; data?: string }>;
	_consumedMessageIds?: string[];
	_formattedQueueMessages?: string;
	_pending?: {
		runningChildren: Array<{ id: string; title: string }>;
		pendingClarifications: number;
	};
}

/**
 * Execute a single tool — MCP handler or built-in.
 * Returns a unified ToolExecResult.
 */
export async function executeToolUnified(
	toolName: string,
	input: Record<string, unknown>,
	// biome-ignore lint/suspicious/noExplicitAny: ToolDefinition generic varies
	mcpHandlers: Map<string, ToolDefinition<any>>,
	cwd: string,
	fallbackCwd?: string,
	sessionId?: string,
	queue?: MessageQueue,
): Promise<ToolExecResult> {
	const mcpHandler = mcpHandlers.get(toolName);
	if (mcpHandler) {
		try {
			const mcpResult = await mcpHandler.handler(input, {});
			const parts = Array.isArray(mcpResult.content) ? mcpResult.content : [];
			const textParts: string[] = [];
			const mcpImages: Array<{
				base64: string;
				mediaType: string;
				data: string;
			}> = [];
			for (const c of parts as Array<Record<string, unknown>>) {
				if (c.type === "text") {
					textParts.push((c.text as string) ?? "");
				} else if (c.type === "image" && c.data) {
					// MCP format: { type: "image", data, mimeType }
					mcpImages.push({
						mediaType: (c.mimeType as string) ?? "image/png",
						data: c.data as string,
						base64: c.data as string,
					});
				} else if (
					c.type === "image" &&
					(c.source as Record<string, unknown>)?.type === "base64"
				) {
					// Anthropic format: { type: "image", source: { type: "base64", media_type, data } }
					const src = c.source as Record<string, string>;
					mcpImages.push({
						mediaType: src.media_type ?? "image/png",
						data: src.data ?? "",
						base64: src.data ?? "",
					});
				} else {
					textParts.push(JSON.stringify(c));
				}
			}
			// Extract consumed message IDs, pending state, and formatted queue messages from yield/done tools
			const consumedIds = Array.isArray(mcpResult._consumedMessageIds)
				? (mcpResult._consumedMessageIds as string[])
				: undefined;
			const pending = mcpResult._pending as ToolExecResult["_pending"];
			const formattedQueueMessages =
				typeof mcpResult._formattedQueueMessages === "string"
					? mcpResult._formattedQueueMessages
					: undefined;
			return {
				content: textParts.join("\n"),
				isError: (mcpResult.isError as boolean) ?? false,
				isImage: mcpImages.length > 0,
				mcpImages,
				...(consumedIds?.length ? { _consumedMessageIds: consumedIds } : {}),
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

	return executeTool(toolName, input, cwd, fallbackCwd, sessionId, queue);
}

// ── Queue image extraction ──

/**
 * Extract images from queue messages in Anthropic format (base64 image blocks).
 */
export function extractQueueImages(msgs: QueueMessage[]): Array<{
	type: "image";
	source: {
		type: "base64";
		media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
		data: string;
	};
}> {
	type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
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

/**
 * Extract images from queue messages in OpenAI format (image_url parts with data URIs).
 */
export function extractQueueImageParts(
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

// ── Implicit yield (end_turn with queue) ──

/**
 * Shared implicit yield logic: wait for messages on queue, format them, emit events.
 * Returns the formatted messages and images, or null if queue was closed.
 *
 * @returns Object with formatted messages and image data, or null if queue closed
 */
export async function* handleImplicitYield(
	queue: MessageQueue,
	emit?: (event: Event) => void,
): AsyncGenerator<
	Event,
	{
		formatted: string;
		nonCompact: QueueMessage[];
		manualCompactRequested: boolean;
		compactOnly: boolean;
	} | null
> {
	const idleEvt: Event = { type: "agent_idle", taskId: "", ts: Date.now() };
	emit?.(idleEvt);
	yield idleEvt;
	try {
		queue.idle = true;
		const first = await queue.wait();
		queue.idle = false;
		const activeEvt: Event = {
			type: "agent_active",
			taskId: "",
			ts: Date.now(),
		};
		emit?.(activeEvt);
		yield activeEvt;
		const rest = queue.drain();
		const all = [first, ...rest];
		const manualCompactRequested = all.some((m) => m.source === "compact");
		const nonCompact = all.filter((m) => m.source !== "compact");
		if (nonCompact.length === 0) {
			return {
				formatted: "",
				nonCompact: [],
				manualCompactRequested,
				compactOnly: true,
			};
		}
		const formatted = nonCompact.map(formatQueueMessage).join("\n");
		return {
			formatted,
			nonCompact,
			manualCompactRequested,
			compactOnly: false,
		};
	} catch {
		queue.idle = false;
		return null; // Queue closed
	}
}

// ── Cancellation point queue drain ──

/**
 * Drain queue at cancellation point (between tool execution and next API call).
 * Returns the queue messages and formatted text, or null if nothing to drain.
 */
export function drainQueueAtCancellationPoint(queue: MessageQueue): {
	messages: QueueMessage[];
	formatted: string;
	manualCompactRequested: boolean;
} | null {
	if (queue.pending <= 0) return null;

	const queueMsgs = queue.drain();
	const manualCompactRequested = queueMsgs.some((m) => m.source === "compact");
	const nonCompactMsgs = queueMsgs.filter((m) => m.source !== "compact");
	if (nonCompactMsgs.length === 0) {
		return { messages: [], formatted: "", manualCompactRequested };
	}

	const formatted = nonCompactMsgs.map(formatQueueMessage).join("\n");
	return { messages: nonCompactMsgs, formatted, manualCompactRequested };
}

// ── Event emission helpers ──

/**
 * Emit queue events and messages_consumed event via the emit callback.
 * Handles the two-phase message lifecycle: user messages with IDs are already
 * written at send time — just track their IDs. Other messages get converted.
 */
export function recordQueueEvents(
	emit: (event: Event) => void,
	queueMsgs: QueueMessage[],
	additionalConsumedIds?: string[],
): void {
	const consumedIds: string[] = [...(additionalConsumedIds ?? [])];

	for (const msg of queueMsgs) {
		if (msg.source === "user" && msg.id) {
			// message already written to JSONL at send time — don't duplicate
			consumedIds.push(msg.id);
		} else {
			const evt = queueMessageToEvent(msg);
			const evtId = (evt as { id?: string }).id;
			if (evtId) consumedIds.push(evtId);
			emit(evt);
		}
	}

	if (consumedIds.length > 0) {
		emit({
			type: "messages_consumed",
			messageIds: consumedIds,
			ts: Date.now(),
		});
	}
}

/**
 * Collect images for the UI tool_result event from execution result.
 * When `_formattedQueueMessages` is set, mcpImages are user queue images
 * — they go alongside the queue text, not in the tool_result.
 */
export function collectToolResultImages(
	exec: ToolExecResult,
): Array<{ base64: string; mediaType: string }> {
	const images: Array<{ base64: string; mediaType: string }> = [];
	if (!exec._formattedQueueMessages && exec.mcpImages?.length) {
		for (const img of exec.mcpImages) {
			images.push({
				base64: img.base64 ?? img.data ?? "",
				mediaType: img.mediaType,
			});
		}
	} else if (exec.isImage && exec.imageData && exec.mediaType) {
		images.push({ base64: exec.imageData, mediaType: exec.mediaType });
	}
	return images;
}

/**
 * Build tool_result events for emission.
 * Returns the events array with tool_result events, cancellation queue events,
 * and a messages_consumed event combining all consumed IDs.
 */
export function buildToolResultEvents(
	toolIds: Array<{ id: string }>,
	execResults: ToolExecResult[],
	cancellationQueueMsgs: QueueMessage[],
): Event[] {
	const toolEvents: Event[] = [];

	// Collect consumed message IDs from cancellation queue messages
	const consumedIds: string[] = [];
	const nonUserQueueEvents: Event[] = [];
	for (const qm of cancellationQueueMsgs) {
		if (qm.source === "user" && qm.id) {
			// message already written to JSONL at send time — just track ID
			consumedIds.push(qm.id);
		} else {
			const evt = queueMessageToEvent(qm);
			const evtId = (evt as { id?: string }).id;
			if (evtId) consumedIds.push(evtId);
			nonUserQueueEvents.push(evt);
		}
	}

	for (let idx = 0; idx < toolIds.length; idx++) {
		const toolId = toolIds[idx] as { id: string };
		const exec = execResults[idx] as ToolExecResult;

		// Record pure tool output — queue text is NOT embedded.
		// The converter reconstructs queue messages from messagesConsumed + message events.
		const images: Array<{ base64: string; mediaType: string }> = [];
		if (!exec._formattedQueueMessages && exec.mcpImages?.length) {
			for (const img of exec.mcpImages) {
				images.push({
					base64: img.base64 ?? img.data ?? "",
					mediaType: img.mediaType,
				});
			}
		} else if (exec.isImage && exec.imageData && exec.mediaType) {
			images.push({
				base64: exec.imageData,
				mediaType: exec.mediaType,
			});
		}

		const isLast = idx === toolIds.length - 1;
		toolEvents.push({
			type: "tool_result",
			toolCallId: toolId.id,
			content: exec.content,
			isError: exec.isError,
			...(images.length > 0 ? { images } : {}),
			...(isLast && exec._pending ? { pending: exec._pending } : {}),
			...(exec.backgroundId ? { backgroundId: exec.backgroundId } : {}),
			...(exec.backgroundCommand
				? { backgroundCommand: exec.backgroundCommand }
				: {}),
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
		...execResults.flatMap((exec) => exec._consumedMessageIds ?? []),
	];
	if (allConsumedIds.length > 0) {
		toolEvents.push({
			type: "messages_consumed",
			messageIds: allConsumedIds,
			ts: Date.now(),
		});
	}

	return toolEvents;
}

// ── Compaction processing ──

/**
 * Process compaction response: extract checkpoint, rebuild context, record events.
 * Returns the new user content and usage info, or null on failure.
 */
export async function* processCompaction(
	responseText: string,
	cwd: string | undefined,
	preCompactTokenCount: number,
	emit: ((event: Event) => void) | undefined,
	contextWindow: number,
): AsyncGenerator<
	Event,
	{
		userContent: string;
		estimatedInputTokens: number;
	} | null
> {
	const checkpoint = extractCheckpoint(responseText, cwd);

	try {
		const compactedContent = await buildCompactedContext(checkpoint, cwd);
		const userContent = cwd
			? `Working directory: ${cwd}\n\n${compactedContent}`
			: compactedContent;
		const postCompactChars = userContent.length;
		const estimatedPostCompactTokens = Math.floor(postCompactChars / 4);
		const compactSavedTokens = Math.max(
			0,
			preCompactTokenCount - estimatedPostCompactTokens,
		);

		// Emit compact_marker + compacted_resume events
		if (emit) {
			emit({
				type: "compact_marker",
				checkpoint,
				savedTokens: compactSavedTokens,
				ts: Date.now(),
			});
			emit({
				type: "compacted_resume",
				content: userContent,
				cwd,
				ts: Date.now(),
			});
		}

		const usageEvt: Event = {
			type: "usage",
			inputTokens: estimatedPostCompactTokens,
			contextWindow,
			estimated: true,
			ts: Date.now(),
		};
		emit?.(usageEvt);
		yield usageEvt;
		// compact_marker already emitted above — yield for consumer loop
		yield {
			type: "compact_marker",
			checkpoint,
			savedTokens: compactSavedTokens,
			ts: Date.now(),
		};

		return { userContent, estimatedInputTokens: estimatedPostCompactTokens };
	} catch (e) {
		const errEvt: Event = {
			type: "error",
			message: `Compaction rebuild failed: ${e instanceof Error ? e.message : String(e)}`,
			ts: Date.now(),
		};
		emit?.(errEvt);
		yield errEvt;
		return null;
	}
}

// ── Budget check ──

/**
 * Check budget and inject warnings at 80% and 100% thresholds.
 * Returns warning events and the warning text to inject, if any.
 */
export function checkBudget(
	budgetUsd: number,
	runningCost: number,
): { warning: string; ratio: number } | null {
	const ratio = runningCost / budgetUsd;
	if (ratio >= 1.0) {
		return {
			warning: `⚠️ Budget exceeded (${runningCost.toFixed(4)} / ${budgetUsd.toFixed(2)} budget). Call done() now.`,
			ratio,
		};
	}
	if (ratio >= 0.8) {
		return {
			warning: `⚠️ Warning: task has used ${Math.round(ratio * 100)}% of its ${budgetUsd.toFixed(2)} budget (${runningCost.toFixed(4)} spent). Wrap up soon.`,
			ratio,
		};
	}
	return null;
}

/**
 * Emit a budget warning event.
 */
export function recordBudgetWarning(
	emit: ((event: Event) => void) | undefined,
	warning: string,
): void {
	if (emit) {
		emit({
			type: "budget_warning",
			warning,
			ts: Date.now(),
		});
	}
}

// ── Shared Event Converter Walker ──

/** Image data extracted from events (provider-agnostic). */
export interface EventImageData {
	base64: string;
	mediaType: string;
}

/** A single tool call in an assistant turn. */
export interface AssistantToolCall {
	id: string;
	name: string;
	input: Record<string, unknown>;
}

/** Collected assistant content: ordered text blocks and tool calls. */
export interface AssistantContent {
	items: Array<
		| { type: "text"; text: string }
		| { type: "tool_call"; call: AssistantToolCall }
	>;
}

/** A single tool result extracted from events. */
export interface ToolResultData {
	toolCallId: string;
	content: string | undefined;
	isError: boolean;
	images?: EventImageData[];
	pending?: {
		runningChildren: Array<{ id: string; title: string }>;
		pendingClarifications: number;
	};
}

/** Consumed messages resolved from a messages_consumed event. */
export interface ConsumedMessages {
	formattedTexts: string[];
	images: EventImageData[];
	isWorkingContext: boolean;
}

/**
 * Callbacks that each provider implements to handle provider-specific message formatting.
 * The shared walker calls these at the right points during event traversal.
 */
export interface EventConverterCallbacks {
	/** Build a user message from plain content (message/user_message without id, compacted_resume, etc.). */
	onUserMessage(content: string): unknown;

	/** Build an assistant message from collected text + tool_call blocks. */
	onAssistantContent(content: AssistantContent): unknown;

	/**
	 * Build message(s) for a batch of tool results.
	 * Called with consecutive tool_results, any interleaved messages_consumed data,
	 * and accumulated queue images.
	 */
	onToolResults(
		results: ToolResultData[],
		interleaved: Array<{ type: "text"; text: string }>,
		queueImages: EventImageData[],
	): unknown[];

	/**
	 * Handle consumed messages (from messages_consumed event).
	 * Called in non-tool-result context (idle or standalone).
	 * `messages` is the current message array — the callback may append to the last message
	 * or push new messages.
	 */
	onConsumedMessages(messages: unknown[], consumed: ConsumedMessages): void;

	/** Fix orphaned tool uses in the final message array. */
	fixOrphans(messages: unknown[]): void;

	/**
	 * Determine if the current message context is "working" (between tool results).
	 * Used to decide "[Messages received while you were working/idle:]" wrapper.
	 */
	isWorkingContext(messages: unknown[]): boolean;
}

/**
 * Build an index of events by ID for messages_consumed resolution.
 */
export function buildEventIndex(events: Event[]): Map<string, Event> {
	const index = new Map<string, Event>();
	for (const e of events) {
		const eid = (e as { id?: string }).id;
		if (eid) {
			index.set(eid, e);
		}
	}
	return index;
}

/**
 * Extract images from a consumed event (message with images in body).
 */
export function extractConsumedEventImages(event: Event): EventImageData[] {
	if (event.type !== "message") return [];
	const imgs = event.body.images ?? [];
	return imgs.map((img) => ({
		base64: img.base64,
		mediaType: img.mediaType,
	}));
}

/**
 * Resolve consumed events from a messages_consumed event using the event index.
 * Returns formatted text contents and extracted images.
 */
export function resolveConsumedMessages(
	messageIds: string[],
	eventIndex: Map<string, Event>,
	isWorking: boolean,
): ConsumedMessages | null {
	const consumedEvents: Event[] = [];
	for (const id of messageIds) {
		const msg = eventIndex.get(id);
		if (msg) consumedEvents.push(msg);
	}
	if (consumedEvents.length === 0) return null;

	const formattedTexts: string[] = [];
	const images: EventImageData[] = [];
	for (const msg of consumedEvents) {
		formattedTexts.push(formatEventForAI(msg));
		images.push(...extractConsumedEventImages(msg));
	}

	return { formattedTexts, images, isWorkingContext: isWorking };
}

/**
 * Generic event walker that converts JSONL events to provider messages.
 * Handles all shared control flow: event index, two-phase skip/materialize,
 * queue event skipping, compaction skip, and the main while-loop structure.
 *
 * Provider-specific formatting is delegated to callbacks.
 */
export function walkEventsToMessages(
	events: Event[],
	callbacks: EventConverterCallbacks,
): unknown[] {
	const messages: unknown[] = [];
	const eventIndex = buildEventIndex(events);
	let i = 0;

	while (i < events.length) {
		const event = events[i] as Event;

		switch (event.type) {
			case "message": {
				// Messages with non-empty IDs are deferred — materialized at messages_consumed
				if (event.id) {
					i++;
					break;
				}
				// Messages without meaningful IDs — render directly as user message
				const msgContent = formatEventForAI(event) || "(empty)";
				messages.push(callbacks.onUserMessage(msgContent));
				i++;
				break;
			}

			case "messages_consumed": {
				const isWorking = callbacks.isWorkingContext(messages);
				const consumed = resolveConsumedMessages(
					event.messageIds,
					eventIndex,
					isWorking,
				);
				if (consumed) {
					callbacks.onConsumedMessages(messages, consumed);
				}
				i++;
				break;
			}

			case "compacted_resume":
				messages.push(callbacks.onUserMessage(event.content));
				i++;
				break;

			case "summarization_request":
				messages.push(callbacks.onUserMessage(event.instruction));
				i++;
				break;

			case "budget_warning":
				messages.push(callbacks.onUserMessage(event.warning));
				i++;
				break;

			case "assistant_text":
			case "tool_call": {
				const content: AssistantContent = {
					items: [],
				};

				// Collect ALL consecutive assistant_text and tool_call events.
				// They may be interleaved (text→tool→text→tool) but belong to the same turn.
				while (i < events.length) {
					const cur = events[i] as Event;
					if (cur.type === "assistant_text") {
						content.items.push({ type: "text", text: cur.content });
						i++;
					} else if (cur.type === "tool_call") {
						const call: AssistantToolCall = {
							id: cur.toolCallId,
							name: cur.tool,
							input: cur.input,
						};
						content.items.push({ type: "tool_call", call });
						i++;
					} else {
						break;
					}
				}

				messages.push(callbacks.onAssistantContent(content));
				break;
			}

			case "tool_result": {
				const results: ToolResultData[] = [];
				const interleavedText: Array<{ type: "text"; text: string }> = [];
				const queueImages: EventImageData[] = [];

				while (i < events.length) {
					const current = events[i] as Event;
					if (current.type === "tool_result") {
						results.push({
							toolCallId: current.toolCallId,
							content: current.content,
							isError: current.isError,
							images: current.images?.map((img) => ({
								base64: img.base64,
								mediaType: img.mediaType,
							})),
							pending: current.pending,
						});
						i++;
					} else if (current.type === "messages_consumed") {
						// messages_consumed between tool_results → working context
						const consumed = resolveConsumedMessages(
							current.messageIds,
							eventIndex,
							true,
						);
						if (consumed) {
							const mcText = `[Messages received while you were working:]\n${consumed.formattedTexts.join("\n")}`;
							interleavedText.push({ type: "text", text: mcText });
							queueImages.push(...consumed.images);
						}
						i++;
					} else if (isQueueEvent(current) || current.type === "message") {
						// Queue events with IDs — skip, materialized by messages_consumed
						i++;
					} else {
						break;
					}
				}

				const toolMsgs = callbacks.onToolResults(
					results,
					interleavedText,
					queueImages,
				);
				for (const msg of toolMsgs) {
					messages.push(msg);
				}
				break;
			}

			case "compact_marker":
				i++;
				break;

			default:
				// Skip lifecycle/broadcast events
				i++;
				break;
		}
	}

	callbacks.fixOrphans(messages);
	return messages;
}

// ── Unified Provider Adapter Interface ──

/** Tool use extracted from a provider response. */
export interface ProviderToolUse {
	id: string;
	name: string;
	input: Record<string, unknown>;
}

/** Token usage from a provider response. */
export interface ProviderTokenUsage {
	inputTokens: number;
	outputTokens: number;
	/** Total context size (for compaction threshold). For Anthropic, includes cache tokens. */
	totalContextTokens: number;
	/** Anthropic-specific: cache creation tokens. */
	cacheCreationTokens?: number;
	/** Anthropic-specific: cache read tokens. */
	cacheReadTokens?: number;
}

/**
 * Adapter interface that each provider implements to plug into the unified run loop.
 * The run loop handles ALL control flow (resume, compaction, tool execution, implicit yield,
 * budget check, event emission). The adapter only handles provider-specific operations.
 */
export interface ProviderAdapter {
	/** Get context window size for a model. May be async (e.g. OpenAI fetches from API). */
	getContextWindow(model: string): number | Promise<number>;

	/** Get per-million-token pricing for a model. */
	getModelPricing(model: string): { inputPer1M: number; outputPer1M: number };

	/** Reconstruct provider messages from JSONL events (for resume). */
	convertEventsToMessages(events: Event[]): unknown[];

	/** Build provider-specific tool definitions from built-in + MCP tools. */
	prepareTools(
		// biome-ignore lint/suspicious/noExplicitAny: ToolDefinition generic varies
		mcpToolDefs: Record<string, ToolDefinition<any>[]> | undefined,
		// biome-ignore lint/suspicious/noExplicitAny: ToolDefinition generic varies
		mcpHandlers: Map<string, ToolDefinition<any>>,
	): unknown[];

	/**
	 * Call the provider API with the given messages and tools.
	 * Handles retries, streaming text deltas, and error handling internally.
	 * Yields text_delta events during streaming, then returns the response.
	 * @param isCompacting - If true, suppress text_delta events (checkpoint text is not user-facing)
	 */
	callAPI(params: {
		model: string;
		messages: unknown[];
		tools: unknown[];
		systemPrompt: string;
		maxTokens: number;
		signal?: AbortSignal;
		isCompacting: boolean;
	}): AsyncGenerator<Event, unknown>;

	/** Extract text content from a provider response. */
	getResponseText(response: unknown): string;

	/** Extract tool uses from a provider response. */
	getToolUses(response: unknown): ProviderToolUse[];

	/** Get token usage from a provider response. */
	getTokenUsage(response: unknown): ProviderTokenUsage;

	/**
	 * Get the stop reason from a provider response.
	 * Returns "end_turn" if the model stopped naturally, "tool_use" if tools were called.
	 */
	getStopReason(response: unknown): "end_turn" | "tool_use";

	/** Whether the provider supports exact token counting (e.g., Anthropic countTokens API). */
	supportsTokenCounting: boolean;

	/** Count tokens for exact threshold check. Only called if supportsTokenCounting is true. */
	countTokens?(params: {
		model: string;
		system: string;
		messages: unknown[];
		tools: unknown[];
	}): Promise<number>;

	/** Build events to record in JSONL for the response (assistant_text + tool_call events). */
	buildResponseEvents(response: unknown, isCompacting: boolean): Event[];

	/** Add the assistant response to the messages array. */
	addAssistantMessage(
		messages: unknown[],
		response: unknown,
		isCompacting: boolean,
	): void;

	/**
	 * Build the user message containing tool results + any queue messages.
	 * This is where provider format differences are most significant:
	 * - Anthropic: single user message with tool_result + text + image blocks
	 * - OpenAI: separate tool messages + user message for images/queue
	 */
	buildToolResultsMessage(params: {
		toolUses: ProviderToolUse[];
		execResults: ToolExecResult[];
		cancellationQueueMsgs: QueueMessage[];
		cancellationFormatted: string;
	}): unknown[];

	/** Build a user message for queue drain during implicit yield. */
	buildImplicitYieldMessage(
		formatted: string,
		nonCompact: QueueMessage[],
	): unknown;

	/** Compute cost from accumulated token counts. */
	computeCost(
		model: string,
		totalInputTokens: number,
		totalOutputTokens: number,
		totalCacheCreationTokens: number,
		totalCacheReadTokens: number,
	): number;

	/**
	 * Build the final AgentResult. Optional — default returns base fields.
	 * Override to include provider-specific fields (e.g. Anthropic cache tokens).
	 */
	buildResult?(params: {
		success: boolean;
		output: string;
		costUsd: number;
		turns: number;
		sessionId: string;
		totalInputTokens: number;
		totalOutputTokens: number;
		totalCacheCreationTokens: number;
		totalCacheReadTokens: number;
	}): AgentResult;
}

/** Default buildResult — used when adapter doesn't override. */
function defaultBuildResult(params: {
	success: boolean;
	output: string;
	costUsd: number;
	turns: number;
	sessionId: string;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheCreationTokens: number;
	totalCacheReadTokens: number;
}): AgentResult {
	return {
		success: params.success,
		output: params.output,
		costUsd: params.costUsd,
		turns: params.turns,
		sessionId: params.sessionId,
		inputTokens: params.totalInputTokens,
		outputTokens: params.totalOutputTokens,
	};
}

/**
 * Unified run loop for both providers. Handles ALL control flow:
 * - Resume detection + event conversion
 * - Main while(true) loop
 * - Compaction trigger + processing
 * - API call + response handling
 * - Tool execution orchestration
 * - Event emission (via emit callback)
 * - Cancellation point drain
 * - Implicit yield
 * - Budget check
 * - Queue closed exit
 *
 * Provider has zero EventStore access. All events flow through the `emit` callback
 * (wired by daemon layer to emitEvent which handles broadcast + persistence).
 *
 * Providers implement a ProviderAdapter with hooks for the ~15 things that differ
 * between Anthropic and OpenAI APIs.
 */
export async function* runProviderLoop(
	adapter: ProviderAdapter,
	request: AgentRequest,
	sessionId: string,
	queue?: MessageQueue,
): AsyncGenerator<Event, AgentResult> {
	const model = request.model ?? "claude-sonnet-4-6"; // default overridden by provider
	let cwd = request.cwd;

	// ── Context window + compaction thresholds ──
	const contextWindow = await adapter.getContextWindow(model);
	const { compressThreshold, lazyCountThreshold } =
		getCompactionThresholds(contextWindow);

	// ── Event emission — all events flow through this callback ──
	const emit = request.emit;

	// Resume from pre-loaded active events (daemon layer reads these from EventStore)
	const activeEvents = request.activeEvents ?? [];
	const isResume = activeEvents.length > 0;

	// Reconstruct messages from active events on resume, or start fresh
	const messages: unknown[] = isResume
		? adapter.convertEventsToMessages(activeEvents)
		: [];

	// Drain the queue for messages — both fresh start and resume.
	// Fresh start: first message has header with working dir + pre-loaded memory.
	// Resume: message has header with fresh context (re-read memory from disk).
	// Header is ALWAYS how context gets into the conversation — no special codepaths.
	if (queue) {
		// Wait for at least one message in the queue
		const firstMsg = await queue.wait();
		const rest = queue.drain();
		const allMsgs = [firstMsg, ...rest];

		// Build user content from the queue message(s)
		// Header (working dir + memory) goes first, then content
		const parts: string[] = [];
		for (const msg of allMsgs) {
			if (msg.source === "user" || msg.source === "parent_update") {
				const m = msg as { header?: string; content: string };
				if (m.header) parts.push(m.header);
				parts.push(m.content);
			} else {
				parts.push(formatQueueMessage(msg));
			}
		}
		const firstUserContent = parts.join("\n\n");
		messages.push({ role: "user" as const, content: firstUserContent });

		// Record queue events for the consumed messages
		if (emit) {
			recordQueueEvents(emit, allMsgs);
		}
	}

	// Build MCP tool handlers map and provider-specific tool definitions
	// biome-ignore lint/suspicious/noExplicitAny: ToolDefinition generic varies
	const mcpHandlers = new Map<string, ToolDefinition<any>>();
	if (request.mcpToolDefs) {
		for (const [serverName, defs] of Object.entries(request.mcpToolDefs)) {
			for (const def of defs) {
				const toolName = `mcp__${serverName}__${def.name}`;
				mcpHandlers.set(toolName, def);
			}
		}
	}
	const allTools = adapter.prepareTools(request.mcpToolDefs, mcpHandlers);

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
	{
		const evt: Event = {
			type: "status",
			message: `Starting agent loop (model: ${model})`,
			ts: Date.now(),
		};
		emit?.(evt);
		yield evt;
	}

	while (true) {
		// Check abort signal
		if (request.signal?.aborted) {
			const evt: Event = { type: "status", message: "Aborted", ts: Date.now() };
			emit?.(evt);
			yield evt;
			break;
		}

		// ── Handle compaction response: extract checkpoint and rebuild context ──
		if (compactionPending) {
			compactionPending = false;
			// Extract text from the last assistant message in the array
			const lastMsg = messages[messages.length - 1] as
				| { role?: string; content?: unknown }
				| undefined;
			let compactionText = "";
			if (lastMsg?.role === "assistant") {
				const content = lastMsg.content;
				if (typeof content === "string") {
					compactionText = content;
				} else if (content === null) {
					compactionText = "";
				} else if (Array.isArray(content)) {
					compactionText = (content as Array<{ type?: string; text?: string }>)
						.filter((b) => b.type === "text")
						.map((b) => b.text ?? "")
						.join("\n");
				}
			}

			const compactGen = processCompaction(
				compactionText,
				cwd,
				preCompactTokenCount,
				emit,
				contextWindow,
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
			const s1: Event = {
				type: "status",
				message: "Context is too short to compact",
				ts: Date.now(),
			};
			emit?.(s1);
			yield s1;
			const s2: Event = { type: "compact_started", taskId: "", ts: Date.now() };
			emit?.(s2);
			yield s2;
			const s3: Event = {
				type: "compact_marker",
				checkpoint: "Context too short for meaningful compaction",
				savedTokens: 0,
				ts: Date.now(),
			};
			emit?.(s3);
			yield s3;
			manualCompactRequested = false;
			continue;
		}
		if (messages.length > 4) {
			let tokenCount = estimatedInputTokens;
			let isEstimated = true;

			if (
				manualCompactRequested ||
				(adapter.supportsTokenCounting
					? estimatedInputTokens >= lazyCountThreshold
					: estimatedInputTokens > compressThreshold)
			) {
				if (
					!manualCompactRequested &&
					adapter.supportsTokenCounting &&
					adapter.countTokens
				) {
					const result = await adapter.countTokens({
						model,
						system: request.systemPrompt ?? "",
						messages,
						tools: allTools,
					});
					tokenCount = result;
					isEstimated = false;
				}
			}

			if (
				manualCompactRequested ||
				(!isEstimated && tokenCount > compressThreshold) ||
				(!adapter.supportsTokenCounting &&
					estimatedInputTokens > compressThreshold)
			) {
				const cs1: Event = {
					type: "compact_started",
					taskId: "",
					ts: Date.now(),
				};
				emit?.(cs1);
				yield cs1;
				const compactStatusMsg = manualCompactRequested
					? "Manual compaction triggered"
					: `Compressing conversation (${adapter.supportsTokenCounting ? "" : "est. "}${tokenCount} tokens, threshold: ${compressThreshold})`;
				const cs2: Event = {
					type: "status",
					message: compactStatusMsg,
					ts: Date.now(),
				};
				emit?.(cs2);
				yield cs2;
				// Inject summarization instruction as a user message
				const summarizationInstruction = buildSummarizationInstruction(cwd);
				(messages as Array<{ role: string; content: string }>).push({
					role: "user",
					content: summarizationInstruction,
				});
				if (emit) {
					emit({
						type: "summarization_request",
						instruction: summarizationInstruction,
						ts: Date.now(),
					});
				}
				compactionPending = true;
				preCompactTokenCount = adapter.supportsTokenCounting
					? tokenCount
					: estimatedInputTokens;
				// Fall through to the normal API call — the model will generate the checkpoint
			}
		}

		turns++;

		// ── Call provider API ──
		const apiGen = adapter.callAPI({
			model,
			messages,
			tools: allTools,
			systemPrompt: request.systemPrompt ?? "",
			maxTokens: DEFAULT_MAX_TOKENS,
			signal: request.signal,
			isCompacting: compactionPending,
		});

		let response: unknown;
		let apiStep = await apiGen.next();
		while (!apiStep.done) {
			// Forward text_delta events from streaming — emit for broadcast
			const streamEvent = apiStep.value;
			if (streamEvent.type === "text_delta" && emit) {
				emit({
					type: "text_delta",
					content: streamEvent.content,
					ts: Date.now(),
				});
			}
			yield streamEvent;
			apiStep = await apiGen.next();
		}
		response = apiStep.value;

		// ── Process response ──
		const usage = adapter.getTokenUsage(response);
		totalInputTokens += usage.inputTokens;
		totalOutputTokens += usage.outputTokens;
		totalCacheCreationTokens += usage.cacheCreationTokens ?? 0;
		totalCacheReadTokens += usage.cacheReadTokens ?? 0;
		estimatedInputTokens = usage.totalContextTokens + usage.outputTokens;

		const usageEvt: Event = {
			type: "usage",
			inputTokens: usage.totalContextTokens,
			contextWindow,
			ts: Date.now(),
		};
		emit?.(usageEvt);
		yield usageEvt;

		// Extract text and tool uses from response
		const responseText = adapter.getResponseText(response);
		if (responseText) {
			lastText = responseText;
			if (!compactionPending) {
				// assistant_text is also emitted via buildResponseEvents — this yield
				// is only for consumer loop advancement
				yield { type: "assistant_text", content: responseText, ts: Date.now() };
			}
		}

		const toolUses = compactionPending ? [] : adapter.getToolUses(response);
		if (!compactionPending) {
			for (const tu of toolUses) {
				// tool_call is also emitted via buildResponseEvents — yield for control flow
				yield {
					type: "tool_call",
					tool: tu.name,
					toolCallId: tu.id,
					input: tu.input,
					ts: Date.now(),
				};
			}
		}

		// Add assistant message to history
		adapter.addAssistantMessage(messages, response, compactionPending);

		// Emit individual Events for each content block
		if (emit) {
			const contentEvents = adapter.buildResponseEvents(
				response,
				compactionPending,
			);
			for (const evt of contentEvents) {
				emit(evt);
			}
		}

		// If compaction is pending, skip tool execution and continue to next iteration
		// where the checkpoint will be extracted and context rebuilt
		if (compactionPending) {
			continue;
		}

		// ── Handle end_turn (no tool use) — enter implicit yield ──
		const stopReason = adapter.getStopReason(response);
		if (stopReason === "end_turn" || toolUses.length === 0) {
			if (!queue) {
				const noQEvt: Event = {
					type: "status",
					message: "Agent ended turn (no queue for yield)",
					ts: Date.now(),
				};
				emit?.(noQEvt);
				yield noQEvt;
				break;
			}

			const idleStatusEvt: Event = {
				type: "status",
				message:
					"Agent ended turn — entering idle state (waiting for messages)",
				ts: Date.now(),
			};
			emit?.(idleStatusEvt);
			yield idleStatusEvt;

			const yieldGen = handleImplicitYield(queue, emit);
			let yieldStep = await yieldGen.next();
			while (!yieldStep.done) {
				yield yieldStep.value;
				yieldStep = await yieldGen.next();
			}
			const yieldResult = yieldStep.value;

			if (yieldResult === null) {
				// Queue closed — normal exit path. Use direct return (Bun async generator hang workaround).
				const cost = adapter.computeCost(
					model,
					totalInputTokens,
					totalOutputTokens,
					totalCacheCreationTokens,
					totalCacheReadTokens,
				);
				const buildResult = adapter.buildResult ?? defaultBuildResult;
				return buildResult({
					success: true,
					output: lastText,
					costUsd: cost,
					turns,
					sessionId,
					totalInputTokens,
					totalOutputTokens,
					totalCacheCreationTokens,
					totalCacheReadTokens,
				});
			}

			if (yieldResult.manualCompactRequested) {
				manualCompactRequested = true;
			}
			if (yieldResult.compactOnly) {
				continue;
			}

			// Inject messages as a new user turn and continue the loop
			const implicitYieldMsg = adapter.buildImplicitYieldMessage(
				yieldResult.formatted,
				yieldResult.nonCompact,
			);
			messages.push(implicitYieldMsg);

			// Emit queue events and messages_consumed
			if (emit) {
				recordQueueEvents(emit, yieldResult.nonCompact);
			}
			continue;
		}

		// ── Execute tools concurrently ──
		const execResults = await Promise.all(
			toolUses.map(async (toolUse) => {
				// OpenAI needs JSON.parse for arguments — handled in getToolUses already
				return executeToolUnified(
					toolUse.name,
					toolUse.input,
					mcpHandlers,
					cwd,
					request.cwd,
					sessionId,
					queue,
				);
			}),
		);

		// Update cwd if bash tool changed it
		for (const exec of execResults) {
			if (exec.cwd) {
				cwd = exec.cwd;
			}
		}

		// Yield tool_result events for consumer loop (full events emitted via buildToolResultEvents below)
		for (let i = 0; i < toolUses.length; i++) {
			const toolUse = toolUses[i] as ProviderToolUse;
			const exec = execResults[i] as ToolExecResult;
			const images = collectToolResultImages(exec);
			yield {
				type: "tool_result" as const,
				tool: toolUse.name,
				toolCallId: toolUse.id,
				content: exec.content.slice(0, 500),
				isError: exec.isError,
				...(images.length > 0 ? { images } : {}),
				...(exec.backgroundId ? { backgroundId: exec.backgroundId } : {}),
				...(exec.backgroundCommand
					? { backgroundCommand: exec.backgroundCommand }
					: {}),
				ts: Date.now(),
			};
		}

		// Cancellation point: drain queue
		let cancellationQueueMsgs: QueueMessage[] = [];
		let cancellationFormatted = "";
		if (queue) {
			const drained = drainQueueAtCancellationPoint(queue);
			if (drained) {
				if (drained.manualCompactRequested) {
					manualCompactRequested = true;
				}
				if (drained.messages.length > 0) {
					cancellationQueueMsgs = drained.messages;
					cancellationFormatted = drained.formatted;
				}
			}
		}

		// Build tool result messages (provider-specific format) and push to history
		const toolResultMsgs = adapter.buildToolResultsMessage({
			toolUses,
			execResults,
			cancellationQueueMsgs,
			cancellationFormatted,
		});
		for (const msg of toolResultMsgs) {
			messages.push(msg);
		}

		// Emit individual tool_result Events
		if (emit) {
			const toolEvents = buildToolResultEvents(
				toolUses.map((tu) => ({ id: tu.id })),
				execResults,
				cancellationQueueMsgs,
			);
			for (const evt of toolEvents) {
				emit(evt);
			}
		}

		// If queue was closed during tool execution (done() was called),
		// exit after recording events but before sending results to the API.
		if (queue?.isClosed) {
			const cost = adapter.computeCost(
				model,
				totalInputTokens,
				totalOutputTokens,
				totalCacheCreationTokens,
				totalCacheReadTokens,
			);
			const buildResult2 = adapter.buildResult ?? defaultBuildResult;
			return buildResult2({
				success: true,
				output: lastText,
				costUsd: cost,
				turns,
				sessionId,
				totalInputTokens,
				totalOutputTokens,
				totalCacheCreationTokens,
				totalCacheReadTokens,
			});
		}

		// Budget check
		if (request.budgetUsd && request.budgetUsd > 0) {
			const runningCost = adapter.computeCost(
				model,
				totalInputTokens,
				totalOutputTokens,
				totalCacheCreationTokens,
				totalCacheReadTokens,
			);
			const budgetResult = checkBudget(request.budgetUsd, runningCost);
			if (budgetResult) {
				messages.push({
					role: "user" as const,
					content: budgetResult.warning,
				});
				recordBudgetWarning(emit, budgetResult.warning);
				const bwEvt: Event = {
					type: "status",
					message: budgetResult.warning,
					ts: Date.now(),
				};
				emit?.(bwEvt);
				yield bwEvt;
			}
		}
	}

	const finalCost = adapter.computeCost(
		model,
		totalInputTokens,
		totalOutputTokens,
		totalCacheCreationTokens,
		totalCacheReadTokens,
	);

	const buildResultFinal = adapter.buildResult ?? defaultBuildResult;
	return buildResultFinal({
		success: true,
		output: lastText,
		costUsd: finalCost,
		turns,
		sessionId,
		totalInputTokens,
		totalOutputTokens,
		totalCacheCreationTokens,
		totalCacheReadTokens,
	});
}
