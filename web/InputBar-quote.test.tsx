/// <reference lib="dom" />
/**
 * InputBar select-to-quote insertion: a QuoteRequest prop change prepends the
 * selection as a markdown blockquote to the draft and focuses the textarea.
 *
 * Covers:
 *   - quote into an empty draft (+ focus, cursor at end)
 *   - quote PREPENDED to an existing draft (draft preserved)
 *   - same text quoted twice (seq bump) applies twice
 *   - no quoteRequest → draft untouched
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

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	localStorage.clear();
});

async function waitFor<T>(
	fn: () => T,
	timeoutMs = 1000,
): Promise<NonNullable<T>> {
	const start = Date.now();
	for (;;) {
		const value = fn();
		if (value) return value as NonNullable<T>;
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 5));
	}
}

/**
 * Render InputBar inside LocaleProvider; returns a rerender function that
 * swaps props on the same root (how Plugin.tsx delivers quote requests).
 */
async function renderInputBar(initial?: {
	quoteRequest?: { text: string; seq: number } | null;
}) {
	const { createRoot } = await import("react-dom/client");
	const { createElement } = await import("react");
	const { InputBar } = await import(
		"../.mxd/plugin/web/components/InputBar.tsx"
	);
	const { LocaleProvider } = await import("../.mxd/plugin/web/i18n.ts");

	const div = document.createElement("div");
	document.body.appendChild(div);
	const root = createRoot(div);

	const render = (props?: {
		quoteRequest?: { text: string; seq: number } | null;
	}) => {
		root.render(
			createElement(
				LocaleProvider,
				null,
				createElement(InputBar, {
					projectId: "proj-1",
					targetNodeId: "node-quote-test",
					nodeMap: new Map(),
					onSend: () => {},
					quoteRequest: props?.quoteRequest ?? null,
				}),
			),
		);
	};

	render(initial);
	const textarea = await waitFor(() =>
		div.querySelector<HTMLTextAreaElement>("textarea.mxd-prompt-input"),
	);

	cleanups.push(() => {
		root.unmount();
		div.remove();
	});
	return { div, textarea, rerender: render };
}

describe("InputBar quote insertion", () => {
	test("quote request fills an empty draft and focuses the textarea", async () => {
		const { textarea, rerender } = await renderInputBar();
		expect(textarea.value).toBe("");

		rerender({ quoteRequest: { text: "selected log text", seq: 1 } });
		await waitFor(() => textarea.value !== "");

		expect(textarea.value).toBe("> selected log text\n\n");
		await waitFor(() => document.activeElement === textarea);
		// Cursor at the end, ready to type the question
		expect(textarea.selectionStart).toBe(textarea.value.length);
	});

	test("quote is prepended to an existing draft, draft preserved below", async () => {
		// Pre-seed the draft the way InputBar restores it (localStorage)
		localStorage.setItem("mxd-prompt-draft:node-quote-test", "my question");
		const { textarea, rerender } = await renderInputBar();
		expect(textarea.value).toBe("my question");

		rerender({ quoteRequest: { text: "line one\nline two", seq: 1 } });
		await waitFor(() => textarea.value.startsWith(">"));

		expect(textarea.value).toBe("> line one\n> line two\n\nmy question");
	});

	test("quoting the same text twice (seq bump) applies twice", async () => {
		const { textarea, rerender } = await renderInputBar();

		rerender({ quoteRequest: { text: "same text", seq: 1 } });
		await waitFor(() => textarea.value !== "");
		expect(textarea.value).toBe("> same text\n\n");

		rerender({ quoteRequest: { text: "same text", seq: 2 } });
		await waitFor(() => textarea.value.length > "> same text\n\n".length);
		expect(textarea.value).toBe("> same text\n\n> same text\n\n");
	});

	test("no quote request leaves the draft untouched", async () => {
		localStorage.setItem("mxd-prompt-draft:node-quote-test", "typed draft");
		const { textarea } = await renderInputBar();
		await new Promise((r) => setTimeout(r, 30));
		expect(textarea.value).toBe("typed draft");
	});
});
