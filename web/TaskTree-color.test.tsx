/// <reference lib="dom" />
/**
 * Frontend test: does TaskTree render borderLeftColor from node.color,
 * and does it update when node.color changes?
 *
 * The test IS the investigation for "task color change not reflecting in sidebar".
 * If this test passes, the frontend render path is clean and the bug lives
 * elsewhere (SSE delivery, event-handler wiring, etc.).
 *
 * Suspect #3 from the task description: CSS specificity.
 *   .mxd-task-node.selected { border-left-color: var(--accent); }
 * is a class-based rule (specificity 0-0-2-0). Inline style has 1-0-0-0.
 * Inline SHOULD win without !important. We test this explicitly.
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

// ── Types matching TaskTree's node contract ──

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

/** Find task node element by its displayed title text. */
function findByTitle(div: HTMLElement, title: string): HTMLElement | null {
	const all = div.querySelectorAll<HTMLElement>(".mxd-task-node");
	for (const el of all) {
		const titleEl = el.querySelector(".mxd-task-title");
		if (titleEl && titleEl.textContent === title) return el;
	}
	return null;
}

describe("TaskTree color rendering", () => {
	test("node with color → inline borderLeftColor set", async () => {
		const { createRoot } = await import("react-dom/client");
		const { createElement } = await import("react");
		const { TaskTree } = await import(
			"../.mxd/plugin/web/components/TaskTree.tsx"
		);
		const { LocaleProvider } = await import("../.mxd/plugin/web/i18n.ts");

		const root = makeTaskNode({
			id: "root-1",
			parentId: null,
			title: "Root",
			children: ["child-1"],
		});
		const child = makeTaskNode({
			id: "child-1",
			parentId: "root-1",
			title: "Blue Task",
			color: "#388bfd",
		});

		const div = document.createElement("div");
		document.body.appendChild(div);
		const reactRoot = createRoot(div);

		reactRoot.render(
			createElement(
				LocaleProvider,
				null,
				createElement(TaskTree, {
					nodes: [root, child],
					selectedTaskId: null,
					rootNodeId: "root-1",
					onSelect: () => {},
					filterOpen: false,
					onFilterOpenChange: () => {},
					filterMode: "all" as const,
				}),
			),
		);
		await new Promise((r) => setTimeout(r, 30));

		try {
			const el = findByTitle(div, "Blue Task");
			expect(el).not.toBeNull();
			expect(el!.style.borderLeftColor).toBe("#388bfd");
		} finally {
			reactRoot.unmount();
			div.remove();
		}
	});

	test("node without color → no inline borderLeftColor", async () => {
		const { createRoot } = await import("react-dom/client");
		const { createElement } = await import("react");
		const { TaskTree } = await import(
			"../.mxd/plugin/web/components/TaskTree.tsx"
		);
		const { LocaleProvider } = await import("../.mxd/plugin/web/i18n.ts");

		const root = makeTaskNode({
			id: "root-1",
			parentId: null,
			title: "Root",
			children: ["child-1"],
		});
		const child = makeTaskNode({
			id: "child-1",
			parentId: "root-1",
			title: "No Color Task",
		});

		const div = document.createElement("div");
		document.body.appendChild(div);
		const reactRoot = createRoot(div);

		reactRoot.render(
			createElement(
				LocaleProvider,
				null,
				createElement(TaskTree, {
					nodes: [root, child],
					selectedTaskId: null,
					rootNodeId: "root-1",
					onSelect: () => {},
					filterOpen: false,
					onFilterOpenChange: () => {},
					filterMode: "all" as const,
				}),
			),
		);
		await new Promise((r) => setTimeout(r, 30));

		try {
			const el = findByTitle(div, "No Color Task");
			expect(el).not.toBeNull();
			expect(el!.style.borderLeftColor).toBe("");
		} finally {
			reactRoot.unmount();
			div.remove();
		}
	});

	test("re-render with new color → borderLeftColor updates", async () => {
		// CORE reproduction of the reported bug.
		// If this passes, the render path correctly updates when node.color changes.
		const { createRoot } = await import("react-dom/client");
		const { createElement } = await import("react");
		const { TaskTree } = await import(
			"../.mxd/plugin/web/components/TaskTree.tsx"
		);
		const { LocaleProvider } = await import("../.mxd/plugin/web/i18n.ts");

		const root = makeTaskNode({
			id: "root-1",
			parentId: null,
			title: "Root",
			children: ["child-1"],
		});
		const childBlue = makeTaskNode({
			id: "child-1",
			parentId: "root-1",
			title: "Color Change",
			color: "#388bfd",
		});

		const div = document.createElement("div");
		document.body.appendChild(div);
		const reactRoot = createRoot(div);

		// First render: blue
		reactRoot.render(
			createElement(
				LocaleProvider,
				null,
				createElement(TaskTree, {
					nodes: [root, childBlue],
					selectedTaskId: null,
					rootNodeId: "root-1",
					onSelect: () => {},
					filterOpen: false,
					onFilterOpenChange: () => {},
					filterMode: "all" as const,
				}),
			),
		);
		await new Promise((r) => setTimeout(r, 30));

		let el = findByTitle(div, "Color Change");
		expect(el).not.toBeNull();
		expect(el!.style.borderLeftColor).toBe("#388bfd");

		// Second render: purple (simulates tree_updated SSE with new color)
		const childPurple = makeTaskNode({
			id: "child-1",
			parentId: "root-1",
			title: "Color Change",
			color: "#a371f7",
		});

		reactRoot.render(
			createElement(
				LocaleProvider,
				null,
				createElement(TaskTree, {
					nodes: [root, childPurple],
					selectedTaskId: null,
					rootNodeId: "root-1",
					onSelect: () => {},
					filterOpen: false,
					onFilterOpenChange: () => {},
					filterMode: "all" as const,
				}),
			),
		);
		await new Promise((r) => setTimeout(r, 30));

		el = findByTitle(div, "Color Change");
		expect(el).not.toBeNull();
		// THE KEY ASSERTION: after re-render with new nodes, color updates
		expect(el!.style.borderLeftColor).toBe("#a371f7");

		reactRoot.unmount();
		div.remove();
	});

	test("selected task with color → inline style present (higher specificity than CSS .selected)", async () => {
		// CSS: .mxd-task-node.selected { border-left-color: var(--accent); }
		// Inline: { borderLeftColor: node.color }
		// Inline specificity 1-0-0-0 > class 0-0-2-0. No !important.
		const { createRoot } = await import("react-dom/client");
		const { createElement } = await import("react");
		const { TaskTree } = await import(
			"../.mxd/plugin/web/components/TaskTree.tsx"
		);
		const { LocaleProvider } = await import("../.mxd/plugin/web/i18n.ts");

		const root = makeTaskNode({
			id: "root-1",
			parentId: null,
			title: "Root",
			children: ["child-1"],
		});
		const child = makeTaskNode({
			id: "child-1",
			parentId: "root-1",
			title: "Selected Colored",
			color: "#f85149",
		});

		const div = document.createElement("div");
		document.body.appendChild(div);
		const reactRoot = createRoot(div);

		reactRoot.render(
			createElement(
				LocaleProvider,
				null,
				createElement(TaskTree, {
					nodes: [root, child],
					selectedTaskId: "child-1", // selected!
					rootNodeId: "root-1",
					onSelect: () => {},
					filterOpen: false,
					onFilterOpenChange: () => {},
					filterMode: "all" as const,
				}),
			),
		);
		await new Promise((r) => setTimeout(r, 30));

		try {
			const el = findByTitle(div, "Selected Colored");
			expect(el).not.toBeNull();
			// Inline style should be present even on selected node
			expect(el!.style.borderLeftColor).toBe("#f85149");
			// And the element should have the selected class
			expect(el!.classList.contains("selected")).toBe(true);
		} finally {
			reactRoot.unmount();
			div.remove();
		}
	});

	test("color cleared → borderLeftColor removed", async () => {
		const { createRoot } = await import("react-dom/client");
		const { createElement } = await import("react");
		const { TaskTree } = await import(
			"../.mxd/plugin/web/components/TaskTree.tsx"
		);
		const { LocaleProvider } = await import("../.mxd/plugin/web/i18n.ts");

		const root = makeTaskNode({
			id: "root-1",
			parentId: null,
			title: "Root",
			children: ["child-1"],
		});
		const childRed = makeTaskNode({
			id: "child-1",
			parentId: "root-1",
			title: "Clearable",
			color: "#f85149",
		});

		const div = document.createElement("div");
		document.body.appendChild(div);
		const reactRoot = createRoot(div);

		// Render with color
		reactRoot.render(
			createElement(
				LocaleProvider,
				null,
				createElement(TaskTree, {
					nodes: [root, childRed],
					selectedTaskId: null,
					rootNodeId: "root-1",
					onSelect: () => {},
					filterOpen: false,
					onFilterOpenChange: () => {},
					filterMode: "all" as const,
				}),
			),
		);
		await new Promise((r) => setTimeout(r, 30));

		let el = findByTitle(div, "Clearable");
		expect(el!.style.borderLeftColor).toBe("#f85149");

		// Re-render without color (simulates update_task {color: null})
		const childNoColor = makeTaskNode({
			id: "child-1",
			parentId: "root-1",
			title: "Clearable",
		});

		reactRoot.render(
			createElement(
				LocaleProvider,
				null,
				createElement(TaskTree, {
					nodes: [root, childNoColor],
					selectedTaskId: null,
					rootNodeId: "root-1",
					onSelect: () => {},
					filterOpen: false,
					onFilterOpenChange: () => {},
					filterMode: "all" as const,
				}),
			),
		);
		await new Promise((r) => setTimeout(r, 30));

		el = findByTitle(div, "Clearable");
		expect(el!.style.borderLeftColor).toBe("");

		reactRoot.unmount();
		div.remove();
	});
});
