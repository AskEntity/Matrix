/**
 * Event display layer — pure UI formatting logic.
 *
 * Converts Event types to structured display data — plain objects with strings,
 * not HTML/React/Telegram-specific markup. Any UI can consume these structs
 * to render events in its own way.
 *
 * Start with the most common event types: tool_call, tool_result, message, assistant_text.
 */
import type { Event } from "../src/events.ts";
import type { QueueMessage } from "../src/message-queue.ts";
import {
	isBuiltinTool,
	stripMcpPrefix,
	TOOL_BACKGROUND,
	TOOL_BASH,
	TOOL_CLARIFY,
	TOOL_CLOSE_TASK,
	TOOL_CREATE_FOLDER,
	TOOL_CREATE_TASK,
	TOOL_DELETE_FOLDER,
	TOOL_DELETE_TASK,
	TOOL_DONE,
	TOOL_EDIT_FILE,
	TOOL_EVALUATE_SCRIPT,
	TOOL_EXECUTE_TASKS,
	TOOL_FORK_TASK_CONTEXT,
	TOOL_GET_TASK,
	TOOL_GET_TREE,
	TOOL_LIST_FILES,
	TOOL_LIST_PROJECTS,
	TOOL_READ_FILE,
	TOOL_RENAME_FOLDER,
	TOOL_REORDER_TASKS,
	TOOL_REPORT_TO_PARENT,
	TOOL_RESET_TASK,
	TOOL_SEARCH,
	TOOL_SEND_MESSAGE,
	TOOL_SEND_MESSAGE_TO_CHILD,
	TOOL_SEND_MESSAGE_TO_PROJECT,
	TOOL_UPDATE_TASK,
	TOOL_WRITE_FILE,
	TOOL_YIELD,
} from "../src/tool-names.ts";

// ── Display data types ──

/** Structured display for a tool call (no result yet or standalone). */
export interface ToolCallDisplay {
	kind: "tool_call";
	/** Human-readable title (e.g. "$ echo hello", "⌕ Read: foo.ts"). */
	title: string;
	/** Short tool name without namespace (e.g. "bash", "read_file"). */
	shortName: string;
	/** Whether this is a builtin tool. */
	isBuiltin: boolean;
	/** Whether the card body should be collapsed by default. */
	titleOnly: boolean;
	/** Formatted arguments string (key=value pairs). */
	argsText: string;
	/** For done() tool: "passed" | "failed" | null. */
	doneStatus: "passed" | "failed" | null;
}

/** Structured display for a tool result. */
export interface ToolResultDisplay {
	kind: "tool_result";
	title: string;
	shortName: string;
	isBuiltin: boolean;
	titleOnly: boolean;
	isError: boolean;
	/** Human-readable summary (e.g. "Created task 'Fix bug'"). Null = show raw content. */
	summary: string | null;
	/** Raw result content. */
	content: string;
}

/** Structured display for a message event (user, task_complete, etc.). */
export interface MessageDisplay {
	kind: "message";
	source: QueueMessage["source"];
	/** Primary text content. */
	text: string;
	/** Optional sender label (e.g. "User", task title). */
	sender: string | null;
	/** Whether this is an error/failure. */
	isError: boolean;
}

/** Structured display for assistant text. */
export interface AssistantTextDisplay {
	kind: "assistant_text";
	text: string;
}

export type EventDisplay =
	| ToolCallDisplay
	| ToolResultDisplay
	| MessageDisplay
	| AssistantTextDisplay
	| { kind: "unknown"; type: string };

// ── Core formatting functions ──

/** Get a basename from a file path. */
export function basename(path: string): string {
	const parts = path.split("/");
	return parts[parts.length - 1] ?? path;
}

/** Extract a string arg from tool input. Returns undefined if not a string. */
export function getArg(
	args: Record<string, unknown> | undefined,
	key: string,
): string | undefined {
	const val = args?.[key];
	return typeof val === "string" ? val : undefined;
}

