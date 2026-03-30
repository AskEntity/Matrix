import { memo, useCallback, useState } from "react";
import {
	isBuiltinTool,
	TOOL_BASH,
	TOOL_DONE,
	TOOL_YIELD,
} from "../../../src/tool-names.ts";
import { api } from "../../api.ts";
import { authFetch } from "../../auth.ts";
import {
	formatTime,
	getLogTaskId,
	type LogEntry,
	type TaskNode,
} from "../../hooks.ts";
import { useLocale } from "../../i18n.ts";
import { Card } from "../Card.tsx";
import { ToolResultImages } from "./ToolResultImages.tsx";
import {
	bashBgExcludeKeys,
	formatArgs,
	formatMcpToolResult,
	getEntryText,
	getToolCardTitle,
	getToolName,
	isTitleOnlyCard,
} from "./utils.ts";

/** Outer wrapper: timestamp + badge + card */
function LogEntryWrapper({
	ts,
	taskLabel,
	taskId,
	className,
	children,
}: {
	ts: number;
	taskLabel: string | null;
	taskId?: string;
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<div className={`mxd-lmxd-entry ${className ?? "mxd-event-tool_card"}`}>
			<span className="mxd-lmxd-time">{formatTime(ts)}</span>
			{taskLabel && (
				<span className="mxd-lmxd-badge" title={taskId}>
					{taskLabel}
				</span>
			)}
			{children}
		</div>
	);
}

