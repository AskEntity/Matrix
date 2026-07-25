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
	COMPACTION_MAX_TOKENS,
	getCompactionThresholds,
	processCompaction,
} from "./compaction.ts";
import {
	type Event,
	type EventSpec,
	hasPendingImplicitYield,
} from "./events.ts";
import type { MessageQueue, QueueMessage } from "./message-queue.ts";
import { createCompactedResume } from "./queue-message-factory.ts";
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
	formatUpstreamError,
	isTransientAPIError,
	MAX_OUTER_RETRIES,
} from "./tool-execution.ts";
import { TOOL_DONE, TOOL_FORK_TASK_CONTEXT, TOOL_YIELD } from "./tool-names.ts";
import type { TurnInterrupt } from "./turn-interrupt.ts";
import type { AgentActivity, AgentResult, ExitReason } from "./types.ts";

// buildWorkContextContent import removed — work context now provided by plugin hook

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

/**
 * Synthetic tool_result contents. Both are written to JSONL and must therefore
 * be byte-identical everywhere they are produced — the walker replays whatever
 * landed on disk, so a second spelling anywhere is a live/reconstruction drift.
 */
const DUPLICATE_YIELD_IGNORED =
	"yield() ignored — duplicate yield in same turn. Only the first yield is used.";
const COMPACT_REQUESTED_RESULT = "Manual compaction requested";

/**
 * Sleep for `ms`, resolving early if `signal` aborts. After it resolves, callers
 * check `signal.aborted` to decide whether the timer elapsed normally or the wait
 * was cut short by a stop/reset. The inner per-call retry already does this; the
 * OUTER retry backoff (30/60/120s) did not — a transient error parked the loop in
 * a plain setTimeout, so a stop/reset blocked for the full backoff (up to 120s),
 * exceeding the daemon's 60s worker-forward timeout → 504 + a retry racing the
 * still-running first reset. (B-M3) The abort listener is removed on both paths so
 * a long-lived signal reused across retries doesn't accumulate listeners.
 */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

// ── Implicit yield (end_turn with queue) ──

/**
 * Shared implicit yield logic: wait for messages on queue, format them, emit events.
 * Returns the formatted messages and images, or null if queue was closed.
 *
 * This is THE place the loop parks on the queue — four call sites (done resume,
 * implicit-yield resume, explicit yield, end_turn) funnel through it, so the
 * `idle` transition is written once. `setActivity` is passed in rather than the
 * raw `emit` on purpose: it both stores the state and broadcasts it. Emitting
 * here and storing at the call sites would split one source into two, and the
 * next call site added would only get one half.
 *
 * The transition on the way OUT is REQUIRED, and it is not enough to say "the
 * API-call block sets `thinking` a moment later". Consumers read the STORED
 * state, not the event sequence: the fast path in `yield_external` and the
 * connect-time snapshot both ask `session.activity` directly. Everything
 * between the wake and the API call — draining, filtering compact, building
 * the user turn, emitting its events — would otherwise report `idle` for a
 * loop that is demonstrably not parked, and `send_user_message` →
 * `yield_external` lands exactly there: the client would be told the agent had
 * stopped working at the moment it started. The old code left idle twice here
 * (`queue.idle = false` and an `agent_active` event); only the flag survived
 * the move to one state, and the flag no longer has a production reader.
 *
 * `idle` is announced only when the loop will ACTUALLY park. With a message
 * already queued, `wait()` resolves on the next microtask and the agent never
 * paused — reporting idle for that would be a state we were never in, and
 * would make `idle` mean "reached a yield point" instead of "waiting for you".
 * Consumers depend on the stronger meaning: yield_external wakes an external
 * client on it, and the UI re-fetches JSONL on it to expose Edit/Rewind.
 */
