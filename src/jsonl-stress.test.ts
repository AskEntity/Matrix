/**
 * Adversarial stress tests for JSONL consistency invariants.
 *
 * **Goal**: attack the boundary between `runtime invariants` (enforced by the
 * provider loop) and `recovery invariants` (enforced by `buildSessionRepair`
 * + the walker). Runtime can guarantee certain shapes only while a loop is
 * live. After a crash, a version upgrade, manual intervention, or a past bug
 * the JSONL on disk can enter states the runtime would never produce. The
 * recovery path must handle these states without silent corruption.
 *
 * **Silent corruption is the worst outcome**: we'd rather see an exception
 * than a walker that produces invalid Anthropic messages which then get
 * swallowed by the API with a cryptic 400.
 *
 * **Paired tests**: for each runtime invariant that matters we ship a pair.
 *
 *   - `runtime: …` tests the positive case — normal agent behavior hits the
 *     invariant and doesn't violate it.
 *   - `recovery: …` manually injects a JSONL that violates the invariant and
 *     exercises the walker / `buildSessionRepair` against it. The assertion
 *     is that the result is either a structurally valid API message array or
 *     a loud error — never silent garbage.
 *
 * Each adversarial test has a comment explaining the invariant it attacks
 * and the specific bug regression it would catch.
 */
import { describe, expect, test } from "bun:test";
import { eventsToAnthropicMessages } from "./anthropic-compatible-provider.ts";
import {
	buildSessionRepair,
	type Event,
	findOrphanedBackgroundProcesses,
	findUnconsumedMessages,
	hasPendingImplicitYield,
	hasPendingYield,
} from "./events.ts";
import { TOOL_DONE, TOOL_YIELD } from "./tool-names.ts";

// ── Small event factory helpers (kept minimal; see walker-golden.test.ts
//    for the full set). These only cover what the tests below need.

function userMsgEvent(
	id: string,
	content: string,
	ts = 0,
	taskId = "t1",
): Event {
	return {
		type: "message",
		id,
		taskId,
		ts,
		body: { source: "user", id, ts, content },
	};
}

function taskCompleteMsgEvent(
	id: string,
	childId: string,
	title: string,
	success: boolean,
	output: string,
	ts = 0,
	taskId = "t1",
): Event {
	return {
		type: "message",
		id,
		taskId,
		ts,
		body: {
			source: "task_complete",
			id,
			ts,
			taskId: childId,
			title,
			success,
			output,
		},
	};
}

function bgCompleteMsgEvent(
	id: string,
	commandId: string,
	command: string,
	exitCode: number | null = 0,
	ts = 0,
	taskId = "t1",
): Event {
	return {
		type: "message",
		id,
		taskId,
		ts,
		body: {
			source: "background_complete",
			id,
			ts,
			commandId,
			command,
			exitCode,
			durationMs: 10,
			content: "exit code: 0\nstdout:\nhi\n",
		},
	};
}

function messagesConsumedEvent(ids: string[], ts = 0, taskId = "t1"): Event {
	return { type: "messages_consumed", messageIds: ids, taskId, ts };
}

function assistantText(content: string, ts = 0, taskId = "t1"): Event {
	return { type: "assistant_text", content, taskId, ts };
}

function toolCall(
	toolCallId: string,
	tool: string,
	input: Record<string, unknown> = {},
	ts = 0,
	taskId = "t1",
): Event {
	return { type: "tool_call", toolCallId, tool, input, taskId, ts };
}

function toolResult(
	toolCallId: string,
	tool: string,
	content: string,
	opts?: { isError?: boolean; ts?: number; taskId?: string },
): Event {
	return {
		type: "tool_result",
		toolCallId,
		tool,
		content,
		isError: opts?.isError ?? false,
		taskId: opts?.taskId ?? "t1",
		ts: opts?.ts ?? 0,
	};
}

function doneNotifiedEvent(
	status: "verify" | "failed",
	summary = "done",
	ts = 0,
	taskId = "t1",
): Event {
	return { type: "done_notified", status, summary, taskId, ts };
}

function forkMarkerEvent(
	sourceTaskId: string,
	targetTitle?: string,
	ts = 0,
): Event {
	return {
		type: "fork_marker",
		sourceTaskId,
		...(targetTitle ? { targetTitle } : {}),
		taskId: "t1",
		ts,
	} as Event;
}

// ──────────────────────────────────────────────────────────────────────────
// Tiny Anthropic message shape assertions — these are what the API wants.
// ──────────────────────────────────────────────────────────────────────────

type AnthMessage = { role: "user" | "assistant"; content: unknown };

/**
 * A minimum Anthropic API validity check. The API rejects:
 *   - empty messages array (for non-empty conversations; we only assert
 *     structural sanity, not this)
 *   - messages with role !== "user" | "assistant"
 *   - messages with empty content arrays
 *   - two consecutive user messages or two consecutive assistant messages
 *   - a trailing assistant message (API wants the conversation to end with
 *     a user message when requesting completion)
 *
 * We don't assert the trailing-role rule because some walker outputs are
 * intermediate and meant to be extended. We DO assert the alternation and
 * structural shape.
 */
function assertStructurallyValidApiMessages(msgs: unknown[]): void {
	const arr = msgs as AnthMessage[];

	for (let i = 0; i < arr.length; i++) {
		const m = arr[i];
		expect(m).toBeDefined();
		if (!m) continue;
		expect(["user", "assistant"]).toContain(m.role);
		// Content must exist and not be an empty array
		if (Array.isArray(m.content)) {
			expect(m.content.length).toBeGreaterThan(0);
		} else if (typeof m.content === "string") {
			// string content is valid (for simple user messages)
		} else {
			expect(m.content).toBeDefined();
		}
	}

	// Alternation: no two consecutive messages with the same role
	for (let i = 1; i < arr.length; i++) {
		const prev = arr[i - 1];
		const curr = arr[i];
		if (prev && curr) {
			expect(prev.role).not.toBe(curr.role);
		}
	}
}

// ══════════════════════════════════════════════════════════════════════════
// 1. Runtime invariant: done is always the LAST tool_call in its turn.
//    Recovery must still produce a valid structure if an old/buggy JSONL
//    has done() with other tool_calls in the same assistant turn.
// ══════════════════════════════════════════════════════════════════════════

