/**
 * Agent activity: the backend's explicit three-state answer to "what is this
 * agent doing", replacing three competing frontend heuristics.
 *
 * The states are asymmetric on purpose (see AgentActivity in types.ts):
 *   • `tool` is precise — the ONLY state with an unclosed tool_call, which is
 *     what an interrupt must repair. Downstream interrupt work keys on it.
 *   • `idle` is empty — the loop is parked on the queue.
 *   • `thinking` is the RESIDUAL — every other way the loop is alive.
 *
 * These tests assert the STATE VALUES the backend reports, never a UI symptom:
 * the whole point is that the distinction exists in the runtime rather than
 * being inferred from the shape of the log.
 *
 * Every transition point is covered by a test that fails when that single
 * `setActivity` call is removed:
 *   • `idle` in handleImplicitYield        → "parks on the queue"
 *   • `idle` in the initial drain          → "launched with an empty queue"
 *   • `thinking` at the API-call block     → "returns to thinking after a tool turn"
 *   • `tool` before tool execution         → "is `tool` WHILE a tool runs"
 *   • `state: null` at session teardown    → "session end"
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	createDoneTool,
	createYieldTool,
	defineTool,
	toToolDefinition,
	z,
} from "./plugin-sdk.ts";
import { getSession } from "./resource-registry.ts";
import type { ScopeOpts } from "./runtime/context.ts";
import { subscribeToEvents } from "./runtime/event-system.ts";
import { createMatrixApp as createApp } from "./test-utils/create-matrix-app.ts";
import {
	createMockedProviderWithMock,
	ValidatingMockAPI,
} from "./test-utils/mock-anthropic-api.ts";
import { TEST_CONFIG } from "./test-utils.ts";
import type { AgentActivity, TaskNode } from "./types.ts";
import { ulid } from "./ulid.ts";

// ── Test infrastructure ──

interface TestContext {
	dataDir: string;
	projectDir: string;
	app: ReturnType<typeof createApp>;
	mockAPI: ValidatingMockAPI;
	projectId: string;
	/** Every agent_activity broadcast, in order: [taskId, state]. */
	activityLog: Array<[string, AgentActivity | null]>;
	unsubscribe: () => void;
}

/** What `probe_state` saw when it ran, keyed by nothing — one probe per test. */
let probeObservation: {
	taskId: string;
	state: AgentActivity | undefined;
} | null = null;

/**
 * A tool that reports the activity state observed FROM INSIDE its own
 * execution. This is the direct observation of the `tool` window: while this
 * handler runs there is an unclosed tool_call in the JSONL, which is exactly
 * what `tool` is defined to mean.
 */
const probeStateTool = defineTool({
	name: "probe_state",
	description: "Report the agent's own activity state while running.",
	availability: "internal",
	params: {
		projectId: {
			schema: z.string(),
			decl: { kind: "bind", from: "projectId" },
		},
		taskId: { schema: z.string(), decl: { kind: "bind", from: "taskId" } },
	},
	handler: async (args) => {
		const session = getSession(args.projectId, args.taskId);
		probeObservation = { taskId: args.taskId, state: session?.activity };
		return {
			content: [{ type: "text" as const, text: `state=${session?.activity}` }],
			isError: false,
		};
	},
});

// biome-ignore lint/suspicious/noExplicitAny: test scope, generic erased
function buildProbeScopeOpts(): ScopeOpts<any> {
	return {
		buildTools: (auth, _taskId) => ({
			tools: [
				probeStateTool,
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
		buildPrompt: () => ({ stable: "You are a probe agent.", variable: "" }),
		buildWorkContext: () => "Probe context.",
		buildSummarizationPrompt: () => "Summarize.",
		shouldResume: (node: TaskNode) => node.status === "in_progress",
		onLaunch: (node: TaskNode, tracker) => {
			tracker.updateStatus(node.id, "in_progress");
		},
	};
}

async function setupTestContext(): Promise<TestContext> {
	const dataDir = await mkdtemp(join(tmpdir(), "mxd-activity-data-"));
	const projectDir = await mkdtemp(join(tmpdir(), "mxd-activity-project-"));

	Bun.spawnSync(["git", "init"], { cwd: projectDir });
	Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
		cwd: projectDir,
	});
	Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: projectDir });
	await Bun.write(join(projectDir, "README.md"), "# Test Project\n");
	Bun.spawnSync(["git", "add", "."], { cwd: projectDir });
	Bun.spawnSync(["git", "commit", "-m", "initial"], { cwd: projectDir });

	const mockAPI = new ValidatingMockAPI();
	mockAPI.enableStrictToolErrors();
	const provider = createMockedProviderWithMock(mockAPI);

	const projectId = ulid();
	const appResult = createApp({
		initialConfig: TEST_CONFIG,
		dataDir,
		agentProvider: provider,
		projects: [{ id: projectId, name: basename(projectDir), path: projectDir }],
	});
	appResult.markReady();
	appResult.ctx.scopeOpts.set(projectId, buildProbeScopeOpts());

	const activityLog: Array<[string, AgentActivity | null]> = [];
	const unsubscribe = subscribeToEvents(appResult.ctx, projectId, (event) => {
		if (event.type !== "agent_activity") return;
		const e = event as unknown as {
			taskId: string;
			state: AgentActivity | null;
		};
		activityLog.push([e.taskId, e.state]);
	});

	probeObservation = null;

	return {
		dataDir,
		projectDir,
		app: appResult,
		mockAPI,
		projectId,
		activityLog,
		unsubscribe,
	};
}

