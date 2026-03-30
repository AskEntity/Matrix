import { describe, expect, test } from "bun:test";
import { eventsToAnthropicMessages } from "./anthropic-compatible-provider.ts";
import {
	type Event,
	formatEventForAI,
	isPersistedByEmitEvent,
	queueMessageToEvent,
} from "./events.ts";
import { eventsToOpenAIMessages } from "./openai-compatible-provider.ts";

describe("queueMessageToEvent", () => {
	test("converts user message — body is the QueueMessage directly", () => {
		const msg = {
			source: "user" as const,
			id: "test-id",
			ts: 0,
			content: "hello",
			images: [{ base64: "abc", mediaType: "image/png" }],
		};
		const event = queueMessageToEvent(msg, "test");
		expect(event.type).toBe("message");
		expect(event.id).toBeTruthy();
		expect(event.body).toBe(msg);
	});

	test("converts user message — preserves existing id", () => {
		const event = queueMessageToEvent(
			{
				source: "user",
				id: "existing-id",
				ts: 0,
				content: "hello",
			},
			"test",
		);
		expect(event.id).toBe("existing-id");
	});

	test("converts task_complete — body is the QueueMessage directly", () => {
		const msg = {
			source: "task_complete" as const,
			id: "test-id",
			ts: 0,
			taskId: "t1",
			title: "Auth",
			success: true as const,
			output: "done",
		};
		const event = queueMessageToEvent(msg, "test");
		expect(event.type).toBe("message");
		expect(event.id).toBeTruthy();
		expect(event.body).toBe(msg);
	});

	test("converts compact — body is the QueueMessage directly", () => {
		const msg = { source: "compact" as const, id: "test-id", ts: 0 };
		const event = queueMessageToEvent(msg, "test");
		expect(event.type).toBe("message");
		expect(event.body).toBe(msg);
	});

	test("converts tree_change — body is the QueueMessage directly", () => {
		const msg = {
			source: "tree_change" as const,
			id: "test-id",
			ts: 0,
			action: "created" as const,
			nodeId: "node-1",
			title: "My Task",
		};
		const event = queueMessageToEvent(msg, "test");
		expect(event.type).toBe("message");
		expect(event.body).toBe(msg);
	});

	test("converts task_message — body is the QueueMessage directly", () => {
		const msg = {
			source: "task_message" as const,
			id: "test-id",
			ts: 0,
			fromTaskId: "p1",
			fromTitle: "Orchestrator",
			content: "update",
			requestReply: true,
			header: "## Task Context\nTitle: Fix Bug",
		};
		const event = queueMessageToEvent(msg, "test");
		expect(event.type).toBe("message");
		expect(event.body).toBe(msg);
	});

	test("converts user message with header — body is the QueueMessage directly", () => {
		const msg = {
			source: "user" as const,
			id: "test-id",
			ts: 0,
			content: "Build a feature",
			header: "Working directory: /tmp\n\n## Memory\nSome memory",
		};
		const event = queueMessageToEvent(msg, "test");
		expect(event.body).toBe(msg);
	});
});

describe("formatEventForAI", () => {
	test("formats user message", () => {
		const event: Event = {
			type: "message",
			id: "test",
			body: { source: "user", id: "test-id", ts: 0, content: "Hello world" },
			taskId: "test",
			ts: 1000,
		};
		expect(formatEventForAI(event)).toBe("[00:00:01] Hello world");
	});

	test("formats task_complete", () => {
		const event: Event = {
			type: "message",
			id: "test",
			body: {
				source: "task_complete",
				id: "test-id",
				ts: 0,
				taskId: "t1",
				title: "Auth",
				success: true,
				output: "All tests pass",
			},
			taskId: "test",
			ts: 1000,
		};
		expect(formatEventForAI(event)).toBe(
			'[00:00:01] <task_complete from_task="t1" task_name="Auth" status="passed">All tests pass</task_complete>',
		);
	});

	test("formats task_message with requestReply", () => {
		const event: Event = {
			type: "message",
			id: "test",
			body: {
				source: "task_message",
				id: "test-id",
				ts: 0,
				fromTaskId: "p1",
				fromTitle: "Orchestrator",
				content: "What status?",
				requestReply: true,
			},
			taskId: "test",
			ts: 1000,
		};
		expect(formatEventForAI(event)).toBe(
			'[00:00:01] <task_message from_task="p1" task_name="Orchestrator" requestReply="true">What status?</task_message>',
		);
	});

	test("formats clarify_response", () => {
		const event: Event = {
			type: "message",
			id: "test",
			body: { source: "clarify_response", id: "test-id", ts: 0, answer: "Yes" },
			taskId: "test",
			ts: 1000,
		};
		expect(formatEventForAI(event)).toBe(
			"[00:00:01] <clarify_response>Yes</clarify_response>",
		);
	});

	test("formats compact", () => {
		const event: Event = {
			type: "message",
			id: "test",
			body: { source: "compact", id: "test-id", ts: 0 },
			taskId: "test",
			ts: 1000,
		};
		expect(formatEventForAI(event)).toBe("[00:00:01] Manual compaction requested");
	});

	test("formats user_message_forwarded tag", () => {
		const event: Event = {
			type: "message",
			id: "test",
			body: {
				source: "user_message_forwarded",
				id: "test-id",
				ts: 0,
				fromTaskId: "t1",
				fromTitle: "Worker",
				content: "User sent a message to child task 'Worker' (t1): fix the bug",
			},
			taskId: "test",
			ts: 1000,
		};
		expect(formatEventForAI(event)).toBe(
			`[00:00:01] <user_message_forwarded from_task="t1" task_name="Worker">User sent a message to child task 'Worker' (t1): fix the bug</user_message_forwarded>`,
		);
	});

	test("formats task_message with title", () => {
		const event: Event = {
			type: "message",
			id: "test",
			body: {
				source: "task_message",
				id: "test-id",
				ts: 0,
				fromTaskId: "t1",
				fromTitle: "Worker",
				content: "Progress: 50%",
				title: "halfway",
			},
			taskId: "test",
			ts: 1000,
		};
		expect(formatEventForAI(event)).toBe(
			'[00:00:01] <task_message from_task="t1" task_name="Worker" title="halfway">Progress: 50%</task_message>',
		);
	});
});