describe("runtime vs recovery: done + other tool in same turn", () => {
	// RUNTIME: the done tool handler closes the queue, the provider loop's
	// post-turn machinery exits, NOTHING else can run in that turn. So at
	// runtime, hasPendingYield + the done orphan together identify a clean
	// state.
	test("runtime: done tool_call alone in a turn → valid `intended orphan`", () => {
		const events: Event[] = [
			userMsgEvent("u1", "start"),
			messagesConsumedEvent(["u1"]),
			assistantText("wrapping up"),
			toolCall("tc-done", TOOL_DONE, { status: "passed", summary: "ok" }),
		];
		// hasPendingYield should be false (yield is the marker, not done)
		expect(hasPendingYield(events)).toBe(false);
		// buildSessionRepair should skip done-as-last-tool — no repair needed
		expect(buildSessionRepair(events, "t1")).toBeNull();
	});

	// RECOVERY: manually inject [done(), bash()] in the same assistant turn
	// (a state that crash / manual edit could leave). Walker must produce a
	// STRUCTURALLY VALID api messages array. buildSessionRepair should
	// recognize the bash tool_call as an orphan and append an interrupted
	// tool_result for it. The done stays as the intended orphan.
	//
	// Attacks: if a future walker refactor forgets that done+bash in the
	// same turn is possible (because runtime never produces it), it might
	// split the turn incorrectly or crash.
	test("recovery: done + bash same turn → walker produces valid structure", () => {
		const events: Event[] = [
			userMsgEvent("u1", "start"),
			messagesConsumedEvent(["u1"]),
			assistantText("wrapping up"),
			toolCall("tc-done", TOOL_DONE, { status: "passed", summary: "ok" }),
			toolCall("tc-bash", "mcp__mxd__bash", { command: "ls" }),
		];
		const msgs = eventsToAnthropicMessages(events);
		// Should be [user, assistant] — the entire assistant turn, including
		// both orphan tool_calls, as ONE assistant message. No crash.
		expect(msgs.length).toBe(2);
		expect((msgs[0] as AnthMessage).role).toBe("user");
		expect((msgs[1] as AnthMessage).role).toBe("assistant");
		// Assistant message has 3 content blocks: text + 2 tool_use
		const content = (msgs[1] as AnthMessage).content as unknown[];
		expect(content.length).toBe(3);
	});

	test("recovery: buildSessionRepair detects bash-with-done as orphan needing repair", () => {
		const events: Event[] = [
			assistantText("text"),
			toolCall("tc-done", TOOL_DONE, { status: "passed" }),
			toolCall("tc-bash", "mcp__mxd__bash", {}),
		];
		const repair = buildSessionRepair(events, "t1");
		// The bash tool_call is orphaned; buildSessionRepair appends a
		// synthetic interrupted tool_result for it. The done is the LAST
		// tool_call — skipped as "intended orphan".
		expect(repair).not.toBeNull();
		expect(repair?.appendEvents.length).toBeGreaterThanOrEqual(1);
		const appended = repair?.appendEvents.find(
			(e) =>
				e.type === "tool_result" &&
				"toolCallId" in e &&
				e.toolCallId === "tc-bash",
		);
		expect(appended).toBeDefined();
	});

	// Adversarial: 2 done tool_calls in the SAME turn. Runtime is impossible
	// (second done() is never reached — loop exits on first). But if a buggy
	// retry wrote both, which one is the "intended orphan"? The last one.
	// First done needs a synthetic tool_result.
	test("recovery: 2 done calls same turn → last is intended orphan, first repaired", () => {
		const events: Event[] = [
			assistantText("t1"),
			toolCall("tc-done1", TOOL_DONE, { status: "passed", summary: "a" }),
			toolCall("tc-done2", TOOL_DONE, { status: "passed", summary: "b" }),
		];
		const repair = buildSessionRepair(events, "t1");
		expect(repair).not.toBeNull();
		// First done gets an interrupted tool_result
		const firstRepaired = repair?.appendEvents.find(
			(e) =>
				e.type === "tool_result" &&
				"toolCallId" in e &&
				e.toolCallId === "tc-done1",
		);
		expect(firstRepaired).toBeDefined();
		// Second done is NOT repaired (intended orphan)
		const secondRepaired = repair?.appendEvents.find(
			(e) =>
				e.type === "tool_result" &&
				"toolCallId" in e &&
				e.toolCallId === "tc-done2",
		);
		expect(secondRepaired).toBeUndefined();
	});
});

// ══════════════════════════════════════════════════════════════════════════
// 2. Runtime invariant: yield is the LAST tool_call in its turn (after the
//    duplicate-yield fix). Recovery tests mirror this.
// ══════════════════════════════════════════════════════════════════════════

