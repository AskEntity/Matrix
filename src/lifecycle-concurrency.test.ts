/**
 * FIX-3 regression tests: lifecycle + provider concurrency bugs.
 *
 * Mutation-proofed — each test fails when the corresponding production fix is
 * reverted:
 *   - cc#3: Phase 2 + loop-promise resolution must live inside try/finally so the
 *     loop promise ALWAYS settles. A throwing Phase 2 must not strand it (the loop
 *     promise is exactly what stopTask/resetTask await — with no timeout — so a leak
 *     hangs them forever).
 *   - B-M4: task_complete must be durable BEFORE done_notified (append ordering).
 *   - B-H2: concurrent worktree-creating launches for the same fresh child must run
 *     beforeChildLaunch exactly ONCE (one `git worktree add`) with no bogus
 *     task_complete(failed) to the parent — across multiple launch entry points.
 *   - B-M3: a stop during the outer-retry backoff sleep must return promptly
 *     (abort-aware sleep), not block for the full backoff.
 *   - launch window: a node must read `in_progress` from the moment a launch is
 *     DECIDED, not from the moment its workspace is ready — otherwise close_task's
 *     only guard is blind for the seconds `git worktree add` takes.
 *
 * B-L9 (done-resume + compact → single user turn) lives in drift-lifecycle.test.ts
 * where the compact/restart harness already exists.
 *
 * The mock parses the agent's turn instruction out of the FIRST user message it
 * sees, so instructions are delivered AS message content (root prompt / task_message).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { EventStore } from "./event-store.ts";
import type { Event } from "./events.ts";
import { createTaskMessage } from "./queue-message-factory.ts";
import { deliverMessage, stopTask } from "./runtime/agent-lifecycle.ts";
import type { ScopeOpts } from "./runtime/context.ts";
import { getEventStore } from "./runtime/helpers.ts";
import { closeTaskOp } from "./task-operations.ts";
import { createMatrixApp as createApp } from "./test-utils/create-matrix-app.ts";
import { initTestProject } from "./test-utils/init-test-project.ts";
import {
	createMockedProviderWithMock,
	ValidatingMockAPI,
} from "./test-utils/mock-anthropic-api.ts";
import { TEST_CONFIG } from "./test-utils.ts";
import { toToolDefinition } from "./tool-def.ts";
import { createDoneTool, createYieldTool } from "./tools/prefab.ts";
import type { TaskNode } from "./types.ts";
import { ulid } from "./ulid.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Ctx {
	dataDir: string;
	projectDir: string;
	app: ReturnType<typeof createApp>;
	mockAPI: ValidatingMockAPI;
	provider: ReturnType<typeof createMockedProviderWithMock>;
	projectId: string;
}

async function setup(): Promise<Ctx> {
	const dataDir = await mkdtemp(join(tmpdir(), "mxd-lcc-data-"));
	const projectDir = await mkdtemp(join(tmpdir(), "mxd-lcc-proj-"));

	Bun.spawnSync(["git", "init"], { cwd: projectDir });
	Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
		cwd: projectDir,
	});
	Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: projectDir });
	await Bun.write(
		join(projectDir, ".gitignore"),
		"*\n!/.gitignore\n!/README.md\n!/.mxd/\n!/.mxd/**\n",
	);
	await Bun.write(join(projectDir, "README.md"), "# Test\n");
	Bun.spawnSync(["git", "add", "."], { cwd: projectDir });
	Bun.spawnSync(["git", "commit", "-m", "initial"], { cwd: projectDir });

	await initTestProject(projectDir);

	const tasksDir = join(projectDir, ".mxd", "tasks");
	if (existsSync(tasksDir)) rmSync(tasksDir, { recursive: true });

	const hookExample = join(
		projectDir,
		".mxd",
		"hooks",
		"setup_worktree.sh.example",
	);
	const hookActive = join(projectDir, ".mxd", "hooks", "setup_worktree.sh");
	if (existsSync(hookExample)) await rename(hookExample, hookActive);
	Bun.spawnSync(["git", "add", "."], { cwd: projectDir });
	Bun.spawnSync(["git", "commit", "-m", "hook"], { cwd: projectDir });

	const mockAPI = new ValidatingMockAPI();
	const provider = createMockedProviderWithMock(mockAPI);
	const projectId = ulid();
	const app = createApp({
		initialConfig: TEST_CONFIG,
		dataDir,
		agentProvider: provider,
		projects: [{ id: projectId, name: basename(projectDir), path: projectDir }],
	});
	app.markReady();

	return { dataDir, projectDir, app, mockAPI, provider, projectId };
}

async function teardown(ctx: Ctx): Promise<void> {
	await ctx.app.shutdown();
	await delay(50);
	await rm(ctx.dataDir, { recursive: true, force: true });
	await rm(ctx.projectDir, { recursive: true, force: true });
}

/**
 * Minimal non-Matrix ScopeOpts (no real git worktrees) with overridable hooks.
 * Provides done/yield tools + the loop-required hooks. Used to inject a throwing
 * onDone (cc#3) or a counting beforeChildLaunch (B-H2), and to give children a
 * done() tool that skips Matrix's worktree git-clean check (B-M4).
 */
