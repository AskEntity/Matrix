/// <reference lib="dom" />
/**
 * Regression guard for: "Root Cache TTL dropdown shows both options as
 * (default)" (task 01KPHEF7A9EF9RJHTBPGXDD9K7).
 *
 * Invariant: every cache-TTL dropdown must have EXACTLY ONE <option> labeled
 * with "(default)" — and that option must be the true default for that
 * control. Per `memory.md` "Cache TTL" section:
 *   - Root default = "1h"
 *   - Child default = "5m"
 *
 * The bug was caused by confusingly-named i18n keys: `cacheTtl5m` translated
 * to "5 min (default)" and `cacheTtl5mChild` translated to plain "5 min" —
 * the suffix was inverted from what the names suggested. The Root dropdown
 * picked `cacheTtl5m` for its non-default 5m option, so both options ended
 * up labeled (default).
 *
 * Fix restructures the keys to be self-documenting:
 *   - cacheTtl1h        = "1 hour"
 *   - cacheTtl5m        = "5 min"
 *   - cacheTtl1hDefault = "1 hour (default)"
 *   - cacheTtl5mDefault = "5 min (default)"
 *
 * These tests exercise the rendered <select> directly. Mutation proof:
 * reverting the fix in any of the four <option>s — e.g. putting
 * `cacheTtl5mDefault` on the Root dropdown's 5m option, or `cacheTtl5m`
 * on the Child dropdown's 5m option — fails at least one assertion.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

type ActiveTab = "global" | "project" | "local";

interface ThreeLayerConfig {
	global: Record<string, unknown>;
	repo: Record<string, unknown>;
	local: Record<string, unknown>;
	resolved: Record<string, unknown>;
}

interface RenderArgs {
	tab: ActiveTab;
	layers?: Partial<ThreeLayerConfig>;
	draft?: Record<string, unknown>;
}

/**
 * Mount `<CacheTtlSection>` standalone and return the container plus an
 * unmount callback. We render directly instead of mounting the entire
 * SettingsPanel because the panel pulls in fetches, useAuthFetch, and a
 * dozen unrelated sections that are noise for this test.
 */
async function renderCacheTtlSection(args: RenderArgs): Promise<{
	div: HTMLDivElement;
	unmount: () => void;
}> {
	const { createRoot } = await import("react-dom/client");
	const { createElement } = await import("react");
	const { CacheTtlSection } = await import("./components/SettingsPanel.tsx");
	const { LocaleProvider } = await import("./i18n.ts");

	const layers: ThreeLayerConfig = {
		global: args.layers?.global ?? {},
		repo: args.layers?.repo ?? {},
		local: args.layers?.local ?? {},
		resolved: args.layers?.resolved ?? {},
	};

	const div = document.createElement("div");
	document.body.appendChild(div);
	const root = createRoot(div);

	root.render(
		createElement(
			LocaleProvider,
			null,
			createElement(CacheTtlSection, {
				tab: args.tab,
				layers,
				draft: args.draft ?? {},
				onDraftChange: () => {},
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

/**
 * Find the Root vs Child <select> by walking the DOM. The two selects sit in
 * adjacent `.mxd-settings-field` blocks, in document order Root → Child.
 */
function getDropdowns(div: HTMLElement): {
	root: HTMLSelectElement;
	child: HTMLSelectElement;
} {
	const selects = div.querySelectorAll("select");
	if (selects.length !== 2) {
		throw new Error(
			`Expected exactly 2 <select> elements (Root + Child), got ${selects.length}`,
		);
	}
	return {
		root: selects[0] as HTMLSelectElement,
		child: selects[1] as HTMLSelectElement,
	};
}

/** Return options whose visible text contains "(default)". */
function defaultOptions(select: HTMLSelectElement): HTMLOptionElement[] {
	return Array.from(select.options).filter((opt) =>
		(opt.textContent ?? "").includes("(default)"),
	);
}

describe("SettingsPanel CacheTtlSection — exactly one (default) per dropdown", () => {
	test("Root dropdown: exactly one option labeled (default), value=1h", async () => {
		// Mutation proof: reverting line 847 to use `cacheTtl5mDefault` (or the
		// pre-fix `cacheTtl5m` which translated to "5 min (default)") would add
		// a SECOND (default) option to the Root dropdown, failing the .toBe(1)
		// assertion. The .value === "1h" pin enforces that the surviving
		// (default) option is the true Root default.
		const { div, unmount } = await renderCacheTtlSection({ tab: "global" });
		const { root } = getDropdowns(div);

		const defaults = defaultOptions(root);
		expect(defaults.length).toBe(1);
		expect(defaults[0]?.value).toBe("1h");

		// Belt-and-braces: positive assertion on the non-default option.
		const nonDefault = Array.from(root.options).filter(
			(o) => !(o.textContent ?? "").includes("(default)") && o.value !== "",
		);
		expect(nonDefault.length).toBe(1);
		expect(nonDefault[0]?.value).toBe("5m");

		unmount();
	});

	test("Child dropdown: exactly one option labeled (default), value=5m", async () => {
		// Mutation proof: reverting line 869 to use `cacheTtl5m` (now translates
		// to plain "5 min") would leave the Child dropdown with ZERO (default)
		// options, failing this assertion.
		const { div, unmount } = await renderCacheTtlSection({ tab: "global" });
		const { child } = getDropdowns(div);

		const defaults = defaultOptions(child);
		expect(defaults.length).toBe(1);
		expect(defaults[0]?.value).toBe("5m");

		const nonDefault = Array.from(child.options).filter(
			(o) => !(o.textContent ?? "").includes("(default)") && o.value !== "",
		);
		expect(nonDefault.length).toBe(1);
		expect(nonDefault[0]?.value).toBe("1h");

		unmount();
	});

	test("Inherit option (non-global tab) uses plain (no '(default)') variants", async () => {
		// On project/local tabs, an "Inherit from lower layer" option is added
		// that shows the inherited value in parentheses. The inherited-display
		// expression must use plain `cacheTtl1h` / `cacheTtl5m` keys — if it
		// used the *Default keys, the inherit option would say e.g.
		// "Inherit (5 min (default))" with a stray "(default)" suffix that's
		// nonsense in the inherit context (it's the inherited value, not the
		// default of THIS dropdown).
		//
		// Mutation proof: swapping `cacheTtl5m` to `cacheTtl5mDefault` on
		// lines 842 or 865 would leak "(default)" into the inherit option's
		// text, failing the chip-count assertion below (we'd see 2 instead of 1).
		const { div, unmount } = await renderCacheTtlSection({
			tab: "local",
			layers: { global: { cacheTtl: { root: "5m", child: "1h" } } },
		});
		const { root, child } = getDropdowns(div);

		// Each dropdown still has exactly ONE (default) — the bare option.
		expect(defaultOptions(root).length).toBe(1);
		expect(defaultOptions(child).length).toBe(1);

		// Inherit option is the value="" option; its text shows the inherited
		// value WITHOUT a stray "(default)" suffix.
		const rootInherit = Array.from(root.options).find((o) => o.value === "");
		const childInherit = Array.from(child.options).find((o) => o.value === "");
		expect(rootInherit?.textContent ?? "").toContain("5 min");
		expect(rootInherit?.textContent ?? "").not.toContain("(default)");
		expect(childInherit?.textContent ?? "").toContain("1 hour");
		expect(childInherit?.textContent ?? "").not.toContain("(default)");

		unmount();
	});
});