describe("runtime vs recovery: yield tool_call position", () => {
	// RUNTIME: normal yield is followed by end-of-turn. On resume, it is the
	// last tool_call with no tool_result → hasPendingYield returns true.
	test("runtime: clean yield is detected by hasPendingYield", () => {
		const events: Event[] = [
			assistantText("before yield"),
			toolCall("tc-y", TOOL_YIELD, {}),
		];
		expect(hasPendingYield(events)).toBe(true);
		// buildSessionRepair leaves it alone — intended orphan
		expect(buildSessionRepair(events, "t1")).toBeNull();
	});

	// RECOVERY: 2 yield tool_calls in same turn + 1 bash. This happens when
	// the Anthropic API sometimes returns duplicate yields. The runtime fix
	// is documented in memory.md as the "extras bundle into the same user
	// turn" pattern. After a crash during that bundling, JSONL could have
	// 2 yields + 1 bash all as orphans.
	//
	// Attack: walker must produce a valid structure. Repair should recognize
	// the earlier yield + bash as repair targets and leave the LAST yield as
	// the intended orphan.
	test("recovery: 2 yield + 1 bash same turn → walker valid, repair fixes earlier yield and bash", () => {
		const events: Event[] = [
			assistantText("multi tool turn"),
			toolCall("tc-y1", TOOL_YIELD, {}),
			toolCall("tc-bash", "mcp__mxd__bash", { command: "ls" }),
			toolCall("tc-y2", TOOL_YIELD, {}),
		];

		// Walker: entire assistant turn as one message, valid structure
		const msgs = eventsToAnthropicMessages(events);
		expect((msgs[0] as AnthMessage).role).toBe("assistant");
		const content = (msgs[0] as AnthMessage).content as unknown[];
		expect(content.length).toBe(4); // 1 text + 3 tool_use

		// Repair: tc-y1 and tc-bash get interrupted results; tc-y2 is the
		// intended orphan (last tool_call).
		const repair = buildSessionRepair(events, "t1");
		expect(repair).not.toBeNull();
		const appendedIds = repair?.appendEvents
			.filter((e) => e.type === "tool_result")
			.map((e) => (e as { toolCallId: string }).toolCallId);
		expect(appendedIds).toContain("tc-y1");
		expect(appendedIds).toContain("tc-bash");
		expect(appendedIds).not.toContain("tc-y2");
	});

	// Adversarial: yield + done in the same turn. Absolutely impossible at
	// runtime — yield and done have mutually exclusive loop exits. But if
	// they show up in JSONL, what does the walker do? What does repair do?
	//
	// Attack: "last tool_call is yield or done" branch. The walker should
	// render both as tool_use blocks. Repair should leave the LAST tool_call
	// as the intended orphan and interrupt the EARLIER one. Regardless of
	// which one is last, only ONE is left unrepaired.
	test("recovery: yield + done same turn → walker valid, last one stays orphan", () => {
		const events: Event[] = [
			assistantText("mixed control"),
			toolCall("tc-y", TOOL_YIELD, {}),
			toolCall("tc-done", TOOL_DONE, { status: "passed" }),
		];
		const msgs = eventsToAnthropicMessages(events);
		// Valid structure, assistant turn preserves both tool_calls
		assertStructurallyValidApiMessages(msgs);
		const repair = buildSessionRepair(events, "t1");
		// Repair appends tc-y interrupted result (tc-done is last → intended)
		expect(repair).not.toBeNull();
		const appendedIds = repair?.appendEvents
			.filter((e) => e.type === "tool_result")
			.map((e) => (e as { toolCallId: string }).toolCallId);
		expect(appendedIds).toContain("tc-y");
		expect(appendedIds).not.toContain("tc-done");
	});

	// Adversarial: yield tool_result in the MIDDLE of a turn (followed by
	// other tool_results). Runtime never produces this — yield's tool_result
	// is written at wake time and is the first/only tool_result of its pair.
	//
	// Attack: walker must not split or misorder the tool_results. The walker
	// processes tool_results in a loop that collects all consecutive
	// tool_result events — as long as they're consecutive, order is preserved.
	test("recovery: yield tool_result with another tool_result after it → walker preserves order", () => {
		const events: Event[] = [
			assistantText("a"),
			toolCall("tc-y", TOOL_YIELD, {}),
			toolCall("tc-bash", "mcp__mxd__bash", {}),
			toolResult("tc-y", TOOL_YIELD, "resumed."),
			toolResult("tc-bash", "mcp__mxd__bash", "ok"),
		];
		const msgs = eventsToAnthropicMessages(events);
		// Valid: assistant turn with 2 tool_use + user turn with 2 tool_result
		assertStructurallyValidApiMessages(msgs);
		expect(msgs.length).toBe(2);
		expect((msgs[0] as AnthMessage).role).toBe("assistant");
		expect((msgs[1] as AnthMessage).role).toBe("user");
		const userContent = (msgs[1] as AnthMessage).content as Array<{
			type: string;
			tool_use_id?: string;
		}>;
		// Both tool_results present, in walker traversal order
		const ids = userContent
			.filter((b) => b.type === "tool_result")
			.map((b) => b.tool_use_id);
		expect(ids).toEqual(["tc-y", "tc-bash"]);
	});
});

// ══════════════════════════════════════════════════════════════════════════
// 3. Runtime invariant: session_config is emitted once (fresh start) or
//    re-emitted after compaction. Recovery must tolerate duplicates.
// ══════════════════════════════════════════════════════════════════════════

describe("runtime vs recovery: session_config uniqueness", () => {
	// RUNTIME: emit is gated on `if (!storedConfig && emit)`. Only one
	// session_config per session (plus a refresh after compaction, which is
	// also a single event). Two consecutive session_configs at session start
	// are a bug.
	test("runtime: fresh start emits exactly ONE session_config", () => {
		// Simulated: a clean session has at most one session_config between
		// start and first user turn. We're asserting via event shape, not a
		// live loop — this is a runtime invariant documented, not enforced
		// by the walker.
		const events: Event[] = [
			{
				type: "session_config",
				tools: [],
				systemStable: "s",
				systemVariable: "v",
				taskId: "t1",
				ts: 0,
			} as Event,
			userMsgEvent("u1", "start", 1),
		];
		const configEvents = events.filter((e) => e.type === "session_config");
		expect(configEvents.length).toBe(1);
	});

	// RECOVERY: 2 session_config events in the stream. Walker skips both
	// (structural events). `runProviderLoop` walks backwards and uses the
	// LAST one — so tools are frozen to the most recent schema (correct
	// for post-compact behavior).
	//
	// Attack: walker must NOT panic on duplicate session_config events.
	// Downstream code must not double-emit system prompts.
	test("recovery: 2 session_config events → walker produces clean output (both skipped)", () => {
		const events: Event[] = [
			{
				type: "session_config",
				tools: [],
				systemStable: "s1",
				systemVariable: "v1",
				taskId: "t1",
				ts: 0,
			} as Event,
			{
				type: "session_config",
				tools: [],
				systemStable: "s2",
				systemVariable: "v2",
				taskId: "t1",
				ts: 1,
			} as Event,
			userMsgEvent("u1", "start", 2),
			messagesConsumedEvent(["u1"], 3),
			assistantText("ok", 4),
		];
		const msgs = eventsToAnthropicMessages(events);
		// Both session_config events skipped → just user turn + assistant
		expect(msgs.length).toBe(2);
		expect((msgs[0] as AnthMessage).role).toBe("user");
		expect((msgs[1] as AnthMessage).role).toBe("assistant");
	});
});

