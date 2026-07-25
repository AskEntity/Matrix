/**
 * Edit/Rewind gate.
 *
 * Two conditions, judged independently and for unrelated reasons:
 *   - `messageStartsRun` (run-start.ts): did the agent ever run FROM this
 *     message? If not, "regenerate from here" names nothing.
 *   - `isWorking` (agent-activity.ts): is the agent busy right now?
 *
 * The first half of this file pins the rule; the second half pins that the
 * `/edit` route actually enforces it, because a rule the backend doesn't run
 * is a suggestion.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWorking } from "../.mxd/plugin/agent-activity.ts";
import {
	editRefusalMessage,
	editVerdict,
} from "../.mxd/plugin/message-editability.ts";
import { hasRewindPoint } from "../.mxd/plugin/rewind-point.ts";
import {
	messageRunStarts,
	messageStartsRun,
	type RunEvent,
} from "../.mxd/plugin/run-start.ts";
import type { AgentProvider } from "./agent-provider.ts";
import type { Event } from "./events.ts";
import { MessageQueue } from "./message-queue.ts";
import { getEventStore } from "./runtime/helpers.ts";
import { createMatrixApp } from "./test-utils/create-matrix-app.ts";
import { attachMockSession } from "./test-utils.ts";
import { TOOL_DONE, TOOL_YIELD } from "./tool-names.ts";
import { ulid } from "./ulid.ts";

// ── the rule ──────────────────────────────────────────────────────────────

const TASK = "task-1";

function call(tool = "mcp__mxd__bash", taskId = TASK): RunEvent {
	return { type: "tool_call", tool, taskId };
}
function result(tool = "mcp__mxd__bash", taskId = TASK): RunEvent {
	return { type: "tool_result", tool, taskId };
}
function text(taskId = TASK): RunEvent {
	return { type: "assistant_text", taskId };
}
/** A delivered user message. `eid` doubles as its queue id for readability. */
function msg(eid: string, taskId = TASK): RunEvent {
	return { type: "message", id: eid, eid, taskId };
}
/** The turn that picked those messages up. */
function consumed(eids: string[], taskId = TASK): RunEvent {
	return { type: "messages_consumed", messageIds: eids, taskId };
}

