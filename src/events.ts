import type { QueueMessage } from "./message-queue.ts";
import {
	createBackgroundComplete,
	createUserMessage,
} from "./queue-message-factory.ts";
import type { EventImageData, PendingState } from "./shared-types.ts";
import type { JsonTool } from "./tool-definition.ts";
import { TOOL_DONE, TOOL_YIELD } from "./tool-names.ts";
import type { AgentActivity } from "./types.ts";

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

/**
 * Distributive Omit — preserves union structure unlike plain Omit<Union, K>.
 * Plain Omit collapses the union to an intersection, losing discriminated union properties.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
	? Omit<T, K>
	: never;

/**
 * EventSpec — an event before routing. Producers create these without taskId;
 * the emit layer adds taskId + traceId to produce a full Event.
 */
export type EventSpec = DistributiveOmit<Event, "taskId">;

export type Event = (
	| MessageEvent
	| SessionConfigEvent
	| {
			type: "assistant_text";
			content: string;
			taskId: string;
			ts: number;
			/**
			 * Synthetic snapshot of in-flight streaming text, injected by the batch
			 * events endpoint so that refresh mid-stream doesn't lose what's already
			 * been deltaed. Never persisted to JSONL; never produced by the provider.
			 *
			 * Clients treat `partial` events as MONOTONIC extend (text only grows)
			 * rather than replace — see `extend_text` in the plugin event-handler.
			 */
			partial?: boolean;
	  }
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
			/** Provider that produced this thinking block (e.g. "anthropic"). Used to filter
			 *  out stale thinking blocks after provider switch — each provider only sees its own. */
			provider?: string;
			/** True when this block was a redacted_thinking from the API (safety redaction).
			 *  Walker reconstructs as `{ type: "redacted_thinking", data: signature }`.
			 *  Normal empty thinking (display:omitted) has redacted=undefined. */
			redacted?: boolean;
			/**
			 * Synthetic snapshot of in-flight thinking deltas, injected by the batch
			 * events endpoint so that refresh mid-stream doesn't lose thinking text
			 * that has only arrived as `thinking_delta` events (those are ephemeral
			 * and never persisted). Never written to JSONL; never produced by the
			 * provider. Clients treat `partial` events as MONOTONIC extend
			 * (thinking only grows) — see `extend_thinking` in the plugin
			 * event-handler.
			 */
			partial?: boolean;
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
			cacheCreationTokens?: number;
			cacheReadTokens?: number;
			ts: number;
	  }
	// Ephemeral events — broadcast over WS but not persisted to JSONL
	| { type: "thinking_delta"; thinking: string; taskId: string; ts: number }
	| { type: "text_delta"; content: string; taskId: string; ts: number }
	| {
			/**
			 * The agent's activity changed. THE one event carrying activity —
			 * it replaced the agent_idle/agent_active pair, which only ever
			 * covered "parked on the queue or not" and left the UI guessing at
			 * the rest from log shape and timers.
			 *
			 * Ephemeral BY DESIGN, not by accident: it must never reach JSONL.
			 * Replaying a log of past activity changes would reconstruct a
			 * past "active" as a present one — the exact category error this
			 * event exists to kill. Keeping it out of JSONL makes that
			 * structurally impossible rather than something a poll corrects
			 * after the fact.
			 */
			type: "agent_activity";
			taskId: string;
			/** null = the session ended; the task has no agent at all. */
			state: AgentActivity | null;
			ts: number;
	  }
	| { type: "status"; message: string; taskId: string; ts: number }
	| {
			type: "clarification_timeout";
			taskId: string;
			timeoutMs: number;
			ts: number;
	  }
	| { type: "budget_warning"; warning: string; taskId: string; ts: number }
	| {
			/** Empty boundary marker — content lives in subsequent compacted_resume message. */
			type: "compact_marker";
			savedTokens: number;
			taskId: string;
			ts: number;
	  }
	// Lifecycle events — persisted to JSONL for activity log replay
	| {
			type: "agent_start";
			taskId: string;
			resume: boolean;
			model: string;
			provider: string;
			ts: number;
	  }
	| {
			type: "agent_end";
			taskId: string;
			reason:
				| "done_passed"
				| "done_failed"
				| "stopped"
				| "error"
				| "budget_exceeded";
			result?: string;
			stats?: {
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
				contextWindow?: number;
			};
			ts: number;
	  }
	| { type: "error"; taskId: string; message: string; ts: number }
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
			taskId: string;
			[key: string]: unknown;
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

	/**
	 * 12-char hex event ID, unique within this JSONL file.
	 * Auto-generated by EventStore on append — callers never set this.
	 * Used for parent-chain traversal: readActive walks the parentEid chain
	 * from the last event to reconstruct the active event sequence.
	 */
	eid?: string;

	/**
	 * eid of the preceding event in the active chain, or null for the first event.
	 * Auto-generated by EventStore on append — callers never set this.
	 * Normally forms a linear chain (each event → previous). After a rollback
	 * (setChainHead), the next event's parentEid jumps to the target event,
	 * skipping over rolled-back events.
	 */
	parentEid?: string | null;
};

