/// <reference lib="dom" />
/**
 * Component tests for the sidebar search/filter toggle (TaskTree).
 *
 * Covers the behaviours the fix promises:
 *  - filtering is driven by the controlled `filterQuery` prop
 *  - the search bar's visibility reflects `filterOpen`
 *  - Escape in the input calls `onFilterClose`
 *  - blurring the input does NOT close it (the removed race source)
 *  - the input auto-focuses when opened
 *  - the "又弹出来" reproduction: open → blur → toggle stays CLOSED
 *
 * The pure toggle logic (open/close/clear) is covered exhaustively in
 * filter-state.test.ts; these tests verify TaskTree is wired to that contract.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { TaskTreeProps } from "../.mxd/plugin/web/components/TaskTree.tsx";

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

type TaskNode = {
	id: string;
	type: "task";
	title: string;
	parentId: string | null;
	children: string[];
	status: "pending" | "in_progress" | "verify" | "failed" | "closed" | "draft";
	description: string;
	editedBy: "user" | "agent";
	createdAt: string;
	updatedAt: string;
	color?: string;
};

function makeTaskNode(
	overrides: Partial<TaskNode> & { id: string; parentId: string | null },
): TaskNode {
	return {
		type: "task",
		title: "Test Task",
		children: [],
		status: "pending",
		description: "",
		editedBy: "user",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

function findByTitle(div: HTMLElement, title: string): HTMLElement | null {
	const all = div.querySelectorAll<HTMLElement>(".mxd-task-node");
	for (const el of all) {
		const titleEl = el.querySelector(".mxd-task-title");
		if (titleEl && titleEl.textContent === title) return el;
	}
	return null;
}

function searchBar(div: HTMLElement): HTMLElement | null {
	return div.querySelector<HTMLElement>(".mxd-tree-search-bar");
}

function searchInput(div: HTMLElement): HTMLInputElement | null {
	return div.querySelector<HTMLInputElement>(".mxd-tree-search");
}

const rootWithTwo = () => {
	const root = makeTaskNode({
		id: "root-1",
		parentId: null,
		title: "Root",
		children: ["blue", "red"],
	});
	const blue = makeTaskNode({
		id: "blue",
		parentId: "root-1",
		title: "Blue Task",
	});
	const red = makeTaskNode({
		id: "red",
		parentId: "root-1",
		title: "Red Task",
	});
	return [root, blue, red];
};

async function mount(
	props: TaskTreeProps,
): Promise<{ div: HTMLElement; unmount: () => void }> {
	const { createRoot } = await import("react-dom/client");
	const { createElement } = await import("react");
	const { TaskTree } = await import(
		"../.mxd/plugin/web/components/TaskTree.tsx"
	);
	const { LocaleProvider } = await import("../.mxd/plugin/web/i18n.ts");
	const div = document.createElement("div");
	document.body.appendChild(div);
	const reactRoot = createRoot(div);
	reactRoot.render(
		createElement(LocaleProvider, null, createElement(TaskTree, props)),
	);
	await new Promise((r) => setTimeout(r, 30));
	return {
		div,
		unmount: () => {
			reactRoot.unmount();
			div.remove();
		},
	};
}

const baseProps = {
	nodes: rootWithTwo(),
	selectedTaskId: null,
	rootNodeId: "root-1",
	onSelect: () => {},
	filterMode: "all" as const,
};

describe("TaskTree filter toggle", () => {
	test("filterQuery prop filters the tree (matching + hides non-matching)", async () => {
		const { div, unmount } = await mount({
			...baseProps,
			filterOpen: true,
			filterQuery: "Blue",
			onFilterQueryChange: () => {},
			onFilterClose: () => {},
		});
		try {
			expect(findByTitle(div, "Blue Task")).not.toBeNull();
			expect(findByTitle(div, "Red Task")).toBeNull();
		} finally {
			unmount();
		}
	});

	test("empty filterQuery shows all tasks", async () => {
		const { div, unmount } = await mount({
			...baseProps,
			filterOpen: true,
			filterQuery: "",
			onFilterQueryChange: () => {},
			onFilterClose: () => {},
		});
		try {
			expect(findByTitle(div, "Blue Task")).not.toBeNull();
			expect(findByTitle(div, "Red Task")).not.toBeNull();
		} finally {
			unmount();
		}
	});

	test("search bar reflects filterOpen: open has --open, closed does not", async () => {
		const openMount = await mount({
			...baseProps,
			filterOpen: true,
			filterQuery: "",
			onFilterQueryChange: () => {},
			onFilterClose: () => {},
		});
		try {
			expect(
				searchBar(openMount.div)?.classList.contains(
					"mxd-tree-search-bar--open",
				),
			).toBe(true);
		} finally {
			openMount.unmount();
		}

		const closedMount = await mount({
			...baseProps,
			filterOpen: false,
			filterQuery: "",
			onFilterQueryChange: () => {},
			onFilterClose: () => {},
		});
		try {
			expect(
				searchBar(closedMount.div)?.classList.contains(
					"mxd-tree-search-bar--open",
				),
			).toBe(false);
		} finally {
			closedMount.unmount();
		}
	});

	test("Escape in the input calls onFilterClose", async () => {
		let closed = 0;
		const { div, unmount } = await mount({
			...baseProps,
			filterOpen: true,
			filterQuery: "abc",
			onFilterQueryChange: () => {},
			onFilterClose: () => {
				closed++;
			},
		});
		try {
			const input = searchInput(div);
			expect(input).not.toBeNull();
			input!.focus();
			input!.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
			);
			await new Promise((r) => setTimeout(r, 10));
			expect(closed).toBe(1);
		} finally {
			unmount();
		}
	});

	test("blurring the input does NOT close it (no blur-driven close)", async () => {
		// Mutation guard: the old code auto-closed on blur, which raced the toggle
		// button and made click-to-close re-open ("又弹出来"). blur must be a no-op.
		let closed = 0;
		const { div, unmount } = await mount({
			...baseProps,
			filterOpen: true,
			filterQuery: "",
			onFilterQueryChange: () => {},
			onFilterClose: () => {
				closed++;
			},
		});
		try {
			const input = searchInput(div);
			expect(input).not.toBeNull();
			input!.focus();
			input!.blur();
			await new Promise((r) => setTimeout(r, 10));
			expect(closed).toBe(0);
		} finally {
			unmount();
		}
	});

	test("input auto-focuses when opened", async () => {
		const { div, unmount } = await mount({
			...baseProps,
			filterOpen: true,
			filterQuery: "",
			onFilterQueryChange: () => {},
			onFilterClose: () => {},
		});
		try {
			// Auto-focus is scheduled ~50ms after open.
			await new Promise((r) => setTimeout(r, 80));
			const input = searchInput(div);
			expect(document.activeElement).toBe(input);
		} finally {
			unmount();
		}
	});
});

describe("TaskTree filter toggle — '又弹出来' reproduction (button + real reducer)", () => {
	test("open → blur input → click toggle: stays CLOSED (does not re-open)", async () => {
		const { createRoot } = await import("react-dom/client");
		const { createElement, useReducer } = await import("react");
		const { TaskTree } = await import(
			"../.mxd/plugin/web/components/TaskTree.tsx"
		);
		const { LocaleProvider } = await import("../.mxd/plugin/web/i18n.ts");
		const { filterReducer, INITIAL_FILTER_STATE } = await import(
			"../.mxd/plugin/web/filter-state.ts"
		);

		// Mirrors Plugin.tsx's exact wiring: one reducer, button dispatches toggle,
		// TaskTree gets filterOpen/filterQuery + onFilterQueryChange/onFilterClose.
		function Harness() {
			const [state, dispatch] = useReducer(filterReducer, INITIAL_FILTER_STATE);
			return createElement(
				LocaleProvider,
				null,
				createElement(
					"button",
					{
						type: "button",
						"data-testid": "toggle",
						onClick: () => dispatch({ type: "toggle" }),
					},
					"toggle",
				),
				createElement(TaskTree, {
					...baseProps,
					filterOpen: state.open,
					filterQuery: state.query,
					onFilterQueryChange: (q: string) =>
						dispatch({ type: "setQuery", query: q }),
					onFilterClose: () => dispatch({ type: "close" }),
				}),
			);
		}

		const div = document.createElement("div");
		document.body.appendChild(div);
		const reactRoot = createRoot(div);
		reactRoot.render(createElement(Harness));
		await new Promise((r) => setTimeout(r, 30));

		try {
			const toggle = div.querySelector<HTMLButtonElement>(
				'[data-testid="toggle"]',
			)!;
			// 1. Closed initially.
			expect(
				searchBar(div)?.classList.contains("mxd-tree-search-bar--open"),
			).toBe(false);

			// 2. Click to open.
			toggle.click();
			await new Promise((r) => setTimeout(r, 70)); // allow auto-focus
			expect(
				searchBar(div)?.classList.contains("mxd-tree-search-bar--open"),
			).toBe(true);

			// 3. Simulate the browser's blur-on-mousedown when clicking the button
			//    while the input is focused (this is what triggered the old race).
			searchInput(div)?.blur();
			await new Promise((r) => setTimeout(r, 10));

			// 4. Click the toggle again → must CLOSE, not re-open.
			toggle.click();
			await new Promise((r) => setTimeout(r, 20));
			expect(
				searchBar(div)?.classList.contains("mxd-tree-search-bar--open"),
			).toBe(false);
		} finally {
			reactRoot.unmount();
			div.remove();
		}
	});
});
