import type { TaskNode } from "../hooks.ts";
import { useLocale } from "../i18n.ts";
import { InputBar } from "./InputBar.tsx";
import { IconClose } from "./icons.tsx";

export function AppFooter({
	projectId,
	targetNodeId,
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
	nodeMap: Map<string, TaskNode>;
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
		<footer className="og-footer">
			{/* Pending clarifications — shown above footer when agent called clarify() */}
			{pendingClarifications.length > 0 && (
				<div className="og-clarifications">
					{pendingClarifications.map((c) => {
						const taskTitle =
							nodeMap.get(c.taskId)?.title ?? c.taskId.slice(0, 8);
						return (
							<div key={c.id} className="og-clarification-card">
								<div className="og-clarification-header">
									<span className="og-clarification-badge">
										❓ {t("clarify.needed")}
									</span>
									<span className="og-clarification-task">
										{t("clarify.from")} {taskTitle}
									</span>
								</div>
								<p className="og-clarification-question">{c.question}</p>
								<form
									className="og-clarification-form"
									onSubmit={(e) => {
										e.preventDefault();
										onClarifySubmit(c.id);
									}}
								>
									<input
										type="text"
										className="og-clarification-input"
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
										className="og-btn-run"
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
					targetNodeId ? m.taskId === targetNodeId : m.taskId === null,
				);
				return (
					filtered.length > 0 && (
						<div className="og-pending-messages">
							<span className="og-pending-label">{t("pending.label")}</span>
							{filtered.map((m) => (
								<span key={m.id} className="og-pending-chip">
									{m.text.length > 30 ? `${m.text.slice(0, 30)}…` : m.text}
								</span>
							))}
						</div>
					)
				);
			})()}
			{targetNodeId && (
				<div className="og-message-target">
					<span className="og-message-target-label">
						→ {t("target.sendingTo")}{" "}
						<strong>
							{nodeMap.get(targetNodeId)?.title ?? targetNodeId.slice(0, 8)}
						</strong>
					</span>
					<button
						type="button"
						className="og-message-target-clear"
						onClick={onClearTarget}
						aria-label={t("target.sendToOrch")}
						title={t("target.sendToOrch")}
					>
						<IconClose size={10} />
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
}
