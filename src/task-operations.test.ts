/**
 * Unit tests for task-operations.ts — shared functions used by both MCP and REST.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageQueue } from "./message-queue.ts";
import {
	closeTaskOp,
	createTaskOp,
	deleteTaskOp,
	reorderTasksOp,
	resetTaskOp,
	updateTaskOp,
} from "./task-operations.ts";
import { TaskTracker } from "./task-tracker.ts";

let tempDir: string;
let tracker: TaskTracker;
let broadcastCount: number;
let notifyTreeChangeCalls: Array<{
	action: string;
	nodeId: string;
	title?: string;
}>;
let notifyTargetNodeCalls: Array<{
	action: string;
	nodeId: string;
	title?: string;
}>;

function resetCallbacks() {
	broadcastCount = 0;
	notifyTreeChangeCalls = [];
	notifyTargetNodeCalls = [];
}

function makeCallbacks(extra?: Record<string, unknown>) {
	return {
		broadcastTree: () => {
			broadcastCount++;
		},
		notifyTreeChange: (
			action: "created" | "updated" | "deleted" | "reordered",
			nodeId: string,
			title?: string,
		) => {
			notifyTreeChangeCalls.push({ action, nodeId, title });
		},
		notifyTargetNode: (
			action: "created" | "updated" | "deleted" | "reordered",
			nodeId: string,
			title?: string,
		) => {
			notifyTargetNodeCalls.push({ action, nodeId, title });
		},
		projectPath: tempDir,
		removeWorktree: async () => {},
		clearEventStore: () => {},
		...extra,
	};
}

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "mxd-taskops-"));
	tracker = new TaskTracker(join(tempDir, "tree.json"));
	await tracker.load("main");
	resetCallbacks();
});

afterEach(async () => {
	await rm(tempDir, { recursive: true });
});

// ── createTaskOp ──

describe("createTaskOp", () => {
	test("creates a child task under parent", async () => {
		const node = await createTaskOp(
			tracker,
			{
				title: "My Task",
				description: "Do things",
				parentId: tracker.rootNodeId,
			},
			"user",
			makeCallbacks(),
		);

		expect(node.title).toBe("My Task");
		expect(node.description).toBe("Do things");
		expect(node.parentId).toBe(tracker.rootNodeId);
		expect(node.status).toBe("pending");
		expect(node.editedBy).toBe("user");
		expect(broadcastCount).toBe(1);
	});

	test("creates top-level task when no parentId", async () => {
		const node = await createTaskOp(
			tracker,
			{ title: "Top Level", description: "" },
			"agent",
			makeCallbacks(),
		);

		expect(node.parentId).toBeNull();
		expect(node.editedBy).toBe("agent");
	});

	test("applies draft mode", async () => {
		const node = await createTaskOp(
			tracker,
			{
				title: "Draft",
				description: "",
				parentId: tracker.rootNodeId,
				draft: true,
			},
			"user",
			makeCallbacks(),
		);

		expect(node.status).toBe("draft");
	});

	test("applies color", async () => {
		const node = await createTaskOp(
			tracker,
			{
				title: "Colored",
				description: "",
				parentId: tracker.rootNodeId,
				color: "red",
			},
			"user",
			makeCallbacks(),
		);

		expect(node.color).toBe("#f85149"); // red resolved to hex
	});

	test("applies budgetUsd", async () => {
		const node = await createTaskOp(
			tracker,
			{
				title: "Budget",
				description: "",
				parentId: tracker.rootNodeId,
				budgetUsd: 1.5,
			},
			"user",
			makeCallbacks(),
		);

		expect(node.budgetUsd).toBe(1.5);
	});

	test("notifies parent chain only for user edits", async () => {
		// User edit — should notify
		await createTaskOp(
			tracker,
			{
				title: "User Task",
				description: "",
				parentId: tracker.rootNodeId,
			},
			"user",
			makeCallbacks(),
		);
		expect(notifyTreeChangeCalls).toHaveLength(1);
		expect(notifyTreeChangeCalls[0]?.action).toBe("created");

		// Agent edit — should NOT notify parent chain
		resetCallbacks();
		await createTaskOp(
			tracker,
			{
				title: "Agent Task",
				description: "",
				parentId: tracker.rootNodeId,
			},
			"agent",
			makeCallbacks(),
		);
		expect(notifyTreeChangeCalls).toHaveLength(0);
	});

	test("saves tracker to disk", async () => {
		await createTaskOp(
			tracker,
			{
				title: "Saved",
				description: "",
				parentId: tracker.rootNodeId,
			},
			"user",
			makeCallbacks(),
		);

		// Reload and verify
		const tracker2 = new TaskTracker(join(tempDir, "tree.json"));
		await tracker2.load("main");
		const nodes = tracker2.allNodes();
		expect(nodes.some((n) => n.title === "Saved")).toBe(true);
	});
});

// ── updateTaskOp ──

describe("updateTaskOp", () => {
	test("updates title and description", async () => {
		const task = tracker.addChild(tracker.rootNodeId, "Original", "Old desc", {
			editedBy: "agent",
		});

		const updated = await updateTaskOp(
			tracker,
			task.id,
			{ title: "Updated", description: "New desc" },
			"user",
			makeCallbacks(),
		);

		expect(updated.title).toBe("Updated");
		expect(updated.description).toBe("New desc");
		expect(updated.editedBy).toBe("user");
	});

	test("updates status", async () => {
		const task = tracker.addChild(tracker.rootNodeId, "Task", "", {
			editedBy: "agent",
		});

		const updated = await updateTaskOp(
			tracker,
			task.id,
			{ status: "in_progress" },
			"user",
			makeCallbacks(),
		);

		expect(updated.status).toBe("in_progress");
	});

	test("reparents task", async () => {
		const parent1 = tracker.addChild(tracker.rootNodeId, "P1", "", {
			editedBy: "agent",
		});
		const parent2 = tracker.addChild(tracker.rootNodeId, "P2", "", {
			editedBy: "agent",
		});
		const child = tracker.addChild(parent1.id, "Child", "", {
			editedBy: "agent",
		});

		const updated = await updateTaskOp(
			tracker,
			child.id,
			{ parentId: parent2.id },
			"user",
			makeCallbacks(),
		);

		expect(updated.parentId).toBe(parent2.id);
	});

	test("updates draft flag", async () => {
		const task = tracker.addChild(tracker.rootNodeId, "Task", "", {
			editedBy: "agent",
		});

		const updated = await updateTaskOp(
			tracker,
			task.id,
			{ draft: true },
			"user",
			makeCallbacks(),
		);

		expect(updated.status).toBe("draft");
	});

	test("updates color", async () => {
		const task = tracker.addChild(tracker.rootNodeId, "Task", "", {
			editedBy: "agent",
		});

		const updated = await updateTaskOp(
			tracker,
			task.id,
			{ color: "blue" },
			"user",
			makeCallbacks(),
		);

		expect(updated.color).toBe("#388bfd");
	});

	test("clears color with null", async () => {
		const task = tracker.addChild(tracker.rootNodeId, "Task", "", {
			editedBy: "agent",
		});
		tracker.updateColor(task.id, "#ff0000");

		const updated = await updateTaskOp(
			tracker,
			task.id,
			{ color: null },
			"user",
			makeCallbacks(),
		);

		expect(updated.color).toBeUndefined();
	});

	test("throws for nonexistent task", async () => {
		await expect(
			updateTaskOp(
				tracker,
				"nonexistent",
				{ title: "X" },
				"user",
				makeCallbacks(),
			),
		).rejects.toThrow("Task not found");
	});

	test("notifyTargetNode called for title change by both agent and user", async () => {
		const task = tracker.addChild(tracker.rootNodeId, "Task", "desc", {
			editedBy: "agent",
		});

		// Agent edit — should call notifyTargetNode but NOT notifyTreeChange
		await updateTaskOp(
			tracker,
			task.id,
			{ title: "New Title" },
			"agent",
			makeCallbacks(),
		);
		expect(notifyTargetNodeCalls).toHaveLength(1);
		expect(notifyTreeChangeCalls).toHaveLength(0);

		// User edit — should call BOTH
		resetCallbacks();
		await updateTaskOp(
			tracker,
			task.id,
			{ description: "New desc" },
			"user",
			makeCallbacks(),
		);
		expect(notifyTargetNodeCalls).toHaveLength(1);
		expect(notifyTreeChangeCalls).toHaveLength(1);
	});

	test("no notification for status-only change", async () => {
		const task = tracker.addChild(tracker.rootNodeId, "Task", "", {
			editedBy: "agent",
		});

		await updateTaskOp(
			tracker,
			task.id,
			{ status: "in_progress" },
			"user",
			makeCallbacks(),
		);

		// No title/desc change — no notification
		expect(notifyTargetNodeCalls).toHaveLength(0);
		expect(notifyTreeChangeCalls).toHaveLength(0);
		// But broadcastTree is still called
		expect(broadcastCount).toBe(1);
	});
});

// ── deleteTaskOp ──

describe("deleteTaskOp", () => {
	test("rejects delete when task has children", async () => {
		const parent = tracker.addChild(tracker.rootNodeId, "Parent", "", {
			editedBy: "agent",
		});
		tracker.addChild(parent.id, "Child", "", { editedBy: "agent" });

		await expect(
			deleteTaskOp(tracker, parent.id, "user", makeCallbacks()),
		).rejects.toThrow("Cannot delete task with children");
	});

	test("deletes leaf task", async () => {
		const task = tracker.addChild(tracker.rootNodeId, "Leaf", "", {
			editedBy: "agent",
		});

		const result = await deleteTaskOp(
			tracker,
			task.id,
			"user",
			makeCallbacks(),
		);

		expect(result.taskId).toBe(task.id);
		expect(result.title).toBe("Leaf");
		expect(tracker.getTask(task.id)).toBeUndefined();
		expect(broadcastCount).toBe(1);
	});

	test("throws for nonexistent task", async () => {
		await expect(
			deleteTaskOp(tracker, "nonexistent", "user", makeCallbacks()),
		).rejects.toThrow("Task not found");
	});

	test("notifies parent chain only for user edits", async () => {
		const task = tracker.addChild(tracker.rootNodeId, "Task", "", {
			editedBy: "agent",
		});

		await deleteTaskOp(tracker, task.id, "user", makeCallbacks());
		expect(notifyTreeChangeCalls).toHaveLength(1);
		expect(notifyTreeChangeCalls[0]?.action).toBe("deleted");

		// Agent delete — no parent chain notification
		const task2 = tracker.addChild(tracker.rootNodeId, "Task2", "", {
			editedBy: "agent",
		});
		resetCallbacks();
		await deleteTaskOp(tracker, task2.id, "agent", makeCallbacks());
		expect(notifyTreeChangeCalls).toHaveLength(0);
	});

	test("calls clearEventStore for deleted leaf task", async () => {
		const task = tracker.addChild(tracker.rootNodeId, "Leaf", "", {
			editedBy: "agent",
		});

		const cleared: string[] = [];
		await deleteTaskOp(tracker, task.id, "user", {
			...makeCallbacks(),
			clearEventStore: (id: string) => cleared.push(id),
		});

		expect(cleared).toContain(task.id);
	});
});

// ── closeTaskOp ──

describe("closeTaskOp", () => {
	test("closes passed regular task — sets status to closed", async () => {
		const task = tracker.addChild(tracker.rootNodeId, "Task", "", {
			editedBy: "agent",
		});
		tracker.updateStatus(task.id, "verify");

		const result = await closeTaskOp(tracker, task.id, makeCallbacks());

		expect(result.taskId).toBe(task.id);
		const node = tracker.getTask(task.id);
		expect(node?.status).toBe("closed");
	});

	test("verify → closed for regular tasks", async () => {
		const task = tracker.addChild(tracker.rootNodeId, "Verified", "", {
			editedBy: "agent",
		});
		tracker.updateStatus(task.id, "verify");

		const result = await closeTaskOp(tracker, task.id, makeCallbacks());

		expect(result.taskId).toBe(task.id);
		const node = tracker.getTask(task.id);
		expect(node?.status).toBe("closed");
	});

	test("passed → closed (backward compat)", async () => {
		const task = tracker.addChild(tracker.rootNodeId, "Passed", "", {
			editedBy: "agent",
		});
		tracker.updateStatus(task.id, "verify");

		const result = await closeTaskOp(tracker, task.id, makeCallbacks());

		expect(result.taskId).toBe(task.id);
		const node = tracker.getTask(task.id);
		expect(node?.status).toBe("closed");
	});

	test("failed → closed (backward compat)", async () => {
		const task = tracker.addChild(tracker.rootNodeId, "Failed", "", {
			editedBy: "agent",
		});
		tracker.updateStatus(task.id, "failed");

		const result = await closeTaskOp(tracker, task.id, makeCallbacks());

		expect(result.taskId).toBe(task.id);
		const node = tracker.getTask(task.id);
		expect(node?.status).toBe("closed");
	});

	test("rejects closing in_progress task", async () => {
		const task = tracker.addChild(tracker.rootNodeId, "Running", "", {
			editedBy: "agent",
		});
		tracker.updateStatus(task.id, "in_progress");

		await expect(
			closeTaskOp(tracker, task.id, makeCallbacks()),
		).rejects.toThrow("Cannot close a running task");
	});

	test("rejects closing pending task", async () => {
		const task = tracker.addChild(tracker.rootNodeId, "Pending", "", {
			editedBy: "agent",
		});
		// Already pending by default

		await expect(
			closeTaskOp(tracker, task.id, makeCallbacks()),
		).rejects.toThrow('Cannot close a task with status "pending"');
	});

	test("rejects closing draft task", async () => {
		const task = tracker.addChild(tracker.rootNodeId, "Draft", "", {
			editedBy: "agent",
		});
		tracker.updateStatus(task.id, "draft");

		await expect(
			closeTaskOp(tracker, task.id, makeCallbacks()),
		).rejects.toThrow('Cannot close a task with status "draft"');
	});

	test("throws for nonexistent task", async () => {
		await expect(
			closeTaskOp(tracker, "nonexistent", makeCallbacks()),
		).rejects.toThrow("Task not found");
	});
});

// ── resetTaskOp ──

describe("resetTaskOp", () => {
	test("resets task to pending", async () => {
		const task = tracker.addChild(tracker.rootNodeId, "Failed", "", {
			editedBy: "agent",
		});
		tracker.updateStatus(task.id, "failed");

		const result = await resetTaskOp(tracker, task.id, makeCallbacks());

		expect(result.taskId).toBe(task.id);
		const node = tracker.getTask(task.id);
		expect(node?.status).toBe("pending");
	});

	test("closes running agent queue", async () => {
		const task = tracker.addChild(tracker.rootNodeId, "Running", "", {
			editedBy: "agent",
		});
		const queue = new MessageQueue();
		task.session = {
			queue,
			abortController: new AbortController(),
			loopTraceId: "test-trace-id",
			depth: 1,
			backgroundProcesses: new Map(),
			foregroundExecutions: new Map(),
		};

		await resetTaskOp(tracker, task.id, makeCallbacks());

		expect(queue.isClosed).toBe(true);
		expect(task.session).toBeUndefined();
	});

	test("clears event store", async () => {
		const task = tracker.addChild(tracker.rootNodeId, "Task", "", {
			editedBy: "agent",
		});

		const cleared: string[] = [];
		await resetTaskOp(tracker, task.id, {
			...makeCallbacks(),
			clearEventStore: (id: string) => cleared.push(id),
		});

		expect(cleared).toContain(task.id);
	});

	test("throws for nonexistent task", async () => {
		await expect(
			resetTaskOp(tracker, "nonexistent", makeCallbacks()),
		).rejects.toThrow("Task not found");
	});
});

// ── reorderTasksOp ──

describe("reorderTasksOp", () => {
	test("reorders children", async () => {
		const c1 = tracker.addChild(tracker.rootNodeId, "C1", "", {
			editedBy: "agent",
		});
		const c2 = tracker.addChild(tracker.rootNodeId, "C2", "", {
			editedBy: "agent",
		});

		await reorderTasksOp(
			tracker,
			tracker.rootNodeId,
			[c2.id, c1.id],
			"user",
			makeCallbacks(),
		);

		const root = tracker.getTask(tracker.rootNodeId);
		expect(root?.children).toEqual([c2.id, c1.id]);
		expect(broadcastCount).toBe(1);
	});

	test("notifies parent chain only for user edits", async () => {
		const c1 = tracker.addChild(tracker.rootNodeId, "C1", "", {
			editedBy: "agent",
		});
		const c2 = tracker.addChild(tracker.rootNodeId, "C2", "", {
			editedBy: "agent",
		});

		await reorderTasksOp(
			tracker,
			tracker.rootNodeId,
			[c2.id, c1.id],
			"user",
			makeCallbacks(),
		);
		expect(notifyTreeChangeCalls).toHaveLength(1);
		expect(notifyTreeChangeCalls[0]?.action).toBe("reordered");

		// Agent reorder — no parent chain notification
		resetCallbacks();
		await reorderTasksOp(
			tracker,
			tracker.rootNodeId,
			[c1.id, c2.id],
			"agent",
			makeCallbacks(),
		);
		expect(notifyTreeChangeCalls).toHaveLength(0);
	});

	test("throws for nonexistent task", async () => {
		await expect(
			reorderTasksOp(tracker, "nonexistent", [], "user", makeCallbacks()),
		).rejects.toThrow("Task not found");
	});
});

// ── Surgical description edit (MCP-layer logic) ──
// The MCP update_task handler pre-processes old_description/new_description
// into a final description before calling updateTaskOp. These tests validate
// that pattern at the unit level.

describe("surgical description edit via updateTaskOp", () => {
	function surgicalReplace(
		currentDesc: string,
		oldDesc: string,
		newDesc: string,
	): { description: string } | { error: string } {
		const idx = currentDesc.indexOf(oldDesc);
		if (idx === -1) return { error: "old_description not found" };
		if (currentDesc.indexOf(oldDesc, idx + 1) !== -1)
			return { error: "old_description not unique" };
		return { description: currentDesc.replace(oldDesc, newDesc) };
	}

	test("replaces substring in description", async () => {
		const task = tracker.addChild(
			tracker.rootNodeId,
			"Task",
			"Build the auth module and deploy",
			{ editedBy: "agent" },
		);

		const result = surgicalReplace(
			task.description,
			"auth module",
			"payment module",
		);
		expect("description" in result).toBe(true);
		if ("description" in result) {
			const updated = await updateTaskOp(
				tracker,
				task.id,
				{ description: result.description },
				"agent",
				makeCallbacks(),
			);
			expect(updated.description).toBe("Build the payment module and deploy");
		}
	});

	test("old_description not found returns error", () => {
		const result = surgicalReplace(
			"Build the auth module",
			"payment module",
			"billing module",
		);
		expect("error" in result).toBe(true);
		if ("error" in result) {
			expect(result.error).toContain("not found");
		}
	});

	test("old_description not unique returns error", () => {
		const result = surgicalReplace(
			"Fix bug in auth. Fix bug in payment.",
			"Fix bug",
			"Resolve issue",
		);
		expect("error" in result).toBe(true);
		if ("error" in result) {
			expect(result.error).toContain("not unique");
		}
	});

	test("successful replacement persists through save/load", async () => {
		const task = tracker.addChild(
			tracker.rootNodeId,
			"Task",
			"Phase 1: types\nPhase 2: implementation\nPhase 3: tests",
			{ editedBy: "agent" },
		);

		const result = surgicalReplace(
			task.description,
			"Phase 2: implementation",
			"Phase 2: implementation (DONE)",
		);
		expect("description" in result).toBe(true);
		if ("description" in result) {
			await updateTaskOp(
				tracker,
				task.id,
				{ description: result.description },
				"agent",
				makeCallbacks(),
			);
		}

		// Reload and verify
		const tracker2 = new TaskTracker(join(tempDir, "tree.json"));
		await tracker2.load("main");
		const reloaded = tracker2.getTask(task.id);
		expect(reloaded?.description).toBe(
			"Phase 1: types\nPhase 2: implementation (DONE)\nPhase 3: tests",
		);
	});

	test("replaces only the first occurrence when unique", () => {
		const result = surgicalReplace(
			"The quick brown fox jumps over the lazy dog",
			"brown fox",
			"red fox",
		);
		expect("description" in result).toBe(true);
		if ("description" in result) {
			expect(result.description).toBe(
				"The quick red fox jumps over the lazy dog",
			);
		}
	});

	test("empty old_description matches at start", () => {
		// Empty string is found at index 0, and also at index 1, 2, etc.
		// indexOf("", 1) !== -1 → not unique
		const result = surgicalReplace("hello", "", "prefix-");
		expect("error" in result).toBe(true);
		if ("error" in result) {
			expect(result.error).toContain("not unique");
		}
	});
});