/** Format tool args as key=value string. */
export function formatToolArgs(
	input: Record<string, unknown> | undefined,
	excludeKeys?: Set<string>,
): string {
	if (!input) return "";
	return Object.entries(input)
		.filter(([k]) => !excludeKeys?.has(k))
		.map(([k, v]) => {
			const val = typeof v === "string" ? v : JSON.stringify(v);
			return `${k}=${val}`;
		})
		.join(", ");
}

// ── Title generation (extracted from web/components/tools/utils.ts) ──

export interface ToolTitleOptions {
	/** Map of project IDs to names, for resolving cross-project references. */
	projectMap?: Map<string, string>;
}

/**
 * Generate a human-readable title for a tool call.
 * Platform-agnostic — returns plain text, no markup.
 * No truncation — display overflow handled by CSS in the rendering layer.
 */
export function getToolTitle(
	toolName: string,
	toolArgs: Record<string, unknown> | undefined,
	resultContent?: string | null,
	nodeMap?: Map<string, { title?: string }>,
	opts?: ToolTitleOptions,
): string {
	switch (toolName) {
		case TOOL_READ_FILE: {
			const path = getArg(toolArgs, "path");
			return path ? `Read: ${basename(path)}` : "Read";
		}
		case TOOL_WRITE_FILE: {
			const path = getArg(toolArgs, "path");
			return path ? `Write: ${basename(path)}` : "Write";
		}
		case TOOL_EDIT_FILE: {
			const path = getArg(toolArgs, "path");
			return path ? `Edit: ${basename(path)}` : "Edit";
		}
		case TOOL_SEARCH: {
			const pattern = getArg(toolArgs, "pattern");
			return pattern ? `Search: ${pattern}` : "Search";
		}
		case TOOL_LIST_FILES: {
			const pattern = getArg(toolArgs, "pattern");
			return pattern ? `List: ${pattern}` : "List";
		}
		case TOOL_BASH: {
			const bgAction = getArg(toolArgs, "bg_action");
			if (bgAction) {
				const bgId = getArg(toolArgs, "background_id") ?? "?";
				return `Background: ${bgAction} ${bgId}`;
			}
			const command = getArg(toolArgs, "command");
			return command ? `Shell: ${command}` : "Shell";
		}
		case TOOL_BACKGROUND: {
			const action = getArg(toolArgs, "action");
			const bgId = getArg(toolArgs, "id") ?? "";
			if (action) {
				return bgId ? `Background: ${action} ${bgId}` : `Background: ${action}`;
			}
			return "Background";
		}
		case TOOL_CREATE_TASK: {
			const title = getArg(toolArgs, "title");
			return title ? `Task Created: ${title}` : "Task Created";
		}
		case TOOL_DELETE_TASK: {
			if (resultContent) {
				try {
					const json = JSON.parse(resultContent) as Record<string, unknown>;
					if (typeof json.title === "string")
						return `Task Deleted: ${json.title}`;
				} catch {
					/* ignore */
				}
			}
			const taskId = getArg(toolArgs, "taskId");
			if (taskId) {
				const title = nodeMap?.get(taskId)?.title;
				return `Task Deleted: ${title ?? taskId}`;
			}
			return "Task Deleted";
		}
		case TOOL_EXECUTE_TASKS: {
			let parsedTasks: Array<{ taskId?: string; title?: string }> = [];
			const tasksVal = toolArgs?.tasks;
			if (Array.isArray(tasksVal)) {
				parsedTasks = tasksVal as typeof parsedTasks;
			} else {
				const tasksArg = getArg(toolArgs, "tasks");
				if (tasksArg) {
					try {
						parsedTasks = JSON.parse(tasksArg) as typeof parsedTasks;
					} catch {
						/* ignore */
					}
				}
			}
			if (parsedTasks.length > 0) {
				let titles: string[] = [];
				if (resultContent) {
					try {
						const json = JSON.parse(resultContent) as {
							tasks?: Array<{ title?: string }>;
						};
						if (Array.isArray(json.tasks)) {
							titles = json.tasks.map((t) => t.title ?? "?").filter(Boolean);
						}
					} catch {
						/* ignore */
					}
				}
				if (titles.length > 0) {
					return `Run ${titles.length}: ${titles.join(", ")}`;
				}
				return `Run ${parsedTasks.length}`;
			}
			return "Run";
		}
		case TOOL_DONE: {
			const status = getArg(toolArgs, "status");
			const summary = getArg(toolArgs, "summary");
			const isPassed = status === "passed";
			const label = isPassed ? "Task Passed" : "Task Failed";
			return summary ? `${label}: ${summary}` : label;
		}
		case TOOL_YIELD: {
			if (resultContent) return "Resume from yield";
			return "Yield";
		}
		case TOOL_GET_TREE: {
			const parts: string[] = [];
			if (toolArgs?.format === "tree") parts.push("tree");
			if (toolArgs?.include_details) parts.push("detailed");
			if (toolArgs?.include_closed) parts.push("with closed");
			return parts.length > 0 ? `Task Tree (${parts.join(", ")})` : "Task Tree";
		}
		case TOOL_GET_TASK: {
			const taskId = getArg(toolArgs, "taskId");
			if (taskId) {
				const title = nodeMap?.get(taskId)?.title;
				return `Task Detail: ${title ?? taskId}`;
			}
			return "Task Detail";
		}
		case TOOL_UPDATE_TASK: {
			const changedFields: string[] = [];
			if (toolArgs) {
				if (toolArgs.status) changedFields.push(`status→${toolArgs.status}`);
				if (toolArgs.title) changedFields.push("title");
				if (toolArgs.description || toolArgs.old_description)
					changedFields.push("description");
				if (toolArgs.parentId) changedFields.push("parent");
				if (toolArgs.color) changedFields.push("color");
				if (toolArgs.draft !== undefined) changedFields.push("draft");
			}
			let resolvedTitle = "";
			if (resultContent) {
				try {
					const json = JSON.parse(resultContent);
					if (typeof json.title === "string") {
						resolvedTitle = json.title;
					}
				} catch {
					/* ignore */
				}
			}
			if (!resolvedTitle) {
				const taskId = getArg(toolArgs, "taskId");
				if (taskId) {
					resolvedTitle = nodeMap?.get(taskId)?.title ?? taskId;
				}
			}
			const suffix =
				changedFields.length > 0 ? ` (${changedFields.join(", ")})` : "";
			return resolvedTitle
				? `Task Updated: ${resolvedTitle}${suffix}`
				: `Task Updated${suffix}`;
		}
		case TOOL_SEND_MESSAGE:
		case TOOL_SEND_MESSAGE_TO_CHILD: {
			const taskId = getArg(toolArgs, "taskId");
			if (taskId) {
				const title = nodeMap?.get(taskId)?.title;
				return `Message: ${title ?? taskId}`;
			}
			return "Message";
		}
		case TOOL_CLOSE_TASK: {
			const taskId = getArg(toolArgs, "taskId");
			if (taskId) {
				const title = nodeMap?.get(taskId)?.title;
				return `Task Closed: ${title ?? taskId}`;
			}
			return "Task Closed";
		}
		case TOOL_RESET_TASK: {
			const taskId = getArg(toolArgs, "taskId");
			if (taskId) {
				const title = nodeMap?.get(taskId)?.title;
				return `Task Reset: ${title ?? taskId}`;
			}
			return "Task Reset";
		}
		case TOOL_REORDER_TASKS:
			return "Task Reorder";
		case TOOL_LIST_PROJECTS:
			return "List Projects";
		case TOOL_SEND_MESSAGE_TO_PROJECT: {
			const targetProjectId = getArg(toolArgs, "targetProjectId");
			if (targetProjectId) {
				const projectName =
					opts?.projectMap?.get(targetProjectId) ?? targetProjectId;
				return `Cross-project → ${projectName}`;
			}
			return "Cross-project";
		}
		case TOOL_REPORT_TO_PARENT: {
			const title = getArg(toolArgs, "title");
			return title ?? "Report";
		}
		case TOOL_CLARIFY: {
			const question = getArg(toolArgs, "question");
			if (question) {
				const firstLine = question.split("\n")[0] ?? question;
				return `Clarify: ${firstLine}`;
			}
			return "Clarify";
		}
		case TOOL_FORK_TASK_CONTEXT: {
			const sourceId = getArg(toolArgs, "sourceTaskId");
			const targetId = getArg(toolArgs, "targetTaskId");
			if (sourceId && targetId) {
				const sourceTitle = nodeMap?.get(sourceId)?.title ?? sourceId;
				const targetTitle = nodeMap?.get(targetId)?.title ?? targetId;
				return `Fork: ${sourceTitle} → ${targetTitle}`;
			}
			return "Fork";
		}
		case TOOL_EVALUATE_SCRIPT:
			return "Evaluate";
		case TOOL_CREATE_FOLDER: {
			const title = getArg(toolArgs, "title");
			return title ? `Folder Created: ${title}` : "Folder Created";
		}
		case TOOL_DELETE_FOLDER:
			return "Folder Deleted";
		case TOOL_RENAME_FOLDER: {
			const title = getArg(toolArgs, "title");
			return title ? `Folder Renamed: ${title}` : "Folder Renamed";
		}
		default:
			return stripMcpPrefix(toolName);
	}
}

