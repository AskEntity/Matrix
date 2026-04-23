import type { AgentProvider } from "../agent-provider.ts";
import { OpenAIResponsesCompatibleProvider } from "../openai-responses-compatible-provider.ts";

let currentFetchMock: ValidatingMockResponsesAPI | null = null;
let originalFetch: typeof globalThis.fetch | null = null;

interface TextBlock {
	type: "text";
	text: string;
}

interface ToolUseBlock {
	type: "tool_use";
	name: string;
	input: Record<string, unknown>;
}

type InstructionBlock = TextBlock | ToolUseBlock;

interface BlockAssertRule {
	block: number;
	type?: "tool_result" | "text";
	contains?: string;
	notContains?: string;
	isError?: boolean;
	matches?: string;
}

interface LengthAssertRule {
	length: number;
}

type AssertRule = BlockAssertRule | LengthAssertRule;

interface SingleTurnInstruction {
	blocks: InstructionBlock[];
	assert?: AssertRule[];
}

interface MultiTurnInstruction {
	turns: SingleTurnInstruction[];
}

type MockInstruction = SingleTurnInstruction | MultiTurnInstruction;

export interface ResponsesRequestRecord {
	body: Record<string, unknown>;
	headers: Record<string, string>;
	timestamp: number;
}

export class MockResponsesValidationError extends Error {
	status = 400;
	constructor(message: string) {
		super(message);
		this.name = "MockResponsesValidationError";
	}
}

const KNOWN_RESPONSE_FIELDS = new Set([
	"model",
	"instructions",
	"input",
	"tools",
	"stream",
	"store",
	"max_output_tokens",
	"include",
]);

function isMultiTurn(parsed: unknown): parsed is MultiTurnInstruction {
	return (
		parsed != null &&
		typeof parsed === "object" &&
		"turns" in parsed &&
		Array.isArray((parsed as MultiTurnInstruction).turns)
	);
}

function isSingleTurn(parsed: unknown): parsed is SingleTurnInstruction {
	return (
		parsed != null &&
		typeof parsed === "object" &&
		"blocks" in parsed &&
		Array.isArray((parsed as SingleTurnInstruction).blocks)
	);
}

function tryParseInstruction(text: string): MockInstruction | null {
	const trimmed = text.trim();
	if (trimmed.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmed);
			if (isMultiTurn(parsed) || isSingleTurn(parsed)) return parsed;
		} catch {}
	}

	let searchFrom = 0;
	while (searchFrom < text.length) {
		const braceIdx = text.indexOf("{", searchFrom);
		if (braceIdx === -1) break;
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (let i = braceIdx; i < text.length; i++) {
			const ch = text[i];
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === '"') {
				inString = !inString;
				continue;
			}
			if (inString) continue;
			if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					try {
						const parsed = JSON.parse(text.slice(braceIdx, i + 1));
						if (isMultiTurn(parsed) || isSingleTurn(parsed)) return parsed;
					} catch {}
					break;
				}
			}
		}
		searchFrom = braceIdx + 1;
	}

	return null;
}

