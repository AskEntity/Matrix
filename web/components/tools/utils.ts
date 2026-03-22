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
		case "error":
			return entry.message;
		case "message":
			return entry.body.content ?? "";
		case "lifecycle":
		case "parent_update":
		case "child_report":
		case "cross_project":
		case "generic_queue_message":
			return entry.content ?? "";
		case "background_complete":
			return `${entry.command} (exit ${entry.exitCode})`;
		case "task_started":
			return entry.title;
		case "task_completed":
			return entry.title;
		case "tree_mutation":
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

/** Get tool name from entry (only for tool_call/tool_result). */
export function getToolName(entry: LogEntry): string {
	if (entry.type === "tool_call" || entry.type === "tool_result") {
		return "tool" in entry ? (entry.tool as string) : "";
	}
	return "";
}

/** Get tool args from entry (only for tool_call). */
export function getToolArgs(
	entry: LogEntry,
): Record<string, unknown> | undefined {
	if (entry.type === "tool_call") {
		return entry.input;
	}
	return undefined;
}

/** Get a basename from a file path */
export function basename(path: string): string {
	const parts = path.split("/");
	return parts[parts.length - 1] ?? path;
}

/** Get a string arg from structured tool args */
export function getArg(
	args: Record<string, unknown> | undefined,
	key: string,
): string | null {
	if (!args) return null;
	const val = args[key];
	return val != null ? String(val) : null;
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
	if (toolName === "bash" && toolArgs?.bg_action) return BASH_BG_EXCLUDE;
	return undefined;
}

/** Format MCP tool results as human-readable summaries instead of raw JSON. */
export function formatMcpToolResult(
	toolName: string,
	content: string,
	t: (key: string, params?: Record<string, string>) => string,
): string | null {
	const mcpTool = toolName.replace("mcp__opengraft__", "");
	if (!toolName.startsWith("mcp__opengraft__")) return null;

	// Try to parse JSON content
	let json: Record<string, unknown> | null = null;
	try {
		json = JSON.parse(content) as Record<string, unknown>;
	} catch {
		// Not valid JSON — use text-based formatting below
	}

	switch (mcpTool) {
		case "create_task": {
			if (json && typeof json.title === "string") {
				return `${t("log.createdTask")} "${json.title}"`;
			}
			return null;
		}
		case "delete_task": {
			if (json && typeof json.title === "string") {
				return `${t("log.deletedTask")} "${json.title}"`;
			}
			return null;
		}
		case "execute_tasks": {
			// Legacy: execute_tasks was removed but old event history may reference it
			if (json && Array.isArray(json.tasks)) {
				const tasks = json.tasks as Array<{ title?: string }>;
				const names = tasks.map((tk) => tk.title ?? "?").join(", ");
				return `${t("log.executingTasks")} ${tasks.length} ${t("log.tasks")}: ${names}`;
			}
			return null;
		}
		case "done": {
			// done returns plain text like "Task marked as passed. Good work!"
			const match = /Task marked as (passed|failed)/.exec(content);
			if (match?.[1]) {
				return `${t("log.taskDone")} ${match[1] === "passed" ? "✓" : "✗"} ${match[1]}`;
			}
			return null;
		}
		case "get_tree": {
			if (json && Array.isArray(json.nodes)) {
				const count = json.nodes.length;
				return count === 0
					? t("log.treeEmpty")
					: t("log.treeCount", { count: String(count) });
			}
			return null;
		}
		case "update_task": {
			if (json && typeof json.status === "string") {
				const title = typeof json.title === "string" ? ` "${json.title}"` : "";
				return `${t("log.statusUpdate", { status: json.status as string })}${title}`;
			}
			return null;
		}
		case "send_message_to_child":
			return t("log.messageSent");
		case "report_to_parent":
			return t("log.reportSent");
		case "close_task": {
			if (json && typeof json.title === "string") {
				return `${t("log.closedTask")} "${json.title}"`;
			}
			return null;
		}
		case "reset_task": {
			if (json && typeof json.title === "string") {
				return `${t("log.resetTask")} "${json.title}"`;
			}
			return null;
		}
		case "reorder_tasks":
			return t("log.reorderedTasks");
		case "list_projects":
			return t("log.listedProjects");
		case "send_message_to_project":
			return t("log.messageSentToProject");
		case "clarify":
			return t("log.clarifyAsked");
		case "yield":
			return t("log.yieldReceived");
		default:
			return null;
	}
}