/** Determine if a tool card should show title only (no expandable body). */
export function isTitleOnly(
	toolName: string,
	toolArgs?: Record<string, unknown>,
): boolean {
	switch (toolName) {
		case TOOL_GET_TREE:
		case TOOL_GET_TASK:
		case TOOL_YIELD:
		case TOOL_DELETE_TASK:
		case TOOL_CLOSE_TASK:
		case TOOL_RESET_TASK:
		case TOOL_REORDER_TASKS:
		case TOOL_LIST_PROJECTS:
		case TOOL_FORK_TASK_CONTEXT:
			return true;
		case TOOL_UPDATE_TASK: {
			const oldDesc = getArg(toolArgs, "old_description");
			const newDesc = getArg(toolArgs, "new_description");
			return !(oldDesc != null && newDesc != null);
		}
		case TOOL_REPORT_TO_PARENT: {
			const msg = getArg(toolArgs, "message");
			return !msg;
		}
		default:
			return false;
	}
}

/** Generate a human-readable summary for an MCP tool result. Returns null if no summary available. */
export function summarizeToolResult(
	toolName: string,
	content: string,
): string | null {
	const baseName = stripMcpPrefix(toolName);
	if (!isBuiltinTool(toolName)) return null;

	let json: Record<string, unknown> | null = null;
	try {
		json = JSON.parse(content) as Record<string, unknown>;
	} catch {
		// Not JSON
	}

	switch (baseName) {
		case "create_task":
			if (json && typeof json.title === "string")
				return `Created task "${json.title}"`;
			return null;
		case "delete_task":
			if (json && typeof json.title === "string")
				return `Deleted task "${json.title}"`;
			return null;
		case "close_task":
			if (json && typeof json.title === "string")
				return `Closed task "${json.title}"`;
			return null;
		case "reset_task":
			if (json && typeof json.title === "string")
				return `Reset task "${json.title}"`;
			return null;
		case "get_tree": {
			if (json && Array.isArray(json.nodes)) {
				const count = json.nodes.length;
				return count === 0 ? "Empty tree" : `${count} tasks`;
			}
			return null;
		}
		case "get_task": {
			if (json && typeof json.title === "string")
				return `Task: "${json.title}"`;
			return null;
		}
		case "update_task": {
			if (json && typeof json.status === "string") {
				const title = typeof json.title === "string" ? ` "${json.title}"` : "";
				return `Status → ${json.status}${title}`;
			}
			return null;
		}
		case "reorder_tasks":
			return "Reordered tasks";
		case "list_projects":
			return "Listed projects";
		case "send_message_to_project":
			return "Message sent to project";
		case "clarify":
			return "Question sent";
		case "yield":
			return "Received messages";
		case "fork_task_context":
			return content.startsWith("Error") ? null : "Context forked";
		default:
			return null;
	}
}

