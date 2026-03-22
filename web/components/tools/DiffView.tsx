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
		<div className="og-diff-container">
			{oldLines.map((line, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: stable ordered lines
				<div key={`r${i}`} className="og-diff-line og-diff-line-removed">
					<span className="og-diff-prefix">-</span>
					<span className="og-diff-content">{line}</span>
				</div>
			))}
			{newLines.map((line, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: stable ordered lines
				<div key={`a${i}`} className="og-diff-line og-diff-line-added">
					<span className="og-diff-prefix">+</span>
					<span className="og-diff-content">{line}</span>
				</div>
			))}
		</div>
	);
}
