/**
 * Factory functions for QueueMessage construction.
 *
 * Every QueueMessage requires `id: ulid()` and `ts: Date.now()`. These factories
 * enforce that invariant and eliminate boilerplate at construction sites.
 */
import type { QueueImage, QueueMessage } from "./message-queue.ts";
import { ulid } from "./ulid.ts";

/** Extract a specific variant from the QueueMessage union by source. */
type MessageOf<S extends QueueMessage["source"]> = Extract<
	QueueMessage,
	{ source: S }
>;

function stamp() {
	return { id: ulid(), ts: Date.now() };
}

// ── User messages ──

export function createUserMessage(
	content: string,
	opts?: { images?: QueueImage[]; id?: string; ts?: number },
): MessageOf<"user"> {
	return {
		source: "user",
		...stamp(),
		content,
		...(opts?.images?.length ? { images: opts.images } : {}),
		...(opts?.id ? { id: opts.id } : {}),
		...(opts?.ts != null ? { ts: opts.ts } : {}),
	};
}

// ── Task lifecycle ──

export function createTaskComplete(
	taskId: string,
	title: string,
	success: boolean,
	output: string,
): MessageOf<"task_complete"> {
	return {
		source: "task_complete",
		...stamp(),
		taskId,
		title,
		success,
		output,
	};
}

export function createTaskMessage(
	fromTaskId: string,
	fromTitle: string,
	content: string,
	opts?: { title?: string; requestReply?: boolean },
): MessageOf<"task_message"> {
	return {
		source: "task_message",
		...stamp(),
		fromTaskId,
		fromTitle,
		content,
		...(opts?.title ? { title: opts.title } : {}),
		...(opts?.requestReply != null ? { requestReply: opts.requestReply } : {}),
	};
}

// ── Tree change ──

export function createTreeChange(
	action: "created" | "updated" | "deleted" | "reordered",
	nodeId: string,
	title?: string,
): MessageOf<"tree_change"> {
	return {
		source: "tree_change",
		...stamp(),
		action,
		nodeId,
		...(title ? { title } : {}),
	};
}

// ── Clarify response ──

export function createClarifyResponse(
	answer: string,
): MessageOf<"clarify_response"> {
	return { source: "clarify_response", ...stamp(), answer };
}

// ── User message forwarded ──

export function createUserMessageForwarded(
	fromTaskId: string,
	fromTitle: string,
	content: string,
	opts?: { resumed?: boolean },
): MessageOf<"user_message_forwarded"> {
	return {
		source: "user_message_forwarded",
		...stamp(),
		fromTaskId,
		fromTitle,
		content,
		...(opts?.resumed ? { resumed: true } : {}),
	};
}

// ── Cross-project ──

export function createCrossProjectMessage(
	fromProjectId: string,
	fromProjectName: string,
	content: string,
): MessageOf<"cross_project"> {
	return {
		source: "cross_project",
		...stamp(),
		fromProjectId,
		fromProjectName,
		content,
	};
}

// ── Background complete ──

export function createBackgroundComplete(opts: {
	commandId: string;
	command: string;
	exitCode: number | null;
	durationMs: number;
	/** Formatted output — identical to foreground bash tool_result content. From formatBashResult(). */
	content: string;
}): MessageOf<"background_complete"> {
	return {
		source: "background_complete",
		...stamp(),
		commandId: opts.commandId,
		command: opts.command,
		exitCode: opts.exitCode,
		durationMs: opts.durationMs,
		content: opts.content,
	};
}

// ── Compact ──

export function createCompactMessage(): MessageOf<"compact"> {
	return { source: "compact", ...stamp() };
}

// ── Work context ──

export function createWorkContext(content: string): MessageOf<"work_context"> {
	return { source: "work_context", ...stamp(), content };
}

// ── Compacted resume (message form) ──

export function createCompactedResume(
	content: string,
): MessageOf<"compacted_resume"> {
	return { source: "compacted_resume", ...stamp(), content };
}
