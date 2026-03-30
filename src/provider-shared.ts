/**
 * Shared provider logic: the unified run loop and provider adapter interface.
 * Both providers import these to avoid code duplication.
 *
 * The unified `runProviderLoop()` is the single run loop used by both providers.
 * Each provider implements a `ProviderAdapter` interface with hooks for the
 * API-specific operations (message format, API call, response parsing, etc.).
 *
 * Split modules:
 * - Tool execution + transient error detection: see ./tool-execution.ts
 * - Queue utilities (images, formatting, drain): see ./queue-utils.ts
 * - Budget management: see ./budget.ts
 * - Compaction logic: see ./compaction.ts
 * - Event converter walker: see ./event-converter.ts
 * - Zod-to-JSON-Schema: see ./zod-schema.ts
 */
import type { AgentRequest } from "./agent-provider.ts";
import { checkBudget, recordBudgetWarning } from "./budget.ts";
import {
	buildSummarizationInstruction,
	getCompactionThresholds,
	processCompaction,
} from "./compaction.ts";
import { type Event, queueMessageToEvent } from "./events.ts";
import type { MessageQueue, QueueMessage } from "./message-queue.ts";
import {
	drainQueueAtCancellationPoint,
	formatQueueMessagesWithHeaders,
	recordQueueEvents,
} from "./queue-utils.ts";
import type { EventImageData } from "./shared-types.ts";
import { formatQueueMessage } from "./task-utils.ts";
import type { ToolDefinition } from "./tool-definition.ts";
import {
	defaultOuterRetryDelay,
	executeTool,
	isTransientAPIError,
	MAX_OUTER_RETRIES,
} from "./tool-execution.ts";
import type { AgentResult, ExitReason } from "./types.ts";

// ── Re-exports for backward compatibility ──
// These symbols were originally defined here. Re-export so existing importers
// don't need to change their import paths.

export {
	extractQueueImageParts,
	extractQueueImages,
} from "./queue-utils.ts";
// ToolResult: unified tool execution result type. Canonical definition in shared-types.ts.
// Re-exported here for consumers that imported ToolExecResult from provider-shared.
export type { ToolResult } from "./shared-types.ts";
export { executeTool, isTransientAPIError } from "./tool-execution.ts";

// ── Constants ──

const DEFAULT_MAX_TOKENS = 16384;

// ── Implicit yield (end_turn with queue) ──

/**
 * Shared implicit yield logic: wait for messages on queue, format them, emit events.
 * Returns the formatted messages and images, or null if queue was closed.
 *
 * Events (agent_idle, agent_active) are emitted directly via the emit callback —
 * they don't need to be yielded since consumers of the provider generator ignore
 * intermediate events (they only care about driving the generator and the final AgentResult).
 */
