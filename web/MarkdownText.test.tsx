/// <reference lib="dom" />
/**
 * Integration tests for markdown TABLE rendering in the activity log.
 *
 * Exercises the full production path: createLogEntry → LocaleProvider →
 * LogEntryView (assistant_text branch) → MarkdownText. This is the canonical
 * user journey: an agent reply containing a markdown table must render as a
 * real, aligned <table> the user can copy — not raw pipe text.
 *
 * Covered:
 *   - No-table reply renders the plain .mxd-lmxd-text span (byte-identical to
 *     the previous behavior — zero regression for the common case)
 *   - A table reply renders a real <table> with correct headers/cells/alignment
 *   - The copy button copies the ORIGINAL markdown source to the clipboard
 *   - Mixed prose + table renders both, in order
 *   - Cell content is escaped (no HTML injection — XSS guard)
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

beforeAll(() => {
	GlobalRegistrator.register();
	(
		globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
	).IS_REACT_ACT_ENVIRONMENT = false;
});

afterAll(async () => {
	await new Promise((r) => setTimeout(r, 20));
	GlobalRegistrator.unregister();
});

/** Render LogEntryView for an assistant_text entry; return the container div. */
async function renderAssistantText(
	content: string,
): Promise<{ div: HTMLDivElement; unmount: () => void }> {
	const { createRoot } = await import("react-dom/client");
	const { createElement } = await import("react");
	const { LogEntryView } = await import(
		"../.mxd/plugin/web/components/tools/LogEntryView.tsx"
	);
	const { LocaleProvider } = await import("../.mxd/plugin/web/i18n.ts");
	const { createLogEntry } = await import("../.mxd/plugin/web/hooks.ts");

	const entry = createLogEntry({
		type: "assistant_text",
		content,
		taskId: "task-a",
		ts: 1000,
	} as Parameters<typeof createLogEntry>[0]);

	const div = document.createElement("div");
	document.body.appendChild(div);
	const root = createRoot(div);
	root.render(
		createElement(
			LocaleProvider,
			null,
			createElement(LogEntryView, {
				entry,
				nodeMap: new Map(),
				projectId: "proj-1",
				rootNodeId: "root-a",
			}),
		),
	);
	await new Promise((r) => setTimeout(r, 10));
	return {
		div,
		unmount: () => {
			root.unmount();
			div.remove();
		},
	};
}

const TABLE_MD = [
	"| Option | Speed | Notes |",
	"| :--- | ---: | :---: |",
	"| Alpha | 10 | good |",
	"| Beta | 200 | better |",
].join("\n");

