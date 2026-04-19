/**
 * Golden snapshot tests for the Anthropic event walker.
 *
 * These tests target `eventsToAnthropicMessages` — the walker callbacks that
 * transform JSONL events into Anthropic MessageParam[]. Since the unified
 * architecture makes live path delegate to this walker, these callbacks are
 * the single source of truth for "how user messages are built".
 *
 * Prefix-validation tests verify live path and reconstruction AGREE. These
 * tests verify the walker produces CORRECT bytes — which is a different class
 * of bug. Example: if walker forgot the caption entirely, both live and
 * reconstruction would consistently drop it, prefix validation would pass,
 * and bytes would be wrong. These tests catch that.
 *
 * RUTHLESS assertions: every field of every block, including absence of
 * `is_error` on image tool_results, exact block ordering, caption presence
 * only when images > 0, etc.
 */

import { describe, expect, test } from "bun:test";
import { eventsToAnthropicMessages } from "./anthropic-compatible-provider.ts";
import type { Event } from "./events.ts";

// ── Helpers ──

/**
 * Build a message event (user source) for testing. The walker resolves these
 * via messages_consumed using eventIndex. Every message event MUST have an id
 * for the walker to defer it until consumed (otherwise it's rendered directly).
 */
function userMessageEvent(
	id: string,
	content: string,
	opts?: {
		ts?: number;
		images?: Array<{ base64: string; mediaType: string }>;
	},
): Event {
	return {
		type: "message",
		id,
		taskId: "",
		ts: opts?.ts ?? 0,
		body: {
			source: "user",
			id,
			ts: opts?.ts ?? 0,
			content,
			...(opts?.images?.length ? { images: opts.images } : {}),
		},
	};
}

function taskMessageEvent(
	id: string,
	fromTaskId: string,
	fromTitle: string,
	content: string,
	opts?: {
		ts?: number;
		title?: string;
		requestReply?: boolean;
	},
): Event {
	return {
		type: "message",
		id,
		taskId: "",
		ts: opts?.ts ?? 0,
		body: {
			source: "task_message",
			id,
			ts: opts?.ts ?? 0,
			fromTaskId,
			fromTitle,
			content,
			...(opts?.title ? { title: opts.title } : {}),
			...(opts?.requestReply != null
				? { requestReply: opts.requestReply }
				: {}),
		},
	};
}

function taskCompleteEvent(
	id: string,
	taskId: string,
	title: string,
	success: boolean,
	output: string,
	ts = 0,
): Event {
	return {
		type: "message",
		id,
		taskId: "",
		ts,
		body: {
			source: "task_complete",
			id,
			ts,
			taskId,
			title,
			success,
			output,
		},
	};
}

function messagesConsumedEvent(messageIds: string[], ts = 0): Event {
	return { type: "messages_consumed", messageIds, taskId: "", ts };
}

function assistantTextEvent(content: string, ts = 0): Event {
	return { type: "assistant_text", content, taskId: "", ts };
}

function toolCallEvent(
	toolCallId: string,
	tool: string,
	input: Record<string, unknown> = {},
	ts = 0,
): Event {
	return { type: "tool_call", toolCallId, tool, input, taskId: "", ts };
}

function toolResultEvent(
	toolCallId: string,
	tool: string,
	content: string,
	opts?: {
		isError?: boolean;
		images?: Array<{ base64: string; mediaType: string }>;
		ts?: number;
	},
): Event {
	return {
		type: "tool_result",
		toolCallId,
		tool,
		content,
		isError: opts?.isError ?? false,
		...(opts?.images ? { images: opts.images } : {}),
		taskId: "",
		ts: opts?.ts ?? 0,
	};
}

function thinkingEvent(thinking: string, signature: string, ts = 0): Event {
	return { type: "thinking", thinking, signature, taskId: "", ts };
}