/**
 * Whether emitEvent() should persist this event to JSONL.
 *
 * This answers exactly one question — does THIS path write the event — and
 * says nothing about whether some other writer does. `false` means "emitEvent
 * broadcasts it and moves on", NOT "this type can never appear in a JSONL
 * file": any caller holding an EventStore can append whatever it needs, and
 * one does (see the `status` case below).
 *
 * Returns true for the rest, including provider events (assistant_text,
 * tool_call, tool_result, compact_marker) which flow through emitEvent via the
 * provider's emit callback.
 *
 * Uses an exhaustive switch — adding a new Event type without handling it here
 * causes a compile error (default: never check).
 */
export function isPersistedByEmitEvent(event: Event): boolean {
	switch (event.type) {
		// Broadcast only — emitEvent does not write these.
		case "thinking_delta":
		case "text_delta":
		// agent_activity is live process state, not history. Persisting it
		// would let a replay of the log resurrect a past "active" as a
		// present one — see the type's own comment.
		case "agent_activity":
		// `status` is the exception worth knowing about: a repair writes one
		// straight to the EventStore (see `repairStatusEvent`), because that
		// event's parentEid is what makes the repair's chain jump durable. So a
		// repaired session DOES have status lines in its JSONL. Don't turn this
		// list into a "never appears on disk" invariant — the test would pass
		// everywhere except on the rarest path.
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
		case "budget_warning":
		case "compact_marker":
		case "agent_start":
		case "agent_end":
		case "error":
		case "clarification_requested":
		case "clarification_answered":
		case "compact_started":
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
			return `<task_message from_task="${body.fromTaskId}" task_name="${body.fromTitle}"${titleAttr}${replyAttr}>${body.content}</task_message>`;
		}
		case "cross_project":
			return `<cross_project from="${body.fromProjectName}" projectId="${body.fromProjectId}">${body.content}</cross_project>`;
		case "background_complete":
			return `<background_complete command="${body.command}" id="${body.commandId}" exit="${body.exitCode}" duration="${body.durationMs}ms">${body.content}</background_complete>`;
		case "tree_change":
			return `<tree_change action="${body.action}" nodeId="${body.nodeId}"${body.title ? ` title="${body.title}"` : ""}>Call get_tree to see latest state.</tree_change>`;
		case "compact":
			return "Manual compaction requested";
		case "user":
			return body.content;
		case "work_context":
			return body.content;
		case "compacted_resume":
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
				content: "Background process interrupted by daemon restart",
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

/**
 * The raw `input` object of the LAST done() tool_call in a slice of events
 * (the exact object the agent passed to done(), read from the JSONL — the
 * single source of truth), or undefined when there is no done() tool_call.
 *
 * GENERIC — no field knowledge beyond "which tool is done". The runtime hands
 * this record OPAQUELY to the plugin's onDone hook; only the plugin reads its
 * content fields (Matrix: {result} via parseDonePayload). Keeping the runtime
 * on the raw record is what prevents round structure from leaking into the
 * plugin-agnostic layer.
 */
export function readDoneInput(
	events: Event[],
): Record<string, unknown> | undefined {
	let last: Record<string, unknown> | undefined;
	for (const e of events) {
		if (e.type === "tool_call" && e.tool === TOOL_DONE) {
			last = e.input;
		}
	}
	return last;
}

/**
 * The completion-output string of a done() input — the universal "what
 * happened" summary the runtime sends to the parent (task_complete) and records
 * on the done_notified marker. This is the ONE done field the runtime is allowed
 * to read: a completion output every plugin has, conventionally named `result`.
 * NOT round content / structure — that stays inside the plugin's onDone.
 * Empty string when absent / non-string.
 */
export function doneCompletionOutput(
	input: Record<string, unknown> | undefined,
): string {
	return typeof input?.result === "string" ? input.result : "";
}

// ── JSONL Repair: truncate-and-rebuild ──

type ToolCallEvent = Extract<Event, { type: "tool_call" }>;

/** The last tool_call event in a slice (intended-orphan detection), or null. */
function lastToolCallEvent(events: Event[]): ToolCallEvent | null {
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i];
		if (e?.type === "tool_call") return e;
	}
	return null;
}

