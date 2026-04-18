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
 *   {"type": "tool_use", "name": "mcp__mxd__bash", "input": {"command": "echo hi"}}
 * ], "stop_reason": "tool_use"}
 * ```
 *
 * ### Multi-turn (scripts an entire conversation):
 * ```json
 * {"turns": [
 *   {"blocks": [{"type": "text", "text": "Let me check."}, {"type": "tool_use", "name": "mcp__mxd__bash", "input": {"command": "echo hi"}}]},
 *   {"blocks": [{"type": "text", "text": "Done!"}, {"type": "tool_use", "name": "mcp__mxd__done", "input": {"status": "passed", "summary": "ok"}}]}
 * ]}
 * ```
 *
 * Turn[0] is returned on the API call that contains the instruction.
 * Turn[1] is returned on the NEXT API call (e.g., containing tool_results).
 * If the queue is empty and no new instruction is found → default "Acknowledged." + end_turn.
 *
 * ### Assert DSL
 * Turns can have `assert` arrays that validate content blocks from the previous turn's user message:
 * ```json
 * {"assert": [
 *   {"block": 0, "type": "tool_result", "contains": "hello"},
 *   {"block": 1, "type": "text", "contains": "injected_msg"}
 * ]}
 * ```
 * `block` indexes into the full content array (all blocks, not just tool_results).
 * `type` optionally validates the block type. `isError` only valid for tool_result blocks.
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

interface ThinkingInstructionBlock {
	type: "thinking";
	thinking: string;
	signature: string;
}

type InstructionBlock = TextBlock | ToolUseBlock | ThinkingInstructionBlock;

// ── Assert DSL types ──

interface BlockAssertRule {
	/** Index into the user message's content array (all blocks, not just tool_results). */
	block: number;
	/** Expected block type. If specified, validates the block has this type. */
	type?: "tool_result" | "text";
	/** Content must contain this string. */
	contains?: string;
	/** Content must NOT contain this string. */
	notContains?: string;
	/** Check the isError flag on the tool_result block. Only valid when type is "tool_result". */
	isError?: boolean;
	/** Content must match this regex. */
	matches?: string;
	/** Capture named values from content via regex groups. Key = var name, value = "regex:(group)". */
	capture?: Record<string, string>;
}

interface LengthAssertRule {
	/** Validates the user message has exactly this many content blocks. */
	length: number;
}

type AssertRule = BlockAssertRule | LengthAssertRule;

interface SingleTurnInstruction {
	blocks: InstructionBlock[];
	stop_reason?: "end_turn" | "tool_use";
	/** Assert rules to validate tool_results from the previous turn before returning this turn's response. */
	assert?: AssertRule[];
	/** Delay in milliseconds before emitting the first stream event. Used to simulate slow API responses. */
	delay_ms?: number;
}

interface MultiTurnInstruction {
	turns: SingleTurnInstruction[];
}

type MockInstruction = SingleTurnInstruction | MultiTurnInstruction;

interface ContentBlock {
	type: "text" | "tool_use" | "thinking";
	text?: string;
	id?: string;
	name?: string;
	input?: Record<string, unknown>;
	thinking?: string;
	signature?: string;
}

export interface RequestRecord {
	messages: MessageParam[];
	system?: unknown;
	tools?: unknown;
	model?: string;
	timestamp: number;
	/** Session ID from provider — used as conversation key for turn queuing and prefix validation. */
	sessionId?: string;
}

// ── Validation ──

export class MockValidationError extends Error {
	status = 400;
	constructor(message: string) {
		super(message);
		this.name = "MockValidationError";
	}
}

// ── API field validation ──
// Mirrors the real Anthropic API's strict field validation.
// Unknown fields → 400 "Extra inputs are not permitted" (same as production).
const KNOWN_API_FIELDS = new Set([
	"cache_control",
	"container",
	"context_management",
	"inference_geo",
	"max_tokens",
	"messages",
	"metadata",
	"model",
	"output_config",
	"service_tier",
	"stop_sequences",
	"stream",
	"system",
	"temperature",
	"thinking",
	"tool_choice",
	"tools",
	"top_k",
	"top_p",
]);

const KNOWN_METADATA_FIELDS = new Set(["user_id"]);

function validateAPIFields(params: Record<string, unknown>): void {
	for (const key of Object.keys(params)) {
		if (!KNOWN_API_FIELDS.has(key)) {
			throw new MockValidationError(
				`${key}: Extra inputs are not permitted. ` +
					`Known fields: ${[...KNOWN_API_FIELDS].join(", ")}`,
			);
		}
	}
	// Validate metadata sub-fields
	if (params.metadata && typeof params.metadata === "object") {
		for (const key of Object.keys(params.metadata as Record<string, unknown>)) {
			if (!KNOWN_METADATA_FIELDS.has(key)) {
				throw new MockValidationError(
					`metadata.${key}: Extra inputs are not permitted. ` +
						`Allowed metadata fields: ${[...KNOWN_METADATA_FIELDS].join(", ")}`,
				);
			}
		}
	}
}

import type { CacheTtl } from "../config.ts";

/** Numeric TTL rank for ordering: no ttl field (5m default) = 5, "5m" = 5, "1h" = 60. */
function ttlRank(ttl: CacheTtl | undefined): number {
	if (ttl === "1h") return 60;
	return 5; // undefined or "5m" = 5 min
}

/**
 * Extract the highest cache_control TTL from an array of blocks/objects.
 */
function extractMaxTtl(items: unknown[] | undefined): CacheTtl | undefined {
	if (!items) return undefined;
	let maxRank = 0;
	let result: CacheTtl | undefined;
	for (const item of items) {
		const cc = (item as Record<string, unknown>)?.cache_control as
			| { type?: string; ttl?: CacheTtl }
			| undefined;
		if (cc) {
			const rank = ttlRank(cc.ttl);
			if (rank > maxRank) {
				maxRank = rank;
				result = cc.ttl;
			}
		}
	}
	return maxRank > 0 ? result : undefined;
}

/**
 * Validate cache_control TTL non-increasing order: tools → system → messages.
 * Anthropic requires TTLs in non-increasing order across the prefix.
 */
function validateCacheTtlOrder(
	tools: unknown[] | undefined,
	system: unknown[] | string | undefined,
	messages: MessageParam[],
): void {
	const toolsTtl = extractMaxTtl(tools);
	// system can be a string or an array of blocks
	const systemBlocks = Array.isArray(system) ? system : undefined;
	const systemTtl = extractMaxTtl(systemBlocks);
	const allMsgBlocks: unknown[] = [];
	for (const msg of messages) {
		if (Array.isArray(msg.content)) {
			allMsgBlocks.push(...msg.content);
		}
	}
	const msgTtl = extractMaxTtl(allMsgBlocks);

	// Only validate if at least one layer has cache_control
	const hasAnyCacheControl =
		toolsTtl !== undefined || systemTtl !== undefined || msgTtl !== undefined;
	if (!hasAnyCacheControl) return;

	// Layers without cache_control impose no constraint (POSITIVE_INFINITY = "any TTL is fine")
	const toolsRank =
		toolsTtl !== undefined ? ttlRank(toolsTtl) : Number.POSITIVE_INFINITY;
	const systemRank =
		systemTtl !== undefined ? ttlRank(systemTtl) : Number.POSITIVE_INFINITY;
	const msgRank = msgTtl !== undefined ? ttlRank(msgTtl) : 0;

	if (toolsRank < systemRank) {
		throw new MockValidationError(
			`Cache TTL ordering violation: tools TTL (${toolsTtl ?? "5m"}) < system TTL (${systemTtl ?? "5m"}). ` +
				"Anthropic requires non-increasing TTL order: tools ≥ system ≥ messages.",
		);
	}
	if (systemRank < msgRank) {
		throw new MockValidationError(
			`Cache TTL ordering violation: system TTL (${systemTtl ?? "5m"}) < messages TTL (${msgTtl ?? "5m"}). ` +
				"Anthropic requires non-increasing TTL order: tools ≥ system ≥ messages.",
		);
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
	// Queue messages are formatted with timestamp prefix like "[HH:MM:SS] {..."
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
		} else if (block.type === "thinking") {
			content.push({
				type: "thinking",
				thinking: block.thinking,
				signature: block.signature,
			});
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
	// Match the actual SUMMARIZATION_INSTRUCTION signature — NOT just "<summary>" which
	// also appears in compacted content (checkpoint includes <summary>...</summary> tags).
	return (
		combined.includes("Context compression required") ||
		combined.includes("Create a structured checkpoint") ||
		combined.includes("summarize the conversation")
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
	delayMs?: number,
): {
	[Symbol.asyncIterator](): AsyncIterableIterator<StreamEvent>;
	finalMessage(): Promise<Anthropic.Messages.Message>;
} {
	const finalContent = content.map((block) => {
		if (block.type === "text") {
			return { type: "text" as const, text: block.text ?? "" };
		}
		if (block.type === "thinking") {
			return {
				type: "thinking" as const,
				thinking: block.thinking ?? "",
				signature: block.signature ?? "",
			};
		}
		return {
			type: "tool_use" as const,
			id: block.id ?? "",
			name: block.name ?? "",
			input: block.input ?? {},
			caller: { type: "direct" as const },
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

		if (block.type === "thinking") {
			events.push({
				type: "content_block_start",
				index: i,
				content_block: {
					type: "thinking",
					thinking: "",
					signature: "",
				},
			});
			// Stream thinking in chunks
			const thinking = block.thinking ?? "";
			const chunkSize = Math.max(1, Math.ceil(thinking.length / 3));
			for (let j = 0; j < thinking.length; j += chunkSize) {
				events.push({
					type: "content_block_delta",
					index: i,
					delta: {
						type: "thinking_delta",
						thinking: thinking.slice(j, j + chunkSize),
					},
				});
			}
			// Signature delta at the end
			events.push({
				type: "content_block_delta",
				index: i,
				delta: {
					type: "signature_delta",
					signature: block.signature ?? "",
				},
			});
			events.push({ type: "content_block_stop", index: i });
		} else if (block.type === "text") {
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
					caller: { type: "direct" },
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
			if (delayMs != null && delayMs > 0) {
				await new Promise((r) => setTimeout(r, delayMs));
			}
			for (const event of events) {
				yield event;
			}
		},
		finalMessage: () => Promise.resolve(message),
	};
}

// ── Prefix validation helpers ──

/**
 * Extract the message-level cache_control value from a request's messages.
 * This is the "last" cache_control marker — placed on the second-to-last user message.
 * Its position moves between turns (as new messages are added), but its VALUE must stay
 * consistent across requests in the same conversation.
 *
 * Returns the JSON-serialized cache_control value, or null if no message has one.
 */
function extractMessageCacheControl(messages?: unknown[]): string | null {
	if (!Array.isArray(messages)) return null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg && typeof msg === "object") {
			const content = (msg as Record<string, unknown>).content;
			if (Array.isArray(content)) {
				for (const block of content) {
					if (block && typeof block === "object") {
						const cc = (block as Record<string, unknown>).cache_control;
						if (cc) return JSON.stringify(cc);
					}
				}
			}
		}
	}
	return null;
}

/**
 * Normalize message content for comparison.
 * - Normalizes string content to array form: "text" → [{type: "text", text: "text"}]
 * - When stripCC=true, strips `cache_control` from content blocks.
 *
 * Note: `caller` is NOT stripped — the mock now includes it (matching real API),
 * and our JSONL reconstruction includes it too. If they ever diverge, that's a
 * real bug we want prefix validation to catch.
 */
function normalizeContent(content: unknown, stripCC = false): unknown {
	if (typeof content === "string") {
		return [{ type: "text", text: content }];
	}
	if (Array.isArray(content)) {
		return content.map((block) => {
			if (block && typeof block === "object") {
				if (stripCC) {
					const { cache_control: _, ...rest } = block as Record<
						string,
						unknown
					>;
					return rest;
				}
				return { ...(block as Record<string, unknown>) };
			}
			return block;
		});
	}
	return content;
}

/**
 * Deep equality check for Anthropic message objects.
 * Normalizes content (converts string to array form).
 * When stripCC=true, also strips cache_control from content blocks.
 */
function deepEqualMessage(
	a: MessageParam | undefined,
	b: MessageParam | undefined,
	stripCC = false,
): boolean {
	if (a === b) return true;
	if (a == null || b == null) return false;
	if (a.role !== b.role) return false;

	const aNorm = normalizeContent(a.content, stripCC);
	const bNorm = normalizeContent(b.content, stripCC);
	return deepEqualContent(aNorm, bNorm);
}

/**
 * Find the message index that has the message-level cache_control breakpoint.
 * This is the "last marker" — placed on the second-to-last user message.
 * Returns -1 if no message has cache_control.
 */
function findMessageCacheControlIndex(messages: MessageParam[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg && typeof msg === "object") {
			const content = msg.content;
			if (Array.isArray(content)) {
				for (const block of content) {
					if (
						block &&
						typeof block === "object" &&
						// biome-ignore lint/suspicious/noExplicitAny: checking cache_control on varied block types
						(block as any).cache_control
					) {
						return i;
					}
				}
			}
		}
	}
	return -1;
}

function deepEqualContent(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a == null || b == null) return a === b;
	if (typeof a !== typeof b) return false;

	if (typeof a === "string") return a === b;

	if (Array.isArray(a)) {
		if (!Array.isArray(b)) return false;
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (!deepEqualContent(a[i], b[i])) return false;
		}
		return true;
	}

	if (typeof a === "object") {
		const aObj = a as Record<string, unknown>;
		const bObj = b as Record<string, unknown>;
		const aKeys = Object.keys(aObj).sort();
		const bKeys = Object.keys(bObj).sort();
		if (aKeys.length !== bKeys.length) return false;
		for (let i = 0; i < aKeys.length; i++) {
			if (aKeys[i] !== bKeys[i]) return false;
			const key = aKeys[i] as string;
			if (!deepEqualContent(aObj[key], bObj[key])) return false;
		}
		return true;
	}

	return a === b;
}

/**
 * JSON replacer that abbreviates long content fields for error messages.
 * Shows first 120 chars of long strings.
 */
function abbreviateContent(_key: string, value: unknown): unknown {
	if (typeof value === "string" && value.length > 120) {
		return `${value.slice(0, 120)}... (${value.length} chars)`;
	}
	return value;
}

// ── Error injection types ──

export type InjectedErrorType =
	| "rate_limit"
	| "overloaded"
	| "internal_server_error"
	| "connection_error"
	| "invalid_request_error";

export interface ErrorInjection {
	/** Which API call number to fail on (1-based). */
	onRequest: number;
	/** Type of error to simulate. */
	error: InjectedErrorType;
	/** How many consecutive calls to fail before allowing success. Default: 1. */
	count?: number;
}

/**
 * Transient API error for testing. NOT an Anthropic SDK error class, so it
 * bypasses the inner retry's `instanceof` checks and throws immediately.
 * The outer retry in runProviderLoop detects it via the `status` property.
 */
export class TransientAPIError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "TransientAPIError";
		this.status = status;
	}
}

function makeInjectedError(errorType: InjectedErrorType): Error {
	// Use TransientAPIError (not Anthropic SDK classes) so the inner retry in
	// callAPI does NOT recognize these as transient → throws immediately.
	// The outer retry in runProviderLoop catches them via status code check.
	// This avoids 30s of inner retry delays in tests.
	switch (errorType) {
		case "rate_limit":
			return new TransientAPIError(429, "Rate limit exceeded");
		case "overloaded":
			return new TransientAPIError(529, "Overloaded");
		case "internal_server_error":
			return new TransientAPIError(500, "Internal server error");
		case "connection_error":
			return new TransientAPIError(0, "Connection error: ECONNREFUSED");
		case "invalid_request_error":
			return new TransientAPIError(
				400,
				"messages: each tool_use must have a single result",
			);
	}
}

// ── Strict tool-error allowlist ──

/**
 * An entry in the strict-tool-errors allowlist. A tool_result with
 * `is_error: true` is "allowed" if at least one allowlist entry matches both
 * `tool` (empty / "*" matches any) AND `contains` (empty matches any content).
 */
export interface AllowedToolError {
	/** Tool name (e.g. "mcp__mxd__bash"). Omit or "*" for any tool. */
	tool?: string;
	/** Substring the error content must contain. Omit to match any content. */
	contains?: string;
}

// ── ValidatingMockAPI class ──

export class ValidatingMockAPI {
	private requestHistory: RequestRecord[] = [];
	/**
	 * Per-conversation turn queues. Keyed by conversation ID (derived from first user message).
	 * When parent and child agents share the same mock, their turns don't interfere.
	 */
	private conversationQueues: Map<string, SingleTurnInstruction[]> = new Map();
	/** When enabled, validates messages are strictly monotonically increasing across API calls. */
	private prefixValidationEnabled = false;
	/**
	 * When enabled, every tool_result with `is_error: true` that appears in a
	 * request's user message content must match an entry in `toolErrorAllowlist`.
	 * Unsurfaced errors throw MockValidationError so tests fail loudly instead
	 * of silently swallowing bugs in tool handlers.
	 */
	private strictToolErrorsEnabled = false;
	private toolErrorAllowlist: AllowedToolError[] = [];
	/** Variables captured from tool results via assert capture rules. */
	private capturedVars: Map<string, string> = new Map();
	/** Error injections — keyed by request number (1-based), value = remaining fail count. */
	private errorInjections: Map<
		number,
		{ error: InjectedErrorType; remaining: number }
	> = new Map();

	/**
	 * Derive a stable conversation key from the messages array.
	 * Uses the first user message's text content as the key — this is unique per conversation
	 * and stable across API calls (the first message never changes).
	 *
	 * For forked agents: the message history starts with the source agent's messages,
	 * so the first user message is the same as the parent's. To distinguish them,
	 * we detect the fork tool_result ("You are the CHILD") and use the first user
	 * message AFTER that fork point as the key.
	 */
	private getConversationKey(
		_messages: MessageParam[],
		sessionId?: string,
	): string {
		if (!sessionId) {
			throw new MockValidationError(
				"sessionId is required — provider must set client._currentSessionId before stream call. " +
					"All API calls must have a session identity for conversation keying.",
			);
		}
		return `session:${sessionId}`;
	}

	/**
	 * Extract all content blocks from the last user message in the request.
	 * Returns them in order with their type and normalized text content.
	 */
	private extractContentBlocks(messages: MessageParam[]): Array<{
		type: string;
		content: string;
		isError: boolean;
		tool_use_id?: string;
	}> {
		const lastUser = [...messages].reverse().find((m) => m.role === "user");
		if (!lastUser) return [];

		// Handle string content
		if (typeof lastUser.content === "string") {
			return [{ type: "text", content: lastUser.content, isError: false }];
		}

		if (!Array.isArray(lastUser.content)) return [];

		const blocks: Array<{
			type: string;
			content: string;
			isError: boolean;
			tool_use_id?: string;
		}> = [];
		for (const block of lastUser.content) {
			if (!block || typeof block !== "object" || !("type" in block)) continue;

			if (block.type === "tool_result") {
				const tr = block as {
					tool_use_id: string;
					content?: string | unknown[];
					is_error?: boolean;
				};
				// Normalize content to string
				let contentStr = "";
				if (typeof tr.content === "string") {
					contentStr = tr.content;
				} else if (Array.isArray(tr.content)) {
					contentStr = tr.content
						.map((c) =>
							c && typeof c === "object" && "text" in c
								? (c as { text: string }).text
								: "",
						)
						.join("");
				}
				blocks.push({
					type: "tool_result",
					content: contentStr,
					isError: tr.is_error ?? false,
					tool_use_id: tr.tool_use_id,
				});
			} else if (block.type === "text") {
				const tb = block as { text: string };
				blocks.push({
					type: "text",
					content: tb.text ?? "",
					isError: false,
				});
			}
		}
		return blocks;
	}

	/**
	 * Validate assert rules against content blocks from the current request.
	 * Supports two rule types:
	 * - LengthAssertRule: validates total number of content blocks
	 * - BlockAssertRule: indexes into the full content block array
	 * Runs captures and stores them in capturedVars.
	 * Throws MockValidationError on assert failure.
	 */
	private validateAsserts(
		asserts: AssertRule[],
		messages: MessageParam[],
	): void {
		const contentBlocks = this.extractContentBlocks(messages);

		for (const rule of asserts) {
			// Length assert: validate total block count
			if ("length" in rule) {
				if (contentBlocks.length !== rule.length) {
					throw new MockValidationError(
						`Assert failed: expected ${rule.length} content blocks, found ${contentBlocks.length}`,
					);
				}
				continue;
			}

			const block = contentBlocks[rule.block];
			if (!block) {
				throw new MockValidationError(
					`Assert failed: no content block at index ${rule.block} ` +
						`(only ${contentBlocks.length} blocks found)`,
				);
			}

			// Validate type if specified
			if (rule.type !== undefined && block.type !== rule.type) {
				throw new MockValidationError(
					`Assert failed: block[${rule.block}] has type "${block.type}", expected "${rule.type}"`,
				);
			}

			if (rule.contains !== undefined) {
				if (!block.content.includes(rule.contains)) {
					throw new MockValidationError(
						`Assert failed: block[${rule.block}] does not contain "${rule.contains}".\n` +
							`Content: ${block.content.slice(0, 300)}`,
					);
				}
			}

			if (rule.notContains !== undefined) {
				if (block.content.includes(rule.notContains)) {
					throw new MockValidationError(
						`Assert failed: block[${rule.block}] contains "${rule.notContains}" but should not.\n` +
							`Content: ${block.content.slice(0, 300)}`,
					);
				}
			}

			if (rule.isError !== undefined) {
				if (block.type !== "tool_result") {
					throw new MockValidationError(
						`Assert failed: block[${rule.block}] isError check is only valid for tool_result blocks, got "${block.type}"`,
					);
				}
				if (block.isError !== rule.isError) {
					throw new MockValidationError(
						`Assert failed: block[${rule.block}] isError=${block.isError}, expected ${rule.isError}.\n` +
							`Content: ${block.content.slice(0, 300)}`,
					);
				}
			}

			if (rule.matches !== undefined) {
				const regex = new RegExp(rule.matches);
				if (!regex.test(block.content)) {
					throw new MockValidationError(
						`Assert failed: block[${rule.block}] does not match /${rule.matches}/.\n` +
							`Content: ${block.content.slice(0, 300)}`,
					);
				}
			}

			if (rule.capture) {
				for (const [varName, pattern] of Object.entries(rule.capture)) {
					// Pattern format: "regex:(group pattern)"
					const regexStr = pattern.startsWith("regex:")
						? pattern.slice(6)
						: pattern;
					const regex = new RegExp(regexStr);
					const match = regex.exec(block.content);
					if (!match?.[1]) {
						throw new MockValidationError(
							`Assert capture failed: block[${rule.block}] ` +
								`regex /${regexStr}/ did not capture group 1 for var "${varName}".\n` +
								`Content: ${block.content.slice(0, 300)}`,
						);
					}
					this.capturedVars.set(varName, match[1]);
				}
			}
		}
	}

	/**
	 * Substitute $varName references in blocks with captured values.
	 * Returns a new blocks array with substitutions applied (does not mutate originals).
	 */
	private substituteVars(blocks: InstructionBlock[]): InstructionBlock[] {
		if (this.capturedVars.size === 0) return blocks;

		const substituteStr = (s: string): string => {
			let result = s;
			for (const [name, value] of this.capturedVars) {
				// Use split+join to avoid $ special chars in replacement strings
				const token = `${"$"}${name}`;
				result = result.split(token).join(value);
			}
			return result;
		};

		const substituteArr = (arr: unknown[]): unknown[] => {
			return arr.map((item) => {
				if (typeof item === "string") return substituteStr(item);
				if (Array.isArray(item)) return substituteArr(item);
				if (item && typeof item === "object")
					return substituteObj(item as Record<string, unknown>);
				return item;
			});
		};

		const substituteObj = (
			obj: Record<string, unknown>,
		): Record<string, unknown> => {
			const result: Record<string, unknown> = {};
			for (const [key, val] of Object.entries(obj)) {
				if (typeof val === "string") {
					result[key] = substituteStr(val);
				} else if (Array.isArray(val)) {
					result[key] = substituteArr(val);
				} else if (val && typeof val === "object") {
					result[key] = substituteObj(val as Record<string, unknown>);
				} else {
					result[key] = val;
				}
			}
			return result;
		};

		return blocks.map((block) => {
			if (block.type === "text") {
				return { ...block, text: substituteStr(block.text) };
			}
			if (block.type === "thinking") {
				return {
					...block,
					thinking: substituteStr(block.thinking),
					signature: substituteStr(block.signature),
				};
			}
			return { ...block, input: substituteObj(block.input) };
		});
	}

	/**
	 * Process a turn: validate asserts, substitute vars, build response.
	 */
	private processTurn(
		turn: SingleTurnInstruction,
		messages: MessageParam[],
	): {
		content: ContentBlock[];
		stopReason: "end_turn" | "tool_use";
		delayMs?: number;
	} {
		// Validate asserts against tool_results in current request
		if (turn.assert && turn.assert.length > 0) {
			this.validateAsserts(turn.assert, messages);
		}

		// Substitute captured variables in blocks
		const resolvedBlocks = this.substituteVars(turn.blocks);
		const resolvedTurn = { ...turn, blocks: resolvedBlocks };

		const result = buildResponseContent(resolvedTurn);
		return { ...result, delayMs: turn.delay_ms };
	}

	/**
	 * Inject a transient error on a specific API request.
	 * When request N arrives, throw the specified error instead of returning a response.
	 * After `count` failures, clear the injection and let subsequent calls succeed.
	 *
	 * Note: this counts ALL requests to the mock (including retries from callAPI's
	 * internal retry loop). To fail the Nth "logical" API call after all internal
	 * retries have been exhausted, set count >= the internal retry count (5).
	 */
	injectError(injection: ErrorInjection): void {
		this.errorInjections.set(injection.onRequest, {
			error: injection.error,
			remaining: injection.count ?? 1,
		});
	}

	/**
	 * Check and apply error injection for the current request number.
	 * Returns the error to throw, or null if no injection applies.
	 * Decrements remaining count and removes injection when exhausted.
	 */
	private checkErrorInjection(): Error | null {
		// Request count is already incremented in createStream before this check
		const reqNum = this.requestHistory.length;
		const injection = this.errorInjections.get(reqNum);
		if (!injection || injection.remaining <= 0) return null;

		injection.remaining--;
		if (injection.remaining <= 0) {
			this.errorInjections.delete(reqNum);
		} else {
			// Shift the injection to the next request number so consecutive failures work
			this.errorInjections.delete(reqNum);
			this.errorInjections.set(reqNum + 1, injection);
		}
		return makeInjectedError(injection.error);
	}

	/**
	 * Creates a stream handler that replaces `client.messages.stream`.
	 * Validates the request, dequeues from turn queue or parses new instruction,
	 * and returns a streaming mock response.
	 */
	createStream(
		params: {
			messages: MessageParam[];
			system?: unknown;
			tools?: unknown;
			model?: string;
			max_tokens?: number;
			[key: string]: unknown;
		},
		sessionId?: string,
	): ReturnType<typeof createMockAnthropicStream> {
		const { messages, system, tools, model } = params;

		// Validate API fields — reject unknown fields just like the real Anthropic API.
		validateAPIFields(params as Record<string, unknown>);

		// Record the request
		this.requestHistory.push({
			messages: structuredClone(messages),
			system: system ? structuredClone(system) : undefined,
			tools: tools ? structuredClone(tools) : undefined,
			model,
			timestamp: Date.now(),
			sessionId,
		});

		// Check error injection — throws before any validation/response
		const injectedError = this.checkErrorInjection();
		if (injectedError) throw injectedError;

		// Validate request structure
		validateRequest(messages);

		// Validate prefix consistency across calls (messages + system + tools)
		if (this.prefixValidationEnabled) {
			this.validatePrefix(messages, system, tools, sessionId);
		}

		// Validate cache_control TTL non-increasing order: tools → system → messages
		// Anthropic requires TTLs in non-increasing order across the prefix.
		validateCacheTtlOrder(
			tools as unknown[] | undefined,
			system as unknown[] | undefined,
			messages,
		);

		const modelName = (model as string) ?? "claude-sonnet-4-6";

		// Check for compaction request first
		if (isCompactionRequest(messages)) {
			// Compaction requests never trigger strict check — the mock synthesizes
			// a summary response unconditionally. Any is_error on the agent side
			// will be caught on the NEXT (post-compaction) request.
			const { content, stopReason } = buildCompactionResponse();
			return createMockAnthropicStream(content, stopReason, modelName);
		}

		// Identify conversation for per-conversation turn queuing.
		// This allows parent and child agents to have independent turn queues.
		const convKey = this.getConversationKey(messages, sessionId);

		// Resolve the turn to respond with (dequeue or parse instruction).
		// We compute this BEFORE the strict tool-error check so the turn's
		// assert rules can pre-acknowledge expected errors (e.g. tests that
		// explicitly assert `isError: true` on a specific block don't need
		// a redundant allowlist entry).
		let turn: SingleTurnInstruction | null = null;
		const convQueue = this.conversationQueues.get(convKey);
		if (convQueue && convQueue.length > 0) {
			turn = convQueue.shift() as SingleTurnInstruction;
			if (convQueue.length === 0) this.conversationQueues.delete(convKey);
		} else {
			const instruction = extractInstruction(messages);
			if (instruction) {
				if (isMultiTurn(instruction)) {
					const [first, ...rest] = instruction.turns;
					if (rest.length > 0) this.conversationQueues.set(convKey, rest);
					turn = first ?? null;
				} else {
					turn = instruction;
				}
			}
		}

		// Strict tool-error check: fail loudly on any tool_result with is_error
		// that the test hasn't allowlisted or explicitly asserted. Runs AFTER
		// turn resolution so per-turn assert rules can pre-acknowledge errors.
		this.checkStrictToolErrors(messages, turn?.assert);

		if (turn) {
			const { content, stopReason, delayMs } = this.processTurn(turn, messages);
			return createMockAnthropicStream(content, stopReason, modelName, delayMs);
		}

		// Default response — no instruction found, turn queue empty.
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

	/**
	 * Extract tool names from a recorded request's `tools` array.
	 * Anthropic tools shape: [{name, description, input_schema}, ...].
	 * Returns [] if request or tools missing.
	 *
	 * @param requestIdx Index into requestHistory (default: last request)
	 */
	getToolNames(requestIdx?: number): string[] {
		const record =
			requestIdx === undefined
				? this.getLastRequest()
				: this.requestHistory[requestIdx];
		if (!record?.tools || !Array.isArray(record.tools)) return [];
		const names: string[] = [];
		for (const t of record.tools as Array<{ name?: string }>) {
			if (t?.name) names.push(t.name);
		}
		return names;
	}

	/**
	 * Flatten a recorded request's `system` field to a single text string.
	 * Handles both string and TextBlockParam[] forms.
	 * Returns "" if request or system missing.
	 *
	 * @param requestIdx Index into requestHistory (default: last request)
	 */
	getSystemText(requestIdx?: number): string {
		const record =
			requestIdx === undefined
				? this.getLastRequest()
				: this.requestHistory[requestIdx];
		if (!record?.system) return "";
		if (typeof record.system === "string") return record.system;
		if (Array.isArray(record.system)) {
			const parts: string[] = [];
			for (const block of record.system as Array<{
				type?: string;
				text?: string;
			}>) {
				if (block?.type === "text" && typeof block.text === "string") {
					parts.push(block.text);
				}
			}
			return parts.join("\n");
		}
		return "";
	}

	/** How many turns are still queued across all conversations. */
	getPendingTurnCount(): number {
		let total = 0;
		for (const q of this.conversationQueues.values()) {
			total += q.length;
		}
		return total;
	}

	/**
	 * Enable prefix consistency validation.
	 * When enabled, every API call's messages must be a strict prefix extension
	 * of the previous call's messages. i.e., messages[0..N-1] from the previous
	 * call must deep-equal messages[0..N-1] of the current call.
	 *
	 * This catches JSONL reconstruction bugs that cause prompt cache misses.
	 */
	enablePrefixValidation(): void {
		this.prefixValidationEnabled = true;
	}

	/**
	 * Enable strict tool-error mode.
	 *
	 * When enabled, every tool_result block in a request's user messages is
	 * inspected. If `is_error: true` AND no entry in the effective allowlist
	 * matches (by tool name and/or content substring) → the mock throws
	 * `MockValidationError("Unsurfaced tool error: ...")`. That error
	 * propagates back through `client.messages.stream` and surfaces as a
	 * test failure — agents can't silently swallow errors from tool handlers
	 * while still ticking through the scripted turns.
	 *
	 * ## Default allowlist
	 *
	 * Called with no argument: the default allowlist covers **system-level
	 * contracts** that are legitimately surfaced to agents as errors, not
	 * bugs. Currently only one entry:
	 *
	 *   - `"Tool execution was interrupted by daemon restart"` — emitted by
	 *     `buildSessionRepair` as a synthetic tool_result for orphaned
	 *     tool_calls found on restart. This is the crash-recovery contract
	 *     and every restart test legitimately triggers it.
	 *
	 * Called with an explicit allowlist: the caller takes FULL control.
	 * No defaults are merged. Pass `[]` to mean "every error fails"; add
	 * the orphan-repair entry yourself if you want it included.
	 *
	 * ## How tests opt out
	 *
	 * Test authors who intentionally invoke a failing tool must either:
	 *   - add `{ tool: "...", contains: "..." }` to the allowlist,
	 *   - or call `mockAPI.disableStrictToolErrors()` for that specific test.
	 *
	 * ## Motivation
	 *
	 * The stripSession regression (FU8 removed triple-JSON-serialize in the
	 * broadcast path, `broadcastTreeUpdate` started leaking live session
	 * objects) caused every `create_task` / `update_task` / `delete_task` /
	 * `close_task` / `reset_task` / `reorder_tasks` call to return
	 * `isError: true`. Dozens of integration tests hit these tools; none
	 * failed because nothing asserted the error state. Strict mode plus the
	 * structuredClone wrapper in create-matrix-app.ts now cover this class
	 * of bug from two independent angles.
	 */
	enableStrictToolErrors(allowlist?: AllowedToolError[]): void {
		this.strictToolErrorsEnabled = true;
		this.toolErrorAllowlist = allowlist ?? [
			...ValidatingMockAPI.DEFAULT_ERROR_ALLOWLIST,
		];
	}

	/**
	 * Default allowlist — covers system-level contracts (not tool-handler
	 * bugs). Exposed as a static so tests that pass an explicit allowlist
	 * can spread this in: `enableStrictToolErrors([...DEFAULT_ERROR_ALLOWLIST, ...])`.
	 */
	static readonly DEFAULT_ERROR_ALLOWLIST: readonly AllowedToolError[] = [
		// buildSessionRepair's synthetic tool_result for orphaned tool_calls.
		// See src/events.ts — this content string is the contract.
		{ contains: "Tool execution was interrupted by daemon restart" },
	];

	/**
	 * Disable strict tool-error mode. Use this in individual tests that
	 * intentionally trigger tool errors and don't want to maintain an
	 * allowlist; prefer `enableStrictToolErrors([...])` when the error is
	 * specific enough to allowlist.
	 */
	disableStrictToolErrors(): void {
		this.strictToolErrorsEnabled = false;
		this.toolErrorAllowlist = [];
	}

	/**
	 * Scan the last user message's content for tool_result blocks and throw
	 * on any `is_error: true` block that isn't:
	 *   1. Pre-acknowledged by a turn assert rule (`{ block: N, isError: true }`), OR
	 *   2. Covered by `this.toolErrorAllowlist`.
	 *
	 * The assert-rule pre-acknowledgment means tests that already have
	 * per-turn isError asserts get strict-mode coverage "for free" — no
	 * redundant allowlist entry required.
	 */
	private checkStrictToolErrors(
		messages: MessageParam[],
		assertRules?: AssertRule[],
	): void {
		if (!this.strictToolErrorsEnabled) return;

		const lastUser = [...messages].reverse().find((m) => m.role === "user");
		if (!lastUser || !Array.isArray(lastUser.content)) return;

		// Block indices the current turn's asserts explicitly expect to be
		// errors. Strict mode treats these as pre-acknowledged.
		const acknowledgedIndices = new Set<number>();
		if (assertRules) {
			for (const rule of assertRules) {
				if ("length" in rule) continue;
				if (rule.isError === true) acknowledgedIndices.add(rule.block);
			}
		}

		for (let i = 0; i < lastUser.content.length; i++) {
			const block = lastUser.content[i];
			if (!block || typeof block !== "object" || !("type" in block)) continue;
			if (block.type !== "tool_result") continue;

			const tr = block as {
				tool_use_id: string;
				content?: string | unknown[];
				is_error?: boolean;
			};
			if (tr.is_error !== true) continue;

			// Test explicitly asserted this block is an error → acknowledged.
			if (acknowledgedIndices.has(i)) continue;

			// Normalize content to a single string for contains-matching and
			// error-message rendering.
			let contentStr = "";
			if (typeof tr.content === "string") {
				contentStr = tr.content;
			} else if (Array.isArray(tr.content)) {
				contentStr = tr.content
					.map((c) =>
						c && typeof c === "object" && "text" in c
							? ((c as { text: string }).text ?? "")
							: "",
					)
					.join("");
			}

			const toolName =
				this.findToolNameForToolUseId(messages, tr.tool_use_id) ?? "<unknown>";

			const allowed = this.toolErrorAllowlist.some((rule) => {
				const toolMatches =
					!rule.tool || rule.tool === "*" || rule.tool === toolName;
				const contentMatches =
					!rule.contains || contentStr.includes(rule.contains);
				return toolMatches && contentMatches;
			});

			if (!allowed) {
				throw new MockValidationError(
					`Unsurfaced tool error: tool "${toolName}" returned is_error: true but test did not allowlist or assert it.\n` +
						`  tool_use_id: ${tr.tool_use_id}\n` +
						`  content: ${contentStr.slice(0, 500)}${contentStr.length > 500 ? ` ... (${contentStr.length} chars total)` : ""}\n` +
						`Fix: either fix the underlying bug, add a turn assert ` +
						`\`{ block: ${i}, type: "tool_result", isError: true }\`, or add ` +
						`\`{ tool: "${toolName}" }\` to mockAPI.enableStrictToolErrors([...]).`,
				);
			}
		}
	}

	/**
	 * Walk the assistant messages backward looking for a tool_use with the
	 * given id. Used to attach a tool name to an error message produced by
	 * a tool_result block.
	 */
	private findToolNameForToolUseId(
		messages: MessageParam[],
		toolUseId: string,
	): string | null {
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (!msg || msg.role !== "assistant") continue;
			if (!Array.isArray(msg.content)) continue;
			for (const block of msg.content) {
				if (!block || typeof block !== "object" || !("type" in block)) continue;
				if (block.type !== "tool_use") continue;
				const tu = block as { id?: string; name?: string };
				if (tu.id === toolUseId) return tu.name ?? null;
			}
		}
		return null;
	}

	/**
	 * Validate that current request is a prefix extension of the previous request
	 * from the SAME conversation. Checks messages, system prompt, and tools.
	 *
	 * System + tools must be IDENTICAL across calls (they don't grow).
	 * Messages must be strictly monotonically increasing (prefix extension).
	 *
	 * Compaction is a valid reset point — after compaction, prefix restarts from scratch.
	 */
	private validatePrefix(
		messages: MessageParam[],
		system?: unknown,
		tools?: unknown,
		sessionId?: string,
	): void {
		if (this.requestHistory.length < 2) return;

		// Current request might be a compaction — skip prefix check for compactions
		if (isCompactionRequest(messages)) return;

		const convKey = this.getConversationKey(messages, sessionId);

		// Find previous non-compaction request from the SAME conversation.
		// Also detect if there's a compaction request between the found request
		// and the current request — that means we crossed a compact boundary
		// (new epoch: system/tools legitimately change, messages restart).
		let prevRequest: (typeof this.requestHistory)[0] | null = null;
		let compactBetween = false;
		for (let i = this.requestHistory.length - 2; i >= 0; i--) {
			const prev = this.requestHistory[i];
			if (!prev) continue;
			if (isCompactionRequest(prev.messages)) {
				// Found a compaction from this conversation between prev-non-compact and current
				if (
					this.getConversationKey(prev.messages, prev.sessionId) === convKey
				) {
					compactBetween = true;
				}
				continue;
			}
			if (this.getConversationKey(prev.messages, prev.sessionId) === convKey) {
				prevRequest = prev;
				break;
			}
		}
		if (!prevRequest) return;

		// After a compaction boundary, system/tools legitimately change (refresh)
		// and messages restart from compacted_resume. The previous epoch's prefix
		// is irrelevant — only validate within the post-compact epoch.
		if (compactBetween) return;

		// System prompt must be identical across calls (cache-critical).
		// Presence asymmetry also throws: if one call has system, all subsequent
		// calls in the same conversation must have system (dropping it would
		// invalidate the cache prefix).
		if (prevRequest.system !== undefined || system !== undefined) {
			const prevSystem = JSON.stringify(prevRequest.system ?? null);
			const currSystem = JSON.stringify(system ?? null);
			if (prevSystem !== currSystem) {
				throw new MockValidationError(
					`System prompt changed between API calls for the same conversation.\n` +
						`Previous: ${prevSystem.slice(0, 200)}...\n` +
						`Current:  ${currSystem.slice(0, 200)}...`,
				);
			}
		}

		// Tools must be identical across calls (cache-critical).
		// Presence asymmetry also throws: dropping the tools array mid-conversation
		// would invalidate the cache prefix.
		if (prevRequest.tools !== undefined || tools !== undefined) {
			const prevTools = JSON.stringify(prevRequest.tools ?? null);
			const currTools = JSON.stringify(tools ?? null);
			if (prevTools !== currTools) {
				throw new MockValidationError(
					`Tools changed between API calls for the same conversation.\n` +
						`Previous tool count: ${Array.isArray(prevRequest.tools) ? prevRequest.tools.length : "?"}\n` +
						`Current tool count: ${Array.isArray(tools) ? tools.length : "?"}`,
				);
			}
		}

		// Cache control consistency for message-level breakpoint:
		// System + tools cache_control are already validated by JSON.stringify above
		// (position + value must be identical). The message-level breakpoint is the
		// "last" marker — its position moves between turns (second-to-last user message
		// changes as conversation grows), but its VALUE must stay the same.
		const prevMsgCC = extractMessageCacheControl(prevRequest.messages);
		const currMsgCC = extractMessageCacheControl(messages);
		if (prevMsgCC !== null && currMsgCC !== null && prevMsgCC !== currMsgCC) {
			throw new MockValidationError(
				`Message cache_control value changed between API calls for the same conversation.\n` +
					`Previous: ${prevMsgCC}\n` +
					`Current:  ${currMsgCC}\n` +
					`The message breakpoint position can move, but its cache_control value must stay consistent.`,
			);
		}

		const prevMessages = prevRequest.messages;

		// The previous messages must be a prefix of the current messages.
		// Current messages length must be >= previous messages length.
		if (messages.length < prevMessages.length) {
			throw new MockValidationError(
				`Prefix violation: current request has ${messages.length} messages, ` +
					`but previous request had ${prevMessages.length}. Messages must be monotonically increasing.`,
			);
		}

		// Find message-level cache_control breakpoint positions in both requests.
		// The breakpoint is the "last marker" — placed on the second-to-last user
		// message. Its position moves between turns as the conversation grows.
		// At the breakpoint indices, cache_control is stripped for content comparison
		// (position is allowed to move). At all other indices, cache_control is
		// compared strictly — any unexpected cache_control is a bug.
		const prevBreakpointIdx = findMessageCacheControlIndex(prevMessages);
		const currBreakpointIdx = findMessageCacheControlIndex(messages);

		for (let i = 0; i < prevMessages.length; i++) {
			const prev = prevMessages[i];
			const curr = messages[i];
			// Strip cache_control at breakpoint positions (prev or curr) — the
			// breakpoint legitimately moves between turns.
			const stripCC = i === prevBreakpointIdx || i === currBreakpointIdx;
			if (!deepEqualMessage(prev, curr, stripCC)) {
				throw new MockValidationError(
					`Prefix violation at message index ${i}: ` +
						`previous and current messages differ.\n` +
						`Previous: ${JSON.stringify(prev, abbreviateContent, 2)}\n` +
						`Current:  ${JSON.stringify(curr, abbreviateContent, 2)}`,
				);
			}
		}
	}

	/** Get the current captured variables (from assert capture rules). */
	getCapturedVars(): ReadonlyMap<string, string> {
		return this.capturedVars;
	}

	/** Pre-set a captured variable for use in $varName substitution. */
	setCapturedVar(name: string, value: string): void {
		this.capturedVars.set(name, value);
	}

	/**
	 * Validate that a forked child's pre-fork messages are an exact prefix
	 * of the source agent's messages at fork time.
	 *
	 * For fork-self: sourceSessionId is the parent, childSessionId is the forked child.
	 * For fork-other: sourceSessionId is the closed task, childSessionId is the new task.
	 *
	 * Returns the number of matching prefix messages, or throws MockValidationError on mismatch.
	 */
	validateForkPrefix(sourceSessionId: string, childSessionId: string): number {
		const sourceKey = `session:${sourceSessionId}`;
		const childKey = `session:${childSessionId}`;

		// Find the source's last request before the child's first request
		const childFirstIdx = this.requestHistory.findIndex(
			(r) => this.getConversationKey(r.messages, r.sessionId) === childKey,
		);
		if (childFirstIdx === -1) {
			throw new MockValidationError(
				`validateForkPrefix: no requests found for child session ${childSessionId}`,
			);
		}

		// Find the source request whose response included fork_task_context.
		// That response's tool_result is in the NEXT source request's messages.
		// The next source request after fork = the one with the fork tool_result.
		// Its messages ARE the fork-point snapshot (all pre-fork messages + fork turn).
		let forkResultRequest: RequestRecord | null = null;
		for (let i = 0; i < childFirstIdx; i++) {
			const req = this.requestHistory[i];
			if (
				!req ||
				this.getConversationKey(req.messages, req.sessionId) !== sourceKey
			)
				continue;

			// Check if this request's user messages contain a fork tool_result
			// ("You are the PARENT")
			const hasForkResult = req.messages.some((m) => {
				if (m.role !== "user" || !Array.isArray(m.content)) return false;
				return (m.content as Array<{ type: string; content?: string }>).some(
					(b) =>
						b.type === "tool_result" &&
						b.content?.includes("You are the PARENT"),
				);
			});
			if (hasForkResult) {
				forkResultRequest = req;
				break;
			}
		}

		// The fork-point messages are the previous source request (before fork result).
		// The fork tool_result request has messages = pre-fork + fork assistant + fork result.
		// The child's first request should match pre-fork + fork assistant + child's fork result.
		// Use the fork result request — they share everything except the last user message.
		let sourceMessages: MessageParam[];
		if (forkResultRequest) {
			sourceMessages = forkResultRequest.messages;
		} else {
			// Fallback: use the last source request before child
			let fallback: RequestRecord | null = null;
			for (let i = childFirstIdx - 1; i >= 0; i--) {
				const req = this.requestHistory[i];
				if (
					req &&
					this.getConversationKey(req.messages, req.sessionId) === sourceKey
				) {
					fallback = req;
					break;
				}
			}
			if (!fallback) {
				throw new MockValidationError(
					`validateForkPrefix: no source requests found for session ${sourceSessionId}`,
				);
			}
			sourceMessages = fallback.messages;
		}
		const childMessages = this.requestHistory[childFirstIdx]?.messages as
			| typeof sourceMessages
			| undefined;
		if (!childMessages) {
			throw new MockValidationError(
				`validateForkPrefix: no child request found at index ${childFirstIdx}`,
			);
		}

		// The child should have the source's messages as a prefix, followed by the
		// fork tool_result (with "You are the CHILD") and any additional messages.
		// The fork point is where they diverge — the user message containing the fork
		// tool_result will differ (parent has "PARENT", child has "CHILD").
		let matchCount = 0;
		const minLen = Math.min(sourceMessages.length, childMessages.length);
		for (let i = 0; i < minLen; i++) {
			if (deepEqualMessage(sourceMessages[i], childMessages[i])) {
				matchCount++;
			} else {
				break;
			}
		}

		// At minimum, the pre-fork messages should match. The fork divergence point
		// should be the LAST message in the source (the one with the fork tool_result).
		// So matchCount should be sourceMessages.length - 1 (everything except the
		// last user message which has parent vs child fork result).
		if (matchCount < sourceMessages.length - 1) {
			const divergeIdx = matchCount;
			throw new MockValidationError(
				`Fork prefix mismatch at message index ${divergeIdx}.\n` +
					`Source (${sourceSessionId}): ${JSON.stringify(sourceMessages[divergeIdx], abbreviateContent, 2)}\n` +
					`Child  (${childSessionId}): ${JSON.stringify(childMessages[divergeIdx], abbreviateContent, 2)}`,
			);
		}

		return matchCount;
	}

	/** Reset state between tests. */
	reset(): void {
		this.requestHistory = [];
		this.conversationQueues.clear();
		this.prefixValidationEnabled = false;
		this.strictToolErrorsEnabled = false;
		this.toolErrorAllowlist = [];
		this.capturedVars.clear();
		this.errorInjections.clear();
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
	opts?: { systemPreamble?: string },
) {
	// Lazy import to avoid circular dependencies
	const { AnthropicCompatibleProvider } =
		// biome-ignore lint/suspicious/noExplicitAny: dynamic import for test isolation
		require("../anthropic-compatible-provider.ts") as any;

	const savedKey = process.env.ANTHROPIC_API_KEY;
	process.env.ANTHROPIC_API_KEY = "test-key";
	const provider = new AnthropicCompatibleProvider(
		model ?? "claude-sonnet-4-6",
		{
			apiKey: "test-key",
			...(opts?.systemPreamble ? { systemPreamble: opts.systemPreamble } : {}),
		},
	);
	process.env.ANTHROPIC_API_KEY = savedKey;

	// Replace the client's messages.stream with our mock.
	// The provider sets mockClient._currentSessionId before each stream call
	// (side channel — avoids putting test-only fields in the API params).
	// biome-ignore lint/suspicious/noExplicitAny: replacing internal client for testing
	const mockClient: any = {
		_currentSessionId: undefined as string | undefined,
		messages: {
			stream: (params: Parameters<typeof mockAPI.createStream>[0]) =>
				mockAPI.createStream(params, mockClient._currentSessionId),
			countTokens: async () => ({ input_tokens: 100 }),
		},
	};
	(provider as unknown as { client: typeof mockClient }).client = mockClient;

	// Fast outer retry delay for tests (100ms instead of 30s+)
	provider.outerRetryDelayMs = () => 100;

	return provider;
}
