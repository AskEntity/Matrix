import type { QueueMessage } from "./message-queue.ts";
import {
	createBackgroundComplete,
	createUserMessage,
} from "./queue-message-factory.ts";
import type { EventImageData, PendingState } from "./shared-types.ts";
import type { JsonTool } from "./tool-definition.ts";
import { TOOL_DONE, TOOL_YIELD } from "./tool-names.ts";

export type { EventImageData, PendingState } from "./shared-types.ts";

/**
 * Strongly-typed event — provider-agnostic, one event per action.
 * Each event represents a single atomic action (no batching).
 *
 * All injected content uses `type: "message"` with a `body` field.
 * `body.source` discriminates: "user", "tree_change", "task_complete", "task_message", etc.
 */

/**
 * MessageEvent — unified format for ALL messages that flow through the system.
 * Uses `body.source` to indicate the message type. Written to JSONL with `id` for tracking.
 * All data lives in `body` as a QueueMessage discriminated union.
 */
interface MessageEvent {
	type: "message";
	/** ULID — identifies this message for two-phase lifecycle. */
	id: string;
	/** Task/session ID — used for JSONL routing and SSE broadcast targeting. */
	taskId: string;
	/** Structured message body — QueueMessage discriminated union. */
	body: QueueMessage;
	ts: number;
}

/**
 * Session configuration snapshot — persisted at JSONL start and after compact_marker.
 * Records the exact tools + system prompt used for this session segment.
 * Fork copies this event → child gets parent's exact config → cache hit.
 * Between compactions, system + tools are FROZEN → cache 100% stable.
 */
export interface SessionConfigEvent {
	type: "session_config";
	/**
	 * Provider-agnostic tool definitions (JSON Schema).
	 * The golden source: computed once at session start, frozen in JSONL.
	 * On resume, providers map these to their own format — no Zod regeneration.
	 */
	tools: JsonTool[];
	/** SYSTEM_PROMPT pure text — shared by ALL agents, never changes. */
	systemStable: string;
	/** Role + date + selfBootstrap — per-agent, per-day. */
	systemVariable: string;
	/**
	 * Cache TTL for message-level cache breakpoints.
	 * Root + persistent tasks: "1h" (long-lived, stable conversations).
	 * Regular children: undefined (default 5min ephemeral).
	 * Inherited via fork (session_config copied to child JSONL).
	 */
	cacheTtl?: "1h";
	taskId: string;
	ts: number;
}