function buildScopeOpts(
	// biome-ignore lint/suspicious/noExplicitAny: erased generic
	overrides: Partial<ScopeOpts<any>> = {},
	// biome-ignore lint/suspicious/noExplicitAny: erased generic
): ScopeOpts<any> {
	return {
		buildTools: (auth) => ({
			tools: [
				createYieldTool(),
				createDoneTool({
					extraParams: {
						status: {
							schema: z.enum(["passed", "failed"]),
							decl: { kind: "explicit" },
						},
						result: { schema: z.string(), decl: { kind: "explicit" } },
					},
				}),
			].map((def) => toToolDefinition(def, auth)),
		}),
		buildPrompt: () => ({ stable: "You are a test agent.", variable: "Test." }),
		buildWorkContext: () => "Test work context.",
		buildSummarizationPrompt: () => "Summarize.",
		shouldResume: (node: TaskNode) => node.status === "in_progress",
		onLaunch: (node: TaskNode, tracker) => {
			tracker.updateStatus(node.id, "in_progress");
		},
		// Runtime routes done → verify/failed; no default onDone content. Tests
		// that need to exercise onDone (e.g. the throwing-onDone Phase-2 case)
		// supply their own via `overrides`.
		...overrides,
	};
}

function doneInstruction(result = "ok"): string {
	return JSON.stringify({
		blocks: [
			{ type: "text", text: "Working." },
			{
				type: "tool_use",
				name: "mcp__mxd__done",
				input: { status: "passed", result },
			},
		],
	});
}

function yieldThenDoneInstruction(): string {
	return JSON.stringify({
		turns: [
			{ blocks: [{ type: "tool_use", name: "mcp__mxd__yield", input: {} }] },
			{
				blocks: [
					{ type: "text", text: "done now" },
					{
						type: "tool_use",
						name: "mcp__mxd__done",
						input: { status: "passed", result: "ok" },
					},
				],
			},
		],
	});
}

function yieldInstruction(): string {
	return JSON.stringify({
		blocks: [{ type: "tool_use", name: "mcp__mxd__yield", input: {} }],
	});
}

async function getRootId(ctx: Ctx): Promise<string> {
	const tracker = await ctx.app.getTracker(ctx.projectId);
	return tracker.rootNodeId;
}

async function postMessage(
	ctx: Ctx,
	nodeId: string,
	content: string,
): Promise<Response> {
	return ctx.app.app.request(
		`/projects/${ctx.projectId}/tasks/${nodeId}/message`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content }),
		},
	);
}