describe("run-start: was this message sent on its own?", () => {
	test("a message the agent picked up by itself was sent on its own", () => {
		// Nothing to answer: the turn exists because the message arrived.
		const log = [text(), msg("m1"), consumed(["m1"])];
		expect(messageStartsRun(log, "m1")).toBe(true);
	});

	test("SHAPE 1 — typed in the thinking gap, before the tool_call is written", () => {
		// The live failure this rule was rewritten for (2026-07-25): the user
		// asked for a bash run, then added one more thing while the agent was
		// still composing the call. At DELIVERY there was no outstanding tool
		// call — which is why the old proxy called it editable — but it was
		// picked up together with that bash's result, so it plainly wasn't
		// sent on its own.
		const log = [
			msg("m1"),
			consumed(["m1"]), // "run a bash for me" — starts the run
			msg("m2"), // "…and one more thing" — arrives BEFORE the call
			call(),
			result(),
			consumed(["m2"]),
		];
		expect(messageStartsRun(log, "m1")).toBe(true);
		expect(messageStartsRun(log, "m2")).toBe(false);
	});

	test("typed while the tool was running is blocked the same way", () => {
		const log = [call(), msg("m1"), result(), consumed(["m1"])];
		expect(messageStartsRun(log, "m1")).toBe(false);
	});

	test("SHAPE 2 — two messages onto a parked agent: BOTH were sent on their own", () => {
		// They share a turn, and that is irrelevant: the turn answers nothing.
		// Rewinding to the first replaces both; rewinding to the second keeps
		// the first and redoes it. Both are meaningful, so neither is blocked.
		// Guards the over-strict direction — a rule keyed on "alone in its
		// turn" would fail here and still pass every blocking test.
		const log = [text(), msg("m1"), msg("m2"), consumed(["m1", "m2"])];
		expect(messageStartsRun(log, "m1")).toBe(true);
		expect(messageStartsRun(log, "m2")).toBe(true);
	});

	test("SHAPE 3 — waking an agent parked on done(): sent on its own", () => {
		// The dominant shape for sub-agents: every task ends in done() and is
		// later woken by a message. done's tool_result is written AT WAKE, so
		// it is this message's consequence, not work that preceded it. The
		// most independent message there is.
		const log = [
			call(TOOL_DONE),
			msg("m1"),
			result(TOOL_DONE),
			consumed(["m1"]),
		];
		expect(messageStartsRun(log, "m1")).toBe(true);
	});

	test("waking an agent parked on yield(): same", () => {
		const log = [
			call(TOOL_YIELD),
			msg("m1"),
			result(TOOL_YIELD),
			consumed(["m1"]),
		];
		expect(messageStartsRun(log, "m1")).toBe(true);
	});

	test("a park's result alongside a real one still counts as prior work", () => {
		// yield called next to real tools gets a no-op result; the real tool
		// genuinely ran, so its result is the message's cause.
		const log = [
			call(),
			call(TOOL_YIELD),
			msg("m1"),
			result(),
			result(TOOL_YIELD),
			consumed(["m1"]),
		];
		expect(messageStartsRun(log, "m1")).toBe(false);
	});

	test("a status event between the result and the consumption doesn't detach them", () => {
		// Unrecognised events must not end the turn: detaching a tool_result
		// is the direction that wrongly calls a message editable.
		const log = [
			call(),
			msg("m1"),
			result(),
			{ type: "status", taskId: TASK },
			consumed(["m1"]),
		];
		expect(messageStartsRun(log, "m1")).toBe(false);
	});

	test("a sibling task's turn says nothing about this one", () => {
		const log = [
			call("mcp__mxd__bash", "other-task"),
			result("mcp__mxd__bash", "other-task"),
			msg("m1"),
			consumed(["m1"]),
			{ type: "messages_consumed", messageIds: ["x"], taskId: "other-task" },
		];
		expect(messageStartsRun(log, "m1")).toBe(true);
	});

	test("an eid that names no message is undefined, not false", () => {
		// "we can't tell" — a different answer from "no", and it gets its
		// own refusal.
		expect(messageStartsRun([msg("m1"), consumed(["m1"])], "nope")).toBe(
			undefined,
		);
	});

	test("a message no turn has picked up yet has no answer", () => {
		// Delivered but not consumed: the agent has not looked at it, so
		// whether it started anything is not yet decided.
		expect(messageStartsRun([msg("m1")], "m1")).toBe(undefined);
	});

	test("one pass answers for every message in the log", () => {
		const starts = messageRunStarts([
			msg("m1"),
			consumed(["m1"]),
			call(),
			msg("m2"),
			result(),
			consumed(["m2"]),
			text(),
			msg("m3"),
			consumed(["m3"]),
		]);
		expect([...starts]).toEqual([
			["m1", true],
			["m2", false],
			["m3", true],
		]);
	});
});

// ── the verdict ───────────────────────────────────────────────────────────

describe("rewind-point: is there a state to go back to?", () => {
	const marker = { type: "compact_marker", eid: "c1" };

	test("without a compaction every position is a valid cut", () => {
		const chain = [{ type: "message", eid: "m1" }];
		expect(hasRewindPoint(chain, "m1")).toBe(true);
	});

	test("a message after the compaction has one", () => {
		const chain = [marker, { type: "message", eid: "m2" }];
		expect(hasRewindPoint(chain, "m2")).toBe(true);
	});

	test("a message the compaction carried across does not", () => {
		// Spliced into the active chain by the walk, but its parent link
		// points into the region the summary replaced.
		const chain = [{ type: "message", eid: "m1" }, marker];
		expect(hasRewindPoint(chain, "m1")).toBe(false);
	});

	test("an eid the chain doesn't hold has nothing to rewind either way", () => {
		expect(hasRewindPoint([marker], "nope")).toBe(false);
	});
});

