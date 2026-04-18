/// <reference lib="dom" />
/**
 * Task Y regression suite — "URL path-based routing, plugin owns its segment".
 *
 * The bug this replaces: pre-Task-Y the URL used hash routing
 * `#<projectId>/<taskId>` with shell and plugin coordinating through the
 * shared hash. Shell ignored URL on mount (picked first project), plugin
 * tried to normalize but bailed when its `props.projectId !== hash.projectId`.
 * Result: refresh drifted state and URL apart.
 *
 * The fix: path-based routing `/<projectId>/<pluginScope>/<pluginPath>`.
 * Shell owns the `/<projectId>/<pluginScope>/` prefix; plugin owns the
 * suffix (`pluginPath`) and navigates via a shell-provided callback
 * `pushPluginPath(path, replace?)`. Plugin never touches `window.history`.
 *
 * These tests exercise the plugin alone with a stateful `TestShell` that
 * mimics shell's real behavior (holds `pluginPath` state, updates on
 * `pushPluginPath`). That's enough to verify the plugin's routing contract.
 *
 * No layer treats root specially at routing/targeting/identification.
 */

import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { DEFAULT_CONFIG, saveGlobalConfig } from "../src/config.ts";
import { createDaemon, type DaemonInstance } from "../src/daemon.ts";
import { createTestToken } from "../src/test-utils/auth-helper.ts";

