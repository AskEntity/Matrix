import { describe, expect, test } from "bun:test";
import {
	type Event,
	eventsToAnthropicMessages,
	eventsToOpenAIMessages,
	formatQueueMessageEvent,
	type QueueMessageEvent,
	queueMessageToEvent,
} from "./events.ts";

describe("queueMessageToEvent", () => {
	test("converts user message", () => {
		const event = queueMessageToEvent({
			source: "user",
			content: "hello",
			images: [{ base64: "abc", mediaType: "image/png" }],
		});
		expect(event.type).toBe("queue_message");
		expect(event.source).toBe("user");
		expect((event as { content: string }).content).toBe("hello");
		expect((event as { images: unknown[] }).images).toHaveLength(1);
	});

	test("converts child_complete", () => {
		const event = queueMessageToEvent({
			source: "child_complete",
			taskId: "t1",
			title: "Auth",
			success: true,
			output: "done",
		});
		expect(event.source).toBe("child_complete");
		expect((event as { taskId: string }).taskId).toBe("t1");
	});

	test("converts compact", () => {
		const event = queueMessageToEvent({ source: "compact" });
		expect(event.source).toBe("compact");
	});
});

describe("formatQueueMessageEvent", () => {
	test("formats user message", () => {
		const event: QueueMessageEvent = {
			type: "queue_message",
			source: "user",
			content: "Hello world",
			ts: 1000,
		};
		expect(formatQueueMessageEvent(event)).toBe("Hello world");
	});

	test("formats child_complete", () => {
		const event: QueueMessageEvent = {
			type: "queue_message",
			source: "child_complete",
			taskId: "t1",
			title: "Auth",
			success: true,
			output: "All tests pass",
			ts: 1000,
		};
		expect(formatQueueMessageEvent(event)).toBe(
			'<child_complete task="Auth" id="t1" status="passed">All tests pass</child_complete>',
		);
	});

	test("formats parent_update with requestReply", () => {
		const event: QueueMessageEvent = {
			type: "queue_message",
			source: "parent_update",
			content: "What status?",
			requestReply: true,
			ts: 1000,
		};
		expect(formatQueueMessageEvent(event)).toBe(
			'<parent_update requestReply="true">What status?</parent_update>',
		);
	});

	test("formats clarify_response", () => {
		const event: QueueMessageEvent = {
			type: "queue_message",
			source: "clarify_response",
			answer: "Yes",
			ts: 1000,
		};
		expect(formatQueueMessageEvent(event)).toBe("Yes");
	});

	test("formats compact", () => {
		const event: QueueMessageEvent = {
			type: "queue_message",
			source: "compact",
			ts: 1000,
		};
		expect(formatQueueMessageEvent(event)).toBe("Manual compaction requested");
	});
});

