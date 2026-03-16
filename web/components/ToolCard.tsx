import { useState } from "react";
import type { LogEntry, TaskNode } from "../hooks.ts";
import { useLocale } from "../i18n.ts";
import { IconChevron } from "./icons.tsx";

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
				return `${t("log.deletedTask")} – Task: "${json.title}"`;
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
				return `${t("log.closedTask")} – Task: "${json.title}"`;
			}
			return null;
		}
		case "reset_task": {
			if (json && typeof json.title === "string") {
				return `${t("log.resetTask")} – Task: "${json.title}"`;
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

/** Get a basename from a file path */
export function basename(path: string): string {
	const parts = path.split("/");
	return parts[parts.length - 1] ?? path;
}

/** Get a string arg from structured tool args */
function getArg(
	args: Record<string, unknown> | undefined,
	key: string,
): string | null {
	if (!args) return null;
	const val = args[key];
	return val != null ? String(val) : null;
}

/** Keys to exclude from displayed args for bash bg_action calls */
const BASH_BG_EXCLUDE = new Set(["command"]);

function bashBgExcludeKeys(
	toolName: string,
	toolArgs: Record<string, unknown> | undefined,
): Set<string> | undefined {
	if (toolName === "bash" && toolArgs?.bg_action) return BASH_BG_EXCLUDE;
	return undefined;
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
				return title ? `+ Task: ${title}` : "+ Task";
			}
			case "delete_task": {
				// Try to get title from result
				if (resultContent) {
					try {
						const json = JSON.parse(resultContent) as Record<string, unknown>;
						if (typeof json.title === "string") return `– Task: ${json.title}`;
					} catch {
						/* ignore */
					}
				}
				const taskId = getArg(toolArgs, "taskId");
				if (taskId) {
					const title = nodeMap?.get(taskId)?.title;
					return `– Task: ${title ?? taskId.slice(0, 8)}`;
				}
				return "– Task";
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
				const status = getArg(toolArgs, "status");
				const draft = getArg(toolArgs, "draft");
				const updateTitle = getArg(toolArgs, "title");
				const updateDesc = getArg(toolArgs, "description");
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
				// Build a label from what's being updated
				const updateLabel = status
					? status
					: draft != null
						? draft === "true"
							? "draft"
							: "undraft"
						: updateTitle
							? "rename"
							: updateDesc
								? "update"
								: "update_task";
				if (resolvedTitle) return `${updateLabel} → ${resolvedTitle}`;
				const taskId = getArg(toolArgs, "taskId");
				if (taskId) {
					const resolved = nodeMap?.get(taskId)?.title;
					return `${updateLabel} → ${resolved ?? taskId.slice(0, 8)}`;
				}
				return updateLabel;
			}
			case "send_message_to_child": {
				const taskId = getArg(toolArgs, "taskId");
				if (taskId) {
					const title = nodeMap?.get(taskId)?.title;
					return `→ Message Child: ${title ?? taskId.slice(0, 8)}`;
				}
				return "→ Message Child";
			}
			case "close_task": {
				const taskId = getArg(toolArgs, "taskId");
				if (taskId) {
					const title = nodeMap?.get(taskId)?.title;
					return `– Close: ${title ?? taskId.slice(0, 8)}`;
				}
				return "– Close Task";
			}
			case "reset_task": {
				const taskId = getArg(toolArgs, "taskId");
				if (taskId) {
					const title = nodeMap?.get(taskId)?.title;
					return `↺ Reset: ${title ?? taskId.slice(0, 8)}`;
				}
				return "↺ Reset Task";
			}
			case "reorder_tasks":
				return "↕ Reorder tasks";
			case "list_projects":
				return "⌕ List projects";
			case "send_message_to_project": {
				const projectId = getArg(toolArgs, "projectId");
				return projectId
					? `→ Cross-project: ${projectId.slice(0, 8)}…`
					: "→ Cross-project";
			}
			case "report_to_parent":
				return "← Report to Parent";
			case "clarify": {
				const question = getArg(toolArgs, "question");
				if (question) {
					const display =
						question.length > 40 ? `${question.slice(0, 40)}…` : question;
					return `? Clarify: ${display}`;
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
			const msg = getArg(toolArgs, "message");
			return !msg || msg.length <= 80;
		}
		default:
			return false;
	}
}

/** Render structured body for special MCP tools */
function McpToolCardBody({
	toolName,
	toolArgs,
	resultContent,
	isOk,
	t,
	nodeMap,
	taskId,
}: {
	toolName: string;
	toolArgs: Record<string, unknown> | undefined;
	resultContent: string | null;
	isOk: boolean;
	t: (key: string, params?: Record<string, string>) => string;
	nodeMap?: Map<string, { title?: string }>;
	taskId?: string;
}) {
	const mcpTool = toolName.replace("mcp__opengraft__", "");

	// Try to parse result as JSON for structured display
	let resultJson: Record<string, unknown> | null = null;
	if (resultContent) {
		try {
			resultJson = JSON.parse(resultContent) as Record<string, unknown>;
		} catch {
			// not JSON
		}
	}

	switch (mcpTool) {
		case "execute_tasks": {
			// Parse tasks from structured args
			let tasks: Array<{ taskId?: string; message?: string; mode?: string }> =
				[];
			const tasksVal = toolArgs?.tasks;
			if (Array.isArray(tasksVal)) {
				tasks = tasksVal as typeof tasks;
			} else if (typeof tasksVal === "string") {
				try {
					tasks = JSON.parse(tasksVal) as typeof tasks;
				} catch {
					// ignore
				}
			}
			// Parse result tasks info
			let resultTasks: Array<{ title?: string; taskId?: string }> = [];
			if (resultJson && Array.isArray(resultJson.tasks)) {
				resultTasks = resultJson.tasks as typeof resultTasks;
			}
			return (
				<div className="og-mcp-body">
					{resultTasks.map((rt, i) => {
						const taskInput = tasks[i];
						return (
							// biome-ignore lint/suspicious/noArrayIndexKey: stable index
							<div key={i} className="og-mcp-task-item">
								<span className="og-mcp-task-title">
									{rt.title ??
										(rt.taskId
											? (nodeMap?.get(rt.taskId)?.title ??
												rt.taskId.slice(0, 8))
											: "?")}
								</span>
								{taskInput?.mode && taskInput.mode !== "new" && (
									<span className="og-mcp-task-mode">{taskInput.mode}</span>
								)}
								{taskInput?.message && (
									<div className="og-mcp-task-msg">{taskInput.message}</div>
								)}
							</div>
						);
					})}
					{resultTasks.length === 0 && tasks.length > 0 && (
						<div className="og-mcp-task-item">
							<span className="og-mcp-task-title">
								{tasks.length} {t("log.tasks")}
							</span>
						</div>
					)}
				</div>
			);
		}
		case "create_task": {
			const title =
				getArg(toolArgs, "title") ?? String(resultJson?.title ?? "");
			const desc = getArg(toolArgs, "description");
			return (
				<div className="og-mcp-body">
					{title && <div className="og-mcp-task-title">{title}</div>}
					{desc && <div className="og-mcp-task-desc">{desc}</div>}
				</div>
			);
		}
		case "done": {
			const status = getArg(toolArgs, "status");
			const summary = getArg(toolArgs, "summary");
			const isPassed =
				status === "passed" || (isOk && resultContent?.includes("passed"));
			const taskTitle = taskId ? nodeMap?.get(taskId)?.title : undefined;
			return (
				<div className="og-mcp-body">
					{taskTitle && <div className="og-mcp-done-title">{taskTitle}</div>}
					<div
						className={`og-mcp-done-status ${isPassed ? "og-mcp-done-passed" : "og-mcp-done-failed"}`}
					>
						{isPassed ? t("tool.passed") : t("tool.failed")}
					</div>
					{summary && <div className="og-mcp-task-desc">{summary}</div>}
				</div>
			);
		}
		case "yield": {
			const formatted =
				isOk && resultContent
					? formatMcpToolResult(toolName, resultContent, t)
					: null;
			return (
				<div className="og-mcp-body">
					<div className="og-mcp-yield">{formatted ?? t("tool.waiting")}</div>
				</div>
			);
		}
		case "delete_task": {
			const title =
				typeof resultJson?.title === "string" ? resultJson.title : null;
			const taskId = getArg(toolArgs, "taskId");
			return (
				<div className="og-mcp-body">
					{title ? (
						<div className="og-mcp-task-title">
							{t("log.deletedTask")} – "{title}"
						</div>
					) : (
						<div className="og-mcp-task-title">
							{(taskId
								? (nodeMap?.get(taskId)?.title ?? taskId.slice(0, 8))
								: null) ?? "?"}
						</div>
					)}
				</div>
			);
		}
		case "get_tree": {
			const formatted =
				isOk && resultContent
					? formatMcpToolResult(toolName, resultContent, t)
					: null;
			return (
				<div className="og-mcp-body">
					<div className="og-mcp-tree-summary">
						{formatted ?? resultContent ?? ""}
					</div>
				</div>
			);
		}
		case "send_message_to_child": {
			const msg = getArg(toolArgs, "message") ?? "";
			return (
				<div className="og-mcp-body">
					{msg && <div className="og-mcp-task-desc">{msg}</div>}
				</div>
			);
		}
		case "report_to_parent": {
			const msg = getArg(toolArgs, "message") ?? "";
			return msg.length > 80 ? (
				<div className="og-mcp-body">
					<div className="og-mcp-task-desc">{msg}</div>
				</div>
			) : null;
		}
		case "send_message_to_project": {
			const msg = getArg(toolArgs, "message") ?? "";
			return (
				<div className="og-mcp-body">
					{msg && <div className="og-mcp-task-desc">{msg}</div>}
				</div>
			);
		}
		default:
			return null;
	}
}

/** Merged tool_use + tool_result card */
export function ToolCard({
	useEntry,
	resultEntry,
	nodeMap,
}: {
	useEntry: LogEntry;
	resultEntry: LogEntry;
	nodeMap: Map<string, TaskNode>;
}) {
	const { t } = useLocale();

	const toolName = useEntry.toolName ?? "";
	const toolArgs = useEntry.toolArgs;
	const argsExclude = bashBgExcludeKeys(toolName, toolArgs);
	const argsStr = formatArgs(toolArgs, argsExclude);
	const resultContent = resultEntry.toolResult ?? resultEntry.text;
	const isErr = resultEntry.isError ?? false;
	const isOk = !isErr;

	const isMcp = toolName.startsWith("mcp__opengraft__");
	const titleOnly = isTitleOnlyCard(toolName, toolArgs);
	const totalContent = argsStr + (resultContent ?? "");
	const [expanded, setExpanded] = useState(() =>
		titleOnly ? false : totalContent.length <= 200,
	);

	// Suppress done() tool_result card — task_completed card replaces it
	if (toolName === "mcp__opengraft__done") return null;

	const taskLabel = null;

	// Try structured MCP rendering (skip for title-only cards)
	const mcpBody =
		isMcp && !titleOnly ? (
			<McpToolCardBody
				toolName={toolName}
				toolArgs={toolArgs}
				nodeMap={nodeMap}
				resultContent={resultContent}
				isOk={isOk}
				t={t}
				taskId={useEntry.taskId}
			/>
		) : null;

	const mcpFormatted =
		isOk && !mcpBody ? formatMcpToolResult(toolName, resultContent, t) : null;

	const statusClass = isErr ? "og-tool-card-err" : "og-tool-card-ok";
	const accentClass = isMcp ? "og-tool-card-mcp" : "";

	return (
		<div className="og-log-entry og-event-tool_card">
			<span className="og-log-time">{useEntry.time}</span>
			{taskLabel && (
				<span className="og-log-badge" title={useEntry.taskId}>
					{taskLabel}
				</span>
			)}
			<div className={`og-tool-card ${statusClass} ${accentClass}`}>
				{titleOnly ? (
					<div className="og-tool-card-header">
						<span className="og-tool-card-name">
							{getToolCardTitle(toolName, toolArgs, resultContent, nodeMap)}
						</span>
					</div>
				) : (
					<button
						type="button"
						className="og-tool-card-header"
						onClick={() => setExpanded(!expanded)}
					>
						<span className="og-tool-card-name">
							{getToolCardTitle(toolName, toolArgs, resultContent, nodeMap)}
						</span>
						{toolName !== "mcp__opengraft__done" && (
							<span className={`og-tool-card-status ${isErr ? "err" : "ok"}`}>
								{isErr ? "✗" : "✓"}
							</span>
						)}
						<span className="og-tool-card-toggle">
							<IconChevron size={10} expanded={expanded} />
						</span>
					</button>
				)}
				{expanded && mcpBody && (
					<div className="og-tool-card-body">{mcpBody}</div>
				)}
				{expanded && !mcpBody && (
					<div className="og-tool-card-body">
						{argsStr && <div className="og-tool-card-args">{argsStr}</div>}
						{resultContent && (
							<div className="og-tool-card-result">
								{mcpFormatted ?? resultContent}
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

/** Reusable card for parent_update, child_report, cross_project messages */
function QueueMessageCard({
	entry,
	icon,
	label,
	cardClass,
	taskLabel,
}: {
	entry: LogEntry;
	icon: string;
	label: string;
	cardClass: string;
	taskLabel: string | null;
}) {
	const [expanded, setExpanded] = useState(false);
	const isLong = entry.text.length > 100 || entry.text.includes("\n");
	const headerText =
		entry.text.length > 100
			? `${entry.text.slice(0, 100)}…`
			: (entry.text.split("\n")[0] ?? entry.text);
	const header = `${icon ? `${icon} ` : ""}${label}`;

	return (
		<div className="og-log-entry og-event-tool_card">
			<span className="og-log-time">{entry.time}</span>
			{taskLabel && (
				<span className="og-log-badge" title={entry.taskId}>
					{taskLabel}
				</span>
			)}
			<div className={`og-tool-card ${cardClass}`}>
				{isLong ? (
					<button
						type="button"
						className="og-tool-card-header"
						onClick={() => setExpanded(!expanded)}
					>
						<span className="og-tool-card-name">{header}</span>
						<span className="og-tool-card-detail">{headerText}</span>
						<span className="og-tool-card-toggle">
							<IconChevron size={10} expanded={expanded} />
						</span>
					</button>
				) : (
					<div className="og-tool-card-header">
						<span className="og-tool-card-name">{header}</span>
						<span className="og-tool-card-detail">{entry.text}</span>
					</div>
				)}
				{expanded && isLong && (
					<div className="og-tool-card-body">
						<div className="og-tool-card-result">{entry.text}</div>
					</div>
				)}
			</div>
		</div>
	);
}

export function LogEntryView({
	entry,
	nodeMap,
}: {
	entry: LogEntry;
	nodeMap: Map<string, TaskNode>;
}) {
	const [expanded, setExpanded] = useState(false);
	const taskLabel = null;

	const { t } = useLocale();

	if (entry.type === "compact") {
		return (
			<div className="og-compact-boundary">
				<div className="og-compact-hint">{t("compact.notVisible")}</div>
				<div
					className={`og-compact-bar${entry.checkpoint ? "" : " og-compact-bar-loading"}`}
				>
					<span className="og-compact-label">◈ {entry.text}</span>
					{entry.checkpoint && (
						<button
							type="button"
							className="og-compact-toggle"
							onClick={() => setExpanded(!expanded)}
						>
							{expanded ? t("compact.collapse") : t("compact.checkpoint")}
						</button>
					)}
				</div>
				{expanded && entry.checkpoint && (
					<pre className="og-compact-checkpoint">{entry.checkpoint}</pre>
				)}
			</div>
		);
	}

	// Standalone tool_use (not merged with result) — show as a card too
	if (entry.type === "tool_use") {
		const toolName = entry.toolName ?? "";
		// Suppress done() tool_use card — task_completed card replaces it
		if (toolName === "mcp__opengraft__done") return null;
		const toolArgs = entry.toolArgs;
		const argsStr = formatArgs(toolArgs, bashBgExcludeKeys(toolName, toolArgs));
		const isMcp = toolName.startsWith("mcp__opengraft__");
		const isYield = toolName === "mcp__opengraft__yield";
		// Yield gets a calm "waiting" card — no spinner/pulse since it's idle, not loading
		if (isYield) {
			return (
				<div className="og-log-entry og-event-tool_card">
					<span className="og-log-time">{entry.time}</span>
					{taskLabel && (
						<span className="og-log-badge" title={entry.taskId}>
							{taskLabel}
						</span>
					)}
					<div className="og-tool-card og-tool-card-yield-waiting og-tool-card-mcp">
						<div className="og-tool-card-header">
							<span className="og-tool-card-name">⏸ {t("tool.waiting")}</span>
						</div>
					</div>
				</div>
			);
		}
		return (
			<div className="og-log-entry og-event-tool_card">
				<span className="og-log-time">{entry.time}</span>
				{taskLabel && (
					<span className="og-log-badge" title={entry.taskId}>
						{taskLabel}
					</span>
				)}
				<div
					className={`og-tool-card og-tool-card-pending og-tool-card-loading ${isMcp ? "og-tool-card-mcp" : ""}`}
				>
					<div className="og-tool-card-header">
						<span className="og-tool-card-name">
							{getToolCardTitle(toolName, toolArgs, null, nodeMap)}
						</span>
						<span className="og-tool-card-status pending">
							<span className="og-spinner" />
						</span>
					</div>
					{argsStr && (
						<div className="og-tool-card-body">
							<div className="og-tool-card-args">{argsStr}</div>
						</div>
					)}
				</div>
			</div>
		);
	}

	// Standalone tool_result (not merged) — show as a card
	if (entry.type === "tool_result") {
		const toolName = entry.toolName ?? "";
		// Suppress done() tool_result card — task_completed card replaces it
		if (toolName === "mcp__opengraft__done") return null;
		const content = entry.toolResult ?? entry.text;
		const isErr = entry.isError ?? false;
		const isOk = !isErr;
		const mcpFormatted = isOk
			? formatMcpToolResult(toolName, content, t)
			: null;
		const isMcp = toolName.startsWith("mcp__opengraft__");
		const statusClass = isErr ? "og-tool-card-err" : "og-tool-card-ok";
		return (
			<div className="og-log-entry og-event-tool_card">
				<span className="og-log-time">{entry.time}</span>
				{taskLabel && (
					<span className="og-log-badge" title={entry.taskId}>
						{taskLabel}
					</span>
				)}
				<div
					className={`og-tool-card ${statusClass} ${isMcp ? "og-tool-card-mcp" : ""}`}
				>
					<div className="og-tool-card-header">
						<span className="og-tool-card-name">
							{getToolCardTitle(toolName, undefined, content, nodeMap)}
						</span>
						{toolName !== "mcp__opengraft__done" && (
							<span className={`og-tool-card-status ${isErr ? "err" : "ok"}`}>
								{isErr ? "✗" : "✓"}
							</span>
						)}
					</div>
					{content && !isTitleOnlyCard(toolName) && (
						<div className="og-tool-card-body">
							<div className="og-tool-card-result">
								{mcpFormatted ?? content}
							</div>
						</div>
					)}
				</div>
			</div>
		);
	}

	// task_started — card-like rendering
	if (entry.type === "task_started") {
		return (
			<div className="og-log-entry og-event-tool_card">
				<span className="og-log-time">{entry.time}</span>
				{taskLabel && (
					<span className="og-log-badge" title={entry.taskId}>
						{taskLabel}
					</span>
				)}
				<div className="og-tool-card og-tool-card-pending">
					<div className="og-tool-card-header">
						<span className="og-tool-card-name">▶ {entry.text}</span>
					</div>
				</div>
			</div>
		);
	}

	// task_completed — styled card with green/red border, badge, collapsible output
	if (entry.type === "task_completed") {
		const meta = entry.meta as
			| { title?: string; success?: boolean; output?: string }
			| undefined;
		const title = meta?.title ?? "";
		const success = meta?.success ?? entry.text.startsWith("✓");
		const output = meta?.output ?? "";
		const hasOutput = output.length > 0;
		const borderClass = success
			? "og-tool-card-done-passed"
			: "og-tool-card-done-failed";

		return (
			<div className="og-log-entry og-event-tool_card">
				<span className="og-log-time">{entry.time}</span>
				{taskLabel && (
					<span className="og-log-badge" title={entry.taskId}>
						{taskLabel}
					</span>
				)}
				<div className={`og-tool-card ${borderClass}`}>
					{hasOutput ? (
						<button
							type="button"
							className="og-tool-card-header"
							onClick={() => setExpanded(!expanded)}
						>
							<span className="og-tool-card-name">
								{success ? "✓" : "✗"} {title}
							</span>
							<span
								className={`og-mcp-done-status ${success ? "og-mcp-done-passed" : "og-mcp-done-failed"}`}
							>
								{success ? "Passed" : "Failed"}
							</span>
							<span className="og-tool-card-toggle">
								<IconChevron size={10} expanded={expanded} />
							</span>
						</button>
					) : (
						<div className="og-tool-card-header">
							<span className="og-tool-card-name">
								{success ? "✓" : "✗"} {title}
							</span>
							<span
								className={`og-mcp-done-status ${success ? "og-mcp-done-passed" : "og-mcp-done-failed"}`}
							>
								{success ? "Passed" : "Failed"}
							</span>
						</div>
					)}
					{expanded && hasOutput && (
						<div className="og-tool-card-body">
							<div className="og-tool-card-result">{output}</div>
						</div>
					)}
				</div>
			</div>
		);
	}

	if (entry.type === "tree_mutation") {
		return (
			<div className="og-log-entry og-event-tool_card">
				<span className="og-log-time">{entry.time}</span>
				<div className="og-tool-card og-tool-card-system">
					<div className="og-tool-card-header">
						<span className="og-tool-card-name">🌿 {t("log.treeUpdated")}</span>
						<span className="og-tool-card-detail">{entry.text}</span>
					</div>
				</div>
			</div>
		);
	}

	if (entry.type === "parent_update") {
		return (
			<QueueMessageCard
				entry={entry}
				icon="←"
				label="Parent"
				cardClass="og-tool-card-parent"
				taskLabel={taskLabel}
			/>
		);
	}

	if (entry.type === "child_report") {
		const childTitle = (entry.meta?.childTitle as string) ?? "";
		const label = childTitle ? `↑ from ${childTitle}` : "↑ Child Report";
		return (
			<QueueMessageCard
				entry={entry}
				icon=""
				label={label}
				cardClass="og-tool-card-child-report"
				taskLabel={taskLabel}
			/>
		);
	}

	if (entry.type === "background_complete") {
		const command = (entry.meta?.command as string) ?? "";
		const exitCode = (entry.meta?.exitCode as string) ?? "";
		const durationMs = (entry.meta?.durationMs as string) ?? "";
		const cmdDisplay =
			command.length > 50 ? `${command.slice(0, 50)}…` : command;
		const detail = [
			exitCode !== "" ? `exit ${exitCode}` : "",
			durationMs ? `${durationMs}ms` : "",
		]
			.filter(Boolean)
			.join(" · ");
		return (
			<div className="og-log-entry og-event-tool_card">
				<span className="og-log-time">{entry.time}</span>
				<div className="og-tool-card og-tool-card-bg-complete">
					<div className="og-tool-card-header">
						<span className="og-tool-card-name">
							⚙ Background Complete{cmdDisplay ? `: ${cmdDisplay}` : ""}
						</span>
						{detail && <span className="og-tool-card-detail">{detail}</span>}
					</div>
				</div>
			</div>
		);
	}

	if (entry.type === "cross_project") {
		const projectName = (entry.meta?.projectName as string) ?? "";
		const label = projectName ? `← from ${projectName}` : "← Cross-Project";
		return (
			<QueueMessageCard
				entry={entry}
				icon=""
				label={label}
				cardClass="og-tool-card-cross-project"
				taskLabel={taskLabel}
			/>
		);
	}

	if (entry.type === "queue_message") {
		const sourceLabel = entry.meta?.source
			? `[${entry.meta.source as string}]`
			: "";
		const isLong = entry.text.length > 100 || entry.text.includes("\n");
		const headerText =
			entry.text.length > 100
				? `${entry.text.slice(0, 100)}…`
				: (entry.text.split("\n")[0] ?? entry.text);
		return (
			<div className="og-log-entry og-event-tool_card">
				<span className="og-log-time">{entry.time}</span>
				{taskLabel && (
					<span className="og-log-badge" title={entry.taskId}>
						{taskLabel}
					</span>
				)}
				<div className="og-tool-card og-tool-card-mcp">
					{isLong ? (
						<>
							<button
								type="button"
								className="og-tool-card-header"
								onClick={() => setExpanded(!expanded)}
							>
								<span className="og-tool-card-name">
									{sourceLabel} {headerText}
								</span>
								<span className="og-tool-card-toggle">
									<IconChevron size={10} expanded={expanded} />
								</span>
							</button>
							{expanded && (
								<div className="og-mcp-body">
									<div className="og-mcp-task-desc">{entry.text}</div>
								</div>
							)}
						</>
					) : (
						<div className="og-tool-card-header">
							<span className="og-tool-card-name">
								{sourceLabel} {headerText}
							</span>
						</div>
					)}
				</div>
			</div>
		);
	}

	if (entry.type === "user_prompt") {
		return (
			<div className="og-log-entry og-event-user_prompt">
				<span className="og-log-time">{entry.time}</span>
				<div className="og-user-prompt-bubble">
					<span className="og-user-prompt-text">{entry.text}</span>
					{entry.images && entry.images.length > 0 && (
						<div className="og-user-images">
							{entry.images.map((img) => (
								<img
									key={img.base64.slice(-32)}
									src={`data:${img.mediaType};base64,${img.base64}`}
									alt="attached"
									className="og-user-image-thumb"
									onClick={() =>
										window.open(
											`data:${img.mediaType};base64,${img.base64}`,
											"_blank",
										)
									}
									onKeyDown={(e) => {
										if (e.key === "Enter" || e.key === " ")
											window.open(
												`data:${img.mediaType};base64,${img.base64}`,
												"_blank",
											);
									}}
								/>
							))}
						</div>
					)}
				</div>
			</div>
		);
	}

	return (
		<div className={`og-log-entry og-event-${entry.type}`}>
			<span className="og-log-time">{entry.time}</span>
			{taskLabel && (
				<span className="og-log-badge" title={entry.taskId}>
					{taskLabel}
				</span>
			)}
			<div className="og-log-body">
				<span className="og-log-text">{entry.text}</span>
			</div>
		</div>
	);
}

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