describe("Plugin — path-based routing (Task Y)", () => {
	let daemon: DaemonInstance;
	let tempDir: string;
	let savedFetch: typeof fetch;
	const projectId = "p1";
	const rootNodeId = "root-tasky-abc";

	beforeAll(async () => {
		GlobalRegistrator.register();
		(
			globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
		).IS_REACT_ACT_ENVIRONMENT = false;

		// Force desktop viewport (sidebar open, full Plugin tree renders).
		(
			window as unknown as { matchMedia: (q: string) => MediaQueryList }
		).matchMedia = (query: string) =>
			({
				matches: query.includes("min-width") && query.includes("768"),
				media: query,
				onchange: null,
				addListener: () => {},
				removeListener: () => {},
				addEventListener: () => {},
				removeEventListener: () => {},
				dispatchEvent: () => false,
			}) as MediaQueryList;

		tempDir = await mkdtemp(join(tmpdir(), "plugin-url-taskid-"));
		const dataDir = join(tempDir, ".mxd");
		const projectPath = join(tempDir, "fake-project");
		await mkdir(projectPath, { recursive: true });
		await writeFile(
			join(projectPath, "package.json"),
			JSON.stringify({ name: "fake-project" }),
		);
		await mkdir(join(dataDir, "projects"), { recursive: true });
		await writeFile(
			join(dataDir, "projects.json"),
			JSON.stringify([
				{
					id: projectId,
					name: "fake",
					path: projectPath,
					createdAt: "2026-01-01",
				},
			]),
		);
		// Write tree.json so useTasks resolves with a proper root.
		const treeDir = join(dataDir, "projects", projectId);
		await mkdir(treeDir, { recursive: true });
		await writeFile(
			join(treeDir, "tree.json"),
			JSON.stringify({
				rootNodeId,
				nodes: [
					{
						id: rootNodeId,
						title: "Orchestrator",
						parentId: null,
						children: [],
						status: "pending",
						description: "",
					},
				],
			}),
		);
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));
		const token = await createTestToken(join(dataDir, "auth.json"));
		localStorage.setItem("mxd-jwt", token);
		daemon = await createDaemon({ dataDir });

		// happy-dom doesn't ship EventSource; the plugin opens one for SSE
		// and would ReferenceError. Mock it as a no-op shell so the plugin
		// can mount. We only care about HTTP paths for these tests.
		if (!globalThis.EventSource) {
			(globalThis as unknown as Record<string, unknown>).EventSource =
				class MockEventSource {
					onmessage: ((e: unknown) => void) | null = null;
					onerror: ((e: unknown) => void) | null = null;
					onopen: (() => void) | null = null;
					addEventListener() {}
					removeEventListener() {}
					close() {}
					readyState = 1;
					url = "";
					withCredentials = false;
					CONNECTING = 0 as const;
					OPEN = 1 as const;
					CLOSED = 2 as const;
					constructor(url: string) {
						this.url = url;
					}
				};
		}

		savedFetch = globalThis.fetch;
		globalThis.fetch = (async (
			input: string | URL | Request,
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
		await new Promise((r) => setTimeout(r, 20));
		GlobalRegistrator.unregister();
	});

	beforeEach(() => {
		const jwt = localStorage.getItem("mxd-jwt");
		localStorage.clear();
		if (jwt) localStorage.setItem("mxd-jwt", jwt);
	});

	/**
	 * Shell-like stateful wrapper. Holds `pluginPath` state and forwards
	 * `pushPluginPath` to a state-setter so the effect chain closes
	 * (plugin calls `pushPluginPath` → state updates → prop flows back down).
	 *
	 * `pushes` is a log of every `pushPluginPath` call; tests inspect to
	 * confirm the plugin triggered the expected normalizations/navigations.
	 */
	async function mountPlugin(initialPluginPath: string) {
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
		const pushes: Array<{ path: string; replace?: boolean }> = [];

		function TestShell() {
			const [pluginPath, setPluginPath] = useState(initialPluginPath);
			return createElement(Plugin, {
				projectId,
				pluginPath,
				pushPluginPath: (path: string, replace?: boolean) => {
					pushes.push({ path, replace });
					setPluginPath(path);
				},
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

		return {
			div,
			pushes,
			unmount: () => {
				root.unmount();
				div.remove();
			},
		};
	}

	async function waitForPlaceholder(
		div: HTMLElement,
		substr: string,
		attempts = 60,
	): Promise<string | null> {
		for (let i = 0; i < attempts; i++) {
			await new Promise((r) => setTimeout(r, 100));
			const textarea = div.querySelector(
				"textarea",
			) as HTMLTextAreaElement | null;
			if (textarea?.placeholder.includes(substr)) return textarea.placeholder;
		}
		return null;
	}

	test("pluginPath has root task id → first render shows root placeholder", async () => {
		// Common case post-normalization: shell passes pluginPath=<rootId>.
		// selectedTaskId derives from pluginPath (no async wait). Placeholder
		// reflects the root task title as soon as useTasks resolves.
		//
		// Mutation: replace `parsePluginPath(pluginPath).taskId` with null
		// → placeholder stays at generic "Send a message…", test fails.
		const { div, unmount } = await mountPlugin(rootNodeId);

		const placeholder = await waitForPlaceholder(div, "Orchestrator");
		expect(placeholder).toContain("Orchestrator");
		expect(placeholder).toContain("Message to");

		unmount();
	}, 20000);

	test("pluginPath empty → plugin calls pushPluginPath(rootNodeId, replace=true) once useTasks resolves", async () => {
		// Brand-new-project transient: shell hands over empty pluginPath
		// after `/<projectId>/matrix/` redirect. Plugin waits for useTasks,
		// then calls pushPluginPath(rootNodeId, true) — replace (no history
		// entry).
		//
		// Mutation: remove the URL normalization effect in plugin → no push
		// fires → pushes array stays empty → test fails.
		const { div, pushes, unmount } = await mountPlugin("");

		const placeholder = await waitForPlaceholder(div, "Orchestrator");
		expect(placeholder).toContain("Orchestrator");

		// Exactly one normalizing push with replace=true.
		const normalizing = pushes.filter(
			(p) => p.path === rootNodeId && p.replace === true,
		);
		expect(normalizing.length).toBeGreaterThanOrEqual(1);

		unmount();
	}, 20000);

	test("pluginPath has sub-task id → preserved verbatim, no normalization push", async () => {
		// Sub-task deeplink. The normalization effect must NOT fire — plugin
		// path already has a taskId (even if unknown to the tree).
		//
		// Mutation: a defensive "always go to root" mistake would show up as
		// an extra push to rootNodeId → test fails.
		const subTaskId = "sub-task-not-in-tree";
		const { pushes, unmount } = await mountPlugin(subTaskId);

		await new Promise((r) => setTimeout(r, 300));
		// No normalization calls — pluginPath was already non-empty, so the
		// plugin's normalization predicate (`pluginPath === ""`) never fired.
		expect(pushes.length).toBe(0);

		unmount();
	}, 20000);

	test("openTabs defensive strip removes root id (no localStorage cache to consult)", async () => {
		// openTabs seeds from pluginPath (in addition to localStorage). If
		// the initial pluginPath happens to be rootNodeId, the defensive
		// post-mount effect strips it once useTasks resolves rootNodeId.
		// Root never coexists in openTabs alongside its dedicated tab button.
		//
		// Mutation: drop the defensive effect → localStorage keeps rootId.
		localStorage.setItem(
			"mxd-open-tabs",
			JSON.stringify([rootNodeId, "some-sub-task"]),
		);
		const { unmount } = await mountPlugin(rootNodeId);

		await new Promise((r) => setTimeout(r, 400));

		const stored = localStorage.getItem("mxd-open-tabs");
		const tabs = stored ? (JSON.parse(stored) as string[]) : [];
		expect(tabs).not.toContain(rootNodeId);

		unmount();
	}, 20000);

	test("No localStorage `mxd-root:` keys are written or read", async () => {
		// Deliberate non-cache invariant: this key MUST NOT exist after any
		// flow. Task Y's routing is URL-derived, not cache-backed.
		const { unmount } = await mountPlugin("");
		await new Promise((r) => setTimeout(r, 400));

		const cacheKeys = Object.keys(localStorage).filter((k) =>
			k.startsWith("mxd-root:"),
		);
		expect(cacheKeys).toEqual([]);

		unmount();
	}, 20000);
});
