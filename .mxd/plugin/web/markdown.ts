// Lightweight markdown parser for agent replies — NOT a full CommonMark
// implementation.
//
// Extends the tables-only pipeline (markdown-table.ts) into the small subset
// of markdown agents actually emit in chat replies:
//
//   blocks: fenced code (```), headings (#{1..6} + space), blockquotes (>),
//           lists (-,* / 1.) with ONE nesting level, horizontal rules
//           (---/***/___), GFM tables (delegated to markdown-table.ts)
//   inline: `code`, **strong**, *em*, ~~strike~~, [text](http(s)://url)
//
// Parse order is load-bearing:
//   1. Fenced code blocks are extracted FIRST — fence content is verbatim
//      (no table, no block, no inline parsing inside).
//   2. Table detection (parseTextSegments) runs on the non-fence text.
//   3. Block elements are recognized per line within text segments.
//   4. Inline constructs are parsed within a single line; `code` spans bind
//      tightest and protect their content from emphasis parsing.
//
// Deliberate non-features (in a chat log, false positives are worse than
// missing features — same philosophy as the table parser): no setext
// headings, no indented code blocks, no _underscore_ emphasis (snake_case
// identifiers would italicize), no backslash escapes (Windows/glob paths
// would silently lose backslashes), no raw HTML, no images. Unknown or
// unsafe link schemes (javascript:, data:, …) render as plain text — only
// http:// and https:// become anchors.
//
// Emphasis uses whitespace-adjacency rules, NOT word-boundary (\b) rules —
// CJK text has no spaces, so `**中文**` must work with characters directly
// adjacent to the markers.

import { type ParsedTable, parseTextSegments } from "./markdown-table.ts";

export type InlineNode =
	| { type: "text"; text: string }
	| { type: "code"; text: string }
	| { type: "strong"; children: InlineNode[] }
	| { type: "em"; children: InlineNode[] }
	| { type: "strike"; children: InlineNode[] }
	| { type: "link"; href: string; children: InlineNode[] };

export interface MdList {
	ordered: boolean;
	start: number;
	items: MdListItem[];
}

export interface MdListItem {
	content: InlineNode[];
	/** One nesting level only — sub-items never have their own `sub`. */
	sub?: MdList;
}

export type MarkdownBlock =
	| { type: "text"; lines: InlineNode[][] }
	| { type: "heading"; level: number; content: InlineNode[] }
	| { type: "code_block"; lang: string; content: string; closed: boolean }
	| { type: "blockquote"; lines: InlineNode[][] }
	| ({ type: "list" } & MdList)
	| { type: "hr" }
	| { type: "table"; table: ParsedTable; raw: string };

/** Only http:// and https:// may become clickable anchors. */
export function isSafeLinkHref(href: string): boolean {
	return /^https?:\/\//i.test(href);
}

const isWS = (ch: string | undefined): boolean =>
	ch !== undefined && /\s/.test(ch);

/** Length of the run of `ch` starting at `i`. */
function runLength(text: string, i: number, ch: string): number {
	let n = 0;
	while (text[i + n] === ch) n++;
	return n;
}

/**
 * Match a code span starting at `i` (which must point at a backtick).
 *
 * CommonMark rules, simplified: an opening run of N backticks closes at the
 * next run of EXACTLY N backticks; content is verbatim. One space is stripped
 * from each side when the content both starts and ends with a space and is
 * not all spaces (lets `` `code` `` express a backtick-wrapped literal).
 */
function matchCodeSpan(
	text: string,
	i: number,
): { content: string; end: number } | null {
	const n = runLength(text, i, "`");
	let j = i + n;
	while (j < text.length) {
		if (text[j] === "`") {
			const m = runLength(text, j, "`");
			if (m === n) {
				let content = text.slice(i + n, j);
				if (
					content.length >= 2 &&
					content.startsWith(" ") &&
					content.endsWith(" ") &&
					content.trim() !== ""
				) {
					content = content.slice(1, -1);
				}
				return { content, end: j + m };
			}
			j += m;
			continue;
		}
		j++;
	}
	return null;
}

