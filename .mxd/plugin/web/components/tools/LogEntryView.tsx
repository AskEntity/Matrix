import { memo, useCallback, useState } from "react";
import { api } from "../../api.ts";
import { useAuthFetch } from "../../auth.ts";
import {
	type CacheInfo,
	formatTime,
	getLogTaskId,
	type LogEntry,
	type TreeNode,
} from "../../hooks.ts";
import { useLocale } from "../../i18n.ts";
import {
	isBuiltinTool,
	TOOL_BASH,
	TOOL_DONE,
	TOOL_YIELD,
} from "../../tool-names.ts";
import { Card } from "../Card.tsx";
import { ToolResultImages } from "./ToolResultImages.tsx";
import {
	bashBgExcludeKeys,
	formatArgs,
	getEntryText,
	getToolName,
	getToolTitle,
	isTitleOnly,
	summarizeToolResult,
} from "./utils.ts";

/** Outer wrapper: timestamp + badge + card */
function LogEntryWrapper({
	ts,
	entryId,
	taskLabel,
	taskId,
	className,
	children,
}: {
	ts: number;
	entryId?: string;
	taskLabel: string | null;
	taskId?: string;
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<div
			className={`mxd-lmxd-entry ${className ?? "mxd-event-tool_card"}`}
			data-entry-id={entryId}
		>
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

/** Subtle cache info badge — shows on hover with detailed token breakdown tooltip. */
function CacheInfoBadge({ cacheInfo }: { cacheInfo: CacheInfo }) {
	const creation = cacheInfo.cacheCreationTokens ?? 0;
	const read = cacheInfo.cacheReadTokens ?? 0;
	const input = cacheInfo.inputTokens;
	const output = cacheInfo.outputTokens ?? 0;

	// Cache hit ratio: read tokens / (read + creation + uncached input)
	// A high ratio means most tokens were served from cache
	const totalInput = input;
	const hitRatio = totalInput > 0 ? read / totalInput : 0;

	const lines = [
		`Input: ${input.toLocaleString()}`,
		output ? `Output: ${output.toLocaleString()}` : null,
		`Cache read: ${read.toLocaleString()}`,
		`Cache write: ${creation.toLocaleString()}`,
		`Cache hit: ${(hitRatio * 100).toFixed(0)}%`,
	]
		.filter(Boolean)
		.join("\n");

	// Icon color reflects cache performance
	const color =
		hitRatio >= 0.8
			? "var(--color-passed)"
			: hitRatio >= 0.3
				? "var(--color-pending)"
				: "var(--text-faint)";

	return (
		<span
			className="mxd-cache-badge"
			title={lines}
			style={{ color, cursor: "default" }}
		>
			⚡
		</span>
	);
}

export const LogEntryView = memo(function LogEntryView({
	entry,
	nodeMap,
	projectId,
	rootNodeId,
	onTaskNavigate,
	onProjectNavigate,
	showCacheBadges,
}: {
	entry: LogEntry;
	nodeMap: Map<string, TreeNode>;
	projectId?: string;
	rootNodeId?: string | null;
	onTaskNavigate?: (taskId: string, entryId?: string) => void;
	onProjectNavigate?: (projectId: string) => void;
	showCacheBadges?: boolean;
}) {
	const authFetch = useAuthFetch();
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
	}, [projectId, rootNodeId, entry, authFetch]);

	if (entry.type === "compact_marker") {
		const displayText = `Context compacted (saved ~${entry.savedTokens} tokens)`;
		return (
			<div className="mxd-compact-boundary">
				<div className="mxd-compact-hint">{t("compact.notVisible")}</div>
				<div className="mxd-compact-bar">
					<span className="mxd-compact-label">◈ {displayText}</span>
				</div>
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
					entryId={String(entry.id)}
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
					entryId={String(entry.id)}
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
				entryId={String(entry.id)}
				taskLabel={taskLabel}
				taskId={getLogTaskId(entry)}
			>
				<Card
					title={getToolTitle(toolName, toolArgs, null, nodeMap)}
					className={`mxd-tool-card-pending mxd-tool-card-loading ${isBuiltin ? "mxd-tool-card-mcp" : "mxd-tool-card-external"}`}
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
		const mcpFormatted = isOk ? summarizeToolResult(toolName, content) : null;
		const isBuiltin = isBuiltinTool(toolName);
		const statusClass = isErr ? "mxd-tool-card-err" : "mxd-tool-card-ok";
		const hasImages = entry.images && entry.images.length > 0;
		const hasBody = (content && !isTitleOnly(toolName)) || hasImages;

		return (
			<LogEntryWrapper
				ts={entry.ts}
				entryId={String(entry.id)}
				taskLabel={taskLabel}
				taskId={getLogTaskId(entry)}
			>
				<Card
					title={getToolTitle(toolName, undefined, content, nodeMap)}
					className={`${statusClass} ${isBuiltin ? "mxd-tool-card-mcp" : "mxd-tool-card-external"}`}
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
							{content && !isTitleOnly(toolName) && (
								<div className="mxd-tool-card-body">
									<div className="mxd-tool-card-result">
										{mcpFormatted ?? content}
									</div>
								</div>
							)}
							{hasImages && (
								<div className="mxd-tool-card-body">
									<ToolResultImages
										images={
											entry.images as Array<{
												mediaType: string;
												base64: string;
											}>
										}
									/>
								</div>
							)}
						</>
					) : null}
				</Card>
			</LogEntryWrapper>
		);
	}

	// task_started removed — merged into agent_start event

	// task_completed — styled card with green/red border, collapsible output
	if (entry.type === "task_completed") {
		const title = entry.title;
		const fromTaskId =
			"fromTaskId" in entry ? (entry.fromTaskId as string) : undefined;
		const success = entry.success;
		const output = entry.output ?? "";
		const borderClass = success
			? "mxd-tool-card-done-passed"
			: "mxd-tool-card-done-failed";
		const prefix = `${success ? "✓" : "✗"} Task ${success ? "Passed" : "Failed"}: `;
		const canNavigate = fromTaskId && onTaskNavigate;

		const titleNode = canNavigate ? (
			<>
				{prefix}
				{/* biome-ignore lint/a11y/useKeyWithClickEvents: click-to-navigate affordance */}
				{/* biome-ignore lint/a11y/noStaticElementInteractions: clickable task name */}
				<span
					className="mxd-clickable-task-name"
					onClick={(e) => {
						e.stopPropagation();
						onTaskNavigate(fromTaskId, String(entry.id));
					}}
				>
					{title}
				</span>
			</>
		) : (
			`${prefix}${title}`
		);

		return (
			<LogEntryWrapper
				ts={entry.ts}
				entryId={String(entry.id)}
				taskLabel={taskLabel}
				taskId={entry.taskId}
			>
				<Card title={titleNode} className={borderClass}>
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
			<LogEntryWrapper
				ts={entry.ts}
				entryId={String(entry.id)}
				taskLabel={taskLabel}
			>
				<Card
					title={t("log.treeUpdated")}
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
		const fromTaskId =
			"fromTaskId" in entry ? (entry.fromTaskId as string) : undefined;
		const msgTitle = entry.title ?? "";
		const text = getEntryText(entry);

		// Determine direction: is the sender a child of the current task?
		// Walk up from fromTaskId through folders to find the owning task.
		// If that owner is the current task → child reporting up (↑)
		// Otherwise → parent/sibling instructing down (↓)
		const currentTaskId = getLogTaskId(entry) ?? rootNodeId;
		let isFromChild = false;
		if (fromTaskId && nodeMap) {
			let walkId: string | null | undefined = fromTaskId;
			while (walkId) {
				const walkNode = nodeMap.get(walkId);
				if (!walkNode) break;
				if (walkNode.parentId === currentTaskId) {
					isFromChild = true;
					break;
				}
				// If parent is a folder, keep walking up
				const parentNode = walkNode.parentId
					? nodeMap.get(walkNode.parentId)
					: undefined;
				if (
					parentNode &&
					"type" in parentNode &&
					parentNode.type === "folder"
				) {
					walkId = parentNode.parentId;
				} else {
					break;
				}
			}
		}
		const arrow = isFromChild ? "↑" : "↓";

		const senderName = fromTitle || "Task";
		const titleSuffix = msgTitle ? ` · ${msgTitle}` : "";
		const canNavigate = fromTaskId && onTaskNavigate;
		const labelNode = canNavigate ? (
			<>
				{`${arrow} `}
				{/* biome-ignore lint/a11y/useKeyWithClickEvents: click-to-navigate affordance */}
				{/* biome-ignore lint/a11y/noStaticElementInteractions: clickable task name */}
				<span
					className="mxd-clickable-task-name"
					onClick={(e) => {
						e.stopPropagation();
						onTaskNavigate(fromTaskId, String(entry.id));
					}}
				>
					{senderName}
				</span>
				{titleSuffix}
			</>
		) : (
			`${arrow} ${senderName}${titleSuffix}`
		);

		return (
			<LogEntryWrapper
				ts={entry.ts}
				entryId={String(entry.id)}
				taskLabel={taskLabel}
				taskId={getLogTaskId(entry)}
			>
				<Card title={labelNode} className="mxd-tool-card-task-message">
					{text ? (
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
		const fromTaskId =
			"fromTaskId" in entry ? (entry.fromTaskId as string) : undefined;
		const resumed = "resumed" in entry && entry.resumed;
		const prefix = resumed ? "User resumed → " : "User → ";
		const text = getEntryText(entry);

		const titleNode =
			fromTaskId && onTaskNavigate ? (
				<>
					{prefix}
					{/* biome-ignore lint/a11y/useKeyWithClickEvents: click-to-navigate affordance */}
					{/* biome-ignore lint/a11y/noStaticElementInteractions: clickable task name */}
					<span
						className="mxd-clickable-task-name"
						onClick={(e) => {
							e.stopPropagation();
							onTaskNavigate(fromTaskId, String(entry.id));
						}}
					>
						{childTitle}
					</span>
				</>
			) : (
				`${prefix}${childTitle}`
			);

		return (
			<LogEntryWrapper
				ts={entry.ts}
				entryId={String(entry.id)}
				taskLabel={taskLabel}
				taskId={getLogTaskId(entry)}
			>
				<Card
					title={titleNode}
					detail={text}
					className="mxd-tool-card-forwarded"
				/>
			</LogEntryWrapper>
		);
	}

	// background_complete — now collapsible via Card
	if (entry.type === "background_complete") {
		const command = entry.command;
		const exitCode = entry.exitCode;
		const durationMs = entry.durationMs;
		const outputContent = entry.content;
		const cmdDisplay =
			command.length > 50 ? `${command.slice(0, 50)}…` : command;
		const durationSec = durationMs ? `${Math.round(durationMs / 1000)}s` : "";
		const detail = [exitCode != null ? `exit ${exitCode}` : "", durationSec]
			.filter(Boolean)
			.join(" · ");
		const isErr = exitCode != null && exitCode !== 0;

		return (
			<LogEntryWrapper
				ts={entry.ts}
				entryId={String(entry.id)}
				taskLabel={taskLabel}
			>
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
		const fromProjectId = entry.fromProjectId;
		const text = getEntryText(entry);
		const isLong = text.length > 100 || text.includes("\n");
		const headerText =
			text.length > 100
				? `${text.slice(0, 100)}…`
				: (text.split("\n")[0] ?? text);

		const titleNode =
			fromProjectId && onProjectNavigate && projectName ? (
				<>
					{"← from "}
					{/* biome-ignore lint/a11y/useKeyWithClickEvents: click-to-navigate */}
					{/* biome-ignore lint/a11y/noStaticElementInteractions: clickable project name */}
					<span
						className="mxd-clickable-task-name"
						onClick={(e) => {
							e.stopPropagation();
							onProjectNavigate(fromProjectId);
						}}
					>
						{projectName}
					</span>
				</>
			) : projectName ? (
				`← from ${projectName}`
			) : (
				"← Cross-Project"
			);

		return (
			<LogEntryWrapper
				ts={entry.ts}
				entryId={String(entry.id)}
				taskLabel={taskLabel}
				taskId={getLogTaskId(entry)}
			>
				<Card
					title={titleNode}
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
				entryId={String(entry.id)}
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

	// thinking — collapsible gray block showing model's reasoning
	if (entry.type === "thinking") {
		const thinkingText = (entry as LogEntry & { thinking: string }).thinking;
		const isRedacted = !thinkingText;
		return (
			<div
				className="mxd-lmxd-entry mxd-event-thinking"
				data-entry-id={String(entry.id)}
			>
				<span className="mxd-lmxd-time">{formatTime(entry.ts)}</span>
				{taskLabel && (
					<span
						className="mxd-lmxd-badge"
						title={"taskId" in entry ? entry.taskId : undefined}
					>
						{taskLabel}
					</span>
				)}
				<Card
					title={isRedacted ? "Thinking (redacted)" : "Thinking"}
					className="mxd-tool-card-thinking"
					defaultExpanded={!isRedacted}
					collapsible={!isRedacted}
				>
					{!isRedacted && (
						<div className="mxd-tool-card-body">
							<div className="mxd-thinking-content">{thinkingText}</div>
						</div>
					)}
				</Card>
			</div>
		);
	}

	// assistant_text — render with optional cache info tooltip
	if (entry.type === "assistant_text") {
		const text = getEntryText(entry);
		const ci = entry.cacheInfo;
		return (
			<div className="mxd-lmxd-entry mxd-event-assistant_text">
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
					{ci && showCacheBadges && <CacheInfoBadge cacheInfo={ci} />}
				</div>
			</div>
		);
	}

	// usage events — not rendered as separate entries (data is attached to assistant_text via cacheInfo)
	if (entry.type === "usage") {
		return null;
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