describe("eventsToAnthropicMessages", () => {
	test("returns empty array for no events", () => {
		expect(eventsToAnthropicMessages([])).toEqual([]);
	});

	test("converts user_message", () => {
		const events: Event[] = [
			{ type: "user_message", content: "Hello world", ts: 1000 },
		];
		expect(eventsToAnthropicMessages(events)).toEqual([
			{ role: "user", content: "Hello world" },
		]);
	});

	test("converts compacted_resume", () => {
		const events: Event[] = [
			{
				type: "compacted_resume",
				content: "Checkpoint summary",
				cwd: "/tmp",
				ts: 1000,
			},
		];
		expect(eventsToAnthropicMessages(events)).toEqual([
			{ role: "user", content: "Checkpoint summary" },
		]);
	});

	test("converts summarization_request", () => {
		const events: Event[] = [
			{ type: "summarization_request", instruction: "Summarize now", ts: 1000 },
		];
		expect(eventsToAnthropicMessages(events)).toEqual([
			{ role: "user", content: "Summarize now" },
		]);
	});

	test("converts budget_warning", () => {
		const events: Event[] = [
			{ type: "budget_warning", warning: "⚠️ Over budget", ts: 1000 },
		];
		expect(eventsToAnthropicMessages(events)).toEqual([
			{ role: "user", content: "⚠️ Over budget" },
		]);
	});

	test("converts assistant_text only → array content format", () => {
		const events: Event[] = [
			{ type: "assistant_text", content: "I'll help you.", ts: 1000 },
		];
		expect(eventsToAnthropicMessages(events)).toEqual([
			{
				role: "assistant",
				content: [{ type: "text", text: "I'll help you." }],
			},
		]);
	});

	test("converts assistant_text + tool_calls → single assistant message", () => {
		const events: Event[] = [
			{ type: "assistant_text", content: "Let me check.", ts: 1000 },
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "tc1",
				input: { command: "ls" },
				ts: 1001,
			},
			{
				type: "tool_call",
				tool: "read_file",
				toolCallId: "tc2",
				input: { path: "src/main.ts" },
				ts: 1002,
			},
		];
		expect(eventsToAnthropicMessages(events)).toEqual([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Let me check." },
					{
						type: "tool_use",
						id: "tc1",
						name: "bash",
						input: { command: "ls" },
						caller: { type: "direct" },
					},
					{
						type: "tool_use",
						id: "tc2",
						name: "read_file",
						input: { path: "src/main.ts" },
						caller: { type: "direct" },
					},
				],
			},
		]);
	});

	test("converts tool_calls without assistant_text", () => {
		const events: Event[] = [
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "tc1",
				input: { command: "echo hi" },
				ts: 1000,
			},
		];
		expect(eventsToAnthropicMessages(events)).toEqual([
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "tc1",
						name: "bash",
						input: { command: "echo hi" },
						caller: { type: "direct" },
					},
				],
			},
		]);
	});

	test("converts tool_results → single user message", () => {
		const events: Event[] = [
			{
				type: "tool_result",
				toolCallId: "tc1",
				content: "file1.ts\nfile2.ts",
				isError: false,
				ts: 1000,
			},
			{
				type: "tool_result",
				toolCallId: "tc2",
				content: "contents of file",
				isError: false,
				ts: 1001,
			},
		];
		expect(eventsToAnthropicMessages(events)).toEqual([
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tc1",
						content: "file1.ts\nfile2.ts",
						is_error: false,
					},
					{
						type: "tool_result",
						tool_use_id: "tc2",
						content: "contents of file",
						is_error: false,
					},
				],
			},
		]);
	});

	test("tool_results with images embeds images inside tool_result content", () => {
		const events: Event[] = [
			{
				type: "tool_result",
				toolCallId: "tc1",
				content: "screenshot taken",
				isError: false,
				images: [{ base64: "abc123", mediaType: "image/png" }],
				ts: 1000,
			},
		];
		expect(eventsToAnthropicMessages(events)).toEqual([
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tc1",
						content: [
							{
								type: "image",
								source: {
									type: "base64",
									media_type: "image/png",
									data: "abc123",
								},
							},
							{ type: "text", text: "screenshot taken" },
						],
					},
				],
			},
		]);
	});

	test("queue_messages between tool_results merge into user message", () => {
		const events: Event[] = [
			{
				type: "tool_result",
				toolCallId: "tc1",
				content: "ok",
				isError: false,
				ts: 1000,
			},
			{
				type: "queue_message",
				source: "parent_update",
				content: "New instructions here",
				ts: 1001,
			},
			{
				type: "tool_result",
				toolCallId: "tc2",
				content: "done",
				isError: false,
				ts: 1002,
			},
		];
		expect(eventsToAnthropicMessages(events)).toEqual([
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tc1",
						content: "ok",
						is_error: false,
					},
					{
						type: "text",
						text: "[Messages received while you were working:]\n<parent_update>New instructions here</parent_update>",
					},
					{
						type: "tool_result",
						tool_use_id: "tc2",
						content: "done",
						is_error: false,
					},
				],
			},
		]);
	});

	test("standalone queue_message → user message with idle wrapper", () => {
		const events: Event[] = [
			{
				type: "queue_message",
				source: "user",
				content: "Please check this",
				ts: 1000,
			},
		];
		expect(eventsToAnthropicMessages(events)).toEqual([
			{
				role: "user",
				content: "[Messages received while you were idle:]\nPlease check this",
			},
		]);
	});

	test("compact_marker is skipped", () => {
		const events: Event[] = [
			{ type: "user_message", content: "hello", ts: 1000 },
			{
				type: "compact_marker",
				checkpoint: "summary",
				savedTokens: 5000,
				ts: 2000,
			},
			{ type: "compacted_resume", content: "summary", ts: 2001 },
		];
		expect(eventsToAnthropicMessages(events)).toEqual([
			{ role: "user", content: "hello" },
			{ role: "user", content: "summary" },
		]);
	});

	test("full conversation: user → assistant+tools → results → assistant", () => {
		const events: Event[] = [
			{
				type: "user_message",
				content: "Working directory: /tmp\n\nBuild a feature",
				cwd: "/tmp",
				ts: 1000,
			},
			{ type: "assistant_text", content: "I'll build that.", ts: 1001 },
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "tu_1",
				input: { command: "echo hi" },
				ts: 1002,
			},
			{
				type: "tool_result",
				toolCallId: "tu_1",
				content: "hi\n",
				isError: false,
				ts: 1003,
			},
			{ type: "assistant_text", content: "Done!", ts: 1004 },
		];

		const messages = eventsToAnthropicMessages(events);
		expect(messages).toHaveLength(4);
		expect(messages[0]).toEqual({
			role: "user",
			content: "Working directory: /tmp\n\nBuild a feature",
		});
		expect(messages[1]).toEqual({
			role: "assistant",
			content: [
				{ type: "text", text: "I'll build that." },
				{
					type: "tool_use",
					id: "tu_1",
					name: "bash",
					input: { command: "echo hi" },
					caller: { type: "direct" },
				},
			],
		});
		expect(messages[2]).toEqual({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "tu_1",
					content: "hi\n",
					is_error: false,
				},
			],
		});
		expect(messages[3]).toEqual({
			role: "assistant",
			content: [{ type: "text", text: "Done!" }],
		});
	});

	test("compaction scenario: compacted_resume + continuation", () => {
		const events: Event[] = [
			{
				type: "compacted_resume",
				content: "## Checkpoint\n\nCompleted steps 1-3.",
				cwd: "/tmp",
				ts: 2000,
			},
			{
				type: "assistant_text",
				content: "Continuing from checkpoint.",
				ts: 2001,
			},
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "tc1",
				input: { command: "ls" },
				ts: 2002,
			},
			{
				type: "tool_result",
				toolCallId: "tc1",
				content: "src/",
				isError: false,
				ts: 2003,
			},
			{
				type: "assistant_text",
				content: "Found the source directory.",
				ts: 2004,
			},
		];

		const messages = eventsToAnthropicMessages(events);
		expect(messages).toHaveLength(4);
		expect(messages[0]).toEqual({
			role: "user",
			content: "## Checkpoint\n\nCompleted steps 1-3.",
		});
	});

	test("tool_result with error flag", () => {
		const events: Event[] = [
			{
				type: "tool_result",
				toolCallId: "tc1",
				content: "Command failed with exit code 1",
				isError: true,
				ts: 1000,
			},
		];
		expect(eventsToAnthropicMessages(events)).toEqual([
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tc1",
						content: "Command failed with exit code 1",
						is_error: true,
					},
				],
			},
		]);
	});

	test("multiple images from multiple tool_results embedded in each", () => {
		const events: Event[] = [
			{
				type: "tool_result",
				toolCallId: "tc1",
				content: "screenshot 1",
				isError: false,
				images: [{ base64: "img1", mediaType: "image/png" }],
				ts: 1000,
			},
			{
				type: "tool_result",
				toolCallId: "tc2",
				content: "screenshot 2",
				isError: false,
				images: [{ base64: "img2", mediaType: "image/jpeg" }],
				ts: 1001,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toHaveLength(1);
		const content = (messages[0] as { content: unknown[] }).content;
		expect(content).toHaveLength(2);
		expect(content[0]).toEqual({
			type: "tool_result",
			tool_use_id: "tc1",
			content: [
				{
					type: "image",
					source: { type: "base64", media_type: "image/png", data: "img1" },
				},
				{ type: "text", text: "screenshot 1" },
			],
		});
	});

	test("queue_message with images between tool_results", () => {
		const events: Event[] = [
			{
				type: "tool_result",
				toolCallId: "tc1",
				content: "ok",
				isError: false,
				ts: 1000,
			},
			{
				type: "queue_message",
				source: "user",
				content: "Look at this",
				images: [{ base64: "qimg", mediaType: "image/png" }],
				ts: 1001,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toHaveLength(1);
		const content = (messages[0] as { content: unknown[] }).content;
		// 1 tool_result + 1 text (queue msg) + 1 image + 1 annotation
		expect(content).toHaveLength(4);
		expect(content[1]).toEqual({
			type: "text",
			text: "[Messages received while you were working:]\nLook at this",
		});
		expect(content[2]).toEqual({
			type: "image",
			source: { type: "base64", media_type: "image/png", data: "qimg" },
		});
		expect(content[3]).toEqual({
			type: "text",
			text: "[1 image(s) attached by user]",
		});
	});

	test("tool images and queue images separated correctly", () => {
		const events: Event[] = [
			{
				type: "tool_result",
				toolCallId: "tc1",
				content: "screenshot captured",
				isError: false,
				images: [{ base64: "tool_img", mediaType: "image/png" }],
				ts: 1000,
			},
			{
				type: "queue_message",
				source: "user",
				content: "Check this out",
				images: [{ base64: "user_img", mediaType: "image/jpeg" }],
				ts: 1001,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toHaveLength(1);
		const content = (messages[0] as { content: unknown[] }).content;
		expect(content).toHaveLength(4);
		// Tool images embedded INSIDE tool_result content
		expect(content[0]).toEqual({
			type: "tool_result",
			tool_use_id: "tc1",
			content: [
				{
					type: "image",
					source: {
						type: "base64",
						media_type: "image/png",
						data: "tool_img",
					},
				},
				{ type: "text", text: "screenshot captured" },
			],
		});
		// Queue message text
		expect(content[1]).toEqual({
			type: "text",
			text: "[Messages received while you were working:]\nCheck this out",
		});
		// Queue images as sibling blocks with annotation
		expect(content[2]).toEqual({
			type: "image",
			source: {
				type: "base64",
				media_type: "image/jpeg",
				data: "user_img",
			},
		});
		expect(content[3]).toEqual({
			type: "text",
			text: "[1 image(s) attached by user]",
		});
	});

	test("handles resume user_message", () => {
		const events: Event[] = [
			{
				type: "user_message",
				content: "Continue the task",
				isResume: true,
				ts: 1000,
			},
		];
		expect(eventsToAnthropicMessages(events)).toEqual([
			{ role: "user", content: "Continue the task" },
		]);
	});
});

describe("eventsToOpenAIMessages", () => {
	test("returns empty array for no events", () => {
		expect(eventsToOpenAIMessages([])).toEqual([]);
	});

	test("converts user_message", () => {
		const events: Event[] = [
			{ type: "user_message", content: "Hello world", ts: 1000 },
		];
		expect(eventsToOpenAIMessages(events)).toEqual([
			{ role: "user", content: "Hello world" },
		]);
	});

	test("converts compacted_resume", () => {
		const events: Event[] = [
			{
				type: "compacted_resume",
				content: "Checkpoint summary",
				cwd: "/tmp",
				ts: 1000,
			},
		];
		expect(eventsToOpenAIMessages(events)).toEqual([
			{ role: "user", content: "Checkpoint summary" },
		]);
	});

	test("converts summarization_request", () => {
		const events: Event[] = [
			{ type: "summarization_request", instruction: "Summarize now", ts: 1000 },
		];
		expect(eventsToOpenAIMessages(events)).toEqual([
			{ role: "user", content: "Summarize now" },
		]);
	});

	test("converts budget_warning", () => {
		const events: Event[] = [
			{ type: "budget_warning", warning: "⚠️ Over budget", ts: 1000 },
		];
		expect(eventsToOpenAIMessages(events)).toEqual([
			{ role: "user", content: "⚠️ Over budget" },
		]);
	});

	test("converts assistant_text only → content string, no tool_calls", () => {
		const events: Event[] = [
			{ type: "assistant_text", content: "I'll help you.", ts: 1000 },
		];
		expect(eventsToOpenAIMessages(events)).toEqual([
			{ role: "assistant", content: "I'll help you." },
		]);
	});

	test("converts assistant_text + tool_calls → single message with tool_calls array", () => {
		const events: Event[] = [
			{ type: "assistant_text", content: "Let me check.", ts: 1000 },
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "call_1",
				input: { command: "ls" },
				ts: 1001,
			},
			{
				type: "tool_call",
				tool: "read_file",
				toolCallId: "call_2",
				input: { path: "src/main.ts" },
				ts: 1002,
			},
		];
		expect(eventsToOpenAIMessages(events)).toEqual([
			{
				role: "assistant",
				content: "Let me check.",
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: {
							name: "bash",
							arguments: JSON.stringify({ command: "ls" }),
						},
					},
					{
						id: "call_2",
						type: "function",
						function: {
							name: "read_file",
							arguments: JSON.stringify({ path: "src/main.ts" }),
						},
					},
				],
			},
		]);
	});

	test("converts tool_calls without assistant_text → null content", () => {
		const events: Event[] = [
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "call_1",
				input: { command: "echo hi" },
				ts: 1000,
			},
		];
		expect(eventsToOpenAIMessages(events)).toEqual([
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: {
							name: "bash",
							arguments: JSON.stringify({ command: "echo hi" }),
						},
					},
				],
			},
		]);
	});

	test("converts tool_results → individual tool messages with name lookup", () => {
		const events: Event[] = [
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "call_1",
				input: { command: "ls" },
				ts: 1000,
			},
			{
				type: "tool_result",
				toolCallId: "call_1",
				content: "file1.ts\nfile2.ts",
				isError: false,
				ts: 1001,
			},
		];
		const messages = eventsToOpenAIMessages(events);
		expect(messages[1]).toEqual({
			role: "tool",
			tool_call_id: "call_1",
			name: "bash",
			content: "file1.ts\nfile2.ts",
		});
	});

	test("tool_result uses 'unknown' when tool_call not found", () => {
		const events: Event[] = [
			{
				type: "tool_result",
				toolCallId: "orphan_call",
				content: "result",
				isError: false,
				ts: 1000,
			},
		];
		expect(eventsToOpenAIMessages(events)).toEqual([
			{
				role: "tool",
				tool_call_id: "orphan_call",
				name: "unknown",
				content: "result",
			},
		]);
	});

	test("tool_results with images → separate user message with tool content as label", () => {
		const events: Event[] = [
			{
				type: "tool_call",
				tool: "take_screenshot",
				toolCallId: "call_1",
				input: {},
				ts: 1000,
			},
			{
				type: "tool_result",
				toolCallId: "call_1",
				content: "screenshot taken",
				isError: false,
				images: [{ base64: "abc123", mediaType: "image/png" }],
				ts: 1001,
			},
		];
		const messages = eventsToOpenAIMessages(events);
		expect(messages).toHaveLength(3);
		expect(messages[2]).toEqual({
			role: "user",
			content: [
				{ type: "text", text: "screenshot taken" },
				{
					type: "image_url",
					image_url: {
						url: "data:image/png;base64,abc123",
						detail: "auto",
					},
				},
			],
		});
	});

	test("queue_message between tool_results appends to last tool content", () => {
		const events: Event[] = [
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "call_1",
				input: { command: "ls" },
				ts: 1000,
			},
			{
				type: "tool_call",
				tool: "read_file",
				toolCallId: "call_2",
				input: { path: "a.ts" },
				ts: 1001,
			},
			{
				type: "tool_result",
				toolCallId: "call_1",
				content: "ok",
				isError: false,
				ts: 1002,
			},
			{
				type: "queue_message",
				source: "parent_update",
				content: "New instructions",
				ts: 1003,
			},
			{
				type: "tool_result",
				toolCallId: "call_2",
				content: "done",
				isError: false,
				ts: 1004,
			},
		];
		const messages = eventsToOpenAIMessages(events);
		expect(messages).toHaveLength(3);
		// Queue message should be appended to the first tool result
		expect((messages[1] as { content: string }).content).toContain(
			"<parent_update>New instructions</parent_update>",
		);
		expect((messages[1] as { content: string }).content).toContain(
			"[Messages received while you were working:]",
		);
	});

	test("compact_marker is skipped", () => {
		const events: Event[] = [
			{ type: "user_message", content: "hello", ts: 1000 },
			{
				type: "compact_marker",
				checkpoint: "summary",
				savedTokens: 5000,
				ts: 2000,
			},
			{ type: "compacted_resume", content: "summary", ts: 2001 },
		];
		expect(eventsToOpenAIMessages(events)).toEqual([
			{ role: "user", content: "hello" },
			{ role: "user", content: "summary" },
		]);
	});

	test("full conversation: user → assistant+tools → results → assistant", () => {
		const events: Event[] = [
			{
				type: "user_message",
				content: "Working directory: /tmp\n\nBuild a feature",
				cwd: "/tmp",
				ts: 1000,
			},
			{ type: "assistant_text", content: "I'll build that.", ts: 1001 },
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "call_1",
				input: { command: "echo hi" },
				ts: 1002,
			},
			{
				type: "tool_result",
				toolCallId: "call_1",
				content: "hi\n",
				isError: false,
				ts: 1003,
			},
			{ type: "assistant_text", content: "Done!", ts: 1004 },
		];

		const messages = eventsToOpenAIMessages(events);
		expect(messages).toHaveLength(4);
		expect(messages[0]).toEqual({
			role: "user",
			content: "Working directory: /tmp\n\nBuild a feature",
		});
		expect(messages[1]).toEqual({
			role: "assistant",
			content: "I'll build that.",
			tool_calls: [
				{
					id: "call_1",
					type: "function",
					function: {
						name: "bash",
						arguments: JSON.stringify({ command: "echo hi" }),
					},
				},
			],
		});
		expect(messages[2]).toEqual({
			role: "tool",
			tool_call_id: "call_1",
			name: "bash",
			content: "hi\n",
		});
		expect(messages[3]).toEqual({
			role: "assistant",
			content: "Done!",
		});
	});

	test("handles resume user_message", () => {
		const events: Event[] = [
			{
				type: "user_message",
				content: "Continue the task",
				isResume: true,
				ts: 1000,
			},
		];
		expect(eventsToOpenAIMessages(events)).toEqual([
			{ role: "user", content: "Continue the task" },
		]);
	});

	test("multiple tool_results with images from different tools", () => {
		const events: Event[] = [
			{
				type: "tool_call",
				tool: "screenshot1",
				toolCallId: "call_1",
				input: {},
				ts: 1000,
			},
			{
				type: "tool_call",
				tool: "screenshot2",
				toolCallId: "call_2",
				input: {},
				ts: 1001,
			},
			{
				type: "tool_result",
				toolCallId: "call_1",
				content: "shot1",
				isError: false,
				images: [{ base64: "img1", mediaType: "image/png" }],
				ts: 1002,
			},
			{
				type: "tool_result",
				toolCallId: "call_2",
				content: "shot2",
				isError: false,
				images: [{ base64: "img2", mediaType: "image/jpeg" }],
				ts: 1003,
			},
		];
		const messages = eventsToOpenAIMessages(events);
		expect(messages).toHaveLength(4);
		const imgMsg = messages[3] as { content: unknown[] };
		expect(imgMsg.content).toHaveLength(4);
	});

	test("compaction scenario: compacted_resume + continuation", () => {
		const events: Event[] = [
			{
				type: "compacted_resume",
				content: "## Checkpoint\n\nCompleted steps 1-3.",
				cwd: "/tmp",
				ts: 2000,
			},
			{
				type: "assistant_text",
				content: "Continuing from checkpoint.",
				ts: 2001,
			},
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "call_1",
				input: { command: "ls" },
				ts: 2002,
			},
			{
				type: "tool_result",
				toolCallId: "call_1",
				content: "src/",
				isError: false,
				ts: 2003,
			},
			{
				type: "assistant_text",
				content: "Found the source directory.",
				ts: 2004,
			},
		];

		const messages = eventsToOpenAIMessages(events);
		expect(messages).toHaveLength(4);
		expect(messages[0]).toEqual({
			role: "user",
			content: "## Checkpoint\n\nCompleted steps 1-3.",
		});
	});

	test("tool_result with error flag", () => {
		const events: Event[] = [
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "call_1",
				input: { command: "exit 1" },
				ts: 1000,
			},
			{
				type: "tool_result",
				toolCallId: "call_1",
				content: "Command failed with exit code 1",
				isError: true,
				ts: 1001,
			},
		];
		const messages = eventsToOpenAIMessages(events);
		expect(messages[1]).toEqual({
			role: "tool",
			tool_call_id: "call_1",
			name: "bash",
			content: "Command failed with exit code 1",
		});
	});
});

