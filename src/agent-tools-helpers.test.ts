import { describe, expect, test } from "bun:test";
import {
	buildTaskPrompt,
	formatQueueMessage,
	isDescendantOf,
	slugify,
	toRawMessage,
} from "./agent-tools.ts";
import { TaskTracker } from "./task-tracker.ts";
import type { TaskNode } from "./types.ts";

function makeNode(overrides: Partial<TaskNode> & { id: string }): TaskNode {
	return {
		title: "Test Task",
		description: "A test description",
		status: "pending",
		branch: null,
		parentId: null,
		children: [],
		sessionId: null,
		worktreePath: null,
		message: null,
		failCount: 0,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

describe("slugify", () => {
	test("converts title to lowercase kebab-case", () => {
		expect(slugify("My Great Task")).toBe("my-great-task");
	});

	test("replaces special characters with hyphens", () => {
		expect(slugify("fix: bug #42 (urgent!)")).toBe("fix-bug-42-urgent");
	});

	test("strips leading and trailing hyphens", () => {
		expect(slugify("---hello---")).toBe("hello");
	});

	test("collapses consecutive special chars to single hyphen", () => {
		expect(slugify("a   b...c")).toBe("a-b-c");
	});

	test("truncates to 30 characters", () => {
		const long =
			"this is a very long task title that exceeds thirty characters";
		const result = slugify(long);
		expect(result.length).toBeLessThanOrEqual(30);
	});

	test("handles empty string", () => {
		expect(slugify("")).toBe("");
	});

	test("handles all-special-character input", () => {
		expect(slugify("!@#$%^&*()")).toBe("");
	});
});

describe("buildTaskPrompt", () => {
	function makeTracker(nodes: TaskNode[]): TaskTracker {
		// Create a tracker with nodes injected via its internal map
		const tracker = new TaskTracker("/dev/null/tree.json");
		// Access the private nodes map to set up test state
		const nodesMap = (tracker as unknown as { nodes: Map<string, TaskNode> })
			.nodes;
		for (const node of nodes) {
			nodesMap.set(node.id, node);
		}
		return tracker;
	}

	test("includes task title and description", () => {
		const tracker = makeTracker([]);
		const result = buildTaskPrompt(
			makeNode({ id: "task-1", title: "Fix Bug", description: "Fix the bug" }),
			tracker,
			"",
		);
		expect(result).toContain("# Task: Fix Bug");
		expect(result).toContain("Fix the bug");
		expect(result).toContain("`task-1`");
	});

	test("includes project memory when provided", () => {
		const tracker = makeTracker([]);
		const result = buildTaskPrompt(
			makeNode({ id: "task-1" }),
			tracker,
			"## Important\nRemember this.",
		);
		expect(result).toContain("## Project Memory");
		expect(result).toContain("Remember this.");
	});

	test("omits project memory section when empty", () => {
		const tracker = makeTracker([]);
		const result = buildTaskPrompt(makeNode({ id: "task-1" }), tracker, "");
		expect(result).not.toContain("## Project Memory");
	});

	test("includes git context when branch is set", () => {
		const tracker = makeTracker([]);
		const result = buildTaskPrompt(
			makeNode({
				id: "task-1",
				branch: "og/task-1/fix-bug",
				worktreePath: "/tmp/worktree",
			}),
			tracker,
			"",
		);
		expect(result).toContain("## Git Context");
		expect(result).toContain("`og/task-1/fix-bug`");
		expect(result).toContain("`/tmp/worktree`");
		expect(result).toContain("Do NOT switch branches");
	});

	test("includes instructions section", () => {
		const tracker = makeTracker([]);
		const result = buildTaskPrompt(makeNode({ id: "task-1" }), tracker, "");
		expect(result).toContain("## Instructions");
		expect(result).toContain("bun test");
		expect(result).toContain("memory.md");
	});

	test("lists completed siblings when task has a parent", () => {
		const parent = makeNode({
			id: "parent-1",
			children: ["task-1", "task-2", "task-3"],
		});
		const sibling1 = makeNode({
			id: "task-2",
			parentId: "parent-1",
			title: "Done Sibling",
			status: "passed",
		});
		const sibling2 = makeNode({
			id: "task-3",
			parentId: "parent-1",
			title: "Pending Sibling",
			status: "pending",
		});
		const tracker = makeTracker([parent, sibling1, sibling2]);

		const result = buildTaskPrompt(
			makeNode({ id: "task-1", parentId: "parent-1" }),
			tracker,
			"",
		);
		expect(result).toContain("Already completed siblings");
		expect(result).toContain("Done Sibling (passed)");
		expect(result).not.toContain("Pending Sibling");
	});

	test("omits siblings section when no siblings are passed", () => {
		const parent = makeNode({
			id: "parent-1",
			children: ["task-1", "task-2"],
		});
		const sibling = makeNode({
			id: "task-2",
			parentId: "parent-1",
			status: "in_progress",
		});
		const tracker = makeTracker([parent, sibling]);

		const result = buildTaskPrompt(
			makeNode({ id: "task-1", parentId: "parent-1" }),
			tracker,
			"",
		);
		expect(result).not.toContain("Already completed siblings");
	});

	test("includes budget info when budgetUsd is set", () => {
		const tracker = makeTracker([]);
		const result = buildTaskPrompt(
			makeNode({ id: "task-1", budgetUsd: 0.5 }),
			tracker,
			"",
		);
		expect(result).toContain("**Budget: $0.50**");
		expect(result).toContain("warned at 80%");
	});

	test("omits budget info when budgetUsd is not set", () => {
		const tracker = makeTracker([]);
		const result = buildTaskPrompt(makeNode({ id: "task-1" }), tracker, "");
		expect(result).not.toContain("Budget:");
	});
});

describe("isDescendantOf", () => {
	function makeTracker(nodes: TaskNode[]): TaskTracker {
		const tracker = new TaskTracker("/dev/null/tree.json");
		const nodesMap = (tracker as unknown as { nodes: Map<string, TaskNode> })
			.nodes;
		for (const node of nodes) {
			nodesMap.set(node.id, node);
		}
		return tracker;
	}

	test("returns true for direct child", () => {
		const tracker = makeTracker([
			makeNode({ id: "parent", children: ["child"] }),
			makeNode({ id: "child", parentId: "parent" }),
		]);
		expect(isDescendantOf(tracker, "child", "parent")).toBe(true);
	});

	test("returns true for grandchild", () => {
		const tracker = makeTracker([
			makeNode({ id: "root", children: ["mid"] }),
			makeNode({ id: "mid", parentId: "root", children: ["leaf"] }),
			makeNode({ id: "leaf", parentId: "mid" }),
		]);
		expect(isDescendantOf(tracker, "leaf", "root")).toBe(true);
	});

	test("returns false for unrelated nodes", () => {
		const tracker = makeTracker([makeNode({ id: "a" }), makeNode({ id: "b" })]);
		expect(isDescendantOf(tracker, "a", "b")).toBe(false);
	});

	test("returns false for parent-of-child query (wrong direction)", () => {
		const tracker = makeTracker([
			makeNode({ id: "parent", children: ["child"] }),
			makeNode({ id: "child", parentId: "parent" }),
		]);
		expect(isDescendantOf(tracker, "parent", "child")).toBe(false);
	});

	test("returns false for self", () => {
		const tracker = makeTracker([makeNode({ id: "self" })]);
		expect(isDescendantOf(tracker, "self", "self")).toBe(false);
	});
});

describe("formatQueueMessage", () => {
	test("formats cross_project message as XML", () => {
		const result = formatQueueMessage({
			source: "cross_project",
			fromProjectId: "proj-123",
			fromProjectName: "MyProject",
			content: "Hello from another project",
		});
		expect(result).toContain("<cross_project");
		expect(result).toContain('from="MyProject"');
		expect(result).toContain('projectId="proj-123"');
		expect(result).toContain("Hello from another project");
		expect(result).toContain("</cross_project>");
	});
});

describe("toRawMessage", () => {
	test("converts cross_project message to raw format", () => {
		const result = toRawMessage({
			source: "cross_project",
			fromProjectId: "proj-456",
			fromProjectName: "OtherProject",
			content: "Status update",
		});
		expect(result.source).toBe("cross_project");
		expect(result.content).toContain("OtherProject");
		expect(result.content).toContain("proj-456");
		expect(result.content).toContain("Status update");
	});
});
