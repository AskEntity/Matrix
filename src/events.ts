import type { QueueMessage } from "./message-queue.ts";
import { ulid } from "./ulid.ts";

/**
 * Strongly-typed event — provider-agnostic, one event per action.
 * Each event represents a single atomic action (no batching).
 *
 * All injected content uses `type: "message"` with a `body` field.
 * `body.source` discriminates: "user", "system", "child_complete", etc.
 */
/**
 * MessageBody — structured body of a message event.
 * The `source` field discriminates the shape. Format for AI happens at conversion time.
 */
export interface MessageBody {
	source: string;
	content?: string;
	taskId?: string;
	title?: string;
	summary?: string;
	success?: boolean;
	output?: string;
	requestReply?: boolean;
	answer?: string;
	fromProjectId?: string;
	fromProjectName?: string;
	command?: string;
	commandId?: string;
	exitCode?: number | null;
	durationMs?: number;
	images?: Array<{ base64: string; mediaType: string }>;
	/** Context header prepended to AI message (working dir, pre-loaded memory, task description). Not shown in UI. */
	header?: string;
}

/**
 * MessageEvent — unified format for ALL messages that flow through the system.
 * Uses `body.source` to indicate the message type. Written to JSONL with `id` for tracking.
 *
 * **New format (unified)**: `id` and `body` are always present. All data lives in `body`.
 * **Old format (legacy JSONL)**: may have top-level `source`, `content`, `images`, `cwd`, `isResume`.
 * Old fields are kept optional for backward compatibility — readers normalize via `normalizeMessageEvent()`.
 */
export interface MessageEvent {
	type: "message";
	/** ULID — identifies this message for two-phase lifecycle. Required in new format. */
	id?: string;
	/** @deprecated Use body.source instead. Kept for backward compat with old JSONL. */
	source?: string;
	/** @deprecated Use body.content instead. Kept for backward compat with old JSONL. */
	content?: string;
	/** @deprecated No longer used. Kept for backward compat with old JSONL. */
	cwd?: string;
	/** @deprecated No longer used. Kept for backward compat with old JSONL. */
	isResume?: boolean;
	/** @deprecated Use body.images instead. Kept for backward compat with old JSONL. */
	images?: Array<{ base64: string; mediaType: string }>;
	/** Task/session ID — used for JSONL routing and SSE broadcast targeting. */
	taskId?: string;
	/**
	 * Structured message body — contains ALL message data.
	 * Required in new unified format. Optional for backward compat with old JSONL.
	 */
	body?: MessageBody;
	ts: number;
}

/** @deprecated Use MessageEvent instead */
export type UserMessageEvent = MessageEvent;
/** @deprecated Use MessageBody instead */
export type QueueEntry = MessageBody;

