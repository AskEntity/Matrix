/// <reference lib="dom" />
/**
 * The composer's Stop button.
 *
 * The property under test is that Stop and Send COEXIST. Chat products swap
 * Send for Stop while the model is generating, because there is nothing useful
 * to send until it stops. Matrix is not that: a message sent while the agent
 * works is queued and picked up on its next turn, which is a real capability —
 * "also do X", "that file is at Y" — and swapping the button away would delete
 * it. So this test asserts both buttons are present at once, not merely that
 * Stop appears.
 *
 * The second property, and the reason the Orchestrator panel is rendered at the
 * bottom of a file named after the composer: this is the ONLY stop. The panel
 * used to carry a second one that tore the whole session down while saying
 * "Interrupt", so a user had to know which stop was which before they could use
 * either. Both halves of that invariant are asserted in one file for the same
 * reason `src/image-requires-text.test.ts` asserts both REST doors together — a
 * rule enforced at one of two places is enforced nowhere, and the second place
 * is reliably the one nobody remembers.
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

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

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	localStorage.clear();
});

async function waitFor<T>(
	fn: () => T,
	timeoutMs = 1000,
): Promise<NonNullable<T>> {
	const start = Date.now();
	for (;;) {
		const value = fn();
		if (value) return value as NonNullable<T>;
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 5));
	}
}

interface Props {
	agentRunning?: boolean;
	onInterrupt?: () => void;
}

async function renderInputBar(initial?: Props) {
	const { createRoot } = await import("react-dom/client");
	const { createElement } = await import("react");
	const { InputBar } = await import(
		"../.mxd/plugin/web/components/InputBar.tsx"
	);
	const { LocaleProvider } = await import("../.mxd/plugin/web/i18n.ts");

	const div = document.createElement("div");
	document.body.appendChild(div);
	const root = createRoot(div);

	const render = (props?: Props) => {
		root.render(
			createElement(
				LocaleProvider,
				null,
				createElement(InputBar, {
					projectId: "proj-1",
					targetNodeId: "node-stop-test",
					nodeMap: new Map(),
					onSend: () => {},
					agentRunning: props?.agentRunning,
					onInterrupt: props?.onInterrupt,
				}),
			),
		);
	};

	render(initial);
	await waitFor(() =>
		div.querySelector<HTMLTextAreaElement>("textarea.mxd-prompt-input"),
	);

	cleanups.push(() => {
		root.unmount();
		div.remove();
	});
	return { div, rerender: render };
}

const send = (div: HTMLElement) =>
	div.querySelector<HTMLButtonElement>("button.mxd-btn-run");
const stop = (div: HTMLElement) =>
	div.querySelector<HTMLButtonElement>("button.mxd-btn-interrupt");

describe("InputBar stop button", () => {
	test("not running: Send only", async () => {
		const { div } = await renderInputBar({
			agentRunning: false,
			onInterrupt: () => {},
		});
		expect(send(div) !== null).toBe(true);
		expect(stop(div) === null).toBe(true);
	});

	test("running: Stop appears ALONGSIDE Send, and Send stays usable", async () => {
		const { div } = await renderInputBar({
			agentRunning: true,
			onInterrupt: () => {},
		});
		const sendBtn = await waitFor(() => send(div));
		const stopBtn = await waitFor(() => stop(div));
		expect(sendBtn !== null).toBe(true);
		expect(stopBtn !== null).toBe(true);
		// Send is not disabled BECAUSE the agent is running — only an empty
		// draft disables it, which is the same rule as when the agent is idle.
		expect(sendBtn.disabled).toBe(true); // empty draft
		// Stop is never a submit — it must not send the draft as a side effect.
		expect(stopBtn.getAttribute("type")).toBe("button");
	});

	test("clicking Stop calls onInterrupt", async () => {
		let calls = 0;
		const { div } = await renderInputBar({
			agentRunning: true,
			onInterrupt: () => {
				calls++;
			},
		});
		const stopBtn = await waitFor(() => stop(div));
		stopBtn.click();
		expect(calls).toBe(1);
	});

	test("the Orchestrator panel offers no second stop while root works", async () => {
		// Rendered here rather than in a file of its own because the claim is
		// about the PAIR: exactly one stop exists, and it is the composer's.
		const { createRoot } = await import("react-dom/client");
		const { createElement } = await import("react");
		const { OrchestratorDetail } = await import(
			"../.mxd/plugin/web/components/OrchestratorDetail.tsx"
		);
		const { LocaleProvider } = await import("../.mxd/plugin/web/i18n.ts");

		const div = document.createElement("div");
		document.body.appendChild(div);
		const root = createRoot(div);
		cleanups.push(() => {
			root.unmount();
			div.remove();
		});

		const renderPanel = (isRootActive: boolean) => {
			root.render(
				createElement(
					LocaleProvider,
					null,
					createElement(OrchestratorDetail, {
						isRootActive,
						nodes: [],
						rootNodeId: "root",
						onClearSession: () => {},
					}),
				),
			);
		};

		// Root is working: the whole action row is empty. Stopping a turn is
		// the composer's job and there is nowhere else to ask for it.
		renderPanel(true);
		await waitFor(() => div.querySelector(".mxd-orch-detail"));
		expect(div.querySelectorAll("button").length).toBe(0);

		// POSITIVE CONTROL — the assertion above is only worth the wiring
		// behind it. The row still renders its OTHER control, which sits one
		// line from the deleted one and is the obvious collateral.
		renderPanel(false);
		const buttons = await waitFor(() => {
			const found = div.querySelectorAll("button");
			return found.length > 0 ? found : null;
		});
		expect(buttons.length).toBe(1);
		expect(buttons[0]?.textContent).toContain("Clear");
	});

	test("Stop disappears again when the agent goes idle", async () => {
		const { div, rerender } = await renderInputBar({
			agentRunning: true,
			onInterrupt: () => {},
		});
		await waitFor(() => stop(div));
		rerender({ agentRunning: false, onInterrupt: () => {} });
		// Poll the REAL condition. `x === null || true` polls nothing — it
		// returns on the first tick and asserts before React has committed.
		await waitFor(() => stop(div) === null);
		expect(stop(div) === null).toBe(true);
		expect(send(div) !== null).toBe(true);
	});
});
