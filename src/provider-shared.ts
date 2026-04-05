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
 * - Zod-to-JSON-Schema: computed at tool creation time in tool-definition.ts
 */
import type { AgentRequest } from "./agent-provider.ts";
import { checkBudget, recordBudgetWarning } from "./budget.ts";
import {
	buildSummarizationInstruction,
	COMPACTION_MAX_TOKENS,
	getCompactionThresholds,
	processCompaction,
} from "./compaction.ts";
import {
	type Event,
	hasPendingImplicitYield,
	queueMessageToEvent,
} from "./events.ts";
import type { MessageQueue, QueueMessage } from "./message-queue.ts";
import {
	drainQueueAtCancellationPoint,
	recordQueueEvents,
} from "./queue-utils.ts";
import type { EventImageData } from "./shared-types.ts";
import type { ToolDefinition } from "./tool-definition.ts";
import { buildJsonTools, type JsonTool } from "./tool-definition.ts";
import {
	defaultOuterRetryDelay,
	executeTool,
	isTransientAPIError,
	MAX_OUTER_RETRIES,
} from "./tool-execution.ts";
import { TOOL_DONE, TOOL_FORK_TASK_CONTEXT, TOOL_YIELD } from "./tool-names.ts";
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

const DEFAULT_MAX_TOKENS = 128000;

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
				nonCompact: [],
				manualCompactRequested,
				compactOnly: true,
			};
		}
		return {
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
 * Prefers mcpImages (from external MCP tools) over direct imageData (built-in read_file).
 */
function collectToolResultImages(exec: ToolResult): EventImageData[] {
	const images: EventImageData[] = [];
	if (exec.mcpImages?.length) {
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

// ── Image validation helpers ──

const IMAGE_REJECTED_PREFIX = "[Image rejected: ";
const IMAGE_REJECTED_SUFFIX =
	". Use bash to resize: `magick <file> -resize 4000x4000\\> <file>`]";

/**
 * Validate a single image against the provider's limits.
 * Returns the rejection reason text, or null if the image is acceptable.
 */
function checkImage(
	adapter: ProviderAdapter,
	base64: string,
	mediaType: string,
): string | null {
	if (!adapter.validateImage) return null;
	const result = adapter.validateImage(base64, mediaType);
	if (result.ok) return null;
	return `${IMAGE_REJECTED_PREFIX}${result.reason}${IMAGE_REJECTED_SUFFIX}`;
}

/**
 * Filter oversized images from tool execution results before they reach provider code.
 * Replaces oversized images with error text in-place on the ToolResult objects.
 */
export function filterExecResultImages(
	adapter: ProviderAdapter,
	execResults: ToolResult[],
): void {
	if (!adapter.validateImage) return;
	for (const exec of execResults) {
		// Direct image result (e.g. from read_file on an image)
		if (exec.isImage && exec.imageData && exec.mediaType) {
			const rejection = checkImage(adapter, exec.imageData, exec.mediaType);
			if (rejection) {
				exec.content = rejection;
				exec.isImage = false;
				exec.imageData = undefined;
				exec.mediaType = undefined;
			}
		}
		// MCP images (from external MCP tools)
		if (exec.mcpImages?.length) {
			exec.mcpImages = exec.mcpImages.filter((img) => {
				const data = img.base64 ?? img.data ?? "";
				const rejection = checkImage(adapter, data, img.mediaType);
				if (rejection) {
					// Append rejection text to the tool result content
					exec.content = exec.content
						? `${exec.content}\n${rejection}`
						: rejection;
					return false; // Remove this image
				}
				return true; // Keep this image
			});
		}
	}
}

/**
 * Filter oversized images from queue messages before they reach provider code.
 * Replaces oversized images with error text in-place on user QueueMessages.
 */
export function filterQueueMessageImages(
	adapter: ProviderAdapter,
	msgs: QueueMessage[],
): void {
	if (!adapter.validateImage) return;
	for (const msg of msgs) {
		if (msg.source === "user" && msg.images?.length) {
			msg.images = msg.images.filter((img) => {
				const rejection = checkImage(adapter, img.base64, img.mediaType);
				if (rejection) {
					msg.content = msg.content
						? `${msg.content}\n${rejection}`
						: rejection;
					return false;
				}
				return true;
			});
			if (msg.images.length === 0) {
				msg.images = undefined;
			}
		}
	}
}

/**
 * Filter oversized images from JSONL events before resume reconstruction.
 * Returns a new events array with oversized images stripped from tool_result
 * and message events, replaced with error text.
 */
export function filterEventImages(
	adapter: ProviderAdapter,
	events: Event[],
): Event[] {
	if (!adapter.validateImage) return events;
	return events.map((event) => {
		if (event.type === "tool_result" && event.images?.length) {
			const filteredImages: EventImageData[] = [];
			let content = event.content;
			for (const img of event.images) {
				const rejection = checkImage(adapter, img.base64, img.mediaType);
				if (rejection) {
					content = content ? `${content}\n${rejection}` : rejection;
				} else {
					filteredImages.push(img);
				}
			}
			if (filteredImages.length !== event.images.length) {
				return {
					...event,
					content,
					images: filteredImages.length > 0 ? filteredImages : undefined,
				};
			}
		}
		if (event.type === "message" && event.body.source === "user") {
			const userBody = event.body;
			if (userBody.images?.length) {
				const filteredImages: Array<{ base64: string; mediaType: string }> = [];
				let content = userBody.content;
				for (const img of userBody.images) {
					const rejection = checkImage(adapter, img.base64, img.mediaType);
					if (rejection) {
						content = content ? `${content}\n${rejection}` : rejection;
					} else {
						filteredImages.push(img);
					}
				}
				if (filteredImages.length !== userBody.images.length) {
					return {
						...event,
						body: {
							...userBody,
							content,
							images: filteredImages.length > 0 ? filteredImages : undefined,
						},
					};
				}
			}
		}
		return event;
	});
}

/**
 * Build tool_result events for emission.
 * Returns the events array with tool_result events, cancellation queue events,
 * and a messages_consumed event combining all consumed IDs.
 *
 * Exported so providers can delegate buildUserTurn to walker-based reconstruction:
 * construct the same events that will be emitted, then walk them to produce
 * user message(s). This keeps live path and reconstruction path byte-identical
 * by eliminating the duplicate "build user message from tools+queue" rule.
 */
export function buildToolResultEvents(
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
		if (exec.mcpImages?.length) {
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

	// Record non-user queue messages (from cancellation drain) as separate Events
	for (const evt of nonUserQueueEvents) {
		toolEvents.push(evt);
	}

	// Record standalone messages_consumed event AFTER tool_results and queue events
	if (consumedIds.length > 0) {
		toolEvents.push({
			type: "messages_consumed",
			messageIds: consumedIds,
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

	/**
	 * Map provider-agnostic JsonTool[] to provider-specific tool definitions.
	 * JsonTool is the golden source (from session_config). This just reformats:
	 * - Anthropic: { name, description, input_schema }
	 * - OpenAI: { type: "function", name, description, strict: false, parameters }
	 */
	prepareTools(jsonTools: JsonTool[]): unknown[];

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
		/** Cache TTL for message-level cache breakpoints. "1h" for root + persistent. */
		cacheTtl?: "1h";
		/** Session ID for test mock conversation keying. */
		sessionId?: string;
		/**
		 * Absolute file path for pre-API-call debug snapshot. Non-fatal on error.
		 * When set, provider writes the fully-assembled request bytes (post-cache-
		 * control) to this path before each API call, overwriting.
		 */
		debugSnapshotPath?: string;
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
	 * Build the next user turn for the API conversation.
	 * Combines tool results (if any) with queue messages (if any) into provider-specific format:
	 * - Anthropic: single user message with tool_result + text + image blocks
	 * - OpenAI: separate tool messages + user message for images/queue
	 *
	 * When toolUses is empty (implicit yield), returns just the queue message content.
	 * Formatting of queue messages is handled internally — callers pass raw QueueMessage[].
	 */
	buildUserTurn(params: {
		toolUses: ProviderToolUse[];
		execResults: ToolResult[];
		queueMessages: QueueMessage[];
	}): unknown[];

	/**
	 * Append queue messages to an existing messages array (initial drain path).
	 * Called on fresh start / interrupted resume when the run loop has drained
	 * queue messages that need to be injected as user content.
	 *
	 * Must produce byte-identical output to JSONL reconstruction of the same
	 * queue messages — provider must route through its walker's callback logic.
	 * Handles both idle context (push new user message) and working context
	 * (append to existing tool_result user message).
	 */
	appendQueueMessagesToMessages(
		messages: unknown[],
		queueMsgs: QueueMessage[],
	): void;

	/** Compute cost from accumulated token counts. */
	computeCost(
		model: string,
		totalInputTokens: number,
		totalOutputTokens: number,
		totalCacheCreationTokens: number,
		totalCacheReadTokens: number,
	): number;

	/**
	 * Validate an image before it's sent to the API.
	 * Called for every image in tool results, queue messages, and resume events.
	 * Return { ok: true } to accept, { ok: false, reason } to reject.
	 * Rejected images are replaced with error text — never sent to the API.
	 * Optional — if not provided, all images are accepted.
	 */
	validateImage?(
		base64: string,
		mediaType: string,
	): { ok: true } | { ok: false; reason: string };

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
		doneSummary?: string;
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
	doneSummary?: string;
}): AgentResult {
	return {
		exitReason: params.exitReason,
		output: params.output,
		costUsd: params.costUsd,
		turns: params.turns,
		sessionId: params.sessionId,
		inputTokens: params.totalInputTokens,
		outputTokens: params.totalOutputTokens,
		doneSummary: params.doneSummary,
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

	// Reconstruct messages from active events on resume, or start fresh.
	// Filter oversized images from events before conversion — prevents poison
	// images from JSONL entering the API request on resume.
	const messages: unknown[] = isResume
		? adapter.convertEventsToMessages(filterEventImages(adapter, activeEvents))
		: [];

	// Bind live messages array for hidden evaluate_script tool (selfBootstrap).
	request.setMessages?.(messages);

	// Store messages ref on TaskSession for debug dump endpoint.
	const currentSession = request.getSession?.(sessionId);
	if (currentSession) {
		currentSession.messages = messages;
	}

	// Detect pending yield from JSONL: if last tool_call is yield with no matching result,
	// the agent was in yield state when the daemon restarted. We restore this at loop level
	// instead of writing a synthetic orphan result — yield is a loop-level pause, not a JS await.
	let pendingYieldToolCall: { id: string; name: string } | null = null;
	// Extra yield tool_uses from the same turn — their tool_results must be bundled into
	// the REAL yield's user turn (not pushed as a separate user message) to avoid
	// consecutive user messages violating the API's role-alternation rule.
	let pendingDuplicateYieldExtras: Array<{ id: string; name: string }> = [];
	// Yield tool_call that needs its tool_result bundled into the summarization user
	// message (compactOnly path). Set when compact arrives during a pending yield.
	// The yield tool_result is emitted to JSONL immediately (orphan prevention), but
	// the messages[] push is DEFERRED until the compact path builds the summarization
	// turn — otherwise we'd have two consecutive user messages (yield tool_result,
	// then summarization instruction) violating API role alternation.
	let pendingCompactYieldToolCall: { id: string; name: string } | null = null;
	// Detect pending done from JSONL: if last tool_call is done with no matching result,
	// the agent called done() and the loop exited (done is an intended orphan).
	// On wake, write a synthetic tool_result so the message history is well-formed.
	let pendingDoneToolCall: { id: string; name: string } | null = null;
	// Detect pending implicit yield from JSONL: last provider content event is assistant_text
	// (no tool_call after it). The model ended its turn naturally (end_turn) and the agent
	// was in handleImplicitYield waiting for messages when it died. On resume, bypass to
	// handleImplicitYield → block on queue → buildUserTurn → API call.
	let pendingImplicitYieldResume = false;
	if (isResume) {
		const lastToolCall = [...activeEvents]
			.reverse()
			.find((e) => e.type === "tool_call");
		if (
			lastToolCall?.type === "tool_call" &&
			lastToolCall.tool === TOOL_YIELD
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

		// Detect pending done: last tool_call is TOOL_DONE with no result
		if (
			!pendingYieldToolCall &&
			lastToolCall?.type === "tool_call" &&
			lastToolCall.tool === TOOL_DONE
		) {
			const hasResult = activeEvents.some(
				(e) =>
					e.type === "tool_result" && e.toolCallId === lastToolCall.toolCallId,
			);
			if (!hasResult) {
				pendingDoneToolCall = {
					id: lastToolCall.toolCallId,
					name: lastToolCall.tool,
				};
			}
		}

		// Check for implicit yield: last provider content event is assistant_text
		if (!pendingYieldToolCall && !pendingDoneToolCall) {
			pendingImplicitYieldResume = hasPendingImplicitYield(activeEvents);
		}
	}

	// Initial drain behavior depends on resume state:
	//
	// 1. Yield (explicit/implicit) — skip entirely. Messages consumed by yield handler.
	// 2. Interrupted resume (messages end with user content from repair) — non-blocking drain.
	//    Don't wait for messages, but pick up any unconsumed messages already in the queue
	//    (e.g., messages persisted to JSONL before crash, recovered by findUnconsumedMessages).
	// 3. Fresh start or resume without user-ending messages — blocking wait for first message.
	//
	const isYieldResume =
		pendingYieldToolCall != null || pendingImplicitYieldResume;
	const isDoneResume = pendingDoneToolCall != null;
	const isInterruptedResume =
		!isYieldResume &&
		!isDoneResume &&
		isResume &&
		messages.length > 0 &&
		(messages[messages.length - 1] as { role?: string })?.role === "user";

	if (queue && !isYieldResume && !isDoneResume) {
		let allMsgs: QueueMessage[];

		if (isInterruptedResume) {
			// Non-blocking drain: pick up any messages already in the queue
			// (recovered from JSONL by findUnconsumedMessages). Don't wait.
			allMsgs = queue.drain();
		} else {
			// Blocking wait: fresh start needs first message (with header).
			const firstMsg = await queue.wait();
			const rest = queue.drain();
			allMsgs = [firstMsg, ...rest];
		}

		if (allMsgs.length > 0) {
			// Filter oversized images before they reach the adapter.
			filterQueueMessageImages(adapter, allMsgs);

			// Delegate to adapter hook — each provider routes through its walker's
			// onConsumedMessages logic to guarantee byte-identical output with
			// JSONL reconstruction. This is the ONLY user-message construction path
			// that runs here; no provider-shared ad-hoc logic.
			adapter.appendQueueMessagesToMessages(messages, allMsgs);

			// Record queue events for the consumed messages
			if (emit) {
				recordQueueEvents(emit, allMsgs);
			}
		}
	}

	// Build MCP tool handlers map (for executeTool dispatch)
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

	// Build provider-agnostic JSON Schema tool definitions.
	// On resume: use frozen tools from session_config (byte-identical = cache hit).
	// On fresh start: build from Zod schemas and store in session_config.
	const storedConfig = isResume
		? (() => {
				for (let i = activeEvents.length - 1; i >= 0; i--) {
					if (activeEvents[i]?.type === "session_config")
						return activeEvents[i] as import("./events.ts").SessionConfigEvent;
				}
				return undefined;
			})()
		: undefined;

	const jsonTools: JsonTool[] =
		storedConfig && storedConfig.tools.length > 0
			? (storedConfig.tools as JsonTool[])
			: buildJsonTools(request.mcpToolDefs);

	// Map to provider-specific format (Anthropic Tool, OpenAI ResponsesTool)
	const allTools = adapter.prepareTools(jsonTools);

	// Bind frozen tools for hidden evaluate_script tool (selfBootstrap).
	request.setAllTools?.(jsonTools);

	// Store allTools ref on TaskSession for debug dump endpoint.
	if (currentSession) {
		currentSession.allTools = jsonTools;
	}

	// Emit session_config on fresh start (tools are now populated, not [])
	if (!storedConfig && emit) {
		const sp = request.systemPrompt ?? { stable: "", variable: "" };
		const sessionConfigEvt: import("./events.ts").Event = {
			type: "session_config",
			tools: jsonTools,
			systemStable: sp.stable,
			systemVariable: sp.variable,
			...(request.cacheTtl ? { cacheTtl: request.cacheTtl } : {}),
			taskId: "",
			ts: Date.now(),
		} as import("./events.ts").Event;
		emit(sessionConfigEvt);
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
	// Track whether done() was called during tool execution.
	// Set when doneToolUse is detected in the current turn's tool batch.
	// Used to determine exitReason on loop exit.
	let doneExitReason: ExitReason | null = null;
	let doneSummary = "";
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
		// ── Handle pending done resume (done tool_call orphan on JSONL) ──
		// Agent called done() and the loop exited. On wake (new message), write a
		// synthetic tool_result for the done tool_call, then continue to next API call.
		// This is like yield resume but with done context instead of yield messages.
		if (pendingDoneToolCall && queue) {
			const doneResult = await handleImplicitYield(queue, emit);

			if (doneResult === null) {
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
					exitReason: doneExitReason ?? "interrupted",
					output: lastText,
					costUsd: cost,
					turns,
					sessionId,
					totalInputTokens,
					totalOutputTokens,
					totalCacheCreationTokens,
					totalCacheReadTokens,
					doneSummary,
				});
			}

			if (doneResult.manualCompactRequested) {
				manualCompactRequested = true;
			}

			// Write done tool_result with wake context
			const cwdLine = cwd ? `\n\n## Working Directory\n${cwd}` : "";
			const doneText = `You previously called done(). New messages woke you up:${cwdLine}`;
			const doneToolResultEvt: Event = {
				type: "tool_result",
				tool: pendingDoneToolCall.name,
				toolCallId: pendingDoneToolCall.id,
				content: doneText,
				isError: false,
				taskId: "",
				ts: Date.now(),
			};
			emit?.(doneToolResultEvt);
			yield doneToolResultEvt;

			// Build messages for API from done tool_result + wake messages
			const doneToolResultMsgs = adapter.buildUserTurn({
				toolUses: [
					{
						id: pendingDoneToolCall.id,
						name: pendingDoneToolCall.name,
						input: {},
					},
				],
				execResults: [
					{
						content: doneText,
						isError: false,
					},
				],
				queueMessages: doneResult.nonCompact,
			});
			for (const msg of doneToolResultMsgs) {
				messages.push(msg);
			}

			// Emit queue events (messages_consumed, etc.) — the tool_result itself
			// is already emitted via yield above, don't double-emit
			if (emit) {
				recordQueueEvents(emit, doneResult.nonCompact);
			}

			pendingDoneToolCall = null;
			// Fall through to API call
		}

		// ── Handle pending implicit yield resume (end_turn on JSONL) ──
		// The model ended its turn naturally before daemon crash. On resume, bypass to
		// handleImplicitYield → block on queue → buildUserTurn → API call.
		// No tool_result to write (no tool_call to pair with).
		if (pendingImplicitYieldResume && queue) {
			pendingImplicitYieldResume = false;

			const yieldResult = await handleImplicitYield(queue, emit);

			if (yieldResult === null) {
				// Queue closed — exit (stop/reset during implicit yield = interrupted)
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
					doneSummary,
				});
			}

			if (yieldResult.manualCompactRequested) {
				manualCompactRequested = true;
			}
			if (yieldResult.compactOnly) {
				// No tool_result to write — this is implicit yield (no tool_call to pair)
				continue;
			}

			// Filter oversized images from queue messages
			filterQueueMessageImages(adapter, yieldResult.nonCompact);

			// Build user message from queue content and push to conversation
			const implicitYieldMsgs = adapter.buildUserTurn({
				toolUses: [],
				execResults: [],
				queueMessages: yieldResult.nonCompact,
			});
			for (const msg of implicitYieldMsgs) {
				messages.push(msg);
			}

			// Emit queue events and messages_consumed
			if (emit) {
				recordQueueEvents(emit, yieldResult.nonCompact);
			}
			continue;
		}

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
					doneSummary,
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
				// DEFER the messages[] push: pushing a user message here would produce
				// two consecutive user messages (this tool_result + summarization
				// instruction) violating API role alternation. Instead, carry the
				// yield tool_call forward via pendingCompactYieldToolCall; the compact
				// path bundles it into the SAME user turn as the summarization text.
				// Order must match JSONL: this tool_result event was emitted FIRST here,
				// then summarization_request is emitted in the compact path → walker
				// reconstructs [tool_result, text] in that order. Live path must match.
				pendingCompactYieldToolCall = {
					id: pendingYieldToolCall.id,
					name: pendingYieldToolCall.name,
				};
				pendingYieldToolCall = null;
				continue;
			}

			// Filter oversized images from queue messages before yield tool_result
			filterQueueMessageImages(adapter, yieldResult.nonCompact);

			// Build yield tool_result — just "resumed." Queue messages appear as
			// additional text blocks in the same user message.
			//
			// If the API returned duplicate yield tool_uses in the same turn, bundle
			// the extras' tool_results INTO THIS SAME user turn. Pushing them as a
			// separate user message earlier would produce consecutive user roles → API 400.
			const yieldContent = "resumed.";
			const realYieldToolUse: ProviderToolUse = {
				id: pendingYieldToolCall.id,
				name: pendingYieldToolCall.name,
				input: {},
			};
			const realYieldExec: ToolResult = {
				content: yieldContent,
				isError: false,
			};
			const extraYieldToolUses: ProviderToolUse[] =
				pendingDuplicateYieldExtras.map((e) => ({
					id: e.id,
					name: e.name,
					input: {},
				}));
			const extraYieldExecs: ToolResult[] = pendingDuplicateYieldExtras.map(
				() => ({
					content:
						"yield() ignored — duplicate yield in same turn. Only the first yield is used.",
					isError: false,
				}),
			);
			// Order must match JSONL: extras' tool_result events were emitted FIRST
			// at the yield-detection point (orphan prevention), then the real yield's
			// tool_result is emitted after wake. Walker reconstructs in JSONL order.
			// So live path must build [extras..., real] to match.
			const toolResultMsgs = adapter.buildUserTurn({
				toolUses: [...extraYieldToolUses, realYieldToolUse],
				execResults: [...extraYieldExecs, realYieldExec],
				queueMessages: yieldResult.nonCompact,
			});
			for (const msg of toolResultMsgs) {
				messages.push(msg);
			}
			// Clear extras after bundling — they've been consumed into this user turn.
			pendingDuplicateYieldExtras = [];

			// Emit the yield tool_result event FIRST with FULL content (not truncated).
			// On resume, event converter reads this from JSONL to rebuild the tool_result
			// message — truncation would cause prompt cache misses.
			// tool_result must come before messages_consumed to match normal tool path order.
			const yieldResultEvt: Event = {
				type: "tool_result",
				tool: pendingYieldToolCall.name,
				toolCallId: pendingYieldToolCall.id,
				content: yieldContent,
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

				// Refresh session_config after compaction — updates date, keeps frozen tools.
				// compact_marker was already emitted by processCompaction; session_config
				// follows it so readActive() sees the fresh config for this segment.
				if (emit) {
					const freshPrompt = request.refreshSystemPrompt
						? request.refreshSystemPrompt()
						: request.systemPrompt;
					if (freshPrompt) {
						const sessionConfigEvt: Event = {
							type: "session_config",
							tools: jsonTools,
							systemStable: freshPrompt.stable,
							systemVariable: freshPrompt.variable,
							...(request.cacheTtl ? { cacheTtl: request.cacheTtl } : {}),
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
				// Inject summarization instruction as a user message.
				// If a pending compactOnly-yield tool_call is carried forward, bundle
				// its tool_result INTO THIS SAME user message — otherwise we'd emit
				// two consecutive user messages (tool_result + this one) → API 400.
				const summarizationInstruction = buildSummarizationInstruction(cwd);
				if (pendingCompactYieldToolCall) {
					// Build a structured user message: [tool_result, text] via the
					// walker-delegating buildUserTurn. Walker is the single source of
					// truth for tool_result user messages → live and reconstruction
					// produce byte-identical output.
					const bundledMsgs = adapter.buildUserTurn({
						toolUses: [
							{
								id: pendingCompactYieldToolCall.id,
								name: pendingCompactYieldToolCall.name,
								input: {},
							},
						],
						execResults: [
							{
								content: "Manual compaction requested",
								isError: false,
							},
						],
						queueMessages: [],
					});
					// The buildUserTurn output is a single user message with ONE
					// tool_result block. Extend its content array with the
					// summarization text so both blocks share the same user turn.
					for (const msg of bundledMsgs) {
						const m = msg as { role: string; content: unknown };
						if (m.role === "user" && Array.isArray(m.content)) {
							(m.content as Array<{ type: string; text: string }>).push({
								type: "text",
								text: summarizationInstruction,
							});
						}
						messages.push(m);
					}
					pendingCompactYieldToolCall = null;
				} else {
					(messages as Array<{ role: string; content: string }>).push({
						role: "user",
						content: summarizationInstruction,
					});
				}
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
					maxTokens: compactionPending
						? COMPACTION_MAX_TOKENS
						: DEFAULT_MAX_TOKENS,
					signal: request.signal,
					isCompacting: compactionPending,
					cacheTtl: request.cacheTtl,
					sessionId,
					debugSnapshotPath: request.debugSnapshotPath,
				});

				let apiStep = await apiGen.next();
				while (!apiStep.done) {
					// Forward streaming deltas — emit for broadcast
					const streamEvent = apiStep.value;
					if (streamEvent.type === "thinking_delta" && emit) {
						emit({
							type: "thinking_delta",
							thinking: (streamEvent as Event & { thinking: string }).thinking,
							taskId: "",
							ts: Date.now(),
						});
					} else if (streamEvent.type === "text_delta" && emit) {
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
				// API 400 (invalid_request_error) — don't try to fix in-memory.
				// The error will propagate, the agent will stop, and on next launch
				// buildSessionRepair will fix the JSONL on disk before retrying.
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
			outputTokens: usage.outputTokens,
			contextWindow,
			cacheCreationTokens: usage.cacheCreationTokens,
			cacheReadTokens: usage.cacheReadTokens,
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
					doneSummary,
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
					doneSummary,
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

			// Filter oversized images from queue messages before implicit yield
			filterQueueMessageImages(adapter, yieldResult.nonCompact);

			// Inject messages as a new user turn and continue the loop.
			const implicitYieldMsgs = adapter.buildUserTurn({
				toolUses: [],
				execResults: [],
				queueMessages: yieldResult.nonCompact,
			});
			for (const msg of implicitYieldMsgs) {
				messages.push(msg);
			}

			// Emit queue events and messages_consumed
			if (emit) {
				recordQueueEvents(emit, yieldResult.nonCompact);
			}
			continue;
		}

		// ── Check for yield/done/fork conflicts with other tools in same turn ──
		const yieldToolUse = toolUses.find((tu) => tu.name === TOOL_YIELD);
		const doneToolUse = toolUses.find((tu) => tu.name === TOOL_DONE);
		const otherToolUses = toolUses.filter(
			(tu) =>
				tu.name !== TOOL_YIELD &&
				tu.name !== TOOL_DONE &&
				tu.name !== TOOL_FORK_TASK_CONTEXT,
		);
		const hasOtherTools = otherToolUses.length > 0;

		// Yield alone: loop-level pause (existing behavior)
		// If API returned multiple yield calls in same turn, first one wins —
		// extras get no-op tool_results bundled into the real yield's user turn.
		if (yieldToolUse && !hasOtherTools && !doneToolUse) {
			pendingYieldToolCall = { id: yieldToolUse.id, name: yieldToolUse.name };

			// Handle duplicate yield calls in same turn.
			// Extras MUST be bundled into the real yield's user turn (built when the
			// yield wakes up) — NOT pushed as a separate user message here. Otherwise
			// messages[] ends up with two consecutive user messages: the extras user
			// message pushed now, then the real yield's user message pushed on wake.
			// That violates API role-alternation and fails with 400.
			const extraYields = toolUses.filter(
				(tu) => tu.name === TOOL_YIELD && tu.id !== yieldToolUse.id,
			);
			if (extraYields.length > 0) {
				// Defer to yield wake — bundled into the same user turn as the real yield.
				pendingDuplicateYieldExtras = extraYields.map((tu) => ({
					id: tu.id,
					name: tu.name,
				}));
				// Emit tool_results to JSONL immediately (orphan prevention).
				// JSONL reconstruction walks tool_results into the same user turn as
				// the real yield's tool_result, matching the bundled live path output.
				for (const tu of extraYields) {
					const evt: Event = {
						type: "tool_result" as const,
						tool: tu.name,
						toolCallId: tu.id,
						content:
							"yield() ignored — duplicate yield in same turn. Only the first yield is used.",
						isError: false,
						taskId: "",
						ts: Date.now(),
					};
					if (emit) emit(evt);
				}
			}

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
				if (toolUse.name === TOOL_YIELD && hasOtherTools) {
					return {
						content:
							"yield() ignored — other tools in the same turn produced results. Process them first.",
						isError: false,
					} satisfies ToolResult;
				}
				// done + other tools: done returns error
				if (toolUse.name === TOOL_DONE && hasOtherTools) {
					return {
						content:
							"Cannot call done() alongside other tools — you must process their results first before finishing.",
						isError: true,
					} satisfies ToolResult;
				}
				// fork + other tools: fork returns error (fork must be sole tool
				// to ensure clean event state — like unix fork(), no race conditions)
				if (toolUse.name === TOOL_FORK_TASK_CONTEXT && hasOtherTools) {
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

		// ── done() alone: intended orphan (like yield) ──
		// done() handler closes the queue. No tool_result is written to JSONL or
		// yielded — the done tool_call stays as an orphan (buildSessionRepair skips it).
		// Exit immediately with the done exit reason. Phase 2 (in runAgentForNode)
		// handles status update, parent notification, and done_notified.
		if (doneToolUse && !hasOtherTools) {
			const doneIndex = toolUses.indexOf(doneToolUse);
			const doneResult = execResults[doneIndex] as ToolResult | undefined;
			if (doneResult && !doneResult.isError) {
				const doneInput = doneToolUse.input as
					| { status?: string; summary?: string }
					| undefined;
				doneExitReason =
					doneInput?.status === "passed" ? "done_passed" : "done_failed";
				doneSummary = doneInput?.summary ?? "";
				const cost = adapter.computeCost(
					model,
					totalInputTokens,
					totalOutputTokens,
					totalCacheCreationTokens,
					totalCacheReadTokens,
				);
				const buildResultDone = adapter.buildResult ?? defaultBuildResult;
				return buildResultDone({
					exitReason: doneExitReason,
					output: lastText,
					costUsd: cost,
					turns,
					sessionId,
					totalInputTokens,
					totalOutputTokens,
					totalCacheCreationTokens,
					totalCacheReadTokens,
					doneSummary,
				});
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
		if (queue) {
			const drained = drainQueueAtCancellationPoint(queue);
			if (drained) {
				if (drained.manualCompactRequested) {
					manualCompactRequested = true;
				}
				if (drained.messages.length > 0) {
					cancellationQueueMsgs = drained.messages;
				}
			}
		}

		// Filter oversized images from tool results and queue messages before
		// they reach provider code — prevents API 400 from oversized images.
		filterExecResultImages(adapter, execResults);
		filterQueueMessageImages(adapter, cancellationQueueMsgs);

		// Build user turn (provider-specific format) and push to history
		const toolResultMsgs = adapter.buildUserTurn({
			toolUses,
			execResults,
			queueMessages: cancellationQueueMsgs,
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

		// If queue was closed during tool execution (e.g. stop/reset),
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
				doneSummary,
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
		doneSummary,
	});
}