/**
 * Find the closing delimiter for an emphasis span opened before `from`.
 *
 * Rules: the closer must be preceded by a non-whitespace character (so
 * `2 ** 3 ** 4` stays math); a `*` closer must be a LONE star (not part of a
 * `**` run — this is what lets `*a **b** c*` nest); code spans are skipped so
 * a marker inside `` ` `` never closes emphasis.
 */
function findEmphasisCloser(
	text: string,
	from: number,
	marker: "*" | "**" | "~~",
): number {
	const mc = marker === "~~" ? "~" : "*";
	const double = marker !== "*";
	let i = from;
	while (i < text.length) {
		const ch = text[i];
		if (ch === "`") {
			const span = matchCodeSpan(text, i);
			if (span) {
				i = span.end;
				continue;
			}
		}
		if (ch === mc && !isWS(text[i - 1]) && text[i - 1] !== mc) {
			if (double) {
				if (text[i + 1] === mc) return i;
			} else if (text[i + 1] !== mc) {
				return i;
			}
		}
		i++;
	}
	return -1;
}

/**
 * Match `[label](destination)` starting at `i` (which must point at `[`).
 *
 * The label runs to the FIRST `]` (no nested brackets — keep it simple); the
 * destination allows balanced parens (Wikipedia-style URLs); an optional
 * quoted title after the destination is dropped. Anything else after a space
 * in the destination means "parenthetical prose, not a link" → null.
 */
function matchLink(
	text: string,
	i: number,
): { href: string; label: string; end: number } | null {
	let close = -1;
	for (let j = i + 1; j < text.length; j++) {
		if (text[j] === "]") {
			close = j;
			break;
		}
	}
	if (close === -1 || text[close + 1] !== "(") return null;
	let depth = 1;
	let end = -1;
	for (let j = close + 2; j < text.length; j++) {
		const ch = text[j];
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) {
				end = j;
				break;
			}
		}
	}
	if (end === -1) return null;
	const inner = text.slice(close + 2, end).trim();
	const wsIdx = inner.search(/\s/);
	let href = inner;
	if (wsIdx !== -1) {
		href = inner.slice(0, wsIdx);
		const rest = inner.slice(wsIdx).trim();
		if (!/^"[^"]*"$/.test(rest) && !/^'[^']*'$/.test(rest)) return null;
	}
	return { href, label: text.slice(i + 1, close), end: end + 1 };
}

/**
 * Parse the inline constructs of a single line into a node list.
 *
 * Precedence: `code` spans bind tightest (their content is verbatim), then
 * links, then **strong** / *em* / ~~strike~~ (recursively parsed). Anything
 * unclosed or invalid degrades to literal text — never throws, never eats
 * content.
 */