// A tiny valid 1×1 PNG for image blocks
const TINY_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// Expected timestamp-prefixed text for a user message.
// formatEventForAI: `[HH:MM:SS] ${formatBodyForAI(body)}`
// ts=0 → [00:00:00] (UTC time, en-GB locale)
function userText(ts: number, content: string): string {
	const hh = new Date(ts).toLocaleTimeString("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
	return `[${hh}] ${content}`;
}

function taskMessageText(
	ts: number,
	fromTaskId: string,
	fromTitle: string,
	content: string,
	opts?: { title?: string; requestReply?: boolean },
): string {
	const hh = new Date(ts).toLocaleTimeString("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
	const titleAttr = opts?.title ? ` title="${opts.title}"` : "";
	const replyAttr = opts?.requestReply ? ' requestReply="true"' : "";
	return `[${hh}] <task_message from_task="${fromTaskId}" task_name="${fromTitle}"${titleAttr}${replyAttr}>${content}</task_message>`;
}

function taskCompleteText(
	ts: number,
	taskId: string,
	title: string,
	success: boolean,
	output: string,
): string {
	const hh = new Date(ts).toLocaleTimeString("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
	return `[${hh}] <task_complete from_task="${taskId}" task_name="${title}" status="${success ? "passed" : "failed"}">${output}</task_complete>`;
}

// ── Tests: onUserMessage callback ──
// compacted_resume and summarization_request tests removed — these event types
// no longer exist. Content now flows through the message path as QueueMessage sources.

describe("walker: onUserMessage callback", () => {
	test("budget_warning event renders as user message", () => {
		const events: Event[] = [
			{
				type: "budget_warning",
				warning: "You're at 80% of budget.",
				taskId: "",
				ts: 0,
			},
		];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs).toEqual([
			{ role: "user", content: "You're at 80% of budget." },
		]);
	});
});

// ── Tests: onAssistantContent callback ──

describe("walker: onAssistantContent callback", () => {
	test("single text block", () => {
		const events: Event[] = [assistantTextEvent("Hello world")];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs).toEqual([
			{
				role: "assistant",
				content: [{ type: "text", text: "Hello world" }],
			},
		]);
	});

	test("text followed by tool_call — both in same assistant turn", () => {
		const events: Event[] = [
			assistantTextEvent("Let me check."),
			toolCallEvent("tool_01", "bash", { command: "ls" }),
		];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs).toEqual([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Let me check." },
					{
						type: "tool_use",
						id: "tool_01",
						name: "bash",
						input: { command: "ls" },
						caller: { type: "direct" },
					},
				],
			},
		]);
	});

	test("thinking + text + tool_call interleaved", () => {
		const events: Event[] = [
			thinkingEvent("Analyzing the problem", "sig-abc"),
			assistantTextEvent("OK, I'll start."),
			toolCallEvent("tool_02", "read_file", { path: "/x" }),
			assistantTextEvent("And then another action."),
			toolCallEvent("tool_03", "bash", { command: "echo" }),
		];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs).toEqual([
			{
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "Analyzing the problem",
						signature: "sig-abc",
					},
					{ type: "text", text: "OK, I'll start." },
					{
						type: "tool_use",
						id: "tool_02",
						name: "read_file",
						input: { path: "/x" },
						caller: { type: "direct" },
					},
					{ type: "text", text: "And then another action." },
					{
						type: "tool_use",
						id: "tool_03",
						name: "bash",
						input: { command: "echo" },
						caller: { type: "direct" },
					},
				],
			},
		]);
	});

	// Legacy alias tests removed — TOOL_NAME_ALIASES deleted, no remapping exists.

	test("unknown tool name passes through unchanged", () => {
		// Non-aliased names flow through resolveToolName unchanged.
		const events: Event[] = [
			toolCallEvent("tool_06", "mcp__external__some_tool", { x: 1 }),
		];
		const msgs = eventsToAnthropicMessages(events);
		expect(
			(msgs[0] as { content: Array<{ name: string }> }).content[0]?.name,
		).toBe("mcp__external__some_tool");
	});
});

// ── Tests: onToolResults — tool_result without queue ──

