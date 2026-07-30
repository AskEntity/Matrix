import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { openAICredentialSource, staticCredential } from "./codex-auth.ts";
import { clearContextWindowCache } from "./context-window.ts";
import type { Event, EventSpec } from "./events.ts";
import { MessageQueue } from "./message-queue.ts";
import {
	createOpenAIResponsesAdapter,
	eventsToOpenAIResponsesMessages,
	getModelPricing,
	OpenAIResponsesCompatibleProvider,
	streamResponsesAPI,
} from "./openai-responses-compatible-provider.ts";
import { withClientEnv } from "./test-utils/sdk-client-env.ts";
import { tool } from "./tool-definition.ts";

/**
 * What every endpoint in this file answers to `GET /models`.
 *
 * The provider loop now asks the endpoint for the context window before its
 * first API call and throws if it will not answer — `src/context-window.ts`
 * deleted the static table, the substring guess and the default constant. So a
 * runLoop fixture has to say what its deployment offers, the same way a real
 * one does. Numbers are OpenAI's published windows for these two models.
 */
function modelsListResponse(): Response {
	return new Response(
		JSON.stringify({
			data: [
				{ id: "gpt-4.1-mini", context_length: 1_047_576 },
				{ id: "gpt-4o-mini", context_length: 128_000 },
			],
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

/**
 * Wrap a fetch mock so `/models` is served before the handler sees it.
 * Intercepting OUTSIDE the handler matters: several of these mocks count calls
 * or record bodies, and the window lookup is not one of the requests they are
 * about.
 */
function withModelsList(
	handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
	return mock(async (url: string | URL | Request, init?: RequestInit) => {
		const urlStr =
			typeof url === "string"
				? url
				: url instanceof URL
					? url.toString()
					: url.url;
		// Match the PATH, not the whole URL: the models request now carries a
		// required `client_version` query string, and an endsWith("/models")
		// guard silently stops recognising it — which shows up as every runLoop
		// test getting an SSE body where it asked for a model list.
		if (new URL(urlStr).pathname.endsWith("/models")) {
			return modelsListResponse();
		}
		return handler(urlStr, init);
	}) as unknown as typeof fetch;
}

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
	let seq = 0;
	const body = events
		.map(({ event, data }) => {
			// SDK expects `type` and `sequence_number` in parsed JSON data
			const enriched =
				typeof data === "object" && data !== null
					? {
							type: event,
							sequence_number: seq++,
							...(data as Record<string, unknown>),
						}
					: data;
			return `event: ${event}\ndata: ${JSON.stringify(enriched)}\n\n`;
		})
		.join("");
	return new Response(body, {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
	});
}

/** Build a minimal but complete OAI Response object for mock SSE data. */
function mockOAIResponse(overrides: {
	id?: string;
	output?: unknown[];
	usage?: { input_tokens: number; output_tokens: number };
	model?: string;
}): Record<string, unknown> {
	return {
		id: overrides.id ?? "resp-1",
		object: "response",
		status: "completed",
		output: overrides.output ?? [],
		output_text: "",
		usage: {
			input_tokens: overrides.usage?.input_tokens ?? 0,
			output_tokens: overrides.usage?.output_tokens ?? 0,
			input_tokens_details: { cached_tokens: 0 },
			output_tokens_details: { reasoning_tokens: 0 },
		},
		created_at: 0,
		error: null,
		incomplete_details: null,
		instructions: null,
		metadata: null,
		model: overrides.model ?? "gpt-4.1-mini",
		parallel_tool_calls: true,
		temperature: 1,
		tool_choice: "auto",
		tools: [],
		top_p: 1,
	};
}

/** Build a function_call output item for mock responses. */
function mockFunctionCall(opts: {
	id?: string;
	call_id: string;
	name: string;
	arguments: string;
}): Record<string, unknown> {
	return {
		type: "function_call",
		id: opts.id ?? opts.call_id,
		call_id: opts.call_id,
		name: opts.name,
		arguments: opts.arguments,
		status: "completed",
	};
}

describe("OpenAIResponsesCompatibleProvider constructor", () => {
	// No env save/restore here: the constructor reads no environment variable, so
	// what the shell happens to hold cannot reach it. An empty opts IS "no
	// credential configured" — the state the warning is about.
	test("warns when no credential is configured", () => {
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(
				() => new OpenAIResponsesCompatibleProvider("gpt-4.1-mini", {}),
			).not.toThrow();
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("no OpenAI credential configured"),
			);
		} finally {
			warnSpy.mockRestore();
		}
	});

	// Inverted guard for a DELETED feature, not a re-aimed test of a deleted
	// mechanism: the producer it consumes still exists (a shell really can hold
	// OPENAI_API_KEY), so this reddens the moment the fallback comes back —
	// verified by mutation. Nothing else in the suite pins it: the env fallback
	// itself never had a test, so its absence would not have had one either.
	test("a populated OPENAI_API_KEY in the environment is NOT picked up", () => {
		const saved = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "sk-env-should-be-ignored";
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		try {
			new OpenAIResponsesCompatibleProvider("gpt-4.1-mini", {});
			// Reached the "no credential" branch => the env value never landed.
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("no OpenAI credential configured"),
			);
		} finally {
			if (saved === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = saved;
			warnSpy.mockRestore();
		}
	});

	test("accepts access token via constructor apiKey slot", () => {
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
			warnSpy.mockRestore();
		}
	});

	/**
	 * The canonical journey for the codex path: point an auth group at the file
	 * the codex CLI writes, run an agent, and the token inside that file is what
	 * reaches the API. This replaces the old `accessToken` test — the capability
	 * ("a credential that is not an apiKey reaches the Authorization header")
	 * survived; only where it is read from changed.
	 */
	test("uses the token inside authJsonPath when apiKey is absent", async () => {
		let authHeader: string | undefined;
		const originalFetch = globalThis.fetch;
		const doneArgs = JSON.stringify({ status: "passed", result: "ok" });
		globalThis.fetch = withModelsList(
			async (_url: string, init?: RequestInit) => {
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
							item: mockFunctionCall({
								call_id: "call-done",
								name: "mcp__mxd__done",
								arguments: doneArgs,
							}),
						},
					},
					{
						event: "response.function_call_arguments.done",
						data: {
							output_index: 0,
							item_id: "call-done",
							name: "mcp__mxd__done",
							arguments: doneArgs,
						},
					},
					{
						event: "response.completed",
						data: {
							response: mockOAIResponse({
								output: [
									mockFunctionCall({
										call_id: "call-done",
										name: "mcp__mxd__done",
										arguments: doneArgs,
									}),
								],
								usage: { input_tokens: 3, output_tokens: 2 },
							}),
						},
					},
				]);
			},
		) as unknown as typeof fetch;

		const dir = await mkdtemp(join(tmpdir(), "codex-auth-"));
		const authPath = join(dir, "auth.json");
		await writeFile(
			authPath,
			JSON.stringify({
				OPENAI_API_KEY: null,
				tokens: { access_token: "token-from-file", account_id: "acct-1" },
			}),
		);

		try {
			const provider = new OpenAIResponsesCompatibleProvider("gpt-4.1-mini", {
				authJsonPath: authPath,
			});
			const result = await provider.execute({
				buildSystemPrompt: () => ({ stable: "stable", variable: "variable" }),
				buildWorkContext: () => null,
				buildSummarizationPrompt: () => "Summarize the conversation.",
				model: "gpt-4.1-mini",
				queue: queueWithPrompt("Do the thing"),
				mcpToolDefs: {
					mxd: [
						tool("done", "Signal completion", {}, async () => ({
							content: [{ type: "text", text: "done ok" }],
						})),
					],
				},
			});
			expect(authHeader).toBe("Bearer token-from-file");
			expect(result.exitReason).toBe("done_passed");
		} finally {
			globalThis.fetch = originalFetch;
			await rm(dir, { recursive: true, force: true });
		}
	});
});

