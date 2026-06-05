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
import { createMatrixApp as createApp } from "./test-utils/create-matrix-app.ts";
import { initTestProject } from "./test-utils/init-test-project.ts";
import {
	createMockedProviderWithMock,
	ValidatingMockAPI,
} from "./test-utils/mock-anthropic-api.ts";
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
						summary: { schema: z.string(), decl: { kind: "explicit" } },
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
		onDone: (node: TaskNode, tracker, doneArgs) => {
			tracker.updateStatus(
				node.id,
				doneArgs.status === "passed" ? "verify" : "failed",
			);
			return doneArgs;
		},
		...overrides,
	};
}

function doneInstruction(summary = "ok"): string {
	return JSON.stringify({
		blocks: [
			{ type: "text", text: "Working." },
			{
				type: "tool_use",
				name: "mcp__mxd__done",
				input: { status: "passed", summary },
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
						input: { status: "passed", summary: "ok" },
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
