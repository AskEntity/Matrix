/// <reference lib="dom" />
/**
 * Canonical user journey for select-to-quote ("Ask Matrix") in the activity
 * log: the user selects text in a log entry, a floating "Ask Matrix" button
 * appears, clicking it hands the selected text to onQuoteText and dismisses
 * the button + selection.
 *
 * Also covers dismissal paths (Escape, selection collapse) and the negative
 * cases (selection outside the log, whitespace-only selection, no callback).
 *
 * happy-dom implements Selection/Range well enough for this flow; only
 * getBoundingClientRect returns zeros, so button POSITION math is covered by
 * the pure-function tests in web/quote.test.ts instead.
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
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

const TEXT_A = "The quick brown fox jumps over the lazy dog";
const TEXT_B = "Second entry with more content";

type Cleanup = () => void;
const cleanups: Cleanup[] = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	window.getSelection()?.removeAllRanges();
});

/** Poll until fn() is truthy (returns it) or the timeout elapses (throws). */
async function waitFor<T>(
	fn: () => T,
	timeoutMs = 1000,
): Promise<NonNullable<T>> {
	const start = Date.now();
	for (;;) {
		const value = fn();
		if (value) return value as NonNullable<T>;
		if (Date.now() - start > timeoutMs) {
			throw new Error("waitFor timed out");
		}
		await new Promise((r) => setTimeout(r, 5));
	}
}

/** Render ActivityLog with two assistant_text entries + a quote spy. */
async function renderLog(opts?: { withQuoteCallback?: boolean }) {
	const { createRoot } = await import("react-dom/client");
	const { createElement } = await import("react");
	const { ActivityLog } = await import(
		"../.mxd/plugin/web/components/ActivityLog.tsx"
	);
	const { LocaleProvider } = await import("../.mxd/plugin/web/i18n.ts");
	const { createLogEntry } = await import("../.mxd/plugin/web/hooks.ts");

	const entries = [
		createLogEntry({
			type: "assistant_text",
			content: TEXT_A,
			taskId: "root-1",
			ts: 1000,
		} as Parameters<typeof createLogEntry>[0]),
		createLogEntry({
			type: "assistant_text",
			content: TEXT_B,
			taskId: "root-1",
			ts: 2000,
		} as Parameters<typeof createLogEntry>[0]),
	];

	const quoteCalls: string[] = [];
	const onQuoteText =
		opts?.withQuoteCallback === false
			? undefined
			: (text: string) => quoteCalls.push(text);

	const div = document.createElement("div");
	document.body.appendChild(div);
	// An element OUTSIDE the log for negative selection tests
	const outside = document.createElement("p");
	outside.textContent = "text outside the activity log";
	document.body.appendChild(outside);

	const root = createRoot(div);
	root.render(
		createElement(
			LocaleProvider,
			null,
			createElement(ActivityLog, {
				entries,
				filterTaskId: null,
				rootNodeId: "root-1",
				nodeMap: new Map(),
				autoScroll: false,
				onAutoScrollChange: () => {},
				activity: undefined,
				projectId: "proj-1",
				onQuoteText,
			}),
		),
	);
	// Wait for the log content to be committed. React runs the selection
	// listener effect at commit time, so once the text is visible the
	// document-level mouseup listener is attached (plus one settle tick).
	await waitFor(() => div.textContent?.includes(TEXT_B));
	await new Promise((r) => setTimeout(r, 10));

	cleanups.push(() => {
		root.unmount();
		div.remove();
		outside.remove();
	});
	return { div, outside, quoteCalls };
}

/** Find the DOM text node containing the given string. */
function findTextNode(rootEl: Element, needle: string): Text {
	const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
	let node = walker.nextNode();
	while (node) {
		if (node.textContent?.includes(needle)) return node as Text;
		node = walker.nextNode();
	}
	throw new Error(`text node containing ${JSON.stringify(needle)} not found`);
}

