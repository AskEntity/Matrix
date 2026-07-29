/// <reference lib="dom" />
/**
 * The user's report, verbatim: "ui 不区分没有填写和 inherit" — the project
 * settings panel could not distinguish "this field inherits from global" from
 * "this field is set to an empty string".
 *
 * `ModelsAuthSection` read its controls as `(draft.model as string | undefined)
 * ?? ""`, which erases the distinction at the moment of reading: `undefined`
 * (inherit) and `""` (an explicit empty override) become one value, so
 *
 *   - both render as an empty box — the state is invisible, and
 *   - typing then deleting leaves `""` in the draft with NO gesture anywhere
 *     that returns to `undefined`, so the panel was a one-way door INTO an
 *     explicit empty override.
 *
 * That matters more since `DEFAULT_MODEL` was deleted: a project-layer `""`
 * overrides a real global model (`resolveConfig` overlays on
 * `value !== undefined`) and no fallback substitutes a model any more, so the
 * empty string now reaches the API.
 *
 * The fix adopts the convention `SettingBoolField` already used one screen away
 * — absence of the key IS inherit — and renders it as a ticked checkbox that
 * also shows WHAT is inherited, with the control hidden while it is ticked.
 *
 * The three tabs are deliberately NOT variations of one form (user, 2026-07-29):
 *
 *   global   settable, no inherit state — nothing sits above it
 *   project  NOT RENDERED — the repo layer is git-tracked and travels with a
 *            clone, so it must not choose the model or auth group an agent runs
 *            with. A trust boundary, which is why GLOBAL_ONLY_FIELDS is the
 *            wrong home for it: the field is not global-only, it is
 *            not-from-the-repo.
 *   local    settable, and the only tab where the inherit state applies.
 *
 * MUTATION PROOF: re-introduce the collapse by deriving the inherit state after
 * `?? ""` (i.e. `isInheriting` reading a coalesced value) and
 * "an explicit empty override is NOT shown as inherit" fails — it is the only
 * test here that separates the two states, and it is the bug that was reported.
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
	layer: ActiveTab;
	layers?: Partial<ThreeLayerConfig>;
	draft?: Record<string, unknown>;
	authGroupNames?: string[];
}

async function renderModelsAuth(args: RenderArgs): Promise<{
	div: HTMLDivElement;
	patches: Record<string, unknown>[];
	unmount: () => void;
}> {
	const { createRoot } = await import("react-dom/client");
	const { createElement } = await import("react");
	const { ModelsAuthSection } = await import("./components/SettingsPanel.tsx");
	const { LocaleProvider } = await import("./i18n.ts");

	const layers: ThreeLayerConfig = {
		global: args.layers?.global ?? {},
		repo: args.layers?.repo ?? {},
		local: args.layers?.local ?? {},
		resolved: args.layers?.resolved ?? {},
	};
	const patches: Record<string, unknown>[] = [];

	const div = document.createElement("div");
	document.body.appendChild(div);
	const root = createRoot(div);
	root.render(
		createElement(
			LocaleProvider,
			null,
			createElement(ModelsAuthSection, {
				layer: args.layer,
				layers,
				authGroupNames: args.authGroupNames ?? ["work"],
				draft: args.draft ?? {},
				onDraftChange: (patch: Record<string, unknown>) => {
					patches.push(patch);
				},
			}),
		),
	);
	await new Promise((r) => setTimeout(r, 10));

	return {
		div,
		patches,
		unmount: () => {
			root.unmount();
			div.remove();
		},
	};
}

/** The two `.mxd-settings-field` rows, in document order: Auth then Model. */
function rows(div: HTMLElement): { auth: HTMLElement; model: HTMLElement } {
	const found = div.querySelectorAll(".mxd-settings-field");
	if (found.length !== 2) {
		throw new Error(`expected 2 field rows, got ${found.length}`);
	}
	return {
		auth: found[0] as HTMLElement,
		model: found[1] as HTMLElement,
	};
}

function checkboxIn(row: HTMLElement): HTMLInputElement | null {
	return row.querySelector('input[type="checkbox"]');
}