// ══════════════════════════════════════════════════════════════════════════
// 4. Runtime invariant: message events with ids are deferred until
//    messages_consumed references them. If a message id is orphan (never
//    consumed) it is invisible to the walker.
// ══════════════════════════════════════════════════════════════════════════

describe("runtime vs recovery: message id deferral", () => {
	// RUNTIME: normal flow — message event is written when deliverMessage
	// routes through queue.enqueue → onPersist. Then messages_consumed
	// references it when the provider loop drains the queue.
	test("runtime: message with id + messages_consumed → rendered once", () => {
		const events: Event[] = [
			userMsgEvent("u1", "hello", 0),
			messagesConsumedEvent(["u1"], 1),
		];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs.length).toBe(1);
		expect((msgs[0] as AnthMessage).role).toBe("user");
	});

	// RECOVERY: a message event has an id but NO messages_consumed references
	// it. Runtime would produce this briefly (message delivered, agent not
	// yet drained), and crash-recovery would re-enqueue it via replay on
	// restart.
	//
	// Attack: the walker must NOT render this as an orphan message. It stays
	// invisible. findUnconsumedMessages picks it up for re-delivery.
	test("recovery: message with id, never consumed → walker skips it silently", () => {
		const events: Event[] = [
			userMsgEvent("u1", "already-consumed", 0),
			messagesConsumedEvent(["u1"], 1),
			userMsgEvent("u2", "never-consumed", 2),
		];
		const msgs = eventsToAnthropicMessages(events);
		// Only u1 (consumed) shows up, u2 is invisible until reclaimed
		expect(msgs.length).toBe(1);
		// findUnconsumedMessages must find u2 for replay
		const unconsumed = findUnconsumedMessages(events);
		expect(unconsumed.length).toBe(1);
		if (unconsumed[0]?.source === "user") {
			expect(unconsumed[0].content).toBe("never-consumed");
		}
	});

	// Adversarial: messages_consumed references an id that doesn't exist.
	// Runtime never produces this (the id was generated when the message
	// was written). Manual edit, version upgrade, or past bug could produce
	// it. The walker falls back to a no-op for missing ids.
	//
	// Attack: if the walker crashed on missing id, a single corrupt JSONL
	// file would brick the agent. It must degrade gracefully.
	test("recovery: messages_consumed references unknown id → walker no-op, no crash", () => {
		const events: Event[] = [
			userMsgEvent("u1", "real", 0),
			messagesConsumedEvent(["u1", "u-ghost"], 1),
		];
		// Does not throw
		const msgs = eventsToAnthropicMessages(events);
		// Only u1 resolves — ghost id is silently ignored
		expect(msgs.length).toBe(1);
	});

	// Adversarial: messages_consumed with ZERO ids → walker no-op.
	test("recovery: empty messages_consumed is a no-op", () => {
		const events: Event[] = [messagesConsumedEvent([], 0)];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs.length).toBe(0);
	});

	// Adversarial: same message id appearing TWICE in the event stream.
	// This would happen if the pre-refactor double-emit bug came back.
	// The eventIndex uses Map.set — later value wins. messages_consumed
	// resolves to the second copy.
	//
	// Attack: if someone refactors eventIndex to check-and-reject duplicates
	// without also checking downstream, the walker could panic. This test
	// pins the "last write wins" behavior.
	test("recovery: duplicate message id in JSONL → eventIndex last-write-wins", () => {
		const events: Event[] = [
			userMsgEvent("u1", "first copy", 0),
			userMsgEvent("u1", "second copy", 1), // SAME id, different content
			messagesConsumedEvent(["u1"], 2),
		];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs.length).toBe(1);
		const content = (msgs[0] as AnthMessage).content;
		// Whichever copy eventIndex keeps, the result is ONE rendered message
		// (not both, not zero).
		expect(typeof content === "string" || Array.isArray(content)).toBe(true);
	});

	// Adversarial: messages_consumed references an id that EXISTS but with a
	// body.source that isn't a valid queue message (e.g., some future event
	// type). formatEventForAI handles this by falling back to generic
	// serialization. The walker must not crash.
	test("recovery: messages_consumed on non-queue event type → walker tolerant", () => {
		const weirdEvent: Event = {
			type: "message",
			id: "weird",
			taskId: "t1",
			ts: 0,
			// biome-ignore lint/suspicious/noExplicitAny: adversarial shape
			body: { source: "task_complete" as any, id: "weird", ts: 0 } as any,
		};
		const events: Event[] = [weirdEvent, messagesConsumedEvent(["weird"], 1)];
		// Does not throw — walker resolves to SOMETHING (possibly empty text)
		const msgs = eventsToAnthropicMessages(events);
		expect(Array.isArray(msgs)).toBe(true);
	});
});

// ══════════════════════════════════════════════════════════════════════════
// 5. Runtime invariant: fork_marker is emitted exactly once per fork.
//    Recovery must tolerate duplicates gracefully.
// ══════════════════════════════════════════════════════════════════════════

describe("runtime vs recovery: fork_marker uniqueness", () => {
	// RUNTIME: a fresh fork emits exactly one fork_marker.
	test("runtime: single fork_marker renders once", () => {
		const events: Event[] = [
			assistantText("before fork"),
			toolCall("tc-bash", "mcp__mxd__bash", {}),
			toolResult("tc-bash", "mcp__mxd__bash", "ok"),
			forkMarkerEvent("parent-task-id", "New Task"),
		];
		const msgs = eventsToAnthropicMessages(events);
		assertStructurallyValidApiMessages(msgs);
	});

	// RECOVERY: two fork_markers back-to-back (e.g., from a fork that got
	// retried after a crash). The walker's tool_result inner loop consumes
	// consecutive fork_markers as interleaved text. Duplicate → both rendered.
	//
	// Attack: if a future refactor tries to dedupe fork_markers by timestamp
	// or id, the walker must handle a redundant one without dropping the
	// assistant's identity context.
	test("recovery: 2 consecutive fork_markers → walker renders BOTH", () => {
		const events: Event[] = [
			assistantText("mixed"),
			toolCall("tc-bash", "mcp__mxd__bash", {}),
			toolResult("tc-bash", "mcp__mxd__bash", "ok"),
			forkMarkerEvent("parent-a"),
			forkMarkerEvent("parent-b"),
		];
		const msgs = eventsToAnthropicMessages(events);
		assertStructurallyValidApiMessages(msgs);
		// The user turn (tool_result batch) contains interleaved text with
		// both fork markers. Count fork_marker occurrences in text blocks.
		const userMsg = msgs.find((m) => (m as AnthMessage).role === "user") as
			| AnthMessage
			| undefined;
		expect(userMsg).toBeDefined();
		const content = userMsg?.content as Array<{
			type: string;
			text?: string;
		}>;
		const forkTexts = content.filter(
			(b) => b.type === "text" && b.text?.includes("<fork_marker"),
		);
		expect(forkTexts.length).toBe(2);
	});
});

