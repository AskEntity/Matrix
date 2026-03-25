/**
 * Shared provider logic: the unified run loop, tool execution, queue handling,
 * and budget management. Both providers import these to avoid code duplication.
 *
 * The unified `runProviderLoop()` is the single run loop used by both providers.
 * Each provider implements a `ProviderAdapter` interface with hooks for the
 * API-specific operations (message format, API call, response parsing, etc.).
 *
 * Compaction logic: see ./compaction.ts
 * Event converter walker: see ./event-converter.ts
 * Zod-to-JSON-Schema: see ./zod-schema.ts
 */
import type { AgentRequest } from "./agent-provider.ts";
import {
	buildSummarizationInstruction,
	getCompactionThresholds,
	processCompaction,
} from "./compaction.ts";
import { type Event, queueMessageToEvent } from "./events.ts";
import type { MessageQueue, QueueMessage } from "./message-queue.ts";
import type {
	EventImageData,
	InternalToolResult,
	PendingState,
} from "./shared-types.ts";
import { formatQueueMessage } from "./task-utils.ts";
import type { ToolDefinition } from "./tool-definition.ts";
import type { AgentResult } from "./types.ts";

// ── Constants ──

const DEFAULT_MAX_TOKENS = 16384;

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
	mcpImages?: Array<EventImageData & { data?: string }>;
	/** User message IDs consumed (already persisted at send time). */
	consumedMessageIds?: string[];
	/** Raw queue messages from yield/done that need to flow through emit for SSE broadcast + persistence. */
	consumedQueueMessages?: QueueMessage[];
	/** Formatted text of all consumed queue messages for display. */
	formattedQueueMessages?: string;
	/** Structured pending state after yield/done. */
	pending?: PendingState;
}

/**
 * Execute a single tool via its handler.
 * ALL tools (built-in + orchestrator + external MCP) go through this single path.
 * Returns a unified ToolExecResult.
 */
