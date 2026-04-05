/**
 * Tests for provider-level image validation.
 * Validates that oversized images are rejected before reaching the API,
 * replaced with error text containing resize instructions.
 */
import { describe, expect, it } from "bun:test";
import type { Event } from "./events.ts";
import type { QueueMessage } from "./message-queue.ts";
import {
	filterEventImages,
	filterExecResultImages,
	filterQueueMessageImages,
	type ProviderAdapter,
} from "./provider-shared.ts";
import type { ToolResult } from "./shared-types.ts";

// ── Helpers ──

/** Create a base64 string of exactly `byteCount` decoded bytes. */
function makeBase64(byteCount: number): string {
	const buf = Buffer.alloc(byteCount, 0x42); // fill with 'B'
	return buf.toString("base64");
}

/** Stub adapter with Anthropic-like 5MB limit. */
const anthropicAdapter: ProviderAdapter = {
	validateImage(base64: string, _mediaType: string) {
		const MAX_BYTES = 5_242_880;
		const byteLength = Buffer.from(base64, "base64").byteLength;
		if (byteLength > MAX_BYTES) {
			const sizeMB = (byteLength / 1_048_576).toFixed(1);
			return {
				ok: false as const,
				reason: `image size (${sizeMB} MB) exceeds Anthropic API limit (5.0 MB)`,
			};
		}
		return { ok: true as const };
	},
	// Stubs for required interface methods — not used in filter tests
	getContextWindow: () => 200000,
	getModelPricing: () => ({ inputPer1M: 0, outputPer1M: 0 }),
	convertEventsToMessages: () => [],
	prepareTools: () => [],
	// biome-ignore lint/correctness/useYield: stub for tests
	callAPI: async function* () {
		return {};
	},
	getResponseText: () => "",
	getToolUses: () => [],
	getTokenUsage: () => ({
		inputTokens: 0,
		outputTokens: 0,
		totalContextTokens: 0,
	}),
	getStopReason: () => "end_turn" as const,
	supportsTokenCounting: false,
	buildResponseEvents: () => [],
	addAssistantMessage: () => {},
	buildUserTurn: () => [],
	appendQueueMessagesToMessages: () => {},
	computeCost: () => 0,
} as ProviderAdapter;

/** Adapter without validateImage — should accept all images. */
const noValidationAdapter: ProviderAdapter = {
	...anthropicAdapter,
	validateImage: undefined,
};