describe("walker: onToolResults — pure tool_result (no queue messages)", () => {
	test("single tool_result without images — includes is_error field", () => {
		// Critical: the `is_error` field MUST be present on tool_result blocks
		// without images. Live path emits it; walker must reconstruct it.
		const events: Event[] = [
			toolResultEvent("tool_01", "bash", "hello_world\n"),
		];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs).toEqual([
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool_01",
						content: "hello_world\n",
						is_error: false,
					},
				],
			},
		]);
	});

	test("single tool_result with isError=true", () => {
		const events: Event[] = [
			toolResultEvent("tool_02", "bash", "command failed", { isError: true }),
		];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs).toEqual([
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool_02",
						content: "command failed",
						is_error: true,
					},
				],
			},
		]);
	});

	test("single tool_result with images — OMITS is_error field", () => {
		// Critical invariant: tool_result blocks WITH images are NOT emitted
		// with is_error. Live path matches this. A drift here would cause
		// prefix mismatch via key-presence difference (prev has is_error, curr doesn't).
		const events: Event[] = [
			toolResultEvent("tool_03", "read_file", "[Image: test.png]", {
				images: [{ base64: TINY_PNG, mediaType: "image/png" }],
			}),
		];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs).toEqual([
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool_03",
						content: [
							{
								type: "image",
								source: {
									type: "base64",
									media_type: "image/png",
									data: TINY_PNG,
								},
							},
							{ type: "text", text: "[Image: test.png]" },
						],
					},
				],
			},
		]);

		// Explicit check: is_error must NOT be present on image tool_results
		const content = (msgs[0] as { content: unknown[] }).content;
		const block = content[0] as Record<string, unknown>;
		expect("is_error" in block).toBe(false);
	});

	test("multiple tool_results in same turn", () => {
		const events: Event[] = [
			toolResultEvent("t1", "bash", "output 1"),
			toolResultEvent("t2", "bash", "output 2"),
			toolResultEvent("t3", "bash", "output 3", { isError: true }),
		];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs).toEqual([
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "t1",
						content: "output 1",
						is_error: false,
					},
					{
						type: "tool_result",
						tool_use_id: "t2",
						content: "output 2",
						is_error: false,
					},
					{
						type: "tool_result",
						tool_use_id: "t3",
						content: "output 3",
						is_error: true,
					},
				],
			},
		]);
	});

	test("empty content → '(empty)' fallback", () => {
		const events: Event[] = [toolResultEvent("t1", "bash", "")];
		const msgs = eventsToAnthropicMessages(events);
		const block = (msgs[0] as { content: Array<{ content: string }> })
			.content[0];
		expect(block?.content).toBe("(empty)");
	});

	test("image tool_result with empty content → '(empty)' text block", () => {
		const events: Event[] = [
			toolResultEvent("t1", "read_file", "", {
				images: [{ base64: TINY_PNG, mediaType: "image/png" }],
			}),
		];
		const msgs = eventsToAnthropicMessages(events);
		const block = (
			msgs[0] as {
				content: Array<{ content: Array<{ type: string; text?: string }> }>;
			}
		).content[0];
		const textBlock = block?.content?.find((b) => b.type === "text");
		expect(textBlock?.text).toBe("(empty)");
	});

	test("multiple images on same tool_result preserved in order", () => {
		const png2 =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAEnNCcKAAAAAElFTkSuQmCC";
		const events: Event[] = [
			toolResultEvent("t1", "mcp__devtools__screenshot", "two shots", {
				images: [
					{ base64: TINY_PNG, mediaType: "image/png" },
					{ base64: png2, mediaType: "image/png" },
				],
			}),
		];
		const msgs = eventsToAnthropicMessages(events);
		const content = (msgs[0] as { content: Array<{ content: Array<unknown> }> })
			.content[0]?.content;
		expect(content).toEqual([
			{
				type: "image",
				source: { type: "base64", media_type: "image/png", data: TINY_PNG },
			},
			{
				type: "image",
				source: { type: "base64", media_type: "image/png", data: png2 },
			},
			{ type: "text", text: "two shots" },
		]);
	});

	test("JPEG tool_result uses correct media_type", () => {
		const events: Event[] = [
			toolResultEvent("t1", "read_file", "jpeg", {
				images: [{ base64: "abc", mediaType: "image/jpeg" }],
			}),
		];
		const msgs = eventsToAnthropicMessages(events);
		const imgBlock = (
			msgs[0] as {
				content: Array<{
					content: Array<{
						type: string;
						source?: { media_type: string };
					}>;
				}>;
			}
		).content[0]?.content?.find((b) => b.type === "image");
		expect(imgBlock?.source?.media_type).toBe("image/jpeg");
	});
});

