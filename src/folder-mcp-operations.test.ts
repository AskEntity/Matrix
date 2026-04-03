/**
 * Tests that all MCP operations work correctly when folders are involved.
 *
 * The key change: `isDescendantOf` and `getDescendantIds` use `tracker.get()`
 * (which returns both tasks and folders) instead of `tracker.getTask()` (tasks only).
 * Without this fix, scope validation breaks whenever a folder appears in the
 * parent chain between two tasks.
 *
 * This file covers:
 * 1. isDescendantOf traversing folders
 * 2. getDescendantIds collecting through folders
 * 3. create_task with folder parents (scope validation)
 * 4. update_task reparent into/through folders
 * 5. delete_task on nodes inside folders
 * 6. close_task on nodes inside folders
 * 7. reset_task on nodes inside folders
 * 8. send_message to nodes through folders (direction validation)
 * 9. reorder_tasks on folder's children
 * 10. done() descendant check through folders
 * 11. getTaskAbove / getTasksBelow folder transparency
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageQueue } from "./message-queue.ts";
import { createOrchestratorTools } from "./orchestrator-tools.ts";
import { TaskTracker } from "./task-tracker.ts";
import {
	buildTaskPrompt,
	getDescendantIds,
	isDescendantOf,
} from "./task-utils.ts";
import { attachMockSession, mockOrchestratorDeps } from "./test-utils.ts";

describe("folder-aware: isDescendantOf", () => {
	let tempDir: string;
	let tracker: TaskTracker;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-folder-desc-"));
		tracker = new TaskTracker(join(tempDir, "tree.json"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
	});

	test("returns true for task inside a folder that is child of ancestor", () => {
		// root → folder → task
		const root = tracker.addTask("root", "");
		const folder = tracker.addFolder("Folder", root.id);
		const task = tracker.addChild(folder.id, "task", "");
		expect(isDescendantOf(tracker, task.id, root.id)).toBe(true);
	});

	test("returns true for folder itself as descendant of ancestor", () => {
		const root = tracker.addTask("root", "");
		const folder = tracker.addFolder("Folder", root.id);
		expect(isDescendantOf(tracker, folder.id, root.id)).toBe(true);
	});

	test("returns true for task nested in multiple folders", () => {
		// root → folder1 → folder2 → task
		const root = tracker.addTask("root", "");
		const f1 = tracker.addFolder("F1", root.id);
		const f2 = tracker.addFolder("F2", f1.id);
		const task = tracker.addChild(f2.id, "deep task", "");
		expect(isDescendantOf(tracker, task.id, root.id)).toBe(true);
	});

	test("returns true for task in folder when checking against folder's parent task", () => {
		// agent → folder → child
		const agent = tracker.addTask("agent", "");
		const folder = tracker.addFolder("My Folder", agent.id);
		const child = tracker.addChild(folder.id, "child", "");
		expect(isDescendantOf(tracker, child.id, agent.id)).toBe(true);
	});

	test("returns false for task in folder not under ancestor", () => {
		// agent1 → folder → task
		// agent2 (separate)
		const agent1 = tracker.addTask("agent1", "");
		const agent2 = tracker.addTask("agent2", "");
		const folder = tracker.addFolder("Folder", agent1.id);
		const task = tracker.addChild(folder.id, "task", "");
		expect(isDescendantOf(tracker, task.id, agent2.id)).toBe(false);
	});

	test("returns false for folder not under ancestor", () => {
		const a = tracker.addTask("a", "");
		const b = tracker.addTask("b", "");
		const folder = tracker.addFolder("Folder", a.id);
		expect(isDescendantOf(tracker, folder.id, b.id)).toBe(false);
	});
});

describe("folder-aware: getDescendantIds", () => {
	let tempDir: string;
	let tracker: TaskTracker;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-folder-getdesc-"));
		tracker = new TaskTracker(join(tempDir, "tree.json"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
	});

	test("collects task IDs through a folder", () => {
		// root → folder → [task1, task2]
		const root = tracker.addTask("root", "");
		const folder = tracker.addFolder("Folder", root.id);
		const t1 = tracker.addChild(folder.id, "task1", "");
		const t2 = tracker.addChild(folder.id, "task2", "");

		const ids = getDescendantIds(tracker, root.id);
		expect(ids).toContain(folder.id);
		expect(ids).toContain(t1.id);
		expect(ids).toContain(t2.id);
		expect(ids).toHaveLength(3); // folder + 2 tasks
	});

	test("collects through nested folders", () => {
		// root → f1 → f2 → task
		const root = tracker.addTask("root", "");
		const f1 = tracker.addFolder("F1", root.id);
		const f2 = tracker.addFolder("F2", f1.id);
		const task = tracker.addChild(f2.id, "deep task", "");

		const ids = getDescendantIds(tracker, root.id);
		expect(ids).toContain(f1.id);
		expect(ids).toContain(f2.id);
		expect(ids).toContain(task.id);
		expect(ids).toHaveLength(3);
	});

	test("collects mixed task and folder children", () => {
		// root → [task1, folder → task2, task3]
		const root = tracker.addTask("root", "");
		const t1 = tracker.addChild(root.id, "task1", "");
		const folder = tracker.addFolder("Folder", root.id);
		const t2 = tracker.addChild(folder.id, "task2", "");
		const t3 = tracker.addChild(root.id, "task3", "");

		const ids = getDescendantIds(tracker, root.id);
		expect(ids).toContain(t1.id);
		expect(ids).toContain(folder.id);
		expect(ids).toContain(t2.id);
		expect(ids).toContain(t3.id);
		expect(ids).toHaveLength(4);
	});

	test("returns empty for folder with no children", () => {
		const root = tracker.addTask("root", "");
		const folder = tracker.addFolder("Empty", root.id);
		expect(getDescendantIds(tracker, folder.id)).toEqual([]);
	});

	test("returns descendants of a folder node", () => {
		// folder → [task1, task2]
		const root = tracker.addTask("root", "");
		const folder = tracker.addFolder("Folder", root.id);
		const t1 = tracker.addChild(folder.id, "task1", "");
		const t2 = tracker.addChild(folder.id, "task2", "");

		const ids = getDescendantIds(tracker, folder.id);
		expect(ids).toContain(t1.id);
		expect(ids).toContain(t2.id);
		expect(ids).toHaveLength(2);
	});
});

describe("folder-aware: getTaskAbove / getTasksBelow", () => {
	let tempDir: string;
	let tracker: TaskTracker;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-folder-ownership-"));
		tracker = new TaskTracker(join(tempDir, "tree.json"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
	});

	test("getTaskAbove skips folder to find owning task", () => {
		const root = tracker.addTask("root", "");
		const folder = tracker.addFolder("Folder", root.id);
		const child = tracker.addChild(folder.id, "child", "");

		const above = tracker.getTaskAbove(child.id);
		expect(above).toBeDefined();
		expect(above?.id).toBe(root.id);
	});

	test("getTaskAbove skips multiple folders", () => {
		const root = tracker.addTask("root", "");
		const f1 = tracker.addFolder("F1", root.id);
		const f2 = tracker.addFolder("F2", f1.id);
		const child = tracker.addChild(f2.id, "child", "");

		const above = tracker.getTaskAbove(child.id);
		expect(above).toBeDefined();
		expect(above?.id).toBe(root.id);
	});

	test("getTaskAbove returns immediate parent when no folders", () => {
		const parent = tracker.addTask("parent", "");
		const child = tracker.addChild(parent.id, "child", "");

		const above = tracker.getTaskAbove(child.id);
		expect(above).toBeDefined();
		expect(above?.id).toBe(parent.id);
	});

	test("getTasksBelow collects tasks through folders", () => {
		const root = tracker.addTask("root", "");
		const folder = tracker.addFolder("Folder", root.id);
		const t1 = tracker.addChild(folder.id, "task1", "");
		const t2 = tracker.addChild(root.id, "task2", "");

		const below = tracker.getTasksBelow(root.id);
		const ids = below.map((t) => t.id);
		expect(ids).toContain(t1.id);
		expect(ids).toContain(t2.id);
		expect(ids).toHaveLength(2);
	});

	test("getTasksBelow recurses through nested folders", () => {
		const root = tracker.addTask("root", "");
		const f1 = tracker.addFolder("F1", root.id);
		const f2 = tracker.addFolder("F2", f1.id);
		const task = tracker.addChild(f2.id, "deep task", "");

		const below = tracker.getTasksBelow(root.id);
		expect(below).toHaveLength(1);
		expect(below[0]?.id).toBe(task.id);
	});

	test("getTasksBelow does not include folders themselves", () => {
		const root = tracker.addTask("root", "");
		const folder = tracker.addFolder("Folder", root.id);
		tracker.addChild(folder.id, "task", "");

		const below = tracker.getTasksBelow(root.id);
		const ids = below.map((t) => t.id);
		expect(ids).not.toContain(folder.id);
	});
});

describe("folder-aware: create_task scope validation", () => {
	let tempDir: string;
	let tracker: TaskTracker;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-folder-create-"));
		tracker = new TaskTracker(join(tempDir, "tree.json"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
	});

	async function invokeCreateTask(
		currentTaskId: string | null,
		args: { title: string; description: string; parentId?: string },
	) {
		const deps = mockOrchestratorDeps({
			tracker,
			projectId: "test-project",
			projectPath: tempDir,
		});
		const { toolDefs } = createOrchestratorTools(
			deps,
			"test-project",
			currentTaskId,
		);
		const createTaskTool = toolDefs.find((t) => t.name === "create_task");
		if (!createTaskTool) throw new Error("create_task tool not found");
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		return (createTaskTool as any).handler(args);
	}

	test("agent creates task inside a folder in its subtree → succeeds", async () => {
		// agent → folder → (new task here)
		const agent = tracker.addTask("agent", "");
		const folder = tracker.addFolder("My Folder", agent.id);

		const result = await invokeCreateTask(agent.id, {
			title: "new task",
			description: "desc",
			parentId: folder.id,
		});
		expect(result.isError).toBeUndefined();
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.parentId).toBe(folder.id);
	});

	test("agent creates task inside a folder NOT in its subtree → fails", async () => {
		// parent → folder → (task inside)
		// agent (sibling of parent)
		const parent = tracker.addTask("parent", "");
		const agent = tracker.addChild(parent.id, "agent", "");
		const sibling = tracker.addChild(parent.id, "sibling", "");
		const folder = tracker.addFolder("Sibling Folder", sibling.id);

		const result = await invokeCreateTask(agent.id, {
			title: "bad task",
			description: "desc",
			parentId: folder.id,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("not your task or descendant");
	});

	test("root orchestrator creates task inside any folder → succeeds", async () => {
		const task = tracker.addTask("some task", "");
		const folder = tracker.addFolder("Folder", task.id);

		const result = await invokeCreateTask(null, {
			title: "anywhere",
			description: "desc",
			parentId: folder.id,
		});
		expect(result.isError).toBeUndefined();
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.parentId).toBe(folder.id);
	});

	test("agent creates task in deeply nested folder in its subtree → succeeds", async () => {
		// agent → f1 → f2 → (new task)
		const agent = tracker.addTask("agent", "");
		const f1 = tracker.addFolder("F1", agent.id);
		const f2 = tracker.addFolder("F2", f1.id);

		const result = await invokeCreateTask(agent.id, {
			title: "deep task",
			description: "desc",
			parentId: f2.id,
		});
		expect(result.isError).toBeUndefined();
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.parentId).toBe(f2.id);
	});

	test("agent creates task in folder that is direct child of agent → succeeds", async () => {
		const agent = tracker.addTask("agent", "");
		const folder = tracker.addFolder("Direct Folder", agent.id);

		const result = await invokeCreateTask(agent.id, {
			title: "task in folder",
			description: "desc",
			parentId: folder.id,
		});
		expect(result.isError).toBeUndefined();
	});
});

describe("folder-aware: update_task reparent", () => {
	let tempDir: string;
	let tracker: TaskTracker;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-folder-reparent-"));
		tracker = new TaskTracker(join(tempDir, "tree.json"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
	});

	async function invokeUpdateTask(
		currentTaskId: string | null,
		args: { taskId: string; parentId?: string },
	) {
		const deps = mockOrchestratorDeps({
			tracker,
			projectId: "test-project",
			projectPath: tempDir,
		});
		const { toolDefs } = createOrchestratorTools(
			deps,
			"test-project",
			currentTaskId,
		);
		const updateTaskTool = toolDefs.find((t) => t.name === "update_task");
		if (!updateTaskTool) throw new Error("update_task tool not found");
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		return (updateTaskTool as any).handler(args);
	}

	test("agent reparents child into a folder in its subtree → succeeds", async () => {
		// agent → [child, folder]
		const agent = tracker.addTask("agent", "");
		const child = tracker.addChild(agent.id, "child", "");
		const folder = tracker.addFolder("Folder", agent.id);

		const result = await invokeUpdateTask(agent.id, {
			taskId: child.id,
			parentId: folder.id,
		});
		expect(result.isError).toBeUndefined();

		// Verify reparent happened
		const updated = tracker.getTask(child.id);
		expect(updated?.parentId).toBe(folder.id);
	});

	test("agent reparents child into a folder outside its subtree → fails", async () => {
		// parent → [agent → child, sibling → folder]
		const parent = tracker.addTask("parent", "");
		const agent = tracker.addChild(parent.id, "agent", "");
		const child = tracker.addChild(agent.id, "child", "");
		const sibling = tracker.addChild(parent.id, "sibling", "");
		const folder = tracker.addFolder("Sibling Folder", sibling.id);

		const result = await invokeUpdateTask(agent.id, {
			taskId: child.id,
			parentId: folder.id,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("not your task or descendant");
	});

	test("agent reparents task from folder to another folder in subtree → succeeds", async () => {
		// agent → [f1 → task, f2]
		const agent = tracker.addTask("agent", "");
		const f1 = tracker.addFolder("F1", agent.id);
		const f2 = tracker.addFolder("F2", agent.id);
		const task = tracker.addChild(f1.id, "task", "");

		const result = await invokeUpdateTask(agent.id, {
			taskId: task.id,
			parentId: f2.id,
		});
		expect(result.isError).toBeUndefined();
		expect(tracker.getTask(task.id)?.parentId).toBe(f2.id);
	});

	test("scope check: task in folder is recognized as descendant for reparent", async () => {
		// agent → folder → task (reparent task to agent directly)
		const agent = tracker.addTask("agent", "");
		const folder = tracker.addFolder("Folder", agent.id);
		const task = tracker.addChild(folder.id, "task", "");

		const result = await invokeUpdateTask(agent.id, {
			taskId: task.id,
			parentId: agent.id,
		});
		expect(result.isError).toBeUndefined();
		expect(tracker.getTask(task.id)?.parentId).toBe(agent.id);
	});
});

describe("folder-aware: delete_task", () => {
	let tempDir: string;
	let tracker: TaskTracker;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-folder-delete-"));
		tracker = new TaskTracker(join(tempDir, "tree.json"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
	});

	async function invokeDeleteTask(
		currentTaskId: string | null,
		args: { taskId: string },
	) {
		const deps = mockOrchestratorDeps({
			tracker,
			projectId: "test-project",
			projectPath: tempDir,
		});
		const { toolDefs } = createOrchestratorTools(
			deps,
			"test-project",
			currentTaskId,
		);
		const deleteTool = toolDefs.find((t) => t.name === "delete_task");
		if (!deleteTool) throw new Error("delete_task tool not found");
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		return (deleteTool as any).handler(args);
	}

	test("delete task inside folder (no children) → succeeds", async () => {
		const agent = tracker.addTask("agent", "");
		const folder = tracker.addFolder("Folder", agent.id);
		const task = tracker.addChild(folder.id, "leaf", "");

		const result = await invokeDeleteTask(null, { taskId: task.id });
		expect(result.isError).toBeUndefined();
		expect(tracker.getTask(task.id)).toBeUndefined();
	});

	test("delete empty folder → succeeds", async () => {
		const agent = tracker.addTask("agent", "");
		const folder = tracker.addFolder("Empty Folder", agent.id);

		const result = await invokeDeleteTask(null, { taskId: folder.id });
		expect(result.isError).toBeUndefined();
		expect(tracker.get(folder.id)).toBeUndefined();
	});

	test("delete folder with children → fails", async () => {
		const agent = tracker.addTask("agent", "");
		const folder = tracker.addFolder("Folder", agent.id);
		tracker.addChild(folder.id, "child", "");

		const result = await invokeDeleteTask(null, { taskId: folder.id });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain(
			"Cannot delete folder with children",
		);
	});
});

describe("folder-aware: close_task", () => {
	let tempDir: string;
	let tracker: TaskTracker;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-folder-close-"));
		tracker = new TaskTracker(join(tempDir, "tree.json"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
	});

	async function invokeCloseTask(
		currentTaskId: string | null,
		args: { taskId: string },
	) {
		const deps = mockOrchestratorDeps({
			tracker,
			projectId: "test-project",
			projectPath: tempDir,
		});
		const { toolDefs } = createOrchestratorTools(
			deps,
			"test-project",
			currentTaskId,
		);
		const closeTool = toolDefs.find((t) => t.name === "close_task");
		if (!closeTool) throw new Error("close_task tool not found");
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		return (closeTool as any).handler(args);
	}

	test("close task inside folder (verify status) → succeeds", async () => {
		const agent = tracker.addTask("agent", "");
		const folder = tracker.addFolder("Folder", agent.id);
		const task = tracker.addChild(folder.id, "task", "");
		tracker.updateStatus(task.id, "verify");

		const result = await invokeCloseTask(null, { taskId: task.id });
		expect(result.isError).toBeUndefined();
		expect(tracker.getTask(task.id)?.status).toBe("closed");
	});

	test("close folder → fails (folders cannot be closed)", async () => {
		const agent = tracker.addTask("agent", "");
		const folder = tracker.addFolder("Folder", agent.id);

		const result = await invokeCloseTask(null, { taskId: folder.id });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Cannot close a folder");
	});
});

describe("folder-aware: reset_task", () => {
	let tempDir: string;
	let tracker: TaskTracker;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-folder-reset-"));
		tracker = new TaskTracker(join(tempDir, "tree.json"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
	});

	async function invokeResetTask(
		currentTaskId: string | null,
		args: { taskId: string },
	) {
		const deps = mockOrchestratorDeps({
			tracker,
			projectId: "test-project",
			projectPath: tempDir,
		});
		const { toolDefs } = createOrchestratorTools(
			deps,
			"test-project",
			currentTaskId,
		);
		const resetTool = toolDefs.find((t) => t.name === "reset_task");
		if (!resetTool) throw new Error("reset_task tool not found");
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		return (resetTool as any).handler(args);
	}

	test("reset task inside folder → succeeds", async () => {
		const agent = tracker.addTask("agent", "");
		const folder = tracker.addFolder("Folder", agent.id);
		const task = tracker.addChild(folder.id, "task", "");
		tracker.updateStatus(task.id, "in_progress");

		const result = await invokeResetTask(null, { taskId: task.id });
		expect(result.isError).toBeUndefined();
		expect(tracker.getTask(task.id)?.status).toBe("pending");
	});

	test("reset folder → fails (folders cannot be reset)", async () => {
		const agent = tracker.addTask("agent", "");
		const folder = tracker.addFolder("Folder", agent.id);

		const result = await invokeResetTask(null, { taskId: folder.id });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Cannot reset a folder");
	});
});

describe("folder-aware: send_message direction validation", () => {
	let tempDir: string;
	let tracker: TaskTracker;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-folder-msg-"));
		tracker = new TaskTracker(join(tempDir, "tree.json"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
	});

	async function invokeSendMessage(
		currentTaskId: string | null,
		args: { taskId: string; title: string; message: string },
	) {
		const deps = mockOrchestratorDeps({
			tracker,
			projectId: "test-project",
			projectPath: tempDir,
		});
		const { toolDefs } = createOrchestratorTools(
			deps,
			"test-project",
			currentTaskId,
		);
		const sendTool = toolDefs.find((t) => t.name === "send_message");
		if (!sendTool) throw new Error("send_message tool not found");
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		return (sendTool as any).handler(args);
	}

	test("upward message: task in folder sends to owning task (getTaskAbove) → succeeds", async () => {
		// root → folder → agent (running)
		const root = tracker.addTask("root", "");
		const folder = tracker.addFolder("Folder", root.id);
		const agent = tracker.addChild(folder.id, "agent", "");

		// Attach sessions so the queue exists
		const rootQueue = new MessageQueue();
		attachMockSession(root, rootQueue);
		const agentQueue = new MessageQueue();
		attachMockSession(agent, agentQueue, { depth: 1 });

		// Agent sends upward → should find root (skipping folder)
		const result = await invokeSendMessage(agent.id, {
			taskId: root.id,
			title: "Progress",
			message: "50% done",
		});

		expect(result.isError).toBeUndefined();
		expect(result.content[0].text).toContain("Message sent to parent task");
	});

	test("downward message: owning task sends to task in folder (getTaskAbove check) → succeeds", async () => {
		// root → folder → child
		const root = tracker.addTask("root", "");
		const folder = tracker.addFolder("Folder", root.id);
		const child = tracker.addChild(folder.id, "child", "");

		// Child needs a branch + worktree for send_message to not try to create one
		child.branch = "mxd/child/test";
		child.worktreePath = tempDir;

		const rootQueue = new MessageQueue();
		attachMockSession(root, rootQueue);
		const childQueue = new MessageQueue();
		attachMockSession(child, childQueue, { depth: 1 });

		// Root sends downward to child (through folder) → should succeed
		const result = await invokeSendMessage(root.id, {
			taskId: child.id,
			title: "Instructions",
			message: "Do this",
		});

		expect(result.isError).toBeUndefined();
		// Should be recognized as downward (child's getTaskAbove = root)
		expect(result.content[0].text).toContain("Message sent to task");
	});

	test("message to unrelated task in folder → fails direction check", async () => {
		// root → [agent, other_agent → folder → task]
		const root = tracker.addTask("root", "");
		const agent = tracker.addChild(root.id, "agent", "");
		const other = tracker.addChild(root.id, "other", "");
		const folder = tracker.addFolder("Folder", other.id);
		const task = tracker.addChild(folder.id, "task in folder", "");

		const agentQueue = new MessageQueue();
		attachMockSession(agent, agentQueue, { depth: 1 });

		const result = await invokeSendMessage(agent.id, {
			taskId: task.id,
			title: "Test",
			message: "Can I reach you?",
		});

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("is neither");
	});

	test("root orchestrator sends to task inside folder → succeeds (downward)", async () => {
		// We simulate root orchestrator (currentTaskId = root's actual ID)
		await tracker.load("main");
		const rootId = tracker.rootNodeId;
		const folder = tracker.addFolder("Folder", rootId);
		const child = tracker.addChild(folder.id, "child", "");
		child.branch = "mxd/child/test";
		child.worktreePath = tempDir;

		const rootNode = tracker.getTask(rootId);
		if (!rootNode) throw new Error("root node not found");
		const rootQueue = new MessageQueue();
		attachMockSession(rootNode, rootQueue);
		const childQueue = new MessageQueue();
		attachMockSession(child, childQueue, { depth: 1 });

		const result = await invokeSendMessage(rootId, {
			taskId: child.id,
			title: "Go",
			message: "Start working",
		});

		expect(result.isError).toBeUndefined();
	});
});

describe("folder-aware: reorder_tasks", () => {
	let tempDir: string;
	let tracker: TaskTracker;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-folder-reorder-"));
		tracker = new TaskTracker(join(tempDir, "tree.json"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
	});

	async function invokeReorder(
		currentTaskId: string | null,
		args: { nodeId: string; children: string[] },
	) {
		const deps = mockOrchestratorDeps({
			tracker,
			projectId: "test-project",
			projectPath: tempDir,
		});
		const { toolDefs } = createOrchestratorTools(
			deps,
			"test-project",
			currentTaskId,
		);
		const reorderTool = toolDefs.find((t) => t.name === "reorder_tasks");
		if (!reorderTool) throw new Error("reorder_tasks tool not found");
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		return (reorderTool as any).handler(args);
	}

	test("agent reorders children of a folder in its subtree → succeeds", async () => {
		// agent → folder → [t1, t2, t3]
		const agent = tracker.addTask("agent", "");
		const folder = tracker.addFolder("Folder", agent.id);
		const t1 = tracker.addChild(folder.id, "task1", "");
		const t2 = tracker.addChild(folder.id, "task2", "");
		const t3 = tracker.addChild(folder.id, "task3", "");

		const result = await invokeReorder(agent.id, {
			nodeId: folder.id,
			children: [t3.id, t1.id, t2.id],
		});

		expect(result.isError).toBeUndefined();
		const node = tracker.get(folder.id);
		if (!node) throw new Error("folder not found");
		expect(node.children).toEqual([t3.id, t1.id, t2.id]);
	});

	test("agent cannot reorder folder outside its subtree → fails", async () => {
		const parent = tracker.addTask("parent", "");
		const agent = tracker.addChild(parent.id, "agent", "");
		const sibling = tracker.addChild(parent.id, "sibling", "");
		const folder = tracker.addFolder("Folder", sibling.id);
		const t1 = tracker.addChild(folder.id, "task1", "");
		const t2 = tracker.addChild(folder.id, "task2", "");

		const result = await invokeReorder(agent.id, {
			nodeId: folder.id,
			children: [t2.id, t1.id],
		});

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("not your task or descendant");
	});

	test("reorder folder's own children (mix of tasks and sub-folders) → succeeds", async () => {
		const agent = tracker.addTask("agent", "");
		const folder = tracker.addFolder("Folder", agent.id);
		const t1 = tracker.addChild(folder.id, "task1", "");
		const subFolder = tracker.addFolder("SubFolder", folder.id);
		const t2 = tracker.addChild(folder.id, "task2", "");

		const result = await invokeReorder(agent.id, {
			nodeId: folder.id,
			children: [t2.id, subFolder.id, t1.id],
		});

		expect(result.isError).toBeUndefined();
		expect(tracker.get(folder.id)?.children).toEqual([
			t2.id,
			subFolder.id,
			t1.id,
		]);
	});
});

describe("folder-aware: done() descendant check", () => {
	let tempDir: string;
	let tracker: TaskTracker;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-folder-done-"));
		tracker = new TaskTracker(join(tempDir, "tree.json"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
	});

	async function invokeDone(
		currentTaskId: string | null,
		args: { status: string; summary: string },
	) {
		const deps = mockOrchestratorDeps({
			tracker,
			projectId: "test-project",
			projectPath: tempDir,
		});
		const { toolDefs } = createOrchestratorTools(
			deps,
			"test-project",
			currentTaskId,
		);
		const doneTool = toolDefs.find((t) => t.name === "done");
		if (!doneTool) throw new Error("done tool not found");
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		return (doneTool as any).handler(args);
	}

	test("done() blocked when running child exists inside folder", async () => {
		// agent → folder → child (with active session)
		const agent = tracker.addTask("agent", "");
		const folder = tracker.addFolder("Folder", agent.id);
		const child = tracker.addChild(folder.id, "child", "");

		// Give agent a queue so done() can close it
		const agentQueue = new MessageQueue();
		attachMockSession(agent, agentQueue);

		// Give child a session (simulates running child)
		const childQueue = new MessageQueue();
		attachMockSession(child, childQueue, { depth: 1 });

		const result = await invokeDone(agent.id, {
			status: "passed",
			summary: "Done",
		});

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain(
			"Cannot call done() while child tasks are still running",
		);
		expect(result.content[0].text).toContain(child.title);
	});

	test("done() allowed when child inside folder has no session", async () => {
		// agent → folder → child (no session = not running)
		const agent = tracker.addTask("agent", "");
		const folder = tracker.addFolder("Folder", agent.id);
		tracker.addChild(folder.id, "child", "");

		const agentQueue = new MessageQueue();
		attachMockSession(agent, agentQueue);

		const result = await invokeDone(agent.id, {
			status: "passed",
			summary: "Done",
		});

		// Should succeed — child is not running
		expect(result.isError).toBeUndefined();
	});

	test("done() blocked when deeply nested child (through folders) is running", async () => {
		// agent → f1 → f2 → child (running)
		const agent = tracker.addTask("agent", "");
		const f1 = tracker.addFolder("F1", agent.id);
		const f2 = tracker.addFolder("F2", f1.id);
		const child = tracker.addChild(f2.id, "deep child", "");

		const agentQueue = new MessageQueue();
		attachMockSession(agent, agentQueue);
		const childQueue = new MessageQueue();
		attachMockSession(child, childQueue, { depth: 1 });

		const result = await invokeDone(agent.id, {
			status: "passed",
			summary: "Done",
		});

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("deep child");
	});
});

describe("folder-aware: fork_task_context scope validation", () => {
	let tempDir: string;
	let tracker: TaskTracker;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-folder-fork-"));
		tracker = new TaskTracker(join(tempDir, "tree.json"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
	});

	async function invokeForkContext(
		currentTaskId: string | null,
		args: { sourceTaskId: string; targetTaskId: string },
	) {
		const deps = mockOrchestratorDeps({
			tracker,
			projectId: "test-project",
			projectPath: tempDir,
		});
		// hasEventStore needs to return true for source
		deps.hasEventStore = (id: string) => id === args.sourceTaskId;

		const { toolDefs } = createOrchestratorTools(
			deps,
			"test-project",
			currentTaskId,
		);
		const forkTool = toolDefs.find((t) => t.name === "fork_task_context");
		if (!forkTool) throw new Error("fork_task_context tool not found");
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		return (forkTool as any).handler(args);
	}

	test("fork into target inside folder in agent's subtree → succeeds", async () => {
		const agent = tracker.addTask("agent", "");
		const source = tracker.addChild(agent.id, "source", "");
		const folder = tracker.addFolder("Folder", agent.id);
		const target = tracker.addChild(folder.id, "target", "");

		const result = await invokeForkContext(agent.id, {
			sourceTaskId: source.id,
			targetTaskId: target.id,
		});

		expect(result.isError).toBeUndefined();
		expect(result.content[0].text).toContain("fork_task_context completed");
	});

	test("fork into target inside folder NOT in agent's subtree → fails", async () => {
		const parent = tracker.addTask("parent", "");
		const agent = tracker.addChild(parent.id, "agent", "");
		const source = tracker.addChild(agent.id, "source", "");
		const sibling = tracker.addChild(parent.id, "sibling", "");
		const folder = tracker.addFolder("Folder", sibling.id);
		const target = tracker.addChild(folder.id, "target", "");

		const result = await invokeForkContext(agent.id, {
			sourceTaskId: source.id,
			targetTaskId: target.id,
		});

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("not your task or descendant");
	});
});

describe("folder-aware: TaskTracker persistence", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-folder-persist-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
	});

	test("folders survive save/load round-trip", async () => {
		const treePath = join(tempDir, "tree.json");
		const tracker1 = new TaskTracker(treePath);
		await tracker1.load("main");

		const root = tracker1.getTask(tracker1.rootNodeId);
		if (!root) throw new Error("root node not found");
		const folder = tracker1.addFolder("My Folder", root.id);
		const task = tracker1.addChild(folder.id, "task in folder", "");
		await tracker1.save();

		// Load in a new tracker instance
		const tracker2 = new TaskTracker(treePath);
		await tracker2.load("main");

		// Verify folder was restored
		const loadedFolder = tracker2.get(folder.id);
		expect(loadedFolder).toBeDefined();
		expect(loadedFolder?.type).toBe("folder");
		expect(loadedFolder?.title).toBe("My Folder");
		expect(loadedFolder?.children).toContain(task.id);

		// Verify task inside folder was restored
		const loadedTask = tracker2.getTask(task.id);
		expect(loadedTask).toBeDefined();
		expect(loadedTask?.parentId).toBe(folder.id);

		// Verify traversal still works after load
		expect(isDescendantOf(tracker2, task.id, root.id)).toBe(true);
		expect(tracker2.getTaskAbove(task.id)?.id).toBe(root.id);
	});

	test("getTask returns undefined for folder (correct type filtering)", () => {
		const tracker = new TaskTracker(join(tempDir, "tree.json"));
		const root = tracker.addTask("root", "");
		const folder = tracker.addFolder("Folder", root.id);

		expect(tracker.getTask(folder.id)).toBeUndefined();
		expect(tracker.get(folder.id)).toBeDefined();
	});
});

describe("folder-aware: buildTaskPrompt", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-folder-prompt-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
	});

	test("task in folder shows owning task (not folder) in 'Your task is part of'", () => {
		const tracker = new TaskTracker(join(tempDir, "tree.json"));
		const root = tracker.addTask("Orchestrator", "");
		const folder = tracker.addFolder("My Folder", root.id);
		const child = tracker.addChild(folder.id, "Child Task", "Do the work");

		const prompt = buildTaskPrompt(child, tracker, "");
		// Should mention root (the owning task), not the folder
		expect(prompt).toContain(`Your task is part of "Orchestrator"`);
		expect(prompt).toContain(root.id);
		// Should NOT contain the folder ID as the "part of" target
		expect(prompt).not.toContain(`part of "My Folder"`);
	});

	test("task directly under another task still works", () => {
		const tracker = new TaskTracker(join(tempDir, "tree.json"));
		const parent = tracker.addTask("Parent", "");
		const child = tracker.addChild(parent.id, "Child", "desc");

		const prompt = buildTaskPrompt(child, tracker, "");
		expect(prompt).toContain(`Your task is part of "Parent"`);
		expect(prompt).toContain(parent.id);
	});

	test("task in nested folders shows correct owning task", () => {
		const tracker = new TaskTracker(join(tempDir, "tree.json"));
		const root = tracker.addTask("Root Agent", "");
		const f1 = tracker.addFolder("F1", root.id);
		const f2 = tracker.addFolder("F2", f1.id);
		const task = tracker.addChild(f2.id, "Deep Task", "");

		const prompt = buildTaskPrompt(task, tracker, "");
		expect(prompt).toContain(`Your task is part of "Root Agent"`);
		expect(prompt).toContain(root.id);
	});
});