describe("markdown table rendering in activity log", () => {
	test("plain reply (no table) renders the unchanged .mxd-lmxd-text span", async () => {
		const TEXT = "Just a normal reply.\nNo tables here.";
		const { div, unmount } = await renderAssistantText(TEXT);

		// No table element, no .mxd-md wrapper — identical to prior behavior.
		expect(div.querySelector("table")).toBeNull();
		expect(div.querySelector(".mxd-md")).toBeNull();

		const span = div.querySelector(".mxd-lmxd-text");
		expect(span).toBeTruthy();
		expect(span?.tagName.toLowerCase()).toBe("span");
		expect(span?.textContent).toBe(TEXT);

		unmount();
	});

	test("a reply with a markdown table renders a real <table> with headers + cells", async () => {
		const { div, unmount } = await renderAssistantText(
			`Comparison below:\n\n${TABLE_MD}`,
		);

		const table = div.querySelector("table.mxd-md-table");
		expect(table).toBeTruthy();

		// Headers
		const ths = Array.from(table?.querySelectorAll("thead th") ?? []);
		expect(ths.map((th) => th.textContent)).toEqual([
			"Option",
			"Speed",
			"Notes",
		]);

		// Body rows / cells
		const rows = Array.from(table?.querySelectorAll("tbody tr") ?? []);
		expect(rows).toHaveLength(2);
		const firstRow = Array.from(rows[0]?.querySelectorAll("td") ?? []).map(
			(td) => td.textContent,
		);
		expect(firstRow).toEqual(["Alpha", "10", "good"]);
		const secondRow = Array.from(rows[1]?.querySelectorAll("td") ?? []).map(
			(td) => td.textContent,
		);
		expect(secondRow).toEqual(["Beta", "200", "better"]);

		unmount();
	});

	test("column alignment from the delimiter row is applied to cells", async () => {
		const { div, unmount } = await renderAssistantText(TABLE_MD);
		const ths = Array.from(
			div.querySelectorAll("thead th"),
		) as HTMLTableCellElement[];
		// `:---` left, `---:` right, `:---:` center
		expect(ths[0]?.style.textAlign).toBe("left");
		expect(ths[1]?.style.textAlign).toBe("right");
		expect(ths[2]?.style.textAlign).toBe("center");
		unmount();
	});

	test("copy button copies the ORIGINAL markdown source to the clipboard", async () => {
		// Stub the clipboard so we can capture what gets written. Use a holder
		// object (not a bare `let`) so TS doesn't narrow the closure-assigned
		// value back to its `null` initializer at the assertion below.
		const clip: { value: string | null } = { value: null };
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: async (s: string) => {
					clip.value = s;
				},
			},
		});

		const { div, unmount } = await renderAssistantText(`See:\n\n${TABLE_MD}`);

		const btn = div.querySelector(
			".mxd-md-table-copy",
		) as HTMLButtonElement | null;
		expect(btn).toBeTruthy();
		expect(btn?.textContent).toBe("Copy");

		btn?.click();
		await new Promise((r) => setTimeout(r, 10));

		// The exact markdown table block (not the surrounding prose) is copied —
		// so it can be re-pasted into another markdown surface verbatim.
		expect(clip.value).toBe(TABLE_MD);
		// Label flips to the "copied" confirmation.
		expect(btn?.textContent).toBe("Copied");

		unmount();
	});

	test("mixed prose + table renders both, prose preserved", async () => {
		const { div, unmount } = await renderAssistantText(
			`Here are the options:\n\n${TABLE_MD}\n\nPick Alpha.`,
		);
		// Table present.
		expect(div.querySelector("table.mxd-md-table")).toBeTruthy();
		// Prose blocks present and carry the surrounding text.
		const textBlocks = Array.from(div.querySelectorAll(".mxd-md-text")).map(
			(b) => b.textContent ?? "",
		);
		expect(textBlocks.some((t) => t.includes("Here are the options:"))).toBe(
			true,
		);
		expect(textBlocks.some((t) => t.includes("Pick Alpha."))).toBe(true);
		unmount();
	});

	test("XSS guard: HTML-looking cell content is rendered as TEXT, not markup", async () => {
		const EVIL = [
			"| Name | Payload |",
			"| --- | --- |",
			"| x | <img src=x onerror=alert(1)> |",
			"| y | <b>bold</b> |",
		].join("\n");
		const { div, unmount } = await renderAssistantText(EVIL);

		// No injected element from the cell content.
		expect(div.querySelector("img")).toBeNull();
		expect(div.querySelector("b")).toBeNull();

		// The literal markup text is present as cell text content.
		const cells = Array.from(div.querySelectorAll("tbody td")).map(
			(td) => td.textContent,
		);
		expect(cells).toContain("<img src=x onerror=alert(1)>");
		expect(cells).toContain("<b>bold</b>");

		unmount();
	});
});

