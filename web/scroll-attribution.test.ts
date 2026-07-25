/// <reference lib="dom" />
/**
 * The scroll attribution facility: off by default, behaviour-preserving when
 * off, and recording who moved the activity log when on.
 *
 * It exists because every scroll complaint in this subsystem has arrived as
 * "something moved me and I don't know what". Six code paths write that one
 * offset and the browser writes it too, so the expensive half of each
 * diagnosis has been working out which one fired.
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
});

afterAll(async () => {
	await new Promise((r) => setTimeout(r, 20));
	GlobalRegistrator.unregister();
});

afterEach(async () => {
	const { _resetScrollAttribution } = await import(
		"../.mxd/plugin/web/scroll-attribution.ts"
	);
	_resetScrollAttribution();
	localStorage.removeItem("mxd-debug-scroll");
});

/** A stand-in for the log container; happy-dom does no layout. */
function fakeEl(scrollTop = 0, scrollHeight = 1000, clientHeight = 300) {
	const el = document.createElement("div");
	Object.defineProperty(el, "scrollHeight", {
		value: scrollHeight,
		configurable: true,
	});
	Object.defineProperty(el, "clientHeight", {
		value: clientHeight,
		configurable: true,
	});
	el.scrollTop = scrollTop;
	return el;
}

describe("scroll attribution", () => {
	test("off by default: the write still happens and nothing is recorded", async () => {
		const { attributeScrollWrite, _getScrollTrace } = await import(
			"../.mxd/plugin/web/scroll-attribution.ts"
		);
		const el = fakeEl(100);

		attributeScrollWrite(el, "follow-content", () => {
			el.scrollTop = 700;
		});

		// The behaviour is identical whether or not anyone is watching.
		expect(el.scrollTop).toBe(700);
		expect(_getScrollTrace()).toEqual([]);
	});

	test("on: records who moved it, and from where to where", async () => {
		localStorage.setItem("mxd-debug-scroll", "true");
		const { attributeScrollWrite, _getScrollTrace } = await import(
			"../.mxd/plugin/web/scroll-attribution.ts"
		);
		const el = fakeEl(100);

		attributeScrollWrite(el, "load-older-anchor", () => {
			el.scrollTop = 420;
		});

		const trace = _getScrollTrace();
		expect(trace).toHaveLength(1);
		expect(trace[0]?.who).toBe("load-older-anchor");
		expect(trace[0]?.from).toBe(100);
		expect(trace[0]?.to).toBe(420);
		// range is what turns an ordinary scroll event into a clamp — see scroll.ts
		expect(trace[0]?.range).toBe(700);
		expect(el.scrollTop).toBe(420);
	});

	test("writers stay distinguishable — that is the entire point", async () => {
		localStorage.setItem("mxd-debug-scroll", "true");
		const { attributeScrollWrite, _getScrollTrace } = await import(
			"../.mxd/plugin/web/scroll-attribution.ts"
		);
		const el = fakeEl(0);

		attributeScrollWrite(el, "follow-stream", () => {
			el.scrollTop = 1;
		});
		attributeScrollWrite(el, "lazy-render-anchor", () => {
			el.scrollTop = 2;
		});
		attributeScrollWrite(el, "jump-request", () => {
			el.scrollTop = 3;
		});

		expect(_getScrollTrace().map((e) => e.who)).toEqual([
			"follow-stream",
			"lazy-render-anchor",
			"jump-request",
		]);
	});

	test("a null container still runs the write (callers pass querySelector results)", async () => {
		localStorage.setItem("mxd-debug-scroll", "true");
		const { attributeScrollWrite, _getScrollTrace } = await import(
			"../.mxd/plugin/web/scroll-attribution.ts"
		);
		let ran = false;

		attributeScrollWrite(null, "edit-indicator", () => {
			ran = true;
		});

		expect(ran).toBe(true);
		expect(_getScrollTrace()).toEqual([]);
	});

	test("the sampler is not installed when tracing is off", async () => {
		const { startScrollAttributionSampler, _getScrollTrace } = await import(
			"../.mxd/plugin/web/scroll-attribution.ts"
		);
		const el = fakeEl(0);

		const stop = startScrollAttributionSampler(() => el);
		el.scrollTop = 500; // movement nobody claimed
		await new Promise((r) => setTimeout(r, 60));
		stop();

		expect(_getScrollTrace()).toEqual([]);
	});

	test("on: the sampler catches movement no writer claimed", async () => {
		// This is the case that matters most and that instrumenting the writers
		// alone cannot see: a clamp or a scroll-anchoring adjustment. Anchoring
		// in particular fires no event at all, which is why this is a per-frame
		// poll rather than a scroll listener.
		localStorage.setItem("mxd-debug-scroll", "true");
		const { startScrollAttributionSampler, _getScrollTrace } = await import(
			"../.mxd/plugin/web/scroll-attribution.ts"
		);
		const el = fakeEl(500);

		const stop = startScrollAttributionSampler(() => el);
		await new Promise((r) => setTimeout(r, 40));
		el.scrollTop = 380; // nobody went through attributeScrollWrite
		await new Promise((r) => setTimeout(r, 120));
		stop();

		const external = _getScrollTrace().filter((e) => e.who === "external");
		expect(external.length).toBeGreaterThan(0);
		expect(external[0]?.to).toBe(380);
		expect(external[0]?.detail).toBeTruthy();
	});

	test("on: an attributed write is not re-reported as external", async () => {
		localStorage.setItem("mxd-debug-scroll", "true");
		const {
			attributeScrollWrite,
			startScrollAttributionSampler,
			_getScrollTrace,
		} = await import("../.mxd/plugin/web/scroll-attribution.ts");
		const el = fakeEl(500);

		const stop = startScrollAttributionSampler(() => el);
		await new Promise((r) => setTimeout(r, 40));
		attributeScrollWrite(el, "jump-request", () => {
			el.scrollTop = 700;
		});
		await new Promise((r) => setTimeout(r, 120));
		stop();

		expect(_getScrollTrace().filter((e) => e.who === "external")).toEqual([]);
	});
});