async function createChild(ctx: Ctx, title: string): Promise<string> {
	const rootId = await getRootId(ctx);
	const res = await ctx.app.app.request(`/projects/${ctx.projectId}/tasks`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ title, description: "", parentId: rootId }),
	});
	const node = (await res.json()) as TaskNode;
	return node.id;
}

async function waitForIdle(ctx: Ctx, nodeId: string, ms = 8000): Promise<void> {
	const tracker = await ctx.app.getTracker(ctx.projectId);
	const start = Date.now();
	while (Date.now() - start < ms) {
		if (tracker.getTask(nodeId)?.session?.queue?.idle) return;
		await delay(25);
	}
	throw new Error(`node ${nodeId} did not go idle within ${ms}ms`);
}

async function readEvents(ctx: Ctx, sessionId: string): Promise<Event[]> {
	const store = ctx.app.ctx.eventStores.get(ctx.projectId);
	if (store) await store.flushSession(sessionId);
	const fresh = new EventStore(
		join(ctx.dataDir, "projects", ctx.projectId, "tasks"),
	);
	return fresh.read(sessionId);
}

// ════════════════════════════════════════════════════════════════════════
// cc#3 — Phase 2 throw must not strand the loop promise
// ════════════════════════════════════════════════════════════════════════

describe("cc#3: Phase 2 throw → loop promise still settles", () => {
	let ctx: Ctx;
	afterEach(async () => {
		if (ctx) await teardown(ctx);
	});

	test("a throwing onDone (Phase 2) still resolves the loop promise and clears agentLoopPromises", async () => {
		ctx = await setup();
		// onDone throws → Phase 2 throws. Before the fix, resolveLoopPromise() and the
		// agentLoopPromises.delete() sat AFTER Phase 2, OUTSIDE any try/finally, so the
		// throw skipped both → the loop promise leaked forever (stopTask/resetTask, which
		// await it with no timeout, would hang).
		ctx.app.ctx.scopeOpts.set(
			ctx.projectId,
			buildScopeOpts({
				onDone: () => {
					throw new Error("cc#3 simulated Phase 2 failure");
				},
			}),
		);

		const rootId = await getRootId(ctx);
		// yield first → gives us a stable point to grab the loop promise while idle,
		// before the wake triggers done() → Phase 2 (onDone throws).
		await postMessage(ctx, rootId, yieldThenDoneInstruction());
		await waitForIdle(ctx, rootId);

		const loopPromise = ctx.app.ctx.agentLoopPromises.get(rootId);
		expect(loopPromise).toBeDefined();
		let settled = false;
		loopPromise?.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);

		// Wake → turn 2 → done() → Phase 2 onDone throws.
		await postMessage(ctx, rootId, "wake");

		const start = Date.now();
		while (Date.now() - start < 5000) {
			if (settled && !ctx.app.ctx.agentLoopPromises.has(rootId)) break;
			await delay(25);
		}

		// The loop promise (exactly what stopTask/resetTask await) MUST resolve, and
		// the map entry MUST be cleared — both happen only in the new Phase-2 finally.
		// WITHOUT the fix: settled stays false and the entry leaks.
		expect(settled).toBe(true);
		expect(ctx.app.ctx.agentLoopPromises.has(rootId)).toBe(false);
	}, 20000);
});

// ════════════════════════════════════════════════════════════════════════
// B-M4 — task_complete durable BEFORE done_notified (append ordering)
// ════════════════════════════════════════════════════════════════════════

