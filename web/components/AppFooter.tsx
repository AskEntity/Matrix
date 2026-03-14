import type React from "react";
import { useEffect, useRef } from "react";
import type { TaskNode } from "../hooks.ts";
import { useLocale } from "../i18n.ts";
import { IconPlay, IconSend } from "./icons.tsx";

export function AppFooter({
	running,
	projectId,
	prompt,
	targetNodeId,
	nodeMap,
	pendingMessages,
	pendingClarifications,
	clarifyAnswers,
	onPromptChange,
	onSubmit,
	onClarifySubmit,
	onClarifyAnswerChange,
}: {
	running: boolean;
	projectId: string;
	prompt: string;
	targetNodeId: string | null;
	nodeMap: Map<string, TaskNode>;
	pendingMessages: {
		id: string;
		taskId: string | null;
		text: string;
		timestamp: number;
	}[];
	pendingClarifications: {
		id: string;
		taskId: string;
		question: string;
		timestamp: number;
	}[];
	clarifyAnswers: Record<string, string>;
	onPromptChange: (value: string) => void;
	onSubmit: (e: React.FormEvent) => void;
	onClarifySubmit: (taskId: string) => void;
	onClarifyAnswerChange: (taskId: string, value: string) => void;
}) {
	const { t } = useLocale();
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const composingRef = useRef(false);

	function adjustTextareaHeight() {
		const el = textareaRef.current;
		if (el) {
			el.style.height = "auto";
			el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
		}
	}

	// Auto-resize on any prompt change (typing, paste, programmatic updates).
	// prompt drives textarea value → scrollHeight changes → need to re-measure.
	// biome-ignore lint/correctness/useExhaustiveDependencies: prompt is intentional — it triggers resize when textarea content changes
	useEffect(() => {
		adjustTextareaHeight();
	}, [prompt]);

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
										onClarifySubmit(c.taskId);
									}}
								>
									<input
										type="text"
										className="og-clarification-input"
										placeholder={t("clarify.placeholder")}
										value={clarifyAnswers[c.taskId] ?? ""}
										onChange={(e) =>
											onClarifyAnswerChange(c.taskId, e.target.value)
										}
										// biome-ignore lint/a11y/noAutofocus: clarification input should grab focus immediately
										autoFocus
									/>
									<button
										type="submit"
										className="og-btn-run"
										disabled={!clarifyAnswers[c.taskId]?.trim()}
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
			{running && targetNodeId && (
				<div className="og-message-target">
					<span className="og-message-target-label">
						→ {t("target.sendingTo")}{" "}
						<strong>
							{nodeMap.get(targetNodeId)?.title ?? targetNodeId.slice(0, 8)}
						</strong>
					</span>
				</div>
			)}
			<form className="og-footer-form" onSubmit={onSubmit}>
				<textarea
					ref={textareaRef}
					className="og-prompt-input"
					rows={1}
					value={prompt}
					onChange={(e) => {
						onPromptChange(e.target.value);
						adjustTextareaHeight();
					}}
					onCompositionStart={() => {
						composingRef.current = true;
					}}
					onCompositionEnd={() => {
						setTimeout(() => {
							composingRef.current = false;
						}, 0);
					}}
					onKeyDown={(e) => {
						if (
							e.key === "Enter" &&
							!e.shiftKey &&
							!composingRef.current &&
							!e.nativeEvent.isComposing &&
							e.keyCode !== 229
						) {
							e.preventDefault();
							onSubmit(e);
						}
					}}
					placeholder={
						running && targetNodeId
							? t("footer.messageToTask", {
									task: nodeMap.get(targetNodeId)?.title ?? "task",
								})
							: running
								? t("footer.sendMessage")
								: t("footer.describeBuild")
					}
					disabled={!projectId}
				/>
				<div className="og-footer-controls">
					{running ? (
						<button
							type="submit"
							className="og-btn-run"
							disabled={!projectId || !prompt.trim()}
						>
							<IconSend size={13} />
							{t("footer.send")}
						</button>
					) : (
						<button
							type="submit"
							className="og-btn-run"
							disabled={!projectId || !prompt.trim()}
						>
							<IconPlay size={13} />
							{t("footer.run")}
						</button>
					)}
				</div>
			</form>
		</footer>
	);
}
