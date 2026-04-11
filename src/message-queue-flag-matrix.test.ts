/**
 * Exhaustive adversarial tests for MessageQueue flag matrix + onPersist
 * atomicity + setOnPersist constraints.
 *
 * Complements src/message-queue-onpersist.test.ts by pinning the 2×2 matrix
 * (quiet × replay) explicitly and hunting for atomicity violations a refactor
 * could accidentally re-introduce.
 */
import { describe, expect, test } from "bun:test";
import { MessageQueue, type QueueMessage } from "./message-queue.ts";
import { createUserMessage } from "./queue-message-factory.ts";

// ─── Small helpers — flat state recorder for contention/atomicity ──────────

function makeRecorder() {
	const persisted: QueueMessage[] = [];
	const waiterFired: string[] = [];
	return {
		persisted,
		waiterFired,
		onPersist: (m: QueueMessage) => persisted.push(m),
	};
}

// ══════════════════════════════════════════════════════════════════════════
// 2×2 flag matrix — each cell is independently asserted
// ══════════════════════════════════════════════════════════════════════════

describe("MessageQueue flag matrix: quiet × replay (2×2)", () => {
	// Cell 1: !quiet && !replay = normal path
	//   - persists ✓
	//   - wakes waiter ✓
	test("cell(quiet=f, replay=f): persist yes, wake yes", async () => {
		const rec = makeRecorder();
		const q = new MessageQueue({ onPersist: rec.onPersist });
		const waiterP = q.wait().then((m) => {
			if (m.source === "user") rec.waiterFired.push(m.content);
		});
		q.enqueue(createUserMessage("cell-ff"));
		await waiterP;
		expect(rec.persisted.length).toBe(1);
		expect(rec.waiterFired).toEqual(["cell-ff"]);
		expect(q.pending).toBe(0);
	});

	// Cell 2: quiet && !replay = tree_change notifyTargetNode path
	//   - persists ✓
	//   - does NOT wake waiter ✗
	test("cell(quiet=t, replay=f): persist yes, wake NO", async () => {
		const rec = makeRecorder();
		const q = new MessageQueue({ onPersist: rec.onPersist });
		let waiterResolved = false;
		q.wait()
			.then((m) => {
				waiterResolved = true;
				if (m.source === "user") rec.waiterFired.push(m.content);
			})
			.catch(() => {});
		q.enqueue(createUserMessage("cell-tf"), { quiet: true });
		await new Promise((r) => setTimeout(r, 30));
		expect(rec.persisted.length).toBe(1);
		expect(waiterResolved).toBe(false);
		expect(rec.waiterFired).toEqual([]);
		expect(q.pending).toBe(1); // sitting in queue, not delivered
		q.close();
	});

	// Cell 3: !quiet && replay = agent-restart recovery (findUnconsumedMessages)
	//   - does NOT persist ✗
	//   - wakes waiter ✓
	test("cell(quiet=f, replay=t): persist NO, wake yes", async () => {
		const rec = makeRecorder();
		const q = new MessageQueue({ onPersist: rec.onPersist });
		const waiterP = q.wait().then((m) => {
			if (m.source === "user") rec.waiterFired.push(m.content);
		});
		q.enqueue(createUserMessage("cell-ft"), { replay: true });
		await waiterP;
		expect(rec.persisted.length).toBe(0); // replay skipped persistence
		expect(rec.waiterFired).toEqual(["cell-ft"]);
		expect(q.pending).toBe(0);
	});

	// Cell 4: quiet && replay = currently unused but semantics must be complete
	//   - does NOT persist ✗
	//   - does NOT wake waiter ✗
	// This is the safety net for a future use case: recovering from disk into
	// a quiet slot (e.g., pre-queuing notifications on boot without interrupting
	// a running handler).
	test("cell(quiet=t, replay=t): persist NO, wake NO — orthogonal", async () => {
		const rec = makeRecorder();
		const q = new MessageQueue({ onPersist: rec.onPersist });
		let waiterResolved = false;
		q.wait()
			.then(() => {
				waiterResolved = true;
			})
			.catch(() => {});
		q.enqueue(createUserMessage("cell-tt"), { quiet: true, replay: true });
		await new Promise((r) => setTimeout(r, 30));
		expect(rec.persisted.length).toBe(0);
		expect(waiterResolved).toBe(false);
		expect(q.pending).toBe(1);
		q.close();
	});

	// Cross-cell orthogonality: the quiet flag must never affect persist; the
	// replay flag must never affect waiter delivery. If a refactor wires them
	// together, these assertions blow up independently.
	test("quiet flag is orthogonal to persist (2 cells)", () => {
		const rec = makeRecorder();
		const q = new MessageQueue({ onPersist: rec.onPersist });
		q.enqueue(createUserMessage("a"), { quiet: false });
		q.enqueue(createUserMessage("b"), { quiet: true });
		// Both paths hit onPersist regardless of quiet
		expect(rec.persisted.length).toBe(2);
	});

	test("replay flag is orthogonal to waiter delivery (2 cells)", async () => {
		const q = new MessageQueue({ onPersist: () => {} });

		// replay=false
		const p1 = q.wait();
		q.enqueue(createUserMessage("a"), { replay: false });
		const received1 = await p1;
		if (received1.source === "user") expect(received1.content).toBe("a");

		// replay=true
		const p2 = q.wait();
		q.enqueue(createUserMessage("b"), { replay: true });
		const received2 = await p2;
		if (received2.source === "user") expect(received2.content).toBe("b");
	});
});

