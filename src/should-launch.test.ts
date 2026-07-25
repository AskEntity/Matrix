/**
 * `shouldLaunchAgent` — "will launching this node produce an action, or will
 * it just park?"
 *
 * Answered from the log alone so it can run BEFORE a session exists, because
 * session construction (MCP connect, work context, session_config) is the
 * entire cost being avoided.
 *
 * ## Why this file leans on a differential test
 *
 * The predicate is an EXTRACTION of what the provider loop already decides on
 * resume, not a second opinion. A shape table alone would pin the extraction's
 * current answers without pinning the thing that makes them correct — that the
 * loop agrees. So the table below is checked twice: once against the expected
 * verdict, and once against the loop's own gate order recomputed from the real
 * walker (`eventsToAnthropicMessages`) and the real repair
 * (`buildSessionRepair`). If someone changes the walker so a shape's message
 * list ends on a different role, the differential test fails even though every
 * hand-written expectation still passes.
 */
import { describe, expect, test } from "bun:test";
import { eventsToAnthropicMessages } from "./anthropic-compatible-provider.ts";
import {
	buildSessionRepair,
	type Event,
	hasPendingImplicitYield,
	shouldLaunchAgent,
} from "./events.ts";
import { createInterruptNotice } from "./queue-message-factory.ts";
import { TOOL_DONE, TOOL_YIELD } from "./tool-names.ts";

// ── Event factory. `eid` on everything: buildSessionRepair throws on an
//    unstamped event, and every event on a real active chain is stamped.

let seq = 0;
const eid = () => `e${(seq++).toString(16).padStart(4, "0")}`;
const T = "t1";

function chain(events: Array<Omit<Event, "eid" | "parentEid">>): Event[] {
	let parent: string | null = null;
	return events.map((e) => {
		const id = eid();
		const out = { ...e, eid: id, parentEid: parent } as Event;
		parent = id;
		return out;
	});
}

const msg = (id: string, content: string) =>
	({
		type: "message",
		id,
		taskId: T,
		ts: 1,
		body: { source: "user", id, ts: 1, content },
	}) as Omit<Event, "eid" | "parentEid">;
/** Returns the `id` alongside so tests can build a messages_consumed for it. */
const interruptMsg = (): Omit<Event, "eid" | "parentEid"> & { id: string } => {
	const m = createInterruptNotice();
	return {
		type: "message",
		id: m.id,
		taskId: T,
		ts: m.ts,
		body: m,
	} as Omit<Event, "eid" | "parentEid"> & { id: string };
};
const treeChangeMsg = (id: string) =>
	({
		type: "message",
		id,
		taskId: T,
		ts: 1,
		body: { source: "tree_change", id, ts: 1, action: "updated", nodeId: "n1" },
	}) as Omit<Event, "eid" | "parentEid">;
const consumed = (ids: string[]) =>
	({
		type: "messages_consumed",
		messageIds: ids,
		taskId: T,
		ts: 1,
	}) as Omit<Event, "eid" | "parentEid">;
const text = (c: string) =>
	({ type: "assistant_text", content: c, taskId: T, ts: 1 }) as Omit<
		Event,
		"eid" | "parentEid"
	>;
const think = (c: string) =>
	({
		type: "thinking",
		thinking: c,
		signature: "sig",
		taskId: T,
		ts: 1,
	}) as Omit<Event, "eid" | "parentEid">;
const call = (id: string, tool = "mcp__mxd__bash") =>
	({
		type: "tool_call",
		toolCallId: id,
		tool,
		input: {},
		taskId: T,
		ts: 1,
	}) as Omit<Event, "eid" | "parentEid">;
const result = (id: string, tool = "mcp__mxd__bash") =>
	({
		type: "tool_result",
		toolCallId: id,
		tool,
		content: "ok",
		isError: false,
		taskId: T,
		ts: 1,
	}) as Omit<Event, "eid" | "parentEid">;
const usage = () =>
	({
		type: "usage",
		taskId: T,
		ts: 1,
		inputTokens: 1,
		outputTokens: 1,
	}) as unknown as Omit<Event, "eid" | "parentEid">;
const agentStart = () =>
	({ type: "agent_start", taskId: T, ts: 1 }) as unknown as Omit<
		Event,
		"eid" | "parentEid"
	>;
