/**
 * Unit tests for the lightweight markdown parser (no DOM).
 *
 * markdown.ts extends the tables-only pipeline (markdown-table.ts) into a full
 * lightweight renderer: fenced code, headings, lists, quotes, hr + inline
 * code/bold/italic/strike/links. The dangerous failure modes, pinned
 * adversarially here:
 *   (1) fence leaks — table/heading/inline parsing INSIDE ``` fences;
 *   (2) unsafe links — javascript:/data: schemes becoming clickable;
 *   (3) word-boundary assumptions that break CJK adjacency (no spaces);
 *   (4) unclosed markers turning the rest of a message into markup;
 *   (5) false positives — prose misread as markup (the table parser's lesson).
 */

import { describe, expect, test } from "bun:test";
import {
	type InlineNode,
	isPlainText,
	isSafeLinkHref,
	parseInline,
	parseMarkdown,
} from "../.mxd/plugin/web/markdown.ts";

// ── Convenience constructors for expected trees ──────────────────────────
const t = (text: string): InlineNode => ({ type: "text", text });
const code = (text: string): InlineNode => ({ type: "code", text });
const strong = (...children: InlineNode[]): InlineNode => ({
	type: "strong",
	children,
});
const em = (...children: InlineNode[]): InlineNode => ({
	type: "em",
	children,
});
const strike = (...children: InlineNode[]): InlineNode => ({
	type: "strike",
	children,
});
const link = (href: string, ...children: InlineNode[]): InlineNode => ({
	type: "link",
	href,
	children,
});

// ═════════════════════════════════════════════════════════════════════════
// Fences protect their content (parse order rule 1)
// ═════════════════════════════════════════════════════════════════════════

describe("parseMarkdown — fences protect content", () => {
	test("table-shaped text inside a fence is NOT a table", () => {
		const text = "```\n| a | b |\n| --- | --- |\n| 1 | 2 |\n```";
		const blocks = parseMarkdown(text);
		expect(blocks).toEqual([
			{
				type: "code_block",
				lang: "",
				content: "| a | b |\n| --- | --- |\n| 1 | 2 |",
				closed: true,
			},
		]);
	});

	test("heading / list / bold markers inside a fence stay verbatim", () => {
		const text = "```\n# not a heading\n- not a list\n**not bold**\n```";
		const blocks = parseMarkdown(text);
		expect(blocks).toEqual([
			{
				type: "code_block",
				lang: "",
				content: "# not a heading\n- not a list\n**not bold**",
				closed: true,
			},
		]);
	});

	test("unclosed fence runs to end of input (graceful) and is marked closed:false", () => {
		const text = "before\n```ts\nconst x = 1;\nmore();";
		const blocks = parseMarkdown(text);
		expect(blocks).toEqual([
			{ type: "text", lines: [[t("before")]] },
			{
				type: "code_block",
				lang: "ts",
				content: "const x = 1;\nmore();",
				closed: false,
			},
		]);
	});

	test("info string (language) is captured", () => {
		const blocks = parseMarkdown("```python\nprint(1)\n```");
		expect(blocks[0]).toEqual({
			type: "code_block",
			lang: "python",
			content: "print(1)",
			closed: true,
		});
	});

	test("a 4-backtick fence contains a 3-backtick line verbatim", () => {
		const text = "````\n```\ninner\n````";
		const blocks = parseMarkdown(text);
		expect(blocks).toEqual([
			{ type: "code_block", lang: "", content: "```\ninner", closed: true },
		]);
	});

	test("tables outside a fence still parse; fence + table compose in order", () => {
		const text = [
			"intro",
			"",
			"| a | b |",
			"| --- | --- |",
			"| 1 | 2 |",
			"",
			"```",
			"| x |",
			"| --- |",
			"```",
		].join("\n");
		const blocks = parseMarkdown(text);
		expect(blocks.map((b) => b.type)).toEqual(["text", "table", "code_block"]);
		const table = blocks[1];
		if (table?.type !== "table") throw new Error("expected table");
		expect(table.table.headers).toEqual(["a", "b"]);
		const fence = blocks[2];
		if (fence?.type !== "code_block") throw new Error("expected code_block");
		expect(fence.content).toBe("| x |\n| --- |");
	});

	test("a mid-line triple backtick is NOT a fence (inline code instead)", () => {
		const blocks = parseMarkdown("use ```npm install``` here");
		expect(blocks).toEqual([
			{
				type: "text",
				lines: [[t("use "), code("npm install"), t(" here")]],
			},
		]);
	});

	test("a line-start ```x``` y line is not a fence (info string may not contain backticks)", () => {
		const blocks = parseMarkdown("```inline``` more");
		expect(blocks).toEqual([
			{ type: "text", lines: [[code("inline"), t(" more")]] },
		]);
	});
});

