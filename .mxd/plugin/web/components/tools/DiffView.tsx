/** Line-by-line diff view — red for removed, green for added */
export function DiffView({
	oldText,
	newText,
}: {
	oldText: string;
	newText: string;
}) {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");

	return (
		<div className="mxd-diff-container">
			{oldLines.map((line, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: stable ordered lines
				<div key={`r${i}`} className="mxd-diff-line mxd-diff-line-removed">
					<span className="mxd-diff-prefix">-</span>
					<span className="mxd-diff-content">{line}</span>
				</div>
			))}
			{newLines.map((line, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: stable ordered lines
				<div key={`a${i}`} className="mxd-diff-line mxd-diff-line-added">
					<span className="mxd-diff-prefix">+</span>
					<span className="mxd-diff-content">{line}</span>
				</div>
			))}
		</div>
	);
}
