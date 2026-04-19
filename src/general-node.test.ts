/**
 * GeneralNode exercise — a non-folder general node ("probe") rides through
 * every path in the tree system.
 *
 * Matrix's actual tree only has `type: "folder"` as a general node variant.
 * This test proves the generalization works: a hypothetical second plugin
 * that adds its own `GeneralNode.type` values would compose cleanly through
 * addGeneralNode, round-trip serialization, ownership walks, and tracker
 * helpers without touching runtime code.
 *
 * Covers the "new test" bullet in P2+P3 scope.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskTracker } from "./task-tracker.ts";
import { type GeneralNode, isGeneral, isTask } from "./types.ts";

describe("GeneralNode — plugin-defined types beyond folder", () => {
	let tempDir: string;
	let tracker: TaskTracker;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-general-node-"));
		tracker = new TaskTracker(join(tempDir, "tree.json"));
		await tracker.load("main");
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("addGeneralNode accepts arbitrary type string with metadata", () => {
		const probe = tracker.addGeneralNode("Probe", tracker.rootNodeId, "probe", {
			custom: "data",
		});
		expect(probe.type).toBe("probe");
		expect(probe.metadata).toEqual({ custom: "data" });
		expect(probe.title).toBe("Probe");
		expect(probe.children).toEqual([]);
	});

	test("addGeneralNode rejects type='task' (reserved for TaskNode)", () => {
		expect(() =>
			tracker.addGeneralNode("Bogus", tracker.rootNodeId, "task"),
		).toThrow(/task/i);
	});

	test("isGeneral / isTask discriminate cleanly", () => {
		const probe = tracker.addGeneralNode("Probe", tracker.rootNodeId, "probe");
		const task = tracker.addChild(tracker.rootNodeId, "Real Task", "desc");

		expect(isGeneral(probe)).toBe(true);
		expect(isTask(probe)).toBe(false);
		expect(isGeneral(task)).toBe(false);
		expect(isTask(task)).toBe(true);
	});

	test("probe node round-trips through save/load", async () => {
		const probe = tracker.addGeneralNode("Probe", tracker.rootNodeId, "probe", {
			pluginData: 42,
		});
		await tracker.save();

		const tracker2 = new TaskTracker(join(tempDir, "tree.json"));
		await tracker2.load();
		const loaded = tracker2.get(probe.id);
		if (!loaded) throw new Error("probe not found after reload");
		expect(isGeneral(loaded)).toBe(true);
		expect((loaded as GeneralNode).type).toBe("probe");
		expect((loaded as GeneralNode).metadata).toEqual({ pluginData: 42 });
	});

	test("runAgentForNode-style predicate filters out general nodes", () => {
		tracker.addGeneralNode("Probe", tracker.rootNodeId, "probe");
		const task = tracker.addChild(tracker.rootNodeId, "Real Task", "desc");

		// Mirrors the pattern used in runtime.ts + agent-lifecycle: iterate
		// allNodes and skip anything not a task.
		const launchable = tracker.allNodes().filter(isTask);
		expect(launchable.map((n) => n.id)).toContain(task.id);
		expect(launchable.map((n) => n.id)).toContain(tracker.rootNodeId);
		expect(launchable.find((n) => n.title === "Probe")).toBeUndefined();
	});

	test("getTaskAbove walks through probe node to owning task", () => {
		// root → probe → task
		const probe = tracker.addGeneralNode(
			"Probe Wrapper",
			tracker.rootNodeId,
			"probe",
		);
		const task = tracker.addChild(probe.id, "Deep task", "desc");

		const above = tracker.getTaskAbove(task.id);
		expect(above?.id).toBe(tracker.rootNodeId);
	});

	test("getTasksBelow recurses transparently through probe node", () => {
		// root → probe → task1
		//             → task2
		const probe = tracker.addGeneralNode(
			"Probe Wrapper",
			tracker.rootNodeId,
			"probe",
		);
		const task1 = tracker.addChild(probe.id, "Task 1", "desc");
		const task2 = tracker.addChild(probe.id, "Task 2", "desc");

		const below = tracker.getTasksBelow(tracker.rootNodeId).map((n) => n.id);
		expect(below).toContain(task1.id);
		expect(below).toContain(task2.id);
		// probe itself shouldn't appear (only tasks)
		expect(below).not.toContain(probe.id);
	});

	test("reparent moves probe node with its task children", () => {
		const probe = tracker.addGeneralNode("Probe", tracker.rootNodeId, "probe");
		const task = tracker.addChild(probe.id, "Inside", "desc");
		const newParent = tracker.addTask("New", "desc");

		tracker.reparent(probe.id, newParent.id);
		expect(tracker.get(probe.id)?.parentId).toBe(newParent.id);
		expect(tracker.getTask(task.id)?.parentId).toBe(probe.id);
	});

	test("byStatus excludes probe nodes (they have no status)", () => {
		tracker.addGeneralNode("Probe", tracker.rootNodeId, "probe");
		tracker.addTask("Draft Task", "desc", { draft: true });

		const drafts = tracker.byStatus("draft");
		expect(drafts.length).toBe(1);
		expect(drafts[0]?.title).toBe("Draft Task");
	});

	test("probe node without metadata omits the field on round-trip", async () => {
		const probe = tracker.addGeneralNode(
			"No meta",
			tracker.rootNodeId,
			"probe",
		);
		expect(probe.metadata).toBeUndefined();
		await tracker.save();

		const tracker2 = new TaskTracker(join(tempDir, "tree.json"));
		await tracker2.load();
		const loaded = tracker2.get(probe.id);
		expect((loaded as GeneralNode).metadata).toBeUndefined();
	});
});
