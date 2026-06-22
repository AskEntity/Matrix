import { memo, useMemo, useState } from "react";
import { useLocale } from "../i18n.ts";
import {
	type CellAlign,
	type ParsedTable,
	parseTextSegments,
} from "../markdown-table.ts";

/** Inline style for a cell's alignment (omitted when default/none). */
function alignStyle(a: CellAlign): React.CSSProperties | undefined {
	if (a === "none") return undefined;
	return { textAlign: a };
}

/** A single rendered markdown table with a copy-to-clipboard button. */
function MarkdownTable({ table, raw }: { table: ParsedTable; raw: string }) {
	const { t } = useLocale();
	const [copied, setCopied] = useState(false);

	const copy = async () => {
		try {
			await navigator.clipboard?.writeText(raw);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			// Clipboard may be unavailable (insecure context / denied permission).
		}
	};

	return (
		<div className="mxd-md-table-wrap">
			<button
				type="button"
				className="mxd-md-table-copy"
				onClick={copy}
				title={t("table.copy")}
			>
				{copied ? t("table.copied") : t("table.copy")}
			</button>
			<div className="mxd-md-table-scroll">
				<table className="mxd-md-table">
					<thead>
						<tr>
							{table.headers.map((h, ci) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: columns are fixed and never reorder
								<th key={ci} style={alignStyle(table.align[ci] ?? "none")}>
									{h}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{table.rows.map((row, ri) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and never reorder
							<tr key={ri}>
								{row.map((cell, ci) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: cells are positional and never reorder
									<td key={ci} style={alignStyle(table.align[ci] ?? "none")}>
										{cell}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}

/**
 * Render text that may contain GitHub-flavored markdown TABLES.
 *
 * Tables become real <table> elements (aligned, copyable); everything else
 * stays plain text with the caller-provided className. When the text has no
 * table, this renders a single <span className={className}>{text}</span> —
 * byte-identical to the previous plain rendering (zero behavior change for the
 * common case). Cell content is rendered as React text children (escaped — no
 * dangerouslySetInnerHTML), so untrusted content cannot inject markup.
 */
export const MarkdownText = memo(function MarkdownText({
	text,
	className,
}: {
	text: string;
	className?: string;
}) {
	const segments = useMemo(() => parseTextSegments(text), [text]);

	const tablePresent = segments.some((s) => s.type === "table");
	if (!tablePresent) {
		return <span className={className}>{text}</span>;
	}

	return (
		<div className={`mxd-md${className ? ` ${className}` : ""}`}>
			{segments.map((seg, idx) => {
				if (seg.type === "text") {
					if (seg.content.trim() === "") return null;
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: segments are stable and never reorder
						<div key={idx} className="mxd-md-text">
							{seg.content}
						</div>
					);
				}
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: segments are stable and never reorder
					<MarkdownTable key={idx} table={seg.table} raw={seg.raw} />
				);
			})}
		</div>
	);
});