export type Event = (
	| MessageEvent
	| SessionConfigEvent
	| { type: "assistant_text"; content: string; taskId: string; ts: number }
	| {
			type: "tool_call";
			tool: string;
			toolCallId: string;
			input: Record<string, unknown>;
			taskId: string;
			ts: number;
	  }
	| {
			type: "tool_result";
			tool: string;
			toolCallId: string;
			content: string;
			isError: boolean;
			images?: EventImageData[];
			/** Structured pending state (running children + clarifications). */
			pending?: PendingState;
			/** Background process ID — set when bash moves a command to background. */
			backgroundId?: string;
			/** Background command — set when bash moves a command to background. */
			backgroundCommand?: string;

			taskId: string;
			ts: number;
	  }
	// Thinking events — extended thinking (Anthropic)
	| {
			type: "thinking";
			thinking: string;
			signature: string;
			taskId: string;
			ts: number;
	  }
	// Per-turn token usage — persisted to JSONL for historical cache diagnostics
	| {
			type: "usage";
			taskId: string;
			inputTokens: number;
			outputTokens?: number;
			contextWindow: number;
			estimated?: boolean;
			cacheCreationTokens?: number;
			cacheReadTokens?: number;
			ts: number;
	  }
	// Ephemeral events — broadcast over WS but not persisted to JSONL
	| { type: "thinking_delta"; thinking: string; taskId: string; ts: number }
	| { type: "text_delta"; content: string; taskId: string; ts: number }
	| { type: "agent_idle"; taskId: string; ts: number }
	| { type: "agent_active"; taskId: string; ts: number }
	| { type: "status"; message: string; taskId: string; ts: number }
	| {
			type: "clarification_timeout";
			taskId: string;
			timeoutMs: number;
			ts: number;
	  }
	| {
			type: "compacted_resume";
			content: string;
			cwd?: string;
			taskId: string;
			ts: number;
	  }
	| {
			type: "summarization_request";
			instruction: string;
			taskId: string;
			ts: number;
	  }
	| { type: "budget_warning"; warning: string; taskId: string; ts: number }
	| {
			type: "compact_marker";
			checkpoint: string;
			savedTokens: number;
			taskId: string;
			ts: number;
	  }
	// Lifecycle events — persisted to JSONL for activity log replay
	| {
			type: "orchestration_started";
			taskId: string;
			resume: boolean;
			model: string;
			provider: string;
			ts: number;
	  }
	| {
			type: "orchestration_completed";
			taskId: string;
			success: boolean;
			costUsd?: number;
			turns?: number;
			inputTokens?: number;
			cacheCreationTokens?: number;
			cacheReadTokens?: number;
			outputTokens?: number;
			childCosts?: {
				totalCostUsd: number;
				totalTurns: number;
				taskCount: number;
			};
			ts: number;
	  }
	| { type: "task_started"; taskId: string; title: string; ts: number }
	| { type: "error"; taskId: string; message: string; ts: number }
	| {
			type: "budget_exceeded";
			taskId: string;
			title: string;
			costUsd: number;
			budgetUsd: number;
			ts: number;
	  }
	| {
			type: "clarification_requested";
			taskId: string;
			question: string;
			/** Short title extracted from question (first line or full question). */
			title: string;
			/** Detailed body (remaining lines after title). */
			body?: string;
			ts: number;
	  }
	| {
			type: "clarification_answered";
			taskId: string;
			answer: string;
			ts: number;
	  }
	| { type: "compact_started"; taskId: string; ts: number }
	| { type: "agent_stopped"; taskId: string; ts: number }
	| {
			type: "messages_consumed";
			messageIds: string[];
			taskId: string;
			ts: number;
	  }
	| {
			type: "fork_marker";
			/** Task ID of the source session whose context was copied. */
			sourceTaskId: string;
			/** Title of the target task (the new agent's task). */
			targetTitle?: string;
			/** Description of the target task. */
			targetDescription?: string;
			taskId: string;
			ts: number;
	  }
	| {
			type: "done_notified";
			/** The committed status after done() — "verify" for passed, "failed" for failed. */
			status: "verify" | "failed";
			/** The agent's summary text from done(). */
			summary: string;
			taskId: string;
			ts: number;
	  }
) & {
	/**
	 * ULID identifying the agent loop instance (runAgentForNode invocation)
	 * that emitted this event. Generated once per loop, injected into every
	 * event via emitWithTask. Used to detect interleaved events from duplicate
	 * launches of the same task.
	 */
	traceId?: string;
};

/**
 * Whether emitEvent() should persist this event to JSONL.
 *
 * Returns false for:
 * - Truly ephemeral events (text_delta, usage, status, etc.) — broadcast only, never persisted
 *
 * Returns true for all other events, which are persisted by emitEvent to JSONL.
 * This includes provider events (assistant_text, tool_call, tool_result, compact_marker)
 * which flow through emitEvent via the provider's emit callback.
 *
 * Uses an exhaustive switch — adding a new Event type without handling it here
 * causes a compile error (default: never check).
 */
export function isPersistedByEmitEvent(event: Event): boolean {
	switch (event.type) {
		// Ephemeral — broadcast only, never persisted
		case "thinking_delta":
		case "text_delta":
		case "agent_idle":
		case "agent_active":
		case "status":
		case "clarification_timeout":
			return false;

		// Persisted — written to JSONL by emitEvent
		case "usage":
		case "thinking":
		case "session_config":
		case "message":
		case "assistant_text":
		case "tool_call":
		case "tool_result":
		case "compacted_resume":
		case "summarization_request":
		case "budget_warning":
		case "compact_marker":
		case "orchestration_started":
		case "orchestration_completed":
		case "task_started":
		case "error":
		case "budget_exceeded":
		case "clarification_requested":
		case "clarification_answered":
		case "compact_started":
		case "agent_stopped":
		case "messages_consumed":
		case "fork_marker":
		case "done_notified":
			return true;

		default: {
			// Exhaustive check — TypeScript error if a new Event type is added
			// without handling it above.
			const _exhaustive: never = event;
			return _exhaustive;
		}
	}
}