function eventDataLine(data: unknown): string {
	return `data: ${JSON.stringify(data)}\n`;
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
			return `event: ${event}\n${eventDataLine(enriched)}\n`;
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
	usage?: Record<string, unknown>;
}): Record<string, unknown> {
	return {
		id: overrides.id ?? "resp-1",
		object: "response",
		status: "completed",
		output: overrides.output ?? [],
		output_text: "",
		usage: overrides.usage ?? {
			input_tokens: 10,
			output_tokens: 5,
			total_tokens: 15,
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
	};
}

function deepEqual(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

export class ValidatingMockResponsesAPI {
	private requestHistory: ResponsesRequestRecord[] = [];
	private conversationQueues = new Map<string, SingleTurnInstruction[]>();
	private prefixValidationEnabled = false;

	private validateBody(body: Record<string, unknown>): void {
		for (const key of Object.keys(body)) {
			if (!KNOWN_RESPONSE_FIELDS.has(key)) {
				throw new MockResponsesValidationError(
					`${key}: Extra inputs are not permitted. Known fields: ${[...KNOWN_RESPONSE_FIELDS].join(", ")}`,
				);
			}
		}
		if (typeof body.model !== "string" || body.model.length === 0) {
			throw new MockResponsesValidationError(
				"model must be a non-empty string",
			);
		}
		if (typeof body.instructions !== "string") {
			throw new MockResponsesValidationError("instructions must be a string");
		}
		if (!Array.isArray(body.input) || body.input.length === 0) {
			throw new MockResponsesValidationError("input must be a non-empty array");
		}
		if (!Array.isArray(body.tools)) {
			throw new MockResponsesValidationError("tools must be an array");
		}
		if (body.stream !== true) {
			throw new MockResponsesValidationError("stream must be true");
		}
		if (body.store !== false) {
			throw new MockResponsesValidationError("store must be false");
		}
	}

	private getConversationKey(body: Record<string, unknown>): string {
		const input = body.input;
		if (!Array.isArray(input)) {
			throw new MockResponsesValidationError("input must be an array");
		}
		for (const item of input) {
			if (!item || typeof item !== "object") continue;
			const record = item as Record<string, unknown>;
			if (record.type !== "message" || record.role !== "user") continue;
			for (const text of this.extractTextFromInputItem(item)) {
				if (tryParseInstruction(text)) return text;
			}
		}
		const instructions = body.instructions;
		if (typeof instructions !== "string") {
			throw new MockResponsesValidationError("instructions must be a string");
		}
		return instructions;
	}

	private extractTextFromInputItem(item: unknown): string[] {
		if (!item || typeof item !== "object") return [];
		const itemRecord = item as Record<string, unknown>;
		const content = itemRecord.content;
		if (typeof content === "string") return [content];
		if (!Array.isArray(content)) return [];
		const texts: string[] = [];
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const partRecord = part as Record<string, unknown>;
			if (
				(partRecord.type === "input_text" || partRecord.type === "text") &&
				typeof partRecord.text === "string"
			) {
				texts.push(partRecord.text);
			}
		}
		return texts;
	}

	private extractInstruction(
		body: Record<string, unknown>,
	): MockInstruction | null {
		const input = body.input;
		if (!Array.isArray(input)) return null;
		for (let i = input.length - 1; i >= 0; i--) {
			const item = input[i];
			const texts = this.extractTextFromInputItem(item);
			for (let j = texts.length - 1; j >= 0; j--) {
				const instruction = tryParseInstruction(texts[j] ?? "");
				if (instruction) return instruction;
			}
		}
		return null;
	}

	private extractContentBlocks(body: Record<string, unknown>): Array<{
		type: string;
		content: string;
		isError: boolean;
	}> {
		const input = body.input;
		if (!Array.isArray(input)) return [];
		const lastItem = input[input.length - 1];
		if (!lastItem || typeof lastItem !== "object") return [];
		const itemRecord = lastItem as Record<string, unknown>;
		const contents = itemRecord.content;
		if (!Array.isArray(contents)) return [];

		const blocks: Array<{ type: string; content: string; isError: boolean }> =
			[];
		for (const block of contents) {
			if (!block || typeof block !== "object") continue;
			const blockRecord = block as Record<string, unknown>;
			if (
				blockRecord.type === "input_text" &&
				typeof blockRecord.text === "string"
			) {
				blocks.push({
					type: "text",
					content: blockRecord.text,
					isError: false,
				});
			}
			if (
				blockRecord.type === "function_call_output" &&
				typeof blockRecord.output === "string"
			) {
				blocks.push({
					type: "tool_result",
					content: blockRecord.output,
					isError: false,
				});
			}
		}
		return blocks;
	}

	private validateAsserts(
		asserts: AssertRule[],
		body: Record<string, unknown>,
	): void {
		const contentBlocks = this.extractContentBlocks(body);
		for (const rule of asserts) {
			if ("length" in rule) {
				if (contentBlocks.length !== rule.length) {
					throw new MockResponsesValidationError(
						`Assert failed: expected ${rule.length} content blocks, found ${contentBlocks.length}`,
					);
				}
				continue;
			}
			const block = contentBlocks[rule.block];
			if (!block) {
				throw new MockResponsesValidationError(
					`Assert failed: no content block at index ${rule.block} (only ${contentBlocks.length} blocks found)`,
				);
			}
			if (rule.type !== undefined && block.type !== rule.type) {
				throw new MockResponsesValidationError(
					`Assert failed: block[${rule.block}] has type "${block.type}", expected "${rule.type}"`,
				);
			}
			if (
				rule.contains !== undefined &&
				!block.content.includes(rule.contains)
			) {
				throw new MockResponsesValidationError(
					`Assert failed: block[${rule.block}] does not contain "${rule.contains}".\nContent: ${block.content}`,
				);
			}
			if (
				rule.notContains !== undefined &&
				block.content.includes(rule.notContains)
			) {
				throw new MockResponsesValidationError(
					`Assert failed: block[${rule.block}] contains "${rule.notContains}" but should not.\nContent: ${block.content}`,
				);
			}
			if (rule.isError !== undefined && block.isError !== rule.isError) {
				throw new MockResponsesValidationError(
					`Assert failed: block[${rule.block}] isError=${block.isError}, expected ${rule.isError}`,
				);
			}
			if (
				rule.matches !== undefined &&
				!new RegExp(rule.matches).test(block.content)
			) {
				throw new MockResponsesValidationError(
					`Assert failed: block[${rule.block}] does not match /${rule.matches}/.\nContent: ${block.content}`,
				);
			}
		}
	}

	private validatePrefix(body: Record<string, unknown>): void {
		if (this.requestHistory.length < 2) return;
		const prev = this.requestHistory[this.requestHistory.length - 2];
		if (!prev) return;
		if (this.getConversationKey(prev.body) !== this.getConversationKey(body))
			return;
		if (!deepEqual(prev.body.instructions, body.instructions)) {
			throw new MockResponsesValidationError(
				"instructions changed between API calls for the same conversation",
			);
		}
		if (!deepEqual(prev.body.tools, body.tools)) {
			throw new MockResponsesValidationError(
				"tools changed between API calls for the same conversation",
			);
		}
		const prevInput = prev.body.input;
		const currInput = body.input;
		if (!Array.isArray(prevInput) || !Array.isArray(currInput)) return;
		if (currInput.length < prevInput.length) {
			throw new MockResponsesValidationError(
				`Prefix violation: current request has ${currInput.length} input items, previous had ${prevInput.length}`,
			);
		}
		for (let i = 0; i < prevInput.length; i++) {
			if (!deepEqual(prevInput[i], currInput[i])) {
				throw new MockResponsesValidationError(
					`Prefix violation at input index ${i}`,
				);
			}
		}
	}

	private buildTurnResponse(turn: SingleTurnInstruction): Response {
		const events: Array<{ event: string; data: unknown }> = [
			{
				event: "response.created",
				data: { response: { id: "resp-1", status: "in_progress" } },
			},
		];
		// Build the final output array for response.completed
		const outputItems: unknown[] = [];

		turn.blocks.forEach((block, index) => {
			if (block.type === "text") {
				const msgItem = {
					type: "message",
					id: `msg-${index}`,
					role: "assistant",
					content: [{ type: "output_text", text: block.text, annotations: [] }],
					status: "completed",
				};
				events.push({
					event: "response.output_item.added",
					data: { output_index: index, item: msgItem },
				});
				events.push({
					event: "response.content_part.added",
					data: {
						output_index: index,
						item_id: `msg-${index}`,
						part: { type: "output_text", text: block.text },
					},
				});
				// Emit the text delta — real Responses API streams the full output_text
				// via one or more `response.output_text.delta` events between
				// content_part.added and content_part.done. We emit a single delta
				// carrying the whole text (tests don't need per-token granularity).
				events.push({
					event: "response.output_text.delta",
					data: {
						output_index: index,
						item_id: `msg-${index}`,
						delta: block.text,
					},
				});
				outputItems.push(msgItem);
			} else {
				const args = JSON.stringify(block.input);
				const fcItem = {
					type: "function_call",
					id: `call-${index}`,
					call_id: `call-${index}`,
					name: block.name,
					arguments: args,
					status: "completed",
				};
				events.push({
					event: "response.output_item.added",
					data: { output_index: index, item: fcItem },
				});
				events.push({
					event: "response.function_call_arguments.done",
					data: {
						output_index: index,
						item_id: `call-${index}`,
						name: block.name,
						arguments: args,
					},
				});
				outputItems.push(fcItem);
			}
		});

		// Build output_text from text blocks
		const outputText = turn.blocks
			.filter((b) => b.type === "text")
			.map((b) => (b as TextBlock).text)
			.join("\n");

		const completedResponse = mockOAIResponse({ output: outputItems });
		completedResponse.output_text = outputText;

		events.push({
			event: "response.completed",
			data: { response: completedResponse },
		});
		return sseResponse(events);
	}

	async handleFetch(
		url: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> {
		const urlStr =
			typeof url === "string"
				? url
				: url instanceof URL
					? url.toString()
					: url.url;
		if (urlStr.endsWith("/models")) {
			return new Response(
				JSON.stringify({
					data: [{ id: "gpt-4.1-mini", context_length: 1_047_576 }],
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		}
		if (!urlStr.endsWith("/responses")) {
			throw new MockResponsesValidationError(`Unexpected URL: ${urlStr}`);
		}
		const bodyText = typeof init?.body === "string" ? init.body : "";
		const body = JSON.parse(bodyText) as Record<string, unknown>;
		const headers = new Headers(init?.headers);
		const headerRecord = Object.fromEntries(headers.entries());
		this.validateBody(body);
		this.requestHistory.push({
			body: structuredClone(body),
			headers: headerRecord,
			timestamp: Date.now(),
		});
		if (this.prefixValidationEnabled) this.validatePrefix(body);

		const convKey = this.getConversationKey(body);
		const queued = this.conversationQueues.get(convKey);
		if (queued && queued.length > 0) {
			const turn = queued.shift();
			if (queued.length === 0) this.conversationQueues.delete(convKey);
			if (turn?.assert?.length) this.validateAsserts(turn.assert, body);
			return this.buildTurnResponse(turn as SingleTurnInstruction);
		}

		const instruction = this.extractInstruction(body);
		if (instruction) {
			if (isMultiTurn(instruction)) {
				const [first, ...rest] = instruction.turns;
				if (rest.length > 0) this.conversationQueues.set(convKey, rest);
				return this.buildTurnResponse(first as SingleTurnInstruction);
			}
			return this.buildTurnResponse(instruction);
		}

		return this.buildTurnResponse({
			blocks: [{ type: "text", text: "Acknowledged." }],
		});
	}

	getRequestHistory(): ResponsesRequestRecord[] {
		return this.requestHistory;
	}

	getRequestCount(): number {
		return this.requestHistory.length;
	}

	enablePrefixValidation(): void {
		this.prefixValidationEnabled = true;
	}
}

export function createMockedResponsesProviderWithMock(
	mockAPI: ValidatingMockResponsesAPI,
	model = "gpt-4.1-mini",
): AgentProvider {
	if (originalFetch === null) {
		originalFetch = globalThis.fetch;
	}
	currentFetchMock = mockAPI;
	globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
		if (currentFetchMock === null) {
			throw new Error("Responses fetch mock not installed");
		}
		return currentFetchMock.handleFetch(url, init);
	}) as typeof fetch;

	return new OpenAIResponsesCompatibleProvider(model, {
		apiKey: "test-key",
		baseUrl: "https://api.example.com/v1",
	});
}

export function restoreMockedResponsesFetch(): void {
	if (originalFetch !== null) {
		globalThis.fetch = originalFetch;
	}
	currentFetchMock = null;
	originalFetch = null;
}
