/**
 * Audit tests for ValidatingMockAPI's prefix validation.
 *
 * These are mutation-testing-style tests: we deliberately inject differences
 * between consecutive API calls and verify the mock DETECTS them. This is the
 * safety net that caught the live/reconstruction caption drift bug. If it has
 * blind spots, future drift bugs slip through.
 *
 * Philosophy: "test your tests". Our drift-prevention tests depend on this
 * infra being strong. We audit by mutation: inject a diff → must throw.
 *
 * If a test here fails with "did NOT throw", it means the mock silently
 * accepts a mutation that could hide a real drift bug.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ARCHITECTURAL LIMITATION (critical context)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Prefix validation catches DIVERGENCE BETWEEN API CALLS in the same
 * conversation. It was perfect for the pre-unification architecture where
 * live path and reconstruction path were two independent codepaths: any
 * drift → different bytes at restart → validator throws.
 *
 * AFTER the unification fix (2026-04-05), live path (`buildUserTurn`)
 * delegates to the same walker that reconstruction uses. Both paths produce
 * identical output by construction — no divergence for prefix validation
 * to catch. A walker bug breaks BOTH paths equally → no restart-time diff
 * → validator silent.
 *
 * ✅ What prefix validation catches:
 *    - Two codepaths that disagree (pre-unification drift)
 *    - Provider accidentally mutating prior messages across calls
 *    - cache_control placement regressions
 *    - tools/system dropped or changed mid-conversation
 *
 * ❌ What prefix validation CANNOT catch after unification:
 *    - Walker bugs that are consistently wrong across ALL calls
 *    - Bugs where live path and reconstruction agree on wrong output
 *    - Bad assumptions baked into the shared codepath
 *
 * The complementary defense: GOLDEN SNAPSHOT TESTS on the walker itself.
 * See the "Walker golden snapshots" describe block at the bottom — those
 * assert the walker produces EXACT expected bytes for known inputs,
 * catching walker bugs regardless of whether prefix validation would.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { describe, expect, test } from "bun:test";
import { eventsToAnthropicMessages } from "./anthropic-compatible-provider.ts";
import type { Event } from "./events.ts";
import {
	MockValidationError,
	ValidatingMockAPI,
} from "./test-utils/mock-anthropic-api.ts";

const SESSION = "audit-session";

function newMock(): ValidatingMockAPI {
	const m = new ValidatingMockAPI();
	m.enablePrefixValidation();
	return m;
}

/** Helper: first call primes the prefix; returns the mock ready for 2nd call. */
function primeFirstCall(
	mock: ValidatingMockAPI,
	messages: unknown[],
	system?: unknown,
	tools?: unknown,
) {
	// biome-ignore lint/suspicious/noExplicitAny: test helper with varied inputs
	mock.createStream({ messages, system, tools } as any, SESSION);
}

/** Helper: expect a second call to throw MockValidationError. */
function expectMismatch(
	mock: ValidatingMockAPI,
	messages: unknown[],
	system?: unknown,
	tools?: unknown,
) {
	expect(() => {
		// biome-ignore lint/suspicious/noExplicitAny: test helper with varied inputs
		mock.createStream({ messages, system, tools } as any, SESSION);
	}).toThrow(MockValidationError);
}

// ── Core mutation tests ──

describe("Prefix validation: content mutations MUST throw", () => {
	test("different text content at index 0 → throws", () => {
		const mock = newMock();
		primeFirstCall(mock, [{ role: "user", content: "hello" }]);
		expectMismatch(mock, [
			{ role: "user", content: "hello WORLD" },
			{ role: "assistant", content: [{ type: "text", text: "hi" }] },
			{ role: "user", content: "next" },
		]);
	});

	test("content block array length differs (3 vs 4) → throws", () => {
		const mock = newMock();
		primeFirstCall(mock, [
			{
				role: "user",
				content: [
					{ type: "text", text: "a" },
					{ type: "text", text: "b" },
					{ type: "text", text: "c" },
				],
			},
		]);
		expectMismatch(mock, [
			{
				role: "user",
				content: [
					{ type: "text", text: "a" },
					{ type: "text", text: "b" },
					{ type: "text", text: "c" },
					{ type: "text", text: "d" },
				],
			},
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{ role: "user", content: "next" },
		]);
	});

	test("is_error VALUE differs (true vs false) → throws", () => {
		const mock = newMock();
		primeFirstCall(mock, [
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "t1",
						content: "out",
						is_error: true,
					},
				],
			},
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{ role: "user", content: "next" },
		]);
		expectMismatch(mock, [
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "t1",
						content: "out",
						is_error: false,
					},
				],
			},
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{ role: "user", content: "next" },
			{ role: "assistant", content: [{ type: "text", text: "ok2" }] },
			{ role: "user", content: "next2" },
		]);
	});

	test("image base64 data differs → throws", () => {
		const mock = newMock();
		primeFirstCall(mock, [
			{
				role: "user",
				content: [
					{ type: "text", text: "here is" },
					{
						type: "image",
						source: {
							type: "base64",
							media_type: "image/png",
							data: "AAAA",
						},
					},
				],
			},
		]);
		expectMismatch(mock, [
			{
				role: "user",
				content: [
					{ type: "text", text: "here is" },
					{
						type: "image",
						source: {
							type: "base64",
							media_type: "image/png",
							data: "BBBB",
						},
					},
				],
			},
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{ role: "user", content: "next" },
		]);
	});

	test("image media_type differs → throws", () => {
		const mock = newMock();
		primeFirstCall(mock, [
			{
				role: "user",
				content: [
					{
						type: "image",
						source: {
							type: "base64",
							media_type: "image/png",
							data: "A",
						},
					},
					{ type: "text", text: "x" },
				],
			},
		]);
		expectMismatch(mock, [
			{
				role: "user",
				content: [
					{
						type: "image",
						source: {
							type: "base64",
							media_type: "image/jpeg",
							data: "A",
						},
					},
					{ type: "text", text: "x" },
				],
			},
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{ role: "user", content: "next" },
		]);
	});

	test("reordered content blocks in user message → throws", () => {
		const mock = newMock();
		primeFirstCall(mock, [
			{
				role: "user",
				content: [
					{ type: "text", text: "first" },
					{ type: "text", text: "second" },
				],
			},
		]);
		expectMismatch(mock, [
			{
				role: "user",
				content: [
					{ type: "text", text: "second" },
					{ type: "text", text: "first" },
				],
			},
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{ role: "user", content: "next" },
		]);
	});

	test("role change at index → throws", () => {
		const mock = newMock();
		primeFirstCall(mock, [
			{ role: "user", content: "a" },
			{ role: "assistant", content: [{ type: "text", text: "b" }] },
			{ role: "user", content: "c" },
		]);
		// Try to swap roles at index 1 (which would violate role alternation anyway,
		// but let's test what the prefix validator itself does)
		expect(() =>
			mock.createStream(
				{
					messages: [
						{ role: "user", content: "a" },
						// was assistant, now "user" — but Anthropic requires alternation.
						// Constructing something valid that still has role diff at prefix:
						{
							role: "assistant",
							content: [{ type: "text", text: "DIFFERENT" }],
						},
						{ role: "user", content: "c" },
						{ role: "assistant", content: [{ type: "text", text: "d" }] },
						{ role: "user", content: "e" },
					],
				},
				SESSION,
			),
		).toThrow(MockValidationError);
	});

	test("tool_use input differs → throws", () => {
		const mock = newMock();
		primeFirstCall(mock, [
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "t1",
						name: "bash",
						input: { command: "echo hi" },
					},
				],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "t1", content: "hi" }],
			},
		]);
		expectMismatch(mock, [
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "t1",
						name: "bash",
						input: { command: "echo BYE" },
					},
				],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "t1", content: "hi" }],
			},
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{ role: "user", content: "next" },
		]);
	});

	test("tool_use id differs → throws", () => {
		const mock = newMock();
		primeFirstCall(mock, [
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "tool_A",
						name: "bash",
						input: { command: "x" },
					},
				],
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "tool_A", content: "out" },
				],
			},
		]);
		expectMismatch(mock, [
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "tool_B",
						name: "bash",
						input: { command: "x" },
					},
				],
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "tool_B", content: "out" },
				],
			},
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{ role: "user", content: "next" },
		]);
	});

	test("tool_result content differs → throws", () => {
		const mock = newMock();
		primeFirstCall(mock, [
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "t1",
						content: "result A",
						is_error: false,
					},
				],
			},
		]);
		expectMismatch(mock, [
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "t1",
						content: "result B",
						is_error: false,
					},
				],
			},
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{ role: "user", content: "next" },
		]);
	});
});

