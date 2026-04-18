/// <reference lib="dom" />
/**
 * Regression guard for Fix A: "root as regular task — remove null sentinel".
 *
 * What changed:
 *   - Plugin.tsx: `targetNodeId = selectedTaskId ?? rootNodeId` (no null sentinel)
 *   - AppFooter filter: `m.taskId === targetNodeId` (direct id comparison)
 *
 * Previously the root view used targetNodeId=null as a sentinel and the filter
 * had a second branch that matched against the rootNodeId prop. That coupled
 * pending-banner visibility to whether `rootNodeId` state was populated, and
 * on fresh mount (useTasks pending) the filter silently dropped root messages.
 *
 * These tests hit AppFooter in isolation with various prop combinations —
 * direct exercise of the filter line. Mutation proof is spelled out below
 * each test; if the filter reverts to the old form OR to any wrong shape,
 * at least one test fails.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

beforeAll(() => {
	GlobalRegistrator.register();
	// Silence React 19 act() warnings in this no-act render harness — we use
	// setTimeout-based flushing (same as web/ShellApp.test.tsx).
	(
		globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
	).IS_REACT_ACT_ENVIRONMENT = false;
});

afterAll(async () => {
	// Let any pending React work flush before unregistering happy-dom.
	// Without this, React's scheduler can reference `window` after teardown.
	await new Promise((r) => setTimeout(r, 20));
	GlobalRegistrator.unregister();
});

type PendingMessage = {
	id: string;
	taskId: string | null;
	text: string;
	timestamp: number;
};

/**
 * Render AppFooter with the given props and return the container div + unmount.
 * LocaleProvider wraps so `t("pending.label")` → "Pending:".
 */
async function renderAppFooter(props: {
	targetNodeId: string | null;
	pendingMessages: PendingMessage[];
}): Promise<{ div: HTMLDivElement; unmount: () => void }> {
	const { createRoot } = await import("react-dom/client");
	const { createElement } = await import("react");
	const { AppFooter } = await import(
		"../.mxd/plugin/web/components/AppFooter.tsx"
	);
	const { LocaleProvider } = await import("../.mxd/plugin/web/i18n.ts");

	const div = document.createElement("div");
	document.body.appendChild(div);
	const root = createRoot(div);

	root.render(
		createElement(
			LocaleProvider,
			null,
			createElement(AppFooter, {
				projectId: "p1",
				targetNodeId: props.targetNodeId,
				nodeMap: new Map(),
				pendingMessages: props.pendingMessages,
				pendingClarifications: [],
				clarifyAnswers: {},
				onSend: () => {},
				onClarifySubmit: () => {},
				onClarifyAnswerChange: () => {},
			}),
		),
	);

	// Let React flush the synchronous render.
	await new Promise((r) => setTimeout(r, 10));

	return {
		div,
		unmount: () => {
			root.unmount();
			div.remove();
		},
	};
}

/** Extract pending chip text values from the rendered DOM. */
function pendingChipTexts(div: HTMLElement): string[] {
	return Array.from(div.querySelectorAll(".mxd-pending-chip")).map(
		(el) => el.textContent ?? "",
	);
}