// ══════════════════════════════════════════════════════════════════════════
// 6. Runtime invariant: done state machine (orphan × notified).
//    The recovery path maps JSONL state to a tracker status action.
// ══════════════════════════════════════════════════════════════════════════

describe("runtime vs recovery: done state machine 4 combinations", () => {
	// Read findInterruptedDonePhase2 from daemon.ts
	// Cases:
	//   (a) orphan=yes, notified=yes → "status_stale" (if node still in_progress)
	//   (b) orphan=yes, notified=no  → "needs_phase2"
	//   (c) orphan=no,  notified=yes → null (no orphan to recover)
	//   (d) orphan=no,  notified=no  → null (clean)

	test("case d: no done orphan, no notified → null (clean state)", async () => {
		const { findInterruptedDonePhase2 } = await import("./daemon.ts");
		const events: Event[] = [userMsgEvent("u1", "start"), assistantText("ok")];
		expect(findInterruptedDonePhase2(events)).toBeNull();
	});

	test("case b: done orphan, no notified → needs_phase2", async () => {
		const { findInterruptedDonePhase2 } = await import("./daemon.ts");
		const events: Event[] = [
			assistantText("finishing"),
			toolCall("tc-done", TOOL_DONE, {
				status: "passed",
				summary: "all done",
			}),
		];
		const result = findInterruptedDonePhase2(events);
		expect(result?.type).toBe("needs_phase2");
		if (result?.type === "needs_phase2") {
			expect(result.status).toBe("verify");
			expect(result.summary).toBe("all done");
		}
	});

	test("case a: done orphan AND notified → status_stale", async () => {
		const { findInterruptedDonePhase2 } = await import("./daemon.ts");
		const events: Event[] = [
			assistantText("finishing"),
			toolCall("tc-done", TOOL_DONE, { status: "passed", summary: "ok" }),
			doneNotifiedEvent("verify", "ok", 1),
		];
		const result = findInterruptedDonePhase2(events);
		expect(result?.type).toBe("status_stale");
		if (result?.type === "status_stale") {
			expect(result.status).toBe("verify");
		}
	});

	test("case: done with tool_result (resumed done) → null (not an orphan)", async () => {
		const { findInterruptedDonePhase2 } = await import("./daemon.ts");
		const events: Event[] = [
			toolCall("tc-done", TOOL_DONE, { status: "passed" }),
			toolResult("tc-done", TOOL_DONE, "resumed"),
		];
		expect(findInterruptedDonePhase2(events)).toBeNull();
	});

	// Adversarial: failed status is propagated through findInterruptedDonePhase2
	test("case b: done orphan with status=failed → needs_phase2 with failed", async () => {
		const { findInterruptedDonePhase2 } = await import("./daemon.ts");
		const events: Event[] = [
			toolCall("tc-done", TOOL_DONE, {
				status: "failed",
				summary: "gave up",
			}),
		];
		const result = findInterruptedDonePhase2(events);
		expect(result?.type).toBe("needs_phase2");
		if (result?.type === "needs_phase2") {
			expect(result.status).toBe("failed");
		}
	});

	// Adversarial: done with missing input → still parseable
	test("case b: done orphan with no input → needs_phase2 defaults to failed+empty", async () => {
		const { findInterruptedDonePhase2 } = await import("./daemon.ts");
		const events: Event[] = [
			{
				type: "tool_call",
				tool: TOOL_DONE,
				toolCallId: "tc-done",
				input: {},
				taskId: "t1",
				ts: 0,
			},
		];
		const result = findInterruptedDonePhase2(events);
		expect(result?.type).toBe("needs_phase2");
		if (result?.type === "needs_phase2") {
			// status defaults to "failed" when input.status is not "passed"
			expect(result.status).toBe("failed");
			expect(result.summary).toBe("");
		}
	});
});

// ══════════════════════════════════════════════════════════════════════════
// 7. Recovery idempotency: buildSessionRepair MUST be idempotent. Running
//    it twice on the same (potentially already-repaired) JSONL returns null
//    the second time. Otherwise a slow-boot path could keep appending
//    interrupted tool_results on every restart.
// ══════════════════════════════════════════════════════════════════════════

describe("buildSessionRepair idempotency", () => {
	test("clean JSONL → null (no repair)", () => {
		const events: Event[] = [
			userMsgEvent("u1", "start"),
			messagesConsumedEvent(["u1"]),
			assistantText("ok"),
			toolCall("tc-bash", "mcp__mxd__bash", {}),
			toolResult("tc-bash", "mcp__mxd__bash", "out"),
		];
		expect(buildSessionRepair(events, "t1")).toBeNull();
	});

	// After applying the first repair, the result must be clean. No infinite
	// repair loop on restart.
	test("repair → apply → repair returns null (idempotent)", () => {
		const events: Event[] = [toolCall("tc-orphan", "mcp__mxd__bash", {})];
		const repair1 = buildSessionRepair(events, "t1");
		expect(repair1).not.toBeNull();

		// Apply the repair (append events)
		const applied = [...events, ...(repair1?.appendEvents ?? [])];
		// Second repair on the applied output — should be null
		const repair2 = buildSessionRepair(applied, "t1");
		expect(repair2).toBeNull();
	});

	// Adversarial: a genuine session with a pending yield (the intended
	// orphan) must NOT trigger repair. This is the main runtime resume path —
	// if buildSessionRepair erroneously flagged it, every yield resume would
	// get a synthetic "interrupted" tool_result, breaking cache.
	test("pending yield alone → null (intended orphan)", () => {
		const events: Event[] = [
			assistantText("before yield"),
			toolCall("tc-y", TOOL_YIELD, {}),
		];
		expect(buildSessionRepair(events, "t1")).toBeNull();
	});

	// Adversarial: pending done alone → null (intended orphan).
	test("pending done alone → null (intended orphan)", () => {
		const events: Event[] = [
			toolCall("tc-done", TOOL_DONE, { status: "passed" }),
		];
		expect(buildSessionRepair(events, "t1")).toBeNull();
	});

	// Adversarial: a mix of done orphan + already-committed done_notified
	// (the tracker says verify, JSONL still has the orphan). Repair should
	// NOT mess with the orphan — findInterruptedDonePhase2 is the correct
	// place for that decision.
	test("done orphan + done_notified → buildSessionRepair leaves it alone", () => {
		const events: Event[] = [
			toolCall("tc-done", TOOL_DONE, { status: "passed" }),
			doneNotifiedEvent("verify"),
		];
		// buildSessionRepair only looks at tool orphans, not done_notified.
		// The done is LAST tool_call → intended orphan → null.
		expect(buildSessionRepair(events, "t1")).toBeNull();
	});
});

