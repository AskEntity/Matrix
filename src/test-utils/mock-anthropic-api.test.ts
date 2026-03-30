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
						name: "mcp__mxd__bash",
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
				name: "mcp__mxd__bash",
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
								name: "mcp__mxd__done",
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
			const wrappedText = `[15:42:00] ${instruction}`;

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

	/** Helper: build messages with tool_use → tool_result flow for assert testing. */
	function messagesWithToolResults(
		instruction: string,
		toolResults: Array<{
			id: string;
			content: string;
			is_error?: boolean;
		}>,
	) {
		return {
			messages: [
				{ role: "user" as const, content: instruction },
				{
					role: "assistant" as const,
					content: toolResults.map((tr) => ({
						type: "tool_use" as const,
						id: tr.id,
						name: "bash",
						input: {},
						caller: { type: "direct" as const },
					})),
				},
				{
					role: "user" as const,
					content: toolResults.map((tr) => ({
						type: "tool_result" as const,
						tool_use_id: tr.id,
						content: tr.content,
						is_error: tr.is_error ?? false,
					})),
				},
			],
		};
	}

	// ── Assert DSL ──

	describe("assert DSL", () => {
		test("assert contains passes when content matches", async () => {
			const instruction = JSON.stringify({
				turns: [
					{
						blocks: [
							{ type: "tool_use", name: "bash", input: { command: "echo hi" } },
						],
					},
					{
						assert: [
							{ block: 0, type: "tool_result", contains: "hello_world" },
						],
						blocks: [{ type: "text", text: "Found it" }],
					},
				],
			});

			// First call: get turn 0
			mock.createStream({ messages: [{ role: "user", content: instruction }] });

			// Second call with tool_result containing expected text
			const stream = mock.createStream(
				messagesWithToolResults(instruction, [
					{ id: "tc_1", content: "output: hello_world done" },
				]),
			);
			const msg = await stream.finalMessage();
			expect(msg.content[0]).toMatchObject({ type: "text", text: "Found it" });
		});

		test("assert contains fails when content doesn't match", () => {
			const instruction = JSON.stringify({
				turns: [
					{
						blocks: [
							{ type: "tool_use", name: "bash", input: { command: "echo hi" } },
						],
					},
					{
						assert: [
							{ block: 0, type: "tool_result", contains: "expected_output" },
						],
						blocks: [{ type: "text", text: "Done" }],
					},
				],
			});

			mock.createStream({ messages: [{ role: "user", content: instruction }] });

			expect(() =>
				mock.createStream(
					messagesWithToolResults(instruction, [
						{ id: "tc_1", content: "wrong output" },
					]),
				),
			).toThrow('does not contain "expected_output"');
		});

		test("assert notContains passes when content doesn't contain", async () => {
			const instruction = JSON.stringify({
				turns: [
					{
						blocks: [
							{ type: "tool_use", name: "bash", input: { command: "test" } },
						],
					},
					{
						assert: [{ block: 0, type: "tool_result", notContains: "error" }],
						blocks: [{ type: "text", text: "Good" }],
					},
				],
			});

			mock.createStream({ messages: [{ role: "user", content: instruction }] });

			const stream = mock.createStream(
				messagesWithToolResults(instruction, [
					{ id: "tc_1", content: "success: all ok" },
				]),
			);
			const msg = await stream.finalMessage();
			expect(msg.content[0]).toMatchObject({ type: "text", text: "Good" });
		});

		test("assert notContains fails when content contains forbidden string", () => {
			const instruction = JSON.stringify({
				turns: [
					{
						blocks: [
							{ type: "tool_use", name: "bash", input: { command: "test" } },
						],
					},
					{
						assert: [{ block: 0, type: "tool_result", notContains: "error" }],
						blocks: [{ type: "text", text: "Done" }],
					},
				],
			});

			mock.createStream({ messages: [{ role: "user", content: instruction }] });

			expect(() =>
				mock.createStream(
					messagesWithToolResults(instruction, [
						{ id: "tc_1", content: "fatal error occurred" },
					]),
				),
			).toThrow('contains "error" but should not');
		});

		test("assert isError checks the is_error flag", async () => {
			const instruction = JSON.stringify({
				turns: [
					{
						blocks: [
							{ type: "tool_use", name: "bash", input: { command: "fail" } },
						],
					},
					{
						assert: [{ block: 0, type: "tool_result", isError: true }],
						blocks: [{ type: "text", text: "Error confirmed" }],
					},
				],
			});

			mock.createStream({ messages: [{ role: "user", content: instruction }] });

			const stream = mock.createStream(
				messagesWithToolResults(instruction, [
					{ id: "tc_1", content: "command failed", is_error: true },
				]),
			);
			const msg = await stream.finalMessage();
			expect(msg.content[0]).toMatchObject({
				type: "text",
				text: "Error confirmed",
			});
		});

		test("assert isError fails on mismatch", () => {
			const instruction = JSON.stringify({
				turns: [
					{
						blocks: [
							{ type: "tool_use", name: "bash", input: { command: "ok" } },
						],
					},
					{
						assert: [{ block: 0, type: "tool_result", isError: true }],
						blocks: [{ type: "text", text: "Done" }],
					},
				],
			});

			mock.createStream({ messages: [{ role: "user", content: instruction }] });

			expect(() =>
				mock.createStream(
					messagesWithToolResults(instruction, [
						{ id: "tc_1", content: "ok", is_error: false },
					]),
				),
			).toThrow("isError=false, expected true");
		});

		test("assert matches uses regex", async () => {
			const instruction = JSON.stringify({
				turns: [
					{
						blocks: [
							{ type: "tool_use", name: "bash", input: { command: "ver" } },
						],
					},
					{
						assert: [
							{ block: 0, type: "tool_result", matches: "v\\d+\\.\\d+\\.\\d+" },
						],
						blocks: [{ type: "text", text: "Version found" }],
					},
				],
			});

			mock.createStream({ messages: [{ role: "user", content: instruction }] });

			const stream = mock.createStream(
				messagesWithToolResults(instruction, [
					{ id: "tc_1", content: "version: v1.2.3" },
				]),
			);
			const msg = await stream.finalMessage();
			expect(msg.content[0]).toMatchObject({
				type: "text",
				text: "Version found",
			});
		});

		test("assert on missing block index throws", () => {
			const instruction = JSON.stringify({
				turns: [
					{
						blocks: [
							{ type: "tool_use", name: "bash", input: { command: "test" } },
						],
					},
					{
						assert: [{ block: 5, contains: "anything" }],
						blocks: [{ type: "text", text: "Done" }],
					},
				],
			});

			mock.createStream({ messages: [{ role: "user", content: instruction }] });

			expect(() =>
				mock.createStream(
					messagesWithToolResults(instruction, [
						{ id: "tc_1", content: "only one result" },
					]),
				),
			).toThrow("no content block at index 5");
		});

		test("assert on multiple tool results checks each independently", async () => {
			const instruction = JSON.stringify({
				turns: [
					{
						blocks: [
							{
								type: "tool_use",
								name: "bash",
								input: { command: "echo hello" },
							},
							{
								type: "tool_use",
								name: "bash",
								input: { command: "echo world" },
							},
						],
					},
					{
						assert: [
							{ block: 0, type: "tool_result", contains: "hello" },
							{ block: 1, type: "tool_result", contains: "world" },
						],
						blocks: [{ type: "text", text: "Both matched" }],
					},
				],
			});

			mock.createStream({ messages: [{ role: "user", content: instruction }] });

			const stream = mock.createStream(
				messagesWithToolResults(instruction, [
					{ id: "tc_1", content: "output: hello" },
					{ id: "tc_2", content: "output: world" },
				]),
			);
			const msg = await stream.finalMessage();
			expect(msg.content[0]).toMatchObject({
				type: "text",
				text: "Both matched",
			});
		});

		test("assert type validation catches wrong block type", () => {
			const instruction = JSON.stringify({
				turns: [
					{
						blocks: [
							{ type: "tool_use", name: "bash", input: { command: "test" } },
						],
					},
					{
						assert: [{ block: 0, type: "text", contains: "hello" }],
						blocks: [{ type: "text", text: "Done" }],
					},
				],
			});

			mock.createStream({ messages: [{ role: "user", content: instruction }] });

			expect(() =>
				mock.createStream(
					messagesWithToolResults(instruction, [
						{ id: "tc_1", content: "hello world" },
					]),
				),
			).toThrow('has type "tool_result", expected "text"');
		});

		test("assert on text block alongside tool_results", async () => {
			const instruction = JSON.stringify({
				turns: [
					{
						blocks: [
							{ type: "tool_use", name: "bash", input: { command: "echo hi" } },
						],
					},
					{
						assert: [
							{ block: 0, type: "tool_result", contains: "output" },
							{ block: 1, type: "text", contains: "injected" },
						],
						blocks: [{ type: "text", text: "Both checked" }],
					},
				],
			});

			mock.createStream({ messages: [{ role: "user", content: instruction }] });

			// Build a user message with tool_result + text block
			const stream = mock.createStream({
				messages: [
					{ role: "user" as const, content: instruction },
					{
						role: "assistant" as const,
						content: [
							{
								type: "tool_use" as const,
								id: "tc_1",
								name: "bash",
								input: {},
								caller: { type: "direct" as const },
							},
						],
					},
					{
						role: "user" as const,
						content: [
							{
								type: "tool_result" as const,
								tool_use_id: "tc_1",
								content: "output: success",
								is_error: false,
							},
							{
								type: "text" as const,
								text: "injected message from queue",
							},
						],
					},
				],
			});
			const msg = await stream.finalMessage();
			expect(msg.content[0]).toMatchObject({
				type: "text",
				text: "Both checked",
			});
		});

		test("assert without type skips type check", async () => {
			const instruction = JSON.stringify({
				turns: [
					{
						blocks: [
							{ type: "tool_use", name: "bash", input: { command: "test" } },
						],
					},
					{
						assert: [{ block: 0, contains: "hello" }],
						blocks: [{ type: "text", text: "Matched" }],
					},
				],
			});

			mock.createStream({ messages: [{ role: "user", content: instruction }] });

			const stream = mock.createStream(
				messagesWithToolResults(instruction, [
					{ id: "tc_1", content: "hello world" },
				]),
			);
			const msg = await stream.finalMessage();
			expect(msg.content[0]).toMatchObject({ type: "text", text: "Matched" });
		});

		test("isError on non-tool_result block throws", () => {
			const instruction = JSON.stringify({
				turns: [
					{
						blocks: [
							{ type: "tool_use", name: "bash", input: { command: "test" } },
						],
					},
					{
						assert: [{ block: 1, type: "text", isError: true }],
						blocks: [{ type: "text", text: "Done" }],
					},
				],
			});

			mock.createStream({ messages: [{ role: "user", content: instruction }] });

			expect(() =>
				mock.createStream({
					messages: [
						{ role: "user" as const, content: instruction },
						{
							role: "assistant" as const,
							content: [
								{
									type: "tool_use" as const,
									id: "tc_1",
									name: "bash",
									input: {},
									caller: { type: "direct" as const },
								},
							],
						},
						{
							role: "user" as const,
							content: [
								{
									type: "tool_result" as const,
									tool_use_id: "tc_1",
									content: "ok",
									is_error: false,
								},
								{
									type: "text" as const,
									text: "some text",
								},
							],
						},
					],
				}),
			).toThrow("isError check is only valid for tool_result blocks");
		});

		test("assert length validates total block count", async () => {
			const instruction = JSON.stringify({
				turns: [
					{
						blocks: [
							{ type: "tool_use", name: "bash", input: { command: "test" } },
						],
					},
					{
						assert: [{ length: 1 }],
						blocks: [{ type: "text", text: "Only one block" }],
					},
				],
			});

			mock.createStream({ messages: [{ role: "user", content: instruction }] });

			const stream = mock.createStream(
				messagesWithToolResults(instruction, [
					{ id: "tc_1", content: "result" },
				]),
			);
			const msg = await stream.finalMessage();
			expect(msg.content[0]).toMatchObject({
				type: "text",
				text: "Only one block",
			});
		});

		test("assert length fails when count mismatches", () => {
			const instruction = JSON.stringify({
				turns: [
					{
						blocks: [
							{ type: "tool_use", name: "bash", input: { command: "test" } },
						],
					},
					{
						assert: [{ length: 2 }],
						blocks: [{ type: "text", text: "Done" }],
					},
				],
			});

			mock.createStream({ messages: [{ role: "user", content: instruction }] });

			expect(() =>
				mock.createStream(
					messagesWithToolResults(instruction, [
						{ id: "tc_1", content: "only one" },
					]),
				),
			).toThrow("expected 2 content blocks, found 1");
		});

		test("assert length combined with block asserts", async () => {
			const instruction = JSON.stringify({
				turns: [
					{
						blocks: [
							{ type: "tool_use", name: "bash", input: { command: "test" } },
						],
					},
					{
						assert: [
							{ length: 2 },
							{ block: 0, type: "tool_result", contains: "done" },
							{ block: 1, type: "text", contains: "injected" },
						],
						blocks: [{ type: "text", text: "All verified" }],
					},
				],
			});

			mock.createStream({ messages: [{ role: "user", content: instruction }] });

			const stream = mock.createStream({
				messages: [
					{ role: "user" as const, content: instruction },
					{
						role: "assistant" as const,
						content: [
							{
								type: "tool_use" as const,
								id: "tc_1",
								name: "bash",
								input: {},
								caller: { type: "direct" as const },
							},
						],
					},
					{
						role: "user" as const,
						content: [
							{
								type: "tool_result" as const,
								tool_use_id: "tc_1",
								content: "done",
								is_error: false,
							},
							{
								type: "text" as const,
								text: "injected message",
							},
						],
					},
				],
			});
			const msg = await stream.finalMessage();
			expect(msg.content[0]).toMatchObject({
				type: "text",
				text: "All verified",
			});
		});

		test("turns without assert work unchanged (backward compat)", async () => {
			const instruction = JSON.stringify({
				turns: [
					{
						blocks: [
							{ type: "tool_use", name: "bash", input: { command: "echo" } },
						],
					},
					{
						// No assert array — should work exactly as before
						blocks: [{ type: "text", text: "No asserts here" }],
					},
				],
			});

			mock.createStream({ messages: [{ role: "user", content: instruction }] });

			const stream = mock.createStream(
				messagesWithToolResults(instruction, [
					{ id: "tc_1", content: "anything" },
				]),
			);
			const msg = await stream.finalMessage();
			expect(msg.content[0]).toMatchObject({
				type: "text",
				text: "No asserts here",
			});
		});
	});

	// ── Variable capture + substitution ──

	describe("variable capture and substitution", () => {
		test("capture extracts value and substitutes in later blocks", async () => {
			const instruction = JSON.stringify({
				turns: [
					{
						blocks: [
							{
								type: "tool_use",
								name: "create_task",
								input: { title: "test" },
							},
						],
					},
					{
						assert: [
							{
								block: 0,
								type: "tool_result",
								capture: { taskId: "regex:Task (\\S+) created" },
							},
						],
						blocks: [
							{
								type: "tool_use",
								name: "send_message",
								input: { taskId: "$taskId", message: "hello" },
							},
						],
					},
				],
			});

			mock.createStream({ messages: [{ role: "user", content: instruction }] });

			const stream = mock.createStream(
				messagesWithToolResults(instruction, [
					{ id: "tc_1", content: "Task ABC123 created successfully" },
				]),
			);
			const msg = await stream.finalMessage();
			// The tool_use should have the substituted taskId
			const toolUse = msg.content.find((b) => b.type === "tool_use") as {
				type: "tool_use";
				input: Record<string, unknown>;
			};
			expect(toolUse.input.taskId).toBe("ABC123");
		});

		test("capture failure throws when regex doesn't match", () => {
			const instruction = JSON.stringify({
				turns: [
					{
						blocks: [
							{ type: "tool_use", name: "bash", input: { command: "test" } },
						],
					},
					{
						assert: [
							{
								block: 0,
								type: "tool_result",
								capture: { id: "regex:ID: (\\d+)" },
							},
						],
						blocks: [{ type: "text", text: "Done" }],
					},
				],
			});

			mock.createStream({ messages: [{ role: "user", content: instruction }] });

			expect(() =>
				mock.createStream(
					messagesWithToolResults(instruction, [
						{ id: "tc_1", content: "no id here" },
					]),
				),
			).toThrow("did not capture group 1");
		});

		test("getCapturedVars returns captured values", () => {
			const instruction = JSON.stringify({
				turns: [
					{
						blocks: [
							{ type: "tool_use", name: "bash", input: { command: "test" } },
						],
					},
					{
						assert: [
							{
								block: 0,
								type: "tool_result",
								capture: { myVar: "regex:value=(\\w+)" },
							},
						],
						blocks: [{ type: "text", text: "Done" }],
					},
				],
			});

			mock.createStream({ messages: [{ role: "user", content: instruction }] });
			mock.createStream(
				messagesWithToolResults(instruction, [
					{ id: "tc_1", content: "the value=foobar here" },
				]),
			);

			expect(mock.getCapturedVars().get("myVar")).toBe("foobar");
		});

		test("variable substitution in text blocks", async () => {
			const instruction = JSON.stringify({
				turns: [
					{
						blocks: [
							{ type: "tool_use", name: "bash", input: { command: "test" } },
						],
					},
					{
						assert: [
							{
								block: 0,
								type: "tool_result",
								capture: { name: "regex:name=(\\w+)" },
							},
						],
						blocks: [
							{
								type: "text",
								text: "Hello $name, welcome!",
							},
						],
					},
				],
			});

			mock.createStream({ messages: [{ role: "user", content: instruction }] });

			const stream = mock.createStream(
				messagesWithToolResults(instruction, [
					{ id: "tc_1", content: "name=World" },
				]),
			);
			const msg = await stream.finalMessage();
			expect(msg.content[0]).toMatchObject({
				type: "text",
				text: "Hello World, welcome!",
			});
		});

		test("variables persist across turns", async () => {
			const instruction = JSON.stringify({
				turns: [
					{
						blocks: [
							{ type: "tool_use", name: "bash", input: { command: "get_id" } },
						],
					},
					{
						assert: [
							{
								block: 0,
								type: "tool_result",
								capture: { id: "regex:id=(\\w+)" },
							},
						],
						blocks: [
							{
								type: "tool_use",
								name: "bash",
								input: { command: "use $id" },
							},
						],
					},
					{
						// Third turn: variable should still be available
						blocks: [
							{
								type: "text",
								text: "Used $id",
							},
						],
					},
				],
			});

			// Turn 0
			mock.createStream({ messages: [{ role: "user", content: instruction }] });

			// Turn 1: capture id from tool_result
			const stream1 = mock.createStream(
				messagesWithToolResults(instruction, [
					{ id: "tc_1", content: "id=XYZ789" },
				]),
			);
			const msg1 = await stream1.finalMessage();
			const toolUse = msg1.content.find((b) => b.type === "tool_use") as {
				input: Record<string, unknown>;
			};
			expect(toolUse.input.command).toBe("use XYZ789");

			// Turn 2: variable persists
			const stream2 = mock.createStream(
				messagesWithToolResults(instruction, [{ id: "tc_2", content: "ok" }]),
			);
			const msg2 = await stream2.finalMessage();
			expect(msg2.content[0]).toMatchObject({
				type: "text",
				text: "Used XYZ789",
			});
		});

		test("reset clears captured variables", () => {
			const instruction = JSON.stringify({
				turns: [
					{
						blocks: [
							{ type: "tool_use", name: "bash", input: { command: "test" } },
						],
					},
					{
						assert: [
							{
								block: 0,
								type: "tool_result",
								capture: { x: "regex:(\\w+)" },
							},
						],
						blocks: [{ type: "text", text: "ok" }],
					},
				],
			});

			mock.createStream({ messages: [{ role: "user", content: instruction }] });
			mock.createStream(
				messagesWithToolResults(instruction, [
					{ id: "tc_1", content: "hello" },
				]),
			);
			expect(mock.getCapturedVars().size).toBe(1);

			mock.reset();
			expect(mock.getCapturedVars().size).toBe(0);
		});
	});
});