// ── Tests: onToolResults — tool_result WITH queue messages (working context) ──

describe("walker: onToolResults — tool_result + messages_consumed (working context)", () => {
	test("tool_result + single user queue message", () => {
		const events: Event[] = [
			toolResultEvent("t1", "bash", "done"),
			userMessageEvent("msg_01", "User interrupt!", { ts: 0 }),
			messagesConsumedEvent(["msg_01"]),
		];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs).toEqual([
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "t1",
						content: "done",
						is_error: false,
					},
					{ type: "text", text: userText(0, "User interrupt!") },
				],
			},
		]);
	});

	test("tool_result + user queue message with images — CAPTION APPEARS", () => {
		// Working-context image path in onToolResults. Must include caption
		// `[N image(s) attached by user]` as final text block.
		const events: Event[] = [
			toolResultEvent("t1", "bash", "done"),
			userMessageEvent("msg_01", "Check this image", {
				ts: 0,
				images: [{ base64: TINY_PNG, mediaType: "image/png" }],
			}),
			messagesConsumedEvent(["msg_01"]),
		];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs).toEqual([
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "t1",
						content: "done",
						is_error: false,
					},
					{ type: "text", text: userText(0, "Check this image") },
					{
						type: "image",
						source: {
							type: "base64",
							media_type: "image/png",
							data: TINY_PNG,
						},
					},
					{ type: "text", text: "[1 image(s) attached by user]" },
				],
			},
		]);
	});

	test("multiple tool_results + multiple queue messages interleaved", () => {
		const events: Event[] = [
			toolResultEvent("t1", "bash", "out1"),
			toolResultEvent("t2", "bash", "out2"),
			userMessageEvent("msg_01", "First queue msg", { ts: 0 }),
			userMessageEvent("msg_02", "Second queue msg", { ts: 0 }),
			messagesConsumedEvent(["msg_01", "msg_02"]),
		];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs).toEqual([
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "t1",
						content: "out1",
						is_error: false,
					},
					{
						type: "tool_result",
						tool_use_id: "t2",
						content: "out2",
						is_error: false,
					},
					{ type: "text", text: userText(0, "First queue msg") },
					{ type: "text", text: userText(0, "Second queue msg") },
				],
			},
		]);
	});

	test("tool_result + 2 queue messages with 2 images — caption counts total images", () => {
		const png2 =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAEnNCcKAAAAAElFTkSuQmCC";
		const events: Event[] = [
			toolResultEvent("t1", "bash", "done"),
			userMessageEvent("msg_01", "First image", {
				ts: 0,
				images: [{ base64: TINY_PNG, mediaType: "image/png" }],
			}),
			userMessageEvent("msg_02", "Second image", {
				ts: 0,
				images: [{ base64: png2, mediaType: "image/png" }],
			}),
			messagesConsumedEvent(["msg_01", "msg_02"]),
		];
		const msgs = eventsToAnthropicMessages(events);
		const content = (msgs[0] as { content: unknown[] }).content;
		// Expect: tool_result, text1, text2, image1, image2, caption
		expect(content.length).toBe(6);
		expect((content[0] as { type: string }).type).toBe("tool_result");
		expect((content[1] as { type: string; text: string }).type).toBe("text");
		expect((content[2] as { type: string; text: string }).type).toBe("text");
		expect((content[3] as { type: string }).type).toBe("image");
		expect((content[4] as { type: string }).type).toBe("image");
		expect(content[5]).toEqual({
			type: "text",
			text: "[2 image(s) attached by user]",
		});
	});

	test("tool_result + task_message queue message (mixed source types)", () => {
		const events: Event[] = [
			toolResultEvent("t1", "bash", "done"),
			taskMessageEvent("msg_01", "fromT1", "From Task", "Hello from peer", {
				ts: 0,
			}),
			messagesConsumedEvent(["msg_01"]),
		];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs).toEqual([
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "t1",
						content: "done",
						is_error: false,
					},
					{
						type: "text",
						text: taskMessageText(0, "fromT1", "From Task", "Hello from peer"),
					},
				],
			},
		]);
	});

	test("tool_result + task_complete queue message", () => {
		const events: Event[] = [
			toolResultEvent("t1", "bash", "parent check"),
			taskCompleteEvent("msg_01", "childA", "Child A", true, "all good", 0),
			messagesConsumedEvent(["msg_01"]),
		];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs).toEqual([
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "t1",
						content: "parent check",
						is_error: false,
					},
					{
						type: "text",
						text: taskCompleteText(0, "childA", "Child A", true, "all good"),
					},
				],
			},
		]);
	});
});

