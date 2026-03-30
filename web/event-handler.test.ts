import { describe, expect, it, mock } from "bun:test";
import type React from "react";
import { createEventHandler, type EventHandlerDeps } from "./event-handler.ts";
import type { IncomingEvent, LogEntry } from "./hooks.ts";

/** Minimal deps that satisfy the EventHandlerDeps interface */
function makeDeps() {
	const logs: LogEntry[][] = [];
	return {
		deps: {
			updateFromWS: mock(() => {}),
			setRootNodeId: mock(() => {}),
			setActiveAgents: mock(() => {}),
			checkAgentStatus: mock(() => {}),
			setAgentProvider: mock(() => {}),
			setAgentModel: mock(() => {}),
			setLogs: mock((updater: React.SetStateAction<LogEntry[]>) => {
				if (typeof updater === "function") {
					const result = updater([]);
					logs.push(result);
				} else {
					logs.push(updater);
				}
			}),
			setTokenUsage: mock(() => {}),
			setPendingMessages: mock(() => {}),
			setPendingClarifications: mock(() => {}),
			setLastTurns: mock(() => {}),
			setLastInputTokens: mock(() => {}),
			setLastCacheCreationTokens: mock(() => {}),
			setLastCacheReadTokens: mock(() => {}),
			setLastOutputTokens: mock(() => {}),
			setBackgroundProcesses: mock(() => {}),
			t: (key: string) => key,
		},
		logs,
	};
}

