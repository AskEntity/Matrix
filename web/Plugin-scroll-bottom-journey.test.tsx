/// <reference lib="dom" />
/**
 * CANONICAL USER JOURNEY for getting back to the newest content, full stack:
 * real daemon → real Plugin.tsx wiring → user scrolls the activity log up →
 * the Follow control appears immediately LEFT of the Compact button → click →
 * the log jumps to the bottom, follow mode resumes, the control hides.
 *
 * There is exactly ONE control for this. An icon-only ↓ button used to sit
 * beside Follow calling the identical handler, and it is gone — do not add a
 * second entry point back. The jump MECHANISM was already single (Plugin.tsx's
 * `scrollBottomRequest` counter); what duplicated was the way in.
 *
 * The component tests (web/ActivityLog-scroll-report.test.tsx) cover the
 * reporting mechanism; this test covers the seam — Plugin.tsx's autoScroll
 * state, the onAutoScrollChange prop wiring, the control's placement in
 * .mxd-panel-actions, and the click handler. If any link is dropped (e.g.
 * onAutoScrollChange not passed to ActivityLog, or the control not rendered),
 * this test fails while the component tests stay green.
 *
 * Setup mirrors web/Plugin-quote-journey.test.tsx: tree.json + a session
 * JSONL seeded at matrix's dataRoot. A `usage` event is seeded so the
 * TokenUsageBadge (⌘ Compact button) renders — needed to assert placement.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { DEFAULT_CONFIG, saveGlobalConfig } from "../src/config.ts";
import { createDaemon, type DaemonInstance } from "../src/daemon.ts";
import { createTestToken } from "../src/test-utils/auth-helper.ts";

const MATRIX_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const LOG_TEXT = "A long assistant reply the user scrolled away from";

describe("Plugin — back-to-newest (Follow) full journey", () => {
	let daemon: DaemonInstance;
	let tempDir: string;
	let savedFetch: typeof fetch;
	const projectId = "psb1";
	const rootNodeId = "root-scroll-bottom-journey";

	beforeAll(async () => {
		GlobalRegistrator.register();
		(
			globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
		).IS_REACT_ACT_ENVIRONMENT = false;

		// Desktop viewport so the Plugin renders the full layout.
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

		tempDir = await mkdtemp(join(tmpdir(), "plugin-scroll-bottom-"));
		const dataDir = join(tempDir, ".mxd");
		await mkdir(join(dataDir, "projects"), { recursive: true });

		await writeFile(
			join(dataDir, "projects.json"),
			JSON.stringify([
				{
					id: projectId,
					name: "fixture",
					path: MATRIX_REPO_ROOT,
					createdAt: "2026-01-01",
				},
			]),
		);

		// Seed at matrix's dataRoot: projects/<id>/plugin/matrix/
		const matrixDir = join(dataDir, "projects", projectId, "plugin", "matrix");
		await mkdir(join(matrixDir, "tasks"), { recursive: true });
		await writeFile(
			join(matrixDir, "tree.json"),
			JSON.stringify({
				rootNodeId,
				nodes: [
					{
						id: rootNodeId,
						type: "task",
						title: "Orchestrator",
						description: "",
						parentId: null,
						children: [],
						status: "pending",
						branch: "main",
						editedBy: "user",
						costUsd: 0,
						budgetUsd: -1,
						createdAt: "2026-01-01T00:00:00.000Z",
						updatedAt: "2026-01-01T00:00:00.000Z",
					},
				],
			}),
		);
		// One assistant reply (log content) + a usage event (renders the
		// TokenUsageBadge, i.e. the ⌘ Compact button, in the panel header).
		await writeFile(
			join(matrixDir, "tasks", `${rootNodeId}.jsonl`),
			`${JSON.stringify({
				type: "assistant_text",
				content: LOG_TEXT,
				taskId: rootNodeId,
				ts: 1000,
			})}\n${JSON.stringify({
				type: "usage",
				taskId: rootNodeId,
				inputTokens: 50_000,
				contextWindow: 200_000,
				ts: 1001,
			})}\n`,
		);

		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));
		const token = await createTestToken(join(dataDir, "auth.json"));
		daemon = await createDaemon({ dataDir });
		localStorage.setItem("mxd-jwt", token);

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
			const res = await daemon.fetch(new Request(url, init));
			const body = await res.text();
			return new Response(body, { status: res.status, headers: res.headers });
		}) as typeof fetch;
	}, 30000);

	afterAll(async () => {
		globalThis.fetch = savedFetch;
		await daemon?.shutdown();
		await rm(tempDir, { recursive: true, force: true });
		await new Promise((r) => setTimeout(r, 20));
		GlobalRegistrator.unregister();
	});

	test("scroll up → Follow appears left of Compact → click → back to bottom + hidden", async () => {
		const { createRoot } = await import("react-dom/client");
		const { createElement, useState } = await import("react");
		const { AuthFetchProvider, GetTokenProvider } = await import(
			"./auth-context.ts"
		);
		const { authFetch, getToken } = await import("./auth.ts");
		const { Plugin } = await import("../.mxd/plugin/web/Plugin.tsx");

		const div = document.createElement("div");
		document.body.appendChild(div);
		const root = createRoot(div);

		function TestShell() {
			const [pluginPath, setPluginPath] = useState("");
			return createElement(Plugin, {
				projectId,
				scope: "matrix",
				pluginPath,
				pushPluginPath: (path: string) => setPluginPath(path),
			});
		}

		root.render(
			createElement(
				AuthFetchProvider,
				{ value: authFetch },
				createElement(
					GetTokenProvider,
					{ value: getToken },
					createElement(TestShell),
				),
			),
		);

		const waitFor = async <T,>(
			fn: () => T,
			timeoutMs = 15000,
		): Promise<NonNullable<T>> => {
			const start = Date.now();
			for (;;) {
				const value = fn();
				if (value) return value as NonNullable<T>;
				if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
				await new Promise((r) => setTimeout(r, 50));
			}
		};
		const followBtn = () =>
			div.querySelector<HTMLButtonElement>(".mxd-scroll-follow-btn");

		// 1. App ready: seeded reply visible in the log, Compact button
		//    rendered (usage event consumed), Follow NOT shown yet.
		const logContainer = await waitFor(() => {
			const el = div.querySelector<HTMLElement>(".mxd-activity-log");
			return el?.textContent?.includes(LOG_TEXT) ? el : null;
		});
		const compactBtn = await waitFor(() =>
			div.querySelector<HTMLButtonElement>(".mxd-compact-trigger-btn"),
		);
		expect(followBtn()).toBeNull();

		// 2. User scrolls up: mock overflow geometry, position far from the
		//    bottom, and fire a scroll event.
		Object.defineProperty(logContainer, "scrollHeight", {
			value: 1000,
			configurable: true,
		});
		Object.defineProperty(logContainer, "clientHeight", {
			value: 300,
			configurable: true,
		});
		logContainer.scrollTop = 100;
		logContainer.dispatchEvent(new Event("scroll"));

		// 3. Follow appears — as a SIBLING immediately LEFT of Compact.
		const btn = await waitFor(followBtn);
		expect(btn.textContent).toContain("Follow");
		const panelActions = btn.parentElement;
		expect(panelActions?.className).toContain("mxd-panel-actions");
		expect(compactBtn.parentElement).toBe(panelActions);
		const children = Array.from(panelActions?.children ?? []);
		expect(children.indexOf(btn)).toBeLessThan(children.indexOf(compactBtn));

		// 4. Click → the log jumps to the bottom, follow mode resumes, and the
		//    control hides. One click, one commit, nothing left on screen —
		//    there is no second control that could linger a frame behind.
		btn.click();
		await waitFor(() => followBtn() === null);
		expect(logContainer.scrollTop).toBe(1000); // scrollTop = scrollHeight

		root.unmount();
		div.remove();
	}, 30000);
});