export async function executeTool(
	toolName: string,
	input: Record<string, unknown>,
	// biome-ignore lint/suspicious/noExplicitAny: ToolDefinition generic varies
	mcpHandlers: Map<string, ToolDefinition<any>>,
	toolCallId?: string,
): Promise<ToolExecResult> {
	const mcpHandler = mcpHandlers.get(toolName);
	if (!mcpHandler) {
		return {
			content: `Unknown tool: ${toolName}`,
			isError: true,
		};
	}

	try {
		const mcpResult = await mcpHandler.handler(input, { toolCallId });
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
		// Extract non-standard properties from handler results.
		// InternalToolResult has typed fields — no `as any` needed.
		const r = mcpResult as InternalToolResult;

		return {
			content: textParts.join("\n"),
			isError: mcpResult.isError ?? false,
			isImage: r.isImage ?? mcpImages.length > 0,
			...(r.cwd ? { cwd: r.cwd } : {}),
			...(r.backgroundId ? { backgroundId: r.backgroundId } : {}),
			...(r.backgroundCommand
				? { backgroundCommand: r.backgroundCommand }
				: {}),
			...(r.imageData ? { imageData: r.imageData } : {}),
			...(r.mediaType ? { mediaType: r.mediaType } : {}),
			mcpImages,
			...(r.consumedMessageIds?.length
				? { consumedMessageIds: r.consumedMessageIds }
				: {}),
			...(r.consumedQueueMessages?.length
				? { consumedQueueMessages: r.consumedQueueMessages }
				: {}),
			...(r.pending ? { pending: r.pending } : {}),
			...(r.formattedQueueMessages
				? { formattedQueueMessages: r.formattedQueueMessages }
				: {}),
		};
	} catch (e) {
		return {
			content: `Tool error (${toolName}): ${e instanceof Error ? e.message : String(e)}`,
			isError: true,
		};
	}
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
async function* handleImplicitYield(
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
	const idleEvt: Event = {
		type: "agent_idle",
		taskId: "",
		ts: Date.now(),
	};
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

/**
 * Format queue messages with headers extracted to message level.
 * For user messages: header placed before raw content (not via formatQueueMessage which embeds header).
 * For task_messages with header: header placed before the XML-formatted content (sans header).
 * Other messages: formatted normally via formatQueueMessage.
 */
function formatQueueMessagesWithHeaders(msgs: QueueMessage[]): string {
	const parts: string[] = [];
	for (const msg of msgs) {
		if (msg.source === "user" && msg.header) {
			parts.push(msg.header);
			parts.push(msg.content);
		} else if (msg.source === "task_message" && msg.header) {
			parts.push(msg.header);
			// Format without header to avoid duplication (formatQueueMessage includes header)
			const stripped = { ...msg, header: undefined };
			parts.push(formatQueueMessage(stripped));
		} else {
			parts.push(formatQueueMessage(msg));
		}
	}
	return parts.join("\n\n");
}

// ── Cancellation point queue drain ──

/**
 * Drain queue at cancellation point (between tool execution and next API call).
 * Returns the queue messages and formatted text, or null if nothing to drain.
 */
function drainQueueAtCancellationPoint(queue: MessageQueue): {
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
function recordQueueEvents(
	emit: (event: Event) => void,
	queueMsgs: QueueMessage[],
	additionalConsumedIds?: string[],
	taskId = "",
): void {
	const consumedIds: string[] = [...(additionalConsumedIds ?? [])];

	for (const msg of queueMsgs) {
		if (msg.source === "user" && msg.id) {
			// message already written to JSONL at send time — don't duplicate
			consumedIds.push(msg.id);
		} else {
			const evt = queueMessageToEvent(msg, taskId);
			const evtId = (evt as { id?: string }).id;
			if (evtId) consumedIds.push(evtId);
			emit(evt);
		}
	}

	if (consumedIds.length > 0) {
		emit({
			type: "messages_consumed",
			messageIds: consumedIds,
			taskId,
			ts: Date.now(),
		});
	}
}

/**
 * Collect images for the UI tool_result event from execution result.
 * When `_formattedQueueMessages` is set, mcpImages are user queue images
 * — they go alongside the queue text, not in the tool_result.
 */
function collectToolResultImages(exec: ToolExecResult): EventImageData[] {
	const images: EventImageData[] = [];
	if (!exec.formattedQueueMessages && exec.mcpImages?.length) {
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
function buildToolResultEvents(
	toolIds: Array<{ id: string; name: string }>,
	execResults: ToolExecResult[],
	cancellationQueueMsgs: QueueMessage[],
	taskId = "",
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
			const evt = queueMessageToEvent(qm, taskId);
			const evtId = (evt as { id?: string }).id;
			if (evtId) consumedIds.push(evtId);
			nonUserQueueEvents.push(evt);
		}
	}

	for (let idx = 0; idx < toolIds.length; idx++) {
		const toolId = toolIds[idx] as { id: string; name: string };
		const exec = execResults[idx] as ToolExecResult;

		// Record pure tool output — queue text is NOT embedded.
		// The converter reconstructs queue messages from messagesConsumed + message events.
		const images: EventImageData[] = [];
		if (!exec.formattedQueueMessages && exec.mcpImages?.length) {
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
			tool: toolId.name,
			toolCallId: toolId.id,
			content: exec.content,
			isError: exec.isError,
			...(images.length > 0 ? { images } : {}),
			...(isLast && exec.pending ? { pending: exec.pending } : {}),
			...(exec.backgroundId ? { backgroundId: exec.backgroundId } : {}),
			...(exec.backgroundCommand
				? { backgroundCommand: exec.backgroundCommand }
				: {}),
			taskId,
			ts: Date.now(),
		});
	}

	// Process queue messages from yield/done tool results (same pattern as cancellation)
	for (const exec of execResults) {
		if (exec.consumedQueueMessages?.length) {
			for (const qm of exec.consumedQueueMessages) {
				if (qm.source === "user" && qm.id) {
					consumedIds.push(qm.id);
				} else {
					const evt = queueMessageToEvent(qm, taskId);
					const evtId = (evt as { id?: string }).id;
					if (evtId) consumedIds.push(evtId);
					nonUserQueueEvents.push(evt);
				}
			}
		}
	}

	// Record non-user queue messages (cancellation + yield/done) as separate Events
	for (const evt of nonUserQueueEvents) {
		toolEvents.push(evt);
	}

	// Record standalone messages_consumed event AFTER tool_results and queue events
	const allConsumedIds = [
		...consumedIds,
		...execResults.flatMap((exec) => exec.consumedMessageIds ?? []),
	];
	if (allConsumedIds.length > 0) {
		toolEvents.push({
			type: "messages_consumed",
			messageIds: allConsumedIds,
			taskId,
			ts: Date.now(),
		});
	}

	return toolEvents;
}

// ── Budget check ──

/**
 * Check budget and inject warnings at 80% and 100% thresholds.
 * Returns warning events and the warning text to inject, if any.
 */
function checkBudget(
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
function recordBudgetWarning(
	emit: ((event: Event) => void) | undefined,
	warning: string,
	taskId = "",
): void {
	if (emit) {
		emit({
			type: "budget_warning",
			warning,
			taskId,
			ts: Date.now(),
		});
	}
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
		/** True for root orchestrator sessions (depth 0). Affects cache TTL strategy. */
		isOrchestrator?: boolean;
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

	// Detect pending yield from JSONL: if last tool_call is yield with no matching result,
	// the agent was in yield state when the daemon restarted. We restore this at loop level
	// instead of writing a synthetic orphan result — yield is a loop-level pause, not a JS await.
	let pendingYieldToolCall: { id: string; name: string } | null = null;
	if (isResume) {
		const lastToolCall = [...activeEvents]
			.reverse()
			.find((e) => e.type === "tool_call");
		if (
			lastToolCall?.type === "tool_call" &&
			lastToolCall.tool === "mcp__opengraft__yield"
		) {
			const hasResult = activeEvents.some(
				(e) =>
					e.type === "tool_result" && e.toolCallId === lastToolCall.toolCallId,
			);
			if (!hasResult) {
				pendingYieldToolCall = {
					id: lastToolCall.toolCallId,
					name: lastToolCall.tool,
				};
			}
		}
	}

	// Drain the queue for messages — both fresh start and resume.
	// Fresh start: first message has header with working dir + pre-loaded memory.
	// Resume: message has header with fresh context (re-read memory from disk).
	// Header is ALWAYS how context gets into the conversation — no special codepaths.
	// Skip initial drain if resuming into yield — messages will be consumed by the yield handler.
	if (queue && !pendingYieldToolCall) {
		// Wait for at least one message in the queue
		const firstMsg = await queue.wait();
		const rest = queue.drain();
		const allMsgs = [firstMsg, ...rest];

		// Build user content from the queue message(s)
		// Header (working dir + memory) goes first, then content
		const parts: string[] = [];
		for (const msg of allMsgs) {
			if (
				msg.source === "user" ||
				(msg.source === "task_message" && msg.header)
			) {
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
			taskId: "",
			ts: Date.now(),
		};
		emit?.(evt);
		yield evt;
	}

	while (true) {
		// ── Handle pending yield (loop-level pause) ──
		// This fires when: (a) resuming from JSONL where last event was yield tool_call,
		// or (b) yield was detected in tool execution and deferred to loop level.
		// Wait for messages, write yield tool_result, then continue to next API call.
		if (pendingYieldToolCall && queue) {
			const yieldGen = handleImplicitYield(queue, emit);
			let yieldStep = await yieldGen.next();
			while (!yieldStep.done) {
				yield yieldStep.value;
				yieldStep = await yieldGen.next();
			}
			const yieldResult = yieldStep.value;

			if (yieldResult === null) {
				// Queue closed — exit
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
				// Emit yield tool_result before compaction to avoid orphan tool_call in JSONL.
				// Without this, the yield tool_call remains unpaired → on resume, converter
				// finds tool_use without tool_result → duplicate tool_result blocks → API 400.
				const compactYieldEvt: Event = {
					type: "tool_result",
					tool: pendingYieldToolCall.name,
					toolCallId: pendingYieldToolCall.id,
					content: "Manual compaction requested",
					isError: false,
					taskId: "",
					ts: Date.now(),
				};
				emit?.(compactYieldEvt);
				yield compactYieldEvt;
				// Push tool_result into messages so compaction sees a paired tool_use/tool_result.
				// Without this, messages has an unpaired tool_use → API 400.
				const compactToolResultMsgs = adapter.buildToolResultsMessage({
					toolUses: [
						{
							id: pendingYieldToolCall.id,
							name: pendingYieldToolCall.name,
							input: {},
						},
					],
					execResults: [
						{
							content: "Manual compaction requested",
							isError: false,
						},
					],
					cancellationQueueMsgs: [],
					cancellationFormatted: "",
				});
				for (const msg of compactToolResultMsgs) {
					messages.push(msg);
				}
				pendingYieldToolCall = null;
				continue;
			}

			// Build yield tool_result with pending section + queue messages as additional
			// text blocks in the same user message. Headers (memory.md + working dir) are
			// stripped from queue messages — they shouldn't appear in tool_result content.
			const pendingSection =
				request.buildYieldPendingSection?.() ??
				"## Pending\n- Running sub tasks: unknown\n- Pending clarifications: none";
			const yieldFormatted = formatQueueMessagesWithHeaders(
				yieldResult.nonCompact,
			);
			const toolResultMsgs = adapter.buildToolResultsMessage({
				toolUses: [
					{
						id: pendingYieldToolCall.id,
						name: pendingYieldToolCall.name,
						input: {},
					},
				],
				execResults: [
					{
						content: pendingSection,
						isError: false,
					},
				],
				cancellationQueueMsgs: yieldResult.nonCompact,
				cancellationFormatted: yieldFormatted,
			});
			for (const msg of toolResultMsgs) {
				messages.push(msg);
			}

			// Emit the yield tool_result event FIRST with FULL content (not truncated).
			// On resume, event converter reads this from JSONL to rebuild the tool_result
			// message — truncation would cause prompt cache misses.
			// tool_result must come before messages_consumed to match normal tool path order.
			const yieldResultEvt: Event = {
				type: "tool_result",
				tool: pendingYieldToolCall.name,
				toolCallId: pendingYieldToolCall.id,
				content: pendingSection,
				isError: false,
				taskId: "",
				ts: Date.now(),
			};
			emit?.(yieldResultEvt);
			yield yieldResultEvt;

			// Emit queue events for consumed messages AFTER tool_result
			if (emit) {
				recordQueueEvents(emit, yieldResult.nonCompact);
			}

			pendingYieldToolCall = null;
			continue;
		}

		// Check abort signal
		if (request.signal?.aborted) {
			const evt: Event = {
				type: "status",
				message: "Aborted",
				taskId: "",
				ts: Date.now(),
			};
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
				taskId: "",
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
				taskId: "",
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
					taskId: "",
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
						taskId: "",
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
			isOrchestrator: request.isOrchestrator,
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
					taskId: "",
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
			taskId: "",
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
				yield {
					type: "assistant_text",
					content: responseText,
					taskId: "",
					ts: Date.now(),
				};
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
					taskId: "",
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
					taskId: "",
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
				taskId: "",
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
				// No tool_result needed here — this is the end-of-turn path (assistant ended
				// turn without tool calls), so there's no pendingYieldToolCall to pair.
				continue;
			}

			// Inject messages as a new user turn and continue the loop.
			// Headers extracted to message level (defense-in-depth — headers shouldn't
			// be present during running sessions, but strip them if they are).
			const endTurnFormatted = formatQueueMessagesWithHeaders(
				yieldResult.nonCompact,
			);
			const implicitYieldMsg = adapter.buildImplicitYieldMessage(
				endTurnFormatted,
				yieldResult.nonCompact,
			);
			messages.push(implicitYieldMsg);

			// Emit queue events and messages_consumed
			if (emit) {
				recordQueueEvents(emit, yieldResult.nonCompact);
			}
			continue;
		}

		// ── Check for yield tool — handle at loop level instead of inside executeTool ──
		const yieldToolUse = toolUses.find(
			(tu) => tu.name === "mcp__opengraft__yield",
		);
		if (yieldToolUse) {
			// Yield is a loop-level pause: set pendingYield, skip tool execution.
			// The assistant message + tool_call events are already recorded above.
			// The yield result will be produced at the top of the next while(true) iteration
			// when messages arrive in the queue. This makes yield state serializable/recoverable.
			pendingYieldToolCall = { id: yieldToolUse.id, name: yieldToolUse.name };
			continue;
		}

		// ── Execute tools concurrently ──
		const execResults = await Promise.all(
			toolUses.map(async (toolUse) => {
				return executeTool(
					toolUse.name,
					toolUse.input,
					mcpHandlers,
					toolUse.id,
				);
			}),
		);

		// Update cwd if bash tool changed it — sync both the loop-local cwd
		// and the session's cwd so handler closures see the new value.
		for (const exec of execResults) {
			if (exec.cwd) {
				cwd = exec.cwd;
				const currentSession = request.getSession?.(sessionId);
				if (currentSession) {
					currentSession.cwd = exec.cwd;
				}
			}
		}

		// Yield tool_result events for consumer loop
		for (let i = 0; i < toolUses.length; i++) {
			const toolUse = toolUses[i] as ProviderToolUse;
			const exec = execResults[i] as ToolExecResult;
			const images = collectToolResultImages(exec);
			yield {
				type: "tool_result" as const,
				tool: toolUse.name,
				toolCallId: toolUse.id,
				content: exec.content,
				isError: exec.isError,
				...(images.length > 0 ? { images } : {}),
				...(exec.backgroundId ? { backgroundId: exec.backgroundId } : {}),
				...(exec.backgroundCommand
					? { backgroundCommand: exec.backgroundCommand }
					: {}),
				taskId: "",
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
				toolUses.map((tu) => ({ id: tu.id, name: tu.name })),
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
					taskId: "",
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
