import { memo, useCallback, useState } from "react";
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
		<div className={`og-log-entry ${className ?? "og-event-tool_card"}`}>
			<span className="og-log-time">{formatTime(ts)}</span>
			{taskLabel && (
				<span className="og-log-badge" title={taskId}>
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
			await authFetch(`/projects/${projectId}/background/move`, {
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
			<div className="og-compact-boundary">
				<div className="og-compact-hint">{t("compact.notVisible")}</div>
				<div className="og-compact-bar">
					<span className="og-compact-label">◈ {displayText}</span>
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

	if (entry.type === "compact_started") {
		return (
			<div className="og-compact-boundary">
				<div className="og-compact-hint">{t("compact.notVisible")}</div>
				<div className="og-compact-bar og-compact-bar-loading">
					<span className="og-compact-label">◈ Compacting context...</span>
				</div>
			</div>
		);
	}

	if (entry.type === "fork_marker") {
		return (
			<div className="og-compact-boundary">
				<div className="og-compact-bar">
					<span className="og-compact-label">
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
		const isOpengraft = toolName.startsWith("mcp__opengraft__");
		const isDone = toolName === "mcp__opengraft__done";
		const isYield = toolName === "mcp__opengraft__yield";

		// done() tool_call — styled card with pass/fail status
		if (isDone) {
			const doneStatus = toolArgs?.status as string | undefined;
			const doneSummary = toolArgs?.summary as string | undefined;
			const donePassed = doneStatus === "passed";
			const borderClass = donePassed
				? "og-tool-card-done-passed"
				: "og-tool-card-done-failed";
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
							<div className="og-tool-card-body">
								<div className="og-tool-card-result">{doneSummary}</div>
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
						className="og-tool-card-yield-waiting og-tool-card-mcp"
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
					className={`og-tool-card-pending og-tool-card-loading ${isOpengraft ? "og-tool-card-mcp" : ""}`}
					defaultExpanded={!!argsStr}
					collapsible={!!argsStr}
					statusSlot={
						<>
							{toolName === "mcp__opengraft__bash" && projectId && (
								<button
									type="button"
									className="og-bash-background-btn"
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
							<span className="og-tool-card-status pending">
								<span className="og-spinner" />
							</span>
						</>
					}
				>
					{argsStr ? (
						<div className="og-tool-card-body">
							<div className="og-tool-card-args">{argsStr}</div>
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
		if (toolName === "mcp__opengraft__done") return null;
		const content = entry.content;
		const isErr = entry.isError;
		const isOk = !isErr;
		const mcpFormatted = isOk
			? formatMcpToolResult(toolName, content, t)
			: null;
		const isOpengraft = toolName.startsWith("mcp__opengraft__");
		const statusClass = isErr ? "og-tool-card-err" : "og-tool-card-ok";
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
					className={`${statusClass} ${isOpengraft ? "og-tool-card-mcp" : ""}`}
					collapsible={!!hasBody}
					defaultExpanded={!!hasBody}
					statusSlot={
						toolName !== "mcp__opengraft__done" ? (
							<span className={`og-tool-card-status ${isErr ? "err" : "ok"}`}>
								{isErr ? "✗" : "✓"}
							</span>
						) : undefined
					}
				>
					{hasBody ? (
						<>
							{content && !isTitleOnlyCard(toolName) && (
								<div className="og-tool-card-body">
									<div className="og-tool-card-result">
										{mcpFormatted ?? content}
									</div>
								</div>
							)}
							{hasImages && (
								<div className="og-tool-card-body">
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
					className="og-tool-card-pending"
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
			? "og-tool-card-done-passed"
			: "og-tool-card-done-failed";
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
						<div className="og-tool-card-body">
							<div className="og-tool-card-result">{output}</div>
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
					className="og-tool-card-system"
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
					className="og-tool-card-task-message"
				>
					{isLong ? (
						<div className="og-tool-card-body">
							<div className="og-tool-card-result">{text.trim()}</div>
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
				<Card title={label} detail={text} className="og-tool-card-forwarded" />
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
					className={`og-tool-card-bg-complete ${isErr ? "og-tool-card-err" : ""}`}
				>
					{outputContent ? (
						<div className="og-tool-card-body">
							<div className="og-tool-card-result">{outputContent}</div>
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
					className="og-tool-card-cross-project"
				>
					{isLong ? (
						<div className="og-tool-card-body">
							<div className="og-tool-card-result">{text.trim()}</div>
						</div>
					) : null}
				</Card>
			</LogEntryWrapper>
		);
	}

	// User message — special bubble rendering, not a card
	if (entry.type === "message" && entry.body.source === "user") {
		return (
			<div className="og-log-entry og-event-user_message">
				<span className="og-log-time">{formatTime(entry.ts)}</span>
				<div className="og-user-prompt-bubble">
					<span className="og-user-prompt-text">{entry.body.content}</span>
					{entry.body.images && entry.body.images.length > 0 && (
						<div className="og-user-images">
							{entry.body.images.map(
								(img: { base64: string; mediaType: string }) => (
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
				className="og-log-entry og-event-tool_card"
			>
				<Card title={`✗ Error`} className="og-tool-card-err" defaultExpanded>
					<div className="og-tool-card-body">
						<div className="og-tool-card-result">{entry.message}</div>
					</div>
				</Card>
			</LogEntryWrapper>
		);
	}

	// Fallback for lifecycle and any other event types
	const text = getEntryText(entry);
	return (
		<div className={`og-log-entry og-event-${entry.type}`}>
			<span className="og-log-time">{formatTime(entry.ts)}</span>
			{taskLabel && (
				<span
					className="og-log-badge"
					title={"taskId" in entry ? entry.taskId : undefined}
				>
					{taskLabel}
				</span>
			)}
			<div className="og-log-body">
				<span className="og-log-text">{text}</span>
			</div>
		</div>
	);
});
