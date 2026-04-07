import type { ReactNode } from "react";
import { memo, useState } from "react";
import {
	isBuiltinTool,
	stripMcpPrefix,
	TOOL_CLOSE_TASK,
	TOOL_CREATE_TASK,
	TOOL_DONE,
	TOOL_FORK_TASK_CONTEXT,
	TOOL_RESET_TASK,
	TOOL_SEND_MESSAGE,
	TOOL_SEND_MESSAGE_TO_CHILD,
	TOOL_SEND_MESSAGE_TO_PROJECT,
	TOOL_UPDATE_TASK,
} from "../../src/tool-names.ts";
import {
	formatTime,
	getLogTaskId,
	type LogEntry,
	type TreeNode,
} from "../hooks.ts";
import { useLocale } from "../i18n.ts";
import { Card } from "./Card.tsx";
import { MCP_CARD_BODY_TOOLS, McpToolCardBody } from "./tools/McpToolCard.tsx";
import { ToolResultImages } from "./tools/ToolResultImages.tsx";
import {
	bashBgExcludeKeys,
	formatArgs,
	getArg,
	getToolTitle,
	isTitleOnly,
	summarizeToolResult,
} from "./tools/utils.ts";

export { LogEntryView } from "./tools/LogEntryView.tsx";

/**
 * Extract target task ID and title prefix for task operation tools.
 * Returns null for tools that shouldn't have clickable task links (e.g. delete_task).
 */
function getTaskLinkInfo(
	toolName: string,
	toolArgs: Record<string, unknown> | undefined,
	resultContent: string,
): { targetTaskId: string; prefix: string; suffix?: string } | null {
	switch (toolName) {
		case TOOL_SEND_MESSAGE:
		case TOOL_SEND_MESSAGE_TO_CHILD: {
			const taskId = getArg(toolArgs, "taskId");
			return taskId ? { targetTaskId: taskId, prefix: "→ Message: " } : null;
		}
		case TOOL_CREATE_TASK: {
			// Result is JSON with {id, title, ...}
			const id = parseJsonField(resultContent, "id");
			return id ? { targetTaskId: id, prefix: "+ Task Created: " } : null;
		}
		case TOOL_UPDATE_TASK: {
			const taskId = getArg(toolArgs, "taskId");
			if (!taskId) return null;
			// Preserve changed-fields suffix from the original title
			const fields: string[] = [];
			if (toolArgs) {
				if (toolArgs.status) fields.push(`status→${toolArgs.status}`);
				if (toolArgs.title) fields.push("title");
				if (toolArgs.description || toolArgs.old_description)
					fields.push("description");
				if (toolArgs.parentId) fields.push("parent");
				if (toolArgs.color) fields.push("color");
				if (toolArgs.draft !== undefined) fields.push("draft");
			}
			const suffix = fields.length > 0 ? ` (${fields.join(", ")})` : "";
			return { targetTaskId: taskId, prefix: "Task Updated: ", suffix };
		}
		case TOOL_CLOSE_TASK: {
			const taskId = getArg(toolArgs, "taskId");
			return taskId
				? { targetTaskId: taskId, prefix: "– Task Closed: " }
				: null;
		}
		case TOOL_RESET_TASK: {
			const taskId = getArg(toolArgs, "taskId");
			return taskId ? { targetTaskId: taskId, prefix: "↺ Task Reset: " } : null;
		}
		case TOOL_FORK_TASK_CONTEXT: {
			const targetId = getArg(toolArgs, "targetTaskId");
			return targetId ? { targetTaskId: targetId, prefix: "⑂ Fork → " } : null;
		}
		default:
			return null;
	}
}

/** Safely parse a string field from JSON content. */
function parseJsonField(content: string, field: string): string | undefined {
	try {
		const json = JSON.parse(content) as Record<string, unknown>;
		const val = json[field];
		return typeof val === "string" ? val : undefined;
	} catch {
		return undefined;
	}
}

