import { beforeEach, describe, expect, test } from "bun:test";
import {
	MockValidationError,
	ValidatingMockAPI,
} from "./mock-anthropic-api.ts";

describe("ValidatingMockAPI", () => {
	let mock: ValidatingMockAPI;

	beforeEach(() => {
		mock = new ValidatingMockAPI();
	});

	// ── Validation ──

	describe("request validation", () => {
		test("rejects empty messages", () => {
			expect(() => mock.createStream({ messages: [] })).toThrow(
				MockValidationError,
			);
		});

		test("rejects first message not user", () => {
			expect(() =>
				mock.createStream({
					messages: [
						{ role: "assistant", content: [{ type: "text", text: "hi" }] },
					],
				}),
			).toThrow("First message must be role 'user'");
		});

		test("rejects consecutive same roles", () => {
			expect(() =>
				mock.createStream({
					messages: [
						{ role: "user", content: "a" },
						{ role: "user", content: "b" },
					],
				}),
			).toThrow("consecutive");
		});

		test("rejects empty string content", () => {
			expect(() =>
				mock.createStream({
					messages: [{ role: "user", content: "" }],
				}),
			).toThrow("empty string content");
		});

		test("rejects empty array content", () => {
			expect(() =>
				mock.createStream({
					messages: [{ role: "user", content: [] }],
				}),
			).toThrow("empty content array");
		});

		test("rejects missing tool_result for tool_use", () => {
			expect(() =>
				mock.createStream({
					messages: [
						{ role: "user", content: "hi" },
						{
							role: "assistant",
							content: [
								{ type: "tool_use", id: "tc_1", name: "bash", input: {} },
							],
						},
						{ role: "user", content: "no tool result here" },
					],
				}),
			).toThrow("Missing tool_result for tool_use_id 'tc_1'");
		});

		test("rejects duplicate tool_result", () => {
			expect(() =>
				mock.createStream({
					messages: [
						{ role: "user", content: "hi" },
						{
							role: "assistant",
							content: [
								{ type: "tool_use", id: "tc_1", name: "bash", input: {} },
							],
						},
						{
							role: "user",
							content: [
								{ type: "tool_result", tool_use_id: "tc_1", content: "ok" },
								{
									type: "tool_result",
									tool_use_id: "tc_1",
									content: "ok again",
								},
							],
						},
					],
				}),
			).toThrow("Duplicate tool_result");
		});

		test("rejects unexpected tool_result", () => {
			expect(() =>
				mock.createStream({
					messages: [
						{ role: "user", content: "hi" },
						{
							role: "assistant",
							content: [
								{ type: "tool_use", id: "tc_1", name: "bash", input: {} },
							],
						},
						{
							role: "user",
							content: [
								{ type: "tool_result", tool_use_id: "tc_1", content: "ok" },
								{
									type: "tool_result",
									tool_use_id: "tc_999",
									content: "orphan",
								},
							],
						},
					],
				}),
			).toThrow("Unexpected tool_result for tool_use_id 'tc_999'");
		});

		test("accepts valid alternating messages", () => {
			const stream = mock.createStream({
				messages: [{ role: "user", content: "hello" }],
			});
			expect(stream).toBeDefined();
		});

		test("accepts valid tool_use/tool_result pair", () => {
			const stream = mock.createStream({
				messages: [
					{ role: "user", content: "hi" },
					{
						role: "assistant",
						content: [
							{ type: "text", text: "checking" },
							{ type: "tool_use", id: "tc_1", name: "bash", input: {} },
						],
					},
					{
						role: "user",
						content: [
							{ type: "tool_result", tool_use_id: "tc_1", content: "done" },
						],
					},
				],
			});
			expect(stream).toBeDefined();
		});
	});

	// ── Instruction parsing ──

	describe("instruction parsing", () => {
		test("single turn instruction returns correct response", async () => {
			const instruction = JSON.stringify({
				blocks: [
					{ type: "text", text: "Hello world" },
					{
						type: "tool_use",
						name: "mcp__opengraft__bash",
						input: { command: "echo hi" },
					},
				],
			});

			const stream = mock.createStream({
				messages: [{ role: "user", content: instruction }],
			});
			const msg = await stream.finalMessage();
			expect(msg.content).toHaveLength(2);
			expect(msg.content[0]).toMatchObject({
				type: "text",
				text: "Hello world",
			});
			expect(msg.content[1]).toMatchObject({
				type: "tool_use",
				name: "mcp__opengraft__bash",
				input: { command: "echo hi" },
			});
			expect(msg.stop_reason).toBe("tool_use");
		});

		test("explicit stop_reason overrides auto-detection", async () => {
			const instruction = JSON.stringify({
				blocks: [{ type: "text", text: "Just text" }],
				stop_reason: "end_turn",
			});

			const stream = mock.createStream({
				messages: [{ role: "user", content: instruction }],
			});
			const msg = await stream.finalMessage();
			expect(msg.stop_reason).toBe("end_turn");
		});

		test("default response for non-instruction text", async () => {
			const stream = mock.createStream({
				messages: [{ role: "user", content: "Just a regular message" }],
			});
			const msg = await stream.finalMessage();
			expect(msg.content).toHaveLength(1);
			expect(msg.content[0]).toMatchObject({
				type: "text",
				text: "Acknowledged.",
			});
			expect(msg.stop_reason).toBe("end_turn");
		});
	});

	// ── Multi-turn ──

	describe("multi-turn instructions", () => {
		test("multi-turn queues subsequent turns", async () => {
			const instruction = JSON.stringify({
				turns: [
					{
						blocks: [
							{ type: "text", text: "Turn 1" },
							{ type: "tool_use", name: "bash", input: {} },
						],
					},
					{
						blocks: [
							{ type: "text", text: "Turn 2" },
							{
								type: "tool_use",
								name: "mcp__opengraft__done",
								input: { status: "passed", summary: "ok" },
							},
						],
					},
				],
			});

			// First call: gets turn 0
			const stream1 = mock.createStream({
				messages: [{ role: "user", content: instruction }],
			});
			const msg1 = await stream1.finalMessage();
			expect(msg1.content[0]).toMatchObject({ type: "text", text: "Turn 1" });
			expect(mock.getPendingTurnCount()).toBe(1);

			// Second call: gets turn 1 from queue (no new instruction needed)
			const stream2 = mock.createStream({
				messages: [
					{ role: "user", content: instruction },
					{ role: "assistant", content: msg1.content },
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id:
									msg1.content[1]?.type === "tool_use"
										? (msg1.content[1] as { id: string }).id
										: "",
								content: "ok",
							},
						],
					},
				],
			});
			const msg2 = await stream2.finalMessage();
			expect(msg2.content[0]).toMatchObject({ type: "text", text: "Turn 2" });
			expect(mock.getPendingTurnCount()).toBe(0);
		});

		test("default response when queue is empty", async () => {
			// No instruction → default
			const stream = mock.createStream({
				messages: [{ role: "user", content: "no instruction here" }],
			});
			const msg = await stream.finalMessage();
			expect(msg.content[0]).toMatchObject({
				type: "text",
				text: "Acknowledged.",
			});
		});
	});

	// ── Streaming ──

	describe("streaming events", () => {
		test("text blocks produce content_block_delta events", async () => {
			const instruction = JSON.stringify({
				blocks: [{ type: "text", text: "Hello" }],
			});

			const stream = mock.createStream({
				messages: [{ role: "user", content: instruction }],
			});

			const events: unknown[] = [];
			for await (const event of stream) {
				events.push(event);
			}

			// Should have: content_block_start, 1+ content_block_delta, content_block_stop
			const deltas = events.filter(
				(e) => (e as { type: string }).type === "content_block_delta",
			);
			expect(deltas.length).toBeGreaterThanOrEqual(1);

			// Delta text should reconstruct the full text
			const fullText = deltas
				.map((d) => (d as { delta: { text: string } }).delta.text)
				.join("");
			expect(fullText).toBe("Hello");
		});

		test("tool_use blocks produce content_block_start events", async () => {
			const instruction = JSON.stringify({
				blocks: [{ type: "tool_use", name: "test_tool", input: { a: 1 } }],
			});

			const stream = mock.createStream({
				messages: [{ role: "user", content: instruction }],
			});

			const events: unknown[] = [];
			for await (const event of stream) {
				events.push(event);
			}

			const starts = events.filter(
				(e) => (e as { type: string }).type === "content_block_start",
			);
			expect(starts).toHaveLength(1);
			expect(
				(starts[0] as { content_block: { type: string; name: string } })
					.content_block,
			).toMatchObject({ type: "tool_use", name: "test_tool" });
		});
	});

	// ── Compaction ──

	describe("compaction detection", () => {
		test("detects compaction request from summarization keywords", async () => {
			const stream = mock.createStream({
				messages: [
					{
						role: "user",
						content:
							"Create a structured checkpoint of the conversation so far.",
					},
				],
			});
			const msg = await stream.finalMessage();
			const text = msg.content[0]?.type === "text" ? msg.content[0].text : "";
			expect(text).toContain("<summary>");
			expect(text).toContain("</summary>");
		});
	});

	// ── Request history ──

	describe("request tracking", () => {
		test("records requests", () => {
			mock.createStream({ messages: [{ role: "user", content: "a" }] });
			mock.createStream({
				messages: [
					{ role: "user", content: "a" },
					{ role: "assistant", content: [{ type: "text", text: "b" }] },
					{ role: "user", content: "c" },
				],
			});
			expect(mock.getRequestCount()).toBe(2);
			expect(mock.getRequestHistory()).toHaveLength(2);
			expect(mock.getLastRequest()?.messages).toHaveLength(3);
		});

		test("reset clears state", () => {
			mock.createStream({ messages: [{ role: "user", content: "a" }] });
			mock.reset();
			expect(mock.getRequestCount()).toBe(0);
			expect(mock.getPendingTurnCount()).toBe(0);
		});
	});

	// ── Instruction in array content with tool_results ──

	describe("instruction extraction from complex messages", () => {
		test("finds instruction in text block alongside tool_results", async () => {
			const instruction = JSON.stringify({
				blocks: [{ type: "text", text: "Found it" }],
			});

			const stream = mock.createStream({
				messages: [
					{ role: "user", content: "start" },
					{
						role: "assistant",
						content: [
							{ type: "tool_use", id: "tc_1", name: "bash", input: {} },
						],
					},
					{
						role: "user",
						content: [
							{ type: "tool_result", tool_use_id: "tc_1", content: "output" },
							{ type: "text", text: instruction },
						],
					},
				],
			});
			const msg = await stream.finalMessage();
			expect(msg.content[0]).toMatchObject({ type: "text", text: "Found it" });
		});

		test("finds instruction embedded in formatted queue message", async () => {
			const instruction = JSON.stringify({
				blocks: [{ type: "text", text: "Found embedded" }],
			});
			const wrappedText = `[Messages received while you were working:]\n[15:42:00] ${instruction}`;

			const stream = mock.createStream({
				messages: [{ role: "user", content: wrappedText }],
			});
			const msg = await stream.finalMessage();
			expect(msg.content[0]).toMatchObject({
				type: "text",
				text: "Found embedded",
			});
		});

		test("returns default when last user message has only tool_results", async () => {
			const stream = mock.createStream({
				messages: [
					{ role: "user", content: "start" },
					{
						role: "assistant",
						content: [
							{ type: "tool_use", id: "tc_1", name: "bash", input: {} },
						],
					},
					{
						role: "user",
						content: [
							{ type: "tool_result", tool_use_id: "tc_1", content: "output" },
						],
					},
				],
			});
			const msg = await stream.finalMessage();
			expect(msg.content[0]).toMatchObject({
				type: "text",
				text: "Acknowledged.",
			});
		});
	});
});
