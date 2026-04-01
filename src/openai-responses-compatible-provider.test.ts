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
import type { Event } from "./events.ts";
import { MessageQueue } from "./message-queue.ts";
import {
	clearContextWindowCache,
	eventsToOpenAIResponsesMessages,
	fetchContextWindowFromAPI,
	getContextWindow,
	getModelPricing,
	OpenAIResponsesCompatibleProvider,
	streamResponsesAPI,
} from "./openai-responses-compatible-provider.ts";
import { tool } from "./tool-definition.ts";

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

function sseResponse(
	events: Array<{ event: string; data: unknown }>,
): Response {
	const body = events
		.map(
			({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
		)
		.join("");
	return new Response(body, {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
	});
}

describe("OpenAIResponsesCompatibleProvider constructor", () => {
	const originalKey = process.env.OPENAI_API_KEY;

	afterAll(() => {
		if (originalKey) {
			process.env.OPENAI_API_KEY = originalKey;
		} else {
			delete process.env.OPENAI_API_KEY;
		}
	});

	test("warns when no credential is configured", () => {
		const saved = process.env.OPENAI_API_KEY;
		delete process.env.OPENAI_API_KEY;
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(() => new OpenAIResponsesCompatibleProvider()).not.toThrow();
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("no OpenAI credential configured"),
			);
		} finally {
			process.env.OPENAI_API_KEY = saved;
			warnSpy.mockRestore();
		}
	});

	test("accepts access token via constructor apiKey slot", () => {
		const saved = process.env.OPENAI_API_KEY;
		delete process.env.OPENAI_API_KEY;
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(
				() =>
					new OpenAIResponsesCompatibleProvider("gpt-4.1-mini", {
						apiKey: "eyJhbGciOiJIUzI1NiJ9.payload.sig",
					}),
			).not.toThrow();
			expect(warnSpy).not.toHaveBeenCalled();
		} finally {
			process.env.OPENAI_API_KEY = saved;
			warnSpy.mockRestore();
		}
	});

	test("uses accessToken when apiKey is absent", async () => {
		let authHeader: string | undefined;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(
			async (_url: string | URL | Request, init?: RequestInit) => {
				authHeader =
					new Headers(init?.headers).get("authorization") ?? undefined;
				return sseResponse([
					{
						event: "response.created",
						data: { response: { id: "resp-1", status: "in_progress" } },
					},
					{
						event: "response.output_item.added",
						data: {
							output_index: 0,
							item: {
								type: "function_call",
								call_id: "call-done",
								name: "mcp__mxd__done",
								arguments: JSON.stringify({ status: "passed", summary: "ok" }),
							},
						},
					},
					{
						event: "response.function_call_arguments.done",
						data: {
							output_index: 0,
							name: "mcp__mxd__done",
							arguments: JSON.stringify({ status: "passed", summary: "ok" }),
						},
					},
					{
						event: "response.completed",
						data: {
							response: {
								id: "resp-1",
								status: "completed",
								usage: { input_tokens: 3, output_tokens: 2 },
							},
						},
					},
				]);
			},
		) as unknown as typeof fetch;

		try {
			const provider = new OpenAIResponsesCompatibleProvider("gpt-4.1-mini", {
				accessToken: "access-token-123",
			});
			const result = await provider.execute({
				cwd: process.cwd(),
				systemPrompt: { stable: "stable", variable: "variable" },
				queue: queueWithPrompt("Do the thing"),
				mcpToolDefs: {
					mxd: [
						tool("done", "Signal completion", {}, async () => ({
							content: [{ type: "text", text: "done ok" }],
						})),
					],
				},
			});
			expect(authHeader).toBe("Bearer access-token-123");
			expect(result.exitReason).toBe("done_passed");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("Responses pricing and context windows", () => {
	test("returns exact pricing for gpt-5.4-mini", () => {
		const p = getModelPricing("gpt-5.4-mini");
		expect(p.inputPer1M).toBe(0.25);
		expect(p.outputPer1M).toBe(2);
	});

	test("prefix match prefers longest pricing key", () => {
		const p = getModelPricing("gpt-5.4-mini-2026-02-01");
		expect(p.inputPer1M).toBe(0.25);
		expect(p.outputPer1M).toBe(2);
	});

	test("returns context window for gpt-5.4", () => {
		expect(getContextWindow("gpt-5.4")).toBe(1_050_000);
	});

	test("prefix match prefers longest context window key", () => {
		expect(getContextWindow("gpt-5.4-mini-preview")).toBe(400_000);
	});
});

describe("fetchContextWindowFromAPI", () => {
	afterEach(() => {
		clearContextWindowCache();
	});

	test("skips /models lookup when base URL already points at /responses", async () => {
		const originalFetch = globalThis.fetch;
		const fetchSpy = mock(async () => {
			throw new Error("should not fetch");
		});
		globalThis.fetch = fetchSpy as unknown as typeof fetch;
		try {
			const window = await fetchContextWindowFromAPI(
				"https://api.example.com/v1/responses",
				"token",
				"gpt-4o",
			);
			expect(window).toBeNull();
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("caches successful /models lookups by requested model", async () => {
		const originalFetch = globalThis.fetch;
		const fetchSpy = mock(
			async () =>
				new Response(
					JSON.stringify({
						data: [{ id: "gpt-4o", context_length: 131072 }],
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
		);
		globalThis.fetch = fetchSpy as unknown as typeof fetch;
		try {
			const first = await fetchContextWindowFromAPI(
				"https://api.example.com/v1",
				"token",
				"gpt-4o",
			);
			const second = await fetchContextWindowFromAPI(
				"https://api.example.com/v1",
				"token",
				"gpt-4o",
			);
			expect(first).toBe(131072);
			expect(second).toBe(131072);
			expect(fetchSpy).toHaveBeenCalledTimes(1);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("prefix match: requested model is base name, API returns versioned", async () => {
		const originalFetch = globalThis.fetch;
		const fetchSpy = mock(
			async () =>
				new Response(
					JSON.stringify({
						data: [{ id: "gpt-4o-2024-08-06", context_length: 131072 }],
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
		);
		globalThis.fetch = fetchSpy as unknown as typeof fetch;
		try {
			const result = await fetchContextWindowFromAPI(
				"https://api.example.com/v1",
				"token",
				"gpt-4o",
			);
			expect(result).toBe(131072);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("prefix match: requested model is versioned, API returns base", async () => {
		const originalFetch = globalThis.fetch;
		const fetchSpy = mock(
			async () =>
				new Response(
					JSON.stringify({
						data: [{ id: "gpt-4o", context_length: 131072 }],
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
		);
		globalThis.fetch = fetchSpy as unknown as typeof fetch;
		try {
			const result = await fetchContextWindowFromAPI(
				"https://api.example.com/v1",
				"token",
				"gpt-4o-2024-08-06",
			);
			expect(result).toBe(131072);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("prefix match: no match returns null", async () => {
		const originalFetch = globalThis.fetch;
		const fetchSpy = mock(
			async () =>
				new Response(
					JSON.stringify({
						data: [{ id: "gpt-4o", context_length: 131072 }],
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
		);
		globalThis.fetch = fetchSpy as unknown as typeof fetch;
		try {
			const result = await fetchContextWindowFromAPI(
				"https://api.example.com/v1",
				"token",
				"claude-3",
			);
			expect(result).toBeNull();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("eventsToOpenAIResponsesMessages", () => {
	test("converts assistant tool calls, tool results, consumed queue text, and images", () => {
		const events: Event[] = [
			{
				type: "message",
				id: "msg-1",
				taskId: "task-1",
				ts: 1,
				body: {
					source: "user",
					id: "user-1",
					ts: 1,
					content: "Original prompt",
					header: "Working directory: /repo",
				},
			},
			{
				type: "assistant_text",
				content: "Need to inspect files",
				taskId: "task-1",
				ts: 2,
			},
			{
				type: "tool_call",
				tool: "mcp__mxd__bash",
				toolCallId: "call-1",
				input: { command: "pwd" },
				taskId: "task-1",
				ts: 3,
			},
			{
				type: "tool_result",
				tool: "mcp__mxd__bash",
				toolCallId: "call-1",
				content: "/repo",
				isError: false,
				images: [
					{
						base64: "dG9vbC1pbWFnZQ==",
						mediaType: "image/png",
					},
				],
				taskId: "task-1",
				ts: 4,
			},
			{
				type: "messages_consumed",
				messageIds: ["task-msg-1"],
				taskId: "task-1",
				ts: 5,
			},
			{
				type: "message",
				id: "task-msg-1",
				taskId: "task-1",
				ts: 5,
				body: {
					source: "task_message",
					id: "task-msg-1",
					ts: 5,
					fromTaskId: "parent-1",
					fromTitle: "Orchestrator",
					title: "Progress",
					content: "Please continue",
					requestReply: false,
				},
			},
			{
				type: "message",
				id: "img-msg-1",
				taskId: "task-1",
				ts: 6,
				body: {
					source: "user",
					id: "img-user-1",
					ts: 6,
					content: "image attached",
					images: [
						{
							base64: "dXNlci1pbWFnZQ==",
							mediaType: "image/png",
						},
					],
				},
			},
			{
				type: "messages_consumed",
				messageIds: ["img-msg-1"],
				taskId: "task-1",
				ts: 6,
			},
		];

		const messages = eventsToOpenAIResponsesMessages(events) as Array<
			Record<string, unknown>
		>;
		// User prompt is consumed into assistant/tool history here; what matters is the
		// tool-call/tool-result round-trip and multimodal image carry-forward.
		expect(messages).toHaveLength(3);
		expect(messages[0]).toMatchObject({
			role: "assistant",
			content: "Need to inspect files",
			tool_calls: [
				{
					id: "call-1",
					type: "function",
					function: {
						name: "mcp__mxd__bash",
						arguments: JSON.stringify({ command: "pwd" }),
					},
				},
			],
		});
		expect(messages[1]).toMatchObject({
			role: "tool",
			tool_call_id: "call-1",
			name: "mcp__mxd__bash",
		});
		expect(messages[1]?.content).toContain("/repo");
		expect(messages[1]?.content).toContain("Please continue");
		expect(messages[2]).toMatchObject({ role: "user" });
		expect(messages[2]?.content).toEqual([
			{ type: "text", text: "/repo" },
			{
				type: "image_url",
				image_url: {
					url: "data:image/png;base64,dG9vbC1pbWFnZQ==",
					detail: "auto",
				},
			},
			{ type: "text", text: "[User-attached image]" },
			{
				type: "image_url",
				image_url: {
					url: "data:image/png;base64,dXNlci1pbWFnZQ==",
					detail: "auto",
				},
			},
		]);
	});
});

describe("OpenAIResponsesCompatibleProvider runLoop", () => {
	let tmpDir: string;

	beforeAll(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "openai-responses-provider-test-"));
	});

	afterAll(async () => {
		clearContextWindowCache();
		await rm(tmpDir, { recursive: true, force: true });
	});

	test("posts Responses request body to /responses and completes done()", async () => {
		const originalFetch = globalThis.fetch;
		const requests: Array<{
			url: string;
			headers: Headers;
			body: Record<string, unknown>;
		}> = [];

		globalThis.fetch = mock(
			async (url: string | URL | Request, init?: RequestInit) => {
				const urlStr =
					typeof url === "string"
						? url
						: url instanceof URL
							? url.toString()
							: url.url;
				if (urlStr.endsWith("/models")) {
					return new Response(
						JSON.stringify({
							data: [{ id: "gpt-4.1-mini", context_length: 1047576 }],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				const body = JSON.parse(String(init?.body ?? "{}")) as Record<
					string,
					unknown
				>;
				requests.push({
					url: urlStr,
					headers: new Headers(init?.headers),
					body,
				});
				return sseResponse([
					{
						event: "response.created",
						data: { response: { id: "resp-1", status: "in_progress" } },
					},
					{
						event: "response.output_item.added",
						data: {
							output_index: 0,
							item: {
								id: "fc-1",
								type: "function_call",
								call_id: "call-done",
								name: "mcp__mxd__done",
								arguments: JSON.stringify({
									status: "passed",
									summary: "Task completed",
								}),
							},
						},
					},
					{
						event: "response.function_call_arguments.done",
						data: {
							output_index: 0,
							item_id: "fc-1",
							name: "mcp__mxd__done",
							arguments: JSON.stringify({
								status: "passed",
								summary: "Task completed",
							}),
						},
					},
					{
						event: "response.completed",
						data: {
							response: {
								id: "resp-1",
								status: "completed",
								usage: { input_tokens: 200, output_tokens: 20 },
							},
						},
					},
				]);
			},
		) as unknown as typeof fetch;

		try {
			const provider = new OpenAIResponsesCompatibleProvider("gpt-4.1-mini", {
				apiKey: "test-key",
				baseUrl: "https://api.example.com/v1",
			});
			const result = await provider.execute({
				cwd: tmpDir,
				systemPrompt: { stable: "Stable prompt", variable: "Variable prompt" },
				queue: queueWithPrompt("Please finish", tmpDir),
				mcpToolDefs: {
					mxd: [
						tool(
							"done",
							"Signal completion",
							{
								status: z.string(),
								summary: z.string().optional(),
							},
							async (input) => ({
								content: [
									{
										type: "text",
										text: `Task marked as ${input.status}`,
									},
								],
							}),
						),
					],
				},
			});

			expect(result.exitReason).toBe("done_passed");
			expect(result.turns).toBe(1);
			expect(result.costUsd).toBeGreaterThan(0);
			expect(requests).toHaveLength(1);
			expect(requests[0]?.url).toBe("https://api.example.com/v1/responses");
			expect(requests[0]?.headers.get("authorization")).toBe("Bearer test-key");
			const firstBody = requests[0]?.body;
			expect(firstBody).toMatchObject({
				model: "gpt-4.1-mini",
				instructions: "Stable prompt\n\nVariable prompt",
				stream: true,
				store: false,
				max_output_tokens: 128000,
			});
			expect(firstBody?.tools).toEqual([
				{
					type: "function",
					name: "mcp__mxd__done",
					description: "Signal completion",
					strict: false,
					parameters: {
						type: "object",
						properties: {
							status: { type: "string" },
							summary: { type: "string" },
						},
						required: ["status"],
					},
				},
			]);
			expect(firstBody?.input).toEqual([
				{
					type: "message",
					role: "user",
					content: [
						{
							type: "input_text",
							text: expect.stringContaining("Please finish"),
						},
					],
				},
			]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("serializes optional booleans and strings in tool schema for Responses", async () => {
		const originalFetch = globalThis.fetch;
		const requests: Array<Record<string, unknown>> = [];
		globalThis.fetch = mock(
			async (_url: string | URL | Request, init?: RequestInit) => {
				requests.push(JSON.parse(String(init?.body ?? "{}")));
				return sseResponse([
					{
						event: "response.created",
						data: { response: { id: "resp-1", status: "in_progress" } },
					},
					{
						event: "response.completed",
						data: {
							response: {
								id: "resp-1",
								status: "completed",
								usage: { input_tokens: 3, output_tokens: 2 },
							},
						},
					},
				]);
			},
		) as unknown as typeof fetch;

		try {
			const provider = new OpenAIResponsesCompatibleProvider("gpt-4.1-mini", {
				apiKey: "test-key",
				baseUrl: "https://api.example.com/v1",
			});
			await provider.execute({
				cwd: process.cwd(),
				systemPrompt: { stable: "Stable prompt", variable: "Variable prompt" },
				queue: queueWithPrompt("Please inspect the schema"),
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

			expect(requests).toHaveLength(1);
			expect(requests[0]?.tools).toEqual([
				{
					type: "function",
					name: "mcp__mxd__update_task",
					description: "Update task",
					strict: false,
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
			]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("round-trips tool results into the next Responses request after yield()", async () => {
		const originalFetch = globalThis.fetch;
		let callCount = 0;
		const requestBodies: Record<string, unknown>[] = [];
		globalThis.fetch = mock(
			async (_url: string | URL | Request, init?: RequestInit) => {
				callCount++;
				const body = JSON.parse(String(init?.body ?? "{}")) as Record<
					string,
					unknown
				>;
				requestBodies.push(body);
				if (callCount === 1) {
					return sseResponse([
						{
							event: "response.created",
							data: { response: { id: "resp-tool", status: "in_progress" } },
						},
						{
							event: "response.content_part.added",
							data: {
								output_index: 0,
								item_id: "msg-1",
								part: { type: "output_text", text: "Checking repo" },
							},
						},
						{
							event: "response.output_text.delta",
							data: {
								output_index: 0,
								item_id: "msg-1",
								content_index: 0,
								delta: " now",
							},
						},
						{
							event: "response.output_item.added",
							data: {
								output_index: 1,
								item: {
									id: "fc-yield",
									type: "function_call",
									call_id: "call-yield",
									name: "mcp__mxd__yield",
									arguments: JSON.stringify({}),
								},
							},
						},
						{
							event: "response.function_call_arguments.done",
							data: {
								output_index: 1,
								item_id: "fc-yield",
								name: "mcp__mxd__yield",
								arguments: JSON.stringify({}),
							},
						},
						{
							event: "response.completed",
							data: {
								response: {
									id: "resp-tool",
									status: "completed",
									usage: { input_tokens: 100, output_tokens: 10 },
								},
							},
						},
					]);
				}
				return sseResponse([
					{
						event: "response.created",
						data: { response: { id: "resp-idle", status: "in_progress" } },
					},
					{
						event: "response.content_part.added",
						data: {
							output_index: 0,
							item_id: "msg-2",
							part: { type: "output_text", text: "Back to idle" },
						},
					},
					{
						event: "response.completed",
						data: {
							response: {
								id: "resp-idle",
								status: "completed",
								usage: { input_tokens: 50, output_tokens: 5 },
							},
						},
					},
				]);
			},
		) as unknown as typeof fetch;

		try {
			const provider = new OpenAIResponsesCompatibleProvider("gpt-4o-mini", {
				apiKey: "test-key",
				baseUrl: "https://api.example.com/v1/responses",
			});
			const queue = queueWithPrompt("Need status", tmpDir);
			const session = provider.stream({
				cwd: tmpDir,
				systemPrompt: { stable: "Stable", variable: "Variable" },
				queue,
				buildYieldPendingSection: () =>
					"## Pending\n- Running sub tasks: none\n- Pending clarifications: none",
				mcpToolDefs: {
					mxd: [
						tool("yield", "Wait for more work", {}, async () => ({
							content: [{ type: "text", text: "waiting" }],
						})),
					],
				},
			});

			const seen: Event[] = [];
			const consumePromise = (async () => {
				let result = await session.next();
				while (!result.done) {
					seen.push(result.value);
					if (
						result.value.type === "tool_result" &&
						result.value.tool === "mcp__mxd__yield"
					) {
						queue.enqueue({
							source: "user",
							id: "resume-msg",
							ts: Date.now(),
							content: "Resume after yield",
						});
					}
					result = await session.next();
				}
				return result.value;
			})();

			await new Promise((resolve) => setTimeout(resolve, 0));
			queue.close();
			const finalResult = await consumePromise;
			expect(finalResult.exitReason).toBe("interrupted");
			expect(
				seen.some((e) => e.type === "text_delta" && e.content === " now"),
			).toBe(true);
			expect(
				seen.some(
					(e) =>
						e.type === "tool_call" &&
						e.tool === "mcp__mxd__yield" &&
						e.toolCallId === "call-yield",
				),
			).toBe(true);

			expect(requestBodies).toHaveLength(1);
			expect(requestBodies[0]?.max_output_tokens).toBe(128000);
			expect(requestBodies[0]?.input).toEqual([
				{
					type: "message",
					role: "user",
					content: [
						{
							type: "input_text",
							text: expect.stringContaining("Need status"),
						},
					],
				},
			]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("function_call_arguments.done supplies name/args when output_item.added omits them", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(async (url: string | URL | Request) => {
			const urlStr =
				typeof url === "string"
					? url
					: url instanceof URL
						? url.toString()
						: url.url;
			if (urlStr.endsWith("/models")) {
				return new Response(
					JSON.stringify({
						data: [{ id: "gpt-4.1-mini", context_length: 1047576 }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return sseResponse([
				{
					event: "response.created",
					data: { response: { id: "resp-1", status: "in_progress" } },
				},
				{
					event: "response.output_item.added",
					data: {
						output_index: 0,
						item: {
							id: "fc-1",
							type: "function_call",
							call_id: "call-done",
							name: "",
							arguments: "",
						},
					},
				},
				{
					event: "response.function_call_arguments.done",
					data: {
						output_index: 0,
						item_id: "fc-1",
						name: "mcp__mxd__done",
						arguments: JSON.stringify({
							status: "passed",
							summary: "All good",
						}),
					},
				},
				{
					event: "response.completed",
					data: {
						response: {
							id: "resp-1",
							status: "completed",
							usage: { input_tokens: 100, output_tokens: 10 },
						},
					},
				},
			]);
		}) as unknown as typeof fetch;

		try {
			const provider = new OpenAIResponsesCompatibleProvider("gpt-4.1-mini", {
				apiKey: "test-key",
				baseUrl: "https://api.example.com/v1",
			});

			// Collect events via stream() to verify tool_call shape
			const seen: Event[] = [];
			const queue = queueWithPrompt("Do the thing", tmpDir);
			const execQueue = new MessageQueue();
			for (const msg of queue.drain()) {
				execQueue.enqueue(msg);
			}
			execQueue.onDrain = () => {
				execQueue.onDrain = undefined;
				execQueue.close();
			};

			const gen = provider.stream({
				cwd: tmpDir,
				systemPrompt: { stable: "Stable", variable: "Variable" },
				queue: execQueue,
				mcpToolDefs: {
					mxd: [
						tool(
							"done",
							"Signal completion",
							{
								status: z.string(),
								summary: z.string().optional(),
							},
							async (input) => ({
								content: [
									{
										type: "text",
										text: `Task marked as ${input.status}`,
									},
								],
							}),
						),
					],
				},
			});
			let result = await gen.next();
			while (!result.done) {
				seen.push(result.value);
				result = await gen.next();
			}
			const finalResult = result.value;

			// done_passed proves name was correctly assembled from function_call_arguments.done
			expect(finalResult.exitReason).toBe("done_passed");

			// Verify the tool_call event has correct name and parsed input
			const toolCallEvent = seen.find(
				(e) => e.type === "tool_call" && e.toolCallId === "call-done",
			);
			expect(toolCallEvent).toBeDefined();
			expect(toolCallEvent?.type).toBe("tool_call");
			if (toolCallEvent?.type === "tool_call") {
				expect(toolCallEvent.tool).toBe("mcp__mxd__done");
				expect(toolCallEvent.input).toEqual({
					status: "passed",
					summary: "All good",
				});
			}
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("streamResponsesAPI inner retry", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function successSSEResponse(): Response {
		return sseResponse([
			{
				event: "response.created",
				data: { response: { id: "resp-1", status: "in_progress" } },
			},
			{
				event: "response.completed",
				data: {
					response: {
						id: "resp-1",
						status: "completed",
						output: [],
						usage: { input_tokens: 3, output_tokens: 2 },
					},
				},
			},
		]);
	}

	function errorResponse(status: number, body = "error"): Response {
		return new Response(body, { status, headers: {} });
	}

	const baseParams = {
		endpoint: "https://api.openai.com/v1",
		authToken: "test-key",
		model: "gpt-4.1-mini",
		messages: [] as Parameters<typeof streamResponsesAPI>[0]["messages"],
		tools: [] as Parameters<typeof streamResponsesAPI>[0]["tools"],
		instructions: "test",
		maxTokens: 4096,
		retryDelayMs: () => 1, // near-zero delay for tests
	};

	async function runStream(
		fetchMock: typeof fetch,
	): Promise<{ events: Event[]; response: unknown }> {
		globalThis.fetch = fetchMock;
		const gen = streamResponsesAPI(baseParams);
		const events: Event[] = [];
		let result = await gen.next();
		while (!result.done) {
			events.push(result.value);
			result = await gen.next();
		}
		return { events, response: result.value };
	}

	test("retries on 429 then succeeds", async () => {
		let callCount = 0;
		const fetchMock = mock(async () => {
			callCount++;
			if (callCount === 1) return errorResponse(429, "rate limited");
			return successSSEResponse();
		}) as unknown as typeof fetch;

		const { events } = await runStream(fetchMock);

		expect(callCount).toBe(2);
		const errorEvents = events.filter((e) => e.type === "error");
		expect(errorEvents.length).toBe(1);
		expect(
			errorEvents[0]?.type === "error" && errorEvents[0]?.message,
		).toContain("retry 1/4");
	});

	test("retries on 500 then succeeds", async () => {
		let callCount = 0;
		const fetchMock = mock(async () => {
			callCount++;
			if (callCount <= 2) return errorResponse(500, "internal server error");
			return successSSEResponse();
		}) as unknown as typeof fetch;

		const { events } = await runStream(fetchMock);

		expect(callCount).toBe(3);
		const errorEvents = events.filter((e) => e.type === "error");
		expect(errorEvents.length).toBe(2);
	});

	test("retries on 502, 503, 529", async () => {
		const transientCodes = [502, 503, 529];
		for (const code of transientCodes) {
			let callCount = 0;
			const fetchMock = mock(async () => {
				callCount++;
				if (callCount === 1) return errorResponse(code, `error ${code}`);
				return successSSEResponse();
			}) as unknown as typeof fetch;

			const { events } = await runStream(fetchMock);
			expect(callCount).toBe(2);
			const errorEvents = events.filter((e) => e.type === "error");
			expect(errorEvents.length).toBe(1);
		}
	});

	test("does not retry on 400 (client error)", async () => {
		let callCount = 0;
		const fetchMock = mock(async () => {
			callCount++;
			return errorResponse(400, "bad request");
		}) as unknown as typeof fetch;

		await expect(runStream(fetchMock)).rejects.toThrow(
			"OpenAI Responses API error (400): bad request",
		);
		expect(callCount).toBe(1);
	});

	test("does not retry on 401 (unauthorized)", async () => {
		let callCount = 0;
		const fetchMock = mock(async () => {
			callCount++;
			return errorResponse(401, "unauthorized");
		}) as unknown as typeof fetch;

		await expect(runStream(fetchMock)).rejects.toThrow(
			"OpenAI Responses API error (401): unauthorized",
		);
		expect(callCount).toBe(1);
	});

	test("does not retry on 403", async () => {
		let callCount = 0;
		const fetchMock = mock(async () => {
			callCount++;
			return errorResponse(403, "forbidden");
		}) as unknown as typeof fetch;

		await expect(runStream(fetchMock)).rejects.toThrow(
			"OpenAI Responses API error (403): forbidden",
		);
		expect(callCount).toBe(1);
	});

	test("does not retry on 404", async () => {
		let callCount = 0;
		const fetchMock = mock(async () => {
			callCount++;
			return errorResponse(404, "not found");
		}) as unknown as typeof fetch;

		await expect(runStream(fetchMock)).rejects.toThrow(
			"OpenAI Responses API error (404): not found",
		);
		expect(callCount).toBe(1);
	});

	test("throws after exhausting all 5 retry attempts on persistent 429", async () => {
		let callCount = 0;
		const fetchMock = mock(async () => {
			callCount++;
			return errorResponse(429, "rate limited");
		}) as unknown as typeof fetch;

		await expect(runStream(fetchMock)).rejects.toThrow(
			"OpenAI Responses API error (429): rate limited",
		);
		expect(callCount).toBe(5);
		// Should have yielded 4 error events (attempts 1-4 retry, 5th throws)
	});
});
