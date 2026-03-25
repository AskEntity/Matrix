/**
 * Validating Mock Anthropic API for integration testing.
 *
 * Serves as both a response generator (instruction-driven) and a contract validator.
 * The mock reads JSON instructions from user messages to determine responses.
 * It validates every request for proper turn interleaving, tool_use/tool_result pairing, etc.
 *
 * ## Instruction Formats
 *
 * ### Single turn (backwards compatible):
 * ```json
 * {"blocks": [
 *   {"type": "text", "text": "Let me check."},
 *   {"type": "tool_use", "name": "mcp__opengraft__bash", "input": {"command": "echo hi"}}
 * ], "stop_reason": "tool_use"}
 * ```
 *
 * ### Multi-turn (scripts an entire conversation):
 * ```json
 * {"turns": [
 *   {"blocks": [{"type": "text", "text": "Let me check."}, {"type": "tool_use", "name": "mcp__opengraft__bash", "input": {"command": "echo hi"}}]},
 *   {"blocks": [{"type": "text", "text": "Done!"}, {"type": "tool_use", "name": "mcp__opengraft__done", "input": {"status": "passed", "summary": "ok"}}]}
 * ]}
 * ```
 *
 * Turn[0] is returned on the API call that contains the instruction.
 * Turn[1] is returned on the NEXT API call (e.g., containing tool_results).
 * If the queue is empty and no new instruction is found → default "Acknowledged." + end_turn.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages";

// ── Types ──

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

interface SingleTurnInstruction {
	blocks: InstructionBlock[];
	stop_reason?: "end_turn" | "tool_use";
}

interface MultiTurnInstruction {
	turns: SingleTurnInstruction[];
}

type MockInstruction = SingleTurnInstruction | MultiTurnInstruction;

interface ContentBlock {
	type: "text" | "tool_use";
	text?: string;
	id?: string;
	name?: string;
	input?: Record<string, unknown>;
}

export interface RequestRecord {
	messages: MessageParam[];
	system?: unknown;
	tools?: unknown;
	model?: string;
	timestamp: number;
}

// ── Validation ──

export class MockValidationError extends Error {
	status = 400;
	constructor(message: string) {
		super(message);
		this.name = "MockValidationError";
	}
}

function validateRequest(messages: MessageParam[]): void {
	if (messages.length === 0) {
		throw new MockValidationError("Messages array must not be empty");
	}

	// 1. First message must be user
	if (messages[0]?.role !== "user") {
		throw new MockValidationError(
			`First message must be role 'user', got '${messages[0]?.role}'`,
		);
	}

	// 2. Strict alternation: user/assistant/user/assistant...
	for (let i = 1; i < messages.length; i++) {
		const prev = messages[i - 1];
		const curr = messages[i];
		if (prev?.role === curr?.role) {
			throw new MockValidationError(
				`Messages must alternate roles. Found consecutive '${curr?.role}' at index ${i - 1} and ${i}`,
			);
		}
	}

	// 3. No empty content
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (!msg) continue;
		const content = msg.content;
		if (content === undefined || content === null) {
			throw new MockValidationError(`Message at index ${i} has empty content`);
		}
		if (typeof content === "string" && content.length === 0) {
			throw new MockValidationError(
				`Message at index ${i} has empty string content`,
			);
		}
		if (Array.isArray(content) && content.length === 0) {
			throw new MockValidationError(
				`Message at index ${i} has empty content array`,
			);
		}
	}

	// 4. tool_use/tool_result pairing
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (!msg || msg.role !== "assistant") continue;

		// Collect tool_use IDs from this assistant message
		const toolUseIds = new Set<string>();
		if (Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (
					block &&
					typeof block === "object" &&
					"type" in block &&
					block.type === "tool_use" &&
					"id" in block
				) {
					toolUseIds.add(block.id as string);
				}
			}
		}

		if (toolUseIds.size === 0) continue;

		// The immediately-following message must be a user message with matching tool_results
		const nextMsg = messages[i + 1];
		if (!nextMsg || nextMsg.role !== "user") {
			throw new MockValidationError(
				`Assistant message at index ${i} has tool_use but no following user message with tool_results`,
			);
		}

		const toolResultIds = new Set<string>();
		if (Array.isArray(nextMsg.content)) {
			for (const block of nextMsg.content) {
				if (
					block &&
					typeof block === "object" &&
					"type" in block &&
					block.type === "tool_result" &&
					"tool_use_id" in block
				) {
					const toolUseId = (block as { tool_use_id: string }).tool_use_id;
					if (toolResultIds.has(toolUseId)) {
						throw new MockValidationError(
							`Duplicate tool_result for tool_use_id '${toolUseId}' in message at index ${i + 1}`,
						);
					}
					toolResultIds.add(toolUseId);
				}
			}
		}

		// Every tool_use must have exactly one matching tool_result
		for (const id of toolUseIds) {
			if (!toolResultIds.has(id)) {
				throw new MockValidationError(
					`Missing tool_result for tool_use_id '${id}' (assistant at index ${i}, expected in user at index ${i + 1})`,
				);
			}
		}

		// No extra tool_results for tool_use IDs not in this assistant message
		for (const id of toolResultIds) {
			if (!toolUseIds.has(id)) {
				throw new MockValidationError(
					`Unexpected tool_result for tool_use_id '${id}' in message at index ${i + 1} — no matching tool_use in assistant at index ${i}`,
				);
			}
		}
	}
}

// ── Instruction parsing ──

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

/**
 * Try to parse a JSON instruction from text.
 * Looks for JSON objects both at the start of the text and embedded within it
 * (e.g., after timestamp prefixes or wrapper text from formatQueueMessage).
 */