async function handleImplicitYield(
	queue: MessageQueue,
	emit?: (event: Event) => void,
): Promise<{
	formatted: string;
	nonCompact: QueueMessage[];
	manualCompactRequested: boolean;
	compactOnly: boolean;
} | null> {
	const idleEvt: Event = {
		type: "agent_idle",
		taskId: "",
		ts: Date.now(),
	};
	emit?.(idleEvt);
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

// ── Event emission helpers ──

/**
 * Collect images for the UI tool_result event from execution result.
 * When `_formattedQueueMessages` is set, mcpImages are user queue images
 * — they go alongside the queue text, not in the tool_result.
 */
function collectToolResultImages(exec: ToolResult): EventImageData[] {
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
	execResults: ToolResult[],
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
		const exec = execResults[idx] as ToolResult;

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
		systemPrompt: import("./system-prompts.ts").SystemPrompt;
		maxTokens: number;
		signal?: AbortSignal;
		isCompacting: boolean;
		/** True for root orchestrator sessions (depth 0). Affects cache TTL strategy. */
		isOrchestrator?: boolean;
		/** Session ID for test mock conversation keying. */
		sessionId?: string;
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
		execResults: ToolResult[];
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
	 * Get the delay (in ms) before the outer retry of a failed API call.
	 * Called when callAPI throws after exhausting its own internal retries.
	 * Optional — defaults to exponential backoff (30s, 60s, 120s).
	 */
	getOuterRetryDelayMs?(attempt: number, error: unknown): number;

	/**
	 * Build the final AgentResult. Optional — default returns base fields.
	 * Override to include provider-specific fields (e.g. Anthropic cache tokens).
	 */
	buildResult?(params: {
		exitReason: ExitReason;
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

// ── Import ToolResult type for use in this file ──
import type { ToolResult } from "./shared-types.ts";

/** Default buildResult — used when adapter doesn't override. */
function defaultBuildResult(params: {
	exitReason: ExitReason;
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
		exitReason: params.exitReason,
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

		// Build user content from the queue message(s).
		// All messages go through formatQueueMessage for consistent formatting
		// (includes [HH:MM:SS] prefix) between live path and JSONL reconstruction.
		const firstUserContent = allMsgs.map(formatQueueMessage).join("\n\n");

		// On resume from a crash during tool execution, the last reconstructed message
		// may be a user message (tool_result). Appending another user message would
		// violate the Anthropic API's strict role alternation. Instead, combine queue
		// content into the existing last user message as additional text blocks.
		const lastMsg = messages[messages.length - 1] as
			| { role: string; content: unknown }
			| undefined;
		if (lastMsg && lastMsg.role === "user" && Array.isArray(lastMsg.content)) {
			// Last message is a user message with content blocks (e.g., tool_results).
			// Append queue text as additional text blocks.
			(lastMsg.content as unknown[]).push({
				type: "text",
				text: firstUserContent,
			});
		} else if (
			lastMsg &&
			lastMsg.role === "user" &&
			typeof lastMsg.content === "string"
		) {
			// Last message is a plain string user message — combine as string.
			lastMsg.content = `${lastMsg.content}\n\n${firstUserContent}`;
		} else {
			// Normal case: no prior user message, push new one.
			messages.push({ role: "user" as const, content: firstUserContent });
		}

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
	// Track whether done() was called during tool execution.
	// Set when doneToolUse is detected in the current turn's tool batch.
	// Used to determine exitReason on loop exit.
	let doneExitReason: ExitReason | null = null;
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
			const yieldResult = await handleImplicitYield(queue, emit);

			if (yieldResult === null) {
				// Queue closed — exit (stop/reset during yield = interrupted)
				const cost = adapter.computeCost(
					model,
					totalInputTokens,
					totalOutputTokens,
					totalCacheCreationTokens,
					totalCacheReadTokens,
				);
				const exitReason = doneExitReason ?? "interrupted";
				const buildResult = adapter.buildResult ?? defaultBuildResult;
				return buildResult({
					exitReason,
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

				// Refresh session_config after compaction — updates date, tools if changed.
				// compact_marker was already emitted by processCompaction; session_config
				// follows it so readActive() sees the fresh config for this segment.
				if (emit) {
					const freshPrompt = request.refreshSystemPrompt
						? request.refreshSystemPrompt()
						: request.systemPrompt;
					if (freshPrompt) {
						const sessionConfigEvt: Event = {
							type: "session_config",
							tools: allTools,
							systemStable: freshPrompt.stable,
							systemVariable: freshPrompt.variable,
							taskId: "",
							ts: Date.now(),
						} as Event;
						emit(sessionConfigEvt);
					}
				}
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
					const sp = request.systemPrompt ?? { stable: "", variable: "" };
					const result = await adapter.countTokens({
						model,
						system: `${sp.stable}\n\n${sp.variable}`,
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

		// ── Call provider API (with outer retry for transient errors) ──
		// The adapter's callAPI has its own internal retry loop (e.g., 5 attempts).
		// This outer retry catches errors that propagate after internal retries are
		// exhausted, giving the agent a longer recovery window for persistent transient
		// errors (rate limits during high load, prolonged outages).
		let response: unknown;
		for (let outerAttempt = 0; ; outerAttempt++) {
			try {
				const apiGen = adapter.callAPI({
					model,
					messages,
					tools: allTools,
					systemPrompt: request.systemPrompt ?? { stable: "", variable: "" },
					maxTokens: DEFAULT_MAX_TOKENS,
					signal: request.signal,
					isCompacting: compactionPending,
					isOrchestrator: request.isOrchestrator,
					sessionId,
				});

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
				break; // Success — exit retry loop
			} catch (e) {
				if (!isTransientAPIError(e) || outerAttempt >= MAX_OUTER_RETRIES) {
					throw e; // Non-transient or retries exhausted — let it propagate
				}
				const delay = adapter.getOuterRetryDelayMs
					? adapter.getOuterRetryDelayMs(outerAttempt, e)
					: defaultOuterRetryDelay(outerAttempt);
				const errMsg = e instanceof Error ? e.message : String(e);
				const retryEvt: Event = {
					type: "error",
					taskId: "",
					message: `API call failed (outer retry ${outerAttempt + 1}/${MAX_OUTER_RETRIES}, waiting ${Math.round(delay / 1000)}s): ${errMsg}`,
					ts: Date.now(),
				};
				emit?.(retryEvt);
				yield retryEvt;
				await new Promise((r) => setTimeout(r, delay));
			}
		}

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
		// end_turn ALWAYS means implicit yield, never implicit done.
		const stopReason = adapter.getStopReason(response);
		if (stopReason === "end_turn" || toolUses.length === 0) {
			if (!queue) {
				// No queue = can't yield. Return as interrupted (not success).
				const noQCost = adapter.computeCost(
					model,
					totalInputTokens,
					totalOutputTokens,
					totalCacheCreationTokens,
					totalCacheReadTokens,
				);
				const noQExitReason = doneExitReason ?? "interrupted";
				const noQBuildResult = adapter.buildResult ?? defaultBuildResult;
				return noQBuildResult({
					exitReason: noQExitReason,
					output: lastText,
					costUsd: noQCost,
					turns,
					sessionId,
					totalInputTokens,
					totalOutputTokens,
					totalCacheCreationTokens,
					totalCacheReadTokens,
				});
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

			const yieldResult = await handleImplicitYield(queue, emit);

			if (yieldResult === null) {
				// Queue closed during implicit yield (stop/reset = interrupted).
				const cost = adapter.computeCost(
					model,
					totalInputTokens,
					totalOutputTokens,
					totalCacheCreationTokens,
					totalCacheReadTokens,
				);
				const exitReason = doneExitReason ?? "interrupted";
				const buildResult = adapter.buildResult ?? defaultBuildResult;
				return buildResult({
					exitReason,
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

		// ── Check for yield/done/fork conflicts with other tools in same turn ──
		const yieldToolUse = toolUses.find(
			(tu) => tu.name === "mcp__opengraft__yield",
		);
		const doneToolUse = toolUses.find(
			(tu) => tu.name === "mcp__opengraft__done",
		);
		const otherToolUses = toolUses.filter(
			(tu) =>
				tu.name !== "mcp__opengraft__yield" &&
				tu.name !== "mcp__opengraft__done" &&
				tu.name !== "mcp__opengraft__fork_task_context",
		);
		const hasOtherTools = otherToolUses.length > 0;

		// Yield alone: loop-level pause (existing behavior)
		if (yieldToolUse && !hasOtherTools && !doneToolUse) {
			pendingYieldToolCall = { id: yieldToolUse.id, name: yieldToolUse.name };
			continue;
		}

		// ── Execute tools concurrently ──
		// When yield/done appear alongside other tools:
		// - Other tools execute normally
		// - yield returns success (no-op — other tool results ARE the "messages")
		// - done returns error (can't finish without seeing other tools' results)
		const execResults = await Promise.all(
			toolUses.map(async (toolUse) => {
				// yield + other tools: yield becomes no-op success
				if (toolUse.name === "mcp__opengraft__yield" && hasOtherTools) {
					return {
						content:
							"yield() ignored — other tools in the same turn produced results. Process them first.",
						isError: false,
					} satisfies ToolResult;
				}
				// done + other tools: done returns error
				if (toolUse.name === "mcp__opengraft__done" && hasOtherTools) {
					return {
						content:
							"Cannot call done() alongside other tools — you must process their results first before finishing.",
						isError: true,
					} satisfies ToolResult;
				}
				// fork + other tools: fork returns error (fork must be sole tool
				// to ensure clean event state — like unix fork(), no race conditions)
				if (
					toolUse.name === "mcp__opengraft__fork_task_context" &&
					hasOtherTools
				) {
					return {
						content:
							"Cannot call fork_task_context alongside other tools — fork must be the only tool in the turn to ensure clean event state.",
						isError: true,
					} satisfies ToolResult;
				}
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
			const exec = execResults[i] as ToolResult;
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

		// Detect done() was successfully executed (not errored or conflicting with other tools).
		// done() handler already updated tracker status + delivered task_complete.
		// We just need to record the exit reason for the loop's return value.
		// Only set doneExitReason if the tool execution succeeded (isError = false).
		if (doneToolUse && !hasOtherTools) {
			const doneIndex = toolUses.indexOf(doneToolUse);
			const doneResult = execResults[doneIndex] as ToolResult | undefined;
			if (doneResult && !doneResult.isError) {
				const doneInput = doneToolUse.input as { status?: string } | undefined;
				doneExitReason =
					doneInput?.status === "passed" ? "done_passed" : "done_failed";
			}
		}

		// If queue was closed during tool execution (done() was called for child agents),
		// exit after recording events but before sending results to the API.
		if (queue?.isClosed) {
			const cost = adapter.computeCost(
				model,
				totalInputTokens,
				totalOutputTokens,
				totalCacheCreationTokens,
				totalCacheReadTokens,
			);
			const exitReason = doneExitReason ?? "interrupted";
			const buildResult2 = adapter.buildResult ?? defaultBuildResult;
			return buildResult2({
				exitReason,
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

	// Loop exited via break (abort signal). This is an interrupted exit unless done() was called earlier.
	const finalExitReason = doneExitReason ?? "interrupted";
	const buildResultFinal = adapter.buildResult ?? defaultBuildResult;
	return buildResultFinal({
		exitReason: finalExitReason,
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