/**
 * Check if an event originated from the message queue.
 * A `message` event is a queue event if `body.source` is present and not "user".
 */
export function isQueueEvent(event: Event): boolean {
	if (event.type === "message") {
		return event.body.source !== "user";
	}
	return false;
}

/** Convert a QueueMessage to a unified `message` Event with body. */
export function queueMessageToEvent(
	msg: QueueMessage,
	taskId: string,
): MessageEvent {
	return { type: "message", id: msg.id, taskId, body: msg, ts: msg.ts };
}

/**
 * Format a QueueMessage body for AI consumption based on source narrowing.
 * Used by formatEventForAI for message events.
 */
function formatBodyForAI(body: QueueMessage): string {
	switch (body.source) {
		case "task_complete":
			return `<task_complete from_task="${body.taskId}" task_name="${body.title}" status="${body.success ? "passed" : "failed"}">${body.output}</task_complete>`;
		case "clarify_response":
			return `<clarify_response>${body.answer}</clarify_response>`;
		case "user_message_forwarded": {
			const resumedAttr = body.resumed ? ' resumed="true"' : "";
			return `<user_message_forwarded from_task="${body.fromTaskId}" task_name="${body.fromTitle}"${resumedAttr}>${body.content}</user_message_forwarded>`;
		}
		case "task_message": {
			const titleAttr = body.title ? ` title="${body.title}"` : "";
			const replyAttr = body.requestReply ? ' requestReply="true"' : "";
			const tag = `<task_message from_task="${body.fromTaskId}" task_name="${body.fromTitle}"${titleAttr}${replyAttr}>${body.content}</task_message>`;
			if (body.header) {
				return `${body.header}\n\n${tag}`;
			}
			return tag;
		}
		case "cross_project":
			return `<cross_project from="${body.fromProjectName}" projectId="${body.fromProjectId}">${body.content}</cross_project>`;
		case "background_complete": {
			const parts: string[] = [];
			if (body.stdout) parts.push(`stdout:\n${body.stdout}`);
			if (body.stderr) parts.push(`stderr:\n${body.stderr}`);
			const innerContent =
				parts.length > 0
					? `${parts.join("\n")}\nexit code: ${body.exitCode}`
					: `exit code: ${body.exitCode}`;
			return `<background_complete command="${body.command}" id="${body.commandId}" exit="${body.exitCode}" duration="${body.durationMs}ms">${innerContent}</background_complete>`;
		}
		case "tree_change":
			return `<tree_change action="${body.action}" nodeId="${body.nodeId}"${body.title ? ` title="${body.title}"` : ""}>Call get_tree to see latest state.</tree_change>`;
		case "compact":
			return "Manual compaction requested";
		case "user":
			if (body.header) {
				return `${body.header}\n\n${body.content}`;
			}
			return body.content;
		default:
			return "";
	}
}

/**
 * Format a timestamp as [HH:MM:SS] for AI message display.
 */
