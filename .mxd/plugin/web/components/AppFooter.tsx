import { memo } from "react";
import type { TreeNode } from "../hooks.ts";
import { useLocale } from "../i18n.ts";
import {
	type EditRequest,
	type ImageDropRequest,
	InputBar,
	type QuoteRequest,
} from "./InputBar.tsx";

export const AppFooter = memo(function AppFooter({
	projectId,
	targetNodeId,
	nodeMap,
	pendingMessages,
	pendingClarifications,
	clarifyAnswers,
	onSend,
	onClarifySubmit,
	onClarifyAnswerChange,
	quoteRequest,
	imageDropRequest,
	editRequest,
	onCancelEdit,
	onScrollToEditing,
	agentRunning,
	onInterrupt,
}: {
	projectId: string;
	targetNodeId: string | null;
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
	onClarifySubmit: (clarificationId: string) => void;
	onClarifyAnswerChange: (clarificationId: string, value: string) => void;
	quoteRequest?: QuoteRequest | null;
	imageDropRequest?: ImageDropRequest | null;
	editRequest?: EditRequest | null;
	onCancelEdit?: () => void;
	/** Click the "editing" indicator to jump to that message in the log. */
	onScrollToEditing?: () => void;
	/** The agent this composer targets is working right now. */
	agentRunning?: boolean;
	/** End the current turn. Leaves the session — and the queue — alive. */
	onInterrupt?: () => void;
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
				// Root is a regular task — targetNodeId resolves to the root id in the
				// root view, to the sub-task id in sub-task views. One filter path,
				// direct id comparison. Null targetNodeId (pre-useTasks transient)
				// matches no messages → banner empty until rootNodeId populates.
				const filtered = pendingMessages.filter(
					(m) => m.taskId === targetNodeId,
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
			<InputBar
				projectId={projectId}
				targetNodeId={targetNodeId}
				nodeMap={nodeMap}
				onSend={onSend}
				quoteRequest={quoteRequest}
				imageDropRequest={imageDropRequest}
				editRequest={editRequest}
				onCancelEdit={onCancelEdit}
				onScrollToEditing={onScrollToEditing}
				agentRunning={agentRunning}
				onInterrupt={onInterrupt}
			/>
		</footer>
	);
});
