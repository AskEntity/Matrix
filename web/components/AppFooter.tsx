import type React from "react";
import { useEffect, useRef } from "react";
import type { TaskNode } from "../hooks.ts";
import { useLocale } from "../i18n.ts";
import { IconClose, IconSend } from "./icons.tsx";

const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

export function AppFooter({
	running,
	projectId,
	prompt,
	targetNodeId,
	nodeMap,
	pendingCompact,
	pendingMessages,
	pendingClarifications,
	clarifyAnswers,
	attachedImages,
	onPromptChange,
	onSubmit,
	onImageAttach,
	onImageRemove,
	onClearTarget,
	onClarifySubmit,
	onClarifyAnswerChange,
}: {
	running: boolean;
	projectId: string;
	prompt: string;
	targetNodeId: string | null;
	nodeMap: Map<string, TaskNode>;
	pendingCompact: boolean;
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
	attachedImages: { base64: string; mediaType: string }[];
	onPromptChange: (value: string) => void;
	onSubmit: (e: React.FormEvent) => void;
	onImageAttach: (img: { base64: string; mediaType: string }) => void;
	onImageRemove: (index: number) => void;
	onClearTarget: () => void;
	onClarifySubmit: (clarificationId: string) => void;
	onClarifyAnswerChange: (clarificationId: string, value: string) => void;
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

	function handleFileToBase64(file: File) {
		if (file.size > MAX_IMAGE_SIZE_BYTES) {
			// Silently ignore files that are too large — could add toast later
			return;
		}
		const reader = new FileReader();
		reader.onload = () => {
			const base64 = (reader.result as string).split(",")[1];
			if (base64) {
				onImageAttach({ base64, mediaType: file.type });
			}
		};
		reader.readAsDataURL(file);
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
				const hasChips = filtered.length > 0 || pendingCompact;
				return (
					hasChips && (
						<div className="og-pending-messages">
							<span className="og-pending-label">{t("pending.label")}</span>
							{pendingCompact && (
								<span className="og-pending-chip">
									⏳ {t("footer.compactPending")}
								</span>
							)}
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
			<form className="og-footer-form" onSubmit={onSubmit}>
				{/* Image preview thumbnails */}
				{attachedImages.length > 0 && (
					<div className="og-image-previews">
						{attachedImages.map((img, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: images have no natural unique ID
							<div key={`${img.mediaType}-${i}`} className="og-image-preview">
								<img
									src={`data:${img.mediaType};base64,${img.base64}`}
									alt={`Attachment ${i + 1}`}
								/>
								<button
									type="button"
									className="og-image-preview-remove"
									onClick={() => onImageRemove(i)}
									aria-label="Remove image"
								>
									<IconClose size={10} />
								</button>
							</div>
						))}
					</div>
				)}
				<textarea
					ref={textareaRef}
					className="og-prompt-input"
					rows={1}
					value={prompt}
					onChange={(e) => {
						onPromptChange(e.target.value);
						adjustTextareaHeight();
					}}
					onPaste={(e) => {
						const items = e.clipboardData?.items;
						if (!items) return;
						for (const item of items) {
							if (item.type.startsWith("image/")) {
								e.preventDefault();
								const file = item.getAsFile();
								if (file) handleFileToBase64(file);
							}
						}
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
						targetNodeId
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
					<button
						type="submit"
						className="og-btn-run"
						disabled={!projectId || !prompt.trim()}
					>
						<IconSend size={13} />
						{t("footer.send")}
					</button>
				</div>
			</form>
		</footer>
	);
}
