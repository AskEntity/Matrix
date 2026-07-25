/// <reference lib="dom" />
/**
 * ActivityLog scroll-position reporting (`onAtBottomChange`) — the mechanism
 * behind the scroll-to-bottom button next to the Compact button.
 *
 * Covers every report path:
 *  - scroll events (user scrolls up / back down) — also asserts the existing
 *    auto-follow callback (onAutoScrollChange) still fires with the same
 *    value, pinning "don't disturb auto-follow" at the mechanism level
 *  - content growth while scrolled up (visible.length effect re-evaluation)
 *  - auto-follow scrolls (autoScroll=true + new entry → reports true)
 *  - prop omitted → no crash (optional prop, showcase/legacy callers)
 *
 * happy-dom does no layout, so container geometry (scrollHeight/clientHeight)
 * is mocked via Object.defineProperty; scrollTop assignment works natively.
 * The predicate's math itself is covered by web/scroll.test.ts.
 *
 * NOT covered here: the MutationObserver branch (streaming characterData
 * growth). happy-dom v20 holds MutationObserver callbacks only via WeakRef
 * (MutationObserverListener.js) — under full-suite GC pressure the callback
 * is collected and delivery silently stops, so any test of that branch is
 * inherently flaky. The deterministic visible.length effect is the primary
 * trigger and is what the content-growth test exercises.
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
 * Render ActivityLog with N assistant_text entries and callback spies.
 * Returns the container element, the spy logs, and a rerender helper that
 * swaps in a new entry list (same root — exercises the MutationObserver).
 */
async function renderLog(opts: {
	autoScroll: boolean;
	withAtBottomCallback?: boolean;
	entryCount?: number;
}) {
	const { createRoot } = await import("react-dom/client");
	const { createElement } = await import("react");
	const { ActivityLog } = await import(
		"../.mxd/plugin/web/components/ActivityLog.tsx"
	);
	const { LocaleProvider } = await import("../.mxd/plugin/web/i18n.ts");
	const { createLogEntry } = await import("../.mxd/plugin/web/hooks.ts");

	// Built ONCE and sliced, so an entry keeps its id — and therefore its React
	// key and its DOM node — across rerenders. Regenerating them per render
	// would make every rerender look like a wholesale content replacement,
	// which fires the MutationObserver and hides whether the effect under test
	// scrolled. Growing the count appends, exactly as production does.
	const master = Array.from({ length: 64 }, (_, i) =>
		createLogEntry({
			type: "assistant_text",
			content: `log entry number ${i}`,
			taskId: "root-1",
			ts: 1000 + i,
		} as Parameters<typeof createLogEntry>[0]),
	);
	const makeEntries = (count: number) => master.slice(0, count);

	const atBottomCalls: boolean[] = [];
	const autoScrollCalls: boolean[] = [];
	const onAtBottomChange =
		opts.withAtBottomCallback === false
			? undefined
			: (v: boolean) => atBottomCalls.push(v);

	const div = document.createElement("div");
	document.body.appendChild(div);
	const root = createRoot(div);

	const render = (entryCount: number, autoScroll: boolean) =>
		root.render(
			createElement(
				LocaleProvider,
				null,
				createElement(ActivityLog, {
					entries: makeEntries(entryCount),
					filterTaskId: null,
					rootNodeId: "root-1",
					nodeMap: new Map(),
					autoScroll,
					onAutoScrollChange: (v: boolean) => autoScrollCalls.push(v),
					onAtBottomChange,
					activity: undefined,
					projectId: "proj-1",
				}),
			),
		);

	const initialCount = opts.entryCount ?? 3;
	render(initialCount, opts.autoScroll);
	await waitFor(() =>
		div.textContent?.includes(`log entry number ${initialCount - 1}`),
	);
	const container = await waitFor(() =>
		div.querySelector<HTMLElement>(".mxd-activity-log"),
	);
	// Settle tick so mount effects (MutationObserver attach, initial rAF
	// auto-scroll) have run before tests start mutating geometry.
	await new Promise((r) => setTimeout(r, 30));

	cleanups.push(() => {
		root.unmount();
		div.remove();
	});
	return { container, atBottomCalls, autoScrollCalls, render };
}

