/// <reference lib="dom" />
/**
 * ActivityLog's scroll reporting — `onAutoScrollChange`, the ONE channel by
 * which a scroll position becomes follow intent, and the guard that decides
 * when a scroll event is allowed to speak for the user at all.
 *
 * There used to be a second channel, `onAtBottomChange`, reporting raw
 * at-bottom-ness for an icon-only ↓ button in the panel header. Both the
 * button and the channel are gone: Follow subsumed the button, so nothing
 * read the observation any more. Do NOT reintroduce a second reporting
 * channel to serve a new control — one intent-guarded channel plus the
 * `scrollToBottomRequest` counter is the whole vocabulary, and the split
 * between them is what the guard below depends on.
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
 * trigger and is what the arming/acting tests exercise.
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
async function renderLog(opts: { autoScroll: boolean; entryCount?: number }) {
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

	const autoScrollCalls: boolean[] = [];

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
	return { container, autoScrollCalls, render };
}

/** Settle window for a NEGATIVE assertion ("nothing was reported"). */
const settle = () => new Promise((r) => setTimeout(r, 80));

/**
 * The follow-intent guard. `isNearBottom` answers "is the log at its bottom",
 * which is not the same question as "does the user want to follow new output"
 * — because the offset can arrive at the bottom without the user doing
 * anything, when the content or the viewport shrinks under it. The browser
 * clamps and fires an ordinary scroll event; nothing on the event
 * distinguishes it from a real scroll (a clamp-dispatched event is
 * isTrusted too).
 *
 * Measured in Chrome before the guard: switching tasks, and every log search
 * (no match / few matches / a match set that still overflows) re-armed follow
 * and dragged the user to the bottom the moment the content came back.
 *
 * ⚠️ Both tests below assert an ABSENCE, so each one ends with a positive
 * control that re-arms follow for real. Without it they pass just as happily
 * against a component that reports nothing at all — which is exactly what
 * `expect(autoScrollCalls).toEqual([])` looked like while a second, unguarded
 * reporting channel was still doing the synchronising for it.
 */
describe("ActivityLog follow-intent guard (shrinking range)", () => {
	test("range shrinks to zero → does NOT re-arm follow", async () => {
		const { container, autoScrollCalls } = await renderLog({
			autoScroll: false,
		});
		mockGeometry(container, { scrollHeight: 1000, clientHeight: 300 });

		// Establish the previous range (700) with a real scroll.
		container.scrollTop = 200;
		container.dispatchEvent(new Event("scroll"));
		await waitFor(() => autoScrollCalls.length > 0);

		autoScrollCalls.length = 0;

		// The log empties (task switch mid-fetch / search matched nothing):
		// range 700 → 0, the browser clamps the offset to 0 and fires scroll.
		mockGeometry(container, { scrollHeight: 300, clientHeight: 300 });
		container.scrollTop = 0;
		container.dispatchEvent(new Event("scroll"));

		await settle();
		// Follow intent is left alone, even though the offset reads as
		// at-bottom (there is nowhere left to scroll).
		expect(autoScrollCalls).toEqual([]);

		// Positive control: the channel is alive and this container still
		// reports. Content comes back (range 0 → 700, a GROWTH) and the user
		// scrolls to within the threshold themselves.
		mockGeometry(container, { scrollHeight: 1000, clientHeight: 300 });
		container.scrollTop = 690;
		container.dispatchEvent(new Event("scroll"));
		await waitFor(() => autoScrollCalls.length > 0);
		expect(autoScrollCalls[autoScrollCalls.length - 1]).toBe(true);
	});

	test("range shrinks but still overflows → still does NOT re-arm follow", async () => {
		// The case that rules out "does it overflow" as the discriminator:
		// a log search whose results still scroll. Measured range 1549 → 449,
		// offset clamped to the new bottom, follow silently re-armed.
		const { container, autoScrollCalls } = await renderLog({
			autoScroll: false,
		});
		mockGeometry(container, { scrollHeight: 1000, clientHeight: 300 });
		container.scrollTop = 200;
		container.dispatchEvent(new Event("scroll"));
		await waitFor(() => autoScrollCalls.length > 0);

		autoScrollCalls.length = 0;

		mockGeometry(container, { scrollHeight: 400, clientHeight: 300 });
		container.scrollTop = 100; // clamped to the new max → reads as at-bottom
		container.dispatchEvent(new Event("scroll"));

		await settle();
		expect(autoScrollCalls).toEqual([]);

		// Positive control — see the describe comment.
		mockGeometry(container, { scrollHeight: 1000, clientHeight: 300 });
		container.scrollTop = 690;
		container.dispatchEvent(new Event("scroll"));
		await waitFor(() => autoScrollCalls.length > 0);
		expect(autoScrollCalls[autoScrollCalls.length - 1]).toBe(true);
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