// ══════════════════════════════════════════════════════════════════════════
// setOnPersist constraints — one-shot wiring contract
// ══════════════════════════════════════════════════════════════════════════

describe("MessageQueue setOnPersist: wiring contract", () => {
	test("bare queue reports hasOnPersist=false", () => {
		const q = new MessageQueue();
		expect(q.hasOnPersist()).toBe(false);
	});

	test("constructor callback reports hasOnPersist=true", () => {
		const q = new MessageQueue({ onPersist: () => {} });
		expect(q.hasOnPersist()).toBe(true);
	});

	test("setOnPersist on bare queue flips hasOnPersist to true", () => {
		const q = new MessageQueue();
		expect(q.hasOnPersist()).toBe(false);
		q.setOnPersist(() => {});
		expect(q.hasOnPersist()).toBe(true);
	});

	test("setOnPersist throws when a callback is already wired (constructor)", () => {
		const q = new MessageQueue({ onPersist: () => {} });
		expect(() => q.setOnPersist(() => {})).toThrow(/already set/);
	});

	test("setOnPersist throws when a callback is already wired (setOnPersist)", () => {
		const q = new MessageQueue();
		q.setOnPersist(() => {});
		expect(() => q.setOnPersist(() => {})).toThrow(/already set/);
	});

	// Adversarial: if setOnPersist ever silently replaced the callback, a
	// production wiring (runAgentForNode) could be clobbered by a provider-loop
	// re-wire, producing message events at the wrong taskId. The error is a
	// defensive gate — keep it loud.
	test("production wiring survives subsequent setOnPersist attempts", () => {
		const productionCalls: QueueMessage[] = [];
		const q = new MessageQueue({
			onPersist: (m) => productionCalls.push(m),
		});
		expect(() => q.setOnPersist(() => {})).toThrow();
		// Production callback is still wired
		q.enqueue(createUserMessage("after-attempted-override"));
		expect(productionCalls.length).toBe(1);
	});
});

// ══════════════════════════════════════════════════════════════════════════
// onPersist atomicity under failure — persist failure must not leak state
// ══════════════════════════════════════════════════════════════════════════

