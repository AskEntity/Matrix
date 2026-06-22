import { memo, useCallback, useEffect } from "react";

/**
 * Full-screen image lightbox overlay.
 * Click backdrop or press Escape to close.
 */
export const ImageLightbox = memo(function ImageLightbox({
	src,
	alt,
	onClose,
}: {
	src: string;
	alt?: string;
	onClose: () => void;
}) {
	const handleKeyDown = useCallback(
		(e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		},
		[onClose],
	);

	useEffect(() => {
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [handleKeyDown]);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: full-screen dismiss overlay
		// biome-ignore lint/a11y/useKeyWithClickEvents: Escape handled at document level in useEffect
		<div className="mxd-lightbox-overlay" onClick={onClose}>
			<img
				className="mxd-lightbox-image"
				src={src}
				alt={alt ?? "enlarged image"}
				onClick={(e) => e.stopPropagation()}
				onKeyDown={() => {}}
			/>
		</div>
	);
});
