/**
 * Backend test: does broadcastTreeUpdate carry the new color after updateTaskOp?
 *
 * The test IS the investigation for "task color change not reflecting in sidebar".
 * If this test passes, the backend path (updateColor → save → broadcast) is clean
 * and the bug lives in the frontend render or SSE delivery path.
 *
 * Pipeline under test:
 *   updateTaskOp(tracker, nodeId, { color: "purple" }, "user", callbacks)
 *     → tracker.updateColor(nodeId, resolveColor("purple"), "user")
 *     → tracker.save()
 *     → callbacks.broadcastTree()
 *         → broadcastTreeUpdate(ctx, projectId, tracker)
 *             → tracker.allNodes().map(n => isTask(n) ? stripSession(n) : n)
 *             → broadcast(ctx, projectId, { type: "tree_updated", nodes, rootNodeId })
 *
 * We capture the broadcast payload and assert node.color matches the updated value.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeContext } from "./runtime/context.ts";
import { broadcastTreeUpdate } from "./runtime/event-system.ts";
import { createTaskOp, updateTaskOp } from "./task-operations.ts";
import { TaskTracker } from "./task-tracker.ts";
import { isTask, type TaskNode } from "./types.ts";

let tempDir: string;
let tracker: TaskTracker;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "mxd-color-broadcast-"));
	tracker = new TaskTracker(join(tempDir, "tree.json"));
	await tracker.load("main");
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

/** Capture the last broadcast payload from broadcastTreeUpdate. */
function captureBroadcast(tracker: TaskTracker) {
	let lastPayload: {
		type: string;
		nodes: unknown[];
		rootNodeId: string;
	} | null = null;

	const ctx: RuntimeContext = {
		onBroadcast: (_projectId: string, event: Record<string, unknown>) => {
			lastPayload = event as typeof lastPayload;
		},
		eventSubscribers: new Map(),
	} as unknown as RuntimeContext;

	function broadcast() {
		broadcastTreeUpdate(ctx, "test-project", tracker);
	}

	function findNode(nodeId: string): TaskNode | undefined {
		if (!lastPayload) return undefined;
		return lastPayload.nodes.find(
			(n: unknown) => isTask(n as TaskNode) && (n as TaskNode).id === nodeId,
		) as TaskNode | undefined;
	}

	return { broadcast, findNode, getPayload: () => lastPayload };
}

function makeCallbacks(broadcastFn: () => void) {
	return {
		broadcastTree: broadcastFn,
		notifyTreeChange: () => {},
		notifyTargetNode: () => {},
		projectPath: tempDir,
	};
}

describe("task color in broadcastTreeUpdate", () => {
	test("create task with color → broadcast carries the color", async () => {
		const { broadcast, findNode } = captureBroadcast(tracker);

		const node = await createTaskOp(
			tracker,
			{
				title: "Blue Task",
				description: "test",
				parentId: tracker.rootNodeId,
				color: "blue",
			},
			"user",
			makeCallbacks(broadcast),
		);

		const broadcasted = findNode(node.id);
		expect(broadcasted).toBeDefined();
		expect(broadcasted!.color).toBe("#388bfd"); // blue → hex
	});

	test("update color → broadcast carries the NEW color", async () => {
		const { broadcast, findNode } = captureBroadcast(tracker);

		// Create with blue
		const node = await createTaskOp(
			tracker,
			{
				title: "Color Change Test",
				description: "test",
				parentId: tracker.rootNodeId,
				color: "blue",
			},
			"user",
			makeCallbacks(broadcast),
		);

		// Verify initial broadcast
		expect(findNode(node.id)!.color).toBe("#388bfd");

		// Update to purple
		await updateTaskOp(
			tracker,
			node.id,
			{ color: "purple" },
			"user",
			makeCallbacks(broadcast),
		);

		// THE KEY ASSERTION: broadcast after update carries the new color
		const updated = findNode(node.id);
		expect(updated).toBeDefined();
		expect(updated!.color).toBe("#a371f7"); // purple → hex
	});

	test("update color with hex value → broadcast carries exact hex", async () => {
		const { broadcast, findNode } = captureBroadcast(tracker);

		const node = await createTaskOp(
			tracker,
			{
				title: "Hex Color",
				description: "test",
				parentId: tracker.rootNodeId,
				color: "#ff5733",
			},
			"user",
			makeCallbacks(broadcast),
		);

		expect(findNode(node.id)!.color).toBe("#ff5733");

		// Update to a different hex
		await updateTaskOp(
			tracker,
			node.id,
			{ color: "#00ff00" },
			"user",
			makeCallbacks(broadcast),
		);

		expect(findNode(node.id)!.color).toBe("#00ff00");
	});

	test("clear color → broadcast node has no color", async () => {
		const { broadcast, findNode } = captureBroadcast(tracker);

		const node = await createTaskOp(
			tracker,
			{
				title: "Clear Color",
				description: "test",
				parentId: tracker.rootNodeId,
				color: "red",
			},
			"user",
			makeCallbacks(broadcast),
		);

		expect(findNode(node.id)!.color).toBe("#f85149");

		// Clear the color
		await updateTaskOp(
			tracker,
			node.id,
			{ color: null },
			"user",
			makeCallbacks(broadcast),
		);

		expect(findNode(node.id)!.color).toBeUndefined();
	});

	test("broadcast payload passes structuredClone (SSE safety)", async () => {
		const { broadcast, getPayload } = captureBroadcast(tracker);

		await createTaskOp(
			tracker,
			{
				title: "Clone Safe",
				description: "test",
				parentId: tracker.rootNodeId,
				color: "green",
			},
			"user",
			makeCallbacks(broadcast),
		);

		// The real production path sends the payload through postMessage which
		// uses structuredClone. Verify the payload survives cloning.
		const payload = getPayload();
		expect(payload).toBeDefined();
		const cloned = structuredClone(payload);
		const clonedNode = (cloned!.nodes as TaskNode[]).find(
			(n) => isTask(n) && n.title === "Clone Safe",
		) as TaskNode | undefined;
		expect(clonedNode).toBeDefined();
		expect(clonedNode!.color).toBe("#3fb950"); // green → hex
	});
});