// ═════════════════════════════════════════════════════════════════════════
// Link safety
// ═════════════════════════════════════════════════════════════════════════

describe("link safety — only http(s) becomes a link", () => {
	test("isSafeLinkHref accepts only http:// and https:// (case-insensitive)", () => {
		expect(isSafeLinkHref("https://example.com")).toBe(true);
		expect(isSafeLinkHref("http://example.com")).toBe(true);
		expect(isSafeLinkHref("HTTPS://EXAMPLE.COM")).toBe(true);
		expect(isSafeLinkHref("javascript:alert(1)")).toBe(false);
		expect(isSafeLinkHref("data:text/html,<script>")).toBe(false);
		expect(isSafeLinkHref("vbscript:msgbox")).toBe(false);
		expect(isSafeLinkHref("file:///etc/passwd")).toBe(false);
		expect(isSafeLinkHref("./relative.md")).toBe(false);
		expect(isSafeLinkHref("#anchor")).toBe(false);
		expect(isSafeLinkHref("https:/missing-slash")).toBe(false);
	});

	test("[x](javascript:alert(1)) renders as PLAIN TEXT, source preserved", () => {
		expect(parseInline("[x](javascript:alert(1))")).toEqual([
			t("[x](javascript:alert(1))"),
		]);
	});

	test("data: / file: / relative destinations render as plain text", () => {
		expect(parseInline("[a](data:text/html,x)")).toEqual([
			t("[a](data:text/html,x)"),
		]);
		expect(parseInline("[a](file:///etc/passwd)")).toEqual([
			t("[a](file:///etc/passwd)"),
		]);
		expect(parseInline("[doc](./README.md)")).toEqual([
			t("[doc](./README.md)"),
		]);
	});

	test("https link parses with label and href", () => {
		expect(parseInline("see [docs](https://example.com/a) now")).toEqual([
			t("see "),
			link("https://example.com/a", t("docs")),
			t(" now"),
		]);
	});

	test("URL with balanced parens stays intact", () => {
		expect(parseInline("[w](https://en.wikipedia.org/wiki/A_(b))")).toEqual([
			link("https://en.wikipedia.org/wiki/A_(b)", t("w")),
		]);
	});

	test("quoted title after the URL is dropped from href", () => {
		expect(parseInline('[a](https://x.dev "the title")')).toEqual([
			link("https://x.dev", t("a")),
		]);
	});

	test("parenthetical prose after brackets is NOT a link", () => {
		expect(parseInline("[1](see note below)")).toEqual([
			t("[1](see note below)"),
		]);
	});

	test("image syntax ![alt](url) is NOT parsed as a link", () => {
		expect(parseInline("![alt](https://x.dev/i.png)")).toEqual([
			t("![alt](https://x.dev/i.png)"),
		]);
	});

	test("link label supports nested inline markdown", () => {
		expect(parseInline("[**bold** label](https://x.dev)")).toEqual([
			link("https://x.dev", strong(t("bold")), t(" label")),
		]);
	});

	test("unclosed link forms stay literal", () => {
		expect(parseInline("[dangling")).toEqual([t("[dangling")]);
		expect(parseInline("[a](https://x.dev")).toEqual([t("[a](https://x.dev")]);
		expect(parseInline("[a] (https://x.dev)")).toEqual([
			t("[a] (https://x.dev)"),
		]);
	});
});