export function parseInline(text: string): InlineNode[] {
	const nodes: InlineNode[] = [];
	let buf = "";
	const flush = () => {
		if (buf !== "") {
			nodes.push({ type: "text", text: buf });
			buf = "";
		}
	};

	let i = 0;
	while (i < text.length) {
		const ch = text[i];

		if (ch === "`") {
			const span = matchCodeSpan(text, i);
			if (span) {
				flush();
				nodes.push({ type: "code", text: span.content });
				i = span.end;
				continue;
			}
			const n = runLength(text, i, "`");
			buf += text.slice(i, i + n);
			i += n;
			continue;
		}

		if (ch === "[" && text[i - 1] !== "!") {
			const lk = matchLink(text, i);
			if (lk) {
				if (isSafeLinkHref(lk.href)) {
					flush();
					nodes.push({
						type: "link",
						href: lk.href,
						children: parseInline(lk.label),
					});
				} else {
					// Unsafe scheme (javascript:, data:, …) or non-URL destination:
					// keep the raw source as plain text — never a clickable anchor.
					buf += text.slice(i, lk.end);
				}
				i = lk.end;
				continue;
			}
			buf += ch;
			i++;
			continue;
		}

		if (ch === "*" || ch === "~") {
			const n = runLength(text, i, ch);
			let marker: "*" | "**" | "~~" | null = null;
			if (ch === "~") {
				if (n === 2) marker = "~~";
			} else if (n === 1) {
				marker = "*";
			} else if (n === 2) {
				marker = "**";
			}
			// Runs of 3+ markers are ambiguous soup — degrade to literal text.
			if (marker !== null) {
				const contentStart = i + marker.length;
				const nx = text[contentStart];
				if (nx !== undefined && !isWS(nx)) {
					const close = findEmphasisCloser(text, contentStart + 1, marker);
					if (close !== -1) {
						const children = parseInline(text.slice(contentStart, close));
						flush();
						if (marker === "**") nodes.push({ type: "strong", children });
						else if (marker === "*") nodes.push({ type: "em", children });
						else nodes.push({ type: "strike", children });
						i = close + marker.length;
						continue;
					}
				}
			}
			buf += text.slice(i, i + n);
			i += n;
			continue;
		}

		buf += ch;
		i++;
	}
	flush();
	return nodes;
}

// ── Block grammar ─────────────────────────────────────────────────────────

// A backtick fence's info string may not contain backticks (CommonMark) —
// this is what keeps a line like "```inline``` more" out of fence territory.
const FENCE_OPEN = /^ {0,3}(`{3,})([^`]*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,})\s*$/;
const HEADING = /^ {0,3}(#{1,6}) +(\S.*)$/;
// Runs of -/*/_ (3+, spaces allowed between) — `- - -` and `* * *` included.
const HR = /^ {0,3}(?:(?:- *){3,}|(?:\* *){3,}|(?:_ *){3,})$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const UL_ITEM = /^( *)[-*] +(\S.*)$/;
const OL_ITEM = /^( *)(\d{1,9})\. +(\S.*)$/;

interface ListItemMatch {
	indent: number;
	ordered: boolean;
	num: number;
	content: string;
}

function matchListItem(line: string): ListItemMatch | null {
	const ul = line.match(UL_ITEM);
	if (ul) {
		return {
			indent: (ul[1] ?? "").length,
			ordered: false,
			num: 1,
			content: ul[2] ?? "",
		};
	}
	const ol = line.match(OL_ITEM);
	if (ol) {
		return {
			indent: (ol[1] ?? "").length,
			ordered: true,
			num: Number(ol[2] ?? "1"),
			content: ol[3] ?? "",
		};
	}
	return null;
}

/** Collect consecutive `>` lines into one blockquote. Returns the next index. */
function collectQuote(
	lines: string[],
	start: number,
	out: MarkdownBlock[],
): number {
	const qlines: InlineNode[][] = [];
	let i = start;
	while (i < lines.length) {
		const m = (lines[i] ?? "").match(QUOTE);
		if (!m) break;
		qlines.push(parseInline(m[1] ?? ""));
		i++;
	}
	out.push({ type: "blockquote", lines: qlines });
	return i;
}

/**
 * Collect consecutive list-item lines into one list block.
 *
 * The first item's indent is the baseline; items indented ≥2 past it become
 * a nested list under the previous top-level item (ONE level — deeper indents
 * flatten into the same sub-list). A marker-type switch at the top level ends
 * the list (the caller starts a new one). Returns the next index.
 */
function collectList(
	lines: string[],
	start: number,
	out: MarkdownBlock[],
): number {
	const first = matchListItem(lines[start] ?? "");
	if (!first) return start + 1; // unreachable — caller checked
	const items: MdListItem[] = [{ content: parseInline(first.content) }];
	const ordered = first.ordered;
	const startNum = first.num;
	const base = first.indent;
	let i = start + 1;
	while (i < lines.length) {
		const m = matchListItem(lines[i] ?? "");
		if (!m) break;
		if (m.indent >= base + 2) {
			const last = items[items.length - 1];
			if (last) {
				if (!last.sub) {
					last.sub = { ordered: m.ordered, start: m.num, items: [] };
				}
				last.sub.items.push({ content: parseInline(m.content) });
			}
			i++;
			continue;
		}
		if (m.ordered !== ordered) break;
		items.push({ content: parseInline(m.content) });
		i++;
	}
	out.push({ type: "list", ordered, start: startNum, items });
	return i;
}

/**
 * Parse the lines of one table-free text segment into block elements.
 *
 * Lines that are no special block accumulate into verbatim text runs —
 * interior blank lines are preserved exactly (chat replies are pre-wrap
 * text, not reflowed paragraphs); blank edges next to block elements are
 * trimmed because blocks carry their own margins.
 */
function parseBlockLines(lines: string[], out: MarkdownBlock[]): void {
	let run: string[] = [];
	const flushRun = () => {
		while (run.length > 0 && (run[0] ?? "").trim() === "") run.shift();
		while (run.length > 0 && (run[run.length - 1] ?? "").trim() === "")
			run.pop();
		if (run.length > 0) {
			out.push({ type: "text", lines: run.map((l) => parseInline(l)) });
		}
		run = [];
	};

	let i = 0;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		const h = line.match(HEADING);
		if (h) {
			flushRun();
			out.push({
				type: "heading",
				level: (h[1] ?? "#").length,
				content: parseInline(h[2] ?? ""),
			});
			i++;
			continue;
		}
		if (HR.test(line)) {
			flushRun();
			out.push({ type: "hr" });
			i++;
			continue;
		}
		if (QUOTE.test(line)) {
			flushRun();
			i = collectQuote(lines, i, out);
			continue;
		}
		if (matchListItem(line)) {
			flushRun();
			i = collectList(lines, i, out);
			continue;
		}
		run.push(line);
		i++;
	}
	flushRun();
}