function tryParseInstruction(text: string): MockInstruction | null {
	// First try: direct JSON parse of the whole text
	const trimmed = text.trim();
	if (trimmed.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmed);
			if (isMultiTurn(parsed) || isSingleTurn(parsed)) {
				return parsed;
			}
		} catch {
			// Not valid JSON — try embedded extraction below
		}
	}

	// Second try: find JSON objects embedded in the text.
	// The formatQueueMessage wrapper adds prefixes like:
	// "[Messages received while you were working:]\n[HH:MM:SS] {..."
	// We scan for '{' characters and try to parse from each position.
	let searchFrom = 0;
	while (searchFrom < text.length) {
		const braceIdx = text.indexOf("{", searchFrom);
		if (braceIdx === -1) break;

		// Try to find the matching closing brace by parsing from this position
		const candidate = text.slice(braceIdx);
		try {
			const parsed = JSON.parse(candidate);
			if (isMultiTurn(parsed) || isSingleTurn(parsed)) {
				return parsed;
			}
		} catch {
			// JSON.parse fails if there's trailing text after the object.
			// Try to find the end of the JSON object by counting braces.
		}

		// Brace-counting fallback: find the end of the JSON object
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
					const jsonStr = text.slice(braceIdx, i + 1);
					try {
						const parsed = JSON.parse(jsonStr);
						if (isMultiTurn(parsed) || isSingleTurn(parsed)) {
							return parsed;
						}
					} catch {
						// Not valid instruction JSON
					}
					break;
				}
			}
		}

		searchFrom = braceIdx + 1;
	}

	return null;
}

/**
 * Extract text content from a user message.
 * Handles both string and array content, skipping tool_result blocks.
 */
function extractUserTextBlocks(msg: MessageParam): string[] {
	const content = msg.content;
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];

	const texts: string[] = [];
	for (const block of content) {
		if (
			block &&
			typeof block === "object" &&
			"type" in block &&
			block.type === "text" &&
			"text" in block
		) {
			texts.push(block.text as string);
		}
	}
	return texts;
}

/** Extract instruction from user messages in the array. Searches from last to first. */
function extractInstruction(messages: MessageParam[]): MockInstruction | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg || msg.role !== "user") continue;

		const texts = extractUserTextBlocks(msg);
		// Search text blocks from last to first within the message
		for (let j = texts.length - 1; j >= 0; j--) {
			const text = texts[j];
			if (text) {
				const instruction = tryParseInstruction(text);
				if (instruction) return instruction;
			}
		}
		// Only check the last user message — don't search further back
		// (consumed instructions from earlier turns should already be in the queue)
		return null;
	}
	return null;
}

// ── Response building ──

let toolUseCounter = 0;