describe("full lightweight markdown rendering in activity log", () => {
	test("a composite reply renders headings, emphasis, list, quote, link, hr", async () => {
		const MD = [
			"## Plan",
			"",
			"We need **bold**, *italic*, ~~strike~~ and `inline code`.",
			"",
			"- first item",
			"- second item",
			"",
			"1. step one",
			"2. step two",
			"",
			"> a **quoted** note",
			"",
			"---",
			"",
			"See [the docs](https://example.com/x) for details.",
		].join("\n");
		const { div, unmount } = await renderAssistantText(MD);

		// Heading, modest tag + class.
		const h2 = div.querySelector("h2.mxd-md-h");
		expect(h2?.textContent).toBe("Plan");

		// Inline styles.
		expect(div.querySelector("strong")?.textContent).toBe("bold");
		expect(div.querySelector("em")?.textContent).toBe("italic");
		expect(div.querySelector("del")?.textContent).toBe("strike");
		expect(div.querySelector("code.mxd-md-code-inline")?.textContent).toBe(
			"inline code",
		);

		// Lists.
		const ulItems = Array.from(div.querySelectorAll("ul.mxd-md-list li")).map(
			(li) => li.textContent,
		);
		expect(ulItems).toEqual(["first item", "second item"]);
		const olItems = Array.from(div.querySelectorAll("ol.mxd-md-list li")).map(
			(li) => li.textContent,
		);
		expect(olItems).toEqual(["step one", "step two"]);

		// Blockquote with nested inline parsing.
		const quote = div.querySelector("blockquote.mxd-md-quote");
		expect(quote?.textContent).toBe("a quoted note");
		expect(quote?.querySelector("strong")?.textContent).toBe("quoted");

		// Horizontal rule.
		expect(div.querySelector("hr.mxd-md-hr")).toBeTruthy();

		// Safe link with hardened rel/target.
		const a = div.querySelector("a.mxd-md-link") as HTMLAnchorElement | null;
		expect(a?.getAttribute("href")).toBe("https://example.com/x");
		expect(a?.getAttribute("target")).toBe("_blank");
		expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
		expect(a?.textContent).toBe("the docs");

		unmount();
	});

	test("javascript: link renders as literal text — no anchor in the DOM", async () => {
		const { div, unmount } = await renderAssistantText(
			"Click [here](javascript:alert(1)) — also **bold** so markdown mode is on.",
		);
		expect(div.querySelector("a")).toBeNull();
		expect(div.textContent).toContain("[here](javascript:alert(1))");
		// Sanity: markdown mode really was active (not the plain fallback).
		expect(div.querySelector("strong")).toBeTruthy();
		unmount();
	});

	test("fenced code protects table-shaped text — <pre> yes, <table> no", async () => {
		const MD = ["```", "| a | b |", "| --- | --- |", "| 1 | 2 |", "```"].join(
			"\n",
		);
		const { div, unmount } = await renderAssistantText(MD);

		expect(div.querySelector("table")).toBeNull();
		const pre = div.querySelector("pre.mxd-md-code-block");
		expect(pre?.textContent).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
		unmount();
	});

	test("code block copy button copies the verbatim content", async () => {
		const clip: { value: string | null } = { value: null };
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: async (s: string) => {
					clip.value = s;
				},
			},
		});

		const { div, unmount } = await renderAssistantText(
			"```ts\nconst x = 1;\nconsole.log(x);\n```",
		);
		const btn = div.querySelector(
			".mxd-md-code-copy",
		) as HTMLButtonElement | null;
		expect(btn).toBeTruthy();
		btn?.click();
		await new Promise((r) => setTimeout(r, 10));
		expect(clip.value).toBe("const x = 1;\nconsole.log(x);");
		expect(btn?.textContent).toBe("Copied");
		unmount();
	});

	test("markdown-symbol-free reply with * math stays a plain single span", async () => {
		const TEXT = "Compute 2 * 3 * 4 and 5 ** 2 (see item #3).";
		const { div, unmount } = await renderAssistantText(TEXT);
		expect(div.querySelector(".mxd-md")).toBeNull();
		const span = div.querySelector(".mxd-lmxd-text");
		expect(span?.tagName.toLowerCase()).toBe("span");
		expect(span?.textContent).toBe(TEXT);
		unmount();
	});

	test("HTML in markdown text renders escaped (XSS guard for inline path)", async () => {
		const { div, unmount } = await renderAssistantText(
			"**bold** then <script>alert(1)</script> and <img src=x onerror=alert(2)>",
		);
		expect(div.querySelector("script")).toBeNull();
		expect(div.querySelector("img")).toBeNull();
		expect(div.textContent).toContain("<script>alert(1)</script>");
		unmount();
	});
});