describe("MessageQueue atomicity under onPersist failure", () => {
	// If onPersist throws, the message MUST NOT be delivered or queued.
	// Otherwise, a disk-write failure leaves the message in memory without
	// a JSONL record — a drift bug waiting to happen on restart.
	test("onPersist throws → pending stays zero", () => {
		const q = new MessageQueue({
			onPersist: () => {
				throw new Error("disk full");
			},
		});
		expect(() => q.enqueue(createUserMessage("boom"))).toThrow("disk full");
		expect(q.pending).toBe(0);
	});

	// Specifically: a pending waiter must NOT resolve when persist fails.
	test("onPersist throws with waiter pending → waiter does NOT resolve", async () => {
		const q = new MessageQueue({
			onPersist: () => {
				throw new Error("disk full");
			},
		});
		let waiterResolved = false;
		q.wait()
			.then(() => {
				waiterResolved = true;
			})
			.catch(() => {});
		expect(() => q.enqueue(createUserMessage("x"))).toThrow("disk full");
		await new Promise((r) => setTimeout(r, 20));
		expect(waiterResolved).toBe(false);
		q.close();
	});

	// Ordering: onPersist must fire BEFORE waiter resolves. Otherwise a
	// pathological test could see the waiter get a message that isn't
	// persisted yet and the next line of business code could read JSONL
	// believing the message is recorded.
	test("onPersist ordering: persist runs strictly before waiter resolves", async () => {
		const order: string[] = [];
		const q = new MessageQueue({
			onPersist: () => {
				order.push("persist");
			},
		});
		const p = q.wait().then(() => {
			order.push("waiter-resolved");
		});
		q.enqueue(createUserMessage("ordering"));
		await p;
		expect(order).toEqual(["persist", "waiter-resolved"]);
	});

	// Adversarial: repeated sequential enqueues with a failing persist. Each
	// one must throw and leave pending at 0 — no accumulation.
	test("repeated failing persist: pending stays zero across 10 attempts", () => {
		const q = new MessageQueue({
			onPersist: () => {
				throw new Error("disk full");
			},
		});
		for (let i = 0; i < 10; i++) {
			expect(() => q.enqueue(createUserMessage(`n${i}`))).toThrow();
			expect(q.pending).toBe(0);
		}
	});

	// Adversarial: mixture of failing and succeeding persists. After a failing
	// one, the queue must recover — later successful enqueues still work.
	test("queue recovers: failing persist does NOT break subsequent enqueues", () => {
		let shouldThrow = true;
		const persisted: QueueMessage[] = [];
		const q = new MessageQueue({
			onPersist: (m) => {
				if (shouldThrow) throw new Error("disk full");
				persisted.push(m);
			},
		});
		expect(() => q.enqueue(createUserMessage("bad"))).toThrow();
		shouldThrow = false;
		q.enqueue(createUserMessage("good"));
		expect(persisted.length).toBe(1);
		expect(q.pending).toBe(1);
	});
});

// ══════════════════════════════════════════════════════════════════════════
// Adversarial: multiple waiters, FIFO, message identity preservation
// ══════════════════════════════════════════════════════════════════════════

