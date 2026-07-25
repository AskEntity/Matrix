/// <reference lib="dom" />
/**
 * CANONICAL USER JOURNEY for the blocked half of Edit/Rewind, full stack:
 * real daemon → real JSONL → real Plugin.tsx → a user message that was typed
 * while the agent was running a tool renders with its ✎ / ↺ GREYED and the
 * reason on hover.
 *
 * Its sibling `Plugin-rewind-journey.test.tsx` covers the allowed path (that
 * fixture's message sits before the tool call, so it is a run start and its
 * buttons work). Between them the two directions of the gate are pinned end
 * to end.
 *
 * The chain this exercises, and why no smaller test can:
 *
 *   1. the daemon chain-walks the JSONL and returns it in DELIVERY order
 *   2. processEventBatch annotates run starts from that raw batch — and the
 *      message here is delivered INSIDE the bash call's window
 *   3. the activity log then renders that same message AFTER the finished
 *      bash card, because a message materializes where it was consumed
 *   4. LogEntryView greys the buttons from the annotation, not the position
 *
 * Step 3 is the trap the whole design exists for. If anyone ever "simplifies"
 * step 2 to read the rendered entries instead of the raw events, every
 * component test stays green and this one fails.
 *
 * No stubs: nothing is clicked, so nothing reaches /edit.
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

/** Typed while bash was still running. */
const INTERRUPTING_TEXT = "wait, stop";
/** Typed after the agent parked on yield. */
const PARKED_TEXT = "please refactor the parser";

describe("Plugin — a message typed mid-tool-call cannot be edited", () => {
	let daemon: DaemonInstance;
	let tempDir: string;
	let savedFetch: typeof fetch;
	const projectId = "peg1";
	const rootNodeId = "root-edit-gate-journey";

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

		tempDir = await mkdtemp(join(tmpdir(), "plugin-edit-gate-"));
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
						// pending, and clearSessionState drops the log of anything
						// that transitions to pending.
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

		// yield → parked message (editable) → bash starts → interrupting
		// message (NOT editable) → bash finishes → both consumed together.
		const lines = [
			{
				type: "tool_call",
				tool: "mcp__mxd__yield",
				toolCallId: "y-1",
				input: {},
				taskId: rootNodeId,
				ts: 900,
				eid: "bbbb00000001",
				parentEid: null,
			},
			{
				type: "message",
				id: "um-parked",
				taskId: rootNodeId,
				body: {
					source: "user",
					id: "um-parked",
					ts: 1000,
					content: PARKED_TEXT,
				},
				ts: 1000,
				eid: "bbbb00000002",
				parentEid: "bbbb00000001",
			},
			// The park's result is written AT WAKE, by the message that woke
			// it — so it rides in that message's own turn and must not count
			// as work the agent was already doing.
			{
				type: "tool_result",
				tool: "mcp__mxd__yield",
				toolCallId: "y-1",
				content: "resumed.",
				isError: false,
				taskId: rootNodeId,
				ts: 1001,
				eid: "bbbb0000000a",
				parentEid: "bbbb00000002",
			},
			{
				type: "messages_consumed",
				messageIds: ["um-parked"],
				taskId: rootNodeId,
				ts: 1001,
				eid: "bbbb00000003",
				parentEid: "bbbb0000000a",
			},
			{
				type: "tool_call",
				tool: "mcp__mxd__bash",
				toolCallId: "tc-1",
				input: { command: "bun test" },
				taskId: rootNodeId,
				ts: 1002,
				eid: "bbbb00000004",
				parentEid: "bbbb00000003",
			},
			// Delivered INSIDE the bash window — this is the whole point.
			{
				type: "message",
				id: "um-mid",
				taskId: rootNodeId,
				body: {
					source: "user",
					id: "um-mid",
					ts: 1003,
					content: INTERRUPTING_TEXT,
				},
				ts: 1003,
				eid: "bbbb00000005",
				parentEid: "bbbb00000004",
			},
			{
				type: "tool_result",
				tool: "mcp__mxd__bash",
				toolCallId: "tc-1",
				content: "2745 pass",
				isError: false,
				taskId: rootNodeId,
				ts: 1004,
				eid: "bbbb00000006",
				parentEid: "bbbb00000005",
			},
			{
				type: "messages_consumed",
				messageIds: ["um-mid"],
				taskId: rootNodeId,
				ts: 1005,
				eid: "bbbb00000007",
				parentEid: "bbbb00000006",
			},
		];
		await writeFile(
			join(matrixDir, "tasks", `${rootNodeId}.jsonl`),
			`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
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

	async function mountPlugin() {
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
		return { div, unmount: () => root.unmount() };
	}

	const waitFor = async <T,>(
		fn: () => T,
		label = "condition",
		timeoutMs = 10000,
	): Promise<NonNullable<T>> => {
		const start = Date.now();
		for (;;) {
			const value = fn();
			if (value) return value as NonNullable<T>;
			if (Date.now() - start > timeoutMs) {
				throw new Error(`waitFor timeout: ${label}`);
			}
			await new Promise((r) => setTimeout(r, 50));
		}
	};

	/** The message bubble row whose text contains `text`. */
	function messageRow(div: HTMLElement, text: string): HTMLElement | null {
		for (const row of div.querySelectorAll<HTMLElement>(
			".mxd-event-user_message",
		)) {
			if (row.textContent?.includes(text)) return row;
		}
		return null;
	}

	test("greys ✎/↺ on the interrupting message, keeps them on the parked one", async () => {
		const { div, unmount } = await mountPlugin();
		try {
			await waitFor(
				() =>
					messageRow(div, INTERRUPTING_TEXT) && messageRow(div, PARKED_TEXT),
				"both seeded user messages render",
			);

			const log = div.querySelector<HTMLElement>(".mxd-activity-log");
			if (!log) throw new Error("no activity log");

			// The trap, made visible: the interrupting message renders AFTER
			// the finished bash card even though it was delivered inside it.
			const order = [...log.querySelectorAll<HTMLElement>("*")];
			const bashIdx = order.findIndex((el) =>
				el.className?.toString().includes("mxd-tool-card"),
			);
			const midIdx = order.findIndex(
				(el) =>
					el.className?.toString().includes("mxd-event-user_message") &&
					el.textContent?.includes(INTERRUPTING_TEXT),
			);
			expect(bashIdx).toBeGreaterThanOrEqual(0);
			expect(midIdx).toBeGreaterThan(bashIdx);

			// Blocked: buttons present, disabled, explaining themselves.
			const midRow = messageRow(div, INTERRUPTING_TEXT);
			if (!midRow) throw new Error("interrupting message row vanished");
			const midActions = [
				...midRow.querySelectorAll<HTMLButtonElement>(".mxd-user-msg-action"),
			].slice(0, 2);
			expect(midActions).toHaveLength(2);
			for (const b of midActions) {
				expect(b.disabled).toBe(true);
				expect(b.title).toMatch(/on its own/i);
			}

			// Allowed: the message that woke the agent keeps working buttons.
			const parkedRow = messageRow(div, PARKED_TEXT);
			if (!parkedRow) throw new Error("parked message row vanished");
			const parkedActions = [
				...parkedRow.querySelectorAll<HTMLButtonElement>(
					".mxd-user-msg-action",
				),
			].slice(0, 2);
			expect(parkedActions).toHaveLength(2);
			for (const b of parkedActions) {
				expect(b.disabled).toBe(false);
			}
		} finally {
			unmount();
		}
	}, 20000);
});
