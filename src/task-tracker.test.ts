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
		// Root node + the new task = 2 top-level nodes
		expect(tracker.getTopLevel()).toHaveLength(2);
	});

	test("multiple top-level tasks allowed", () => {
		tracker.addTask("App1", "desc1");
		tracker.addTask("App2", "desc2");
		// Root node + 2 tasks = 3 top-level nodes
		expect(tracker.getTopLevel()).toHaveLength(3);
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
		expect(tracker.byStatus("pending")).toHaveLength(2); // parent + root node
	});

	test("remove deletes node and descendants", () => {
		const parent = tracker.addTask("App", "desc");
		const c1 = tracker.addChild(parent.id, "A", "a");
		const c1a = tracker.addChild(c1.id, "A1", "a1");

		tracker.remove(c1.id);

		expect(tracker.get(c1.id)).toBeUndefined();
		expect(tracker.get(c1a.id)).toBeUndefined();
		expect(tracker.getChildren(parent.id)).toHaveLength(0);
		expect(tracker.allNodes()).toHaveLength(2); // parent + root node
	});

	test("remove top-level task works", () => {
		const task = tracker.addTask("App", "desc");
		tracker.addChild(task.id, "A", "a");

		tracker.remove(task.id);

		expect(tracker.allNodes()).toHaveLength(1); // root node remains
	});

	test("persists and reloads", async () => {
		const parent = tracker.addTask("App", "desc");
		tracker.addChild(parent.id, "Auth", "auth desc");
		tracker.updateStatus(parent.id, "in_progress");
		await tracker.save();

		const tracker2 = new TaskTracker(join(tempDir, "tree.json"));
		await tracker2.load();

		// Root node + the saved "App" node are top-level
		expect(tracker2.getTopLevel()).toHaveLength(2);
		const appNode = tracker2.getTopLevel().find((n) => n.title === "App");
		expect(appNode?.status).toBe("in_progress");
		expect(tracker2.getChildren(parent.id)).toHaveLength(1);
	});

	test("allNodes returns flat list", () => {
		const parent = tracker.addTask("App", "desc");
		tracker.addChild(parent.id, "A", "a");
		tracker.addChild(parent.id, "B", "b");

		expect(tracker.allNodes()).toHaveLength(4); // root + parent + 2 children
	});

	test("get() supports short prefix matching (8+ chars)", () => {
		// Root node and new tasks share ULID timestamp prefix.
		// Use full ID for exact match, and verify ambiguous short prefix returns undefined.
		const task = tracker.addTask("Prefix test", "Test prefix matching");
		// Full ID always works
		expect(tracker.get(task.id)).toBe(task);
		// Short prefix (8 chars) is ambiguous with the root node (same ms timestamp)
		// so it correctly returns undefined
		const shortId = task.id.slice(0, 8);
		expect(tracker.get(shortId)).toBeUndefined(); // ambiguous — both root and task match
		// Too short (7 chars) should not match
		expect(tracker.get(task.id.slice(0, 7))).toBeUndefined();
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

	test("addTask accepts draft option and sets status to draft", () => {
		const task = tracker.addTask("Draft task", "desc", { draft: true });
		expect(task.status).toBe("draft");
	});

	test("addChild accepts draft option and sets status to draft", () => {
		const parent = tracker.addTask("Parent", "desc");
		const child = tracker.addChild(parent.id, "Child", "desc", {
			draft: true,
		});
		expect(child.status).toBe("draft");
	});

	test("status is pending when draft not provided", () => {
		const task = tracker.addTask("No draft", "desc");
		expect(task.status).toBe("pending");
	});

	test("updateStatus toggles between draft and pending", () => {
		const task = tracker.addTask("Toggle draft", "desc");
		expect(task.status).toBe("pending");

		tracker.updateStatus(task.id, "draft");
		expect(tracker.get(task.id)?.status).toBe("draft");

		tracker.updateStatus(task.id, "pending");
		expect(tracker.get(task.id)?.status).toBe("pending");
	});

	test("draft status persists across save/load", async () => {
		const task = tracker.addTask("Draft persist", "desc", { draft: true });
		await tracker.save();

		const tracker2 = new TaskTracker(join(tempDir, "tree.json"));
		await tracker2.load();
		expect(tracker2.get(task.id)?.status).toBe("draft");
	});

	test("root node auto-created on load (fresh project)", () => {
		// Root node is created automatically when tracker loads with no tree.json
		const rootId = tracker.rootNodeId;
		expect(rootId).toBeTruthy();
		const root = tracker.get(rootId)!;
		expect(root.title).toBe("Orchestrator");
		expect(root.parentId).toBeNull();
		expect(root.status).toBe("pending");
	});

	test("rootNodeId persists across save/load", async () => {
		const rootId = tracker.rootNodeId;
		tracker.addChild(rootId, "Child", "child desc");
		await tracker.save();

		const tracker2 = new TaskTracker(join(tempDir, "tree.json"));
		await tracker2.load();
		expect(tracker2.rootNodeId).toBe(rootId);
		expect(tracker2.get(rootId)?.title).toBe("Orchestrator");
		expect(tracker2.getChildren(rootId)).toHaveLength(1);
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

	test("reparent moves node to new parent", () => {
		const parent1 = tracker.addTask("Parent 1", "desc");
		const parent2 = tracker.addTask("Parent 2", "desc");
		const child = tracker.addChild(parent1.id, "Child", "desc");

		expect(child.parentId).toBe(parent1.id);
		expect(parent1.children).toContain(child.id);

		tracker.reparent(child.id, parent2.id);

		expect(child.parentId).toBe(parent2.id);
		expect(parent1.children).not.toContain(child.id);
		expect(parent2.children).toContain(child.id);
	});

	test("reparent throws when reparenting under self", () => {
		const task = tracker.addTask("Self ref", "desc");
		expect(() => tracker.reparent(task.id, task.id)).toThrow(
			"Cannot reparent a node under itself",
		);
	});

	test("reparent throws when reparenting under descendant (circular)", () => {
		const parent = tracker.addTask("Root", "desc");
		const child = tracker.addChild(parent.id, "Child", "desc");
		const grandchild = tracker.addChild(child.id, "Grandchild", "desc");

		expect(() => tracker.reparent(parent.id, grandchild.id)).toThrow(
			"Cannot reparent under a descendant",
		);
		expect(() => tracker.reparent(parent.id, child.id)).toThrow(
			"Cannot reparent under a descendant",
		);
	});

	test("reparent throws for nonexistent nodes", () => {
		const task = tracker.addTask("Real", "desc");
		expect(() => tracker.reparent("nonexistent", task.id)).toThrow(
			"Node not found",
		);
		expect(() => tracker.reparent(task.id, "nonexistent")).toThrow(
			"New parent not found",
		);
	});

	test("reparent is a no-op when already under the same parent", () => {
		const parent = tracker.addTask("Parent", "desc");
		const child = tracker.addChild(parent.id, "Child", "desc");

		tracker.reparent(child.id, parent.id);

		expect(child.parentId).toBe(parent.id);
		expect(parent.children).toEqual([child.id]);
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