describe("Models & Auth: inherit is the absence of the key, not an empty string", () => {
	// The trust boundary, and the reason the three tabs are not variations of one
	// form: `<projectPath>/.mxd/config.json` is git-tracked and arrives with `git
	// clone`, so the repo layer must not choose the model or the auth group an
	// agent runs with. `~/.mxd/`'s local layer never enters a repo. The daemon
	// agrees on the auth half (`rejectCredentialFields` refuses defaultAuth on the
	// repo layer), so rendering the control here would also be offering a remedy
	// that cannot work.
	test("PROJECT tab renders no Models & Auth section at all — the repo layer is untrusted", async () => {
		const r = await renderModelsAuth({
			layer: "project",
			layers: { global: { model: "claude-sonnet-4-6", defaultAuth: "work" } },
			draft: {},
		});
		try {
			expect(r.div.querySelectorAll(".mxd-settings-field").length).toBe(0);
			expect(r.div.querySelector("input[type=text]")).toBe(null);
			expect(r.div.querySelector("select")).toBe(null);
			expect(r.div.querySelector('input[type="checkbox"]')).toBe(null);
			// Not merely hidden fields — the section, title included, is absent.
			expect(r.div.textContent).toBe("");
		} finally {
			r.unmount();
		}
	});

	test("local tab, key absent → ticked, and the control is GONE", async () => {
		const r = await renderModelsAuth({
			layer: "local",
			layers: { global: { model: "claude-sonnet-4-6", defaultAuth: "work" } },
			draft: {},
		});
		try {
			const { auth, model } = rows(r.div);

			const modelBox = checkboxIn(model);
			expect(modelBox === null).toBe(false);
			expect(modelBox?.checked).toBe(true);
			// "选择框消失" — while inheriting there is no input to mistake for a
			// value, which is what made the state invisible before.
			expect(model.querySelector("input[type=text]") === null).toBe(true);

			const authBox = checkboxIn(auth);
			expect(authBox?.checked).toBe(true);
			expect(auth.querySelector("select") === null).toBe(true);
		} finally {
			r.unmount();
		}
	});

	test("local tab, key absent → the INHERITED VALUE is displayed", async () => {
		// Showing "inheriting" without showing WHAT trades an invisible state for
		// a better-labelled invisible state. The question is "what will this
		// project actually use".
		const r = await renderModelsAuth({
			layer: "local",
			layers: { global: { model: "claude-opus-5", defaultAuth: "work" } },
			draft: {},
		});
		try {
			const { auth, model } = rows(r.div);
			expect(model.textContent?.includes("claude-opus-5")).toBe(true);
			expect(auth.textContent?.includes("work")).toBe(true);
		} finally {
			r.unmount();
		}
	});

	test("local tab inherits through repo, not just global", async () => {
		const r = await renderModelsAuth({
			layer: "local",
			layers: {
				global: { model: "global-model" },
				repo: { model: "repo-model" },
			},
			draft: {},
		});
		try {
			const { model } = rows(r.div);
			expect(model.textContent?.includes("repo-model")).toBe(true);
			expect(model.textContent?.includes("global-model")).toBe(false);
		} finally {
			r.unmount();
		}
	});

	test("nothing set on any layer → says so instead of rendering a blank", async () => {
		// DEFAULT_CONFIG.model is "" now, so this is the fresh-install state and
		// it must be legible rather than an empty gap.
		const r = await renderModelsAuth({
			layer: "local",
			layers: { global: { model: "" } },
			draft: {},
		});
		try {
			const { model } = rows(r.div);
			expect(model.textContent?.includes("not set on any layer")).toBe(true);
		} finally {
			r.unmount();
		}
	});

	// ─── The reported bug ───
	test("an explicit empty override is NOT shown as inherit", async () => {
		const r = await renderModelsAuth({
			layer: "local",
			layers: { global: { model: "claude-sonnet-4-6" } },
			draft: { model: "" },
		});
		try {
			const { model } = rows(r.div);
			// Unticked: this project overrides, with an empty value.
			expect(checkboxIn(model)?.checked).toBe(false);
			// And the control is present, so the empty value is visible AS a value
			// and can be corrected.
			const input = model.querySelector(
				"input[type=text]",
			) as HTMLInputElement | null;
			expect(input === null).toBe(false);
			expect(input?.value).toBe("");
			// It must NOT claim to be inheriting the global model.
			expect(model.textContent?.includes("claude-sonnet-4-6")).toBe(false);
		} finally {
			r.unmount();
		}
	});

	test("an explicit value → unticked, control shows the value", async () => {
		const r = await renderModelsAuth({
			layer: "local",
			layers: { global: { model: "claude-sonnet-4-6" } },
			draft: { model: "claude-haiku-9" },
		});
		try {
			const { model } = rows(r.div);
			expect(checkboxIn(model)?.checked).toBe(false);
			const input = model.querySelector(
				"input[type=text]",
			) as HTMLInputElement | null;
			expect(input?.value).toBe("claude-haiku-9");
		} finally {
			r.unmount();
		}
	});

	test("ticking Inherit clears the key (undefined → buildPatch sends null)", async () => {
		const r = await renderModelsAuth({
			layer: "local",
			layers: { global: { model: "claude-sonnet-4-6" } },
			draft: { model: "claude-haiku-9" },
		});
		try {
			const { model } = rows(r.div);
			checkboxIn(model)?.click();
			await new Promise((res) => setTimeout(res, 10));
			expect(r.patches.length).toBe(1);
			expect("model" in (r.patches[0] ?? {})).toBe(true);
			expect(r.patches[0]?.model).toBe(undefined);
		} finally {
			r.unmount();
		}
	});

	test("unticking seeds the inherited value — the UI never authors an empty string", async () => {
		const r = await renderModelsAuth({
			layer: "local",
			layers: { global: { model: "claude-sonnet-4-6" } },
			draft: {},
		});
		try {
			const { model } = rows(r.div);
			checkboxIn(model)?.click();
			await new Promise((res) => setTimeout(res, 10));
			expect(r.patches[0]?.model).toBe("claude-sonnet-4-6");
		} finally {
			r.unmount();
		}
	});

	test("global tab has no inherit control at all — there is no lower layer", async () => {
		const r = await renderModelsAuth({
			layer: "global",
			layers: { global: { model: "claude-sonnet-4-6", defaultAuth: "work" } },
			draft: { model: "claude-sonnet-4-6", defaultAuth: "work" },
		});
		try {
			const { auth, model } = rows(r.div);
			expect(checkboxIn(model)).toBe(null);
			expect(checkboxIn(auth)).toBe(null);
			// Global keeps its controls unconditionally.
			expect(model.querySelector("input[type=text]") === null).toBe(false);
			expect(auth.querySelector("select") === null).toBe(false);
		} finally {
			r.unmount();
		}
	});

	test("local Auth select offers no empty option — inherit is the tickbox", async () => {
		// "" as a project override means "this project has no auth group", which
		// only breaks the project's agent. Global keeps "— None —" because global
		// can legitimately have no auth configured yet.
		const r = await renderModelsAuth({
			layer: "local",
			layers: { global: { defaultAuth: "work" } },
			draft: { defaultAuth: "work" },
			authGroupNames: ["work", "personal"],
		});
		try {
			const { auth } = rows(r.div);
			const select = auth.querySelector("select") as HTMLSelectElement;
			const values = [...select.options].map((o) => o.value);
			expect(values.includes("")).toBe(false);
			expect(values).toEqual(["work", "personal"]);
		} finally {
			r.unmount();
		}
	});

	test("global Auth select DOES offer the empty option", async () => {
		const r = await renderModelsAuth({
			layer: "global",
			layers: { global: { defaultAuth: "" } },
			draft: { defaultAuth: "" },
			authGroupNames: ["work"],
		});
		try {
			const { auth } = rows(r.div);
			const select = auth.querySelector("select") as HTMLSelectElement;
			expect([...select.options].map((o) => o.value)).toEqual(["", "work"]);
		} finally {
			r.unmount();
		}
	});
});