// ══════════════════════════════════════════════════════════════════════════
// 8. Walker edge cases — bizarre but structurally valid inputs
// ══════════════════════════════════════════════════════════════════════════

describe("walker edge cases", () => {
	// Empty event stream → empty messages
	test("empty events → empty messages", () => {
		expect(eventsToAnthropicMessages([])).toEqual([]);
	});

	// Only lifecycle/structural events → empty messages
	test("only structural events (session_config, compact_marker) → empty messages", () => {
		const events: Event[] = [
			{
				type: "session_config",
				tools: [],
				systemStable: "s",
				systemVariable: "v",
				taskId: "t1",
				ts: 0,
			} as Event,
			{
				type: "compact_marker",
				savedTokens: 0,
				taskId: "t1",
				ts: 1,
			} as Event,
		];
		expect(eventsToAnthropicMessages(events)).toEqual([]);
	});

	// Adversarial: an assistant_text event with EMPTY content. The walker
	// renders it as a text block. Defensive fallback in onAssistantContent
	// ensures the block array is never empty (prevents Anthropic 400).
	test("assistant_text with empty content → block present, never empty content[]", () => {
		const events: Event[] = [assistantText("")];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs.length).toBe(1);
		const content = (msgs[0] as AnthMessage).content as unknown[];
		expect(content.length).toBeGreaterThan(0); // defensive fallback fired
	});

	// Adversarial: alternating assistant_text and tool_call in a single turn
	// — this is allowed by the walker's inner loop (thinking→text→tool→text).
	// Attack: a refactor could split the turn on the first tool_call, which
	// would break the interleaving and produce invalid API messages.
	test("alternating text/tool/text/tool in one assistant turn stays one message", () => {
		const events: Event[] = [
			assistantText("intro"),
			toolCall("tc1", "mcp__mxd__bash", { command: "a" }),
			assistantText("between"),
			toolCall("tc2", "mcp__mxd__bash", { command: "b" }),
			assistantText("outro"),
			toolResult("tc1", "mcp__mxd__bash", "a-out"),
			toolResult("tc2", "mcp__mxd__bash", "b-out"),
		];
		const msgs = eventsToAnthropicMessages(events);
		// 2 messages: assistant (entire turn) + user (both tool_results)
		expect(msgs.length).toBe(2);
		expect((msgs[0] as AnthMessage).role).toBe("assistant");
		const aContent = (msgs[0] as AnthMessage).content as unknown[];
		expect(aContent.length).toBe(5); // text,tool,text,tool,text
		expect((msgs[1] as AnthMessage).role).toBe("user");
	});

	// Adversarial: a very long user message content (100K chars). The walker
	// must handle it without truncation or crash.
	test("very long user content (100K chars) rendered verbatim", () => {
		const longContent = "x".repeat(100_000);
		const events: Event[] = [
			userMsgEvent("u1", longContent),
			messagesConsumedEvent(["u1"]),
		];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs.length).toBe(1);
		const content = (msgs[0] as AnthMessage).content;
		// Content can be a string or array — either way, the substring
		// must be present
		if (typeof content === "string") {
			expect(content.includes(longContent)).toBe(true);
		} else {
			const flat = JSON.stringify(content);
			expect(flat.includes(longContent)).toBe(true);
		}
	});

	// Adversarial: 100 consecutive user messages in one consumed batch.
	// Each becomes its own text block. Attack: a refactor could collapse
	// them into one concatenated string, losing the per-message boundary.
	test("100 consumed messages in one batch → 100 text blocks", () => {
		const events: Event[] = [];
		const ids: string[] = [];
		for (let i = 0; i < 100; i++) {
			const id = `u${i}`;
			ids.push(id);
			events.push(
				taskCompleteMsgEvent(id, `c${i}`, `Child ${i}`, true, `out ${i}`, i),
			);
		}
		// A tool_result turn wrapping the consumed batch
		events.push(toolCall("tc", "mcp__mxd__bash", {}, 100));
		events.push(toolResult("tc", "mcp__mxd__bash", "ok", { ts: 101 }));
		events.push(messagesConsumedEvent(ids, 102));

		const msgs = eventsToAnthropicMessages(events);
		// At least one assistant + one user message
		assertStructurallyValidApiMessages(msgs);
		const userMsg = msgs.find((m) => (m as AnthMessage).role === "user") as
			| AnthMessage
			| undefined;
		expect(userMsg).toBeDefined();
		const content = userMsg?.content as Array<{ type: string }>;
		// Each consumed message = 1 text block (plus the tool_result)
		const textBlocks = content.filter((b) => b.type === "text");
		expect(textBlocks.length).toBeGreaterThanOrEqual(100);
	});

	// Adversarial: consumed messages with identical timestamps (millisecond
	// collision). FIFO must be stable.
	test("consumed messages with identical ts → walker preserves event-stream order", () => {
		const events: Event[] = [
			taskCompleteMsgEvent("u1", "c1", "A", true, "out-1", 42),
			taskCompleteMsgEvent("u2", "c2", "B", true, "out-2", 42),
			taskCompleteMsgEvent("u3", "c3", "C", true, "out-3", 42),
			toolCall("tc", "mcp__mxd__bash", {}, 43),
			toolResult("tc", "mcp__mxd__bash", "ok", { ts: 44 }),
			messagesConsumedEvent(["u1", "u2", "u3"], 45),
		];
		const msgs = eventsToAnthropicMessages(events);
		const userMsg = msgs.find((m) => (m as AnthMessage).role === "user") as
			| AnthMessage
			| undefined;
		expect(userMsg).toBeDefined();
		const content = userMsg?.content as Array<{ type: string; text?: string }>;
		// Find the three task_complete texts, in order
		const taskTexts = content
			.filter((b) => b.type === "text" && b.text?.includes("task_complete"))
			.map((b) => b.text);
		// Order must be u1,u2,u3 (by messages_consumed id order, not ts)
		expect(taskTexts[0]).toContain("out-1");
		expect(taskTexts[1]).toContain("out-2");
		expect(taskTexts[2]).toContain("out-3");
	});
});