async function teardownTestContext(ctx: TestContext): Promise<void> {
	ctx.unsubscribe();
	await ctx.app.shutdown();
	await new Promise((r) => setTimeout(r, 50));
	await rm(ctx.dataDir, { recursive: true, force: true });
	await rm(ctx.projectDir, { recursive: true, force: true });
}

async function postMessage(
	ctx: TestContext,
	nodeId: string,
	instruction: string,
): Promise<void> {
	const resp = await ctx.app.app.request(
		`/projects/${ctx.projectId}/tasks/${nodeId}/message`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: instruction }),
		},
	);
	expect(resp.status).toBe(200);
}

/** Poll until `pred` holds, or throw with the states seen so far. */
async function waitFor(
	pred: () => boolean,
	describeFailure: () => string,
	timeoutMs = 15000,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (pred()) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error(`Timed out waiting: ${describeFailure()}`);
}

/** The states broadcast for one task, in order. */
function statesFor(
	ctx: TestContext,
	taskId: string,
): Array<AgentActivity | null> {
	return ctx.activityLog.filter(([id]) => id === taskId).map(([, s]) => s);
}

/** Live state as the backend stores it (undefined = no session). */
function storedState(
	ctx: TestContext,
	taskId: string,
): AgentActivity | undefined {
	return getSession(ctx.projectId, taskId)?.activity;
}

/** Instruction: call probe_state, then done("passed"). */
function probeThenDone(marker: string): string {
	return JSON.stringify({
		turns: [
			{
				blocks: [
					{ type: "tool_use", name: "mcp__mxd__probe_state", input: {} },
				],
			},
			{
				blocks: [
					{
						type: "tool_use",
						name: "mcp__mxd__done",
						input: { status: "passed", result: marker },
					},
				],
			},
		],
	});
}

// ── Tests ──