describe("Image validation", () => {
	describe("filterExecResultImages", () => {
		it("accepts images under the limit", () => {
			const smallBase64 = makeBase64(1_000_000); // 1MB — well under 5MB
			const results: ToolResult[] = [
				{
					content: "Screenshot captured",
					isError: false,
					isImage: true,
					imageData: smallBase64,
					mediaType: "image/png",
				},
			];

			filterExecResultImages(anthropicAdapter, results);

			expect(results[0]?.isImage).toBe(true);
			expect(results[0]?.imageData).toBe(smallBase64);
			expect(results[0]?.mediaType).toBe("image/png");
			expect(results[0]?.content).toBe("Screenshot captured");
		});

		it("rejects oversized direct images and replaces with error text", () => {
			const bigBase64 = makeBase64(6_000_000); // 6MB — over 5MB limit
			const results: ToolResult[] = [
				{
					content: "Screenshot captured",
					isError: false,
					isImage: true,
					imageData: bigBase64,
					mediaType: "image/png",
				},
			];

			filterExecResultImages(anthropicAdapter, results);

			// Image fields should be cleared
			expect(results[0]?.isImage).toBe(false);
			expect(results[0]?.imageData).toBeUndefined();
			expect(results[0]?.mediaType).toBeUndefined();
			// Content replaced with rejection message
			expect(results[0]?.content).toContain("[Image rejected:");
			expect(results[0]?.content).toContain(
				"exceeds Anthropic API limit (5.0 MB)",
			);
			expect(results[0]?.content).toContain("magick");
		});

		it("rejects oversized MCP images and appends error to content", () => {
			const bigBase64 = makeBase64(6_000_000);
			const smallBase64 = makeBase64(1_000_000);
			const results: ToolResult[] = [
				{
					content: "Tool output",
					isError: false,
					mcpImages: [
						{ base64: bigBase64, mediaType: "image/png" },
						{ base64: smallBase64, mediaType: "image/jpeg" },
					],
				},
			];

			filterExecResultImages(anthropicAdapter, results);

			// Oversized image removed, small one kept
			expect(results[0]?.mcpImages).toHaveLength(1);
			expect(results[0]?.mcpImages?.[0]?.base64).toBe(smallBase64);
			// Rejection message appended to content
			expect(results[0]?.content).toContain("Tool output");
			expect(results[0]?.content).toContain("[Image rejected:");
		});

		it("skips validation when adapter has no validateImage", () => {
			const bigBase64 = makeBase64(6_000_000);
			const results: ToolResult[] = [
				{
					content: "Screenshot",
					isError: false,
					isImage: true,
					imageData: bigBase64,
					mediaType: "image/png",
				},
			];

			filterExecResultImages(noValidationAdapter, results);

			// Image should be untouched
			expect(results[0]?.isImage).toBe(true);
			expect(results[0]?.imageData).toBe(bigBase64);
		});

		it("handles image exactly at the limit", () => {
			const exactBase64 = makeBase64(5_242_880); // exactly 5MB
			const results: ToolResult[] = [
				{
					content: "Screenshot",
					isError: false,
					isImage: true,
					imageData: exactBase64,
					mediaType: "image/png",
				},
			];

			filterExecResultImages(anthropicAdapter, results);

			// Exactly at limit — should be accepted
			expect(results[0]?.isImage).toBe(true);
			expect(results[0]?.imageData).toBe(exactBase64);
		});

		it("rejects image one byte over the limit", () => {
			const overBase64 = makeBase64(5_242_881); // 1 byte over
			const results: ToolResult[] = [
				{
					content: "Screenshot",
					isError: false,
					isImage: true,
					imageData: overBase64,
					mediaType: "image/png",
				},
			];

			filterExecResultImages(anthropicAdapter, results);

			expect(results[0]?.isImage).toBe(false);
			expect(results[0]?.imageData).toBeUndefined();
			expect(results[0]?.content).toContain("[Image rejected:");
		});
	});

	describe("filterQueueMessageImages", () => {
		it("accepts user images under the limit", () => {
			const smallBase64 = makeBase64(1_000_000);
			const msgs: QueueMessage[] = [
				{
					source: "user",
					id: "msg1",
					ts: Date.now(),
					content: "Check this image",
					images: [{ base64: smallBase64, mediaType: "image/png" }],
				},
			];

			filterQueueMessageImages(anthropicAdapter, msgs);

			const userMsg = msgs[0] as Extract<QueueMessage, { source: "user" }>;
			expect(userMsg.images).toHaveLength(1);
			expect(userMsg.images?.[0]?.base64).toBe(smallBase64);
		});

		it("rejects oversized user images and appends error to content", () => {
			const bigBase64 = makeBase64(6_000_000);
			const msgs: QueueMessage[] = [
				{
					source: "user",
					id: "msg1",
					ts: Date.now(),
					content: "Check this image",
					images: [{ base64: bigBase64, mediaType: "image/png" }],
				},
			];

			filterQueueMessageImages(anthropicAdapter, msgs);

			const userMsg = msgs[0] as Extract<QueueMessage, { source: "user" }>;
			expect(userMsg.images).toBeUndefined(); // cleared when all filtered
			expect(userMsg.content).toContain("[Image rejected:");
			expect(userMsg.content).toContain("Check this image");
		});

		it("ignores non-user queue messages", () => {
			const msgs: QueueMessage[] = [
				{
					source: "task_complete",
					id: "msg1",
					ts: Date.now(),
					taskId: "t1",
					title: "test",
					success: true,
					output: "done",
				},
			];

			// Should not throw
			filterQueueMessageImages(anthropicAdapter, msgs);
		});
	});

	describe("filterEventImages", () => {
		it("filters oversized images from tool_result events", () => {
			const bigBase64 = makeBase64(6_000_000);
			const smallBase64 = makeBase64(1_000_000);
			const events: Event[] = [
				{
					type: "tool_result",
					tool: "read_file",
					toolCallId: "tc1",
					content: "File content",
					isError: false,
					images: [
						{ base64: bigBase64, mediaType: "image/png" },
						{ base64: smallBase64, mediaType: "image/jpeg" },
					],
					taskId: "",
					ts: Date.now(),
				},
			];

			const filtered = filterEventImages(anthropicAdapter, events);

			const evt = filtered[0] as Extract<Event, { type: "tool_result" }>;
			expect(evt.images).toHaveLength(1);
			expect(evt.images?.[0]?.base64).toBe(smallBase64);
			expect(evt.content).toContain("[Image rejected:");
			expect(evt.content).toContain("File content");
		});

		it("filters oversized images from message events with user source", () => {
			const bigBase64 = makeBase64(6_000_000);
			const events: Event[] = [
				{
					type: "message",
					id: "m1",
					taskId: "",
					body: {
						source: "user",
						id: "m1",
						ts: Date.now(),
						content: "Hello",
						images: [{ base64: bigBase64, mediaType: "image/png" }],
					},
					ts: Date.now(),
				},
			];

			const filtered = filterEventImages(anthropicAdapter, events);

			const evt = filtered[0] as Extract<Event, { type: "message" }>;
			expect(evt.body.source).toBe("user");
			const body = evt.body as Extract<QueueMessage, { source: "user" }>;
			expect(body.images).toBeUndefined();
			expect(body.content).toContain("[Image rejected:");
		});

		it("returns same array when no validateImage hook", () => {
			const events: Event[] = [
				{
					type: "tool_result",
					tool: "read_file",
					toolCallId: "tc1",
					content: "data",
					isError: false,
					images: [{ base64: makeBase64(6_000_000), mediaType: "image/png" }],
					taskId: "",
					ts: Date.now(),
				},
			];

			const filtered = filterEventImages(noValidationAdapter, events);
			expect(filtered).toBe(events); // same reference — no processing
		});

		it("preserves non-image events unchanged", () => {
			const events: Event[] = [
				{
					type: "assistant_text",
					content: "Hello",
					taskId: "",
					ts: Date.now(),
				},
				{
					type: "tool_call",
					tool: "bash",
					toolCallId: "tc1",
					input: { command: "ls" },
					taskId: "",
					ts: Date.now(),
				},
			];

			const filtered = filterEventImages(anthropicAdapter, events);
			expect(filtered).toEqual(events);
		});

		it("removes images field entirely when all images are rejected", () => {
			const bigBase64 = makeBase64(6_000_000);
			const events: Event[] = [
				{
					type: "tool_result",
					tool: "read_file",
					toolCallId: "tc1",
					content: "data",
					isError: false,
					images: [{ base64: bigBase64, mediaType: "image/png" }],
					taskId: "",
					ts: Date.now(),
				},
			];

			const filtered = filterEventImages(anthropicAdapter, events);
			const evt = filtered[0] as Extract<Event, { type: "tool_result" }>;
			expect(evt.images).toBeUndefined();
		});
	});

	describe("Anthropic validateImage (via adapter)", () => {
		it("accepts exactly 5MB", () => {
			const base64 = makeBase64(5_242_880);
			const validate = anthropicAdapter.validateImage as NonNullable<
				typeof anthropicAdapter.validateImage
			>;
			const result = validate(base64, "image/png");
			expect(result.ok).toBe(true);
		});

		it("rejects 5MB + 1 byte", () => {
			const base64 = makeBase64(5_242_881);
			const validate = anthropicAdapter.validateImage as NonNullable<
				typeof anthropicAdapter.validateImage
			>;
			const result = validate(base64, "image/png");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toContain("5.0 MB");
				expect(result.reason).toContain("Anthropic");
			}
		});

		it("uses actual decoded byte count, not base64 string length", () => {
			// 4MB raw = ~5.33MB base64 string, but decoded is only 4MB → should pass
			const base64 = makeBase64(4_000_000);
			expect(base64.length).toBeGreaterThan(5_000_000); // base64 is larger than 5MB
			const validate = anthropicAdapter.validateImage as NonNullable<
				typeof anthropicAdapter.validateImage
			>;
			const result = validate(base64, "image/png");
			expect(result.ok).toBe(true); // but decoded is only 4MB
		});
	});
});