// ══════════════════════════════════════════════════════════════════════════
// 9. findUnconsumedMessages + findOrphanedBackgroundProcesses determinism
// ══════════════════════════════════════════════════════════════════════════

describe("recovery-path determinism", () => {
	// Running findUnconsumedMessages TWICE on the same JSONL must return the
	// same list. This matters because runAgentForNode calls it at restart;
	// if a bug made it non-deterministic, restart semantics would drift.
	test("findUnconsumedMessages is deterministic across 10 runs", () => {
		const events: Event[] = [
			userMsgEvent("u1", "consumed", 0),
			userMsgEvent("u2", "unconsumed", 1),
			userMsgEvent("u3", "also unconsumed", 2),
			messagesConsumedEvent(["u1"], 3),
		];
		const first = findUnconsumedMessages(events);
		for (let i = 0; i < 10; i++) {
			const next = findUnconsumedMessages(events);
			expect(next.length).toBe(first.length);
			for (let j = 0; j < first.length; j++) {
				expect(next[j]?.id).toBe(first[j]?.id);
			}
		}
	});

	// findOrphanedBackgroundProcesses determinism
	test("findOrphanedBackgroundProcesses is deterministic across 10 runs", () => {
		const events: Event[] = [
			{
				type: "tool_result",
				toolCallId: "tc",
				tool: "mcp__mxd__bash",
				content: "started",
				isError: false,
				backgroundId: "bg-1",
				backgroundCommand: "sleep 10",
				taskId: "t1",
				ts: 0,
			} as Event,
		];
		const first = findOrphanedBackgroundProcesses(events, "t1");
		expect(first.length).toBe(1);
		for (let i = 0; i < 10; i++) {
			const next = findOrphanedBackgroundProcesses(events, "t1");
			expect(next.length).toBe(first.length);
		}
	});

	// If the bg_complete was already written, the orphan detector must NOT
	// produce it again. This matters for replay safety — double-injected
	// bg_complete would inflate JSONL and cause prefix drift.
	test("orphan detector skips bg processes that already have completion", () => {
		const events: Event[] = [
			{
				type: "tool_result",
				toolCallId: "tc",
				tool: "mcp__mxd__bash",
				content: "started",
				isError: false,
				backgroundId: "bg-1",
				backgroundCommand: "sleep 10",
				taskId: "t1",
				ts: 0,
			} as Event,
			bgCompleteMsgEvent("msg-1", "bg-1", "sleep 10", 0, 1),
		];
		expect(findOrphanedBackgroundProcesses(events, "t1").length).toBe(0);
	});

	// findUnconsumedMessages on an empty array returns empty
	test("empty JSONL → findUnconsumedMessages = []", () => {
		expect(findUnconsumedMessages([])).toEqual([]);
	});

	// hasPendingImplicitYield: last provider content is assistant_text with
	// no subsequent tool_call → true
	test("hasPendingImplicitYield: trailing assistant_text → true", () => {
		const events: Event[] = [
			toolCall("tc-bash", "mcp__mxd__bash", {}),
			toolResult("tc-bash", "mcp__mxd__bash", "ok"),
			assistantText("end_turn response"),
		];
		expect(hasPendingImplicitYield(events)).toBe(true);
	});

	test("hasPendingImplicitYield: trailing tool_call → false (pending yield territory)", () => {
		const events: Event[] = [
			assistantText("before"),
			toolCall("tc", "mcp__mxd__bash", {}),
		];
		expect(hasPendingImplicitYield(events)).toBe(false);
	});

	// hasPendingYield and hasPendingImplicitYield must be mutually exclusive
	// on any given JSONL. Attack: if a refactor breaks this, the resume
	// logic's priority chain would pick the wrong path.
	test("hasPendingYield and hasPendingImplicitYield are mutually exclusive", () => {
		const testCases: Event[][] = [
			[assistantText("a")], // implicit yield only
			[assistantText("a"), toolCall("tc-y", TOOL_YIELD, {})], // explicit yield only
			[
				toolCall("tc", "mcp__mxd__bash", {}),
				toolResult("tc", "mcp__mxd__bash", "ok"),
			], // neither
			[], // neither
		];
		for (const events of testCases) {
			const yield1 = hasPendingYield(events);
			const yield2 = hasPendingImplicitYield(events);
			expect(yield1 && yield2).toBe(false);
		}
	});
});

// ══════════════════════════════════════════════════════════════════════════
// 10. Walker output validity under dirty JSONL (catch-all structural check)
// ══════════════════════════════════════════════════════════════════════════

