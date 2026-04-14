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
import { z } from "zod";
import { MessageQueue } from "./message-queue.ts";
import {
	clearContextWindowCache,
	fetchContextWindowFromAPI,
	getContextWindow,
	getModelPricing,
	OpenAICompatibleProvider,
} from "./openai-compatible-provider.ts";
import { tool } from "./tool-definition.ts";
import type { EventSpec } from "./events.ts";

/** Create a MessageQueue pre-loaded with a user message (for tests). */
function queueWithPrompt(content: string, cwd?: string): MessageQueue {
	const q = new MessageQueue();
	const header = cwd ? `Working directory: ${cwd}` : undefined;
	q.enqueue({
		source: "user",
		id: "test-prompt",
		ts: 0,
		content,
		...(header ? { header } : {}),
	});
	return q;
}

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
				expect.stringContaining("no OpenAI credential configured"),
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

	test("accepts access token via constructor apiKey slot", () => {
		const saved = process.env.OPENAI_API_KEY;
		delete process.env.OPENAI_API_KEY;
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(
				() =>
					new OpenAICompatibleProvider("gpt-4o-mini", {
						apiKey: "eyJhbGciOiJIUzI1NiJ9.payload.sig",
					}),
			).not.toThrow();
			expect(warnSpy).not.toHaveBeenCalled();
		} finally {
			process.env.OPENAI_API_KEY = saved;
			warnSpy.mockRestore();
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
												name: "mcp__mxd__done",
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
			const testQueue = queueWithPrompt("Do something", tmpDir);
			const session = provider.stream({
				buildSystemPrompt: () => ({ stable: "You are a helpful agent.", variable: "" }),
			buildWorkContext: () => null,
			buildSummarizationPrompt: () => "Summarize the conversation.",
				queue: testQueue,
				mcpToolDefs: {
					mxd: [
						tool(
							"done",
							"Signal completion",
							{
								status: z.string().describe("passed or failed"),
								summary: z.string().describe("Summary"),
							},
							async (input) => ({
								content: [
									{
										type: "text",
										text: `Task marked as ${input.status}. Entering idle state.`,
									},
								],
							}),
						),
					],
				},
			});

			const events: EventSpec[] = [];

			// Consume events but stop the session when we see the idle status
			// (after done() tool is called and model responds with end_turn,
			// the loop enters yield mode — we stop it to exit cleanly)
			const consumePromise = (async () => {
				let result = await session.next();
				while (!result.done) {
					events.push(result.value);
					// When the agent enters idle state, stop the session to exit the loop
					if (
						result.value.type === "status" &&
						(result.value as { message: string }).message.includes("idle state")
					) {
						testQueue.close();
					}
					result = await session.next();
				}
				return result.value as AgentResult;
			})();

			const agentResult = await consumePromise;
			expect(agentResult.exitReason).not.toBe("done_failed");
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
				buildSystemPrompt: () => ({ stable: "You are helpful.", variable: "" }),
			buildWorkContext: () => null,
			buildSummarizationPrompt: () => "Summarize the conversation.",
				queue: queueWithPrompt("Say hello", tmpDir),
			});
			expect(result.exitReason).not.toBe("done_failed");
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

	test("serializes optional booleans and strings in tool schema for chat completions", async () => {
		const originalKey = process.env.OPENAI_API_KEY;
		const originalBase = process.env.OPENAI_BASE_URL;
		const originalFetch = globalThis.fetch;

		process.env.OPENAI_API_KEY = "test-key";
		process.env.OPENAI_BASE_URL = "http://localhost:9999";

		const requestBodies: Array<Record<string, unknown>> = [];
		globalThis.fetch = mock(
			async (url: string | URL | Request, init?: RequestInit) => {
				const urlStr =
					typeof url === "string"
						? url
						: url instanceof URL
							? url.toString()
							: url.url;
				if (urlStr.includes("/models") && !urlStr.includes("/chat/")) {
					return createOpenAIModelsResponse();
				}
				requestBodies.push(JSON.parse(String(init?.body ?? "{}")));
				return createOpenAIChatResponse({
					content: "All done!",
					finishReason: "stop",
				});
			},
		) as unknown as typeof fetch;

		try {
			const provider = new OpenAICompatibleProvider("gpt-4o");
			await provider.execute({
				buildSystemPrompt: () => ({ stable: "You are helpful.", variable: "" }),
			buildWorkContext: () => null,
			buildSummarizationPrompt: () => "Summarize the conversation.",
				queue: queueWithPrompt("Say hello", tmpDir),
				mcpToolDefs: {
					mxd: [
						tool(
							"update_task",
							"Update task",
							{
								taskId: z.string(),
								draft: z.boolean().optional(),
								old_description: z.string().optional(),
								new_description: z.string().optional(),
								parentId: z.string().optional(),
							},
							async () => ({
								content: [{ type: "text", text: "ok" }],
							}),
						),
					],
				},
			});

			expect(requestBodies).toHaveLength(1);
			expect(requestBodies[0]?.tools).toEqual([
				{
					type: "function",
					function: {
						name: "mcp__mxd__update_task",
						description: "Update task",
						parameters: {
							type: "object",
							properties: {
								taskId: { type: "string" },
								draft: { type: "boolean" },
								old_description: { type: "string" },
								new_description: { type: "string" },
								parentId: { type: "string" },
							},
							required: ["taskId"],
						},
					},
				},
			]);
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
			// Queue auto-closes after drain so stream() exits on end_turn
			const retryQueue = queueWithPrompt("Hello", tmpDir);
			retryQueue.onDrain = () => {
				retryQueue.onDrain = undefined;
				retryQueue.close();
			};
			const gen = provider.stream({
				buildSystemPrompt: () => ({ stable: "Be helpful", variable: "" }),
			buildWorkContext: () => null,
			buildSummarizationPrompt: () => "Summarize the conversation.",
				queue: retryQueue,
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
												name: "mcp__mxd__done",
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
			const emittedEvents: EventSpec[] = [];
			const emit = (event: EventSpec) => {
				emittedEvents.push(event);
			};
			const provider = new OpenAICompatibleProvider("gpt-4o");
			const testQueue = queueWithPrompt("Do something", tmpDir);
			const session = provider.stream({
				buildSystemPrompt: () => ({ stable: "You are a helpful agent.", variable: "" }),
			buildWorkContext: () => null,
			buildSummarizationPrompt: () => "Summarize the conversation.",
				emit,
				queue: testQueue,
				mcpToolDefs: {
					mxd: [
						tool(
							"done",
							"Signal completion",
							{
								status: z.string().describe("passed or failed"),
								summary: z.string().describe("Summary"),
							},
							async () => ({
								content: [
									{
										type: "text",
										text: "Done acknowledged.",
									},
								],
							}),
						),
					],
				},
			});

			// Consume all events — done() exits loop immediately (no queue close needed)
			let result = await session.next();
			while (!result.done) {
				result = await session.next();
			}
			const agentResult = result.value as AgentResult;

			expect(agentResult.exitReason).toBe("done_passed");
			expect(agentResult.doneSummary).toBe("Task completed");

			// Verify Events were recorded
			const strongEvents = emittedEvents;
			expect(strongEvents.length).toBeGreaterThanOrEqual(3);

			// Should have: messages_consumed (from queue drain), assistant_text, tool_call
			// NO tool_result — done() is an intended orphan
			const types = strongEvents.map((e) => e.type);
			expect(types).toContain("messages_consumed");
			expect(types).toContain("assistant_text");
			expect(types).toContain("tool_call");
			expect(types).not.toContain("tool_result");

			// Verify tool_call has correct tool name
			const toolCallEvent = strongEvents.find((e) => e.type === "tool_call");
			expect(toolCallEvent).toBeDefined();
			if (toolCallEvent?.type === "tool_call") {
				expect(toolCallEvent.tool).toBe("mcp__mxd__done");
				expect(toolCallEvent.toolCallId).toBe("call_done");
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
		const emittedEvents: EventSpec[] = [];
		const emit = (event: EventSpec) => {
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
					buildSystemPrompt: () => ({ stable: "You are helpful.", variable: "" }),
			buildWorkContext: () => null,
			buildSummarizationPrompt: () => "Summarize the conversation.",
					emit,
					queue: queueWithPrompt("Say hello", testDir),
				});

				expect(result.exitReason).not.toBe("done_failed");

				const events = emittedEvents;
				expect(events.length).toBeGreaterThanOrEqual(2);
				// Filter to persistable events (skip ephemeral status/usage events)
				const persistable = events.filter(
					(e) => !["status", "usage", "text_delta"].includes(e.type as string),
				);
				// First persistable should be messages_consumed (from queue drain), then assistant_text
				expect(persistable).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ type: "messages_consumed" }),
						expect.objectContaining({ type: "assistant_text" }),
					]),
				);

				// Verify reconstruction — prepend user message event (in production, already in JSONL)
				const userMsgEvent: Event = {
					type: "message",
					id: "test-prompt",
					taskId: "",
					body: {
						source: "user",
						id: "test-prompt",
						ts: 0,
						content: "Say hello",
					},
					ts: Date.now(),
				};
				const allEvents = [userMsgEvent, ...persistable];
				const reconstructed = eventsToOpenAIMessages(allEvents as Event[]);
				expect(reconstructed.length).toBeGreaterThanOrEqual(2);
				// First message should contain the content from queue drain
				const firstMsg = reconstructed[0] as {
					role: string;
					content: string;
				};
				expect(firstMsg?.role).toBe("user");
				expect(reconstructed[1]).toEqual({
					role: "assistant",
					content: "Hello! How can I help?",
				});
			},
		);
	});

	test("tool calls: text + tool_use → tool_result → stop", async () => {
		const testDir = join(tmpDir, "tool-calls");
		const emittedEvents: EventSpec[] = [];
		const emit = (event: EventSpec) => {
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
				// done() is an orphan — only 1 API call, loop exits immediately
				return createOpenAIChatResponse({
					content: "I'll complete the task.",
					toolCalls: [
						{
							id: "call_done",
							name: "mcp__mxd__done",
							arguments: JSON.stringify({
								status: "passed",
								summary: "All done",
							}),
						},
					],
				});
			}) as unknown as typeof fetch,
			async () => {
				const provider = new OpenAICompatibleProvider("gpt-4o");
				const testQueue = queueWithPrompt("Do the task", testDir);
				const session = provider.stream({
					buildSystemPrompt: () => ({ stable: "You are helpful.", variable: "" }),
			buildWorkContext: () => null,
			buildSummarizationPrompt: () => "Summarize the conversation.",
					emit,
					queue: testQueue,
					mcpToolDefs: {
						mxd: [
							tool(
								"done",
								"Signal completion",
								{
									status: z.string(),
									summary: z.string().optional(),
								},
								async () => ({
									content: [
										{
											type: "text",
											text: "Done acknowledged.",
										},
									],
								}),
							),
						],
					},
				});

				// Consume all events — loop exits on done
				let result = await session.next();
				while (!result.done) {
					result = await session.next();
				}
				const agentResult = result.value as AgentResult;

				expect(agentResult.exitReason).toBe("done_passed");
				expect(agentResult.doneSummary).toBe("All done");

				const types = emittedEvents.map((e) => e.type);
				expect(types).toContain("assistant_text");
				expect(types).toContain("tool_call");
				// done() is an intended orphan — no tool_result emitted
				expect(types).not.toContain("tool_result");

				// Verify tool_call details
				const toolCall = emittedEvents.find((e) => e.type === "tool_call");
				if (toolCall?.type === "tool_call") {
					expect(toolCall.tool).toBe("mcp__mxd__done");
					expect(toolCall.toolCallId).toBe("call_done");
				}
			},
		);
	});

	test("implicit yield: stop → queue drain → continue", async () => {
		const testDir = join(tmpDir, "implicit-yield");
		const emittedEvents: EventSpec[] = [];
		// Detect idle state via emit callback — handleImplicitYield emits agent_idle
		// synchronously before queue.wait(), so enqueuing here resolves the wait immediately.
		let idleCount = 0;
		let session: ReturnType<OpenAICompatibleProvider["stream"]>;
		const emit = (event: EventSpec) => {
			emittedEvents.push(event);
			if (event.type === "agent_idle") {
				idleCount++;
				if (idleCount === 1) {
					queue.enqueue({
						source: "user",
						id: "test-id",
						ts: 0,
						content: "New instruction for you",
					});
				} else {
					queue.close();
				}
			}
		};

		let chatCallCount = 0;
		let queue: MessageQueue;
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
				queue = queueWithPrompt("Start working", testDir);
				const provider = new OpenAICompatibleProvider("gpt-4o");
				session = provider.stream({
					buildSystemPrompt: () => ({ stable: "You are helpful.", variable: "" }),
			buildWorkContext: () => null,
			buildSummarizationPrompt: () => "Summarize the conversation.",
					emit,
					queue,
				});

				// Drive the generator to completion — idle detection is in emit callback
				const consumePromise = (async () => {
					let result = await session.next();
					while (!result.done) {
						result = await session.next();
					}
					return result.value as AgentResult;
				})();

				const agentResult = await consumePromise;
				expect(agentResult.exitReason).not.toBe("done_failed");
				expect(idleCount).toBe(2);

				// Provider emits messages_consumed but not message events for user messages
				// Prepend user message events for reconstruction
				const userMsg1: Event = {
					type: "message",
					id: "test-prompt",
					taskId: "",
					body: {
						source: "user",
						id: "test-prompt",
						ts: 0,
						content: "Start working",
					},
					ts: Date.now(),
				};
				const userMsg2: Event = {
					type: "message",
					id: "test-id",
					taskId: "",
					body: {
						source: "user",
						id: "test-id",
						ts: 0,
						content: "New instruction for you",
					},
					ts: Date.now(),
				};
				const events = [userMsg1, ...emittedEvents];
				// Insert second user message before its consumption
				const consumedIndices = events.reduce<number[]>((acc, e, i) => {
					if (e.type === "messages_consumed") acc.push(i);
					return acc;
				}, []);
				const secondIdx = consumedIndices[1];
				if (secondIdx !== undefined) {
					events.splice(secondIdx, 0, userMsg2);
				}

				// Verify reconstruction — queue message should become user message
				const reconstructed = eventsToOpenAIMessages(events as Event[]);
				expect(reconstructed.length).toBeGreaterThanOrEqual(4);
			},
		);
	});

	test("error tool results: isError preserved", async () => {
		const testDir = join(tmpDir, "error-tool");
		const emittedEvents: EventSpec[] = [];
		const emit = (event: EventSpec) => {
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
								name: "mcp__mxd__done",
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
				const testQueue = queueWithPrompt("Try something", testDir);
				const session = provider.stream({
					buildSystemPrompt: () => ({ stable: "You are helpful.", variable: "" }),
			buildWorkContext: () => null,
			buildSummarizationPrompt: () => "Summarize the conversation.",
					emit,
					queue: testQueue,
					mcpToolDefs: {
						mxd: [
							tool("done", "Signal completion", {}, async () => ({
								isError: true,
								content: [
									{
										type: "text",
										text: "Error: command failed",
									},
								],
							})),
						],
					},
				});

				const consumePromise = (async () => {
					let result = await session.next();
					while (!result.done) {
						if (
							result.value.type === "status" &&
							(result.value as { message: string }).message.includes(
								"idle state",
							)
						) {
							testQueue.close();
						}
						result = await session.next();
					}
					return result.value as AgentResult;
				})();

				const agentResult = await consumePromise;
				expect(agentResult.exitReason).not.toBe("done_failed");

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
		const emittedEvents: EventSpec[] = [];
		const emit = (event: EventSpec) => {
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
				const testQueue = queueWithPrompt("Run three tools", testDir);
				const session = provider.stream({
					buildSystemPrompt: () => ({ stable: "You are helpful.", variable: "" }),
			buildWorkContext: () => null,
			buildSummarizationPrompt: () => "Summarize the conversation.",
					emit,
					queue: testQueue,
					mcpToolDefs: {
						test: [
							tool("tool_a", "Tool A", {}, async () => ({
								content: [{ type: "text", text: "Result A" }],
							})),
							tool("tool_b", "Tool B", {}, async () => ({
								content: [{ type: "text", text: "Result B" }],
							})),
							tool("tool_c", "Tool C", {}, async () => ({
								content: [{ type: "text", text: "Result C" }],
							})),
						],
					},
				});

				const consumePromise = (async () => {
					let result = await session.next();
					while (!result.done) {
						if (
							result.value.type === "status" &&
							(result.value as { message: string }).message.includes(
								"idle state",
							)
						) {
							testQueue.close();
						}
						result = await session.next();
					}
					return result.value as AgentResult;
				})();

				const agentResult = await consumePromise;
				expect(agentResult.exitReason).not.toBe("done_failed");

				const events = emittedEvents;
				const toolCalls = events.filter((e) => e.type === "tool_call");
				const toolResults = events.filter((e) => e.type === "tool_result");

				expect(toolCalls.length).toBe(3);
				expect(toolResults.length).toBe(3);

				// Verify reconstruction — prepend user message event
				const userMsgEvent: Event = {
					type: "message",
					id: "test-prompt",
					taskId: "",
					body: {
						source: "user",
						id: "test-prompt",
						ts: 0,
						content: "Run three tools",
					},
					ts: Date.now(),
				};
				const allEvents = [userMsgEvent, ...events];
				const reconstructed = eventsToOpenAIMessages(allEvents as Event[]);
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