// ── Bug fix regression tests ──

describe("eventsToAnthropicMessages — converter bug fixes", () => {
	test("Bug 1: assistant text-only must use array content format (not bare string)", () => {
		const events: Event[] = [
			{ type: "user_message", content: "Hello", ts: 1000 },
			{ type: "assistant_text", content: "Hi there!", ts: 1001 },
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages[1]).toEqual({
			role: "assistant",
			content: [{ type: "text", text: "Hi there!" }],
		});
	});

	test("Bug 1: multiple assistant_text blocks still produce array format", () => {
		const events: Event[] = [
			{ type: "assistant_text", content: "First paragraph.", ts: 1000 },
			{ type: "assistant_text", content: "Second paragraph.", ts: 1001 },
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages[0]).toEqual({
			role: "assistant",
			content: [
				{ type: "text", text: "First paragraph." },
				{ type: "text", text: "Second paragraph." },
			],
		});
	});

	test("Bug 1: assistant_text + tool_calls still produce array format (unchanged)", () => {
		const events: Event[] = [
			{ type: "assistant_text", content: "Let me check.", ts: 1000 },
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "tc1",
				input: { command: "ls" },
				ts: 1001,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages[0]).toEqual({
			role: "assistant",
			content: [
				{ type: "text", text: "Let me check." },
				{
					type: "tool_use",
					id: "tc1",
					name: "bash",
					input: { command: "ls" },
					caller: { type: "direct" },
				},
			],
		});
	});

	test("Bug 2: standalone queue_message formats from structured data", () => {
		// Standalone queue_message events (from implicit yield drain) should:
		// - Use "[Messages received while you were idle:]"
		// - Format content from structured fields via formatQueueMessageEvent
		const events: Event[] = [
			{
				type: "queue_message",
				source: "user",
				content: "Hello from user",
				ts: 1000,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages[0]).toEqual({
			role: "user",
			content: "[Messages received while you were idle:]\nHello from user",
		});
	});

	test("Bug 2: multiple queue_messages are joined and wrapped correctly", () => {
		const events: Event[] = [
			{
				type: "queue_message",
				source: "user",
				content: "First message",
				ts: 1000,
			},
			{
				type: "queue_message",
				source: "parent_update",
				content: "Second message",
				ts: 1001,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages[0]).toEqual({
			role: "user",
			content:
				"[Messages received while you were idle:]\nFirst message\n<parent_update>Second message</parent_update>",
		});
	});

	test("Bug 2: queue_message with images uses array content format", () => {
		const events: Event[] = [
			{
				type: "queue_message",
				source: "user",
				content: "Check this image",
				images: [{ base64: "abc123", mediaType: "image/png" }],
				ts: 1000,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages[0]).toEqual({
			role: "user",
			content: [
				{
					type: "text",
					text: "[Messages received while you were idle:]\nCheck this image",
				},
				{
					type: "image",
					source: {
						type: "base64",
						media_type: "image/png",
						data: "abc123",
					},
				},
			],
		});
	});

	test("Bug fix: queue_message between tool_results uses working wrapper", () => {
		const events: Event[] = [
			{
				type: "tool_result",
				toolCallId: "tc1",
				content: "ok",
				isError: false,
				ts: 1000,
			},
			{
				type: "queue_message",
				source: "parent_update",
				content: "New instructions",
				ts: 1001,
			},
			{
				type: "tool_result",
				toolCallId: "tc2",
				content: "done",
				isError: false,
				ts: 1002,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toHaveLength(1);
		const content = (messages[0] as { content: unknown[] }).content;
		expect(content).toHaveLength(3);
		expect(content[1]).toEqual({
			type: "text",
			text: "[Messages received while you were working:]\n<parent_update>New instructions</parent_update>",
		});
	});
});
