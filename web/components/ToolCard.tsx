import { useState } from "react";
import {
	formatTime,
	getLogTaskId,
	type LogEntry,
	type TaskNode,
} from "../hooks.ts";
import { useLocale } from "../i18n.ts";
import { IconChevron } from "./icons.tsx";
import { McpToolCardBody } from "./tools/McpToolCard.tsx";
import { ToolResultImages } from "./tools/ToolResultImages.tsx";
import {
	bashBgExcludeKeys,
	formatArgs,
	formatMcpToolResult,
	getEntryText,
	getToolArgs,
	getToolCardTitle,
	getToolName,
	isTitleOnlyCard,
} from "./tools/utils.ts";

// Re-export sub-components and utilities for backward compatibility
export { LogEntryView } from "./tools/LogEntryView.tsx";
export {
	basename,
	formatArgs,
	formatMcpToolResult,
	getToolCardTitle,
	isTitleOnlyCard,
} from "./tools/utils.ts";

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

	const toolName = getToolName(useEntry);
	const toolArgs = getToolArgs(useEntry);
	const argsExclude = bashBgExcludeKeys(toolName, toolArgs);
	const argsStr = formatArgs(toolArgs, argsExclude);
	const resultContent =
		resultEntry.type === "tool_result"
			? resultEntry.content
			: getEntryText(resultEntry);
	const isErr =
		resultEntry.type === "tool_result" ? resultEntry.isError : false;
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
				taskId={getLogTaskId(useEntry)}
			/>
		) : null;

	const mcpFormatted =
		isOk && !mcpBody ? formatMcpToolResult(toolName, resultContent, t) : null;

	const statusClass = isErr ? "og-tool-card-err" : "og-tool-card-ok";
	const accentClass = isMcp ? "og-tool-card-mcp" : "";

	return (
		<div className="og-log-entry og-event-tool_card">
			<span className="og-log-time">{formatTime(useEntry.ts)}</span>
			{taskLabel && (
				<span className="og-log-badge" title={getLogTaskId(useEntry)}>
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
				{resultEntry.type === "tool_result" &&
					resultEntry.images &&
					resultEntry.images.length > 0 && (
						<div className="og-tool-card-body">
							<ToolResultImages images={resultEntry.images} />
						</div>
					)}
			</div>
		</div>
	);
}