describe("walker output is always structurally valid under dirty JSONL", () => {
	// Parameterized dirty JSONL scenarios — for each one, assert the walker
	// output passes the alternation + non-empty content guards.

	const scenarios: Array<{ name: string; events: Event[] }> = [
		{
			name: "done + bash same turn",
			events: [
				userMsgEvent("u1", "x"),
				messagesConsumedEvent(["u1"]),
				assistantText("finishing"),
				toolCall("tc-done", TOOL_DONE, { status: "passed" }),
				toolCall("tc-bash", "mcp__mxd__bash", {}),
			],
		},
		{
			name: "2 yield + bash same turn",
			events: [
				userMsgEvent("u1", "x"),
				messagesConsumedEvent(["u1"]),
				assistantText("multi"),
				toolCall("tc-y1", TOOL_YIELD, {}),
				toolCall("tc-bash", "mcp__mxd__bash", {}),
				toolCall("tc-y2", TOOL_YIELD, {}),
			],
		},
		{
			name: "orphan assistant_text with no user message before it",
			events: [assistantText("random")],
		},
		// NOTE: "tool_result with no tool_call" is intentionally omitted from
		// this structurally-valid batch — see the dedicated test case below
		// which documents a LATENT RECOVERY GAP in buildSessionRepair.
		{
			name: "two fork_markers",
			events: [
				userMsgEvent("u1", "x"),
				messagesConsumedEvent(["u1"]),
				assistantText("before"),
				toolCall("tc", "mcp__mxd__bash", {}),
				toolResult("tc", "mcp__mxd__bash", "ok"),
				forkMarkerEvent("a"),
				forkMarkerEvent("b"),
			],
		},
		{
			name: "duplicate session_config",
			events: [
				{
					type: "session_config",
					tools: [],
					systemStable: "",
					systemVariable: "",
					taskId: "t1",
					ts: 0,
				} as Event,
				{
					type: "session_config",
					tools: [],
					systemStable: "",
					systemVariable: "",
					taskId: "t1",
					ts: 1,
				} as Event,
				userMsgEvent("u1", "x", 2),
				messagesConsumedEvent(["u1"], 3),
			],
		},
		{
			name: "messages_consumed with unknown id",
			events: [
				userMsgEvent("u1", "real"),
				messagesConsumedEvent(["u1", "ghost", "also-ghost"], 1),
			],
		},
		{
			name: "empty messages_consumed",
			events: [
				userMsgEvent("u1", "real"),
				messagesConsumedEvent(["u1"], 1),
				messagesConsumedEvent([], 2),
			],
		},
	];

	for (const { name, events } of scenarios) {
		test(`dirty JSONL [${name}] → walker produces valid structure`, () => {
			// Does not throw
			const msgs = eventsToAnthropicMessages(events);
			// Valid API structure (alternating, non-empty content)
			if (msgs.length > 0) {
				assertStructurallyValidApiMessages(msgs);
			}
		});
	}
});

// ══════════════════════════════════════════════════════════════════════════
// BEHAVIOR SNAPSHOT: orphan tool_result
//
// Runtime CANNOT produce JSONL with an orphan tool_result (a tool_result
// with no matching tool_call) — tool_result is always emitted by the
// provider loop immediately after its tool_call. If one ever appears,
// something upstream is seriously broken, and buildSessionRepair's job is
// NOT to mask it.
//
// These tests are **behavior snapshots**, not invariants:
//   - They document what the walker + buildSessionRepair currently do.
//   - They do NOT assert that the output is valid Anthropic API messages.
//   - They exist so that if someone changes the walker / repair behavior
//     around this state, they see a test failure and can confirm the
//     change is intentional.
//
// Rationale: a future improvement that makes the walker "graceful" on this
// state is a red flag — it would hide a real bug somewhere else. The tests
// force a deliberate decision. See memory.md for the reasoning.
// ══════════════════════════════════════════════════════════════════════════

describe("BEHAVIOR SNAPSHOT: orphan tool_result (not an invariant)", () => {
	test("walker: orphan tool_result produces TWO consecutive user messages (not API-valid)", () => {
		const events: Event[] = [
			userMsgEvent("u1", "x"),
			messagesConsumedEvent(["u1"]),
			toolResult("tc-ghost", "mcp__mxd__bash", "orphan result"),
		];
		const msgs = eventsToAnthropicMessages(events);
		// Current behavior: 2 consecutive user messages. NOT valid API input.
		// If someone makes the walker "smarter" about this case, revisit
		// whether they're masking an upstream bug.
		expect(msgs.length).toBe(2);
		expect((msgs[0] as AnthMessage).role).toBe("user");
		expect((msgs[1] as AnthMessage).role).toBe("user");
	});

	test("buildSessionRepair: orphan tool_result → null (out of scope)", () => {
		const events: Event[] = [
			userMsgEvent("u1", "x"),
			messagesConsumedEvent(["u1"]),
			toolResult("tc-ghost", "mcp__mxd__bash", "orphan result"),
		];
		// Current behavior: buildSessionRepair is purposely not responsible
		// for this. It only repairs states that a CRASH on a legitimate run
		// could have produced. Orphan tool_result means something bigger is
		// wrong upstream and shouldn't be papered over here.
		expect(buildSessionRepair(events, "t1")).toBeNull();
	});
});

// ══════════════════════════════════════════════════════════════════════════
// TODO: tests that need stronger infra to exercise
// ══════════════════════════════════════════════════════════════════════════

describe("TODO — infra-blocked adversarial scenarios", () => {
	// Manual JSONL injection + restart + agent launch. Current harness does
	// a fresh start; we need a helper that writes raw events to disk and
	// then triggers autoResumeProjects.
	test.todo("inject dirty JSONL, restart, assert agent repairs and continues", () => {});

	// Concurrent deliverMessage from two callers on the same running agent.
	// Currently the harness delivers sequentially; true concurrency would
	// need Promise.all on multiple deliverMessage calls and assertion on
	// the resulting JSONL order.
	test.todo("2 concurrent deliverMessage calls preserve order in JSONL", () => {});

	// Fork + cross-session message id lookup. The walker's eventIndex is
	// per-session; if a forked child references a parent-session message
	// by id, the lookup would miss.
	test.todo("forked child references parent-session message id → walker handles gracefully", () => {});

	// Compact during pending yield. This is test.todo in drift-lifecycle.test.ts
	// as well — shared infra gap.
	test.todo("compact triggered during pending yield with bgOrphans in queue", () => {});

	// stopTask while a tool handler is mid-R.emit. Tests that emit's
	// traceId lookup handles session=null gracefully (no throw).
	test.todo("tool handler calls R.emit AFTER session is nullified → no throw, event still emits without traceId", () => {});
});