/** What a repair does: jump the chain back to `chainToEid`, then append. */
export interface SessionRepair {
	/**
	 * The event the repaired chain must point at — the last event the repair
	 * keeps. `null` means "no jump": the repair only appends (missing
	 * tool_results for orphaned calls), nothing is dropped.
	 *
	 * The caller applies it exactly like a rollback: `setChainHead(chainToEid)`
	 * then append. `setChainHead` is pure in-memory, so the jump only becomes
	 * durable when the first appended event is written carrying it as its
	 * parentEid — which is why a repair with a `chainToEid` ALWAYS has at least
	 * one append event.
	 */
	chainToEid: string | null;
	/** Interrupted tool_results, replayed messages, and the repair status. */
	appendEvents: Event[];
}

/**
 * Inspect a session's events and determine if repair is needed.
 * Finds the last complete assistant turn (all tool_calls have exactly one
 * valid tool_result, no duplicates). Everything after it is the "tail"
 * that may contain poison (duplicate tool_results, orphaned calls, etc.).
 *
 * Repair NEVER deletes anything. The poisoned events stay on disk and simply
 * leave the active chain, exactly like a rolled-back branch. The old shape
 * returned an index the caller translated into a physical JSONL line for
 * `truncateAfterLine`; that translation was the source of two separate
 * data-destroying bugs (FIX-1 cc#1 sliced across a compact boundary, FIX-8
 * R8-B#4 mis-cut whenever a crash-torn line shifted the mapping) and it
 * destroyed the very evidence needed to debug the corruption.
 *
 * COMPACT-BOUNDARY SAFETY: analysis is scoped to the region after the last
 * `compact_marker`. The marker, the post-compact session_config, the summary,
 * and the messages stranded in the compaction window are all load-bearing for
 * a compacted session's resume and must never be dropped.
 *
 * Returns null when no repair is needed.
 *
 * This replaces findOrphanedToolCalls, findOrphanedBackgroundProcesses, and
 * the in-memory auto-recovery in provider-shared.ts — a single mechanism for
 * ALL JSONL repair scenarios (daemon restart, API 400, duplicate results).
 */