// ═════════════════════════════════════════════════════════════════════════
// CJK adjacency — no word-boundary assumptions
// ═════════════════════════════════════════════════════════════════════════

describe("CJK adjacency", () => {
	test("**bold** directly adjacent to CJK characters", () => {
		expect(parseInline("周围**中文**相邻")).toEqual([
			t("周围"),
			strong(t("中文")),
			t("相邻"),
		]);
	});

	test("*em* between CJK characters", () => {
		expect(parseInline("中*文*字")).toEqual([t("中"), em(t("文")), t("字")]);
	});

	test("~~strike~~ adjacent to CJK", () => {
		expect(parseInline("已~~删除~~内容")).toEqual([
			t("已"),
			strike(t("删除")),
			t("内容"),
		]);
	});

	test("`code` adjacent to CJK", () => {
		expect(parseInline("调用`fn()`函数")).toEqual([
			t("调用"),
			code("fn()"),
			t("函数"),
		]);
	});

	test("link with CJK label adjacent to CJK text", () => {
		expect(parseInline("见[文档](https://x.dev)末尾")).toEqual([
			t("见"),
			link("https://x.dev", t("文档")),
			t("末尾"),
		]);
	});
});

// ═════════════════════════════════════════════════════════════════════════
// Unclosed markers degrade to literal text
// ═════════════════════════════════════════════════════════════════════════

describe("unclosed markers stay literal", () => {
	test("unclosed ** stays literal", () => {
		expect(parseInline("**bold never closes")).toEqual([
			t("**bold never closes"),
		]);
	});

	test("unclosed * stays literal", () => {
		expect(parseInline("*italic never closes")).toEqual([
			t("*italic never closes"),
		]);
	});

	test("unclosed ~~ stays literal", () => {
		expect(parseInline("~~strike never closes")).toEqual([
			t("~~strike never closes"),
		]);
	});

	test("unclosed backtick stays literal", () => {
		expect(parseInline("`code never closes")).toEqual([
			t("`code never closes"),
		]);
	});

	test("closer candidates preceded by whitespace do not close", () => {
		// The second ** is preceded by a space, so it cannot close — and there
		// is no other closer. Whole thing stays literal.
		expect(parseInline("** not bold **")).toEqual([t("** not bold **")]);
	});

	test("math-like ** surrounded by spaces stays literal", () => {
		expect(parseInline("2 ** 3 ** 4")).toEqual([t("2 ** 3 ** 4")]);
		expect(parseInline("2 * 3 * 4")).toEqual([t("2 * 3 * 4")]);
	});

	test("opener followed by whitespace cannot open (even with a valid closer)", () => {
		// The closer here (`x**`) IS valid — only the opener-side whitespace
		// rule keeps this literal.
		expect(parseInline("** x**")).toEqual([t("** x**")]);
	});

	test("closer preceded by whitespace cannot close — emphasis extends to the real closer", () => {
		// The middle ** is preceded by a space, so it must NOT close; the strong
		// span runs to the final ** (CommonMark-compatible).
		expect(parseInline("**a ** b**")).toEqual([strong(t("a ** b"))]);
	});
});

// ═════════════════════════════════════════════════════════════════════════
// Code spans bind tightest
// ═════════════════════════════════════════════════════════════════════════

describe("code spans protect their content", () => {
	test("** inside `code` is not emphasis", () => {
		expect(parseInline("`a ** b`")).toEqual([code("a ** b")]);
	});

	test("double-backtick span may contain a single backtick", () => {
		expect(parseInline("``a ` b``")).toEqual([code("a ` b")]);
	});

	test("one space is stripped from each side when both present", () => {
		expect(parseInline("`` `code` ``")).toEqual([code("`code`")]);
	});

	test("emphasis closer search skips over code spans", () => {
		// The * inside the code span must not close the emphasis.
		expect(parseInline("*a `b*` c*")).toEqual([
			em(t("a "), code("b*"), t(" c")),
		]);
	});

	test("markdown constructs inside a code span stay verbatim", () => {
		expect(parseInline("`[x](https://y) **z**`")).toEqual([
			code("[x](https://y) **z**"),
		]);
	});
});

