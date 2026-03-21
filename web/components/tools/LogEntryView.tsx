import { memo, useState } from "react";
import {
	formatTime,
	getLogTaskId,
	type LogEntry,
	type TaskNode,
} from "../../hooks.ts";
import { useLocale } from "../../i18n.ts";
import { IconChevron } from "../icons.tsx";
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

/** Reusable card for parent_update, child_report, cross_project messages */
function QueueMessageCard({
	entry,
	icon,
	label,
	cardClass,
	taskLabel,
}: {
	entry: LogEntry;
	icon: string;
	label: string;
	cardClass: string;
	taskLabel: string | null;
}) {
	const [expanded, setExpanded] = useState(false);
	const text = getEntryText(entry);
	const isLong = text.length > 100 || text.includes("\n");
	const headerText =
		text.length > 100
			? `${text.slice(0, 100)}…`
			: (text.split("\n")[0] ?? text);
	const header = `${icon ? `${icon} ` : ""}${label}`;

	return (
		<div className="og-log-entry og-event-tool_card">
			<span className="og-log-time">{formatTime(entry.ts)}</span>
			{taskLabel && (
				<span className="og-log-badge" title={getLogTaskId(entry)}>
					{taskLabel}
				</span>
			)}
			<div className={`og-tool-card ${cardClass}`}>
				{isLong ? (
					<button
						type="button"
						className="og-tool-card-header"
						onClick={() => setExpanded(!expanded)}
					>
						<span className="og-tool-card-name">{header}</span>
						<span className="og-tool-card-detail">{headerText}</span>
						<span className="og-tool-card-toggle">
							<IconChevron size={10} expanded={expanded} />
						</span>
					</button>
				) : (
					<div className="og-tool-card-header">
						<span className="og-tool-card-name">{header}</span>
						<span className="og-tool-card-detail">{text}</span>
					</div>
				)}
				{expanded && isLong && (
					<div className="og-tool-card-body">
						<div className="og-tool-card-result">{text.trim()}</div>
					</div>
				)}
			</div>
		</div>
	);
}

