import type { ReactNode } from "react";
import { memo, useState } from "react";
import {
	isBuiltinTool,
	stripMcpPrefix,
	TOOL_DONE,
	TOOL_SEND_MESSAGE,
	TOOL_SEND_MESSAGE_TO_CHILD,
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

/** Resolved tool_pair card — tool_call + tool_result merged in event processing layer */
export const ToolCard = memo(function ToolCard({
	entry,
	nodeMap,
	onTaskNavigate,
}: {
	entry: Extract<LogEntry, { type: "tool_pair" }>;
	nodeMap: Map<string, TreeNode>;
	onTaskNavigate?: (taskId: string, ts?: number) => void;
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
			<div className="mxd-lmxd-entry mxd-event-tool_card">
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
	const accentClass = isBuiltin ? "mxd-tool-card-mcp" : "";

	const hasImages = entry.images && entry.images.length > 0;

	// Build title — clickable for send_message tools
	let cardTitle: string | ReactNode = getToolTitle(
		toolName,
		toolArgs,
		resultContent,
		nodeMap,
		{ emoji: true },
	);
	if (
		onTaskNavigate &&
		(toolName === TOOL_SEND_MESSAGE || toolName === TOOL_SEND_MESSAGE_TO_CHILD)
	) {
		const targetTaskId = getArg(toolArgs, "taskId");
		if (targetTaskId) {
			const targetTitle = nodeMap?.get(targetTaskId)?.title ?? targetTaskId;
			cardTitle = (
				<>
					{"→ Message: "}
					{/* biome-ignore lint/a11y/useKeyWithClickEvents: click-to-navigate */}
					{/* biome-ignore lint/a11y/noStaticElementInteractions: clickable task name */}
					<span
						className="mxd-clickable-task-name"
						onClick={(e) => {
							e.stopPropagation();
							onTaskNavigate(targetTaskId, entry.ts);
						}}
					>
						{targetTitle}
					</span>
				</>
			);
		}
	}

	return (
		<div className="mxd-lmxd-entry mxd-event-tool_card">
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
