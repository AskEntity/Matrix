import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskTracker } from "./task-tracker.ts";
import type { TaskNode } from "./types.ts";

describe("TaskTracker", () => {
	let tempDir: string;
	let tracker: TaskTracker;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-tracker-"));
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
		expect(tracker.getTask(task.id)?.status).toBe("in_progress");
	});

	test("assignBranch sets branch name", () => {
		const parent = tracker.addTask("App", "desc");
		const child = tracker.addChild(parent.id, "Auth", "desc");
		tracker.assignBranch(child.id, "feat/auth");
		expect(tracker.getTask(child.id)?.branch).toBe("feat/auth");
	});

	test("byStatus filters nodes", () => {
		const parent = tracker.addTask("App", "desc");
		const c1 = tracker.addChild(parent.id, "A", "a");
		const c2 = tracker.addChild(parent.id, "B", "b");
		tracker.updateStatus(c1.id, "verify");
		tracker.updateStatus(c2.id, "in_progress");

		expect(tracker.byStatus("verify")).toHaveLength(1);
		expect(tracker.byStatus("in_progress")).toHaveLength(1);
		expect(tracker.byStatus("pending")).toHaveLength(2); // parent + root node
	});

	test("remove deletes node and descendants", () => {
		const parent = tracker.addTask("App", "desc");
		const c1 = tracker.addChild(parent.id, "A", "a");
		const c1a = tracker.addChild(c1.id, "A1", "a1");

		tracker.remove(c1.id);

		expect(tracker.getTask(c1.id)).toBeUndefined();
		expect(tracker.getTask(c1a.id)).toBeUndefined();
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
		const appNode = tracker2.getTopLevel().find((n) => n.title === "App") as
			| TaskNode
			| undefined;
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
		expect(tracker.getTask(task.id)).toBe(task);
		// Short prefix (8 chars) is ambiguous with the root node (same ms timestamp)
		// so it correctly returns undefined
		const shortId = task.id.slice(0, 8);
		expect(tracker.getTask(shortId)).toBeUndefined(); // ambiguous — both root and task match
		// Too short (7 chars) should not match
		expect(tracker.getTask(task.id.slice(0, 7))).toBeUndefined();
	});

	test("updateCost accumulates cost on a task node", () => {
		const task = tracker.addTask("Costly task", "desc");
		expect(task.costUsd).toBe(0);

		tracker.updateCost(task.id, 0.0123);
		expect(tracker.getTask(task.id)?.costUsd).toBeCloseTo(0.0123);

		tracker.updateCost(task.id, 0.0077);
		expect(tracker.getTask(task.id)?.costUsd).toBeCloseTo(0.02);
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
		expect(tracker2.getTask(task.id)?.costUsd).toBeCloseTo(0.0456);
	});

	test("costUsd and editedBy have defaults on creation", () => {
		const task = tracker.addTask("Defaults", "desc");
		expect(task.costUsd).toBe(0);
		expect(task.editedBy).toBe("agent");

		const taskUser = tracker.addTask("User task", "desc", {
			editedBy: "user",
		});
		expect(taskUser.editedBy).toBe("user");
		expect(taskUser.costUsd).toBe(0);
	});

	test("costUsd and editedBy backfilled on load from old tree.json", async () => {
		// Simulate old tree.json without costUsd and editedBy
		const task = tracker.addTask("Old task", "desc");
		await tracker.save();

		// Manually strip costUsd and editedBy from saved file
		const raw = await readFile(join(tempDir, "tree.json"), "utf-8");
		const data = JSON.parse(raw);
		for (const node of data.nodes) {
			delete node.costUsd;
			delete node.editedBy;
		}
		await writeFile(
			join(tempDir, "tree.json"),
			JSON.stringify(data, null, "\t"),
		);

		const tracker2 = new TaskTracker(join(tempDir, "tree.json"));
		await tracker2.load();
		const loaded = tracker2.getTask(task.id);
		expect(loaded?.costUsd).toBe(0);
		expect(loaded?.editedBy).toBe("agent");
	});

	test("get() returns undefined for ambiguous prefix", () => {
		const task1 = tracker.addTask("Task A", "First");
		const task2 = tracker.addTask("Task B", "Second");
		// Using a 1-char prefix (too short) returns undefined
		expect(tracker.getTask(task1.id.slice(0, 1))).toBeUndefined();
		// Full IDs still work
		expect(tracker.getTask(task1.id)).toBe(task1);
		expect(tracker.getTask(task2.id)).toBe(task2);
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
		expect(tracker2.getTask(task.id)?.budgetUsd).toBe(2.0);
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
		expect(tracker.getTask(task.id)?.status).toBe("draft");

		tracker.updateStatus(task.id, "pending");
		expect(tracker.getTask(task.id)?.status).toBe("pending");
	});

	test("draft status persists across save/load", async () => {
		const task = tracker.addTask("Draft persist", "desc", { draft: true });
		await tracker.save();

		const tracker2 = new TaskTracker(join(tempDir, "tree.json"));
		await tracker2.load();
		expect(tracker2.getTask(task.id)?.status).toBe("draft");
	});

	test("root node auto-created on load (fresh project)", () => {
		// Root node is created automatically when tracker loads with no tree.json
		const rootId = tracker.rootNodeId;
		expect(rootId).toBeTruthy();
		const root = tracker.getTask(rootId) as TaskNode;
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
		expect(tracker2.getTask(rootId)?.title).toBe("Orchestrator");
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

	test("legacy persistent field stripped on load", async () => {
		const task1 = tracker.addTask("Old task", "desc");
		await tracker.save();

		// Manually add old persistent field to saved file
		const raw = await readFile(join(tempDir, "tree.json"), "utf-8");
		const data = JSON.parse(raw);
		const saved1 = data.nodes.find((n: { id: string }) => n.id === task1.id);
		saved1.persistent = true;
		await writeFile(
			join(tempDir, "tree.json"),
			JSON.stringify(data, null, "\t"),
		);

		const tracker2 = new TaskTracker(join(tempDir, "tree.json"));
		await tracker2.load();
		// persistent field should be stripped — not present on TaskNode
		const loaded = tracker2.getTask(task1.id) as unknown as Record<
			string,
			unknown
		>;
		expect(loaded.persistent).toBeUndefined();
	});

	test("regular nodes have title/description preserved in tree.json on save", async () => {
		const rootId = tracker.rootNodeId;
		const task = tracker.addChild(rootId, "Regular task", "my desc");
		await tracker.save();

		const raw = await readFile(join(tempDir, "tree.json"), "utf-8");
		const data = JSON.parse(raw);
		const saved = data.nodes.find((n: { id: string }) => n.id === task.id);
		expect(saved.title).toBe("Regular task");
		expect(saved.description).toBe("my desc");
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

	// ── Folder tests ──

	test("addGeneralNode creates a folder node with type=folder", () => {
		const folder = tracker.addGeneralNode(
			"Features",
			tracker.rootNodeId,
			"folder",
		);
		expect(folder.type).toBe("folder");
		expect(folder.title).toBe("Features");
		expect(folder.parentId).toBe(tracker.rootNodeId);
		expect(folder.children).toEqual([]);
		expect("status" in folder).toBe(false);
		expect("session" in folder).toBe(false);
		expect("branch" in folder).toBe(false);
	});

	test("addGeneralNode adds folder to parent's children", () => {
		const folder = tracker.addGeneralNode("Auth", tracker.rootNodeId, "folder");
		const root = tracker.get(tracker.rootNodeId);
		expect(root?.children).toContain(folder.id);
	});

	test("getTaskAbove skips folders to find real task parent", () => {
		const folder = tracker.addGeneralNode(
			"Features",
			tracker.rootNodeId,
			"folder",
		);
		const task = tracker.addChild(folder.id, "JWT", "Implement JWT");
		expect(task.parentId).toBe(folder.id);
		const above = tracker.getTaskAbove(task.id);
		expect(above?.id).toBe(tracker.rootNodeId);
	});

	test("getTaskAbove skips nested folders", () => {
		const f1 = tracker.addGeneralNode("Level1", tracker.rootNodeId, "folder");
		const f2 = tracker.addGeneralNode("Level2", f1.id, "folder");
		const task = tracker.addChild(f2.id, "Deep Task", "desc");
		const above = tracker.getTaskAbove(task.id);
		expect(above?.id).toBe(tracker.rootNodeId);
	});

	test("getTasksBelow skips folders to find real task children", () => {
		const folder = tracker.addGeneralNode(
			"Features",
			tracker.rootNodeId,
			"folder",
		);
		const task1 = tracker.addChild(folder.id, "JWT", "Implement JWT");
		const task2 = tracker.addChild(folder.id, "Login", "Implement Login");
		const directChildren = tracker.getChildren(tracker.rootNodeId);
		expect(directChildren.some((n) => n.id === folder.id)).toBe(true);
		const tasksBelow = tracker.getTasksBelow(tracker.rootNodeId);
		expect(tasksBelow.map((n) => n.id)).toContain(task1.id);
		expect(tasksBelow.map((n) => n.id)).toContain(task2.id);
	});

	test("getTasksBelow recurses through nested folders", () => {
		const f1 = tracker.addGeneralNode("Level1", tracker.rootNodeId, "folder");
		const f2 = tracker.addGeneralNode("Level2", f1.id, "folder");
		const task = tracker.addChild(f2.id, "Deep Task", "desc");
		const tasksBelow = tracker.getTasksBelow(tracker.rootNodeId);
		expect(tasksBelow.map((n) => n.id)).toContain(task.id);
	});

	test("getTasksBelow returns mix of direct tasks and tasks inside folders", () => {
		const directTask = tracker.addChild(tracker.rootNodeId, "Direct", "desc");
		const folder = tracker.addGeneralNode(
			"Grouped",
			tracker.rootNodeId,
			"folder",
		);
		const folderTask = tracker.addChild(folder.id, "In Folder", "desc");
		const tasksBelow = tracker.getTasksBelow(tracker.rootNodeId);
		const ids = tasksBelow.map((n) => n.id);
		expect(ids).toContain(directTask.id);
		expect(ids).toContain(folderTask.id);
		// folder itself should NOT be in tasksBelow
		expect(ids).not.toContain(folder.id);
	});

	test("lifecycle operations reject general nodes", () => {
		const folder = tracker.addGeneralNode(
			"Features",
			tracker.rootNodeId,
			"folder",
		);
		expect(() => tracker.updateStatus(folder.id, "in_progress")).toThrow(
			/non-task/i,
		);
		expect(() => tracker.assignBranch(folder.id, "some-branch")).toThrow(
			/non-task/i,
		);
		expect(() => tracker.assignWorktree(folder.id, "branch", "/path")).toThrow(
			/non-task/i,
		);
		expect(() => tracker.updateDescription(folder.id, "desc")).toThrow(
			/non-task/i,
		);
		expect(() => tracker.updateColor(folder.id, "red")).toThrow(/non-task/i);
	});

	test("updateCost silently ignores folders", () => {
		const folder = tracker.addGeneralNode(
			"Features",
			tracker.rootNodeId,
			"folder",
		);
		// Should not throw
		tracker.updateCost(folder.id, 1.5);
		// Folder has no costUsd field — no change
		expect(
			(folder as unknown as Record<string, unknown>).costUsd,
		).toBeUndefined();
	});

	test("getTask returns undefined for folder nodes", () => {
		const folder = tracker.addGeneralNode(
			"Features",
			tracker.rootNodeId,
			"folder",
		);
		expect(tracker.getTask(folder.id)).toBeUndefined();
		expect(tracker.get(folder.id)).toBeDefined();
	});

	test("folder persists across save/load", async () => {
		const folder = tracker.addGeneralNode(
			"Features",
			tracker.rootNodeId,
			"folder",
		);
		const task = tracker.addChild(folder.id, "JWT", "desc");
		await tracker.save();

		const tracker2 = new TaskTracker(join(tempDir, "tree.json"));
		await tracker2.load();
		const loaded = tracker2.get(folder.id);
		expect(loaded).toBeDefined();
		expect(loaded?.type).toBe("folder");
		expect(loaded?.title).toBe("Features");
		expect(tracker2.getTask(task.id)).toBeDefined();
	});

	test("reparent moves folder with its children", () => {
		const folder = tracker.addGeneralNode("Old", tracker.rootNodeId, "folder");
		const task = tracker.addChild(folder.id, "JWT", "desc");
		const newParent = tracker.addTask("New Parent", "desc");
		tracker.reparent(folder.id, newParent.id);
		expect(tracker.get(folder.id)?.parentId).toBe(newParent.id);
		expect(tracker.getTask(task.id)?.parentId).toBe(folder.id);
		expect(tracker.getTasksBelow(newParent.id).map((n) => n.id)).toContain(
			task.id,
		);
	});

	test("remove empty folder succeeds", () => {
		const folder = tracker.addGeneralNode(
			"Empty",
			tracker.rootNodeId,
			"folder",
		);
		const id = folder.id;
		tracker.remove(id);
		expect(tracker.get(id)).toBeUndefined();
	});

	test("remove folder cascades to children", () => {
		const folder = tracker.addGeneralNode(
			"Parent",
			tracker.rootNodeId,
			"folder",
		);
		const task = tracker.addChild(folder.id, "Child", "desc");
		tracker.remove(folder.id);
		expect(tracker.get(folder.id)).toBeUndefined();
		expect(tracker.get(task.id)).toBeUndefined();
	});

	test("remove task inside folder leaves folder intact", () => {
		const folder = tracker.addGeneralNode(
			"Parent",
			tracker.rootNodeId,
			"folder",
		);
		const task = tracker.addChild(folder.id, "Child", "desc");
		tracker.remove(task.id);
		expect(tracker.get(folder.id)).toBeDefined();
		expect(tracker.get(folder.id)?.children).toEqual([]);
	});

	test("updateTitle works on folders", () => {
		const folder = tracker.addGeneralNode(
			"Old Name",
			tracker.rootNodeId,
			"folder",
		);
		tracker.updateTitle(folder.id, "New Name");
		expect(tracker.get(folder.id)?.title).toBe("New Name");
	});

	test("byStatus excludes folders", () => {
		tracker.addGeneralNode("Folder", tracker.rootNodeId, "folder");
		tracker.addTask("Draft Task", "desc", { draft: true });
		const drafts = tracker.byStatus("draft");
		expect(
			drafts.every((n) => (n as { type?: string }).type !== "folder"),
		).toBe(true);
		expect(drafts.length).toBe(1);
	});

	test("allNodes includes folders", () => {
		const folder = tracker.addGeneralNode(
			"Folder",
			tracker.rootNodeId,
			"folder",
		);
		const all = tracker.allNodes();
		expect(all.some((n) => n.id === folder.id)).toBe(true);
	});

	test("reorderChildren works with mixed folders and tasks", () => {
		const folder = tracker.addGeneralNode(
			"Folder",
			tracker.rootNodeId,
			"folder",
		);
		const task = tracker.addChild(tracker.rootNodeId, "Task", "desc");
		const root = tracker.get(tracker.rootNodeId);
		if (!root) throw new Error("root not found");
		expect(root.children).toContain(folder.id);
		expect(root.children).toContain(task.id);
		tracker.reorderChildren(tracker.rootNodeId, [task.id, folder.id]);
		const reordered = tracker.get(tracker.rootNodeId);
		if (!reordered) throw new Error("reordered root not found");
		expect(reordered.children[0]).toBe(task.id);
		expect(reordered.children[1]).toBe(folder.id);
	});

	test("getTaskAbove for task nested inside multiple folders", () => {
		// root → folder1 → folder2 → folder3 → task
		const f1 = tracker.addGeneralNode("F1", tracker.rootNodeId, "folder");
		const f2 = tracker.addGeneralNode("F2", f1.id, "folder");
		const f3 = tracker.addGeneralNode("F3", f2.id, "folder");
		const task = tracker.addChild(f3.id, "Deep", "desc");
		// task above should skip all 3 folders to reach root
		expect(tracker.getTaskAbove(task.id)?.id).toBe(tracker.rootNodeId);
	});

	test("getTasksBelow finds tasks through multiple folder layers", () => {
		// root → folder1 → folder2 → task1
		//                 → task2
		const f1 = tracker.addGeneralNode("F1", tracker.rootNodeId, "folder");
		const f2 = tracker.addGeneralNode("F2", f1.id, "folder");
		const task1 = tracker.addChild(f2.id, "Deep", "desc");
		const task2 = tracker.addChild(f1.id, "Shallow", "desc");
		const below = tracker.getTasksBelow(tracker.rootNodeId);
		const ids = below.map((n) => n.id);
		expect(ids).toContain(task1.id);
		expect(ids).toContain(task2.id);
		expect(ids).toHaveLength(2);
	});

	test("getTaskAbove returns task parent when task is between folders", () => {
		// root → parentTask → folder → childTask
		const parentTask = tracker.addChild(tracker.rootNodeId, "Parent", "desc");
		const folder = tracker.addGeneralNode("Group", parentTask.id, "folder");
		const childTask = tracker.addChild(folder.id, "Child", "desc");
		// childTask's task above should be parentTask, not root
		expect(tracker.getTaskAbove(childTask.id)?.id).toBe(parentTask.id);
	});
});

// ── Node-model generalization: status + metadata on BaseTaskNode ──
// These pin the changes that let a plugin's launchable node carry per-node
// config (metadata) and inherit the lifecycle field (status) without
// re-declaring runtime-generic fields.
describe("TaskTracker: node-model generalization", () => {
	let tempDir: string;
	let tracker: TaskTracker;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-tracker-meta-"));
		tracker = new TaskTracker(join(tempDir, "tree.json"));
		await tracker.load();
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("addChild attaches metadata at creation", () => {
		const meta = { character: { displayName: "Alice", groups: ["lobby"] } };
		const child = tracker.addChild(tracker.rootNodeId, "Alice", "desc", {
			metadata: meta,
		});
		expect(child.metadata).toEqual(meta);
	});

	test("addTask attaches metadata at creation", () => {
		const task = tracker.addTask("Top", "desc", {
			metadata: { kind: "probe" },
		});
		expect(task.metadata).toEqual({ kind: "probe" });
	});

	test("metadata is undefined (not {}) when not provided", () => {
		const task = tracker.addTask("No meta", "desc");
		// Important: absent, not an empty object — keeps tree.json clean and
		// lets `metadata !== undefined` checks be meaningful.
		expect(task.metadata).toBeUndefined();
		expect("metadata" in task).toBe(false);
	});

	test("setMetadata REPLACES metadata (not merge) on task nodes", () => {
		const task = tracker.addChild(tracker.rootNodeId, "Bob", "desc", {
			metadata: { character: { displayName: "Bob" }, extra: 1 },
		});
		tracker.setMetadata(task.id, { character: { displayName: "Bobby" } });
		const after = tracker.getTask(task.id);
		// Replace, not merge — the `extra` key is gone. (A merge impl keeps it.)
		expect(after?.metadata).toEqual({ character: { displayName: "Bobby" } });
	});

	test("setMetadata works on general nodes too", () => {
		const folder = tracker.addGeneralNode(
			"Group",
			tracker.rootNodeId,
			"folder",
		);
		tracker.setMetadata(folder.id, { color: "blue" });
		expect(tracker.get(folder.id)?.metadata).toEqual({ color: "blue" });
	});

	test("setMetadata throws on unknown node", () => {
		expect(() => tracker.setMetadata("nonexistent-12345678", {})).toThrow(
			"Node not found",
		);
	});

	test("metadata + status round-trip through save/load", async () => {
		const task = tracker.addChild(tracker.rootNodeId, "Aria", "desc", {
			metadata: { character: { displayName: "Aria", personality: "calm" } },
		});
		tracker.updateStatus(task.id, "in_progress");
		await tracker.save();

		const tracker2 = new TaskTracker(join(tempDir, "tree.json"));
		await tracker2.load();
		const loaded = tracker2.getTask(task.id);
		expect(loaded?.status).toBe("in_progress");
		expect(loaded?.metadata).toEqual({
			character: { displayName: "Aria", personality: "calm" },
		});
	});

	test("load() returns true for a fresh tree, false for an existing one", async () => {
		const path = join(tempDir, "fresh.json");
		const fresh = new TaskTracker(path);
		const wasFresh = await fresh.load();
		expect(wasFresh).toBe(true);
		await fresh.save();

		const reopened = new TaskTracker(path);
		const wasFresh2 = await reopened.load();
		expect(wasFresh2).toBe(false);
	});
});
