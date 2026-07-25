/// <reference lib="dom" />
/**
 * CANONICAL USER JOURNEY for Rewind / Edit confirmation, full stack:
 * real daemon → real Plugin.tsx wiring → user clicks ↺ on a message →
 * an IN-APP dialog (never window.confirm) explains what the rollback does
 * NOT undo → Cancel does nothing → Confirm calls /edit, re-fetches the log,
 * and lands the view at the BOTTOM with follow mode resumed.
 *
 * Plus the Edit half of the same seam: ✎ → dialog with the edit wording →
 * confirm → the message is loaded into the composer AND marked in the log.
 *
 * The component tests (web/ConfirmDialog.test.tsx,
 * web/ActivityLog-rollback-scroll.test.tsx) cover the dialog and the scroll
 * mechanism in isolation; this test covers the seams between them — the
 * handlers in Plugin.tsx, the props flowing to ActivityLog/AppFooter, and
 * the post-rollback scroll request. If any link is dropped (dialog not
 * rendered, editingEid not passed, scroll request not issued) this test
 * fails while the component tests stay green.
 *
 * ONE stub: the POST to /edit returns `{ok:true}` without reaching the
 * daemon. The real endpoint stops the agent and delivers a message, which
 * would launch a real agent against the fixture project — backend rollback
 * semantics are covered by src/rollback.test.ts. Everything else (tree,
 * events, SPA shell) goes through the real daemon.
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

const USER_TEXT = "please refactor the parser";
const TARGET_EID = "aaaa00000002";

describe("Plugin — Rewind/Edit confirm dialog full journey", () => {
	let daemon: DaemonInstance;
	let tempDir: string;
	let savedFetch: typeof fetch;
	const projectId = "prw1";
	const rootNodeId = "root-rewind-journey";
	const editPosts: Array<{ url: string; body: string }> = [];

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

		tempDir = await mkdtemp(join(tmpdir(), "plugin-rewind-"));
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

		// A user message (id + eid → Edit/Rewind buttons after the
		// messages_consumed materializes it) followed by a bash tool call —
		// the side effect the dialog must warn about.
		const lines = [
			{
				type: "agent_start",
				taskId: rootNodeId,
				ts: 900,
				eid: "aaaa00000001",
				parentEid: null,
			},
			{
				type: "message",
				id: "um-1",
				taskId: rootNodeId,
				body: { source: "user", id: "um-1", ts: 1000, content: USER_TEXT },
				ts: 1000,
				eid: TARGET_EID,
				parentEid: "aaaa00000001",
			},
			{
				type: "messages_consumed",
				messageIds: ["um-1"],
				taskId: rootNodeId,
				ts: 1001,
				eid: "aaaa00000003",
				parentEid: TARGET_EID,
			},
			{
				type: "tool_call",
				tool: "mcp__mxd__bash",
				toolCallId: "tc-1",
				input: { command: "echo hi" },
				taskId: rootNodeId,
				ts: 1002,
				eid: "aaaa00000004",
				parentEid: "aaaa00000003",
			},
			{
				type: "assistant_text",
				content: "done rewriting the parser",
				taskId: rootNodeId,
				ts: 1003,
				eid: "aaaa00000005",
				parentEid: "aaaa00000004",
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
			// See the header: the /edit POST is the one stubbed call.
			if (init?.method === "POST" && url.includes("/edit")) {
				editPosts.push({ url, body: String(init.body ?? "") });
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			}
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

	test("Rewind: in-app dialog with impact → cancel is a no-op → confirm rolls back and returns to the bottom", async () => {
		const { div, unmount } = await mountPlugin();
		editPosts.length = 0;

		// window.confirm must never be reached — that's the bug being fixed.
		let nativeConfirmCalls = 0;
		const savedConfirm = window.confirm;
		window.confirm = () => {
			nativeConfirmCalls++;
			return true;
		};

		const logContainer = await waitFor(() => {
			const el = div.querySelector<HTMLElement>(".mxd-activity-log");
			return el?.textContent?.includes(USER_TEXT) ? el : null;
		}, "log renders the seeded user message");

		const rewindBtn = await waitFor(
			() =>
				div.querySelector<HTMLButtonElement>(
					'.mxd-user-msg-action[title="Rewind to here"]',
				),
			"rewind button",
		);

		// 1. Click ↺ → in-app dialog, not the browser's.
		rewindBtn.click();
		const card = await waitFor(
			() => div.querySelector<HTMLElement>(".mxd-confirm-card"),
			"confirm dialog opens",
		);
		expect(nativeConfirmCalls).toBe(0);
		expect(div.querySelector(".mxd-confirm-title")?.textContent).toBe(
			"Rewind to this message?",
		);

		// 2. The impact of the rolled-back range is spelled out: a bash call
		//    happened after this message, so file changes must be flagged.
		const warnings = card.querySelector(".mxd-confirm-warnings");
		expect(warnings?.textContent).toContain("File changes");
		expect(card.querySelector(".mxd-confirm-tools")?.textContent).toContain(
			"bash",
		);

		// 3. Cancel closes it and touches nothing.
		const cancelBtn = card.querySelectorAll<HTMLButtonElement>(
			".mxd-confirm-actions button",
		)[0];
		cancelBtn?.click();
		await waitFor(
			() => div.querySelector(".mxd-confirm-card") === null,
			"dialog closes on cancel",
		);
		expect(editPosts.length).toBe(0);

		// 4. User scrolls up (the state they're in after hunting for the
		//    message to rewind): follow mode off, viewport far from bottom.
		Object.defineProperty(logContainer, "scrollHeight", {
			value: 1000,
			configurable: true,
		});
		Object.defineProperty(logContainer, "clientHeight", {
			value: 300,
			configurable: true,
		});
		logContainer.scrollTop = 60;
		logContainer.dispatchEvent(new Event("scroll"));
		await waitFor(
			() => div.querySelector(".mxd-scroll-follow-btn"),
			"follow pill appears after scrolling up",
		);

		// 5. Rewind for real.
		rewindBtn.click();
		const card2 = await waitFor(
			() => div.querySelector<HTMLElement>(".mxd-confirm-card"),
			"confirm dialog reopens",
		);
		card2
			.querySelectorAll<HTMLButtonElement>(".mxd-confirm-actions button")[1]
			?.click();

		// 6. The edit API was called with the target eid + original content.
		await waitFor(() => editPosts.length > 0, "POST /edit issued");
		expect(nativeConfirmCalls).toBe(0);
		const posted = JSON.parse(editPosts[0]?.body ?? "{}");
		expect(posted.eid).toBe(TARGET_EID);
		expect(posted.content).toBe(USER_TEXT);

		// 7. THE FIX: after the log is rebuilt the view is at the bottom and
		//    follow mode is back on (no "Follow" pill).
		await waitFor(
			() => logContainer.scrollTop === 1000,
			"log jumps to the bottom after the rewind",
		);
		expect(logContainer.scrollTop).toBe(1000);
		await waitFor(
			() => div.querySelector(".mxd-scroll-follow-btn") === null,
			"follow pill gone",
		);

		// 8. MUTATION PROOF for the explicit scroll request. Follow mode is
		//    already on and the rebuilt log has the same entry count, so no
		//    prop change can re-trigger ActivityLog's follow effect — only the
		//    bumped request reaches the DOM. Move the container off the bottom
		//    WITHOUT a scroll event (exactly what a wholesale entries
		//    replacement does to the offset) and rewind again.
		logContainer.scrollTop = 55;
		editPosts.length = 0;
		// The rebuild remounts the entries (fresh log-entry ids → new React
		// keys → new DOM nodes), so the button has to be re-queried.
		const rewindBtn2 = await waitFor(
			() =>
				div.querySelector<HTMLButtonElement>(
					'.mxd-user-msg-action[title="Rewind to here"]',
				),
			"rewind button after the rebuild",
		);
		rewindBtn2.click();
		const card3 = await waitFor(
			() => div.querySelector<HTMLElement>(".mxd-confirm-card"),
			"dialog opens for the follow-mode rewind",
		);
		card3
			.querySelectorAll<HTMLButtonElement>(".mxd-confirm-actions button")[1]
			?.click();
		await waitFor(() => editPosts.length > 0, "second POST /edit issued");
		await waitFor(
			() => logContainer.scrollTop === 1000,
			"explicit scroll request applies while already in follow mode",
		);
		expect(logContainer.scrollTop).toBe(1000);

		window.confirm = savedConfirm;
		unmount();
		div.remove();
	}, 30000);

	test("Edit: dialog uses the edit wording → confirm loads the composer and marks the message", async () => {
		const { div, unmount } = await mountPlugin();
		editPosts.length = 0;

		await waitFor(() => {
			const el = div.querySelector<HTMLElement>(".mxd-activity-log");
			return el?.textContent?.includes(USER_TEXT) ? el : null;
		}, "log renders the seeded user message");
		const editBtn = await waitFor(
			() =>
				div.querySelector<HTMLButtonElement>(
					'.mxd-user-msg-action[title="Edit"]',
				),
			"edit button",
		);

		// Nothing is marked before the edit starts.
		expect(div.querySelector(".mxd-user-msg--editing")).toBeNull();

		editBtn.click();
		const card = await waitFor(
			() => div.querySelector<HTMLElement>(".mxd-confirm-card"),
			"edit confirm dialog opens",
		);
		expect(div.querySelector(".mxd-confirm-title")?.textContent).toBe(
			"Edit this message?",
		);
		// Same honest impact report as Rewind — it's the same rollback.
		expect(card.querySelector(".mxd-confirm-warnings")?.textContent).toContain(
			"File changes",
		);

		card
			.querySelectorAll<HTMLButtonElement>(".mxd-confirm-actions button")[1]
			?.click();

		// Composer is loaded with the original content…
		const textarea = await waitFor(() => {
			const el = div.querySelector<HTMLTextAreaElement>("textarea");
			return el?.value === USER_TEXT ? el : null;
		}, "composer prefilled with the original content");
		expect(textarea.value).toBe(USER_TEXT);
		// …the editing indicator is up (with an icon, not an emoji)…
		const indicator = await waitFor(
			() => div.querySelector<HTMLElement>(".mxd-edit-indicator"),
			"editing indicator",
		);
		expect(indicator.textContent).not.toContain("✏️");
		expect(indicator.querySelector("svg")).not.toBeNull();
		// …and the message being edited is marked in the log.
		const marked = await waitFor(
			() => div.querySelector<HTMLElement>(".mxd-user-msg--editing"),
			"edited message marked in the log",
		);
		expect(marked.getAttribute("data-eid")).toBe(TARGET_EID);
		expect(marked.textContent).toContain(USER_TEXT);

		// The indicator is a shortcut back to that message.
		const scrolled: Element[] = [];
		const savedScrollIntoView = Element.prototype.scrollIntoView;
		Element.prototype.scrollIntoView = function scrollIntoViewSpy(
			this: Element,
		) {
			scrolled.push(this);
		};
		indicator
			.querySelector<HTMLButtonElement>(".mxd-edit-indicator-label")
			?.click();
		Element.prototype.scrollIntoView = savedScrollIntoView;
		expect(scrolled.length).toBe(1);
		expect(scrolled[0]?.getAttribute("data-eid")).toBe(TARGET_EID);

		// No POST yet — Edit only rolls back when the composer is submitted.
		expect(editPosts.length).toBe(0);

		// Cancelling the edit clears the mark.
		div.querySelector<HTMLButtonElement>(".mxd-edit-cancel")?.click();
		await waitFor(
			() => div.querySelector(".mxd-user-msg--editing") === null,
			"mark cleared after cancelling the edit",
		);

		unmount();
		div.remove();
	}, 30000);
});
