import type React from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TreeNode } from "../hooks.ts";
import { useLocale } from "../i18n.ts";
import { IconClose, IconImage, IconSend } from "./icons.tsx";
import { SLASH_COMMANDS, SlashCommandMenu } from "./SlashCommandMenu.tsx";

const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

function draftKey(nodeId: string | null) {
	return nodeId ? `mxd-prompt-draft:${nodeId}` : "mxd-prompt-draft";
}

export const InputBar = memo(function InputBar({
	projectId,
	targetNodeId,
	nodeMap,
	onSend,
}: {
	projectId: string;
	targetNodeId: string | null;
	nodeMap: Map<string, TreeNode>;
	onSend: (
		message: string,
		images?: { base64: string; mediaType: string }[],
	) => void;
}) {
	const { t } = useLocale();
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const composingRef = useRef(false);

	const [prompt, setPrompt] = useState(
		() => localStorage.getItem(draftKey(targetNodeId)) ?? "",
	);
	const [attachedImages, setAttachedImages] = useState<
		{ base64: string; mediaType: string }[]
	>([]);

	// When targetNodeId changes, save current draft and load new task's draft
	const prevTargetRef = useRef(targetNodeId);
	const targetRef = useRef(targetNodeId);
	targetRef.current = targetNodeId;
	useEffect(() => {
		if (prevTargetRef.current === targetNodeId) return;
		// Save current draft for previous target
		setPrompt((currentPrompt) => {
			const prevKey = draftKey(prevTargetRef.current);
			if (currentPrompt) localStorage.setItem(prevKey, currentPrompt);
			else localStorage.removeItem(prevKey);
			return localStorage.getItem(draftKey(targetNodeId)) ?? "";
		});
		prevTargetRef.current = targetNodeId;
	}, [targetNodeId]);

	// Slash command autocomplete state
	const [slashMenuOpen, setSlashMenuOpen] = useState(false);
	const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);

	// Compute filtered commands from prompt
	const slashFilteredCommands = useMemo(() => {
		if (!prompt.startsWith("/")) return [];
		const filter = prompt.slice(1).toLowerCase();
		return SLASH_COMMANDS.filter((cmd) => cmd.name.startsWith(filter));
	}, [prompt]);

	// Open/close menu based on prompt
	useEffect(() => {
		if (!prompt.startsWith("/") || slashFilteredCommands.length === 0) {
			setSlashMenuOpen(false);
			return;
		}
		// Don't show menu if prompt exactly matches a command (user already selected)
		const filter = prompt.slice(1).toLowerCase();
		const isExactMatch =
			slashFilteredCommands.length === 1 &&
			slashFilteredCommands[0]?.name === filter;
		if (isExactMatch) {
			setSlashMenuOpen(false);
		} else {
			setSlashMenuOpen(true);
			setSlashSelectedIndex(0);
		}
	}, [prompt, slashFilteredCommands]);

	// localStorage draft save with 2s debounce.
	// Uses targetRef (not targetNodeId in deps) to avoid saving stale prompt
	// to wrong task key during the render where targetNodeId changed but
	// setPrompt hasn't taken effect yet.
	useEffect(() => {
		const timer = setTimeout(() => {
			const key = draftKey(targetRef.current);
			if (prompt) localStorage.setItem(key, prompt);
			else localStorage.removeItem(key);
		}, 2000);
		return () => clearTimeout(timer);
	}, [prompt]);

	// Save draft on page unload
	useEffect(() => {
		const handler = () => {
			const key = draftKey(targetRef.current);
			if (prompt) localStorage.setItem(key, prompt);
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

	const handleSlashSelect = useCallback((cmd: { name: string }) => {
		setPrompt(`/${cmd.name}`);
		setSlashMenuOpen(false);
		textareaRef.current?.focus();
	}, []);

	const handleSubmit = useCallback(
		(e: React.FormEvent | React.KeyboardEvent) => {
			e.preventDefault();
			if (!prompt.trim() || !projectId) return;
			const images = attachedImages.length > 0 ? attachedImages : undefined;
			onSend(prompt.trim(), images);
			setPrompt("");
			setAttachedImages([]);
			localStorage.removeItem(draftKey(targetRef.current));
		},
		[prompt, attachedImages, projectId, onSend],
	);

	return (
		<form className="mxd-footer-form" onSubmit={handleSubmit}>
			{/* Image preview thumbnails */}
			{attachedImages.length > 0 && (
				<div className="mxd-image-previews">
					{attachedImages.map((img, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: images have no natural unique ID
						<div key={`${img.mediaType}-${i}`} className="mxd-image-preview">
							<img
								src={`data:${img.mediaType};base64,${img.base64}`}
								alt={`Attachment ${i + 1}`}
							/>
							<button
								type="button"
								className="mxd-image-preview-remove"
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
			{/* Slash command menu — positioned above the form */}
			{slashMenuOpen && (
				<SlashCommandMenu
					commands={slashFilteredCommands}
					selectedIndex={slashSelectedIndex}
					onSelect={handleSlashSelect}
				/>
			)}
			<textarea
				ref={textareaRef}
				className="mxd-prompt-input"
				rows={1}
				value={prompt}
				onChange={(e) => {
					setPrompt(e.target.value);
					adjustTextareaHeight();
				}}
				onBlur={() => setSlashMenuOpen(false)}
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
					// Slash menu keyboard navigation
					if (slashMenuOpen && slashFilteredCommands.length > 0) {
						if (e.key === "ArrowUp") {
							e.preventDefault();
							setSlashSelectedIndex((prev) =>
								prev <= 0 ? slashFilteredCommands.length - 1 : prev - 1,
							);
							return;
						}
						if (e.key === "ArrowDown") {
							e.preventDefault();
							setSlashSelectedIndex((prev) =>
								prev >= slashFilteredCommands.length - 1 ? 0 : prev + 1,
							);
							return;
						}
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							const cmd = slashFilteredCommands[slashSelectedIndex];
							if (cmd) handleSlashSelect(cmd);
							return;
						}
						if (e.key === "Escape") {
							e.preventDefault();
							setSlashMenuOpen(false);
							return;
						}
					}

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
			<div className="mxd-footer-controls">
				<input
					ref={fileInputRef}
					type="file"
					accept="image/*"
					multiple
					hidden
					onChange={(e) => {
						const files = e.target.files;
						if (files) {
							for (const file of files) {
								handleFileToBase64(file);
							}
						}
						// Reset so the same file can be re-selected
						e.target.value = "";
					}}
				/>
				<button
					type="button"
					className="mxd-btn-attach"
					onClick={() => fileInputRef.current?.click()}
					disabled={!projectId}
					aria-label={t("footer.attachImage")}
					title={t("footer.attachImage")}
				>
					<IconImage size={14} />
				</button>
				<button
					type="submit"
					className="mxd-btn-run"
					disabled={!projectId || !prompt.trim()}
				>
					<IconSend size={13} />
					<span className="mxd-btn-run-label">{t("footer.send")}</span>
				</button>
			</div>
		</form>
	);
});
