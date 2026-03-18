import { describe, expect, test } from "bun:test";
import {
	type CanonicalEvent,
	eventsToAnthropicMessages,
	eventsToOpenAIMessages,
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