describe("event-handler queueEntry handling", () => {
	it("processEventBatch: user_message with queueEntry.source=task_message materializes as task_message", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((entries: React.SetStateAction<LogEntry[]>) => {
			capturedLogs = typeof entries === "function" ? entries([]) : entries;
		});

		const { processEventBatch } = createEventHandler(deps as EventHandlerDeps);

		processEventBatch([
			{
				type: "message",
				id: "msg-1",
				body: {
					source: "task_message",
					id: "test-id",
					ts: 0,
					fromTaskId: "child-1",
					fromTitle: "My Child Task",
					content: "Progress update: 50% done",
				},
				taskId: "parent-1",
				ts: 1000,
			},
			{
				type: "messages_consumed",
				messageIds: ["msg-1"],
				taskId: "parent-1",
				ts: 2000,
			},
		] satisfies IncomingEvent[]);

		const taskMessageEntry = capturedLogs.find(
			(e: LogEntry) => e.type === "task_message",
		);
		expect(taskMessageEntry).toBeDefined();
		expect(taskMessageEntry?.content).toBe("Progress update: 50% done");
		expect(taskMessageEntry?.fromTitle).toBe("My Child Task");
		// taskId should be the PARENT's (consuming agent), not the child's
		expect(taskMessageEntry?.taskId).toBe("parent-1");
	});

	it("processEventBatch: user_message with queueEntry.source=task_message (downward) materializes as task_message", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((entries: React.SetStateAction<LogEntry[]>) => {
			capturedLogs = typeof entries === "function" ? entries([]) : entries;
		});

		const { processEventBatch } = createEventHandler(deps as EventHandlerDeps);

		processEventBatch([
			{
				type: "message",
				id: "msg-2",
				body: {
					source: "task_message",
					id: "test-id",
					ts: 0,
					fromTaskId: "p1",
					fromTitle: "Orchestrator",
					content: "Please also fix bug #42",
				},
				taskId: "task-1",
				ts: 1000,
			},
			{
				type: "messages_consumed",
				messageIds: ["msg-2"],
				taskId: "task-1",
				ts: 2000,
			},
		] satisfies IncomingEvent[]);

		const taskMessageEntry = capturedLogs.find(
			(e: LogEntry) => e.type === "task_message",
		);
		expect(taskMessageEntry).toBeDefined();
		expect(taskMessageEntry?.content).toBe("Please also fix bug #42");
	});

	it("processEventBatch: user_message with queueEntry.source=user still renders as user_message", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((entries: React.SetStateAction<LogEntry[]>) => {
			capturedLogs = typeof entries === "function" ? entries([]) : entries;
		});

		const { processEventBatch } = createEventHandler(deps as EventHandlerDeps);

		processEventBatch([
			{
				type: "message",
				id: "msg-3",
				body: {
					source: "user",
					id: "test-id",
					ts: 0,
					content: "Hello world",
				},
				taskId: "task-1",
				ts: 1000,
			},
			{
				type: "messages_consumed",
				messageIds: ["msg-3"],
				taskId: "task-1",
				ts: 2000,
			},
		] satisfies IncomingEvent[]);

		const userEntry = capturedLogs.find((e: LogEntry) => e.type === "message");
		expect(userEntry).toBeDefined();
		expect(
			userEntry?.type === "message" && userEntry.body.source === "user"
				? userEntry.body.content
				: "",
		).toBe("Hello world");
	});

	it("processEventBatch: unconsumed non-user user_message goes to pendingMessages with descriptive text", () => {
		const { deps } = makeDeps();

		let capturedPending: unknown[] = [];
		(deps as Record<string, unknown>).setPendingMessages = mock(
			(updater: React.SetStateAction<unknown[]>) => {
				capturedPending = typeof updater === "function" ? updater([]) : updater;
			},
		);

		const { processEventBatch } = createEventHandler(deps as EventHandlerDeps);

		processEventBatch([
			{
				type: "message",
				id: "msg-4",
				body: {
					source: "task_message",
					id: "test-id",
					ts: 0,
					fromTaskId: "child-1",
					fromTitle: "Worker",
					content: "Phase 1 done",
				},
				taskId: "parent-1",
				ts: 1000,
			},
			// No messages_consumed — message is unconsumed
		] satisfies IncomingEvent[]);

		// Non-user messages also appear in pending banner with descriptive text
		expect(capturedPending.length).toBe(1);
		expect((capturedPending[0] as { text: string }).text).toBe(
			"↑ Worker: Phase 1 done",
		);
	});

	it("processEventBatch: unconsumed user-typed user_message goes to pendingMessages", () => {
		const { deps } = makeDeps();

		let capturedPending: unknown[] = [];
		(deps as Record<string, unknown>).setPendingMessages = mock(
			(updater: React.SetStateAction<unknown[]>) => {
				capturedPending = typeof updater === "function" ? updater([]) : updater;
			},
		);

		const { processEventBatch } = createEventHandler(deps as EventHandlerDeps);

		processEventBatch([
			{
				type: "message",
				id: "msg-5",
				body: { source: "user", id: "test-id", ts: 0, content: "Please check this" },
				taskId: "task-1",
				ts: 1000,
			},
			// No messages_consumed — message is unconsumed
		] satisfies IncomingEvent[]);

		expect(capturedPending.length).toBe(1);
		expect((capturedPending[0] as { text: string }).text).toBe(
			"Please check this",
		);
	});

	it("processEventBatch: message with body.source=task_message materializes correctly", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((entries: React.SetStateAction<LogEntry[]>) => {
			capturedLogs = typeof entries === "function" ? entries([]) : entries;
		});

		const { processEventBatch } = createEventHandler(deps as EventHandlerDeps);

		processEventBatch([
			{
				type: "message",
				id: "msg-6",
				body: {
					source: "task_message",
					id: "test-id",
					ts: 0,
					fromTaskId: "child-1",
					fromTitle: "New Task",
					content: "Report content",
				},
				taskId: "parent-1",
				ts: 1000,
			},
			{
				type: "messages_consumed",
				messageIds: ["msg-6"],
				taskId: "parent-1",
				ts: 2000,
			},
		] satisfies IncomingEvent[]);

		const taskMessageEntry = capturedLogs.find(
			(e: LogEntry) => e.type === "task_message",
		);
		expect(taskMessageEntry).toBeDefined();
		expect(taskMessageEntry?.content).toBe("Report content");
		expect(taskMessageEntry?.fromTitle).toBe("New Task");
	});

	it("handleEvent: live user_message with queueEntry.source=task_message deferred, then messages_consumed renders card", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((updater: React.SetStateAction<LogEntry[]>) => {
			if (typeof updater === "function") {
				capturedLogs = updater(capturedLogs);
			} else {
				capturedLogs = updater;
			}
		});

		let capturedPending: unknown[] = [];
		(deps as Record<string, unknown>).setPendingMessages = mock(
			(updater: React.SetStateAction<unknown[]>) => {
				capturedPending =
					typeof updater === "function" ? updater(capturedPending) : updater;
			},
		);

		const { handleEvent } = createEventHandler(deps as EventHandlerDeps);

		// 1. Receive user_message with queueEntry (non-user source)
		handleEvent({
			type: "message",
			id: "msg-7",
			body: {
				source: "task_message",
				id: "test-id",
				ts: 0,
				fromTaskId: "child-1",
				fromTitle: "Worker Task",
				content: "I'm done with phase 1",
			},
			taskId: "parent-1",
			ts: 1000,
		} satisfies IncomingEvent);

		// Should be in pending banner with descriptive text
		expect(capturedPending.length).toBe(1);
		expect((capturedPending[0] as { text: string }).text).toBe(
			"↑ Worker Task: I'm done with phase 1",
		);
		// Should NOT be in activity log yet
		expect(capturedLogs.length).toBe(0);

		// 2. Receive messages_consumed
		handleEvent({
			type: "messages_consumed",
			messageIds: ["msg-7"],
			taskId: "parent-1",
			ts: 2000,
		} satisfies IncomingEvent);

		// Now should appear in activity log as task_message
		const taskMessageEntry = capturedLogs.find(
			(e: LogEntry) => e.type === "task_message",
		);
		expect(taskMessageEntry).toBeDefined();
		expect(taskMessageEntry?.content).toBe("I'm done with phase 1");
		// taskId should be the PARENT's (consuming agent), not the child's
		expect(taskMessageEntry?.taskId).toBe("parent-1");
		// Pending should be cleared
		expect(capturedPending.length).toBe(0);
	});

	it("handleEvent: live user_message (actual user) goes to pending, then messages_consumed moves to log", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((updater: React.SetStateAction<LogEntry[]>) => {
			if (typeof updater === "function") {
				capturedLogs = updater(capturedLogs);
			} else {
				capturedLogs = updater;
			}
		});

		let capturedPending: Array<{ id: string; text: string }> = [];
		(deps as Record<string, unknown>).setPendingMessages = mock(
			(updater: React.SetStateAction<Array<{ id: string; text: string }>>) => {
				capturedPending =
					typeof updater === "function" ? updater(capturedPending) : updater;
			},
		);

		const { handleEvent } = createEventHandler(deps as EventHandlerDeps);

		// 1. Receive message (actual user)
		handleEvent({
			type: "message",
			id: "msg-8",
			body: { source: "user", id: "test-id", ts: 0, content: "Build a feature" },
			taskId: "task-1",
			ts: 1000,
		} satisfies IncomingEvent);

		// Should be in pending banner
		expect(capturedPending.length).toBe(1);
		expect(capturedPending[0]?.text).toBe("Build a feature");

		// 2. Receive messages_consumed
		handleEvent({
			type: "messages_consumed",
			messageIds: ["msg-8"],
			taskId: "task-1",
			ts: 2000,
		} satisfies IncomingEvent);

		// Should be moved to activity log
		const userEntry = capturedLogs.find((e: LogEntry) => e.type === "message");
		expect(userEntry).toBeDefined();
		expect(
			userEntry?.type === "message" && userEntry.body.source === "user"
				? userEntry.body.content
				: "",
		).toBe("Build a feature");

		// Should be removed from pending
		expect(capturedPending.length).toBe(0);
	});

	it("processEventBatch: user_message with queueEntry.source=clarify_response materializes correctly", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((entries: React.SetStateAction<LogEntry[]>) => {
			capturedLogs = typeof entries === "function" ? entries([]) : entries;
		});

		const { processEventBatch } = createEventHandler(deps as EventHandlerDeps);

		processEventBatch([
			{
				type: "message",
				id: "msg-9",
				body: {
					source: "clarify_response",
					id: "test-id",
					ts: 0,
					answer: "Yes, go ahead with approach A",
				},
				taskId: "task-1",
				ts: 1000,
			},
			{
				type: "messages_consumed",
				messageIds: ["msg-9"],
				taskId: "task-1",
				ts: 2000,
			},
		] satisfies IncomingEvent[]);

		const clarifyEntry = capturedLogs.find(
			(e: LogEntry) => e.type === "clarify_response",
		);
		expect(clarifyEntry).toBeDefined();
		expect(clarifyEntry?.answer).toBe("Yes, go ahead with approach A");
	});
});

