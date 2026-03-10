import { useState } from "react";
import type { LogEntry, TaskNode } from "../hooks.ts";
import { useLocale } from "../i18n.ts";
import { IconChevron } from "./icons.tsx";

/** Tools whose expanded content can stay truncated (code content). */
function isFileContentTool(toolName: string): boolean {
	return (
		toolName === "read_file" ||
		toolName === "write_file" ||
		toolName === "edit_file"
	);
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
				return `${t("log.deletedTask")} – Task: "${json.title}"`;
			}
			return null;
		}
		case "execute_tasks": {
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
		case "update_task_status": {
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
		case "clarify":
			return t("log.clarifyAsked");
		case "yield":
			return t("log.yieldReceived");
		default:
			return null;
	}
}

/** Parse tool_use text "toolName(args...)" into {toolName, argsStr} */
export function parseToolUse(text: string): {
	toolName: string;
	argsStr: string;
} {
	const idx = text.indexOf("(");
	if (idx === -1) return { toolName: text, argsStr: "" };
	return {
		toolName: text.slice(0, idx),
		argsStr: text.slice(idx + 1).replace(/\)$/, ""),
	};
}

/** Parse tool_result text "OK toolName: content" into parts */
export function parseToolResult(text: string): {
	isOk: boolean;
	isErr: boolean;
	toolName: string;
	content: string;
} {
	const isOk = text.startsWith("OK ");
	const isErr = text.startsWith("ERR ");
	const content = text.replace(/^(?:OK|ERR) [^:]+: /, "");
	const match = /^(?:OK|ERR) ([^:]+):/.exec(text);
	return { isOk, isErr, toolName: match?.[1] ?? "", content };
}

/** Extract a value from the key=value args string */
export function extractArg(argsStr: string, key: string): string | null {
	// Handle JSON values (arrays/objects) by finding key= and then matching balanced brackets
	const prefix = `${key}=`;
	const idx = argsStr.indexOf(prefix);
	if (idx === -1) return null;
	const start = idx + prefix.length;
	const firstChar = argsStr[start];
	if (firstChar === "[" || firstChar === "{") {
		// Find matching bracket
		const open = firstChar;
		const close = open === "[" ? "]" : "}";
		let depth = 0;
		for (let i = start; i < argsStr.length; i++) {
			if (argsStr[i] === open) depth++;
			else if (argsStr[i] === close) {
				depth--;
				if (depth === 0) return argsStr.slice(start, i + 1);
			}
		}
		return argsStr.slice(start);
	}
	// Simple value: read until ", key=" or end
	const rest = argsStr.slice(start);
	const endMatch = /, [a-zA-Z_]+=/.exec(rest);
	return endMatch ? rest.slice(0, endMatch.index) : rest;
}

/** Get a basename from a file path */
export function basename(path: string): string {
	const parts = path.split("/");
	return parts[parts.length - 1] ?? path;
}

