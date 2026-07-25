/// <reference lib="dom" />
/**
 * Edit/Rewind buttons under the gate.
 *
 * The choice being pinned here is that a blocked message KEEPS its buttons,
 * greyed, with the reason on hover. Hiding them is what the first draft did,
 * and it leaves the user with a gap where an affordance used to be and no way
 * to find out why — worst exactly in the two cases that need explaining: an
 * agent that happens to be busy, and a message that was never a starting
 * point.
 *
 * The two reasons must not collapse into one sentence: "wait for the agent"
 * on a permanently un-editable message is a remedy that doesn't work.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { AgentActivity } from "../src/types.ts";

beforeAll(() => {
	GlobalRegistrator.register();
	(
		globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
	).IS_REACT_ACT_ENVIRONMENT = false;
});

afterAll(async () => {
	await new Promise((r) => setTimeout(r, 20));
	GlobalRegistrator.unregister();
});

async function renderUserMessage(opts: {
	startsRun?: boolean;
	activity?: AgentActivity;
	/** Simulate a live SSE entry, which carries no chain id. */
	noEid?: boolean;
}): Promise<{ div: HTMLDivElement; unmount: () => void }> {
	const { createRoot } = await import("react-dom/client");
	const { createElement } = await import("react");
	const { LogEntryView } = await import(
		"../.mxd/plugin/web/components/tools/LogEntryView.tsx"
	);
	const { LocaleProvider } = await import("../.mxd/plugin/web/i18n.ts");
	const { createLogEntry } = await import("../.mxd/plugin/web/hooks.ts");

	const entry = createLogEntry({
		type: "message",
		id: "m-1",
		body: { source: "user", id: "m-1", ts: 1000, content: "hello" },
		taskId: "task-a",
		ts: 1000,
		...(opts.noEid ? {} : { eid: "e-1" }),
	} as Parameters<typeof createLogEntry>[0]);
	if (opts.startsRun !== undefined) entry.startsRun = opts.startsRun;

	const div = document.createElement("div");
	document.body.appendChild(div);
	const root = createRoot(div);
	root.render(
		createElement(
			LocaleProvider,
			null,
			createElement(LogEntryView, {
				entry,
				nodeMap: new Map(),
				projectId: "proj-1",
				rootNodeId: "root-a",
				onEdit: () => {},
				onRollback: () => {},
				activity: opts.activity,
			}),
		),
	);
	await new Promise((r) => setTimeout(r, 10));
	return {
		div,
		unmount: () => {
			root.unmount();
			div.remove();
		},
	};
}

/** Every action button in the user-message row, in DOM order. */
function actionButtons(div: HTMLDivElement): HTMLButtonElement[] {
	return [...div.querySelectorAll<HTMLButtonElement>(".mxd-user-msg-action")];
}

/** Edit + Rewind, i.e. everything except the trailing Copy button. */
function gatedButtons(div: HTMLDivElement): HTMLButtonElement[] {
	return actionButtons(div).slice(0, 2);
}

describe("Edit/Rewind buttons under the gate", () => {
	test("a run start on a parked agent gets working buttons", async () => {
		const { div, unmount } = await renderUserMessage({
			startsRun: true,
			activity: "idle",
		});
		try {
			const gated = gatedButtons(div);
			expect(gated).toHaveLength(2);
			for (const b of gated) {
				expect(b.disabled).toBe(false);
				expect(b.className).not.toContain("--blocked");
			}
		} finally {
			unmount();
		}
	});

	test("a busy agent greys them and says to wait", async () => {
		const { div, unmount } = await renderUserMessage({
			startsRun: true,
			activity: "tool",
		});
		try {
			const gated = gatedButtons(div);
			// Still there — the affordance does not vanish.
			expect(gated).toHaveLength(2);
			for (const b of gated) {
				expect(b.disabled).toBe(true);
				expect(b.className).toContain("--blocked");
				expect(b.title).toMatch(/stop it/i);
			}
		} finally {
			unmount();
		}
	});

	test("a message that was not sent on its own says so instead, even while busy", async () => {
		// The permanent reason wins: telling this user to wait would send
		// them off to watch a button that is never going to light up.
		const { div, unmount } = await renderUserMessage({
			startsRun: false,
			activity: "tool",
		});
		try {
			for (const b of gatedButtons(div)) {
				expect(b.disabled).toBe(true);
				expect(b.title).toMatch(/on its own/i);
				expect(b.title).not.toMatch(/stop it/i);
			}
		} finally {
			unmount();
		}
	});

	test("the two reasons are different sentences", async () => {
		const busy = await renderUserMessage({
			startsRun: true,
			activity: "thinking",
		});
		const midRun = await renderUserMessage({
			startsRun: false,
			activity: "idle",
		});
		try {
			const a = gatedButtons(busy.div)[0]?.title;
			const b = gatedButtons(midRun.div)[0]?.title;
			expect(a).toBeTruthy();
			expect(b).toBeTruthy();
			expect(a).not.toBe(b);
		} finally {
			busy.unmount();
			midRun.unmount();
		}
	});

	test("Copy stays available on a blocked message", async () => {
		const { div, unmount } = await renderUserMessage({
			startsRun: false,
			activity: "tool",
		});
		try {
			const all = actionButtons(div);
			const copy = all[all.length - 1];
			expect(copy?.disabled).toBe(false);
			expect(copy?.className).not.toContain("--blocked");
		} finally {
			unmount();
		}
	});

	test("an entry with no eid shows no gated buttons at all", async () => {
		// Live SSE entries carry no eid — nothing to edit yet, and nothing
		// to explain either.
		const { div, unmount } = await renderUserMessage({ noEid: true });
		try {
			expect(actionButtons(div)).toHaveLength(1); // Copy only
		} finally {
			unmount();
		}
	});
});