const agentEnd = () =>
	({ type: "agent_end", taskId: T, ts: 1 }) as unknown as Omit<
		Event,
		"eid" | "parentEid"
	>;

/** A settled conversation opening so every shape below is realistic. */
const HEAD = [msg("m0", "hello"), consumed(["m0"])];

// ── The shape table. Every row of the task's VERIFICATION section lives here.

interface Shape {
	name: string;
	events: Event[];
	launch: boolean;
	why: string;
}

const SHAPES: Shape[] = [
	{
		name: "dormant: parked after end_turn",
		events: chain([...HEAD, think("t"), text("hi"), usage(), agentEnd()]),
		launch: false,
		why: "verification 5 — the shape 6 of today's 15 dormant nodes are in",
	},
	{
		name: "dormant: parked on yield()",
		events: chain([
			...HEAD,
			text("hi"),
			call("y1", TOOL_YIELD),
			usage(),
			agentEnd(),
			agentStart(),
		]),
		launch: false,
		why: "the shape the other 9 dormant nodes are in",
	},
	{
		name: "dormant: parked on done()",
		events: chain([...HEAD, text("bye"), call("d1", TOOL_DONE), usage()]),
		launch: false,
		why: "done() parks waiting to be woken; nothing is owed",
	},
	{
		name: "consumed message, nothing produced",
		events: chain([
			...HEAD,
			think("t"),
			text("hi"),
			usage(),
			msg("m1", "go"),
			consumed(["m1"]),
		]),
		launch: true,
		why: "verification 3 — died inside the API call; the turn must re-run",
	},
	{
		name: "consumed message, thinking finished, never spoke",
		events: chain([
			...HEAD,
			text("hi"),
			usage(),
			msg("m1", "go"),
			consumed(["m1"]),
			think("mid-thought"),
		]),
		launch: true,
		why: "verification 4 — thinking is not an answer",
	},
	{
		name: "died mid tool-using turn, after a tool_result",
		events: chain([
			...HEAD,
			think("t"),
			text("working"),
			call("c1"),
			usage(),
			result("c1"),
			call("c2"),
			usage(),
			result("c2"),
		]),
		launch: true,
		why: "the added row — results were in hand and never sent back",
	},
	{
		name: "died with an unanswered tool_call",
		events: chain([...HEAD, text("working"), call("c1"), usage()]),
		launch: true,
		why: "verification 3 variant — repair answers it, then the turn runs",
	},
	{
		name: "real message arrived while the daemon was down",
		events: chain([...HEAD, text("hi"), usage(), msg("m1", "hello?")]),
		launch: true,
		why: "verification 6",
	},
	{
		name: "interrupt after text streamed",
		events: chain([...HEAD, think("t"), text("partial answ"), interruptMsg()]),
		launch: false,
		why: "verification 1",
	},
	{
		name: "interrupt before anything streamed",
		events: chain([...HEAD, msg("m1", "go"), consumed(["m1"]), interruptMsg()]),
		launch: false,
		why: "verification 2 — the case with no other signal at all",
	},
	{
		name: "empty log",
		events: [],
		launch: false,
		why: "a node that never ran has nothing to resume",
	},
	{
		name: "log of pure lifecycle noise",
		events: chain([agentStart(), agentEnd(), agentStart(), agentEnd()]),
		launch: false,
		why: "01KMHAHT48-shaped: start/end pairs and no conversation",
	},
];

describe("shouldLaunchAgent — the shape table", () => {
	for (const s of SHAPES) {
		test(`${s.launch ? "LAUNCH" : "park "} — ${s.name} (${s.why})`, () => {
			expect(shouldLaunchAgent(s.events)).toBe(s.launch);
		});
	}
});

// ── The differential. Recomputes the loop's own gate order from the real
//    walker + real repair and asserts the predicate agrees on every shape.

/**
 * What `runProviderLoop` decides on resume, recomputed here from the same
 * inputs it uses. Mirrors provider-shared.ts: repair the JSONL, reconstruct
 * messages, then apply the gates in order — pending yield/done, implicit
 * yield, and finally "do the messages end on a user turn".
 */