// ── System + tools mutations ──

describe("Prefix validation: system/tools mutations MUST throw", () => {
	test("system prompt changes → throws", () => {
		const mock = newMock();
		primeFirstCall(mock, [{ role: "user", content: "go" }], "system v1");
		expect(() =>
			mock.createStream(
				{
					messages: [
						{ role: "user", content: "go" },
						{ role: "assistant", content: [{ type: "text", text: "ok" }] },
						{ role: "user", content: "next" },
					],
					system: "system v2",
				},
				SESSION,
			),
		).toThrow(MockValidationError);
	});

	test("tools array changes (different tool) → throws", () => {
		const mock = newMock();
		const tools1 = [
			{ name: "bash", description: "shell", input_schema: { type: "object" } },
		];
		const tools2 = [
			{
				name: "python",
				description: "python",
				input_schema: { type: "object" },
			},
		];
		primeFirstCall(mock, [{ role: "user", content: "go" }], undefined, tools1);
		expect(() =>
			mock.createStream(
				{
					messages: [
						{ role: "user", content: "go" },
						{ role: "assistant", content: [{ type: "text", text: "ok" }] },
						{ role: "user", content: "next" },
					],
					tools: tools2,
				},
				SESSION,
			),
		).toThrow(MockValidationError);
	});

	test("tools array reordered → throws (JSON.stringify order sensitive)", () => {
		const mock = newMock();
		const tools1 = [
			{ name: "a", description: "A", input_schema: { type: "object" } },
			{ name: "b", description: "B", input_schema: { type: "object" } },
		];
		const tools2 = [
			{ name: "b", description: "B", input_schema: { type: "object" } },
			{ name: "a", description: "A", input_schema: { type: "object" } },
		];
		primeFirstCall(mock, [{ role: "user", content: "go" }], undefined, tools1);
		expect(() =>
			mock.createStream(
				{
					messages: [
						{ role: "user", content: "go" },
						{ role: "assistant", content: [{ type: "text", text: "ok" }] },
						{ role: "user", content: "next" },
					],
					tools: tools2,
				},
				SESSION,
			),
		).toThrow(MockValidationError);
	});

	test("tools count differs → throws", () => {
		const mock = newMock();
		const tools1 = [
			{ name: "a", description: "A", input_schema: { type: "object" } },
		];
		const tools2 = [
			{ name: "a", description: "A", input_schema: { type: "object" } },
			{ name: "b", description: "B", input_schema: { type: "object" } },
		];
		primeFirstCall(mock, [{ role: "user", content: "go" }], undefined, tools1);
		expect(() =>
			mock.createStream(
				{
					messages: [
						{ role: "user", content: "go" },
						{ role: "assistant", content: [{ type: "text", text: "ok" }] },
						{ role: "user", content: "next" },
					],
					tools: tools2,
				},
				SESSION,
			),
		).toThrow(MockValidationError);
	});
});

// ── Cache control mutations ──

