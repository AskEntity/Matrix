/// <reference lib="dom" />
/**
 * CANONICAL USER JOURNEY for select-to-quote ("Ask Matrix"), full stack:
 * real daemon → real Plugin.tsx wiring → ActivityLog selection → floating
 * button → Plugin's quoteRequest state hop → AppFooter → InputBar draft.
 *
 * The component tests (web/ActivityLog-quote.test.tsx, web/InputBar-quote.test.tsx)
 * cover the two ends; this test covers the seam between them — Plugin.tsx's
 * handleQuoteText → quoteRequest → AppFooter → InputBar prop chain. If any
 * link in that chain is dropped (e.g. onQuoteText not passed to ActivityLog,
 * or quoteRequest not forwarded through AppFooter), this test fails while the
 * component tests stay green.
 *
 * Setup: tree.json + a session JSONL with one assistant_text event are seeded
 * at matrix's dataRoot (projects/<id>/plugin/matrix/…) so the activity log
 * renders selectable text.
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

const LOG_TEXT = "Deploy failed because the token expired at midnight";

describe("Plugin — select-to-quote full journey", () => {
	let daemon: DaemonInstance;
	let tempDir: string;
	let savedFetch: typeof fetch;
	const projectId = "pq1";
	const rootNodeId = "root-quote-journey";

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

		tempDir = await mkdtemp(join(tmpdir(), "plugin-quote-journey-"));
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
		// One assistant reply in the root session → selectable text in the log.
		await writeFile(
			join(matrixDir, "tasks", `${rootNodeId}.jsonl`),
			`${JSON.stringify({
				type: "assistant_text",
				content: LOG_TEXT,
				taskId: rootNodeId,
				ts: 1000,
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

	test("select log text → Ask Matrix → quote lands in the InputBar draft", async () => {
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

		// 1. App ready: the seeded assistant reply is visible in the activity log.
		const logContainer = await waitFor(() => {
			const el = div.querySelector(".mxd-activity-log");
			return el?.textContent?.includes(LOG_TEXT) ? el : null;
		});
		// Give React a settle tick so the selection listener effect is attached.
		await new Promise((r) => setTimeout(r, 50));

		// 2. User selects "token expired" inside the log entry.
		const walker = document.createTreeWalker(
			logContainer,
			NodeFilter.SHOW_TEXT,
		);
		let textNode: Node | null = walker.nextNode();
		while (textNode && !textNode.textContent?.includes("token expired")) {
			textNode = walker.nextNode();
		}
		if (!textNode) throw new Error("log text node not found");
		const offset = textNode.textContent?.indexOf("token expired") ?? 0;
		const range = document.createRange();
		range.setStart(textNode, offset);
		range.setEnd(textNode, offset + "token expired".length);
		const sel = window.getSelection();
		sel?.removeAllRanges();
		sel?.addRange(range);
		document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

		// 3. The floating "Ask Matrix" button appears.
		const btn = await waitFor(() =>
			document.querySelector<HTMLButtonElement>(".mxd-selection-quote-btn"),
		);
		expect(btn.textContent).toContain("Ask Matrix");

		// 4. Click → the quote lands in the InputBar draft, textarea focused.
		btn.click();
		const textarea = await waitFor(() => {
			const el = div.querySelector<HTMLTextAreaElement>(
				"textarea.mxd-prompt-input",
			);
			return el?.value.includes("token expired") ? el : null;
		});
		expect(textarea.value).toBe("> token expired\n\n");
		await waitFor(() => document.activeElement === textarea);

		// Button dismissed after the click.
		expect(document.querySelector(".mxd-selection-quote-btn")).toBeNull();

		root.unmount();
		div.remove();
	}, 30000);
});