export function buildSessionRepair(
	events: Event[],
	taskId: string,
	opts?: { reason?: string },
): SessionRepair | null {
	if (events.length === 0) return null;
	const lastCompactMarker = events.findLastIndex(
		(e) => e.type === "compact_marker",
	);
	const offset = lastCompactMarker < 0 ? 0 : lastCompactMarker + 1;
	const active = offset === 0 ? events : events.slice(offset);
	// Chain targets are eids, so the active-region slice needs no index
	// translation on the way out.
	return repairActiveRegion(active, taskId, opts);
}

/**
 * The eid the repaired chain points at. Every event on an active chain is
 * stamped — `EventStore` stamps on write and migrates eid-less files on first
 * read — so a missing eid means these events never came from a store. Fail
 * loudly: a repair that cannot express its jump would silently leave the
 * poison in place and loop.
 */
function chainTarget(events: Event[], lastKeptIndex: number): string {
	const eid = events[lastKeptIndex]?.eid;
	if (!eid) {
		throw new Error(
			`buildSessionRepair: event at index ${lastKeptIndex} has no eid — a repair chains to an event, so every event must be stamped.`,
		);
	}
	return eid;
}

/**
 * Messages in the region the repair drops off the chain.
 *
 * Those events stay on disk but leave the active context, and the
 * `messages_consumed` records that acknowledged them leave with them — so
 * from the agent's point of view every message in there is undelivered again.
 * Re-appending puts them back on the chain (with fresh eids), where
 * `findUnconsumedMessages` picks them up on resume.
 *
 * ALL messages are replayed, not only the ones that never had a
 * `messages_consumed`: a message consumed into a turn the repair just dropped
 * is exactly as absent from the context as one that never arrived.
 */
function messagesToReplay(dropped: Event[]): Event[] {
	return dropped.filter((e) => e.type === "message" && !!e.id && !!e.body);
}

/**
 * The event that makes a repair's chain jump durable. `setChainHead` is pure
 * in-memory; the jump only reaches disk on the next write. Appending this
 * status guarantees there IS a next write even when the repair has nothing
 * else to say, and it leaves the repair visible in the activity log instead of
 * silently reshaping history. The walker skips `status` events, so it can
 * never affect the reconstructed conversation.
 *
 * Deliberately bypasses the emitEvent gate: `isPersistedByEmitEvent` returns
 * false for `status`, and the repair path appends to the EventStore directly.
 * That classifier is documented accordingly — it describes what emitEvent
 * writes, not what may exist on disk.
 */
function repairStatusEvent(taskId: string, reason: string): Event {
	return {
		type: "status",
		message: `Session repaired: ${reason}`,
		taskId,
		ts: Date.now(),
	} as Event;
}

/**
 * Core repair analysis over a single active region (no compact_marker inside).
 */