/** Resolved tool_pair card — tool_call + tool_result merged in event processing layer */
export const ToolCard = memo(function ToolCard({
	entry,
	nodeMap,
	onTaskNavigate,
	projectMap,
	onProjectNavigate,
}: {
	entry: Extract<LogEntry, { type: "tool_pair" }>;
	nodeMap: Map<string, TreeNode>;
	onTaskNavigate?: (taskId: string, entryId?: string) => void;
	projectMap?: Map<string, string>;
	onProjectNavigate?: (projectId: string) => void;
}) {
	const { t } = useLocale();

	const toolName = entry.tool;
	const toolArgs = entry.input;
	const isDone = toolName === TOOL_DONE;
	const argsExclude = bashBgExcludeKeys(toolName, toolArgs);
	const argsStr = formatArgs(toolArgs, argsExclude);
	const resultContent = entry.resultContent;
	const isErr = entry.isError;
	const isOk = !isErr;

	const isBuiltin = isBuiltinTool(toolName);
	const titleOnly = isTitleOnly(toolName, toolArgs);
	const totalContent = argsStr + (resultContent ?? "");
	const [defaultExpanded] = useState(() =>
		titleOnly ? false : totalContent.length <= 200,
	);

	const taskLabel = null;

	// done() merged card — render like standalone done() tool_call card
	if (isDone) {
		const doneStatus = toolArgs?.status as string | undefined;
		const doneSummary = toolArgs?.summary as string | undefined;
		const donePassed = doneStatus === "passed";
		const borderClass = donePassed
			? "mxd-tool-card-done-passed"
			: "mxd-tool-card-done-failed";
		const doneTaskId = getLogTaskId(entry);
		const doneTaskTitle = doneTaskId
			? nodeMap?.get(doneTaskId)?.title
			: undefined;
		const doneTitle = `Task ${donePassed ? "Passed" : "Failed"}: ${doneTaskTitle || "Orchestrator"}`;
		return (
			<div
				className="mxd-lmxd-entry mxd-event-tool_card"
				data-entry-id={String(entry.id)}
			>
				<span className="mxd-lmxd-time">{formatTime(entry.ts)}</span>
				<Card
					title={`${donePassed ? "✓" : "✗"} ${doneTitle}`}
					className={borderClass}
				>
					{doneSummary ? (
						<div className="mxd-tool-card-body">
							<div className="mxd-tool-card-result">{doneSummary}</div>
						</div>
					) : null}
				</Card>
			</div>
		);
	}

	// Try structured MCP rendering (only for tools with custom card bodies)
	const shortName = stripMcpPrefix(toolName);
	const mcpBody =
		isBuiltin && !titleOnly && MCP_CARD_BODY_TOOLS.has(shortName) ? (
			<McpToolCardBody
				toolName={toolName}
				toolArgs={toolArgs}
				nodeMap={nodeMap}
				resultContent={resultContent}
				isOk={isOk}
				t={t}
				taskId={getLogTaskId(entry)}
			/>
		) : null;

	const mcpFormatted =
		isOk && !mcpBody ? summarizeToolResult(toolName, resultContent) : null;

	const statusClass = isErr ? "mxd-tool-card-err" : "mxd-tool-card-ok";
	const accentClass = isBuiltin
		? "mxd-tool-card-mcp"
		: "mxd-tool-card-external";

	const hasImages = entry.images && entry.images.length > 0;

	// Build title — clickable for task operation tools
	let cardTitle: string | ReactNode = getToolTitle(
		toolName,
		toolArgs,
		resultContent,
		nodeMap,
		{ projectMap },
	);
	if (onTaskNavigate) {
		const linkInfo = getTaskLinkInfo(toolName, toolArgs, resultContent);
		if (linkInfo) {
			const { targetTaskId, prefix, suffix } = linkInfo;
			const targetTitle = nodeMap?.get(targetTaskId)?.title ?? targetTaskId;
			cardTitle = (
				<>
					{prefix}
					{/* biome-ignore lint/a11y/useKeyWithClickEvents: click-to-navigate */}
					{/* biome-ignore lint/a11y/noStaticElementInteractions: clickable task name */}
					<span
						className="mxd-clickable-task-name"
						onClick={(e) => {
							e.stopPropagation();
							onTaskNavigate(targetTaskId, String(entry.id));
						}}
					>
						{targetTitle}
					</span>
					{suffix}
				</>
			);
		}
	}
	if (onProjectNavigate && toolName === TOOL_SEND_MESSAGE_TO_PROJECT) {
		const targetProjectId = getArg(toolArgs, "projectId");
		if (targetProjectId) {
			const targetName = projectMap?.get(targetProjectId) ?? targetProjectId;
			cardTitle = (
				<>
					{"→ Cross-project: "}
					{/* biome-ignore lint/a11y/useKeyWithClickEvents: click-to-navigate */}
					{/* biome-ignore lint/a11y/noStaticElementInteractions: clickable project name */}
					<span
						className="mxd-clickable-task-name"
						onClick={(e) => {
							e.stopPropagation();
							onProjectNavigate(targetProjectId);
						}}
					>
						{targetName}
					</span>
				</>
			);
		}
	}

	return (
		<div
			className="mxd-lmxd-entry mxd-event-tool_card"
			data-entry-id={String(entry.id)}
		>
			<span className="mxd-lmxd-time">{formatTime(entry.ts)}</span>
			{taskLabel && (
				<span className="mxd-lmxd-badge" title={getLogTaskId(entry)}>
					{taskLabel}
				</span>
			)}
			<Card
				title={cardTitle}
				className={`${statusClass} ${accentClass}`}
				collapsible={!titleOnly}
				defaultExpanded={defaultExpanded}
				statusSlot={
					!titleOnly && toolName !== TOOL_DONE ? (
						<span className={`mxd-tool-card-status ${isErr ? "err" : "ok"}`}>
							{isErr ? "✗" : "✓"}
						</span>
					) : undefined
				}
			>
				{!titleOnly ? (
					<>
						{mcpBody && <div className="mxd-tool-card-body">{mcpBody}</div>}
						{!mcpBody && (
							<div className="mxd-tool-card-body">
								{argsStr && <div className="mxd-tool-card-args">{argsStr}</div>}
								{resultContent && (
									<div className="mxd-tool-card-result">
										{mcpFormatted ?? resultContent}
									</div>
								)}
							</div>
						)}
						{hasImages && entry.images && (
							<div className="mxd-tool-card-body">
								<ToolResultImages images={entry.images} />
							</div>
						)}
					</>
				) : null}
			</Card>
		</div>
	);
});
