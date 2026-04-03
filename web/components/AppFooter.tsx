import { memo } from "react";
import type { TreeNode } from "../hooks.ts";
import { useLocale } from "../i18n.ts";
import { InputBar } from "./InputBar.tsx";
import { IconBack } from "./icons.tsx";

export const AppFooter = memo(function AppFooter({
	projectId,
	targetNodeId,
	rootNodeId,
	nodeMap,
	pendingMessages,
	pendingClarifications,
	clarifyAnswers,
	onSend,
	onClearTarget,
	onClarifySubmit,
	onClarifyAnswerChange,
}: {
	projectId: string;
	targetNodeId: string | null;
	rootNodeId: string | null;
	nodeMap: Map<string, TreeNode>;
	pendingMessages: {
		id: string;
		taskId: string | null;
		text: string;
		timestamp: number;
		images?: Array<{ base64: string; mediaType: string }>;
	}[];
	pendingClarifications: {
		id: string;
		taskId: string;
		question: string;
		title?: string;
		body?: string;
		timestamp: number;
	}[];
	clarifyAnswers: Record<string, string>;
	onSend: (
		message: string,
		images?: { base64: string; mediaType: string }[],
	) => void;
	onClearTarget: () => void;
	onClarifySubmit: (clarificationId: string) => void;
	onClarifyAnswerChange: (clarificationId: string, value: string) => void;
}) {
	const { t } = useLocale();

	return (
		<footer className="mxd-footer">
			{/* Pending clarifications — shown above footer when agent called clarify() */}
			{pendingClarifications.length > 0 && (
				<div className="mxd-clarifications">
					{pendingClarifications.map((c) => {
						const taskTitle = nodeMap.get(c.taskId)?.title ?? c.taskId;
						return (
							<div key={c.id} className="mxd-clarification-card">
								<div className="mxd-clarification-header">
									<span className="mxd-clarification-badge">
										❓ {t("clarify.needed")}
									</span>
									<span className="mxd-clarification-task">
										{t("clarify.from")} {taskTitle}
									</span>
								</div>
								<p className="mxd-clarification-question">
									{c.title ?? c.question}
								</p>
								{c.body && <p className="mxd-clarification-body">{c.body}</p>}
								<form
									className="mxd-clarification-form"
									onSubmit={(e) => {
										e.preventDefault();
										onClarifySubmit(c.id);
									}}
								>
									<input
										type="text"
										className="mxd-clarification-input"
										placeholder={t("clarify.placeholder")}
										value={clarifyAnswers[c.id] ?? ""}
										onChange={(e) =>
											onClarifyAnswerChange(c.id, e.target.value)
										}
										// biome-ignore lint/a11y/noAutofocus: clarification input should grab focus immediately
										autoFocus
									/>
									<button
										type="submit"
										className="mxd-btn-run"
										disabled={!clarifyAnswers[c.id]?.trim()}
									>
										{t("clarify.answer")}
									</button>
								</form>
							</div>
						);
					})}
				</div>
			)}
			{(() => {
				const filtered = pendingMessages.filter((m) =>
					targetNodeId
						? m.taskId === targetNodeId
						: m.taskId === null || m.taskId === rootNodeId,
				);
				return (
					filtered.length > 0 && (
						<div className="mxd-pending-messages">
							<span className="mxd-pending-label">{t("pending.label")}</span>
							{filtered.map((m) => (
								<span key={m.id} className="mxd-pending-chip">
									{m.text.length > 30 ? `${m.text.slice(0, 30)}…` : m.text}
								</span>
							))}
						</div>
					)
				);
			})()}
			{targetNodeId && (
				<div className="mxd-message-target">
					<span className="mxd-message-target-label">
						→ {t("target.sendingTo")}{" "}
						<strong>{nodeMap.get(targetNodeId)?.title ?? targetNodeId}</strong>
					</span>
					<button
						type="button"
						className="mxd-message-target-clear"
						onClick={onClearTarget}
						aria-label={t("target.sendToOrch")}
						title={t("target.sendToOrch")}
					>
						<IconBack size={10} />
					</button>
				</div>
			)}
			<InputBar
				projectId={projectId}
				targetNodeId={targetNodeId}
				nodeMap={nodeMap}
				onSend={onSend}
			/>
		</footer>
	);
});
