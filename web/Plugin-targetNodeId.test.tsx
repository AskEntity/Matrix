/// <reference lib="dom" />
/**
 * Plugin-level integration: after useTasks populates rootNodeId (selectedTaskId
 * unset, as on fresh mount), Plugin.tsx's effect sets targetNodeId = rootNodeId.
 *
 * That value propagates to InputBar, where the textarea placeholder is:
 *   - `Message to "<task title>"…` when targetNodeId is truthy AND the id is
 *     in nodeMap.
 *   - `Send a message…` otherwise.
 *
 * This test verifies the root-as-regular-task invariant end-to-end: if the
 * Plugin.tsx effect regresses to the old branching form
 * `if (!selectedTaskId || selectedTaskId === rootNodeId) setTargetNodeId(null)`,
 * targetNodeId stays null, the ternary takes the false branch, and the
 * placeholder reverts to the generic "Send a message…".
 *
 * Mutation proof: reverting either the effect or the InputBar placeholder's
 * targetNodeId check makes this test fail.
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

// Hermetic repo root (see ShellApp.test.tsx).
const MATRIX_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("Plugin — targetNodeId resolves to rootNodeId after useTasks", () => {
	let daemon: DaemonInstance;
	let tempDir: string;
	let savedFetch: typeof fetch;
	const projectId = "p1";
	const rootNodeId = "root-abc-123";

	beforeAll(async () => {
		GlobalRegistrator.register();
		(
			globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
		).IS_REACT_ACT_ENVIRONMENT = false;

		// Force desktop viewport so the sidebar is open + Plugin renders fully.
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

		tempDir = await mkdtemp(join(tmpdir(), "plugin-targetnode-"));
		const dataDir = join(tempDir, ".mxd");
		const projectsDir = join(dataDir, "projects");
		await mkdir(projectsDir, { recursive: true });

		// Register a project pointing at Matrix's repo (plugin discovery).
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

		// Pre-seed tree.json with a root task. Daemon's TaskTracker will load it
		// and expose the id via GET /tasks → the plugin's useTasks hook sees it.
		const projectDir = join(projectsDir, projectId);
		await mkdir(join(projectDir, "tasks"), { recursive: true });
		await writeFile(
			join(projectDir, "tree.json"),
			JSON.stringify({
				rootNodeId,
				nodes: [
					{
						id: rootNodeId,
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
	}, 20000);

	afterAll(async () => {
		globalThis.fetch = savedFetch;
		await daemon?.shutdown();
		await rm(tempDir, { recursive: true, force: true });
		// Drain React scheduler before teardown.
		await new Promise((r) => setTimeout(r, 20));
		GlobalRegistrator.unregister();
	});

	test("InputBar placeholder reflects root task title after useTasks resolves", async () => {
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

		// Shell-like stateful wrapper: Plugin's pushPluginPath calls set a
		// local state, which flows back down as pluginPath prop. Mimics
		// shell's real behavior for the URL-normalization effect.
		function TestShell() {
			const [pluginPath, setPluginPath] = useState("");
			return createElement(Plugin, {
				projectId,
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

		// Wait for useTasks to fetch → rootNodeId populates → effect sets
		// targetNodeId = rootNodeId → InputBar sees it and renders "Message to X".
		let placeholder: string | null = null;
		for (let i = 0; i < 60; i++) {
			await new Promise((r) => setTimeout(r, 100));
			const textarea = div.querySelector(
				"textarea",
			) as HTMLTextAreaElement | null;
			if (textarea?.placeholder.includes("Orchestrator")) {
				placeholder = textarea.placeholder;
				break;
			}
		}

		// Regression guard: the old targetNodeId=null sentinel form (reverted
		// Plugin.tsx effect) never fills targetNodeId, so this placeholder
		// stays at the generic "Send a message…" form. The assertion below
		// demands the specific form with the root task's title.
		expect(placeholder).toBeTruthy();
		expect(placeholder).toContain("Orchestrator");
		expect(placeholder).toContain("Message to");

		root.unmount();
		div.remove();
	}, 20000);
});