describe("B-M4: task_complete is durable before done_notified", () => {
	let ctx: Ctx;
	afterEach(async () => {
		if (ctx) await teardown(ctx);
	});

	test("when done_notified is written, task_complete is ALREADY durable in the parent JSONL", async () => {
		ctx = await setup();
		// Custom scope so the child's done() skips Matrix's worktree git-clean check
		// and no real worktree/branch is required. Phase 2 ordering is runtime logic,
		// independent of scope.
		ctx.app.ctx.scopeOpts.set(ctx.projectId, buildScopeOpts());

		const rootId = await getRootId(ctx);
		const childId = await createChild(ctx, "B-M4 child");
		const parentJsonl = join(
			ctx.dataDir,
			"projects",
			ctx.projectId,
			"tasks",
			`${rootId}.jsonl`,
		);

		// Spy: at the EXACT moment the child's done_notified is appended, read the
		// parent JSONL from disk and record whether task_complete is already present.
		// getEventStore get-or-creates + registers the store so the agent run reuses
		// this exact spied instance.
		const store = getEventStore(ctx.app.ctx, ctx.projectId);
		const origAppend = store.append.bind(store);
		// Holder object (not a bare `let`) so TS doesn't narrow the closure-assigned
		// value back to its `null` initializer at the assertion site.
		const probe: { durable: boolean | null } = { durable: null };
		store.append = (sessionId: string, event: Event) => {
			if (
				sessionId === childId &&
				event.type === "done_notified" &&
				probe.durable === null
			) {
				try {
					probe.durable = readFileSync(parentJsonl, "utf8").includes(
						'"source":"task_complete"',
					);
				} catch {
					// Parent JSONL not even created yet → task_complete not durable.
					probe.durable = false;
				}
			}
			return origAppend(sessionId, event);
		};

		await deliverMessage(
			ctx.app.ctx,
			{ id: ctx.projectId, path: ctx.projectDir },
			childId,
			createTaskMessage(rootId, "Root", doneInstruction("child done")),
		);

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const start = Date.now();
		while (Date.now() - start < 10000) {
			if (
				probe.durable !== null &&
				tracker.getTask(childId)?.status === "verify"
			)
				break;
			await delay(30);
		}

		// THE INVARIANT (B-M4): the done_notified marker is only written AFTER
		// task_complete is durable on the parent's disk. Reverting to fire-and-forget
		// deliverMessage (+ dropping the flush) makes done_notified emit synchronously,
		// before task_complete is even appended → false here.
		expect(probe.durable).toBe(true);

		store.append = origAppend;
	}, 25000);
});

// ════════════════════════════════════════════════════════════════════════
// B-H2 — concurrent launches create the worktree exactly once
// ════════════════════════════════════════════════════════════════════════