// ═════════════════════════════════════════════════════════════════════════
// Emphasis & nesting sanity
// ═════════════════════════════════════════════════════════════════════════

describe("emphasis and nesting", () => {
	test("basic strong / em / strike", () => {
		expect(parseInline("**b**")).toEqual([strong(t("b"))]);
		expect(parseInline("*i*")).toEqual([em(t("i"))]);
		expect(parseInline("~~s~~")).toEqual([strike(t("s"))]);
	});

	test("em inside strong", () => {
		expect(parseInline("**a *b* c**")).toEqual([
			strong(t("a "), em(t("b")), t(" c")),
		]);
	});

	test("strong inside em", () => {
		expect(parseInline("*a **b** c*")).toEqual([
			em(t("a "), strong(t("b")), t(" c")),
		]);
	});

	test("intraword strong works (CommonMark-compatible for *)", () => {
		expect(parseInline("a**b**c")).toEqual([t("a"), strong(t("b")), t("c")]);
	});

	test("runs of 3+ markers degrade to literal text (predictable)", () => {
		expect(parseInline("***x***")).toEqual([t("***x***")]);
		expect(parseInline("****")).toEqual([t("****")]);
		expect(parseInline("~~~x~~~")).toEqual([t("~~~x~~~")]);
	});

	test("two sibling strongs with text between", () => {
		expect(parseInline("**a**mid**b**")).toEqual([
			strong(t("a")),
			t("mid"),
			strong(t("b")),
		]);
	});

	test("single ~ is never strike", () => {
		expect(parseInline("~x~")).toEqual([t("~x~")]);
		expect(parseInline("https://x.dev/~user")).toEqual([
			t("https://x.dev/~user"),
		]);
	});

	test("empty input → no nodes", () => {
		expect(parseInline("")).toEqual([]);
	});
});

// ═════════════════════════════════════════════════════════════════════════
// Block elements
// ═════════════════════════════════════════════════════════════════════════

describe("headings", () => {
	test("levels 1..6 with inline content", () => {
		const blocks = parseMarkdown(
			"# h1\n## h2 **b**\n### h3\n#### h4\n##### h5\n###### h6",
		);
		expect(blocks).toEqual([
			{ type: "heading", level: 1, content: [t("h1")] },
			{ type: "heading", level: 2, content: [t("h2 "), strong(t("b"))] },
			{ type: "heading", level: 3, content: [t("h3")] },
			{ type: "heading", level: 4, content: [t("h4")] },
			{ type: "heading", level: 5, content: [t("h5")] },
			{ type: "heading", level: 6, content: [t("h6")] },
		]);
	});

	test("#nospace is NOT a heading (hashtags stay text)", () => {
		const blocks = parseMarkdown("#hashtag");
		expect(blocks).toEqual([{ type: "text", lines: [[t("#hashtag")]] }]);
	});

	test("7+ hashes is NOT a heading", () => {
		const blocks = parseMarkdown("####### seven");
		expect(blocks).toEqual([{ type: "text", lines: [[t("####### seven")]] }]);
	});
});