/** Generate a descriptive card title from tool name, args, and result */
export function getToolCardTitle(
	toolName: string,
	toolArgs: Record<string, unknown> | undefined,
	resultContent: string | null,
	nodeMap?: Map<string, { title?: string }>,
): string {
	// File tools
	if (toolName === "read_file") {
		const path = getArg(toolArgs, "path");
		return path ? `⌕ Read: ${basename(path)}` : "⌕ Read";
	}
	if (toolName === "write_file") {
		const path = getArg(toolArgs, "path");
		return path ? `← Write: ${basename(path)}` : "← Write";
	}
	if (toolName === "edit_file") {
		const path = getArg(toolArgs, "path");
		return path ? `✎ Edit: ${basename(path)}` : "✎ Edit";
	}
	if (toolName === "search") {
		const pattern = getArg(toolArgs, "pattern");
		if (pattern) {
			const display =
				pattern.length > 40 ? `${pattern.slice(0, 40)}…` : pattern;
			return `⌕ Search: ${display}`;
		}
		return "⌕ Search";
	}
	if (toolName === "list_files") {
		const pattern = getArg(toolArgs, "pattern");
		return pattern ? `ls: ${pattern}` : "ls";
	}
	if (toolName === "bash") {
		const bgAction = getArg(toolArgs, "bg_action");
		if (bgAction) {
			const bgId = getArg(toolArgs, "background_id") ?? "?";
			return `bg ${bgAction}: ${bgId}`;
		}
		const command = getArg(toolArgs, "command");
		if (command) {
			const display =
				command.length > 50 ? `${command.slice(0, 50)}…` : command;
			return `$ ${display}`;
		}
		return "$ bash";
	}

	// MCP tools
	const mcpTool = toolName.replace("mcp__opengraft__", "");
	if (toolName.startsWith("mcp__opengraft__")) {
		switch (mcpTool) {
			case "create_task": {
				const title = getArg(toolArgs, "title");
				return title ? `+ Task Created: ${title}` : "+ Task Created";
			}
			case "delete_task": {
				// Try to get title from result
				if (resultContent) {
					try {
						const json = JSON.parse(resultContent) as Record<string, unknown>;
						if (typeof json.title === "string")
							return `– Task Deleted: ${json.title}`;
					} catch {
						/* ignore */
					}
				}
				const taskId = getArg(toolArgs, "taskId");
				if (taskId) {
					const title = nodeMap?.get(taskId)?.title;
					return `– Task Deleted: ${title ?? taskId}`;
				}
				return "– Task Deleted";
			}
			case "execute_tasks": {
				// toolArgs.tasks may be an array (live) or a JSON string (event_history)
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
					// Try to get titles from result
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
						return `⚡ Run ${titles.length}: ${titles.join(", ")}`;
					}
					return `⚡ Run ${parsedTasks.length}`;
				}
				return "⚡ Run";
			}
			case "done": {
				const status = getArg(toolArgs, "status");
				const summary = getArg(toolArgs, "summary");
				const isPassed = status === "passed";
				const icon = isPassed ? "✓" : "✗";
				const label = isPassed ? "Task Passed" : "Task Failed";
				if (summary) {
					const display =
						summary.length > 60 ? `${summary.slice(0, 60)}…` : summary;
					return `${icon} ${label}: ${display}`;
				}
				return `${icon} ${label}`;
			}
			case "yield": {
				// If we have result content, yield has returned with messages
				if (resultContent) {
					return "▶ Resume from yield";
				}
				return "⏸ Yield";
			}
			case "get_tree":
				return "Tree";
			case "update_task": {
				let resolvedTitle = "";
				if (resultContent) {
					try {
						const json = JSON.parse(resultContent);
						if (typeof json.title === "string") {
							resolvedTitle =
								json.title.length > 40
									? `${json.title.slice(0, 40)}…`
									: json.title;
						}
					} catch {
						/* ignore */
					}
				}
				if (resolvedTitle) return `Task Updated: ${resolvedTitle}`;
				const taskId = getArg(toolArgs, "taskId");
				if (taskId) {
					const resolved = nodeMap?.get(taskId)?.title;
					return `Task Updated: ${resolved ?? taskId}`;
				}
				return "Task Updated";
			}
			case "send_message_to_child": {
				const taskId = getArg(toolArgs, "taskId");
				if (taskId) {
					const title = nodeMap?.get(taskId)?.title;
					return `→ Message Child: ${title ?? taskId}`;
				}
				return "→ Message Child";
			}
			case "close_task": {
				const taskId = getArg(toolArgs, "taskId");
				if (taskId) {
					const title = nodeMap?.get(taskId)?.title;
					return `– Task Closed: ${title ?? taskId}`;
				}
				return "– Task Closed";
			}
			case "reset_task": {
				const taskId = getArg(toolArgs, "taskId");
				if (taskId) {
					const title = nodeMap?.get(taskId)?.title;
					return `↺ Task Reset: ${title ?? taskId}`;
				}
				return "↺ Task Reset";
			}
			case "reorder_tasks":
				return "↕ Reorder tasks";
			case "list_projects":
				return "⌕ List projects";
			case "send_message_to_project": {
				const projectId = getArg(toolArgs, "projectId");
				return projectId ? `→ Cross-project: ${projectId}` : "→ Cross-project";
			}
			case "report_to_parent": {
				const title = getArg(toolArgs, "title");
				if (title) {
					const display = title.length > 60 ? `${title.slice(0, 60)}…` : title;
					return `← ${display}`;
				}
				return "← Report to Parent";
			}
			case "clarify": {
				const question = getArg(toolArgs, "question");
				if (question) {
					// Show first line as title (may be multi-line with title\nbody)
					const firstLine = question.split("\n")[0] ?? question;
					const display =
						firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
					return `? ${display}`;
				}
				return "? Clarify";
			}
		}
	}

	return toolName;
}

/** Determine if a tool card should be title-only (no expandable body) */
export function isTitleOnlyCard(
	toolName: string,
	toolArgs?: Record<string, unknown>,
): boolean {
	const mcpTool = toolName.replace("mcp__opengraft__", "");
	if (!toolName.startsWith("mcp__opengraft__")) return false;
	switch (mcpTool) {
		case "get_tree":
		case "yield":
		case "delete_task":
		case "update_task":
		case "close_task":
		case "reset_task":
		case "reorder_tasks":
		case "list_projects":
			return true;
		case "report_to_parent": {
			// Always expandable — title is in header, message is in body
			const msg = getArg(toolArgs, "message");
			return !msg;
		}
		default:
			return false;
	}
}