describe("event-handler JSONL-driven pending state", () => {
	it("pending state is derived from deferredMessages map — no race condition possible", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((updater: React.SetStateAction<LogEntry[]>) => {
			if (typeof updater === "function") {
				capturedLogs = updater(capturedLogs);
			} else {
				capturedLogs = updater;
			}
		});

		let capturedPending: Array<{
			id: string;
			text: string;
			taskId: string | null;
			timestamp: number;
		}> = [];
		(deps as Record<string, unknown>).setPendingMessages = mock(
			(
				updater: React.SetStateAction<
					Array<{
						id: string;
						text: string;
						taskId: string | null;
						timestamp: number;
					}>
				>,
			) => {
				capturedPending =
					typeof updater === "function" ? updater(capturedPending) : updater;
			},
		);

		const { handleEvent } = createEventHandler(deps as EventHandlerDeps);

		// Step 1: message arrives → deferred in map, shown in pending banner
		handleEvent({
			type: "message",
			id: "msg-race",
			body: { source: "user", id: "test-id", ts: 0, content: "Hello world" },
			taskId: "",
			ts: 1000,
		} satisfies IncomingEvent);
		expect(capturedPending.length).toBe(1);
		expect(capturedPending[0]?.id).toBe("msg-race");
		expect(capturedLogs.length).toBe(0);

		// Step 2: messages_consumed arrives — materializes in log, clears from pending
		// No pending_messages:[] race — pending state is derived from deferredMessages map
		handleEvent({
			type: "messages_consumed",
			messageIds: ["msg-race"],
			taskId: "",
			ts: 2000,
		} satisfies IncomingEvent);

		// The user message MUST appear in the activity log
		const userEntry = capturedLogs.find((e: LogEntry) => e.type === "message");
		expect(userEntry).toBeDefined();
		expect(
			userEntry?.type === "message" && userEntry.body.source === "user"
				? userEntry.body.content
				: "",
		).toBe("Hello world");
		// Pending should be cleared
		expect(capturedPending.length).toBe(0);
	});
});

