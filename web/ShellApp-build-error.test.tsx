/// <reference lib="dom" />
/**
 * P2.10 — Surface plugin `buildError` in the Shell UI.
 *
 * Before: when the web-build pipeline failed to compile a plugin's JS,
 * the `/plugins` response included a `buildError` field, but `PluginInfo`
 * in ShellApp didn't declare it. `plugin.webComponentPath` was undefined
 * too, so the code fell into the `PluginUI ? ... : "Select a scope to load
 * plugin UI"` branch — which for a SELECTED scope would momentarily show
 * the Suspense fallback ("Loading plugin…") when a stale PluginUI lingered,
 * or the "Select a scope" message otherwise. Either way the user had no
 * signal that their plugin failed to build.
 *
 * After: when the selected plugin has `buildError`, we render
 * `PluginBuildErrorPanel` (role="alert") with the error text verbatim.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

describe("P2.10: plugin buildError is visible in ShellApp", () => {
	let savedFetch: typeof fetch;

	beforeAll(() => {
		// Register once per describe — tearing down between tests caused
		// React's scheduler to schedule callbacks after `window` was gone.
		GlobalRegistrator.register();
		savedFetch = globalThis.fetch;
	});

	afterAll(async () => {
		globalThis.fetch = savedFetch;
		// Let React's scheduler drain before tearing down `window` — the
		// teardown race surfaces as `ReferenceError: window is not defined`
		// from `react-dom-client.development.js:scheduleCallback`.
		await new Promise((r) => setTimeout(r, 100));
		GlobalRegistrator.unregister();
	});

	test("ShellApp renders error panel when /plugins returns buildError", async () => {
		// Mock fetch: auth says unauthenticated-enabled, /projects empty,
		// /plugins returns one plugin with a build error. The component
		// should render an error panel, NOT the Suspense fallback.
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.toString()
						: input.url;
			if (url.includes("/auth/status")) {
				return new Response(
					JSON.stringify({ enabled: false, authenticated: true }),
					{ headers: { "content-type": "application/json" } },
				);
			}
			if (url.includes("/projects")) {
				return new Response(
					JSON.stringify([
						{ id: "p1", name: "proj", path: "/proj", pathExists: true },
					]),
					{ headers: { "content-type": "application/json" } },
				);
			}
			if (url.includes("/plugins")) {
				return new Response(
					JSON.stringify([
						{
							name: "broken-plugin",
							scope: "global",
							buildError: "SyntaxError: Unexpected token '?'",
						},
					]),
					{ headers: { "content-type": "application/json" } },
				);
			}
			if (url.includes("/health")) {
				return new Response("ok");
			}
			return new Response("", { status: 404 });
		}) as typeof fetch;

		// Import AFTER registering happy-dom so React sees a DOM.
		const { createRoot } = await import("react-dom/client");
		const { createElement } = await import("react");
		const { ShellApp } = await import("./ShellApp.tsx");

		const div = document.createElement("div");
		document.body.appendChild(div);
		const root = createRoot(div);
		root.render(createElement(ShellApp));

		// Wait for the component to fetch /plugins and render
		for (let i = 0; i < 30; i++) {
			await new Promise((r) => setTimeout(r, 50));
			const text = div.textContent ?? "";
			if (text.includes("failed to build")) break;
		}

		const text = div.textContent ?? "";
		// The error panel is the canonical user-observable signal.
		expect(text).toContain("broken-plugin");
		expect(text).toContain("failed to build");
		expect(text).toContain("SyntaxError: Unexpected token");
		// Suspense fallback must NOT be shown for a failed-build plugin —
		// that was the old hanging-on-"Loading plugin…" bug.
		expect(text).not.toContain("Loading plugin...");

		// Role=alert for screen readers / test selection
		const alert = div.querySelector('[role="alert"]');
		expect(alert).toBeTruthy();

		root.unmount();
		div.remove();
	});

	test("ShellApp renders normal plugin when buildError absent", async () => {
		// Negative-case guard: without buildError, the error panel must NOT
		// appear. A "render error whenever buildError is anywhere in the
		// response" mutation would fail this test.
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.toString()
						: input.url;
			if (url.includes("/auth/status")) {
				return new Response(
					JSON.stringify({ enabled: false, authenticated: true }),
					{ headers: { "content-type": "application/json" } },
				);
			}
			if (url.includes("/projects")) {
				return new Response(
					JSON.stringify([
						{ id: "p1", name: "proj", path: "/proj", pathExists: true },
					]),
					{ headers: { "content-type": "application/json" } },
				);
			}
			if (url.includes("/plugins")) {
				return new Response(
					JSON.stringify([
						{
							name: "working-plugin",
							scope: "global",
							webComponentPath: "/app/does-not-exist.js",
						},
					]),
					{ headers: { "content-type": "application/json" } },
				);
			}
			if (url.includes("/health")) {
				return new Response("ok");
			}
			return new Response("", { status: 404 });
		}) as typeof fetch;

		const { createRoot } = await import("react-dom/client");
		const { createElement } = await import("react");
		const { ShellApp } = await import("./ShellApp.tsx");

		const div = document.createElement("div");
		document.body.appendChild(div);
		const root = createRoot(div);
		root.render(createElement(ShellApp));

		// Give React time to render (plugin won't load — path is fake —
		// but the error panel is what we're NOT expecting).
		await new Promise((r) => setTimeout(r, 300));

		const text = div.textContent ?? "";
		expect(text).not.toContain("failed to build");
		expect(div.querySelector('[role="alert"]')).toBeFalsy();

		root.unmount();
		div.remove();
	});
});
