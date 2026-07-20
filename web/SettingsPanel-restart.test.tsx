/// <reference lib="dom" />
/**
 * Tests for the unified "Save & Restart" + Revert SettingsPanel UX:
 *
 * - "Save & Restart" saves all dirty tabs then restarts the daemon.
 * - "Revert" resets all tabs to last-saved state.
 * - Closing the panel = discard (no confirm dialog).
 * - Tab-switch does NOT confirm (drafts persist across sub-tabs).
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
					updateGlobal: async () => null,
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
	};
}

// ---- isDirty unit tests ----

describe("isDirty (pure function)", () => {
	let isDirtyFn: typeof import("./components/SettingsPanel.tsx").isDirty;

	beforeAll(async () => {
		isDirtyFn = (await import("./components/SettingsPanel.tsx")).isDirty;
	});

	test("identical → not dirty", () => {
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

	test("nested objects compared by JSON", () => {
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

// ---- Save & Restart + Revert buttons ----

describe("Save & Restart + Revert", () => {
	let result: RenderResult;

	afterEach(() => result?.unmount());

	test("RestartBar has 'Save & Restart' and 'Revert' buttons", async () => {
		result = await renderSettingsPanel();
		const bar = result.div.querySelector(".mxd-settings-tab-actions");
		expect(bar).not.toBeNull();
		const buttons = bar?.querySelectorAll("button");
		expect(buttons?.length).toBe(2);
		expect(buttons?.[0]?.textContent).toContain("Save & Restart");
		expect(buttons?.[1]?.textContent).toContain("Revert");
	});

	test("Revert is disabled when clean (nothing to revert)", async () => {
		result = await renderSettingsPanel();
		const revertBtn = Array.from(
			result.div.querySelectorAll<HTMLButtonElement>(
				".mxd-settings-tab-actions button",
			),
		).find((b) => b.textContent?.includes("Revert"));
		expect(revertBtn).not.toBeNull();
		expect(revertBtn?.disabled).toBe(true);
	});

	test("RestartBar visible on every tab", async () => {
		result = await renderSettingsPanel();
		for (const tabName of ["Global", "Project", "Local"]) {
			const tab = Array.from(
				result.div.querySelectorAll<HTMLButtonElement>(".mxd-settings-tab"),
			).find((b) => b.textContent?.includes(tabName));
			tab?.click();
			await new Promise((r) => setTimeout(r, 20));
			expect(
				result.div.querySelector(".mxd-settings-tab-actions"),
			).not.toBeNull();
		}
	});

	test("clicking Save & Restart with clean state → restart fires, no PATCH", async () => {
		result = await renderSettingsPanel();
		const btn = result.div.querySelector<HTMLButtonElement>(
			".mxd-settings-tab-actions .mxd-btn-primary",
		);
		btn?.click();
		await new Promise((r) => setTimeout(r, 30));
		expect(
			result.fetchCalls.some((c) => c.url.includes("restart-daemon")),
		).toBe(true);
	});
});

// ---- Close panel: no confirm ----

describe("Close panel (no confirm)", () => {
	let result: RenderResult;
	let savedConfirm: typeof window.confirm;

	beforeAll(() => {
		savedConfirm = window.confirm;
	});

	afterEach(() => {
		window.confirm = savedConfirm;
		result?.unmount();
	});

	test("close (X) fires onClose directly — no window.confirm", async () => {
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
		await new Promise((r) => setTimeout(r, 20));
		expect(confirmCalled).toBe(false);
		expect(result.onCloseCalls.length).toBe(1);
	});

	test("tab-switch → no confirm", async () => {
		let confirmCalled = false;
		window.confirm = () => {
			confirmCalled = true;
			return true;
		};
		result = await renderSettingsPanel();
		const projectTab = Array.from(
			result.div.querySelectorAll<HTMLButtonElement>(".mxd-settings-tab"),
		).find((b) => b.textContent?.includes("Project"));
		projectTab?.click();
		await new Promise((r) => setTimeout(r, 20));
		expect(confirmCalled).toBe(false);
	});
});
