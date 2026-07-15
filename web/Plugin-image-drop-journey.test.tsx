/// <reference lib="dom" />
/**
 * CANONICAL USER JOURNEY for page-wide image drag-drop, full stack:
 * real daemon → real Plugin.tsx wiring → window drop handler
 * (useWindowFileDrop) → Plugin's imageDropRequest state hop → AppFooter →
 * InputBar → handleFileToBase64 → composer preview thumbnail.
 *
 * Guards the SEAM the component tests can't: Plugin.tsx's
 * useWindowFileDrop → handleImageFiles → imageDropRequest → AppFooter →
 * InputBar prop chain. If any link is dropped (hook not called, or
 * imageDropRequest not forwarded through AppFooter), this fails while the
 * component tests (web/file-drop-hook, web/InputBar-image-drop) stay green.
 *
 * Also pins the RED LINE: a global handler must NOT intercept internal HTML5
 * drags (task-tree reorder) — a dragover carrying text/plain over the sidebar
 * is left un-prevented.
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
const LOG_TEXT = "Ready to receive a dropped screenshot";

/** Dispatch a synthetic DragEvent on an element (bubbles to the window). */
function dispatchDrag(
	target: Element,
	type: string,
	dt: { types: string[]; files: File[] },
): Event {
	const ev = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(ev, "dataTransfer", {
		value: { types: dt.types, files: dt.files, dropEffect: "" },
	});
	target.dispatchEvent(ev);
	return ev;
}

describe("Plugin — global image drag-drop full journey", () => {
	let daemon: DaemonInstance;
	let tempDir: string;
	let savedFetch: typeof fetch;
	const projectId = "pd1";
	const rootNodeId = "root-drop-journey";

	beforeAll(async () => {
		GlobalRegistrator.register();
		(
			globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
		).IS_REACT_ACT_ENVIRONMENT = false;

		// Desktop viewport so the Plugin renders the full layout (sidebar etc).
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

		tempDir = await mkdtemp(join(tmpdir(), "plugin-drop-journey-"));
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

	test("drop an image on the sidebar → composer attachment; internal drag untouched", async () => {
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

		// 1. App ready: sidebar + composer are present.
		const sidebar = await waitFor(() => div.querySelector(".mxd-sidebar"));
		await waitFor(() =>
			div.querySelector<HTMLTextAreaElement>("textarea.mxd-prompt-input"),
		);
		await new Promise((r) => setTimeout(r, 50)); // settle window listeners

		// 2. RED LINE: an internal HTML5 drag (text/plain) over the sidebar is
		//    NOT intercepted by the global handler — the task tree owns it.
		const internal = dispatchDrag(sidebar, "dragover", {
			types: ["text/plain"],
			files: [],
		});
		expect(internal.defaultPrevented).toBe(false);

		// 3. A file drag over the sidebar shows the overlay + suppresses default.
		dispatchDrag(sidebar, "dragenter", { types: ["Files"], files: [] });
		const over = dispatchDrag(sidebar, "dragover", {
			types: ["Files"],
			files: [],
		});
		expect(over.defaultPrevented).toBe(true);
		await waitFor(() => div.querySelector(".mxd-global-drop-overlay"));

		// 4. Drop an image ON THE SIDEBAR (not the composer) → it attaches.
		const file = new File(
			[new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
			"shot.png",
			{ type: "image/png" },
		);
		const drop = dispatchDrag(sidebar, "drop", {
			types: ["Files"],
			files: [file],
		});
		expect(drop.defaultPrevented).toBe(true);

		// 5. The composer shows the preview thumbnail (data URL).
		const preview = await waitFor(() =>
			div.querySelector<HTMLImageElement>(".mxd-image-previews img"),
		);
		expect(preview.src.startsWith("data:image/png;base64,")).toBe(true);

		// Overlay gone after the drop.
		await waitFor(() =>
			div.querySelector(".mxd-global-drop-overlay") === null ? true : null,
		);

		root.unmount();
		div.remove();
	}, 30000);
});
