/**
 * Test: Shell app renders correctly.
 * Uses React server-side rendering to test without a full DOM.
 */
import { describe, expect, mock, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { ShellApp } from "./ShellApp.tsx";

// Mock fetch for auth check
globalThis.fetch = mock(async (input: RequestInfo | URL) => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
	const path = new URL(url, "http://localhost").pathname;

	const responses: Record<string, unknown> = {
		"/auth/status": { enabled: false, authenticated: true },
		"/projects": [{ id: "p1", name: "test-project", path: "/tmp/test" }],
		"/plugins": [{ name: "matrix", scope: "global", webComponentPath: null }],
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

describe("ShellApp SSR", () => {
	test("renders without crashing", () => {
		// ShellApp starts with checking=true, renders null initially
		const html = renderToString(<ShellApp />);
		// During SSR, useState initializes synchronously.
		// checking=true → renders null → empty string
		expect(typeof html).toBe("string");
	});

	test("LoginPage renders when not authenticated", async () => {
		// Import LoginPage directly to test it renders
		const { LoginPage } = await import("./LoginPage.tsx");
		const html = renderToString(<LoginPage onAuthenticated={() => {}} />);
		expect(html).toContain("Matrix");
		// LoginPage should have the login flow elements
		expect(html.length).toBeGreaterThan(100);
	});
});