describe("editVerdict: three conditions, permanent wins", () => {
	const ok = { startsRun: true, hasRewindPoint: true, agentBusy: false };

	test("a run start with somewhere to go, on a parked agent, is editable", () => {
		expect(editVerdict(ok)).toEqual({ editable: true });
	});

	test("a busy agent blocks it, transiently", () => {
		expect(editVerdict({ ...ok, agentBusy: true })).toEqual({
			editable: false,
			reason: "agent_busy",
		});
	});

	test("it decides nothing itself — the module has no imports", async () => {
		// The line editVerdict must not cross. It CONSUMES three verdicts; the
		// moment it computes one (reaches for an event, tests a tool name,
		// asks what the agent is doing) it stops being a presentation rule and
		// becomes the shared abstraction the three judgments are deliberately
		// not allowed to have. "No imports" is that boundary, mechanically.
		const src = await Bun.file(
			new URL("../.mxd/plugin/message-editability.ts", import.meta.url),
		).text();
		const code = src
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "");
		expect(code).not.toMatch(/^\s*import\s/m);
	});

	test("a message that started no run is blocked even when idle", () => {
		expect(editVerdict({ ...ok, startsRun: false })).toEqual({
			editable: false,
			reason: "did_not_start_run",
		});
	});

	test("a message with no state to return to is blocked when idle too", () => {
		expect(editVerdict({ ...ok, hasRewindPoint: false })).toEqual({
			editable: false,
			reason: "no_rewind_point",
		});
	});

	test("PERMANENT outranks TRANSIENT when both apply", () => {
		// "wait for the agent to stop" would be a lie here: the user waits,
		// the agent stops, the button is still grey, and now they can't tell
		// whether they waited wrong or the product is broken.
		expect(editVerdict({ ...ok, startsRun: false, agentBusy: true })).toEqual({
			editable: false,
			reason: "did_not_start_run",
		});
		expect(
			editVerdict({ ...ok, hasRewindPoint: false, agentBusy: true }),
		).toEqual({ editable: false, reason: "no_rewind_point" });
	});

	test("an unknown message outranks everything", () => {
		expect(
			editVerdict({
				startsRun: undefined,
				hasRewindPoint: false,
				agentBusy: true,
			}),
		).toEqual({ editable: false, reason: "unknown_message" });
	});

	test("every reason gets its own sentence", () => {
		const said = [
			editRefusalMessage("agent_busy"),
			editRefusalMessage("did_not_start_run"),
			editRefusalMessage("no_rewind_point"),
			editRefusalMessage("unknown_message"),
		];
		expect(new Set(said).size).toBe(4);
		for (const s of said) expect(s.length).toBeGreaterThan(20);
		// The transient one is the only one that tells you to do something.
		expect(editRefusalMessage("agent_busy")).toMatch(/stop/i);
	});

	test("isWorking: absent and idle are both parked", () => {
		expect(isWorking(undefined)).toBe(false);
		expect(isWorking("idle")).toBe(false);
		expect(isWorking("thinking")).toBe(true);
		expect(isWorking("tool")).toBe(true);
	});
});

// ── the route ─────────────────────────────────────────────────────────────

const mockProvider: AgentProvider = {
	name: "mock",
	execute: async () => ({
		exitReason: "interrupted" as const,
		output: "",
		costUsd: 0,
		turns: 0,
		sessionId: "mock-session",
	}),
	// biome-ignore lint/correctness/useYield: mock provider — drains then exits
	stream: async function* (req) {
		const queue = req.queue ?? new MessageQueue();
		if (queue.pending > 0) queue.drain();
		return {
			exitReason: "interrupted" as const,
			output: "",
			costUsd: 0,
			turns: 0,
			sessionId: "mock-session",
		};
	},
};

/** Named so a mutation failure reads as a sentence about what broke. */
const SUMMARIZED_AWAY =
	"HISTORY THE COMPACTION REPLACED — this must never come back";
const SUMMARY = "<summary>the summary that replaced it</summary>";

