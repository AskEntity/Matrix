import { describe, expect, test } from "bun:test";
import {
	type CanonicalEvent,
	eventsToAnthropicMessages,
	eventsToOpenAIMessages,
	type StrongEvent,
	strongEventsToAnthropicMessages,
} from "./canonical-events.ts";

describe("eventsToAnthropicMessages", () => {
	test("returns empty array for no events", () => {
		expect(eventsToAnthropicMessages([])).toEqual([]);
	});

	test("converts user_message event", () => {
		const events: CanonicalEvent[] = [
			{ type: "user_message", content: "Hello world" },
		];
		expect(eventsToAnthropicMessages(events)).toEqual([
			{ role: "user", content: "Hello world" },
		]);
	});

	test("converts user_message with cwd (cwd already baked into content)", () => {
		const events: CanonicalEvent[] = [
			{
				type: "user_message",
				content: "Working directory: /tmp/test\n\nHello",
				cwd: "/tmp/test",
			},
		];
		expect(eventsToAnthropicMessages(events)).toEqual([
			{ role: "user", content: "Working directory: /tmp/test\n\nHello" },
		]);
	});

	test("converts compacted_resume event", () => {
		const events: CanonicalEvent[] = [
			{ type: "compacted_resume", content: "Checkpoint summary here" },
		];
		expect(eventsToAnthropicMessages(events)).toEqual([
			{ role: "user", content: "Checkpoint summary here" },
		]);
	});

	test("converts summarization_request event", () => {
		const events: CanonicalEvent[] = [
			{ type: "summarization_request", instruction: "Summarize now" },
		];
		expect(eventsToAnthropicMessages(events)).toEqual([
			{ role: "user", content: "Summarize now" },
		]);
	});

	test("converts assistant_response event", () => {
		const content = [{ type: "text", text: "I'll help you with that." }];
		const events: CanonicalEvent[] = [{ type: "assistant_response", content }];
		expect(eventsToAnthropicMessages(events)).toEqual([
			{ role: "assistant", content },
		]);
	});

	test("converts queue_messages without images", () => {
		const events: CanonicalEvent[] = [
			{ type: "queue_messages", formatted: "New task assigned" },
		];
		expect(eventsToAnthropicMessages(events)).toEqual([
			{
				role: "user",
				content:
					"[Messages received while you were idle:]\nNew task assigned\n\nProcess these messages and continue working. Remember to call done() when finished.",
			},
		]);
	});

	test("converts queue_messages with images", () => {
		const imageBlocks = [
			{
				type: "image",
				source: {
					type: "base64",
					media_type: "image/png",
					data: "abc123",
				},
			},
		];
		const events: CanonicalEvent[] = [
			{
				type: "queue_messages",
				formatted: "Check this image",
				hasImages: true,
				imageBlocks,
			},
		];
		expect(eventsToAnthropicMessages(events)).toEqual([
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "[Messages received while you were idle:]\nCheck this image\n\nProcess these messages and continue working. Remember to call done() when finished.",
					},
					...imageBlocks,
				],
			},
		]);
	});

	test("converts tool_results without images", () => {
		const results = [
			{
				type: "tool_result",
				tool_use_id: "id1",
				content: "success",
				is_error: false,
			},
		];
		const events: CanonicalEvent[] = [{ type: "tool_results", results }];
		expect(eventsToAnthropicMessages(events)).toEqual([
			{ role: "user", content: results },
		]);
	});

	test("converts tool_results with images (includes text annotation)", () => {
		const results = [
			{
				type: "tool_result",
				tool_use_id: "id1",
				content: "done",
			},
		];
		const imageBlocks = [
			{
				type: "image",
				source: {
					type: "base64",
					media_type: "image/jpeg",
					data: "img_data",
				},
			},
		];
		const events: CanonicalEvent[] = [
			{
				type: "tool_results",
				results,
				hasImages: true,
				imageBlocks,
			},
		];
		expect(eventsToAnthropicMessages(events)).toEqual([
			{
				role: "user",
				content: [
					...results,
					...imageBlocks,
					{ type: "text", text: "[1 image(s) attached by user]" },
				],
			},
		]);
	});

	test("converts budget_warning event", () => {
		const events: CanonicalEvent[] = [
			{
				type: "budget_warning",
				warning: "⚠️ Budget exceeded (0.50 / 0.40 budget). Call done() now.",
			},
		];
		expect(eventsToAnthropicMessages(events)).toEqual([
			{
				role: "user",
				content: "⚠️ Budget exceeded (0.50 / 0.40 budget). Call done() now.",
			},
		]);
	});

	test("converts a full conversation sequence", () => {
		const events: CanonicalEvent[] = [
			{
				type: "user_message",
				content: "Working directory: /tmp\n\nBuild a feature",
				cwd: "/tmp",
			},
			{
				type: "assistant_response",
				content: [
					{ type: "text", text: "I'll build that." },
					{
						type: "tool_use",
						id: "tu_1",
						name: "bash",
						input: { command: "echo hi" },
					},
				],
			},
			{
				type: "tool_results",
				results: [
					{
						type: "tool_result",
						tool_use_id: "tu_1",
						content: "hi\n",
						is_error: false,
					},
				],
			},
			{
				type: "assistant_response",
				content: [{ type: "text", text: "Done!" }],
			},
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

	test("handles compaction scenario (events reset after compaction)", () => {
		// After compaction, events.length = 0 and a compacted_resume is the first event
		const events: CanonicalEvent[] = [
			{
				type: "compacted_resume",
				content:
					"Working directory: /tmp\n\n## Checkpoint Summary\n\nCompleted steps 1-3.",
				cwd: "/tmp",
			},
			{
				type: "assistant_response",
				content: [{ type: "text", text: "Continuing from checkpoint." }],
			},
		];

		const messages = eventsToAnthropicMessages(events);
		expect(messages).toHaveLength(2);
		expect(messages[0]).toEqual({
			role: "user",
			content:
				"Working directory: /tmp\n\n## Checkpoint Summary\n\nCompleted steps 1-3.",
		});
		expect(messages[1]).toEqual({
			role: "assistant",
			content: [{ type: "text", text: "Continuing from checkpoint." }],
		});
	});

	test("handles queue_messages with empty imageBlocks array (no images)", () => {
		const events: CanonicalEvent[] = [
			{
				type: "queue_messages",
				formatted: "Message text",
				hasImages: false,
				imageBlocks: [],
			},
		];
		// Empty imageBlocks array means no images — should use string content
		expect(eventsToAnthropicMessages(events)).toEqual([
			{
				role: "user",
				content:
					"[Messages received while you were idle:]\nMessage text\n\nProcess these messages and continue working. Remember to call done() when finished.",
			},
		]);
	});

	test("handles tool_results with empty imageBlocks array (no images)", () => {
		const results = [
			{ type: "tool_result", tool_use_id: "id1", content: "ok" },
		];
		const events: CanonicalEvent[] = [
			{
				type: "tool_results",
				results,
				hasImages: false,
				imageBlocks: [],
			},
		];
		// Empty imageBlocks = no images, should use results directly
		expect(eventsToAnthropicMessages(events)).toEqual([
			{ role: "user", content: results },
		]);
	});

	test("handles resume user_message", () => {
		const events: CanonicalEvent[] = [
			{
				type: "user_message",
				content: "Continue the task",
				isResume: true,
			},
		];
		// isResume is metadata only — message format is the same
		expect(eventsToAnthropicMessages(events)).toEqual([
			{ role: "user", content: "Continue the task" },
		]);
	});

	test("multiple tool_results with images counts correctly", () => {
		const results = [
			{ type: "tool_result", tool_use_id: "id1", content: "ok" },
			{ type: "tool_result", tool_use_id: "id2", content: "ok" },
		];
		const imageBlocks = [
			{
				type: "image",
				source: { type: "base64", media_type: "image/png", data: "a" },
			},
			{
				type: "image",
				source: { type: "base64", media_type: "image/png", data: "b" },
			},
		];
		const events: CanonicalEvent[] = [
			{
				type: "tool_results",
				results,
				hasImages: true,
				imageBlocks,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toHaveLength(1);
		const content = (messages[0] as { content: unknown[] }).content;
		// results + 2 images + 1 text annotation
		expect(content).toHaveLength(5);
		expect(content[4]).toEqual({
			type: "text",
			text: "[2 image(s) attached by user]",
		});
	});
});

describe("eventsToOpenAIMessages", () => {
	test("returns empty array for no events", () => {
		expect(eventsToOpenAIMessages([])).toEqual([]);
	});

	test("converts user_message event", () => {
		const events: CanonicalEvent[] = [
			{ type: "user_message", content: "Hello world" },
		];
		expect(eventsToOpenAIMessages(events)).toEqual([
			{ role: "user", content: "Hello world" },
		]);
	});

	test("converts compacted_resume event", () => {
		const events: CanonicalEvent[] = [
			{
				type: "compacted_resume",
				content: "Working directory: /tmp\n\nCheckpoint",
				cwd: "/tmp",
			},
		];
		expect(eventsToOpenAIMessages(events)).toEqual([
			{ role: "user", content: "Working directory: /tmp\n\nCheckpoint" },
		]);
	});

	test("converts summarization_request event", () => {
		const events: CanonicalEvent[] = [
			{ type: "summarization_request", instruction: "Summarize now" },
		];
		expect(eventsToOpenAIMessages(events)).toEqual([
			{ role: "user", content: "Summarize now" },
		]);
	});

	test("converts assistant_response — spreads content array", () => {
		const assistantMsg = {
			role: "assistant",
			content: "I'll help",
			tool_calls: [
				{
					id: "call_1",
					type: "function",
					function: { name: "bash", arguments: '{"command":"echo hi"}' },
				},
			],
		};
		const events: CanonicalEvent[] = [
			{ type: "assistant_response", content: [assistantMsg] },
		];
		// Should spread — each item in content becomes a separate message
		expect(eventsToOpenAIMessages(events)).toEqual([assistantMsg]);
	});

	test("converts tool_results — spreads results array", () => {
		const toolMsg1 = {
			role: "tool",
			tool_call_id: "call_1",
			name: "bash",
			content: "hi\n",
		};
		const toolMsg2 = {
			role: "tool",
			tool_call_id: "call_2",
			name: "read_file",
			content: "file contents",
		};
		const events: CanonicalEvent[] = [
			{ type: "tool_results", results: [toolMsg1, toolMsg2] },
		];
		expect(eventsToOpenAIMessages(events)).toEqual([toolMsg1, toolMsg2]);
	});

	test("converts queue_messages without images", () => {
		const events: CanonicalEvent[] = [
			{ type: "queue_messages", formatted: "New task assigned" },
		];
		expect(eventsToOpenAIMessages(events)).toEqual([
			{
				role: "user",
				content:
					"[Messages received while you were idle:]\nNew task assigned\n\nProcess these messages and continue working. Remember to call done() when finished.",
			},
		]);
	});

	test("converts queue_messages with images", () => {
		const imageBlocks = [
			{
				type: "image_url",
				image_url: { url: "data:image/png;base64,abc", detail: "auto" },
			},
		];
		const events: CanonicalEvent[] = [
			{
				type: "queue_messages",
				formatted: "Check this",
				hasImages: true,
				imageBlocks,
			},
		];
		expect(eventsToOpenAIMessages(events)).toEqual([
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "[Messages received while you were idle:]\nCheck this\n\nProcess these messages and continue working. Remember to call done() when finished.",
					},
					...imageBlocks,
				],
			},
		]);
	});

	test("converts budget_warning event", () => {
		const events: CanonicalEvent[] = [
			{ type: "budget_warning", warning: "⚠️ Budget exceeded" },
		];
		expect(eventsToOpenAIMessages(events)).toEqual([
			{ role: "user", content: "⚠️ Budget exceeded" },
		]);
	});

	test("converts a full OpenAI conversation sequence", () => {
		const assistantMsg = {
			role: "assistant",
			content: "Running command.",
			tool_calls: [
				{
					id: "call_1",
					type: "function",
					function: { name: "bash", arguments: '{"command":"ls"}' },
				},
			],
		};
		const toolResult = {
			role: "tool",
			tool_call_id: "call_1",
			name: "bash",
			content: "file1.ts\nfile2.ts",
		};
		const events: CanonicalEvent[] = [
			{
				type: "user_message",
				content: "Working directory: /tmp\n\nList files",
				cwd: "/tmp",
			},
			{ type: "assistant_response", content: [assistantMsg] },
			{ type: "tool_results", results: [toolResult] },
			{
				type: "assistant_response",
				content: [{ role: "assistant", content: "Found 2 files." }],
			},
		];

		const messages = eventsToOpenAIMessages(events);
		expect(messages).toHaveLength(4);
		expect(messages[0]).toEqual({
			role: "user",
			content: "Working directory: /tmp\n\nList files",
		});
		expect(messages[1]).toEqual(assistantMsg);
		expect(messages[2]).toEqual(toolResult);
		expect(messages[3]).toEqual({
			role: "assistant",
			content: "Found 2 files.",
		});
	});
});

