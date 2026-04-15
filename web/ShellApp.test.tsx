/// <reference lib="dom" />
/**
 * NOTE: This file requires happy-dom globals. Run separately:
 *   bun test --preload web/test-setup.ts web/ShellApp.test.tsx
 * 
 * DO NOT run with `bun test` (all files) — GlobalRegistrator pollutes other tests.
 */
import "./test-setup.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { act, render, waitFor } from "@testing-library/react";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG, saveGlobalConfig } from "../src/config.ts";
import { createDaemon, type DaemonInstance } from "../src/daemon.ts";
import { ShellApp } from "./ShellApp.tsx";

describe("daemon + Matrix plugin in UI", () => {
	let daemon: DaemonInstance;
	let tempDir: string;
	let server: ReturnType<typeof Bun.serve>;
	let savedFetch: typeof fetch;
	let PORT: number;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "ui-test-"));
		const dataDir = join(tempDir, ".mxd");

		await mkdir(join(dataDir, "projects"), { recursive: true });
		await writeFile(
			join(dataDir, "projects.json"),
			JSON.stringify([
				{ id: "m1", name: "matrix", path: resolve("."), createdAt: "2026-01-01" },
			]),
		);
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));
		daemon = await createDaemon({ dataDir });
		server = Bun.serve({ port: 0, fetch: daemon.fetch });
		PORT = server.port;

		// Patch fetch BEFORE any React render — redirect relative URLs to test daemon
		// and mock auth to always pass
		// Save original fetch for restoration in afterAll
		savedFetch = globalThis.fetch;
		// Use daemon.fetch directly (bypass HTTP — happy-dom's fetch doesn't do real HTTP)
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			let url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

			// Relative → absolute
			if (url.startsWith("/")) url = `http://localhost${url}`;

			// Mock auth
			if (url.includes("/auth/status")) {
				return new Response(JSON.stringify({ enabled: false, authenticated: true }), {
					headers: { "content-type": "application/json" },
				});
			}

			// Call daemon.fetch directly (no HTTP hop)
			const res = await daemon.fetch(new Request(url, init));
			const body = await res.text();
			console.log("[fetch]", url, "→", res.status, body.slice(0, 100));
			return new Response(body, { status: res.status, headers: res.headers });
		}) as typeof fetch;
	}, 15000);

	afterAll(async () => {
		// Restore original fetch — CRITICAL: our override pollutes other test files
		globalThis.fetch = savedFetch;
		server?.stop();
		await daemon?.shutdown();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("shell renders and shows matrix plugin in scope selector", async () => {
		let container: HTMLElement;
		const result = render(<ShellApp />);
		container = result.container!;
		
		// Wait for all async effects to settle: auth → projects → plugins
		for (let i = 0; i < 20; i++) {
			await act(async () => {
				await new Promise((r) => setTimeout(r, 200));
			});
			// Check if selects populated
			if (container.querySelectorAll(".mxd-shell-select option").length > 0) break;
		}

		// Scope selector should contain "matrix"
		const selects = container.querySelectorAll(".mxd-shell-select");
		expect(selects.length).toBeGreaterThanOrEqual(2);
		const scopeOptions = Array.from(selects[1]!.querySelectorAll("option")).map(o => o.textContent);
		expect(scopeOptions).toContain("matrix");
	});

	test("plugin component loads (not just 'Loading plugin...')", async () => {
		const result = render(<ShellApp />);
		const container = result.container;

		// Wait for selects to populate
		for (let i = 0; i < 30; i++) {
			await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
			const content = container.querySelector(".mxd-shell-content");
			const text = content?.textContent ?? "";
			if (text !== "Loading plugin..." && text !== "Select a scope to load plugin UI" && text.length > 0) {
				console.log("PLUGIN LOADED:", content?.innerHTML?.slice(0, 300));
				break;
			}
		}

		const content = container.querySelector(".mxd-shell-content");
		console.log("FINAL CONTENT:", content?.innerHTML?.slice(0, 500));
		// Should not be just the loading fallback
		expect(content?.textContent).not.toBe("Loading plugin...");
	});
});
