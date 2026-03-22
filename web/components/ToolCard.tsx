import { memo, useState } from "react";
import {
	formatTime,
	getLogTaskId,
	type LogEntry,
	type TaskNode,
} from "../hooks.ts";
import { useLocale } from "../i18n.ts";
import { Card } from "./Card.tsx";
import { MCP_CARD_BODY_TOOLS, McpToolCardBody } from "./tools/McpToolCard.tsx";
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
export const ToolCard = memo(function ToolCard({
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
	const isDone = toolName === "mcp__opengraft__done";
	const argsExclude = bashBgExcludeKeys(toolName, toolArgs);
	const argsStr = formatArgs(toolArgs, argsExclude);
	const resultContent =
		resultEntry.type === "tool_result"
			? resultEntry.content
			: getEntryText(resultEntry);
	const isErr =
		resultEntry.type === "tool_result" ? resultEntry.isError : false;
	const isOk = !isErr;

	const isOpengraft = toolName.startsWith("mcp__opengraft__");
	const titleOnly = isTitleOnlyCard(toolName, toolArgs);
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
			? "og-tool-card-done-passed"
			: "og-tool-card-done-failed";
		const doneTaskId = getLogTaskId(useEntry);
		const doneTaskTitle = doneTaskId
			? nodeMap?.get(doneTaskId)?.title
			: undefined;
		const doneTitle = `Task ${donePassed ? "Passed" : "Failed"}: ${doneTaskTitle || "Orchestrator"}`;
		return (
			<div className="og-log-entry og-event-tool_card">
				<span className="og-log-time">{formatTime(useEntry.ts)}</span>
				<Card
					title={`${donePassed ? "✓" : "✗"} ${doneTitle}`}
					className={borderClass}
				>
					{doneSummary ? (
						<div className="og-tool-card-body">
							<div className="og-tool-card-result">{doneSummary}</div>
						</div>
					) : null}
				</Card>
			</div>
		);
	}

	// Try structured MCP rendering (only for tools with custom card bodies)
	const shortName = toolName.replace("mcp__opengraft__", "");
	const mcpBody =
		isOpengraft && !titleOnly && MCP_CARD_BODY_TOOLS.has(shortName) ? (
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
	const accentClass = isOpengraft ? "og-tool-card-mcp" : "";

	const hasImages =
		resultEntry.type === "tool_result" &&
		resultEntry.images &&
		resultEntry.images.length > 0;

	return (
		<div className="og-log-entry og-event-tool_card">
			<span className="og-log-time">{formatTime(useEntry.ts)}</span>
			{taskLabel && (
				<span className="og-log-badge" title={getLogTaskId(useEntry)}>
					{taskLabel}
				</span>
			)}
			<Card
				title={getToolCardTitle(toolName, toolArgs, resultContent, nodeMap)}
				className={`${statusClass} ${accentClass}`}
				collapsible={!titleOnly}
				defaultExpanded={defaultExpanded}
				statusSlot={
					!titleOnly && toolName !== "mcp__opengraft__done" ? (
						<span className={`og-tool-card-status ${isErr ? "err" : "ok"}`}>
							{isErr ? "✗" : "✓"}
						</span>
					) : undefined
				}
			>
				{!titleOnly ? (
					<>
						{mcpBody && <div className="og-tool-card-body">{mcpBody}</div>}
						{!mcpBody && (
							<div className="og-tool-card-body">
								{argsStr && <div className="og-tool-card-args">{argsStr}</div>}
								{resultContent && (
									<div className="og-tool-card-result">
										{mcpFormatted ?? resultContent}
									</div>
								)}
							</div>
						)}
						{hasImages && (
							<div className="og-tool-card-body">
								<ToolResultImages
									images={
										(resultEntry as Extract<LogEntry, { type: "tool_result" }>)
											.images!
									}
								/>
							</div>
						)}
					</>
				) : null}
			</Card>
		</div>
	);
});