// ── Tests: onConsumedMessages — working context (append to existing tool_result msg) ──

describe("walker: onConsumedMessages — working context (append to prior tool_result message)", () => {
	// Working context is reached when the last message is a user message with
	// tool_result blocks, and then a STANDALONE messages_consumed event fires
	// (not absorbed into the adjacent tool_result loop). This happens when
	// something — e.g., an error/status/lifecycle event — breaks the tool_result
	// loop, so the messages_consumed event is handled by the main switch instead.

	test("tool_result → error event → standalone messages_consumed appends text to tool_result user msg", () => {
		const events: Event[] = [
			toolResultEvent("t1", "bash", "done"),
			// error event breaks the tool_result adjacency loop in walker
			{ type: "error", message: "something", taskId: "", ts: 0 },
			userMessageEvent("msg_01", "Late message", { ts: 0 }),
			messagesConsumedEvent(["msg_01"]),
		];
		const msgs = eventsToAnthropicMessages(events);
		// Expect ONE user message (tool_result + appended text block)
		expect(msgs.length).toBe(1);
		expect(msgs[0]).toEqual({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "t1",
					content: "done",
					is_error: false,
				},
				{ type: "text", text: userText(0, "Late message") },
			],
		});
	});

	test("working context with images — appends texts, images, AND caption", () => {
		const events: Event[] = [
			toolResultEvent("t1", "bash", "done"),
			{ type: "error", message: "break", taskId: "", ts: 0 },
			userMessageEvent("msg_01", "Late image msg", {
				ts: 0,
				images: [{ base64: TINY_PNG, mediaType: "image/png" }],
			}),
			messagesConsumedEvent(["msg_01"]),
		];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs).toEqual([
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "t1",
						content: "done",
						is_error: false,
					},
					{ type: "text", text: userText(0, "Late image msg") },
					{
						type: "image",
						source: {
							type: "base64",
							media_type: "image/png",
							data: TINY_PNG,
						},
					},
					{ type: "text", text: "[1 image(s) attached by user]" },
				],
			},
		]);
	});

	test("working context with ONLY images (no text messages) still appends caption", () => {
		// If imageBlocks.length > 0 but textBlocks is empty (edge case),
		// caption still appears.
		const events: Event[] = [
			toolResultEvent("t1", "bash", "done"),
			{ type: "error", message: "break", taskId: "", ts: 0 },
			messagesConsumedEvent([]),
		];
		// Note: empty messageIds → consumed returns null → onConsumedMessages never called.
		// But to simulate "image-only" we need a user message with empty content + image.
		// Let's use a real case: user message has EMPTY content string but has images.
		const events2: Event[] = [
			toolResultEvent("t1", "bash", "done"),
			{ type: "error", message: "break", taskId: "", ts: 0 },
			userMessageEvent("msg_01", "", {
				ts: 0,
				images: [{ base64: TINY_PNG, mediaType: "image/png" }],
			}),
			messagesConsumedEvent(["msg_01"]),
		];
		const msgs = eventsToAnthropicMessages(events2);
		// Expect tool_result + [timestamp] text (from formatEventForAI) + image + caption
		const content = (msgs[0] as { content: unknown[] }).content;
		expect(content.length).toBe(4);
		expect((content[0] as { type: string }).type).toBe("tool_result");
		expect((content[1] as { type: string }).type).toBe("text");
		expect((content[2] as { type: string }).type).toBe("image");
		expect(content[3]).toEqual({
			type: "text",
			text: "[1 image(s) attached by user]",
		});
		// Sanity: make sure we're not getting a SECOND user message
		expect(msgs.length).toBe(1);
		// Silence unused var
		void events;
	});
});