function repairActiveRegion(
	events: Event[],
	taskId: string,
	opts?: { reason?: string },
): SessionRepair | null {
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

		// Messages from the dropped region come back so they can be delivered
		// again — see messagesToReplay.
		appendEvents.push(...messagesToReplay(events.slice(truncateAt + 1)));

		// Status message — a synthetic USER-role message (createUserMessage),
		// so formatBodyForAI + UI materialization actually surface its content.
		// (The old `source: "system" as never` cast produced a body that
		// formatBodyForAI's `default` branch rendered to an empty string — the
		// repair reason silently vanished.) Only appended when the session does
		// NOT resume in a pending control state: a trailing unresolved
		// yield/done orphan must stay the last block, so appending a user
		// message after it would break assistant→tool_result alternation.
		const lastKept = lastToolCallEvent(keptEvents);
		const endsInPendingControl =
			!!lastKept &&
			(lastKept.tool === TOOL_YIELD || lastKept.tool === TOOL_DONE) &&
			!keptResults.has(lastKept.toolCallId);
		if (opts?.reason && !endsInPendingControl) {
			const statusMsg = createUserMessage(
				`Session repaired: ${opts.reason}. Out-of-order events dropped from the chain.`,
			);
			appendEvents.push({
				type: "message",
				id: statusMsg.id,
				taskId,
				body: statusMsg,
				ts: statusMsg.ts,
			} as Event);
		}

		// Last, so it can never split a run of tool_results into two user turns.
		appendEvents.push(
			repairStatusEvent(
				taskId,
				opts?.reason ?? "out-of-order events dropped from the chain",
			),
		);

		return { chainToEid: chainTarget(events, truncateAt), appendEvents };
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
			chainToEid: null, // nothing dropped — append-only repair
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
	// The ONLY legitimate orphans are tool_calls in the KEPT region whose
	// results lived in the truncated region (e.g. tool_call at index 8, result
	// at index 9 = the poison). Each gets a synthetic interrupted result so its
	// assistant turn resolves.
	//
	// We deliberately do NOT append results for tool_calls located in the
	// TRUNCATED region: those tool_calls are removed by truncation, so a result
	// referencing them would be an ORPHAN tool_result (a result with no matching
	// tool_call in the kept JSONL). The walker reconstructs that into an invalid
	// user message → API 400 → next launch's buildSessionRepair returns null (it
	// detects orphan CALLS and duplicates, not orphan RESULTS) → permanent crash
	// loop. The old "truncated region also need interrupted results" loop did
	// exactly this; it is gone.
	const appendEvents: Event[] = [];
	const now = Date.now();

	// Scan kept region for tool_calls whose results are being truncated.
	const keptEvents = events.slice(0, lastGoodIndex + 1);
	const keptResultIds = new Set<string>();
	for (const e of keptEvents) {
		if (e.type === "tool_result") keptResultIds.add(e.toolCallId);
	}
	// The intended orphan is the LAST tool_call in the kept region IF it's a
	// yield/done — it stays unresolved so the session resumes in its pending
	// control state. Every OTHER orphan (earlier yield/done, or any other tool)
	// gets an interrupted result. Skipping only TOOL_YIELD (and not TOOL_DONE)
	// was asymmetric: a kept-region done() orphan got a spurious tool_result.
	const intendedOrphan = lastToolCallEvent(keptEvents);
	const intendedOrphanId =
		intendedOrphan &&
		(intendedOrphan.tool === TOOL_YIELD || intendedOrphan.tool === TOOL_DONE)
			? intendedOrphan.toolCallId
			: null;
	for (const e of keptEvents) {
		if (e.type !== "tool_call" || keptResultIds.has(e.toolCallId)) continue;
		if (e.toolCallId === intendedOrphanId) continue; // intended orphan stays
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

	// Messages from the dropped region come back — see messagesToReplay.
	appendEvents.push(...messagesToReplay(truncatedRegion));

	// Status message — a synthetic USER-role message that resumes the session
	// with an API call. Skip it when the repaired session ends in an unresolved
	// intended-orphan yield/done: that turn must stay last (assistant→tool_result
	// alternation), and the session correctly resumes in its pending-yield /
	// pending-done state instead of forcing an API call. Without this guard the
	// intended-orphan skip above would be followed by a user message → invalid
	// structure → API 400.
	const endsInPendingControl =
		intendedOrphanId !== null && !keptResultIds.has(intendedOrphanId);
	if (!endsInPendingControl) {
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
	}

	// Last, so it can never split a run of tool_results into two user turns.
	appendEvents.push(
		repairStatusEvent(
			taskId,
			opts?.reason ?? "duplicate tool results dropped from the chain",
		),
	);

	return {
		chainToEid: chainTarget(events, lastGoodIndex),
		appendEvents,
	};
}

// ── Active chain walk ──

/**
 * The active event sequence: everything the agent's context is built from.
 * Returns event-array INDICES (into the passed `events` array) in
 * chronological order (ascending).
 *
 * ONE backward scan doing two things at once:
 *
 * 1. FOLLOW THE CHAIN. `parentEid` always points at an EARLIER position, so
 *    scanning backward is both the lookup and the traversal — no eid→index
 *    map, O(result) memory, and a cycle is structurally impossible because
 *    `i` only ever decreases. Without rollback every event chains linearly,
 *    so this is every event. After a rollback (`setChainHead`) the next
 *    event's parentEid jumps back over the abandoned branch, which the scan
 *    then never accepts.
 *
 * 2. CUT AT THE LAST COMPLETED COMPACTION. Walking backward, a
 *    `compact_marker` opens the compaction window and its `compact_started`
 *    closes the walk. Inside that window ONLY `message` events survive:
 *
 *      - Messages delivered while the summarizer runs land there. They belong
 *        to the post-compact context: the `messages_consumed` written AFTER
 *        the marker references them, and the walker materializes them into
 *        that user turn. Ending the chain at the marker (the old rule) left a
 *        consumption record pointing at an id the walker had never seen — the
 *        content vanished with no error at all. Measured on the root session:
 *        22 compactions, 8 with stranded messages, 15 lost, 4 typed by the
 *        user.
 *      - The summarizer's own output (`thinking`, the `<summary>…`
 *        `assistant_text`, `usage`) must NOT come back — the summary is
 *        already in the context as the `compacted_resume` message after the
 *        marker.
 *
 *    An UNPAIRED `compact_started` is NOT a barrier. A compaction takes
 *    minutes (124s / 178s / 145s on the three real root compactions); if the
 *    daemon dies inside that window there is no summary at all, so the
 *    pre-compact history must stay reachable. That is also why the barrier
 *    cannot be encoded as `compact_started.parentEid = null` at emission
 *    time — the outcome isn't known yet. See memory.md.
 *
 *    A `compact_marker` with NO `compact_started` before it (logs written
 *    before compact_started existed) keeps the old semantic: the marker ends
 *    the chain. That is why window messages are BUFFERED and only committed
 *    once the opening `compact_started` is actually found.
 *
 *    The `compact_marker` itself is always kept: the walker treats it as a
 *    structural no-op, `readFromLastCompactMarker` slices the UI log at it,
 *    and `buildSessionRepair` needs it to know where the repairable region
 *    starts.
 *
 * An event with NO parentEid ends the walk's chain-following: whatever comes
 * before it is taken linearly. That is the genuine chain root at index 0, and
 * it is also what makes a log written before eids existed readable.
 *
 * There is deliberately NO handling for a parentEid that points at an eid no
 * line carries. Every writer chains through `stampEvent`, and a fork re-links
 * the subset it copies, so a dangling link means the file's structure is
 * broken — we want that to show (the events before it stop rendering), not to
 * be quietly patched over by a fallback. Same rule as `buildSessionRepair`
 * refusing to repair orphan tool_results.
 */
export function walkActiveChainIndices(events: Event[]): number[] {
	const kept: number[] = [];
	/** Buffered window `message` indices; non-null ⇔ inside a compaction window. */
	let window: number[] | null = null;
	/**
	 * The eid the walk is looking for. `null` means "take the next event
	 * whatever it is" — the state at the head of the walk, and after an event
	 * that carries no parentEid.
	 */
	let wanted: string | null = null;

	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i] as Event;

		if (wanted !== null && e.eid !== wanted) continue; // not on the chain
		wanted = e.parentEid ?? null;

		if (window === null) {
			kept.push(i);
			// Walking backward, the marker is the window's far edge.
			if (e.type === "compact_marker") window = [];
			continue;
		}
		if (e.type === "compact_started") {
			// Completed compaction: its window messages are part of the active
			// context, everything older has been summarized away.
			kept.push(...window);
			window = null;
			break;
		}
		if (e.type === "message") window.push(i);
	}
	// window !== null here means a marker with no opening compact_started:
	// the buffered messages are discarded and the marker stays the barrier.

	kept.reverse();
	return kept;
}