describe("strongEventsToAnthropicMessages", () => {
	test("returns empty array for no events", () => {
		expect(strongEventsToAnthropicMessages([])).toEqual([]);
	});

	test("converts user_message", () => {
		const events: StrongEvent[] = [
			{ type: "user_message", content: "Hello world", ts: 1000 },
		];
		expect(strongEventsToAnthropicMessages(events)).toEqual([
			{ role: "user", content: "Hello world" },
		]);
	});

	test("converts compacted_resume", () => {
		const events: StrongEvent[] = [
			{
				type: "compacted_resume",
				content: "Checkpoint summary",
				cwd: "/tmp",
				ts: 1000,
			},
		];
		expect(strongEventsToAnthropicMessages(events)).toEqual([
			{ role: "user", content: "Checkpoint summary" },
		]);
	});

	test("converts summarization_request", () => {
		const events: StrongEvent[] = [
			{ type: "summarization_request", instruction: "Summarize now", ts: 1000 },
		];
		expect(strongEventsToAnthropicMessages(events)).toEqual([
			{ role: "user", content: "Summarize now" },
		]);
	});

	test("converts budget_warning", () => {
		const events: StrongEvent[] = [
			{ type: "budget_warning", warning: "⚠️ Over budget", ts: 1000 },
		];
		expect(strongEventsToAnthropicMessages(events)).toEqual([
			{ role: "user", content: "⚠️ Over budget" },
		]);
	});

	test("converts assistant_text only → simple string content", () => {
		const events: StrongEvent[] = [
			{ type: "assistant_text", content: "I'll help you.", ts: 1000 },
		];
		expect(strongEventsToAnthropicMessages(events)).toEqual([
			{ role: "assistant", content: "I'll help you." },
		]);
	});

	test("converts assistant_text + tool_calls → single assistant message", () => {
		const events: StrongEvent[] = [
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
		expect(strongEventsToAnthropicMessages(events)).toEqual([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Let me check." },
					{
						type: "tool_use",
						id: "tc1",
						name: "bash",
						input: { command: "ls" },
					},
					{
						type: "tool_use",
						id: "tc2",
						name: "read_file",
						input: { path: "src/main.ts" },
					},
				],
			},
		]);
	});

	test("converts tool_calls without assistant_text", () => {
		const events: StrongEvent[] = [
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "tc1",
				input: { command: "echo hi" },
				ts: 1000,
			},
		];
		expect(strongEventsToAnthropicMessages(events)).toEqual([
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "tc1",
						name: "bash",
						input: { command: "echo hi" },
					},
				],
			},
		]);
	});

	test("converts tool_results → single user message", () => {
		const events: StrongEvent[] = [
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
		expect(strongEventsToAnthropicMessages(events)).toEqual([
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

	test("tool_results with images adds image blocks", () => {
		const events: StrongEvent[] = [
			{
				type: "tool_result",
				toolCallId: "tc1",
				content: "screenshot taken",
				isError: false,
				images: [{ base64: "abc123", mediaType: "image/png" }],
				ts: 1000,
			},
		];
		expect(strongEventsToAnthropicMessages(events)).toEqual([
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tc1",
						content: "screenshot taken",
						is_error: false,
					},
					{
						type: "image",
						source: {
							type: "base64",
							media_type: "image/png",
							data: "abc123",
						},
					},
					{ type: "text", text: "[1 image(s) attached by user]" },
				],
			},
		]);
	});

	test("queue_messages between tool_results merge into user message", () => {
		const events: StrongEvent[] = [
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
		expect(strongEventsToAnthropicMessages(events)).toEqual([
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
						text: "[Messages received while you were working:]\n<parent_update>\nNew instructions here\n</parent_update>",
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

	test("standalone queue_message → user message", () => {
		const events: StrongEvent[] = [
			{
				type: "queue_message",
				source: "user",
				content: "Please check this",
				ts: 1000,
			},
		];
		expect(strongEventsToAnthropicMessages(events)).toEqual([
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "[Messages received while you were working:]\n<user>\nPlease check this\n</user>",
					},
				],
			},
		]);
	});

	test("compact_marker is skipped", () => {
		const events: StrongEvent[] = [
			{ type: "user_message", content: "hello", ts: 1000 },
			{
				type: "compact_marker",
				checkpoint: "summary",
				savedTokens: 5000,
				ts: 2000,
			},
			{ type: "compacted_resume", content: "summary", ts: 2001 },
		];
		expect(strongEventsToAnthropicMessages(events)).toEqual([
			{ role: "user", content: "hello" },
			{ role: "user", content: "summary" },
		]);
	});

	test("full conversation: user → assistant+tools → results → assistant", () => {
		const events: StrongEvent[] = [
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

		const messages = strongEventsToAnthropicMessages(events);
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
			content: "Done!",
		});
	});

	test("compaction scenario: compacted_resume + continuation", () => {
		const events: StrongEvent[] = [
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

		const messages = strongEventsToAnthropicMessages(events);
		expect(messages).toHaveLength(4);
		expect(messages[0]).toEqual({
			role: "user",
			content: "## Checkpoint\n\nCompleted steps 1-3.",
		});
		expect(messages[1]).toEqual({
			role: "assistant",
			content: [
				{ type: "text", text: "Continuing from checkpoint." },
				{
					type: "tool_use",
					id: "tc1",
					name: "bash",
					input: { command: "ls" },
				},
			],
		});
		expect(messages[2]).toEqual({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "tc1",
					content: "src/",
					is_error: false,
				},
			],
		});
		expect(messages[3]).toEqual({
			role: "assistant",
			content: "Found the source directory.",
		});
	});

	test("tool_result with error flag", () => {
		const events: StrongEvent[] = [
			{
				type: "tool_result",
				toolCallId: "tc1",
				content: "Command failed with exit code 1",
				isError: true,
				ts: 1000,
			},
		];
		expect(strongEventsToAnthropicMessages(events)).toEqual([
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

	test("multiple images from multiple tool_results", () => {
		const events: StrongEvent[] = [
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
		const messages = strongEventsToAnthropicMessages(events);
		expect(messages).toHaveLength(1);
		const content = (messages[0] as { content: unknown[] }).content;
		// 2 tool_results + 2 images + 1 text annotation = 5
		expect(content).toHaveLength(5);
		expect(content[0]).toEqual({
			type: "tool_result",
			tool_use_id: "tc1",
			content: "screenshot 1",
			is_error: false,
		});
		expect(content[1]).toEqual({
			type: "tool_result",
			tool_use_id: "tc2",
			content: "screenshot 2",
			is_error: false,
		});
		expect(content[2]).toEqual({
			type: "image",
			source: { type: "base64", media_type: "image/png", data: "img1" },
		});
		expect(content[3]).toEqual({
			type: "image",
			source: { type: "base64", media_type: "image/jpeg", data: "img2" },
		});
		expect(content[4]).toEqual({
			type: "text",
			text: "[2 image(s) attached by user]",
		});
	});

	test("queue_message with images between tool_results", () => {
		const events: StrongEvent[] = [
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
		const messages = strongEventsToAnthropicMessages(events);
		expect(messages).toHaveLength(1);
		const content = (messages[0] as { content: unknown[] }).content;
		// 1 tool_result + 1 text (queue msg) + 1 image + 1 annotation = 4
		expect(content).toHaveLength(4);
		expect(content[2]).toEqual({
			type: "image",
			source: { type: "base64", media_type: "image/png", data: "qimg" },
		});
		expect(content[3]).toEqual({
			type: "text",
			text: "[1 image(s) attached by user]",
		});
	});

	test("handles resume user_message", () => {
		const events: StrongEvent[] = [
			{
				type: "user_message",
				content: "Continue the task",
				isResume: true,
				ts: 1000,
			},
		];
		expect(strongEventsToAnthropicMessages(events)).toEqual([
			{ role: "user", content: "Continue the task" },
		]);
	});
});