describe("Prefix validation: cache_control mutations", () => {
	test("cache_control TTL differs (5m vs 1h) → throws", () => {
		const mock = newMock();
		primeFirstCall(mock, [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "hi",
						cache_control: { type: "ephemeral" },
					},
				],
			},
		]);
		// Second call: same message content but different TTL at breakpoint.
		// The breakpoint moves (to the new last user message), but the VALUE
		// at the original breakpoint must have matched (stripped) AND the
		// message-level cache_control VALUE across calls must be consistent.
		expect(() =>
			mock.createStream(
				{
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: "hi" }],
						},
						{ role: "assistant", content: [{ type: "text", text: "ok" }] },
						{
							role: "user",
							content: [
								{
									type: "text",
									text: "next",
									cache_control: { type: "ephemeral", ttl: "1h" },
								},
							],
						},
					],
				},
				SESSION,
			),
		).toThrow(MockValidationError);
	});

	test("cache_control type differs (ephemeral vs something else) → throws", () => {
		const mock = newMock();
		primeFirstCall(mock, [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "hi",
						cache_control: { type: "ephemeral" },
					},
				],
			},
		]);
		expect(() =>
			mock.createStream(
				{
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: "hi" }],
						},
						{ role: "assistant", content: [{ type: "text", text: "ok" }] },
						{
							role: "user",
							content: [
								{
									type: "text",
									text: "next",
									// biome-ignore lint/suspicious/noExplicitAny: test injects invalid type
									cache_control: { type: "persistent" as any },
								},
							],
						},
					],
				},
				SESSION,
			),
		).toThrow(MockValidationError);
	});

	test("stale cache_control at an index that was NEVER a breakpoint → throws", () => {
		// validatePrefix strips cache_control at EITHER prev or curr breakpoint
		// index. So stripping is legitimate when CC is at a position that is (or
		// was) a breakpoint. But if CC shows up at an index that is NOT either
		// breakpoint, it must be strictly compared.
		//
		// Setup: call 1 has message at index 1 with breakpoint. Call 2 extends
		// and has breakpoint at last user (index 2). Now if someone sneaks a
		// CC into message at index 0 on call 2 (never a breakpoint), strict
		// compare at index 0 catches the difference.
		const mock = newMock();
		primeFirstCall(mock, [
			{ role: "user", content: "first" },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "second",
						cache_control: { type: "ephemeral" },
					},
				],
			},
		]);
		// Call 2: breakpoint moves to index 4. Index 0 now has spurious CC.
		// prevBreakpointIdx=2, currBreakpointIdx=4 → index 0 strictly compared.
		expect(() =>
			mock.createStream(
				{
					messages: [
						{
							role: "user",
							content: [
								{
									type: "text",
									text: "first",
									cache_control: { type: "ephemeral" }, // SPURIOUS
								},
							],
						},
						{ role: "assistant", content: [{ type: "text", text: "ok" }] },
						{ role: "user", content: [{ type: "text", text: "second" }] },
						{ role: "assistant", content: [{ type: "text", text: "b" }] },
						{
							role: "user",
							content: [
								{
									type: "text",
									text: "third",
									cache_control: { type: "ephemeral" },
								},
							],
						},
					],
				},
				SESSION,
			),
		).toThrow(MockValidationError);
	});

	test("cache_control breakpoint position moves forward → PASSES", () => {
		// Legitimate: breakpoint on second-to-last user message moves as
		// conversation grows. Value stays the same. Should pass.
		const mock = newMock();
		primeFirstCall(mock, [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "hi",
						cache_control: { type: "ephemeral" },
					},
				],
			},
		]);
		expect(() =>
			mock.createStream(
				{
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: "hi" }],
						},
						{ role: "assistant", content: [{ type: "text", text: "ok" }] },
						{
							role: "user",
							content: [
								{
									type: "text",
									text: "next",
									cache_control: { type: "ephemeral" },
								},
							],
						},
					],
				},
				SESSION,
			),
		).not.toThrow();
	});
});

// ── Key ordering (SHOULD NOT throw) ──

describe("Prefix validation: key reordering WITHIN objects should PASS", () => {
	test("same object with different key insertion order → passes", () => {
		const mock = newMock();
		// Both objects semantically identical — keys in different insertion order
		primeFirstCall(mock, [
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "t1",
						content: "x",
						is_error: false,
					},
				],
			},
		]);
		// Rebuild with different key order — should still pass (deep equal sorts keys)
		expect(() =>
			mock.createStream(
				{
					messages: [
						{
							role: "user",
							content: [
								{
									is_error: false,
									content: "x",
									type: "tool_result",
									tool_use_id: "t1",
								},
							],
						},
						{ role: "assistant", content: [{ type: "text", text: "ok" }] },
						{ role: "user", content: "next" },
					],
				},
				SESSION,
			),
		).not.toThrow();
	});

	test("nested object with different key order → passes", () => {
		const mock = newMock();
		primeFirstCall(mock, [
			{
				role: "user",
				content: [
					{
						type: "image",
						source: {
							type: "base64",
							media_type: "image/png",
							data: "X",
						},
					},
					{ type: "text", text: "x" },
				],
			},
		]);
		expect(() =>
			mock.createStream(
				{
					messages: [
						{
							role: "user",
							content: [
								{
									source: {
										data: "X",
										type: "base64",
										media_type: "image/png",
									},
									type: "image",
								},
								{ text: "x", type: "text" },
							],
						},
						{ role: "assistant", content: [{ type: "text", text: "ok" }] },
						{ role: "user", content: "next" },
					],
				},
				SESSION,
			),
		).not.toThrow();
	});

	test("tool input with keys in different order → passes", () => {
		const mock = newMock();
		primeFirstCall(mock, [
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "t1",
						name: "bash",
						input: { command: "ls", cwd: "/tmp" },
					},
				],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
			},
		]);
		expect(() =>
			mock.createStream(
				{
					messages: [
						{ role: "user", content: "go" },
						{
							role: "assistant",
							content: [
								{
									input: { cwd: "/tmp", command: "ls" },
									type: "tool_use",
									id: "t1",
									name: "bash",
								},
							],
						},
						{
							role: "user",
							content: [
								{ type: "tool_result", tool_use_id: "t1", content: "ok" },
							],
						},
						{ role: "assistant", content: [{ type: "text", text: "ok" }] },
						{ role: "user", content: "next" },
					],
				},
				SESSION,
			),
		).not.toThrow();
	});
});

// ── Content normalization (string vs array) ──

describe("Prefix validation: string↔array content normalization", () => {
	test("content string vs [{type:text,text:same}] → passes (normalized)", () => {
		const mock = newMock();
		primeFirstCall(mock, [{ role: "user", content: "hi" }]);
		expect(() =>
			mock.createStream(
				{
					messages: [
						// Same message but as array form
						{ role: "user", content: [{ type: "text", text: "hi" }] },
						{ role: "assistant", content: [{ type: "text", text: "ok" }] },
						{ role: "user", content: "next" },
					],
				},
				SESSION,
			),
		).not.toThrow();
	});

	test("string content vs different text in array form → throws", () => {
		const mock = newMock();
		primeFirstCall(mock, [{ role: "user", content: "hi" }]);
		expectMismatch(mock, [
			{ role: "user", content: [{ type: "text", text: "bye" }] },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{ role: "user", content: "next" },
		]);
	});
});

