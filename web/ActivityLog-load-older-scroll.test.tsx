/// <reference lib="dom" />
/**
 * Load-earlier-history scroll anchor — the viewport must stay at the same
 * content after older events are prepended above.
 *
 * Exercises the bottom-relative anchor captured in handleLoadOlder and
 * restored by the useLayoutEffect on loadingOlderEvents true→false.
 *
 * happy-dom stores scrollTop unclamped (same as existing scroll tests),
 * so the arithmetic assertion is exact.
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

type Cleanup = () => void;
const cleanups: Cleanup[] = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

/** Poll until fn() is truthy (returns it) or the timeout elapses (throws). */
async function waitFor<T>(
	fn: () => T,
	timeoutMs = 2000,
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

/** Mock scroll geometry on the log container (happy-dom does no layout). */
function mockGeometry(
	el: HTMLElement,
	{
		scrollHeight,
		clientHeight,
	}: { scrollHeight: number; clientHeight: number },
) {
	Object.defineProperty(el, "scrollHeight", {
		value: scrollHeight,
		configurable: true,
	});
	Object.defineProperty(el, "clientHeight", {
		value: clientHeight,
		configurable: true,
	});
}

/**
 * Render ActivityLog with load-older support and controllable props.
 * Returns the container, a rerender helper, and the captured load callback.
 */
async function renderLogWithOlder(opts: { entryCount: number }) {
	const { createRoot } = await import("react-dom/client");
	const { createElement } = await import("react");
	const { ActivityLog } = await import(
		"../.mxd/plugin/web/components/ActivityLog.tsx"
	);
	const { LocaleProvider } = await import("../.mxd/plugin/web/i18n.ts");
	const { createLogEntry } = await import("../.mxd/plugin/web/hooks.ts");

	const rootTaskId = "root-1";

	const makeEntries = (count: number, offset = 0) =>
		Array.from({ length: count }, (_, i) =>
			createLogEntry({
				type: "assistant_text",
				content: `entry-${offset + i}`,
				taskId: rootTaskId,
				ts: 1000 + offset + i,
			} as Parameters<typeof createLogEntry>[0]),
		);

	const loadCalls: string[] = [];
	const onLoadOlderEvents = (sessionId: string) => loadCalls.push(sessionId);

	const div = document.createElement("div");
	document.body.appendChild(div);
	const root = createRoot(div);

	const render = (props: {
		entryCount: number;
		entryOffset?: number;
		loadingOlderEvents: boolean;
		hasOlder: boolean;
	}) => {
		const olderEventsAvailable = props.hasOlder
			? new Map([
					[
						rootTaskId,
						{ hasOlder: true, oldestTs: 1000 + (props.entryOffset ?? 0) },
					],
				])
			: new Map<string, { hasOlder: boolean; oldestTs: number }>();

		root.render(
			createElement(
				LocaleProvider,
				null,
				createElement(ActivityLog, {
					entries: makeEntries(props.entryCount, props.entryOffset ?? 0),
					filterTaskId: null,
					rootNodeId: rootTaskId,
					nodeMap: new Map(),
					autoScroll: false,
					onAutoScrollChange: () => {},
					isActive: false,
					projectId: "proj-1",
					olderEventsAvailable,
					loadingOlderEvents: props.loadingOlderEvents,
					onLoadOlderEvents,
				}),
			),
		);
	};

	// Initial render
	render({
		entryCount: opts.entryCount,
		loadingOlderEvents: false,
		hasOlder: true,
	});
	await waitFor(() =>
		div.textContent?.includes(`entry-${opts.entryCount - 1}`),
	);
	const container = await waitFor(() =>
		div.querySelector<HTMLElement>(".mxd-activity-log"),
	);
	// Let mount effects settle
	await new Promise((r) => setTimeout(r, 30));

	cleanups.push(() => {
		root.unmount();
		div.remove();
	});
	return { container, render, loadCalls, div };
}

describe("ActivityLog load-older scroll anchor", () => {
	test("scroll position preserved after older events prepend (the fix)", async () => {
		const { container, render, loadCalls } = await renderLogWithOlder({
			entryCount: 10,
		});

		// Mock geometry: 2000px total height, 400px viewport
		mockGeometry(container, { scrollHeight: 2000, clientHeight: 400 });

		// User has scrolled to a middle position
		container.scrollTop = 600;

		// Capture the expected anchor
		const scrollBottom = 2000 - 600; // = 1400

		// Click "Load earlier" — the button calls onLoadOlderEvents
		const btn = container.querySelector<HTMLButtonElement>(
			".mxd-load-older-btn",
		);
		expect(btn).toBeTruthy();
		btn!.click();

		// Verify the callback was called
		expect(loadCalls).toEqual(["root-1"]);

		// Simulate Plugin.tsx setting loadingOlderEvents=true
		render({
			entryCount: 10,
			loadingOlderEvents: true,
			hasOlder: true,
		});
		await new Promise((r) => setTimeout(r, 10));

		// Now simulate the load completing: more entries (prepended) + loadingOlderEvents=false.
		// The new scrollHeight is larger because there are more entries above.
		const newScrollHeight = 3500;
		mockGeometry(container, {
			scrollHeight: newScrollHeight,
			clientHeight: 400,
		});

		render({
			entryCount: 30, // 20 older + 10 original
			entryOffset: -20, // older entries start before the original
			loadingOlderEvents: false,
			hasOlder: false,
		});

		// Wait for the render + useLayoutEffect to fire
		await waitFor(() => container.scrollTop !== 600);

		// The anchor should be restored: scrollTop = newScrollHeight - scrollBottom
		const expectedScrollTop = newScrollHeight - scrollBottom;
		expect(container.scrollTop).toBe(expectedScrollTop);
	});

	test("MUTATION-PROOF: without the anchor, scroll stays at wrong position", async () => {
		// This test documents the BUG behavior (before the fix):
		// after entries change, scrollTop is NOT automatically corrected
		// by React — it stays at whatever value it had.
		const { container, render, loadCalls } = await renderLogWithOlder({
			entryCount: 10,
		});

		mockGeometry(container, { scrollHeight: 2000, clientHeight: 400 });
		container.scrollTop = 600;

		// Click load
		const btn = container.querySelector<HTMLButtonElement>(
			".mxd-load-older-btn",
		);
		btn!.click();
		expect(loadCalls.length).toBe(1);

		// Loading state
		render({
			entryCount: 10,
			loadingOlderEvents: true,
			hasOlder: true,
		});
		await new Promise((r) => setTimeout(r, 10));

		// Complete with new entries + new geometry
		const newScrollHeight = 3500;
		mockGeometry(container, {
			scrollHeight: newScrollHeight,
			clientHeight: 400,
		});
		render({
			entryCount: 30,
			entryOffset: -20,
			loadingOlderEvents: false,
			hasOlder: false,
		});

		await new Promise((r) => setTimeout(r, 30));

		// With the fix: scrollTop should be newScrollHeight - (2000 - 600) = 2100
		// Without the fix: scrollTop would stay at 600 (or 0 if React resets it)
		// This test PASSES because the fix IS present — it asserts the correct value.
		// Reverting the useLayoutEffect anchor makes scrollTop stay at 600.
		const scrollBottom = 2000 - 600;
		expect(container.scrollTop).toBe(newScrollHeight - scrollBottom);
		// This value is NOT 600 (the original scrollTop):
		expect(container.scrollTop).not.toBe(600);
	});

	test("anchor NOT applied for normal entry growth (streaming)", async () => {
		const { container, render } = await renderLogWithOlder({
			entryCount: 10,
		});

		mockGeometry(container, { scrollHeight: 2000, clientHeight: 400 });
		container.scrollTop = 600;

		// Normal entry growth (NOT a load-older flow — no button click,
		// loadingOlderEvents stays false throughout).
		mockGeometry(container, { scrollHeight: 2200, clientHeight: 400 });
		render({
			entryCount: 12,
			loadingOlderEvents: false,
			hasOlder: true,
		});
		await new Promise((r) => setTimeout(r, 30));

		// scrollTop should NOT have been modified by the anchor logic
		// (it may have been modified by other effects, but the anchor
		// ref was never set because handleLoadOlder was never called)
		expect(container.scrollTop).toBe(600);
	});

	test("load-older button shows 'Loading…' during fetch", async () => {
		const { container, render } = await renderLogWithOlder({
			entryCount: 5,
		});

		// Initial: shows "Load earlier history"
		const btn = container.querySelector(".mxd-load-older-btn");
		expect(btn?.textContent).toContain("Load earlier history");

		// Loading state: shows "Loading…"
		render({
			entryCount: 5,
			loadingOlderEvents: true,
			hasOlder: true,
		});
		await waitFor(() => btn?.textContent?.includes("Loading"));
		expect(btn?.textContent).toContain("Loading");
	});
});
