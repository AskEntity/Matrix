import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clearContextWindowCache,
	convertToolsToOpenAI,
	fetchContextWindowFromAPI,
	getContextWindow,
	getModelPricing,
	OpenAICompatibleProvider,
} from "./openai-compatible-provider.ts";
import { TOOLS } from "./tools/index.ts";

// ── Pricing ──

describe("getModelPricing", () => {
	test("returns gpt-4o pricing for exact match", () => {
		const p = getModelPricing("gpt-4o");
		expect(p.inputPer1M).toBe(2.5);
		expect(p.outputPer1M).toBe(10);
	});

	test("returns gpt-4o-mini pricing", () => {
		const p = getModelPricing("gpt-4o-mini");
		expect(p.inputPer1M).toBe(0.15);
		expect(p.outputPer1M).toBe(0.6);
	});

	test("returns o3 pricing", () => {
		const p = getModelPricing("o3");
		expect(p.inputPer1M).toBe(10);
		expect(p.outputPer1M).toBe(40);
	});

	test("returns o1 pricing", () => {
		const p = getModelPricing("o1");
		expect(p.inputPer1M).toBe(15);
		expect(p.outputPer1M).toBe(60);
	});

	test("returns o4-mini pricing", () => {
		const p = getModelPricing("o4-mini");
		expect(p.inputPer1M).toBe(1.1);
		expect(p.outputPer1M).toBe(4.4);
	});

	test("returns gpt-4-turbo pricing", () => {
		const p = getModelPricing("gpt-4-turbo");
		expect(p.inputPer1M).toBe(10);
		expect(p.outputPer1M).toBe(30);
	});

	test("returns gpt-4.1 pricing", () => {
		const p = getModelPricing("gpt-4.1");
		expect(p.inputPer1M).toBe(2.0);
		expect(p.outputPer1M).toBe(8.0);
	});

	test("returns gpt-4.1-mini pricing", () => {
		const p = getModelPricing("gpt-4.1-mini");
		expect(p.inputPer1M).toBe(0.4);
		expect(p.outputPer1M).toBe(1.6);
	});

	test("returns deepseek-chat pricing", () => {
		const p = getModelPricing("deepseek-chat");
		expect(p.inputPer1M).toBe(0.14);
	});

	test("prefix match for dated model names", () => {
		const p = getModelPricing("gpt-4o-2024-08-06");
		expect(p.inputPer1M).toBe(2.5);
	});

	test("prefix match prefers longest key (gpt-4.1-mini over gpt-4.1)", () => {
		const p = getModelPricing("gpt-4.1-mini-2025-04-14");
		expect(p.inputPer1M).toBe(0.4);
		expect(p.outputPer1M).toBe(1.6);
	});

	test("defaults to gpt-4o for unknown models", () => {
		const p = getModelPricing("some-unknown-model");
		expect(p.inputPer1M).toBe(2.5);
		expect(p.outputPer1M).toBe(10);
	});
});

// ── Context windows ──

describe("getContextWindow", () => {
	test("returns 128k for gpt-4o", () => {
		expect(getContextWindow("gpt-4o")).toBe(128_000);
	});

	test("returns 200k for o3", () => {
		expect(getContextWindow("o3")).toBe(200_000);
	});

	test("returns 200k for o1", () => {
		expect(getContextWindow("o1")).toBe(200_000);
	});

	test("returns 200k for o4-mini", () => {
		expect(getContextWindow("o4-mini")).toBe(200_000);
	});

	test("returns 128k for gpt-4-turbo", () => {
		expect(getContextWindow("gpt-4-turbo")).toBe(128_000);
	});

	test("returns 1M+ for gpt-4.1", () => {
		expect(getContextWindow("gpt-4.1")).toBe(1_047_576);
	});

	test("returns 1M+ for gpt-4.1-mini", () => {
		expect(getContextWindow("gpt-4.1-mini")).toBe(1_047_576);
	});

	test("returns 1M+ for gpt-4.1-nano", () => {
		expect(getContextWindow("gpt-4.1-nano")).toBe(1_047_576);
	});

	test("returns 64k for deepseek-chat", () => {
		expect(getContextWindow("deepseek-chat")).toBe(64_000);
	});

	test("prefix match for dated models", () => {
		expect(getContextWindow("gpt-4o-mini-2024-07-18")).toBe(128_000);
	});

	test("defaults to 128k for unknown models", () => {
		expect(getContextWindow("unknown-model")).toBe(128_000);
	});
});

// ── Tool format conversion ──

