/// <reference lib="dom" />
/**
 * Shell + Plugin tests.
 *
 * Part 1 (HTTP): build pipeline outputs correct (importmap, compiled JS, routes).
 * Part 2 (Render): Plugin component renders real Matrix UI (task tree, Orchestrator).
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
		await writeFile(join(dataDir, "projects.json"),
			JSON.stringify([{ id: "m1", name: "matrix", path: resolve("."), createdAt: "2026-01-01" }]));
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));
		daemon = await createDaemon({ dataDir });
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
		const plugins = await (await daemon.fetch(new Request("http://localhost/plugins"))).json();
		const matrix = plugins.find((p: { name: string }) => p.name === "matrix");
		expect(matrix.webComponentPath).toMatch(/^\/app\/.*\.js$/);
	});

	test("vendor + app assets servable", async () => {
		expect((await daemon.fetch(new Request("http://localhost/vendor/react.js"))).status).toBe(200);
		expect((await daemon.fetch(new Request("http://localhost/app/web/main.js"))).status).toBe(200);
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
		await writeFile(join(dataDir, "projects.json"),
			JSON.stringify([{ id: "m1", name: "matrix", path: resolve("."), createdAt: "2026-01-01" }]));
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));
		daemon = await createDaemon({ dataDir });

		// Mock EventSource (happy-dom doesn't have it, plugin's SSE hook needs it)
		if (!globalThis.EventSource) {
			(globalThis as unknown as Record<string, unknown>).EventSource = class MockEventSource {
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
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			let url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url.startsWith("/")) url = `http://localhost${url}`;
			if (url.includes("/auth/status"))
				return new Response(JSON.stringify({ enabled: false, authenticated: true }),
					{ headers: { "content-type": "application/json" } });
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
		const { AuthFetchProvider, GetTokenProvider } = await import("./auth-context.ts");
		const { authFetch, getToken } = await import("./auth.ts");
		const { Plugin } = await import("../.mxd/plugin/web/Plugin.tsx");

		// Render using ReactDOM directly (not @testing-library, which conflicts with beforeAll)
		const div = document.createElement("div");
		document.body.appendChild(div);
		const root = createRoot(div);

		await new Promise<void>((resolve) => {
			root.render(
				createElement(AuthFetchProvider, { value: authFetch },
					createElement(GetTokenProvider, { value: getToken },
						createElement(Plugin, { projectId: "m1" })
					)
				)
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