/** Select [start, end) inside the text node containing needle, then mouseup. */
async function selectAndMouseUp(
	scope: Element,
	needle: string,
	start: number,
	end: number,
) {
	const textNode = findTextNode(scope, needle);
	const offset = textNode.textContent?.indexOf(needle) ?? 0;
	const range = document.createRange();
	range.setStart(textNode, offset + start);
	range.setEnd(textNode, offset + end);
	const sel = window.getSelection();
	sel?.removeAllRanges();
	sel?.addRange(range);
	document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
	await new Promise((r) => setTimeout(r, 20));
}

function quoteButton(): HTMLButtonElement | null {
	return document.querySelector<HTMLButtonElement>(".mxd-selection-quote-btn");
}

describe("select-to-quote in the activity log", () => {
	test("canonical journey: select → button appears → click → onQuoteText(text) + dismissed", async () => {
		const { div, quoteCalls } = await renderLog();

		// "quick brown fox" from TEXT_A
		await selectAndMouseUp(div, TEXT_A, 4, 19);

		const btn = await waitFor(quoteButton);
		expect(btn.textContent).toContain("Ask Matrix");

		btn.click();
		await waitFor(() => quoteCalls.length > 0);

		expect(quoteCalls).toEqual(["quick brown fox"]);
		// Button dismissed and the selection cleared after the click
		await waitFor(() => quoteButton() === null);
		expect(window.getSelection()?.toString() ?? "").toBe("");
	});

	test("Escape dismisses the button without quoting", async () => {
		const { div, quoteCalls } = await renderLog();
		await selectAndMouseUp(div, TEXT_B, 0, 6);
		await waitFor(quoteButton);

		document.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
		);
		await waitFor(() => quoteButton() === null);

		expect(quoteCalls).toEqual([]);
	});

	test("collapsing the selection (click elsewhere) dismisses the button", async () => {
		const { div } = await renderLog();
		await selectAndMouseUp(div, TEXT_A, 0, 9);
		await waitFor(quoteButton);

		// Clearing the selection fires selectionchange → dismissal
		window.getSelection()?.removeAllRanges();
		await waitFor(() => quoteButton() === null);
	});

	test("selection outside the log container shows no button", async () => {
		const { outside } = await renderLog();
		await selectAndMouseUp(outside, "outside the activity log", 0, 7);
		expect(quoteButton()).toBeNull();
	});

	test("whitespace-only selection shows no button", async () => {
		const { div } = await renderLog();
		// The space between "quick" and "brown" (offset 9..10 = " ")
		await selectAndMouseUp(div, TEXT_A, 9, 10);
		expect(quoteButton()).toBeNull();
	});

	test("without onQuoteText no button appears (showcase/legacy callers)", async () => {
		const { div } = await renderLog({ withQuoteCallback: false });
		await selectAndMouseUp(div, TEXT_A, 4, 19);
		expect(quoteButton()).toBeNull();
	});

	test("selecting across two entries quotes the multi-line text", async () => {
		const { div, quoteCalls } = await renderLog();

		// Range from inside entry A to inside entry B (crosses entry boundary)
		const nodeA = findTextNode(div, TEXT_A);
		const nodeB = findTextNode(div, TEXT_B);
		const range = document.createRange();
		range.setStart(nodeA, nodeA.textContent?.indexOf("lazy") ?? 0);
		range.setEnd(nodeB, (nodeB.textContent?.indexOf("Second") ?? 0) + 6);
		const sel = window.getSelection();
		sel?.removeAllRanges();
		sel?.addRange(range);
		document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

		const btn = await waitFor(quoteButton);
		btn.click();
		await waitFor(() => quoteCalls.length > 0);

		expect(quoteCalls.length).toBe(1);
		const quoted = quoteCalls[0] ?? "";
		expect(quoted).toContain("lazy dog");
		expect(quoted).toContain("Second");
	});
});
