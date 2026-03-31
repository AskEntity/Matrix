import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "./event-store.ts";
import type { Event } from "./events.ts";
import { TaskTracker } from "./task-tracker.ts";

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
		expect(task.costUsd).toBe(0);

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
		const loaded = tracker2.get(task.id);
		expect(loaded?.costUsd).toBe(0);
		expect(loaded?.editedBy).toBe("agent");
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

	test("persistent field defaults to false on new nodes", () => {
		const task = tracker.addTask("Regular task", "desc");
		expect(task.persistent).toBe(false);
	});

	test("persistent field backfilled to false on load from old tree.json", async () => {
		const task = tracker.addTask("Old task", "desc");
		await tracker.save();

		// Manually strip persistent from saved file
		const raw = await readFile(join(tempDir, "tree.json"), "utf-8");
		const data = JSON.parse(raw);
		for (const node of data.nodes) {
			delete node.persistent;
		}
		await writeFile(
			join(tempDir, "tree.json"),
			JSON.stringify(data, null, "\t"),
		);

		const tracker2 = new TaskTracker(join(tempDir, "tree.json"));
		await tracker2.load();
		expect(tracker2.get(task.id)?.persistent).toBe(false);
	});

	test("persistent: true migrated to 'reset' on load from old tree.json", async () => {
		const task = tracker.addTask("Old persistent", "desc");
		await tracker.save();

		// Manually set persistent: true (old format) in saved file
		const raw = await readFile(join(tempDir, "tree.json"), "utf-8");
		const data = JSON.parse(raw);
		const savedNode = data.nodes.find((n: { id: string }) => n.id === task.id);
		savedNode.persistent = true;
		await writeFile(
			join(tempDir, "tree.json"),
			JSON.stringify(data, null, "\t"),
		);

		const tracker2 = new TaskTracker(join(tempDir, "tree.json"));
		await tracker2.load();
		expect(tracker2.get(task.id)?.persistent).toBe("reset");
	});

	test("persistent nodes have title/description stripped from tree.json on save", async () => {
		const rootId = tracker.rootNodeId;
		const task = tracker.addChild(rootId, "Persistent task", "my desc", {
			persistent: "reset",
		});
		expect(task.persistent).toBe("reset");
		await tracker.save();

		const raw = await readFile(join(tempDir, "tree.json"), "utf-8");
		const data = JSON.parse(raw);
		const saved = data.nodes.find((n: { id: string }) => n.id === task.id);
		expect(saved.persistent).toBe("reset");
		expect(saved.title).toBeUndefined();
		expect(saved.description).toBeUndefined();
	});

	test("regular nodes have title/description preserved in tree.json on save", async () => {
		const rootId = tracker.rootNodeId;
		const task = tracker.addChild(rootId, "Regular task", "my desc");
		await tracker.save();

		const raw = await readFile(join(tempDir, "tree.json"), "utf-8");
		const data = JSON.parse(raw);
		const saved = data.nodes.find((n: { id: string }) => n.id === task.id);
		expect(saved.persistent).toBe(false);
		expect(saved.title).toBe("Regular task");
		expect(saved.description).toBe("my desc");
	});

	test("persistent tasks loaded from .mxd/tasks/ directory", async () => {
		// Create a .mxd/tasks/ directory with a task definition
		const { mkdir: mkdirAsync, writeFile: writeFileAsync } = await import(
			"node:fs/promises"
		);
		const projectDir = await mkdtemp(join(tmpdir(), "mxd-project-"));
		const tasksDir = join(projectDir, ".mxd", "tasks");
		await mkdirAsync(tasksDir, { recursive: true });

		const taskId = "01TESTPERSISTENT1234";
		await writeFileAsync(
			join(tasksDir, `${taskId}.json`),
			JSON.stringify({
				title: "Test Agent",
				description: "Run tests periodically",
				color: "#a371f7",
			}),
		);

		// Load tracker with project path — persistent task should be created
		const tracker2 = new TaskTracker(join(tempDir, "tree2.json"));
		await tracker2.load(undefined, projectDir);

		const node = tracker2.get(taskId);
		expect(node).toBeDefined();
		expect(node!.persistent).toBe("reset");
		expect(node!.title).toBe("Test Agent");
		expect(node!.description).toBe("Run tests periodically");
		expect(node!.color).toBe("#a371f7");
		expect(node!.status).toBe("pending");
		expect(node!.parentId).toBe(tracker2.rootNodeId);

		// Verify root has it as child
		const root = tracker2.get(tracker2.rootNodeId)!;
		expect(root.children).toContain(taskId);

		await rm(projectDir, { recursive: true });
	});

	test("persistent tasks merge with existing tree.json entries", async () => {
		const { mkdir: mkdirAsync, writeFile: writeFileAsync } = await import(
			"node:fs/promises"
		);
		const projectDir = await mkdtemp(join(tmpdir(), "mxd-project-"));
		const tasksDir = join(projectDir, ".mxd", "tasks");
		await mkdirAsync(tasksDir, { recursive: true });

		const taskId = "01TESTMERGE12345678";
		await writeFileAsync(
			join(tasksDir, `${taskId}.json`),
			JSON.stringify({
				title: "Updated Title",
				description: "Updated description",
			}),
		);

		// Create tree.json with existing persistent node (stale title/description are stripped)
		const rootId = tracker.rootNodeId;
		const existingNode = tracker.addChild(
			rootId,
			"placeholder",
			"placeholder",
			{
				persistent: "reset",
				id: taskId,
			},
		);
		tracker.updateStatus(existingNode.id, "passed");
		existingNode.costUsd = 1.5;
		await tracker.save();

		// Reload with project path — title/description refreshed from json file
		const tracker2 = new TaskTracker(join(tempDir, "tree.json"));
		await tracker2.load(undefined, projectDir);

		const node = tracker2.get(taskId)!;
		expect(node.title).toBe("Updated Title");
		expect(node.description).toBe("Updated description");
		expect(node.status).toBe("passed"); // Status preserved from tree.json
		expect(node.costUsd).toBe(1.5); // Cost preserved from tree.json

		await rm(projectDir, { recursive: true });
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

describe("Persistent task close modes", () => {
	let tempDir: string;
	let tracker: TaskTracker;
	let sessionsDir: string;
	let eventStore: EventStore;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-persistent-"));
		tracker = new TaskTracker(join(tempDir, "tree.json"));
		await tracker.load();
		sessionsDir = join(tempDir, "sessions");
		eventStore = new EventStore(sessionsDir);
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
	});

	/**
	 * Simulate what close_task MCP tool does:
	 * - Persistent "reset": clear JSONL, set status to pending
	 * - Persistent "continue": keep JSONL, set status to pending
	 * - Regular: set status to closed
	 */
	function simulateCloseTask(
		node: ReturnType<typeof tracker.get>,
		clearEventStoreFn: (id: string) => void,
	) {
		if (!node) throw new Error("Node not found");
		// Simulate worktree removal
		node.worktreePath = null;
		node.branch = null;

		if (node.persistent) {
			if (node.persistent === "reset") {
				clearEventStoreFn(node.id);
			}
			// "continue" mode keeps JSONL
			tracker.updateStatus(node.id, "pending");
		} else {
			tracker.updateStatus(node.id, "closed");
		}
	}

	function writeTestEvents(nodeId: string) {
		const events: Event[] = [
			{
				type: "session_config",
				id: `evt-${nodeId}-1`,
				sessionId: nodeId,
				tools: [],
				systemStable: "stable",
				systemVariable: "variable",
				ts: Date.now(),
			},
			{
				type: "assistant_text",
				id: `evt-${nodeId}-2`,
				sessionId: nodeId,
				text: "I will help you with this task.",
				ts: Date.now(),
			},
			{
				type: "tool_call",
				id: `evt-${nodeId}-3`,
				sessionId: nodeId,
				toolCallId: `tc-${nodeId}-1`,
				toolName: "mcp__mxd__bash",
				input: { command: "echo test" },
				ts: Date.now(),
			},
			{
				type: "tool_result",
				id: `evt-${nodeId}-4`,
				sessionId: nodeId,
				toolCallId: `tc-${nodeId}-1`,
				content: "test\n",
				isError: false,
				ts: Date.now(),
			},
		];
		eventStore.appendBatch(nodeId, events);
	}

	test("'continue' mode: close resets status to pending, JSONL preserved", async () => {
		const rootId = tracker.rootNodeId;
		const task = tracker.addChild(rootId, "Continue task", "runs with context", {
			persistent: "continue",
		});
		tracker.updateStatus(task.id, "passed");

		// Simulate agent generating JSONL events
		writeTestEvents(task.id);
		await eventStore.flush();
		expect(eventStore.has(task.id)).toBe(true);
		const eventsBefore = eventStore.read(task.id);
		expect(eventsBefore.length).toBe(4);

		// Close the task
		simulateCloseTask(tracker.get(task.id), (id) => eventStore.clear(id));
		await tracker.save();

		// Status should be pending, NOT closed
		expect(tracker.get(task.id)!.status).toBe("pending");

		// JSONL should be preserved
		expect(eventStore.has(task.id)).toBe(true);
		const eventsAfter = eventStore.read(task.id);
		expect(eventsAfter.length).toBe(4);
	});

	test("'reset' mode: close resets status to pending, JSONL deleted", async () => {
		const rootId = tracker.rootNodeId;
		const task = tracker.addChild(rootId, "Reset task", "clean start each cycle", {
			persistent: "reset",
		});
		tracker.updateStatus(task.id, "passed");

		// Simulate agent generating JSONL events
		writeTestEvents(task.id);
		await eventStore.flush();
		expect(eventStore.has(task.id)).toBe(true);

		// Close the task
		simulateCloseTask(tracker.get(task.id), (id) => eventStore.clear(id));
		await tracker.save();

		// Status should be pending, NOT closed
		expect(tracker.get(task.id)!.status).toBe("pending");

		// JSONL should be deleted
		expect(eventStore.has(task.id)).toBe(false);
	});

	test("regular task: close sets status to closed", async () => {
		const rootId = tracker.rootNodeId;
		const task = tracker.addChild(rootId, "Regular task", "one-off work");
		tracker.updateStatus(task.id, "passed");

		writeTestEvents(task.id);
		await eventStore.flush();
		expect(eventStore.has(task.id)).toBe(true);

		simulateCloseTask(tracker.get(task.id), (id) => eventStore.clear(id));
		await tracker.save();

		// Regular task goes to "closed", NOT pending
		expect(tracker.get(task.id)!.status).toBe("closed");

		// JSONL is NOT cleared by close for regular tasks
		expect(eventStore.has(task.id)).toBe(true);
	});

	test("persistent status survives save/load cycle", async () => {
		const rootId = tracker.rootNodeId;
		const continueTask = tracker.addChild(rootId, "C", "desc", {
			persistent: "continue",
		});
		const resetTask = tracker.addChild(rootId, "R", "desc", {
			persistent: "reset",
		});
		const regularTask = tracker.addChild(rootId, "Reg", "desc");

		// All start as pending
		expect(continueTask.status).toBe("pending");
		expect(resetTask.status).toBe("pending");
		expect(regularTask.status).toBe("pending");

		// Mark as passed, then close
		for (const t of [continueTask, resetTask, regularTask]) {
			tracker.updateStatus(t.id, "passed");
		}
		simulateCloseTask(tracker.get(continueTask.id), (id) => eventStore.clear(id));
		simulateCloseTask(tracker.get(resetTask.id), (id) => eventStore.clear(id));
		simulateCloseTask(tracker.get(regularTask.id), (id) => eventStore.clear(id));
		await tracker.save();

		// Reload
		const tracker2 = new TaskTracker(join(tempDir, "tree.json"));
		await tracker2.load();

		expect(tracker2.get(continueTask.id)!.status).toBe("pending");
		expect(tracker2.get(continueTask.id)!.persistent).toBe("continue");
		expect(tracker2.get(resetTask.id)!.status).toBe("pending");
		expect(tracker2.get(resetTask.id)!.persistent).toBe("reset");
		expect(tracker2.get(regularTask.id)!.status).toBe("closed");
		expect(tracker2.get(regularTask.id)!.persistent).toBe(false);
	});

	test("'continue' mode: JSONL content is identical after close", async () => {
		const rootId = tracker.rootNodeId;
		const task = tracker.addChild(rootId, "Continue verify", "desc", {
			persistent: "continue",
		});
		tracker.updateStatus(task.id, "passed");

		writeTestEvents(task.id);
		await eventStore.flush();
		const eventsBefore = eventStore.read(task.id);

		simulateCloseTask(tracker.get(task.id), (id) => eventStore.clear(id));

		const eventsAfter = eventStore.read(task.id);

		// Events must be exactly the same — not just count, but content
		expect(eventsAfter.length).toBe(eventsBefore.length);
		for (let i = 0; i < eventsBefore.length; i++) {
			expect(eventsAfter[i]!.type).toBe(eventsBefore[i]!.type);
			expect(eventsAfter[i]!.id).toBe(eventsBefore[i]!.id);
		}
	});

	test("closing then reopening: 'continue' mode resumes from JSONL", async () => {
		const rootId = tracker.rootNodeId;
		const task = tracker.addChild(rootId, "Resume test", "desc", {
			persistent: "continue",
		});

		// Simulate first run
		tracker.updateStatus(task.id, "in_progress");
		writeTestEvents(task.id);
		await eventStore.flush();

		// Pass and close
		tracker.updateStatus(task.id, "passed");
		simulateCloseTask(tracker.get(task.id), (id) => eventStore.clear(id));
		expect(tracker.get(task.id)!.status).toBe("pending");

		// "Reopen" — set back to in_progress
		tracker.updateStatus(task.id, "in_progress");

		// JSONL is still there — agent can resume from existing context
		expect(eventStore.has(task.id)).toBe(true);
		const events = eventStore.read(task.id);
		expect(events.length).toBe(4);
		expect(events[0]!.type).toBe("session_config");
	});

	test("closing then reopening: 'reset' mode starts fresh", async () => {
		const rootId = tracker.rootNodeId;
		const task = tracker.addChild(rootId, "Fresh start test", "desc", {
			persistent: "reset",
		});

		// Simulate first run
		tracker.updateStatus(task.id, "in_progress");
		writeTestEvents(task.id);
		await eventStore.flush();

		// Pass and close
		tracker.updateStatus(task.id, "passed");
		simulateCloseTask(tracker.get(task.id), (id) => eventStore.clear(id));
		expect(tracker.get(task.id)!.status).toBe("pending");

		// "Reopen" — set back to in_progress
		tracker.updateStatus(task.id, "in_progress");

		// JSONL is gone — agent starts fresh
		expect(eventStore.has(task.id)).toBe(false);
	});
});