/**
 * The design's central claim, at the layer that could break it.
 *
 * ⭐ These pass if and only if nothing between the auth group and the request
 * captures a token. A single `const token = await credentials()` hoisted out of
 * a call — the tidy-looking refactor — reverts us to holding a copy of a
 * credential codex rotates, which is the bug the whole shape exists to prevent,
 * and no other test in the suite would notice.
 */
describe("the credential is re-read at every use", () => {
	let dir: string;
	let authPath: string;

	beforeEach(async () => {
		clearContextWindowCache();
		dir = await mkdtemp(join(tmpdir(), "codex-auth-"));
		authPath = join(dir, "auth.json");
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	async function writeToken(token: string, accountId?: string): Promise<void> {
		await writeFile(
			authPath,
			JSON.stringify({
				OPENAI_API_KEY: null,
				tokens: {
					access_token: token,
					...(accountId ? { account_id: accountId } : {}),
				},
			}),
		);
	}

	test("a rewrite between two calls is picked up by the second", async () => {
		const bearers: Array<string | undefined> = [];
		const accounts: Array<string | undefined> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
			const h = new Headers(init?.headers);
			bearers.push(h.get("authorization") ?? undefined);
			accounts.push(h.get("chatgpt-account-id") ?? undefined);
			return new Response(
				JSON.stringify({ data: [{ id: "m", context_length: 1000 }] }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		try {
			await writeToken("first-token", "acct-first");
			const adapter = createOpenAIResponsesAdapter(
				"https://api.example.com/v1",
				openAICredentialSource({ provider: "openai", authJsonPath: authPath }),
			);
			expect(await adapter.getContextWindow("m")).toBe(1000);

			// codex refreshes the file behind us — the thing that actually happens.
			await writeToken("second-token", "acct-second");
			clearContextWindowCache();
			expect(await adapter.getContextWindow("m")).toBe(1000);

			expect(bearers).toEqual(["Bearer first-token", "Bearer second-token"]);
			expect(accounts).toEqual(["acct-first", "acct-second"]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("an apiKey group needs no file and answers the same value twice", async () => {
		const source = openAICredentialSource({
			provider: "openai",
			apiKey: "sk-static",
		});
		expect((await source()).authToken).toBe("sk-static");
		expect((await source()).authToken).toBe("sk-static");
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
});

/**
 * Replaces `describe("fetchContextWindowFromAPI")`, whose five tests all
 * asserted behaviour that no longer exists: a null return that let a static
 * table take over, and prefix matching in both directions. Both were deleted
 * with the table — see src/context-window.ts. What survives is the inversion:
 * the adapter must ask, and must throw rather than answer with anything else.
 */
describe("OpenAI adapter.getContextWindow asks the endpoint", () => {
	function withFetch<T>(
		handler: (url: string, init?: RequestInit) => Promise<Response>,
		body: (calls: () => string[]) => Promise<T>,
	): Promise<T> {
		const originalFetch = globalThis.fetch;
		const urls: string[] = [];
		globalThis.fetch = mock(
			async (url: string | URL | Request, init?: RequestInit) => {
				const urlStr =
					typeof url === "string"
						? url
						: url instanceof URL
							? url.toString()
							: url.url;
				urls.push(urlStr);
				return handler(urlStr, init);
			},
		) as unknown as typeof fetch;
		return body(() => urls).finally(() => {
			globalThis.fetch = originalFetch;
		});
	}

	function modelsResponse(data: Array<Record<string, unknown>>): Response {
		return new Response(JSON.stringify({ data }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}

	beforeEach(() => {
		clearContextWindowCache();
	});

	test("reads context_length and sends the bearer token", async () => {
		await withFetch(
			async () => modelsResponse([{ id: "gpt-4o", context_length: 131072 }]),
			async (urls) => {
				const adapter = createOpenAIResponsesAdapter(
					"https://api.example.com/v1",
					staticCredential("token"),
				);
				expect(await adapter.getContextWindow("gpt-4o")).toBe(131072);
				// The version filter is part of the request, deliberately asserted:
				// dropping it 400s the codex catalog, and pinning a REAL version
				// here would degrade to an empty list as the server floor rises.
				expect(urls()).toEqual([
					"https://api.example.com/v1/models?client_version=999.0.0",
				]);
			},
		);
	});

	/**
	 * The old `canFetchModels` refused to look when the configured base URL
	 * already pointed at /responses, and fell through to the static table. With
	 * the table gone, refusing to look can only produce a worse error, so the
	 * models URL is derived from the API root instead.
	 */
	test("still asks when the configured base URL points at /responses", async () => {
		await withFetch(
			async () => modelsResponse([{ id: "gpt-4o", context_length: 131072 }]),
			async (urls) => {
				const adapter = createOpenAIResponsesAdapter(
					"https://api.example.com/v1/responses",
					staticCredential("token"),
				);
				expect(await adapter.getContextWindow("gpt-4o")).toBe(131072);
				expect(urls()).toEqual([
					"https://api.example.com/v1/models?client_version=999.0.0",
				]);
			},
		);
	});

	test("throws on a non-200, naming the endpoint and the status", async () => {
		await withFetch(
			async () => new Response("nope", { status: 401 }),
			async () => {
				const adapter = createOpenAIResponsesAdapter(
					"https://chatgpt.com/backend-api/codex/responses",
					staticCredential("token"),
				);
				await expect(adapter.getContextWindow("gpt-5-codex")).rejects.toThrow(
					/chatgpt\.com\/backend-api\/codex\/models\?client_version=[\d.]+ returned 401/,
				);
			},
		);
	});

	/**
	 * `api.openai.com/v1/models` really does answer 200 with no context length
	 * on any entry. That used to silently become 128_000; it is now an error
	 * that says which keys were looked for and which the entry carried.
	 */
	test("throws when the model is listed without either window key", async () => {
		await withFetch(
			async () =>
				modelsResponse([{ id: "gpt-4o", object: "model", owned_by: "openai" }]),
			async () => {
				const adapter = createOpenAIResponsesAdapter(
					"https://api.openai.com/v1",
					staticCredential("token"),
				);
				await expect(adapter.getContextWindow("gpt-4o")).rejects.toThrow(
					/neither max_input_tokens nor context_length/,
				);
			},
		);
	});

	/**
	 * ⭐ The codex catalog disagrees on the ENVELOPE too — `{models:[…]}` where
	 * every OpenAI-compatible endpoint says `{data:[…]}`. Before this, the
	 * provider threw `returned 200 with no "data" array` on a perfectly good
	 * reply. Payload copied from the live response (2026-07-30).
	 */
	test("reads the codex envelope: models[] keyed by slug, window in context_window", async () => {
		await withFetch(
			async () =>
				new Response(
					JSON.stringify({
						models: [
							{ slug: "gpt-5.5", context_window: 272_000 },
							{
								slug: "gpt-5.4",
								context_window: 272_000,
								max_context_window: 1_000_000,
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			async (urls) => {
				const adapter = createOpenAIResponsesAdapter(
					"https://chatgpt.com/backend-api/codex/responses",
					staticCredential("token"),
				);
				expect(await adapter.getContextWindow("gpt-5.5")).toBe(272_000);
				// The API root is derived by stripping /responses, and the version
				// filter rides along — omit it and the real endpoint 400s.
				expect(urls()).toEqual([
					"https://chatgpt.com/backend-api/codex/models?client_version=999.0.0",
				]);
			},
		);
	});

	test("neither data nor models is a reportable failure, not a silent empty list", async () => {
		await withFetch(
			async () =>
				new Response(JSON.stringify({ object: "list" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			async () => {
				const adapter = createOpenAIResponsesAdapter(
					"https://api.example.com/v1",
					staticCredential("token"),
				);
				await expect(adapter.getContextWindow("gpt-4o")).rejects.toThrow(
					/neither a "data" nor a "models" array/,
				);
			},
		);
	});

	/**
	 * ⚠️ The whole reason `requestDetail` exists. MEASURED: the codex catalog
	 * answers 200 with zero models when `client_version` is under its floor, so
	 * this failure is caused by a parameter WE send. The error has to point
	 * there — telling the user their model is not listed sends them to edit a
	 * config field that cannot fix it.
	 */
	test("an empty catalogue blames the request, not the configured model", async () => {
		await withFetch(
			async () =>
				new Response(JSON.stringify({ models: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			async () => {
				const adapter = createOpenAIResponsesAdapter(
					"https://chatgpt.com/backend-api/codex/responses",
					staticCredential("token"),
				);
				const call = adapter.getContextWindow("gpt-5.5");
				await expect(call).rejects.toThrow(/enumerated no models at all/);
				await expect(call).rejects.toThrow(
					/asked as: GET .*\/models\?client_version=[\d.]+/,
				);
				await expect(call).rejects.not.toThrow(/does not list it/);
			},
		);
	});

	test("a near-miss id is suggested, never resolved", async () => {
		await withFetch(
			async () =>
				modelsResponse([
					{ id: "gpt-4o-2024-08-06", context_length: 131072 },
					{ id: "gpt-4.1", context_length: 1047576 },
				]),
			async () => {
				const adapter = createOpenAIResponsesAdapter(
					"https://api.example.com/v1",
					staticCredential("token"),
				);
				const call = adapter.getContextWindow("gpt-4o");
				await expect(call).rejects.toThrow(/Did you mean "gpt-4o-2024-08-06"/);
				await expect(call).rejects.toThrow(/does not list it/);
			},
		);
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

describe("eventsToOpenAIResponsesMessages: cross-provider thinking", () => {
	test("thinking from another provider → text content with <thinking> wrapper", () => {
		const events: Event[] = [
			{
				type: "thinking",
				thinking: "Anthropic reasoning here",
				signature: "sig-anthro",
				provider: "anthropic",
				taskId: "t1",
				ts: 1,
			},
			{
				type: "assistant_text",
				content: "Visible answer",
				taskId: "t1",
				ts: 2,
			},
		];
		const msgs = eventsToOpenAIResponsesMessages(events) as Array<
			Record<string, unknown>
		>;
		expect(msgs).toHaveLength(1);
		// OpenAI format: text content is a string (not blocks)
		// Thinking converted to text should be prepended
		expect(msgs[0]).toEqual({
			role: "assistant",
			content:
				"<thinking>\nAnthropic reasoning here\n</thinking>\nVisible answer",
		});
	});

	test("redacted thinking from another provider → skipped", () => {
		const events: Event[] = [
			{
				type: "thinking",
				thinking: "",
				signature: "encrypted-sig",
				provider: "anthropic",
				redacted: true,
				taskId: "t1",
				ts: 1,
			},
			{
				type: "assistant_text",
				content: "Just the answer",
				taskId: "t1",
				ts: 2,
			},
		];
		const msgs = eventsToOpenAIResponsesMessages(events) as Array<
			Record<string, unknown>
		>;
		expect(msgs).toHaveLength(1);
		expect(msgs[0]).toEqual({
			role: "assistant",
			content: "Just the answer",
		});
	});

	test("thinking-only turn (no text, no tool_call) → text content from thinking", () => {
		const events: Event[] = [
			{
				type: "thinking",
				thinking: "Just thinking, no output",
				signature: "sig-1",
				provider: "anthropic",
				taskId: "t1",
				ts: 1,
			},
		];
		const msgs = eventsToOpenAIResponsesMessages(events) as Array<
			Record<string, unknown>
		>;
		expect(msgs).toHaveLength(1);
		expect(msgs[0]).toEqual({
			role: "assistant",
			content: "<thinking>\nJust thinking, no output\n</thinking>",
		});
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

		globalThis.fetch = withModelsList(
			async (urlStr: string, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body ?? "{}")) as Record<
					string,
					unknown
				>;
				requests.push({
					url: urlStr,
					headers: new Headers(init?.headers),
					body,
				});
				const doneArgs = JSON.stringify({
					status: "passed",
					result: "Task completed",
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
							item: mockFunctionCall({
								id: "fc-1",
								call_id: "call-done",
								name: "mcp__mxd__done",
								arguments: doneArgs,
							}),
						},
					},
					{
						event: "response.function_call_arguments.done",
						data: {
							output_index: 0,
							item_id: "fc-1",
							name: "mcp__mxd__done",
							arguments: doneArgs,
						},
					},
					{
						event: "response.completed",
						data: {
							response: mockOAIResponse({
								output: [
									mockFunctionCall({
										id: "fc-1",
										call_id: "call-done",
										name: "mcp__mxd__done",
										arguments: doneArgs,
									}),
								],
								usage: { input_tokens: 200, output_tokens: 20 },
							}),
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
				buildSystemPrompt: () => ({
					stable: "Stable prompt",
					variable: "Variable prompt",
				}),
				buildWorkContext: () => null,
				buildSummarizationPrompt: () => "Summarize the conversation.",
				model: "gpt-4.1-mini",
				queue: queueWithPrompt("Please finish", tmpDir),
				mcpToolDefs: {
					mxd: [
						tool(
							"done",
							"Signal completion",
							{
								status: z.string(),
								result: z.string().optional(),
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
							result: { type: "string" },
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
		globalThis.fetch = withModelsList(
			async (_url: string, init?: RequestInit) => {
				requests.push(JSON.parse(String(init?.body ?? "{}")));
				return sseResponse([
					{
						event: "response.created",
						data: { response: { id: "resp-1", status: "in_progress" } },
					},
					{
						event: "response.completed",
						data: {
							response: mockOAIResponse({
								usage: { input_tokens: 3, output_tokens: 2 },
							}),
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
				buildSystemPrompt: () => ({
					stable: "Stable prompt",
					variable: "Variable prompt",
				}),
				buildWorkContext: () => null,
				buildSummarizationPrompt: () => "Summarize the conversation.",
				model: "gpt-4.1-mini",
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
		globalThis.fetch = withModelsList(
			async (_url: string, init?: RequestInit) => {
				callCount++;
				const body = JSON.parse(String(init?.body ?? "{}")) as Record<
					string,
					unknown
				>;
				requestBodies.push(body);
				if (callCount === 1) {
					const yieldArgs = JSON.stringify({});
					return sseResponse([
						{
							event: "response.created",
							data: { response: { id: "resp-tool", status: "in_progress" } },
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
								item: mockFunctionCall({
									id: "fc-yield",
									call_id: "call-yield",
									name: "mcp__mxd__yield",
									arguments: yieldArgs,
								}),
							},
						},
						{
							event: "response.function_call_arguments.done",
							data: {
								output_index: 1,
								item_id: "fc-yield",
								name: "mcp__mxd__yield",
								arguments: yieldArgs,
							},
						},
						{
							event: "response.completed",
							data: {
								response: mockOAIResponse({
									id: "resp-tool",
									output: [
										{
											type: "message",
											id: "msg-1",
											role: "assistant",
											content: [
												{
													type: "output_text",
													text: "Checking repo now",
													annotations: [],
												},
											],
											status: "completed",
										},
										mockFunctionCall({
											id: "fc-yield",
											call_id: "call-yield",
											name: "mcp__mxd__yield",
											arguments: yieldArgs,
										}),
									],
									usage: { input_tokens: 100, output_tokens: 10 },
								}),
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
						event: "response.completed",
						data: {
							response: mockOAIResponse({
								id: "resp-idle",
								output: [
									{
										type: "message",
										id: "msg-2",
										role: "assistant",
										content: [
											{
												type: "output_text",
												text: "Back to idle",
												annotations: [],
											},
										],
										status: "completed",
									},
								],
								usage: { input_tokens: 50, output_tokens: 5 },
							}),
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
				buildSystemPrompt: () => ({ stable: "Stable", variable: "Variable" }),
				buildWorkContext: () => null,
				buildSummarizationPrompt: () => "Summarize the conversation.",
				model: "gpt-4o-mini",
				queue,

				mcpToolDefs: {
					mxd: [
						tool("yield", "Wait for more work", {}, async () => ({
							content: [{ type: "text", text: "waiting" }],
						})),
					],
				},
			});

			const seen: EventSpec[] = [];
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
		globalThis.fetch = withModelsList(async () => {
			const doneArgs = JSON.stringify({
				status: "passed",
				result: "All good",
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
						arguments: doneArgs,
					},
				},
				{
					event: "response.completed",
					data: {
						response: mockOAIResponse({
							output: [
								mockFunctionCall({
									id: "fc-1",
									call_id: "call-done",
									name: "mcp__mxd__done",
									arguments: doneArgs,
								}),
							],
							usage: { input_tokens: 100, output_tokens: 10 },
						}),
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
			const seen: EventSpec[] = [];
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
				buildSystemPrompt: () => ({ stable: "Stable", variable: "Variable" }),
				buildWorkContext: () => null,
				buildSummarizationPrompt: () => "Summarize the conversation.",
				model: "gpt-4.1-mini",
				queue: execQueue,
				mcpToolDefs: {
					mxd: [
						tool(
							"done",
							"Signal completion",
							{
								status: z.string(),
								result: z.string().optional(),
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
					result: "All good",
				});
			}
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("streamResponsesAPI (SDK-based)", () => {
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
						object: "response",
						status: "completed",
						output: [],
						output_text: "",
						usage: {
							input_tokens: 3,
							output_tokens: 2,
							input_tokens_details: { cached_tokens: 0 },
							output_tokens_details: { reasoning_tokens: 0 },
						},
						created_at: 0,
						error: null,
						incomplete_details: null,
						instructions: null,
						metadata: null,
						model: "gpt-4.1-mini",
						parallel_tool_calls: true,
						temperature: 1,
						tool_choice: "auto",
						tools: [],
						top_p: 1,
					},
				},
			},
		]);
	}

	function errorResponse(status: number, body = "error"): Response {
		return new Response(body, {
			status,
			headers: { "Content-Type": "application/json" },
		});
	}

	const baseBody = {
		model: "gpt-4.1-mini" as const,
		instructions: "test",
		input: [] as [],
		tools: [] as [],
		stream: true as const,
		store: false,
	};

	async function runStream(
		fetchMock: typeof fetch,
		overrides?: Partial<Parameters<typeof streamResponsesAPI>[0]>,
	): Promise<{ events: EventSpec[]; response: unknown }> {
		globalThis.fetch = fetchMock;
		const gen = streamResponsesAPI({
			endpoint: "https://api.openai.com/v1",
			authToken: "test-key",
			body: baseBody,
			maxRetries: 0, // disable SDK retries for error tests
			...overrides,
		});
		const events: EventSpec[] = [];
		let result = await gen.next();
		while (!result.done) {
			events.push(result.value);
			result = await gen.next();
		}
		return { events, response: result.value };
	}

	test("streams text_delta and returns completed response", async () => {
		const fetchMock = mock(async () =>
			sseResponse([
				{
					event: "response.created",
					data: { response: { id: "resp-1", status: "in_progress" } },
				},
				{
					event: "response.output_text.delta",
					data: { output_index: 0, content_index: 0, delta: "Hello" },
				},
				{
					event: "response.completed",
					data: {
						response: {
							id: "resp-1",
							object: "response",
							status: "completed",
							output: [
								{
									type: "message",
									id: "msg-1",
									role: "assistant",
									content: [
										{ type: "output_text", text: "Hello", annotations: [] },
									],
									status: "completed",
								},
							],
							output_text: "Hello",
							usage: {
								input_tokens: 10,
								output_tokens: 5,
								input_tokens_details: { cached_tokens: 0 },
								output_tokens_details: { reasoning_tokens: 0 },
							},
							created_at: 0,
							error: null,
							incomplete_details: null,
							instructions: null,
							metadata: null,
							model: "gpt-4.1-mini",
							parallel_tool_calls: true,
							temperature: 1,
							tool_choice: "auto",
							tools: [],
							top_p: 1,
						},
					},
				},
			]),
		) as unknown as typeof fetch;

		const { events, response } = await runStream(fetchMock);
		const textDeltas = events.filter((e) => e.type === "text_delta");
		expect(textDeltas.length).toBeGreaterThanOrEqual(1);
		expect((response as { id: string }).id).toBe("resp-1");
		expect((response as { output_text: string }).output_text).toBe("Hello");
	});

	// The OpenAI SDK takes ALL FIVE of its credential-ish slots as default
	// parameters reading env, so a slot we leave out is a slot the shell fills.
	// `organization` / `project` were left out, and they become
	// `OpenAI-Organization` / `OpenAI-Project` headers — which OpenAI documents as
	// deciding attribution: "If no header is provided, the default organization
	// will be billed." Pinned to `null`, the only spelling that suppresses the
	// read (`""` also suppresses it and emits an empty bearer token — measured,
	// and not a workaround).
	//
	// `apiKey` and `baseURL` are always passed at this site, so env cannot reach
	// them today. "Today" is the reason this test asserts all four names and not
	// just the two that leaked: nothing else pins it, and `apiKey`'s type has no
	// `null`, so if `authToken` ever became optional there would be no way to
	// stop OPENAI_API_KEY from filling it.
	test("no shell value decides the credential, the host, or who is billed", async () => {
		const seen: Record<string, string>[] = [];
		const hosts: string[] = [];
		const fetchMock = mock(
			async (url: string | URL | Request, init?: RequestInit) => {
				const request = new Request(url, init);
				const headers: Record<string, string> = {};
				request.headers.forEach((v, k) => {
					if (
						k === "authorization" ||
						k === "openai-organization" ||
						k === "openai-project"
					)
						headers[k] = v;
				});
				seen.push(headers);
				hosts.push(new URL(request.url).origin);
				return successSSEResponse();
			},
		) as unknown as typeof fetch;

		await withClientEnv(
			{
				OPENAI_API_KEY: "sk-shell-key-should-never-be-sent",
				OPENAI_BASE_URL: "https://env-should-never-decide.example.com",
				OPENAI_ORG_ID: "org-shell-should-never-be-sent",
				OPENAI_PROJECT_ID: "proj-shell-should-never-be-sent",
			},
			// runStream installs the fetch stub before streamResponsesAPI builds the
			// client, which is required: the SDK snapshots globalThis.fetch in its
			// constructor.
			() => runStream(fetchMock, { authToken: "configured-token" }),
		);

		// One request, carrying our credential and nothing of the shell's. The
		// positive `authorization` entry is the control: an empty object is also
		// what a reader that read nothing returns.
		expect(seen).toEqual([{ authorization: "Bearer configured-token" }]);
		expect(hosts).toEqual(["https://api.openai.com"]);
	});

	test("SDK retries on 429 then succeeds", async () => {
		let callCount = 0;
		const fetchMock = mock(async () => {
			callCount++;
			if (callCount === 1) return errorResponse(429, "rate limited");
			return successSSEResponse();
		}) as unknown as typeof fetch;

		// maxRetries: 2 lets the SDK retry once after 429
		const { response } = await runStream(fetchMock, { maxRetries: 2 });
		expect(callCount).toBe(2);
		expect((response as { id: string }).id).toBe("resp-1");
	});

	test("throws on 400 without retry", async () => {
		let callCount = 0;
		const fetchMock = mock(async () => {
			callCount++;
			return errorResponse(
				400,
				JSON.stringify({ error: { message: "bad request" } }),
			);
		}) as unknown as typeof fetch;

		await expect(runStream(fetchMock)).rejects.toThrow(/400/);
		expect(callCount).toBe(1);
	});

	test("throws on 401 without retry", async () => {
		let callCount = 0;
		const fetchMock = mock(async () => {
			callCount++;
			return errorResponse(
				401,
				JSON.stringify({ error: { message: "unauthorized" } }),
			);
		}) as unknown as typeof fetch;

		await expect(runStream(fetchMock)).rejects.toThrow(/401/);
		expect(callCount).toBe(1);
	});
});
