import { createElement, Fragment, memo, useMemo, useState } from "react";
import { useLocale } from "../i18n.ts";
import {
	type InlineNode,
	isPlainText,
	type MarkdownBlock,
	type MdList,
	parseMarkdown,
} from "../markdown.ts";
import type { CellAlign, ParsedTable } from "../markdown-table.ts";

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
 * Render inline nodes as React elements. All content lands as escaped text
 * children (never dangerouslySetInnerHTML); link hrefs were already gated to
 * http(s) by the parser.
 */
function renderInline(nodes: InlineNode[]): React.ReactNode[] {
	return nodes.map((n, i) => {
		switch (n.type) {
			case "text":
				return n.text;
			case "code":
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: inline nodes are positional and never reorder
					<code key={i} className="mxd-md-code-inline">
						{n.text}
					</code>
				);
			case "strong":
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: inline nodes are positional and never reorder
					<strong key={i}>{renderInline(n.children)}</strong>
				);
			case "em":
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: inline nodes are positional and never reorder
					<em key={i}>{renderInline(n.children)}</em>
				);
			case "strike":
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: inline nodes are positional and never reorder
					<del key={i}>{renderInline(n.children)}</del>
				);
			// The default arm makes every path return for the linter while `n`
			// still narrows to the link variant (all other cases returned above).
			default:
				return (
					<a
						// biome-ignore lint/suspicious/noArrayIndexKey: inline nodes are positional and never reorder
						key={i}
						className="mxd-md-link"
						href={n.href}
						target="_blank"
						rel="noopener noreferrer"
					>
						{renderInline(n.children)}
					</a>
				);
		}
	});
}

/**
 * Render multi-line inline content (text runs, blockquotes) with literal
 * newlines between lines — the containers use white-space: pre-wrap, so the
 * original line layout is preserved exactly.
 */
function renderLines(lines: InlineNode[][]): React.ReactNode[] {
	return lines.map((line, i) => (
		// biome-ignore lint/suspicious/noArrayIndexKey: lines are positional and never reorder
		<Fragment key={i}>
			{i > 0 ? "\n" : null}
			{renderInline(line)}
		</Fragment>
	));
}

/** A fenced code block with a copy-to-clipboard button (verbatim content). */
function CodeBlock({ content }: { content: string }) {
	const { t } = useLocale();
	const [copied, setCopied] = useState(false);

	const copy = async () => {
		try {
			await navigator.clipboard?.writeText(content);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			// Clipboard may be unavailable (insecure context / denied permission).
		}
	};

	return (
		<div className="mxd-md-code-wrap">
			<button
				type="button"
				className="mxd-md-code-copy"
				onClick={copy}
				title={t("code.copy")}
			>
				{copied ? t("code.copied") : t("code.copy")}
			</button>
			<pre className="mxd-md-code-block">
				<code>{content}</code>
			</pre>
		</div>
	);
}

/** A (possibly nested) list. `start` only applies to ordered lists. */
function ListView({ list }: { list: MdList }) {
	const items = list.items.map((item, i) => (
		// biome-ignore lint/suspicious/noArrayIndexKey: items are positional and never reorder
		<li key={i}>
			{renderInline(item.content)}
			{item.sub ? <ListView list={item.sub} /> : null}
		</li>
	));
	if (list.ordered) {
		return (
			<ol
				className="mxd-md-list"
				start={list.start !== 1 ? list.start : undefined}
			>
				{items}
			</ol>
		);
	}
	return <ul className="mxd-md-list">{items}</ul>;
}

/** Render one parsed markdown block. */
function BlockView({ block }: { block: MarkdownBlock }) {
	switch (block.type) {
		case "text":
			return <div className="mxd-md-text">{renderLines(block.lines)}</div>;
		case "heading":
			return createElement(
				`h${block.level}`,
				{ className: `mxd-md-h mxd-md-h${block.level}` },
				...renderInline(block.content),
			);
		case "code_block":
			return <CodeBlock content={block.content} />;
		case "blockquote":
			return (
				<blockquote className="mxd-md-quote">
					{renderLines(block.lines)}
				</blockquote>
			);
		case "list":
			return <ListView list={block} />;
		case "hr":
			return <hr className="mxd-md-hr" />;
		case "table":
			return <MarkdownTable table={block.table} raw={block.raw} />;
	}
}

/**
 * Render text that may contain lightweight markdown: tables, fenced code,
 * headings, lists, blockquotes, horizontal rules + inline code / bold /
 * italic / strikethrough / http(s) links (see markdown.ts for the grammar
 * and its deliberate limits).
 *
 * When the text contains NO markdown constructs, this renders a single
 * <span className={className}>{text}</span> — byte-identical to plain
 * rendering (zero behavior change for the common case). All content is
 * rendered as React text children (escaped — no dangerouslySetInnerHTML),
 * so untrusted content cannot inject markup; only http(s) URLs become
 * anchors.
 */
export const MarkdownText = memo(function MarkdownText({
	text,
	className,
}: {
	text: string;
	className?: string;
}) {
	const blocks = useMemo(() => parseMarkdown(text), [text]);

	if (isPlainText(blocks)) {
		return <span className={className}>{text}</span>;
	}

	return (
		<div className={`mxd-md${className ? ` ${className}` : ""}`}>
			{blocks.map((block, idx) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: blocks are stable and never reorder
				<BlockView key={idx} block={block} />
			))}
		</div>
	);
});
