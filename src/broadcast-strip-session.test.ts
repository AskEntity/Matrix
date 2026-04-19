/**
 * Regression test: broadcastTreeUpdate must strip runtime-only `session`
 * fields before crossing the worker→shell postMessage boundary.
 *
 * ## Bug history
 *
 * FU8 removed a triple-JSON-serialize step in the SSE relay path:
 *   broadcast → worker.onBroadcast(postMessage) → daemon SSE fanout
 *
 * The old JSON serialize layer silently dropped non-cloneable fields
 * (functions, AbortController, class instances with method refs).
 * `broadcastTreeUpdate` relied on that accidental sanitization: it passed
 * `tracker.allNodes()` straight through, with live `TaskSession` objects
 * attached.
 *
 * Once the serialize layer was removed, `postMessage` performed a raw
 * `structuredClone` on the event payload — which throws `DataCloneError`
 * on the live session objects. Every `create_task`/`update_task`/etc.
 * call returned `isError: true` to the agent from then on.
 *
 * Hot-fix (commit 84369e3): `broadcastTreeUpdate` now runs
 * `tracker.allNodes().map((n) => isTask(n) ? stripSession(n) : n)`
 * before broadcasting.
 *
 * ## What this test proves
 *
 * 1. With the fix in place, `broadcastTreeUpdate` on a tracker that has a
 *    live session produces a payload that passes `structuredClone`
 *    cleanly (positive regression).
 *
 * 2. If we simulate the pre-fix behavior (broadcast unstripped nodes),
 *    `structuredClone` throws — which is exactly what the test harness's
 *    `onBroadcast` wrapper (in `create-matrix-app.ts`) detects. This is
 *    the mutation proof: the harness DOES catch this class of bug, so if
 *    the fix is ever reverted or a new broadcast site forgets to strip,
 *    every integration test that touches the tree will fail loudly.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageQueue } from "./message-queue.ts";
import type { RuntimeContext } from "./runtime/context.ts";
import { broadcast, broadcastTreeUpdate } from "./runtime/event-system.ts";
import { TaskTracker } from "./task-tracker.ts";
import { isTask, type TaskSession } from "./types.ts";

async function makeTrackerWithRunningTask(): Promise<{
	tracker: TaskTracker;
	dir: string;
}> {
	const dir = await mkdtemp(join(tmpdir(), "mxd-strip-session-"));
	const tracker = new TaskTracker(join(dir, "tree.json"));
	await tracker.load("main");

	const root = tracker.getTask(tracker.rootNodeId);
	if (!root) throw new Error("root not found");

	// Real non-cloneable references: AbortController (always throws on
	// structuredClone), MessageQueue with a function hook (onPersist).
	const session: TaskSession = {
		queue: new MessageQueue({ onPersist: () => {} }),
		abortController: new AbortController(),
		loopTraceId: "test-trace",
		depth: 0,
		backgroundProcesses: new Map(),
		foregroundExecutions: new Map(),
	};
	root.session = session;

	return { tracker, dir };
}

function makeMinimalCtx(
	onBroadcast: (projectId: string, event: Record<string, unknown>) => void,
): RuntimeContext {
	// broadcast() touches only onBroadcast and eventSubscribers; the rest is
	// irrelevant for this code path.
	return {
		onBroadcast,
		eventSubscribers: new Map(),
	} as unknown as RuntimeContext;
}

describe("broadcastTreeUpdate: strip runtime-only session", () => {
	test("fix in place: broadcastTreeUpdate with live session does NOT throw on structuredClone", async () => {
		const { tracker } = await makeTrackerWithRunningTask();
		const root = tracker.getTask(tracker.rootNodeId);
		expect(root?.session).toBeTruthy();
		expect(root?.session?.abortController).toBeInstanceOf(AbortController);

		let broadcasted: Record<string, unknown> | null = null;
		const ctx = makeMinimalCtx((_, event) => {
			// Mimic production's postMessage boundary: structuredClone is what
			// actually enforces cloneability between worker and shell.
			structuredClone({ event });
			broadcasted = event;
		});

		// Must not throw — stripSession removes session before broadcast.
		expect(() => broadcastTreeUpdate(ctx, "proj", tracker)).not.toThrow();

		expect(broadcasted).toBeTruthy();
		const payload = broadcasted as unknown as { nodes: unknown[] };
		for (const n of payload.nodes) {
			// Every task node in the payload must have had its session stripped.
			expect((n as { session?: unknown }).session).toBeUndefined();
			// Folders don't have session at all — isTask guard is fine.
			if (isTask(n as Parameters<typeof isTask>[0])) {
				expect(n).not.toHaveProperty("session");
			}
		}
	});

	test("mutation proof: broadcasting unstripped nodes THROWS on structuredClone", async () => {
		// Simulate a regression where a broadcast site forgot to strip. If this
		// scenario is ever silently allowed (e.g. someone resurrects a JSON-
		// serialize hop), the test below would pass instead of throw — which
		// is exactly what we DON'T want, and what this assertion guards.
		const { tracker } = await makeTrackerWithRunningTask();

		const ctx = makeMinimalCtx((_, event) => {
			// Same structuredClone semantic as the test harness's onBroadcast
			// wrapper (see src/test-utils/create-matrix-app.ts).
			structuredClone({ event });
		});

		expect(() =>
			broadcast(ctx, "proj", {
				type: "tree_updated",
				// Pre-fix shape: raw tracker nodes, session NOT stripped.
				nodes: tracker.allNodes(),
				rootNodeId: tracker.rootNodeId,
			}),
		).toThrow();
	});
});
