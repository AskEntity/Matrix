/// <reference lib="dom" />
/**
 * Tests for the unified "Save & Restart" SettingsPanel UX:
 *
 * - One action button: "Save & Restart" — saves all dirty tabs then restarts.
 * - No separate Save / Revert buttons.
 * - Closing the panel = discard. If unsaved changes exist, confirm first.
 * - Tab-switch does NOT confirm (drafts persist across sub-tabs).
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ happy-dom limitation: React controlled-input onChange can't be      │
 * │ triggered via native value setter + dispatchEvent. So dirty-path    │
 * │ component tests (where draft ≠ saved) can't be driven from the DOM.│
 * │ isDirty() is unit-tested; clean-path wiring is component-tested.   │
 * └──────────────────────────────────────────────────────────────────────┘
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

// ---- Shared helpers ----

interface ThreeLayerConfig {
	global: Record<string, unknown>;
	repo: Record<string, unknown>;
	local: Record<string, unknown>;
	resolved: Record<string, unknown>;
}

const SAVED_GLOBAL: Record<string, unknown> = {
	model: "claude-opus-4-6",
	defaultAuth: "main",
	authGroups: { main: { provider: "anthropic", apiKey: "sk-ant-test" } },
};

function makeLayers(): ThreeLayerConfig {
	return {
		global: { ...SAVED_GLOBAL },
		repo: {},
		local: {},
		resolved: { ...SAVED_GLOBAL },
	};
}

interface RenderResult {
	div: HTMLDivElement;
	unmount: () => void;
	fetchCalls: Array<{ url: string; method?: string }>;
	onCloseCalls: number[];
	updateGlobalCalls: Array<Record<string, unknown>>;
}

async function renderSettingsPanel(): Promise<RenderResult> {
	const { createRoot } = await import("react-dom/client");
	const { createElement } = await import("react");
	const { SettingsPanel } = await import("./components/SettingsPanel.tsx");
	const { LocaleProvider } = await import("./i18n.ts");
	const { AuthFetchProvider } = await import("./auth-context.ts");

	const fetchCalls: Array<{ url: string; method?: string }> = [];
	const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : (input as Request).url;
		fetchCalls.push({ url, method: init?.method });
		return new Response("ok");
	};

	const onCloseCalls: number[] = [];
	const updateGlobalCalls: Array<Record<string, unknown>> = [];

	const layers = makeLayers();

	const div = document.createElement("div");
	document.body.appendChild(div);
	const root = createRoot(div);

	root.render(
		createElement(
			LocaleProvider,
			null,
			createElement(
				AuthFetchProvider,
				{ value: mockFetch },
				createElement(SettingsPanel, {
					projectId: "test-project",
					layers,
					loading: false,
					theme: "dark",
					onThemeChange: () => {},
					updateGlobal: async (patch: Record<string, unknown>) => {
						updateGlobalCalls.push(patch);
						return null;
					},
					updateRepo: async () => null,
					updateLocal: async () => null,
					onClose: () => onCloseCalls.push(Date.now()),
				}),
			),
		),
	);

	await new Promise((r) => setTimeout(r, 30));

	return {
		div,
		unmount: () => {
			root.unmount();
			div.remove();
		},
		fetchCalls,
		onCloseCalls,
		updateGlobalCalls,
	};
}

// ---- isDirty unit tests ----

describe("isDirty (pure function)", () => {
	let isDirtyFn: typeof import("./components/SettingsPanel.tsx").isDirty;

	beforeAll(async () => {
		const mod = await import("./components/SettingsPanel.tsx");
		isDirtyFn = mod.isDirty;
	});

	test("identical objects → not dirty", () => {
		expect(isDirtyFn({ model: "A" }, { model: "A" })).toBe(false);
	});

	test("different value → dirty", () => {
		expect(isDirtyFn({ model: "B" }, { model: "A" })).toBe(true);
	});

	test("key missing in draft → dirty", () => {
		expect(isDirtyFn({}, { model: "A" })).toBe(true);
	});

	test("extra key in draft → dirty", () => {
		expect(isDirtyFn({ model: "A", extra: 1 }, { model: "A" })).toBe(true);
	});

	test("nested objects compared by JSON value", () => {
		expect(
			isDirtyFn({ cacheTtl: { root: "1h" } }, { cacheTtl: { root: "1h" } }),
		).toBe(false);
		expect(
			isDirtyFn({ cacheTtl: { root: "5m" } }, { cacheTtl: { root: "1h" } }),
		).toBe(true);
	});

	test("both empty → not dirty", () => {
		expect(isDirtyFn({}, {})).toBe(false);
	});
});

// ---- "Save & Restart" button ----

describe("Save & Restart unified button", () => {
	let result: RenderResult;

	afterEach(() => result?.unmount());

	test("button says 'Save & Restart'", async () => {
		result = await renderSettingsPanel();
		const btn = result.div.querySelector<HTMLButtonElement>(
			".mxd-settings-tab-actions .mxd-btn-primary",
		);
		expect(btn).not.toBeNull();
		expect(btn?.textContent).toContain("Save & Restart");
	});

	test("no separate Save or Revert buttons in tab-actions", async () => {
		result = await renderSettingsPanel();
		const tabActions = result.div.querySelector(".mxd-settings-tab-actions");
		expect(tabActions).not.toBeNull();
		const buttons = tabActions?.querySelectorAll("button");
		// Only one button: "Save & Restart"
		expect(buttons.length).toBe(1);
		expect(buttons[0]?.textContent).toContain("Save & Restart");
	});

	test("button is visible on every tab (shared RestartBar)", async () => {
		result = await renderSettingsPanel();

		// Check it's there on Global (default)
		let bar = result.div.querySelector(".mxd-settings-tab-actions");
		expect(bar).not.toBeNull();

		// Switch to Project tab
		const projectTab = Array.from(
			result.div.querySelectorAll<HTMLButtonElement>(".mxd-settings-tab"),
		).find((btn) => btn.textContent?.includes("Project"));
		projectTab?.click();
		await new Promise((r) => setTimeout(r, 20));

		bar = result.div.querySelector(".mxd-settings-tab-actions");
		expect(bar).not.toBeNull();

		// Switch to Local tab
		const localTab = Array.from(
			result.div.querySelectorAll<HTMLButtonElement>(".mxd-settings-tab"),
		).find((btn) => btn.textContent?.includes("Local"));
		localTab?.click();
		await new Promise((r) => setTimeout(r, 20));

		bar = result.div.querySelector(".mxd-settings-tab-actions");
		expect(bar).not.toBeNull();
	});

	test("clicking button with clean state → no PATCH, restart fires", async () => {
		result = await renderSettingsPanel();
		const btn = result.div.querySelector<HTMLButtonElement>(
			".mxd-settings-tab-actions .mxd-btn-primary",
		);
		btn?.click();
		await new Promise((r) => setTimeout(r, 30));

		// No PATCH calls (nothing dirty)
		expect(result.updateGlobalCalls.length).toBe(0);
		// Restart POST fired
		expect(
			result.fetchCalls.some((c) => c.url.includes("restart-daemon")),
		).toBe(true);
	});
});

// ---- Close-panel guard ----

describe("Close-panel unsaved guard", () => {
	let result: RenderResult;
	let savedConfirm: typeof window.confirm;

	beforeAll(() => {
		savedConfirm = window.confirm;
	});

	afterEach(() => {
		window.confirm = savedConfirm;
		result?.unmount();
	});

	test("close (X) with NO unsaved → onClose fires, no confirm", async () => {
		let confirmCalled = false;
		window.confirm = () => {
			confirmCalled = true;
			return true;
		};
		result = await renderSettingsPanel();

		const closeBtn = result.div.querySelector<HTMLButtonElement>(
			".mxd-settings-header .mxd-btn-icon",
		);
		closeBtn?.click();
		await new Promise((r) => setTimeout(r, 30));

		expect(confirmCalled).toBe(false);
		expect(result.onCloseCalls.length).toBe(1);
	});

	test("tab-switch → NO confirm (drafts persist, not a loss point)", async () => {
		let confirmCalled = false;
		window.confirm = () => {
			confirmCalled = true;
			return true;
		};
		result = await renderSettingsPanel();

		// Switch Global → Project → Global
		const projectTab = Array.from(
			result.div.querySelectorAll<HTMLButtonElement>(".mxd-settings-tab"),
		).find((btn) => btn.textContent?.includes("Project"));
		projectTab?.click();
		await new Promise((r) => setTimeout(r, 20));

		const globalTab = Array.from(
			result.div.querySelectorAll<HTMLButtonElement>(".mxd-settings-tab"),
		).find((btn) => btn.textContent?.includes("Global"));
		globalTab?.click();
		await new Promise((r) => setTimeout(r, 20));

		expect(confirmCalled).toBe(false);
	});
});
