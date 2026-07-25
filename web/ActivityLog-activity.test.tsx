/// <reference lib="dom" />
/**
 * The "Thinking..." indicator is now a direct read of the backend's state,
 * not a guess.
 *
 * What it used to be (ActivityLog.tsx, deleted):
 *
 *   setShowThinking(isActive && !hasToolInProgress && elapsed > 1500)
 *
 * — three guesses on a 500ms interval: `isActive` came from a boolean with
 * three competing sources, `hasToolInProgress` inferred "a tool is running"
 * from whether the LAST LOG ENTRY happened to be a tool_call, and the 1.5s
 * silence timer stood in for "the model is generating" because the frontend
 * had no way to tell thinking from tool.
 *
 * Now the component is handed `activity` and reads it. These tests pin each
 * state's rendering, especially `tool` → no indicator, which used to depend
 * on the shape of the log rather than on what the agent was doing.
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

type Cleanup = () => void;
const cleanups: Cleanup[] = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
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

/**
 * Render ActivityLog whose last entry is a tool_call — the log shape the old
 * heuristic keyed on. Every test uses it so that `tool` vs `thinking` can only
 * be distinguished by the `activity` prop, never by the entries.
 */
async function renderLog(activity?: "idle" | "thinking" | "tool") {
	const { createRoot } = await import("react-dom/client");
	const { createElement } = await import("react");
	const { ActivityLog } = await import(
		"../.mxd/plugin/web/components/ActivityLog.tsx"
	);
	const { LocaleProvider } = await import("../.mxd/plugin/web/i18n.ts");
	const { createLogEntry } = await import("../.mxd/plugin/web/hooks.ts");

	const entries = [
		createLogEntry({
			type: "assistant_text",
			content: "some earlier reply",
			taskId: "root-1",
			ts: 1000,
		} as Parameters<typeof createLogEntry>[0]),
		createLogEntry({
			type: "tool_call",
			tool: "mcp__mxd__bash",
			toolCallId: "tc-1",
			input: { command: "sleep 5" },
			taskId: "root-1",
			ts: 2000,
		} as Parameters<typeof createLogEntry>[0]),
	];

	const div = document.createElement("div");
	document.body.appendChild(div);
	const root = createRoot(div);

	const render = (next?: "idle" | "thinking" | "tool") =>
		root.render(
			createElement(
				LocaleProvider,
				null,
				createElement(ActivityLog, {
					entries,
					filterTaskId: null,
					rootNodeId: "root-1",
					nodeMap: new Map(),
					autoScroll: true,
					onAutoScrollChange: () => {},
					activity: next,
					projectId: "proj-1",
				}),
			),
		);

	render(activity);
	await waitFor(() => div.textContent?.includes("some earlier reply"));
	await new Promise((r) => setTimeout(r, 30));

	cleanups.push(() => {
		root.unmount();
		div.remove();
	});

	const indicator = () =>
		div.querySelector<HTMLElement>(".mxd-thinking-indicator");
	return { div, indicator, render };
}

describe("ActivityLog thinking indicator reads the agent's state", () => {
	test("`thinking` shows it IMMEDIATELY — no 1.5s silence timer", async () => {
		const { indicator } = await renderLog("thinking");
		// The old code needed 1.5s of no events before it dared say
		// "Thinking"; the state is authoritative, so there is nothing to wait
		// for. (This assertion runs ~30ms after mount.)
		expect(indicator()).not.toBeNull();
		expect(indicator()?.style.visibility).toBe("visible");
	});

	test("`tool` does NOT show it — even though the last entry is a tool_call", async () => {
		// The tool card is already showing progress. The old code reached this
		// same conclusion by inspecting the last log entry's type; now it is a
		// consequence of the agent telling us what it is doing.
		// The node stays mounted-but-hidden while the agent is working — it
		// reserves its own height so the log doesn't jump when the indicator
		// appears. `visibility` is therefore the assertion; its textContent is
		// "Thinking..." either way.
		const { indicator } = await renderLog("tool");
		expect(indicator()?.style.visibility).toBe("hidden");
	});

	test("`idle` renders no indicator at all", async () => {
		const { indicator } = await renderLog("idle");
		expect(indicator()).toBeNull();
	});

	test("no agent (undefined) renders no indicator at all", async () => {
		const { indicator } = await renderLog(undefined);
		expect(indicator()).toBeNull();
	});

	test("switching thinking → tool → thinking follows the state, with the same entries", async () => {
		// One render tree, three states, identical log content: the indicator
		// can only be tracking `activity`.
		const { indicator, render } = await renderLog("thinking");
		expect(indicator()?.style.visibility).toBe("visible");

		render("tool");
		await waitFor(() => indicator()?.style.visibility === "hidden");

		render("thinking");
		await waitFor(() => indicator()?.style.visibility === "visible");
	});
});