// ── Tests: onConsumedMessages — idle context (no prior tool_result) ──

describe("walker: onConsumedMessages — idle context (no tool_results)", () => {
	test("single text-only user message → string content (not array)", () => {
		// Critical: when exactly one text block and no images, content must be
		// a STRING, not a single-element array. Live path does this for cache
		// consistency; walker must match.
		const events: Event[] = [
			userMessageEvent("msg_01", "Just hello", { ts: 0 }),
			messagesConsumedEvent(["msg_01"]),
		];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs).toEqual([
			{ role: "user", content: userText(0, "Just hello") },
		]);
	});

	test("multiple text-only messages → content array", () => {
		const events: Event[] = [
			userMessageEvent("msg_01", "First", { ts: 0 }),
			userMessageEvent("msg_02", "Second", { ts: 0 }),
			messagesConsumedEvent(["msg_01", "msg_02"]),
		];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: userText(0, "First") },
					{ type: "text", text: userText(0, "Second") },
				],
			},
		]);
	});

	test("single user message WITH image → CAPTION APPEARS (this is the original caption bug)", () => {
		// THIS is the regression test for the actual caption bug. Before the
		// fix, the idle-context branch of onConsumedMessages dropped this
		// caption block. Its presence here is the correctness invariant.
		const events: Event[] = [
			userMessageEvent("msg_01", "Here is a screenshot", {
				ts: 0,
				images: [{ base64: TINY_PNG, mediaType: "image/png" }],
			}),
			messagesConsumedEvent(["msg_01"]),
		];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: userText(0, "Here is a screenshot") },
					{
						type: "image",
						source: {
							type: "base64",
							media_type: "image/png",
							data: TINY_PNG,
						},
					},
					{ type: "text", text: "[1 image(s) attached by user]" },
				],
			},
		]);
	});

	test("caption count matches number of images (2)", () => {
		const png2 =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAEnNCcKAAAAAElFTkSuQmCC";
		const events: Event[] = [
			userMessageEvent("msg_01", "two images", {
				ts: 0,
				images: [
					{ base64: TINY_PNG, mediaType: "image/png" },
					{ base64: png2, mediaType: "image/png" },
				],
			}),
			messagesConsumedEvent(["msg_01"]),
		];
		const msgs = eventsToAnthropicMessages(events);
		const content = (msgs[0] as { content: unknown[] }).content;
		// text, image, image, caption
		expect(content.length).toBe(4);
		expect(content[3]).toEqual({
			type: "text",
			text: "[2 image(s) attached by user]",
		});
	});

	test("images split across multiple user messages — caption counts ALL images", () => {
		const png2 =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAEnNCcKAAAAAElFTkSuQmCC";
		const events: Event[] = [
			userMessageEvent("msg_01", "First", {
				ts: 0,
				images: [{ base64: TINY_PNG, mediaType: "image/png" }],
			}),
			userMessageEvent("msg_02", "Second", {
				ts: 0,
				images: [{ base64: png2, mediaType: "image/png" }],
			}),
			messagesConsumedEvent(["msg_01", "msg_02"]),
		];
		const msgs = eventsToAnthropicMessages(events);
		const content = (msgs[0] as { content: unknown[] }).content;
		// text1, text2, image1, image2, caption
		expect(content).toEqual([
			{ type: "text", text: userText(0, "First") },
			{ type: "text", text: userText(0, "Second") },
			{
				type: "image",
				source: {
					type: "base64",
					media_type: "image/png",
					data: TINY_PNG,
				},
			},
			{
				type: "image",
				source: { type: "base64", media_type: "image/png", data: png2 },
			},
			{ type: "text", text: "[2 image(s) attached by user]" },
		]);
	});

	test("NO caption when imageBlocks.length === 0", () => {
		// Absence check: plain text messages must NOT get a caption appended.
		const events: Event[] = [
			userMessageEvent("msg_01", "no image here", { ts: 0 }),
			messagesConsumedEvent(["msg_01"]),
		];
		const msgs = eventsToAnthropicMessages(events);
		// Single text → string content, no caption anywhere
		expect(msgs).toEqual([
			{ role: "user", content: userText(0, "no image here") },
		]);
		// Also verify content is NOT an array containing caption
		const content = (msgs[0] as { content: unknown }).content;
		expect(typeof content).toBe("string");
		expect(content).not.toContain("image(s) attached");
	});

	test("NO caption for pure text multi-message batch", () => {
		const events: Event[] = [
			userMessageEvent("msg_01", "First", { ts: 0 }),
			userMessageEvent("msg_02", "Second", { ts: 0 }),
			userMessageEvent("msg_03", "Third", { ts: 0 }),
			messagesConsumedEvent(["msg_01", "msg_02", "msg_03"]),
		];
		const msgs = eventsToAnthropicMessages(events);
		const content = (msgs[0] as { content: Array<{ text: string }> }).content;
		for (const block of content) {
			expect(block.text).not.toContain("image(s) attached");
		}
	});

	test("mixed source queue messages → each gets its own text block", () => {
		const events: Event[] = [
			userMessageEvent("msg_01", "user msg", { ts: 0 }),
			taskMessageEvent("msg_02", "fromT", "From Task", "task msg", { ts: 0 }),
			taskCompleteEvent("msg_03", "childX", "Child X", true, "done", 0),
			messagesConsumedEvent(["msg_01", "msg_02", "msg_03"]),
		];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: userText(0, "user msg") },
					{
						type: "text",
						text: taskMessageText(0, "fromT", "From Task", "task msg"),
					},
					{
						type: "text",
						text: taskCompleteText(0, "childX", "Child X", true, "done"),
					},
				],
			},
		]);
	});
});