export function formatTimestamp(ts: number): string {
	return new Date(ts).toLocaleTimeString("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
}

/**
 * Format a concrete Event for inclusion in provider messages.
 * `message` events use body.source to determine formatting.
 * All messages get [HH:MM:SS] timestamp prefix for consistency between
 * live path and JSONL reconstruction path.
 */
export function formatEventForAI(event: Event): string {
	if (event.type === "message") {
		// Defensive: body should always be present but guard against corrupt data
		if (!event.body) return "";
		const text = formatBodyForAI(event.body);
		if (!text) return "";
		return `[${formatTimestamp(event.ts)}] ${text}`;
	}
	return "";
}

/**
 * Format a structured pending section into text for AI consumption.
 * Converts the structured `pending` field on tool_result into the `## Pending` text format.
 */
export function formatPendingSection(pending: PendingState): string {
	const runningChildrenText =
		pending.runningChildren.length > 0
			? pending.runningChildren.map((c) => `"${c.title}" (${c.id})`).join(", ")
			: "none";
	const clarifyText =
		pending.pendingClarifications > 0
			? String(pending.pendingClarifications)
			: "none";
	return [
		"",
		"## Pending",
		`- Running sub tasks: ${runningChildrenText}`,
		`- Pending clarifications: ${clarifyText}`,
	].join("\n");
}

/**
 * Reconstruct Anthropic-format messages from events.
 * Pure function — no side effects or external dependencies.
 *
 * Key batching rules:
 * - assistant_text + consecutive tool_calls → single assistant message
 * - consecutive tool_results (with optional queue events) → single user message
 * - compact_marker → skipped (readActive handles filtering)
 */

/**
 * Find message events that were persisted to JSONL but never consumed.
 * A message is "unconsumed" if it has a non-empty `id` and no `messages_consumed`
 * event references that id. This happens when a message arrives while a tool is
 * executing, gets enqueued to the live queue and persisted to JSONL as a `message`
 * event, but the daemon crashes before the provider loop can drain the queue and
 * emit a `messages_consumed` event.
 *
 * Returns the QueueMessage bodies of unconsumed messages (in order).
 * These should be enqueued to the agent's queue on resume so they're delivered.
 */
export function findUnconsumedMessages(events: Event[]): QueueMessage[] {
	// Collect all message IDs that were consumed
	const consumedIds = new Set<string>();
	for (const e of events) {
		if (e.type === "messages_consumed") {
			for (const id of e.messageIds) {
				consumedIds.add(id);
			}
		}
	}

	// Find message events with IDs that were never consumed
	const unconsumed: QueueMessage[] = [];
	for (const e of events) {
		if (e.type === "message" && e.id && !consumedIds.has(e.id)) {
			unconsumed.push(e.body);
		}
	}
	return unconsumed;
}

/**
 * Check if the last tool_call in events is a yield with no matching tool_result.
 * This means the agent was in yield state when the daemon restarted.
 * When a yield is pending, NOTHING should be written to JSONL after the yield
 * tool_call — the provider loop handles yield resolution at resume time.
 * External events (bg_complete, etc.) should go to the queue instead.
 */
export function hasPendingYield(events: Event[]): boolean {
	const lastToolCall = [...events]
		.reverse()
		.find((e) => e.type === "tool_call");
	if (lastToolCall?.type === "tool_call" && lastToolCall.tool === TOOL_YIELD) {
		const hasResult = events.some(
			(e) =>
				e.type === "tool_result" && e.toolCallId === lastToolCall.toolCallId,
		);
		return !hasResult;
	}
	return false;
}

/**
 * Check if the session ended in implicit yield (end_turn — model stopped without tool calls).
 * This happens when the daemon crashes while the agent is in handleImplicitYield,
 * waiting for messages after an end_turn response.
 *
 * Detection: the last provider content event (assistant_text, tool_call, tool_result)
 * is assistant_text, and no tool_call follows it. This means the model ended its turn
 * naturally and the agent was waiting for new messages when it died.
 */
export function hasPendingImplicitYield(events: Event[]): boolean {
	// Walk backwards to find the last provider content event
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i] as Event;
		if (e.type === "assistant_text") return true;
		if (e.type === "tool_call" || e.type === "tool_result") return false;
	}
	return false;
}

/**
 * Find background processes that were started but never completed.
 * A background process is "orphaned" if a tool_result has a `backgroundId`
 * but no `message` event with `source: "background_complete"` and matching
 * `commandId` exists. This happens when the daemon crashes while a background
 * process is running — the process is killed but no completion event is generated.
 *
 * Returns synthetic message events with `background_complete` bodies that should
 * be appended to JSONL so the frontend can clean up the stale UI entries.
 */
