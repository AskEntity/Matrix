import { stripMcpPrefix } from "../../../../../src/tool-names.ts";
import { DiffView } from "./DiffView.tsx";
import { getArg, summarizeToolResult } from "./utils.ts";

/** Tool short names that have custom card body rendering in McpToolCardBody */
export const MCP_CARD_BODY_TOOLS = new Set([
	"create_task",
	"done",
	"yield",
	"delete_task",
	"get_tree",
	"get_task",
	"send_message",
	"send_message_to_child", // backward compat (old JSONL)
	"report_to_parent", // backward compat (old JSONL)
	"send_message_to_project",
	"execute_tasks",
	"edit_file",
	"update_task",
]);

/** Render structured body for special MCP tools */
export function McpToolCardBody({
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
	const mcpTool = stripMcpPrefix(toolName);

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
				<div className="mxd-mcp-body">
					{resultTasks.map((rt, i) => {
						const taskInput = tasks[i];
						return (
							// biome-ignore lint/suspicious/noArrayIndexKey: stable index
							<div key={i} className="mxd-mcp-task-item">
								<span className="mxd-mcp-task-title">
									{rt.title ??
										(rt.taskId
											? (nodeMap?.get(rt.taskId)?.title ?? rt.taskId)
											: "?")}
								</span>
								{taskInput?.mode && taskInput.mode !== "new" && (
									<span className="mxd-mcp-task-mode">{taskInput.mode}</span>
								)}
								{taskInput?.message && (
									<div className="mxd-mcp-task-msg">{taskInput.message}</div>
								)}
							</div>
						);
					})}
					{resultTasks.length === 0 && tasks.length > 0 && (
						<div className="mxd-mcp-task-item">
							<span className="mxd-mcp-task-title">
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
				<div className="mxd-mcp-body">
					{title && <div className="mxd-mcp-task-title">{title}</div>}
					{desc && <div className="mxd-mcp-task-desc">{desc}</div>}
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
				<div className="mxd-mcp-body">
					{taskTitle && <div className="mxd-mcp-done-title">{taskTitle}</div>}
					<div
						className={`mxd-mcp-done-status ${isPassed ? "mxd-mcp-done-passed" : "mxd-mcp-done-failed"}`}
					>
						{isPassed ? t("tool.passed") : t("tool.failed")}
					</div>
					{summary && <div className="mxd-mcp-task-desc">{summary}</div>}
				</div>
			);
		}
		case "yield": {
			const formatted =
				isOk && resultContent
					? summarizeToolResult(toolName, resultContent)
					: null;
			return (
				<div className="mxd-mcp-body">
					<div className="mxd-mcp-yield">{formatted ?? t("tool.waiting")}</div>
				</div>
			);
		}
		case "delete_task": {
			const title =
				typeof resultJson?.title === "string" ? resultJson.title : null;
			const argTaskId = getArg(toolArgs, "taskId");
			return (
				<div className="mxd-mcp-body">
					{title ? (
						<div className="mxd-mcp-task-title">
							{t("log.deletedTask")} "{title}"
						</div>
					) : (
						<div className="mxd-mcp-task-title">
							{(argTaskId
								? (nodeMap?.get(argTaskId)?.title ?? argTaskId)
								: null) ?? "?"}
						</div>
					)}
				</div>
			);
		}
		case "get_tree": {
			const opts: string[] = [];
			if (toolArgs?.format === "tree") opts.push("tree format");
			if (toolArgs?.include_details) opts.push("detailed");
			if (toolArgs?.include_closed) opts.push("with closed");
			const formatted =
				isOk && resultContent
					? summarizeToolResult(toolName, resultContent)
					: null;
			return (
				<div className="mxd-mcp-body">
					{opts.length > 0 && (
						<div className="mxd-mcp-task-desc">{opts.join(", ")}</div>
					)}
					<div className="mxd-mcp-tree-summary">
						{formatted ?? resultContent ?? ""}
					</div>
				</div>
			);
		}
		case "get_task": {
			const argTaskId = getArg(toolArgs, "taskId");
			const title =
				typeof resultJson?.title === "string" ? resultJson.title : null;
			return (
				<div className="mxd-mcp-body">
					<div className="mxd-mcp-task-title">{title ?? argTaskId ?? "?"}</div>
				</div>
			);
		}
		case "send_message":
		case "send_message_to_child": // backward compat (old JSONL)
		case "report_to_parent": {
			// backward compat (old JSONL)
			const msg = getArg(toolArgs, "message") ?? "";
			if (!msg) return null;
			return (
				<div className="mxd-mcp-body">
					<div className="mxd-mcp-task-desc">{msg}</div>
				</div>
			);
		}
		case "send_message_to_project": {
			const msg = getArg(toolArgs, "message") ?? "";
			return (
				<div className="mxd-mcp-body">
					{msg && <div className="mxd-mcp-task-desc">{msg}</div>}
				</div>
			);
		}
		case "edit_file": {
			const path = getArg(toolArgs, "path");
			const oldStr = getArg(toolArgs, "old_string");
			const newStr = getArg(toolArgs, "new_string");
			if (oldStr != null && newStr != null) {
				return (
					<div className="mxd-mcp-body">
						{path && <div className="mxd-mcp-diff-path">{path}</div>}
						<DiffView oldText={oldStr} newText={newStr} />
					</div>
				);
			}
			return null;
		}
		case "update_task": {
			const oldDesc = getArg(toolArgs, "old_description");
			const newDesc = getArg(toolArgs, "new_description");
			if (oldDesc != null && newDesc != null) {
				return (
					<div className="mxd-mcp-body">
						<DiffView oldText={oldDesc} newText={newDesc} />
					</div>
				);
			}
			// Show changed fields summary
			const fields: string[] = [];
			if (toolArgs) {
				if (toolArgs.status) fields.push(`status → ${toolArgs.status}`);
				if (toolArgs.title) fields.push(`title: "${toolArgs.title}"`);
				if (toolArgs.description) fields.push("description updated");
				if (toolArgs.parentId) fields.push(`parent → ${toolArgs.parentId}`);
				if (toolArgs.color) fields.push(`color → ${toolArgs.color}`);
				if (toolArgs.draft !== undefined)
					fields.push(`draft → ${toolArgs.draft}`);
			}
			if (fields.length > 0) {
				return (
					<div className="mxd-mcp-body">
						{fields.map((f) => (
							<div key={f} className="mxd-mcp-task-desc">
								{f}
							</div>
						))}
					</div>
				);
			}
			return null;
		}
		default:
			return null;
	}
}
