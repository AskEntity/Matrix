import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskNode } from "../hooks.ts";
import { useLocale } from "../i18n.ts";
import { IconClose, IconSend } from "./icons.tsx";

const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

export function InputBar({
	projectId,
	targetNodeId,
	nodeMap,
	onSend,
}: {
	projectId: string;
	targetNodeId: string | null;
	nodeMap: Map<string, TaskNode>;
	onSend: (
		message: string,
		images?: { base64: string; mediaType: string }[],
	) => void;
}) {
	const { t } = useLocale();
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const composingRef = useRef(false);

	const [prompt, setPrompt] = useState(
		() => localStorage.getItem("og-prompt-draft") ?? "",
	);
	const [attachedImages, setAttachedImages] = useState<
		{ base64: string; mediaType: string }[]
	>([]);

	// localStorage draft save with 2s debounce
	useEffect(() => {
		const timer = setTimeout(() => {
			if (prompt) localStorage.setItem("og-prompt-draft", prompt);
			else localStorage.removeItem("og-prompt-draft");
		}, 2000);
		return () => clearTimeout(timer);
	}, [prompt]);

	// Save draft on page unload
	useEffect(() => {
		const handler = () => {
			if (prompt) localStorage.setItem("og-prompt-draft", prompt);
		};
		window.addEventListener("beforeunload", handler);
		return () => window.removeEventListener("beforeunload", handler);
	}, [prompt]);

	function adjustTextareaHeight() {
		const el = textareaRef.current;
		if (el) {
			el.style.height = "auto";
			el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
		}
	}

	// Auto-resize on prompt change
	// biome-ignore lint/correctness/useExhaustiveDependencies: prompt is intentional — it triggers resize when textarea content changes
	useEffect(() => {
		adjustTextareaHeight();
	}, [prompt]);

	function handleFileToBase64(file: File) {
		if (file.size > MAX_IMAGE_SIZE_BYTES) return;
		const reader = new FileReader();
		reader.onload = () => {
			const base64 = (reader.result as string).split(",")[1];
			if (base64) {
				setAttachedImages((prev) => [
					...prev,
					{ base64, mediaType: file.type },
				]);
			}
		};
		reader.readAsDataURL(file);
	}

	const handleSubmit = useCallback(
		(e: React.FormEvent | React.KeyboardEvent) => {
			e.preventDefault();
			if (!prompt.trim() || !projectId) return;
			const images = attachedImages.length > 0 ? attachedImages : undefined;
			onSend(prompt.trim(), images);
			setPrompt("");
			setAttachedImages([]);
			localStorage.removeItem("og-prompt-draft");
		},
		[prompt, attachedImages, projectId, onSend],
	);

	return (
		<form className="og-footer-form" onSubmit={handleSubmit}>
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
								onClick={() =>
									setAttachedImages((prev) =>
										prev.filter((_, idx) => idx !== i),
									)
								}
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
					setPrompt(e.target.value);
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
						handleSubmit(e);
					}
				}}
				placeholder={
					targetNodeId
						? t("footer.messageToTask", {
								task: nodeMap.get(targetNodeId)?.title ?? "task",
							})
						: t("footer.sendMessage")
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
	);
}