describe("convertToolsToOpenAI", () => {
	test("converts Anthropic tools to OpenAI function format", () => {
		const converted = convertToolsToOpenAI(TOOLS);
		expect(converted.length).toBe(TOOLS.length);

		// Check first tool (bash)
		const bash = converted[0];
		expect(bash?.type).toBe("function");
		expect(bash?.function.name).toBe("bash");
		expect(bash?.function.parameters).toHaveProperty("type", "object");
		expect(bash?.function.parameters).toHaveProperty("properties");
	});

	test("each tool has type 'function'", () => {
		const converted = convertToolsToOpenAI(TOOLS);
		for (const tool of converted) {
			expect(tool.type).toBe("function");
			expect(tool.function.name).toBeTruthy();
			expect(tool.function.description).toBeTruthy();
		}
	});

	test("preserves required fields from input_schema", () => {
		const converted = convertToolsToOpenAI(TOOLS);
		const bash = converted.find((t) => t.function.name === "bash");
		expect(bash?.function.parameters).toHaveProperty("required");
		const required = bash?.function.parameters.required as string[];
		expect(required).toContain("command");
	});
});

// ── Compaction ──
// In-context compaction functions (extractCheckpoint, buildCompactedContext, SUMMARIZATION_INSTRUCTION)
// are shared with the Anthropic provider and tested in anthropic-compatible-provider.test.ts.
// The OpenAI provider's runLoop integration is tested below in "runLoop integration".

// ── Constructor ──

describe("OpenAICompatibleProvider constructor", () => {
	const originalKey = process.env.OPENAI_API_KEY;

	afterAll(() => {
		if (originalKey) {
			process.env.OPENAI_API_KEY = originalKey;
		}
	});

	test("warns (does not throw) when OPENAI_API_KEY is not set", () => {
		const saved = process.env.OPENAI_API_KEY;
		delete process.env.OPENAI_API_KEY;
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(() => new OpenAICompatibleProvider()).not.toThrow();
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("no API key configured"),
			);
		} finally {
			process.env.OPENAI_API_KEY = saved;
			warnSpy.mockRestore();
		}
	});

	test("uses custom model", () => {
		const saved = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "test-key";
		try {
			const provider = new OpenAICompatibleProvider("gpt-4o-mini");
			expect(provider.name).toBe("openai");
		} finally {
			process.env.OPENAI_API_KEY = saved;
		}
	});
});

// ── Cost calculation ──

describe("cost calculation", () => {
	test("computes correct cost for gpt-4o", () => {
		const { inputPer1M, outputPer1M } = getModelPricing("gpt-4o");
		const inputTokens = 10_000;
		const outputTokens = 1_000;
		const cost =
			(inputTokens * inputPer1M) / 1_000_000 +
			(outputTokens * outputPer1M) / 1_000_000;
		// 10000 * 2.5 / 1M + 1000 * 10 / 1M = 0.025 + 0.01 = 0.035
		expect(cost).toBeCloseTo(0.035, 6);
	});

	test("cost is always positive", () => {
		for (const model of ["gpt-4o", "gpt-4o-mini", "o3", "deepseek-chat"]) {
			const { inputPer1M, outputPer1M } = getModelPricing(model);
			const cost =
				(1000 * inputPer1M) / 1_000_000 + (500 * outputPer1M) / 1_000_000;
			expect(cost).toBeGreaterThan(0);
		}
	});
});

// ── runLoop integration (mocked fetch) ──

