/**
 * Regression guard: every destructive orchestrator tool must enforce
 * `checkPermission(auth, "subtree", ...)` on its target.
 *
 * The gap this closes (Audit G H1): `close_task`, `delete_task`,
 * `reset_task`, `update_task` (non-reparent), and folder ops previously
 * ran without any scope check. A bug/hallucination in one agent could
 * delete a sibling's worktree + JSONL with no recovery path.
 *
 * Pattern: two-task tree (agent + sibling). Agent calls the tool on the
 * sibling — must get `not your task or descendant`, sibling state intact.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestratorTools } from "./orchestrator-tools.ts";
import { resetResourceRegistry } from "./resource-registry.ts";
import { TaskTracker } from "./task-tracker.ts";
import { initMockResourceRegistry } from "./test-utils.ts";

async function invokeAs(
	tracker: TaskTracker,
	tempDir: string,
	currentTaskId: string,
	toolName: string,
	args: Record<string, unknown>,
) {
	resetResourceRegistry();
	const { auth } = initMockResourceRegistry({
		tracker,
		projectId: "test-project",
		projectPath: tempDir,
		taskId: currentTaskId,
	});
	const { toolDefs } = createOrchestratorTools(
		auth,
		"test-project",
		currentTaskId,
	);
	const tool = toolDefs.find((t) => t.name === toolName);
	if (!tool) throw new Error(`tool not found: ${toolName}`);
	// biome-ignore lint/suspicious/noExplicitAny: test helper signature
	return (tool as any).handler(args);
}

describe("subtree permission on destructive tools", () => {
	let tempDir: string;
	let tracker: TaskTracker;
	let parentId: string;
	let agentId: string;
	let siblingId: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-subtree-perm-"));
		tracker = new TaskTracker(join(tempDir, "tree.json"));
		const parent = tracker.addTask("parent", "");
		parentId = parent.id;
		const agent = tracker.addChild(parentId, "agent", "");
		agentId = agent.id;
		const sibling = tracker.addChild(parentId, "sibling", "");
		siblingId = sibling.id;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
	});

	// ── update_task ──

	test("agent cannot update_task on sibling's title/description/status", async () => {
		const r1 = await invokeAs(tracker, tempDir, agentId, "update_task", {
			taskId: siblingId,
			title: "hijacked",
		});
		expect(r1.isError).toBe(true);
		expect(r1.content[0].text).toContain("not your task or descendant");
		expect(tracker.getTask(siblingId)?.title).toBe("sibling");

		const r2 = await invokeAs(tracker, tempDir, agentId, "update_task", {
			taskId: siblingId,
			description: "rewritten",
		});
		expect(r2.isError).toBe(true);

		const r3 = await invokeAs(tracker, tempDir, agentId, "update_task", {
			taskId: siblingId,
			status: "closed",
		});
		expect(r3.isError).toBe(true);
		expect(tracker.getTask(siblingId)?.status).not.toBe("closed");
	});

	test("agent CAN update its own task", async () => {
		const r = await invokeAs(tracker, tempDir, agentId, "update_task", {
			taskId: agentId,
			title: "agent renamed",
		});
		expect(r.isError).toBeFalsy();
		expect(tracker.getTask(agentId)?.title).toBe("agent renamed");
	});

	test("agent CAN update a descendant", async () => {
		const descendant = tracker.addChild(agentId, "descendant", "");
		const r = await invokeAs(tracker, tempDir, agentId, "update_task", {
			taskId: descendant.id,
			title: "child renamed",
		});
		expect(r.isError).toBeFalsy();
		expect(tracker.getTask(descendant.id)?.title).toBe("child renamed");
	});

	// ── close_task ──

	test("agent cannot close_task on sibling", async () => {
		tracker.updateStatus(siblingId, "verify");
		const r = await invokeAs(tracker, tempDir, agentId, "close_task", {
			taskId: siblingId,
		});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("not your task or descendant");
		expect(tracker.getTask(siblingId)?.status).toBe("verify");
	});

	// ── delete_task ──

	test("agent cannot delete_task on sibling", async () => {
		const r = await invokeAs(tracker, tempDir, agentId, "delete_task", {
			taskId: siblingId,
		});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("not your task or descendant");
		expect(tracker.getTask(siblingId)).toBeDefined();
	});

	// ── reset_task ──

	test("agent cannot reset_task on sibling", async () => {
		tracker.updateStatus(siblingId, "in_progress");
		const r = await invokeAs(tracker, tempDir, agentId, "reset_task", {
			taskId: siblingId,
		});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("not your task or descendant");
		expect(tracker.getTask(siblingId)?.status).toBe("in_progress");
	});

	// ── folder ops ──

	test("agent cannot delete_folder owned by sibling", async () => {
		const foreignFolder = tracker.addFolder("sibling-folder", siblingId);
		const r = await invokeAs(tracker, tempDir, agentId, "delete_folder", {
			folderId: foreignFolder.id,
		});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("not your task or descendant");
		expect(tracker.get(foreignFolder.id)).toBeDefined();
	});

	test("agent cannot rename_folder owned by sibling", async () => {
		const foreignFolder = tracker.addFolder("sibling-folder", siblingId);
		const r = await invokeAs(tracker, tempDir, agentId, "rename_folder", {
			folderId: foreignFolder.id,
			title: "hijacked",
		});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("not your task or descendant");
		expect(tracker.get(foreignFolder.id)?.title).toBe("sibling-folder");
	});

	test("agent cannot create_folder under a sibling", async () => {
		const r = await invokeAs(tracker, tempDir, agentId, "create_folder", {
			parentId: siblingId,
			title: "hijack-folder",
		});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("not your task or descendant");
	});

	test("agent CAN create_folder under itself", async () => {
		const r = await invokeAs(tracker, tempDir, agentId, "create_folder", {
			parentId: agentId,
			title: "my-folder",
		});
		expect(r.isError).toBeFalsy();
	});

	// ── reparent ──

	test("reparent still fails if EITHER source or new parent is out-of-subtree", async () => {
		const child = tracker.addChild(agentId, "agent-child", "");
		// Source (agent-child) is in subtree, but new parent (sibling) isn't.
		const r1 = await invokeAs(tracker, tempDir, agentId, "update_task", {
			taskId: child.id,
			parentId: siblingId,
		});
		expect(r1.isError).toBe(true);
		expect(tracker.getTask(child.id)?.parentId).toBe(agentId);

		// Source (sibling) is out of subtree, new parent (agent) in subtree.
		const r2 = await invokeAs(tracker, tempDir, agentId, "update_task", {
			taskId: siblingId,
			parentId: agentId,
		});
		expect(r2.isError).toBe(true);
		expect(tracker.getTask(siblingId)?.parentId).toBe(parentId);
	});
});