describe("ActivityLog scroll-position reporting", () => {
	test("scrolling away from the bottom reports false on BOTH callbacks", async () => {
		const { container, atBottomCalls, autoScrollCalls } = await renderLog({
			autoScroll: true,
		});
		mockGeometry(container, { scrollHeight: 1000, clientHeight: 300 });

		atBottomCalls.length = 0;
		autoScrollCalls.length = 0;

		// User scrolls up: 500px from the bottom
		container.scrollTop = 200;
		container.dispatchEvent(new Event("scroll"));

		await waitFor(() => atBottomCalls.length > 0);
		expect(atBottomCalls[atBottomCalls.length - 1]).toBe(false);
		// Existing auto-follow behavior untouched: same event, same value
		expect(autoScrollCalls[autoScrollCalls.length - 1]).toBe(false);
	});

	test("scrolling back to the bottom reports true on BOTH callbacks", async () => {
		const { container, atBottomCalls, autoScrollCalls } = await renderLog({
			autoScroll: false,
		});
		mockGeometry(container, { scrollHeight: 1000, clientHeight: 300 });

		// Away first…
		container.scrollTop = 100;
		container.dispatchEvent(new Event("scroll"));
		await waitFor(() => atBottomCalls.length > 0);
		expect(atBottomCalls[atBottomCalls.length - 1]).toBe(false);

		// …then within the 40px threshold (distance = 1000-680-300 = 20)
		container.scrollTop = 680;
		container.dispatchEvent(new Event("scroll"));
		await waitFor(() => atBottomCalls[atBottomCalls.length - 1] === true);
		expect(autoScrollCalls[autoScrollCalls.length - 1]).toBe(true);
	});

	test("content growth while scrolled up re-reports without any scroll event", async () => {
		// Neuter MutationObserver for this test so ONLY the visible.length
		// effect can deliver the report — makes the mutation-proof exact
		// (deleting the effect's else-branch fails this test even in
		// isolated low-GC runs where the MO complement would still fire).
		const RealMO = globalThis.MutationObserver;
		class NoopMO {
			observe() {}
			disconnect() {}
			takeRecords() {
				return [];
			}
		}
		(globalThis as { MutationObserver: unknown }).MutationObserver = NoopMO;
		cleanups.push(() => {
			(globalThis as { MutationObserver: unknown }).MutationObserver = RealMO;
		});

		const { container, atBottomCalls, render } = await renderLog({
			autoScroll: false,
		});
		mockGeometry(container, { scrollHeight: 1000, clientHeight: 300 });
		container.scrollTop = 100; // far from bottom; no scroll event dispatched

		atBottomCalls.length = 0;

		// New entry arrives → visible.length effect re-evaluates and reports
		// (the deterministic growth trigger; see file header for why the
		// MutationObserver complement is untestable in happy-dom)
		render(4, false);
		await waitFor(() => atBottomCalls.length > 0);
		expect(atBottomCalls[atBottomCalls.length - 1]).toBe(false);
	});

	test("auto-follow scroll (autoScroll=true + new entry) reports true", async () => {
		const { container, atBottomCalls, render } = await renderLog({
			autoScroll: true,
		});
		mockGeometry(container, { scrollHeight: 1000, clientHeight: 300 });
		container.scrollTop = 0;

		atBottomCalls.length = 0;

		// New entry with follow mode on → rAF scrollToBottom → reports true
		render(4, true);
		await waitFor(() => atBottomCalls.length > 0);
		expect(atBottomCalls[atBottomCalls.length - 1]).toBe(true);
		// And the container was actually scrolled to its bottom
		expect(container.scrollTop).toBe(1000);
	});

	test("omitting onAtBottomChange crashes nothing (optional prop)", async () => {
		const { container, autoScrollCalls } = await renderLog({
			autoScroll: false,
			withAtBottomCallback: false,
		});
		mockGeometry(container, { scrollHeight: 1000, clientHeight: 300 });

		container.scrollTop = 150;
		container.dispatchEvent(new Event("scroll"));

		// Auto-follow callback still works; no throw anywhere
		await waitFor(() => autoScrollCalls.length > 0);
		expect(autoScrollCalls[autoScrollCalls.length - 1]).toBe(false);
	});
});

/**
 * The follow-intent guard. `isNearBottom` answers "is the log at its bottom",
 * which is the right question for the ↓ button and the wrong one for "does the
 * user want to follow new output" — because the offset can arrive at the bottom
 * without the user doing anything, when the content or the viewport shrinks
 * under it. The browser clamps and fires an ordinary scroll event; nothing on
 * the event distinguishes it from a real scroll.
 *
 * Measured in Chrome before the guard: switching tasks, and every log search
 * (no match / few matches / a match set that still overflows) re-armed follow
 * and dragged the user to the bottom the moment the content came back.
 */