describe("runLoop integration", () => {
	let tmpDir: string;

	beforeAll(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "openai-compatible-provider-test-"));
	});

	afterAll(async () => {
		clearContextWindowCache();
		await rm(tmpDir, { recursive: true, force: true });
	});

	test("handles a simple conversation with tool use and done()", async () => {
		const originalKey = process.env.OPENAI_API_KEY;
		const originalBase = process.env.OPENAI_BASE_URL;
		const originalFetch = globalThis.fetch;

		process.env.OPENAI_API_KEY = "test-key";
		process.env.OPENAI_BASE_URL = "http://localhost:9999";

		let chatCallCount = 0;
		globalThis.fetch = mock(async (url: string | URL | Request) => {
			const urlStr =
				typeof url === "string"
					? url
					: url instanceof URL
						? url.toString()
						: url.url;
			// GET /models for context window lookup
			if (urlStr.includes("/models") && !urlStr.includes("/chat/")) {
				return new Response(
					JSON.stringify({
						data: [{ id: "gpt-4o", context_length: 128000 }],
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			chatCallCount++;
			if (chatCallCount === 1) {
				// First chat call: assistant calls done() tool
				return new Response(
					JSON.stringify({
						id: "chatcmpl-1",
						object: "chat.completion",
						choices: [
							{
								index: 0,
								message: {
									role: "assistant",
									content: "I'll complete the task now.",
									tool_calls: [
										{
											id: "call_done",
											type: "function",
											function: {
												name: "mcp__opengraft__done",
												arguments: JSON.stringify({
													status: "passed",
													summary: "Task completed",
												}),
											},
										},
									],
								},
								finish_reason: "tool_calls",
							},
						],
						usage: {
							prompt_tokens: 500,
							completion_tokens: 100,
							total_tokens: 600,
						},
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			// Second call: model responds with stop (after done tool result)
			// This enters implicit yield; the queue will be closed by session.stop()
			return new Response(
				JSON.stringify({
					id: "chatcmpl-2",
					object: "chat.completion",
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: "Done" },
							finish_reason: "stop",
						},
					],
					usage: {
						prompt_tokens: 100,
						completion_tokens: 10,
						total_tokens: 110,
					},
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		}) as unknown as typeof fetch;

		try {
			const provider = new OpenAICompatibleProvider("gpt-4o");
			const session = provider.startSession({
				prompt: "Do something",
				cwd: tmpDir,
				systemPrompt: "You are a helpful agent.",
				mcpToolDefs: {
					opengraft: [
						{
							name: "done",
							description: "Signal completion",
							inputSchema: {
								status: {
									_zod: {
										def: { type: "string" },
										bag: { description: "passed or failed" },
									},
								},
								summary: {
									_zod: {
										def: { type: "string" },
										bag: { description: "Summary" },
									},
								},
							},
							handler: async (input: Record<string, unknown>) => {
								return {
									content: [
										{
											type: "text",
											text: `Task marked as ${input.status}. Entering idle state.`,
										},
									],
								};
							},
						},
					],
				},
			});

			const events: Array<{ type: string }> = [];

			// Consume events but stop the session when we see the idle status
			// (after done() tool is called and model responds with end_turn,
			// the loop enters yield mode — we stop it to exit cleanly)
			const consumePromise = (async () => {
				let result = await session.events.next();
				while (!result.done) {
					events.push(result.value);
					// When the agent enters idle state, stop the session to exit the loop
					if (
						result.value.type === "status" &&
						(result.value as { message: string }).message.includes("idle state")
					) {
						session.stop();
					}
					result = await session.events.next();
				}
				return result.value as AgentResult;
			})();

			const agentResult = await consumePromise;
			expect(agentResult.success).toBe(true);
			expect(agentResult.costUsd).toBeGreaterThan(0);
			expect(agentResult.turns).toBeGreaterThanOrEqual(1);

			// Verify we got the expected events
			const textEvents = events.filter((e) => e.type === "assistant_text");
			expect(textEvents.length).toBeGreaterThanOrEqual(1);

			const toolUseEvents = events.filter((e) => e.type === "tool_call");
			expect(toolUseEvents.length).toBe(1);
		} finally {
			clearContextWindowCache();
			process.env.OPENAI_API_KEY = originalKey ?? "";
			if (originalBase) {
				process.env.OPENAI_BASE_URL = originalBase;
			} else {
				delete process.env.OPENAI_BASE_URL;
			}
			globalThis.fetch = originalFetch;
		}
	});

	test("handles stop finish_reason without tool calls (no queue = exit)", async () => {
		const originalKey = process.env.OPENAI_API_KEY;
		const originalBase = process.env.OPENAI_BASE_URL;
		const originalFetch = globalThis.fetch;

		process.env.OPENAI_API_KEY = "test-key";
		process.env.OPENAI_BASE_URL = "http://localhost:9999";

		globalThis.fetch = mock(async (url: string | URL | Request) => {
			const urlStr =
				typeof url === "string"
					? url
					: url instanceof URL
						? url.toString()
						: url.url;
			if (urlStr.includes("/models") && !urlStr.includes("/chat/")) {
				return new Response(
					JSON.stringify({
						data: [{ id: "gpt-4o", context_length: 128000 }],
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			return new Response(
				JSON.stringify({
					id: "chatcmpl-1",
					object: "chat.completion",
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: "All done!" },
							finish_reason: "stop",
						},
					],
					usage: {
						prompt_tokens: 100,
						completion_tokens: 20,
						total_tokens: 120,
					},
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		}) as unknown as typeof fetch;

		try {
			// execute() doesn't pass a queue, so on end_turn the provider exits
			const provider = new OpenAICompatibleProvider("gpt-4o");
			const result = await provider.execute({
				prompt: "Say hello",
				cwd: tmpDir,
				systemPrompt: "You are helpful.",
			});
			expect(result.success).toBe(true);
			expect(result.output).toBe("All done!");
		} finally {
			clearContextWindowCache();
			process.env.OPENAI_API_KEY = originalKey ?? "";
			if (originalBase) {
				process.env.OPENAI_BASE_URL = originalBase;
			} else {
				delete process.env.OPENAI_BASE_URL;
			}
			globalThis.fetch = originalFetch;
		}
	});

	test("retries on 429 rate limit", async () => {
		const originalKey = process.env.OPENAI_API_KEY;
		const originalBase = process.env.OPENAI_BASE_URL;
		const originalFetch = globalThis.fetch;

		process.env.OPENAI_API_KEY = "test-key";
		process.env.OPENAI_BASE_URL = "http://localhost:9999";

		let chatCallCount = 0;
		globalThis.fetch = mock(async (url: string | URL | Request) => {
			const urlStr =
				typeof url === "string"
					? url
					: url instanceof URL
						? url.toString()
						: url.url;
			if (urlStr.includes("/models") && !urlStr.includes("/chat/")) {
				return new Response(
					JSON.stringify({
						data: [{ id: "gpt-4o", context_length: 128000 }],
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			chatCallCount++;
			if (chatCallCount === 1) {
				return new Response("Rate limited", { status: 429 });
			}
			return new Response(
				JSON.stringify({
					id: "chatcmpl-1",
					object: "chat.completion",
					choices: [
						{
							index: 0,
							message: {
								role: "assistant",
								content: "Success after retry",
							},
							finish_reason: "stop",
						},
					],
					usage: {
						prompt_tokens: 50,
						completion_tokens: 10,
						total_tokens: 60,
					},
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		}) as unknown as typeof fetch;

		try {
			const provider = new OpenAICompatibleProvider("gpt-4o");
			const events: Array<{ type: string; message?: string }> = [];
			const gen = provider.stream({
				prompt: "Hello",
				cwd: tmpDir,
				systemPrompt: "Be helpful",
			});
			let result = await gen.next();
			while (!result.done) {
				events.push(result.value as { type: string; message?: string });
				result = await gen.next();
			}

			expect(chatCallCount).toBe(2);
			expect(result.value.output).toBe("Success after retry");
		} finally {
			clearContextWindowCache();
			process.env.OPENAI_API_KEY = originalKey ?? "";
			if (originalBase) {
				process.env.OPENAI_BASE_URL = originalBase;
			} else {
				delete process.env.OPENAI_BASE_URL;
			}
			globalThis.fetch = originalFetch;
		}
	});
});

// ── fetchContextWindowFromAPI ──

describe("fetchContextWindowFromAPI", () => {
	afterEach(() => {
		clearContextWindowCache();
	});

	test("returns context_length from /v1/models response", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(async () => {
			return new Response(
				JSON.stringify({
					object: "list",
					data: [
						{
							id: "my-custom-model",
							object: "model",
							created: 1234567890,
							owned_by: "test",
							context_length: 96_000,
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		try {
			const result = await fetchContextWindowFromAPI(
				"https://api.example.com/v1",
				"test-key",
				"my-custom-model",
			);
			expect(result).toBe(96_000);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("returns null when model is not found in response", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(async () => {
			return new Response(
				JSON.stringify({
					object: "list",
					data: [
						{
							id: "other-model",
							object: "model",
							created: 1234567890,
							owned_by: "test",
							context_length: 64_000,
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		try {
			const result = await fetchContextWindowFromAPI(
				"https://api.example.com/v1",
				"test-key",
				"missing-model",
			);
			expect(result).toBeNull();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("caches result so second call does not fetch again", async () => {
		const originalFetch = globalThis.fetch;
		let callCount = 0;
		globalThis.fetch = mock(async () => {
			callCount++;
			return new Response(
				JSON.stringify({
					object: "list",
					data: [
						{
							id: "cached-model",
							object: "model",
							created: 1234567890,
							owned_by: "test",
							context_length: 50_000,
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		try {
			const result1 = await fetchContextWindowFromAPI(
				"https://api.example.com/v1",
				"test-key",
				"cached-model",
			);
			const result2 = await fetchContextWindowFromAPI(
				"https://api.example.com/v1",
				"test-key",
				"cached-model",
			);

			expect(result1).toBe(50_000);
			expect(result2).toBe(50_000);
			expect(callCount).toBe(1); // Only one API call despite two fetches
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

// Old CanonicalEvent recording tests removed — system deleted in Event migration.

// ── Event recording via emit callback ──

describe("Event recording via emit callback", () => {
	let tmpDir: string;

	beforeAll(async () => {
		tmpDir = await mkdtemp(
			join(tmpdir(), "openai-compatible-provider-strong-events-test-"),
		);
	});

	afterAll(async () => {
		clearContextWindowCache();
		await rm(tmpDir, { recursive: true, force: true });
	});

	test("records Events via emit callback", async () => {
		const originalKey = process.env.OPENAI_API_KEY;
		const originalBase = process.env.OPENAI_BASE_URL;
		const originalFetch = globalThis.fetch;

		process.env.OPENAI_API_KEY = "test-key";
		process.env.OPENAI_BASE_URL = "http://localhost:9999";

		let chatCallCount = 0;
		globalThis.fetch = mock(async (url: string | URL | Request) => {
			const urlStr =
				typeof url === "string"
					? url
					: url instanceof URL
						? url.toString()
						: url.url;
			if (urlStr.includes("/models") && !urlStr.includes("/chat/")) {
				return new Response(
					JSON.stringify({
						data: [{ id: "gpt-4o", context_length: 128000 }],
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			chatCallCount++;
			if (chatCallCount === 1) {
				return new Response(
					JSON.stringify({
						id: "chatcmpl-1",
						object: "chat.completion",
						choices: [
							{
								index: 0,
								message: {
									role: "assistant",
									content: "Running command.",
									tool_calls: [
										{
											id: "call_done",
											type: "function",
											function: {
												name: "mcp__opengraft__done",
												arguments: JSON.stringify({
													status: "passed",
													summary: "Task completed",
												}),
											},
										},
									],
								},
								finish_reason: "tool_calls",
							},
						],
						usage: {
							prompt_tokens: 500,
							completion_tokens: 100,
							total_tokens: 600,
						},
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			return new Response(
				JSON.stringify({
					id: "chatcmpl-2",
					object: "chat.completion",
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: "Done" },
							finish_reason: "stop",
						},
					],
					usage: {
						prompt_tokens: 100,
						completion_tokens: 10,
						total_tokens: 110,
					},
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		}) as unknown as typeof fetch;

		try {
			const emittedEvents: Event[] = [];
			const emit = (event: Event) => {
				emittedEvents.push(event);
			};
			const provider = new OpenAICompatibleProvider("gpt-4o");
			const session = provider.startSession({
				prompt: "Do something",
				cwd: tmpDir,
				systemPrompt: "You are a helpful agent.",
				emit,
				mcpToolDefs: {
					opengraft: [
						{
							name: "done",
							description: "Signal completion",
							inputSchema: {
								status: {
									_zod: {
										def: { type: "string" },
										bag: { description: "passed or failed" },
									},
								},
								summary: {
									_zod: {
										def: { type: "string" },
										bag: { description: "Summary" },
									},
								},
							},
							handler: async (input: Record<string, unknown>) => ({
								content: [
									{
										type: "text",
										text: `Task marked as ${input.status}. Entering idle state.`,
									},
								],
							}),
						},
					],
				},
			});

			const consumePromise = (async () => {
				let result = await session.events.next();
				while (!result.done) {
					if (
						result.value.type === "status" &&
						(result.value as { message: string }).message.includes("idle state")
					) {
						session.stop();
					}
					result = await session.events.next();
				}
				return result.value as AgentResult;
			})();

			const agentResult = await consumePromise;
			expect(agentResult.success).toBe(true);

			// Verify Events were recorded
			const strongEvents = emittedEvents;
			expect(strongEvents.length).toBeGreaterThanOrEqual(4);

			// Should have: user_message, assistant_text, tool_call, tool_result, assistant_text
			const types = strongEvents.map((e) => e.type);
			expect(types[0]).toBe("message");
			expect(types).toContain("assistant_text");
			expect(types).toContain("tool_call");
			expect(types).toContain("tool_result");

			// Verify user_message has cwd
			const userMsg = strongEvents[0] as {
				type: string;
				content: string;
				cwd?: string;
				ts: number;
			};
			expect(userMsg.cwd).toBe(tmpDir);
			expect(userMsg.content).toContain("Do something");
			expect(userMsg.ts).toBeGreaterThan(0);

			// Verify tool_call has correct tool name
			const toolCallEvent = strongEvents.find((e) => e.type === "tool_call");
			expect(toolCallEvent).toBeDefined();
			if (toolCallEvent?.type === "tool_call") {
				expect(toolCallEvent.tool).toBe("mcp__opengraft__done");
				expect(toolCallEvent.toolCallId).toBe("call_done");
			}

			// Verify tool_result has matching toolCallId
			const toolResultEvent = strongEvents.find(
				(e) => e.type === "tool_result",
			);
			expect(toolResultEvent).toBeDefined();
			if (toolResultEvent?.type === "tool_result") {
				expect(toolResultEvent.toolCallId).toBe("call_done");
				expect(toolResultEvent.content).toContain("Task marked as passed");
			}
		} finally {
			clearContextWindowCache();
			process.env.OPENAI_API_KEY = originalKey ?? "";
			if (originalBase) {
				process.env.OPENAI_BASE_URL = originalBase;
			} else {
				delete process.env.OPENAI_BASE_URL;
			}
			globalThis.fetch = originalFetch;
		}
	});
});

import type { Event } from "./events.ts";
import { MessageQueue } from "./message-queue.ts";
import { eventsToOpenAIMessages } from "./openai-compatible-provider.ts";
// Import AgentResult for type assertion
import type { AgentResult } from "./types.ts";

// ── Helper for OpenAI mock fetch ──

function createOpenAIModelsResponse() {
	return new Response(
		JSON.stringify({
			data: [{ id: "gpt-4o", context_length: 128000 }],
		}),
		{
			status: 200,
			headers: { "Content-Type": "application/json" },
		},
	);
}

function createOpenAIChatResponse(opts: {
	id?: string;
	content?: string | null;
	toolCalls?: Array<{
		id: string;
		name: string;
		arguments: string;
	}>;
	finishReason?: "stop" | "tool_calls";
	promptTokens?: number;
	completionTokens?: number;
}) {
	const toolCallsArr = opts.toolCalls?.map((tc) => ({
		id: tc.id,
		type: "function",
		function: {
			name: tc.name,
			arguments: tc.arguments,
		},
	}));
	return new Response(
		JSON.stringify({
			id: opts.id ?? `chatcmpl-${Math.random().toString(36).slice(2)}`,
			object: "chat.completion",
			choices: [
				{
					index: 0,
					message: {
						role: "assistant",
						content: opts.content ?? null,
						...(toolCallsArr ? { tool_calls: toolCallsArr } : {}),
					},
					finish_reason:
						opts.finishReason ?? (opts.toolCalls ? "tool_calls" : "stop"),
				},
			],
			usage: {
				prompt_tokens: opts.promptTokens ?? 100,
				completion_tokens: opts.completionTokens ?? 50,
				total_tokens:
					(opts.promptTokens ?? 100) + (opts.completionTokens ?? 50),
			},
		}),
		{
			status: 200,
			headers: { "Content-Type": "application/json" },
		},
	);
}

// ── Event deterministic verification (OpenAI) ──

describe("Event deterministic verification (OpenAI)", () => {
	let tmpDir: string;

	beforeAll(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "openai-strong-event-verify-"));
	});

	afterAll(async () => {
		clearContextWindowCache();
		await rm(tmpDir, { recursive: true, force: true });
	});

	function withMockFetch<T>(
		mockFn: typeof fetch,
		fn: () => Promise<T>,
	): Promise<T> {
		const originalKey = process.env.OPENAI_API_KEY;
		const originalBase = process.env.OPENAI_BASE_URL;
		const originalFetch = globalThis.fetch;

		process.env.OPENAI_API_KEY = "test-key";
		process.env.OPENAI_BASE_URL = "http://localhost:9999";
		globalThis.fetch = mockFn;

		return fn().finally(() => {
			clearContextWindowCache();
			process.env.OPENAI_API_KEY = originalKey ?? "";
			if (originalBase) {
				process.env.OPENAI_BASE_URL = originalBase;
			} else {
				delete process.env.OPENAI_BASE_URL;
			}
			globalThis.fetch = originalFetch;
		});
	}

	test("basic conversation: text only → stop", async () => {
		const testDir = join(tmpDir, "basic");
		const emittedEvents: Event[] = [];
		const emit = (event: Event) => {
			emittedEvents.push(event);
		};

		await withMockFetch(
			mock(async (url: string | URL | Request) => {
				const urlStr =
					typeof url === "string"
						? url
						: url instanceof URL
							? url.toString()
							: url.url;
				if (urlStr.includes("/models") && !urlStr.includes("/chat/")) {
					return createOpenAIModelsResponse();
				}
				return createOpenAIChatResponse({
					content: "Hello! How can I help?",
					finishReason: "stop",
				});
			}) as unknown as typeof fetch,
			async () => {
				const provider = new OpenAICompatibleProvider("gpt-4o");
				const result = await provider.execute({
					prompt: "Say hello",
					cwd: testDir,
					systemPrompt: "You are helpful.",
					emit,
				});

				expect(result.success).toBe(true);

				const events = emittedEvents;
				expect(events.length).toBeGreaterThanOrEqual(2);
				// Filter to persistable events (skip ephemeral status/usage events)
				const persistable = events.filter(
					(e) => !["status", "usage", "text_delta"].includes(e.type),
				);
				expect(persistable[0]?.type).toBe("message");
				expect(persistable[1]?.type).toBe("assistant_text");

				// Verify reconstruction
				const reconstructed = eventsToOpenAIMessages(persistable);
				expect(reconstructed.length).toBe(2);
				expect(reconstructed[0]).toEqual({
					role: "user",
					content: `Working directory: ${testDir}\n\nSay hello`,
				});
				expect(reconstructed[1]).toEqual({
					role: "assistant",
					content: "Hello! How can I help?",
				});
			},
		);
	});

	test("tool calls: text + tool_use → tool_result → stop", async () => {
		const testDir = join(tmpDir, "tool-calls");
		const emittedEvents: Event[] = [];
		const emit = (event: Event) => {
			emittedEvents.push(event);
		};

		let chatCallCount = 0;
		await withMockFetch(
			mock(async (url: string | URL | Request) => {
				const urlStr =
					typeof url === "string"
						? url
						: url instanceof URL
							? url.toString()
							: url.url;
				if (urlStr.includes("/models") && !urlStr.includes("/chat/")) {
					return createOpenAIModelsResponse();
				}
				chatCallCount++;
				if (chatCallCount === 1) {
					return createOpenAIChatResponse({
						content: "I'll complete the task.",
						toolCalls: [
							{
								id: "call_done",
								name: "mcp__opengraft__done",
								arguments: JSON.stringify({
									status: "passed",
									summary: "All done",
								}),
							},
						],
					});
				}
				return createOpenAIChatResponse({
					content: "Task completed.",
					finishReason: "stop",
				});
			}) as unknown as typeof fetch,
			async () => {
				const provider = new OpenAICompatibleProvider("gpt-4o");
				const session = provider.startSession({
					prompt: "Do the task",
					cwd: testDir,
					systemPrompt: "You are helpful.",
					emit,
					mcpToolDefs: {
						opengraft: [
							{
								name: "done",
								description: "Signal completion",
								inputSchema: {},
								handler: async (input: Record<string, unknown>) => ({
									content: [
										{
											type: "text",
											text: `Task marked as ${input.status}. Entering idle state.`,
										},
									],
								}),
							},
						],
					},
				});

				const consumePromise = (async () => {
					let result = await session.events.next();
					while (!result.done) {
						if (
							result.value.type === "status" &&
							(result.value as { message: string }).message.includes(
								"idle state",
							)
						) {
							session.stop();
						}
						result = await session.events.next();
					}
					return result.value as AgentResult;
				})();

				const agentResult = await consumePromise;
				expect(agentResult.success).toBe(true);

				const events = emittedEvents;
				const types = events.map((e) => e.type);
				expect(types).toContain("message");
				expect(types).toContain("assistant_text");
				expect(types).toContain("tool_call");
				expect(types).toContain("tool_result");

				// Verify tool_call details
				const toolCall = events.find((e) => e.type === "tool_call");
				if (toolCall?.type === "tool_call") {
					expect(toolCall.tool).toBe("mcp__opengraft__done");
					expect(toolCall.toolCallId).toBe("call_done");
				}

				// Verify reconstruction
				const reconstructed = eventsToOpenAIMessages(events);
				expect(reconstructed.length).toBeGreaterThanOrEqual(4);
				// First: user, second: assistant with tool_calls, third: tool result, fourth: assistant
				expect((reconstructed[0] as { role: string }).role).toBe("user");
				expect((reconstructed[1] as { role: string }).role).toBe("assistant");
				const assistantMsg = reconstructed[1] as {
					tool_calls?: unknown[];
				};
				expect(assistantMsg.tool_calls).toBeDefined();
				expect((reconstructed[2] as { role: string }).role).toBe("tool");
			},
		);
	});

	test("implicit yield: stop → queue drain → continue", async () => {
		const testDir = join(tmpDir, "implicit-yield");
		const emittedEvents: Event[] = [];
		const emit = (event: Event) => {
			emittedEvents.push(event);
		};

		let chatCallCount = 0;
		await withMockFetch(
			mock(async (url: string | URL | Request) => {
				const urlStr =
					typeof url === "string"
						? url
						: url instanceof URL
							? url.toString()
							: url.url;
				if (urlStr.includes("/models") && !urlStr.includes("/chat/")) {
					return createOpenAIModelsResponse();
				}
				chatCallCount++;
				if (chatCallCount === 1) {
					return createOpenAIChatResponse({
						content: "I'm done for now.",
						finishReason: "stop",
					});
				}
				return createOpenAIChatResponse({
					content: "Got your message.",
					finishReason: "stop",
				});
			}) as unknown as typeof fetch,
			async () => {
				const queue = new MessageQueue();
				const provider = new OpenAICompatibleProvider("gpt-4o");
				const session = provider.startSession({
					prompt: "Start working",
					cwd: testDir,
					systemPrompt: "You are helpful.",
					emit,
					queue,
				});

				let idleCount = 0;
				const consumePromise = (async () => {
					let result = await session.events.next();
					while (!result.done) {
						if (result.value.type === "agent_idle") {
							idleCount++;
							if (idleCount === 1) {
								queue.enqueue({
									source: "user",
									content: "New instruction for you",
								});
							} else {
								session.stop();
							}
						}
						result = await session.events.next();
					}
					return result.value as AgentResult;
				})();

				const agentResult = await consumePromise;
				expect(agentResult.success).toBe(true);
				expect(idleCount).toBe(2);

				const events = emittedEvents;
				const types = events.map((e) => e.type);

				// Must have user_message events (from queue)
				expect(types).toContain("message");
				const queueMsgEvent = events.find(
					(e) => e.type === "message" && e.content?.includes("New instruction"),
				);
				if (queueMsgEvent?.type === "user_message") {
					expect(queueMsgEvent.content).toContain("New instruction for you");
				}

				// Verify reconstruction — queue_message should become user message
				const reconstructed = eventsToOpenAIMessages(events);
				expect(reconstructed.length).toBeGreaterThanOrEqual(4);
			},
		);
	});

	test("error tool results: isError preserved", async () => {
		const testDir = join(tmpDir, "error-tool");
		const emittedEvents: Event[] = [];
		const emit = (event: Event) => {
			emittedEvents.push(event);
		};

		let chatCallCount = 0;
		await withMockFetch(
			mock(async (url: string | URL | Request) => {
				const urlStr =
					typeof url === "string"
						? url
						: url instanceof URL
							? url.toString()
							: url.url;
				if (urlStr.includes("/models") && !urlStr.includes("/chat/")) {
					return createOpenAIModelsResponse();
				}
				chatCallCount++;
				if (chatCallCount === 1) {
					return createOpenAIChatResponse({
						content: "Running command.",
						toolCalls: [
							{
								id: "call_err",
								name: "mcp__opengraft__done",
								arguments: JSON.stringify({
									status: "failed",
									summary: "Error",
								}),
							},
						],
					});
				}
				return createOpenAIChatResponse({
					content: "Noted.",
					finishReason: "stop",
				});
			}) as unknown as typeof fetch,
			async () => {
				const provider = new OpenAICompatibleProvider("gpt-4o");
				const session = provider.startSession({
					prompt: "Try something",
					cwd: testDir,
					systemPrompt: "You are helpful.",
					emit,
					mcpToolDefs: {
						opengraft: [
							{
								name: "done",
								description: "Signal completion",
								inputSchema: {},
								handler: async () => ({
									isError: true,
									content: [
										{
											type: "text",
											text: "Error: command failed",
										},
									],
								}),
							},
						],
					},
				});

				const consumePromise = (async () => {
					let result = await session.events.next();
					while (!result.done) {
						if (
							result.value.type === "status" &&
							(result.value as { message: string }).message.includes(
								"idle state",
							)
						) {
							session.stop();
						}
						result = await session.events.next();
					}
					return result.value as AgentResult;
				})();

				const agentResult = await consumePromise;
				expect(agentResult.success).toBe(true);

				const events = emittedEvents;
				const toolResult = events.find((e) => e.type === "tool_result");
				expect(toolResult).toBeDefined();
				if (toolResult?.type === "tool_result") {
					expect(toolResult.isError).toBe(true);
					expect(toolResult.content).toContain("Error: command failed");
				}
			},
		);
	});

	test("multiple parallel tool calls: 3 tool_use → 3 tool_results", async () => {
		const testDir = join(tmpDir, "parallel-tools");
		const emittedEvents: Event[] = [];
		const emit = (event: Event) => {
			emittedEvents.push(event);
		};

		let chatCallCount = 0;
		await withMockFetch(
			mock(async (url: string | URL | Request) => {
				const urlStr =
					typeof url === "string"
						? url
						: url instanceof URL
							? url.toString()
							: url.url;
				if (urlStr.includes("/models") && !urlStr.includes("/chat/")) {
					return createOpenAIModelsResponse();
				}
				chatCallCount++;
				if (chatCallCount === 1) {
					return createOpenAIChatResponse({
						content: "Running three tools.",
						toolCalls: [
							{
								id: "call_a",
								name: "mcp__test__tool_a",
								arguments: JSON.stringify({ param: "a" }),
							},
							{
								id: "call_b",
								name: "mcp__test__tool_b",
								arguments: JSON.stringify({ param: "b" }),
							},
							{
								id: "call_c",
								name: "mcp__test__tool_c",
								arguments: JSON.stringify({ param: "c" }),
							},
						],
					});
				}
				return createOpenAIChatResponse({
					content: "All tools done.",
					finishReason: "stop",
				});
			}) as unknown as typeof fetch,
			async () => {
				const provider = new OpenAICompatibleProvider("gpt-4o");
				const session = provider.startSession({
					prompt: "Run three tools",
					cwd: testDir,
					systemPrompt: "You are helpful.",
					emit,
					mcpToolDefs: {
						test: [
							{
								name: "tool_a",
								description: "Tool A",
								inputSchema: {},
								handler: async () => ({
									content: [{ type: "text", text: "Result A" }],
								}),
							},
							{
								name: "tool_b",
								description: "Tool B",
								inputSchema: {},
								handler: async () => ({
									content: [{ type: "text", text: "Result B" }],
								}),
							},
							{
								name: "tool_c",
								description: "Tool C",
								inputSchema: {},
								handler: async () => ({
									content: [{ type: "text", text: "Result C" }],
								}),
							},
						],
					},
				});

				const consumePromise = (async () => {
					let result = await session.events.next();
					while (!result.done) {
						if (
							result.value.type === "status" &&
							(result.value as { message: string }).message.includes(
								"idle state",
							)
						) {
							session.stop();
						}
						result = await session.events.next();
					}
					return result.value as AgentResult;
				})();

				const agentResult = await consumePromise;
				expect(agentResult.success).toBe(true);

				const events = emittedEvents;
				const toolCalls = events.filter((e) => e.type === "tool_call");
				const toolResults = events.filter((e) => e.type === "tool_result");

				expect(toolCalls.length).toBe(3);
				expect(toolResults.length).toBe(3);

				// Verify reconstruction
				const reconstructed = eventsToOpenAIMessages(events);
				// user, assistant(with 3 tool_calls), 3 tool results, assistant
				expect(reconstructed.length).toBeGreaterThanOrEqual(6);

				// Assistant should have 3 tool_calls
				const assistantMsg = reconstructed[1] as {
					tool_calls?: unknown[];
				};
				expect(assistantMsg.tool_calls?.length).toBe(3);

				// 3 individual tool messages
				const toolMsgs = reconstructed.filter(
					(m) => (m as { role: string }).role === "tool",
				);
				expect(toolMsgs.length).toBe(3);
			},
		);
	});
});