function loopWouldAct(events: Event[]): boolean {
	if (events.length === 0) return false;

	// 1. Repair, exactly as runAgentForNode does before the loop starts.
	let repaired = events;
	const repair = buildSessionRepair(events, T);
	if (repair) {
		const cut = repair.chainToEid
			? events.slice(
					0,
					events.findIndex((e) => e.eid === repair.chainToEid) + 1,
				)
			: events;
		repaired = [...cut, ...repair.appendEvents];
	}

	// 2. Unconsumed messages are re-enqueued by findUnconsumedMessages, and
	//    queue.wait() returns immediately on a non-empty queue — so any of
	//    them makes the loop act, whatever gate it took to get there.
	const consumedIds = new Set<string>();
	for (const e of repaired) {
		if (e.type === "messages_consumed")
			for (const id of e.messageIds) consumedIds.add(id);
	}
	const pending = repaired.filter(
		(e) => e.type === "message" && e.id && !consumedIds.has(e.id),
	);
	if (pending.length > 0) return true;

	// 3. The loop's gate order.
	const lastToolCall = repaired.findLast((e) => e.type === "tool_call");
	const answered =
		lastToolCall?.type === "tool_call" &&
		repaired.some(
			(e) =>
				e.type === "tool_result" && e.toolCallId === lastToolCall.toolCallId,
		);
	const pendingYield =
		lastToolCall?.type === "tool_call" &&
		lastToolCall.tool === TOOL_YIELD &&
		!answered;
	const pendingDone =
		lastToolCall?.type === "tool_call" &&
		lastToolCall.tool === TOOL_DONE &&
		!answered;
	if (pendingYield || pendingDone) return false;
	if (hasPendingImplicitYield(repaired)) return false;

	const messages = eventsToAnthropicMessages(repaired) as Array<{
		role: string;
	}>;
	return messages[messages.length - 1]?.role === "user";
}

describe("shouldLaunchAgent agrees with what the loop actually does", () => {
	for (const s of SHAPES) {
		// The interrupt rows are the deliberate divergence: the loop, handed an
		// unconsumed interrupt notice, WOULD act on it. Refusing to launch is
		// the whole point of the notice, so they are asserted separately below.
		const isInterruptRow = s.name.startsWith("interrupt");
		if (isInterruptRow) continue;
		test(`loop and predicate agree — ${s.name}`, () => {
			expect(shouldLaunchAgent(s.events)).toBe(loopWouldAct(s.events));
		});
	}

	// Stated as its own claim so the exclusion above cannot quietly widen:
	// these are the ONLY shapes where the two disagree, and the disagreement
	// is the feature.
	test("the interrupt notice is the one place they deliberately differ", () => {
		for (const s of SHAPES.filter((x) => x.name.startsWith("interrupt"))) {
			expect(loopWouldAct(s.events)).toBe(true);
			expect(shouldLaunchAgent(s.events)).toBe(false);
		}
	});
});

describe("rule 2: unconsumed messages, by source", () => {
	// The user's call, and the reason it is right: `quiet` is an argument to
	// enqueue, not a field on the message, so it does not survive to JSONL.
	// Source does.
	test("a non-interrupt unconsumed message launches, even a quiet-delivered one", () => {
		// tree_change is always delivered quiet — and on resume it is replayed,
		// wakes the loop and produces a real turn. Faithful means launching.
		const events = chain([...HEAD, text("hi"), treeChangeMsg("tc1")]);
		expect(shouldLaunchAgent(events)).toBe(true);
	});

	test("an interrupt notice alone does not launch", () => {
		const events = chain([...HEAD, text("hi"), interruptMsg()]);
		expect(shouldLaunchAgent(events)).toBe(false);
	});

	test("a real message alongside an interrupt notice does launch", () => {
		const events = chain([
			...HEAD,
			text("hi"),
			interruptMsg(),
			msg("m9", "actually, do this instead"),
		]);
		expect(shouldLaunchAgent(events)).toBe(true);
	});

	test("once CONSUMED the notice stops being special — turn shape decides", () => {
		// The veto is about a notice still WAITING. A consumed one was drained
		// into a turn like any other message, so it is ordinary history and the
		// consumption is a user turn owed an answer.
		const notice = interruptMsg();
		const events = chain([...HEAD, text("hi"), notice, consumed([notice.id])]);
		expect(shouldLaunchAgent(events)).toBe(true);
	});

	test("the veto is not 'ignore interrupts' — it needs them to be the ONLY thing waiting", () => {
		// Mutation guard: an implementation that simply filtered interrupt
		// notices out of the unconsumed list would pass every other test in
		// this block and fail here, because the tree_change would then be the
		// only pending message and would launch on its own.
		const events = chain([
			...HEAD,
			msg("m1", "go"),
			consumed(["m1"]),
			interruptMsg(),
		]);
		expect(shouldLaunchAgent(events)).toBe(false);
		const withReal = chain([
			...HEAD,
			msg("m2", "go"),
			consumed(["m2"]),
			interruptMsg(),
			treeChangeMsg("tc2"),
		]);
		expect(shouldLaunchAgent(withReal)).toBe(true);
	});
});