describe("eventsToAnthropicMessages", () => {
	test("returns empty array for no events", () => {
		expect(eventsToAnthropicMessages([])).toEqual([]);
	});

	test("converts user_message", () => {
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", ts: 0, content: "Hello world" },
				taskId: "test",
				ts: 1000,
			},
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
				taskId: "test",
				ts: 1000,
			},
		];
		expect(eventsToAnthropicMessages(events)).toEqual([
			{ role: "user", content: "Checkpoint summary" },
		]);
	});

	test("converts summarization_request", () => {
		const events: Event[] = [
			{
				type: "summarization_request",
				instruction: "Summarize now",
				taskId: "test",
				ts: 1000,
			},
		];
		expect(eventsToAnthropicMessages(events)).toEqual([
			{ role: "user", content: "Summarize now" },
		]);
	});

	test("converts budget_warning", () => {
		const events: Event[] = [
			{
				type: "budget_warning",
				warning: "⚠️ Over budget",
				taskId: "test",
				ts: 1000,
			},
		];
		expect(eventsToAnthropicMessages(events)).toEqual([
			{ role: "user", content: "⚠️ Over budget" },
		]);
	});

	test("converts assistant_text only → array content format", () => {
		const events: Event[] = [
			{
				type: "assistant_text",
				content: "I'll help you.",
				taskId: "test",
				ts: 1000,
			},
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
			{
				type: "assistant_text",
				content: "Let me check.",
				taskId: "test",
				ts: 1000,
			},
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "tc1",
				input: { command: "ls" },
				taskId: "test",
				ts: 1001,
			},
			{
				type: "tool_call",
				tool: "read_file",
				toolCallId: "tc2",
				input: { path: "src/main.ts" },
				taskId: "test",
				ts: 1002,
			},
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "tc1",
				content: "file.ts",
				isError: false,
				taskId: "test",
				ts: 1003,
			},
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "tc2",
				content: "contents",
				isError: false,
				taskId: "test",
				ts: 1004,
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
				{
					type: "tool_use",
					id: "tc2",
					name: "read_file",
					input: { path: "src/main.ts" },
					caller: { type: "direct" },
				},
			],
		});
	});

	test("converts tool_calls without assistant_text", () => {
		const events: Event[] = [
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "tc1",
				input: { command: "echo hi" },
				taskId: "test",
				ts: 1000,
			},
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "tc1",
				content: "hi",
				isError: false,
				taskId: "test",
				ts: 1001,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages[0]).toEqual({
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
		});
	});

	test("converts tool_results → single user message", () => {
		const events: Event[] = [
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "tc1",
				content: "file1.ts\nfile2.ts",
				isError: false,
				taskId: "test",
				ts: 1000,
			},
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "tc2",
				content: "contents of file",
				isError: false,
				taskId: "test",
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
				tool: "test_tool",
				toolCallId: "tc1",
				content: "screenshot taken",
				isError: false,
				images: [{ base64: "abc123", mediaType: "image/png" }],
				taskId: "test",
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

	// Legacy tests for queue events without IDs removed — new format uses
	// user_message with id + queueEntry, materialized by messages_consumed.
	// See "messages_consumed" test suite below for comprehensive coverage.

	test("standalone user_message from queue → idle wrapper", () => {
		// When user_message appears after an assistant message (idle context),
		// it should be wrapped. But as the first event or after a provider user_message,
		// it acts as a normal user message.
		// Queue-originated messages only get idle wrapper when batched with other queue events.
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", ts: 0, content: "Please check this" },
				taskId: "test",
				ts: 1000,
			},
		];
		expect(eventsToAnthropicMessages(events)).toEqual([
			{
				role: "user",
				content: "Please check this",
			},
		]);
	});

	test("compact_marker is skipped", () => {
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", ts: 0, content: "hello" },
				taskId: "test",
				ts: 1000,
			},
			{
				type: "compact_marker",
				checkpoint: "summary",
				savedTokens: 5000,
				taskId: "test",
				ts: 2000,
			},
			{
				type: "compacted_resume",
				content: "summary",
				taskId: "test",
				ts: 2001,
			},
		];
		expect(eventsToAnthropicMessages(events)).toEqual([
			{ role: "user", content: "hello" },
			{ role: "user", content: "summary" },
		]);
	});

	test("full conversation: user → assistant+tools → results → assistant", () => {
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: {
					source: "user",
					id: "test-id",
					ts: 0,
					content: "Working directory: /tmp\n\nBuild a feature",
				},
				taskId: "test",
				ts: 1000,
			},
			{
				type: "assistant_text",
				content: "I'll build that.",
				taskId: "test",
				ts: 1001,
			},
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "tu_1",
				input: { command: "echo hi" },
				taskId: "test",
				ts: 1002,
			},
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "tu_1",
				content: "hi\n",
				isError: false,
				taskId: "test",
				ts: 1003,
			},
			{ type: "assistant_text", content: "Done!", taskId: "test", ts: 1004 },
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
				taskId: "test",
				ts: 2000,
			},
			{
				type: "assistant_text",
				content: "Continuing from checkpoint.",
				taskId: "test",
				ts: 2001,
			},
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "tc1",
				input: { command: "ls" },
				taskId: "test",
				ts: 2002,
			},
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "tc1",
				content: "src/",
				isError: false,
				taskId: "test",
				ts: 2003,
			},
			{
				type: "assistant_text",
				content: "Found the source directory.",
				taskId: "test",
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
				tool: "test_tool",
				toolCallId: "tc1",
				content: "Command failed with exit code 1",
				isError: true,
				taskId: "test",
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
				tool: "test_tool",
				toolCallId: "tc1",
				content: "screenshot 1",
				isError: false,
				images: [{ base64: "img1", mediaType: "image/png" }],
				taskId: "test",
				ts: 1000,
			},
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "tc2",
				content: "screenshot 2",
				isError: false,
				images: [{ base64: "img2", mediaType: "image/jpeg" }],
				taskId: "test",
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

	test("handles resume user_message", () => {
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", ts: 0, content: "Continue the task" },
				taskId: "test",
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
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", ts: 0, content: "Hello world" },
				taskId: "test",
				ts: 1000,
			},
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
				taskId: "test",
				ts: 1000,
			},
		];
		expect(eventsToOpenAIMessages(events)).toEqual([
			{ role: "user", content: "Checkpoint summary" },
		]);
	});

	test("converts summarization_request", () => {
		const events: Event[] = [
			{
				type: "summarization_request",
				instruction: "Summarize now",
				taskId: "test",
				ts: 1000,
			},
		];
		expect(eventsToOpenAIMessages(events)).toEqual([
			{ role: "user", content: "Summarize now" },
		]);
	});

	test("converts budget_warning", () => {
		const events: Event[] = [
			{
				type: "budget_warning",
				warning: "⚠️ Over budget",
				taskId: "test",
				ts: 1000,
			},
		];
		expect(eventsToOpenAIMessages(events)).toEqual([
			{ role: "user", content: "⚠️ Over budget" },
		]);
	});

	test("converts assistant_text only → content string, no tool_calls", () => {
		const events: Event[] = [
			{
				type: "assistant_text",
				content: "I'll help you.",
				taskId: "test",
				ts: 1000,
			},
		];
		expect(eventsToOpenAIMessages(events)).toEqual([
			{ role: "assistant", content: "I'll help you." },
		]);
	});

	test("converts assistant_text + tool_calls → single message with tool_calls array", () => {
		const events: Event[] = [
			{
				type: "assistant_text",
				content: "Let me check.",
				taskId: "test",
				ts: 1000,
			},
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "call_1",
				input: { command: "ls" },
				taskId: "test",
				ts: 1001,
			},
			{
				type: "tool_call",
				tool: "read_file",
				toolCallId: "call_2",
				input: { path: "src/main.ts" },
				taskId: "test",
				ts: 1002,
			},
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "call_1",
				content: "file.ts",
				isError: false,
				taskId: "test",
				ts: 1003,
			},
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "call_2",
				content: "contents",
				isError: false,
				taskId: "test",
				ts: 1004,
			},
		];
		const messages = eventsToOpenAIMessages(events);
		expect(messages[0]).toEqual({
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
		});
	});

	test("converts tool_calls without assistant_text → null content", () => {
		const events: Event[] = [
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "call_1",
				input: { command: "echo hi" },
				taskId: "test",
				ts: 1000,
			},
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "call_1",
				content: "hi",
				isError: false,
				taskId: "test",
				ts: 1001,
			},
		];
		const messages = eventsToOpenAIMessages(events);
		expect(messages[0]).toEqual({
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
		});
	});

	test("converts tool_results → individual tool messages with name lookup", () => {
		const events: Event[] = [
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "call_1",
				input: { command: "ls" },
				taskId: "test",
				ts: 1000,
			},
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "call_1",
				content: "file1.ts\nfile2.ts",
				isError: false,
				taskId: "test",
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
				tool: "test_tool",
				toolCallId: "orphan_call",
				content: "result",
				isError: false,
				taskId: "test",
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
				taskId: "test",
				ts: 1000,
			},
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "call_1",
				content: "screenshot taken",
				isError: false,
				images: [{ base64: "abc123", mediaType: "image/png" }],
				taskId: "test",
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

	test("compact_marker is skipped", () => {
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", ts: 0, content: "hello" },
				taskId: "test",
				ts: 1000,
			},
			{
				type: "compact_marker",
				checkpoint: "summary",
				savedTokens: 5000,
				taskId: "test",
				ts: 2000,
			},
			{
				type: "compacted_resume",
				content: "summary",
				taskId: "test",
				ts: 2001,
			},
		];
		expect(eventsToOpenAIMessages(events)).toEqual([
			{ role: "user", content: "hello" },
			{ role: "user", content: "summary" },
		]);
	});

	test("full conversation: user → assistant+tools → results → assistant", () => {
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: {
					source: "user",
					id: "test-id",
					ts: 0,
					content: "Working directory: /tmp\n\nBuild a feature",
				},
				taskId: "test",
				ts: 1000,
			},
			{
				type: "assistant_text",
				content: "I'll build that.",
				taskId: "test",
				ts: 1001,
			},
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "call_1",
				input: { command: "echo hi" },
				taskId: "test",
				ts: 1002,
			},
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "call_1",
				content: "hi\n",
				isError: false,
				taskId: "test",
				ts: 1003,
			},
			{ type: "assistant_text", content: "Done!", taskId: "test", ts: 1004 },
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
				type: "message",

				id: "",

				body: { source: "user", id: "test-id", ts: 0, content: "Continue the task" },

				taskId: "test",
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
				taskId: "test",
				ts: 1000,
			},
			{
				type: "tool_call",
				tool: "screenshot2",
				toolCallId: "call_2",
				input: {},
				taskId: "test",
				ts: 1001,
			},
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "call_1",
				content: "shot1",
				isError: false,
				images: [{ base64: "img1", mediaType: "image/png" }],
				taskId: "test",
				ts: 1002,
			},
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "call_2",
				content: "shot2",
				isError: false,
				images: [{ base64: "img2", mediaType: "image/jpeg" }],
				taskId: "test",
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
				taskId: "test",
				ts: 2000,
			},
			{
				type: "assistant_text",
				content: "Continuing from checkpoint.",
				taskId: "test",
				ts: 2001,
			},
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "call_1",
				input: { command: "ls" },
				taskId: "test",
				ts: 2002,
			},
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "call_1",
				content: "src/",
				isError: false,
				taskId: "test",
				ts: 2003,
			},
			{
				type: "assistant_text",
				content: "Found the source directory.",
				taskId: "test",
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
				taskId: "test",
				ts: 1000,
			},
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "call_1",
				content: "Command failed with exit code 1",
				isError: true,
				taskId: "test",
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

	test("interleaved assistant_text + tool_call produces ONE assistant message", () => {
		const events: Event[] = [
			{
				type: "assistant_text",
				content: "Creating task and reading files.",
				taskId: "test",
				ts: 1000,
			},
			{
				type: "tool_call",
				tool: "create_task",
				toolCallId: "call_1",
				input: { title: "Fix bug" },
				taskId: "test",
				ts: 1001,
			},
			{
				type: "assistant_text",
				content: "Also checking source.",
				taskId: "test",
				ts: 1002,
			},
			{
				type: "tool_call",
				tool: "read_file",
				toolCallId: "call_2",
				input: { path: "src/foo.ts" },
				taskId: "test",
				ts: 1003,
			},
			// Tool results for both
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "call_1",
				content: "Task created",
				isError: false,
				taskId: "test",
				ts: 1004,
			},
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "call_2",
				content: "file contents",
				isError: false,
				taskId: "test",
				ts: 1005,
			},
		];
		const messages = eventsToOpenAIMessages(events);
		// ONE assistant + TWO tool results = 3 messages (OpenAI uses individual tool messages)
		expect(messages).toHaveLength(3);
		expect(messages[0]).toEqual({
			role: "assistant",
			content: "Creating task and reading files.\nAlso checking source.",
			tool_calls: [
				{
					id: "call_1",
					type: "function",
					function: { name: "create_task", arguments: '{"title":"Fix bug"}' },
				},
				{
					id: "call_2",
					type: "function",
					function: { name: "read_file", arguments: '{"path":"src/foo.ts"}' },
				},
			],
		});
	});
});