describe("event-handler tool_pair creation", () => {
	it("processEventBatch: tool_call + tool_result creates a tool_pair entry", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((entries: React.SetStateAction<LogEntry[]>) => {
			capturedLogs = typeof entries === "function" ? entries([]) : entries;
		});

		const { processEventBatch } = createEventHandler(deps as EventHandlerDeps);

		processEventBatch([
			{
				type: "tool_call",
				tool: "mcp__opengraft__bash",
				toolCallId: "tc-1",
				input: { command: "ls" },
				taskId: "task-1",
				ts: 1000,
			},
			{
				type: "tool_result",
				tool: "mcp__opengraft__bash",
				toolCallId: "tc-1",
				content: "file1.ts\nfile2.ts",
				isError: false,
				taskId: "task-1",
				ts: 2000,
			},
		]);

		// Should produce a single tool_pair entry, not separate tool_call + tool_result
		expect(capturedLogs.length).toBe(1);
		const pair = capturedLogs[0];
		expect(pair?.type).toBe("tool_pair");
		if (pair?.type === "tool_pair") {
			expect(pair.tool).toBe("mcp__opengraft__bash");
			expect(pair.toolCallId).toBe("tc-1");
			expect(pair.input).toEqual({ command: "ls" });
			expect(pair.resultContent).toBe("file1.ts\nfile2.ts");
			expect(pair.isError).toBe(false);
			expect(pair.taskId).toBe("task-1");
			expect(pair.ts).toBe(1000); // original tool_call timestamp
			expect(pair.resultTs).toBe(2000);
		}
	});

	it("processEventBatch: yield tool_call + tool_result are hidden entirely", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((entries: React.SetStateAction<LogEntry[]>) => {
			capturedLogs = typeof entries === "function" ? entries([]) : entries;
		});

		const { processEventBatch } = createEventHandler(deps as EventHandlerDeps);

		processEventBatch([
			{
				type: "tool_call",
				tool: "mcp__opengraft__yield",
				toolCallId: "tc-yield",
				input: {},
				taskId: "task-1",
				ts: 1000,
			},
			{
				type: "tool_result",
				tool: "mcp__opengraft__yield",
				toolCallId: "tc-yield",
				content: "resumed",
				isError: false,
				taskId: "task-1",
				ts: 5000,
			},
		]);

		// Yield pairs should be completely hidden
		expect(capturedLogs.length).toBe(0);
	});

	it("processEventBatch: unresolved tool_call remains as pending tool_call", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((entries: React.SetStateAction<LogEntry[]>) => {
			capturedLogs = typeof entries === "function" ? entries([]) : entries;
		});

		const { processEventBatch } = createEventHandler(deps as EventHandlerDeps);

		processEventBatch([
			{
				type: "tool_call",
				tool: "mcp__opengraft__bash",
				toolCallId: "tc-pending",
				input: { command: "sleep 10" },
				taskId: "task-1",
				ts: 1000,
			},
			// No tool_result — still pending
		]);

		expect(capturedLogs.length).toBe(1);
		expect(capturedLogs[0]?.type).toBe("tool_call");
	});

	it("handleEvent: live tool_call then tool_result replaces entry with tool_pair", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((updater: React.SetStateAction<LogEntry[]>) => {
			if (typeof updater === "function") {
				capturedLogs = updater(capturedLogs);
			} else {
				capturedLogs = updater;
			}
		});

		const { handleEvent } = createEventHandler(deps as EventHandlerDeps);

		// 1. tool_call arrives
		handleEvent({
			type: "tool_call",
			tool: "mcp__opengraft__read_file",
			toolCallId: "tc-live",
			input: { path: "foo.ts" },
			taskId: "task-1",
			ts: 1000,
		});

		expect(capturedLogs.length).toBe(1);
		expect(capturedLogs[0]?.type).toBe("tool_call");

		// 2. tool_result arrives
		handleEvent({
			type: "tool_result",
			tool: "mcp__opengraft__read_file",
			toolCallId: "tc-live",
			content: "const x = 1;",
			isError: false,
			taskId: "task-1",
			ts: 2000,
		});

		// Should replace tool_call with tool_pair — same count
		expect(capturedLogs.length).toBe(1);
		const pair = capturedLogs[0];
		expect(pair?.type).toBe("tool_pair");
		if (pair?.type === "tool_pair") {
			expect(pair.tool).toBe("mcp__opengraft__read_file");
			expect(pair.resultContent).toBe("const x = 1;");
			expect(pair.isError).toBe(false);
		}
	});

	it("handleEvent: live yield tool_call then tool_result removes entry entirely", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((updater: React.SetStateAction<LogEntry[]>) => {
			if (typeof updater === "function") {
				capturedLogs = updater(capturedLogs);
			} else {
				capturedLogs = updater;
			}
		});

		const { handleEvent } = createEventHandler(deps as EventHandlerDeps);

		handleEvent({
			type: "tool_call",
			tool: "mcp__opengraft__yield",
			toolCallId: "tc-yield-live",
			input: {},
			taskId: "task-1",
			ts: 1000,
		});

		expect(capturedLogs.length).toBe(1);
		expect(capturedLogs[0]?.type).toBe("tool_call");

		handleEvent({
			type: "tool_result",
			tool: "mcp__opengraft__yield",
			toolCallId: "tc-yield-live",
			content: "resumed",
			isError: false,
			taskId: "task-1",
			ts: 5000,
		});

		// Yield pair should be removed entirely
		expect(capturedLogs.length).toBe(0);
	});

	it("handleEvent: remove_tool removes tool_pair entries (not just tool_call)", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((updater: React.SetStateAction<LogEntry[]>) => {
			if (typeof updater === "function") {
				capturedLogs = updater(capturedLogs);
			} else {
				capturedLogs = updater;
			}
		});

		const { handleEvent } = createEventHandler(deps as EventHandlerDeps);

		// 1. yield tool_call arrives
		handleEvent({
			type: "tool_call",
			tool: "mcp__opengraft__yield",
			toolCallId: "tc-yield-pair",
			input: {},
			taskId: "task-1",
			ts: 1000,
		});
		expect(capturedLogs.length).toBe(1);
		expect(capturedLogs[0]?.type).toBe("tool_call");

		// 2. A tool_result with the same toolCallId resolves it to a tool_pair
		//    (e.g., duplicate event during reconnect replay)
		handleEvent({
			type: "tool_result",
			tool: "mcp__opengraft__read_file",
			toolCallId: "tc-yield-pair",
			content: "some content",
			isError: false,
			taskId: "task-1",
			ts: 2000,
		});
		expect(capturedLogs.length).toBe(1);
		expect(capturedLogs[0]?.type).toBe("tool_pair");

		// 3. The actual yield tool_result arrives with remove_tool
		handleEvent({
			type: "tool_result",
			tool: "mcp__opengraft__yield",
			toolCallId: "tc-yield-pair",
			content: "resumed",
			isError: false,
			taskId: "task-1",
			ts: 5000,
		});

		// Should remove the tool_pair entry entirely
		expect(capturedLogs.length).toBe(0);
	});

	it("processEventBatch: remove_tool removes tool_pair entries (not just tool_call)", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((entries: React.SetStateAction<LogEntry[]>) => {
			capturedLogs = typeof entries === "function" ? entries([]) : entries;
		});

		const { processEventBatch } = createEventHandler(deps as EventHandlerDeps);

		processEventBatch([
			// tool_call for yield
			{
				type: "tool_call",
				tool: "mcp__opengraft__yield",
				toolCallId: "tc-yield-batch",
				input: {},
				taskId: "task-1",
				ts: 1000,
			},
			// A non-yield tool_result resolves it to tool_pair first
			{
				type: "tool_result",
				tool: "mcp__opengraft__read_file",
				toolCallId: "tc-yield-batch",
				content: "content",
				isError: false,
				taskId: "task-1",
				ts: 2000,
			},
			// Then the actual yield tool_result fires remove_tool
			{
				type: "tool_result",
				tool: "mcp__opengraft__yield",
				toolCallId: "tc-yield-batch",
				content: "resumed",
				isError: false,
				taskId: "task-1",
				ts: 5000,
			},
		]);

		// The tool_pair should be removed
		expect(capturedLogs.length).toBe(0);
	});

	it("processEventBatch: tool_result with backgroundId still tracks background process", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((entries: React.SetStateAction<LogEntry[]>) => {
			capturedLogs = typeof entries === "function" ? entries([]) : entries;
		});

		let bgProcesses: Map<
			string,
			{ id: string; command: string; startTime: number; taskId?: string }
		> = new Map();
		(deps as Record<string, unknown>).setBackgroundProcesses = mock(
			(
				updater: React.SetStateAction<
					Map<
						string,
						{
							id: string;
							command: string;
							startTime: number;
							taskId?: string;
						}
					>
				>,
			) => {
				bgProcesses =
					typeof updater === "function" ? updater(bgProcesses) : updater;
			},
		);

		const { processEventBatch } = createEventHandler(deps as EventHandlerDeps);

		processEventBatch([
			{
				type: "tool_call",
				tool: "mcp__opengraft__bash",
				toolCallId: "tc-bg",
				input: { command: "long-running-cmd" },
				taskId: "task-1",
				ts: 1000,
			},
			{
				type: "tool_result",
				tool: "mcp__opengraft__bash",
				toolCallId: "tc-bg",
				content: "moved to background",
				isError: false,
				backgroundId: "bg-123",
				backgroundCommand: "long-running-cmd",
				taskId: "task-1",
				ts: 2000,
			},
		]);

		// Should create tool_pair with backgroundId
		expect(capturedLogs.length).toBe(1);
		const pair = capturedLogs[0];
		expect(pair?.type).toBe("tool_pair");
		if (pair?.type === "tool_pair") {
			expect(pair.backgroundId).toBe("bg-123");
			expect(pair.backgroundCommand).toBe("long-running-cmd");
		}

		// Background process should be tracked via side effect
		expect(bgProcesses.has("bg-123")).toBe(true);
	});

	it("processEventBatch: tool_result with isError=true creates error tool_pair", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((entries: React.SetStateAction<LogEntry[]>) => {
			capturedLogs = typeof entries === "function" ? entries([]) : entries;
		});

		const { processEventBatch } = createEventHandler(deps as EventHandlerDeps);

		processEventBatch([
			{
				type: "tool_call",
				tool: "mcp__opengraft__bash",
				toolCallId: "tc-err",
				input: { command: "failing-cmd" },
				taskId: "task-1",
				ts: 1000,
			},
			{
				type: "tool_result",
				tool: "mcp__opengraft__bash",
				toolCallId: "tc-err",
				content: "command not found",
				isError: true,
				taskId: "task-1",
				ts: 2000,
			},
		]);

		expect(capturedLogs.length).toBe(1);
		const pair = capturedLogs[0];
		expect(pair?.type).toBe("tool_pair");
		if (pair?.type === "tool_pair") {
			expect(pair.isError).toBe(true);
			expect(pair.resultContent).toBe("command not found");
		}
	});

	it("processEventBatch: orphan tool_result (no matching tool_call) creates standalone tool_pair", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((entries: React.SetStateAction<LogEntry[]>) => {
			capturedLogs = typeof entries === "function" ? entries([]) : entries;
		});

		const { processEventBatch } = createEventHandler(deps as EventHandlerDeps);

		processEventBatch([
			{
				type: "tool_result",
				tool: "mcp__opengraft__bash",
				toolCallId: "tc-orphan",
				content: "orphan result",
				isError: false,
				taskId: "task-1",
				ts: 2000,
			},
		]);

		// Should still render as tool_pair (with empty input)
		expect(capturedLogs.length).toBe(1);
		const pair = capturedLogs[0];
		expect(pair?.type).toBe("tool_pair");
		if (pair?.type === "tool_pair") {
			expect(pair.tool).toBe("mcp__opengraft__bash");
			expect(pair.input).toEqual({});
			expect(pair.resultContent).toBe("orphan result");
		}
	});

	it("processEventBatch: multiple tool_call + tool_result pairs resolve correctly", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((entries: React.SetStateAction<LogEntry[]>) => {
			capturedLogs = typeof entries === "function" ? entries([]) : entries;
		});

		const { processEventBatch } = createEventHandler(deps as EventHandlerDeps);

		processEventBatch([
			{
				type: "tool_call",
				tool: "mcp__opengraft__bash",
				toolCallId: "tc-a",
				input: { command: "echo a" },
				taskId: "task-1",
				ts: 1000,
			},
			{
				type: "tool_result",
				tool: "mcp__opengraft__bash",
				toolCallId: "tc-a",
				content: "a",
				isError: false,
				taskId: "task-1",
				ts: 1500,
			},
			{
				type: "tool_call",
				tool: "mcp__opengraft__read_file",
				toolCallId: "tc-b",
				input: { path: "b.ts" },
				taskId: "task-1",
				ts: 2000,
			},
			{
				type: "tool_result",
				tool: "mcp__opengraft__read_file",
				toolCallId: "tc-b",
				content: "content of b",
				isError: false,
				taskId: "task-1",
				ts: 2500,
			},
		]);

		expect(capturedLogs.length).toBe(2);
		expect(capturedLogs[0]?.type).toBe("tool_pair");
		expect(capturedLogs[1]?.type).toBe("tool_pair");
		if (capturedLogs[0]?.type === "tool_pair") {
			expect(capturedLogs[0].tool).toBe("mcp__opengraft__bash");
			expect(capturedLogs[0].resultContent).toBe("a");
		}
		if (capturedLogs[1]?.type === "tool_pair") {
			expect(capturedLogs[1].tool).toBe("mcp__opengraft__read_file");
			expect(capturedLogs[1].resultContent).toBe("content of b");
		}
	});
});