describe("repair: a trailing thinking-only turn is dropped", () => {
	const events = chain([
		...HEAD,
		text("hi"),
		usage(),
		msg("m1", "go"),
		consumed(["m1"]),
		think("thought but never spoke"),
	]);

	test("buildSessionRepair chains back past the dead turn", () => {
		const repair = buildSessionRepair(events, T);
		expect(repair).not.toBeNull();
		// The kept head must end at the messages_consumed — the user turn the
		// dead turn was failing to answer.
		const consumedEvent = events.findLast(
			(e) => e.type === "messages_consumed",
		);
		expect(repair?.chainToEid).toBe(consumedEvent?.eid as string);
	});

	test("it appends an event, so the jump reaches disk", () => {
		// setChainHead is pure in-memory; the jump only becomes durable as the
		// next appended event's parentEid.
		const repair = buildSessionRepair(events, T);
		expect(repair?.appendEvents.length).toBeGreaterThan(0);
	});

	test("after repair the conversation ends on the user turn", () => {
		const repair = buildSessionRepair(events, T);
		const cut = events.slice(
			0,
			events.findIndex((e) => e.eid === repair?.chainToEid) + 1,
		);
		const messages = eventsToAnthropicMessages([
			...cut,
			...(repair?.appendEvents ?? []),
		]) as Array<{ role: string }>;
		expect(messages[messages.length - 1]?.role).toBe("user");
	});

	test("a turn with thinking AND text is left alone", () => {
		// The normal end_turn shape. Dropping this would delete real replies.
		const ok = chain([
			...HEAD,
			msg("m1", "go"),
			consumed(["m1"]),
			think("t"),
			text("here is your answer"),
		]);
		expect(buildSessionRepair(ok, T)).toBeNull();
		expect(shouldLaunchAgent(ok)).toBe(false);
	});

	test("a turn with thinking AND a tool_call is not thinking-only", () => {
		// It has an orphan tool_call, so repair fires — but as the orphan
		// strategy (append-only), never as a chain jump that would drop the call.
		const ok = chain([...HEAD, think("t"), call("c1")]);
		const repair = buildSessionRepair(ok, T);
		expect(repair?.chainToEid).toBeNull();
		expect(shouldLaunchAgent(ok)).toBe(true);
	});

	test("thinking at the very start of a log is not chained past", () => {
		// thinkingOnlyFrom must be > 0 — chaining to index -1 has no target.
		const odd = chain([think("orphan thought")]);
		expect(() => buildSessionRepair(odd, T)).not.toThrow();
		expect(buildSessionRepair(odd, T)).toBeNull();
	});
});

describe("hasPendingImplicitYield: a consumption ends the walk", () => {
	// The defect: an assistant_text followed by a messages_consumed was read as
	// a park, so the loop parked on a message it had already taken into a turn
	// and never answered it.
	test("assistant_text then messages_consumed → NOT a pending yield", () => {
		const events = chain([
			...HEAD,
			text("hi"),
			usage(),
			msg("m1", "go"),
			consumed(["m1"]),
		]);
		expect(hasPendingImplicitYield(events)).toBe(false);
	});

	test("assistant_text with nothing after it → still a pending yield", () => {
		const events = chain([...HEAD, text("hi"), usage()]);
		expect(hasPendingImplicitYield(events)).toBe(true);
	});

	test("an unconsumed message does NOT end the walk", () => {
		// It is picked up by the queue, not by this predicate — the loop parks
		// and wait() returns immediately. Ending the walk here would change
		// which resume branch runs.
		const events = chain([...HEAD, text("hi"), msg("m1", "hello?")]);
		expect(hasPendingImplicitYield(events)).toBe(true);
	});
});