// ── Tests: end-to-end sequences (assistant turn + tool_result + queue) ──

describe("walker: full turn sequences", () => {
	test("assistant turn → tool_result → assistant turn → done", () => {
		const events: Event[] = [
			assistantTextEvent("Let me check."),
			toolCallEvent("t1", "bash", { command: "ls" }),
			toolResultEvent("t1", "bash", "file1\nfile2"),
			assistantTextEvent("Found files."),
			toolCallEvent("t2", "mcp__mxd__done", {
				status: "passed",
				summary: "found",
			}),
		];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs.length).toBe(3);
		// Msg 0: assistant turn 1
		expect(msgs[0]).toEqual({
			role: "assistant",
			content: [
				{ type: "text", text: "Let me check." },
				{
					type: "tool_use",
					id: "t1",
					name: "bash",
					input: { command: "ls" },
					caller: { type: "direct" },
				},
			],
		});
		// Msg 1: tool_result (user role)
		expect(msgs[1]).toEqual({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "t1",
					content: "file1\nfile2",
					is_error: false,
				},
			],
		});
		// Msg 2: assistant turn 2
		expect(msgs[2]).toEqual({
			role: "assistant",
			content: [
				{ type: "text", text: "Found files." },
				{
					type: "tool_use",
					id: "t2",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "found" },
					caller: { type: "direct" },
				},
			],
		});
	});

	test("end_turn text → user message arrives (idle context)", () => {
		const events: Event[] = [
			assistantTextEvent("Waiting for input."),
			userMessageEvent("msg_01", "Here you go", { ts: 0 }),
			messagesConsumedEvent(["msg_01"]),
		];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs.length).toBe(2);
		expect(msgs[0]).toEqual({
			role: "assistant",
			content: [{ type: "text", text: "Waiting for input." }],
		});
		expect(msgs[1]).toEqual({
			role: "user",
			content: userText(0, "Here you go"),
		});
	});

	test("tool cycle → idle user message → another assistant turn", () => {
		const events: Event[] = [
			// Turn 1: tool call
			assistantTextEvent("Running."),
			toolCallEvent("t1", "bash", { command: "pwd" }),
			// tool result
			toolResultEvent("t1", "bash", "/tmp"),
			// Turn 2: plain text, end_turn
			assistantTextEvent("Done for now."),
			// Idle: user message arrives
			userMessageEvent("msg_01", "Keep going", { ts: 0 }),
			messagesConsumedEvent(["msg_01"]),
		];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs.length).toBe(4);
		expect((msgs[3] as { role: string }).role).toBe("user");
		// The idle user message should be string content (single text block)
		expect((msgs[3] as { content: unknown }).content).toBe(
			userText(0, "Keep going"),
		);
	});

	test("fork_marker between tool_results gets injected as interleaved text", () => {
		// fork_marker is a structural event that should appear as an interleaved
		// text block between tool_results. Walker handles it specially.
		const events: Event[] = [
			toolResultEvent("t1", "bash", "before fork"),
			{
				type: "fork_marker",
				sourceTaskId: "source-task",
				targetTitle: "Target Task",
				targetDescription: "Work on X",
				taskId: "",
				ts: 0,
			},
		];
		const msgs = eventsToAnthropicMessages(events);
		const content = (
			msgs[0] as {
				content: Array<{ type: string; text?: string }>;
			}
		).content;
		// Expect: tool_result, then text block with fork_marker content
		expect(content.length).toBe(2);
		expect(content[0]?.type).toBe("tool_result");
		expect(content[1]?.type).toBe("text");
		expect(content[1]?.text).toContain("<fork_marker");
		expect(content[1]?.text).toContain('source="source-task"');
		expect(content[1]?.text).toContain('task="Target Task"');
		expect(content[1]?.text).toContain("Work on X");
		expect(content[1]?.text).toContain("</fork_marker>");
	});

	// compacted_resume in middle test removed — event type no longer exists.
	// Content now flows through message path with source: "compacted_resume".
});

