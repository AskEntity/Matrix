/// <reference lib="dom" />
/**
 * Regression guard: compacted_resume message renders a compact summary card
 * showing the real summary content (body.content), NOT the old placeholder
 * "Session resumed from checkpoint".
 *
 * Covered:
 *   - Card header shows "Compact Summary" (via t("compact.summaryTitle"))
 *   - Card uses the existing compact-boundary / compact-label visual language
 *   - Default-collapsed: summary content is NOT in DOM on first render
 *   - Click-to-expand: summary content appears in DOM, preserving newlines
 *   - Placeholder string "Session resumed from checkpoint" is never rendered
 *     (mutation-proof — reverting event-display.ts / LogEntryView.tsx back to
 *     the placeholder would make the "no placeholder" assertion fail)
 *
 * This exercises the full rendering path: createLogEntry + LocaleProvider +
 * LogEntryView (what ActivityLog uses in production). No mocks between.
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

/** Render LogEntryView with the given LogEntry and return the container div. */
async function renderLogEntry(
	entryInput: Parameters<
		typeof import("../.mxd/plugin/web/hooks.ts")["createLogEntry"]
	>[0],
): Promise<{ div: HTMLDivElement; unmount: () => void }> {
	const { createRoot } = await import("react-dom/client");
	const { createElement } = await import("react");
	const { LogEntryView } = await import(
		"../.mxd/plugin/web/components/tools/LogEntryView.tsx"
	);
	const { LocaleProvider } = await import("../.mxd/plugin/web/i18n.ts");
	const { createLogEntry } = await import("../.mxd/plugin/web/hooks.ts");

	const entry = createLogEntry(entryInput);

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

/** Construct a compacted_resume message entry shape with the given content. */
function compactedResumeEntry(
	content: string,
	id = "cr-test-1",
	taskId = "task-a",
): Parameters<
	typeof import("../.mxd/plugin/web/hooks.ts")["createLogEntry"]
>[0] {
	return {
		type: "message",
		id,
		body: {
			source: "compacted_resume",
			id,
			ts: 2001,
			content,
		},
		taskId,
		ts: 2001,
	};
}

describe("LogEntryView: compacted_resume summary card", () => {
	test("renders the compact-summary card with i18n header, collapsed by default", async () => {
		// The card's collapsed shape is the thing users see first.
		// Assertions here pin the visible shell: boundary wrapper, ◈ label,
		// and that content is NOT yet in DOM (Card is closed).
		const SUMMARY = "Specific marker text 12345 — worked on X, then Y.";
		const { div, unmount } = await renderLogEntry(
			compactedResumeEntry(SUMMARY),
		);

		// Visual cousin of compact_marker: uses mxd-compact-boundary wrapper
		// and mxd-compact-label for the ◈ glyph + purple text style.
		const boundary = div.querySelector(
			".mxd-compact-boundary.mxd-compact-summary",
		);
		expect(boundary).toBeTruthy();

		const label = div.querySelector(".mxd-compact-label");
		expect(label).toBeTruthy();
		expect(label?.textContent).toContain("Compact Summary");
		expect(label?.textContent).toContain("◈");

		// Default-collapsed → content is not yet rendered in DOM.
		const contentEl = div.querySelector(".mxd-compact-summary-content");
		expect(contentEl).toBeNull();

		// Mutation proof: the old placeholder "Session resumed from checkpoint"
		// must NEVER appear. If a future agent reverts event-display.ts or
		// LogEntryView.tsx back to the placeholder, this assertion fails.
		expect(div.textContent ?? "").not.toContain(
			"Session resumed from checkpoint",
		);

		unmount();
	});

	test("clicking the card header expands and reveals the real summary content (preserves newlines)", async () => {
		// Real summaries are narrative text with paragraph breaks. Expanding
		// must render the entire body.content — no truncation, no markdown
		// parsing. Preserve \n so `white-space: pre-wrap` in CSS works.
		const SUMMARY = [
			"Specific marker text 12345 — worked on module X.",
			"",
			"You were mid-investigation of feature Y when context filled up.",
			"Next step: finish the refactor in `src/foo.ts`.",
		].join("\n");

		const { div, unmount } = await renderLogEntry(
			compactedResumeEntry(SUMMARY),
		);

		// Simulate user clicking the collapsible header to expand.
		const header = div.querySelector(
			".mxd-tool-card-compact-summary .mxd-tool-card-header",
		) as HTMLButtonElement | null;
		expect(header).toBeTruthy();
		header?.click();
		await new Promise((r) => setTimeout(r, 10));

		// Expanded: content element is now in DOM, bearing the full summary.
		const contentEl = div.querySelector(".mxd-compact-summary-content");
		expect(contentEl).toBeTruthy();

		// Real content — no placeholder, no truncation.
		expect(contentEl?.textContent).toBe(SUMMARY);

		// Newline preservation (sanity for pre-wrap downstream styling).
		expect(contentEl?.textContent ?? "").toContain(
			"Specific marker text 12345",
		);
		expect(contentEl?.textContent ?? "").toContain("Next step:");

		// Still no placeholder anywhere.
		expect(div.textContent ?? "").not.toContain(
			"Session resumed from checkpoint",
		);

		unmount();
	});

	test("long narrative summary (thousands of chars) renders verbatim after expand", async () => {
		// Production summaries are hundreds of lines. Exercise a big body
		// to confirm there's no implicit slicing / truncation inside the
		// card. Content length should match byte-for-byte.
		const LINE = "This is a narrative summary line for compaction audit. ";
		const SUMMARY = Array.from({ length: 120 }, (_, i) => `${i}. ${LINE}`).join(
			"\n",
		);

		const { div, unmount } = await renderLogEntry(
			compactedResumeEntry(SUMMARY),
		);

		const header = div.querySelector(
			".mxd-tool-card-compact-summary .mxd-tool-card-header",
		) as HTMLButtonElement | null;
		header?.click();
		await new Promise((r) => setTimeout(r, 10));

		const contentEl = div.querySelector(".mxd-compact-summary-content");
		expect(contentEl).toBeTruthy();
		expect(contentEl?.textContent?.length).toBe(SUMMARY.length);
		expect(contentEl?.textContent).toBe(SUMMARY);

		unmount();
	});
});