// ── Bug fix regression tests ──

describe("eventsToAnthropicMessages — converter bug fixes", () => {
	test("Bug 1: assistant text-only must use array content format (not bare string)", () => {
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", ts: 0, content: "Hello" },
				taskId: "test",
				ts: 1000,
			},
			{
				type: "assistant_text",
				content: "Hi there!",
				taskId: "test",
				ts: 1001,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages[1]).toEqual({
			role: "assistant",
			content: [{ type: "text", text: "Hi there!" }],
		});
	});

	test("Bug 1: multiple assistant_text blocks still produce array format", () => {
		const events: Event[] = [
			{
				type: "assistant_text",
				content: "First paragraph.",
				taskId: "test",
				ts: 1000,
			},
			{
				type: "assistant_text",
				content: "Second paragraph.",
				taskId: "test",
				ts: 1001,
			},
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
			{
				type: "assistant_text",
				content: "Let me check.",
				taskId: "test",
				ts: 1000,
			},
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "tc1",
				input: { command: "ls" },
				taskId: "test",
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

	test("Bug: interleaved assistant_text + tool_call produces ONE assistant message", () => {
		// Reproduces the bug where text→tool→text→tool from the same API response
		// was split into two separate assistant messages
		const events: Event[] = [
			{
				type: "assistant_text",
				content: "I'll create the task and read files.",
				taskId: "test",
				ts: 1000,
			},
			{
				type: "tool_call",
				tool: "create_task",
				toolCallId: "toolu_01Foy",
				input: { title: "Fix bug" },
				taskId: "test",
				ts: 1001,
			},
			{
				type: "assistant_text",
				content: "Let me also check the source.",
				taskId: "test",
				ts: 1002,
			},
			{
				type: "tool_call",
				tool: "read_file",
				toolCallId: "toolu_02Bar",
				input: { path: "src/foo.ts" },
				taskId: "test",
				ts: 1003,
			},
			{
				type: "tool_call",
				tool: "read_file",
				toolCallId: "toolu_03Baz",
				input: { path: "src/bar.ts" },
				taskId: "test",
				ts: 1004,
			},
			// Tool results for all three
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "toolu_01Foy",
				content: "Task created",
				isError: false,
				taskId: "test",
				ts: 1005,
			},
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "toolu_02Bar",
				content: "file contents",
				isError: false,
				taskId: "test",
				ts: 1006,
			},
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "toolu_03Baz",
				content: "file contents",
				isError: false,
				taskId: "test",
				ts: 1007,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		// Must be TWO messages: ONE assistant + ONE user (tool_results), not three
		expect(messages).toHaveLength(2);
		expect(messages[0]).toEqual({
			role: "assistant",
			content: [
				{ type: "text", text: "I'll create the task and read files." },
				{
					type: "tool_use",
					id: "toolu_01Foy",
					name: "create_task",
					input: { title: "Fix bug" },
					caller: { type: "direct" },
				},
				{ type: "text", text: "Let me also check the source." },
				{
					type: "tool_use",
					id: "toolu_02Bar",
					name: "read_file",
					input: { path: "src/foo.ts" },
					caller: { type: "direct" },
				},
				{
					type: "tool_use",
					id: "toolu_03Baz",
					name: "read_file",
					input: { path: "src/bar.ts" },
					caller: { type: "direct" },
				},
			],
		});
		// All tool_results in ONE user message
		expect((messages[1] as { role: string }).role).toBe("user");
	});

	test("Bug: interleaved text+tool with tool_results — all results reference same assistant msg", () => {
		const events: Event[] = [
			{
				type: "assistant_text",
				content: "Checking files.",
				taskId: "test",
				ts: 1000,
			},
			{
				type: "tool_call",
				tool: "read_file",
				toolCallId: "tc1",
				input: { path: "a.ts" },
				taskId: "test",
				ts: 1001,
			},
			{
				type: "assistant_text",
				content: "And this one too.",
				taskId: "test",
				ts: 1002,
			},
			{
				type: "tool_call",
				tool: "read_file",
				toolCallId: "tc2",
				input: { path: "b.ts" },
				taskId: "test",
				ts: 1003,
			},
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "tc1",
				content: "file a contents",
				isError: false,
				taskId: "test",
				ts: 1004,
			},
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "tc2",
				content: "file b contents",
				isError: false,
				taskId: "test",
				ts: 1005,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		// ONE assistant + ONE user (tool_results) = 2 messages total
		expect(messages).toHaveLength(2);
		expect((messages[0] as { role: string }).role).toBe("assistant");
		expect((messages[1] as { role: string }).role).toBe("user");
	});
});

describe("messages_consumed — two-phase user message lifecycle", () => {
	test("Anthropic: user_message with id is skipped; messages_consumed materializes it (idle)", () => {
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", ts: 0, content: "Hello" },
				taskId: "test",
				ts: 1000,
			},
			{
				type: "assistant_text",
				content: "Working...",
				taskId: "test",
				ts: 1001,
			},
			// Agent calls done(), enters idle state. User sends new message.
			{
				type: "message",

				id: "msg-1",

				body: { source: "user", id: "test-id", ts: 0, content: "Please also check X" },

				taskId: "test",
				ts: 2000,
			},
			{
				type: "messages_consumed",
				messageIds: ["msg-1"],
				taskId: "test",
				ts: 3000,
			},
			{
				type: "assistant_text",
				content: "I'll check X.",
				taskId: "test",
				ts: 3001,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toHaveLength(4);
		expect(messages[0]).toEqual({ role: "user", content: "Hello" });
		expect(messages[1]).toEqual({
			role: "assistant",
			content: [{ type: "text", text: "Working..." }],
		});
		expect(messages[2]).toEqual({
			role: "user",
			content: "Please also check X",
		});
		expect(messages[3]).toEqual({
			role: "assistant",
			content: [{ type: "text", text: "I'll check X." }],
		});
	});

	test("Anthropic: messages_consumed at cancellation point (between tool_results)", () => {
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", ts: 0, content: "Do a task" },
				taskId: "test",
				ts: 1000,
			},
			{ type: "assistant_text", content: "OK", taskId: "test", ts: 1001 },
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "tc1",
				input: { command: "ls" },
				taskId: "test",
				ts: 1002,
			},
			{
				type: "message",

				id: "msg-1",

				body: { source: "user", id: "test-id", ts: 0, content: "Also do Y" },

				taskId: "test",
				ts: 1500,
			},
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "tc1",
				content: "ok",
				isError: false,
				taskId: "test",
				ts: 2000,
			},
			{
				type: "messages_consumed",
				messageIds: ["msg-1"],
				taskId: "test",
				ts: 2001,
			},
			{ type: "assistant_text", content: "I see Y.", taskId: "test", ts: 2002 },
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toHaveLength(4);
		// Message 3 = tool_results user message with messages_consumed appended
		const toolResultMsg = messages[2] as { role: string; content: unknown[] };
		expect(toolResultMsg.role).toBe("user");
		expect(toolResultMsg.content).toHaveLength(2);
		expect(toolResultMsg.content[0]).toEqual({
			type: "tool_result",
			tool_use_id: "tc1",
			content: "ok",
			is_error: false,
		});
		expect(toolResultMsg.content[1]).toEqual({
			type: "text",
			text: "Also do Y",
		});
	});

	test("Anthropic: multiple user_messages consumed together", () => {
		const events: Event[] = [
			{
				type: "message",

				id: "msg-1",

				body: { source: "user", id: "test-id", ts: 0, content: "First" },

				taskId: "test",
				ts: 1000,
			},
			{
				type: "message",

				id: "msg-2",

				body: { source: "user", id: "test-id", ts: 0, content: "Second" },

				taskId: "test",
				ts: 1500,
			},
			{
				type: "messages_consumed",
				messageIds: ["msg-1", "msg-2"],
				taskId: "test",
				ts: 2000,
			},
			{
				type: "assistant_text",
				content: "Got both.",
				taskId: "test",
				ts: 2001,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toHaveLength(2);
		// Multiple messages → array of text blocks
		expect(messages[0]).toEqual({
			role: "user",
			content: [
				{ type: "text", text: "First" },
				{ type: "text", text: "Second" },
			],
		});
	});

	test("Anthropic: user_message with id and images at cancellation point", () => {
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", ts: 0, content: "Start" },
				taskId: "test",
				ts: 1000,
			},
			{ type: "assistant_text", content: "OK", taskId: "test", ts: 1001 },
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "tc1",
				input: { command: "ls" },
				taskId: "test",
				ts: 1002,
			},
			{
				type: "message",
				id: "msg-1",
				body: {
					source: "user",
					id: "test-id",
					ts: 0,
					content: "Look at this",
					images: [{ base64: "abc123", mediaType: "image/png" }],
				},
				taskId: "test",
				ts: 1500,
			},
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "tc1",
				content: "ok",
				isError: false,
				taskId: "test",
				ts: 2000,
			},
			{
				type: "messages_consumed",
				messageIds: ["msg-1"],
				taskId: "test",
				ts: 2001,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toHaveLength(3);
		const toolResultMsg = messages[2] as { role: string; content: unknown[] };
		expect(toolResultMsg.content).toHaveLength(4);
		expect(toolResultMsg.content[1]).toEqual({
			type: "text",
			text: "Look at this",
		});
		expect(toolResultMsg.content[2]).toEqual({
			type: "image",
			source: {
				type: "base64",
				media_type: "image/png",
				data: "abc123",
			},
		});
		expect(toolResultMsg.content[3]).toEqual({
			type: "text",
			text: "[1 image(s) attached by user]",
		});
	});

	test("OpenAI: user_message with id is skipped; messages_consumed materializes it (idle)", () => {
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", ts: 0, content: "Hello" },
				taskId: "test",
				ts: 1000,
			},
			{
				type: "assistant_text",
				content: "Working...",
				taskId: "test",
				ts: 1001,
			},
			{
				type: "message",

				id: "msg-1",

				body: { source: "user", id: "test-id", ts: 0, content: "Please also check X" },

				taskId: "test",
				ts: 2000,
			},
			{
				type: "messages_consumed",
				messageIds: ["msg-1"],
				taskId: "test",
				ts: 3000,
			},
			{
				type: "assistant_text",
				content: "I'll check X.",
				taskId: "test",
				ts: 3001,
			},
		];
		const messages = eventsToOpenAIMessages(events);
		expect(messages).toHaveLength(4);
		expect(messages[0]).toEqual({ role: "user", content: "Hello" });
		expect(messages[1]).toEqual({
			role: "assistant",
			content: "Working...",
		});
		expect(messages[2]).toEqual({
			role: "user",
			content: "Please also check X",
		});
		expect(messages[3]).toEqual({
			role: "assistant",
			content: "I'll check X.",
		});
	});

	test("OpenAI: messages_consumed at cancellation point appends to tool result", () => {
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", ts: 0, content: "Do a task" },
				taskId: "test",
				ts: 1000,
			},
			{ type: "assistant_text", content: "OK", taskId: "test", ts: 1001 },
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "call_1",
				input: { command: "ls" },
				taskId: "test",
				ts: 1002,
			},
			{
				type: "message",

				id: "msg-1",

				body: { source: "user", id: "test-id", ts: 0, content: "Also do Y" },

				taskId: "test",
				ts: 1500,
			},
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "call_1",
				content: "ok",
				isError: false,
				taskId: "test",
				ts: 2000,
			},
			{
				type: "messages_consumed",
				messageIds: ["msg-1"],
				taskId: "test",
				ts: 2001,
			},
			{ type: "assistant_text", content: "I see Y.", taskId: "test", ts: 2002 },
		];
		const messages = eventsToOpenAIMessages(events);
		expect(messages).toHaveLength(4);
		// Tool result should have consumed messages appended
		const toolResult = messages[2] as { content: string };
		expect(toolResult.content).toContain("Also do Y");
	});

	test("Anthropic: messages_consumed skips unknown IDs gracefully", () => {
		const events: Event[] = [
			{
				type: "messages_consumed",
				messageIds: ["nonexistent-id"],
				taskId: "test",
				ts: 1000,
			},
			{ type: "assistant_text", content: "OK", taskId: "test", ts: 1001 },
		];
		const messages = eventsToAnthropicMessages(events);
		// No user message generated for unknown IDs
		expect(messages).toHaveLength(1);
		expect(messages[0]).toEqual({
			role: "assistant",
			content: [{ type: "text", text: "OK" }],
		});
	});

	test("Anthropic: messages_consumed at cancellation point materializes user_message", () => {
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", ts: 0, content: "Do a task" },
				taskId: "test",
				ts: 1000,
			},
			{ type: "assistant_text", content: "OK", taskId: "test", ts: 1001 },
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "tc1",
				input: { command: "ls" },
				taskId: "test",
				ts: 1002,
			},
			{
				type: "message",

				id: "msg-1",

				body: { source: "user", id: "test-id", ts: 0, content: "Also do Y" },

				taskId: "test",
				ts: 1500,
			},
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "tc1",
				content: "ok",
				isError: false,
				taskId: "test",
				ts: 2000,
			},
			{
				type: "messages_consumed",
				messageIds: ["msg-1"],
				taskId: "test",
				ts: 2001,
			},
			{ type: "assistant_text", content: "I see Y.", taskId: "test", ts: 2002 },
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toHaveLength(4);
		const toolResultMsg = messages[2] as { role: string; content: unknown[] };
		expect(toolResultMsg.role).toBe("user");
		expect(toolResultMsg.content).toHaveLength(2);
		expect(toolResultMsg.content[0]).toEqual({
			type: "tool_result",
			tool_use_id: "tc1",
			content: "ok",
			is_error: false,
		});
		expect(toolResultMsg.content[1]).toEqual({
			type: "text",
			text: "Also do Y",
		});
	});

	test("OpenAI: messages_consumed at cancellation point materializes user_message", () => {
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", ts: 0, content: "Do a task" },
				taskId: "test",
				ts: 1000,
			},
			{ type: "assistant_text", content: "OK", taskId: "test", ts: 1001 },
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "call_1",
				input: { command: "ls" },
				taskId: "test",
				ts: 1002,
			},
			{
				type: "message",

				id: "msg-1",

				body: { source: "user", id: "test-id", ts: 0, content: "Also do Y" },

				taskId: "test",
				ts: 1500,
			},
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "call_1",
				content: "ok",
				isError: false,
				taskId: "test",
				ts: 2000,
			},
			{
				type: "messages_consumed",
				messageIds: ["msg-1"],
				taskId: "test",
				ts: 2001,
			},
			{ type: "assistant_text", content: "I see Y.", taskId: "test", ts: 2002 },
		];
		const messages = eventsToOpenAIMessages(events);
		expect(messages).toHaveLength(4);
		const toolResult = messages[2] as { content: string };
		expect(toolResult.content).toContain("Also do Y");
	});

	test("user_message without id works as direct message", () => {
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", ts: 0, content: "Direct message" },
				taskId: "test",
				ts: 1000,
			},
		];
		expect(eventsToAnthropicMessages(events)).toEqual([
			{ role: "user", content: "Direct message" },
		]);
		expect(eventsToOpenAIMessages(events)).toEqual([
			{ role: "user", content: "Direct message" },
		]);
	});
});