// ── Event → Display conversion ──

/**
 * Convert an Event to a structured EventDisplay.
 * Platform-agnostic — all display logic in one place.
 */
export function eventToDisplay(
	event: Event,
	nodeMap?: Map<string, { title?: string }>,
): EventDisplay | null {
	switch (event.type) {
		case "assistant_text":
			return { kind: "assistant_text", text: event.content.trimStart() };

		case "tool_call":
			return {
				kind: "tool_call",
				title: getToolTitle(event.tool, event.input, null, nodeMap),
				shortName: stripMcpPrefix(event.tool),
				isBuiltin: isBuiltinTool(event.tool),
				titleOnly: isTitleOnly(event.tool, event.input),
				argsText: formatToolArgs(event.input),
				doneStatus:
					event.tool === TOOL_DONE
						? (event.input?.status as string) === "passed"
							? "passed"
							: "failed"
						: null,
			};

		case "tool_result":
			return {
				kind: "tool_result",
				title: getToolTitle(event.tool, undefined, event.content, nodeMap),
				shortName: stripMcpPrefix(event.tool),
				isBuiltin: isBuiltinTool(event.tool),
				titleOnly: isTitleOnly(event.tool),
				isError: event.isError,
				summary: event.isError
					? null
					: summarizeToolResult(event.tool, event.content),
				content: event.content,
			};

		case "message":
			return messageToDisplay(event.body);

		default:
			return { kind: "unknown", type: event.type };
	}
}