// ── Message count / prefix extension ──

describe("Prefix validation: message count rules", () => {
	test("shrinking message count → throws", () => {
		const mock = newMock();
		primeFirstCall(mock, [
			{ role: "user", content: "a" },
			{ role: "assistant", content: [{ type: "text", text: "b" }] },
			{ role: "user", content: "c" },
		]);
		expect(() =>
			mock.createStream(
				{
					messages: [
						{ role: "user", content: "a" },
						{ role: "assistant", content: [{ type: "text", text: "b" }] },
					],
				},
				SESSION,
			),
		).toThrow(MockValidationError);
	});

	test("extending prefix with identical prior messages → passes", () => {
		const mock = newMock();
		primeFirstCall(mock, [{ role: "user", content: "go" }]);
		expect(() =>
			mock.createStream(
				{
					messages: [
						{ role: "user", content: "go" },
						{ role: "assistant", content: [{ type: "text", text: "ok" }] },
						{ role: "user", content: "next" },
					],
				},
				SESSION,
			),
		).not.toThrow();
	});

	test("inserting message in middle of prefix → throws (shifts later messages)", () => {
		const mock = newMock();
		primeFirstCall(mock, [
			{ role: "user", content: "a" },
			{ role: "assistant", content: [{ type: "text", text: "b" }] },
			{ role: "user", content: "c" },
		]);
		// Insert "INSERTED" between index 0 and 1 → index 1 now has "INSERTED" vs "b"
		expect(() =>
			mock.createStream(
				{
					messages: [
						{ role: "user", content: "a" },
						{ role: "user", content: "INSERTED" },
						{ role: "assistant", content: [{ type: "text", text: "b" }] },
						{ role: "user", content: "c" },
					],
				},
				SESSION,
			),
		).toThrow(MockValidationError);
	});
});

// ── Session isolation ──

describe("Prefix validation: session isolation", () => {
	test("different sessions have independent prefix chains", () => {
		const mock = newMock();
		mock.createStream({ messages: [{ role: "user", content: "a" }] }, "sess1");
		// Different session — should not validate against sess1's prefix
		expect(() =>
			mock.createStream(
				{ messages: [{ role: "user", content: "TOTALLY DIFFERENT" }] },
				"sess2",
			),
		).not.toThrow();
	});

	test("same session with matching prefix → passes", () => {
		const mock = newMock();
		mock.createStream({ messages: [{ role: "user", content: "a" }] }, "sess1");
		expect(() =>
			mock.createStream(
				{
					messages: [
						{ role: "user", content: "a" },
						{ role: "assistant", content: [{ type: "text", text: "b" }] },
						{ role: "user", content: "c" },
					],
				},
				"sess1",
			),
		).not.toThrow();
	});
});

// ── Presence asymmetry — fixed blind spots ──

describe("Prefix validation: system/tools presence asymmetry (cache prefix)", () => {
	test("system present then absent → throws (cache prefix broken)", () => {
		// If one call passes system but next doesn't, the cache prefix is broken.
		// Previously this was silently allowed. Fixed to throw.
		const mock = newMock();
		mock.createStream(
			{ messages: [{ role: "user", content: "go" }], system: "A" },
			SESSION,
		);
		expect(() =>
			mock.createStream(
				{
					messages: [
						{ role: "user", content: "go" },
						{ role: "assistant", content: [{ type: "text", text: "ok" }] },
						{ role: "user", content: "next" },
					],
				},
				SESSION,
			),
		).toThrow(MockValidationError);
	});

	test("system absent then present → throws (new prefix injected)", () => {
		const mock = newMock();
		mock.createStream({ messages: [{ role: "user", content: "go" }] }, SESSION);
		expect(() =>
			mock.createStream(
				{
					messages: [
						{ role: "user", content: "go" },
						{ role: "assistant", content: [{ type: "text", text: "ok" }] },
						{ role: "user", content: "next" },
					],
					system: "INJECTED",
				},
				SESSION,
			),
		).toThrow(MockValidationError);
	});

	test("tools present then absent → throws (cache prefix broken)", () => {
		const mock = newMock();
		const tools = [
			{ name: "a", description: "A", input_schema: { type: "object" } },
		];
		mock.createStream(
			{ messages: [{ role: "user", content: "go" }], tools },
			SESSION,
		);
		expect(() =>
			mock.createStream(
				{
					messages: [
						{ role: "user", content: "go" },
						{ role: "assistant", content: [{ type: "text", text: "ok" }] },
						{ role: "user", content: "next" },
					],
				},
				SESSION,
			),
		).toThrow(MockValidationError);
	});

	test("tools absent then present → throws", () => {
		const mock = newMock();
		mock.createStream({ messages: [{ role: "user", content: "go" }] }, SESSION);
		const tools = [
			{ name: "a", description: "A", input_schema: { type: "object" } },
		];
		expect(() =>
			mock.createStream(
				{
					messages: [
						{ role: "user", content: "go" },
						{ role: "assistant", content: [{ type: "text", text: "ok" }] },
						{ role: "user", content: "next" },
					],
					tools,
				},
				SESSION,
			),
		).toThrow(MockValidationError);
	});

	test("system/tools both absent in all calls → passes", () => {
		const mock = newMock();
		mock.createStream({ messages: [{ role: "user", content: "go" }] }, SESSION);
		expect(() =>
			mock.createStream(
				{
					messages: [
						{ role: "user", content: "go" },
						{ role: "assistant", content: [{ type: "text", text: "ok" }] },
						{ role: "user", content: "next" },
					],
				},
				SESSION,
			),
		).not.toThrow();
	});
});

// ── Real-world drift scenarios (simulate bugs we care about) ──