/** Generate a descriptive card title from tool name, args, and result */
export function getToolCardTitle(
	toolName: string,
	argsStr: string,
	resultContent: string | null,
): string {
	// File tools
	if (toolName === "read_file") {
		const path = extractArg(argsStr, "path");
		return path ? `⌕ Read: ${basename(path)}` : "⌕ Read";
	}
	if (toolName === "write_file") {
		const path = extractArg(argsStr, "path");
		return path ? `← Write: ${basename(path)}` : "← Write";
	}
	if (toolName === "edit_file") {
		const path = extractArg(argsStr, "path");
		return path ? `✎ Edit: ${basename(path)}` : "✎ Edit";
	}
	if (toolName === "search") {
		const pattern = extractArg(argsStr, "pattern");
		if (pattern) {
			const display =
				pattern.length > 40 ? `${pattern.slice(0, 40)}…` : pattern;
			return `⌕ Search: ${display}`;
		}
		return "⌕ Search";
	}
	if (toolName === "list_files") {
		const pattern = extractArg(argsStr, "pattern");
		return pattern ? `ls: ${pattern}` : "ls";
	}
	if (toolName === "bash") {
		const command = extractArg(argsStr, "command");
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
				const title = extractArg(argsStr, "title");
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
				const taskId = extractArg(argsStr, "taskId");
				return taskId ? `– Task: ${taskId.slice(0, 8)}` : "– Task";
			}
			case "execute_tasks": {
				const tasksArg = extractArg(argsStr, "tasks");
				if (tasksArg) {
					try {
						const tasks = JSON.parse(tasksArg) as Array<{
							taskId?: string;
							title?: string;
						}>;
						// Try to get titles from result
						let titles: string[] = [];
						if (resultContent) {
							try {
								const json = JSON.parse(resultContent) as {
									tasks?: Array<{ title?: string }>;
								};
								if (Array.isArray(json.tasks)) {
									titles = json.tasks
										.map((t) => t.title ?? "?")
										.filter(Boolean);
								}
							} catch {
								/* ignore */
							}
						}
						if (titles.length > 0) {
							return `⚡ Run ${titles.length}: ${titles.join(", ")}`;
						}
						return `⚡ Run ${tasks.length}`;
					} catch {
						/* ignore */
					}
				}
				return "⚡ Run";
			}
			case "done": {
				const status = extractArg(argsStr, "status");
				const summary = extractArg(argsStr, "summary");
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
			case "update_task_status": {
				const status = extractArg(argsStr, "status");
				let title = "";
				if (resultContent) {
					try {
						const json = JSON.parse(resultContent);
						if (typeof json.title === "string") {
							title =
								json.title.length > 40
									? `${json.title.slice(0, 40)}…`
									: json.title;
						}
					} catch {
						/* ignore */
					}
				}
				if (status && title) return `${status} → ${title}`;
				const taskId = extractArg(argsStr, "taskId");
				if (status && taskId) return `${status} → ${taskId.slice(0, 8)}`;
				return "update_task_status";
			}
			case "send_message_to_child": {
				const taskId = extractArg(argsStr, "taskId");
				return taskId
					? `→ Message Child: ${taskId.slice(0, 8)}`
					: "→ Message Child";
			}
			case "report_to_parent":
				return "← Report to Parent";
			case "clarify": {
				const question = extractArg(argsStr, "question");
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
export function isTitleOnlyCard(toolName: string, argsStr: string): boolean {
	const mcpTool = toolName.replace("mcp__opengraft__", "");
	if (!toolName.startsWith("mcp__opengraft__")) return false;
	switch (mcpTool) {
		case "get_tree":
		case "yield":
		case "delete_task":
		case "update_task_status":
			return true;
		case "report_to_parent": {
			const msg = extractArg(argsStr, "message");
			return !msg || msg.length <= 80;
		}
		default:
			return false;
	}
}

/** Render structured body for special MCP tools */
function McpToolCardBody({
	toolName,
	argsStr,
	resultContent,
	isOk,
	t,
}: {
	toolName: string;
	argsStr: string;
	resultContent: string | null;
	isOk: boolean;
	t: (key: string, params?: Record<string, string>) => string;
}) {
	const mcpTool = toolName.replace("mcp__opengraft__", "");

	// Try to parse args as JSON-like key=value pairs
	let parsedArgs: Record<string, string> | null = null;
	try {
		// argsStr format: key=value, key=value or key={"json"}, ...
		// Try simple extraction
		const obj: Record<string, string> = {};
		// Handle JSON objects in args by parsing the raw format
		const rawParts = argsStr.split(/, (?=[a-zA-Z_]+=)/);
		for (const part of rawParts) {
			const eqIdx = part.indexOf("=");
			if (eqIdx > 0) {
				obj[part.slice(0, eqIdx)] = part.slice(eqIdx + 1);
			}
		}
		if (Object.keys(obj).length > 0) parsedArgs = obj;
	} catch {
		// ignore
	}

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
			// Parse tasks from args
			const tasksArg = parsedArgs?.tasks;
			let tasks: Array<{ taskId?: string; message?: string; mode?: string }> =
				[];
			if (tasksArg) {
				try {
					tasks = JSON.parse(tasksArg) as typeof tasks;
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
									{rt.title ?? rt.taskId?.slice(0, 8) ?? "?"}
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
			const title = String(parsedArgs?.title ?? resultJson?.title ?? "");
			const desc = parsedArgs?.description;
			return (
				<div className="og-mcp-body">
					{title && <div className="og-mcp-task-title">{title}</div>}
					{desc && <div className="og-mcp-task-desc">{desc}</div>}
				</div>
			);
		}
		case "done": {
			const status = parsedArgs?.status;
			const summary = parsedArgs?.summary;
			const isPassed =
				status === "passed" || (isOk && resultContent?.includes("passed"));
			return (
				<div className="og-mcp-body">
					<div
						className={`og-mcp-done-status ${isPassed ? "og-mcp-done-passed" : "og-mcp-done-failed"}`}
					>
						{isPassed ? `✓ ${t("tool.passed")}` : `✗ ${t("tool.failed")}`}
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
			return (
				<div className="og-mcp-body">
					{title ? (
						<div className="og-mcp-task-title">
							{t("log.deletedTask")} – "{title}"
						</div>
					) : (
						<div className="og-mcp-task-title">
							{parsedArgs?.taskId?.slice(0, 8) ?? "?"}
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
			const msg = parsedArgs?.message ?? "";
			return (
				<div className="og-mcp-body">
					{msg && <div className="og-mcp-task-desc">{msg}</div>}
				</div>
			);
		}
		case "report_to_parent": {
			const msg = parsedArgs?.message ?? "";
			return msg.length > 80 ? (
				<div className="og-mcp-body">
					<div className="og-mcp-task-desc">{msg}</div>
				</div>
			) : null;
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
	const { toolName, argsStr } = parseToolUse(useEntry.text);
	const {
		isOk,
		isErr,
		content: resultContent,
	} = parseToolResult(resultEntry.text);

	const isMcp = toolName.startsWith("mcp__opengraft__");
	const titleOnly = isTitleOnlyCard(toolName, argsStr);
	const totalContent = argsStr + (resultContent ?? "");
	const [expanded, setExpanded] = useState(() =>
		titleOnly ? false : totalContent.length <= 200,
	);

	const taskLabel = useEntry.taskId
		? (nodeMap.get(useEntry.taskId)?.title?.slice(0, 18) ??
			useEntry.taskId.slice(0, 8))
		: null;

	// Try structured MCP rendering (skip for title-only cards)
	const mcpBody =
		isMcp && !titleOnly ? (
			<McpToolCardBody
				toolName={toolName}
				argsStr={argsStr}
				resultContent={resultContent}
				isOk={isOk}
				t={t}
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
							{getToolCardTitle(toolName, argsStr, resultContent)}
						</span>
					</div>
				) : (
					<button
						type="button"
						className="og-tool-card-header"
						onClick={() => setExpanded(!expanded)}
					>
						<span className="og-tool-card-name">
							{getToolCardTitle(toolName, argsStr, resultContent)}
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
								{mcpFormatted ??
									(isFileContentTool(toolName) && resultContent.length > 500
										? `${resultContent.slice(0, 500)}…`
										: resultContent)}
							</div>
						)}
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
	const taskLabel = entry.taskId
		? (nodeMap.get(entry.taskId)?.title?.slice(0, 18) ??
			entry.taskId.slice(0, 8))
		: null;

	const { t } = useLocale();

	if (entry.type === "compact" && entry.checkpoint) {
		return (
			<div className="og-compact-boundary">
				<div className="og-compact-hint">{t("compact.notVisible")}</div>
				<div className="og-compact-bar">
					<span className="og-compact-label">◈ {entry.text}</span>
					<button
						type="button"
						className="og-compact-toggle"
						onClick={() => setExpanded(!expanded)}
					>
						{expanded ? t("compact.collapse") : t("compact.checkpoint")}
					</button>
				</div>
				{expanded && (
					<pre className="og-compact-checkpoint">{entry.checkpoint}</pre>
				)}
			</div>
		);
	}

	// Standalone tool_use (not merged with result) — show as a card too
	if (entry.type === "tool_use") {
		const { toolName, argsStr } = parseToolUse(entry.text);
		const isMcp = toolName.startsWith("mcp__opengraft__");
		return (
			<div className="og-log-entry og-event-tool_card">
				<span className="og-log-time">{entry.time}</span>
				{taskLabel && (
					<span className="og-log-badge" title={entry.taskId}>
						{taskLabel}
					</span>
				)}
				<div
					className={`og-tool-card og-tool-card-pending ${isMcp ? "og-tool-card-mcp" : ""}`}
				>
					<div className="og-tool-card-header">
						<span className="og-tool-card-name">
							{getToolCardTitle(toolName, argsStr, null)}
						</span>
						<span className="og-tool-card-status pending">⋯</span>
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
		const { isOk, isErr, toolName, content } = parseToolResult(entry.text);
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
							{getToolCardTitle(toolName, "", content)}
						</span>
						{toolName !== "mcp__opengraft__done" && (
							<span className={`og-tool-card-status ${isErr ? "err" : "ok"}`}>
								{isErr ? "✗" : "✓"}
							</span>
						)}
					</div>
					{content && !isTitleOnlyCard(toolName, "") && (
						<div className="og-tool-card-body">
							<div className="og-tool-card-result">
								{mcpFormatted ??
									(isFileContentTool(toolName) && content.length > 500
										? `${content.slice(0, 500)}…`
										: content)}
							</div>
						</div>
					)}
				</div>
			</div>
		);
	}

	// task_started / task_completed — card-like rendering
	if (entry.type === "task_started" || entry.type === "task_completed") {
		const isPassed =
			entry.text.startsWith("✓") || entry.text.includes(" passed");
		const icon = entry.type === "task_started" ? "▶ " : "";
		const statusClass =
			entry.type === "task_started"
				? "og-tool-card-pending"
				: isPassed
					? "og-tool-card-ok"
					: "og-tool-card-err";
		const isLong = entry.text.length > 80;
		const headerText = isLong ? `${entry.text.slice(0, 80)}…` : entry.text;
		return (
			<div className="og-log-entry og-event-tool_card">
				<span className="og-log-time">{entry.time}</span>
				{taskLabel && (
					<span className="og-log-badge" title={entry.taskId}>
						{taskLabel}
					</span>
				)}
				<div className={`og-tool-card ${statusClass}`}>
					{isLong ? (
						<button
							type="button"
							className="og-tool-card-header"
							onClick={() => setExpanded(!expanded)}
						>
							<span className="og-tool-card-name">
								{icon}
								{headerText}
							</span>
							<span className="og-tool-card-toggle">
								<IconChevron size={10} expanded={expanded} />
							</span>
						</button>
					) : (
						<div className="og-tool-card-header">
							<span className="og-tool-card-name">
								{icon}
								{entry.text}
							</span>
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

	if (entry.type === "queue_message") {
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
								<span className="og-tool-card-name">{headerText}</span>
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
							<span className="og-tool-card-name">{entry.text}</span>
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

export function formatArgs(input: Record<string, unknown> | undefined): string {
	if (!input) return "";
	const parts = Object.entries(input).map(([k, v]) => {
		const val = typeof v === "string" ? v : JSON.stringify(v);
		return `${k}=${val}`;
	});
	const joined = parts.join(", ");
	return joined;
}