/**
 * Parse arbitrary text into an ordered list of markdown blocks.
 *
 * Fences are extracted first (verbatim content), then tables (via
 * markdown-table.ts), then per-line block elements, then inline constructs.
 * Always returns at least one block.
 */
export function parseMarkdown(text: string): MarkdownBlock[] {
	const lines = text.split("\n");
	const blocks: MarkdownBlock[] = [];
	let plain: string[] = [];

	const flushPlain = () => {
		if (plain.length === 0) return;
		for (const seg of parseTextSegments(plain.join("\n"))) {
			if (seg.type === "table") {
				blocks.push({ type: "table", table: seg.table, raw: seg.raw });
			} else {
				parseBlockLines(seg.content.split("\n"), blocks);
			}
		}
		plain = [];
	};

	let i = 0;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		const open = line.match(FENCE_OPEN);
		if (open) {
			flushPlain();
			const fenceLen = (open[1] ?? "```").length;
			const content: string[] = [];
			let closed = false;
			let j = i + 1;
			while (j < lines.length) {
				const l = lines[j] ?? "";
				const cm = l.match(FENCE_CLOSE);
				if (cm && (cm[1] ?? "").length >= fenceLen) {
					closed = true;
					j++;
					break;
				}
				content.push(l);
				j++;
			}
			blocks.push({
				type: "code_block",
				lang: (open[2] ?? "").trim(),
				content: content.join("\n"),
				closed,
			});
			i = j;
			continue;
		}
		plain.push(line);
		i++;
	}
	flushPlain();

	if (blocks.length === 0) {
		blocks.push({ type: "text", lines: [parseInline(text)] });
	}
	return blocks;
}

/**
 * True when the parse found NO markdown constructs — every block is a text
 * run of plain text nodes. Callers then render the ORIGINAL string verbatim
 * (byte-identical fallback), so plain replies are untouched by this parser.
 */
export function isPlainText(blocks: MarkdownBlock[]): boolean {
	return blocks.every(
		(b) =>
			b.type === "text" &&
			b.lines.every((line) => line.every((n) => n.type === "text")),
	);
}
