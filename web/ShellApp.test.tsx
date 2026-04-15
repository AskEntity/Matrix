/// <reference lib="dom" />
/**
 * Test: Shell app renders correctly with happy-dom (via GlobalRegistrator).
 */
import "./test-setup.ts";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { ShellApp } from "./ShellApp.tsx";

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

describe("ShellApp", () => {
	afterEach(() => cleanup());

	test("renders shell with logo after auth", async () => {
		const { container } = render(<ShellApp />);
		await waitFor(() => {
			expect(container.querySelector(".mxd-shell-logo")).toBeTruthy();
		}, { timeout: 3000 });
		expect(container.querySelector(".mxd-shell-logo")?.textContent).toBe("Matrix");
	});

	test("renders project selector with project names", async () => {
		const { container } = render(<ShellApp />);
		await waitFor(() => {
			const options = container.querySelectorAll(".mxd-shell-select option");
			const texts = Array.from(options).map((o) => o.textContent);
			expect(texts).toContain("test-project");
		}, { timeout: 3000 });
	});

	test("renders scope selector with plugin names", async () => {
		const { container } = render(<ShellApp />);
		await waitFor(() => {
			const selects = container.querySelectorAll(".mxd-shell-select");
			// Second select is scope selector
			if (selects.length >= 2) {
				const options = selects[1]!.querySelectorAll("option");
				const texts = Array.from(options).map((o) => o.textContent);
				expect(texts).toContain("matrix");
			}
		}, { timeout: 3000 });
	});

	test("shows plugin loading area", async () => {
		const { container } = render(<ShellApp />);
		await waitFor(() => {
			expect(container.querySelector(".mxd-shell-content")).toBeTruthy();
		}, { timeout: 3000 });
	});
});