describe("ActivityLog follow-intent guard (shrinking range)", () => {
	test("range shrinks to zero → reports at-bottom but does NOT re-arm follow", async () => {
		const { container, atBottomCalls, autoScrollCalls } = await renderLog({
			autoScroll: false,
		});
		mockGeometry(container, { scrollHeight: 1000, clientHeight: 300 });

		// Establish the previous range (700) with a real scroll.
		container.scrollTop = 200;
		container.dispatchEvent(new Event("scroll"));
		await waitFor(() => autoScrollCalls.length > 0);

		atBottomCalls.length = 0;
		autoScrollCalls.length = 0;

		// The log empties (task switch mid-fetch / search matched nothing):
		// range 700 → 0, the browser clamps the offset to 0 and fires scroll.
		mockGeometry(container, { scrollHeight: 300, clientHeight: 300 });
		container.scrollTop = 0;
		container.dispatchEvent(new Event("scroll"));

		await waitFor(() => atBottomCalls.length > 0);
		// The ↓ button still gets the truth: there is nowhere to scroll.
		expect(atBottomCalls[atBottomCalls.length - 1]).toBe(true);
		// Follow intent is left alone.
		expect(autoScrollCalls).toEqual([]);
	});

	test("range shrinks but still overflows → still does NOT re-arm follow", async () => {
		// The case that rules out "does it overflow" as the discriminator:
		// a log search whose results still scroll. Measured range 1549 → 449,
		// offset clamped to the new bottom, follow silently re-armed.
		const { container, atBottomCalls, autoScrollCalls } = await renderLog({
			autoScroll: false,
		});
		mockGeometry(container, { scrollHeight: 1000, clientHeight: 300 });
		container.scrollTop = 200;
		container.dispatchEvent(new Event("scroll"));
		await waitFor(() => autoScrollCalls.length > 0);

		atBottomCalls.length = 0;
		autoScrollCalls.length = 0;

		mockGeometry(container, { scrollHeight: 400, clientHeight: 300 });
		container.scrollTop = 100; // clamped to the new max → reads as at-bottom
		container.dispatchEvent(new Event("scroll"));

		await waitFor(() => atBottomCalls.length > 0);
		expect(atBottomCalls[atBottomCalls.length - 1]).toBe(true);
		expect(autoScrollCalls).toEqual([]);
	});

	test("range GROWS (streaming) → scrolling back down still re-arms follow", async () => {
		const { container, autoScrollCalls } = await renderLog({
			autoScroll: false,
		});
		mockGeometry(container, { scrollHeight: 1000, clientHeight: 300 });
		container.scrollTop = 200;
		container.dispatchEvent(new Event("scroll"));
		await waitFor(() => autoScrollCalls.length > 0);

		autoScrollCalls.length = 0;

		// Content grew while the user was reading, then they scroll to the end.
		mockGeometry(container, { scrollHeight: 2000, clientHeight: 300 });
		container.scrollTop = 1700;
		container.dispatchEvent(new Event("scroll"));

		await waitFor(() => autoScrollCalls.length > 0);
		expect(autoScrollCalls[autoScrollCalls.length - 1]).toBe(true);
	});

	test("stable geometry → scrolling back to the bottom re-arms follow", async () => {
		// The guard must not break the everyday path.
		const { container, autoScrollCalls } = await renderLog({
			autoScroll: false,
		});
		mockGeometry(container, { scrollHeight: 1000, clientHeight: 300 });
		container.scrollTop = 100;
		container.dispatchEvent(new Event("scroll"));
		await waitFor(() => autoScrollCalls.length > 0);
		expect(autoScrollCalls[autoScrollCalls.length - 1]).toBe(false);

		autoScrollCalls.length = 0;
		container.scrollTop = 690; // distance 10 < 40
		container.dispatchEvent(new Event("scroll"));

		await waitFor(() => autoScrollCalls.length > 0);
		expect(autoScrollCalls[autoScrollCalls.length - 1]).toBe(true);
	});
});

/**
 * Arming follow is not the same as going to the bottom.
 *
 * Re-arming happens the instant a manual scroll comes within 40px of the
 * bottom. While `autoScroll` was a dependency of the new-content effect, that
 * re-arm ran the effect and finished the user's gesture for them. Measured in
 * Chrome: a scroll walking down to 25px from the bottom was at 0.5px two frames
 * later, with no further input. The user reported it as the scroll being taken
 * away from them.
 *
 * The two tests below are the two sides of the same guard. The first proves the
 * effect no longer reacts to intent; the second proves it still reacts to
 * content. Without the second, over-blocking this effect (or deleting it) would
 * leave every test green while follow mode silently stopped working.
 */
describe("ActivityLog: arming follow vs acting on it", () => {
	test("re-arming follow does NOT move the offset on its own", async () => {
		const { container, render } = await renderLog({
			autoScroll: false,
			entryCount: 3,
		});
		mockGeometry(container, { scrollHeight: 1000, clientHeight: 300 });

		// The user's own gesture has just crossed the 40px threshold and is
		// still in progress — 20px of scroll left that THEY are driving.
		container.scrollTop = 680;

		// handleScroll re-arms follow. Same entries: no new content.
		render(3, true);
		await new Promise((r) => setTimeout(r, 80));

		expect(container.scrollTop).toBe(680);
	});

	test("new content while following DOES scroll to the bottom", async () => {
		const { container, render } = await renderLog({
			autoScroll: true,
			entryCount: 3,
		});
		mockGeometry(container, { scrollHeight: 1000, clientHeight: 300 });
		container.scrollTop = 100;

		// One more entry arrives while following.
		render(4, true);

		await waitFor(() => container.scrollTop === 1000);
		expect(container.scrollTop).toBe(1000);
	});

	test("new content while NOT following leaves the offset alone", async () => {
		const { container, render } = await renderLog({
			autoScroll: false,
			entryCount: 3,
		});
		mockGeometry(container, { scrollHeight: 1000, clientHeight: 300 });
		container.scrollTop = 100;

		render(4, false);
		await new Promise((r) => setTimeout(r, 80));

		expect(container.scrollTop).toBe(100);
	});
});