export function findOrphanedBackgroundProcesses(
	events: Event[],
	taskId: string,
): Event[] {
	// Collect all background processes started (from tool_result events)
	const bgProcesses = new Map<string, { command: string; ts: number }>();
	for (const e of events) {
		if (e.type === "tool_result" && e.backgroundId) {
			bgProcesses.set(e.backgroundId, {
				command: e.backgroundCommand ?? "",
				ts: e.ts,
			});
		}
	}

	// Collect all completed background processes (from message events)
	const completedIds = new Set<string>();
	for (const e of events) {
		if (
			e.type === "message" &&
			e.body &&
			typeof e.body === "object" &&
			"source" in e.body &&
			e.body.source === "background_complete" &&
			"commandId" in e.body
		) {
			completedIds.add((e.body as { commandId: string }).commandId);
		}
	}

	// Generate synthetic background_complete for orphaned processes
	const orphans: Event[] = [];
	for (const [bgId, info] of bgProcesses) {
		if (!completedIds.has(bgId)) {
			const body = createBackgroundComplete({
				commandId: bgId,
				command: info.command,
				exitCode: null,
				durationMs: 0,
				stdout: "",
				stderr: "Background process interrupted by daemon restart",
			});
			orphans.push({
				type: "message",
				id: body.id,
				taskId,
				body,
				ts: body.ts,
			});
		}
	}
	return orphans;
}

// ── JSONL Repair: truncate-and-rebuild ──

/**
 * Inspect a session's events and determine if repair is needed.
 * Finds the last complete assistant turn (all tool_calls have exactly one
 * valid tool_result, no duplicates). Everything after it is the "tail"
 * that may contain poison (duplicate tool_results, orphaned calls, etc.).
 *
 * Returns null if no repair needed, otherwise returns:
 * - truncateAfterIndex: line index to truncate after (keep lines 0..index inclusive)
 * - appendEvents: events to append after truncation (interrupted tool_results + status message)
 *
 * This replaces findOrphanedToolCalls, findOrphanedBackgroundProcesses, and
 * the in-memory auto-recovery in provider-shared.ts — a single mechanism for
 * ALL JSONL repair scenarios (daemon restart, API 400, duplicate results).
 */