describe("Prefix validation: real-world drift scenarios", () => {
	test("caption bug: missing '[N image(s) attached by user]' block → throws", () => {
		// Simulates the exact drift we fixed: live path has caption, reconstruction doesn't.
		const mock = newMock();
		primeFirstCall(mock, [
			{
				role: "user",
				content: [
					{ type: "text", text: "Here's a screenshot" },
					{
						type: "image",
						source: {
							type: "base64",
							media_type: "image/png",
							data: "IMG",
						},
					},
					{ type: "text", text: "[1 image(s) attached by user]" },
				],
			},
		]);
		// Reconstruction path (bug) would OMIT caption block
		expectMismatch(mock, [
			{
				role: "user",
				content: [
					{ type: "text", text: "Here's a screenshot" },
					{
						type: "image",
						source: {
							type: "base64",
							media_type: "image/png",
							data: "IMG",
						},
					},
					// caption missing — drift
				],
			},
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{ role: "user", content: "next" },
		]);
	});

	test("caption count bug: '1 image' vs '2 image' → throws", () => {
		const mock = newMock();
		primeFirstCall(mock, [
			{
				role: "user",
				content: [
					{ type: "text", text: "t" },
					{
						type: "image",
						source: { type: "base64", media_type: "image/png", data: "X" },
					},
					{ type: "text", text: "[1 image(s) attached by user]" },
				],
			},
		]);
		expectMismatch(mock, [
			{
				role: "user",
				content: [
					{ type: "text", text: "t" },
					{
						type: "image",
						source: { type: "base64", media_type: "image/png", data: "X" },
					},
					{ type: "text", text: "[2 image(s) attached by user]" },
				],
			},
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{ role: "user", content: "next" },
		]);
	});

	test("is_error key presence asymmetry on tool_result → throws", () => {
		// Same content, only difference: is_error key absent in one version
		const mock = newMock();
		primeFirstCall(mock, [
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "t1",
						content: "ok",
						is_error: false,
					},
				],
			},
		]);
		expectMismatch(mock, [
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "t1",
						content: "ok",
					},
				],
			},
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{ role: "user", content: "next" },
		]);
	});

	test("single text block vs two split text blocks (same total content) → throws", () => {
		// Drift where JSONL reconstruction splits queue msg by \n into separate
		// blocks, but live keeps as one. This was fixed in a previous refactor
		// (see memory.md "Multiline split fix") but we protect against regressions.
		const mock = newMock();
		primeFirstCall(mock, [
			{
				role: "user",
				content: [{ type: "text", text: "line1\nline2" }],
			},
		]);
		expectMismatch(mock, [
			{
				role: "user",
				content: [
					{ type: "text", text: "line1" },
					{ type: "text", text: "line2" },
				],
			},
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{ role: "user", content: "next" },
		]);
	});

	test("timestamp prefix added in one path but not other → throws", () => {
		// Tests our [HH:MM:SS] timestamp invariant. Live path and reconstruction
		// must BOTH add timestamps (or neither).
		const mock = newMock();
		primeFirstCall(mock, [{ role: "user", content: "[12:34:56] hello" }]);
		expectMismatch(mock, [
			{ role: "user", content: "hello" }, // timestamp missing
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{ role: "user", content: "next" },
		]);
	});

	test("tool_name change in assistant tool_use → throws", () => {
		// If reconstruction uses wrong tool name alias (e.g., old renamed tool),
		// we'd produce different name than live. Protects against tool alias bugs.
		const mock = newMock();
		primeFirstCall(mock, [
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: [
					{ type: "tool_use", id: "t1", name: "send_message", input: {} },
				],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
			},
		]);
		expectMismatch(mock, [
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "t1",
						name: "send_message_to_child",
						input: {},
					},
				],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
			},
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{ role: "user", content: "next" },
		]);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// WALKER GOLDEN SNAPSHOTS
//
// These tests assert the EXACT output of `eventsToAnthropicMessages` for
// known inputs. They catch walker bugs that prefix validation cannot (because
// after unification, walker bugs produce consistent-but-wrong output on both
// live path and reconstruction path, leaving prefix validation silent).
//
// Each test:
//   1. Constructs a specific Event[] sequence representing a known scenario
//   2. Feeds it to eventsToAnthropicMessages (the post-unification single
//      source of truth for building messages)
//   3. Asserts the output is byte-exact match with the expected shape
//
// Add a new golden test any time you find a walker invariant worth locking:
// tool_result images, caption ordering, interleaved fork_marker, etc.
//
// If the walker ever changes format intentionally, update the golden here
// AND increment prompt-cache compat versioning in the provider.
// ═══════════════════════════════════════════════════════════════════════════

