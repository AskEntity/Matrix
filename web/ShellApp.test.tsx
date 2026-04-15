/**
 * Test: Shell app renders correctly with jsdom.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { cleanup, render, waitFor } from "@testing-library/react";
import { ShellApp } from "./ShellApp.tsx";

// Setup jsdom globals
const dom = new JSDOM("<!DOCTYPE html><html><body><div id='root'></div></body></html>", {
	url: "http://localhost",
	pretendToBeVisual: true,
});

Object.assign(globalThis, {
	document: dom.window.document,
	window: dom.window,
	navigator: dom.window.navigator,
	HTMLElement: dom.window.HTMLElement,
	HTMLSelectElement: dom.window.HTMLSelectElement,
	SVGElement: dom.window.SVGElement,
	MutationObserver: dom.window.MutationObserver,
	getComputedStyle: dom.window.getComputedStyle,
});

// Mock fetch
globalThis.fetch = mock(async (input: RequestInfo | URL) => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
	const path = new URL(url, "http://localhost").pathname;
	const responses: Record<string, unknown> = {
		"/auth/status": { enabled: false, authenticated: true },
		"/projects": [{ id: "p1", name: "test-project", path: "/tmp/test" }],
		"/plugins": [{ name: "matrix", scope: "global", webComponentPath: "/path/to/App.tsx" }],
	};
	const data = responses[path];
	return new Response(JSON.stringify(data ?? {}), {
		status: data ? 200 : 404,
		headers: { "content-type": "application/json" },
	});
}) as typeof fetch;

// Mock localStorage
const storage = new Map<string, string>();
globalThis.localStorage = {
	getItem: (k: string) => storage.get(k) ?? null,
	setItem: (k: string, v: string) => storage.set(k, v),
	removeItem: (k: string) => storage.delete(k),
	clear: () => storage.clear(),
	get length() { return storage.size; },
	key: () => null,
} as Storage;

describe("ShellApp with jsdom", () => {
	afterEach(() => {
		cleanup();
		storage.clear();
	});

	test("renders shell with logo after auth", async () => {
		const { container } = render(<ShellApp />);

		await waitFor(() => {
			const logo = container.querySelector(".mxd-shell-logo");
			expect(logo).toBeTruthy();
		}, { timeout: 3000 });

		expect(container.querySelector(".mxd-shell-logo")?.textContent).toBe("Matrix");
	});

	test("renders project selector", async () => {
		const { container } = render(<ShellApp />);

		await waitFor(() => {
			const selects = container.querySelectorAll(".mxd-shell-select");
			expect(selects.length).toBeGreaterThanOrEqual(1);
		}, { timeout: 3000 });
	});

	test("renders scope selector with plugin names", async () => {
		const { container } = render(<ShellApp />);

		await waitFor(() => {
			const options = container.querySelectorAll(".mxd-shell-select option");
			const names = Array.from(options).map((o) => o.textContent);
			expect(names).toContain("matrix");
		}, { timeout: 3000 });
	});

	test("shows loading state for plugin UI", async () => {
		const { container } = render(<ShellApp />);

		await waitFor(() => {
			const content = container.querySelector(".mxd-shell-content");
			expect(content).toBeTruthy();
		}, { timeout: 3000 });
	});
});