function buildResponseContent(turn: SingleTurnInstruction): {
	content: ContentBlock[];
	stopReason: "end_turn" | "tool_use";
} {
	const content: ContentBlock[] = [];
	let hasToolUse = false;

	for (const block of turn.blocks) {
		if (block.type === "text") {
			content.push({ type: "text", text: block.text });
		} else if (block.type === "tool_use") {
			hasToolUse = true;
			toolUseCounter++;
			content.push({
				type: "tool_use",
				id: `toolu_mock_${toolUseCounter.toString().padStart(4, "0")}`,
				name: block.name,
				input: block.input ?? {},
			});
		}
	}

	const stopReason = turn.stop_reason ?? (hasToolUse ? "tool_use" : "end_turn");
	return { content, stopReason };
}

function buildDefaultResponse(): {
	content: ContentBlock[];
	stopReason: "end_turn" | "tool_use";
} {
	return {
		content: [{ type: "text", text: "Acknowledged." }],
		stopReason: "end_turn",
	};
}

function buildCompactionResponse(): {
	content: ContentBlock[];
	stopReason: "end_turn" | "tool_use";
} {
	return {
		content: [
			{
				type: "text",
				text: `<summary>
<decisions>No significant decisions yet.</decisions>
<current_task>Mock compaction summary — context was compacted.</current_task>
<pending_work>Continue with the current task.</pending_work>
<key_facts>This is a mock compaction response for testing.</key_facts>
<working_state>Clean state after compaction.</working_state>
<open_questions>None.</open_questions>
<session_fatigue>Fresh start after compaction.</session_fatigue>
</summary>`,
			},
		],
		stopReason: "end_turn",
	};
}

/** Detect if this is a compaction request by checking for summarization instruction in messages. */
function isCompactionRequest(messages: MessageParam[]): boolean {
	const lastUser = [...messages].reverse().find((m) => m.role === "user");
	if (!lastUser) return false;
	const texts = extractUserTextBlocks(lastUser);
	const combined = texts.join(" ");
	return (
		combined.includes("Create a structured checkpoint") ||
		combined.includes("summarize the conversation") ||
		combined.includes("<summary>")
	);
}

// ── Mock stream ──

interface StreamEvent {
	type: string;
	index?: number;
	content_block?: unknown;
	delta?: unknown;
	message?: unknown;
	usage?: unknown;
}

function createMockAnthropicStream(
	content: ContentBlock[],
	stopReason: "end_turn" | "tool_use",
	model: string,
): {
	[Symbol.asyncIterator](): AsyncIterableIterator<StreamEvent>;
	finalMessage(): Promise<Anthropic.Messages.Message>;
} {
	const finalContent = content.map((block) => {
		if (block.type === "text") {
			return { type: "text" as const, text: block.text ?? "" };
		}
		return {
			type: "tool_use" as const,
			id: block.id ?? "",
			name: block.name ?? "",
			input: block.input ?? {},
		};
	});

	const message: Anthropic.Messages.Message = {
		id: `msg_mock_${Date.now()}`,
		type: "message",
		role: "assistant",
		model,
		content: finalContent,
		stop_reason: stopReason,
		stop_sequence: null,
		usage: {
			input_tokens: 100,
			output_tokens: 50,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
		},
	} as Anthropic.Messages.Message;

	// Build SSE-style stream events
	const events: StreamEvent[] = [];

	for (let i = 0; i < content.length; i++) {
		const block = content[i];
		if (!block) continue;

		if (block.type === "text") {
			events.push({
				type: "content_block_start",
				index: i,
				content_block: { type: "text", text: "" },
			});
			// Stream text in chunks to test the streaming path
			const text = block.text ?? "";
			const chunkSize = Math.max(1, Math.ceil(text.length / 3));
			for (let j = 0; j < text.length; j += chunkSize) {
				events.push({
					type: "content_block_delta",
					index: i,
					delta: { type: "text_delta", text: text.slice(j, j + chunkSize) },
				});
			}
			events.push({ type: "content_block_stop", index: i });
		} else if (block.type === "tool_use") {
			events.push({
				type: "content_block_start",
				index: i,
				content_block: {
					type: "tool_use",
					id: block.id,
					name: block.name,
					input: {},
				},
			});
			const inputJson = JSON.stringify(block.input ?? {});
			events.push({
				type: "content_block_delta",
				index: i,
				delta: { type: "input_json_delta", partial_json: inputJson },
			});
			events.push({ type: "content_block_stop", index: i });
		}
	}

	return {
		[Symbol.asyncIterator]: async function* () {
			for (const event of events) {
				yield event;
			}
		},
		finalMessage: () => Promise.resolve(message),
	};
}

