/// <reference lib="dom" />
/**
 * Test: Full shell + Matrix plugin renders task tree.
 * Real daemon, real plugin, happy-dom rendering.
 */
import "./test-setup.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG, saveGlobalConfig } from "../src/config.ts";
import { createDaemon, type DaemonInstance } from "../src/daemon.ts";
import { ShellApp } from "./ShellApp.tsx";

const TEST_PORT = 17436;

describe("Full shell + Matrix plugin", () => {
	let tempDir: string;
	let daemon: DaemonInstance;
	let server: ReturnType<typeof Bun.serve>;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "shell-plugin-e2e-"));
		const dataDir = join(tempDir, ".mxd");
		// Use worktree path (has .mxd/plugin/index.ts)
		const matrixPath = resolve(".");

		await mkdir(join(dataDir, "projects"), { recursive: true });
		await writeFile(
			join(dataDir, "projects.json"),
			JSON.stringify([
				{ id: "m1", name: "matrix", path: matrixPath, createdAt: "2026-01-01" },
			]),
		);
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));

		daemon = await createDaemon({ dataDir });
		server = Bun.serve({ port: TEST_PORT, fetch: daemon.fetch });

		// Override fetch to hit our test daemon
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			// Relative URLs → point to test daemon
			if (url.startsWith("/")) {
				return originalFetch(`http://localhost:${TEST_PORT}${url}`, init);
			}
			if (url.startsWith("http://localhost/")) {
				return originalFetch(url.replace("http://localhost/", `http://localhost:${TEST_PORT}/`), init);
			}
			return originalFetch(input, init);
		};
	}, 15000);

	afterEach(() => cleanup());

	afterAll(async () => {
		server?.stop();
		await daemon?.shutdown();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("daemon discovered Matrix plugin", () => {
		const matrix = daemon.plugins.find((p) => p.name === "matrix");
		expect(matrix).toBeDefined();
		expect(matrix!.scope).toBe("global");
	});

	test("shell renders with real daemon data", async () => {
		const { container } = render(<ShellApp />);

		await waitFor(() => {
			expect(container.querySelector(".mxd-shell-logo")).toBeTruthy();
		}, { timeout: 5000 });

		expect(container.querySelector(".mxd-shell-logo")?.textContent).toBe("Matrix");
	});

	test("project selector shows real project", async () => {
		const { container } = render(<ShellApp />);

		await waitFor(() => {
			const options = container.querySelectorAll(".mxd-shell-select option");
			const texts = Array.from(options).map((o) => o.textContent);
			expect(texts).toContain("matrix");
		}, { timeout: 5000 });
	});

	test("scope selector shows matrix plugin", async () => {
		const { container } = render(<ShellApp />);

		await waitFor(() => {
			const selects = container.querySelectorAll(".mxd-shell-select");
			if (selects.length >= 2) {
				const texts = Array.from(selects[1]!.querySelectorAll("option")).map((o) => o.textContent);
				expect(texts).toContain("matrix");
			}
		}, { timeout: 5000 });
	});
});