describe("POST /edit enforces the gate", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createMatrixApp>["app"];
	let ctx: ReturnType<typeof createMatrixApp>["ctx"];
	let shutdown: ReturnType<typeof createMatrixApp>["shutdown"];
	let projectId: string;
	let rootNodeId: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-editgate-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-editgate-data-"));
		const { registerRoutes } = await import("../.mxd/plugin/runtime.ts");
		const project = {
			id: ulid(),
			name: "edit-gate",
			path: join(tempDir, "edit-gate"),
		};
		const result = createMatrixApp({
			dataDir,
			agentProvider: mockProvider,
			projects: [project],
			registerPluginRoutes: registerRoutes,
		});
		app = result.app;
		ctx = result.ctx;
		shutdown = result.shutdown;
		projectId = project.id;
		rootNodeId = (await result.getTracker(projectId)).rootNodeId;
	});

	afterEach(async () => {
		// Shut down BEFORE removing the dirs. An accepted edit delivers a
		// message, which launches an agent whose fire-and-forget tracker.save
		// otherwise races the rm and fails with ENOENT — the flake shape
		// documented for tracker.save's temp+rename.
		await shutdown();
		await rm(tempDir, { recursive: true, force: true });
		await rm(dataDir, { recursive: true, force: true });
	});

	/** Seed a session log and hand back the eid of each user message. */
	async function seed(
		build: (taskId: string) => Event[],
	): Promise<{ eids: string[] }> {
		const store = getEventStore(ctx, projectId);
		for (const spec of build(rootNodeId)) {
			await store.append(rootNodeId, spec);
		}
		await store.flushSession(rootNodeId);
		const eids = store
			.read(rootNodeId)
			.filter((e) => e.type === "message")
			.map((e) => e.eid as string);
		return { eids };
	}

	function edit(eid: string, content = "edited") {
		return app.request(`/projects/${projectId}/tasks/${rootNodeId}/edit`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ eid, content }),
		});
	}

	/** [assistant turn] → yield → user message → wake. The common shape. */
	function parkedThenMessage(taskId: string): Event[] {
		const ts = Date.now();
		return [
			{ type: "assistant_text", content: "on it", taskId, ts },
			{
				type: "tool_call",
				tool: TOOL_YIELD,
				toolCallId: "y1",
				input: {},
				taskId,
				ts: ts + 1,
			},
			{
				type: "message",
				id: "m1",
				body: { source: "user", id: "m1", ts: ts + 2, content: "hello" },
				taskId,
				ts: ts + 2,
			},
			// Written at wake, by the very message that woke it.
			{
				type: "tool_result",
				tool: TOOL_YIELD,
				toolCallId: "y1",
				content: "resumed.",
				isError: false,
				taskId,
				ts: ts + 3,
			},
			{ type: "messages_consumed", messageIds: ["m1"], taskId, ts: ts + 4 },
		];
	}

	/** bash starts → user types → bash finishes. */
	function midToolMessage(taskId: string): Event[] {
		const ts = Date.now();
		return [
			{ type: "assistant_text", content: "running tests", taskId, ts },
			{
				type: "tool_call",
				tool: "mcp__mxd__bash",
				toolCallId: "b1",
				input: { command: "bun test" },
				taskId,
				ts: ts + 1,
			},
			{
				type: "message",
				id: "m1",
				body: { source: "user", id: "m1", ts: ts + 2, content: "wait" },
				taskId,
				ts: ts + 2,
			},
			{
				type: "tool_result",
				tool: "mcp__mxd__bash",
				toolCallId: "b1",
				content: "ok",
				isError: false,
				taskId,
				ts: ts + 3,
			},
			{ type: "messages_consumed", messageIds: ["m1"], taskId, ts: ts + 4 },
		];
	}

	test("a message sent to a parked agent can be edited", async () => {
		const { eids } = await seed(parkedThenMessage);
		const res = await edit(eids[0] as string);
		expect(res.status).toBe(200);
	});

	test("a message the agent swept up mid-tool-call is refused", async () => {
		const { eids } = await seed(midToolMessage);
		const res = await edit(eids[0] as string);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { reason: string; error: string };
		expect(body.reason).toBe("did_not_start_run");
		// The sentence has to explain, not just refuse.
		expect(body.error).toMatch(/on its own/i);
	});

	test("a working agent blocks even an otherwise editable message", async () => {
		const { eids } = await seed(parkedThenMessage);
		const tracker = ctx.trackers.get(projectId);
		const node = tracker?.getTask(rootNodeId);
		if (!node) throw new Error("no root node");
		const session = attachMockSession(node, new MessageQueue());
		session.activity = "tool";

		const res = await edit(eids[0] as string);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { reason: string; error: string };
		expect(body.reason).toBe("agent_busy");
		expect(body.error).toMatch(/stop/i);
	});

	test("an idle session does not block", async () => {
		const { eids } = await seed(parkedThenMessage);
		const tracker = ctx.trackers.get(projectId);
		const node = tracker?.getTask(rootNodeId);
		if (!node) throw new Error("no root node");
		const session = attachMockSession(node, new MessageQueue());
		session.activity = "idle";

		const res = await edit(eids[0] as string);
		expect(res.status).toBe(200);
	});

	test("when both conditions fail, the permanent one is reported", async () => {
		const { eids } = await seed(midToolMessage);
		const tracker = ctx.trackers.get(projectId);
		const node = tracker?.getTask(rootNodeId);
		if (!node) throw new Error("no root node");
		const session = attachMockSession(node, new MessageQueue());
		session.activity = "tool";

		const res = await edit(eids[0] as string);
		const body = (await res.json()) as { reason: string };
		expect(body.reason).toBe("did_not_start_run");
	});

	/**
	 * A completed compaction, with a user message that arrived while the
	 * summarizer was running. The walk SPLICES that message into the active
	 * chain (it is genuinely part of the agent's context) but its parent link
	 * still points at `compact_started`, inside the region the summary
	 * replaced.
	 */
	function compactionWindow(taskId: string): Event[] {
		const ts = Date.now();
		return [
			{
				type: "assistant_text",
				content: SUMMARIZED_AWAY,
				taskId,
				ts,
			},
			{ type: "compact_started", taskId, ts: ts + 1 },
			{
				type: "message",
				id: "m-window",
				body: {
					source: "user",
					id: "m-window",
					ts: ts + 2,
					content: "don't forget X",
				},
				taskId,
				ts: ts + 2,
			},
			// The summarizer's own output. The walk drops this one — the
			// summary reaches the next session as the compacted_resume
			// message below, which is what the agent actually reads.
			{
				type: "assistant_text",
				content: "<summary>…</summary>",
				taskId,
				ts: ts + 3,
			},
			{ type: "compact_marker", savedTokens: 1, taskId, ts: ts + 4 },
			{
				type: "message",
				id: "m-resume",
				body: {
					source: "compacted_resume",
					id: "m-resume",
					ts: ts + 5,
					content: SUMMARY,
				},
				taskId,
				ts: ts + 5,
			},
			{
				type: "messages_consumed",
				messageIds: ["m-window", "m-resume"],
				taskId,
				ts: ts + 6,
			},
		];
	}

	/**
	 * ⚠️ This limit looks arbitrary — the message IS in the agent's context,
	 * so why can't it be rewound? Because being in the context and being a
	 * cuttable point are different things, and the difference is measured,
	 * not hypothetical. Allowing it produces:
	 *
	 *   active BEFORE: [message:m-window, compact_marker, message:m-after]
	 *   active AFTER : [assistant_text, compact_started, message:m-edited]
	 *   pre-compact history resurrected? true    summary still present? false
	 *
	 * Rewinding sets the chain head to the target's parent. Here that is
	 * `compact_started`, which the walk only treats as a barrier once it has
	 * already passed a `compact_marker` — restarted from inside the window it
	 * never meets one, so it walks back to the first line of the file. On a
	 * large session that is the whole summarized-away history returning at
	 * once, with the summary that replaced it stranded on the abandoned
	 * branch. The assertions below are ordered so that removing the guard
	 * fails on the damage, not on a missing status code.
	 */
	test("a message the compaction carried across cannot be rewound into", async () => {
		const { eids } = await seed(compactionWindow);
		const store = getEventStore(ctx, projectId);

		const res = await edit(eids[0] as string);

		const active = store.readActive(rootNodeId);
		const resurrected = active
			.filter((e) => e.type === "assistant_text")
			.map((e) => (e.type === "assistant_text" ? e.content : ""))
			.filter((c) => c === SUMMARIZED_AWAY);
		expect(resurrected).toEqual([]);
		const summaries = active.flatMap((e) =>
			e.type === "message" && e.body && "content" in e.body
				? [e.body.content]
				: [],
		);
		expect(summaries).toContain(SUMMARY);
		expect(active.some((e) => e.type === "compact_marker")).toBe(true);

		expect(res.status).toBe(400);
		expect(((await res.json()) as { reason: string }).reason).toBe(
			"no_rewind_point",
		);
	});

	test("a message an earlier rewind cut away is no longer editable", async () => {
		const { eids } = await seed(parkedThenMessage);
		const first = eids[0] as string;
		// Rewind past it: the chain head jumps to its parent, so the next
		// appended event skips it and it leaves the active conversation.
		const store = getEventStore(ctx, projectId);
		const target = store.read(rootNodeId).find((e) => e.eid === first);
		const parentEid = target?.parentEid;
		if (!parentEid) throw new Error("seeded message has no parent");
		store.setChainHead(rootNodeId, parentEid);
		await store.append(rootNodeId, {
			type: "message",
			id: "m2",
			taskId: rootNodeId,
			body: { source: "user", id: "m2", ts: Date.now(), content: "redo" },
			ts: Date.now(),
		});
		await store.flushSession(rootNodeId);

		const res = await edit(first);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { reason: string };
		expect(body.reason).toBe("unknown_message");
	});
});