describe("horizontal rule vs table delimiter", () => {
	test("a lone --- between prose is an hr", () => {
		const blocks = parseMarkdown("above\n\n---\n\nbelow");
		expect(blocks).toEqual([
			{ type: "text", lines: [[t("above")]] },
			{ type: "hr" },
			{ type: "text", lines: [[t("below")]] },
		]);
	});

	test("*** and ___ and ---- are hr too", () => {
		expect(parseMarkdown("***")).toEqual([{ type: "hr" }]);
		expect(parseMarkdown("___")).toEqual([{ type: "hr" }]);
		expect(parseMarkdown("----")).toEqual([{ type: "hr" }]);
	});

	test("-- (two dashes) is NOT an hr", () => {
		expect(parseMarkdown("--\ntext")).toEqual([
			{ type: "text", lines: [[t("--")], [t("text")]] },
		]);
	});

	test("--- under a matching header row is a TABLE, not an hr", () => {
		const blocks = parseMarkdown("| a |\n| --- |\n| 1 |");
		expect(blocks.map((b) => b.type)).toEqual(["table"]);
	});

	test("--- after a column-count-mismatched pipe line renders hr, NOT table", () => {
		// markdown-table.ts's guard: `a | b` (2 cols) + `---` (1 col) is not a
		// table. The lone --- then falls through to the hr rule.
		const blocks = parseMarkdown("a | b\n---\nc | d");
		expect(blocks).toEqual([
			{ type: "text", lines: [[t("a | b")]] },
			{ type: "hr" },
			{ type: "text", lines: [[t("c | d")]] },
		]);
	});

	test("an orphan piped delimiter row (no header) stays literal text", () => {
		const blocks = parseMarkdown("--- | ---");
		expect(blocks).toEqual([{ type: "text", lines: [[t("--- | ---")]] }]);
	});
});

describe("blockquotes", () => {
	test("consecutive > lines form one quote with inline parsing", () => {
		const blocks = parseMarkdown("> first **b**\n> second");
		expect(blocks).toEqual([
			{
				type: "blockquote",
				lines: [[t("first "), strong(t("b"))], [t("second")]],
			},
		]);
	});

	test("a bare > continues the quote as a blank line", () => {
		const blocks = parseMarkdown("> a\n>\n> b");
		expect(blocks).toEqual([
			{ type: "blockquote", lines: [[t("a")], [], [t("b")]] },
		]);
	});

	test("a blank line ends the quote", () => {
		const blocks = parseMarkdown("> a\n\n> b");
		expect(blocks).toEqual([
			{ type: "blockquote", lines: [[t("a")]] },
			{ type: "blockquote", lines: [[t("b")]] },
		]);
	});
});

describe("lists", () => {
	test("unordered list with - and * markers", () => {
		expect(parseMarkdown("- a\n- b")).toEqual([
			{
				type: "list",
				ordered: false,
				start: 1,
				items: [{ content: [t("a")] }, { content: [t("b")] }],
			},
		]);
		expect(parseMarkdown("* a\n* b")).toEqual([
			{
				type: "list",
				ordered: false,
				start: 1,
				items: [{ content: [t("a")] }, { content: [t("b")] }],
			},
		]);
	});

	test("ordered list preserves its start number", () => {
		expect(parseMarkdown("3. c\n4. d")).toEqual([
			{
				type: "list",
				ordered: true,
				start: 3,
				items: [{ content: [t("c")] }, { content: [t("d")] }],
			},
		]);
	});

	test("one nesting level via 2-space indent", () => {
		const blocks = parseMarkdown("- top\n  - sub1\n  - sub2\n- next");
		expect(blocks).toEqual([
			{
				type: "list",
				ordered: false,
				start: 1,
				items: [
					{
						content: [t("top")],
						sub: {
							ordered: false,
							start: 1,
							items: [{ content: [t("sub1")] }, { content: [t("sub2")] }],
						},
					},
					{ content: [t("next")] },
				],
			},
		]);
	});

	test("marker type switch at top level splits into two lists", () => {
		const blocks = parseMarkdown("- a\n1. b");
		expect(blocks.map((b) => b.type)).toEqual(["list", "list"]);
		const first = blocks[0];
		const second = blocks[1];
		if (first?.type !== "list" || second?.type !== "list")
			throw new Error("expected lists");
		expect(first.ordered).toBe(false);
		expect(second.ordered).toBe(true);
	});

	test("*noSpace is NOT a list item (stays text, em rules apply)", () => {
		expect(parseMarkdown("*notlist")).toEqual([
			{ type: "text", lines: [[t("*notlist")]] },
		]);
	});

	test("a negative number like -5 is NOT a list item", () => {
		expect(parseMarkdown("-5 degrees")).toEqual([
			{ type: "text", lines: [[t("-5 degrees")]] },
		]);
	});

	test("list item content is inline-parsed (links, code, bold)", () => {
		const blocks = parseMarkdown("- see [x](https://x.dev) and `y`");
		expect(blocks).toEqual([
			{
				type: "list",
				ordered: false,
				start: 1,
				items: [
					{
						content: [
							t("see "),
							link("https://x.dev", t("x")),
							t(" and "),
							code("y"),
						],
					},
				],
			},
		]);
	});

	test("blank line ends the list", () => {
		const blocks = parseMarkdown("- a\n\n- b");
		expect(blocks.map((b) => b.type)).toEqual(["list", "list"]);
	});
});