async function handleImplicitYield(
	queue: MessageQueue,
	setActivity: (state: AgentActivity) => void,
	interrupt?: TurnInterrupt,
): Promise<{
	nonCompact: QueueMessage[];
	manualCompactRequested: boolean;
	compactOnly: boolean;
} | null> {
	// Reaching a park is what SATISFIES an interrupt — whichever path parked us,
	// including one the agent reached on its own. Consuming here rather than at
	// the decision point is what keeps a stop that lands exactly as the agent
	// goes idle from surviving into the next turn. See TurnInterrupt.consume.
	interrupt?.consume();
	if (!queue.hasPending) setActivity("idle");
	try {
		queue.idle = true;
		const first = await queue.wait();
		queue.idle = false;
		// Left the queue — everything from here to the next API call is the
		// residual, which is `thinking`. Deduped, so this is free when the
		// loop was never announced idle in the first place.
		setActivity("thinking");
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
/**
 * Build tool_result events plus the matching messages_consumed marker for a
 * turn's worth of tool calls and drained queue messages.
 *
 * After the `enqueue === persist` refactor, queue messages are persisted
 * when they enter the queue (via `queue.enqueue`'s onPersist callback).
 * This function no longer needs to emit `message` events — it only outputs
 * `tool_result*` and the `messages_consumed` marker referencing their ids.
 * The walker resolves consumed ids via eventIndex lookup.
 */
export function buildToolResultEvents(
	toolIds: Array<{ id: string; name: string }>,
	execResults: ToolResult[],
	cancellationQueueMsgs: QueueMessage[],
): EventSpec[] {
	const toolEvents: EventSpec[] = [];

	for (let idx = 0; idx < toolIds.length; idx++) {
		const toolId = toolIds[idx] as { id: string; name: string };
		const exec = execResults[idx] as ToolResult;

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
			ts: Date.now(),
		});
	}

	if (cancellationQueueMsgs.length > 0) {
		const consumedIds = cancellationQueueMsgs.map((qm) => qm.id);
		toolEvents.push({
			type: "messages_consumed",
			messageIds: consumedIds,
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
	}): AsyncGenerator<EventSpec, unknown>;

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
	buildResponseEvents(response: unknown, isCompacting: boolean): EventSpec[];

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
): AsyncGenerator<EventSpec, AgentResult> {
	const model = request.model ?? "claude-sonnet-4-6"; // default overridden by provider

	// ── Context window + compaction thresholds ──
	const contextWindow = await adapter.getContextWindow(model);
	const { compressThreshold, lazyCountThreshold } =
		getCompactionThresholds(contextWindow);

	// ── Event emission — all events flow through this callback ──
	const emit = request.emit;

	// Wire the queue's onPersist callback to emit if the queue doesn't already
	// have one. This enforces the `enqueue === persist` invariant at the
	// provider-loop layer: any caller with a queue + emit gets single-write
	// persistence automatically, regardless of how the queue was constructed.
	// Production (runAgentForNode) already wires onPersist; unit tests that
	// pass a bare `new MessageQueue()` also get it automatically.
	if (queue && emit && !queue.hasOnPersist()) {
		queue.setOnPersist((msg) => {
			emit({
				type: "message",
				id: msg.id,
				body: msg,
				ts: msg.ts,
			});
		});
	}

	// Resume from pre-loaded active events (daemon layer reads these from EventStore)
	const activeEvents = request.activeEvents ?? [];
	const isResume = activeEvents.length > 0;

	// System prompt: use frozen from session_config on resume, build fresh otherwise.
	const storedPromptConfig = isResume
		? (() => {
				for (let i = activeEvents.length - 1; i >= 0; i--) {
					if (activeEvents[i]?.type === "session_config") {
						const sc = activeEvents[
							i
						] as import("./events.ts").SessionConfigEvent;
						return { stable: sc.systemStable, variable: sc.systemVariable };
					}
				}
				return undefined;
			})()
		: undefined;
	let systemPrompt = storedPromptConfig ??
		request.buildSystemPrompt?.() ?? { stable: "", variable: "" };

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

	/**
	 * THE loop-side writer of agent activity: stores the state on the session
	 * AND broadcasts it, in one call. Both halves live here so they cannot
	 * drift — a stored state nobody was told about, or a broadcast nobody can
	 * read back at connect time, are the same bug wearing different clothes.
	 *
	 * Session birth/death is the other half of the story and lives in
	 * agent-lifecycle (`setAgentActivity`) — this loop cannot see either.
	 *
	 * Re-announcing the current state is a no-op, and that is load-bearing
	 * rather than an optimisation: it makes "an extra setActivity call is
	 * harmless" true, so a transition point is written wherever the loop
	 * changes what it is doing, without anyone having to first argue that the
	 * event would be redundant. That argument is how the leave-idle transition
	 * went missing — the reasoning was about the event sequence, and the
	 * consumers read the stored value.
	 *
	 * Deduping against a local rather than the session keeps the property true
	 * when there is no session (a provider driven directly in a unit test).
	 * Nothing else writes the field while the loop runs — agent-lifecycle
	 * touches it only at session creation and teardown — so the two agree.
	 */
	/**
	 * Turn-interrupt channel — "end this turn, but stay alive". Read at exactly
	 * three places (the API call's signal, the retry backoff, the top of the
	 * loop) and consumed in one (`handleImplicitYield`, i.e. when we park).
	 * Absent when the loop is driven without a session (unit tests).
	 */
	const interrupt = request.interrupt;

	let announcedActivity: AgentActivity | undefined = currentSession?.activity;
	const setActivity = (state: AgentActivity) => {
		if (announcedActivity === state) return;
		announcedActivity = state;
		if (currentSession) currentSession.activity = state;
		emit?.({ type: "agent_activity", state, ts: Date.now() });
	};

	// Detect pending yield from JSONL: if last tool_call is yield with no matching result,
	// the agent was in yield state when the daemon restarted. We restore this at loop level
	// instead of writing a synthetic orphan result — yield is a loop-level pause, not a JS await.
	let pendingYieldToolCall: { id: string; name: string } | null = null;
	// Extra yield tool_uses from the same turn. Their tool_results are emitted to
	// JSONL at yield-detection time and the REAL yield's at wake — with NOTHING
	// between them that the walker's collection loop breaks on. So reconstruction
	// yields ONE user message containing all of them, and the live path must build
	// the same one turn or the two drift.
	//
	// ⚠️ That byte-identity is the reason, NOT role alternation (which does not
	// exist — see memory.md "The Anthropic message-shape rules, MEASURED"). The
	// distinction decides whether a deferral is needed at all: required when the
	// deferred tool_result is PERSISTED and lands ADJACENT to another, unnecessary
	// when the message it would merge into is TRANSIENT. That is why this one stays
	// and the two compaction deferrals are gone.
	let pendingDuplicateYieldExtras: Array<{ id: string; name: string }> = [];
	// Detect pending done from JSONL: if last tool_call is done with no matching result,
	// the agent called done() and the loop exited (done is an intended orphan).
	// On wake, write a synthetic tool_result so the message history is well-formed.
	let pendingDoneToolCall: { id: string; name: string } | null = null;
	/**
	 * A pending yield/done was woken by /compact and nothing else. Emit its
	 * tool_result (orphan prevention — the assistant's tool_use must be answered,
	 * which IS a real API rule) and push the matching user turn immediately.
	 *
	 * Any duplicate-yield extras ride along in the SAME turn: their tool_results
	 * were emitted to JSONL earlier and sit adjacent to this one, so that is the
	 * single user message reconstruction will produce.
	 *
	 * The summarization instruction deliberately does NOT join this turn. It is
	 * never persisted, so a turn containing it is one the walker can never
	 * rebuild — bundling them was the only arrangement guaranteed to drift.
	 *
	 * ⚠️ CALL WITH `yield*`. Calling it bare compiles fine, produces no
	 * diagnostic, and does NOTHING — the generator body never runs, the
	 * tool_result never reaches JSONL or messages[], and the next request goes
	 * out with an unanswered tool_use. (Cost one full suite run to find; the
	 * mock's pairing check is what caught it.)
	 */
	function* emitAndPushCompactToolResult(
		id: string,
		name: string,
	): Generator<EventSpec> {
		const evt: EventSpec = {
			type: "tool_result",
			tool: name,
			toolCallId: id,
			content: COMPACT_REQUESTED_RESULT,
			isError: false,
			ts: Date.now(),
		};
		emit?.(evt);
		yield evt;

		const turn = adapter.buildUserTurn({
			toolUses: [
				...pendingDuplicateYieldExtras.map((e) => ({
					id: e.id,
					name: e.name,
					input: {},
				})),
				{ id, name, input: {} },
			],
			execResults: [
				...pendingDuplicateYieldExtras.map(() => ({
					content: DUPLICATE_YIELD_IGNORED,
					isError: false,
				})),
				{ content: COMPACT_REQUESTED_RESULT, isError: false },
			],
			queueMessages: [],
		});
		for (const msg of turn) messages.push(msg);
		pendingDuplicateYieldExtras = [];
	}

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
			// This is the FIFTH place the loop parks on the queue and the only
			// one outside handleImplicitYield. It used to set nothing at all —
			// not queue.idle, not an event — so an agent launched with an empty
			// queue sat here waiting for input while every client showed it as
			// running. Usually the launching message is already queued and this
			// returns immediately; when it isn't, idle is the truth.
			//
			// Deliberately does NOT set `queue.idle`: that flag means "a waiter
			// is parked on this queue" and is read as a synchronization signal
			// for the steady-state loop (test helpers poll it to know the agent
			// has settled). Flipping it during startup would let a poller
			// declare a still-booting agent settled.
			//
			// Same "only if it really parks" rule as handleImplicitYield: the
			// launching message is normally already queued, and announcing idle
			// on every launch would blink the spinner off for a pause that
			// never happened.
			if (!queue.hasPending) setActivity("idle");
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

	let jsonTools: JsonTool[] =
		storedConfig && storedConfig.tools.length > 0
			? (storedConfig.tools as JsonTool[])
			: buildJsonTools(request.mcpToolDefs);

	// Map to provider-specific format (Anthropic Tool, OpenAI ResponsesTool)
	let allTools = adapter.prepareTools(jsonTools);

	// Bind frozen tools for hidden evaluate_script tool (selfBootstrap).
	request.setAllTools?.(jsonTools);

	// Store allTools ref on TaskSession for debug dump endpoint.
	if (currentSession) {
		currentSession.allTools = jsonTools;
	}

	// session_config for fresh starts is now emitted by runAgentForNode
	// (before any messages, before launch lock release).
	// Only compact-refresh session_config is emitted here (see compaction block below).

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
		const evt: EventSpec = {
			type: "status",
			message: `Starting agent loop (model: ${model})`,
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
			const doneResumeResult = await handleImplicitYield(
				queue,
				setActivity,
				interrupt,
			);

			if (doneResumeResult === null) {
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
				});
			}

			if (doneResumeResult.manualCompactRequested) {
				manualCompactRequested = true;
			}

			if (doneResumeResult.compactOnly) {
				// The ONLY wake message was /compact. Emit the done tool_result
				// (orphan prevention) and push its user turn RIGHT HERE.
				//
				// This used to be deferred via `pendingCompactDoneToolCall` so the
				// summarization instruction could share ONE user turn, on the belief
				// that two consecutive user messages were an API 400 (B-L9). They are
				// not — measured against production Anthropic, see memory.md "The
				// Anthropic message-shape rules, MEASURED". The deferral is gone.
				//
				// Pushing here is not merely allowed, it is the byte-identical
				// choice: this tool_result IS persisted, and on reconstruction the
				// walker turns it into exactly this user message. The summarization
				// instruction, by contrast, is never persisted at all — so bundling
				// the two was the one arrangement the walker could never reproduce.
				yield* emitAndPushCompactToolResult(
					pendingDoneToolCall.id,
					pendingDoneToolCall.name,
				);
				pendingDoneToolCall = null;
				continue;
			}

			// Write done tool_result with wake context
			const doneText = request.buildDoneResumeContext
				? request.buildDoneResumeContext()
				: "resumed.";
			const doneToolResultEvt: EventSpec = {
				type: "tool_result",
				tool: pendingDoneToolCall.name,
				toolCallId: pendingDoneToolCall.id,
				content: doneText,
				isError: false,
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
				queueMessages: doneResumeResult.nonCompact,
			});
			for (const msg of doneToolResultMsgs) {
				messages.push(msg);
			}

			// Emit queue events (messages_consumed, etc.) — the tool_result itself
			// is already emitted via yield above, don't double-emit
			if (emit) {
				recordQueueEvents(emit, doneResumeResult.nonCompact);
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

			const yieldResult = await handleImplicitYield(
				queue,
				setActivity,
				interrupt,
			);

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
			const yieldResult = await handleImplicitYield(
				queue,
				setActivity,
				interrupt,
			);

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
				// (That one IS real — it is the pairing rule.)
				//
				// The messages[] push used to be DEFERRED here via
				// `pendingCompactYieldToolCall` (commit 304fccd) to keep the
				// summarization instruction in the same user turn. See the done-side
				// twin above for why that is gone.
				yield* emitAndPushCompactToolResult(
					pendingYieldToolCall.id,
					pendingYieldToolCall.name,
				);
				pendingYieldToolCall = null;
				continue;
			}

			// Filter oversized images from queue messages before yield tool_result
			filterQueueMessageImages(adapter, yieldResult.nonCompact);

			// Build yield tool_result — just "resumed." Queue messages appear as
			// additional text blocks in the same user message.
			//
			// If the API returned duplicate yield tool_uses in the same turn, bundle
			// the extras' tool_results INTO THIS SAME user turn — that is the single
			// message reconstruction produces from the adjacent JSONL tool_results,
			// so the live path must match it. (Byte-identity, not role alternation;
			// see the detection site.)
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
					content: DUPLICATE_YIELD_IGNORED,
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
			const yieldResultEvt: EventSpec = {
				type: "tool_result",
				tool: pendingYieldToolCall.name,
				toolCallId: pendingYieldToolCall.id,
				content: yieldContent,
				isError: false,
				ts: Date.now(),
			};
			emit?.(yieldResultEvt);
			yield yieldResultEvt;

			// Emit messages_consumed marker AFTER tool_result
			if (emit) {
				recordQueueEvents(emit, yieldResult.nonCompact);
			}

			pendingYieldToolCall = null;
			continue;
		}

		// Check abort signal — TEARDOWN. Checked before the interrupt below:
		// a dying session must never be mistaken for "park and wait".
		if (request.signal?.aborted) {
			const evt: EventSpec = {
				type: "status",
				message: "Aborted",
				ts: Date.now(),
			};
			emit?.(evt);
			yield evt;
			break;
		}

		// ── Interrupt: THE park point ──
		//
		// The single place that decides "this turn is over, wait for the user".
		// Both ways an interrupt can arrive converge here: a cut-off API call
		// `continue`s to the top, and a tool batch runs to completion and falls
		// through to the top. Neither branch parks on its own, so there is one
		// site to reason about — and it is the SAME park every other path uses
		// (`handleImplicitYield`), so no fifth "what is the agent waiting for"
		// state exists. `handleImplicitYield` consumes the flag.
		//
		// Everything owed to the API has already been written by the time we get
		// here: tool_results for every tool_use of the turn (that is what makes
		// `buildSessionRepair` return null after an interrupt), or nothing at all
		// if the turn was cut before the response arrived.
		if (interrupt?.requested && queue) {
			const yieldResult = await handleImplicitYield(
				queue,
				setActivity,
				interrupt,
			);
			if (yieldResult === null) {
				// Queue closed while parked = the session is being torn down.
				const cost = adapter.computeCost(
					model,
					totalInputTokens,
					totalOutputTokens,
					totalCacheCreationTokens,
					totalCacheReadTokens,
				);
				const buildResultI = adapter.buildResult ?? defaultBuildResult;
				return buildResultI({
					exitReason: doneExitReason ?? "interrupted",
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
			if (!yieldResult.compactOnly) {
				filterQueueMessageImages(adapter, yieldResult.nonCompact);
				// The one construction path — same helper the initial drain uses,
				// which routes through the walker's own callback. It appends to a
				// user turn still being built (tool_results from the interrupted
				// turn) or starts a new one after an assistant turn, so the request
				// always ends with a user message either way.
				adapter.appendQueueMessagesToMessages(messages, yieldResult.nonCompact);
				if (emit) recordQueueEvents(emit, yieldResult.nonCompact);
			}
			// compactOnly: fall through exactly as the end_turn path does — the
			// compaction block at the top of the next iteration owns it.
			continue;
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
				undefined,
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
				estimatedInputTokens = 0;
				manualCompactRequested = false;

				// Refresh session_config after compaction — updates tools, system prompt, date.
				// compact_marker was already emitted by processCompaction; session_config
				// follows it so readActive() sees the fresh config for this segment.
				if (emit) {
					const freshPrompt = request.buildSystemPrompt
						? request.buildSystemPrompt()
						: systemPrompt;
					// Rebuild tools from current code (not stored session_config).
					jsonTools = buildJsonTools(request.mcpToolDefs);
					allTools = adapter.prepareTools(jsonTools);
					// Propagate refreshed tools to session + hidden evaluate_script binding.
					request.setAllTools?.(jsonTools);
					if (currentSession) {
						currentSession.allTools = jsonTools;
					}
					// Update systemPrompt so subsequent API calls use the
					// refreshed prompt. Without this, the next iteration's API call
					// uses systemPrompt which is still frozen.
					if (freshPrompt) {
						systemPrompt = freshPrompt;
						const sessionConfigEvt: EventSpec = {
							type: "session_config",
							tools: jsonTools,
							systemStable: freshPrompt.stable,
							systemVariable: freshPrompt.variable,
							...(request.cacheTtl ? { cacheTtl: request.cacheTtl } : {}),
							ts: Date.now(),
						} as EventSpec;
						emit(sessionConfigEvt);
					}

					// Re-arm the before-first-message hook so work_context is
					// injected before the compacted_resume message. Then enqueue
					// compacted_resume — the hook fires first, injecting work_context.
					// Both messages are persisted to JSONL via onPersist.
					if (queue) {
						queue.resetBeforeFirstMessage();
						const resumeMsg = createCompactedResume(compactResult.checkpoint);
						await queue.enqueue(resumeMsg);
					}
					// Drain the just-enqueued messages and build the user message
					// through the unified adapter path — same walker callbacks used
					// by JSONL reconstruction. This ensures byte-identical output
					// and emits messages_consumed so the walker can materialize them
					// at the correct position on restart.
					if (queue) {
						const compactMsgs = queue.drain();
						if (compactMsgs.length > 0) {
							filterQueueMessageImages(adapter, compactMsgs);
							adapter.appendQueueMessagesToMessages(messages, compactMsgs);
							recordQueueEvents(emit, compactMsgs);
						}
					}
				}
			}
			continue; // Skip normal processing, go to next API call with rebuilt context
		}

		// ── Pre-call compression: count tokens, inject summarization instruction if over threshold ──
		if (manualCompactRequested && messages.length <= 4) {
			// Context too short to compact. Do NOT emit compact_marker — a bare marker
			// without session_config + compacted_resume after it would brick the session
			// on restart (readActive() returns only post-marker events → starts with
			// assistant → API 400 "first message must be role user" → permanent brick).
			// Just emit a status and skip. (R8-B#1)
			const s1: EventSpec = {
				type: "status",
				message: "Context is too short to compact",
				ts: Date.now(),
			};
			emit?.(s1);
			yield s1;
			manualCompactRequested = false;
			// R8-B#1b used to live here: consume the yield/done tool_result that the
			// compactOnly path had deferred, so the assistant's tool_use would not
			// reach the API unanswered. That obligation is REAL (it is the pairing
			// rule) — it is just discharged earlier now, at the moment the
			// tool_result is emitted, so there is nothing left to consume here.
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
					const sp = systemPrompt;
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
				const cs1: EventSpec = {
					type: "compact_started",
					ts: Date.now(),
				};
				emit?.(cs1);
				yield cs1;
				const compactStatusMsg = manualCompactRequested
					? "Manual compaction triggered"
					: `Compressing conversation (${adapter.supportsTokenCounting ? "" : "est. "}${tokenCount} tokens, threshold: ${compressThreshold})`;
				const cs2: EventSpec = {
					type: "status",
					message: compactStatusMsg,
					ts: Date.now(),
				};
				emit?.(cs2);
				yield cs2;
				// Inject summarization instruction as its own user message.
				//
				// This used to bundle a deferred yield/done tool_result into the SAME
				// message, on the belief that two consecutive user messages were an
				// API 400. They are not (measured — see memory.md). The tool_result
				// is now pushed where it is emitted, which is also the only place the
				// walker can reproduce it: the summarization instruction is never
				// persisted, so any turn containing it is unreconstructible by
				// definition.
				const summarizationInstruction = request.buildSummarizationPrompt!();
				(messages as Array<{ role: string; content: string }>).push({
					role: "user",
					content: summarizationInstruction,
				});
				// summarization_request event removed — instruction is part of compact_started
				compactionPending = true;
				preCompactTokenCount = adapter.supportsTokenCounting
					? tokenCount
					: estimatedInputTokens;
				// Fall through to the normal API call — the model will generate the checkpoint
			}
		}

		turns++;

		// ── Call provider API (with outer retry for transient errors) ──
		// The ONE `thinking` transition. Set outside the retry loop on purpose:
		// the backoff between attempts (up to 120s) is the loop alive, not
		// parked on the queue, with no unclosed tool_call — the residual, so it
		// is `thinking` by definition rather than by special case. Compaction
		// turns run through this same block (isCompacting), so they are
		// `thinking` too — see the naming-debt note on AgentActivity.
		setActivity("thinking");
		let response: unknown;
		// The ONE place the two abort channels meet. A compaction turn is
		// deliberately NOT interruptible mid-flight: it is a 2-3 minute system
		// operation whose instruction is already sitting in messages[], and
		// cutting it there would leave that instruction paired with whatever the
		// user says next. The flag stays set and takes effect at the top of the
		// next iteration.
		const turnAbort =
			interrupt && !compactionPending
				? AbortSignal.any(
						request.signal
							? [request.signal, interrupt.signal]
							: [interrupt.signal],
					)
				: request.signal;
		// Set only by the interrupt branches below, so the post-retry check can
		// tell "cut off on purpose" from "succeeded".
		let turnInterrupted = false;
		// Text the model streamed before the cut. Kept, not discarded — see the
		// emission site after this loop.
		let partialText = "";
		for (let outerAttempt = 0; ; outerAttempt++) {
			try {
				const apiGen = adapter.callAPI({
					model,
					messages,
					tools: allTools,
					systemPrompt: systemPrompt,
					maxTokens: compactionPending
						? COMPACTION_MAX_TOKENS
						: DEFAULT_MAX_TOKENS,
					signal: turnAbort,
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
							ts: Date.now(),
						});
					} else if (streamEvent.type === "text_delta" && emit) {
						partialText += streamEvent.content;
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
				break; // Success — exit retry loop
			} catch (e) {
				// ⭐ Interrupt is checked FIRST. An abort error is not classified as
				// transient, so falling through would `throw e` and take the whole
				// agent down — the exact outcome an interrupt exists to avoid.
				// `request.signal.aborted` (teardown) still wins over it.
				if (interrupt?.requested && !request.signal?.aborted) {
					turnInterrupted = true;
					break;
				}
				// API 400 (invalid_request_error) — don't try to fix in-memory.
				// The error will propagate, the agent will stop, and on next launch
				// buildSessionRepair will fix the JSONL on disk before retrying.
				if (!isTransientAPIError(e) || outerAttempt >= MAX_OUTER_RETRIES) {
					throw e; // Non-transient or retries exhausted — let it propagate
				}
				const delay = adapter.getOuterRetryDelayMs
					? adapter.getOuterRetryDelayMs(outerAttempt, e)
					: defaultOuterRetryDelay(outerAttempt);
				// Classify so the retry log shows a curated headline instead
				// of a raw SDK blob. Raw is still appended for debugging.
				const formatted = formatUpstreamError(
					e,
					`API call failed (outer retry ${outerAttempt + 1}/${MAX_OUTER_RETRIES}, waiting ${Math.round(delay / 1000)}s)`,
				);
				const retryEvt: EventSpec = {
					type: "error",
					message: formatted,
					ts: Date.now(),
				};
				emit?.(retryEvt);
				yield retryEvt;
				// Abort-aware backoff: a stop/reset during this wait resolves it early
				// (B-M3). If aborted, abandon the retry loop — the loop's normal abort
				// handling / session replacement takes over instead of waiting out the
				// full 120s backoff. `turnAbort` also carries the interrupt, so a stop
				// button reaches an agent parked in a 120s backoff — `thinking` is the
				// residual state and that backoff is part of it.
				await abortableDelay(delay, turnAbort);
				if (request.signal?.aborted) {
					throw e;
				}
				if (interrupt?.requested) {
					turnInterrupted = true;
					break;
				}
			}
		}

		if (turnInterrupted) {
			// Keep what the model already streamed, as a normal assistant_text
			// event + assistant message. Three reasons, the last decisive:
			//   1. The user pressed stop BECAUSE of what they were reading; drop it
			//      and their next message ("no, not that") has no referent.
			//   2. It is what makes memory and JSONL agree: a final assistant_text
			//      is what clears `ctx.streamingText`, so the UI's partial becomes
			//      final instead of lingering until the next refetch.
			//   3. It makes the interrupted state REPRESENTABLE on disk with zero
			//      new states: the log then ends in assistant_text, which is
			//      exactly `hasPendingImplicitYield` — so a daemon restart comes
			//      back parked at idle instead of resuming the work.
			// Never the thinking blocks (no signature) and never a half-emitted
			// tool_use (that would be the orphan this whole task removes).
			if (partialText) {
				const evt: EventSpec = {
					type: "assistant_text",
					content: partialText,
					ts: Date.now(),
				};
				emit?.(evt);
				yield evt;
				// Build the message by running the SAME event through the SAME
				// reconstruction the walker uses, so live and restart cannot drift.
				const [assistantMsg] = adapter.convertEventsToMessages([
					{ ...evt, taskId: "" } as Event,
				]);
				if (assistantMsg) messages.push(assistantMsg);
			}
			continue; // → top of loop → the park point
		}

		// ── Process response ──
		const usage = adapter.getTokenUsage(response);
		totalInputTokens += usage.inputTokens;
		totalOutputTokens += usage.outputTokens;
		totalCacheCreationTokens += usage.cacheCreationTokens ?? 0;
		totalCacheReadTokens += usage.cacheReadTokens ?? 0;
		estimatedInputTokens = usage.totalContextTokens + usage.outputTokens;

		// Extract text and tool uses from response
		const responseText = adapter.getResponseText(response);
		if (responseText) {
			lastText = responseText;
		}
		const toolUses = compactionPending ? [] : adapter.getToolUses(response);

		// Add assistant message to history
		adapter.addAssistantMessage(messages, response, compactionPending);

		// Emit individual Events for each content block FIRST.
		// The `usage` event is emitted AFTER so the frontend's `attach_usage`
		// walk-backwards logic finds this turn's assistant_text, not the
		// previous turn's (off-by-one bug — cache badge on wrong message).
		if (emit) {
			const contentEvents = adapter.buildResponseEvents(
				response,
				compactionPending,
			);
			for (const evt of contentEvents) {
				emit(evt);
			}
		}

		// Emit usage AFTER content events — see ordering note above.
		const usageEvt: EventSpec = {
			type: "usage",
			inputTokens: usage.totalContextTokens,
			outputTokens: usage.outputTokens,
			contextWindow,
			cacheCreationTokens: usage.cacheCreationTokens,
			cacheReadTokens: usage.cacheReadTokens,
			ts: Date.now(),
		};
		emit?.(usageEvt);
		yield usageEvt;

		// Yield assistant_text and tool_call events to the consumer loop AFTER
		// emission. These yields are control-flow signals only — they are NOT
		// persisted (assistant_text / tool_call are emitted via buildResponseEvents
		// above). Consumer loops (SSE pumping, cost tracking) don't care about
		// ordering relative to usage, so emission order is what matters for JSONL.
		if (responseText && !compactionPending) {
			yield {
				type: "assistant_text",
				content: responseText,
				ts: Date.now(),
			};
		}
		if (!compactionPending) {
			for (const tu of toolUses) {
				yield {
					type: "tool_call",
					tool: tu.name,
					toolCallId: tu.id,
					input: tu.input,
					ts: Date.now(),
				};
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

			const idleStatusEvt: EventSpec = {
				type: "status",
				message:
					"Agent ended turn — entering idle state (waiting for messages)",
				ts: Date.now(),
			};
			emit?.(idleStatusEvt);
			yield idleStatusEvt;

			const yieldResult = await handleImplicitYield(
				queue,
				setActivity,
				interrupt,
			);

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

			// Emit messages_consumed marker for the drained queue messages
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
			// yield wakes up) — NOT pushed as a separate user message here.
			//
			// The reason is live/walker BYTE-IDENTITY, not role alternation (which
			// does not exist — the two-consecutive-user shape this used to cite is
			// accepted by the API). The extras' tool_results are emitted to JSONL
			// below and the real yield's at wake, with nothing between them that the
			// walker's collection loop breaks on — so reconstruction produces ONE
			// user message and the live path must produce the same one. Splitting
			// would require inventing a JSONL boundary event: more machinery, not
			// less. See memory.md, and contrast with the two compaction deferrals
			// that were removed because the turn they merged into is transient.
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
					const evt: EventSpec = {
						type: "tool_result" as const,
						tool: tu.name,
						toolCallId: tu.id,
						content: DUPLICATE_YIELD_IGNORED,
						isError: false,
						ts: Date.now(),
					};
					if (emit) emit(evt);
				}
			}

			continue;
		}

		// ── Execute tools concurrently ──
		// From here until the results are built there IS an unclosed tool_call
		// in the JSONL — that is what makes `tool` the precisely-defined state
		// and the one an interrupt has to repair. Nothing else may claim it.
		//
		// An interrupt that landed in the window between "response arrived" and
		// "tools start" means NOTHING in this batch has run yet, so nothing is
		// started: every tool_use gets a "not executed" result and the loop parks.
		// This is the only granularity at which "hasn't been reached yet" exists —
		// the Promise.all below starts all tools at once, so there is no such
		// thing as a per-tool queue.
		//
		// done()/yield() are deliberately NOT skipped: they are instantaneous
		// control tools, and a stop that races a done() is the done winning.
		// That is completion, not interruption — the task finished, and turning
		// its last act into "not executed" would strand the parent waiting.
		const interruptedBeforeExecution =
			interrupt?.requested === true && !doneToolUse && !yieldToolUse;
		setActivity("tool");
		const execResults = interruptedBeforeExecution
			? toolUses.map(
					() =>
						({
							content:
								"Not executed — interrupted by user before this tool ran.",
							isError: true,
						}) satisfies ToolResult,
				)
			: await Promise.all(
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

		// node.cwd is updated by the bash tool handler directly — no loop-local tracking.

		// ── done() alone: intended orphan (like yield) ──
		// done() handler closes the queue. No tool_result is written to JSONL or
		// yielded — the done tool_call stays as an orphan (buildSessionRepair skips it).
		// Exit immediately with the done exit reason. Phase 2 (in runAgentForNode)
		// handles status update, parent notification, and done_notified.
		if (doneToolUse && !hasOtherTools) {
			const doneIndex = toolUses.indexOf(doneToolUse);
			const doneToolResult = execResults[doneIndex] as ToolResult | undefined;
			if (doneToolResult && !doneToolResult.isError) {
				// Duplicate done() calls in the same turn need NO special handling.
				//
				// FIX-5 R8-B#2 used to emit tool_results for every done here, to keep
				// repair from placing an interrupted result after the lifecycle events
				// (agent_end, done_notified) — which splits the walker's tool_result
				// collection loop into two user messages. That split is REAL; the 400
				// attributed to it was not. `user[tool_result] user[tool_result]` is
				// accepted: both messages open with tool_result blocks, so the answering
				// run spans them. Measured; see memory.md.
				//
				// Removing it is a BEHAVIOR FIX, not a cleanup. That workaround had a
				// documented cost — every done tool_call answered means the resume sees
				// isInterruptedResume instead of pendingDoneToolCall, so a woken agent
				// got a generic "you were interrupted" context instead of its
				// done-resume context. That cost bought nothing.
				//
				// What happens now: the last done stays an intended orphan (repair skips
				// it) and the earlier one gets an interrupted result appended. Both are
				// answered before any non-tool_result block, and the resume correctly
				// detects a pending done.

				const doneInput = doneToolUse.input as { status?: string } | undefined;
				doneExitReason =
					doneInput?.status === "passed" ? "done_passed" : "done_failed";
				// The done CONTENT (result) is NOT carried out of the loop —
				// it is read back from the persisted done() tool_call at Phase 2 (JSONL
				// = single source of truth). The provider loop reads only `status`
				// here, to route the exit (done_passed/done_failed).
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
				ts: Date.now(),
			};
		}

		// Cancellation point: drain queue.
		//
		// Skipped when interrupted: we are about to park, and a message drained
		// HERE would be merged into this turn's user message and then sat on —
		// the loop would wait for a further message before ever calling the API,
		// so the user's "stop, do X instead" would look swallowed. Left in the
		// queue instead, `handleImplicitYield` picks it up immediately (it does
		// not even announce idle when something is pending) and the agent turns
		// straight around to it. The queue is the buffer; don't front-run it.
		let cancellationQueueMsgs: QueueMessage[] = [];
		if (queue && !interrupt?.requested) {
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

		// Emit tool_result + messages_consumed events
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
				const bwEvt: EventSpec = {
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
