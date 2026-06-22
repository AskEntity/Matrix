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