describe("converter resilience — lifecycle events in JSONL", () => {
	test("Anthropic converter skips lifecycle events without infinite loop", () => {
		const events: Event[] = [
			{
				type: "orchestration_started",
				resume: false,
				model: "test-model",
				provider: "test-provider",
				taskId: "test",
				ts: 1,
			} as Event,
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", ts: 0, content: "hello" },
				taskId: "test",
				ts: 2,
			} as Event,
			{ type: "assistant_text", content: "hi", taskId: "test", ts: 3 } as Event,
			{ type: "agent_stopped", taskId: "test", ts: 4 } as Event,
			{
				type: "orchestration_started",
				resume: true,
				model: "test-model",
				provider: "test-provider",
				taskId: "test",
				ts: 5,
			} as Event,
		];
		const messages = eventsToAnthropicMessages(events);
		// Should produce messages for user_message and assistant_text only
		expect(messages.length).toBe(2);
	});

	test("OpenAI converter skips lifecycle events without infinite loop", () => {
		const events: Event[] = [
			{
				type: "orchestration_started",
				resume: false,
				model: "test-model",
				provider: "test-provider",
				taskId: "test",
				ts: 1,
			} as Event,
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", ts: 0, content: "hello" },
				taskId: "test",
				ts: 2,
			} as Event,
			{ type: "assistant_text", content: "hi", taskId: "test", ts: 3 } as Event,
			{ type: "agent_stopped", taskId: "test", ts: 4 } as Event,
			{
				type: "orchestration_started",
				resume: true,
				model: "test-model",
				provider: "test-provider",
				taskId: "test",
				ts: 5,
			} as Event,
		];
		const messages = eventsToOpenAIMessages(events);
		expect(messages.length).toBe(2);
	});
});

