import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOLS } from "./anthropic-compatible-provider.ts";
import {
	clearContextWindowCache,
	compressMessages,
	convertToolsToOpenAI,
	fetchContextWindowFromAPI,
	getContextWindow,
	getModelPricing,
	OpenAICompatibleProvider,
	type OpenAIMessage,
} from "./openai-compatible-provider.ts";

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

	test("returns deepseek-chat pricing", () => {
		const p = getModelPricing("deepseek-chat");
		expect(p.inputPer1M).toBe(0.14);
	});

	test("prefix match for dated model names", () => {
		const p = getModelPricing("gpt-4o-2024-08-06");
		expect(p.inputPer1M).toBe(2.5);
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

describe("compressMessages", () => {
	test("returns unchanged for < 4 messages", async () => {
		const msgs: OpenAIMessage[] = [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi" },
		];
		const result = await compressMessages(
			msgs,
			"gpt-4o",
			"https://api.openai.com/v1",
			"fake-key",
		);
		expect(result.compressed).toEqual(msgs);
		expect(result.savedTokens).toBe(0);
		expect(result.checkpoint).toBe("");
	});

	test("calls OpenAI API and compresses messages", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(async () => {
			return new Response(
				JSON.stringify({
					id: "chatcmpl-123",
					object: "chat.completion",
					choices: [
						{
							index: 0,
							message: {
								role: "assistant",
								content:
									"## Current Phase\nimplementation\n\n## Completed Work\nDid stuff",
							},
							finish_reason: "stop",
						},
					],
					usage: {
						prompt_tokens: 100,
						completion_tokens: 50,
						total_tokens: 150,
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		try {
			const msgs: OpenAIMessage[] = [
				{ role: "user", content: "Do task A" },
				{ role: "assistant", content: "OK, doing A" },
				{ role: "user", content: "Now B" },
				{ role: "assistant", content: "OK, doing B" },
				{ role: "user", content: "Now C" },
			];
			const result = await compressMessages(
				msgs,
				"gpt-4o",
				"https://api.openai.com/v1",
				"test-key",
				"Original task description",
			);

			expect(result.checkpoint).toContain("Current Phase");
			expect(result.compressed.length).toBe(1);
			expect(result.compressed[0]?.role).toBe("user");
			expect(result.compressed[0]?.content).toContain("Original Task");
			expect(result.compressed[0]?.content).toContain("Checkpoint Summary");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("throws on API error", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(async () => {
			return new Response("Internal Server Error", { status: 500 });
		}) as unknown as typeof fetch;

		try {
			const msgs: OpenAIMessage[] = [
				{ role: "user", content: "a" },
				{ role: "assistant", content: "b" },
				{ role: "user", content: "c" },
				{ role: "assistant", content: "d" },
				{ role: "user", content: "e" },
			];
			await expect(
				compressMessages(msgs, "gpt-4o", "http://localhost", "key"),
			).rejects.toThrow("Compaction API error");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("serializes tool_calls in transcript", async () => {
		const originalFetch = globalThis.fetch;
		let capturedBody = "";
		globalThis.fetch = mock(
			async (_url: string | URL | Request, init?: RequestInit) => {
				capturedBody = (init?.body as string) ?? "";
				return new Response(
					JSON.stringify({
						id: "chatcmpl-123",
						object: "chat.completion",
						choices: [
							{
								index: 0,
								message: { role: "assistant", content: "checkpoint" },
								finish_reason: "stop",
							},
						],
						usage: {
							prompt_tokens: 10,
							completion_tokens: 5,
							total_tokens: 15,
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			},
		) as unknown as typeof fetch;

		try {
			const msgs: OpenAIMessage[] = [
				{ role: "user", content: "hello" },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call_1",
							type: "function",
							function: { name: "bash", arguments: '{"command":"ls"}' },
						},
					],
				},
				{
					role: "tool",
					tool_call_id: "call_1",
					name: "bash",
					content: "file1.txt",
				},
				{ role: "assistant", content: "Found file1.txt" },
				{ role: "user", content: "thanks" },
			];
			await compressMessages(msgs, "gpt-4o", "http://localhost", "key");

			// Verify the transcript contains the tool call info
			const parsed = JSON.parse(capturedBody);
			const userContent = parsed.messages[1].content;
			expect(userContent).toContain("tool_call: bash");
			expect(userContent).toContain("tool_result for bash");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

// ── Constructor ──

describe("OpenAICompatibleProvider constructor", () => {
	const originalKey = process.env.OPENAI_API_KEY;

	afterAll(() => {
		if (originalKey) {
			process.env.OPENAI_API_KEY = originalKey;
		}
	});

	test("throws when OPENAI_API_KEY is not set", () => {
		const saved = process.env.OPENAI_API_KEY;
		delete process.env.OPENAI_API_KEY;
		try {
			expect(() => new OpenAICompatibleProvider()).toThrow("OPENAI_API_KEY");
		} finally {
			process.env.OPENAI_API_KEY = saved;
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
			// Shouldn't reach here but return a stop response just in case
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
			const doneRef: {
				done: null | { status: "passed" | "failed"; summary: string };
			} = {
				done: null,
			};

			const provider = new OpenAICompatibleProvider("gpt-4o");
			const session = provider.startSession({
				prompt: "Do something",
				cwd: tmpDir,
				systemPrompt: "You are a helpful agent.",
				sessionsDir: join(tmpDir, "sessions"),
				doneRef,
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
								doneRef.done = {
									status: input.status as "passed" | "failed",
									summary: input.summary as string,
								};
								return {
									content: [{ type: "text", text: "Done signal received" }],
								};
							},
						},
					],
				},
			});

			const events: Array<{ type: string }> = [];
			let result = await session.events.next();
			while (!result.done) {
				events.push(result.value);
				result = await session.events.next();
			}

			const agentResult = result.value as AgentResult;
			expect(agentResult.success).toBe(true);
			expect(agentResult.output).toBe("Task completed");
			expect(agentResult.costUsd).toBeGreaterThan(0);
			expect(agentResult.turns).toBe(1);

			// Verify we got the expected events
			const textEvents = events.filter((e) => e.type === "text");
			expect(textEvents.length).toBeGreaterThanOrEqual(1);

			const toolUseEvents = events.filter((e) => e.type === "tool_use");
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

	test("handles stop finish_reason without tool calls", async () => {
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

// Import AgentResult for type assertion
import type { AgentResult } from "./types.ts";