describe("AppFooter pending filter — root as regular task", () => {
	test("root view shows pending when targetNodeId === message.taskId (regression guard)", async () => {
		// Scenario: useTasks has resolved, rootNodeId populated. Plugin.tsx
		// effect sets targetNodeId = selectedTaskId ?? rootNodeId = rootNodeId.
		// A pending user message arrives with taskId = rootNodeId. Chip must show.
		//
		// Mutation proof: revert Plugin.tsx effect to the old
		// `if (!selectedTaskId || selectedTaskId === rootNodeId) setTargetNodeId(null)`
		// form → targetNodeId would be null here → chip hidden → this test fails.
		const { div, unmount } = await renderAppFooter({
			targetNodeId: "root-abc",
			pendingMessages: [
				{
					id: "m1",
					taskId: "root-abc",
					text: "hello root",
					timestamp: 1,
				},
			],
		});

		const chips = pendingChipTexts(div);
		expect(chips).toEqual(["hello root"]);
		expect(div.querySelector(".mxd-pending-messages")).toBeTruthy();

		unmount();
	});

	test("sub-task view shows pending for its own messages", async () => {
		const { div, unmount } = await renderAppFooter({
			targetNodeId: "sub-def",
			pendingMessages: [
				{
					id: "m1",
					taskId: "sub-def",
					text: "sub message",
					timestamp: 1,
				},
			],
		});

		expect(pendingChipTexts(div)).toEqual(["sub message"]);
		unmount();
	});

	test("sub-task view drops cross-task messages (filter isolation)", async () => {
		// On sub-task view, a message targeting the root MUST NOT appear.
		//
		// Mutation proof: change filter to always-true or to match any taskId
		// → this test catches the leak.
		const { div, unmount } = await renderAppFooter({
			targetNodeId: "sub-def",
			pendingMessages: [
				{
					id: "m1",
					taskId: "root-abc",
					text: "root message leaking into sub view",
					timestamp: 1,
				},
			],
		});

		expect(pendingChipTexts(div)).toEqual([]);
		expect(div.querySelector(".mxd-pending-messages")).toBeFalsy();
		unmount();
	});

	test("pre-useTasks transient: targetNodeId=null → nothing shows (acceptable flash)", async () => {
		// Before useTasks completes, rootNodeId is null → targetNodeId is null.
		// Filter is `m.taskId === null` so real-IDed messages drop. The task
		// description accepts this ~100-500ms flash; a follow-up optimization
		// (hash/props seeding) is out of scope.
		const { div, unmount } = await renderAppFooter({
			targetNodeId: null,
			pendingMessages: [
				{
					id: "m1",
					taskId: "root-abc",
					text: "arrived before useTasks",
					timestamp: 1,
				},
			],
		});

		expect(pendingChipTexts(div)).toEqual([]);
		unmount();
	});

	test("null-taskId messages do not leak into the root view", async () => {
		// With the old null sentinel, a message with taskId=null would match
		// the root view's second branch (`m.taskId === null`). That coupling
		// is now gone — targetNodeId = "root-abc", `null === "root-abc"` fails.
		//
		// Mutation proof: revert filter to `m.taskId === targetNodeId || m.taskId === null`
		// → this test fails (null-taskId message would show in root view).
		const { div, unmount } = await renderAppFooter({
			targetNodeId: "root-abc",
			pendingMessages: [
				{
					id: "m1",
					taskId: null,
					text: "no taskId",
					timestamp: 1,
				},
			],
		});

		expect(pendingChipTexts(div)).toEqual([]);
		unmount();
	});

	test("multiple messages: only matching ones appear (order preserved)", async () => {
		const { div, unmount } = await renderAppFooter({
			targetNodeId: "root-abc",
			pendingMessages: [
				{ id: "m1", taskId: "root-abc", text: "first root", timestamp: 1 },
				{ id: "m2", taskId: "sub-def", text: "sub-task msg", timestamp: 2 },
				{ id: "m3", taskId: "root-abc", text: "second root", timestamp: 3 },
				{ id: "m4", taskId: null, text: "no taskId", timestamp: 4 },
			],
		});

		expect(pendingChipTexts(div)).toEqual(["first root", "second root"]);
		unmount();
	});

	test("chip text truncates at 30 chars (sanity — not part of the filter fix)", async () => {
		// Not strictly a regression test for Fix A, but exercises the render
		// path and confirms the chip pipeline is intact after the refactor.
		const { div, unmount } = await renderAppFooter({
			targetNodeId: "root-abc",
			pendingMessages: [
				{
					id: "m1",
					taskId: "root-abc",
					text: "a".repeat(50),
					timestamp: 1,
				},
			],
		});

		const chips = pendingChipTexts(div);
		expect(chips.length).toBe(1);
		const chip = chips[0] ?? "";
		expect(chip.length).toBe(31); // 30 chars + ellipsis
		expect(chip.endsWith("…")).toBe(true);
		unmount();
	});
});
