/// <reference lib="dom" />
/**
 * ActivityLog's two rollback-facing props:
 *
 *  - `scrollToBottomRequest` — a monotonic counter meaning "jump to now".
 *    A rollback replaces the whole `entries` array with a SHORTER one, which
 *    invalidates the current scroll offset (same class of bug as "Load
 *    earlier history", fixed with the bottom-relative anchor right above this
 *    effect). Here the intent is the opposite end: land at the bottom, after
 *    the new entries commit.
 *  - `editingEid` — marks the message currently loaded into the composer.
 *
 * happy-dom does no layout, so scrollHeight/clientHeight are mocked;
 * scrollTop assignment works natively.
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

type RenderOpts = {
	entryCount: number;
	scrollToBottomRequest?: number;
	editingEid?: string | null;
	autoScroll?: boolean;
};

async function setup() {
	const { createRoot } = await import("react-dom/client");
	const { createElement } = await import("react");
	const { ActivityLog } = await import(
		"../.mxd/plugin/web/components/ActivityLog.tsx"
	);
	const { LocaleProvider } = await import("../.mxd/plugin/web/i18n.ts");
	const { createLogEntry } = await import("../.mxd/plugin/web/hooks.ts");

	/** n user messages, each with a stable eid (eid-0, eid-1, …). */
	const makeEntries = (count: number) =>
		Array.from({ length: count }, (_, i) =>
			createLogEntry({
				type: "message",
				id: `msg-${i}`,
				eid: `eid-${i}`,
				body: { source: "user", content: `user message ${i}` },
				taskId: "root-1",
				ts: 1000 + i,
			} as unknown as Parameters<typeof createLogEntry>[0]),
		);

	const div = document.createElement("div");
	document.body.appendChild(div);
	const root = createRoot(div);

	const render = (opts: RenderOpts) =>
		root.render(
			createElement(
				LocaleProvider,
				null,
				createElement(ActivityLog, {
					entries: makeEntries(opts.entryCount),
					filterTaskId: null,
					rootNodeId: "root-1",
					nodeMap: new Map(),
					autoScroll: opts.autoScroll ?? false,
					onAutoScrollChange: () => {},
					activity: undefined,
					projectId: "proj-1",
					onEdit: () => {},
					onRollback: () => {},
					editingEid: opts.editingEid ?? null,
					scrollToBottomRequest: opts.scrollToBottomRequest ?? 0,
				}),
			),
		);

	cleanups.push(() => {
		root.unmount();
		div.remove();
	});
	return { div, render };
}

/** Renders 5 messages, scrolled up, geometry mocked. */
async function scrolledUpLog(editingEid?: string | null) {
	const { div, render } = await setup();
	render({ entryCount: 5, scrollToBottomRequest: 0, editingEid });
	const container = await waitFor(() =>
		div.querySelector<HTMLElement>(".mxd-activity-log"),
	);
	Object.defineProperty(container, "scrollHeight", {
		value: 1000,
		configurable: true,
	});
	Object.defineProperty(container, "clientHeight", {
		value: 300,
		configurable: true,
	});
	container.scrollTop = 120;
	await new Promise((r) => setTimeout(r, 20));
	container.scrollTop = 120;
	return { div, render, container };
}

describe("ActivityLog — scrollToBottomRequest", () => {
	test("a bumped request lands at the bottom even when entries shrink", async () => {
		const { render, container } = await scrolledUpLog();

		// The rollback shape: shorter entries + a request bump, one batch.
		render({ entryCount: 2, scrollToBottomRequest: 1 });
		await waitFor(() => container.scrollTop === 1000);
		expect(container.scrollTop).toBe(1000);
	});

	test("MUTATION PROOF: replacing entries WITHOUT a request leaves the offset", async () => {
		const { render, container } = await scrolledUpLog();

		render({ entryCount: 2, scrollToBottomRequest: 0 });
		await new Promise((r) => setTimeout(r, 60));
		expect(container.scrollTop).toBe(120);
	});

	test("repeat requests keep working (counter, not a boolean)", async () => {
		const { render, container } = await scrolledUpLog();

		render({ entryCount: 3, scrollToBottomRequest: 1 });
		await waitFor(() => container.scrollTop === 1000);

		container.scrollTop = 40;
		render({ entryCount: 3, scrollToBottomRequest: 1 }); // same value → no-op
		await new Promise((r) => setTimeout(r, 40));
		expect(container.scrollTop).toBe(40);

		render({ entryCount: 3, scrollToBottomRequest: 2 }); // bumped → applies
		await waitFor(() => container.scrollTop === 1000);
		expect(container.scrollTop).toBe(1000);
	});

	test("mounting with a non-zero request does not force a scroll", async () => {
		const { div, render } = await setup();
		render({ entryCount: 3, scrollToBottomRequest: 7 });
		const container = await waitFor(() =>
			div.querySelector<HTMLElement>(".mxd-activity-log"),
		);
		Object.defineProperty(container, "scrollHeight", {
			value: 1000,
			configurable: true,
		});
		container.scrollTop = 55;
		await new Promise((r) => setTimeout(r, 40));
		// Re-render with the SAME request value — mount captured it already.
		render({ entryCount: 3, scrollToBottomRequest: 7 });
		await new Promise((r) => setTimeout(r, 40));
		expect(container.scrollTop).toBe(55);
	});
});

describe("ActivityLog — editingEid highlight", () => {
	test("the matching user message is marked, others are not", async () => {
		const { div } = await scrolledUpLog("eid-2");
		const marked = div.querySelectorAll(".mxd-user-msg--editing");
		expect(marked.length).toBe(1);
		expect(marked[0]?.getAttribute("data-eid")).toBe("eid-2");
		expect(marked[0]?.textContent).toContain("user message 2");
	});

	test("no editingEid → nothing is marked", async () => {
		const { div } = await scrolledUpLog(null);
		expect(div.querySelectorAll(".mxd-user-msg--editing").length).toBe(0);
		// …but every user message still carries its data-eid (used to scroll
		// back to the message being edited).
		expect(div.querySelectorAll("[data-eid]").length).toBe(5);
	});

	test("clearing editingEid removes the mark", async () => {
		const { div, render } = await scrolledUpLog("eid-1");
		await waitFor(() => div.querySelector(".mxd-user-msg--editing"));
		render({ entryCount: 5, editingEid: null });
		await waitFor(() => !div.querySelector(".mxd-user-msg--editing"));
		expect(div.querySelectorAll(".mxd-user-msg--editing").length).toBe(0);
	});
});