describe("MessageQueue adversarial scenarios", () => {
	// FIFO across 20 quiet enqueues — drain order must match enqueue order.
	// Attack: if the internal array were replaced with a Set or the wrong
	// collection, drain would reorder. This pins FIFO explicitly.
	test("FIFO order preserved across 20 enqueues", () => {
		const q = new MessageQueue({ onPersist: () => {} });
		const expected: string[] = [];
		for (let i = 0; i < 20; i++) {
			const content = `msg-${String(i).padStart(2, "0")}`;
			expected.push(content);
			q.enqueue(createUserMessage(content), { quiet: true });
		}
		const drained = q.drain();
		const actual = drained.map((m) =>
			m.source === "user" ? m.content : m.source,
		);
		expect(actual).toEqual(expected);
	});

	// Adversarial: enqueue AFTER a waiter registers, then another enqueue.
	// Waiter takes the first, second stays in queue. This pins the handoff
	// semantics — a bug could dump both on the waiter or neither.
	test("single waiter takes exactly one message; second message stays in queue", async () => {
		const q = new MessageQueue({ onPersist: () => {} });
		const p = q.wait();
		q.enqueue(createUserMessage("first"));
		q.enqueue(createUserMessage("second"));
		const msg = await p;
		if (msg.source === "user") expect(msg.content).toBe("first");
		expect(q.pending).toBe(1);
		const rest = q.drain();
		if (rest[0]?.source === "user") expect(rest[0].content).toBe("second");
	});

	// Adversarial: waiter registers WHILE messages are pending. waitForMessage
	// should resolve synchronously with the first pending message.
	test("waiter on queue with pending messages resolves immediately", async () => {
		const q = new MessageQueue({ onPersist: () => {} });
		q.enqueue(createUserMessage("already-here"), { quiet: true });
		q.enqueue(createUserMessage("also-here"), { quiet: true });
		const msg = await q.wait();
		if (msg.source === "user") expect(msg.content).toBe("already-here");
		// Second message still sits — drain picks it up
		expect(q.pending).toBe(1);
	});

	// Adversarial: onPersist is called with the same object reference. A
	// refactor that clones the message before persisting would break any
	// downstream code holding the original reference (production does this
	// via JSONL writer closures).
	test("onPersist receives the SAME object reference as enqueue", () => {
		const captured: QueueMessage[] = [];
		const q = new MessageQueue({
			onPersist: (m) => captured.push(m),
		});
		const msg = createUserMessage("ref");
		q.enqueue(msg);
		expect(captured[0]).toBe(msg); // strict identity, not just structural
	});

	// Adversarial: throwing onPersist must not corrupt message-id injection.
	// Regression guard for a hypothetical "let me wrap onPersist with a
	// default catch block" refactor that would silently drop messages.
	test("thrown onPersist is visible to caller (not silently swallowed)", () => {
		const q = new MessageQueue({
			onPersist: () => {
				throw new Error("caught");
			},
		});
		let thrown: unknown;
		try {
			q.enqueue(createUserMessage("x"));
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toBe("caught");
	});

	// Adversarial: replay + quiet combination (currently unused in production).
	// If the combination breaks some invariant, the test is the place to find
	// out now, not when a future feature starts using it.
	test("replay+quiet: bypass persist, bypass waiter, still in queue", async () => {
		let persistCalls = 0;
		const q = new MessageQueue({ onPersist: () => persistCalls++ });
		let waiterFired = false;
		q.wait()
			.then(() => {
				waiterFired = true;
			})
			.catch(() => {});
		q.enqueue(createUserMessage("both-flags"), {
			replay: true,
			quiet: true,
		});
		await new Promise((r) => setTimeout(r, 20));
		expect(persistCalls).toBe(0);
		expect(waiterFired).toBe(false);
		expect(q.pending).toBe(1);
		q.close();
	});

	// Adversarial: missing id validation fires BEFORE onPersist is called.
	// A refactor could slip this assertion and end up persisting a broken
	// id-less message that then fails findUnconsumedMessages dedup on resume.
	test("missing id rejected strictly before onPersist runs", () => {
		let persistCalled = false;
		const q = new MessageQueue({
			onPersist: () => {
				persistCalled = true;
			},
		});
		expect(() =>
			q.enqueue({ source: "user", id: "", ts: 0, content: "x" }),
		).toThrow();
		expect(persistCalled).toBe(false);
	});

	// Adversarial: closed queue rejects BEFORE onPersist runs.
	// Drop a message on a closed queue → onPersist must not fire, because
	// the writer would emit a JSONL line the agent never sees.
	test("closed queue rejects BEFORE onPersist runs", () => {
		let persistCalled = false;
		const q = new MessageQueue({
			onPersist: () => {
				persistCalled = true;
			},
		});
		q.close();
		expect(() => q.enqueue(createUserMessage("after-close"))).toThrow(
			"Queue closed",
		);
		expect(persistCalled).toBe(false);
	});
});

// ══════════════════════════════════════════════════════════════════════════
// TODO: tests that need stronger infra to exercise
// ══════════════════════════════════════════════════════════════════════════

describe("MessageQueue: TODO — infra-blocked adversarial scenarios", () => {
	// Race between deliverMessage from two callers simultaneously while the
	// provider loop drains — enqueue order stability under true concurrent
	// callers (the bun runtime is single-threaded but async timing can still
	// produce non-deterministic ordering if onPersist yields).
	test.todo("two concurrent enqueue() calls preserve submission order under scheduler", () => {});

	// Adversarial: onPersist that awaits a promise — currently undocumented,
	// the signature is synchronous. If someone passes an async callback, the
	// delivery happens before persistence completes. A future refactor might
	// want to support async onPersist with a queue of pending writes.
	test.todo("async onPersist should either be rejected or awaited before delivery", () => {});

	// The enqueue path calls onPersist THEN push-to-array. If onPersist is
	// slow and a second enqueue arrives in the meantime, can they interleave?
	// In single-threaded JS no, but a test that documents the assumption is
	// useful — future async changes must revisit.
	test.todo("slow onPersist serializes subsequent enqueue calls", () => {});
});