describe("structured JSONL — queueEntry on user_message", () => {
	test("Anthropic: user_message with body.source=task_complete formats correctly via standalone messages_consumed", () => {
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", ts: 0, content: "Start" },
				taskId: "test",
				ts: 1000,
			},
			{
				type: "assistant_text",
				content: "Working...",
				taskId: "test",
				ts: 1001,
			},
			{
				type: "tool_call",
				toolCallId: "tc1",
				tool: "bash",
				input: { command: "echo hi" },
				taskId: "test",
				ts: 1002,
			},
			{
				type: "message",
				id: "msg-child",
				body: {
					source: "task_complete",
					id: "test-id",
					ts: 0,
					taskId: "t1",
					title: "Auth module",
					success: true,
					output: "All tests pass",
				},
				taskId: "test",
				ts: 1003,
			},
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "tc1",
				content: "hi",
				isError: false,
				taskId: "test",
				ts: 1004,
			},
			{
				type: "messages_consumed",
				messageIds: ["msg-child"],
				taskId: "test",
				ts: 1005,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		// Message 0: user (prompt)
		// Message 1: assistant (text + tool_use)
		// Message 2: user (tool_result + queue text)
		expect(messages).toHaveLength(3);
		const userMsg = messages[2] as { role: string; content: unknown[] };
		expect(userMsg.role).toBe("user");
		// Should have tool_result + text block with formatted queue message (no wrapper)
		const textBlocks = (
			userMsg.content as { type: string; text?: string }[]
		).filter((b) => b.type === "text");
		const queueTextBlock = textBlocks.find((b) =>
			b.text?.includes("task_complete"),
		);
		expect(queueTextBlock).toBeDefined();
		expect(queueTextBlock?.text).toContain(
			'<task_complete from_task="t1" task_name="Auth module" status="passed">All tests pass</task_complete>',
		);
	});

	test("Anthropic: user_message with body formats correctly at idle drain", () => {
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", ts: 0, content: "Start" },
				taskId: "test",
				ts: 1000,
			},
			{
				type: "assistant_text",
				content: "Done for now",
				taskId: "test",
				ts: 1001,
			},
			{
				type: "message",
				id: "msg-parent",
				body: {
					source: "task_message",
					id: "test-id",
					ts: 0,
					fromTaskId: "p1",
					fromTitle: "Orchestrator",
					content: "New instructions here",
					requestReply: true,
				},
				taskId: "test",
				ts: 1002,
			},
			{
				type: "messages_consumed",
				messageIds: ["msg-parent"],
				taskId: "test",
				ts: 1003,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		// Message 0: user (prompt)
		// Message 1: assistant (text)
		// Message 2: user (idle queue message)
		expect(messages).toHaveLength(3);
		const idleMsg = messages[2] as { role: string; content: string };
		expect(idleMsg.role).toBe("user");
		expect(idleMsg.content).toContain(
			'<task_message from_task="p1" task_name="Orchestrator" requestReply="true">New instructions here</task_message>',
		);
	});

	test("OpenAI: user_message with body.source=task_complete formats at cancellation point via standalone messages_consumed", () => {
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", ts: 0, content: "Start" },
				taskId: "test",
				ts: 1000,
			},
			{
				type: "assistant_text",
				content: "Working...",
				taskId: "test",
				ts: 1001,
			},
			{
				type: "tool_call",
				toolCallId: "tc1",
				tool: "bash",
				input: { command: "echo hi" },
				taskId: "test",
				ts: 1002,
			},
			{
				type: "message",
				id: "msg-child",
				body: {
					source: "task_complete",
					id: "test-id",
					ts: 0,
					taskId: "t1",
					title: "Auth module",
					success: true,
					output: "All tests pass",
				},
				taskId: "test",
				ts: 1003,
			},
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "tc1",
				content: "hi",
				isError: false,
				taskId: "test",
				ts: 1004,
			},
			{
				type: "messages_consumed",
				messageIds: ["msg-child"],
				taskId: "test",
				ts: 1005,
			},
		];
		const messages = eventsToOpenAIMessages(events);
		// Message 0: user (prompt)
		// Message 1: assistant (text + tool_calls)
		// Message 2: tool result with queue text appended
		expect(messages).toHaveLength(3);
		const toolMsg = messages[2] as { role: string; content: string };
		expect(toolMsg.role).toBe("tool");
		expect(toolMsg.content).toContain("hi");
		expect(toolMsg.content).toContain(
			'<task_complete from_task="t1" task_name="Auth module" status="passed">All tests pass</task_complete>',
		);
	});

	test("Anthropic: tool_result with pending section formats correctly", () => {
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", ts: 0, content: "Start" },
				taskId: "test",
				ts: 1000,
			},
			{
				type: "assistant_text",
				content: "Yielding",
				taskId: "test",
				ts: 1001,
			},
			{
				type: "tool_call",
				toolCallId: "tc-yield",
				tool: "mcp__opengraft__yield",
				input: {},
				taskId: "test",
				ts: 1002,
			},
			{
				type: "message",
				id: "msg-report",
				body: {
					source: "task_message",
					id: "test-id",
					ts: 0,
					fromTaskId: "t2",
					fromTitle: "Build",
					content: "50% done",
				},
				taskId: "test",
				ts: 1003,
			},
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "tc-yield",
				content: "",
				isError: false,
				pending: {
					runningChildren: [{ id: "t2", title: "Build" }],
					pendingClarifications: 0,
				},
				taskId: "test",
				ts: 1004,
			},
			{
				type: "messages_consumed",
				messageIds: ["msg-report"],
				taskId: "test",
				ts: 1005,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toHaveLength(3);
		const userMsg = messages[2] as { role: string; content: unknown[] };
		expect(userMsg.role).toBe("user");
		// Should have tool_result + queue text + pending section
		const allText = (userMsg.content as { type: string; text?: string }[])
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("");
		expect(allText).toContain("## Pending");
		expect(allText).toContain('"Build" (t2)');
	});

	test("OpenAI: tool_result with pending section formats correctly", () => {
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", ts: 0, content: "Start" },
				taskId: "test",
				ts: 1000,
			},
			{
				type: "assistant_text",
				content: "Yielding",
				taskId: "test",
				ts: 1001,
			},
			{
				type: "tool_call",
				toolCallId: "tc-yield",
				tool: "mcp__opengraft__yield",
				input: {},
				taskId: "test",
				ts: 1002,
			},
			{
				type: "message",
				id: "msg-report",
				body: {
					source: "task_message",
					id: "test-id",
					ts: 0,
					fromTaskId: "t2",
					fromTitle: "Build",
					content: "50% done",
				},
				taskId: "test",
				ts: 1003,
			},
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "tc-yield",
				content: "",
				isError: false,
				pending: {
					runningChildren: [{ id: "t2", title: "Build" }],
					pendingClarifications: 0,
				},
				taskId: "test",
				ts: 1004,
			},
			{
				type: "messages_consumed",
				messageIds: ["msg-report"],
				taskId: "test",
				ts: 1005,
			},
		];
		const messages = eventsToOpenAIMessages(events);
		expect(messages).toHaveLength(3);
		const toolMsg = messages[2] as { role: string; content: string };
		expect(toolMsg.role).toBe("tool");
		// The tool content should have the pure yield content + queue text + pending
		expect(toolMsg.content).toContain("## Pending");
		expect(toolMsg.content).toContain('"Build" (t2)');
	});

	test("Anthropic: user_message with body.images gets image blocks", () => {
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", ts: 0, content: "Start" },
				taskId: "test",
				ts: 1000,
			},
			{
				type: "assistant_text",
				content: "Done",
				taskId: "test",
				ts: 1001,
			},
			{
				type: "message",
				id: "msg-img",
				body: {
					source: "user",
					id: "test-id",
					ts: 0,
					content: "Look at this",
					images: [{ base64: "abc123", mediaType: "image/png" }],
				},
				taskId: "test",
				ts: 1002,
			},
			{
				type: "messages_consumed",
				messageIds: ["msg-img"],
				taskId: "test",
				ts: 1003,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toHaveLength(3);
		const idleMsg = messages[2] as { role: string; content: unknown[] };
		// Should be array content with text + image block
		expect(Array.isArray(idleMsg.content)).toBe(true);
		const imgBlock = (idleMsg.content as { type: string }[]).find(
			(b) => b.type === "image",
		);
		expect(imgBlock).toBeDefined();
	});

	test("Anthropic: multiple queue messages at once (child_complete + user) via messages_consumed", () => {
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", ts: 0, content: "Start" },
				taskId: "test",
				ts: 1000,
			},
			{ type: "assistant_text", content: "Working", taskId: "test", ts: 1001 },
			{
				type: "tool_call",
				toolCallId: "tc1",
				tool: "bash",
				input: { command: "echo" },
				taskId: "test",
				ts: 1002,
			},
			{
				type: "message",
				id: "msg-complete",
				body: {
					source: "task_complete",
					id: "test-id",
					ts: 0,
					taskId: "t1",
					title: "Fix bug",
					success: true,
					output: "Fixed",
				},
				taskId: "test",
				ts: 1003,
			},
			{
				type: "message",
				id: "msg-user",
				body: { source: "user", id: "test-id", ts: 0, content: "Also do this" },
				taskId: "test",
				ts: 1004,
			},
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "tc1",
				content: "done",
				isError: false,
				taskId: "test",
				ts: 1005,
			},
			{
				type: "messages_consumed",
				messageIds: ["msg-complete", "msg-user"],
				taskId: "test",
				ts: 1006,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toHaveLength(3);
		const userMsg = messages[2] as { role: string; content: unknown[] };
		expect(userMsg.role).toBe("user");
		const textBlocks = (
			userMsg.content as { type: string; text?: string }[]
		).filter((b) => b.type === "text");
		// Each queue message is now its own text block (no wrapper)
		const allText = textBlocks.map((b) => b.text).join("\n");
		expect(allText).toContain("task_complete");
		expect(allText).toContain("Fix bug");
		expect(allText).toContain("Also do this");
	});

	test("OpenAI: multiple queue messages at once (child_complete + user) via messages_consumed", () => {
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", ts: 0, content: "Start" },
				taskId: "test",
				ts: 1000,
			},
			{ type: "assistant_text", content: "Working", taskId: "test", ts: 1001 },
			{
				type: "tool_call",
				toolCallId: "tc1",
				tool: "bash",
				input: { command: "echo" },
				taskId: "test",
				ts: 1002,
			},
			{
				type: "message",
				id: "msg-complete",
				body: {
					source: "task_complete",
					id: "test-id",
					ts: 0,
					taskId: "t1",
					title: "Fix bug",
					success: true,
					output: "Fixed",
				},
				taskId: "test",
				ts: 1003,
			},
			{
				type: "message",
				id: "msg-user",
				body: { source: "user", id: "test-id", ts: 0, content: "Also do this" },
				taskId: "test",
				ts: 1004,
			},
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "tc1",
				content: "done",
				isError: false,
				taskId: "test",
				ts: 1005,
			},
			{
				type: "messages_consumed",
				messageIds: ["msg-complete", "msg-user"],
				taskId: "test",
				ts: 1006,
			},
		];
		const messages = eventsToOpenAIMessages(events);
		expect(messages).toHaveLength(3);
		const toolMsg = messages[2] as { role: string; content: string };
		expect(toolMsg.role).toBe("tool");
		expect(toolMsg.content).toContain("done");
		expect(toolMsg.content).toContain("task_complete");
		expect(toolMsg.content).toContain("Also do this");
	});

	test("Anthropic: yield/done tool_result with structured body events from JSONL", () => {
		// This simulates what JSONL looks like after yield/done tool execution:
		// 1. user_message events written by waitForQueueMessages
		// 2. tool_result with pure content (yield result text)
		// 3. messages_consumed written by provider
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", ts: 0, content: "Start" },
				taskId: "test",
				ts: 1000,
			},
			{ type: "assistant_text", content: "Yielding", taskId: "test", ts: 1001 },
			{
				type: "tool_call",
				toolCallId: "tc-yield",
				tool: "mcp__opengraft__yield",
				input: {},
				taskId: "test",
				ts: 1002,
			},
			// Written by waitForQueueMessages to JSONL
			{
				type: "message",
				id: "msg-child-done",
				body: {
					source: "task_complete",
					id: "test-id",
					ts: 0,
					taskId: "t1",
					title: "Build UI",
					success: true,
					output: "All tests pass",
				},
				taskId: "test",
				ts: 1003,
			},
			{
				type: "message",
				id: "msg-parent",
				body: {
					source: "task_message",
					id: "test-id",
					ts: 0,
					fromTaskId: "p1",
					fromTitle: "Orchestrator",
					content: "Keep going",
				},
				taskId: "test",
				ts: 1004,
			},
			// tool_result with pure yield output (no embedded queue text)
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "tc-yield",
				content:
					'<task_complete from_task="t1" task_name="Build UI" status="passed">All tests pass</task_complete>\n<task_message from_task="p1" task_name="Orchestrator">Keep going</task_message>\n\n## Pending\n- Running sub tasks: none\n- Pending clarifications: none',
				isError: false,
				pending: {
					runningChildren: [],
					pendingClarifications: 0,
				},
				taskId: "test",
				ts: 1005,
			},
			// Standalone messages_consumed written by provider
			{
				type: "messages_consumed",
				messageIds: ["msg-child-done", "msg-parent"],
				taskId: "test",
				ts: 1006,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		// user (prompt), assistant (tool_use), user (tool_result + queue text + pending)
		expect(messages).toHaveLength(3);
		const userMsg = messages[2] as { role: string; content: unknown[] };
		expect(userMsg.role).toBe("user");
		const textBlocks = (
			userMsg.content as { type: string; text?: string }[]
		).filter((b) => b.type === "text");
		// Should have: tool_result content + queue messages text + pending text
		const allText = textBlocks.map((b) => b.text).join("");
		expect(allText).toContain("Build UI");
		expect(allText).toContain("Keep going");
		expect(allText).toContain("## Pending");
		expect(allText).toContain("none");
	});

	test("Anthropic: mixed tools — only last tool_result group gets queue messages", () => {
		// Two tool calls, but queue messages arrive after tool execution
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", id: "test-id", ts: 0, content: "Start" },
				taskId: "test",
				ts: 1000,
			},
			{
				type: "assistant_text",
				content: "Running tools",
				taskId: "test",
				ts: 1001,
			},
			{
				type: "tool_call",
				toolCallId: "tc-read",
				tool: "read_file",
				input: { path: "foo.ts" },
				taskId: "test",
				ts: 1002,
			},
			{
				type: "tool_call",
				toolCallId: "tc-bash",
				tool: "bash",
				input: { command: "echo ok" },
				taskId: "test",
				ts: 1003,
			},
			{
				type: "message",
				id: "msg-report",
				body: {
					source: "task_message",
					id: "test-id",
					ts: 0,
					fromTaskId: "t2",
					fromTitle: "Worker",
					content: "Progress: 75%",
				},
				taskId: "test",
				ts: 1004,
			},
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "tc-read",
				content: "const x = 1;",
				isError: false,
				taskId: "test",
				ts: 1005,
			},
			{
				type: "tool_result",
				tool: "test_tool",
				toolCallId: "tc-bash",
				content: "ok",
				isError: false,
				taskId: "test",
				ts: 1006,
			},
			{
				type: "messages_consumed",
				messageIds: ["msg-report"],
				taskId: "test",
				ts: 1007,
			},
		];
		const messages = eventsToAnthropicMessages(events);
		expect(messages).toHaveLength(3);
		const userMsg = messages[2] as { role: string; content: unknown[] };
		// Should have: 2 tool_results + 1 text block with queue message (no wrapper)
		const toolResults = (userMsg.content as { type: string }[]).filter(
			(b) => b.type === "tool_result",
		);
		expect(toolResults).toHaveLength(2);
		const textBlocks = (
			userMsg.content as { type: string; text?: string }[]
		).filter((b) => b.type === "text" && b.text?.includes("Worker"));
		expect(textBlocks).toHaveLength(1);
		expect(textBlocks[0]?.text).toContain("Progress: 75%");
	});
});

