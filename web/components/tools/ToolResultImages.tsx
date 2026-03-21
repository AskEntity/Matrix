/** Render inline images from tool results (e.g. MCP screenshots). */
export function ToolResultImages({
	images,
}: {
	images: Array<{ base64: string; mediaType: string }>;
}) {
	if (images.length === 0) return null;
	return (
		<div className="og-tool-result-images">
			{images.map((img) => (
				<img
					key={img.base64.slice(-32)}
					src={`data:${img.mediaType};base64,${img.base64}`}
					alt="tool result"
					className="og-tool-result-image"
					onClick={() => {
						const binary = atob(img.base64);
						const bytes = new Uint8Array(binary.length);
						for (let i = 0; i < binary.length; i++)
							bytes[i] = binary.charCodeAt(i);
						const blob = new Blob([bytes], { type: img.mediaType });
						window.open(URL.createObjectURL(blob), "_blank");
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							const binary = atob(img.base64);
							const bytes = new Uint8Array(binary.length);
							for (let i = 0; i < binary.length; i++)
								bytes[i] = binary.charCodeAt(i);
							const blob = new Blob([bytes], { type: img.mediaType });
							window.open(URL.createObjectURL(blob), "_blank");
						}
					}}
				/>
			))}
		</div>
	);
}
