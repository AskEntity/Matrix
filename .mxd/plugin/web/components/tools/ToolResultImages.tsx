import { useState } from "react";
import { ImageLightbox } from "../ImageLightbox.tsx";

/** Render inline images from tool results (e.g. MCP screenshots). */
export function ToolResultImages({
	images,
}: {
	images: Array<{ base64: string; mediaType: string }>;
}) {
	const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

	if (images.length === 0) return null;
	return (
		<>
			<div className="mxd-tool-result-images">
				{images.map((img) => {
					const src = `data:${img.mediaType};base64,${img.base64}`;
					return (
						<img
							key={img.base64.slice(-32)}
							src={src}
							alt="tool result"
							className="mxd-tool-result-image"
							onClick={() => setLightboxSrc(src)}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") setLightboxSrc(src);
							}}
						/>
					);
				})}
			</div>
			{lightboxSrc && (
				<ImageLightbox
					src={lightboxSrc}
					alt="tool result"
					onClose={() => setLightboxSrc(null)}
				/>
			)}
		</>
	);
}
