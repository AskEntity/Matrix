import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskTracker } from "./task-tracker.ts";

describe("TaskTracker", () => {
	let tempDir: string;
	let tracker: TaskTracker;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-tracker-"));
		tracker = new TaskTracker(join(tempDir, "tree.json"));
		await tracker.load();
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
	});

	test("addTask creates a top-level task", () => {
		const task = tracker.addTask("Chat App", "Build a multi-user chat");
		expect(task.title).toBe("Chat App");
		expect(task.status).toBe("pending");
		expect(task.parentId).toBeNull();
		expect(tracker.getTopLevel()).toHaveLength(1);
		expect(tracker.getTopLevel()[0]?.id).toBe(task.id);
	});

	test("multiple top-level tasks allowed", () => {
		tracker.addTask("App1", "desc1");
		tracker.addTask("App2", "desc2");
		expect(tracker.getTopLevel()).toHaveLength(2);
	});

	test("addChild creates child under parent", () => {
		const parent = tracker.addTask("App", "desc");
		const child = tracker.addChild(parent.id, "Auth", "User authentication");

		expect(child.parentId).toBe(parent.id);
		expect(child.status).toBe("pending");

		const children = tracker.getChildren(parent.id);
		expect(children).toHaveLength(1);
		expect(children[0]?.id).toBe(child.id);
	});

	test("addChild fails for unknown parent", () => {
		expect(() => tracker.addChild("nonexistent", "Task", "desc")).toThrow(
			"Parent node not found",
		);
	});

	test("updateStatus changes node status", () => {
		const task = tracker.addTask("App", "desc");
		tracker.updateStatus(task.id, "in_progress");
		expect(tracker.get(task.id)?.status).toBe("in_progress");
	});

	test("assignBranch sets branch name", () => {
		const parent = tracker.addTask("App", "desc");
		const child = tracker.addChild(parent.id, "Auth", "desc");
		tracker.assignBranch(child.id, "feat/auth");
		expect(tracker.get(child.id)?.branch).toBe("feat/auth");
	});

	test("byStatus filters nodes", () => {
		const parent = tracker.addTask("App", "desc");
		const c1 = tracker.addChild(parent.id, "A", "a");
		const c2 = tracker.addChild(parent.id, "B", "b");
		tracker.updateStatus(c1.id, "passed");
		tracker.updateStatus(c2.id, "in_progress");

		expect(tracker.byStatus("passed")).toHaveLength(1);
		expect(tracker.byStatus("in_progress")).toHaveLength(1);
		expect(tracker.byStatus("pending")).toHaveLength(1); // parent
	});

	test("remove deletes node and descendants", () => {
		const parent = tracker.addTask("App", "desc");
		const c1 = tracker.addChild(parent.id, "A", "a");
		const c1a = tracker.addChild(c1.id, "A1", "a1");

		tracker.remove(c1.id);

		expect(tracker.get(c1.id)).toBeUndefined();
		expect(tracker.get(c1a.id)).toBeUndefined();
		expect(tracker.getChildren(parent.id)).toHaveLength(0);
		expect(tracker.allNodes()).toHaveLength(1); // only parent
	});

	test("remove top-level task works", () => {
		const task = tracker.addTask("App", "desc");
		tracker.addChild(task.id, "A", "a");

		tracker.remove(task.id);

		expect(tracker.allNodes()).toHaveLength(0);
	});

	test("persists and reloads", async () => {
		const parent = tracker.addTask("App", "desc");
		tracker.addChild(parent.id, "Auth", "auth desc");
		tracker.updateStatus(parent.id, "in_progress");
		await tracker.save();

		const tracker2 = new TaskTracker(join(tempDir, "tree.json"));
		await tracker2.load();

		expect(tracker2.getTopLevel()).toHaveLength(1);
		expect(tracker2.getTopLevel()[0]?.status).toBe("in_progress");
		expect(tracker2.getChildren(parent.id)).toHaveLength(1);
	});

	test("allNodes returns flat list", () => {
		const parent = tracker.addTask("App", "desc");
		tracker.addChild(parent.id, "A", "a");
		tracker.addChild(parent.id, "B", "b");

		expect(tracker.allNodes()).toHaveLength(3);
	});

	test("orchestratorSessionId persists across save/load", async () => {
		tracker.addTask("App", "desc");
		tracker.orchestratorSessionId = "session-abc-123";
		await tracker.save();

		const tracker2 = new TaskTracker(join(tempDir, "tree.json"));
		await tracker2.load();

		expect(tracker2.orchestratorSessionId).toBe("session-abc-123");
	});

	test("orchestratorSessionId defaults to null", () => {
		expect(tracker.orchestratorSessionId).toBeNull();
	});

	test("get() supports short prefix matching (8+ chars)", () => {
		const task = tracker.addTask("Prefix test", "Test prefix matching");
		const shortId = task.id.slice(0, 8);
		expect(tracker.get(shortId)).toBe(task);
		// Too short (7 chars) should not match
		expect(tracker.get(task.id.slice(0, 7))).toBeUndefined();
		// Full ID still works
		expect(tracker.get(task.id)).toBe(task);
	});

	test("updateCost accumulates cost on a task node", () => {
		const task = tracker.addTask("Costly task", "desc");
		expect(task.costUsd).toBeUndefined();

		tracker.updateCost(task.id, 0.0123);
		expect(tracker.get(task.id)?.costUsd).toBeCloseTo(0.0123);

		tracker.updateCost(task.id, 0.0077);
		expect(tracker.get(task.id)?.costUsd).toBeCloseTo(0.02);
	});

	test("updateCost does nothing for unknown nodeId", () => {
		// Should not throw
		tracker.updateCost("nonexistent-id-12345678", 1.0);
	});

	test("updateCost persists across save/load", async () => {
		const task = tracker.addTask("Persist cost", "desc");
		tracker.updateCost(task.id, 0.0456);
		await tracker.save();

		const tracker2 = new TaskTracker(join(tempDir, "tree.json"));
		await tracker2.load();
		expect(tracker2.get(task.id)?.costUsd).toBeCloseTo(0.0456);
	});

	test("get() returns undefined for ambiguous prefix", () => {
		const task1 = tracker.addTask("Task A", "First");
		const task2 = tracker.addTask("Task B", "Second");
		// Using a 1-char prefix (too short) returns undefined
		expect(tracker.get(task1.id.slice(0, 1))).toBeUndefined();
		// Full IDs still work
		expect(tracker.get(task1.id)).toBe(task1);
		expect(tracker.get(task2.id)).toBe(task2);
	});

	test("addTask accepts budgetUsd option", () => {
		const task = tracker.addTask("Budgeted task", "desc", {
			budgetUsd: 0.5,
		});
		expect(task.budgetUsd).toBe(0.5);
	});

	test("addChild accepts budgetUsd option", () => {
		const parent = tracker.addTask("Parent", "desc");
		const child = tracker.addChild(parent.id, "Child", "desc", {
			budgetUsd: 1.25,
		});
		expect(child.budgetUsd).toBe(1.25);
	});

	test("budgetUsd is undefined when not provided", () => {
		const task = tracker.addTask("No budget", "desc");
		expect(task.budgetUsd).toBeUndefined();
	});

	test("budgetUsd persists across save/load", async () => {
		const task = tracker.addTask("Budget persist", "desc", {
			budgetUsd: 2.0,
		});
		await tracker.save();

		const tracker2 = new TaskTracker(join(tempDir, "tree.json"));
		await tracker2.load();
		expect(tracker2.get(task.id)?.budgetUsd).toBe(2.0);
	});

	test("addTask accepts draft option", () => {
		const task = tracker.addTask("Draft task", "desc", { draft: true });
		expect(task.draft).toBe(true);
	});

	test("addChild accepts draft option", () => {
		const parent = tracker.addTask("Parent", "desc");
		const child = tracker.addChild(parent.id, "Child", "desc", {
			draft: true,
		});
		expect(child.draft).toBe(true);
	});

	test("draft is undefined when not provided", () => {
		const task = tracker.addTask("No draft", "desc");
		expect(task.draft).toBeUndefined();
	});

	test("updateDraft sets and unsets draft flag", () => {
		const task = tracker.addTask("Toggle draft", "desc");
		expect(task.draft).toBeUndefined();

		tracker.updateDraft(task.id, true);
		expect(tracker.get(task.id)?.draft).toBe(true);

		tracker.updateDraft(task.id, false);
		expect(tracker.get(task.id)?.draft).toBeUndefined();
	});

	test("draft persists across save/load", async () => {
		const task = tracker.addTask("Draft persist", "desc", { draft: true });
		await tracker.save();

		const tracker2 = new TaskTracker(join(tempDir, "tree.json"));
		await tracker2.load();
		expect(tracker2.get(task.id)?.draft).toBe(true);
	});

	test("ensureRootNode creates root node", () => {
		expect(tracker.rootNodeId).toBeNull();
		const root = tracker.ensureRootNode("Orchestrator", "Initial prompt");
		expect(root.title).toBe("Orchestrator");
		expect(root.parentId).toBeNull();
		expect(root.status).toBe("pending");
		expect(tracker.rootNodeId).toBe(root.id);
	});

	test("ensureRootNode returns existing root node on second call", () => {
		const root1 = tracker.ensureRootNode("Orchestrator", "prompt 1");
		const root2 = tracker.ensureRootNode("Orchestrator", "prompt 2");
		expect(root1.id).toBe(root2.id);
	});

	test("ensureRootNode re-parents existing top-level nodes", () => {
		const orphan1 = tracker.addTask("Task A", "desc a");
		const orphan2 = tracker.addTask("Task B", "desc b");
		expect(orphan1.parentId).toBeNull();
		expect(orphan2.parentId).toBeNull();

		const root = tracker.ensureRootNode("Orchestrator", "prompt");
		expect(orphan1.parentId).toBe(root.id);
		expect(orphan2.parentId).toBe(root.id);
		expect(root.children).toContain(orphan1.id);
		expect(root.children).toContain(orphan2.id);
		expect(tracker.getChildren(root.id)).toHaveLength(2);
		expect(tracker.getTopLevel()).toHaveLength(1); // only root
	});

	test("rootNodeId persists across save/load", async () => {
		const root = tracker.ensureRootNode("Orchestrator", "prompt");
		await tracker.save();

		const tracker2 = new TaskTracker(join(tempDir, "tree.json"));
		await tracker2.load();
		expect(tracker2.rootNodeId).toBe(root.id);
		expect(tracker2.get(root.id)?.title).toBe("Orchestrator");
	});

	test("ensureRootNode restores after load when rootNodeId is set", async () => {
		const root = tracker.ensureRootNode("Orchestrator", "prompt");
		tracker.addChild(root.id, "Child", "child desc");
		await tracker.save();

		const tracker2 = new TaskTracker(join(tempDir, "tree.json"));
		await tracker2.load();

		// Calling ensureRootNode again should return the same root
		const root2 = tracker2.ensureRootNode("Orchestrator", "new prompt");
		expect(root2.id).toBe(root.id);
		expect(tracker2.getChildren(root2.id)).toHaveLength(1);
	});

	test("reorderChildren reorders children of a parent", () => {
		const parent = tracker.addTask("App", "desc");
		const c1 = tracker.addChild(parent.id, "A", "a");
		const c2 = tracker.addChild(parent.id, "B", "b");
		const c3 = tracker.addChild(parent.id, "C", "c");

		expect(parent.children).toEqual([c1.id, c2.id, c3.id]);

		tracker.reorderChildren(parent.id, [c3.id, c1.id, c2.id]);
		expect(parent.children).toEqual([c3.id, c1.id, c2.id]);
	});

	test("reorderChildren throws for unknown parent", () => {
		expect(() => tracker.reorderChildren("nonexistent", [])).toThrow(
			"Parent node not found",
		);
	});

	test("reorderChildren throws for mismatched children", () => {
		const parent = tracker.addTask("App", "desc");
		const c1 = tracker.addChild(parent.id, "A", "a");
		tracker.addChild(parent.id, "B", "b");

		// Missing a child
		expect(() => tracker.reorderChildren(parent.id, [c1.id])).toThrow(
			"orderedChildIds must contain exactly the current children",
		);

		// Extra unknown child
		expect(() =>
			tracker.reorderChildren(parent.id, [c1.id, "unknown-id"]),
		).toThrow();

		// Duplicates
		expect(() => tracker.reorderChildren(parent.id, [c1.id, c1.id])).toThrow();
	});
});
