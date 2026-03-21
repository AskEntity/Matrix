import { memo } from "react";
import type { TaskNode } from "../hooks.ts";
import { useLocale } from "../i18n.ts";
import { IconHexagon, IconPause, IconTrash } from "./icons.tsx";

export const OrchestratorDetail = memo(function OrchestratorDetail({
	running,
	isRootActive,
	nodes,
	rootNodeId,
	totalCost,
	turns,
	inputTokens,
	cacheCreationTokens,
	cacheReadTokens,
	outputTokens,
	provider,
	model,
	onClearSessions,
	onStop,
}: {
	running: boolean;
	isRootActive: boolean;
	nodes: TaskNode[];
	rootNodeId?: string | null;
	totalCost?: number | null;
	turns?: number | null;
	inputTokens?: number | null;
	cacheCreationTokens?: number | null;
	cacheReadTokens?: number | null;
	outputTokens?: number | null;
	provider?: string | null;
	model?: string | null;
	onClearSessions?: () => void;
	onStop?: () => void;
}) {
	const { t } = useLocale();

	// Exclude the root node from task counts
	const childNodes = rootNodeId
		? nodes.filter((n) => n.id !== rootNodeId)
		: nodes;
	const nodeCount = childNodes.length;
	const passed = childNodes.filter((n) => n.status === "passed").length;
	const done = childNodes.filter(
		(n) => n.status === "passed" || n.status === "closed",
	).length;
	const failed = childNodes.filter(
		(n) => n.status === "failed" || n.status === "stuck",
	).length;
	const inProgress = childNodes.filter(
		(n) => n.status === "in_progress",
	).length;
	return (
		<div className="og-orch-detail">
			<div className="og-orch-detail-header">
				<div className="og-orch-icon-lg">
					<IconHexagon size={18} />
				</div>
				<div style={{ flex: 1 }}>
					<div className="og-orch-name">{t("orch.label")}</div>
					<div className="og-orch-sub">{t("orch.rootSession")}</div>
				</div>
			</div>
			<div className="og-stats-row">
				{provider && (
					<div className="og-stat-card">
						<span className="og-stat-label">{t("orch.provider")}</span>
						<span className="og-stat-value" style={{ fontSize: "12px" }}>
							{provider}
						</span>
					</div>
				)}
				{model && (
					<div className="og-stat-card">
						<span className="og-stat-label">{t("orch.model")}</span>
						<span className="og-stat-value" style={{ fontSize: "12px" }}>
							{model}
						</span>
					</div>
				)}
				<div className="og-stat-card">
					<span className="og-stat-label">{t("orch.tasks")}</span>
					<span className="og-stat-value">{nodeCount}</span>
				</div>
				{nodeCount > 0 && (
					<div className="og-stat-card">
						<span className="og-stat-label">{t("orch.done")}</span>
						<span className="og-stat-value" style={{ fontSize: "14px" }}>
							<span style={{ color: "var(--color-passed)" }}>{done}</span>
							<span style={{ color: "var(--text-faint)", fontWeight: 400 }}>
								{" "}
								/ {nodeCount}
							</span>
						</span>
					</div>
				)}
				{passed > 0 && (
					<div className="og-stat-card">
						<span className="og-stat-label">{t("orch.passed")}</span>
						<span
							className="og-stat-value"
							style={{ color: "var(--color-passed)" }}
						>
							{passed}
						</span>
					</div>
				)}
				{inProgress > 0 && (
					<div className="og-stat-card">
						<span className="og-stat-label">{t("orch.active")}</span>
						<span
							className="og-stat-value"
							style={{ color: "var(--color-in-progress)" }}
						>
							{inProgress}
						</span>
					</div>
				)}
				{failed > 0 && (
					<div className="og-stat-card">
						<span className="og-stat-label">{t("orch.failed")}</span>
						<span
							className="og-stat-value"
							style={{ color: "var(--color-failed)" }}
						>
							{failed}
						</span>
					</div>
				)}
				{totalCost != null && totalCost > 0 && (
					<div className="og-stat-card">
						<span className="og-stat-label">{t("orch.totalCost")}</span>
						<span className="og-stat-value">${totalCost.toFixed(3)}</span>
					</div>
				)}
				{turns != null && turns > 0 && (
					<div className="og-stat-card">
						<span className="og-stat-label">{t("orch.turns")}</span>
						<span className="og-stat-value">{turns}</span>
					</div>
				)}
			</div>
			{(inputTokens != null ||
				cacheCreationTokens != null ||
				cacheReadTokens != null ||
				outputTokens != null) && (
				<div className="og-stats-row" style={{ marginTop: "8px" }}>
					<div className="og-stat-card">
						<span className="og-stat-label">{t("orch.input")}</span>
						<span className="og-stat-value" style={{ fontSize: "13px" }}>
							{(inputTokens ?? 0).toLocaleString()}
						</span>
					</div>
					<div className="og-stat-card">
						<span className="og-stat-label">{t("orch.cacheWrite")}</span>
						<span className="og-stat-value" style={{ fontSize: "13px" }}>
							{(cacheCreationTokens ?? 0).toLocaleString()}
						</span>
					</div>
					<div className="og-stat-card">
						<span className="og-stat-label">{t("orch.cacheRead")}</span>
						<span className="og-stat-value" style={{ fontSize: "13px" }}>
							{(cacheReadTokens ?? 0).toLocaleString()}
						</span>
					</div>
					<div className="og-stat-card">
						<span className="og-stat-label">{t("orch.output")}</span>
						<span className="og-stat-value" style={{ fontSize: "13px" }}>
							{(outputTokens ?? 0).toLocaleString()}
						</span>
					</div>
				</div>
			)}
			<div
				style={{
					marginTop: "12px",
					display: "flex",
					gap: "8px",
					alignItems: "center",
				}}
			>
				{isRootActive && onStop && (
					<button
						type="button"
						className="og-btn og-btn-sm og-btn-ghost"
						onClick={onStop}
					>
						<IconPause size={12} />
						{t("orch.pause")}
					</button>
				)}
				{!running && onClearSessions && (
					<button
						type="button"
						className="og-btn og-btn-sm og-btn-ghost"
						onClick={onClearSessions}
					>
						<IconTrash size={12} />
						{t("orch.clearSessions")}
					</button>
				)}
			</div>
		</div>
	);
});
