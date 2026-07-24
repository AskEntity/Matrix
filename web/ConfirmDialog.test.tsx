/// <reference lib="dom" />
/**
 * ConfirmDialog (the in-app replacement for window.confirm) and the
 * RollbackConfirmDialog that composes it with the rollback impact report.
 *
 * Covers the dismissal contract (Escape / backdrop / Cancel / confirm) and
 * that the warnings shown match the analyzed impact — a rollback dialog that
 * silently omits "files won't be reverted" is the bug this feature exists to
 * prevent.
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
import type { RollbackImpact } from "../.mxd/plugin/web/rollback-impact.ts";

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

const CLEAN_IMPACT: RollbackImpact = {
	filesModified: false,
	tasksModified: false,
	messagesSent: false,
	otherSideEffects: false,
	toolNames: [],
};

async function renderConfirm(props: {
	title: string;
	message?: string;
	danger?: boolean;
}) {
	const { createRoot } = await import("react-dom/client");
	const { createElement } = await import("react");
	const { ConfirmDialog } = await import(
		"../.mxd/plugin/web/components/ConfirmDialog.tsx"
	);
	const { LocaleProvider } = await import("../.mxd/plugin/web/i18n.ts");

	const confirms: number[] = [];
	const cancels: number[] = [];
	const div = document.createElement("div");
	document.body.appendChild(div);
	const root = createRoot(div);
	root.render(
		createElement(
			LocaleProvider,
			null,
			createElement(ConfirmDialog, {
				...props,
				confirmLabel: "Do it",
				onConfirm: () => confirms.push(1),
				onCancel: () => cancels.push(1),
			}),
		),
	);
	await waitFor(() => div.querySelector(".mxd-confirm-card"));
	cleanups.push(() => {
		root.unmount();
		div.remove();
	});
	return { div, confirms, cancels };
}

async function renderRollback(props: {
	kind: "rewind" | "edit";
	impact: RollbackImpact;
}) {
	const { createRoot } = await import("react-dom/client");
	const { createElement } = await import("react");
	const { RollbackConfirmDialog } = await import(
		"../.mxd/plugin/web/components/RollbackConfirmDialog.tsx"
	);
	const { LocaleProvider } = await import("../.mxd/plugin/web/i18n.ts");

	const confirms: number[] = [];
	const div = document.createElement("div");
	document.body.appendChild(div);
	const root = createRoot(div);
	root.render(
		createElement(
			LocaleProvider,
			null,
			createElement(RollbackConfirmDialog, {
				...props,
				onConfirm: () => confirms.push(1),
				onCancel: () => {},
			}),
		),
	);
	await waitFor(() => div.querySelector(".mxd-confirm-card"));
	cleanups.push(() => {
		root.unmount();
		div.remove();
	});
	return { div, confirms };
}

describe("ConfirmDialog", () => {
	test("renders title, message and both buttons", async () => {
		const { div } = await renderConfirm({
			title: "Rewind to this message?",
			message: "The conversation rewinds.",
		});
		expect(div.querySelector(".mxd-confirm-title")?.textContent).toBe(
			"Rewind to this message?",
		);
		expect(div.querySelector(".mxd-confirm-message")?.textContent).toBe(
			"The conversation rewinds.",
		);
		const buttons = Array.from(
			div.querySelectorAll<HTMLButtonElement>(".mxd-confirm-actions button"),
		);
		expect(buttons.map((b) => b.textContent)).toEqual(["Cancel", "Do it"]);
	});

	test("confirm button fires onConfirm only", async () => {
		const { div, confirms, cancels } = await renderConfirm({ title: "T" });
		div
			.querySelectorAll<HTMLButtonElement>(".mxd-confirm-actions button")[1]
			?.click();
		expect(confirms.length).toBe(1);
		expect(cancels.length).toBe(0);
	});

	test("cancel button fires onCancel only", async () => {
		const { div, confirms, cancels } = await renderConfirm({ title: "T" });
		div
			.querySelectorAll<HTMLButtonElement>(".mxd-confirm-actions button")[0]
			?.click();
		expect(cancels.length).toBe(1);
		expect(confirms.length).toBe(0);
	});

	test("Escape cancels", async () => {
		const { cancels, confirms } = await renderConfirm({ title: "T" });
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		await waitFor(() => cancels.length > 0);
		expect(confirms.length).toBe(0);
	});

	test("backdrop click cancels, card click does NOT", async () => {
		const { div, cancels } = await renderConfirm({ title: "T" });
		div.querySelector<HTMLElement>(".mxd-confirm-card")?.click();
		expect(cancels.length).toBe(0);
		div.querySelector<HTMLElement>(".mxd-confirm-overlay")?.click();
		expect(cancels.length).toBe(1);
	});

	test("danger renders the destructive confirm style", async () => {
		const { div } = await renderConfirm({ title: "T", danger: true });
		const confirmBtn = div.querySelectorAll<HTMLButtonElement>(
			".mxd-confirm-actions button",
		)[1];
		expect(confirmBtn?.className).toContain("mxd-btn-stop");
	});
});

describe("RollbackConfirmDialog — impact reporting", () => {
	test("clean range: no warnings, explicit 'nothing else changes'", async () => {
		const { div } = await renderRollback({
			kind: "rewind",
			impact: { ...CLEAN_IMPACT, toolNames: ["read_file"] },
		});
		expect(div.querySelector(".mxd-confirm-warnings")).toBeNull();
		const clean = div.querySelector(".mxd-confirm-clean");
		expect(clean?.textContent).toContain("Nothing outside the conversation");
		// Read-only tools are still listed as "what ran here".
		expect(clean?.textContent).toContain("read_file");
	});

	test("file changes → file warning with the tool list", async () => {
		const { div } = await renderRollback({
			kind: "rewind",
			impact: {
				...CLEAN_IMPACT,
				filesModified: true,
				toolNames: ["bash", "write_file"],
			},
		});
		const warnings = div.querySelector(".mxd-confirm-warnings");
		expect(warnings?.textContent).toContain("File changes");
		expect(warnings?.textContent).not.toContain("Task tree changes");
		expect(div.querySelector(".mxd-confirm-tools")?.textContent).toContain(
			"bash, write_file",
		);
		expect(div.querySelector(".mxd-confirm-clean")).toBeNull();
	});

	test("every category flips its own warning line", async () => {
		const { div } = await renderRollback({
			kind: "rewind",
			impact: {
				filesModified: true,
				tasksModified: true,
				messagesSent: true,
				otherSideEffects: true,
				toolNames: ["bash", "create_task", "send_message", "evaluate_script"],
			},
		});
		expect(div.querySelectorAll(".mxd-confirm-warning").length).toBe(4);
		const text = div.querySelector(".mxd-confirm-warnings")?.textContent ?? "";
		expect(text).toContain("File changes");
		expect(text).toContain("Task tree changes");
		expect(text).toContain("Messages already sent");
		expect(text).toContain("other tools");
	});

	test("long tool lists collapse to +N", async () => {
		const { div } = await renderRollback({
			kind: "rewind",
			impact: {
				...CLEAN_IMPACT,
				filesModified: true,
				toolNames: Array.from({ length: 11 }, (_, i) => `tool_${i}`),
			},
		});
		const tools = div.querySelector(".mxd-confirm-tools")?.textContent ?? "";
		expect(tools).toContain("tool_7");
		expect(tools).not.toContain("tool_8");
		expect(tools).toContain("+3");
	});

	test("edit kind uses the edit wording and a non-destructive confirm", async () => {
		const { div } = await renderRollback({
			kind: "edit",
			impact: CLEAN_IMPACT,
		});
		expect(div.querySelector(".mxd-confirm-title")?.textContent).toBe(
			"Edit this message?",
		);
		expect(div.querySelector(".mxd-confirm-message")?.textContent).toContain(
			"edited version",
		);
		const confirmBtn = div.querySelectorAll<HTMLButtonElement>(
			".mxd-confirm-actions button",
		)[1];
		expect(confirmBtn?.textContent).toBe("Edit");
		expect(confirmBtn?.className).toContain("mxd-btn-primary");
	});

	test("rewind kind uses the rewind wording and the destructive confirm", async () => {
		const { div, confirms } = await renderRollback({
			kind: "rewind",
			impact: CLEAN_IMPACT,
		});
		expect(div.querySelector(".mxd-confirm-title")?.textContent).toBe(
			"Rewind to this message?",
		);
		const confirmBtn = div.querySelectorAll<HTMLButtonElement>(
			".mxd-confirm-actions button",
		)[1];
		expect(confirmBtn?.textContent).toBe("Rewind");
		expect(confirmBtn?.className).toContain("mxd-btn-stop");
		confirmBtn?.click();
		expect(confirms.length).toBe(1);
	});
});
