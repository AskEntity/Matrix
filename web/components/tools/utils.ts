// Display logic lives in web/event-display.ts.
// These React-specific wrappers add LogEntry handling on top.

export type { ToolTitleOptions } from "../../event-display.ts";
export {
	basename,
	formatToolArgs,
	getArg,
	getToolTitle,
	isTitleOnly,
	summarizeToolResult,
} from "../../event-display.ts";

import { TOOL_BASH } from "../../../src/tool-names.ts";

import type { LogEntry } from "../../hooks.ts";

/** Get the primary display text for any LogEntry type. */
export function getEntryText(entry: LogEntry): string {
	switch (entry.type) {
		case "assistant_text":
		case "text_delta":
			return entry.content.trimStart();
		case "tool_call":
			return entry.tool;
		case "tool_result":
			return entry.content;
		case "tool_pair":
			return entry.resultContent;
		case "error":
			return entry.message;
		case "message":
			return entry.body.source === "user" ? entry.body.content : "";
		case "lifecycle":
		case "task_message":
		case "cross_project":
		case "user_message_forwarded":
			return entry.content ?? "";
		case "background_complete":
			return `${entry.command} (exit ${entry.exitCode})`;
		case "task_started":
			return entry.title;
		case "task_completed":
			return entry.title;
		case "tree_change":
			return entry.title ?? entry.action;
		case "compact_marker":
			return `Context compacted (saved ~${entry.savedTokens} tokens)`;
		case "compact_started":
			return "Compacting context...";
		case "clarify_response":
			return entry.answer;
		case "clarification_requested":
			return entry.title ?? entry.question;
		case "clarification_answered":
			return entry.answer;
		case "budget_exceeded":
			return entry.title;
		default:
			return "";
	}
}

/** Get tool name from entry (for tool_call/tool_result/tool_pair). */
export function getToolName(entry: LogEntry): string {
	if (
		entry.type === "tool_call" ||
		entry.type === "tool_result" ||
		entry.type === "tool_pair"
	) {
		return "tool" in entry ? (entry.tool as string) : "";
	}
	return "";
}

/** Format tool args as a string for display */
export function formatArgs(
	input: Record<string, unknown> | undefined,
	excludeKeys?: Set<string>,
): string {
	if (!input) return "";
	const parts = Object.entries(input)
		.filter(([k]) => !excludeKeys?.has(k))
		.map(([k, v]) => {
			const val = typeof v === "string" ? v : JSON.stringify(v);
			return `${k}=${val}`;
		});
	return parts.join(", ");
}

/** Keys to exclude from displayed args for bash bg_action calls */
const BASH_BG_EXCLUDE = new Set(["command"]);

export function bashBgExcludeKeys(
	toolName: string,
	toolArgs: Record<string, unknown> | undefined,
): Set<string> | undefined {
	if (toolName === TOOL_BASH && toolArgs?.bg_action) return BASH_BG_EXCLUDE;
	return undefined;
}
