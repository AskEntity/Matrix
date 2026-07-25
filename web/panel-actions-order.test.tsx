/// <reference lib="dom" />
/**
 * The panel header's action row is a right-aligned flex row. Inserting a child
 * into it moves the children BEFORE that child and leaves the ones after it
 * alone. So any control that toggles with the scroll position must sit in
 * FRONT of the controls that are always there — otherwise every scroll away
 * from the bottom shoves the persistent controls sideways.
 *
 * Measured in a real browser before the fix (Follow rendered between the token
 * badge and ⚡): scrolling up moved the ⌘ Compact button and the token badge
 * left by 71.3px. After the fix both stay at the same x.
 *
 * The invariant pinned here is ORDER: every scroll-state control precedes
 * every persistent child.
 *
 * There was a second invariant, ONE COMMIT — clicking Follow had to hide the
 * icon-only ↓ button in the SAME render, because the two were driven by two
 * booleans that flipped a frame apart and the row changed width twice. That
 * duplicate control is gone (Follow always did the same thing), so the
 * coherence question no longer exists rather than having been answered.
 * ⚠️ If a second scroll-state control is ever added, it comes back with it —
 * two controls sharing this row must appear and disappear in one commit.
 *
 * happy-dom does no layout, so this test asserts DOM order — the thing that
 * CAUSES the geometry. The geometry itself was verified by hand in Chrome
 * (see the task's report).
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

describe("panel actions — scroll-state controls stay leftmost", () => {
	let daemon: DaemonInstance;
	let tempDir: string;
	let savedFetch: typeof fetch;
	const projectId = "pao1";
	const rootNodeId = "root-panel-actions-order";

	beforeAll(async () => {
		GlobalRegistrator.register();
		(
			globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
		).IS_REACT_ACT_ENVIRONMENT = false;

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

		tempDir = await mkdtemp(join(tmpdir(), "panel-actions-order-"));
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
						// verify, not pending: a task that owns a session is never
						// "pending" in production, and clearSessionState drops the log
						// for sessions transitioning to pending.
						status: "verify",
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
		// The `usage` event is what makes the TokenUsageBadge (⌘ + badge) render;
		// those are the persistent controls this test asserts about.
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

	test("the Follow control precedes every persistent control, and clicking it jumps to the bottom", async () => {
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

		const logContainer = await waitFor(() => {
			const el = div.querySelector<HTMLElement>(".mxd-activity-log");
			return el?.textContent?.includes(LOG_TEXT) ? el : null;
		});
		// The activity panel's action row — NOT the sidebar's, which shares the
		// class name. The fullscreen button only exists in this one.
		const actions = await waitFor(() =>
			Array.from(div.querySelectorAll<HTMLElement>(".mxd-panel-actions")).find(
				(g) => g.querySelector(".mxd-fullscreen-btn"),
			),
		);
		await waitFor(() => actions.querySelector(".mxd-compact-trigger-btn"));

		// Scroll away from the bottom: mock overflow geometry, then fire scroll.
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

		const follow = await waitFor(() =>
			actions.querySelector<HTMLButtonElement>(".mxd-scroll-follow-btn"),
		);

		// ── The invariant: order ──────────────────────────────────────────
		// Every scroll-state control comes before every persistent control.
		const children = Array.from(actions.children);
		const persistentIdx = children
			.map((c, i) => ({ c, i }))
			.filter(({ c }) => c !== follow)
			.map(({ i }) => i);

		expect(children.indexOf(follow)).not.toBe(-1);
		expect(persistentIdx.length).toBeGreaterThan(0);
		expect(children.indexOf(follow)).toBeLessThan(Math.min(...persistentIdx));

		// And the control does its job: jump to the bottom, and stand down.
		follow.click();
		await waitFor(
			() => actions.querySelector(".mxd-scroll-follow-btn") === null,
		);
		expect(logContainer.scrollTop).toBe(1000);

		root.unmount();
		div.remove();
	}, 30000);
});
