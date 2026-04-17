/// <reference lib="dom" />
/**
 * Shell + Plugin tests.
 *
 * Part 1 (HTTP): build pipeline outputs correct (importmap, compiled JS, routes).
 * Part 2 (Render): Plugin component renders real Matrix UI (task tree, Orchestrator).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { DEFAULT_CONFIG, saveGlobalConfig } from "../src/config.ts";
import { createDaemon, type DaemonInstance } from "../src/daemon.ts";

// ── Part 1: HTTP build pipeline ──

describe("daemon web build pipeline", () => {
	let daemon: DaemonInstance;
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "ui-http-"));
		const dataDir = join(tempDir, ".mxd");
		await mkdir(join(dataDir, "projects"), { recursive: true });
		await writeFile(
			join(dataDir, "projects.json"),
			JSON.stringify([
				{
					id: "m1",
					name: "matrix",
					path: resolve("."),
					createdAt: "2026-01-01",
				},
			]),
		);
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));
		daemon = await createDaemon({ dataDir, autoInitAuth: false });
	}, 15000);

	afterAll(async () => {
		await daemon?.shutdown();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("root HTML includes importmap + shell entry + CSS", async () => {
		const res = await daemon.fetch(new Request("http://localhost/"));
		const html = await res.text();
		expect(html).toContain("importmap");
		expect(html).toContain("/vendor/react.js");
		expect(html).toContain("/app/web/main.js");
	});

	test("plugins returns compiled JS path", async () => {
		const plugins = await (
			await daemon.fetch(new Request("http://localhost/plugins"))
		).json();
		const matrix = plugins.find((p: { name: string }) => p.name === "matrix");
		expect(matrix.webComponentPath).toMatch(/^\/app\/.*\.js$/);
	});

	test("vendor + app assets servable", async () => {
		expect(
			(await daemon.fetch(new Request("http://localhost/vendor/react.js")))
				.status,
		).toBe(200);
		expect(
			(await daemon.fetch(new Request("http://localhost/app/web/main.js")))
				.status,
		).toBe(200);
	});
});

// ── Part 2: Render — Plugin component shows Matrix UI ──

describe("plugin component renders Matrix UI", () => {
	let daemon: DaemonInstance;
	let tempDir: string;
	let savedFetch: typeof fetch;

	beforeAll(async () => {
		// happy-dom FIRST — Plugin.tsx reads window.location at module load
		GlobalRegistrator.register();

		tempDir = await mkdtemp(join(tmpdir(), "ui-render-"));
		const dataDir = join(tempDir, ".mxd");
		await mkdir(join(dataDir, "projects"), { recursive: true });
		await writeFile(
			join(dataDir, "projects.json"),
			JSON.stringify([
				{
					id: "m1",
					name: "matrix",
					path: resolve("."),
					createdAt: "2026-01-01",
				},
			]),
		);
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));
		daemon = await createDaemon({ dataDir, autoInitAuth: false });

		// Mock EventSource (happy-dom doesn't have it, plugin's SSE hook needs it)
		if (!globalThis.EventSource) {
			(globalThis as unknown as Record<string, unknown>).EventSource =
				class MockEventSource {
					onmessage: ((e: unknown) => void) | null = null;
					onerror: ((e: unknown) => void) | null = null;
					onopen: (() => void) | null = null;
					close() {}
					addEventListener() {}
					removeEventListener() {}
				};
		}

		// Patch fetch — route through daemon.fetch
		savedFetch = globalThis.fetch;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			let url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.toString()
						: input.url;
			if (url.startsWith("/")) url = `http://localhost${url}`;
			if (url.includes("/auth/status"))
				return new Response(
					JSON.stringify({ enabled: false, authenticated: true }),
					{ headers: { "content-type": "application/json" } },
				);
			const res = await daemon.fetch(new Request(url, init));
			const body = await res.text();
			return new Response(body, { status: res.status, headers: res.headers });
		}) as typeof fetch;
	}, 15000);

	afterAll(async () => {
		globalThis.fetch = savedFetch;
		await daemon?.shutdown();
		await rm(tempDir, { recursive: true, force: true });
		GlobalRegistrator.unregister();
	});

	test("Plugin renders Orchestrator + task tree (not just loading)", async () => {
		const { createRoot } = await import("react-dom/client");
		const { createElement } = await import("react");
		const { AuthFetchProvider, GetTokenProvider } = await import(
			"./auth-context.ts"
		);
		const { authFetch, getToken } = await import("./auth.ts");
		const { Plugin } = await import("../.mxd/plugin/web/Plugin.tsx");

		// Render using ReactDOM directly (not @testing-library, which conflicts with beforeAll)
		const div = document.createElement("div");
		document.body.appendChild(div);
		const root = createRoot(div);

		await new Promise<void>((resolve) => {
			root.render(
				createElement(
					AuthFetchProvider,
					{ value: authFetch },
					createElement(
						GetTokenProvider,
						{ value: getToken },
						createElement(Plugin, { projectId: "m1" }),
					),
				),
			);
			setTimeout(resolve, 100);
		});

		// Wait for plugin to fetch task tree and render
		for (let i = 0; i < 30; i++) {
			await new Promise((r) => setTimeout(r, 200));
			const text = div.textContent ?? "";
			if (text.includes("Orchestrator")) break;
		}

		const text = div.textContent ?? "";
		console.log("PLUGIN RENDER:", text.slice(0, 300));

		// Real Matrix UI — not loading/empty states
		expect(text.length).toBeGreaterThan(50);
		expect(text).not.toContain("Loading plugin");
		expect(text).not.toContain("No project selected");

		root.unmount();
		div.remove();
	});
});

// ── Part 3: Sidebar toggle — unified open/close state, width invariant ──
//
// Invariants under test:
//   (1) Toggle button is ALWAYS rendered (only fullscreen hides it).
//   (2) Click toggles visibility both directions — open ↔ closed.
//   (3) Width is NEVER 0 while open. Snap-close preserves last-valid width,
//       so re-opening always shows a visible sidebar. This is the regression
//       guard for the "button click hides sidebar but leaves it invisible"
//       bug — mutate the drag handler to set width=0 on snap-close, and this
//       test catches it.
//   (4) Cmd+B keyboard shortcut = button click (same handler).
//   (5) Legacy `mxd-sidebar-collapsed` localStorage key migrates to
//       `mxd-sidebar-open` (inverted) on first mount, then is removed.

describe("sidebar toggle — unified state model", () => {
	let daemon: DaemonInstance;
	let tempDir: string;
	let savedFetch: typeof fetch;

	beforeAll(async () => {
		GlobalRegistrator.register();

		// Force "desktop" viewport so first-visit default is "open".
		// matchMedia matches only min-width queries (desktop detection).
		(
			window as unknown as { matchMedia: (q: string) => MediaQueryList }
		).matchMedia = (query: string) =>
			({
				matches: query.includes("min-width"),
				media: query,
				onchange: null,
				addListener: () => {},
				removeListener: () => {},
				addEventListener: () => {},
				removeEventListener: () => {},
				dispatchEvent: () => false,
			}) as unknown as MediaQueryList;

		tempDir = await mkdtemp(join(tmpdir(), "ui-sidebar-"));
		const dataDir = join(tempDir, ".mxd");
		await mkdir(join(dataDir, "projects"), { recursive: true });
		await writeFile(
			join(dataDir, "projects.json"),
			JSON.stringify([
				{
					id: "m1",
					name: "matrix",
					path: resolve("."),
					createdAt: "2026-01-01",
				},
			]),
		);
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));
		daemon = await createDaemon({ dataDir, autoInitAuth: false });

		if (!globalThis.EventSource) {
			(globalThis as unknown as Record<string, unknown>).EventSource =
				class MockEventSource {
					onmessage: ((e: unknown) => void) | null = null;
					onerror: ((e: unknown) => void) | null = null;
					onopen: (() => void) | null = null;
					close() {}
					addEventListener() {}
					removeEventListener() {}
				};
		}

		savedFetch = globalThis.fetch;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			let url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.toString()
						: input.url;
			if (url.startsWith("/")) url = `http://localhost${url}`;
			if (url.includes("/auth/status"))
				return new Response(
					JSON.stringify({ enabled: false, authenticated: true }),
					{ headers: { "content-type": "application/json" } },
				);
			const res = await daemon.fetch(new Request(url, init));
			const body = await res.text();
			return new Response(body, { status: res.status, headers: res.headers });
		}) as typeof fetch;
	}, 15000);

	afterAll(async () => {
		globalThis.fetch = savedFetch;
		await daemon?.shutdown();
		await rm(tempDir, { recursive: true, force: true });
		GlobalRegistrator.unregister();
	});

	/** Render Plugin with fresh localStorage. Returns the mount container + unmount. */
	async function mountPlugin(
		initialLocalStorage: Record<string, string> = {},
	): Promise<{ div: HTMLDivElement; unmount: () => void }> {
		localStorage.clear();
		for (const [k, v] of Object.entries(initialLocalStorage)) {
			localStorage.setItem(k, v);
		}

		const { createRoot } = await import("react-dom/client");
		const { createElement } = await import("react");
		const { AuthFetchProvider, GetTokenProvider } = await import(
			"./auth-context.ts"
		);
		const { authFetch, getToken } = await import("./auth.ts");
		const { Plugin } = await import("../.mxd/plugin/web/Plugin.tsx");

		const div = document.createElement("div");
		document.body.appendChild(div);
		const root = createRoot(div);
		root.render(
			createElement(
				AuthFetchProvider,
				{ value: authFetch },
				createElement(
					GetTokenProvider,
					{ value: getToken },
					createElement(Plugin, { projectId: "m1" }),
				),
			),
		);

		// Wait until the plugin has rendered the toggle button (indicates the
		// sidebar shell is up; we don't care about task-tree data for these tests).
		for (let i = 0; i < 30; i++) {
			await new Promise((r) => setTimeout(r, 100));
			if (div.querySelector(".mxd-sidebar-expand-btn")) break;
		}
		return {
			div,
			unmount: () => {
				root.unmount();
				div.remove();
			},
		};
	}

	test("toggle button is always rendered — open state", async () => {
		const { div, unmount } = await mountPlugin();
		expect(div.querySelector(".mxd-sidebar-expand-btn")).toBeTruthy();
		const sidebar = div.querySelector(".mxd-sidebar");
		expect(sidebar?.classList.contains("mxd-sidebar-open")).toBe(true);
		expect(sidebar?.classList.contains("mxd-sidebar-collapsed")).toBe(false);
		unmount();
	});

	test("toggle button is always rendered — closed state", async () => {
		const { div, unmount } = await mountPlugin({
			"mxd-sidebar-open": "false",
		});
		expect(div.querySelector(".mxd-sidebar-expand-btn")).toBeTruthy();
		const sidebar = div.querySelector(".mxd-sidebar");
		expect(sidebar?.classList.contains("mxd-sidebar-collapsed")).toBe(true);
		expect(sidebar?.classList.contains("mxd-sidebar-open")).toBe(false);
		unmount();
	});

	test("click toggles visibility both directions, persists to localStorage", async () => {
		const { div, unmount } = await mountPlugin();
		const sidebar = div.querySelector(".mxd-sidebar") as HTMLElement;
		const button = div.querySelector(
			".mxd-sidebar-expand-btn",
		) as HTMLButtonElement;

		// Initially open (desktop default)
		expect(sidebar.classList.contains("mxd-sidebar-open")).toBe(true);

		// Click → close
		button.click();
		await new Promise((r) => setTimeout(r, 50));
		expect(sidebar.classList.contains("mxd-sidebar-collapsed")).toBe(true);
		expect(sidebar.classList.contains("mxd-sidebar-open")).toBe(false);
		expect(localStorage.getItem("mxd-sidebar-open")).toBe("false");

		// Click → open
		button.click();
		await new Promise((r) => setTimeout(r, 50));
		expect(sidebar.classList.contains("mxd-sidebar-open")).toBe(true);
		expect(sidebar.classList.contains("mxd-sidebar-collapsed")).toBe(false);
		expect(localStorage.getItem("mxd-sidebar-open")).toBe("true");

		// Width inline style is applied when open, and >= MIN_OPEN_WIDTH (180)
		const widthStr = sidebar.style.getPropertyValue("--sidebar-w");
		const width = Number(widthStr.replace("px", ""));
		expect(width).toBeGreaterThanOrEqual(180);

		unmount();
	});

	test("snap-close drag, then click — sidebar opens with visible width (regression)", async () => {
		// This is the bug regression test. Old code set sidebarWidth=0 on
		// snap-close. Clicking the button flipped collapsed→false but didn't
		// restore width → sidebar rendered at 0 pixels → "button does nothing".
		// Mutation: change the drag handler to `setSidebarWidth(0)` under the
		// SNAP_CLOSE branch — this test must fail.
		const { div, unmount } = await mountPlugin();
		const sidebar = div.querySelector(".mxd-sidebar") as HTMLElement;
		const handle = div.querySelector(
			".mxd-sidebar-resize-handle",
		) as HTMLElement;
		const button = div.querySelector(
			".mxd-sidebar-expand-btn",
		) as HTMLButtonElement;

		// Simulate a snap-close drag: mousedown on handle, move below threshold, up
		handle.dispatchEvent(
			new MouseEvent("mousedown", { bubbles: true, clientX: 288 }),
		);
		await new Promise((r) => setTimeout(r, 30));
		document.dispatchEvent(
			new MouseEvent("mousemove", { bubbles: true, clientX: 50 }),
		);
		await new Promise((r) => setTimeout(r, 30));
		document.dispatchEvent(
			new MouseEvent("mouseup", { bubbles: true, clientX: 50 }),
		);
		await new Promise((r) => setTimeout(r, 60));

		// After snap-close: sidebar is collapsed (hidden via class)
		expect(sidebar.classList.contains("mxd-sidebar-collapsed")).toBe(true);

		// Click button to re-open
		button.click();
		await new Promise((r) => setTimeout(r, 60));

		// Core assertion: sidebar is open AND width is visibly > 0
		expect(sidebar.classList.contains("mxd-sidebar-open")).toBe(true);
		expect(sidebar.classList.contains("mxd-sidebar-collapsed")).toBe(false);
		const widthStr = sidebar.style.getPropertyValue("--sidebar-w");
		const width = Number(widthStr.replace("px", ""));
		expect(width).toBeGreaterThanOrEqual(180);

		unmount();
	});

	test("Cmd+B keyboard shortcut behaves identically to button click", async () => {
		const { div, unmount } = await mountPlugin();
		const sidebar = div.querySelector(".mxd-sidebar") as HTMLElement;

		expect(sidebar.classList.contains("mxd-sidebar-open")).toBe(true);

		// Cmd+B → close
		document.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "b",
				metaKey: true,
				bubbles: true,
			}),
		);
		await new Promise((r) => setTimeout(r, 50));
		expect(sidebar.classList.contains("mxd-sidebar-collapsed")).toBe(true);
		expect(localStorage.getItem("mxd-sidebar-open")).toBe("false");

		// Cmd+B → open (with visible width, same invariant as button click)
		document.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "b",
				metaKey: true,
				bubbles: true,
			}),
		);
		await new Promise((r) => setTimeout(r, 50));
		expect(sidebar.classList.contains("mxd-sidebar-open")).toBe(true);
		const widthStr = sidebar.style.getPropertyValue("--sidebar-w");
		expect(Number(widthStr.replace("px", ""))).toBeGreaterThanOrEqual(180);

		unmount();
	});

	test("migrates legacy mxd-sidebar-collapsed key on first mount", async () => {
		// User had old-schema storage: collapsed=true. Expect mount to:
		//   1. Interpret as open=false (inverted semantic)
		//   2. Write new key mxd-sidebar-open=false
		//   3. Remove the old key
		const { div, unmount } = await mountPlugin({
			"mxd-sidebar-collapsed": "true",
		});
		const sidebar = div.querySelector(".mxd-sidebar") as HTMLElement;

		expect(sidebar.classList.contains("mxd-sidebar-collapsed")).toBe(true);
		expect(localStorage.getItem("mxd-sidebar-open")).toBe("false");
		expect(localStorage.getItem("mxd-sidebar-collapsed")).toBeNull();
		unmount();
	});
});