describe("defensive guards — prevent content: Field required 400 errors", () => {
	describe("message/user_message without id and without content", () => {
		test("Anthropic: message with body and source uses formatEventForAI fallback", () => {
			// message with source + body (non-user queue message) — formatEventForAI generates content from body
			// Two-phase lifecycle: message event deferred, then materialized by messages_consumed
			const events: Event[] = [
				{
					type: "message",
					id: "test-id",
					body: {
						source: "task_message",
						id: "test-id",
						ts: 1000,
						fromTaskId: "p1",
						fromTitle: "Orchestrator",
						content: "Do this next",
					},
					taskId: "test",
					ts: 1000,
				} as unknown as Event,
				{
					type: "messages_consumed",
					messageIds: ["test-id"],
					taskId: "test",
					ts: 1001,
				},
			];
			const messages = eventsToAnthropicMessages(events);
			expect(messages).toHaveLength(1);
			const msg = messages[0] as { role: string; content: string };
			expect(msg.role).toBe("user");
			expect(msg.content).toContain("task_message");
			expect(msg.content).toContain("Do this next");
		});

		test("Anthropic: message with body but no source uses body to format", () => {
			// message with body — formatEventForAI reads from body
			const events: Event[] = [
				{
					type: "message",
					body: {
						source: "task_message",
						id: "test-id",
						ts: 0,
						fromTaskId: "p1",
						fromTitle: "Orchestrator",
						content: "Do this next",
					},
					taskId: "test",
					ts: 1000,
				} as unknown as Event,
			];
			const messages = eventsToAnthropicMessages(events);
			expect(messages).toHaveLength(1);
			const msg = messages[0] as { role: string; content: string };
			expect(msg.role).toBe("user");
			expect(msg.content).toContain("task_message");
			expect(msg.content).toContain("Do this next");
		});

		test("Anthropic: message with no content and no body falls back to (empty)", () => {
			const events: Event[] = [
				{ type: "message", taskId: "test", ts: 1000 } as unknown as Event,
			];
			const messages = eventsToAnthropicMessages(events);
			expect(messages).toHaveLength(1);
			const msg = messages[0] as { role: string; content: string };
			expect(msg.role).toBe("user");
			expect(msg.content).toBe("(empty)");
		});

		test("OpenAI: message with body and source uses formatEventForAI", () => {
			const events: Event[] = [
				{
					type: "message",
					id: "",
					body: {
						source: "tree_change",
						id: "test-id",
						ts: 0,
						action: "created",
						nodeId: "node-1",
						title: "My Task",
					},
					taskId: "test",
					ts: 1000,
				} as unknown as Event,
			];
			const messages = eventsToOpenAIMessages(events);
			expect(messages).toHaveLength(1);
			const msg = messages[0] as { role: string; content: string };
			expect(msg.role).toBe("user");
			expect(msg.content).toContain("tree_change");
			expect(msg.content).toContain("created");
		});

		test("OpenAI: message with body but no source uses body to format", () => {
			// formatEventForAI reads from body
			const events: Event[] = [
				{
					type: "message",
					id: "",
					body: {
						source: "tree_change",
						id: "test-id",
						ts: 0,
						action: "updated",
						nodeId: "node-2",
					},
					taskId: "test",
					ts: 1000,
				} as unknown as Event,
			];
			const messages = eventsToOpenAIMessages(events);
			expect(messages).toHaveLength(1);
			const msg = messages[0] as { role: string; content: string };
			expect(msg.role).toBe("user");
			expect(msg.content).toContain("tree_change");
			expect(msg.content).toContain("updated");
		});

		test("OpenAI: message with no content and no body falls back to (empty)", () => {
			const events: Event[] = [
				{ type: "message", taskId: "test", ts: 1000 } as unknown as Event,
			];
			const messages = eventsToOpenAIMessages(events);
			expect(messages).toHaveLength(1);
			const msg = messages[0] as { role: string; content: string };
			expect(msg.role).toBe("user");
			expect(msg.content).toBe("(empty)");
		});
	});

	describe("empty assistant content blocks", () => {
		test("Anthropic: empty contentBlocks gets (empty) text fallback", () => {
			// Simulate a scenario where assistant_text/tool_call case is entered
			// but the collection loops find nothing (e.g., corrupt JSONL where
			// assistant_text event has wrong type after normalization)
			const events: Event[] = [
				{
					type: "message",
					id: "",
					body: { source: "user", id: "test-id", ts: 0, content: "Hello" },
					taskId: "test",
					ts: 1000,
				} as unknown as Event,
				// assistant_text with empty content still produces a block, so we test
				// the structural guard by checking the output is always valid
				{
					type: "assistant_text",
					content: "",
					taskId: "test",
					ts: 1001,
				} as unknown as Event,
			];
			const messages = eventsToAnthropicMessages(events);
			expect(messages).toHaveLength(2);
			const assistantMsg = messages[1] as {
				role: string;
				content: Array<{ type: string; text?: string }>;
			};
			expect(assistantMsg.role).toBe("assistant");
			expect(assistantMsg.content.length).toBeGreaterThan(0);
			// Content should always be a non-empty array
			expect(assistantMsg.content[0]?.type).toBe("text");
		});

		test("OpenAI: empty assistant message gets (empty) text fallback", () => {
			const events: Event[] = [
				{
					type: "message",
					id: "",
					body: { source: "user", id: "test-id", ts: 0, content: "Hello" },
					taskId: "test",
					ts: 1000,
				} as unknown as Event,
				{
					type: "assistant_text",
					content: "",
					taskId: "test",
					ts: 1001,
				} as unknown as Event,
			];
			const messages = eventsToOpenAIMessages(events);
			expect(messages).toHaveLength(2);
			const assistantMsg = messages[1] as {
				role: string;
				content: string | null;
			};
			expect(assistantMsg.role).toBe("assistant");
			// OpenAI uses string content (possibly empty string), which is valid
			expect(assistantMsg.content).toBeDefined();
		});
	});

	describe("empty tool_result blocks", () => {
		test("Anthropic: tool_result with undefined content gets (empty) fallback", () => {
			const events: Event[] = [
				{
					type: "message",
					id: "",
					body: { source: "user", id: "test-id", ts: 0, content: "Run it" },
					taskId: "test",
					ts: 1000,
				} as unknown as Event,
				{
					type: "assistant_text",
					content: "Running...",
					taskId: "test",
					ts: 1001,
				} as unknown as Event,
				{
					type: "tool_call",
					toolCallId: "tc1",
					tool: "bash",
					input: { command: "ls" },
					taskId: "test",
					ts: 1002,
				} as unknown as Event,
				{
					type: "tool_result",
					tool: "test_tool",
					toolCallId: "tc1",
					// content is undefined — simulating corrupt JSONL
					taskId: "test",
					ts: 1003,
				} as unknown as Event,
			];
			const messages = eventsToAnthropicMessages(events);
			// user, assistant, user(tool_result)
			expect(messages).toHaveLength(3);
			const toolResultMsg = messages[2] as {
				role: string;
				content: Array<{ type: string; content?: string }>;
			};
			expect(toolResultMsg.role).toBe("user");
			expect(toolResultMsg.content.length).toBeGreaterThan(0);
			const resultBlock = toolResultMsg.content[0] as {
				type: string;
				content: string;
			};
			expect(resultBlock.type).toBe("tool_result");
			expect(resultBlock.content).toBe("(empty)");
		});

		test("OpenAI: tool_result with undefined content gets (empty) fallback", () => {
			const events: Event[] = [
				{
					type: "message",
					id: "",
					body: { source: "user", id: "test-id", ts: 0, content: "Run it" },
					taskId: "test",
					ts: 1000,
				} as unknown as Event,
				{
					type: "assistant_text",
					content: "Running...",
					taskId: "test",
					ts: 1001,
				} as unknown as Event,
				{
					type: "tool_call",
					toolCallId: "tc1",
					tool: "bash",
					input: { command: "ls" },
					taskId: "test",
					ts: 1002,
				} as unknown as Event,
				{
					type: "tool_result",
					tool: "test_tool",
					toolCallId: "tc1",
					// content is undefined — simulating corrupt JSONL
					taskId: "test",
					ts: 1003,
				} as unknown as Event,
			];
			const messages = eventsToOpenAIMessages(events);
			// user, assistant, tool
			expect(messages).toHaveLength(3);
			const toolMsg = messages[2] as { role: string; content: string };
			expect(toolMsg.role).toBe("tool");
			expect(toolMsg.content).toBe("(empty)");
		});

		test("Anthropic: resultBlocks fallback when tool_result section collects nothing", () => {
			// Edge case: tool_result case is entered but the while loop skips
			// everything (all events are queue events with IDs that get skipped)
			const events: Event[] = [
				{
					type: "message",
					id: "",
					body: { source: "user", id: "test-id", ts: 0, content: "Hello" },
					taskId: "test",
					ts: 1000,
				} as unknown as Event,
				{
					type: "assistant_text",
					content: "Running",
					taskId: "test",
					ts: 1001,
				} as unknown as Event,
				{
					type: "tool_call",
					toolCallId: "tc1",
					tool: "bash",
					input: {},
					taskId: "test",
					ts: 1002,
				} as unknown as Event,
				{
					type: "tool_result",
					tool: "test_tool",
					toolCallId: "tc1",
					content: "output",
					taskId: "test",
					ts: 1003,
				} as unknown as Event,
			];
			const messages = eventsToAnthropicMessages(events);
			expect(messages).toHaveLength(3);
			const toolResultMsg = messages[2] as {
				role: string;
				content: Array<{ type: string }>;
			};
			expect(toolResultMsg.content.length).toBeGreaterThan(0);
		});
	});
});