describe("event-handler compact_marker savedTokens", () => {
	it("processEvent returns savedTokens in the complete_compact UpdateOp", () => {
		const { deps } = makeDeps();
		// Smoke test: createEventHandler works without error
		createEventHandler(deps as EventHandlerDeps);
	});

	it("handleEvent: compact_marker with savedTokens=5000 produces LogEntry with savedTokens=5000", () => {
		const { deps } = makeDeps();

		// Pre-populate logs with a compact_started entry so the replacement path is hit
		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((updater: React.SetStateAction<LogEntry[]>) => {
			if (typeof updater === "function") {
				capturedLogs = updater(capturedLogs);
			} else {
				capturedLogs = updater;
			}
		});

		const { handleEvent } = createEventHandler(deps as EventHandlerDeps);

		// First, add a compact_started entry
		handleEvent({
			type: "compact_started",
			taskId: "task-1",
			ts: 1000,
		});

		// Now send compact_marker with savedTokens
		handleEvent({
			type: "compact_marker",
			savedTokens: 5000,
			checkpoint: "test checkpoint",
			taskId: "task-1",
			ts: 2000,
		});

		// Find the compact_marker entry
		const markerEntry = capturedLogs.find(
			(e: LogEntry) => e.type === "compact_marker",
		);
		expect(markerEntry).toBeDefined();
		expect(markerEntry?.savedTokens).toBe(5000);
	});

	it("handleEvent: compact_marker fallback (no compact_started) also uses savedTokens", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((updater: React.SetStateAction<LogEntry[]>) => {
			if (typeof updater === "function") {
				capturedLogs = updater(capturedLogs);
			} else {
				capturedLogs = updater;
			}
		});

		const { handleEvent } = createEventHandler(deps as EventHandlerDeps);

		// Send compact_marker without preceding compact_started
		handleEvent({
			type: "compact_marker",
			savedTokens: 8000,
			checkpoint: "test checkpoint",
			taskId: "task-2",
			ts: 3000,
		});

		const markerEntry = capturedLogs.find(
			(e: LogEntry) => e.type === "compact_marker",
		);
		expect(markerEntry).toBeDefined();
		expect(markerEntry?.savedTokens).toBe(8000);
	});

	it("processEventBatch: compact_marker with savedTokens flows through correctly", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((entries: React.SetStateAction<LogEntry[]>) => {
			capturedLogs = typeof entries === "function" ? entries([]) : entries;
		});

		const { processEventBatch } = createEventHandler(deps as EventHandlerDeps);

		processEventBatch([
			{ type: "compact_started", taskId: "task-3", ts: 1000 },
			{
				type: "compact_marker",
				savedTokens: 12000,
				checkpoint: "batch checkpoint",
				taskId: "task-3",
				ts: 2000,
			},
		]);

		const markerEntry = capturedLogs.find(
			(e: LogEntry) => e.type === "compact_marker",
		);
		expect(markerEntry).toBeDefined();
		expect(markerEntry?.savedTokens).toBe(12000);
	});

	it("processEventBatch: compact_marker fallback also uses savedTokens", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((entries: React.SetStateAction<LogEntry[]>) => {
			capturedLogs = typeof entries === "function" ? entries([]) : entries;
		});

		const { processEventBatch } = createEventHandler(deps as EventHandlerDeps);

		// No compact_started, just compact_marker directly
		processEventBatch([
			{
				type: "compact_marker",
				savedTokens: 3000,
				checkpoint: "fallback checkpoint",
				taskId: "task-4",
				ts: 2000,
			},
		]);

		const markerEntry = capturedLogs.find(
			(e: LogEntry) => e.type === "compact_marker",
		);
		expect(markerEntry).toBeDefined();
		expect(markerEntry?.savedTokens).toBe(3000);
	});
});