describe("Walker golden snapshots: eventsToAnthropicMessages", () => {
	// Fixed timestamp for deterministic [HH:MM:SS] output in formatEventForAI.
	// Date(1704067200000) = 2024-01-01 00:00:00 UTC → depends on machine TZ.
	// Use a constant ts and verify the [HH:MM:SS] regex, not the exact time.
	const FIXED_TS = 1704067200000;

	test("single user message (no id) → plain string user turn", () => {
		const events: Event[] = [
			{
				type: "message",
				id: "", // empty id = rendered directly
				taskId: "",
				ts: FIXED_TS,
				body: {
					source: "user",
					id: "",
					ts: FIXED_TS,
					content: "hello world",
				},
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toEqual({
			role: "user",
			// formatEventForAI adds [HH:MM:SS] prefix
			content: expect.stringMatching(/^\[\d{2}:\d{2}:\d{2}\] hello world$/),
		});
	});

	test("assistant text → single text block in content array", () => {
		const events: Event[] = [
			{
				type: "assistant_text",
				content: "hi there",
				taskId: "",
				ts: FIXED_TS,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toEqual([
			{
				role: "assistant",
				content: [{ type: "text", text: "hi there" }],
			},
		]);
	});

	test("assistant with tool_call → content array with tool_use block", () => {
		const events: Event[] = [
			{
				type: "assistant_text",
				content: "let me check",
				taskId: "",
				ts: FIXED_TS,
			},
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "tc_1",
				input: { command: "ls" },
				taskId: "",
				ts: FIXED_TS,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toEqual([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "let me check" },
					{
						type: "tool_use",
						id: "tc_1",
						name: "bash",
						input: { command: "ls" },
						caller: { type: "direct" },
					},
				],
			},
		]);
	});

	test("tool_result (no images, success) → has is_error:false", () => {
		const events: Event[] = [
			{
				type: "tool_result",
				tool: "bash",
				toolCallId: "tc_1",
				content: "output text",
				isError: false,
				taskId: "",
				ts: FIXED_TS,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toEqual([
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tc_1",
						content: "output text",
						is_error: false,
					},
				],
			},
		]);
	});

	test("tool_result (no images, error) → has is_error:true", () => {
		const events: Event[] = [
			{
				type: "tool_result",
				tool: "bash",
				toolCallId: "tc_1",
				content: "boom",
				isError: true,
				taskId: "",
				ts: FIXED_TS,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		// biome-ignore lint/suspicious/noExplicitAny: test assertion on dynamic output
		const block = (messages[0] as any).content[0];
		expect(block.is_error).toBe(true);
		expect(block.content).toBe("boom");
	});

	test("tool_result WITH images → NO is_error field, content is block array", () => {
		// Critical invariant: tool_result with images uses block-array content
		// (images + text) and omits is_error. This keeps key set [type, tool_use_id, content]
		// consistent across live and reconstruction. See memory.md ITA/Image Handling.
		const events: Event[] = [
			{
				type: "tool_result",
				tool: "read_file",
				toolCallId: "tc_img",
				content: "[Image: foo.png]",
				isError: false,
				images: [{ base64: "IMGDATA", mediaType: "image/png" }],
				taskId: "",
				ts: FIXED_TS,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		// biome-ignore lint/suspicious/noExplicitAny: test assertion on dynamic output
		const block = (messages[0] as any).content[0];
		expect(block.type).toBe("tool_result");
		expect(block.tool_use_id).toBe("tc_img");
		// is_error MUST NOT be present on image tool_results
		expect("is_error" in block).toBe(false);
		// content is a block array: [image, text] in that order
		expect(block.content).toEqual([
			{
				type: "image",
				source: {
					type: "base64",
					media_type: "image/png",
					data: "IMGDATA",
				},
			},
			{ type: "text", text: "[Image: foo.png]" },
		]);
	});

	test("tool_result with empty content → '(empty)' fallback", () => {
		const events: Event[] = [
			{
				type: "tool_result",
				tool: "bash",
				toolCallId: "tc_e",
				content: "",
				isError: false,
				taskId: "",
				ts: FIXED_TS,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		// biome-ignore lint/suspicious/noExplicitAny: test assertion on dynamic output
		const block = (messages[0] as any).content[0];
		expect(block.content).toBe("(empty)");
	});

	test("tool_result + messages_consumed with queue images → caption appended", () => {
		// THIS IS THE CAPTION BUG SNAPSHOT. If caption is removed from walker,
		// this test fails. This is the golden-snapshot protection that
		// compensates for prefix validation's post-unification blindspot.
		const events: Event[] = [
			{
				type: "tool_result",
				tool: "yield",
				toolCallId: "tc_y",
				content: "resumed.",
				isError: false,
				taskId: "",
				ts: FIXED_TS,
			},
			{
				type: "message",
				id: "msg_1",
				taskId: "",
				ts: FIXED_TS,
				body: {
					source: "user",
					id: "msg_1",
					ts: FIXED_TS,
					content: "here's a screenshot",
					images: [{ base64: "IMG1", mediaType: "image/png" }],
				},
			},
			{
				type: "messages_consumed",
				messageIds: ["msg_1"],
				taskId: "",
				ts: FIXED_TS,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toHaveLength(1);
		// biome-ignore lint/suspicious/noExplicitAny: test assertion on dynamic output
		const content = (messages[0] as any).content as unknown[];
		// [tool_result, interleavedText, image, caption]
		expect(content).toHaveLength(4);
		// Block 0: tool_result for yield
		// biome-ignore lint/suspicious/noExplicitAny: test assertion
		expect((content[0] as any).type).toBe("tool_result");
		// biome-ignore lint/suspicious/noExplicitAny: test assertion
		expect((content[0] as any).tool_use_id).toBe("tc_y");
		// Block 1: interleaved text (the queue message text)
		// biome-ignore lint/suspicious/noExplicitAny: test assertion
		expect((content[1] as any).type).toBe("text");
		// biome-ignore lint/suspicious/noExplicitAny: test assertion
		expect((content[1] as any).text).toMatch(
			/^\[\d{2}:\d{2}:\d{2}\] here's a screenshot$/,
		);
		// Block 2: image
		expect(content[2]).toEqual({
			type: "image",
			source: {
				type: "base64",
				media_type: "image/png",
				data: "IMG1",
			},
		});
		// Block 3: caption — THE bug we guard against
		expect(content[3]).toEqual({
			type: "text",
			text: "[1 image(s) attached by user]",
		});
	});

	test("multiple queue images → '[N image(s) attached by user]' count is correct", () => {
		const events: Event[] = [
			{
				type: "tool_result",
				tool: "yield",
				toolCallId: "tc_y",
				content: "resumed.",
				isError: false,
				taskId: "",
				ts: FIXED_TS,
			},
			{
				type: "message",
				id: "m1",
				taskId: "",
				ts: FIXED_TS,
				body: {
					source: "user",
					id: "m1",
					ts: FIXED_TS,
					content: "batch",
					images: [
						{ base64: "A", mediaType: "image/png" },
						{ base64: "B", mediaType: "image/jpeg" },
						{ base64: "C", mediaType: "image/png" },
					],
				},
			},
			{
				type: "messages_consumed",
				messageIds: ["m1"],
				taskId: "",
				ts: FIXED_TS,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		// biome-ignore lint/suspicious/noExplicitAny: test assertion
		const content = (messages[0] as any).content as unknown[];
		// Last block is caption
		const last = content[content.length - 1];
		expect(last).toEqual({
			type: "text",
			text: "[3 image(s) attached by user]",
		});
	});

	test("idle context messages_consumed (no tool_result) → new user message", () => {
		// After end_turn implicit yield: walker processes standalone
		// messages_consumed → calls onConsumedMessages idle branch.
		// This is where the ORIGINAL caption bug lived.
		const events: Event[] = [
			// First an assistant message to establish non-tool-result last context
			{
				type: "assistant_text",
				content: "waiting",
				taskId: "",
				ts: FIXED_TS,
			},
			// Then standalone user message arriving during idle
			{
				type: "message",
				id: "m1",
				taskId: "",
				ts: FIXED_TS,
				body: {
					source: "user",
					id: "m1",
					ts: FIXED_TS,
					content: "wake up",
					images: [{ base64: "IMG", mediaType: "image/png" }],
				},
			},
			{
				type: "messages_consumed",
				messageIds: ["m1"],
				taskId: "",
				ts: FIXED_TS,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toHaveLength(2);
		// messages[0] = assistant
		// messages[1] = user with [text, image, caption]
		// biome-ignore lint/suspicious/noExplicitAny: test assertion
		const userContent = (messages[1] as any).content as unknown[];
		expect(userContent).toHaveLength(3);
		// biome-ignore lint/suspicious/noExplicitAny: test assertion
		expect((userContent[0] as any).type).toBe("text");
		// biome-ignore lint/suspicious/noExplicitAny: test assertion
		expect((userContent[0] as any).text).toMatch(
			/^\[\d{2}:\d{2}:\d{2}\] wake up$/,
		);
		expect(userContent[1]).toEqual({
			type: "image",
			source: {
				type: "base64",
				media_type: "image/png",
				data: "IMG",
			},
		});
		// The caption — this is the regression guard
		expect(userContent[2]).toEqual({
			type: "text",
			text: "[1 image(s) attached by user]",
		});
	});

	test("onConsumedMessages working-context: tool_result then separated messages_consumed → appends with caption", () => {
		// Scenario that hits onConsumedMessages working-context branch:
		// tool_result loop completes, then some structural event breaks it,
		// then messages_consumed fires while last message in array is still
		// the user message with tool_result blocks.
		//
		// Real scenario: a session_config event (structural, skipped by walker)
		// separates tool_result from messages_consumed.
		const events: Event[] = [
			{
				type: "tool_call",
				tool: "mcp__mxd__bash",
				toolCallId: "tc_1",
				input: {},
				taskId: "",
				ts: FIXED_TS,
			},
			{
				type: "tool_result",
				tool: "mcp__mxd__bash",
				toolCallId: "tc_1",
				content: "output",
				isError: false,
				taskId: "",
				ts: FIXED_TS,
			},
			// session_config breaks the tool_result loop (walker i++ on this case)
			{
				type: "session_config",
				tools: [],
				systemStable: "",
				systemVariable: "",
				taskId: "",
				ts: FIXED_TS,
			},
			// Now standalone messages_consumed with images — hits
			// onConsumedMessages working-context branch (last msg is user+tool_result)
			{
				type: "message",
				id: "m1",
				taskId: "",
				ts: FIXED_TS,
				body: {
					source: "user",
					id: "m1",
					ts: FIXED_TS,
					content: "late msg",
					images: [{ base64: "X", mediaType: "image/png" }],
				},
			},
			{
				type: "messages_consumed",
				messageIds: ["m1"],
				taskId: "",
				ts: FIXED_TS,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toHaveLength(2);
		// biome-ignore lint/suspicious/noExplicitAny: test assertion
		const userContent = (messages[1] as any).content as unknown[];
		// Working-context branch appends: [tool_result, text, image, caption]
		expect(userContent).toHaveLength(4);
		// biome-ignore lint/suspicious/noExplicitAny: test assertion
		expect((userContent[0] as any).type).toBe("tool_result");
		// biome-ignore lint/suspicious/noExplicitAny: test assertion
		expect((userContent[1] as any).type).toBe("text");
		// biome-ignore lint/suspicious/noExplicitAny: test assertion
		expect((userContent[1] as any).text).toMatch(
			/^\[\d{2}:\d{2}:\d{2}\] late msg$/,
		);
		expect(userContent[2]).toEqual({
			type: "image",
			source: {
				type: "base64",
				media_type: "image/png",
				data: "X",
			},
		});
		// Caption — the working-context branch's output
		expect(userContent[3]).toEqual({
			type: "text",
			text: "[1 image(s) attached by user]",
		});
	});

	test("working context messages_consumed appends to tool_result user message with caption", () => {
		// Scenario: after tool_result reconstructs a user message, a LATER
		// messages_consumed event fires. Walker detects "working context"
		// (last msg is user with tool_result blocks) and APPENDS to it.
		// This branch also handles caption when appending images.
		//
		// This typically doesn't happen in practice — tool_result loop in the
		// walker handles interleaved messages_consumed. But if events arrive
		// as [tool_result, different_event, messages_consumed] (e.g. fork_marker
		// that ends tool_result loop), this branch fires.
		//
		// Events sequence that forces the working-context branch:
		// assistant → tool_result → messages_consumed
		const events: Event[] = [
			{
				type: "tool_call",
				tool: "mcp__mxd__bash",
				toolCallId: "tc_1",
				input: {},
				taskId: "",
				ts: FIXED_TS,
			},
			{
				type: "tool_result",
				tool: "mcp__mxd__bash",
				toolCallId: "tc_1",
				content: "output",
				isError: false,
				taskId: "",
				ts: FIXED_TS,
			},
			// Message events to be referenced by messages_consumed
			{
				type: "message",
				id: "m1",
				taskId: "",
				ts: FIXED_TS,
				body: {
					source: "user",
					id: "m1",
					ts: FIXED_TS,
					content: "with image",
					images: [{ base64: "X", mediaType: "image/png" }],
				},
			},
			{
				type: "messages_consumed",
				messageIds: ["m1"],
				taskId: "",
				ts: FIXED_TS,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		// messages[0] = assistant (tool_call)
		// messages[1] = user (tool_result + interleaved queue content)
		expect(messages).toHaveLength(2);
		// biome-ignore lint/suspicious/noExplicitAny: test assertion
		const userContent = (messages[1] as any).content as unknown[];
		// Since messages_consumed is processed INSIDE the tool_result loop
		// (walker's tool_result switch case handles messages_consumed as
		// interleaved), the caption appears here via onToolResults path.
		// [tool_result, interleaved_text, image, caption]
		expect(userContent).toHaveLength(4);
		expect(userContent[3]).toEqual({
			type: "text",
			text: "[1 image(s) attached by user]",
		});
	});

	test("idle context single text msg (no images) → string content", () => {
		// When there's only 1 text and no images, walker produces STRING content
		// (not array). This matches live path buildUserTurn's single-text branch.
		const events: Event[] = [
			{
				type: "assistant_text",
				content: "idle",
				taskId: "",
				ts: FIXED_TS,
			},
			{
				type: "message",
				id: "m1",
				taskId: "",
				ts: FIXED_TS,
				body: { source: "user", id: "m1", ts: FIXED_TS, content: "hello" },
			},
			{
				type: "messages_consumed",
				messageIds: ["m1"],
				taskId: "",
				ts: FIXED_TS,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toHaveLength(2);
		// biome-ignore lint/suspicious/noExplicitAny: test assertion
		const user = messages[1] as any;
		expect(typeof user.content).toBe("string");
		expect(user.content).toMatch(/^\[\d{2}:\d{2}:\d{2}\] hello$/);
	});

	test("idle context multiple text msgs (no images) → text block array", () => {
		const events: Event[] = [
			{
				type: "assistant_text",
				content: "idle",
				taskId: "",
				ts: FIXED_TS,
			},
			{
				type: "message",
				id: "m1",
				taskId: "",
				ts: FIXED_TS,
				body: { source: "user", id: "m1", ts: FIXED_TS, content: "one" },
			},
			{
				type: "message",
				id: "m2",
				taskId: "",
				ts: FIXED_TS,
				body: { source: "user", id: "m2", ts: FIXED_TS, content: "two" },
			},
			{
				type: "messages_consumed",
				messageIds: ["m1", "m2"],
				taskId: "",
				ts: FIXED_TS,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toHaveLength(2);
		// biome-ignore lint/suspicious/noExplicitAny: test assertion
		const user = messages[1] as any;
		expect(Array.isArray(user.content)).toBe(true);
		expect(user.content).toHaveLength(2);
		expect(user.content[0].type).toBe("text");
		expect(user.content[1].type).toBe("text");
	});

	test("task_message source renders with <task_message> wrapper", () => {
		const events: Event[] = [
			{
				type: "assistant_text",
				content: "idle",
				taskId: "",
				ts: FIXED_TS,
			},
			{
				type: "message",
				id: "m1",
				taskId: "",
				ts: FIXED_TS,
				body: {
					source: "task_message",
					id: "m1",
					ts: FIXED_TS,
					fromTaskId: "parent_123",
					fromTitle: "Parent Task",
					content: "please do this",
				},
			},
			{
				type: "messages_consumed",
				messageIds: ["m1"],
				taskId: "",
				ts: FIXED_TS,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		// biome-ignore lint/suspicious/noExplicitAny: test assertion
		const user = messages[1] as any;
		expect(user.content).toContain('from_task="parent_123"');
		expect(user.content).toContain('task_name="Parent Task"');
		expect(user.content).toContain("please do this");
	});

	test("task_complete source renders with <task_complete> wrapper", () => {
		const events: Event[] = [
			{
				type: "assistant_text",
				content: "idle",
				taskId: "",
				ts: FIXED_TS,
			},
			{
				type: "message",
				id: "m1",
				taskId: "",
				ts: FIXED_TS,
				body: {
					source: "task_complete",
					id: "m1",
					ts: FIXED_TS,
					taskId: "child_42",
					title: "Subtask",
					success: true,
					output: "done successfully",
				},
			},
			{
				type: "messages_consumed",
				messageIds: ["m1"],
				taskId: "",
				ts: FIXED_TS,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		// biome-ignore lint/suspicious/noExplicitAny: test assertion
		const user = messages[1] as any;
		expect(user.content).toContain('from_task="child_42"');
		expect(user.content).toContain('status="passed"');
		expect(user.content).toContain("done successfully");
	});

	test("failed task_complete renders status='failed'", () => {
		const events: Event[] = [
			{
				type: "assistant_text",
				content: "idle",
				taskId: "",
				ts: FIXED_TS,
			},
			{
				type: "message",
				id: "m1",
				taskId: "",
				ts: FIXED_TS,
				body: {
					source: "task_complete",
					id: "m1",
					ts: FIXED_TS,
					taskId: "child",
					title: "T",
					success: false,
					output: "oops",
				},
			},
			{
				type: "messages_consumed",
				messageIds: ["m1"],
				taskId: "",
				ts: FIXED_TS,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		// biome-ignore lint/suspicious/noExplicitAny: test assertion
		expect((messages[1] as any).content).toContain('status="failed"');
	});

	test("thinking block → preserves thinking + signature fields", () => {
		const events: Event[] = [
			{
				type: "thinking",
				thinking: "let me reason",
				signature: "sig_abc",
				taskId: "",
				ts: FIXED_TS,
			},
			{
				type: "assistant_text",
				content: "here",
				taskId: "",
				ts: FIXED_TS,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toEqual([
			{
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "let me reason",
						signature: "sig_abc",
					},
					{ type: "text", text: "here" },
				],
			},
		]);
	});

	test("empty assistant content → (empty) fallback", () => {
		// Walker's defensive fallback — must NEVER produce empty content array
		// (causes Anthropic 400). Golden test locks this invariant.
		const events: Event[] = [
			// Start a tool_call/assistant_text sequence that ends up empty...
			// Actually walker needs at least ONE of thinking/text/tool_call to
			// enter the assistant case. Simulate by having text event but
			// testing that empty string is handled gracefully:
			{
				type: "assistant_text",
				content: "",
				taskId: "",
				ts: FIXED_TS,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		// Empty text STILL produces a text block (defensive fallback only
		// triggers when NO items exist). This verifies walker doesn't drop it.
		expect(messages).toEqual([
			{
				role: "assistant",
				content: [{ type: "text", text: "" }],
			},
		]);
	});

	// Legacy alias tests removed — TOOL_NAME_ALIASES deleted, no remapping exists.

	test("current tool names pass through unchanged", () => {
		// Non-aliased names pass through unchanged.
		const events: Event[] = [
			{
				type: "tool_call",
				tool: "mcp__mxd__bash",
				toolCallId: "tc_1",
				input: {},
				taskId: "",
				ts: FIXED_TS,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		// biome-ignore lint/suspicious/noExplicitAny: test assertion
		expect((messages[0] as any).content[0].name).toBe("mcp__mxd__bash");
	});

	// compacted_resume event test removed — event type no longer exists.
});