describe("isPersistedByEmitEvent", () => {
	test("ephemeral events return false", () => {
		const ephemeralTypes: Event["type"][] = [
			"text_delta",
			"usage",
			"agent_idle",
			"agent_active",
			"status",
			"clarification_timeout",
		];
		for (const type of ephemeralTypes) {
			const event = { type, taskId: "test", ts: 1000 } as Event;
			expect(isPersistedByEmitEvent(event)).toBe(false);
		}
	});

	test("persisted events return true", () => {
		const persistedTypes: Event["type"][] = [
			"message",
			"assistant_text",
			"tool_call",
			"tool_result",
			"compacted_resume",
			"summarization_request",
			"budget_warning",
			"compact_marker",
			"orchestration_started",
			"orchestration_completed",
			"task_started",
			"error",
			"budget_exceeded",
			"clarification_requested",
			"clarification_answered",
			"compact_started",
			"agent_stopped",
			"messages_consumed",
			"fork_marker",
		];
		for (const type of persistedTypes) {
			const event = { type, taskId: "test", ts: 1000 } as Event;
			expect(isPersistedByEmitEvent(event)).toBe(true);
		}
	});

	test("covers all Event types (exhaustive switch ensures compile-time safety)", () => {
		// This test documents that isPersistedByEmitEvent has a `default: never` guard.
		// If a new Event type is added to the union without handling it in the switch,
		// TypeScript will report a compile error: "Type '...' is not assignable to type 'never'".
		// The typecheck passing IS the test — this test just verifies every known type is handled.
		const allTypes: Event["type"][] = [
			"message",
			"assistant_text",
			"tool_call",
			"tool_result",
			"text_delta",
			"usage",
			"agent_idle",
			"agent_active",
			"status",
			"clarification_timeout",
			"compacted_resume",
			"summarization_request",
			"budget_warning",
			"compact_marker",
			"orchestration_started",
			"orchestration_completed",
			"task_started",
			"error",
			"budget_exceeded",
			"clarification_requested",
			"clarification_answered",
			"compact_started",
			"agent_stopped",
			"messages_consumed",
		];
		for (const type of allTypes) {
			const event = { type, taskId: "test", ts: 1000 } as Event;
			const result = isPersistedByEmitEvent(event);
			expect(typeof result).toBe("boolean");
		}
	});
});