describe("text runs", () => {
	test("interior blank lines are preserved verbatim", () => {
		const blocks = parseMarkdown("# h\nline1\n\nline2");
		expect(blocks).toEqual([
			{ type: "heading", level: 1, content: [t("h")] },
			{ type: "text", lines: [[t("line1")], [], [t("line2")]] },
		]);
	});

	test("blank edges adjacent to blocks are trimmed", () => {
		const blocks = parseMarkdown("intro\n\n# h\n\nafter");
		expect(blocks).toEqual([
			{ type: "text", lines: [[t("intro")]] },
			{ type: "heading", level: 1, content: [t("h")] },
			{ type: "text", lines: [[t("after")]] },
		]);
	});
});

// ═════════════════════════════════════════════════════════════════════════
// Plain-text fallback contract
// ═════════════════════════════════════════════════════════════════════════

describe("plain-text fallback (isPlainText)", () => {
	test("prose with blank lines and no constructs is plain", () => {
		expect(isPlainText(parseMarkdown("hello world\n\nsecond para"))).toBe(true);
	});

	test("empty string is plain", () => {
		expect(isPlainText(parseMarkdown(""))).toBe(true);
	});

	test("punctuation-heavy prose without constructs is plain", () => {
		expect(
			isPlainText(parseMarkdown("a | b (see #3) 2 * 3 = 6, path\\to\\file")),
		).toBe(true);
	});

	test("an unsafe link alone is still plain (renders as literal text)", () => {
		expect(isPlainText(parseMarkdown("[x](javascript:alert(1))"))).toBe(true);
	});

	test("each construct flips plain → false", () => {
		expect(isPlainText(parseMarkdown("**b**"))).toBe(false);
		expect(isPlainText(parseMarkdown("*i*"))).toBe(false);
		expect(isPlainText(parseMarkdown("`c`"))).toBe(false);
		expect(isPlainText(parseMarkdown("[a](https://x.dev)"))).toBe(false);
		expect(isPlainText(parseMarkdown("# h"))).toBe(false);
		expect(isPlainText(parseMarkdown("- item"))).toBe(false);
		expect(isPlainText(parseMarkdown("> quote"))).toBe(false);
		expect(isPlainText(parseMarkdown("---"))).toBe(false);
		expect(isPlainText(parseMarkdown("```\nx\n```"))).toBe(false);
		expect(isPlainText(parseMarkdown("| a |\n| --- |"))).toBe(false);
	});
});

// ═════════════════════════════════════════════════════════════════════════
// Whole-document composition
// ═════════════════════════════════════════════════════════════════════════

describe("composition", () => {
	test("a full reply composes all block types in source order", () => {
		const text = [
			"## Plan",
			"",
			"Steps to take:",
			"",
			"1. First",
			"2. Second",
			"",
			"> note **this**",
			"",
			"---",
			"",
			"| k | v |",
			"| --- | --- |",
			"| a | 1 |",
			"",
			"```sh",
			"echo done",
			"```",
			"",
			"Done.",
		].join("\n");
		const blocks = parseMarkdown(text);
		expect(blocks.map((b) => b.type)).toEqual([
			"heading",
			"text",
			"list",
			"blockquote",
			"hr",
			"table",
			"code_block",
			"text",
		]);
	});
});