describe("B-H2: launch lock serializes worktree creation", () => {
	let ctx: Ctx;
	afterEach(async () => {
		if (ctx) await teardown(ctx);
	});

	/** ScopeOpts whose beforeChildLaunch counts invocations and delays to widen the race. */
	function countingScopeOpts(counter: { n: number }) {
		return buildScopeOpts({
			beforeChildLaunch: async (node, tracker, projectPath) => {
				counter.n++;
				// Widen the window between the lock check and the assignWorktree so two
				// UNLOCKED callers would both be inside here at the same time.
				await delay(120);
				const wt = join(projectPath, ".wt", node.id);
				tracker.assignWorktree(node.id, `branch-${node.id}`, wt);
				node.cwd = wt;
				return { cwd: wt };
			},
		});
	}

	test("two concurrent deliverMessage to a fresh child → beforeChildLaunch runs ONCE, no task_complete(failed) to parent", async () => {
		ctx = await setup();
		const counter = { n: 0 };
		ctx.app.ctx.scopeOpts.set(ctx.projectId, countingScopeOpts(counter));

		const rootId = await getRootId(ctx);
		const childId = await createChild(ctx, "race child");

		// Two deliverMessage concurrently — each auto-launches via ensureChildAgentRunning.
		// send_message routes here too (its inline create was removed), so this also
		// covers the former second-create path. The yield instruction keeps the child
		// alive (idle) after launch.
		await Promise.all([
			deliverMessage(
				ctx.app.ctx,
				{ id: ctx.projectId, path: ctx.projectDir },
				childId,
				createTaskMessage(rootId, "Root", yieldInstruction()),
			),
			deliverMessage(
				ctx.app.ctx,
				{ id: ctx.projectId, path: ctx.projectDir },
				childId,
				createTaskMessage(rootId, "Root", yieldInstruction()),
			),
		]);

		await delay(600);

		// Exactly one worktree creation. Reverting the lock-at-top fix makes this 2.
		expect(counter.n).toBe(1);

		const tracker = await ctx.app.getTracker(ctx.projectId);
		// The loser must NOT have marked the child failed.
		expect(tracker.getTask(childId)?.status).not.toBe("failed");

		// The parent (root) must NOT have received a task_complete(failed). That bogus
		// completion is what deliverMessage.catch emits when a duplicate worktree create
		// throws. Inspect the root JSONL for any task_complete with success=false.
		const events = await readEvents(ctx, rootId);
		const bogus = events.filter(
			(e) =>
				e.type === "message" &&
				typeof e.body === "object" &&
				e.body != null &&
				(e.body as { source?: string }).source === "task_complete" &&
				(e.body as { success?: boolean }).success === false,
		);
		expect(bogus).toHaveLength(0);

		await stopTask(ctx.app.ctx, ctx.projectId, childId);
	}, 25000);

	test("path #3: two concurrent REST reactivations of a verify child → ONE worktree create", async () => {
		ctx = await setup();
		const counter = { n: 0 };
		ctx.app.ctx.scopeOpts.set(ctx.projectId, countingScopeOpts(counter));

		const childId = await createChild(ctx, "verify child");
		// Put the child into verify with NO worktree — the state the REST continue
		// endpoint's reactivation branch (FIX-2's third create path) handles.
		const tracker = await ctx.app.getTracker(ctx.projectId);
		tracker.updateStatus(childId, "verify");
		await tracker.save();

		// Two concurrent reactivations of the SAME node. Each enters the
		// `(verify && !worktreePath)` branch and would call beforeChildLaunch; the
		// lock added in tasks.ts must serialize them. The continue endpoint returns
		// promptly (c.json after firing runAgentForNode), so awaiting both is safe.
		const continueReq = () =>
			ctx.app.app.request(
				`/projects/${ctx.projectId}/tasks/${childId}/continue`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ message: yieldInstruction() }),
				},
			);
		await Promise.all([continueReq(), continueReq()]);

		await delay(600);

		// Exactly one beforeChildLaunch. WITHOUT the tasks.ts lock, both reactivations
		// run beforeChildLaunch → counter 2 (and a real `git worktree add` would have
		// one of them 500).
		expect(counter.n).toBe(1);
		expect(tracker.getTask(childId)?.status).not.toBe("failed");

		await stopTask(ctx.app.ctx, ctx.projectId, childId);
	}, 25000);
});

// ════════════════════════════════════════════════════════════════════════
// B-M3 — stop during outer-retry backoff returns promptly (abort-aware sleep)
// ════════════════════════════════════════════════════════════════════════

describe("B-M3: outer-retry backoff is abort-aware", () => {
	let ctx: Ctx;
	afterEach(async () => {
		if (ctx) await teardown(ctx);
	});

	test("stopTask during the retry backoff returns well before the backoff elapses", async () => {
		ctx = await setup();
		// Long backoff so a non-abort-aware sleep would block for seconds.
		const BACKOFF_MS = 4000;
		(
			ctx.provider as unknown as { outerRetryDelayMs: () => number }
		).outerRetryDelayMs = () => BACKOFF_MS;
		// Fail the API call repeatedly so the loop parks in the backoff sleep.
		ctx.mockAPI.injectError({ onRequest: 1, error: "rate_limit", count: 10 });

		const rootId = await getRootId(ctx);
		await postMessage(ctx, rootId, doneInstruction());

		// Wait until the loop is registered and the first API call has failed into the
		// backoff sleep.
		const loopStart = Date.now();
		while (Date.now() - loopStart < 4000) {
			if (ctx.app.ctx.agentLoopPromises.has(rootId)) break;
			await delay(20);
		}
		await delay(400);

		// stopTask awaits the loop promise with NO timeout — its duration IS the loop's
		// abort latency. Abort-aware sleep → resolves at once. Plain setTimeout → blocks
		// the remaining backoff (~4s).
		const stopStart = Date.now();
		await stopTask(ctx.app.ctx, ctx.projectId, rootId);
		const elapsed = Date.now() - stopStart;
		expect(elapsed).toBeLessThan(BACKOFF_MS - 1000);
	}, 25000);
});

