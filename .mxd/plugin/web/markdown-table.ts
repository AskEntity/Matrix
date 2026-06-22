// Focused markdown TABLE parser — NOT a full markdown implementation.
//
// Detects GitHub-flavored-markdown table blocks inside arbitrary text and
// splits the text into a flat list of segments (plain text vs table). Used by
// <MarkdownText> to render agent replies whose tables would otherwise show as
// misaligned pipe-delimited text in a proportional font.
//
// Grammar (deliberately strict to avoid false positives):
//   - A table requires a HEADER row (a line containing at least one `|`)
//     IMMEDIATELY followed by a DELIMITER row whose cells are all `:?-+:?`
//     (dashes with optional leading/trailing colon for alignment).
//   - Header and delimiter must have the SAME number of cells (GFM rule). This
//     is what prevents a thematic break (`---`) or random pipe text from being
//     misread as a table.
//   - Body rows continue until the first line that is blank, has no `|`, or is
//     itself a delimiter. Body rows are padded/truncated to the header width.
//
// Cell content is returned as plain text (inline markdown is intentionally NOT
// parsed — tables only). Escaped pipes (`\|`) inside cells are unescaped and do
// not split cells.

export type CellAlign = "left" | "right" | "center" | "none";

export interface ParsedTable {
	headers: string[];
	align: CellAlign[];
	rows: string[][];
}

export type TextSegment =
	| { type: "text"; content: string }
	| { type: "table"; table: ParsedTable; raw: string };

/**
 * Split one table line into trimmed cell strings.
 *
 * Handles escaped pipes (`\|` → literal `|`, not a delimiter) and drops the
 * empty cells produced by leading/trailing structural pipes (`| a | b |` → two
 * cells, not four). Lines without boundary pipes (`a | b`) work too.
 */
export function splitRow(line: string): string[] {
	const s = line.trim();
	const tokens: string[] = [];
	let cur = "";
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (ch === "\\" && s[i + 1] === "|") {
			cur += "|";
			i++;
			continue;
		}
		if (ch === "|") {
			tokens.push(cur);
			cur = "";
			continue;
		}
		cur += ch;
	}
	tokens.push(cur);
	// Drop the empty leading/trailing tokens introduced by boundary pipes.
	// Interior empty cells (`| a || c |`) are preserved.
	if (tokens.length > 1 && (tokens[0] ?? "").trim() === "") tokens.shift();
	if (tokens.length > 1 && (tokens[tokens.length - 1] ?? "").trim() === "")
		tokens.pop();
	return tokens.map((t) => t.trim());
}

/** True if a line is a valid GFM delimiter row (every cell is `:?-+:?`). */
export function isDelimiterRow(line: string): boolean {
	if (!line.includes("-")) return false;
	const cells = splitRow(line);
	if (cells.length === 0) return false;
	return cells.every((c) => /^:?-+:?$/.test(c));
}

/** Derive column alignment from a delimiter cell (`:--` left, `--:` right, `:-:` center). */
function parseAlign(cell: string): CellAlign {
	const left = cell.startsWith(":");
	const right = cell.endsWith(":");
	if (left && right) return "center";
	if (right) return "right";
	if (left) return "left";
	return "none";
}

/** Pad (with empty strings) or truncate a row to exactly `n` cells. */
function normalizeRow(cells: string[], n: number): string[] {
	const out = cells.slice(0, n);
	while (out.length < n) out.push("");
	return out;
}

/**
 * Split arbitrary text into ordered text/table segments.
 *
 * When the text contains no table, returns a single `{ type: "text" }` segment
 * holding the input verbatim — callers use this to take a zero-cost plain-text
 * path identical to the previous rendering.
 */
export function parseTextSegments(text: string): TextSegment[] {
	const lines = text.split("\n");
	const segments: TextSegment[] = [];
	let textBuf: string[] = [];

	const flushText = () => {
		if (textBuf.length > 0) {
			segments.push({ type: "text", content: textBuf.join("\n") });
			textBuf = [];
		}
	};

	let i = 0;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		const next = lines[i + 1];
		if (line.includes("|") && next !== undefined && isDelimiterRow(next)) {
			const headerCells = splitRow(line);
			const delimCells = splitRow(next);
			if (headerCells.length >= 1 && headerCells.length === delimCells.length) {
				// Collect body rows until a non-table line.
				const rows: string[][] = [];
				let j = i + 2;
				while (j < lines.length) {
					const bodyLine = lines[j] ?? "";
					if (
						bodyLine.trim() === "" ||
						!bodyLine.includes("|") ||
						isDelimiterRow(bodyLine)
					) {
						break;
					}
					rows.push(normalizeRow(splitRow(bodyLine), headerCells.length));
					j++;
				}
				flushText();
				segments.push({
					type: "table",
					raw: lines.slice(i, j).join("\n"),
					table: {
						headers: headerCells,
						align: delimCells.map(parseAlign),
						rows,
					},
				});
				i = j;
				continue;
			}
		}
		textBuf.push(line);
		i++;
	}
	flushText();

	// Guarantee at least one segment so callers can always read segments[0].
	if (segments.length === 0) segments.push({ type: "text", content: text });
	return segments;
}

/** True if the text contains at least one renderable markdown table. */
export function hasTable(text: string): boolean {
	return parseTextSegments(text).some((s) => s.type === "table");
}