export const LogEntryView = memo(function LogEntryView({
	entry,
	nodeMap,
	projectId,
	rootNodeId,
}: {
	entry: LogEntry;
	nodeMap: Map<string, TaskNode>;
	projectId?: string;
	rootNodeId?: string | null;
}) {
	const [expanded, setExpanded] = useState(false);
	const [movingToBg, setMovingToBg] = useState(false);
	const taskLabel = null;

	const { t } = useLocale();

	const handleMoveToBackground = useCallback(async () => {
		if (!projectId) return;
		const toolCallId =
			"toolCallId" in entry ? (entry.toolCallId as string) : undefined;
		const taskId = getLogTaskId(entry);
		if (!toolCallId) return;
		setMovingToBg(true);
		try {
			await authFetch(api.backgroundMove(projectId), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					sessionId: taskId ?? rootNodeId ?? "",
					execId: toolCallId,
				}),
			});
		} catch {
			// ignore — command may have already completed
		} finally {
			setMovingToBg(false);
		}
	}, [projectId, rootNodeId, entry]);

	if (entry.type === "compact_marker") {
		const displayText = `Context compacted (saved ~${entry.savedTokens} tokens)`;
		return (
			<div className="mxd-compact-boundary">
				<div className="mxd-compact-hint">{t("compact.notVisible")}</div>
				<div className="mxd-compact-bar">
					<span className="mxd-compact-label">◈ {displayText}</span>
					{entry.checkpoint && (
						<button
							type="button"
							className="mxd-compact-toggle"
							onClick={() => setExpanded(!expanded)}
						>
							{expanded ? t("compact.collapse") : t("compact.checkpoint")}
						</button>
					)}
				</div>
				{expanded && entry.checkpoint && (
					<pre className="mxd-compact-checkpoint">{entry.checkpoint}</pre>
				)}
			</div>
		);
	}

	if (entry.type === "compact_started") {
		return (
			<div className="mxd-compact-boundary">
				<div className="mxd-compact-hint">{t("compact.notVisible")}</div>
				<div className="mxd-compact-bar mxd-compact-bar-loading">
					<span className="mxd-compact-label">◈ Compacting context...</span>
				</div>
			</div>
		);
	}

	if (entry.type === "fork_marker") {
		return (
			<div className="mxd-compact-boundary">
				<div className="mxd-compact-bar">
					<span className="mxd-compact-label">
						⑂ Forked from {entry.sourceTaskId}
					</span>
				</div>
			</div>
		);
	}

	// Standalone tool_use (not merged with result) — show as a card
	if (entry.type === "tool_call") {
		const toolName = getToolName(entry);
		const toolArgs = entry.input;
		const argsStr = formatArgs(toolArgs, bashBgExcludeKeys(toolName, toolArgs));
		const isBuiltin = isBuiltinTool(toolName);
		const isDone = toolName === TOOL_DONE;
		const isYield = toolName === TOOL_YIELD;

		// done() tool_call — styled card with pass/fail status
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
				<LogEntryWrapper
					ts={entry.ts}
					taskLabel={taskLabel}
					taskId={getLogTaskId(entry)}
				>
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
				</LogEntryWrapper>
			);
		}

		// Yield gets a calm "waiting" card
		if (isYield) {
			return (
				<LogEntryWrapper
					ts={entry.ts}
					taskLabel={taskLabel}
					taskId={getLogTaskId(entry)}
				>
					<Card
						title={`⏸ ${t("tool.waiting")}`}
						className="mxd-tool-card-yield-waiting mxd-tool-card-mcp"
						collapsible={false}
					/>
				</LogEntryWrapper>
			);
		}

		// Regular pending tool_call
		return (
			<LogEntryWrapper
				ts={entry.ts}
				taskLabel={taskLabel}
				taskId={getLogTaskId(entry)}
			>
				<Card
					title={getToolCardTitle(toolName, toolArgs, null, nodeMap)}
					className={`mxd-tool-card-pending mxd-tool-card-loading ${isBuiltin ? "mxd-tool-card-mcp" : ""}`}
					defaultExpanded={!!argsStr}
					collapsible={!!argsStr}
					statusSlot={
						<>
							{toolName === TOOL_BASH && projectId && (
								<button
									type="button"
									className="mxd-bash-background-btn"
									onClick={(e) => {
										e.stopPropagation();
										handleMoveToBackground();
									}}
									disabled={movingToBg}
									title="Move to background"
								>
									⏎ Background
								</button>
							)}
							<span className="mxd-tool-card-status pending">
								<span className="mxd-spinner" />
							</span>
						</>
					}
				>
					{argsStr ? (
						<div className="mxd-tool-card-body">
							<div className="mxd-tool-card-args">{argsStr}</div>
						</div>
					) : null}
				</Card>
			</LogEntryWrapper>
		);
	}

	// Standalone tool_result (not merged)
	if (entry.type === "tool_result") {
		const toolName = getToolName(entry);
		// Suppress standalone done() tool_result — the tool_call card shows everything
		if (toolName === TOOL_DONE) return null;
		const content = entry.content;
		const isErr = entry.isError;
		const isOk = !isErr;
		const mcpFormatted = isOk
			? formatMcpToolResult(toolName, content, t)
			: null;
		const isBuiltin = isBuiltinTool(toolName);
		const statusClass = isErr ? "mxd-tool-card-err" : "mxd-tool-card-ok";
		const hasImages = entry.images && entry.images.length > 0;
		const hasBody = (content && !isTitleOnlyCard(toolName)) || hasImages;

		return (
			<LogEntryWrapper
				ts={entry.ts}
				taskLabel={taskLabel}
				taskId={getLogTaskId(entry)}
			>
				<Card
					title={getToolCardTitle(toolName, undefined, content, nodeMap)}
					className={`${statusClass} ${isBuiltin ? "mxd-tool-card-mcp" : ""}`}
					collapsible={!!hasBody}
					defaultExpanded={!!hasBody}
					statusSlot={
						toolName !== TOOL_DONE ? (
							<span className={`mxd-tool-card-status ${isErr ? "err" : "ok"}`}>
								{isErr ? "✗" : "✓"}
							</span>
						) : undefined
					}
				>
					{hasBody ? (
						<>
							{content && !isTitleOnlyCard(toolName) && (
								<div className="mxd-tool-card-body">
									<div className="mxd-tool-card-result">
										{mcpFormatted ?? content}
									</div>
								</div>
							)}
							{hasImages && (
								<div className="mxd-tool-card-body">
									<ToolResultImages images={entry.images!} />
								</div>
							)}
						</>
					) : null}
				</Card>
			</LogEntryWrapper>
		);
	}

	// task_started
	if (entry.type === "task_started") {
		return (
			<LogEntryWrapper
				ts={entry.ts}
				taskLabel={taskLabel}
				taskId={entry.taskId}
			>
				<Card
					title={`▶ ${t("lifecycle.taskStarted")} ${entry.title}`}
					className="mxd-tool-card-pending"
					collapsible={false}
				/>
			</LogEntryWrapper>
		);
	}

	// task_completed — styled card with green/red border, collapsible output
	if (entry.type === "task_completed") {
		const title = entry.title;
		const success = entry.success;
		const output = entry.output ?? "";
		const borderClass = success
			? "mxd-tool-card-done-passed"
			: "mxd-tool-card-done-failed";
		const completedTitle = `Task ${success ? "Passed" : "Failed"}: ${title}`;

		return (
			<LogEntryWrapper
				ts={entry.ts}
				taskLabel={taskLabel}
				taskId={entry.taskId}
			>
				<Card
					title={`${success ? "✓" : "✗"} ${completedTitle}`}
					className={borderClass}
				>
					{output.length > 0 ? (
						<div className="mxd-tool-card-body">
							<div className="mxd-tool-card-result">{output}</div>
						</div>
					) : null}
				</Card>
			</LogEntryWrapper>
		);
	}

	// tree_change
	if (entry.type === "tree_change") {
		const text = entry.title ? `${entry.action}: ${entry.title}` : entry.action;
		return (
			<LogEntryWrapper ts={entry.ts} taskLabel={taskLabel}>
				<Card
					title={`🌿 ${t("log.treeUpdated")}`}
					detail={text}
					className="mxd-tool-card-system"
					collapsible={false}
				/>
			</LogEntryWrapper>
		);
	}

	// task_message (from another task — either direction)
	if (entry.type === "task_message") {
		const fromTitle = entry.fromTitle ?? "";
		const msgTitle = entry.title ?? "";
		const label = msgTitle
			? `↑ ${msgTitle}`
			: fromTitle
				? `↑ from ${fromTitle}`
				: "↑ Task Message";
		const text = getEntryText(entry);
		const isLong = text.length > 100 || text.includes("\n");
		const headerText =
			text.length > 100
				? `${text.slice(0, 100)}…`
				: (text.split("\n")[0] ?? text);

		return (
			<LogEntryWrapper
				ts={entry.ts}
				taskLabel={taskLabel}
				taskId={getLogTaskId(entry)}
			>
				<Card
					title={label}
					detail={isLong ? headerText : text}
					className="mxd-tool-card-task-message"
				>
					{isLong ? (
						<div className="mxd-tool-card-body">
							<div className="mxd-tool-card-result">{text.trim()}</div>
						</div>
					) : null}
				</Card>
			</LogEntryWrapper>
		);
	}

	// user_message_forwarded — CC'd user message to sub task, rendered muted
	if (entry.type === "user_message_forwarded") {
		const childTitle = entry.title ?? "";
		const label = `📨 user → ${childTitle}`;
		const text = getEntryText(entry);

		return (
			<LogEntryWrapper
				ts={entry.ts}
				taskLabel={taskLabel}
				taskId={getLogTaskId(entry)}
			>
				<Card title={label} detail={text} className="mxd-tool-card-forwarded" />
			</LogEntryWrapper>
		);
	}

	// background_complete — now collapsible via Card
	if (entry.type === "background_complete") {
		const command = entry.command;
		const exitCode = entry.exitCode;
		const durationMs = entry.durationMs;
		const stdout = entry.stdout;
		const stderr = entry.stderr;
		const cmdDisplay =
			command.length > 50 ? `${command.slice(0, 50)}…` : command;
		const durationSec = durationMs ? `${Math.round(durationMs / 1000)}s` : "";
		const detail = [exitCode != null ? `exit ${exitCode}` : "", durationSec]
			.filter(Boolean)
			.join(" · ");
		const isErr = exitCode != null && exitCode !== 0;
		// Build output content similar to bash tool_result
		const outputParts: string[] = [];
		if (stdout) outputParts.push(`stdout:\n${stdout}`);
		if (stderr) outputParts.push(`stderr:\n${stderr}`);
		if (exitCode != null) outputParts.push(`exit code: ${exitCode}`);
		const outputContent = outputParts.join("\n");

		return (
			<LogEntryWrapper ts={entry.ts} taskLabel={taskLabel}>
				<Card
					title={`⚙ Background Complete${cmdDisplay ? `: ${cmdDisplay}` : ""}`}
					detail={detail || undefined}
					className={`mxd-tool-card-bg-complete ${isErr ? "mxd-tool-card-err" : ""}`}
				>
					{outputContent ? (
						<div className="mxd-tool-card-body">
							<div className="mxd-tool-card-result">{outputContent}</div>
						</div>
					) : null}
				</Card>
			</LogEntryWrapper>
		);
	}

	// cross_project
	if (entry.type === "cross_project") {
		const projectName = entry.fromProjectName ?? "";
		const label = projectName ? `← from ${projectName}` : "← Cross-Project";
		const text = getEntryText(entry);
		const isLong = text.length > 100 || text.includes("\n");
		const headerText =
			text.length > 100
				? `${text.slice(0, 100)}…`
				: (text.split("\n")[0] ?? text);

		return (
			<LogEntryWrapper
				ts={entry.ts}
				taskLabel={taskLabel}
				taskId={getLogTaskId(entry)}
			>
				<Card
					title={label}
					detail={isLong ? headerText : text}
					className="mxd-tool-card-cross-project"
				>
					{isLong ? (
						<div className="mxd-tool-card-body">
							<div className="mxd-tool-card-result">{text.trim()}</div>
						</div>
					) : null}
				</Card>
			</LogEntryWrapper>
		);
	}

	// User message — special bubble rendering, not a card
	if (entry.type === "message" && entry.body.source === "user") {
		return (
			<div className="mxd-lmxd-entry mxd-event-user_message">
				<span className="mxd-lmxd-time">{formatTime(entry.ts)}</span>
				<div className="mxd-user-prompt-bubble">
					<span className="mxd-user-prompt-text">{entry.body.content}</span>
					{entry.body.images && entry.body.images.length > 0 && (
						<div className="mxd-user-images">
							{entry.body.images.map(
								(img: { base64: string; mediaType: string }) => (
									<img
										key={img.base64.slice(-32)}
										src={`data:${img.mediaType};base64,${img.base64}`}
										alt="attached"
										className="mxd-user-image-thumb"
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
								),
							)}
						</div>
					)}
				</div>
			</div>
		);
	}

	// Error — now uses Card for consistent structure
	if (entry.type === "error") {
		return (
			<LogEntryWrapper
				ts={entry.ts}
				taskLabel={taskLabel}
				taskId={entry.taskId}
				className="mxd-lmxd-entry mxd-event-tool_card"
			>
				<Card title={`✗ Error`} className="mxd-tool-card-err" defaultExpanded>
					<div className="mxd-tool-card-body">
						<div className="mxd-tool-card-result">{entry.message}</div>
					</div>
				</Card>
			</LogEntryWrapper>
		);
	}

	// Fallback for lifecycle and any other event types
	const text = getEntryText(entry);
	return (
		<div className={`mxd-lmxd-entry mxd-event-${entry.type}`}>
			<span className="mxd-lmxd-time">{formatTime(entry.ts)}</span>
			{taskLabel && (
				<span
					className="mxd-lmxd-badge"
					title={"taskId" in entry ? entry.taskId : undefined}
				>
					{taskLabel}
				</span>
			)}
			<div className="mxd-lmxd-body">
				<span className="mxd-lmxd-text">{text}</span>
			</div>
		</div>
	);
});