// ── ValidatingMockAPI class ──

export class ValidatingMockAPI {
	private requestHistory: RequestRecord[] = [];
	/** Queued turns from multi-turn instructions. Consumed one per API call. */
	private turnQueue: SingleTurnInstruction[] = [];

	/**
	 * Creates a stream handler that replaces `client.messages.stream`.
	 * Validates the request, dequeues from turn queue or parses new instruction,
	 * and returns a streaming mock response.
	 */
	createStream(params: {
		messages: MessageParam[];
		system?: unknown;
		tools?: unknown;
		model?: string;
		max_tokens?: number;
		[key: string]: unknown;
	}): ReturnType<typeof createMockAnthropicStream> {
		const { messages, system, tools, model } = params;

		// Record the request
		this.requestHistory.push({
			messages: structuredClone(messages),
			system: system ? structuredClone(system) : undefined,
			tools: tools ? structuredClone(tools) : undefined,
			model,
			timestamp: Date.now(),
		});

		// Validate request structure
		validateRequest(messages);

		const modelName = (model as string) ?? "claude-sonnet-4-6";

		// Check for compaction request first
		if (isCompactionRequest(messages)) {
			const { content, stopReason } = buildCompactionResponse();
			return createMockAnthropicStream(content, stopReason, modelName);
		}

		// 1. Try to dequeue from the turn queue (from a previous multi-turn instruction)
		if (this.turnQueue.length > 0) {
			const turn = this.turnQueue.shift() as SingleTurnInstruction;
			const { content, stopReason } = buildResponseContent(turn);
			return createMockAnthropicStream(content, stopReason, modelName);
		}

		// 2. Try to parse a new instruction from the last user message
		const instruction = extractInstruction(messages);
		if (instruction) {
			if (isMultiTurn(instruction)) {
				// Multi-turn: return first turn now, queue the rest
				const [first, ...rest] = instruction.turns;
				this.turnQueue.push(...rest);
				if (first) {
					const { content, stopReason } = buildResponseContent(first);
					return createMockAnthropicStream(content, stopReason, modelName);
				}
			} else {
				// Single turn
				const { content, stopReason } = buildResponseContent(instruction);
				return createMockAnthropicStream(content, stopReason, modelName);
			}
		}

		// 3. Default response — no instruction found, turn queue empty
		const { content, stopReason } = buildDefaultResponse();
		return createMockAnthropicStream(content, stopReason, modelName);
	}

	/** Get all recorded requests. */
	getRequestHistory(): RequestRecord[] {
		return this.requestHistory;
	}

	/** Get the last recorded request. */
	getLastRequest(): RequestRecord | undefined {
		return this.requestHistory[this.requestHistory.length - 1];
	}

	/** Get the number of requests made. */
	getRequestCount(): number {
		return this.requestHistory.length;
	}

	/** How many turns are still queued (not yet consumed). */
	getPendingTurnCount(): number {
		return this.turnQueue.length;
	}

	/** Reset state between tests. */
	reset(): void {
		this.requestHistory = [];
		this.turnQueue = [];
		toolUseCounter = 0;
	}
}

/**
 * Create an AnthropicCompatibleProvider with the mock API wired in.
 * The mock replaces `client.messages.stream` — everything else (provider loop, tool
 * execution, event emission, JSONL persistence) uses real code.
 */
export function createMockedProviderWithMock(
	mockAPI: ValidatingMockAPI,
	model?: string,
) {
	// Lazy import to avoid circular dependencies
	const { AnthropicCompatibleProvider } =
		// biome-ignore lint/suspicious/noExplicitAny: dynamic import for test isolation
		require("../anthropic-compatible-provider.ts") as any;

	const savedKey = process.env.ANTHROPIC_API_KEY;
	process.env.ANTHROPIC_API_KEY = "test-key";
	const provider = new AnthropicCompatibleProvider(
		model ?? "claude-sonnet-4-6",
	);
	process.env.ANTHROPIC_API_KEY = savedKey;

	// Replace the client's messages.stream with our mock
	// biome-ignore lint/suspicious/noExplicitAny: replacing internal client for testing
	(provider as any).client = {
		messages: {
			stream: (params: Parameters<typeof mockAPI.createStream>[0]) =>
				mockAPI.createStream(params),
			countTokens: async () => ({ input_tokens: 100 }),
		},
	};

	return provider;
}