/** Convert a QueueMessage body to a MessageDisplay. */
function messageToDisplay(body: QueueMessage): MessageDisplay {
	switch (body.source) {
		case "user":
			return {
				kind: "message",
				source: "user",
				text: body.content,
				sender: "User",
				isError: false,
			};
		case "task_complete":
			return {
				kind: "message",
				source: "task_complete",
				text: `${body.success ? "Passed" : "Failed"}: ${body.output}`,
				sender: body.title,
				isError: !body.success,
			};
		case "task_message":
			return {
				kind: "message",
				source: "task_message",
				text: body.content,
				sender: body.fromTitle,
				isError: false,
			};
		case "clarify_response":
			return {
				kind: "message",
				source: "clarify_response",
				text: body.answer,
				sender: "User",
				isError: false,
			};
		case "user_message_forwarded":
			return {
				kind: "message",
				source: "user_message_forwarded",
				text: body.content,
				sender: body.fromTitle,
				isError: false,
			};
		case "cross_project":
			return {
				kind: "message",
				source: "cross_project",
				text: body.content,
				sender: body.fromProjectName,
				isError: false,
			};
		case "background_complete":
			return {
				kind: "message",
				source: "background_complete",
				text: `${body.command} (exit ${body.exitCode})`,
				sender: null,
				isError: body.exitCode !== 0,
			};
		case "tree_change":
			return {
				kind: "message",
				source: "tree_change",
				text: `${body.action}: ${body.title ?? body.nodeId}`,
				sender: null,
				isError: false,
			};
		case "compact":
			return {
				kind: "message",
				source: "compact",
				text: "Compaction requested",
				sender: null,
				isError: false,
			};
	}
}
