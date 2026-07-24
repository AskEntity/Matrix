import { memo, useCallback, useEffect, useRef } from "react";
import { useLocale } from "../i18n.ts";

/**
 * In-app confirmation modal — the styled replacement for `window.confirm`.
 *
 * Backdrop + centered card. Escape or a backdrop click cancels; clicks inside
 * the card don't. `children` renders between the message and the buttons
 * (used for the rollback impact warnings).
 */
export const ConfirmDialog = memo(function ConfirmDialog({
	title,
	message,
	confirmLabel,
	cancelLabel,
	danger = false,
	onConfirm,
	onCancel,
	children,
}: {
	title: string;
	message?: string;
	confirmLabel: string;
	/** Defaults to the shared "Cancel" string. */
	cancelLabel?: string;
	/** Renders the confirm button in the destructive style. */
	danger?: boolean;
	onConfirm: () => void;
	onCancel: () => void;
	children?: React.ReactNode;
}) {
	const { t } = useLocale();
	const confirmRef = useRef<HTMLButtonElement>(null);

	const handleKeyDown = useCallback(
		(e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				onCancel();
			}
		},
		[onCancel],
	);

	useEffect(() => {
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [handleKeyDown]);

	// Focus the confirm button so Enter completes the action the user just
	// asked for; Escape / backdrop / Cancel are all one action away.
	useEffect(() => {
		confirmRef.current?.focus();
	}, []);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: full-screen dismiss backdrop
		// biome-ignore lint/a11y/useKeyWithClickEvents: Escape handled at document level in useEffect
		<div className="mxd-confirm-overlay" onClick={onCancel}>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: click only stops backdrop dismissal; Escape is handled at document level */}
			<div
				className="mxd-confirm-card"
				role="dialog"
				aria-modal="true"
				aria-label={title}
				onClick={(e) => e.stopPropagation()}
			>
				<div className="mxd-confirm-title">{title}</div>
				{message && <div className="mxd-confirm-message">{message}</div>}
				{children}
				<div className="mxd-confirm-actions">
					<button
						type="button"
						className="mxd-btn mxd-btn-ghost"
						onClick={onCancel}
					>
						{cancelLabel ?? t("confirm.cancel")}
					</button>
					<button
						type="button"
						ref={confirmRef}
						className={`mxd-btn ${danger ? "mxd-btn-stop" : "mxd-btn-primary"}`}
						onClick={onConfirm}
					>
						{confirmLabel}
					</button>
				</div>
			</div>
		</div>
	);
});