export type Event =
	| MessageEvent
	| { type: "assistant_text"; content: string; taskId?: string; ts: number }
	| {
			type: "tool_call";
			tool: string;
			toolCallId: string;
			input: Record<string, unknown>;
			taskId?: string;
			ts: number;
	  }
	| {
			type: "tool_result";
			tool?: string;
			toolCallId: string;
			content: string;
			isError: boolean;
			images?: Array<{ base64: string; mediaType: string }>;
			/** Structured pending state (running children + clarifications). */
			pending?: {
				runningChildren: Array<{ id: string; title: string }>;
				pendingClarifications: number;
			};

			taskId?: string;
			ts: number;
	  }
	// Ephemeral events — broadcast over WS but not persisted to JSONL
	| { type: "text_delta"; content: string; taskId?: string; ts: number }
	| {
			type: "usage";
			taskId?: string;
			inputTokens: number;
			contextWindow: number;
			estimated?: boolean;
			ts: number;
	  }
	| { type: "agent_idle"; taskId: string; ts: number }
	| { type: "agent_active"; taskId: string; ts: number }
	| { type: "status"; message: string; taskId?: string; ts: number }
	| {
			type: "queue_message";
			messages: string;
			rawMessages?: Array<{
				source: string;
				content: string;
				id?: string;
				images?: { base64: string; mediaType: string }[];
			}>;
			taskId?: string;
			ts: number;
	  }
	| {
			type: "clarification_timeout";
			taskId?: string;
			timeoutMs: number;
			ts: number;
	  }
	// Legacy queue-originated event types — kept for backward compat with old JSONL.
	// New code produces `message` events with `body.source` instead.
	// normalizeLegacyEvent() converts these to `message` on read.
	| {
			type: "child_complete";
			id?: string;
			taskId: string;
			title: string;
			success: boolean;
			output: string;
			ts: number;
	  }
	| {
			type: "parent_update";
			id?: string;
			content: string;
			requestReply?: boolean;
			ts: number;
	  }
	| { type: "clarify_response"; id?: string; answer: string; ts: number }
	| {
			type: "child_report";
			id?: string;
			taskId: string;
			title: string;
			summary?: string;
			content: string;
			requestReply?: boolean;
			ts: number;
	  }
	| {
			type: "cross_project";
			id?: string;
			fromProjectId: string;
			fromProjectName: string;
			content: string;
			ts: number;
	  }
	| {
			type: "background_complete";
			id?: string;
			command: string;
			commandId: string;
			exitCode: number | null;
			durationMs: number;
			ts: number;
	  }
	| { type: "system_notification"; id?: string; content: string; ts: number }
	| { type: "compact_request"; id?: string; ts: number }
	// Legacy user_message — old JSONL may have this type. Normalized to "message" on read.
	| {
			type: "user_message";
			id?: string;
			source?: string;
			content?: string;
			cwd?: string;
			isResume?: boolean;
			images?: Array<{ base64: string; mediaType: string }>;
			queueEntry?: MessageBody;
			body?: MessageBody;
			ts: number;
	  }
	| { type: "compacted_resume"; content: string; cwd?: string; ts: number }
	| { type: "summarization_request"; instruction: string; ts: number }
	| { type: "budget_warning"; warning: string; ts: number }
	| {
			type: "compact_marker";
			checkpoint: string;
			savedTokens: number;
			taskId?: string;
			ts: number;
	  }
	// Lifecycle events — persisted to JSONL for activity log replay
	| {
			type: "orchestration_started";
			taskId: string;
			resume: boolean;
			prompt?: string;
			model?: string;
			provider?: string;
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
	| {
			type: "task_completed";
			taskId: string;
			title: string;
			success: boolean;
			output?: string;
			error?: string;
			ts: number;
	  }
	| { type: "error"; taskId?: string; message: string; ts: number }
	| {
			type: "budget_exceeded";
			taskId: string;
			title: string;
			costUsd?: number;
			budgetUsd?: number;
			ts: number;
	  }
	| {
			type: "clarification_requested";
			taskId: string;
			question: string;
			/** Short title extracted from question (first line). */
			title?: string;
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
	| {
			type: "tree_mutation";
			action: string;
			nodeId: string;
			title?: string;
			ts: number;
	  }
	| { type: "compact_started"; taskId: string; ts: number }
	| { type: "agent_stopped"; taskId?: string; ts: number }
	| {
			type: "messages_consumed";
			messageIds: string[];
			taskId?: string;
			ts: number;
	  };

/** Legacy event types that originate from the message queue (for backward compat). */
const LEGACY_QUEUE_EVENT_TYPES = new Set([
	"child_complete",
	"parent_update",
	"clarify_response",
	"child_report",
	"cross_project",
	"background_complete",
	"system_notification",
	"compact_request",
]);

/**
 * Check if an event originated from the message queue.
 * A `message` event is a queue event if `body.source` is present and not "user".
 * Legacy standalone types (child_complete, parent_update, etc.) are also detected.
 * Legacy `user_message` events with source/queueEntry are also detected.
 */
export function isQueueEvent(event: Event): boolean {
	if (LEGACY_QUEUE_EVENT_TYPES.has(event.type)) return true;
	if (event.type === "message") {
		const body = normalizeMessageEvent(event as MessageEvent);
		return body.source !== undefined && body.source !== "user";
	}
	// Legacy: user_message with source or queueEntry field
	if (event.type === "user_message") {
		const src =
			(event as { source?: string }).source ??
			(event as { queueEntry?: { source?: string } }).queueEntry?.source ??
			(event as { body?: { source?: string } }).body?.source;
		return src !== undefined && src !== "user";
	}
	return false;
}

/** Convert a QueueMessage to a unified `message` Event with body. */
export function queueMessageToEvent(msg: QueueMessage): MessageEvent {
	const ts = Date.now();
	const id = msg.source === "user" && msg.id ? msg.id : ulid();
	// Build body directly from the QueueMessage — source discriminates the shape
	const body: MessageBody = (() => {
		switch (msg.source) {
			case "user":
				return {
					source: "user",
					content: msg.content,
					...(msg.images?.length
						? {
								images: msg.images.map((img) => ({
									base64: img.base64,
									mediaType: img.mediaType,
								})),
							}
						: {}),
					...(msg.header ? { header: msg.header } : {}),
				};
			case "child_complete":
				return {
					source: "child_complete",
					taskId: msg.taskId,
					title: msg.title,
					success: msg.success,
					output: msg.output,
				};
			case "parent_update":
				return {
					source: "parent_update",
					content: msg.content,
					...(msg.requestReply ? { requestReply: true } : {}),
					...(msg.header ? { header: msg.header } : {}),
				};
			case "clarify_response":
				return { source: "clarify_response", answer: msg.answer };
			case "child_report":
				return {
					source: "child_report",
					taskId: msg.taskId,
					title: msg.title,
					...(msg.summary ? { summary: msg.summary } : {}),
					content: msg.content,
					...(msg.requestReply ? { requestReply: true } : {}),
				};
			case "cross_project":
				return {
					source: "cross_project",
					fromProjectId: msg.fromProjectId,
					fromProjectName: msg.fromProjectName,
					content: msg.content,
				};
			case "background_complete":
				return {
					source: "background_complete",
					command: msg.command,
					commandId: msg.commandId,
					exitCode: msg.exitCode,
					durationMs: msg.durationMs,
				};
			case "system":
				return { source: "system", content: msg.content };
			case "compact":
				return { source: "compact" };
		}
	})();
	return { type: "message", id, taskId: undefined, body, ts };
}

/**
 * Normalize a message event from JSONL — handles both old and new formats.
 * Old format: top-level source/content/images/cwd, no body or optional body.
 * New format: all data in body, no top-level fields.
 * Returns the body (synthesized from top-level fields if missing).
 */
export function normalizeMessageEvent(event: MessageEvent): MessageBody {
	if (event.body) return event.body;
	// Old format: synthesize body from top-level fields
	const source = event.source ?? "user";
	return {
		source,
		content: event.content,
		...(event.images?.length ? { images: event.images } : {}),
	};
}

/**
 * Format a MessageBody for AI consumption based on source.
 * Used by formatEventForAI for message events.
 */
function formatBodyForAI(body: MessageBody): string {
	switch (body.source) {
		case "child_complete":
			return `<child_complete task="${body.title}" id="${body.taskId}" status="${body.success ? "passed" : "failed"}">${(body.output ?? "").slice(0, 500)}</child_complete>`;
		case "clarify_response":
			return `<clarify_response>${body.answer}</clarify_response>`;
		case "child_report":
			return `<child_report from="${body.title}" id="${body.taskId}"${body.summary ? ` summary="${body.summary}"` : ""}${body.requestReply ? ' requestReply="true"' : ""}>${body.content}</child_report>`;
		case "cross_project":
			return `<cross_project from="${body.fromProjectName}" projectId="${body.fromProjectId}">${body.content}</cross_project>`;
		case "background_complete":
			return `<background_complete command="${body.command}" id="${body.commandId}" exit="${body.exitCode}" duration="${body.durationMs}ms">Command completed. Use bg_action="status" with background_id="${body.commandId}" or read_file on output files to see results.</background_complete>`;
		case "system":
			return `<system_notification>${body.content}</system_notification>`;
		case "compact":
			return "Manual compaction requested";
		case "user":
			if (body.header) {
				return `${body.header}\n\n${body.content ?? ""}`;
			}
			return body.content ?? "";
		case "parent_update":
			if (body.header) {
				return `${body.header}\n\n<parent_update${body.requestReply ? ' requestReply="true"' : ""}>${body.content}</parent_update>`;
			}
			return `<parent_update${body.requestReply ? ' requestReply="true"' : ""}>${body.content}</parent_update>`;
		default:
			return "";
	}
}

/**
 * Format a concrete Event for inclusion in provider messages.
 * `message` events use body.source to determine formatting.
 * Legacy standalone types (child_complete, etc.) are also supported for backward compat.
 */
export function formatEventForAI(event: Event): string {
	switch (event.type) {
		case "message": {
			const body = normalizeMessageEvent(event as MessageEvent);
			return formatBodyForAI(body);
		}
		// Legacy: user_message (old JSONL)
		case "user_message": {
			const src = (event as { source?: string }).source;
			if (!src || src === "user") {
				return (event as { content: string }).content;
			}
			const body =
				(event as { body?: MessageBody }).body ??
				(event as { queueEntry?: MessageBody }).queueEntry;
			if (!body) return "";
			return formatBodyForAI(body);
		}
		// Legacy standalone queue event types (old JSONL)
		case "clarify_response":
			return `<clarify_response>${event.answer}</clarify_response>`;
		case "system_notification":
			return `<system_notification>${event.content}</system_notification>`;
		case "compact_request":
			return "Manual compaction requested";
		case "child_complete":
			return `<child_complete task="${event.title}" id="${event.taskId}" status="${event.success ? "passed" : "failed"}">${event.output.slice(0, 500)}</child_complete>`;
		case "parent_update":
			return `<parent_update${event.requestReply ? ' requestReply="true"' : ""}>${event.content}</parent_update>`;
		case "child_report":
			return `<child_report from="${event.title}" id="${event.taskId}"${event.summary ? ` summary="${event.summary}"` : ""}${event.requestReply ? ' requestReply="true"' : ""}>${event.content}</child_report>`;
		case "cross_project":
			return `<cross_project from="${event.fromProjectName}" projectId="${event.fromProjectId}">${event.content}</cross_project>`;
		case "background_complete":
			return `<background_complete command="${event.command}" id="${event.commandId}" exit="${event.exitCode}" duration="${event.durationMs}ms">Command completed. Use bg_action="status" with background_id="${event.commandId}" or read_file on output files to see results.</background_complete>`;
		default:
			return "";
	}
}

/**
 * Format a structured pending section into text for AI consumption.
 * Converts the structured `pending` field on tool_result into the `## Pending` text format.
 */
export function formatPendingSection(pending: {
	runningChildren: Array<{ id: string; title: string }>;
	pendingClarifications: number;
}): string {
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
		`- Running children: ${runningChildrenText}`,
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
export function findOrphanedToolCalls(events: Event[]): Event[] {
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
				toolCallId: id,
				content:
					"Tool execution was interrupted by daemon restart. Results were lost.",
				isError: true,
				ts: Date.now(),
			});
		}
	}
	return orphans;
}
