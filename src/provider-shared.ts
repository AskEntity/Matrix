/**
 * Shared provider logic extracted from anthropic-compatible-provider.ts and
 * openai-compatible-provider.ts. Both providers import these helpers to avoid
 * code duplication.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent } from "./agent-provider.ts";
import { formatQueueMessage, toRawMessage } from "./agent-tools.ts";
import type { EventStore } from "./event-store.ts";
import { type Event, queueMessageToEvent } from "./events.ts";
import type { MessageQueue, QueueMessage } from "./message-queue.ts";
import type { ToolDefinition } from "./tool-definition.ts";
import { executeTool } from "./tools/index.ts";

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
export async function* handleImplicitYield(queue: MessageQueue): AsyncGenerator<
	AgentEvent,
	{
		formatted: string;
		nonCompact: QueueMessage[];
		manualCompactRequested: boolean;
		compactOnly: boolean;
	} | null
> {
	yield { type: "agent_idle" };
	try {
		queue.idle = true;
		const first = await queue.wait();
		queue.idle = false;
		yield { type: "agent_active" };
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
		yield {
			type: "queue_message",
			messages: formatted,
			rawMessages: nonCompact.map(toRawMessage),
		};
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

// ── EventStore recording helpers ──

/**
 * Record queue events and messages_consumed event to EventStore.
 * Handles the two-phase message lifecycle: user messages with IDs are already
 * written at send time — just track their IDs. Other messages get converted.
 */
export function recordQueueEvents(
	eventStore: EventStore,
	sessionId: string,
	queueMsgs: QueueMessage[],
	additionalConsumedIds?: string[],
): void {
	const newEvents: Event[] = [];
	const consumedIds: string[] = [...(additionalConsumedIds ?? [])];

	for (const msg of queueMsgs) {
		if (msg.source === "user" && msg.id) {
			// message already written to JSONL at send time — don't duplicate
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
 * Build tool_result events for EventStore recording.
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
	eventStore: EventStore | undefined,
	sessionId: string,
	contextWindow: number,
	compressThreshold: number,
): AsyncGenerator<
	AgentEvent,
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

		yield {
			type: "usage",
			inputTokens: estimatedPostCompactTokens,
			compressThreshold,
			contextWindow,
			estimated: true,
		};
		yield {
			type: "compact",
			checkpoint,
			savedTokens: compactSavedTokens,
		};

		return { userContent, estimatedInputTokens: estimatedPostCompactTokens };
	} catch (e) {
		yield {
			type: "error",
			message: `Compaction rebuild failed: ${e instanceof Error ? e.message : String(e)}`,
		};
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
 * Record a budget warning to EventStore and yield status.
 */
export function recordBudgetWarning(
	eventStore: EventStore | undefined,
	sessionId: string,
	warning: string,
): void {
	if (eventStore) {
		eventStore.append(sessionId, {
			type: "budget_warning",
			warning,
			ts: Date.now(),
		});
	}
}
