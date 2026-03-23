import { describe, expect, test } from "bun:test";
import type { QueueMessage } from "./message-queue.ts";
import { TaskTracker } from "./task-tracker.ts";
import {
	buildTaskPrompt,
	formatQueueMessage,
	getDescendantIds,
	isDescendantOf,
	slugify,
} from "./task-utils.ts";
import type { TaskNode } from "./types.ts";

function makeNode(overrides: Partial<TaskNode> & { id: string }): TaskNode {
	return {
		title: "Test Task",
		description: "A test description",
		status: "pending",
		branch: null,
		parentId: null,
		children: [],
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
		expect(slugify("")).toBe("task");
	});

	test("handles all-special-character input", () => {
		expect(slugify("!@#$%^&*()")).toBe("task");
	});

	test("converts CJK to pinyin", () => {
		expect(slugify("测试")).toBe("ce-shi");
	});

	test("handles mixed CJK and ASCII", () => {
		expect(slugify("Fix: 修复bug")).toBe("fix-xiu-fu-bug");
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
		expect(result).toContain(
			"# .opengraft/memory.md (Preloaded, do not read again)",
		);
		expect(result).toContain("Remember this.");
	});

	test("omits project memory section when empty", () => {
		const tracker = makeTracker([]);
		const result = buildTaskPrompt(makeNode({ id: "task-1" }), tracker, "");
		expect(result).not.toContain(
			"# .opengraft/memory.md (Preloaded, do not read again)",
		);
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

describe("getDescendantIds", () => {
	function makeTracker(nodes: TaskNode[]): TaskTracker {
		const tracker = new TaskTracker("/dev/null/tree.json");
		const nodesMap = (tracker as unknown as { nodes: Map<string, TaskNode> })
			.nodes;
		for (const node of nodes) {
			nodesMap.set(node.id, node);
		}
		return tracker;
	}

	test("returns direct children", () => {
		const tracker = makeTracker([
			makeNode({ id: "root", children: ["a", "b"] }),
			makeNode({ id: "a", parentId: "root" }),
			makeNode({ id: "b", parentId: "root" }),
		]);
		expect(getDescendantIds(tracker, "root")).toEqual(["a", "b"]);
	});

	test("returns grandchildren and deeper", () => {
		const tracker = makeTracker([
			makeNode({ id: "root", children: ["mid"] }),
			makeNode({ id: "mid", parentId: "root", children: ["leaf"] }),
			makeNode({ id: "leaf", parentId: "mid" }),
		]);
		const ids = getDescendantIds(tracker, "root");
		expect(ids).toContain("mid");
		expect(ids).toContain("leaf");
		expect(ids).toHaveLength(2);
	});

	test("returns empty array for leaf node", () => {
		const tracker = makeTracker([makeNode({ id: "leaf" })]);
		expect(getDescendantIds(tracker, "leaf")).toEqual([]);
	});

	test("returns empty array for non-existent node", () => {
		const tracker = makeTracker([]);
		expect(getDescendantIds(tracker, "missing")).toEqual([]);
	});

	test("returns all descendants in breadth-first order", () => {
		const tracker = makeTracker([
			makeNode({ id: "root", children: ["a", "b"] }),
			makeNode({ id: "a", parentId: "root", children: ["a1", "a2"] }),
			makeNode({ id: "b", parentId: "root", children: ["b1"] }),
			makeNode({ id: "a1", parentId: "a" }),
			makeNode({ id: "a2", parentId: "a" }),
			makeNode({ id: "b1", parentId: "b" }),
		]);
		const ids = getDescendantIds(tracker, "root");
		expect(ids).toEqual(["a", "b", "a1", "a2", "b1"]);
	});
});

describe("formatQueueMessage", () => {
	test("parent_update without requestReply", () => {
		const msg: QueueMessage = {
			source: "parent_update",
			content: "Priority changed",
		};
		const result = formatQueueMessage(msg);
		expect(result).toContain("<parent_update>Priority changed</parent_update>");
		expect(result).not.toContain("requestReply");
	});

	test("parent_update with requestReply=true uses XML attribute", () => {
		const msg: QueueMessage = {
			source: "parent_update",
			content: "What is the status?",
			requestReply: true,
		};
		const result = formatQueueMessage(msg);
		expect(result).toContain(
			'<parent_update requestReply="true">What is the status?</parent_update>',
		);
	});

	test("parent_update with requestReply=false does not have attribute", () => {
		const msg: QueueMessage = {
			source: "parent_update",
			content: "FYI update",
			requestReply: false,
		};
		const result = formatQueueMessage(msg);
		expect(result).toContain("<parent_update>FYI update</parent_update>");
		expect(result).not.toContain("requestReply");
	});

	test("child_report without requestReply", () => {
		const msg: QueueMessage = {
			source: "child_report",
			taskId: "task-1",
			title: "Auth Module",
			content: "50% done",
		};
		const result = formatQueueMessage(msg);
		expect(result).toContain(
			'<child_report from="Auth Module" id="task-1">50% done</child_report>',
		);
		expect(result).not.toContain("requestReply");
	});

	test("child_report with requestReply=true uses XML attribute", () => {
		const msg: QueueMessage = {
			source: "child_report",
			taskId: "task-2",
			title: "DB Module",
			content: "Need clarification on schema",
			requestReply: true,
		};
		const result = formatQueueMessage(msg);
		expect(result).toContain(
			'<child_report from="DB Module" id="task-2" requestReply="true">Need clarification on schema</child_report>',
		);
	});

	test("child_report with requestReply=false does not have attribute", () => {
		const msg: QueueMessage = {
			source: "child_report",
			taskId: "task-3",
			title: "UI",
			content: "All good",
			requestReply: false,
		};
		const result = formatQueueMessage(msg);
		expect(result).toContain(
			'<child_report from="UI" id="task-3">All good</child_report>',
		);
		expect(result).not.toContain("requestReply");
	});

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
