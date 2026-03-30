import type { QueueMessage } from "./message-queue.ts";
import type { EventImageData, PendingState } from "./shared-types.ts";
import { ulid } from "./ulid.ts";

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
	/** MCP-spec tool definitions (full JSON schema) as passed to provider. */
	tools: unknown[];
	/** SYSTEM_PROMPT pure text — shared by ALL agents, never changes. */
	systemStable: string;
	/** Role + date + selfBootstrap — per-agent, per-day. */
	systemVariable: string;
	taskId: string;
	ts: number;
}

export type Event =
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
	// Ephemeral events — broadcast over WS but not persisted to JSONL
	| { type: "text_delta"; content: string; taskId: string; ts: number }
	| {
			type: "usage";
			taskId: string;
			inputTokens: number;
			contextWindow: number;
			estimated?: boolean;
			ts: number;
	  }
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
		case "text_delta":
		case "usage":
		case "agent_idle":
		case "agent_active":
		case "status":
		case "clarification_timeout":
			return false;

		// Persisted — written to JSONL by emitEvent
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
			return `<task_complete from_task="${body.taskId}" task_name="${body.title}" status="${body.success ? "passed" : "failed"}">${body.output.slice(0, 500)}</task_complete>`;
		case "clarify_response":
			return `<clarify_response>${body.answer}</clarify_response>`;
		case "user_message_forwarded":
			return `<user_message_forwarded from_task="${body.fromTaskId}" task_name="${body.fromTitle}">${body.content}</user_message_forwarded>`;
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
 * Scan events for orphaned tool_call events (no matching tool_result).
 * Returns synthetic tool_result events that should be persisted to JSONL.
 * Call this BEFORE eventsToAnthropicMessages/eventsToOpenAIMessages on resume
 * to fix orphans once and persist the fix.
 */
export function findOrphanedToolCalls(
	events: Event[],
	taskId: string,
): Event[] {
	// Build sets of tool_call IDs and tool_result IDs
	const toolCallIds = new Map<string, string>(); // id → tool name
	const toolResultIds = new Set<string>();
	for (const e of events) {
		if (e.type === "tool_call") {
			toolCallIds.set(e.toolCallId, e.tool);
		} else if (e.type === "tool_result") {
			toolResultIds.add(e.toolCallId);
		}
	}
	// Find tool_calls without matching tool_results
	const orphans: Event[] = [];
	for (const [id, tool] of toolCallIds) {
		if (!toolResultIds.has(id)) {
			// Skip yield tool_calls — they're handled by the provider loop's
			// loop-level pause mechanism. The yield result is generated at resume time
			// when messages arrive, not as a synthetic orphan fix.
			if (tool === "mcp__opengraft__yield") {
				continue;
			}
			console.warn(
				`[findOrphanedToolCalls] Orphaned tool_call: ${id} (${tool})`,
			);
			orphans.push({
				type: "tool_result" as const,
				tool,
				toolCallId: id,
				content:
					"Tool execution was interrupted by daemon restart. Results were lost.",
				isError: true,
				taskId,
				ts: Date.now(),
			});
		}
	}
	return orphans;
}

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
	if (
		lastToolCall?.type === "tool_call" &&
		lastToolCall.tool === "mcp__opengraft__yield"
	) {
		const hasResult = events.some(
			(e) =>
				e.type === "tool_result" && e.toolCallId === lastToolCall.toolCallId,
		);
		return !hasResult;
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
			const msgId = ulid();
			const ts = Date.now();
			orphans.push({
				type: "message",
				id: msgId,
				taskId,
				body: {
					source: "background_complete",
					id: msgId,
					ts,
					commandId: bgId,
					command: info.command,
					exitCode: null,
					durationMs: 0,
					stdout: "",
					stderr: "Background process interrupted by daemon restart",
				},
				ts,
			});
		}
	}
	return orphans;
}