// ════════════════════════════════════════════════════════════════════════
// The launch window — a node reads `in_progress` from the moment a launch is
// DECIDED, not from the moment its workspace is ready
// ════════════════════════════════════════════════════════════════════════

/**
 * `close_task` refuses exactly one status, `in_progress`, and that guard is the
 * only thing standing between a close and a live agent. The status used to be
 * set at the END of the launch — after `beforeChildLaunch`, which for Matrix is
 * `git worktree add` and takes SECONDS — so for that whole span the node still
 * read `pending` / `verify` / `closed` and a close sailed straight through: the
 * worktree removed, the node marked closed, and the agent then coming up on it.
 * Nothing throws and nothing crashes; the tree says closed while the process
 * runs.
 *
 * The fix flips the status in the SAME SYNCHRONOUS TICK as the launch lock, so
 * there is no await between "we decided to launch" and "the node says so": the
 * window is ZERO rather than smaller, resting on the same single-threaded
 * discipline the launch lock itself already relies on.
 *
 * TWO doors reach that window and both are covered here — `deliverMessage` →
 * `ensureChildAgentRunning` (via the `onLaunch` hook) and the REST `/continue`
 * reactivation branch (which flips the status itself). A rule enforced at one
 * of two doors is enforced nowhere.
 */
describe("launch window: the status flip precedes workspace prep", () => {
	let ctx: Ctx;
	afterEach(async () => {
		if (ctx) await teardown(ctx);
	});

	/**
	 * A launch parked inside `beforeChildLaunch`: `entered` resolves once the
	 * hook is running, and the hook stays there until `release()` — i.e. the
	 * launch window, held open for as long as the test needs it.
	 */
	function launchGate() {
		const r: { entered?: () => void; release?: () => void } = {};
		const entered = new Promise<void>((res) => {
			r.entered = res;
		});
		const held = new Promise<void>((res) => {
			r.release = res;
		});
		return {
			entered,
			held,
			signalEntered: () => r.entered?.(),
			release: () => r.release?.(),
		};
	}

	function parkingScopeOpts(
		gate: ReturnType<typeof launchGate>,
		opts: { fail?: boolean } = {},
	) {
		return buildScopeOpts({
			beforeChildLaunch: async (node, tracker, projectPath) => {
				gate.signalEntered();
				await gate.held;
				if (opts.fail) throw new Error("simulated worktree failure");
				const wt = join(projectPath, ".wt", node.id);
				tracker.assignWorktree(node.id, `branch-${node.id}`, wt);
				node.cwd = wt;
				return { cwd: wt };
			},
		});
	}

	/** close_task's callbacks, recording every worktree removal it asks for. */
	function closeCallbacks(removed: string[]) {
		return {
			broadcastTree: () => {},
			removeWorktree: async (taskId: string) => {
				removed.push(taskId);
			},
			clearEventStore: () => {},
		};
	}

	async function continueReq(ctx: Ctx, nodeId: string): Promise<Response> {
		return ctx.app.app.request(
			`/projects/${ctx.projectId}/tasks/${nodeId}/continue`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message: yieldInstruction() }),
			},
		);
	}

	test("door 1 (deliverMessage): close during the launch window is refused, and nothing is torn down", async () => {
		ctx = await setup();
		const gate = launchGate();
		ctx.app.ctx.scopeOpts.set(ctx.projectId, parkingScopeOpts(gate));

		const rootId = await getRootId(ctx);
		const childId = await createChild(ctx, "closable child");
		const tracker = await ctx.app.getTracker(ctx.projectId);
		// A fresh child is `pending` — a status close_task accepts.
		expect(tracker.getTask(childId)?.status).toBe("pending");

		// deliverMessage persists the message and fires the launch in the
		// background; the launch parks inside beforeChildLaunch, exactly where
		// production spends seconds in `git worktree add`.
		await deliverMessage(
			ctx.app.ctx,
			{ id: ctx.projectId, path: ctx.projectDir },
			childId,
			createTaskMessage(rootId, "Root", yieldInstruction()),
		);
		await gate.entered;

		// THE WINDOW. Before the fix the node still reads "pending" here.
		const removed: string[] = [];
		await expect(
			closeTaskOp(tracker, childId, closeCallbacks(removed)),
		).rejects.toThrow("Cannot close a running task");

		// Assert the DAMAGE is absent, not merely that a string was thrown: on
		// the old code the close SUCCEEDS, and what it leaves behind is a node
		// marked closed with its worktree pulled out from under a starting agent.
		expect(tracker.getTask(childId)?.status).toBe("in_progress");
		expect(removed).toEqual([]);

		gate.release();
		await waitForIdle(ctx, childId);
		await stopTask(ctx.app.ctx, ctx.projectId, childId);
	}, 25000);

	test("door 2 (REST /continue): close during the reactivation window is refused", async () => {
		ctx = await setup();
		const gate = launchGate();
		ctx.app.ctx.scopeOpts.set(ctx.projectId, parkingScopeOpts(gate));

		const childId = await createChild(ctx, "reactivated child");
		const tracker = await ctx.app.getTracker(ctx.projectId);
		// verify + no worktree — the reactivation branch, and a status
		// close_task accepts.
		tracker.updateStatus(childId, "verify");
		await tracker.save();

		// NOT awaited: the handler is parked inside beforeChildLaunch.
		const req = continueReq(ctx, childId);
		await gate.entered;

		const removed: string[] = [];
		await expect(
			closeTaskOp(tracker, childId, closeCallbacks(removed)),
		).rejects.toThrow("Cannot close a running task");
		expect(tracker.getTask(childId)?.status).toBe("in_progress");
		expect(removed).toEqual([]);

		gate.release();
		expect((await req).status).toBe(200);
		await waitForIdle(ctx, childId);
		await stopTask(ctx.app.ctx, ctx.projectId, childId);
	}, 25000);

	test("door 2 failure path: a reactivation that throws restores the status it found, so the node stays closable", async () => {
		// The early flip makes the FAILURE path load-bearing. Leaving this door's
		// node at `in_progress` would invent a state the old code never produced:
		// no agent, and close_task now refuses it — while the caller has just been
		// handed a 500 and nothing to act on. So this door puts back what it
		// found. The deliverMessage door deliberately does NOT restore:
		// reportAutoLaunchFailure marks that node `failed` (pinned by
		// integration.test.ts), which is both accurate and closable.
		ctx = await setup();
		const gate = launchGate();
		ctx.app.ctx.scopeOpts.set(
			ctx.projectId,
			parkingScopeOpts(gate, { fail: true }),
		);

		const childId = await createChild(ctx, "doomed reactivation");
		const tracker = await ctx.app.getTracker(ctx.projectId);
		tracker.updateStatus(childId, "verify");
		await tracker.save();

		const req = continueReq(ctx, childId);
		await gate.entered;
		gate.release();

		expect((await req).status).toBe(500);
		expect(tracker.getTask(childId)?.status).toBe("verify");

		// …and "closable" is the property that matters, so assert it rather than
		// inferring it from the status.
		const removed: string[] = [];
		await closeTaskOp(tracker, childId, closeCallbacks(removed));
		expect(tracker.getTask(childId)?.status).toBe("closed");
	}, 25000);
});