export const LogEntryView = memo(function LogEntryView({
	entry,
	nodeMap,
}: {
	entry: LogEntry;
	nodeMap: Map<string, TaskNode>;
}) {
	const [expanded, setExpanded] = useState(false);
	const taskLabel = null;

	const { t } = useLocale();

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

	// Standalone tool_use (not merged with result) — show as a card too
	if (entry.type === "tool_call") {
		const toolName = getToolName(entry);
		// Suppress done() tool_use card — task_completed card replaces it
		if (toolName === "mcp__opengraft__done") return null;
		const toolArgs = entry.input;
		const argsStr = formatArgs(toolArgs, bashBgExcludeKeys(toolName, toolArgs));
		const isMcp = toolName.startsWith("mcp__opengraft__");
		const isYield = toolName === "mcp__opengraft__yield";
		// Yield gets a calm "waiting" card — no spinner/pulse since it's idle, not loading
		if (isYield) {
			return (
				<div className="og-log-entry og-event-tool_card">
					<span className="og-log-time">{formatTime(entry.ts)}</span>
					{taskLabel && (
						<span className="og-log-badge" title={getLogTaskId(entry)}>
							{taskLabel}
						</span>
					)}
					<div className="og-tool-card og-tool-card-yield-waiting og-tool-card-mcp">
						<div className="og-tool-card-header">
							<span className="og-tool-card-name">⏸ {t("tool.waiting")}</span>
						</div>
					</div>
				</div>
			);
		}
		return (
			<div className="og-log-entry og-event-tool_card">
				<span className="og-log-time">{formatTime(entry.ts)}</span>
				{taskLabel && (
					<span className="og-log-badge" title={getLogTaskId(entry)}>
						{taskLabel}
					</span>
				)}
				<div
					className={`og-tool-card og-tool-card-pending og-tool-card-loading ${isMcp ? "og-tool-card-mcp" : ""}`}
				>
					<div className="og-tool-card-header">
						<span className="og-tool-card-name">
							{getToolCardTitle(toolName, toolArgs, null, nodeMap)}
						</span>
						<span className="og-tool-card-status pending">
							<span className="og-spinner" />
						</span>
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
		const toolName = getToolName(entry);
		// Suppress done() tool_result card — task_completed card replaces it
		if (toolName === "mcp__opengraft__done") return null;
		const content = entry.content;
		const isErr = entry.isError;
		const isOk = !isErr;
		const mcpFormatted = isOk
			? formatMcpToolResult(toolName, content, t)
			: null;
		const isMcp = toolName.startsWith("mcp__opengraft__");
		const statusClass = isErr ? "og-tool-card-err" : "og-tool-card-ok";
		return (
			<div className="og-log-entry og-event-tool_card">
				<span className="og-log-time">{formatTime(entry.ts)}</span>
				{taskLabel && (
					<span className="og-log-badge" title={getLogTaskId(entry)}>
						{taskLabel}
					</span>
				)}
				<div
					className={`og-tool-card ${statusClass} ${isMcp ? "og-tool-card-mcp" : ""}`}
				>
					<div className="og-tool-card-header">
						<span className="og-tool-card-name">
							{getToolCardTitle(toolName, undefined, content, nodeMap)}
						</span>
						{toolName !== "mcp__opengraft__done" && (
							<span className={`og-tool-card-status ${isErr ? "err" : "ok"}`}>
								{isErr ? "✗" : "✓"}
							</span>
						)}
					</div>
					{content && !isTitleOnlyCard(toolName) && (
						<div className="og-tool-card-body">
							<div className="og-tool-card-result">
								{mcpFormatted ?? content}
							</div>
						</div>
					)}
					{entry.images && entry.images.length > 0 && (
						<div className="og-tool-card-body">
							<ToolResultImages images={entry.images} />
						</div>
					)}
				</div>
			</div>
		);
	}

	// task_started — card-like rendering
	if (entry.type === "task_started") {
		return (
			<div className="og-log-entry og-event-tool_card">
				<span className="og-log-time">{formatTime(entry.ts)}</span>
				{taskLabel && (
					<span className="og-log-badge" title={entry.taskId}>
						{taskLabel}
					</span>
				)}
				<div className="og-tool-card og-tool-card-pending">
					<div className="og-tool-card-header">
						<span className="og-tool-card-name">
							▶ {t("lifecycle.taskStarted")} {entry.title}
						</span>
					</div>
				</div>
			</div>
		);
	}

	// task_completed — styled card with green/red border, badge, collapsible output
	if (entry.type === "task_completed") {
		const title = entry.title;
		const success = entry.success;
		const output = entry.output ?? "";
		const hasOutput = output.length > 0;
		const borderClass = success
			? "og-tool-card-done-passed"
			: "og-tool-card-done-failed";

		return (
			<div className="og-log-entry og-event-tool_card">
				<span className="og-log-time">{formatTime(entry.ts)}</span>
				{taskLabel && (
					<span className="og-log-badge" title={entry.taskId}>
						{taskLabel}
					</span>
				)}
				<div className={`og-tool-card ${borderClass}`}>
					{hasOutput ? (
						<button
							type="button"
							className="og-tool-card-header"
							onClick={() => setExpanded(!expanded)}
						>
							<span className="og-tool-card-name">
								{success ? "✓" : "✗"} {title}
							</span>
							<span
								className={`og-mcp-done-status ${success ? "og-mcp-done-passed" : "og-mcp-done-failed"}`}
							>
								{success ? "Passed" : "Failed"}
							</span>
							<span className="og-tool-card-toggle">
								<IconChevron size={10} expanded={expanded} />
							</span>
						</button>
					) : (
						<div className="og-tool-card-header">
							<span className="og-tool-card-name">
								{success ? "✓" : "✗"} {title}
							</span>
							<span
								className={`og-mcp-done-status ${success ? "og-mcp-done-passed" : "og-mcp-done-failed"}`}
							>
								{success ? "Passed" : "Failed"}
							</span>
						</div>
					)}
					{expanded && hasOutput && (
						<div className="og-tool-card-body">
							<div className="og-tool-card-result">{output}</div>
						</div>
					)}
				</div>
			</div>
		);
	}

	if (entry.type === "tree_mutation") {
		const text = entry.title ? `${entry.action}: ${entry.title}` : entry.action;
		return (
			<div className="og-log-entry og-event-tool_card">
				<span className="og-log-time">{formatTime(entry.ts)}</span>
				<div className="og-tool-card og-tool-card-system">
					<div className="og-tool-card-header">
						<span className="og-tool-card-name">🌿 {t("log.treeUpdated")}</span>
						<span className="og-tool-card-detail">{text}</span>
					</div>
				</div>
			</div>
		);
	}

	if (entry.type === "parent_update") {
		return (
			<QueueMessageCard
				entry={entry}
				icon="←"
				label="Parent"
				cardClass="og-tool-card-parent"
				taskLabel={taskLabel}
			/>
		);
	}

	if (entry.type === "child_report") {
		const childTitle = entry.title ?? "";
		const summary = entry.summary ?? "";
		const label = summary
			? `↑ ${summary}`
			: childTitle
				? `↑ from ${childTitle}`
				: "↑ Child Report";
		return (
			<QueueMessageCard
				entry={entry}
				icon=""
				label={label}
				cardClass="og-tool-card-child-report"
				taskLabel={taskLabel}
			/>
		);
	}

	if (entry.type === "background_complete") {
		const command = entry.command;
		const exitCode = entry.exitCode;
		const durationMs = entry.durationMs;
		const cmdDisplay =
			command.length > 50 ? `${command.slice(0, 50)}…` : command;
		const detail = [
			exitCode != null ? `exit ${exitCode}` : "",
			durationMs ? `${durationMs}ms` : "",
		]
			.filter(Boolean)
			.join(" · ");
		return (
			<div className="og-log-entry og-event-tool_card">
				<span className="og-log-time">{formatTime(entry.ts)}</span>
				<div className="og-tool-card og-tool-card-bg-complete">
					<div className="og-tool-card-header">
						<span className="og-tool-card-name">
							⚙ Background Complete{cmdDisplay ? `: ${cmdDisplay}` : ""}
						</span>
						{detail && <span className="og-tool-card-detail">{detail}</span>}
					</div>
				</div>
			</div>
		);
	}

	if (entry.type === "cross_project") {
		const projectName = entry.fromProjectName ?? "";
		const label = projectName ? `← from ${projectName}` : "← Cross-Project";
		return (
			<QueueMessageCard
				entry={entry}
				icon=""
				label={label}
				cardClass="og-tool-card-cross-project"
				taskLabel={taskLabel}
			/>
		);
	}

	if (entry.type === "generic_queue_message") {
		const text = entry.content;
		const sourceLabel = entry.source ? `[${entry.source}]` : "";
		const isLong = text.length > 100 || text.includes("\n");
		const headerText =
			text.length > 100
				? `${text.slice(0, 100)}…`
				: (text.split("\n")[0] ?? text);
		return (
			<div className="og-log-entry og-event-tool_card">
				<span className="og-log-time">{formatTime(entry.ts)}</span>
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
								<span className="og-tool-card-name">
									{sourceLabel} {headerText}
								</span>
								<span className="og-tool-card-toggle">
									<IconChevron size={10} expanded={expanded} />
								</span>
							</button>
							{expanded && (
								<div className="og-mcp-body">
									<div className="og-mcp-task-desc">{text}</div>
								</div>
							)}
						</>
					) : (
						<div className="og-tool-card-header">
							<span className="og-tool-card-name">
								{sourceLabel} {headerText}
							</span>
						</div>
					)}
				</div>
			</div>
		);
	}

	if (entry.type === "message" || entry.type === "user_message") {
		return (
			<div className="og-log-entry og-event-user_message">
				<span className="og-log-time">{formatTime(entry.ts)}</span>
				<div className="og-user-prompt-bubble">
					<span className="og-user-prompt-text">{entry.content ?? ""}</span>
					{entry.images &&
						(entry.images as Array<{ base64: string; mediaType: string }>)
							.length > 0 && (
							<div className="og-user-images">
								{(
									entry.images as Array<{ base64: string; mediaType: string }>
								).map((img: { base64: string; mediaType: string }) => (
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
								))}
							</div>
						)}
				</div>
			</div>
		);
	}

	if (entry.type === "error") {
		return (
			<div className="og-log-entry og-event-error">
				<span className="og-log-time">{formatTime(entry.ts)}</span>
				{taskLabel && (
					<span className="og-log-badge" title={entry.taskId}>
						{taskLabel}
					</span>
				)}
				<div className="og-log-body">
					<span className="og-log-text">{entry.message}</span>
				</div>
			</div>
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