export function buildSessionRepair(
	events: Event[],
	taskId: string,
	opts?: { reason?: string },
): {
	truncateAfterIndex: number;
	appendEvents: Event[];
} | null {
	if (events.length === 0) return null;

	// Collect tool_call → tool info and tool_result counts
	const toolCallTools = new Map<string, string>(); // callId → tool name
	const toolResultCounts = new Map<string, number>();
	for (const e of events) {
		if (e.type === "tool_call") {
			toolCallTools.set(e.toolCallId, e.tool);
		} else if (e.type === "tool_result") {
			const count = toolResultCounts.get(e.toolCallId) ?? 0;
			toolResultCounts.set(e.toolCallId, count + 1);
		}
	}

	// Find the LAST tool_call in the event stream — if it's yield/done,
	// it's the "intended orphan" for resume (no tool_result expected yet).
	// All OTHER yield/done orphans are genuine bugs that need repair.
	let lastToolCallId: string | null = null;
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i];
		if (e?.type === "tool_call") {
			lastToolCallId = e.toolCallId;
			break;
		}
	}

	// Check positional ordering: a tool_result must appear before the next
	// assistant turn after its tool_call. If a new assistant_text appears between
	// a tool_call and its tool_result, the result is out of position.
	// This happens when duplicate agent loops write interleaved events.
	const toolCallIndices = new Map<string, number>(); // callId → event index
	const toolResultIndices = new Map<string, number>(); // callId → first result index
	const assistantTextIndices: number[] = [];
	for (let i = 0; i < events.length; i++) {
		const e = events[i];
		if (e?.type === "tool_call") {
			toolCallIndices.set(e.toolCallId, i);
		} else if (
			e?.type === "tool_result" &&
			!toolResultIndices.has(e.toolCallId)
		) {
			toolResultIndices.set(e.toolCallId, i);
		} else if (e?.type === "assistant_text") {
			assistantTextIndices.push(i);
		}
	}

	// Find the earliest out-of-position tool_result: there exists an assistant_text
	// between the tool_call and its tool_result (a new turn started before resolution).
	let outOfOrderIndex = -1;
	for (const [callId, callIdx] of toolCallIndices) {
		const resultIdx = toolResultIndices.get(callId);
		if (resultIdx === undefined) continue; // orphan — handled below
		// Check if any assistant_text falls between callIdx and resultIdx
		for (const atIdx of assistantTextIndices) {
			if (atIdx > callIdx && atIdx < resultIdx) {
				// This tool_result is out of position — record the earliest problem point
				if (outOfOrderIndex === -1 || callIdx < outOfOrderIndex) {
					outOfOrderIndex = callIdx;
				}
				break;
			}
		}
	}

	// Categorize problems
	let hasDuplicates = false;
	const orphanCallIds: string[] = [];
	for (const [callId, tool] of toolCallTools) {
		// Only skip the LAST tool_call if it's yield/done (intended orphan for resume).
		// Earlier yield/done orphans are genuine bugs (e.g., API returned duplicate
		// yield calls in same turn, only the first got a tool_result).
		if (
			(tool === TOOL_YIELD || tool === TOOL_DONE) &&
			callId === lastToolCallId
		)
			continue;
		const resultCount = toolResultCounts.get(callId) ?? 0;
		if (resultCount > 1) hasDuplicates = true;
		if (resultCount === 0) orphanCallIds.push(callId);
	}

	if (!hasDuplicates && orphanCallIds.length === 0 && outOfOrderIndex === -1)
		return null;

	// Strategy 0: OUT-OF-ORDER tool_results — truncate from the problematic tool_call.
	// This is the most severe case: two agent loops wrote interleaved events.
	// Truncate everything from the first out-of-order tool_call onwards, append
	// interrupted tool_results for any orphaned calls in the kept section.
	if (outOfOrderIndex >= 0) {
		// Truncate from one event BEFORE the out-of-order tool_call
		const truncateAt = Math.max(0, outOfOrderIndex - 1);
		const keptEvents = events.slice(0, truncateAt + 1);

		// Find orphans in the kept section
		const keptCalls = new Map<string, string>();
		const keptResults = new Set<string>();
		for (const e of keptEvents) {
			if (e.type === "tool_call") keptCalls.set(e.toolCallId, e.tool);
			else if (e.type === "tool_result") keptResults.add(e.toolCallId);
		}

		const appendEvents: Event[] = [];
		const now = Date.now();
		for (const [callId, tool] of keptCalls) {
			if (keptResults.has(callId)) continue;
			// Skip the intended orphan (last yield/done in kept section)
			if (tool === TOOL_YIELD || tool === TOOL_DONE) {
				let isLastCall = true;
				for (let i = keptEvents.length - 1; i >= 0; i--) {
					if (keptEvents[i]?.type === "tool_call") {
						isLastCall =
							(keptEvents[i] as Event & { toolCallId: string }).toolCallId ===
							callId;
						break;
					}
				}
				if (isLastCall) continue;
			}
			appendEvents.push({
				type: "tool_result" as const,
				tool,
				toolCallId: callId,
				content:
					"Tool execution was interrupted — out-of-order events detected and repaired.",
				isError: true,
				taskId,
				ts: now,
			} as Event);
		}

		if (opts?.reason) {
			appendEvents.push({
				type: "message",
				id: `repair-${now}`,
				taskId,
				body: {
					source: "system" as never,
					id: `repair-${now}`,
					ts: now,
					content: `Session repaired: ${opts.reason}. Out-of-order events truncated.`,
				},
				ts: now,
			} as Event);
		}

		return { truncateAfterIndex: truncateAt, appendEvents };
	}

	// Two different repair strategies:
	//
	// 1. ORPHAN only (0 results, no duplicates): APPEND missing results.
	//    Same behavior as old findOrphanedToolCalls — just add the missing
	//    tool_results at the end. No truncation needed.
	//
	// 2. DUPLICATE results: TRUNCATE from the first duplicate event onwards.
	//    The duplicate is the "poison" that causes API 400. Everything after
	//    it (including valid later turns) is lost. The orphan tool_calls
	//    created by truncation get interrupted results appended.

	if (!hasDuplicates) {
		// Strategy 1: orphan-only — append interrupted results (no truncation).
		// Same behavior as old findOrphanedToolCalls. No status message needed —
		// the autoResumeProjects resume message already tells the agent what happened.
		const appendEvents: Event[] = [];
		const now = Date.now();
		for (const callId of orphanCallIds) {
			const tool = toolCallTools.get(callId) ?? "unknown";
			appendEvents.push({
				type: "tool_result" as const,
				tool,
				toolCallId: callId,
				content:
					"Tool execution was interrupted by daemon restart. Results were lost.",
				isError: true,
				taskId,
				ts: now,
			} as Event);
		}

		return {
			truncateAfterIndex: events.length - 1, // no truncation — keep everything
			appendEvents,
		};
	}

	// Strategy 2: duplicate results — find first duplicate and truncate from there
	const seenResults = new Set<string>();
	let poisonIndex = -1;

	for (let i = 0; i < events.length; i++) {
		const e = events[i] as Event;
		if (e.type === "tool_result") {
			if (seenResults.has(e.toolCallId)) {
				poisonIndex = i;
				break;
			}
			seenResults.add(e.toolCallId);
		}
	}

	if (poisonIndex === -1) return null; // shouldn't happen

	// Truncate point: one event before the poison
	let lastGoodIndex = poisonIndex - 1;
	if (lastGoodIndex < 0) lastGoodIndex = 0;

	// Everything after lastGoodIndex is the truncated region
	const truncatedRegion = events.slice(lastGoodIndex + 1);

	// Collect error messages from truncated region
	const errorMessages: string[] = [];
	for (const e of truncatedRegion) {
		if (e.type === "error" && "message" in e && typeof e.message === "string") {
			if (e.message.includes("400") || e.message.includes("Auto-recovery")) {
				errorMessages.push(e.message);
			}
		}
	}

	// Build interrupted tool_results for orphaned tool_calls.
	// Two sources of orphans:
	// 1. Tool_calls in the KEPT region whose results were in the truncated region
	//    (e.g., tool_call at index 8, result was at index 9 = the poison)
	// 2. Tool_calls in the truncated region (later turns that got removed)
	const appendEvents: Event[] = [];
	const now = Date.now();

	// Scan kept region for tool_calls whose results are being truncated
	const keptEvents = events.slice(0, lastGoodIndex + 1);
	const keptResultIds = new Set<string>();
	for (const e of keptEvents) {
		if (e.type === "tool_result") keptResultIds.add(e.toolCallId);
	}
	for (const e of keptEvents) {
		if (
			e.type === "tool_call" &&
			e.tool !== TOOL_YIELD &&
			!keptResultIds.has(e.toolCallId)
		) {
			appendEvents.push({
				type: "tool_result" as const,
				tool: e.tool,
				toolCallId: e.toolCallId,
				content: "interrupted, results unknown",
				isError: true,
				taskId,
				ts: now,
			} as Event);
		}
	}

	// Tool_calls in the truncated region also need interrupted results
	for (const e of truncatedRegion) {
		if (e.type === "tool_call" && e.tool !== TOOL_YIELD) {
			appendEvents.push({
				type: "tool_result" as const,
				tool: e.tool,
				toolCallId: e.toolCallId,
				content: "interrupted, results unknown",
				isError: true,
				taskId,
				ts: now,
			} as Event);
		}
	}

	// Preserve unconsumed messages from the truncated region.
	// These were delivered to JSONL but will be lost by truncation.
	// Re-append them so findUnconsumedMessages can recover them.
	// (messages_consumed entries for these are also truncated, so they
	// become unconsumed again — exactly what we want.)
	for (const e of truncatedRegion) {
		if (e.type === "message" && e.id && e.body) {
			appendEvents.push(e);
		}
	}

	// Status message
	let statusText: string;
	if (errorMessages.length > 0) {
		const uniqueErrors = [...new Set(errorMessages)].slice(0, 3);
		statusText = `Session repaired. Tool execution encountered errors:\n${uniqueErrors.join("\n")}\n\nAffected tool results have been removed. Continue from where you left off.`;
	} else {
		statusText =
			opts?.reason ??
			"Session repaired. Duplicate tool results were removed. Continue from where you left off.";
	}

	const statusMsg = createUserMessage(statusText);
	appendEvents.push({
		type: "message" as const,
		id: statusMsg.id,
		taskId,
		body: statusMsg,
		ts: statusMsg.ts,
	} as Event);

	return {
		truncateAfterIndex: lastGoodIndex,
		appendEvents,
	};
}
