import type { QueueMessage } from "./message-queue.ts";
import type { EventImageData, PendingState } from "./shared-types.ts";
import { ulid } from "./ulid.ts";

export type { EventImageData, PendingState } from "./shared-types.ts";

/**
 * Strongly-typed event — provider-agnostic, one event per action.
 * Each event represents a single atomic action (no batching).
 *
 * All injected content uses `type: "message"` with a `body` field.
 * `body.source` discriminates: "user", "tree_change", "child_complete", etc.
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

export type Event =
	| MessageEvent
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
			/** @deprecated Legacy field — prompt is now delivered via queue. Present in old JSONL only. */
			prompt?: string;
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
	const id = msg.source === "user" && msg.id ? msg.id : ulid();
	return { type: "message", id, taskId, body: msg, ts: Date.now() };
}

/**
 * Format a QueueMessage body for AI consumption based on source narrowing.
 * Used by formatEventForAI for message events.
 */
function formatBodyForAI(body: QueueMessage): string {
	switch (body.source) {
		case "child_complete":
			return `<task_complete task="${body.title}" id="${body.taskId}" status="${body.success ? "passed" : "failed"}">${body.output.slice(0, 500)}</task_complete>`;
		case "clarify_response":
			return `<clarify_response>${body.answer}</clarify_response>`;
		case "child_report":
			return `<task_message from="${body.title}" id="${body.taskId}"${body.summary ? ` summary="${body.summary}"` : ""}${body.requestReply ? ' requestReply="true"' : ""}>${body.content}</task_message>`;
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
		case "parent_update":
			if (body.header) {
				return `${body.header}\n\n<task_message${body.requestReply ? ' requestReply="true"' : ""}>${body.content}</task_message>`;
			}
			return `<task_message${body.requestReply ? ' requestReply="true"' : ""}>${body.content}</task_message>`;
		default:
			return "";
	}
}

/**
 * Format a concrete Event for inclusion in provider messages.
 * `message` events use body.source to determine formatting.
 */
export function formatEventForAI(event: Event): string {
	if (event.type === "message") {
		// Defensive: body should always be present but guard against corrupt data
		if (!event.body) return "";
		return formatBodyForAI(event.body);
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