// ── Tests: skipped events (ensure walker doesn't accidentally render them) ──

describe("walker: skipped events", () => {
	test("session_config is skipped", () => {
		const events: Event[] = [
			{
				type: "session_config",
				tools: [],
				systemStable: "stable",
				systemVariable: "variable",
				taskId: "",
				ts: 0,
			},
			assistantTextEvent("hi"),
		];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs.length).toBe(1);
	});

	test("compact_marker is skipped", () => {
		const events: Event[] = [
			{
				type: "compact_marker",
				savedTokens: 100,
				taskId: "",
				ts: 0,
			},
			assistantTextEvent("hi"),
		];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs.length).toBe(1);
	});

	test("lifecycle events skipped (agent_idle, status, error)", () => {
		const events: Event[] = [
			{ type: "agent_idle", taskId: "", ts: 0 },
			{ type: "status", message: "x", taskId: "", ts: 0 },
			{ type: "error", message: "x", taskId: "", ts: 0 },
			assistantTextEvent("hi"),
		];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs.length).toBe(1);
	});

	test("message event without id is rendered immediately (no deferral)", () => {
		// Messages WITHOUT an id are rendered directly via onUserMessage.
		// This is the "raw" path (rarely used — compacted_resume etc. are not
		// messages). Verify the walker handles it.
		const events: Event[] = [
			{
				type: "message",
				id: "",
				taskId: "",
				ts: 0,
				body: {
					source: "user",
					id: "",
					ts: 0,
					content: "immediate content",
				},
			},
		];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs.length).toBe(1);
		// Rendered via onUserMessage → { role: "user", content }
		// content = formatEventForAI(event) — includes [HH:MM:SS] prefix
		expect(msgs[0]).toEqual({
			role: "user",
			content: userText(0, "immediate content"),
		});
	});
});

// ── Tests: empty/defensive cases ──

describe("walker: empty and defensive cases", () => {
	test("empty events array returns empty messages", () => {
		expect(eventsToAnthropicMessages([])).toEqual([]);
	});

	test("messages_consumed with no resolvable messages → no-op", () => {
		// If messageIds don't resolve (not in eventIndex), walker should not
		// crash and should not add an empty user message.
		const events: Event[] = [
			messagesConsumedEvent(["missing_id_01", "missing_id_02"]),
		];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs.length).toBe(0);
	});

	test("assistant_text with empty string still creates block", () => {
		const events: Event[] = [assistantTextEvent("")];
		const msgs = eventsToAnthropicMessages(events);
		expect(msgs.length).toBe(1);
		expect(msgs[0]).toEqual({
			role: "assistant",
			content: [{ type: "text", text: "" }],
		});
	});
});
