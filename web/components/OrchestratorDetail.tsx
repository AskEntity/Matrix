import { memo } from "react";
import { isTask, type TreeNode } from "../hooks.ts";
import { useLocale } from "../i18n.ts";
import { IconHexagon, IconPause, IconTrash } from "./icons.tsx";

export const OrchestratorDetail = memo(function OrchestratorDetail({
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
	onClearSession,
	onStop,
}: {
	isRootActive: boolean;
	nodes: TreeNode[];
	rootNodeId?: string | null;
	totalCost?: number | null;
	turns?: number | null;
	inputTokens?: number | null;
	cacheCreationTokens?: number | null;
	cacheReadTokens?: number | null;
	outputTokens?: number | null;
	provider?: string | null;
	model?: string | null;
	onClearSession?: () => void;
	onStop?: () => void;
}) {
	const { t } = useLocale();

	// Exclude the root node from task counts
	const childNodes = rootNodeId
		? nodes.filter((n) => n.id !== rootNodeId)
		: nodes;
	const nodeCount = childNodes.length;
	const passed = childNodes.filter(
		(n) => isTask(n) && n.status === "verify",
	).length;
	const done = childNodes.filter(
		(n) => isTask(n) && (n.status === "verify" || n.status === "closed"),
	).length;
	const failed = childNodes.filter(
		(n) => isTask(n) && n.status === "failed",
	).length;
	const inProgress = childNodes.filter(
		(n) => isTask(n) && n.status === "in_progress",
	).length;
	return (
		<div className="mxd-orch-detail">
			<div className="mxd-orch-detail-header">
				<div className="mxd-orch-icon-lg">
					<IconHexagon size={18} />
				</div>
				<div style={{ flex: 1 }}>
					<div className="mxd-orch-name">{t("orch.label")}</div>
					<div className="mxd-orch-sub">{t("orch.rootSession")}</div>
				</div>
			</div>
			<div className="mxd-stats-row">
				{provider && (
					<div className="mxd-stat-card">
						<span className="mxd-stat-label">{t("orch.provider")}</span>
						<span className="mxd-stat-value" style={{ fontSize: "12px" }}>
							{provider}
						</span>
					</div>
				)}
				{model && (
					<div className="mxd-stat-card">
						<span className="mxd-stat-label">{t("orch.model")}</span>
						<span className="mxd-stat-value" style={{ fontSize: "12px" }}>
							{model}
						</span>
					</div>
				)}
				<div className="mxd-stat-card">
					<span className="mxd-stat-label">{t("orch.tasks")}</span>
					<span className="mxd-stat-value">{nodeCount}</span>
				</div>
				{nodeCount > 0 && (
					<div className="mxd-stat-card">
						<span className="mxd-stat-label">{t("orch.done")}</span>
						<span className="mxd-stat-value" style={{ fontSize: "14px" }}>
							<span style={{ color: "var(--color-passed)" }}>{done}</span>
							<span style={{ color: "var(--text-faint)", fontWeight: 400 }}>
								{" "}
								/ {nodeCount}
							</span>
						</span>
					</div>
				)}
				{passed > 0 && (
					<div className="mxd-stat-card">
						<span className="mxd-stat-label">{t("orch.passed")}</span>
						<span
							className="mxd-stat-value"
							style={{ color: "var(--color-passed)" }}
						>
							{passed}
						</span>
					</div>
				)}
				{inProgress > 0 && (
					<div className="mxd-stat-card">
						<span className="mxd-stat-label">{t("orch.active")}</span>
						<span
							className="mxd-stat-value"
							style={{ color: "var(--color-in-progress)" }}
						>
							{inProgress}
						</span>
					</div>
				)}
				{failed > 0 && (
					<div className="mxd-stat-card">
						<span className="mxd-stat-label">{t("orch.failed")}</span>
						<span
							className="mxd-stat-value"
							style={{ color: "var(--color-failed)" }}
						>
							{failed}
						</span>
					</div>
				)}
				{totalCost != null && totalCost > 0 && (
					<div className="mxd-stat-card">
						<span className="mxd-stat-label">{t("orch.totalCost")}</span>
						<span className="mxd-stat-value">${totalCost.toFixed(3)}</span>
					</div>
				)}
				{turns != null && turns > 0 && (
					<div className="mxd-stat-card">
						<span className="mxd-stat-label">{t("orch.turns")}</span>
						<span className="mxd-stat-value">{turns}</span>
					</div>
				)}
			</div>
			{(inputTokens != null ||
				cacheCreationTokens != null ||
				cacheReadTokens != null ||
				outputTokens != null) && (
				<div className="mxd-stats-row" style={{ marginTop: "8px" }}>
					<div className="mxd-stat-card">
						<span className="mxd-stat-label">{t("orch.input")}</span>
						<span className="mxd-stat-value" style={{ fontSize: "13px" }}>
							{(inputTokens ?? 0).toLocaleString()}
						</span>
					</div>
					<div className="mxd-stat-card">
						<span className="mxd-stat-label">{t("orch.cacheWrite")}</span>
						<span className="mxd-stat-value" style={{ fontSize: "13px" }}>
							{(cacheCreationTokens ?? 0).toLocaleString()}
						</span>
					</div>
					<div className="mxd-stat-card">
						<span className="mxd-stat-label">{t("orch.cacheRead")}</span>
						<span className="mxd-stat-value" style={{ fontSize: "13px" }}>
							{(cacheReadTokens ?? 0).toLocaleString()}
						</span>
					</div>
					<div className="mxd-stat-card">
						<span className="mxd-stat-label">{t("orch.output")}</span>
						<span className="mxd-stat-value" style={{ fontSize: "13px" }}>
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
						className="mxd-btn mxd-btn-sm mxd-btn-ghost"
						onClick={onStop}
					>
						<IconPause size={12} />
						{t("orch.pause")}
					</button>
				)}
				{!isRootActive && onClearSession && (
					<button
						type="button"
						className="mxd-btn mxd-btn-sm mxd-btn-ghost"
						onClick={onClearSession}
					>
						<IconTrash size={12} />
						{t("detail.clearSession")}
					</button>
				)}
			</div>
		</div>
	);
});
