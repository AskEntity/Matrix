import { formatMcpToolResult, getArg } from "./utils.ts";

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
			const argTaskId = getArg(toolArgs, "taskId");
			return (
				<div className="og-mcp-body">
					{title ? (
						<div className="og-mcp-task-title">
							{t("log.deletedTask")} "{title}"
						</div>
					) : (
						<div className="og-mcp-task-title">
							{(argTaskId
								? (nodeMap?.get(argTaskId)?.title ?? argTaskId.slice(0, 8))
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
			if (!msg) return null;
			return (
				<div className="og-mcp-body">
					<div className="og-mcp-task-desc">{msg}</div>
				</div>
			);
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