describe("Agent activity: three states, one source", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	}, 20000);

	test("is `tool` WHILE a tool runs — observed from inside the tool itself", async () => {
		ctx = await setupTestContext();
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootId = tracker.rootNodeId;

		await postMessage(ctx, rootId, probeThenDone("probe-done"));
		await waitFor(
			() => probeObservation !== null,
			() => "probe tool never ran",
		);

		// The direct observation: mid-execution, with an unclosed tool_call in
		// the JSONL, the stored state is exactly `tool`. Not "some non-idle
		// value" — the distinction is what interrupt semantics depend on.
		expect(probeObservation?.taskId).toBe(rootId);
		expect(probeObservation?.state).toBe("tool");
	}, 20000);

	test("reports thinking → tool → thinking across a tool turn", async () => {
		ctx = await setupTestContext();
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootId = tracker.rootNodeId;

		await postMessage(ctx, rootId, probeThenDone("seq-done"));
		await waitFor(
			() => tracker.getTask(rootId)?.status === "verify",
			() => `status=${tracker.getTask(rootId)?.status}`,
		);

		const states = statesFor(ctx, rootId);
		// Collapse repeats so the assertion is about ORDER, not how many times
		// the loop happened to re-announce the same state.
		const shape = states.filter((s, i) => s !== states[i - 1]);

		// thinking (session created + first API call) → tool (probe) →
		// thinking (the API call that follows the tool result) → null (done).
		expect(shape[0]).toBe("thinking");
		expect(shape).toContain("tool");
		const firstTool = shape.indexOf("tool");
		// A `thinking` AFTER the tool window: this is what dies if the
		// API-call block stops announcing itself — the state would simply
		// stay `tool` through the next model call.
		expect(shape.slice(firstTool + 1)).toContain("thinking");
		// Session teardown always closes the sequence.
		expect(shape[shape.length - 1]).toBe(null);
	}, 20000);

	test("parks on the queue as `idle`, and the snapshot route agrees", async () => {
		ctx = await setupTestContext();
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootId = tracker.rootNodeId;

		// One turn of text, then end_turn → implicit yield → parked on queue.
		await postMessage(
			ctx,
			rootId,
			JSON.stringify({ blocks: [{ type: "text", text: "waiting for you" }] }),
		);
		await waitFor(
			() => storedState(ctx, rootId) === "idle",
			() => `stored=${storedState(ctx, rootId)} seen=${statesFor(ctx, rootId)}`,
		);

		expect(statesFor(ctx, rootId)).toContain("idle");

		// The ASK half: what a newly-connecting client is told.
		const resp = await ctx.app.app.request(
			`/projects/${ctx.projectId}/agent/status`,
		);
		expect(resp.status).toBe(200);
		const { states } = (await resp.json()) as {
			states: Record<string, AgentActivity>;
		};
		expect(states[rootId]).toBe("idle");
	}, 20000);

	test("waking from idle leaves `idle` BEFORE the woken turn is processed", async () => {
		// The window between `queue.wait()` returning and the next API call:
		// draining, filtering, building the user turn. The loop is provably not
		// parked there, so the STORED state must not still say idle — consumers
		// read the field, not the event sequence. `yield_external`'s fast path
		// is the one that bites: send_user_message → yield_external is a
		// documented workflow, and it would answer "the agent stopped working"
		// at the exact moment the agent started.
		ctx = await setupTestContext();
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootId = tracker.rootNodeId;

		// Sample the stored state at a moment strictly INSIDE the window:
		// messages_consumed for the woken turn is emitted after the drain and
		// before the API call.
		let sawIdle = false;
		const insideWindow: Array<AgentActivity | undefined> = [];
		const unsub = subscribeToEvents(ctx.app.ctx, ctx.projectId, (event) => {
			if (event.taskId !== rootId) return;
			if (event.type === "agent_activity") {
				if ((event as { state?: string }).state === "idle") sawIdle = true;
				return;
			}
			if (sawIdle && event.type === "messages_consumed") {
				insideWindow.push(storedState(ctx, rootId));
			}
		});

		try {
			const park = JSON.stringify({
				blocks: [{ type: "text", text: "parking" }],
			});
			await postMessage(ctx, rootId, park);
			await waitFor(
				() => storedState(ctx, rootId) === "idle",
				() => `stored=${storedState(ctx, rootId)}`,
			);

			// Wake it. The agent processes the message, then parks again.
			await postMessage(ctx, rootId, park);
			await waitFor(
				() => insideWindow.length > 0,
				() => `no messages_consumed observed after idle`,
			);
		} finally {
			unsub();
		}

		// Sampled from inside the wake window — not idle, and specifically the
		// residual state.
		expect(insideWindow[0]).toBe("thinking");
	}, 20000);

	test("a launch whose message is already queued announces NO idle", async () => {
		// The other half of "only when it really parks". The normal launch has
		// its triggering message in the queue, so the initial drain's wait()
		// resolves immediately — the agent never waited for input, and this run
		// ends in done() without ever parking. A single `idle` anywhere in the
		// sequence would be a pause that never happened, and both consumers act
		// on it (external-client wake, Edit/Rewind re-fetch).
		ctx = await setupTestContext();
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootId = tracker.rootNodeId;

		await postMessage(ctx, rootId, probeThenDone("no-idle"));
		await waitFor(
			() => tracker.getTask(rootId)?.status === "verify",
			() => `status=${tracker.getTask(rootId)?.status}`,
		);

		expect(statesFor(ctx, rootId)).not.toContain("idle");
	}, 20000);

	test("an agent launched with an EMPTY queue reports idle (initial drain)", async () => {
		// The fifth place the loop parks on the queue, and the only one outside
		// handleImplicitYield. It used to announce nothing at all, so an agent
		// waiting for its first message looked busy to every client.
		//
		// Reaching it takes care: a launch normally enqueues a work_context
		// message before the loop starts, and with something already queued the
		// drain does not park (and correctly says nothing). `buildWorkContext`
		// is optional on ScopeOpts, so a scope without one launches into a
		// genuinely empty queue — that is the state under test.
		//
		// An earlier version of this test used the normal scope and passed
		// anyway: the agent ran a turn, ended it, and parked in
		// handleImplicitYield instead. It was named for the initial drain and
		// measured a different transition. Mutation testing is what exposed it,
		// which is the argument for doing it per transition point rather than
		// once at the end.
		ctx = await setupTestContext();
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const child = tracker.addChild(tracker.rootNodeId, "Empty", "no messages");
		await tracker.save();

		const project = ctx.app.ctx.pm.get(ctx.projectId);
		if (!project) throw new Error("project missing");
		const scopeOpts = ctx.app.ctx.scopeOpts.get(ctx.projectId);
		if (!scopeOpts) throw new Error("scope opts missing");
		// Deliberately NOT awaited: the call resolves only when the agent loop
		// exits, and this agent is supposed to sit there waiting forever.
		const { runAgentForNode } = await import("./runtime/agent-lifecycle.ts");
		void runAgentForNode(ctx.app.ctx, project, tracker, child.id, {
			...scopeOpts,
			buildWorkContext: () => null,
		});

		await waitFor(
			() => storedState(ctx, child.id) === "idle",
			() =>
				`stored=${storedState(ctx, child.id)} seen=${statesFor(ctx, child.id)}`,
		);
		expect(statesFor(ctx, child.id)).toEqual(["thinking", "idle"]);
	}, 20000);

	test("session end broadcasts state null and drops the task from the snapshot", async () => {
		ctx = await setupTestContext();
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootId = tracker.rootNodeId;

		await postMessage(ctx, rootId, probeThenDone("end-done"));
		await waitFor(
			() => tracker.getTask(rootId)?.status === "verify",
			() => `status=${tracker.getTask(rootId)?.status}`,
		);

		// Without this broadcast the last state a task reported (thinking, or
		// tool) would sit in every client's map forever — a spinner for an
		// agent that is gone.
		expect(statesFor(ctx, rootId)[statesFor(ctx, rootId).length - 1]).toBe(
			null,
		);
		expect(storedState(ctx, rootId)).toBeUndefined();

		const resp = await ctx.app.app.request(
			`/projects/${ctx.projectId}/agent/status`,
		);
		const { states } = (await resp.json()) as {
			states: Record<string, AgentActivity>;
		};
		expect(rootId in states).toBe(false);
	}, 20000);

	test("stopping one task broadcasts null for it (stopTask teardown)", async () => {
		// Three places clear node.session and each must announce it. This is
		// the stopTask one: it clears the session ITSELF and then awaits the
		// loop, so runAgentForNode's finally sees a replaced session and skips
		// its own teardown — the announcement cannot be inherited from there.
		ctx = await setupTestContext();
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootId = tracker.rootNodeId;

		await postMessage(
			ctx,
			rootId,
			JSON.stringify({ blocks: [{ type: "text", text: "parking" }] }),
		);
		await waitFor(
			() => storedState(ctx, rootId) === "idle",
			() => `stored=${storedState(ctx, rootId)}`,
		);

		const resp = await ctx.app.app.request(
			`/projects/${ctx.projectId}/tasks/${rootId}/stop`,
			{ method: "POST" },
		);
		expect(resp.status).toBe(200);

		const states = statesFor(ctx, rootId);
		expect(states[states.length - 1]).toBe(null);
		expect(storedState(ctx, rootId)).toBeUndefined();
	}, 20000);

	test("stopping the project broadcasts null for it (stopAgent teardown)", async () => {
		// The third site: the project-wide stop loops over every running node
		// and clears each session.
		ctx = await setupTestContext();
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootId = tracker.rootNodeId;

		await postMessage(
			ctx,
			rootId,
			JSON.stringify({ blocks: [{ type: "text", text: "parking" }] }),
		);
		await waitFor(
			() => storedState(ctx, rootId) === "idle",
			() => `stored=${storedState(ctx, rootId)}`,
		);

		const resp = await ctx.app.app.request(`/projects/${ctx.projectId}/stop`, {
			method: "POST",
		});
		expect(resp.status).toBe(200);

		const states = statesFor(ctx, rootId);
		expect(states[states.length - 1]).toBe(null);
		expect(storedState(ctx, rootId)).toBeUndefined();
	}, 20000);

	test("a task with no agent has NO entry — absence is not `idle`", async () => {
		ctx = await setupTestContext();
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const child = tracker.addChild(
			tracker.rootNodeId,
			"Never run",
			"idle task",
		);
		await tracker.save();

		const resp = await ctx.app.app.request(
			`/projects/${ctx.projectId}/agent/status`,
		);
		const { states } = (await resp.json()) as {
			states: Record<string, AgentActivity>;
		};
		expect(child.id in states).toBe(false);
	}, 20000);

	test("activity is never persisted to JSONL", async () => {
		// The structural guarantee behind "replaying history must not
		// fake-activate": the event cannot reach a batch replay because it is
		// never written down.
		ctx = await setupTestContext();
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootId = tracker.rootNodeId;

		await postMessage(ctx, rootId, probeThenDone("persist-check"));
		await waitFor(
			() => tracker.getTask(rootId)?.status === "verify",
			() => `status=${tracker.getTask(rootId)?.status}`,
		);

		const store = ctx.app.ctx.eventStores.get(ctx.projectId);
		if (!store) throw new Error("no event store");
		await store.flushSession(rootId);
		const events = store.read(rootId);
		expect(events.length).toBeGreaterThan(0);
		expect(events.some((e) => e.type === "agent_activity")).toBe(false);
	}, 20000);
});
